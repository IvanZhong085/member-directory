/* admin-logic.js 的純邏輯測試。
   這幾段是併發正確性的關鍵,原本埋在 admin.js 的 IIFE 裡、任何測試都碰不到 ——
   上一輪外部審查找到的前端 P0 就不是被測試抓到的,是被人逐行讀出來的。

   執行:node tests/logic.test.mjs */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as CASES from "./member-update-cases.mjs";

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

/* ══ makeSingleFlight ══
   對抗式審查在這裡抓到一個 P1:第一版的合流邏輯直接寫在 fetchPendPhoto 裡,
   兩條 early return 落在 try 之外,finally 不執行,於是「暫時拿不到」被永久記成失敗
   —— 待認領照片預覽整頁失效到重新載入為止,而且重新登入也救不回來。

   最關鍵的一條是 ③:把整段包進 try **修不好**。early return 那條路是同步跑完的,
   finally 會在呼叫端把 promise 存進 map 之前就執行,delete 變成空操作。
   所以這裡驗的不是「有沒有 try」,而是「同步就結束的那條路,結束後有沒有留下殘留」。 */
hr("⑤ 請求合流器(makeSingleFlight)");
{
  const flight = L.makeSingleFlight();

  // ① 進行中共用同一顆 promise
  let started = 0;
  let release;
  const slow = () => { started++; return new Promise(r => { release = r; }); };
  const p1 = flight.run("k", slow), p2 = flight.run("k", slow);
  chk("★ 同一把鑰匙進行中只會發一次", started === 1, "發了 " + started + " 次");
  chk("兩次呼叫拿到同一顆 promise", p1 === p2);
  release("url-1");
  chk("結果正確", (await p1) === "url-1");
  await Promise.resolve();
  chk("★ 結束後不留殘留", flight.size() === 0, flight.size() + " 筆");

  // ② 失敗不做負向快取:下一次要能重試
  let n = 0;
  const failFirst = () => { n++; return Promise.resolve(n === 1 ? null : "url-2"); };
  chk("第一次失敗回 null", (await flight.run("r", failFirst)) === null);
  chk("★ 失敗不留殘留(否則永遠重試不了)", flight.size() === 0, flight.size() + " 筆");
  chk("★ 第二次能重試而且拿得到結果", (await flight.run("r", failFirst)) === "url-2", "呼叫了 " + n + " 次");

  // ③ ★ 同步就 return 的路徑(session 過期、caps 還沒回來)不可以毒化
  let syncCalls = 0;
  const syncNull = () => { syncCalls++; return Promise.resolve(null); };   // 沒有任何 await
  chk("同步路徑回 null", (await flight.run("s", syncNull)) === null);
  chk("★ 同步結束的路徑也不留殘留", flight.size() === 0, flight.size() + " 筆");
  const again = await flight.run("s", () => Promise.resolve("url-3"));
  chk("★ 之後恢復正常時真的會重新請求(這正是原本壞掉的地方)", again === "url-3", String(again));

  // ④ reject 也要清乾淨,而且不可以變成未處理的 rejection
  const boom = flight.run("b", () => Promise.reject(new Error("x")));
  let caught = false;
  try{ await boom; }catch(e){ caught = true; }
  chk("reject 會傳出去", caught);
  await Promise.resolve();
  chk("★ reject 之後也不留殘留", flight.size() === 0, flight.size() + " 筆");

  // ⑤ fn 同步丟例外:不能讓呼叫端整段炸掉,也不能留殘留
  const threw = await flight.run("t", () => { throw new Error("同步炸了"); });
  chk("★ fn 同步丟錯 → 回 null 而不是往外炸", threw === null, String(threw));
  chk("★ 同步丟錯也不留殘留", flight.size() === 0, flight.size() + " 筆");

  // ⑥ clear():登出／清單整批換掉時,進行中的結果作廢
  flight.run("c", () => new Promise(() => {}));
  chk("進行中有一筆", flight.size() === 1);
  flight.clear();
  chk("★ clear() 之後清空", flight.size() === 0);
}

/* ══ 常數一致性 ══
   pendingNotice 的註解宣稱「max 由呼叫端傳入,不在這裡寫死第二份」—— 但呼叫端
   (admin.js 的 PENDING_MAX)確實是 Worker MAX_PENDING 的第二份副本。
   兩者一旦不同步,後果是安靜的:待認領區在真正滿掉之前不會升級成紅色警示,
   或是還沒滿就一直喊「已滿」,而使用者只會覺得提醒不準、然後開始忽略它。
   沒有辦法在瀏覽器裡共用同一個常數(Worker 不是靜態站的一部分),所以用測試綁住。 */
hr("⑥ 前端與 Worker 的待認領上限必須一致");
{
  const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
  const feM = /const\s+PENDING_MAX\s*=\s*(\d+)/.exec(read("admin.js"));
  const wkM = /const\s+MAX_PENDING\s*=\s*(\d+)/.exec(read("worker/publish-relay.js"));
  chk("admin.js 找得到 PENDING_MAX", !!feM, feM && feM[1]);
  chk("worker 找得到 MAX_PENDING", !!wkM, wkM && wkM[1]);
  chk("★ 兩邊的數字相同", !!feM && !!wkM && feM[1] === wkM[1],
      `前端 ${feM && feM[1]} / Worker ${wkM && wkM[1]}`);
}

/* ══════════════════════════════════════════════════════════════════════
   夥伴資料更新(規格 §4.1、§6.5)
   ══════════════════════════════════════════════════════════════════════ */
const DAY = 86400000;
const F = L.UPDATE_FIELD_ORDER;

/* ══ canon / same / hash:共用測資 ══
   後台算連結代碼、Worker 驗連結代碼,兩邊各一份實作。差一個字元,每一格都會被當成
   「本人改過」,舊連結再填一次就把後來的更新改回去 —— 而且沒有錯誤訊息。
   預期的 hash 是另一套實作算的;這裡再用第三套(BigInt 參考實作)交叉驗證一次。 */
hr("⑦ canon 與雜湊(共用測資 tests/member-update-cases.mjs)");
{
  for(const v of CASES.FNV_VECTORS){
    chk(`參考實作符合 FNV 官方測試向量 "${v.text}"`, CASES.fnv1a32Ref(v.text) === v.hex, CASES.fnv1a32Ref(v.text));
  }
  for(const c of CASES.VALUE_CASES){
    const canon = L.canonUpdateValue(c.field, c.input);
    const h = L.updateValueHash(c.field, c.input);
    chk(`canon:${c.name}`, eq(canon, c.canon), JSON.stringify(canon).slice(0, 80));
    chk(`hash:${c.name}`, h === c.hash, `${h} ≠ ${c.hash}`);
    // 測資本身的 hash 也要和參考實作對得上 —— 否則測資寫錯時,上面那條只會「一起錯」
    const isEmpty = !c.canon.length;
    const ref = isEmpty ? CASES.HASH_EMPTY : CASES.fnv1a32Ref(JSON.stringify(c.canon));
    chk(`測資自身與參考實作一致:${c.name}`, ref === (c.rawFnv || c.hash), `${ref}`);
  }
  chk("★ 空值一律是 00000000", CASES.VALUE_CASES.filter(c => !c.canon.length).every(c => L.updateValueHash(c.field, c.input) === "00000000"));
  chk("★ FNV 剛好算出 0 → 改成 00000001(8 個 0 留給空白格)",
      CASES.VALUE_CASES.filter(c => c.rawFnv === "00000000").length === 2 &&
      CASES.VALUE_CASES.filter(c => c.rawFnv === "00000000").every(c => L.updateValueHash(c.field, c.input) === "00000001"));
  chk("雜湊一律是 8 位小寫 hex", CASES.VALUE_CASES.every(c => /^[0-9a-f]{8}$/.test(L.updateValueHash(c.field, c.input))));
  for(const s of CASES.SAME_CASES){
    chk(`sameUpdateValue:${s.name}`, L.sameUpdateValue(s.field, s.a, s.b) === s.same);
  }
  for(const t of CASES.TOKEN_CASES){
    const tok = L.memberUpdateToken(t.member);
    chk(`連結代碼:${t.name}`, tok === t.token, tok);
  }
  chk("UPDATE_HASH_EMPTY 是 00000000", L.UPDATE_HASH_EMPTY === "00000000");
  chk("canon 不會改到傳進來的陣列", (() => { const a = [" x "]; L.canonUpdateValue("services", a); return a[0] === " x "; })());
}

/* ══ 選項文字與欄位名稱:後台與 Apps Script 兩份必須一樣 ══
   預填連結靠「A1・曾俊凱」這串字預選名字;兩邊差一個字(例如「・」用成「·」),
   預填就選不到人,夥伴只看到空白選單。所以直接用 vm 載入 google-form.gs 比對輸出。 */
hr("⑧ 選項文字、欄位名稱與欄位順序(和 google-form.gs / Worker 一致)");
{
  const gs = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, "tools/google-form.gs"), "utf8"), gs, { filename: "google-form.gs" });
  chk("google-form.gs 有 memberUpdateLabel_", typeof gs.memberUpdateLabel_ === "function");
  const inputs = [["A1","曾俊凱"], [" A1 "," 曾俊凱 "], ["B2","王 大明"], ["c","Ａ林"], ["D1","李\t小華\n"], [3, "x"]];
  for(const [code, name] of inputs){
    const a = L.memberUpdateLabel(code, name), b = typeof gs.memberUpdateLabel_ === "function" ? gs.memberUpdateLabel_(code, name) : "(沒有)";
    chk(`★ 兩邊輸出相同:${JSON.stringify([code, name])}`, a === b, `${a} / ${b}`);
  }
  const lab = L.memberUpdateLabel(" A1 ", " 曾俊凱 ");
  chk("前後空白被 trim", lab === "A1・曾俊凱", lab);
  chk("★ 中間是 U+30FB「・」", lab.charCodeAt(2) === 0x30FB, lab.charCodeAt(2).toString(16));

  // 欄位名稱與表單題目同名(NEWMEMBER_Q),催收訊息和審核畫面講的字才對得上表單
  const q = gs.NEWMEMBER_Q || {};
  chk("★ FIELD_LABELS 與表單題目(NEWMEMBER_Q)同名", F.every(k => L.FIELD_LABELS[k] === q[k]),
      F.filter(k => L.FIELD_LABELS[k] !== q[k]).join(","));
  chk("FIELD_LABELS 剛好是 9 個欄位", eq(Object.keys(L.FIELD_LABELS).sort(), F.slice().sort()));
  chk("UPDATE_FIELD_ORDER 照規格", eq(F, ["company","business_items","website","have","want","title","services","targets","tagline"]));
  chk("LIST_FIELDS 照規格", eq(L.LIST_FIELDS, ["services","targets","have","want","tagline"]));
  chk("UPDATE_LATE_MS 是 10 分鐘", L.UPDATE_LATE_MS === 10 * 60 * 1000);

  /* 連結代碼的 9 段順序寫死在已經發出去的連結裡:三份程式只要有一份順序不同,
     每一格都會對到別欄的雜湊。Worker 與 .gs 還沒實作時略過,實作之後一定要一致。 */
  const quoted = s => [...s.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
  const wk = /const\s+UPDATE_TOKEN_ORDER\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(path.join(ROOT, "worker/publish-relay.js"), "utf8"));
  if(wk) chk("★ Worker 的 UPDATE_TOKEN_ORDER 與 UPDATE_FIELD_ORDER 相同", eq(quoted(wk[1]), F), quoted(wk[1]).join(","));
  else console.log("  ·  Worker 還沒有 UPDATE_TOKEN_ORDER,略過");
  const wl = /const\s+UPDATE_LIST_FIELDS\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(path.join(ROOT, "worker/publish-relay.js"), "utf8"));
  if(wl) chk("★ Worker 的 UPDATE_LIST_FIELDS 與 LIST_FIELDS 相同", eq(quoted(wl[1]), L.LIST_FIELDS), quoted(wl[1]).join(","));
  else console.log("  ·  Worker 還沒有 UPDATE_LIST_FIELDS,略過");
  if(Array.isArray(gs.UPDATE_FIELD_KEYS)) chk("★ google-form.gs 的 UPDATE_FIELD_KEYS 與 UPDATE_FIELD_ORDER 相同", eq([...gs.UPDATE_FIELD_KEYS], F));
  else console.log("  ·  google-form.gs 還沒有 UPDATE_FIELD_KEYS,略過");
}

