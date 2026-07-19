#!/usr/bin/env node
/* 把 data.js 裡「內嵌」的照片(data: URL)抽出成 images/ 實體圖檔,並改寫 data.js 指向檔名。
   後台上傳照片若未經升級版 Worker,會以內嵌方式儲存——這支腳本(由 GitHub Action 於每次
   發布後自動執行)負責把它們正規化,分享預覽圖才能顯示本人照片。

   用法:在 repo 根目錄執行  node tools/extract-inline-photos.mjs
   沒有內嵌照片時不做任何事(冪等,可重複執行)。 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = join(ROOT, "data.js");

let src = readFileSync(DATA_PATH, "utf8");
const GROUPS = new Function(src + ";return GROUPS;")();

const EXT_BY_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const fileSafeId = id => String(id).replace(/[^A-Za-z0-9_-]/g, "");

let converted = 0;
for(const g of GROUPS){
  for(const m of g.members){
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(m.image || "");
    if(!match) continue;
    const fname = fileSafeId(m.id) + "_x." + EXT_BY_MIME[match[1]];
    writeFileSync(join(ROOT, "images", fname), Buffer.from(match[2], "base64"));
    const needle = JSON.stringify(m.image);
    if(!src.includes(needle)){
      console.error("⚠ 找不到 " + m.name + " 的內嵌照片字串,略過(data.js 格式異常?)");
      continue;
    }
    src = src.split(needle).join(JSON.stringify(fname));
    converted++;
    console.log("已轉檔:" + m.name + " → images/" + fname);
  }
}

if(converted){
  // 改寫後重新解析驗證,確認 data.js 沒被改壞才落盤
  const check = new Function(src + ";return GROUPS;")();
  const total = check.reduce((n, g) => n + g.members.length, 0);
  const orig = GROUPS.reduce((n, g) => n + g.members.length, 0);
  if(total !== orig) throw new Error("改寫後成員數不符(" + total + " ≠ " + orig + "),放棄寫入");
  writeFileSync(DATA_PATH, src);
}
console.log("內嵌照片轉檔完成:共 " + converted + " 張。");
