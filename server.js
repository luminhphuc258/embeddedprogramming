// ====== ESP32 Chatbot Server with Voice Classification ======
// npm i express multer openai cors dotenv node-fetch itunes-search-api

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import itunes from "itunes-search-api";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";

// ===== Middleware =====
app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ===== Multer setup for ESP32 upload =====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ===== Utility =====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ===== MAIN HANDLER =====
async function handleAsk(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    const wavPath = req.file.path;
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // --- Step 1: Gửi file đến Python API ---
    console.log("🎯 Sending file to Python server for label prediction...");
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath));

    const predictRes = await fetch(PYTHON_API, { method: "POST", body: form });
    const predictData = await predictRes.json();
    console.log("🔹 Prediction result:", predictData);

    let label = predictData.label || "unknown";

    // --- Step 2: Nếu là "nhac" → search nhạc trên iTunes ---
    if (label === "nhac") {
      console.log("🎵 Detected 'nhac' → searching iTunes...");

      const searchResult = await itunes.search({
        term: "Vietnam top hits",
        media: "music",
        limit: 1,
      });

      if (searchResult?.results?.length) {
        const song = searchResult.results[0];
        console.log("✅ Found:", song.trackName, "-", song.artistName);
        return res.json({
          success: true,
          type: "music",
          label,
          song: {
            title: song.trackName,
            artist: song.artistName,
            previewUrl: song.previewUrl,
            artwork: song.artworkUrl100,
          },
        });
      } else {
        return res.json({
          success: true,
          type: "music",
          label,
          message: "No music found",
        });
      }
    }

    // --- Step 3: Nếu không phải "nhac" → gọi OpenAI Chat + TTS ---
    console.log("💬 Sending to OpenAI...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
    });
    const text = transcription.text?.trim() || "(no text)";
    console.log("🧠 Transcribed:", text);

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;

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

    // --- Step 4: Text-to-Speech ---
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

    res.json({
      success: true,
      type: "chat",
      text: answer,
      lang: finalLang,
      audio_url: fileURL,
      format: "mp3",
    });

    // Cleanup temp file
    try {
      fs.unlinkSync(wavPath);
    } catch (err) {
      console.warn("⚠️ Cleanup failed:", err.message);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ===== ROUTES =====
app.post("/ask", upload.single("audio"), handleAsk);
app.get("/", (req, res) => res.send("✅ Chatbot + KWS Server is running fine!"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
