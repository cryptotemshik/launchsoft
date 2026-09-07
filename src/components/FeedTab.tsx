import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunnerApi, useMe } from "../lib/runnerClient";
import { goTab } from "../lib/nav";

/**
 * The alpha feed: owner-written project write-ups, each with a whitelist
 * checklist you can tick off (saved to your account). Some are free; Pro
 * articles show only a teaser until you upgrade — Pro hears about projects
 * earlier, which is the point.
 */

interface Link {
  label: string;
  url: string;
}
interface ChecklistItem {
  id: string;
  text: string;
}
interface Article {
  id: string;
  title: string;
  project?: string;
  cover?: string;
  tags: string[];
  pro: boolean;
  wlDeadline?: number;
  createdAt: number;
  checklistCount: number;
  locked: boolean;
  body?: string;
  teaser?: string;
  links: Link[];
  checklist: ChecklistItem[];
  checked: string[];
}

function countdown(deadlineSecs: number, now: number): string {
  const s = deadlineSecs - now;
  if (s <= 0) return "closed";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export default function FeedTab() {
  const { base, call } = useRunnerApi();
  const { me } = useMe();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // Local overlay of ticked items, so a click feels instant.
  const [checks, setChecks] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const r = (await call("/api/feed")) as unknown as { articles: Article[] };
      setArticles(r.articles ?? []);
      const seed: Record<string, Set<string>> = {};
      for (const a of r.articles ?? []) seed[a.id] = new Set(a.checked ?? []);
      setChecks(seed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, call]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  async function toggle(articleId: string, itemId: string) {
    if (!me) {
      goTab("snipe"); // sign in from the top bar
      return;
    }
    const cur = new Set(checks[articleId] ?? []);
    const nextChecked = !cur.has(itemId);
    if (nextChecked) cur.add(itemId);
    else cur.delete(itemId);
    setChecks((c) => ({ ...c, [articleId]: cur }));
    try {
      await call("/api/feed/check", {
        method: "POST",
        body: JSON.stringify({ articleId, itemId, checked: nextChecked }),
      });
    } catch {
      void load(); // put it back to whatever the server says
    }
  }

  const list = useMemo(() => articles ?? [], [articles]);

  if (!base) {
    return (
      <div className="panel">
        <h2>Feed</h2>
        <p className="dim">The service address isn&apos;t configured.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="panel">
        <h2>Alpha feed</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Short write-ups on projects worth watching, each with a whitelist
          checklist you can tick off. <b>Pro</b> articles land here first — free
          readers see a preview.
        </p>
        {error ? <p className="error">{error}</p> : null}
        {articles && list.length === 0 ? <p className="dim">Nothing posted yet.</p> : null}
        {!articles ? <p className="dim">Loading…</p> : null}
      </div>

      {list.map((a) => {
        const done = checks[a.id]?.size ?? 0;
        return (
          <div className="panel" key={a.id}>
            {a.cover ? (
              <img
                src={a.cover}
                alt=""
                style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 8, marginBottom: 10 }}
              />
            ) : null}
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>{a.title}</h2>
              {a.pro ? <span className="pill ok">PRO</span> : <span className="pill">free</span>}
              {a.wlDeadline ? (
                <span className={a.wlDeadline - now <= 0 ? "pill warn" : "pill"}>
                  WL: {countdown(a.wlDeadline, now)}
                </span>
              ) : null}
            </div>
            {a.project ? <div className="dim" style={{ marginTop: 2 }}>{a.project}</div> : null}
            {a.tags.length > 0 ? (
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                {a.tags.map((t) => `#${t}`).join(" ")}
              </div>
            ) : null}

            {a.locked ? (
              <>
                <p style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{a.teaser}…</p>
                <div
                  style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}
                >
                  <span className="dim" style={{ fontSize: 12 }}>
                    🔒 Full write-up + {a.checklistCount}-step WL checklist are Pro.
                  </span>
                  <button className="primary" style={{ padding: "3px 12px", fontSize: 11 }} onClick={() => goTab("pricing")}>
                    Get Pro
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ whiteSpace: "pre-wrap" }}>{a.body}</p>

                {a.links.length > 0 ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    {a.links.map((l) => (
                      <a
                        key={l.url}
                        className="secondary btn-like"
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12 }}
                      >
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                ) : null}

                {a.checklist.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
                      whitelist checklist · {done}/{a.checklist.length}
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {a.checklist.map((c) => {
                        const on = checks[a.id]?.has(c.id) ?? false;
                        return (
                          <li key={c.id} style={{ padding: "3px 0" }}>
                            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                              <input type="checkbox" checked={on} onChange={() => void toggle(a.id, c.id)} />
                              <span style={{ textDecoration: on ? "line-through" : "none", opacity: on ? 0.6 : 1 }}>
                                {c.text}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {!me ? (
                      <p className="dim hint" style={{ marginBottom: 0 }}>
                        Sign in (top bar) to save your ticks across devices.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
