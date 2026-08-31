import { useMe } from "../lib/runnerClient";

/**
 * The server URL + token inputs, in one place and shown to no one but the
 * operator.
 *
 * Every data tab used to carry its own copy of these two fields, which meant a
 * normal visitor saw the box's address and a "SNIPE_TOKEN" prompt on the
 * scanner, the calendar, the watchlist — operator plumbing that is meaningless
 * and slightly alarming to them. This is that pair, extracted, and it renders
 * nothing at all unless the viewer is the operator/admin. A visitor talks to
 * the baked-in backend with their wallet session and never sees a server
 * address.
 */
export default function RunnerConnect({
  url,
  setUrl,
  token,
  setToken,
  compact,
}: {
  url: string;
  setUrl: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  /** Tighter min-widths for narrow panels. */
  compact?: boolean;
}) {
  const { me } = useMe();
  // Until we know who the viewer is, show nothing — better a blank than a flash
  // of the operator box for a normal user on a slow /me.
  if (!me?.admin) return null;
  const min = compact ? 160 : 200;
  return (
    <div className="row" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <div className="field" style={{ flex: 2, minWidth: min + 40 }}>
        <label>server URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-tunnel.trycloudflare.com"
        />
      </div>
      <div className="field" style={{ flex: 1, minWidth: min }}>
        <label>token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="SNIPE_TOKEN"
          autoComplete="off"
        />
      </div>
    </div>
  );
}
