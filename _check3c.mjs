import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.addInitScript(() => localStorage.setItem("launchpad.entered", "1"));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
console.log(await page.evaluate(() => {
  const t = document.querySelector(".tabs");
  const r = t.getBoundingClientRect();
  let anc = [], el = t.parentElement;
  while (el) {
    const cs = getComputedStyle(el);
    if (cs.transform !== "none" || cs.filter !== "none" || cs.willChange.includes("transform")) anc.push([el.className, cs.transform, cs.filter]);
    el = el.parentElement;
  }
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, badAncestors: anc };
}));
await page.screenshot({ path: "design-review/p3-mobile-bottombar.png" });
await browser.close();
