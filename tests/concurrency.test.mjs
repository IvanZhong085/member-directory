/* 多位管理者同時操作的回歸測試。
   用**真實的 worker/publish-relay.js**,只把 GitHub 換成 tests/github-model.mjs。
   每一個情境都對應一個實際發生過或被審查指出的缺陷 —— 加新情境時請一併寫清楚
   「這一條在修復前會怎麼壞」,否則日後重構時沒有人知道它為什麼存在。

   執行:node tests/concurrency.test.mjs */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FakeGitHub, loadWorker } from "./github-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = loadWorker(path.join(ROOT, "worker/publish-relay.js"), fs);
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

const ENV = {
  GH_OWNER:"O", GH_REPO:"R", GH_BRANCH:"main", GH_TOKEN:"t",
  ALLOWED_ORIGIN:"https://ivanzhong085.github.io",
  SESSION_SECRET:"x".repeat(48), INTAKE_SECRET:"s3cret",
  RATE_LIMIT:{ get: async()=>null, put: async()=>{} },
};
const grp = (leader, members=[]) => JSON.stringify({ leader, room:"", members, recruiting:[] }, null, 2) + "\n";
const idx = entries => JSON.stringify(entries, null, 2) + "\n";
const enc = s => Buffer.from(s).toString("base64");
const base = () => ({
  "data/_index.json": idx([{code:"A1",name:"甲組",id:"g1"},{code:"B1",name:"乙組",id:"g2"}]),
  "data/a1.json": grp("組長甲", []),
  "data/b1.json": grp("組長乙", []),
  "data/_pending.json": JSON.stringify([{ pid:"p_x1", name:"新夥伴小明" }], null, 2) + "\n",
});

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
const post = (p, body) => W.__worker.fetch(new Request("https://w.test" + p, {
  method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }), ENV);

const sLeaderA = await W.makeSession(ENV.SESSION_SECRET, { name:"a1", role:"leader", group:"A1" });
const sLeaderB = await W.makeSession(ENV.SESSION_SECRET, { name:"b1", role:"leader", group:"B1" });
const sOwner   = await W.makeSession(ENV.SESSION_SECRET, { name:"owner", role:"owner", group:"" });

/* ══ 1 ══ 兩位組長真正同時認領同一位新夥伴。
   修復前:兩邊都通過版本檢查,各自寫成功自己那組的成員卡 → 同一人變成兩組成員,
   而後者收到的訊息是「這次沒有上線」。 */
hr("① 兩位組長【真正同時】認領同一位新夥伴");
{
  const gh = new FakeGitHub(base());
  let reads = 0, release; const gate = new Promise(r => release = r);
  gh.install({ before: async (u, method) => {
    if(u.includes("_pending.json") && method === "GET" && ++reads >= 2) release();
    if(u.includes("/git/refs/") && method === "PATCH") await gate;
  }});
  const [rA, rB] = await Promise.all([
    post("/claim", { session:sLeaderA, pid:"p_x1" }).then(r => r.json()),
    post("/claim", { session:sLeaderB, pid:"p_x1" }).then(r => r.json()),
  ]);
  const a1 = JSON.parse(gh.files().get("data/a1.json"));
  const b1 = JSON.parse(gh.files().get("data/b1.json"));
  chk("恰好一方成功", (rA.ok?1:0) + (rB.ok?1:0) === 1, `A1=${!!rA.ok} B1=${!!rB.ok}`);
  chk("沒有重複成員卡", !(a1.members.length && b1.members.length),
      `a1=${a1.members.length} b1=${b1.members.length}`);
  chk("失敗方收到 already_claimed", (rA.ok ? rB : rA).error === "already_claimed");
  chk("成員卡帶 claimedFrom", (a1.members[0] || b1.members[0]).claimedFrom === "p_x1");
  chk("待認領區已清空", JSON.parse(gh.files().get("data/_pending.json")).length === 0);
}

