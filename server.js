/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube + Auto Navigation)
   - STT + ChatGPT -> TTS (Eleven WAV server -> MP3, fallback OpenAI TTS)
   - MUSIC: YouTube search (yt-search) -> yt-dlp extract mp3 -> return audio_url (NO VIDEO)
   - ✅ NEW: tạo 1 đoạn intro TTS: "Ây da, mình tìm được bài hát ...", rồi ghép vào trước nhạc
            => trả về 1 audio mp3 cuối cho client
   - ✅ NEW ARCH (FIX LONG YT > threshold):
        + In log ra thời lượng video sau khi search
        + Video dài: lấy transcript từ REMOTE_YT_SERVER -> GPT chấm dấu câu -> TTS theo chunk
        + Trả về audio chunk #0 + podcast_id để client gọi /podcast_next lấy tiếp
   - PI endpoint: TEXT ONLY (no vision), image optional (ignored)
   - AvoidObstacle vision endpoint kept
   - Label override + scan endpoints + camera rotate
===========================================================================*/

import express from "express";
import http from "http";
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
// ✅ prevent Node from timing out long requests (proxy/client may still timeout)
app.use((req, res, next) => {
  try {
    res.setTimeout(0);
  } catch { }
  next();
});
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
      try {
        p.kill("SIGKILL");
      } catch { }
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

// ✅ IMPORTANT (FIX 403 / PO Token):
// Ưu tiên web/ios và retry theo danh sách client.
const YT_PLAYER_CLIENTS = (process.env.YT_PLAYER_CLIENTS || "web,ios,android")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function ytExtractorArgsForClient(client) {
  return ["--extractor-args", `youtube:player_client=${client}`];
}

// ✅ NEW ARCH: remote transcript server
const REMOTE_YT_SERVER =
  process.env.REMOTE_YT_SERVER ||
  "https://endearing-upliftment-ytserver.up.railway.app";

// threshold video dài (seconds). default: 20 phút
const LONG_VIDEO_SECONDS = Number(process.env.LONG_VIDEO_SECONDS || 20 * 60);

// giới hạn transcript (tránh quá dài làm GPT/TTS timeout)
const TRANSCRIPT_MAX_CHARS = Number(process.env.TRANSCRIPT_MAX_CHARS || 20000);

// model punctuation
const PUNCTUATE_MODEL = process.env.PUNCTUATE_MODEL || "gpt-4.1-mini";

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

// ======================
// YTSERVER connectivity check (run on startup)
// ======================
async function checkYtServerConnectivity(remoteBaseUrl) {
  const base = String(remoteBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    console.log("⚠️  YTSERVER: REMOTE_YT_SERVER not set. Skip check.");
    return { ok: false, reason: "missing_base" };
  }

  const healthUrl = `${base}/health`;

  const fetchWithTimeout = async (url, ms = 16000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { method: "GET", signal: ac.signal });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(t);
    }
  };

  try {
    const { res, text } = await fetchWithTimeout(healthUrl, 6000);
    if (res.ok) {
      let js = null;
      try {
        js = JSON.parse(text);
      } catch (_) { }
      console.log("✅ YTSERVER CONNECT OK:", {
        base,
        health: healthUrl,
        status: res.status,
        body: js || (text || "").slice(0, 120),
      });
      return { ok: true, status: res.status };
    }

    console.log("⚠️  YTSERVER health not OK:", {
      base,
      status: res.status,
      bodyPreview: (text || "").slice(0, 160),
    });
    return { ok: false, reason: "health_not_ok", status: res.status };
  } catch (e) {
    const msg = String(e?.message || e);
    const isAbort = msg.toLowerCase().includes("abort");
    console.log("❌ YTSERVER CONNECT FAIL:", {
      base,
      health: healthUrl,
      error: msg,
      hint: isAbort
        ? "Timeout (server down / cold start / network blocked)"
        : "Network/DNS/TLS error",
    });
    return { ok: false, reason: "network_error", error: msg };
  }
}

