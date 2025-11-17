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

/* ========= CORS ========= */
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
  console.log(" Connected to MQTT Broker");
  mqttClient.subscribe("robot/audio_in");
});
mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));

/* ========= Helpers ========= */
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

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
  return t;
}

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
    previewUrl: r.previewUrl,
    artworkUrl: r.artworkUrl100 || r.artworkUrl60,
  };
}

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

/** convert input -> MP3 kiểu giống server cũ (đã từng chạy OK) */
async function convertToMp3(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("mp3")
      .on("start", (cmd) => console.log("🎬 ffmpeg start:", cmd))
      .on("error", (err) => {
        console.error("❌ ffmpeg error:", err.message);
        reject(err);
      })
      .on("end", () => {
        console.log("✅ ffmpeg done:", outputPath);
        resolve();
      })
      .save(outputPath);
  });
}

/** Từ preview (.m4a) → .mp3 trong /audio và trả về URL .mp3 */
async function getMp3FromPreview(previewUrl) {
  const ts = Date.now();
  const tmpM4a = path.join(audioDir, `song_${ts}.m4a`);
  const mp3FileName = `song_${ts}.mp3`;
  const mp3Path = path.join(audioDir, mp3FileName);

  console.log("⬇️ Downloading preview:", previewUrl);
  await downloadFile(previewUrl, tmpM4a);

  console.log("🎼 Converting preview → mp3...");
  await convertToMp3(tmpM4a, mp3Path);
  try {
    fs.unlinkSync(tmpM4a);
  } catch (e) {
    console.warn("⚠️ Cannot delete temp m4a:", e.message);
  }

  const host = getPublicHost();
  const url = `${host}/audio/${mp3FileName}`;
  console.log("🎧 Final MP3 URL:", url);
  return url;
}

/* ========= Label override ========= */
function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  const questionKeywords = [
    "la ai",
    "là ai",
    "hay cho toi biet",
    "hãy cho toi biet",
    "hay cho em biet",
    "hãy cho em biết",
    "hay cho toi biet ve",
    "hãy cho tôi biết",
    "ban co biet",
    "bạn có biết",
    "cho toi hoi",
    "cho tôi hỏi",
    "bạn có biết",
    "tôi muốn biết",
    "cho biết",
    "mình muốn hỏi"
  ];
  if (questionKeywords.some((kw) => t.includes(kw))) {
    console.log("🔁 Label override → 'question' (detect question)");
    return "question";
  }

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
        "mở nhạc",
        "nghe bai",
        "toi muon nghe",
        "tôi muốn nghe",
        "nghe",
        "bật nhạc",
        "phát nhạc",
        "cho tôi nghe",
        "play",
        "music",
        "song",
        "nhạc",
        "hát",
        "cho tôi nghe",
        "nghe bài",
        "bài hát"
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
        "bên trái",
        "di ben trai",
        "xoay trái",
        "xoay trai",
        "di chuyen ve ben trai",
        "đi sang trái",
        "di ve ben trai",
        "bên trái xoay",
        "di chuyển qua trái"
      ],
      newLabel: "trai",
    },
    {
      keywords: [
        "qua phía bên phải",
        "qua phai",
        "qua phải",
        "ben phai",
        "bên phải",
        "bên phải xoay",
        "xoay ben phai",
        "xoay bên phải",
        "qua ben phai",
        "qua bên phải",
        "di ben phai",
        "đi sang phải",
        "di chuyen sang phai",
        "di chuyển sang phải"
      ],
      newLabel: "phai",
    },
    {
      keywords: [
        "lên",
        "tiến",
        "chuyển về phía trước",
        "chạy về trước",
        "phía trước",
        "tien len",
        "tiến lên",
        "di chuyển lên",
        "di chuyen len",
        "đi lên phía trước",
        "di len",
        "đi lên",
        "di toi",
        "đi tới",
        "di ve phia truoc",
        "đi về phía trước",
        "di chuyển về phía trước",
        "tien toi",
        "tiến tới",
        "đi lên",
        "di chuyển lên"
      ],
      newLabel: "tien",
    },
    {
      keywords: ["ngược lại", "về sau", "sau", "lui", "lùi về", "phía sau", "đằng sau", "di chuyển về sau", "đi ngược lại", "ve lại", "lui lai", "lùi lại", "di lui", "đi lùi", "di ve sau", "đi về sau", "lùi"],
      newLabel: "lui",
    },
  ];

  for (const rule of rules) {
    if (
      rule.keywords.some((kw) =>
        t.includes(stripDiacritics(kw.toLowerCase()))
      )
    ) {
      console.log(
        `🔁 Label override: '${label}' → '${rule.newLabel}' (matched '${rule.keywords[0]}')`
      );
      return rule.newLabel;
    }
  }
  return label;
}

