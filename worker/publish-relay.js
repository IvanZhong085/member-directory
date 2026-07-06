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
 *    - 加密變數（Secret）：ADMIN_PASSWORD（你的管理密碼）、SESSION_SECRET（隨機亂碼，見下方）、
 *      GH_TOKEN（你的 GitHub fine-grained 權杖，Contents: Read and write）
 *    - 一般變數：GH_OWNER=IvanZhong085、GH_REPO=member-directory、GH_BRANCH=main、GH_PATH=data.js、
 *      ALLOWED_ORIGIN=https://ivanzhong085.github.io
 * 4. 到 Settings → Bindings → 新增 KV Namespace binding：Variable name 填 RATE_LIMIT，
 *    Namespace 新建一個（例如叫 member-directory-rate-limit）。
 * 5. Save and deploy，把網址（https://xxx.workers.dev）貼到編輯頁「設定」裡的「後端服務網址」。
 *
 * 完整步驟另見 member-site/worker/README.md。
 */

const SESSION_TTL_SECONDS = 30 * 60;     // 登入後 30 分鐘內免重輸密碼
const MAX_FAILS = 5;                     // 同一個 IP 在下方時間窗內最多錯 5 次（KV 為最終一致性，極端並發下可能略為寬鬆，見下方 MIN_LOGIN_MS）
const FAIL_WINDOW_SECONDS = 15 * 60;     // 15 分鐘
const MAX_CONTENT_BYTES = 8 * 1024 * 1024; // 8MB，data.js 內含照片時的安全上限
const MIN_LOGIN_MS = 300;                // 每次 /login 至少花這麼久才回應，拖慢暴力破解速度（也讓 timingSafeEqual 更難被計時分析）
const GITHUB_TIMEOUT_MS = 15000;         // 呼叫 GitHub API 的逾時上限，避免請求無限期卡住

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
async function makeSession(secret){
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS*1000 });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return payloadB64 + "." + b64urlEncode(new Uint8Array(sig));
}
async function verifySession(token, secret){
  if(!token || typeof token !== "string" || token.indexOf(".") === -1) return false;
  const parts = token.split(".");
  if(parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  try{
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sigB64), new TextEncoder().encode(payloadB64));
    if(!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return typeof payload.exp === "number" && Date.now() < payload.exp;
  }catch(e){ return false; }
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

/* 純連線測試，不驗證密碼、不佔用登入錯誤次數額度 */
async function handlePing(request, env){
  return json(env, { ok:true, service:"member-directory-relay" });
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
  const password = (body && body.password) || "";
  const isCorrect = !!env.ADMIN_PASSWORD && !!password && timingSafeEqual(password, env.ADMIN_PASSWORD);

  // 每次 /login 至少花 MIN_LOGIN_MS，拖慢大量平行嘗試的有效速率（也讓時間分析更難）
  const elapsed = Date.now() - startedAt;
  if(elapsed < MIN_LOGIN_MS) await sleep(MIN_LOGIN_MS - elapsed);

  if(!isCorrect){
    await recordFail(env, ip, rl.count);
    return json(env, { ok:false, error:"wrong_password" }, 401);
  }
  await clearFail(env, ip);
  const session = await makeSession(env.SESSION_SECRET);
  return json(env, { ok:true, session, expiresInSeconds: SESSION_TTL_SECONDS });
}

async function ghHeaders(env){
  return {
    "Authorization": "Bearer " + env.GH_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "member-directory-relay",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function contentsUrl(env){
  const path = (env.GH_PATH || "data.js").replace(/^\/+/, "");
  return `https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(env.GH_REPO)}/contents/` +
    path.split("/").map(encodeURIComponent).join("/");
}

/* 讓管理員在設定 Worker 後可以自我檢查：密碼登入成功、且 GitHub 權杖確實可寫入 */
async function handleHealth(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const valid = await verifySession(body && body.session, env.SESSION_SECRET);
  if(!valid) return json(env, { ok:false, error:"session_expired" }, 401);
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

async function handlePublish(request, env){
  let body; try{ body = await request.json(); }catch(e){ return json(env, { ok:false, error:"bad_request" }, 400); }
  const { session, content } = body || {};
  const valid = await verifySession(session, env.SESSION_SECRET);
  if(!valid) return json(env, { ok:false, error:"session_expired" }, 401);
  if(typeof content !== "string" || content.length === 0) return json(env, { ok:false, error:"empty_content" }, 400);
  if(content.length > MAX_CONTENT_BYTES) return json(env, { ok:false, error:"too_large" }, 413);

  const headers = await ghHeaders(env);
  const url = contentsUrl(env);
  const branch = env.GH_BRANCH || "main";

  let sha;
  try{
    const getRes = await fetchWithTimeout(url + "?ref=" + encodeURIComponent(branch), { headers }, GITHUB_TIMEOUT_MS);
    if(getRes.ok){ sha = (await getRes.json()).sha; }
    else if(getRes.status === 401 || getRes.status === 403){ return json(env, { ok:false, error:"token_forbidden" }, 502); }
    else if(getRes.status !== 404){ return json(env, { ok:false, error:"github_read_failed", status:getRes.status }, 502); }
  }catch(e){
    return json(env, { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" }, 502);
  }

  const bytes = new TextEncoder().encode(content);
  let bin = ""; for(const b of bytes) bin += String.fromCharCode(b);
  const contentB64 = btoa(bin);

  const putBody = { message:"更新會員名錄", content: contentB64, branch };
  if(sha) putBody.sha = sha;
  try{
    const putRes = await fetchWithTimeout(url, { method:"PUT", headers: Object.assign({}, headers, {"Content-Type":"application/json"}), body: JSON.stringify(putBody) }, GITHUB_TIMEOUT_MS);
    if(!putRes.ok){
      const status = putRes.status;
      const error = (status === 401 || status === 403) ? "token_forbidden" : (status === 409 ? "conflict" : "github_write_failed");
      return json(env, { ok:false, error, status }, 502);
    }
    return json(env, { ok:true });
  }catch(e){
    return json(env, { ok:false, error: e && e.name === "AbortError" ? "github_timeout" : "github_unreachable" }, 502);
  }
}

export default {
  async fetch(request, env){
    // 沒設定 ALLOWED_ORIGIN 就直接回報錯誤，而不是悄悄用空字串「剛好」擋掉跨網域請求——
    // 避免未來改動不小心讓這個隱性行為失效卻沒人發現。
    if(!env.ALLOWED_ORIGIN){
      return new Response(JSON.stringify({ ok:false, error:"misconfigured_missing_allowed_origin" }), {
        status: 500, headers: { "Content-Type":"application/json" },
      });
    }
    if(request.method === "OPTIONS") return new Response(null, { status:204, headers: corsHeaders(env) });
    if(request.method !== "POST") return json(env, { ok:false, error:"method_not_allowed" }, 405);
    const { pathname } = new URL(request.url);
    if(pathname === "/ping") return handlePing(request, env);
    if(pathname === "/login") return handleLogin(request, env);
    if(pathname === "/publish") return handlePublish(request, env);
    if(pathname === "/health") return handleHealth(request, env);
    return json(env, { ok:false, error:"not_found" }, 404);
  },
};
