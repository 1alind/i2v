#!/usr/bin/env python3
"""Run the upstream MobileI2V pipeline against files in the persistent i2v data dir.

This deliberately uses the official model implementation. It does not export guessed
ONNX graphs or synthesize placeholder videos.
"""
import argparse
import importlib.util
import importlib.metadata
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
        "requests": "requests>=2.25.1",
        "termcolor": "termcolor>=2.0.0",
        "pytz": "pytz>=2023.3",
        "tqdm": "tqdm>=4.60.0",
    }
    def module_exists(module):
        try:
            return importlib.util.find_spec(module) is not None
        except (ImportError, ValueError, AttributeError):
            return False

    def distribution_exists(name):
        try:
            importlib.metadata.version(name)
            return True
        except importlib.metadata.PackageNotFoundError:
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
                        if not module_exists(module) or
                        (module == "requests" and not distribution_exists("requests"))]
    for module, package in missing_portable:
        emit("progress", message=f"Installing Python dependency: {package}")
        if not pip_attempt(package):
            emit("progress", message=f"Retrying {package} without optional dependency resolution…")
            if not pip_attempt(package, no_deps=True):
                raise RuntimeError(f"Could not install {package}, including the Android-safe fallback. "
                                   "See the preceding installation warning for the exact pip error.")
        if not module_exists(module) or (module == "requests" and not distribution_exists("requests")):
            raise RuntimeError(f"pip reported success for {package}, but Python still cannot import {module} or its package metadata is missing.")

    # OpenCV is only used by upstream for optional MP4-as-input support.
    # This app accepts still images, so no Android OpenCV package is required.

    required = ["torch", "torchvision", "PIL", "yaml", "pyrallis", "einops",
                "transformers", "diffusers", "timm", "safetensors", "accelerate", "omegaconf"]
    missing = [name for name in required if importlib.util.find_spec(name) is None]
    if missing:
        raise RuntimeError("Still missing after automatic dependency setup: " + ", ".join(missing) +
                           ". Review the package installation warnings above for the Android-compatible fallback failure.")

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
    # The upstream inference file does not import its MobileDiT module package,
    # so its MODELS registry remains empty unless we load the registration module.
    source = source.replace(
        "from diffusion.model.builder import build_model, get_tokenizer_and_text_encoder, get_vae, vae_decode, vae_encode",
        "from diffusion.model.builder import build_model, get_tokenizer_and_text_encoder, get_vae, vae_decode, vae_encode\\nimport diffusion.model.nets"
    )
    # Remove OpenCV dependency for still-image input. The upstream cv2 branch is
    # only for video files; this app's generation input is an image.
    source = source.replace("import cv2", "# OpenCV omitted: still-image input only")
    source = source.replace(
        '            if image_path.split(\'.\')[-1]=="mp4":',
        '            if image_path.split(\'.\')[-1].lower()=="mp4":\n                raise RuntimeError("Video input is not supported on this Android build; upload a still image.")'
    )
    source = source.replace("z = z.half()", "z = z.to(dtype=weight_dtype)")
    source = source.replace("ref_image = ref_image.half()", "ref_image = ref_image.to(dtype=weight_dtype)")
    source = source.replace("        torch.cuda.empty_cache()", "        if torch.cuda.is_available():\n            torch.cuda.empty_cache()")
    script.write_text(source)

    # The official helper only recognizes a hard-coded relative Qwen path.
    # This app stores model files in the persistent data directory, so allow
    # any existing local model directory without changing remote model names.
    builder = work / "diffusion" / "model" / "builder.py"
    builder_source = builder.read_text()
    assert_line = '    assert name in list(text_encoder_dict.keys()), f"not support this text encoder: {name}"'
    local_path_support = '    if os.path.isdir(name):\\n        text_encoder_dict[name] = name\\n' + assert_line
    if assert_line not in builder_source:
        raise RuntimeError("Upstream text-encoder loader changed; refusing an unsafe patch.")
    builder.write_text(builder_source.replace(assert_line, local_path_support, 1))

    # MMCV has no suitable Android/Termux wheel. The inference-only code path
    # needs just Registry, logger_initialized and get_dist_info, not MMCV's
    # compiled training operators. Supply those small compatibility pieces.
    mmcv = work / "mmcv"
    (mmcv / "utils").mkdir(parents=True, exist_ok=True)
    (mmcv / "runner").mkdir(parents=True, exist_ok=True)
    (mmcv / "__init__.py").write_text(
        "import pickle\\nfrom pathlib import Path\\n"
        "class Registry:\\n"
        "    def __init__(self, name): self.name, self.module_dict = name, {}\\n"
        "    def register_module(self, name=None, force=False, module=None):\\n"
        "        def register(obj):\\n"
        "            key = name or obj.__name__\\n"
        "            if key in self.module_dict and not force: raise KeyError(key)\\n"
        "            self.module_dict[key] = obj\\n"
        "            return obj\\n"
        "        return register(module) if module is not None else register\\n"
        "    def build(self, cfg, default_args=None):\\n"
        "        args = dict(cfg); kind = args.pop('type')\\n"
        "        args = dict(default_args or {}, **args)\\n"
        "        cls = self.module_dict[kind] if isinstance(kind, str) else kind\\n"
        "        return cls(**args)\\n"
        "def mkdir_or_exist(path): Path(path).mkdir(parents=True, exist_ok=True)\\n"
        "def dump(obj, path):\\n"
        "    with open(path, 'wb') as f: pickle.dump(obj, f)\\n"
        "def load(path):\\n"
        "    with open(path, 'rb') as f: return pickle.load(f)\\n"
    )
    (mmcv / "utils" / "__init__.py").write_text("")
    (mmcv / "utils" / "logging.py").write_text("logger_initialized = {}\\n")
    (mmcv / "runner" / "__init__.py").write_text(
        "def get_dist_info():\\n"
        "    import torch.distributed as dist\\n"
        "    return (dist.get_rank(), dist.get_world_size()) if dist.is_available() and dist.is_initialized() else (0, 1)\\n"
    )

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
