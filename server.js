// =======================
// ESP32 Chatbot + KWS + Vietnamese Music + TTS Server
// - Trim silence (ffmpeg)
// - Keyword "nhac" override
// - iTunes VN only (country=vn, entity=song)
// =======================

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import FormData from "form-data";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import * as mm from "music-metadata";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PYTHON_API = "https://mylocalpythonserver-mypythonserver.up.railway.app/predict";

app.use(cors());
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// ===== Multer setup =====
const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) =>
    cb(null, Date.now() + "_" + (file?.originalname || "audio.wav")),
});
const upload = multer({ storage });

// ===== Helper: language detection =====
function detectLanguage(text) {
  const hasVi =
    /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEn = /[a-zA-Z]/.test(text);
  if (hasVi && !hasEn) return "vi";
  if (hasEn && !hasVi) return "en";
  return "mixed";
}

// ===== Helper: detect Vietnamese diacritics =====
const VI_DIACRITIC_RE =
  /[ĂÂÊÔƠƯĐáàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴđ]/;
function hasVietnamese(text = "") {
  return VI_DIACRITIC_RE.test(String(text).normalize("NFC"));
}

// ===== Helper: Trim leading/trailing silence with ffmpeg =====
async function trimSilence(inputPath) {
  const ext = path.extname(inputPath) || ".wav";
  const outPath = inputPath.replace(ext, `_nosil${ext}`);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioFilters([
          // cắt im lặng đầu/cuối: ngưỡng -45 dB, tối thiểu 0.15s
          "silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB:stop_periods=1:stop_duration=0.15:stop_threshold=-45dB",
          // bỏ ồn thấp/DC
          "highpass=f=60",
        ])
        .on("end", resolve)
        .on("error", reject)
        .save(outPath);
    });

    const meta = await mm.parseFile(outPath).catch(() => null);
    if (!meta || !meta.format?.duration || meta.format.duration < 0.25) {
      try { fs.unlinkSync(outPath); } catch { }
      return { path: inputPath, trimmed: null };
    }
    return { path: outPath, trimmed: outPath };
  } catch (e) {
    console.warn("⚠️ trimSilence error:", e.message);
    return { path: inputPath, trimmed: null };
  }
}

// ===== Helper: Search iTunes (VN) and convert preview to MP3 =====
async function searchItunesAndSave(query) {
  try {
    const url =
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}` +
      `&media=music&entity=song&country=vn&limit=10`;

    console.log(`🎶 Searching iTunes (VN) for: ${query}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("iTunes search failed");

    const data = await resp.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      console.warn("⚠️ No iTunes results found (VN).");
      return null;
    }

    // Ưu tiên kết quả có dấu và có previewUrl
    let pick =
      results.find(
        (r) =>
          r.previewUrl &&
          (hasVietnamese(r.trackName) ||
            hasVietnamese(r.artistName) ||
            hasVietnamese(r.collectionName))
      ) ||
      results.find((r) => r.previewUrl) ||
      null;

    if (!pick || !pick.previewUrl) {
      console.warn("⚠️ No previewUrl in VN results.");
      return null;
    }

    const previewUrl = pick.previewUrl;
    const trackName = pick.trackName || "Unknown";
    const artistName = pick.artistName || "Unknown Artist";

    const tmpM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
    const outMP3 = tmpM4A.replace(".m4a", ".mp3");

    console.log(`⬇️ Downloading preview: ${trackName} – ${artistName}`);
    const songRes = await fetch(previewUrl);
    const arrayBuffer = await songRes.arrayBuffer();
    fs.writeFileSync(tmpM4A, Buffer.from(arrayBuffer));

    console.log("🎧 Converting preview to MP3...");
    await new Promise((resolve, reject) =>
      ffmpeg(tmpM4A)
        .audioBitrate("128k")
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(outMP3)
    );

    try { fs.unlinkSync(tmpM4A); } catch { }

    return {
      title: trackName,
      artist: artistName,
      filename: path.basename(outMP3),
    };
  } catch (err) {
    console.error("❌ iTunes VN fetch/conversion error:", err.message);
    return null;
  }
}

