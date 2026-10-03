/* 最近刪除的夥伴(回收區 /recycle-*)的 Worker 端測試。
   用**真實的 worker/publish-relay.js**,把 GitHub、R2、KV 換成 tests/github-model.mjs 的假物件。

   要守住的不變式:
     ・rid 一律由 Worker 產生、先過格式檢查才組 key —— 讀不到、也刪不到 recycle/ 以外的東西
     ・組長只能存、看、救自己那一組;唯讀帳號什麼都不行;永久刪除只限總管理員
     ・救回:用 gid 找**現在的**代號;放回 min(原位置, 人數);成員卡原樣放回(不改 updatedAt);
       已經在名錄上 → already_present 且清掉回收物件;壞檔不 commit;同一個人不會被寫成兩張卡
     ・★ 子請求預算:GitHub + R2 + KV 的呼叫**全部**算進去,每支端點 ≤ 50

   執行:node tests/recycle.test.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGitHub, FakeR2, FakeKV, loadWorker } from "./github-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = loadWorker(path.join(ROOT, "worker/publish-relay.js"), fs, ["RECYCLE_ID_RE", "RECYCLE_PUT_MAX"]);

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const brief = o => JSON.stringify(o, (k, v) => k.startsWith("_") ? undefined : v).slice(0, 160);

/* ── 測資 ─────────────────────────────────────────────────────────────── */
const SS = "x".repeat(48);
const IDX = [
  { code:"A1", name:"肉品海鮮批發組", id:"g3" },
  { code:"B1", name:"滿分食品供應組", id:"g12" },
  { code:"C",  name:"測試大組",       id:"g10" },
];
const GID = { a1:"g3", b1:"g12", c:"g10" };
const M = (id, name, extra = {}) => Object.assign({
  number:"", name, title:"", services:[], targets:[], have:[], want:[], tagline:[],
  image:"", card:"", products:[], company:"", business_items:"", website:"",
  id, dataIssue:false, updatedAt:"2026-07-28T07:14:10.402Z" }, extra);
