/* admin-logic.js 的純邏輯測試。
   這幾段是併發正確性的關鍵,原本埋在 admin.js 的 IIFE 裡、任何測試都碰不到 ——
   上一輪外部審查找到的前端 P0 就不是被測試抓到的,是被人逐行讀出來的。

   執行:node tests/logic.test.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "admin-logic.js"), "utf8");
const L = new Function(`${src}\nreturn AdminLogic;`)();

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(70) + "\n" + t + "\n" + "─".repeat(70));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ══ computeConflicts ══ */
hr("① 草稿三方比較(computeConflicts)");
{
  const live = { "data/a1.json":"H1", "data/b1.json":"H2", "data/_index.json":"H3" };

  chk("來源版本與線上一致 → 沒有衝突",
      eq(L.computeConflicts({ "data/a1.json":"H1", "data/b1.json":"H2", "data/_index.json":"H3" }, live), []));

  chk("有人改過其中一個 → 只有那一個是衝突",
      eq(L.computeConflicts({ "data/a1.json":"舊", "data/b1.json":"H2", "data/_index.json":"H3" }, live),
         ["data/a1.json"]));

  /* ★ 舊格式草稿沒有版本資訊。原本這種情況會**整段跳過**版本還原,變成
     「舊內容配新雜湊」—— 版本檢查會通過,於是靜默蓋掉別人的修改。 */
  chk("★ 舊格式草稿(沒有 baseHashes)→ 整份都算衝突",
      eq(L.computeConflicts(null, live).sort(), Object.keys(live).sort()));

  chk("草稿沒記錄到的路徑不算衝突(視為沒動過)",
      eq(L.computeConflicts({ "data/a1.json":"H1" }, live), []));

  chk("空字串的來源版本不算衝突(當成沒有基準)",
      eq(L.computeConflicts({ "data/a1.json":"" }, live), []));

  chk("線上沒有這個檔就不會被列進來",
      eq(L.computeConflicts({ "data/zz.json":"舊" }, live), []));
}

/* ══ computeRenameRemovals ══ */
hr("② 改名要刪掉的舊路徑(computeRenameRemovals)");
{
  const dataPathOf = code => "data/" + String(code).trim().toLowerCase() + ".json";
  const orig = { g1:"data/a1.json", g2:"data/b1.json" };

  chk("沒有改名 → 不刪任何東西",
      eq(L.computeRenameRemovals([{id:"g1",code:"A1"},{id:"g2",code:"B1"}], orig, dataPathOf), []));

  chk("★ A1 改成 Z9 → 刪掉 data/a1.json",
      eq(L.computeRenameRemovals([{id:"g1",code:"Z9"},{id:"g2",code:"B1"}], orig, dataPathOf),
         ["data/a1.json"]));

  chk("兩組同時改名 → 兩個舊路徑都刪",
      eq(L.computeRenameRemovals([{id:"g1",code:"Z9"},{id:"g2",code:"Y8"}], orig, dataPathOf),
         ["data/a1.json","data/b1.json"]));

  chk("★ 只改大小寫(A1→a1)→ 路徑相同,不刪(否則會把自己刪掉)",
      eq(L.computeRenameRemovals([{id:"g1",code:"a1"}], orig, dataPathOf), []));

  chk("新增的分組(沒有原始路徑)不會產生刪除",
      eq(L.computeRenameRemovals([{id:"g9",code:"C9"}], orig, dataPathOf), []));

  chk("同一個舊路徑不會重複出現",
      eq(L.computeRenameRemovals([{id:"g1",code:"Z9"},{id:"g1",code:"Z9"}], orig, dataPathOf),
         ["data/a1.json"]));
}