// ===== MAIN HANDLER =====
app.post("/ask", upload.single("audio"), async (req, res) => {
  let tmpTrim = null; // để thu dọn file tạm (sau trim)

  const cleanup = () => {
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      if (tmpTrim && fs.existsSync(tmpTrim)) fs.unlinkSync(tmpTrim);
    } catch { }
  };

  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded", audio_url: null });

    const wavPath = req.file.path;
    console.log(`🎧 Received ${req.file.originalname} (${req.file.size} bytes)`);

    // 0) Trim silence (dùng file đã cắt cho tất cả các bước sau)
    const { path: procPath, trimmed } = await trimSilence(wavPath);
    tmpTrim = trimmed;
    if (trimmed) console.log(`✂️  Trimmed silence -> ${trimmed}`);

    // 1) Gửi Python để phân loại nhanh
    console.log("📤 Sending to Python model for classification...");
    let label = "unknown";
    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(procPath));
      const r = await fetch(PYTHON_API, { method: "POST", body: form });
      const j = await r.json();
      label = j.label || "unknown";
    } catch (e) {
      console.warn("⚠️ Python API unreachable:", e.message);
    }
    console.log("🔹 Initial label:", label);

    // 2) STT (dùng file đã cắt)
    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(procPath),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (e) {
      console.error("⚠️ STT error:", e.message);
    }
    console.log("🧠 Transcribed text:", text);

    // 3) Keyword override → nhạc Việt
    const lowerText = text.toLowerCase();
    if (
      lowerText.includes("nhạc") ||
      lowerText.includes("nghe nhạc") ||
      lowerText.includes("phát nhạc") ||
      lowerText.includes("music") ||
      lowerText.includes("play music")
    ) {
      label = "nhac";
      console.log("🎵 Keyword detected → overriding label = nhac");
    }

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // 4) Nhánh nhạc (VN only)
    if (label === "nhac") {
      console.log("🎶 Detected music intent → playing Vietnamese playlist...");
      const defaultSongs = [
        "Top 100 Việt Nam",
        "Nhạc Trẻ",
        "V-Pop Hits Vietnam",
        "Ballad Việt",
        "Nhạc Acoustic Việt",
      ];
      const randomSong = defaultSongs[Math.floor(Math.random() * defaultSongs.length)];

      try {
        const song = await searchItunesAndSave(randomSong);
        if (!song) {
          cleanup();
          return res.json({
            success: false,
            type: "music",
            error: "No Vietnamese song found",
            audio_url: null,
          });
        }

        cleanup();
        return res.json({
          success: true,
          type: "music",
          label,
          text: `Phát nhạc: ${song.title} – ${song.artist}`,
          lang: "vi",
          audio_url: `${host}/audio/${song.filename}`,
          format: "mp3",
        });
      } catch (err) {
        console.error("❌ Music branch error:", err.message);
        cleanup();
        return res.json({
          success: false,
          type: "music",
          error: "Music failed",
          audio_url: null,
        });
      }
    }

    // 5) Nhánh chat
    console.log("💬 Proceeding to chat branch...");

    const lang = detectLanguage(text);
    const finalLang = lang === "mixed" ? "vi" : lang;

    let answer = finalLang === "vi" ? "Xin chào!" : "Hello!";
    try {
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              finalLang === "vi"
                ? "Bạn là một cô gái trẻ, thân thiện, nói tự nhiên bằng tiếng Việt."
                : "You are a friendly young woman who speaks natural English.",
          },
          {
            role: "user",
            content:
              finalLang === "vi"
                ? `Người dùng nói: "${text}". Trả lời thân thiện, ngắn gọn bằng tiếng Việt.`
                : `User said: "${text}". Reply briefly in friendly English.`,
          },
        ],
      });
      answer = chat.choices?.[0]?.message?.content?.trim() || answer;
    } catch (e) {
      console.error("⚠️ Chat error:", e.message);
    }

    const filename = `response_${Date.now()}.mp3`;
    const outPath = path.join(audioDir, filename);
    try {
      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: finalLang === "vi" ? "nova" : "verse",
        format: "mp3",
        input: answer,
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);
    } catch (e) {
      console.error("⚠️ TTS error:", e.message);
    }

    cleanup();

    return res.json({
      success: true,
      type: "chat",
      label,
      text: answer,
      lang: finalLang,
      audio_url: `${host}/audio/${filename}`,
      format: "mp3",
    });
  } catch (err) {
    console.error("❌ /ask error:", err);
    res.status(500).json({ success: false, error: err.message, audio_url: null });
  }
});

// ===== ROUTES =====
app.get("/", (req, res) =>
  res.send("✅ ESP32 Chatbot server (trim silence + VN music + keyword nhac) is running!")
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