/* ========= /upload_audio ========= */
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);
    console.log(
      ` Received audio (${(req.file.buffer.length / 1024).toFixed(1)} KB): ${inputFile}`
    );

    // webm → wav
    // check neu file nho thi bo qua lun 
    // Skip very small files
    if (req.file.buffer.length < 2000) {
      console.log("Audio too small, skip convert");
      return res.json({
        status: "ok",
        transcript: "",
        label: "unknown",
        audio_url: null
      });
    }

    // Write file fully
    await fs.promises.writeFile(inputFile, req.file.buffer);

    const wavFile = inputFile.replace(".webm", ".wav");
    console.log("Converting WebM → WAV...");

    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .inputOptions("-fflags +genpts")
        .outputOptions("-vn")
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .on("error", err => {
          console.error("ffmpeg error:", err.message);
          reject(err);
        })
        .on("end", () => {
          console.log("Converted to WAV:", wavFile);
          resolve();
        })
        .save(wavFile);
    });

    console.log(`🎵 Converted to WAV: ${wavFile}`);

    // STT
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
    // console.log("🧠 Transcript:", text);

    let label = "unknown";
    label = overrideLabelByText(label, text);
    // console.log(`🔹 Final Label: ${label}`);

    let playbackUrl = null;
    let musicMeta = null;
    let replyText = "";

    // 1️⃣ Nhạc: iTunes + convert
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
        } catch (e) {
          console.warn("⚠️ Convert preview to mp3 error:", e.message);
          replyText = "Dạ, em không mở được bài nhạc này, anh thử bài khác nhé.";
        }
      } else {
        replyText = "Dạ, em không tìm được bài nhạc phù hợp.";
      }
    }

    // 2️⃣ MỌI LABEL KHÁC → ChatGPT trả lời
    if (label !== "nhac") {
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
        replyText = "Dạ, em bị lỗi khi trả lời câu này.";
      }
    }

    // 3️⃣ Fallback nếu vẫn trống (phòng trường hợp hiếm)
    if (!replyText) {
      replyText = "Dạ, em đây ạ! Em sẵn sàng nghe lệnh.";
    }

    // 4️⃣ Nếu chưa có playbackUrl → TTS replyText
    if (!playbackUrl) {
      const filename = `tts_${Date.now()}.mp3`;
      const outPath = path.join(audioDir, filename);

      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "ballad",
        format: "mp3",
        input: replyText || "Dạ, em đây ạ!",
      });

      // alloy
      // ash
      // ballad
      // coral
      // echo
      // fable
      // nova
      // onyx
      // sage
      // shimmer




      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);

      const host = getPublicHost();
      playbackUrl = `${host}/audio/${filename}`;
    }

    // publish label for robot di chuyen 
    if (["tien", "lui", "trai", "phai"].includes(label)) {
      const movePayload = { label };
      mqttClient.publish("robot/label", JSON.stringify(movePayload), { qos: 1, retain: true });
      // console.log(" Published move label → robot/label:", movePayload);
    } else {
      // 5 MQTT payload: luôn chỉ có 3 field
      const payload = {
        audio_url: playbackUrl,
        text: replyText,
        label,
      };
      mqttClient.publish("robot/music", JSON.stringify(payload));
      //console.log(" Published to robot/music:", payload);
    }

    try {
      fs.unlinkSync(inputFile);
      fs.unlinkSync(wavFile);
    } catch (e) {
      console.warn("⚠️ Cannot delete temp files:", e.message);
    }

    // HTTP response có thể trả thêm field music nếu bạn muốn dùng trên web sau này
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

/* ========= Trigger Scan Endpoint ========= */
app.get("/trigger_scan", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "start_scan",
      time: Date.now()
    });

    mqttClient.publish("robot/scanning360", payload, { qos: 1 });

    console.log("📡 Triggered 360° scan → robot/scanning360");

    res.json({
      status: "ok",
      message: "Scan started",
      topic: "robot/scanning360",
      payload: JSON.parse(payload)
    });

  } catch (e) {
    console.error("❌ Error triggering scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});

/* ========= Trigger 180° Scan ========= */
app.get("/trigger_scan180", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_180",
      degree: 180,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning180", payload, { qos: 1 });

    console.log("📡 Triggered 180° scan → robot/scanning180");

    res.json({
      status: "ok",
      message: "180° scan started",
      topic: "robot/scanning180",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 180 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});


/* ========= Trigger 90° Scan ========= */
app.get("/trigger_scan90", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_90",
      degree: 90,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning90", payload, { qos: 1 });

    console.log("📡 Triggered 90° scan → robot/scanning90");

    res.json({
      status: "ok",
      message: "90° scan started",
      topic: "robot/scanning90",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 90 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});

app.get("/trigger_scan30", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_30",
      degree: 30,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning90", payload, { qos: 1 });

    console.log("📡 Triggered 90° scan → robot/scanning90");

    res.json({
      status: "ok",
      message: "30° scan started",
      topic: "robot/scanning90",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 90 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});


app.get("/trigger_scan45", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_45",
      degree: 45,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning90", payload, { qos: 1 });

    console.log("📡 Triggered 90° scan → robot/scanning90");

    res.json({
      status: "ok",
      message: "45° scan started",
      topic: "robot/scanning90",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 90 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});

/* ========= Root ========= */
app.get("/", (_, res) => res.send("✅ Node.js Audio+AI Server is running!"));

app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
