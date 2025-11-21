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

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`
const mqttClient = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT Broker");
  mqttClient.subscribe("robot/audio_in");
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("/dieuhuongrobot");   // dùng cho điều hướng tự động
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

/** convert input -> MP3 */
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
    "tôi muốn biết",
    "cho biết",
    "mình muốn hỏi"
  ];
  if (questionKeywords.some((kw) => t.includes(kw))) {
    console.log("🔁 Label override → 'question'");
    return "question";
  }

  const rules = [
    {
      keywords: [
        "nghe bai hat", "nghe nhac", "phat nhac", "mo bai", "play", "music", "song", "nhạc"
      ],
      newLabel: "nhac",
    },
    {
      keywords: ["qua trai", "xoay trái", "đi trái", "qua bên trái"],
      newLabel: "trai",
    },
    {
      keywords: ["qua phải", "xoay phải", "đi phải", "qua bên phải"],
      newLabel: "phai",
    },
    {
      keywords: ["tiến", "đi lên", "phía trước", "tới", "tiến lên"],
      newLabel: "tien",
    },
    {
      keywords: ["lùi", "đi lùi", "phía sau", "ngược lại"],
      newLabel: "lui",
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((kw) => t.includes(stripDiacritics(kw.toLowerCase())))) {
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

    if (req.file.buffer.length < 2000) {
      return res.json({
        status: "ok",
        transcript: "",
        label: "unknown",
        audio_url: null
      });
    }

    const wavFile = inputFile.replace(".webm", ".wav");

    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .inputOptions("-fflags +genpts")
        .outputOptions("-vn")
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .on("error", err => reject(err))
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
    } catch (err) {
      return res.status(500).json({ error: "STT failed" });
    }

    let label = overrideLabelByText("unknown", text);
    let playbackUrl = null;
    let replyText = "";

    if (label === "nhac") {
      const query = extractSongQuery(text) || text;
      const musicMeta = await searchITunes(query);
      if (musicMeta?.previewUrl) {
        const mp3Url = await getMp3FromPreview(musicMeta.previewUrl);
        playbackUrl = mp3Url;
        replyText = `Dạ, em mở bài "${musicMeta.trackName}" của ${musicMeta.artistName} cho anh nhé.`;
      } else {
        replyText = "Không tìm thấy bài phù hợp.";
      }
    } else {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "Bạn là trợ lý của robot." },
          { role: "user", content: text },
        ],
      });
      replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";
    }

    if (!playbackUrl) {
      const filename = `tts_${Date.now()}.mp3`;
      const outPath = path.join(audioDir, filename);
      const speech = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "ballad",
        format: "mp3",
        input: replyText,
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      playbackUrl = `${getPublicHost()}/audio/${filename}`;
    }

    if (["tien", "lui", "trai", "phai"].includes(label)) {
      mqttClient.publish(
        "robot/label",
        JSON.stringify({ label }),
        { qos: 1, retain: true }
      );
    } else {
      mqttClient.publish(
        "robot/music",
        JSON.stringify({ audio_url: playbackUrl, text: replyText, label }),
        { qos: 1 }
      );
    }

    fs.unlinkSync(inputFile);
    fs.unlinkSync(wavFile);

    res.json({
      status: "ok",
      transcript: text,
      label,
      audio_url: playbackUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ========= Auto Navigation /dieuhuongrobot ========= */

/** Ngưỡng vật cản mới: > 20cm = coi như KHÔNG có vật cản */
const OBSTACLE_THRESHOLD_CM = 20;

/** 
 * Tính khoảng cách hiệu dụng:
 * - ultra_cm = -1 (hoặc <=0) → BỎ QUA
 * - lidar_cm <=0           → BỎ QUA
 * - nếu sensor không hợp lệ → Infinity
 */
function getEffectiveDistanceCm(payload) {
  const lidarValid =
    typeof payload.lidar_cm === "number" && payload.lidar_cm > 0;
  const ultraValid =
    typeof payload.ultra_cm === "number" && payload.ultra_cm > 0;

  const lidar = lidarValid ? payload.lidar_cm : Infinity;
  const ultra = ultraValid ? payload.ultra_cm : Infinity;

  return Math.min(lidar, ultra);
}

/* ==========================================================
   GLOBAL SCAN STATUS
========================================================== */

let scanStatus = "idle";

/* ========= AUTO NAV + SCAN DONE MESSAGE HANDLER ========= */
mqttClient.on("message", (topic, msgBuffer) => {
  const msgStr = msgBuffer.toString();

  // 1) Cập nhật trạng thái scan
  if (topic === "robot/scanning_done") {
    scanStatus = "done";
    console.log("📩 robot/scanning_done → scanStatus = done");
    return;
  }

  // 2) Xử lý điều hướng tự động
  if (topic !== "/dieuhuongrobot") return;

  let payload;
  try {
    payload = JSON.parse(msgStr);
  } catch (e) {
    console.log("Invalid JSON on /dieuhuongrobot:", msgStr);
    return;
  }

  const phase = payload.phase || "front";
  const dist = getEffectiveDistanceCm(payload);
  const hasObstacle = dist < OBSTACLE_THRESHOLD_CM;

  console.log(
    `📡 [AUTO] phase=${phase}, dist=${dist}cm, obstacle=${hasObstacle}`
  );

  // Helper: đưa lidar về neutral khi đường clear
  const sendLidarNeutral = (reason) => {
    const p = JSON.stringify({ action: "scan_neutral", reason });
    mqttClient.publish("robot/lidar_neutralpoint", p, { qos: 1 });
    console.log("→ LIDAR NEUTRAL:", reason);
  };

  /* =============================
       PHASE: FRONT (SONAR + LIDAR)
     ============================= */
  if (phase === "front") {
    if (!hasObstacle) {
      // Đường phía trước clear → đi thẳng + đảm bảo lidar đứng im
      sendLidarNeutral("front_clear");
      mqttClient.publish(
        "/robot/goahead",
        JSON.stringify({ action: "goahead" }),
        { qos: 1 }
      );
      console.log("→ FRONT CLEAR → GO AHEAD");
    } else {
      // Có vật cản phía trước → quét PHẢI robot (LIDAR xoay LEFT)
      mqttClient.publish(
        "robot/lidar45_turnleft",
        JSON.stringify({ action: "scan_right" }),
        { qos: 1 }
      );
      console.log("→ FRONT BLOCKED → CHECK RIGHT SIDE (LIDAR LEFT)");
    }
    return;
  }

  /* =============================
        LEFT45 = LiDAR xoay LEFT
        → Quét PHÍA PHẢI robot
     ============================= */
  if (phase === "left45") {
    if (!hasObstacle) {
      // Phía phải robot clear → quay phải + đi tới, đồng thời ngưng quay lidar
      sendLidarNeutral("right_side_clear");
      mqttClient.publish(
        "/robot/turnright45_goahead",
        JSON.stringify({ action: "turnright45_goahead" }),
        { qos: 1 }
      );
      console.log("→ RIGHT SIDE CLEAR → TURN RIGHT + GO");
    } else {
      // Phải bị chặn → kiểm tra TRÁI robot
      mqttClient.publish(
        "robot/lidar45_turnright",
        JSON.stringify({ action: "scan_left" }),
        { qos: 1 }
      );
      console.log("→ RIGHT BLOCKED → CHECK LEFT SIDE (LIDAR RIGHT)");
    }
    return;
  }

  /* =============================
        RIGHT45 = LiDAR xoay RIGHT
        → Quét PHÍA TRÁI robot
     ============================= */
  if (phase === "right45") {
    if (!hasObstacle) {
      // Phía trái clear → quay trái + đi tới, đồng thời đưa lidar về neutral
      sendLidarNeutral("left_side_clear");
      mqttClient.publish(
        "/robot/turnleft45_goahead",
        JSON.stringify({ action: "turnleft45_goahead" }),
        { qos: 1 }
      );
      console.log("→ LEFT SIDE CLEAR → TURN LEFT + GO");
    } else {
      // Trái cũng bị chặn → kiểm tra neutral phía sau
      mqttClient.publish(
        "robot/lidar_neutralpoint",
        JSON.stringify({ action: "scan_neutral" }),
        { qos: 1 }
      );
      console.log("→ LEFT BLOCKED → CHECK NEUTRAL (BACK)");
    }
    return;
  }

  /* =============================
             NEUTRAL
     ============================= */
  if (phase === "neutral") {
    if (!hasObstacle) {
      // Phía sau clear → lùi, đồng thời đảm bảo lidar đứng neutral
      sendLidarNeutral("back_clear");
      mqttClient.publish(
        "/robot/goback",
        JSON.stringify({ action: "goback" }),
        { qos: 1 }
      );
      console.log("→ BACK CLEAR → GO BACK");
    } else {
      // Tất cả hướng đều có vật cản → dừng & neutral
      sendLidarNeutral("all_blocked");
      mqttClient.publish(
        "/robot/stop",
        JSON.stringify({ action: "stop" }),
        { qos: 1 }
      );
      console.log("→ ALL BLOCKED → STOP");
    }
    return;
  }
});

/* ========= CAMERA ROTATE ENDPOINT ========= */
/*
   HTTP GET:
      /camera_rotate?direction=left&angle=60

   JSON gửi lên MQTT:
      { "direction": "left", "angle": 60, "time": 1732... }
*/
app.get("/camera_rotate", (req, res) => {
  try {
    const direction = (req.query.direction || "").toLowerCase();
    const angle = parseInt(req.query.angle || "0", 10);

    if (!["left", "right"].includes(direction)) {
      return res.status(400).json({
        error: "direction must be 'left' or 'right'"
      });
    }

    if (isNaN(angle) || angle < 0 || angle > 180) {
      return res.status(400).json({
        error: "angle must be a number 0–180"
      });
    }

    const payload = JSON.stringify({
      direction,
      angle,
      time: Date.now()
    });

    mqttClient.publish(
      "/robot/camera_rotate",
      payload,
      { qos: 1 }
    );

    console.log("📡 Sent /robot/camera_rotate →", payload);

    res.json({
      status: "ok",
      message: "Camera rotate command sent",
      topic: "/robot/camera_rotate",
      payload: JSON.parse(payload)
    });

  } catch (e) {
    console.error("❌ /camera_rotate error:", e.message);
    res.status(500).json({ error: "server error" });
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

/* ========= Trigger 45° Scan ========= */
app.get("/trigger_scan45", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_45",
      degree: 45,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning45", payload, { qos: 1 });

    console.log("📡 Triggered 45° scan → robot/scanning45");

    res.json({
      status: "ok",
      message: "45° scan started",
      topic: "robot/scanning45",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 45 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});

/* ========= Trigger 30° Scan ========= */
app.get("/trigger_scan30", (req, res) => {
  try {
    const payload = JSON.stringify({
      action: "scan_30",
      degree: 30,
      time: Date.now(),
    });

    mqttClient.publish("robot/scanning30", payload, { qos: 1 });

    console.log("📡 Triggered 30° scan → robot/scanning30");

    res.json({
      status: "ok",
      message: "30° scan started",
      topic: "robot/scanning30",
      payload: JSON.parse(payload),
    });

  } catch (e) {
    console.error("❌ Error triggering 30 scan:", e.message);
    res.status(500).json({ error: "Trigger failed" });
  }
});

/* Endpoint để client kiểm tra scan đã xong chưa */
app.get("/get_scanningstatus", (req, res) => {
  try {
    res.json({
      status: scanStatus
    });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

/* ========= Root Endpoint ========= */
app.get("/", (_, res) =>
  res.send("Node.js Audio + AI + Auto Navigation Server is running!")
);

/* ========= START SERVER ========= */
app.listen(PORT, () => {
  console.log(`🚀 HTTP server running on port ${PORT}`);
});
