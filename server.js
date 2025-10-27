// =======================
// ESP32 Chatbot + KWS + Music + TTS Server (enhanced + iTunes fix)
// 1️⃣ Send to Python API first for intent label
// 2️⃣ If "music"/"nhac" → use Whisper to extract song name → search iTunes + save MP3
// 3️⃣ Else → OpenAI transcribe + chat + TTS
// =======================

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
import * as mm from "music-metadata";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";

app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ===== Multer setup =====
const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ===== Helper functions =====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ===== Helper: Search iTunes and convert preview to MP3 =====
async function searchItunesAndSave(query) {
  try {
    console.log(`🎶 Searching iTunes for: ${query}`);
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
    );
    if (!resp.ok) throw new Error("iTunes search failed");
    const data = await resp.json();
    if (!data.results?.length) {
      console.warn("⚠️ No iTunes results found.");
      return null;
    }

    const song = data.results[0];
    const previewUrl = song.previewUrl;
    const trackName = song.trackName || "Unknown";
    const artistName = song.artistName || "Unknown Artist";

    const tmpM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
    const outMP3 = tmpM4A.replace(".m4a", ".mp3");

    console.log(`⬇️ Downloading preview: ${trackName} – ${artistName}`);
    const songRes = await fetch(previewUrl);
    const arrayBuffer = await songRes.arrayBuffer();
    fs.writeFileSync(tmpM4A, Buffer.from(arrayBuffer));

    // Convert M4A → MP3
    console.log("🎧 Converting preview to MP3...");
    await new Promise((resolve, reject) =>
      ffmpeg(tmpM4A)
        .audioBitrate("128k")
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(outMP3)
    );

    try {
      fs.unlinkSync(tmpM4A);
    } catch { }

    return {
      title: trackName,
      artist: artistName,
      filename: path.basename(outMP3),
    };
  } catch (err) {
    console.error("❌ iTunes fetch/conversion error:", err.message);
    return null;
  }
}

// ===== MAIN HANDLER =====
app.post("/ask", upload.single("audio"), async (req, res) => {
  const cleanup = () => {
    try {
      if (req.file?.path) fs.unlinkSync(req.file.path);
    } catch { }
  };

  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded", audio_url: null });

    const wavPath = req.file.path;
    console.log(`🎧 Received ${req.file.originalname} (${req.file.size} bytes)`);

    // === Step 1: send to Python API first ===
    console.log("📤 Sending to Python model for classification...");
    let label = "unknown";
    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(wavPath));
      const r = await fetch(PYTHON_API, { method: "POST", body: form });
      const j = await r.json();
      label = j.label || "unknown";
    } catch (e) {
      console.warn("⚠️ Python API unreachable:", e.message);
    }
    console.log("🔹 Label:", label);

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // === Step 2: Music branch ===
    if (label === "music" || label === "nhac") {
      console.log("🎵 Detected 'music' intent → extracting song name...");

      let text = "";
      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(wavPath),
          model: "gpt-4o-mini-transcribe",
        });
        text = (tr.text || "").trim();
      } catch (e) {
        console.error("⚠️ Whisper error:", e.message);
      }

      let songName = "Vietnam top hits";
      try {
        const chat = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Extract only the name of the song mentioned in the user's command. Respond with the song title only, no explanation.",
            },
            {
              role: "user",
              content: `Voice command: "${text}"`,
            },
          ],
        });
        songName = chat.choices?.[0]?.message?.content?.trim() || songName;
      } catch (e) {
        console.error("⚠️ Song name extraction error:", e.message);
      }

      console.log("🎯 Detected song name:", songName);

      try {
        const song = await searchItunesAndSave(songName);
        if (!song) {
          cleanup();
          return res.json({ success: false, type: "music", error: "No song found", audio_url: null });
        }

        cleanup();
        return res.json({
          success: true,
          type: "music",
          label,
          query: songName,
          text: `Playing: ${song.title} – ${song.artist}`,
          audio_url: `${host}/audio/${song.filename}`,
          format: "mp3",
        });
      } catch (err) {
        console.error("❌ Music branch error:", err.message);
        cleanup();
        return res.json({ success: false, type: "music", error: "Music failed", audio_url: null });
      }
    }

    // === Step 3: Chat branch ===
    console.log("💬 Transcribing and chatting...");

    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (e) {
      console.error("⚠️ STT error:", e.message);
    }
    console.log("🧠 Text:", text);

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;

    let answer = finalLang === "vi" ? "Xin chào!" : "Hello!";
    try {
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              finalLang === "vi"
                ? "Bạn là một cô gái trẻ, thân thiện, nói tự nhiên bằng tiếng Việt."
                : "You are a friendly young woman who speaks natural English.",
          },
          {
            role: "user",
            content:
              finalLang === "vi"
                ? `Người dùng nói: "${text}". Trả lời thân thiện, ngắn gọn bằng tiếng Việt.`
                : `User said: "${text}". Reply briefly in friendly English.`,
          },
        ],
      });
      answer = chat.choices?.[0]?.message?.content?.trim() || answer;
    } catch (e) {
      console.error("⚠️ Chat error:", e.message);
    }

    const filename = `response_${Date.now()}.mp3`;
    const outPath = path.join(audioDir, filename);
    try {
      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "nova" : "verse",
        format: "mp3",
        input: answer,
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);
    } catch (e) {
      console.error("⚠️ TTS error:", e.message);
    }

    cleanup();

    return res.json({
      success: true,
      type: "chat",
      label,
      text: answer,
      lang: finalLang,
      audio_url: `${host}/audio/${filename}`,
      format: "mp3",
    });
  } catch (err) {
    console.error("❌ /ask error:", err);
    res.status(500).json({ success: false, error: err.message, audio_url: null });
  }
});

// ===== ROUTES =====
app.get("/", (req, res) =>
  res.send("✅ ESP32 Chatbot + Python Classifier + Music + TTS server is running!")
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
