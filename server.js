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

  OS_KEY: "lUQ1BUATojEqaakujSa1KnTzkrlOD6F9",
  OS_ENDPOINT: "https://api.opensubtitles.com/api/v1",

  CACHE_TTL: 60 * 60 * 1000,
  SUB_CACHE_TTL: 6 * 60 * 60 * 1000,
  API_TIMEOUT: 40000,
  QUEUE_TIMEOUT: 120000,
  STREAM_ROUTE_TIMEOUT: 110000,

  PLAN_SUB: [
    { country: "us", variant: "sub" },
    { country: "us", variant: "sub" }
  ],
  PLAN_DUB: [
    { country: "us", variant: "dub" },
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
const osSearchCache = new Map();

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
      task.reject(new Error("kuyruk zaman asimi"));
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
    return { queueLength: this.queue.length, running: this.running, stats: this.stats };
  }
}

const scraperQueue = new SerialQueue();

async function callScraperAPI(targetUrl, country) {
  if (!CONFIG.SA_KEY) return { html: null, status: 0, error: "api_key_yok" };
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
    if (!r.ok) return { html: null, status: r.status, elapsed, error: html.slice(0, 300) };
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
    .filter((u) => !u.includes("index-f1") && !u.includes("iframes") && !u.includes("segment"));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a.length > b.length ? a : b);
}

