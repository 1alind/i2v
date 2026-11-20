"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_DIRS = ["models", "uploads", "outputs", "jobs", "logs"];
const REQUIRED_MODELS = [
  { id: "mobilei2v", file: "hybrid_371.pth", minBytes: 500 * 1024 * 1024, label: "MobileI2V checkpoint" },
  { id: "turboVaed", file: "Turbo-VAED-LTX.pth", minBytes: 50 * 1024 * 1024, label: "Turbo-VAED decoder" }
];

function selectBackend(runtime = {}) {
  const providers = runtime.onnxProviders || [];
  if (runtime.cuda) return {
    id: "pytorch-cuda", label: "PyTorch CUDA",
    status: "candidate",
    detail: "CUDA is available. The model pipeline and required weights still need validation."
  };
  if (providers.includes("NnapiExecutionProvider")) return {
    id: "onnx-nnapi", label: "ONNX Runtime + Android NNAPI",
    status: "candidate",
    detail: "Selected as the first backend to test on Android. NNAPI may use a device accelerator or fall back; actual model support is not yet verified."
  };
  if (providers.includes("XnnpackExecutionProvider")) return {
    id: "onnx-xnnpack", label: "ONNX Runtime + XNNPACK",
    status: "candidate",
    detail: "Selected as the CPU-optimized fallback. XNNPACK is not Adreno GPU acceleration."
  };
  if (providers.includes("CPUExecutionProvider")) return {
    id: "onnx-cpu", label: "ONNX Runtime CPU",
    status: "fallback",
    detail: "Only the CPU execution provider is available. Performance may be unsuitable for video generation."
  };
  return {
    id: "none", label: "No usable inference runtime detected",
    status: "blocked",
    detail: "No supported CUDA or ONNX Runtime execution provider was detected."
  };
}

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
      id: model.id, label: model.label,
      status: present ? "pass" : bytes ? "fail" : "missing",
      file: model.file, bytes,
      detail: present ? "File exists and is larger than the minimum sanity threshold." :
        bytes ? "File is unexpectedly small. It may be incomplete or corrupt." : "File not found."
    };
  });
}

function inspectCompanionModels(modelsDir) {
  const qwen = path.join(modelsDir, "Qwen2-0.5B");
  const vae = path.join(modelsDir, "video-vae");
  return [
    { id: "qwen", label: "Qwen2-0.5B text encoder",
      status: fs.existsSync(qwen) && fs.statSync(qwen).isDirectory() ? "pass" : "missing",
      detail: fs.existsSync(qwen) ? "Directory found." : "Missing. The official MobileI2V config references ./model/Qwen2-0.5B." },
    { id: "vae", label: "Video VAE",
      status: fs.existsSync(vae) && fs.statSync(vae).isDirectory() ? "pass" : "missing",
      detail: fs.existsSync(vae) ? "Directory found." : "Missing. The official MobileI2V config references ./model/video-vae." }
  ];
}

function buildReport({ dataDir, runtime = {}, memory = {}, device = null }) {
  const modelsDir = path.join(dataDir, "models");
  const backend = selectBackend(runtime);
  const checks = [
    ...inspectModelFiles(modelsDir),
    ...inspectCompanionModels(modelsDir),
    {
      id: "device", label: "Detected device",
      status: device ? "pass" : "warn",
      detail: device ? [device.manufacturer, device.model, device.androidVersion ? "Android " + device.androidVersion : device.os,
        device.abi || device.architecture, device.cpuCores ? device.cpuCores + " CPU cores" : null,
        device.hardware ? "SoC " + device.hardware : null, device.gpuDriver ? "GPU driver " + device.gpuDriver : null]
        .filter(Boolean).join(" · ") : "Device properties could not be read."
    },
    {
      id: "python", label: "Python 3",
      status: runtime.python ? "pass" : "missing",
      detail: runtime.python || "Python 3 was not detected. Install it with: pkg install python"
    },
    {
      id: "torch", label: "PyTorch",
      status: runtime.torch ? "pass" : "missing",
      detail: runtime.torch ? "PyTorch " + runtime.torch + " detected." : "PyTorch is not importable in the detected Python environment."
    },
    {
      id: "cuda", label: "CUDA inference backend",
      status: runtime.cuda ? "pass" : "blocked",
      detail: runtime.cuda ? "CUDA is available." : "No NVIDIA CUDA device detected. The app will choose an Android-compatible runtime instead."
    },
    {
      id: "onnx", label: "ONNX Runtime",
      status: runtime.onnx ? "pass" : "missing",
      detail: runtime.onnx ? "ONNX Runtime " + runtime.onnx + " detected." : "ONNX Runtime is not importable. Installing it alone will not convert the .pth checkpoints."
    },
    {
      id: "onnx-backends", label: "ONNX execution providers",
      status: runtime.onnx ? "warn" : "missing",
      detail: !runtime.onnx ? "Cannot inspect providers because ONNX Runtime is unavailable." :
        (Array.isArray(runtime.onnxProviders) && runtime.onnxProviders.length
          ? "Available providers: " + runtime.onnxProviders.join(", ") + ". Provider presence is not proof that the model executes on them."
          : "No execution-provider list was returned.")
    },
    {
      id: "selected-backend", label: "Automatically selected backend",
      status: backend.status === "blocked" ? "blocked" : "warn",
      detail: backend.label + " · " + backend.detail
    },
    {
      id: "ffmpeg", label: "FFmpeg",
      status: runtime.ffmpeg ? "pass" : "missing",
      detail: runtime.ffmpeg ? "FFmpeg detected." : "FFmpeg was not found. Install it with: pkg install ffmpeg"
    },
    {
      id: "memory", label: "Available memory",
      status: Number(memory.free) >= 2 * 1024 ** 3 ? "pass" : "warn",
      detail: memory.free ? (memory.free / 1024 ** 3).toFixed(2) + " GiB currently free." : "Memory information unavailable."
    }
  ];
  const blocking = checks.filter(check => ["missing", "fail", "blocked"].includes(check.status));
  return {
    ready: false,
    generatedAt: new Date().toISOString(),
    dataDir,
    device,
    backend,
    checks,
    summary: blocking.length ? blocking.length + " blocking check(s). Generation remains disabled." : "Runtime detected. Model execution test and a compatible inference adapter are still required.",
    note: "The website detects this device and selects the best available runtime candidate automatically. NNAPI must be tested with the actual converted model; XNNPACK is CPU acceleration, not Adreno GPU acceleration. The existing .pth checkpoints are not ONNX models and are never modified by detection."
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

module.exports = { buildReport, repairStorage, selectBackend, REQUIRED_DIRS, REQUIRED_MODELS };
