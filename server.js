/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube STREAM + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC:
       Search YouTube (Data API if key else yt-search)
       Then yt-dlp -g => get DIRECT AUDIO STREAM URL (NO DOWNLOAD, NO FFMPEG)
   - Vision endpoint kept (/avoid_obstacle_vision)
   - Label override + scan endpoints + camera rotate
=========================================================================== */

import express from "express";
import fs from "fs";
import path from "path";
import dns from "dns";
import os from "os";
import { fileURLToPath } from "url";
import mqtt from "mqtt";
import dotenv from "dotenv";
import fetch from "node-fetch";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import cors from "cors";
import yts from "yt-search";
import { spawn } from "child_process";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

// ✅ Prefer IPv4 first (giảm lỗi DNS/IPv6 trên Railway)
dns.setDefaultResultOrder("ipv4first");

const uploadVision = multer({ storage: multer.memoryStorage() });
const upload = multer({ storage: multer.memoryStorage() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "3mb" }));
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });

/* ===========================================================================
   CONFIG
=========================================================================== */
const YT_VIDEO_DURATION = "medium";           // short|medium|long|any  (YouTube Data API)
const MAX_ACCEPTABLE_VIDEO_SECONDS = 900;     // 15 minutes filter
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const MUSIC_YTDLP_TIMEOUT_MS = Number(process.env.MUSIC_YTDLP_TIMEOUT_MS || 20000); // stream url must be fast
const MUSIC_STREAM_RETRY = Number(process.env.MUSIC_STREAM_RETRY || 2);

/* ===========================================================================
   CORS
=========================================================================== */
const allowedOrigins = [
  "https://videoserver-videoserver.up.railway.app",
  "http://localhost:8000",
  "http://localhost:8080",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("/upload_audio", cors());
app.options("/pi_upload_audio_v2", cors());

/* ===========================================================================
   RATE LIMIT (upload_audio)
=========================================================================== */
const requestLimitMap = {};
const MAX_REQ = 2;
const WINDOW_MS = 1000;

function uploadLimiter(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  if (!requestLimitMap[ip]) requestLimitMap[ip] = [];
  requestLimitMap[ip] = requestLimitMap[ip].filter((t) => now - t < WINDOW_MS);
  if (requestLimitMap[ip].length >= MAX_REQ)
    return res.status(429).json({ error: "Server busy, try again" });
  requestLimitMap[ip].push(now);
  next();
}

/* ===========================================================================
   RUN helper (spawn)
=========================================================================== */
function run(cmd, args, { timeoutMs = 180000, cwd = undefined, env = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env: env ?? process.env });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { }
      reject(new Error(`Timeout: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      reject(new Error(`Exit ${code}\nSTDERR:\n${err}\nSTDOUT:\n${out}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { }
}

/* ===========================================================================
   yt-dlp STREAM URL (NO DOWNLOAD)
=========================================================================== */
async function checkYtdlpReady() {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    console.log("✅ yt-dlp ready:", out.trim());
    return true;
  } catch (e) {
    console.error("❌ yt-dlp not found/failed:", e?.message || e);
    return false;
  }
}

// Lấy direct audio URL (ưu tiên m4a nếu có; nếu không thì bestaudio)
async function ytdlpGetAudioStreamUrl(youtubeUrl) {
  if (!youtubeUrl) throw new Error("Missing youtubeUrl");

  // NOTE: -g trả URL trực tiếp (thường googlevideo), sẽ hết hạn theo thời gian
  const args = [
    "--no-playlist",
    "--force-ipv4",
    "--retries", "5",
    "--socket-timeout", "10",
    "--geo-bypass",
    "--geo-bypass-country", "VN",
    "-f", "bestaudio[ext=m4a]/bestaudio/best",
    "-g",
    youtubeUrl,
  ];

  const { out } = await run(YTDLP_BIN, args, { timeoutMs: MUSIC_YTDLP_TIMEOUT_MS });
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const url = lines[0];

  if (!url || !url.startsWith("http")) {
    throw new Error("yt-dlp -g returned empty/invalid url");
  }
  return url;
}

// retry wrapper
async function getStreamUrlWithRetry(youtubeUrl) {
  let lastErr = null;
  for (let i = 0; i < Math.max(1, MUSIC_STREAM_RETRY + 1); i++) {
    try {
      return await ytdlpGetAudioStreamUrl(youtubeUrl);
    } catch (e) {
      lastErr = e;
      console.error(`[MUSIC] stream url attempt ${i + 1} failed:`, e?.message || e);
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr || new Error("Failed to get stream url");
}

/* ===========================================================================
   STATIC (for TTS mp3 only)
=========================================================================== */
app.use("/audio", express.static(audioDir));

/* ===========================================================================
   MQTT CLIENT
=========================================================================== */
const MQTT_HOST = process.env.MQTT_HOST || "rfff7184.ala.us-east-1.emqxsl.com";
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USER = process.env.MQTT_USER || "robot_matthew";
const MQTT_PASS = process.env.MQTT_PASS || "";

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;
const mqttClient = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
});

let scanStatus = "idle";

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");

  mqttClient.subscribe("/dieuhuongrobot");
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("/done_rotate_lidarleft");
  mqttClient.subscribe("/done_rotate_lidarright");
  mqttClient.subscribe("robot/audio_in");
  mqttClient.subscribe("robot/scanning180");
  mqttClient.subscribe("robot/label");

  mqttClient.subscribe("/robot/gesture/stopmusic");
  mqttClient.subscribe("/robot/gesture/stop");
  mqttClient.subscribe("robot/gesture/standup");
  mqttClient.subscribe("robot/gesture/sit");
  mqttClient.subscribe("robot/gesture/moveleft");
  mqttClient.subscribe("robot/moveright");
});

