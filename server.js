/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube -> MP3 FILE + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC:
       Search YouTube (Data API if key else yt-search)
       yt-dlp -g => direct audio stream url
       ffmpeg => convert stream to LOCAL mp3 (clip <= MAX_MUSIC_SECONDS)
       optional: pre-voice mp3 + concat => final mp3
   - Vision endpoint kept (/avoid_obstacle_vision) (optional)
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
   CONFIG
=========================================================================== */
const MAX_MUSIC_SECONDS = Number(process.env.MAX_MUSIC_SECONDS || 540); // 9 minutes
const YT_VIDEO_DURATION = "medium";           // short|medium|long|any
const MAX_ACCEPTABLE_VIDEO_SECONDS = 900;     // 15 minutes filter

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const MUSIC_YTDLP_TIMEOUT_MS = Number(process.env.MUSIC_YTDLP_TIMEOUT_MS || 25000);
const MUSIC_FFMPEG_TIMEOUT_MS = Number(process.env.MUSIC_FFMPEG_TIMEOUT_MS || 240000);
const MUSIC_RETRY = Number(process.env.MUSIC_RETRY || 2); // total attempts = retry + 1

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
   RUN helper
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { }
}
function safeRmDir(p) {
  try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { }
}

/* ===========================================================================
   STATIC (serve mp3 files)
=========================================================================== */
app.use("/audio", express.static(audioDir));

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
   yt-dlp + ffmpeg: YouTube -> local mp3 clip
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

// lấy direct audio URL
async function ytdlpGetAudioStreamUrl(youtubeUrl) {
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
  if (!url || !url.startsWith("http")) throw new Error("yt-dlp -g returned invalid url");
  return url;
}

// convert url -> mp3 clip (<= MAX_MUSIC_SECONDS), dùng reconnect để giảm lỗi 502/timeout
async function ffmpegUrlToMp3Clip(inputUrl, outMp3, seconds = MAX_MUSIC_SECONDS) {
  const sec = Math.max(1, Math.floor(Number(seconds) || MAX_MUSIC_SECONDS));
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",

    // ✅ reconnect flags (hay cứu trong trường hợp 502/timeout)
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    // timeouts
    "-rw_timeout", "15000000",
    "-timeout", "15000000",

    "-i", inputUrl,
    "-t", String(sec),
    "-vn",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "192k",
    outMp3,
  ];

  await run(ffmpegPath, args, { timeoutMs: MUSIC_FFMPEG_TIMEOUT_MS });

  if (!fs.existsSync(outMp3) || fs.statSync(outMp3).size < 50_000) {
    throw new Error("ffmpeg mp3 output missing/too small");
  }
  return outMp3;
}

async function youtubeToMp3Local(youtubeUrl, outDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytmp3_"));
  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, MUSIC_RETRY + 1); attempt++) {
    try {
      // 1) lấy stream url mới (nếu url cũ hết hạn thì attempt sau vẫn cứu được)
      const streamUrl = await ytdlpGetAudioStreamUrl(youtubeUrl);

      // 2) convert -> mp3 local
      const outMp3 = path.join(outDir, `yt_${Date.now()}_${attempt}.mp3`);
      await ffmpegUrlToMp3Clip(streamUrl, outMp3, MAX_MUSIC_SECONDS);

      safeRmDir(tmpDir);
      return outMp3;
    } catch (e) {
      lastErr = e;
      console.error(`[MUSIC] youtubeToMp3Local attempt ${attempt} failed:`, e?.message || e);
      await sleep(700 * attempt);
    }
  }

  safeRmDir(tmpDir);
  throw lastErr || new Error("Failed to convert youtube to mp3");
}

// concat 2 mp3 => final mp3
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

  await run(ffmpegPath, args, { timeoutMs: MUSIC_FFMPEG_TIMEOUT_MS });

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 50_000) {
    throw new Error("concat output missing/too small");
  }
  return outPath;
}

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
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("robot/label");
});

