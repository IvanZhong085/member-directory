#!/usr/bin/env node
/* 把 data.js 的內容雜湊蓋進各頁的 <script src="data.js?v=…"> —— 快取破除。

   為什麼需要:GitHub Pages 對所有檔案回 `cache-control: max-age=600`,而前台是用
   <script src="data.js"> 載入資料的。網址沒變的話,瀏覽器在 10 分鐘內**連問都不問**
   伺服器,直接用快取。結果就是「發布完了、Action 也跑完了,回名錄卻還是舊資料」——
   看起來像壞掉,其實只是還沒過期。(後台不受影響,它是用 fetch + no-store 抓的。)

   加上 ?v=<雜湊> 之後,資料一變就是一個全新網址,瀏覽器一定重抓。
   雜湊取自 data.js 內容,所以**資料沒變時版本號也不變**,不會製造多餘的提交。

   用法:在 repo 根目錄執行  node tools/stamp-data-version.mjs
   必須在 build-data.mjs **之後**跑(要對最終的 data.js 取雜湊)。由同步 Action 自動執行。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* 會載入 data.js 的前台頁面。admin.html 拆檔後改讀 data/ 分組檔,m/ 分享頁不載資料,
   兩者都不在這裡。新增頁面若要用 GROUPS,記得加進這個清單。 */
export const PAGES = ["index.html", "groups.html", "spotlight.html", "visitor.html"];
const SRC_RE = /(<script\s+src=")data\.js(?:\?v=[A-Za-z0-9]+)?(")/g;
/* 版本戳寫在 index.html 裡,而 index.html 自己也被快取 10 分鐘 —— 光靠戳記,
   發布後那 10 分鐘內回來的人還是會看到舊資料。所以同一個版本另外寫一份獨立的小檔,
   data-fresh.js 會用 no-store 問它,對不上就換網址重載。詳見 data-fresh.js。 */
const VERSION_FILE = "data-version.txt";

export function dataVersion(dataJsText){
  return createHash("sha256").update(dataJsText, "utf8").digest("hex").slice(0, 8);
}

const dataPath = join(ROOT, "data.js");
if(!existsSync(dataPath)){
  console.error("找不到 data.js —— 請先跑 node tools/build-data.mjs");
  process.exit(1);
}
const version = dataVersion(readFileSync(dataPath, "utf8"));

let changed = 0, missing = [];
for(const page of PAGES){
  const path = join(ROOT, page);
  if(!existsSync(path)){ missing.push(page); continue; }
  const before = readFileSync(path, "utf8");
  if(!SRC_RE.test(before)){ missing.push(page + "(找不到載入 data.js 的 script)"); SRC_RE.lastIndex = 0; continue; }
  SRC_RE.lastIndex = 0;
  const after = before.replace(SRC_RE, `$1data.js?v=${version}$2`);
  if(after !== before){ writeFileSync(path, after); changed++; }
}

const versionPath = join(ROOT, VERSION_FILE);
const versionBefore = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : null;
if(versionBefore !== version + "\n"){ writeFileSync(versionPath, version + "\n"); changed++; }

if(missing.length){
  console.error("✗ 這些頁面沒處理到:" + missing.join("、"));
  process.exit(1);
}
console.log(changed
  ? `data.js 版本戳已更新為 ${version}:改了 ${changed} 個檔案。`
  : `data.js 版本戳未變(${version}),不需重寫。`);
