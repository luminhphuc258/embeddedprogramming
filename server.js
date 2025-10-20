// =======================
// ESP32 Chatbot + Music Server (iTunes + OpenAI TTS + Auto Convert to MP3)
// Compatible with Arduino Socket.IO v3 client
// =======================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
const { Server } = require("socket.io");

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

// ==== Setup ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.enable("trust proxy");
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

// ==== Helper: Socket.IO emitter ====
let ioRef = null;
function emitStatus(state, extra = {}) {
  if (!ioRef) return;
  console.log(`📡 [SOCKET EMIT] ${state}`, extra);
  ioRef.emit("status", { event: "status", state, ...extra });
}

// ==== Helper: download + convert from iTunes ====
async function getMusicFromItunesAndConvert(query, audioDir) {
  console.log(`🎶 Searching iTunes Music for: ${query}`);
  emitStatus("processing:music_search", { q: query });

  try {
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
    );
    if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
    const data = await resp.json();
    if (!data.results || data.results.length === 0)
      throw new Error("Không tìm thấy bài hát trên iTunes.");

    const song = data.results[0];
    console.log(`🎧 Found: ${song.trackName} - ${song.artistName}`);

    const res = await fetch(song.previewUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
    fs.writeFileSync(localM4A, buffer);

    const localMP3 = localM4A.replace(".m4a", ".mp3");
    emitStatus("processing:convert", { from: "m4a", to: "mp3" });
    await new Promise((resolve, reject) => {
      ffmpeg(localM4A)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(localMP3);
    });

    fs.unlinkSync(localM4A);
    console.log(`🎵 Converted to MP3: ${path.basename(localMP3)}`);

    return {
      title: song.trackName,
      artist: song.artistName,
      file: path.basename(localMP3),
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
      return res.status(400).json({ success: false, error: "No audio file uploaded" });

    emitStatus("processing");
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // === 1️⃣ Speech-to-text ===
    emitStatus("processing:stt");
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe",
    });
    const text = stt.text.trim();
    console.log(`🧠 Transcribed: ${text}`);

    // === 2️⃣ Detect language ===
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // === 3️⃣ Check if user requests music ===
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
        const song = await getMusicFromItunesAndConvert(songQuery || "relaxing music", audioDir);
        const notice =
          finalLang === "vi"
            ? `Đang phát bài ${song.title} của ${song.artist}.`
            : `Playing ${song.title} by ${song.artist}.`;

        emitStatus("speaking:tts", { lang: finalLang });
        const tts = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: finalLang === "vi" ? "alloy" : "verse",
          format: "mp3",
          input: notice,
        });

        const noticeFile = `tts_${Date.now()}.mp3`;
        const noticePath = path.join(audioDir, noticeFile);
        fs.writeFileSync(noticePath, Buffer.from(await tts.arrayBuffer()));

        const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
        emitStatus("speaking", { type: "music" });

        res.json({
          success: true,
          type: "music",
          text: notice,
          audio_url: `${host}/audio/${noticeFile}`,
          music_url: `${host}/audio/${song.file}`,
        });
      } catch (err) {
        emitStatus("error", { message: err.message });
        res.json({
          success: false,
          text:
            finalLang === "vi"
              ? `Không thể phát nhạc: ${err.message}`
              : `Could not play music: ${err.message}`,
        });
      }
    } else {
      // === 5️⃣ Normal Chat ===
      emitStatus("processing:chat");
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

      emitStatus("speaking:tts", { lang: finalLang });
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
      emitStatus("speaking", { type: "chat" });

      res.json({
        success: true,
        type: "chat",
        text: answer,
        audio_url: fileUrl,
      });
    }

    fs.unlinkSync(req.file.path);
  } catch (err) {
    emitStatus("error", { message: err.message });
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    emitStatus("idle");
  }
});

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("ESP32 Chatbot Music Server (iTunes → MP3, ESP32 compatible) is running!")
);

// ==== Start server & Socket.IO ====
const server = app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));

// ✅ Cập nhật để tương thích EIO=3 (Arduino)
const io = new Server(server, {
  cors: { origin: "*" },
  allowEIO3: true,          // ✅ Cho phép Arduino EIO=3
  transports: ["websocket"], // Ưu tiên WebSocket
  pingInterval: 10000,       // Ping server gửi xuống mỗi 10s
  pingTimeout: 40000,        // Client có 40s để phản hồi
});
ioRef = io;

// ==== Socket.IO Logs ====
io.on("connection", (socket) => {
  console.log(`✅ [SOCKET CONNECTED] ID: ${socket.id}`);
  socket.emit("status", { event: "status", state: "hello" });

  socket.on("client_message", (data) => {
    console.log(`💬 [FROM CLIENT ${socket.id}]`, data);
  });

  socket.on("disconnect", (reason) => {
    console.log(`❌ [SOCKET DISCONNECTED] ${socket.id} | Reason: ${reason}`);
  });
});