/** Extract mp3 from YouTube URL into audioDir, return absolute mp3 filepath */
async function ytdlpExtractMp3FromYoutube(url, outDir) {
  if (!url) throw new Error("Missing url");
  fs.mkdirSync(outDir, { recursive: true });

  const ts = Date.now();
  const outTemplate = path.join(outDir, `yt_${ts}.%(ext)s`);

  let lastErr = null;

  // Retry theo danh sách client để giảm 403/Forbidden
  for (const client of YT_PLAYER_CLIENTS) {
    const args = [
      "--no-playlist",
      "--force-ipv4",
      ...ytExtractorArgsForClient(client),
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--ffmpeg-location",
      ffmpegPath,
      "-o",
      outTemplate,
      url,
    ];

    try {
      console.log("▶️ yt-dlp download (client):", client, url);
      await run(YTDLP_BIN, args, { timeoutMs: 240000 });

      const files = fs
        .readdirSync(outDir)
        .filter((f) => f.startsWith(`yt_${ts}.`));
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
        const junk = fs
          .readdirSync(outDir)
          .filter((f) => f.startsWith(`yt_${ts}.`));
        for (const f of junk) safeUnlink(path.join(outDir, f));
      } catch { }
      // thử client tiếp theo
    }
  }

  throw lastErr || new Error("yt-dlp failed (all clients)");
}

/* ===========================================================================  
   ✅ Captions local fallback (vtt -> text)
===========================================================================*/
function vttToPlainText(vttRaw = "") {
  const lines = vttRaw.split(/\r?\n/);
  const keep = [];

  for (const line of lines) {
    const l = (line || "").trim();
    if (!l) continue;
    if (l === "WEBVTT") continue;
    if (/^\d+$/.test(l)) continue; // cue number
    if (l.includes("-->")) continue; // timestamps
    if (/^(NOTE|Kind:|Language:)/i.test(l)) continue;
    keep.push(l);
  }

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

  const args = [
    "--skip-download",
    "--no-playlist",
    "--force-ipv4",
    ...ytExtractorArgsForClient("web"),
    "--write-subs",
    "--write-auto-subs",
    "--sub-format",
    "vtt",
    "--sub-langs",
    "vi,vi-VN,en,en-US",
    "-o",
    outTemplate,
    url,
  ];

  try {
    await run(YTDLP_BIN, args, { timeoutMs: 120000 });
  } catch (e) {
    console.error("⚠️ ytdlp captions error:", e?.message || e);
    return null;
  }

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(`cap_${ts}.`) && f.endsWith(".vtt"));

  if (!files.length) return null;

  const pick =
    files.find((f) => f.includes(".vi.") || f.includes(".vi-VN.")) ||
    files.find((f) => f.includes(".en.") || f.includes(".en-US.")) ||
    files[0];

  return path.join(outDir, pick);
}

async function getYoutubeTranscriptTextLocal(url) {
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
    try {
      fs.unlinkSync(vttPath);
    } catch { }
  }
}

