/**
 * The alpha feed: short, owner-written write-ups on projects, each with a
 * clickable checklist (how to get the whitelist). Some are free; most are Pro,
 * so subscribers hear about projects earlier — that is the draw.
 *
 * Two kinds of state live here, and they are deliberately separate:
 *   - the articles themselves are global — one set the owner authors, the same
 *     for everyone — so they live beside the main config.
 *   - a reader's ticked checklist is theirs alone, so it lives per account,
 *     keyed by the config path like every other private thing a wallet owns.
 *
 * Pure file I/O and shaping; who may read a Pro article, and pushing a new one
 * to Telegram, are the server's job.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface ChecklistItem {
  id: string;
  text: string;
}
export interface FeedLink {
  label: string;
  url: string;
}
export interface Article {
  id: string;
  title: string;
  /** The project this is about — shown as a subtitle. */
  project?: string;
  /** Body text; newlines preserved, rendered plainly. */
  body: string;
  /** A cover image URL, optional. */
  cover?: string;
  tags: string[];
  links: FeedLink[];
  checklist: ChecklistItem[];
  /** Whitelist deadline, unix seconds, for the countdown. */
  wlDeadline?: number;
  /** Pro-only: free readers see the card and teaser but not the body/checklist. */
  pro: boolean;
  /** Drafts are invisible to everyone but the admin editor. */
  published: boolean;
  createdAt: number;
  updatedAt: number;
}

function feedPath(configPath: string): string {
  return `${resolve(configPath)}.feed.json`;
}

function id(): string {
  return randomBytes(6).toString("hex");
}

function writeJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export function loadFeed(configPath: string): Article[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(feedPath(configPath), "utf8"));
    return Array.isArray(raw) ? raw.filter(isArticle).map(normalise) : [];
  } catch {
    return [];
  }
}

function isArticle(v: unknown): v is Article {
  const a = v as Partial<Article>;
  return Boolean(a && typeof a.id === "string" && typeof a.title === "string");
}

function normalise(a: Article): Article {
  return {
    id: a.id,
    title: a.title,
    project: a.project || undefined,
    body: typeof a.body === "string" ? a.body : "",
    cover: a.cover || undefined,
    tags: Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === "string") : [],
    links: Array.isArray(a.links)
      ? a.links.filter((l): l is FeedLink => !!l && typeof l.url === "string").map((l) => ({ label: l.label || l.url, url: l.url }))
      : [],
    checklist: Array.isArray(a.checklist)
      ? a.checklist
          .filter((c): c is ChecklistItem => !!c && typeof c.text === "string")
          .map((c) => ({ id: c.id || id(), text: c.text }))
      : [],
    wlDeadline: Number.isFinite(a.wlDeadline) ? a.wlDeadline : undefined,
    pro: a.pro !== false, // default Pro — the feed is a Pro draw
    published: a.published === true,
    createdAt: Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
    updatedAt: Number.isFinite(a.updatedAt) ? a.updatedAt : Date.now(),
  };
}

/** What a draft coming in from the admin editor may set. */
export interface ArticleInput {
  id?: string;
  title: string;
  project?: string;
  body?: string;
  cover?: string;
  tags?: string[];
  links?: FeedLink[];
  checklist?: { id?: string; text: string }[];
  wlDeadline?: number;
  pro?: boolean;
  published?: boolean;
}

/**
 * Create or update an article. A new one gets an id and timestamps; an edit
 * keeps its id and createdAt. Returns the saved article and whether this is the
 * moment it first became public (so the caller can push it once).
 */
export function upsertArticle(
  configPath: string,
  input: ArticleInput,
  nowMs = Date.now(),
): { article: Article; firstPublish: boolean } {
  if (!input.title?.trim()) throw new Error("an article needs a title");
  const list = loadFeed(configPath);
  const existing = input.id ? list.find((a) => a.id === input.id) : undefined;
  const wasPublished = existing?.published === true;

  const article: Article = normalise({
    id: existing?.id ?? id(),
    title: input.title.trim(),
    project: input.project?.trim(),
    body: input.body ?? existing?.body ?? "",
    cover: input.cover?.trim(),
    tags: input.tags ?? existing?.tags ?? [],
    links: input.links ?? existing?.links ?? [],
    checklist: (input.checklist ?? existing?.checklist ?? []).map((c) => ({
      id: c.id || id(),
      text: c.text,
    })),
    wlDeadline: input.wlDeadline,
    pro: input.pro ?? existing?.pro ?? true,
    published: input.published ?? existing?.published ?? false,
    createdAt: existing?.createdAt ?? nowMs,
    updatedAt: nowMs,
  } as Article);

  const next = existing ? list.map((a) => (a.id === article.id ? article : a)) : [article, ...list];
  writeJson(feedPath(configPath), next);
  return { article, firstPublish: article.published && !wasPublished };
}

export function removeArticle(configPath: string, articleId: string): boolean {
  const list = loadFeed(configPath);
  const next = list.filter((a) => a.id !== articleId);
  if (next.length === list.length) return false;
  writeJson(feedPath(configPath), next);
  return true;
}

// ── Per-reader checklist progress ────────────────────────────────────────────
function progressPath(configPath: string): string {
  return `${resolve(configPath)}.feedprogress.json`;
}

/** Map of articleId -> ticked checklist item ids, for one account. */
export type FeedProgress = Record<string, string[]>;

export function loadProgress(configPath: string): FeedProgress {
  try {
    const raw = JSON.parse(readFileSync(progressPath(configPath), "utf8")) as FeedProgress;
    if (!raw || typeof raw !== "object") return {};
    const out: FeedProgress = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** Tick or untick one checklist item for one account. Returns the new set. */
export function setChecked(
  configPath: string,
  articleId: string,
  itemId: string,
  checked: boolean,
): string[] {
  const prog = loadProgress(configPath);
  const set = new Set(prog[articleId] ?? []);
  if (checked) set.add(itemId);
  else set.delete(itemId);
  prog[articleId] = [...set];
  writeJson(progressPath(configPath), prog);
  return prog[articleId];
}
