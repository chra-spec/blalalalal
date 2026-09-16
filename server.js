/**
 * ═══════════════════════════════════════════════════════════════
 * ANIME STREAM SERVER — v2.0 (Robust)
 * ═══════════════════════════════════════════════════════════════
 * 
 * MİMARİ:
 *   Client → /api/stream → [KUYRUK] → scraper → m3u8 döner
 *   Client → /api/proxy  → [CURL]   → segment stream
 * 
 * PROXY STRATEJİSİ (Plan A/B/C):
 *   Plan A: ScrapingAnt proxy (env varsa)
 *   Plan B: Direct connection (proxy yoksa)
 *   Plan C: Proxy başarısızsa direct retry
 * 
 * RETRY POLİTİKASI:
 *   Her URL şeması için 2 deneme
 *   2 farklı URL şeması × 2 deneme = 4 max deneme
 * ═══════════════════════════════════════════════════════════════
 */

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
  pingInterval: 25000,
  connectTimeout: 45000
});

app.use(cors());
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════
// YAPILANDIRMA
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_FILE: "/data/admin.json",
  
  // ScrapingAnt proxy (env varsa aktif)
  PROXY_ENABLED: !!process.env.SCRAPINGANT_PASS,
  PROXY_SERVER: "http://proxy.scrapingant.com:8080",
  PROXY_USER: process.env.SCRAPINGANT_USER || "scrapingant",
  PROXY_PASS: process.env.SCRAPINGANT_PASS,
  
  // Zamanlamalar (ms)
  PAGE_GOTO_TIMEOUT: 30000,
  M3U8_CAPTURE_TIMEOUT: 25000,  // Erken çıkış için
  POST_GOTO_WAIT: 3000,          // Sayfa yüklenince biraz bekle
  
  // Retry
  MAX_RETRIES_PER_URL: 2,
  RETRY_DELAY: 1500,
  
  // Cache
  CACHE_TTL: 30 * 60 * 1000,     // 30 dk
  
  // Kuyruk
  QUEUE_TIMEOUT: 90 * 1000       // 90 sn max bekleme
};

// ═══════════════════════════════════════════════════════════
// LOGGER (zaman damgalı)
// ═══════════════════════════════════════════════════════════

function log(tag, msg) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${tag} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
// ADMIN KALICILIĞI
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
    fs.writeFileSync(CONFIG.ADMIN_FILE, JSON.stringify({
      deviceId: adminDeviceId,
      createdAt: Date.now()
    }));
  } catch (e) {
    // /data yoksa sessiz geç
  }
}

loadAdmin();

// ═══════════════════════════════════════════════════════════
// VIDEO DURUMU
// ═══════════════════════════════════════════════════════════

let currentVideo = null;
let currentState = { action: "pause", currentTime: 0, at: Date.now() };
const m3u8Cache = new Map();

// ═══════════════════════════════════════════════════════════
// KUYRUK SİSTEMİ (ScrapingAnt concurrency=1 için)
// ═══════════════════════════════════════════════════════════

class SerialQueue {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.running = false;
    this.stats = { total: 0, done: 0, failed: 0 };
  }

  async run(fn) {
    return new Promise((resolve, reject) => {
      const task = {
        fn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        id: ++this.stats.total
      };
      this.queue.push(task);
      log("📥", `Kuyruğa eklendi #${task.id} (bekleyen: ${this.queue.length})`);
      this.process();
    });
  }

  async process() {
    if (this.running) return;
    if (this.queue.length === 0) return;

    this.running = true;
    const task = this.queue.shift();

    // Timeout kontrolü
    const waited = Date.now() - task.enqueuedAt;
    if (waited > CONFIG.QUEUE_TIMEOUT) {
      log("⏰", `Kuyruk timeout #${task.id}`);
      task.reject(new Error("queue timeout"));
      this.running = false;
      this.process();
      return;
    }

    log("⚙️", `İşleniyor #${task.id} (bekleme: ${((waited) / 1000).toFixed(1)}s)`);

    try {
      const result = await task.fn();
      this.stats.done++;
      task.resolve(result);
    } catch (e) {
      this.stats.failed++;
      log("❌", `Task #${task.id} hata: ${e.message.slice(0, 100)}`);
      task.reject(e);
    } finally {
      this.running = false;
      // Sonraki iş için event loop'a bırak
      setImmediate(() => this.process());
    }
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      running: this.running,
      stats: this.stats
    };
  }
}

const scraperQueue = new SerialQueue("scraper");

// ═══════════════════════════════════════════════════════════
// BROWSER LAUNCH (her istekte taze)
// ═══════════════════════════════════════════════════════════

function getBrowserArgs() {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--disable-blink-features=AutomationControlled",
    "--ignore-certificate-errors",
    "--ignore-ssl-errors",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-web-security",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
  ];
}

function getProxyConfig() {
  if (!CONFIG.PROXY_ENABLED) return undefined;
  return {
    server: CONFIG.PROXY_SERVER,
    username: CONFIG.PROXY_USER,
    password: CONFIG.PROXY_PASS
  };
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    proxy: getProxyConfig(),
    args: getBrowserArgs()
  });
}

