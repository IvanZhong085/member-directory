#!/usr/bin/env node
/* 從 data.js 產生名冊鏡像 roster.csv(給 Google 試算表 IMPORTDATA 連結用)。
   欄位與後台「匯出 CSV」完全相同,改好也能直接回灌後台「匯入 CSV」。
   注意:這個檔不含 BOM(Google 試算表取向);要用 Excel 開請改用後台的「匯出 CSV」。

   用法:在 repo 根目錄執行  node tools/build-roster.mjs
   內容取決於 data.js,資料沒變重跑也不會產生差異(冪等)。 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GROUPS = new Function(readFileSync(join(ROOT, "data.js"), "utf8") + ";return GROUPS;")();

const HEADERS = ["編號","姓名","行業職稱","分組代號","分組名稱","服務項目","適合引薦對象","宣傳標語","所屬公司","主要營業項目","照片","資料需確認","刪除"];
const esc = v => {
  v = String(v == null ? "" : v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

const rows = [HEADERS];
for(const g of GROUPS){
  for(const m of g.members){
    rows.push([
      m.number || "", m.name || "", m.title || "", g.code || "", g.name || "",
      (m.services || []).join("|"), (m.targets || []).join("|"), (m.tagline || []).join("|"),
      m.company || "", m.business_items || "",
      /^data:/.test(m.image || "") ? "(內嵌照片)" : (m.image || ""),
      m.dataIssue ? "是" : "", "",
    ]);
  }
}
writeFileSync(join(ROOT, "roster.csv"), rows.map(r => r.map(esc).join(",")).join("\r\n") + "\r\n");
const total = GROUPS.reduce((n, g) => n + g.members.length, 0);
console.log("roster.csv 已產生:" + GROUPS.length + " 組、" + total + " 位成員。");
