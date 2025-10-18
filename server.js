import express from "express";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 8080;
const HTTP_PORT = 8081; //  HTTP port for ESP32

app.use(cors());
app.use(express.static("public"));

// ===== AUDIO UPLOAD & PROCESSING =====
app.post("/api/audio", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
  try {
    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length)
      return res.status(400).json({ success: false, error: "No audio data received" });

    // Create WAV header
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
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

    // Save WAV file
    const uploads = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
    const wavPath = path.join(uploads, `input_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wav);

    // Transcribe
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "gpt-4o-mini-transcribe",
    });
    const text = transcription.text || "(no text)";
    console.log("Transcribed:", text);

    // TTS
    const outputDir = path.join(__dirname, "public/audio");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outFile = `response_${Date.now()}.mp3`;
    const outPath = path.join(outputDir, outFile);

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    const httpsURL = `https://embeddedprogramming-healtheworldserver.up.railway.app/audio/${outFile}`;
    const httpURL = `http://${req.hostname}:${HTTP_PORT}/audio/${outFile}`; // ✅ HTTP link for ESP32

    res.json({
      success: true,
      text,
      audio_url_https: httpsURL,
      audio_url_http: httpURL
    });

    fs.unlinkSync(wavPath);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Static Files =====
app.use("/audio", express.static("public/audio"));

// ===== Health check =====
app.get("/", (req, res) => res.send("ESP32 Audio AI Server running!"));

// ===== Main HTTPS listener =====
app.listen(PORT, () => console.log(`HTTPS server running on ${PORT}`));

// ===== Extra HTTP listener for ESP32 =====
http.createServer(app).listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP stream server running on port ${HTTP_PORT}`);
});
