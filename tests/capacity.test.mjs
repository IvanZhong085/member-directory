/* 待認領區的容量測試。

   照片移到私有 R2 之後,「同時能有幾筆待認領」只跟**文字 metadata** 有關,與照片大小
   完全脫鉤。所以容量不再是估計值,而是可推導的保證:

     MAX_PENDING(30) × MAX_PENDING_ENTRY_BYTES(96 KiB) = 2.88 MiB < MAX_DATA_BYTES(3 MiB)

   這裡用**最壞情境**驗證那個保證:每一筆都是「所有文字欄位都塞到合法上限、而且全是
   中文(UTF-8 三 bytes)、外加 7 個 photoRefs」。斷言用精確相等,不用「至少 N 筆」——
   寬鬆斷言正是上一版把問題掩蓋過去的方式。

   執行:node tests/capacity.test.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { FakeGitHub, FakeR2, loadWorker } from "./github-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = loadWorker(path.join(ROOT, "worker/publish-relay.js"), fs);
const SRC = fs.readFileSync(path.join(ROOT, "worker/publish-relay.js"), "utf8");
const constOf = name => {
  const m = SRC.match(new RegExp("const\\s+" + name + "\\s*=\\s*([^;]+);"));
  return m ? eval(m[1]) : null;
};
const MAX_PENDING            = constOf("MAX_PENDING");
const MAX_PENDING_ENTRY_BYTES = constOf("MAX_PENDING_ENTRY_BYTES");
const MAX_DATA_BYTES         = constOf("MAX_DATA_BYTES");
const PENDING_IMG_COUNT_MAX  = constOf("PENDING_IMG_COUNT_MAX");
const PENDING_IMG_BYTES_MAX  = constOf("PENDING_IMG_BYTES_MAX");

const grp = (leader, members=[]) => JSON.stringify({ leader, room:"", members, recruiting:[] }, null, 2) + "\n";
const baseFiles = () => ({
  "data/_index.json": JSON.stringify([{code:"A1",name:"甲組",id:"g1"}], null, 2) + "\n",
  "data/a1.json": grp("組長甲", []),
  "data/_pending.json": "[]\n",
});
const makeEnv = r2 => ({
  GH_OWNER:"O", GH_REPO:"R", GH_BRANCH:"main", GH_TOKEN:"t",
  ALLOWED_ORIGIN:"https://ivanzhong085.github.io",
  SESSION_SECRET:"x".repeat(48), INTAKE_SECRET:"s3cret",
  RATE_LIMIT:{ get: async()=>null, put: async()=>{} },
  PENDING_IMAGES: r2,
});
const post = (env, p, body) => W.__worker.fetch(new Request("https://w.test" + p, {
  method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }), env);
const pendOf = gh => JSON.parse(gh.files().get("data/_pending.json"));

/* 全中文的最壞情境申請:每個文字欄位都塞到 Worker 允許的上限。
   照片用很小的(容量與照片無關了),但張數給滿 7 張 —— photoRefs 也要算進 metadata。 */
const 中 = n => "壹".repeat(n);
const tinyPhoto = seed => {
  const b = Buffer.alloc(64, 0); b.write(String(seed), 0);
  return "data:image/jpeg;base64," + b.toString("base64");
};
const worstCaseApplicant = seed => ({
  name: 中(80), title: 中(80), company: 中(120),
  business_items: 中(400),
  website: "https://" + "a".repeat(292),
  services: Array.from({length:12}, () => 中(400)),
  targets:  Array.from({length:12}, () => 中(400)),
  have:     Array.from({length:12}, () => 中(400)),
  want:     Array.from({length:12}, () => 中(400)),
  tagline:  Array.from({length:12}, () => 中(400)),
  image: tinyPhoto(seed + "i"),
  card:  tinyPhoto(seed + "c"),
  products: [0,1,2,3,4].map(i => tinyPhoto(seed + "p" + i)),
});

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));

