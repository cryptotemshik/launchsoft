import { scanHoldings } from "./src/cli/nftSweep";
const api = "https://robinhoodchain.blockscout.com/api/v2";
const wallets = (await import("node:fs")).readFileSync("/tmp/addrs.txt", "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean) as `0x${string}`[];
const t0 = Date.now();
let last = "";
const r = await scanHoldings(api, wallets, {
  onProgress: (d, t, phase) => { const m = `${phase} ${d}/${t}`; if (m !== last && d % 25 === 0) { console.log("  " + m); last = m; } },
});
console.log(`\nпроверено кошельков: ${r.checked}`);
console.log(`с токенами:          ${r.withTokens}`);
console.log(`всего NFT:           ${r.holdings.reduce((n, h) => n + h.tokenIds.length, 0)}`);
console.log(`не прочитано:        ${r.failed.length}`);
console.log(`время:               ${Math.round((Date.now() - t0) / 1000)}s`);
const byColl = new Map<string, number>();
for (const h of r.holdings) byColl.set(h.collectionName ?? h.collection, (byColl.get(h.collectionName ?? h.collection) ?? 0) + h.tokenIds.length);
console.log("\nпо коллекциям:");
for (const [k, v] of byColl) console.log(`  ${k}: ${v}`);
