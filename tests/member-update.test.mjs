/* 夥伴資料更新(Google 表單 → 私有 R2 待審核 → 後台套用)的 Worker 端測試。
   用**真實的 worker/publish-relay.js**,把 GitHub(含公開網站)、R2、KV 換成 tests/github-model.mjs
   的假物件。條號對應規格 §6.5 的 1–39;㊵ 之後是更新表單的照片(介面契約 §2)。

   要守住的不變式:
     ・收件只讀公開網站,不打 GitHub API(灌單不會吃光權杖額度)
     ・沒審核過的內容只在私有 R2,不進 repo;套用前逐欄比對審核者看到的值
     ・連結代碼:夥伴點舊連結再填一次,不會把後來的修改改回去
     ・套用的鎖一定會解開;不確定有沒有寫入時不說「沒有寫入」;同一筆不會被寫兩次
     ・★ 子請求預算:GitHub + 公開網站 + R2 + KV 的呼叫**全部**算進去,每支端點 ≤ 50
       (Cloudflare 的定義:"A subrequest is any request a Worker makes using the Fetch API
        or to Cloudflare services like R2, KV, or D1" —— R2 與 KV 不是免費的)

   執行:node tests/member-update.test.mjs */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FakeGitHub, FakeR2, FakeKV, loadWorker, blobShaOf } from "./github-model.mjs";
import * as CASES from "./member-update-cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PATH = path.join(ROOT, "worker/publish-relay.js");
const W = loadWorker(WORKER_PATH, fs, ["canonUpdateValue", "sameUpdateValue", "updateValueHash", "parseLinkToken",
  "UPDATE_TOKEN_ORDER", "UPDATE_FIELDS", "UPDATE_LIST_FIELDS"]);
/* admin-logic.js 用 vm 載入(它是給瀏覽器的一般 script,最後一行才 module.exports)。
   第 28 條要用它真正產生連結代碼,送進 Worker —— 兩邊的雜湊只要差一個字元,這條就會壞。 */
const AL_SRC = fs.readFileSync(path.join(ROOT, "admin-logic.js"), "utf8");
const alCtx = vm.createContext({ TextEncoder, URL, URLSearchParams });
vm.runInContext(AL_SRC, alCtx, { filename: "admin-logic.js" });
const AL = alCtx.AdminLogic;

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const brief = o => String(JSON.stringify(o, (k, v) => k.startsWith("_") ? undefined : v)).slice(0, 160);   // undefined 也能印

/* ── 測資 ─────────────────────────────────────────────────────────────── */
const SS = "x".repeat(48);
const IDX = [
  { code:"A1", name:"肉品海鮮批發組", id:"g3" },
  { code:"B1", name:"滿分食品供應組", id:"g12" },
  { code:"C",  name:"測試大組",       id:"g10" },
];
const M = (id, name, extra = {}) => Object.assign({
  number:"", name, title:"", services:[], targets:[], have:[], want:[], tagline:[],
  image:"", card:"", products:[], company:"", business_items:"", website:"",
  id, dataIssue:false, updatedAt:"2026-07-28T07:14:10.402Z" }, extra);
const A1_MEMBERS = () => [
  M("g3_m1", "曾俊凱", { title:"豬肉屠宰批發零售",
    services:["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切"], targets:["連鎖滷味店/豬腳店", "小家庭豬肉箱"],
    tagline:["國產豬肉專門家", "品質保證攏抵家"] }),
  M("g3_m9", "王大銘", { title:"水產批發", company:"大銘水產" }),
  M("g3_m2", "林小美", { title:"蔬果", dataIssue:true }),
  M("g3_m3", "李 小 華", { title:"甲" }),
  M("g3_m4", "李小華", { title:"乙" }),
  M("g3_m5", "張多項", { title:"雜貨", services: Array.from({ length:14 }, (_, i) => "品項" + (i + 1)) }),
  M("g3_m6", "陳清單", { title:"清單", services: Array.from({ length:10 }, (_, i) => "服務" + (i + 1)) }),
];
const grpJson = members => JSON.stringify({ leader:"組長", room:"", members, recruiting:[] }, null, 2) + "\n";
const pad2 = n => String(n).padStart(2, "0");
const baseFiles = () => ({
  "data/_index.json": JSON.stringify(IDX, null, 2) + "\n",
  "data/a1.json": grpJson(A1_MEMBERS()),
  "data/b1.json": grpJson([ M("g12_m1", "陳大文", { title:"烘焙" }) ]),
  "data/c.json": grpJson(Array.from({ length:30 }, (_, i) => M("g10_m" + pad2(i + 1), "夥伴" + pad2(i + 1), { title:"行業" + (i + 1) }))),
  "data/_pending.json": "[]\n",
});

function world(o = {}){
  const gh = new FakeGitHub(o.files || baseFiles()); gh.install(o.hooks || {});
  const r2 = new FakeR2(); const kv = new FakeKV();
  const env = Object.assign({
    GH_OWNER:"O", GH_REPO:"R", GH_BRANCH:"main", GH_TOKEN:"t",
    ALLOWED_ORIGIN:"https://ivanzhong085.github.io",
    SESSION_SECRET:SS, INTAKE_SECRET:"s3cret",
    RATE_LIMIT:kv, PENDING_IMAGES:r2,
  }, o.env || {});
  return { gh, r2, kv, env };
}

/* 每次呼叫都量子請求:GitHub API + 公開網站(gh.subrequests)+ R2 呼叫 + KV 呼叫。
   ★ 不要照 pending-r2 測試「R2 不計入」的寫法 —— R2 與 KV 都算在 50 個以內。
   同時跑好幾個請求時(並行測試)量不準,那幾次傳 track:false。 */
const maxCost = {};
async function call(w, p, body, opt = {}){
  const s0 = w.gh.subrequests, a0 = w.gh.apiCalls, g0 = w.gh.pagesFetches, r0 = w.r2.calls.length, k0 = w.kv.calls;
  const res = await W.__worker.fetch(new Request("https://w.test" + p, { method:"POST",
    headers:{ "Content-Type":"application/json", "CF-Connecting-IP": opt.ip || "1.2.3.4" },
    body: typeof body === "string" ? body : JSON.stringify(body) }), w.env);
  const out = await res.json().catch(() => ({}));
  out._status = res.status;
  out._cost = (w.gh.subrequests - s0) + (w.r2.calls.length - r0) + (w.kv.calls - k0);
  out._api = w.gh.apiCalls - a0;
  out._pages = w.gh.pagesFetches - g0;
  out._r2 = w.r2.calls.slice(r0);
  if(opt.track !== false) maxCost[p] = Math.max(maxCost[p] || 0, out._cost);
  return out;
}
let ridSeq = 0;
const upd = (o = {}) => Object.assign({ label:"A1・曾俊凱", name:"曾俊凱", group:"A1", changes:{}, note:"",
  responseId:"rid-" + (++ridSeq), submittedAt: new Date().toISOString(), linkToken:"", pickedLabel:"" }, o);
const submit = (w, o, opt) => call(w, "/member-update", { secret:"s3cret", update: upd(o) }, opt);
const GROUP_FILE = { g3:"a1", g12:"b1", g10:"c" };
const memberOf = (w, id, code) =>
  (JSON.parse(w.gh.files().get("data/" + (code || GROUP_FILE[id.split("_")[0]]) + ".json")).members || []).find(m => m.id === id);
function setMember(w, code, id, patch){
  const p = "data/" + code + ".json";
  const g = JSON.parse(w.gh.files().get(p));
  Object.assign(g.members.find(x => x.id === id), patch);
  return w.gh.pushFiles({ [p]: grpJson(g.members) }, "其他人發布");
}
const keyOf = uid => "updates/req/" + uid + ".json";
const reqKeys = w => w.r2.keys().filter(k => k.startsWith("updates/req/"));
const reqOf = (w, uid) => w.r2.peekJson(keyOf(uid));
const expectOf = (w, id, fields, code) => {
  const m = memberOf(w, id, code);
  return Object.fromEntries(fields.map(f => [f, m[f] == null ? "" : m[f]]));
};
const apply = (w, sess, uid, choices, expect, extra = {}, opt) =>
  call(w, "/member-update-apply", Object.assign({ session:sess, uid, choices, expect }, extra), opt);
/* 直接把一筆請求改成「處理中」(模擬另一個分頁正在套用),metadata 一起改 —— 與真實 put 一樣整份取代。 */
async function forceState(w, uid, state){
  const key = keyOf(uid);
  const req = w.r2.peekJson(key), meta = w.r2.peekMeta(key);
  const lockAt = new Date().toISOString();
  Object.assign(req, { state, lockAt, lockBy:"someone" });
  Object.assign(meta, { state, lockAt, lockBy:"someone" });
  await w.r2.put(key, JSON.stringify(req), { httpMetadata:{ contentType:"application/json" }, customMetadata:meta });
}
const commitsWith = (w, prefix) => [...w.gh.commits.values()].filter(c => String(c.message).startsWith(prefix));
const FIELDS = W.UPDATE_FIELDS;
/* 從後台產生的預填值組出「夥伴點連結 → 送出」的內容。over 裡的欄位是夥伴改過的。 */
const fromLink = (pv, name, over = {}) => ({
  label: pv.member, name, group: pv.member.split("・")[0], linkToken: pv.token,
  changes: Object.fromEntries(FIELDS.map(f => [f, Object.prototype.hasOwnProperty.call(over, f) ? over[f] : (pv[f] || "")])),
});

const sOwner  = await W.makeSession(SS, { name:"owner", role:"owner", group:"" });
const sA1     = await W.makeSession(SS, { name:"a1", role:"leader", group:"A1" });
const sB1     = await W.makeSession(SS, { name:"b1", role:"leader", group:"B1" });
const sA9     = await W.makeSession(SS, { name:"a9", role:"leader", group:"A9" });
const sViewer = await W.makeSession(SS, { name:"v", role:"viewer", group:"" });

