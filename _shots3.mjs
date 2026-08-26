import { chromium } from "playwright";
const NOW = Math.floor(Date.now() / 1000);
const status = {
  apiVersion: 6, running: false, activeJobId: null, armLeadMs: 120000, jobs: [
    { id: "j1", label: "Soon Drop", status: "queued", addedAt: 2, startTime: NOW + 1800, collection: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", stage: "public", quantity: 5, dryRun: false,
      drop: { name: "Soon Drop", totalSupply: "1200", maxSupply: "5000", priceWei: "0", startTime: NOW + 1800, endTime: NOW + 5400, perWallet: 5, readAt: Date.now() } },
  ],
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
page.on("pageerror", (e) => console.log("PAGE ERR:", e.message));
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.route("**/api/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) }));
await page.route("**/api/wallets", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wallets: [], chain: "x", explorerUrl: "https://x" }) }));
await page.addInitScript(() => {
  localStorage.setItem("launchpad.entered", "1");
  localStorage.setItem("launchpad.runner.url", "https://fake.example");
  localStorage.setItem("launchpad.runner.token", "t");
});
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(900);
await page.screenshot({ path: "design-review/p3-mobile-dash.png" });
await page.locator('.tabs button:has-text("SNIPE")').first().click({ force: true });
await page.waitForTimeout(1200);
const q = page.locator("table.collapsible").first();
if (await q.count()) await q.scrollIntoViewIfNeeded();
await page.screenshot({ path: "design-review/p3-mobile-queue.png" });
await browser.close();
