"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildReport, repairStorage, selectBackend, REQUIRED_MODELS } = require("./doctor");

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "i2v-doctor-")); }

test("automatic backend selection prefers Android NNAPI then XNNPACK then CPU", () => {
  assert.equal(selectBackend({ onnxProviders: ["CPUExecutionProvider", "XnnpackExecutionProvider", "NnapiExecutionProvider"] }).id, "onnx-nnapi");
  assert.equal(selectBackend({ onnxProviders: ["CPUExecutionProvider", "XnnpackExecutionProvider"] }).id, "onnx-xnnpack");
  assert.equal(selectBackend({ onnxProviders: ["CPUExecutionProvider"] }).id, "onnx-cpu");
  assert.equal(selectBackend({ cuda: true, onnxProviders: [] }).id, "pytorch-cuda");
  assert.equal(selectBackend({}).id, "none");
});

test("model checks distinguish present, missing and suspiciously small files", () => {
  const root = tempDir();
  const models = path.join(root, "models");
  fs.mkdirSync(models);
  const largeModel = fs.openSync(path.join(models, REQUIRED_MODELS[0].file), "w");
  fs.ftruncateSync(largeModel, REQUIRED_MODELS[0].minBytes);
  fs.closeSync(largeModel);
  fs.writeFileSync(path.join(models, REQUIRED_MODELS[1].file), Buffer.alloc(12));
  const report = buildReport({ dataDir: root, runtime: {}, memory: {} });
  assert.equal(report.checks.find(x => x.id === "mobilei2v").status, "pass");
  assert.equal(report.checks.find(x => x.id === "turboVaed").status, "fail");
  fs.rmSync(root, { recursive: true, force: true });
});

test("report identifies missing companion models and CUDA blocker", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "models"));
  const report = buildReport({ dataDir: root, runtime: { python: "Python 3", torch: "2.x", cuda: false }, memory: { free: 3 * 1024 ** 3 } });
  assert.equal(report.checks.find(x => x.id === "qwen").status, "missing");
  assert.equal(report.checks.find(x => x.id === "vae").status, "missing");
  assert.equal(report.checks.find(x => x.id === "cuda").status, "blocked");
  assert.equal(report.ready, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("report exposes ONNX provider availability without claiming hardware support", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "models"));
  const report = buildReport({
    dataDir: root,
    runtime: { onnx: "1.32.0", onnxProviders: ["CPUExecutionProvider", "QNNExecutionProvider"] },
    memory: {}
  });
  const check = report.checks.find(x => x.id === "onnx-backends");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /QNNExecutionProvider/);
  assert.match(check.detail, /does not prove/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe repair creates storage folders and removes only stale partial files", async () => {
  const root = tempDir();
  const models = path.join(root, "models");
  fs.mkdirSync(models);
  const oldPart = path.join(models, ".download-old.part");
  const newPart = path.join(models, ".download-new.part");
  const keep = path.join(models, "hybrid_371.pth");
  const stalePart = path.join(models, ".download-stale.part");
  fs.writeFileSync(oldPart, "partial");
  fs.writeFileSync(newPart, "active");
  fs.writeFileSync(stalePart, "stale");
  fs.writeFileSync(keep, "model");
  const now = Date.now();
  fs.utimesSync(oldPart, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
  fs.utimesSync(newPart, new Date(now), new Date(now));
  fs.utimesSync(stalePart, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
  const result = await repairStorage(root, { now, activePartNames: [".download-old.part"] });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(oldPart), true);
  assert.equal(fs.existsSync(stalePart), false);
  assert.equal(fs.existsSync(newPart), true);
  assert.equal(fs.existsSync(keep), true);
  for (const dir of ["uploads", "outputs", "jobs", "logs"]) assert.equal(fs.existsSync(path.join(root, dir)), true);
  fs.rmSync(root, { recursive: true, force: true });
});