/* ══ 0 ══ canon / 雜湊:Worker 與 admin-logic.js 必須逐字相同 */
hr("⓪ canon / 雜湊:Worker 與 admin-logic 用同一份共用測資");
{
  chk("參考實作先對過 FNV 官方測試向量", CASES.FNV_VECTORS.every(v => CASES.fnv1a32Ref(v.text) === v.hex));
  let bad = [];
  for(const c of CASES.VALUE_CASES){
    const wc = W.canonUpdateValue(c.field, c.input), wh = W.updateValueHash(c.field, c.input);
    const ah = AL.updateValueHash(c.field, c.input);
    const ref = c.canon.length ? CASES.fnv1a32Ref(JSON.stringify(c.canon)) : CASES.HASH_EMPTY;
    if(!eq(wc, c.canon) || wh !== c.hash || ah !== c.hash || (c.rawFnv ? ref !== c.rawFnv : ref !== c.hash)) bad.push(c.name);
  }
  chk(`★ ${CASES.VALUE_CASES.length} 筆 canon/雜湊:Worker = admin-logic = 獨立算出的預期值`, !bad.length, bad.join("、"));
  bad = CASES.SAME_CASES.filter(c => W.sameUpdateValue(c.field, c.a, c.b) !== c.same || AL.sameUpdateValue(c.field, c.a, c.b) !== c.same);
  chk(`sameUpdateValue ${CASES.SAME_CASES.length} 筆`, !bad.length, bad.map(c => c.name).join("、"));
  for(const t of CASES.TOKEN_CASES){
    const wt = "v1." + t.member.id + "." + W.UPDATE_TOKEN_ORDER.map(f => W.updateValueHash(f, t.member[f])).join("");
    const p = W.parseLinkToken(t.token);
    chk("連結代碼:" + t.name, wt === t.token && AL.memberUpdateToken(t.member) === t.token &&
        p && p.memberId === t.member.id && W.UPDATE_TOKEN_ORDER.every(f => p.hashes[f] === W.updateValueHash(f, t.member[f])));
  }
  chk("UPDATE_TOKEN_ORDER = admin-logic 的 UPDATE_FIELD_ORDER", eq(W.UPDATE_TOKEN_ORDER, [...AL.UPDATE_FIELD_ORDER]));
  chk("UPDATE_LIST_FIELDS = admin-logic 的 LIST_FIELDS", eq(W.UPDATE_LIST_FIELDS, [...AL.LIST_FIELDS]));
  /* 原始碼逐字比對:行為測試只看得到測資涵蓋到的輸入,逐字相同才保證每一種輸入都一樣。
     唯一允許的差異是清單欄位判斷的名稱(Worker 裡叫 isUpdateListField)。 */
  const fnSrc = (src, name) => {
    const m = new RegExp("^([ \\t]*)function " + name + "\\([\\s\\S]*?\\n\\1\\}", "m").exec(src);
    return m ? m[0].split("\n").map(l => l.slice(m[1].length)).join("\n") : null;
  };
  const wsrc = fs.readFileSync(WORKER_PATH, "utf8");
  for(const fn of ["canonText", "canonUpdateValue", "sameUpdateValue", "updateValueHash"]){
    const a = fnSrc(AL_SRC, fn), b = fnSrc(wsrc, fn);
    chk("★ " + fn + " 與 admin-logic.js 逐字相同", a && b && a.replace(/\bisListField\(/g, "isUpdateListField(") === b);
  }
  const ctrl = s => (/const UPDATE_CTRL_RE = (\/.*\/g);/.exec(s) || [])[1];
  chk("控制字元的正規表示式相同", ctrl(AL_SRC) && ctrl(AL_SRC) === ctrl(wsrc), ctrl(wsrc));
}

/* ══ 1 ══ 正常收件 */
hr("① 正常收件:R2 一筆、metadata 齊全、不打 GitHub API");
{
  const w = world();
  const r = await submit(w, { changes:{ company:"雲榮肉品有限公司",
    services:"冷藏/凍豬肉原料批發\n豬肉絲/丁/片/塊精切\n豬肉餡", title:"", website:"" }, note:"請刪掉我的公司網站" });
  chk("200 ok", r._status === 200 && r.ok === true && /^u_[a-z0-9]{6,40}$/.test(r.uid || ""), brief(r));
  chk("R2 裡有 1 個物件", reqKeys(w).length === 1 && reqKeys(w)[0] === keyOf(r.uid));
  const meta = w.r2.peekMeta(keyOf(r.uid)) || {};
  const need = ["v","name","memberId","gid","code","at","sat","fields","hasNote","confirm","state","lockAt","rid","h"];
  chk("customMetadata 欄位齊全(含 sat、rid、h)", need.every(k => typeof meta[k] === "string") && meta.sat && meta.rid && meta.h,
      need.filter(k => typeof meta[k] !== "string").join(","));
  chk("customMetadata ≤ 2,048 bytes", Buffer.byteLength(JSON.stringify(meta)) <= 2048, Buffer.byteLength(JSON.stringify(meta)) + " bytes");
  chk("metadata 的值是 UTF-8 原文(沒有 encodeURIComponent)", meta.name === "曾俊凱" && meta.fields === "company,services" && meta.hasNote === "1");
  const raw = new TextDecoder().decode(w.r2.objects.get(keyOf(r.uid)));
  chk("★ 請求 JSON 不含 secret", !raw.includes("s3cret"));
  chk("★ gh.apiCalls 增量是 0(收件只讀公開網站)", r._api === 0 && r._pages === 2, `api=${r._api} pages=${r._pages}`);
  const q = reqOf(w, r.uid);
  chk("以 memberId/gid 為準", q.memberId === "g3_m1" && q.gid === "g3" && q.code === "A1" && q.name === "曾俊凱");
  chk("changes 只有真的改的欄位;base 是收件當下的網站值",
      eq(Object.keys(q.changes), ["company","services"]) && q.base.company === "" && q.base.services.length === 2);
  chk("contentType 是 application/json", (w.r2.meta.get(keyOf(r.uid)) || {}).contentType === "application/json");
  chk("回應:fields / open / groupOpen / hasNote", eq(r.fields, ["company","services"]) && r.open === 1 && r.groupOpen === 1 && r.hasNote === true);
  chk("子請求 ≤ 10", r._cost <= 10, r._cost + " 個");
}

/* ══ 2 ══ 密碼錯誤的節流 */
hr("② secret 錯誤:401;同一 IP 錯 5 次後 429;正確的送件不寫 KV");
{
  const w = world();
  const rs = [];
  for(let i = 0; i < 5; i++) rs.push(await call(w, "/member-update", { secret:"wrong", update: upd() }, { ip:"9.9.9.9" }));
  chk("secret 錯 → 401 bad_secret", rs.every(r => r._status === 401 && r.error === "bad_secret"), rs.map(r => r.error).join(","));
  const r6 = await submit(w, { changes:{ company:"新公司" } }, { ip:"9.9.9.9" });
  chk("★ 第 6 次即使 secret 正確也 429", r6._status === 429 && r6.error === "too_many_submissions" && r6.retryAfter > 0, brief(r6));
  const other = await submit(w, { changes:{ company:"新公司" } }, { ip:"8.8.8.8" });
  chk("別的 IP 不受影響", other.ok === true, brief(other));
  const w2 = world();
  await submit(w2, { changes:{ company:"新公司 2" } });
  await call(w2, "/member-update", { secret:"s3cret", update:{} });
  chk("★ secret 正確的送件,KV put 次數是 0", w2.kv.n.put === 0, "put " + w2.kv.n.put + " 次");
  /* 畸形的 body:JSON null、陣列、純字串、數字,secret 是 {"toString":null} 或陣列。
     以前會在比對密碼前丟 TypeError → 500,跳過補延遲與失敗計數。現在一律當成沒帶密碼。
     陣列 ["s3cret"] 以前會被 String() 轉成正確密碼,也一起擋掉。 */
  const w3 = world();
  const weird = ["null", "[]", '"x"', "5",
    JSON.stringify({ secret:{ toString:null }, update: upd() }),
    JSON.stringify({ secret:["s3cret"], update: upd() })];
  const t0 = Date.now();
  const ws = await Promise.all(weird.map((b, i) => call(w3, "/member-update", b, { ip:"6.6.6." + i, track:false })));
  const took = Date.now() - t0;
  chk("★ 畸形 body / secret 型別不對 → 401 bad_secret(不是 500)", ws.every(r => r._status === 401 && r.error === "bad_secret"),
      ws.map(r => r._status + " " + r.error).join(","));
  chk("★ 每一筆都記一次密碼錯誤", weird.every((b, i) => w3.kv.store.has("mupd-fail:6.6.6." + i)) && w3.kv.n.put === weird.length,
      "put " + w3.kv.n.put + " 次");
  chk("★ 照常補延遲(≥ 300ms)", took >= 290, took + "ms");
  chk("R2 沒有寫入", reqKeys(w3).length === 0);
}

/* ══ 3 ══ 同一 IP 大量正確送件 */
hr("③ 同一 IP 連續 25 筆正確送件(25 人)全部成功(不可以沿用 /intake 的節流)");
{
  const w = world();
  const rs = await Promise.all(Array.from({ length:25 }, (_, i) => submit(w, {
    label:"C・夥伴" + pad2(i + 1), name:"夥伴" + pad2(i + 1), group:"C", changes:{ company:"公司" + i } }, { ip:"7.7.7.7", track:false })));
  chk("★ 25 筆全部成功", rs.every(r => r.ok === true), rs.filter(r => !r.ok).map(r => r.error).join(","));
  chk("R2 有 25 筆", reqKeys(w).length === 25);
  chk("KV 沒有任何寫入", w.kv.n.put === 0);
}

/* ══ 4 ══ 設定不完整與格式錯誤 */
hr("④ 沒綁 R2 / 沒設 INTAKE_SECRET / update:{}");
{
  const w = world({ env:{ PENDING_IMAGES: undefined } });
  const r = await submit(w, { changes:{ company:"x" } });
  chk("沒綁 R2 → 503 pending_image_store_unavailable", r._status === 503 && r.error === "pending_image_store_unavailable", brief(r));
  const w2 = world({ env:{ INTAKE_SECRET: undefined } });
  const r2 = await submit(w2, { changes:{ company:"x" } });
  chk("沒設 INTAKE_SECRET → 503 intake_disabled", r2._status === 503 && r2.error === "intake_disabled", brief(r2));
  const w3 = world();
  const r3 = await call(w3, "/member-update", { secret:"s3cret", update:{} });
  chk("update:{} → 400 bad_update(checkMemberUpdateForm 的探測)", r3._status === 400 && r3.error === "bad_update", brief(r3));
  const r4 = await submit(w3, { group:"A-1", changes:{ company:"x" } });
  chk("組代號格式不對 → 400 bad_update", r4._status === 400 && r4.error === "bad_update");
  const w5 = world({ env:{ RATE_LIMIT: undefined } });
  const r5 = await submit(w5, { changes:{ company:"x" } });
  chk("沒綁 KV → 500 rate_limit_unavailable", r5._status === 500 && r5.error === "rate_limit_unavailable", brief(r5));
  /* 收件欄位型別不對(密碼正確):name 是 toString 為 null 的物件 → 400 bad_update,不是 500;
     其他欄位(備註、回應 ID、代碼…)型別不對就當成空的,照常收件。 */
  const w6 = world();
  const BAD = { toString:null };
  const r6 = await submit(w6, { name:BAD, changes:{ company:"x" } });
  chk("★ name 是怪物件 → 400 bad_update", r6._status === 400 && r6.error === "bad_update", brief(r6));
  const r7 = await submit(w6, { group:BAD, changes:{ company:"x" } });
  chk("★ group 是怪物件 → 400 bad_update", r7._status === 400 && r7.error === "bad_update", brief(r7));
  const r8 = await submit(w6, { label:BAD, note:BAD, responseId:BAD, submittedAt:BAD, linkToken:BAD, pickedLabel:BAD,
    changes:{ company:"型別不對的其他欄位" } });
  const q8 = r8.ok ? reqOf(w6, r8.uid) : {};
  chk("★ 其他欄位是怪物件 → 當成空的,照常收件", r8.ok === true && q8.note === "" && q8.responseId === "" &&
      q8.pickedLabel === "" && q8.tokenUsed === false && q8.label === "A1・曾俊凱" && q8.sat === q8.at, brief(r8));
}

/* ══ 5 ══ 找組、找人 */
hr("⑤ 組代號不存在 / 姓名對不上 / 同組同名");
{
  const w = world();
  const a = await submit(w, { label:"Z9・曾俊凱", group:"Z9", changes:{ company:"x" } });
  chk("組代號不存在 → 404 group_not_found", a._status === 404 && a.error === "group_not_found", brief(a));
  const b = await submit(w, { label:"A1・不存在的人", name:"不存在的人", changes:{ company:"x" } });
  chk("姓名對不上 → 404 member_not_found", b._status === 404 && b.error === "member_not_found", brief(b));
  const c = await submit(w, { label:"A1・李小華", name:"李小華", changes:{ company:"x" } });
  chk("同組兩人去掉空白後同名 → 409 member_ambiguous", c._status === 409 && c.error === "member_ambiguous", brief(c));
  const d = await submit(w, { label:"A1・曾 俊凱", name:"曾 俊凱", changes:{ company:"空白不影響" } });
  chk("姓名比對忽略空白", d.ok === true && d.memberId === "g3_m1", brief(d));
  chk("找不到人時 R2 沒有寫入", reqKeys(w).length === 1);
}

/* ══ 6 ══ 沒改 / 佔位字 */
hr("⑥ 全部和現值相同 → unchanged;只填「同上」→ nothing_to_update;「同上」+ 公司 → 只收公司");
{
  const w = world();
  const m = memberOf(w, "g3_m1");
  const same = Object.fromEntries(FIELDS.map(f => [f, Array.isArray(m[f]) ? m[f].join("\n") : m[f]]));
  const a = await submit(w, { changes: same });
  chk("全部相同、沒有備註 → 200 unchanged", a._status === 200 && a.unchanged === true && a.memberId === "g3_m1", brief(a));
  chk("R2 裡沒有物件", reqKeys(w).length === 0);
  const b = await submit(w, { changes:{ company:"同上" } });
  chk("只填「同上」→ 400 nothing_to_update", b._status === 400 && b.error === "nothing_to_update" &&
      eq(b.ignored, [{ field:"company", value:"同上" }]), brief(b));
  const c = await submit(w, { changes:{ tagline:"同上。", company:"新公司", have:"Ｎ／Ａ" } });
  const q = c.ok ? reqOf(w, c.uid) : {};
  chk("「同上」+ 公司 → 只收公司,ignored 有那兩欄", c.ok && eq(Object.keys(q.changes), ["company"]) &&
      eq(q.ignored.map(x => x.field).sort(), ["have","tagline"]), brief(c));
  const d = await submit(w, { changes:{ services:"同上\n新的一項", company:"另一間" } });
  chk("清單裡夾著「同上」不算佔位字", d.ok && eq(reqOf(w, d.uid).changes.services, ["同上","新的一項"]), brief(d));
}

/* ══ 7 ══ 網站 */
hr("⑦ 網站:www 開頭自動補 https://;不是網址的進 invalid");
{
  const w = world();
  const a = await submit(w, { changes:{ website:"www.abc.com.tw" } });
  chk("www.abc.com.tw → https://www.abc.com.tw", a.ok && reqOf(w, a.uid).changes.website === "https://www.abc.com.tw", brief(a));
  const b = await submit(w, { changes:{ website:"我的官網" } });
  const q = b.ok ? reqOf(w, b.uid) : {};
  chk("「我的官網」→ invalid,不在 changes 裡", b.ok && !("website" in q.changes) && eq(q.invalid, [{ field:"website", value:"我的官網" }]) &&
      eq(b.invalid, [{ field:"website", value:"我的官網" }]), brief(b));
  const c = await submit(w, { changes:{ website:"javascript:alert(1)" }, note:"" });
  chk("javascript: 不會被當成網址", c.ok && !("website" in reqOf(w, c.uid).changes), brief(c));
  /* 手機輸入法會把第一個字母自動大寫。協定要轉成小寫存:套用時與前台(app.js)都只認小寫的 http(s)://。 */
  const d = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ website:"Https://www.abc.com.tw/Path?Q=1" } });
  const qd = d.ok ? reqOf(w, d.uid) : {};
  chk("★ Https://… → 協定轉小寫收下,路徑大小寫不動", d.ok && qd.changes.website === "https://www.abc.com.tw/Path?Q=1" &&
      !qd.invalid.length, brief(d));
  const e = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ website:"HTTP://abc.tw" } });
  const qe = e.ok ? reqOf(w, e.uid) : {};
  chk("★ HTTP://abc.tw → http://abc.tw,不進 invalid", e.ok && qe.changes.website === "http://abc.tw" && !qe.invalid.length, brief(e));
}

/* ══ 8 ══ 原型鍵 */
hr("⑧ changes 帶 constructor、__proto__、白名單以外的鍵 → 全部忽略");
{
  const w = world();
  const raw = '{"secret":"s3cret","update":{"label":"A1・曾俊凱","name":"曾俊凱","group":"A1","responseId":"r8",' +
    '"changes":{"constructor":"x","__proto__":{"company":"污染"},"hack":"y","toString":"z","products":"p","company":"真的公司"}}}';
  const r = await call(w, "/member-update", raw);
  const q = r.ok ? reqOf(w, r.uid) : {};
  chk("★ 只收白名單裡的 company", r.ok && eq(Object.keys(q.changes), ["company"]) && q.changes.company === "真的公司", brief(r));
  chk("沒有污染 Object.prototype", ({}).company === undefined);
}

/* ══ 9 ══ 上限 */
hr("⑨ 每人 3 筆、全分會 100 筆");
{
  const w = world();
  const rs = [];
  for(const c of ["甲","乙","丙","丁"]) rs.push(await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"公司" + c } }));
  chk("前 3 筆成功", rs.slice(0, 3).every(r => r.ok), rs.map(r => r.error || "ok").join(","));
  chk("★ 第 4 筆 → 409 too_many_updates_for_member", rs[3]._status === 409 && rs[3].error === "too_many_updates_for_member" &&
      rs[3].max === 3 && rs[3].open === 3, brief(rs[3]));
  const w2 = world();
  for(let i = 0; i < 100; i++){
    await w2.r2.put("updates/req/u_fill" + String(i).padStart(4, "0") + ".json", "{}", { customMetadata:{
      v:"1", memberId:"g10_m" + pad2(i % 30 + 1), gid:"g10", code:"C", at:new Date().toISOString(), sat:new Date().toISOString(),
      rid:"fill" + i, h:"h" + i, state:"open", lockAt:"" } });
  }
  const r = await submit(w2, { changes:{ company:"第 101 筆" } });
  chk("★ 全分會第 101 筆 → 409 updates_full", r._status === 409 && r.error === "updates_full" && r.max === 100, brief(r));
}

/* ══ 10 ══ 分頁 */
hr("⑩ list 帶 metadata 時分頁;5 頁之後仍 truncated → updates_full");
{
  const w = world();
  for(let i = 0; i < 7; i++) await submit(w, { label:"C・夥伴" + pad2(i + 1), name:"夥伴" + pad2(i + 1), group:"C", changes:{ company:"c" + i } });
  w.r2.metaPageSize = 2;
  const calls0 = w.r2._n.list;
  const r = await submit(w, { changes:{ company:"第 8 筆" } });
  chk("7 筆、每頁 2 筆 → 分 4 頁,計數正確(open = 8)", r.ok && r.open === 8 && w.r2._n.list - calls0 === 4, brief(r));
  chk("子請求 ≤ 10", r._cost <= 10, r._cost + " 個");
  w.r2.metaPageSize = 1;
  const r2 = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"第 9 筆" } });
  chk("★ 5 頁之後仍 truncated → 409 updates_full(list_truncated)", r2._status === 409 && r2.error === "updates_full" &&
      r2.reason === "list_truncated", brief(r2));
  chk("最多讀 5 頁", r2._r2.filter(c => c.op === "list").length === 5);
}

/* ══ 11 ══ put 失敗 */
hr("⑪ R2 put 丟例外 → 502 update_store_failed,並嘗試 delete");
{
  const w = world();
  w.r2.fail = { op:"put", once:true };
  const r = await submit(w, { changes:{ company:"x" } });
  chk("502 update_store_failed", r._status === 502 && r.error === "update_store_failed", brief(r));
  const del = r._r2.find(c => c.op === "delete");
  chk("★ 有嘗試 delete 同一個 key", !!del && /^updates\/req\/u_[a-z0-9]+\.json$/.test(del.key), del && del.key);
  chk("沒有殘留", reqKeys(w).length === 0);
}

