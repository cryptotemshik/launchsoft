#!/usr/bin/env bash
#
# One-shot setup for the snipe runner on a fresh Ubuntu VPS.
#
# Does steps 4-7 of the README's VPS guide: installs Node/git/pm2/cloudflared,
# clones the repo, checks that this box is actually near the sequencer, writes
# the config and a generated token, and starts both services under pm2.
#
# Safe to re-run: it skips what is already installed and never overwrites an
# existing config, keys file or token.
#
# The repository is private, so the usual route is to clone it first (which
# brings this script with it) and run it from inside:
#
#   git clone https://<TOKEN>@github.com/cryptotemshik/launchsoft.git
#   cd launchsoft
#   bash setup-vps.sh
#
# Running it from anywhere else works too if GITHUB_TOKEN is exported, or if the
# repo has been made public.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/cryptotemshik/launchsoft.git}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO_DIR="${REPO_DIR:-$HOME/launchsoft}"
SEQUENCER="${SEQUENCER:-https://sequencer.mainnet.chain.robinhood.com}"
PORT="${SNIPE_PORT:-8787}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Run this as the normal 'ubuntu' user, not root — pm2 would install for the wrong user."

# ── 1. Packages ─────────────────────────────────────────────────────────────
bold "1/6  Installing Node.js, git and pm2"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2- | cut -d. -f1)" -ge 20 ] 2>/dev/null; then
  ok "node $(node -v) already present"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
  ok "node $(node -v) installed"
fi
command -v git >/dev/null 2>&1 || sudo apt-get install -y git >/dev/null
ok "git $(git --version | awk '{print $3}')"
command -v pm2 >/dev/null 2>&1 || sudo npm i -g pm2 >/dev/null 2>&1
ok "pm2 ready"

# ── 1b. Swap ────────────────────────────────────────────────────────────────
# A 1GB instance runs node, cloudflared and — during a self-update — a
# typechecker. Without swap the kernel resolves that by killing something, and
# it once picked the tunnel, leaving the box unreachable from the panel. 2GB of
# swap on disk costs nothing and removes the whole failure mode.
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$TOTAL_MB" -lt 2048 ] && [ "$SWAP_MB" -lt 512 ] && [ ! -f /swapfile ]; then
  bold "1b/6  Adding 2GB of swap (this box has ${TOTAL_MB}MB of RAM)"
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "swap on, and it survives a reboot"
else
  ok "memory fine (${TOTAL_MB}MB RAM, ${SWAP_MB}MB swap)"
fi

# ── 2. cloudflared ──────────────────────────────────────────────────────────
bold "2/6  Installing cloudflared (the tunnel — no inbound port is opened)"
if command -v cloudflared >/dev/null 2>&1; then
  ok "already installed"
else
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unexpected CPU $(uname -m)" ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" -o /tmp/cloudflared
  chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
  ok "installed for linux-${ARCH}"
fi

