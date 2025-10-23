// =======================
// ESP32 Audio Echo Server (DEBUG ONLY)
// - /ask: nhận file audio và trả về URL nghe lại file gốc
// - /uploads: serve các file đã upload (stream được từ client/Arduino)
// - /status, /update, / (healthcheck)
// =======================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import * as mm from "music-metadata";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// ---- Setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 8080;

// ---- Middleware
app.enable("trust proxy");
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // nếu bạn có file tĩnh khác

// ---- Dirs
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Cho phép client truy cập file gốc đã upload để nghe lại
app.use("/uploads", express.static(uploadsDir));

// ---- Status
let systemStatus = {
  state: "idle", // idle | processing | error
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

// ---- Helpers
function scheduleDelete(filePath, ms = 30 * 60 * 1000) {
  setTimeout(() => {
    fs.promises.unlink(filePath).catch(() => { });
  }, ms);
}

// ---- Multer upload
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

// ==== ROUTE: /ask (ECHO MODE) ====
// Nhận file audio và chỉ trả về link nghe lại file gốc.
// Field form-data phải là "audio" (name="audio")
app.post("/ask", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No audio file uploaded" });
    }

    updateStatus("processing", "Echo debug: received audio, returning original URL");

    // Xác định host an toàn sau proxy (Railway)
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
    const host = process.env.PUBLIC_BASE_URL || `${proto}://${req.headers.host}`;
    const originalUrl = `${host}/uploads/${path.basename(req.file.path)}`;

    // Tự xoá file sau 30 phút (đủ để debug)
    scheduleDelete(req.file.path, 30 * 60 * 1000);

    // (Tuỳ chọn) Lấy duration để đối chiếu xem file có nội dung
    let durationMs = 0;
    try {
      const meta = await mm.parseFile(req.file.path);
      durationMs = Math.round((meta.format.duration || 0) * 1000);
    } catch (_) { }

    updateStatus("idle", "Echo ready");

    return res.json({
      success: true,
      type: "echo",
      message: "Debug echo: returning uploaded audio URL only.",
      original_audio_url: originalUrl,   // Arduino có thể GET/stream URL này
      filename: path.basename(req.file.path),
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      duration_ms: durationMs
    });
  } catch (err) {
    console.error("Echo /ask error:", err);
    updateStatus("error", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Robot status (giữ nguyên để đồng bộ robot nếu cần)
app.post("/update", (req, res) => {
  const { robot_state } = req.body || {};
  if (!robot_state)
    return res.status(400).json({ success: false, error: "Missing robot_state" });

  systemStatus.last_robot_state = robot_state;
  systemStatus.last_update = new Date().toISOString();
  console.log(`🤖 Robot reported: ${robot_state}`);
  res.json({ success: true, message: `State updated: ${robot_state}` });
});

// ---- Poll status
app.get("/status", (_req, res) => res.json(systemStatus));

// ---- Health
app.get("/", (_req, res) =>
  res.send("✅ ESP32 Audio Echo Server is running (debug mode)!")
);

// ---- Start
app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
