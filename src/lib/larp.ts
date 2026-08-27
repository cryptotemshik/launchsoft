/**
 * How much of a collection is real, as a number between 0 and 100.
 *
 * The grading machinery is `openseasuite`'s: every check reports ok / warn /
 * bad with its evidence attached, weights say how much each one matters, and
 * the score is the weighted average. Nothing is ever just a colour — the row
 * carries the number it was decided from, so a reader can disagree with it.
 *
 * The checks themselves are **not** that project's, and it is worth saying why
 * rather than quietly diverging. Its list leans on contract verification,
 * deployer history and metadata storage. Measured against Robinhood Chain, all
 * three are constants here: every collection sampled is an eip1167 clone from
 * the same factory, and the explorer reports every one of them verified. A
 * check that passes for everything adds the same number to every score, which
 * is not a signal — it is a wider gap between the score and what it claims to
 * mean.
 *
 * So these checks are the ones that actually separated collections when I
 * looked: whether anyone has attached a public identity to the drop and how
 * old it is, whether the market has priced the thing below what you would pay
 * to mint it, whether the minting is many wallets or one wallet in a loop, and
 * whether the art has been committed to or can still be swapped.
 */

export type CheckStatus = "ok" | "warn" | "bad" | "info";

export interface LarpCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** The number or fact this was decided from. Always shown. */
  detail: string;
  /** Relative importance. Ignored for "info". */
  weight?: number;
}

export interface LarpReport {
  /** 0–100, or null when nothing scoreable was known. */
  score: number | null;
  checks: LarpCheck[];
  /** How much of the total weight was actually decidable, 0..1. */
  confidence: number;
}

const GRADE: Record<Exclude<CheckStatus, "info">, number> = { ok: 1, warn: 0.5, bad: 0 };

/**
 * The weighted average of what could be graded.
 *
 * A check nobody could answer becomes "info" and carries no weight, so an
 * unknown never reads as a pass. When *nothing* could be graded the score is
 * null rather than 50: an invented middle is the one number a reader would
 * take at face value.
 */
export function computeLarpScore(checks: readonly LarpCheck[], totalWeight?: number): LarpReport {
  const scored = checks.filter(
    (c): c is LarpCheck & { status: keyof typeof GRADE } => c.status !== "info",
  );
  const graded = scored.reduce((a, c) => a + GRADE[c.status] * (c.weight ?? 1), 0);
  const weight = scored.reduce((a, c) => a + (c.weight ?? 1), 0);
  // Everything that was *asked*, graded or not — so confidence falls when
  // checks come back unknown rather than staying at 1 on half the evidence.
  const possible = totalWeight ?? checks.reduce((a, c) => a + (c.weight ?? 1), 0);
  return {
    score: weight === 0 ? null : Math.round((100 * graded) / weight),
    checks: [...checks],
    confidence: possible === 0 ? 0 : weight / possible,
  };
}

