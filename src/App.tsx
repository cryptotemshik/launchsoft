import { useEffect, useRef, useState } from "react";
import Landing from "./components/Landing";
import ConnectBar from "./components/ConnectBar";
import DashboardTab from "./components/DashboardTab";
import UpcomingTab from "./components/UpcomingTab";
import ScannerTab from "./components/ScannerTab";
import LiveTab from "./components/LiveTab";
import CalendarTab from "./components/CalendarTab";
import LaunchTab from "./components/LaunchTab";
import RevealTab from "./components/RevealTab";
import FundingTab from "./components/FundingTab";
import ServerWalletsTab from "./components/ServerWalletsTab";
import MintProfitPanel from "./components/MintProfitPanel";
import WalletInspectTab from "./components/WalletInspectTab";
import FeedTab from "./components/FeedTab";
import PricingTab from "./components/PricingTab";
import DocsTab from "./components/DocsTab";
import ReferralsTab from "./components/ReferralsTab";
import SnipeTab from "./components/SnipeTab";
import StatusTab from "./components/StatusTab";
import WalletsTab from "./components/WalletsTab";
import ProfileTab from "./components/ProfileTab";
import AdminTab from "./components/AdminTab";
import WhaleAlertTab from "./components/WhaleAlertTab";
import { installClickSound } from "./lib/sound";
import { useRunnerApi, useMe } from "./lib/runnerClient";
import { captureRefFromUrl, clearRefCode, pendingRefCode } from "./lib/referral";
import { useActiveChain } from "./signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "./chains";
import {
  ChevronDownIcon,
  CrosshairIcon,
  EyeIcon,
  GridIcon,
  CoinsIcon,
  CalendarGridIcon,
  CalendarIcon,
  KeyIcon,
  RadarIcon,
  ActivityIcon,
  PulseIcon,
  RocketIcon,
  WalletIcon,
  UserIcon,
  ShieldIcon,
  WhaleIcon,
  StarIcon,
  BookIcon,
  GiftIcon,
} from "./components/icons";

type Tab =
  | "dashboard"
  | "launch"
  | "reveal"
  | "status"
  | "wallets"
  | "snipe"
  | "serverwallets"
  | "funding"
  | "pnl"
  | "upcoming"
  | "scanner"
  | "live"
  | "calendar"
  | "profile"
  | "admin"
  | "whales"
  | "inspect"
  | "feed"
  | "pricing"
  | "docs"
  | "referrals"
;

const TAB_ICON = {
  launch: RocketIcon,
  reveal: EyeIcon,
  status: PulseIcon,
  wallets: WalletIcon,
  dashboard: GridIcon,
  snipe: CrosshairIcon,
  serverwallets: KeyIcon,
  funding: CoinsIcon,
  pnl: ActivityIcon,
  upcoming: CalendarIcon,
  scanner: RadarIcon,
  live: ActivityIcon,
  calendar: CalendarGridIcon,
  profile: UserIcon,
  admin: ShieldIcon,
  whales: WhaleIcon,
  inspect: EyeIcon,
  feed: PulseIcon,
  pricing: StarIcon,
  docs: BookIcon,
  referrals: GiftIcon,
} as const;

