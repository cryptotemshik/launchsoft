# LaunchPad — one-click NFT drop launcher for Robinhood Chain

A single-page static web app for launching a complete, OpenSea-indexed NFT drop
on **Robinhood Chain** in one sitting: fill a form, upload a pre-reveal image,
connect your wallet, press **LAUNCH**, sign 2 transactions — done. The
collection is deployed, configured, mintable, and picked up by OpenSea
automatically because the contract is the stock **ERC721SeaDrop** talking to the
canonical **SeaDrop** contract that OpenSea natively understands.

This is a creator tool for launching **your own** collections from **your own**
connected wallet:

- **No private keys, by default.** Launching, revealing and managing a
  collection all sign through your injected wallet (MetaMask/Rabby) via
  wagmi/viem. The only secrets you touch there are your wallet (in the
  extension) and your Pinata JWT (pasted per session, held in memory only,
  never persisted). The **Snipe** tab is the one deliberate exception — it
  takes pasted private keys for multi-wallet public-stage minting, held in
  memory only and never persisted; see that section below before using it.
- **No auto-listing.** Public and allow-list mint stages are supported;
  signed/token-gated stages are intentionally not built (see Allow-list
  detection below for why).
- The deployed contract's `owner` is your connected wallet. The app holds zero
  privileges.

## Architecture (facts verified 2026-08-18)

- OpenSea Studio has **no public API** for creating drops — Studio is UI-only.
  LaunchPad bypasses it: the on-chain half (contract, supply, price, window,
  per-wallet limit, payouts, fees) is fully automated via SeaDrop; only the
  cosmetic drop page on opensea.io requires manual clicks afterwards (the app
  prints that checklist on the success screen).
- **Robinhood Chain**: chain id **4663**, Arbitrum Orbit, native ETH.
  Public RPC `https://rpc.mainnet.chain.robinhood.com`, explorer
  `https://robinhoodchain.blockscout.com` (both from the official Robinhood
  docs; also on chainlist.org/chain/4663). Swap the RPC in
  [`src/config.ts`](src/config.ts) if you have an Alchemy key.
