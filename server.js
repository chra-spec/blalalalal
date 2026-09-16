const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 50 * 1024 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.static(__dirname));

// ===== ADMIN KALICILIĞI =====
const ADMIN_FILE = "/data/admin.json";
let adminDeviceId = null;

function loadAdmin() {
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
      adminDeviceId = data.deviceId || null;
      console.log("👑 Admin yüklendi:", adminDeviceId);
    }
  } catch (e) {}
}
function saveAdmin() {
  try {
    fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ deviceId: adminDeviceId, createdAt: Date.now() }));
  } catch (e) {}
}
loadAdmin();

// ===== DURUM =====
let currentVideo = null;
let currentState = { action: "pause", currentTime: 0, at: Date.now() };
const m3u8Cache = new Map();

// ===== PAYLAŞIMLI BROWSER =====
let sharedBrowser = null;

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch (e) {}
    sharedBrowser = null;
  }
  console.log("🌐 Chromium başlatılıyor...");
  sharedBrowser = await chromium.launch({
    headless: true,
    proxy: process.env.SCRAPINGANT_PASS ? {
      server: "http://proxy.scrapingant.com:8080",
      username: process.env.SCRAPINGANT_USER || "scrapingant",
      password: process.env.SCRAPINGANT_PASS
    } : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled",
      "--ignore-certificate-errors",
      "--ignore-ssl-errors",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });
  sharedBrowser.on("disconnected", () => {
    console.log("⚠️ Chromium düştü");
    sharedBrowser = null;
  });
  console.log("✅ Chromium hazır");
  return sharedBrowser;
}

async function getM3u8(vidnestUrl) {
  const startTime = Date.now();
  let context = null;
  try {
    const browser = await getSharedBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });

    const page = await context.newPage();

    let captured = null;
    let resolveCapture;
    const capturePromise = new Promise((resolve) => { resolveCapture = resolve; });

    page.on("request", (req) => {
      const u = req.url();
      if (u.includes(".m3u8") && !u.includes("index-f1") && !u.includes("iframes")) {
        if (!captured || u.length > captured.length) {
          captured = u;
          if (resolveCapture) resolveCapture(u);
        }
      }
    });

    page.goto(vidnestUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => {
      console.log("⚠️ goto uyarı:", e.message.slice(0, 80));
    });

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 25000));
    const result = await Promise.race([capturePromise, timeoutPromise]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️ ${elapsed}s | m3u8: ${result ? "BULUNDU ✅" : "YOK ❌"}`);

    await page.close().catch(() => {});
    await context.close().catch(() => {});
    return result;
  } catch (e) {
    console.error("❌ getM3u8:", e.message.slice(0, 120));
    if (context) { try { await context.close(); } catch (x) {} }
    return null;
  }
}

// ===== CURL YARDIMCI =====
function curlFetch(url) {
  return new Promise((resolve) => {
    const proc = spawn("curl", [
      "-s", "-L", "--max-time", "30", "--compressed",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "-H", "Referer: https://megaplay.buzz/",
      "-H", "Origin: https://megaplay.buzz",
      url
    ]);
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      resolve(Buffer.concat(chunks));
    });
    proc.on("error", () => resolve(null));
  });
}

// ===== API: SEARCH =====
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json({ results: [] });

    const body = {
      query: "query($s:String){Page(perPage:15){media(search:$s,type:ANIME,sort:POPULARITY_DESC){id title{english romaji} episodes format seasonYear coverImage{large}}}}",
      variables: { s: q }
    };

    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    const m = (d.data && d.data.Page && d.data.Page.media) || [];

    res.json({
      results: m.map((x) => ({
        id: x.id,
        title: x.title.english || x.title.romaji,
        titleRomaji: x.title.romaji,
        episodes: x.episodes || 0,
        format: x.format || "TV",
        year: x.seasonYear || "",
        poster: x.coverImage ? x.coverImage.large : ""
      }))
    });
  } catch (e) {
    res.json({ results: [], error: e.message });
  }
});

// ===== API: STREAM =====
app.get("/api/stream", async (req, res) => {
  try {
    const { id, ep } = req.query;
    if (!id || !ep) return res.json({ error: "id ve ep gerekli" });

    const key = id + "_" + ep;
    if (m3u8Cache.has(key)) {
      console.log("⚡ Cache:", key);
      return res.json({ url: m3u8Cache.get(key), cached: true });
    }

    const vidnestUrl = `https://vidnest.fun/anime/${id}/${ep}/sub`;
    console.log("🎬 Scraper:", vidnestUrl);

    const m3u8 = await getM3u8(vidnestUrl);
    if (!m3u8) return res.json({ error: "Video bulunamadı. Farklı bölüm deneyin." });

    m3u8Cache.set(key, m3u8);
    setTimeout(() => m3u8Cache.delete(key), 30 * 60 * 1000);

    res.json({ url: m3u8 });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API: PROXY =====
app.get("/api/proxy", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("url gerekli");

    const buf = await curlFetch(url);
    if (!buf || buf.length === 0) return res.status(500).send("bos");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    const head = buf.slice(0, 20).toString();
    const isM3u8 = url.includes(".m3u8") || head.startsWith("#EXTM3U");

    if (isM3u8) {
      const text = buf.toString("utf8");
      const baseUrl = new URL(url);
      const lines = text.split(String.fromCharCode(10));
      const rewritten = lines.map((line) => {
        if (line.indexOf('URI="') !== -1) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            try {
              const abs = new URL(uri, baseUrl).toString();
              return 'URI="/api/proxy?url=' + encodeURIComponent(abs) + '"';
            } catch (e) { return 'URI="' + uri + '"'; }
          });
        }
        if (!line || line.startsWith("#")) return line;
        const x = line.trim();
        if (!x) return line;
        try {
          return "/api/proxy?url=" + encodeURIComponent(new URL(x, baseUrl).toString());
        } catch (e) { return line; }
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten.join(String.fromCharCode(10)));
    }

    res.setHeader("Content-Type", "video/mp2t");
    res.send(buf);
  } catch (e) {
    res.status(500).send("hata");
  }
});

