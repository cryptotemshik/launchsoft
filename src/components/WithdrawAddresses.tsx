/**
 * Where the server's wallets may send money and NFTs.
 *
 * The signing policy refuses any destination that is not one of our own
 * wallets, set on the box (`consolidateTo`, SNIPE_WITHDRAW_TO), or registered
 * here at least an hour ago. The server has always had the register; this is
 * the screen for it, so a refused sweep says "register it" instead of pointing
 * at a panel that did not exist.
 *
 * The hour is the point, not an obstacle to route around: a stolen session can
 * add an address, but the registration pings Telegram at once and nothing can
 * follow it until the hour is up.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AddrLink } from "./Bits";

type Call = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

interface Registered {
  address: string;
  label?: string;
  addedAt: number;
  matured: boolean;
  readyInMs: number;
}

export interface WithdrawRegistry {
  registered: Registered[];
  /** Null on a server too old to say. */
  instant: string[] | null;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  register: (address: string, label?: string) => Promise<void>;
  remove: (address: string) => Promise<void>;
}

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
const mins = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export function useWithdrawRegistry(call: Call, enabled: boolean): WithdrawRegistry {
  const [registered, setRegistered] = useState<Registered[]>([]);
  const [instant, setInstant] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = useCallback((r: Record<string, unknown>) => {
    if (Array.isArray(r.addresses)) setRegistered(r.addresses as Registered[]);
    if (Array.isArray(r.instant)) setInstant(r.instant as string[]);
    setLoaded(true);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      take(await call("/api/withdraw-addresses"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [call, take]);

  const register = useCallback(
    async (address: string, label?: string) => {
      take(
        await call("/api/withdraw-addresses", {
          method: "POST",
          body: JSON.stringify({ address: address.trim(), label: label?.trim() || undefined }),
        }),
      );
    },
    [call, take],
  );

  const remove = useCallback(
    async (address: string) => {
      take(
        await call(`/api/withdraw-addresses?address=${encodeURIComponent(address)}`, {
          method: "DELETE",
        }),
      );
    },
    [call, take],
  );

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    // The wait counts down on the server's clock; re-read it now and then so
    // "ready in 12 min" turns into "allowed" without a reload.
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  return { registered, instant, loaded, error, refresh, register, remove };
}

/**
 * One line under a destination field: whether a send there will go through,
 * and if not, the button that starts its hour.
 */
export function DestinationStatus({
  address,
  registry,
  ownWallets,
}: {
  address: string;
  registry: WithdrawRegistry;
  ownWallets: string[];
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const a = address.trim();
  if (!isAddr(a) || !registry.loaded) return null;
  const lower = a.toLowerCase();

  let body: ReactNode;
  if (ownWallets.some((w) => w.toLowerCase() === lower)) {
    body = <span className="ok">✓ one of the server&apos;s wallets — allowed</span>;
  } else if (registry.instant?.includes(lower)) {
    body = <span className="ok">✓ allowed — set on the server</span>;
  } else {
    const r = registry.registered.find((x) => x.address === lower);
    if (r?.matured) {
      body = <span className="ok">✓ allowed — registered{r.label ? ` as “${r.label}”` : ""}</span>;
    } else if (r) {
      body = (
        <span className="warn">
          ⏳ registered — usable in {mins(r.readyInMs)} min. Sends there are refused until then.
        </span>
      );
    } else {
      body = (
        <>
          <span className="warn">Not an allowed destination yet — a send there will be refused. </span>
          <button
            className="secondary"
            style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await registry.register(a);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spin">…</span> : "register (usable in 1 h)"}
          </button>
        </>
      );
    }
  }
  return (
    <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
      {body}
      {err ? <span className="error"> {err}</span> : null}
    </p>
  );
}

export default function WithdrawAddresses({ registry }: { registry: WithdrawRegistry }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      await registry.register(address, label);
      setAddress("");
      setLabel("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function drop(a: string) {
    if (!window.confirm(`Remove ${a} from the allowed destinations?`)) return;
    setErr(null);
    try {
      await registry.remove(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel">
      <h2>Allowed destinations</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        ETH and NFTs leave the server&apos;s wallets only to one of its own
        wallets, to an address set on the server, or to one registered here.
        A registered address becomes usable <b>one hour</b> after it is added,
        and adding one pings Telegram — so a stolen session cannot empty the
        wallets before you see it. Register your selling wallet once; after the
        hour, sends to it are instant for good.
      </p>

      {registry.error ? <p className="error">{registry.error}</p> : null}

      <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 2, minWidth: 220 }}>
          <label>address</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label>label (optional)</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="selling wallet"
            maxLength={60}
          />
        </div>
        <button className="secondary" disabled={busy || !isAddr(address)} onClick={() => void add()}>
          {busy ? <span className="spin">…</span> : "REGISTER"}
        </button>
      </div>
      {err ? <p className="error">{err}</p> : null}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="projects">
          <thead>
            <tr>
              <th>address</th>
              <th>label</th>
              <th>status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(registry.instant ?? []).map((a) => (
              <tr key={`i-${a}`}>
                <td>
                  <AddrLink address={a} />
                </td>
                <td className="dim">set on the server</td>
                <td>
                  <span className="ok">allowed</span>
                </td>
                <td />
              </tr>
            ))}
            {registry.registered.map((r) => (
              <tr key={r.address}>
                <td>
                  <AddrLink address={r.address} />
                </td>
                <td className="dim">{r.label || "—"}</td>
                <td>
                  {r.matured ? (
                    <span className="ok">allowed</span>
                  ) : (
                    <span className="warn">usable in {mins(r.readyInMs)} min</span>
                  )}
                </td>
                <td>
                  <button
                    className="secondary"
                    style={{ padding: "2px 9px", fontSize: 11, width: "auto" }}
                    title="Remove — sends there are refused again at once"
                    onClick={() => void drop(r.address)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {registry.loaded && registry.registered.length === 0 && !(registry.instant ?? []).length ? (
              <tr>
                <td colSpan={4} className="dim">
                  Nothing yet — only the server&apos;s own wallets can receive.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="hint dim" style={{ marginBottom: 0 }}>
        Need one without the wait? Add it to <code>SNIPE_WITHDRAW_TO</code> on the
        server and restart with <code>--update-env</code> — that needs the box
        itself, which is why it skips the hour.
      </p>
    </div>
  );
}
