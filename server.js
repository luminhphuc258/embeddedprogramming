// server.js
// Node 18+ / 20+
// npm i express multer openai cors node-fetch p-queue

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import PQueue from "p-queue"; // giới hạn request song song

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ==== Folders ====
const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// ==== Multer upload ====
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== OpenAI ====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Queue (giới hạn xử lý đồng thời để tránh lỗi body used already) ====
const queue = new PQueue({ concurrency: 2 });

// === Utility: phát hiện ngôn ngữ ===
function detectLanguage(text) {
  const hasVietnamese =
    /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasVietnamese && !hasEnglish) return "vi";
  if (hasEnglish && !hasVietnamese) return "en";
  return "mixed";
}

// === Helper: tạo file TTS an toàn ===
async function createSpeechFile({ text, voice, lang }) {
  const speechResp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voice || (lang === "vi" ? "alloy" : "verse"),
    input: text,
    format: "mp3",
  });
  const buffer = Buffer.from(await speechResp.clone().arrayBuffer()); // clone tránh body reuse
  const filePath = path.join(audioDir, `tts_${Date.now()}.mp3`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// === Main handler ===
async function handleAsk(req, res) {
  // Quan trọng: return Promise để Express chờ kết quả
  return queue.add(async () => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No audio file uploaded" });
      }

      const filePath = req.file.path;
      console.log(`[ASK] file=${req.file.originalname} size=${req.file.size}`);

      // 1️⃣ Speech-to-text
      const stt = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
      });
      const userText = stt.text?.trim() || "";
      console.log("[STT] =>", userText);

      // 2️⃣ Detect language
      const lang = detectLanguage(userText);
      const finalLang = lang === "mixed" ? "vi" : lang;
      console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

      // 3️⃣ Handle music requests 🎵
      const lower = userText.toLowerCase();
      if (
        lower.includes("phát nhạc") ||
        lower.includes("mở nhạc") ||
        lower.includes("bật nhạc") ||
        lower.includes("play music") ||
        lower.includes("play song")
      ) {
        const songQuery = userText
          .replace(/(phát nhạc|mở nhạc|bật nhạc|play music|play song)/gi, "")
          .trim();
        const q = songQuery || "relaxing background music";

        console.log("[MUSIC] Request:", q);

        // Thông báo bằng giọng nói
        const notice =
          finalLang === "vi" ? `Đang phát bài ${q}.` : `Playing the song ${q}.`;
        const noticePath = await createSpeechFile({
          text: notice,
          lang: finalLang,
        });

        // 🔎 Tìm bài hát thật qua iTunes Search API
        const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
          q
        )}&media=music&limit=1`;
        let musicUrl = null;
        try {
          const resp = await fetch(searchUrl);
          const data = await resp.json();
          if (data.results && data.results.length > 0) {
            musicUrl = data.results[0].previewUrl; // 30s MP3 link
          }
        } catch (err) {
          console.error("iTunes fetch error:", err);
        }

        const host = process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`;
        if (!musicUrl) musicUrl = `${host}/audio/${path.basename(noticePath)}`;

        console.log("[RESPONSE SENT] => music request");
        return res.json({
          success: true,
          text: notice,
          audio_url: `${host}/audio/${path.basename(noticePath)}`,
          music_url: musicUrl,
          type: "music",
        });
      }

      // 4️⃣ Chat reply
      const systemPrompt =
        finalLang === "vi"
          ? "Bạn là một cô gái trẻ, thân thiện, nói tiếng Việt tự nhiên."
          : "You are a friendly young woman assistant speaking natural English.";

      const prompt =
        finalLang === "vi"
          ? `Người dùng nói: "${userText}". Trả lời ngắn gọn (1–2 câu) bằng tiếng Việt, thân thiện.`
          : `User said: "${userText}". Reply briefly (1–2 sentences) in friendly conversational English.`;

      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      });
      const answer =
        chat.choices?.[0]?.message?.content?.trim() ||
        (finalLang === "vi" ? "Xin chào!" : "Hello!");

      // 5️⃣ Text-to-speech
      const mp3Path = await createSpeechFile({
        text: answer,
        lang: finalLang,
      });

      const host = process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`;
      const url = `${host}/audio/${path.basename(mp3Path)}`;

      try {
        fs.unlinkSync(filePath);
      } catch { }

      console.log("[RESPONSE SENT] => chat reply");
      return res.json({
        success: true,
        text: answer,
        audio_url: url,
        lang: finalLang,
        format: "mp3",
      });
    } catch (err) {
      console.error("[ASK ERROR]", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

// === Routes ===
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/ask", upload.single("audio"), handleAsk);

app.get("/", (_, res) =>
  res.send("✅ OK. Use POST /ask (multipart: audio=<file>)")
);

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