mqttClient.on("message", (topic, message) => {
  try {
    const msg = message.toString();

    if (topic === "robot/label") {
      console.log("==> Robot quyết định hướng:", msg);
      return;
    }

    if (topic === "robot/scanning180") {
      console.log("==> Quyết định xoay 180 độ:", msg);
      return;
    }

    if (topic === "robot/scanning_done") {
      scanStatus = "done";
      return;
    }

    if (topic === "/robot/gesture/stopmusic") {
      console.log("==> Detect gesture stop music");
      return;
    }
    if (topic === "/robot/gesture/stop") {
      console.log("==> Detect gesture stop");
      return;
    }
  } catch (err) {
    console.error("MQTT message error", err);
  }
});

/* ===========================================================================
   HELPERS
=========================================================================== */
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function getClientKey(req) {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").toString();
  return ip.split(",")[0].trim();
}

function getPublicHost() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const r = process.env.RAILWAY_STATIC_URL;
  if (r) return `https://${r}`;
  return `http://localhost:${PORT}`;
}

function filePathToPublicUrl(filePath) {
  const filename = path.basename(filePath);
  return `${getPublicHost()}/audio/${filename}`;
}

/* ===========================================================================
   VOICE (Eleven WAV->MP3) + fallback OpenAI
=========================================================================== */
const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ||
  "https://eleven-tts-wav-server-matthewrobotvoice.up.railway.app/convertvoice";

const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 45000);
const VOICE_TIMEOUT_PI_MS = Number(process.env.VOICE_TIMEOUT_PI_MS || 12000);

const DEFAULT_VOICE_PAYLOAD = {
  voice_settings: {
    stability: 0.45,
    similarity_boost: 0.9,
    style: 0,
    use_speaker_boost: true,
  },
  optimize_streaming_latency: 0,
};

async function openaiTtsToMp3File(replyText, prefix = "tts") {
  const filename = `${prefix}_${Date.now()}.mp3`;
  const outPath = path.join(audioDir, filename);

  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "ballad",
    format: "mp3",
    input: replyText,
  });

  fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));
  return outPath;
}

