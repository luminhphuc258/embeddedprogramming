/* ===========================================================================
   NODEJS SERVER — FIXED VERSION (CORRECT LIDAR TOPICS)
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

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  }
}));

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
  password: MQTT_PASS
});

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");
  mqttClient.subscribe("/dieuhuongrobot");
  mqttClient.subscribe("robot/scanning_done");
});

mqttClient.on("error", err => console.error("❌ MQTT error:", err));

/* ===========================================================================
   AUTO-NAVIGATION LOGIC (FIXED)
===========================================================================*/

const THRESHOLD = 20;

/* ULTRA LOGIC */
function isFrontBlocked(ultra) {
  if (typeof ultra !== "number") return false;
  if (ultra <= 0) return false;  // ultra = -1 => ignore
  return ultra < THRESHOLD;
}

/* LIDAR LOGIC */
function isLidarClear(lidar) {
  return typeof lidar === "number" && lidar >= THRESHOLD;
}

mqttClient.on("message", (topic, msgBuf) => {
  if (topic !== "/dieuhuongrobot") return;

  let payload;
  try { payload = JSON.parse(msgBuf.toString()); }
  catch { return; }

  const phase = payload.phase;
  const lidar = payload.lidar_cm;
  const ultra = payload.ultra_cm;

  console.log(`📡 NAVIGATION phase=${phase} ultra=${ultra} lidar=${lidar}`);

  /* ===========================================================================
      PHASE 1 — FRONT -> ONLY ULTRASONIC
  ===========================================================================*/

  if (phase === "front") {

    if (!isFrontBlocked(ultra)) {
      mqttClient.publish("/robot/goahead", JSON.stringify({ action: "goahead" }), { qos: 1 });
      console.log("→ FRONT CLEAR → GO AHEAD");
      return;
    }

    // BLOCKED → SCAN RIGHT (LIDAR TURN LEFT)
    mqttClient.publish(
      "robot/lidar45_turnleft",
      JSON.stringify({ action: "scan_right" }),
      { qos: 1 }
    );
    console.log("→ FRONT BLOCKED → LIDAR TURN LEFT (SCAN RIGHT)");
    return;
  }

  /* ===========================================================================
      PHASE 2 — LEFT45 CHECK (SCAN RIGHT SIDE)
  ===========================================================================*/

  if (phase === "left45") {

    if (isLidarClear(lidar)) {
      mqttClient.publish("/robot/turnright45_goahead",
        JSON.stringify({ action: "turnright45_goahead" }),
        { qos: 1 }
      );
      console.log("→ RIGHT SIDE CLEAR → TURN RIGHT + GOAHEAD");
      return;
    }

    // RIGHT BLOCKED → SCAN LEFT SIDE
    mqttClient.publish(
      "robot/lidar45_turnright",
      JSON.stringify({ action: "scan_left" }),
      { qos: 1 }
    );
    console.log("→ RIGHT BLOCKED → LIDAR TURN RIGHT (SCAN LEFT)");
    return;
  }

  /* ===========================================================================
      PHASE 3 — RIGHT45 CHECK (SCAN LEFT SIDE)
  ===========================================================================*/

  if (phase === "right45") {

    if (isLidarClear(lidar)) {
      mqttClient.publish(
        "/robot/turnleft45_goahead",
        JSON.stringify({ action: "turnleft45_goahead" }),
        { qos: 1 }
      );
      console.log("→ LEFT SIDE CLEAR → TURN LEFT + GOAHEAD");
      return;
    }

    // ALL BLOCKED → GO BACK + STOP
    mqttClient.publish("/robot/goback", JSON.stringify({ action: "goback" }), { qos: 1 });
    mqttClient.publish("/robot/stop", JSON.stringify({ action: "stop" }), { qos: 1 });

    console.log("⛔ BOTH SIDES BLOCKED → GO BACK + STOP");
    return;
  }
});

/* ===========================================================================
   CAMERA ROTATE ENDPOINT
===========================================================================*/
app.get("/camera_rotate", (req, res) => {
  const direction = (req.query.direction || "").toLowerCase();
  const angle = parseInt(req.query.angle || "0", 10);

  if (!["left", "right"].includes(direction))
    return res.status(400).json({ error: "direction must be left/right" });

  if (isNaN(angle) || angle < 0 || angle > 180)
    return res.status(400).json({ error: "angle must be 0-180" });

  const payload = { direction, angle, time: Date.now() };

  mqttClient.publish("/robot/camera_rotate", JSON.stringify(payload), { qos: 1 });

  res.json({ status: "ok", payload });
});

/* ===========================================================================
   START SERVER
===========================================================================*/
app.listen(PORT, () => {
  console.log(`🚀 Node.js server running on port ${PORT}`);
});