const A1_MEMBERS = () => [
  M("g3_m1", "曾俊凱", { title:"豬肉屠宰批發零售", services:["冷藏/凍豬肉原料批發"] }),
  M("g3_m9", "王大銘", { title:"水產批發", company:"大銘水產", phone:"0912-345-678", updatedAt:"2026-09-02T01:02:03.000Z" }),
  M("g3_m2", "林小美", { title:"蔬果", dataIssue:true }),
  M("g3_m3", "李小華", { title:"甲" }),
  M("g3_m4", "陳阿明", { title:"乙" }),
  M("g3_m5", "張多項", { title:"雜貨" }),
  M("g3_m6", "黃最後", { title:"最後一位" }),
];
const grpJson = members => JSON.stringify({ leader:"組長", room:"", members, recruiting:[] }, null, 2) + "\n";
const pad2 = n => String(n).padStart(2, "0");
const baseFiles = () => ({
  "data/_index.json": JSON.stringify(IDX, null, 2) + "\n",
  "data/a1.json": grpJson(A1_MEMBERS()),
  "data/b1.json": grpJson([ M("g12_m1", "陳大文", { title:"烘焙" }), M("g12_m2", "吳小芳", { title:"甜點" }) ]),
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

/* 每次呼叫都量子請求:GitHub API(gh.subrequests)+ R2 呼叫 + KV 呼叫 —— R2 與 KV 都算在 50 個以內。
   同時跑好幾個請求時量不準,那幾次傳 track:false。 */
const maxCost = {};
async function call(w, p, body, opt = {}){
  const s0 = w.gh.subrequests, a0 = w.gh.apiCalls, r0 = w.r2.calls.length, k0 = w.kv.calls;
  const res = await W.__worker.fetch(new Request("https://w.test" + p, { method:"POST",
    headers:{ "Content-Type":"application/json", "CF-Connecting-IP":"1.2.3.4" },
    body: typeof body === "string" ? body : JSON.stringify(body) }), w.env);
  const out = await res.json().catch(() => ({}));
  out._status = res.status;
  out._cost = (w.gh.subrequests - s0) + (w.r2.calls.length - r0) + (w.kv.calls - k0);
  out._api = w.gh.apiCalls - a0;
  out._r2 = w.r2.calls.slice(r0);
  if(opt.track !== false) maxCost[p] = Math.max(maxCost[p] || 0, out._cost);
  return out;
}
const put = (w, sess, items, opt) => call(w, "/recycle-put", { session:sess, items }, opt);
const list = (w, sess, opt) => call(w, "/recycle-list", { session:sess }, opt);
const restore = (w, sess, rid, opt) => call(w, "/recycle-restore", { session:sess, rid }, opt);
const drop = (w, sess, rid, opt) => call(w, "/recycle-drop", { session:sess, rid }, opt);

const groupOf = (w, code) => JSON.parse(w.gh.files().get("data/" + code + ".json"));
const idsOf = (w, code) => groupOf(w, code).members.map(m => m.id);
/* 從**目前**的組檔取出一位的回收項目(後台在發布前做的事:線上那組的 index 與完整成員卡) */
function itemFor(w, code, id){
  const g = groupOf(w, code);
  const index = g.members.findIndex(m => m.id === id);
  return { gid: GID[code], code: code.toUpperCase(), index, member: g.members[index] };
}
/* 模擬一次「把這幾位刪掉」的發布 */
function removeMembers(w, code, ids){
  const g = groupOf(w, code);
  return w.gh.pushFiles({ ["data/" + code + ".json"]: grpJson(g.members.filter(m => !ids.includes(m.id))) }, "發布:刪人");
}
function setMember(w, code, id, patch){
  const g = groupOf(w, code);
  Object.assign(g.members.find(x => x.id === id), patch);
  return w.gh.pushFiles({ ["data/" + code + ".json"]: grpJson(g.members) }, "其他人發布");
}
const recKeys = w => w.r2.keys().filter(k => k.startsWith("recycle/"));
const keyOf = rid => "recycle/" + rid + ".json";
const commitsWith = (w, prefix) => [...w.gh.commits.values()].filter(c => String(c.message).startsWith(prefix));
/* 把 Date.now 暫時撥到指定時間(Worker 的 at 與 rid 都從 Date.now 來)。只往過去撥,session 不會過期。 */
const realNow = Date.now;
async function atTime(ms, fn){ Date.now = () => ms; try{ return await fn(); } finally{ Date.now = realNow; } }

const RID_RE = /^r_[0-9a-z]{9}_[0-9a-z]{6}$/;
const sOwner  = await W.makeSession(SS, { name:"owner", role:"owner", group:"" });
const sA1     = await W.makeSession(SS, { name:"a1", role:"leader", group:"A1" });
const sB1     = await W.makeSession(SS, { name:"b1", role:"leader", group:"B1" });
const sA9     = await W.makeSession(SS, { name:"a9", role:"leader", group:"A9" });
const sViewer = await W.makeSession(SS, { name:"v", role:"viewer", group:"" });

/* ══ 1 ══ 存進回收區 */
hr("① /recycle-put 正常:每位一個物件、內容與 metadata 齊全、by/at 由 Worker 填");
{
  chk("RECYCLE_ID_RE 就是預期的格式(不含 . / 與大寫)", String(W.RECYCLE_ID_RE) === String(RID_RE), String(W.RECYCLE_ID_RE));
  const w = world();
  const it1 = itemFor(w, "a1", "g3_m9"), it2 = itemFor(w, "b1", "g12_m2");
  removeMembers(w, "a1", ["g3_m9"]); removeMembers(w, "b1", ["g12_m2"]);
  const t0 = Date.now();
  // 前端多送的 by / at / rid 一律不採用
  const r = await put(w, sOwner, [Object.assign({ by:"冒名", at:"2000-01-01T00:00:00.000Z", rid:"r_000000000_aaaaaa" }, it1), it2]);
  chk("200 ok,stored 2,兩個 rid 都合格且不同", r._status === 200 && r.ok === true && r.stored === 2 &&
      r.rids.length === 2 && r.rids.every(x => RID_RE.test(x)) && r.rids[0] !== r.rids[1], brief(r));
  chk("R2 裡正好是 recycle/<rid>.json 兩個", eq(recKeys(w), r.rids.map(keyOf).sort()));
  const rec = w.r2.peekJson(keyOf(r.rids[0]));
  chk("內容 { v:1, rid, at, by, gid, code, index, member }", eq(Object.keys(rec), ["v","rid","at","by","gid","code","index","member"]) &&
      rec.v === 1 && rec.rid === r.rids[0] && rec.gid === "g3" && rec.code === "A1" && rec.index === 1, brief(rec));
  chk("★ 成員卡原樣存下(含 updatedAt 與白名單以外的欄位)", eq(rec.member, it1.member) && rec.member.phone === "0912-345-678");
  chk("★ by 是 session 的帳號、at 是 Worker 的時間(不採用前端送的)",
      rec.by === "owner" && Date.parse(rec.at) >= t0 - 1000 && rec.at !== "2000-01-01T00:00:00.000Z" && rec.rid !== "r_000000000_aaaaaa");
  const meta = w.r2.peekMeta(keyOf(r.rids[0]));
  chk("customMetadata 正好是 v/at/by/gid/code/id/name", eq(Object.keys(meta).sort(), ["at","by","code","gid","id","name","v"]) &&
      meta.v === "1" && meta.gid === "g3" && meta.code === "A1" && meta.id === "g3_m9" && meta.at === rec.at, brief(meta));
  chk("metadata 是 UTF-8 原文(沒有 encodeURIComponent)", meta.name === "王大銘");
  chk("metadata ≤ 2,048 bytes", Buffer.byteLength(JSON.stringify(meta)) <= 2048, Buffer.byteLength(JSON.stringify(meta)) + " bytes");
  chk("contentType 是 application/json", (w.r2.meta.get(keyOf(r.rids[0])) || {}).contentType === "application/json");
  chk("總管理員不讀 GitHub(子請求 = 2 次 put)", r._api === 0 && r._cost === 2, `api=${r._api} cost=${r._cost}`);
  chk("沒有產生任何 commit", commitsWith(w, "救回").length === 0 && w.gh.commits.size === 3);

  const l = await put(w, sA1, [itemFor(w, "a1", "g3_m2")]);
  chk("組長存自己那一組 → ok,by = 組長帳號,讀 _index 1 次", l.ok && w.r2.peekJson(keyOf(l.rids[0])).by === "a1" && l._api === 1, brief(l));
}

/* ══ 2 ══ 唯讀與 session */
hr("② 唯讀帳號:put/list/restore 403 read_only、drop 403 admin_only;session 過期 401");
{
  const w = world();
  const ok = await put(w, sOwner, [itemFor(w, "a1", "g3_m9")]);
  const rid = ok.rids[0];
  const vp = await put(w, sViewer, [itemFor(w, "a1", "g3_m2")]);
  const vl = await list(w, sViewer);
  const vr = await restore(w, sViewer, rid);
  const vd = await drop(w, sViewer, rid);
  chk("put → 403 read_only", vp._status === 403 && vp.error === "read_only", brief(vp));
  chk("list → 403 read_only", vl._status === 403 && vl.error === "read_only", brief(vl));
  chk("restore → 403 read_only", vr._status === 403 && vr.error === "read_only", brief(vr));
  chk("drop → 403 admin_only", vd._status === 403 && vd.error === "admin_only", brief(vd));
  chk("唯讀帳號什麼都沒動到(R2 只有原本那一筆,沒有讀寫)", eq(recKeys(w), [keyOf(rid)]) &&
      [vp, vl, vr, vd].every(r => r._r2.length === 0 && r._api === 0));
  const ex = await put(w, "garbage.token", [itemFor(w, "a1", "g3_m2")]);
  const ex2 = await restore(w, "", rid);
  chk("session 不合格 → 401 session_expired", ex._status === 401 && ex.error === "session_expired" && ex2._status === 401);
  const bad = await call(w, "/recycle-put", "{不是 JSON");
  chk("body 不是 JSON → 400 bad_request", bad._status === 400 && bad.error === "bad_request");
}

/* ══ 3 ══ 組長的組別 */
hr("③ 組長只能存自己那一組");
{
  const w = world();
  const o = await put(w, sA1, [itemFor(w, "b1", "g12_m1")]);
  chk("組長 A1 存 B1 的人 → 403 forbidden_group", o._status === 403 && o.error === "forbidden_group", brief(o));
  const mix = await put(w, sA1, [itemFor(w, "a1", "g3_m9"), itemFor(w, "b1", "g12_m1")]);
  chk("★ 一批裡混一筆別組的 → 整批 403,一筆都不寫", mix._status === 403 && mix.error === "forbidden_group" && recKeys(w).length === 0, brief(mix));
  // 拿自己的 gid 包一張別組的卡:member.id 不以 gid_ 開頭,在格式檢查就擋下
  const disguised = await put(w, sA1, [Object.assign(itemFor(w, "b1", "g12_m1"), { gid:"g3", code:"A1" })]);
  chk("★ 拿自己的 gid 包別組成員 → 400(member_gid)", disguised._status === 400 && disguised.reason === "member_gid", brief(disguised));
  const gone = await put(w, sA9, [itemFor(w, "a1", "g3_m9")]);
  chk("組長的代號已不在 _index → 409 group_renamed", gone._status === 409 && gone.error === "group_renamed", brief(gone));
  chk("以上都沒有寫入 R2", recKeys(w).length === 0 && w.r2.calls.every(c => c.op !== "put"));
}

/* ══ 4 ══ 格式檢查 */
hr("④ /recycle-put 格式不合 → 400 bad_request,整批不寫");
{
  const w = world();
  const good = () => itemFor(w, "a1", "g3_m9");
  const withM = patch => { const it = good(); it.member = Object.assign({}, it.member, patch); return it; };
  const cases = [
    ["沒有 items", { session:sOwner }],
    ["items 不是陣列", { session:sOwner, items:{ 0:good() } }],
    ["items 是空陣列", { session:sOwner, items:[] }],
    ["items 超過 20 筆", { session:sOwner, items: Array.from({ length: W.RECYCLE_PUT_MAX + 1 }, good) }],
    ["項目是 null", { session:sOwner, items:[null] }],
    ["項目是陣列", { session:sOwner, items:[[good()]] }],
    ["gid 缺", { session:sOwner, items:[Object.assign(good(), { gid:undefined })] }],
    ["gid 是 ../g3", { session:sOwner, items:[Object.assign(good(), { gid:"../g3" })] }],
    ["gid 是數字", { session:sOwner, items:[Object.assign(good(), { gid:3 })] }],
    ["code 空白", { session:sOwner, items:[Object.assign(good(), { code:"" })] }],
    ["code 含符號", { session:sOwner, items:[Object.assign(good(), { code:"A-1" })] }],
    ["index 是 -1", { session:sOwner, items:[Object.assign(good(), { index:-1 })] }],
    ["index 是 1.5", { session:sOwner, items:[Object.assign(good(), { index:1.5 })] }],
    ["index 是字串", { session:sOwner, items:[Object.assign(good(), { index:"2" })] }],
    ["index 太大", { session:sOwner, items:[Object.assign(good(), { index:100001 })] }],
    ["member 缺", { session:sOwner, items:[Object.assign(good(), { member:undefined })] }],
    ["member 是陣列", { session:sOwner, items:[Object.assign(good(), { member:[1] })] }],
    ["member 是字串", { session:sOwner, items:[Object.assign(good(), { member:"g3_m9" })] }],
    ["member.id 缺", { session:sOwner, items:[withM({ id:undefined })] }],
    ["member.id 是 ../index", { session:sOwner, items:[withM({ id:"../index" })] }],
    ["member.id 是 g3_../x", { session:sOwner, items:[withM({ id:"g3_../x" })] }],
    ["member.id 超過 64 字", { session:sOwner, items:[withM({ id:"g3_" + "m".repeat(62) })] }],
    ["★ member.id 不以 gid_ 開頭(別組)", { session:sOwner, items:[withM({ id:"g12_m1" })] }],
    ["★ member.id 不以 gid_ 開頭(少底線)", { session:sOwner, items:[withM({ id:"g3m9" })] }],
    ["★ member.id 不以 gid_ 開頭(前綴相似 g33_)", { session:sOwner, items:[withM({ id:"g33_m1" })] }],
    ["member 序列化超過 64KB", { session:sOwner, items:[withM({ business_items:"字".repeat(22 * 1024) })] }],
    ["第 1 筆合格、第 2 筆不合格", { session:sOwner, items:[good(), withM({ id:"g12_m1" })] }],
  ];
  const bad = [];
  for(const [name, body] of cases){
    const r = await call(w, "/recycle-put", body);
    if(!(r._status === 400 && r.error === "bad_request")) bad.push(name + " → " + r._status + " " + r.error);
  }
  chk(`${cases.length} 種不合格的輸入都是 400 bad_request`, !bad.length, bad.join("、"));
  chk("★ 以上沒有任何一次寫進 R2(連第 1 筆合格的那批也沒有)", recKeys(w).length === 0 && w.r2.calls.length === 0);
  const r = await call(w, "/recycle-put", { session:sOwner, items:[good(), withM({ id:"g12_m1" })] });
  chk("錯誤回應只說第幾筆、哪一項,不回內容", r.item === 1 && r.reason === "member_gid" && !JSON.stringify(r).includes("王大銘"), brief(r));
  const raw = JSON.stringify({ session:sOwner, items:[] }).replace('"items":[]', '"items":[{"__proto__":{"gid":"g3","code":"A1","index":0,"member":{"id":"g3_m9"}}}]');
  const proto = await call(w, "/recycle-put", raw);
  chk("★ 欄位藏在 __proto__ 裡 → 400(只認自己的鍵)", proto._status === 400 && proto.reason === "gid", brief(proto));
  const max = await put(w, sOwner, Array.from({ length: W.RECYCLE_PUT_MAX }, good));
  chk("正好 20 筆 → ok", max.ok && max.stored === 20 && recKeys(w).length === 20, brief(max));
}

/* ══ 5 ══ 沒綁 R2 / ping */
hr("⑤ 沒綁 R2 → 503 pending_image_store_unavailable;/ping 的 caps.recycle 跟著 binding");
{
  const w = world({ env:{ PENDING_IMAGES: undefined } });
  const rs = [
    await put(w, sOwner, [itemFor(w, "a1", "g3_m9")]),
    await list(w, sOwner),
    await restore(w, sOwner, "r_000000001_abcdef"),
    await drop(w, sOwner, "r_000000001_abcdef"),
  ];
  chk("put/list/restore/drop 全部 503", rs.every(r => r._status === 503 && r.error === "pending_image_store_unavailable"),
      rs.map(r => r._status + " " + r.error).join(","));
  chk("沒有打 GitHub", rs.every(r => r._api === 0));
  const p = await call(world(), "/ping", {});
  const p2 = await call(w, "/ping", {});
  chk("綁了 → caps.recycle true;沒綁 → false", p.caps && p.caps.recycle === true && p2.caps.recycle === false, brief(p2.caps));
}

/* ══ 6 ══ 中途 put 失敗 */
hr("⑥ 第 2 筆 put 丟例外 → 502 update_store_failed,附 stored;已寫的不回滾");
{
  const w = world();
  w.r2.fail = { op:"put", nth:2, once:true };
  const r = await put(w, sOwner, [itemFor(w, "a1", "g3_m9"), itemFor(w, "a1", "g3_m2"), itemFor(w, "a1", "g3_m3")]);
  chk("502 update_store_failed,stored 1", r._status === 502 && r.error === "update_store_failed" && r.stored === 1 &&
      r.rids.length === 1, brief(r));
  chk("第 1 筆留著(回收區多一筆無害),第 3 筆沒有寫", eq(recKeys(w), [keyOf(r.rids[0])]) &&
      r._r2.filter(c => c.op === "put").length === 2 && !r._r2.some(c => c.op === "delete"));
}

/* ══ 7 ══ 清單 */
hr("⑦ /recycle-list:新到舊、組長只看自己那一組、壞 metadata 跳過、代號用現在的");
{
  const w = world();
  const DAY = 86400000, now = realNow();
  const r1 = await atTime(now - 3 * DAY, () => put(w, sOwner, [itemFor(w, "a1", "g3_m9")]));
  const r2 = await atTime(now - 2 * DAY, () => put(w, sB1, [itemFor(w, "b1", "g12_m2")]));
  const r3 = await atTime(now - 1 * DAY, () => put(w, sA1, [itemFor(w, "a1", "g3_m2")]));
  chk("★ rid 的字典序就是新到舊(R2 list 由小到大,讀不完時少掉的是最舊的)",
      r3.rids[0] < r2.rids[0] && r2.rids[0] < r1.rids[0], [r1, r2, r3].map(r => r.rids[0]).join(" > "));
  // 壞掉或不是回收物件的東西
  const meta = (o = {}) => Object.assign({ v:"1", at:new Date().toISOString(), by:"x", gid:"g3", code:"A1", id:"g3_m1", name:"壞" }, o);
  const raw = (k, m) => w.r2.put(k, "{}", { customMetadata: m });
  await raw("recycle/r_bad.json", meta());                                  // rid 格式不對
  await raw("recycle/r_000000000_aaaaaa.json", meta({ gid:undefined }));     // 缺 gid
  await raw("recycle/r_000000000_bbbbbb.json", meta({ v:"2" }));             // 不認得的版本
  await raw("recycle/r_000000000_cccccc.json", meta({ id:"g12_m1" }));       // id 與 gid 對不上
  await raw("recycle/r_000000000_dddddd.json", meta({ at:"不是時間" }));
  await raw("updates/req/u_abcdef12.json", meta());                         // 別的前綴不列
  const l = await list(w, sOwner);
  chk("總管理員看到 3 筆,依刪除時間新到舊", l.ok && eq(l.items.map(x => x.id), ["g3_m2", "g12_m2", "g3_m9"]), brief(l));
  chk("每一筆是 { rid, at, by, gid, code, groupMissing, id, name }",
      eq(Object.keys(l.items[0]), ["rid","at","by","gid","code","groupMissing","id","name"]) &&
      eq(l.items[2], { rid:r1.rids[0], at:new Date(now - 3 * DAY).toISOString(), by:"owner", gid:"g3", code:"A1",
                       groupMissing:false, id:"g3_m9", name:"王大銘" }), brief(l.items[2]));
  chk("★ 壞掉的 metadata 跳過並計數(unknown 5),不讓整份清單變錯誤", l.unknown === 5 && l.truncated === false, brief(l));
  chk("清單不回成員卡內容", !JSON.stringify(l).includes("0912-345-678"));
  const la = await list(w, sA1), lb = await list(w, sB1);
  chk("★ 組長 A1 只看到 g3 的 2 筆", la.ok && eq(la.items.map(x => x.id), ["g3_m2", "g3_m9"]), brief(la));
  chk("★ 組長 B1 只看到 g12 的 1 筆", lb.ok && eq(lb.items.map(x => x.id), ["g12_m2"]), brief(lb));
  chk("子請求 ≤ 7", [l, la, lb].every(r => r._cost <= 7), [l, la, lb].map(r => r._cost).join("/"));

  // 改代號 A1 → A9;刪掉 B1 整組
  const idx = IDX.map(e => e.id === "g3" ? Object.assign({}, e, { code:"A9" }) : e).filter(e => e.id !== "g12");
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(idx, null, 2) + "\n", "data/a9.json": w.gh.files().get("data/a1.json"),
                   "data/a1.json": null, "data/b1.json": null }, "改代號、刪分組");
  const l2 = await list(w, sOwner);
  const by = id => l2.items.find(x => x.id === id) || {};
  chk("★ 代號用現在的(A1 → A9)", by("g3_m9").code === "A9" && by("g3_m9").groupMissing === false, brief(by("g3_m9")));
  chk("分組已不在 → groupMissing:true,沿用刪除當時的代號", by("g12_m2").groupMissing === true && by("g12_m2").code === "B1", brief(by("g12_m2")));
  const old = await list(w, sA1), neu = await list(w, sA9);
  chk("舊代號的組長 → 409 group_renamed;新代號的組長看得到", old._status === 409 && old.error === "group_renamed" &&
      neu.ok && eq(neu.items.map(x => x.id), ["g3_m2", "g3_m9"]), brief(old));
}

