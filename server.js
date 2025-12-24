/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC:
       (A) Search: YouTube Data API v3 (if YOUTUBE_API_KEY set) with videoDuration=medium
           fallback to yt-search (scrape) and locally filter duration
       (B) Download: yt-dlp download ONLY first MAX_MUSIC_SECONDS -> mp3
           fallback to full download+trim if needed
   - Vision only when user asks (kept only for /avoid_obstacle_vision endpoint)
   - Label override + scan endpoints + camera rotate
=========================================================================== */

import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import dns from "dns";
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
   CONFIG (defaults hard-coded)
=========================================================================== */
const MAX_MUSIC_SECONDS = 540;                // 9 minutes
const YT_VIDEO_DURATION = "medium";           // short|medium|long|any  (YouTube Data API)
const MAX_ACCEPTABLE_VIDEO_SECONDS = 900;     // 15 minutes (lọc clip dài)

const MUSIC_FFMPEG_TIMEOUT_MS = Number(process.env.MUSIC_FFMPEG_TIMEOUT_MS || 240000); // 4 min
const MUSIC_YTDLP_TIMEOUT_MS = Number(process.env.MUSIC_YTDLP_TIMEOUT_MS || 220000);  // 3.6 min
const MUSIC_DOWNLOAD_RETRY = Number(process.env.MUSIC_DOWNLOAD_RETRY || 2);

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

function safeRmdir(p) {
  try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { }
}

/* ===========================================================================
   yt-dlp + ffmpeg
   - FIX: retry-sleep syntax (KHÔNG dùng "1:linear", phải "http:linear=1::2"...)
   - Try multiple youtube player clients (android/ios/mweb/web/tv)
   - Optional: YT_VISITOR_DATA / YT_PO_TOKEN / YT_COOKIES_PATH
=========================================================================== */
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

// OPTIONAL (khi YouTube yêu cầu)
const YT_VISITOR_DATA = (process.env.YT_VISITOR_DATA || "").trim();
const YT_PO_TOKEN = (process.env.YT_PO_TOKEN || "").trim();
const YT_COOKIES_PATH = (process.env.YT_COOKIES_PATH || "").trim();

// Thử các client để né SABR / 502 / missing url
const YT_CLIENT_TRY_ORDER = ["android", "ios", "mweb", "web", "tv"];

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

function findDownloadedFile(baseNoExt) {
  const exts = ["m4a", "webm", "opus", "aac", "mp4", "mkv", "wav", "flac", "mp3"];
  for (const ext of exts) {
    const p = `${baseNoExt}.${ext}`;
    if (fs.existsSync(p) && fs.statSync(p).size > 50_000) return p;
  }
  const dir = path.dirname(baseNoExt);
  const prefix = path.basename(baseNoExt) + ".";
  try {
    const files = fs.readdirSync(dir);
    const hit = files.find((f) => f.startsWith(prefix));
    if (hit) {
      const full = path.join(dir, hit);
      if (fs.existsSync(full) && fs.statSync(full).size > 50_000) return full;
    }
  } catch { }
  return null;
}

function buildExtractorArgsForClient(client) {
  // youtube extractor args: player_client=...
  // optional visitor_data / po_token (khi yt-dlp warn Missing required Visitor Data)
  const parts = [`player_client=${client}`];
  if (YT_VISITOR_DATA) parts.push(`visitor_data=${YT_VISITOR_DATA}`);
  if (YT_PO_TOKEN) parts.push(`po_token=${YT_PO_TOKEN}`);
  return `youtube:${parts.join(";")}`;
}

