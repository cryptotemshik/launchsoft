# Orvex team dashboard

A read-only page for a partner: balances of the main and sniping wallets, PnL
by collection (with held NFTs at floor), the snipe queue, the watchlist, and a
feed of snipe results. Plain HTML/JS in `public/`, no build step.

It reads the Orvex server's `/api/dashboard/*` routes with a separate key. That
key only reads: it cannot queue a snipe, touch wallets or withdraw, and it never
sees a private key. Every other route answers it with 401.

## Server (VPS)

Two environment variables on `snipe-api`, then restart:

```bash
cd ~/launchsoft && git pull
SNIPE_DASHBOARD_TOKEN='<32+ random chars>' \
SNIPE_DASHBOARD_WALLETS='Main:0x…,Funding:0x…' \
pm2 restart snipe-api --update-env && pm2 save
```

- `SNIPE_DASHBOARD_TOKEN` — the password you give your partner (16+ chars; off when unset).
- `SNIPE_DASHBOARD_WALLETS` — wallets shown by name (`Label:0x…`, comma-separated).
- `SNIPE_DASHBOARD_SNAPSHOT_MS` — optional; how often the balance line gets a point (default 30 min).

Balance history is kept in `snipe.config.json.balances.jsonl` beside the config.

## Page

```bash
cd dashboard
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler pages deploy --branch main
```

Open the URL, enter the key. A different server can be set under "Сервер" on
the sign-in card, or with `?api=https://…` once.