async function voiceServerToMp3FileWithTimeout(replyText, prefix = "eleven", timeoutMs = VOICE_TIMEOUT_MS) {
  const ts = Date.now();
  const wavTmp = path.join(audioDir, `${prefix}_${ts}.wav`);
  const mp3Out = path.join(audioDir, `${prefix}_${ts}.mp3`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(VOICE_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: replyText, ...DEFAULT_VOICE_PAYLOAD }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`VOICE_SERVER ${resp.status}: ${errText.slice(0, 400)}`);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());

    if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) {
      fs.writeFileSync(mp3Out, buf);
      return mp3Out;
    }

    fs.writeFileSync(wavTmp, buf);

    await new Promise((resolve, reject) =>
      ffmpeg(wavTmp)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(mp3Out)
    );

    safeUnlink(wavTmp);
    return mp3Out;
  } catch (e) {
    clearTimeout(timer);
    safeUnlink(wavTmp);
    safeUnlink(mp3Out);
    throw e;
  }
}

async function textToSpeechMp3FilePi(replyText, prefix = "pi_v2") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3File("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3FileWithTimeout(safeText, `${prefix}_eleven`, VOICE_TIMEOUT_PI_MS);
  } catch (e) {
    console.error("⚠️ PI voice server timeout/fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3File(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================
   MUSIC QUERY CLEANING
=========================================================================== */
function cleanMusicQuery(q = "") {
  let t = (q || "").toLowerCase().trim();
  t = t.replace(/\(.*?\)|\[.*?\]/g, " ");
  t = t.replace(/[.,;:!?]/g, " ");
  t = t.replace(
    /\b(official|mv|lyrics|karaoke|cover|8d|tiktok|sped\s*up|slowed|remix|ver\.?|version)\b/g,
    " "
  );
  t = t.replace(/\b(feat|ft)\.?\b/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function extractSongQuery(text = "") {
  let t = cleanMusicQuery(text);
  const tNoDau = stripDiacritics(t);

  const removePhrases = [
    "xin chao",
    "nghe",
    "toi muon nghe",
    "cho toi nghe",
    "nghe nhac",
    "phat nhac",
    "bat nhac",
    "mo bai",
    "bai hat",
    "bai nay",
    "nhac",
    "song",
    "music",
    "play",
  ];

  let s = tNoDau;
  for (const p of removePhrases) {
    const pp = stripDiacritics(p);
    s = s.replace(new RegExp(`\\b${pp}\\b`, "g"), " ");
  }
  s = s.replace(/\s+/g, " ").trim();

  if (!s || s.length < 2) return cleanMusicQuery(text);
  return cleanMusicQuery(s);
}

/* ===========================================================================
   Intent detection
=========================================================================== */
function isQuestionLike(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const q = [
    "la ai", "la gi", "cai gi", "vi sao", "tai sao", "o dau", "khi nao", "bao nhieu",
    "how", "what", "why", "where", "?"
  ];
  return q.some(k => t.includes(stripDiacritics(k)));
}

function looksLikeSongTitleOnly(userText = "") {
  const t = (userText || "").trim();
  if (!t) return false;

  const nd = stripDiacritics(t.toLowerCase());
  const banned = ["xoay", "qua", "ben", "tien", "lui", "trai", "phai", "dung", "stop"];
  if (banned.some(k => nd.includes(k))) return false;

  if (t.length > 70) return false;
  if (isQuestionLike(t)) return false;

  return /[a-zA-Z0-9À-ỹ]/.test(t);
}

function containsMusicIntent(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = [
    "nghe", "nghe nhac", "phat", "phat nhac", "mo", "mo nhac", "mo bai", "bat nhac",
    "bai hat", "cho toi nghe", "mở", "bật", "phát",
    "listen", "play song", "play music"
  ];
  return keys.some(k => t.includes(stripDiacritics(k)));
}

function looksLikeMusicQuery(text = "") {
  const raw = (text || "").trim();
  if (!raw) return false;

  const t = stripDiacritics(raw.toLowerCase());
  const banned = ["xoay", "quay", "re", "tien", "lui", "trai", "phai", "dung", "stop", "di"];
  if (banned.some(k => t.includes(k))) return false;

  if (isQuestionLike(raw)) return false;
  if (raw.length > 70) return false;

  const words = t.split(/\s+/).filter(Boolean);
  const hasTitlePattern =
    raw.includes("-") || raw.includes("|") || t.includes(" by ") || t.includes(" cua ") || t.includes(" cover ");

  const isShortPhrase = words.length >= 2 && words.length <= 8;
  const hasLetters = /[a-zA-ZÀ-ỹ]/.test(raw);

  return hasLetters && (hasTitlePattern || isShortPhrase);
}

function shouldAutoSwitchToMusic(text = "") {
  return containsMusicIntent(text) || looksLikeSongTitleOnly(text) || looksLikeMusicQuery(text);
}

function detectStopPlayback(text = "") {
  const t = stripDiacritics((text || "").toLowerCase()).trim();
  const patterns = [
    /\b(tat|tat\s*di|tat\s*giup|tắt|tắt\s*đi|tắt\s*giúp)\s*(nhac|nhạc|music|video)\b/u,
    /\b(dung|dung\s*lai|dung\s*di|dừng|dừng\s*lại|dừng\s*đi)\s*(nhac|nhạc|music|video)\b/u,
    /\b(stop|stop\s*now|stop\s*it)\b/u,
    /\b(skip|bo\s*qua|bỏ\s*qua)\b/u,
    /\b(im\s*di|im\s*đi)\b/u,
  ];
  return patterns.some((re) => re.test(t));
}

/* ===========================================================================
   YouTube Search
=========================================================================== */
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

function parseIsoDurationToSeconds(iso = "") {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

async function ytApiSearchCandidates(query, { videoDuration = YT_VIDEO_DURATION, maxResults = 8 } = {}) {
  if (!YOUTUBE_API_KEY) return null;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      maxResults: String(maxResults),
      videoDuration: videoDuration,
      key: YOUTUBE_API_KEY,
      safeSearch: "none",
      regionCode: "VN",
      relevanceLanguage: "vi",
      videoCategoryId: "10",
    });

    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    const resp = await fetch(url, { signal: controller.signal });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) throw new Error(`YT_API search error ${resp.status}`);

    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map((it) => ({
        videoId: it?.id?.videoId || "",
        title: it?.snippet?.title || "",
        channelTitle: it?.snippet?.channelTitle || "",
      }))
      .filter((x) => x.videoId);
  } finally {
    clearTimeout(t);
  }
}

async function ytApiFetchDurations(videoIds = []) {
  if (!YOUTUBE_API_KEY) return null;
  if (!videoIds.length) return [];

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const params = new URLSearchParams({
      part: "contentDetails,snippet",
      id: videoIds.join(","),
      key: YOUTUBE_API_KEY,
    });

    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
    const resp = await fetch(url, { signal: controller.signal });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) throw new Error(`YT_API videos error ${resp.status}`);

    const items = Array.isArray(data.items) ? data.items : [];
    return items.map((it) => {
      const iso = it?.contentDetails?.duration || "";
      const seconds = parseIsoDurationToSeconds(iso);
      return {
        videoId: it?.id || "",
        title: it?.snippet?.title || "",
        channelTitle: it?.snippet?.channelTitle || "",
        seconds: typeof seconds === "number" ? seconds : null,
      };
    });
  } finally {
    clearTimeout(t);
  }
}