/* ══ 12 ══ 後台清單 */
hr("⑫ /member-updates:權限、只看自己組、依 sat 排序、壞 metadata、改代號");
{
  const w = world();
  const day = 86400000;
  const x = await submit(w, { changes:{ company:"X" }, submittedAt: new Date(Date.now() - 1 * day).toISOString() });
  const y = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"Y" }, submittedAt: new Date(Date.now() - 3 * day).toISOString() });
  const z = await submit(w, { label:"B1・陳大文", name:"陳大文", group:"B1", changes:{ company:"Z" } });
  await w.r2.put("updates/req/u_broken01.json", "{}", { customMetadata:{ v:"1" } });
  await w.r2.put("updates/req/not-a-uid.json", "{}", { customMetadata:{ memberId:"g3_m1", gid:"g3", at:"2026-01-01T00:00:00Z" } });
  const v = await call(w, "/member-updates", { session:sViewer });
  chk("viewer → 403", v._status === 403 && v.error === "read_only", brief(v));
  const own = await call(w, "/member-updates", { session:sOwner });
  chk("總管理員看到全部 3 筆,壞的 2 筆計入 unknown,不是 500", own._status === 200 && own.items.length === 3 && own.unknown === 2 &&
      own.openAll === 3 && own.truncated === false && own.max === 100 && own.perMemberMax === 3, brief(own));
  const la = await call(w, "/member-updates", { session:sA1 });
  chk("組長只看到自己組", la.ok && la.items.length === 2 && la.items.every(i => i.gid === "g3") && la.openAll === 3, brief(la));
  chk("★ 依 sat 排序(先收到但 sat 較晚的排後面)", la.ok && la.items[0].uid === y.uid && la.items[1].uid === x.uid);
  const it = la.items[1] || {};
  chk("清單項目欄位", it.code === "A1" && it.groupName === "肉品海鮮批發組" && it.groupMissing === false &&
      eq(it.fields, ["company"]) && it.busy === false && it.state === "open" && it.name === "曾俊凱", brief(it));
  chk("子請求 ≤ 7", la._cost <= 7 && own._cost <= 7, la._cost + " / " + own._cost);
  // 總管理員把 A1 改成 A9(gid 不變)
  const idx = IDX.map(e => e.id === "g3" ? Object.assign({}, e, { code:"A9" }) : e);
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(idx, null, 2) + "\n", "data/a9.json": w.gh.files().get("data/a1.json"), "data/a1.json": null }, "改代號");
  const l9 = await call(w, "/member-updates", { session:sA9 });
  chk("★ 改代號後,組長用新代號登入仍看得到,code 是新代號", l9.ok && l9.items.length === 2 && l9.items.every(i => i.code === "A9"), brief(l9));
  const lOld = await call(w, "/member-updates", { session:sA1 });
  chk("舊代號的 session → 409 group_renamed", lOld._status === 409 && lOld.error === "group_renamed", brief(lOld));
  void z;
}

/* ══ 13 ══ 讀一筆 */
hr("⑬ /member-update-get");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"讀取測試" } });
  const r = await call(w, "/member-update-get", { session:sA1, uid:a.uid });
  chk("自己組的組長讀得到原樣", r.ok && r.request.uid === a.uid && r.request.changes.company === "讀取測試", brief(r));
  const b = await call(w, "/member-update-get", { session:sB1, uid:a.uid });
  chk("組長讀別組 → 403 forbidden_group", b._status === 403 && b.error === "forbidden_group", brief(b));
  const c = await call(w, "/member-update-get", { session:sOwner, uid:"../pending/x" });
  chk("uid 含 ../ → 400", c._status === 400 && c.error === "bad_request", brief(c));
  const d = await call(w, "/member-update-get", { session:sOwner, uid:"u_nothere1" });
  chk("不存在 → 409 update_gone", d._status === 409 && d.error === "update_gone", brief(d));
  const e = await call(w, "/member-update-get", { session:sViewer, uid:a.uid });
  chk("viewer → 403", e._status === 403);
  const f = await call(w, "/member-update-get", { session:sOwner, uid:{ toString:null } });
  chk("★ uid 是怪物件 → 400 bad_request(不是 500)", f._status === 400 && f.error === "bad_request", brief(f));
  chk("子請求 ≤ 3", r._cost <= 3 && b._cost <= 3 && d._cost <= 3, [r._cost, b._cost, d._cost].join("/"));
}

/* ══ 14 ══ 套用 */
hr("⑭ /member-update-apply 正常:只改勾選的欄位");
{
  const w = world();
  const before = memberOf(w, "g3_m1");
  const a = await submit(w, { changes:{ company:"雲榮肉品有限公司", services:"冷藏/凍豬肉原料批發\n豬肉餡" } });
  const r = await apply(w, sA1, a.uid, { company:"replace", services:"skip" }, expectOf(w, "g3_m1", ["company"]));
  const after = memberOf(w, "g3_m1");
  chk("200 ok", r._status === 200 && r.ok === true && eq(r.applied, ["company"]) && r.code === "A1" && r.memberId === "g3_m1", brief(r));
  chk("只改勾選的欄位", after.company === "雲榮肉品有限公司" && eq(after.services, before.services) && after.title === before.title);
  chk("updatedAt 與 lastUpdateFrom 寫入", after.lastUpdateFrom === a.uid && after.updatedAt !== before.updatedAt &&
      Number.isFinite(Date.parse(after.updatedAt)));
  chk("R2 物件被刪", reqKeys(w).length === 0);
  const msg = (w.gh.commits.get(w.gh.head) || {}).message;
  chk("commit 訊息格式", msg === "夥伴資料更新：曾俊凱（A1・a1）", msg);
  chk("子請求 ≤ 50(組長)", r._cost <= 50, r._cost + " 個");
}

/* ══ 15 ══ 加在原本後面 */
hr("⑮ append:去重、超過 12 項截斷並回 warnings");
{
  const w = world();
  const a = await submit(w, { changes:{ services:"冷藏/凍豬肉原料批發\n豬肉餡" } });
  const r = await apply(w, sOwner, a.uid, { services:"append" }, expectOf(w, "g3_m1", ["services"]));
  chk("★ 舊 2 項 + 新 1 項(另一項重複)= 3 項", r.ok && eq(memberOf(w, "g3_m1").services,
      ["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切", "豬肉餡"]) && eq(r.warnings, []), brief(r));
  const b = await submit(w, { label:"A1・陳清單", name:"陳清單", changes:{ services:["新1","新2","新3","新4","新5","服務1"].join("\n") } });
  const r2 = await apply(w, sOwner, b.uid, { services:"append" }, expectOf(w, "g3_m6", ["services"]));
  const s = memberOf(w, "g3_m6").services;
  chk("★ 10 + 5 → 截到 12 項,warnings 記下被截掉的 3 項", r2.ok && s.length === 12 && s[10] === "新1" && s[11] === "新2" &&
      eq(r2.warnings, [{ field:"services", reason:"list_truncated", dropped:3 }]), brief(r2));
}

/* ══ 16 ══ expect */
hr("⑯ expect 對不上 → member_changed;別人改的是另一欄 → 照常套用");
{
  const w = world();
  const a = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"新水產" } });
  const head0 = w.gh.head;
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"審核者看到的舊值" });
  chk("★ 409 member_changed {fields}", r._status === 409 && r.error === "member_changed" && eq(r.fields, ["company"]), brief(r));
  chk("組檔沒有被動", w.gh.head === head0);
  chk("state 回到 open", reqOf(w, a.uid).state === "open" && w.r2.peekMeta(keyOf(a.uid)).state === "open");
  setMember(w, "a1", "g3_m9", { title:"別人改的職稱" });
  const r2 = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"大銘水產" });
  const m = memberOf(w, "g3_m9");
  chk("★ 別人改另一欄 → 照常套用,而且沒有蓋掉別人的修改", r2.ok && m.company === "新水產" && m.title === "別人改的職稱", brief(r2));
}

/* ══ 17 ══ 並行 */
hr("⑰ 並行:drop 與 apply、apply 與 apply");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"並行 1" } });
  const d = await call(w, "/member-update-drop", { session:sOwner, uid:a.uid });
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"" });
  chk("drop 先成功 → apply 拿到 update_gone", d.ok && r._status === 409 && r.error === "update_gone", brief(r));

  const b = await submit(w, { changes:{ company:"並行 2" } });
  let release, entered;
  const gate = new Promise(res => release = res), inPatch = new Promise(res => entered = res);
  w.gh.hooks.before = async (u, method) => { if(u.includes("/git/refs/") && method === "PATCH"){ entered(); await gate; } };
  const pApply = apply(w, sOwner, b.uid, { company:"replace" }, { company:"" }, {}, { track:false });
  await inPatch;
  const d2 = await call(w, "/member-update-drop", { session:sOwner, uid:b.uid });
  chk("★ apply 已上鎖 → drop 拿到 update_busy", d2._status === 409 && d2.error === "update_busy" && d2.state === "applying" && d2.lockBy === "owner", brief(d2));
  release();
  const rb = await pApply;
  w.gh.hooks.before = null;
  chk("apply 照常完成", rb.ok === true && memberOf(w, "g3_m1").company === "並行 2", brief(rb));

  const c = await submit(w, { changes:{ company:"並行 3" } });
  const n0 = commitsWith(w, "夥伴資料更新").length;
  /* 讓兩邊都先讀到同一版(同一個 etag)才放行,真正同時去搶鎖 ——
     少了這道柵欄,其中一邊多半在另一邊上鎖之後才讀到,測不出 CAS。 */
  const origGet = w.r2.get.bind(w.r2);
  let gets = 0, bothRead;
  const bothP = new Promise(res => bothRead = res);
  w.r2.get = async key => {
    const o = await origGet(key);
    if(key === keyOf(c.uid) && ++gets <= 2){ if(gets === 2) bothRead(); await bothP; }
    return o;
  };
  const [x, y] = await Promise.all([
    apply(w, sOwner, c.uid, { company:"replace" }, { company:"並行 2" }, {}, { track:false }),
    apply(w, sA1, c.uid, { company:"replace" }, { company:"並行 2" }, {}, { track:false }),
  ]);
  w.r2.get = origGet;
  const okN = [x, y].filter(o => o.ok).length;
  const loser = x.ok ? y : x;
  chk("★ 兩個 apply 同時讀到同一版 → 上鎖的 CAS 只讓一方過,只有一個 commit",
      gets >= 2 && okN === 1 && commitsWith(w, "夥伴資料更新").length - n0 === 1 && loser.error === "update_busy",
      `${brief(x)} / ${brief(y)}`);

  /* 批次不採用在 apply 上鎖之前列表、上鎖之後才刪(§3.10 接受的競態),而這次 apply 沒有成功。
     解鎖若是無條件 put,會把總管理員剛刪掉的請求救回來。 */
  const e = await submit(w, { changes:{ company:"並行 4" } });
  w.gh.hooks.before = async (u, method) => {
    if(u.includes("/git/refs/") && method === "PATCH"){
      w.r2.objects.delete(keyOf(e.uid)); w.r2.meta.delete(keyOf(e.uid));        // 批次不採用刪掉了
      w.gh.pushFiles({ "data.js":"sync " + Math.random() }, "同步 bot");          // 這一輪 ref_moved
    }
  };
  const re = await apply(w, sOwner, e.uid, { company:"replace" }, { company:"並行 3" });
  w.gh.hooks.before = null;
  chk("★ apply 期間請求被刪、apply 沒成功 → 解鎖不會把請求救回來(條件式 put)",
      re.error === "busy_retry_later" && reqOf(w, e.uid) === null, `${brief(re)} / 物件 ${reqOf(w, e.uid) ? "復活了" : "沒有復活"}`);
}

/* ══ 18 ══ commit 成功但清除失敗 */
hr("⑱ commit 成功但 delete 失敗 → cleanupFailed;再套用 → update_already_applied");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"清除失敗" } });
  w.r2.fail = { op:"delete", once:true };
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"" });
  chk("200 cleanupFailed", r.ok === true && r.cleanupFailed === true && memberOf(w, "g3_m1").company === "清除失敗", brief(r));
  chk("物件還在,鎖已解開(不必等 10 分鐘)", reqKeys(w).length === 1 && reqOf(w, a.uid).state === "open");
  const head0 = w.gh.head;
  const r2 = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"清除失敗" });
  chk("★ 再 apply → 409 update_already_applied,物件被清掉,沒有第二個 commit",
      r2._status === 409 && r2.error === "update_already_applied" && reqKeys(w).length === 0 && w.gh.head === head0, brief(r2));
}

/* ══ 19 ══ 輪數與預算 */
hr("⑲ 套用的輪數與子請求預算(組長,最壞情況)");
{
  const countRounds = w => { let n = 0; const prev = w.gh.hooks.before;
    w.gh.hooks.before = async (u, m, s) => { if(m === "GET" && u.includes("/contents/data/a1.json")) n++; if(prev) await prev(u, m, s); };
    return () => n; };
  for(const races of [0, 1, 2, 3]){
    const w = world();
    const a = await submit(w, { changes:{ company:"插隊 " + races } });
    let n = 0;
    w.gh.hooks.before = async (u, method) => {
      if(u.includes("/git/refs/") && method === "PATCH" && n < races){ n++; w.gh.pushFiles({ "data.js":"sync " + n }, "同步 bot"); }
    };
    const rounds = countRounds(w);
    const r = await apply(w, sA1, a.uid, { company:"replace" }, { company:"" });
    const okExpected = races < 3;
    chk(`(a) 同步 bot 插隊 ${races} 次 → ${okExpected ? "成功" : "busy_retry_later"};${rounds()} 輪;子請求 ${r._cost}`,
        (okExpected ? r.ok === true : (r._status === 409 && r.error === "busy_retry_later")) &&
        rounds() <= 3 && r._cost <= 50 && (okExpected || reqOf(w, a.uid).state === "open"), brief(r));
  }
  {
    const w = world();
    const a = await submit(w, { changes:{ company:"每輪都 stale" } });
    let n = 0;
    w.gh.hooks.before = async (u, method) => {
      // 每一輪讀完組檔、讀 head 之前,另一位組長都剛好發布了同組的另一位成員
      if(u.includes("/git/ref/heads/") && method === "GET"){ n++; setMember(w, "a1", "g3_m9", { title:"別人第 " + n + " 次發布" }); }
    };
    const rounds = countRounds(w);
    const r = await apply(w, sA1, a.uid, { company:"replace" }, { company:"" });
    chk(`(b) ★ 每一輪都 stale_base → 最多 3 輪(${rounds()})、回 stale_base、子請求 ${r._cost} ≤ 50、state 回 open`,
        r._status === 409 && r.error === "stale_base" && rounds() === 3 && r._cost <= 50 && reqOf(w, a.uid).state === "open" &&
        memberOf(w, "g3_m9").title === "別人第 3 次發布" && memberOf(w, "g3_m1").company === "", brief(r));
  }
  {
    const w = world();
    const a = await submit(w, { changes:{ company:"每輪都 ref_moved" } });
    w.gh.hooks.before = async (u, method) => {
      if(u.includes("/git/refs/") && method === "PATCH") w.gh.pushFiles({ "data.js":"sync " + Math.random() }, "同步 bot");
    };
    const rounds = countRounds(w);
    const r = await apply(w, sA1, a.uid, { company:"replace" }, { company:"" });
    chk(`(c) ★ 每一輪都 ref_moved → 3 輪(${rounds()})、busy_retry_later、子請求 ${r._cost} ≤ 50、state 回 open`,
        r._status === 409 && r.error === "busy_retry_later" && rounds() === 3 && r._cost <= 50 &&
        reqOf(w, a.uid).state === "open", brief(r));
  }
}

