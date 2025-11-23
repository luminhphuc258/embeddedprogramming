/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + iTunes + Auto Navigation)
   - STT + ChatGPT / iTunes + TTS
   - Auto điều hướng với LIDAR + ULTRASONIC
   - Label override + camera + scan 360
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
   RATE LIMIT (upload_audio)
===========================================================================*/
const requestLimitMap = {};
const MAX_REQ = 2;
const WINDOW_MS = 1000;

function uploadLimiter(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();

  if (!requestLimitMap[ip]) requestLimitMap[ip] = [];

  requestLimitMap[ip] = requestLimitMap[ip].filter(
    (t) => now - t < WINDOW_MS
  );

  if (requestLimitMap[ip].length >= MAX_REQ)
    return res.status(429).json({ error: "Server busy, try again" });

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
  mqttClient.subscribe("robot/audio_in");
});

/* ===========================================================================  
   HELPERS — remove dấu, iTunes, mp3  
===========================================================================*/
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function extractSongQuery(text) {
  let t = stripDiacritics(text.toLowerCase());
  const remove = [
    "xin chao", "toi muon nghe", "nghe nhac", "phat nhac", "mo bai",
    "bai hat", "nhac", "song", "music"
  ];

  remove.forEach((p) => (t = t.replace(p, " ")));
  return t.replace(/\s+/g, " ").trim();
}

async function searchITunes(query) {
  if (!query) return null;

  const url = `https://itunes.apple.com/search?media=music&limit=1&term=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data = await resp.json();
  return data.results?.[0] || null;
}

function getPublicHost() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const r = process.env.RAILWAY_STATIC_URL;
  if (r) return `https://${r}`;
  return `http://localhost:${PORT}`;
}

async function getMp3FromPreview(previewUrl) {
  const ts = Date.now();
  const src = path.join(audioDir, `song_${ts}.m4a`);
  const dst = path.join(audioDir, `song_${ts}.mp3`);

  const resp = await fetch(previewUrl);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(src, buffer);

  await new Promise((resolve, reject) =>
    ffmpeg(src).toFormat("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(dst)
  );

  fs.unlinkSync(src);
  return `${getPublicHost()}/audio/song_${ts}.mp3`;
}

/* ===========================================================================  
   OVERRIDE LABEL  
===========================================================================*/
function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  const question = ["la ai", "là ai", "cho toi biet", "cho tôi hỏi"];
  if (question.some((k) => t.includes(k))) return "question";

  const rules = [
    { keys: ["nhac", "nghe bai", "phat nhac"], out: "nhac" },
    { keys: ["qua trai", "xoay trai", "bên trái"], out: "trai" },
    { keys: ["qua phai", "xoay phải"], out: "phai" },
    { keys: ["tiến", "đi lên"], out: "tien" },
    { keys: ["lùi", "đi lùi"], out: "lui" },
  ];

  for (const r of rules)
    if (r.keys.some((k) => t.includes(stripDiacritics(k)))) return r.out;

  return label;
}
/* ===========================================================================  
   UPLOAD_AUDIO — STT → (Music / Chatbot) → TTS  
===========================================================================*/

const upload = multer({ storage: multer.memoryStorage() });

