/* 會員名錄・後台編輯器
   ══════════════════════════════════════════════════════════════
   目錄(節區依出現順序,搜尋「---------- 節區名」可跳轉):
     state                    共用狀態與 DOM 參照
     undo / redo              上一步/重做(最多 10 步)
     draft persistence        草稿自動存 localStorage
     toast                    提示訊息(可帶動作按鈕)
     helpers / validation     小工具與資料檢查
     image crop + resize      成員照裁切(4:4.6)與名片/商品照縮圖
     render: sidebar / main   畫面渲染
     mutations                增刪改(結構性動作先 pushUndo)
     export                   data.js 備份下載
     CSV 匯出                 欄位定義共用 csv-schema.js
     缺資料清單               催收訊息產生器(附表單連結)
     批次預覽視窗             CSV/PPT 共用的差異預覽 modal
     publish relay            經 Cloudflare Worker 發布(密碼與 token 都在 Worker)
     lock screen / settings   登入鎖與設定(Worker 網址、表單 CSV 網址)
     Worker 能力偵測+發布附件 照片實體檔;分享頁由 GitHub Action 重建
     leave-to-site guard      離開前提醒未發布變更
     small utils              esc/clone/byId 等
     分會總覽儀表板           即時統計+工具捷徑
     boot                     事件接線與初始化
   ══════════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  /* 草稿鍵含角色範圍:組長只握有自己那組,不能跟總管理員的整份草稿混用。
     ★ 這個範圍在登入當下就固定下來,不再每次即時計算。
     原本 draftKey() 讀的是即時的 currentSession() —— session 過期之後 myRole() 會退回
     預設的 "owner",於是 isLeader() 變成 false,草稿鍵從「組長那一份」悄悄變成「總管理員
     那一份」。結果是:session 過期後繼續編輯的內容全部寫到別人的鍵上,重新登入時讀回來的
     是過期前的舊草稿,中間那段編輯**靜默消失**,而橫幅照樣顯示「尚未發布的變更」。
     共用電腦上還會反過來污染總管理員的草稿。 */
  const DRAFT_PREFIX = "member-directory-draft-v2:";
  let draftScope = null;
  function lockDraftScope(){ draftScope = isLeader() ? myGroupCode().toLowerCase() : "all"; }
  function draftKey(){
    return DRAFT_PREFIX + (draftScope != null ? draftScope : (isLeader() ? myGroupCode().toLowerCase() : "all"));
  }
  const glist = document.getElementById("glist");
  const main = document.getElementById("adm-main");
  const saveState = document.getElementById("save-state");
  const validationBox = document.getElementById("validation");
  const toastEl = document.getElementById("toast");
  const draftBanner = document.getElementById("draft-banner");

  const ICON = {
    up:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    cam:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
    warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  };

  /* ---------- state ---------- */
  const clone = o => JSON.parse(JSON.stringify(o));
  /* ---------- 資料來源:data/ 底下的分組檔 ----------
     真實來源是 data/_index.json(分會結構)與 data/<代號>.json(各組內容);
     根目錄的 data.js 只是給前台用的產出物,由 GitHub Action 合併產生,後台不讀也不寫。
     組長只會載入自己那一組,總管理員載入全部。 */
  let DATA = [];
  let INDEX = [];              // [{code,name,id}...],決定分組順序
  const loadedBody = {};       // 路徑 → 載入當下的檔案內容(用來判斷「這組有沒有被改過」)
  const baseHashes = {};       // 路徑 → 載入當下的 SHA-256(草稿的三方比較用)
  /* 路徑 → 載入當下的 git blob sha。發布時一併送給 Worker:它拿一次 recursive tree
     就能比對全部檔案,不必為了版本檢查逐檔重讀(子請求預算很緊,見 Worker 的說明)。 */
  const baseBlobShas = {};
  /* 分組 id → 載入當下的檔案路徑。改名時要靠它知道「舊檔是哪一個」並一起刪掉 ——
     否則舊檔會留下來變成孤兒:build-data.mjs 只讀 _index 列出的檔,而持有舊分頁的
     組長還能繼續寫進去,兩邊都顯示成功,資料卻永遠不會出現在網站上。 */
  const originalPathByGroupId = {};
  /* 路徑 → 「上一次發布送出去的內容」。送出前就寫進草稿,收到成功回應才清掉。
     用途只有一個:發布其實已經寫進 GitHub、但這邊沒記到成功時(回應在網路上逾時遺失,
     或同一次請求裡前面的檔寫成功、後面的失敗),重新整理後靠它認出「那次其實成功了」,
     把 baseHashes 對齊到線上版本 —— 否則 baseHashes 會一直停在舊值,而 repo 已是新內容,
     每次發布都被判成版本落後(stale_base),而且訊息還謊稱「有人在你編輯期間發布過」,
     連重新整理都救不回來(草稿會把舊 baseHashes 再蓋回去),只能捨棄草稿、連帶丟掉還沒
     發布的修改。見 reconcileWithLive()。 */
  const sentBody = {};
  /* 「草稿的來源版本」與「線上現況」對不起來的路徑。這些路徑在使用者明確表態之前
     不會被送出去 —— 見 tryLoadDraft() 的三方比較與 publish() 的閘門。 */
  const conflictPaths = new Set();

  const dataPathOf = code => "data/" + String(code).trim().toLowerCase() + ".json";
  /* 分組代號只能是英數字:它同時是檔名(data/<代號>.json)與權限的判定依據。
     新增分組時預設代號是「新」,沒改就發布會被 Worker 擋下,所以檢查表要先講。 */
  const GROUPCODE_RE = /^[A-Za-z0-9]{1,8}$/;
  const DATA_PATH_RE = /^data\/(_index|_pending|[a-z0-9]{1,8})\.json$/;
  const PENDING_PATH = "data/_pending.json";
  let PENDING = [];        // 新夥伴自填表單送來、還沒被任何組長認領的申請
  const GROUP_BODY_KEYS = ["leader", "room", "members", "recruiting"];
  /* 分組物件的鍵順序要與 tools/build-data.mjs 一致,否則合併出來的 data.js 會有無意義的差異 */
  function groupBody(g){
    const o = {};
    for(const k of GROUP_BODY_KEYS) o[k] = g[k] ?? (k === "members" || k === "recruiting" ? [] : "");
    return o;
  }
  const serializeBody = body => JSON.stringify(body, null, 2) + "\n";

  function utf8ToB64(str){
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for(const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64ToUtf8(b64){
    return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  }
  async function sha256Hex(bytes){
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  /* 從公開網站(GitHub Pages)讀。這是**最終一致**的來源:任何人發布後要 1~4 分鐘
     才會重新部署。只在 Worker 太舊、沒有 /read 端點時才走這條。 */
  async function fetchFromPages(path){
    const res = await fetch(path + "?ts=" + Date.now(), { cache: "no-store" });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error(path + " HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    return { json: JSON.parse(text), text, hash: await sha256Hex(buf) };
  }

  /* ★ 一次把要的檔案從 Worker 讀回來(權威來源)。
     為什麼不再直接讀 data/*.json:相對路徑讀到的是 GitHub Pages 上的**已部署**版本,
     而 Worker 驗證版本時讀的是 GitHub API(repo 的當下狀態)。兩者的一致性時機不同,
     所以任何人發布後的 1~4 分鐘內,其他人載入編輯頁拿到的是**必定過期**的版本基準:
     發布一定被判 stale_base,而提示叫他「重新整理取得最新資料」——重新整理拿到的還是
     同一份舊內容,於是形成迴圈。待認領區更嚴重:它會列出已經被別人認領走的人,
     按下去就是重複認領。
     改走 Worker 之後,載入與驗證來自同一個立即一致的來源。 */
  let pagesFallbackWarned = false;
  async function fetchMany(paths){
    const session = loadSession();
    if(workerCaps.read && session){
      const res = await workerFetch("/read", { session, paths });
      if(res && res.ok && res.files){
        const out = {};
        for(const p of paths){
          const f = res.files[p];
          out[p] = (f && f.exists)
            ? { json: JSON.parse(f.text), text: f.text, hash: f.hash, blobSha: f.blobSha }
            : null;
        }
        return out;
      }
      // 讀不到就不要靜默改用落後的來源當版本基準 —— 那正是死迴圈的來源
      throw new Error("read_failed:" + ((res && res.error) || "unknown"));
    }
    if(!pagesFallbackWarned){
      pagesFallbackWarned = true;
      toast("發布服務尚未升級，資料改從公開網站讀取；剛發布過的內容可能還沒同步過來。",
            { warn:true, duration:8000 });
    }
    const out = {};
    for(const p of paths) out[p] = await fetchFromPages(p);
    return out;
  }
  /* 依角色載入:總管理員 13 個檔,組長 2 個(結構 + 自己那組) */
  async function loadData(){
    await ensureCaps();     // 要先知道 Worker 支不支援 /read 才決定從哪讀
    const IDX = "data/_index.json";
    const first = await fetchMany([IDX]);
    if(!first[IDX]) throw new Error("讀不到 " + IDX);
    INDEX = first[IDX].json;
    baseHashes[IDX] = first[IDX].hash;
    baseBlobShas[IDX] = first[IDX].blobSha || "";
    loadedBody[IDX] = first[IDX].text;

    const code = myGroupCode().trim().toLowerCase();
    const wanted = isLeader() ? INDEX.filter(e => String(e.code).trim().toLowerCase() === code) : INDEX;
    const paths = wanted.map(e => dataPathOf(e.code));
    /* 待認領區:新夥伴自填表單送來的申請。所有角色都載入——組長要能認領自己那組的人。
       檔案可能還不存在(還沒有人申請過),那不是錯誤,當成空清單。 */
    const got = await fetchMany(paths.concat([PENDING_PATH]));

    const next = [];
    for(const e of wanted){
      const path = dataPathOf(e.code);
      const f = got[path];
      if(!f) throw new Error("讀不到 " + path);
      baseHashes[path] = f.hash;
      baseBlobShas[path] = f.blobSha || "";
      originalPathByGroupId[e.id] = path;      // 改名時要靠它刪掉舊檔
      loadedBody[path] = serializeBody(groupBody(f.json));
      next.push({ code: e.code, name: e.name, leader: f.json.leader ?? "", room: f.json.room ?? "",
                  members: f.json.members ?? [], id: e.id, recruiting: f.json.recruiting ?? [] });
    }
    DATA = next;

    const p = got[PENDING_PATH];
    if(p){
      PENDING = Array.isArray(p.json) ? p.json : [];
      baseHashes[PENDING_PATH] = p.hash;
      baseBlobShas[PENDING_PATH] = p.blobSha || "";
      loadedBody[PENDING_PATH] = p.text;
    } else {
      PENDING = [];
      delete baseHashes[PENDING_PATH];
      delete baseBlobShas[PENDING_PATH];
      loadedBody[PENDING_PATH] = null;
    }
    fixSelected();
  }
  let selected = DATA.length ? DATA[0].id : null;
  let saveTimer = null;
  let hasDraft = false;
  let dirty = false;   // 只有真的改過東西才需要在關閉前搶救草稿

  function uid(prefix){
    return prefix + "_" + Date.now().toString(36) + Math.floor(Math.random()*1e5).toString(36);
  }

  /* ---------- undo / redo（最多往前 10 步） ---------- */
  const HISTORY_LIMIT = 10;
  let undoStack = [];
  let redoStack = [];
  let pendingSnap = null;   // 文字編輯：進欄位時先拍照，第一次輸入才真正入堆疊 → 一次編輯＝一步
  function updateHistoryButtons(){
    const u = byId("btn-undo"), r = byId("btn-redo");
    if(u){ u.disabled = undoStack.length === 0; u.title = "上一步" + (undoStack.length ? "（剩 " + undoStack.length + " 步）" : "（已到最初）"); }
    if(r){ r.disabled = redoStack.length === 0; }
  }
  /* 一步 = 分組資料 + 待認領區的整體狀態。認領新夥伴會同時動到兩邊,
     只記其中一邊會讓「復原」把成員收回去、卻沒把申請放回待認領區。 */
  const snapshot = () => ({ data: clone(DATA), pending: clone(PENDING) });
  const restore = s => { DATA = s.data; PENDING = s.pending || []; };
  /* 這三個是所有結構性變更的共同前置與回溯點,唯讀帳號一律不動。
     擋在函式本體而不是按鈕上 —— Ctrl+Z / Ctrl+Y 不經過按鈕。 */
  function pushUndo(){
    if(isViewer()) return;
    undoStack.push(snapshot());
    if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    pendingSnap = null;
    updateHistoryButtons();
  }
  /* 選到的分組必須是「這個角色看得到的」——組長被指派的組被刪或改代號時會退回無選取 */
  function fixSelected(){
    const groups = visibleGroups();
    if(!groups.some(g => g.id === selected)) selected = groups.length ? groups[0].id : null;
  }
  function undo(){
    if(isViewer() || !undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    fixSelected(); renderAll(); validate(); saveDraft(); updateHistoryButtons();
    toast("已回上一步");
  }
  function redo(){
    if(isViewer() || !redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    fixSelected(); renderAll(); validate(); saveDraft(); updateHistoryButtons();
    toast("已重做");
  }

  /* ---------- draft persistence ---------- */
  /* ★ 跨分頁協調。原本完全沒有:兩個分頁共用同一個草稿鍵,各自無條件整份覆寫,
     後存的把先存的整份蓋掉;而其中一個分頁發布成功並清掉草稿之後,另一個分頁下一次
     按鍵又會把「發布前」的狀態寫回去 —— 於是橫幅顯示「尚未發布的變更」而內容是舊版,
     接著發布就撞上版本落後。
     這裡不做複雜的合併:偵測到同一個範圍已經有分頁開著,後開的那個就停止自動存草稿
     (記憶體裡照樣能編輯、也能發布),並且明白告訴使用者。不寫,就不會蓋掉對方。 */
  let tabChannel = null, tabIsSecondary = false;
  const TAB_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const tabPeers = new Map();            // 其他分頁的 id → 最後一次聽到它的時間
  const TAB_BEAT_MS = 2000, TAB_STALE_MS = 5000;
  /* 誰是 primary 由 id 的字典序決定 —— 每個分頁各自算,結論必然一致,不需要協商,
     也不會出現「兩邊都把自己標成 secondary」而全都不存草稿的情況。
     原分頁關掉之後心跳就停了,5 秒內會被清掉,剩下的分頁自動接手(原本永遠接不了手)。 */
  function recomputePrimary(){
    const now = Date.now();
    for(const [id, t] of tabPeers){ if(now - t > TAB_STALE_MS) tabPeers.delete(id); }
    const was = tabIsSecondary;
    tabIsSecondary = !AdminLogic.isPrimaryTab(TAB_ID, [...tabPeers.keys()]);
    if(tabIsSecondary && !was){
      toast("另一個分頁已經開著同一份後台。為避免兩邊的草稿互相覆蓋，這個分頁不會自動儲存草稿——" +
            "請關掉其中一個分頁再繼續編輯。", { warn:true, duration:15000 });
    } else if(!tabIsSecondary && was){
      toast("另一個分頁已關閉，這個分頁恢復自動儲存草稿。", { duration:6000 });
      saveDraft();
    }
  }
  function startTabGuard(){
    if(typeof BroadcastChannel === "undefined") return;
    try{ tabChannel = new BroadcastChannel("member-directory-admin:" + draftKey()); }catch(e){ return; }
    tabChannel.onmessage = ev => {
      const d = ev && ev.data || {};
      if(!d.id || d.id === TAB_ID) return;
      if(d.type === "bye") tabPeers.delete(d.id); else tabPeers.set(d.id, Date.now());
      recomputePrimary();
    };
    const beat = () => {
      try{ tabChannel.postMessage({ type:"beat", id:TAB_ID }); }catch(e){}
      recomputePrimary();
    };
    beat();
    setInterval(beat, TAB_BEAT_MS);
    window.addEventListener("beforeunload", () => {
      try{ tabChannel.postMessage({ type:"bye", id:TAB_ID }); }catch(e){}
    });
  }
  function showDraftBanner(on){ draftBanner.classList.toggle("show", !!on); }
  /* 唯讀帳號不留草稿。除了「本來就沒東西可存」之外還有一個實際理由:草稿的鍵對
     非組長一律是 "all",同一台電腦上唯讀帳號與總管理員會共用同一份 —— 唯讀帳號
     會載到別人還沒發布的內容,自己的暫存也會反過來污染對方。 */
  function saveDraft(){
    if(isViewer()) return;
    /* 同一個範圍已經有別的分頁開著:不寫,就不會蓋掉對方的草稿。
       記憶體裡的編輯不受影響,也還是可以發布 —— 只是這台裝置上不留自動備份。 */
    if(tabIsSecondary){
      saveState.textContent = "⚠ 另一個分頁開著同一份後台，這裡不自動儲存草稿（避免互相覆蓋）";
      return;
    }
    try{
      /* 連 baseHashes 與 loadedBody 一起存。只存資料的話,下次開頁面的流程是
         「先載線上最新版(拿到新的雜湊)→ 再用舊草稿蓋掉資料」,發布時送出的就變成
         「舊內容 + 新雜湊」—— Worker 的版本落後偵測比對的是雜湊,完全看不出異常,
         於是別人在這期間發布的修改會被這份舊草稿無聲蓋回去。 */
      localStorage.setItem(draftKey(), JSON.stringify({
        savedAt: Date.now(), data: DATA, pending: PENDING,
        baseHashes: baseHashes, loadedBody: loadedBody, sentBody: sentBody,
      }));
      saveState.textContent = "已自動儲存 " + new Date().toLocaleTimeString("zh-Hant",{hour:"2-digit",minute:"2-digit"});
      showDraftBanner(true);
      dirty = false;
      renderDash();   // 儀表板數字跟著草稿即時更新
    }catch(e){
      saveState.textContent = "⚠ 無法自動儲存草稿（瀏覽器儲存空間不足或被封鎖）— 發布前請勿關閉此分頁，並建議先「下載備份」";
    }
  }
  function scheduleSave(){ dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); }
  function manualSave(){
    clearTimeout(saveTimer);
    /* ★ 這個分頁不是 primary 時 saveDraft() 其實什麼都不會寫,原本卻照樣回報
       「已暫存到這台裝置」—— 使用者因此以為東西存起來了,關掉分頁就沒了。 */
    if(tabIsSecondary){
      toast("這個分頁沒有在儲存草稿（另一個分頁開著同一份後台），所以**沒有暫存**。" +
            "請關掉另一個分頁再存一次，或直接按「發布到網站」。", { warn:true, duration:11000 });
      return;
    }
    saveDraft();   // 立即寫入瀏覽器草稿
    toast("已暫存到這台裝置（尚未發布到網站）");
  }

  // Silently continue from any saved draft (no scary modal); a banner shows there are unpublished changes.
  function tryLoadDraft(){
    if(isViewer()) return;   // 唯讀帳號一律看線上的真實資料,不吃任何草稿(見 saveDraft)
    let raw; try{ raw = localStorage.getItem(draftKey()); }catch(e){ return; }
    if(!raw) return;
    let parsed; try{ parsed = JSON.parse(raw); }catch(e){ return; }
    if(!parsed || !Array.isArray(parsed.data) || !parsed.data.length) return;
    /* 先留住 loadData() 剛抓到的線上實況 —— 下面會被草稿蓋掉,但 reconcileWithLive()
       需要拿它跟「上次送出去的內容」比對,才認得出「其實已經發布成功了」。 */
    const liveHashes = Object.assign({}, baseHashes);
    const liveBody = Object.assign({}, loadedBody);
    DATA = parsed.data;
    // 舊版草稿沒有 pending 欄位,那時就沿用剛從伺服器載到的清單
    if(Array.isArray(parsed.pending)) PENDING = parsed.pending;
    /* ★ 三方比較:base(草稿當初的來源版本)/ draft(草稿內容)/ live(剛讀到的現況)。

       原本這裡是「把草稿的 baseHashes 整份蓋回去」,那會造成兩種**方向相反**的災難:
       ・真的有人在這期間發布過 → 基準停在舊值,每次發布都被判 stale_base,而畫面叫人
         「重新整理再試」—— 重新整理又會把舊基準蓋回來,於是**無限迴圈**,唯一出路是
         捨棄草稿、連帶丟掉所有未發布的編輯。
       ・舊格式草稿(沒有 baseHashes 欄位)→ 整段被跳過,變成「舊內容配新雜湊」,
         版本檢查會**通過**,於是**靜默覆蓋**別人的修改,雙方都不會察覺。

       現在的做法:baseHashes 一律維持剛讀到的線上值(它才是 Worker 會拿來比對的東西),
       草稿的內容照樣還原給使用者看;只有「草稿的來源版本 ≠ 線上現況」的那幾個路徑被
       標成衝突並鎖住,發布前一定會問過人。既不會無聲覆蓋,也不會丟掉任何編輯。 */
    conflictPaths.clear();
    const draftBase = (parsed.baseHashes && typeof parsed.baseHashes === "object") ? parsed.baseHashes : null;
    // 純邏輯抽在 admin-logic.js,才有辦法寫自動測試(見 tests/logic.test.mjs)
    AdminLogic.computeConflicts(draftBase, liveHashes).forEach(p => conflictPaths.add(p));
    if(parsed.sentBody && typeof parsed.sentBody === "object"){
      for(const k of Object.keys(sentBody)) delete sentBody[k];
      Object.assign(sentBody, parsed.sentBody);
    }
    recoveredPaths = reconcileWithLive(liveHashes, liveBody);
    if(!DATA.some(g => g.id === selected)) selected = DATA.length ? DATA[0].id : null;
    hasDraft = true;
  }
  let recoveredPaths = [];
  /* 「上次其實已經發布成功了,只是這邊沒記到」的自我修復。
     判斷依據是內容本身:某個檔線上的內容 === 我們上次送出去的內容,就代表那次寫入
     確實落地了(不管是我們寫的、還是別人剛好送了一模一樣的內容,結果都是 repo 已經
     有我們要的東西)。這時把 baseHashes/loadedBody 對齊到線上版本,發布就不會再被
     誤判成版本落後;那個檔也自然從「有變更」的清單裡消失,不會重送一次。
     內容不一致就什麼都不做 —— 那是真的還沒寫進去(或別人改成了別的東西),
     維持原本的保護,寧可擋下來也不要蓋掉別人。 */
  function reconcileWithLive(liveHashes, liveBody){
    const fixed = [];
    for(const path of Object.keys(sentBody)){
      if(liveBody[path] == null || liveBody[path] !== sentBody[path]) continue;
      baseHashes[path] = liveHashes[path];
      loadedBody[path] = liveBody[path];
      delete sentBody[path];      // 已經對齊,不必再追蹤
      /* 線上的內容就是我上次送出去的內容 → 那次其實成功了,這不是別人造成的衝突。
         把它從衝突清單拿掉,免得叫使用者去確認一件他自己做過的事。 */
      conflictPaths.delete(path);
      fixed.push(path);
    }
    return fixed;
  }
  function discardDraft(){
    if(!confirm("捨棄尚未發布的變更，改回目前公開網站的內容？")) return;
    clearTimeout(saveTimer);
    dirty = false;
    for(const k of Object.keys(sentBody)) delete sentBody[k];   // 草稿都不要了,復原線索一起清掉
    try{ localStorage.removeItem(draftKey()); }catch(e){}
    loadData().then(() => {
      showDraftBanner(false);
      renderAll(); validate(); toast("已捨棄變更，已重新載入目前線上的內容");
    }).catch(() => toast("重新載入失敗，請重新整理頁面", { warn: true }));
  }

  /* ---------- toast (optional action button, e.g. undo) ---------- */
  let toastTimer = null;
  function hideToast(){ toastEl.classList.remove("show"); }
  function toast(msg, opts){
    opts = opts || {};
    toastEl.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = msg;
    toastEl.appendChild(span);
    if(opts.actionLabel && typeof opts.onAction === "function"){
      const b = document.createElement("button");
      b.className = "toast-action";
      b.type = "button";
      b.textContent = opts.actionLabel;
      b.onclick = () => { opts.onAction(); hideToast(); };
      toastEl.appendChild(b);
    }
    toastEl.classList.toggle("warn", !!opts.warn);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.duration || 2600);
  }

  /* ---------- helpers ---------- */
  const groupById = id => DATA.find(g => g.id === id);
  function esc(s){ return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function imgSrc(image){ return /^data:image\//.test(image) ? image : "images/" + encodeURIComponent(image); }

  /* ---------- 修改時間戳 ----------
     任何會改到「成員資料內容」的動作都要呼叫 touch(m):逐欄編輯、換照片/名片/商品照、
     勾選需確認,以及 CSV／表單／PPT 的批次匯入。純粹調整排序不算內容變更,不蓋章。
     存 ISO 字串(可排序、時區明確),要顯示時才用 fmtStamp 轉成本地格式。 */
  function touch(m){ if(m) m.updatedAt = new Date().toISOString(); }
  function fmtStamp(iso, withTime){
    if(!iso) return "";
    const d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    const date = d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
    return withTime ? date + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) : date;
  }
  function linesToArr(v){ const a = v.replace(/\u000B/g, "\n").split("\n"); while(a.length && a[a.length-1].trim()==="") a.pop(); return a; }

  /* ---------- validation ---------- */
  /* 回傳「會擋下發布的問題」清單。分兩級是刻意的:
     擋下的是會造成**資料靜默損毀**的(代號重複會讓兩組共用同一個檔、id 重複會讓
     前台連結指到錯的人);空姓名、編號重複這類是資料品質提醒,不該擋住人發布。 */
  function validate(){
    const problems = [];
    const blocking = [];
    const ids = new Map();
    const nums = new Map();
    const codes = new Map();
    visibleGroups().forEach(g => {
      if(!g.name.trim()) problems.push("有分組沒有名稱（" + (g.code||"?") + "）");
      if(!GROUPCODE_RE.test(String(g.code||"").trim())){
        blocking.push("分組代號「" + (g.code||"(空白)") + "」不合法：只能用英文字母或數字、最多 8 個字（例如 A1、B2、C），改好才能發布");
      }
      // 檔名是代號小寫,所以 A1 與 a1 是同一個檔
      const key = String(g.code||"").trim().toLowerCase();
      if(key) codes.set(key, (codes.get(key)||[]).concat(g.name || "(未命名)"));
      g.members.forEach(m => {
        ids.set(m.id, (ids.get(m.id)||0)+1);
        if(!m.name.trim()) problems.push("「" + (g.code||"?") + "」組有成員未填姓名");
        const n = (m.number||"").trim();
        if(n) nums.set(n, (nums.get(n)||[]).concat((m.name||"?")));
      });
    });
    [...codes.entries()].filter(([,names])=>names.length>1).forEach(([code,names]) =>
      blocking.push("分組代號「" + code.toUpperCase() + "」重複了（" + names.join("、") +
                    "）。兩組共用同一個代號會讓其中一組的成員全部消失，請先改掉再發布"));
    [...ids.entries()].filter(([,c])=>c>1).forEach(([id,c]) =>
      blocking.push("成員 id 重複：" + id + "（×" + c + "）。前台的連結會指到錯的人"));
    const dupNums = [...nums.entries()].filter(([,names])=>names.length>1);
    if(dupNums.length){
      problems.push("編號重複（僅提醒，可接受）：" + dupNums.map(([n,names])=>n+"→"+names.join("/")).join("；"));
    }
    const all = blocking.concat(problems);
    if(all.length){
      validationBox.innerHTML = ICON.warn + "<div>" + all.map(esc).join("<br>") + "</div>";
      validationBox.classList.add("show");
    } else {
      validationBox.classList.remove("show");
    }
    return blocking;
  }

  /* ---------- image crop + resize（裁成與前台卡片相同比例 4:4.6，輸出寬 900） ---------- */
  const CROP_VW = 300, CROP_VH = 345;              // 裁剪視窗（比例 4:4.6）
  const CROP_OUT_W = 900, CROP_OUT_H = Math.round(900 * CROP_VH / CROP_VW);

  function cropAndResize(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => openCropper(img, resolve);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function openCropper(img, done){
    const modal = byId("crop-modal");
    const canvas = byId("crop-canvas");
    const zoom = byId("crop-zoom");
    canvas.width = CROP_VW; canvas.height = CROP_VH;
    const ctx = canvas.getContext("2d");
    const natW = img.naturalWidth, natH = img.naturalHeight;
    const minScale = Math.max(CROP_VW / natW, CROP_VH / natH);
    const maxScale = minScale * 5;
    let scale = minScale;
    let offX = (CROP_VW - natW * scale) / 2;
    let offY = (CROP_VH - natH * scale) / 2;

    function clamp(){
      offX = Math.min(0, Math.max(CROP_VW - natW * scale, offX));
      offY = Math.min(0, Math.max(CROP_VH - natH * scale, offY));
    }
    function draw(){
      ctx.clearRect(0, 0, CROP_VW, CROP_VH);
      ctx.drawImage(img, offX, offY, natW * scale, natH * scale);
    }
    function setScale(newScale){
      newScale = Math.min(maxScale, Math.max(minScale, newScale));
      // 以視窗中心為軸縮放
      const cxImg = (CROP_VW / 2 - offX) / scale;
      const cyImg = (CROP_VH / 2 - offY) / scale;
      scale = newScale;
      offX = CROP_VW / 2 - cxImg * scale;
      offY = CROP_VH / 2 - cyImg * scale;
      clamp(); draw();
    }
    clamp(); draw();
    zoom.value = "0";

    // pointer 拖曳平移
    let dragging = false, startX = 0, startY = 0, startOX = 0, startOY = 0;
    function pd(e){ dragging = true; startX = e.clientX; startY = e.clientY; startOX = offX; startOY = offY; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); }
    function pm(e){ if(!dragging) return; const r = canvas.getBoundingClientRect(); const sx = CROP_VW / r.width, sy = CROP_VH / r.height; offX = startOX + (e.clientX - startX) * sx; offY = startOY + (e.clientY - startY) * sy; clamp(); draw(); }
    function pu(){ dragging = false; }
    function onZoom(){ setScale(minScale + (maxScale - minScale) * (parseFloat(zoom.value) / 100)); }
    function onWheel(e){ e.preventDefault(); const step = (maxScale - minScale) / 12 * (e.deltaY < 0 ? 1 : -1); setScale(scale + step); zoom.value = String(Math.round((scale - minScale) / (maxScale - minScale) * 100)); }

    canvas.addEventListener("pointerdown", pd);
    canvas.addEventListener("pointermove", pm);
    canvas.addEventListener("pointerup", pu);
    canvas.addEventListener("pointercancel", pu);
    canvas.addEventListener("wheel", onWheel, {passive:false});
    zoom.addEventListener("input", onZoom);

    function cleanup(){
      canvas.removeEventListener("pointerdown", pd);
      canvas.removeEventListener("pointermove", pm);
      canvas.removeEventListener("pointerup", pu);
      canvas.removeEventListener("pointercancel", pu);
      canvas.removeEventListener("wheel", onWheel);
      zoom.removeEventListener("input", onZoom);
      byId("crop-ok").onclick = null;
      byId("crop-cancel").onclick = null;
      modal.onclick = null;
      modal.hidden = true;
    }
    function confirm(){
      const out = document.createElement("canvas");
      out.width = CROP_OUT_W; out.height = CROP_OUT_H;
      const octx = out.getContext("2d");
      const sx = -offX / scale, sy = -offY / scale, sW = CROP_VW / scale, sH = CROP_VH / scale;
      octx.drawImage(img, sx, sy, sW, sH, 0, 0, CROP_OUT_W, CROP_OUT_H);
      let url; try{ url = out.toDataURL("image/jpeg", 0.85); }catch(e){ url = null; }
      cleanup(); done(url);
    }
    byId("crop-ok").onclick = confirm;
    byId("crop-cancel").onclick = () => { cleanup(); done(null); };
    modal.onclick = e => { if(e.target === modal){ cleanup(); done(null); } };
    modal.hidden = false;
  }

  /* ---------- render: sidebar ---------- */
  function renderSidebar(){
    const groups = visibleGroups();
    glist.innerHTML = groups.map(g => `
      <div class="gitem ${g.id===selected?"active":""}" data-gid="${esc(g.id)}" title="${esc(g.code||"?")}・${esc(g.name||"（未命名）")}">
        <span class="gitem-code">${esc(g.code||"?")}</span>
        <span class="gitem-name">${esc(g.name||"（未命名）")}</span>
        <span class="gitem-count">${g.members.length}</span>
      </div>`).join("") +
      (isLeader() || isViewer() ? "" : `<button class="gadd-tile" id="gadd-tile" type="button">＋ 新增分組</button>`);
    glist.querySelectorAll(".gitem").forEach(el => {
      el.addEventListener("click", () => {
        selected = el.dataset.gid; renderAll();
        closeDrawerIfMobile();
      });
    });
    const addTile = byId("gadd-tile");
    if(addTile) addTile.onclick = () => { addGroup(); closeDrawerIfMobile(); };
  }
  function closeDrawerIfMobile(){ document.body.classList.remove("drawer-open"); }

  /* ---------- render: main ---------- */
  function renderMain(){
    const g = groupById(selected);
    if(!g){
      main.innerHTML = isLeader()
        ? `<div class="adm-card">找不到你被指派的分組（代號 <b>${esc(myGroupCode())}</b>）。<br>
             可能是代號被改過，或帳號設定有誤，請聯繫總管理員。</div>`
        : `<div class="adm-card">尚無分組，請按左上「+ 新增組」。</div>`;
      return;
    }
    if(!canEditGroup(g)){   // 保險:選到不該編輯的組就不渲染表單
      main.innerHTML = isViewer()
        ? `<div class="adm-card"><b>${esc(g.code)}・${esc(g.name)}</b>　${g.members.length} 位成員<br>
             <span class="hint">這是唯讀帳號，不能修改資料。匯出 CSV、缺資料清單、
             聚光燈產生器與產業小組表都可以照常使用。</span></div>`
        : `<div class="adm-card">你沒有編輯「${esc(g.code)}・${esc(g.name)}」的權限。</div>`;
      return;
    }
    const gi = DATA.indexOf(g);
    const leader = isLeader();

    main.innerHTML = `
      <div class="adm-card">
        <div class="adm-group-head">
          <div class="field" style="width:120px;">
            <label>組別代號${leader ? '<span class="hint">（不可改）</span>' : ""}</label>
            <input id="g-code" value="${esc(g.code)}" placeholder="如 A1" ${leader ? "disabled" : ""}>
          </div>
          <div class="field grow">
            <label>分組名稱${leader ? '<span class="hint">（不可改）</span>' : ""}</label>
            <input id="g-name" value="${esc(g.name)}" placeholder="如 健康營養照護組" ${leader ? "disabled" : ""}>
          </div>
          <div class="field" style="width:150px;">
            <label>組長</label>
            <input id="g-leader" value="${esc(g.leader||"")}" placeholder="組長姓名">
          </div>
          ${leader ? "" : `<div style="display:flex; gap:6px; align-self:flex-end; padding-bottom:1px;">
            <button class="icon-btn" id="g-up" title="分組上移" ${gi===0?"disabled":""}>${ICON.up}</button>
            <button class="icon-btn" id="g-down" title="分組下移" ${gi===DATA.length-1?"disabled":""}>${ICON.down}</button>
          </div>`}
        </div>
        <div class="field" style="margin-top:12px;">
          <label>招募席位<span class="hint">（每行一項；會以紅字顯示在「產業小組表」該組名單下方）</span></label>
          <textarea id="g-recruit" style="min-height:52px;">${esc((g.recruiting||[]).join("\n"))}</textarea>
        </div>
      </div>

      <div class="adm-card" style="padding:14px 16px;">
        <div class="quick-add">
          <input id="quick-add-name" placeholder="輸入姓名，按 Enter 快速新增成員…" autocomplete="off">
          <button class="btn btn-primary" id="quick-add-btn" type="button">+ 新增成員</button>
        </div>
      </div>

      <div class="mem-list" id="mem-list"></div>

      <div>
        <button class="btn btn-primary" id="add-mem" type="button">+ 新增成員到「${esc(g.name||g.code)}」</button>
      </div>`;

    // group field bindings（focus 先拍照、第一次輸入才計為一步）
    // 組長不綁代號與組名:代號是他自己的綁定鍵,改了會把自己鎖在外面
    if(!leader){
      bindTextField("g-code", v => { g.code = v; renderSidebar(); scheduleSaveAndValidate(); });
      bindTextField("g-name", v => { g.name = v; renderSidebar(); scheduleSaveAndValidate(); });
      byId("g-up").onclick = () => moveGroup(gi, -1);
      byId("g-down").onclick = () => moveGroup(gi, 1);
    }
    bindTextField("g-leader", v => { g.leader = v; scheduleSaveAndValidate(); });
    bindTextField("g-recruit", v => { g.recruiting = linesToArr(v); scheduleSave(); });
    byId("add-mem").onclick = () => addMember(g);

    // quick add by name (Enter or button) — stays focused for rapid entry
    const qi = byId("quick-add-name");
    const quickAdd = () => {
      const nm = qi.value.trim();
      if(nm){ addMember(g, nm, {quick:true}); qi.value = ""; byId("quick-add-name").focus(); }
      else { addMember(g); }
    };
    byId("quick-add-btn").onclick = quickAdd;
    qi.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); quickAdd(); } });

    renderMembers(g);
  }

  function renderMembers(g){
    const wrap = byId("mem-list");
    if(!g.members.length){
      wrap.innerHTML = `<div class="mem-empty"><p>這個分組還沒有成員。</p><button class="btn btn-primary" id="empty-add" type="button">+ 新增第一位成員</button></div>`;
      byId("empty-add").onclick = () => addMember(g);
      return;
    }
    wrap.innerHTML = g.members.map((m, i) => memberCardHTML(m, i, g.members.length)).join("");
    g.members.forEach((m, i) => bindMember(g, m, i));
  }

  function memberCardHTML(m, i, total){
    const photo = m.image
      ? `<img class="mem-photo" src="${esc(imgSrc(m.image))}" alt="">`
      : `<div class="mem-photo-none">${ICON.cam}<span>無照片</span></div>`;
    return `
      <div class="mem-card" data-mid="${esc(m.id)}">
        <div class="mem-photo-col">
          ${photo}
          <div class="mem-photo-btns">
            <button class="btn btn-sm" data-act="photo">更換照片</button>
            <button class="btn btn-sm btn-danger" data-act="rmphoto" ${m.image?"":"disabled"}>移除</button>
          </div>
          <input type="file" accept="image/*" data-act="file" hidden>
        </div>
        <div class="mem-fields">
          <div class="mem-head">
            <span class="mem-idx">第 ${i+1} 位</span>
            <span class="mem-stamp">${m.updatedAt ? "最後更新 " + esc(fmtStamp(m.updatedAt, true)) : "尚無更新紀錄"}</span>
            <label class="chk"><input type="checkbox" data-f="dataIssue" ${m.dataIssue?"checked":""}> 標記資料需確認</label>
            <span class="mem-tools">
              <button class="icon-btn" data-act="up" title="上移" ${i===0?"disabled":""}>${ICON.up}</button>
              <button class="icon-btn" data-act="down" title="下移" ${i===total-1?"disabled":""}>${ICON.down}</button>
              <button class="icon-btn" data-act="dup" title="複製此成員">${ICON.copy}</button>
              <button class="icon-btn" data-act="del" title="刪除成員">${ICON.trash}</button>
            </span>
          </div>
          <div class="row3">
            <div class="field"><label>編號</label><input data-f="number" value="${esc(m.number)}"></div>
            <div class="field"><label>姓名</label><input data-f="name" value="${esc(m.name)}"></div>
            <div class="field"><label>行業／職稱</label><input data-f="title" value="${esc(m.title)}"></div>
          </div>
          <div class="row2">
            <div class="field"><label>服務項目<span class="hint">（每行一項）</span></label><textarea data-f="services">${esc((m.services||[]).join("\n"))}</textarea></div>
            <div class="field"><label>適合引薦對象<span class="hint">（每行一項）</span></label><textarea data-f="targets">${esc((m.targets||[]).join("\n"))}</textarea></div>
          </div>
          <div class="row2">
            <div class="field"><label>我有…<span class="hint">（每行一項：手上的資源、專長、人脈）</span></label><textarea data-f="have">${esc((m.have||[]).join("\n"))}</textarea></div>
            <div class="field"><label>我要…<span class="hint">（每行一項：想被引薦到的對象、需求）</span></label><textarea data-f="want">${esc((m.want||[]).join("\n"))}</textarea></div>
          </div>
          <div class="field"><label>宣傳標語<span class="hint">（每行一句）</span></label><textarea data-f="tagline" style="min-height:56px;">${esc((m.tagline||[]).join("\n"))}</textarea></div>
          <div class="row2">
            <div class="field"><label>所屬公司</label><input data-f="company" value="${esc(m.company||"")}" placeholder="待補充"></div>
            <div class="field"><label>主要營業項目</label><input data-f="business_items" value="${esc(m.business_items||"")}" placeholder="待補充"></div>
          </div>
          <div class="field"><label>公司網站<span class="hint">（選填，請含 https://）</span></label><input data-f="website" value="${esc(m.website||"")}" placeholder="https://…"></div>
          <div class="field"><label>名片圖檔<span class="hint">（橫式即可，不裁切、自動縮圖）</span></label>
            <div class="cardimg-row">
              ${m.card ? `<img class="cardimg-thumb" src="${esc(imgSrc(m.card))}" alt="">` : `<span class="cardimg-none">尚無名片</span>`}
              <button class="btn btn-sm" data-act="cardbtn" type="button">更換名片</button>
              <button class="btn btn-sm btn-danger" data-act="rmcard" type="button" ${m.card?"":"disabled"}>移除</button>
              <input type="file" accept="image/*" data-act="cardfile" hidden>
            </div>
          </div>
          <div class="field"><label>商品／服務照片<span class="hint">（至多 5 張，會顯示在成員內頁）</span></label>
            <div class="prod-row">
              ${(m.products||[]).map((p,i)=>`<span class="prod-item"><img src="${esc(imgSrc(p))}" alt=""><button class="prod-del" data-act="rmprod" data-i="${i}" type="button" title="移除這張">×</button></span>`).join("")}
              ${(m.products||[]).length < 5 ? `<button class="btn btn-sm" data-act="prodbtn" type="button">＋ 加商品照</button><input type="file" accept="image/*" multiple data-act="prodfile" hidden>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }

  function bindMember(g, m, i){
    const card = main.querySelector('.mem-card[data-mid="'+cssq(m.id)+'"]');
    if(!card) return;
    ["number","name","title","company","business_items","website"].forEach(f => {
      wireTextInput(card.querySelector('[data-f="'+f+'"]'), v => { m[f] = v; touch(m); scheduleSaveAndValidate(); });
    });
    ["services","targets","have","want","tagline"].forEach(f => {
      wireTextInput(card.querySelector('[data-f="'+f+'"]'), v => { m[f] = linesToArr(v); touch(m); scheduleSave(); });
    });
    const chk = card.querySelector('[data-f="dataIssue"]');
    chk.addEventListener("change", () => { pushUndo(); m.dataIssue = chk.checked; touch(m); scheduleSave(); });

    const fileInput = card.querySelector('[data-act="file"]');
    card.querySelector('[data-act="photo"]').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      if(!file) return;
      try{
        const dataUrl = await cropAndResize(file);   // 開啟裁剪視窗；取消回傳 null
        if(dataUrl){
          pushUndo();
          m.image = dataUrl; touch(m);
          renderMembers(g); saveDraft(); toast("照片已更新，記得最後按「發布到網站」");
        }
      }catch(e){ toast("照片讀取失敗", {warn:true}); }
      fileInput.value = "";
    };
    card.querySelector('[data-act="rmphoto"]').onclick = () => {
      if(!m.image) return;
      pushUndo();
      m.image = ""; touch(m); renderMembers(g); saveDraft();
    };
    card.querySelector('[data-act="up"]').onclick = () => moveMember(g, i, -1);
    card.querySelector('[data-act="down"]').onclick = () => moveMember(g, i, 1);
    card.querySelector('[data-act="dup"]').onclick = () => duplicateMember(g, i);
    card.querySelector('[data-act="del"]').onclick = () => deleteMember(g, i);

    /* 名片:不裁切,自動縮圖 */
    const cardFile = card.querySelector('[data-act="cardfile"]');
    card.querySelector('[data-act="cardbtn"]').onclick = () => cardFile.click();
    cardFile.onchange = async () => {
      const file = cardFile.files && cardFile.files[0];
      cardFile.value = "";
      if(!file) return;
      const url = await resizeFlat(file, 1400);
      if(url){ pushUndo(); m.card = url; touch(m); renderMembers(g); saveDraft(); toast("名片已更新，記得最後按「發布到網站」"); }
      else toast("名片讀取失敗", {warn:true});
    };
    card.querySelector('[data-act="rmcard"]').onclick = () => {
      if(!m.card) return;
      pushUndo(); m.card = ""; touch(m); renderMembers(g); saveDraft();
    };

    /* 商品照:多選,最多 5 張 */
    const prodFile = card.querySelector('[data-act="prodfile"]');
    const prodBtn = card.querySelector('[data-act="prodbtn"]');
    if(prodBtn && prodFile){
      prodBtn.onclick = () => prodFile.click();
      prodFile.onchange = async () => {
        const files = Array.from(prodFile.files || []);
        prodFile.value = "";
        if(!files.length) return;
        const room = 5 - (m.products || []).length;
        const take = files.slice(0, room);
        pushUndo();
        if(!m.products) m.products = [];
        let ok = 0;
        for(const f of take){
          const url = await resizeFlat(f, 1200);
          if(url){ m.products.push(url); ok++; }
        }
        if(ok) touch(m);
        renderMembers(g); saveDraft();
        toast("已加入 " + ok + " 張商品照" + (files.length > room ? "（超過 5 張上限，其餘略過）" : "") + "，記得最後按「發布到網站」");
      };
    }
    card.querySelectorAll('[data-act="rmprod"]').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.i, 10);
        if(!(m.products || [])[idx] && (m.products || [])[idx] !== "") return;
        pushUndo(); m.products.splice(idx, 1); touch(m); renderMembers(g); saveDraft();
      };
    });
  }

  /* 等比例縮圖(不裁切):名片、商品照用 */
  function resizeFlat(file, maxSide){
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const out = document.createElement("canvas");
          out.width = Math.round(img.naturalWidth * s);
          out.height = Math.round(img.naturalHeight * s);
          out.getContext("2d").drawImage(img, 0, 0, out.width, out.height);
          let url; try{ url = out.toDataURL("image/jpeg", 0.85); }catch(e){ url = null; }
          resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- mutations（每個結構性動作先 pushUndo() 記錄一步） ---------- */
  function moveGroup(i, dir){
    if(isViewer() || isLeader()) return;   // 同 addGroup:排序也是分會結構
    const j = i + dir; if(j<0||j>=DATA.length) return;
    pushUndo();
    [DATA[i], DATA[j]] = [DATA[j], DATA[i]];
    renderAll(); scheduleSave();
  }
  function addGroup(){
    if(isViewer() || isLeader()) return;   // 分會結構只有總管理員能動;函式本體也擋一道,不只靠隱藏按鈕
    pushUndo();
    const g = { id: uid("g"), code:"新", name:"新分組", leader:"", room:"", members:[] };
    // 預設代號是中文的「新」,發布一定會被擋——立刻跑一次檢查表把話講在前面
    DATA.push(g); selected = g.id; renderAll(); scheduleSaveAndValidate();
    byId("g-code") && byId("g-code").focus();
    toast("已新增分組，請填代號與名稱");
  }
  /* 新成員的欄位樣板:後台手動新增與 CSV 匯入新增共用同一份,欄位增減只改這裡 */
  function newMember(gid, name, number){
    return { id: uid(gid+"_m"), number:number||"", name:name||"", title:"",
      services:[], targets:[], have:[], want:[], tagline:[],
      image:"", card:"", products:[], company:"", business_items:"", website:"",
      dataIssue:false, updatedAt:new Date().toISOString() };
  }
  function addMember(g, name, opts){
    opts = opts || {};
    pushUndo();
    const m = newMember(g.id, name);
    g.members.push(m); renderSidebar(); renderMembers(g); scheduleSaveAndValidate();
    if(opts.quick){
      toast("已新增成員" + (name ? "「" + name + "」" : ""));
    } else {
      const card = main.querySelector('.mem-card[data-mid="'+cssq(m.id)+'"]');
      if(card){ card.scrollIntoView({behavior:"smooth", block:"center"}); card.querySelector('[data-f="name"]').focus(); }
    }
  }
  function duplicateMember(g, i){
    pushUndo();
    const src = g.members[i];
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid(g.id+"_m");
    copy.name = (src.name || "") + "（複製）";
    touch(copy);
    g.members.splice(i+1, 0, copy);
    renderSidebar(); renderMembers(g); scheduleSaveAndValidate();
    const card = main.querySelector('.mem-card[data-mid="'+cssq(copy.id)+'"]');
    if(card){ card.scrollIntoView({behavior:"smooth", block:"center"}); }
    toast("已複製成員");
  }
  function deleteMember(g, i){
    pushUndo();
    const removed = g.members[i];
    g.members.splice(i,1);
    renderSidebar(); renderMembers(g); scheduleSaveAndValidate();
    // 立即復原鈕＝退回這一步（等同上一步）
    toast("已刪除「" + (removed.name || "未命名") + "」", { actionLabel:"復原", duration:6000, onAction: undo });
  }
  function moveMember(g, i, dir){
    const j = i + dir; if(j<0||j>=g.members.length) return;
    pushUndo();
    [g.members[i], g.members[j]] = [g.members[j], g.members[i]];
    renderMembers(g); scheduleSave();
  }

  /* ---------- export ---------- */
  function serialize(data){
    return "// 會員名錄資料檔 — 由後台編輯器 admin.html 產生/更新\n" +
           "// 直接用文字編輯器修改也可以；欄位說明見 README.md\n" +
           "const GROUPS = " + JSON.stringify(data || DATA, null, 2) + ";\n" +
           "if (typeof module !== 'undefined') { module.exports = GROUPS; }\n";
  }
  function download(){
    validate();
    const blob = new Blob([serialize()], {type:"text/javascript;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "data.js";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已下載備份 data.js");
  }

  /* ---------- 匯出 CSV ----------
     欄位定義的單一來源是 csv-schema.js,與 roster.csv 鏡像共用。
     2026/7 起本站不再提供任何批次「匯入」管道(CSV／PPT／表單皆已移除),
     成員資料一律在後台逐欄編輯;此處只負責把名冊倒出來給人核對。 */
  const CSV_HEADERS = CSV_SCHEMA.HEADERS;   // 欄位定義單一來源:csv-schema.js(與 roster.csv 鏡像共用)
  const csvEscape = CSV_SCHEMA.escape;
  function csvExport(){
    const scope = visibleGroups();          // 組長只匯出自己那組
    const rows = [CSV_HEADERS.slice()];
    scope.forEach(g => g.members.forEach(m => rows.push(CSV_SCHEMA.memberRow(g, m))));
    const csv = "\uFEFF" + rows.map(r => r.map(csvEscape).join(",")).join("\r\n");   // BOM：讓 Excel 直接開就是正確中文
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const d = new Date(), pad = n => String(n).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = "會員名錄_" + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    const total = scope.reduce((n, g) => n + g.members.length, 0);
    toast("已匯出名冊：" + scope.length + " 組、" + total + " 位成員");
  }

  /* ---------- 缺資料清單:找出資料不齊的夥伴,產生可直接貼 LINE 的催收訊息 ---------- */
  /* 外部連結取自 site-config.js;留空則相關捷徑自動隱藏 */
  const SHEET_URL = SITE.ROSTER_SHEET_URL || "";  // Google 名冊試算表(工具列「名冊試算表」捷徑)
  function copyPlain(text){
    return navigator.clipboard.writeText(text).then(() => true).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try{ ok = document.execCommand("copy"); }catch(e){}
      ta.remove(); return ok;
    });
  }
  function missingReport(){
    const items = [];
    const fieldCount = {};
    const bump = k => { fieldCount[k] = (fieldCount[k] || 0) + 1; };
    const scope = visibleGroups();          // 組長只看自己那組的缺項
    scope.forEach(g => g.members.forEach(m => {
      const miss = [];
      if(!m.image) miss.push("形象照");
      if(!(m.card || "").trim()) miss.push("名片圖檔");
      if(!(m.products || []).length) miss.push("商品照片");
      if(!(m.company || "").trim()) miss.push("所屬公司");
      if(!(m.business_items || "").trim()) miss.push("主要營業項目");
      if(!(m.services || []).filter(s => String(s).trim()).length) miss.push("服務項目");
      if(!(m.targets || []).filter(s => String(s).trim()).length) miss.push("適合引薦對象");
      if(!(m.have || []).filter(s => String(s).trim()).length) miss.push("我有");
      if(!(m.want || []).filter(s => String(s).trim()).length) miss.push("我要");
      if(!(m.tagline || []).filter(s => String(s).trim()).length) miss.push("宣傳標語");
      if(miss.length){ items.push({ g, m, miss }); miss.forEach(bump); }
    }));
    const total = scope.reduce((n, g) => n + g.members.length, 0);
    const lines = items.map(it => "・" + it.m.name + "(" + (it.g.code || "?") + "):缺 " + it.miss.join("、"));
    const notice = [
      "【會員名錄・資料補齊通知】",
      "以下夥伴的名錄資料還有缺項,麻煩抽空補上,讓你的頁面更有引薦力 💪",
      "請直接把缺的內容回覆給網管,由網管統一更新。",
      "",
    ].concat(lines).join("\n");
    const statHtml = Object.entries(fieldCount).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => "<tr><td>" + esc(k) + "</td><td>" + v + " 位</td></tr>").join("");
    const html =
      '<div class="batch-sec"><h4>缺項統計<span class="cnt">' + items.length + "／" + total + ' 位</span></h4>' +
      '<table class="batch-table"><tr><th>缺的項目</th><th>人數</th></tr>' + statHtml + "</table></div>" +
      '<div class="batch-sec"><h4>催收訊息(按下方「複製」直接貼到 LINE 群)</h4>' +
      '<textarea readonly rows="12" style="width:100%; font:inherit; font-size:12.5px; line-height:1.8; border:1.5px solid var(--border-2); border-radius:10px; padding:10px 12px; background:var(--bg-soft);">' +
      esc(notice) + "</textarea></div>" +
      '<div class="batch-note">「商品照片」與「名片」屬選填,催收語氣自行斟酌;統計即時反映目前草稿內容。</div>';
    openBatchModal(
      "缺資料清單",
      items.length ? html : "<p>🎉 全員資料齊全,沒有缺項。</p>",
      items.length ? items.length + " 位夥伴有缺項" : "0 缺項",
      "複製催收訊息",
      items.length ? async () => {
        const ok = await copyPlain(notice);
        toast(ok ? "催收訊息已複製,貼到 LINE 群即可" : "複製失敗,請開啟清單手動複製", ok ? {} : { warn: true });
      } : null
    );
  }

  /* ---------- 批次預覽視窗（CSV 與照片共用） ---------- */
  let batchApplyFn = null;
  function openBatchModal(title, bodyHTML, summary, applyLabel, onApply){
    byId("batch-title").textContent = title;
    byId("batch-body").innerHTML = bodyHTML;
    byId("batch-summary").textContent = summary || "";
    const ap = byId("batch-apply");
    ap.textContent = applyLabel || "套用變更";
    ap.disabled = !onApply;
    batchApplyFn = onApply || null;
    byId("batch-modal").hidden = false;
  }
  function closeBatchModal(){ byId("batch-modal").hidden = true; batchApplyFn = null; }

  /* ---------- publish relay (Cloudflare Worker holds the real GitHub token) ----------
     瀏覽器只保管「Worker 網址」（不是機密）與一次登入用的 session（存在 sessionStorage，
     關掉分頁就消失）。密碼與 GitHub 權杖從頭到尾都不會出現在瀏覽器裡。 */
  const WORKER_URL_KEY = "member-directory-worker-url-v1";
  const SESSION_KEY = "member-directory-session-v1";   // sessionStorage only
  // 部署好 Worker 後，把網址寫在這裡，所有裝置都不用再手動設定，只要輸入密碼即可（此網址不是機密）。
  const WORKER_URL_DEFAULT = "https://member-directory-relay.retetrhjj123.workers.dev";

  // 瀏覽器封鎖儲存（例如 iOS 無痕模式）時，退回記憶體變數：同一個分頁內一切照常，
  // 只是重新整理後需要重新輸入設定與密碼——不會出現「登入成功卻永遠發布不了」的死循環。
  let memWorkerUrl = "";
  let memSession = null;

  function loadWorkerUrl(){
    let saved = ""; try{ saved = localStorage.getItem(WORKER_URL_KEY) || ""; }catch(e){}
    return (saved || memWorkerUrl || WORKER_URL_DEFAULT || "").trim().replace(/\/+$/, "");
  }
  function saveWorkerUrl(url){
    memWorkerUrl = url;
    try{ localStorage.setItem(WORKER_URL_KEY, url); }catch(e){}
  }
  function currentSession(){
    let raw = null; try{ raw = sessionStorage.getItem(SESSION_KEY); }catch(e){}
    if(raw){
      let s; try{ s = JSON.parse(raw); }catch(e){ s = null; }
      if(s && s.token && s.exp && Date.now() < s.exp) return s;
    }
    if(memSession && memSession.token && Date.now() < memSession.exp) return memSession;
    return null;
  }
  function loadSession(){ const s = currentSession(); return s ? s.token : null; }
  function saveSession(token, expiresInSeconds, user, role, group){
    memSession = { token, exp: Date.now() + expiresInSeconds*1000,
      user: user || "", role: role || "owner", group: group || "" };
    try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(memSession)); }catch(e){}
    showWho();
  }
  /* ⚠️ 這裡的角色判斷只用來「隱藏介面」,不是真的權限。真正的界線在 Worker:
     組長送別組的檔案會被 canWriteDataFile 擋下,唯讀帳號的發布在 handlePublish
     開頭就被回 read_only。這一層擋的是誤觸,不是惡意——會開發者工具的人繞得過。 */
  function myRole(){ const s = currentSession(); return (s && s.role) || "owner"; }
  function myGroupCode(){ const s = currentSession(); return (s && s.group) || ""; }
  function isLeader(){ return myRole() === "leader"; }
  /* 唯讀帳號:看得到全會資料、能匯出,但改不了也發不了。
     注意下面幾個判斷式原本都是「不是組長就當成全開」——多一種角色之後那樣寫會直接
     把唯讀帳號當成總管理員,所以要問的是 isViewer(),不是 !isLeader()。 */
  function isViewer(){ return myRole() === "viewer"; }
  /* 組長綁定的那一組(找不到回 null:代號被改過或設定錯誤) */
  function myGroup(){
    const code = myGroupCode().trim().toLowerCase();
    if(!code) return null;
    return DATA.find(g => String(g.code || "").trim().toLowerCase() === code) || null;
  }
  /* 這位使用者看得到／改得到的分組清單 */
  function visibleGroups(){
    if(!isLeader()) return DATA;
    const g = myGroup();
    return g ? [g] : [];
  }
  /* 唯讀帳號一律 false —— 這一句就讓 renderMain 不渲染編輯表單,
     連帶把表單裡所有的輸入、快速新增、裁切、刪除都變成到不了的路徑。 */
  function canEditGroup(g){ return !isViewer() && (!isLeader() || (g && myGroup() === g)); }
  function clearSession(){
    memSession = null;
    try{ sessionStorage.removeItem(SESSION_KEY); }catch(e){}
    showWho();
  }
  /* 頂端顯示目前登入者:多帳號時要一眼看得出「現在是誰在改」 */
  function showWho(){
    const el = byId("adm-who");
    if(!el) return;
    const s = currentSession();
    if(s && s.user){
      const g = s.role === "leader" ? myGroup() : null;
      el.textContent = "👤 " + s.user +
        (s.role === "leader" ? "・" + (g ? g.code + " " + g.name : s.group + "（找不到此組）") + " 組長"
         : s.role === "viewer" ? "・唯讀"
         : "・總管理員");
      el.hidden = false;
    } else { el.textContent = ""; el.hidden = true; }
  }
  /* 依角色決定介面:組長只看到自己那組,全域功能一律隱藏;
     唯讀帳號再把所有會改資料的鈕收起來,只留匯出與查看。 */
  function applyRoleUI(){
    const leader = isLeader(), viewer = isViewer();
    const hide = (id, on) => { const el = byId(id); if(el) el.hidden = !!on; };
    ["btn-settings", "btn-add-group"].forEach(id => hide(id, leader || viewer));
    // 復原/重做/儲存草稿/發布:唯讀帳號按了也沒有意義,收起來免得以為壞了
    ["btn-undo", "btn-redo", "btn-save", "btn-publish"].forEach(id => hide(id, viewer));
    // 儀表板的說明字由 renderDash 統一決定（renderAll 會在此之後才呼叫它）
  }

  async function workerFetch(path, payload, urlOverride){
    /* 唯讀帳號連一次發布請求都不該送出去。擋在這裡而不是各個按鈕上,是因為發布有
       兩個入口(工具列的「發布到網站」與離開提醒視窗裡的那顆),而這裡是所有對外
       請求的唯一出口 —— 以後再多幾個入口也不會漏。
       Worker 端本來就會回 read_only,這一層只是不要白跑一趟。 */
    if(path === "/publish" && isViewer()) return { ok:false, error:"read_only" };
    const url = urlOverride || loadWorkerUrl();
    if(!url) return { ok:false, error:"no_worker_url" };
    try{
      const r = await fetch(url + path, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload || {}),
      });
      let data = {};
      try{ data = await r.json(); }catch(e){}
      if(r.status === 429) return { ok:false, error:"too_many_attempts", retryAfter: data.retryAfter };
      return Object.assign({ httpStatus:r.status }, data);
    }catch(e){
      return { ok:false, error:"network" };
    }
  }

  function showPermBanner(msgHtmlSafe){
    byId("perm-banner-text").textContent = msgHtmlSafe;
    byId("perm-banner").hidden = false;
  }
  function hidePermBanner(){ byId("perm-banner").hidden = true; }

  /* ---------- lock screen ---------- */
  function showLock(){
    const configured = !!loadWorkerUrl();
    byId("lock-lead").textContent = configured
      ? "輸入你的帳號與密碼進入編輯模式。"
      : "尚未設定發布服務。請按下方「連線設定」貼上 Worker 網址。";
    byId("lock-user-field").style.display = configured ? "" : "none";
    byId("lock-pass-field").style.display = configured ? "" : "none";
    byId("lock-enter").style.display = configured ? "" : "none";
    byId("lock-error").hidden = true;
    byId("lock-overlay").hidden = false;
    if(configured) byId("lock-user").focus();
  }
  function hideLock(){ byId("lock-overlay").hidden = true; }

  async function tryUnlock(){
    const user = byId("lock-user").value.trim();
    const pass = byId("lock-pass").value;
    if(!user){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "請先輸入帳號。";
      byId("lock-user").focus();
      return;
    }
    if(!pass){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "請先輸入密碼。";
      byId("lock-pass").focus();
      return;
    }
    if(!loadWorkerUrl()){ openSettings(); return; }
    const btn = byId("lock-enter");
    btn.disabled = true; btn.textContent = "確認中…";
    const res = await workerFetch("/login", { username: user, password: pass });
    btn.disabled = false; btn.textContent = "進入編輯模式";
    if(res.ok && res.session){
      saveSession(res.session, res.expiresInSeconds || 1800, res.user || user, res.role, res.group);
      byId("lock-pass").value = "";
      hideLock();
      hidePermBanner();
      await bootData();                          // 角色決定載入哪幾組,登入後才取資料
      toast(isLeader() ? "已進入編輯模式（只會顯示你負責的分組）"
            : isViewer() ? "已登入（唯讀帳號：可以查看與匯出，不能修改）"
            : "已進入編輯模式");
      checkHealth(res.session);   // 登入後順便確認伺服器上的 GitHub 權杖還能不能寫入
    } else if(res.error === "too_many_attempts"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "密碼錯誤次數過多，請等約 " + Math.ceil((res.retryAfter||60)/60) + " 分鐘後再試。";
    } else if(res.error === "no_worker_url" || res.error === "network"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "連不到發布服務，請檢查「連線設定」裡的網址是否正確。";
    } else if(res.error === "misconfigured_no_accounts"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "發布服務上還沒有設定任何帳號，請管理員到 Cloudflare 檢查 Worker 的 ADMIN_USERS 設定（見 worker/README.md）。";
    } else if(res.error === "rate_limit_unavailable" || res.error === "misconfigured_missing_allowed_origin"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "發布服務尚未設定完成，請管理員檢查 Cloudflare Worker 的設定（見 worker/README.md）。";
    } else {
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "帳號或密碼不正確，請再試一次。";
      byId("lock-pass").select();
    }
  }

  function logout(){
    clearSession();
    showLock();
    toast("已登出");
  }

  async function checkHealth(session){
    const res = await workerFetch("/health", { session });
    if(!res.ok) return;   // 網路問題等，不打擾，發布時自然會再報
    if(res.github === "read_only"){
      showPermBanner("Worker 上設定的 GitHub 權杖「只能讀、不能寫」，按發布會失敗。請管理員到 Cloudflare 該 Worker 的 GH_TOKEN 設定檢查（GitHub 那支權杖的 Contents 需為 Read and write）。");
    } else if(res.github === "invalid_token"){
      showPermBanner("Worker 上設定的 GitHub 權杖無效或已過期／被撤銷。請管理員重新建立權杖並更新 Worker 的 GH_TOKEN 設定。");
    } else if(res.github === "repo_not_found"){
      showPermBanner("Worker 找不到設定的 GitHub repo，請管理員檢查 Worker 的 GH_OWNER / GH_REPO 設定。");
    }
    /* "writable" 或 "network_error" → 不顯示提醒 */
  }

  /* ---------- settings（只有 Worker 網址，不是機密） ---------- */
  function openSettings(){
    byId("s-worker-url").value = loadWorkerUrl();
    byId("settings-modal").hidden = false;
    byId("s-worker-url").focus();
  }
  function closeSettings(){ byId("settings-modal").hidden = true; }
  function saveSettings(){
    /* 改 Worker 網址等於改發布目標。設定視窗有兩個入口(工具列的鈕、鎖定畫面上的
       「連線設定」),後者在還沒登入時就點得到、判不了角色,所以閘門放在這裡。 */
    if(isViewer()){ toast("唯讀帳號不能修改連線設定", { warn:true }); return; }
    const url = byId("s-worker-url").value.trim().replace(/\/+$/, "");
    if(url && !/^https:\/\//.test(url)){ toast("網址需以 https:// 開頭", {warn:true}); return; }
    const changed = url !== loadWorkerUrl();
    saveWorkerUrl(url);
    refreshCaps();   // 換了服務就重新確認它支不支援附件
    closeSettings();
    if(loadSession() && !changed){
      // 已登入且網址沒變（例如只是打開看看就按儲存）→ 不需要把人踢回登入畫面
      toast("設定已儲存");
      return;
    }
    if(changed) clearSession();   // 換了後端服務，舊 session 對新服務無效
    showLock();
    toast(url ? "設定已儲存，請輸入密碼登入" : "已清空設定");
  }
  async function testConnection(){
    const url = byId("s-worker-url").value.trim().replace(/\/+$/, "");
    if(!url){ toast("請先填入 Worker 網址", {warn:true}); return; }
    const b = byId("s-test"); b.disabled = true; b.textContent = "測試中…";
    const res = await workerFetch("/ping", {}, url);   // 直接測輸入框裡的網址，不動 localStorage，不會跟真正登入互相干擾
    b.disabled = false; b.textContent = "測試連線";
    if(res.ok){ toast("✔ 服務有回應，網址設定正確"); }
    else { toast("✘ 連不到這個網址，請確認 Worker 是否已部署、網址是否正確", {warn:true, duration:6000}); }
  }

  /* ---------- Worker 能力偵測 + 發布附件（照片實體檔） ----------
     Worker 升級後 /ping 會回 caps.files=true：發布時把內嵌照片轉成 images/ 實體檔
     一併交給 Worker 寫入；未升級時完全維持舊行為（照片內嵌在 data.js 裡）。
     m/ 分享預覽頁一律由 GitHub Action 於發布後 1–2 分鐘重建，
     唯一產生器是 tools/build-member-pages.mjs（後台不再重生，避免兩份範本要同步）。 */
  let workerCaps = {};
  let capsReady = null;      // promise:一定要 await 過才知道 Worker 支援什麼
  /* ★ 原本這裡是 fire-and-forget（呼叫端沒有 await）:workerCaps 初值是 {},要等 /ping
     往返回來才變成真值。使用者在那之前按下發布(Worker 冷啟動可達數秒),或 /ping 失敗
     (原註解寫「失敗就當不支援,行為同舊版」),整個分頁就會退回「照片內嵌在分組檔裡」
     的舊路徑 —— 分組檔膨脹數 MB,推送後同步 Action 又會回頭改寫 data/,於是下一次發布
     被判版本落後,而訊息說「有人在你編輯期間發布過」(其實是自動化流程),連重新整理都
     解不開。改成 promise:發布前一定會等它,而且失敗時不再靜默降級成舊行為。
     外層呼叫點不是 async,所以不能只加一個 await —— 要留住 promise 讓發布時去等。 */
  function refreshCaps(){
    const p = (async () => {
      const res = await workerFetch("/ping");
      if(res && res.ok && res.caps){ workerCaps = res.caps; return true; }
      workerCaps = {};
      return false;
    })();
    capsReady = p;
    return p;
  }
  /* ★ 只快取**成功**的偵測結果。
     原本失敗的 promise 也會留在 capsReady 裡,而 promise 本身是 truthy,於是
     `await (capsReady || refreshCaps())` 之後永遠不會再問一次 —— 第一次 /ping 剛好
     失敗(Worker 冷啟動、網路抖一下),整個分頁就再也發布不了,而畫面還在叫使用者
     「稍候幾秒再按一次」:按幾次都一樣,只能重新整理。
     這裡在失敗後把 capsReady 清掉(且只清掉自己那一顆,避免蓋到別人剛啟動的偵測),
     下一次操作就會重新偵測。換 Worker 網址時 refreshCaps() 也會覆寫它。 */
  async function ensureCaps(){
    const pending = capsReady || refreshCaps();
    const ok = await pending;
    if(!ok && capsReady === pending) capsReady = null;
    return ok;
  }

  /* 檔名要通得過 Worker 的路徑白名單:開頭必須是英數,其餘只留 [A-Za-z0-9._-]。
     現在的 id 都是 uid() 產的、開頭一定是英數,但舊資料匯進來的不保證;
     開頭補一個 m,比整次發布被打回來 bad_file_path 好處理。 */
  function fileSafeId(id){
    const s = String(id).replace(/[^A-Za-z0-9_-]/g, "");
    return /^[A-Za-z0-9]/.test(s) ? s : "m" + s;
  }

  /* 內嵌照片 → 要寫進 images/ 的實體檔;不是內嵌照片(已經是檔名了)回 null。
     三種格式都要認:表單收得到 png 與 webp，只認 jpeg 的話那兩種會整串 base64
     留在分組檔裡，每個訪客載入名錄都要多扛幾百 KB。副檔名跟著實際格式走，
     存成 .jpg 會讓 GitHub Pages 回錯的 content-type。 */
  const DATA_IMG_EXT = { jpeg: "jpg", png: "png", webp: "webp" };
  async function embeddedPhoto(value, base){
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(value || ""));
    if(!m) return null;
    const b64 = m[2].trim();
    if(!b64) return null;
    /* ★ 檔名帶**內容雜湊**。原本檔名只由成員 id 決定(而裁切一律輸出 jpeg,副檔名也固定),
       所以兩個人同時替同一位成員換照片必然寫到同一個路徑;而 images/ 的寫入沒有版本鎖,
       後寫的會靜默蓋掉先寫的,雙方都不會收到任何錯誤 —— 前台於是變成「A 的資料配 B 的
       照片」。加上內容雜湊之後,不同的照片必然是不同的檔,永遠不會互相覆蓋;內容相同則
       自然指向同一個檔,不會產生重複檔案。 */
    const h = (await sha256Hex(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))).slice(0, 10);
    return { name: base + "_" + h + "." + DATA_IMG_EXT[m[1]], b64 };
  }

  /* 組出這次發布要寫的檔案:照片附件 + 「內容真的有變」的分組檔。
     沒改到的組完全不送,才不會在別組組長同時編輯時互相踩到。 */
  async function buildPublishPayload(){
    const data = clone(DATA);
    const files = [];
    if(workerCaps.files){
      for(const g of data){
        for(const m of g.members){
          const pic = await embeddedPhoto(m.image, fileSafeId(m.id) + "_x");
          if(pic){ files.push({ path: "images/" + pic.name, contentB64: pic.b64 }); m.image = pic.name; }
          const card = await embeddedPhoto(m.card, fileSafeId(m.id) + "_card");
          if(card){ files.push({ path: "images/" + card.name, contentB64: card.b64 }); m.card = card.name; }
          const prods = m.products || [];
          for(let i = 0; i < prods.length; i++){
            const prod = await embeddedPhoto(prods[i], fileSafeId(m.id) + "_p" + (i + 1));
            if(prod){ files.push({ path: "images/" + prod.name, contentB64: prod.b64 }); prods[i] = prod.name; }
          }
        }
      }
    }
    // 分組檔:與載入時的內容逐字比對,只送真的有差異的
    data.forEach(g => {
      const path = dataPathOf(g.code);
      const body = serializeBody(groupBody(g));
      if(body !== loadedBody[path]) files.push({ path, contentB64: utf8ToB64(body) });
    });
    // 待認領區:認領或刪除申請都會改動它,有變才送
    const pend = JSON.stringify(PENDING, null, 2) + "\n";
    if(loadedBody[PENDING_PATH] != null && pend !== loadedBody[PENDING_PATH]){
      files.push({ path: PENDING_PATH, contentB64: utf8ToB64(pend) });
    }
    // 分會結構(順序/代號/組名)只有總管理員能寫,同樣有變才送
    if(!isLeader()){
      const idx = JSON.stringify(DATA.map(g => ({ code: g.code, name: g.name, id: g.id })), null, 2) + "\n";
      if(idx !== loadedBody["data/_index.json"]) files.push({ path: "data/_index.json", contentB64: utf8ToB64(idx) });
    }
    /* ★ 改名:分組代號改了,檔案路徑就跟著變。新檔會被送出,但**舊檔不會自己消失** ——
       Worker 沒有任何 DELETE,而 build-data.mjs 只讀 _index 列出的檔,於是舊檔變成
       沒有人會讀的孤兒。更糟的是在它被刪掉之前,持有舊分頁的組長還能繼續寫進去:
       兩邊都顯示「已發布!」,資料卻永遠不會出現在網站上。
       所以改名時要把舊路徑一起送出去刪掉,而且必須和新檔在**同一個 commit** 裡,
       中間不能存在「_index 指向新檔、新檔卻還不存在」的狀態(那會讓產線整條失敗)。 */
    const remove = AdminLogic.computeRenameRemovals(DATA, originalPathByGroupId, dataPathOf);
    return { files, remove };
  }

  /* 發布成功後,把記憶體裡還是 base64 的照片換成剛寫進去的檔名。
     少了這一步,同一個分頁再按一次發布會把同一批照片整批重送 —— 產生一個 tree 其實
     沒有變化的空 commit,而且白白吃掉子請求預算。檔名由內容雜湊決定,所以這裡重算
     出來的名字與剛才送出去的必然一致。 */
  async function normalizePhotosInMemory(){
    for(const g of DATA){
      for(const m of g.members){
        const pic = await embeddedPhoto(m.image, fileSafeId(m.id) + "_x");
        if(pic) m.image = pic.name;
        const card = await embeddedPhoto(m.card, fileSafeId(m.id) + "_card");
        if(card) m.card = card.name;
        const prods = m.products || [];
        for(let i = 0; i < prods.length; i++){
          const prod = await embeddedPhoto(prods[i], fileSafeId(m.id) + "_p" + (i + 1));
          if(prod) prods[i] = prod.name;
        }
      }
    }
  }

  let publishing = false;
  async function publish(){
    if(publishing) return false;
    /* 唯讀帳號:這裡先擋下來,只是為了給一句看得懂的話。
       就算把這幾行刪掉,Worker 也會回 read_only —— 權限不是靠這裡守的。 */
    if(isViewer()){
      toast("唯讀帳號不能發布。你可以查看與匯出，要修改請找有編輯權限的夥伴。", { warn:true, duration:6000 });
      return false;
    }
    let session = loadSession();
    if(!session){
      showLock();
      toast("請先輸入管理密碼", {warn:true});
      return false;
    }
    /* 有會造成資料損毀的問題就擋下來。以前這裡只是把警告畫在頁面上、照樣發布,
       代號重複那種情況等於讓人一路按到底,然後某一組的成員就從網站上消失了。 */
    const blocking = validate();
    if(blocking.length){
      toast("有必須先修正的問題：" + blocking[0].split("。")[0], { warn:true, duration:9000 });
      validationBox.scrollIntoView({ behavior:"smooth", block:"center" });
      return false;
    }
    publishing = true;
    let ok = false;
    const btn = byId("btn-publish");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.textContent = "發布中…";
    try{
      /* ★ 一定要先確認 Worker 支援什麼才動手組 payload。
         沒問到就發布的話,照片會以 base64 內嵌進分組檔(見 refreshCaps 的說明),
         那是一條會把人帶進死迴圈的路 —— 寧可擋下來請他重試。 */
      const capsOk = await ensureCaps();
      if(!capsOk || !workerCaps.files){
        toast("暫時連不到發布服務（或它尚未升級），為避免照片被錯誤地寫進資料檔，這次先不發布。" +
              "請稍候幾秒再按一次。", { warn:true, duration:8000 });
        return false;
      }
      const payload = await buildPublishPayload();
      if(!payload.files.length){
        toast("沒有偵測到任何變更，不需要發布");
        return false;
      }
      /* ★ 衝突閘門:草稿的來源版本與線上現況對不起來的路徑,一定要使用者明確表態。
         這裡刻意用 confirm 而不是靜默處理 —— 「覆蓋別人剛發布的內容」不該是預設行為,
         但也不該把人卡在無限迴圈裡(那正是原本的狀況)。 */
      const hit = payload.files.filter(f => conflictPaths.has(f.path)).map(f => f.path);
      if(hit.length){
        const names = hit.map(p => p === "data/_index.json" ? "分會結構"
                                : p === PENDING_PATH ? "待認領區"
                                : p.replace(/^data\/|\.json$/g, "").toUpperCase() + " 組");
        const okOverride = confirm(
          "以下項目在你離開之後被其他人發布過：\n\n  " + names.join("、") +
          "\n\n你手上的草稿是根據更早的版本編輯的。要繼續發布嗎？\n" +
          "（繼續 = 用你的版本覆蓋對方的修改；取消 = 先按「捨棄變更」取得最新資料，" +
          "或用「下載備份」把你的內容留一份再處理）");
        if(!okOverride) return false;
        hit.forEach(p => conflictPaths.delete(p));   // 已經問過了,不再重複打擾
      }
      /* ★ 一次發布 = 一個請求 = 一個 commit。**不再自動分批。**
         原本超過 20 檔會先送幾批純 images/、最後才送資料檔。那樣做有兩個後果:
         ・前面幾批已經推進 main,若最後一批失敗,repo 就停在「有照片、沒有資料」的
           半套狀態,而使用者看到的是「這次修改沒有上線」;
         ・那些純照片的 commit 不符合 sync.yml 的 paths 條件,不會觸發同步流程,
           卻會讓正在跑的同步推送被拒 —— 重試次數耗盡後前台會停在舊版且沒有告警。
         檔案太多時改成請使用者分幾次做,並且講清楚為什麼不自動拆。 */
      const MAX_FILES = 20;    // 與 Worker 的 MAX_FILES_PER_REQUEST 一致
      if(payload.files.length > MAX_FILES){
        toast("這次要寫入 " + payload.files.length + " 個檔案，超過單次上限（" + MAX_FILES + "）。" +
              "請分幾次發布：先處理一部分成員的照片，發布之後再繼續其餘的。" +
              "（一次發布必須是一個提交，所以不會自動拆批。）", { warn:true, duration:14000 });
        return false;
      }

      /* 送出「之前」先把資料檔的內容記進草稿。這一步是回應遺失時唯一的線索:
         沒有它,下次開頁面就分不出「其實已經寫進去了」與「真的被別人搶先改掉」,
         只能一律當成版本落後,把人卡死。照片附件不必記(檔名由內容決定,重寫無妨)。 */
      const sentData = payload.files.filter(f => f.path.startsWith("data/"));
      if(sentData.length){
        sentData.forEach(f => { sentBody[f.path] = b64ToUtf8(f.contentB64); });
        saveDraft();
      }
      const res = await workerFetch("/publish", {
        session, files: payload.files, remove: payload.remove, baseHashes, baseBlobShas,
      });
      if(res.ok){
        Object.assign(baseHashes, res.newHashes || {});
        Object.assign(baseBlobShas, res.newBlobShas || {});
        payload.files.forEach(f => {
          if(!f.path.startsWith("data/")) return;
          loadedBody[f.path] = b64ToUtf8(f.contentB64);
          delete sentBody[f.path];
        });
        /* 改名成功之後,舊路徑已經被刪掉了 —— 把追蹤基準對齊到新路徑,
           否則下一次發布會再送一次同樣的刪除(而且那時舊檔已經不在,會被判 stale)。 */
        for(const p of (payload.remove || [])){ delete baseHashes[p]; delete baseBlobShas[p]; delete loadedBody[p]; }
        for(const g of DATA) originalPathByGroupId[g.id] = dataPathOf(g.code);
        // 記憶體裡的 base64 換成剛寫進去的檔名,避免下一次發布重送同一批照片
        await normalizePhotosInMemory();
        clearTimeout(saveTimer);
        dirty = false;
        for(const k of Object.keys(sentBody)) delete sentBody[k];   // 全部確認成功,復原線索用不到了
        try{ localStorage.removeItem(draftKey()); }catch(e){}
        showDraftBanner(false);
        hidePermBanner();
        ok = true;
        // 已經開著名錄的分頁不會自己更新——講清楚,免得以為發布失敗又發一次
        toast("已發布！約 1～2 分鐘後公開網站就會更新 ✔（已經開著名錄的分頁要重新整理才看得到）",
              {duration:8000});
      } else if(res.error === "read_only"){
        // 唯讀帳號。前端本來就擋著,會走到這裡代表 session 是別的分頁登的、或有人繞過介面
        toast("這是唯讀帳號，伺服器拒絕了這次發布。要修改請用有編輯權限的帳號登入。",
              {warn:true, duration:7000});
      } else if(res.error === "session_expired" || res.httpStatus === 401){
        clearSession();
        toast("登入逾時，請重新輸入密碼再發布一次（草稿都還在，沒有遺失）", {warn:true, duration:6000});
        showLock();
        // 鎖定畫面蓋住畫面時，toast 可能被忽略——把說明直接寫在登入卡片上
        byId("lock-error").hidden = false;
        byId("lock-error").textContent = "登入逾時（超過 30 分鐘）。剛才的修改都還在，重新輸入密碼後再按一次「發布到網站」即可。";
      } else if(res.error === "token_forbidden"){
        toast("發布服務目前無法寫入 GitHub，這次修改「沒有」上線（草稿都還在）。", {warn:true, duration:7000});
        showPermBanner("Worker 上設定的 GitHub 權杖沒有寫入權限或已失效，請管理員到 Cloudflare 檢查 Worker 的 GH_TOKEN 設定（需要 Contents: Read and write）。");
      } else if(res.error === "content_not_accepted"){
        toast("這個編輯頁是舊版本，請重新整理頁面後再改一次（你的草稿仍在）", {warn:true, duration:9000});
      } else if(res.error === "bad_file_path" && !DATA_PATH_RE.test(String(res.path || ""))){
        // 路徑本身就不合法,幾乎都是分組代號打了中文或符號(新增分組的預設代號是「新」)
        toast("分組代號「" + String(res.path || "").replace(/^data\/|\.json$/g, "") +
              "」不合法，這次修改「沒有」上線。代號只能用英文字母或數字，改好再發布一次（草稿都還在）。",
              {warn:true, duration:10000});
      } else if(res.error === "bad_data_file"){
        toast("資料內容不符合規則（" + String(res.reason || "") + "），這次修改「沒有」上線。" +
              "請先「下載備份」，再把該筆資料改回正常值（草稿都還在）。", {warn:true, duration:10000});
      } else if(res.error === "bad_file_path" && String(res.path || "").startsWith("data/")){
        // 路徑是合法的分組檔卻被說格式錯 → 對方是舊版 Worker,它的白名單只認得 images/ 與 m/。
        // 不講清楚的話,組長只會看到「發布失敗」而一直重試。
        toast("發布服務還是舊版本，尚未支援分組資料檔，這次修改「沒有」上線（草稿都還在）。", {warn:true, duration:9000});
        showPermBanner("Cloudflare 上的 Worker 還沒更新到最新版。請總管理員到 Cloudflare → Worker → Edit code，貼上 repo 裡最新的 worker/publish-relay.js 後 Deploy，再發布一次即可。");
      } else if(res.error === "forbidden_path"){
        toast("你沒有修改「" + String(res.path || "").replace(/^data\/|\.json$/g, "").toUpperCase() +
              "」的權限，這次修改沒有上線。若你認為這是設定錯誤，請聯繫總管理員。", {warn:true, duration:9000});
      } else if(res.error === "forbidden_asset"){
        // 組長送出的照片檔名不屬於自己那組(正常操作不會發生;多半是別組的照片混進來)
        toast("這次要上傳的照片不屬於你這一組，伺服器拒絕了發布。請重新整理頁面再試一次；" +
              "若持續發生，請聯繫總管理員。", {warn:true, duration:9000});
      } else if(res.error === "group_unresolved"){
        toast("伺服器找不到你這一組的設定，這次修改沒有上線。請稍後再試一次，或聯繫總管理員確認分組設定。",
              {warn:true, duration:9000});
      } else if(res.error === "stale_base"){
        /* 別人在你編輯期間發布過:硬送出去會把對方的修改蓋掉,所以擋在這裡。
           ★ 措辭改過:原本斷言「被其他人發布過」並叫人「重新整理再改一次」。
             兩句都可能是錯的 —— 發布者自己觸發的同步流程也會改到 data/,而在 Worker
             支援 /read 之前,重新整理讀到的是延遲 1~4 分鐘的公開網站,重整根本拿不到
             最新資料(於是形成迴圈)。現在資料改從 Worker 讀,重新整理才真的有用。 */
        toast("「" + String(res.path || "").replace(/^data\/|\.json$/g, "").toUpperCase() +
              "」的線上版本比你手上的新，這次「沒有」上線（一個位元組都沒有寫入）。" +
              "請先「下載備份」保留你的修改，重新整理頁面取得最新資料後再改一次。",
              {warn:true, duration:12000});
      } else if(res.error === "already_exists"){
        toast("「" + String(res.path || "").replace(/^data\/|\.json$/g, "").toUpperCase() +
              "」已經被其他人建立了，這次「沒有」上線。請重新整理頁面，改用既有的那一組。",
              {warn:true, duration:10000});
      } else if(res.error === "group_renamed"){
        toast("你這一組的代號已被總管理員改過，這次「沒有」上線。請重新整理頁面後再試一次。",
              {warn:true, duration:10000});
      } else if(res.error === "version_check_failed"){
        toast("暫時讀不到線上版本，為了不覆蓋別人的修改，這次「沒有」上線（草稿都還在）。請稍後再試。",
              {warn:true, duration:9000});
      } else if(res.error === "busy_retry_later"){
        toast("同一時間發布的人有點多，這次「沒有」上線（草稿都還在）。請過幾秒再按一次。",
              {warn:true, duration:9000});
      } else if(res.error === "data_file_too_large" || res.error === "pending_too_large"){
        toast("資料量超過單檔上限，這次「沒有」上線。若待認領區累積太多筆，請先認領或刪除幾筆。",
              {warn:true, duration:11000});
      } else if(res.error === "conflict"){
        toast("版本衝突，請重新整理頁面後再發布一次", {warn:true, duration:6000});
      } else if(res.error === "no_worker_url"){
        toast("尚未設定發布服務網址，請到「設定」填入", {warn:true, duration:6000});
        openSettings();
      } else if(res.error === "network"){
        toast("連不到發布服務，請檢查網路連線或稍後再試", {warn:true, duration:6000});
      } else if(res.error === "github_timeout" || res.error === "github_unreachable"){
        toast("連不到 GitHub，這次修改「沒有」上線（草稿都還在），請稍後再發布一次", {warn:true, duration:6000});
      } else if(res.error === "misconfigured_missing_allowed_origin"){
        toast("發布服務尚未設定完成，請管理員檢查 Worker 設定", {warn:true, duration:6000});
      } else {
        toast("發布失敗，草稿都還在，可以稍後再試一次", {warn:true, duration:6000});
      }
    } finally {
      publishing = false; btn.disabled = false; btn.innerHTML = orig;
    }
    return ok;
  }

  /* ---------- leave-to-site guard ---------- */
  // 有「尚未發布」的變更＝草稿橫幅正顯示，或剛改完還沒自動存進草稿
  function hasUnpublishedChanges(){
    return dirty || byId("draft-banner").classList.contains("show");
  }
  function leaveToSite(){ window.location.href = "index.html"; }
  function closeLeaveModal(){ byId("leave-modal").hidden = true; }
  function requestLeave(){
    // 未登入（鎖定中）根本改不了東西，直接離開；否則有未發布變更才提醒
    if(hasUnpublishedChanges() && byId("lock-overlay").hidden){
      byId("leave-modal").hidden = false;
    } else {
      leaveToSite();
    }
  }

  /* ---------- small utils ---------- */
  function byId(id){ return document.getElementById(id); }
  function cssq(s){ return String(s).replace(/["\\]/g, "\\$&"); }
  function commitPendingSnap(){
    if(!pendingSnap) return;
    undoStack.push(pendingSnap);
    if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = []; pendingSnap = null;
    updateHistoryButtons();
  }
  /* 文字欄位：focus 時先拍一張，第一次輸入才把那張存進復原堆疊 → 一整段編輯只算「一步」。
     這裡務必用 snapshot()（{data,pending} 物件），不能是裸的 clone(DATA)：commitPendingSnap
     會把它 push 進「同一個」undoStack，而 undo() 的 restore() 讀的是 s.data / s.pending。
     若存成裸陣列，undo 取到後 s.data 為 undefined → DATA=undefined → renderAll 崩潰、資料全毀。 */
  function wireTextInput(el, onInput){
    if(!el) return;
    el.addEventListener("focus", () => { pendingSnap = snapshot(); });
    el.addEventListener("blur", () => { pendingSnap = null; });
    el.addEventListener("input", () => { commitPendingSnap(); onInput(el.value); });
  }
  function bindTextField(id, cb){ wireTextInput(byId(id), cb); }
  function scheduleSaveAndValidate(){ scheduleSave(); validate(); }

  function renderAll(){ applyRoleUI(); renderSidebar(); renderMain(); renderDash(); renderPending(); }

  /* ---------- 分會總覽儀表板:即時統計+工具捷徑 ---------- */
  function renderDash(){
    const el = byId("dash-stats");
    if(!el) return;
    const scope = visibleGroups();          // 組長的儀表板只統計自己那組
    const total = scope.reduce((n, g) => n + g.members.length, 0);
    let noPhoto = 0, hasCard = 0, hasProducts = 0, hasWebsite = 0, recruit = 0, missingMembers = 0;
    let hasHave = 0, hasWant = 0, recentlyEdited = 0;
    const WEEK_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;
    scope.forEach(g => {
      recruit += (g.recruiting || []).filter(r => String(r).trim()).length;
      g.members.forEach(m => {
        if(!m.image) noPhoto++;
        if((m.card || "").trim()) hasCard++;
        if((m.products || []).length) hasProducts++;
        if(/^https?:\/\//.test(m.website || "")) hasWebsite++;
        if((m.have || []).filter(s => String(s).trim()).length) hasHave++;
        if((m.want || []).filter(s => String(s).trim()).length) hasWant++;
        const t = Date.parse(m.updatedAt || "");
        if(!isNaN(t) && t >= WEEK_AGO) recentlyEdited++;
        const miss = !m.image || !(m.card || "").trim() || !(m.products || []).length ||
          !(m.company || "").trim() || !(m.business_items || "").trim() ||
          !(m.services || []).filter(s => String(s).trim()).length ||
          !(m.targets || []).filter(s => String(s).trim()).length ||
          !(m.have || []).filter(s => String(s).trim()).length ||
          !(m.want || []).filter(s => String(s).trim()).length ||
          !(m.tagline || []).filter(s => String(s).trim()).length;
        if(miss) missingMembers++;
      });
    });
    const sub = byId("dash-sub");
    if(sub){
      const g = isLeader() ? myGroup() : null;
      sub.textContent = isViewer() ? "唯讀帳號:看得到全會資料,也可以匯出,但不能修改"
        : !isLeader() ? "資料一修改,數字立即更新;發布後全站同步"
        : g ? "你是「" + g.code + "・" + g.name + "」的組長,以下統計只算本組"
            : "找不到你被指派的分組,請聯繫總管理員";
    }
    el.innerHTML =
      '<div class="dstat"><b>' + total + '</b><span>位成員</span></div>' +
      '<div class="dstat"><b>' + scope.length + '</b><span>專業分組</span></div>' +
      '<div class="dstat click warn" id="dstat-missing" title="點擊看缺項清單與催收訊息"><b>' + missingMembers + '<small>／' + total + '</small></b><span>資料有缺項 →</span></div>' +
      '<div class="dstat"><b>' + (total - noPhoto) + '<small>／' + total + '</small></b><span>已有形象照</span></div>' +
      '<div class="dstat"><b>' + hasCard + '<small>／' + total + '</small></b><span>已有名片圖</span></div>' +
      '<div class="dstat"><b>' + hasProducts + '<small>／' + total + '</small></b><span>已有商品照</span></div>' +
      '<div class="dstat"><b>' + hasWebsite + '<small>／' + total + '</small></b><span>已填公司網站</span></div>' +
      '<div class="dstat"><b>' + hasHave + '<small>／' + total + '</small></b><span>已填「我有」</span></div>' +
      '<div class="dstat"><b>' + hasWant + '<small>／' + total + '</small></b><span>已填「我要」</span></div>' +
      '<div class="dstat"><b>' + recentlyEdited + '<small>／' + total + '</small></b><span>近 7 天有更新</span></div>' +
      '<div class="dstat"><b>' + recruit + '</b><span>招募中席位</span></div>';
    const dm = byId("dstat-missing");
    if(dm) dm.onclick = missingReport;

    const tools = byId("dash-tools");
    if(tools && !tools.dataset.built){
      tools.dataset.built = "1";
      let h =
        '<a class="dtool" href="index.html" target="_blank" rel="noopener">🏠 前台名錄</a>' +
        '<a class="dtool" href="spotlight.html" target="_blank" rel="noopener">🌟 聚光燈產生器</a>' +
        '<a class="dtool" href="groups.html" target="_blank" rel="noopener">📋 產業小組表</a>' +
        '<a class="dtool" href="visitor.html" target="_blank" rel="noopener">🤝 來賓報名頁</a>' +
        '<a class="dtool" href="roster.csv" target="_blank" rel="noopener">📄 名冊 CSV</a>';
      if(SITE.VISITOR_FORM_URL) h += '<a class="dtool" href="' + esc(SITE.VISITOR_FORM_URL) + '" target="_blank" rel="noopener">📝 來賓報名表單</a>';
      // 新夥伴自填表單:把網址發給新夥伴,他填完就會出現在上方待認領區
      if(SITE.MEMBER_FORM_URL) h += '<a class="dtool" href="' + esc(SITE.MEMBER_FORM_URL) + '" target="_blank" rel="noopener">🙋 新夥伴填寫表單</a>';
      if(SHEET_URL) h += '<a class="dtool" href="' + esc(SHEET_URL) + '" target="_blank" rel="noopener">📊 名冊試算表</a>';
      tools.innerHTML = h;
    }
  }

  /* ---------- 待認領區 ----------
     新夥伴自填表單送來的申請放在 data/_pending.json,所有組長都看得到。
     按「認領」= 在自己那一組建一張成員卡 + 把該筆從待認領清單移除,兩件事都只是
     本機草稿,要按「發布到網站」才真正生效(發布時會同時送出分組檔與待認領檔)。 */
  function pendingPhoto(a){
    return /^data:image\//.test(a.image || "") ? a.image : "";
  }
  function renderPending(){
    const wrap = byId("pending-wrap"), list = byId("pending-list"), sub = byId("pending-sub");
    if(!wrap || !list) return;
    // 認領＝在某一組建一張成員卡,是編輯行為。唯讀帳號整塊不顯示。
    if(isViewer()){ wrap.hidden = true; list.innerHTML = ""; return; }
    if(!PENDING.length){ wrap.hidden = true; list.innerHTML = ""; return; }
    wrap.hidden = false;
    if(sub) sub.textContent = PENDING.length + " 位等待認領";

    const groups = visibleGroups();
    list.innerHTML = PENDING.map(a => {
      const meta = [
        a.title && "行業：" + a.title,
        a.company && "公司：" + a.company,
        (a.services || []).length && "服務：" + a.services.join("、"),
        (a.targets || []).length && "適合引薦：" + a.targets.join("、"),
        (a.have || []).length && "我有：" + a.have.join("、"),
        (a.want || []).length && "我要：" + a.want.join("、"),
      ].filter(Boolean).map(esc).join("<br>");
      const photo = pendingPhoto(a);
      const pickGroup = isLeader()
        ? ""
        : '<select class="input-sm" data-pick="' + esc(a.pid) + '">' +
          groups.map(g => '<option value="' + esc(g.id) + '">' + esc((g.code || "?") + " " + (g.name || "")) + '</option>').join("") +
          '</select>';
      return '<div class="pend-card" data-pid="' + esc(a.pid) + '">' +
        (photo ? '<img class="pend-photo" src="' + esc(photo) + '" alt="' + esc(a.name) + ' 的照片">' : '<div class="pend-photo"></div>') +
        '<div class="pend-body">' +
          '<div class="pend-name">' + esc(a.name || "(未填姓名)") + '</div>' +
          (meta ? '<div class="pend-meta">' + meta + '</div>' : "") +
          '<div class="pend-at">申請時間：' + esc(fmtStamp(a.at, true) || "—") + '</div>' +
        '</div>' +
        '<div class="pend-actions">' + pickGroup +
          '<button class="btn btn-primary btn-sm" data-claim="' + esc(a.pid) + '" type="button">' +
            (isLeader() ? "認領到「" + esc(myGroupCode()) + "」" : "加入這一組") + '</button>' +
          '<button class="btn btn-sm" data-drop="' + esc(a.pid) + '" type="button">刪除申請</button>' +
        '</div>' +
      '</div>';
    }).join("");

    list.querySelectorAll("[data-claim]").forEach(btn => {
      btn.onclick = () => {
        const pid = btn.dataset.claim;
        let gid;
        if(isLeader()){
          const mine = visibleGroups()[0];
          gid = mine && mine.id;
        } else {
          const sel = list.querySelector('[data-pick="' + cssq(pid) + '"]');
          gid = sel && sel.value;
        }
        claimPending(pid, gid);
      };
    });
    list.querySelectorAll("[data-drop]").forEach(btn => {
      btn.onclick = () => dropPending(btn.dataset.drop);
    });
  }

  /* 申請 → 成員卡的轉換已經移到 Worker（applicantToMember，publish-relay.js）——
     它必須與「這筆是否仍在待認領區」的檢查在同一個交易裡,前端做不到。 */
  /* ★ 認領改成伺服器端的交易,不再是本機草稿。
     為什麼一定要搬到伺服器:認領在語意上是「這位申請人歸這一組」——一個只能發生一次的
     動作。原本它完全是前端操作(建成員卡 + 從清單移除),真正生效要等發布,而發布是多個
     獨立寫入。兩位組長同時認領同一人時,兩邊的草稿各自成立、各自通過版本檢查,於是各自
     寫成功自己那組的成員卡 —— 同一個人變成兩組的成員,而後者收到的訊息還是
     「這次沒有上線」。兩個瀏覽器看不到彼此,前端無論怎麼防都補不起來。
     現在由 Worker 在同一個交易裡確認「這筆還在待認領區」並寫入,第二位會拿到明確的
     already_claimed,而且他那組一個位元組都不會被寫入。 */
  async function claimPending(pid, gid){
    const i = PENDING.findIndex(x => x.pid === pid);
    const g = DATA.find(x => x.id === gid);
    if(i < 0 || !g) return;
    if(!canEditGroup(g)){ toast("你沒有修改這一組的權限", { warn:true }); return; }
    const session = loadSession();
    if(!session){ showLock(); toast("請先輸入管理密碼", { warn:true }); return; }
    if(!workerCaps.claim){
      toast("發布服務尚未升級，暫時無法認領。請稍候再試，或請總管理員更新 Worker。",
            { warn:true, duration:8000 });
      return;
    }
    /* 認領會立刻寫進網站,而本機草稿不會跟著送出去。兩者混在一起會讓「發布」的
       版本基準對不上,所以要求先把手上的修改處理掉 —— 講清楚比事後解釋容易。
       ★ 這裡一定要用 hasUnpublishedChanges() 而不是 dirty:dirty 只代表「距離上次
         自動存檔之後又動過」,存檔完成(400ms)就會被清成 false。用 dirty 判斷的話,
         草稿明明還沒發布卻會放行認領,而認領成功後的 loadData() 會把畫面換成線上資料
         —— 剛才的編輯從畫面上消失,使用者再改一個字,下一次自動存檔就用新畫面覆蓋掉
         原本的草稿,那才是真正的資料遺失。 */
    if(hasUnpublishedChanges()){
      toast("你還有尚未發布的修改。請先按「發布到網站」（或捨棄變更），再進行認領。",
            { warn:true, duration:9000 });
      return;
    }
    const name = PENDING[i].name || "新夥伴";
    toast("認領中…");
    const res = await workerFetch("/claim", { session, pid, group: g.code });
    if(res.ok){
      await loadData();
      /* 先把選取切到目標組再畫面重繪 —— 反過來的話這一輪畫的還是舊的選取。
         loadData() 之後 DATA 是全新的物件,gid 不一定還在(例如同時被改名),
         所以要用 fixSelected() 兜底。 */
      selected = gid; fixSelected(); renderAll();
      toast(`已認領「${name}」到「${g.code}」，並且**已經寫進網站**（不必再按發布）。` +
            `已標記為「資料需確認」，請確認資料後再發布一次。`, { duration: 9000 });
      return;
    }
    if(res.error === "already_claimed"){
      await loadData(); renderAll();
      toast(`「${name}」已經被其他組長認領走了，清單已更新。`, { warn:true, duration: 8000 });
      return;
    }
    if(res.error === "group_renamed"){
      toast("你這一組的代號已被總管理員改過，請重新整理頁面後再試。", { warn:true, duration: 8000 });
      return;
    }
    if(res.error === "session_expired" || res.httpStatus === 401){
      clearSession(); showLock();
      toast("登入逾時，請重新輸入密碼後再認領一次", { warn:true, duration: 6000 });
      return;
    }
    toast("認領沒有成功（" + (res.error || "未知錯誤") + "），資料沒有被改動，請稍後再試。",
          { warn:true, duration: 8000 });
  }
  function dropPending(pid){
    if(isViewer()) return;   // 刪申請是破壞性的,而且這個函式原本一道角色檢查都沒有
    const a = PENDING.find(x => x.pid === pid);
    if(!a) return;
    if(!confirm("刪除「" + (a.name || "這筆申請") + "」的申請？\n\n這筆資料會從待認領區移除，發布後就找不回來了。")) return;
    pushUndo();
    PENDING = PENDING.filter(x => x.pid !== pid);
    renderPending(); scheduleSaveAndValidate();
    toast("已刪除該筆申請，按「發布到網站」後生效");
  }

  /* ---------- boot ---------- */
  // 清掉舊版（權杖存本機加密）留下的機密，遷移到新架構後這些不該再存在
  try{
    localStorage.removeItem("member-directory-gh-token-v1");
    localStorage.removeItem("member-directory-gh-token-enc-v1");
    localStorage.removeItem("member-directory-gh-settings-v1");
  }catch(e){}
  /* 資料要等登入後才載入(組長只能拿自己那組,載入範圍取決於角色) */
  async function bootData(){
    /* 草稿範圍在這裡固定下來(登入之後、讀資料之前),之後 session 過期也不會漂移。
       同一個範圍只讓一個分頁自動存草稿,見 startTabGuard()。 */
    lockDraftScope();
    startTabGuard();
    try{
      await loadData();
    }catch(e){
      main.innerHTML = '<div class="adm-card">載入資料失敗，請重新整理頁面。<br><small>' + esc(String(e && e.message || e)) + '</small></div>';
      return;
    }
    tryLoadDraft();
    fixSelected();
    renderAll(); validate();
    // 登入當下資料還沒抓回來,組長的組名查不到(會顯示「找不到此組」),載完要再寫一次
    showWho();
    showDraftBanner(hasDraft);
    /* 上次發布其實成功了、只是沒收到回應 —— 講清楚。使用者當時看到的是失敗訊息
       (甚至是「有人在你編輯期間發布過」),不講的話他會以為修改還沒上線而重做一次。 */
    if(recoveredPaths.length){
      toast("上次發布其實已經成功了（" + recoveredPaths.length + " 個檔案），只是當時沒收到回應。" +
            "已自動對齊，可以直接繼續編輯。", { duration: 10000 });
    }
  }
  renderAll();
  validate();
  showDraftBanner(hasDraft);
  updateHistoryButtons();
  saveState.textContent = "就緒";
  showLock();   // 密碼閘門：解鎖（或先設定 Worker 網址）才能編輯

  byId("btn-add-group").onclick = () => { addGroup(); closeDrawerIfMobile(); };
  byId("btn-export").onclick = download;
  byId("btn-publish").onclick = publish;
  byId("btn-settings").onclick = openSettings;
  byId("btn-discard").onclick = discardDraft;
  byId("btn-logout").onclick = logout;
  byId("btn-save").onclick = manualSave;
  byId("btn-csv-export").onclick = csvExport;
  byId("btn-missing").onclick = missingReport;
  if(SHEET_URL && byId("sheet-link")){ byId("sheet-link").href = SHEET_URL; byId("sheet-link").hidden = false; }
  byId("batch-cancel").onclick = closeBatchModal;
  byId("batch-apply").onclick = () => { const fn = batchApplyFn; closeBatchModal(); if(fn) fn(); };
  byId("batch-modal").addEventListener("click", e => { if(e.target.id === "batch-modal") closeBatchModal(); });
  refreshCaps();   // 問一次 Worker 是否支援附件（照片實體檔）；失敗就當不支援，行為同舊版
  /* 已有有效 session(重新整理頁面)就直接載入,並且要把鎖定畫面收起來 ——
     上面那行 showLock() 是「預設鎖住」,安全的預設;但少了這裡的 hideLock(),
     30 分鐘的 session 等於形同虛設,每次重新整理都要再打一次帳密。
     角色相關的介面(哪些鈕該藏)也要在這裡跑一次,不然重整後會以總管理員的樣子顯示。 */
  if(loadSession()){ hideLock(); applyRoleUI(); showWho(); bootData(); }
  byId("btn-undo").onclick = undo;
  byId("btn-redo").onclick = redo;
  byId("s-save").onclick = saveSettings;
  byId("s-cancel").onclick = closeSettings;
  byId("s-test").onclick = testConnection;
  byId("lock-enter").onclick = tryUnlock;
  byId("lock-user").addEventListener("keydown", e => { if(e.key === "Enter") byId("lock-pass").focus(); });
  byId("lock-pass").addEventListener("keydown", e => { if(e.key === "Enter") tryUnlock(); });
  showWho();
  byId("s-worker-url").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); saveSettings(); } });
  byId("lock-setup").onclick = () => { openSettings(); };
  byId("perm-recheck").onclick = () => { hidePermBanner(); toast("已隱藏提醒，發布時若還有問題會再顯示"); };
  byId("settings-modal").addEventListener("click", e => { if(e.target.id === "settings-modal") closeSettings(); });

  // 總覽儀表板收合(記住選擇)
  const DASH_KEY = "member-directory-dash-collapsed";
  try{ if(localStorage.getItem(DASH_KEY) === "1") document.body.classList.add("dash-collapsed"); }catch(e){}
  byId("dash-toggle").onclick = () => {
    const c = document.body.classList.toggle("dash-collapsed");
    try{ localStorage.setItem(DASH_KEY, c ? "1" : "0"); }catch(e){}
  };

  // 側邊分組：桌機收合 / 手機抽屜
  byId("btn-collapse").onclick = () => document.body.classList.toggle("side-collapsed");
  byId("btn-drawer").onclick = () => document.body.classList.toggle("drawer-open");
  byId("drawer-backdrop").onclick = closeDrawerIfMobile;

  // 回名錄：離開前若有未發布變更就提醒
  byId("btn-back-site").addEventListener("click", e => { e.preventDefault(); requestLeave(); });
  byId("leave-stay").onclick = closeLeaveModal;
  byId("leave-anyway").onclick = () => { closeLeaveModal(); leaveToSite(); };
  byId("leave-publish").onclick = async () => {
    const b = byId("leave-publish"), orig = b.textContent;
    b.disabled = true; byId("leave-anyway").disabled = true; b.textContent = "發布中…";
    const ok = await publish();
    b.disabled = false; byId("leave-anyway").disabled = false; b.textContent = orig;
    closeLeaveModal();
    if(ok) leaveToSite();   // 發布失敗就留在編輯頁，publish() 已用 toast 說明原因
  };
  byId("leave-modal").addEventListener("click", e => { if(e.target.id === "leave-modal") closeLeaveModal(); });

  document.addEventListener("keydown", e => {
    if(e.key === "Escape"){
      if(!byId("crop-modal").hidden){ byId("crop-cancel").click(); return; }
      if(!byId("batch-modal").hidden){ closeBatchModal(); return; }
      if(!byId("leave-modal").hidden){ closeLeaveModal(); return; }
      if(!byId("settings-modal").hidden){ closeSettings(); return; }
      if(document.body.classList.contains("drawer-open")){ closeDrawerIfMobile(); return; }
    }
    // 只有在編輯中（非鎖定、非彈窗）才吃 Ctrl+Z / Ctrl+Y
    const editing = byId("lock-overlay").hidden && byId("settings-modal").hidden && byId("crop-modal").hidden && byId("leave-modal").hidden && byId("batch-modal").hidden;
    if(editing && (e.ctrlKey || e.metaKey)){
      if(e.key === "z" && !e.shiftKey){ e.preventDefault(); undo(); }
      else if((e.key === "z" && e.shiftKey) || e.key === "y"){ e.preventDefault(); redo(); }
    }
  });

  window.addEventListener("beforeunload", () => { if(dirty) saveDraft(); });
})();
