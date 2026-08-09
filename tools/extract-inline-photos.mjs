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
/* 與 admin.js 的 fileSafeId 同一套規則:開頭必須是英數(Worker 的路徑白名單這樣要求)。
   兩邊都會替同一張照片取檔名,規則不一致的話同一張圖會在兩條路徑下變成兩個檔名。 */
const fileSafeId = id => {
  const s = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  return /^[A-Za-z0-9]/.test(s) ? s : "m" + s;
};

if(!existsSync(INDEX_FILE)){ console.error("找不到 data/_index.json"); process.exit(1); }
const index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));

let converted = 0;
for(const entry of index){
  const path = groupFilePath(entry.code);
  if(!existsSync(path)){ console.warn("略過不存在的分組檔:" + groupFileName(entry.code)); continue; }

  const body = JSON.parse(readFileSync(path, "utf8"));
  let changedInGroup = 0;

  /* value=內嵌字串、suffix 決定檔名:形象照 _x、名片 _card、商品照 _p1.._p5。
     setField 把「這一位、這一欄」改成檔名 —— 直接改物件對應欄位,而不是對整份檔案字串取代。
     兩位成員若共用同一張內嵌照片(位元組完全相同),字串取代會把兩處一起換成第一位的檔名,
     造成第二位被別名、其實體檔變孤兒,日後第一位換照片還會連帶悄悄替換掉第二位;
     逐欄改寫則兩人各自指向自己的檔。 */
  const convert = (m, value, suffix, setField) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(value || "");
    if(!match) return;
    const fname = fileSafeId(m.id) + suffix + "." + EXT_BY_MIME[match[1]];
    writeFileSync(join(ROOT, "images", fname), Buffer.from(match[2], "base64"));
    setField(fname);
    converted++; changedInGroup++;
    console.log("已轉檔:" + entry.code + "・" + m.name + " → images/" + fname);
  };

  for(const m of body.members || []){
    convert(m, m.image, "_x", fn => { m.image = fn; });
    convert(m, m.card, "_card", fn => { m.card = fn; });
    (m.products || []).forEach((p, i) => convert(m, p, "_p" + (i + 1), fn => { m.products[i] = fn; }));
  }

  if(changedInGroup){
    // 逐欄改寫不可能改到成員數;以正規格式(2 空格縮排 + 尾端換行,與後台/Worker 落盤一致)寫回
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  }
}

console.log("內嵌照片轉檔完成:共 " + converted + " 張。");
