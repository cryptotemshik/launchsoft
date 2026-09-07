import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadFeed, loadProgress, removeArticle, setChecked, upsertArticle } from "./feed";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "feed-"));
  cfg = resolve(dir, "snipe.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("feed articles", () => {
  it("starts empty", () => {
    expect(loadFeed(cfg)).toEqual([]);
  });

  it("creates, defaults to Pro + draft, and assigns ids", () => {
    const { article, firstPublish } = upsertArticle(cfg, { title: "Alpha 1" });
    expect(article.id).toMatch(/^[0-9a-f]+$/);
    expect(article.pro).toBe(true);
    expect(article.published).toBe(false);
    expect(firstPublish).toBe(false); // still a draft
    expect(loadFeed(cfg)).toHaveLength(1);
  });

  it("reports firstPublish only on the transition to published", () => {
    const a = upsertArticle(cfg, { title: "P", published: true });
    expect(a.firstPublish).toBe(true);
    const b = upsertArticle(cfg, { id: a.article.id, title: "P2", published: true });
    expect(b.firstPublish).toBe(false); // already public — no re-push
  });

  it("keeps id and createdAt across an edit", () => {
    const a = upsertArticle(cfg, { title: "One" });
    const b = upsertArticle(cfg, { id: a.article.id, title: "One edited" });
    expect(b.article.id).toBe(a.article.id);
    expect(b.article.createdAt).toBe(a.article.createdAt);
    expect(loadFeed(cfg)).toHaveLength(1);
    expect(loadFeed(cfg)[0].title).toBe("One edited");
  });

  it("assigns ids to checklist items and preserves given ones", () => {
    const { article } = upsertArticle(cfg, {
      title: "WL",
      checklist: [{ text: "Follow on X" }, { id: "keep", text: "Join Discord" }],
    });
    expect(article.checklist[0].id).toMatch(/^[0-9a-f]+$/);
    expect(article.checklist[1].id).toBe("keep");
  });

  it("requires a title", () => {
    expect(() => upsertArticle(cfg, { title: "  " })).toThrow(/title/);
  });

  it("removes", () => {
    const a = upsertArticle(cfg, { title: "X" });
    expect(removeArticle(cfg, a.article.id)).toBe(true);
    expect(removeArticle(cfg, a.article.id)).toBe(false);
    expect(loadFeed(cfg)).toEqual([]);
  });
});

describe("checklist progress (per reader)", () => {
  it("starts empty and ticks/unticks", () => {
    expect(loadProgress(cfg)).toEqual({});
    setChecked(cfg, "art1", "step1", true);
    setChecked(cfg, "art1", "step2", true);
    expect(loadProgress(cfg).art1.sort()).toEqual(["step1", "step2"]);
    setChecked(cfg, "art1", "step1", false);
    expect(loadProgress(cfg).art1).toEqual(["step2"]);
  });

  it("does not duplicate a re-ticked item", () => {
    setChecked(cfg, "a", "s", true);
    setChecked(cfg, "a", "s", true);
    expect(loadProgress(cfg).a).toEqual(["s"]);
  });
});
