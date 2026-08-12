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
import crypto2 from "node:crypto";
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

/* ══ 13 ══ ★ 子請求預算。Cloudflare Workers 免費方案:單次呼叫最多 50 個外部子請求。
   R2 是 binding、不計入,計入的是打 GitHub 的那些。7 張照片的認領一旦遇到 ref 競爭,
   外層會重試 —— 若每次重試都把 9 個 blob 重建一遍,兩次競爭就會越界(實測 58),
   而越界的表現是整個認領失敗、訊息卻是「連不到 GitHub」,極難查。
   這條測試把 blob 快取的效果釘住,不讓它日後被重構掉。 */
hr("⑬ ★ 子請求預算(7 張照片 + ref 競爭)");
{
  const grpOf = (l, m=[]) => JSON.stringify({ leader:l, room:"", members:m, recruiting:[] }, null, 2) + "\n";
  for(const races of [0, 1, 2]){
    const gh = new FakeGitHub(baseFiles()); gh.install();
    const r2 = new FakeR2(); const env = makeEnv(r2);
    await post(env, "/intake", { secret:"s3cret",
      applicant: Object.assign({ name:"預算測試", title:"t" }, sevenPhotos("q" + races)) });
    const pid = pendOf(gh)[0].pid;
    let n = 0;
    gh.install({ before: async (u, m) => {
      if(u.includes("/git/refs/") && m === "PATCH" && n < races){
        n++;
        const cur = gh.files(); const next = new Map(cur);
        next.set("data/a1.json", grpOf("別人改的", []));
        const t = gh.treeShaFor(next); gh.trees.set(t, next);
        gh.commits.set("cR" + races + n, { tree:t, parent:gh.head, message:"別人" });
        gh.head = "cR" + races + n;
      }
    }});
    gh.subrequests = 0;
    const r = await (await post(env, "/claim", { session:sLeader, pid })).json();
    chk(`★ ${races} 次 ref 競爭 → 子請求 ≤ 50`, gh.subrequests <= 50 && r.ok === true,
        `用了 ${gh.subrequests} 個(R2 呼叫 ${r2.calls.length} 次,不計入)`);
  }
}

/* ══ 14 ══ ★ claim 外層重試期間,別人改了同一個分組檔。
   先前的 bug:blob 快取以「路徑」判斷命中,重試時雖然重新讀了最新的分組檔、也重新組了
   files,ghCreateBlobs 卻因為路徑相同而跳過 —— 新內容配上舊 blob sha,於是 API 回報
   成功、寫進去的卻是舊資料,把競爭者剛完成的修改整個蓋掉。 */
hr("⑭ ★ 重試期間分組檔被別人改過(不得覆蓋競爭者)");
{
  const grpOf = (l, m=[]) => JSON.stringify({ leader:l, room:"", members:m, recruiting:[] }, null, 2) + "\n";
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"認領對象", title:"t" }, sevenPhotos("r")) });
  const pid = pendOf(gh)[0].pid;

  let raced = false;
  gh.install({ before: async (u, m) => {
    if(u.includes("/git/refs/") && m === "PATCH" && !raced){
      raced = true;
      const cur = gh.files(); const next = new Map(cur);
      next.set("data/a1.json", grpOf("組長甲", [{ id:"g1_m_other", name:"競爭者剛加的人" }]));
      const t = gh.treeShaFor(next); gh.trees.set(t, next);
      gh.commits.set("cRace", { tree:t, parent:gh.head, message:"競爭者" }); gh.head = "cRace";
    }
  }});
  const r = await (await post(env, "/claim", { session:sLeader, pid })).json();
  const a1 = JSON.parse(gh.files().get("data/a1.json"));
  const names = a1.members.map(m => m.name);
  chk("認領成功", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("★ 競爭者剛加的人沒有被蓋掉", names.indexOf("競爭者剛加的人") >= 0, names.join("、"));
  chk("★ 被認領的人也在", names.indexOf("認領對象") >= 0, names.join("、"));
}

