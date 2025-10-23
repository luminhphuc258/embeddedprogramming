// =======================
// ESP32 Audio Server with Voice Enhancement
// - /ask: receive audio, enhance quality, return URLs for original + enhanced
// - /uploads: serve uploaded files
// - /status, /update, / (healthcheck)
// =======================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import * as mm from "music-metadata";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

// ---- Setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 8080;
ffmpeg.setFfmpegPath(ffmpegPath);

// ---- Middleware
app.enable("trust proxy");
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // if you have static assets

// ---- Directories
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded audio files
app.use("/uploads", express.static(uploadsDir));

// ---- Status tracking
let systemStatus = {
  state: "idle", // idle | processing | error
  message: "Server ready",
  last_update: new Date().toISOString(),
  last_robot_state: "unknown",
};

function updateStatus(state, message = "") {
  systemStatus.state = state;
  if (message) systemStatus.message = message;
  systemStatus.last_update = new Date().toISOString();
  console.log(`STATUS: ${state} → ${message}`);
}

// ---- Helpers
function scheduleDelete(filePath, ms = 30 * 60 * 1000) {
  setTimeout(() => {
    fs.promises.unlink(filePath).catch(() => { });
  }, ms);
}

/**
 * Enhance voice quality using FFmpeg filters
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<string>} - Enhanced file path
 */
async function enhanceAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilter([
        "highpass=f=200",   // remove rumble
        "lowpass=f=3000",   // reduce hiss
        "acompressor=threshold=-20dB:ratio=3:attack=200:release=1000", // smooth dynamics
        "loudnorm",          // normalize
        "volume=1.3"         // slight volume boost
      ])
      .audioCodec("pcm_s16le")
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

// ---- Multer upload config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

// ==== ROUTE: /ask ====
// Upload audio → Enhance → Return URLs
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    }

    updateStatus("processing", "Enhancing uploaded audio");

    const inputFile = req.file.path;
    const enhancedFile = inputFile.replace(/\.(\w+)$/, "_enhanced.wav");

    // 🎧 Enhance the audio
    await enhanceAudio(inputFile, enhancedFile);

    // Get URLs for both files
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = process.env.PUBLIC_BASE_URL || `${proto}://${req.headers.host}`;
    const originalUrl = `${host}/uploads/${path.basename(inputFile)}`;
    const enhancedUrl = `${host}/uploads/${path.basename(enhancedFile)}`;

    // Get metadata
    let durationMs = 0;
    try {
      const meta = await mm.parseFile(enhancedFile);
      durationMs = Math.round((meta.format.duration || 0) * 1000);
    } catch (_) { }

    // Auto-delete after 30 minutes
    scheduleDelete(inputFile);
    scheduleDelete(enhancedFile);

    updateStatus("idle", "Audio enhancement complete");

    return res.json({
      success: true,
      message: "Audio enhanced successfully.",
      original_audio_url: originalUrl,
      enhanced_audio_url: enhancedUrl,
      enhanced_filename: path.basename(enhancedFile),
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      duration_ms: durationMs
    });
  } catch (err) {
    console.error("Enhance /ask error:", err);
    updateStatus("error", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Robot status
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res.status(400).json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ---- Poll status
app.get("/status", (_req, res) => res.json(systemStatus));

// ==== ROUTE: /stream ====
// Stream any enhanced audio file by filename
app.get("/stream", async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) {
      return res.status(400).json({ success: false, error: "Missing ?file parameter" });
    }

    const filePath = path.join(uploadsDir, path.basename(file));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // ---- Stream with partial content (for browser / audio tag compatibility)
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "audio/wav",
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "audio/wav",
      });
      fs.createReadStream(filePath).pipe(res);
    }

    console.log(`🎧 Streaming file: ${file}`);
  } catch (err) {
    console.error("Stream error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---- Health check
app.get("/", (_req, res) => res.send("✅ ESP32 Audio Server is running with voice enhancement!"));

// ---- Start server
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
