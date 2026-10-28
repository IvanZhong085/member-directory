#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, sep, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

export async function renderSingleOverview() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const out = process.env.GROUPS_ARTIFACT_DIR || join(tmpdir(), "member-directory-single");
  await mkdir(out, { recursive: true });
  const groups = require("../data.js");
  const profiles = JSON.parse(await readFile(join(root, "data/_public-profiles.json"), "utf8"));
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
      if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
      const mime = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain" }[extname(path)];
      res.writeHead(200, { "Content-Type": (mime || "application/octet-stream") + "; charset=utf-8" }).end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  // Windows 的 ephemeral range 可能含 Chromium 禁用的 6566；選用高位本機埠。
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(30000 + Math.floor(Math.random() * 10000), "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    async function ready(mode) {
      await page.goto(base + "/groups.html?view=" + mode);
      await page.waitForFunction(() => document.getElementById("public-status").dataset.state === "ready");
      await page.evaluate(() => document.fonts.ready);
    }
    async function metrics() {
      return page.evaluate(() => {
        const sheet = document.querySelector(".sheet"), box = sheet.getBoundingClientRect();
        const zoom = parseFloat(getComputedStyle(sheet).zoom) || 1;
        const fonts = Object.fromEntries(["n", "company", "position"].map(s => [s, parseFloat(getComputedStyle(sheet.querySelector("." + s)).fontSize)]));
        return { width: box.width / zoom, height: box.height / zoom, fonts,
          at1000px: Object.fromEntries(Object.entries(fonts).map(([k,v]) => [k, v * zoom * 1000 / box.width])),
          at390px: Object.fromEntries(Object.entries(fonts).map(([k,v]) => [k, v * zoom * 390 / box.width])) };
      });
    }
    async function download(button, name) {
      const waiting = page.waitForEvent("download");
      await page.locator(button).click();
      const file = await waiting;
      await file.saveAs(join(out, name));
      assert.equal(await file.failure(), null);
      return "data:" + (name.endsWith("png") ? "image/png" : "image/jpeg") + ";base64," + (await readFile(join(out, name))).toString("base64");
    }
    async function noClipping(label) {
      const issues = await page.evaluate(() => {
        const sheet = document.querySelector(".sheet").getBoundingClientRect(), issues = [];
        for (const group of document.querySelectorAll("#grid .g")) {
          if (group.getClientRects().length !== 1) issues.push("split group");
          let last = group.querySelector(".g-h").getBoundingClientRect().bottom;
          for (const row of group.querySelectorAll("li")) {
            const r = row.getBoundingClientRect(), n = row.querySelector(".n").getBoundingClientRect();
            if (r.top < last - 1) issues.push("overlapping members");
            last = r.bottom;
            for (const el of row.querySelectorAll(".company, .position")) {
              if (el.textContent && el.getBoundingClientRect().top < n.bottom - 1) issues.push("company/title above name");
            }
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), range = document.createRange();
            let node;
            while ((node = walker.nextNode())) {
              range.selectNodeContents(node);
              for (const b of range.getClientRects()) {
                if (b.width && (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 2 || b.bottom > sheet.bottom)) issues.push("clipped: " + node.textContent + " " + JSON.stringify({text:[b.left,b.top,b.right,b.bottom],row:[r.left,r.top,r.right,r.bottom]}));
              }
            }
          }
        }
        return issues;
      });
      if(issues.length){
        console.log(await page.locator('#grid li').first().evaluate(row => Object.fromEntries(['.n','.details','.company','.position'].map(s => { const e=row.querySelector(s), r=e.getBoundingClientRect(); return [s,{top:r.top,bottom:r.bottom,lineHeight:getComputedStyle(e).lineHeight}]; }))));
        await page.locator('.sheet').screenshot({path:join(out,'layout-debug.png')});
      }
      assert.deepEqual(issues.slice(0, 4), [], label + " (" + issues.length + " issues)");
    }
    await ready("public");
    const before = await metrics();
    const oldImage = await download("#btn-jpg", "original-six-column.jpg");
    await page.locator("#view-mode").selectOption("public-single");
    assert.equal(await page.locator("#grid .g").count(), 12);
    const rows = await page.locator("#grid li").evaluateAll(nodes => nodes.map(el => ({
      name: el.querySelector(".n").textContent, company: el.querySelector(".company").textContent, position: el.querySelector(".position").textContent
    })));
    const members = groups.flatMap(g => g.members);
    assert.equal(rows.length, members.length);
    for (const m of members) assert.deepEqual(rows.find(row => row.name === m.name), {
      name: m.name, company: profiles[m.id].company, position: profiles[m.id].position || ""
    });
    assert.equal(rows.filter(r => !r.position).length, 2);
    assert.equal(await page.locator(".leader, .recruit, .sheet .t").count(), 0);
    await noClipping("單張桌面閱讀版不得重疊、裁字或拆組");
    // 螢幕寬度不足 1800px 時顯示依寬度排欄的閱讀版;橫式 2200px 四欄只在存圖/列印(.exporting)時出現,在那個版面下量。
    await page.locator(".sheet").evaluate(el => el.classList.add("exporting"));
    await noClipping("單張存圖版面不得重疊、裁字或拆組");
    const after = await metrics();
    const columns = await page.locator("#grid .g").evaluateAll(nodes => [...new Set(nodes.map(n => Math.round(n.getBoundingClientRect().left)))]);
    await page.locator(".sheet").evaluate(el => el.classList.remove("exporting"));
    assert.equal(columns.length, 4);
    assert.ok(after.width / after.height > 1.25, "完整單張必須是橫式，不得旋轉或拉伸直式圖: " + JSON.stringify(after));
    for (const field of ["n", "company", "position"]) assert.ok(after.at1000px[field] / before.at1000px[field] > 1.8, "橫式相同顯示寬度仍明顯大於舊六欄字體");
    const jpg = await download("#btn-jpg", "public-single-overview.jpg");
    const png = await download("#btn-png", "public-single-overview.png");
    const dimensions = await page.evaluate(src => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.src = src;
    }), jpg);
    assert.equal(dimensions[0], 6600);
    assert.ok(dimensions[0] > dimensions[1], "JPG 必須橫式");
    const pngDimensions = await page.evaluate(src => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.src = src;
    }), png);
    assert.deepEqual(pngDimensions, dimensions, "PNG 與 JPG 尺寸一致");
    const review = await context.newPage();
    await review.setViewportSize({ width: 1100, height: 1100 });
    await review.setContent('<body style="margin:0"><img style="display:block;width:1100px" src="' + jpg + '"></body>');
    await review.locator("img").evaluate(el => el.decode());
    await review.locator("img").screenshot({ path: join(out, "review-single-at-1100.png") });
    for (const [name, src] of [["before",oldImage],["after",jpg]]) {
      await review.setViewportSize({ width: 1000, height: 1000 });
      await review.setContent('<body style="margin:0"><img style="display:block;width:1000px" src="' + src + '"></body>');
      await review.locator("img").evaluate(el => el.decode());
      await review.locator("img").screenshot({ path: join(out, "comparison-" + name + "-at-1000.png") });
    }
    await review.close();
    await page.emulateMedia({ media: "print" });
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await noClipping("單頁列印不得裁切");
    await page.pdf({ path: join(out, "public-single-overview.pdf"), preferCSSPageSize: true, printBackground: true });
    const pdf = await readFile(join(out, "public-single-overview.pdf"));
    assert.equal([...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length, 1);
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await noClipping(width + "px 單張版");
      assert.ok(await page.locator(".sheet").evaluate(el => el.getBoundingClientRect().width <= innerWidth));
    }
    // 相同匯出路徑從窄螢幕產生，應維持同一張圖尺寸。
    const mobileImage = await download("#btn-jpg", "public-single-mobile-export.jpg");
    const mobileDimensions = await page.evaluate(src => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.src = src;
    }), mobileImage);
    assert.deepEqual(mobileDimensions, dimensions);
    await page.locator("#view-mode").selectOption("internal");
    assert.equal(await page.locator(".company").count(), 0);
    assert.ok(await page.locator(".leader").count());
    assert.ok(await page.locator(".recruit").count());
    assert.equal(await page.locator("#large-page-size").textContent(), "");
    assert.deepEqual(errors, []);
    const result = { verifiedAt: new Date().toISOString(), before, after, dimensions, groups: 12, members: rows.length,
      emptyPositions: rows.filter(r => !r.position).map(r => r.name), pdfPages: 1,
      ratios: Object.fromEntries(Object.keys(after.fonts).map(k => [k, after.at1000px[k] / before.at1000px[k]])), rows, allPassed: true };
    await writeFile(join(out, "single-overview-verification.json"), JSON.stringify(result, null, 2) + "\n");
    await writeFile(join(out, "single-overview-preview.html"), '<!doctype html><html lang="zh-Hant"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>對外產業小組圖｜完整單張</title><style>body{margin:0;background:#eee}img{display:block;width:100%;max-width:1100px;height:auto;margin:auto}</style><img alt="雲榮鑽石分會，12 組 89 人完整產業小組圖" src="' + png + '"></html>');
    console.log(JSON.stringify({ dimensions, before: before.at1000px, after: after.at1000px, ratios: result.ratios, count: rows.length, pdfPages:1 }));
    return result;
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await renderSingleOverview();
