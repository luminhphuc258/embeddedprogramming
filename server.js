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

app.use(cors());
app.use(express.static("public"));

// ====== API: Receive audio from ESP32 ======
app.post("/api/audio", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  try {
    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ success: false, error: "No audio data received" });
    }

    // ===== 1️⃣ Convert raw input to valid WAV =====
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
    const wav = Buffer.concat([header, audioBuffer]);

    // Save temporary WAV for transcription
    const uploadsDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const wavPath = path.join(uploadsDir, `input_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wav);

    // ===== 2️⃣ Speech-to-Text (Whisper) =====
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "gpt-4o-mini-transcribe",
    });
    const text = transcription.text || "(no text)";
    console.log("🧠 Transcribed:", text);

    // ===== 3️⃣ Text-to-Speech (PCM) =====
    const outputDir = path.join(__dirname, "public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outFile = `response_${Date.now()}.pcm`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "pcm", // raw PCM 24 kHz
      input: text,
    });

    let buffer = Buffer.from(await speech.arrayBuffer());

    // ===== 4️⃣ Convert PCM → 16kHz, 16-bit (for ESP32) =====
    // OpenAI returns 24kHz 32-bit float little-endian samples.
    const srcStep = 6; // 4 bytes (float) × (24/16 = 1.5) ≈ 6 bytes per new sample
    const converted = Buffer.alloc(Math.floor(buffer.length / 1.5));
    let writeIndex = 0;
    for (let i = 0; i < buffer.length; i += srcStep) {
      // Convert float32 [-1.0, 1.0] to int16 little-endian
      if (i + 3 >= buffer.length) break;
      const floatVal = buffer.readFloatLE(i);
      let int16 = Math.max(-1, Math.min(1, floatVal)) * 32767;
      converted.writeInt16LE(int16, writeIndex);
      writeIndex += 2;
    }

    fs.writeFileSync(outPath, converted.slice(0, writeIndex));

    // ===== 5️⃣ Respond with JSON =====
    const fileURL = `https://${req.headers.host}/audio/${outFile}`;
    res.json({
      success: true,
      text,
      audio_url: fileURL,
      sample_rate: 16000,
      format: "pcm16le"
    });

    fs.unlinkSync(wavPath);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Serve generated PCM files =====
app.use("/audio", express.static("public/audio"));

// ===== Health check =====
app.get("/", (req, res) => {
  res.send("✅ ESP32 Audio AI Server (PCM16 @16kHz) running successfully!");
});

// ===== Start server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
