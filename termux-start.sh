#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js missing. Run: pkg install nodejs-lts"; exit 1; }
if [ ! -d node_modules ]; then
  npm install
fi
mkdir -p "$HOME/i2v-data"/{models,uploads,outputs,jobs}
echo "Starting local I2V server on http://127.0.0.1:9999"
exec npm start