/* ══ 8 ══ 分頁與截斷 */
hr("⑧ 清單分頁:最多 5 頁;讀不完時 truncated,少掉的是最舊的");
{
  const w = world();
  w.r2.metaPageSize = 2;
  const now = realNow();
  const ids = Array.from({ length:12 }, (_, i) => "g10_m" + pad2(i + 1));
  for(let i = 0; i < 7; i++){
    await atTime(now - (12 - i) * 60000, () => put(w, sOwner, [itemFor(w, "c", ids[i])]));
  }
  const l7 = await list(w, sOwner);
  chk("7 筆、每頁 2 筆(4 頁)→ 全部列出,truncated false", l7.ok && l7.items.length === 7 && l7.truncated === false &&
      l7._r2.filter(c => c.op === "list").length === 4, brief(l7));
  for(let i = 7; i < 12; i++){
    await atTime(now - (12 - i) * 60000, () => put(w, sOwner, [itemFor(w, "c", ids[i])]));
  }
  const l12 = await list(w, sOwner);
  chk("12 筆(要 6 頁)→ 只讀 5 頁,truncated true", l12.ok && l12.truncated === true && l12.items.length === 10 &&
      l12._r2.filter(c => c.op === "list").length === 5, brief(l12));
  chk("★ 列出來的是最新的 10 筆(最舊的 2 筆沒列到)", eq(l12.items.map(x => x.id), ids.slice(2).reverse()), l12.items.map(x => x.id).join(","));
  chk("子請求 = _index 1 + list 5", l12._cost === 6, l12._cost + " 個");
  // 組長的過濾在分頁之後:別組的物件照樣佔頁數,但不會出現在他的清單裡
  await put(w, sOwner, [itemFor(w, "a1", "g3_m9")]);
  const la = await list(w, sA1);
  chk("組長 A1 只看到自己那一組", la.ok && eq(la.items.map(x => x.id), ["g3_m9"]) && la.truncated === true, brief(la));
  w.r2.fail = { op:"list", nth: w.r2._n.list + 2, once:true };
  const lf = await list(w, sOwner);
  chk("list 中途丟例外 → 502 update_store_failed", lf._status === 502 && lf.error === "update_store_failed", brief(lf));
}

