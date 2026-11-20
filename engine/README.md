# Inference adapter

This directory is reserved for a real local inference implementation.

The server expects a backend that can:
1. Load a model from the persistent `models/` directory.
2. Accept an uploaded image, prompt, and frame count.
3. Produce an MP4 in the persistent `outputs/` directory.
4. Report progress and errors to the job API.

Do not drop the original MobileI2V PyTorch checkpoint here and assume it will run. The published checkpoint/script is not a ready-made Termux ARM64 runtime. The backend must be ported or converted and tested against the Snapdragon 778G/Adreno 642L before the UI can enable generation.

No fake generation or placeholder video is used.
