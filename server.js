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

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_FILE: "/data/admin.json",
  SA_KEY: "90b9a65c2e799e5af2d8a774cb657e1a",
  SA_ENDPOINT: "https://api.scraperapi.com",
  CACHE_TTL: 60 * 60 * 1000,
  SUB_CACHE_TTL: 6 * 60 * 60 * 1000,
  API_TIMEOUT: 40000,
  QUEUE_TIMEOUT: 120000,
  STREAM_ROUTE_TIMEOUT: 110000,
  TRANSLATE_CONCURRENCY: 2,
  PLAN: [
    { country: "us", variant: "sub" },
    { country: "us", variant: "sub" }
  ]
};

function log(tag, msg) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${tag} ${msg}`);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

let adminDeviceId = null;

function loadAdmin() {
  try {
    if (fs.existsSync(CONFIG.ADMIN_FILE)) {
      const d = JSON.parse(fs.readFileSync(CONFIG.ADMIN_FILE, "utf8"));
      adminDeviceId = d.deviceId || null;
      log("ADMIN", `Yuklendi: ${adminDeviceId}`);
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
  } catch (e) {}
}

loadAdmin();

let currentVideo = null;
let currentState = { action: "pause", currentTime: 0, at: Date.now() };
const m3u8Cache = new Map();
const streamInfoCache = new Map();
const subtitleCache = new Map();
const subtitleJobs = new Map();

class SerialQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.stats = { total: 0, done: 0, failed: 0 };
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject, id: ++this.stats.total, at: Date.now() };
      this.queue.push(task);
      log("QUEUE", `#${task.id} bekleyen:${this.queue.length}`);
      this.process();
    });
  }

  async process() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const task = this.queue.shift();

    const waited = Date.now() - task.at;
    if (waited > CONFIG.QUEUE_TIMEOUT) {
      task.reject(new Error("queue timeout"));
      this.running = false;
      setImmediate(() => this.process());
      return;
    }

    log("QUEUE", `Isleniyor #${task.id} bekleme:${(waited / 1000).toFixed(1)}s`);

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

  status() {
    return {
      queueLength: this.queue.length,
      running: this.running,
      stats: this.stats
    };
  }
}

const scraperQueue = new SerialQueue();

async function callScraperAPI(targetUrl, country) {
  if (!CONFIG.SA_KEY) return { html: null, status: 0, error: "no_key" };

  const params = new URLSearchParams({
    api_key: CONFIG.SA_KEY,
    url: targetUrl,
    render: "true",
    country_code: country || "us"
  });

  const apiUrl = `${CONFIG.SA_ENDPOINT}?${params.toString()}`;
  const t0 = Date.now();

  try {
    const r = await fetch(apiUrl, { signal: AbortSignal.timeout(CONFIG.API_TIMEOUT) });
    const html = await r.text();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    log("API", `HTTP ${r.status} ${country} ${elapsed}s ${html.length}b`);

    if (!r.ok) {
      return { html: null, status: r.status, elapsed, error: html.slice(0, 300) };
    }

    return { html, status: r.status, elapsed };
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log("API", `Hata ${e.message.slice(0, 80)} ${elapsed}s`);
    return { html: null, status: 0, elapsed, error: e.message };
  }
}

function extractM3u8(html) {
  if (!html) return null;

  const regex = /https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/g;
  const matches = html.match(regex) || [];

  const filtered = matches
    .map((u) => decodeHtmlEntities(u))
    .filter((u) =>
      !u.includes("index-f1") &&
      !u.includes("iframes") &&
      !u.includes("segment")
    );

  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a.length > b.length ? a : b);
}