app.post(
  "/upload_audio",
  uploadLimiter,
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No audio uploaded" });
      }

      const inputFile = path.join(audioDir, `input_${Date.now()}.webm`);
      fs.writeFileSync(inputFile, req.file.buffer);

      // Nếu file quá nhỏ thì bỏ qua
      if (req.file.buffer.length < 2000) {
        try { fs.unlinkSync(inputFile); } catch { }
        return res.json({
          status: "ok",
          transcript: "",
          label: "unknown",
          audio_url: null,
        });
      }

      const wavFile = inputFile.replace(".webm", ".wav");

      /* -------------------------------------------------------------
         CHUYỂN WEBM → WAV (16kHz, mono)
      ------------------------------------------------------------- */
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

      /* -------------------------------------------------------------
         STT → TEXT
      ------------------------------------------------------------- */
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

      /* -------------------------------------------------------------
         OVERRIDE LABEL (nhạc / hướng / câu hỏi)
      ------------------------------------------------------------- */
      let label = overrideLabelByText("unknown", text);

      let playbackUrl = null;
      let replyText = "";

      /* -------------------------------------------------------------
         LABEL = "nhac" → tìm iTunes → convert mp3 → publish MQTT
      ------------------------------------------------------------- */
      if (label === "nhac") {
        const query = extractSongQuery(text) || text;
        const musicMeta = await searchITunes(query);

        if (musicMeta?.previewUrl) {
          playbackUrl = await getMp3FromPreview(musicMeta.previewUrl);

          replyText = `Dạ, em mở bài "${musicMeta.trackName}" của ${musicMeta.artistName} cho anh nhé.`;

          // Gửi tín hiệu robot vẫy tay khi bật nhạc
          mqttClient.publish(
            "/robot/vaytay",
            JSON.stringify({ action: "vaytay", playing: true }),
            { qos: 1 }
          );

          console.log("🎵 Sent /robot/vaytay");
        } else {
          replyText = "Em không tìm thấy bài hát phù hợp.";
        }
      }

      /* -------------------------------------------------------------
         LABEL KHÁC "nhac" → Chatbot → TTS
      ------------------------------------------------------------- */
      if (label !== "nhac") {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content: "Bạn là trợ lý của robot, trả lời ngắn gọn, dễ hiểu.",
            },
            { role: "user", content: text },
          ],
        });

        replyText =
          completion.choices?.[0]?.message?.content?.trim() ||
          "Em chưa hiểu câu này.";
      }

      /* -------------------------------------------------------------
         TTS (nếu KHÔNG phải nhạc)
      ------------------------------------------------------------- */
      if (!playbackUrl) {
        const filename = `tts_${Date.now()}.mp3`;
        const outPath = path.join(audioDir, filename);

        const speech = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: "ballad",
          format: "mp3",
          input: replyText,
        });

        fs.writeFileSync(
          outPath,
          Buffer.from(await speech.arrayBuffer())
        );

        playbackUrl = `${getPublicHost()}/audio/${filename}`;
      }

      /* -------------------------------------------------------------
         GỬI MQTT CHO ROBOT (movement hoặc music)
      ------------------------------------------------------------- */
      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish(
          "robot/label",
          JSON.stringify({ label }),
          { qos: 1, retain: true }
        );
      } else {
        mqttClient.publish(
          "robot/music",
          JSON.stringify({
            audio_url: playbackUrl,
            text: replyText,
            label,
          }),
          { qos: 1 }
        );
      }

      /* -------------------------------------------------------------
         Xóa file tạm
      ------------------------------------------------------------- */
      try {
        fs.unlinkSync(inputFile);
        fs.unlinkSync(wavFile);
      } catch { }

      /* -------------------------------------------------------------
         TRẢ KẾT QUẢ CHO CLIENT
      ------------------------------------------------------------- */
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
  }
);

/* ===========================================================================  
   CAMERA ROTATE ENDPOINT  
===========================================================================*/
app.get("/camera_rotate", (req, res) => {
  try {
    const angle = parseInt(req.query.angle || "0", 10);
    const direction = req.query.direction || "abs"; // tuyệt đối

    if (isNaN(angle) || angle < 0 || angle > 180) {
      return res.status(400).json({ error: "Angle must be 0–180" });
    }

    const payload = { angle, direction, time: Date.now() };

    mqttClient.publish(
      "/robot/camera_rotate",
      JSON.stringify(payload),
      { qos: 1 }
    );

    console.log("📡 Sent /robot/camera_rotate →", payload);

    res.json({ status: "ok", payload });
  } catch (e) {
    console.error("/camera_rotate error:", e);
    res.status(500).json({ error: "server error" });
  }
});

/* ===========================================================================  
   SCAN TRIGGER ENDPOINTS  
===========================================================================*/

function triggerScanEndpoint(pathUrl, payload) {
  return (req, res) => {
    try {
      const msg = {
        ...payload,
        time: Date.now(),
      };

      mqttClient.publish(pathUrl, JSON.stringify(msg), { qos: 1 });

      console.log(`📡 Triggered scan → ${pathUrl}`);

      res.json({
        status: "ok",
        topic: pathUrl,
        payload: msg,
      });
    } catch (e) {
      res.status(500).json({ error: "Trigger failed" });
    }
  };
}

app.get("/trigger_scan", triggerScanEndpoint("robot/scanning360", { action: "start_scan" }));
app.get("/trigger_scan180", triggerScanEndpoint("robot/scanning180", { action: "scan_180" }));
app.get("/trigger_scan90", triggerScanEndpoint("robot/scanning90", { action: "scan_90" }));
app.get("/trigger_scan45", triggerScanEndpoint("robot/scanning45", { action: "scan_45" }));
app.get("/trigger_scan30", triggerScanEndpoint("robot/scanning30", { action: "scan_30" }));

/* ===========================================================================  
   SCAN STATUS  
===========================================================================*/
let scanStatus = "idle";

mqttClient.on("message", (topic) => {
  if (topic === "robot/scanning_done") scanStatus = "done";
});

app.get("/get_scanningstatus", (req, res) => {
  res.json({ status: scanStatus });
});
/* ===========================================================================
   AUTO NAVIGATION — NEW LOGIC (FINAL VERSION)
   REQUIREMENTS:
   - Ngưỡng LIDAR: 55 cm
   - Khi blocked:
       1. STOP
       2. Turn LEFT 45°
       3. Wait 500ms → check again
          - Nếu clear → đi tiếp
          - Nếu blocked →
                4. Lùi 500ms
                5. Turn RIGHT 45°
                6. Wait 500ms
                   - Nếu clear → đi tiếp
                   - Nếu blocked →
                        7. Kiểm tra ultrasonic sau
                        8. Nếu sau <50 cm hoặc = -1 → lùi 500ms rồi STOP
                        9. Quay 360°
                        10. Nếu vẫn blocked → HARD_BLOCK
===========================================================================*/

