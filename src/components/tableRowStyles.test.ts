/**
 * A guard against the one CSS mistake that took the scanner apart.
 *
 * Two unrelated things were called `.feed-row`: the activity list, which is a
 * flex `<li>`, and a scanner row a refresh had just turned up, which is a
 * `<tr>`. The flex rule won, and a `<tr>` given `display: flex` stops being a
 * table row — its cells become blocks, the colgroup no longer applies, and the
 * row collapses to the first column's width while the header keeps the full
 * table. At 24h a couple of rows were new and it read as a rendering glitch;
 * at 14d every contract was new and the whole table came apart.
 *
 * The second half is the same shape: a `::before` on a `<tr>` has nowhere to
 * live, so the table wraps it in an anonymous cell — a column the colgroup
 * says nothing about, which takes its width from the only flexible column and
 * pushes the table past its wrapper.
 *
 * Neither shows up in a unit test of a component, and both are invisible in
 * review. So they are checked here, against the stylesheet itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
// Comments are stripped first: the prose explaining this very bug contains
// the words it looks for, and a naive scan would read the explanation as a
// declaration.
const css = readFileSync(join(root, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Class tokens used on a `<tr …>` element in a component. */
function rowClasses(file: string): string[] {
  const src = readFileSync(join(root, "components", file), "utf8");
  const out = new Set<string>();
  // <tr … className={`a${x ? " b" : ""}`} — the literal tokens are what a
  // stylesheet can match, and they are what this is checking.
  for (const m of src.matchAll(/<tr\b[^>]*className=\{`([^`]*)`\}/gs)) {
    for (const token of m[1].matchAll(/(?:^|[\s"'])([a-z][a-z0-9-]+)(?=[\s"'`$]|$)/g)) {
      out.add(token[1]);
    }
  }
  for (const m of src.matchAll(/<tr\b[^>]*className="([^"]*)"/gs)) {
    for (const token of m[1].split(/\s+/)) if (token) out.add(token);
  }
  return [...out];
}

/** The body of every top-level rule whose selector mentions `.name`. */
function blocksFor(name: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (new RegExp(`\\.${name}(?![\\w-])`).test(m[1])) out.push(`${m[1]}{${m[2]}}`);
  }
  return out;
}

const FILES = ["DropTable.tsx", "LiveTab.tsx"];

describe("classes put on a table row", () => {
  it("finds the classes it is meant to be checking", () => {
    // A regex that quietly matches nothing would make every test below pass.
    expect(rowClasses("DropTable.tsx")).toContain("project-row");
    expect(rowClasses("DropTable.tsx")).toContain("row-just-in");
    expect(rowClasses("LiveTab.tsx")).toContain("row-just-in");
  });

  it.each(FILES)("%s: none of them is laid out as anything but a table row", (file) => {
    for (const name of rowClasses(file)) {
      for (const block of blocksFor(name)) {
        // A media query for the phone layout deliberately restyles the whole
        // table into cards; that is the one place a row is not a row.
        const mobile = /max-width:\s*640px/.test(
          css.slice(Math.max(0, css.indexOf(block) - 400), css.indexOf(block)),
        );
        if (mobile) continue;
        expect(
          block,
          `.${name} is put on a <tr> in ${file}, so it must not change its display`,
        ).not.toMatch(/display:\s*(flex|block|grid|inline)/);
      }
    }
  });

  it.each(FILES)("%s: none of them hangs a pseudo-element off the row", (file) => {
    for (const name of rowClasses(file)) {
      for (const block of blocksFor(name)) {
        const selector = block.slice(0, block.indexOf("{"));
        // `.row-just-in > td:first-child::before` is the correct form and must
        // keep passing; `.row-just-in::before` is the bug.
        expect(
          selector,
          `a ::before on a <tr> becomes an anonymous column — hang it off a cell instead`,
        ).not.toMatch(new RegExp(`\\.${name}::(before|after)`));
      }
    }
  });
});

describe("the two things once both called feed-row", () => {
  it("keeps the flex one off table rows entirely", () => {
    for (const file of FILES) {
      expect(rowClasses(file)).not.toContain("feed-row");
    }
  });

  it("still styles the activity list it belongs to", () => {
    const wallets = readFileSync(join(root, "components", "WalletsTab.tsx"), "utf8");
    expect(wallets).toContain('className="feed-row"');
    expect(blocksFor("feed-row").join("")).toMatch(/display:\s*flex/);
  });
});
