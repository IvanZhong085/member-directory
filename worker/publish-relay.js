/**
 * 會員名錄 — 發布中介服務（Cloudflare Worker）
 *
 * 這支程式碼負責「真正保管 GitHub 權杖」，瀏覽器（包含所有操作者）永遠看不到權杖本人，
 * 只會把「密碼」送到這裡驗證；驗證通過才由這支 Worker 代替使用者去更新 GitHub 上的 data.js。
 *
 * 部署方式（不需要安裝任何軟體，全部在 Cloudflare 網站上點一點）：
 * 1. 到 https://dash.cloudflare.com → Workers & Pages → Create → Create Worker
 * 2. 開啟編輯器，把這個檔案的內容整個貼進去、Deploy。
 * 3. 到該 Worker 的 Settings → Variables：
 *    - 加密變數（Secret）：ADMIN_USERS（帳號密碼表，見下方）、SESSION_SECRET（隨機亂碼，見下方）、
 *      GH_TOKEN（你的 GitHub fine-grained 權杖，Contents: Read and write）
 *
 * ADMIN_USERS 的格式是一段 JSON，一個帳號一組「帳號":"密碼"」：
 *     {"ivan":"密碼1","amy":"密碼2","shufen":"密碼3"}
 * 也可以寫成物件，指定角色（三種）：
 *     "ivan":  "密碼"                                        → 總管理員，全開
 *     "主席":  {"password":"密碼","role":"owner"}             → 同上，寫清楚而已
 *     "曾俊凱":{"password":"密碼","role":"leader","group":"A1"} → 組長，只能改 A1 這一組
 *     "123":  {"password":"密碼","role":"viewer"}             → 唯讀，看得到、匯得出，寫不了
 * 要新增／刪除人或改密碼，就改這一格字串再 Deploy，不必動程式碼。
 * 帳號不分大小寫（Ivan 與 ivan 視為同一人），密碼分大小寫。
 * 相容性：沒有設定 ADMIN_USERS 時，仍會沿用舊的單一 ADMIN_PASSWORD，此時帳號固定為 admin。
 *    - 一般變數：GH_OWNER=IvanZhong085、GH_REPO=member-directory、GH_BRANCH=main、GH_PATH=data.js、
 *      ALLOWED_ORIGIN=https://ivanzhong085.github.io
 * 4. 到 Settings → Bindings → 新增 KV Namespace binding，一共兩個，**各自要有自己的 Namespace**：
 *      RATE_LIMIT → 新建一個（例如 member-directory-rate-limit）：登入失敗次數，必要。
 *      VIEWS      → 新建一個（例如 member-directory-views）：前台「累計瀏覽」那格，選用。
 *    沒綁 VIEWS 只是不顯示計數，其他功能完全正常；千萬不要把兩個變數指到同一個 Namespace，
 *    原因見下方 handleViews 的說明（瀏覽量會吃光寫入額度，連帶讓登入限流失效）。
 * 5. Save and deploy，把網址（https://xxx.workers.dev）貼到編輯頁「設定」裡的「後端服務網址」。
 *
 * 完整步驟另見 member-site/worker/README.md。
 */

const SESSION_TTL_SECONDS = 30 * 60;     // 登入後 30 分鐘內免重輸密碼
const MAX_FAILS = 5;                     // 同一個 IP 在下方時間窗內最多錯 5 次（KV 為最終一致性，極端並發下可能略為寬鬆，見下方 MIN_LOGIN_MS）
const FAIL_WINDOW_SECONDS = 15 * 60;     // 15 分鐘
const MIN_LOGIN_MS = 300;                // 每次 /login 至少花這麼久才回應，拖慢暴力破解速度（也讓 timingSafeEqual 更難被計時分析）
const GITHUB_TIMEOUT_MS = 15000;         // 呼叫 GitHub API 的逾時上限，避免請求無限期卡住

/* 附件檔（照片）：編輯頁發布時可一併附上，逐一寫進 repo。
   路徑白名單只允許 images/ 一個資料夾、安全字元檔名、限定副檔名——
   權杖雖只授權這個 repo，仍不給「寫任意路徑」的能力。
   （m/ 的成員分享頁是 Action 產生的產出物,不接受從瀏覽器寫入,理由見下方 FILE_PATH_RE。） */
/* 單次發布的檔案上限。這個數字受 Cloudflare Workers **免費方案單次呼叫 50 個子請求**
   的限制:一次發布的成本是「N 個 blob(只做一次)+ 每次重試 6 個」,所以 20 個檔案配上
   3 次重試約 38 個子請求,留有餘裕。編輯頁不再自動分批 —— 分批會產生「只有照片的
   commit」先推進 main,那些 commit 不符合 sync.yml 的 paths 條件、不會觸發同步,
   卻會讓正在跑的同步流程推送被拒。 */
const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_B64_CHARS = 3 * 1024 * 1024;     // 單一附件 base64 上限（約 2.2MB 原始檔）
/* 只有 images/ 的圖片。m/ 的成員分享頁是 Action 產生的產出物,沒有人該從瀏覽器直接寫——
   而它與編輯頁同源,能寫任意 .html 就等於能在站上放一頁自己的 JavaScript 去偷別人的登入
   憑證。既然前端根本不會送,就不留這個能力。 */
const FILE_PATH_RE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$/;
/* 分組資料檔:data/_index.json(分會結構)與 data/<代號小寫>.json(各組內容)。
   ★ 這條路徑規則就是權限本身:組長只被允許寫自己那一組的檔案,見 canWriteDataFile() ★ */
const DATA_PATH_RE = /^data\/(_index|_pending|[a-z0-9]{1,8})\.json$/;
/* ★ 一個 data/ 檔案能有多大,只有這一個數字說了算 ★
   原本 /publish 的上限是 4MB base64(約 3MB 原始),而 /intake 的上限是 8MB 原始 ——
   兩邊不一致的後果是待認領區會進入「只進不出」:申請累積到 4~5 筆時 intake 還收得下,
   但組長認領後要寫回剩下那幾筆就超過 publish 的上限而被拒,於是**沒有任何人能認領或
   刪除任何一筆**,連自己那組的其他編輯都一起發不出去。兩邊必須是同一個數字。 */
const MAX_DATA_BYTES = 3 * 1024 * 1024;
const MAX_DATA_B64_CHARS = Math.ceil(MAX_DATA_BYTES * 4 / 3) + 8;   // base64 的等值上限(先擋掉明顯過大的請求)
const PENDING_PATH = "data/_pending.json";
/* 一個檔案最多讀進 Worker 記憶體多少位元組。git blobs API 本身容得下 100MB,但 Worker 只有
   約 128MB,而讀一份 N 位元組的 JSON 峰值大約要 5N(base64 回應 → base64 字串 → 位元組陣列
   → 解碼字串 → 解析後的物件)。8MB 對應峰值約 43MB,留了很寬的餘裕。 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/* 這個 session 可不可以寫這個路徑。
   總管理員:data/ 底下都可以。
   組長:只有 data/<自己分組代號>.json——連 _index.json(分會結構)都不行。
   唯讀帳號:一律不行。
   回傳 true/false;非 data/ 開頭的附件(images、m)不經過這裡,由 FILE_PATH_RE 管
   ——所以唯讀帳號還有 handlePublish 開頭那道總開關擋著,不能只靠這裡。 */
/* session 的角色。有兩個地方要判 viewer(這裡與 handlePublish 的總開關),
   各自寫一次字串比對遲早會漂移 —— 一邊改了另一邊沒跟上就是靜默破洞,
   所以只留這一個來源。 */
function sessionRole(sess){ return (sess && sess.r) || "owner"; }
function isViewerSession(sess){ return sessionRole(sess) === "viewer"; }

function canWriteDataFile(sess, path){
  if(!DATA_PATH_RE.test(path)) return false;
  const role = sessionRole(sess);
  if(role === "viewer") return false;                        // 唯讀:連自己的組都沒有
  if(role !== "leader") return true;                         // owner
  const group = String(sess.g || "").trim().toLowerCase();
  if(!group) return false;
  // 待認領區:組長認領新人時要把那筆從清單裡移掉,所以必須能寫。
  // 這是刻意放寬的——組長之間看得到、也動得到彼此還沒認領的申請。
  if(path === PENDING_PATH) return true;
  return path === "data/" + group + ".json";
}

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }
async function fetchWithTimeout(url, opts, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try{ return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally{ clearTimeout(timer); }
}

function corsHeaders(env){
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(env, data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(env)),
  });
}