function buildCommonYtdlpArgs() {
  const args = [
    "--no-playlist",
    "--force-ipv4",

    // retries
    "--retries", "10",
    "--fragment-retries", "10",
    "--extractor-retries", "10",

    // ✅ FIX retry-sleep syntax (đúng chuẩn yt-dlp)
    // EXPR dạng linear=START[:END[:STEP=1]] hoặc exp=START[:END[:BASE=2]]
    // Ví dụ official: --retry-sleep linear=1::2 --retry-sleep fragment:exp=1:20
    "--retry-sleep", "http:linear=1::2",
    "--retry-sleep", "fragment:linear=1::2",
    "--retry-sleep", "extractor:linear=1::2",
    "--retry-sleep", "file_access:linear=1::2",

    // timeouts
    "--socket-timeout", "15",

    // tránh bị chặn nhanh (nhẹ thôi)
    "--sleep-requests", "1",

    // header nhẹ (giảm 502 ở vài môi trường)
    "--add-header", "Accept-Language:vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  ];

  // cookies nếu có
  if (YT_COOKIES_PATH && fs.existsSync(YT_COOKIES_PATH)) {
    args.push("--cookies", YT_COOKIES_PATH);
  }

  return args;
}

// (old) Download full audio to local file (NO streaming)
async function ytdlpDownloadBestAudio(youtubeUrl, outDir) {
  if (!youtubeUrl) throw new Error("Missing youtubeUrl");
  fs.mkdirSync(outDir, { recursive: true });

  const base = path.join(outDir, `ytdlp_${Date.now()}`);
  const template = `${base}.%(ext)s`;

  let lastErr = null;

  for (const client of YT_CLIENT_TRY_ORDER) {
    try {
      console.log(`🎵 [yt-dlp] full download try client=${client}`);
      const args = [
        ...buildCommonYtdlpArgs(),
        "--extractor-args", buildExtractorArgsForClient(client),

        // prefer m4a if possible (hay ổn hơn webm ở vài case)
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "-o", template,
        youtubeUrl,
      ];

      await run(YTDLP_BIN, args, { timeoutMs: MUSIC_YTDLP_TIMEOUT_MS });

      const downloaded = findDownloadedFile(base);
      if (!downloaded) throw new Error("yt-dlp download finished but file not found");
      return downloaded;
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ [yt-dlp] client=${client} failed:`, e?.message || e);
      await sleep(600);
    }
  }

  throw lastErr || new Error("yt-dlp full download failed all clients");
}

// (old) Local trim+convert to mp3
async function ffmpegTrimToMp3Local(inputFile, outMp3, maxSeconds = MAX_MUSIC_SECONDS) {
  if (!inputFile || !fs.existsSync(inputFile)) throw new Error("Input file missing");
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputFile,
    "-t", String(Math.max(1, Math.floor(maxSeconds))),
    "-vn",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "192k",
    outMp3,
  ];

  await run(ffmpegPath, args, { timeoutMs: MUSIC_FFMPEG_TIMEOUT_MS });

  if (!fs.existsSync(outMp3) || fs.statSync(outMp3).size < 20_000) {
    throw new Error("ffmpeg output too small / missing");
  }
  return outMp3;
}

// ✅ NEW: Download ONLY first N seconds -> MP3 (fast)
async function ytdlpDownloadFirstNSecondsMp3(youtubeUrl, outDir, seconds = MAX_MUSIC_SECONDS) {
  if (!youtubeUrl) throw new Error("Missing youtubeUrl");
  fs.mkdirSync(outDir, { recursive: true });

  const base = path.join(outDir, `ytclip_${Date.now()}`);
  const template = `${base}.%(ext)s`;

  const sec = Math.max(1, Math.floor(Number(seconds) || MAX_MUSIC_SECONDS));

  let lastErr = null;

  for (const client of YT_CLIENT_TRY_ORDER) {
    try {
      console.log(`🎵 [yt-dlp] section clip try client=${client}`);

      const args = [
        ...buildCommonYtdlpArgs(),
        "--extractor-args", buildExtractorArgsForClient(client),

        // Use ffmpeg-static to only pull first N seconds
        "--ffmpeg-location", ffmpegPath,
        "--external-downloader", ffmpegPath,
        "--external-downloader-args", `ffmpeg_i:-ss 0 -t ${sec}`,

        // format
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "-o", template,
        youtubeUrl,
      ];

      await run(YTDLP_BIN, args, { timeoutMs: MUSIC_YTDLP_TIMEOUT_MS });

      const downloaded = findDownloadedFile(base);
      if (!downloaded || !downloaded.endsWith(".mp3")) {
        throw new Error("yt-dlp section download finished but mp3 not found");
      }
      if (!fs.existsSync(downloaded) || fs.statSync(downloaded).size < 30_000) {
        throw new Error("downloaded mp3 too small / invalid");
      }

      return downloaded;
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ [yt-dlp] client=${client} failed:`, e?.message || e);
      await sleep(700);
    }
  }

  throw lastErr || new Error("yt-dlp section clip failed all clients");
}

