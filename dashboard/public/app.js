// Orvex team dashboard — read-only client for /api/dashboard/*.
// No build step: plain ES module, served as-is from Cloudflare Pages.

const MIN_API_VERSION = 51;
const DEFAULT_API = "https://api.orvex.cash";
const KEY_STORE = "orvex.team.key";
const API_STORE = "orvex.team.api";
const SUMMARY_EVERY_MS = 30_000;
const PROFIT_EVERY_MS = 5 * 60_000;
const PROFIT_RETRY_MS = 8_000;

// ── storage (can throw in private windows — never let that break the page) ──
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* per-visit only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing to clear */ } },
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));
const short = (a) => (isAddr(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : esc(a));

function apiBase() {
  const fromUrl = new URLSearchParams(location.search).get("api");
  if (fromUrl) store.set(API_STORE, fromUrl);
  return (store.get(API_STORE) || DEFAULT_API).replace(/\/+$/, "");
}

// ── numbers ────────────────────────────────────────────────────────────────
const weiToEth = (w) => {
  try { return Number(BigInt(String(w ?? "0"))) / 1e18; } catch { return 0; }
};
const ethNum = (s) => (s === null || s === undefined || s === "" ? null : Number(s));
function fmtEth(n, { signed = false, unit = true } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  let s;
  if (a === 0) s = "0";
  else if (a >= 100) s = a.toFixed(1);
  else if (a >= 1) s = a.toFixed(3);
  else if (a >= 0.01) s = a.toFixed(4);
  else if (a >= 0.0001) s = a.toFixed(5);
  else s = a.toPrecision(2);
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  return `${sign}${s}${unit ? " ETH" : ""}`;
}
function fmtUsd(n, { signed = false } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const a = Math.abs(n);
  const s = a.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: a < 100 ? 2 : 0 });
  return `${n < 0 ? "−" : signed && n > 0 ? "+" : ""}${s}`;
}
const usdOf = (eth) => (state.ethUsd && eth !== null ? eth * state.ethUsd : null);

// ── time ───────────────────────────────────────────────────────────────────
const fmtDate = (ms, withYear = false) =>
  new Date(ms).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", ...(withYear ? { year: "2-digit" } : {}), hour: "2-digit", minute: "2-digit",
  });
