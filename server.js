// server.js
// Node 18+  (package.json: { "type": "module" })
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
// Log mọi request để debug
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// Bật JSON parser cho các route không dùng multipart
app.use(express.json({ limit: "10mb" }));

// ==== Thư mục public để phát file mp3 ====
const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

// ==== Multer nhận file từ ESP32 (multipart/form-data, field name: "audio") ====
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.bin")),
});
const upload = multer({ storage });

// ==== OpenAI ====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Utility: phát hiện ngôn ngữ trong text ====
function detectLanguage(text) {
  const hasVietnamese =
    /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasVietnamese && !hasEnglish) return "vi";
  if (hasEnglish && !hasVietnamese) return "en";
  return "mixed";
}

// ==== Handler chính cho /ask và /api/ask ====
async function handleAsk(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file (field name must be 'audio')" });
    }
    console.log(
      `[ASK] file=${req.file.originalname} size=${req.file.size} type=${req.file.mimetype}`
    );

    const filePath = req.file.path;

    // 1️⃣ Speech-to-text
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: process.env.STT_MODEL || "whisper-1",
    });

    const userText = stt.text?.trim() || "";
    console.log("[STT] =>", userText);

    // 2️⃣ Nhận diện ngôn ngữ
    const lang = detectLanguage(userText);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} → using ${finalLang}`);

    // 3️⃣ Tạo phản hồi bằng ChatGPT
    const prompt =
      finalLang === "vi"
        ? `Người dùng nói: "${userText}". Trả lời thân thiện, ngắn gọn (1–2 câu) bằng tiếng Việt tự nhiên.`
        : `User said: "${userText}". Reply briefly in friendly conversational English (1–2 sentences).`;

    const systemPrompt =
      finalLang === "vi"
        ? "Bạn là một cô gái trẻ, nói giọng tự nhiên, thân thiện bằng tiếng Việt."
        : "You are a friendly young woman who speaks casual, natural English.";

    const chat = await openai.chat.completions.create({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.8,
    });

    const answer =
      chat.choices?.[0]?.message?.content?.trim() ||
      (finalLang === "vi" ? "Xin chào!" : "Hello there!");

    console.log("[AI REPLY] =>", answer);

    // 4️⃣ TTS (Text-to-Speech)
    const mp3Name = `resp_${Date.now()}.mp3`;
    const mp3Path = path.join(audioDir, mp3Name);

    const speech = await openai.audio.speech.create({
      model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse", // alloy = nữ VN, verse = nữ EN
      input: answer,
      format: "mp3",
    });

    const buf = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(mp3Path, buf);

    const host = process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`;
    const url = `${host}/audio/${mp3Name}`;

    // Xóa file tạm (upload)
    try {
      fs.unlinkSync(filePath);
    } catch { }

    console.log(`[RESPONSE SENT] => ${url}`);

    // 5️⃣ Gửi kết quả JSON
    res.json({
      success: true,
      text: answer,
      lang: finalLang,
      audio_url: url,
      format: "mp3",
    });
  } catch (err) {
    console.error("[ASK ERROR]", err);
    res
      .status(500)
      .json({ success: false, error: String(err?.message || err) });
  }
}

// ==== Routes ====
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/ask", upload.single("audio"), handleAsk);

app.get("/ask", (_req, res) =>
  res
    .status(405)
    .type("text/plain")
    .send("Use POST /ask (multipart: audio=<file>)")
);

app.get("/", (_req, res) =>
  res.type("text/plain").send("OK. POST /ask (multipart: audio=<file>)")
);

// 404 rõ ràng
app.use((req, res) => {
  res
    .status(404)
    .json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

app.listen(port, () =>
  console.log(`🚀 Server running on port ${port}`)
);