async function searchYouTubeTop1(query) {
  const q = (query || "").trim();
  if (!q) return null;

  // 1) Prefer API
  try {
    const cands = await ytApiSearchCandidates(q, { videoDuration: YT_VIDEO_DURATION, maxResults: 8 });
    if (cands && cands.length) {
      const ids = cands.map((c) => c.videoId);
      const details = await ytApiFetchDurations(ids);

      const ok = (details || []).filter(
        (d) => typeof d.seconds === "number" && d.seconds <= MAX_ACCEPTABLE_VIDEO_SECONDS
      );
      const pick = ok[0] || (details || [])[0];

      if (pick?.videoId) {
        return {
          url: `https://www.youtube.com/watch?v=${pick.videoId}`,
          title: pick.title || "",
          seconds: typeof pick.seconds === "number" ? pick.seconds : null,
          author: pick.channelTitle || "",
        };
      }
    }
  } catch (e) {
    console.error("YT_API search failed -> fallback yt-search:", e?.message || e);
  }

  // 2) Fallback scrape
  try {
    const r = await yts(q);
    const vids = (r?.videos || []).filter((v) => !!v?.url);
    const ok = vids.filter((v) => typeof v.seconds === "number" && v.seconds <= MAX_ACCEPTABLE_VIDEO_SECONDS);
    const v = ok[0] || vids[0];
    if (!v?.url) return null;

    return {
      url: v.url,
      title: v.title || "",
      seconds: typeof v.seconds === "number" ? v.seconds : null,
      author: v.author?.name || "",
    };
  } catch (e) {
    console.error("YouTube search error:", e?.message || e);
    return null;
  }
}

