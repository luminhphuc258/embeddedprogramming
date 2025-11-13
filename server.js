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
import cors from "cors";              // 👈 THÊM CORS

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
// origin của video server trên Railway
const allowedOrigins = [
  "https://videoserver-videoserver.up.railway.app",
  "http://localhost:8080" // để test local, có thể bỏ
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

// đảm bảo preflight cho route upload_audio
app.options("/upload_audio", cors());

/* ========= Static ========= */
// Cho phép truy cập file âm thanh qua HTTP
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

/* ========= Hàm xác định lại nhãn (label override) ========= */
function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  const rules = [
    {
      keywords: ["bai hat", "nghe nhac", "phat nhac", "bat nhac", "mo bai", "nghe"],
      newLabel: "nhac",
    },
    {
      keywords: ["di chuyen sang trai", "qua trai", "ben trai", "di ben trai"],
      newLabel: "trai",
    },
    {
      keywords: ["quay ben phai", "qua phai", "di ben phai"],
      newLabel: "phai",
    },
    {
      keywords: ["tien len", "di toi", "di ve phia truoc", "tien toi"],
      newLabel: "tien",
    },
    {
      keywords: ["lui lai", "di lui", "di ve sau"],
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

/* ========= Route nhận audio từ Flask / video server ========= */
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

    // 🔄 Chuyển webm → wav để gửi lên OpenAI
    const wavFile = inputFile.replace(".webm", ".wav");
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .toFormat("wav")
        .on("error", reject)
        .on("end", resolve)
        .save(wavFile);
    });
    console.log(`🎵 Converted to WAV: ${wavFile}`);

    // 1️⃣ Speech-to-Text (STT)
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

    // 2️⃣ Nếu không có wake word → chỉ log transcript
    if (!hasWakeWord(text)) {
      fs.unlinkSync(inputFile);
      fs.unlinkSync(wavFile);
      return res.json({ status: "ok", transcript: text });
    }

    // 3️⃣ Gửi sang Python server để phân loại nhãn
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

    // 4️⃣ Override label nếu có từ khóa trong transcript
    const oldLabel = label;
    label = overrideLabelByText(label, text);
    console.log(`🔹 Final Label: ${label} (was ${oldLabel})`);

    // 5️⃣ Sinh phản hồi TTS
    const reply = "Dạ, em đây ạ! Em sẵn sàng nghe lệnh.";
    const filename = `tts_${Date.now()}.mp3`;
    const outPath = path.join(audioDir, filename);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      format: "mp3",
      input: reply,
    });
    const buf = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buf);

    // 6️⃣ Gửi đường dẫn phát âm thanh qua MQTT
    const host =
      process.env.PUBLIC_BASE_URL ||
      `https://${process.env.RAILWAY_STATIC_URL || "localhost:" + PORT}`;
    const audioUrl = `${host}/audio/${filename}`;

    mqttClient.publish(
      "robot/music",
      JSON.stringify({
        audio_url: audioUrl,
        text: reply,
        label,
      })
    );

    console.log(`📢 Published audio to robot/music: ${audioUrl}`);

    // 7️⃣ Xoá file tạm
    fs.unlinkSync(inputFile);
    fs.unlinkSync(wavFile);

    // Trả kết quả cho frontend (video server) dùng để hiển thị transcript
    res.json({ status: "ok", transcript: text, label, audio_url: audioUrl });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========= Root route ========= */
app.get("/", (_, res) => res.send("✅ Node.js Audio+AI Server is running!"));

app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