async function extractFirst9MinMp3FromYoutube(youtubeUrl, outDir) {
  if (!youtubeUrl) throw new Error("Missing url");

  // ✅ prefer fast section download
  try {
    const mp3 = await ytdlpDownloadFirstNSecondsMp3(youtubeUrl, outDir, MAX_MUSIC_SECONDS);
    return mp3;
  } catch (e) {
    console.error("[MUSIC] section clip failed -> fallback full download+trim:", e?.message || e);
  }

  // fallback to old method
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), "yt_work_"));
  const ts = Date.now();
  const outMp3 = path.join(outDir, `yt9m_${ts}.mp3`);

  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, MUSIC_DOWNLOAD_RETRY + 1); attempt++) {
    let downloaded = null;
    try {
      downloaded = await ytdlpDownloadBestAudio(youtubeUrl, tmpWork);
      await ffmpegTrimToMp3Local(downloaded, outMp3, MAX_MUSIC_SECONDS);

      safeUnlink(downloaded);
      safeRmdir(tmpWork);
      return outMp3;
    } catch (err) {
      lastErr = err;
      console.error(`[MUSIC] fallback attempt ${attempt} failed:`, err?.message || err);
      try { if (downloaded) safeUnlink(downloaded); } catch { }
      await sleep(800 * attempt);
    }
  }

  safeRmdir(tmpWork);
  throw lastErr || new Error("Failed to extract music");
}

/* ===========================================================================
   CONCAT: pre-voice mp3 + song mp3 => final mp3
=========================================================================== */
async function concatTwoMp3(ttsPath, songPath, outDir, prefix = "mix") {
  fs.mkdirSync(outDir, { recursive: true });
  const ts = Date.now();
  const outPath = path.join(outDir, `${prefix}_${ts}.mp3`);

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", ttsPath,
    "-i", songPath,
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[outa]",
    "-map", "[outa]",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "192k",
    outPath,
  ];

  await run(ffmpegPath, args, { timeoutMs: 240000 });

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 50_000) {
    throw new Error("concat output missing/too small");
  }
  return outPath;
}

/* ===========================================================================
   STATIC
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
    if (topic === "robot/gesture/standup") {
      console.log("==> Detect gesture stand up");
      return;
    }
    if (topic === "robot/gesture/sit") {
      console.log("==> Detect gesture sitdown");
      return;
    }
    if (topic === "robot/gesture/moveleft") {
      console.log("==> Detect gesture turn left");
      return;
    }
    if (topic === "robot/moveright") {
      console.log("==> Detect gesture turn right");
      return;
    }
  } catch (err) {
    console.error("MQTT message error", err);
  }
});

/* ===========================================================================
   HELPERS — normalize / routing
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

/* ===========================================================================
   VOICE (Eleven proxy server -> WAV -> MP3) + fallback OpenAI
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

function filePathToPublicUrl(filePath) {
  const filename = path.basename(filePath);
  return `${getPublicHost()}/audio/${filename}`;
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

  const hasWord = /[a-zA-Z0-9À-ỹ]/.test(t);
  return hasWord;
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
   YouTube Search (Data API v3 preferred)
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

    if (!resp.ok) {
      throw new Error(`YT_API search error ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }

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

    if (!resp.ok) {
      throw new Error(`YT_API videos error ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }

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

  try {
    const r = await yts(q);
    const vids = (r?.videos || []).filter((v) => !!v?.url);

    const ok = vids.filter(
      (v) => typeof v.seconds === "number" && v.seconds <= MAX_ACCEPTABLE_VIDEO_SECONDS
    );
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
   VISION trigger (used only in /avoid_obstacle_vision)
=========================================================================== */
function wantsVision(text = "") {
  const t = stripDiacritics((text || "").toLowerCase());
  const triggers = [
    "nhin", "xem", "xung quanh", "truoc mat", "o day co gi", "co gi", "mo ta",
    "trong anh", "anh nay", "tam anh", "camera", "day la gi", "cai gi", "vat gi", "giai thich hinh"
  ];
  return triggers.some((k) => t.includes(stripDiacritics(k)));
}

