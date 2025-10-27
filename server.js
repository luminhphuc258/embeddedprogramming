// =======================
// ESP32 Chatbot + KWS + Music + TTS Server (enhanced + keyword correction)
// 1️⃣ Gọi Python API để lấy label sơ bộ
// 2️⃣ Dùng Whisper để transcribe text
// 3️⃣ Nếu text có từ khóa điều khiển → sửa lại label tương ứng
// 4️⃣ Nếu label là [tien, lui, trai, phai, yen] → tạo phản hồi cố định (TTS)
// 5️⃣ Nếu "music"/"nhac" → iTunes flow
// 6️⃣ Các nhãn khác → chat bình thường + TTS
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

// ===== Helper =====
function detectLanguage(text) {
  const hasVi = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ===== MAIN HANDLER =====
app.post("/ask", upload.single("audio"), async (req, res) => {
  const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { } };

  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded", audio_url: null });

    const wavPath = req.file.path;
    console.log(`🎧 Received ${req.file.originalname} (${req.file.size} bytes)`);

    // === Step 1: gọi Python API ===
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
    console.log("🔹 Python label:", label);

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // === Step 2: Music flow ===
    if (label === "music" || label === "nhac") {
      // ... (giữ nguyên toàn bộ phần iTunes ở bản gốc)
    }

    // === Step 3: Transcribe để phân tích từ khóa ===
    console.log("💬 Transcribing audio...");
    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim().toLowerCase();
    } catch (e) {
      console.error("⚠️ STT error:", e.message);
    }
    console.log("🧠 Transcribed text:", text);

    // === Step 4: Keyword correction for label ===
    const keywordMap = {
      tien: ["tien", "tiến", "go forward", "move forward", "đi lên", "tiến lên", "di chuyển lên"],
      lui: ["lui", "đi lui", "back", "go back", "backward", "lui lại"],
      trai: ["trai", "left", "rẽ trái", "turn left", "xoay trái"],
      phai: ["phai", "phải", "right", "rẽ phải", "turn right", "xoay phải"],
      yen: ["dung", "stop", "dừng", "đứng yên", "stay still"]
    };

    for (const [key, keywords] of Object.entries(keywordMap)) {
      if (keywords.some((kw) => text.includes(kw))) {
        console.log(`🔄 Overriding label → "${key}" (keyword detected in text)`);
        label = key;
        break;
      }
    }

    // === Step 5: Control flow ===
    const controlMap = {
      tien: "Dạ rõ sư phụ, đệ tử đang di chuyển lên.",
      lui: "Dạ rõ sư phụ, đệ tử đang di chuyển lùi lại.",
      trai: "Dạ rõ sư phụ, đệ tử đang di chuyển qua trái.",
      phai: "Dạ rõ sư phụ, đệ tử đang di chuyển qua phải.",
      yen: "Dạ rõ sư phụ, đệ tử đang đứng yên.",
    };

    if (label in controlMap) {
      const answer = controlMap[label];
      const filename = `response_${Date.now()}.mp3`;
      const outPath = path.join(audioDir, filename);

      try {
        console.log(`🗣️ Creating control TTS for label: ${label}`);
        const speech = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: "echo", // hoặc "nova" nếu muốn giọng sáng hơn
          format: "mp3",
          input: answer,
        });
        const buf = Buffer.from(await speech.arrayBuffer());
        fs.writeFileSync(outPath, buf);
      } catch (e) {
        console.error("⚠️ TTS error (control branch):", e.message);
      }

      cleanup();
      return res.json({
        success: true,
        type: "chat",
        label,
        text: answer,
        lang: "vi",
        audio_url: `${host}/audio/${filename}`,
        format: "mp3",
      });
    }

    // === Step 6: Chat fallback ===
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
