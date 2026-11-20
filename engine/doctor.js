"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_DIRS = ["models", "uploads", "outputs", "jobs", "logs"];
const REQUIRED_MODELS = [
  { id: "mobilei2v", file: "hybrid_371.pth", minBytes: 500 * 1024 * 1024, label: "MobileI2V checkpoint" },
  { id: "turboVaed", file: "Turbo-VAED-LTX.pth", minBytes: 50 * 1024 * 1024, label: "Turbo-VAED decoder" }
];

function inspectModelFiles(modelsDir) {
  return REQUIRED_MODELS.map(model => {
    const file = path.join(modelsDir, model.file);
    let bytes = 0;
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) bytes = stat.size;
    } catch {}
    const present = bytes >= model.minBytes;
    return {
      id: model.id,
      label: model.label,
      status: present ? "pass" : bytes ? "fail" : "missing",
      file: model.file,
      bytes,
      detail: present ? "File exists and is larger than the minimum sanity threshold." :
        bytes ? "File is unexpectedly small. It may be incomplete or corrupt." : "File not found."
    };
  });
}

function inspectCompanionModels(modelsDir) {
  const qwen = path.join(modelsDir, "Qwen2-0.5B");
  const vae = path.join(modelsDir, "video-vae");
  return [
    {
      id: "qwen",
      label: "Qwen2-0.5B text encoder",
      status: fs.existsSync(qwen) && fs.statSync(qwen).isDirectory() ? "pass" : "missing",
      detail: fs.existsSync(qwen) ? "Directory found." : "Missing. The official MobileI2V config references ./model/Qwen2-0.5B."
    },
    {
      id: "vae",
      label: "Video VAE",
      status: fs.existsSync(vae) && fs.statSync(vae).isDirectory() ? "pass" : "missing",
      detail: fs.existsSync(vae) ? "Directory found." : "Missing. The official MobileI2V config references ./model/video-vae."
    }
  ];
}

function buildReport({ dataDir, runtime = {}, memory = {} }) {
  const modelsDir = path.join(dataDir, "models");
  const checks = [
    ...inspectModelFiles(modelsDir),
    ...inspectCompanionModels(modelsDir),
    {
      id: "python",
      label: "Python 3",
      status: runtime.python ? "pass" : "missing",
      detail: runtime.python || "Python 3 was not detected. Install it with: pkg install python"
    },
    {
      id: "torch",
      label: "PyTorch",
      status: runtime.torch ? "pass" : "missing",
      detail: runtime.torch ? "PyTorch " + runtime.torch + " detected." : "PyTorch is not importable in the detected Python environment."
    },
    {
      id: "cuda",
      label: "CUDA inference backend",
      status: runtime.cuda ? "pass" : "blocked",
      detail: runtime.cuda ? "CUDA is available." : "The official inference script uses CUDA. This Snapdragon/Adreno device does not expose NVIDIA CUDA."
    },
    {
      id: "onnx",
      label: "ONNX Runtime",
      status: runtime.onnx ? "pass" : "missing",
      detail: runtime.onnx ? "ONNX Runtime " + runtime.onnx + " detected." : "ONNX Runtime is not importable. Installing it alone will not convert the .pth checkpoints."
    },
    {
      id: "onnx-backends",
      label: "ONNX hardware execution providers",
      status: runtime.onnx ? "warn" : "missing",
      detail: !runtime.onnx ? "Cannot inspect providers because ONNX Runtime is unavailable." :
        (Array.isArray(runtime.onnxProviders) && runtime.onnxProviders.length
          ? "Available providers: " + runtime.onnxProviders.join(", ") + ". Provider presence does not prove this phone or model is supported."
          : "ONNX Runtime is installed, but no execution-provider list was returned. CPU execution may still be available; Qualcomm acceleration is unconfirmed.")
    },
    {
      id: "ffmpeg",
      label: "FFmpeg",
      status: runtime.ffmpeg ? "pass" : "missing",
      detail: runtime.ffmpeg ? "FFmpeg detected." : "FFmpeg was not found. Install it with: pkg install ffmpeg"
    },
    {
      id: "memory",
      label: "Available memory",
      status: Number(memory.free) >= 2 * 1024 ** 3 ? "pass" : "warn",
      detail: memory.free ? (memory.free / 1024 ** 3).toFixed(2) + " GiB currently free." : "Memory information unavailable."
    }
  ];
  const blocking = checks.filter(check => ["missing", "fail", "blocked"].includes(check.status));
  return {
    ready: blocking.length === 0,
    generatedAt: new Date().toISOString(),
    dataDir,
    checks,
    summary: blocking.length ? blocking.length + " blocking check(s). Generation remains disabled." : "Checks passed. A real inference smoke test is still required.",
    note: "File-size checks are only sanity checks, not checkpoint integrity or compatibility verification. The official PyTorch pipeline is CUDA-oriented; ONNX Runtime presence does not make .pth files runnable. QNN/NNAPI provider presence must be followed by a device-specific model smoke test."
  };
}

async function repairStorage(dataDir, options = {}) {
  const now = options.now || Date.now();
  const staleAfterMs = options.staleAfterMs || 24 * 60 * 60 * 1000;
  const repaired = [];
  for (const name of REQUIRED_DIRS) {
    const dir = path.join(dataDir, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      repaired.push("Created " + name + " directory.");
    } else if (!fs.statSync(dir).isDirectory()) {
      throw new Error("Expected a directory but found a file: " + dir);
    }
  }
  const modelsDir = path.join(dataDir, "models");
  for (const name of fs.readdirSync(modelsDir)) {
    if (!name.startsWith(".") || !name.endsWith(".part")) continue;
    const file = path.join(modelsDir, name);
    const stat = fs.statSync(file);
    if (stat.isFile() && !(options.activePartNames || []).includes(name) && now - stat.mtimeMs > staleAfterMs) {
      fs.unlinkSync(file);
      repaired.push("Removed stale partial download: " + name);
    }
  }
  if (!repaired.length) repaired.push("No safe storage repairs were needed.");
  return { ok: true, repaired };
}

module.exports = { buildReport, repairStorage, REQUIRED_DIRS, REQUIRED_MODELS };
