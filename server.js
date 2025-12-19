/* ===========================================================================
   Matthew Robot — Node.js Server (Chatbot + iTunes + Auto Navigation)
   - STT + ChatGPT / iTunes + TTS
   - Auto điều hướng với LIDAR + ULTRASONIC
   - Label override + camera + scan 360
   - IMPROVED: iTunes search (VN region) + candidates + user choice -> play immediately
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
const upload = multer({ storage: multer.memoryStorage() });

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
  requestLimitMap[ip] = requestLimitMap[ip].filter((t) => now - t < WINDOW_MS);
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

let scanStatus = "idle";

mqttClient.on("connect", () => {
  console.log("✅ MQTT connected");

  mqttClient.subscribe("/dieuhuongrobot");
  mqttClient.subscribe("robot/scanning_done");
  mqttClient.subscribe("/done_rotate_lidarleft");
  mqttClient.subscribe("/done_rotate_lidarright");
  mqttClient.subscribe("robot/audio_in");
  mqttClient.subscribe("robot/scanning180");
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
   HELPERS — text normalize, iTunes, mp3  
===========================================================================*/
function stripDiacritics(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function getClientKey(req) {
  // best-effort key per user
  const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").toString();
  return ip.split(",")[0].trim();
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

  try { fs.unlinkSync(src); } catch { }
  return `${getPublicHost()}/audio/song_${ts}.mp3`;
}

/* ------------------------------ MUSIC QUERY CLEANING ------------------------------ */
function cleanMusicQuery(q = "") {
  let t = (q || "").toLowerCase().trim();

  // remove brackets tags
  t = t.replace(/\(.*?\)|\[.*?\]/g, " ");

  // remove common junk words
  t = t.replace(/\b(official|mv|lyrics|karaoke|cover|8d|tiktok|sped\s*up|slowed|remix|ver\.?|version)\b/g, " ");

  // normalize feat
  t = t.replace(/\b(feat|ft)\.?\b/g, " ");

  // collapse
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function extractSongQuery(text) {
  // less aggressive; avoid deleting real title
  let t = cleanMusicQuery(text);
  const tNoDau = stripDiacritics(t);

  const removePhrases = [
    "xin chao",
    "toi muon nghe",
    "cho toi nghe",
    "nghe nhac",
    "phat nhac",
    "bat nhac",
    "mo bai",
    "bai hat",
    "bai nay",
    "nhac",
    "song",
    "music",
    "play",
    "please",
  ];

  let s = tNoDau;
  for (const p of removePhrases) {
    const pp = stripDiacritics(p);
    s = s.replace(new RegExp(`\\b${pp}\\b`, "g"), " ");
  }
  s = s.replace(/\s+/g, " ").trim();

  // if too short, fallback to original cleaned
  if (!s || s.length < 2) return cleanMusicQuery(text);
  return cleanMusicQuery(s);
}

// parse "artist - title", "title by artist"
function parseArtistTitle(raw = "") {
  const t = cleanMusicQuery(raw);

  const by = t.match(/(.+?)\s+by\s+(.+)/i);
  if (by) return { title: by[1].trim(), artist: by[2].trim() };

  const dash = t.split(/\s-\s|—|–|\|/).map(s => s.trim()).filter(Boolean);
  if (dash.length === 2) {
    const [a, b] = dash;
    return (a.split(" ").length <= b.split(" ").length)
      ? { artist: a, title: b }
      : { artist: b, title: a };
  }

  return { title: t };
}

function scoreItunesSong(item, { title, artist }) {
  const track = (item.trackName || "").toLowerCase();
  const art = (item.artistName || "").toLowerCase();
  const album = (item.collectionName || "").toLowerCase();

  let s = 0;
  if (title) {
    const tt = title.toLowerCase();
    if (track === tt) s += 120;
    else if (track.startsWith(tt)) s += 70;
    else if (track.includes(tt)) s += 35;
  }
  if (artist) {
    const aa = artist.toLowerCase();
    if (art === aa) s += 90;
    else if (art.includes(aa)) s += 45;
  }

  // penalties
  const bad = ["karaoke", "instrumental", "tribute", "cover", "8d"];
  for (const w of bad) if (track.includes(w) || art.includes(w) || album.includes(w)) s -= 60;

  // too short track => often wrong
  if ((item.trackTimeMillis || 0) < 60_000) s -= 12;

  // slight preference
  if (album.includes("single")) s += 4;

  return s;
}

/* ------------------------------ iTunes cache + search ------------------------------ */
const ITUNES_COUNTRY = "VN";
const ITUNES_LANG = "vi_vn";
const itunesCache = new Map(); // key -> { ts, data }
const ITUNES_CACHE_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const v = itunesCache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > ITUNES_CACHE_MS) {
    itunesCache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  itunesCache.set(key, { ts: Date.now(), data });
}

async function itunesSearchRaw(term, { limit = 25 } = {}) {
  const key = `${ITUNES_COUNTRY}|${ITUNES_LANG}|${limit}|${term}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("country", ITUNES_COUNTRY);
  url.searchParams.set("lang", ITUNES_LANG);

  const resp = await fetch(url.toString(), { timeout: 5000 });
  if (!resp.ok) return { results: [] };

  const data = await resp.json();
  cacheSet(key, data);
  return data;
}

async function searchITunesSmart(rawQuery) {
  const cleaned = cleanMusicQuery(rawQuery);
  if (!cleaned || cleaned.length < 2) return null;

  const parsed = parseArtistTitle(cleaned);

  const attempts = [];
  attempts.push({ term: cleaned, parsed });

  const nodau = stripDiacritics(cleaned);
  if (nodau && nodau !== cleaned) attempts.push({ term: nodau, parsed: parseArtistTitle(nodau) });

  const short = cleaned.split(" ").slice(0, 5).join(" ");
  if (short && short !== cleaned) attempts.push({ term: short, parsed: parseArtistTitle(short) });

  const noDash = cleaned.split(/\s-\s|—|–|\|/)[0]?.trim();
  if (noDash && noDash !== cleaned) attempts.push({ term: noDash, parsed: { title: noDash } });

  for (const att of attempts) {
    const data = await itunesSearchRaw(att.term, { limit: 25 });
    const results = Array.isArray(data.results) ? data.results : [];

    const ranked = results
      .filter(r => r.wrapperType === "track" && r.previewUrl)
      .map(r => ({ r, s: scoreItunesSong(r, att.parsed) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.r);

    if (ranked.length) {
      return {
        usedTerm: att.term,
        cleaned,
        top: ranked[0],
        candidates: ranked.slice(0, 5),
      };
    }
  }
  return null;
}

/* ------------------------------ detect user choice (bài số 2 / chọn 1 / bài thứ hai) ------------------------------ */
function detectSongChoice(text = "") {
  const t = stripDiacritics(text.toLowerCase());

  // patterns: "bai so 2", "chon 1", "so 3", "bai thu hai", "bai dau tien"
  const m1 = t.match(/\b(bai\s*so|so|chon|chọn)\s*(\d)\b/);
  if (m1) {
    const n = parseInt(m1[2], 10);
    if (n >= 1 && n <= 5) return n; // 1..5
  }

  if (t.includes("bai dau tien") || t.includes("bai 1") || t.includes("bai thu nhat")) return 1;
  if (t.includes("bai thu hai") || t.includes("bai 2")) return 2;
  if (t.includes("bai thu ba") || t.includes("bai 3")) return 3;
  if (t.includes("bai thu tu") || t.includes("bai 4")) return 4;
  if (t.includes("bai thu nam") || t.includes("bai 5")) return 5;

  return null;
}

/* ===========================================================================  
   OVERRIDE LABEL  
===========================================================================*/
function isClapText(text = "") {
  const t = stripDiacritics(text.toLowerCase());
  const keys = [
    "clap", "applause", "hand clap", "clapping",
    "vo tay", "vo tay", "tieng vo tay"
  ];
  return keys.some(k => t.includes(stripDiacritics(k)));
}

function overrideLabelByText(label, text) {
  const t = stripDiacritics(text.toLowerCase());

  const question = ["la ai", "cho toi biet", "cho toi hoi", "cau hoi", "ban co biet"];
  if (question.some((k) => t.includes(k))) return "question";

  const rules = [
    { keys: ["nhac", "music", "play", "nghe bai hat", "nghe", "phat nhac", "cho toi nghe", "bat nhac", "mo nhac"], out: "nhac" },
    { keys: ["qua trai", "xoay trai", "ben trai"], out: "trai" },
    { keys: ["qua phai", "xoay phai", "ben phai"], out: "phai" },
    { keys: ["tien", "di len"], out: "tien" },
    { keys: ["lui", "di lui"], out: "lui" },
  ];

  for (const r of rules) {
    if (r.keys.some((k) => t.includes(stripDiacritics(k)))) return r.out;
  }
  return label;
}

/* ===========================================================================  
   MEMORY: store last candidates per user (IP-based)
===========================================================================*/
const lastMusicCandidatesByUser = new Map();
// key -> { ts, candidates: [ {trackName, artistName, previewUrl, trackId, ...} ], originalQuery }

const CANDIDATES_TTL_MS = 3 * 60 * 1000;

function setLastCandidates(userKey, payload) {
  lastMusicCandidatesByUser.set(userKey, { ts: Date.now(), ...payload });
}
function getLastCandidates(userKey) {
  const v = lastMusicCandidatesByUser.get(userKey);
  if (!v) return null;
  if (Date.now() - v.ts > CANDIDATES_TTL_MS) {
    lastMusicCandidatesByUser.delete(userKey);
    return null;
  }
  return v;
}

/* ===========================================================================  
   VISION ENDPOINT (giữ nguyên phần bạn đưa)
===========================================================================*/
app.post(
  "/avoid_obstacle_vision",
  uploadVision.single("image"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No image" });
      }

      let meta = {};
      try {
        meta = req.body?.meta ? JSON.parse(req.body.meta) : {};
      } catch {
        meta = {};
      }

      const distCm = meta.lidar_cm ?? meta.ultra_cm ?? null;
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

      const b64 = req.file.buffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${b64}`;

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
  "best_sector": number,
  "walkway_center_x": number,
  "walkway_poly": [[x,y],[x,y],[x,y],[x,y]],
  "obstacles": [{"label": string, "bbox":[x1,y1,x2,y2], "risk": number}],
  "n_obstacles": number,
  "confidence": number
}
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

      let plan = null;
      try {
        plan = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}$/);
        if (m) {
          try { plan = JSON.parse(m[0]); } catch { }
        }
      }

      const fallbackCenter =
        typeof corridorCenterX === "number" ? corridorCenterX : Math.floor(roiW / 2);
      const fallbackBest = typeof localBest === "number" ? localBest : 4;
      const fallbackPoly = (() => {
        const halfW = Math.floor(roiW * 0.18);
        const x1 = Math.max(0, fallbackCenter - halfW);
        const x2 = Math.min(roiW - 1, fallbackCenter + halfW);
        const yTop = Math.floor(0.60 * roiH);
        return [[x1, roiH - 1], [x2, roiH - 1], [x2, yTop], [x1, yTop]];
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

      if (typeof plan.best_sector !== "number") plan.best_sector = fallbackBest;
      if (!Array.isArray(plan.obstacles)) plan.obstacles = [];
      if (!Array.isArray(plan.walkway_poly)) plan.walkway_poly = fallbackPoly;

      if (typeof plan.walkway_center_x !== "number") {
        try {
          const xs = plan.walkway_poly
            .map((p) => (Array.isArray(p) ? Number(p[0]) : NaN))
            .filter(Number.isFinite);
          if (xs.length) {
            const minx = Math.max(0, Math.min(...xs));
            const maxx = Math.min(roiW - 1, Math.max(...xs));
            plan.walkway_center_x = Math.floor((minx + maxx) / 2);
          } else plan.walkway_center_x = fallbackCenter;
        } catch {
          plan.walkway_center_x = fallbackCenter;
        }
      }

      plan.walkway_center_x = Math.max(0, Math.min(roiW - 1, Number(plan.walkway_center_x)));
      plan.walkway_poly = plan.walkway_poly
        .filter((p) => Array.isArray(p) && p.length === 2)
        .map((p) => {
          const x = Math.max(0, Math.min(roiW - 1, Number(p[0])));
          const y = Math.max(0, Math.min(roiH - 1, Number(p[1])));
          return [x, y];
        });

      plan.obstacles = plan.obstacles.slice(0, 12).map((o) => {
        const label = typeof o?.label === "string" ? o.label : "unknown";
        const risk = typeof o?.risk === "number" ? Math.max(0, Math.min(1, o.risk)) : 0.5;
        let bbox = o?.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) bbox = [0, 0, 0, 0];
        let [x1, y1, x2, y2] = bbox.map((v) => Number(v));
        if (![x1, y1, x2, y2].every(Number.isFinite)) x1 = y1 = x2 = y2 = 0;
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

      if (plan.confidence < 0.25) {
        plan.walkway_center_x = fallbackCenter;
        plan.walkway_poly = fallbackPoly;
        plan.best_sector = fallbackBest;
      }

      console.log("VISION PLAN:", {
        dist_cm: distCm,
        strength,
        localBest,
        corridor: { center_x: corridorCenterX, width_ratio: corridorWidthRatio, conf: corridorConf },
        best_sector: plan.best_sector,
        walkway_center_x: plan.walkway_center_x,
        confidence: plan.confidence,
        n_obstacles: plan.n_obstacles,
      });

      return res.json(plan);
    } catch (err) {
      console.error("/avoid_obstacle_vision error:", err);
      res.status(500).json({ error: err.message || "vision failed" });
    }
  }
);