/* ===========================================================================
   OVERRIDE LABEL
=========================================================================== */
function overrideLabelByText(label, text) {
  const t = stripDiacritics((text || "").toLowerCase());

  const question = ["la ai", "cho toi biet", "cho toi hoi", "cau hoi", "ban co biet"];
  if (question.some((k) => t.includes(k))) return "question";

  const rules = [
    { keys: ["nhac", "music", "play", "nghe bai hat", "nghe", "phat nhac", "cho toi nghe", "bat nhac", "mo nhac"], out: "nhac" },
    { keys: ["qua trai", "xoay trai", "ben trai"], out: "trai" },
    { keys: ["qua phai", "xoay phai", "ben phai"], out: "phai" },
    { keys: ["tien", "di len"], out: "tien" },
    { keys: ["lui", "di lui"], out: "lui" },
  ];

  for (const r of rules) {
    if (r.keys.some((k) => t.includes(stripDiacritics(k)))) return r.out;
  }
  return label;
}

/* ===========================================================================
   clap detect by STT text
=========================================================================== */
function isClapText(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["clap", "applause", "hand clap", "clapping", "vo tay", "tieng vo tay"];
  return keys.some((k) => t.includes(stripDiacritics(k)));
}

/* ===========================================================================
   VISION ENDPOINT
=========================================================================== */
app.post("/avoid_obstacle_vision", uploadVision.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No image" });

    let meta = {};
    try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }

    const distCm = meta.lidar_cm ?? meta.ultra_cm ?? null;
    const strength = meta.lidar_strength ?? meta.uart_strength ?? null;
    const localBest = meta.best_sector_local ?? meta.local_best_sector ?? meta.local_best ?? null;
    const corridorCenterX = meta.corridor_center_x ?? null;
    const corridorWidthRatio = meta.corridor_width_ratio ?? null;
    const corridorConf = meta.corridor_conf ?? null;

    const roiW = Number(meta.roi_w || 640);
    const roiH = Number(meta.roi_h || 240);

    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${b64}`;

    const system = `
Bạn là module "AvoidObstacle" cho robot đi trong nhà.
Mục tiêu: chọn hướng đi theo "lối đi dành cho người" (walkway/corridor) trong ROI.
Trả về JSON hợp lệ, KHÔNG giải thích.
`.trim();

    const user = [
      {
        type: "text",
        text: `
Meta:
- dist_cm: ${distCm}
- strength: ${strength}
- local_best_sector: ${localBest}
- local_corridor_center_x: ${corridorCenterX}
- local_corridor_width_ratio: ${corridorWidthRatio}
- local_corridor_conf: ${corridorConf}
ROI size: ${roiW}x${roiH}