/* ===========================================================================  
   ✅ NEW ARCH: fetch transcript from remote YT server
   Expect: POST /api/transcript (or similar) -> JSON includes transcript/text
===========================================================================*/
async function tryFetchJson(url, opts) {
  const controller = new AbortController();
  const timeoutMs = Number(opts?.timeoutMs || 180000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!resp.ok) {
      const msg = json?.error || text || `HTTP ${resp.status}`;
      throw new Error(`Remote ${resp.status}: ${String(msg).slice(0, 400)}`);
    }
    return json || { raw: text };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRemoteTranscript(json) {
  if (!json) return "";

  // common direct strings
  const direct =
    (typeof json.transcript === "string" && json.transcript) ||
    (typeof json.text === "string" && json.text) ||
    (typeof json.caption === "string" && json.caption) ||
    (typeof json?.data?.transcript === "string" && json.data.transcript) ||
    (typeof json?.data?.text === "string" && json.data.text) ||
    (typeof json?.result?.transcript === "string" && json.result.transcript) ||
    "";

  if (direct) return String(direct).trim();

  // array segments: [{text:"..."}, ...]
  const arr =
    (Array.isArray(json.segments) && json.segments) ||
    (Array.isArray(json.items) && json.items) ||
    (Array.isArray(json.data?.segments) && json.data.segments) ||
    null;

  if (arr) {
    const joined = arr
      .map((x) => (typeof x === "string" ? x : x?.text || x?.transcript || ""))
      .filter(Boolean)
      .join(" ");
    return joined.replace(/\s+/g, " ").trim();
  }

  return "";
}

async function fetchRemoteTranscriptText({ videoUrl }) {
  const endpoint = `${String(REMOTE_YT_SERVER).replace(/\/+$/, "")}/api/transcript`;

  const body = new URLSearchParams();
  body.set("video_url", videoUrl);
  body.set("format", "json");
  body.set("include_timestamp", "false");
  body.set("send_metadata", "false");

  const json = await tryFetchJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    timeoutMs: 240000,
  });

  const txt = normalizeRemoteTranscript(json);
  return (txt || "").trim();
}

/* ===========================================================================  
   ✅ Punctuation with GPT (keep words, add punctuation only)
===========================================================================*/
function chunkByChars(text = "", maxChars = 2400) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    chunks.push(t.slice(i, i + maxChars));
    i += maxChars;
  }
  return chunks;
}

