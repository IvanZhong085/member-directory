/* 從 admin.js 抽出來的純邏輯：沒有 DOM、沒有網路、沒有全域狀態。

   抽出來的唯一理由是**可測試**。這幾段是併發正確性的關鍵，而它們原本埋在一個
   一千多行的 IIFE 裡，任何自動測試都碰不到。上一輪外部審查找到的兩個 P0 之中，
   前端那一個（認領前檢查 dirty 而不是 hasUnpublishedChanges）就不是被測試抓到的，
   是被人逐行讀出來的 —— 同一類錯誤還會再發生。

   改動這裡請一併更新 tests/logic.test.mjs。 */
var AdminLogic = (function(){
  "use strict";

  /* 三方比較：草稿當初的來源版本（draftBase）vs 剛從權威來源讀到的現況（liveHashes）。
     回傳「有衝突」的路徑清單。

     draftBase 為 null 代表舊格式草稿（那時還沒有存版本資訊）——整份都算衝突。
     不是因為它一定壞掉，而是因為**無法安全比對的東西不該被當成可以直接覆蓋**：
     原本這種草稿會變成「舊內容配新雜湊」，版本檢查會通過，於是靜默蓋掉別人的修改。 */
  function computeConflicts(draftBase, liveHashes){
    const paths = Object.keys(liveHashes || {});
    if(!draftBase) return paths.slice();
    const out = [];
    for(const p of paths){
      const b = draftBase[p];
      if(typeof b === "string" && b && b !== liveHashes[p]) out.push(p);
    }
    return out;
  }

  /* 改名時要一併刪掉的舊路徑。

     分組代號改了，檔案路徑就跟著變。新檔會被送出，但舊檔不會自己消失 —— 它會變成
     沒有人會讀的孤兒（build-data.mjs 只讀 _index 列出的檔），而持有舊分頁的組長還能
     繼續寫進去：兩邊都顯示成功，資料卻永遠不會出現在網站上。

     「改回原名」不會產生刪除（orig === now）。同一個舊路徑只會出現一次。 */
  function computeRenameRemovals(groups, originalPathByGroupId, dataPathOf){
    const out = [];
    for(const g of (groups || [])){
      const orig = originalPathByGroupId ? originalPathByGroupId[g.id] : null;
      const now = dataPathOf(g.code);
      if(orig && orig !== now && out.indexOf(orig) < 0) out.push(orig);
    }
    return out;
  }

  /* 誰是 primary 分頁：id 字典序最小的那一個。

     每個分頁各自算，結論必然一致，所以不需要協商 —— 也就不會出現「兩邊都把自己
     標成 secondary」而全都不存草稿的情況（那是用「先到先得」時的真實風險）。
     原分頁關閉後它的心跳停止、從 peers 裡被清掉，剩下的分頁自然接手。 */
  function isPrimaryTab(selfId, peerIds){
    for(const id of (peerIds || [])) if(id < selfId) return false;
    return true;
  }

  /* 待認領區要不要提醒、提醒什麼。回傳 { level, text } 或 null(不提醒)。

     為什麼需要:申請進了待認領區之後不會有任何人被通知,就這樣躺著等某位組長剛好
     打開後台。新夥伴那頭只會覺得「送出之後就沒下文」。在人一定會看到的位置(待認領
     區本身)放一則會隨筆數升級的提醒,是不動用信件也做得到的最低限度。

     三個級距不是隨手挑的:
       ≥2   有人在等 —— 一筆時清單本身就看得見,兩筆開始才需要催。
       ≥80% 快滿了 —— 滿了之後 /intake 會回 pending_full,新夥伴的申請**會被退回**,
            所以要在還來得及的時候講。
       =max 已經滿了 —— 這時候申請已經在掉了,措辭必須是「現在就處理」。
     max 由呼叫端傳入(對齊 Worker 的 MAX_PENDING),不在這裡寫死第二份。 */
  function pendingNotice(count, max){
    const n = Number(count) || 0;
    const cap = Number(max) > 0 ? Number(max) : 30;
    if(n >= cap){
      return { level:"danger",
               text:"待認領區已滿（" + n + "/" + cap + "）：新夥伴現在送出的申請會被退回，請立即認領或刪除幾筆。" };
    }
    if(n >= Math.ceil(cap * 0.8)){
      return { level:"warn",
               text:"待認領區快滿了（" + n + "/" + cap + "）：滿了之後新夥伴的申請會被退回，請組長盡速認領。" };
    }
    if(n >= 2){
      return { level:"info",
               text:"目前有 " + n + " 位新夥伴等待認領，請組長盡速認領組員。" };
    }
    return null;
  }

  /* 「同一把鑰匙同時只發一次請求」的合流器（single-flight）。

     為什麼要抽出來:第一版直接寫在 fetchPendPhoto 裡,而且錯了 ——
     內層 async 函式有兩條 early return 寫在 `try{` **之前**,於是 `finally` 裡的
     「把這把鑰匙從進行中移除」對那兩條路完全不執行;接著呼叫端仍然把那顆
     **已經 resolve 成 null** 的 promise 放進 map,之後每一次查詢都直接命中它。
     結果是那把鑰匙從此再也不會發出第二次請求 —— 重繪、重新登入都救不回來,
     只有整頁重新載入才會清掉。

     踩到的路不是罕見情況,而是最需要它自我修復的那條:
       ・session 過期(預設 30 分鐘)→ 拿不到 session → 走 early return
       ・開機時 /ping 還沒回來 → caps 是空的 → 走 early return
     兩者都是「等一下就會好」的暫時狀態,卻被記成永久失敗。

     ★ 修法不是「把整段包進 try」。early return 那條路上沒有任何 await,函式是
       **同步跑完**的,finally 會在呼叫端把 promise 放進 map **之前**就執行,
       delete 變成空操作,毒化照樣發生。要在 promise settle **之後**才清除,
       也就是靠 .finally() 排進 microtask —— 那必然晚於同步的 set。

     run(key, fn) 回傳 fn 的結果;同一把鑰匙在進行中時共用同一顆 promise。
     結束(成功或失敗)一律清掉,不做任何負向快取。 */
  function makeSingleFlight(){
    const inflight = new Map();
    return {
      run(key, fn){
        if(inflight.has(key)) return inflight.get(key);
        let job;
        try{ job = Promise.resolve(fn()); }
        catch(e){ return Promise.resolve(null); }     // fn 同步丟錯:不留任何痕跡
        inflight.set(key, job);
        // ★ .finally 的 callback 是 microtask,必然排在上一行的同步 set 之後
        job.finally(() => { if(inflight.get(key) === job) inflight.delete(key); });
        return job;
      },
      size(){ return inflight.size; },
      clear(){ inflight.clear(); },
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
     夥伴資料更新(Google 表單 → 私有 R2 待審核 → 組長在後台逐欄確認後套用)
     ══════════════════════════════════════════════════════════════════════
     這一段給審核區、成員卡的「複製已帶好名字的更新連結」、催收訊息與草稿衝突警示用。

     ★ canonUpdateValue / sameUpdateValue / updateValueHash 必須和 Worker
       (worker/publish-relay.js)**逐字相同**。組長複製的連結帶著「連結代碼」——
       產生連結當下每一格帶入內容的雜湊 —— Worker 收件時用同一套算法判斷「這格是
       連結帶入、本人沒改」。兩邊只要差一個字元(例如一邊去控制字元、一邊沒有),
       每一格都會被當成修改,夥伴從 LINE 點舊連結再填一次,就會把後來的更新改回去,
       而且不會有任何錯誤訊息。所以兩邊用 tests/member-update-cases.mjs 的共用測資鎖住。 */

  /* 欄位名稱一律和表單題目同名(tools/google-form.gs 的 NEWMEMBER_Q,測試會比對)。
     審核畫面、催收訊息都用這一份:組長跟夥伴說「請補『主要營業項目』」時,夥伴在
     表單上找得到同一個字。 */
  const FIELD_LABELS = Object.freeze({
    title:"行業／職稱", company:"所屬公司", services:"服務項目", targets:"適合引薦對象",
    have:"我有…", want:"我要…", tagline:"25 秒自我介紹 Slogan",
    business_items:"主要營業項目", website:"公司網站",
  });
  /* 差異表的順序,也是連結代碼裡 9 段雜湊的順序(= Worker 的 UPDATE_TOKEN_ORDER)。
     ★ 不可以調整:已經發到 LINE 的連結代碼是照這個順序切的,改了順序,
       舊連結的每一格都會對到別欄的雜湊。 */
  const UPDATE_FIELD_ORDER = Object.freeze(["company","business_items","website","have","want","title","services","targets","tagline"]);
  const LIST_FIELDS = Object.freeze(["services","targets","have","want","tagline"]);
  /* 收件時間比填寫時間晚超過 10 分鐘就算「補送」。正常送件從按下送出到 Worker 收到
     只要幾秒;晚這麼多代表是失敗後補送的舊內容,可能比網站上的資料還舊。 */
  const UPDATE_LATE_MS = 10 * 60 * 1000;
  /* 空白格的雜湊固定是 8 個 0。真的算出 0 的值改成 "00000001",
     免得「本人清空」和「本來就空」分不出來。 */
  const UPDATE_HASH_EMPTY = "00000000";
  const UPDATE_MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  /* 與 Worker 的 str() 同一組控制字元:保留 \t \n \r(段落題本來就會有換行) */
  const UPDATE_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const DAY_MS = 86400000;

  /* 照片欄位(更新表單的三個上傳題)。和 9 個文字欄位分開放:
     FIELD_LABELS 有測試鎖住「剛好 9 欄、和表單文字題同名」,連結代碼的 9 段雜湊也只管文字。
     鍵和 Worker 的 UPDATE_PHOTO_FIELDS、成員卡的 image/card/products 同名 ——
     套用時 choices / expect 用的就是這三個鍵。 */
  const PHOTO_LABELS = Object.freeze({ image:"形象照", card:"名片照片", products:"商品照片" });
  const UPDATE_PHOTO_FIELDS = Object.freeze(["image","card","products"]);
  /* 商品照最多幾張:和成員卡上傳、Worker 套用的上限同一個數字 */
  const UPDATE_PRODUCTS_MAX = 5;

  const hasOwn = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const isListField = f => LIST_FIELDS.indexOf(f) >= 0;
  /* 欄位鍵 → 顯示名稱。只查自己的屬性,"constructor" 這類鍵不會查到 Object.prototype 上的東西 */
  const fieldLabel = f => hasOwn(FIELD_LABELS, f) ? FIELD_LABELS[f] : hasOwn(PHOTO_LABELS, f) ? PHOTO_LABELS[f] : String(f == null ? "" : f);
  const fieldRank = f => { const i = UPDATE_FIELD_ORDER.indexOf(f); return i < 0 ? UPDATE_FIELD_ORDER.length : i; };

  /* 選單上的選項文字「A1・曾俊凱」。中間是 U+30FB「・」,和網站徽章「代號・組名」同一種寫法。
     ★ 與 tools/google-form.gs 的 memberUpdateLabel_ 逐字相同:預填連結靠這串字預選名字,
       兩邊差一個字(例如一邊用 U+00B7「·」),預填就選不到人,夥伴只會看到空白的選單。 */
  function memberUpdateLabel(code, name){
    return String(code).trim() + "・" + String(name).trim();
  }

  /* 比對與雜湊用的文字正規化:去掉控制字元後 trim。
     ★ 刻意**不截長度**:截過再比的話,現值已經 14 項、夥伴只改了第 14 項,
       兩邊截到 12 項後一樣,真的修改就會被判成「沒改」而丟掉(乙 9)。截斷只在寫入時做。 */
  function canonText(v){
    return String(v == null ? "" : v).replace(UPDATE_CTRL_RE, "").trim();
  }

  /* 清單欄位:陣列或「一行一項」的字串都轉成去掉空行的陣列;文字欄位:canonText。
     表單送來的是字串、網站上存的是陣列,兩種寫法要能直接比。 */
  function canonUpdateValue(field, v){
    if(isListField(field)){
      return (Array.isArray(v) ? v : String(v == null ? "" : v).split("\n")).map(canonText).filter(Boolean);
    }
    return canonText(v);
  }

  function sameUpdateValue(field, a, b){
    return JSON.stringify(canonUpdateValue(field, a)) === JSON.stringify(canonUpdateValue(field, b));
  }

  /* 一格內容的 8 位 hex 雜湊(FNV-1a 32 位元,對 UTF-8 位元組)。
     為什麼不用 SHA-256:瀏覽器的 crypto.subtle 是非同步的,而組長按「複製連結」要同步
     拿到結果;這裡要的只是「這格有沒有被改過」,不是防偽 —— 代碼本來就印在表單上,
     任何人都看得到、改得了。8 位 hex × 9 格 = 72 字,放進預填網址也不會太長。 */
  function updateValueHash(field, v){
    const c = canonUpdateValue(field, v);
    if(!c.length) return UPDATE_HASH_EMPTY;          // 空字串或空陣列
    const bytes = new TextEncoder().encode(JSON.stringify(c));
    let h = 0x811c9dc5;
    for(let i = 0; i < bytes.length; i++){
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    const hex = (h >>> 0).toString(16).padStart(8, "0");
    return hex === UPDATE_HASH_EMPTY ? "00000001" : hex;
  }

  /* 連結代碼:"v1." + 成員 id + "." + 依 UPDATE_FIELD_ORDER 串起 9 格雜湊。
     帶成員 id 是為了夥伴改名之後,舊連結照樣找得到人(乙 5)。
     id 不合格就不給代碼 —— Worker 的格式檢查會整串丟掉,給了也沒用。 */
  function memberUpdateToken(member){
    const id = member && typeof member.id === "string" ? member.id : "";
    if(!UPDATE_MEMBER_ID_RE.test(id)) return "";
    return "v1." + id + "." + UPDATE_FIELD_ORDER.map(f => updateValueHash(f, member[f])).join("");
  }

  /* 組長複製的連結要預填的內容:名字選項 + 目前的 9 格(清單用換行串起來)+ 連結代碼。
     空的格子不放 —— 預填一個空值沒有意義,只會讓網址變長。
     放進去的是正規化後的值,所以「預填的字」和「代碼記的雜湊」一定對得上。 */
  function memberPrefillValues(code, member){
    const m = member || {};
    const out = {};
    if(canonText(code) && canonText(m.name)) out.member = memberUpdateLabel(code, m.name);
    for(const f of UPDATE_FIELD_ORDER){
      const c = canonUpdateValue(f, m[f]);
      const v = isListField(f) ? c.join("\n") : c;
      if(v) out[f] = v;
    }
    const token = memberUpdateToken(m);
    if(token) out.token = token;
    return out;
  }

  /* 給夥伴的表單連結一律加這個參數:LINE 內建瀏覽器看到它會改用手機的瀏覽器開。
     為什麼一定要:更新表單可以上傳照片,Google 因此要求登入;LINE 內建瀏覽器登不進 Google
     (會卡在「這個瀏覽器不安全」),長輩點了連結只會看到登入失敗,不會知道要換瀏覽器。
     Google 表單會忽略不認得的參數,其他 App 開也不受影響。 */
  const EXTERNAL_BROWSER_PARAM = "openExternalBrowser";

  /* 字串網址加上 openExternalBrowser=1。已經有這個參數就原樣回傳(不重複加);
     不是 http(s) 網址(或根本不是字串)也原樣回傳 —— 那種網址加了也沒用。
     ★ 用字串接在查詢字串後面,不經過 URLSearchParams 重組:重組會把原本的參數重新編碼
       (例如 %20 變成 +),組長貼在 site-config 的網址要原封不動。 */
  function withExternalBrowser(url){
    if(typeof url !== "string") return url;
    const s = url.trim();
    let u;
    try{ u = new URL(s); }catch(e){ return url; }
    if(u.protocol !== "https:" && u.protocol !== "http:") return url;
    if(u.searchParams.has(EXTERNAL_BROWSER_PARAM)) return url;
    const at = s.indexOf("#");
    const head = at < 0 ? s : s.slice(0, at), hash = at < 0 ? "" : s.slice(at);
    const sep = head.indexOf("?") < 0 ? "?" : /[?&]$/.test(head) ? "" : "&";
    return head + sep + EXTERNAL_BROWSER_PARAM + "=1" + hash;
  }

  /* 組 Google 表單的預填連結。回傳 null(沒設表單網址,或網址不是 http(s))
     或 { url, nameless, trimmed }:
       nameless  site-config 沒有 member 的 entry → 只能給通用連結
       trimmed   全部預填超過 maxLen → 退回只預選名字(**不帶連結代碼**:代碼記的是
                 「每一格帶入了什麼」,格子沒帶入卻帶代碼,Worker 會誤判本人清空了每一格)
     只放 entries 與 values 兩邊都有的鍵;編碼一律交給 URLSearchParams,
     換行、空白、「・」、括號都不用自己處理。
     三種結果都帶 openExternalBrowser=1(見 withExternalBrowser),長度判斷也把它算進去 ——
     它是最後才接上的,不算的話剛好卡在上限邊緣的連結會超過。 */
  const PREFILL_KEYS = ["member"].concat(UPDATE_FIELD_ORDER, ["token"]);
  function updatePrefillUrl(formUrl, entries, values, maxLen = 6000){
    const base = typeof formUrl === "string" ? formUrl.trim() : "";
    if(!base) return null;
    const entryOf = k => hasOwn(entries, k) && typeof entries[k] === "string" ? entries[k].trim() : "";
    if(!entryOf("member")) return { url: withExternalBrowser(base), nameless: true, trimmed: false };
    const valueOf = k => hasOwn(values, k) && values[k] != null ? String(values[k]) : "";
    const build = keys => {
      let u;
      try{ u = new URL(base); }catch(e){ return null; }
      if(u.protocol !== "https:" && u.protocol !== "http:") return null;
      u.searchParams.set("usp", "pp_url");        // 原本的 usp=sf_link 之類會被取代
      for(const k of keys){
        const e = entryOf(k), v = valueOf(k);
        if(e && v) u.searchParams.set(e, v);
      }
      u.searchParams.set(EXTERNAL_BROWSER_PARAM, "1");   // 放最後:前面那些才是給表單看的
      return u.toString();
    };
    /* 連結代碼記的是「每一格帶入了什麼」。有內容的格子卻沒有 entry(題目被改了標題、site-config
       少貼一個)時,那一格帶不進表單,夥伴送出時是空的 —— 代碼卻說它原本有內容,Worker 會判成
       「本人把這一格清空了」,審核畫面就多一則假的警示。這時寧可不帶代碼(少一層保護)。 */
    const tokenSafe = UPDATE_FIELD_ORDER.every(f => !valueOf(f) || entryOf(f));
    const full = build(tokenSafe ? PREFILL_KEYS : PREFILL_KEYS.filter(k => k !== "token"));
    if(full === null) return null;
    const cap = Number(maxLen) > 0 ? Number(maxLen) : 6000;
    if(full.length <= cap) return { url: full, nameless: false, trimmed: false };
    return { url: build(["member"]), nameless: false, trimmed: true };
  }

  /* 清單欄位「整格換成新的」時逐項標示:原本有、新的也有 → kept;
     原本有、新的沒有 → removed(會刪掉);新的才有 → added。
     順序是原本的項目在前、新增的接在後面,組長一眼看得出刪了哪幾項。 */
  function listDiff(before, after){
    const b = canonUpdateValue("services", before), a = canonUpdateValue("services", after);
    const inAfter = new Set(a), inBefore = new Set(b);
    const out = b.map(text => ({ text, state: inAfter.has(text) ? "kept" : "removed" }));
    for(const text of a) if(!inBefore.has(text)) out.push({ text, state: "added" });
    return out;
  }

  /* 「加在原本後面」:原本的項目原封不動,接上新清單裡還沒有的項目(重複的不再加),
     最多 max 項。dropped = 被截掉的項數,給畫面上「最後 k 項不會放進去」用。 */
  function mergeList(before, add, max = 12){
    const items = canonUpdateValue("services", before);
    const seen = new Set(items);
    for(const t of canonUpdateValue("services", add)){
      if(!seen.has(t)){ seen.add(t); items.push(t); }
    }
    const cap = Number(max) > 0 ? Math.floor(Number(max)) : 12;
    return { items: items.slice(0, cap), dropped: Math.max(0, items.length - cap) };
  }

  /* 網址的主機名稱(小寫、去掉開頭的 www.),比對「網域有沒有變」用。解析不了回 "" */
  function websiteHost(url){
    try{ return new URL(canonText(url)).hostname.toLowerCase().replace(/^www\./, ""); }
    catch(e){ return ""; }
  }

  const pad2 = n => String(n).padStart(2, "0");
  /* 「2026/10/02 13:14」(瀏覽器當地時間)。解析不了回 "" */
  function updateTimeText(iso){
    const d = new Date(iso == null ? "" : iso);
    if(isNaN(d.getTime())) return "";
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  /* 「10/2」,給要貼到 LINE 的訊息用。解析不了回 "" */
  function updateMonthDay(iso){
    const d = new Date(iso == null ? "" : iso);
    if(isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  /* 從 iso 到 nowMs 經過幾個整天。解析不了或在未來都算 0 */
  function updateWaitDays(iso, nowMs){
    const t = Date.parse(iso == null ? "" : iso);
    const now = Number(nowMs);
    if(!isFinite(t) || !isFinite(now) || now <= t) return 0;
    return Math.floor((now - t) / DAY_MS);
  }
  /* 一格內容的顯示文字:清單用「、」串起來,空的寫「（空白）」 */
  function updateValueText(field, v){
    const c = canonUpdateValue(field, v);
    const s = Array.isArray(c) ? c.join("、") : c;
    return s || "（空白）";
  }

  /* 審核卡的標頭:整筆要不要預設全部不勾(allSkip),以及要醒目提示的事。
     三種情況整筆預設不勾,因為「這筆是不是真的屬於這個人、是不是最新」都有疑問:
       ① 系統依姓名改送到別組(pickedLabel 和目前的「代號・姓名」不同,乙 11)
       ② 連結代碼指向的人和選單上的名字對不上(nameMismatch,可能改過名,乙 5)
       ③ 補送進來,而且填寫之後網站上這位夥伴又改過(乙 2)。updatedAt 沒有值或看不懂
          時判斷不了「之後有沒有改過」,一律當成改過 —— 判斷不了時偏向保守。
     days 是填寫至今幾天(標頭「已等 D 天」用)。 */
  function memberUpdateHeader(req, member, code, nowMs){
    const r = req || {}, m = member || {};
    const warnings = [], info = [];
    let allSkip = false;
    const satIso = r.sat || r.at;
    const atMs = Date.parse(r.at == null ? "" : r.at), satMs = Date.parse(satIso == null ? "" : satIso);
    const late = isFinite(atMs) && isFinite(satMs) && atMs - satMs > UPDATE_LATE_MS;

    const picked = canonText(r.pickedLabel);
    if(picked){
      const current = memberUpdateLabel(code, m.name);
      if(picked !== current){
        allSkip = true;
        warnings.push("⚠ 本人在選單上選的是「" + picked + "」，系統依照目前的名錄改送到「" + current + "」。請先 LINE 確認是同一個人，再勾選要套用的欄位。");
      }
    }
    if(r.nameMismatch && typeof r.nameMismatch === "object"){
      allSkip = true;
      warnings.push("⚠ 本人在選單上選的是「" + canonText(r.nameMismatch.picked) + "」，連結代碼指向名錄上的「" + canonText(r.nameMismatch.current) + "」（可能改過名字）。請先確認是同一個人，再勾選要套用的欄位。");
    }
    if(late){
      const satText = updateTimeText(satIso) || String(satIso), atText = updateTimeText(r.at) || String(r.at);
      const upd = Date.parse(m.updatedAt == null ? "" : m.updatedAt);
      if(!m.updatedAt || !isFinite(upd) || upd > satMs){
        allSkip = true;
        warnings.push("⚠ 這筆是 " + satText + " 填的，" + atText + " 才補送進來；之後這位夥伴的資料已經改過，內容可能比網站上舊，請逐欄確認。");
      }else{
        info.push("這筆是 " + satText + " 填的，" + atText + " 才補送進來。");
      }
    }
    if(r.confirmOnly === true) info.push("本人確認資料正確，沒有要修改。");
    return { warnings, info, allSkip, late, days: updateWaitDays(satIso, nowMs) };
  }

  /* 差異表的每一列與預設勾選。規則由上往下,第一條成立的決定 defaultChoice;
     警示則是每一條成立的都列出來(同一列可能同時被截斷又是連結過期,兩件事組長都該知道)。
     唯一的例外是「和目前一樣」:沒有東西要套用,其他提醒只是雜訊。
     「本人送出後這一欄被改過」不影響預設值,只提醒 —— 套用時 Worker 還會逐欄比對 expect。

     為什麼這幾種情況預設不勾(都是「預設套用的話,錯了沒人會發現」的情況):
       網站從空白變成有網址  90 位裡有網站的是 0 位,新網址一律要本人確認(甲 1)
       行業／職稱原本有內容  名錄上最顯眼的一行,選錯名字時最先被換掉的就是它(甲 6)
       清單完全沒有重疊      夥伴多半只寫了要新增的,整格換掉會把原本的全刪光 */
  function memberUpdateRows(member, req, newerFields, allSkip){
    const m = member || {}, r = req || {};
    const changes = r.changes && typeof r.changes === "object" ? r.changes : {};
    const newer = newerFields && typeof newerFields.has === "function" ? newerFields : new Set();
    const listOf = v => Array.isArray(v) ? v : [];
    const truncated = listOf(r.truncated).filter(t => t && typeof t === "object");
    const stale = listOf(r.stalePrefill);
    const rows = [];
    for(const f of UPDATE_FIELD_ORDER){
      if(!hasOwn(changes, f)) continue;
      const kind = f === "website" ? "website" : isListField(f) ? "list" : "text";
      const before = canonUpdateValue(f, m[f]);
      const after = canonUpdateValue(f, changes[f]);
      const hasBase = hasOwn(r.base, f);
      const base = hasBase ? canonUpdateValue(f, r.base[f]) : null;
      const identical = sameUpdateValue(f, after, before);
      const changedSinceSubmit = hasBase && !sameUpdateValue(f, base, before);
      const warnings = [];
      let choice = "";
      const decide = (c, w) => { if(!choice) choice = c; if(w) warnings.push(w); };

      if(identical){
        decide("skip", "和網站上目前一樣（不用套用）");
      }else{
        if(allSkip) decide("skip");
        const tr = truncated.find(t => t.field === f);
        if(tr){
          decide("skip", "⚠ 夥伴寫了 " + tr.total + " " + tr.unit + "，只收進前 " + tr.kept + " " + tr.unit +
                 "，完整內容在回應試算表（回應 ID " + (canonText(r.responseId) || "不明") + "）。請先跟本人確認要怎麼縮短。");
        }
        if(stale.indexOf(f) >= 0){
          decide("skip", "⚠ 夥伴的連結是在這一欄改過之前產生的，他是看著舊內容改的；直接換掉，可能把後來加上的內容刪掉。請比對後再決定（清單可以選「加在原本後面」）。");
        }
        if(newer.has(f)) decide("skip", "後面那筆較新的更新也改了這一欄，這裡先不套用。");
        if(kind === "website"){
          if(!before){
            decide("skip", "⚠ 新的網址會直接放上公開名錄（訪客只看到「公司網站 ↗」按鈕，看不到網址），請先跟本人確認這是他的網站。");
          }else{
            const a = websiteHost(before), b = websiteHost(after);
            if(a !== b) decide("skip", "⚠ 網域變了（原本 " + (a || before) + " → 新的 " + (b || after) + "）。網址會直接放上公開名錄，請先跟本人確認。");
          }
        }
        if(f === "title" && before){
          decide("skip", "⚠ 行業／職稱是名錄上最顯眼的一行，而且會整句換掉。選錯名字時最常被換掉的就是這一欄，請確認像這位夥伴的行業再勾選。");
        }
        if(kind === "list"){
          if(!before.length) decide("replace");
          else if(after.some(t => before.indexOf(t) >= 0)){
            decide("replace", after.length < before.length / 2 ? "⚠ 原本 " + before.length + " 項，換成新的只剩 " + after.length + " 項。" : "");
          }else{
            decide("skip", "⚠ 原本 " + before.length + " 項，夥伴寫的內容裡沒有任何一項是原本的 —— 他可能只寫了要新增的。請選「加在原本後面」，或先跟本人確認。");
          }
        }
        decide("replace");
      }
      if(changedSinceSubmit) warnings.push("⚠ 本人送出後，這一欄被改過（他送出時是：" + updateValueText(f, base) + "）。");

      const row = { field: f, label: fieldLabel(f), kind, before, after, base, identical, changedSinceSubmit,
                    options: kind === "list" ? ["replace","append","skip"] : ["replace","skip"],
                    defaultChoice: choice, warnings };
      if(kind === "list") row.items = listDiff(before, after);
      rows.push(row);
    }

    /* 照片列接在文字列後面(形象照、名片照片、商品照片)。
       before 是成員卡上現在的檔名(後台用 imgSrc 顯示);incoming 是暫存區的新照片,
       後台另外向 /member-update-photo 要。
       照片不和網站上的比對:同一張照片重新上傳也會是不同的檔,判斷不出「一樣」,所以 identical 一律 false。
       預設規則和文字列一樣是「第一條成立的決定,警示每條都列」:
         ① allSkip                    整筆有疑問(選錯名字、補送的舊內容),警示已經在標頭
         ② 較新那筆也傳了這類照片       舊的先不套用,免得舊照片蓋掉新照片
         ③ 形象照/名片原本就有          換掉就回不去,而冒名送件最容易得逞、也最傷人的就是換大頭照
         ④ 商品照:原本沒有 → 換成新的;放得下 → 加在原本後面(最不會弄丟東西);
            放不下(超過 5 張)→ 不勾,要組長自己選整組換掉還是不套用 */
    for(const p of memberUpdatePhotos(r)){
      const f = p.field;
      const before = f === "products"
        ? (Array.isArray(m.products) ? m.products : []).filter(x => typeof x === "string").map(canonText).filter(Boolean)
        : [canonText(typeof m[f] === "string" ? m[f] : "")].filter(Boolean);
      const warnings = [];
      let choice = "";
      const decide = (c, w) => { if(!choice) choice = c; if(w) warnings.push(w); };
      if(allSkip) decide("skip");
      if(newer.has(f)) decide("skip", "後面那筆較新的更新也傳了這類照片，這裡先不套用。");
      if(f === "products"){
        const n = before.length, k = p.incoming.length;
        if(!n) decide("replace");
        else if(n + k <= UPDATE_PRODUCTS_MAX) decide("append");
        else decide("skip", "⚠ 原本 " + n + " 張加上新的 " + k + " 張超過 " + UPDATE_PRODUCTS_MAX + " 張，請選「整組換成新的」或不套用。");
      }else{
        if(before.length) decide("skip", "⚠ 會換掉名錄上現在的" + p.label + "。請先確認新照片是本人（或他的名片）再勾選。");
        decide("replace");
      }
      rows.push({ field: f, label: p.label, kind: "photo", before, incoming: p.incoming, count: p.incoming.length,
                  options: f === "products" ? ["replace","append","skip"] : ["replace","skip"],
                  defaultChoice: choice, warnings, identical: false, changedSinceSubmit: false });
    }
    return rows;
  }

  /* 這筆更新帶了哪些照片。回傳 [{ field, label, incoming:[{ field, index }] }],
     依形象照、名片照片、商品照片的順序,只列真的有照片的欄位。
     incoming 的 field / index 就是 /member-update-photo 要的參數:商品照是 "product"
     (單數,和 Worker 的照片 key 同一個字)、index 0–4;形象照與名片的 index 是 -1。
     req.photos 是 /member-update-get 給的摘要(只有 mime、bytes,沒有 R2 key)。
     格式不對的項目略過,但其他項目**保留原本的位置**當 index —— Worker 是照位置找照片的。 */
  function memberUpdatePhotos(req){
    const p = req && req.photos && typeof req.photos === "object" && !Array.isArray(req.photos) ? req.photos : null;
    if(!p) return [];
    const isRef = x => !!x && typeof x === "object" && !Array.isArray(x);
    const out = [];
    for(const f of UPDATE_PHOTO_FIELDS){
      const incoming = f === "products"
        ? (Array.isArray(p.products) ? p.products.slice(0, UPDATE_PRODUCTS_MAX) : [])
            .map((x, i) => isRef(x) ? { field:"product", index:i } : null).filter(Boolean)
        : (hasOwn(p, f) && isRef(p[f]) ? [{ field:f, index:-1 }] : []);
      if(incoming.length) out.push({ field:f, label:PHOTO_LABELS[f], incoming });
    }
    return out;
  }

  /* 審核畫面的「系統註記」:沒有變成修改、但組長應該知道的事。
     欄位鍵一律換成和表單同名的標籤;cleared 附上網站上目前的內容,組長才知道清空會刪掉什麼。 */
  function memberUpdateExtras(req, member){
    const r = req || {}, m = member || {};
    const listOf = v => Array.isArray(v) ? v : [];
    const objs = v => listOf(v).filter(x => x && typeof x === "object");
    const keyOf = x => typeof x === "string" ? x : (x && typeof x === "object" ? x.field : "");
    const byOrder = (a, b) => fieldRank(a) - fieldRank(b);
    return {
      ignored: objs(r.ignored).map(x => ({ label: fieldLabel(x.field), value: canonText(x.value) })),
      invalid: objs(r.invalid).map(x => ({ label: fieldLabel(x.field), value: canonText(x.value) })),
      untouched: listOf(r.untouched).filter(f => typeof f === "string").sort(byOrder).map(fieldLabel),
      cleared: listOf(r.cleared).map(keyOf).filter(f => typeof f === "string" && f)
                 .map(f => ({ label: fieldLabel(f), current: updateValueText(f, m[f]) })),
      truncated: objs(r.truncated).map(x => ({ label: fieldLabel(x.field), total: x.total, kept: x.kept, unit: x.unit })),
    };
  }

  /* 審核區的提醒,和 pendingNotice 同一個思路:放在一定會看到的地方,隨情況升級。
     級距:
       已滿(openAll ≥ max)  Worker 會回 updates_full,夥伴送出的更新**會被退回**
       快滿(≥ 80%)          還來得及的時候先講
       最舊一筆 ≥ 7 天       夥伴等太久會以為表單壞了、開始重送
       ≥ 1 筆               這個區塊在頁面下方,一筆就要提醒(R5-5)
     openAll 是全分會的筆數:組長也要知道「快滿了」,因為滿了連他那組的夥伴都送不進來。
     天數一律從 sat(夥伴按送出的時間)算,不是 Worker 收件時間 —— 補送的那筆實際上等更久。 */
  function memberUpdateNotice(o, nowMs){
    const p = o || {};
    const count = Number(p.count) || 0;
    const openAll = p.openAll == null ? count : (Number(p.openAll) || 0);
    const max = Number(p.max) > 0 ? Number(p.max) : 100;
    const days = count >= 1 ? updateWaitDays(p.oldestAt, nowMs) : 0;
    if(openAll >= max){
      return { level:"danger", text:"待審核的夥伴資料更新已滿（" + openAll + "/" + max + "）：新送出的更新會被退回，請立即處理。" };
    }
    if(openAll >= Math.ceil(max * 0.8)){
      return { level:"warn", text:"待審核更新快滿了（" + openAll + "/" + max + "）：滿了之後夥伴送出的更新會被退回。" };
    }
    if(count >= 1 && days >= 7){
      return { level:"warn", text:"「" + canonText(p.oldestName) + "」的資料更新已經等了 " + days + " 天，請盡快審核。" };
    }
    if(count >= 1){
      return { level:"info", text:"有 " + count + " 筆夥伴資料更新等待審核" + (days >= 1 ? "（最久的已等 " + days + " 天）" : "") };
    }
    return null;
  }

  /* /member-updates 的清單 → 每位夥伴一張卡。
     同一位的多筆依 sat 由舊到新排:只有最舊那筆能操作,較新那筆也改的欄位在舊的這筆預設不勾
     —— 用 sat 而不是收件時間,補送進來的舊內容才不會變成「最新的一筆」(乙 2)。
     卡片之間依各自最舊的 sat 排,等最久的在最上面。
     名字與代號取最新那筆(代號是 Worker 用 gid 對目前 _index 查出來的)。 */
  function groupMemberUpdates(items){
    const keyMs = it => { const t = Date.parse(it.sat || it.at || ""); return isFinite(t) ? t : Infinity; };
    // 同一個 sat 時再依收件時間、uid 排,每次重畫的順序才固定
    const cmp = (a, b) => {
      const x = keyMs(a), y = keyMs(b);
      if(x !== y) return x < y ? -1 : 1;
      return String(a.at || "").localeCompare(String(b.at || "")) || String(a.uid || "").localeCompare(String(b.uid || ""));
    };
    const byMember = new Map();
    for(const it of (Array.isArray(items) ? items : [])){
      if(!it || typeof it !== "object") continue;
      const key = it.memberId ? "m:" + it.memberId : "u:" + it.uid;
      if(!byMember.has(key)) byMember.set(key, []);
      byMember.get(key).push(it);
    }
    const cards = [];
    for(const list of byMember.values()){
      list.sort(cmp);
      const first = list[0], last = list[list.length - 1];
      cards.push({ memberId: first.memberId || "", name: last.name || "", code: last.code || "", groupName: last.groupName || "",
                   gid: last.gid || "", groupMissing: list.some(it => it.groupMissing === true),
                   items: list, oldestAt: first.sat || first.at || "" });
    }
    cards.sort((a, b) => cmp(a.items[0], b.items[0]));
    return cards;
  }

  /* 在所有分組裡找同名的成員(去掉所有空白後完全比對)。
     夥伴被刪除重建或換組之後,舊請求的 memberId 找不到人;用名字提示組長「他可能在這裡」,
     讓內容有地方轉抄,而不是只能按不採用(乙 12)。 */
  function findMembersByName(groups, name){
    const want = String(name == null ? "" : name).replace(/\s+/g, "");
    if(!want) return [];
    const out = [];
    for(const g of (Array.isArray(groups) ? groups : [])){
      if(!g || !Array.isArray(g.members)) continue;
      for(const m of g.members){
        if(m && String(m.name == null ? "" : m.name).replace(/\s+/g, "") === want){
          out.push({ code: String(g.code == null ? "" : g.code), groupName: String(g.name == null ? "" : g.name),
                     memberId: String(m.id == null ? "" : m.id), name: String(m.name) });
        }
      }
    }
    return out;
  }

  /* 給轉抄用的純文字:夥伴已經不在名錄上(刪除或換組)時,組長複製下來貼到他現在的成員卡。
     清單逐項列出,備註也放進來 —— 備註裡常常就是「我換到 B2 組了」這種線索。 */
  function memberUpdateCopyText(req){
    const r = req || {};
    const changes = r.changes && typeof r.changes === "object" ? r.changes : {};
    const label = canonText(r.label) || memberUpdateLabel(r.code == null ? "" : r.code, r.name == null ? "" : r.name);
    const when = updateMonthDay(r.sat || r.at);
    const lines = [label + " 在 " + (when || "?") + " 送來的資料更新"];
    for(const f of UPDATE_FIELD_ORDER){
      if(!hasOwn(changes, f)) continue;
      const c = canonUpdateValue(f, changes[f]);
      if(isListField(f)){
        lines.push("【" + fieldLabel(f) + "】");
        for(const t of c) lines.push("・" + t);
      }else{
        lines.push("【" + fieldLabel(f) + "】" + c);
      }
    }
    /* 照片沒辦法放進純文字,只說有幾張、去哪裡拿 —— 不講的話,組長貼完文字就以為轉抄完了 */
    const PHOTO_SHORT = { image:"形象照", card:"名片", products:"商品照" };
    const photos = memberUpdatePhotos(r);
    if(photos.length){
      lines.push("另外傳了照片：" + photos.map(p => PHOTO_SHORT[p.field] + " " + p.incoming.length + " 張").join("、") +
                 "（照片請在後台查看、另存）。");
    }
    if(r.confirmOnly === true) lines.push("本人確認資料正確，沒有要修改。");
    const note = canonText(r.note);
    if(note) lines.push("【給組長的備註】" + note);
    return lines.join("\n");
  }

  /* 草稿衝突時,線上版本裡「夥伴自己送來、已經套用」的更新會被草稿蓋掉的成員姓名(乙 4)。
     判斷:線上這位有 lastUpdateFrom(套用時寫入的請求 uid),草稿裡同一個 id 的人沒有,
     或是記的是別的 uid —— 代表草稿是在那次套用之前存的。
     草稿把他整個刪掉的不算:那是草稿主人刻意的操作,原本的衝突提示就涵蓋了。 */
  function overwrittenMemberUpdates(liveGroup, draftGroup){
    const live = liveGroup && Array.isArray(liveGroup.members) ? liveGroup.members : [];
    const draft = draftGroup && Array.isArray(draftGroup.members) ? draftGroup.members : [];
    const draftById = new Map();
    for(const d of draft) if(d && d.id) draftById.set(d.id, d);
    const out = [];
    for(const m of live){
      if(!m || !m.id || !m.lastUpdateFrom) continue;
      const d = draftById.get(m.id);
      if(d && d.lastUpdateFrom !== m.lastUpdateFrom) out.push(String(m.name == null ? "" : m.name));
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════
     舊草稿 × 線上版本的三方合併
     ══════════════════════════════════════════════════════════════════════
     10/1 事故:一台電腦的瀏覽器裡留著 8 月初的草稿,後台開起來就自動載入它;發布時衝突確認
     只給「繼續 = 用你的版本覆蓋」這個選項,一按確定,6 個組檔被**整檔**換回 8 月的版本 ——
     9 月才加入的夥伴被刪掉、已刪的人復活、別人補的公司名稱與照片全部消失。
     那份草稿其實一個字都沒改過。

     根本原因是「整檔覆蓋」:草稿裡只要有一組跟線上不一樣,整組就用草稿的。
     這裡改成三方比較 —— base(草稿當初的來源版本)、draft(草稿)、live(線上現況)——
     **只有草稿真的改過的人、改過的欄位**才寫上去,其他一律用線上的。草稿沒改過的東西,
     就算它比線上舊,也不會蓋回去。 */

  /* 穩定的 JSON:物件的鍵排序後才 stringify。深度相等一律用它比。
     同一位夥伴的資料經過不同的路(後台編輯、Worker 套用更新、同步 Action)寫出來,鍵的順序
     可能不一樣;直接比 JSON.stringify 會把「內容一樣、順序不同」判成改過,那個人就會被當成
     草稿的修改寫回去 —— 正是這次要防的事。 */
  function stableJson(v){
    if(v === undefined) return undefined;
    return JSON.stringify(v, (k, x) => {
      if(!x || typeof x !== "object" || Array.isArray(x)) return x;
      const o = {};
      for(const key of Object.keys(x).sort()) o[key] = x[key];
      return o;
    });
  }
  const sameJson = (a, b) => stableJson(a) === stableJson(b);
  const cloneJson = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const isPlainObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  /* 成員清單 → 依 id 對應的鍵。沒有 id 的(理論上不會有)用整筆內容當鍵:沒改就對得上,
     改了就是「刪一筆、加一筆」,一樣走得通。同一個 id 出現兩次(發布前的檢查會擋,但草稿裡
     可能有)第二筆加上序號,不會把其中一筆吃掉。 */
  function keyMembers(list){
    const keys = [], map = new Map(), seen = new Map();
    for(const m of (Array.isArray(list) ? list : [])){
      let k = isPlainObj(m) && typeof m.id === "string" && m.id ? "id:" + m.id : "raw:" + stableJson(m);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if(n > 1) k += "#" + n;
      keys.push(k);
      map.set(k, m);
    }
    return { keys, map };
  }
  const memberIdOf = m => isPlainObj(m) && typeof m.id === "string" ? m.id : "";
  const memberNameOf = m => isPlainObj(m) && m.name != null ? String(m.name) : "";

  /* 兩個時間戳取比較晚的那個;看不懂的那個輸。兩個都看不懂 → 用線上的(b)。 */
  function laterStamp(a, b){
    const ta = Date.parse(a == null ? "" : a), tb = Date.parse(b == null ? "" : b);
    if(isFinite(ta) && isFinite(tb)) return ta > tb ? a : b;
    if(isFinite(ta)) return a;
    return b;
  }

  /* 兩個除了 updatedAt 以外完全一樣。合併出來只差修改時間的人不算「改過」——
     否則一個「打了字又改回去」的欄位(touch() 會蓋章)也會讓整個組檔被重寫。 */
  function sameExceptStamp(a, b){
    if(!isPlainObj(a) || !isPlainObj(b)) return sameJson(a, b);
    const strip = o => { const c = Object.assign({}, o); delete c.updatedAt; return c; };
    return sameJson(strip(a), strip(b));
  }

  /* 同一位夥伴兩邊都改過:逐欄合併。
     只有草稿改的欄位 → 草稿;只有線上改的 → 線上;兩邊改成一樣 → 那個值;
     兩邊改成不一樣 → **線上**,記一筆衝突(寧可少寫一欄,也不要蓋掉別人後來的修改)。
     updatedAt 例外:兩邊都改了就取比較晚的,那不是內容衝突。
     輸出的鍵順序跟線上一樣(線上沒有的鍵接在後面),內容沒變的時候寫出來的檔才會逐字相同。 */
  function mergeMemberFields(b, d, l, conflicts){
    const keys = Object.keys(l);
    for(const k of Object.keys(d)) if(keys.indexOf(k) < 0) keys.push(k);
    for(const k of Object.keys(b)) if(keys.indexOf(k) < 0) keys.push(k);
    const out = {};
    for(const k of keys){
      if(k === "__proto__") continue;
      const fb = b[k], fd = d[k], fl = l[k];
      let v;
      if(sameJson(fb, fd)) v = fl;                 // 草稿沒改這一欄
      else if(sameJson(fb, fl)) v = fd;            // 只有草稿改了
      else if(sameJson(fd, fl)) v = fl;            // 兩邊改成一樣
      else if(k === "updatedAt") v = laterStamp(fd, fl);
      else {
        v = fl;
        conflicts.push({ id: memberIdOf(l) || memberIdOf(d), name: memberNameOf(l) || memberNameOf(d), kind:"field", field:k });
      }
      if(v !== undefined) out[k] = cloneJson(v);
    }
    return out;
  }

  /* 依「來源順序」把還沒放進去的鍵插進 out:插在來源裡它前一位、而且已經在 out 裡的人後面,
     找不到就放最前面。依來源順序逐一處理,連續新增的幾個人會照原本的先後接在一起。 */
  function weaveKeys(out, srcKeys, want){
    for(let i = 0; i < srcKeys.length; i++){
      const k = srcKeys[i];
      if(!want.has(k) || out.indexOf(k) >= 0) continue;
      let at = 0;
      for(let j = i - 1; j >= 0; j--){
        const p = out.indexOf(srcKeys[j]);
        if(p >= 0){ at = p + 1; break; }
      }
      out.splice(at, 0, k);
    }
    return out;
  }
  const sameSeq = (x, y) => x.length === y.length && x.every((k, i) => k === y[i]);

  const GROUP_MERGE_FIELDS = ["leader", "room", "recruiting"];

  /* mergeGroupThreeWay(base, draft, live) → { group, report }
     三個參數都是組物件 { leader, room, recruiting, members:[...] }(base 由呼叫端從草稿的
     loadedBody parse 出來)。group 只有這四個鍵,代號、組名、id 由呼叫端保留。

     成員(以 id 對應):
       草稿沒改(base 與 draft 深度相等,含兩邊都不存在) → 用線上的(線上沒有就是不存在)
       草稿改了、線上沒改 → 用草稿的(草稿沒有 = 刪除)
       兩邊都改了:
         兩邊都刪                → 不存在
         草稿刪、線上改          → **保留線上**,衝突 kept_deleted_edited
         草稿改、線上刪          → **維持刪除**,衝突 edited_but_deleted
         base 沒有、兩邊各自新增 → 用線上的(內容不同時記衝突 both_added)
         兩邊都改                → 逐欄合併(mergeMemberFields)
     組層級欄位(組長、地點、招募席位)同樣三方逐欄判斷,衝突用線上並記 group_field。

     成員順序:線上沒有調整順序(base 與 live 共有的人先後一樣)→ 用草稿的順序;否則用線上的。
     另一邊才有的人插在「那一邊裡他前一位、而且合併後也存在的人」後面,找不到就放最前面。

     report = { applied, conflicts, reordered, untouched }
       applied   只列「因為草稿而跟線上不一樣」的地方:
                 { id, name, kind:"added"|"removed"|"changed", fields } 成員;
                 { id:"", name:"", kind:"group", fields } 組層級欄位
       reordered 草稿調整了成員的先後(只有順序不同,沒有任何欄位不同時也會寫檔)
       untouched 整組沒有要寫的 —— 這時 group 與 live 內容逐字相同 */
  function mergeGroupThreeWay(base, draft, live){
    const B0 = isPlainObj(base) ? base : {}, D0 = isPlainObj(draft) ? draft : {}, L0 = isPlainObj(live) ? live : {};
    const B = keyMembers(B0.members), D = keyMembers(D0.members), L = keyMembers(L0.members);
    const applied = [], conflicts = [];
    const result = new Map();

    const all = [];
    for(const k of L.keys.concat(D.keys, B.keys)) if(all.indexOf(k) < 0) all.push(k);
    for(const k of all){
      const inB = B.map.has(k), inD = D.map.has(k), inL = L.map.has(k);
      const b = B.map.get(k), d = D.map.get(k), l = L.map.get(k);
      const draftChanged = inB !== inD || (inB && !sameJson(b, d));
      if(!draftChanged){ if(inL) result.set(k, l); continue; }
      const liveChanged = inB !== inL || (inB && !sameJson(b, l));
      if(!liveChanged){ if(inD) result.set(k, d); continue; }
      if(!inD && !inL) continue;                                         // 兩邊都刪了
      if(!inD){                                                          // 草稿刪、線上改 → 保留線上
        result.set(k, l);
        conflicts.push({ id: memberIdOf(l), name: memberNameOf(l), kind:"kept_deleted_edited" });
        continue;
      }
      if(!inL){                                                          // 草稿改、線上刪 → 維持刪除
        conflicts.push({ id: memberIdOf(d), name: memberNameOf(d), kind:"edited_but_deleted" });
        continue;
      }
      if(!inB){                                                          // 兩邊各自新增同一個 id
        result.set(k, l);
        if(!sameJson(d, l)) conflicts.push({ id: memberIdOf(l), name: memberNameOf(l), kind:"both_added" });
        continue;
      }
      if(!isPlainObj(b) || !isPlainObj(d) || !isPlainObj(l)){            // 不是物件(壞資料):線上為準
        result.set(k, l);
        if(!sameJson(d, l)) conflicts.push({ id: memberIdOf(l), name: memberNameOf(l), kind:"field", field:"" });
        continue;
      }
      result.set(k, mergeMemberFields(b, d, l, conflicts));
    }

    // 合併後只差修改時間的人,直接用線上那一份(見 sameExceptStamp)
    for(const [k, v] of result){
      if(L.map.has(k) && v !== L.map.get(k) && sameExceptStamp(v, L.map.get(k))) result.set(k, L.map.get(k));
    }

    // 成員順序
    const want = new Set(result.keys());
    const liveReordered = !sameSeq(B.keys.filter(k => L.map.has(k)), L.keys.filter(k => B.map.has(k)));
    const order = liveReordered
      ? weaveKeys(L.keys.filter(k => want.has(k)), D.keys, want)
      : weaveKeys(D.keys.filter(k => want.has(k)), L.keys, want);
    weaveKeys(order, all, want);      // 保險:任何還沒放進去的(理論上沒有)照出現順序補上

    // applied:最後結果跟線上比
    for(const k of order){
      const v = result.get(k);
      if(!L.map.has(k)){
        applied.push({ id: memberIdOf(v), name: memberNameOf(v), kind:"added", fields:[] });
      }else if(v !== L.map.get(k) && !sameJson(v, L.map.get(k))){
        const l = L.map.get(k);
        const keys = Object.keys(isPlainObj(v) ? v : {});
        for(const f of Object.keys(isPlainObj(l) ? l : {})) if(keys.indexOf(f) < 0) keys.push(f);
        applied.push({ id: memberIdOf(v), name: memberNameOf(v), kind:"changed",
                       fields: keys.filter(f => f !== "updatedAt" && !sameJson(v[f], l[f])) });
      }
    }
    for(const k of L.keys){
      if(!want.has(k)){
        const l = L.map.get(k);
        applied.push({ id: memberIdOf(l), name: memberNameOf(l), kind:"removed", fields:[] });
      }
    }

    // 組層級欄位
    const group = {};
    const groupFields = [];
    for(const f of GROUP_MERGE_FIELDS){
      const fb = B0[f], fd = D0[f], fl = L0[f];
      let v;
      if(sameJson(fb, fd)) v = fl;
      else if(sameJson(fb, fl)) v = fd;
      else if(sameJson(fd, fl)) v = fl;
      else { v = fl; conflicts.push({ id:"", name:"", kind:"group_field", field:f }); }
      if(!sameJson(v, fl)) groupFields.push(f);
      if(v !== undefined) group[f] = cloneJson(v);
    }
    if(groupFields.length) applied.unshift({ id:"", name:"", kind:"group", fields: groupFields });
    group.members = order.map(k => cloneJson(result.get(k)));

    const common = order.filter(k => L.map.has(k));
    const reordered = !sameSeq(common, L.keys.filter(k => want.has(k)));
    return { group, report: { applied, conflicts, reordered, untouched: !applied.length && !reordered } };
  }

  /* 這次發布會刪掉哪些夥伴(要記進回收區,刪錯了可以一鍵救回)。
     liveGroups:這次會寫到或刪掉的組檔,在線上的樣子 —— [{ gid, code, members }]。
                 分組改代號時,舊檔(會被刪掉的那個)也要放進來,否則改名那一次刪掉的人不會被記到。
     sentGroups:發布之後的所有分組(手上整份 DATA)。
     回傳「線上有、發布之後哪一組都沒有」的人:[{ gid, code, index, member }],
     index 是他在線上那組的位置(救回時放回原位用),member 是線上那一份完整資料。
     同一個 id 搬到別組不算刪除 —— 他還在名錄上,救回反而會變成兩個人。
     movedFrom:後台「換到別組」留下的 { 新 id: 線上的舊 id }。換組會換 id(id 開頭必須是
                所屬組的內部 id,Worker 靠它做跨組授權),舊 id 因此從名錄上消失;但只要新 id
                還在,這個人就沒被刪,不能進回收區。新 id 也不在了(換組後又被刪)才算刪除。 */
  function removedMembers(liveGroups, sentGroups, movedFrom){
    const kept = new Set();
    const alias = isPlainObj(movedFrom) ? movedFrom : {};
    for(const g of (Array.isArray(sentGroups) ? sentGroups : [])){
      for(const m of (g && Array.isArray(g.members) ? g.members : [])){
        const id = memberIdOf(m);
        if(!id) continue;
        kept.add(id);
        if(Object.prototype.hasOwnProperty.call(alias, id) && typeof alias[id] === "string") kept.add(alias[id]);
      }
    }
    const out = [], seen = new Set();
    for(const g of (Array.isArray(liveGroups) ? liveGroups : [])){
      if(!g || !Array.isArray(g.members)) continue;
      const gid = String(g.gid != null ? g.gid : (g.id != null ? g.id : ""));
      g.members.forEach((m, index) => {
        const id = memberIdOf(m);
        if(!id || kept.has(id) || seen.has(id)) return;
        seen.add(id);
        out.push({ gid, code: String(g.code == null ? "" : g.code), index, member: m });
      });
    }
    return out;
  }

  return { computeConflicts, computeRenameRemovals, isPrimaryTab, pendingNotice, makeSingleFlight,
           FIELD_LABELS, PHOTO_LABELS, UPDATE_FIELD_ORDER, UPDATE_PHOTO_FIELDS, UPDATE_PRODUCTS_MAX,
           LIST_FIELDS, UPDATE_LATE_MS, UPDATE_HASH_EMPTY, fieldLabel,
           memberUpdateLabel, canonUpdateValue, sameUpdateValue, updateValueHash, memberUpdateToken,
           memberPrefillValues, updatePrefillUrl, withExternalBrowser, listDiff, mergeList, websiteHost,
           updateTimeText, updateMonthDay, updateWaitDays,
           memberUpdateHeader, memberUpdateRows, memberUpdatePhotos, memberUpdateExtras, memberUpdateNotice,
           groupMemberUpdates, findMembersByName, memberUpdateCopyText, overwrittenMemberUpdates,
           stableJson, sameJson, mergeGroupThreeWay, removedMembers };
})();
if(typeof module !== "undefined" && module.exports) module.exports = AdminLogic;
