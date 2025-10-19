// server.js
// Node 18+
// npm i express multer openai cors

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

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
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ==== OpenAI ====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Utility ===
function detectLanguage(text) {
  const hasVietnamese = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasVietnamese && !hasEnglish) return "vi";
  if (hasEnglish && !hasVietnamese) return "en";
  return "mixed";
}

// === Main handler ===
async function handleAsk(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
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
    console.log(`[LANG DETECTED] ${lang}`);

    // 3️⃣ Handle music requests 🎵
    const lower = userText.toLowerCase();
    if (
      lower.includes("phát nhạc") ||
      lower.includes("mở nhạc") ||
      lower.includes("play music") ||
      lower.includes("play song")
    ) {
      const songQuery = userText.replace(/(phát nhạc|mở nhạc|play music|play song)/gi, "").trim();
      const q = songQuery || "relaxing background music";

      console.log("[MUSIC] Request:", q);

      // dùng TTS ngắn gọn thông báo đang phát
      const notice = lang === "vi" ? `Đang phát bài ${q}.` : `Playing the song ${q}.`;

      const ttsNotice = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: lang === "vi" ? "alloy" : "verse",
        input: notice,
      });
      const noticePath = path.join(audioDir, `notice_${Date.now()}.mp3`);
      fs.writeFileSync(noticePath, Buffer.from(await ttsNotice.arrayBuffer()));

      // Ở đây bạn có thể thay bằng API YouTube → mp3 hoặc phát nhạc tĩnh có sẵn
      // Tạm thời phát file nhạc tĩnh (demo)
      const musicFile = path.join(__dirname, "public", "music_demo.mp3");
      if (!fs.existsSync(musicFile)) {
        fs.writeFileSync(musicFile, Buffer.from(await ttsNotice.arrayBuffer())); // fallback
      }

      const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      return res.json({
        success: true,
        text: notice,
        audio_url: `${host}/audio/${path.basename(noticePath)}`,
        music_url: `${host}/music_demo.mp3`,
        type: "music",
      });
    }

    // 4️⃣ Chat reply
    const systemPrompt =
      lang === "vi"
        ? "Bạn là một cô gái trẻ, thân thiện, nói tiếng Việt tự nhiên."
        : "You are a friendly young woman assistant speaking natural English.";

    const prompt =
      lang === "vi"
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
    const answer = chat.choices?.[0]?.message?.content?.trim() || (lang === "vi" ? "Xin chào!" : "Hello!");

    // 5️⃣ Text-to-speech
    const mp3Name = `resp_${Date.now()}.mp3`;
    const mp3Path = path.join(audioDir, mp3Name);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: lang === "vi" ? "alloy" : "verse", // alloy = nữ VN, verse = nữ trẻ EN
      format: "mp3",
      input: answer,
    });
    fs.writeFileSync(mp3Path, Buffer.from(await speech.arrayBuffer()));

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const url = `${host}/audio/${mp3Name}`;

    // Cleanup
    try { fs.unlinkSync(filePath); } catch { }

    res.json({
      success: true,
      text: answer,
      audio_url: url,
      lang,
      format: "mp3",
    });
  } catch (err) {
    console.error("[ASK ERROR]", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// === Routes ===
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/ask", upload.single("audio"), handleAsk);

app.get("/", (_, res) => res.send("OK. Use POST /ask (multipart: audio=<file>)"));

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