function extractSubtitleFromHtml(html) {
  if (!html) return null;

  const regex = /https?:\/\/[^"'\s\\<>]+\.(?:vtt|srt)[^"'\s\\<>]*/g;
  const matches = html.match(regex) || [];

  if (matches.length === 0) return null;

  const decoded = decodeHtmlEntities(matches[0]);
  log("SUB", `HTML altyazi bulundu`);
  return decoded;
}

function isCloudflareBlock(html) {
  if (!html) return false;
  return html.includes("Attention Required") ||
         html.includes("you have been blocked") ||
         html.includes("Just a moment");
}

function isConcurrencyError(html) {
  if (!html) return false;
  return html.includes("concurrency") ||
         html.includes("Free user concurrency") ||
         html.includes("rate limit") ||
         html.includes("too many requests") ||
         html.includes("insufficient credit") ||
         html.includes("credits");
}

async function fetchStreamInfo(animeId, episode) {
  const baseUrl = `https://vidnest.fun/anime/${animeId}/${episode}`;

  for (let i = 0; i < CONFIG.PLAN.length; i++) {
    const plan = CONFIG.PLAN[i];
    const targetUrl = `${baseUrl}/${plan.variant}`;

    log("PLAN", `#${i + 1} ${plan.variant}/${plan.country}`);

    const result = await callScraperAPI(targetUrl, plan.country);

    const isLimitError = result.status === 429 || result.status === 409 || result.status === 401 || result.status === 403;
    if (isLimitError || (result.html && isConcurrencyError(result.html))) {
      log("RETRY", "Limit, 6s bekle");
      await new Promise((r) => setTimeout(r, 6000));
      const retry = await callScraperAPI(targetUrl, plan.country);
      if (retry.html && !isConcurrencyError(retry.html)) {
        const m3u8 = extractM3u8(retry.html);
        if (m3u8) {
          const sub = extractSubtitleFromHtml(retry.html);
          log("OK", `Plan#${i + 1} retry sub=${sub ? "var" : "yok"}`);
          return { m3u8, subtitleUrl: sub };
        }
      }
      continue;
    }

    if (!result.html) {
      log("SKIP", `Plan#${i + 1} html yok`);
      continue;
    }

    if (isCloudflareBlock(result.html)) {
      log("BLOCK", `Plan#${i + 1} Cloudflare`);
      continue;
    }

    const m3u8 = extractM3u8(result.html);
    if (m3u8) {
      const sub = extractSubtitleFromHtml(result.html);
      log("OK", `Plan#${i + 1} sub=${sub ? "var" : "yok"}`);
      return { m3u8, subtitleUrl: sub };
    }

    log("MISS", `Plan#${i + 1} m3u8 yok`);
  }

  return null;
}

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

function parseVtt(vttText) {
  if (!vttText) return [];
  const blocks = vttText.split(/\n\s*\n/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) continue;

    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;

    const timeLine = lines[timeIdx];
    const m = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;

    const textLines = lines.slice(timeIdx + 1);
    cues.push({
      start: m[1].replace(",", "."),
      end: m[2].replace(",", "."),
      text: textLines.join(" ")
    });
  }

  return cues;
}

function buildVtt(cues) {
  let out = "WEBVTT\n\n";
  cues.forEach((c, i) => {
    out += `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n\n`;
  });
  return out;
}

async function translateText(text) {
  if (!text || !text.trim()) return text;

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=${encodeURIComponent(text)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });

      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500 * attempt));
        continue;
      }
      if (!r.ok) return text;

      const d = await r.json();
      if (!d || !d[0]) return text;
      return d[0].map((x) => x[0]).join("");
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  return text;
}

async function translateAll(texts) {
  const results = new Array(texts.length);
  let cursor = 0;
  let done = 0;
  const total = texts.length;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;

      results[idx] = await translateText(texts[idx]);
      done++;

      if (done % 25 === 0 || done === total) {
        log("SUB", `Progress: ${done}/${total}`);
      }

      // Rate limit'i yumuşatmak için kısa bekleme
      await new Promise((res) => setTimeout(res, 120));
    }
  };

  const workerCount = Math.min(CONFIG.TRANSLATE_CONCURRENCY, total);
  const workers = Array(workerCount).fill(0).map(worker);

  await Promise.race([
    Promise.all(workers),
    new Promise((res) => setTimeout(res, 120000))
  ]);

  log("SUB", `Translate bitis: ${done}/${total}`);
  return results;
}

async function generateTranslatedSubtitle(subUrl, key) {
  try {
    log("SUB", `Indiriliyor`);
    const buf = await curlFetch(subUrl);
    if (!buf || buf.length === 0) {
      log("SUB", "Indirilemedi");
      return null;
    }

    const vttRaw = buf.toString("utf8");
    const cues = parseVtt(vttRaw);

    if (cues.length === 0) {
      log("SUB", "Cue yok");
      return null;
    }

    log("SUB", `${cues.length} satir cevrilecek`);
    const t0 = Date.now();

    const translated = await translateAll(cues.map((c) => c.text));
    cues.forEach((c, i) => { c.text = translated[i]; });

    const finalVtt = buildVtt(cues);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    log("SUB", `Ceviri tamam ${elapsed}s`);
    subtitleCache.set(key, finalVtt);
    setTimeout(() => subtitleCache.delete(key), CONFIG.SUB_CACHE_TTL);

    return finalVtt;
  } catch (e) {
    log("SUB", `Hata: ${e.message.slice(0, 100)}`);
    return null;
  }
}

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

