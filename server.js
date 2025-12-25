/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC: YouTube search (yt-search) -> yt-dlp extract mp3 -> return audio_url (NO VIDEO)
   - ✅ NEW: tạo 1 đoạn intro TTS: "Ây da, mình tìm được bài hát ...", rồi ghép vào trước nhạc
            => trả về 1 audio mp3 cuối cho client
   - ✅ NEW (FIX LONG YT > 20 phút):
        + KHÔNG tải audio dài nữa để tránh timeout
        + Dùng yt-dlp lấy transcript/caption (vtt)
        + Nếu có transcript: server đọc transcript theo từng đoạn (podcast chunks)
          - trả ngay chunk #0 (kèm intro)
          - client gọi /podcast_next?id=... để lấy chunk tiếp theo
        + Nếu không có transcript: trả về "không tìm thấy transcript"
   - PI endpoint: TEXT ONLY (no vision), image optional (ignored)
   - AvoidObstacle vision endpoint kept
   - Label override + scan endpoints + camera rotate
===========================================================================*/

import express from "express";
import fs from "fs";
import path from "path";
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
   yt-dlp (binary) -> mp3 / captions
===========================================================================*/
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

// ✅ tránh “tv client / deno” bằng cách ép youtube player_client=android
// (đây là chỗ FIX chính theo yêu cầu của bạn)
const YT_EXTRACTOR_ARGS = ["--extractor-args", "youtube:player_client=android"];

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
    ...YT_EXTRACTOR_ARGS,
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
   ✅ NEW: YT transcript/captions (vtt) for long videos
===========================================================================*/
function vttToPlainText(vttRaw = "") {
  const lines = vttRaw.split(/\r?\n/);
  const keep = [];

  for (const line of lines) {
    const l = (line || "").trim();
    if (!l) continue;
    if (l === "WEBVTT") continue;
    if (/^\d+$/.test(l)) continue;                // cue number
    if (l.includes("-->")) continue;              // timestamps
    if (/^(NOTE|Kind:|Language:)/i.test(l)) continue;
    keep.push(l);
  }

  // join + cleanup
  return keep
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function ytdlpFetchCaptionVtt(url, outDir) {
  if (!url) return null;
  fs.mkdirSync(outDir, { recursive: true });

  const ts = Date.now();
  const outTemplate = path.join(outDir, `cap_${ts}.%(ext)s`);

  // NOTE:
  // - write-subs + write-auto-subs: lấy cả caption người upload + auto-caption
  // - sub-langs: thử vi trước, rồi en (thêm biến thể hay gặp)
  const args = [
    "--skip-download",
    "--no-playlist",
    "--force-ipv4",
    ...YT_EXTRACTOR_ARGS,
    "--write-subs",
    "--write-auto-subs",
    "--sub-format", "vtt",
    "--sub-langs", "vi,vi-VN,en,en-US",
    "-o", outTemplate,
    url,
  ];

  // captions thường nhanh hơn tải audio, nên timeout 120s là hợp lý
  try {
    await run(YTDLP_BIN, args, { timeoutMs: 120000 });
  } catch (e) {
    // fail captions => return null (đừng làm sập server)
    console.error("⚠️ ytdlp captions error:", e?.message || e);
    return null;
  }

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(`cap_${ts}.`) && f.endsWith(".vtt"));

  if (!files.length) return null;

  // ưu tiên vi trước
  const pick =
    files.find((f) => f.includes(".vi.") || f.includes(".vi-VN.")) ||
    files.find((f) => f.includes(".en.") || f.includes(".en-US.")) ||
    files[0];

  return path.join(outDir, pick);
}

async function getYoutubeTranscriptText(url) {
  const vttPath = await ytdlpFetchCaptionVtt(url, audioDir);
  if (!vttPath) return "";

  try {
    const raw = fs.readFileSync(vttPath, "utf-8");
    const text = vttToPlainText(raw);
    return (text || "").trim();
  } catch (e) {
    console.error("⚠️ read vtt error:", e?.message || e);
    return "";
  } finally {
    try { fs.unlinkSync(vttPath); } catch { }
  }
}

