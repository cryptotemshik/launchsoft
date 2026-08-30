/**
 * Node's built-in SQLite, fetched at runtime rather than imported.
 *
 * `node:sqlite` arrived in Node 22, and the bundler here predates it: given
 * the specifier directly it strips the prefix, hunts for a package called
 * "sqlite", and fails — in the app build and in the test runner alike. Going
 * through `createRequire` makes this an ordinary module as far as the bundler
 * is concerned, and leaves fetching the builtin to Node, which is the only
 * place it was ever coming from.
 *
 * The alternative was better-sqlite3, which has to be compiled on install.
 * The box this runs on has no compiler, so `npm i` ended in
 * `gyp ERR! not found: make` — with the server already restarting.
 *
 * The fetch is deferred to the first call rather than done when this module
 * loads, and that is the whole point of the function. `node:sqlite` was
 * flagged until late in the Node 22 line, so on an older runtime the require
 * throws — and a throw while modules are still loading takes the entire
 * server down before it has opened a port. The index is meant to be optional:
 * asking for it here, inside a call the caller can wrap, is what makes a
 * runtime without SQLite one line in the log instead of a restart loop.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

let cached: typeof import("node:sqlite") | null = null;

export function loadSqlite(): typeof import("node:sqlite") {
  if (cached) return cached;
  try {
    cached = require("node:sqlite") as typeof import("node:sqlite");
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(
      `this Node has no node:sqlite (${why}) — it needs Node 22.13 or newer, ` +
        `or Node 22.5+ started with --experimental-sqlite`,
    );
  }
  return cached;
}
