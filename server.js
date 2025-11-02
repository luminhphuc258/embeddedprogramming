// server.js  (Node v20+, ESM)
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import cors from "cors";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath);

// ---- basic setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ---- folders
const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

// ---- static
app.use("/audio", express.static(audioDir));

// ---- multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file?.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ---- helpers
function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

async function toMp3Echo(inPath) {
  const outName = `echo_${Date.now()}.mp3`;
  const outPath = path.join(audioDir, outName);

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .noVideo()
      .audioBitrate("128k")
      .toFormat("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });
  return outName;
}

// ---- routes (ECHO only)
app.post("/ask", upload.single("audio"), async (req, res) => {
  const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { } };

  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    console.log(`🎧 ECHO /ask received ${req.file.originalname} (${req.file.size} bytes)`);
    const name = await toMp3Echo(req.file.path);
    cleanup();

    return res.json({
      success: true,
      type: "echo",
      audio_url: `${baseUrl(req)}/audio/${name}`,
      format: "mp3",
    });
  } catch (err) {
    console.error("❌ /ask echo error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/wake", upload.single("audio"), async (req, res) => {
  const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { } };

  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    console.log(`🎧 ECHO /wake received ${req.file.originalname} (${req.file.size} bytes)`);
    const name = await toMp3Echo(req.file.path);
    cleanup();

    return res.json({
      success: true,
      label: "echo",
      audio_url: `${baseUrl(req)}/audio/${name}`,
      format: "mp3",
    });
  } catch (err) {
    console.error("❌ /wake echo error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.send("✅ Echo server is running. POST /ask or /wake with form-data field 'audio'.");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