/* 測試用的成員:和 data/a1.json 的曾俊凱同一個形狀 */
const MEMBER = () => ({
  id:"g3_m1", name:"曾俊凱", title:"豬肉屠宰批發零售",
  services:["冷藏/凍豬肉原料批發","豬肉絲/丁/片/塊精切"], targets:["連鎖滷味店/豬腳店","小家庭豬肉箱"],
  have:[], want:[], tagline:["國產豬肉專門家","品質保證攏抵家"],
  company:"", business_items:"", website:"", dataIssue:false, updatedAt:"2026-07-28T07:14:10.402Z",
});

/* ══ memberPrefillValues / memberUpdateToken ══ */
hr("⑨ 預填內容與連結代碼(memberPrefillValues)");
{
  const m = MEMBER();
  const v = L.memberPrefillValues("A1", m);
  chk("名字選項是「A1・曾俊凱」", v.member === "A1・曾俊凱", v.member);
  chk("★ 清單用 \\n 串起來", v.services === "冷藏/凍豬肉原料批發\n豬肉絲/丁/片/塊精切", JSON.stringify(v.services));
  chk("文字欄位照原樣", v.title === "豬肉屠宰批發零售");
  chk("★ 空值不放(公司、營業項目、網站、我有、我要)",
      ["company","business_items","website","have","want"].every(k => !(k in v)), Object.keys(v).join(","));
  chk("★ 有 token,格式符合 v1.<id>.<72 hex>", /^v1\.[A-Za-z0-9_-]{1,64}\.[0-9a-f]{72}$/.test(v.token || ""), v.token);
  chk("token 就是 memberUpdateToken(member)", v.token === L.memberUpdateToken(m));
  chk("token 帶的是成員 id", (v.token || "").split(".")[1] === "g3_m1");

  /* ★ Worker 判斷「連結帶入、本人沒改」靠的是:預填的值送回來後算出的雜湊 == 代碼裡那一段。
     這條不成立,所有預填的格子都會被當成修改。空的格子不預填、送回來是空字串,
     Worker 走「canon 是空的」那條路,所以只看有預填的格子。 */
  const segs = (v.token || "").split(".")[2] || "";
  const bad = F.filter((f, i) => f in v && L.updateValueHash(f, v[f]) !== segs.slice(i * 8, i * 8 + 8));
  chk("★ 每一格預填值的雜湊 = 代碼裡對應的那一段", segs.length === 72 && bad.length === 0, bad.join(","));
  chk("空的格子在代碼裡是 00000000",
      F.every((f, i) => f in v || segs.slice(i * 8, i * 8 + 8) === "00000000"));

  // 預填的是正規化後的值:控制字元、前後空白、空行都清掉,和代碼記的一致
  const dirty = Object.assign(MEMBER(), { company:"  雲榮肉品\u0000有限公司 ", targets:["", " 火鍋餐廳 ", "外燴團隊"] });
  const dv = L.memberPrefillValues("A1", dirty);
  chk("文字值去掉控制字元與前後空白", dv.company === "雲榮肉品有限公司", JSON.stringify(dv.company));
  chk("清單去掉空項與每項前後空白", dv.targets === "火鍋餐廳\n外燴團隊", JSON.stringify(dv.targets));

  for(const id of ["g3 m1", "", "../g3_m1", "x".repeat(65), 123, undefined]){
    const bv = L.memberPrefillValues("A1", Object.assign(MEMBER(), { id }));
    chk(`member.id 不合格(${JSON.stringify(id)})→ 沒有 token`, !("token" in bv) && L.memberUpdateToken(Object.assign(MEMBER(), { id })) === "");
  }
  chk("沒有名字 → 不放 member", !("member" in L.memberPrefillValues("A1", Object.assign(MEMBER(), { name:"" }))));
  chk("member 是 null 也不會丟例外", eq(L.memberPrefillValues("A1", null), {}));
}

/* ══ updatePrefillUrl ══ */
hr("⑩ 預填連結(updatePrefillUrl)");
{
  const FORM = "https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform?usp=sf_link";
  const ENT = { member:"entry.1001", title:"entry.1002", company:"entry.1003", services:"entry.1004", targets:"entry.1005",
                have:"entry.1006", want:"entry.1007", tagline:"entry.1008", business_items:"entry.1009",
                website:"entry.1010", token:"entry.1011" };
  const m = MEMBER();
  const vals = L.memberPrefillValues("A1", m);
  const r = L.updatePrefillUrl(FORM, ENT, vals);
  const u = new URL(r.url);
  chk("回傳 url,沒有 trimmed / nameless", !!r.url && r.trimmed === false && r.nameless === false);
  chk("★ 原本帶 ? 的網址:usp 只剩一個 pp_url", eq(u.searchParams.getAll("usp"), ["pp_url"]), u.search.slice(0, 60));
  chk("網址的路徑不變", u.origin + u.pathname === "https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform");
  chk("名字帶進去", u.searchParams.get("entry.1001") === "A1・曾俊凱");
  chk("清單帶進去(換行原樣還原)", u.searchParams.get("entry.1004") === vals.services);
  chk("★ 連結代碼帶進去", u.searchParams.get("entry.1011") === vals.token);
  chk("空值沒有帶(公司)", !u.searchParams.has("entry.1003"));

  // 換行、空白、「・」、括號、& 都要正確編碼
  const tricky = { member:"A1・曾俊凱", company:"雲榮 肉品（股）(台灣) & 分店=1", services:"a b\nc" };
  const t = L.updatePrefillUrl(FORM, ENT, tricky);
  const tu = new URL(t.url);
  chk("★ 原始網址裡沒有未編碼的空白、換行、括號、「・」",
      !/[\s()（）・]/.test(t.url), t.url);
  chk("換行編碼成 %0A", t.url.indexOf("%0A") >= 0);
  chk("「・」編碼成 %E3%83%BB", t.url.indexOf("%E3%83%BB") >= 0);
  chk("括號編碼成 %28 / %29", t.url.indexOf("%28") >= 0 && t.url.indexOf("%29") >= 0);
  chk("★ 每個值都能原樣還原", tu.searchParams.get("entry.1001") === tricky.member &&
      tu.searchParams.get("entry.1003") === tricky.company && tu.searchParams.get("entry.1004") === tricky.services);
  chk("值裡的 & 和 = 不會多出參數", tu.searchParams.getAll("entry.1003").length === 1 && !tu.searchParams.has("分店"));

  const plain = L.updatePrefillUrl("https://docs.google.com/forms/d/e/X/viewform", ENT, { member:"A1・曾俊凱" });
  chk("沒有 ? 的網址也能組", plain.url.startsWith("https://docs.google.com/forms/d/e/X/viewform?usp=pp_url&"), plain.url);
  chk("★ 只有 member:只帶 usp、名字和 openExternalBrowser", eq([...new URL(plain.url).searchParams.keys()], ["usp","entry.1001","openExternalBrowser"]));

  chk("entries 沒有 member → 通用連結(帶 openExternalBrowser=1)+ nameless",
      eq(L.updatePrefillUrl(FORM, { company:"entry.1003" }, vals), { url: FORM + "&openExternalBrowser=1", nameless: true, trimmed: false }));
  chk("entries 是空的 → nameless", (L.updatePrefillUrl(FORM, {}, vals) || {}).nameless === true);
  chk("★ formUrl 空 → null", L.updatePrefillUrl("", ENT, vals) === null && L.updatePrefillUrl(null, ENT, vals) === null &&
      L.updatePrefillUrl("   ", ENT, vals) === null);
  chk("formUrl 不是 http(s) → null", L.updatePrefillUrl("javascript:alert(1)", ENT, vals) === null);

  const noTok = Object.assign({}, ENT); delete noTok.token;
  const nt = new URL(L.updatePrefillUrl(FORM, noTok, vals).url);
  chk("★ entries 沒有 token → 不帶 token(其他照帶)", !nt.searchParams.has("entry.1011") &&
      ![...nt.searchParams.values()].some(x => x === vals.token) && nt.searchParams.get("entry.1004") === vals.services);
  chk("只放 entries 與 values 都有的鍵", eq([...new URL(L.updatePrefillUrl(FORM, { member:"entry.1001", company:"entry.1003" },
      { member:"A1・曾俊凱", title:"x" }).url).searchParams.keys()], ["usp","entry.1001","openExternalBrowser"]));
  /* 有內容的格子沒有 entry → 那一格帶不進表單、送出時是空的;代碼若照帶,Worker 會判成「本人清空了」 */
  const noTitle = Object.assign({}, ENT); delete noTitle.title;
  const ntu = new URL(L.updatePrefillUrl(FORM, noTitle, vals).url);
  chk("★ 有內容的格子(職稱)沒有 entry → 不帶連結代碼,其他照帶",
      !ntu.searchParams.has("entry.1011") && ![...ntu.searchParams.values()].some(x => x === vals.token) &&
      ntu.searchParams.get("entry.1004") === vals.services && ntu.searchParams.get("entry.1001") === "A1・曾俊凱");
  const noWeb = Object.assign({}, ENT); delete noWeb.website;
  chk("沒有 entry 的格子本來就是空的(網站)→ 代碼照帶(兩邊都記成空白,對得上)",
      new URL(L.updatePrefillUrl(FORM, noWeb, vals).url).searchParams.get("entry.1011") === vals.token);

  // 太長 → 退回只帶名字,而且不帶代碼(格子沒帶入卻帶代碼,Worker 會以為本人清空了每一格)
  const big = Object.assign(MEMBER(), { business_items: "營".repeat(3000) });
  const bv = L.memberPrefillValues("A1", big);
  const b = L.updatePrefillUrl(FORM, ENT, bv);
  const bu = new URL(b.url);
  chk("★ 超過 6000 字 → trimmed", b.trimmed === true, b.url.length);
  chk("★ 退回的版本只帶名字(和 openExternalBrowser)", eq([...bu.searchParams.keys()], ["usp","entry.1001","openExternalBrowser"]) &&
      bu.searchParams.get("entry.1001") === "A1・曾俊凱" && bu.searchParams.get("openExternalBrowser") === "1");
  chk("★ 退回的版本不含 token", !bu.searchParams.has("entry.1011") && b.url.indexOf(bv.token) < 0);
  chk("maxLen 可以指定", L.updatePrefillUrl(FORM, ENT, vals, 100).trimmed === true &&
      L.updatePrefillUrl(FORM, ENT, vals, 100000).trimmed === false);

  /* openExternalBrowser=1:表單要登入 Google(能上傳照片),LINE 內建瀏覽器登不進去,
     帶這個參數 LINE 才會改用手機瀏覽器開。三種結果(完整、退回只帶名字、通用)都要有。 */
  chk("★ 完整預填的連結帶 openExternalBrowser=1(剛好一個)", eq(u.searchParams.getAll("openExternalBrowser"), ["1"]), r.url.slice(-40));
  chk("openExternalBrowser 放在最後", [...u.searchParams.keys()].pop() === "openExternalBrowser");
  const dupe = L.updatePrefillUrl(FORM + "&openExternalBrowser=1", ENT, vals);
  chk("表單網址本來就有 openExternalBrowser → 不會變成兩個", eq(new URL(dupe.url).searchParams.getAll("openExternalBrowser"), ["1"]));
  chk("nameless 的通用連結也帶", new URL(L.updatePrefillUrl(FORM, {}, vals).url).searchParams.get("openExternalBrowser") === "1");
  // 長度判斷把 openExternalBrowser 算進去:上限剛好等於完整連結的長度 → 不退回;少 1 → 退回
  chk("★ 長度判斷包含 openExternalBrowser(上限 = 完整長度 → 不退回;少 1 → 退回)",
      L.updatePrefillUrl(FORM, ENT, vals, r.url.length).trimmed === false &&
      L.updatePrefillUrl(FORM, ENT, vals, r.url.length - 1).trimmed === true, String(r.url.length));
  const tr1 = L.updatePrefillUrl(FORM, ENT, vals, r.url.length - 1);
  chk("退回只帶名字的版本也帶 openExternalBrowser=1,而且不帶代碼",
      new URL(tr1.url).searchParams.get("openExternalBrowser") === "1" && !new URL(tr1.url).searchParams.has("entry.1011"));

  // 實際名錄:每一位都組得出連結,而且名字一定帶得進去(只記錄最長的長度,不設門檻 —— 名錄內容會變)
  let longest = 0, people = 0, labelOk = true;
  for(const f of fs.readdirSync(path.join(ROOT, "data")).filter(x => /^[a-z0-9]+\.json$/.test(x))){
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
    for(const mm of (g.members || [])){
      const code = f.replace(/\.json$/, "").toUpperCase();
      const res = L.updatePrefillUrl(FORM, ENT, L.memberPrefillValues(code, mm));
      people++; longest = Math.max(longest, res.url.length);
      if(new URL(res.url).searchParams.get("entry.1001") !== L.memberUpdateLabel(code, mm.name)) labelOk = false;
    }
  }
  chk(`實際名錄 ${people} 位都組得出帶名字的連結(最長 ${longest} 字)`, people > 0 && labelOk);
}

