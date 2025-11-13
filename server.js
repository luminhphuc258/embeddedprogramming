import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mqtt from "mqtt";
import dotenv from "dotenv";
import fetch from "node-fetch";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import cors from "cors";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });

/* ========= CORS cho video server ========= */
const allowedOrigins = [
  "https://videoserver-videoserver.up.railway.app",
  "http://localhost:8000",
  "http://localhost:8080",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// preflight cho route upload_audio
app.options("/upload_audio", cors());

/* ========= Static ========= */
app.use("/audio", express.static(audioDir));

/* ========= MQTT Setup ========= */
const MQTT_HOST = "rfff7184.ala.us-east-1.emqxsl.com";
const MQTT_PORT = 8883;
const MQTT_USER = "robot_matthew";
const MQTT_PASS = "29061992abCD!yesokmen";

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;
const mqttClient = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT Broker");
  mqttClient.subscribe("robot/audio_in");
});
mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));

/* ========= Helper Functions ========= */
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// (Giữ lại nếu muốn dùng sau, nhưng hiện tại không gọi nữa)
function hasWakeWord(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  return /(xin chao|hello|hi|nghe|doremon|lily|pipi|bibi)/.test(t);
}

/** Tên bài hát từ câu lệnh tiếng Việt */
function extractSongQuery(text = "") {
  let t = stripDiacritics(text.toLowerCase());

  const removePhrases = [
    "xin chao",
    "hello",
    "hi",
    "toi muon nghe",
    "toi muon nghe bai",
    "tôi muốn nghe",
    "tôi muốn nghe bài",
    "nghe bai hat",
    "nghe bài hát",
    "bai hat",
    "bài hát",
    "nghe nhac",
    "nghe nhạc",
    "phat nhac",
    "phát nhạc",
    "bat nhac",
    "bật nhạc",
    "mo bai",
    "mở bài",
    "em mo bai",
    "em mở bài",
  ];

  for (const p of removePhrases) t = t.replace(p, " ");

  t = t.replace(/\s+/g, " ").trim();
  return t; // query để search iTunes
}

/** Gọi iTunes Search API để tìm nhạc */
async function searchITunes(query) {
  if (!query) return null;

  const url = `https://itunes.apple.com/search?media=music&limit=1&term=${encodeURIComponent(
    query
  )}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn("⚠️ iTunes search failed status:", resp.status);
    return null;
  }

  const data = await resp.json();
  if (!data.results || !data.results.length) return null;

  const r = data.results[0];
  return {
    trackName: r.trackName,
    artistName: r.artistName,
    previewUrl: r.previewUrl, // thường là .m4a 30s
    artworkUrl: r.artworkUrl100 || r.artworkUrl60,
  };
}

/* ========= Helper: host & download / convert ========= */
function getPublicHost() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const railway = process.env.RAILWAY_STATIC_URL;
  if (railway) return `https://${railway}`;
  return `http://localhost:${PORT}`;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

async function convertToMp3(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("mp3")
      .on("error", reject)
      .on("end", resolve)
      .save(outputPath);
  });
}

/** Từ preview (.m4a) → .mp3 trong /audio và trả về URL .mp3 */
async function getMp3FromPreview(previewUrl) {
  const ts = Date.now();
  const tmpM4a = path.join(audioDir, `itunes_${ts}.m4a`);
  const mp3FileName = `itunes_${ts}.mp3`;
  const mp3Path = path.join(audioDir, mp3FileName);

  await downloadFile(previewUrl, tmpM4a);
  await convertToMp3(tmpM4a, mp3Path);
  try {
    fs.unlinkSync(tmpM4a);
  } catch (e) {
    console.warn("⚠️ Cannot delete temp m4a:", e.message);
  }

  const host = getPublicHost();
  return `${host}/audio/${mp3FileName}`;
}

/* ========= Hàm override label ========= */
function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  // Ưu tiên 1: Question
  const questionKeywords = [
    " la ai",
    " là ai",
    "hay cho toi biet",
    "hãy cho toi biet",
    "hay cho toi biet",
    "hay cho em biet",
    "hãy cho em biết",
    "hay cho toi biet ve",
    "hãy cho tôi biết",
  ];
  if (questionKeywords.some((kw) => t.includes(kw))) {
    console.log("🔁 Label override → 'question' (detect question)");
    return "question";
  }

  // Các rule còn lại như cũ
  const rules = [
    {
      keywords: [
        "nghe bai hat",
        "nghe bài hát",
        "phat nhac",
        "phát nhạc",
        "nghe nhac",
        "nghe nhạc",
        "bat nhac",
        "bật nhạc",
        "mo bai",
        "mở bài",
        "nghe bai",
        "toi muon nghe",
        "tôi muốn nghe",
      ],
      newLabel: "nhac",
    },
    {
      keywords: [
        "qua trai",
        "qua trái",
        "qua ben trai",
        "qua bên trái",
        "di chuyen sang trai",
        "ben trai",
        "di ben trai",
      ],
      newLabel: "trai",
    },
    {
      keywords: [
        "qua phai",
        "qua phải",
        "xoay ben phai",
        "xoay bên phải",
        "qua ben phai",
        "qua bên phải",
        "di ben phai",
      ],
      newLabel: "phai",
    },
    {
      keywords: [
        "tien len",
        "tiến lên",
        "di len",
        "đi lên",
        "di toi",
        "đi tới",
        "di ve phia truoc",
        "đi về phía trước",
        "tien toi",
      ],
      newLabel: "tien",
    },
    {
      keywords: ["lui lai", "lùi lại", "di lui", "đi lùi", "di ve sau", "đi về sau", "lùi"],
      newLabel: "lui",
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((kw) => t.includes(kw))) {
      console.log(
        `🔁 Label override: '${label}' → '${rule.newLabel}' (matched '${rule.keywords[0]}')`
      );
      return rule.newLabel;
    }
  }
  return label;
}

