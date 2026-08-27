/**
 * The numbers as a picture.
 *
 * A screenshot of a table is a screenshot of a table. This draws the same
 * figures as something worth posting: the net, what it took to get there, and
 * the collections behind it, in the app's own palette so it reads as coming
 * from this thing rather than from a spreadsheet.
 *
 * Drawn on a canvas rather than rendered from the DOM. Turning HTML into an
 * image needs a library and a font-loading dance, and the whole content here
 * is nine strings and two rules — the canvas is smaller, exact, and cannot
 * accidentally include the page around it.
 *
 * It reports what happened, and nothing else: no "up 400%", no claim about
 * what anyone should do next.
 */

export interface CardStats {
  netWei: bigint;
  spentWei: bigint;
  earnedWei: bigint;
  minted: number;
  sold: number;
  collections: number;
  /** The window these cover, as it reads in the panel. */
  rangeLabel: string;
  /** Best few by net, largest first. */
  top: { name: string; netWei: bigint }[];
  symbol: string;
}

const W = 1200;
const H = 630;

/** Wei to a short decimal string, the same shape the panel uses. */
function eth(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n) / 10n ** 14n; // four places
  const s = `${whole}.${String(frac).padStart(4, "0")}`.replace(/\.?0+$/, "");
  return `${neg ? "−" : ""}${s || "0"}`;
}

/**
 * Draw the card and hand back a blob.
 *
 * The palette is read off the live stylesheet rather than repeated here, so a
 * change to the theme shows up in the image too instead of drifting from it.
 */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  stats: CardStats,
  css: (name: string, fallback: string) => string,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = W;
  canvas.height = H;

  const bg = css("--bg", "#050806");
  const panel = css("--panel", "#0b100d");
  const line = css("--line", "#1d2a22");
  const green = css("--green-bright", "#00e676");
  const text = css("--text", "#d7e5dc");
  const dim = css("--faint", "#6a8074");
  const err = css("--err", "#ff5252");
  const mono = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = panel;
  ctx.fillRect(40, 40, W - 80, H - 80);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, W - 80, H - 80);

  ctx.fillStyle = text;
  ctx.font = `700 30px ${mono}`;
  ctx.fillText("LAUNCHPAD", 80, 105);
  ctx.fillStyle = green;
  ctx.fillText("_", 80 + ctx.measureText("LAUNCHPAD").width, 105);

  ctx.fillStyle = dim;
  ctx.font = `500 20px ${mono}`;
  ctx.fillText(stats.rangeLabel.toUpperCase(), W - 80 - ctx.measureText(stats.rangeLabel.toUpperCase()).width, 105);

  // The headline: the one number the whole card is about.
  const up = stats.netWei >= 0n;
  ctx.fillStyle = dim;
  ctx.font = `500 22px ${mono}`;
  ctx.fillText("NET", 80, 190);
  const headline = `${up ? "+" : "−"}${eth(stats.netWei < 0n ? -stats.netWei : stats.netWei)}`;
  ctx.fillStyle = up ? green : err;
  ctx.font = `700 108px ${mono}`;
  ctx.fillText(headline, 80, 285);
  // Measured at the size it was drawn at. Measuring after switching to the
  // smaller font put the symbol on top of the decimal point.
  const headlineWidth = ctx.measureText(headline).width;
  ctx.font = `500 34px ${mono}`;
  ctx.fillText(` ${stats.symbol}`, 80 + headlineWidth, 285);

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(80, 330);
  ctx.lineTo(W - 80, 330);
  ctx.stroke();

  const cells: [string, string, string][] = [
    ["MINTED", String(stats.minted), text],
    ["SPENT", `${eth(stats.spentWei)} ${stats.symbol}`, err],
    ["SOLD", String(stats.sold), text],
    ["EARNED", `${eth(stats.earnedWei)} ${stats.symbol}`, green],
  ];
  cells.forEach(([label, value, colour], i) => {
    const x = 80 + i * ((W - 160) / 4);
    ctx.fillStyle = dim;
    ctx.font = `500 18px ${mono}`;
    ctx.fillText(label, x, 375);
    ctx.fillStyle = colour;
    ctx.font = `700 34px ${mono}`;
    ctx.fillText(value, x, 415);
  });

  if (stats.top.length > 0) {
    ctx.fillStyle = dim;
    ctx.font = `500 18px ${mono}`;
    ctx.fillText(`BEST OF ${stats.collections} COLLECTIONS`, 80, 480);
    stats.top.slice(0, 3).forEach((t, i) => {
      const y = 520 + i * 34;
      ctx.fillStyle = text;
      ctx.font = `500 24px ${mono}`;
      // Names are user data and can be any length; clip rather than overflow
      // the card.
      let name = t.name;
      while (ctx.measureText(name).width > W - 420 && name.length > 3) {
        name = name.slice(0, -2);
      }
      ctx.fillText(name === t.name ? name : `${name}…`, 80, y);
      const amount = `${t.netWei >= 0n ? "+" : "−"}${eth(t.netWei < 0n ? -t.netWei : t.netWei)}`;
      ctx.fillStyle = t.netWei >= 0n ? green : err;
      ctx.font = `700 24px ${mono}`;
      ctx.fillText(amount, W - 80 - ctx.measureText(amount).width, y);
    });
  }
}

export function cardFileName(rangeLabel: string): string {
  return `launchpad-${rangeLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
}
