#!/usr/bin/env python3
"""Run the upstream MobileI2V pipeline against files in the persistent i2v data dir.

This deliberately uses the official model implementation. It does not export guessed
ONNX graphs or synthesize placeholder videos.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback

UPSTREAM = "https://github.com/hustvl/MobileI2V.git"

def emit(kind, **fields):
    print(json.dumps({"event": kind, **fields}), flush=True)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--prompt", default="")
    p.add_argument("--job", required=True)
    args = p.parse_args()

    data = Path(args.data).resolve()
    image = Path(args.image).resolve()
    models = data / "models"
    runtime = data / "runtime"
    repo = runtime / "MobileI2V"
    output = data / "outputs" / args.job
    output.mkdir(parents=True, exist_ok=True)

    if not image.is_file():
        raise RuntimeError("Uploaded input image does not exist.")
    checkpoint = models / "hybrid_371.pth"
    qwen = models / "Qwen2-0.5B"
    vae = models / "video-vae"
    for path, label in [(checkpoint, "MobileI2V checkpoint"), (qwen, "Qwen2-0.5B text encoder"), (vae, "LTX Video VAE")]:
        if not path.exists():
            raise RuntimeError(f"Missing {label}: {path}")

    runtime.mkdir(parents=True, exist_ok=True)
    if not repo.exists():
        emit("progress", message="Fetching the official HUST MobileI2V source…")
        subprocess.run(["git", "clone", "--depth", "1", UPSTREAM, str(repo)], check=True)
    elif not (repo / "scripts" / "inference_i2v.py").is_file():
        raise RuntimeError("The cached MobileI2V source folder is incomplete. Remove i2v-data/runtime/MobileI2V and retry.")

    # Install only the portable Python dependencies used by the official inference
    # path. Never install upstream requirements.txt: it pins CUDA wheels and replaces
    # the device's existing PyTorch build.
    portable = {
        "pyrallis": "pyrallis==0.3.1",
        "diffusers": "diffusers==0.35.2",
        "timm": "timm==1.0.20",
        "accelerate": "accelerate==1.1.0",
        "safetensors": "safetensors>=0.6.2",
        "omegaconf": "omegaconf==2.3.0",
    }
    def module_exists(module):
        try:
            return importlib.util.find_spec(module) is not None
        except (ImportError, ValueError, AttributeError):
            return False

    def pip_attempt(package, no_deps=False):
        cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir"]
        if no_deps:
            cmd.append("--no-deps")
        cmd.append(package)
        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT)
        if result.returncode:
            detail = (result.stdout or "")[-1800:]
            emit("warning", message=f"Install attempt failed for {package}"
                 + (" (dependency-free fallback)" if no_deps else "")
                 + ": " + detail[-900:])
        return result.returncode == 0

    # Android is not a supported psutil build target. Some otherwise portable
    # packages (notably accelerate) declare psutil as an unconditional dependency.
    # Install normally first, then retry without dependency resolution when the
    # platform rejects a transitive package. Existing torch/torchvision are never
    # upgraded or replaced.
    missing_portable = [(module, package) for module, package in portable.items()
                        if not module_exists(module)]
    for module, package in missing_portable:
        emit("progress", message=f"Installing Python dependency: {package}")
        if not pip_attempt(package):
            emit("progress", message=f"Retrying {package} without optional dependency resolution…")
            if not pip_attempt(package, no_deps=True):
                raise RuntimeError(f"Could not install {package}, including the Android-safe fallback. "
                                   "See the preceding installation warning for the exact pip error.")
        if not module_exists(module):
            raise RuntimeError(f"pip reported success for {package}, but Python still cannot import {module}.")

    # OpenCV's pip wheels are not built for Termux/Android. Use the native Termux
    # package, which supplies the cv2 Python module for the Termux interpreter.
    if not module_exists("cv2") and shutil.which("pkg"):
        emit("progress", message="Installing native Termux OpenCV package…")
        cv_result = subprocess.run(["pkg", "install", "-y", "opencv"], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if cv_result.returncode or not module_exists("cv2"):
            emit("warning", message="Termux OpenCV install did not complete; refreshing package indexes and retrying. "
                 + (cv_result.stdout or "")[-1000:])
            subprocess.run(["pkg", "update", "-y"], check=False,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            cv_result = subprocess.run(["pkg", "install", "-y", "opencv"], text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if cv_result.returncode or not module_exists("cv2"):
            raise RuntimeError("Could not install/import cv2 from the native Termux opencv package. "
                               + (cv_result.stdout or "")[-1400:])

    required = ["torch", "torchvision", "PIL", "yaml", "pyrallis", "einops", "cv2",
                "transformers", "diffusers", "timm", "safetensors", "accelerate", "omegaconf"]
    missing = [name for name in required if importlib.util.find_spec(name) is None]
    if missing:
        raise RuntimeError("Still missing after automatic dependency setup: " + ", ".join(missing) +
                           ". The Termux OpenCV package or a Python dependency could not be installed.")

    import torch
    if torch.cuda.is_available():
        device_mode = "cuda"
    else:
        device_mode = "cpu"
    emit("progress", message=f"Preparing official MobileI2V inference on {device_mode.upper()}.")

    # Work on a private copy so upstream files remain untouched.
    work = runtime / ("run-" + args.job)
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(repo, work, ignore=shutil.ignore_patterns(".git", "output", "test_video"))
    script = work / "scripts" / "inference_i2v.py"
    source = script.read_text()
    source = source.replace("z = z.half()", "z = z.to(dtype=weight_dtype)")
    source = source.replace("ref_image = ref_image.half()", "ref_image = ref_image.to(dtype=weight_dtype)")
    source = source.replace("        torch.cuda.empty_cache()", "        if torch.cuda.is_available():\n            torch.cuda.empty_cache()")
    script.write_text(source)

    config_path = work / "configs" / "mobilei2v_config" / "MobileI2V_300M_img512.yaml"
    import yaml
    config = yaml.safe_load(config_path.read_text())
    config["txt_file"] = str(work / "asset" / ("input-" + args.job + ".txt"))
    config["model_path"] = str(checkpoint)
    config["save_path"] = str(output)
    config["prompt"] = args.prompt or "Animate the scene naturally with subtle realistic motion."
    config["flow_score"] = 2.0
    config["vae"]["vae_pretrained"] = str(vae)
    config["text_encoder"]["text_encoder_name"] = str(qwen)
    if device_mode == "cpu":
        config["model"]["mixed_precision"] = "fp32"
        config["vae"]["weight_dtype"] = "fp32"
    config_path.write_text(yaml.safe_dump(config, sort_keys=False))
    input_list = work / "asset" / ("input-" + args.job + ".txt")
    input_list.parent.mkdir(parents=True, exist_ok=True)
    input_list.write_text(str(image) + "\n")

    emit("progress", message="Loading Qwen, LTX VAE and MobileI2V weights. First run may take several minutes.")
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    command = [sys.executable, str(script), "--config", str(config_path)]
    process = subprocess.Popen(command, cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail = []
    for line in process.stdout:
        line = line.rstrip()
        if line:
            tail.append(line)
            tail = tail[-35:]
            print(line, flush=True)
    code = process.wait()
    if code:
        raise RuntimeError("Official MobileI2V inference exited with code " + str(code) + ":\n" + "\n".join(tail[-12:]))
    videos = sorted(output.rglob("*.mp4"), key=lambda x: x.stat().st_mtime, reverse=True)
    if not videos:
        raise RuntimeError("The official inference script finished but produced no MP4 file.")
    final = output / "result.mp4"
    if videos[0] != final:
        shutil.copy2(videos[0], final)
    emit("complete", output=str(final), bytes=final.stat().st_size, backend=device_mode)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit("failed", error=str(exc), traceback=traceback.format_exc()[-5000:])
        sys.exit(1)
