#!/data/data/com.termux/files/usr/bin/bash
echo "=== Termux I2V device diagnostics ==="
echo "Android: $(getprop ro.build.version.release 2>/dev/null || echo unknown)"
echo "SDK: $(getprop ro.build.version.sdk 2>/dev/null || echo unknown)"
echo "Device: $(getprop ro.product.model 2>/dev/null || echo unknown)"
echo "SoC: $(getprop ro.soc.model 2>/dev/null || getprop ro.hardware 2>/dev/null || echo unknown)"
echo "ABI: $(getprop ro.product.cpu.abi 2>/dev/null || uname -m)"
echo "Kernel: $(uname -r)"
echo "Node: $(node --version 2>/dev/null || echo missing)"
echo "npm: $(npm --version 2>/dev/null || echo missing)"
echo "Python: $(python --version 2>/dev/null || echo missing)"
echo "Available RAM:"
grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null
echo "GPU-related system properties:"
getprop | grep -iE 'gpu|vulkan|adreno|egl' | head -30 || true
echo "OpenCL libraries:"
find "$PREFIX/lib" -maxdepth 1 -iname '*opencl*' -o -iname '*vulkan*' 2>/dev/null | head -20
echo "=== End ==="
