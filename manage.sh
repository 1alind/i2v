#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"

DATA_DIR="${I2V_DATA_DIR:-$HOME/i2v-data}"
LOG_DIR="$DATA_DIR/logs"
SETUP_LOG="$LOG_DIR/setup.log"
RUN_PID_FILE="$DATA_DIR/run.pid"
mkdir -p "$DATA_DIR"/{models,uploads,outputs,jobs,logs}

say() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() {
  local code=$?
  say "MANAGER FAILED (exit $code)."
  printf 'Android: '; getprop ro.build.version.release 2>/dev/null || true
  printf 'Device: '; getprop ro.product.model 2>/dev/null || true
  printf 'Architecture: '; uname -m
  printf 'Node: '; node --version 2>/dev/null || echo missing
  printf 'npm: '; npm --version 2>/dev/null || echo missing
  printf 'Storage: '; df -h "$HOME" 2>/dev/null | tail -1 || true
  say "Recent npm logs:"
  ls -t "$HOME"/.npm/_logs/* 2>/dev/null | head -3 | while read -r f; do
    echo "--- $f"; tail -35 "$f"
  done
  say "Setup log: $SETUP_LOG"
  exit "$code"
}
trap fail ERR

pkg_refresh() {
  say "Refreshing Termux package lists..."
  if ! pkg update; then
    say "Trying apt metadata refresh..."
    apt-get update
  fi
}
pkg_install() {
  local packages=("$@")
  say "Installing Termux packages: ${packages[*]}"
  if pkg install -y "${packages[@]}"; then return 0; fi
  say "Repairing dpkg and retrying..."
  dpkg --configure -a || true
  pkg_refresh
  pkg install -y "${packages[@]}"
}
install_deps() {
  say "Installing/verifying Node dependencies..."
  if npm install --no-audit --no-fund --fetch-retries=3 --fetch-timeout=120000; then return 0; fi
  say "npm install failed. Verifying cache and checking for native build errors..."
  npm cache verify || true
  if grep -Eqi 'node-gyp|gyp ERR|make:|clang:|C\+\+|compiler|native addon|ELIFECYCLE' "$HOME"/.npm/_logs/* 2>/dev/null; then
    pkg_refresh
    pkg_install clang make python pkg-config binutils
  fi
  say "Retrying with the official npm registry..."
  if ! npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=180000 --registry=https://registry.npmjs.org/; then
    say "Retry failed. Rebuilding only generated node_modules from package.json..."
    rm -rf node_modules
    npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=180000 --registry=https://registry.npmjs.org/
  fi
}
prepare() {
  if ! command -v pkg >/dev/null 2>&1; then
    echo "This manager must run inside Termux."
    exit 1
  fi
  say "Preparing I2V on $(getprop ro.product.model 2>/dev/null || echo Android) ($(uname -m))"
  if ! command -v git >/dev/null 2>&1; then pkg_refresh; pkg_install git; fi
  if ! command -v node >/dev/null 2>&1; then pkg_refresh; pkg_install nodejs-lts; fi
  if ! command -v npm >/dev/null 2>&1; then pkg_refresh; pkg_install npm; fi
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$major" -lt 20 ]; then
    pkg_refresh
    pkg_install nodejs-lts
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi
  if [ "$major" -lt 20 ]; then
    echo "Node.js 20+ is required. Current: $(node --version)"
    exit 1
  fi
  [ -f package.json ] || { echo "package.json missing. Run from the project directory."; exit 1; }
  say "Node $(node --version), npm $(npm --version)"
  if [ ! -d node_modules ] || ! node -e "require('express'); require('multer')" >/dev/null 2>&1; then
    install_deps
  fi
  node -e 'for (const n of ["express","multer"]) console.log("OK:",n,require.resolve(n))'
  node --check server.js
  for d in models uploads outputs jobs logs; do
    mkdir -p "$DATA_DIR/$d"
    test -w "$DATA_DIR/$d"
  done
  say "Setup checks passed."
}
runner_active() {
  if [ -f "$RUN_PID_FILE" ]; then
    local pid
    pid="$(cat "$RUN_PID_FILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then return 0; fi
  fi
  return 1
}
manual_update() {
  if runner_active; then
    echo "The I2V supervisor is running (PID $(cat "$RUN_PID_FILE"))."
    echo "Automatic updates are handled by the server; it will restart through run.sh."
    echo "For a manual update, stop run.sh first, then run: bash manage.sh update"
    exit 1
  fi
  git rev-parse --is-inside-work-tree >/dev/null
  local branch before changed
  branch="$(git branch --show-current)"
  [ -n "$branch" ] || { echo "Detached HEAD. Switch to the project branch first."; exit 1; }
  if [ -n "$(git status --porcelain)" ]; then
    echo "Local changes detected. Update cancelled to protect your edits."
    exit 1
  fi
  before="$(git rev-parse HEAD)"
  say "Fetching GitHub updates for branch $branch..."
  git fetch origin "$branch"
  changed="$(git diff --name-only "$before" "origin/$branch")"
  if [ -z "$changed" ]; then say "Already up to date."; return; fi
  git merge --ff-only "origin/$branch"
  if printf '%s\n' "$changed" | grep -Eq '^(package\.json|package-lock\.json)$'; then
    install_deps
  fi
  say "Update installed. Start it with: bash run.sh"
}
show_status() {
  if runner_active; then
    echo "Supervisor: running (PID $(cat "$RUN_PID_FILE"))"
  else
    echo "Supervisor: stopped"
  fi
  echo "Project: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "Node: $(node --version 2>/dev/null || echo missing)"
  echo "Data: $DATA_DIR"
  echo "Models:"
  ls -lh "$DATA_DIR/models" 2>/dev/null || true
}
show_logs() {
  for f in "$SETUP_LOG" "$LOG_DIR/updates.log"; do
    if [ -f "$f" ]; then echo; echo "===== $f ====="; tail -100 "$f"; fi
  done
}

case "${1:-help}" in
  prepare)
    mkdir -p "$LOG_DIR"
    exec > >(tee -a "$SETUP_LOG") 2>&1
    prepare
    ;;
  setup)
    mkdir -p "$LOG_DIR"
    exec > >(tee -a "$SETUP_LOG") 2>&1
    prepare
    ;;
  update) manual_update ;;
  status) show_status ;;
  logs) show_logs ;;
  help|*)
    cat <<'HELP'
I2V manager
  bash manage.sh setup    Install/check Termux and Node dependencies
  bash manage.sh update   Manually update while the supervisor is stopped
  bash manage.sh status   Show supervisor, version, and stored models
  bash manage.sh logs     Show recent setup and update logs

Start/restart supervision with: bash run.sh
Stop the running supervisor with Ctrl+C in its Termux session.
HELP
    ;;
esac
