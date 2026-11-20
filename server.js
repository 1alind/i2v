"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { buildReport, repairStorage } = require("./engine/doctor");
const { detectDevice } = require("./engine/device");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 9999);
const ROOT = path.resolve(__dirname);
const UPDATE_INTERVAL_MS = 60 * 1000;
let updateCheckRunning = false;
let httpServer = null;
function requestServerRestart() {
  setTimeout(() => {
    if (!httpServer) return process.exit(75);
    httpServer.close(() => process.exit(75));
    if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
  }, 500);
}
let dependencyRepairNeeded = false;
let updateState = { status: "checking", current: null, latest: null, checkedAt: null, message: "Waiting for first update check." };
function logUpdate(message) {
  const line = "[" + new Date().toISOString() + "] " + message + "\n";
  fs.appendFileSync(path.join(DATA, "logs", "updates.log"), line);
  console.log("[update] " + message);
}
async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: ROOT, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}
async function checkForUpdates() {
  if (updateCheckRunning) return;
  updateCheckRunning = true;
  try {
    const branch = await gitOutput(["branch", "--show-current"]);
    if (!branch) throw new Error("Project is not on a named Git branch.");
    const current = await gitOutput(["rev-parse", "HEAD"]);
    updateState = { ...updateState, current, checkedAt: new Date().toISOString(), status: "checking", message: "Checking GitHub for updates." };
    await gitOutput(["fetch", "--quiet", "origin", branch]);
    const latest = await gitOutput(["rev-parse", "origin/" + branch]);
    if (latest === current) {
      if (dependencyRepairNeeded) {
        updateState = { status: "updating", current, latest, checkedAt: new Date().toISOString(), message: "Retrying dependency installation after an earlier failure." };
        logUpdate(updateState.message);
        await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--fetch-retries=5", "--fetch-timeout=180000", "--registry=https://registry.npmjs.org/"], { cwd: ROOT, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
        dependencyRepairNeeded = false;
        updateState = { status: "restarting", current, latest, checkedAt: new Date().toISOString(), message: "Dependencies repaired. Restarting server now." };
        logUpdate(updateState.message);
        requestServerRestart();
        return;
      }
      updateState = { status: "current", current, latest, checkedAt: new Date().toISOString(), message: "App is up to date." };
      return;
    }
    const status = await gitOutput(["status", "--porcelain"]);
    if (status) {
      updateState = { status: "local-changes", current, latest, checkedAt: new Date().toISOString(), message: "Update found, but local project edits exist. Automatic update paused to protect them." };
      logUpdate(updateState.message);
      return;
    }
    if ([...activeDownloads.values()].some(d => ["queued", "downloading"].includes(d.status))) {
      updateState = { status: "waiting", current, latest, checkedAt: new Date().toISOString(), message: "Update found. Waiting for model downloads to finish before updating." };
      return;
    }
    updateState = { status: "updating", current, latest, checkedAt: new Date().toISOString(), message: "New version found. Updating project files." };
    logUpdate("Update available: " + current.slice(0, 8) + " -> " + latest.slice(0, 8));
    const changed = await gitOutput(["diff", "--name-only", current, latest]);
    await gitOutput(["merge", "--ff-only", "origin/" + branch]);
    if (changed.split("\n").some(file => ["package.json", "package-lock.json"].includes(file))) {
      dependencyRepairNeeded = true;
      updateState.message = "Project updated. Installing updated dependencies before restart.";
      logUpdate(updateState.message);
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--fetch-retries=5", "--fetch-timeout=180000", "--registry=https://registry.npmjs.org/"], { cwd: ROOT, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
      dependencyRepairNeeded = false;
    }
    updateState = { status: "restarting", current: latest, latest, checkedAt: new Date().toISOString(), message: "Update installed. Restarting server now." };
    logUpdate("Update installed successfully. Restarting server.");
    requestServerRestart();
  } catch (error) {
    updateState = { ...updateState, status: "error", checkedAt: new Date().toISOString(), message: "Update check failed: " + (error.message || String(error)) };
    logUpdate(updateState.message);
  } finally {
    updateCheckRunning = false;
  }
}
const DATA = path.resolve(process.env.I2V_DATA_DIR || path.join(process.env.HOME || ROOT, "i2v-data"));
const DIRS = {
  models: path.join(DATA, "models"),
  uploads: path.join(DATA, "uploads"),
  outputs: path.join(DATA, "outputs"),
  jobs: path.join(DATA, "jobs"),
  logs: path.join(DATA, "logs")
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

app.get("/api/version", (_req, res) => {
  let current = null;
  try { current = require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
  res.set("Cache-Control", "no-store");
  res.json({ current, update: updateState, serverTime: new Date().toISOString() });
});

app.get("/api/updates/log", (_req, res) => {
  const file = path.join(DIRS.logs, "updates.log");
  res.type("text").send(fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-100).join("\n") : "No update activity yet.");
});

async function probeEngineRuntime() {
  const runtime = { python: null, torch: null, cuda: false, onnx: null, onnxProviders: [], ffmpeg: false };
  const devicePromise = detectDevice();
  try {
    const script = [
      "import importlib.util, json",
      "out = {'python': __import__('sys').version.split()[0], 'torch': None, 'cuda': False, 'onnx': None}",
      "if importlib.util.find_spec('torch'):",
      " import torch",
      " out['torch'] = torch.__version__",
      " out['cuda'] = bool(torch.cuda.is_available())",
      "if importlib.util.find_spec('onnxruntime'):",
      " import onnxruntime as ort",
      " out['onnx'] = ort.__version__",
      " out['onnx_providers'] = ort.get_available_providers()",
      "print(json.dumps(out))"
    ].join("\n");
    const { stdout } = await execFileAsync("python3", ["-c", script], { timeout: 45000, maxBuffer: 1024 * 1024 });
    const detected = JSON.parse(stdout.trim());
    Object.assign(runtime, detected);
    runtime.onnxProviders = detected.onnx_providers || [];
    delete runtime.onnx_providers;
  } catch {}
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000, maxBuffer: 256 * 1024 });
    runtime.ffmpeg = true;
  } catch {}
  runtime.device = await devicePromise;
  return runtime;
}