/* ══ 2 ══ ★ 二次審查指出的 P0:改名與認領使用不同快照。
   修復前:groupInternalId() 讀移動中的 main、commit 卻建在改名後的 head 上,
   於是「總管理員改名成功」與「組長認領成功」同時發生,成員卡落在孤兒 a1.json,
   而申請已經從待認領區消失 —— 一筆申請憑空蒸發。 */
hr("② ★ 認領通過代號檢查之後,總管理員才完成改名(P0 交錯)");
{
  const gh = new FakeGitHub(base());
  let renamed = false;
  gh.install({ before: async (u, method) => {
    // 在 /claim 讀完 _index(代號檢查)之後、真正更新 ref 之前,讓改名先落地
    if(!renamed && u.includes("_pending.json") && method === "GET"){
      renamed = true;
      const cur = gh.files();
      const next = new Map(cur);
      next.set("data/_index.json", idx([{code:"Z9",name:"甲組",id:"g1"},{code:"B1",name:"乙組",id:"g2"}]));
      next.set("data/z9.json", cur.get("data/a1.json"));
      next.delete("data/a1.json");
      const t = gh.treeShaFor(next); gh.trees.set(t, next);
      const c = "cRename"; gh.commits.set(c, { tree:t, parent:gh.head, message:"改名" });
      gh.head = c;
    }
  }});
  const r = await (await post("/claim", { session:sLeaderA, pid:"p_x1" })).json();
  const files = gh.files();
  const orphan = files.has("data/a1.json") ? JSON.parse(files.get("data/a1.json")) : null;
  const pend = JSON.parse(files.get("data/_pending.json"));
  chk("★ 認領被擋下(不是兩邊都成功)", r.ok !== true, JSON.stringify(r).slice(0, 60));
  chk("★ 沒有寫進孤兒檔", !orphan || orphan.members.length === 0);
  chk("★ 申請仍留在待認領區(沒有蒸發)", pend.some(p => p.pid === "p_x1"), `剩 ${pend.length} 筆`);
}

/* ══ 3 ══ 改名交易:新檔、_index、刪除舊檔必須在同一個 commit。 */
hr("③ 改名:同一個 commit 內建新檔、更新 index、刪除舊檔");
{
  const gh = new FakeGitHub(base()); gh.install();
  const before = gh.files().get("data/a1.json");
  const r = await (await post("/publish", { session:sOwner,
    files:[
      { path:"data/z9.json", contentB64: enc(before) },
      { path:"data/_index.json", contentB64: enc(idx([{code:"Z9",name:"甲組",id:"g1"},{code:"B1",name:"乙組",id:"g2"}])) },
    ],
    remove:["data/a1.json"],
    baseHashes:{ "data/_index.json": sha256(gh.files().get("data/_index.json")), "data/a1.json": sha256(before) },
  })).json();
  const f = gh.files();
  chk("改名成功", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("新檔存在", f.has("data/z9.json"));
  chk("★ 舊檔已刪除(不再是孤兒)", !f.has("data/a1.json"));
  chk("只產生一個 commit", gh.commits.get(gh.head).parent === "c0");
}

/* ══ 4 ══ 刪除也要版本檢查:來源檔在改名前被別人更新過就不可以直接刪。 */
hr("④ 改名時來源檔已被別人更新(刪除的版本檢查)");
{
  const gh = new FakeGitHub(base()); gh.install();
  const staleHash = sha256(gh.files().get("data/a1.json"));
  // 組長先更新了 a1
  const cur = gh.files(); const next = new Map(cur);
  next.set("data/a1.json", grp("組長甲", [{ id:"g1_m1", name:"組長剛加的人" }]));
  const t = gh.treeShaFor(next); gh.trees.set(t, next);
  gh.commits.set("cEdit", { tree:t, parent:gh.head, message:"組長更新" }); gh.head = "cEdit";

  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/z9.json", contentB64: enc(grp("組長甲", [])) },
           { path:"data/_index.json", contentB64: enc(idx([{code:"Z9",name:"甲組",id:"g1"},{code:"B1",name:"乙組",id:"g2"}])) }],
    remove:["data/a1.json"],
    baseHashes:{ "data/_index.json": sha256(gh.files().get("data/_index.json")), "data/a1.json": staleHash },
  })).json();
  chk("★ 被 stale_base 擋下,不會丟掉組長剛加的人", r.error === "stale_base", JSON.stringify(r).slice(0, 70));
  chk("組長的修改還在", JSON.parse(gh.files().get("data/a1.json")).members.length === 1);
}

