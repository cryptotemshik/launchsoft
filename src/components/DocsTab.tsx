import { goTab } from "../lib/nav";

/**
 * The manual. Public and read-only — a visitor can learn what everything does
 * without a wallet. Prose lives here; the working free/Pro comparison table and
 * the "Get Pro" button live on the Pricing tab, and this links across to it
 * rather than duplicating the numbers that could drift.
 */

interface Service {
  id: string;
  name: string;
  tab?: string;
  what: string;
  free: string;
  pro?: string;
}

const SERVICES: Service[] = [
  {
    id: "scanner",
    name: "Scanner",
    tab: "scanner",
    what:
      "Drops nobody has announced yet. A creator configures the public mint stage on-chain — price, start time, supply, per-wallet cap — before telling anyone, and the contract emits that whole struct as an event. One log query surfaces every scheduled drop, ranked, with a risk score and the creator's other collections attached.",
    free: "mints opening in the next 6 hours",
    pro: "the whole schedule, up to 14 days ahead",
  },
  {
    id: "live",
    name: "Live mint board",
    tab: "live",
    what:
      "What is minting right now, ordered by momentum — mints per minute, unique buyers, how concentrated the buying is. The pulse that tells a real launch from a dead one.",
    free: "full access",
  },
  {
    id: "calendar",
    name: "Calendar",
    tab: "calendar",
    what: "Everything scheduled, laid out by day — a month view of what opens when.",
    free: "full access",
  },
  {
    id: "watchlist",
    name: "Watchlist",
    tab: "upcoming",
    what:
      "The drops you have marked to keep an eye on. Mark a row anywhere in the scanner and it parks here with its start-time countdown.",
    free: "full access",
  },
  {
    id: "tracker",
    name: "Wallet tracker",
    tab: "wallets",
    what:
      "A live activity feed for wallets you follow — every NFT they acquire on Robinhood Chain, as it happens. Delivered to Telegram if you link it.",
    free: "up to 3 wallets to Telegram",
    pro: "up to 100 wallets",
  },
  {
    id: "whales",
    name: "Whale Alerts",
    tab: "whales",
    what:
      "The signal that matters: when three or more tracked whales buy into the same collection in a short window, that collection lights up. Curated whale list, tunable threshold.",
    free: "—",
    pro: "full access + the whale list, and delivery to Telegram",
  },
  {
    id: "inspect",
    name: "Inspect",
    tab: "inspect",
    what:
      "Paste any wallet address and see what it holds — ETH balance, NFTs, and NFT PnL on Robinhood Chain. Hover any address anywhere in the app for a quick peek card.",
    free: "15 lookups / minute",
    pro: "90 lookups / minute",
  },
  {
    id: "feed",
    name: "Alpha Feed",
    tab: "feed",
    what:
      "Short owner-written write-ups on projects worth watching, each with a clickable whitelist checklist you can tick off (saved to your account). Pro articles land here first — that head start is the point.",
    free: "free articles in full; Pro articles show a preview",
    pro: "every article in full + the WL checklist, and a Telegram ping on each new Pro post",
  },
  {
    id: "pnl",
    name: "Your PnL",
    tab: "pnl",
    what:
      "Your own mint profit and loss on Robinhood Chain — cost from the mint transactions, revenue from sales, netted per collection.",
    free: "totals + a per-collection table",
    pro: "+ a profit-over-time chart and CSV export",
  },
  {
    id: "snipe",
    name: "Launch, Snipe, Wallets & Funding",
    tab: "snipe",
    what:
      "The core loop. Snipe arms a mint to fire the moment it opens, from server-held wallets you fund. Launch runs your own drop. Wallets manages the server's sniping wallets; Funding moves money in and out.",
    free: "full access on any plan",
  },
];

/**
 * A free/Pro badge that wraps. The app's `.pill` is `white-space: nowrap` —
 * fine for short labels, but a full sentence like "Pro: every article in full…"
 * would then overflow the viewport and force a phone to zoom the whole page out.
 * This one wraps and never exceeds the column.
 */