/* ══ withExternalBrowser ══ */
hr("⑩-2 給夥伴的通用連結加 openExternalBrowser=1(withExternalBrowser)");
{
  const W = L.withExternalBrowser;
  chk("沒有查詢字串 → 加 ?openExternalBrowser=1", W("https://forms.gle/AbC123") === "https://forms.gle/AbC123?openExternalBrowser=1");
  chk("★ 已有參數 → 接在後面,原本的參數一字不改",
      W("https://docs.google.com/forms/d/e/X/viewform?usp=sf_link") === "https://docs.google.com/forms/d/e/X/viewform?usp=sf_link&openExternalBrowser=1");
  const odd = "https://x.test/f?a=%20b&c=d+e&n=%E3%83%BB";
  chk("★ 原本參數的編碼不被重組(%20、+、%E3%83%BB 照舊)", W(odd) === odd + "&openExternalBrowser=1", W(odd));
  chk("有 #hash → 參數加在 # 前面", W("https://x.test/f?a=1#sec") === "https://x.test/f?a=1&openExternalBrowser=1#sec");
  chk("結尾是 ? 或 & → 不多一個分隔字元", W("https://x.test/f?") === "https://x.test/f?openExternalBrowser=1" &&
      W("https://x.test/f?a=1&") === "https://x.test/f?a=1&openExternalBrowser=1");
  const once = W("https://forms.gle/AbC123");
  chk("★ 已經有了 → 原樣回傳(不重複加);連續呼叫兩次結果一樣", W(once) === once && W(W(once)) === once);
  chk("已經有了但值不是 1 → 也不動(尊重原本的設定)", W("https://x.test/f?openExternalBrowser=0") === "https://x.test/f?openExternalBrowser=0");
  chk("http:// 也加", W("http://x.test/f") === "http://x.test/f?openExternalBrowser=1");
  chk("★ 不是 http(s) → 原樣回傳", W("javascript:alert(1)") === "javascript:alert(1)" && W("mailto:a@b.c") === "mailto:a@b.c" &&
      W("line://msg/text/x") === "line://msg/text/x");
  chk("不是網址、空字串 → 原樣回傳", W("請洽組長") === "請洽組長" && W("") === "");
  chk("不是字串 → 原樣回傳", W(null) === null && W(undefined) === undefined && W(123) === 123);
  chk("前後空白會去掉", W("  https://forms.gle/x  ") === "https://forms.gle/x?openExternalBrowser=1");
}

/* ══ memberUpdateHeader ══ */
hr("⑪ 審核卡標頭(memberUpdateHeader)");
{
  const mem = { id:"g3_m9", name:"王大銘", updatedAt:"2026-09-30T00:00:00.000Z" };
  const sat = "2026-10-01T10:00:00.000Z";
  const base = { sat, at:"2026-10-01T10:00:05.000Z" };
  const H = (req, m = mem) => L.memberUpdateHeader(Object.assign({}, base, req), m, "A1", Date.parse(sat) + 3.5 * DAY);

  const ok0 = H({});
  chk("一般送件:沒有警示、不會整筆不勾", ok0.warnings.length === 0 && ok0.info.length === 0 && ok0.allSkip === false && ok0.late === false);
  chk("days 從 sat 算(3.5 天 → 3)", ok0.days === 3, ok0.days);

  const p = H({ pickedLabel:"B2・王大銘" });
  chk("★ pickedLabel 和目前的「代號・姓名」不同 → allSkip", p.allSkip === true);
  chk("警示寫出本人選的和系統改送的", p.warnings.length === 1 && p.warnings[0].indexOf("「B2・王大銘」") >= 0 &&
      p.warnings[0].indexOf("「A1・王大銘」") >= 0 && p.warnings[0].indexOf("請先 LINE 確認是同一個人") >= 0, p.warnings[0]);
  const same = H({ pickedLabel:"A1・王大銘" });
  chk("pickedLabel 和目前標籤相同 → 不警示", same.allSkip === false && same.warnings.length === 0);
  chk("pickedLabel 是空字串 → 不警示", H({ pickedLabel:"" }).allSkip === false);

  const nm = H({ nameMismatch:{ picked:"王大明", current:"王大銘" } });
  chk("★ nameMismatch → allSkip", nm.allSkip === true);
  chk("警示寫出兩個名字與「可能改過名字」", nm.warnings.length === 1 && nm.warnings[0].indexOf("「王大明」") >= 0 &&
      nm.warnings[0].indexOf("「王大銘」") >= 0 && nm.warnings[0].indexOf("可能改過名字") >= 0, nm.warnings[0]);
  chk("nameMismatch 是 null → 不警示", H({ nameMismatch:null }).allSkip === false);
  chk("兩種情況同時發生 → 兩條警示", H({ pickedLabel:"B2・王大明", nameMismatch:{ picked:"王大明", current:"王大銘" } }).warnings.length === 2);

  // 補送:at 比 sat 晚一天
  const late = { at:"2026-10-02T10:00:00.000Z" };
  const changed = H(late, Object.assign({}, mem, { updatedAt:"2026-10-01T12:00:00.000Z" }));
  chk("★ 補送,而且之後網站上改過(updatedAt > sat)→ allSkip", changed.late === true && changed.allSkip === true);
  chk("警示寫出填寫時間與補送時間", changed.warnings.length === 1 &&
      changed.warnings[0].indexOf(L.updateTimeText(sat) + " 填的，" + L.updateTimeText(late.at) + " 才補送進來；") >= 0, changed.warnings[0]);
  const notChanged = H(late);
  chk("★ 補送,但之後沒改過 → 只有 info", notChanged.late === true && notChanged.allSkip === false &&
      notChanged.warnings.length === 0 && notChanged.info.length === 1 && /才補送進來。$/.test(notChanged.info[0]), notChanged.info[0]);
  chk("★ 補送,updatedAt 沒有值 → 當成改過(偏向保守)", H(late, { name:"王大銘", updatedAt:"" }).allSkip === true);
  chk("補送,updatedAt 看不懂 → 當成改過", H(late, { name:"王大銘", updatedAt:"亂碼" }).allSkip === true);
  chk("晚 5 分鐘不算補送", H({ at:"2026-10-01T10:05:00.000Z" }).late === false);
  chk("晚剛好 10 分鐘不算補送", H({ at:"2026-10-01T10:10:00.000Z" }).late === false);
  chk("晚 10 分鐘又 1 秒算補送", H({ at:"2026-10-01T10:10:01.000Z" }).late === true);
  chk("沒有 sat → 用 at,不算補送", L.memberUpdateHeader({ at:"2026-10-02T10:00:00.000Z" }, mem, "A1", Date.now()).late === false);

  const co = H({ confirmOnly:true });
  chk("★ confirmOnly → info「本人確認資料正確」", co.info.indexOf("本人確認資料正確，沒有要修改。") >= 0 && co.allSkip === false);

  chk("updateTimeText 格式是 YYYY/MM/DD HH:mm(當地時間)",
      L.updateTimeText(new Date(2026, 9, 2, 13, 5).toISOString()) === "2026/10/02 13:05");
  chk("updateMonthDay 格式是 M/D", L.updateMonthDay(new Date(2026, 9, 2, 13, 5).toISOString()) === "10/2");
  chk("日期看不懂 → 空字串", L.updateTimeText("x") === "" && L.updateMonthDay(null) === "");
  chk("updateWaitDays:未來或看不懂 → 0", L.updateWaitDays(sat, Date.parse(sat) - DAY) === 0 && L.updateWaitDays("x", Date.now()) === 0);
}

