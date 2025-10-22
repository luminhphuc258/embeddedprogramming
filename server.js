// =======================
// ESP32 Chatbot + Music Server (iTunes + OpenAI TTS + Auto Convert to MP3)
// + Robot Status Update (ESP32 polling)
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

// ==== Global System Status ====
let systemStatus = {
  state: "idle", // idle | speaking | music | error
  message: "Server ready",
  last_update: new Date().toISOString(),
  last_robot_state: "unknown",
};

// ==== Helper: update system status ====
function updateStatus(state, message = "") {
  systemStatus.state = state;
  if (message) systemStatus.message = message;
  systemStatus.last_update = new Date().toISOString();
  //console.log(`📡 STATUS: ${state} → ${message}`);
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
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .send(JSON.stringify({ success: false, error: "No audio file uploaded" }));

    updateStatus("processing", "Transcribing with DeepSeek...");

    // --- TRANSCRIBE bằng DeepSeek ---
    const deepseekResp = await fetch("https://api.deepseek.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`, // thêm vào file .env
      },
      body: (() => {
        const form = new FormData();
        form.append("model", "deepseek-whisper-large-v2"); // model của DeepSeek hỗ trợ tiếng Việt tốt
        form.append("language", "vi");
        form.append("file", fs.createReadStream(req.file.path));
        return form;
      })(),
    });

    if (!deepseekResp.ok) {
      const errText = await deepseekResp.text();
      throw new Error(`DeepSeek API error: ${deepseekResp.status} ${errText}`);
    }

    const deepseekData = await deepseekResp.json();
    const text = (deepseekData.text || "").trim();

    if (!text) throw new Error("Không nhận được kết quả từ DeepSeek");
    console.log(`=========> Transcription nek: ${text}`);
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    const lower = text.toLowerCase();
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // --- MUSIC MODE ---
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

      res.setHeader("Content-Type", "application/json");
      res.send(
        JSON.stringify({
          success: true,
          type: "music",
          text: notice,
          audio_url: `${host}/audio/${noticeFile}`,
          music_url: `${host}/audio/${song.file}`,
        })
      );

      setTimeout(() => updateStatus("idle", "Server ready"), 10000);
      return;
    }

    // --- CHAT / SPEAKING MODE ---
    updateStatus("speaking", "Generating reply...");
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

    res.setHeader("Content-Type", "application/json");
    res.send(
      JSON.stringify({
        success: true,
        type: "chat",
        text: answer,
        audio_url: `${host}/audio/${filename}`,
      })
    );

    setTimeout(() => updateStatus("idle", "Server ready"), 8000);
    fs.unlinkSync(req.file.path);

  } catch (err) {
    updateStatus("error", err.message);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ success: false, error: err.message }));
    setTimeout(() => updateStatus("idle", "Recovered from error"), 5000);
  }
});


// ==== ROUTE: Robot sends status ====
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res
      .status(400)
      .send(JSON.stringify({ success: false, error: "Missing robot_state" }));

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  //console.log(`🤖 Robot reported: ${robot_state}`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ success: true, message: `State updated: ${robot_state}` }));
});

// ==== ROUTE: ESP32 polls current system status ====
app.get("/status", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(systemStatus));
});

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Music Server (iTunes → MP3) is running and synced with robot!")
);

// ==== ROUTE: Generate Doraemon greeting ====
app.get("/greeting", async (req, res) => {
  try {
    updateStatus("speaking", "Generating Doraemon greeting...");

    const text = "Mình là Doraemon, rất vui được gặp bạn.";
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy", // giọng tự nhiên, nhẹ nhàng
      format: "mp3",
      input: text,
    });

    const filename = `doraemon_greeting_${Date.now()}.mp3`;
    const filePath = path.join(audioDir, filename);
    fs.writeFileSync(filePath, Buffer.from(await tts.arrayBuffer()));

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const audioUrl = `${host}/audio/${filename}`;

    console.log(`🎤 Doraemon greeting generated → ${audioUrl}`);

    updateStatus("speaking", "Doraemon greeting ready");

    res.setHeader("Content-Type", "application/json");
    res.send(
      JSON.stringify({
        success: true,
        type: "greeting",
        text: text,
        audio_url: audioUrl,
      })
    );

    // 8s sau trở lại idle
    setTimeout(() => updateStatus("idle", "Server ready"), 8000);
  } catch (err) {
    console.error("❌ Greeting error:", err);
    updateStatus("error", err.message);
    res.status(500).json({ success: false, error: err.message });
    setTimeout(() => updateStatus("idle", "Recovered from error"), 5000);
  }
});

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