/* ===========================================================================
   VISION ENDPOINT (AvoidObstacle vision)
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
   UPLOAD_AUDIO — PI v2 (WAV) + optional image (ignored), TEXT ONLY
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

      // clap short-circuit -> client bark
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

      // stop playback intent
      if (detectStopPlayback(text)) {
        const replyText = "Dạ, em tắt nhạc nha.";
        const ttsPath = await textToSpeechMp3FilePi(replyText, "stop");
        const audio_url = filePathToPublicUrl(ttsPath);
        return res.json({
          status: "ok",
          transcript: text,
          label: "stop_playback",
          reply_text: replyText,
          audio_url,
          play: null,
          used_vision: false,
        });
      }

      // label detect + AUTO SWITCH to MUSIC
      let label = overrideLabelByText("unknown", text);
      if (label !== "nhac" && shouldAutoSwitchToMusic(text)) label = "nhac";

      // ===========================
      // MUSIC
      // ===========================
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);

        console.log("🎵 MUSIC:", {
          stt: text,
          q,
          found: true,
          url: top?.url,
          seconds: top?.seconds ?? null,
          duration_filter: YT_VIDEO_DURATION,
          max_accept_s: MAX_ACCEPTABLE_VIDEO_SECONDS,
        }, `(${ms()}ms)`);

        if (top?.url) {
          const songTitle = (top.title || "").trim() || "bài này";
          const preVoiceText = `Ây da, bài hát "${songTitle}" của huynh đây rồi, nghe vui nha`;

          // 1) pre-voice
          const preVoicePath = await textToSpeechMp3FilePi(preVoiceText, "prevoice");

          // 2) download first 9 minutes only (FAST)
          const song9mPath = await extractFirst9MinMp3FromYoutube(top.url, audioDir);

          // 3) concat
          const finalPath = await concatTwoMp3(preVoicePath, song9mPath, audioDir, "music_final");
          const audio_url = filePathToPublicUrl(finalPath);

          safeUnlink(preVoicePath);
          safeUnlink(song9mPath);

          mqttClient.publish(
            "robot/music",
            JSON.stringify({ label: "nhac", text: preVoiceText, audio_url, user: userKey, title: songTitle }),
            { qos: 1 }
          );

          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: preVoiceText,
            audio_url,
            play: null,
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

      // ===========================
      // MOVEMENT labels -> MQTT
      // ===========================
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

      // ===========================
      // GPT (chat / question) — TEXT ONLY (no vision)
      // ===========================
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
   Debug: test yt-dlp
=========================================================================== */
app.get("/debug_ytdlp", async (req, res) => {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    return res.json({
      ok: true,
      ytdlp: out.trim(),
      ffmpeg_static: !!ffmpegPath,
      visitor_data_set: !!YT_VISITOR_DATA,
      po_token_set: !!YT_PO_TOKEN,
      cookies_path: YT_COOKIES_PATH && fs.existsSync(YT_COOKIES_PATH) ? YT_COOKIES_PATH : null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/test_ytdlp", async (req, res) => {
  try {
    const url = (req.query.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    const mp3Path = await extractFirst9MinMp3FromYoutube(url, audioDir);
    const audio_url = filePathToPublicUrl(mp3Path);

    res.json({ ok: true, filename: path.basename(mp3Path), audio_url, max_seconds: MAX_MUSIC_SECONDS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===========================================================================
   CAMERA ROTATE ENDPOINT
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
  res.send("Matthew Robot server is running 🚀 (yt-dlp retry-sleep fixed + multi client + optional visitor_data/po_token/cookies)");
});

/* ===========================================================================
   START SERVER
=========================================================================== */
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  console.log(`🎵 MAX_MUSIC_SECONDS: ${MAX_MUSIC_SECONDS}`);
  console.log(`🎵 YT_VIDEO_DURATION: ${YT_VIDEO_DURATION}`);
  console.log(`🎵 MAX_ACCEPTABLE_VIDEO_SECONDS: ${MAX_ACCEPTABLE_VIDEO_SECONDS}`);
  console.log(`🎵 yt-dlp timeout: ${MUSIC_YTDLP_TIMEOUT_MS} ms`);
  console.log(`🎵 ffmpeg timeout: ${MUSIC_FFMPEG_TIMEOUT_MS} ms`);
  console.log(`🎵 YouTube Data API enabled: ${!!YOUTUBE_API_KEY}`);
  console.log(`🔐 YT_VISITOR_DATA set: ${!!YT_VISITOR_DATA}`);
  console.log(`🔐 YT_PO_TOKEN set: ${!!YT_PO_TOKEN}`);
  console.log(`🍪 YT_COOKIES_PATH exists: ${!!(YT_COOKIES_PATH && fs.existsSync(YT_COOKIES_PATH))}`);
  await checkYtdlpReady();
});
