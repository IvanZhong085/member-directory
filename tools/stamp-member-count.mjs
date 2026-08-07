#!/usr/bin/env node
/* 把實際人數蓋進頁面上「寫死的數字」。

   為什麼需要:來賓頁的 meta description 與 og:description 裡有「認識 93 位」這種
   精確數字。頁面上看得到的地方有 JavaScript 會改成正確的,但**meta 標籤沒有** ——
   搜尋引擎與 LINE 預覽讀的就是 meta,於是分享出去的卡片一直停在舊數字。
   另外行銷文案卡那句「93 位各行業的老闆」是純文字、沒有 id,JS 也不會動它。

   名錄本來就會長,所以這件事不該靠人記得手改。由同步 Action 在 build-data 之後跑。

   ★ 找不到樣式就整支失敗 ★
   這種「靜默略過」的工具最危險:文案改寫過之後它就什麼都沒做,而你要好幾個月後
   才會發現數字又停在某個舊值。寧可讓 Action 紅一次,叫人回來把樣式補上。

   用法:在 repo 根目錄執行  node tools/stamp-member-count.mjs
   必須在 build-data.mjs 之後跑(要讀最終的 data.js)。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 每一條 = 一個「這裡有個人數」的樣式。用前後文當錨點,不要去比對裸數字
   ——「93」在 CSS 或別的地方也可能出現,盲目取代會改壞不相干的東西。 */
export const COUNT_SLOTS = [
  { file: "visitor.html", re: /(認識 )\d+( 位可以互相引薦)/g,   what: "meta / og 的描述" },
  { file: "visitor.html", re: /(<b id="hero-total">)\d+(<\/b>)/g, what: "首屏那句話" },
  { file: "visitor.html", re: /(<b id="stat-members">)\d+(<\/b>)/g, what: "首屏數字卡" },
  { file: "visitor.html", re: /(<p>)\d+( 位各行業的老闆)/g,      what: "「一次見到全產業」文案卡" },
];

export function memberCount(dataJsText){
  const m = dataJsText.match(/\[[\s\S]*\]/);
  if(!m) throw new Error("data.js 裡找不到 GROUPS 陣列");
  return JSON.parse(m[0]).reduce((n, g) => n + (g.members || []).length, 0);
}

const dataPath = join(ROOT, "data.js");
if(!existsSync(dataPath)){
  console.error("找不到 data.js —— 請先跑 node tools/build-data.mjs");
  process.exit(1);
}
const total = memberCount(readFileSync(dataPath, "utf8"));

let changed = 0;
const missing = [];
const byFile = new Map();
for(const slot of COUNT_SLOTS){
  const path = join(ROOT, slot.file);
  if(!existsSync(path)){ missing.push(slot.file + "(檔案不存在)"); continue; }
  const before = byFile.has(slot.file) ? byFile.get(slot.file) : readFileSync(path, "utf8");
  slot.re.lastIndex = 0;
  if(!slot.re.test(before)){ missing.push(slot.file + " 的「" + slot.what + "」"); continue; }
  slot.re.lastIndex = 0;
  byFile.set(slot.file, before.replace(slot.re, "$1" + total + "$2"));
}

for(const [file, after] of byFile){
  const path = join(ROOT, file);
  if(after !== readFileSync(path, "utf8")){ writeFileSync(path, after); changed++; }
}

if(missing.length){
  console.error("✗ 這些「人數」的樣式對不上,無法更新:" + missing.join("、"));
  console.error("  文案改寫過的話,請同步改 tools/stamp-member-count.mjs 的 COUNT_SLOTS。");
  process.exit(1);
}
console.log(changed
  ? `人數已更新為 ${total}:改了 ${changed} 個檔案。`
  : `人數未變(${total}),不需重寫。`);