// ═══════════════════════════════════════════════════════════
// M3U8 YAKALAMA (tek deneme)
// ═══════════════════════════════════════════════════════════

async function captureM3u8(vidnestUrl, attemptLabel) {
  const t0 = Date.now();
  let browser = null;
  let context = null;
  let page = null;

  try {
    log("🌐", `${attemptLabel} — browser açılıyor`);
    browser = await launchBrowser();

    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });

    page = await context.newPage();

    let captured = null;
    let resolveCapture = null;
    let captureResolved = false;

    const capturePromise = new Promise((res) => { resolveCapture = res; });

    page.on("request", (req) => {
      const u = req.url();
      if (u.includes(".m3u8") && !u.includes("index-f1") && !u.includes("iframes")) {
        // En uzun URL'yi tercih et (genelde master playlist)
        if (!captured || u.length > captured.length) {
          captured = u;
          if (!captureResolved) {
            captureResolved = true;
            if (resolveCapture) resolveCapture(u);
          }
        }
      }
    });

    // Sayfa yükleme (goto) — başarısız olsa bile video yüklenebilir
    const gotoPromise = page.goto(vidnestUrl, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.PAGE_GOTO_TIMEOUT
    }).catch((e) => {
      log("⚠️", `${attemptLabel} — goto: ${e.message.slice(0, 80)}`);
      return null;
    });

    // Erken yakalama: m3u8 gelirse hemen dön
    const timeoutPromise = new Promise((res) =>
      setTimeout(() => res(null), CONFIG.M3U8_CAPTURE_TIMEOUT)
    );

    const result = await Promise.race([capturePromise, timeoutPromise]);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(result ? "✅" : "❌", `${attemptLabel} — ${elapsed}s — m3u8: ${result ? "BULUNDU" : "YOK"}`);

    return result;
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log("❌", `${attemptLabel} — ${elapsed}s — ${e.message.slice(0, 100)}`);
    return null;
  } finally {
    // ⚡ GARANTİLİ TEMİZLİK — proxy slotunu serbest bırak
    if (page) { try { await page.close(); } catch (x) {} }
    if (context) { try { await context.close(); } catch (x) {} }
    if (browser) { try { await browser.close(); } catch (x) {} }
    log("🔒", `${attemptLabel} — temizlendi (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

// ═══════════════════════════════════════════════════════════
// M3U8 STRATEJİSİ (URL şemaları + retry)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// M3U8 ÇEK — ScrapingAnt API (Playwright'sız)
// ═══════════════════════════════════════════════════════════

async function fetchM3u8WithRetry(animeId, episode) {
  const apiKey = CONFIG.PROXY_PASS; // ScrapingAnt API key

  if (!apiKey) {
    log("❌", "SCRAPINGANT_PASS env yok");
    return null;
  }

  // URL şemaları
  const variants = [
    { url: `https://vidnest.fun/anime/${animeId}/${episode}/sub`, label: "sub" },
    { url: `https://vidnest.fun/anime/${animeId}/${episode}/dub`, label: "dub" }
  ];

  for (const variant of variants) {
    try {
      const t0 = Date.now();
      log("🌐", `${variant.label} — ScrapingAnt API çağrılıyor`);

      // ScrapingAnt v2 General endpoint
      const params = new URLSearchParams({
        url: variant.url,
        "x-api-key": apiKey,
        browser: "true",              // JS render
        wait_until: "networkidle",    // Ağ boşalana kadar bekle (m3u8 yakalanır)
        proxy_country: "us",
        block_resource: "image,media,font,stylesheet" // Hız için görselleri engelle
      });

      const apiUrl = `https://api.scrapingant.com/v2/general?${params.toString()}`;
      log("🔗", `API: ${apiUrl.slice(0, 100)}...`);

      const r = await fetch(apiUrl, { signal: AbortSignal.timeout(60000) });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        log("❌", `${variant.label} — HTTP ${r.status} — ${errText.slice(0, 150)}`);
        continue;
      }

      const html = await r.text();
      log("📥", `${variant.label} — ${elapsed}s — HTML ${html.length} byte`);

      // m3u8 regex ile ara
      const m3u8Regex = /https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/g;
      const matches = html.match(m3u8Regex) || [];

      // Master playlist'leri tercih et, segment'leri atla
      const filtered = matches.filter((u) =>
        !u.includes("index-f1") &&
        !u.includes("iframes") &&
        !u.includes("segment")
      );

      if (filtered.length === 0) {
        log("⚠️", `${variant.label} — m3u8 yok (HTML ${html.length} byte)`);
        // HTML'in başını logla (debug)
        if (html.includes("Attention Required")) {
          log("🚫", `${variant.label} — Cloudflare block`);
        } else if (html.includes("concurrency limit")) {
          log("🚫", `${variant.label} — Concurrency limit`);
        }
        continue;
      }

      // En uzun URL genelde master playlist
      const best = filtered.reduce((a, b) => a.length > b.length ? a : b);
      log("✅", `${variant.label} — ${elapsed}s — BULUNDU (${filtered.length} aday)`);
      return best;

    } catch (e) {
      log("❌", `${variant.label} — ${e.message.slice(0, 100)}`);
      // Devam et, sonraki varyantı dene
    }
  }

  log("❌", "Tüm varyantlar başarısız");
  return null;
}

