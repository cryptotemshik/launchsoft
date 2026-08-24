import { useState } from "react";
import Landing from "./components/Landing";
import ConnectBar from "./components/ConnectBar";
import DashboardTab from "./components/DashboardTab";
import LaunchTab from "./components/LaunchTab";
import LiveTab from "./components/LiveTab";
import RevealTab from "./components/RevealTab";
import SnipeTab from "./components/SnipeTab";
import StatusTab from "./components/StatusTab";
import WalletsTab from "./components/WalletsTab";
import { useActiveChain } from "./signer";
import { CHAINS_BY_ID, DEFAULT_CHAIN_ID } from "./chains";
import {
  CrosshairIcon,
  EyeIcon,
  GridIcon,
  PulseIcon,
  RocketIcon,
  TrendingIcon,
  WalletIcon,
} from "./components/icons";

type Tab =
  | "dashboard"
  | "launch"
  | "reveal"
  | "status"
  | "live"
  | "wallets"
  | "snipe";

const TAB_ICON = {
  launch: RocketIcon,
  reveal: EyeIcon,
  status: PulseIcon,
  live: TrendingIcon,
  wallets: WalletIcon,
  dashboard: GridIcon,
  snipe: CrosshairIcon,
} as const;

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [entered, setEntered] = useState(
    () => localStorage.getItem("launchpad.entered") === "1",
  );
  const info = useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;

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
        {(["launch", "reveal", "status", "live", "wallets", "dashboard"] as const).map((t) => {
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
        <button
          className={`tab-mint ${tab === "snipe" ? "active" : ""}`}
          onClick={() => setTab("snipe")}
        >
          <CrosshairIcon />
          SNIPE
        </button>
      </div>
      {tab === "dashboard" ? <DashboardTab /> : null}
      {tab === "launch" ? <LaunchTab /> : null}
      {tab === "reveal" ? <RevealTab /> : null}
      {tab === "status" ? <StatusTab /> : null}
      {tab === "live" ? <LiveTab /> : null}
      {tab === "wallets" ? <WalletsTab /> : null}
      {tab === "snipe" ? <SnipeTab /> : null}
      <div className="footer">
        {info.label} · explorer:{" "}
        <a href={info.explorerUrl} target="_blank" rel="noreferrer">
          {info.explorerUrl.replace("https://", "")}
        </a>
      </div>
    </div>
  );
}
