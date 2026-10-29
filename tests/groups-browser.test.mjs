import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const out = process.env.GROUPS_ARTIFACT_DIR || join(tmpdir(), "member-directory-groups-test");
await mkdir(out, { recursive: true });
const mime = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".css": "text/css", ".txt": "text/plain" };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
    if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { "Content-Type": (mime[extname(path)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
  // 本機驗證不連到發布 Worker、Google 或其他外部服務。
  await context.route("**/*", route => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const groups = require("../data.js");
  const count = groups.reduce((n, g) => n + g.members.length, 0);
  await page.goto(base + "/index.html");
  await page.getByRole("link", { name: /對外產業小組圖/ }).waitFor();
  assert.equal(await page.getByRole("link", { name: /對外產業小組圖/ }).getAttribute("href"), "groups.html?view=public-single");
  await page.setViewportSize({ width: 390, height: 844 });
  const button = await page.getByRole("link", { name: /對外產業小組圖/ }).boundingBox();
  assert.ok(button.x >= 0 && button.x + button.width <= 391, "首頁對外入口不得溢出手機寬度");
  await page.setViewportSize({ width: 1400, height: 950 });

  async function ready(view = "") {
    await page.goto(base + "/groups.html" + view);
    await page.waitForFunction(() => document.getElementById("public-status")?.dataset.state === "ready");
    await page.evaluate(() => document.fonts.ready);
  }
  async function fits(label) {
    const issues = await page.evaluate(() => {
      const grid = document.querySelector(".grid").getBoundingClientRect();
      const issues = [];
      for (const group of document.querySelectorAll(".g")) {
        if (group.getBoundingClientRect().bottom > grid.bottom + 3) issues.push("group below grid");
      }
      for (const el of document.querySelectorAll(".g-h, .company, .position")) {
        if (el.scrollWidth > el.clientWidth + 2) issues.push("horizontal overflow: " + el.textContent);
      }
      for (const row of document.querySelectorAll(".public .g-list li")) {
        const name = row.querySelector(".n").getBoundingClientRect();
        const company = row.querySelector(".company").getBoundingClientRect();
        const position = row.querySelector(".position").getBoundingClientRect();
        if (company.top < name.bottom - 1 || position.top < company.bottom - 1) issues.push("overlapping member lines");
      }
      return issues;
    });
    assert.deepEqual(issues, [], label);
  }
  async function download(label) {
    const waiting = page.waitForEvent("download");
    await page.locator("#btn-jpg").click();
    const file = await waiting;
    await file.saveAs(join(out, label + ".jpg"));
    assert.equal(await file.failure(), null);
    assert.match(file.suggestedFilename(), label.startsWith("internal") ? /_產業小組表\.jpg$/ : /_對外產業小組圖\.jpg$/);
    const bytes = (await readFile(join(out, label + ".jpg"))).toString("base64");
    const dimensions = await page.evaluate(data => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = reject;
      image.src = "data:image/jpeg;base64," + data;
    }), bytes);
    assert.deepEqual(dimensions, [3508, 1973], "桌面與手機都須匯出 300dpi 橫式海報");
    return file;
  }

  await ready();
  assert.equal(await page.locator(".g").count(), groups.length);
  assert.equal(await page.locator(".n").count(), count);
  assert.match(await page.locator("#mast-title").innerText(), /成交破億/);
  assert.ok(await page.locator(".leader").count());
  assert.ok(await page.locator(".recruit").count());
  assert.equal(await page.locator(".company").count(), 0);
  const internalRows = await page.locator("#grid").innerHTML();
  await fits("內部原版不可溢出");
  await download("internal");
  await page.locator("#mast-title").fill("自訂內部標題");

  await page.locator("#view-mode").selectOption("public");
  assert.match(await page.title(), /^對外產業小組圖/);
  assert.equal(await page.locator(".company").count(), count);
  assert.equal(await page.locator(".position").count(), count);
  assert.equal(await page.locator(".leader, .recruit, .sep").count(), 0);
  assert.ok(!(await page.locator(".sheet").innerText()).includes("成交破億"));
  assert.ok(!(await page.locator(".sheet").innerText()).includes("豬肉屠宰批發零售"));
  assert.ok(await page.locator(".company").evaluateAll(nodes => nodes.some(el => el.textContent !== "公司待補")));
  assert.ok(await page.locator(".position").evaluateAll(nodes => nodes.some(el => el.textContent !== "職位待確認")));
  await fits("對外桌面版不可溢出");
  await page.locator(".sheet").screenshot({ path: join(out, "public-desktop.png") });
  await download("public");
  const background = (await readFile(join(root, "group-sheet-bg.svg"))).toString("base64");
  const preview = await page.evaluate(background => {
    const sheet = document.querySelector(".sheet").cloneNode(true);
    sheet.querySelector(".sheet-bg").src = "data:image/svg+xml;base64," + background;
    const qr = document.createElement("img");
    qr.src = document.querySelector("#foot-qr-canvas").toDataURL();
    qr.alt = "完整會員名錄 QR code";
    qr.style.cssText = "width:44px;height:44px";
    sheet.querySelector("canvas").replaceWith(qr);
    sheet.querySelectorAll("[contenteditable]").forEach(el => el.removeAttribute("contenteditable"));
    return '<!doctype html><html lang="zh-Hant"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>對外產業小組圖 — 本機預覽</title><style>' + document.querySelector("style").textContent +
      '</style><body><div class="toolbar">本機預覽：' +
      document.getElementById("public-status").textContent + '</div>' + sheet.outerHTML + '</body></html>';
  }, background);
  await writeFile(join(out, "public-preview.html"), preview);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await fits("對外列印版不可溢出");
  await page.pdf({ path: join(out, "public-print.pdf"), preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.locator("#view-mode").selectOption("internal");
  assert.equal(await page.locator("#grid").innerHTML(), internalRows, "切回內部要還原全部列");
  assert.equal(await page.locator("#mast-title").innerText(), "自訂內部標題", "切換版本要保留使用者自訂標題");

  await page.setViewportSize({ width: 390, height: 844 });
  await ready("?view=public");
  await fits("手機長公司名需要換行");
  await page.screenshot({ path: join(out, "public-mobile.png"), fullPage: true });
  await download("public-mobile-export");
  const restored = await page.evaluate(() => document.querySelector(".sheet").getBoundingClientRect().width);
  assert.ok(restored <= 390, "匯出後需還原手機版面");

  // 超長公司名、長英文、缺職位、來源更正後姓名都經過真正 DOM 與 JPG 路徑。
  const fixture = structuredClone(groups);
  fixture[0].members[0].name = "曾俊楷"; // 合成測試，不是實際姓名更正。
  fixture[0].leader = "曾俊楷";
  fixture[0].members[0].company = "臺灣跨國食品農產冷鏈加工物流整合永續發展研發技術顧問服務股份有限公司";
  fixture[0].members[0].companyPosition = "";
  fixture[0].members[1].company = "InternationalFoodAndAgricultureSupplyChainCorporationGlobalResearchAndDevelopmentConsultingServices";
  fixture[0].members[0].phone = "PRIVATE-PHONE";
  fixture[0].members[0].taxId = "PRIVATE-TAX";
  await page.route("**/data.js?*", route => route.fulfill({
    contentType: "application/javascript", body: "const GROUPS = " + JSON.stringify(fixture) + ";"
  }));
  await page.route("**/data/_public-profiles.json", route => route.fulfill({
    contentType: "application/json", body: "{}"
  }));
  await page.setViewportSize({ width: 1400, height: 950 });
  await ready("?view=public");
  await page.locator("#mast-title").fill("版面測試（合成資料，非實際姓名更正）");
  await fits("長公司名與更正姓名不可溢出");
  const wrap = await page.locator(".company").first().evaluate(el => ({
    height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight), fontSize: getComputedStyle(el).fontSize,
    scale: getComputedStyle(document.getElementById("grid")).getPropertyValue("--s"),
    font: document.fonts.check("12px 'Noto Sans TC'")
  }));
  assert.ok(wrap.height > wrap.lineHeight * 1.5, "長公司名必須實際跨行，不能只驗短字串: " + JSON.stringify(wrap));
  assert.equal(await page.locator(".n").first().innerText(), "曾俊楷");
  assert.match(await page.locator(".position").first().innerText(), /職位待確認/);
  assert.ok(!(await page.locator(".sheet").innerText()).includes("PRIVATE-"));
  await page.locator(".sheet").screenshot({ path: join(out, "public-long-company-fixture.png") });
  await download("public-long-company-fixture");
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await fits("長公司名列印不可溢出");
  await page.emulateMedia({ media: "screen" });

  await page.route("**/data/_public-profiles.json", route => route.fulfill({ status: 503, body: "" }));
  await page.goto(base + "/groups.html?view=public");
  await page.waitForFunction(() => document.getElementById("public-status").dataset.state === "ready");
  assert.equal(await page.locator(".n").count(), count, "圖表直接使用主資料，不受舊補充檔影響");
  assert.equal(await page.locator(".position").nth(1).innerText(), fixture[0].members[1].companyPosition);
  assert.deepEqual(errors, [], "頁面不得發生 JavaScript 錯誤");
  console.log(`groups-browser: PASS (${groups.length} 組 ${count} 人；雙模式、JPG、PDF、手機、長公司名、更正姓名、單一主資料)`);
  console.log(`預覽目錄: ${out}`);
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