/* ══ 9 ══ 救回 */
hr("⑨ /recycle-restore 正常:放回原位、成員卡原樣、commit 訊息、清掉回收物件");
{
  const w = world();
  const original = itemFor(w, "a1", "g3_m9");             // index 1
  removeMembers(w, "a1", ["g3_m9"]);
  const p = await put(w, sOwner, [original]);
  const rid = p.rids[0];
  const r = await restore(w, sOwner, rid);
  chk("200 ok,回 { id, name, code, commit }", r.ok === true && r.id === "g3_m9" && r.name === "王大銘" && r.code === "A1" &&
      r.commit === w.gh.head && !("cleanupFailed" in r), brief(r));
  chk("★ 放回原本的位置(index 1)", eq(idsOf(w, "a1"), ["g3_m1","g3_m9","g3_m2","g3_m3","g3_m4","g3_m5","g3_m6"]), idsOf(w, "a1").join(","));
  const back = groupOf(w, "a1").members[1];
  chk("★ 成員卡原樣放回(updatedAt 沒變、白名單以外的欄位也在)", eq(back, original.member) &&
      back.updatedAt === "2026-09-02T01:02:03.000Z" && back.phone === "0912-345-678");
  chk("組檔其他部分不變", eq(groupOf(w, "a1"), JSON.parse(baseFiles()["data/a1.json"])));
  const cs = commitsWith(w, "救回刪除的夥伴：");
  chk("★ commit 訊息「救回刪除的夥伴：王大銘（A1・owner）」", cs.length === 1 && cs[0].message === "救回刪除的夥伴：王大銘（A1・owner）",
      cs.map(c => c.message).join(" | "));
  chk("只動到 data/a1.json 一個檔", (() => {
    const c = w.gh.commits.get(w.gh.head), prev = w.gh.trees.get(w.gh.commits.get(c.parent).tree), cur = w.gh.trees.get(c.tree);
    const changed = [...new Set([...prev.keys(), ...cur.keys()])].filter(k => prev.get(k) !== cur.get(k));
    return eq(changed, ["data/a1.json"]);
  })());
  chk("回收物件已刪除", recKeys(w).length === 0);
  chk("子請求 ≤ 34(總管理員)", r._cost <= 34, r._cost + " 個");

  // 原本排在最後,之後組裡少了好幾個人 → 放在最後(min(index, 人數))
  const last = itemFor(w, "a1", "g3_m6");                  // index 6
  removeMembers(w, "a1", ["g3_m6", "g3_m3", "g3_m4", "g3_m5"]);
  const p2 = await put(w, sA1, [last]);
  const r2 = await restore(w, sA1, p2.rids[0]);
  chk("★ 原位置 6 > 現在人數 3 → 放在第 3 位(最後)", r2.ok && eq(idsOf(w, "a1"), ["g3_m1","g3_m9","g3_m2","g3_m6"]), brief(r2));
  chk("組長救自己那一組 → commit 訊息帶組長帳號", commitsWith(w, "救回刪除的夥伴：黃最後（A1・a1）").length === 1);
  chk("子請求 ≤ 40(組長)", r2._cost <= 40, r2._cost + " 個");

  // 原本是第一位
  const first = itemFor(w, "a1", "g3_m1");
  removeMembers(w, "a1", ["g3_m1"]);
  const r3 = await restore(w, sOwner, (await put(w, sOwner, [first])).rids[0]);
  chk("原位置 0 → 放回第一位", r3.ok && idsOf(w, "a1")[0] === "g3_m1", idsOf(w, "a1").join(","));
}