/* ══ 20 ══ 改代號 / 分組被刪 / 成員被刪 */
hr("⑳ 送出後改了組代號、分組被刪、成員被刪");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"改代號之後" } });
  const idx = IDX.map(e => e.id === "g3" ? Object.assign({}, e, { code:"A9" }) : e);
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(idx, null, 2) + "\n", "data/a9.json": w.gh.files().get("data/a1.json"), "data/a1.json": null }, "改代號");
  const old = await apply(w, sA1, a.uid, { company:"replace" }, { company:"" });
  const oldGet = await call(w, "/member-update-get", { session:sA1, uid:a.uid });
  chk("舊代號的組長 → 409 group_renamed(不是「沒有權限」),而且沒有上鎖",
      old._status === 409 && old.error === "group_renamed" && oldGet.error === "group_renamed" && reqOf(w, a.uid).state === "open", brief(old));
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"" });
  chk("★ 依 gid 找到新檔並成功", r.ok && r.code === "A9" && memberOf(w, "g3_m1", "a9").company === "改代號之後", brief(r));
  const r9 = await apply(w, sA9, (await submit(w, { label:"A9・王大銘", name:"王大銘", group:"A9", changes:{ company:"A9 組長" } })).uid,
    { company:"replace" }, { company:"大銘水產" });
  chk("新代號的組長可以套用", r9.ok === true, brief(r9));

  const b = await submit(w, { label:"B1・陳大文", name:"陳大文", group:"B1", changes:{ company:"分組被刪" } });
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(idx.filter(e => e.id !== "g12"), null, 2) + "\n", "data/b1.json": null }, "刪分組");
  const rb = await apply(w, sOwner, b.uid, { company:"replace" }, { company:"" });
  chk("分組被刪 → 409 group_missing", rb._status === 409 && rb.error === "group_missing", brief(rb));

  const c = await submit(w, { label:"A9・林小美", name:"林小美", group:"A9", changes:{ company:"成員被刪" } });
  const g = JSON.parse(w.gh.files().get("data/a9.json"));
  w.gh.pushFiles({ "data/a9.json": grpJson(g.members.filter(m => m.id !== "g3_m2")) }, "刪成員");
  const rc = await apply(w, sOwner, c.uid, { company:"replace" }, { company:"" });
  chk("成員被刪 → 409 member_missing,並解鎖", rc._status === 409 && rc.error === "member_missing" && reqOf(w, c.uid).state === "open", brief(rc));
}

/* ══ 21 ══ 權限與參數 */
hr("㉑ 權限與參數");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"參數", services:"新服務" } });
  const ex = expectOf(w, "g3_m1", ["company","services"]);
  const v = await apply(w, sViewer, a.uid, { company:"replace" }, ex);
  chk("viewer → 403", v._status === 403 && v.error === "read_only", brief(v));
  const b = await apply(w, sB1, a.uid, { company:"replace" }, ex);
  chk("組長套用別組 → 403 forbidden_group", b._status === 403 && b.error === "forbidden_group", brief(b));
  const c1 = await apply(w, sOwner, a.uid, { hack:"replace" }, ex);
  const raw = JSON.stringify({ session:sOwner, uid:a.uid, expect:ex }).replace(/\}$/, ',"choices":{"constructor":"replace"}}');
  const c2 = await call(w, "/member-update-apply", raw);
  const c3 = await apply(w, sOwner, a.uid, { company:"append" }, ex);
  const c4 = await apply(w, sOwner, a.uid, { title:"replace" }, ex);
  const c5 = await apply(w, sOwner, a.uid, { company:"delete" }, ex);
  chk("★ 白名單以外、constructor、文字欄位 append、這筆沒有的欄位、不認得的動作 → 400 bad_choice",
      [c1, c2, c3, c4, c5].every(r => r._status === 400 && r.error === "bad_choice"), [c1, c2, c3, c4, c5].map(r => r.error).join(","));
  const c6 = await apply(w, sOwner, a.uid, { company:"replace" }, {});
  chk("沒帶 expect → 400 bad_choice", c6._status === 400 && c6.error === "bad_choice", brief(c6));
  const d = await apply(w, sOwner, a.uid, { company:"skip", services:"skip" }, {});
  chk("全部 skip → 400 nothing_selected", d._status === 400 && d.error === "nothing_selected", brief(d));
  const e = await apply(w, sOwner, a.uid, [], ex);
  chk("choices 不是物件 → 400 bad_request", e._status === 400 && e.error === "bad_request", brief(e));
  const f = await apply(w, sOwner, { toString:null }, { company:"replace" }, ex);
  chk("★ uid 是怪物件 → 400 bad_request(不是 500)", f._status === 400 && f.error === "bad_request", brief(f));
  chk("以上都沒有上鎖", reqOf(w, a.uid).state === "open");
}

/* ══ 22 ══ 資料需確認 */
hr("㉒ clearDataIssue:只會取消、不會設成 true");
{
  const w = world();
  const a = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ company:"小美蔬果行" } });
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"" }, { clearDataIssue:true });
  chk("true 而且原本是 true → false", r.ok && r.dataIssueCleared === true && memberOf(w, "g3_m2").dataIssue === false, brief(r));
  const w2 = world();
  const b = await submit(w2, { label:"A1・林小美", name:"林小美", changes:{ company:"小美蔬果行" } });
  const r2 = await apply(w2, sOwner, b.uid, { company:"replace" }, { company:"" });
  chk("不帶旗標 → 不變", r2.ok && r2.dataIssueCleared === false && memberOf(w2, "g3_m2").dataIssue === true, brief(r2));
  const c = await submit(w2, { changes:{ company:"凱的公司" } });
  const r3 = await apply(w2, sOwner, c.uid, { company:"replace" }, { company:"" }, { clearDataIssue:true });
  chk("原本是 false → 不變(永遠不會設成 true)", r3.ok && r3.dataIssueCleared === false && memberOf(w2, "g3_m1").dataIssue === false, brief(r3));
}

/* ══ 23 ══ 壞檔 */
hr("㉓ 同組另一位成員的 products 是字串(壞檔)→ bad_data_file,不 commit");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"壞檔測試" } });
  setMember(w, "a1", "g3_m9", { products:"不是陣列" });
  const head0 = w.gh.head;
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"" });
  chk("400 bad_data_file", r._status === 400 && r.error === "bad_data_file" && /products/.test(r.reason || ""), brief(r));
  chk("沒有 commit,state 回 open", w.gh.head === head0 && reqOf(w, a.uid).state === "open");
}

/* ══ 24 ══ 沒有實際變化 */
hr("㉔ 勾選的值和現值一樣 → no_effective_change");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"已經一樣" } });
  setMember(w, "a1", "g3_m1", { company:"已經一樣" });
  const head0 = w.gh.head;
  const r = await apply(w, sOwner, a.uid, { company:"replace" }, { company:"已經一樣" });
  chk("409 no_effective_change,不 commit", r._status === 409 && r.error === "no_effective_change" && w.gh.head === head0, brief(r));
}

/* ══ 25 ══ 不採用 / 已處理 */
hr("㉕ /member-update-drop");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"不採用" } });
  const r = await call(w, "/member-update-drop", { session:sA1, uid:a.uid });
  chk("正常 → 物件刪掉", r.ok === true && reqKeys(w).length === 0, brief(r));
  chk("子請求 ≤ 5", r._cost <= 5, r._cost + " 個");
  const again = await call(w, "/member-update-drop", { session:sA1, uid:a.uid });
  chk("已經刪掉 → 409 update_gone", again._status === 409 && again.error === "update_gone", brief(again));
  const b = await submit(w, { changes:{ company:"處理中" } });
  await forceState(w, b.uid, "applying");
  const rb = await call(w, "/member-update-drop", { session:sOwner, uid:b.uid });
  chk("applying 中 → 409 update_busy", rb._status === 409 && rb.error === "update_busy" && rb.lockBy === "someone", brief(rb));
  const c = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"別組組長" } });
  const rc = await call(w, "/member-update-drop", { session:sB1, uid:c.uid });
  chk("組長刪別組 → 403", rc._status === 403 && rc.error === "forbidden_group" && reqOf(w, c.uid) !== null, brief(rc));
  const rv = await call(w, "/member-update-drop", { session:sViewer, uid:c.uid });
  chk("viewer → 403", rv._status === 403);
  const rw = await call(w, "/member-update-drop", { session:sOwner, uid:{ toString:null } });
  chk("★ uid 是怪物件 → 400 bad_request(不是 500)", rw._status === 400 && rw.error === "bad_request" && reqOf(w, c.uid) !== null, brief(rw));
}

/* ══ 26 ══ /ping */
hr("㉖ /ping:caps.memberUpdate 跟著 PENDING_IMAGES、memberUpdateSite");
{
  const w = world();
  const p = await call(w, "/ping", {});
  chk("綁了 R2 → caps.memberUpdate true,memberUpdateSite 由 GH_OWNER/GH_REPO 推出",
      p.caps && p.caps.memberUpdate === true && p.memberUpdateSite === "https://o.github.io/R/", brief(p));
  const w2 = world({ env:{ SITE_BASE:"https://example.org/dir" } });
  const p2 = await call(w2, "/ping", {});
  chk("有設 SITE_BASE → 用它(補結尾 /)", p2.memberUpdateSite === "https://example.org/dir/", p2.memberUpdateSite);
  const w3 = world({ env:{ PENDING_IMAGES: undefined } });
  const p3 = await call(w3, "/ping", {});
  chk("沒綁 R2 → false,不回 memberUpdateSite", p3.caps.memberUpdate === false && !("memberUpdateSite" in p3), brief(p3));
  chk("★ caps.memberUpdatePhotos 跟著 PENDING_IMAGES(綁了 true、沒綁 false)",
      p.caps.memberUpdatePhotos === true && p3.caps.memberUpdatePhotos === false, brief(p3.caps));
  // 有設 SITE_BASE 時,收件真的去讀那個網站(假 GitHub 認得任何 *.github.io/<repo>/)
  const w4 = world({ env:{ SITE_BASE:"https://other.github.io/R2/" } });
  let seen = "";
  w4.gh.hooks.before = async u => { if(u.includes("github.io")) seen = u; };
  await submit(w4, { changes:{ company:"site base" } });
  chk("收件讀的是 SITE_BASE", seen.startsWith("https://other.github.io/R2/data/"), seen);
}

/* ══ 27 ══ 回歸:/publish 不傳 maxTries */
hr("㉗ 回歸:/publish 不傳 maxTries 時仍然重試 3 次");
{
  for(const races of [2, 3]){
    const w = world();
    let n = 0;
    w.gh.hooks.before = async (u, method) => {
      if(u.includes("/git/refs/") && method === "PATCH" && n < races){ n++; w.gh.pushFiles({ "data.js":"sync " + n }); }
    };
    const cur = w.gh.files().get("data/b1.json");
    const g = JSON.parse(cur); g.leader = "新組長";
    const r = await call(w, "/publish", { session:sOwner, baseBlobShas:{ "data/b1.json": blobShaOf(cur) },
      files:[{ path:"data/b1.json", contentB64: Buffer.from(grpJson(g.members).replace('"組長"', '"新組長"')).toString("base64") }] });
    chk(`ref 被搶 ${races} 次 → ${races < 3 ? "第 3 次成功" : "busy_retry_later"}`,
        races < 3 ? r.ok === true : r.error === "busy_retry_later", brief(r));
  }
}

/* ══ 28 ══ 連結代碼:舊連結再填一次 */
hr("㉘ ★ 連結代碼:用 admin-logic 產生 10/1 的連結,套用之後再用同一條連結送一次");
{
  const w = world();
  const m0 = memberOf(w, "g3_m1");
  const pv = AL.memberPrefillValues("A1", m0);           // 10/1 組長複製的連結
  chk("admin-logic 產生的預填值有代碼", /^v1\.g3_m1\.[0-9a-f]{72}$/.test(pv.token || ""), pv.token);
  // 第一次:夥伴把服務項目改成 3 項
  const r1 = await submit(w, fromLink(pv, "曾俊凱", { services: pv.services + "\n豬肉餡" }));
  chk("第一次:只有 services 是修改,其他連結帶入的格子都是 untouched",
      r1.ok && eq(r1.fields, ["services"]) && eq(r1.untouched, ["title","targets","tagline"]) && reqOf(w, r1.uid).tokenUsed === true, brief(r1));
  const ap = await apply(w, sOwner, r1.uid, { services:"replace" }, expectOf(w, "g3_m1", ["services"]));
  chk("套用之後網站上是 3 項", ap.ok && memberOf(w, "g3_m1").services.length === 3, brief(ap));
  // 第二次:同一條 10/1 連結,服務項目維持連結帶入的 2 項、職稱維持舊值,只改 slogan
  const r2 = await submit(w, fromLink(pv, "曾俊凱", { tagline:"國產豬肉專門家\n新的一句" }));
  const q2 = r2.ok ? reqOf(w, r2.uid) : {};
  chk("★ changes 只有 tagline", r2.ok && eq(r2.fields, ["tagline"]) && eq(Object.keys(q2.changes), ["tagline"]), brief(r2));
  chk("★ untouched 含 services 與 title", r2.ok && r2.untouched.includes("services") && r2.untouched.includes("title"), brief(r2.untouched));
  chk("★ R2 裡的請求不含 services(不會把 3 項改回 2 項)", r2.ok && !("services" in q2.changes) && !("services" in q2.base));
  chk("tagline 在連結發出後沒變過 → 不是 stalePrefill", r2.ok && eq(r2.stalePrefill, []));
  // 同一條連結,這次公司也改
  const r3 = await submit(w, fromLink(pv, "曾俊凱", { company:"雲榮肉品" }));
  chk("改公司 → changes 只有 company", r3.ok && eq(r3.fields, ["company"]), brief(r3));

  /* ══ 29 ══ */
  hr("㉙ 代碼某一格被改,而且網站上這一欄在連結產生後變過 → stalePrefill");
  const r4 = await submit(w, fromLink(pv, "曾俊凱", { services:"全新項目甲\n全新項目乙" }));
  chk("★ services 在 changes 裡,也在 stalePrefill 裡", r4.ok && r4.fields.includes("services") && r4.stalePrefill.includes("services") &&
      reqOf(w, r4.uid).stalePrefill.includes("services"), brief(r4));
}

/* ══ 30 ══ 本人清空、代碼格式錯誤 */
hr("㉚ 本人清空(cleared);代碼格式錯誤 → 當成沒有代碼");
{
  const w = world();
  const m0 = memberOf(w, "g3_m1");
  const pv = AL.memberPrefillValues("A1", m0);
  const a = await submit(w, fromLink(pv, "曾俊凱", { title:"", company:"新公司" }));
  chk("★ 代碼記的格子有內容、送來是空的、網站上有內容 → cleared", a.ok && eq(a.cleared, ["title"]) &&
      eq(reqOf(w, a.uid).cleared, [{ field:"title" }]) && !("title" in reqOf(w, a.uid).changes), brief(a));
  const pvX = AL.memberPrefillValues("A1", Object.assign({}, m0, { website:"https://old.example.com" }));
  const b = await submit(w, fromLink(pvX, "曾俊凱", { website:"", company:"另一間公司" }));
  chk("網站上目前是空的 → 不算 cleared", b.ok && !b.cleared.includes("website"), brief(b));
  const c = await submit(w, fromLink(pv, "曾俊凱", { title:"", tagline:"" }));
  chk("只有清空(沒有其他修改)也會建一筆", c.ok && eq(c.cleared, ["title","tagline"]) && eq(c.fields, []), brief(c));

  const variants = [
    ["少一碼", pv.token.slice(0, -1)],
    ["多一段", pv.token + ".x"],
    ["大寫 hex", pv.token.replace(/\.([0-9a-f]{72})$/, (_, h) => "." + h.toUpperCase().replace(/^0/, "A"))],
  ];
  for(const [label, tok] of variants){
    const w2 = world();
    setMember(w2, "a1", "g3_m1", { services:["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切", "豬肉餡"] });
    const r = await submit(w2, Object.assign(fromLink(pv, "曾俊凱"), { linkToken: tok }));
    const q = r.ok ? reqOf(w2, r.uid) : {};
    chk("代碼" + label + " → 當成沒有代碼,照現值比對", r.ok && eq(r.untouched, []) && eq(r.fields, ["services"]) && q.tokenUsed === false, brief(r));
  }
}

