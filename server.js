// =======================
// ESP32 Chatbot + Music Server (Piped.video + OpenAI TTS)
// =======================
// Node 18+
// npm i express cors multer openai node-fetch dotenv

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ==== Setup ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ==== Directory setup ====
const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "public", "audio");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

// ==== Multer for audio upload ====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });


// ==== Helper: fetch playable audio from piped.video ====
async function getMusicFromPiped(query) {
  console.log(`🎶 Searching music for: ${query}`);
  try {
    // 1️⃣ Search video
    const searchRes = await fetch(`https://pipedapi.kavin.rocks/api/v1/search?q=${encodeURIComponent(query)}`);
    if (!searchRes.ok) throw new Error(`Search failed (${searchRes.status})`);
    const list = await searchRes.json();

    if (!list || !Array.isArray(list) || list.length === 0) {
      throw new Error("Không tìm thấy kết quả nào trên piped.video");
    }

    const video = list.find(v => v.duration < 600) || list[0];
    console.log(`🎵 Found: ${video.title} | Duration: ${video.duration}s`);

    // 2️⃣ Get stream info
    const videoId = video.url.split("watch?v=")[1];
    const streamRes = await fetch(`https://pipedapi.kavin.rocks/api/v1/streams/${videoId}`);
    if (!streamRes.ok) throw new Error(`Stream fetch failed (${streamRes.status})`);
    const streamData = await streamRes.json();

    const audio = streamData.audioStreams?.find(a => a.format === "m4a" || a.format === "mp4");
    if (!audio) throw new Error("Không có audio stream trong kết quả.");

    console.log(`🎧 Audio stream ready: ${audio.quality} | ${audio.mimeType}`);
    return audio.url;
  } catch (err) {
    console.error("❌ [PIPED] Lỗi khi tìm nhạc:", err.message);
    throw new Error("Không tìm thấy hoặc lấy được nhạc.");
  }
}


// ==== MAIN ROUTE ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // === 1️⃣ Speech-to-text ===
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe",
    });
    const text = stt.text.trim();
    console.log(`🧠 Transcribed: ${text}`);

    // === 2️⃣ Detect language ===
    const lang = /[^\x00-\x7F]/.test(text) ? "vi" : "en";
    console.log(`[LANG DETECTED] ${lang} -> using ${lang}`);

    // === 3️⃣ Check for music command ===
    const lower = text.toLowerCase();
    if (lower.includes("play") || lower.includes("nhạc") || lower.includes("music") || lower.includes("phát nhạc") || lower.includes("nghe")) {
      const songQuery = text.replace(/play|phát nhạc|bật bài/gi, "").trim();
      console.log(`🎵 Song requested: ${songQuery}`);

      try {
        const songUrl = await getMusicFromPiped(songQuery);
        console.log(`🎶 Searching music for: ${query}`);
        res.json({
          success: true,
          type: "music",
          text: `Đang phát bài hát: ${songQuery}`,
          audio_url: songUrl,
        });
      } catch (err) {
        res.json({
          success: false,
          text: `Không thể phát bài hát này: ${err.message}`,
        });
      }
    } else {
      // === 4️⃣ Chat with GPT ===
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system", content: lang === "vi"
              ? "Bạn là một cô gái trẻ thân thiện, trả lời ngắn gọn bằng tiếng Việt tự nhiên."
              : "You are a friendly young woman speaking natural English, short and casual."
          },
          { role: "user", content: text },
        ],
        temperature: 0.8,
      });

      const answer = chat.choices[0].message.content.trim();
      console.log(`💬 Answer: ${answer}`);

      // === 5️⃣ Text-to-speech ===
      const filename = `tts_${Date.now()}.mp3`;
      const outputPath = path.join(audioDir, filename);

      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "verse",
        format: "mp3",
        input: answer,
      });

      const buffer = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outputPath, buffer);

      const fileUrl = `https://${req.headers.host}/audio/${filename}`;
      res.json({ success: true, type: "chat", text: answer, audio_url: fileUrl });
    }

    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== Health check ====
app.get("/", (_req, res) => res.send("✅ ESP32 Chatbot Music Server is running!"));

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
