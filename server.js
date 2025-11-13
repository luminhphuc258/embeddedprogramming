import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mqtt from "mqtt";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import cors from "cors";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });

/* ========= CORS cho video server ========= */
const allowedOrigins = [
  "https://videoserver-videoserver.up.railway.app",
  "http://localhost:8000",
  "http://localhost:8080",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// preflight cho route upload_audio
app.options("/upload_audio", cors());

/* ========= Static ========= */
app.use("/audio", express.static(audioDir));

/* ========= MQTT Setup ========= */
const MQTT_HOST = "rfff7184.ala.us-east-1.emqxsl.com";
const MQTT_PORT = 8883;
const MQTT_USER = "robot_matthew";
const MQTT_PASS = "29061992abCD!yesokmen";

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;
const mqttClient = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT Broker");
  mqttClient.subscribe("robot/audio_in");
});
mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));

/* ========= Helper Functions ========= */
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function hasWakeWord(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  return /(xin chao|hello|hi|nghe|doremon|lily|pipi|bibi)/.test(t);
}

/** Lấy phần tên bài hát từ câu lệnh tiếng Việt */
function extractSongQuery(text = "") {
  let t = stripDiacritics(text.toLowerCase());

  const removePhrases = [
    "xin chao",
    "hello",
    "hi",
    "toi muon nghe",
    "toi muon nghe bai",
    "tôi muốn nghe",
    "tôi muốn nghe bài",
    "nghe bai hat",
    "nghe bài hát",
    "bai hat",
    "bài hát",
    "nghe nhac",
    "nghe nhạc",
    "phat nhac",
    "phát nhạc",
    "bat nhac",
    "bật nhạc",
    "mo bai",
    "mở bài",
    "em mo bai",
    "em mở bài",
  ];

  for (const p of removePhrases) t = t.replace(p, " ");

  t = t.replace(/\s+/g, " ").trim();
  return t; // query để search iTunes
}

/** Gọi iTunes Search API để tìm nhạc */
async function searchITunes(query) {
  if (!query) return null;

  const url = `https://itunes.apple.com/search?media=music&limit=1&term=${encodeURIComponent(
    query
  )}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn("⚠️ iTunes search failed status:", resp.status);
    return null;
  }

  const data = await resp.json();
  if (!data.results || !data.results.length) return null;

  const r = data.results[0];
  return {
    trackName: r.trackName,
    artistName: r.artistName,
    previewUrl: r.previewUrl, // mp3 30s
    artworkUrl: r.artworkUrl100 || r.artworkUrl60,
  };
}

/* ========= Hàm override label ========= */
function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  const rules = [
    {
      keywords: [
        "nghe bài hát",
        "nghe bai hat",
        "phát nhạc",
        "phat nhac",
        "nghe nhạc",
        "nghe nhac",
        "bật nhạc",
        "bat nhac",
        "mo bai",
        "mở bài",
        "nghe bài",
        "toi muon nghe",
        "tôi muốn nghe",
      ],
      newLabel: "nhac",
    },
    {
      keywords: [
        "qua trái",
        "qua bên trái",
        "di chuyen sang trai",
        "qua trai",
        "ben trai",
        "di ben trai",
      ],
      newLabel: "trai",
    },
    {
      keywords: [
        "qua phải",
        "xoay bên phải",
        "qua bên phải",
        "quay ben phai",
        "qua phai",
        "di ben phai",
      ],
      newLabel: "phai",
    },
    {
      keywords: ["tiến lên", "đi lên", "tien len", "di toi", "di ve phia truoc", "tien toi"],
      newLabel: "tien",
    },
    {
      keywords: ["lui lai", "di lui", "di ve sau", "lùi lại", "ve lại", "lùi"],
      newLabel: "lui",
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((kw) => t.includes(kw))) {
      console.log(
        `🔁 Label override: '${label}' → '${rule.newLabel}' (matched '${rule.keywords[0]}')`
      );
      return rule.newLabel;
    }
  }
  return label;
}

/* ========= Route nhận audio từ video server ========= */
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);
    console.log(
      `🎧 Received audio (${(req.file.buffer.length / 1024).toFixed(1)} KB): ${inputFile}`
    );

    // 🔄 webm → wav
    const wavFile = inputFile.replace(".webm", ".wav");
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .toFormat("wav")
        .on("error", reject)
        .on("end", resolve)
        .save(wavFile);
    });
    console.log(`🎵 Converted to WAV: ${wavFile}`);

    // 1️⃣ STT
    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavFile),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (err) {
      console.error("⚠️ STT error:", err.message);
      return res.status(500).json({ error: "STT failed" });
    }
    console.log("🧠 Transcript:", text);

    // Không có wake word thì chỉ trả transcript
    if (!hasWakeWord(text)) {
      fs.unlinkSync(inputFile);
      fs.unlinkSync(wavFile);
      return res.json({ status: "ok", transcript: text });
    }

    // 3️⃣ Gửi sang Python model
    let label = "unknown";
    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(wavFile));
      const r = await fetch(PYTHON_API, { method: "POST", body: form });
      const j = await r.json();
      label = j.label || "unknown";
    } catch (e) {
      console.warn("⚠️ Python model unreachable:", e.message);
    }

    // 4️⃣ Override label
    const oldLabel = label;
    label = overrideLabelByText(label, text);
    console.log(`🔹 Final Label: ${label} (was ${oldLabel})`);

    let playbackUrl = null;
    let musicMeta = null;
    let replyText = "";

    // 5️⃣ Nếu là nhạc → search iTunes
    if (label === "nhac") {
      const query = extractSongQuery(text) || text;
      console.log("🎼 Music query:", query);

      try {
        musicMeta = await searchITunes(query);
      } catch (e) {
        console.warn("⚠️ iTunes search error:", e.message);
      }

      if (musicMeta && musicMeta.previewUrl) {
        playbackUrl = musicMeta.previewUrl;
        replyText = `Dạ, em mở bài "${musicMeta.trackName}" của ${musicMeta.artistName} cho anh nhé.`;
        console.log("🎧 iTunes hit:", musicMeta);
      }
    }

    // 6️⃣ Nếu không phải nhạc, hoặc search thất bại → dùng TTS như cũ
    if (!playbackUrl) {
      replyText = replyText || "Dạ, em đây ạ! Em sẵn sàng nghe lệnh.";
      const filename = `tts_${Date.now()}.mp3`;
      const outPath = path.join(audioDir, filename);

      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "nova",
        format: "mp3",
        input: replyText,
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);

      const host =
        process.env.PUBLIC_BASE_URL ||
        `https://${process.env.RAILWAY_STATIC_URL || "localhost:" + PORT}`;
      playbackUrl = `${host}/audio/${filename}`;
    }

    // 7️⃣ Publish cho robot
    const payload = {
      audio_url: playbackUrl,
      text: replyText,
      label,
    };
    if (musicMeta) payload.music = musicMeta;

    mqttClient.publish("robot/music", JSON.stringify(payload));
    console.log("📢 Published to robot/music:", payload);

    // 8️⃣ Xoá file tạm
    fs.unlinkSync(inputFile);
    fs.unlinkSync(wavFile);

    // 9️⃣ Trả kết quả cho video server
    res.json({
      status: "ok",
      transcript: text,
      label,
      audio_url: playbackUrl,
      music: musicMeta,
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========= Root route ========= */
app.get("/", (_, res) => res.send("✅ Node.js Audio+AI Server is running!"));

app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
