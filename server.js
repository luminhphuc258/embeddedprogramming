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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 8080;

// Enable CORS for ESP32
app.use(cors());

// Handle raw binary audio upload
app.post("/api/audio", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  try {
    const audioBuffer = req.body;

    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ success: false, error: "No audio data received" });
    }

    // Save raw audio data to a temp file
    const inputDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });

    const inputPath = path.join(inputDir, `input_${Date.now()}.wav`);
    fs.writeFileSync(inputPath, audioBuffer);

    console.log("Audio file received:", inputPath);

    // === Step 1: Transcribe audio ===
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(inputPath),
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcription.text;
    console.log(" Transcribed Text:", text);

    // === Step 2: Generate speech ===
    const outputDir = path.join(__dirname, "public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = `response_${Date.now()}.mp3`;
    const outputPath = path.join(outputDir, outputFile);

    const speechResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });

    const buffer = Buffer.from(await speechResponse.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const fileUrl = `https://${process.env.RAILWAY_STATIC_URL || "embeddedprogramming-healtheworldserver.up.railway.app"}/audio/${outputFile}`;

    // Optional cleanup of uploaded temp file
    fs.unlinkSync(inputPath);

    res.json({
      success: true,
      text,
      audio_url: fileUrl,
    });

  } catch (error) {
    console.error("Error processing audio:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve static audio files
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("ESP32 Audio AI Server running!");
});

app.listen(PORT, () => console.log(` Server running on port ${PORT}`));