/* ══ memberUpdateRows ══ */
hr("⑫ 差異表與預設勾選(memberUpdateRows)");
{
  const REQ = (changes, extra) => Object.assign({ changes, base:{}, truncated:[], stalePrefill:[], responseId:"2_ABaOnu" }, extra || {});
  const rows = (m, req, newer, allSkip) => L.memberUpdateRows(m, req, newer || new Set(), !!allSkip);
  const row = (m, req, f, newer, allSkip) => rows(m, req, newer, allSkip).find(r => r.field === f);
  const has = (r, s) => !!r && r.warnings.some(w => w.indexOf(s) >= 0);
  const m = MEMBER();

  const all = rows(m, REQ({ tagline:"新標語", company:"雲榮肉品有限公司", services:["冷藏/凍豬肉原料批發"], constructor:"x" }));
  chk("只列 changes 裡的欄位,依 UPDATE_FIELD_ORDER 排", eq(all.map(r => r.field), ["company","services","tagline"]), all.map(r => r.field).join(","));
  chk("白名單以外的鍵(constructor)不會出現", !all.some(r => r.field === "constructor"));

  const co = row(m, REQ({ company:"雲榮肉品有限公司" }), "company");
  chk("★ 文字欄位改了 → replace,沒有警示", co.defaultChoice === "replace" && co.warnings.length === 0 && co.identical === false, JSON.stringify(co.warnings));
  chk("文字欄位的列:kind / label / options / before / after",
      co.kind === "text" && co.label === "所屬公司" && eq(co.options, ["replace","skip"]) && co.before === "" && co.after === "雲榮肉品有限公司");
  const same = row(Object.assign(MEMBER(), { company:"雲榮" }), REQ({ company:" 雲榮 " }), "company");
  chk("★ 文字欄位沒改(只差空白)→ identical、skip、「和網站上目前一樣」",
      same.identical === true && same.defaultChoice === "skip" && eq(same.warnings, ["和網站上目前一樣（不用套用）"]), JSON.stringify(same.warnings));

  // 清單
  const lm = Object.assign(MEMBER(), { services:["A","B","C","D"] });
  const ls = row(lm, REQ({ services:["A","B","E"] }), "services");
  chk("★ 清單逐項標示 kept / removed / added",
      eq(ls.items, [{text:"A",state:"kept"},{text:"B",state:"kept"},{text:"C",state:"removed"},{text:"D",state:"removed"},{text:"E",state:"added"}]),
      JSON.stringify(ls.items));
  chk("★ 至少一項重疊 → replace", ls.defaultChoice === "replace" && ls.warnings.length === 0, JSON.stringify(ls.warnings));
  chk("清單的 options 有「加在原本後面」", ls.kind === "list" && eq(ls.options, ["replace","append","skip"]));
  const few = row(Object.assign(MEMBER(), { services:["A","B","C","D","E"] }), REQ({ services:"A" }), "services");
  chk("★ 換成新的只剩不到一半 → 仍 replace,但加警示", few.defaultChoice === "replace" && has(few, "⚠ 原本 5 項，換成新的只剩 1 項。"), JSON.stringify(few.warnings));
  const none = row(lm, REQ({ services:"新項目一\n新項目二" }), "services");
  chk("★ 完全沒有重疊 → skip + 警示", none.defaultChoice === "skip" && has(none, "沒有任何一項是原本的") && has(none, "原本 4 項"), JSON.stringify(none.warnings));
  const empty = row(m, REQ({ have:"我有國產羊肉爐資源" }), "have");
  chk("★ 目前是空的 → replace", empty.defaultChoice === "replace" && empty.warnings.length === 0);

  // 網站
  const w0 = row(m, REQ({ website:"https://www.abc.com.tw" }), "website");
  chk("★ 網站目前空白 → skip,並帶「新的網址會直接放上公開名錄」警示",
      w0.kind === "website" && w0.defaultChoice === "skip" && has(w0, "新的網址會直接放上公開名錄"), JSON.stringify(w0.warnings));
  const wm = Object.assign(MEMBER(), { website:"https://www.old.com.tw/a" });
  const w1 = row(wm, REQ({ website:"https://new.com.tw/" }), "website");
  chk("★ 網域改變 → skip + 警示(寫出新舊網域)", w1.defaultChoice === "skip" && has(w1, "網域變了（原本 old.com.tw → 新的 new.com.tw）"), JSON.stringify(w1.warnings));
  const w2 = row(Object.assign(MEMBER(), { website:"https://www.abc.com.tw/a" }), REQ({ website:"https://abc.com.tw/b" }), "website");
  chk("★ 同網域不同路徑(含 www 差異)→ replace", w2.defaultChoice === "replace" && w2.warnings.length === 0, JSON.stringify(w2.warnings));

  // 行業／職稱
  const t1 = row(m, REQ({ title:"國產羊肉批發" }), "title");
  chk("★ title 目前有內容 → skip + 警示", t1.defaultChoice === "skip" && has(t1, "行業／職稱是名錄上最顯眼的一行"), JSON.stringify(t1.warnings));
  const t0 = row(Object.assign(MEMBER(), { title:"" }), REQ({ title:"國產羊肉批發" }), "title");
  chk("★ title 目前空白 → replace", t0.defaultChoice === "replace" && t0.warnings.length === 0);

  // 截斷、連結過期、較新那筆、allSkip
  const tr = row(m, REQ({ business_items:"營".repeat(400) }, { truncated:[{ field:"business_items", total:612, kept:400, unit:"字" }] }), "business_items");
  chk("★ truncated → skip,警示寫出字數與回應 ID", tr.defaultChoice === "skip" &&
      has(tr, "⚠ 夥伴寫了 612 字，只收進前 400 字，完整內容在回應試算表（回應 ID 2_ABaOnu）"), JSON.stringify(tr.warnings));
  const st = row(m, REQ({ company:"新公司" }, { stalePrefill:["company"] }), "company");
  chk("★ stalePrefill → skip + 警示", st.defaultChoice === "skip" && has(st, "看著舊內容改的"), JSON.stringify(st.warnings));
  const both = row(m, REQ({ company:"新公司" }, { stalePrefill:["company"], truncated:[{ field:"company", total:130, kept:120, unit:"字" }] }), "company");
  chk("同一列可以同時有好幾條警示", both.defaultChoice === "skip" && both.warnings.length === 2, JSON.stringify(both.warnings));
  const nw = row(m, REQ({ company:"新公司" }), "company", new Set(["company"]));
  chk("★ newerFields → skip + 「後面那筆較新的更新也改了這一欄」", nw.defaultChoice === "skip" && has(nw, "後面那筆較新的更新也改了這一欄"));
  chk("newerFields 沒有這一欄 → 不受影響", row(m, REQ({ company:"新公司" }), "company", new Set(["services"])).defaultChoice === "replace");

  const sk = rows(m, REQ({ company:"新公司", have:"我有資源", services:["冷藏/凍豬肉原料批發","新的一項"], website:"https://abc.com.tw" }), new Set(), true);
  chk("★ allSkip → 每一列都 skip", sk.length === 4 && sk.every(r => r.defaultChoice === "skip"), sk.map(r => r.field + ":" + r.defaultChoice).join(","));
  chk("allSkip 的警示寫在標頭,列上不重複(公司那列沒有警示)", sk.find(r => r.field === "company").warnings.length === 0);
  chk("allSkip 時仍保留欄位本身的提醒(新網址)", has(sk.find(r => r.field === "website"), "新的網址會直接放上公開名錄"));
  const idAll = row(Object.assign(MEMBER(), { company:"雲榮" }), REQ({ company:"雲榮" }), "company", new Set(), true);
  chk("allSkip 又和目前一樣 → 只顯示「和網站上目前一樣」", eq(idAll.warnings, ["和網站上目前一樣（不用套用）"]));

  // base:本人送出後這一欄被改過
  const cm = Object.assign(MEMBER(), { company:"舊公司" });
  const cs = row(cm, REQ({ company:"新公司" }, { base:{ company:"" } }), "company");
  chk("★ base 和目前不同 → changedSinceSubmit + 警示", cs.changedSinceSubmit === true && has(cs, "⚠ 本人送出後，這一欄被改過（他送出時是：（空白））。"), JSON.stringify(cs.warnings));
  chk("changedSinceSubmit 不影響預設值", cs.defaultChoice === "replace");
  const cl = row(Object.assign(MEMBER(), { services:["A","B","C"] }), REQ({ services:["A","B","D"] }, { base:{ services:["A","B"] } }), "services");
  chk("清單的 base 用「、」串起來顯示", cl.changedSinceSubmit === true && has(cl, "（他送出時是：A、B）"), JSON.stringify(cl.warnings));
  const nc = row(cm, REQ({ company:"新公司" }, { base:{ company:" 舊公司 " } }), "company");
  chk("base 和目前一樣(正規化後)→ 沒有 changedSinceSubmit", nc.changedSinceSubmit === false && nc.warnings.length === 0);
  chk("沒有 base → 沒有 changedSinceSubmit", row(cm, REQ({ company:"新公司" }), "company").changedSinceSubmit === false);
  chk("沒有 changes → 空陣列", eq(L.memberUpdateRows(m, { confirmOnly:true }, new Set(), false), []));
}

/* ══ memberUpdateExtras ══ */
hr("⑬ 系統註記(memberUpdateExtras)");
{
  const req = {
    untouched:["title","company"], cleared:[{ field:"want" }],
    truncated:[{ field:"business_items", total:612, kept:400, unit:"字" }],
    ignored:[{ field:"tagline", value:"同上" }], invalid:[{ field:"website", value:"雲榮肉品官網" }],
  };
  const x = L.memberUpdateExtras(req, Object.assign(MEMBER(), { want:["羊肉特色小吃店","肉舖"] }));
  chk("★ untouched 換成欄位名稱,依表單順序", eq(x.untouched, ["所屬公司","行業／職稱"]), JSON.stringify(x.untouched));
  chk("★ cleared 帶網站上目前的內容", eq(x.cleared, [{ label:"我要…", current:"羊肉特色小吃店、肉舖" }]), JSON.stringify(x.cleared));
  chk("★ truncated 的標籤與數字", eq(x.truncated, [{ label:"主要營業項目", total:612, kept:400, unit:"字" }]), JSON.stringify(x.truncated));
  chk("ignored 帶原文", eq(x.ignored, [{ label:"25 秒自我介紹 Slogan", value:"同上" }]));
  chk("invalid 帶原文", eq(x.invalid, [{ label:"公司網站", value:"雲榮肉品官網" }]));
  chk("cleared 但網站上已經是空的 → current 寫「（空白）」",
      L.memberUpdateExtras({ cleared:[{ field:"have" }] }, MEMBER()).cleared[0].current === "（空白）");
  chk("空的請求 → 全部是空陣列", eq(L.memberUpdateExtras({}, null), { ignored:[], invalid:[], untouched:[], cleared:[], truncated:[] }));
  chk("原型上的鍵不會查到 Object.prototype", L.memberUpdateExtras({ untouched:["constructor"] }, {}).untouched[0] === "constructor");
}

/* ══ listDiff / mergeList / websiteHost ══ */
hr("⑭ 清單合併與網域(listDiff、mergeList、websiteHost)");
{
  chk("listDiff:原本空的 → 全是 added", eq(L.listDiff([], ["A"]), [{ text:"A", state:"added" }]));
  chk("listDiff:新的空的 → 全是 removed", eq(L.listDiff(["A"], ""), [{ text:"A", state:"removed" }]));
  chk("listDiff 接受換行字串", eq(L.listDiff("A\nB", "B\r\nC").map(x => x.state), ["removed","kept","added"]));

  chk("★ mergeList 去重(舊 2 項 + 新 2 項其中 1 項重複 → 3 項)", eq(L.mergeList(["A","B"], ["B","C"]), { items:["A","B","C"], dropped:0 }));
  chk("mergeList:新清單裡自己重複的也只加一次", eq(L.mergeList(["A"], ["B","B"]).items, ["A","B"]));
  chk("mergeList 比對前先正規化(前後空白)", eq(L.mergeList(["A"], [" A ", "B"]).items, ["A","B"]));
  const ten = Array.from({ length: 10 }, (_, i) => "舊" + i);
  const mg = L.mergeList(ten, ["新1","新2","新3","新4","新5"]);
  chk("★ mergeList 截到 12 項,回報被截掉幾項", mg.items.length === 12 && mg.dropped === 3 && mg.items[11] === "新2", JSON.stringify(mg));
  chk("mergeList 的上限可以指定", eq(L.mergeList(["A","B"], ["C"], 2), { items:["A","B"], dropped:1 }));
  chk("mergeList 接受換行字串", eq(L.mergeList("A\nB", "C").items, ["A","B","C"]));

  chk("websiteHost:小寫、去掉 www.", L.websiteHost("https://WWW.Example.COM/path?q=1") === "example.com");
  chk("websiteHost:有 port 也只取主機", L.websiteHost("http://www.abc.com.tw:8080/x") === "abc.com.tw");
  chk("websiteHost:只去掉開頭的 www.", L.websiteHost("https://shop.www.abc.com") === "shop.www.abc.com");
  chk("websiteHost:解析失敗 → \"\"", L.websiteHost("雲榮肉品官網") === "" && L.websiteHost("") === "" && L.websiteHost(null) === "");
}

