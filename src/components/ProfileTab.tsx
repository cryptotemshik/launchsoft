import { useCallback, useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";
import { shortAddress } from "./ConnectBar";

/**
 * Your account, as the server sees it: who you are (the wallet you signed in
 * with), what plan you are on, and the handful of things you get to say about
 * yourself. Everything here is your own — it lives in your isolated world on
 * the box, keyed by your address, and no other account can read or change it.
 *
 * It needs a runner session, which is what "sign in with wallet" on the Snipe
 * tab hands out. Until then there is nothing to show, so it says so plainly
 * rather than sitting empty.
 */
interface Me {
  address: string;
  admin: boolean;
  tier: "free" | "pro";
  proUntil: number | null;
  profile: { nickname?: string; avatarUrl?: string; twitter?: string; telegram?: string };
}

export default function ProfileTab() {
  const { base, token, call } = useRunnerApi();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [nickname, setNickname] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");

  const load = useCallback(async () => {
    if (!base || !token) {
      setMe(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const m = (await call("/api/auth/me")) as unknown as Me;
      setMe(m);
      setNickname(m.profile.nickname ?? "");
      setAvatarUrl(m.profile.avatarUrl ?? "");
      setTwitter(m.profile.twitter ?? "");
      setTelegram(m.profile.telegram ?? "");
    } catch (e) {
      setMe(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base, token, call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const r = (await call("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ nickname, avatarUrl, twitter, telegram }),
      })) as unknown as { profile: Me["profile"] };
      setMe((prev) => (prev ? { ...prev, profile: r.profile } : prev));
      setNickname(r.profile.nickname ?? "");
      setAvatarUrl(r.profile.avatarUrl ?? "");
      setTwitter(r.profile.twitter ?? "");
      setTelegram(r.profile.telegram ?? "");
      setSavedNote("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!base || !token) {
    return (
      <div className="panel">
        <h2>Profile</h2>
        <p className="dim">
          Sign in with your wallet on the <strong>SNIPE</strong> tab to see your
          account. Your profile, watchlist and wallets all live under that
          login — private to you.
        </p>
      </div>
    );
  }

  const label = me?.profile.nickname?.trim() || (me ? shortAddress(me.address) : "");
  const proUntil =
    me?.proUntil != null ? new Date(me.proUntil).toLocaleDateString() : null;

  return (
    <div className="panel">
      <h2>Profile</h2>
      {loading && !me ? <p className="dim">loading…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {me ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
            <div
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: 10,
                overflow: "hidden",
                background: "var(--panel-2, #14151a)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--mono)",
                fontSize: 20,
                flex: "0 0 auto",
              }}
            >
              {me.profile.avatarUrl ? (
                // eslint-disable-next-line jsx-a11y/img-redundant-alt
                <img
                  src={me.profile.avatarUrl}
                  alt="avatar"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                label.slice(0, 2).toUpperCase()
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{label}</div>
              <div className="mono-break dim" style={{ fontSize: 12 }}>{me.address}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <span className={`pill ${me.tier === "pro" ? "ok" : ""}`}>
                  {me.tier === "pro" ? "PRO" : "FREE"}
                </span>
                {proUntil ? <span className="pill dim">until {proUntil}</span> : null}
                {me.admin ? <span className="pill warn">ADMIN</span> : null}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
            <div className="field">
              <label>nickname</label>
              <input
                value={nickname}
                maxLength={40}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={me ? shortAddress(me.address) : ""}
              />
            </div>
            <div className="field">
              <label>avatar URL (an NFT image, or any image link)</label>
              <input
                value={avatarUrl}
                maxLength={2048}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="field">
              <label>twitter / X (optional)</label>
              <input
                value={twitter}
                maxLength={40}
                onChange={(e) => setTwitter(e.target.value.replace(/^@+/, ""))}
                placeholder="handle (without @)"
              />
            </div>
            <div className="field">
              <label>telegram (optional — for tracker &amp; alerts)</label>
              <input
                value={telegram}
                maxLength={40}
                onChange={(e) => setTelegram(e.target.value.replace(/^@+/, ""))}
                placeholder="handle (without @)"
              />
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="primary" onClick={() => void save()} disabled={saving}>
                {saving ? <span className="spin">SAVING</span> : "save profile"}
              </button>
              {savedNote ? <span className="ok">{savedNote}</span> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