function b64urlEncode(bytes){
  let bin = ""; for(const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function b64urlDecode(str){
  str = str.replace(/-/g,"+").replace(/_/g,"/");
  while(str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacKey(secret){
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign","verify"]);
}
/* session 帶上登入者帳號(u)、角色(r)與分組(g):發布時要記進 commit 訊息,
   編輯頁也靠它決定顯示哪些功能。payload 有簽章保護,竄改會讓驗證失敗。 */
async function makeSession(secret, acc){
  const payload = JSON.stringify({
    exp: Date.now() + SESSION_TTL_SECONDS*1000,
    u: (acc && acc.name) || "", r: (acc && acc.role) || "owner", g: (acc && acc.group) || "",
  });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return payloadB64 + "." + b64urlEncode(new Uint8Array(sig));
}
/* 通過回傳 payload 物件({exp,u,r,g}),失敗回傳 null——呼叫端一律用真假值判斷 */
async function verifySession(token, secret){
  if(!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  const parts = token.split(".");
  if(parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try{
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sigB64), new TextEncoder().encode(payloadB64));
    if(!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    if(typeof payload.exp !== "number" || Date.now() >= payload.exp) return null;
    return payload;
  }catch(e){ return null; }
}
/* ── 帳號表 ────────────────────────────────────────────────────────────
   來源是 ADMIN_USERS 這一個加密變數,內容為 JSON。一筆帳號兩種寫法都吃:
     "ivan": "密碼"                                          → 總管理員(舊格式,相容)
     "a1": {"password":"密碼","role":"leader","group":"A1"}   → 組長,綁定分組代號
   沒設定 ADMIN_USERS 時沿用舊的單一 ADMIN_PASSWORD(帳號固定 admin)。
   回傳 Map(帳號小寫 → {password,role,group});設定壞掉回傳 null,由呼叫端明確報錯。 */
const USERNAME_RE = /^[^\s\u0000-\u001f\u007f]{1,32}$/;   // 不含空白與控制字元,長度 1–32
const GROUPCODE_RE = /^[A-Za-z0-9]{1,8}$/;

/* 一筆帳號設定 → {password, role, group}。認得三種角色:
     owner   全開(role 留空或寫 owner,以及舊格式的純字串密碼)
     leader  綁定一個分組,只能改那一組
     viewer  唯讀:登得進後台、看得到資料、能匯出,但什麼都寫不了

   ★ 白名單,不是黑名單 ★
   原本寫的是「不是 leader 就當 owner」。那在只有兩種角色時沒問題,加了 viewer
   之後就變成一個安靜的陷阱:role 打成 "Viewer"、"viewer "、"read-only",
   全都會掉進 else 變成**總管理員**,而且部署的人不會看到任何錯誤。
   所以改成:認得的才給,不認得的整筆不生效(跟 leader 沒綁好分組同樣處理)。
   大小寫與前後空白先抹平,免得為了一個空格debug半天。 */
function normalizeAccount(val){
  if(typeof val === "string") return val ? { password: val, role: "owner", group: "" } : null;
  if(!val || typeof val !== "object" || Array.isArray(val)) return null;
  const password = typeof val.password === "string" ? val.password : "";
  if(!password) return null;                       // 空密碼的帳號一律不生效
  const role = String(val.role == null ? "" : val.role).trim().toLowerCase();
  if(role === "" || role === "owner") return { password, role: "owner", group: "" };
  if(role === "viewer") return { password, role: "viewer", group: "" };
  if(role === "leader"){
    const group = typeof val.group === "string" ? val.group.trim() : "";
    if(!GROUPCODE_RE.test(group)) return null;
    return { password, role: "leader", group };
  }
  return null;                                     // 不認得的角色:寧可登不進來,也不要變成總管理員
}
function loadUsers(env){
  const users = new Map();
  if(env.ADMIN_USERS){
    let parsed;
    try{ parsed = JSON.parse(env.ADMIN_USERS); }catch(e){ return null; }
    if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for(const [name, val] of Object.entries(parsed)){
      const key = String(name).trim().toLowerCase();
      if(!USERNAME_RE.test(key)) continue;         // 帳號名不合規就跳過,不讓它進 commit 訊息
      const acc = normalizeAccount(val);
      if(acc) users.set(key, acc);
    }
    return users.size ? users : null;
  }
  if(env.ADMIN_PASSWORD) users.set("admin", { password: env.ADMIN_PASSWORD, role: "owner", group: "" });
  return users.size ? users : null;
}
/* 驗證帳密。帳號不存在時仍走一次完整比對,讓「查無帳號」與「密碼錯」耗時一致,
   不會因為回應快慢而洩漏哪些帳號真的存在。通過回傳 {name,role,group},否則 null。 */
function verifyCredentials(users, username, password){
  const key = String(username == null ? "" : username).trim().toLowerCase();
  const acc = users.get(key);
  const expected = acc === undefined ? "\u0000\u0000no-such-account\u0000\u0000" : acc.password;
  const match = timingSafeEqual(String(password == null ? "" : password), expected);
  return (acc !== undefined && match) ? { name: key, role: acc.role, group: acc.group } : null;
}

/* ⚠️ 角色只做「介面分權」,不是伺服器端的寫入權限 ⚠️
   組長的發布請求與總管理員走完全同一條路:整份 data.js 照收照寫。編輯頁會依角色
   隱藏全域功能、只顯示自己那組,但那是防呆,不是防駭——會用開發者工具的人仍可
   送出任意內容。這是部署者知情下的取捨,見 worker/README.md「權限的真實邊界」。
   要變成真的權限,做法是在 handlePublish 抓現行 data.js、只採用該帳號那一組。 */

/* ── 版本落後偵測(與權限無關,是多人同時編輯的正確性問題)──────────────
   每位組長的瀏覽器都握著「整份」草稿,誰後發布誰就會覆蓋別人先發布的內容。
   發布時帶上「這份草稿是根據哪個版本改的」雜湊,與現行檔案不符就擋下,
   請他重新整理後再改一次,不讓別人的修改被無聲蓋掉。 */
async function sha256Hex(bytes){
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* bytes → 標準 base64（GitHub contents API 要的格式）。分段處理避免
   一次展開成過長的參數列表。 */
function bytesToB64(bytes){
  let bin = "";
  for(let i = 0; i < bytes.length; i += 0x8000){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64ToBytes(b64){
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* 讀一個 repo 檔案的完整內容 + 它的 blob sha。

   為什麼不能直接用 contents API 的 content 欄位:那個欄位**只在檔案 ≤1MB 時才有內容**。
   超過 1MB 時 GitHub 仍回 200,但 content 是空字串、encoding 變成 "none"(size 照樣是
   真實大小)。先前沒有分辨這件事,一個超過 1MB 的 data/_pending.json 就會造成兩種故障:
     ・/intake 的 JSON.parse("") 直接拋錯 → 被外層 catch 成 502,新夥伴表單靜默收不到件
     ・currentFileState 把「空內容」的 SHA-256 當成現行版本 → 與編輯頁(走 GitHub Pages
       讀到完整檔案)算出來的雜湊永遠對不起來 → 組長認領一律被判 stale_base
   一筆含名片與商品照的申請就足以讓 _pending.json 越過 1MB,所以這不是極端狀況。

   >1MB 就改走 git blobs API(上限 100MB)。它吃的是 contents 回來的**同一個 blob sha**,
   而 sha 就是內容本身的識別碼 —— 兩次讀取拿到的必然是同一份內容,中間就算有人推了新
   commit 也不會讀到混血的結果,樂觀鎖的語意不受影響。

   回傳:
     { ok:true, bytes, sha }          讀到了(bytes/sha 皆為 null 代表檔案不存在)
     { ok:false, error, status }      讀不到 —— 呼叫端各自決定要 fail-closed 還是跳過 */
async function ghReadFile(env, headers, path, ref){
  let d;
  try{
    /* ★ ref 可以是 commit sha。傳 sha 進來時,讀到的是**那個 commit 的快照**,
       而不是「此刻的 main」—— 檢查與寫入之間別人推了東西也不會讀到混血的組合。
       這件事在改名情境下是關鍵:若 _index 讀的是移動中的 main、而 commit 建在另一個
       head 上,就會出現「代號檢查通過、但寫進去的是改名前的舊檔」這種兩邊都成功、
       資料卻掉進孤兒檔的結果。 */
    const url = contentsUrlFor(env, path) + "?ref=" + encodeURIComponent(ref || env.GH_BRANCH || "main");
    const r = await fetchWithTimeout(url, { headers }, GITHUB_TIMEOUT_MS);
    if(r.status === 404) return { ok:true, bytes:null, sha:null };   // 還沒有這個檔,不是錯誤
    if(r.status === 401 || r.status === 403) return { ok:false, error:"token_forbidden", status:r.status };
    if(!r.ok) return { ok:false, error:"github_read_failed", status:r.status };
    d = await r.json();
  }catch(e){
    return { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" };
  }
  if(!d || typeof d.sha !== "string" || !d.sha) return { ok:false, error:"github_read_failed" };

  // ≤1MB:內容就在 content 裡。空檔案(size 0)的 content 也是空字串,那是合法的。
  if(d.encoding === "base64" && typeof d.content === "string" && (d.content !== "" || d.size === 0)){
    return { ok:true, bytes: b64ToBytes(d.content), sha: d.sha };
  }
  // >1MB:content 是空的,改用 blob sha 去拿。先擋掉大到不該讀進 Worker 記憶體的檔案,
  // 否則不是回錯誤而是整個 Worker 被 OOM 砍掉 —— 那種失敗更難查。
  if(typeof d.size === "number" && d.size > MAX_READ_BYTES){
    return { ok:false, error:"file_too_large", size:d.size, max:MAX_READ_BYTES };
  }
  try{
    const b = await fetchWithTimeout(blobUrlFor(env, d.sha), { headers }, GITHUB_TIMEOUT_MS);
    if(b.status === 401 || b.status === 403) return { ok:false, error:"token_forbidden", status:b.status };
    if(!b.ok) return { ok:false, error:"github_read_failed", status:b.status };
    const bd = await b.json();
    if(!bd || bd.encoding !== "base64" || typeof bd.content !== "string"){
      return { ok:false, error:"github_read_failed" };
    }
    return { ok:true, bytes: b64ToBytes(bd.content), sha: d.sha };
  }catch(e){
    return { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" };
  }
}

/* (原本這裡有 currentFileState():逐檔讀回來算 SHA-256 做版本比對。
    已被 ghTreeMap() + verifyVersions() 取代 —— 一次 recursive tree 就能拿到所有檔案的
    blob sha,不必每個檔各讀一次。那樣做的成本在 Cloudflare Workers 免費方案上是實際的:
    單次呼叫只有 50 個子請求,14 個資料檔加上一次重試就會越界。) */

/* 組長分組代號(session.g,如 "A1")→ 分組內部 id(如 "g3")。
   照片檔名是 fileSafeId(成員id)+後綴,而成員 id 一律以「分組內部 id + _m…」開頭
   (uid(g.id+"_m")),成員也不會跨組搬動(moveMember 只在組內換位),所以某組所有照片的
   檔名都以該組內部 id 為前綴。用它來判斷組長能不能寫某張 images/ 附件。
   對應關係只存在 data/_index.json,這裡讀一次;讀不到或查無此代號回 null,呼叫端 fail-closed。 */
async function groupInternalId(env, headers, code, ref){
  const want = String(code == null ? "" : code).trim().toLowerCase();
  if(!want) return null;
  try{
    const r = await ghReadFile(env, headers, "data/_index.json", ref);
    if(!r.ok || r.bytes === null) return null;
    const idx = JSON.parse(new TextDecoder().decode(r.bytes));
    if(!Array.isArray(idx)) return null;
    const hit = idx.find(e => e && typeof e.code === "string" && e.code.trim().toLowerCase() === want);
    return hit && typeof hit.id === "string" && hit.id ? hit.id : null;
  }catch(e){ return null; }
}

/* constant-time-ish string compare — avoids leaking password length/content via response timing */
function timingSafeEqual(a, b){
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  const len = Math.max(ea.length, eb.length, 1);
  let diff = ea.length ^ eb.length;
  for(let i=0;i<len;i++) diff |= (ea[i]||0) ^ (eb[i]||0);
  return diff === 0;
}

/* 找不到 RATE_LIMIT 這個 KV binding（管理員忘記綁）時，故意讓登入直接失敗並給出清楚訊息，
   而不是丟出一個沒人看得懂的例外——寧可「暫時登不進去」也不要「悄悄關掉防暴力破解」。 */
function requireKV(env){
  if(!env.RATE_LIMIT || typeof env.RATE_LIMIT.get !== "function"){
    const e = new Error("rate_limit_kv_missing");
    e.code = "rate_limit_kv_missing";
    throw e;
  }
}
async function checkRateLimit(env, ip){
  requireKV(env);
  const raw = await env.RATE_LIMIT.get("fail:" + ip);
  if(!raw) return { blocked:false, count:0 };
  let data; try{ data = JSON.parse(raw); }catch(e){ return { blocked:false, count:0 }; }
  const now = Date.now();
  if(now - data.windowStart > FAIL_WINDOW_SECONDS*1000) return { blocked:false, count:0 };
  if(data.count >= MAX_FAILS){
    return { blocked:true, retryAfter: Math.ceil((data.windowStart + FAIL_WINDOW_SECONDS*1000 - now)/1000) };
  }
  return { blocked:false, count:data.count };
}
async function recordFail(env, ip, prevCount){
  requireKV(env);
  const now = Date.now();
  // 讀-改-寫非原子操作：Workers KV 沒有內建的原子遞增。單一使用者短時間內大量平行請求，
  // 理論上可能讓有效上限略高於 MAX_FAILS；MIN_LOGIN_MS 的人為延遲用來拉高平行攻擊的門檻。
  // 對這個小型名錄網站的威脅模型（好奇的人 / 隨機掃描，非鎖定式攻擊）而言是可接受的取捨。
  await env.RATE_LIMIT.put("fail:" + ip, JSON.stringify({ count:(prevCount||0)+1, windowStart: now }), { expirationTtl: FAIL_WINDOW_SECONDS });
}
async function clearFail(env, ip){
  requireKV(env);
  await env.RATE_LIMIT.delete("fail:" + ip);
}

/* 純連線測試，不驗證密碼、不佔用登入錯誤次數額度。
   caps.files=true 讓編輯頁知道這個 Worker 已支援附件（照片存實體檔、同步分享預覽頁）。 */
/* caps 是給前端判斷「這個 Worker 支援什麼」用的:
   files   發布時可以附照片實體檔(舊版沒有,編輯頁會改走內嵌照片)
   visitor 來賓報名的 entry 設定已填好 —— visitor.html 靠它決定要顯示內嵌表單,
           還是退回「開新分頁到 Google 表單」的舊按鈕。 */
async function handlePing(request, env){
  /* atomic:一次發布寫成單一 commit(全成功或全失敗);read:權威讀取端點;
     claim:認領是伺服器端交易。編輯頁靠這幾個旗標判斷該走新路徑還是舊路徑。 */
  return json(env, { ok:true, service:"member-directory-relay",
    caps:{ files:true, visitor: visitorConfigured(), atomic:true, read:true, claim:true,
           /* 待認領照片存放方式。"r2-v1" = 私有 R2 bucket(照片不進公開 repo)。
              沒有這個欄位或值不同,代表 Worker 還沒更新到支援 R2 的版本 —— 部署時
              一定要先確認這一項,否則 Apps Script 送來的申請會被 503 擋下。 */
           pendingImages: env.PENDING_IMAGES ? PENDING_IMAGE_CAPABILITY : false } });
}

async function handleLogin(request, env){
  const startedAt = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let rl;
  try{
    rl = await checkRateLimit(env, ip);
  }catch(e){
    if(e && e.code === "rate_limit_kv_missing"){
      // 寧可讓登入失敗並提示管理員修設定，也不要在沒有防暴力破解的情況下悄悄放行
      return json(env, { ok:false, error:"rate_limit_unavailable" }, 500);
    }
    throw e;
  }
  if(rl.blocked) return json(env, { ok:false, error:"too_many_attempts", retryAfter: rl.retryAfter }, 429);

  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const users = loadUsers(env);
  if(!users){
    // 帳號表沒設定或 JSON 壞掉:寧可全部登不進去並明講,也不要在無人把關的狀態下放行
    return json(env, { ok:false, error:"misconfigured_no_accounts" }, 500);
  }
  const acc = verifyCredentials(users, body && body.username, body && body.password);

  // 每次 /login 至少花 MIN_LOGIN_MS，拖慢大量平行嘗試的有效速率（也讓時間分析更難）
  const elapsed = Date.now() - startedAt;
  if(elapsed < MIN_LOGIN_MS) await sleep(MIN_LOGIN_MS - elapsed);

  if(!acc){
    /* 記不下這次失敗就不能放行:記不了等於防暴力破解停擺,那時候回 401 會讓人
       以為只是密碼錯,實際上已經可以無限次猜。明講是伺服器端的問題。 */
    try{ await recordFail(env, ip, rl.count); }
    catch(e){ return json(env, { ok:false, error:"rate_limit_unavailable" }, 503); }
    return json(env, { ok:false, error:"wrong_password" }, 401);   // 不區分帳號錯/密碼錯,避免探測帳號
  }
  /* 清掉失敗記錄只是善後,失敗了不該連累一次「密碼正確」的登入 ——
     那筆記錄本來就有 TTL,自己會過期。這裡吞掉例外是刻意的。 */
  try{ await clearFail(env, ip); }catch(e){ /* best-effort */ }
  const session = await makeSession(env.SESSION_SECRET, acc);
  return json(env, { ok:true, session, user: acc.name, role: acc.role, group: acc.group,
    expiresInSeconds: SESSION_TTL_SECONDS });
}

async function ghHeaders(env){
  return {
    "Authorization": "Bearer " + env.GH_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "member-directory-relay",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
/* 讓管理員在設定 Worker 後可以自我檢查：密碼登入成功、且 GitHub 權杖確實可寫入。
   唯讀帳號問不到 —— 它本來就發不了,知道權杖能不能寫也沒有用,
   而這個答案透露的是伺服器的設定狀態,沒必要給不需要的人。 */
async function handleHealth(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const sess = await verifySession(body && body.session, env.SESSION_SECRET);
  if(!sess) return json(env, { ok:false, error:"session_expired" }, 401);
  if(isViewerSession(sess)) return json(env, { ok:false, error:"read_only" }, 403);
  try{
    const r = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}`, { headers: await ghHeaders(env) }, GITHUB_TIMEOUT_MS);
    if(r.status === 401 || r.status === 403) return json(env, { ok:true, github:"invalid_token" });
    if(!r.ok) return json(env, { ok:true, github:"repo_not_found", status:r.status });
    const d = await r.json();
    return json(env, { ok:true, github: (d.permissions && d.permissions.push) ? "writable" : "read_only" });
  }catch(e){
    return json(env, { ok:true, github:"network_error" });
  }
}

function contentsUrlFor(env, path){
  return `https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}/contents/` +
    String(path).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}
function blobUrlFor(env, sha){
  return `https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}/git/blobs/` +
    encodeURIComponent(sha);
}

/* 讀 sha（存在才需要）→ PUT 寫入一個檔案。回傳 {ok} 或 {ok:false, error, status} */
/* pinnedSha:版本檢查那一刻讀到的 blob sha。傳了就直接用,**不再重讀**。

   為什麼重讀是錯的:GitHub contents API 靠 sha 做樂觀鎖 —— 帶著「我看到的版本」
   去寫,別人先寫過就回 409。原本在 PUT 前一刻才去取最新 sha,等於每次都主動把這道
   鎖解掉:兩個人從同一版本開始編輯,檢查都過、寫入一前一後,兩邊都收到「已發布!」,
   先寫那位的修改被無聲蓋掉。中間只要隔著幾張照片的上傳時間(認領新夥伴必帶照片),
   這個窗口就是好幾秒。
   沒傳 pinnedSha(images/ 這種沒有版本語意的附件)才沿用舊行為自己讀。 */
async function ghPutFile(env, headers, path, contentB64, message, pinnedSha){
  const url = contentsUrlFor(env, path);
  const branch = env.GH_BRANCH || "main";
  let sha = pinnedSha === undefined ? undefined : (pinnedSha || undefined);
  if(pinnedSha === undefined){
    try{
      const getRes = await fetchWithTimeout(url + "?ref=" + encodeURIComponent(branch), { headers }, GITHUB_TIMEOUT_MS);
      if(getRes.ok){ sha = (await getRes.json()).sha; }
      else if(getRes.status === 401 || getRes.status === 403){ return { ok:false, error:"token_forbidden" }; }
      else if(getRes.status !== 404){ return { ok:false, error:"github_read_failed", status:getRes.status }; }
    }catch(e){
      return { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" };
    }
  }
  const putBody = { message, content: contentB64, branch };
  if(sha) putBody.sha = sha;
  try{
    const putRes = await fetchWithTimeout(url, { method:"PUT", headers: Object.assign({}, headers, {"Content-Type":"application/json"}), body: JSON.stringify(putBody) }, GITHUB_TIMEOUT_MS);
    if(!putRes.ok){
      const status = putRes.status;
      // 409 = 我們帶去的 sha 已經不是最新的 → 別人在這中間寫過了,就是版本落後
      const error = (status === 401 || status === 403) ? "token_forbidden"
                  : (status === 409 || status === 422) ? "stale_base"
                  : "github_write_failed";
      return { ok:false, error, status };
    }
    return { ok:true };
  }catch(e){
    return { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Git Data API:把一次發布寫成「一個 commit」

   為什麼要換掉 contents API 的逐檔 PUT:
   contents API 一次只能寫一個檔,一次發布 N 個檔就是 N 個 commit、N 次 ref 更新。
   第 k 個失敗時前 k-1 個**已經上線**,而回應卻對使用者說「這次沒有上線」。
   認領新夥伴在語意上是一個交易(建成員卡 + 從待認領區移除 + 寫照片),被拆成
   3~9 個可各自失敗的寫入之後,兩位組長同時認領同一人的結果是:兩人都通過版本檢查
   (檢查全部跑完才開始寫)、各自寫成功自己那組的成員卡,只有後者的待認領區被 409 擋下
   —— 於是同一個人變成兩組的成員,而後者收到的訊息是「這次沒有上線」。

   git data API 可以先把所有檔案做成 blob、組成一棵 tree、建一個 commit,最後只更新
   一次 ref。**全成功或全失敗,沒有中間狀態。**

   併發保護在最後那一步:commit 的 parent 是我們讀到的 head,ref 更新用 force:false
   (只允許快轉)。別人在這中間推過任何東西,parent 就不再是 ref 的現值,GitHub 會拒絕
   —— 這是**跨檔**的樂觀鎖,不是逐檔的。被拒時重讀 head、重新比對各檔雜湊、重試。

   ★ 為什麼 parent 用「當下的 head」而不是使用者載入時的 baseCommitSha:
     同步 Action 每次發布後都會推一個 commit(data.js/m//roster.csv)。若把整個 commit
     綁在載入時的 head 上,那個自動提交會讓**每一次**發布都變成衝突,即使雙方碰的根本
     不是同一個檔。所以這裡的做法是:parent 取當下 head(避免無關的推送造成假衝突),
     真正的衝突偵測留給「逐檔雜湊比對」(只在乎我們要寫的那幾個檔有沒有被動過)
     加上「ref 的 CAS」(擋住讀到寫之間的競爭)。兩者合起來就不會有失落更新。 */
function apiUrl(env, suffix){
  return `https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}/` + suffix;
}
async function ghJson(env, headers, suffix, init){
  const r = await fetchWithTimeout(apiUrl(env, suffix), init ? Object.assign({}, init, {
    headers: Object.assign({}, headers, { "Content-Type":"application/json" }),
  }) : { headers }, GITHUB_TIMEOUT_MS);
  if(r.status === 401 || r.status === 403) return { ok:false, error:"token_forbidden", status:r.status };
  if(!r.ok) return { ok:false, error:"github_write_failed", status:r.status };
  try{ return { ok:true, data: await r.json() }; }
  catch(e){ return { ok:false, error:"github_write_failed" }; }
}

/* 目前分支頂端的 commit sha 與它的 tree sha */
async function ghHead(env, headers, branch){
  const ref = await ghJson(env, headers, "git/ref/heads/" + encodeURIComponent(branch));
  if(!ref.ok) return ref;
  const commitSha = ref.data && ref.data.object && ref.data.object.sha;
  if(!commitSha) return { ok:false, error:"github_write_failed" };
  const commit = await ghJson(env, headers, "git/commits/" + encodeURIComponent(commitSha));
  if(!commit.ok) return commit;
  const treeSha = commit.data && commit.data.tree && commit.data.tree.sha;
  if(!treeSha) return { ok:false, error:"github_write_failed" };
  return { ok:true, commitSha, treeSha };
}

/* 一次拿到某棵 tree 底下所有檔案的 blob sha(路徑 → sha)。
   ★ 這一支是子請求預算的關鍵。原本每個要寫的檔都要單獨讀一次來比對雜湊,14 個資料檔
     就是 14 次;加上重試很容易越過 Cloudflare Workers 免費方案「單次呼叫 50 個子請求」
     的上限,而越界的表現是整個發布失敗、訊息還是「連不到 GitHub」。
     改成一次 recursive tree 之後,不管幾個檔都只花 1 次。 */
async function ghTreeMap(env, headers, treeSha){
  const r = await ghJson(env, headers, "git/trees/" + encodeURIComponent(treeSha) + "?recursive=1");
  if(!r.ok) return r;
  const map = new Map();
  for(const e of (r.data && r.data.tree) || []){
    if(e && e.type === "blob" && typeof e.path === "string") map.set(e.path, e.sha);
  }
  // truncated = tree 太大沒回完。寧可擋下也不要基於不完整的清單做版本判斷
  if(r.data && r.data.truncated) return { ok:false, error:"tree_truncated" };
  return { ok:true, map };
}

/* files:[{ path, contentB64 }] 或 { path, remove:true }(刪檔,改名時要用)
   回傳 { ok:true, commitSha } / { ok:false, error } */
/* 第一階段:把所有檔案做成 blob。
   ★ 這一步刻意放在重試迴圈**外面**。blob 是內容定址的,建立它不會動到 ref,也就
     不會產生任何「已上線」的效果 —— 所以只需要做一次,重試時不必重來。
     這對子請求預算是決定性的:Cloudflare Workers 免費方案單次呼叫只有 50 個子請求,
     若每次重試都重建全部 blob,14 個檔案重試兩次就會越界,而越界的表現是整個發布失敗、
     訊息卻是「連不到 GitHub」。分開之後,每次重試只花 6 個子請求。 */
async function ghCreateBlobs(env, headers, files){
  const blobShas = {};
  for(const f of files){
    if(f.remove) continue;
    const blob = await ghJson(env, headers, "git/blobs", {
      method:"POST", body: JSON.stringify({ content: f.contentB64, encoding:"base64" }),
    });
    if(!blob.ok) return blob;
    blobShas[f.path] = blob.data.sha;
  }
  return { ok:true, blobShas };
}

/* 第二階段:把已經建好的 blob 掛上 tree、建 commit、更新一次 ref。
   ref 更新失敗時什麼都沒有生效,呼叫端可以直接用同一批 blob 重試。 */
async function ghCommitFiles(env, headers, branch, files, message, baseCommitSha, baseTreeSha, blobShas){
  const entries = [];
  for(const f of files){
    if(f.remove){ entries.push({ path:f.path, mode:"100644", type:"blob", sha:null }); continue; }
    entries.push({ path:f.path, mode:"100644", type:"blob", sha: blobShas[f.path] });
  }
  const tree = await ghJson(env, headers, "git/trees", {
    method:"POST", body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
  });
  if(!tree.ok) return tree;
  const commit = await ghJson(env, headers, "git/commits", {
    method:"POST", body: JSON.stringify({ message, tree: tree.data.sha, parents:[baseCommitSha] }),
  });
  if(!commit.ok) return commit;
  /* force:false —— 只允許快轉。別人在我們讀 head 之後推過東西,這一步就會被拒,
     整個 commit 原地作廢(沒有任何檔案上線),呼叫端重讀重試。 */
  const upd = await fetchWithTimeout(apiUrl(env, "git/refs/heads/" + encodeURIComponent(branch)), {
    method:"PATCH",
    headers: Object.assign({}, headers, { "Content-Type":"application/json" }),
    body: JSON.stringify({ sha: commit.data.sha, force:false }),
  }, GITHUB_TIMEOUT_MS);
  if(upd.status === 422 || upd.status === 409) return { ok:false, error:"ref_moved" };
  if(upd.status === 401 || upd.status === 403) return { ok:false, error:"token_forbidden", status:upd.status };
  if(!upd.ok) return { ok:false, error:"github_write_failed", status:upd.status };
  return { ok:true, commitSha: commit.data.sha, blobShas };
}

/* base64 基本檢查：字元集合法且長度合理（避免把垃圾塞進 GitHub API 才被打回） */
function isPlausibleB64(s, max){
  const cap = max || MAX_FILE_B64_CHARS;
  return typeof s === "string" && s.length > 0 && s.length <= cap && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/* ★ 分組資料檔的內容檢查 ★
   data/*.json 進來之後會被 GitHub Action 拿去合併成 data.js、產生分享頁與名冊。
   那條產線是「前台會不會更新」的唯一通道：只要有一個檔案壞掉，合併腳本就會拋錯、
   Action 失敗，data.js 從此停在舊版——全分會的前台一起凍結。所以壞資料要擋在這裡，
   不能等到產線才發現。同時 id 會被拿去組檔名（m/<id>.html），一定要擋掉路徑穿越。 */
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_ARRAY_FIELDS = ["services", "targets", "have", "want", "tagline", "products"];
/* 待認領區的筆數上限。★ 這個數字與 MAX_PENDING_ENTRY_BYTES、MAX_DATA_BYTES 是連動的:
   30 × 96 KiB = 2.88 MiB < 3 MiB,所以「30 筆最大合法申請」是**保證**。
   要調大就得同時調小單筆上限,或調大 MAX_DATA_BYTES —— 三個數字任何一個單獨改動,
   tests/capacity.test.mjs 的一致性檢查都會直接失敗。 */
const MAX_PENDING = 30;
function checkDataFileBody(path, text){
  let doc;
  try{ doc = JSON.parse(text); }catch(e){ return "not_json"; }
  if(path === PENDING_PATH){
    if(!Array.isArray(doc)) return "pending_not_array";
    if(doc.length > MAX_PENDING) return "too_many_pending";
    for(const a of doc){
      if(!a || typeof a !== "object" || Array.isArray(a)) return "pending_entry_not_object";
      if(!MEMBER_ID_RE.test(typeof a.pid === "string" ? a.pid : "")) return "bad_pending_id";
      for(const k of MEMBER_ARRAY_FIELDS){
        if(k in a && a[k] != null && !Array.isArray(a[k])) return "bad_pending_field:" + k;
      }
      const why = checkPhotoRefs(a);
      if(why) return why;
      /* 單筆大小也在這裡守一次。/intake 已經擋過,但 /publish 是另一條入口
         (組長刪申請時會整份重寫),不能只靠其中一邊。 */
      if(new TextEncoder().encode(JSON.stringify(a, null, 2)).length > MAX_PENDING_ENTRY_BYTES){
        return "pending_entry_too_large";
      }
    }
    return null;
  }
  if(path === "data/_index.json"){
    if(!Array.isArray(doc)) return "index_not_array";
    /* 代號重複要擋在這裡。分組檔的檔名就是代號小寫(data/<code>.json),
       兩組同代號 = 兩組共用同一個檔:發布時後寫的整份蓋掉先寫的,前台兩組顯示
       同一批人,被撞掉那組的成員直接從網站上消失。只要總管理員在代號欄打錯一次
       就會發生,而且是靜默的 —— 沒有錯誤、沒有警告,要靠 git 歷史才救得回來。 */
    const seen = new Set();
    for(const e of doc){
      if(!e || typeof e !== "object" || Array.isArray(e)) return "index_entry_not_object";
      if(!GROUPCODE_RE.test(typeof e.code === "string" ? e.code : "")) return "bad_group_code";
      if(typeof e.name !== "string" || typeof e.id !== "string") return "bad_index_field";
      const key = e.code.toLowerCase();          // 檔名是小寫,A1 與 a1 是同一個檔
      if(seen.has(key)) return "dup_group_code:" + e.code;
      seen.add(key);
    }
    return null;
  }
  if(!doc || typeof doc !== "object" || Array.isArray(doc)) return "group_not_object";
  for(const k of ["members", "recruiting"]){
    if(k in doc && !Array.isArray(doc[k])) return "bad_" + k;
  }
  for(const m of (Array.isArray(doc.members) ? doc.members : [])){
    if(!m || typeof m !== "object" || Array.isArray(m)) return "member_not_object";
    // id 之後會變成 m/<id>.html 的檔名——"../index" 這種值會蓋掉 repo 裡的其他檔案
    if(!MEMBER_ID_RE.test(typeof m.id === "string" ? m.id : "")) return "bad_member_id";
    // 這幾個欄位前台與產線都直接 .join()/.map():型別一錯就整頁(整條產線)拋錯
    for(const k of MEMBER_ARRAY_FIELDS){
      if(k in m && m[k] != null && !Array.isArray(m[k])) return "bad_member_field:" + k;
    }
  }
  return null;
}

/* photoRefs 的形狀驗證。回傳錯誤字串或 null。
   這是寫進公開 repo 之前的最後一道:key 必須落在自己那筆申請的前綴底下、mime 必須是
   認得的三種、bytes 與 sha256 必須是合理的值。任何一項不對就整份分組檔退回 ——
   一個被動過手腳的 key 若寫進 _pending.json,認領時就會拿它去讀 R2。 */
const SHA256_RE = /^[0-9a-f]{64}$/;
function checkPhotoRefs(a){
  if(!("photoRefs" in a) || a.photoRefs == null) return null;     // 舊格式:沒有這個欄位
  const pr = a.photoRefs;
  if(typeof pr !== "object" || Array.isArray(pr)) return "bad_photo_refs";
  if(!Array.isArray(pr.products)) return "bad_photo_refs:products";
  if(pr.products.length > 5) return "bad_photo_refs:too_many_products";
  const one = (ref, label) => {
    if(ref == null) return null;
    if(typeof ref !== "object" || Array.isArray(ref)) return "bad_photo_ref:" + label;
    if(!keyBelongsToPid(ref.key, a.pid)) return "bad_photo_ref_key:" + label;
    if(!PENDING_IMG_MIME[ref.mime]) return "bad_photo_ref_mime:" + label;
    if(typeof ref.bytes !== "number" || !(ref.bytes > 0) || ref.bytes > PENDING_IMG_BYTES_MAX){
      return "bad_photo_ref_bytes:" + label;
    }
    if(!SHA256_RE.test(String(ref.sha256 || ""))) return "bad_photo_ref_hash:" + label;
    return null;
  };
  let why = one(pr.image, "image") || one(pr.card, "card");
  if(why) return why;
  for(let i = 0; i < pr.products.length; i++){
    why = one(pr.products[i], "product[" + i + "]");
    if(why) return why;
  }
  const total = [pr.image, pr.card].concat(pr.products).filter(Boolean).length;
  if(total > PENDING_IMG_COUNT_MAX) return "bad_photo_refs:too_many";
  if("photoWarnings" in a && a.photoWarnings != null && !Array.isArray(a.photoWarnings)){
    return "bad_photo_warnings";
  }
  return null;
}

/* ── 新夥伴自填表單的收件口 ────────────────────────────────────────────────
   Google 表單的 Apps Script 在有人送出時呼叫這裡,把申請放進待認領區。
   刻意做成獨立的一條路,而不是給它一組後台帳號:

   - 認證用的是 INTAKE_SECRET(與 ADMIN_USERS、SESSION_SECRET 都不同的一把)
   - 它**只能寫 data/_pending.json**,寫不到任何分組資料,也拿不到 session
   - 沒設 INTAKE_SECRET 就整個關閉,不會有預設開放的狀態
   照片以 data: URL 存在申請裡,組長認領時才會變成 images/ 實體檔——
   沒被認領的人不會在 repo 留下任何圖檔。 */
const INTAKE_TEXT_MAX = 400;          // 單一文字欄位
const INTAKE_LIST_MAX = 12;           // 陣列欄位的項目數
/* ══ 待認領照片改存私有 R2,不再進公開 repo ══════════════════════════════════
   為什麼:照片以 data URL 存在 data/_pending.json 裡,而那個檔案在**公開 repo**。
   一位還沒被任何人認領的申請人,他的名片(上面通常有手機、Email、地址)因此對全世界
   可讀,而且進了 git 歷史 —— 事後刪檔也移不掉。
   照片改放 Cloudflare R2 的私有 bucket,_pending.json 只留文字與「不可公開讀取的
   物件引用」(photoRefs)。認領成功的那一刻才把 web 版照片寫進 repo。

   附帶解掉一個容量問題:照片一旦不在 JSON 裡,「同時能有幾筆待認領」就與照片大小
   完全脫鉤,也不必再為了塞得下而截斷商品照。 */
const PENDING_IMAGE_PREFIX = "pending/";
const PENDING_IMAGE_CAPABILITY = "r2-v1";      // /ping 回報,前端與部署檢查用
const PENDING_IMG_BYTES_MAX = 200 * 1024;      // 單張照片**解碼後**的位元組上限
const PENDING_IMG_COUNT_MAX = 7;               // 形象照 1 + 名片 1 + 商品照 5
/* 整個請求裡所有照片的位元組上限。由「張數 × 單張上限」推導,不是另外拍一個數字 ——
   它的用途是防止 intake secret 外流後被拿來灌爆 R2,不是拿來截斷合法申請。 */
const PENDING_IMG_TOTAL_BYTES_MAX = PENDING_IMG_COUNT_MAX * PENDING_IMG_BYTES_MAX;
const PENDING_IMG_MIME = { "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp" };

/* 單筆申請的 metadata(已清理、已含 photoRefs)序列化後的位元組上限。
   推導:目前欄位的最大合法長度是 name 80 + title 80 + company 120 + business_items 400
   + website 300 + 五個陣列各 12 項 × 400 字 = 24,980 字。中文在 UTF-8 是 3 bytes,
   即約 75 KB,加上 JSON 的縮排/引號/逗號與 7 個 photoRefs 約 78 KB。
   取 96 KiB 作上限,30 筆 × 96 KiB = 2.88 MiB < MAX_DATA_BYTES(3 MiB)——
   於是「30 筆最大合法申請」是**保證**而不是估計。見 tests/capacity.test.mjs。 */
const MAX_PENDING_ENTRY_BYTES = 96 * 1024;

const INTAKE_MAX_PER_WINDOW = 20;     // 同一 IP 在節流窗內最多送幾份
const DATA_IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max || INTAKE_TEXT_MAX);
const list = v => (Array.isArray(v) ? v : String(v == null ? "" : v).split("\n"))
  .map(x => str(x)).filter(Boolean).slice(0, INTAKE_LIST_MAX);

/* 只整理**文字**。照片走 parsePendingPhotos() 那條路 —— 兩者刻意分開。
   原本兩件事混在一起,而且所有照片錯誤都用「回空字串」表示:一張照片格式壞掉、太大、
   或超出預算,結果都是靜默消失,表單那頭仍然顯示送出成功,沒有任何人會知道。
   回傳 null 代表連姓名都沒有,那才是真的不收。 */
function sanitizeApplicantText(raw, pid){
  if(!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = str(raw.name, 80);
  if(!name) return null;
  return {
    pid,
    at: new Date().toISOString(),
    name,
    title: str(raw.title, 80),
    company: str(raw.company, 120),
    services: list(raw.services),
    targets: list(raw.targets),
    have: list(raw.have),
    want: list(raw.want),
    tagline: list(raw.tagline),
    business_items: str(raw.business_items),
    website: /^https?:\/\/[^\s]{1,300}$/.test(String(raw.website || "").trim()) ? String(raw.website).trim() : "",
    /* 舊格式的三個欄位保留為空字串/空陣列,讓還沒更新的前端不會因為缺欄位而爆掉。
       新資料一律**不**在這裡放 data URL —— 照片只存在 photoRefs 指向的 R2 物件。 */
    image: "",
    card: "",
    products: [],
  };
}

/* 一張待處理的照片:驗格式 → 解碼 → 量真實位元組 → 算雜湊。
   回傳 { ok:true, bytes, mime, sha256 } 或 { ok:false, error }。
   ★ 長度限制一律以**解碼後的位元組**為準。base64 字串長度只是它的 4/3 倍再加 padding,
     拿字串長度當上限會讓不同 padding 的同尺寸圖片有不同待遇。 */
async function parseOnePhoto(value){
  const s = String(value == null ? "" : value);
  if(!s) return { ok:false, error:"empty" };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if(!m) return { ok:false, error:"bad_format" };
  const mime = m[1];
  if(!PENDING_IMG_MIME[mime]) return { ok:false, error:"bad_mime" };
  let bytes;
  try{ bytes = b64ToBytes(m[2]); }
  catch(e){ return { ok:false, error:"bad_base64" }; }
  if(!bytes.length) return { ok:false, error:"empty" };
  if(bytes.length > PENDING_IMG_BYTES_MAX){
    return { ok:false, error:"too_large", bytes: bytes.length, max: PENDING_IMG_BYTES_MAX };
  }
  return { ok:true, bytes, mime, sha256: await sha256Hex(bytes) };
}

/* 把一份申請裡的所有照片解析出來(還沒寫進 R2)。
   欄位是固定的:image、card、products[0..4] —— 呼叫端送什麼欄位名都不會影響 key。 */
async function parsePendingPhotos(raw){
  const slots = [];
  slots.push({ field:"image", index:-1, value: raw && raw.image });
  slots.push({ field:"card",  index:-1, value: raw && raw.card });
  const prods = Array.isArray(raw && raw.products) ? raw.products.slice(0, 5) : [];
  prods.forEach((v, i) => slots.push({ field:"product", index:i, value:v }));

  const out = [];
  let total = 0;
  for(const s of slots){
    if(s.value == null || s.value === "") continue;      // 沒提供這一張,不是錯誤
    const r = await parseOnePhoto(s.value);
    if(!r.ok){
      return { ok:false, error: r.error === "too_large" ? "pending_image_too_large" : "invalid_pending_image",
               field: s.field + (s.index >= 0 ? "[" + s.index + "]" : ""),
               reason: r.error, bytes: r.bytes, max: r.max };
    }
    total += r.bytes.length;
    if(out.length >= PENDING_IMG_COUNT_MAX){
      return { ok:false, error:"invalid_pending_image", field:"products", reason:"too_many", max: PENDING_IMG_COUNT_MAX };
    }
    if(total > PENDING_IMG_TOTAL_BYTES_MAX){
      return { ok:false, error:"pending_image_too_large", field:"(total)", reason:"total_too_large",
               bytes: total, max: PENDING_IMG_TOTAL_BYTES_MAX };
    }
    out.push(Object.assign({}, s, r));
  }
  return { ok:true, photos: out };
}

/* R2 的 key 完全由伺服器決定:pid(伺服器產生)+ 固定欄位名 + 索引 + 內容雜湊。
   呼叫端送來的檔名一個字都不會進到這裡 —— 路徑穿越與跨申請讀取在這一層就不可能。 */
function pendingKeyFor(pid, field, index, sha256, mime){
  const base = field + (index >= 0 ? "-" + index : "");
  return PENDING_IMAGE_PREFIX + pid + "/" + base + "-" + sha256.slice(0, 16) + "." + PENDING_IMG_MIME[mime];
}
/* 這個 key 是不是屬於這一筆申請。認領時每一個 photoRef 都要過這一關。 */
function keyBelongsToPid(key, pid){
  return typeof key === "string" && key.startsWith(PENDING_IMAGE_PREFIX + pid + "/") && !key.includes("..");
}

/* 刪掉某一筆申請在 R2 的全部照片。best-effort:回傳沒刪成功的 key。
   呼叫端要嘛把它當成清理(失敗只記錄),要嘛在建立階段用它回滾。 */
async function deletePendingImages(env, keys){
  const failed = [];
  for(const k of keys || []){
    try{ await env.PENDING_IMAGES.delete(k); }
    catch(e){ failed.push(k); }
  }
  return failed;
}

async function handleIntake(request, env){
  const secret = env.INTAKE_SECRET;
  if(!secret) return json(env, { ok:false, error:"intake_disabled" }, 503);

  const startedAt = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let count = 0;
  try{
    requireKV(env);
    const raw = await env.RATE_LIMIT.get("intake:" + ip);
    const d = raw ? JSON.parse(raw) : null;
    if(d && Date.now() - d.windowStart <= FAIL_WINDOW_SECONDS*1000){
      if(d.count >= INTAKE_MAX_PER_WINDOW) return json(env, { ok:false, error:"too_many_submissions" }, 429);
      count = d.count;
    }
  }catch(e){
    if(e && e.code === "rate_limit_kv_missing") return json(env, { ok:false, error:"rate_limit_unavailable" }, 500);
  }

  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const good = timingSafeEqual(String(body && body.secret == null ? "" : body.secret), secret);
  const elapsed = Date.now() - startedAt;
  if(elapsed < MIN_LOGIN_MS) await sleep(MIN_LOGIN_MS - elapsed);
  try{ await env.RATE_LIMIT.put("intake:" + ip, JSON.stringify({ count: count+1, windowStart: Date.now() }), { expirationTtl: FAIL_WINDOW_SECONDS }); }catch(e){}
  if(!good) return json(env, { ok:false, error:"bad_secret" }, 401);

  /* ★ 沒有 R2 就整個停下來,不退回「照片塞進 _pending.json」的舊行為。
     那個退路正是要消滅的東西:一旦退回去,未認領者的名片又會進公開 repo 與 git 歷史,
     而且是在沒有人察覺的情況下。寧可讓表單明確失敗、資料留在回應試算表可補送。 */
  if(!env.PENDING_IMAGES){
    return json(env, { ok:false, error:"pending_image_store_unavailable" }, 503);
  }

  // pid 由這裡產生,不讓外面決定——它之後會出現在 R2 key、檔名與 DOM 屬性裡
  const pid = "p_" + Date.now().toString(36) + Math.floor(Math.random()*1e6).toString(36);
  const applicant = sanitizeApplicantText(body && body.applicant, pid);
  if(!applicant) return json(env, { ok:false, error:"bad_applicant" }, 400);

  /* 照片:先全部解析驗證,再全部上傳。任何一張不合格就整筆退回 ——
     不再有「靜默丟掉一張照片但回報成功」這種結果。
     只有 Apps Script 明確送 allowMissingPhotos 時才容許缺照片,而且會在申請上留下
     photoWarnings,讓組長在後台看得到「這一筆少了什麼」。 */
  const allowMissingPhotos = (body && body.allowMissingPhotos) === true;
  const parsed = await parsePendingPhotos(body && body.applicant);
  if(!parsed.ok){
    if(!allowMissingPhotos){
      return json(env, { ok:false, error:parsed.error, field:parsed.field, reason:parsed.reason,
                         bytes:parsed.bytes, max:parsed.max }, 400);
    }
    applicant.photoWarnings = [{ field:parsed.field, reason:parsed.reason }];
    parsed.photos = [];
  }

  /* 上傳到 R2。中途失敗就把這次已經上傳的刪掉 —— 不留半套,也不建立 pending 記錄。 */
  const uploaded = [];
  const photoRefs = { image:null, card:null, products:[] };
  for(const p of (parsed.photos || [])){
    const key = pendingKeyFor(pid, p.field, p.index, p.sha256, p.mime);
    try{
      await env.PENDING_IMAGES.put(key, p.bytes, { httpMetadata:{ contentType: p.mime } });
    }catch(e){
      await deletePendingImages(env, uploaded);
      return json(env, { ok:false, error:"pending_image_store_failed", field:p.field }, 502);
    }
    uploaded.push(key);
    const ref = { key, mime:p.mime, bytes:p.bytes.length, sha256:p.sha256 };
    if(p.field === "image") photoRefs.image = ref;
    else if(p.field === "card") photoRefs.card = ref;
    else photoRefs.products.push(ref);
  }
  applicant.photoRefs = photoRefs;
  if(!applicant.photoWarnings) applicant.photoWarnings = [];

  /* 單筆 metadata 的大小上限。照片已經不在 JSON 裡,所以這個數字只跟文字有關 ——
     它讓「同時能有幾筆待認領」變成一個可推導的保證,而不是隨照片大小浮動的估計。 */
  const entryBytes = new TextEncoder().encode(JSON.stringify(applicant, null, 2)).length;
  if(entryBytes > MAX_PENDING_ENTRY_BYTES){
    await deletePendingImages(env, uploaded);
    return json(env, { ok:false, error:"pending_entry_too_large", size:entryBytes, max:MAX_PENDING_ENTRY_BYTES }, 413);
  }

  const headers = await ghHeaders(env);
  /* 從這裡開始,任何失敗都要把剛才上傳的 R2 物件清掉 —— 否則會留下沒有任何 pending
     記錄指向它的孤兒。清理本身失敗不影響「這次是失敗」的結論(bucket 上另有 30 天的
     lifecycle rule 當最後保險),但絕不能把失敗回報成成功。 */
  const failWith = async (payload, status) => {
    const left = await deletePendingImages(env, uploaded);
    if(left.length) payload.orphanKeys = left.length;   // 只回數量,不回內容
    return json(env, payload, status);
  };

  /* 讀-改-寫 data/_pending.json,帶樂觀鎖(pinned sha)重試。
     為什麼要鎖:兩位新夥伴幾乎同時送出表單、或一筆 intake 撞上組長認領(認領也在寫
     _pending)時,若各自「讀舊清單 → 追加 → 寫回」而不帶版本,後寫的會靜默蓋掉先寫的
     —— 一筆申請憑空消失(表單卻回報成功),或把剛被認領移除的人又寫回待認領區「復活」、
     被重複認領成兩位成員。做法與 /publish 一致:讀取時記下 blob sha,原封帶去寫,別人
     先寫過 GitHub 就回 409/422,這時重讀最新版、重新合併、再寫,最多幾次。
     全部重試用完仍失敗就 fail-closed 回錯誤 —— 表單資料留在回應試算表,可補救,
     絕不靜默覆蓋。 */
  const MAX_INTAKE_TRIES = 5;
  let pendingCount = 0;
  for(let attempt = 0; ; attempt++){
    let current = [], sha = null;
    const read = await ghReadFile(env, headers, PENDING_PATH);
    if(!read.ok){
      return await failWith({ ok:false, error:read.error, status:read.status, size:read.size, max:read.max }, 502);
    }
    if(read.bytes !== null){
      /* 檔案在,但內容讀不懂(不是合法 JSON、或不是陣列)就 fail-closed。
         原本這裡是「解析失敗就當成空清單」,而空清單接下來會被當成基底整份寫回去 ——
         等於把所有還沒被認領的申請一次抹掉,而且表單那頭收到的是「送出成功」。
         寧可這一筆退回請對方稍後再送(資料還留在回應試算表),也不要洗掉別人的申請。 */
      let parsed;
      try{ parsed = JSON.parse(new TextDecoder().decode(read.bytes)); }
      catch(e){ return await failWith({ ok:false, error:"pending_unreadable" }, 502); }
      if(!Array.isArray(parsed)) return await failWith({ ok:false, error:"pending_unreadable" }, 502);
      current = parsed;
      sha = read.sha;   // ★ 留住 sha 當樂觀鎖,別像以前丟掉
    }
    // read.bytes === null:還沒有這個檔,current 空、sha null(寫入時不帶 sha = 建立新檔)
    if(current.length >= MAX_PENDING) return await failWith({ ok:false, error:"pending_full", max:MAX_PENDING }, 409);

    const next = current.concat([applicant]);
    const bytes = new TextEncoder().encode(JSON.stringify(next, null, 2) + "\n");
    /* 寫入上限與讀取上限刻意是同一個數字:永遠不要寫出一份自己讀不回來的檔案。
       照片移出去之後這個檔只剩文字,單筆有 MAX_PENDING_ENTRY_BYTES 的上限、筆數有
       MAX_PENDING 的上限,兩者相乘已經低於這裡;這道閘門是最後一層防呆。
       擋在這裡的話,訊息是明確的:待認領區滿了,請組長先認領或清掉幾筆。 */
    if(bytes.length > MAX_DATA_BYTES){
      return await failWith({ ok:false, error:"pending_too_large", size:bytes.length, max:MAX_DATA_BYTES }, 409);
    }
    const res = await ghPutFile(env, headers, PENDING_PATH, bytesToB64(bytes),
                                "新夥伴申請待認領：" + applicant.name, sha);
    if(res.ok){ pendingCount = next.length; break; }
    // stale_base = 我們帶去的 sha 已過期(別人在這中間寫過)→ 重讀重試,不覆蓋對方
    if(res.error === "stale_base" && attempt < MAX_INTAKE_TRIES - 1) continue;
    return await failWith({ ok:false, error:res.error, status:res.status }, 502);
  }
  return json(env, { ok:true, pid, pending: pendingCount,
                     photos: uploaded.length, warnings: applicant.photoWarnings });
}

/* ══ 權威讀取 ══════════════════════════════════════════════════════════════
   編輯頁原本用相對路徑讀 data/*.json —— 那是 GitHub **Pages** 上的已部署版本,而
   Worker 驗證版本時讀的是 GitHub **API**(repo 的當下狀態)。兩者的一致性時機不同:
   任何人發布後,Pages 要 1~4 分鐘才重新部署。在那段窗口裡,其他人載入編輯頁拿到的是
   **必定過期**的版本基準,發布一定被判 stale_base;而畫面提示叫他「重新整理取得最新
   資料」,重新整理拿到的還是同一份舊內容 —— 於是形成迴圈,而且待認領區裡還會列出
   已經被別人認領走的人(按下去就是重複認領)。
   讓編輯頁改從這裡讀,載入與驗證就來自同一個立即一致的來源。
   內容本身不是機密(公開 repo、公開網站都讀得到),但仍要求登入 —— 沒必要讓未登入者
   拿它當一支免費的 API。 */
async function handleRead(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const sess = await verifySession(body && body.session, env.SESSION_SECRET);
  if(!sess) return json(env, { ok:false, error:"session_expired" }, 401);

  const paths = Array.isArray(body && body.paths) ? body.paths.slice(0, 20) : [];
  if(!paths.length) return json(env, { ok:false, error:"bad_request" }, 400);
  for(const p of paths){
    if(typeof p !== "string" || !DATA_PATH_RE.test(p)){
      return json(env, { ok:false, error:"bad_file_path", path:p }, 400);
    }
  }
  const headers = await ghHeaders(env);
  const files = {};
  for(const p of paths){
    const r = await ghReadFile(env, headers, p);
    if(!r.ok) return json(env, { ok:false, error:r.error, path:p, status:r.status }, 502);
    files[p] = r.bytes === null ? { exists:false } : {
      exists:true,
      text: new TextDecoder().decode(r.bytes),
      hash: await sha256Hex(r.bytes),   // 內容雜湊:給草稿的三方比較用
      blobSha: r.sha,                   // git blob sha:給發布時的版本檢查用(省掉逐檔重讀)
    };
  }
  return json(env, { ok:true, files });
}

/* ══ 一次性遷移:把舊格式的 data URL 照片搬進 R2 ═════════════════════════════
   部署 R2 版本之前收到的申請,照片還以 data URL 存在 data/_pending.json 裡(而那個檔
   在公開 repo)。這支端點把它們搬到私有 R2、換成 photoRefs,然後用**一個**受版本檢查
   的 commit 改寫 _pending.json。

   ・可重跑(idempotent):已經有 photoRefs 的項目直接跳過,不會重複上傳或重複計數。
   ・只動「目前的」_pending.json,**不改寫 git 歷史** —— 歷史裡的舊照片要不要清除
     是另一個決定(git filter-repo),不在這支端點的範圍。
   ・只有總管理員能執行。 */
async function handleMigratePending(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const sess = await verifySession(body && body.session, env.SESSION_SECRET);
  if(!sess) return json(env, { ok:false, error:"session_expired" }, 401);
  if(sessionRole(sess) !== "owner") return json(env, { ok:false, error:"forbidden_path", path:PENDING_PATH }, 403);
  if(!env.PENDING_IMAGES) return json(env, { ok:false, error:"pending_image_store_unavailable" }, 503);

  const headers = await ghHeaders(env);
  const head = await ghHead(env, headers, env.GH_BRANCH || "main");
  if(!head.ok) return json(env, { ok:false, error:head.error, status:head.status }, 502);
  const tm = await ghTreeMap(env, headers, head.treeSha);
  if(!tm.ok) return json(env, { ok:false, error:tm.error }, 502);

  const read = await ghReadFile(env, headers, PENDING_PATH, head.commitSha);
  if(!read.ok) return json(env, { ok:false, error:read.error, status:read.status }, 502);
  if(read.bytes === null) return json(env, { ok:true, migrated:0, skipped:0, note:"沒有待認領區檔案" });
  let list;
  try{ list = JSON.parse(new TextDecoder().decode(read.bytes)); }
  catch(e){ return json(env, { ok:false, error:"pending_unreadable" }, 502); }
  if(!Array.isArray(list)) return json(env, { ok:false, error:"pending_unreadable" }, 502);

  let migrated = 0, skipped = 0;
  const uploaded = [];
  for(const a of list){
    if(!a || typeof a !== "object") continue;
    if(a.photoRefs){ skipped++; continue; }                 // 已經是新格式
    const parsed = await parsePendingPhotos(a);
    if(!parsed.ok){
      await deletePendingImages(env, uploaded);
      return json(env, { ok:false, error:parsed.error, pid:a.pid, field:parsed.field, reason:parsed.reason }, 400);
    }
    const refs = { image:null, card:null, products:[] };
    for(const p of parsed.photos){
      const key = pendingKeyFor(a.pid, p.field, p.index, p.sha256, p.mime);
      try{ await env.PENDING_IMAGES.put(key, p.bytes, { httpMetadata:{ contentType:p.mime } }); }
      catch(e){
        await deletePendingImages(env, uploaded);
        return json(env, { ok:false, error:"pending_image_store_failed", pid:a.pid, field:p.field }, 502);
      }
      uploaded.push(key);
      const ref = { key, mime:p.mime, bytes:p.bytes.length, sha256:p.sha256 };
      if(p.field === "image") refs.image = ref;
      else if(p.field === "card") refs.card = ref;
      else refs.products.push(ref);
    }
    a.photoRefs = refs;
    a.image = ""; a.card = ""; a.products = [];             // 公開 repo 裡不再留 base64
    if(!a.photoWarnings) a.photoWarnings = [];
    migrated++;
  }
  if(!migrated) return json(env, { ok:true, migrated:0, skipped });

  const bytes = new TextEncoder().encode(JSON.stringify(list, null, 2) + "\n");
  const baseBlobShas = {};
  if(tm.map.has(PENDING_PATH)) baseBlobShas[PENDING_PATH] = tm.map.get(PENDING_PATH);
  const r = await commitWithVersionCheck(env, headers, {
    files: [{ path: PENDING_PATH, contentB64: bytesToB64(bytes) }],
    remove: [], baseHashes:{}, baseBlobShas, assetPaths: [], sess,
    message: "待認領照片搬到私有儲存（" + migrated + " 筆）",
  });
  if(!r.ok){
    /* commit 失敗:剛上傳的 R2 物件沒有任何 pending 記錄指向它們,清掉。
       這也是可重跑的原因 —— 重跑一次會從頭再來,不會留下半套。 */
    await deletePendingImages(env, uploaded);
    return json(env, r.body, r.status);
  }
  return json(env, { ok:true, migrated, skipped, commit:r.commitSha });
}

/* ══ 認領新夥伴(伺服器端交易)══════════════════════════════════════════════
   為什麼要把認領搬到伺服器:
   認領在語意上是「這位申請人歸這一組」——一個**只能發生一次**的動作。原本它完全是
   前端的草稿操作(建成員卡 + 從待認領清單移除),真正生效要等發布。兩位組長同時認領
   同一人時,兩邊的草稿各自成立、各自通過版本檢查(檢查全部跑完才開始寫),於是各自
   寫成功自己那組的成員卡 —— 同一個人變成兩組的成員,而後者收到的訊息還是
   「這次沒有上線」。前端無論怎麼防都補不起來,因為兩個瀏覽器看不到彼此。

   把「這筆是否仍在待認領區」與「寫入」放進同一個伺服器端交易,才是唯一擋得住的位置:
   第二位組長會拿到明確的 already_claimed,而且他那組**一個位元組都沒有被寫入**。 */
const CLAIM_IMG_EXT = { jpeg:"jpg", png:"png", webp:"webp" };

/* 申請 → 成員卡。照片從 base64 抽成 images/ 實體檔,檔名帶**內容雜湊**:
   原本檔名只由成員 id 決定,兩個人同時替同一位換照片就會寫到同一個路徑,而 images/
   的寫入完全沒有版本鎖 → 後寫的靜默蓋掉先寫的,雙方都不會收到任何錯誤。
   把內容雜湊放進檔名之後,不同的照片必然是不同的檔,永遠不會互相覆蓋;內容相同則
   自然指向同一個檔,不會產生重複檔案。 */
/* 認領時把照片準備好:新格式從 R2 取回並驗證,舊格式(部署 R2 之前收到的申請)
   仍然從 data URL 解。★ 這一步必須在**動 Git ref 之前**全部完成 —— 先建 commit 再去
   拿圖的話,拿不到就會留下「成員卡已上線但沒有照片、申請也已從待認領區消失」的狀態。
   回傳 { ok:true, files, names, missing } 或 { ok:false, error, ... }。 */
async function resolvePendingPhotos(env, a, memberId, allowMissing){
  const files = [], names = { image:"", card:"", products:[] }, missing = [];
  const suffixOf = (field, index) => field === "product" ? "p" + (index + 1) : (field === "card" ? "card" : "x");
  const record = (field, index, bytes, mime, sha) => {
    const name = memberId + "_" + suffixOf(field, index) + "_" + sha.slice(0, 10) + "." + PENDING_IMG_MIME[mime];
    files.push({ path: "images/" + name, contentB64: bytesToB64(bytes) });
    if(field === "image") names.image = name;
    else if(field === "card") names.card = name;
    else names.products.push(name);
  };

  const pr = a && a.photoRefs;
  if(pr && typeof pr === "object"){
    /* 新格式的申請需要 R2 才認領得出照片。沒有 binding 就明確擋下 —— 若在這裡「當成
       沒有照片」放行,結果會是成員卡建立了、申請也從待認領區消失了,但照片永遠找不回來。 */
    if(!env.PENDING_IMAGES) return { ok:false, error:"pending_image_store_unavailable" };
    const slots = [];
    if(pr.image) slots.push({ field:"image", index:-1, ref:pr.image });
    if(pr.card)  slots.push({ field:"card",  index:-1, ref:pr.card });
    (Array.isArray(pr.products) ? pr.products : []).forEach((r, i) => slots.push({ field:"product", index:i, ref:r }));

    for(const s of slots){
      const label = s.field + (s.index >= 0 ? "[" + s.index + "]" : "");
      /* key 必須落在這一筆申請自己的前綴底下。少了這一關,一個被動過手腳的
         _pending.json 就能讓認領去讀別筆申請(甚至別的 prefix)的物件。 */
      if(!keyBelongsToPid(s.ref && s.ref.key, a.pid)){
        return { ok:false, error:"pending_image_forbidden", field:label };
      }
      let obj = null;
      try{ obj = await env.PENDING_IMAGES.get(s.ref.key); }catch(e){ obj = null; }
      if(!obj){ missing.push(label); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if(bytes.length !== s.ref.bytes){
        return { ok:false, error:"pending_image_corrupt", field:label, reason:"bytes" };
      }
      const h = await sha256Hex(bytes);
      if(h !== s.ref.sha256){
        return { ok:false, error:"pending_image_corrupt", field:label, reason:"sha256" };
      }
      record(s.field, s.index, bytes, s.ref.mime, h);
    }
    if(missing.length && !allowMissing){
      /* 預設擋下。要在明知缺圖的情況下認領,必須由後台明確送 allowMissingImages,
         而且介面上要先列出缺哪幾張 —— 不可以是預設值。 */
      return { ok:false, error:"pending_image_missing", fields: missing };
    }
    return { ok:true, files, names, missing };
  }

  /* ── 舊格式:照片以 data URL 存在申請裡 ──
     部署 R2 之前收到的申請仍然要能認領,不能因為升級 Worker 就把它們卡死。 */
  const pick = async (value, field, index) => {
    const raw = String(value == null ? "" : value);
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(raw);
    if(!m) return raw && !raw.startsWith("data:") ? str(raw, 200) : "";
    const b64 = m[2].trim();
    if(!b64 || !isPlausibleB64(b64, Math.ceil(PENDING_IMG_BYTES_MAX * 4 / 3) + 8)) return "";
    const bytes = b64ToBytes(b64);
    const sha = await sha256Hex(bytes);
    record(field, index, bytes, "image/" + m[1], sha);
    return names[field === "product" ? "products" : field];
  };
  await pick(a.image, "image", -1);
  await pick(a.card, "card", -1);
  const prods = Array.isArray(a.products) ? a.products.slice(0, 5) : [];
  for(let i = 0; i < prods.length; i++) await pick(prods[i], "product", i);
  return { ok:true, files, names, missing };
}

/* 申請 → 成員卡。照片的檔名由 resolvePendingPhotos() 決定,帶**內容雜湊**:
   檔名只由成員 id 決定的話,兩個人同時替同一位換照片就會寫到同一個路徑,而 images/
   的寫入沒有版本鎖 → 後寫的靜默蓋掉先寫的,雙方都不會收到任何錯誤。 */
function applicantToMember(a, memberId, pid, names, warnings){
  const arr = v => (Array.isArray(v) ? v : []).slice(0, INTAKE_LIST_MAX).map(x => str(x)).filter(Boolean);
  return {
    id: memberId, number:"", name: str(a.name, 80), title: str(a.title),
    services: arr(a.services), targets: arr(a.targets), have: arr(a.have),
    want: arr(a.want), tagline: arr(a.tagline),
    image: names.image, card: names.card, products: names.products.slice(),
    company: str(a.company), business_items: str(a.business_items),
    website: str(a.website),
    dataIssue: true,              // 自填資料請組長過目一次,前台會顯示「資料需確認」
    claimedFrom: pid,             // ★ 事後判斷「這張卡是從哪一筆申請來的」的唯一依據
    photoNotes: (warnings && warnings.length) ? warnings.slice() : undefined,
    updatedAt: new Date().toISOString(),
  };
}

async function handleClaim(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const sess = await verifySession(body && body.session, env.SESSION_SECRET);
  if(!sess) return json(env, { ok:false, error:"session_expired" }, 401);
  if(isViewerSession(sess)) return json(env, { ok:false, error:"read_only" }, 403);

  const pid = String(body && body.pid == null ? "" : body.pid);
  if(!MEMBER_ID_RE.test(pid)) return json(env, { ok:false, error:"bad_request" }, 400);

  // 組長只能認領到自己那一組 —— 不看前端送什麼過來
  const role = sessionRole(sess);
  const code = role === "leader" ? String(sess.g || "") : String(body && body.group == null ? "" : body.group);
  if(!/^[A-Za-z0-9]{1,8}$/.test(code)) return json(env, { ok:false, error:"bad_request" }, 400);

  const headers = await ghHeaders(env);
  const dataPath = "data/" + code.toLowerCase() + ".json";
  if(!canWriteDataFile(sess, dataPath)) return json(env, { ok:false, error:"forbidden_path", path:dataPath }, 403);

  const MAX_TRIES = 3;   // 同上:/claim 每輪還要多讀 _index/pending/分組檔
  for(let attempt = 0; ; attempt++){
    /* ★ 先取 head,之後所有讀取都釘在這個快照。代號解析、待認領區、分組檔必須來自
       **同一個 commit** —— 否則會出現「代號檢查在改名前通過、寫入落在改名後」的交錯:
       兩邊都回報成功,但成員卡寫進了正式名錄不會讀取的孤兒檔,而申請已經從待認領區
       消失,等於一筆申請憑空蒸發。 */
    const head = await ghHead(env, headers, env.GH_BRANCH || "main");
    if(!head.ok) return json(env, { ok:false, error:head.error, status:head.status }, 502);
    const REF = head.commitSha;
    const tm = await ghTreeMap(env, headers, head.treeSha);
    if(!tm.ok) return json(env, { ok:false, error:tm.error }, 502);

    const gid = await groupInternalId(env, headers, code, REF);
    if(!gid) return json(env, { ok:false, error:"group_renamed", group:code }, 409);

    const pend = await ghReadFile(env, headers, PENDING_PATH, REF);
    if(!pend.ok) return json(env, { ok:false, error:pend.error, status:pend.status }, 502);
    let list = [];
    if(pend.bytes){
      try{ list = JSON.parse(new TextDecoder().decode(pend.bytes)); }
      catch(e){ return json(env, { ok:false, error:"pending_unreadable" }, 502); }
      if(!Array.isArray(list)) return json(env, { ok:false, error:"pending_unreadable" }, 502);
    }
    const idx = list.findIndex(a => a && a.pid === pid);
    // ★★ 這一行就是重複認領的擋門:別人先認領走了,這裡就找不到了 ★★
    if(idx < 0) return json(env, { ok:false, error:"already_claimed", pid }, 409);

    const grp = await ghReadFile(env, headers, dataPath, REF);
    if(!grp.ok) return json(env, { ok:false, error:grp.error, status:grp.status }, 502);
    if(!grp.bytes) return json(env, { ok:false, error:"group_missing", path:dataPath }, 409);
    let groupBody;
    try{ groupBody = JSON.parse(new TextDecoder().decode(grp.bytes)); }
    catch(e){ return json(env, { ok:false, error:"group_unreadable" }, 502); }
    if(!groupBody || typeof groupBody !== "object" || !Array.isArray(groupBody.members)){
      return json(env, { ok:false, error:"group_unreadable" }, 502);
    }
    // 保險:同一筆申請已經有卡了就不要再建一張(claimedFrom 讓這件事第一次變得可判斷)
    if(groupBody.members.some(m => m && m.claimedFrom === pid)){
      return json(env, { ok:false, error:"already_claimed", pid }, 409);
    }

    const memberId = gid + "_m_" + Date.now().toString(36) + Math.floor(Math.random()*1e5).toString(36);

    /* ★ 照片全部取回並驗證完,才動 Git。失敗的話 pending 記錄與 R2 物件都原封不動,
       可以安全重試 —— 這正是「不得出現 pending 已刪除但成員/圖片沒寫入」的保證來源。 */
    const allowMissing = (body && body.allowMissingImages) === true;
    const ph = await resolvePendingPhotos(env, list[idx], memberId, allowMissing);
    if(!ph.ok){
      return json(env, { ok:false, error:ph.error, field:ph.field, fields:ph.fields, reason:ph.reason }, 409);
    }
    const warnings = (ph.missing || []).map(f => ({ field:f, reason:"missing_at_claim" }))
      .concat(Array.isArray(list[idx].photoWarnings) ? list[idx].photoWarnings : []);
    /* 這一筆申請在 R2 佔用的 key。只有 Git ref 更新成功之後才拿它去刪。 */
    const usedKeys = [];
    const prRefs = list[idx].photoRefs;
    if(prRefs && typeof prRefs === "object"){
      for(const r of [prRefs.image, prRefs.card].concat(Array.isArray(prRefs.products) ? prRefs.products : [])){
        if(r && typeof r.key === "string") usedKeys.push(r.key);
      }
    }

    const files = ph.files.slice();
    const member = applicantToMember(list[idx], memberId, pid, ph.names, warnings);
    groupBody.members.push(member);
    list.splice(idx, 1);

    const enc = new TextEncoder();
    files.push({ path: dataPath,     contentB64: bytesToB64(enc.encode(JSON.stringify(groupBody, null, 2) + "\n")) });
    files.push({ path: PENDING_PATH, contentB64: bytesToB64(enc.encode(JSON.stringify(list, null, 2) + "\n")) });

    /* 版本基準用剛才那棵 tree 裡的 blob sha —— 與我們讀到的內容來自同一個快照,
       而且不必再為了比對多讀一次檔案(子請求預算很緊,見 ghTreeMap 的說明)。 */
    const baseBlobShas = {};
    if(tm.map.has(dataPath)) baseBlobShas[dataPath] = tm.map.get(dataPath);
    if(tm.map.has(PENDING_PATH)) baseBlobShas[PENDING_PATH] = tm.map.get(PENDING_PATH);

    const who = String(sess.u || "").slice(0, 32);
    const r = await commitWithVersionCheck(env, headers, {
      files, remove: [], baseHashes:{}, baseBlobShas, assetPaths: files.filter(f => !f.path.startsWith("data/")).map(f => f.path), sess,
      message: "認領新夥伴：" + (member.name || "") + "（" + code.toUpperCase() + "・" + who + "）",
    });
    if(r.ok){
      /* ★ Git ref 已經更新成功,現在才刪 R2。順序反過來的話,commit 失敗就會留下
         「照片沒了、申請還在待認領區」的狀態,之後永遠認領不出照片。
         刪除失敗**不回滾**(commit 是對的,網站資料正確),留下的孤兒由 bucket 的
         lifecycle rule 在 30 天內清掉。 */
      const left = await deletePendingImages(env, usedKeys);
      return json(env, { ok:true, memberId, group:code, pending:list.length, commit:r.commitSha,
                         warnings, orphanKeys: left.length || undefined });
    }
    /* 別人在我們讀完之後動過待認領區或這一組 → 重讀重試。
       重讀之後那筆很可能已經不在了,於是回到上面的 already_claimed —— 這正是我們要的
       結果:訊息明確,而且他那組完全沒有被寫入。 */
    const e = r.body && r.body.error;
    if((e === "stale_base" || e === "busy_retry_later") && attempt < MAX_TRIES - 1) continue;
    return json(env, r.body, r.status);
  }
}

async function handlePublish(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const { session, content, files } = body || {};
  const sess = await verifySession(session, env.SESSION_SECRET);
  if(!sess) return json(env, { ok:false, error:"session_expired" }, 401);

  /* ★ 唯讀帳號的總開關 ★
     擋在最前面,連一個位元組都不看。這道很重要:下面的逐檔權限檢查只管 data/ 開頭的,
     images/ 是走 FILE_PATH_RE 那條、不經過 canWriteDataFile —— 只擋 data/ 的話,
     唯讀帳號仍然可以往 repo 塞圖片。前端把按鈕藏起來不算數,真正的界線在這一行。 */
  if(isViewerSession(sess)) return json(env, { ok:false, error:"read_only" }, 403);

  // 誰發布的:記進 commit 訊息。帳號在登入時已過 USERNAME_RE(無空白/控制字元)且長度受限,
  // 這裡再截一次長度,確保任何情況下都不會把奇怪的東西寫進 git 歷史。
  const who = String(sess.u || "").slice(0, 32);
  const grp = String(sess.g || "").slice(0, 8);
  const by = who ? "（" + who + (grp ? "・" + grp : "") + "）" : "";

  /* data.js 現在是由 GitHub Action 從 data/*.json 合併產生的產出物,沒有人該直接寫它。
     舊版編輯頁(還開著沒重新整理的分頁)會送 content;明確擋下並請他重新整理,
     否則那份整檔內容會蓋掉分組檔剛發布的結果。 */
  if(typeof content === "string" && content.length > 0){
    return json(env, { ok:false, error:"content_not_accepted" }, 409);
  }
  const fileList = Array.isArray(files) ? files : [];
  if(fileList.length === 0) return json(env, { ok:false, error:"empty_content" }, 400);

  // 附件驗證：數量、路徑白名單、寫入權限、base64 合法性
  // ——先全部驗完才動 GitHub，避免寫到一半才發現壞資料或越權
  if(fileList.length > MAX_FILES_PER_REQUEST) return json(env, { ok:false, error:"too_many_files", max:MAX_FILES_PER_REQUEST }, 413);
  for(const f of fileList){
    if(!f || typeof f.path !== "string" || f.path.includes("..")){
      return json(env, { ok:false, error:"bad_file_path", path: f && f.path }, 400);
    }
    const isData = f.path.startsWith("data/");
    if(isData){
      // ★ 真正的權限檢查:組長送出別組的檔案會在這裡被擋下,前端怎麼改都沒用 ★
      if(!canWriteDataFile(sess, f.path)){
        return json(env, { ok:false, error:"forbidden_path", path: f.path, role: sess.r || "owner", group: sess.g || "" }, 403);
      }
      if(!isPlausibleB64(f.contentB64, MAX_DATA_B64_CHARS)){
        return json(env, { ok:false, error:"bad_file_content", path: f.path }, 400);
      }
      let text;
      try{
        const raw = b64ToBytes(f.contentB64);
        if(raw.length > MAX_DATA_BYTES){
          return json(env, { ok:false, error:"data_file_too_large", path:f.path, size:raw.length, max:MAX_DATA_BYTES }, 413);
        }
        text = new TextDecoder("utf-8", { fatal:true }).decode(raw);
      }catch(e){ return json(env, { ok:false, error:"bad_file_content", path: f.path }, 400); }
      const why = checkDataFileBody(f.path, text);
      if(why) return json(env, { ok:false, error:"bad_data_file", path: f.path, reason: why }, 400);
    } else {
      if(!FILE_PATH_RE.test(f.path)) return json(env, { ok:false, error:"bad_file_path", path: f.path }, 400);
      if(!isPlausibleB64(f.contentB64)) return json(env, { ok:false, error:"bad_file_content", path: f.path }, 400);
    }
  }

  const headers = await ghHeaders(env);

  /* ★ 跨組保護:images/ 附件的授權 ★
     data/ 檔的跨組隔離靠 canWriteDataFile,但 images/ 走 FILE_PATH_RE、不經過那裡——
     只擋 viewer 的話,任一組長都能發一張 images/<別組成員檔名>.jpg 覆寫別組成員的照片
     (檔名全寫在公開的 data.js 裡,不必猜)。所以組長送 images/ 附件時,要求檔名前綴等於
     自己那組的內部 id;owner 不受限。內部 id 由 _index.json 解析,讀不到就 fail-closed
     (寧可這次發不出去、要求重試,也不要放行一次可能的越權覆寫)。 */
  /* images/ 附件的跨組授權檢查已經移進 commitWithVersionCheck —— 它必須與版本比對用
     **同一個 commit 快照**來解析 _index,否則會出現「授權在改名前通過、寫入落在改名後」
     的交錯。留在這裡的話,那個檢查讀的是移動中的 main。 */

  const baseHashes = (body && typeof body.baseHashes === "object" && body.baseHashes) || {};
  const removePaths = sanitizeRemovals(body && body.remove, sess);
  if(removePaths.error) return json(env, { ok:false, error:removePaths.error, path:removePaths.path }, 403);

  const label = describeFiles(fileList);
  const r = await commitWithVersionCheck(env, headers, {
    files: fileList, remove: removePaths.list, baseHashes, sess,
    baseBlobShas: (body && typeof body.baseBlobShas === "object" && body.baseBlobShas) || {},
    assetPaths: fileList.filter(f => !f.path.startsWith("data/")).map(f => f.path),
    message: "更新會員名錄・" + label + by,
  });
  if(!r.ok) return json(env, r.body, r.status);
  return json(env, { ok:true, filesWritten: fileList.length, newHashes: r.newHashes,
                     newBlobShas: r.newBlobShas, commit: r.commitSha });
}

/* 這次發布動到什麼,寫進 commit 訊息 */
function describeFiles(fileList){
  const names = fileList.filter(f => f.path.startsWith("data/")).map(f =>
    f.path === "data/_index.json" ? "分會結構"
    : f.path === PENDING_PATH ? "待認領區"
    : f.path.replace(/^data\/|\.json$/g, "").toUpperCase() + " 組");
  if(!names.length) return "照片";
  return names.slice(0, 3).join("、") + (names.length > 3 ? ` 等 ${names.length} 項` : "");
}

/* 改名分組時要刪掉舊檔。刪除與新增必須在同一個 commit 裡,否則中間狀態會讓
   build-data.mjs 找不到 _index 列出的檔而整條產線失敗。 */
function sanitizeRemovals(raw, sess){
  const list = [];
  if(!Array.isArray(raw)) return { list };
  for(const p of raw){
    if(typeof p !== "string" || !DATA_PATH_RE.test(p)) return { error:"bad_file_path", path:p };
    if(!canWriteDataFile(sess, p)) return { error:"forbidden_path", path:p };
    if(p === "data/_index.json" || p === PENDING_PATH) return { error:"forbidden_path", path:p };
    list.push(p);
  }
  return { list };
}

/* 版本比對。回傳 null = 通過,否則回傳可以直接送出去的錯誤物件。 */
async function verifyVersions(env, headers, o){
  const { files, remove, baseHashes, baseBlobShas, treeMap, ref } = o;
  const blobs = (baseBlobShas && typeof baseBlobShas === "object") ? baseBlobShas : {};

  const cmp = async (path, isRemoval) => {
    const cur = treeMap.get(path);                 // undefined = 這個快照裡沒有這個檔
    const wantBlob = blobs[path];
    const wantHash = baseHashes[path];
    const hasBase = (typeof wantBlob === "string" && wantBlob) || (typeof wantHash === "string" && wantHash);

    if(!hasBase){
      /* 沒有版本基準:新增檔案 → create-only;刪除檔案 → 一律拒絕(等於盲刪) */
      if(isRemoval) return { ok:false, status:400, body:{ ok:false, error:"remove_without_base", path } };
      if(cur) return { ok:false, status:409, body:{ ok:false, error:"already_exists", path } };
      return null;
    }
    /* ★ 有版本基準、但檔案已經不在了 = 別人在這期間刪掉或改名了它。
       原本這種情況會被當成「檔案不存在」而**重新建立** —— 等於把別人剛刪掉的檔案復活;
       在改名場景下就是把資料寫回一個沒有人會讀的孤兒檔,而且雙方都收到成功。 */
    if(!cur) return { ok:false, status:409, body:{ ok:false, error:"stale_base", reason:"file_deleted", path } };

    if(typeof wantBlob === "string" && wantBlob){
      if(wantBlob !== cur){
        return { ok:false, status:409, body:{ ok:false, error:"stale_base", path, currentBlob:cur } };
      }
      return null;
    }
    // 舊版前端只送 sha256:得把檔案讀回來算一次(釘在同一個快照上)
    const r = await ghReadFile(env, headers, path, ref);
    if(!r.ok || r.bytes === null) return { ok:false, status:503, body:{ ok:false, error:"version_check_failed", path } };
    const h = await sha256Hex(r.bytes);
    if(h !== wantHash) return { ok:false, status:409, body:{ ok:false, error:"stale_base", path, currentHash:h } };
    return null;
  };

  for(const f of files){
    if(!f.path.startsWith("data/")) continue;
    const bad = await cmp(f.path, false);
    if(bad) return bad;
  }
  for(const p of (remove || [])){
    const bad = await cmp(p, true);
    if(bad) return bad;
  }
  return null;
}

/* 提交之後,_index 列到的每個代號都必須有對應的分組檔存在。 */
async function checkIndexInvariant(env, headers, o){
  const { files, remove, treeMap, ref } = o;
  const idxFile = files.find(f => f.path === "data/_index.json");
  const removals = new Set(remove || []);
  const touchesGroups = removals.size > 0 || files.some(f => /^data\/[a-z0-9]{1,8}\.json$/.test(f.path));
  if(!idxFile && !touchesGroups) return null;      // 這次提交碰不到這個不變式

  let idxText;
  if(idxFile){
    try{ idxText = new TextDecoder().decode(b64ToBytes(idxFile.contentB64)); }
    catch(e){ return { ok:false, status:400, body:{ ok:false, error:"bad_file_content", path:"data/_index.json" } }; }
  } else {
    const r = await ghReadFile(env, headers, "data/_index.json", ref);
    if(!r.ok || r.bytes === null){
      return { ok:false, status:503, body:{ ok:false, error:"version_check_failed", path:"data/_index.json" } };
    }
    idxText = new TextDecoder().decode(r.bytes);
  }
  let idx;
  try{ idx = JSON.parse(idxText); }
  catch(e){ return { ok:false, status:400, body:{ ok:false, error:"bad_data_file", path:"data/_index.json", reason:"index_not_json" } }; }
  if(!Array.isArray(idx)){
    return { ok:false, status:400, body:{ ok:false, error:"bad_data_file", path:"data/_index.json", reason:"index_not_array" } };
  }

  const after = new Set(treeMap.keys());           // 提交之後會存在的檔案
  for(const p of removals) after.delete(p);
  for(const f of files) after.add(f.path);

  for(const e of idx){
    const code = e && typeof e.code === "string" ? e.code.trim().toLowerCase() : "";
    if(!code) continue;
    const p = "data/" + code + ".json";
    if(!after.has(p)){
      return { ok:false, status:409, body:{ ok:false, error:"index_missing_group", code:(e && e.code) || "", path:p } };
    }
  }
  return null;
}

/* 逐檔版本比對 + 單一 commit 寫入,ref 被搶就重讀重試。
   回傳 { ok:true, newHashes, commitSha } 或 { ok:false, body, status }。 */
async function commitWithVersionCheck(env, headers, opts){
  const { files, remove, baseHashes, sess, message } = opts;
  const branch = env.GH_BRANCH || "main";
  const MAX_TRIES = 3;   // 子請求預算:N 個 blob(一次)+ 每次重試 6 個,見 MAX_FILES_PER_REQUEST

  const { baseBlobShas, assetPaths } = opts;
  /* 先把所有 blob 建好(一次就好,重試不必重來,見 ghCreateBlobs) */
  const made = await ghCreateBlobs(env, headers, files);
  if(!made.ok) return { ok:false, status:502, body:{ ok:false, error:made.error, status:made.status } };

  for(let attempt = 0; ; attempt++){
    /* ★★ 順序很重要:先取 head,之後**所有**讀取都釘在 head.commitSha 這個快照上 ★★
       原本 groupInternalId() 跑在 ghHead() 之前,讀的是移動中的 main。於是會出現:
       組長的代號檢查在「改名前」通過、而 commit 建在「改名後」的 head 上 —— 兩邊都
       回報成功,但成員卡寫進了正式名錄不會讀取的孤兒檔,而申請已經從待認領區消失。 */
    const head = await ghHead(env, headers, branch);
    if(!head.ok) return { ok:false, status:502, body:{ ok:false, error:head.error, status:head.status } };
    const REF = head.commitSha;

    const tm = await ghTreeMap(env, headers, head.treeSha);
    if(!tm.ok) return { ok:false, status:502, body:{ ok:false, error:tm.error, status:tm.status } };
    const treeMap = tm.map;

    /* 組長的分組代號是否仍在 _index 裡（用同一個快照讀）。 */
    if(sessionRole(sess) === "leader" && (files.some(f => f.path.startsWith("data/")) || (remove||[]).length)){
      const gid = await groupInternalId(env, headers, sess.g, REF);
      if(!gid) return { ok:false, status:409, body:{ ok:false, error:"group_renamed", group: sess.g || "" } };
      // images/ 附件的跨組授權也要用同一個快照,理由同上
      for(const p of (assetPaths || [])){
        if(!p.startsWith("images/" + gid + "_")){
          return { ok:false, status:403, body:{ ok:false, error:"forbidden_asset", path:p, group: sess.g || "" } };
        }
      }
    }

    /* 版本比對。優先用 git blob sha(前端從 /read 拿到的),那樣整批只需要上面那一次
       recursive tree,不必逐檔再讀一遍。舊版前端只送 sha256 時才退回逐檔讀取。 */
    const conflict = await verifyVersions(env, headers, { files, remove, baseHashes, baseBlobShas, treeMap, ref:REF });
    if(conflict) return conflict;

    /* ★ F21:_index 列到的每一組,提交之後都必須有對應的分組檔。
       原本這個不變式只活在前端的送出順序裡,伺服器端完全沒有守 —— 直接呼叫 /publish
       送一份列出 X 的 _index,就能建出一個**永久無效**的 commit:之後 build-data.mjs
       每次都 throw,整條產線停住,而前台凍結在舊版且沒有任何告警。 */
    const bad = await checkIndexInvariant(env, headers, { files, remove, treeMap, ref:REF });
    if(bad) return bad;

    const payload = files.map(f => ({ path:f.path, contentB64:f.contentB64 }))
                         .concat((remove || []).map(p => ({ path:p, remove:true })));
    const res = await ghCommitFiles(env, headers, branch, payload, message, head.commitSha, head.treeSha, made.blobShas);
    if(res.ok){
      const newHashes = {};
      for(const f of files){
        if(f.path.startsWith("data/")) newHashes[f.path] = await sha256Hex(b64ToBytes(f.contentB64));
      }
      /* 一併回傳新的 blob sha:下一次發布的版本基準要用它。
         少了這個,前端的 baseBlobShas 會停在發布前的值,而 repo 已經是新的 —— 下一次
         發布會被自己剛寫進去的內容判成版本落後(而且訊息還說是別人改的)。 */
      return { ok:true, newHashes, newBlobShas: made.blobShas, commitSha: res.commitSha };
    }
    /* ref 在我們讀 head 之後被別人推進了。這一次的 commit 完全沒有生效(ref 沒動),
       所以重讀重試是安全的 —— 重試時會重新比對各檔雜湊,真的有人改到同一個檔就會
       在上面被判 stale_base。 */
    if(res.error === "ref_moved" && attempt < MAX_TRIES - 1) continue;
    if(res.error === "ref_moved"){
      return { ok:false, status:409, body:{ ok:false, error:"busy_retry_later" } };
    }
    return { ok:false, status:502, body:{ ok:false, error:res.error, status:res.status } };
  }
}

/* ══ 來賓報名(公開、免密碼)══════════════════════════════════════════════
   visitor.html 上的內嵌表單送到這裡,由 Worker 轉送到 Google 表單的
   formResponse 端點,資料照樣進原本那張表單與來賓 CRM。

   為什麼要繞這一手,而不是讓瀏覽器直接打 Google:
   跨網域的關係,瀏覽器**讀不到** Google 的回應 —— 送失敗時來賓看到的仍然是
   「報名成功」,單子掉了沒有人會知道。走 Worker 就拿得到 Google 真正的 HTTP
   狀態,失敗能請來賓重試。順便,這裡有 IP 限流與 honeypot,擋掉把 CRM 灌爆的
   機器人(自己刻的表單等於繞過了 Google 表單頁面本身的防護)。

   ★ 下面兩個設定要跟線上那張表單對得起來 ★
   entry 編號是 Google 給每一題的 id,改題目重建時會變。到 Apps Script 執行
   printVisitorFormEntryIds() 會把整段印出來,直接貼過來取代即可;
   之後可以用 checkVisitorEntryIds() 確認有沒有跑掉。
   兩者都不是機密(任何人在表單原始碼裡都看得到),放在這裡沒有安全問題。
   留空 = 這個功能沒開,前台會自動退回「開新分頁到 Google 表單」的舊行為。 */
const VISITOR_FORM_ID = "1FAIpQLScOoqaeS9M3Tq-vaaI6ic3bR1nIvnquSptsgtLiFd8a9EPIDg";
const VISITOR_ENTRY = {            // 欄位 → entry 編號
  name: "entry.1128131260", phone: "entry.1708639339", line: "entry.1952852401",
  job: "entry.1596298967", referrer: "entry.798820908",
};
const VISITOR_TEXT_MAX = 100;
const VISITOR_MAX_PER_WINDOW = 8;  // 同一 IP 在節流窗內最多報名幾次

function visitorConfigured(){
  return !!(VISITOR_FORM_ID && VISITOR_ENTRY.name && VISITOR_ENTRY.phone &&
            VISITOR_ENTRY.line && VISITOR_ENTRY.job);
}

async function handleVisitor(request, env){
  if(!visitorConfigured()) return json(env, { ok:false, error:"visitor_not_configured" }, 503);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let count = 0;
  try{
    requireKV(env);
    const raw = await env.RATE_LIMIT.get("visitor:" + ip);
    const d = raw ? JSON.parse(raw) : null;
    if(d && Date.now() - d.windowStart <= FAIL_WINDOW_SECONDS*1000){
      if(d.count >= VISITOR_MAX_PER_WINDOW) return json(env, { ok:false, error:"too_many_submissions" }, 429);
      count = d.count;
    }
  }catch(e){
    if(e && e.code === "rate_limit_kv_missing") return json(env, { ok:false, error:"rate_limit_unavailable" }, 500);
  }

  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  body = body && typeof body === "object" ? body : {};

  /* honeypot:畫面上看不到的欄位,只有機器人會填。填了就當成功回覆但不真的送出 ——
     直接回錯誤等於告訴對方「這裡有陷阱」,換個寫法再來就是了。 */
  if(String(body.website == null ? "" : body.website).trim()){
    return json(env, { ok:true, skipped:true });
  }

  /* 沿用 intake 那支 str():剝掉控制字元、截長度。再把換行/tab 收成單一空白 ——
     這幾欄都是單行,但字內的空白與連字號要保留(「陳 大文」「0912-345-678」不能被改掉)。 */
  const t = v => str(v, VISITOR_TEXT_MAX).replace(/\s+/g, " ").trim();
  const fields = { name:t(body.name), phone:t(body.phone), line:t(body.line), job:t(body.job), referrer:t(body.referrer) };
  for(const k of ["name","phone","line","job"]){
    if(!fields[k]) return json(env, { ok:false, error:"missing_field", field:k }, 400);
  }

  try{ await env.RATE_LIMIT.put("visitor:" + ip, JSON.stringify({ count: count+1, windowStart: Date.now() }), { expirationTtl: FAIL_WINDOW_SECONDS }); }catch(e){}

  const form = new URLSearchParams();
  for(const k of ["name","phone","line","job","referrer"]){
    if(VISITOR_ENTRY[k] && fields[k]) form.set(VISITOR_ENTRY[k], fields[k]);
  }
  const url = "https://docs.google.com/forms/d/e/" + encodeURIComponent(VISITOR_FORM_ID) + "/formResponse";
  try{
    const r = await fetchWithTimeout(url, {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" },
      body: form.toString(),
    }, GITHUB_TIMEOUT_MS);
    /* Google 收下會回 200(確認頁)。400 幾乎都是 entry 編號對不上或必填沒帶到 ——
       那是設定問題,不是來賓的錯,所以回一個看得出來的錯誤碼而不是含糊的失敗。 */
    if(r.status === 400) return json(env, { ok:false, error:"form_rejected" }, 502);
    if(!r.ok) return json(env, { ok:false, error:"form_unreachable", status:r.status }, 502);
    return json(env, { ok:true });
  }catch(e){
    return json(env, { ok:false, error: e && e.name === "AbortError" ? "form_timeout" : "form_unreachable" }, 502);
  }
}

/* 公開的訪客瀏覽計數：不需要密碼、不佔登入錯誤額度。
   scope="site" 累計全站；scope="member"&id=<成員id> 累計單一成員頁，回傳遞增後的數字。
   讀-改-寫非原子（Workers KV 特性），對這種展示用計數可接受；偶爾平行存取可能少算一兩次。

   ★ 一定要用獨立的 VIEWS 命名空間，沒綁就不計數 ★
   原本沒綁 VIEWS 時會退回用 RATE_LIMIT —— 也就是防暴力破解那一個。這條路很危險：
   這個端點是公開的、免密碼、不限流，而且**每一次呼叫都寫一次 KV**；前台每個訪客
   開名錄就會打一次。免費方案每天 1000 次寫入用完之後，登入那條路的 KV 寫入也會
   一起失敗，全會（包含總管理員）都登不進後台。任何人用 curl 跑個迴圈就做得到。
   一個「展示用的計數器」不該和「登入」共用同一個失敗範圍，所以這裡不再退而求其次：
   沒綁 VIEWS 就回 views_disabled，前端會安靜地不顯示計數（app.js 本來就這樣處理）。 */
const VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
async function handleViews(request, env){
  const kv = env.VIEWS;
  if(!kv || typeof kv.get !== "function" || typeof kv.put !== "function"){
    return json(env, { ok:false, error:"views_disabled" }, 200);   // 前端會安靜地不顯示計數，不讓頁面出錯
  }
  let body; try{ body = await request.json(); }catch(e){ body = {}; }
  const scope = body && body.scope;
  let key;
  if(scope === "site"){
    key = "views:site";
  } else if(scope === "member" && VIEW_ID_RE.test((body && body.id) || "")){
    key = "views:member:" + body.id;
  } else {
    return json(env, { ok:false, error:"bad_scope" }, 400);
  }
  let n = null;
  let viewsReadOk = false;
  try{
    const raw = await kv.get(key);
    viewsReadOk = true;                       // 讀到了(不論有沒有值);null 代表「這個 key 還不存在」
    if(raw != null) n = parseInt(raw, 10) || 0;
  }catch(e){ /* VIEWS 讀取失敗:見下方,絕不接手、也絕不覆寫 */ }

  /* VIEWS 這次讀不到目前的值(KV 暫時性抖動)就別寫回去。若硬要往下走,會用一個過時的數字
     覆蓋掉較新的儲存值 —— 接手分支會拿 RATE_LIMIT 的舊值、否則退回 0,兩者都會讓前台
     計數倒退(例如已接手到 620,抖一下就被寫成 501 或 1)。這是展示用計數器,這一次不計數
     即可,前端拿到非 ok 會靜默隱藏該格,下一次讀成功就恢復。 */
  if(!viewsReadOk){
    return json(env, { ok:false, error:"views_unavailable" }, 200);
  }

  /* 一次性接手舊數字:VIEWS 是新命名空間,綁上去的那一刻裡面是空的,計數會從 0 重來。
     舊值還躺在 RATE_LIMIT 裡(當年沒綁 VIEWS 時寫進去的,沒設過期時間),key 名稱兩邊
     完全一樣,所以第一次遇到某個 key 就去那裡撈一次,撈到就從那個數字接著加。
     全站總數與 93 位成員各自的數字都會自動接回來,不必手動一筆一筆抄。

     只有在「VIEWS 讀取成功、且確定沒有這個 key(n 仍為 null)」時才接手 —— 讀取例外已在上面
     擋掉,不會誤觸接手把較新值蓋掉。這條路只「讀」RATE_LIMIT,不寫 —— 上面那段在意的是寫入
     額度,讀取不佔額度,失敗範圍仍分開。每個 key 也只會走這一次:接手後 VIEWS 就有值了。 */
  if(n === null){
    const old = env.RATE_LIMIT;
    if(old && typeof old.get === "function" && old !== kv){
      try{
        const raw = await old.get(key);
        if(raw != null) n = parseInt(raw, 10) || 0;
      }catch(e){ /* 舊命名空間讀不到就從 0 起算 */ }
    }
  }
  if(n === null || !(n >= 0)) n = 0;

  n += 1;
  try{ await kv.put(key, String(n)); }
  catch(e){ return json(env, { ok:false, error:"write_failed", count:n }, 200); }
  return json(env, { ok:true, count:n });
}

export default {
  async fetch(request, env){
    // 沒設定 ALLOWED_ORIGIN 就直接回報錯誤，而不是悄悄用空字串「剛好」擋掉跨網域請求——
    // 避免未來改動不小心讓這個隱性行為失效卻沒人發現。
    // 錯誤回應（含 OPTIONS 預檢）刻意用 "*"，任何來源的瀏覽器都能讀到錯誤碼（內容無機密）：
    // 部署的管理員才能在編輯頁上直接看到「服務尚未設定完成」，而不是一個看不懂的網路錯誤。
    // 此狀態下所有實際請求一律回 500，不會執行登入/發布，故放寬 CORS 不影響安全。
    if(!env.ALLOWED_ORIGIN){
      const openCors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      if(request.method === "OPTIONS") return new Response(null, { status:204, headers: openCors });
      return new Response(JSON.stringify({ ok:false, error:"misconfigured_missing_allowed_origin" }), {
        status: 500, headers: Object.assign({ "Content-Type":"application/json" }, openCors),
      });
    }
    if(request.method === "OPTIONS") return new Response(null, { status:204, headers: corsHeaders(env) });
    if(request.method !== "POST") return json(env, { ok:false, error:"method_not_allowed" }, 405);

    /* ALLOWED_ORIGIN 原本只被寫進「回應」的 CORS 標頭 —— 那只能阻止瀏覽器**讀取回應**,
       擋不住請求送達。simple request(Content-Type: text/plain)連預檢都不會發,
       所以任何網站都能拿訪客的瀏覽器連打 /login:五次錯誤之後,那位訪客的 IP 就被鎖
       15 分鐘。共用同一條對外 IP 的辦公室裡,這代表整間公司都登不進後台。

       這裡擋的正是這條路:**有帶 Origin 就必須相符**。只有瀏覽器會自動帶 Origin,
       而這個攻擊的前提就是借用別人的瀏覽器。沒帶 Origin 的請求(curl、伺服器對伺服器)
       維持放行 —— 那種攻擊者用的是自己的 IP,鎖到的也只有自己,而 Apps Script 送來的
       /intake 本來就沒有 Origin,擋掉會把新夥伴表單一起弄壞。 */
    const origin = request.headers.get("Origin");
    if(origin && origin !== env.ALLOWED_ORIGIN){
      return json(env, { ok:false, error:"bad_origin" }, 403);
    }

    const { pathname } = new URL(request.url);
    /* 沒有這層 try/catch 的話,任何一個沒預期到的例外都會變成 Workers 執行階段的裸錯誤:
       沒有 CORS 標頭 → 瀏覽器只看得到一個網路錯誤 → 編輯頁顯示「連不到發布服務」,
       於是人去查網址、查有沒有部署,查不到真正的原因。回一個帶 CORS 的 JSON,
       至少畫面上會出現看得懂的訊息。 */
    try{
      if(pathname === "/ping") return await handlePing(request, env);
      if(pathname === "/login") return await handleLogin(request, env);
      if(pathname === "/publish") return await handlePublish(request, env);
      if(pathname === "/read") return await handleRead(request, env);
      if(pathname === "/claim") return await handleClaim(request, env);
      if(pathname === "/migrate-pending") return await handleMigratePending(request, env);
      if(pathname === "/intake") return await handleIntake(request, env);
      if(pathname === "/health") return await handleHealth(request, env);
      if(pathname === "/views") return await handleViews(request, env);
      if(pathname === "/visitor") return await handleVisitor(request, env);
      return json(env, { ok:false, error:"not_found" }, 404);
    }catch(e){
      return json(env, { ok:false, error:"server_error" }, 500);
    }
  },
};
