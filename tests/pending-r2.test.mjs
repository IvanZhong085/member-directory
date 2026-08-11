/* 待認領照片改存私有 R2 之後的行為測試。

   要守住的不變式:
     ・data/_pending.json 永遠不含 base64 圖片(它在公開 repo)
     ・7 張合法照片都保得住,不會因為總額預算而靜默消失
     ・任何失敗都不會出現「表單顯示成功,但資料或照片悄悄不見」
     ・認領成功之後才刪 R2;crash 在 commit 之前,pending 與 R2 都保留

   執行:node tests/pending-r2.test.mjs */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FakeGitHub, FakeR2, loadWorker } from "./github-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = loadWorker(path.join(ROOT, "worker/publish-relay.js"), fs);

const grp = (leader, members=[]) => JSON.stringify({ leader, room:"", members, recruiting:[] }, null, 2) + "\n";
const baseFiles = () => ({
  "data/_index.json": JSON.stringify([{code:"A1",name:"甲組",id:"g1"}], null, 2) + "\n",
  "data/a1.json": grp("組長甲", []),
  "data/_pending.json": "[]\n",
});
function makeEnv(r2){
  return {
    GH_OWNER:"O", GH_REPO:"R", GH_BRANCH:"main", GH_TOKEN:"t",
    ALLOWED_ORIGIN:"https://ivanzhong085.github.io",
    SESSION_SECRET:"x".repeat(48), INTAKE_SECRET:"s3cret",
    RATE_LIMIT:{ get: async()=>null, put: async()=>{} },
    PENDING_IMAGES: r2 || undefined,
  };
}
/* 產生一張指定 byte 數的「照片」。內容不同 → 雜湊不同 → key 不同。 */
function photoBytes(bytes, seed){
  const b = Buffer.alloc(bytes, 0);
  b.write(String(seed), 0);
  return "data:image/jpeg;base64," + b.toString("base64");
}
const MAX_ONE = 200 * 1024;                 // 與 Worker 的 PENDING_IMG_BYTES_MAX 一致
const post = (env, p, body) => W.__worker.fetch(new Request("https://w.test" + p, {
  method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }), env);
const sevenPhotos = seed => ({
  image: photoBytes(MAX_ONE, seed + "i"),
  card:  photoBytes(MAX_ONE, seed + "c"),
  products: [0,1,2,3,4].map(i => photoBytes(MAX_ONE, seed + "p" + i)),
});
const pendOf = gh => JSON.parse(gh.files().get("data/_pending.json"));

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));

const sLeader = await W.makeSession("x".repeat(48), { name:"a1", role:"leader", group:"A1" });
const sLeaderB = await W.makeSession("x".repeat(48), { name:"b1", role:"leader", group:"B1" });

/* ══ 1・2・3 ══ 7 張最大合法照片全部保住,而且一個 byte 都沒進公開 repo。 */
hr("① 7 張各達合法最大值的照片");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  const r = await (await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"七張照片的人", title:"t", company:"c" }, sevenPhotos("a")) })).json();
  const raw = gh.files().get("data/_pending.json");
  const a = pendOf(gh)[0];

  chk("★ 7 張全部收下,沒有因為總額而消失", r.ok === true && r.photos === 7,
      `ok=${r.ok} photos=${r.photos}`);
  chk("★ _pending.json 完全不含 base64 圖片", !/data:image\//.test(raw) && raw.length < 8000,
      `檔案 ${raw.length} bytes`);
  chk("★ R2 裡有 7 個物件", r2.keys().length === 7, r2.keys().length + " 個");
  chk("photoRefs 的 key 都在自己的前綴底下",
      [a.photoRefs.image, a.photoRefs.card].concat(a.photoRefs.products)
        .every(x => x.key.startsWith("pending/" + a.pid + "/")));
  chk("metadata 的 bytes 是解碼後的真實長度",
      a.photoRefs.image.bytes === MAX_ONE, a.photoRefs.image.bytes);
  chk("metadata 的 sha256 與 R2 內容相符", (() => {
      const bytes = r2.objects.get(a.photoRefs.image.key);
      return crypto.createHash("sha256").update(bytes).digest("hex") === a.photoRefs.image.sha256;
    })());
  chk("mime 被保留", a.photoRefs.image.mime === "image/jpeg");
  chk("舊欄位留空,不放 data URL", a.image === "" && a.card === "" && a.products.length === 0);
}