// ═══════════════════════════════════════════════════════════
// CURL YARDIMCI (m3u8 proxy)
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
// API: ANİME ARA (AniList)
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
// API: STREAM (m3u8 çek, kuyruk ile)
// ═══════════════════════════════════════════════════════════

app.get("/api/stream", async (req, res) => {
  try {
    const { id, ep } = req.query;
    if (!id || !ep) return res.json({ error: "id ve ep gerekli" });

    const key = `${id}_${ep}`;

    // CACHE kontrol
    if (m3u8Cache.has(key)) {
      log("⚡", `Cache hit: ${key}`);
      return res.json({ url: m3u8Cache.get(key), cached: true });
    }

    log("🎬", `Stream istek: ${key}`);

    // KUYRUK üzerinden çalıştır
    const m3u8 = await scraperQueue.run(() => fetchM3u8WithRetry(id, ep));

    if (!m3u8) {
      return res.json({
        error: "Video bulunamadı. Farklı bölüm veya anime deneyin."
      });
    }

    // Cache'e al
    m3u8Cache.set(key, m3u8);
    setTimeout(() => m3u8Cache.delete(key), CONFIG.CACHE_TTL);

    log("✅", `Stream OK: ${key}`);
    res.json({ url: m3u8 });
  } catch (e) {
    log("❌", `Stream: ${e.message}`);
    res.json({ error: e.message || "Bilinmeyen hata" });
  }
});

// ═══════════════════════════════════════════════════════════
// API: PROXY (m3u8 + segment)
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
        // URI="..." attribute'ları (key, iframe stream)
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
    res.status(500).send("hata: " + e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// API: DEBUG (canlı teşhis)
// ═══════════════════════════════════════════════════════════

app.get("/api/debug", async (req, res) => {
  const url = req.query.url || "https://vidnest.fun/anime/21355/1/sub";
  let browser = null;
  let ctx = null;

  try {
    browser = await launchBrowser();
    ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    });
    const page = await ctx.newPage();
    const requests = [];
    page.on("request", (r) => { if (requests.length < 50) requests.push(r.url()); });

    let gotoError = null;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (e) { gotoError = e.message; }

    await page.waitForTimeout(5000);

    const title = await page.title();
    const bodyText = await page.evaluate(() =>
      document.body ? document.body.innerText.substring(0, 500) : "NO BODY"
    );

    res.json({
      url,
      gotoError,
      title,
      bodyText,
      requestCount: requests.length,
      requestsSample: requests.slice(0, 15),
      proxy: CONFIG.PROXY_ENABLED ? "aktif" : "yok"
    });
  } catch (e) {
    res.json({ error: e.message });
  } finally {
    if (ctx) try { await ctx.close(); } catch (x) {}
    if (browser) try { await browser.close(); } catch (x) {}
  }
});

// ═══════════════════════════════════════════════════════════
// API: HEALTH
// ═══════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    admin: adminDeviceId,
    proxy: CONFIG.PROXY_ENABLED,
    cache: m3u8Cache.size,
    queue: scraperQueue.getStatus(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB"
  });
});

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════

function isAdminSocket(socket) {
  return socket.data && socket.data.deviceId === adminDeviceId;
}

function broadcastAdminStatus() {
  io.emit("admin-status", {
    adminDeviceId,
    totalDevices: io.sockets.sockets.size
  });
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

    log(isAdmin ? "👑" : "👤", `Katıldı: ${deviceId}`);
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

    currentState = {
      action: data.action,
      currentTime: data.currentTime || 0,
      at: Date.now()
    };
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
// SERVER BAŞLAT
// ═══════════════════════════════════════════════════════════

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log("═══════════════════════════════════════════");
  console.log(`🚀 Sunucu ${CONFIG.PORT} portunda çalışıyor`);
  console.log(`👑 Admin: ${adminDeviceId || "(ilk girene atanacak)"}`);
  console.log(`🔒 Proxy: ${CONFIG.PROXY_ENABLED ? "AKTİF (ScrapingAnt)" : "YOK (direct)"}`);
  console.log(`⚙️ Kuyruk: aktif (concurrency=1)`);
  console.log(`💾 Cache: ${CONFIG.CACHE_TTL / 60000} dk`);
  console.log("═══════════════════════════════════════════");
});

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════

async function shutdown(signal) {
  log("🛑", `${signal} — kapatılıyor...`);
  io.close();
  server.close(() => {
    log("✅", "Sunucu kapandı");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (e) => {
  log("💥", `Uncaught: ${e.message}`);
});

process.on("unhandledRejection", (e) => {
  log("💥", `Rejection: ${e && e.message ? e.message : e}`);
});