/* ========= Route nhận audio từ video server ========= */
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);
    console.log(
      `🎧 Received audio (${(req.file.buffer.length / 1024).toFixed(1)} KB): ${inputFile}`
    );

    // 🔄 webm → wav
    const wavFile = inputFile.replace(".webm", ".wav");
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .toFormat("wav")
        .on("error", reject)
        .on("end", resolve)
        .save(wavFile);
    });
    console.log(`🎵 Converted to WAV: ${wavFile}`);

    // 1️⃣ STT
    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavFile),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch (err) {
      console.error("⚠️ STT error:", err.message);
      return res.status(500).json({ error: "STT failed" });
    }
    console.log("🧠 Transcript:", text);

    // === Không còn wake word: luôn xử lý ===

    // 2️⃣ Label chỉ dựa trên text (không gọi Python)
    let label = "unknown";
    label = overrideLabelByText(label, text);
    console.log(`🔹 Final Label: ${label}`);

    let playbackUrl = null;
    let musicMeta = null;
    let replyText = "";

    // 3️⃣ Nhạc: dùng iTunes + convert .m4a → .mp3
    if (label === "nhac") {
      const query = extractSongQuery(text) || text;
      console.log("🎼 Music query:", query);

      try {
        musicMeta = await searchITunes(query);
      } catch (e) {
        console.warn("⚠️ iTunes search error:", e.message);
      }

      if (musicMeta && musicMeta.previewUrl) {
        try {
          const mp3Url = await getMp3FromPreview(musicMeta.previewUrl);
          playbackUrl = mp3Url;
          replyText = `Dạ, em mở bài "${musicMeta.trackName}" của ${musicMeta.artistName} cho anh nhé.`;
          console.log("🎧 iTunes hit:", musicMeta);
          console.log("🎧 MP3 URL:", playbackUrl);
        } catch (e) {
          console.warn("⚠️ Convert preview to mp3 error:", e.message);
        }
      }
    }

    // 4️⃣ Câu hỏi: gọi ChatGPT trả lời
    if (label === "question") {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "Bạn là trợ lý nói tiếng Việt cho một robot nhỏ. Trả lời ngắn gọn, dễ hiểu.",
            },
            { role: "user", content: text },
          ],
        });
        replyText =
          completion.choices?.[0]?.message?.content?.trim() ||
          "Dạ, em chưa chắc lắm, nhưng em sẽ cố gắng tìm hiểu thêm.";
      } catch (e) {
        console.error("⚠️ Chat completion error:", e.message);
        replyText = "Dạ, em bị lỗi khi trả lời câu hỏi này.";
      }
    }

    // 5️⃣ Các label khác (tien, lui, trai, phai, unknown...) → câu trả lời mặc định
    if (!replyText && label !== "nhac") {
      replyText = "Dạ, em đây ạ! Em sẵn sàng nghe lệnh.";
    }

    // 6️⃣ Nếu chưa có playbackUrl (không phải nhạc hoặc nhạc fail) → TTS
    if (!playbackUrl) {
      const filename = `tts_${Date.now()}.mp3`;
      const outPath = path.join(audioDir, filename);

      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "nova",
        format: "mp3",
        input: replyText,
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);

      const host = getPublicHost();
      playbackUrl = `${host}/audio/${filename}`;
    }

    // 7️⃣ Publish cho robot
    const payload = {
      audio_url: playbackUrl,
      text: replyText,
      label,
    };
    if (musicMeta) payload.music = musicMeta;

    mqttClient.publish("robot/music", JSON.stringify(payload));
    console.log("📢 Published to robot/music:", payload);

    // 8️⃣ Xoá file tạm
    try {
      fs.unlinkSync(inputFile);
      fs.unlinkSync(wavFile);
    } catch (e) {
      console.warn("⚠️ Cannot delete temp files:", e.message);
    }

    // 9️⃣ Trả kết quả cho video server
    res.json({
      status: "ok",
      transcript: text,
      label,
      audio_url: playbackUrl,
      music: musicMeta,
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ========= Root route ========= */
app.get("/", (_, res) => res.send("✅ Node.js Audio+AI Server is running!"));

app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