/* ══ 5 ══ _index 參照完整性:列出的代號一定要有對應的分組檔。
   修復前:單一原子 commit 也能建出永久壞狀態,之後 build-data.mjs 每次都失敗。 */
hr("⑤ _index 列出沒有對應檔案的代號");
{
  const gh = new FakeGitHub(base()); gh.install();
  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/_index.json",
             contentB64: enc(idx([{code:"A1",name:"甲",id:"g1"},{code:"B1",name:"乙",id:"g2"},{code:"XX",name:"沒有檔案",id:"g9"}])) }],
    baseHashes:{ "data/_index.json": sha256(gh.files().get("data/_index.json")) },
  })).json();
  chk("★ 被 index_missing_group 擋下", r.error === "index_missing_group", JSON.stringify(r).slice(0, 70));
  chk("repo 沒有被寫入", gh.head === "c0");
}

/* ══ 6 ══ 刪除仍被 _index 引用的分組檔。 */
hr("⑥ 刪除一個仍被 _index 引用的分組檔");
{
  const gh = new FakeGitHub(base()); gh.install();
  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/b1.json", contentB64: enc(grp("組長乙", [])) }],
    remove:["data/a1.json"],
    baseHashes:{ "data/b1.json": sha256(gh.files().get("data/b1.json")),
                 "data/a1.json": sha256(gh.files().get("data/a1.json")) },
  })).json();
  chk("★ 被擋下(_index 仍列著 A1)", r.error === "index_missing_group", JSON.stringify(r).slice(0, 70));
}

/* ══ 7 ══ 沒有版本基準的刪除 = 盲刪,一律拒絕。 */
hr("⑦ 沒有帶 baseHash 的刪除");
{
  const gh = new FakeGitHub(base()); gh.install();
  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/_index.json", contentB64: enc(idx([{code:"B1",name:"乙組",id:"g2"}])) }],
    remove:["data/a1.json"],
    baseHashes:{ "data/_index.json": sha256(gh.files().get("data/_index.json")) },
  })).json();
  chk("★ 被 remove_without_base 擋下", r.error === "remove_without_base", JSON.stringify(r).slice(0, 70));
}

/* ══ 8 ══ 有版本基準、但檔案已被別人刪掉 → 不可以默默重建。 */
hr("⑧ 要寫的檔案在這期間被別人刪掉了");
{
  const gh = new FakeGitHub(base()); gh.install();
  const h = sha256(gh.files().get("data/a1.json"));
  const cur = gh.files(); const next = new Map(cur); next.delete("data/a1.json");
  next.set("data/_index.json", idx([{code:"B1",name:"乙組",id:"g2"}]));
  const t = gh.treeShaFor(next); gh.trees.set(t, next);
  gh.commits.set("cDel", { tree:t, parent:gh.head, message:"刪組" }); gh.head = "cDel";

  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/a1.json", contentB64: enc(grp("復活", [])) }],
    baseHashes:{ "data/a1.json": h },
  })).json();
  chk("★ 回 stale_base / file_deleted,不是默默重建", r.error === "stale_base" && r.reason === "file_deleted",
      JSON.stringify(r).slice(0, 70));
}

