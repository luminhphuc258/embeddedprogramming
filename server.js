// server.js
// Compatible with ESP32-S3 Chatbot (multipart/form-data upload)
// npm i express multer openai cors dotenv

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ==== Multer setup for ESP32 form upload ====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== Utility: detect language ====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ==== MAIN HANDLER ====
async function handleAsk(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    }

    const wavPath = req.file.path;
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // 1️⃣ Transcribe using Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
    });
    const text = transcription.text?.trim() || "(no text)";
    console.log("🧠 Transcribed:", text);

    // 2️⃣ Detect language
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // 3️⃣ Generate reply via GPT
    const systemPrompt =
      finalLang === "vi"
        ? "Bạn là một cô gái trẻ, thân thiện, nói giọng tự nhiên bằng tiếng Việt."
        : "You are a friendly young woman who speaks natural English.";
    const userPrompt =
      finalLang === "vi"
        ? `Người dùng nói: "${text}". Trả lời thân thiện, ngắn gọn bằng tiếng Việt.`
        : `User said: "${text}". Reply briefly in friendly English.`;

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
    });

    const answer =
      chat.choices?.[0]?.message?.content?.trim() ||
      (finalLang === "vi" ? "Xin chào!" : "Hello!");
    console.log("💬 GPT:", answer);

    // 4️⃣ Text-to-Speech (TTS)
    const outputDir = path.join(__dirname, "public/audio");
    fs.mkdirSync(outputDir, { recursive: true });

    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      input: answer,
      format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const fileURL = `${host}/audio/${outFile}`;

    console.log(`[RESP] ${fileURL}`);

    // 5️⃣ Respond JSON to ESP32
    res.json({
      success: true,
      text: answer,
      lang: finalLang,
      audio_url: fileURL,
      format: "mp3",
    });

    // 6️⃣ Cleanup
    try {
      fs.unlinkSync(wavPath);
    } catch (err) {
      console.warn("⚠️ Cleanup:", err.message);
    }
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ==== ROUTES ====
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/audio", upload.single("audio"), handleAsk); // alias

app.get("/", (req, res) => {
  res.send("✅ ESP32 Chatbot Server is running fine!");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