/** Everything the checks are allowed to look at. */
export interface LarpInput {
  priceWei: string;
  maxPerWallet: number;
  feeBps: number;
  maxSupply?: number;
  minted?: number;
  /** From the marketplace: the connected account, if there is one. */
  twitter?: string | null;
  followers?: number;
  joinedMs?: number;
  /**
   * The cheapest listing. Its coin is whatever the seller priced in, which is
   * not necessarily the coin the mint costs — both USDG and ETH occur here.
   */
  floorUnit?: number | null;
  floorSymbol?: string | null;
  /** The listing in dollars, when the marketplace gave one. */
  floorUsd?: number | null;
  /** The chain's own coin, which the mint price is denominated in. */
  nativeSymbol?: string;
  /** Dollars per unit of the chain's coin, when known. */
  nativeUsd?: number | null;
  /** Where the art lives: ipfs://…, https://…, or empty before a reveal. */
  baseURI?: string;
  /** Committed art hash. Zero means nothing was committed. */
  provenanceHash?: string;
  /** Minting activity over the last hour, when there was any. */
  perMin?: number;
  uniqueness?: number | null;
  mintTxs?: number;
  top1?: number;
  /** Seconds since the newest mint, when one has been seen. */
  quietFor?: number | null;
  now: number;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

type FloorVerdict =
  | "unlisted"
  | "free"
  | "incomparable"
  | { ratio: number; floorText: string; priceText: string };

/**
 * Put the floor and the mint price in the same units, or refuse to.
 *
 * They are not always the same coin: the mint costs the chain's own coin and
 * a seller may have listed in USDG. When the coins differ the only honest
 * comparison is through dollars, and only when both sides have one.
 */
function comparableFloor(d: LarpInput, price: number): FloorVerdict {
  if (d.floorUnit === undefined || d.floorUnit === null) return "unlisted";
  if (price === 0) return "free";

  // Only when both coins are known and equal, or when the floor named no coin
  // at all. An unknown native symbol is not permission to assume they match —
  // that assumption is exactly what produced the 2,500,000% comparison.
  const sameCoin =
    !d.floorSymbol ||
    (!!d.nativeSymbol && d.floorSymbol.toUpperCase() === d.nativeSymbol.toUpperCase());
  if (sameCoin) {
    const coin = d.floorSymbol ?? d.nativeSymbol ?? "";
    return {
      ratio: d.floorUnit / price,
      floorText: `${d.floorUnit} ${coin}`.trim(),
      priceText: `${price} ${coin}`.trim(),
    };
  }

  const priceUsd = d.nativeUsd ? price * d.nativeUsd : null;
  if (!priceUsd || !d.floorUsd) return "incomparable";
  return {
    ratio: d.floorUsd / priceUsd,
    floorText: `$${d.floorUsd.toFixed(2)}`,
    priceText: `$${priceUsd.toFixed(2)}`,
  };
}

/** Days since a unix-ms instant. */
function daysSince(ms: number, now: number): number {
  return Math.max(0, Math.floor((now * 1000 - ms) / 86_400_000));
}

export function larpChecks(d: LarpInput): LarpCheck[] {
  const checks: LarpCheck[] = [];

  // ── Identity ────────────────────────────────────────────────────────────
  // The cheapest thing a real project does and a throwaway does not.
  if (!d.twitter) {
    checks.push({
      id: "twitter",
      label: "Public account",
      status: "bad",
      detail: "no account connected on the marketplace",
      weight: 2,
    });
  } else if (d.followers === undefined) {
    checks.push({
      id: "twitter",
      label: "Public account",
      status: "info",
      detail: `@${d.twitter} — follower count not read yet`,
      weight: 2,
    });
  } else {
    const age = d.joinedMs ? daysSince(d.joinedMs, d.now) : null;
    // Both halves matter and neither alone is enough: ten thousand followers
    // on an account opened last Tuesday is a bought list, and a 2019 account
    // with nine followers is a dormant one.
    const young = age !== null && age < 30;
    const small = d.followers < 100;
    checks.push({
      id: "twitter",
      label: "Public account",
      status: small && young ? "bad" : small || young ? "warn" : "ok",
      detail:
        `@${d.twitter} · ${d.followers.toLocaleString("en-US")} followers` +
        (age === null ? "" : ` · account ${age}d old`),
      weight: 2,
    });
  }

  // ── What the market already thinks ──────────────────────────────────────
  const price = Number(d.priceWei) / 1e18;
  const floor = comparableFloor(d, price);
  if (floor === "unlisted") {
    checks.push({
      id: "floor",
      label: "Floor against mint price",
      status: "info",
      detail: "nothing listed yet — no market price to compare",
      weight: 2,
    });
  } else if (floor === "free") {
    checks.push({
      id: "floor",
      label: "Floor against mint price",
      status: "info",
      detail: `free mint · floor ${d.floorUnit} ${d.floorSymbol ?? ""}`.trim(),
      weight: 2,
    });
  } else if (floor === "incomparable") {
    // Rather than the nonsense this replaced: a 0.25 USDG floor against a
    // 0.00001 ETH mint was being reported as "2,500,000% of the mint price".
    checks.push({
      id: "floor",
      label: "Floor against mint price",
      status: "info",
      detail: `floor is priced in ${d.floorSymbol} — no rate to compare it with the ${d.nativeSymbol ?? "native"} mint price`,
      weight: 2,
    });
  } else {
    // The most direct evidence there is: people are already selling it for
    // less than it costs to mint.
    checks.push({
      id: "floor",
      label: "Floor against mint price",
      status: floor.ratio >= 1 ? "ok" : floor.ratio >= 0.6 ? "warn" : "bad",
      detail: `floor ${floor.floorText} is ${pct(floor.ratio)} of the ${floor.priceText} mint`,
      weight: 2,
    });
  }

  // ── Who is minting ──────────────────────────────────────────────────────
  if (d.uniqueness === undefined || d.uniqueness === null) {
    checks.push({
      id: "uniqueness",
      label: "Wallets behind the minting",
      status: "info",
      detail:
        d.mintTxs && d.mintTxs > 0
          ? `only ${d.mintTxs} mint tx${d.mintTxs === 1 ? "" : "s"} in the last hour — too few to judge`
          : "no mints in the last hour",
      weight: 3,
    });
  } else {
    checks.push({
      id: "uniqueness",
      label: "Wallets behind the minting",
      status: d.uniqueness >= 0.7 ? "ok" : d.uniqueness >= 0.4 ? "warn" : "bad",
      detail: `${pct(d.uniqueness)} of ${d.mintTxs} mint txs came from a different wallet`,
      weight: 3,
    });
  }

  if (d.top1 !== undefined && (d.mintTxs ?? 0) >= 5) {
    checks.push({
      id: "top1",
      label: "Largest wallet's share",
      status: d.top1 <= 0.15 ? "ok" : d.top1 <= 0.35 ? "warn" : "bad",
      detail: `${pct(d.top1)} of the last hour's mints came from one wallet`,
      weight: 2,
    });
  }

  // ── The art ─────────────────────────────────────────────────────────────
  const uri = (d.baseURI ?? "").trim();
  const committed = d.provenanceHash && !/^0x0*$/.test(d.provenanceHash);
  if (!uri) {
    checks.push({
      id: "art",
      label: "Where the art lives",
      status: committed ? "warn" : "bad",
      detail: committed
        ? "unrevealed, but the art is committed to on-chain"
        : "unrevealed and nothing committed — the art can still be anything",
      weight: 1,
    });
  } else if (uri.startsWith("ipfs://") || uri.startsWith("ar://")) {
    checks.push({
      id: "art",
      label: "Where the art lives",
      status: "ok",
      detail: `pinned content-addressed (${uri.slice(0, 12)}…)`,
      weight: 1,
    });
  } else {
    checks.push({
      id: "art",
      label: "Where the art lives",
      status: "warn",
      detail: `served from ${uri.replace(/^https?:\/\//, "").split("/")[0]} — replaceable at any time`,
      weight: 1,
    });
  }

  // ── The stage's own terms ───────────────────────────────────────────────
  const fee = d.feeBps / 100;
  checks.push({
    id: "fee",
    label: "Marketplace fee on the mint",
    status: fee <= 10 ? "ok" : fee <= 20 ? "warn" : "bad",
    detail: `${fee}% of every mint`,
    weight: 1,
  });

  if (d.maxSupply !== undefined) {
    // A cap that lets one wallet take a large slice is a drop designed to be
    // taken by one wallet.
    const share = d.maxPerWallet > 0 && d.maxSupply > 0 ? d.maxPerWallet / d.maxSupply : 0;
    checks.push({
      id: "cap",
      label: "Per-wallet cap against supply",
      status: d.maxPerWallet === 0 ? "bad" : share <= 0.01 ? "ok" : share <= 0.05 ? "warn" : "bad",
      detail:
        d.maxPerWallet === 0
          ? `no per-wallet limit on ${d.maxSupply.toLocaleString("en-US")} items`
          : `${d.maxPerWallet} of ${d.maxSupply.toLocaleString("en-US")} — ${pct(share)} to a single wallet`,
      weight: 1,
    });
  }

  return checks;
}

export function larpReport(d: LarpInput): LarpReport {
  return computeLarpScore(larpChecks(d));
}

/** The bands the column colours by. */
export function riskBand(score: number | null): "ok" | "warn" | "bad" | "unknown" {
  if (score === null) return "unknown";
  return score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
}
