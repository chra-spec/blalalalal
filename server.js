/**
 * ═══════════════════════════════════════════════════════════════
 * ANIME STREAM SERVER — v3.0 (ScrapingAnt API)
 * Playwright YOK, sadece HTTP API
 * ═══════════════════════════════════════════════════════════════
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_FILE: "/data/admin.json",
  SA_KEY: process.env.SCRAPINGANT_PASS,
  SA_ENDPOINT: "https://api.scrapingant.com/v2/general",
  CACHE_TTL: 30 * 60 * 1000,
  API_TIMEOUT: 60000
};

function log(tag, msg) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${tag} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════

let adminDeviceId = null;

function loadAdmin() {
  try {
    if (fs.existsSync(CONFIG.ADMIN_FILE)) {
      const d = JSON.parse(fs.readFileSync(CONFIG.ADMIN_FILE, "utf8"));
      adminDeviceId = d.deviceId || null;
      log("👑", `Admin yüklendi: ${adminDeviceId}`);
    }
  } catch (e) {}
}
function saveAdmin() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.ADMIN_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.ADMIN_FILE, JSON.stringify({ deviceId: adminDeviceId, createdAt: Date.now() }));
  } catch (e) {}
}
loadAdmin();

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

let currentVideo = null;
let currentState = { action: "pause", currentTime: 0, at: Date.now() };
const m3u8Cache = new Map();

// ═══════════════════════════════════════════════════════════
// SERIAL QUEUE
// ═══════════════════════════════════════════════════════════

class SerialQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.stats = { total: 0, done: 0, failed: 0 };
  }
  async run(fn) {
    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject, id: ++this.stats.total, at: Date.now() };
      this.queue.push(task);
      log("📥", `Kuyruk #${task.id} (bekleyen: ${this.queue.length})`);
      this.process();
    });
  }
  async process() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const task = this.queue.shift();
    log("⚙️", `İşleniyor #${task.id}`);
    try {
      const r = await task.fn();
      this.stats.done++;
      task.resolve(r);
    } catch (e) {
      this.stats.failed++;
      task.reject(e);
    } finally {
      this.running = false;
      setImmediate(() => this.process());
    }
  }
  getStatus() {
    return { queueLength: this.queue.length, running: this.running, stats: this.stats };
  }
}
const scraperQueue = new SerialQueue();

// ═══════════════════════════════════════════════════════════
// SCRAPINGANT API ÇAĞRISI
// ═══════════════════════════════════════════════════════════

async function callScrapingAnt(targetUrl) {
  if (!CONFIG.SA_KEY) {
    log("❌", "SCRAPINGANT_PASS env yok");
    return null;
  }

  const params = new URLSearchParams({
    url: targetUrl,
    "x-api-key": CONFIG.SA_KEY,
    browser: "true",
    wait_until: "networkidle",
    proxy_country: "us"
  });

  const apiUrl = `${CONFIG.SA_ENDPOINT}?${params.toString()}`;
  const t0 = Date.now();

  try {
    const r = await fetch(apiUrl, { signal: AbortSignal.timeout(CONFIG.API_TIMEOUT) });
    const html = await r.text();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    log("📥", `HTTP ${r.status} — ${elapsed}s — ${html.length} byte`);

    if (!r.ok) {
      if (html.includes("concurrency")) log("🚫", "Concurrency limit");
      if (html.includes("plan")) log("🚫", "Plan limit");
      return { html: null, status: r.status, elapsed, error: html.slice(0, 200) };
    }

    return { html, status: r.status, elapsed };
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log("❌", `${e.message.slice(0, 100)} — ${elapsed}s`);
    return { html: null, status: 0, elapsed, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// M3U8 ÇIKAR (regex)
// ═══════════════════════════════════════════════════════════

function extractM3u8(html) {
  if (!html) return null;

  const regex = /https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/g;
  const matches = html.match(regex) || [];

  const filtered = matches.filter((u) =>
    !u.includes("index-f1") &&
    !u.includes("iframes") &&
    !u.includes("segment")
  );

  if (filtered.length === 0) return null;

  // En uzun (genelde master playlist)
  return filtered.reduce((a, b) => a.length > b.length ? a : b);
}

// ═══════════════════════════════════════════════════════════
// ANA AKIŞ: sub → dub fallback
// ═══════════════════════════════════════════════════════════

async function fetchM3u8(animeId, episode) {
  const variants = [
    { url: `https://vidnest.fun/anime/${animeId}/${episode}/sub`, label: "sub" },
    { url: `https://vidnest.fun/anime/${animeId}/${episode}/dub`, label: "dub" }
  ];

  for (const v of variants) {
    log("🌐", `${v.label} — API çağrılıyor`);

    const result = await callScrapingAnt(v.url);

    if (!result.html) {
      if (result.error && result.error.includes("concurrency")) {
        log("⏸️", "Concurrency limit, 3s bekleyip tekrar");
        await new Promise((r) => setTimeout(r, 3000));
        const retry = await callScrapingAnt(v.url);
        if (retry.html) {
          const m3u8 = extractM3u8(retry.html);
          if (m3u8) {
            log("✅", `${v.label} — BULUNDU (retry)`);
            return m3u8;
          }
        }
      }
      continue;
    }

    if (result.html.includes("Attention Required") || result.html.includes("you have been blocked")) {
      log("🚫", `${v.label} — Cloudflare block`);
      continue;
    }

    const m3u8 = extractM3u8(result.html);
    if (m3u8) {
      log("✅", `${v.label} — BULUNDU`);
      return m3u8;
    }

    log("⚠️", `${v.label} — m3u8 yok (HTML ${result.html.length} byte)`);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// CURL (m3u8 + segment proxy)
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// API: SEARCH
// ═══════════════════════════════════════════════════════════

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
    log("❌", `Search: ${e.message}`);
    res.json({ results: [], error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// API: STREAM
// ═══════════════════════════════════════════════════════════

app.get("/api/stream", async (req, res) => {
  try {
    const { id, ep } = req.query;
    if (!id || !ep) return res.json({ error: "id ve ep gerekli" });

    const key = `${id}_${ep}`;
    if (m3u8Cache.has(key)) {
      log("⚡", `Cache: ${key}`);
      return res.json({ url: m3u8Cache.get(key), cached: true });
    }

    log("🎬", `Stream: ${key}`);
    const m3u8 = await scraperQueue.run(() => fetchM3u8(id, ep));

    if (!m3u8) return res.json({ error: "Video bulunamadı. Farklı bölüm/anime deneyin." });

    m3u8Cache.set(key, m3u8);
    setTimeout(() => m3u8Cache.delete(key), CONFIG.CACHE_TTL);

    log("✅", `Stream OK: ${key}`);
    res.json({ url: m3u8 });
  } catch (e) {
    log("❌", `Stream: ${e.message}`);
    res.json({ error: e.message || "Hata" });
  }
});

// ═══════════════════════════════════════════════════════════
// API: PROXY
// ═══════════════════════════════════════════════════════════

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
    res.status(500).send("hata: " + e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// API: DEBUG
// ═══════════════════════════════════════════════════════════

app.get("/api/debug", async (req, res) => {
  const url = req.query.url || "https://vidnest.fun/anime/21355/1/sub";
  const result = await callScrapingAnt(url);
  const m3u8 = extractM3u8(result.html);
  res.json({
    url,
    status: result.status,
    elapsed: result.elapsed + "s",
    htmlLength: result.html ? result.html.length : 0,
    hasCloudflare: result.html ? result.html.includes("Attention Required") : false,
    hasConcurrency: result.html ? result.html.includes("concurrency") : false,
    m3u8Found: !!m3u8,
    m3u8Sample: m3u8,
    error: result.error || null,
    htmlSample: result.html ? result.html.substring(0, 400) : null
  });
});

// ═══════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    admin: adminDeviceId,
    proxy: !!CONFIG.SA_KEY,
    cache: m3u8Cache.size,
    queue: scraperQueue.getStatus(),
    mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB"
  });
});

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════

function isAdminSocket(socket) {
  return socket.data && socket.data.deviceId === adminDeviceId;
}
function broadcastAdminStatus() {
  io.emit("admin-status", { adminDeviceId, totalDevices: io.sockets.sockets.size });
}

io.on("connection", (socket) => {
  log("🔌", `Socket: ${socket.id}`);

  socket.on("join", (data) => {
    const deviceId = data && data.deviceId ? String(data.deviceId) : null;
    if (!deviceId) return socket.emit("error-msg", { message: "deviceId gerekli" });

    socket.data.deviceId = deviceId;
    if (!adminDeviceId) {
      adminDeviceId = deviceId;
      saveAdmin();
      log("👑", `Yeni admin: ${deviceId}`);
    }

    const isAdmin = deviceId === adminDeviceId;
    socket.emit("you-are", { isAdmin, deviceId, adminDeviceId });
    broadcastAdminStatus();

    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }

    log(isAdmin ? "👑" : "👤", `${deviceId}`);
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
    log("🎬", `Yayınlandı: ${currentVideo.title}`);
  });

  socket.on("video-control", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.action) return;
    currentState = { action: data.action, currentTime: data.currentTime || 0, at: Date.now() };
    socket.broadcast.emit("video-control", currentState);
    log("⏯️", `${data.action} @ ${(data.currentTime || 0).toFixed(1)}s`);
  });

  socket.on("request-sync", () => {
    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }
  });

  socket.on("disconnect", () => {
    log("❌", `Ayrıldı: ${socket.data.deviceId || socket.id}`);
    broadcastAdminStatus();
  });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log("═══════════════════════════════════════════");
  console.log(`🚀 Sunucu ${CONFIG.PORT} portunda`);
  console.log(`👑 Admin: ${adminDeviceId || "(ilk girene)"}`);
  console.log(`🔒 ScrapingAnt: ${CONFIG.SA_KEY ? "AKTİF" : "YOK"}`);
  console.log("═══════════════════════════════════════════");
});

process.on("SIGTERM", () => { io.close(); server.close(() => process.exit(0)); });
process.on("uncaughtException", (e) => log("💥", e.message));
process.on("unhandledRejection", (e) => log("💥", e && e.message ? e.message : e));
