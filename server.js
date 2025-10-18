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
app.use(express.json());

// Serve file mp3 công khai
const publicDir = path.join(__dirname, "public");
const audioDir = path.join(publicDir, "audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

// Multer nhận file từ ESP32 (multipart/form-data, field name: "audio")
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (_, file, cb) => cb(null, Date.now() + "_" + (file.originalname || "audio.bin")),
});
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
const upload = multer({ storage });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === API chính: ESP32 POST file -> trả về mp3 url ===
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file" });

    const filePath = req.file.path; // đường dẫn file ESP32 upload (wav/pcm)

    // 1) STT (Speech-to-Text)
    // Bạn có thể dùng 'gpt-4o-transcribe' (nếu enable) hoặc 'whisper-1'
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-transcribe",  // nếu tài khoản bạn chưa có, tạm dùng "whisper-1"
      // language: "vi"  // có thể chỉ định
    });

    const userText = stt.text?.trim() || "";
    console.log("[STT] =>", userText);

    // 2) LLM: sinh câu trả lời (ngắn, thân thiện)
    const prompt = `Người dùng hỏi (tiếng Việt): "${userText}"
Trả lời ngắn gọn (1-2 câu), thân thiện.`;

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Bạn là trợ lý hữu ích, trả lời tiếng Việt tự nhiên." },
        { role: "user", content: prompt }
      ],
      temperature: 0.6,
    });
    const answer = chat.choices?.[0]?.message?.content?.trim() || "Xin chào!";

    // 3) TTS: tạo MP3
    const mp3Name = `resp_${Date.now()}.mp3`;
    const mp3Path = path.join(audioDir, mp3Name);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
      input: answer,
    });

    const buf = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(mp3Path, buf);

    // 4) Trả về link HTTPS đến MP3 (Railway sẽ là https://<app>.up.railway.app)
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const url = `${host}/audio/${mp3Name}`;

    // (Tùy chọn) dọn file upload gốc
    try { fs.unlinkSync(filePath); } catch { }

    res.json({ success: true, text: answer, audio_url: url, format: "mp3" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/", (_, res) => res.type("text/plain").send("OK. POST /ask (multipart: audio=<file>)"));
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
