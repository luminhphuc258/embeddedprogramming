// =======================
// ESP32 Chatbot + Music Server (iTunes Music + OpenAI TTS)
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

// ==== Helper: detect language ====
function detectLanguage(text) {
  const hasVN = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEN = /[a-zA-Z]/.test(text);
  if (hasVN && !hasEN) return "vi";
  if (hasEN && !hasVN) return "en";
  return "mixed";
}

// ==== Helper: fetch song from iTunes and save locally ====
async function getMusicFromItunesAndSave(query, audioDir) {
  console.log(`🎶 Searching iTunes Music for: ${query}`);
  try {
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        query
      )}&media=music&limit=1`
    );
    if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
    const data = await resp.json();
    if (!data.results || data.results.length === 0)
      throw new Error("Không tìm thấy bài hát trên iTunes.");

    const song = data.results[0];
    console.log(`🎧 Found: ${song.trackName} - ${song.artistName}`);

    // === Download preview ===
    const previewUrl = song.previewUrl;
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const localFile = `song_${Date.now()}.m4a`;
    const localPath = path.join(audioDir, localFile);
    fs.writeFileSync(localPath, buffer);

    console.log(`💾 Saved song locally: ${localFile}`);
    return {
      title: song.trackName,
      artist: song.artistName,
      file: localFile,
    };
  } catch (err) {
    console.error("❌ [iTunes] Error:", err.message);
    throw err;
  }
}

// ==== MAIN ROUTE ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, error: "No audio file uploaded" });
    console.log(
      `[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`
    );

    // === 1️⃣ Speech-to-text ===
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
    });
    const text = stt.text.trim();
    console.log(`🧠 Transcribed: ${text}`);

    // === 2️⃣ Detect language ===
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // === 3️⃣ Check for music command ===
    const lower = text.toLowerCase();
    if (
      lower.includes("play") ||
      lower.includes("music") ||
      lower.includes("nhạc") ||
      lower.includes("bật bài") ||
      lower.includes("phát nhạc") ||
      lower.includes("nghe")
    ) {
      const songQuery = text.replace(
        /(play|music|nhạc|bật bài|phát nhạc|nghe)/gi,
        ""
      ).trim();
      console.log(`🎵 Song requested: ${songQuery}`);

      try {
        const song = await getMusicFromItunesAndSave(
          songQuery || "relaxing music",
          audioDir
        );

        // === Tạo TTS thông báo ===
        const notice =
          finalLang === "vi"
            ? `Đang phát bài ${song.title} của ${song.artist}.`
            : `Playing ${song.title} by ${song.artist}.`;

        const tts = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: finalLang === "vi" ? "alloy" : "verse",
          format: "mp3",
          input: notice,
        });

        const noticeFile = `tts_${Date.now()}.mp3`;
        const noticePath = path.join(audioDir, noticeFile);
        fs.writeFileSync(noticePath, Buffer.from(await tts.arrayBuffer()));

        const host =
          process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

        res.json({
          success: true,
          type: "music",
          text: notice,
          audio_url: `${host}/audio/${noticeFile}`,
          music_url: `${host}/audio/${song.file}`,
        });
      } catch (err) {
        res.json({
          success: false,
          text:
            finalLang === "vi"
              ? `Không thể phát nhạc: ${err.message}`
              : `Could not play music: ${err.message}`,
        });
      }
    } else {
      // === 4️⃣ Normal Chat ===
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              finalLang === "vi"
                ? "Bạn là một cô gái trẻ thân thiện, trả lời ngắn gọn bằng tiếng Việt tự nhiên."
                : "You are a friendly young woman speaking natural English, short and casual.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.8,
      });

      const answer = chat.choices[0].message.content.trim();
      console.log(`💬 Answer: ${answer}`);

      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "alloy" : "verse",
        format: "mp3",
        input: answer,
      });

      const filename = `tts_${Date.now()}.mp3`;
      const outputPath = path.join(audioDir, filename);
      fs.writeFileSync(outputPath, Buffer.from(await tts.arrayBuffer()));

      const fileUrl = `https://${req.headers.host}/audio/${filename}`;
      res.json({
        success: true,
        type: "chat",
        text: answer,
        audio_url: fileUrl,
      });
    }

    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Music Server (iTunes local) is running!")
);

// ==== Start server ====
app.listen(port, () =>
  console.log(`🚀 Server listening on port ${port}`)
);