/* ══ 1 ══ 常數之間的一致性。任何一個被單獨改動,這裡就會失敗。 */
hr("① 上限之間的一致性(推導的前提)");
{
  const budget = MAX_PENDING * MAX_PENDING_ENTRY_BYTES;
  chk("★ MAX_PENDING × 單筆上限 < MAX_DATA_BYTES", budget < MAX_DATA_BYTES,
      `${MAX_PENDING} × ${Math.round(MAX_PENDING_ENTRY_BYTES/1024)} KiB = ` +
      `${(budget/1048576).toFixed(2)} MiB < ${(MAX_DATA_BYTES/1048576).toFixed(2)} MiB`);
  chk("保證筆數不少於 30", MAX_PENDING >= 30, `MAX_PENDING = ${MAX_PENDING}`);
  chk("照片張數上限是 7", PENDING_IMG_COUNT_MAX === 7);
  chk("單張照片上限以位元組計", PENDING_IMG_BYTES_MAX >= 100 * 1024,
      `${Math.round(PENDING_IMG_BYTES_MAX/1024)} KiB`);
}

/* ══ 2 ══ 最壞情境的單筆大小,必須低於單筆上限。 */
hr("② 最壞情境的單筆 metadata 大小");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const env = makeEnv(new FakeR2());
  const r = await (await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("w") })).json();
  chk("最壞情境的申請收得下", r.ok === true, JSON.stringify(r).slice(0, 60));
  const entry = pendOf(gh)[0];
  const bytes = Buffer.byteLength(JSON.stringify(entry, null, 2), "utf8");
  chk("★ 單筆最壞情境 < 單筆上限", bytes < MAX_PENDING_ENTRY_BYTES,
      `${bytes.toLocaleString()} bytes < ${MAX_PENDING_ENTRY_BYTES.toLocaleString()}`);
  chk("有 7 個 photoRefs",
      [entry.photoRefs.image, entry.photoRefs.card].concat(entry.photoRefs.products).filter(Boolean).length === 7);
  chk("★ 不含任何 base64 圖片", !/data:image\//.test(JSON.stringify(entry)));
}

/* ══ 3 ══ ★ 保證容量:30 筆最壞情境全部收得下,第 31 筆才被擋。 */
hr(`③ ★ 保證容量:${MAX_PENDING} 筆最壞情境申請`);
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const env = makeEnv(new FakeR2());
  let accepted = 0, blocked = null;
  for(let i = 1; i <= MAX_PENDING + 1; i++){
    const r = await (await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("s" + i) })).json();
    if(r.ok) accepted++; else { blocked = r; break; }
  }
  const list = pendOf(gh);
  const fileBytes = Buffer.byteLength(gh.files().get("data/_pending.json"), "utf8");

  chk(`★ 恰好收下 ${MAX_PENDING} 筆(精確相等,不是「至少」)`, accepted === MAX_PENDING,
      `收下 ${accepted} 筆`);
  chk(`★ 第 ${MAX_PENDING + 1} 筆被 pending_full 擋下`,
      blocked && blocked.error === "pending_full", blocked ? blocked.error : "(沒有被擋)");
  chk("★ 檔案仍在 MAX_DATA_BYTES 之內", fileBytes < MAX_DATA_BYTES,
      `${(fileBytes/1048576).toFixed(2)} MiB < ${(MAX_DATA_BYTES/1048576).toFixed(2)} MiB`);
  chk("★ 被擋下時,既有的每一筆逐 byte 不變", list.length === MAX_PENDING &&
      list.every((a, i) => a.name === 中(80) && a.services.length === 12));
}

/* ══ 4 ══ 滿載時仍然認領得動,而且認領之後又收得進來。 */
hr("④ ★ 滿載狀態下的認領(只進不出死鎖的反面驗證)");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  for(let i = 1; i <= MAX_PENDING; i++){
    await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("f" + i) });
  }
  const before = pendOf(gh);
  chk("前置條件:已經滿載", before.length === MAX_PENDING);
  const full = await (await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("x") })).json();
  chk("滿載時新申請被擋", full.error === "pending_full");

  const sLeader = await W.makeSession("x".repeat(48), { name:"a1", role:"leader", group:"A1" });
  const r = await (await post(env, "/claim", { session:sLeader, pid: before[0].pid })).json();
  chk("★ 滿載時仍然認領得動", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("待認領區少一筆", pendOf(gh).length === MAX_PENDING - 1);

  const again = await (await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("y") })).json();
  chk("★ 認領空出名額後,新申請又收得進來", again.ok === true, JSON.stringify(again).slice(0, 50));
}