/* ══ 15 ══ ★ 重試期間同一個 pid 的內容被改過 → 不可以混用快照。 */
hr("⑮ ★ 重試期間同一筆申請被改過(不得混用快照)");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"舊姓名", title:"t" }, sevenPhotos("s")) });
  const pid = pendOf(gh)[0].pid;
  const oldKeys = r2.keys().slice();

  let raced = false;
  gh.install({ before: async (u, m) => {
    if(u.includes("/git/refs/") && m === "PATCH" && !raced){
      raced = true;
      const list = JSON.parse(gh.files().get("data/_pending.json"));
      list[0].name = "新姓名";                       // 同一個 pid 的內容被改過
      const cur = gh.files(); const next = new Map(cur);
      next.set("data/_pending.json", JSON.stringify(list, null, 2) + "\n");
      const t = gh.treeShaFor(next); gh.trees.set(t, next);
      gh.commits.set("cEdit", { tree:t, parent:gh.head, message:"改申請" }); gh.head = "cEdit";
    }
  }});
  const r = await (await post(env, "/claim", { session:sLeader, pid })).json();
  const a1 = JSON.parse(gh.files().get("data/a1.json"));
  const mixed = a1.members.length > 0 && a1.members[0].name === "舊姓名";
  chk("★ 不得用舊快照建卡", !mixed, mixed ? "用了舊姓名建卡" : "沒有混用");
  chk("★ 明確回 pending_changed 或整批中止", r.ok !== true, r.error);
  chk("★ R2 照片沒有被刪掉(申請還在)", r2.keys().length === oldKeys.length,
      `${r2.keys().length}/${oldKeys.length}`);
  chk("待認領區保留該筆", pendOf(gh).some(a => a.pid === pid));
}

/* ══ 16 ══ 同一路徑但不同內容 → blob 快取必須 miss。 */
hr("⑯ blob 快取以內容而非路徑為 key");
{
  const grpOf = (l, m=[]) => JSON.stringify({ leader:l, room:"", members:m, recruiting:[] }, null, 2) + "\n";
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const enc = s => Buffer.from(s).toString("base64");
  const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });
  const h = c => crypto2.createHash("sha256").update(c).digest("hex");
  const first = gh.files().get("data/a1.json");
  await post(makeEnv(new FakeR2()), "/publish", { session:sOwner,
    files:[{ path:"data/a1.json", contentB64: enc(grpOf("第一版", [])) }],
    baseHashes:{ "data/a1.json": h(first) } });
  chk("第一次寫入生效", JSON.parse(gh.files().get("data/a1.json")).leader === "第一版");
  const second = gh.files().get("data/a1.json");
  await post(makeEnv(new FakeR2()), "/publish", { session:sOwner,
    files:[{ path:"data/a1.json", contentB64: enc(grpOf("第二版", [])) }],
    baseHashes:{ "data/a1.json": h(second) } });
  chk("★ 同一路徑的第二次寫入拿到新內容(沒有沿用舊 blob)",
      JSON.parse(gh.files().get("data/a1.json")).leader === "第二版",
      JSON.parse(gh.files().get("data/a1.json")).leader);
}

/* ══ 17 ══ ★ 兩個遷移同時執行:失敗方不得刪掉成功方引用的物件。
   先前 key 完全由 pid + 內容雜湊決定,兩個遷移算出**同一組 key**;先完成的 commit 成功、
   後者 stale_base 失敗並回滾,而它刪的正是那組共用 key —— 成功的 commit 指向一個已經
   不存在的物件。 */
hr("⑰ ★ 兩個 /migrate-pending 同時執行");
{
  const legacy = [{ pid:"p_mig1", at:"2026-01-01T00:00:00.000Z", name:"舊格式",
    title:"t", company:"c", services:[], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"", image: photoBytes(4000, "mig"), card:"", products:[] }];
  const files = baseFiles(); files["data/_pending.json"] = JSON.stringify(legacy, null, 2) + "\n";
  const gh = new FakeGitHub(files); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });

  const [r1, r2res] = await Promise.all([
    post(env, "/migrate-pending", { session:sOwner }).then(x => x.json()),
    post(env, "/migrate-pending", { session:sOwner }).then(x => x.json()),
  ]);
  const list = pendOf(gh);
  const refs = list[0] && list[0].photoRefs;
  const key = refs && refs.image && refs.image.key;

  chk("恰好一方成功", (r1.ok?1:0) + (r2res.ok?1:0) >= 1, `${r1.ok} / ${r2res.ok}`);
  chk("★ 待認領區已是新格式", !!key && !/data:image\//.test(gh.files().get("data/_pending.json")));
  chk("★ 成功 commit 引用的物件仍然存在於 R2", r2.objects.has(key),
      `key=${String(key).slice(0, 50)} 存在=${r2.objects.has(key)}`);
}

/* ══ 18 ══ ★ R2 讀取故障 ≠ 缺圖,而且不可被 allowMissingImages 覆寫。 */
hr("⑱ ★ R2 讀取故障(不是缺圖)");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant:{ name:"讀取會失敗", title:"t", image: photoBytes(5000, "err") } });
  const pid = pendOf(gh)[0].pid;
  r2.fail = { op:"get" };                        // 持續丟錯(服務故障,不是物件不存在)

  const first = await (await post(env, "/claim", { session:sLeader, pid })).json();
  chk("★ 回 pending_image_store_failed 而不是 missing",
      first.error === "pending_image_store_failed", first.error);
  const forced = await (await post(env, "/claim", { session:sLeader, pid, allowMissingImages:true })).json();
  chk("★ allowMissingImages 也不能覆寫服務故障",
      forced.error === "pending_image_store_failed", forced.error);
  chk("★ R2 物件沒有被刪掉", r2.objects.size === 1, r2.objects.size + " 個");
  chk("待認領區保留該筆", pendOf(gh).length === 1);
}