/* ══ memberUpdateNotice ══ */
hr("⑮ 審核區提醒(memberUpdateNotice)");
{
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  const ago = d => new Date(now - d * DAY).toISOString();
  const N = o => L.memberUpdateNotice(Object.assign({ max:100, oldestName:"曾俊凱" }, o), now);
  chk("0 筆 → 不提醒", N({ count:0, openAll:0, oldestAt:null }) === null);
  const full = N({ count:5, openAll:100, oldestAt:ago(1) });
  chk("★ 已滿 → danger", !!full && full.level === "danger" && full.text.indexOf("（100/100）") >= 0, full && full.text);
  const near = N({ count:5, openAll:80, oldestAt:ago(1) });
  chk("★ 80% → warn「快滿了」", !!near && near.level === "warn" && near.text.indexOf("快滿了（80/100）") >= 0, near && near.text);
  chk("79 筆還不算快滿", (N({ count:5, openAll:79, oldestAt:ago(1) }) || {}).level === "info");
  chk("★ 組長自己組 0 筆、全分會快滿 → 仍然警示", (N({ count:0, openAll:95, oldestAt:null }) || {}).level === "warn");
  const old = N({ count:2, openAll:2, oldestAt:ago(7.2) });
  chk("★ 最舊一筆 ≥ 7 天 → warn,寫出姓名與天數", !!old && old.level === "warn" &&
      old.text === "「曾俊凱」的資料更新已經等了 7 天，請盡快審核。", old && old.text);
  const six = N({ count:2, openAll:2, oldestAt:ago(6.9) });
  chk("★ 6 天 → info,帶「最久的已等 6 天」", !!six && six.level === "info" &&
      six.text === "有 2 筆夥伴資料更新等待審核（最久的已等 6 天）", six && six.text);
  const one = N({ count:1, openAll:1, oldestAt:ago(0.5) });
  chk("★ 1 筆、未滿 1 天 → info,不寫天數", !!one && one.level === "info" && one.text === "有 1 筆夥伴資料更新等待審核", one && one.text);
  chk("沒給 max → 預設 100", (L.memberUpdateNotice({ count:1, openAll:100, oldestAt:ago(0) }, now) || {}).level === "danger");
  chk("沒給 openAll → 用 count", (L.memberUpdateNotice({ count:100, max:100, oldestAt:ago(0) }, now) || {}).level === "danger");

  // ★ 天數用 sat 算:補送的那筆收件才 1 天,但其實 8 天前就填了
  const cards = L.groupMemberUpdates([{ uid:"u_late01", memberId:"g3_m1", name:"曾俊凱", sat:ago(8), at:ago(1) }]);
  const viaSat = L.memberUpdateNotice({ count:1, openAll:1, max:100, oldestAt:cards[0].oldestAt, oldestName:cards[0].name }, now);
  chk("★ 天數從 sat 算(補送的那筆收件 1 天、填寫 8 天 → 8 天)", !!viaSat && viaSat.level === "warn" && viaSat.text.indexOf("等了 8 天") >= 0, viaSat && viaSat.text);
}

/* ══ groupMemberUpdates ══ */
hr("⑯ 每位夥伴一張卡(groupMemberUpdates)");
{
  const items = [
    { uid:"u_aaaaa1", memberId:"g3_m1", name:"曾俊凱", code:"A1", groupName:"肉品海鮮批發組", gid:"g3",
      sat:"2026-10-02T10:00:00.000Z", at:"2026-10-02T10:00:03.000Z" },
    { uid:"u_bbbbb2", memberId:"g4_m2", name:"王大明", code:"B2", groupName:"蔬果點心供應組", gid:"g4",
      sat:"2026-10-01T09:00:00.000Z", at:"2026-10-02T11:00:00.000Z" },                // 補送:收得晚、填得早
    { uid:"u_ccccc3", memberId:"g3_m1", name:"曾俊凱", code:"A1", groupName:"肉品海鮮批發組", gid:"g3",
      sat:"2026-10-01T12:00:00.000Z", at:"2026-10-02T12:00:00.000Z" },                // 收得比 u_aaaaa1 晚,但填得早
  ];
  const cards = L.groupMemberUpdates(items);
  chk("同一位夥伴合成一張卡", cards.length === 2);
  chk("★ 卡片依最舊的 sat 由舊到新(補送的那位排第一)", eq(cards.map(c => c.memberId), ["g4_m2","g3_m1"]));
  chk("★ 卡內依 sat 由舊到新(先收到但 sat 較晚的排後面)", eq(cards[1].items.map(i => i.uid), ["u_ccccc3","u_aaaaa1"]));
  chk("oldestAt 是最舊那筆的 sat", cards[1].oldestAt === "2026-10-01T12:00:00.000Z");
  chk("卡片帶 name / code / groupName", cards[1].name === "曾俊凱" && cards[1].code === "A1" && cards[1].groupName === "肉品海鮮批發組");
  chk("沒有 sat → 用 at 排", eq(L.groupMemberUpdates([
    { uid:"u_x00001", memberId:"a", at:"2026-10-03T00:00:00.000Z" },
    { uid:"u_x00002", memberId:"b", sat:"2026-10-02T00:00:00.000Z", at:"2026-10-04T00:00:00.000Z" },
  ]).map(c => c.memberId), ["b","a"]));
  chk("空的或格式不對 → 空陣列", eq(L.groupMemberUpdates(null), []) && eq(L.groupMemberUpdates([null, 1]), []));
}

/* ══ findMembersByName / memberUpdateCopyText ══ */
hr("⑰ 找同名夥伴與轉抄文字(findMembersByName、memberUpdateCopyText)");
{
  const groups = [
    { code:"A1", name:"肉品海鮮批發組", members:[{ id:"g3_m1", name:"曾俊凱" }] },
    { code:"B2", name:"蔬果點心供應組", members:[{ id:"g5_m3", name:"曾 俊凱" }, { id:"g5_m4", name:"王大明" }] },
  ];
  const found = L.findMembersByName(groups, "曾俊凱");
  chk("★ 跨組找到,去掉空白後比對", eq(found, [
    { code:"A1", groupName:"肉品海鮮批發組", memberId:"g3_m1", name:"曾俊凱" },
    { code:"B2", groupName:"蔬果點心供應組", memberId:"g5_m3", name:"曾 俊凱" }]), JSON.stringify(found));
  chk("查詢的名字也去掉空白", L.findMembersByName(groups, " 王 大明 ").length === 1);
  chk("完全比對,不做部分比對", eq(L.findMembersByName(groups, "曾俊"), []));
  chk("空名字 → 空陣列", eq(L.findMembersByName(groups, ""), []) && eq(L.findMembersByName(null, "曾俊凱"), []));

  const sat = "2026-10-02T05:14:41.000Z";
  const req = { label:"A1・曾俊凱", sat, at:sat, note:"請刪掉我的公司網站",
                changes:{ services:["冷藏/凍豬肉原料批發","豬肉餡"], company:"雲榮肉品有限公司" } };
  const txt = L.memberUpdateCopyText(req);
  const lines = txt.split("\n");
  chk("★ 第一行是「{label} 在 {M/D} 送來的資料更新」", lines[0] === "A1・曾俊凱 在 " + L.updateMonthDay(sat) + " 送來的資料更新", lines[0]);
  chk("文字欄位一行", lines.indexOf("【所屬公司】雲榮肉品有限公司") > 0);
  chk("★ 清單逐項列出", lines.indexOf("【服務項目】") > 0 && lines.indexOf("・冷藏/凍豬肉原料批發") > lines.indexOf("【服務項目】") &&
      lines.indexOf("・豬肉餡") > lines.indexOf("・冷藏/凍豬肉原料批發"), txt);
  chk("欄位依表單順序(公司在服務項目前面)", lines.indexOf("【所屬公司】雲榮肉品有限公司") < lines.indexOf("【服務項目】"));
  chk("★ 含備註", lines[lines.length - 1] === "【給組長的備註】請刪掉我的公司網站", lines[lines.length - 1]);
  chk("沒有 label → 用代號與姓名組", L.memberUpdateCopyText({ code:"A1", name:"曾俊凱", sat, changes:{} }).startsWith("A1・曾俊凱 在 "));
  chk("confirmOnly 寫明本人確認", L.memberUpdateCopyText({ label:"A1・曾俊凱", sat, changes:{}, confirmOnly:true }).indexOf("本人確認資料正確") > 0);
}

/* ══ overwrittenMemberUpdates ══
   套用是伺服器端直接寫進組檔;另一台裝置的舊草稿一發布,就會把夥伴的更新蓋回舊內容,
   而那筆待審核早就刪了、找不回來(乙 4)。衝突 confirm 要能說出「誰的更新會被蓋掉」。 */
hr("⑱ 草稿會蓋掉已套用的夥伴更新(overwrittenMemberUpdates)");
{
  const live = { members:[
    { id:"g3_m1", name:"曾俊凱", lastUpdateFrom:"u_aaa111" },
    { id:"g3_m2", name:"王大明", lastUpdateFrom:"u_bbb222" },
    { id:"g3_m3", name:"林小華", lastUpdateFrom:"u_ccc333" },
    { id:"g3_m4", name:"陳一", lastUpdateFrom:"" },
  ] };
  const draft = { members:[
    { id:"g3_m1", name:"曾俊凱" },
    { id:"g3_m2", name:"王大明", lastUpdateFrom:"u_bbb222" },
    { id:"g3_m4", name:"陳一" },
  ] };
  chk("★ live 有 lastUpdateFrom、draft 沒有 → 回傳姓名;相同的不回;draft 刪掉的不回",
      eq(L.overwrittenMemberUpdates(live, draft), ["曾俊凱"]), JSON.stringify(L.overwrittenMemberUpdates(live, draft)));
  const draft2 = { members:[{ id:"g3_m2", name:"王大明", lastUpdateFrom:"u_old000" }] };
  chk("★ draft 的 lastUpdateFrom 是另一個 uid → 回傳", eq(L.overwrittenMemberUpdates(live, draft2), ["王大明"]));
  chk("兩邊都沒有 lastUpdateFrom → 不回", eq(L.overwrittenMemberUpdates({ members:[{ id:"x", name:"甲" }] }, { members:[{ id:"x", name:"甲" }] }), []));
  chk("群組是 null → 空陣列", eq(L.overwrittenMemberUpdates(null, draft), []) && eq(L.overwrittenMemberUpdates(live, null), []));
}

