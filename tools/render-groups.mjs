#!/usr/bin/env node
/* 把 groups.html(產業小組表)渲染成一張 JPG,給 LINE bot 等外部系統直接取用。

   為什麼需要:groups.html 不是一張圖,是用 data.js 即時畫出來的海報;「存成 JPG」
   也是在瀏覽器裡用 canvas 畫的。沒有瀏覽器的環境(例如 Google Apps Script)拿不到畫面,
   所以由這支工具在 GitHub Action 裡用無頭瀏覽器開頁面、截下 .sheet 區塊存成實體檔。
   產出跟網頁 100% 一致(同一份 HTML/CSS/字體/底圖),不另外維護第二套版面。

   產出(repo 根目錄,GitHub Pages 直接可取):
     groups.jpg    16:9 海報,裝置像素比 2(約 2248×1264)
     groups.json   { dataVersion, renderedAt, image, width, height }
                   dataVersion = data-version.txt 的內容(data.js 的雜湊),
                   外部系統比對這個值就知道「名錄有沒有變」,不用下載圖片。

   用法:先在 repo 根目錄起一個靜態伺服器,再執行
     python3 -m http.server 8000 &
     node tools/render-groups.mjs
   環境變數:BASE_URL(預設 http://127.0.0.1:8000/)、FORCE=1(版本沒變也重畫)。

   版面上印的是「渲染當天」的日期,所以版本沒變時不重畫 —— 否則每次跑都會因為
   日期不同而產生一張「不一樣」的圖、多一筆沒有意義的提交。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:8000/").replace(/\/?$/, "/");
const FORCE = process.env.FORCE === "1";
const OUT_IMAGE = "groups.jpg";
const OUT_META = "groups.json";

const versionPath = join(ROOT, "data-version.txt");
if (!existsSync(versionPath)) {
  console.error("找不到 data-version.txt —— 請先跑 node tools/stamp-data-version.mjs");
  process.exit(1);
}
const dataVersion = readFileSync(versionPath, "utf8").trim();

const metaPath = join(ROOT, OUT_META);
if (!FORCE && existsSync(metaPath) && existsSync(join(ROOT, OUT_IMAGE))) {
  try {
    const prev = JSON.parse(readFileSync(metaPath, "utf8"));
    if (prev.dataVersion === dataVersion) {
      console.log(`名錄版本未變(${dataVersion}),不重畫。要強制重畫請設 FORCE=1。`);
      process.exit(0);
    }
  } catch (e) { /* groups.json 壞掉就當作沒有,直接重畫 */ }
}

/* CHROMIUM_PATH 只給本機測試用(指定既有的 Chromium);Action 上由 playwright install 自備。 */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  /* 用 data.js 的版本戳開頁面:跟 data-fresh.js 的檢查對得上,就不會觸發它的重載。 */
  await page.goto(`${BASE_URL}groups.html?v=${dataVersion}`, { waitUntil: "networkidle" });
  /* 字體載完 fit() 才會算出最終縮放;多等一下讓版面穩定。 */
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);

  const groupCount = await page.evaluate(() => (typeof GROUPS !== "undefined" ? GROUPS.length : 0));
  if (!groupCount) {
    console.error("頁面沒有載到 GROUPS 資料,放棄輸出(避免提交一張空白圖)。");
    process.exit(1);
  }
  const sheet = await page.$(".sheet");
  if (!sheet) { console.error("找不到 .sheet 區塊。"); process.exit(1); }

  const box = await sheet.boundingBox();
  await sheet.screenshot({ path: join(ROOT, OUT_IMAGE), type: "jpeg", quality: 88 });
  const meta = {
    dataVersion,
    renderedAt: new Date().toISOString(),
    image: OUT_IMAGE,
    width: Math.round(box.width * 2),
    height: Math.round(box.height * 2),
    groups: groupCount,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`已輸出 ${OUT_IMAGE}(${meta.width}×${meta.height},${groupCount} 組)與 ${OUT_META},版本 ${dataVersion}。`);
} finally {
  await browser.close();
}
