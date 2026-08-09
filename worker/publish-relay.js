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
const MAX_FILES_PER_REQUEST = 25;               // 單次發布的附件上限（編輯頁會自動分批）
const MAX_FILE_B64_CHARS = 3 * 1024 * 1024;     // 單一附件 base64 上限（約 2.2MB 原始檔）
/* 只有 images/ 的圖片。m/ 的成員分享頁是 Action 產生的產出物,沒有人該從瀏覽器直接寫——
   而它與編輯頁同源,能寫任意 .html 就等於能在站上放一頁自己的 JavaScript 去偷別人的登入
   憑證。既然前端根本不會送,就不留這個能力。 */
const FILE_PATH_RE = /^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|jpeg|png|webp)$/;
/* 分組資料檔:data/_index.json(分會結構)與 data/<代號小寫>.json(各組內容)。
   ★ 這條路徑規則就是權限本身:組長只被允許寫自己那一組的檔案,見 canWriteDataFile() ★ */
const DATA_PATH_RE = /^data\/(_index|_pending|[a-z0-9]{1,8})\.json$/;
const MAX_DATA_B64_CHARS = 4 * 1024 * 1024;   // 單一分組檔 base64 上限(約 3MB 原始,含內嵌照片綽綽有餘)
const PENDING_PATH = "data/_pending.json";

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
/* 現行檔案內容的 SHA-256。讀不到(檔案不存在、網路問題)回傳 null＝跳過比對:
   寧可放行,也不要因為一次讀取失敗就擋住所有人發布。 */
/* 現行版本:內容的 SHA-256(拿來跟草稿的來源版本比對)+ GitHub 的 blob sha
   (寫入時要原封不動帶回去,那是 GitHub contents API 的樂觀鎖)。
   兩個值必須來自**同一次讀取** —— 分開讀就等於在檢查與寫入之間開了一個窗口。
   讀不到(檔案不存在、網路問題)回 null;檔案不存在時回 { hash:null, sha:null }。 */
async function currentFileState(env, headers, path){
  try{
    const url = contentsUrlFor(env, path) + "?ref=" + encodeURIComponent(env.GH_BRANCH || "main");
    const r = await fetchWithTimeout(url, { headers }, GITHUB_TIMEOUT_MS);
    if(r.status === 404) return { hash:null, sha:null };   // 還沒有這個檔,不是錯誤
    if(!r.ok) return null;
    const d = await r.json();
    if(!d || typeof d.content !== "string") return null;
    return { hash: await sha256Hex(b64ToBytes(d.content)), sha: typeof d.sha === "string" ? d.sha : null };
  }catch(e){ return null; }
}

/* 組長分組代號(session.g,如 "A1")→ 分組內部 id(如 "g3")。
   照片檔名是 fileSafeId(成員id)+後綴,而成員 id 一律以「分組內部 id + _m…」開頭
   (uid(g.id+"_m")),成員也不會跨組搬動(moveMember 只在組內換位),所以某組所有照片的
   檔名都以該組內部 id 為前綴。用它來判斷組長能不能寫某張 images/ 附件。
   對應關係只存在 data/_index.json,這裡讀一次;讀不到或查無此代號回 null,呼叫端 fail-closed。 */
