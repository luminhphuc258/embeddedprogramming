/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + iTunes + YouTube Play)
   - STT + ChatGPT + TTS (Eleven proxy -> MP3, fallback OpenAI TTS)
   - iTunes search (OLD stable: limit=1, pick first)
   - NEW: YouTube play -> return { play: { type:"youtube", playerUrl } }
   - Compatible with Pi client main.py:
       * play.type=="youtube" => Pi calls robot-video-player service
       * audio_url => Pi stops video, set face suprise + mouth, plays audio
       * label=="clap" => Pi bark + sad face
===========================================================================*/

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
   VOICE (Eleven proxy server -> WAV -> MP3) + fallback OpenAI TTS
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
      return `${getPublicHost()}/audio/${path.basename(mp3Out)}`;
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
   MUSIC QUERY CLEANING
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
    "xin chao", "nghe", "toi muon nghe", "cho toi nghe",
    "nghe nhac", "phat nhac", "bat nhac", "mo bai",
    "bai hat", "bai nay", "nhac", "song", "music", "play",
    "youtube", "you tube", "video"
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
   YouTube intent + search
   - If user says "youtube", "mở video", "play video", "bật youtube" => YouTube
===========================================================================*/
function wantsYouTube(text = "") {
  const t = stripDiacritics((text || "").toLowerCase());
  const triggers = [
    "youtube", "you tube", "mo youtube", "bat youtube",
    "mo video", "bat video", "play video", "xem video",
    "video nay", "mo clip", "bat clip"
  ];
  return triggers.some(k => t.includes(stripDiacritics(k)));
}

async function searchYouTubeFirstUrl(query) {
  const q = (query || "").trim();
  if (!q) return null;

  try {
    const r = await yts(q);
    const v = (r?.videos || [])[0];
    if (!v?.url) return null;
    return { url: v.url, title: v.title || "", duration_sec: v.seconds || null, author: v.author?.name || "" };
  } catch (e) {
    console.error("YouTube search error:", e?.message || e);
    return null;
  }
}

/* ===========================================================================  
   iTunes search (OLD stable)
===========================================================================*/
const ITUNES_COUNTRY = (process.env.ITUNES_COUNTRY || "US").toUpperCase();
const ITUNES_LANG = process.env.ITUNES_LANG || "";

async function searchITunesOld(query) {
  const q = (query || "").trim();
  if (!q) return null;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "1");
  url.searchParams.set("term", q);
  url.searchParams.set("country", ITUNES_COUNTRY);
  if (ITUNES_LANG) url.searchParams.set("lang", ITUNES_LANG);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const data = await resp.json();
    const item = data?.results?.[0] || null;
    if (item?.previewUrl) return item;
    return null;
  } catch (e) {
    clearTimeout(timer);
    console.error("iTunes search error:", e?.message || e);
    return null;
  }
}

/* ===========================================================================  
   MP3 from iTunes preview
===========================================================================*/
async function getMp3FromPreview(previewUrl) {
  const ts = Date.now();
  const src = path.join(audioDir, `song_${ts}.m4a`);
  const dst = path.join(audioDir, `song_${ts}.mp3`);

  const resp = await fetch(previewUrl);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(src, buffer);

  await new Promise((resolve, reject) =>
    ffmpeg(src).toFormat("mp3").on("end", resolve).on("error", reject).save(dst)
  );

  try { fs.unlinkSync(src); } catch { }
  return `${getPublicHost()}/audio/song_${ts}.mp3`;
}

/* ===========================================================================  
   VISION / INTENT HELPERS (keep)
===========================================================================*/
function isQuestionLike(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const q = ["la ai", "la gi", "cai gi", "vi sao", "tai sao", "o dau", "khi nao", "bao nhieu", "how", "what", "why", "where", "?"];
  return q.some(k => t.includes(stripDiacritics(k)));
}

function wantsVision(text = "") {
  const t = stripDiacritics((text || "").toLowerCase());
  const triggers = [
    "nhin", "xem", "xung quanh", "truoc mat", "o day co gi",
    "mo ta", "trong anh", "anh nay", "camera", "day la gi",
    "cai gi", "vat gi", "giai thich hinh",
  ];
  return triggers.some((k) => t.includes(stripDiacritics(k)));
}

/* ===========================================================================  
   OVERRIDE LABEL
===========================================================================*/
function isClapText(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = ["clap", "applause", "hand clap", "clapping", "vo tay", "tieng vo tay"];
  return keys.some((k) => t.includes(stripDiacritics(k)));
}

function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

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
   VISION ENDPOINT (optional, keep skeleton)
===========================================================================*/
app.post("/avoid_obstacle_vision", uploadVision.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No image" });
    // (Bạn giữ endpoint này như cũ nếu đang dùng. Mình không sửa logic ở đây.)
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("/avoid_obstacle_vision error:", err);
    res.status(500).json({ error: err.message || "vision failed" });
  }
});