/* ══ isPrimaryTab ══ */
hr("③ 分頁 primary 選舉(isPrimaryTab)");
{
  chk("只有自己 → 是 primary", L.isPrimaryTab("b", []) === true);
  chk("自己的 id 最小 → 是 primary", L.isPrimaryTab("a", ["b","c"]) === true);
  chk("有更小的 id → 不是 primary", L.isPrimaryTab("c", ["a","b"]) === false);

  /* ★ 兩頁同時啟動時,雙方各自算出的答案必須互補 —— 不能兩邊都是 secondary
     (那樣兩頁都不存草稿,使用者的東西關掉分頁就沒了),也不能兩邊都是 primary
     (那樣又會互相整份覆寫)。 */
  const A = "a-111", B = "b-222";
  const aIsP = L.isPrimaryTab(A, [B]), bIsP = L.isPrimaryTab(B, [A]);
  chk("★ 兩頁同時啟動 → 恰好一頁是 primary", aIsP !== bIsP, `A=${aIsP} B=${bIsP}`);

  /* ★ 原分頁關閉後,它會從 peers 裡被清掉,剩下的分頁必須能接手。
     原本的實作(先到先得)永遠接不了手,後開的分頁會一直不存草稿。 */
  chk("★ 原分頁關閉後 secondary 接手", L.isPrimaryTab(B, []) === true);

  chk("三頁:只有最小的那個是 primary",
      [L.isPrimaryTab("a",["b","c"]), L.isPrimaryTab("b",["a","c"]), L.isPrimaryTab("c",["a","b"])]
        .filter(Boolean).length === 1);
}

/* ══ pendingNotice ══
   「有人在等認領」這件事原本沒有任何提示,申請就躺在待認領區直到有人剛好打開後台。
   這幾個級距的界線要驗,因為它們各自對應一個不同的後果:
     1 筆    清單本身就看得見,不必催 —— 每一筆都跳提醒會讓提醒本身變成雜訊
     2 筆起  開始催
     80% 起  滿了之後 /intake 會回 pending_full、新夥伴的申請**會被退回**
     滿      申請已經在掉了 */
hr("④ 待認領提醒(pendingNotice)");
{
  const P = L.pendingNotice;
  chk("0 筆不提醒", P(0, 30) === null);
  chk("★ 1 筆不提醒(清單本身就看得見)", P(1, 30) === null);

  const two = P(2, 30);
  chk("★ 2 筆開始提醒", !!two && two.level === "info", two && two.level);
  chk("★ 文案要講「盡速認領」", !!two && two.text.indexOf("盡速認領") >= 0, two && two.text);
  chk("文案帶出筆數", !!two && two.text.indexOf("2 位") >= 0, two && two.text);

  chk("中間值仍是 info", (P(10, 30) || {}).level === "info", (P(10, 30) || {}).level);
  chk("★ 23 筆(未達 80%)還不算快滿", (P(23, 30) || {}).level === "info", (P(23, 30) || {}).level);
  chk("★ 24 筆(達 80%)升級為警示", (P(24, 30) || {}).level === "warn", (P(24, 30) || {}).level);
  chk("快滿的文案要講「會被退回」",
      (P(24, 30) || {}).text.indexOf("退回") >= 0, (P(24, 30) || {}).text);

  chk("★ 滿了 → danger", (P(30, 30) || {}).level === "danger", (P(30, 30) || {}).level);
  chk("超過上限也是 danger(不會掉回別的級距)",
      (P(31, 30) || {}).level === "danger", (P(31, 30) || {}).level);

  /* 上限由呼叫端傳進來(對齊 Worker 的 MAX_PENDING),所以換了數字級距要跟著換 ——
     不能在這裡寫死第二份 30。 */
  chk("★ 上限換成 10 時,8 筆就算快滿", (P(8, 10) || {}).level === "warn", (P(8, 10) || {}).level);
  chk("上限換成 10 時,7 筆還是 info", (P(7, 10) || {}).level === "info", (P(7, 10) || {}).level);

  // 壞輸入不可以讓待認領區畫不出來
  chk("上限給 0 → 退回預設 30,不會除以零或永遠 danger",
      (P(2, 0) || {}).level === "info", (P(2, 0) || {}).level);
  chk("count 不是數字 → 當成 0,不提醒", P(undefined, 30) === null && P(null, 30) === null);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