/* ══ 後台 ↔ Worker 的錯誤碼 ══
   審核區的訊息是照規格的錯誤表寫的,Worker 是照規格的步驟寫的;兩邊各自補了規格沒寫到的碼時
   (例如 Worker 在查看、不採用也回 group_renamed),後台只會顯示「沒有成功（group_renamed）」。
   這裡從 Worker 原始碼抓出每支審核端點會回的 409/403 錯誤碼 —— 那些都是「人要照著做」的情況
   (被別人處理掉、正在處理、沒有權限、代號被改) —— 確認後台對應的函式都有專屬訊息。 */
hr("⑲ 後台 ↔ Worker:審核端點會回的 409/403 錯誤碼,後台都有專屬訊息");
{
  const wsrc = fs.readFileSync(path.join(ROOT, "worker/publish-relay.js"), "utf8");
  const asrc = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
  const fnSrc = (s, name) => {
    const m = new RegExp("^([ \\t]*)(?:async )?function " + name + "\\([\\s\\S]*?\\n\\1\\}", "m").exec(s);
    return m ? m[0] : "";
  };
  const humanCodes = names => {
    const out = new Set();
    for(const n of names){
      for(const m of fnSrc(wsrc, n).matchAll(/error:\s*"([a-z_]+)"[^;]*?\},\s*(40[39])\)/g)) out.add(m[1]);
    }
    out.delete("read_only");                 // 唯讀帳號整塊看不到,一個請求都不會送
    return [...out];
  };
  // 查看、套用、不採用的組長檢查都走這兩支
  const LEADER = ["memberUpdateAuth", "leaderGroupDenied"];
  const PAIRS = [
    ["/member-updates",           ["handleMemberUpdates", "memberUpdateAuth"],         ["loadMemberUpdatesOnce", "renderMemberUpdates"]],
    ["/member-update-get",        ["handleMemberUpdateGet", ...LEADER],       ["mupdToggle"]],
    ["/member-update-apply",      ["handleMemberUpdateApply", ...LEADER],     ["mupdApply"]],
    ["/member-update-drop",       ["handleMemberUpdateDrop", ...LEADER],      ["mupdDrop"]],
    ["/member-update-drop-batch", ["handleMemberUpdateDropBatch"],            ["mupdBatchDrop"]],
  ];
  for(const [ep, wfns, afns] of PAIRS){
    const codes = humanCodes(wfns);
    const abody = afns.map(n => fnSrc(asrc, n)).join("\n");
    const missing = codes.filter(c => abody.indexOf('"' + c + '"') < 0);
    chk("★ " + ep + ":" + (codes.join("、") || "(沒有)") + " 都有專屬訊息",
        abody.length > 200 && codes.length > 0 && !missing.length, missing.length ? "缺 " + missing.join("、") : "");
  }
  chk("★ 查看與不採用:Worker 的組長檢查會回 group_renamed(與清單、發布同一個碼)",
      humanCodes(["leaderGroupDenied"]).indexOf("group_renamed") >= 0);
}

/* ══ 後台審核區的兩個時序漏洞 ══
   admin.js 是瀏覽器裡的 IIFE,這裡把相關函式**原樣**從原始碼切出來,放進 vm 跑;
   DOM、網路、載入資料換成假的。要守住的是:
     (a) 套用、重新整理把伺服器端寫入後的線上資料讀進來之後,「上一步」不能回到寫入之前 ——
         否則再按發布(版本基準已是新值,不會 stale_base、也不跳衝突提示)會把已套用的夥伴更新無聲蓋回去;
     (b) 套用／不採用成功的當下就把那筆從畫面拿掉,不等清單重抓 —— 否則按鈕解鎖後舊卡還在,
         再按一次只拿到「已經被別人處理掉了」,還蓋掉帶「複製給本人的訊息」的成功 toast。 */