/* ===========================================================================
   TEXT helpers
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

function isQuestionLike(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const q = ["la ai", "la gi", "vi sao", "tai sao", "o dau", "khi nao", "bao nhieu", "how", "what", "why", "where", "?"];
  return q.some(k => t.includes(stripDiacritics(k)));
}

function containsMusicIntent(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["nghe", "nghe nhac", "phat", "phat nhac", "mo", "mo nhac", "mo bai", "bat nhac", "bai hat", "music", "play"];
  return keys.some(k => t.includes(stripDiacritics(k)));
}

function looksLikeMusicQuery(text = "") {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (isQuestionLike(raw)) return false;
  if (raw.length > 80) return false;

  const t = stripDiacritics(raw.toLowerCase());
  const banned = ["xoay", "quay", "re", "tien", "lui", "trai", "phai", "dung", "stop", "di"];
  if (banned.some(k => t.includes(k))) return false;

  const words = t.split(/\s+/).filter(Boolean);
  const isShortPhrase = words.length >= 2 && words.length <= 10;
  return /[a-zA-ZÀ-ỹ]/.test(raw) && isShortPhrase;
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
   YouTube Search (API + fallback yt-search)
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

      const ok = (details || []).filter((d) => typeof d.seconds === "number" && d.seconds <= MAX_ACCEPTABLE_VIDEO_SECONDS);
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
   VOICE (Eleven -> wav->mp3) + fallback OpenAI
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
   MAIN ENDPOINT: /pi_upload_audio_v2
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

      // auto music intent
      let label = "unknown";
      if (shouldAutoSwitchToMusic(text)) label = "nhac";

      // ===========================
      // MUSIC => RETURN MP3 FILE URL
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

        // 2) youtube -> mp3 clip local (<= MAX_MUSIC_SECONDS)
        const songMp3Path = await youtubeToMp3Local(top.url, audioDir);

        // 3) concat -> final mp3
        const finalPath = await concatTwoMp3(preVoicePath, songMp3Path, audioDir, "music_final");
        const audio_url = filePathToPublicUrl(finalPath);

        // cleanup intermediate (final giữ lại)
        safeUnlink(preVoicePath);
        safeUnlink(songMp3Path);

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
          audio_url, // ✅ mp3 file như cũ
          play: { type: "mp3", url: audio_url, title: songTitle },
          used_vision: false,
        });
      }

      // ===========================
      // GPT chat (fallback)
      // ===========================
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
      if (memoryText) {
        messages.push({ role: "system", content: `Robot recent memory:\n${memoryText}`.slice(0, 6000) });
      }

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
   Debug endpoints
=========================================================================== */
app.get("/debug_ytdlp", async (req, res) => {
  try {
    const { out } = await run(YTDLP_BIN, ["--version"], { timeoutMs: 15000 });
    return res.json({ ok: true, ytdlp: out.trim(), ffmpeg_static: !!ffmpegPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/test_youtube_mp3", async (req, res) => {
  try {
    const url = (req.query.url || "").toString().trim();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    const songMp3Path = await youtubeToMp3Local(url, audioDir);
    const audio_url = filePathToPublicUrl(songMp3Path);
    return res.json({ ok: true, audio_url, max_seconds: MAX_MUSIC_SECONDS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===========================================================================
   ROOT
=========================================================================== */
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀 (YouTube => local MP3 mode)");
});

/* ===========================================================================
   START SERVER
=========================================================================== */
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🎵 MAX_MUSIC_SECONDS: ${MAX_MUSIC_SECONDS}`);
  console.log(`🎵 yt-dlp timeout: ${MUSIC_YTDLP_TIMEOUT_MS} ms`);
  console.log(`🎵 ffmpeg timeout: ${MUSIC_FFMPEG_TIMEOUT_MS} ms`);
  console.log(`🎵 YouTube Data API enabled: ${!!YOUTUBE_API_KEY}`);
  await checkYtdlpReady();
});
