import { useEffect, useState } from "react";
import Landing from "./components/Landing";
import ConnectBar from "./components/ConnectBar";
import DashboardTab from "./components/DashboardTab";
import UpcomingTab from "./components/UpcomingTab";
import ScannerTab from "./components/ScannerTab";
import LiveTab from "./components/LiveTab";
import { adoptSharedLink } from "./lib/shareLink";
import { saveRunnerCreds } from "./lib/runnerClient";
import LaunchTab from "./components/LaunchTab";
import RevealTab from "./components/RevealTab";
import FundingTab from "./components/FundingTab";
import ServerWalletsTab from "./components/ServerWalletsTab";
import SnipeTab from "./components/SnipeTab";
import StatusTab from "./components/StatusTab";
import WalletsTab from "./components/WalletsTab";
import { installClickSound } from "./lib/sound";
import { useActiveChain } from "./signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "./chains";
import {
  ChevronDownIcon,
  CrosshairIcon,
  EyeIcon,
  GridIcon,
  CoinsIcon,
  CalendarIcon,
  KeyIcon,
  RadarIcon,
  ActivityIcon,
  PulseIcon,
  RocketIcon,
  WalletIcon,
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
  | "upcoming"
  | "scanner"
  | "live";

const TAB_ICON = {
  launch: RocketIcon,
  reveal: EyeIcon,
  status: PulseIcon,
  wallets: WalletIcon,
  dashboard: GridIcon,
  snipe: CrosshairIcon,
  serverwallets: KeyIcon,
  funding: CoinsIcon,
  upcoming: CalendarIcon,
  scanner: RadarIcon,
  live: ActivityIcon,
} as const;

/**
 * A shared view, read from the fragment once at startup.
 *
 * Done at module load rather than in an effect so the first render already
 * knows: a viewer should never see the owner's tabs flash past before being
 * dropped into the feed. The credentials go into session storage, so they last
 * the tab and no longer, and the fragment is wiped from the address bar so a
 * screenshot of the page does not carry the token.
 */
const shared = adoptSharedLink(saveRunnerCreds);

export default function App() {
  const [tab, setTab] = useState<Tab>(shared ? "live" : "dashboard");
  const [entered, setEntered] = useState(
    // A shared link goes straight to the feed: the landing page is an
    // invitation to set the thing up, and a viewer has nothing to set up.
    () => shared !== null || localStorage.getItem("launchpad.entered") === "1",
  );
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

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
        {(shared
          ? ([
              ["live", "LIVE"],
              ["scanner", "SCANNER"],
            ] as const)
          : ([
              ["wallets", "TRACKER"],
              ["scanner", "SCANNER"],
              ["live", "LIVE"],
              ["upcoming", "WATCHLIST"],
            ] as const)
        ).map(([t, label]) => {
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
        {shared ? null : (
          <>
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
              tab === "snipe" ? "active" : tab === "serverwallets" || tab === "funding" ? "group-active" : ""
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
          </div>
        </div>
          </>
        )}
      </div>
      {tab === "dashboard" ? <DashboardTab /> : null}
      {tab === "launch" ? <LaunchTab /> : null}
      {tab === "reveal" ? <RevealTab /> : null}
      {tab === "status" ? <StatusTab /> : null}
      {tab === "wallets" ? <WalletsTab /> : null}
      {tab === "snipe" ? <SnipeTab /> : null}
      {tab === "serverwallets" ? <ServerWalletsTab /> : null}
      {tab === "funding" ? <FundingTab /> : null}
      {tab === "upcoming" ? <UpcomingTab /> : null}
      {tab === "scanner" ? <ScannerTab onSnipe={() => setTab("snipe")} /> : null}
      {tab === "live" ? <LiveTab onSnipe={() => setTab("snipe")} /> : null}
      <div className="footer">
        {info.label} · explorer:{" "}
        <a href={info.explorerUrl} target="_blank" rel="noreferrer">
          {info.explorerUrl.replace("https://", "")}
        </a>
      </div>
    </div>
  );
}
