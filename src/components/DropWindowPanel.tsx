import { useEffect, useState, type ReactNode } from "react";
import type { CollectionStatus } from "../lib/collectionData";
import { unixToLocalAndUtc } from "../lib/convert";
import {
  describeWindow,
  formatDuration,
  secondsToDuration,
  windowFromDuration,
  windowWarnings,
  type Duration,
} from "../lib/dropWindow";

/**
 * The drop window, stated in both languages: absolute start/end (what the
 * contract stores) and duration (what OpenSea's stage dialog shows). Owners can
 * set the end by duration-from-now, which is the operation OpenSea's dialog
 * only approximates.
 */
export default function DropWindowPanel({
  status,
  isOwner,
  busy,
  onSetWindow,
  onSetStageMeta,
}: {
  status: CollectionStatus;
  isOwner: boolean;
  busy: boolean;
  /** Sends updatePublicDrop with the new absolute window. */
  onSetWindow: (startTime: number, endTime: number) => void;
  /** Sends updateDropURI with a JSON payload describing the stage. */
  onSetStageMeta: (dropUriJson: string) => void;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const { startTime, endTime } = status.publicDrop;
  const info = describeWindow(startTime, endTime, now);
  const warnings = windowWarnings(startTime, endTime, now);

  const [dur, setDur] = useState<Duration>({ days: 30, hours: 0, mins: 0 });
  const [keepStart, setKeepStart] = useState(true);
  const [stageName, setStageName] = useState("Public");
  const [stageDesc, setStageDesc] = useState("");

  const preview = windowFromDuration(dur, now, {
    keepStart: keepStart ? startTime : undefined,
  });

  const stateLabel: Record<typeof info.state, ReactNode> = {
    unconfigured: <span className="warn">not configured</span>,
    pending: (
      <span className="warn">
        opens in {formatDuration(info.startsInSeconds)}
      </span>
    ),
    live: (
      <span className="ok">
        ● LIVE — {formatDuration(info.remainingSeconds)} left
      </span>
    ),
    ended: <span className="error">CLOSED</span>,
  };

  return (
    <div className="panel">
      <h2>Drop window</h2>

      {warnings.length > 0 ? (
        <ul className="errors" style={{ marginTop: 0 }}>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      <dl className="kv">
        <dt>status</dt>
        <dd>{stateLabel[info.state]}</dd>
        {startTime > 0 ? (
          <>
            <dt>starts</dt>
            <dd>
              {unixToLocalAndUtc(startTime).local}
              <div className="dim">{unixToLocalAndUtc(startTime).utc}</div>
            </dd>
            <dt>ends</dt>
            <dd>
              {unixToLocalAndUtc(endTime).local}
              <div className="dim">{unixToLocalAndUtc(endTime).utc}</div>
            </dd>
            <dt>total length</dt>
            <dd>
              {formatDuration(info.totalSeconds)}
              <span className="dim">
                {" "}
                · elapsed {formatDuration(info.elapsedSeconds)} · left{" "}
                {formatDuration(info.remainingSeconds)}
              </span>
            </dd>
          </>
        ) : null}
      </dl>

      <p className="hint warn" style={{ marginTop: 4 }}>
        <b>Editing the stage on OpenSea can shorten it.</b> That dialog has no
        end-time field — only <i>Duration</i> — so pressing <b>Update</b> makes
        OpenSea re-derive the end time. On a stage that is already running, the
        window can come back shorter than it was, and repeating it can leave
        only minutes. Set the window here instead, and after any edit on
        OpenSea press <b>read</b> above and check the numbers in this panel.
      </p>

      {isOwner ? (
        <>
          <h3 style={{ fontSize: 13, margin: "18px 0 8px" }}>
            Set the end by duration (counted from now)
          </h3>
          <div className="dur-row">
            {(["days", "hours", "mins"] as const).map((unit) => (
              <div className="field dur-field" key={unit}>
                <label>{unit}</label>
                <input
                  type="number"
                  min={0}
                  value={dur[unit]}
                  onChange={(e) =>
                    setDur({ ...dur, [unit]: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            ))}
            <div className="field dur-preset">
              <label>presets</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(
                  [
                    ["1h", { days: 0, hours: 1, mins: 0 }],
                    ["24h", { days: 1, hours: 0, mins: 0 }],
                    ["7d", { days: 7, hours: 0, mins: 0 }],
                    ["30d", { days: 30, hours: 0, mins: 0 }],
                  ] as [string, Duration][]
                ).map(([label, d]) => (
                  <button
                    key={label}
                    className="secondary"
                    style={{ padding: "4px 10px", fontSize: 11 }}
                    onClick={() => setDur(d)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label
            className="dim"
            style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}
          >
            <input
              type="checkbox"
              checked={keepStart}
              onChange={(e) => setKeepStart(e.target.checked)}
            />
            keep the original start time (uncheck to restart the drop now)
          </label>

          <p className="dim" style={{ marginBottom: 8 }}>
            new window: {unixToLocalAndUtc(preview.startTime).local} →{" "}
            {unixToLocalAndUtc(preview.endTime).local}{" "}
            <span className="ok">
              ({formatDuration(preview.endTime - preview.startTime)} total,{" "}
              {formatDuration(preview.endTime - now)} of minting from now)
            </span>
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="primary"
              disabled={busy || preview.endTime <= now}
              onClick={() => onSetWindow(preview.startTime, preview.endTime)}
            >
              {busy ? "sending…" : "SET WINDOW"}
            </button>
            {info.state === "live" ? (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  setDur(secondsToDuration(info.remainingSeconds + 86_400))
                }
                title="fill the boxes with the time left plus one day"
              >
                + extend by 24h
              </button>
            ) : null}
          </div>
          <p className="hint dim">
            Sends one <code>updatePublicDrop</code> with absolute start/end —
            price, per-wallet limit and fee stay exactly as they are.
          </p>

          <h3 style={{ fontSize: 13, margin: "22px 0 8px" }}>Stage metadata</h3>
          <div className="grid">
            <div className="field">
              <label>stage name</label>
              <input
                value={stageName}
                onChange={(e) => setStageName(e.target.value)}
                placeholder="Public"
              />
            </div>
            <div className="field">
              <label>stage description</label>
              <input
                value={stageDesc}
                onChange={(e) => setStageDesc(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <button
            className="secondary"
            disabled={busy || !stageName.trim()}
            onClick={() =>
              onSetStageMeta(
                JSON.stringify({
                  name: stageName.trim(),
                  ...(stageDesc.trim() ? { description: stageDesc.trim() } : {}),
                }),
              )
            }
          >
            {busy ? "sending…" : "publish stage metadata on-chain"}
          </button>
          <p className="hint warn" style={{ marginBottom: 0 }}>
            Straight answer: SeaDrop&apos;s public drop has <b>no name field</b>
            — this writes a <code>dropURI</code> via{" "}
            <code>updateDropURI</code>, which is the only on-chain home for
            stage metadata. The <b>&ldquo;Stage Name&rdquo; OpenSea shows lives
            in OpenSea&apos;s own database</b>, set through their Edit-stage
            dialog; no collection on these chains publishes a dropURI, so expect
            OpenSea to keep showing whatever you typed there. Rename it on
            OpenSea if you need the label changed — just re-check this
            panel&apos;s window afterwards.
          </p>
        </>
      ) : null}
    </div>
  );
}