# ── 3. The one check that actually matters ──────────────────────────────────
bold "3/6  Checking how close this machine is to the sequencer"
CONNECT=$(curl -s -o /dev/null -w '%{time_connect}' --max-time 20 -X POST \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0x00"],"id":1}' \
  "$SEQUENCER" || echo "9")
MS=$(awk -v c="$CONNECT" 'BEGIN{printf "%.0f", c*1000}')
if [ "$MS" -le 10 ]; then
  ok "${MS}ms — you are in the right region"
elif [ "$MS" -le 40 ]; then
  warn "${MS}ms — close, but not the same region. us-east-2 (Ohio) gives ~1ms."
else
  warn "${MS}ms — this box is NOT near the sequencer."
  warn "The whole point of running here is proximity. Recreate the instance in"
  warn "US East (Ohio) / us-east-2 unless you have a reason not to."
fi

# ── 4. Code ─────────────────────────────────────────────────────────────────
bold "4/6  Fetching the code"
# Run from inside a clone (the normal case for a private repo) and that clone
# is what we set up, wherever it happens to live.
if [ -f "./package.json" ] && [ -d "./.git" ] && [ -f "./src/cli/server.ts" ]; then
  REPO_DIR="$(pwd)"
  git pull --ff-only >/dev/null 2>&1 || warn "couldn't fast-forward; keeping what's there"
  ok "using this checkout: $REPO_DIR"
elif [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only >/dev/null 2>&1 || warn "couldn't fast-forward; keeping what's there"
  ok "updated $REPO_DIR"
else
  CLONE_URL="$REPO_URL"
  [ -n "$GITHUB_TOKEN" ] && CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
  if ! git clone --quiet "$CLONE_URL" "$REPO_DIR" 2>/dev/null; then
    die "couldn't clone $REPO_URL — it is private. Either clone it yourself with a
  GitHub token and re-run this script from inside that folder:

    git clone https://<YOUR_TOKEN>@github.com/cryptotemshik/launchsoft.git
    cd launchsoft && bash setup-vps.sh

  or export GITHUB_TOKEN=<YOUR_TOKEN> and run this again."
  fi
  ok "cloned into $REPO_DIR"
fi
cd "$REPO_DIR"
npm install --silent >/dev/null 2>&1
ok "dependencies installed"

# ── 5. Config, keys and secrets ─────────────────────────────────────────────
bold "5/6  Writing config"
[ -f snipe.config.json ] || cp snipe.config.example.json snipe.config.json
ok "snipe.config.json"

# Wallets are added from the site's WALLETS tab; the file just has to exist.
[ -f snipe.keys ] || { : > snipe.keys; chmod 600 snipe.keys; }
ok "snipe.keys (add wallets from the site, not here)"

if [ -f snipe.env ] && grep -q '^SNIPE_TOKEN=.\+' snipe.env; then
  SNIPE_TOKEN=$(grep '^SNIPE_TOKEN=' snipe.env | cut -d= -f2-)
  ok "keeping the existing SNIPE_TOKEN"
else
  SNIPE_TOKEN=$(openssl rand -hex 32)
  printf 'SNIPE_TOKEN=%s\n' "$SNIPE_TOKEN" > snipe.env
  ok "generated a new SNIPE_TOKEN"

  printf '\n  Telegram summaries after each mint (press Enter twice to skip)\n'
  read -rp "  bot token: " TG_TOKEN || TG_TOKEN=""
  read -rp "  chat id:   " TG_CHAT || TG_CHAT=""
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$TG_TOKEN" "$TG_CHAT" >> snipe.env
    ok "Telegram configured"
  else
    warn "skipped — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to snipe.env later"
  fi
fi
chmod 600 snipe.env

# ── 6. Run ──────────────────────────────────────────────────────────────────
bold "6/6  Starting the runner and the tunnel"
set -a; . ./snipe.env; set +a
pm2 delete snipe-api tunnel >/dev/null 2>&1 || true
# pm2's log file outlives the process, so it still holds every dead tunnel
# address this box has had. Clearing it is what makes the URL printed below
# certainly the current one rather than possibly a stale one.
pm2 flush tunnel >/dev/null 2>&1 || true
pm2 start npm --name snipe-api -- run snipe:server >/dev/null
pm2 start cloudflared --name tunnel -- tunnel --url "http://127.0.0.1:${PORT}" >/dev/null
pm2 save >/dev/null 2>&1
ok "both services started under pm2"

# Survive a reboot. Without this pm2 comes back empty and both services stay
# down — which, on a box reachable only through its own outbound tunnel, means
# no way in at all except the cloud provider's console.
if ! systemctl list-unit-files 2>/dev/null | grep -q '^pm2-'; then
  if sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1; then
    pm2 save >/dev/null 2>&1
    ok "pm2 will start both services on boot"
  else
    warn "couldn't enable pm2 on boot — run 'pm2 startup' and paste the command it prints"
  fi
else
  ok "pm2 already starts on boot"
fi

printf '  waiting for the tunnel to come up'
TUNNEL_URL=""
for _ in $(seq 1 30); do
  sleep 2; printf '.'
  # Everything after the last "created!" banner, so a log that somehow still
  # holds an older address cannot win over the one just issued.
  TUNNEL_URL=$(pm2 logs tunnel --lines 200 --nostream 2>/dev/null \
    | awk '/quick Tunnel has been created/ {found=1; out=""} found' \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$TUNNEL_URL" ] && break
done
printf '\n'

if grep -q 'telegram notifications ON' <(pm2 logs snipe-api --lines 40 --nostream 2>/dev/null); then
  ok "Telegram notifications ON"
fi

printf '\n\033[1m─────────────────────────────────────────────────────────────\033[0m\n'
if [ -n "$TUNNEL_URL" ]; then
  printf '\033[1mPaste these into the site (SNIPE tab → Remote runner):\033[0m\n\n'
  printf '  server URL : \033[32m%s\033[0m\n' "$TUNNEL_URL"
else
  warn "the tunnel URL hasn't appeared yet — run:  pm2 logs tunnel --lines 50 --nostream | grep trycloudflare"
  printf '\n'
fi
printf '  token      : \033[32m%s\033[0m\n' "$SNIPE_TOKEN"
printf '\n\033[1mThen:\033[0m  WALLETS tab → upload your keys · FUNDING tab → send 0.001 ETH each\n'
printf '\033[1mNote:\033[0m  the tunnel URL changes if the tunnel restarts — re-read it with\n'
printf '        pm2 flush tunnel && pm2 restart tunnel && sleep 25 \\\n'
printf '          && pm2 logs tunnel --lines 60 --nostream | grep trycloudflare\n'
printf '\n'