async function punctuateWithGPT(rawText = "") {
  const t = (rawText || "").replace(/\s+/g, " ").trim();
  if (!t) return "";

  // hard cap
  const capped =
    t.length > TRANSCRIPT_MAX_CHARS ? t.slice(0, TRANSCRIPT_MAX_CHARS) : t;

  const parts = chunkByChars(capped, 2400);
  const out = [];

  for (let idx = 0; idx < parts.length; idx++) {
    const piece = parts[idx];

    const system = `
Bạn là công cụ "chấm dấu câu" cho transcript.
YÊU CẦU:
- Giữ nguyên từ ngữ, KHÔNG thêm/đổi/bớt ý.
- Chỉ thêm dấu câu, xuống dòng nếu cần cho dễ đọc/nghe.
- Không giải thích. Chỉ xuất ra văn bản đã chấm dấu câu.
`.trim();

    const completion = await openai.chat.completions.create({
      model: PUNCTUATE_MODEL,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `PHẦN ${idx + 1}/${parts.length}:\n${piece}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 900,
    });

    const punct = completion.choices?.[0]?.message?.content?.trim() || piece;
    out.push(punct);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ===========================================================================  
   ✅ Chunk for TTS (podcast)
===========================================================================*/
function chunkTextSmart(text = "", maxChars = 520) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];

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

  // (optional) gesture topics
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

const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 45000);
const VOICE_TIMEOUT_PI_MS = Number(process.env.VOICE_TIMEOUT_PI_MS || 12000);
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

async function voiceServerToMp3WithTimeout(
  replyText,
  prefix = "eleven",
  timeoutMs = VOICE_TIMEOUT_MS
) {
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
      return `${getPublicHost()}/audio/${path.basename(mp3Out)}`;
    }

    fs.writeFileSync(wavTmp, buf);

    await new Promise((resolve, reject) =>
      ffmpeg(wavTmp)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(mp3Out)
    );

    try {
      fs.unlinkSync(wavTmp);
    } catch { }
    return `${getPublicHost()}/audio/${path.basename(mp3Out)}`;
  } catch (e) {
    clearTimeout(timer);
    try {
      if (fs.existsSync(wavTmp)) fs.unlinkSync(wavTmp);
    } catch { }
    try {
      if (fs.existsSync(mp3Out)) fs.unlinkSync(mp3Out);
    } catch { }
    throw e;
  }
}

async function textToSpeechMp3Pi(replyText, prefix = "pi_v2") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3WithTimeout(
      safeText,
      `${prefix}_eleven`,
      VOICE_TIMEOUT_PI_MS
    );
  } catch (e) {
    console.error("⚠️ PI voice server timeout/fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3(safeText, `${prefix}_openai`);
  }
}

async function textToSpeechMp3Long(replyText, prefix = "long") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3WithTimeout(
      safeText,
      `${prefix}_eleven`,
      VOICE_TIMEOUT_LONG_MS
    );
  } catch (e) {
    console.error("⚠️ LONG voice server fail -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================  
   ✅ CONCAT mp3 helpers
===========================================================================*/
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch { }
}

function audioUrlToLocalPath(audio_url) {
  const u = new URL(audio_url);
  const filename = path.basename(u.pathname);
  return path.join(audioDir, filename);
}

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
   ✅ Podcast session store (punctuated transcript -> chunks)
===========================================================================*/
const podcastSessions = new Map();
const PODCAST_TTL_MS = Number(process.env.PODCAST_TTL_MS || 60 * 60 * 1000); // 1h
const PODCAST_MAX_CHUNKS = Number(process.env.PODCAST_MAX_CHUNKS || 240);

function newPodcastId() {
  return `pod_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createPodcastSession({ title = "", url = "", transcriptText = "" }) {
  let chunks = chunkTextSmart(transcriptText, 520);

  if (chunks.length > PODCAST_MAX_CHUNKS) {
    chunks = chunks.slice(0, PODCAST_MAX_CHUNKS);
  }

  const id = newPodcastId();
  podcastSessions.set(id, {
    id,
    title,
    url,
    chunks,
    index: 0, // current index already served (0 means chunk0 will be served now)
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

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of podcastSessions.entries()) {
    if (!s?.createdAt || now - s.createdAt > PODCAST_TTL_MS) {
      podcastSessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

/* ===========================================================================  
   ✅ JOB QUEUE (avoid client timeout)
===========================================================================*/
const jobs = new Map();
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000); // 1h

function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createJob(initial = {}) {
  const id = newJobId();
  jobs.set(id, {
    id,
    status: "queued", // queued | running | done | error
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null,
    ...initial,
  });
  return id;
}

function patchJob(id, patch = {}) {
  const j = jobs.get(id);
  if (!j) return null;
  Object.assign(j, patch, { updatedAt: Date.now() });
  jobs.set(id, j);
  return j;
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  if (Date.now() - (j.createdAt || 0) > JOB_TTL_MS) {
    jobs.delete(id);
    return null;
  }
  return j;
}

async function runJob(id, fn) {
  patchJob(id, { status: "running" });
  try {
    const result = await fn();
    patchJob(id, { status: "done", result, error: null });
    return result;
  } catch (e) {
    patchJob(id, { status: "error", error: e?.message || String(e) });
    throw e;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs.entries()) {
    if (!j?.createdAt || now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 20 * 60 * 1000);

app.get("/job", (req, res) => {
  const id = (req.query.id || "").toString().trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing ?id=" });
  const j = getJob(id);
  if (!j) return res.status(404).json({ ok: false, error: "Job not found/expired" });
  return res.json({ ok: true, job: j });
});

/* ===========================================================================  
   ✅ endpoint lấy chunk tiếp theo
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
      return res.json({
        ok: true,
        id,
        done: true,
        index: nextIndex,
        total: s.chunks.length,
        audio_url: null,
      });
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
    "la ai",
    "la gi",
    "cai gi",
    "vi sao",
    "tai sao",
    "o dau",
    "khi nao",
    "bao nhieu",
    "how",
    "what",
    "why",
    "where",
    "?",
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
    "nghe",
    "nghe nhac",
    "phat",
    "phat nhac",
    "mo",
    "mo nhac",
    "mo bai",
    "bat nhac",
    "bai hat",
    "cho toi nghe",
    "mở",
    "bật",
    "phát",
    "listen",
    "play song",
    "play music",
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
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "file", maxCount: 1 },
    { name: "voice", maxCount: 1 },
    { name: "wav", maxCount: 1 },
    { name: "recording", maxCount: 1 },
    { name: "image", maxCount: 1 },
    { name: "photo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const t0 = Date.now();
      const ms = () => Date.now() - t0;

      const audioFile = (
        req.files?.audio?.[0] ||
        req.files?.file?.[0] ||
        req.files?.voice?.[0] ||
        req.files?.wav?.[0] ||
        req.files?.recording?.[0]
      );
      const userKey = getClientKey(req);

      if (!audioFile?.buffer) {
        return res.status(400).json({
          error: "No audio uploaded (expected multipart field: audio/file/voice/wav/recording)",
        });
      }

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

        const durationStr = formatDuration(top?.seconds);
        const isLong = typeof top?.seconds === "number" && top.seconds >= LONG_VIDEO_SECONDS;
        const route = isLong ? "REMOTE_TRANSCRIPT_TTS" : "LOCAL_YTDLP";

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

        if (!top?.url) {
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

        // ✅ LONG VIDEO => transcript -> punctuate -> TTS chunk -> podcast_next
        if (isLong) {
          const wantWait = String(req.query.wait || req.query.sync || "0") === "1";

          const jobMeta = {
            type: "yt_long_transcript_tts",
            user: userKey,
            stt: text,
            q,
            yt: {
              title: top.title,
              url: top.url,
              seconds: top.seconds,
              duration: durationStr,
            },
            remote: REMOTE_YT_SERVER,
          };

          const processLong = async () => {
            console.log("📤 LONG_YT -> FETCH TRANSCRIPT REMOTE:", {
              remote: REMOTE_YT_SERVER,
              url: top.url,
              title: top.title,
              seconds: top.seconds,
              duration: durationStr,
            });

            // 1) remote transcript
            let transcript = "";
            try {
              transcript = await fetchRemoteTranscriptText({ videoUrl: top.url });
            } catch (e) {
              console.error("⚠️ Remote transcript failed:", e?.message || e);
              transcript = "";
            }

            // 2) fallback local captions if remote empty
            if (!transcript || transcript.length < 30) {
              console.log("⚠️ Remote transcript empty -> fallback local captions (yt-dlp vtt)");
              transcript = await getYoutubeTranscriptTextLocal(top.url);
            }

            if (!transcript || transcript.length < 30) {
              throw new Error("No transcript available (remote + local captions both empty)");
            }

            // cap transcript to avoid huge tasks
            if (transcript.length > TRANSCRIPT_MAX_CHARS) {
              transcript = transcript.slice(0, TRANSCRIPT_MAX_CHARS);
            }

            console.log("📝 TRANSCRIPT_LEN:", transcript.length);

            // 3) GPT punctuation
            console.log("🔧 PUNCTUATE_WITH_GPT...");
            const punctuated = await punctuateWithGPT(transcript);
            console.log("✅ PUNCTUATED_LEN:", punctuated.length);

            // 4) create podcast session
            const podcast_id = createPodcastSession({
              title: top.title,
              url: top.url,
              transcriptText: punctuated,
            });

            const s = getPodcastSession(podcast_id);
            const total = s?.chunks?.length || 0;

            // 5) TTS intro + chunk0, then concat
            const introText = `Video này hơi dài. Em sẽ đọc nội dung cho bạn nghe từng phần. Đây là "${top.title}".`;
            const intro_url = await textToSpeechMp3Long(introText, `pod_intro_${podcast_id}`);
            const introLocal = audioUrlToLocalPath(intro_url);

            const chunk0 = s.chunks[0] || punctuated.slice(0, 520);
            const chunk0_url = await textToSpeechMp3Long(chunk0, `pod_${podcast_id}_0`);
            const chunk0Local = audioUrlToLocalPath(chunk0_url);

            const first_audio_url = await concatMp3LocalToPublicUrl(
              introLocal,
              chunk0Local,
              `pod_first_${podcast_id}`
            );

            safeUnlink(introLocal);
            safeUnlink(chunk0Local);

            console.log("✅ LONG_TTS_READY:", {
              podcast_id,
              total,
              first_audio_url,
              title: top.title,
              duration: durationStr,
            });

            // MQTT notify
            mqttClient.publish(
              "robot/music",
              JSON.stringify({
                label: "nhac",
                mode: "podcast_transcript_tts",
                text: introText,
                audio_url: first_audio_url,
                user: userKey,
                podcast: { id: podcast_id, index: 0, total },
                yt: {
                  title: top.title,
                  url: top.url,
                  seconds: top.seconds,
                  duration: durationStr,
                  route: "remote_transcript_tts",
                  remote_server: REMOTE_YT_SERVER,
                },
              }),
              { qos: 1 }
            );

            return {
              status: "ok",
              transcript: text,
              label: "nhac",
              reply_text: introText,
              audio_url: first_audio_url,
              play: null,
              used_vision: false,
              yt: {
                title: top.title,
                url: top.url,
                seconds: top.seconds,
                duration: durationStr,
                route: "REMOTE_TRANSCRIPT_TTS",
              },
              podcast: { id: podcast_id, index: 0, total },
            };
          };

          // ✅ default async job to avoid timeout
          if (!wantWait) {
            const job_id = createJob(jobMeta);
            console.log("🧵 JOB_CREATED:", { job_id, ...jobMeta });
            runJob(job_id, processLong).catch((e) => {
              console.error("❌ Job failed:", job_id, e?.message || e);
            });

            return res.status(202).json({
              status: "processing",
              job_id,
              transcript: text,
              label: "nhac",
              title: top.title,
              url: top.url,
              seconds: top.seconds,
              duration: durationStr,
              route: "REMOTE_TRANSCRIPT_TTS",
              remote: REMOTE_YT_SERVER,
            });
          }

          // ✅ sync wait=1 (debug)
          const job_id = createJob({ ...jobMeta, note: "sync_wait=1" });
          try {
            const result = await runJob(job_id, processLong);
            return res.json({ ...result, job_id });
          } catch (e) {
            console.error("❌ LONG transcript TTS error:", e?.message || e);
            const replyText = `Em bị lỗi khi lấy transcript cho video dài "${top.title}". Anh thử video khác giúp em nha.`;
            const audio_url = await textToSpeechMp3Pi(replyText, "yt_long_fail");
            return res.json({
              status: "ok",
              transcript: text,
              label: "nhac",
              reply_text: replyText,
              audio_url,
              play: null,
              used_vision: false,
              job_id,
            });
          }
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
        const final_audio_url = await concatMp3LocalToPublicUrl(
          introLocalPath,
          songMp3Path,
          "music_final"
        );

        // dọn file trung gian
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
   MULTER ERROR HANDLER (better logs)
===========================================================================*/
app.use((err, req, res, next) => {
  if (err && err.name === "MulterError") {
    console.error("❌ MulterError:", err.code, "field:", err.field || "(unknown)");
    return res.status(400).json({
      error: `MulterError ${err.code} field=${err.field || "unknown"}`,
    });
  }
  return next(err);
});

/* ===========================================================================  
   ROOT
===========================================================================*/
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀 (YouTube short=mp3+intro, long=transcript->punctuate->TTS podcast)");
});

/* ===========================================================================  
   START SERVER (tune timeouts)
===========================================================================*/
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
try {
  server.requestTimeout = 0;
} catch { }

server.listen(PORT, async () => {
  console.log(` Server listening on port ${PORT}`);
  console.log(` Voice server: ${VOICE_SERVER_URL}`);
  console.log(` Remote YT server: ${REMOTE_YT_SERVER}`);
  console.log(` LONG_VIDEO_SECONDS: ${LONG_VIDEO_SECONDS}`);
  console.log(` TRANSCRIPT_MAX_CHARS: ${TRANSCRIPT_MAX_CHARS}`);
  console.log(` PUNCTUATE_MODEL: ${PUNCTUATE_MODEL}`);
  await checkYtdlpReady();
  await checkYtServerConnectivity(REMOTE_YT_SERVER);
});
