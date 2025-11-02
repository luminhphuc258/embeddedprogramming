// =======================
// ESP32 Chatbot + KWS + Vietnamese Music + TTS Server (VN-first)
// - Trim silence (ffmpeg)
// - Only Vietnamese handled; otherwise reply "Mình chưa hiểu..." (vi TTS)
// - Keyword "nhac" override (VN only)
// - iTunes VN (country=vn, entity=song)
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

// ===== Language helpers =====
const VI_DIACRITIC_RE =
  /[ĂÂÊÔƠƯĐáàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴđ]/;

function stripDiacritics(s = "") {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function hasVietnamese(text = "") {
  return VI_DIACRITIC_RE.test(String(text).normalize("NFC"));
}

// Bảng chữ cái ngoại (CJK, Cyrillic, Arabic, Hebrew, Thai, Devanagari, Hangul…)
const FOREIGN_SCRIPT_RE =
  /[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u0E00-\u0E7F\u0900-\u097F\u3040-\u30FF\u3130-\u318F\uAC00-\uD7AF\u3400-\u9FFF\uF900-\uFAFF]/;

function containsForeignScript(text = "") {
  return FOREIGN_SCRIPT_RE.test(text);
}

// Từ tiếng Việt phổ biến (sau khi bỏ dấu) để nhận biết khi không có dấu
const VN_COMMON_WORDS = [
  "xin chao", "chao", "ban", "toi", "minh", "anh", "em",
  "nhac", "nghe nhac", "phat nhac", "mo nhac", "bat nhac",
  "cam on", "cam on ban", "doremon", "do re mon", "doremon oi",
  "gi", "gi vay", "duoc khong", "phai", "trai", "tien", "lui",
  "phat", "nghe", "mo", "bat"
];

function looksVietnameseWithoutDiacritics(text = "") {
  const t = stripDiacritics(text).toLowerCase();
  return VN_COMMON_WORDS.some(w => t.includes(w));
}

function isLikelyVietnamese(text = "") {
  // Ưu tiên: có dấu → chắc chắn VI
  if (hasVietnamese(text)) return true;
  // Không có dấu: chấp nhận nếu có nhiều từ Việt phổ biến
  if (looksVietnameseWithoutDiacritics(text)) return true;
  return false;
}

function isNonsenseOrTooShort(text = "") {
  const t = (text || "").trim();
  if (t.length < 2) return true;
  // nếu toàn dấu, số, ký tự lạ
  const letters = (t.match(/[A-Za-zÀ-ỹ]/g) || []).length;
  return letters < Math.ceil(t.length * 0.25);
}

// ===== Trim leading/trailing silence =====
async function trimSilence(inputPath) {
  const ext = path.extname(inputPath) || ".wav";
  const outPath = inputPath.replace(ext, `_nosil${ext}`);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioFilters([
          "silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB:stop_periods=1:stop_duration=0.15:stop_threshold=-45dB",
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

// ===== Keyword helpers (VN) =====
function hasWake(text) {
  const t = stripDiacritics(text.toLowerCase());
  return (
    t.includes("doremon") || t.includes("do re mon") || t.includes("doremon oi") ||
    t.includes("xin chao") || t.includes("xin chào")
  );
}

function hasStop(text) {
  const t = stripDiacritics(text.toLowerCase());
  return t.includes("cam on") || t.includes("cam on ban");
}

// ===== TTS (Vietnamese) =====
async function ttsViToFile(text) {
  const filename = `tts_${Date.now()}.mp3`;
  const outPath = path.join(audioDir, filename);
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "nova",
    format: "mp3",
    input: text,
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return filename;
}

// ===== iTunes VN search & convert preview to mp3 =====
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

// ===== /ask =====
app.post("/ask", upload.single("audio"), async (req, res) => {
  let tmpTrim = null;

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

    // 0) Trim silence
    const { path: procPath, trimmed } = await trimSilence(wavPath);
    tmpTrim = trimmed;
    if (trimmed) console.log(`Trimmed silence -> ${trimmed}`);

    // 1) Quick classifier (KWS)
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

    // 2) STT
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

    // 2.5) Vietnamese-first filter
    // - Nếu không phải tiếng Việt / chứa bảng chữ cái ngoại / câu vô nghĩa → trả lời “Mình chưa hiểu…” (vi TTS)
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const notVietnamese =
      !isLikelyVietnamese(text) || containsForeignScript(text) || isNonsenseOrTooShort(text);

    if (notVietnamese) {
      const reply = "Mình chưa hiểu câu này. Bạn nói lại bằng tiếng Việt nhé.";
      let file = null;
      try {
        file = await ttsViToFile(reply);
      } catch { }
      cleanup();
      return res.json({
        success: true,
        type: "chat",
        label: "unknown_vi_only",
        text: reply,
        lang: "vi",
        audio_url: file ? `${host}/audio/${file}` : null,
        format: file ? "mp3" : null,
      });
    }

    // 3) Keyword override → nhạc VN
    const lowerNoAccent = stripDiacritics(text.toLowerCase());
    const isMusic =
      lowerNoAccent.includes("nhac") ||
      lowerNoAccent.includes("nghe nhac") ||
      lowerNoAccent.includes("phat nhac") ||
      lowerNoAccent.match(/\b(phat|mo|bat)\b.+\bnhac\b/);

    if (isMusic) {
      label = "nhac";
      console.log("🎵 Keyword detected (VI) → overriding label = nhac");
    }

    // 4) Music branch (VN only)
    if (label === "nhac") {
      const tenbaihat = text
        .replace(/(phát|nghe|cho|mở|bật|nhạc)/gi, "")
        .trim();

      try {
        const song = await searchItunesAndSave(tenbaihat || "V-Pop");
        if (!song) {
          cleanup();
          return res.json({
            success: false,
            type: "music",
            error: "Không tìm thấy bài hát phù hợp trên iTunes VN.",
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

    // 5) Chat branch (VN only)
    console.log("💬 Proceeding to chat branch (VI)...");
    let answer = "Xin chào!";
    try {
      const chat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Bạn là một cô gái trẻ, thân thiện, nói tự nhiên bằng tiếng Việt.",
          },
          {
            role: "user",
            content: `Người dùng nói: "${text}". Trả lời thân thiện, ngắn gọn bằng tiếng Việt.`,
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
        voice: "nova",
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
      lang: "vi",
      audio_url: `${host}/audio/${filename}`,
      format: "mp3",
    });
  } catch (err) {
    console.error("❌ /ask error:", err);
    res.status(500).json({ success: false, error: err.message, audio_url: null });
  }
});

// ===== /wake =====
app.post("/wake", upload.single("audio"), async (req, res) => {
  const cleanup = () => {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch { }
  };

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    }

    const wavPath = req.file.path;
    let text = "";

    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (e) {
      cleanup();
      return res.json({ success: false, label: "none", error: "transcribe_failed" });
    }

    // Chỉ chấp nhận tiếng Việt cho wake
    if (!isLikelyVietnamese(text) || containsForeignScript(text) || isNonsenseOrTooShort(text)) {
      cleanup();
      return res.json({ success: true, label: "none", text, audio_url: null });
    }

    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    if (hasStop(text)) {
      cleanup();
      return res.json({
        success: true,
        label: "yen",
        text,
        audio_url: null,
      });
    }

    if (hasWake(text)) {
      const reply = "Dạ, có em. Anh cần giúp gì vậy?";
      let filename = null;
      try {
        filename = await ttsViToFile(reply);
      } catch { }
      cleanup();
      return res.json({
        success: true,
        label: "wake",
        text,
        reply,
        audio_url: filename ? `${host}/audio/${filename}` : null,
        format: filename ? "mp3" : null,
      });
    }

    cleanup();
    return res.json({ success: true, label: "none", text, audio_url: null });

  } catch (err) {
    console.error("❌ /wake error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===== ROUTES =====
app.get("/", (req, res) =>
  res.send("✅ ESP32 Chatbot server (VN-first, trim silence, VN music) is running!")
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