const LIDAR_THRESHOLD = 55;       // cm phía trước
const ULTRA_BACK_THRESHOLD = 50;  // cm phía sau

let lastUltra = -1;   // ultrasonic sau
let lastLidar = -1;   // lidar trước

let HARD_BLOCK = false;  // robot bị kẹt hoàn toàn

function sendCmd(topic, action) {
  mqttClient.publish(topic, JSON.stringify({ action }), { qos: 1 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lidarBlocked() {
  return lastLidar > 0 && lastLidar < LIDAR_THRESHOLD;
}

function lidarClear() {
  return lastLidar >= LIDAR_THRESHOLD;
}

function ultraBlocked() {
  return lastUltra > 0 && lastUltra < ULTRA_BACK_THRESHOLD;
}

function ultraUndefined() {
  return lastUltra === undefined;
}

mqttClient.on("message", async (topic, buf) => {
  if (topic !== "/dieuhuongrobot") return;

  let p;
  try {
    p = JSON.parse(buf.toString());
  } catch {
    console.log("❌ Sensor JSON invalid:", buf.toString());
    return;
  }

  lastLidar = p.lidar_cm;
  lastUltra = p.ultra_cm;

  console.log(
    `📡 NAV: LIDAR=${lastLidar}cm ULTRA=${lastUltra}cm HARD_BLOCK=${HARD_BLOCK}`
  );

  /* ==========================================================
        CASE: HARD BLOCK MODE
     ==========================================================*/
  if (HARD_BLOCK) {
    if (!lidarClear()) {
      console.log("⛔ HARD BLOCK → ROBOT MUST STOP");
      sendCmd("/robot/stop", "stop");
      return;
    }

    console.log("✔ LIDAR CLEAR AGAIN → EXIT HARD BLOCK");
    HARD_BLOCK = false;
  }

  /* ==========================================================
        CASE: ĐƯỜNG TRƯỚC RÕ → ĐI THẲNG
     ==========================================================*/
  if (!lidarBlocked()) {
    sendCmd("/robot/goahead", "goahead");
    return;
  }

  /* ==========================================================
        CASE: BỊ CHẶN — BẮT ĐẦU LOGIC TRÁNH VẬT CẢN
     ==========================================================*/

  console.log("⛔ BLOCKED FRONT → STOP");
  sendCmd("/robot/stop", "stop");

  // STEP 1: QUAY TRÁI 45°
  console.log("↩️ TURN LEFT 45°");
  sendCmd("/robot/turnleft45", "turnleft45");
  await delay(500);

  if (lidarClear()) {
    console.log("✔ LEFT CLEAR → GO AHEAD");
    sendCmd("/robot/goahead", "goahead");
    return;
  }

  // STEP 2: LÙI 500MS
  console.log("↩️ REVERSE 500ms");
  sendCmd("/robot/goback", "goback");
  await delay(500);
  sendCmd("/robot/stop", "stop");

  // STEP 3: XOAY PHẢI 45°
  console.log("↪️ TURN RIGHT 45°");
  sendCmd("/robot/turnright45", "turnright45");
  await delay(500);

  if (lidarClear()) {
    console.log("✔ RIGHT CLEAR → GO");
    sendCmd("/robot/goahead", "goahead");
    return;
  }

  // STEP 4: HAI BÊN + TRƯỚC ĐỀU KẸT → CHECK SAU
  console.log("🔥 BOTH SIDES BLOCKED → CHECK ULTRASONIC BACK");

  if (ultraUndefined()) {
    console.log("⛔ ULTRASONIC UNDEFINED → HARD BLOCK");
    sendCmd("/robot/stop", "stop");
    HARD_BLOCK = true;
    return;
  }

  if (!ultraBlocked() || lastUltra === -1) {
    console.log("↩️ BACK CLEAR OR -1 → REVERSE 500ms");
    sendCmd("/robot/goback", "goback");
    await delay(500);
    sendCmd("/robot/stop", "stop");
  } else {
    console.log("⛔ BACK ALSO BLOCKED → STOP");
    sendCmd("/robot/stop", "stop");
  }

  // STEP 5: XOAY 360°
  console.log("🔄 TURN FULL 360°");
  sendCmd("/robot/turn360", "turn360");
  await delay(500);

  // STEP 6: SAU 360° → KIỂM TRA LẠI LIDAR
  if (lidarBlocked()) {
    console.log("⛔ STILL BLOCKED AFTER 360° → HARD BLOCK");
    sendCmd("/robot/stop", "stop");
    HARD_BLOCK = true;
    return;
  }

  console.log("✔ CLEAR AFTER 360° → MOVE FORWARD");
  sendCmd("/robot/goahead", "goahead");
});