// ===== API: DEBUG =====
app.get("/api/debug", async (req, res) => {
  const url = req.query.url || "https://vidnest.fun/anime/21355/1/sub";
  let ctx = null;
  try {
    const browser = await getSharedBrowser();
    ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    });
    const page = await ctx.newPage();
    const requests = [];
    page.on("request", (r) => { if (requests.length < 50) requests.push(r.url()); });

    let gotoError = null;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) { gotoError = e.message; }

    await page.waitForTimeout(6000);

    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 500) : "NO BODY");

    await page.close().catch(() => {});
    await ctx.close().catch(() => {});

    res.json({ url, gotoError, title, bodyText, requestCount: requests.length, requestsSample: requests.slice(0, 20) });
  } catch (e) {
    if (ctx) try { await ctx.close(); } catch (x) {}
    res.json({ error: e.message });
  }
});

// ===== SOCKET.IO =====
function isAdminSocket(socket) {
  return socket.data && socket.data.deviceId === adminDeviceId;
}
function broadcastAdminStatus() {
  io.emit("admin-status", { adminDeviceId, totalDevices: io.sockets.sockets.size });
}

io.on("connection", (socket) => {
  console.log("🔌 Bağlandı:", socket.id);

  socket.on("join", (data) => {
    const deviceId = data && data.deviceId ? String(data.deviceId) : null;
    if (!deviceId) return socket.emit("error-msg", { message: "deviceId gerekli" });

    socket.data.deviceId = deviceId;
    if (!adminDeviceId) {
      adminDeviceId = deviceId;
      saveAdmin();
      console.log("👑 Yeni admin:", deviceId);
    }

    const isAdmin = deviceId === adminDeviceId;
    socket.emit("you-are", { isAdmin, deviceId, adminDeviceId });
    broadcastAdminStatus();

    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }
    console.log(`${isAdmin ? "👑" : "👤"} ${deviceId}`);
  });

  socket.on("video-load", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.url) return;
    currentVideo = {
      url: data.url,
      title: data.title || "Video",
      animeId: data.animeId || null,
      episode: data.episode || 1,
      startedAt: Date.now()
    };
    currentState = { action: "play", currentTime: 0, at: Date.now() };
    socket.broadcast.emit("video-load", currentVideo);
    console.log("🎬 Yayınlandı:", currentVideo.title);
  });

  socket.on("video-control", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.action) return;
    currentState = { action: data.action, currentTime: data.currentTime || 0, at: Date.now() };
    socket.broadcast.emit("video-control", currentState);
    console.log(`⏯️ ${data.action} @ ${(data.currentTime || 0).toFixed(1)}s`);
  });

  socket.on("request-sync", () => {
    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Ayrıldı:", socket.data.deviceId || socket.id);
    broadcastAdminStatus();
  });
});

// ===== HEALTH =====
app.get("/health", (req, res) => res.json({ status: "ok", admin: adminDeviceId, cacheSize: m3u8Cache.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Sunucu ${PORT} portunda`);
  console.log(`👑 Admin: ${adminDeviceId || "(ilk girene)"}`);
  console.log(`🔒 Proxy: ${process.env.SCRAPINGANT_PASS ? "AKTİF" : "YOK"}`);
});

process.on("SIGTERM", async () => {
  if (sharedBrowser) try { await sharedBrowser.close(); } catch (e) {}
  server.close(() => process.exit(0));
});
