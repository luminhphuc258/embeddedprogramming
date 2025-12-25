/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC: YouTube search (yt-search) -> yt-dlp extract mp3 -> return audio_url (NO VIDEO)
   - ✅ NEW: tạo 1 đoạn intro TTS: "Ây da, mình tìm được bài hát ...", rồi ghép vào trước nhạc
            => trả về 1 audio mp3 cuối cho client
   - ✅ NEW (minimal change): nếu YouTube video > 20 phút => lấy transcript (captions)
            -> TTS transcript (chunk) -> ghép thành 1 mp3 trả về
            -> nếu không có transcript => trả về "không tìm thấy transcript"
   - PI endpoint: TEXT ONLY (no vision), image optional (ignored)
   - AvoidObstacle vision endpoint kept
   - Label override + scan endpoints + camera rotate
===========================================================================*/

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
   CORS  
===========================================================================*/
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
===========================================================================*/
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
===========================================================================*/
function run(cmd, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/* ===========================================================================  
   yt-dlp (binary) -> mp3
===========================================================================*/
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

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

/** Extract mp3 from YouTube URL into audioDir, return absolute mp3 filepath */
async function ytdlpExtractMp3FromYoutube(url, outDir) {
  if (!url) throw new Error("Missing url");
  fs.mkdirSync(outDir, { recursive: true });

  const ts = Date.now();
  const outTemplate = path.join(outDir, `yt_${ts}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--force-ipv4",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--ffmpeg-location", ffmpegPath,
    "-o", outTemplate,
    url,
  ];

  await run(YTDLP_BIN, args, { timeoutMs: 240000 });

  const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`yt_${ts}.`));
  const mp3 = files.find((f) => f.endsWith(".mp3"));
  if (!mp3) throw new Error("MP3 not found after yt-dlp run");
  return path.join(outDir, mp3);
}

/* ===========================================================================  
   ✅ NEW: Transcript helpers (captions -> text)
   - Video > 20 phút: ưu tiên đọc transcript (nếu có), không tải video/audio dài
===========================================================================*/
function safeRmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

function stripVttToText(vttContent = "") {
  if (!vttContent) return "";
  const lines = vttContent.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)) continue;

    // remove vtt styling tags
    const cleaned = line
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned) out.push(cleaned);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// split text into chunks for TTS (rough, minimal)
function splitTextForTts(text, { maxChars = 1200, maxChunks = 8 } = {}) {
  const t = (text || "").trim();
  if (!t) return [];
  const chunks = [];
  let cur = "";

  // split by sentence-ish punctuation first
  const parts = t.split(/(?<=[.!?。！？])\s+/g);

  for (const p of parts) {
    const seg = p.trim();
    if (!seg) continue;

    if ((cur + " " + seg).trim().length <= maxChars) {
      cur = (cur ? cur + " " : "") + seg;
    } else {
      if (cur) chunks.push(cur.trim());
      cur = seg;
      if (chunks.length >= maxChunks) break;
    }
  }
  if (chunks.length < maxChunks && cur) chunks.push(cur.trim());
  return chunks.slice(0, maxChunks);
}

async function ytdlpFetchTranscriptTextFromYoutube(url, { preferLangs = ["vi", "en"] } = {}) {
  if (!url) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytcap_"));
  try {
    // yt-dlp writes subtitles near output template
    // we DO NOT download media
    const outTemplate = path.join(tmpDir, "%(id)s.%(ext)s");
    const subLangs = preferLangs.join(",");

    const args = [
      "--skip-download",
      "--no-playlist",
      "--force-ipv4",
      "--write-subs",
      "--write-auto-subs",
      "--sub-format", "vtt",
      "--sub-langs", subLangs,
      "-o", outTemplate,
      url,
    ];

    // quick-ish timeout (caption download should be fast)
    await run(YTDLP_BIN, args, { timeoutMs: 60000 });

    const files = fs.readdirSync(tmpDir);

    // pick best vtt by preferred lang order
    // common names: <id>.<lang>.vtt OR <id>.<lang>-something.vtt
    let picked = null;
    for (const lang of preferLangs) {
      const f = files.find((x) => x.endsWith(".vtt") && x.includes(`.${lang}`));
      if (f) { picked = f; break; }
    }
    if (!picked) {
      // any vtt at all?
      picked = files.find((x) => x.endsWith(".vtt")) || null;
    }
    if (!picked) return null;

    const vttPath = path.join(tmpDir, picked);
    const vtt = fs.readFileSync(vttPath, "utf-8");
    const text = stripVttToText(vtt);

    if (!text || text.length < 20) return null;
    return text;
  } catch (e) {
    console.error("⚠️ fetch transcript failed:", e?.message || e);
    return null;
  } finally {
    safeRmDir(tmpDir);
  }
}

/* ===========================================================================  
   STATIC  
===========================================================================*/
app.use("/audio", express.static(audioDir));

/* ===========================================================================  
   MQTT CLIENT
===========================================================================*/
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

  // (optional) gesture topics if you use them
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
      console.log("==> Detect gesture sidown");
      return;
    }
    if (topic === "robot/gesture/moveleft") {
      console.log("==> Detect gesture turn left ");
      return;
    }
    if (topic === "robot/moveright") {
      console.log("==> Detect gesture turn right ");
      return;
    }
  } catch (err) {
    console.error("MQTT message error", err);
  }
});

/* ===========================================================================  
   HELPERS — normalize / routing
===========================================================================*/
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
===========================================================================*/
const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ||
  "https://eleven-tts-wav-server-matthewrobotvoice.up.railway.app/convertvoice";

// global timeout (for non-PI usage)
const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 45000);

// ✅ PI endpoint timeout nhỏ hơn để tránh 502
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

async function openaiTtsToMp3(replyText, prefix = "tts") {
  const filename = `${prefix}_${Date.now()}.mp3`;
  const outPath = path.join(audioDir, filename);

  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "ballad",
    format: "mp3",
    input: replyText,
  });

  fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));
  return `${getPublicHost()}/audio/${filename}`;
}

async function voiceServerToMp3WithTimeout(replyText, prefix = "eleven", timeoutMs = VOICE_TIMEOUT_MS) {
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

    // voice server trả mp3 luôn
    if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) {
      fs.writeFileSync(mp3Out, buf);
      return `${getPublicHost()}/audio/${path.basename(mp3Out)}`;
    }

    // voice server trả wav -> convert mp3
    fs.writeFileSync(wavTmp, buf);

    await new Promise((resolve, reject) =>
      ffmpeg(wavTmp).toFormat("mp3").on("end", resolve).on("error", reject).save(mp3Out)
    );

    try { fs.unlinkSync(wavTmp); } catch { }
    return `${getPublicHost()}/audio/${path.basename(mp3Out)}`;
  } catch (e) {
    clearTimeout(timer);
    try { if (fs.existsSync(wavTmp)) fs.unlinkSync(wavTmp); } catch { }
    try { if (fs.existsSync(mp3Out)) fs.unlinkSync(mp3Out); } catch { }
    throw e;
  }
}

// ✅ PI endpoint: bắt buộc attempt voice server trước, nhưng timeout nhỏ hơn
async function textToSpeechMp3Pi(replyText, prefix = "pi_v2") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3WithTimeout(safeText, `${prefix}_eleven`, VOICE_TIMEOUT_PI_MS);
  } catch (e) {
    console.error("⚠️ PI voice server timeout/fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================  
   ✅ NEW: CONCAT intro mp3 + song mp3 => final mp3 (public URL)
===========================================================================*/
function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { }
}

function audioUrlToLocalPath(audio_url) {
  const u = new URL(audio_url);
  const filename = path.basename(u.pathname);
  return path.join(audioDir, filename);
}

/** concat 2 mp3 local -> mp3 local, return public URL */
async function concatMp3LocalToPublicUrl(mp3APath, mp3BPath, prefix = "music_final") {
  const ts = Date.now();
  const outPath = path.join(audioDir, `${prefix}_${ts}.mp3`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(mp3APath)
      .input(mp3BPath)
      .complexFilter(["[0:a][1:a]concat=n=2:v=0:a=1[outa]"])
      .outputOptions(["-map [outa]", "-ac 2", "-ar 44100", "-b:a 192k"])
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });

  return `${getPublicHost()}/audio/${path.basename(outPath)}`;
}

/** ✅ NEW: concat MANY mp3 local -> mp3 local, return public URL */
async function concatManyMp3LocalToPublicUrl(paths, prefix = "podcast_final") {
  const list = (paths || []).filter(Boolean);
  if (list.length === 0) throw new Error("No mp3 inputs to concat");
  if (list.length === 1) return `${getPublicHost()}/audio/${path.basename(list[0])}`;

  const ts = Date.now();
  const outPath = path.join(audioDir, `${prefix}_${ts}.mp3`);

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    list.forEach((p) => cmd.input(p));

    // build concat filter: [0:a][1:a]...[n:a]concat=n=N:v=0:a=1[outa]
    const inputs = list.map((_, i) => `[${i}:a]`).join("");
    const filter = `${inputs}concat=n=${list.length}:v=0:a=1[outa]`;

    cmd
      .complexFilter([filter])
      .outputOptions(["-map [outa]", "-ac 2", "-ar 44100", "-b:a 192k"])
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });

  return `${getPublicHost()}/audio/${path.basename(outPath)}`;
}

/* ===========================================================================  
   MUSIC QUERY CLEANING
===========================================================================*/
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
===========================================================================*/
function isQuestionLike(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const q = [
    "la ai", "la gi", "cai gi", "vi sao", "tai sao", "o dau", "khi nao", "bao nhieu",
    "how", "what", "why", "where", "?"
  ];
  return q.some((k) => t.includes(stripDiacritics(k)));
}

function looksLikeSongTitleOnly(userText = "") {
  const t = (userText || "").trim();
  if (!t) return false;

  const nd = stripDiacritics(t.toLowerCase());
  const banned = ["xoay", "qua", "ben", "tien", "lui", "trai", "phai", "dung", "stop"];
  if (banned.some((k) => nd.includes(k))) return false;

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
  return keys.some((k) => t.includes(stripDiacritics(k)));
}

function looksLikeMusicQuery(text = "") {
  const raw = (text || "").trim();
  if (!raw) return false;

  const t = stripDiacritics(raw.toLowerCase());
  const banned = ["xoay", "quay", "re", "tien", "lui", "trai", "phai", "dung", "stop", "di"];
  if (banned.some((k) => t.includes(k))) return false;

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
   YouTube search (yt-search) -> TOP 1
===========================================================================*/
async function searchYouTubeTop1(query) {
  const q = (query || "").trim();
  if (!q) return null;

  try {
    const r = await yts(q);
    const v = (r?.videos || [])[0];
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
   OVERRIDE LABEL (movement + question + music)
===========================================================================*/
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
===========================================================================*/
function isClapText(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["clap", "applause", "hand clap", "clapping", "vo tay", "tieng vo tay"];
  return keys.some((k) => t.includes(stripDiacritics(k)));
}

/* ===========================================================================  
   VISION ENDPOINT (AvoidObstacle vision)
===========================================================================*/
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
===========================================================================*/
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

      // save WAV temp
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
        try { fs.unlinkSync(wavPath); } catch { }
        return res.json({
          status: "error",
          transcript: "",
          label: "unknown",
          reply_text: "",
          audio_url: null,
          play: null,
          used_vision: false,
        });
      } finally {
        try { fs.unlinkSync(wavPath); } catch { }
      }

      // clap short-circuit
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
        const audio_url = await textToSpeechMp3Pi(replyText, "stop");
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
      // MUSIC (YouTube -> MP3) / Long video (>20m) -> Transcript -> TTS
      // ===========================
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);
        console.log("🎵 MUSIC:", { stt: text, q, found: !!top?.url, url: top?.url, seconds: top?.seconds }, `(${ms()}ms)`);

        if (top?.url) {
          const isLongVideo = typeof top.seconds === "number" && top.seconds > 20 * 60;

          // ✅ NEW: video dài -> transcript TTS (nếu có), không download mp3 dài
          if (isLongVideo) {
            const transcriptText = await ytdlpFetchTranscriptTextFromYoutube(top.url, { preferLangs: ["vi", "en"] });

            if (!transcriptText) {
              const replyText = `Em không tìm thấy transcript (caption) cho video "${top.title}". Anh thử video khác giúp em nha.`;
              const audio_url = await textToSpeechMp3Pi(replyText, "yt_no_transcript");
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

            const introText = `Ây da, video này dài hơn 20 phút nên em sẽ đọc transcript cho anh nghe. Tựa đề là "${top.title}".`;
            const intro_url = await textToSpeechMp3Pi(introText, "podcast_intro");
            const introLocal = audioUrlToLocalPath(intro_url);

            // chunk transcript -> TTS từng đoạn (giới hạn để tránh treo server)
            const chunks = splitTextForTts(transcriptText, { maxChars: 1200, maxChunks: 8 });
            if (chunks.length === 0) {
              const replyText = `Em có lấy được transcript nhưng nội dung rỗng/không hợp lệ. Anh thử video khác giúp em nha.`;
              const audio_url = await textToSpeechMp3Pi(replyText, "yt_transcript_empty");
              safeUnlink(introLocal);
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

            const tmpMp3Paths = [introLocal];
            try {
              for (let i = 0; i < chunks.length; i++) {
                // dùng OpenAI TTS cho ổn định (không phụ thuộc voice server timeout)
                const u = await openaiTtsToMp3(chunks[i], `podcast_part${String(i + 1).padStart(2, "0")}`);
                const p = audioUrlToLocalPath(u);
                tmpMp3Paths.push(p);
              }

              const final_audio_url = await concatManyMp3LocalToPublicUrl(tmpMp3Paths, "podcast_final");

              // cleanup trung gian
              tmpMp3Paths.forEach(safeUnlink);

              mqttClient.publish(
                "robot/music",
                JSON.stringify({ label: "nhac", text: introText, audio_url: final_audio_url, user: userKey }),
                { qos: 1 }
              );

              return res.json({
                status: "ok",
                transcript: text,
                label: "nhac",
                reply_text: introText,
                audio_url: final_audio_url,
                play: null,
                used_vision: false,
              });
            } catch (e) {
              console.error("podcast transcript TTS/concat error:", e?.message || e);
              tmpMp3Paths.forEach(safeUnlink);

              const replyText = "Em bị lỗi khi tạo audio từ transcript. Anh thử lại giúp em nha.";
              const audio_url = await textToSpeechMp3Pi(replyText, "podcast_fail");
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
          }

          // ✅ Normal: bài ngắn (<=20m) -> tải mp3 + ghép intro như cũ
          const introText = `Ây da, mình tìm được bài hát "${top.title}" rồi, mình sẽ cho bạn nghe đây, nghe vui nha.`;

          // 1) TTS intro -> URL mp3 trong /audio
          const intro_url = await textToSpeechMp3Pi(introText, "music_intro");

          // 2) yt-dlp tải mp3 nhạc (local path)
          const songMp3Path = await ytdlpExtractMp3FromYoutube(top.url, audioDir);

          // 3) Ghép intro + nhạc => mp3 cuối
          const introLocalPath = audioUrlToLocalPath(intro_url);
          const final_audio_url = await concatMp3LocalToPublicUrl(introLocalPath, songMp3Path, "music_final");

          // dọn file trung gian (để tránh đầy disk)
          safeUnlink(introLocalPath);
          safeUnlink(songMp3Path);

          mqttClient.publish(
            "robot/music",
            JSON.stringify({ label: "nhac", text: introText, audio_url: final_audio_url, user: userKey }),
            { qos: 1 }
          );

          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: introText,
            audio_url: final_audio_url, // ✅ mp3 cuối, client đọc được
            play: null,
            used_vision: false,
          });
        }

        const replyText = "Em không tìm thấy bài trên YouTube. Anh nói lại tên bài + ca sĩ giúp em nha.";
        const audio_url = await textToSpeechMp3Pi(replyText, "yt_fail");
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

      const audio_url = await textToSpeechMp3Pi(replyText, "pi_v2");

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
===========================================================================*/
app.get("/debug_ytdlp", async (req, res) => {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    return res.json({ ok: true, ytdlp: out.trim(), ffmpeg_static: !!ffmpegPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/test_ytdlp", async (req, res) => {
  try {
    const url = (req.query.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    const mp3Path = await ytdlpExtractMp3FromYoutube(url, audioDir);
    const filename = path.basename(mp3Path);
    const audio_url = `${getPublicHost()}/audio/${filename}`;

    res.json({ ok: true, filename, audio_url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===========================================================================  
   CAMERA ROTATE ENDPOINT  
===========================================================================*/
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
===========================================================================*/
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
===========================================================================*/
app.get("/get_scanningstatus", (req, res) => {
  res.json({ status: scanStatus });
});

/* ===========================================================================  
   ROOT
===========================================================================*/
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀 (YouTube -> MP3 + Intro + Merge + Long Video Transcript)");
});

/* ===========================================================================  
   START SERVER
===========================================================================*/
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  await checkYtdlpReady();
});
