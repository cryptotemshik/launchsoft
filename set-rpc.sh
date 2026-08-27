#!/usr/bin/env bash
#
# Point the runner at your own RPC endpoint.
#
#   bash set-rpc.sh https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
#
# Two keys, if you want the scanning kept off the mint path — a provider's
# throughput limit is per key, so a calendar refresh on the same key as the
# mint is spending the same allowance:
#
#   bash set-rpc.sh --snipe https://…/v2/SNIPE_KEY   (arming + broadcast only)
#   bash set-rpc.sh --scan  https://…/v2/SCAN_KEY    (scanner, live, calendar)
#   bash set-rpc.sh        https://…/v2/GENERAL_KEY  (everything else)
#
# The snipe one is the one worth keeping quiet: arming a hundred wallets is a
# hundred balance reads and a hundred nonce reads down a single endpoint, two
# minutes before the stage opens. A sweep or a wallet refresh landing on that
# same key at that moment is what loses the drop.
#
# Without this the box reads the chain through its public RPC, which meters:
# a scan then spends its time being rate-limited and split into ever smaller
# pieces instead of returning drops.
#
# There is a second reason this is a script and not a line in the README.
# setup-vps.sh sources snipe.env into the shell *before* starting pm2, so pm2
# keeps its own copy of the environment. Editing snipe.env and running the
# usual `pm2 restart snipe-api` therefore changes nothing at all — the process
# comes back with the environment it was born with. The restart has to re-source
# the file and pass --update-env, which is easy to get wrong by hand and is
# done here.
#
# Safe to re-run: it replaces the line rather than adding a second one, and
# leaves every other setting alone.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$REPO_DIR"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VAR=SNIPE_RPCS
WHAT="wallets, sweeps, and anything without its own endpoint"
case "${1:-}" in
  --snipe) VAR=SNIPE_MINT_RPCS; WHAT="arming and broadcasting a queued mint";        shift ;;
  --scan)  VAR=SNIPE_SCAN_RPCS; WHAT="scanner, live feed, calendar, profit report";  shift ;;
  --mint)  die "renamed: --mint used to mean everything. Use --snipe for the mint path alone, or no flag for the general endpoint" ;;
  --*)     die "unknown option $1 — use --snipe or --scan, or neither" ;;
esac

URL="${1:-}"
[ -n "$URL" ] || die "Usage: bash set-rpc.sh [--snipe|--scan] https://your-endpoint/… (comma-separate several, best first)"

# ── 1. Is it real, and is it this chain? ────────────────────────────────────
# Worth one round trip: a typo'd endpoint or one pointed at the wrong network
# would otherwise be discovered as a scan that returns nothing, hours later.
bold "1/3  Checking the endpoint"
WANT=$(grep -o '"chainId"[[:space:]]*:[[:space:]]*[0-9]*' snipe.config.json 2>/dev/null | grep -o '[0-9]*$' || true)
FIRST="${URL%%,*}"
GOT_HEX=$(curl -fsS -m 15 -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$FIRST" 2>/dev/null \
  | grep -o '"result"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]*"' | grep -o '0x[0-9a-fA-F]*' || true)
[ -n "$GOT_HEX" ] || die "no chain id came back from ${FIRST%%\?*} — wrong URL, or the key is rejected"
GOT=$((GOT_HEX))
if [ -n "$WANT" ] && [ "$GOT" != "$WANT" ]; then
  die "that endpoint is chain $GOT, but snipe.config.json says $WANT"
fi
ok "answers, chain $GOT"

# ── 2. Store it ─────────────────────────────────────────────────────────────
bold "2/3  Writing snipe.env"
touch snipe.env
# Rewrite in place rather than appending: a second SNIPE_RPCS line would win
# silently and leave the first one looking like it had taken effect.
if grep -q "^${VAR}=" snipe.env; then
  PREV=$(grep "^${VAR}=" snipe.env | head -1 | cut -d= -f2-)
  grep -v "^${VAR}=" snipe.env > snipe.env.tmp
  mv snipe.env.tmp snipe.env
  [ "$PREV" = "$URL" ] && warn "unchanged — it was already set to this" || ok "replaced the previous endpoint"
else
  ok "added"
fi
printf '%s=%s\n' "$VAR" "$URL" >> snipe.env
ok "${VAR} now serves: ${WHAT}"
chmod 600 snipe.env

# ── 3. Make the running process actually see it ─────────────────────────────
bold "3/3  Restarting the runner"
if command -v pm2 >/dev/null 2>&1 && pm2 describe snipe-api >/dev/null 2>&1; then
  set -a; . ./snipe.env; set +a
  # --update-env is the whole point: without it pm2 restarts the process with
  # the environment it was originally started with, and SNIPE_RPCS never
  # arrives however many times you restart.
  pm2 restart snipe-api --update-env >/dev/null
  ok "snipe-api restarted with the new environment"
  sleep 2
  echo
  pm2 logs snipe-api --lines 60 --nostream 2>/dev/null | grep -iE 'go through|scans through|mints through|scan endpoint' | tail -4 \
    || warn "no endpoint line in the log yet — run: pm2 logs snipe-api --lines 60"
else
  warn "pm2 isn't running snipe-api here — start it, or restart it yourself with:"
  echo "      set -a; . ./snipe.env; set +a && pm2 restart snipe-api --update-env"
fi