/** Date and time in the viewer's own timezone: "24.09.2026, 20:30". */
const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
function fmtAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "только что";
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} дн назад`;
}
function countdown(secs) {
  if (secs <= 0) return "идёт";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const p = (n) => String(n).padStart(2, "0");
  return d > 0 ? `${d}д ${p(h)}ч ${p(m)}м` : `${p(h)}:${p(m)}:${p(s)}`;
}

// ── state ──────────────────────────────────────────────────────────────────
const state = {
  key: store.get(KEY_STORE) || "",
  summary: null,
  profit: null,
  profitBuilding: false,
  ethUsd: null,
  lastOk: 0,
  sortBalance: "desc",
  /** Collections table order; key null keeps the server's (biggest position first). */
  collSort: { key: null, dir: -1 },
  timers: [],
};

// ── network ────────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path) {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { authorization: `Bearer ${state.key}` },
    cache: "no-store",
  });
  let body = {};
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok && res.status !== 202) throw new HttpError(res.status, body.error || `HTTP ${res.status}`);
  return { status: res.status, body };
}
async function serverVersion() {
  try {
    const r = await fetch(`${apiBase()}/api/ping`, { cache: "no-store" });
    const b = await r.json();
    return typeof b.apiVersion === "number" ? b.apiVersion : 0;
  } catch {
    return null;
  }
}

// ── gate ───────────────────────────────────────────────────────────────────
function showGate(message) {
  stopTimers();
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-api").value = store.get(API_STORE) || "";
  $("gate-api").placeholder = DEFAULT_API;
  const err = $("gate-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("gate-key").focus();
}
function showApp() {
  $("gate").hidden = true;
  $("app").hidden = false;
}

$("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("gate-key").value.trim();
  const apiUrl = $("gate-api").value.trim();
  if (apiUrl) store.set(API_STORE, apiUrl); else store.del(API_STORE);
  state.key = key;
  const ok = await start();
  if (ok) {
    store.set(KEY_STORE, key);
    $("gate-key").value = "";
  }
});
$("logout").addEventListener("click", () => {
  store.del(KEY_STORE);
  state.key = "";
  state.summary = state.profit = null;
  showGate("");
});
$("refresh").addEventListener("click", () => { void loadSummary(); void loadProfit(); });

// ── lifecycle ──────────────────────────────────────────────────────────────
function stopTimers() {
  state.timers.forEach((t) => clearInterval(t));
  state.timers = [];
}
async function start() {
  if (!state.key) { showGate(""); return false; }
  const v = await serverVersion();
  if (v === null) { showGate(`Сервер ${apiBase()} не отвечает.`); return false; }
  if (v < MIN_API_VERSION) {
    showGate(`Сервер не обновлён (версия ${v}, нужна ${MIN_API_VERSION}+). На VPS: git pull и pm2 restart snipe-api.`);
    return false;
  }
  try {
    await loadSummary(true);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      store.del(KEY_STORE);
      showGate("Ключ не подошёл.");
    } else {
      showGate(`Не получилось загрузить данные: ${e.message}`);
    }
    return false;
  }
  showApp();
  void loadProfit();
  stopTimers();
  state.timers.push(setInterval(() => void loadSummary(), SUMMARY_EVERY_MS));
  state.timers.push(setInterval(() => void loadProfit(), PROFIT_EVERY_MS));
  state.timers.push(setInterval(tick, 1000));
  return true;
}

// Back on the tab (e.g. after changing the queue in the app): refresh now
// rather than showing up to half a minute of what was there before.
let lastFocusLoad = 0;
function refreshOnReturn() {
  if (document.visibilityState !== "visible" || !state.summary) return;
  if (Date.now() - lastFocusLoad < 5_000) return;
  lastFocusLoad = Date.now();
  void loadSummary();
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);

async function loadSummary(throwOnError = false) {
  try {
    const { body } = await api("/api/dashboard/summary");
    state.summary = body;
    state.ethUsd = typeof body.ethUsd === "number" ? body.ethUsd : state.ethUsd;
    state.lastOk = Date.now();
    setBanner("");
    renderSummary();
  } catch (e) {
    if (throwOnError) throw e;
    if (e instanceof HttpError && e.status === 401) {
      store.del(KEY_STORE);
      showGate("Доступ отозван или ключ сменили.");
      return;
    }
    setLive("err", "сервер недоступен");
    setBanner(`Не удалось обновить данные (${e.message}). Показаны последние полученные.`);
  }
}

let profitRetry = null;
async function loadProfit() {
  clearTimeout(profitRetry);
  try {
    const { status, body } = await api("/api/dashboard/profit");
    if (body.collections) state.profit = body;
    state.profitBuilding = status === 202;
    renderProfit();
    // A 202 means the report is still being read from the chain; so are any
    // floors that were not cached yet. Ask again shortly either way.
    if (status === 202 || (body.floorsPending ?? 0) > 0) profitRetry = setTimeout(() => void loadProfit(), PROFIT_RETRY_MS);
  } catch (e) {
    $("coll-hint").textContent = `отчёт недоступен: ${e.message}`;
  }
}

// ── rendering: summary ─────────────────────────────────────────────────────
function setLive(kind, text) {
  const el = $("live");
  el.className = `live ${kind}`;
  $("live-text").textContent = text;
}
function setBanner(text) {
  const b = $("banner");
  b.hidden = !text;
  b.textContent = text;
}

function renderSummary() {
  const s = state.summary;
  if (!s) return;
  $("eth-price").textContent = state.ethUsd ? `ETH $${Math.round(state.ethUsd).toLocaleString("en-US")}` : "ETH —";

  const main = (s.mainWallets || []).map((w) => ({ ...w, eth: ethNum(w.balance) }));
  const wallets = (s.wallets || []).map((w) => ({ ...w, eth: ethNum(w.balance) }));
  const mainSum = main.reduce((n, w) => n + (w.eth ?? 0), 0);
  const walletSum = wallets.reduce((n, w) => n + (w.eth ?? 0), 0);
  const funded = wallets.filter((w) => (w.eth ?? 0) > 0).length;

  setKpi("k-total", fmtEth(mainSum + walletSum), fmtUsd(usdOf(mainSum + walletSum)));
  setKpi("k-main", main.length ? fmtEth(mainSum) : "—", main.length ? `${fmtUsd(usdOf(mainSum))} · ${main.length} шт` : "задай SNIPE_DASHBOARD_WALLETS на сервере");
  setKpi("k-wallets", fmtEth(walletSum), `${wallets.length} кошельков · ${funded} с балансом`);

  const runs = s.runs || [];
  const tried = runs.reduce((n, r) => n + r.tried, 0);
  const won = runs.reduce((n, r) => n + r.won, 0);
  setKpi(
    "k-win",
    tried ? `${Math.round((won / tried) * 100)}%` : "—",
    tried ? `${won} из ${tried} кошельков · ${runs.length} запусков` : "запусков ещё не было",
  );

  renderNext(s);
  renderQueue(s);
  renderFeed(s);
  renderWatch(s);
  renderMainWallets(main);
  renderWallets(wallets);
  renderBalanceChart(s, mainSum + walletSum);
  $("foot-updated").textContent = `обновлено ${fmtDate(Date.now())}`;
  tick();
}

function setKpi(id, value, sub, cls = "") {
  const v = $(id);
  v.textContent = value;
  // Tiny ETH figures carry many digits; step the size down rather than clip them.
  v.className = `kpi-val ${cls}${value.length > 12 ? " long" : ""}`;
  $(`${id}-sub`).textContent = sub || " ";
}

/**
 * What the countdown points at. The snipe queue decides: it is what the bot
 * will actually fire on, so taking a job out of it must take it off the timer
 * even while the same collection is still on the watchlist. The watchlist only
 * fills the timer when nothing is queued, and says so.
 */
function nextCandidates(s) {
  const nowS = Date.now() / 1000;
  const snipes = [];
  for (const q of s.queue || []) {
    if (q.startTime && q.startTime > nowS - 60) {
      snipes.push({ at: q.startTime, name: q.name, meta: `снайп в очереди · ${q.wallets} кошельков`, contract: q.collection });
    }
  }
  const watch = [];
  for (const w of s.watchlist || []) {
    const at = watchStart(w);
    if (at && at > nowS - 60) {
      watch.push({ at, name: w.name, meta: `только watch-лист, снайп не поставлен${w.supply ? ` · сапплай ${w.supply}` : ""}`, contract: w.contract });
    }
  }
  const byAt = (a, b) => a.at - b.at;
  return { snipes: snipes.sort(byAt), watch: watch.sort(byAt) };
}
function renderNext(s) {
  const { snipes, watch } = nextCandidates(s);
  const next = snipes[0] || watch[0];
  const timer = $("next-timer");
  $("next-title").textContent = snipes[0] ? "Следующий снайп" : "Следующий дроп";
  $("next-timer").classList.toggle("watch-only", !snipes[0] && !!next);
  if (!next) {
    $("next-name").textContent = "Ничего не запланировано";
    $("next-meta").textContent = "поставь снайп в очередь или добавь дроп в watch-лист";
    timer.textContent = "—";
    timer.dataset.at = "";
    return;
  }
  $("next-name").textContent = next.name || short(next.contract);
  // A watchlist drop that opens before the next snipe is worth a mention, but
  // not the timer: nothing will fire on it.
  const queued = new Set(snipes.map((q) => String(q.contract || "").toLowerCase()));
  const sooner = snipes[0] && watch.find((w) => w.at < next.at && !queued.has(String(w.contract || "").toLowerCase()));
  $("next-meta").textContent =
    `${fmtDate(next.at * 1000)} · ${next.meta}` +
    (sooner ? ` · раньше в watch-листе: ${sooner.name || short(sooner.contract)} (${fmtDate(sooner.at * 1000)}), без снайпа` : "");
  timer.dataset.at = String(next.at);
}

function explorer(path) {
  const base = state.summary?.explorerUrl;
  return base ? `${base}${path}` : "#";
}
/** A collection opens on OpenSea — where it is traded — not on the explorer. */
function collLink(addr, label) {
  if (!isAddr(addr)) return esc(label || "—");
  const slug = state.summary?.openSeaSlug || state.profit?.openSeaSlug || "robinhood";
  return `<a href="https://opensea.io/assets/${encodeURIComponent(slug)}/${addr}" target="_blank" rel="noopener" title="Открыть на OpenSea">${esc(label || short(addr))}</a>`;
}

/**
 * When a watchlist drop opens: the chain's public start when the contract has
 * one (what the snipe fires on), else the time saved with the entry.
 */
const watchStart = (w) => w.chainStart || w.at || null;
function addrLink(addr, text) {
  if (!isAddr(addr)) return esc(text || addr || "—");
  return `<a class="addr" href="${explorer(`/address/${addr}`)}" target="_blank" rel="noopener" title="${esc(addr)}">${esc(text || short(addr))}</a>`;
}

function renderQueue(s) {
  const rows = s.queue || [];
  $("queue-count").textContent = rows.length ? `${rows.length}` : "";
  $("queue-empty").hidden = rows.length > 0;
  $("queue-table").hidden = rows.length === 0;
  $("queue-table").querySelector("tbody").innerHTML = rows
    .map((q) => {
      const status = q.active
        ? `<span class="badge live">● стреляет</span>`
        : q.status === "armed"
          ? `<span class="badge armed">◆ армлен</span>`
          : `<span class="badge">○ в очереди</span>`;
      const mode = q.style === "spread" ? `spread ×${q.shots}` : "single";
      return `<tr>
        <td class="name" data-label="Коллекция">${collLink(q.collection, q.name)}${q.dryRun ? ` <span class="badge dry">dry</span>` : ""}</td>
        <td data-label="Старт">${q.startTime ? `${fmtDate(q.startTime * 1000)}<div class="muted" data-cd="${q.startTime}"></div>` : `<span class="muted">не задан</span>`}</td>
        <td class="r" data-label="Кошельки × шт">${q.wallets} × ${esc(q.quantity)}</td>
        <td class="muted" data-label="Режим">${esc(mode)}</td>
        <td data-label="Статус">${status}</td>
      </tr>`;
    })
    .join("");
}

function renderFeed(s) {
  const items = [
    ...(s.runs || []).map((r) => ({ kind: "run", at: r.at, r })),
    ...(s.failures || []).map((f) => ({ kind: "fail", at: f.at, f })),
  ].sort((a, b) => b.at - a.at);
  $("feed-count").textContent = items.length ? `${items.length}` : "";
  $("feed-empty").hidden = items.length > 0;
  $("feed").innerHTML = items
    .slice(0, 60)
    .map((it) => {
      if (it.kind === "fail") {
        const f = it.f;
        const icon = f.status === "aborted" ? "⏹" : "⚠";
        return `<li>
          <span class="ico bad" aria-label="${f.status === "aborted" ? "отменён" : "ошибка"}">${icon}</span>
          <div><div class="ttl">${collLink(f.collection, f.name)}</div>
          <div class="sub bad">${f.status === "aborted" ? "отменён" : "ошибка"}${f.error ? ` · ${esc(f.error.slice(0, 140))}` : ""}</div></div>
          <span class="when">${fmtAgo(f.at)}</span></li>`;
      }
      const r = it.r;
      const icon = r.outcome === "won" ? "🎯" : r.outcome === "partial" ? "◐" : "✕";
      const cls = r.outcome === "won" ? "ok" : r.outcome === "partial" ? "part" : "bad";
      const label = r.outcome === "won" ? "все взяли" : r.outcome === "partial" ? "частично" : "мимо";
      const spent = weiToEth(r.gasWei) + weiToEth(r.valueWei);
      return `<li>
        <span class="ico ${cls}" aria-label="${label}">${icon}</span>
        <div><div class="ttl">${collLink(r.collection, r.name)}</div>
        <div class="sub"><span class="${cls}">${r.won}/${r.tried} кошельков взяли</span> · ${r.tokens} NFT · потрачено ${fmtEth(spent)}</div></div>
        <span class="when" title="${fmtDate(r.at, true)}">${fmtAgo(r.at)}</span></li>`;
    })
    .join("");
}

function twitterHandle(v) {
  const m = String(v || "").match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i) || String(v || "").match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}
function renderWatch(s) {
  const rows = [...(s.watchlist || [])].sort((a, b) => (watchStart(a) ?? Infinity) - (watchStart(b) ?? Infinity));
  $("watch-count").textContent = rows.length ? `${rows.length}` : "";
  $("watch-empty").hidden = rows.length > 0;
  $("watch-table").hidden = rows.length === 0;
  $("watch-table").querySelector("tbody").innerHTML = rows
    .map((w) => {
      const h = twitterHandle(w.twitter);
      const at = watchStart(w);
      // Flag a saved time the chain disagrees with, so a wrong entry is visible.
      const moved = w.chainStart && w.at && Math.abs(w.chainStart - w.at) > 60;
      const when = at
        ? `${w.dayOnly && !w.chainStart ? new Date(at * 1000).toLocaleDateString("ru-RU") : fmtDate(at * 1000)}` +
          (moved ? ` <span class="muted" title="В watch-листе сохранено ${esc(fmtDate(w.at * 1000))}, в контракте — это время">· по контракту</span>` : "")
        : `<span class="muted">не объявлено</span>`;
      return `<tr>
        <td class="name" data-label="Дроп">${w.contract && isAddr(w.contract) ? collLink(w.contract, w.name) : esc(w.name)}</td>
        <td data-label="Когда">${when}</td>
        <td class="r muted" data-label="Через">${at ? `<span data-cd="${at}"></span>` : "—"}</td>
        <td class="r" data-label="Сапплай">${w.supply ? esc(w.supply) : "—"}</td>
        <td data-label="Контракт">${w.contract && isAddr(w.contract) ? collLink(w.contract, short(w.contract)) : `<span class="muted">—</span>`}</td>
        <td data-label="Twitter">${h ? `<a href="https://x.com/${h}" target="_blank" rel="noopener">@${esc(h)}</a>` : `<span class="muted">—</span>`}</td>
      </tr>`;
    })
    .join("");
}

function renderMainWallets(main) {
  $("main-wallets").innerHTML = main.length
    ? main
        .map(
          (w) => `<div class="mw">
            <div class="mw-label">${esc(w.label)}</div>
            <div class="mw-bal">${fmtEth(w.eth)}</div>
            <div class="mw-addr">${addrLink(w.address)} <span class="muted">${fmtUsd(usdOf(w.eth))}</span></div>
          </div>`,
        )
        .join("")
    : `<p class="empty">Основные кошельки не заданы (SNIPE_DASHBOARD_WALLETS на сервере).</p>`;
}

function renderWallets(wallets) {
  const q = $("wallet-filter").value.trim().toLowerCase();
  const onlyFunded = $("wallet-funded").checked;
  let rows = wallets.map((w, i) => ({ ...w, n: i + 1 }));
  if (q) rows = rows.filter((w) => w.address.toLowerCase().includes(q) || String(w.label || "").toLowerCase().includes(q));
  if (onlyFunded) rows = rows.filter((w) => (w.eth ?? 0) > 0);
  if (state.sortBalance !== "none") {
    const dir = state.sortBalance === "desc" ? -1 : 1;
    rows.sort((a, b) => dir * ((a.eth ?? -1) - (b.eth ?? -1)));
  }
  const max = Math.max(0, ...wallets.map((w) => w.eth ?? 0));
  const funded = wallets.filter((w) => (w.eth ?? 0) > 0).length;
  const total = wallets.reduce((n, w) => n + (w.eth ?? 0), 0);
  const shown = rows.reduce((n, w) => n + (w.eth ?? 0), 0);
  const filtered = rows.length !== wallets.length;
  $("wallet-count").textContent =
    `${wallets.length} кошельков · ${funded} с балансом · всего ${fmtEth(total)} ${fmtUsd(usdOf(total))}` +
    (filtered ? ` · в фильтре ${rows.length}: ${fmtEth(shown)}` : "");
  $("wallet-empty").hidden = rows.length > 0;
  const th = $("sort-bal");
  th.setAttribute("aria-sort", state.sortBalance === "desc" ? "descending" : state.sortBalance === "asc" ? "ascending" : "none");
  th.textContent = state.sortBalance === "desc" ? "Баланс ↓" : state.sortBalance === "asc" ? "Баланс ↑" : "Баланс ↕";
  $("wallet-table").querySelector("tbody").innerHTML = rows
    .slice(0, 1000)
    .map((w) => {
      const width = max > 0 && w.eth ? Math.max(2, Math.round((w.eth / max) * 60)) : 0;
      return `<tr>
        <td class="muted hide-sm">${w.n}</td>
        <td>${esc(w.label || "—")}</td>
        <td>${addrLink(w.address)}</td>
        <td class="r">${w.eth === null ? `<span class="muted">—</span>` : fmtEth(w.eth, { unit: false })}${width ? `<span class="bar hide-sm" style="width:${width}px"></span>` : ""}</td>
        <td class="r muted hide-sm">${fmtUsd(usdOf(w.eth))}</td>
      </tr>`;
    })
    .join("");
}
$("wallet-filter").addEventListener("input", () => state.summary && renderWallets(currentWallets()));
$("wallet-funded").addEventListener("change", () => state.summary && renderWallets(currentWallets()));
$("sort-bal").addEventListener("click", () => {
  state.sortBalance = state.sortBalance === "desc" ? "asc" : state.sortBalance === "asc" ? "none" : "desc";
  if (state.summary) renderWallets(currentWallets());
});
const currentWallets = () => (state.summary?.wallets || []).map((w) => ({ ...w, eth: ethNum(w.balance) }));

// ── rendering: profit ──────────────────────────────────────────────────────
function floorEth(floor) {
  if (!floor || !Number.isFinite(floor.unit)) return null;
  return /^w?eth$/i.test(floor.symbol || "") ? floor.unit : null;
}

function renderProfit() {
  const p = state.profit;
  if (!p) {
    $("coll-empty").hidden = false;
    $("coll-empty").textContent = state.profitBuilding ? "Отчёт собирается из цепи — это до минуты…" : "Нет данных.";
    return;
  }
  const floors = p.floors || {};
  // When each collection was minted: its first and last mint on chain, in ms.
  // The chain sees mints this server never made; the local ledger's time is
  // the fallback for a run the chain scan has not picked up.
  const mintSpan = new Map();
  for (const e of p.events || []) {
    if (e.kind !== "mint" || !e.at) continue;
    const ms = e.at * 1000;
    const cur = mintSpan.get(e.collection);
    mintSpan.set(e.collection, cur ? { first: Math.min(cur.first, ms), last: Math.max(cur.last, ms) } : { first: ms, last: ms });
  }
  const cols = (p.collections || []).map((c) => {
    const spent = weiToEth(c.cost?.gasWei) + weiToEth(c.cost?.priceWei);
    const revenue = weiToEth(c.revenueWei);
    const net = weiToEth(c.netWei);
    const fl = floorEth(floors[String(c.collection).toLowerCase()]);
    const heldValue = fl !== null ? fl * (c.heldTokens || 0) : null;
    const span = mintSpan.get(String(c.collection).toLowerCase());
    const mintAt = span?.first ?? (c.lastAt || null);
    const mintLast = span?.last ?? (c.lastAt || null);
    return { ...c, spent, revenue, net, fl, heldValue, withFloor: net + (heldValue ?? 0), mintAt, mintLast };
  });

  const { key: sortKey, dir } = state.collSort;
  if (sortKey) {
    const val = COLL_SORT[sortKey];
    cols.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
  }
  document.querySelectorAll("#coll-table th[data-sort]").forEach((th) => {
    const on = th.dataset.sort === sortKey;
    th.setAttribute("aria-sort", on ? (dir < 0 ? "descending" : "ascending") : "none");
    th.dataset.arrow = on ? (dir < 0 ? " ↓" : " ↑") : "";
  });

  const realized = cols.reduce((n, c) => n + c.net, 0);
  const heldTokens = cols.reduce((n, c) => n + (c.heldTokens || 0), 0);
  const heldValue = cols.reduce((n, c) => n + (c.heldValue ?? 0), 0);
  const unknownFloors = cols.filter((c) => (c.heldTokens || 0) > 0 && c.fl === null).length;

  setKpi(
    "k-pnl",
    `${realized >= 0 ? "▲" : "▼"} ${fmtEth(realized, { signed: true })}`,
    `${fmtUsd(usdOf(realized), { signed: true })}${state.profitBuilding ? " · обновляется…" : ""}`,
    realized > 0 ? "delta-up" : realized < 0 ? "delta-down" : "",
  );
  setKpi(
    "k-held",
    heldTokens ? fmtEth(heldValue) : "—",
    heldTokens
      ? `${heldTokens} NFT${unknownFloors ? ` · floor неизвестен у ${unknownFloors}` : ""} · ${fmtUsd(usdOf(heldValue))}`
      : "сейчас ничего не держим",
  );

  $("coll-hint").textContent = `${cols.length} коллекций${p.cachedAt ? ` · отчёт от ${fmtDate(p.cachedAt)}` : ""}${state.profitBuilding ? " · обновляется…" : ""}`;
  $("coll-empty").hidden = cols.length > 0;
  $("coll-empty").textContent = "Коллекций пока нет.";
  const signed = (n) =>
    `<span class="${n > 0 ? "delta-up" : n < 0 ? "delta-down" : ""}">${n > 0 ? "▲ " : n < 0 ? "▼ " : ""}${fmtEth(n, { signed: true, unit: false })}</span>`;
  $("coll-table").querySelector("tbody").innerHTML = cols
    .map(
      (c) => `<tr>
        <td class="name" data-label="Коллекция">${collLink(c.collection, c.collectionName)}</td>
        <td class="nowrap" data-label="Минт"${c.mintAt && c.mintLast - c.mintAt > 3600_000 ? ` title="первый минт ${fmtDateTime(c.mintAt)}, последний ${fmtDateTime(c.mintLast)}"` : ""}>${c.mintAt ? fmtDateTime(c.mintAt) : `<span class="muted">—</span>`}</td>
        <td class="r" data-label="Запусков">${c.runs || 0}</td>
        <td class="r" data-label="Заминчено">${c.cost?.tokens ?? 0}</td>
        <td class="r" data-label="Потрачено">${fmtEth(c.spent, { unit: false })}</td>
        <td class="r" data-label="Продажи">${fmtEth(c.revenue, { unit: false })}</td>
        <td class="r" data-label="Держим">${c.heldTokens || 0}</td>
        <td class="r" data-label="Floor">${c.fl === null ? `<span class="muted">—</span>` : fmtEth(c.fl, { unit: false })}</td>
        <td class="r" data-label="Стоимость">${c.heldValue === null ? `<span class="muted">—</span>` : fmtEth(c.heldValue, { unit: false })}</td>
        <td class="r" data-label="PnL реал.">${signed(c.net)}</td>
        <td class="r" data-label="PnL c floor">${signed(c.withFloor)}</td>
      </tr>`,
    )
    .join("");

  renderPnlChart(p);
}

/** What each sortable collections column sorts by. Unknowns sink to the bottom. */
const COLL_SORT = {
  name: (c) => String(c.collectionName || c.collection).toLowerCase(),
  mintAt: (c) => c.mintAt ?? -Infinity,
  runs: (c) => c.runs || 0,
  minted: (c) => c.cost?.tokens ?? 0,
  spent: (c) => c.spent,
  revenue: (c) => c.revenue,
  held: (c) => c.heldTokens || 0,
  floor: (c) => c.fl ?? -Infinity,
  value: (c) => c.heldValue ?? -Infinity,
  net: (c) => c.net,
  withFloor: (c) => c.withFloor,
};
// Click a header: biggest first; again: smallest first. Names start A→Z.
$("coll-table").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  const s = state.collSort;
  state.collSort = s.key === key ? { key, dir: -s.dir } : { key, dir: key === "name" ? 1 : -1 };
  renderProfit();
});

// ── charts ─────────────────────────────────────────────────────────────────
function niceTicks(min, max, count = 4) {
  if (min === max) { const pad = Math.abs(min) * 0.1 || 0.001; min -= pad; max += pad; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const n = Math.round((hi - lo) / step);
  // Each tick from its index, not a running sum — adding a float step over and
  // over turns zero into 3.5e-18.
  const ticks = [];
  for (let i = 0; i <= n; i++) {
    const v = lo + i * step;
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : Number(v.toPrecision(10)));
  }
  return { lo, hi, ticks };
}

function lineChart(el, points, { color, name, valueFmt, emptyText, includeZero = true }) {
  const w = el.clientWidth || 600;
  const h = el.clientHeight || 220;
  el.__chart = { points, color, name, valueFmt, emptyText, includeZero };
  if (points.length === 0) {
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}"><text class="empty-chart" x="${w / 2}" y="${h / 2}" text-anchor="middle">${esc(emptyText)}</text></svg>`;
    return;
  }
  const pad = { l: 58, r: 12, t: 12, b: 26 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, h - pad.t - pad.b);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 3600e3; x1 += 3600e3; }
  // PnL keeps zero in view (the sign is the point); a balance line zooms to its
  // own range so a few-percent move is visible instead of a flat bar.
  const yMin = includeZero ? Math.min(0, ...ys) : Math.min(...ys);
  const yMax = includeZero ? Math.max(0, ...ys) : Math.max(...ys);
  const { lo, hi, ticks } = niceTicks(yMin, yMax);
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * iw;
  const Y = (y) => pad.t + (1 - (y - lo) / (hi - lo || 1)) * ih;

  const grid = ticks
    .map((t) => `<line class="${t === 0 ? "zero-line" : "grid-line"}" x1="${pad.l}" x2="${pad.l + iw}" y1="${Y(t)}" y2="${Y(t)}"/>
      <text class="tick" x="${pad.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(valueFmt(t, true))}</text>`)
    .join("");
  const xticks = [x0, x0 + (x1 - x0) / 2, x1]
    .map((t, i) => `<text class="tick" x="${X(t)}" y="${h - 6}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${esc(new Date(t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }))}</text>`)
    .join("");
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const base = Y(lo <= 0 && hi >= 0 ? 0 : lo);
  const area = `${d}L${X(points[points.length - 1].x).toFixed(1)},${base.toFixed(1)}L${X(points[0].x).toFixed(1)},${base.toFixed(1)}Z`;
  const single = points.length === 1
    ? `<circle class="dot" cx="${X(points[0].x)}" cy="${Y(points[0].y)}" r="4" fill="${color}"/>`
    : "";

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${grid}${xticks}
    <path class="area" d="${area}" fill="${color}"/>
    <path class="series" d="${d}" stroke="${color}"/>
    ${single}
    <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
    <circle class="dot hover-dot" r="4" fill="${color}" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>
  </svg>`;

  const svg = el.querySelector("svg");
  const cross = svg.querySelector(".cross");
  const dot = svg.querySelector(".hover-dot");
  const hit = svg.querySelector(".hit");
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * w;
    const xv = x0 + ((px - pad.l) / iw) * (x1 - x0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
    const cx = X(best.x);
    const cy = Y(best.y);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
    showTip(ev.clientX, ev.clientY, `<b>${esc(valueFmt(best.y))}</b><div class="t-muted">${esc(name)} · ${esc(fmtDate(best.x, true))}</div>${best.note ? `<div class="t-muted">${esc(best.note)}</div>` : ""}`);
  };
  const leave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", leave);
}

function renderPnlChart(p) {
  const events = [...(p.events || [])].filter((e) => e.at > 0).sort((a, b) => a.at - b.at);
  let cum = 0;
  const points = events.map((e) => {
    cum += weiToEth(e.wei);
    return { x: e.at * 1000, y: cum, note: e.kind === "sale" ? "продажа" : "минт" };
  });
  if (points.length) points.push({ x: Date.now(), y: cum, note: "сейчас" });
  lineChart($("chart-pnl"), points, {
    color: "var(--series-pnl)",
    name: "PnL",
    valueFmt: (v, axis) => fmtEth(v, { signed: !axis, unit: !axis }),
    emptyText: state.profitBuilding ? "Отчёт собирается…" : "Минтов и продаж пока нет",
  });
}

function renderBalanceChart(s, currentTotal) {
  const hist = (s.balanceHistory || []).map((p) => ({ x: p.at, y: weiToEth(p.walletsWei) + weiToEth(p.mainWei) }));
  const last = hist[hist.length - 1];
  if (!last || Date.now() - last.x > 5 * 60_000) hist.push({ x: Date.now(), y: currentTotal, note: "сейчас" });
  lineChart($("chart-bal"), hist.length > 1 ? hist : [], {
    color: "var(--series-bal)",
    name: "Общий баланс",
    valueFmt: (v, axis) => fmtEth(v, { unit: !axis }),
    emptyText: "Линия появится после первого снимка (раз в 30 мин)",
    includeZero: false,
  });
}

// Redraw charts when their box changes size — the SVG is drawn in pixels.
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const c = e.target.__chart;
    if (c) lineChart(e.target, c.points, c);
  }
});
ro.observe($("chart-pnl"));
ro.observe($("chart-bal"));

// ── tooltip ────────────────────────────────────────────────────────────────
function showTip(x, y, html) {
  const t = $("tip");
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
function hideTip() { $("tip").hidden = true; }

// ── once a second: countdowns and "updated N ago" ─────────────────────────
function tick() {
  const nowS = Date.now() / 1000;
  const timer = $("next-timer");
  if (timer.dataset.at) timer.textContent = countdown(Number(timer.dataset.at) - nowS);
  document.querySelectorAll("[data-cd]").forEach((el) => {
    const left = Number(el.dataset.cd) - nowS;
    el.textContent = left > 0 ? countdown(left) : "идёт";
  });
  if (state.lastOk) {
    const age = Math.round((Date.now() - state.lastOk) / 1000);
    if (age < SUMMARY_EVERY_MS / 1000 * 3) setLive("ok", age < 5 ? "в эфире" : `обновлено ${age}с назад`);
    else setLive("err", `нет связи ${Math.round(age / 60)} мин`);
  }
}

// ── boot ───────────────────────────────────────────────────────────────────
void start();