/* ===========================================================================  
   UPLOAD_AUDIO — STT → (Music / Chatbot) → TTS  
===========================================================================*/
app.post(
  "/pi_upload_audio_v2",
  uploadLimiter,
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const audioFile = req.files?.audio?.[0];
      const imageFile = req.files?.image?.[0] || null;
      const userKey = getClientKey(req);

      if (!audioFile?.buffer) {
        return res.status(400).json({ error: "No audio uploaded" });
      }

      // meta (memory + info)
      let meta = {};
      try {
        meta = req.body?.meta ? JSON.parse(req.body.meta) : {};
      } catch { meta = {}; }

      const memoryArr = Array.isArray(meta.memory) ? meta.memory : [];

      // save WAV
      const wavPath = path.join(audioDir, `pi_v2_${Date.now()}.wav`);
      fs.writeFileSync(wavPath, audioFile.buffer);

      // STT
      let text = "";
      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(wavPath),
          model: "gpt-4o-mini-transcribe",
        });
        text = (tr.text || "").trim();
        console.log("🎤 PI_V2 STT:", text);
      } catch (e) {
        console.error("PI_V2 STT error:", e);
        try { fs.unlinkSync(wavPath); } catch { }
        return res.json({ status: "error", transcript: "", label: "unknown", reply_text: "", audio_url: null });
      }

      // clap short-circuit
      if (isClapText(text)) {
        console.log("👏 Detected CLAP by STT -> return label=clap");
        try { fs.unlinkSync(wavPath); } catch { }
        return res.json({ status: "ok", transcript: text, label: "clap", reply_text: "", audio_url: null, used_vision: false });
      }

      // detect if user is choosing from last candidates
      const choice = detectSongChoice(text);
      const last = getLastCandidates(userKey);

      let label = overrideLabelByText("unknown", text);

      let replyText = "";
      let playbackUrl = null;

      /* ===========================
         MUSIC: user chooses (1..5) -> play immediately
      =========================== */
      if (choice && last?.candidates?.length) {
        const idx = choice - 1;
        const picked = last.candidates[idx];
        if (picked?.previewUrl) {
          playbackUrl = await getMp3FromPreview(picked.previewUrl);
          label = "nhac";
          replyText = `Dạ ok anh, em mở "${picked.trackName}" của ${picked.artistName} nha.`;

          mqttClient.publish("/robot/vaytay", JSON.stringify({ action: "vaytay", playing: true }), { qos: 1 });

          console.log("✅ USER CHOICE -> PLAY:", { choice, track: picked.trackName, artist: picked.artistName });
        }
      }

      /* ===========================
         MUSIC: normal search flow
      =========================== */
      if (!playbackUrl && label === "nhac") {
        const query = extractSongQuery(text) || text;

        const result = await searchITunesSmart(query);

        if (result?.candidates?.length) {
          // store candidates for later selection
          setLastCandidates(userKey, {
            candidates: result.candidates.map(x => ({
              trackName: x.trackName,
              artistName: x.artistName,
              previewUrl: x.previewUrl,
              trackId: x.trackId,
            })),
            originalQuery: query,
          });

          const top = result.top;

          // If you want immediate play top1 (current behavior):
          playbackUrl = await getMp3FromPreview(top.previewUrl);
          replyText = `Dạ, em mở bài "${top.trackName}" của ${top.artistName} cho anh nhé.`;

          mqttClient.publish("/robot/vaytay", JSON.stringify({ action: "vaytay", playing: true }), { qos: 1 });

          // Optional: publish candidates list for UI
          mqttClient.publish("robot/music_candidates", JSON.stringify({
            query,
            candidates: result.candidates.map((x, i) => ({
              index: i + 1,
              trackName: x.trackName,
              artistName: x.artistName
            }))
          }), { qos: 1 });

          console.log("🎵 iTunes usedTerm:", result.usedTerm);
          console.log("🎵 Candidates:", result.candidates.map(x => `${x.trackName} - ${x.artistName}`));
        } else {
          replyText = "Em không tìm thấy bài hát phù hợp ở iTunes (VN). Anh nói lại tên bài + ca sĩ giúp em nha.";
        }
      }

      /* ===========================
         GPT (only if NOT playing music)
         - If user already chose song, we already played.
         - If user said "bài số 2" but no candidates, GPT should ask short.
      =========================== */
      const hasImage = !!imageFile?.buffer;

      if (!playbackUrl) {
        const memoryText = memoryArr
          .slice(-12)
          .map((m, i) => {
            const u = (m.transcript || "").trim();
            const a = (m.reply_text || "").trim();
            return `#${i + 1} USER: ${u}\n#${i + 1} BOT: ${a}`;
          })
          .join("\n\n");

        const system = `
Bạn là dog robot của Matthew.
Trả lời ngắn gọn, dễ hiểu, thân thiện.
Nếu user đang chọn bài hát theo số (ví dụ: "bài số 2") mà thiếu danh sách candidates thì chỉ nói: "Anh nói lại tên bài hoặc ca sĩ giúp em nha."
Nếu có hình ảnh đi kèm: bạn đã có ảnh rồi, KHÔNG được yêu cầu gửi ảnh nữa.
Nếu user hỏi nhìn/xung quanh thì mô tả thứ bạn đang thấy (không nói "từ hình ảnh").
Nếu không chắc thì nói rõ không chắc.
`.trim();

        const messages = [{ role: "system", content: system }];

        if (memoryText) {
          messages.push({ role: "system", content: `Robot long-term memory (recent):\n${memoryText}`.slice(0, 6000) });
        }

        // if user tries to choose but no candidates cached
        if (choice && !last?.candidates?.length) {
          replyText = "Anh nói lại tên bài hoặc ca sĩ giúp em nha.";
        } else if (hasImage) {
          const b64 = imageFile.buffer.toString("base64");
          const dataUrl = `data:image/jpeg;base64,${b64}`;

          const userContent = [
            { type: "text", text: `Người dùng nói: "${text}". Trả lời theo yêu cầu. Nếu có liên quan đến hình ảnh thì mô tả hình.` },
            { type: "image_url", image_url: { url: dataUrl } },
          ];

          const completion = await openai.chat.completions.create({
            model: process.env.VISION_MODEL || "gpt-4.1-mini",
            messages: [...messages, { role: "user", content: userContent }],
            temperature: 0.3,
            max_tokens: 420,
          });

          replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa thấy rõ lắm.";
        } else {
          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [...messages, { role: "user", content: text }],
            temperature: 0.4,
            max_tokens: 260,
          });

          replyText = completion.choices?.[0]?.message?.content?.trim() || "Em chưa hiểu câu này.";
        }
      }

      /* ===========================
         TTS if not music playbackUrl
      =========================== */
      if (!playbackUrl) {
        const filename = `pi_v2_tts_${Date.now()}.mp3`;
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

      /* ===========================
         publish MQTT
      =========================== */
      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
      } else {
        mqttClient.publish(
          "robot/music",
          JSON.stringify({ audio_url: playbackUrl, text: replyText, label }),
          { qos: 1 }
        );
      }

      // cleanup wav
      try { fs.unlinkSync(wavPath); } catch { }

      return res.json({
        status: "ok",
        transcript: text,
        label,
        reply_text: replyText,
        audio_url: playbackUrl,
        used_vision: hasImage,
        country: ITUNES_COUNTRY,
        lang: ITUNES_LANG,
      });
    } catch (err) {
      console.error("pi_upload_audio_v2 error:", err);
      res.status(500).json({ error: err.message || "server error" });
    }
  }
);

