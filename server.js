"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 9999);
const ROOT = path.resolve(__dirname);
const DATA = path.resolve(process.env.I2V_DATA_DIR || path.join(process.env.HOME || ROOT, "i2v-data"));
const DIRS = {
  models: path.join(DATA, "models"),
  uploads: path.join(DATA, "uploads"),
  outputs: path.join(DATA, "outputs"),
  jobs: path.join(DATA, "jobs")
};

for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DIRS.uploads),
  filename: (_req, file, cb) => {
    const ext = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" })[file.mimetype];
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  }
});

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function jobFile(id) { return path.join(DIRS.jobs, id + ".json"); }

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "termux-i2v",
    host: HOST,
    port: PORT,
    dataDir: DATA,
    inference: { available: false, reason: "No compatible local inference adapter is installed." }
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    port: PORT,
    maxUploadBytes: 15 * 1024 * 1024,
    acceptedImages: ["image/jpeg", "image/png", "image/webp"],
    paths: Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [k, v])),
    generationReady: false
  });
});

app.get("/api/models", (_req, res) => {
  const models = fs.readdirSync(DIRS.models, { withFileTypes: true })
    .filter(x => x.isFile())
    .map(x => {
      const p = path.join(DIRS.models, x.name);
      const st = fs.statSync(p);
      return { name: x.name, bytes: st.size };
    });
  res.json({ directory: DIRS.models, models });
});

app.post("/api/upload", (req, res) => {
  upload.single("image")(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed" });
    if (!req.file) return res.status(400).json({ error: "Choose a JPG, PNG, or WebP image." });
    res.status(201).json({
      imageId: req.file.filename,
      name: req.file.originalname,
      bytes: req.file.size,
      mime: req.file.mimetype
    });
  });
});

app.post("/api/jobs", (req, res) => {
  const { imageId, prompt = "", frames = 16 } = req.body || {};
  if (!imageId || typeof imageId !== "string" || path.basename(imageId) !== imageId) {
    return res.status(400).json({ error: "A valid uploaded imageId is required." });
  }
  if (!fs.existsSync(path.join(DIRS.uploads, imageId))) {
    return res.status(404).json({ error: "Uploaded image not found." });
  }
  if (typeof prompt !== "string" || prompt.length > 1000) {
    return res.status(400).json({ error: "Prompt must be a string under 1000 characters." });
  }
  if (!Number.isInteger(frames) || frames < 8 || frames > 32) {
    return res.status(400).json({ error: "Frames must be an integer between 8 and 32." });
  }

  const job = {
    id: crypto.randomUUID(),
    status: "blocked",
    createdAt: new Date().toISOString(),
    imageId,
    prompt,
    frames,
    progress: 0,
    message: "Generation is unavailable: no compatible inference adapter is installed.",
    output: null
  };
  writeJson(jobFile(job.id), job);
  res.status(503).json({
    error: "Inference backend is not installed.",
    job,
    details: "The web server and upload pipeline are ready, but this repository does not yet contain a model/runtime combination verified for Termux ARM64 and the Adreno 642L."
  });
});

app.get("/api/jobs/:id", (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
  const file = jobFile(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Job not found." });
  res.json(readJson(file, { error: "Could not read job." }));
});

app.get("/api/jobs/:id/log", (req, res) => {
  const file = jobFile(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).type("text").send("Job not found.");
  const job = readJson(file, {});
  res.type("text").send([
    "Job: " + job.id,
    "Status: " + job.status,
    "Created: " + job.createdAt,
    "Message: " + job.message
  ].join("\n"));
});

app.get("/outputs/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(DIRS.outputs, name);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.sendFile(file);
});

app.listen(PORT, HOST, () => {
  console.log("Termux I2V listening at http://" + HOST + ":" + PORT);
  console.log("Data directory: " + DATA);
});
