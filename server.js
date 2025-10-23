// =======================
// ESP32 Chatbot + Music Server (DeepSeek STT + Together Chat + OpenAI TTS + iTunes Music)
// =======================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import * as mm from "music-metadata";
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
  state: "idle", // idle | speaking | music | error | processing
  message: "Server ready",
  last_update: new Date().toISOString(),
  last_robot_state: "unknown",
};

function updateStatus(state, message = "") {
  systemStatus.state = state;
  if (message) systemStatus.message = message;
  systemStatus.last_update = new Date().toISOString();
  console.log(`STATUS: ${state} → ${message}`);
}

// ==== Together.ai chat ====
async function callChatCompletion(user_promp, finalLang = "vi") {
  updateStatus("processing", "Generating reply (Gemma)...");
  if (!user_promp || user_promp.trim() === "" || user_promp.length > 1000 || user_promp.length < 3) {
    updateStatus("error", "Yêu cầu không rõ ràng hoặc quá dài/ngắn.");
    return null;
  }
  const resp = await fetch("https://api.together.xyz/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemma-3n-E4B-it",
      messages: [
        {
          role: "system",
          content:
            finalLang === "vi"
              ? "Bạn là doremon robot, nói chuyện thân thiện bằng tiếng Việt."
              : "You are a robot speaking natural English.",
        },
        { role: "user", content: user_promp },
      ],
      temperature: 0.8,
    }),
  });
  return resp;
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

// ==== Audio duration ====
async function getAudioDuration(filePath) {
  try {
    const metadata = await mm.parseFile(filePath);
    const duration = metadata.format.duration || 0;
    console.log(`=== > Thời lượng audio: ${duration}s`);
    return Math.floor(duration * 1000);
  } catch (err) {
    console.error("Lỗi khi đọc file âm thanh:", err.message);
    updateStatus("error", "Lỗi khi đọc file âm thanh.");
    return 0;
  }
}

// ==== iTunes download & convert ====
async function getMusicFromItunesAndConvert(query, audioDir) {
  updateStatus("music", `Searching iTunes: ${query}`);
  const resp = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
  );
  if (!resp.ok) {
    console.error("Lỗi khi tìm kiếm bài hát trên iTunes.");
    updateStatus("error", "Lỗi khi tìm kiếm bài hát trên iTunes.");
    return { title: "", artist: "", file: "", success: false };
  }

  const data = await resp.json();
  if (!data.results?.length) return { title: "", artist: "", file: "", success: false };

  const song = data.results[0];
  const res = await fetch(song.previewUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
  fs.writeFileSync(localM4A, buffer);

  const localMP3 = localM4A.replace(".m4a", ".mp3");
  updateStatus("music", "Converting to MP3...");
  await new Promise((resolve, reject) => {
    ffmpeg(localM4A).toFormat("mp3").on("end", resolve).on("error", reject).save(localMP3);
  });
  fs.unlinkSync(localM4A);
  updateStatus("music", "Music ready");

  return {
    title: song.trackName,
    artist: song.artistName,
    file: path.basename(localMP3),
    success: true,
  };
}

/* =========================
   DeepSeek Speech-to-Text
   ========================= */
