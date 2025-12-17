/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + iTunes + Auto Navigation)
   - STT + ChatGPT / iTunes + TTS
   - Auto điều hướng với LIDAR + ULTRASONIC (3 mode: cao / trung / thấp)
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

const uploadVision = multer({ storage: multer.memoryStorage() });
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

// PHAN COMPUTER VISION 
app.post(
  "/avoid_obstacle_vision",
  uploadVision.single("image"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No image" });
      }

      // -------- meta ----------
      let meta = {};
      try {
        meta = req.body?.meta ? JSON.parse(req.body.meta) : {};
      } catch {
        meta = {};
      }

      // Support both old + new meta keys
      const distCm = meta.lidar_cm ?? meta.ultra_cm ?? null;                 // lidar distance
      const strength = meta.lidar_strength ?? meta.uart_strength ?? null;

      const localBest =
        meta.best_sector_local ??
        meta.local_best_sector ??
        meta.local_best ??
        null;

      const corridorCenterX = meta.corridor_center_x ?? null;
      const corridorWidthRatio = meta.corridor_width_ratio ?? null;
      const corridorConf = meta.corridor_conf ?? null;

      const roiW = Number(meta.roi_w || 640);
      const roiH = Number(meta.roi_h || 240);

      // image -> base64 data url
      const b64 = req.file.buffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${b64}`;

      // -------- prompt ----------
      const system = `
Bạn là module "AvoidObstacle" cho robot đi trong nhà.
Mục tiêu: chọn hướng đi theo "lối đi dành cho người" (walkway/corridor) trong ROI.

Từ ảnh ROI (vùng gần robot):
- Xác định vật cản quan trọng (bàn/ghế/quạt/tường/đồ vật).
- Xác định lối đi (walkway) rộng và an toàn nhất để robot đi theo.
- Nếu thấy khe giữa bàn và tường có thể đi được, hãy chọn lối đó.
- Ưu tiên đánh giá near-field (nửa dưới ROI).
- Trả về JSON hợp lệ, KHÔNG giải thích.
`.trim();

      const user = [
        {
          type: "text",
          text: `
Meta:
- dist_cm: ${distCm}
- strength: ${strength}
- local_best_sector: ${localBest}
- local_corridor_center_x: ${corridorCenterX}
- local_corridor_width_ratio: ${corridorWidthRatio}
- local_corridor_conf: ${corridorConf}
ROI size: ${roiW}x${roiH}

Return JSON schema exactly:
{
  "best_sector": number,                 // 0..8
  "walkway_center_x": number,            // 0..roiW-1
  "walkway_poly": [[x,y],[x,y],[x,y],[x,y]],  // polygon vùng đi được
  "obstacles": [{"label": string, "bbox":[x1,y1,x2,y2], "risk": number}],
  "n_obstacles": number,
  "confidence": number
}

Rules:
- best_sector map 9 sectors theo chiều ngang ROI.
- walkway_center_x nằm ở trung tâm của walkway_poly.
- Nếu không chắc: confidence thấp, và chọn walkway theo local_corridor_*.
- risk 0..1: vật càng gần đáy ROI / chiếm near-field càng risk cao.
- Không bịa. Nếu không chắc label="unknown".
`.trim(),
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ];

      const model = process.env.VISION_MODEL || "gpt-4.1-mini";

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 420,
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || "";

      // -------- parse JSON best-effort ----------
      let plan = null;
      try {
        plan = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}$/);
        if (m) {
          try {
            plan = JSON.parse(m[0]);
          } catch { }
        }
      }

      // -------- smart fallback ----------
      const fallbackCenter =
        typeof corridorCenterX === "number"
          ? corridorCenterX
          : Math.floor(roiW / 2);

      const fallbackBest =
        typeof localBest === "number"
          ? localBest
          : 4;

      const fallbackPoly = (() => {
        // corridor-based rectangle in lower ROI
        const halfW = Math.floor(roiW * 0.18);
        const x1 = Math.max(0, fallbackCenter - halfW);
        const x2 = Math.min(roiW - 1, fallbackCenter + halfW);
        const yTop = Math.floor(0.60 * roiH);
        return [
          [x1, roiH - 1],
          [x2, roiH - 1],
          [x2, yTop],
          [x1, yTop],
        ];
      })();

      if (!plan || typeof plan !== "object") {
        return res.status(200).json({
          best_sector: fallbackBest,
          walkway_center_x: fallbackCenter,
          walkway_poly: fallbackPoly,
          obstacles: [],
          n_obstacles: 0,
          confidence: 0.15,
        });
      }

      // -------- normalize fields ----------
      if (typeof plan.best_sector !== "number") plan.best_sector = fallbackBest;

      if (!Array.isArray(plan.obstacles)) plan.obstacles = [];
      if (!Array.isArray(plan.walkway_poly)) {
        // backward compat: accept safe_poly too
        if (Array.isArray(plan.safe_poly)) plan.walkway_poly = plan.safe_poly;
        else plan.walkway_poly = fallbackPoly;
      }

      if (typeof plan.walkway_center_x !== "number") {
        // derive from polygon if possible
        try {
          const xs = plan.walkway_poly.map((p) => (Array.isArray(p) ? Number(p[0]) : NaN)).filter(Number.isFinite);
          if (xs.length > 0) {
            const minx = Math.max(0, Math.min(...xs));
            const maxx = Math.min(roiW - 1, Math.max(...xs));
            plan.walkway_center_x = Math.floor((minx + maxx) / 2);
          } else {
            plan.walkway_center_x = fallbackCenter;
          }
        } catch {
          plan.walkway_center_x = fallbackCenter;
        }
      }

      // clamp walkway_center_x
      plan.walkway_center_x = Math.max(0, Math.min(roiW - 1, Number(plan.walkway_center_x)));

      // clamp poly points
      plan.walkway_poly = plan.walkway_poly
        .filter((p) => Array.isArray(p) && p.length === 2)
        .map((p) => {
          const x = Math.max(0, Math.min(roiW - 1, Number(p[0])));
          const y = Math.max(0, Math.min(roiH - 1, Number(p[1])));
          return [x, y];
        });

      // clamp obstacles bbox
      plan.obstacles = plan.obstacles.slice(0, 12).map((o) => {
        const label = typeof o?.label === "string" ? o.label : "unknown";
        const risk = typeof o?.risk === "number" ? Math.max(0, Math.min(1, o.risk)) : 0.5;
        let bbox = o?.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) {
          bbox = [0, 0, 0, 0];
        }
        let [x1, y1, x2, y2] = bbox.map((v) => Number(v));
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
          x1 = y1 = x2 = y2 = 0;
        }
        x1 = Math.max(0, Math.min(roiW - 1, x1));
        x2 = Math.max(0, Math.min(roiW - 1, x2));
        y1 = Math.max(0, Math.min(roiH - 1, y1));
        y2 = Math.max(0, Math.min(roiH - 1, y2));
        if (x2 < x1) [x1, x2] = [x2, x1];
        if (y2 < y1) [y1, y2] = [y2, y1];
        return { label, bbox: [x1, y1, x2, y2], risk };
      });

      plan.n_obstacles = plan.obstacles.length;

      if (typeof plan.confidence !== "number") plan.confidence = 0.4;
      plan.confidence = Math.max(0, Math.min(1, plan.confidence));

      // optional: if confidence too low, softly fallback walkway
      if (plan.confidence < 0.25) {
        plan.walkway_center_x = fallbackCenter;
        plan.walkway_poly = fallbackPoly;
        plan.best_sector = fallbackBest;
      }

      /* ====== SERVER LOG ====== */
      console.log("VISION PLAN:", {
        dist_cm: distCm,
        strength,
        localBest,
        corridor: { center_x: corridorCenterX, width_ratio: corridorWidthRatio, conf: corridorConf },
        best_sector: plan.best_sector,
        walkway_center_x: plan.walkway_center_x,
        confidence: plan.confidence,
        n_obstacles: plan.n_obstacles,
        obstacles: plan.obstacles.map((o, i) => ({ i, label: o.label, risk: o.risk, bbox: o.bbox })),
        walkway_poly: plan.walkway_poly,
      });

      return res.json(plan);
    } catch (err) {
      console.error("/avoid_obstacle_vision error:", err);
      res.status(500).json({ error: err.message || "vision failed" });
    }
  }
);



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
  mqttClient.subscribe("robot/scanning180");
  //nhận hướng điều hướng từ ESP
  mqttClient.subscribe("robot/label");
});

mqttClient.on("message", (topic, message) => {
  try {
    const msg = message.toString();

    if (topic === "robot/label") {
      console.log("==> Robot quyết định hướng:", msg);
      return;
    }

    if (topic === "robot/scanning180") {
      console.log("==> Quyet dinh xoay 180 độ:", msg);
      return;
    }

    if (topic === "robot/scanning_done") {
      scanStatus = "done";
      return;
    }

  } catch (err) {
    console.error("MQTT message error", err);
  }
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
    "xin chao",
    "toi muon nghe",
    "nghe nhac",
    "phat nhac",
    "mo bai",
    "bai hat",
    "nhac",
    "song",
    "music",
  ];

  remove.forEach((p) => (t = t.replace(p, " ")));
  return t.replace(/\s+/g, " ").trim();
}

async function searchITunes(query) {
  if (!query) return null;

  const url = `https://itunes.apple.com/search?media=music&limit=1&term=${encodeURIComponent(
    query
  )}`;
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
    ffmpeg(src)
      .toFormat("mp3")
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

  const question = ["la ai", "là ai", "cho toi biet", "cho tôi hỏi", "hay cho toi biet", "hay cho tôi biết", "cau hoi", "ban co biet"];
  if (question.some((k) => t.includes(k))) return "question";

  const rules = [
    { keys: ["nhac", "music", "play", "nghe bai hat", "nhac", "nghe", "phat nhac", "cho toi nghe", "phat nhac", "bat nhac"], out: "nhac" },
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

        fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));

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
   API RIÊNG CHO RASPBERRY PI
   - Nhận WAV (S16_LE, mono, 16kHz)
   - Không convert WebM
===========================================================================*/

app.post(
  "/pi_upload_audio",
  uploadLimiter,
  upload.single("audio"),   // nhận field "audio"
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No audio uploaded" });
      }

      // lưu WAV vào server
      const wavFile = path.join(audioDir, `pi_${Date.now()}.wav`);
      fs.writeFileSync(wavFile, req.file.buffer);

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
        console.log("🎤 PI STT:", text);
      } catch (err) {
        console.error("PI STT error:", err);
        return res.json({
          status: "error",
          text: "",
          label: "unknown",
          audio_url: null,
        });
      }

      /* -------------------------------------------------------------
         OVERRIDE LABEL
      ------------------------------------------------------------- */
      let label = overrideLabelByText("unknown", text);

      let playbackUrl = null;
      let replyText = "";

      /* -------------------------------------------------------------
         LABEL = nhạc → iTunes
      ------------------------------------------------------------- */
      if (label === "nhac") {
        const query = extractSongQuery(text) || text;
        const m = await searchITunes(query);

        if (m?.previewUrl) {
          playbackUrl = await getMp3FromPreview(m.previewUrl);
          replyText = `Em mở bài "${m.trackName}" của ${m.artistName} nhé.`;
        } else {
          replyText = "Em không tìm thấy bài phù hợp.";
        }
      }

      /* -------------------------------------------------------------
         LABEL KHÁC → ChatGPT → TTS
      ------------------------------------------------------------- */
      if (!playbackUrl) {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: "Bạn là trợ lý robot, trả lời ngắn gọn." },
            { role: "user", content: text },
          ],
        });

        replyText = completion.choices?.[0]?.message?.content || "Em chưa hiểu.";
      }

      /* -------------------------------------------------------------
         TTS nếu cần
      ------------------------------------------------------------- */
      if (!playbackUrl) {
        const filename = `pi_tts_${Date.now()}.mp3`;
        const outPath = path.join(audioDir, filename);

        const speech = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: "ballad",
          format: "mp3",
          input: replyText,
        });

        fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));

        playbackUrl = `${getPublicHost()}/audio/${filename}`;
      }

      /* -------------------------------------------------------------
         Gửi MQTT CHO ROBOT
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
         TRẢ KẾT QUẢ CHO RASPBERRY PI
      ------------------------------------------------------------- */
      res.json({
        status: "ok",
        text,
        label,
        audio_url: playbackUrl,
      });
    } catch (err) {
      console.error("pi_upload_audio error:", err);
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
   SCAN TRIGGER ENDPOINTS (360 / 180 / 90 / 45 / 30)
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

app.get(
  "/trigger_scan",
  triggerScanEndpoint("robot/scanning360", { action: "start_scan" })
);
app.get(
  "/trigger_scan180",
  triggerScanEndpoint("robot/scanning180", { action: "scan_180" })
);
app.get(
  "/trigger_scan90",
  triggerScanEndpoint("robot/scanning90", { action: "scan_90" })
);
app.get(
  "/trigger_scan45",
  triggerScanEndpoint("robot/scanning45", { action: "scan_45" })
);
app.get(
  "/trigger_scan30",
  triggerScanEndpoint("robot/scanning30", { action: "scan_30" })
);

/* ===========================================================================  
   SCAN STATUS (CHO FLASK VIDEO SERVER HỎI)
===========================================================================*/
let scanStatus = "idle";

mqttClient.on("message", (topic) => {
  if (topic === "robot/scanning_done") scanStatus = "done";
});

app.get("/get_scanningstatus", (req, res) => {
  res.json({ status: scanStatus });
});

/* ===========================================================================  
   SIMPLE ROOT CHECK  
===========================================================================*/
app.get("/", (req, res) => {
  res.send("Matthew Robot server is running 🚀");
});

/* ===========================================================================  
   START SERVER  
===========================================================================*/
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
