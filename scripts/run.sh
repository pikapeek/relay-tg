#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# RelayTG one-command install & run (command-line runtime).
# Fetches the source, installs dependencies, configures itself, and starts.
#
# One line, with options:
#   bash <(curl -fsSL https://raw.githubusercontent.com/pikapeek/relay-tg/main/scripts/run.sh) \
#     --token=1234567890:TOKEN --group=-1001234567890 --admin=111,222
#
# Options (any may be omitted; required ones are then asked interactively):
#   --token=       Bot token from @BotFather
#   --group=       Numeric support-group id, e.g. -1001234567890
#   --admin=       Comma-separated admin user ids
#   --operator=    Comma-separated operator user ids
#   --port=        HTTP port (default 17575)
#   --db=          SQLite database path (default data/relaytg.db)
#   --auto-hide=   Auto-hide idle topics after N hours (default 168)
#
# Environment: needs Node >= 22.5. If it's missing or too old, the script
# asks before downloading a private Node 22 (LTS) into ~/.relaytg — no system
# changes — and uses it for this run.
#
# First run clones the source, writes .env from the options (asking for
# anything required that's missing), installs dependencies and starts on
# port 17575 — all in one go. Re-running with no options starts again using
# the existing .env.
#
# When run from inside a relay-tg checkout (local development), the script
# uses that checkout directly instead of cloning.
# ---------------------------------------------------------------------------
set -euo pipefail

URL=https://github.com/pikapeek/relay-tg.git
DIR=relay-tg

CONFIG_TOKEN=""
CONFIG_GROUP=""
CONFIG_ADMIN=""
CONFIG_OPERATOR=""
CONFIG_PORT=""
CONFIG_DB=""
CONFIG_AUTO_HIDE=""

usage() {
  cat <<'EOF'
Usage: bash <(curl -fsSL <run.sh-url>) [options]

Options (omit any to be asked interactively / use defaults):
  --token=<BOT_TOKEN>    Bot token from @BotFather (required)
  --group=<GROUP_ID>     Numeric support-group id, e.g. -1001234567890 (required)
  --admin=<IDS>          Comma-separated admin user ids
  --operator=<IDS>       Comma-separated operator user ids
  --port=<PORT>          HTTP port (default 17575)
  --db=<PATH>            SQLite database path (default data/relaytg.db)
  --auto-hide=<HOURS>    Auto-hide idle topics after N hours (default 168)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --token=*)     CONFIG_TOKEN="${arg#*=}" ;;
    --group=*)     CONFIG_GROUP="${arg#*=}" ;;
    --admin=*)     CONFIG_ADMIN="${arg#*=}" ;;
    --operator=*)  CONFIG_OPERATOR="${arg#*=}" ;;
    --port=*)      CONFIG_PORT="${arg#*=}" ;;
    --db=*)        CONFIG_DB="${arg#*=}" ;;
    --auto-hide=*) CONFIG_AUTO_HIDE="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

# If this script lives inside a relay-tg checkout, use it directly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd || true)"
LOCAL_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"
if [ -n "$LOCAL_ROOT" ] && [ -f "$LOCAL_ROOT/pnpm-workspace.yaml" ] && [ -f "$LOCAL_ROOT/package.json" ]; then
  echo "==> using local relay-tg checkout at $LOCAL_ROOT"
  cd "$LOCAL_ROOT"
else
  if [ ! -d "$DIR" ]; then
    echo "==> cloning relay-tg"
    git clone "$URL" "$DIR"
  fi
  cd "$DIR"
  git pull --quiet
fi

# ---- environment ----------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [m,i]=process.versions.node.split(".").map(Number); process.exit(m>22||(m===22&&i>=5)?0:1)' 2>/dev/null
}

# Download an official Node 22 (LTS) tarball into ~/.relaytg and put it on
# PATH for this run. Verifies the SHA-256 against nodejs.org. No system
# changes — nothing is installed outside $HOME.
install_node() {
  local os arch ext sumcmd
  case "$(uname -s)" in
    Linux)  os=linux  ;;
    Darwin) os=darwin ;;
    *) echo "error: unsupported OS '$(uname -s)' — install Node >= 22.5 manually and re-run" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64)            arch=x64 ;;
    aarch64|arm64)     arch=arm64 ;;
    *) echo "error: unsupported architecture '$(uname -m)' — install Node >= 22.5 manually" >&2; return 1 ;;
  esac
  if [ "$os" = darwin ]; then ext=tar.gz; else ext=tar.xz; fi
  if command -v sha256sum >/dev/null 2>&1; then sumcmd="sha256sum"; else sumcmd="shasum -a 256"; fi

  echo "==> fetching latest Node 22 (LTS) for $os-$arch"
  local sha fname ver url expected actual
  sha=$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")
  # Match only the extension we'll download — the checksum file lists both
  # .tar.gz and .tar.xz for every platform, and head -1 would grab the wrong one.
  fname=$(printf '%s\n' "$sha" | grep -oE "node-v[0-9]+\.[0-9]+\.[0-9]+-$os-$arch\.$ext" | head -1)
  if [ -z "$fname" ]; then
    echo "error: no Node 22 build found for $os-$arch" >&2
    return 1
  fi
  ver=${fname#node-v}; ver=${ver%-*}
  url="https://nodejs.org/dist/latest-v22.x/$fname"
  echo "==> downloading $url"
  curl -fsSL "$url" -o /tmp/relaytg-node.$ext

  expected=$(printf '%s\n' "$sha" | grep " $fname$" | awk '{print $1}')
  actual=$($sumcmd /tmp/relaytg-node.$ext | awk '{print $1}')
  if [ "$expected" != "$actual" ]; then
    echo "error: checksum mismatch for $fname" >&2
    rm -f /tmp/relaytg-node.$ext
    return 1
  fi

  mkdir -p "$HOME/.relaytg"
  if [ "$os" = darwin ]; then
    tar -xzf /tmp/relaytg-node.tar.gz -C "$HOME/.relaytg"
  else
    tar -xJf /tmp/relaytg-node.tar.xz -C "$HOME/.relaytg"
  fi
  rm -f /tmp/relaytg-node.$ext
  # The tarball extracts to node-vX.Y.Z-<os>-<arch> (no extension); point the
  # stable ~/.relaytg/node symlink at that directory.
  ln -sfn "$HOME/.relaytg/${fname%.$ext}" "$HOME/.relaytg/node"
  export PATH="$HOME/.relaytg/node/bin:$PATH"
  echo "==> installed Node $(node -v) in ~/.relaytg/node (this run only)"
  echo "    to make it permanent, add to your shell:"
  echo "    export PATH=\"\$HOME/.relaytg/node/bin:\$PATH\""
}

