import { useCallback, useEffect, useState } from "react";
import { useRunnerApi } from "../lib/runnerClient";

/**
 * The owner's editor for the alpha feed — write a short piece, add links and a
 * whitelist checklist, mark it free or Pro, and publish. Publishing a Pro piece
 * pushes it to linked Pro chats (unless "notify" is off). Admin-only; the
 * server checks that on every call.
 */

interface Link {
  label: string;
  url: string;
}
interface ChecklistItem {
  id?: string;
  text: string;
}
interface Article {
  id: string;
  title: string;
  project?: string;
  body: string;
  cover?: string;
  tags: string[];
  links: Link[];
  checklist: ChecklistItem[];
  wlDeadline?: number;
  pro: boolean;
  published: boolean;
  createdAt: number;
}

const BLANK = {
  id: "",
  title: "",
  project: "",
  cover: "",
  tags: "",
  body: "",
  linksText: "",
  checklistText: "",
  wl: "",
  pro: true,
  published: false,
  notify: true,
};

function toLocalInput(secs?: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AdminFeedEditor() {
  const { base, token, call } = useRunnerApi();
  const [articles, setArticles] = useState<Article[]>([]);
  const [form, setForm] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!base || !token) return;
    try {
      const r = (await call("/api/admin/feed")) as unknown as { articles: Article[] };
      setArticles(r.articles ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, token, call]);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(a: Article) {
    setForm({
      id: a.id,
      title: a.title,
      project: a.project ?? "",
      cover: a.cover ?? "",
      tags: a.tags.join(", "),
      body: a.body,
      linksText: a.links.map((l) => `${l.label} | ${l.url}`).join("\n"),
      checklistText: a.checklist.map((c) => c.text).join("\n"),
      wl: toLocalInput(a.wlDeadline),
      pro: a.pro,
      published: a.published,
      notify: true,
    });
    setNote(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save(publish?: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const links: Link[] = form.linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [label, url] = l.split("|").map((s) => s.trim());
          return url ? { label: label || url, url } : { label: "link", url: label };
        })
        .filter((l) => /^https?:\/\//.test(l.url));
      const checklist: ChecklistItem[] = form.checklistText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text) => ({ text }));
      const body: Record<string, unknown> = {
        id: form.id || undefined,
        title: form.title,
        project: form.project,
        cover: form.cover,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        body: form.body,
        links,
        checklist,
        wlDeadline: form.wl ? Math.floor(new Date(form.wl).getTime() / 1000) : undefined,
        pro: form.pro,
        published: publish ?? form.published,
        notify: form.notify,
      };
      const r = (await call("/api/admin/feed", { method: "POST", body: JSON.stringify(body) })) as unknown as {
        article: Article;
      };
      setNote(`Saved "${r.article.title}"${r.article.published ? " (published)" : " (draft)"}.`);
      setForm({ ...BLANK });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Article) {
    if (!confirm(`Delete "${a.title}"?`)) return;
    try {
      await call(`/api/admin/feed?id=${a.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel">
      <h2>Feed — write an article</h2>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}

      <div className="field">
        <label>title</label>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Project X — early WL" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label>project (subtitle)</label>
          <input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label>tags (comma-separated)</label>
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="NFT, RH Chain" />
        </div>
      </div>
      <div className="field">
        <label>cover image URL (optional)</label>
        <input value={form.cover} onChange={(e) => setForm({ ...form, cover: e.target.value })} placeholder="https://…" />
      </div>
      <div className="field">
        <label>body</label>
        <textarea rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What the project is, why it matters, how the drop works…" />
      </div>
      <div className="field">
        <label>links — one per line, &ldquo;Label | https://…&rdquo;</label>
        <textarea rows={3} value={form.linksText} onChange={(e) => setForm({ ...form, linksText: e.target.value })} placeholder={"Website | https://…\nTwitter | https://x.com/…\nDiscord | https://discord.gg/…"} />
      </div>
      <div className="field">
        <label>WL checklist — one step per line (editing text resets ticks)</label>
        <textarea rows={4} value={form.checklistText} onChange={(e) => setForm({ ...form, checklistText: e.target.value })} placeholder={"Follow on X\nJoin Discord & get level 5\nRetweet the pinned post"} />
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div className="field" style={{ width: 220 }}>
          <label>WL deadline (optional)</label>
          <input type="datetime-local" value={form.wl} onChange={(e) => setForm({ ...form, wl: e.target.value })} />
        </div>
        <label className="dim" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={form.pro} onChange={(e) => setForm({ ...form, pro: e.target.checked })} />
          Pro-only
        </label>
        <label className="dim" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} />
          push to Telegram on publish
        </label>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button className="secondary" disabled={busy || !form.title.trim()} onClick={() => void save(false)}>
          save draft
        </button>
        <button className="primary" disabled={busy || !form.title.trim()} onClick={() => void save(true)}>
          {form.id ? "save & publish" : "publish"}
        </button>
        {form.id ? (
          <button className="secondary" disabled={busy} onClick={() => setForm({ ...BLANK })}>
            new (clear)
          </button>
        ) : null}
      </div>

      {articles.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>{articles.length} article(s)</div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {articles.map((a) => (
              <li key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", flexWrap: "wrap" }}>
                <span className={a.published ? "pill ok" : "pill"}>{a.published ? "live" : "draft"}</span>
                <span className={a.pro ? "pill ok" : "pill"}>{a.pro ? "Pro" : "free"}</span>
                <span style={{ flex: 1, minWidth: 160 }}>{a.title}</span>
                <button className="secondary" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => edit(a)}>edit</button>
                <button className="secondary" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => void remove(a)}>delete</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