export default function App() {
  const [tab, setTab] = useState<Tab>("scanner");
  // Which nav group's menu is open, if any. One at a time; a tap toggles it,
  // hover opens it on a mouse, and a tap outside or picking a tab closes it.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(
    () => localStorage.getItem("launchpad.entered") === "1",
  );
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

  // Is the signed-in wallet an admin? Decides whether the admin tab exists at
  // all. Checked against the server, which is the only authority — the tab is
  // gated on its own routes too, so this only hides a button, never trusts one.
  const { base, token, call } = useRunnerApi();
  const { me } = useMe();
  const [isAdmin, setIsAdmin] = useState(false);

  // Referral attribution: grab ?ref= on first paint; once signed in and not yet
  // bound, tell the server who referred this account (once).
  useEffect(() => captureRefFromUrl(), []);
  useEffect(() => {
    if (!base || !token || !me?.address || me.referredBy) return;
    const code = pendingRefCode();
    if (!code) return;
    void call("/api/referrals/bind", { method: "POST", body: JSON.stringify({ code }) })
      .then(() => clearRefCode())
      .catch(() => {
        /* leave the code in place to retry on next load */
      });
  }, [base, token, me, call]);
  useEffect(() => {
    let live = true;
    if (!base || !token) {
      setIsAdmin(false);
      return;
    }
    void call("/api/auth/me")
      .then((m) => {
        if (live) setIsAdmin(Boolean((m as { admin?: boolean }).admin));
      })
      .catch(() => {
        if (live) setIsAdmin(false);
      });
    return () => {
      live = false;
    };
  }, [base, token, call]);
  // Never leave a non-admin parked on the admin tab (e.g. after signing out).
  useEffect(() => {
    if (tab === "admin" && !isAdmin) setTab("scanner");
  }, [tab, isAdmin]);

  // One capture-phase listener gives every button its click tick — and the
  // first of those clicks is the user gesture that unlocks the AudioContext.
  useEffect(() => installClickSound(), []);

  // Panels switch tabs by firing an "lp-nav" event (see lib/nav) — upsell
  // buttons use it to send someone to PRICING or PROFILE.
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent).detail;
      if (typeof t === "string") {
        setTab(t as Tab);
        setOpenGroup(null);
      }
    };
    window.addEventListener("lp-nav", h);
    return () => window.removeEventListener("lp-nav", h);
  }, []);

  // A tap or click outside the nav closes an open group menu. Only armed while
  // one is open, so it costs nothing the rest of the time.
  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openGroup]);

  if (!entered) {
    return (
      <Landing
        onEnter={() => {
          localStorage.setItem("launchpad.entered", "1");
          setEntered(true);
        }}
      />
    );
  }

  return (
    <div className="app-enter">
      <ConnectBar
        onHome={() => {
          localStorage.removeItem("launchpad.entered");
          setEntered(false);
        }}
      />
      <div className="tabs" ref={navRef}>
        {/* Five groups, not twenty flat tabs: DISCOVER and SIGNALS gather the
            read-only views, INFO the docs, and the two accent actions — LAUNCH
            and SNIPE — sit at the right with their later stages beneath them.
            Each group's button jumps to its primary tab and toggles a menu;
            picking a child (or tapping outside) closes it. This is the same on
            desktop and phone — no flattened ribbon. */}
        {([
          { key: "discover", label: "DISCOVER", Icon: RadarIcon, tabs: [["scanner", "SCANNER"], ["live", "LIVE"], ["calendar", "CALENDAR"], ["upcoming", "WATCHLIST"]] },
          { key: "signals", label: "SIGNALS", Icon: WhaleIcon, tabs: [["wallets", "TRACKER"], ["whales", "WHALES"], ["inspect", "INSPECT"], ["feed", "FEED"]] },
          { key: "info", label: "INFO", Icon: BookIcon, tabs: [["docs", "DOCS"], ["pricing", "PRICING"]] },
          { key: "launch", label: "LAUNCH", Icon: RocketIcon, mint: true, tabs: [["launch", "LAUNCH"], ["reveal", "REVEAL"], ["status", "STATUS"]] },
          {
            key: "snipe",
            label: "SNIPE",
            Icon: CrosshairIcon,
            mint: true,
            tabs: [
              ["snipe", "SNIPE"],
              ["dashboard", "DASHBOARD"],
              ["serverwallets", "WALLETS"],
              ["funding", "FUNDING"],
              ["pnl", "PNL"],
              ["referrals", "REFERRALS"],
              ["profile", "PROFILE"],
              ...(isAdmin ? [["admin", "ADMIN"]] : []),
            ],
          },
        ] as { key: string; label: string; Icon: typeof RadarIcon; mint?: boolean; tabs: [Tab, string][] }[]).map((g) => {
          const primary = g.tabs[0][0];
          const inGroup = g.tabs.some(([t]) => t === tab);
          const open = openGroup === g.key;
          return (
            <div
              key={g.key}
              className={`tab-group ${g.mint ? "mint-group" : ""} ${g.key === "launch" ? "mint-lead" : ""} ${open ? "open" : ""}`}
              onMouseEnter={() => setOpenGroup(g.key)}
              onMouseLeave={() => setOpenGroup((k) => (k === g.key ? null : k))}
            >
              <button
                className={`${g.mint ? "tab-mint " : ""}${inGroup ? "active" : ""}`}
                onClick={() => {
                  setTab(primary);
                  setOpenGroup(open ? null : g.key);
                }}
              >
                <g.Icon />
                {g.label}
                <ChevronDownIcon className="tab-chevron" width={13} height={13} />
              </button>
              <div className="tab-menu">
                {g.tabs.map(([t, label]) => {
                  const Icon = TAB_ICON[t];
                  return (
                    <button
                      key={t}
                      className={tab === t ? "active" : ""}
                      onClick={() => {
                        setTab(t);
                        setOpenGroup(null);
                      }}
                    >
                      <Icon />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {tab === "dashboard" ? <DashboardTab /> : null}
      {tab === "launch" ? <LaunchTab /> : null}
      {tab === "reveal" ? <RevealTab /> : null}
      {tab === "status" ? <StatusTab /> : null}
      {tab === "wallets" ? <WalletsTab /> : null}
      {tab === "snipe" ? <SnipeTab /> : null}
      {tab === "serverwallets" ? <ServerWalletsTab /> : null}
      {tab === "funding" ? <FundingTab /> : null}
      {tab === "pnl" ? <MintProfitPanel /> : null}
      {/* No onSnipe/onWatch handlers here on purpose. Marking a row parks the
          collection for the snipe tab and adds to the watchlist where asked,
          and that is all it does: someone going down a scan marks three or
          four things, and jumping tabs after the first one costs them their
          place in the list. The snipe tab shows what is waiting when they get
          there. */}
      {tab === "upcoming" ? <UpcomingTab /> : null}
      {tab === "scanner" ? <ScannerTab /> : null}
      {tab === "calendar" ? <CalendarTab /> : null}
      {tab === "live" ? <LiveTab /> : null}
      {tab === "profile" ? <ProfileTab /> : null}
      {tab === "admin" && isAdmin ? <AdminTab /> : null}
      {tab === "whales" ? <WhaleAlertTab /> : null}
      {tab === "inspect" ? <WalletInspectTab /> : null}
      {tab === "feed" ? <FeedTab /> : null}
      {tab === "pricing" ? <PricingTab /> : null}
      {tab === "docs" ? <DocsTab /> : null}
      {tab === "referrals" ? <ReferralsTab /> : null}
      <div className="footer">
        {info.label} · explorer:{" "}
        <a href={info.explorerUrl} target="_blank" rel="noreferrer">
          {info.explorerUrl.replace("https://", "")}
        </a>
      </div>
    </div>
  );
}