/* ===========================================================================  
   PI UPLOAD V2 — STT → (YouTube / iTunes / ChatGPT) → return audio_url OR play
===========================================================================*/
app.post(
  "/pi_upload_audio_v2",
  uploadLimiter,
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const audioFile = req.files?.audio?.[0];
      const imageFile = req.files?.image?.[0] || null;

      if (!audioFile?.buffer) {
        return res.status(400).json({ error: "No audio uploaded" });
      }

      // meta (memory)
      let meta = {};
      try { meta = req.body?.meta ? JSON.parse(req.body.meta) : {}; } catch { meta = {}; }
      const memoryArr = Array.isArray(meta.memory) ? meta.memory : [];

      // save wav
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

      // base label
      let label = overrideLabelByText("unknown", text);

      // 1) YOUTUBE PLAY (highest priority if user requests)
      if (wantsYouTube(text)) {
        const q = extractSongQuery(text) || text;
        const yt = await searchYouTubeFirstUrl(q);

        if (yt?.url) {
          const replyText = `Dạ ok anh, em mở YouTube "${yt.title || q}" nha.`;
          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: replyText,
            audio_url: null,
            play: {
              type: "youtube",
              playerUrl: yt.url,
              title: yt.title || "",
              duration_sec: yt.duration_sec || null,
              query: q,
            },
            used_vision: false,
            itunes_country: ITUNES_COUNTRY,
          });
        } else {
          // fallback: speak
          const replyText = "Em không tìm thấy video YouTube phù hợp. Anh nói lại tên bài giúp em nha.";
          const audioUrl = await textToSpeechMp3(replyText, "pi_v2");
          return res.json({
            status: "ok",
            transcript: text,
            label: "nhac",
            reply_text: replyText,
            audio_url: audioUrl,
            play: null,
            used_vision: false,
            itunes_country: ITUNES_COUNTRY,
          });
        }
      }

      // 2) MUSIC iTunes (limit=1 old stable)
      let replyText = "";
      let playbackUrl = null;
      let play = null;

      if (label === "nhac") {
        const query = extractSongQuery(text) || text;
        const m = await searchITunesOld(query);

        if (m?.previewUrl) {
          playbackUrl = await getMp3FromPreview(m.previewUrl);
          replyText = `Dạ, em mở bài "${m.trackName}" của ${m.artistName} cho anh nhé.`;
        } else {
          replyText = "Em không tìm thấy bài hát phù hợp ở iTunes. Anh nói lại tên bài + ca sĩ giúp em nha.";
        }
      }

      // 3) GPT (only if not playing iTunes)
      const hasImage = !!imageFile?.buffer;
      const useVision = hasImage && wantsVision(text);

      if (!playbackUrl && label !== "nhac") {
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
- Với câu hỏi kiến thức phổ thông (người nổi tiếng, khái niệm, “là ai”, “là gì”), hãy trả lời trực tiếp bằng kiến thức chung.
- Chỉ nói "em không chắc" khi câu hỏi quá chi tiết/khó kiểm chứng.

QUY TẮC ẢNH:
- CHỈ mô tả hình khi user hỏi "nhìn/xem/xung quanh/trong ảnh".
- Nếu user KHÔNG hỏi về hình thì bỏ qua ảnh.
`.trim();

        const messages = [{ role: "system", content: system }];

        if (memoryText) {
          messages.push({
            role: "system",
            content: `Robot memory (recent):\n${memoryText}`.slice(0, 6000),
          });
        }

        if (useVision) {
          const b64 = imageFile.buffer.toString("base64");
          const dataUrl = `data:image/jpeg;base64,${b64}`;

          const userContent = [
            { type: "text", text: `Người dùng nói: "${text}". Vì user hỏi về hình nên mô tả hình đúng yêu cầu.` },
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

      // 4) If still no playbackUrl => TTS
      if (!playbackUrl) {
        playbackUrl = await textToSpeechMp3(replyText, "pi_v2");
      }

      // 5) publish MQTT (optional)
      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
      } else {
        mqttClient.publish(
          "robot/music",
          JSON.stringify({ audio_url: playbackUrl, text: replyText, label }),
          { qos: 1 }
        );
      }

      return res.json({
        status: "ok",
        transcript: text,
        label,
        reply_text: replyText,
        audio_url: playbackUrl, // IMPORTANT for Pi client
        play,                  // null (unless youtube branch above)
        used_vision: !!useVision,
        itunes_country: ITUNES_COUNTRY,
      });
    } catch (err) {
      console.error("pi_upload_audio_v2 error:", err);
      res.status(500).json({ error: err.message || "server error" });
    }
  }
);

/* ===========================================================================  
   SIMPLE ROOT CHECK  
===========================================================================*/
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀");
});

/* ===========================================================================  
   START SERVER  
===========================================================================*/
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🎵 iTunes country=${ITUNES_COUNTRY} lang=${ITUNES_LANG || "(none)"}`);
  console.log(`🗣️ Voice server: ${VOICE_SERVER_URL}`);
});
