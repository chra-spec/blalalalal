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
  pingTimeout: 60000
});

app.use(cors());
app.use(express.static(__dirname));

// ==========================================
// ADMIN KALICILIĞI (dosyaya yaz)
// ==========================================
const ADMIN_FILE = "/data/admin.json";  // Render disk varsa
let adminDeviceId = null;

function loadAdmin() {
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
      adminDeviceId = data.deviceId || null;
      console.log("👑 Admin yüklendi:", adminDeviceId);
    }
  } catch (e) {
    console.error("Admin yükleme hatası:", e.message);
  }
}

function saveAdmin() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({
      deviceId: adminDeviceId,
      createdAt: Date.now()
    }));
  } catch (e) {
    // /data yoksa sessizce geç (disk eklenmemiş)
    if (!e.message.includes("ENOENT")) {
      console.error("Admin kaydetme hatası:", e.message);
    }
  }
}

loadAdmin();

// ==========================================
// VİDEO DURUMU (oda hafızası)
// ==========================================
let currentVideo = null;
let currentState = { action: "pause", currentTime: 0, at: Date.now() };
const m3u8Cache = new Map();

// ==========================================
// PLAYWRIGHT SCRAPER (browser tekil)
// ==========================================
async function getM3u8(vidnestUrl) {
  let browser = null;
  let context = null;
  try {
    console.log("🌐 Chromium başlatılıyor...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--no-zygote"
      ]
    });
    console.log("✅ Browser hazır");

    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "en-US"
    });

    const page = await context.newPage();
    const found = new Set();

    page.on("request", (req) => {
      const u = req.url();
      if (u.includes(".m3u8") && !u.includes("index-f1") && !u.includes("iframes")) {
        found.add(u);
      }
    });

    try {
      await page.goto(vidnestUrl, {
        waitUntil: "domcontentloaded",
        timeout: 40000
      });
    } catch (e) {
      console.log("⚠️ Sayfa yükleme uyarısı:", e.message);
    }

    console.log("⏳ 15 saniye bekleniyor...");
    await page.waitForTimeout(15000);

    console.log("📊 Bulunan m3u8 sayısı:", found.size);

    await page.close();
    await context.close();
    await browser.close();
    browser = null;

    const urls = Array.from(found);
    if (urls.length === 0) return null;
    return urls.reduce((a, b) => a.length > b.length ? a : b);
  } catch (e) {
    console.error("❌ getM3u8 hata:", e.message);
    if (context) { try { await context.close(); } catch (x) {} }
    if (browser) { try { await browser.close(); } catch (x) {} }
    return null;
  }
}
// ==========================================
// CURL YARDIMCI (Cloudflare bypass)
// ==========================================
function curlFetch(url) {
  return new Promise((resolve) => {
    const proc = spawn("curl", [
      "-s", "-L", "--max-time", "30",
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

// ==========================================
// API: ANİME ARA (AniList)
// ==========================================
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

// ==========================================
// API: STREAM (m3u8 linki)
// ==========================================
app.get("/api/stream", async (req, res) => {
  try {
    const { id, ep } = req.query;
    if (!id || !ep) return res.json({ error: "id ve ep gerekli" });

    const key = id + "_" + ep;
    if (m3u8Cache.has(key)) {
      console.log("⚡ Cache hit:", key);
      return res.json({ url: m3u8Cache.get(key), cached: true });
    }

    const vidnestUrl = `https://vidnest.fun/anime/${id}/${ep}/sub`;
    console.log("🎬 Scraper çalışıyor:", vidnestUrl);

    const m3u8 = await getM3u8(vidnestUrl);
    if (!m3u8) return res.json({ error: "Video bulunamadı. Farklı bölüm deneyin." });

    m3u8Cache.set(key, m3u8);
    setTimeout(() => m3u8Cache.delete(key), 30 * 60 * 1000);

    console.log("✅ m3u8 alındı");
    res.json({ url: m3u8 });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ==========================================
// API: PROXY (CORS bypass + URL rewrite)
// ==========================================
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
        // URI="..." attribute'ları (key, iframe stream vs.)
        if (line.indexOf('URI="') !== -1) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            try {
              const abs = new URL(uri, baseUrl).toString();
              return 'URI="/api/proxy?url=' + encodeURIComponent(abs) + '"';
            } catch (e) {
              return 'URI="' + uri + '"';
            }
          });
        }
        if (!line || line.startsWith("#")) return line;
        const x = line.trim();
        if (!x) return line;
        try {
          return "/api/proxy?url=" + encodeURIComponent(new URL(x, baseUrl).toString());
        } catch (e) {
          return line;
        }
      });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten.join(String.fromCharCode(10)));
    }

    res.setHeader("Content-Type", "video/mp2t");
    res.send(buf);
  } catch (e) {
    console.error("Proxy hata:", e.message);
    res.status(500).send("hata");
  }
});

// ==========================================
// SOCKET.IO — ADMIN SENKRONİZASYON
// ==========================================
function isAdminSocket(socket) {
  return socket.data && socket.data.deviceId && socket.data.deviceId === adminDeviceId;
}

function broadcastAdminStatus() {
  io.emit("admin-status", {
    adminDeviceId: adminDeviceId,
    totalDevices: io.sockets.sockets.size
  });
}

io.on("connection", (socket) => {
  console.log("🔌 Bağlandı:", socket.id);

  socket.on("join", (data) => {
    const deviceId = data && data.deviceId ? String(data.deviceId) : null;
    if (!deviceId) {
      socket.emit("error-msg", { message: "deviceId gerekli" });
      return;
    }

    socket.data.deviceId = deviceId;

    // ⚡ İlk giren admin olur, değişmez
    if (!adminDeviceId) {
      adminDeviceId = deviceId;
      saveAdmin();
      console.log("👑 Yeni admin atandı:", deviceId);
    }

    const isAdmin = deviceId === adminDeviceId;

    socket.emit("you-are", { isAdmin, deviceId, adminDeviceId });
    broadcastAdminStatus();

    // Mevcut video varsa gönder
    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }

    console.log(`${isAdmin ? "👑" : "👤"} Katıldı: ${deviceId}`);
  });

  // ===== ADMIN: Video yükle =====
  socket.on("video-load", (data) => {
    if (!isAdminSocket(socket)) {
      socket.emit("error-msg", { message: "Sadece admin video yükleyebilir" });
      return;
    }
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
    console.log("🎬 Video yüklendi:", currentVideo.title);
  });

  // ===== ADMIN: Play/Pause/Seek =====
  socket.on("video-control", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.action) return;

    currentState = {
      action: data.action,
      currentTime: data.currentTime || 0,
      at: Date.now()
    };

    socket.broadcast.emit("video-control", {
      action: data.action,
      currentTime: data.currentTime || 0,
      at: Date.now()
    });

    const t = (data.currentTime || 0).toFixed(1);
    console.log(`⏯️ ${data.action} @ ${t}s`);
  });

  // ===== İzleyici: Senkron isteği =====
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

// ==========================================
// SUNUCU BAŞLAT
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
  console.log(`👑 Admin: ${adminDeviceId || "(ilk girene atanacak)"}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Kapatılıyor...");
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
  }
  server.close(() => process.exit(0));
});
