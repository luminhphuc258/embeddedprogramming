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

// Enable CORS so your ESP32 can connect
app.use(cors());

// ==========  AUDIO UPLOAD API ==========
app.post("/api/audio", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  try {
    const audioBuffer = req.body;

    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ success: false, error: "No audio data received" });
    }

    // ===== Step 1: Wrap raw PCM into a valid 16-bit WAV =====
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const dataSize = audioBuffer.length;
    const headerSize = 44;
    const totalSize = dataSize + headerSize - 8;

    const wavHeader = Buffer.alloc(headerSize);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(totalSize, 4);
    wavHeader.write("WAVEfmt ", 8);
    wavHeader.writeUInt32LE(16, 16); // Subchunk1Size
    wavHeader.writeUInt16LE(1, 20);  // PCM
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
    wavHeader.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);

    // Save file temporarily
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const wavPath = path.join(uploadDir, `input_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);

    console.log("Audio received and wrapped:", wavPath);

    // ===== Step 2: Transcribe =====
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcription.text || "(no text recognized)";
    console.log("Transcribed Text:", text);

    // ===== Step 3: Generate TTS Audio =====
    const publicDir = path.join(__dirname, "public", "audio");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const outputFile = `response_${Date.now()}.mp3`;
    const outputPath = path.join(publicDir, outputFile);

    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });

    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const fileUrl = `https://embeddedprogramming-healtheworldserver.up.railway.app/audio/${outputFile}`;

    // Clean up input
    fs.unlinkSync(wavPath);

    // Send response back to ESP32
    res.json({
      success: true,
      text,
      audio_url: fileUrl,
    });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve static audio files
app.use(express.static("public"));

// Health check route
app.get("/", (req, res) => {
  res.send("ESP32 Audio AI Server running successfully!");
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
