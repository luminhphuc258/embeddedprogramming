/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC: YouTube search (yt-search) -> yt-dlp extract mp3 -> return audio_url (NO VIDEO)
   - ✅ NEW: tạo 1 đoạn intro TTS: "Ây da, mình tìm được bài hát .", rồi ghép vào trước nhạc
            => trả về 1 audio mp3 cuối cho client
   - ✅ NEW (FIX LONG YT > 20 phút):
        + In log ra thời lượng video sau khi search
        + Chỉ video dài mới gửi qua server YT riêng (REMOTE_YT_SERVER) để xử lý lấy audio_url
        + Video ngắn vẫn tải mp3 local như cũ
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
const requestLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = requestLimitMap.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > 60_000) {
    rec.count = 0;
    rec.ts = now;
  }
  rec.count += 1;
  requestLimitMap.set(ip, rec);
  if (rec.count > 120) return false;
  return true;
}

/* ===========================================================================  
   MQTT SETUP
===========================================================================*/
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.emqx.io";
const mqttClient = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  reconnectPeriod: 2000,
});

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected:", MQTT_URL);
});
mqttClient.on("error", (e) => {
  console.error("❌ MQTT error:", e?.message || e);
});

/* ===========================================================================  
   HELPER: timer ms
===========================================================================*/
const t0 = Date.now();
function ms() {
  return Date.now() - t0;
}

/* ===========================================================================  
   VOICE SERVER (Eleven) -> WAV, convert to MP3
===========================================================================*/
const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL || "https://videoserver-videoserver.up.railway.app";

function getPublicHost(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  return `${proto}://${host}`;
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch { }
}

