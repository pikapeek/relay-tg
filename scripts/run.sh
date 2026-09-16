#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# RelayTG one-command install & run (command-line runtime).
# Fetches the source, installs dependencies, then starts the relay.
#
# Run it from a server that has node + git:
#   bash <(curl -fsSL https://raw.githubusercontent.com/pikapeek/relay-tg/main/scripts/run.sh)
#
# First run clones the source and copies .env.example to .env; fill in
# BOT_TOKEN / GROUP_ID / ADMIN_IDS there, then run the same line again to
# start the relay on port 17575.
# ---------------------------------------------------------------------------
set -euo pipefail

URL=https://github.com/pikapeek/relay-tg.git
DIR=relay-tg

if [ ! -d "$DIR" ]; then
  echo "==> cloning relay-tg"
  git clone "$URL" "$DIR"
fi
cd "$DIR"
git pull --quiet

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> installing pnpm"
  npm install -g pnpm
fi

echo "==> installing dependencies"
pnpm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "First run: fill in BOT_TOKEN / GROUP_ID / ADMIN_IDS in $(pwd)/.env"
  echo "then run this script again to start."
  exit 0
fi

set -a; source .env; set +a
echo "==> starting relaytg"
exec pnpm start
