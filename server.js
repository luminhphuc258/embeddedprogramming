// =======================
// ESP32 Chatbot + Music REST Server
// (OpenAI STT + Chat + TTS + iTunes Music)
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

// ==== Global Status Object ====
let systemStatus = {
  state: "idle",
  last_update: new Date().toISOString(),
  message: "Server ready",
  current_task: "none",
};

// ==== Helper: Update & Log Status ====
function updateStatus(state, message = "") {
  systemStatus = {
    state,
    message: message || systemStatus.message,
    current_task: state,
    last_update: new Date().toISOString(),
  };
  console.log(`📡 STATUS: ${state} → ${message}`);
}

// ==== Helper: Detect language ====
function detectLanguage(text) {
  const hasVN = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEN = /[a-zA-Z]/.test(text);
  if (hasVN && !hasEN) return "vi";
  if (hasEN && !hasVN) return "en";
  return "mixed";
}

// ==== Helper: Download & Convert Music from iTunes ====
async function getMusicFromItunesAndConvert(query) {
  updateStatus("music_search", `Searching song: ${query}`);
  const resp = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
  );
  if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
  const data = await resp.json();
  if (!data.results?.length) throw new Error("Không tìm thấy bài hát trên iTunes.");

  const song = data.results[0];
  const res = await fetch(song.previewUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
  fs.writeFileSync(localM4A, buffer);

  updateStatus("converting", "Converting audio to mp3...");
  const localMP3 = localM4A.replace(".m4a", ".mp3");
  await new Promise((resolve, reject) => {
    ffmpeg(localM4A)
      .toFormat("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(localMP3);
  });
  fs.unlinkSync(localM4A);
  updateStatus("done", "Music ready");
  return {
    title: song.trackName,
    artist: song.artistName,
    file: path.basename(localMP3),
  };
}

// ==== 1️⃣ Polling API for ESP32 ====
app.get("/status", (_req, res) => {
  res.json(systemStatus);
});

// ==== 2️⃣ Audio upload + chat/music ====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded" });

    updateStatus("processing", "Transcribing...");
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe",
    });

    const text = stt.text.trim();
    console.log(`🧠 Transcribed: ${text}`);
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;

    if (
      text.toLowerCase().includes("nhạc") ||
      text.toLowerCase().includes("play") ||
      text.toLowerCase().includes("music")
    ) {
      const song = await getMusicFromItunesAndConvert(text);
      res.json({
        success: true,
        type: "music",
        text:
          finalLang === "vi"
            ? `Đang phát bài ${song.title} của ${song.artist}`
            : `Playing ${song.title} by ${song.artist}`,
        url: `/audio/${song.file}`,
      });
    } else {
      updateStatus("chatting", "Generating reply...");
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

      updateStatus("speaking", "Generating TTS...");
      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "alloy" : "verse",
        format: "mp3",
        input: answer,
      });

      const filename = `tts_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(audioDir, filename), Buffer.from(await tts.arrayBuffer()));
      updateStatus("done", "TTS ready");

      res.json({
        success: true,
        type: "chat",
        text: answer,
        url: `/audio/${filename}`,
      });
    }

    fs.unlinkSync(req.file.path);
  } catch (err) {
    updateStatus("error", err.message);
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== 3️⃣ Health Check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 REST AI Server is running. Use /status or /ask endpoints.")
);
// ==== 2️⃣ Robot update status ====
app.post("/update", express.json(), (req, res) => {
  const { robot_state } = req.body;
  if (!robot_state) {
    return res.status(400).json({ success: false, error: "Missing robot_state" });
  }
  console.log(`🤖 Robot reported state: ${robot_state}`);
  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  res.json({ success: true, message: `State updated: ${robot_state}` });
});


// ==== Start Server ====
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
