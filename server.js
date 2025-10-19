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
// Log mọi request để debug 404/prefix
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// Chỉ bật JSON parser cho route không dùng multipart
app.use(express.json({ limit: "10mb" }));

// Serve file mp3 công khai
const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

// Multer nhận file từ ESP32 (multipart/form-data, field name: "audio")
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file.originalname || "audio.bin")),
});
const upload = multer({ storage });

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Một handler dùng chung cho /ask và /api/ask
// --- English + young female voice version ---
async function handleAsk(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file (field name must be 'audio')" });
    }
    console.log(`[ASK] file=${req.file.originalname} size=${req.file.size} type=${req.file.mimetype}`);

    const filePath = req.file.path;

    // 1️⃣ Speech-to-text (convert voice to English text)
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: process.env.STT_MODEL || "whisper-1",
      language: "en", // Force English output
    });
    const userText = stt.text?.trim() || "";
    console.log("[STT] =>", userText);

    // 2️⃣ ChatGPT: English short friendly reply
    const prompt = `User said: "${userText}". 
Answer briefly in friendly, conversational English (1–2 sentences).`;

    const chat = await openai.chat.completions.create({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a friendly young woman assistant who speaks natural, casual English." },
        { role: "user", content: prompt },
      ],
      temperature: 0.8,
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "Hello there!";

    // 3️⃣ Text-to-speech (TTS)
    const mp3Name = `resp_${Date.now()}.mp3`;
    const mp3Path = path.join(audioDir, mp3Name);

    const speech = await openai.audio.speech.create({
      model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.TTS_VOICE || "verse", // “verse” = young female; can try "alloy", "ember", "sage"
      format: "mp3",
      input: answer,
    });

    const buf = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(mp3Path, buf);

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const url = `${host}/audio/${mp3Name}`;

    try { fs.unlinkSync(filePath); } catch { }

    res.json({ success: true, text: answer, audio_url: url, format: "mp3" });
  } catch (err) {
    console.error("[ASK] error:", err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}


// Chấp nhận cả /ask và /api/ask (để phòng proxy thêm prefix)
app.post("/ask", upload.single("audio"), handleAsk);
app.post("/api/ask", upload.single("audio"), handleAsk);

// GET vào /ask → báo rõ method
app.get("/ask", (_req, res) => res.status(405).type("text/plain").send("Use POST /ask (multipart: audio=<file>)"));

app.get("/", (_req, res) => res.type("text/plain").send("OK. POST /ask (multipart: audio=<file>)"));

app.use((req, res) => {
  // 404 rõ ràng
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
