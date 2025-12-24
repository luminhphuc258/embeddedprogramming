/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube/yt-dlp -> MP3 FILE)
   - STT (OpenAI) -> detect music intent
   - MUSIC:
       Search: yt-search
       Download: yt-dlp -> clip first N seconds -> output MP3 into /public/audio
       Return: https://<host>/audio/<file>.mp3   (client đọc OK)
   - Pre-voice: Eleven WAV server -> MP3, fallback OpenAI TTS
   - Concat pre-voice + song mp3 => final mp3
=========================================================================== */

import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import dns from "dns";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import cors from "cors";
import yts from "yt-search";
import { spawn } from "child_process";
import mqtt from "mqtt";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

// ✅ Prefer IPv4 first (giảm lỗi DNS/IPv6 trên Railway)
dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "3mb" }));
const PORT = process.env.PORT || 8080;

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });

/* ===========================================================================
   CONFIG
=========================================================================== */
const MAX_MUSIC_SECONDS = Number(process.env.MAX_MUSIC_SECONDS || 540); // 9 phút
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const MUSIC_YTDLP_TIMEOUT_MS = Number(process.env.MUSIC_YTDLP_TIMEOUT_MS || 220000); // 3m40s
const MUSIC_CONCAT_TIMEOUT_MS = Number(process.env.MUSIC_CONCAT_TIMEOUT_MS || 240000);

// Optional bypass options if YouTube blocks server IP
// - If you have cookies (recommended), set YT_COOKIES_FILE=/app/cookies.txt
// - If you have visitor_data / po_token, set env accordingly
const YT_COOKIES_FILE = process.env.YT_COOKIES_FILE || ""; // path to cookies.txt
const YT_VISITOR_DATA = process.env.YT_VISITOR_DATA || ""; // e.g. "Cg..."
const YT_PO_TOKEN = process.env.YT_PO_TOKEN || "";         // e.g. "M..."
const YT_PLAYER_CLIENT = process.env.YT_PLAYER_CLIENT || "android"; // single client (NO multiple)

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

app.options("/pi_upload_audio_v2", cors());

/* ===========================================================================
   RATE LIMIT
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
   STATIC
=========================================================================== */
app.use("/audio", express.static(audioDir));

function getPublicHost() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const r = process.env.RAILWAY_STATIC_URL;
  if (r) return `https://${r}`;
  return `http://localhost:${PORT}`;
}

function filePathToPublicUrl(filePath) {
  return `${getPublicHost()}/audio/${path.basename(filePath)}`;
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { }
}
function safeRmrf(p) {
  try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { }
}