/* ===========================================================================  
   (Optional) Keep your old endpoints. Here I keep them but they will use the same smart search.
   If you don't need them, you can remove to simplify.
===========================================================================*/

// web upload_audio (WebM->WAV)
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

      if (req.file.buffer.length < 2000) {
        try { fs.unlinkSync(inputFile); } catch { }
        return res.json({ status: "ok", transcript: "", label: "unknown", audio_url: null });
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
      } catch (err) {
        console.error("STT error:", err);
        try { fs.unlinkSync(inputFile); fs.unlinkSync(wavFile); } catch { }
        return res.status(500).json({ error: "STT failed" });
      }

      let label = overrideLabelByText("unknown", text);

      let playbackUrl = null;
      let replyText = "";

      if (label === "nhac") {
        const query = extractSongQuery(text) || text;
        const result = await searchITunesSmart(query);

        if (result?.top?.previewUrl) {
          playbackUrl = await getMp3FromPreview(result.top.previewUrl);
          replyText = `Dạ, em mở bài "${result.top.trackName}" của ${result.top.artistName} cho anh nhé.`;
          mqttClient.publish("/robot/vaytay", JSON.stringify({ action: "vaytay", playing: true }), { qos: 1 });
        } else {
          replyText = "Em không tìm thấy bài hát phù hợp ở iTunes (VN).";
        }
      }

      if (!playbackUrl) {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: "Bạn là trợ lý của robot, trả lời ngắn gọn, dễ hiểu." },
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

        fs.writeFileSync(outPath, Buffer.from(await speech.arrayBuffer()));
        playbackUrl = `${getPublicHost()}/audio/${filename}`;
      }

      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
      } else {
        mqttClient.publish("robot/music", JSON.stringify({ audio_url: playbackUrl, text: replyText, label }), { qos: 1 });
      }

      try { fs.unlinkSync(inputFile); fs.unlinkSync(wavFile); } catch { }

      res.json({ status: "ok", transcript: text, label, audio_url: playbackUrl });
    } catch (err) {
      console.error("upload_audio error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// PI upload_audio (WAV already)
app.post(
  "/pi_upload_audio",
  uploadLimiter,
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No audio uploaded" });
      }

      const wavFile = path.join(audioDir, `pi_${Date.now()}.wav`);
      fs.writeFileSync(wavFile, req.file.buffer);

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
        return res.json({ status: "error", text: "", label: "unknown", audio_url: null });
      }

      let label = overrideLabelByText("unknown", text);

      let playbackUrl = null;
      let replyText = "";

      if (label === "nhac") {
        const query = extractSongQuery(text) || text;
        const result = await searchITunesSmart(query);

        if (result?.top?.previewUrl) {
          playbackUrl = await getMp3FromPreview(result.top.previewUrl);
          replyText = `Em mở bài "${result.top.trackName}" của ${result.top.artistName} nhé.`;
        } else {
          replyText = "Em không tìm thấy bài phù hợp ở iTunes (VN).";
        }
      }

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

      if (["tien", "lui", "trai", "phai"].includes(label)) {
        mqttClient.publish("robot/label", JSON.stringify({ label }), { qos: 1, retain: true });
      } else {
        mqttClient.publish("robot/music", JSON.stringify({ audio_url: playbackUrl, text: replyText, label }), { qos: 1 });
      }

      res.json({ status: "ok", text, label, audio_url: playbackUrl, country: ITUNES_COUNTRY, lang: ITUNES_LANG });
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
    const direction = req.query.direction || "abs";

    if (isNaN(angle) || angle < 0 || angle > 180) {
      return res.status(400).json({ error: "Angle must be 0–180" });
    }

    const payload = { angle, direction, time: Date.now() };

    mqttClient.publish("/robot/camera_rotate", JSON.stringify(payload), { qos: 1 });
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
      const msg = { ...payload, time: Date.now() };
      mqttClient.publish(pathUrl, JSON.stringify(msg), { qos: 1 });
      console.log(`📡 Triggered scan → ${pathUrl}`);
      res.json({ status: "ok", topic: pathUrl, payload: msg });
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
  console.log(`🎵 iTunes region: country=${ITUNES_COUNTRY} lang=${ITUNES_LANG}`);
});
