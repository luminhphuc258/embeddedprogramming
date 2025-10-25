// server.js
// ESP32 Chatbot + Model Prediction + iTunes Music + GPT Fallback

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import * as tf from "@tensorflow/tfjs";
import wav from "wav-decoder";
import OpenAI from "openai";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== MODEL SETUP ====
const MODEL_DIR = path.join(__dirname, "model_1s");
let model, labels, mean = 0, std = 1;

async function loadModel() {
  const modelPath = `file://${MODEL_DIR}/best.keras`;
  console.log("🔹 Loading model from", modelPath);
  model = await tf.loadLayersModel(modelPath);
  labels = JSON.parse(fs.readFileSync(`${MODEL_DIR}/labels.json`, "utf-8")).classes;
  const stats = JSON.parse(fs.readFileSync(`${MODEL_DIR}/stats.json`, "utf-8"));
  mean = stats.mean || 0;
  std = stats.std || 1;
  console.log("✅ Model loaded with labels:", labels);
}
await loadModel();

// ==== MULTER UPLOAD ====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== WAV -> Tensor ====
async function wavToTensor(filePath) {
  const buffer = fs.readFileSync(filePath);
  const audioData = await wav.decode(buffer);
  const y = Float32Array.from(audioData.channelData[0]).slice(0, 16000); // 1s
  const tensor = tf.tensor(y).reshape([1, y.length, 1]);
  return tensor;
}

// ==== MUSIC SEARCH (iTunes API) ====
async function searchMusicOnItunes(keyword) {
  const query = encodeURIComponent(keyword);
  const res = await fetch(`https://itunes.apple.com/search?term=${query}&limit=1`);
  const data = await res.json();
  if (data.results && data.results.length > 0) {
    const track = data.results[0];
    return {
      title: track.trackName,
      artist: track.artistName,
      previewUrl: track.previewUrl,
      artwork: track.artworkUrl100,
    };
  }
  return null;
}

// ==== MAIN ENDPOINT ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    console.log(`[ASK] Received ${req.file.originalname}`);
    const wavPath = req.file.path;

    // 1️⃣ Predict intent (local model)
    const inputTensor = await wavToTensor(wavPath);
    const logits = model.predict(inputTensor);
    const probs = logits.dataSync();
    const idx = probs.indexOf(Math.max(...probs));
    const predicted = labels[idx];
    const confidence = probs[idx];

    console.log(`🎯 Predicted: ${predicted} (${(confidence * 100).toFixed(2)}%)`);

    // 2 Nếu là "nhac" → tìm nhạc + phát
    if (predicted === "nhac" && confidence > 0.7) {
      const song = await searchMusicOnItunes("Vietnamese pop");
      if (song) {
        console.log("🎵 Found:", song.title);
        return res.json({
          success: true,
          action: "play_music",
          song,
          confidence,
        });
      } else {
        return res.json({ success: true, action: "no_music_found", confidence });
      }
    }

    // 3️⃣ Nếu không phải "nhac" → chuyển sang GPT để trả lời
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
    });
    const text = transcription.text?.trim() || "…";
    console.log("🗣️ Transcribed:", text);

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a friendly female assistant who speaks both English and Vietnamese naturally." },
        { role: "user", content: text },
      ],
      temperature: 0.8,
    });

    const answer = chat.choices[0]?.message?.content || "Xin chào!";
    console.log("💬 GPT:", answer);

    // 4️⃣ Convert to speech
    const outputDir = path.join(__dirname, "public/audio");
    fs.mkdirSync(outputDir, { recursive: true });
    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: answer,
      format: "mp3",
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const audioUrl = `${host}/audio/${outFile}`;

    res.json({
      success: true,
      action: "chat",
      text: answer,
      audio_url: audioUrl,
      confidence,
    });

    fs.unlinkSync(wavPath);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== TEST ROUTE ====
app.get("/", (_, res) => res.send("✅ ESP32 + Model + GPT server running on Railway!"));

app.listen(PORT, () => console.log(`🚀 Server ready on port ${PORT}`));
