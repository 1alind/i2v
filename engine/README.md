# MobileI2V inference adapter

The app now calls `engine/mobilei2v_runner.py` for actual generation jobs. The runner fetches the official HUST MobileI2V source on first use, stages a private working copy, points its official pipeline at the persistent model files, and runs the upstream inference script. The original model checkpoint and upstream checkout are not modified.

Required files under `~/i2v-data/models`:
- `hybrid_371.pth`
- `Qwen2-0.5B/`
- `video-vae/`

The runner automatically installs the portable Python dependencies it needs (including Pyrallis, Diffusers, Timm, Accelerate, SafeTensors and OmegaConf) without replacing the existing PyTorch/TorchVision installation. On Termux it installs the native `opencv` package for the `cv2` module because upstream pip OpenCV wheels are not Android wheels. It intentionally does not install the upstream `requirements.txt`, because that file pins CUDA/NVIDIA packages and would replace the device's working PyTorch stack.

On devices without CUDA, the runner selects CPU and patches only the upstream inference copy to keep tensors in the configured FP32 dtype instead of forcing FP16 CPU tensors. This is an experimental compatibility path, not a performance guarantee. The A52s has not yet been verified with a completed end-to-end generation. RAM pressure or unsupported upstream dependencies may still prevent a run.

The official pipeline currently outputs 17 frames. The UI therefore exposes 17 frames rather than offering unsupported frame counts. Jobs run one at a time to avoid competing model loads and memory exhaustion. The API reports completion only after an MP4 exists.

No fake generation, placeholder video, guessed ONNX graph, or altered checkpoint is used.

## Device diagnostics

The server reads Android build properties, CPU architecture/core count and system memory. ONNX NNAPI/XNNPACK detection remains informational; this MobileI2V runner currently uses the official PyTorch pipeline and does not claim NNAPI or Adreno acceleration.
