import { chromium } from "playwright";
const sizes = [[1440, 900, "desktop"], [768, 1024, "tablet"], [375, 812, "mobile"]];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
for (const [w, h, name] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => console.log(`PAGE ERR [${name}]:`, e.message));
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.screenshot({ path: `design-review/p1-landing-${name}.png` });
  await page.getByText("ENTER APP").first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `design-review/p1-app-${name}.png` });
  await page.close();
}
await browser.close();
