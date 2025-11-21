/* ===========================================================================
   NODEJS SERVER — FULL FIXED VERSION (NO SPAM LIDAR, CORRECT TOPICS)
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

/* =======================================================================
   MQTT CLIENT
=======================================================================*/

const MQTT_HOST = "rfff7184.ala.us-east-1.emqxsl.com";
const MQTT_PORT = 8883;
const MQTT_USER = "robot_matthew";
const MQTT_PASS = "29061992abCD!yesokmen";

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
});

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");
  mqttClient.subscribe("/dieuhuongrobot");
});

/* =======================================================================
   AUTO-NAV LOGIC + ANTI-SPAM MECHANISM
=======================================================================*/

const THRESHOLD = 20;

/* record last command to avoid spamming */
let lastCmd = "";

/* helper: send MQTT command only if different */
function sendOnce(topic, data) {
  const key = topic + ":" + JSON.stringify(data);

  if (key === lastCmd) return; // ← prevent spam

  lastCmd = key;
  mqttClient.publish(topic, JSON.stringify(data), { qos: 1 });

  console.log("📤 MQTT:", topic, data);
}

/* === sensor helpers === */
function isFrontBlocked(ultra) {
  if (typeof ultra !== "number") return false;
  if (ultra <= 0) return false; // ultra = -1 → ignore
  return ultra < THRESHOLD;
}

function isLidarClear(lidar) {
  return typeof lidar === "number" && lidar >= THRESHOLD;
}

/* =======================================================================
   AUTO-NAV HANDLER
=======================================================================*/

mqttClient.on("message", (topic, msgBuf) => {
  if (topic !== "/dieuhuongrobot") return;

  let p;
  try { p = JSON.parse(msgBuf.toString()); }
  catch { return; }

  const phase = p.phase;
  const ultra = p.ultra_cm;
  const lidar = p.lidar_cm;

  console.log(`📡 NAV phase=${phase} ultra=${ultra} lidar=${lidar}`);

  /* ================================================================
       PHASE FRONT — USE ULTRASONIC ONLY
  ================================================================ */
  if (phase === "front") {

    if (!isFrontBlocked(ultra)) {
      sendOnce("/robot/goahead", { action: "goahead" });
      return;
    }

    // BLOCKED → ROTATE LIDAR LEFT (SCAN RIGHT)
    sendOnce("robot/lidar45_turnleft", { action: "scan_right" });
    return;
  }

  /* ================================================================
       PHASE LEFT45 — CHECK RIGHT SIDE
  ================================================================ */
  if (phase === "left45") {

    if (isLidarClear(lidar)) {
      sendOnce("/robot/turnright45_goahead",
        { action: "turnright45_goahead" }
      );
      return;
    }

    // RIGHT BLOCKED → ROTATE LIDAR RIGHT
    sendOnce("robot/lidar45_turnright", { action: "scan_left" });
    return;
  }

  /* ================================================================
       PHASE RIGHT45 — CHECK LEFT SIDE
  ================================================================ */
  if (phase === "right45") {

    if (isLidarClear(lidar)) {
      sendOnce("/robot/turnleft45_goahead",
        { action: "turnleft45_goahead" }
      );
      return;
    }

    // ALL BLOCKED → STOP
    sendOnce("/robot/goback", { action: "goback" });
    sendOnce("/robot/stop", { action: "stop" });
    return;
  }
});

/* =======================================================================
   CAMERA ROTATE ENDPOINT
=======================================================================*/

app.get("/camera_rotate", (req, res) => {
  const direction = (req.query.direction || "").toLowerCase();
  const angle = parseInt(req.query.angle || "0", 10);

  if (!["left", "right"].includes(direction))
    return res.status(400).json({ error: "direction must be left/right" });

  if (isNaN(angle) || angle < 0 || angle > 180)
    return res.status(400).json({ error: "angle must be 0-180" });

  sendOnce("/robot/camera_rotate", {
    direction, angle, time: Date.now(),
  });

  res.json({ status: "ok" });
});

/* =======================================================================
   START NODE SERVER
=======================================================================*/

app.listen(PORT, () => {
  console.log(`🚀 Node.js server running on port ${PORT}`);
});
