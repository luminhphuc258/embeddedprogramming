// =======================
// ESP32 Chatbot + Music Server (Whisper STT + DeepSeek Chat + OpenAI TTS + iTunes Music)
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
import FormData from "form-data";
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
  state: "idle", // idle | speaking | music | error
  message: "Server ready",
  last_update: new Date().toISOString(),
  last_robot_state: "unknown",
};

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
  updateStatus("music", `Searching iTunes: ${query}`);
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

  const localMP3 = localM4A.replace(".m4a", ".mp3");
  updateStatus("music", "Converting to MP3...");
  await new Promise((resolve, reject) => {
    ffmpeg(localM4A)
      .toFormat("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(localMP3);
  });
  fs.unlinkSync(localM4A);
  updateStatus("music", "Music ready");

  return {
    title: song.trackName,
    artist: song.artistName,
    file: path.basename(localMP3),
  };
}

// ==== ROUTE: ASK ====
// ==== ROUTE: ASK ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    if (systemStatus.state !== "idle") {
      console.log("--> Server busy, let wait...:", systemStatus.state);
      return res.status(429).json({ success: false, error: "Server busy. Try again later." });
    }

    updateStatus("processing", "Transcribing with Whisper...");

    // 🎧 1️⃣ STT bằng OpenAI Whisper
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      language: "vi",
    });

    const text = stt.text.trim();
    console.log("🎙️ Whisper transcript:", text);

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    const lower = text.toLowerCase();
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // 🎵 2️⃣ MUSIC MODE
    if (
      lower.includes("play") ||
      lower.includes("music") ||
      lower.includes("nhạc") ||
      lower.includes("bật bài") ||
      lower.includes("phát nhạc") ||
      lower.includes("nghe")
    ) {
      const song = await getMusicFromItunesAndConvert(text, audioDir);
      const notice =
        finalLang === "vi"
          ? `Đang phát bài ${song.title} của ${song.artist}.`
          : `Playing ${song.title} by ${song.artist}.`;

      updateStatus("music", notice);

      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "alloy" : "verse",
        format: "mp3",
        input: notice,
      });

      const noticeFile = `tts_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(audioDir, noticeFile), Buffer.from(await tts.arrayBuffer()));

      return res.json({
        success: true,
        type: "music",
        text: notice,
        audio_url: `${host}/audio/${noticeFile}`,
        music_url: `${host}/audio/${song.file}`,
      });
    }

    // 💬 3️⃣ CHAT MODE với Together.ai (Gemma)
    updateStatus("speaking", "Generating reply (Gemma)...");

    const togetherResp = await fetch("https://api.together.xyz/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemma-3n-E4B-it", // 🔥 model bạn chọn
        messages: [
          {
            role: "system",
            content:
              finalLang === "vi"
                ? "Bạn là một cô gái trẻ thân thiện, nói chuyện tự nhiên và dễ thương bằng tiếng Việt."
                : "You are a friendly young woman speaking natural English.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.8,
      }),
    });

    if (!togetherResp.ok) {
      const errText = await togetherResp.text();
      throw new Error(`Together.ai API error: ${errText}`);
    }

    const togetherData = await togetherResp.json();
    const answer =
      togetherData.choices?.[0]?.message?.content?.trim() ||
      "Xin lỗi, mình chưa nghe rõ lắm.";

    console.log("💬 Gemma reply:", answer);

    // 🔊 4️⃣ TTS bằng OpenAI
    updateStatus("speaking", "Generating TTS...");
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      format: "mp3",
      input: answer,
    });

    const filename = `tts_${Date.now()}.mp3`;
    fs.writeFileSync(path.join(audioDir, filename), Buffer.from(await tts.arrayBuffer()));
    updateStatus("speaking", "TTS ready");

    res.json({
      success: true,
      type: "chat",
      text: answer,
      audio_url: `${host}/audio/${filename}`,
    });

    setTimeout(() => updateStatus("idle", "Server ready"), 8000);
    fs.unlinkSync(req.file.path);

  } catch (err) {
    console.error("❌ Error:", err.message);
    updateStatus("error", err.message);
    res.json({ success: false, error: err.message });
    setTimeout(() => updateStatus("idle", "Recovered from error"), 5000);
  }
});


// ==== ROUTE: Robot sends status ====
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res
      .status(400)
      .json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ==== ROUTE: ESP32 polls current system status ====
app.get("/status", (_req, res) => res.json(systemStatus));

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Server (Whisper + DeepSeek + TTS + Music) is running!")
);

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