if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    echo "==> Node $(node -v) is too old — RelayTG needs Node >= 22.5"
  else
    echo "==> Node.js not found — RelayTG needs Node >= 22.5"
  fi
  printf 'Install a private Node 22 (LTS) into ~/.relaytg (no system changes)? [y/N] '
  read -r ans
  case "$ans" in
    y|Y|yes) install_node || exit 1 ;;
    *)
      echo "aborted — install Node >= 22.5 yourself and re-run this command." >&2
      exit 1
      ;;
  esac
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then
  # Node >= 16.13 ships corepack; it runs the exact pnpm version pinned
  # in package.json without needing a global install.
  PNPM="corepack pnpm"
else
  echo "==> installing pnpm"
  npm install -g pnpm
  PNPM=pnpm
fi

echo "==> installing dependencies"
$PNPM install

# ---- configuration --------------------------------------------------------
# Read an existing value from .env, if any.
env_value() { # key
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env 2>/dev/null | tail -1
}
# Update key in .env in place, or append it if missing. Escapes the sed
# replacement metacharacters (&, | and backslash) so tokens pass through clean.
upsert() { # key value
  local key="$1" value="$2" esc
  esc=$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${esc}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

WRITE_ENV=false
[ ! -f .env ] && WRITE_ENV=true
[ -n "$CONFIG_TOKEN$CONFIG_GROUP$CONFIG_ADMIN$CONFIG_OPERATOR$CONFIG_PORT$CONFIG_DB$CONFIG_AUTO_HIDE" ] && WRITE_ENV=true
if [ -f .env ] && grep -q '^BOT_TOKEN=.*REPLACE_WITH_REAL_TOKEN' .env; then
  echo "==> .env still has the placeholder BOT_TOKEN — reconfiguring"
  WRITE_ENV=true
fi

if [ "$WRITE_ENV" = true ]; then
  TOKEN="${CONFIG_TOKEN:-$(env_value BOT_TOKEN)}"
  GROUP="${CONFIG_GROUP:-$(env_value GROUP_ID)}"
  ADMIN="${CONFIG_ADMIN:-$(env_value ADMIN_IDS)}"
  OPERATOR="${CONFIG_OPERATOR:-$(env_value OPERATOR_IDS)}"
  PORT="${CONFIG_PORT:-$(env_value PORT)}"
  DB="${CONFIG_DB:-$(env_value DATABASE_PATH)}"
  AUTO_HIDE="${CONFIG_AUTO_HIDE:-$(env_value AUTO_HIDE_HOURS)}"

  if [ -z "$TOKEN" ]; then
    printf "BOT_TOKEN (paste from @BotFather; not echoed): "
    read -rs TOKEN
    printf '\n'
  fi
  if [ -z "$GROUP" ]; then
    printf "GROUP_ID (numeric support-group id, e.g. -1001234567890): "
    read -r GROUP
  fi
  if [ -z "$TOKEN" ] || [ -z "$GROUP" ]; then
    echo "error: BOT_TOKEN and GROUP_ID are required" >&2
    exit 1
  fi

  [ ! -f .env ] && cp .env.example .env
  upsert BOT_TOKEN "$TOKEN"
  upsert GROUP_ID "$GROUP"
  [ -n "$ADMIN" ] && upsert ADMIN_IDS "$ADMIN"
  [ -n "$OPERATOR" ] && upsert OPERATOR_IDS "$OPERATOR"
  [ -n "$PORT" ] && upsert PORT "$PORT"
  [ -n "$DB" ] && upsert DATABASE_PATH "$DB"
  [ -n "$AUTO_HIDE" ] && upsert AUTO_HIDE_HOURS "$AUTO_HIDE"
  echo "==> wrote $(pwd)/.env"
fi

set -a; source .env; set +a
echo "==> starting relaytg"
# Use --filter so we don't re-invoke pnpm inside the start script
# (root's `pnpm start` delegates to pnpm, which breaks when pnpm is
# reached via corepack and isn't on PATH).
exec $PNPM --filter @relaytg/app-docker start
