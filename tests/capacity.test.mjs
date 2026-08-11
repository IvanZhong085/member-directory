/* 待認領區的容量測試。

   為什麼需要:原本「單筆申請的照片上限」與「整個 _pending.json 的上限」都是 3MB
   —— 一筆申請就被允許吃掉整個收件預算。實際發生過的後果是待認領區進入「只進不出」:
   /intake 還收得下,但組長認領後要寫回剩下那幾筆卻超過發布端的上限,於是沒有任何人
   能認領或刪除任何一筆,連自己那組的其他編輯都一起發不出去。

   這一組測試把那個死鎖的**反面**釘住:滿的時候仍然認領得動。

   執行:node tests/capacity.test.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGitHub, loadWorker } from "./github-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = loadWorker(path.join(ROOT, "worker/publish-relay.js"), fs);

const ENV = {
  GH_OWNER:"O", GH_REPO:"R", GH_BRANCH:"main", GH_TOKEN:"t",
  ALLOWED_ORIGIN:"https://ivanzhong085.github.io",
  SESSION_SECRET:"x".repeat(48), INTAKE_SECRET:"s3cret",
  RATE_LIMIT:{ get: async()=>null, put: async()=>{} },
};
const grp = (leader, members=[]) => JSON.stringify({ leader, room:"", members, recruiting:[] }, null, 2) + "\n";
const base = () => ({
  "data/_index.json": JSON.stringify([{code:"A1",name:"甲組",id:"g1"}], null, 2) + "\n",
  "data/a1.json": grp("組長甲", []),
  "data/_pending.json": "[]\n",
});
/* 產生一張「看起來像 JPEG」的 base64 照片,長度可控 */
const photo = kb => "data:image/jpeg;base64," + "A".repeat(Math.round(kb * 1024));
const post = (p, body) => W.__worker.fetch(new Request("https://w.test" + p, {
  method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }), ENV);
const apply = (name, photos) => post("/intake", {
  secret:"s3cret",
  applicant: Object.assign({ name, title:"t", company:"c" }, photos),
}).then(r => r.json());

let pass = 0, fail = 0;
const chk = (n, ok, d="") => { ok ? pass++ : fail++; console.log(`  ${ok?"✅":"❌"} ${n}${d?"  —— "+d:""}`); };
const hr = t => console.log("\n" + "─".repeat(72) + "\n" + t + "\n" + "─".repeat(72));
const pendOf = gh => JSON.parse(gh.files().get("data/_pending.json"));

/* ══ 1 ══ 單張照片超過上限 → 丟掉那張,但整筆申請照收。
   刻意的設計:一張照片太大不該讓整份申請消失(名字與聯絡方式才是最重要的)。 */
hr("① 單張照片超過上限");
{
  const gh = new FakeGitHub(base()); gh.install();
  const r = await apply("照片過大的人", { image: photo(300) });   // 上限 220KB
  const list = pendOf(gh);
  chk("申請仍然收下", r.ok === true, JSON.stringify(r).slice(0, 50));
  chk("★ 過大的照片被丟掉,不是整筆退回", list[0] && list[0].image === "");
  chk("姓名等資料都在", list[0] && list[0].name === "照片過大的人");
}

/* ══ 2 ══ 單筆申請的照片總和超過上限 → 超出的部分被丟掉。 */
hr("② 單筆申請的照片總和超過上限");
{
  const gh = new FakeGitHub(base()); gh.install();
  await apply("照片很多的人", { image: photo(200), card: photo(200), products:[photo(200), photo(200)] });
  const a = pendOf(gh)[0];
  const kept = [a.image, a.card].concat(a.products || []).filter(Boolean).length;
  chk("★ 只留下預算內的照片", kept >= 1 && kept <= 3, `留下 ${kept} 張(單筆上限 500KB)`);
  chk("申請本身沒有消失", a.name === "照片很多的人");
}