app.get("/api/engine/diagnostics", async (_req, res) => {
  try {
    const runtime = await probeEngineRuntime();
    const report = buildReport({
      dataDir: DATA,
      runtime,
      memory: { free: os.freemem(), total: os.totalmem() },
      device: runtime.device
    });
    res.set("Cache-Control", "no-store");
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: "Engine diagnostics failed: " + (error.message || String(error)) });
  }
});

app.post("/api/engine/repair", async (_req, res) => {
  try {
    const activePartNames = [...activeDownloads.values()].filter(d => ["queued", "downloading"].includes(d.status)).map(d => "." + d.name + "." + d.id + ".part");
    const result = await repairStorage(DATA, { activePartNames });
    const runtime = await probeEngineRuntime();
    const report = buildReport({
      dataDir: DATA,
      runtime,
      memory: { free: os.freemem(), total: os.totalmem() },
      device: runtime.device
    });
    res.json({ ...result, report });
  } catch (error) {
    res.status(500).json({ error: "Safe repair failed: " + (error.message || String(error)) });
  }
});

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

app.get("/api/setup-report", (_req, res) => {
  const file = path.join(DIRS.logs, "setup.log");
  if (!fs.existsSync(file)) return res.json({ available: false, status: "not-run", report: "", updatedAt: null });
  const stat = fs.statSync(file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const report = lines.slice(-35).join("\n");
  const failed = /SETUP FAILED|\\b(error|failed)\\b/i.test(report.split("\n").slice(-12).join("\n")) && !/All dependencies and startup checks passed/.test(report.split("\n").slice(-12).join("\n"));
  const passed = /All dependencies and startup checks passed/.test(report);
  res.json({ available: true, status: failed ? "failed" : passed ? "passed" : "running", report, updatedAt: stat.mtime.toISOString(), bytes: stat.size });
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
    .filter(x => x.isFile() || (x.isDirectory() && ["Qwen2-0.5B", "video-vae"].includes(x.name)))
    .map(x => {
      const p = path.join(DIRS.models, x.name);
      if (x.isFile()) return { name: x.name, bytes: fs.statSync(p).size };
      const total = fs.readdirSync(p).reduce((sum, file) => {
        const item = path.join(p, file);
        return sum + (fs.statSync(item).isFile() ? fs.statSync(item).size : 0);
      }, 0);
      return { name: x.name, bytes: total, directory: true };
    });
  res.json({ directory: DIRS.models, models });
});


function allowedDownloadHost(host) {
  host = host.toLowerCase();
  return host === "huggingface.co" || host.endsWith(".huggingface.co") ||
    host === "hf.co" || host.endsWith(".hf.co") ||
    host === "github.com" || host.endsWith(".github.com") ||
    host === "githubusercontent.com" || host.endsWith(".githubusercontent.com") ||
    host === "xethub.hf.co" || host.endsWith(".xethub.hf.co");
}
const activeDownloads = new Map();

const MODEL_CATALOG = [
  {
    id: "mobilei2v-checkpoint",
    name: "MobileI2V checkpoint",
    file: "hybrid_371.pth",
    url: "https://huggingface.co/hustvl/MobileI2V/resolve/main/hybrid_371.pth",
    size: "1.07 GB",
    format: "PyTorch .pth",
    category: "Image-to-video",
    status: "Experimental weights",
    description: "Official 270M MobileI2V checkpoint from HUST Vision Lab.",
    compatibility: "Not directly usable by this Termux app. The published checkpoint is PyTorch and needs the model's Python pipeline or a verified mobile conversion."
  },
  {
    id: "turbo-vaed-ltx",
    name: "Turbo-VAED LTX decoder",
    file: "Turbo-VAED-LTX.pth",
    url: "https://huggingface.co/hustvl/Turbo-VAED/resolve/main/Turbo-VAED-LTX.pth",
    size: "169 MB",
    format: "PyTorch .pth",
    category: "Video decoder",
    status: "Dependency",
    description: "Official mobile-oriented video VAE decoder variant referenced by the MobileI2V workflow.",
    compatibility: "A component only, not a standalone generator. The published file is PyTorch, not a ready-to-run Android/ONNX model."
  },
  {
    id: "ltx-video-vae",
    name: "LTX Video VAE encoder",
    folder: "video-vae",
    files: ["config.json", "diffusion_pytorch_model.safetensors"],
    size: "About 1.68 GB",
    format: "Diffusers VAE folder",
    category: "Video VAE",
    status: "Required dependency",
    description: "Official LTX Video VAE encoder used by MobileI2V to encode the input image into its video latent space.",
    compatibility: "Downloads the original LTX Video VAE config and weights into ~/i2v-data/models/video-vae. The separate Turbo-VAED-LTX.pth remains the decoder component."
  },
  {
    id: "qwen2-05b",
    name: "Qwen2-0.5B text encoder",
    folder: "Qwen2-0.5B",
    files: ["config.json", "generation_config.json", "merges.txt", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "vocab.json"],
    size: "About 1.0 GB",
    format: "Hugging Face model folder",
    category: "Text encoder",
    status: "Required dependency",
    description: "Official Qwen/Qwen2-0.5B model required by MobileI2V's published configuration.",
    compatibility: "Downloads the complete model and tokenizer files into ~/i2v-data/models/Qwen2-0.5B. This fixes the missing dependency, but does not by itself enable Android inference."
  }
];

function safeModelName(input) {
  const name = path.basename(String(input || ""));
  if (!name || name !== String(input) || name.startsWith(".") || name.length > 180 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._+() -]*$/.test(name)) return null;
  return name;
}
function publicDownload(d) {
  const elapsed = Math.max(0.001, (Date.now() - d.startedAt) / 1000);
  const speed = d.bytes / elapsed;
  const remaining = d.total > 0 ? Math.max(0, d.total - d.bytes) : null;
  return {
    id: d.id, name: d.name, status: d.status, bytes: d.bytes,
    total: d.total || null, progress: d.total > 0 ? Math.min(100, d.bytes / d.total * 100) : null,
    speed, eta: remaining !== null && speed > 0 ? remaining / speed : null,
    error: d.error || null
  };
}
async function downloadLtxVaeBundle(d, model) {
  const folder = path.join(DIRS.models, model.folder);
  const staging = path.join(DIRS.models, "." + model.folder + "." + d.id + ".part");
  try {
    if (fs.existsSync(folder)) throw new Error("The video-vae folder already exists. It was not overwritten.");
    fs.mkdirSync(staging, { recursive: false });
    d.status = "downloading";
    for (const filename of model.files) {
      if (d.controller.signal.aborted) throw new Error("Download cancelled.");
      let current = new URL("https://huggingface.co/Lightricks/LTX-Video/resolve/main/vae/" + filename);
      let response;
      for (let redirects = 0; redirects <= 8; redirects++) {
        if (current.protocol !== "https:" || !allowedDownloadHost(current.hostname)) throw new Error("Blocked unsafe model download host.");
        response = await fetch(current, { redirect: "manual", signal: d.controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Hugging Face redirected without a location.");
          current = new URL(location, current);
          continue;
        }
        break;
      }
      if (!response || !response.ok) throw new Error(filename + " download failed: HTTP " + (response ? response.status : "redirect limit"));
      const length = Number(response.headers.get("content-length") || 0);
      const destination = path.join(staging, filename);
      const temp = destination + ".part";
      const output = fs.createWriteStream(temp, { flags: "wx" });
      let fileBytes = 0;
      try {
        for await (const chunk of response.body) {
          if (d.controller.signal.aborted) throw new Error("Download cancelled.");
          fileBytes += chunk.length;
          d.bytes += chunk.length;
          if (!output.write(chunk)) await new Promise((resolve, reject) => {
            output.once("drain", resolve);
            output.once("error", reject);
          });
        }
        await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()));
        if (length && fileBytes !== length) throw new Error(filename + " was incomplete: expected " + length + " bytes, received " + fileBytes + ".");
        fs.renameSync(temp, destination);
      } catch (error) {
        output.destroy();
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw error;
      }
    }
    const config = JSON.parse(fs.readFileSync(path.join(staging, "config.json"), "utf8"));
    const weights = path.join(staging, "diffusion_pytorch_model.safetensors");
    if (config._class_name !== "AutoencoderKLLTXVideo" || config.latent_channels !== 128 ||
        !fs.existsSync(weights) || fs.statSync(weights).size < 1.5 * 1024 * 1024 * 1024) {
      throw new Error("Downloaded LTX Video VAE files failed validation. The incomplete folder was discarded.");
    }
    if (fs.existsSync(folder)) throw new Error("video-vae appeared during download. Existing folder was preserved.");
    fs.renameSync(staging, folder);
    d.total = d.bytes;
    d.status = "completed";
    d.completedAt = Date.now();
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    d.status = d.controller.signal.aborted ? "cancelled" : "failed";
    d.error = error.message || "Video VAE download failed.";
  }
}

