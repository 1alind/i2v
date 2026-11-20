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
pkg update
pkg install git
git clone https://github.com/1alind/i2v.git
cd i2v
bash r.sh
```

**Automatic setup:** run `bash r.sh` for both first install and every later launch. It checks Node.js/npm versions, installs missing Termux packages, installs or repairs the project's npm dependencies, verifies that Express and Multer actually load, checks JavaScript syntax and writable storage, then starts the server. If npm installation fails, it verifies the npm cache, detects native compiler errors and installs build tools only when needed, then retries using the official npm registry. It keeps a persistent setup log at `~/i2v-data/logs/setup.log`. It does not delete model files or uploads.
Open http://127.0.0.1:9999 on the phone. The startup log also prints a `Same-Wi-Fi URL` such as `http://192.168.1.23:9999`; open that address on another device connected to the same Wi-Fi.

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
- `GET /api/models` and `DELETE /api/models/:name`
- `GET /api/downloads`, `POST /api/downloads`, and `DELETE /api/downloads/:id`
- `POST /api/upload` (multipart field: `image`)
- `POST /api/jobs` (JSON: `{ "imageId": "...", "prompt": "...", "frames": 16 }`)
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/log`

The Model Manager includes a built-in catalog with one-click downloads for the official MobileI2V checkpoint and the Turbo-VAED LTX decoder, plus an advanced custom-URL downloader. It shows download progress, transfer speed and estimated time remaining, supports cancellation, and lists/deletes stored files. Downloads are saved directly into `~/i2v-data/models`. The listed files are original PyTorch checkpoints, not verified Android/Termux runtime assets; downloading them does not enable generation.

Generation returns HTTP 503 until a compatible inference adapter is installed. The server never labels a placeholder or fake video as generated output.

## Acceleration

The target is local CPU inference with optional Android accelerator support when a compatible runtime and model are available. NNAPI is an Android API, not a generic Termux GPU switch; whether it uses the Adreno GPU depends on the device driver and supported model operations. See https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html

## Security

The server listens on all network interfaces (`0.0.0.0`) so devices on the same Wi-Fi can connect. There is currently no login or password. Only use it on a trusted private Wi-Fi network, and stop the server when finished. Do not expose port 9999 to the internet or configure router port forwarding.