app.get("/api/stream", async (req, res) => {
  const routeTimeout = setTimeout(() => {
    if (!res.headersSent) {
      log("TIMEOUT", "Stream route");
      res.status(200).json({ error: "Zaman asimi." });
    }
  }, CONFIG.STREAM_ROUTE_TIMEOUT);

  try {
    const { id, ep } = req.query;
    if (!id || !ep) {
      clearTimeout(routeTimeout);
      return res.json({ error: "id ve ep gerekli" });
    }

    const key = `${id}_${ep}`;

    if (streamInfoCache.has(key)) {
      clearTimeout(routeTimeout);
      const info = streamInfoCache.get(key);
      log("CACHE", key);
      return res.json({
        url: info.m3u8,
        hasSubtitles: !!info.subtitleUrl,
        cached: true
      });
    }

    log("STREAM", key);
    const info = await scraperQueue.run(() => fetchStreamInfo(id, ep));

    clearTimeout(routeTimeout);

    if (!info || !info.m3u8) {
      return res.json({ error: "Video bulunamadi. Farkli bolum deneyin." });
    }

    m3u8Cache.set(key, info.m3u8);
    setTimeout(() => m3u8Cache.delete(key), CONFIG.CACHE_TTL);

    streamInfoCache.set(key, { m3u8: info.m3u8, subtitleUrl: info.subtitleUrl });
    setTimeout(() => streamInfoCache.delete(key), CONFIG.CACHE_TTL);

    if (info.subtitleUrl && !subtitleJobs.has(key) && !subtitleCache.has(key)) {
      subtitleJobs.set(key, generateTranslatedSubtitle(info.subtitleUrl, key).finally(() => subtitleJobs.delete(key)));
    }

    log("STREAM", `OK ${key} sub=${info.subtitleUrl ? "var" : "yok"}`);
    res.json({ url: info.m3u8, hasSubtitles: !!info.subtitleUrl });
  } catch (e) {
    clearTimeout(routeTimeout);
    if (!res.headersSent) res.json({ error: e.message || "Hata" });
  }
});
app.get("/api/subtitle", async (req, res) => {
  try {
    const { id, ep, lang } = req.query;
    if (!id || !ep) return res.status(400).send("id ve ep gerekli");

    const key = `${id}_${ep}`;
    log("SUBREQ", `${key} lang=${lang}`);

    if (lang === "en") {
      const info = streamInfoCache.get(key);
      if (!info || !info.subtitleUrl) return res.status(404).send("no subtitle");
      const buf = await curlFetch(info.subtitleUrl);
      if (!buf) return res.status(500).send("fetch fail");
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.send(buf.toString("utf8"));
    }

    if (subtitleCache.has(key)) {
      log("SUBREQ", `${key} - cache HIT (TR)`);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.send(subtitleCache.get(key));
    }

    let info = streamInfoCache.get(key);

    if (!info || !info.subtitleUrl) {
      log("SUBREQ", `${key} - cache bos, yeniden fetch`);
      try {
        const fresh = await scraperQueue.run(() => fetchStreamInfo(id, ep));
        if (fresh) {
          info = fresh;
          streamInfoCache.set(key, { m3u8: fresh.m3u8, subtitleUrl: fresh.subtitleUrl });
          setTimeout(() => streamInfoCache.delete(key), CONFIG.CACHE_TTL);
        }
      } catch (e) {
        log("SUBREQ", `Fetch hata: ${e.message}`);
      }
    }

    if (!info || !info.subtitleUrl) {
      log("SUBREQ", `${key} - subtitle URL yok`);
      return res.status(404).send("no subtitle");
    }

    log("SUBREQ", `${key} - ceviri bekleniyor`);
    let job = subtitleJobs.get(key);
    if (!job) {
      job = generateTranslatedSubtitle(info.subtitleUrl, key);
      subtitleJobs.set(key, job);
      job.finally(() => subtitleJobs.delete(key));
    }

    const result = await job;
    if (!result) return res.status(500).send("translate fail");

    log("SUBREQ", `${key} - ceviri OK`);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(result);
  } catch (e) {
    log("SUBREQ", `Hata: ${e.message}`);
    res.status(500).send(e.message);
  }
});