/* ══ 31 ══ 改名 */
hr("㉛ 改名:代碼的 memberId 找得到人 → 用它並記 nameMismatch;不是這一組的 → 照姓名比對");
{
  const w = world();
  const pv = AL.memberPrefillValues("A1", memberOf(w, "g3_m9"));       // 名錄上叫「王大銘」
  const r = await submit(w, Object.assign(fromLink(pv, "王大明", { company:"改名後的水產" }), { label:"A1・王大明" }));
  const q = r.ok ? reqOf(w, r.uid) : {};
  chk("★ 200,memberId 是 g3_m9,有 nameMismatch", r.ok && r.memberId === "g3_m9" &&
      eq(q.nameMismatch, { picked:"王大明", current:"王大銘" }), brief(r));
  const pvB = AL.memberPrefillValues("B1", memberOf(w, "g12_m1"));
  const r2 = await submit(w, Object.assign(fromLink(pvB, "曾俊凱", { company:"別組代碼" }), { label:"A1・曾俊凱", group:"A1" }));
  chk("代碼的 memberId 不是以這一組的 gid 開頭 → 不採用,照姓名比對", r2.ok && r2.memberId === "g3_m1" &&
      reqOf(w, r2.uid).nameMismatch === null, brief(r2));
  const r3 = await submit(w, { label:"A1・王大明", name:"王大明", changes:{ company:"沒有代碼" } });
  chk("沒有代碼時,舊名字找不到人 → member_not_found", r3.error === "member_not_found", brief(r3));
}

/* ══ 32 ══ 去重 */
hr("㉜ 去重:同一個 responseId、同一位同內容、去重排在計數之前");
{
  const w = world();
  const a = await submit(w, { responseId:"R-1", changes:{ company:"去重" } });
  const b = await submit(w, { responseId:"R-1", changes:{ company:"去重" } });
  chk("★ 同一個 responseId → duplicate,R2 只有 1 個", b.ok && b.duplicate === true && b.uid === a.uid && reqKeys(w).length === 1, brief(b));
  const c = await submit(w, { responseId:"R-2", changes:{ company:"去重" } });
  chk("responseId 不同但內容相同(提交其他回應)→ duplicate", c.duplicate === true && c.uid === a.uid && reqKeys(w).length === 1, brief(c));
  await submit(w, { responseId:"R-3", changes:{ company:"第二筆" } });
  await submit(w, { responseId:"R-4", changes:{ company:"第三筆" } });
  const d = await submit(w, { responseId:"R-3", changes:{ company:"補送時內容變了" } });
  chk("★ 已經有 3 筆,其中一筆同 rid → duplicate(不是 too_many)", d.duplicate === true && reqKeys(w).length === 3, brief(d));
  const e = await submit(w, { responseId:"R-5", changes:{ company:"第四筆" } });
  chk("真的第 4 筆 → too_many_updates_for_member", e.error === "too_many_updates_for_member", brief(e));
}

/* ══ 33 ══ sat */
hr("㉝ sat:夥伴按送出的時間");
{
  const w = world();
  const day = 86400000;
  const t3 = new Date(Date.now() - 3 * day).toISOString();
  const a = await submit(w, { submittedAt:t3, changes:{ company:"三天前" } });
  chk("3 天前 → sat 是 3 天前", a.ok && reqOf(w, a.uid).sat === t3 && w.r2.peekMeta(keyOf(a.uid)).sat === t3 && reqOf(w, a.uid).at !== t3);
  for(const [label, v] of [["200 天前", new Date(Date.now() - 200 * day).toISOString()],
                           ["未來 1 小時", new Date(Date.now() + 3600000).toISOString()], ["亂碼", "昨天下午"]]){
    const w2 = world();
    const r = await submit(w2, { submittedAt:v, changes:{ company:label } });
    const q = r.ok ? reqOf(w2, r.uid) : {};
    chk(label + " → sat 等於 at", r.ok && q.sat === q.at, `${q.sat} / ${q.at}`);
  }
  const w3 = world();
  const late = await submit(w3, { submittedAt:new Date(Date.now() - 1 * day).toISOString(), changes:{ company:"先收到但較晚填" } });
  const early = await submit(w3, { label:"A1・王大銘", name:"王大銘", submittedAt:new Date(Date.now() - 2 * day).toISOString(), changes:{ company:"補送的較早填" } });
  const l = await call(w3, "/member-updates", { session:sOwner });
  chk("★ 先送 sat 較晚的、再補送 sat 較早的 → 清單依 sat 排序", l.ok && l.items[0].uid === early.uid && l.items[1].uid === late.uid, brief(l.items));
  chk("回應的 oldestAt 是最舊的 sat", early.oldestAt === reqOf(w3, early.uid).sat, early.oldestAt);
}

/* ══ 34 ══ 截斷 */
hr("㉞ 截斷:比對用完整內容,寫入時才截,並記進 truncated");
{
  const w = world();
  const a = await submit(w, { changes:{ business_items:"營".repeat(600) } });
  const q = a.ok ? reqOf(w, a.uid) : {};
  chk("business_items 600 字 → 存 400 字,truncated {600, 400, 字}", a.ok && q.changes.business_items.length === 400 &&
      eq(q.truncated, [{ field:"business_items", total:600, kept:400, unit:"字" }]) && eq(a.truncated, ["business_items"]), brief(a));
  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ services: Array.from({ length:15 }, (_, i) => "行" + i).join("\n") } });
  const qb = b.ok ? reqOf(w, b.uid) : {};
  chk("服務項目 15 行 → 12 項,truncated {15, 12, 項}", b.ok && qb.changes.services.length === 12 &&
      eq(qb.truncated, [{ field:"services", total:15, kept:12, unit:"項" }]), brief(b));
  const cur = memberOf(w, "g3_m5").services;
  const changed = cur.slice(0, 13).concat(["改過的第 14 項"]);
  const c = await submit(w, { label:"A1・張多項", name:"張多項", changes:{ services: changed.join("\n") } });
  chk("★ 現值 14 項、只改第 14 項 → 不是 unchanged(比對不截斷)", c.ok && !c.unchanged && eq(c.fields, ["services"]), brief(c));
  const d = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ services:["一", "長".repeat(450)].join("\n") } });
  chk("單項超過 400 字 → truncated {450, 400, 字}", d.ok && eq(reqOf(w, d.uid).truncated, [{ field:"services", total:450, kept:400, unit:"字" }]), brief(d));
}

/* ══ 35 ══ confirmOnly */
hr("㉟ 資料需確認的夥伴確認沒有要改 → confirmOnly");
{
  const w = world();
  const a = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ title:"蔬果" } });
  const meta = a.ok ? w.r2.peekMeta(keyOf(a.uid)) : {};
  chk("★ dataIssue 為 true、內容沒改 → R2 有 1 筆 confirmOnly", a.ok && a.confirmOnly === true && reqKeys(w).length === 1 &&
      reqOf(w, a.uid).confirmOnly === true && meta.confirm === "1" && meta.fields === "", brief(a));
  const b = await submit(w, { changes:{ title:"豬肉屠宰批發零售" } });
  chk("dataIssue 為 false、內容沒改 → unchanged", b.unchanged === true && reqKeys(w).length === 1, brief(b));
  const n = await apply(w, sA1, a.uid, {}, {});
  chk("choices:{} 又沒勾 clearDataIssue → nothing_selected", n._status === 400 && n.error === "nothing_selected", brief(n));
  const r = await apply(w, sA1, a.uid, {}, {}, { clearDataIssue:true });
  chk("★ choices:{} + clearDataIssue → dataIssue 變成 false", r.ok && r.dataIssueCleared === true &&
      memberOf(w, "g3_m2").dataIssue === false && memberOf(w, "g3_m2").lastUpdateFrom === a.uid && reqKeys(w).length === 0, brief(r));
}

/* ══ 36 ══ pickedLabel */
hr("㊱ pickedLabel");
{
  const w = world();
  const a = await submit(w, { pickedLabel:"B1・曾俊凱", changes:{ company:"改送" } });
  chk("有帶 → 存進請求", a.ok && reqOf(w, a.uid).pickedLabel === "B1・曾俊凱", brief(a));
  const b = await submit(w, { pickedLabel:"<script>", changes:{ company:"格式不對" } });
  chk("格式不對 → 空字串", b.ok && reqOf(w, b.uid).pickedLabel === "", brief(b));
}

/* ══ 37 ══ 公開網站 */
hr("㊲ 公開網站讀不到 / Pages 還是舊版");
{
  const w = world();
  w.gh.failPages = true;
  const r = await submit(w, { changes:{ company:"x" } });
  chk("★ failPages → 502 site_unreachable,R2 沒有寫入", r._status === 502 && r.error === "site_unreachable" &&
      !r._r2.some(c => c.op === "put") && reqKeys(w).length === 0, brief(r));
  const w2 = world();
  const old = w2.gh.head;
  setMember(w2, "a1", "g3_m1", { company:"API 上的新值" });
  w2.gh.pagesCommit = old;
  const r2 = await submit(w2, { changes:{ company:"夥伴寫的" } });
  chk("Pages 是舊版 → 仍然收件成功,base 是舊版的值", r2.ok && reqOf(w2, r2.uid).base.company === "" && r2._api === 0, brief(r2));
  const ap = await apply(w2, sOwner, r2.uid, { company:"replace" }, { company:"" });
  chk("套用時用 API 重讀 → 審核者看的舊值對不上就停下", ap.error === "member_changed", brief(ap));
  const w3 = world();
  w3.gh.pushFiles({ "data/a1.json": "{這不是 JSON" });
  const r3 = await submit(w3, { changes:{ company:"x" } });
  chk("組檔不是 JSON → 502 group_unreadable", r3._status === 502 && r3.error === "group_unreadable", brief(r3));
}

/* ══ 38 ══ ref PATCH 丟例外 */
hr("㊳ 套用時 ref PATCH 丟例外(回應逾時)");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"逾時" } });
  w.gh.hooks.refPatchThrow = { once:true, move:false };
  const head0 = w.gh.head;
  const r = await apply(w, sA1, a.uid, { company:"replace" }, { company:"" });
  chk("★ 502 apply_uncertain,state 回到 open", r._status === 502 && r.error === "apply_uncertain" &&
      reqOf(w, a.uid).state === "open" && w.gh.head === head0, brief(r));
  chk("子請求 ≤ 50", r._cost <= 50, r._cost + " 個");
  const w2 = world();
  const b = await submit(w2, { changes:{ company:"其實寫進去了" } });
  w2.gh.hooks.refPatchThrow = { once:true, move:true };
  const r2 = await apply(w2, sA1, b.uid, { company:"replace" }, { company:"" });
  chk("ref 其實已經移動 → 仍然回 apply_uncertain(不說沒有寫入)", r2.error === "apply_uncertain" &&
      memberOf(w2, "g3_m1").lastUpdateFrom === b.uid && reqOf(w2, b.uid).state === "open", brief(r2));
  const head1 = w2.gh.head;
  const r3 = await apply(w2, sA1, b.uid, { company:"replace" }, { company:"" });
  chk("★ 再 apply 一次 → 409 update_already_applied,不重複寫入,物件清掉",
      r3._status === 409 && r3.error === "update_already_applied" && w2.gh.head === head1 && reqKeys(w2).length === 0, brief(r3));
  chk("子請求 ≤ 50", r2._cost <= 50 && r3._cost <= 50, r2._cost + " / " + r3._cost);
}

/* ══ 39 ══ 批次不採用 */
hr("㊴ /member-update-drop-batch");
{
  const w = world();
  const uids = [];
  for(const [name, code] of [["曾俊凱","A1"],["王大銘","A1"],["林小美","A1"],["陳大文","B1"]]){
    uids.push((await submit(w, { label:code + "・" + name, name, group:code, changes:{ company:"灌單 " + name } })).uid);
  }
  await forceState(w, uids[1], "applying");
  const l = await call(w, "/member-update-drop-batch", { session:sA1, uids });
  const v = await call(w, "/member-update-drop-batch", { session:sViewer, uids });
  chk("組長、viewer → 403 admin_only", l._status === 403 && l.error === "admin_only" && v._status === 403 && v.error === "admin_only");
  const big = await call(w, "/member-update-drop-batch", { session:sOwner, uids: Array.from({ length:101 }, (_, i) => "u_many" + String(i).padStart(4, "0")) });
  const dot = await call(w, "/member-update-drop-batch", { session:sOwner, uids:[uids[0], "../pending/x"] });
  const empty = await call(w, "/member-update-drop-batch", { session:sOwner, uids:[] });
  chk("超過 100 個、含 ../、空陣列 → 400", [big, dot, empty].every(r => r._status === 400 && r.error === "bad_request"));
  chk("以上都沒有刪任何東西", reqKeys(w).length === 4);
  const r = await call(w, "/member-update-drop-batch", { session:sOwner, uids: uids.concat(["u_nothere99"]) });
  chk("★ 5 筆(1 筆上鎖、1 筆不存在)→ dropped 3、skipped 2", r.ok && r.dropped === 3 && eq(r.skipped.slice().sort(), [uids[1], "u_nothere99"].sort()), brief(r));
  const dels = r._r2.filter(c => c.op === "delete");
  chk("★ R2 delete 只被呼叫 1 次(陣列)", dels.length === 1 && Array.isArray(dels[0].key) && dels[0].key.length === 3);
  chk("上鎖中的那筆還在", eq(reqKeys(w), [keyOf(uids[1])]));
  chk("子請求 ≤ 6", r._cost <= 6, r._cost + " 個");
}

/* ══ 照片 ══════════════════════════════════════════════════════════════════
   測試用的照片是「可列印 ASCII」的位元組:假 GitHub 把 blob 當 UTF-8 字串存,
   非 ASCII 會失真,就沒辦法逐位元組比對寫進 repo 的圖檔。seed 不同 → 內容與 sha256 不同。 */
