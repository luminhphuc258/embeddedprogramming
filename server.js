// =======================
// ESP32 Chatbot + Music Server (Whisper STT + DeepSeek Chat + OpenAI TTS + iTunes Music)
// =======================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import * as mm from "music-metadata";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Console } from "console";
dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

// ==== Setup ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Middleware ====
app.enable("trust proxy");
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ==== Directory setup ====
const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "public", "audio");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

// ==== Global System Status ====
let systemStatus = {
  state: "idle", // idle | speaking | music | error
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

async function callChatCompletion(user_promp) {
  let togetherResp = "";
  updateStatus("Calling chatCompletin & get answer", "Generating reply (Gemma)...");
  if (!user_promp || user_promp.trim() === "" || user_promp.length > 1000 || user_promp.length < 3) {
    console.log("Yeu cau khong ro rang");
    updateStatus("error", "Yêu cầu không rõ ràng hoặc quá dài/ngắn.");
  } else {
    togetherResp = await fetch("https://api.together.xyz/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemma-3n-E4B-it",
        messages: [
          {
            role: "system",
            content:
              finalLang === "vi"
                ? "Bạn là doremon robot, nói chuyện thân thiện bằng tiếng Việt."
                : "You are a robot speaking natural English.",
          },
          { role: "assistant", content: user_promp },
        ],
        temperature: 0.8,
      }),
    });
  }
  return togetherResp;
}

// ==== Multer for audio upload ====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

// ==== Helper: detect language ====
function detectLanguage(text) {
  const hasVN = /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(text);
  const hasEN = /[a-zA-Z]/.test(text);
  if (hasVN && !hasEN) return "vi";
  if (hasEN && !hasVN) return "en";
  return "mixed";
}

// tinh thoi luong file audio
async function getAudioDuration(filePath) {
  try {
    const metadata = await mm.parseFile(filePath);
    const duration = metadata.format.duration;
    console.log(`=== > Thời luong speaking cũa cau tra loi nay la: ${duration} giây`);
    return duration * 1000 || 0;

  } catch (err) {
    console.error("Lỗi khi đọc file âm thanh:", err.message);
    updateStatus("error", "Lỗi khi đọc file âm thanh.");
    return 0;
  }
}

// ==== Helper: download + convert from iTunes ====
async function getMusicFromItunesAndConvert(query, audioDir) {
  updateStatus("music", `Searching iTunes: ${query}`);
  const resp = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
  );
  if (!resp.ok) {
    Console.log("Lỗi khi tìm kiếm bài hát trên iTunes.");

    updateStatus("error", "Lỗi khi tìm kiếm bài hát trên iTunes.");

    return {
      title: "",
      artist: "",
      file: "",
      success: false,
    };

  } else {
    const data = await resp.json();

    const song = data.results[0];
    const res = await fetch(song.previewUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    const localM4A = path.join(audioDir, `song_${Date.now()}.m4a`);
    fs.writeFileSync(localM4A, buffer);

    const localMP3 = localM4A.replace(".m4a", ".mp3");
    updateStatus("music", "Converting to MP3...");
    await new Promise((resolve, reject) => {
      ffmpeg(localM4A)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(localMP3);
    });
    fs.unlinkSync(localM4A);
    updateStatus("music", "Music ready");

    return {
      title: song.trackName,
      artist: song.artistName,
      file: path.basename(localMP3),
      success: true,
    };
  }
}

// ==== ROUTE: ASK ====
// ==== ROUTE: ASK ====
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    if (systemStatus.state !== "idle") {
      console.log("--> Server busy, let wait...:", systemStatus.state);
      return res.status(429).json({ success: false, error: "Server busy. Try again later." });
    }

    updateStatus("processing", "Transcribing with Whisper...");

    // 🎧 1️⃣ STT bằng OpenAI Whisper
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      language: "vi",
    });

    const text = stt.text.trim();
    console.log("🎙️ Whisper transcript:", text);

    const lang = detectLanguage(text);
    // const finalLang = lang === "mixed" ? "vi" : lang;
    const lower = text.toLowerCase();
    const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;

    // TIM KIEM TREN ITUNES VA PHAT NHAC
    if (
      lower.includes("play") ||
      lower.includes("music") ||
      lower.includes("nhạc") ||
      lower.includes("bật bài") ||
      lower.includes("phát nhạc") ||
      lower.includes("nghe nhạc") ||
      lower.includes("cho tôi nghe") || lower.includes("mở bài") || lower.includes("mở nhạc")
    ) {

      const song = await getMusicFromItunesAndConvert(text, audioDir);

      if (!song.success) {
        console.log("read result and raise Khong tim thay bai hat phu hop tren iTunes.");
        updateStatus("idle", "Server ready")

        return res.json({
          success: false,
          error: "Không tìm thấy bài hát phù hợp.",
        });

      } else {
        // tinh duration de set timeout
        let musicDuration = await getAudioDuration(path.join(audioDir, song.file));
        setTimeout(() => updateStatus("idle", "Server ready"), musicDuration + 1000);

        return res.json({
          success: true,
          type: "music",
          text: notice,
          audio_url: `${host}/audio/${song.file}`,
          music_url: `${host}/audio/${song.file}`,
        });
      }
      // update server return 
    }

    // ================ CHAT MODE với Together.ai (Gemma)

    const togetherResp = await callChatCompletion(text);
    if (!togetherResp.ok || togetherResp === "") {
      const errText = await togetherResp.text();
      console.log("Update status vi khong xu ly duoc user prompt:", errText);

    } else {
      console.log("Da xu ly promp thanh cong tu chatcompletion API.");
      const togetherData = await togetherResp.json();
      const answer =
        togetherData.choices?.[0]?.message?.content?.trim() ||
        "Xin lỗi, mình chưa nghe rõ lắm.";

      console.log("Gemma reply:", answer);

      // =============== Tao audio tra loi bằng OpenAI APIs
      updateStatus("speaking", "Generating TTS...");

      const tts = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "sage",
        format: "mp3",
        input: answer,
      });

      const filename = `tts_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(audioDir, filename), Buffer.from(await tts.arrayBuffer()));
      updateStatus("speaking", "TTS ready");

      // clean memory
      fs.unlinkSync(req.file.path);

      // tinh duration de set timeout
      const duration = await getAudioDuration(path.join(audioDir, `tts_${Date.now()}.mp3`));

      setTimeout(() => updateStatus("idle", "Server ready"), duration + 1000);

      res.json({
        success: true,
        type: "chat",
        text: answer,
        audio_url: `${host}/audio/${filename}`,
      });
    }



  } catch (err) {
    console.log("Error happening /ask:", err);
    console.error("Error:", err.message);
    updateStatus("error", err.message);
    res.json({ success: false, error: err.message });
    setTimeout(() => updateStatus("idle", "Recovered from error"), 2000);
  }
});


// ==== ROUTE: Robot sends status ====
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res
      .status(400)
      .json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ==== ROUTE: ESP32 polls current system status ====
app.get("/status", (_req, res) => res.json(systemStatus));

// ==== Health check ====
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Chatbot Server (Whisper + DeepSeek + TTS + Music) is running!")
);

// ==== Start server ====
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
