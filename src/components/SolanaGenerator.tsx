/**
 * Solana wallets for download only — nothing goes to the server.
 *
 * Same shape as the EVM generator: how many, an optional start and end of the
 * address, a search spread over the machine's cores, and an .xlsx with the
 * address in column A and the private key in column B. The key is the base58
 * of the 64-byte secret, which Phantom and Solflare import as "private key".
 */
import { useEffect, useRef, useState } from "react";
import {
  MAX_SOL_PATTERN,
  expectedSolTries,
  freshKeys,
  matches,
  normalizeSolPattern,
  verifySolWallet,
  walletFromSeed,
  type SolWallet,
} from "../lib/solVanity";
import { XLSX_TYPE, buildXlsx, downloadBytes, stampedName } from "../lib/xlsx";

const MAX_COUNT = 1000;

function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s < 1) return "<1 s";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} days`;
}

export default function SolanaGenerator() {
  const [count, setCount] = useState("10");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [made, setMade] = useState<SolWallet[]>([]);
  const [running, setRunning] = useState(false);
  const [rate, setRate] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
    pre = normalizeSolPattern(prefix, ignoreCase);
    suf = normalizeSolPattern(suffix, ignoreCase);
    if (pre.length + suf.length > MAX_SOL_PATTERN) {
      patternError = `at most ${MAX_SOL_PATTERN} characters across start and end — each one is ~58× longer`;
    }
  } catch (e) {
    patternError = e instanceof Error ? e.message : String(e);
  }
  const n = Math.floor(Number(count));
  const countOk = Number.isFinite(n) && n >= 1 && n <= MAX_COUNT;
  const tries = expectedSolTries(pre, suf, ignoreCase);
  // Every core but one, so the page and the rest of the machine stay usable.
  const cores = Math.max(1, Math.min(32, (navigator.hardwareConcurrency || 4) - 1));
  const guessRate = rate || cores * 15_000;
  const eta = pre || suf ? ((countOk ? n : 1) - made.length) * (tries / guessRate) : 0;

  async function generate() {
    setError(null);
    setSaved(false);
    if (!countOk || patternError) return;
    if (!pre && !suf) {
      const keys = await freshKeys(n);
      setMade(keys.map((k) => walletFromSeed(k.seed, k.pub)));
      return;
    }
    setMade([]);
    setRunning(true);
    setRate(0);
    setElapsed(0);
    const t0 = performance.now();
    let tried = 0;
    const found: SolWallet[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < cores; i++) {
      const w = new Worker(new URL("../lib/solVanity.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ type: string; tried: number; address?: string; secret?: string }>) => {
        tried += e.data.tried;
        const secs = (performance.now() - t0) / 1000;
        setElapsed(secs);
        if (secs > 0.5) setRate(tried / secs);
        if (e.data.type !== "found" || !e.data.address || !e.data.secret || found.length >= n) return;
        const wallet = { address: e.data.address, secret: e.data.secret };
        // Trust no worker: the seed must re-derive this exact address.
        if (!matches(wallet.address, pre, suf, ignoreCase) || seen.has(wallet.address) || !verifySolWallet(wallet)) return;
        seen.add(wallet.address);
        found.push(wallet);
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
      w.postMessage({ prefix: pre, suffix: suf, ignoreCase });
      workers.current.push(w);
    }
  }

  function stop() {
    stopWorkers();
    setRunning(false);
  }

  function download() {
    const rows = [["Address", "Private key"], ...made.map((m) => [m.address, m.secret])];
    downloadBytes(buildXlsx(rows, { sheet: "Solana", widths: [48, 92] }), stampedName("orvex-solana-wallets"), XLSX_TYPE);
    setSaved(true);
  }

  function clear() {
    if (!saved && !window.confirm("These keys are not saved anywhere. Discard them?")) return;
    setMade([]);
    setSaved(false);
  }

  const shown = made.slice(0, 50);
  const mark = (a: string) => {
    const p = pre.length;
    const s = suf.length;
    return (
      <>
        {p ? <b className="ok">{a.slice(0, p)}</b> : null}
        {a.slice(p, a.length - s)}
        {s ? <b className="ok">{a.slice(a.length - s)}</b> : null}
      </>
    );
  };

  return (
    <div className="panel">
      <h2>Generate Solana wallets</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        Made in this browser and only downloaded — nothing is sent to the server.
        The file has the address on the left and the private key on the right, in
        the form Phantom and Solflare import. Addresses are base58: case matters
        and there is no 0, O, I or l. Each extra character is ~58× longer: 1–3 are
        quick, 4 takes minutes per wallet, 5 hours.
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
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. Sol" disabled={running} spellCheck={false} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label>ends with (optional)</label>
          <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="e.g. 777" disabled={running} spellCheck={false} />
        </div>
        <label className="dim" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, paddingBottom: 8 }}>
          <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} disabled={running} />
          ignore case (faster)
        </label>
      </div>

      {patternError ? <p className="error">{patternError}</p> : null}
      {!countOk && count ? <p className="error">1 to {MAX_COUNT} at a time</p> : null}
      {(pre || suf) && !patternError && countOk ? (
        <p className="dim" style={{ marginBottom: 0 }}>
          ~{Math.round(tries).toLocaleString()} keys to try per wallet · {cores} core(s)
          {rate ? ` · ${Math.round(rate).toLocaleString()} keys/s` : ""} · about <b>{fmtDuration(eta)}</b>{" "}
          {running ? "left" : `for ${n}`}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {running ? (
          <button className="secondary" onClick={stop}>
            STOP ({made.length}/{n} · {fmtDuration(elapsed)})
          </button>
        ) : (
          <button className="primary" disabled={!countOk || !!patternError} onClick={() => void generate()}>
            {pre || suf ? `SEARCH ${countOk ? n : ""} WALLET(S)` : `GENERATE ${countOk ? n : ""} WALLET(S)`}
          </button>
        )}
        {made.length > 0 && !running ? (
          <>
            <button className="primary" onClick={download}>
              {saved ? "DOWNLOADED ✓" : `DOWNLOAD ${made.length} (.xlsx)`}
            </button>
            <button className="secondary" onClick={clear}>
              CLEAR
            </button>
          </>
        ) : null}
        {running && made.length > 0 ? (
          <button className="secondary" onClick={download}>
            DOWNLOAD {made.length} FOUND SO FAR
          </button>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}

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
        The keys exist only in this tab and in the file you save. Treat the file
        like cash.
      </p>
    </div>
  );
}