const imgBytes = (seed, n = 600) => Buffer.from(Array.from({ length:n }, (_, i) => 32 + ((i * 7 + seed * 13) % 95)));
const dataUrl = (bytes, mime = "image/jpeg") => "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64");
const IMG = (seed, n, mime) => dataUrl(imgBytes(seed, n), mime);
const shaOf = b => crypto.createHash("sha256").update(b).digest("hex");
const imgKeys = w => w.r2.keys().filter(k => k.startsWith("updates/img/"));
/* 請求被刪掉時 reqOf 是 null —— 用這支讀 state,斷言失敗時才不會變成整支測試丟例外。 */
const stateOf = (w, uid) => (reqOf(w, uid) || {}).state;
const imgKeysOf = (w, uid) => imgKeys(w).filter(k => k.startsWith("updates/img/" + uid + "/"));
/* 直接改 R2 裡的請求 JSON(模擬被寫壞或被動過手腳),metadata 原樣帶回去。 */
async function patchReq(w, uid, fn){
  const key = keyOf(uid), q = w.r2.peekJson(key), meta = w.r2.peekMeta(key);
  if(!q) return;                          // 請求已經不在(前面的斷言已經失敗):不要讓整支測試丟例外
  fn(q);
  await w.r2.put(key, JSON.stringify(q), { httpMetadata:{ contentType:"application/json" }, customMetadata:meta });
}
/* /member-update-photo 回的是圖片位元組(錯誤時才是 JSON),所以另外一支:保留標頭與原始位元組。 */
async function callPhoto(w, body){
  const s0 = w.gh.subrequests, r0 = w.r2.calls.length, k0 = w.kv.calls;
  const res = await W.__worker.fetch(new Request("https://w.test/member-update-photo", { method:"POST",
    headers:{ "Content-Type":"application/json", "CF-Connecting-IP":"1.2.3.4" }, body: JSON.stringify(body) }), w.env);
  const buf = Buffer.from(await res.arrayBuffer());
  let out = {};
  if((res.headers.get("Content-Type") || "").startsWith("application/json")){ try{ out = JSON.parse(buf.toString("utf8")); }catch(e){} }
  out._status = res.status; out._headers = res.headers; out._bytes = buf;
  out._cost = (w.gh.subrequests - s0) + (w.r2.calls.length - r0) + (w.kv.calls - k0);
  out._r2 = w.r2.calls.slice(r0);
  maxCost["/member-update-photo"] = Math.max(maxCost["/member-update-photo"] || 0, out._cost);
  return out;
}

/* ══ 40 ══ 收件帶照片 */
hr("㊵ 收件帶照片:R2 物件在 updates/img/<uid>/、請求 JSON 只留引用、metadata 有照片欄位");
{
  const w = world();
  const P = { image: imgBytes(1), card: imgBytes(2), p0: imgBytes(3), p1: imgBytes(4, 700) };
  const r = await submit(w, { changes:{ company:"有照片的公司" }, photos:{ image: dataUrl(P.image), card: dataUrl(P.card),
    products:[dataUrl(P.p0), dataUrl(P.p1, "image/png")] } });
  chk("200 ok,回應 photos = 4,fields 仍然只有文字欄位", r.ok === true && r.photos === 4 && eq(r.fields, ["company"]), brief(r));
  const base = "updates/img/" + r.uid + "/";
  const want = { image: base + "image-" + shaOf(P.image).slice(0, 16) + ".jpg", card: base + "card-" + shaOf(P.card).slice(0, 16) + ".jpg",
                 p0: base + "product-0-" + shaOf(P.p0).slice(0, 16) + ".jpg", p1: base + "product-1-" + shaOf(P.p1).slice(0, 16) + ".png" };
  chk("★ R2 有 4 張照片,key = updates/img/<uid>/<欄位>[-<索引>]-<sha256 前 16>.<副檔名>",
      eq(imgKeys(w), Object.values(want).sort()), imgKeys(w).join(" "));
  chk("照片位元組原樣、contentType 依 mime", Buffer.from(w.r2.objects.get(want.image) || []).equals(P.image) &&
      Buffer.from(w.r2.objects.get(want.p1) || []).equals(P.p1) && (w.r2.meta.get(want.p1) || {}).contentType === "image/png" &&
      (w.r2.meta.get(want.card) || {}).contentType === "image/jpeg");
  const q = reqOf(w, r.uid);
  const ref = (k, b, mime) => ({ key:k, mime, bytes:b.length, sha256:shaOf(b) });
  chk("★ 請求 JSON 的 photos = { image, card, products:[…] },ref = {key, mime, bytes, sha256}",
      eq(q.photos, { image: ref(want.image, P.image, "image/jpeg"), card: ref(want.card, P.card, "image/jpeg"),
                     products:[ref(want.p0, P.p0, "image/jpeg"), ref(want.p1, P.p1, "image/png")] }), brief(q.photos));
  chk("請求 JSON 裡沒有 data URL", !JSON.stringify(q).includes("base64"));
  const meta = w.r2.peekMeta(keyOf(r.uid));
  chk("★ metadata fields = 文字欄位 + image,card,products", meta.fields === "company,image,card,products", meta.fields);
  const puts = r._r2.filter(c => c.op === "put").map(c => c.key);
  chk("先寫照片、最後才寫請求(清單上看得到的請求,照片一定已經在了)", puts.length === 5 && puts[4] === keyOf(r.uid) &&
      puts.slice(0, 4).every(k => k.startsWith(base)), puts.join(" "));
  chk("收件仍然不打 GitHub API;子請求 ≤ 18", r._api === 0 && r._cost <= 18, `api=${r._api} cost=${r._cost}`);

  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{}, photos:{ products:[IMG(5)] } });
  chk("★ 只傳照片(文字全空)也收件,不是 nothing_to_update", b.ok && b.photos === 1 && eq(b.fields, []) &&
      w.r2.peekMeta(keyOf(b.uid)).fields === "products" && eq(reqOf(w, b.uid).changes, {}), brief(b));
  const m = memberOf(w, "g3_m1");
  const same = Object.fromEntries(FIELDS.map(f => [f, Array.isArray(m[f]) ? m[f].join("\n") : m[f]]));
  const c = await submit(w, { changes: same, photos:{ image: IMG(6) } });
  chk("★ 文字都和現值一樣、但有照片 → 一定建一筆(不是 unchanged)", c.ok && !c.unchanged && !!c.uid && c.photos === 1, brief(c));
  const d = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ title:"蔬果" }, photos:{ card: IMG(7) } });
  chk("資料需確認的夥伴、文字沒改、有照片 → 照片那一筆(confirmOnly false)", d.ok && d.confirmOnly === false &&
      w.r2.peekMeta(keyOf(d.uid)).fields === "card" && w.r2.peekMeta(keyOf(d.uid)).confirm === "0", brief(d));
  const e = await submit(w, { label:"A1・陳清單", name:"陳清單", changes:{ company:"沒附照片" }, photos:{ image:"", card:"", products:[] } });
  const qe = e.ok ? reqOf(w, e.uid) : {};
  chk("三個空值 = 沒有照片:photos 0、請求 JSON 沒有 photos 鍵、metadata 只有文字欄位", e.ok && e.photos === 0 &&
      !("photos" in qe) && w.r2.peekMeta(keyOf(e.uid)).fields === "company" && !imgKeysOf(w, e.uid).length, brief(e));
  const f = await submit(w, { label:"A1・張多項", name:"張多項", changes:{}, photos:"data:image/jpeg;base64,AAAA" });
  chk("photos 不是物件 → 當成沒有照片(只有它 → nothing_to_update)", f._status === 400 && f.error === "nothing_to_update", brief(f));
  const g = await submit(w, { label:"A1・張多項", name:"張多項", changes:{}, photos:{ products:["", IMG(8), null] } });
  const qg = g.ok ? reqOf(w, g.uid) : {};
  chk("商品照的空值先剔除:key 的索引 = 請求 JSON 裡的陣列位置", g.ok && g.photos === 1 && qg.photos.products.length === 1 &&
      /\/product-0-/.test(qg.photos.products[0].key) && qg.photos.image === null && qg.photos.card === null, brief(qg.photos));
  const raw = '{"secret":"s3cret","update":{"label":"A1・陳大文","name":"陳大文","group":"B1","responseId":"proto-photo",' +
    '"changes":{},"photos":{"__proto__":{"image":"' + IMG(9) + '"},"constructor":"' + IMG(10) + '"}}}';
  const h = await call(w, "/member-update", raw);
  chk("★ photos 帶 __proto__、constructor → 不收(只有它 → nothing_to_update),沒有污染原型",
      h._status === 400 && h.error === "nothing_to_update" && ({}).image === undefined, brief(h));
}

/* ══ 41 ══ 照片不合格 */
hr("㊶ 照片不合格 → 整筆退回(不靜默丟照片);擋在讀網站之前、R2 一個都不寫");
{
  const w = world();
  const big = await submit(w, { changes:{ company:"x" }, photos:{ image: IMG(1, 200 * 1024 + 1) } });
  chk("★ 解碼後超過 200KB → 413 pending_image_too_large {field:image}", big._status === 413 &&
      big.error === "pending_image_too_large" && big.field === "image" && big.reason === "too_large" && big.max === 200 * 1024, brief(big));
  chk("沒有讀公開網站、沒有任何 R2 呼叫", big._pages === 0 && big._r2.length === 0, `pages=${big._pages} r2=${big._r2.length}`);
  const ok200 = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{}, photos:{ image: IMG(1, 200 * 1024) } });
  chk("剛好 200KB → 收", ok200.ok === true && ok200.photos === 1, brief(ok200));
  const gif = await submit(w, { changes:{ company:"x" }, photos:{ card:"data:image/gif;base64,R0lGODlhAQABAAAAACw=" } });
  chk("★ gif → 400 invalid_pending_image {field:card, reason:bad_format}", gif._status === 400 &&
      gif.error === "invalid_pending_image" && gif.field === "card" && gif.reason === "bad_format", brief(gif));
  const b64 = await submit(w, { changes:{ company:"x" }, photos:{ image:"data:image/jpeg;base64,!!!!" } });
  chk("base64 不合法 → 400 invalid_pending_image", b64._status === 400 && b64.error === "invalid_pending_image", brief(b64));
  const num = await submit(w, { changes:{ company:"x" }, photos:{ image:12345 } });
  chk("★ 照片不是字串 → 400 invalid_pending_image(不是當成沒傳)", num._status === 400 && num.error === "invalid_pending_image" &&
      num.field === "image", brief(num));
  const weird = await submit(w, { changes:{ company:"x" }, photos:{ products:[IMG(2), { toString:null }] } });
  chk("★ 商品照是 {toString:null} → 400 invalid_pending_image {field:product[1]}(不是 500)", weird._status === 400 &&
      weird.error === "invalid_pending_image" && weird.field === "product[1]", brief(weird));
  const six = await submit(w, { changes:{ company:"x" }, photos:{ products:[1, 2, 3, 4, 5, 6].map(i => IMG(i)) } });
  chk("★ 商品照 6 張 → 400 invalid_pending_image {field:products, reason:too_many, max:5}(不是靜默截成 5 張)",
      six._status === 400 && six.error === "invalid_pending_image" && six.field === "products" && six.reason === "too_many" &&
      six.max === 5, brief(six));
  const five = await submit(w, { label:"A1・林小美", name:"林小美", changes:{}, photos:{ products:["", 1, 2, 3, 4, 5].map(i => i ? IMG(i) : "") } });
  chk("空值不算張數:5 張 + 1 個空值 → 收", five.ok === true && five.photos === 5, brief(five));
  const notArr = await submit(w, { changes:{ company:"x" }, photos:{ products: IMG(1) } });
  chk("products 不是陣列 → 400 invalid_pending_image", notArr._status === 400 && notArr.error === "invalid_pending_image" &&
      notArr.field === "products", brief(notArr));
  chk("以上不合格的都沒有在 R2 留下任何東西", reqKeys(w).length === 2 && imgKeys(w).length === 6, reqKeys(w).length + " / " + imgKeys(w).length);
}

/* ══ 42 ══ 寫入失敗的回滾 */
hr("㊷ 照片或請求寫入失敗 → 這次寫過的一次 delete 掉,回 502 update_store_failed");
{
  const w = world();
  w.r2.fail = { op:"put", nth: w.r2._n.put + 3, once:true };       // 第 3 個 put = 請求本身(前兩個是照片)
  const r = await submit(w, { changes:{ company:"請求寫不進去" }, photos:{ image: IMG(1), products:[IMG(2)] } });
  chk("502 update_store_failed", r._status === 502 && r.error === "update_store_failed", brief(r));
  const dels = r._r2.filter(c => c.op === "delete");
  const puts = r._r2.filter(c => c.op === "put").map(c => c.key);
  chk("★ 只 delete 一次,陣列裡是請求 key + 兩張照片", dels.length === 1 && Array.isArray(dels[0].key) &&
      eq(dels[0].key, [puts[2]].concat(puts.slice(0, 2))) && puts[2].startsWith("updates/req/"), brief(dels));
  chk("沒有殘留", w.r2.keys().length === 0, w.r2.keys().join(" "));
  const w2 = world();
  w2.r2.fail = { op:"put", nth: w2.r2._n.put + 2, once:true };     // 第 2 張照片
  const r2 = await submit(w2, { changes:{ company:"第二張寫不進去" }, photos:{ image: IMG(1), card: IMG(2), products:[IMG(3)] } });
  const puts2 = r2._r2.filter(c => c.op === "put").map(c => c.key);
  const dels2 = r2._r2.filter(c => c.op === "delete");
  chk("502 update_store_failed {field:card}", r2._status === 502 && r2.error === "update_store_failed" && r2.field === "card", brief(r2));
  chk("★ 第 3 張與請求都沒有寫;一次 delete 刪掉第 1 張與失敗的第 2 張(丟例外不代表沒寫進去)",
      puts2.length === 2 && dels2.length === 1 && eq(dels2[0].key, puts2) && w2.r2.keys().length === 0, brief(dels2));
}

/* ══ 43 ══ 去重 */
hr("㊸ 去重:同一段文字配不同照片是兩筆;同一批照片重送是重複;沒有照片時雜湊和以前逐位元組相同");
{
  const w = world();
  const a = await submit(w, { responseId:"P-1", changes:{ company:"同一段文字" }, photos:{ image: IMG(1) } });
  const b = await submit(w, { responseId:"P-2", changes:{ company:"同一段文字" }, photos:{ image: IMG(2) } });
  chk("★ 同一段文字、不同照片 → 不是重複(兩筆)", a.ok && b.ok && !b.duplicate && b.uid !== a.uid && reqKeys(w).length === 2, brief(b));
  const c = await submit(w, { responseId:"P-3", changes:{ company:"同一段文字" }, photos:{ image: IMG(1) } });
  chk("同一段文字、同一張照片(另一筆回應)→ duplicate,沒有多寫照片", c.duplicate === true && c.uid === a.uid &&
      reqKeys(w).length === 2 && imgKeys(w).length === 2 && !c._r2.some(x => x.op === "put"), brief(c));
  const d = await submit(w, { responseId:"P-4", changes:{ company:"同一段文字" }, photos:{ card: IMG(1) } });
  chk("同一張照片放在別的欄位 → 不是重複", d.ok && !d.duplicate && d.uid !== a.uid, brief(d));
  const H = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
  const w2 = world();
  const e = await submit(w2, { changes:{ company:"沒有照片" }, note:"備註" });
  const qe = reqOf(w2, e.uid) || {};
  chk("★ 沒有照片 → 雜湊 = 加照片之前的算式(JSON 裡沒有多一個 photos 鍵)",
      qe.h === H({ changes:qe.changes, note:"備註", invalid:[], cleared:[], confirmOnly:false }) && w2.r2.peekMeta(keyOf(e.uid)).h === qe.h, qe.h);
  const f = await submit(w2, { label:"A1・王大銘", name:"王大銘", changes:{}, photos:{ image: IMG(3), products:[IMG(4), IMG(5)] } });
  const qf = reqOf(w2, f.uid) || {};
  chk("有照片 → photos:[\"image:<sha>\", \"product0:<sha>\", \"product1:<sha>\"] 一起算",
      qf.h === H({ changes:{}, note:"", invalid:[], cleared:[], confirmOnly:false,
                   photos:["image:" + shaOf(imgBytes(3)), "product0:" + shaOf(imgBytes(4)), "product1:" + shaOf(imgBytes(5))] }), qf.h);
}

