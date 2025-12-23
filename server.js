/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + YouTube Music + Auto Navigation)
   - STT (OpenAI) -> detect intent
   - MUSIC: YouTube search (TOP1) -> return play:{type:"youtube", url,...}
   - CHAT: GPT -> Eleven voice server (WAV->MP3) fallback OpenAI TTS
   - Vision only when user asks
=========================================================================== */

import express from "express";
import fs from "fs";
import path from "path";
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

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const uploadVision = multer({ storage: multer.memoryStorage() });
const upload = multer({ storage: multer.memoryStorage() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const audioDir = path.join(__dirname, "public/audio");
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
  } catch (err) {
    console.error("MQTT message error", err);
  }
});

/* ===========================================================================  
   HELPERS
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
   VOICE (Eleven proxy server -> WAV -> MP3)  ✅ keep
===========================================================================*/
const VOICE_SERVER_URL =
  process.env.VOICE_SERVER_URL ||
  "https://eleven-tts-wav-server-matthewrobotvoice.up.railway.app/convertvoice";

const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 45000);

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

async function voiceServerToMp3(replyText, prefix = "eleven") {
  const ts = Date.now();
  const wavTmp = path.join(audioDir, `${prefix}_${ts}.wav`);
  const mp3Out = path.join(audioDir, `${prefix}_${ts}.mp3`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);

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
      return `${getPublicHost()}/audio/${path.basename(mppath.basename(mp3Out)}`;
    }

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

async function textToSpeechMp3(replyText, prefix = "reply") {
  const safeText = (replyText || "").trim();
  if (!safeText) return await openaiTtsToMp3("Dạ.", `${prefix}_fallback`);

  try {
    return await voiceServerToMp3(safeText, `${prefix}_eleven`);
  } catch (e) {
    console.error("⚠️ voiceServerToMp3 failed -> fallback OpenAI:", e?.message || e);
    return await openaiTtsToMp3(safeText, `${prefix}_openai`);
  }
}

