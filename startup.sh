#!/usr/bin/env bash
set -euo pipefail
cd /home/site/wwwroot
mkdir -p /home/site/data
export NODE_ENV=production
export PORT="${PORT:-8080}"
{
  echo "Starting Leadflo tracker on PORT=$PORT NODE=$(node -v) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ls -la node_modules/tsx/dist/cli.mjs node_modules/better-sqlite3/package.json 2>&1 || true
} >> /home/site/wwwroot/startup.log
exec node ./node_modules/tsx/dist/cli.mjs src/index.ts >> /home/site/wwwroot/startup.log 2>&1