- **SeaDrop** is deployed and source-verified on Robinhood Chain at the
  canonical cross-chain address
  [`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`](https://robinhoodchain.blockscout.com/address/0x00005EA00Ac477B1030CE78506496e8C2dE24bf5).
- **OpenSea drop fee**: every live SeaDrop collection on Robinhood Chain allows
  fee recipient `0x0000a26b00c1F0DF003000390027140000fAa719` with
  `feeBps = 1000` (10%) and `restrictFeeRecipients = true` (verified by decoding
  the SeaDrop contract's live state). LaunchPad configures the same. Constants
  live in `src/config.ts`.
- **OpenSea chain slug**: `robinhood` → collections appear at
  `https://opensea.io/assets/robinhood/<contract>`.

### The embedded contract

`src/contracts/ERC721SeaDrop.json` is the **stock, unmodified**
`ERC721SeaDrop` from [ProjectOpenSea/seadrop](https://github.com/ProjectOpenSea/seadrop)
(`src/ERC721SeaDrop.sol`, commit `6ab8b2c`), compiled with the repo's own pinned
settings (solc 0.8.17, optimizer 1,000,000 runs, `bytecode_hash = "none"`).
Mint logic untouched — OpenSea compatibility depends on it. To regenerate:

```bash
git clone https://github.com/ProjectOpenSea/seadrop && cd seadrop
git submodule update --init lib/ERC721A lib/solmate lib/openzeppelin-contracts lib/utility-contracts
forge build src/ERC721SeaDrop.sol
# then copy abi + bytecode.object from out/ERC721SeaDrop.sol/ERC721SeaDrop.json
```

Two contract behaviors LaunchPad relies on (verified in that source, don't
"fix" them):

1. `tokenURI(id)`: if `baseURI` does **not** end in `/`, the contract returns
   `baseURI` verbatim for **every** token → pre-reveal uses ONE shared
   unrevealed JSON, not N copies. If it **does** end in `/`, it returns
   `baseURI + tokenId` with **no `.json` suffix** → revealed metadata files are
   named `1`, `2`, … with no extension.
2. `setBaseURI` emits `BatchMetadataUpdate(1, totalMinted)` — OpenSea refreshes
   metadata on its own after the reveal.

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (CSV converter, wei/time conversions)
npm run build      # typecheck + production build into dist/
```

Deploy anywhere static (no backend, no database):

- **Cloudflare Pages** (config included — `wrangler.toml`):
  - *Git-connected (recommended)*: Cloudflare dashboard → Workers & Pages →
    Create → Pages → Connect to Git → pick this repo, build command
    `npm run build`, output `dist` (both are auto-detected from
    `wrangler.toml`). Every push redeploys automatically.
  - *CLI*: `CLOUDFLARE_API_TOKEN=<token> npm run deploy:cf`
    (token: Cloudflare dashboard → My Profile → API Tokens → template
    "Edit Cloudflare Workers"/Pages edit). First run creates the `launchpad`
    Pages project and prints the `*.pages.dev` URL.
- **Vercel**: `vercel` in the repo root — framework preset "Vite", build
  command `npm run build`, output `dist`. Or just import the repo in the Vercel
  dashboard.
- **Netlify**: build `npm run build`, publish directory `dist`.

## Launch flow (what the one button does)

1. Validates everything, then shows a confirmation modal with every parameter
   in plain language (price in ETH — $ prices don't exist on-chain; start/end
   shown in your local timezone AND UTC). Requires a checkbox.
2. Uploads to Pinata: pre-reveal image → one shared unrevealed metadata JSON →
   collection-level `contractURI` JSON. Per-step progress, each CID linked.
3. **TX 1**: deploy `ERC721SeaDrop(name, symbol, [SeaDrop])`.
   **TX 2**: `multiConfigure(...)` — maxSupply, baseURI (pre-reveal),
   contractURI, public drop (price/window/per-wallet limit/fee), creator payout
   address, optional provenance hash, OpenSea fee recipient allowed.
   Optional **TX 3**: `setRoyaltyInfo` if you set a royalty % (ERC-2981 —
   supported by this contract but not part of `multiConfigure`).
   Optional **TX 4**: `setTransferValidator` when royalty enforcement is set to
   "enforced" — it points the token at OpenSea's transfer validator
   (`StrictAuthorizedTransferSecurityRegistry`,
   `0xA000027A9B2802E1ddf7000061001e5c005A0000`, source-verified; the same
   validator live enforced drops on Robinhood Chain use). "Signal only" leaves
   the validator unset — ERC-2981 is then a request marketplaces may ignore.
   The owner can flip enforcement on/off later from the Status tab.
4. Success screen: contract address, Blockscout + predicted OpenSea links, mint
   countdown, and the manual OpenSea Studio checklist.

Every step is persisted to `localStorage`. If configure fails after deploy
succeeded, the Launch tab offers **Resume** — completed steps (uploads, deploy)
are never redone, and the drop window doesn't drift because the original
timestamps are frozen in the saved state.

## Reveal flow

The real art must **not** touch IPFS until reveal — otherwise snipers scrape
rarities before mint-out. Launch uploads only the pre-reveal assets. When ready:

1. Reveal tab → contract is prefilled from the saved launch (or paste it).
2. Pick the images folder (`1.png … N.png`) and optionally your **OpenSea
   Studio CSV** (`tokenID,name,description,file_name,external_url,attributes[Type],…`).
   Empty attribute cells are skipped; plain-number values become numeric
   traits. No CSV → minimal `"<Collection> #N"` metadata is generated.
3. The app refuses with a precise diff if anything disagrees: image count vs
   on-chain `maxSupply`, ids not consecutive from 1, duplicate ids, CSV rows
   missing/extra, `file_name`s that don't match uploaded files.
4. Upload images folder → build per-token JSONs (named `1…N`, no extension) →
   upload metadata folder → **one tx**: `setBaseURI("ipfs://<metadataCID>/")`
   (trailing slash required). `BatchMetadataUpdate` is emitted; OpenSea
   refreshes on its own. If an item lags: item page → … → Refresh metadata.

## Networks (multi-chain)

LaunchPad works on every OpenSea-supported EVM mainnet where the canonical
SeaDrop is deployed — verified on-chain (`eth_getCode`), not from docs. Pick one
in the top-bar **network selector**; it drives both wallet mode (asks the wallet
to switch) and fast mode (the local signer targets that chain).

Supported: Robinhood Chain, Ethereum, Base, Arbitrum One, Arbitrum Nova,
Optimism, Polygon, Zora, Blast, Avalanche, Sei, B3, Ronin, ApeChain, Shape,
Soneium, Unichain, Abstract, Berachain, Flow EVM. (Solana is non-EVM and out of
scope.) SeaDrop, Seaport 1.6, the OpenSea fee recipient, and the royalty
transfer validator are the same deterministic addresses on all of them — the
registry with per-chain RPC, explorer, and OpenSea slug is `src/chains.ts`.

Per-chain notes:

- **Enforced royalties** need the transfer validator, which is deployed
  everywhere *except Abstract* — the enforce option hides itself there.
- **The launch fee factory is per chain.** Deploy one per chain you want to
  monetize and map it in `LAUNCH_FACTORIES` (`src/config.ts`).
- **Profit / Dashboard richness depends on the chain's explorer.** Mint revenue
  comes from RPC logs and works wherever the chain's RPC serves full-range
  `getLogs`; royalties and USD need a Blockscout v2 API, set for the chains that
  have one (Robinhood, Base, Optimism, Zora, B3, Shape, Soneium, Unichain, Flow).
  Where a public RPC caps log range (some do), the profit panel says so — swap
  that chain's RPC in `chains.ts` for an archive-capable one to fix it.

## Charging a launch fee (monetization)

LaunchPad can take a flat on-chain fee for every launch — no backend, no
accounts, no stored data. You deploy a small factory contract once; from then
on every launch routes through it and pays the fee to your wallet in the same
transaction as the deploy.

- **Off by default.** While `LAUNCH_FACTORY` in `src/config.ts` is empty,
  launches are a free direct deploy (local/self-host).
- **To turn it on**, deploy `contracts/PaidSeaDropCloneFactory.sol` (full
  build/deploy/manage steps and an honesty note on what a fee can and can't
  enforce are in [`contracts/README.md`](contracts/README.md)), paste its
  address into `LAUNCH_FACTORY`, and redeploy the site.
- The fee amount is read live from the factory (`launchFee()`) and is
  owner-settable on-chain, so you change pricing without touching code.
- The factory deploys OpenSea `ERC721SeaDropCloneable` clones — real,
  OpenSea-compatible SeaDrop collections owned by the creator. Verified against
  the live SeaDrop with a fork test.

Accounts / fiat subscriptions are a possible later phase (they need a real
backend, database, auth, and Stripe — i.e. running a money-handling business);
the on-chain fee covers "charge per launch" with none of that.

## Signing: browser wallet vs. fast mode

Two ways to sign, chosen with the **wallet | fast ⚡** toggle in the top bar:

- **wallet** (default): your injected wallet (MetaMask/Rabby). Every transaction
  shows a confirmation pop-up. Nothing sensitive touches the app.
- **fast ⚡** (local signer): paste one or more private keys (one per line);
  transactions then sign automatically with **no pop-up** — the same
  convenience a deploy script has. Keys are held in the browser tab's memory
  only: never written to localStorage, never sent over the network (viem signs
  locally and broadcasts the already-signed transaction), and gone the moment
  you refresh. When several are loaded, a selector in the top bar picks the
  **active** wallet — the one that signs and launches — so you can launch from
  whichever wallet you want without re-pasting.

Fast mode is a deliberate footgun with rails. There is **no key generation and
no persistence** — keys live in memory for the session only. The real risk is
exposure: anything that can run script in the page — a browser extension, a
compromised dependency, an XSS bug — can read a key while it's loaded. So for
real funds:

- Run LaunchPad **locally** (`npm run dev` on your own machine), not the public
  URL, when a key is loaded.
- Use wallets that hold only what the session needs, and remove the keys
  (top bar → **remove key/all**) when done.

There is no server and no key database anywhere in this project — a backend that
stored keys would concentrate every wallet behind one breachable door, which is
strictly worse than one key in one browser tab.

## Drop window — and why a stage can come back shorter

SeaDrop stores an **absolute** `startTime` and `endTime`. OpenSea's "Edit drop
stage" dialog has **no end-time field** — only a *Duration*. A duration is not a
window until you say what it counts from, so pressing **Update** there makes
OpenSea re-derive the end time; on a stage that is **already running** the
window can come back shorter than it was, and repeating it can whittle a drop
down to minutes.

The Status tab's **Drop window** panel is the fix:

- Live readout of start, end, total length, elapsed and remaining — a collapsed
  window is impossible to miss.
- Loud warnings when the drop is closed, nearly over, or when the whole window
  is under ten minutes (which is what the duration-dialog failure looks like).
- **Set the end by duration counted from now**, with 1h / 24h / 7d / 30d
  presets and an "keep the original start time" toggle. It sends one
  `updatePublicDrop` with absolute times; price, per-wallet limit and fee are
  passed through unchanged.

After any edit on OpenSea, press **read** and check this panel.

The Launch form asks the same way OpenSea does: **when minting opens** (right
away, or at a set time) and **how long it stays open** — days / hours / mins
with 1h / 24h / 7d / 30d / 1y presets. The absolute end time is derived and
shown live ("open for 30d · ends …"), and a duration under ten minutes is
rejected before it can produce a drop that closes on arrival.

### Stage name

SeaDrop's public drop struct has **no name field**. The "Stage Name" OpenSea
shows lives in OpenSea's database, set through their Edit-stage dialog. The
only on-chain home for stage metadata is `updateDropURI`, which the panel can
publish (name + description, as an inline `data:` JSON) — but no collection on
these chains publishes one, so expect OpenSea to keep showing whatever was
typed in its own dialog.

## Secondary-market currency (ETH/WETH vs USDG)

Three separate things, often confused:

1. **Mint currency is always native ETH.** SeaDrop takes payment as
   `msg.value`, so no stablecoin can be the mint currency — this is fixed by
   the canonical contract, not a setting.
2. **Secondary sales settle in whatever the seller picks per listing**, and
   **every OpenSea offer/bid is paid in WETH**.
3. **The currency OpenSea *defaults to* in its UI** (USDG on some chains) is
   OpenSea's own per-chain configuration. No field on the NFT contract controls
   it, so nothing in LaunchPad — or any contract call — can change that default.
   Pick ETH/WETH in the listing form, and set accepted tokens under OpenSea →
   collection → Edit where that chain exposes the option.

What LaunchPad *can* do is the useful part: the Status tab's **Secondary
market** panel shows the chain's canonical WETH and approves it to Seaport in
one tx, so accepting a WETH offer later is a single signature instead of two.
WETH addresses are only listed where verified on-chain (Robinhood Chain's is a
verified `aeWETH` proxy with 425k holders that Seaport demonstrably settles in);
on chains without a verified address the helper hides itself rather than risk
pointing at a lookalike token.

## Collection category

The Launch form has a **category** picker defaulting to **PFPs**, written into
the collection metadata as a hint. OpenSea's own category lives in its
settings, not the contract — confirm it on opensea.io → collection → Edit once
the collection is indexed.

## Link click tracking

The collection detail (Status / Dashboard) shows click tallies for the
collection's **X/Twitter**, **website** and **OpenSea** links.

Scope, stated plainly: these count clicks **made through LaunchPad, in that
browser**, stored locally. A static site has no server, so it cannot see clicks
on the same link as it appears on opensea.io or anywhere else. To count every
visitor, put a tracked short link (Bitly, Dub, …) in the collection's website/X
field and read the numbers there.

## Pinata key — which one

Pinata's "API Key Information" dialog shows three values. LaunchPad needs the
**third: "JWT (secret access token)"**, the one starting with `eyJ`. The API
Key and API Secret are rejected. Create it at pinata.cloud → API Keys → New Key
with `pinFileToIPFS` + `pinJSONToIPFS` permissions (or Admin). It's held in the
tab's memory only — never stored, re-paste each session.

## Starting from an existing collection

The Launch tab can copy another collection's **settings** into the form: name,
symbol, description, website, supply, mint price, per-wallet limit and royalty
%. Everything comes from public reads (the contract plus its contractURI JSON).
Artwork is deliberately never copied — you upload your own pre-reveal image and
your own art at reveal.

## Live mints tab (MintGo-style)

What's minting **right now**, read live from the chain's Blockscout API — no
backend. It reads the newest `SeaDropMint` logs emitted by the canonical
SeaDrop contract, decodes them (collection, minter, quantity, unit price), and
shows:

- **Header stats** over the recent window: NFTs minted, mint txns, unique
  minters, distinct collections.
- **Trending — most minted**: collections ranked by NFTs minted (then unique
  minters), with a rough secondary of mint volume and how long ago the last
  mint landed. Collection names are resolved on-chain via `name()`, and each
  collection shows its logo (pulled from `contractURI` and cached).
- **Latest mints**: a live ticker of individual mints with the collection's
  avatar, the minter linked to their **OpenSea profile**, quantity, unit
  price, time-ago and tx link.
- **Realtime (optional)**: the Blockscout feed auto-refreshes every 5s; paste a
  **WebSocket RPC** (`wss://…` that supports `eth_subscribe`, e.g. your Alchemy
  WebSocket URL) and it subscribes directly to SeaDrop mint logs for
  instant, no-poll updates. Nothing is stored.

Collection logos and pre-reveal art resolve through a **fallback chain of IPFS
gateways** (ipfs.io → Pinata → Cloudflare → dweb.link → nft.storage), so a
single slow or rate-limited gateway no longer leaves a broken image.

Only mints that go through SeaDrop are visible here (that's what LaunchPad and
OpenSea drops use). It needs a **Blockscout API** for the active chain, so it's
enabled on Robinhood, Base, Optimism, Zora, Soneium, Unichain, Shape, B3, and
Flow, and shows a "switch chain" note elsewhere.

## Tracker tab

Watch any set of wallets and get alerted when they **mint**, **buy**, or
**sell** an NFT. **Addresses only — never keys.**

- **Bulk add**: paste one address per line (or comma/space separated), with an
  optional label on the same line (`0xabc… whale`). The list is validated,
  deduped, and stored locally.
- Each wallet's recent ERC-721/1155 transfers are read from Blockscout and
  classified relative to the wallet: `mint` (from `0x0`), `buy`/`sell` (a
  Seaport order fill — matched by method name or raw 4-byte selector), or plain
  `receive`/`send`. Poll runs every 5s.
- **Browser notifications** (opt-in) fire for new events while the tab is open;
  the first (baseline) batch is silenced so you only hear about genuinely new
  activity.

Honest limit: a static site can only notify while the tab is open. Closed-tab /
background push needs a server with Web Push (a Service Worker + VAPID key +
subscription store), which this keyless app deliberately doesn't run. Like the
Live tab, activity reads need a Blockscout API for the active chain.

## Dashboard tab

All your projects in one place. Launches made from this browser register
themselves; any other collection can be tracked by pasting its address or an
OpenSea/Blockscout link (the registry is addresses-only, stored locally).

- **Total profit** across projects with a **live cumulative chart** (crosshair
  tooltip, auto-refresh every 30s) built from real events: mint proceeds at
  their block times, royalty payouts at their tx times, launch gas at deploy
  time. Royalty payouts are deduped when collections share a receiver wallet.
- **Table**: collection, minted/supply, volume≈ (secondary volume derived from
  royalty payouts — needs royalties > 0), deployer, profit (green/red), date.
  Click a column header to sort; "only mine" filters to collections owned by
  the connected wallet. Click a row to expand the full Status-style detail.

## Snipe tab

Pre-signed, multi-wallet racing for a SeaDrop drop — **public** or
**allow-list**, chosen with the stage toggle. Paste any number of private
keys and each wallet builds, signs and races its own transaction; the two
stages differ only in the calldata each wallet carries.

- **One flow for both stages.** The public stage sends a byte-identical
  `mintPublic` from every wallet. The allow-list stage builds a per-wallet
  `mintAllowList` — each wallet's own merkle proof, verified against the
  contract's on-chain root before it's offered — so being on the list is
  proven locally, per wallet, and wallets that aren't on it are skipped rather
  than sent to revert.
- **On-chain only.** Price, fee recipient, per-wallet limit and (for the
  allow-list stage) each wallet's mint params all come straight from the
  SeaDrop contract and the published list — no OpenSea account, login or API
  key. Signed/token-gated stages need a signature or list only the drop's own
  backend can produce (see "Three kinds of gate" below) — mint those on
  opensea.io.
- **Pre-signed, then blasted.** Every wallet's transaction is signed and
  serialised *before* the stage opens, so at T-0 the only work left is writing
  bytes to the network — signing and encoding are off the critical path. Each
  signed transaction is sent to every configured RPC endpoint at once
  (chain defaults plus any you paste, e.g. your own Alchemy key), and whichever
  answers first wins.
- **Guarded the same way the CLI original was.** A max fee under the current
  base fee, a tip above the ceiling, or a wallet that can't cover
  `gas × max fee + mint price` are all caught before firing, not after a
  transaction is rejected on-chain.
- **Keys never leave the tab.** Pasted private keys are held in memory for
  that session only — never written to disk, never sent anywhere except as a
  locally-signed transaction. Refreshing the page clears them.

Racing other bidders on a mint isn't hacking or a contract exploit — it calls
the exact function anyone can call, just faster and from more wallets — but it
*is* a competitive-advantage tool, not a neutral one. Decide for yourself
whether that fits how you want to use LaunchPad.

## Headless runner (`npm run snipe`) — for a VPS next to the sequencer

The Snipe tab needs an open browser tab on your machine. That's the wrong place
to race from, because these chains order by **arrival time at the sequencer**,
not by gas. The runner is the same logic without the browser, so it can sit on a
server beside the sequencer under `pm2`.

### Where the sequencer actually is

Resolved 2026-08-24, and confirmed against `ip-ranges.amazonaws.com`:

```
sequencer.mainnet.chain.robinhood.com
  → CNAME ac23019b22f1ae5a-sequencer.ue2v1.rhm.arbitrum-internal.io
  → 3.136.74.196 / 3.141.111.43 / 3.142.9.34   (all in 3.136.0.0/13)
  → AWS us-east-2 (Ohio)
```

So an EC2 instance in **us-east-2** reaches it over AWS's own regional network
(~1ms) instead of the open internet (~100ms+ from Europe). The public RPC, by
contrast, sits behind Cloudflare — one more hop the sequencer doesn't have.

Because Arbitrum Orbit sequences first-come-first-served with no mempool, that
latency is the *only* lever: raising the tip cannot buy priority here.

### Setup

```bash
# on an Ubuntu EC2 instance in us-east-2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
git clone <this repo> && cd launchsoft && npm install

cp snipe.config.example.json snipe.config.json   # edit: collection, quantity, gas
cp snipe.keys.example snipe.keys                 # one private key per line
```

Confirm you're actually close before trusting it — `connect` must be under ~5ms:

```bash
curl -s -o /dev/null -w "connect=%{time_connect}s\n" -X POST \
  -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0x00"],"id":1}' \
  https://sequencer.mainnet.chain.robinhood.com
```

### Running it

```bash
npm run snipe                 # DRY RUN — reads the drop, prints the plan, sends nothing
npm run snipe -- --yes        # actually fires
```

The dry run is the default on purpose: it reads the live drop, resolves the
stage, checks every wallet's balance against `gas × maxFee + price`, and prints
exactly what would be broadcast. Nothing leaves the machine without `--yes`.

To keep it alive across reboots: `pm2 start "npm run snipe -- --yes" --name sniper && pm2 save && pm2 startup`.

### Driving it from the browser (control server)

Editing JSON over SSH for every drop gets old. `npm run snipe:server` exposes
the same runner to the **Remote runner** panel in the Snipe tab, so you pick the
collection in the browser and press fire.

This does **not** put the browser in the firing path. A request only *starts* a
run; from then on the server holds and fires on its own clock, so a
browser-started run is exactly as fast as an SSH-started one — and you can close
the tab while it holds.

```bash
export SNIPE_TOKEN=$(openssl rand -hex 32)   # keep this; the panel needs it
npm run snipe:server                          # listens on 127.0.0.1:8787 only
```

It binds to localhost on purpose — nothing is reachable until you publish it.
The documented route is a Cloudflare Tunnel, which is outbound-only, so **no
inbound port is ever opened on the box** and you get HTTPS for free (the panel
is served over HTTPS, so a plain-HTTP server would be blocked as mixed content
anyway):

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a `https://….trycloudflare.com` URL. Paste that plus the token into
the panel and press **connect**.

| Env var | Default | Meaning |
|---|---|---|
| `SNIPE_TOKEN` | — | **required**, ≥16 chars; the only thing guarding your wallets |
| `SNIPE_PORT` | `8787` | port to listen on |
| `SNIPE_HOST` | `127.0.0.1` | keep as-is unless you know why not |
| `SNIPE_ORIGINS` | `*` | comma-separated allowed origins; set to your site to narrow |
| `SNIPE_CONFIG` | `snipe.config.json` | config whose keys/defaults the server uses |
| `SNIPE_ARM_LEAD_MS` | `120000` | how far ahead of a stage a job is armed |
| `TELEGRAM_BOT_TOKEN` | — | enables run summaries (with the chat id) |
| `TELEGRAM_CHAT_ID` | — | where to send them |

Routes: `GET /api/ping` (unauthenticated liveness), `GET /api/status`,
`POST /api/queue`, `DELETE /api/queue?id=…`, `POST /api/abort`, and
`POST /api/snipe` (queues one job immediately). Everything but ping needs
`Authorization: Bearer $SNIPE_TOKEN`, compared in constant time. Keys never
leave the server — the panel receives addresses and balances only.

Under pm2: `pm2 start "npm run snipe:server" --name snipe-api && pm2 save`.

### Managing the server's wallets from the browser

**SNIPE → WALLETS** adds and removes the wallets the runner mints with, so
`snipe.keys` never has to be edited over SSH. Paste keys, optionally label
them, press upload; the list shows each wallet's address, label and balance.

The API behind it is **write-only by design**: keys go up, and only addresses
come back. Nothing in the server exposes a stored key, so a leaked token cannot
be used to extract wallets already on the box (it could add or remove ones,
which costs you nothing but the removal). Keys are written with mode `0600`,
and the file keeps hand-written labels and comments.

Both tabs share one connection — connect in either and the other is connected.

### Funding the wallet set

**SNIPE → FUNDING** fans ETH out to every stored wallet before a mint, and
sweeps it back afterwards. Both run on the server: all transfers are signed
together and blasted at once, so a hundred of them cost about one round-trip
rather than a hundred.

The two directions differ only in nonces, and that difference is the design:
disperse sends N transactions from one wallet, so they take sequential nonces
`n … n+N-1`; collect sends one transaction from each of N wallets, so every
nonce is independent. Both are signed and fired in one go either way.

Practical details:

- **How much per wallet.** On this chain the binding cost is the gas
  *reservation*, not the fee. A node checks the wallet holds
  `gasLimit × maxFee` before accepting a transaction at all, while the fee
  actually paid is tiny — real SeaDrop mints measured 107k–236k gas at a
  ~0.022 gwei base fee, i.e. **0.0000025–0.0000053 ETH each**. With the default
  250,000 limit at 2 gwei the reservation is **0.0005 ETH**, so **0.001 ETH per
  wallet** is a comfortable float for a free mint. Add the mint price for a paid
  one.
- **Skip-if-funded** is on by default, so re-running after a partial failure
  tops up only the wallets that still need it.
- The payer is either a stored wallet or a one-off key pasted for that call
  and never written to disk. A payer that is also a stored wallet is excluded
  from its own target list.
- Collect sends `balance − gas reserve` from each wallet and skips empty and
  dust ones automatically; the only input is the destination.

### Gathering the minted NFTs onto one wallet

A twenty-wallet mint leaves the tokens across twenty wallets, and listing them
means signing into twenty wallets. **FUNDING → Collect NFTs** moves them onto
one address first, so selling is one session.

- **Scan wallets** lists what the set holds — optionally filtered to one
  collection — then **Move all NFTs** transfers the lot. Transfers are signed
  together and blasted at once, like everything else here.
- **Automatically, after every mint:** set `consolidateTo` in
  `snipe.config.json` (or the `CONSOLIDATE_TO` env var) to the destination.
  That path uses the token ids decoded from the mint receipt, so it moves
  exactly what the run minted and needs no holdings lookup at all.

Two things worth knowing. `ERC721SeaDrop` is ERC721A and does **not** implement
`tokenOfOwnerByIndex`, so holdings cannot be enumerated on-chain — the manual
scan reads the chain's Blockscout index instead, and is therefore unavailable
on chains without one (the automatic post-mint sweep still works there, since
it already knows the ids). And a collection with **enforced royalties** points
at a transfer validator that can reject transfers; a rejected move is reported
per token rather than failing the batch.

A failed sweep never fails the mint — the tokens are minted either way, and can
be moved by hand afterwards.

### Queueing drops ahead of time

Load a collection in the Snipe tab, press **+ QUEUE THIS DROP**, then load the
next one and queue it too — ten drops hours in advance is the intended use. The
queue table shows each job's stage, countdown and status; click a row for its
wallets, outcomes and log tail.

Jobs run **strictly one at a time**, soonest stage first, and that is not a
simplification to fix later: every wallet's transactions are pre-signed against
a specific nonce, so two jobs armed at once for the same wallets would sign the
same nonce twice and the second would be rejected. The scheduler arms the next
job only once the previous has settled, reading fresh nonces at arm time —
which costs nothing, because arming happens `SNIPE_ARM_LEAD_MS` (2 min by
default) before the stage opens. A job whose stage is further out than that
simply waits in the queue.

### Telegram summaries

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` and every finished run posts a
summary: total NFTs, how many wallets, then one line per wallet with its
OpenSea profile, its minted token ids as direct item links, and the tx. Failed
and skipped wallets are listed with the reason.

To get the two values: message [@BotFather](https://t.me/BotFather) → `/newbot`
for the token, then message your new bot once and read the chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

A notification that fails to send is logged and otherwise ignored — it can
never turn a successful mint into a failed run.

### Config

| Key | Meaning |
|---|---|
| `chainId` | 4663 = Robinhood Chain; any id from `src/chains.ts` |
| `collection` | the drop's contract address |
| `stage` | `"public"` or `"allowlist"` (per-wallet proofs are derived locally) |
| `quantity` | NFTs per wallet, clamped to the stage's cap |
| `keysFile` | path to the keys file, relative to the config |
| `extraRpcs` | your own endpoints; also used for reads |
| `gas` | `maxFeeGwei`, `tipGwei`, `limit` — validated against the live base fee |
| `timing` | `"wait"` holds until the stage opens, `"now"` fires immediately |

`snipe.config.json` and `snipe.keys` are gitignored. Keys are read at start,
held in memory, and never written anywhere — but they *are* on a server, so
fund those wallets with only what the mint needs.

## Allow-list detection (Snipe tab)

The Snipe tab works out by itself whether your connected wallet can mint from
an allow-list stage, not just the public one:

1. Reads `getAllowListMerkleRoot` — a non-zero root means the drop has a list.
2. Finds the list's `allowListURI` from SeaDrop's `AllowListUpdated` event
   (indexed RPC query, falling back to Blockscout where the RPC refuses wide
   ranges), and fetches it — `http(s)`, `ipfs://` and inline `data:` all work.
3. Looks the connected wallet up and derives its merkle proof, **verifying it
   against the root the contract actually holds** before offering the mint.
4. Once the proof verifies, the allow-list mint button unlocks — price,
   per-wallet limit and window come from that stage's `MintParams`, and it
   mints via `mintAllowList`.

Leaf encoding is `keccak256(abi.encode(minter, mintParams))` with sorted-pair
proofs — verified against a live drop, reproducing its published leaf and
on-chain root exactly (pinned in `allowlist.test.ts`). Both allow-list document
shapes seen in the wild are handled: a `claims` map carrying ready-made proofs,
and a flat array whose tree is rebuilt locally. A shipped proof that no longer
matches the chain is detected and reported rather than sent.

### Three kinds of gate, named correctly

A zero merkle root does **not** mean "public only" — SeaDrop restricts stages
three different ways, and the tab reports which one a drop uses:

- **merkle** — an on-chain root plus a published list. Fully handled above:
  membership is proven locally and `mintAllowList` works from here.
- **signed** — the stage is authorised by OpenSea signing each mint
  (`mintSigned`), detected via `getSigners`. There is no list to read:
  eligibility lives in OpenSea's backend and the mint needs their signature,
  so that stage can only be minted on opensea.io. The tab says exactly that,
  and names the authorised signer.
- **tokenGated** — holders of another NFT mint the stage, detected via
  `getTokenGatedAllowedTokens`. Not mintable from here yet; reported rather
  than hidden.

Honest limits: **OpenSea publishes its own merkle allow-lists PGP-encrypted**,
so for those the membership check is impossible for anyone but OpenSea; and a
signature-gated stage is impossible for *any* third-party app, since only the
signer's private key can authorise it. In both cases the tab points you at
opensea.io for that stage — the public stage still mints from here.

## Status tab

Read-only dashboard for any pasted/saved contract: minted vs maxSupply, decoded
`PublicDrop` (price, window in local+UTC, per-wallet limit, fee), owner, payout
address, baseURI (revealed or not), provenance, OpenSea/Blockscout links.

**Profit widget** — a big green/red number:
`profit = mint proceeds + royalties − launch cost`.

- *Mint proceeds* are exact: decoded from SeaDrop's `SeaDropMint` events for
  this contract, already net of OpenSea's drop fee (the gross and OpenSea's
  cut are shown alongside).
- *Royalties* are an estimate: the sum of Seaport 1.6 → royalty-receiver
  internal transfers (that's how OpenSea pays creator earnings on secondary
  sales). Other collections or the wallet's own OpenSea sales inflate it.
- *Launch cost* is the gas actually paid for the deploy (from the contract's
  creation tx) plus configure/royalty/reveal txs when the launch was made from
  this browser (saved state).

Owner actions (only shown to the owner):

- `updatePublicDrop` — change price / start / end / per-wallet limit any time.
- `setMaxSupply` — cut supply after mint slows (never below already-minted).
- Enforce / un-enforce royalties — one tx toggling OpenSea's transfer validator.
- Nothing to withdraw: mint proceeds stream to the creator payout address on
  every mint, automatically, via SeaDrop.

## Rehearsal script — run this before EVERY real launch

Gas on Robinhood Chain is near-zero; a full dress rehearsal costs pennies.

1. Prepare a throwaway set: 5 images (`1.png … 5.png`), optionally a 5-row CSV,
   any pre-reveal image.
2. Open LaunchPad with your deployer wallet on Robinhood Chain. Launch a
   collection named `REHEARSAL-<date>`, supply **5**, price **0**, per-wallet
   limit 5, start time **~2 minutes from now**.
3. Sign both transactions. Confirm the success screen shows the contract on
   Blockscout and the countdown reaches "live now".
4. From a **second browser profile / second wallet**, mint 1 via the contract
   on Blockscout: open the **SeaDrop** contract
   (`0x00005EA0…24bf5`) → Write → `mintPublic(nftContract, feeRecipient,
   minterIfNotPayer, quantity)` with your collection address,
   `0x0000a26b00c1F0DF003000390027140000fAa719`, `0x0000…0000`, `1`.
5. Status tab: confirm minted = 1 and the drop params decode correctly.
6. Run the Reveal flow with the 5 real images (+ CSV). Confirm the tx succeeds
   and `baseURI` flips to `ipfs://…/` (revealed).
7. On opensea.io, find the collection (search the contract address), confirm
   metadata + images render, and traits show up. Force "Refresh metadata" on
   one item if needed.
8. Optional: `setMaxSupply(1)` from the Status tab to close the rehearsal
   collection down to the single minted token.

If any step surprises you, fix the inputs and rehearse again before launching
the real collection.

## Verify the contract on Blockscout (buyer trust)

Verified source on the explorer builds buyer trust. From a clone of the seadrop
repo (same commit + submodules as above, so compiler settings match):

```bash
forge verify-contract \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --compiler-version 0.8.17 \
  --constructor-args $(cast abi-encode "constructor(string,string,address[])" \
      "<Your Collection Name>" "<SYMBOL>" "[0x00005EA00Ac477B1030CE78506496e8C2dE24bf5]") \
  <YOUR_CONTRACT_ADDRESS> \
  src/ERC721SeaDrop.sol:ERC721SeaDrop
```

## Manual OpenSea Studio checklist (cannot be automated — no API)

1. Log into opensea.io with the **deployer wallet**.
2. The collection auto-appears after indexing (SeaDrop events; no submission).
3. Collection → Edit: logo, banner, description, royalties (if you didn't set
   ERC-2981 at launch). The website is already set if you filled it in at
   launch — it ships in the contractURI JSON as `external_link`.
4. Collection → Edit → Links: connect **X (Twitter)** and Discord. This is an
   OAuth flow that exists only in OpenSea's settings UI — there is no metadata
   field or API for it, so it cannot be automated.
5. Collection → Edit: switch the collection's **trading currency** from USDG
   (the Robinhood Chain default) to **ETH** if you want secondary listings and
   the floor denominated in ETH. Off-chain OpenSea marketplace preference —
   no contract field or public API exists for it, so it's a manual toggle.
   (Either way the primary mint settles in native ETH via SeaDrop, and buyers
   can still pay with other tokens — OpenSea swaps at checkout.)
6. Optional: OpenSea Studio drop-page cosmetics (gallery, story sections).
7. Post-reveal, if an item shows the placeholder: … → Refresh metadata.

## FAQ

**Why 2 signatures?** TX 1 deploys the contract (constructor can't configure
the drop — SeaDrop only accepts configuration from the deployed token itself).
TX 2 is `multiConfigure`, which batches *all* drop parameters into one call.
That's the minimum SeaDrop allows. (A royalty % adds an optional third —
`setRoyaltyInfo` isn't part of `multiConfigure`.)

**Why does the real art upload only at reveal?** IPFS is public. If the full
metadata directory exists before mint-out, anyone can scrape rarities and
snipe the best tokens. Pre-reveal, every token points at one shared
"unrevealed" JSON; `setBaseURI` at reveal flips the whole collection at once.

**How do I change the price/time/limit later?** Status tab → Owner actions →
`updatePublicDrop`. Owner-only, effective immediately, one transaction.

**Can the mint be priced in USDG or WETH?** No — and that's the canonical
SeaDrop contract, not this app: `mintPublic` is `payable` and validates
`msg.value == quantity × mintPrice`, paying out with native-ETH transfers.
ERC-20 pricing would require a custom drop contract that OpenSea's drop
indexing doesn't recognize, which defeats the point of LaunchPad. Buyers can
still pay with other tokens on OpenSea's *secondary* market (OpenSea swaps for
them); the primary mint settles in native ETH.

**Enforced vs signal-only royalties?** ERC-2981 (`setRoyaltyInfo`) is just an
on-chain request — marketplaces may ignore it. "Enforced" additionally sets
OpenSea's transfer validator, which restricts transfers to royalty-respecting
channels. Trade-off: enforcement limits composability (some marketplaces and
protocols won't be able to move the tokens), which is exactly the point.

**Can I raise the supply later?** `setMaxSupply` technically allows any value
not below the minted count, but treat supply as a promise to buyers — LaunchPad
surfaces it for *cutting* supply after mint slows.

**Why are metadata files named `1` and not `1.json`?** `ERC721SeaDrop.tokenURI`
returns `baseURI + tokenId` with no suffix. Files must match or every token 404s.

**Why does my wallet ask to "add network"?** First contact with Robinhood
Chain: the app offers chain id 4663 with the official RPC/explorer via your
wallet's add-chain prompt. One click, then switch.

**Where do mint proceeds go?** They stream to the creator payout address on
every mint (SeaDrop splits fee vs. payout in the mint transaction). There is no
withdraw step and no funds ever sit in the app.