/* ══ 44 ══ /member-update-get */
hr("㊹ /member-update-get:照片只回摘要(沒有 key、沒有 sha256)");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"讀照片摘要" }, photos:{ image: IMG(1), products:[IMG(2, 500), IMG(3, 400, "image/webp")] } });
  const r = await call(w, "/member-update-get", { session:sA1, uid:a.uid });
  chk("★ request.photos = { image:{mime,bytes}, card:null, products:[{mime,bytes}, …] }", r.ok &&
      eq(r.request.photos, { image:{ mime:"image/jpeg", bytes:600 }, card:null,
                             products:[{ mime:"image/jpeg", bytes:500 }, { mime:"image/webp", bytes:400 }] }), brief(r.request && r.request.photos));
  const raw = JSON.stringify(r);
  chk("★ 整個回應裡沒有 R2 key、沒有 sha256", !raw.includes("updates/img/") && !raw.includes("sha256") && !raw.includes(shaOf(imgBytes(1))));
  chk("其他欄位照舊;R2 裡的請求沒有被改", r.request.uid === a.uid && r.request.changes.company === "讀照片摘要" &&
      ((reqOf(w, a.uid) || {}).photos || { image:{ key:"" } }).image.key.startsWith("updates/img/" + a.uid + "/"));
  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"沒有照片" } });
  const rb = await call(w, "/member-update-get", { session:sOwner, uid:b.uid });
  chk("沒有照片 → 沒有 photos 鍵", rb.ok && !("photos" in rb.request), brief(rb));
  chk("子請求 ≤ 3", r._cost <= 3 && rb._cost <= 3, r._cost + " / " + rb._cost);
  await patchReq(w, a.uid, q => { q.photos = { image:"updates/img/" + a.uid + "/image-x.jpg", card:7, products:"updates/img/oops" }; });
  const rc = await call(w, "/member-update-get", { session:sOwner, uid:a.uid });
  chk("★ photos 被寫壞(沒有一個是合格的引用)→ 不放 photos 鍵,原始內容也不外流", rc.ok && !("photos" in rc.request) &&
      !JSON.stringify(rc).includes("updates/img/"), brief(rc.request && rc.request.photos));
}

/* ══ 45 ══ /member-update-photo */
hr("㊺ /member-update-photo:權限同 get、key 一律從請求 JSON 查、標頭與 /pending-photo 相同");
{
  const w = world();
  const P0 = imgBytes(1), C0 = imgBytes(2), P1 = imgBytes(3, 300);
  const a = await submit(w, { changes:{ company:"預覽" }, photos:{ image: dataUrl(P0), products:[dataUrl(C0), dataUrl(P1, "image/png")] } });
  const r = await callPhoto(w, { session:sOwner, uid:a.uid, field:"image", index:-1 });
  const h = r._headers;
  chk("總管理員讀形象照:200,位元組原樣", r._status === 200 && r._bytes.equals(P0), r._status + " " + brief(r));
  chk("★ 標頭:Content-Type 取 ref.mime、private, no-store、nosniff、inline、CORS", h.get("Content-Type") === "image/jpeg" &&
      h.get("Cache-Control") === "private, no-store" && h.get("X-Content-Type-Options") === "nosniff" &&
      h.get("Content-Disposition") === "inline" && h.get("Access-Control-Allow-Origin") === "https://ivanzhong085.github.io");
  const r2 = await callPhoto(w, { session:sA1, uid:a.uid, field:"product", index:1 });
  chk("自己組的組長讀商品照第 2 張(png)", r2._status === 200 && r2._bytes.equals(P1) && r2._headers.get("Content-Type") === "image/png", r2._status);
  chk("子請求 ≤ 4(組長:R2 2、_index ≤2)", r._cost <= 4 && r2._cost <= 4, r._cost + " / " + r2._cost);
  const b = await callPhoto(w, { session:sB1, uid:a.uid, field:"image" });
  chk("★ 別組組長 → 403 forbidden_group,沒有讀照片", b._status === 403 && b.error === "forbidden_group" &&
      b._r2.filter(c => c.op === "get").length === 1, brief(b));
  const v = await callPhoto(w, { session:sViewer, uid:a.uid, field:"image" });
  chk("★ viewer → 403 read_only", v._status === 403 && v.error === "read_only", brief(v));
  const bads = [["欄位寫成 products", { field:"products", index:0 }], ["欄位 key", { field:"key" }], ["沒有欄位", {}],
    ["商品照 index 5", { field:"product", index:5 }], ["商品照 index -1", { field:"product", index:-1 }],
    ["商品照 index 是字串", { field:"product", index:"0" }], ["商品照 index 1.5", { field:"product", index:1.5 }],
    ["uid 含 ../", { uid:"../req/x", field:"image" }], ["uid 是怪物件", { uid:{ toString:null }, field:"image" }]];
  const badRes = [];
  for(const [, o] of bads) badRes.push(await callPhoto(w, Object.assign({ session:sOwner, uid:a.uid }, o)));
  chk("★ 欄位、索引、uid 不合格 → 400 bad_request", badRes.every(x => x._status === 400 && x.error === "bad_request"),
      bads.map((x, i) => x[0] + ":" + badRes[i]._status).join("、"));
  const noCard = await callPhoto(w, { session:sOwner, uid:a.uid, field:"card" });
  const noP2 = await callPhoto(w, { session:sOwner, uid:a.uid, field:"product", index:2 });
  chk("這一筆沒有那張照片 → 404 update_image_missing", noCard._status === 404 && noCard.error === "update_image_missing" &&
      noP2._status === 404 && noP2.error === "update_image_missing", brief(noCard) + " / " + brief(noP2));
  const withKey = await callPhoto(w, { session:sOwner, uid:a.uid, field:"card", key: reqOf(w, a.uid).photos.image.key });
  chk("★ 呼叫端帶 key 一律無效", withKey._status === 404 && withKey.error === "update_image_missing", brief(withKey));
  const gone = await callPhoto(w, { session:sOwner, uid:"u_nothere1", field:"image" });
  chk("請求不存在 → 409 update_gone", gone._status === 409 && gone.error === "update_gone", brief(gone));

  // 請求 JSON 被動過手腳:key 指到別的地方
  const goodKey = reqOf(w, a.uid).photos.image.key;
  await w.r2.put("pending/p_victim/image-0123456789abcdef.jpg", "secret card");
  const tampered = [];
  for(const k of ["pending/p_victim/image-0123456789abcdef.jpg", "updates/img/" + a.uid + "/../../req/" + a.uid + ".json",
                  "updates/img/u_other123/image-0123456789abcdef.jpg", 12345]){
    await patchReq(w, a.uid, q => { q.photos.image.key = k; });
    tampered.push(await callPhoto(w, { session:sOwner, uid:a.uid, field:"image" }));
  }
  chk("★ key 不在 updates/img/<uid>/ 底下(pending/、含 ..、別筆、不是字串)→ 403 update_image_forbidden,不讀 R2",
      tampered.every(x => x._status === 403 && x.error === "update_image_forbidden" && x._r2.filter(c => c.op === "get").length === 1),
      tampered.map(x => x._status + " " + x.error).join("、"));
  await patchReq(w, a.uid, q => { q.photos.image.key = goodKey; q.photos.image.mime = "constructor"; });
  const t4 = await callPhoto(w, { session:sOwner, uid:a.uid, field:"image" });
  chk("★ mime 不在白名單(constructor)→ 502 update_image_corrupt", t4._status === 502 && t4.error === "update_image_corrupt", brief(t4));
  const pk = reqOf(w, a.uid).photos.products[1].key;
  w.r2.fail = { op:"get", key:pk, once:true };
  const t5 = await callPhoto(w, { session:sOwner, uid:a.uid, field:"product", index:1 });
  chk("R2 讀照片丟例外 → 502 update_store_failed", t5._status === 502 && t5.error === "update_store_failed", brief(t5));
  w.r2.objects.delete(pk); w.r2.meta.delete(pk);
  const t6 = await callPhoto(w, { session:sOwner, uid:a.uid, field:"product", index:1 });
  chk("照片物件不在了(lifecycle 清掉)→ 404 update_image_missing", t6._status === 404 && t6.error === "update_image_missing", brief(t6));
}

/* ══ 46 ══ 套用照片 */
hr("㊻ 套用照片:replace / append / skip,和組檔同一個 commit");
{
  const w = world();
  const I = imgBytes(1), C = imgBytes(2), P = [imgBytes(3), imgBytes(4, 500)];
  const a = await submit(w, { changes:{ company:"照片也換" }, photos:{ image: dataUrl(I), card: dataUrl(C), products: P.map(x => dataUrl(x, "image/png")) } });
  const allKeys = [keyOf(a.uid)].concat(imgKeysOf(w, a.uid));
  const n0 = commitsWith(w, "夥伴資料更新").length;
  const r = await apply(w, sA1, a.uid, { company:"replace", image:"replace", card:"replace", products:"replace" },
                        { company:"", image:"", card:"", products:[] });
  const m = memberOf(w, "g3_m1");
  const nm = (id, suffix, b, ext) => id + "_" + suffix + "_" + shaOf(b).slice(0, 10) + "." + ext;
  chk("★ 組長套用自己組的照片 → 200(通過 assetPaths 的組別前綴檢查),applied 含照片欄位", r.ok === true &&
      eq(r.applied, ["company","image","card","products"]) && eq(r.warnings, []), brief(r));
  chk("★ member.image = <memberId>_x_<sha10>.jpg、card = _card_、products = _p1_/_p2_", m.image === nm("g3_m1", "x", I, "jpg") &&
      m.card === nm("g3_m1", "card", C, "jpg") && eq(m.products, [nm("g3_m1", "p1", P[0], "png"), nm("g3_m1", "p2", P[1], "png")]) &&
      m.company === "照片也換" && m.lastUpdateFrom === a.uid, brief(m));
  const files = w.gh.files();
  chk("★ 圖檔寫進 images/,內容和夥伴送來的一樣", [[m.image, I], [m.card, C], [m.products[0], P[0]], [m.products[1], P[1]]]
      .every(([n, b]) => files.get("images/" + n) === b.toString("latin1")));
  chk("只有一個 commit(照片和組檔在同一個)", commitsWith(w, "夥伴資料更新").length - n0 === 1);
  const dels = r._r2.filter(c => c.op === "delete");
  chk("★ 成功後一次 delete:請求 + 4 張照片", dels.length === 1 && Array.isArray(dels[0].key) &&
      eq([...dels[0].key].sort(), allKeys.slice().sort()) && w.r2.keys().length === 0, brief(dels));
  chk("子請求 ≤ 50", r._cost <= 50, r._cost + " 個");
}
{
  const w = world();
  setMember(w, "a1", "g3_m9", { products:["old1.jpg", "", "old2.jpg", "old3.jpg"] });
  const P = [imgBytes(11), imgBytes(12), imgBytes(13)];
  const a = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{}, photos:{ products: P.map(x => dataUrl(x)) } });
  const r = await apply(w, sOwner, a.uid, { products:"append" }, { products:["old1.jpg", "old2.jpg", "old3.jpg"] });
  const m = memberOf(w, "g3_m9");
  const nm = (i, b) => "g3_m9_p" + i + "_" + shaOf(b).slice(0, 10) + ".jpg";
  chk("★ append:原本 3 張(空值不算)+ 新的 3 張 → 截到 5 張,warnings list_truncated dropped 1", r.ok &&
      eq(m.products, ["old1.jpg", "old2.jpg", "old3.jpg", nm(1, P[0]), nm(2, P[1])]) &&
      eq(r.warnings, [{ field:"products", reason:"list_truncated", dropped:1 }]), brief(r) + " " + brief(m.products));
  chk("被截掉的那張不寫進 repo", w.gh.files().has("images/" + nm(1, P[0])) && w.gh.files().has("images/" + nm(2, P[1])) &&
      !w.gh.files().has("images/" + nm(3, P[2])));
  setMember(w, "a1", "g3_m6", { products:["a.jpg"] });
  const b = await submit(w, { label:"A1・陳清單", name:"陳清單", changes:{}, photos:{ products:[dataUrl(P[0]), dataUrl(P[0])] } });
  const rb = await apply(w, sOwner, b.uid, { products:"append" }, { products:["a.jpg"] });
  const mb = memberOf(w, "g3_m6");
  chk("append 沒超過 5 張 → 不截、沒有 warnings;同內容的兩張是兩個檔名", rb.ok && eq(rb.warnings, []) &&
      eq(mb.products, ["a.jpg", "g3_m6_p1_" + shaOf(P[0]).slice(0, 10) + ".jpg", "g3_m6_p2_" + shaOf(P[0]).slice(0, 10) + ".jpg"]), brief(mb.products));
  const c = await submit(w, { label:"A1・陳清單", name:"陳清單", changes:{}, photos:{ products:[dataUrl(P[2])] } });
  const rc = await apply(w, sOwner, c.uid, { products:"replace" }, { products: mb.products });
  chk("replace:整組換成新的", rc.ok && eq(memberOf(w, "g3_m6").products, ["g3_m6_p1_" + shaOf(P[2]).slice(0, 10) + ".jpg"]), brief(rc));
}
{
  const w = world();
  const a = await submit(w, { changes:{ company:"只套文字" }, photos:{ image: IMG(21), card: IMG(22) } });
  const r = await apply(w, sOwner, a.uid, { company:"replace", image:"skip", card:"skip" }, { company:"" });
  chk("★ 照片 skip → 成員卡照片不變、沒有寫任何圖檔、不讀照片;成功後請求與照片一起刪", r.ok && eq(r.applied, ["company"]) &&
      memberOf(w, "g3_m1").image === "" && ![...w.gh.files().keys()].some(p => p.startsWith("images/")) &&
      r._r2.filter(c => c.op === "get").length === 1 && w.r2.keys().length === 0, brief(r));
  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{}, photos:{ image: IMG(23) } });
  const nb = await apply(w, sOwner, b.uid, { image:"skip" }, {});
  chk("只有照片、全部 skip → 400 nothing_selected", nb._status === 400 && nb.error === "nothing_selected", brief(nb));
  const rb = await apply(w, sOwner, b.uid, { image:"replace" }, { image:"" }, { clearDataIssue:true });
  chk("只勾照片 → 照常套用", rb.ok && eq(rb.applied, ["image"]) && memberOf(w, "g3_m9").image.startsWith("g3_m9_x_"), brief(rb));
}

