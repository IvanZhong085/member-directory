#!/usr/bin/env node
/* 把對內產業小組表依目前順序、每六組渲染成一張 16:9 JPG。

   產出(repo 根目錄,GitHub Pages 直接可取):
     groups.jpg      第一張(前六組),保留既有檔名
     groups-2.jpg    第二張(後六組)
     groups.json     { dataVersion, layout, renderedAt, image, width, height, groups, images }
                     images 依頁序列出每張的 image/width/height/groups/groupCodes。
                     舊 image/width/height 欄位仍指第一張;外部系統應讀 images 才取得全部小組。

   用法:先在 repo 根目錄起靜態伺服器,再執行
     python3 -m http.server 8000 &
     node tools/render-groups.mjs
   環境變數:BASE_URL(預設 http://127.0.0.1:8000/)、FORCE=1(版本沒變也重畫)、
     GROUPS_ARTIFACT_DIR(另存輸出,本機驗證時避免修改 repo 產出物)、
     PLAYWRIGHT_MODULE(選用既有套件的絕對路徑)、CHROMIUM_PATH(選用既有 Chromium)。

   使用同一份 HTML/CSS/字體/底圖,不另外維護版面。資料版本與版型未變時不重畫,
   避免只因為當天日期不同而產生多餘提交。 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = process.env.GROUPS_ARTIFACT_DIR ? resolve(process.env.GROUPS_ARTIFACT_DIR) : ROOT;
const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:8000/").replace(/\/?$/, "/");
const FORCE = process.env.FORCE === "1";
const LAYOUT = "internal-six-per-page-v3";
const OUT_META = "groups.json";
const imageName = index => index === 0 ? "groups.jpg" : `groups-${index + 1}.jpg`;

const versionPath = join(ROOT, "data-version.txt");
if (!existsSync(versionPath)) {
  console.error("找不到 data-version.txt —— 請先跑 node tools/stamp-data-version.mjs");
  process.exit(1);
}
const dataVersion = readFileSync(versionPath, "utf8").trim();

const metaPath = join(OUTPUT, OUT_META);
if (!FORCE && existsSync(metaPath)) {
  try {
    const prev = JSON.parse(readFileSync(metaPath, "utf8"));
    if (prev.dataVersion === dataVersion && prev.layout === LAYOUT &&
        Array.isArray(prev.images) && prev.images.length > 0 &&
        prev.images.length === Math.ceil(prev.groups / 6) &&
        prev.images.every((image, index) => image.image === imageName(index) && existsSync(join(OUTPUT, image.image)))) {
      console.log(`名錄與版型未變(${dataVersion}),不重畫。要強制重畫請設 FORCE=1。`);
      process.exit(0);
    }
  } catch { /* 舊版或損壞的 metadata 必須重畫,不能沿用單張全組圖。 */ }
}

mkdirSync(OUTPUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`${BASE_URL}groups.html?v=${encodeURIComponent(dataVersion)}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.getElementById("public-status")?.dataset.state === "ready");
  await page.evaluate(() => document.fonts.ready);

  const groupCodes = await page.evaluate(() => typeof GROUPS === "undefined" ? [] : GROUPS.map(group => group.code));
  assert.ok(groupCodes.length, "頁面沒有載到 GROUPS 資料,放棄輸出空白圖。");
  const options = await page.locator("#internal-page-select option").evaluateAll(nodes => nodes.map(node => node.value));
  assert.equal(options.length, Math.ceil(groupCodes.length / 6), "頁數必須涵蓋全部小組,每張最多六組。");
  const images = [];
  for (const [index, value] of options.entries()) {
    await page.locator("#internal-page-select").selectOption(value);
    // 使用網頁的匯出版面,避免桌面預覽的 zoom 影響圖片尺寸。
    await page.evaluate(() => {
      document.querySelector(".sheet").classList.add("exporting");
      window.dispatchEvent(new Event("resize"));
    });
    const codes = await page.locator("#grid .g-h").evaluateAll(nodes => nodes.map(node => node.textContent.split("/")[0]));
    assert.deepEqual(codes, groupCodes.slice(index * 6, index * 6 + 6), "每張需保留原順序,不得漏組或重複。");
    const sheet = page.locator("body > .sheet");
    const box = await sheet.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "找不到可見的 .sheet 區塊。");
    const name = imageName(index);
    const bytes = await sheet.screenshot({ path: join(OUTPUT, name), type: "jpeg", quality: 88 });
    // Element screenshots round their clip to physical pixels; report the actual JPEG dimensions.
    const dimensions = await page.evaluate(async base64 => {
      const image = new Image();
      image.src = "data:image/jpeg;base64," + base64;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, bytes.toString("base64"));
    images.push({ image: name, ...dimensions, groups: codes.length, groupCodes: codes });
    await page.evaluate(() => document.querySelector(".sheet").classList.remove("exporting"));
  }
  const meta = {
    dataVersion,
    layout: LAYOUT,
    renderedAt: new Date().toISOString(),
    image: images[0].image,
    width: images[0].width,
    height: images[0].height,
    groups: groupCodes.length,
    images,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`已輸出 ${images.map(image => `${image.image}(${image.groups} 組)`).join("、")} 與 ${OUT_META},版本 ${dataVersion}。`);
} finally {
  await browser.close();
}
