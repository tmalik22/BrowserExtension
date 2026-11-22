#!/usr/bin/env sh
# Starts the Browser Agent server. Keep this terminal open while you use the agent.
# Running it again restarts the agent: a server that is already running is replaced.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Browser Agent needs Node.js 20 or newer."
  echo "  Install it from https://nodejs.org/ (or: brew install node), then run ./start.sh again."
  echo
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  Browser Agent needs Node.js 20 or newer (you have $(node -v)). Update it from https://nodejs.org/"
  exit 1
fi
exec node server.mjs
