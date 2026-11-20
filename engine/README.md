# Inference adapter

This directory is reserved for a real local inference implementation.

The server expects a backend that can:
1. Load a model from the persistent `models/` directory.
2. Accept an uploaded image, prompt, and frame count.
3. Produce an MP4 in the persistent `outputs/` directory.
4. Report progress and errors to the job API.

Do not drop the original MobileI2V PyTorch checkpoint here and assume it will run. The published checkpoint/script is not a ready-made Termux ARM64 runtime. The backend must be ported or converted and tested against the Snapdragon 778G/Adreno 642L before the UI can enable generation.

No fake generation or placeholder video is used.


## Automatic device profiling

The server reads Android build properties through `getprop`, plus CPU architecture/core count and system memory. It reports the detected device in the Studio diagnostics panel.

The runtime planner chooses a candidate in this order:
1. PyTorch CUDA, when CUDA is genuinely available.
2. ONNX Runtime NNAPI on Android.
3. ONNX Runtime XNNPACK.
4. ONNX Runtime CPU.

This is a capability-based plan, not a claim that inference works. NNAPI provider availability does not prove that a given ONNX graph is supported or accelerated. XNNPACK is CPU execution. The actual model must pass session creation and inference before generation can be enabled.

The official MobileI2V `.pth` weights are not ONNX files. Device detection cannot safely or automatically turn those checkpoints into an Android model. Do not overwrite the original weights during conversion experiments.
