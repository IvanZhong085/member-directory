#!/usr/bin/env node
/* 從 data.js 產生名冊鏡像 roster.csv(給 Google 試算表 IMPORTDATA 連結用)。
   欄位與後台「匯出 CSV」完全相同(共用 csv-schema.js),改好也能直接回灌後台「匯入 CSV」。
   注意:這個檔不含 BOM(Google 試算表取向);要用 Excel 開請改用後台的「匯出 CSV」。

   用法:在 repo 根目錄執行  node tools/build-roster.mjs
   內容取決於 data.js,資料沒變重跑也不會產生差異(冪等)。 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import CSV_SCHEMA from "../csv-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GROUPS = new Function(readFileSync(join(ROOT, "data.js"), "utf8") + ";return GROUPS;")();

const rows = [CSV_SCHEMA.HEADERS];
for(const g of GROUPS){
  for(const m of g.members){
    rows.push(CSV_SCHEMA.memberRow(g, m));
  }
}
writeFileSync(join(ROOT, "roster.csv"), rows.map(r => r.map(CSV_SCHEMA.escape).join(",")).join("\r\n") + "\r\n");
const total = GROUPS.reduce((n, g) => n + g.members.length, 0);
console.log("roster.csv 已產生:" + GROUPS.length + " 組、" + total + " 位成員。");