function chunkTextSmart(text = "", maxChars = 520) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];

  // split by sentence-ish
  const parts = t.split(/(?<=[\.\!\?\。\！\？])\s+/g);
  const chunks = [];
  let cur = "";

  for (const p of parts) {
    const s = (p || "").trim();
    if (!s) continue;

    if ((cur + " " + s).trim().length <= maxChars) {
      cur = (cur + " " + s).trim();
      continue;
    }

    if (cur) chunks.push(cur);
    cur = "";

    if (s.length <= maxChars) {
      cur = s;
    } else {
      // nếu 1 câu quá dài -> cắt thẳng
      for (let i = 0; i < s.length; i += maxChars) {
        chunks.push(s.slice(i, i + maxChars).trim());
      }
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
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

// ✅ long TTS (podcast chunk) timeout dài hơn
const VOICE_TIMEOUT_LONG_MS = Number(process.env.VOICE_TIMEOUT_LONG_MS || 45000);

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

// ✅ long text (podcast chunks): timeout dài hơn, fallback OpenAI
async function textToSpeechMp3Long(replyText, prefix = "long") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3WithTimeout(safeText, `${prefix}_eleven`, VOICE_TIMEOUT_LONG_MS);
  } catch (e) {
    console.error("⚠️ LONG voice server fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================  
   ✅ CONCAT mp3 helpers
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

/* ===========================================================================  
   ✅ NEW: Podcast session store (transcript -> chunks)
===========================================================================*/
const podcastSessions = new Map();
const PODCAST_TTL_MS = Number(process.env.PODCAST_TTL_MS || 60 * 60 * 1000); // 1h
const PODCAST_MAX_CHUNKS = Number(process.env.PODCAST_MAX_CHUNKS || 240);

function newPodcastId() {
  return `pod_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createPodcastSession({ title = "", url = "", transcriptText = "" }) {
  let chunks = chunkTextSmart(transcriptText, 520);

  // tránh quá dài -> giữ tối đa N chunks đầu
  if (chunks.length > PODCAST_MAX_CHUNKS) {
    chunks = chunks.slice(0, PODCAST_MAX_CHUNKS);
  }

  const id = newPodcastId();
  podcastSessions.set(id, {
    id,
    title,
    url,
    chunks,
    index: 0,
    createdAt: Date.now(),
  });
  return id;
}

function getPodcastSession(id) {
  const s = podcastSessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > PODCAST_TTL_MS) {
    podcastSessions.delete(id);
    return null;
  }
  return s;
}

// cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of podcastSessions.entries()) {
    if (!s?.createdAt || now - s.createdAt > PODCAST_TTL_MS) {
      podcastSessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

/* ===========================================================================  
   ✅ NEW: endpoint lấy chunk tiếp theo
   GET /podcast_next?id=pod_xxx
===========================================================================*/
app.get("/podcast_next", async (req, res) => {
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing ?id=" });

    const s = getPodcastSession(id);
    if (!s) return res.status(404).json({ ok: false, error: "Podcast session not found/expired" });

    const nextIndex = Number(s.index || 0) + 1;
    if (nextIndex >= s.chunks.length) {
      podcastSessions.delete(id);
      return res.json({ ok: true, id, done: true, index: nextIndex, total: s.chunks.length, audio_url: null });
    }

    s.index = nextIndex;

    const chunkText = s.chunks[nextIndex];
    const audio_url = await textToSpeechMp3Long(chunkText, `pod_${id}_${nextIndex}`);

    return res.json({
      ok: true,
      id,
      done: false,
      index: nextIndex,
      total: s.chunks.length,
      audio_url,
      title: s.title,
    });
  } catch (e) {
    console.error("/podcast_next error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

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
      // MUSIC (YouTube)
      // ===========================
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);
        console.log("🎵 MUSIC:", { stt: text, q, found: !!top?.url, url: top?.url, seconds: top?.seconds }, `(${ms()}ms)`);

        if (top?.url) {
          const isLong = typeof top.seconds === "number" && top.seconds >= 20 * 60;

          // ✅ LONG VIDEO => transcript/podcast mode
          if (isLong) {
            const transcriptText = await getYoutubeTranscriptText(top.url);

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

            // create session
            const podcast_id = createPodcastSession({
              title: top.title,
              url: top.url,
              transcriptText,
            });

            const s = getPodcastSession(podcast_id);
            const firstChunk = s?.chunks?.[0] || "";
            const introText = `Ây da, video này dài nên em sẽ đọc transcript cho bạn nghe nha. Tiêu đề: "${top.title}".`;

            // intro + chunk0 => final mp3
            const intro_url = await textToSpeechMp3Long(introText, "pod_intro");
            const chunk0_url = await textToSpeechMp3Long(firstChunk, "pod_chunk0");

            const introLocal = audioUrlToLocalPath(intro_url);
            const chunk0Local = audioUrlToLocalPath(chunk0_url);
            const final_audio_url = await concatMp3LocalToPublicUrl(introLocal, chunk0Local, "podcast_0");

            safeUnlink(introLocal);
            safeUnlink(chunk0Local);

            const next_url = `${getPublicHost()}/podcast_next?id=${podcast_id}`;

            mqttClient.publish(
              "robot/music",
              JSON.stringify({
                label: "nhac",
                text: introText,
                audio_url: final_audio_url,
                user: userKey,
                podcast: { id: podcast_id, index: 0, total: s?.chunks?.length || 0, next_url },
              }),
              { qos: 1 }
            );

            return res.json({
              status: "ok",
              transcript: text,
              label: "nhac",
              reply_text: introText,
              audio_url: final_audio_url,
              play: {
                type: "podcast",
                id: podcast_id,
                index: 0,
                total: s?.chunks?.length || 0,
                next_url,
              },
              used_vision: false,
            });
          }

          // ✅ SHORT VIDEO => tải mp3 như cũ
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
            audio_url: final_audio_url,
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
  res.send("Matthew Robot server is running 🚀 (YouTube -> MP3 + Intro + Merge + LONG transcript podcast)");
});

/* ===========================================================================  
   START SERVER
===========================================================================*/
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  await checkYtdlpReady();
});