async function transcribeAudioWithDeepSeek(filePath, lang = "vi") {
  // You can override URL/model via env if DeepSeek uses a different path/model name.
  const url = process.env.DEEPSEEK_STT_URL || "https://api.deepseek.com/audio/transcriptions";
  const model = process.env.DEEPSEEK_STT_MODEL || "whisper-large-v3";

  // FormData & ReadStream
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", model);
  if (lang) form.append("language", lang);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      // DO NOT set Content-Type explicitly for multipart; let fetch set boundary
    },
    body: form,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`DeepSeek STT failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  // Try common fields that providers use
  const text = data.text || data.transcript || data.result || "";
  return (text || "").trim();
}

// ==== ROUTE: ASK ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    if (systemStatus.state !== "idle") {
      console.log("--> Server busy, let wait...:", systemStatus.state);
      return res.status(429).json({ success: false, error: "Server busy. Try again later." });
    }

    updateStatus("processing", "Transcribing with DeepSeek...");

    // STT (DeepSeek)
    let text = "";
    try {
      text = await transcribeAudioWithDeepSeek(req.file.path, "vi");
    } catch (e) {
      console.error(e.message);
      updateStatus("error", "DeepSeek STT failed");
      try { fs.unlinkSync(req.file.path); } catch { }
      return res.json({ success: false, error: "Transcribe lỗi: " + e.message });
    }

    console.log("🎙️ DeepSeek transcript:", text);

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    const lower = text.toLowerCase();
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // Music mode
    if (
      lower.includes("play") ||
      lower.includes("music") ||
      lower.includes("nhạc") ||
      lower.includes("bật bài") ||
      lower.includes("phát nhạc") ||
      lower.includes("nghe nhạc") ||
      lower.includes("cho tôi nghe") ||
      lower.includes("mở bài") ||
      lower.includes("mở nhạc")
    ) {
      const song = await getMusicFromItunesAndConvert(text, audioDir);
      if (!song.success) {
        updateStatus("idle", "Server ready");
        try { fs.unlinkSync(req.file.path); } catch { }
        return res.json({ success: false, error: "Không tìm thấy bài hát phù hợp." });
      }

      const notice =
        finalLang === "vi"
          ? `Đang phát: ${song.title} – ${song.artist}`
          : `Playing: ${song.title} – ${song.artist}`;

      const musicPath = path.join(audioDir, song.file);
      const musicDuration = await getAudioDuration(musicPath);
      setTimeout(() => updateStatus("idle", "Server ready"), musicDuration + 1000);

      try { fs.unlinkSync(req.file.path); } catch { }

      return res.json({
        success: true,
        type: "music",
        text: notice,
        audio_url: `${host}/audio/${song.file}`,
        music_url: `${host}/audio/${song.file}`,
      });
    }

    // Chat mode
    const togetherResp = await callChatCompletion(text, finalLang);
    if (!togetherResp || !togetherResp.ok) {
      const errText = togetherResp ? await togetherResp.text() : "No response";
      console.error("Together error:", errText);
      updateStatus("error", "Chat generation failed");
      try { fs.unlinkSync(req.file.path); } catch { }
      return res.json({ success: false, error: "Xin lỗi, máy bận. Hãy thử lại." });
    }

    const togetherData = await togetherResp.json();
    const answer =
      togetherData.choices?.[0]?.message?.content?.trim() ||
      (finalLang === "vi" ? "Xin lỗi, mình chưa nghe rõ lắm." : "Sorry, I didn’t catch that.");

    console.log("Gemma reply:", answer);

    // TTS (OpenAI)
    updateStatus("speaking", "Generating TTS...");
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "sage",
      format: "mp3",
      input: answer,
    });

    const stamp = Date.now();
    const filename = `tts_${stamp}.mp3`;
    const ttsPath = path.join(audioDir, filename);
    fs.writeFileSync(ttsPath, Buffer.from(await tts.arrayBuffer()));
    updateStatus("speaking", "TTS ready");

    try { fs.unlinkSync(req.file.path); } catch { }

    const duration = await getAudioDuration(ttsPath);
    setTimeout(() => updateStatus("idle", "Server ready"), duration + 1000);

    return res.json({
      success: true,
      type: "chat",
      text: answer,
      audio_url: `${host}/audio/${filename}`,
    });
  } catch (err) {
    console.error("Error happening /ask:", err);
    updateStatus("error", err.message);
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { }
    res.json({ success: false, error: err.message });
    setTimeout(() => updateStatus("idle", "Recovered from error"), 2000);
  }
});

// ==== Robot status ====
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res.status(400).json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ==== Poll status ====
app.get("/status", (_req, res) => res.json(systemStatus));

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Server (DeepSeek STT + Together Chat + TTS + Music) is running!")
);

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