/* ===========================================================================  
   MUSIC INTENT + QUERY CLEANING
===========================================================================*/
function cleanMusicQuery(q = "") {
  let t = (q || "").toLowerCase().trim();
  t = t.replace(/\(.*?\)|\[.*?\]/g, " ");
  t = t.replace(/[.,;:!?]/g, " ");
  t = t.replace(/\b(official|mv|lyrics|karaoke|cover|8d|tiktok|sped\s*up|slowed|remix|ver\.?|version)\b/g, " ");
  t = t.replace(/\b(feat|ft)\.?\b/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function extractSongQuery(text) {
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

function isQuestionLike(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const q = ["la ai", "la gi", "cai gi", "vi sao", "tai sao", "o dau", "khi nao", "bao nhieu", "how", "what", "why", "where", "?"];
  return q.some(k => t.includes(stripDiacritics(k)));
}

function looksLikeSongTitleOnly(userText = "") {
  const t = (userText || "").trim();
  if (!t) return false;

  const nd = stripDiacritics(t.toLowerCase());
  const banned = ["xoay", "qua", "ben", "tien", "lui", "trai", "phai", "dung", "stop"];
  if (banned.some(k => nd.includes(k))) return false;

  if (t.length > 45) return false;
  if (isQuestionLike(t)) return false;

  return /[a-zA-Z0-9À-ỹ]/.test(t);
}

function wantsVision(text = "") {
  const t = stripDiacritics((text || "").toLowerCase());
  const triggers = [
    "nhin", "xem", "xung quanh", "truoc mat", "o day co gi", "mo ta", "trong anh", "anh nay", "tam anh", "camera", "day la gi", "cai gi", "vat gi", "giai thich hinh",
  ];
  return triggers.some((k) => t.includes(stripDiacritics(k)));
}

function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  // stop media
  const stopKeys = ["tat nhac", "tat video", "dung nhac", "stop music", "stop video", "stop", "dung lai"];
  if (stopKeys.some(k => t.includes(stripDiacritics(k)))) return "stop";

  const question = ["la ai", "cho toi biet", "cho toi hoi", "cau hoi", "ban co biet"];
  if (question.some((k) => t.includes(stripDiacritics(k)))) return "question";

  const rules = [
    { keys: ["nhac", "music", "play", "nghe bai hat", "nghe", "phat nhac", "cho toi nghe", "bat nhac", "mo nhac", "mo bai"], out: "nhac" },
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
   CLAP detector shortcut (from STT)
===========================================================================*/
function isClapText(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["clap", "applause", "hand clap", "clapping", "vo tay", "tieng vo tay"];
  return keys.some((k) => t.includes(stripDiacritics(k)));
}

/* ===========================================================================  
   YouTube search (TOP1)
===========================================================================*/
async function searchYouTubeTop1(query) {
  const q = (query || "").trim();
  if (!q) return null;

  try {
    const r = await yts(q);
    const v = r?.videos?.[0];
    if (!v?.url) return null;

    return {
      type: "youtube",
      url: v.url,
      videoId: v.videoId,
      title: v.title,
      seconds: v.seconds ?? null,
      author: v.author?.name ?? null,
    };
  } catch (e) {
    console.error("YouTube search error:", e?.message || e);
    return null;
  }
}

/* ===========================================================================  
   VISION ENDPOINT (giữ như cũ nếu bạn cần)
===========================================================================*/
app.post("/avoid_obstacle_vision", uploadVision.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "No image" });

    let meta = {};
    try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }

    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${b64}`;

    const system = `
Bạn là module "AvoidObstacle" cho robot đi trong nhà.
Trả JSON hợp lệ, KHÔNG giải thích.
`.trim();

    const user = [
      { type: "text", text: `Meta: ${JSON.stringify(meta).slice(0, 1200)}\nReturn JSON: {"best_sector":number,"confidence":number}` },
      { type: "image_url", image_url: { url: dataUrl } },
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.VISION_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "";
    let plan = null;
    try { plan = JSON.parse(raw); } catch { plan = null; }

    return res.json(plan || { best_sector: 4, confidence: 0.2 });
  } catch (err) {
    console.error("/avoid_obstacle_vision error:", err);
    res.status(500).json({ error: err.message || "vision failed" });
  }
});

/* ===========================================================================  
   PI_V2: STT -> (YouTube music OR Chat) -> return play/audio_url
===========================================================================*/
app.post(
  "/pi_upload_audio_v2",
  uploadLimiter,
  upload.fields([{ name: "audio", maxCount: 1 }, { name: "image", maxCount: 1 }]),
  async (req, res) => {
    try {
      const audioFile = req.files?.audio?.[0];
      const imageFile = req.files?.image?.[0] || null;
      const userKey = getClientKey(req);

      if (!audioFile?.buffer) return res.status(400).json({ error: "No audio uploaded" });

      let meta = {};
      try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }
      const memoryArr = Array.isArray(meta.memory) ? meta.memory : [];

      // save WAV
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
        console.log("🎤 PI_V2 STT:", text);
      } catch (e) {
        console.error("PI_V2 STT error:", e);
        try { fs.unlinkSync(wavPath); } catch { }
        return res.json({ status: "error", transcript: "", label: "unknown", reply_text: "", audio_url: null, play: null });
      } finally {
        try { fs.unlinkSync(wavPath); } catch { }
      }

      // clap short-circuit
      if (isClapText(text)) {
        console.log("👏 Detected CLAP by STT -> label=clap");
        return res.json({ status: "ok", transcript: text, label: "clap", reply_text: "", audio_url: null, play: null, used_vision: false });
      }

      // label detect
      let label = overrideLabelByText("unknown", text);

      // ✅ nếu user chỉ nói tên bài hát (không nói “mở nhạc”) vẫn coi là nhạc
      if (label !== "nhac" && looksLikeSongTitleOnly(text)) {
        // bạn có thể siết chặt rule hơn nếu muốn
        label = "nhac";
      }

      // STOP media command
      if (label === "stop") {
        const replyText = "Dạ ok anh, em tắt nhạc/video nha.";
        return res.json({
          status: "ok",
          transcript: text,
          label: "stop",
          reply_text: replyText,
          audio_url: await textToSpeechMp3(replyText, "stop"),
          play: { type: "stop" },
          used_vision: false,
        });
      }

      // MUSIC -> YouTube play
      if (label === "nhac") {
        const q = extractSongQuery(text) || text;
        const play = await searchYouTubeTop1(q);

        if (play?.url) {
          const replyText = `Dạ, em mở YouTube: "${play.title}" nha.`;

          // (optional) notify mqtt
          mqttClient.publish("robot/music", JSON.stringify({ play, text: replyText, label: "nhac", user: userKey }), { qos: 1 });

          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: replyText,
            audio_url: null,
            play,
            used_vision: false,
          });
        }

        const failText = "Em không tìm thấy bài phù hợp trên YouTube. Anh nói lại tên bài + ca sĩ giúp em nha.";
        return res.json({
          status: "ok",
          transcript: text,
          label: "nhac",
          reply_text: failText,
          audio_url: await textToSpeechMp3(failText, "yt_fail"),
          play: null,
          used_vision: false,
        });
      }

      // CHAT / COMMANDS
      const hasImage = !!imageFile?.buffer;
      const useVision = hasImage && wantsVision(text);

      let replyText = "";
      if (["tien", "lui", "trai", "phai"].includes(label)) {
        // movement commands -> publish
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
        replyText = "Dạ.";
      } else {
        const memoryText = memoryArr
          .slice(-12)
          .map((m, i) => {
            const u = (m.transcript || "").trim();
            const a = (m.reply_text || "").trim();
            return `#${i + 1} USER: ${u}\n#${i + 1} BOT: ${a}`;
          })
          .join("\n\n");

        const system = `
Bạn là dog robot của Matthew. Trả lời ngắn gọn, dễ hiểu, thân thiện.

QUY TẮC KIẾN THỨC:
- Với câu hỏi kiến thức phổ thông, trả lời trực tiếp bằng kiến thức chung.
- Chỉ nói "em không chắc" khi quá chi tiết/khó kiểm chứng.

QUY TẮC ẢNH:
- CHỈ mô tả ảnh khi user hỏi kiểu "nhìn/xem/trong ảnh".
`.trim();

        const messages = [{ role: "system", content: system }];

        if (memoryText) {
          messages.push({ role: "system", content: `Robot memory (recent):\n${memoryText}`.slice(0, 6000) });
        }

        if (useVision) {
          const b64 = imageFile.buffer.toString("base64");
          const dataUrl = `data:image/jpeg;base64,${b64}`;
          const userContent = [
            { type: "text", text: `Người dùng nói: "${text}". Vì user hỏi về hình nên mới mô tả hình.` },
            { type: "image_url", image_url: { url: dataUrl } },
          ];

          const completion = await openai.chat.completions.create({
            model: process.env.VISION_MODEL || "gpt-4.1-mini",
            messages: [...messages, { role: "user", content: userContent }],
            temperature: 0.25,
            max_tokens: 420,
          });

          replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa thấy rõ lắm.";
        } else {
          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [...messages, { role: "user", content: text }],
            temperature: 0.25,
            max_tokens: 260,
          });

          replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";
        }
      }

      const audio_url = await textToSpeechMp3(replyText, "pi_v2");

      mqttClient.publish("robot/music", JSON.stringify({ audio_url, text: replyText, label }), { qos: 1 });

      return res.json({
        status: "ok",
        transcript: text,
        label,
        reply_text: replyText,
        audio_url,
        play: null,
        used_vision: !!useVision,
      });
    } catch (err) {
      console.error("pi_upload_audio_v2 error:", err);
      res.status(500).json({ error: err.message || "server error" });
    }
  }
);

