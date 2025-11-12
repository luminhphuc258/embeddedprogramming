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

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });

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
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

function hasWakeWord(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  return /(xin chao|hello|hi|nghe|doremon|lily|pipi|bibi)/.test(t);
}

/* ========= Route nhận audio từ Flask client ========= */
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);
    console.log(`🎧 Received audio (${(req.file.buffer.length / 1024).toFixed(1)} KB): ${inputFile}`);

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

    // 1️⃣ Speech-to-Text (STT) qua OpenAI
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

    // 2️⃣ Nếu không có wake word thì chỉ trả transcript
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
    console.log("🔹 Label:", label);

    // 4️⃣ Sinh phản hồi TTS
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

    // 5️⃣ Gửi đường dẫn phát âm thanh qua MQTT
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

    // 6️⃣ Xoá file tạm
    fs.unlinkSync(inputFile);
    fs.unlinkSync(wavFile);

    res.json({ status: "ok", transcript: text, label, audio_url: audioUrl });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========= Root route ========= */
app.get("/", (_, res) => res.send("✅ Node.js Audio+AI Server is running!"));

app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