Return JSON schema exactly:
{
  "best_sector": number,
  "walkway_center_x": number,
  "walkway_poly": [[x,y],[x,y],[x,y],[x,y]],
  "obstacles": [{"label": string, "bbox":[x1,y1,x2,y2], "risk": number}],
  "n_obstacles": number,
  "confidence": number
}
`.trim(),
      },
      { type: "image_url", image_url: { url: dataUrl } },
    ];

    const model = process.env.VISION_MODEL || "gpt-4.1-mini";
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens: 420,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "";
    let plan = null;

    try { plan = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}$/);
      if (m) { try { plan = JSON.parse(m[0]); } catch { } }
    }

    const fallbackCenter = typeof corridorCenterX === "number" ? corridorCenterX : Math.floor(roiW / 2);
    const fallbackBest = typeof localBest === "number" ? localBest : 4;
    const fallbackPoly = (() => {
      const halfW = Math.floor(roiW * 0.18);
      const x1 = Math.max(0, fallbackCenter - halfW);
      const x2 = Math.min(roiW - 1, fallbackCenter + halfW);
      const yTop = Math.floor(0.6 * roiH);
      return [[x1, roiH - 1], [x2, roiH - 1], [x2, yTop], [x1, yTop]];
    })();

    if (!plan || typeof plan !== "object") {
      return res.status(200).json({
        best_sector: fallbackBest,
        walkway_center_x: fallbackCenter,
        walkway_poly: fallbackPoly,
        obstacles: [],
        n_obstacles: 0,
        confidence: 0.15,
      });
    }

    if (typeof plan.best_sector !== "number") plan.best_sector = fallbackBest;
    if (!Array.isArray(plan.obstacles)) plan.obstacles = [];
    if (!Array.isArray(plan.walkway_poly)) plan.walkway_poly = fallbackPoly;

    if (typeof plan.walkway_center_x !== "number") plan.walkway_center_x = fallbackCenter;
    plan.walkway_center_x = Math.max(0, Math.min(roiW - 1, Number(plan.walkway_center_x)));
    plan.n_obstacles = plan.obstacles.length;
    if (typeof plan.confidence !== "number") plan.confidence = 0.4;
    plan.confidence = Math.max(0, Math.min(1, plan.confidence));

    return res.json(plan);
  } catch (err) {
    console.error("/avoid_obstacle_vision error:", err);
    res.status(500).json({ error: err.message || "vision failed" });
  }
});

/* ===========================================================================
   UPLOAD_AUDIO — PI v2
=========================================================================== */
app.post(
  "/pi_upload_audio_v2",
  uploadLimiter,
  upload.fields([{ name: "audio", maxCount: 1 }, { name: "image", maxCount: 1 }]),
  async (req, res) => {
    try {
      const t0 = Date.now();
      const ms = () => Date.now() - t0;

      const audioFile = req.files?.audio?.[0];
      const userKey = getClientKey(req);

      if (!audioFile?.buffer) return res.status(400).json({ error: "No audio uploaded" });

      let meta = {};
      try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }
      const memoryArr = Array.isArray(meta.memory) ? meta.memory : [];

      const wavPath = path.join(audioDir, `pi_v2_${Date.now()}.wav`);
      fs.writeFileSync(wavPath, audioFile.buffer);

      // STT
      let text = "";
      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(wavPath),
          model: "gpt-4o-mini-transcribe",
        });
        text = (tr.text || "").trim();
        console.log("🎤 PI_V2 STT:", text, `(${ms()}ms)`);
      } catch (e) {
        console.error("PI_V2 STT error:", e?.message || e);
        safeUnlink(wavPath);
        return res.json({ status: "error", transcript: "", label: "unknown", reply_text: "", audio_url: null, play: null, used_vision: false });
      } finally {
        safeUnlink(wavPath);
      }

      // clap
      if (isClapText(text)) {
        console.log("👏 Detected CLAP by STT -> return label=clap");
        return res.json({
          status: "ok",
          transcript: text,
          label: "clap",
          reply_text: "",
          audio_url: null,
          play: null,
          used_vision: false,
        });
      }

      // stop playback
      if (detectStopPlayback(text)) {
        const replyText = "Dạ, em tắt nhạc nha.";
        const ttsPath = await textToSpeechMp3FilePi(replyText, "stop");
        const tts_url = filePathToPublicUrl(ttsPath);
        return res.json({
          status: "ok",
          transcript: text,
          label: "stop_playback",
          reply_text: replyText,
          audio_url: tts_url,   // giữ tương thích: client play mp3 này nếu muốn
          play: null,
          used_vision: false,
        });
      }

      // label detect + AUTO SWITCH to MUSIC
      let label = overrideLabelByText("unknown", text);
      if (label !== "nhac" && shouldAutoSwitchToMusic(text)) label = "nhac";

      // ===========================
      // MUSIC STREAM
      // ===========================
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);

        console.log("🎵 MUSIC:", {
          stt: text,
          q,
          found: !!top?.url,
          url: top?.url,
          seconds: top?.seconds ?? null,
          duration_filter: YT_VIDEO_DURATION,
          max_accept_s: MAX_ACCEPTABLE_VIDEO_SECONDS,
        }, `(${ms()}ms)`);

        if (top?.url) {
          const streamUrl = await getStreamUrlWithRetry(top.url);
          const songTitle = (top.title || "").trim() || "bài này";
          const replyText = `Đây rồi: "${songTitle}".`;

          // (optional) tạo TTS mp3 để robot đọc, nhưng KHÔNG merge
          let tts_url = null;
          try {
            const ttsPath = await textToSpeechMp3FilePi(replyText, "music_tts");
            tts_url = filePathToPublicUrl(ttsPath);
          } catch (e) {
            console.error("⚠️ music tts fail:", e?.message || e);
          }

          // publish MQTT: gửi streamUrl (quan trọng)
          mqttClient.publish(
            "robot/music",
            JSON.stringify({
              label: "nhac",
              title: songTitle,
              stream_url: streamUrl, // ✅ direct stream
              tts_url,               // optional
              user: userKey,
              time: Date.now(),
            }),
            { qos: 1 }
          );

          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: replyText,
            audio_url: streamUrl, // ✅ bạn nói chỉ cần audio ok => trả stream luôn
            play: { type: "stream", url: streamUrl, title: songTitle, tts_url },
            used_vision: false,
          });
        }

        const replyText = "Em không tìm thấy bài trên YouTube. Anh nói lại tên bài + ca sĩ giúp em nha.";
        const ttsPath = await textToSpeechMp3FilePi(replyText, "yt_fail");
        const audio_url = filePathToPublicUrl(ttsPath);
        return res.json({
          status: "ok",
          transcript: text,
          label: "nhac",
          reply_text: replyText,
          audio_url,
          play: null,
          used_vision: false,
        });
      }

      // movement -> MQTT
      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
        return res.json({
          status: "ok",
          transcript: text,
          label,
          reply_text: "",
          audio_url: null,
          play: null,
          used_vision: false,
        });
      }

      // GPT chat (no vision)
      const memoryText = (memoryArr || [])
        .slice(-12)
        .map((m, i) => {
          const u = (m.transcript || "").trim();
          const a = (m.reply_text || "").trim();
          return `#${i + 1} USER: ${u}\n#${i + 1} BOT: ${a}`;
        })
        .join("\n\n");

      const system = `
Bạn là dog robot của Matthew. Trả lời ngắn gọn, dễ hiểu, thân thiện.
Tạm thời KHÔNG mô tả ảnh. Trả lời dựa trên câu nói của người dùng.
`.trim();

      const messages = [{ role: "system", content: system }];
      if (memoryText) {
        messages.push({
          role: "system",
          content: `Robot recent memory:\n${memoryText}`.slice(0, 6000),
        });
      }

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [...messages, { role: "user", content: text }],
        temperature: 0.25,
        max_tokens: 260,
      });

      const replyText =
        completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";

      const ttsPath = await textToSpeechMp3FilePi(replyText, "pi_v2");
      const audio_url = filePathToPublicUrl(ttsPath);

      mqttClient.publish(
        "robot/music",
        JSON.stringify({ audio_url, text: replyText, label, user: userKey }),
        { qos: 1 }
      );

      console.log("✅ PI_V2 done", `(${ms()}ms)`);

      return res.json({
        status: "ok",
        transcript: text,
        label,
        reply_text: replyText,
        audio_url,
        play: null,
        used_vision: false,
      });
    } catch (err) {
      console.error("pi_upload_audio_v2 error:", err);
      res.status(500).json({ error: err.message || "server error" });
    }
  }
);

