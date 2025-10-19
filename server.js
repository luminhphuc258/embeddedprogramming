import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import cors from "cors";
import OpenAI from "openai";

dotenv.config();
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static("public"));

// ===== Multer setup for audio upload =====
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ===== Utility: Detect language =====
function detectLanguage(text) {
  const hasVietnamese =
    /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasVietnamese && !hasEnglish) return "vi";
  if (hasEnglish && !hasVietnamese) return "en";
  return "mixed";
}

// ===== API route =====
app.post("/api/audio", upload.single("audio"), async (req, res) => {
  try {
    const audioFilePath = req.file.path;

    // 1 Transcribe audio to text
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcription.text?.trim() || "";
    console.log("Transcribed Text:", text);

    // 2 Detect language
    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;
    console.log(`[LANG DETECTED] ${lang} -> using ${finalLang}`);

    // 3Prepare response text
    const replyText =
      finalLang === "vi"
        ? `Bạn vừa nói: "${text}".`
        : `You said: "${text}".`;

    // 4Generate TTS in proper language
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: finalLang === "vi" ? "alloy" : "verse",
      input: replyText,
    });

    // 5Save generated audio
    const outputDir = path.resolve("public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filename = `response_${Date.now()}.mp3`;
    const outputPath = path.join(outputDir, filename);
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const fileUrl = `http://${req.hostname}:${PORT}/audio/${filename}`;

    // 6 Send response
    res.json({
      success: true,
      text: replyText,
      audio_url: fileUrl,
      lang: finalLang,
    });

    // optional: delete uploaded input after done
    fs.unlink(audioFilePath, () => { });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