/* ══ 19 ══ ★ 舊格式的大圖(歷史上合法)必須能遷移、能認領,不可靜默變空。 */
hr("⑲ ★ 舊格式大圖的相容");
{
  const big = photoBytes(300 * 1024, "old-big");     // 300 KiB:舊規則合法、超過新的 200 KiB
  const legacy = [{ pid:"p_big1", at:"2026-01-01T00:00:00.000Z", name:"舊格式大圖",
    title:"t", company:"c", services:[], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"", image: big, card:"", products:[] }];
  {
    const files = baseFiles(); files["data/_pending.json"] = JSON.stringify(legacy, null, 2) + "\n";
    const gh = new FakeGitHub(files); gh.install();
    const r2 = new FakeR2(); const env = makeEnv(r2);
    const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });
    const r = await (await post(env, "/migrate-pending", { session:sOwner })).json();
    chk("★ 舊格式大圖可以遷移", r.ok === true && r.migrated === 1, JSON.stringify(r).slice(0, 60));
  }
  {
    const files = baseFiles(); files["data/_pending.json"] = JSON.stringify(legacy, null, 2) + "\n";
    const gh = new FakeGitHub(files); gh.install();
    const r2 = new FakeR2(); const env = makeEnv(r2);
    const r = await (await post(env, "/claim", { session:sLeader, pid:"p_big1" })).json();
    const m = JSON.parse(gh.files().get("data/a1.json")).members[0];
    chk("★ 舊格式大圖可以直接認領", r.ok === true, JSON.stringify(r).slice(0, 60));
    chk("★ 照片沒有靜默變成空的", !!(m && m.image) && gh.files().has("images/" + m.image),
        m ? m.image : "(沒有成員)");
  }
}

/* ══ 20 ══ ★ /publish 不能把 base64 連同 photoRefs 一起寫回公開 repo。 */
hr("⑳ ★ 從 publish 端點塞回 data URL");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const env = makeEnv(new FakeR2());
  const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });
  const before = gh.files().get("data/_pending.json");
  const evil = [{ pid:"p_evil", at:"2026-01-01T00:00:00.000Z", name:"塞回去",
    title:"", company:"", services:[], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"",
    image: photoBytes(3000, "back"), card:"", products:[],
    photoRefs:{ image:null, card:null, products:[] } }];
  const r = await (await post(env, "/publish", { session:sOwner,
    files:[{ path:"data/_pending.json", contentB64: Buffer.from(JSON.stringify(evil, null, 2) + "\n").toString("base64") }],
    baseHashes:{ "data/_pending.json": crypto.createHash("sha256").update(before).digest("hex") } })).json();
  chk("★ 被 photo_ref_with_inline_image 擋下",
      r.error === "bad_data_file" && r.reason === "photo_ref_with_inline_image", `${r.error}/${r.reason}`);
  chk("★ 公開檔案裡沒有出現 base64", !/data:image\//.test(gh.files().get("data/_pending.json")));
}

/* ══ 21 ══ 刪除申請要一併清掉 R2,而且是在 commit 成功之後。 */
hr("㉑ /drop-pending 的清理");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"要被刪掉的", title:"t" }, sevenPhotos("d2")) });
  const pid = pendOf(gh)[0].pid;
  chk("前置:R2 有 7 個物件", r2.keys().length === 7);
  const r = await (await post(env, "/drop-pending", { session:sLeader, pid })).json();
  chk("刪除成功", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("★ 待認領區已移除", pendOf(gh).length === 0);
  chk("★ R2 物件一併清掉(不再是孤兒)", r2.keys().length === 0, r2.keys().length + " 個殘留");

  // Git 失敗時不可以先刪 R2
  await post(env, "/intake", { secret:"s3cret",
    applicant: Object.assign({ name:"刪除會失敗", title:"t" }, sevenPhotos("d3")) });
  const pid2 = pendOf(gh)[0].pid;
  gh.install({ before: async (u, m) => {
    if(u.includes("/git/refs/") && m === "PATCH") throw new Error("ref 失敗");
  }});
  const bad = await (await post(env, "/drop-pending", { session:sLeader, pid:pid2 })).json();
  chk("★ Git 失敗時申請與照片都保留", bad.ok !== true && pendOf(gh).length === 1 && r2.keys().length === 7,
      `pending=${pendOf(gh).length} r2=${r2.keys().length}`);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