/* ===========================================================================  
   web upload_audio (WebM->WAV) - optional
===========================================================================*/
app.post("/upload_audio", uploadLimiter, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "No audio uploaded" });

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);

    if (req.file.buffer.length < 2000) {
      try { fs.unlinkSync(inputFile); } catch { }
      return res.json({ status: "ok", transcript: "", label: "unknown", audio_url: null, play: null });
    }

    const wavFile = inputFile.replace(".webm", ".wav");
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .inputOptions("-fflags +genpts")
        .outputOptions("-vn")
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .on("error", reject)
        .on("end", resolve)
        .save(wavFile);
    });

    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavFile),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (err) {
      try { fs.unlinkSync(inputFile); fs.unlinkSync(wavFile); } catch { }
      return res.status(500).json({ error: "STT failed" });
    } finally {
      try { fs.unlinkSync(inputFile); fs.unlinkSync(wavFile); } catch { }
    }

    let label = overrideLabelByText("unknown", text);

    if (label === "nhac" || looksLikeSongTitleOnly(text)) {
      const q = extractSongQuery(text) || text;
      const play = await searchYouTubeTop1(q);
      if (play?.url) {
        return res.json({ status: "ok", transcript: text, label: "nhac", reply_text: `Mở YouTube: ${play.title}`, audio_url: null, play });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Bạn là trợ lý của robot, trả lời ngắn gọn, dễ hiểu." },
        { role: "user", content: text },
      ],
      temperature: 0.25,
      max_tokens: 260,
    });

    const replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";
    const audio_url = await textToSpeechMp3(replyText, "web");
    return res.json({ status: "ok", transcript: text, label, reply_text: replyText, audio_url, play: null });
  } catch (err) {
    console.error("upload_audio error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ===========================================================================  
   CAMERA ROTATE + SCAN endpoints (giữ)
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

app.get("/get_scanningstatus", (req, res) => res.json({ status: scanStatus }));

app.get("/", (req, res) => res.send("Matthew Robot server is running 🚀"));

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
});