/* ===========================================================================  
   SPAWN helper
===========================================================================*/
function run(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch { }
      reject(new Error(`Timeout ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      reject(new Error(`Exit ${code}\nSTDERR:\n${err}\nSTDOUT:\n${out}`));
    });
  });
}

/* ===========================================================================  
   Convert WAV -> MP3 (ffmpeg)
===========================================================================*/
async function wavToMp3(wavPath, mp3Path) {
  return new Promise((resolve, reject) => {
    ffmpeg(wavPath)
      .outputOptions(["-y", "-codec:a libmp3lame", "-qscale:a 2"])
      .save(mp3Path)
      .on("end", resolve)
      .on("error", reject);
  });
}

/* ===========================================================================  
   Text-to-Speech via VOICE_SERVER (WAV -> MP3)
===========================================================================*/
async function textToSpeechMp3Pi(text, prefix = "tts") {
  const url = `${VOICE_SERVER_URL}/tts`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!resp.ok) {
    throw new Error(`Voice server HTTP ${resp.status}`);
  }

  const wavBuf = Buffer.from(await resp.arrayBuffer());
  const ts = Date.now();
  const wavPath = path.join(audioDir, `${prefix}_${ts}.wav`);
  const mp3Path = path.join(audioDir, `${prefix}_${ts}.mp3`);

  fs.writeFileSync(wavPath, wavBuf);
  await wavToMp3(wavPath, mp3Path);
  safeUnlink(wavPath);

  const filename = path.basename(mp3Path);
  return `${getPublicHost({ headers: {} })}/audio/${filename}`;
}

/* ===========================================================================  
   OpenAI STT (Whisper) - used in /upload_audio only (not PI endpoint)
===========================================================================*/
async function whisperTranscribeBase64(base64Audio) {
  const tmpDir = fs.mkdtempSync(path.join("/tmp", "whisper_"));
  const wavPath = path.join(tmpDir, "input.wav");

  fs.writeFileSync(wavPath, Buffer.from(base64Audio, "base64"));

  const file = fs.createReadStream(wavPath);
  const transcript = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  safeUnlink(wavPath);
  try {
    fs.rmdirSync(tmpDir);
  } catch { }

  return transcript?.text?.trim() || "";
}

/* ===========================================================================  
   AUDIO concat: intro + music => final mp3
===========================================================================*/
async function concatMp3LocalToPublicUrl(introLocalPath, musicLocalPath, prefix = "mix") {
  const ts = Date.now();
  const outPath = path.join(audioDir, `${prefix}_${ts}.mp3`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(introLocalPath)
      .input(musicLocalPath)
      .complexFilter(["[0:a][1:a]concat=n=2:v=0:a=1[outa]"])
      .outputOptions(["-map [outa]", "-y"])
      .save(outPath)
      .on("end", resolve)
      .on("error", reject);
  });

  const filename = path.basename(outPath);
  return `${getPublicHost({ headers: {} })}/audio/${filename}`;
}

function audioUrlToLocalPath(audioUrl) {
  const m = audioUrl.match(/\/audio\/([^/?#]+\.mp3)$/);
  if (!m) throw new Error("audioUrlToLocalPath: invalid audio_url");
  return path.join(audioDir, m[1]);
}

/* ===========================================================================  
   Youtube search (yt-search)
===========================================================================*/
function extractSongQuery(text) {
  const t = (text || "").toLowerCase();
  // basic remove Vietnamese trigger words
  return t
    .replace(/(mở|bật|cho|nghe|nhạc|bài|hát|song|music)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchYouTubeTop1(query) {
  try {
    const r = await yts(query);
    const v = r?.videos?.[0];
    if (!v) return null;
    return {
      title: v.title,
      url: v.url,
      seconds: v.seconds,
    };
  } catch (e) {
    console.error("YouTube search error:", e?.message || e);
    return null;
  }
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hh > 0) return `${hh}:${pad(mm)}:${pad(ss)}`;
  return `${mm}:${pad(ss)}`;
}

async function tryFetchJson(url, opts) {
  const controller = new AbortController();
  const timeoutMs = Number(opts?.timeoutMs || 180000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }

    if (!resp.ok) {
      const msg = json?.error || text || `HTTP ${resp.status}`;
      throw new Error(`Remote ${resp.status}: ${String(msg).slice(0, 400)}`);
    }
    return json || { raw: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi server YT riêng để xử lý video dài và trả về audio_url.
 * - Try vài endpoint phổ biến để bạn khỏi phải sửa nhiều nếu server kia đổi route.
 */
async function fetchRemoteYtAudio({ url, title = "", seconds = null, query = "", stt = "", user = "" }) {
  if (!url) throw new Error("Missing url");

  const endpoints = [
    { method: "POST", path: "/yt_audio" },
    { method: "POST", path: "/download_audio" },
    { method: "POST", path: "/extract_audio" },
    { method: "POST", path: "/ytdlp_audio" },
    { method: "GET", path: "/yt_audio" },
    { method: "GET", path: "/download_audio" },
  ];

  const payload = { url, title, seconds, query, stt, user };

  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const full = `${REMOTE_YT_SERVER}${ep.path}`;
      const isGet = ep.method === "GET";
      const fullUrl = isGet ? `${full}?url=${encodeURIComponent(url)}` : full;

      const json = await tryFetchJson(fullUrl, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: isGet ? undefined : JSON.stringify(payload),
        timeoutMs: 240000,
      });

      const audio_url = json?.audio_url || json?.url || json?.audio || null;
      if (audio_url) return audio_url;

      lastErr = new Error(`Remote returned no audio_url on ${ep.method} ${ep.path}`);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Remote ytserver failed");
}

async function headContentLength(fileUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(fileUrl, { method: "HEAD", signal: controller.signal });
    if (!resp.ok) return null;
    const v = resp.headers.get("content-length");
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(fileUrl, outPath, { timeoutMs = 240000, maxBytes = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let ws = null;
  try {
    const resp = await fetch(fileUrl, { method: "GET", signal: controller.signal });
    if (!resp.ok) throw new Error(`Download failed ${resp.status}`);

    ws = fs.createWriteStream(outPath);
    let downloaded = 0;

    for await (const chunk of resp.body) {
      downloaded += chunk.length;
      if (maxBytes && downloaded > maxBytes) {
        throw new Error(`Remote audio too large > ${Math.round(maxBytes / (1024 * 1024))}MB`);
      }
      ws.write(chunk);
    }

    await new Promise((resolve, reject) => {
      ws.end(resolve);
      ws.on("error", reject);
    });

    return { bytes: downloaded };
  } finally {
    clearTimeout(timer);
    try { if (ws) ws.close?.(); } catch { }
  }
}

/**
 * Cố gắng merge intro + remote audio (chỉ khi file remote không quá lớn).
 * Nếu quá lớn / lỗi => trả về remoteAudioUrl luôn để không bị timeout.
 */
async function maybeConcatIntroWithRemote(introLocalPath, remoteAudioUrl) {
  const maxBytes = Math.max(1, REMOTE_MERGE_MAX_MB) * 1024 * 1024;

  const size = await headContentLength(remoteAudioUrl);
  if (size && size > maxBytes) {
    return { final_audio_url: remoteAudioUrl, merged: false, reason: "remote_too_large_head" };
  }

  const dlPath = path.join(audioDir, `remote_${Date.now()}.mp3`);
  try {
    await downloadToFile(remoteAudioUrl, dlPath, { timeoutMs: 240000, maxBytes });
    const final_audio_url = await concatMp3LocalToPublicUrl(introLocalPath, dlPath, "music_final_remote");
    safeUnlink(dlPath);
    return { final_audio_url, merged: true };
  } catch (e) {
    safeUnlink(dlPath);
    return { final_audio_url: remoteAudioUrl, merged: false, reason: e?.message || "merge_failed" };
  }
}

/* ===========================================================================  
   OVERRIDE LABEL
===========================================================================*/
let overrideLabel = null;
app.post("/override_label", (req, res) => {
  overrideLabel = req.body?.label || null;
  console.log("✅ override_label set:", overrideLabel);
  res.json({ status: "ok", overrideLabel });
});

/* ===========================================================================  
   SCAN STATUS
===========================================================================*/
const scanStatus = {
  isScanning: false,
  currentAngle: 0,
  lastUpdate: Date.now(),
};

mqttClient.on("message", (topic, msg) => {
  try {
    if (topic === "robot/scanningstatus") {
      const data = JSON.parse(msg.toString());
      scanStatus.isScanning = !!data.isScanning;
      scanStatus.currentAngle = data.currentAngle || 0;
      scanStatus.lastUpdate = Date.now();
    }
  } catch { }
});

mqttClient.subscribe("robot/scanningstatus", { qos: 1 });

/* ===========================================================================  
   Serve static
===========================================================================*/
app.use("/audio", express.static(audioDir));
app.use("/public", express.static(publicDir));

/* ===========================================================================  
   UPLOAD AUDIO (old endpoint)
===========================================================================*/
app.post("/upload_audio", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "rate limited" });
    }

    const base64Audio = req.body?.audio;
    if (!base64Audio) return res.status(400).json({ error: "Missing audio" });

    const text = await whisperTranscribeBase64(base64Audio);
    if (!text) return res.status(400).json({ error: "No transcript" });

    // Use OpenAI chat
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You are Matthew's dog robot. Reply briefly, friendly, easy to understand.",
        },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 240,
    });

    const replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu.";
    const audio_url = await textToSpeechMp3Pi(replyText, "upload");

    mqttClient.publish("robot/music", JSON.stringify({ audio_url, text: replyText }), { qos: 1 });

    res.json({ transcript: text, reply_text: replyText, audio_url });
  } catch (e) {
    console.error("/upload_audio error:", e?.message || e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

/* ===========================================================================  
   yt-dlp (binary) -> mp3 / captions
===========================================================================*/
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

// ✅ IMPORTANT (FIX 403 / PO Token):
// Một số "player_client" (đặc biệt android https formats) có thể yêu cầu PO Token -> dễ dính 403 trên Railway.
// Vì vậy ta ưu tiên web/ios và có cơ chế retry theo danh sách client.
const YT_PLAYER_CLIENTS = (process.env.YT_PLAYER_CLIENTS || "web,ios,android")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function ytExtractorArgsForClient(client) {
  return ["--extractor-args", `youtube:player_client=${client}`];
}

// ✅ Chỉ video dài mới gửi qua server YT riêng để xử lý lấy audio
const REMOTE_YT_SERVER =
  process.env.REMOTE_YT_SERVER || "https://endearing-upliftment-ytserver.up.railway.app";

// threshold video dài (seconds). default: 20 phút
const LONG_VIDEO_SECONDS = Number(process.env.LONG_VIDEO_SECONDS || 20 * 60);

// Nếu file remote quá to thì KHÔNG merge intro (tránh timeout/disk).
const REMOTE_MERGE_MAX_MB = Number(process.env.REMOTE_MERGE_MAX_MB || 80);

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

  const baseArgs = [
    "--no-playlist",
    "--force-ipv4",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--ffmpeg-location", ffmpegPath,
    "-o", outTemplate,
    url,
  ];

  let lastErr = null;

  // Retry theo danh sách client để giảm 403/Forbidden
  for (const client of YT_PLAYER_CLIENTS) {
    const args = [
      "--no-playlist",
      "--force-ipv4",
      ...ytExtractorArgsForClient(client),
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--ffmpeg-location", ffmpegPath,
      "-o", outTemplate,
      url,
    ];

    try {
      console.log("▶️ yt-dlp download (client):", client, url);
      await run(YTDLP_BIN, args, { timeoutMs: 240000 });

      const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`yt_${ts}.`));
      const mp3 = files.find((f) => f.endsWith(".mp3"));
      if (!mp3) throw new Error("MP3 not found after yt-dlp run");
      console.log("✅ yt-dlp ok (client):", client, "->", mp3);
      return path.join(outDir, mp3);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      console.error("⚠️ yt-dlp fail (client):", client, msg.slice(0, 600));
      // dọn file rác nếu có
      try {
        const junk = fs.readdirSync(outDir).filter((f) => f.startsWith(`yt_${ts}.`));
        for (const f of junk) safeUnlink(path.join(outDir, f));
      } catch { }
      // thử client tiếp theo
    }
  }

  throw lastErr || new Error("yt-dlp failed (all clients)");
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
    ...ytExtractorArgsForClient("web"),
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
  const capPath = await ytdlpFetchCaptionVtt(url, audioDir);
  if (!capPath) return null;
  try {
    const vtt = fs.readFileSync(capPath, "utf-8");
    safeUnlink(capPath);
    const plain = vttToPlainText(vtt);
    return plain || null;
  } catch {
    safeUnlink(capPath);
    return null;
  }
}

/* ===========================================================================  
   ✅ NEW: Long transcript -> chunks ("podcast")
===========================================================================*/
function chunkText(text, maxChars = 900) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  let cur = "";

  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + sentence).trim().length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = sentence;
    } else {
      cur += " " + sentence;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

const podcastSessions = new Map(); // id -> { chunks, idx, createdAt }
function newPodcastSession(chunks) {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  podcastSessions.set(id, { chunks, idx: 0, createdAt: Date.now() });
  return id;
}

function getPodcastChunk(id) {
  const s = podcastSessions.get(id);
  if (!s) return null;
  if (s.idx >= s.chunks.length) return { done: true, chunk: null };
  const c = s.chunks[s.idx];
  s.idx += 1;
  return { done: false, chunk: c, idx: s.idx, total: s.chunks.length };
}

/* ===========================================================================  
   PI endpoint (TEXT ONLY): /pi_upload_audio_v2
===========================================================================*/
const memoryMap = new Map(); // userKey -> [{ transcript, reply_text }]
function pushMemory(userKey, transcript, replyText) {
  if (!userKey) return;
  const arr = memoryMap.get(userKey) || [];
  arr.push({ transcript, reply_text: replyText });
  while (arr.length > 6) arr.shift();
  memoryMap.set(userKey, arr);
}

function shouldAutoSwitchToMusic(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("mở nhạc") || t.includes("bật nhạc") || t.includes("cho nghe")) return true;
  if (t.includes("bài hát") || t.includes("song") || t.includes("music")) return true;
  return false;
}

app.post(
  "/pi_upload_audio_v2",
  upload.single("audio"),
  async (req, res) => {
    try {
      const userKey = (req.query.user || "default").toString();
      const text = (req.body?.text || "").toString().trim();
      if (!text) return res.status(400).json({ error: "Missing text" });

      // Label selection
      let label = overrideLabel || req.body?.label || "chat";

      // Auto: if user asks for music -> label=nhac
      if (label !== "nhac" && shouldAutoSwitchToMusic(text)) label = "nhac";

      // ===========================
      // MUSIC (YouTube)
      // ===========================
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);

        const durationStr = formatDuration(top?.seconds);
        const isLong = typeof top?.seconds === "number" && top.seconds >= LONG_VIDEO_SECONDS;
        const route = isLong ? "REMOTE_YTSERVER" : "LOCAL_YTDLP";

        console.log(
          "🎵 YT_SEARCH_RESULT:",
          {
            stt: text,
            q,
            found: !!top?.url,
            title: top?.title,
            url: top?.url,
            seconds: top?.seconds,
            duration: durationStr,
            route,
          },
          `(${ms()}ms)`
        );

        if (top?.url) {
          // ✅ LONG VIDEO => gửi qua server YT riêng để lấy audio_url
          if (isLong) {
            console.log("📤 SEND_TO_REMOTE_YTSERVER:", {
              remote: REMOTE_YT_SERVER,
              url: top.url,
              title: top.title,
              seconds: top.seconds,
              duration: durationStr,
            });

            let remoteAudioUrl = null;
            try {
              remoteAudioUrl = await fetchRemoteYtAudio({
                url: top.url,
                title: top.title,
                seconds: top.seconds,
                query: q,
                stt: text,
                user: userKey,
              });
            } catch (e) {
              console.error("❌ Remote ytserver error:", e?.message || e);
            }

            if (!remoteAudioUrl) {
              const replyText = `Em bị lỗi khi lấy audio cho video dài "${top.title}". Anh thử bài khác giúp em nha.`;
              const audio_url = await textToSpeechMp3Pi(replyText, "yt_remote_fail");
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

            // (Optional) tạo intro + cố merge nếu remote file không quá to
            const introText = `Video này hơi dài nên em nhờ server phụ xử lý. Đây là "${top.title}".`;
            let final_audio_url = remoteAudioUrl;
            let merged = false;
            let merge_reason = "";

            try {
              const intro_url = await textToSpeechMp3Pi(introText, "music_intro_long");
              const introLocalPath = audioUrlToLocalPath(intro_url);

              const r = await maybeConcatIntroWithRemote(introLocalPath, remoteAudioUrl);
              final_audio_url = r.final_audio_url;
              merged = !!r.merged;
              merge_reason = r.reason || "";

              safeUnlink(introLocalPath);
            } catch (e) {
              console.error("⚠️ Merge intro+remote failed -> return remote only:", e?.message || e);
              final_audio_url = remoteAudioUrl;
              merged = false;
              merge_reason = e?.message || "merge_exception";
            }

            console.log("✅ REMOTE_AUDIO_READY:", {
              remoteAudioUrl,
              final_audio_url,
              merged,
              merge_reason,
            });

            mqttClient.publish(
              "robot/music",
              JSON.stringify({
                label: "nhac",
                text: introText,
                audio_url: final_audio_url,
                user: userKey,
                yt: {
                  title: top.title,
                  url: top.url,
                  seconds: top.seconds,
                  duration: durationStr,
                  route: "remote",
                  remote_server: REMOTE_YT_SERVER,
                  merged,
                  merge_reason,
                },
              }),
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

          // ✅ SHORT VIDEO => tải mp3 như cũ (local yt-dlp)
          console.log("📦 LOCAL_YTDLP_DOWNLOAD:", {
            url: top.url,
            title: top.title,
            seconds: top.seconds,
            duration: durationStr,
          });

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

          console.log("✅ LOCAL_AUDIO_READY:", {
            final_audio_url,
            title: top.title,
            duration: durationStr,
          });

          mqttClient.publish(
            "robot/music",
            JSON.stringify({
              label: "nhac",
              text: introText,
              audio_url: final_audio_url,
              user: userKey,
              yt: {
                title: top.title,
                url: top.url,
                seconds: top.seconds,
                duration: durationStr,
                route: "local",
              },
            }),
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
      // MOVEMENT labels (keep)
      // ===========================
      // ... (giữ nguyên phần dưới của bạn, không đổi)
      // ===========================

      // Default CHAT
      const memory = memoryMap.get(userKey) || [];
      const memoryText =
        memory.length > 0
          ? memory
            .map((m, i) => {
              const u = (m.transcript || "").trim();
              const a = (m.reply_text || "").trim();
              return `#${i + 1} USER: ${u}\n#${i + 1} BOT: ${a}`;
            })
            .join("\n\n")
          : "";

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

      pushMemory(userKey, text, replyText);

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
    const audio_url = `${getPublicHost(req)}/audio/${filename}`;

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
  res.send("Matthew Robot server is running 🚀 (YouTube -> MP3 + Intro + Merge + LONG->REMOTE)");
});

/* ===========================================================================  
   START SERVER
===========================================================================*/
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  await checkYtdlpReady();
});