hr("⑳ 審核區:套用／重新整理之後不能復原到寫入之前;處理掉的那筆當下就從畫面拿掉");
{
  const asrc = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
  const fnSrc = (s, name) => {
    const m = new RegExp("^([ \\t]*)(?:async )?function " + name + "\\([\\s\\S]*?\\n\\1\\}", "m").exec(s);
    return m ? m[0] : "";
  };
  const constSrc = (s, name) => (new RegExp("^[ \\t]*const " + name + " = [^\\n]*;$", "m").exec(s) || [""])[0];
  const FNS = ["updateHistoryButtons", "resetHistory", "undo", "findMemberById", "mupdRawValue",
               "mupdForget", "mupdApply", "mupdReloadData", "mupdReloadAll", "mupdDrop", "mupdBatchDrop"];
  const CONSTS = ["snapshot", "restore", "mupdCode", "mupdKey", "mupdCardBusy", "mupdLabel"];
  const missing = FNS.filter(n => !fnSrc(asrc, n)).concat(CONSTS.filter(n => !constSrc(asrc, n)));
  chk("admin.js 切得出要測的函式", !missing.length, missing.length ? "缺 " + missing.join("、") : "");

  const M1 = (company, extra = {}) => Object.assign({ id:"g3_m1", name:"曾俊凱", company }, extra);
  const OLD = () => [{ id:"g3", code:"A1", members:[ M1(""), { id:"g3_m3", name:"李小華", company:"組長自己改的" } ] }];
  const LIVE = () => [{ id:"g3", code:"A1", members:[ M1("夥伴自己填的公司", { lastUpdateFrom:"u_aaaaaa1" }),
                                                     { id:"g3_m3", name:"李小華", company:"組長自己改的" } ] }];
  const it = (uid, memberId, sat) => ({ uid, memberId, name:"x", code:"A1", sat, at:sat });

  /* 每個情境一個乾淨的 vm。o.unpublished:有未發布的修改;o.loadFails:重讀失敗(DATA 沒換);
     o.api:假 Worker 的回應;o.slowList:清單重抓不回來 */
  function makeCtx(o = {}){
    const btn = { undo:{ disabled:false, title:"" }, redo:{ disabled:false, title:"" } };
    const log = [];
    const c = {
      DATA: OLD(), PENDING: [], selected: "g3",
      undoStack: [], redoStack: [], pendingSnap: null,
      mupdList: null, mupdOpen: new Set(), mupdReqs: new Map(), mupdChecked: new Set(), mupdCards: [],
      mupdAfter: null, mupdLast: Promise.resolve(), MUPD_BATCH_MAX: 100,
      MUPD_APPLY_OFF: "off", MUPD_GROUP_RENAMED: "renamed",
      AdminLogic: L, SITE: { SITE_BASE: "https://example.test/" },
      byId: id => id === "btn-undo" ? btn.undo : id === "btn-redo" ? btn.redo : null,
      clone: x => JSON.parse(JSON.stringify(x)),
      isViewer: () => false, isLeader: () => false, hasUnpublishedChanges: () => !!o.unpublished,
      fixSelected(){}, renderAll(){}, validate(){}, saveDraft(){}, renderMupdAfter(){}, copyWithToast(){},
      // 新照片預覽的 blob URL 撤銷:記下撤了哪幾筆(null = 全部)
      revokeMupdPhotos: uids => log.push({ t:"revoke", uids: uids == null ? null : [...(typeof uids === "string" ? [uids] : uids)] }),
      confirm: () => true, mupdReady: async () => true, mupdSession: () => ({ token:"t" }), mupdSessionExpired: () => false,
      mupdReadChoices: () => ({ company:"replace" }),
      nameOnlyUpdateLink: () => "https://form.test/",
      toast: (msg, opts) => log.push({ t:"toast", msg, opts: opts || {} }),
      mupdToastLater: msg => log.push({ t:"later", msg }),
      /* 清單重抓。slowList:故意永遠不回來(手機上很慢)—— 成功分支不能靠它把舊卡拿掉。
         (這支檔案整段只跑 microtask,不要 await 永遠不回來的 promise。) */
      refreshMemberUpdates: () => { log.push({ t:"refresh" }); return o.slowList ? new Promise(() => {}) : Promise.resolve(); },
      renderMemberUpdates: () => log.push({ t:"render", uids: (c.mupdList && c.mupdList.items || []).map(x => x.uid),
                                            after: !!c.mupdAfter }),
      loadData: async () => { log.push({ t:"load" }); if(o.loadFails) throw new Error("read_failed"); c.DATA = LIVE(); },
      workerFetch: async (p, body) => { log.push({ t:"api", p, body }); return o.api ? o.api(p, body) : { ok:true }; },
    };
    vm.createContext(c);
    vm.runInContext(CONSTS.map(n => constSrc(asrc, n)).join("\n") + "\n" + FNS.map(n => fnSrc(asrc, n)).join("\n"), c,
                    { filename: "admin.js(切片)" });
    c.log = log; c.btn = btn;
    return c;
  }
  const company = c => c.DATA[0].members.find(m => m.id === "g3_m1").company;
  const seedHistory = c => { c.undoStack = [ { data: OLD(), pending: [] } ]; c.redoStack = [ { data: OLD(), pending: [] } ];
                             c.pendingSnap = { data: OLD(), pending: [] }; };
  const cleared = c => c.undoStack.length === 0 && c.redoStack.length === 0 && c.pendingSnap === null && c.btn.undo.disabled === true;
  const view = (req) => ({ req, member: OLD()[0].members[0], rows:[{ field:"company", label:"所屬公司" }],
                           group:{ code:"A1" }, orphan:false });
  const el = { querySelector: () => null };
  const REQ = (o = {}) => Object.assign({ uid:"u_aaaaaa1", memberId:"g3_m1", name:"曾俊凱", code:"A1",
                                          sat:"2026-09-30T02:00:00.000Z", note:"", cleared:[] }, o);

  /* (a) 復原歷史 */
  {
    const c = makeCtx({ api: () => ({ ok:true, memberId:"g3_m1", applied:["company"], warnings:[] }) });
    seedHistory(c);
    await c.mupdApply(el, view(REQ()));
    chk("★ 套用成功、重讀線上資料之後:上一步／重做清空,「上一步」按鈕停用", cleared(c),
        `undo=${c.undoStack.length} redo=${c.redoStack.length} btn=${c.btn.undo.disabled}`);
    c.undo();
    chk("★ 套用之後按「上一步」不會把夥伴的更新改回套用前", company(c) === "夥伴自己填的公司", JSON.stringify(company(c)));
  }
  {
    const c = makeCtx(); seedHistory(c);
    await c.mupdReloadAll();
    chk("★ 審核區「重新整理」(沒有未發布的修改)重讀資料後清空復原歷史", cleared(c) && company(c) === "夥伴自己填的公司");
  }
  {
    const c = makeCtx({ unpublished:true }); seedHistory(c);
    await c.mupdReloadAll();
    chk("有未發布的修改時「重新整理」只抓清單:不重讀資料、復原歷史保留",
        c.undoStack.length === 1 && !c.log.some(x => x.t === "load"));
  }
  {
    const c = makeCtx({ loadFails:true }); seedHistory(c);
    await c.mupdReloadAll();
    chk("重讀失敗(DATA 沒換)→ 復原歷史保留", c.undoStack.length === 1 && company(c) === "");
  }
  {
    const c = makeCtx(); seedHistory(c);
    await c.mupdReloadData();
    chk("★ member_changed／member_missing 之後的重讀也清空復原歷史", cleared(c));
    const f = makeCtx({ loadFails:true }); seedHistory(f);
    await f.mupdReloadData();
    chk("mupdReloadData 重讀失敗 → 復原歷史保留", f.undoStack.length === 1);
  }

  /* (b) 處理掉的那筆當下就從畫面拿掉 */
  const LIST = () => ({ ok:true, max:100, openAll:4, items:[ it("u_aaaaaa1", "g3_m1", "2026-09-30T02:00:00.000Z"),
    it("u_bbbbbb2", "g3_m1", "2026-09-30T03:00:00.000Z"), it("u_cccccc3", "g3_m9", "2026-09-30T04:00:00.000Z"),
    it("u_dddddd4", "g3_m2", "2026-09-30T05:00:00.000Z") ] });
  {
    const c = makeCtx({ slowList:true, api: () => ({ ok:true, memberId:"g3_m1", applied:["company"], warnings:[] }) });
    c.mupdList = LIST(); c.mupdOpen.add("u_aaaaaa1"); c.mupdReqs.set("u_aaaaaa1", REQ());
    await c.mupdApply(el, view(REQ({ note:"請刪掉我的網站" })));
    const r = c.log.filter(x => x.t === "render").pop();
    const api = c.log.findIndex(x => x.t === "api");
    const rIdx = c.log.lastIndexOf(r);
    chk("★ 套用成功:清單還沒重抓回來,這筆就已經從畫面拿掉(同一位的下一筆接上)",
        !!r && rIdx > api && eq(r.uids, ["u_bbbbbb2", "u_cccccc3", "u_dddddd4"]) &&
        !c.mupdOpen.has("u_aaaaaa1") && !c.mupdReqs.has("u_aaaaaa1"), r ? JSON.stringify(r.uids) : "沒有重畫");
    chk("★ 套用成功:重畫時備註提醒已經設好(最後一筆被拿掉時整塊才不會藏起來)", !!r && r.after === true);
    chk("套用成功:openAll 跟著減掉", c.mupdList.openAll === 3, String(c.mupdList.openAll));
    const toasts = c.log.filter(x => x.t === "toast");
    chk("套用成功:最後一則 toast 是帶「複製給本人的訊息」的成功訊息",
        toasts.length && toasts[toasts.length - 1].opts.actionLabel === "複製給本人的訊息");
    chk("★ 套用成功:這筆的新照片預覽(blob URL)一起撤掉",
        c.log.some(x => x.t === "revoke" && Array.isArray(x.uids) && eq(x.uids, ["u_aaaaaa1"])), JSON.stringify(c.log.filter(x => x.t === "revoke")));
  }
  {
    const c = makeCtx({ slowList:true, api: () => ({ ok:true }) });
    c.mupdList = LIST(); c.mupdOpen.add("u_cccccc3");
    const req = REQ({ uid:"u_cccccc3", memberId:"g3_m9", name:"王大銘" });
    await c.mupdDrop({ req }, { code:"A1" }, "reject", "公司名稱打錯");
    const r = c.log.filter(x => x.t === "render").pop();
    chk("★ 不採用成功:清單還沒重抓回來,這筆就已經從畫面拿掉",
        !!r && eq(r.uids, ["u_aaaaaa1", "u_bbbbbb2", "u_dddddd4"]) && !c.mupdOpen.has("u_cccccc3"), r ? JSON.stringify(r.uids) : "沒有重畫");
    const toasts = c.log.filter(x => x.t === "toast");
    chk("不採用成功:最後一則 toast 帶「複製給本人的訊息」",
        toasts.length && toasts[toasts.length - 1].opts.actionLabel === "複製給本人的訊息");
    chk("★ 不採用成功:這筆的新照片預覽一起撤掉", c.log.some(x => x.t === "revoke" && eq(x.uids, ["u_cccccc3"])));
  }
  {
    const c = makeCtx({ slowList:true, api: () => ({ ok:true, dropped:2, skipped:["u_bbbbbb2"] }) });
    c.mupdList = LIST();
    c.mupdCards = L.groupMemberUpdates(c.mupdList.items);
    const key = vm.runInContext("mupdKey", c);
    c.mupdCards.forEach(card => { if(card.memberId !== "g3_m2") c.mupdChecked.add(key(card)); });
    await c.mupdBatchDrop();
    const r = c.log.filter(x => x.t === "render").pop();
    chk("批次不採用成功:刪掉的當下就拿掉,正在處理中(skipped)的留著",
        !!r && eq(r.uids, ["u_bbbbbb2", "u_dddddd4"]), r ? JSON.stringify(r.uids) : "沒有重畫");
  }

  /* (c) 照片欄位的 choices / expect。Worker 會檢查 expect 的型別:形象照、名片是字串
     (沒有照片是 ""),商品照是字串陣列 —— 成員卡上沒有 products 時送 "" 會被整筆打回 bad_choice。
     沒勾的欄位不送 expect(和文字欄位同一個規則)。 */
  const PHOTO_ROWS = () => [
    { field:"company", label:"所屬公司", kind:"text" },
    { field:"image", label:"形象照", kind:"photo", before:[] },
    { field:"card", label:"名片照片", kind:"photo", before:["g3_m1_card_old.jpg"] },
    { field:"products", label:"商品照片", kind:"photo", before:["p1.jpg"] },
  ];
  const photoView = member => ({ req: REQ(), member, group:{ code:"A1" }, orphan:false, rows: PHOTO_ROWS() });
  {
    const c = makeCtx({ api: () => ({ ok:true, memberId:"g3_m1", applied:["image","card","products"], warnings:[] }) });
    c.mupdReadChoices = () => ({ company:"skip", image:"replace", card:"replace", products:"append" });
    let asked = "";
    c.confirm = msg => { asked = msg; return true; };
    // 沒有形象照(欄位不存在)、名片有、商品照裡混了一個非字串
    await c.mupdApply(el, photoView(M1("", { card:"g3_m1_card_old.jpg", products:["p1.jpg", 7] })));
    const api = c.log.find(x => x.t === "api" && x.p === "/member-update-apply");
    chk("★ choices 原樣送出(含照片欄位)", !!api && eq(api.body.choices, { company:"skip", image:"replace", card:"replace", products:"append" }),
        api && JSON.stringify(api.body.choices));
    chk("★ expect:形象照沒有 → \"\"、名片 → 檔名字串、商品照 → 字串陣列;沒勾的欄位不送",
        !!api && eq(api.body.expect, { image:"", card:"g3_m1_card_old.jpg", products:["p1.jpg"] }), api && JSON.stringify(api.body.expect));
    chk("★ confirm 寫出照片怎麼套用(新增／換成新的／加在原本後面)",
        asked.indexOf("會更新：形象照（新增）、名片照片（換成新的）、商品照片（加在原本後面）") >= 0 && asked.indexOf("不套用：所屬公司") >= 0, asked);
  }
  {
    const c = makeCtx({ api: () => ({ ok:true, memberId:"g3_m1", applied:["products"], warnings:[] }) });
    c.mupdReadChoices = () => ({ company:"replace", image:"skip", card:"skip", products:"replace" });
    let asked = "";
    c.confirm = msg => { asked = msg; return true; };
    await c.mupdApply(el, photoView(M1("")));
    const api = c.log.find(x => x.t === "api" && x.p === "/member-update-apply");
    chk("★ 成員卡上沒有 products → expect.products 是 [](不是 \"\")", !!api && eq(api.body.expect, { company:"", products:[] }),
        api && JSON.stringify(api.body.expect));
    chk("confirm:商品照整組換掉寫「整組換成新的」,沒勾的照片列在「不套用」",
        asked.indexOf("商品照片（整組換成新的）") >= 0 && asked.indexOf("不套用：形象照、名片照片") >= 0, asked);
  }
  {
    const c = makeCtx({ api: () => ({ ok:true, memberId:"g3_m1", applied:["products"],
                                      warnings:[{ field:"products", reason:"list_truncated", dropped:2 }] }) });
    c.mupdReadChoices = () => ({ company:"skip", image:"skip", card:"skip", products:"append" });
    await c.mupdApply(el, photoView(M1("")));
    const t = c.log.filter(x => x.t === "toast").pop();
    chk("商品照被截掉 → 成功訊息寫「超過 5 張，最後 2 張沒有放進去」(不是 12 項)",
        !!t && t.msg.indexOf("「商品照片」超過 5 張，最後 2 張沒有放進去。") >= 0 && t.msg.indexOf("12 項") < 0, t && t.msg);
  }
  {
    const c = makeCtx({ api: () => ({ ok:false, error:"update_image_missing", fields:["image","products"] }) });
    c.mupdReadChoices = () => ({ company:"skip", image:"replace", card:"skip", products:"replace" });
    await c.mupdApply(el, photoView(M1("")));
    const t = c.log.filter(x => x.t === "toast").pop();
    chk("★ update_image_missing → 專屬訊息,列出哪幾種照片",
        !!t && t.opts.warn === true && t.msg === "照片已經不在暫存區（可能超過 90 天被清掉）：形象照、商品照片。請取消勾選照片再套用，或請本人重新上傳。", t && t.msg);
    chk("update_image_missing:沒有重讀資料、沒有從畫面拿掉(組長要取消勾選照片再套用)",
        !c.log.some(x => x.t === "load" || x.t === "render" || x.t === "revoke"));
  }
  {
    const c = makeCtx({ api: () => ({ ok:false, error:"update_image_corrupt", field:"card" }) });
    c.mupdReadChoices = () => ({ company:"skip", image:"skip", card:"replace", products:"skip" });
    await c.mupdApply(el, photoView(M1("")));
    const t = c.log.filter(x => x.t === "toast").pop();
    chk("★ update_image_corrupt → 專屬訊息(寫出哪一種照片)",
        !!t && t.msg === "照片檔有問題（名片照片），這次沒有寫入。請取消勾選照片再套用，並聯繫總管理員。", t && t.msg);
  }
  {
    const c = makeCtx({ api: () => ({ ok:false, error:"member_changed", fields:["image","company"] }) });
    c.mupdReadChoices = () => ({ company:"replace", image:"replace", card:"skip", products:"skip" });
    await c.mupdApply(el, photoView(M1("")));
    const t = c.log.filter(x => x.t === "toast").pop();
    chk("member_changed 的照片欄位也翻成中文", !!t && t.msg.indexOf("「形象照、所屬公司」在你打開這筆之後被別人改過") === 0, t && t.msg);
  }
  {
    const c = makeCtx({ api: () => ({ ok:false, error:"update_store_failed" }) });
    c.mupdReadChoices = () => ({ company:"skip", image:"replace", card:"skip", products:"skip" });
    await c.mupdApply(el, photoView(M1("")));
    const t = c.log.filter(x => x.t === "toast").pop();
    chk("update_store_failed(寫入之前)→ 明確說「沒有寫入」,不是「不確定有沒有寫進網站」",
        !!t && t.msg.indexOf("這次沒有寫入") >= 0 && t.msg.indexOf("不確定") < 0, t && t.msg);
  }
}

/* ══ 照片:差異表的照片列、欄位名稱、轉抄文字 ══
   夥伴可以在更新表單上傳形象照(1)、名片照片(1)、商品照片(≤5)。照片列接在文字列後面,
   預設規則同樣是「第一條成立的決定,警示每條都列」:allSkip → 較新那筆也傳了 → 原本就有(形象照/名片)
   → 商品照放不放得下。 */