/* ===========================================================================
   Debug endpoints
=========================================================================== */
app.get("/debug_ytdlp", async (req, res) => {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    return res.json({ ok: true, ytdlp: out.trim() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/test_stream", async (req, res) => {
  try {
    const url = (req.query.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    const stream_url = await getStreamUrlWithRetry(url);
    res.json({ ok: true, stream_url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===========================================================================
   CAMERA ROTATE
=========================================================================== */
app.get("/camera_rotate", (req, res) => {
  try {
    const angle = parseInt(req.query.angle || "0", 10);
    const direction = req.query.direction || "abs";

    if (isNaN(angle) || angle < 0 || angle > 180) {
      return res.status(400).json({ error: "Angle must be 0–180" });
    }

    const payload = { angle, direction, time: Date.now() };
    mqttClient.publish("/robot/camera_rotate", JSON.stringify(payload), { qos: 1 });
    console.log("📡 Sent /robot/camera_rotate →", payload);

    res.json({ status: "ok", payload });
  } catch (e) {
    console.error("/camera_rotate error:", e);
    res.status(500).json({ error: "server error" });
  }
});

/* ===========================================================================
   SCAN TRIGGER ENDPOINTS
=========================================================================== */
function triggerScanEndpoint(pathUrl, payload) {
  return (req, res) => {
    try {
      const msg = { ...payload, time: Date.now() };
      mqttClient.publish(pathUrl, JSON.stringify(msg), { qos: 1 });
      console.log(`📡 Triggered scan → ${pathUrl}`);
      res.json({ status: "ok", topic: pathUrl, payload: msg });
    } catch (e) {
      res.status(500).json({ error: "Trigger failed" });
    }
  };
}

app.get("/trigger_scan", triggerScanEndpoint("robot/scanning360", { action: "start_scan" }));
app.get("/trigger_scan180", triggerScanEndpoint("robot/scanning180", { action: "scan_180" }));
app.get("/trigger_scan90", triggerScanEndpoint("robot/scanning90", { action: "scan_90" }));
app.get("/trigger_scan45", triggerScanEndpoint("robot/scanning45", { action: "scan_45" }));
app.get("/trigger_scan30", triggerScanEndpoint("robot/scanning30", { action: "scan_30" }));

/* ===========================================================================
   SCAN STATUS
=========================================================================== */
app.get("/get_scanningstatus", (req, res) => {
  res.json({ status: scanStatus });
});

/* ===========================================================================
   ROOT
=========================================================================== */
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀 (YouTube STREAM mode: yt-dlp -g, no download)");
});

/* ===========================================================================
   START SERVER
=========================================================================== */
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  console.log(`🎵 YouTube stream mode: yt-dlp -g (no download)`);
  console.log(`🎵 yt-dlp stream timeout: ${MUSIC_YTDLP_TIMEOUT_MS} ms`);
  console.log(`🎵 YouTube Data API enabled: ${!!YOUTUBE_API_KEY}`);
  await checkYtdlpReady();
});
