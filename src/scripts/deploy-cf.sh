#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-command Cloudflare Workers deploy.
# Reads BOT_TOKEN / GROUP_ID / ADMIN_IDS / OPERATOR_IDS from the
# repo-root .env, pushes them as Worker secrets, then deploys.
# .env is gitignored and never uploaded; nothing secret is printed.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  echo "No .env found. Run: cp .env.example .env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

cd src/apps/worker

for VAR in BOT_TOKEN GROUP_ID ADMIN_IDS OPERATOR_IDS WEBHOOK_SECRET; do
  if [ -z "${!VAR:-}" ]; then
    echo "Skipping $VAR (empty in .env)" >&2
    continue
  fi
  printf '%s' "${!VAR}" | npx wrangler secret put "$VAR"
done

npx wrangler deploy