/* ══ 4 ══ 單張超限 / base64 壞掉 → 整筆失敗,pending 不增加,R2 無殘留。 */
hr("② 照片不合法時整筆退回(不再靜默丟掉)");
for(const [label, bad] of [
  ["單張超過上限", { image: photoBytes(MAX_ONE + 1, "big") }],
  ["base64 內容壞掉", { image: "data:image/jpeg;base64,!!!!not-base64!!!!" }],
  ["mime 不被接受",   { image: "data:image/gif;base64,AAAA" }],
]){
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  const r = await (await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"測試", title:"t" }, bad) })).json();
  const ok = r.ok !== true && pendOf(gh).length === 0 && r2.keys().length === 0;
  chk("★ " + label + " → 整筆失敗、pending 不增、R2 無殘留", ok,
      `${r.error || "(沒有錯誤)"} / pending=${pendOf(gh).length} / r2=${r2.keys().length}`);
}

/* ══ 5 ══ R2 第 N 張上傳失敗 → 前 N-1 張被清掉,pending 不增加。 */
hr("③ R2 上傳到一半失敗");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); r2.fail = { op:"put", nth:4 };      // 第 4 張失敗
  const env = makeEnv(r2);
  const r = await (await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"上傳中斷", title:"t" }, sevenPhotos("b")) })).json();
  chk("回報失敗(不是成功)", r.ok !== true, r.error);
  chk("★ 前面已上傳的都被清掉", r2.keys().length === 0, r2.keys().length + " 個殘留");
  chk("pending 沒有增加", pendOf(gh).length === 0);
}

/* ══ 6 ══ R2 成功但 GitHub 寫入失敗 → 不回報成功,R2 被清理。 */
hr("④ R2 成功但 GitHub 寫入失敗");
{
  const gh = new FakeGitHub(baseFiles());
  gh.install({ before: async (u, method) => {
    if(u.includes("_pending.json") && method === "PUT") throw new Error("GitHub 掛了");
  }});
  const r2 = new FakeR2(); const env = makeEnv(r2);
  const r = await (await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"GitHub 失敗", title:"t" }, sevenPhotos("c")) })).json();
  chk("回報失敗(不是成功)", r.ok !== true, r.error);
  chk("★ R2 物件已被清理,不留孤兒", r2.keys().length === 0, r2.keys().length + " 個殘留");
  chk("pending 沒有增加", pendOf(gh).length === 0);
}

/* ══ 7 ══ 沒有 R2 binding → fail-closed,不退回 base64。 */
hr("⑤ 沒有 PENDING_IMAGES binding");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const env = makeEnv(null);
  const r = await (await post(env, "/intake", { secret:"s3cret",
    applicant: { name:"沒有 R2", title:"t", image: photoBytes(1000, "x") } })).json();
  chk("★ 回 pending_image_store_unavailable(503)", r.error === "pending_image_store_unavailable", r.error);
  chk("★ 沒有退回把照片寫進 _pending.json", pendOf(gh).length === 0 &&
      !/data:image\//.test(gh.files().get("data/_pending.json")));
}

/* ══ 8 ══ 認領成功:同一個 commit 建圖片、更新分組、移除 pending;之後才清 R2。 */
hr("⑥ 認領成功的完整流程");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"待認領的人", title:"t" }, sevenPhotos("d")) });
  const pid = pendOf(gh)[0].pid;
  const headBefore = gh.head;

  const r = await (await post(env, "/claim", { session:sLeader, pid })).json();
  const files = gh.files();
  const a1 = JSON.parse(files.get("data/a1.json"));
  const commits = [];
  for(let c = gh.head; c && c !== headBefore; c = gh.commits.get(c).parent) commits.push(c);

  chk("認領成功", r.ok === true, JSON.stringify(r).slice(0, 70));
  chk("★ 只產生一個 commit", commits.length === 1, commits.length + " 個");
  chk("★ 7 張照片都寫進 images/", a1.members[0].products.length === 5 &&
      a1.members[0].image && a1.members[0].card,
      `image=${!!a1.members[0].image} card=${!!a1.members[0].card} products=${a1.members[0].products.length}`);
  chk("圖片檔實際存在於同一個 commit",
      [a1.members[0].image, a1.members[0].card].concat(a1.members[0].products)
        .every(n => files.has("images/" + n)));
  chk("待認領區已移除該筆", pendOf(gh).length === 0);
  chk("★ R2 在 commit 成功之後才被清空", r2.keys().length === 0);
  chk("成員卡帶 claimedFrom", a1.members[0].claimedFrom === pid);
}

