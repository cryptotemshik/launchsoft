import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.addInitScript(() => localStorage.setItem("launchpad.entered", "1"));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
console.log(await page.evaluate(() => {
  const t = document.querySelector(".tabs");
  const cs = getComputedStyle(t);
  return { position: cs.position, bottom: cs.bottom, matched: matchMedia("(max-width: 640px)").matches };
}));
await browser.close();