/* ══ 10 ══ 救回的權限 */
hr("⑩ 組長不能救別組;沒有寫入、物件還在");
{
  const w = world();
  const it = itemFor(w, "a1", "g3_m9");
  removeMembers(w, "a1", ["g3_m9"]);
  const rid = (await put(w, sOwner, [it])).rids[0];
  const head0 = w.gh.head;
  const b = await restore(w, sB1, rid);
  chk("組長 B1 救 A1 的人 → 403 forbidden_group", b._status === 403 && b.error === "forbidden_group", brief(b));
  const o = await restore(w, sA9, rid);
  chk("代號不在 _index 的組長 → 409 group_renamed", o._status === 409 && o.error === "group_renamed", brief(o));
  chk("沒有 commit,回收物件還在", w.gh.head === head0 && eq(recKeys(w), [keyOf(rid)]));
  chk("擋下之前只讀了 _index(沒有讀組檔、沒有動 R2 以外的東西)", [b, o].every(r => r._api === 1 &&
      eq(r._r2.map(c => c.op), ["get"])), [b, o].map(r => r._api + "/" + r._r2.map(c => c.op)).join(" "));
  const ok = await restore(w, sA1, rid);
  chk("本組組長 → ok", ok.ok === true, brief(ok));
}

/* ══ 11 ══ rid 格式 */
hr("⑪ rid 格式不合(路徑穿越、別的前綴、大小寫、型別)→ 400,不碰 R2");
{
  const w = world();
  const rid = (await put(w, sOwner, [itemFor(w, "a1", "g3_m9")])).rids[0];
  await w.r2.put("pending/p_x/image-0.jpg", new Uint8Array([1, 2, 3]));
  await w.r2.put("updates/req/u_abcdef12.json", "{}");
  const bads = ["", "../pending/p_x/image-0", "r_../../pending/x", rid + "/../x", rid.toUpperCase(), "R" + rid.slice(1),
    "r_00000000_abcdef", "r_0000000000_abcdef", "r_000000000_abcde", "r_000000000-abcdef", "u_abcdef12",
    "recycle/" + rid, rid + ".json", " " + rid, rid + "\n", 5, null, [rid], { toString:null }];
  const res = [];
  for(const b of bads){
    res.push(await call(w, "/recycle-restore", { session:sOwner, rid:b }));
    res.push(await call(w, "/recycle-drop", { session:sOwner, rid:b }));
  }
  const wrong = res.filter(r => !(r._status === 400 && r.error === "bad_request"));
  chk(`restore/drop × ${bads.length} 種 → 全部 400 bad_request`, !wrong.length, wrong.map(brief).join(" | "));
  chk("★ 一次都沒有碰 R2(先驗格式才組 key)", res.every(r => r._r2.length === 0 && r._api === 0));
  chk("pending/ 與 updates/ 的物件都還在", w.r2.objects.has("pending/p_x/image-0.jpg") && w.r2.objects.has("updates/req/u_abcdef12.json") &&
      eq(recKeys(w), [keyOf(rid)]));
}