/* ══ 9 ══ Git 失敗 → pending 與 R2 都保留,可安全重試。 */
hr("⑦ 認領時 Git 更新失敗");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"認領會失敗", title:"t" }, sevenPhotos("e")) });
  const pid = pendOf(gh)[0].pid;
  const keysBefore = r2.keys().length;
  gh.install({ before: async (u, method) => {
    if(u.includes("/git/refs/") && method === "PATCH") throw new Error("ref 更新失敗");
  }});
  const r = await (await post(env, "/claim", { session:sLeader, pid })).json();
  chk("回報失敗", r.ok !== true, r.error);
  chk("★ pending 記錄保留", pendOf(gh).length === 1);
  chk("★ R2 物件保留(沒有被提前刪掉)", r2.keys().length === keysBefore, `${r2.keys().length}/${keysBefore}`);
}

/* ══ 10 ══ 兩位組長同時認領 → 恰好一位成功,失敗方不得刪 R2。 */
hr("⑧ 兩位組長同時認領同一筆");
{
  const files = baseFiles();
  files["data/_index.json"] = JSON.stringify([{code:"A1",name:"甲",id:"g1"},{code:"B1",name:"乙",id:"g2"}], null, 2) + "\n";
  files["data/b1.json"] = grp("組長乙", []);
  const gh = new FakeGitHub(files); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"搶手的人", title:"t" }, sevenPhotos("f")) });
  const pid = pendOf(gh)[0].pid;

  let reads = 0, release; const gate = new Promise(res => release = res);
  gh.install({ before: async (u, method) => {
    if(u.includes("_pending.json") && method === "GET" && ++reads >= 2) release();
    if(u.includes("/git/refs/") && method === "PATCH") await gate;
  }});
  const [rA, rB] = await Promise.all([
    post(env, "/claim", { session:sLeader,  pid }).then(x => x.json()),
    post(env, "/claim", { session:sLeaderB, pid }).then(x => x.json()),
  ]);
  const a1 = JSON.parse(gh.files().get("data/a1.json"));
  const b1 = JSON.parse(gh.files().get("data/b1.json"));
  chk("恰好一位成功", (rA.ok?1:0) + (rB.ok?1:0) === 1, `A=${!!rA.ok} B=${!!rB.ok}`);
  chk("沒有重複成員卡", !(a1.members.length && b1.members.length));
  chk("★ 成功方清空 R2、失敗方沒有提前刪", r2.keys().length === 0);
}

/* ══ 11 ══ R2 物件缺失或雜湊不符 → 預設擋下,pending 保留。 */
hr("⑨ R2 物件缺失 / 內容被竄改");
{
  for(const mode of ["missing", "corrupt"]){
    const gh = new FakeGitHub(baseFiles()); gh.install();
    const r2 = new FakeR2(); const env = makeEnv(r2);
    await post(env, "/intake", { secret:"s3cret",
      applicant: { name:"照片有問題", title:"t", image: photoBytes(5000, "g") } });
    const a = pendOf(gh)[0];
    if(mode === "missing") r2.objects.delete(a.photoRefs.image.key);
    else r2.corrupt(a.photoRefs.image.key, Buffer.alloc(5000, 7));

    const r = await (await post(env, "/claim", { session:sLeader, pid:a.pid })).json();
    const expect = mode === "missing" ? "pending_image_missing" : "pending_image_corrupt";
    chk(`★ ${mode} → 回 ${expect} 並擋下`, r.error === expect, r.error);
    chk("pending 保留,沒有建出缺圖成員", pendOf(gh).length === 1 &&
        JSON.parse(gh.files().get("data/a1.json")).members.length === 0);
  }
}

