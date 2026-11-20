#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"

DATA_DIR="${I2V_DATA_DIR:-$HOME/i2v-data}"
mkdir -p "$DATA_DIR"/{models,uploads,outputs,jobs,logs}
PID_FILE="$DATA_DIR/run.pid"
LOCK_DIR="$DATA_DIR/run.lock"
LOG="$DATA_DIR/logs/setup.log"
CHILD_PID=""
STOP_REQUESTED=0

say() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
cleanup() {
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
on_stop() {
  STOP_REQUESTED=1
  say "Stop requested. Shutting down the server..."
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
  fi
}
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "I2V supervisor appears to be running already."
  echo "If it is not, remove the stale lock: $LOCK_DIR"
  exit 1
fi
printf '%s\n' "$$" > "$PID_FILE"
trap cleanup EXIT
trap on_stop INT TERM

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
say "I2V supervisor started (PID $$)."

if ! bash manage.sh prepare; then
  say "Setup failed. Check $LOG and run: bash manage.sh logs"
  exit 1
fi

while [ "$STOP_REQUESTED" -eq 0 ]; do
  say "Launching Node server..."
  set +e
  node server.js &
  CHILD_PID=$!
  wait "$CHILD_PID"
  SERVER_EXIT=$?
  CHILD_PID=""
  set -e

  if [ "$STOP_REQUESTED" -eq 1 ]; then break; fi
  if [ "$SERVER_EXIT" -eq 75 ]; then
    say "Server requested a controlled restart after updating. Relaunching the new version..."
    sleep 1
    continue
  fi
  if [ "$SERVER_EXIT" -eq 0 ]; then
    say "Server exited normally. Supervisor stopping."
    break
  fi
  say "Server exited with code $SERVER_EXIT. Restarting in 3 seconds..."
  sleep 3
done

say "I2V supervisor stopped."
