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

// Middleware
app.use(cors());
app.use(express.raw({ type: "audio/*", limit: "10mb" }));
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ===== MAIN API: Receive audio from ESP32 =====
app.post("/api/audio", async (req, res) => {
  try {
    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ success: false, error: "No audio data received" });
    }

    // 1️⃣ Convert raw buffer → WAV header (16-bit 16 kHz mono)
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
    header.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
    header.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    const wavData = Buffer.concat([header, audioBuffer]);
    const uploadsDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const wavPath = path.join(uploadsDir, `input_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavData);

    // 2️⃣ Speech-to-Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "gpt-4o-mini-transcribe"
    });
    const text = transcription.text || "(no text)";
    console.log("🧠 Transcribed:", text);

    // 3️⃣ Text-to-Speech (WAV 16-bit / 24 kHz)
    const outputDir = path.join(__dirname, "public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outFile = `response_${Date.now()}.wav`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "wav", // ✅ Output as standard WAV
      input: text
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    // 4️⃣ Respond with JSON to ESP32
    const fileURL = `https://${req.headers.host}/audio/${outFile}`;
    res.json({
      success: true,
      text,
      audio_url: fileURL,
      format: "wav",
      sample_rate: 24000
    });

    // 5️⃣ Clean up temp file
    fs.unlinkSync(wavPath);
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ ESP32 Audio AI Server (WAV 24 kHz) is running fine!");
});

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
