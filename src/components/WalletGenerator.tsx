/**
 * Make new wallets for the server, optionally with a chosen start and/or end
 * of the address.
 *
 * Keys are made here, in the browser, and go to the server the same way pasted
 * keys do — the server seals them into its keystore and never hands them back.
 * So the page offers the one copy you can keep, before or after adding.
 *
 * A pattern is a brute-force search (see lib/vanity.ts) spread over the
 * machine's cores in workers, so the page stays usable while it runs.
 */
import { useEffect, useRef, useState } from "react";
import { getAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  MAX_PATTERN_CHARS,
  expectedTries,
  normalizePattern,
  randomWallet,
} from "../lib/vanity";

type Call = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

interface Made {
  key: `0x${string}`;
  address: string;
}

const MAX_COUNT = 500;

function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s < 1) return "<1 s";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export default function WalletGenerator({
  call,
  onAdded,
}: {
  call: Call;
  /** The server has new wallets: reload the list. */
  onAdded: () => void | Promise<void>;
}) {
  const [count, setCount] = useState("10");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<Made[]>([]);
  const [running, setRunning] = useState(false);
  const [rate, setRate] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const [savedCopy, setSavedCopy] = useState(false);

  const workers = useRef<Worker[]>([]);
  useEffect(() => () => stopWorkers(), []);

  function stopWorkers() {
    for (const w of workers.current) w.terminate();
    workers.current = [];
  }

  let pre = "";
  let suf = "";
  let patternError: string | null = null;
  try {
    pre = normalizePattern(prefix);
    suf = normalizePattern(suffix);
    if (pre.length + suf.length > MAX_PATTERN_CHARS) {
      patternError = `at most ${MAX_PATTERN_CHARS} characters across start and end — each one is 16× longer`;
    }
  } catch (e) {
    patternError = e instanceof Error ? e.message : String(e);
  }
  const n = Math.floor(Number(count));
  const countOk = Number.isFinite(n) && n >= 1 && n <= MAX_COUNT;
  const tries = expectedTries(pre, suf);
  const cores = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  // A first guess until the search reports its real speed: ~25k keys/s a core.
  const guessRate = rate || cores * 25_000;
  const eta = pre || suf ? ((countOk ? n : 1) - made.length) * (tries / guessRate) : 0;

  function generate() {
    setError(null);
    setNotice(null);
    setAddedCount(0);
    setSavedCopy(false);
    if (!countOk || patternError) return;

    if (!pre && !suf) {
      const out: Made[] = [];
      for (let i = 0; i < n; i++) {
        const w = randomWallet();
        out.push({ key: w.key, address: getAddress(w.address) });
      }
      setMade(out);
      return;
    }

    setMade([]);
    setRunning(true);
    setRate(0);
    setElapsed(0);
    const t0 = performance.now();
    let tried = 0;
    const found: Made[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < cores; i++) {
      const w = new Worker(new URL("../lib/vanity.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (
        e: MessageEvent<{ type: "found" | "progress"; tried: number; key?: `0x${string}`; address?: string }>,
      ) => {
        tried += e.data.tried;
        const secs = (performance.now() - t0) / 1000;
        setElapsed(secs);
        if (secs > 0.5) setRate(tried / secs);
        if (e.data.type !== "found" || !e.data.key || found.length >= n) return;
        // Trust nothing a worker says about a key: derive the address again.
        const address = privateKeyToAddress(e.data.key);
        const lower = address.toLowerCase().slice(2);
        if (!lower.startsWith(pre) || !lower.endsWith(suf) || seen.has(lower)) return;
        seen.add(lower);
        found.push({ key: e.data.key, address });
        setMade([...found]);
        if (found.length >= n) {
          stopWorkers();
          setRunning(false);
        }
      };
      w.onerror = (ev) => {
        stopWorkers();
        setRunning(false);
        setError(`search stopped: ${ev.message || "worker failed"}`);
      };
      w.postMessage({ prefix: pre, suffix: suf });
      workers.current.push(w);
    }
  }

  function stop() {
    stopWorkers();
    setRunning(false);
    if (made.length) setNotice(`Stopped with ${made.length} of ${n} found — those can still be added.`);
  }

  function download() {
    const lines = ["address,privateKey", ...made.map((m) => `${m.address},${m.key}`)];
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.download = `orvex-wallets-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setSavedCopy(true);
  }

  async function addToServer() {
    if (!made.length) return;
    setAdding(true);
    setError(null);
    try {
      const r = (await call("/api/wallets", {
        method: "POST",
        body: JSON.stringify({
          keys: made.map((m) => m.key).join("\n"),
          label: label.trim() || undefined,
        }),
      })) as { added?: number; rejected?: number };
      setAddedCount(r.added ?? 0);
      setNotice(
        `Added ${r.added ?? 0} wallet(s) to the server` +
          (r.rejected ? ` · ${r.rejected} rejected` : "") +
          (savedCopy ? "." : " — download the keys if you want a copy; the server never gives them back."),
      );
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  function clear() {
    if (!savedCopy && addedCount < made.length && !window.confirm("These keys are not saved or added anywhere. Discard them?")) {
      return;
    }
    setMade([]);
    setNotice(null);
    setAddedCount(0);
    setSavedCopy(false);
  }

  const shown = made.slice(0, 50);
  const mark = (a: string) => {
    const body = a.slice(2);
    const p = pre.length;
    const s = suf.length;
    return (
      <>
        0x
        {p ? <b className="ok">{body.slice(0, p)}</b> : null}
        {body.slice(p, body.length - s)}
        {s ? <b className="ok">{body.slice(body.length - s)}</b> : null}
      </>
    );
  };

  return (
    <div className="panel">
      <h2>Generate wallets</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        New random wallets, made in this browser. Optionally pick how the
        address starts and/or ends — every extra character makes the search 16×
        longer, so 3–4 are quick, 5 takes a while, 6+ can take hours. Matching
        ignores upper/lower case.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
        <div className="field" style={{ width: 90 }}>
          <label>how many</label>
          <input
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={running}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label>starts with (optional)</label>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="0x… e.g. 777"
            disabled={running}
            spellCheck={false}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label>ends with (optional)</label>
          <input
            value={suffix}
            onChange={(e) => setSuffix(e.target.value)}
            placeholder="e.g. 000"
            disabled={running}
            spellCheck={false}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label>label (optional)</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="batch name" maxLength={60} />
        </div>
      </div>

      {patternError ? <p className="error">{patternError}</p> : null}
      {!countOk && count ? <p className="error">1 to {MAX_COUNT} at a time</p> : null}
      {(pre || suf) && !patternError && countOk ? (
        <p className="dim" style={{ marginBottom: 0 }}>
          ~{tries.toLocaleString()} keys to try per wallet · {cores} core(s)
          {rate ? ` · ${Math.round(rate).toLocaleString()} keys/s` : ""} · about{" "}
          <b>{fmtDuration(eta)}</b> {running ? "left" : `for ${n}`}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {running ? (
          <button className="secondary" onClick={stop}>
            STOP ({made.length}/{n} · {fmtDuration(elapsed)})
          </button>
        ) : (
          <button className="primary" disabled={!countOk || !!patternError} onClick={generate}>
            {pre || suf ? `SEARCH ${countOk ? n : ""} WALLET(S)` : `GENERATE ${countOk ? n : ""} WALLET(S)`}
          </button>
        )}
        {made.length > 0 && !running ? (
          <>
            <button
              className="primary"
              disabled={adding || addedCount >= made.length}
              onClick={() => void addToServer()}
            >
              {adding ? (
                <span className="spin">ADDING</span>
              ) : addedCount >= made.length ? (
                "ADDED ✓"
              ) : (
                `ADD ${made.length} TO SERVER`
              )}
            </button>
            <button className="secondary" onClick={download}>
              {savedCopy ? "DOWNLOADED ✓" : "DOWNLOAD KEYS (.csv)"}
            </button>
            <button className="secondary" onClick={clear}>
              CLEAR
            </button>
          </>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}

      {made.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="projects">
            <thead>
              <tr>
                <th>#</th>
                <th>address</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m, i) => (
                <tr key={m.address}>
                  <td className="dim">{i + 1}</td>
                  <td className="mono-break">{mark(m.address)}</td>
                </tr>
              ))}
              {made.length > shown.length ? (
                <tr>
                  <td colSpan={2} className="dim">
                    …and {made.length - shown.length} more (all in the download)
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="hint dim" style={{ marginBottom: 0 }}>
        The keys stay in this tab until you add them or clear. The server stores
        what you add encrypted and never shows a key again — the .csv is the only
        copy you can keep. Treat it like cash.
      </p>
    </div>
  );
}
