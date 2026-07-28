#!/usr/bin/env node
/* 把 data/ 底下的分組檔合併成前台用的 data.js。
   ★ 真實來源是 data/*.json,data.js 只是產出物 ★

   data/_index.json   分會結構:分組順序、代號、組名、內部 id(只有總管理員能改)
   data/<code>.json   該組的組長、招募席位、成員陣列(該組組長與總管理員可改)

   用法:在 repo 根目錄執行  node tools/build-data.mjs
   由 GitHub Action 在 data/ 有變動時自動執行;內容沒變重跑也不會產生差異(冪等)。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = join(ROOT, "data");
export const INDEX_FILE = join(DATA_DIR, "_index.json");

/* 分組物件的鍵順序:與歷史上的 data.js 一致,換順序會讓整份檔案產生無意義的 diff */
const GROUP_KEY_ORDER = ["code", "name", "leader", "room", "members", "id", "recruiting"];
/* 各鍵的歸屬:index=分會結構(總管理員),group=分組內容(該組組長) */
const INDEX_KEYS = new Set(["code", "name", "id"]);

export const groupFileName = code => String(code).trim().toLowerCase() + ".json";
export const groupFilePath = code => join(DATA_DIR, groupFileName(code));

/* 讀 data/ → 還原成與舊 data.js 完全同構的 GROUPS 陣列 */
export function loadGroups(){
  if(!existsSync(INDEX_FILE)) throw new Error("找不到 data/_index.json");
  const index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  if(!Array.isArray(index)) throw new Error("data/_index.json 必須是陣列");

  return index.map(entry => {
    const path = groupFilePath(entry.code);
    if(!existsSync(path)) throw new Error(`_index.json 列出了 ${entry.code},但找不到 data/${groupFileName(entry.code)}`);
    const body = JSON.parse(readFileSync(path, "utf8"));
    const g = {};
    for(const k of GROUP_KEY_ORDER) g[k] = INDEX_KEYS.has(k) ? (entry[k] ?? "") : (body[k] ?? (k === "members" || k === "recruiting" ? [] : ""));
    return g;
  });
}

export function serializeDataJs(groups){
  return "// 會員名錄資料檔 — 由後台編輯器 admin.html 產生/更新\n" +
         "// 直接用文字編輯器修改也可以；欄位說明見 README.md\n" +
         "const GROUPS = " + JSON.stringify(groups, null, 2) + ";\n" +
         "if (typeof module !== 'undefined') { module.exports = GROUPS; }\n";
}

/* 直接執行時才寫檔;被 import 當函式庫時不動任何東西 */
if(import.meta.url === `file://${process.argv[1]}`){
  const groups = loadGroups();
  const out = join(ROOT, "data.js");
  const next = serializeDataJs(groups);
  const prev = existsSync(out) ? readFileSync(out, "utf8") : "";
  if(next === prev){
    console.log("data.js 內容未變,不重寫。");
  } else {
    writeFileSync(out, next);
    const total = groups.reduce((n, g) => n + g.members.length, 0);
    console.log(`data.js 已重建:${groups.length} 組、${total} 位成員。`);
  }
}