/* ══ 12 ══ 已經在名錄上 */
hr("⑫ 名錄上已經有同一個 id → 409 already_present,並刪掉回收物件");
{
  const w = world();
  const rid = (await put(w, sOwner, [itemFor(w, "a1", "g3_m9")])).rids[0];   // 沒有真的刪掉
  const head0 = w.gh.head;
  const r = await restore(w, sOwner, rid);
  chk("409 already_present(附 id、代號)", r._status === 409 && r.error === "already_present" && r.id === "g3_m9" && r.code === "A1", brief(r));
  chk("★ 回收物件刪掉了,沒有 commit,組檔不變", recKeys(w).length === 0 && w.gh.head === head0 &&
      idsOf(w, "a1").filter(x => x === "g3_m9").length === 1);
  chk("子請求 ≤ 6", r._cost <= 6, r._cost + " 個");
  const again = await restore(w, sOwner, rid);
  chk("再按一次 → 409 recycle_gone", again._status === 409 && again.error === "recycle_gone", brief(again));

  // 同一個人被記了兩筆(發布後重試):第一筆救回,第二筆被認出來
  const w2 = world();
  const it = itemFor(w2, "a1", "g3_m9");
  removeMembers(w2, "a1", ["g3_m9"]);
  const a = (await put(w2, sOwner, [it])).rids[0], b = (await put(w2, sOwner, [it])).rids[0];
  const ra = await restore(w2, sOwner, a), rb = await restore(w2, sOwner, b);
  chk("★ 同一位記了兩筆 → 第一筆救回、第二筆 already_present;名錄上只有一張卡",
      ra.ok && rb.error === "already_present" && idsOf(w2, "a1").filter(x => x === "g3_m9").length === 1 && recKeys(w2).length === 0,
      brief(rb));
}

/* ══ 13 ══ 改代號 */
hr("⑬ 刪除之後總管理員改了代號(gid 不變)→ 照樣救回到新檔");
{
  const w = world();
  const it = itemFor(w, "a1", "g3_m9");
  removeMembers(w, "a1", ["g3_m9"]);
  const rid = (await put(w, sOwner, [it])).rids[0];
  const rid2 = (await put(w, sOwner, [itemFor(w, "a1", "g3_m2")])).rids[0];
  removeMembers(w, "a1", ["g3_m2"]);
  const idx = IDX.map(e => e.id === "g3" ? Object.assign({}, e, { code:"A9" }) : e);
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(idx, null, 2) + "\n", "data/a9.json": w.gh.files().get("data/a1.json"), "data/a1.json": null }, "改代號");
  const old = await restore(w, sA1, rid);
  chk("舊代號的組長 → 409 group_renamed,物件還在", old._status === 409 && old.error === "group_renamed" && recKeys(w).length === 2, brief(old));
  const r = await restore(w, sOwner, rid);
  chk("★ 依 gid 找到新代號 A9、寫進 data/a9.json 的原位", r.ok && r.code === "A9" && idsOf(w, "a9")[1] === "g3_m9" &&
      !w.gh.files().has("data/a1.json"), brief(r));
  chk("commit 訊息用新代號", commitsWith(w, "救回刪除的夥伴：王大銘（A9・owner）").length === 1);
  const r2 = await restore(w, sA9, rid2);
  chk("新代號的組長救得回來", r2.ok && r2.code === "A9" && idsOf(w, "a9").includes("g3_m2"), brief(r2));
}

/* ══ 14 ══ 分組被刪 */
hr("⑭ 分組已經不在 → 409 group_missing,不替他猜要放哪一組");
{
  const w = world();
  const rid = (await put(w, sOwner, [itemFor(w, "b1", "g12_m1")])).rids[0];
  w.gh.pushFiles({ "data/_index.json": JSON.stringify(IDX.filter(e => e.id !== "g12"), null, 2) + "\n", "data/b1.json": null }, "刪分組");
  const head0 = w.gh.head;
  const r = await restore(w, sOwner, rid);
  chk("409 group_missing", r._status === 409 && r.error === "group_missing", brief(r));
  chk("沒有 commit、物件還在(可以之後再處理或永久刪除)", w.gh.head === head0 && eq(recKeys(w), [keyOf(rid)]));
  const l = await restore(w, sB1, rid);
  chk("該組組長(代號已不在)→ 409 group_renamed", l._status === 409 && l.error === "group_renamed", brief(l));
}

/* ══ 15 ══ 壞檔 */
hr("⑮ 同組另一位的 products 是字串(壞檔)→ 400 bad_data_file,不 commit");
{
  const w = world();
  const it = itemFor(w, "a1", "g3_m9");
  removeMembers(w, "a1", ["g3_m9"]);
  const rid = (await put(w, sOwner, [it])).rids[0];
  setMember(w, "a1", "g3_m2", { products:"不是陣列" });
  const head0 = w.gh.head;
  const r = await restore(w, sOwner, rid);
  chk("400 bad_data_file(reason 指出 products)", r._status === 400 && r.error === "bad_data_file" && /products/.test(r.reason || ""), brief(r));
  chk("★ 沒有 commit,回收物件還在", w.gh.head === head0 && eq(recKeys(w), [keyOf(rid)]));

  // 回收物件本身的成員卡壞掉(被動過手腳):在讀取時就擋下
  const w2 = world();
  const rid2 = (await put(w2, sOwner, [itemFor(w2, "a1", "g3_m9")])).rids[0];
  const k = keyOf(rid2);
  const orig = w2.r2.peekJson(k);
  // 每一次都從原本的內容改一處,彼此獨立(g3_m9 還在名錄上:檢查若被跳過,就會走到 already_present)
  const tamper = async patch => {
    w2.r2.corrupt(k, Buffer.from(JSON.stringify(Object.assign({}, orig, patch))));
    return restore(w2, sOwner, rid2);
  };
  const t1 = await tamper({ member: Object.assign({}, orig.member, { id:"g12_m1" }) });
  const t2 = await tamper({ gid:"../g3" });
  const t3 = await tamper({ rid:"r_000000000_zzzzzz" });
  const t4 = await tamper({ index:-1 });
  const t5 = await tamper({ v:2 });
  const t6 = await tamper({ member:"g3_m9" });
  w2.r2.corrupt(k, Buffer.from("{不是 JSON"));
  const t7 = await restore(w2, sOwner, rid2);
  const ts = [t1, t2, t3, t4, t5, t6, t7];
  chk("★ member.id 換成別組、gid 亂填、rid 對不上、index 負數、版本不對、member 不是物件、不是 JSON → 502 recycle_unreadable",
      ts.every(r => r._status === 502 && r.error === "recycle_unreadable"), ts.map(r => r.error).join(","));
  chk("以上都沒有打 GitHub,物件還在", ts.every(r => r._api === 0) && commitsWith(w2, "救回").length === 0 && eq(recKeys(w2), [k]));
  w2.r2.corrupt(k, Buffer.from(JSON.stringify(orig)));
  w2.r2.fail = { op:"get", once:true };
  const g = await restore(w2, sOwner, rid2);
  chk("R2 get 丟例外 → 502 update_store_failed", g._status === 502 && g.error === "update_store_failed", brief(g));
  const gone = await restore(w2, sOwner, "r_000000000_nothin");
  chk("不存在 → 409 recycle_gone", gone._status === 409 && gone.error === "recycle_gone", brief(gone));
}