hr("㉑ 照片列(memberUpdateRows 的照片、memberUpdatePhotos、fieldLabel、memberUpdateCopyText)");
{
  const PH = { mime:"image/jpeg", bytes:12345 };          // /member-update-get 給的摘要:沒有 key、沒有 sha256
  const REQ = (photos, extra) => Object.assign({ changes:{}, base:{}, truncated:[], stalePrefill:[], photos }, extra || {});
  const rows = (m, req, newer, allSkip) => L.memberUpdateRows(m, req, newer || new Set(), !!allSkip);
  const row = (m, req, f, newer, allSkip) => rows(m, req, newer, allSkip).find(r => r.field === f);
  const has = (r, s) => !!r && r.warnings.some(w => w.indexOf(s) >= 0);
  const m0 = MEMBER();                                     // 成員卡上沒有任何照片欄位
  const mFull = () => Object.assign(MEMBER(), { image:"g3_m1_x_abc.jpg", card:"g3_m1_card_def.jpg", products:["p1.jpg","p2.jpg"] });

  // 欄位名稱
  chk("★ fieldLabel 查得到三個照片欄位", L.fieldLabel("image") === "形象照" && L.fieldLabel("card") === "名片照片" &&
      L.fieldLabel("products") === "商品照片");
  chk("fieldLabel:文字欄位照舊、未知鍵原樣、原型鍵不會查到、null → \"\"", L.fieldLabel("company") === "所屬公司" &&
      L.fieldLabel("xyz") === "xyz" && L.fieldLabel("constructor") === "constructor" && L.fieldLabel(null) === "");
  chk("FIELD_LABELS 還是只有 9 個文字欄位(照片另外放在 PHOTO_LABELS)",
      Object.keys(L.FIELD_LABELS).length === 9 && !("image" in L.FIELD_LABELS) && !("products" in L.FIELD_LABELS));
  chk("PHOTO_LABELS、UPDATE_PHOTO_FIELDS、UPDATE_PRODUCTS_MAX 照規格",
      eq(L.PHOTO_LABELS, { image:"形象照", card:"名片照片", products:"商品照片" }) &&
      eq(L.UPDATE_PHOTO_FIELDS, ["image","card","products"]) && L.UPDATE_PRODUCTS_MAX === 5);
  chk("系統註記用的 fieldLabel 也認得照片(untouched 不會顯示英文鍵)",
      eq(L.memberUpdateExtras({ untouched:["products","company"] }, {}).untouched, ["所屬公司","商品照片"]));

  // 列的形狀與順序
  const all = rows(mFull(), REQ({ products:[PH,PH,PH], card:PH, image:PH }, { changes:{ company:"新公司" } }));
  chk("★ 照片列接在文字列後面,順序 image、card、products", eq(all.map(r => r.field), ["company","image","card","products"]),
      all.map(r => r.field).join(","));
  const im = all.find(r => r.field === "image");
  chk("★ 形象照列的形狀(kind / label / before / incoming / count / options / identical / changedSinceSubmit)",
      im.kind === "photo" && im.label === "形象照" && eq(im.before, ["g3_m1_x_abc.jpg"]) && eq(im.incoming, [{ field:"image", index:-1 }]) &&
      im.count === 1 && eq(im.options, ["replace","skip"]) && im.identical === false && im.changedSinceSubmit === false, JSON.stringify(im));
  const cd = all.find(r => r.field === "card");
  chk("名片列:label 名片照片、incoming 是 card / -1", cd.label === "名片照片" && eq(cd.incoming, [{ field:"card", index:-1 }]) &&
      eq(cd.before, ["g3_m1_card_def.jpg"]));
  const pr = all.find(r => r.field === "products");
  chk("★ 商品照列:incoming 是 product(單數)+ index 0..n-1,options 三選一",
      eq(pr.incoming, [{ field:"product", index:0 }, { field:"product", index:1 }, { field:"product", index:2 }]) &&
      pr.count === 3 && eq(pr.options, ["replace","append","skip"]) && pr.label === "商品照片" && eq(pr.before, ["p1.jpg","p2.jpg"]), JSON.stringify(pr));

  chk("只傳了商品照 → 只有商品照一列(image/card 是 null)", eq(rows(m0, REQ({ image:null, card:null, products:[PH] })).map(r => r.field), ["products"]));
  chk("沒有 photos → 沒有照片列(文字列照舊)", eq(rows(m0, REQ(undefined, { changes:{ company:"x" } })).map(r => r.field), ["company"]));
  chk("photos 格式不對(陣列、字串、空物件、products 空陣列)→ 沒有照片列",
      [[PH], "x", {}, { products:[] }, { image:"data:image/jpeg;base64,xx" }].every(p => rows(m0, REQ(p)).length === 0));
  chk("★ 商品照中間有格式不對的項目 → 略過,其他保留原本的位置當 index(Worker 照位置找照片)",
      eq(row(m0, REQ({ products:[PH, null, PH] }), "products").incoming, [{ field:"product", index:0 }, { field:"product", index:2 }]));
  chk("商品照超過 5 張 → 只取前 5 張", row(m0, REQ({ products:[PH,PH,PH,PH,PH,PH] }), "products").count === 5);

  // 預設:形象照、名片
  const i0 = row(m0, REQ({ image:PH }), "image");
  chk("★ 形象照原本沒有 → replace,沒有警示", i0.defaultChoice === "replace" && i0.warnings.length === 0 && eq(i0.before, []));
  const i1 = row(mFull(), REQ({ image:PH }), "image");
  chk("★ 形象照原本有 → skip + 「會換掉名錄上現在的形象照」",
      i1.defaultChoice === "skip" && eq(i1.warnings, ["⚠ 會換掉名錄上現在的形象照。請先確認新照片是本人（或他的名片）再勾選。"]), JSON.stringify(i1.warnings));
  const c1 = row(mFull(), REQ({ card:PH }), "card");
  chk("★ 名片原本有 → skip + 「會換掉名錄上現在的名片照片」", c1.defaultChoice === "skip" && has(c1, "⚠ 會換掉名錄上現在的名片照片。"));
  chk("名片原本是空白字串 → 算沒有 → replace", row(Object.assign(MEMBER(), { card:"  " }), REQ({ card:PH }), "card").defaultChoice === "replace");
  chk("形象照是內嵌的 data: URL(舊資料)→ 也算原本有", row(Object.assign(MEMBER(), { image:"data:image/jpeg;base64,AAAA" }), REQ({ image:PH }), "image").defaultChoice === "skip");

  // 預設:商品照
  const p0 = row(m0, REQ({ products:[PH,PH] }), "products");
  chk("★ 商品照原本 0 張 → replace", p0.defaultChoice === "replace" && p0.warnings.length === 0);
  const pFit = row(Object.assign(MEMBER(), { products:["a.jpg","b.jpg"] }), REQ({ products:[PH,PH,PH] }), "products");
  chk("★ 原本 2 張 + 新的 3 張 = 5(放得下)→ append", pFit.defaultChoice === "append" && pFit.warnings.length === 0);
  const pOver = row(Object.assign(MEMBER(), { products:["a.jpg","b.jpg","c.jpg"] }), REQ({ products:[PH,PH,PH] }), "products");
  chk("★ 原本 3 張 + 新的 3 張 > 5 → skip + 警示",
      pOver.defaultChoice === "skip" && eq(pOver.warnings, ["⚠ 原本 3 張加上新的 3 張超過 5 張，請選「整組換成新的」或不套用。"]), JSON.stringify(pOver.warnings));
  chk("原本的空字串、空白、非字串不算張數", eq(row(Object.assign(MEMBER(), { products:["a.jpg", "", " ", null, 3] }), REQ({ products:[PH] }), "products").before, ["a.jpg"]));

  // 較新那筆、allSkip
  const nw = row(m0, REQ({ image:PH }), "image", new Set(["image"]));
  chk("★ 較新那筆也傳了形象照 → skip + 「後面那筆較新的更新也傳了這類照片」",
      nw.defaultChoice === "skip" && eq(nw.warnings, ["後面那筆較新的更新也傳了這類照片，這裡先不套用。"]), JSON.stringify(nw.warnings));
  const nw2 = row(mFull(), REQ({ image:PH }), "image", new Set(["image"]));
  chk("較新那筆 + 原本有 → 兩條警示都列", nw2.defaultChoice === "skip" && nw2.warnings.length === 2);
  chk("較新那筆改的是別的欄位 → 不受影響", row(m0, REQ({ image:PH }), "image", new Set(["company","card"])).defaultChoice === "replace");
  const np = row(m0, REQ({ products:[PH] }), "products", new Set(["products"]));
  chk("較新那筆也傳了商品照 → skip(原本 0 張也一樣)", np.defaultChoice === "skip" && has(np, "也傳了這類照片"));
  const sk = rows(m0, REQ({ image:PH, card:PH, products:[PH] }), new Set(), true);
  chk("★ allSkip → 每一張照片列都 skip,警示寫在標頭、列上不重複",
      sk.length === 3 && sk.every(r => r.defaultChoice === "skip" && r.warnings.length === 0), sk.map(r => r.field + ":" + r.defaultChoice).join(","));
  chk("allSkip 時仍保留「會換掉現在的形象照」提醒", has(row(mFull(), REQ({ image:PH }), "image", new Set(), true), "會換掉名錄上現在的形象照"));
  const sk3 = row(Object.assign(MEMBER(), { products:["a","b","c","d"] }), REQ({ products:[PH,PH] }), "products", new Set(), true);
  chk("allSkip 時仍保留「超過 5 張」提醒", sk3.defaultChoice === "skip" && has(sk3, "原本 4 張加上新的 2 張超過 5 張"));
  chk("member 是 null 也不會丟例外(照片都算原本沒有)",
      eq(L.memberUpdateRows(null, REQ({ image:PH, products:[PH] }), new Set(), false).map(r => r.defaultChoice), ["replace","replace"]));

  // memberUpdatePhotos
  chk("memberUpdatePhotos:依 image、card、products 排,帶 label 與 incoming",
      eq(L.memberUpdatePhotos(REQ({ products:[PH], image:PH })).map(p => [p.field, p.label, p.incoming.length]), [["image","形象照",1],["products","商品照片",1]]));
  chk("memberUpdatePhotos(null / 沒有 photos) → []", eq(L.memberUpdatePhotos(null), []) && eq(L.memberUpdatePhotos({}), []));

  // 轉抄文字
  const sat = "2026-10-02T05:14:41.000Z";
  const txt = L.memberUpdateCopyText({ label:"A1・曾俊凱", sat, changes:{ company:"雲榮" }, note:"我換到 B2 了",
                                       photos:{ image:PH, card:null, products:[PH,PH,PH] } });
  const lines = txt.split("\n");
  const pl = lines.findIndex(l => l.indexOf("另外傳了照片") === 0);
  chk("★ 有照片 → 多一行「另外傳了照片：形象照 1 張、商品照 3 張（照片請在後台查看、另存）。」",
      pl > 0 && lines[pl] === "另外傳了照片：形象照 1 張、商品照 3 張（照片請在後台查看、另存）。", txt);
  chk("照片那一行在欄位之後、備註之前", pl > lines.indexOf("【所屬公司】雲榮") && lines[lines.length - 1] === "【給組長的備註】我換到 B2 了");
  chk("三種都有 → 形象照、名片、商品照依序",
      L.memberUpdateCopyText({ label:"A1・x", sat, changes:{}, photos:{ image:PH, card:PH, products:[PH] } })
        .indexOf("另外傳了照片：形象照 1 張、名片 1 張、商品照 1 張（照片請在後台查看、另存）。") > 0);
  chk("沒有照片 → 沒有這一行", L.memberUpdateCopyText({ label:"A1・x", sat, changes:{ company:"y" } }).indexOf("另外傳了照片") < 0);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
