/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + iTunes + Auto Navigation)
   - STT + ChatGPT / iTunes + TTS
   - Auto điều hướng với ULTRASONIC + LIDAR + state machine
   - Dùng done_rotate_lidarleft / done_rotate_lidarright để tránh quay lặp
===========================================================================*/

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

/* ===========================================================================
   CORS
===========================================================================*/
const allowedOrigins = [
  "https://videoserver-videoserver.up.railway.app",
  "http://localhost:8000",
  "http://localhost:8080",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("/upload_audio", cors());

/* ===========================================================================
   RATE LIMIT CHO /upload_audio — ƯU TIÊN CHATBOT, TRÁNH QUÁ TẢI
===========================================================================*/
const requestLimitMap = {};
const MAX_REQ = 2;      // tối đa 2 request / giây / IP
const WINDOW_MS = 1000; // 1 giây

function uploadLimiter(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();

  if (!requestLimitMap[ip]) {
    requestLimitMap[ip] = [];
  }

  // chỉ giữ lại những request trong 1 giây gần nhất
  requestLimitMap[ip] = requestLimitMap[ip].filter((t) => now - t < WINDOW_MS);

  if (requestLimitMap[ip].length >= MAX_REQ) {
    return res.status(429).json({
      error: "Server đang bận, vui lòng thử lại sau 1 giây.",
    });
  }

  requestLimitMap[ip].push(now);
  next();
}

/* ===========================================================================
   STATIC
===========================================================================*/
app.use("/audio", express.static(audioDir));

/* ===========================================================================
   MQTT CLIENT
===========================================================================*/
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
  console.log("✅ MQTT connected");

  mqttClient.subscribe("/dieuhuongrobot");
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("/done_rotate_lidarleft");
  mqttClient.subscribe("/done_rotate_lidarright");
  mqttClient.subscribe("robot/audio_in"); // phòng khi dùng sau
});

mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));

/* ===========================================================================
   HELPERS (TEXT + ITUNES + FILE)
===========================================================================*/
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
  if (!res.ok)
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);

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