/* ══ 16 ══ 清理失敗 */
hr("⑯ commit 成功但刪除回收物件失敗 → ok + cleanupFailed;再按 → already_present 並清掉");
{
  const w = world();
  const it = itemFor(w, "a1", "g3_m9");
  removeMembers(w, "a1", ["g3_m9"]);
  const rid = (await put(w, sOwner, [it])).rids[0];
  w.r2.fail = { op:"delete", once:true };
  const r = await restore(w, sOwner, rid);
  chk("ok:true、cleanupFailed:true,網站資料是對的", r.ok === true && r.cleanupFailed === true && idsOf(w, "a1").includes("g3_m9") &&
      eq(recKeys(w), [keyOf(rid)]), brief(r));
  const head1 = w.gh.head;
  const again = await restore(w, sOwner, rid);
  chk("★ 再按一次 → 409 already_present、不重複寫入、物件清掉", again.error === "already_present" && w.gh.head === head1 &&
      recKeys(w).length === 0 && idsOf(w, "a1").filter(x => x === "g3_m9").length === 1, brief(again));
  // already_present 的清理也失敗
  const rid2 = (await put(w, sOwner, [itemFor(w, "a1", "g3_m9")])).rids[0];
  w.r2.fail = { op:"delete", once:true };
  const ap = await restore(w, sOwner, rid2);
  chk("already_present 時刪不掉 → 仍回 already_present + cleanupFailed", ap.error === "already_present" && ap.cleanupFailed === true, brief(ap));
}

/* ══ 17 ══ 永久刪除 */
hr("⑰ /recycle-drop:只限總管理員");
{
  const w = world();
  const rid = (await put(w, sOwner, [itemFor(w, "a1", "g3_m9")])).rids[0];
  const l = await drop(w, sA1, rid);
  chk("組長 → 403 admin_only,物件還在", l._status === 403 && l.error === "admin_only" && eq(recKeys(w), [keyOf(rid)]), brief(l));
  w.r2.fail = { op:"delete", once:true };
  const f = await drop(w, sOwner, rid);
  chk("R2 delete 丟例外 → 502 update_store_failed", f._status === 502 && f.error === "update_store_failed", brief(f));
  const r = await drop(w, sOwner, rid);
  chk("總管理員 → ok,物件刪掉;不打 GitHub、子請求 1", r.ok === true && recKeys(w).length === 0 && r._api === 0 && r._cost === 1, brief(r));
  const again = await drop(w, sOwner, rid);
  chk("已經刪掉再按 → 仍是 ok(R2 delete 不存在的 key 不會出錯)", again.ok === true, brief(again));
  const rs = await restore(w, sOwner, rid);
  chk("刪掉之後救回 → 409 recycle_gone", rs.error === "recycle_gone");
}

/* ══ 18 ══ 輪數與預算 */
hr("⑱ 救回的輪數與子請求預算(組長,最壞情況)");
{
  const countRounds = w => { let n = 0; const prev = w.gh.hooks.before;
    w.gh.hooks.before = async (u, m, s) => { if(m === "GET" && u.includes("/contents/data/a1.json")) n++; if(prev) await prev(u, m, s); };
    return () => n; };
  const setup = () => {
    const w = world();
    const it = itemFor(w, "a1", "g3_m9");
    removeMembers(w, "a1", ["g3_m9"]);
    return { w, it };
  };
  for(const races of [0, 1, 2, 3]){
    const { w, it } = setup();
    const rid = (await put(w, sA1, [it])).rids[0];
    let n = 0;
    w.gh.hooks.before = async (u, method) => {
      if(u.includes("/git/refs/") && method === "PATCH" && n < races){ n++; w.gh.pushFiles({ "data.js":"sync " + n }, "同步 bot"); }
    };
    const rounds = countRounds(w);
    const r = await restore(w, sA1, rid);
    const okExpected = races < 3;
    chk(`(a) 同步 bot 插隊 ${races} 次 → ${okExpected ? "救回" : "busy_retry_later"};${rounds()} 輪;子請求 ${r._cost}`,
        (okExpected ? (r.ok === true && recKeys(w).length === 0 && idsOf(w, "a1")[1] === "g3_m9")
                    : (r._status === 409 && r.error === "busy_retry_later" && eq(recKeys(w), [keyOf(rid)]) && !idsOf(w, "a1").includes("g3_m9"))) &&
        rounds() <= 3 && r._cost <= 40, brief(r));
  }
  {
    const { w, it } = setup();
    const rid = (await put(w, sA1, [it])).rids[0];
    let n = 0;
    w.gh.hooks.before = async (u, method) => {
      // 每一輪讀完組檔、讀 head 之前,另一位剛好發布了同組的另一位成員
      if(u.includes("/git/ref/heads/") && method === "GET"){ n++; setMember(w, "a1", "g3_m2", { title:"別人第 " + n + " 次發布" }); }
    };
    const rounds = countRounds(w);
    const r = await restore(w, sA1, rid);
    chk(`(b) ★ 每一輪都 stale_base → 3 輪(${rounds()})、回 stale_base、子請求 ${r._cost} ≤ 50、物件還在、別人的修改沒被蓋掉`,
        r._status === 409 && r.error === "stale_base" && rounds() === 3 && r._cost <= 50 && eq(recKeys(w), [keyOf(rid)]) &&
        groupOf(w, "a1").members.find(m => m.id === "g3_m2").title === "別人第 3 次發布" && !idsOf(w, "a1").includes("g3_m9"), brief(r));
  }
  {
    const { w, it } = setup();
    const rid = (await put(w, sA1, [it])).rids[0];
    let once = false;
    w.gh.hooks.before = async (u, method) => {
      if(!once && u.includes("/git/ref/heads/") && method === "GET"){ once = true; setMember(w, "a1", "g3_m2", { company:"別人剛改的" }); }
    };
    const r = await restore(w, sA1, rid);
    chk("(c) 第一輪 stale_base、第二輪救回,別人剛改的欄位保留", r.ok && idsOf(w, "a1")[1] === "g3_m9" &&
        groupOf(w, "a1").members.find(m => m.id === "g3_m2").company === "別人剛改的", brief(r));
  }
  {
    // 同一筆同時按兩次:只會有一張卡
    const { w, it } = setup();
    const rid = (await put(w, sOwner, [it])).rids[0];
    const [x, y] = await Promise.all([restore(w, sOwner, rid, { track:false }), restore(w, sA1, rid, { track:false })]);
    const errs = [x, y].filter(r => !r.ok).map(r => r.error);
    chk("(d) ★ 同一筆同時救兩次 → 一個成功、另一個 already_present/recycle_gone;名錄上只有一張卡",
        [x, y].filter(r => r.ok).length === 1 && errs.length === 1 && ["already_present", "recycle_gone"].includes(errs[0]) &&
        idsOf(w, "a1").filter(i => i === "g3_m9").length === 1 && recKeys(w).length === 0, brief(x) + " / " + brief(y));
  }
}

