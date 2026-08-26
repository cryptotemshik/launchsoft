import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.addInitScript(() => localStorage.setItem("launchpad.entered", "1"));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(900);
console.log(await page.evaluate(() => [...document.querySelectorAll(".tabs button")].map(b => {
  const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
  return `${b.textContent.trim().slice(0,9)} x=${r.x.toFixed(0)} w=${r.width.toFixed(0)} flex=${cs.flex}`;
})));
await browser.close();
