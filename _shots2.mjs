import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERR:", e.message));
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.addInitScript(() => localStorage.setItem("launchpad.entered", "1"));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);
for (const [name, click] of [["launch", "LAUNCH"], ["snipe", "SNIPE"], ["tracker", "TRACKER"], ["upcoming", "UPCOMING"]]) {
  await page.locator(`.tabs button:has-text("${click}")`).first().click({ force: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `design-review/p2-${name}.png`, fullPage: false });
}
await browser.close();