/* ══ 47 ══ 套用照片的參數與 expect */
hr("㊼ 套用照片:choices / expect 驗證、審核者看到的照片不是現值 → member_changed");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"參數" }, photos:{ image: IMG(31), products:[IMG(32)] } });
  const ex = { company:"", image:"", products:[] };
  const cs = [
    ["image 用 append", { image:"append" }, ex], ["products 用 delete", { products:"delete" }, ex],
    ["這一筆沒有名片照片", { card:"replace" }, Object.assign({ card:"" }, ex)],
    ["expect.image 是陣列", { image:"replace" }, { image:[] }], ["expect.image 是 null", { image:"replace" }, { image:null }],
    ["沒帶 expect.image", { image:"replace" }, {}], ["expect.products 是字串", { products:"replace" }, { products:"" }],
    ["expect.products 有非字串", { products:"append" }, { products:[1] }],
  ];
  const rs = [];
  for(const [, ch, e] of cs) rs.push(await apply(w, sOwner, a.uid, ch, e));
  chk("★ 不合格的照片 choices / expect → 400 bad_choice", rs.every(x => x._status === 400 && x.error === "bad_choice"),
      cs.map((x, i) => x[0] + ":" + rs[i]._status + " " + rs[i].error + (rs[i].reason ? "/" + rs[i].reason : "")).join("、"));
  chk("expect 型別不對 → reason expect", rs.slice(3).every(x => x.reason === "expect"));
  chk("以上都沒有上鎖、沒有讀照片", stateOf(w, a.uid) === "open" && rs.every(x => x._r2.filter(c => c.op === "get").length === 1));
  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"沒照片" } });
  const nb = await apply(w, sOwner, b.uid, { company:"replace", image:"replace" }, { company:"大銘水產", image:"" });
  chk("沒有照片的請求不收照片欄位 → 400 bad_choice", nb._status === 400 && nb.error === "bad_choice" && nb.field === "image", brief(nb));

  setMember(w, "a1", "g3_m1", { image:"別人剛換的.jpg" });
  const head0 = w.gh.head;
  const r = await apply(w, sA1, a.uid, { company:"replace", image:"replace" }, { company:"", image:"" });
  chk("★ 審核者看到的形象照不是現值 → 409 member_changed [image],不寫入、已解鎖", r._status === 409 && r.error === "member_changed" &&
      eq(r.fields, ["image"]) && w.gh.head === head0 && stateOf(w, a.uid) === "open", brief(r));
  setMember(w, "a1", "g3_m1", { products:["x.jpg"] });
  const r2 = await apply(w, sA1, a.uid, { image:"replace", products:"append" }, { image:"別人剛換的.jpg", products:[] });
  chk("商品照也一樣 → member_changed [products]", r2._status === 409 && r2.error === "member_changed" && eq(r2.fields, ["products"]), brief(r2));
  const r3 = await apply(w, sA1, a.uid, { image:"replace", products:"append" }, { image:" 別人剛換的.jpg ", products:["x.jpg", ""] });
  chk("比對時 trim、去掉空值 → 和現值相同就照常套用", r3.ok && eq(memberOf(w, "g3_m1").products, ["x.jpg", "g3_m1_p1_" + shaOf(imgBytes(32)).slice(0, 10) + ".jpg"]), brief(r3));
}

/* ══ 48 ══ 照片不見了 / 壞了 */
hr("㊽ 套用時照片不見了 → update_image_missing;位元組 / sha256 / mime / key 不對 → update_image_corrupt;一律解鎖、不寫入");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"照片被清掉" }, photos:{ image: IMG(51), products:[IMG(52), IMG(53)] } });
  const pk = reqOf(w, a.uid).photos.products[1].key;
  w.r2.objects.delete(pk); w.r2.meta.delete(pk);
  const head0 = w.gh.head;
  const r = await apply(w, sA1, a.uid, { company:"replace", image:"replace", products:"replace" }, { company:"", image:"", products:[] });
  chk("★ R2 的照片不見了 → 409 update_image_missing {fields:[products]},沒有寫入、已解鎖", r._status === 409 &&
      r.error === "update_image_missing" && eq(r.fields, ["products"]) && w.gh.head === head0 && stateOf(w, a.uid) === "open" &&
      w.r2.peekMeta(keyOf(a.uid)).state === "open", brief(r));
  chk("沒有碰 GitHub 的寫入(連組檔都沒讀)", r._api <= 2, r._api + " 個 API");
  const r2 = await apply(w, sA1, a.uid, { company:"replace", image:"replace", products:"skip" }, { company:"", image:"" });
  chk("取消勾選商品照之後照常套用;成功後請求與剩下的照片都刪掉", r2.ok && memberOf(w, "g3_m1").image.startsWith("g3_m1_x_") &&
      eq(memberOf(w, "g3_m1").products, []) && w.r2.keys().length === 0, brief(r2));
}
{
  const w = world();
  const a = await submit(w, { changes:{ company:"壞照片" }, photos:{ image: IMG(61), card: IMG(62) } });
  const q = reqOf(w, a.uid);
  const go = () => apply(w, sOwner, a.uid, { company:"replace", image:"replace", card:"replace" }, { company:"", image:"", card:"" });
  const head0 = w.gh.head;
  const out = [];
  w.r2.corrupt(q.photos.image.key, imgBytes(99, 599));                 // 長度不同
  out.push(["bytes", "image", await go()]);
  w.r2.corrupt(q.photos.image.key, imgBytes(1));                       // 一樣 600 bytes、內容不同
  out.push(["sha256", "image", await go()]);
  w.r2.corrupt(q.photos.image.key, imgBytes(61));                      // 復原
  await patchReq(w, a.uid, x => { x.photos.card.mime = "text/html"; });
  out.push(["bad_mime", "card", await go()]);
  await w.r2.put("pending/p_victim/card-0000000000000000.jpg", imgBytes(62));
  await patchReq(w, a.uid, x => { x.photos.card.mime = "image/jpeg"; x.photos.card.key = "pending/p_victim/card-0000000000000000.jpg"; });
  out.push(["key", "card", await go()]);
  for(const [reason, field, x] of out){
    chk(`★ ${reason} 不對 → 502 update_image_corrupt {field:${field}, reason:${reason}},已解鎖`, x._status === 502 &&
        x.error === "update_image_corrupt" && x.field === field && x.reason === reason && stateOf(w, a.uid) === "open", brief(x));
  }
  chk("key 不屬於這一筆 → 根本不去讀 pending/ 的物件", !out[3][2]._r2.some(c => c.op === "get" && String(c.key).startsWith("pending/")));
  await patchReq(w, a.uid, x => { x.photos.card.key = q.photos.card.key; });
  w.r2.fail = { op:"get", key:q.photos.card.key, once:true };
  const sf = await go();
  chk("R2 讀照片丟例外 → 502 update_store_failed,已解鎖", sf._status === 502 && sf.error === "update_store_failed" &&
      stateOf(w, a.uid) === "open", brief(sf));
  chk("以上都沒有寫入", w.gh.head === head0);
  const ok = await go();
  chk("修好之後照常套用", ok.ok === true && memberOf(w, "g3_m1").card.startsWith("g3_m1_card_"), brief(ok));
}

/* ══ 49 ══ 預算 */
hr("㊾ 7 張照片的子請求預算:組長 2 輪、總管理員 3 輪;每一輪都被搶先也 ≤ 50;照片 blob 只建一次");
{
  const seven = s => ({ image: IMG(s), card: IMG(s + 1), products:[2, 3, 4, 5, 6].map(i => IMG(s + i)) });
  for(const [label, sess, wantRounds] of [["組長", sA1, 2], ["總管理員", sOwner, 3]]){
    for(const mode of ["stale_base", "ref_moved"]){
      const w = world();
      const a = await submit(w, { changes:{ company:"七張 " + label + mode }, photos: seven(70) });
      let n = 0, rounds = 0, blobs = 0;
      w.gh.hooks.before = async (u, method) => {
        if(method === "GET" && u.includes("/contents/data/a1.json")) rounds++;
        if(method === "POST" && u.endsWith("/git/blobs")) blobs++;
        if(mode === "stale_base" && method === "GET" && u.includes("/git/ref/heads/")){ n++; setMember(w, "a1", "g3_m9", { title:"別人第 " + n + " 次發布" }); }
        if(mode === "ref_moved" && method === "PATCH" && u.includes("/git/refs/")) w.gh.pushFiles({ "data.js":"sync " + Math.random() }, "同步 bot");
      };
      const r = await apply(w, sess, a.uid, { company:"replace", image:"replace", card:"replace", products:"replace" },
                            { company:"", image:"", card:"", products:[] });
      w.gh.hooks.before = null;
      const wantErr = mode === "stale_base" ? "stale_base" : "busy_retry_later";
      chk(`★ ${label}、每一輪都 ${mode} → ${wantRounds} 輪(${rounds})、${wantErr}、子請求 ${r._cost} ≤ 50、已解鎖`,
          r._status === 409 && r.error === wantErr && rounds === wantRounds && r._cost <= 50 && stateOf(w, a.uid) === "open", brief(r));
      chk(`  ${label}・${mode}:照片 get 7 次、blob 只建 7 個(各輪共用 blobCache)`,
          r._r2.filter(c => c.op === "get").length === 8 && blobs === 7, `get ${r._r2.filter(c => c.op === "get").length - 1}、blob ${blobs}`);
    }
  }
  /* 靜態上限:用 worst case 的公式算一次(每個 GitHub 讀取都走 >1MB 的兩段式、組長代號檢查與 _index 不變式都讀兩次)。 */
  for(const [label, perRound] of [["組長", 12], ["總管理員", 10]]){
    for(const photos of [0, 7]){
      const fixed = 6 + photos * 2;
      const rounds = Math.max(1, Math.min(3, Math.floor((50 - fixed) / perRound)));
      chk(`靜態上限:${label}、${photos} 張照片 → ${rounds} 輪、最壞 ${fixed + rounds * perRound} ≤ 50`, fixed + rounds * perRound <= 50);
    }
  }
  const w = world();
  const a = await submit(w, { changes:{ company:"七張、第 3 輪成功" }, photos: seven(80) });
  let n = 0;
  w.gh.hooks.before = async (u, method) => {
    if(method === "PATCH" && u.includes("/git/refs/") && n < 2){ n++; w.gh.pushFiles({ "data.js":"sync " + n }, "同步 bot"); }
  };
  const r = await apply(w, sOwner, a.uid, { company:"replace", image:"replace", card:"replace", products:"replace" },
                        { company:"", image:"", card:"", products:[] });
  w.gh.hooks.before = null;
  chk("總管理員 7 張照片、被搶 2 次 → 第 3 輪成功,7 張都寫進去、R2 清空", r.ok === true && memberOf(w, "g3_m1").products.length === 5 &&
      [...w.gh.files().keys()].filter(p => p.startsWith("images/g3_m1_")).length === 7 && w.r2.keys().length === 0 && r._cost <= 50,
      brief(r) + " cost=" + r._cost);
}

/* ══ 50 ══ 清除失敗 / 已套用 */
hr("㊿ 有照片的請求:commit 成功但清除失敗 → 再套用時一次清掉請求與照片");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"清除失敗" }, photos:{ image: IMG(81) } });
  w.r2.fail = { op:"delete", once:true };
  const r = await apply(w, sOwner, a.uid, { company:"replace", image:"replace" }, { company:"", image:"" });
  chk("200 cleanupFailed,請求與照片都還在、已解鎖", r.ok && r.cleanupFailed === true && w.r2.keys().length === 2 &&
      stateOf(w, a.uid) === "open", brief(r));
  const head0 = w.gh.head;
  const r2 = await apply(w, sOwner, a.uid, { company:"replace", image:"replace" }, { company:"清除失敗", image: memberOf(w, "g3_m1").image });
  const dels = r2._r2.filter(c => c.op === "delete");
  chk("★ 再套用 → 409 update_already_applied,一次 delete 清掉請求與照片,沒有第二個 commit", r2._status === 409 &&
      r2.error === "update_already_applied" && dels.length === 1 && Array.isArray(dels[0].key) && dels[0].key.length === 2 &&
      w.r2.keys().length === 0 && w.gh.head === head0, brief(r2));
}

/* ══ 51 ══ 不採用 */
hr("(51) /member-update-drop 與 drop-batch:照片跟著請求一起刪");
{
  const w = world();
  const a = await submit(w, { changes:{ company:"不採用" }, photos:{ image: IMG(91), products:[IMG(92)] } });
  const r = await call(w, "/member-update-drop", { session:sA1, uid:a.uid });
  const dels = r._r2.filter(c => c.op === "delete");
  chk("★ 一次 delete:請求 + 2 張照片", r.ok && dels.length === 1 && Array.isArray(dels[0].key) && dels[0].key.length === 3 &&
      dels[0].key[0] === keyOf(a.uid) && w.r2.keys().length === 0, brief(dels));
  chk("子請求 ≤ 5", r._cost <= 5, r._cost + " 個");
  const b = await submit(w, { changes:{ company:"不採用 2" }, photos:{ image: IMG(93) } });
  const victim = "pending/p_victim/image-0000000000000000.jpg";
  await w.r2.put(victim, "x");
  await patchReq(w, b.uid, q => { q.photos.card = { key:victim, mime:"image/jpeg", bytes:1, sha256:"0".repeat(64) }; });
  const rb = await call(w, "/member-update-drop", { session:sOwner, uid:b.uid });
  chk("★ 請求 JSON 裡指到別處的 key 不會被刪", rb.ok && w.r2.objects.has(victim) && !imgKeysOf(w, b.uid).length, brief(rb));
}
{
  const w = world();
  const a = await submit(w, { changes:{ company:"灌單 1" }, photos:{ image: IMG(1), products:[IMG(2), IMG(3)] } });
  const b = await submit(w, { label:"A1・王大銘", name:"王大銘", changes:{ company:"灌單 2" }, photos:{ card: IMG(4) } });
  const c = await submit(w, { label:"A1・林小美", name:"林小美", changes:{ company:"灌單 3" }, photos:{ image: IMG(5) } });
  const d = await submit(w, { label:"A1・陳清單", name:"陳清單", changes:{ company:"灌單 4" } });
  await forceState(w, c.uid, "applying");
  w.r2.pageSize = 2;                                        // 照片列表要分頁(5 張 → 3 頁)
  const r = await call(w, "/member-update-drop-batch", { session:sOwner, uids:[a.uid, b.uid, c.uid, d.uid] });
  w.r2.pageSize = 1000;
  const dels = r._r2.filter(x => x.op === "delete");
  chk("★ dropped 3、skipped 1;一次 delete 含 3 筆請求與它們的 4 張照片", r.ok && r.dropped === 3 && eq(r.skipped, [c.uid]) &&
      dels.length === 1 && dels[0].key.length === 7 && dels[0].key.filter(k => k.startsWith("updates/img/")).length === 4, brief(r) + " " + brief(dels));
  chk("上鎖中那筆的請求與照片都還在,其他全刪", eq(w.r2.keys(), [keyOf(c.uid)].concat(imgKeysOf(w, c.uid)).sort()), w.r2.keys().join(" "));
  chk("子請求 ≤ 11", r._cost <= 11, r._cost + " 個");
  const w2 = world();
  const e = await submit(w2, { changes:{ company:"列不出照片 1" }, photos:{ image: IMG(6) } });
  const f = await submit(w2, { label:"A1・王大銘", name:"王大銘", changes:{ company:"列不出照片 2" }, photos:{ image: IMG(7) } });
  w2.r2.fail = { op:"list", key:"updates/img/" };
  const r2 = await call(w2, "/member-update-drop-batch", { session:sOwner, uids:[e.uid, f.uid] });
  w2.r2.fail = null;
  const dels2 = r2._r2.filter(x => x.op === "delete");
  chk("★ 列 updates/img/ 丟例外 → 照常刪請求(照片留給 lifecycle)", r2.ok && r2.dropped === 2 && reqKeys(w2).length === 0 &&
      imgKeys(w2).length === 2 && dels2.length === 1 && eq([...dels2[0].key].sort(), [e.uid, f.uid].map(keyOf).sort()), brief(r2));
}

/* ══ 預算總表 ══ 每支端點在整份測試裡的最壞子請求數(GitHub + 公開網站 + R2 + KV) */
hr("★ 子請求預算(GitHub + 公開網站 + R2 + KV,上限 50)");
{
  const caps = { "/member-update":18, "/member-updates":7, "/member-update-get":3, "/member-update-photo":4,
                 "/member-update-apply":50, "/member-update-drop":5, "/member-update-drop-batch":11 };
  for(const [p, cap] of Object.entries(caps)){
    const got = maxCost[p];
    chk(`${p} 最壞 ${got} 個 ≤ ${cap}(≤ 50)`, typeof got === "number" && got <= cap && got <= 50);
  }
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