/* ===========================================================================
   LABEL OVERRIDE (VOICE COMMANDS)
===========================================================================*/
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
    "mình muốn hỏi",
  ];
  if (questionKeywords.some((kw) => t.includes(kw))) {
    console.log("🔁 Label override → 'question'");
    return "question";
  }

  const rules = [
    {
      keywords: [
        "nghe bai hat",
        "nghe nhac",
        "phat nhac",
        "mo bai",
        "play",
        "music",
        "song",
        "nhạc",
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

/* ===========================================================================
   /upload_audio — STT → (Music / Chatbot) → TTS
===========================================================================*/
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload_audio", uploadLimiter, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
    fs.writeFileSync(inputFile, req.file.buffer);

    // rất ngắn → bỏ qua
    if (req.file.buffer.length < 2000) {
      try {
        fs.unlinkSync(inputFile);
      } catch { }
      return res.json({
        status: "ok",
        transcript: "",
        label: "unknown",
        audio_url: null,
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
        .on("error", (err) => reject(err))
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
      console.error("STT error:", err);
      try {
        fs.unlinkSync(inputFile);
        fs.unlinkSync(wavFile);
      } catch { }
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
          { role: "system", content: "Bạn là trợ lý của robot, nói ngắn gọn, dễ hiểu." },
          { role: "user", content: text },
        ],
      });
      replyText =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Em chưa hiểu câu này.";
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

    // publish control vs music
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

    try {
      fs.unlinkSync(inputFile);
      fs.unlinkSync(wavFile);
    } catch { }

    res.json({
      status: "ok",
      transcript: text,
      label,
      audio_url: playbackUrl,
    });
  } catch (err) {
    console.error("upload_audio error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ===========================================================================
   AUTO NAVIGATION — STATE MACHINE WITH DONE_ROTATE + WATCHDOG
===========================================================================*/

const THRESHOLD = 20;
let STATE = "idle"; // idle | wait_left_done | wait_right_done
let lastUltra = -1;
let lastLidar = -1;

// WATCHDOG chống kẹt
let stateTimer = null;

function setState(newState) {
  STATE = newState;

  if (STATE === "idle") {
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    return;
  }

  if (stateTimer) {
    clearTimeout(stateTimer);
  }
  stateTimer = setTimeout(() => {
    console.log("⏳ WATCHDOG: STATE timeout → reset về idle từ", STATE);
    STATE = "idle";
    stateTimer = null;
  }, 1500); // 1.5 giây
}

function isFrontBlocked(ultra) {
  if (typeof ultra !== "number") return false;
  if (ultra <= 0) return false; // ultra = -1 or 0 → xem như ko có vật cản
  return ultra < THRESHOLD;
}

function isLidarClear(lidar) {
  return typeof lidar === "number" && lidar >= THRESHOLD;
}

function send(topic, obj) {
  mqttClient.publish(topic, JSON.stringify(obj), { qos: 1 });
}

/* ========== SCAN STATUS (nếu bạn còn dùng) ========== */
let scanStatus = "idle";

/* ===========================================================================
   MQTT MESSAGE HANDLER (có log throttle)
===========================================================================*/
let lastLog = 0;
function throttledLog(msg) {
  const now = Date.now();
  if (now - lastLog > 300) {
    console.log(msg);
    lastLog = now;
  }
}

mqttClient.on("message", (topic, msgBuf) => {
  const msgStr = msgBuf.toString();

  // robot báo scan hoàn tất
  if (topic === "robot/scanning_done") {
    scanStatus = "done";
    console.log("📩 robot/scanning_done → scanStatus = done");
    return;
  }

  // SENSOR DATA: từ ESP32 /dieuhuongrobot
  if (topic === "/dieuhuongrobot") {
    let p;
    try {
      p = JSON.parse(msgStr);
    } catch {
      console.log("Invalid JSON on /dieuhuongrobot:", msgStr);
      return;
    }

    const phase = p.phase || "front";
    lastUltra = p.ultra_cm;
    lastLidar = p.lidar_cm;

    throttledLog(
      `📡 NAV phase=${phase} ultra=${lastUltra} lidar=${lastLidar} STATE=${STATE}`
    );

    // PHASE FRONT chỉ xử lý khi đang idle
    if (phase === "front" && STATE === "idle") {
      if (!isFrontBlocked(lastUltra)) {
        send("/robot/goahead", { action: "goahead" });
        console.log("→ FRONT CLEAR → GO AHEAD");
        return;
      }

      // blocked → yêu cầu LIDAR xoay TRÁI 45° (quét PHẢI ROBOT)
      send("robot/lidar45_turnleft", { action: "scan_right" });
      setState("wait_left_done");
      console.log("→ FRONT BLOCKED → REQUEST LIDAR TURN LEFT (SCAN RIGHT)");
      return;
    }

    // các phase khác (left45/right45) sẽ được xử lý gián tiếp qua done_*
    return;
  }

  // DONE ROTATE LEFT
  if (topic === "/done_rotate_lidarleft" && STATE === "wait_left_done") {
    console.log("✔ DONE ROTATE LEFT, lidar =", lastLidar);

    if (isLidarClear(lastLidar)) {
      // reset lidar về 110° trước khi đi
      send("robot/lidar_neutralpoint", { action: "neutral" });
      console.log("→ RESET LIDAR TO NEUTRAL");

      // quẹo phải + đi thẳng
      send("/robot/turnright45_goahead", { action: "turnright45_goahead" });
      console.log("→ RIGHT SIDE CLEAR → GOAHEAD AFTER NEUTRAL");

      setState("idle");
      return;
    }

    // phải blocked → thử LIDAR quay sang phải
    send("robot/lidar45_turnright", { action: "scan_left" });
    setState("wait_right_done");
    console.log("→ RIGHT BLOCKED → REQUEST TURN RIGHT (SCAN LEFT)");
    return;
  }

  // DONE ROTATE RIGHT
  if (topic === "/done_rotate_lidarright" && STATE === "wait_right_done") {
    console.log("✔ DONE ROTATE RIGHT, lidar =", lastLidar);

    if (isLidarClear(lastLidar)) {
      // RESET LIDAR trước khi đi
      send("robot/lidar_neutralpoint", { action: "neutral" });
      console.log("→ RESET LIDAR TO NEUTRAL");

      // quẹo trái + đi thẳng
      send("/robot/turnleft45_goahead", { action: "turnleft45_goahead" });
      console.log("→ LEFT SIDE CLEAR → GOAHEAD AFTER NEUTRAL");

      setState("idle");
      return;
    }

    // trái và phải đều blocked
    send("/robot/goback", { action: "goback" });
    send("/robot/stop", { action: "stop" });
    console.log("⛔ ALL BLOCKED → GO BACK + STOP");
    setState("idle");
    return;
  }
});

/* ===========================================================================
   CAMERA ROTATE ENDPOINT
   GET /camera_rotate?direction=left&angle=60
===========================================================================*/
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

    mqttClient.publish("/robot/camera_rotate", JSON.stringify(payload), {
      qos: 1,
    });

    console.log("📡 Sent /robot/camera_rotate →", payload);

    res.json({
      status: "ok",
      message: "Camera rotate command sent",
      topic: "/robot/camera_rotate",
      payload,
    });
  } catch (e) {
    console.error("❌ /camera_rotate error:", e.message);
    res.status(500).json({ error: "server error" });
  }
});

/* ===========================================================================
   SCAN TRIGGER ENDPOINTS (cho Flask map nếu còn dùng)
===========================================================================*/
function triggerScanEndpoint(pathUrl, payload) {
  return (req, res) => {
    try {
      const msg = JSON.stringify({
        ...payload,
        time: Date.now(),
      });

      mqttClient.publish(pathUrl, msg, { qos: 1 });

      console.log(`📡 Triggered ${payload.degree || "360"}° scan → ${pathUrl}`);

      res.json({
        status: "ok",
        message: "Scan started",
        topic: pathUrl,
        payload: JSON.parse(msg),
      });
    } catch (e) {
      console.error(`❌ Error triggering scan ${pathUrl}:`, e.message);
      res.status(500).json({ error: "Trigger failed" });
    }
  };
}

// 360°
app.get("/trigger_scan", triggerScanEndpoint("robot/scanning360", {
  action: "start_scan",
}));

// 180°
app.get("/trigger_scan180", triggerScanEndpoint("robot/scanning180", {
  action: "scan_180",
  degree: 180,
}));

// 90°
app.get("/trigger_scan90", triggerScanEndpoint("robot/scanning90", {
  action: "scan_90",
  degree: 90,
}));

// 45°
app.get("/trigger_scan45", triggerScanEndpoint("robot/scanning45", {
  action: "scan_45",
  degree: 45,
}));

// 30°
app.get("/trigger_scan30", triggerScanEndpoint("robot/scanning30", {
  action: "scan_30",
  degree: 30,
}));

// cho Flask hỏi trạng thái scan (nếu cần)
app.get("/get_scanningstatus", (req, res) => {
  try {
    res.json({ status: scanStatus });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

/* ===========================================================================
   ROOT
===========================================================================*/
app.get("/", (_, res) =>
  res.send("Node.js Audio + Chatbot + Auto Navigation Server is running!")
);

/* ===========================================================================
   START SERVER
===========================================================================*/
app.listen(PORT, () => {
  console.log(`🚀 HTTP server running on port ${PORT}`);
});