async function groupInternalId(env, headers, code){
  const want = String(code == null ? "" : code).trim().toLowerCase();
  if(!want) return null;
  try{
    const url = contentsUrlFor(env, "data/_index.json") + "?ref=" + encodeURIComponent(env.GH_BRANCH || "main");
    const r = await fetchWithTimeout(url, { headers }, GITHUB_TIMEOUT_MS);
    if(!r.ok) return null;
    const d = await r.json();
    if(!d || typeof d.content !== "string") return null;
    const idx = JSON.parse(new TextDecoder().decode(b64ToBytes(d.content)));
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
  return json(env, { ok:true, service:"member-directory-relay", caps:{ files:true, visitor: visitorConfigured() } });
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
const MAX_PENDING = 50;                       // 待認領區的上限,擋住表單被灌爆
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
const INTAKE_IMG_B64_MAX = 700 * 1024;   // 單張照片 base64(約 500KB 原始)
const INTAKE_TOTAL_B64_MAX = 3 * 1024 * 1024;  // 一份申請所有照片加總
const INTAKE_MAX_PER_WINDOW = 20;     // 同一 IP 在節流窗內最多送幾份
const DATA_IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max || INTAKE_TEXT_MAX);
const list = v => (Array.isArray(v) ? v : String(v == null ? "" : v).split("\n"))
  .map(x => str(x)).filter(Boolean).slice(0, INTAKE_LIST_MAX);

/* 把表單送來的東西整理成一筆乾淨的申請;不合格的照片直接丟掉而不是整筆退回,
   一張照片太大不該讓整份申請消失。回傳 null 代表連姓名都沒有,那才是真的不收。 */
function sanitizeApplicant(raw, pid){
  if(!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = str(raw.name, 80);
  if(!name) return null;
  let budget = INTAKE_TOTAL_B64_MAX;
  const img = v => {
    const s = String(v == null ? "" : v);
    if(!DATA_IMG_RE.test(s) || s.length > INTAKE_IMG_B64_MAX || s.length > budget) return "";
    budget -= s.length;
    return s;
  };
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
    image: img(raw.image),
    card: img(raw.card),
    products: (Array.isArray(raw.products) ? raw.products : []).map(img).filter(Boolean).slice(0, 5),
  };
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

  // pid 由這裡產生,不讓外面決定——它之後會出現在檔名與 DOM 屬性裡
  const pid = "p_" + Date.now().toString(36) + Math.floor(Math.random()*1e6).toString(36);
  const applicant = sanitizeApplicant(body && body.applicant, pid);
  if(!applicant) return json(env, { ok:false, error:"bad_applicant" }, 400);

  const headers = await ghHeaders(env);

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
    try{
      const url = contentsUrlFor(env, PENDING_PATH) + "?ref=" + encodeURIComponent(env.GH_BRANCH || "main");
      const r = await fetchWithTimeout(url, { headers }, GITHUB_TIMEOUT_MS);
      if(r.ok){
        const d = await r.json();
        const parsed = JSON.parse(new TextDecoder().decode(b64ToBytes(d.content)));
        if(Array.isArray(parsed)) current = parsed;
        sha = typeof d.sha === "string" ? d.sha : null;   // ★ 留住 sha 當樂觀鎖,別像以前丟掉
      } else if(r.status === 401 || r.status === 403){
        return json(env, { ok:false, error:"token_forbidden" }, 502);
      } else if(r.status !== 404){
        return json(env, { ok:false, error:"github_read_failed", status:r.status }, 502);
      }
      // 404 = 還沒有這個檔,current 空、sha null(寫入時不帶 sha = 建立新檔)
    }catch(e){
      return json(env, { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" }, 502);
    }
    if(current.length >= MAX_PENDING) return json(env, { ok:false, error:"pending_full", max:MAX_PENDING }, 409);

    const next = current.concat([applicant]);
    const bytes = new TextEncoder().encode(JSON.stringify(next, null, 2) + "\n");
    const res = await ghPutFile(env, headers, PENDING_PATH, bytesToB64(bytes),
                                "新夥伴申請待認領：" + applicant.name, sha);
    if(res.ok){ pendingCount = next.length; break; }
    // stale_base = 我們帶去的 sha 已過期(別人在這中間寫過)→ 重讀重試,不覆蓋對方
    if(res.error === "stale_base" && attempt < MAX_INTAKE_TRIES - 1) continue;
    return json(env, { ok:false, error:res.error, status:res.status }, 502);
  }
  return json(env, { ok:true, pid, pending: pendingCount });
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
      try{ text = new TextDecoder("utf-8", { fatal:true }).decode(b64ToBytes(f.contentB64)); }
      catch(e){ return json(env, { ok:false, error:"bad_file_content", path: f.path }, 400); }
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
  if(sessionRole(sess) === "leader"){
    const assetPaths = fileList.filter(f => !f.path.startsWith("data/")).map(f => f.path);
    if(assetPaths.length){
      const gid = await groupInternalId(env, headers, sess.g);
      if(!gid) return json(env, { ok:false, error:"group_unresolved", group: sess.g || "" }, 403);
      const prefix = "images/" + gid + "_";
      const bad = assetPaths.find(p => !p.startsWith(prefix));
      if(bad) return json(env, { ok:false, error:"forbidden_asset", path: bad, group: sess.g || "" }, 403);
    }
  }

  /* 版本落後偵測(逐檔):baseHashes 是 {路徑: 這份草稿的來源版本雜湊}。
     只要有一個分組檔在編輯期間被別人改過就整批擋下,不做部分寫入——
     寧可要求重來,也不要留下一半新一半舊的狀態。
     讀不到現行檔案(網路問題)就跳過該檔的比對,見 currentFileState。
     檢查與寫入用的是**同一次讀取**的 blob sha(pinned),中間別人寫過就會在 PUT 時被 GitHub 擋下。 */
  const baseHashes = (body && typeof body.baseHashes === "object" && body.baseHashes) || {};
  const pinned = {};              // 路徑 → 檢查那一刻的 blob sha,等一下原封不動帶去寫
  for(const f of fileList){
    if(!f.path.startsWith("data/")) continue;
    const st = await currentFileState(env, headers, f.path);
    if(!st) continue;             // 讀不到(網路問題):維持原本的寬鬆,不因一次抖動卡住所有人
    const want = baseHashes[f.path];
    if(typeof want === "string" && want && st.hash && st.hash !== want){
      return json(env, { ok:false, error:"stale_base", path:f.path, currentHash: st.hash }, 409);
    }
    pinned[f.path] = st.sha;      // null = 這個檔還不存在,寫入時不帶 sha
  }

  /* 先寫照片等附件、最後寫分組資料檔:任何一步失敗就中止,
     公開網站不會出現「資料檔指向不存在照片」的狀態。 */
  const dataFiles = fileList.filter(f => f.path.startsWith("data/"));
  const assetFiles = fileList.filter(f => !f.path.startsWith("data/"));
  let written = 0;
  const newHashes = {};

  for(const f of assetFiles){
    const r = await ghPutFile(env, headers, f.path, f.contentB64, "更新會員名錄（附件）" + by);
    if(!r.ok) return json(env, { ok:false, error:r.error, path:f.path, filesWritten:written, status:r.status }, 502);
    written++;
  }
  for(const f of dataFiles){
    const label = f.path === "data/_index.json" ? "分會結構"
                : f.path === PENDING_PATH ? "待認領區"
                : f.path.replace(/^data\/|\.json$/g, "").toUpperCase() + " 組";
    /* 帶上檢查那一刻的 sha。別人在這中間寫過的話,GitHub 會回 409 → stale_base,
       使用者看到的是「有人在你編輯期間發布過」,而不是一句假的「已發布!」。
       這個檔沒被檢查過(pinned 裡沒有)就傳 undefined,沿用舊行為。 */
    const r = await ghPutFile(env, headers, f.path, f.contentB64, "更新會員名錄・" + label + by,
                              Object.prototype.hasOwnProperty.call(pinned, f.path) ? pinned[f.path] : undefined);
    if(!r.ok) return json(env, { ok:false, error:r.error, path:f.path, filesWritten:written, status:r.status }, 502);
    // 回傳新版本雜湊,編輯頁接著用它當新的 baseHash,不必重新整理就能再次發布
    newHashes[f.path] = await sha256Hex(b64ToBytes(f.contentB64));
    written++;
  }
  return json(env, { ok:true, filesWritten:written, newHashes });
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
const VISITOR_FORM_ID = "";        // 表單的 e/ 後面那段(1FAIpQLSc… 開頭)
const VISITOR_ENTRY = {            // 欄位 → entry 編號
  name: "", phone: "", line: "", job: "", referrer: "",
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
