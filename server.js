import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.use(cors());
app.use(express.raw({ type: "audio/*", limit: "10mb" }));
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ==== Utility: phát hiện ngôn ngữ ====
function detectLanguage(text) {
  const hasVietnamese =
    /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasVietnamese && !hasEnglish) return "vi";
  if (hasEnglish && !hasVietnamese) return "en";
  return "mixed";
}

// ===== MAIN API: Receive audio from ESP32 =====
app.post("/api/audio", async (req, res) => {
  try {
    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length) {
      return res
        .status(400)
        .json({ success: false, error: "No audio data received" });
    }

    // 1️⃣ Convert raw PCM → WAV header (16-bit 16 kHz mono)
    const sampleRate = 16000;
    const bitsPerSample = 16;
    const numChannels = 1;
    const dataSize = audioBuffer.length;
    const headerSize = 44;
    const totalSize = dataSize + headerSize - 8;

    const header = Buffer.alloc(headerSize);
    header.write("RIFF", 0);
    header.writeUInt32LE(totalSize, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(
      sampleRate * numChannels * bitsPerSample / 8,
      28
    );
    header.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    const wavData = Buffer.concat([header, audioBuffer]);
    const uploadsDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadsDir))
      fs.mkdirSync(uploadsDir, { recursive: true });

    const wavPath = path.join(uploadsDir, `input_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavData);

    // 2️⃣ Speech-to-Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
    });
    const text = transcription.text?.trim() || "(no text)";
    console.log("🧠 Transcribed:", text);

    // 3️⃣ Phát hiện ngôn ngữ
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // 4️⃣ Chuẩn bị phản hồi text
    const replyPrompt =
      finalLang === "vi"
        ? `Người dùng nói: "${text}". Hãy trả lời thân thiện, tự nhiên, ngắn gọn bằng tiếng Việt (1–2 câu).`
        : `User said: "${text}". Reply briefly in friendly, conversational English (1–2 sentences).`;

    const systemPrompt =
      finalLang === "vi"
        ? "Bạn là một cô gái trẻ, thân thiện, nói giọng tự nhiên bằng tiếng Việt."
        : "You are a friendly young woman who speaks natural English.";

    // 5️⃣ ChatGPT tạo câu trả lời
    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: replyPrompt },
      ],
      temperature: 0.8,
    });

    const answer =
      chat.choices?.[0]?.message?.content?.trim() ||
      (finalLang === "vi" ? "Xin chào!" : "Hello!");
    console.log("💬 GPT:", answer);

    // 6️⃣ Text-to-Speech (TTS)
    const outputDir = path.join(__dirname, "public/audio");
    if (!fs.existsSync(outputDir))
      fs.mkdirSync(outputDir, { recursive: true });

    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      format: "mp3",
      input: answer,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    // 7️⃣ Trả phản hồi cho ESP32
    const fileURL = `http://${req.headers.host}/audio/${outFile}`;
    res.json({
      success: true,
      text: answer,
      lang: finalLang,
      audio_url: fileURL,
      format: "mp3",
    });

    // 8️⃣ Xóa file tạm
    try {
      fs.unlinkSync(wavPath);
    } catch (e) {
      console.warn("⚠️ Cleanup error:", e.message);
    }
  } catch (err) {
    console.error("❌ Server Error:", err);
    res
      .status(500)
      .json({ success: false, error: err.message || "Internal server error" });
  }
});

// ==== Health check ====
app.get("/", (req, res) => {
  res.send("✅ ESP32 Audio AI Server (auto-detect lang) is running fine!");
});

// ==== Start server ====
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
