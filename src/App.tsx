import { useEffect, useState } from "react";
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
import SnipeTab from "./components/SnipeTab";
import StatusTab from "./components/StatusTab";
import WalletsTab from "./components/WalletsTab";
import ProfileTab from "./components/ProfileTab";
import AdminTab from "./components/AdminTab";
import WhaleAlertTab from "./components/WhaleAlertTab";
import { installClickSound } from "./lib/sound";
import { useRunnerApi } from "./lib/runnerClient";
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
} as const;

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [entered, setEntered] = useState(
    () => localStorage.getItem("launchpad.entered") === "1",
  );
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

  // Is the signed-in wallet an admin? Decides whether the admin tab exists at
  // all. Checked against the server, which is the only authority — the tab is
  // gated on its own routes too, so this only hides a button, never trusts one.
  const { base, token, call } = useRunnerApi();
  const [isAdmin, setIsAdmin] = useState(false);
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
    if (tab === "admin" && !isAdmin) setTab("dashboard");
  }, [tab, isAdmin]);

  // One capture-phase listener gives every button its click tick — and the
  // first of those clicks is the user gesture that unlocks the AudioContext.
  useEffect(() => installClickSound(), []);

  // On a phone the nav scrolls sideways — keep the selected tab in view.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 640px)").matches) return;
    document
      .querySelector(".tabs button.active")
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [tab]);

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
      <div className="tabs">
        {([
          ["wallets", "TRACKER"],
          ["whales", "WHALES"],
          ["scanner", "SCANNER"],
          ["live", "LIVE"],
          ["calendar", "CALENDAR"],
          ["upcoming", "WATCHLIST"],
        ] as const).map(([t, label]) => {
          const Icon = TAB_ICON[t];
          return (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              <Icon />
              {label}
            </button>
          );
        })}
        {/* The two things this app is for — starting a drop and taking one —
            sit together at the right, both painted as actions rather than as
            destinations. Their later stages hang beneath them. */}
        <div className="tab-group launch-group">
          <button
            // `group-active` marks "a child of mine is open": the desktop
            // dropdown paints it like active, the mobile bar — where the
            // children are visible as their own tabs — leaves it alone, so
            // two tabs never look selected at once.
            className={`tab-mint ${
              tab === "launch" ? "active" : tab === "reveal" || tab === "status" ? "group-active" : ""
            }`}
            onClick={() => setTab("launch")}
          >
            <RocketIcon />
            LAUNCH
            <ChevronDownIcon className="tab-chevron" width={13} height={13} />
          </button>
          <div className="tab-menu">
            {(["reveal", "status"] as const).map((t) => {
              const Icon = TAB_ICON[t];
              return (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  <Icon />
                  {t.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>
        {/* Snipe is the entry point; the server's wallets belong with it, and
            so does the dashboard that reports what they did. */}
        <div className="tab-group snipe-group">
          <button
            className={`tab-mint ${
              tab === "snipe" ? "active" : tab === "serverwallets" || tab === "funding" || tab === "pnl" || tab === "profile" || tab === "admin" ? "group-active" : ""
            }`}
            onClick={() => setTab("snipe")}
          >
            <CrosshairIcon />
            SNIPE
            <ChevronDownIcon className="tab-chevron" width={13} height={13} />
          </button>
          <div className="tab-menu">
            <button
              className={tab === "dashboard" ? "active" : ""}
              onClick={() => setTab("dashboard")}
            >
              <GridIcon />
              DASHBOARD
            </button>
            <button
              className={tab === "serverwallets" ? "active" : ""}
              onClick={() => setTab("serverwallets")}
            >
              <KeyIcon />
              WALLETS
            </button>
            <button
              className={tab === "funding" ? "active" : ""}
              onClick={() => setTab("funding")}
            >
              <CoinsIcon />
              FUNDING
            </button>
            <button
              className={tab === "pnl" ? "active" : ""}
              onClick={() => setTab("pnl")}
            >
              <ActivityIcon />
              PNL
            </button>
            <button
              className={tab === "profile" ? "active" : ""}
              onClick={() => setTab("profile")}
            >
              <UserIcon />
              PROFILE
            </button>
            {isAdmin ? (
              <button
                className={tab === "admin" ? "active" : ""}
                onClick={() => setTab("admin")}
              >
                <ShieldIcon />
                ADMIN
              </button>
            ) : null}
          </div>
        </div>
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
      <div className="footer">
        {info.label} · explorer:{" "}
        <a href={info.explorerUrl} target="_blank" rel="noreferrer">
          {info.explorerUrl.replace("https://", "")}
        </a>
      </div>
    </div>
  );
}
