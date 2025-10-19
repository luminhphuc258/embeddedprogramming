// =======================
// ESP32 Chatbot + Music Server (iTunes + OpenAI TTS + Auto Convert to MP3)
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
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
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

// ==== Helper: normalize audio → WAV mono 16 kHz (with silence trim + loudness) ====
async function normalizeToWavMono16k(inputPath) {
  const outWav = inputPath.replace(path.extname(inputPath), "_norm.wav");
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([
        "silenceremove=start_periods=1:start_silence=0.2:start_threshold=-45dB",
        "areverse",
        "silenceremove=start_periods=1:start_silence=0.2:start_threshold=-45dB",
        "areverse",
        "loudnorm=I=-19:TP=-2:LRA=7"
      ])
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outWav);
  });
  return outWav;
}

// ==== Helper: download + convert from iTunes ====
async function getMusicFromItunesAndConvert(query, audioDir) {
  console.log(`🎶 Searching iTunes Music for: ${query}`);
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

    // === Download preview (.m4a) ===
    const previewUrl = song.previewUrl;
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
    fs.writeFileSync(localM4A, buffer);

    // === Convert to MP3 ===
    const localMP3 = localM4A.replace(".m4a", ".mp3");
    await new Promise((resolve, reject) => {
      ffmpeg(localM4A)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(localMP3);
    });

    fs.unlinkSync(localM4A); // delete original m4a
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

    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // === 0️⃣ Normalize input audio to WAV mono 16k ===
    const wavPath = await normalizeToWavMono16k(req.file.path);

    // === 1️⃣ Speech-to-text (primary: gpt-4o-transcribe → fallback: whisper-1) ===
    const langHint = "vi"; // ưu tiên tiếng Việt
    const biasPrompt =
      "Ngữ cảnh: trợ lý ảo nói giọng miền Nam, từ vựng: robot, ESP32, I2S, MAX98357A, OLED, cảm biến, iTunes, Bluetooth, phát nhạc, bài hát.";

    let text = "";
    try {
      const stt = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "gpt-4o-mini-transcribe",
        language: langHint,
        prompt: biasPrompt
      });
      text = (stt.text || "").trim();
    } catch (e) {
      console.warn("[STT] gpt-4o-transcribe failed, fallback whisper-1:", e.message);
      const stt2 = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "whisper-1",
        language: langHint,
        prompt: biasPrompt
      });
      text = (stt2.text || "").trim();
    }
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

        // === 4️⃣ Create voice notice (TTS) ===
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
      // === 5️⃣ Normal Chat ===
      const systemViSouth =
        "Bạn là một cô gái trẻ thân thiện, trả lời ngắn gọn bằng tiếng Việt tự nhiên, giọng miền Nam (ấm áp, gần gũi, dùng từ 'mình/bạn', hạn chế từ Hán Việt).";
      const systemEn =
        "You are a friendly young woman speaking natural English, short and casual.";

      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: finalLang === "vi" ? systemViSouth : systemEn,
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

    // cleanup files
    try { fs.unlinkSync(req.file.path); } catch { }
    try { fs.unlinkSync(wavPath); } catch { }
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Music Server (iTunes → MP3) is running!")
);

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
