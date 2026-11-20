"use strict";

const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

async function property(name) {
  try {
    const { stdout } = await execFileAsync("getprop", [name], { timeout: 2500, maxBuffer: 8192 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function detectDevice() {
  const android = process.platform === "android" || Boolean(await property("ro.build.version.release"));
  const [manufacturer, brand, model, device, androidVersion, sdk, abi, hardware, gpu, glVersion] = android
    ? await Promise.all([
      property("ro.product.manufacturer"),
      property("ro.product.brand"),
      property("ro.product.model"),
      property("ro.product.device"),
      property("ro.build.version.release"),
      property("ro.build.version.sdk"),
      property("ro.product.cpu.abi"),
      property("ro.hardware"),
      property("ro.hardware.egl"),
      property("ro.opengles.version")
    ])
    : Array(10).fill(null);
  const cpus = os.cpus();
  return {
    os: android ? "Android" : process.platform,
    android,
    androidVersion,
    sdk,
    manufacturer,
    brand,
    model,
    device,
    abi: abi || process.arch,
    architecture: process.arch,
    cpuModel: cpus[0]?.model || null,
    cpuCores: cpus.length,
    hardware,
    gpuDriver: gpu,
    openGlesVersion: glVersion,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem()
  };
}

module.exports = { detectDevice };