async function downloadQwenBundle(d, model) {
  const folder = path.join(DIRS.models, model.folder);
  const staging = path.join(DIRS.models, "." + model.folder + "." + d.id + ".part");
  try {
    if (fs.existsSync(folder)) throw new Error("The Qwen2-0.5B folder already exists. It was not overwritten.");
    fs.mkdirSync(staging, { recursive: false });
    d.status = "downloading";
    for (const filename of model.files) {
      if (d.controller.signal.aborted) throw new Error("Download cancelled.");
      let current = new URL("https://huggingface.co/Qwen/Qwen2-0.5B/resolve/main/" + filename);
      let response;
      for (let redirects = 0; redirects <= 8; redirects++) {
        if (current.protocol !== "https:" || !allowedDownloadHost(current.hostname)) throw new Error("Blocked unsafe model download host.");
        response = await fetch(current, { redirect: "manual", signal: d.controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Hugging Face redirected without a location.");
          current = new URL(location, current);
          continue;
        }
        break;
      }
      if (!response || !response.ok) throw new Error(filename + " download failed: HTTP " + (response ? response.status : "redirect limit"));
      const length = Number(response.headers.get("content-length") || 0);

      const destination = path.join(staging, filename);
      const temp = destination + ".part";
      const output = fs.createWriteStream(temp, { flags: "wx" });
      let fileBytes = 0;
      try {
        for await (const chunk of response.body) {
          if (d.controller.signal.aborted) throw new Error("Download cancelled.");
          fileBytes += chunk.length;
          d.bytes += chunk.length;
          if (!output.write(chunk)) await new Promise((resolve, reject) => {
            output.once("drain", resolve);
            output.once("error", reject);
          });
        }
        await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()));
        if (length && fileBytes !== length) throw new Error(filename + " was incomplete: expected " + length + " bytes, received " + fileBytes + ".");
        fs.renameSync(temp, destination);
      } catch (error) {
        output.destroy();
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw error;
      }
    }
    const config = JSON.parse(fs.readFileSync(path.join(staging, "config.json"), "utf8"));
    if (config.model_type !== "qwen2" || !fs.existsSync(path.join(staging, "model.safetensors")) ||
        fs.statSync(path.join(staging, "model.safetensors")).size < 900 * 1024 * 1024) {
      throw new Error("Downloaded Qwen files failed validation. The incomplete folder was discarded.");
    }
    for (const filename of ["tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"]) {
      if (!fs.existsSync(path.join(staging, filename)) || fs.statSync(path.join(staging, filename)).size === 0) {
        throw new Error("Qwen tokenizer validation failed: " + filename + " is missing or empty.");
      }
    }
    if (fs.existsSync(folder)) throw new Error("Qwen2-0.5B appeared during download. Existing folder was preserved.");
    fs.renameSync(staging, folder);
    d.total = d.bytes;
    d.status = "completed";
    d.completedAt = Date.now();
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    d.status = d.controller.signal.aborted ? "cancelled" : "failed";
    d.error = error.message || "Qwen model download failed.";
  }
}