/* ══ 9 ══ 多檔發布的原子性:中途被搶就整批中止。 */
hr("⑨ 多檔發布,版本檢查通過後被別人搶先");
{
  const gh = new FakeGitHub(base());
  let injected = false;
  gh.install({ before: async (u, method) => {
    if(u.includes("/git/refs/") && method === "PATCH" && !injected){
      injected = true;
      const cur = gh.files(); const next = new Map(cur);
      next.set("data/b1.json", grp("別人搶先改的", []));
      const t = gh.treeShaFor(next); gh.trees.set(t, next);
      gh.commits.set("cX", { tree:t, parent:gh.head, message:"別人" }); gh.head = "cX";
    }
  }});
  const beforeA1 = gh.files().get("data/a1.json");
  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/a1.json", contentB64: enc(grp("甲改", [])) },
           { path:"data/b1.json", contentB64: enc(grp("乙改", [])) }],
    baseHashes:{ "data/a1.json": sha256(beforeA1), "data/b1.json": sha256(gh.files().get("data/b1.json")) },
  })).json();
  chk("★ a1 沒有被部分寫入", r.ok || gh.files().get("data/a1.json") === beforeA1,
      r.ok ? "重試後整批成功" : "整批中止");
}

/* ══ 10 ══ create-only:兩人各自新增同一個代號。 */
hr("⑩ 兩位總管理員各自新增同代號的分組");
{
  const gh = new FakeGitHub(base()); gh.install();
  const mk = leader => post("/publish", { session:sOwner,
    files:[{ path:"data/c9.json", contentB64: enc(grp(leader, [])) },
           { path:"data/_index.json", contentB64: enc(idx([{code:"A1",name:"甲",id:"g1"},{code:"B1",name:"乙",id:"g2"},{code:"C9",name:"新",id:"g9"}])) }],
    baseHashes:{ "data/_index.json": sha256(gh.files().get("data/_index.json")) } });
  const r1 = await (await mk("先建的")).json();
  const r2 = await (await mk("後建的")).json();
  chk("第一位成功", r1.ok === true, JSON.stringify(r1).slice(0, 50));
  chk("★ 第二位被 already_exists 擋下", r2.error === "already_exists" || r2.error === "stale_base",
      JSON.stringify(r2).slice(0, 60));
  chk("先建的內容還在", JSON.parse(gh.files().get("data/c9.json")).leader === "先建的");
}

/* ══ 11 ══ 版本檢查讀取失敗 → fail-closed,不可盲寫。 */
hr("⑪ 版本檢查期間 GitHub 讀取失敗");
{
  const gh = new FakeGitHub(base()); gh.install();
  const before = gh.files().get("data/a1.json");
  // 只有舊版前端(沒有 blobSha)才會走逐檔讀取,這裡刻意模擬那條路
  gh.failReadOnce = "data/a1.json";
  const r = await (await post("/publish", { session:sOwner,
    files:[{ path:"data/a1.json", contentB64: enc(grp("舊草稿蓋過去", [])) }],
    baseHashes:{ "data/a1.json": "過期的雜湊" },
  })).json();
  chk("★ 拒絕寫入而不是盲寫", r.ok !== true, r.error);
  chk("檔案維持原狀", gh.files().get("data/a1.json") === before);
}

/* ══ 12 ══ 子請求預算(Cloudflare 免費方案單次上限 50)。 */
hr("⑫ 子請求預算:14 個資料檔的發布");
{
  const files = { "data/_index.json": idx(Array.from({length:12}, (_,i)=>({code:`A${i+1}`,name:`第${i+1}組`,id:`g${i+1}`}))) };
  for(let i=1;i<=12;i++) files[`data/a${i}.json`] = grp(`組長${i}`, []);
  files["data/_pending.json"] = "[]\n";
  const gh = new FakeGitHub(files); gh.install();
  const baseBlobShas = {}, payload = [];
  const tree = gh.files();
  for(let i=1;i<=12;i++){
    const p = `data/a${i}.json`;
    baseBlobShas[p] = (await import("./github-model.mjs")).blobShaOf(tree.get(p));
    payload.push({ path:p, contentB64: enc(grp(`組長${i}`, [{ id:`g${i}_m1`, name:`新成員${i}` }])) });
  }
  gh.subrequests = 0;
  const r = await (await post("/publish", { session:sOwner, files:payload, baseHashes:{}, baseBlobShas })).json();
  chk("發布成功", r.ok === true, JSON.stringify(r).slice(0, 50));
  chk("★ 子請求數在 50 以內", gh.subrequests <= 50, `實際用了 ${gh.subrequests} 個`);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
