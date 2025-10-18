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

// ===== API route =====
app.post("/api/audio", upload.single("audio"), async (req, res) => {
  try {
    const audioFilePath = req.file.path;

    // Step 1: Transcribe audio to text
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcription.text;
    console.log("Transcribed Text:", text);

    // Step 2: Generate audio response (TTS)
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy", // options: alloy, verse, etc.
      input: text,
    });

    // Step 3: Save generated audio
    const outputDir = path.resolve("public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filename = `response_${Date.now()}.mp3`;
    const outputPath = path.join(outputDir, filename);
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const fileUrl = `http://${req.hostname}:${PORT}/audio/${filename}`;

    res.json({
      success: true,
      text,
      audio_url: fileUrl,
    });

    // optional: delete uploaded input after done
    fs.unlink(audioFilePath, () => { });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