/* ══ 3 ══ 連續多筆申請 → 收得下;超過整體上限才擋,而且既有的完好無損。 */
hr("③ 連續申請直到待認領區滿");
{
  const gh = new FakeGitHub(base()); gh.install();
  let accepted = 0, blocked = null;
  for(let i = 1; i <= 12; i++){
    const r = await apply("新夥伴" + i, { image: photo(200), card: photo(200) });
    if(r.ok) accepted++;
    else { blocked = r; break; }
  }
  const list = pendOf(gh);
  chk("★ 能容納數筆同時待認領", accepted >= 5, `收下了 ${accepted} 筆`);
  chk("★ 滿了之後是明確的 pending_too_large,不是靜默失敗",
      blocked && blocked.error === "pending_too_large", blocked ? blocked.error : "(沒有被擋)");
  chk("★ 被擋下時,既有的申請完好無損", list.length === accepted, `檔案裡有 ${list.length} 筆`);
  chk("每一筆的資料都還在", list.every((a, i) => a.name === "新夥伴" + (i + 1)));
}

/* ══ 4 ══ ★ 待認領區滿的時候,組長仍然認領得動。
   這是「只進不出」死鎖的反面:原本認領要把剩下那幾筆寫回去,而那個寫入走的是
   /publish 的上限(4MB base64),比 /intake 的上限還小,於是滿的時候誰都動不了。 */
hr("④ ★ 待認領區滿的時候仍然認領得動(只進不出的反面驗證)");
{
  const gh = new FakeGitHub(base()); gh.install();
  let accepted = 0;
  for(let i = 1; i <= 12; i++){
    const r = await apply("新夥伴" + i, { image: photo(200), card: photo(200) });
    if(r.ok) accepted++; else break;
  }
  const before = pendOf(gh);
  const sizeBefore = gh.files().get("data/_pending.json").length;
  const sLeader = await W.makeSession(ENV.SESSION_SECRET, { name:"a1", role:"leader", group:"A1" });
  const r = await (await post("/claim", { session:sLeader, pid: before[0].pid })).json();
  const after = pendOf(gh);
  const a1 = JSON.parse(gh.files().get("data/a1.json"));

  chk("★ 認領成功(沒有被大小上限卡死)", r.ok === true, JSON.stringify(r).slice(0, 60));
  chk("待認領區少了一筆", after.length === before.length - 1, `${before.length} → ${after.length}`);
  chk("檔案確實變小了", gh.files().get("data/_pending.json").length < sizeBefore);
  chk("成員卡建立成功且帶 claimedFrom", a1.members.length === 1 && a1.members[0].claimedFrom === before[0].pid);
  chk("照片已抽成 images/ 實體檔",
      /^g1_m_[a-z0-9]+_x_[0-9a-f]{10}\.jpg$/.test(a1.members[0].image), a1.members[0].image);

  // 認領空出空間之後,新申請又收得進來
  const again = await apply("認領之後才來的人", { image: photo(200), card: photo(200) });
  chk("★ 認領空出空間後,新申請又收得進來", again.ok === true, JSON.stringify(again).slice(0, 50));
}

/* ══ 5 ══ 上限之間的一致性:單筆預算必須明顯小於整體預算。
   這一條是防呆 —— 日後有人只調其中一個數字時,測試會直接失敗。 */
hr("⑤ 上限之間的一致性");
{
  const src = fs.readFileSync(path.join(ROOT, "worker/publish-relay.js"), "utf8");
  const num = re => { const m = src.match(re); return m ? eval(m[1]) : null; };
  const perApp = num(/INTAKE_TOTAL_B64_MAX\s*=\s*([^;]+);/);
  const whole  = num(/MAX_DATA_BYTES\s*=\s*([^;]+);/);
  const perImg = num(/INTAKE_IMG_B64_MAX\s*=\s*([^;]+);/);
  const slots = Math.floor(whole / perApp);
  chk("★ 單筆預算必須明顯小於整體預算", perApp * 4 <= whole,
      `單筆 ${Math.round(perApp/1024)}KB、整體 ${Math.round(whole/1024)}KB → 可容納約 ${slots} 筆`);
  chk("單張上限小於單筆預算", perImg < perApp,
      `單張 ${Math.round(perImg/1024)}KB < 單筆 ${Math.round(perApp/1024)}KB`);
}

console.log(`\n${fail===0 ? "✅ 全數通過" : "❌ 有失敗"}:${pass} 通過 / ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
