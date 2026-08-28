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
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = InstanceType<typeof sqlite.DatabaseSync>;
