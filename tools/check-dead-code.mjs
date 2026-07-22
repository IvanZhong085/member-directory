#!/usr/bin/env node
/* 死程式碼掃描:找出「宣告了但整個載入環境都沒人呼叫」的函式。
   拆功能、大範圍刪除後必跑——2026/7 曾因拆批次照片誤刪 PPT 匯入三函式,
   這支掃描器 30 秒就能讓那種誤刪現形。

   用法:在 repo 根目錄執行  node tools/check-dead-code.mjs
   出現疑似死函式時以非零碼結束(可擋在提交前)。
   注意:動態組字串呼叫(極少用)可能誤報,人工確認後再處置。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => { try { return readFileSync(join(ROOT, f), "utf8"); } catch (e) { return ""; } };

/* 每個頁面實際載入的檔案組(依各 html 的 <script> 清單維護) */
const PAGES = {
  "admin.html":     ["data.js", "csv-schema.js", "jszip.js", "pptimport.js", "admin.js", "admin.html"],
  "index.html":     ["data.js", "qrcode.js", "sharecard.js", "app.js", "index.html"],
  "spotlight.html": ["data.js", "qrcode.js", "sharecard.js", "spotlight.js", "spotlight.html"],
};
/* 只掃第一方程式碼(第三方與資料檔跳過) */
const SKIP = new Set(["data.js", "jszip.js", "qrcode.js"]);

let suspects = 0;
for (const [page, files] of Object.entries(PAGES)) {
  const all = files.map(read).join("\n");
  for (const f of files.filter(x => x.endsWith(".js") && !SKIP.has(x))) {
    const src = read(f);
    const names = new Set([
      ...[...src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
      ...[...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)].map(m => m[1]),
    ]);
    for (const name of names) {
      const uses = (all.match(new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b", "g")) || []).length;
      if (uses <= 1) { console.log(`✗ ${page} / ${f}: 疑似死函式 ${name}`); suspects++; }
    }
  }
}
if (suspects) {
  console.log(`\n共 ${suspects} 個疑似死函式——若確為棄用請一併刪除;若是被誤刪了呼叫端,把功能救回來。`);
  process.exit(1);
}
console.log("✓ 掃描完成:三個頁面環境皆無疑似死函式。");