function extractSubtitleFromHtml(html) {
  if (!html) return null;
  const regex = /https?:\/\/[^"'\s\\<>]+\.(?:vtt|srt)[^"'\s\\<>]*/g;
  const matches = html.match(regex) || [];
  if (matches.length === 0) return null;
  return decodeHtmlEntities(matches[0]);
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

async function fetchStreamInfo(animeId, episode, mode) {
  const baseUrl = `https://vidnest.fun/anime/${animeId}/${episode}`;
  const plan = mode === "dub" ? CONFIG.PLAN_DUB : CONFIG.PLAN_SUB;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const targetUrl = `${baseUrl}/${p.variant}`;
    log("PLAN", `#${i + 1} ${p.variant}/${p.country} (${mode})`);
    const result = await callScraperAPI(targetUrl, p.country);
    const isLimitError = result.status === 429 || result.status === 409 || result.status === 401 || result.status === 403;
    if (isLimitError || (result.html && isConcurrencyError(result.html))) {
      log("RETRY", "Limit, 6s bekle");
      await new Promise((r) => setTimeout(r, 6000));
      const retry = await callScraperAPI(targetUrl, p.country);
      if (retry.html && !isConcurrencyError(retry.html)) {
        const m3u8 = extractM3u8(retry.html);
        if (m3u8) {
          const sub = extractSubtitleFromHtml(retry.html);
          log("OK", `Plan#${i + 1} retry sub=${sub ? "var" : "yok"}`);
          return { m3u8, subtitleUrl: sub, mode: p.variant };
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
      return { m3u8, subtitleUrl: sub, mode: p.variant };
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

// ═══════════════════════════════════════════════════════════
// SRT → VTT DÖNÜŞTÜRÜCÜ
// ═══════════════════════════════════════════════════════════

function srtToVtt(srtText) {
  if (!srtText) return "";
  const clean = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const vtt = "WEBVTT\n\n" + clean
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/^\d+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return vtt;
}

// ═══════════════════════════════════════════════════════════
// OPENSUBTITLES API
// ═══════════════════════════════════════════════════════════

function cleanAnimeTitle(title) {
  if (!title) return "";
  return title
    .replace(/\(TV\)|\(OVA\)|\(ONA\)|\(Movie\)/gi, "")
    .replace(/Season\s*\d+/gi, "")
    .replace(/:\s*-?Starting.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchOpenSubtitles(query, season, episode) {
  const cacheKey = `${query}_${season}_${episode}`;
  if (osSearchCache.has(cacheKey)) {
    return osSearchCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    query: query,
    languages: "tr",
    type: "episode"
  });
  if (season) params.append("season_number", String(season));
  if (episode) params.append("episode_number", String(episode));

  const url = `${CONFIG.OS_ENDPOINT}/subtitles?${params.toString()}`;
  log("OS", `Arama: ${query} S${season}E${episode}`);

  try {
    const r = await fetch(url, {
      headers: {
        "Api-Key": CONFIG.OS_KEY,
        "Content-Type": "application/json",
        "User-Agent": "AnimeStream v1.0"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (r.status === 429) {
      log("OS", `Rate limit`);
      return null;
    }
    if (!r.ok) {
      log("OS", `HTTP ${r.status}`);
      return null;
    }

    const d = await r.json();
    const data = (d && d.data) || [];
    log("OS", `${data.length} sonuc`);

    if (data.length === 0) return null;

    // Türkçe + bölüm numarası uyanları filtrele
    const filtered = data.filter((s) => {
      const a = s.attributes;
      if (a.language !== "tr") return false;
      if (episode && a.feature_details && a.feature_details.episode_number) {
        return String(a.feature_details.episode_number) === String(episode);
      }
      return true;
    });

    const results = filtered.length > 0 ? filtered : data;

    // En yüksek indirmeye sahip olanı seç
    results.sort((a, b) => (b.attributes.download_count || 0) - (a.attributes.download_count || 0));

    const best = results[0];
    const fileId = best.attributes.files && best.attributes.files[0] ? best.attributes.files[0].file_id : null;

    if (!fileId) return null;

    const out = { fileId, release: best.attributes.release || "Bilinmeyen" };
    osSearchCache.set(cacheKey, out);
    setTimeout(() => osSearchCache.delete(cacheKey), CONFIG.SUB_CACHE_TTL);
    return out;
  } catch (e) {
    log("OS", `Hata: ${e.message.slice(0, 80)}`);
    return null;
  }
}

async function downloadOpenSubtitles(fileId) {
  try {
    const r = await fetch(`${CONFIG.OS_ENDPOINT}/download`, {
      method: "POST",
      headers: {
        "Api-Key": CONFIG.OS_KEY,
        "Content-Type": "application/json",
        "User-Agent": "AnimeStream v1.0",
        "Accept": "application/json"
      },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(15000)
    });

    if (!r.ok) {
      log("OS", `Indirme HTTP ${r.status}`);
      return null;
    }

    const d = await r.json();
    if (!d.link) return null;

    log("OS", `Indirme linki alindi`);
    const buf = await curlFetch(d.link);
    if (!buf || buf.length === 0) return null;

    return buf.toString("utf8");
  } catch (e) {
    log("OS", `Indirme hata: ${e.message.slice(0, 80)}`);
    return null;
  }
}

async function fetchTurkishSubtitle(animeTitle, season, episode) {
  const cleanTitle = cleanAnimeTitle(animeTitle);
  if (!cleanTitle) return null;

  // Birden fazla arama terimi dene
  const queries = [
    cleanTitle,
    cleanTitle.split(":")[0].trim(),
    cleanTitle.split("-")[0].trim(),
    cleanTitle.split(" ").slice(0, 2).join(" ")
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);

  for (const q of queries) {
    log("OS", `Deneme: "${q}"`);
    const found = await searchOpenSubtitles(q, season, episode);
    if (found) {
      const srt = await downloadOpenSubtitles(found.fileId);
      if (srt && srt.length > 50) {
        const vtt = srtToVtt(srt);
        if (vtt && vtt.length > 50) {
          log("OS", `Basarili: ${found.release}`);
          return vtt;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json({ results: [] });

    const body = {
      query: "query($s:String){Page(perPage:25){media(search:$s,type:ANIME,sort:TRENDING_DESC){id title{english romaji native} episodes format seasonYear coverImage{large} averageScore}}}",
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
        title: x.title.english || x.title.romaji || x.title.native,
        titleRomaji: x.title.romaji,
        titleEnglish: x.title.english || "",
        episodes: x.episodes || 0,
        format: x.format || "TV",
        year: x.seasonYear || "",
        poster: x.coverImage ? x.coverImage.large : "",
        score: x.averageScore || 0
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
      res.status(200).json({ error: "Zaman asimi. Farkli bolum deneyin." });
    }
  }, CONFIG.STREAM_ROUTE_TIMEOUT);

  try {
    const { id, ep, mode, title, season } = req.query;
    if (!id || !ep) {
      clearTimeout(routeTimeout);
      return res.json({ error: "id ve ep gerekli" });
    }

    const videoMode = mode === "dub" ? "dub" : "sub";
    const key = `${id}_${ep}_${videoMode}`;

    if (streamInfoCache.has(key)) {
      clearTimeout(routeTimeout);
      const info = streamInfoCache.get(key);
      log("CACHE", key);
      return res.json({
        url: info.m3u8,
        hasSubtitles: true,
        mode: info.mode,
        cached: true
      });
    }

    log("STREAM", key);
    const info = await scraperQueue.run(() => fetchStreamInfo(id, ep, videoMode));

    clearTimeout(routeTimeout);

    if (!info || !info.m3u8) {
      return res.json({ error: "Video bulunamadi. Farkli bolum veya mod deneyin." });
    }

    m3u8Cache.set(key, info.m3u8);
    setTimeout(() => m3u8Cache.delete(key), CONFIG.CACHE_TTL);

    streamInfoCache.set(key, { m3u8: info.m3u8, subtitleUrl: info.subtitleUrl, mode: info.mode });
    setTimeout(() => streamInfoCache.delete(key), CONFIG.CACHE_TTL);

    // OpenSubtitles'tan Türkçe altyazı çek
    if (title && !subtitleJobs.has(key) && !subtitleCache.has(key)) {
      const seasonNum = parseInt(season) || 1;
      const episodeNum = parseInt(ep) || 1;
      subtitleJobs.set(
        key,
        fetchTurkishSubtitle(title, seasonNum, episodeNum).then((vtt) => {
          if (vtt) {
            subtitleCache.set(key, vtt);
            setTimeout(() => subtitleCache.delete(key), CONFIG.SUB_CACHE_TTL);
          }
          return vtt;
        }).finally(() => subtitleJobs.delete(key))
      );
    }

    log("STREAM", `OK ${key}`);
    res.json({ url: info.m3u8, hasSubtitles: true, mode: info.mode });
  } catch (e) {
    clearTimeout(routeTimeout);
    if (!res.headersSent) res.json({ error: e.message || "Hata" });
  }
});

app.get("/api/subtitle", async (req, res) => {
  try {
    const { id, ep, mode, lang, title, season } = req.query;
    if (!id || !ep) return res.status(400).send("id ve ep gerekli");

    const videoMode = mode === "dub" ? "dub" : "sub";
    const key = `${id}_${ep}_${videoMode}`;
    log("SUBREQ", `${key} lang=${lang} title=${title}`);

    if (subtitleCache.has(key)) {
      log("SUBREQ", `${key} cache HIT`);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.send(subtitleCache.get(key));
    }

    // İş hâlâ devam ediyorsa bekle
    if (subtitleJobs.has(key)) {
      log("SUBREQ", `${key} islem devam, bekleniyor`);
      const result = await subtitleJobs.get(key);
      if (result) {
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        return res.send(result);
      }
    }

    // İş yoksa yeniden başlat
    if (title) {
      const seasonNum = parseInt(season) || 1;
      const episodeNum = parseInt(ep) || 1;
      const job = fetchTurkishSubtitle(title, seasonNum, episodeNum).then((vtt) => {
        if (vtt) {
          subtitleCache.set(key, vtt);
          setTimeout(() => subtitleCache.delete(key), CONFIG.SUB_CACHE_TTL);
        }
        return vtt;
      }).finally(() => subtitleJobs.delete(key));
      subtitleJobs.set(key, job);

      const result = await job;
      if (result) {
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        return res.send(result);
      }
    }

    return res.status(404).send("altyazi yok");
  } catch (e) {
    log("SUBREQ", `Hata: ${e.message}`);
    res.status(500).send(e.message);
  }
});

app.get("/api/subtitle-status", (req, res) => {
  const { id, ep, mode } = req.query;
  const videoMode = mode === "dub" ? "dub" : "sub";
  const key = `${id}_${ep}_${videoMode}`;
  res.json({
    hasSource: true,
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
            } catch (e) { return 'URI="' + uri + '"'; }
          });
        }
        if (!line || line.startsWith("#")) return line;
        const x = line.trim();
        if (!x) return line;
        try { return "/api/proxy?url=" + encodeURIComponent(new URL(x, baseUrl).toString()); }
        catch (e) { return line; }
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
    url, country,
    status: result.status,
    elapsed: result.elapsed + "s",
    htmlLength: result.html ? result.html.length : 0,
    m3u8Found: !!m3u8,
    subtitleFound: !!sub,
    error: result.error || null
  });
});

app.get("/api/os-test", async (req, res) => {
  const q = req.query.q || "Re:Zero";
  const s = req.query.s || "1";
  const e = req.query.e || "1";
  const found = await searchOpenSubtitles(q, s, e);
  res.json({ query: q, season: s, episode: e, found });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    admin: adminDeviceId,
    apiKey: !!CONFIG.SA_KEY,
    osKey: !!CONFIG.OS_KEY,
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
  io.emit("admin-status", { adminDeviceId, totalDevices: io.sockets.sockets.size });
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
    log("JOIN", `${isAdmin ? "ADMIN" : "IZLEYICI"} ${deviceId}`);
  });

  socket.on("video-load", (data) => {
    if (!isAdminSocket(socket)) return;
    if (!data || !data.url) return;
    currentVideo = {
      url: data.url,
      title: data.title || "Video",
      animeId: data.animeId || null,
      episode: data.episode || 1,
      season: data.season || 1,
      mode: data.mode || "sub",
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
    currentState = { action: data.action, currentTime: data.currentTime || 0, at: Date.now() };
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
  console.log(`ScraperAPI: ${CONFIG.SA_KEY ? "AKTIF" : "YOK"}`);
  console.log(`OpenSubtitles: ${CONFIG.OS_KEY ? "AKTIF" : "YOK"}`);
  console.log("===========================================");
});

process.on("SIGTERM", () => {
  io.close();
  server.close(() => process.exit(0));
});
process.on("uncaughtException", (e) => log("ERR", e.message));
process.on("unhandledRejection", (e) => log("REJ", e && e.message ? e.message : e));
