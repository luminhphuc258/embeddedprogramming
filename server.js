// ===== ECHO HELPERS (không AI) =====
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
ffmpeg.setFfmpegPath(ffmpegPath);

// Giả sử đã có:
// const __dirname = path.dirname(fileURLToPath(import.meta.url));
// const uploadsDir = path.join(__dirname, "uploads");
// const audioDir   = path.join(__dirname, "public/audio");

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

// ===== /ask (ECHO) =====
app.post("/ask", upload.single("audio"), async (req, res) => {
  const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { } };
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    console.log(`🎧 ECHO /ask received ${req.file.originalname} (${req.file.size} bytes)`);
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    const mp3Name = await toMp3Echo(req.file.path); // convert file client gửi → mp3
    cleanup();

    return res.json({
      success: true,
      type: "echo",
      audio_url: `${host}/audio/${mp3Name}`,
      format: "mp3"
    });
  } catch (err) {
    console.error("❌ /ask echo error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===== /wake (ECHO) =====
app.post("/wake", upload.single("audio"), async (req, res) => {
  const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { } };
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No audio file uploaded" });

    console.log(`🎧 ECHO /wake received ${req.file.originalname} (${req.file.size} bytes)`);
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    const mp3Name = await toMp3Echo(req.file.path);
    cleanup();

    // label để client biết đây là phản hồi phát lại
    return res.json({
      success: true,
      label: "echo",
      audio_url: `${host}/audio/${mp3Name}`,
      format: "mp3"
    });
  } catch (err) {
    console.error("❌ /wake echo error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
