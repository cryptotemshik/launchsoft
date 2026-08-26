import { useEffect, useState } from "react";
import Landing from "./components/Landing";
import ConnectBar from "./components/ConnectBar";
import DashboardTab from "./components/DashboardTab";
import UpcomingTab from "./components/UpcomingTab";
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
  | "upcoming";

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
} as const;

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [entered, setEntered] = useState(
    () => localStorage.getItem("launchpad.entered") === "1",
  );
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

  // One capture-phase listener gives every button its click tick — and the
  // first of those clicks is the user gesture that unlocks the AudioContext.
  useEffect(() => installClickSound(), []);

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
        {/* Launch is the entry point; Reveal and Status are its later stages,
            so they live in a hover menu under it instead of as sibling tabs. */}
        <div className="tab-group">
          <button
            className={
              tab === "launch" || tab === "reveal" || tab === "status" ? "active" : ""
            }
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
        {([
          ["wallets", "TRACKER"],
          ["dashboard", "DASHBOARD"],
          ["upcoming", "UPCOMING"],
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
        {/* Snipe is the entry point; the server's wallets belong with it. */}
        <div className="tab-group snipe-group">
          <button
            className={`tab-mint ${tab === "snipe" || tab === "serverwallets" || tab === "funding" ? "active" : ""}`}
            onClick={() => setTab("snipe")}
          >
            <CrosshairIcon />
            SNIPE
            <ChevronDownIcon className="tab-chevron" width={13} height={13} />
          </button>
          <div className="tab-menu">
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
      <div className="footer">
        {info.label} · explorer:{" "}
        <a href={info.explorerUrl} target="_blank" rel="noreferrer">
          {info.explorerUrl.replace("https://", "")}
        </a>
      </div>
    </div>
  );
}