/* ══ 19 ══ ref PATCH 逾時 */
hr("⑲ 救回時 ref PATCH 丟例外(回應逾時)→ restore_uncertain;再按一次是安全的");
{
  const w = world();
  const it = itemFor(w, "a1", "g3_m9");
  removeMembers(w, "a1", ["g3_m9"]);
  const rid = (await put(w, sOwner, [it])).rids[0];
  w.gh.hooks.refPatchThrow = { once:true, move:false };
  const head0 = w.gh.head;
  const r = await restore(w, sOwner, rid);
  chk("★ 502 restore_uncertain(不說「沒有救回」),物件還在", r._status === 502 && r.error === "restore_uncertain" &&
      w.gh.head === head0 && eq(recKeys(w), [keyOf(rid)]), brief(r));
  const r2 = await restore(w, sOwner, rid);
  chk("其實沒寫進去 → 再按一次就救回", r2.ok && idsOf(w, "a1")[1] === "g3_m9", brief(r2));

  const w2 = world();
  const it2 = itemFor(w2, "a1", "g3_m9");
  removeMembers(w2, "a1", ["g3_m9"]);
  const rid2 = (await put(w2, sOwner, [it2])).rids[0];
  w2.gh.hooks.refPatchThrow = { once:true, move:true };
  const u = await restore(w2, sOwner, rid2);
  chk("ref 其實已經移動 → 仍然 restore_uncertain", u.error === "restore_uncertain" && idsOf(w2, "a1").includes("g3_m9"), brief(u));
  const head1 = w2.gh.head;
  const u2 = await restore(w2, sOwner, rid2);
  chk("★ 再按一次 → already_present,不重複寫入,物件清掉", u2.error === "already_present" && w2.gh.head === head1 &&
      recKeys(w2).length === 0 && idsOf(w2, "a1").filter(x => x === "g3_m9").length === 1, brief(u2));
  chk("子請求 ≤ 50", [r, r2, u, u2].every(x => x._cost <= 50), [r, r2, u, u2].map(x => x._cost).join("/"));
}

/* ══ 20 ══ 靜態上限的最壞情況:_index 與組檔都 > 1MB(各要多讀一次 blob) */
hr("⑳ 最壞情況:_index 與組檔都超過 1MB、組長、20 筆、救回時插隊 2 次");
{
  const bigIdx = IDX.map(e => e.id === "g12" ? Object.assign({}, e, { name:"大".repeat(400 * 1024) }) : e);
  const files = baseFiles();
  files["data/_index.json"] = JSON.stringify(bigIdx, null, 2) + "\n";
  files["data/a1.json"] = grpJson(A1_MEMBERS().map(m => m.id === "g3_m5" ? Object.assign(m, { business_items:"長".repeat(400 * 1024) }) : m));
  const w = world({ files });
  chk("測資:兩個檔都 > 1MB", Buffer.byteLength(files["data/_index.json"]) > 1048576 && Buffer.byteLength(files["data/a1.json"]) > 1048576);
  const items = Array.from({ length:20 }, (_, i) => Object.assign(itemFor(w, "a1", "g3_m9"), { index:i }));
  const p = await put(w, sA1, items);
  chk(`put 20 筆(組長)→ 子請求 ${p._cost} ≤ 22`, p.ok && p.stored === 20 && p._cost <= 22, brief(p));
  w.r2.metaPageSize = 4;                                   // 20 筆 = 正好 5 頁
  const l = await list(w, sA1);
  chk(`list(組長、5 頁)→ 子請求 ${l._cost} ≤ 7`, l.ok && l.items.length === 20 && !l.truncated && l._cost <= 7, brief(l));
  removeMembers(w, "a1", ["g3_m9"]);
  let n = 0;
  w.gh.hooks.before = async (u, method) => {
    if(u.includes("/git/refs/") && method === "PATCH" && n < 2){ n++; w.gh.pushFiles({ "data.js":"sync " + n }, "同步 bot"); }
  };
  const r = await restore(w, sA1, p.rids[3]);
  chk(`★ restore(組長、3 輪)→ 子請求 ${r._cost} ≤ 40`, r.ok && r._cost <= 40 && idsOf(w, "a1")[3] === "g3_m9", brief(r));
  w.gh.hooks.before = null;
  const w2 = world({ files });
  const it = itemFor(w2, "a1", "g3_m9");
  removeMembers(w2, "a1", ["g3_m9"]);
  const rid = (await put(w2, sOwner, [it])).rids[0];
  let k = 0;
  w2.gh.hooks.before = async (u, method) => {
    if(u.includes("/git/refs/") && method === "PATCH" && k < 2){ k++; w2.gh.pushFiles({ "data.js":"sync " + k }, "同步 bot"); }
  };
  const ro = await restore(w2, sOwner, rid);
  chk(`restore(總管理員、3 輪)→ 子請求 ${ro._cost} ≤ 34`, ro.ok && ro._cost <= 34, brief(ro));
}

/* ══ 預算總表 ══ 每支端點在整份測試裡的最壞子請求數(GitHub + R2 + KV) */
hr("★ 子請求預算(GitHub + R2 + KV,上限 50)");
{
  const caps = { "/recycle-put":22, "/recycle-list":7, "/recycle-restore":40, "/recycle-drop":1 };
  for(const [p, cap] of Object.entries(caps)){
    const got = maxCost[p];
    chk(`${p} 最壞 ${got} 個 ≤ ${cap}(≤ 50)`, typeof got === "number" && got <= cap && got <= 50);
  }
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
