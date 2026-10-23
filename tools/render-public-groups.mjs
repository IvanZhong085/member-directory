#!/usr/bin/env node
// 本機批次產出每組大字 JPG 與多頁 PDF；不寫入發布目錄，也不連線至正式服務。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const esc = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

export async function renderPublicGroups(options = {}) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const out = options.outputDirectory || process.env.GROUPS_ARTIFACT_DIR || join(tmpdir(), "member-directory-large");
  await mkdir(out, { recursive: true });
  const groups = require("../data.js");
  const selected = options.groupCodes ? groups.filter(g => options.groupCodes.includes(g.code)) : groups;
  assert.ok(selected.length, "至少需要一個有效小組");
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
      if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
      const content = await readFile(path);
      const mime = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
        ".svg": "image/svg+xml", ".css": "text/css", ".txt": "text/plain" }[extname(path)];
      res.writeHead(200, { "Content-Type": (mime || "application/octet-stream") + "; charset=utf-8" }).end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const result = { generatedAt: new Date().toISOString(), groups: [], pdfPages: 0, regressions: {} };
  const images = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ?
      route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    async function ready(query) {
      await page.goto(base + "/groups.html" + query);
      await page.waitForFunction(() => document.getElementById("public-status").dataset.state === "ready");
      await page.evaluate(() => document.fonts.ready);
    }
    await ready("?view=public-large&group=" + encodeURIComponent(selected[0].code));
    for (const group of selected) {
      await page.locator("#group-select").selectOption(group.code);
      assert.equal(await page.locator(".sheet .g").count(), 1);
      assert.equal(await page.locator(".leader, .recruit, .sep, .sheet .t").count(), 0);
      const metrics = await page.evaluate(() => {
        const sheet = document.querySelector(".sheet"), row = sheet.querySelector("li");
        return {
          cssWidth: sheet.getBoundingClientRect().width, cssHeight: sheet.getBoundingClientRect().height,
          scale: document.querySelector("#grid").style.getPropertyValue("--s"),
          fonts: Object.fromEntries([["name", ".n"], ["company", ".company"], ["position", ".position"]]
            .map(([key, selector]) => [key, parseFloat(getComputedStyle(row.querySelector(selector)).fontSize)])),
          rows: [...sheet.querySelectorAll("li")].map(el => ({
            name: el.querySelector(".n").textContent, company: el.querySelector(".company").textContent,
            position: el.querySelector(".position").textContent
          }))
        };
      });
      assert.equal(metrics.cssWidth, 390);
      const fileName = `public-large-${group.code}.jpg`;
      const waiting = page.waitForEvent("download");
      await page.locator("#btn-jpg").click();
      const download = await waiting;
      await download.saveAs(join(out, fileName));
      assert.equal(await download.failure(), null);
      assert.ok(download.suggestedFilename().includes(`_${group.code}_對外產業小組大字圖.jpg`));
      const bytes = await readFile(join(out, fileName));
      const src = "data:image/jpeg;base64," + bytes.toString("base64");
      const dimensions = await page.evaluate(src => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject; image.src = src;
      }), src);
      assert.equal(dimensions.width, 1170);
      assert.ok(Math.abs(dimensions.height - metrics.cssHeight * 3) <= 1, "畫布必須跟著完整內容增加高度");
      // 每組都在常見手機寬度檢查實際 DOM；換行不能裁字或縮字。
      for (const width of [360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const issues = await page.evaluate(() => {
          const sheet = document.querySelector(".sheet"), issues = [];
          if (sheet.getBoundingClientRect().width > innerWidth) issues.push("sheet overflow");
          for (const el of sheet.querySelectorAll(".g-h, .n, .company, .position")) {
            if (el.scrollWidth > el.clientWidth + 1) issues.push("text clipped: " + el.textContent);
          }
          for (const row of sheet.querySelectorAll("li")) {
            const n = row.querySelector(".n"), c = row.querySelector(".company"), p = row.querySelector(".position");
            if (c.getBoundingClientRect().top < n.getBoundingClientRect().bottom ||
                p.getBoundingClientRect().top < c.getBoundingClientRect().bottom) issues.push("overlap");
            if (getComputedStyle(c).fontSize !== "20px") issues.push("font shrunk");
          }
          return issues;
        });
        assert.deepEqual(issues, [], `${group.code} ${width}px 手機版`);
      }
      // 真正 JPG 以 390px 顯示的截圖供目視審閱，並非只截網頁 DOM。
      const imagePage = await context.newPage();
      await imagePage.setViewportSize({ width: 390, height: 844 });
      await imagePage.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0;background:white"><img alt="${esc(group.code + "／" + group.name)}" src="${src}" style="display:block;width:390px;height:auto"></body></html>`);
      await imagePage.locator("img").evaluate(el => el.decode());
      await imagePage.screenshot({ path: join(out, `review-${group.code}-phone-top.png`) });
      if (group.code === "G") {
        const longMemberTop = await page.locator(".g-list li").filter({ has: page.getByText("劉全修", { exact: true }) })
          .evaluate(el => el.offsetTop);
        await imagePage.evaluate(y => window.scrollTo(0, y), longMemberTop);
        await imagePage.screenshot({ path: join(out, "review-G-phone-long-company.png") });
      }
      await imagePage.close();
      images.push({ fileName, src, code: group.code, name: group.name });
      result.groups.push({ code: group.code, name: group.name, fileName, bytes: bytes.length, ...dimensions, ...metrics });
      await page.setViewportSize({ width: 1400, height: 950 });
      console.log(`${group.code}: ${dimensions.width}×${dimensions.height}, ${metrics.rows.length} 人`);
    }
    if (!options.groupCodes) {
      // 使用頁面上的實際「全部小組」操作，讓 print 專用頁面與手動操作相同。
      await page.evaluate(() => { window.print = () => {}; });
      await page.locator("#btn-print-all").click();
      await page.emulateMedia({ media: "print" });
      const printRows = await page.locator("#large-print .n").count();
      assert.equal(printRows, groups.reduce((n, g) => n + g.members.length, 0));
      result.pdfPageCss = await page.locator("#large-page-size").textContent();
      await page.pdf({ path: join(out, "public-large-all-groups.pdf"), preferCSSPageSize: true, printBackground: true });
      const pdf = await readFile(join(out, "public-large-all-groups.pdf"));
      result.pdfPages = [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
      assert.equal(result.pdfPages, groups.length, "必須每組一頁");
      await page.emulateMedia({ media: "screen" });
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      assert.equal(await page.locator("#large-print .sheet").count(), 0);
      const rows = result.groups.flatMap(g => g.rows);
      assert.ok(rows.find(r => r.name === "呂建緯" && r.position === "職位待確認"));
      assert.ok(rows.find(r => r.name === "邱俊華" && r.position === "職位待確認"));
      result.regressions.missingPosition = true;
      assert.ok(rows.some(r => r.name === "易紅福"));
      assert.ok(!rows.some(r => r.name === "易紅褔" || r.name === "楊淑媚"));
      result.regressions.correctedName = true;
      await page.locator("#view-mode").selectOption("internal");
      assert.equal(await page.locator(".g").count(), groups.length);
      assert.ok(await page.locator(".leader").count());
      assert.ok(await page.locator(".recruit").count());
      assert.equal(await page.locator(".company").count(), 0);
      assert.equal(await page.locator("#large-page-size").textContent(), "");
      await page.locator("#view-mode").selectOption("public");
      assert.equal(await page.locator(".company").count(), rows.length);
      assert.equal(await page.locator(".sheet.large").count(), 0);
      result.regressions.originalModes = true;
    }
    assert.deepEqual(errors, []);
    const previewName = options.groupCodes ? "public-large-G-preview.html" : "public-large-preview.html";
    await writeFile(join(out, previewName), `<!doctype html><html lang="zh-Hant"><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>對外產業小組圖｜每組大字版</title>
      <style>body{margin:0;background:#eee;font-family:"Microsoft JhengHei",sans-serif}header{padding:16px;background:white}
      select{font:inherit;padding:8px;max-width:100%}figure{margin:16px auto;width:390px;max-width:100%}img{display:block;width:100%;height:auto}[hidden]{display:none}</style>
      <header><label for="group">產業小組：</label><select id="group">${images.map(i => `<option value="${esc(i.code)}">${esc(i.code + "／" + i.name)}</option>`).join("")}</select></header>
      ${images.map((i, n) => `<figure data-code="${esc(i.code)}" ${n ? "hidden" : ""}><img alt="${esc(i.code + "／" + i.name + " 姓名、公司及職位")}" src="${i.src}"></figure>`).join("")}
      <script>document.querySelector('select').onchange=function(){document.querySelectorAll('figure').forEach(el=>el.hidden=el.dataset.code!==this.value);}</script></html>`);
    await writeFile(join(out, options.groupCodes ? "large-preview-metrics.json" : "large-groups-manifest.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    if (browser) await browser.close();
    await new Promise(r => server.close(r));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await renderPublicGroups({ groupCodes: process.env.GROUPS_PREVIEW_ONLY ? ["G"] : undefined });
}
