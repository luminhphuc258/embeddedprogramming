// server.js
// Support "phát nhạc" command → play real songs (iTunes)
// npm i express multer openai cors dotenv node-fetch

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ==== Multer setup ====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== Utility: detect language ====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ==== Utility: search music via iTunes ====
async function searchSong(query) {
  try {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error("YOUTUBE_API_KEY missing in .env");

    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(
      query + " official music video"
    )}&key=${key}`;

    const resp = await fetch(searchUrl);
    const data = await resp.json();

    if (data.items && data.items.length > 0) {
      const item = data.items[0];
      const title = item.snippet.title;
      const channel = item.snippet.channelTitle;
      const videoId = item.id.videoId;
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      console.log(` Found: ${title} by ${channel}`);
      return {
        title,
        artist: channel,
        preview: videoUrl,
      };
    } else {
      console.warn(" No results from YouTube");
    }
  } catch (err) {
    console.error("YouTube search error:", err);
  }
  return null;
}


// ==== MAIN HANDLER ====
async function handleAsk(req, res) {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, error: "No audio file uploaded" });

    const wavPath = req.file.path;
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // 1Speech-to-text
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
    });
    const text = transcription.text?.trim() || "(no text)";
    console.log("🧠 Transcribed:", text);

    // 2 Detect language
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // 3 Check if it's a music request
    const lower = text.toLowerCase();
    if (
      lower.includes("phát nhạc") ||
      lower.includes("mở nhạc") ||
      lower.includes("bật nhạc") ||
      lower.includes("play music") ||
      lower.includes("play song")
    ) {
      const songQuery = text.replace(
        /(phát nhạc|mở nhạc|bật nhạc|play music|play song)/gi,
        ""
      ).trim();
      const query = songQuery || "relaxing background music";
      console.log(" Song requested:", query);

      const song = await searchSong(query);
      const title = song?.title || query;
      const artist = song?.artist || "";
      const musicUrl = song?.preview || null;

      // Create TTS notice
      const noticeText =
        finalLang === "vi"
          ? `Đang phát bài ${title}${artist ? " của " + artist : ""}.`
          : `Playing the song ${title}${artist ? " by " + artist : ""}.`;

      const ttsFile = path.join(
        __dirname,
        "public/audio",
        `tts_${Date.now()}.mp3`
      );

      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "alloy" : "verse",
        input: noticeText,
        format: "mp3",
      });

      fs.writeFileSync(ttsFile, Buffer.from(await tts.arrayBuffer()));

      const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const noticeUrl = `${host}/audio/${path.basename(ttsFile)}`;

      return res.json({
        success: true,
        type: "music",
        text: noticeText,
        audio_url: noticeUrl,
        music_url: musicUrl,
        lang: finalLang,
      });
    }

    // 4Otherwise normal chat reply
    const systemPrompt =
      finalLang === "vi"
        ? "Bạn là một cô gái trẻ, thân thiện, nói giọng tự nhiên bằng tiếng Việt."
        : "You are a friendly young woman who speaks natural English.";
    const userPrompt =
      finalLang === "vi"
        ? `Người dùng nói: "${text}". Trả lời thân thiện, ngắn gọn bằng tiếng Việt.`
        : `User said: "${text}". Reply briefly in friendly English.`;

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
    });

    const answer =
      chat.choices?.[0]?.message?.content?.trim() ||
      (finalLang === "vi" ? "Xin chào!" : "Hello!");
    console.log("💬 GPT:", answer);

    // 5Text-to-speech
    const outputDir = path.join(__dirname, "public/audio");
    fs.mkdirSync(outputDir, { recursive: true });
    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      input: answer,
      format: "mp3",
    });
    fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const fileURL = `${host}/audio/${outFile}`;

    res.json({
      success: true,
      type: "chat",
      text: answer,
      lang: finalLang,
      audio_url: fileURL,
    });

    fs.unlinkSync(wavPath);
  } catch (err) {
    console.error(" Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ==== ROUTES ====
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/audio", upload.single("audio"), handleAsk);

app.get("/", (req, res) => {
  res.send(" ESP32 Chatbot Music Server is running fine!");
});

app.listen(PORT, () =>
  console.log(` Server running on port ${PORT}`)
);
