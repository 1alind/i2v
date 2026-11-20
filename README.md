# Termux I2V

A local image-to-video control server designed to run directly on Android through Termux. No APK, cloud server, or WebGPU is required.

## Current status

This repository provides the local web UI, Node.js API, image upload handling, job tracking, and model directory management. The inference adapter is deliberately separated from the server.

**Important hardware/model limitation:** the original MobileI2V checkpoint is a PyTorch `.pth` model, not an ONNX model that can be loaded directly by ONNX Runtime. It also expects a compatible inference environment. Downloading that checkpoint does not automatically make it runnable on a Snapdragon 778G. A compatible Android/Termux inference backend and converted model are still required before generation can be enabled.

## Requirements

- Android ARM64 device
- Termux
- Node.js 20+

## Install

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git
termux-setup-storage
git clone https://github.com/1alind/i2v.git
cd i2v
npm install
npm start
```

Open http://127.0.0.1:9999 in the phone browser.

## Data locations

By default, files are stored in `~/i2v-data`:
- `models/`: model files, downloaded once
- `uploads/`: input images
- `outputs/`: generated videos
- `jobs/`: job state and logs

Set `I2V_DATA_DIR` to change the data directory.

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/models`
- `POST /api/upload` (multipart field: `image`)
- `POST /api/jobs` (JSON: `{ "imageId": "...", "prompt": "...", "frames": 16 }`)
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/log`

Generation returns HTTP 503 until a compatible inference adapter is installed. The server never labels a placeholder or fake video as generated output.

## Acceleration

The target is local CPU inference with optional Android accelerator support when a compatible runtime and model are available. NNAPI is an Android API, not a generic Termux GPU switch; whether it uses the Adreno GPU depends on the device driver and supported model operations. See https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html

## Security

The server binds to 127.0.0.1 only. It does not expose the API to Wi-Fi or the public internet.