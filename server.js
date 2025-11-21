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
  console.log("✅ Connected to MQTT Broker");
  mqttClient.subscribe("robot/audio_in");
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("/dieuhuongrobot"); // auto nav
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
  if (!resp.ok) return null;

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
  if (!res.ok) throw new Error("Download failed!");

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destPath);
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
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

async function getMp3FromPreview(previewUrl) {
  const ts = Date.now();
  const tmpM4a = path.join(audioDir, `song_${ts}.m4a`);
  const mp3Path = path.join(audioDir, `song_${ts}.mp3`);

  await downloadFile(previewUrl, tmpM4a);
  await convertToMp3(tmpM4a, mp3Path);

  try {
    fs.unlinkSync(tmpM4a);
  } catch { }

  return `${getPublicHost()}/audio/song_${ts}.mp3`;
}

/* ========= Speech ========= */
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer)
      return res.status(400).json({ error: "No audio uploaded" });

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);

    if (req.file.buffer.length < 2000) {
      return res.json({ status: "ok", transcript: "", label: "unknown" });
    }

    const wavFile = inputFile.replace(".webm", ".wav");

    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .inputOptions("-fflags +genpts")
        .outputOptions("-vn")
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .on("error", reject)
        .on("end", resolve)
        .save(wavFile);
    });

    let text = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavFile),
        model: "gpt-4o-mini-transcribe",
      });
      text = (tr.text || "").trim();
    } catch {
      return res.status(500).json({ error: "STT failed" });
    }

    fs.unlinkSync(inputFile);
    fs.unlinkSync(wavFile);

    res.json({ status: "ok", transcript: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ========= Auto Navigation ========= */

const THRESHOLD = 20;

/* 
 Chỉ dùng ultrasonic để phát hiện vật cản trước
 - ultra = -1 → bỏ qua → coi như clear
*/
function isFrontBlocked(ultra) {
  if (typeof ultra !== "number") return false;
  if (ultra <= 0) return false; // ultra = -1 → no obstacle
  return ultra < THRESHOLD;
}

/*
 Chỉ dùng LIDAR khi quét trái/phải
*/
function isLidarClear(lidar) {
  return typeof lidar === "number" && lidar >= THRESHOLD;
}

mqttClient.on("message", (topic, msgBuffer) => {
  if (topic !== "/dieuhuongrobot") return;

  let payload;
  try {
    payload = JSON.parse(msgBuffer.toString());
  } catch {
    return;
  }

  const phase = payload.phase || "front";
  const lidar = payload.lidar_cm;
  const ultra = payload.ultra_cm;

  console.log(`📡 NAV phase=${phase} ultra=${ultra} lidar=${lidar}`);

  /* ===========================================================
      PHASE: FRONT → chỉ dùng ULTRASONIC
  =========================================================== */
  if (phase === "front") {
    if (!isFrontBlocked(ultra)) {
      mqttClient.publish(
        "/robot/goahead",
        JSON.stringify({ action: "goahead" }),
        { qos: 1 }
      );
      console.log("→ FRONT CLEAR → GO AHEAD");
      return;
    }

    // blocked → quét TRÁI
    mqttClient.publish(
      "robot/lidar_left",
      JSON.stringify({ action: "scan_left" }),
      { qos: 1 }
    );
    console.log("→ FRONT BLOCKED → SCAN LEFT");
    return;
  }

  /* ===========================================================
      PHASE: LEFT → chỉ dùng LIDAR
  =========================================================== */
  if (phase === "left") {
    if (isLidarClear(lidar)) {
      mqttClient.publish(
        "/robot/goahead_left",
        JSON.stringify({ action: "goahead_left" }),
        { qos: 1 }
      );
      console.log("→ LEFT CLEAR → GO AHEAD LEFT");
      return;
    }

    // trái blocked → quét phải
    mqttClient.publish(
      "robot/lidar_right",
      JSON.stringify({ action: "scan_right" }),
      { qos: 1 }
    );
    console.log("→ LEFT BLOCKED → SCAN RIGHT");
    return;
  }

  /* ===========================================================
      PHASE: RIGHT → chỉ dùng LIDAR
  =========================================================== */
  if (phase === "right") {
    if (isLidarClear(lidar)) {
      mqttClient.publish(
        "/robot/goahead_right",
        JSON.stringify({ action: "goahead_right" }),
        { qos: 1 }
      );
      console.log("→ RIGHT CLEAR → GO AHEAD RIGHT");
      return;
    }

    // cả trước trái phải đều block → lùi + stop
    mqttClient.publish(
      "/robot/goback",
      JSON.stringify({ action: "goback" }),
      { qos: 1 }
    );
    mqttClient.publish(
      "/robot/stop",
      JSON.stringify({ action: "stop" }),
      { qos: 1 }
    );

    console.log("⛔ ALL BLOCKED → GO BACK + STOP");
    return;
  }
});

/* ========= Camera Rotate Endpoint ========= */
app.get("/camera_rotate", (req, res) => {
  try {
    const direction = (req.query.direction || "").toLowerCase();
    const angle = parseInt(req.query.angle || "0", 10);

    if (!["left", "right"].includes(direction)) {
      return res.status(400).json({
        error: "direction must be 'left' or 'right'",
      });
    }

    if (isNaN(angle) || angle < 0 || angle > 180) {
      return res.status(400).json({
        error: "angle must be 0–180",
      });
    }

    const payload = {
      direction,
      angle,
      time: Date.now(),
    };

    mqttClient.publish(
      "/robot/camera_rotate",
      JSON.stringify(payload),
      { qos: 1 }
    );

    res.json({
      status: "ok",
      message: "rotate sent",
      payload,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ========= Root ========= */
app.get("/", (_, res) =>
  res.send("Node.js Audio + AI + Auto Navigation Server is running!")
);

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
