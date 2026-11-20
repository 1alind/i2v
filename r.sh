#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"

DATA_DIR="${I2V_DATA_DIR:-$HOME/i2v-data}"
mkdir -p "$DATA_DIR"/{models,uploads,outputs,jobs,logs}
LOG="$DATA_DIR/logs/setup.log"
touch "$LOG"
exec > >(tee -a "$LOG") 2>&1

say() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() {
  local code=$?
  say "SETUP FAILED (exit $code). Diagnostics:"
  printf 'Android: '; getprop ro.build.version.release 2>/dev/null || true
  printf 'Device: '; getprop ro.product.model 2>/dev/null || true
  printf 'Architecture: '; uname -m
  printf 'Node: '; node --version 2>/dev/null || echo missing
  printf 'npm: '; npm --version 2>/dev/null || echo missing
  printf 'Storage: '; df -h "$HOME" 2>/dev/null | tail -1 || true
  say "Recent npm log files:"
  ls -t "$HOME"/.npm/_logs/* 2>/dev/null | head -3 | while read -r f; do
    echo "--- $f"; tail -35 "$f"
  done
  say "Full setup log: $LOG"
  exit "$code"
}
trap fail ERR

pkg_refresh() {
  say "Refreshing Termux package lists..."
  if ! pkg update -y; then
    say "Package-list refresh failed. Trying Termux's configured apt repair once..."
    apt-get update || return 1
  fi
}

pkg_install() {
  local packages=("$@")
  say "Installing missing Termux packages: ${packages[*]}"
  if pkg install -y "${packages[@]}"; then return 0; fi
  say "Package install failed. Repairing pending dpkg configuration and retrying..."
  dpkg --configure -a || true
  pkg_refresh
  pkg install -y "${packages[@]}"
}

say "=== I2V automatic setup / health check ==="
say "Device: $(getprop ro.product.model 2>/dev/null || echo Android)"
say "Architecture: $(uname -m)"

if ! command -v pkg >/dev/null 2>&1; then
  echo "This installer must run inside Termux."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  pkg_refresh
  pkg_install nodejs-lts
fi
if ! command -v npm >/dev/null 2>&1; then
  pkg_refresh
  pkg_install npm
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Node.js $NODE_MAJOR is too old. Updating the Termux Node.js LTS package..."
  pkg_refresh
  pkg_install nodejs-lts
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required; installed version is $(node --version)."
  exit 1
fi
say "Node $(node --version), npm $(npm --version)"

if [ ! -f package.json ]; then
  echo "package.json is missing. Run this from the I2V project folder."
  exit 1
fi

install_node_deps() {
  say "Installing/verifying project dependencies..."
  npm install --no-audit --no-fund --fetch-retries=3 --fetch-timeout=120000
}

if [ ! -d node_modules ] || ! node -e "require('express'); require('multer')" >/dev/null 2>&1; then
  if ! install_node_deps; then
    say "First npm install failed. Checking the error and applying automatic recovery..."
    npm cache verify || true
    if grep -Eqi 'node-gyp|gyp ERR|make:|clang:|C\+\+|compiler|native addon|ELIFECYCLE' "$HOME"/.npm/_logs/* 2>/dev/null; then
      say "A native build/toolchain error was detected. Installing Termux build tools..."
      pkg_refresh
      pkg_install clang make python pkg-config binutils
    fi
    say "Retrying from the official npm registry after cache verification..."
    if ! npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=180000 --registry=https://registry.npmjs.org/; then
      say "Retry failed. Removing only this project's generated node_modules directory and reinstalling from package.json..."
      rm -rf node_modules
      npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=180000 --registry=https://registry.npmjs.org/
    fi
  fi
fi

say "Checking each required Node package..."
node - <<'NODE'
for (const name of ["express", "multer"]) {
  const pkg = require(name);
  console.log("OK:", name, "loaded from", require.resolve(name));
}
NODE

say "Checking project JavaScript syntax..."
node --check server.js
say "Checking storage directories..."
for d in models uploads outputs jobs logs; do
  mkdir -p "$DATA_DIR/$d"
  test -w "$DATA_DIR/$d"
  echo "OK: $DATA_DIR/$d"
done

say "All dependencies and startup checks passed."
say "Setup log: $LOG"
say "Starting local I2V server on http://127.0.0.1:9999"
exec npm start
