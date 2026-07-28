#!/usr/bin/env node
/* 把分組檔裡「內嵌」的照片(data: URL)抽出成 images/ 實體圖檔,並改寫該分組檔指向檔名。
   後台上傳照片若未經升級版 Worker,會以內嵌方式儲存——這支腳本(由 GitHub Action 於每次
   發布後自動執行)負責把它們正規化,分享預覽圖才能顯示本人照片。

   ★ 寫的是 data/<code>.json(真實來源),不是 data.js(產出物);合併由 build-data.mjs 負責 ★

   用法:在 repo 根目錄執行  node tools/extract-inline-photos.mjs
   沒有內嵌照片時不做任何事(冪等,可重複執行)。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_FILE, groupFilePath, groupFileName } from "./build-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_BY_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const fileSafeId = id => String(id).replace(/[^A-Za-z0-9_-]/g, "");

if(!existsSync(INDEX_FILE)){ console.error("找不到 data/_index.json"); process.exit(1); }
const index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));

let converted = 0;
for(const entry of index){
  const path = groupFilePath(entry.code);
  if(!existsSync(path)){ console.warn("略過不存在的分組檔:" + groupFileName(entry.code)); continue; }

  let src = readFileSync(path, "utf8");
  const body = JSON.parse(src);
  let changedInGroup = 0;

  /* value=內嵌字串、suffix 決定檔名:形象照 _x、名片 _card、商品照 _p1.._p5 */
  const convert = (m, value, suffix) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(value || "");
    if(!match) return;
    const fname = fileSafeId(m.id) + suffix + "." + EXT_BY_MIME[match[1]];
    writeFileSync(join(ROOT, "images", fname), Buffer.from(match[2], "base64"));
    const needle = JSON.stringify(value);
    if(!src.includes(needle)){
      console.error("⚠ 找不到 " + m.name + " 的內嵌圖片字串,略過(分組檔格式異常?)");
      return;
    }
    src = src.split(needle).join(JSON.stringify(fname));
    converted++; changedInGroup++;
    console.log("已轉檔:" + entry.code + "・" + m.name + " → images/" + fname);
  };

  for(const m of body.members || []){
    convert(m, m.image, "_x");
    convert(m, m.card, "_card");
    (m.products || []).forEach((p, i) => convert(m, p, "_p" + (i + 1)));
  }

  if(changedInGroup){
    // 改寫後重新解析驗證,確認人數沒被改壞才落盤
    const check = JSON.parse(src);
    if((check.members || []).length !== (body.members || []).length){
      throw new Error(entry.code + ":改寫後成員數不符,放棄寫入");
    }
    writeFileSync(path, src);
  }
}

console.log("內嵌照片轉檔完成:共 " + converted + " 張。");
