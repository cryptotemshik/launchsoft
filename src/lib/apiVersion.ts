/**
 * Handshake between the published site and the runner on the VPS.
 *
 * The two ship from the same repo but are deployed separately — the site
 * updates the moment it is published, the server only when someone runs
 * `git pull` on the box. A panel talking to an older server fails in confusing
 * ways (a request shape the server doesn't parse, an error about a field it
 * never received), so the panel checks this number on connect and says plainly
 * that the server needs updating.
 *
 * Bump it whenever the request or response shape of an /api route changes in a
 * way an older server would mishandle.
 */
export const API_VERSION = 39;

/** What to tell the user when the server is behind. */
export const UPDATE_HINT =
  "cd ~/launchsoft && git pull && pm2 restart snipe-api";