async function downloadModel(d) {
  let current = new URL(d.url);
  try {
    let response;
    for (let redirects = 0; redirects <= 8; redirects++) {
      if (current.protocol !== "https:" || !allowedDownloadHost(current.hostname)) {
        throw new Error("Only HTTPS downloads from Hugging Face or GitHub are allowed.");
      }
      response = await fetch(current, { redirect: "manual", signal: d.controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Download redirected without a location.");
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error("Download failed: HTTP " + (response ? response.status : "redirect limit"));
    const totalHeader = Number(response.headers.get("content-length") || 0);
    d.total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
    const temp = path.join(DIRS.models, "." + d.name + "." + d.id + ".part");
    const finalPath = path.join(DIRS.models, d.name);
    const file = fs.createWriteStream(temp, { flags: "wx" });
    d.status = "downloading";
    try {
      for await (const chunk of response.body) {
        if (d.controller.signal.aborted) throw new Error("Download cancelled.");
        d.bytes += chunk.length;
        if (!file.write(chunk)) await new Promise((resolve, reject) => {
          file.once("drain", resolve);
          file.once("error", reject);
        });
      }
      await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
      if (d.total && d.bytes !== d.total) throw new Error("Download ended early: expected " + d.total + " bytes, received " + d.bytes + ".");
      if (fs.existsSync(finalPath)) throw new Error("A model with this filename already exists.");
      fs.renameSync(temp, finalPath);
      d.status = "completed";
      d.completedAt = Date.now();
    } catch (err) {
      file.destroy();
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw err;
    }
  } catch (err) {
    d.status = d.controller.signal.aborted ? "cancelled" : "failed";
    d.error = err.message || "Download failed.";
  }
}

app.get("/api/catalog", (_req, res) => {
  res.json({ models: MODEL_CATALOG.map(({ url, ...model }) => model) });
});

app.post("/api/catalog/:id/download", (req, res) => {
  const model = MODEL_CATALOG.find(item => item.id === req.params.id);
  if (!model) return res.status(404).json({ error: "Catalog model not found." });
  if (model.folder) {
    const target = path.join(DIRS.models, model.folder);
    if (fs.existsSync(target)) return res.status(409).json({ error: model.folder + " already exists on this device." });
    if ([...activeDownloads.values()].some(d => d.name === model.folder && ["queued", "downloading"].includes(d.status))) {
      return res.status(409).json({ error: model.folder + " is already downloading." });
    }
    const d = { id: crypto.randomUUID(), name: model.folder, status: "queued", bytes: 0, total: 0,
      startedAt: Date.now(), controller: new AbortController(), error: null };
    activeDownloads.set(d.id, d);
    res.status(202).json(publicDownload(d));
    if (model.id === "ltx-video-vae") downloadLtxVaeBundle(d, model);
    else downloadQwenBundle(d, model);
    return;
  }
  const name = safeModelName(model.file);
  if (fs.existsSync(path.join(DIRS.models, name))) {
    return res.status(409).json({ error: "This model file is already stored on the device." });
  }
  if ([...activeDownloads.values()].some(d => d.name === name && ["queued", "downloading"].includes(d.status))) {
    return res.status(409).json({ error: "This model is already downloading." });
  }
  const d = {
    id: crypto.randomUUID(), name, url: model.url, status: "queued", bytes: 0, total: 0,
    startedAt: Date.now(), controller: new AbortController(), error: null
  };
  activeDownloads.set(d.id, d);
  res.status(202).json(publicDownload(d));
  downloadModel(d);
});

app.get("/api/downloads", (_req, res) => {
  res.json({ downloads: [...activeDownloads.values()].map(publicDownload) });
});

app.post("/api/downloads", (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Enter a valid HTTPS model file URL." }); }
  if (parsed.protocol !== "https:" || !allowedDownloadHost(parsed.hostname)) {
    return res.status(400).json({ error: "Allowed sources: Hugging Face and GitHub HTTPS file links." });
  }
  const inferred = decodeURIComponent(parsed.pathname.split("/").pop() || "");
  const name = safeModelName(req.body?.filename || inferred);
  if (!name) return res.status(400).json({ error: "Enter a safe filename without folders or special characters." });
  if (fs.existsSync(path.join(DIRS.models, name))) return res.status(409).json({ error: "That model file already exists." });
  if ([...activeDownloads.values()].some(d => d.name === name && ["queued", "downloading"].includes(d.status))) {
    return res.status(409).json({ error: "A download with that filename is already active." });
  }
  const d = {
    id: crypto.randomUUID(), name, url, status: "queued", bytes: 0, total: 0,
    startedAt: Date.now(), controller: new AbortController(), error: null
  };
  activeDownloads.set(d.id, d);
  res.status(202).json(publicDownload(d));
  downloadModel(d).finally(() => {
    if (activeDownloads.size > 30) {
      for (const [id, item] of activeDownloads) {
        if (["completed", "failed", "cancelled"].includes(item.status) && id !== d.id) activeDownloads.delete(id);
        if (activeDownloads.size <= 20) break;
      }
    }
  });
});

app.delete("/api/downloads/:id", (req, res) => {
  const d = activeDownloads.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Download not found." });
  if (!["queued", "downloading"].includes(d.status)) return res.status(409).json({ error: "Download is already finished." });
  d.controller.abort();
  res.json({ ok: true, download: publicDownload(d) });
});

app.delete("/api/models/:name", (req, res) => {
  const name = safeModelName(req.params.name);
  if (!name) return res.status(400).json({ error: "Invalid model filename." });
  const file = path.join(DIRS.models, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Model not found." });
  const stat = fs.statSync(file);
  if (stat.isDirectory() && !["Qwen2-0.5B", "video-vae"].includes(name)) return res.status(400).json({ error: "Only known model folders can be deleted." });
  if (stat.isDirectory()) fs.rmSync(file, { recursive: true, force: true });
  else fs.unlinkSync(file);
  res.json({ ok: true, deleted: name });
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

httpServer = app.listen(PORT, HOST, () => {
  console.log("Termux I2V listening on port " + PORT);
  if (HOST === "0.0.0.0" || HOST === "::") {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries || []) {
        if (net.family === "IPv4" && !net.internal) {
          console.log("Same-Wi-Fi URL: http://" + net.address + ":" + PORT);
        }
      }
    }
  } else {
    console.log("Local URL: http://" + HOST + ":" + PORT);
  }
  console.log("Data directory: " + DATA);
  console.log("Automatic GitHub updates: checking every 60 seconds.");
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_INTERVAL_MS).unref();
});