/* ══ 12 ══ allowMissingImages 必須是明確參數,而且會留下 warning。 */
hr("⑩ 明知缺圖仍要認領");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: { name:"缺圖也要認領", title:"t", image: photoBytes(5000, "h") } });
  const a = pendOf(gh)[0];
  r2.objects.delete(a.photoRefs.image.key);

  const blocked = await (await post(env, "/claim", { session:sLeader, pid:a.pid })).json();
  chk("★ 預設擋下(不是預設放行)", blocked.error === "pending_image_missing");

  const r = await (await post(env, "/claim", { session:sLeader, pid:a.pid, allowMissingImages:true })).json();
  const m = JSON.parse(gh.files().get("data/a1.json")).members[0];
  chk("★ 明確送 allowMissingImages 才會成功", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("★ 結果留下可見的 warning", Array.isArray(r.warnings) && r.warnings.length > 0 &&
      Array.isArray(m.photoNotes) && m.photoNotes.length > 0, JSON.stringify(r.warnings));
}

/* ══ 13 ══ 舊 data URL 格式仍可認領(部署前收到的申請不能被卡死)。 */
hr("⑪ 舊格式(data URL)的申請仍可認領");
{
  const files = baseFiles();
  files["data/_pending.json"] = JSON.stringify([{
    pid:"p_legacy1", at:"2026-01-01T00:00:00.000Z", name:"舊格式的人",
    title:"t", company:"c", services:[], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"",
    image: photoBytes(3000, "old"), card:"", products:[],
  }], null, 2) + "\n";
  const gh = new FakeGitHub(files); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  const r = await (await post(env, "/claim", { session:sLeader, pid:"p_legacy1" })).json();
  const a1 = JSON.parse(gh.files().get("data/a1.json"));
  chk("★ 舊格式仍然認領得動", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("照片有被寫成 images/ 實體檔", !!a1.members[0].image && gh.files().has("images/" + a1.members[0].image));
  chk("待認領區已清空", pendOf(gh).length === 0);
}

/* ══ 17 ══ key 路徑穿越、跨 pid 引用、錯誤 bytes/hash 全部被拒。 */
hr("⑫ 被動過手腳的 photoRefs");
{
  const evil = [
    ["路徑穿越",   "pending/p_a/../../secret.jpg"],
    ["跨 pid 引用", "pending/p_other/image-x.jpg"],
    ["完全不同前綴", "images/g1_m1_x.jpg"],
  ];
  for(const [label, key] of evil){
    const files = baseFiles();
    files["data/_pending.json"] = JSON.stringify([{
      pid:"p_a", at:"2026-01-01T00:00:00.000Z", name:"惡意", title:"", company:"",
      services:[], targets:[], have:[], want:[], tagline:[], business_items:"", website:"",
      image:"", card:"", products:[],
      photoRefs:{ image:{ key, mime:"image/jpeg", bytes:100, sha256:"a".repeat(64) }, card:null, products:[] },
    }], null, 2) + "\n";
    const gh = new FakeGitHub(files); gh.install();
    const r2 = new FakeR2(); const env = makeEnv(r2);
    const r = await (await post(env, "/claim", { session:sLeader, pid:"p_a" })).json();
    chk("★ " + label + " → 被擋下", r.ok !== true && r.error === "pending_image_forbidden", r.error);
  }
  // 錯誤的 bytes / hash 也要被擋(內容正確但 metadata 不符)
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant:{ name:"改 metadata", title:"t", image: photoBytes(4000, "z") } });
  const list = pendOf(gh);
  list[0].photoRefs.image.bytes = 999;
  const f = gh.files();
  f.set("data/_pending.json", JSON.stringify(list, null, 2) + "\n");
  const r = await (await post(env, "/claim", { session:sLeader, pid:list[0].pid })).json();
  chk("★ bytes 對不上 → pending_image_corrupt", r.error === "pending_image_corrupt", r.error);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