function Badge({
  children,
  pro,
  muted,
}: {
  children: React.ReactNode;
  pro?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        maxWidth: "100%",
        whiteSpace: "normal",
        border: `1px solid ${pro ? "var(--green, #37d67a)" : "var(--border, #20281f)"}`,
        color: pro ? "var(--green-bright, var(--green))" : muted ? "var(--dim)" : "var(--text)",
        borderRadius: 6,
        padding: "3px 9px",
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

function Anchor({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <button
      className="secondary link-btn"
      style={{ fontSize: 12 }}
      onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
    >
      {children}
    </button>
  );
}

export default function DocsTab() {
  return (
    <div>
      {/* ── Overview ─────────────────────────────────────────────── */}
      <div className="panel">
        <h2>Docs</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Orvex is a launcher and sniper for NFT drops on Robinhood Chain.
          It finds drops before they are announced, watches the wallets and
          whales that move markets, and fires a mint the instant it opens — from
          wallets the service holds and you fund. Everything shared and
          read-only is free, even without a wallet; a few power features are Pro.
        </p>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <Anchor id="start">Getting started</Anchor>
          <Anchor id="services">Services</Anchor>
          <Anchor id="money">Money &amp; billing</Anchor>
          <Anchor id="telegram">Telegram alerts</Anchor>
          <Anchor id="plans">Free vs Pro</Anchor>
          <Anchor id="security">Security</Anchor>
          <Anchor id="faq">FAQ</Anchor>
        </div>
      </div>

      {/* ── Getting started ──────────────────────────────────────── */}
      <div className="panel" id="start">
        <h2>Getting started</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>
            <b>Just browsing?</b> The Scanner, Live board, Calendar and Watchlist
            work with no wallet at all — open them and look around.
          </li>
          <li>
            <b>Connect a wallet.</b> Use a browser extension, or on a phone tap
            <em> mobile / QR</em> and scan with any WalletConnect wallet. Then
            press <em>sign in</em> — you sign a message to prove the wallet is
            yours. Nothing is charged to connect.
          </li>
          <li>
            <b>Fund.</b> On the Funding tab, top up from a source of your choice —
            a deposit address, your connected wallet, or a stored one. Your money
            stays on your own per-account deposit wallet.
          </li>
          <li>
            <b>Snipe.</b> Point the Snipe tab at a collection; it arms and fires
            when the mint opens. A live snipe costs <b>$2</b>, refunded if it
            doesn&apos;t mint.
          </li>
          <li>
            <b>Go Pro (optional).</b> The Profile tab charges{" "}
            <b>$29.99/mo</b> from your balance to unlock the whale signal, the
            full scanner window, and higher limits.
          </li>
        </ol>
      </div>

      {/* ── Services ─────────────────────────────────────────────── */}
      <div className="panel" id="services">
        <h2>Services</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          What each tab does, and what changes between free and Pro. For now
          everything is scoped to <b>NFTs on Robinhood Chain</b>.
        </p>

        {SERVICES.map((s) => (
          <div
            key={s.id}
            id={s.id}
            style={{ padding: "12px 0", borderTop: "1px solid var(--line, #23242b)" }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{s.name}</h3>
              {s.tab ? (
                <button
                  className="secondary link-btn"
                  style={{ fontSize: 11 }}
                  onClick={() => goTab(s.tab!)}
                >
                  open ↗
                </button>
              ) : null}
            </div>
            <p style={{ margin: "6px 0" }}>{s.what}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
              <Badge muted={s.free === "—"}>Free: {s.free}</Badge>
              {s.pro ? <Badge pro>Pro: {s.pro}</Badge> : null}
            </div>
          </div>
        ))}
      </div>

      {/* ── Money & billing ──────────────────────────────────────── */}
      <div className="panel" id="money">
        <h2>Money &amp; billing</h2>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>
            <b>Custody.</b> Deposits stay on your own per-account deposit wallet.
            Only fees you actually incur are ever settled to the operator — the
            rest is yours to withdraw at any time.
          </li>
          <li>
            <b>Funding a snipe.</b> Fund from a source you choose: paste a private
            key, use your connected browser wallet, use a stored wallet, or draw
            from your deposit balance.
          </li>
          <li>
            <b>Snipe fee.</b> <b>$2</b> per live snipe, charged from your balance
            in ETH — and <b>refunded automatically</b> if the mint doesn&apos;t
            go through.
          </li>
          <li>
            <b>Pro.</b> <b>$29.99/mo</b>, paid from your balance in ETH, from the
            Profile tab. It renews from balance; let it lapse and you drop back to
            free with nothing lost.
          </li>
          <li>
            <b>Withdraw.</b> Take your balance out to any address, whenever you
            like, from the Funding tab.
          </li>
        </ul>
      </div>

      {/* ── Telegram ─────────────────────────────────────────────── */}
      <div className="panel" id="telegram">
        <h2>Telegram alerts</h2>
        <p style={{ marginTop: 0 }}>
          Link your Telegram once (Profile tab → the bot gives you a code) and
          alerts arrive privately, only to you:
        </p>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li><b>Tracker moves</b> — your followed wallets acquiring NFTs.</li>
          <li><b>Whale Alerts</b> (Pro) — whales converging on a collection.</li>
          <li><b>New Pro Feed posts</b> (Pro) — the moment alpha drops.</li>
          <li><b>Personal events</b> — your snipes, fills and refunds.</li>
        </ul>
        <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
          One bot serves everyone, but each account&apos;s alerts are separated by
          its own chat link — you only ever see your own.
        </p>
      </div>

      {/* ── Plans ────────────────────────────────────────────────── */}
      <div className="panel" id="plans">
        <h2>Free vs Pro</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Everything shared and read-only is free — even without a wallet. Pro
          unlocks the whale signal, the full scanner window, and higher limits.
        </p>
        <button className="primary" onClick={() => goTab("pricing")}>
          See the full comparison &amp; get Pro
        </button>
      </div>

      {/* ── Security ─────────────────────────────────────────────── */}
      <div className="panel" id="security">
        <h2>Security &amp; privacy</h2>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>
            Signing in never moves funds — it is a signature that proves the
            wallet is yours, nothing more.
          </li>
          <li>
            Each account is isolated: your wallets, balance, tracker list and
            Telegram link are yours alone and never visible to other users.
          </li>
          <li>
            A private key you paste for <em>fast mode</em> stays in that browser
            tab&apos;s memory only — never saved, never sent, gone on refresh. For
            real funds, prefer wallets that hold only what a session needs.
          </li>
          <li>
            The admin panel is owner-only: every admin action is checked
            server-side, so the tab is invisible and its routes refuse anyone
            else.
          </li>
        </ul>
      </div>

      {/* ── FAQ ──────────────────────────────────────────────────── */}
      <div className="panel" id="faq">
        <h2>FAQ</h2>
        <Faq q="Do I need a wallet to look around?">
          No. The Scanner, Live board, Calendar and Watchlist are open to anyone.
          A wallet is only needed to fund, snipe, track to Telegram, or go Pro.
        </Faq>
        <Faq q="Which chain and assets are supported?">
          For now, NFTs on Robinhood Chain. More may come later.
        </Faq>
        <Faq q="What does a snipe cost, and what if it fails?">
          $2 per live snipe, from your balance in ETH — automatically refunded if
          the mint doesn&apos;t go through.
        </Faq>
        <Faq q="How is my money held?">
          On your own per-account deposit wallet. Only fees you incur are settled
          to the operator; the rest is always withdrawable.
        </Faq>
        <Faq q="Can I cancel Pro?">
          Pro simply renews from your balance each month. Stop it any time from
          Profile — you keep your balance and drop back to the free tier.
        </Faq>
        <Faq q="Why can't I connect on my phone?">
          Use the <em>mobile / QR</em> button and scan with a WalletConnect
          wallet — a phone browser has no extension to connect to directly.
        </Faq>
      </div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details style={{ borderTop: "1px solid var(--line, #23242b)", padding: "10px 0" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>{q}</summary>
      <p className="dim" style={{ margin: "8px 0 0" }}>{children}</p>
    </details>
  );
}