app.get("/api/subtitle-status", (req, res) => {
  const { id, ep } = req.query;
  const key = `${id}_${ep}`;
  const info = streamInfoCache.get(key);

  res.json({
    hasSource: !!(info && info.subtitleUrl),
    translating: subtitleJobs.has(key),
    ready: subtitleCache.has(key)
  });
});

app.get("/api/proxy", async (req, res) => {
  try {
    let url = req.query.url;
    if (!url) return res.status(400).send("url gerekli");

    url = url.replace(/&amp;/g, "&");

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
    res.status(500).send("hata");
  }
});

app.get("/api/debug", async (req, res) => {
  const url = req.query.url || "https://vidnest.fun/anime/21355/1/sub";
  const country = req.query.country || "us";
  const result = await callScraperAPI(url, country);
  const m3u8 = extractM3u8(result.html);
  const sub = extractSubtitleFromHtml(result.html);

  res.json({
    url,
    country,
    status: result.status,
    elapsed: result.elapsed + "s",
    htmlLength: result.html ? result.html.length : 0,
    cloudflare: isCloudflareBlock(result.html),
    concurrency: isConcurrencyError(result.html),
    m3u8Found: !!m3u8,
    subtitleFound: !!sub,
    subtitleSample: sub,
    error: result.error || null,
    plan: CONFIG.PLAN
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    admin: adminDeviceId,
    apiKey: !!CONFIG.SA_KEY,
    streamCache: streamInfoCache.size,
    subtitleCache: subtitleCache.size,
    subtitleJobs: subtitleJobs.size,
    queue: scraperQueue.status(),
    mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB"
  });
});

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
  log("SOCKET", socket.id);

  socket.on("join", (data) => {
    const deviceId = data && data.deviceId ? String(data.deviceId) : null;
    if (!deviceId) return socket.emit("error-msg", { message: "deviceId gerekli" });

    socket.data.deviceId = deviceId;

    if (!adminDeviceId) {
      adminDeviceId = deviceId;
      saveAdmin();
      log("ADMIN", `Yeni: ${deviceId}`);
    }

    const isAdmin = deviceId === adminDeviceId;
    socket.emit("you-are", { isAdmin, deviceId, adminDeviceId });
    broadcastAdminStatus();

    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }

    log("JOIN", `${isAdmin ? "ADMIN" : "VIEWER"} ${deviceId}`);
  });

  socket.on("video-load", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.url) return;

    currentVideo = {
      url: data.url,
      title: data.title || "Video",
      animeId: data.animeId || null,
      episode: data.episode || 1,
      hasSubtitles: !!data.hasSubtitles,
      startedAt: Date.now()
    };
    currentState = { action: "play", currentTime: 0, at: Date.now() };

    socket.broadcast.emit("video-load", currentVideo);
    log("LOAD", currentVideo.title);
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
    log("CTRL", `${data.action} @ ${(data.currentTime || 0).toFixed(1)}s`);
  });

  socket.on("request-sync", () => {
    if (currentVideo) {
      socket.emit("video-load", currentVideo);
      socket.emit("video-state", currentState);
    }
  });

  socket.on("disconnect", () => {
    log("LEFT", socket.data.deviceId || socket.id);
    broadcastAdminStatus();
  });
});

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log("===========================================");
  console.log(`Sunucu ${CONFIG.PORT} portunda`);
  console.log(`Admin: ${adminDeviceId || "(ilk girene)"}`);
  console.log(`API: ScraperAPI`);
  console.log(`Plan: ${CONFIG.PLAN.map((p) => `${p.variant}/${p.country}`).join(" > ")}`);
  console.log("===========================================");
});

process.on("SIGTERM", () => {
  io.close();
  server.close(() => process.exit(0));
});

process.on("uncaughtException", (e) => log("ERR", e.message));
process.on("unhandledRejection", (e) => log("REJ", e && e.message ? e.message : e));
