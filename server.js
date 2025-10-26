// ====== ESP32 Chatbot Server with AI + Voice Command ======
// npm i express multer openai cors dotenv node-fetch form-data

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import FormData from "form-data";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Python voice model API =====
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";

// ===== Middleware =====
app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ===== Multer setup =====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ===== Detect language =====
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
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, error: "No audio file uploaded", audio_url: null });

    const wavPath = req.file.path;
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // --- Step 1: Predict action from Python model ---
    console.log("🎯 Sending file to Python server for label prediction...");
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath));

    let predictData = {};
    try {
      const predictRes = await fetch(PYTHON_API, { method: "POST", body: form });
      predictData = await predictRes.json();
    } catch (e) {
      console.warn("⚠️ Python API not reachable, fallback to 'chat'");
    }

    const label = predictData.label || "unknown";
    console.log("🔹 Prediction result:", label);

    // --- Step 2: If label === 'nhac' → iTunes search ---
    if (label === "nhac") {
      console.log("🎵 Detected 'nhac' → searching iTunes API...");
      const query = "Vietnam top hits";
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
        query
      )}&media=music&limit=1`;

      try {
        const musicRes = await fetch(itunesUrl);
        const musicData = await musicRes.json();

        if (musicData.results && musicData.results.length > 0) {
          const song = musicData.results[0];
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
            audio_url: song.previewUrl || null,
          });
        } else {
          return res.json({
            success: true,
            type: "music",
            label,
            message: "No music found",
            audio_url: null,
          });
        }
      } catch (err) {
        console.error("❌ iTunes search failed:", err.message);
        return res.json({
          success: false,
          type: "music",
          label,
          error: "Music API failed",
          audio_url: null,
        });
      }
    }

    // --- Step 3: Normal chatbot mode ---
    console.log("💬 Sending to OpenAI for chat response...");

    // Whisper transcription
    let text = "(no text)";
    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "whisper-1",
      });
      text = transcription.text?.trim() || text;
    } catch (e) {
      console.error("⚠️ Whisper error:", e.message);
    }
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

    let answer =
      finalLang === "vi" ? "Xin chào!" : "Hello!";

    try {
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
      });
      answer = chat.choices?.[0]?.message?.content?.trim() || answer;
    } catch (err) {
      console.error("⚠️ Chat error:", err.message);
    }

    console.log("💬 GPT:", answer);

    // --- Step 4: Text-to-Speech ---
    const outputDir = path.join(__dirname, "public/audio");
    fs.mkdirSync(outputDir, { recursive: true });

    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    let fileURL = null;
    try {
      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "alloy" : "verse",
        input: answer,
        format: "mp3",
      });

      const buffer = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buffer);

      const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      fileURL = `${host}/audio/${outFile}`;
    } catch (err) {
      console.error("⚠️ TTS error:", err.message);
    }

    res.json({
      success: true,
      type: "chat",
      label,
      text: answer,
      lang: finalLang,
      audio_url: fileURL,
      format: "mp3",
    });

    // --- Cleanup ---
    try {
      fs.unlinkSync(wavPath);
    } catch (err) {
      console.warn("⚠️ Cleanup failed:", err.message);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      audio_url: null,
    });
  }
}

// ===== ROUTES =====
app.post("/ask", upload.single("audio"), handleAsk);
app.get("/", (req, res) =>
  res.send("✅ Chatbot + KWS Server (AI integrated) is running fine!")
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
