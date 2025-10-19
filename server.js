// ===============================
// server.js - ESP32 Chatbot + YouTube Music
// Node 18+  (package.json: { "type": "module" })
// npm i express multer openai cors node-fetch ytdl-core dotenv
// ===============================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fetch from "node-fetch";
import OpenAI from "openai";
import ytdl from "ytdl-core";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

// ==== Create folders ====
["uploads", "public", "public/audio"].forEach((dir) =>
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true })
);

const audioDir = path.join(__dirname, "public/audio");
app.use(cors());
app.use("/audio", express.static(audioDir));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Multer ====
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== Detect Language ====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ==== Search song from YouTube ====
async function searchSong(query) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("Missing YOUTUBE_API_KEY in .env");

    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(
      query + " official music video"
    )}&key=${apiKey}`;

    const resp = await fetch(searchUrl);
    const data = await resp.json();

    if (data.items && data.items.length > 0) {
      const item = data.items[0];
      const title = item.snippet.title;
      const channel = item.snippet.channelTitle;
      const videoId = item.id.videoId;
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      console.log(`🎧 Found: ${title} by ${channel}`);
      return { title, artist: channel, preview: videoUrl };
    }
  } catch (err) {
    console.error("🎵 YouTube search error:", err);
  }
  return null;
}

// ==== Download YouTube audio to local ====
async function downloadYouTubeAudio(videoUrl) {
  try {
    const outFile = `yt_${Date.now()}.mp3`;
    const outPath = path.join(audioDir, outFile);
    const stream = ytdl(videoUrl, { filter: "audioonly", quality: "highestaudio" }).pipe(
      fs.createWriteStream(outPath)
    );

    return await new Promise((resolve, reject) => {
      stream.on("finish", () => resolve(outFile));
      stream.on("error", reject);
    });
  } catch (err) {
    console.error("🎵 Download error:", err);
    return null;
  }
}

// ==== MAIN HANDLER ====
async function handleAsk(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    const filePath = req.file.path;
    console.log(`[ASK] Received ${req.file.originalname} (${req.file.size} bytes)`);

    // 🧠 Speech to text
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });

    const text = stt.text?.trim() || "";
    console.log(`🧠 Transcribed: ${text}`);

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // 🎵 Music request
    const lower = text.toLowerCase();
    if (lower.includes("play song") || lower.includes("phát nhạc") || lower.includes("mở bài")) {
      const query = text.replace(/(play song|phát nhạc|mở bài|bật nhạc)/gi, "").trim();
      console.log(`🎶 Song requested: ${query}`);

      const song = await searchSong(query);
      if (song && song.preview) {
        const outFile = await downloadYouTubeAudio(song.preview);
        const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
        const musicUrl = outFile ? `${host}/audio/${outFile}` : song.preview;

        const ttsText =
          finalLang === "vi"
            ? `Đang phát bài ${song.title} của ${song.artist}.`
            : `Playing the song ${song.title} by ${song.artist}.`;

        const ttsOut = path.join(audioDir, `tts_${Date.now()}.mp3`);
        const tts = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: finalLang === "vi" ? "alloy" : "verse",
          format: "mp3",
          input: ttsText,
        });
        fs.writeFileSync(ttsOut, Buffer.from(await tts.arrayBuffer()));

        try {
          fs.unlinkSync(filePath);
        } catch { }

        return res.json({
          success: true,
          type: "music",
          text: ttsText,
          audio_url: `${host}/audio/${path.basename(ttsOut)}`,
          music_url: musicUrl,
        });
      } else {
        return res.json({
          success: false,
          error: "Không tìm thấy bài hát.",
        });
      }
    }

    // 💬 Chat reply
    const systemPrompt =
      finalLang === "vi"
        ? "Bạn là một cô gái trẻ, thân thiện, nói tiếng Việt tự nhiên."
        : "You are a friendly young woman assistant speaking natural English.";

    const prompt =
      finalLang === "vi"
        ? `Người dùng nói: "${text}". Trả lời ngắn gọn (1–2 câu) bằng tiếng Việt.`
        : `User said: "${text}". Reply briefly (1–2 sentences) in friendly conversational English.`;

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "Hello there!";
    console.log(`💬 Reply: ${answer}`);

    const mp3Name = `resp_${Date.now()}.mp3`;
    const mp3Path = path.join(audioDir, mp3Name);
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      format: "mp3",
      input: answer,
    });
    fs.writeFileSync(mp3Path, Buffer.from(await speech.arrayBuffer()));

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    try {
      fs.unlinkSync(filePath);
    } catch { }

    res.json({
      success: true,
      text: answer,
      audio_url: `${host}/audio/${mp3Name}`,
      lang: finalLang,
      format: "mp3",
    });
  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ==== ROUTES ====
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/ask", upload.single("audio"), handleAsk);

app.get("/", (_, res) =>
  res.send("✅ ESP32 Chatbot + YouTube Music Server is running fine.")
);

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