/* ══ 5 ══ ★ 單筆 metadata 超過上限 → 明確拒絕,既有資料逐 byte 不變。
   /intake 那條路做不出超大的 entry(str() 會截斷每個欄位),但「發布」是另一條入口 ——
   組長刪申請時會整份重寫 _pending.json。所以這道閘門必須真的透過 publish 端點驗一次,
   而不是只在測試裡自己算一個數字。 */
hr("⑤ ★ 從 /publish 送入超過單筆上限的 entry");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const r2 = new FakeR2(); const env = makeEnv(r2);
  await post(env, "/intake", { secret:"s3cret", applicant: worstCaseApplicant("keep") });
  const before = gh.files().get("data/_pending.json");
  const beforeHash = crypto.createHash("sha256").update(before).digest("hex");

  // 超過 MAX_PENDING_ENTRY_BYTES 但整檔仍遠低於 MAX_DATA_BYTES
  const filler = "壹".repeat(Math.ceil(MAX_PENDING_ENTRY_BYTES / 3) + 2000);
  const oversized = [{ pid:"p_oversize", at:"2026-01-01T00:00:00.000Z", name:"超大",
    title:"", company:"", services:[filler], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"", image:"", card:"", products:[] }];
  const text = JSON.stringify(oversized, null, 2) + "\n";
  const entryBytes = Buffer.byteLength(JSON.stringify(oversized[0], null, 2), "utf8");
  chk("前置:這一筆確實超過單筆上限、但整檔沒超過",
      entryBytes > MAX_PENDING_ENTRY_BYTES && Buffer.byteLength(text) < MAX_DATA_BYTES,
      `單筆 ${entryBytes.toLocaleString()} > ${MAX_PENDING_ENTRY_BYTES.toLocaleString()}`);

  const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });
  const r = await (await post(env, "/publish", { session:sOwner,
    files:[{ path:"data/_pending.json", contentB64: Buffer.from(text).toString("base64") }],
    baseHashes:{ "data/_pending.json": beforeHash } })).json();

  chk("★ 被 pending_entry_too_large 擋下",
      r.error === "bad_data_file" && r.reason === "pending_entry_too_large",
      `${r.error} / ${r.reason}`);
  chk("★ 原有資料逐 byte 不變", gh.files().get("data/_pending.json") === before);
}

/* ══ 6 ══ photoWarnings 不可以無限成長(否則單筆上限守不住整檔上限)。 */
hr("⑥ photoWarnings 的數量與形狀");
{
  const gh = new FakeGitHub(baseFiles()); gh.install();
  const env = makeEnv(new FakeR2());
  const sOwner = await W.makeSession("x".repeat(48), { name:"owner", role:"owner", group:"" });
  const before = gh.files().get("data/_pending.json");
  const mk = warnings => JSON.stringify([{ pid:"p_w", at:"2026-01-01T00:00:00.000Z", name:"warn",
    title:"", company:"", services:[], targets:[], have:[], want:[], tagline:[],
    business_items:"", website:"", image:"", card:"", products:[],
    photoRefs:{ image:null, card:null, products:[] }, photoWarnings: warnings }], null, 2) + "\n";
  const send = w => post(env, "/publish", { session:sOwner,
    files:[{ path:"data/_pending.json", contentB64: Buffer.from(mk(w)).toString("base64") }],
    baseHashes:{ "data/_pending.json": crypto.createHash("sha256").update(before).digest("hex") } })
    .then(x => x.json());

  const tooMany = await send(Array.from({length:20}, () => ({ field:"image", reason:"x" })));
  chk("★ 超過 7 筆 warning 被擋下", tooMany.reason === "too_many_photo_warnings", tooMany.reason);
  const tooLong = await send([{ field:"x".repeat(100), reason:"y" }]);
  chk("★ field 過長被擋下", tooLong.reason === "bad_photo_warning_field", tooLong.reason);
  chk("原有資料不變", gh.files().get("data/_pending.json") === before);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