/* ===========================================================================
   MQTT (giữ lại như server bạn đang dùng)
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
mqttClient.on("connect", () => console.log("✅ MQTT connected"));

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

async function checkYtdlpReady() {
  const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
  console.log("✅ yt-dlp ready:", out.trim());
}

/* ===========================================================================
   TEXT HELPERS
=========================================================================== */
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function cleanMusicQuery(q = "") {
  let t = (q || "").toLowerCase().trim();
  t = t.replace(/\(.*?\)|\[.*?\]/g, " ");
  t = t.replace(/[.,;:!?]/g, " ");
  t = t.replace(/\b(official|mv|lyrics|karaoke|cover|8d|tiktok|sped\s*up|slowed|remix|ver\.?|version)\b/g, " ");
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
    "ca si",
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

function containsMusicIntent(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["nghe", "nghe nhac", "phat", "phat nhac", "mo", "mo nhac", "mo bai", "bat nhac", "bai hat", "music", "play"];
  return keys.some(k => t.includes(stripDiacritics(k)));
}

function looksLikeMusicQuery(text = "") {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (raw.length > 90) return false;
  const t = stripDiacritics(raw.toLowerCase());
  const banned = ["xoay", "quay", "re", "tien", "lui", "trai", "phai", "dung", "stop", "di"];
  if (banned.some(k => t.includes(k))) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return /[a-zA-ZÀ-ỹ]/.test(raw) && words.length >= 2 && words.length <= 12;
}

function shouldAutoSwitchToMusic(text = "") {
  return containsMusicIntent(text) || looksLikeMusicQuery(text);
}

function detectStopPlayback(text = "") {
  const t = stripDiacritics((text || "").toLowerCase()).trim();
  const patterns = [
    /\b(tat|tắt)\s*(nhac|nhạc|music)\b/u,
    /\b(dung|dừng)\s*(nhac|nhạc|music)\b/u,
    /\b(stop)\b/u,
  ];
  return patterns.some((re) => re.test(t));
}

/* ===========================================================================
   YouTube search (yt-search)
=========================================================================== */
async function searchYouTubeTop1(query) {
  const q = (query || "").trim();
  if (!q) return null;

  const r = await yts(q);
  const vids = (r?.videos || []).filter((v) => !!v?.url);
  const v = vids[0];
  if (!v?.url) return null;

  return {
    url: v.url,
    title: v.title || "",
    seconds: typeof v.seconds === "number" ? v.seconds : null,
    author: v.author?.name || "",
  };
}

/* ===========================================================================
   yt-dlp download CLIP -> MP3 FILE (NO stream link)
=========================================================================== */
function hhmmssFromSeconds(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function findDownloadedFile(baseNoExt) {
  // We expect mp3, but keep a fallback search
  const exts = ["mp3", "m4a", "webm", "opus", "aac", "mp4", "mkv", "wav", "flac"];
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

function buildYtExtractorArgs() {
  // single client only
  const parts = [`player_client=${YT_PLAYER_CLIENT}`];
  if (YT_VISITOR_DATA) parts.push(`visitor_data=${YT_VISITOR_DATA}`);
  if (YT_PO_TOKEN) parts.push(`po_token=${YT_PO_TOKEN}`);
  return `youtube:${parts.join(";")}`;
}

async function ytdlpDownloadClipMp3(youtubeUrl, outDir, maxSeconds = MAX_MUSIC_SECONDS) {
  if (!youtubeUrl) throw new Error("Missing youtubeUrl");
  fs.mkdirSync(outDir, { recursive: true });

  const sec = Math.max(5, Math.floor(Number(maxSeconds) || MAX_MUSIC_SECONDS));
  const start = "00:00:00";
  const end = hhmmssFromSeconds(sec);
  const section = `*${start}-${end}`;

  const base = path.join(outDir, `yt_${Date.now()}`);
  const template = `${base}.%(ext)s`;

  const args = [
    "--no-playlist",
    "--force-ipv4",
    "--no-progress",
    "--newline",
    "--retries", "20",
    "--fragment-retries", "20",
    "--extractor-retries", "10",
    "--socket-timeout", "15",
    "--concurrent-fragments", "1",

    // ✅ reduce SABR/web issues by forcing a single stable client
    "--extractor-args", buildYtExtractorArgs(),
  ];

  // Optional cookies (best if YouTube blocks your IP)
  if (YT_COOKIES_FILE && fs.existsSync(YT_COOKIES_FILE)) {
    args.push("--cookies", YT_COOKIES_FILE);
  }

  // ✅ clip only first N seconds (avoid long video timeout)
  args.push("--download-sections", section);

  // ✅ output MP3 directly via ffmpeg
  args.push("--ffmpeg-location", ffmpegPath);
  args.push("-f", "bestaudio/best");
  args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  args.push("-o", template);
  args.push(youtubeUrl);

  await run(YTDLP_BIN, args, { timeoutMs: MUSIC_YTDLP_TIMEOUT_MS });

  const downloaded = findDownloadedFile(base);
  if (!downloaded) throw new Error("yt-dlp finished but output file not found");

  // Ensure mp3
  if (!downloaded.endsWith(".mp3")) {
    // convert to mp3 if needed
    const mp3Out = `${base}.mp3`;
    await new Promise((resolve, reject) =>
      ffmpeg(downloaded)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(mp3Out)
    );
    safeUnlink(downloaded);
    if (!fs.existsSync(mp3Out) || fs.statSync(mp3Out).size < 30_000) {
      safeUnlink(mp3Out);
      throw new Error("Convert to mp3 failed / too small");
    }
    return mp3Out;
  }

  if (fs.statSync(downloaded).size < 30_000) {
    safeUnlink(downloaded);
    throw new Error("Downloaded mp3 too small / invalid");
  }

  return downloaded;
}

/* ===========================================================================
   VOICE (Eleven -> MP3) + fallback OpenAI
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
    console.error("⚠️ PI voice server fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3File(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================
   CONCAT: pre-voice mp3 + song mp3 => final mp3
=========================================================================== */
async function concatTwoMp3(ttsPath, songPath, outDir, prefix = "mix") {
  fs.mkdirSync(outDir, { recursive: true });
  const ts = Date.now();
  const outPath = path.join(outDir, `${prefix}_${ts}.mp3`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(ttsPath)
      .input(songPath)
      .complexFilter(["[0:a][1:a]concat=n=2:v=0:a=1[outa]"])
      .outputOptions(["-map [outa]", "-ac 2", "-ar 44100", "-b:a 192k"])
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 50_000) {
    safeUnlink(outPath);
    throw new Error("concat output missing/too small");
  }
  return outPath;
}

/* ===========================================================================
   /pi_upload_audio_v2 (STT -> MUSIC or CHAT)
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
      const userKey = (req.headers["x-forwarded-for"] || req.ip || "unknown").toString().split(",")[0].trim();

      if (!audioFile?.buffer) return res.status(400).json({ error: "No audio uploaded" });

      // meta memory (optional)
      let meta = {};
      try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }
      const memoryArr = Array.isArray(meta.memory) ? meta.memory : [];

      // save wav temporary
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
      } finally {
        safeUnlink(wavPath);
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

      // MUSIC
      if (shouldAutoSwitchToMusic(text)) {
        const q = extractSongQuery(text) || text;
        const top = await searchYouTubeTop1(q);

        console.log("🎵 MUSIC:", {
          stt: text,
          q,
          found: !!top?.url,
          url: top?.url,
          seconds: top?.seconds ?? null,
        }, `(${ms()}ms)`);

        if (!top?.url) {
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

        const songTitle = (top.title || "").trim() || "bài này";
        const preVoiceText = `Ây da, bài hát "${songTitle}" của huynh đây rồi, nghe vui nha`;

        // 1) pre-voice mp3
        const preVoicePath = await textToSpeechMp3FilePi(preVoiceText, "prevoice");

        // 2) yt-dlp -> mp3 local (clip first N seconds)
        let songMp3Path = null;
        try {
          songMp3Path = await ytdlpDownloadClipMp3(top.url, audioDir, MAX_MUSIC_SECONDS);
        } catch (e) {
          console.error("❌ yt-dlp download failed:", e?.message || e);
          safeUnlink(preVoicePath);
          const replyText = "YouTube đang lỗi hoặc chặn server. Anh thử lại sau vài giây nha.";
          const ttsPath = await textToSpeechMp3FilePi(replyText, "yt_error");
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

        // 3) concat => final mp3
        const finalPath = await concatTwoMp3(preVoicePath, songMp3Path, audioDir, "music_final");
        const audio_url = filePathToPublicUrl(finalPath);

        // cleanup intermediate
        safeUnlink(preVoicePath);
        safeUnlink(songMp3Path);

        // publish mqtt
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
          audio_url, // ✅ MP3 file URL (client đọc được)
          play: { type: "mp3", url: audio_url, title: songTitle },
          used_vision: false,
        });
      }

      // CHAT fallback (GPT)
      const memoryText = (memoryArr || [])
        .slice(-12)
        .map((m, i) => {
          const u = (m.transcript || "").trim();
          const a = (m.reply_text || "").trim();
          return `#${i + 1} USER: ${u}\n#${i + 1} BOT: ${a}`;
        })
        .join("\n\n");

      const system = `Bạn là dog robot của Matthew. Trả lời ngắn gọn, dễ hiểu, thân thiện.`.trim();
      const messages = [{ role: "system", content: system }];
      if (memoryText) messages.push({ role: "system", content: `Robot recent memory:\n${memoryText}`.slice(0, 6000) });

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [...messages, { role: "user", content: text }],
        temperature: 0.25,
        max_tokens: 260,
      });

      const replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";
      const ttsPath = await textToSpeechMp3FilePi(replyText, "pi_v2");
      const audio_url = filePathToPublicUrl(ttsPath);

      mqttClient.publish(
        "robot/music",
        JSON.stringify({ audio_url, text: replyText, label: "chat", user: userKey }),
        { qos: 1 }
      );

      return res.json({
        status: "ok",
        transcript: text,
        label: "chat",
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
   DEBUG endpoints
=========================================================================== */
app.get("/debug_ytdlp", async (req, res) => {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    res.json({ ok: true, ytdlp: out.trim(), ffmpeg_static: !!ffmpegPath, player_client: YT_PLAYER_CLIENT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/test_ytdlp", async (req, res) => {
  try {
    const url = (req.query.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    const mp3Path = await ytdlpDownloadClipMp3(url, audioDir, MAX_MUSIC_SECONDS);
    const audio_url = filePathToPublicUrl(mp3Path);
    res.json({ ok: true, audio_url, max_seconds: MAX_MUSIC_SECONDS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀 (YouTube/yt-dlp -> MP3 FILE mode)");
});

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🎵 MAX_MUSIC_SECONDS: ${MAX_MUSIC_SECONDS}`);
  console.log(`🎵 yt-dlp timeout: ${MUSIC_YTDLP_TIMEOUT_MS} ms`);
  console.log(`🎵 single player client: ${YT_PLAYER_CLIENT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
  await checkYtdlpReady();
});
