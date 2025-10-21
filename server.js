// =======================
// ESP32 Chatbot + Music Server (iTunes + OpenAI TTS + Auto Convert to MP3)
// + Robot Status Update (ESP32 polling)
// =======================
// Node 18+
// npm i express cors multer openai node-fetch dotenv fluent-ffmpeg ffmpeg-static

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

// ==== Global System Status ====
let systemStatus = {
  state: "idle",
  message: "Server ready",
  last_update: new Date().toISOString(),
  last_robot_state: "unknown",
};

// ==== Helper: update system status ====
function updateStatus(state, message = "") {
  systemStatus.state = state;
  if (message) systemStatus.message = message;
  systemStatus.last_update = new Date().toISOString();
  console.log(`📡 STATUS: ${state} → ${message}`);
}

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

// ==== Helper: download + convert from iTunes ====
async function getMusicFromItunesAndConvert(query, audioDir) {
  updateStatus("music_search", `Searching iTunes: ${query}`);
  const resp = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
  );
  if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
  const data = await resp.json();
  if (!data.results || data.results.length === 0)
    throw new Error("Không tìm thấy bài hát trên iTunes.");

  const song = data.results[0];
  const res = await fetch(song.previewUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
  fs.writeFileSync(localM4A, buffer);

  const localMP3 = localM4A.replace(".m4a", ".mp3");
  updateStatus("converting", "Converting to MP3...");
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

// ==== ROUTE: Ask (Speech → Chat / Music) ====
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
    const lower = text.toLowerCase();
    // --- Play music ---
    if (
      lower.includes("play") ||
      lower.includes("music") ||
      lower.includes("nhạc") ||
      lower.includes("bật bài") ||
      lower.includes("phát nhạc") ||
      lower.includes("nghe")
    ) {
      const song = await getMusicFromItunesAndConvert(text, audioDir);
      const msg =
        finalLang === "vi"
          ? `Đang phát bài ${song.title} của ${song.artist}.`
          : `Playing ${song.title} by ${song.artist}.`;

      updateStatus("playing", msg);
      return res.json({
        success: true,
        type: "music",
        text: msg,
        url: `/audio/${song.file}`,
      });
    }

    // --- Normal chat ---
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

    fs.unlinkSync(req.file.path);
  } catch (err) {
    updateStatus("error", err.message);
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== ROUTE: Robot sends status ====
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res.status(400).json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ==== ROUTE: ESP32 polls current system status ====
app.get("/status", (_req, res) => res.json(systemStatus));

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Music Server (iTunes → MP3) is running!")
);

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
