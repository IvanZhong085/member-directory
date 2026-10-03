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
     夥伴資料更新(待審核)   更新表單送來的修改:逐欄確認後由 Worker 寫進網站
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
  /* 衝突路徑 → 線上版本裡「夥伴自己送來、已經套用」的成員姓名(見 tryLoadDraft)。
     套用夥伴更新是伺服器端直接寫進組檔,而那筆待審核在套用當下就刪掉了 —— 另一台裝置
     上的舊草稿一旦蓋回去,更新就找不回來。發布前的衝突確認要把這些人點名出來。
     跟著 conflictPaths 一起增減:那邊刪掉一個路徑,這邊也要刪。 */
  const conflictMupd = new Map();
  /* 舊草稿裡「沒辦法安全地只寫上修改」的分組檔路徑(見 mergeStaleDraft)。
     沒有記錄當初的來源版本(舊格式草稿)、或對不起來(分組在線上被刪、代號被別組佔走)時,
     我們不知道草稿裡哪些是使用者改的、哪些只是舊資料 —— 這種組在發布時**一律擋下**,
     不再提供「繼續 = 覆蓋」(10/1 事故就是按了那個確定)。
     會跟著草稿一起存:不存的話,下一次自動存檔就把來源版本換成線上值,重新整理之後
     這幾組看起來就像「沒有衝突」,舊內容會被無聲送出去。 */
  const unmergeablePaths = new Set();
  /* 合併舊草稿之後的說明(常駐,要按「知道了」才收起)。見 renderMergeNotice。 */
  let mergeNotice = null;

  const dataPathOf = code => "data/" + String(code).trim().toLowerCase() + ".json";
  /* 分組代號只能是英數字:它同時是檔名(data/<代號>.json)與權限的判定依據。
     新增分組時預設代號是「新」,沒改就發布會被 Worker 擋下,所以檢查表要先講。 */
  const GROUPCODE_RE = /^[A-Za-z0-9]{1,8}$/;
  const DATA_PATH_RE = /^data\/(_index|_pending|[a-z0-9]{1,8})\.json$/;
  const PENDING_PATH = "data/_pending.json";
  const INDEX_PATH = "data/_index.json";
  /* 分組檔(data/<代號>.json),不含 _index、_pending */
  const isGroupPath = p => DATA_PATH_RE.test(String(p)) && p !== INDEX_PATH && p !== PENDING_PATH;
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
    /* 夥伴資料更新的待審核清單跟著每一次載入重抓:登入、認領、套用、捨棄變更都會經過這裡。
       審核畫面的「目前（網站上）」是拿 DATA 比的,DATA 換了清單就該跟著換。
       不 await —— 清單讀不到不該擋住整個後台載入。 */
    refreshMemberUpdates();
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
  /* 審核區把伺服器端寫入後的線上資料重讀進 DATA 時呼叫(套用夥伴更新、重新整理)。
     堆疊裡的快照是「寫入之前」的整份資料,版本基準卻已經是重讀後的新值 —— 這時按「上一步」
     再發布,不會撞到 stale_base、也不會跳衝突提示,會把已套用的夥伴更新(連同 lastUpdateFrom)
     無聲蓋回舊內容,而那筆待審核已經刪掉了(§4.8 的同類風險)。
     只在審核區自己的重讀呼叫,不放進 loadData():登入、認領、捨棄變更是既有流程,這次不動。 */
  function resetHistory(){
    undoStack = [];
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
      /* unmergeable / conflicts:這幾個路徑的「來源版本」已經不在 loadedBody 裡了(那裡現在
         是線上值),只有這兩份清單記得它們還沒解決。分組檔的衝突不存:能合併的已經合併掉了,
         合併不了的在 unmergeable 裡。 */
      localStorage.setItem(draftKey(), JSON.stringify({
        savedAt: Date.now(), data: DATA, pending: PENDING,
        baseHashes: baseHashes, loadedBody: loadedBody, sentBody: sentBody,
        unmergeable: [...unmergeablePaths],
        conflicts: [...conflictPaths].filter(p => p === INDEX_PATH || p === PENDING_PATH),
        mergeNotice: mergeNotice,
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

  /* 自動接續這台裝置上的草稿(有橫幅提示「尚未發布」)。
     草稿跟線上對不起來時(這段期間有人發布過)不再整份照搬:能合併的組只把使用者真的改過的
     地方套到最新資料上,合併不了的組鎖住不准發布。見 mergeStaleDraft。 */
  function tryLoadDraft(){
    if(isViewer()) return;   // 唯讀帳號一律看線上的真實資料,不吃任何草稿(見 saveDraft)
    let raw; try{ raw = localStorage.getItem(draftKey()); }catch(e){ return; }
    if(!raw) return;
    let parsed; try{ parsed = JSON.parse(raw); }catch(e){ return; }
    if(!parsed || !Array.isArray(parsed.data) || !parsed.data.length) return;
    /* 先留住 loadData() 剛抓到的線上實況 —— 下面會被草稿蓋掉,但 reconcileWithLive()
       需要拿它跟「上次送出去的內容」比對,才認得出「其實已經發布成功了」;
       合併舊草稿也需要它(線上那一份分組與待認領清單)。 */
    const liveHashes = Object.assign({}, baseHashes);
    const liveBody = Object.assign({}, loadedBody);
    const liveData = DATA;
    const livePending = PENDING;
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
       草稿的內容照樣還原給使用者看;「草稿的來源版本 ≠ 線上現況」的那幾個路徑先被標成衝突,
       接著由 mergeStaleDraft 處理:分組檔三方合併(只寫上真的改過的地方),合併不了的鎖住、
       發布時擋下;分會結構與待認領區被草稿改過的,發布前一定會問過人。 */
    conflictPaths.clear();
    conflictMupd.clear();
    unmergeablePaths.clear();
    const draftBase = (parsed.baseHashes && typeof parsed.baseHashes === "object") ? parsed.baseHashes : null;
    // 純邏輯抽在 admin-logic.js,才有辦法寫自動測試(見 tests/logic.test.mjs)
    AdminLogic.computeConflicts(draftBase, liveHashes).forEach(p => conflictPaths.add(p));
    /* 上一次存草稿時還沒解決的(見 saveDraft):那時已經把來源版本換成線上值,
       單靠雜湊比對看不出來,要從清單接回來。 */
    const listOf = v => Array.isArray(v) ? v.filter(p => typeof p === "string") : [];
    listOf(parsed.conflicts).forEach(p => { if(liveHashes[p]) conflictPaths.add(p); });
    listOf(parsed.unmergeable).forEach(p => unmergeablePaths.add(p));
    mergeNotice = parsed.mergeNotice && typeof parsed.mergeNotice === "object" ? parsed.mergeNotice : null;

    /* 先認「上次其實發布成功了」,再合併:那幾個檔的線上內容就是我們自己送出去的,
       不是別人的修改 —— 先合併的話,照片(草稿裡是內嵌圖、線上已經是檔名)會被當成
       兩邊都改過,說明裡多出一堆假的「保留網站上的版本」。 */
    if(parsed.sentBody && typeof parsed.sentBody === "object"){
      for(const k of Object.keys(sentBody)) delete sentBody[k];
      Object.assign(sentBody, parsed.sentBody);
    }
    recoveredPaths = reconcileWithLive(liveHashes, liveBody);

    const merged = mergeStaleDraft(parsed, liveData, livePending);

    /* 還留在衝突清單裡的分組檔(合併不了、或草稿裡沒有那一組),有沒有「夥伴自己送來、
       已經套用」的更新會被這份草稿蓋回舊內容 —— 發布前的衝突確認要點名(乙 4)。
       判斷規則在 overwrittenMemberUpdates。 */
    for(const p of conflictPaths){
      if(!isGroupPath(p)) continue;
      const live = liveData.find(g => dataPathOf(g.code) === p);
      const draft = live ? DATA.find(g => g && g.id === live.id) : null;
      if(!live || !draft) continue;
      const names = AdminLogic.overwrittenMemberUpdates(live, draft);
      if(names.length) conflictMupd.set(p, names);
    }
    if(!DATA.some(g => g.id === selected)) selected = DATA.length ? DATA[0].id : null;
    hasDraft = true;

    if(merged){
      /* 合併完的結果跟線上完全一樣(草稿其實沒改什麼):這份草稿已經沒有用了,清掉 ——
         否則橫幅會一直說「有尚未發布的變更」,而認領、救回等功能也會因此被擋住。 */
      if(draftMatchesLive()){
        hasDraft = false;
        if(mergeNotice === merged) merged.cleared = true;
        if(!tabIsSecondary){ try{ localStorage.removeItem(draftKey()); }catch(e){} }
      }else{
        saveDraft();       // 新的來源版本 = 線上;下次開頁面不會再合併一次
      }
    }
  }

  /* 草稿跟線上對不起來時,逐組三方合併。草稿跟線上本來就一致時回傳 null(什麼都沒做);
     否則回傳這次的合併紀錄 —— 有值得講的事(合併了分組、鎖住了分組、結構換成線上的)
     時它同時成為 mergeNotice,畫面上會常駐一則說明。

     base(草稿當初的來源版本)來自草稿裡存的 loadedBody;分組對應一律用分組 id,
     不用路徑 —— 草稿裡改了代號、或線上改了代號,路徑都會不一樣,id 不會。

     每一組的結果是三種之一:
       不必處理 來源版本 = 線上(沒有人在這段期間發布過這一組)
       合併     有來源版本 → AdminLogic.mergeGroupThreeWay,只寫上草稿改過的地方
       鎖住     沒有來源版本(舊格式草稿)、分組在線上已經被刪、或代號被別組佔走
                → unmergeablePaths,發布時擋下(見 publish)
     分會結構(_index)與待認領區(_pending):草稿**沒改過**的話直接用線上的,
     改過的話維持原本發布前的確認(不在這次的範圍)。 */
  function mergeStaleDraft(parsed, liveData, livePending){
    if(!conflictPaths.size && !unmergeablePaths.size) return null;
    const lockedBefore = new Set(unmergeablePaths);    // 上次就鎖住的(已經講過了)
    let newlyLocked = false;
    const baseBodies = parsed.loadedBody && typeof parsed.loadedBody === "object" ? parsed.loadedBody : {};
    const parseText = t => { if(typeof t !== "string") return null; try{ return JSON.parse(t); }catch(e){ return null; } };
    const baseIndex = (() => { const j = parseText(baseBodies[INDEX_PATH]); return Array.isArray(j) ? j : null; })();
    const baseCodeOf = id => {
      const e = baseIndex && baseIndex.find(x => x && x.id === id);
      return e && e.code != null ? String(e.code) : null;
    };
    const asBody = g => { const b = groupBody(g || {}); if(!Array.isArray(b.members)) b.members = []; return b; };
    const report = { savedAt: parsed.savedAt || null, at: Date.now(), groups: [], lost: [], unmergeable: [], structure: false };

    /* ① 分會結構:草稿沒動過(代號、組名、順序都跟來源版本一樣)→ 照線上的結構重排。
       線上新增的組直接放進來;線上已經刪掉的組拿掉(草稿裡那組有改過的話,在說明裡講)。
       只有總管理員握有結構;組長的草稿只有自己那一組。 */
    if(!isLeader() && conflictPaths.has(INDEX_PATH) && baseIndex){
      const shape = list => list.map(e => ({ code: String(e && e.code), name: String(e && e.name), id: String(e && e.id) }));
      if(AdminLogic.sameJson(shape(DATA), shape(baseIndex))){
        const next = [];
        for(const L of liveData){
          const D = DATA.find(g => g && g.id === L.id);
          if(D){ D.code = L.code; D.name = L.name; next.push(D); }
          else next.push(clone(L));          // 線上新增的組:內容就是線上的,不必合併
        }
        for(const D of DATA){
          if(next.indexOf(D) >= 0) continue;
          const bc = baseCodeOf(D.id);
          const base = bc == null ? null : parseText(baseBodies[dataPathOf(bc)]);
          if(!base || !AdminLogic.sameJson(asBody(D), asBody(base))) report.lost.push(String(D.code || ""));
        }
        DATA = next;
        conflictPaths.delete(INDEX_PATH);
        report.structure = true;
      }
    }

    // ② 待認領區:現在認領、刪申請都是伺服器端交易,草稿正常情況下不會改它
    if(conflictPaths.has(PENDING_PATH)){
      const base = parseText(baseBodies[PENDING_PATH]);
      if(Array.isArray(base) && AdminLogic.sameJson(base, PENDING)){
        PENDING = livePending;
        conflictPaths.delete(PENDING_PATH);
      }
    }

    // ③ 分組內容
    const lock = (code, paths) => {
      if(!paths.some(p => lockedBefore.has(p))) newlyLocked = true;
      paths.forEach(p => { if(p) unmergeablePaths.add(p); });
      if(report.unmergeable.indexOf(code) < 0) report.unmergeable.push(code);
    };
    for(const D of DATA){
      if(!D || typeof D !== "object") continue;
      const pD = dataPathOf(D.code);
      const L = liveData.find(g => g.id === D.id);
      const occupant = liveData.find(g => g.id !== D.id && dataPathOf(g.code) === pD);
      if(!L){
        /* 線上沒有這一組:草稿新增的組沒事;來源版本裡有它 = 線上已經把它刪掉,
           發布等於把整組救回來,而且是舊內容。路徑被別組佔走也一樣不能寫。 */
        if(occupant || unmergeablePaths.has(pD) || baseCodeOf(D.id) != null) lock(String(D.code || ""), [pD]);
        continue;
      }
      const pL = dataPathOf(L.code);
      const bc = baseCodeOf(D.id);
      const pB = bc != null ? dataPathOf(bc) : pL;
      if(occupant || unmergeablePaths.has(pL) || unmergeablePaths.has(pD)){ lock(String(D.code || ""), [pL, pD]); continue; }
      if(pB === pL && !conflictPaths.has(pL)) continue;            // 來源版本就是線上的
      const base = parseText(baseBodies[pB]);
      if(!base || typeof base !== "object" || Array.isArray(base)){ lock(String(D.code || ""), [pL, pD]); continue; }
      const r = AdminLogic.mergeGroupThreeWay(asBody(base), asBody(D), asBody(L));
      for(const k of GROUP_BODY_KEYS){ if(r.group[k] !== undefined) D[k] = r.group[k]; }
      conflictPaths.delete(pL);
      conflictMupd.delete(pL);
      report.groups.push({ code: String(D.code || ""), applied: r.report.applied,
                           conflicts: r.report.conflicts, reordered: r.report.reordered });
    }
    /* 只有「待認領區換成線上的」這種事不必講 —— 認領天天在發生,每次都跳說明只會變成雜訊。
       上次就鎖住、而且說明還沒被收起的,沿用原本那則(日期是原本那份草稿的)。 */
    if(report.groups.length || report.lost.length || report.structure || newlyLocked) mergeNotice = report;
    return report;
  }

  /* 手上的資料跟線上一模一樣(不算照片轉檔):分組內容、待認領區、分會結構都沒有差異,
     也沒有還沒解決的衝突。跟 buildPublishPayload 用同一套比法。 */
  function draftMatchesLive(){
    if(conflictPaths.size || unmergeablePaths.size) return false;
    for(const g of DATA){
      if(serializeBody(groupBody(g)) !== loadedBody[dataPathOf(g.code)]) return false;
    }
    if(loadedBody[PENDING_PATH] != null && JSON.stringify(PENDING, null, 2) + "\n" !== loadedBody[PENDING_PATH]) return false;
    if(!isLeader()){
      const idx = JSON.stringify(DATA.map(g => ({ code: g.code, name: g.name, id: g.id })), null, 2) + "\n";
      if(idx !== loadedBody[INDEX_PATH]) return false;
    }
    return !AdminLogic.computeRenameRemovals(DATA, originalPathByGroupId, dataPathOf).length;
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
      conflictMupd.delete(path);
      fixed.push(path);
    }
    return fixed;
  }
  function discardDraft(){
    if(!confirm("捨棄尚未發布的變更，改回目前公開網站的內容？")) return;
    clearTimeout(saveTimer);
    dirty = false;
    for(const k of Object.keys(sentBody)) delete sentBody[k];   // 草稿都不要了,復原線索一起清掉
    /* 衝突與鎖住的清單是「這份草稿」的,草稿丟了就跟著清掉 —— 留著的話,之後在最新資料上
       重新修改那一組,發布時還會被舊草稿的衝突擋下或問一次。合併說明也一起收起來。 */
    conflictPaths.clear(); conflictMupd.clear(); unmergeablePaths.clear();
    mergeNotice = null; renderMergeNotice();
    try{ localStorage.removeItem(draftKey()); }catch(e){}
    loadData().then(() => {
      showDraftBanner(false);
      renderAll(); validate(); toast("已捨棄變更，已重新載入目前線上的內容");
    }).catch(() => toast("重新載入失敗，請重新整理頁面", { warn: true }));
  }

  /* ---------- 合併舊草稿的說明 ----------
     常駐在草稿橫幅下方,要按「知道了」才收起 —— 不是一閃而過的 toast。
     使用者要知道「這份草稿是哪一天的、哪幾處被寫上去、哪幾處保留了網站上的版本」,
     發布前才能再看一眼;10/1 那位使用者並不知道自己手上是一份 8 月的草稿。
     說明跟著草稿一起存(saveDraft),重新整理之後還在,直到按「知道了」。 */
  const MERGE_FIELD_LABELS = Object.assign({}, AdminLogic.FIELD_LABELS, {
    name:"姓名", number:"編號", image:"形象照", card:"名片", products:"商品照",
    dataIssue:"資料需確認", lastUpdateFrom:"夥伴更新紀錄",
    leader:"組長", room:"分組地點", recruiting:"招募席位",
  });
  const mergeFieldLabel = f => Object.prototype.hasOwnProperty.call(MERGE_FIELD_LABELS, f) ? MERGE_FIELD_LABELS[f] : String(f);
  const groupLabelOf = code => (String(code == null ? "" : code).toUpperCase() || "?") + " 組";
  const STALE_BLOCK_MSG = "這份草稿太舊，沒辦法安全地只寫上你的修改。請按「下載備份」留一份，再按「捨棄變更」取得最新資料，然後重新修改。";
  const MERGE_LIST_MAX = 12;     // 清單太長在手機上會佔滿整個畫面;多的只講還有幾處

  /* 說明裡的條列:每一處一句話(純文字,畫的時候才 esc) */
  function mergeNoticeItems(n){
    const applied = [], conflicts = [];
    const who = name => String(name || "") || "（未命名）";
    const labels = fields => (fields || []).map(mergeFieldLabel).join("、");
    for(const g of (Array.isArray(n.groups) ? n.groups : [])){
      const gl = groupLabelOf(g.code);
      for(const a of (Array.isArray(g.applied) ? g.applied : [])){
        if(a.kind === "group") applied.push(gl + " 改了" + labels(a.fields));
        else if(a.kind === "added") applied.push(gl + " 新增了 " + who(a.name));
        else if(a.kind === "removed") applied.push(gl + " 刪除了 " + who(a.name));
        else applied.push(gl + " 改了 " + who(a.name) + ((a.fields || []).length ? "（" + labels(a.fields) + "）" : ""));
      }
      if(g.reordered) applied.push(gl + " 調整了成員順序");
      for(const c of (Array.isArray(g.conflicts) ? g.conflicts : [])){
        if(c.kind === "kept_deleted_edited") conflicts.push(gl + " " + who(c.name) + "：你刪掉了他，但網站上之後有人改過他的資料，所以沒有刪除");
        else if(c.kind === "edited_but_deleted") conflicts.push(gl + " " + who(c.name) + "：你改了他的資料，但網站上已經刪除他，維持刪除");
        else if(c.kind === "both_added") conflicts.push(gl + " " + who(c.name) + "：兩邊都新增了這一位，用網站上的那一份");
        else if(c.kind === "group_field") conflicts.push(gl + "（" + mergeFieldLabel(c.field) + "）");
        else conflicts.push(gl + " " + who(c.name) + (c.field ? "（" + mergeFieldLabel(c.field) + "）" : ""));
      }
    }
    return { applied, conflicts };
  }
  function renderMergeNotice(){
    const el = byId("merge-notice");
    if(!el) return;
    const n = mergeNotice;
    if(!n){ el.hidden = true; el.innerHTML = ""; return; }
    const { applied, conflicts } = mergeNoticeItems(n);
    const list = items => '<ul class="merge-list">' +
      items.slice(0, MERGE_LIST_MAX).map(t => "<li>" + esc(t) + "</li>").join("") +
      (items.length > MERGE_LIST_MAX ? "<li>…還有 " + (items.length - MERGE_LIST_MAX) + " 處</li>" : "") + "</ul>";
    const when = AdminLogic.updateMonthDay(n.savedAt);
    const locked = Array.isArray(n.unmergeable) ? n.unmergeable : [];
    let h = '<div class="merge-title">🔀 這台裝置有一份' + esc(when ? " " + when + " " : "較早") + '的草稿，網站在那之後更新過。</div>';
    if(n.cleared){
      h += "<p>草稿裡沒有你需要套用的修改，已經改用網站上最新的資料。這份舊草稿已清除，不會蓋掉任何人的更新。</p>";
    }else if(applied.length){
      h += "<p>已經只把你改過的 <b>" + applied.length + " 處</b>套到最新資料上，其他都用網站上的版本：</p>" + list(applied) +
           "<p>請確認無誤，再按「發布到網站」。</p>";
    }else if(Array.isArray(n.groups) && n.groups.length){
      h += "<p>網站更新過的分組裡，你的草稿沒有需要套用的修改，已經改用網站上最新的資料。</p>";
    }
    if(conflicts.length){
      h += "<p>兩邊都改到的 <b>" + conflicts.length + " 處</b>保留網站上的版本：</p>" + list(conflicts);
    }
    if(n.structure) h += "<p>分組結構（代號、組名、順序）在網站上改過，已經改用網站上的。</p>";
    if(Array.isArray(n.lost) && n.lost.length){
      h += "<p>" + esc(n.lost.map(groupLabelOf).join("、")) + " 在網站上已經刪除，草稿裡這幾組的修改沒有套用。</p>";
    }
    if(locked.length){
      h += '<p class="merge-warn">⚠ ' + esc(locked.map(groupLabelOf).join("、")) + "：" +
           (n.blocked ? "這次沒有發布。" : "發布時會擋下這幾組。") + esc(STALE_BLOCK_MSG) + "</p>";
    }
    h += '<div class="merge-btns">' +
         (locked.length ? '<button class="btn btn-sm" type="button" data-merge="backup">下載備份</button>' +
                          '<button class="btn btn-sm" type="button" data-merge="discard">捨棄變更</button>' : "") +
         '<button class="btn btn-sm" type="button" data-merge="close">知道了</button></div>';
    el.innerHTML = h;
    el.hidden = false;
    el.classList.toggle("warn", locked.length > 0);
    const on = (k, fn) => { const b = el.querySelector('[data-merge="' + k + '"]'); if(b) b.onclick = fn; };
    on("backup", download);
    on("discard", discardDraft);
    on("close", dismissMergeNotice);
  }
  function dismissMergeNotice(){
    mergeNotice = null;
    renderMergeNotice();
    // 草稿還在的話跟著存一次,重新整理之後才不會又跳出來;草稿已經清掉(或發布了)就不要再建一份
    if(hasUnpublishedChanges()) saveDraft();
  }

  /* ---------- toast (optional action button, e.g. undo) ---------- */
  let toastTimer = null;
  let toastUntil = 0;      // 目前這則 toast 顯示到什麼時候(給「排在後面」的呼叫端用)
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
    const dur = opts.duration || 2600;
    /* 目前這則會顯示到什麼時候。toast 只有一個元素,後來的會直接蓋掉前面那則 ——
       想「排在現在這則後面」的呼叫端(待認領提醒)得知道要等多久。 */
    toastUntil = Date.now() + dur;
    toastTimer = setTimeout(hideToast, dur);
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
    const linkOk = updateLinkEnabled() && canEditGroup(g);
    wrap.innerHTML = g.members.map((m, i) => memberCardHTML(m, i, g.members.length, linkOk)).join("");
    g.members.forEach((m, i) => bindMember(g, m, i));
  }

  function memberCardHTML(m, i, total, linkOk){
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
          ${linkOk ? `<div class="mem-updlink">
            <button class="btn btn-sm" data-act="updlink" type="button">🔗 複製已帶好名字的更新連結</button>
            <span class="hint">私訊給本人，他就能自己更新文字資料（送出後要你審核才會上線）</span>
          </div>` : ""}
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
    const updBtn = card.querySelector('[data-act="updlink"]');
    if(updBtn) updBtn.onclick = () => copyMemberUpdateLink(g, m);
  }

  /* ---------- 夥伴資料更新表單的連結 ----------
     兩種連結:
       已帶好名字的(成員卡上的按鈕)  預選名字 + 預填目前的文字資料 + 「連結代碼」
       只預選名字的(催收、不採用訊息)  不帶資料、不帶代碼
     為什麼催收用的不帶資料:那種訊息是貼在 LINE 群裡的,帶了資料就等於把每個人的內容
     攤在群組;而且群組訊息會一直留著,帶代碼的舊連結過一陣子再被點開,代碼記的內容早就
     過期了。預填的「已帶好名字的連結」只私訊給本人。 */
  function updateFormEntries(){
    const e = SITE.UPDATE_FORM_ENTRIES;
    return e && typeof e === "object" ? e : {};
  }
  function updateLinkEnabled(){
    const e = updateFormEntries();
    return !!(SITE.UPDATE_FORM_URL && typeof e.member === "string" && e.member.trim());
  }
  /* 只預選名字的連結。沒設 member 的 entry、或沒有名字時退回通用連結;沒設表單網址回 "" */
  function nameOnlyUpdateLink(code, name){
    const hasName = String(name == null ? "" : name).trim() && String(code == null ? "" : code).trim();
    const r = AdminLogic.updatePrefillUrl(SITE.UPDATE_FORM_URL || "",
      hasName ? { member: updateFormEntries().member } : {},
      hasName ? { member: AdminLogic.memberUpdateLabel(code, name) } : {});
    return r ? r.url : "";
  }
  async function copyMemberUpdateLink(g, m){
    if(!updateLinkEnabled() || !canEditGroup(g)) return;
    const r = AdminLogic.updatePrefillUrl(SITE.UPDATE_FORM_URL, updateFormEntries(),
                                          AdminLogic.memberPrefillValues(g.code, m));
    if(!r){ toast("site-config.js 裡的夥伴資料更新表單網址格式不對，請聯繫總管理員。", { warn:true, duration:8000 }); return; }
    const ok = await copyPlain(r.url);
    if(!ok){ toast("複製失敗，請再按一次", { warn:true }); return; }
    /* 「不是密碼」要講:預填的連結把這位夥伴目前的資料都帶在網址裡,而且任何人拿到都能
       用他的名字送出。只私訊給本人,不要貼到群組。 */
    let msg = (r.trimmed ? "已複製（內容太長，只帶入名字）。" : "已複製（已帶入名字和他目前的資料）。") +
              "這條連結不是密碼，任何人拿到都能填；請只私訊給本人。";
    /* 連結帶入的是畫面上的內容,連結代碼記的也是這一份 —— 本人沒動的格子會被略過,不會被當成修改;
       但組長要知道他發出去的不是網站上的版本。 */
    if(hasUnpublishedChanges()) msg += "連結帶入的是你畫面上還沒發布的內容。";
    toast(msg, { duration:9000 });
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
  /* 催收訊息超過這個長度就退回「只附一條通用連結」的版本。LINE 單則上限 5,000 字,
     留一點餘裕;一組 5–10 人逐人附連結約 2,000 字,正常碰不到。 */
  const MISSING_NOTICE_MAX = 4800;
  /* 缺項檢查的文字欄位,順序就是訊息裡列出來的順序 */
  const MISSING_TEXT_FIELDS = ["company", "business_items", "services", "targets", "have", "want", "tagline"];
  function missingReport(){
    const items = [];
    const fieldCount = {};
    const bump = k => { fieldCount[k] = (fieldCount[k] || 0) + 1; };
    const scope = visibleGroups();          // 組長只看自己那組的缺項
    /* 缺項名稱一律和表單題目同名(AdminLogic.FIELD_LABELS):組長請夥伴補「主要營業項目」,
       夥伴在更新表單上找得到同一個字。照片類不在表單上,用 LINE 傳給組長。 */
    const FL = AdminLogic.FIELD_LABELS;
    scope.forEach(g => g.members.forEach(m => {
      const miss = [];
      if(!m.image) miss.push("形象照");
      if(!(m.card || "").trim()) miss.push("名片照片");
      if(!(m.products || []).length) miss.push("商品照片");
      for(const f of MISSING_TEXT_FIELDS){
        const v = m[f];
        const empty = Array.isArray(v) ? !v.filter(s => String(s).trim()).length : !String(v || "").trim();
        if(empty) miss.push(FL[f]);
      }
      if(miss.length){ items.push({ g, m, miss }); miss.forEach(bump); }
    }));
    const total = scope.reduce((n, g) => n + g.members.length, 0);
    const notice = missingNoticeText(items);
    const statHtml = Object.entries(fieldCount).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => "<tr><td>" + esc(k) + "</td><td>" + v + " 位</td></tr>").join("");
    const html =
      '<div class="batch-sec"><h4>缺項統計<span class="cnt">' + items.length + "／" + total + ' 位</span></h4>' +
      '<table class="batch-table"><tr><th>缺的項目</th><th>人數</th></tr>' + statHtml + "</table></div>" +
      '<div class="batch-sec"><h4>催收訊息(按下方「複製」直接貼到 LINE 群)</h4>' +
      '<textarea readonly rows="12" style="width:100%; font:inherit; font-size:12.5px; line-height:1.8; border:1.5px solid var(--border-2); border-radius:10px; padding:10px 12px; background:var(--bg-soft);">' +
      esc(notice) + "</textarea></div>" +
      '<div class="batch-note">商品照片與名片屬選填，催收語氣自行斟酌；照片類請夥伴用 LINE 傳給組長，由組長在成員卡上傳。</div>';
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
  /* 催收訊息本文。三種版本:
       沒設更新表單        維持原文:請夥伴把缺的內容回覆給網管
       總管理員(全分會)   附一條通用連結,夥伴自己選名字
       組長(只看一組)     每一位後面附「只預選名字」的連結,夥伴點了不用在 90 人的選單裡找自己
     文字資料走表單、照片走 LINE 分成兩句:表單不收照片(收照片就得強制登入,
     從 LINE 點進來的長輩會卡在登入畫面)。 */
  function missingNoticeText(items){
    const formUrl = SITE.UPDATE_FORM_URL || "";
    if(!formUrl){
      const lines = items.map(it => "・" + it.m.name + "(" + (it.g.code || "?") + "):缺 " + it.miss.join("、"));
      return [
        "【會員名錄・資料補齊通知】",
        "以下夥伴的名錄資料還有缺項,麻煩抽空補上,讓你的頁面更有引薦力 💪",
        "請直接把缺的內容回覆給網管,由網管統一更新。",
        "",
      ].concat(lines).join("\n");
    }
    const head = ["【會員名錄・資料補齊通知】", "以下夥伴的名錄資料還有缺項，麻煩抽空補上，讓你的頁面更有引薦力 💪", ""];
    const photo = ["", "📷 形象照、名片、商品照：請直接用 LINE 傳給你的組長。", ""];
    const general = head.concat([
      "📝 文字資料（公司、主要營業項目、我有／我要…）：",
      "點下面的連結 → 選自己的名字 → 只填缺的那幾格，其他空著就好（不會被清掉）。送出後組長確認就會上線。",
      formUrl,
    ], photo, items.map(it => "・" + it.m.name + "（" + (it.g.code || "?") + "）：缺 " + it.miss.join("、"))).join("\n");
    if(!isLeader() || !updateLinkEnabled()) return general;
    const personal = head.concat([
      "📝 文字資料（公司、主要營業項目、我有／我要…）：",
      "點自己名字後面的連結（名字已經幫你選好） → 只填缺的那幾格，其他空著就好（不會被清掉）。送出後組長確認就會上線。",
    ], photo, items.map(it => {
      const link = nameOnlyUpdateLink(it.g.code, it.m.name);
      return "・" + it.m.name + "：缺 " + it.miss.join("、") + (link ? " 👉 " + link : "");
    })).join("\n");
    // 太長貼不進 LINE 一則訊息 → 退回只附一條通用連結的版本
    return personal.length > MISSING_NOTICE_MAX ? general : personal;
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

  /* 可以帶一則或多則。多則時全部列出來 —— 設定沒完成的地方常常不只一個,
     只講第一件會讓人修好之後以為結束了,下一次才發現還有下一件。 */
  function showPermBanner(msg){
    const msgs = (Array.isArray(msg) ? msg : [msg]).filter(Boolean);
    if(!msgs.length) return;
    byId("perm-banner-text").textContent = msgs.join("\n\n");
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
    /* 待認領照片的 blob URL 撤掉再走。那是還沒被認領的人的名片,登出之後這個分頁
       不該還握著看得見的內容 —— 而 blob URL 只要沒 revoke 就一直能開。 */
    revokePendPhotos(null);
    closePendingPhotos();
    /* 夥伴送來的更新(含私人備註)也是還沒公開的內容,登出就從畫面上拿掉;
       草稿衝突的姓名清單屬於這次登入的草稿,一併清空。 */
    resetMemberUpdates();
    /* 衝突、鎖住的分組與合併說明都屬於這次登入載入的草稿。不清的話換另一個帳號登入
       (而他沒有草稿)時,會被上一個人的舊草稿擋下發布。 */
    conflictPaths.clear(); conflictMupd.clear(); unmergeablePaths.clear();
    mergeNotice = null; renderMergeNotice();
    resetRecycle();          // clearSession 之後:回收區整塊收起來,路上的回應作廢
    showLock();
    toast("已登出");
  }

  async function checkHealth(session){
    const res = await workerFetch("/health", { session });
    if(!res.ok) return;   // 網路問題等，不打擾，發布時自然會再報
    const msgs = [];
    if(res.github === "read_only"){
      msgs.push("Worker 上設定的 GitHub 權杖「只能讀、不能寫」，按發布會失敗。請管理員到 Cloudflare 該 Worker 的 GH_TOKEN 設定檢查（GitHub 那支權杖的 Contents 需為 Read and write）。");
    } else if(res.github === "invalid_token"){
      msgs.push("Worker 上設定的 GitHub 權杖無效或已過期／被撤銷。請管理員重新建立權杖並更新 Worker 的 GH_TOKEN 設定。");
    } else if(res.github === "repo_not_found"){
      msgs.push("Worker 找不到設定的 GitHub repo，請管理員檢查 Worker 的 GH_OWNER / GH_REPO 設定。");
    }
    /* "writable" 或 "network_error" → 不顯示提醒 */

    /* ★ 沒綁待認領照片的儲存空間 = 新夥伴表單正在退件，而且後台完全看不出來:
       待認領區是空的，看起來就只是「最近沒人申請」。先前只有在有人按認領時才會
       發現，可是申請根本沒進來，所以連那個提示都不會觸發 —— 登入時講，是唯一能在
       申請開始掉之前知道的位置。
       ★ 只在伺服器**明確回報**未綁定時才講。舊版 Worker 沒有這個欄位（undefined），
         那是「Worker 該更新了」，不是「R2 沒綁」，兩件事的處理方式不同。 */
    if(res.pendingImages === "unbound"){
      msgs.push("發布服務還沒接上「待認領照片」的儲存空間（Cloudflare R2）。" +
                "在完成設定之前，新夥伴自填表單送出的申請會全部被退回、不會進待認領區。" +
                "請總管理員建立 private R2 bucket 並綁定為 PENDING_IMAGES，再重新 Deploy Worker（見 worker/README.md）。");
    }
    /* ★ 夥伴資料更新表單已經貼進 site-config.js,Worker 卻還不支援(舊版,或沒綁 R2):
       夥伴在 LINE 點連結送出的更新會全部被退回,而後台的審核區只會是一片空白,
       看起來就像「最近沒人送」。只有總管理員能處理,所以只對總管理員講。
       ★ /ping 本身失敗(capsOk 為 false)時不講 —— 那是暫時連不上,不是 Worker 太舊。 */
    const capsOk = await ensureCaps();
    if(capsOk && SITE.UPDATE_FORM_URL && workerCaps.memberUpdate !== true && !isLeader() && !isViewer()){
      msgs.push("夥伴資料更新表單已經公開，但發布服務還沒升級或還沒接上 R2（PENDING_IMAGES），" +
                "夥伴送出的更新會全部被退回。請總管理員更新 Worker（見 README「八、夥伴資料更新表單」）。");
    }
    showPermBanner(msgs);
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

  /* 這次發布會寫到或刪掉、而且被鎖住(舊草稿沒辦法安全合併)的分組檔。
     刪除也要算:改名時舊檔會被刪掉,裡面是線上最新的內容。 */
  function staleBlockedPaths(payload){
    const paths = payload.files.map(f => f.path).concat(payload.remove || []);
    return paths.filter(p => unmergeablePaths.has(p));
  }

  /* ---------- 最近刪除的夥伴:發布時記進回收區 ----------
     發布是整檔覆寫,刪掉的人只剩 git 歷史裡找得到,而那要網管才救得回來。
     發布成功後把被刪的人(完整資料 + 原本在哪一組、第幾位)交給 Worker 存進私有 R2 的回收區,
     儀表板的「最近刪除的夥伴」就能一鍵救回。 */
  const RECYCLE_BATCH_MAX = 20;                   // 與 Worker 的 /recycle-put 上限一致
  const RECYCLE_MEMBER_MAX_BYTES = 64 * 1024;     // 同上:單筆序列化後的上限,超過整批會被退回
  const RECYCLE_MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /* payload → 被刪的人。比對的是「線上那一份」(loadedBody)與發布後的整份 DATA:
     同一個 id 搬到別組不算刪除;改名的組舊檔也算進來(它在 payload.remove 裡)。 */
  function deletedMembersOf(payload){
    const touched = payload.files.map(f => f.path).filter(isGroupPath).concat(payload.remove || []);
    const gidByPath = {};
    for(const gid of Object.keys(originalPathByGroupId)) gidByPath[originalPathByGroupId[gid]] = gid;
    const live = [];
    for(const p of touched){
      const gid = gidByPath[p];
      if(!gid || typeof loadedBody[p] !== "string") continue;      // 新的組:線上本來就沒有人
      let body; try{ body = JSON.parse(loadedBody[p]); }catch(e){ continue; }
      const g = DATA.find(x => x.id === gid);
      live.push({ gid, code: g ? g.code : p.replace(/^data\/|\.json$/g, "").toUpperCase(),
                  members: body && Array.isArray(body.members) ? body.members : [] });
    }
    return AdminLogic.removedMembers(live, DATA);
  }

  /* 發布成功後才呼叫。失敗重試一次(只重送還沒寫進去的那幾筆);還是不行就明講,
     而且要講「已發布」—— 這則會蓋掉發布成功的 toast,不講的話會以為發布失敗而再發一次。
     Worker 會擋下格式不合的整批:id 不合格、不是這一組開頭的 id(舊資料)、太大的(內嵌照片)、
     代號不合格的,先在這裡挑掉,算進「沒有記進去」的人,其他人照常記。 */
  async function recordDeleted(items){
    const session = loadSession();
    const ok = [], miss = [];
    for(const it of items){
      const id = String(it.member && it.member.id || "");
      let bytes = Infinity;
      try{ bytes = new TextEncoder().encode(JSON.stringify(it.member)).length; }catch(e){}
      if(RECYCLE_MEMBER_ID_RE.test(id) && id.indexOf(it.gid + "_") === 0 && bytes <= RECYCLE_MEMBER_MAX_BYTES &&
         GROUPCODE_RE.test(String(it.code || "").trim())) ok.push(it);
      else miss.push(it);
    }
    const put = list => Promise.race([
      workerFetch("/recycle-put", { session, items: list }),
      new Promise(r => setTimeout(() => r({ ok:false, error:"timeout" }), 15000)),   // 不要讓發布鈕一直卡在「發布中」
    ]);
    for(let i = 0; i < ok.length; i += RECYCLE_BATCH_MAX){
      let chunk = ok.slice(i, i + RECYCLE_BATCH_MAX);
      let res = session ? await put(chunk) : { ok:false };
      if(!res.ok && session){
        chunk = chunk.slice(Math.max(0, Number(res.stored) || 0));     // 中途失敗時前面幾筆已經寫進去了
        res = await put(chunk);
      }
      if(!res.ok) chunk.slice(Math.max(0, Number(res.stored) || 0)).forEach(it => miss.push(it));
    }
    if(miss.length){
      const names = miss.map(it => String(it.member && it.member.name || "") || "未命名");
      toast("已發布 ✔，但這次刪除的夥伴沒有記進回收區，要救回請聯絡網管（" + names.join("、") + "）。",
            { warn:true, duration:14000 });
    }
    if(rcyOpen) loadRecycle();      // 回收區開著的話,剛刪的人馬上出現
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
      /* ★ 舊草稿裡沒辦法安全合併的分組:**不提供**「繼續 = 覆蓋」。
         10/1 的事故就是在這裡按了確定 —— 草稿一個字都沒改,6 個組檔卻被整檔換回 8 月的版本。
         沒有來源版本就分不出「使用者改的」和「只是舊資料」,唯一安全的做法是請他留一份備份、
         取得最新資料再重做。擋在衝突確認之前,而且不論角色、不論數量一律擋。 */
      const stuck = staleBlockedPaths(payload);
      if(stuck.length){
        const codes = [];
        stuck.forEach(p => { const c = p.replace(/^data\/|\.json$/g, ""); if(codes.indexOf(c) < 0) codes.push(c); });
        const base = mergeNotice || { savedAt: null, groups: [], lost: [], unmergeable: [] };
        const locked = (Array.isArray(base.unmergeable) ? base.unmergeable : []).slice();
        codes.forEach(c => { if(!locked.some(x => String(x).toLowerCase() === c)) locked.push(c.toUpperCase()); });
        mergeNotice = Object.assign({}, base, { unmergeable: locked, blocked: true });
        renderMergeNotice();
        const box = byId("merge-notice");
        if(box && box.scrollIntoView) box.scrollIntoView({ behavior:"smooth", block:"center" });
        toast(codes.map(groupLabelOf).join("、") + "沒有發布：" + STALE_BLOCK_MSG, { warn:true, duration:14000 });
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
        /* 會被蓋掉的「已套用的夥伴更新」要放在最前面講:那幾筆待審核已經刪掉了,
           一按確定就找不回來,而草稿主人光看「A1 組被其他人發布過」不會知道這件事。 */
        const mupdNames = [];
        hit.forEach(p => (conflictMupd.get(p) || []).forEach(n => { if(mupdNames.indexOf(n) < 0) mupdNames.push(n); }));
        const mupdWarn = mupdNames.length
          ? "⚠ 線上版本含有夥伴自己送來、已經套用的資料更新：" + mupdNames.join("、") + "。\n" +
            "按「確定」會把他們的資料改回你草稿裡的舊內容，而且那幾筆更新已經從待審核清單刪除，找不回來。\n" +
            "建議按「取消」→「下載備份」→「捨棄變更」，再重做你自己的修改。\n\n"
          : "";
        const okOverride = confirm(mupdWarn +
          "以下項目在你離開之後被其他人發布過：\n\n  " + names.join("、") +
          "\n\n你手上的草稿是根據更早的版本編輯的。要繼續發布嗎？\n" +
          "（繼續 = 用你的版本覆蓋對方的修改；取消 = 先按「捨棄變更」取得最新資料，" +
          "或用「下載備份」把你的內容留一份再處理）");
        if(!okOverride) return false;
        hit.forEach(p => { conflictPaths.delete(p); conflictMupd.delete(p); });   // 已經問過了,不再重複打擾
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

      /* 這次會刪掉的夥伴,要在**送出之前**算:成功之後 loadedBody 就換成新內容,
         線上原本那一份(要放進回收區的完整資料、他原本的位置)就沒了。
         真的寫進回收區要等發布成功 —— 失敗的發布什麼都沒刪。 */
      const removedNow = workerCaps.recycle === true ? deletedMembersOf(payload) : [];

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
        /* 發布不經過 loadData(),但審核區的「目前（網站上）」是拿 DATA 比的 —— 剛發布的內容
           可能正好是某筆待審核要改的欄位,清單要跟著重畫,預設勾選才會對。 */
        refreshMemberUpdates();
        /* 等它跑完才回去:離開提醒視窗的「發布並離開」在發布成功後會立刻換頁,
           沒等的話,記錄刪除的請求會跟著頁面一起被取消。 */
        if(removedNow.length) await recordDeleted(removedNow);
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
      // 夥伴資料更新表單:已上架的夥伴自己更新文字資料,送出後進下方「夥伴資料更新(待審核)」
      if(SITE.UPDATE_FORM_URL) h += '<a class="dtool" href="' + esc(SITE.UPDATE_FORM_URL) + '" target="_blank" rel="noopener">✏️ 夥伴資料更新表單</a>';
      if(SHEET_URL) h += '<a class="dtool" href="' + esc(SHEET_URL) + '" target="_blank" rel="noopener">📊 名冊試算表</a>';
      tools.innerHTML = h;
    }
    renderRecycle();
  }

  /* ---------- 儀表板:🗑 最近刪除的夥伴 ----------
     發布時被刪掉的人會記進私有 R2 的回收區(見 recordDeleted)。刪錯了在這裡按「救回」,
     由 Worker 放回他原本那一組、原本的位置,直接寫進網站 —— 不必再找網管翻 git 歷史。
     預設收起,按「查看」才去讀:儀表板每改一個字就重畫一次,不能每次都打一趟 Worker。
     唯讀帳號整塊看不到(伺服器也會回 403);組長只看得到自己那一組的。 */
  let rcyOpen = false;
  let rcyItems = null;        // 最近一次成功讀到的清單(還沒讀過是 null)
  let rcyTruncated = false;
  let rcyUnknown = 0;         // 回收區裡格式不對、被 Worker 略過的筆數
  let rcyError = "";
  let rcyLoading = false;
  let rcyBusy = false;        // 有救回/永久刪除在路上時,其他按鈕先停用
  let rcySeq = 0;             // 只採用最後一次讀取的結果;登出也 +1,路上的回應一律作廢

  function recycleVisible(){ return workerCaps.recycle === true && !isViewer() && !!loadSession(); }

  function renderRecycle(){
    const wrap = byId("rcy"), body = byId("rcy-body"), btn = byId("rcy-toggle");
    if(!wrap || !body || !btn) return;
    if(!recycleVisible()){ wrap.hidden = true; body.innerHTML = ""; return; }
    wrap.hidden = false;
    btn.textContent = rcyOpen ? "收起" : "查看";
    btn.setAttribute("aria-expanded", rcyOpen ? "true" : "false");
    if(!rcyOpen){ body.hidden = true; body.innerHTML = ""; return; }
    body.hidden = false;
    let h = "";
    if(rcyLoading && !rcyItems) h += '<div class="rcy-msg">讀取中…</div>';
    if(rcyError) h += '<div class="rcy-msg warn">' + esc(rcyError) + '</div>';
    if(rcyItems){
      h += rcyItems.length ? '<div class="rcy-list">' + rcyItems.map(rcyRowHTML).join("") + '</div>'
                           : '<div class="rcy-msg">最近沒有刪除的夥伴。</div>';
      if(rcyTruncated) h += '<div class="rcy-msg">筆數太多，只列出最近的一部分。</div>';
      if(rcyUnknown > 0) h += '<div class="rcy-msg">另有 ' + rcyUnknown + ' 筆紀錄看不懂（格式不對），沒有列出來。</div>';
    }
    h += '<div class="rcy-foot"><span>發布時刪掉的夥伴會自動記在這裡' + (isLeader() ? '（只列出你這一組的）' : '') + '。</span>' +
         '<button class="btn btn-sm" type="button" data-rcy-reload' + (rcyLoading || rcyBusy ? " disabled" : "") + '>重新整理</button></div>';
    body.innerHTML = h;
    const reload = body.querySelector("[data-rcy-reload]");
    if(reload) reload.onclick = reloadRecycleAll;
    body.querySelectorAll("[data-rcy-restore]").forEach(b => { b.onclick = () => restoreRecycled(b.dataset.rcyRestore); });
    body.querySelectorAll("[data-rcy-drop]").forEach(b => { b.onclick = () => dropRecycled(b.dataset.rcyDrop); });
  }

  /* 一列:姓名・組・刪除時間・刪除者。名錄上已經有同一個 id 的人(被別人救回、或刪掉之後
     又復原再發布)不給「救回」—— 救回去也只會被伺服器擋下 already_present。 */
  function rcyRowHTML(it){
    const g = DATA.find(x => x.id === it.gid);
    const group = g ? g.code + "・" + g.name : String(it.code || "?");
    const when = AdminLogic.updateTimeText(it.at);
    const meta = (when ? when + " 刪除" : "刪除時間不明") + (it.by ? "・" + it.by : "");
    const off = rcyBusy ? " disabled" : "";
    /* 原本那一組已經不在了(總管理員刪了整組):救回會被伺服器擋 group_missing,
       不給按鈕,直接講要找誰 */
    const acts = (findMemberById(it.id)
        ? '<span class="rcy-here">已經在名錄上</span>'
        : it.groupMissing === true
          ? '<span class="rcy-gone">原本的分組已經不在了，請總管理員手動加回</span>'
          : '<button class="btn btn-sm btn-primary" type="button" data-rcy-restore="' + esc(it.rid) + '"' + off + '>救回</button>') +
      (!isLeader() && !isViewer()
        ? '<button class="btn btn-sm" type="button" data-rcy-drop="' + esc(it.rid) + '"' + off + '>永久刪除</button>' : "");
    return '<div class="rcy-row">' +
      '<div class="rcy-main"><div class="rcy-name">' + esc(String(it.name || "（未命名）")) +
      ' <span class="rcy-group">' + esc(group) + '</span></div>' +
      '<div class="rcy-meta">' + esc(meta) + '</div></div>' +
      '<div class="rcy-acts">' + acts + '</div></div>';
  }

  /* 三支端點共用的錯誤說明。沒列到的碼照實帶出來,方便回報給網管。 */
  function recycleErrorText(res, name){
    const code = String((res && res.error) || (res && res.httpStatus ? "HTTP " + res.httpStatus : "unknown"));
    const who = name ? "「" + name + "」" : "這位夥伴";
    switch(code){
      case "already_present": return who + "已經在名錄上了（可能已經有人救回），回收區的這一筆已經清掉。";
      case "recycle_gone": return "這一筆已經不在回收區了（可能已經被救回或永久刪除），清單已更新。";
      case "group_missing": return who + "原本的分組已經不在了，沒辦法自動救回。請聯絡總管理員手動加回。";
      case "forbidden_group": return "你只能救回自己這一組的夥伴。";
      case "group_renamed": return "你這一組的代號已被總管理員改過，請重新整理頁面後再試。";
      case "admin_only": return "只有總管理員可以永久刪除。";
      case "read_only": return "唯讀帳號不能使用回收區。";
      case "stale_base": case "busy_retry_later": return "剛好有人同時在發布，這次沒有寫入。請等幾秒再按一次。";
      case "bad_data_file": case "data_too_large": case "data_file_too_large":
        return "救回之後的資料不符合規則（" + code + "），這次沒有寫入。請聯絡網管。";
      case "forbidden_path": return "你沒有修改這一組的權限，這次沒有寫入。";
      case "update_store_failed": return "回收區的儲存空間暫時讀寫失敗，請稍後再試一次（再按一次不會重複）。";
      case "restore_uncertain":
        return "GitHub 沒有回應，不確定" + who + "有沒有救回。請按這裡的「重新整理」：名單上顯示「已經在名錄上」就是救回了；" +
               "還沒有的話再按一次「救回」—— 再按是安全的，已經救回的話系統會擋下，不會變成兩個人。";
      case "pending_image_store_unavailable": return "發布服務還沒接上回收區的儲存空間（Cloudflare R2），暫時無法使用。請聯絡總管理員。";
      case "network": return "連不到發布服務，請檢查網路後再試一次。";
      default: return "沒有成功（" + code + "），請稍後再試。";
    }
  }
  function recycleSessionExpired(res){
    if(!(res && (res.error === "session_expired" || res.httpStatus === 401))) return false;
    clearSession(); showLock();
    toast("登入逾時，請重新輸入密碼後再試一次", { warn:true, duration:7000 });
    return true;
  }

  async function loadRecycle(){
    if(!recycleVisible()) return;
    const seq = ++rcySeq;
    rcyLoading = true; renderRecycle();
    const res = await workerFetch("/recycle-list", { session: loadSession() });
    if(seq !== rcySeq) return;           // 已經有更新的一次讀取,或已經登出
    rcyLoading = false;
    if(res.ok){
      rcyItems = (Array.isArray(res.items) ? res.items : []).filter(x => x && typeof x.rid === "string" && x.rid);
      rcyTruncated = res.truncated === true;
      rcyUnknown = Math.max(0, Number(res.unknown) || 0);
      rcyError = "";
    }else if(!recycleSessionExpired(res)){
      rcyError = "讀不到回收區：" + recycleErrorText(res);
    }
    renderRecycle();
  }

  /* 「重新整理」:手上沒有未發布的修改時,連網站資料一起重讀 —— 「已經在名錄上」是拿 DATA 比的,
     救回結果不確定(restore_uncertain)時,使用者就是靠這一顆確認有沒有救回來。
     有未發布的修改時只重抓清單,不動畫面上的資料(同審核區的重新整理)。 */
  async function reloadRecycleAll(){
    if(!hasUnpublishedChanges()){
      try{ await loadData(); resetHistory(); renderAll(); validate(); }
      catch(e){ toast("重新載入網站資料失敗，請重新整理頁面。", { warn:true, duration:7000 }); }
    }
    await loadRecycle();
  }

  /* 救回 = Worker 端交易,直接寫進網站。和認領一樣,手上不能有還沒發布的修改:
     救回成功後要 loadData() 換成線上資料,沒發布的編輯會從畫面上消失,之後的自動存檔
     再用新畫面蓋掉原本的草稿 —— 那才是真的資料遺失(見 claimPending 的說明)。 */
  async function restoreRecycled(rid){
    if(isViewer() || rcyBusy) return;
    const it = (rcyItems || []).find(x => x.rid === rid);
    if(!it) return;
    const name = String(it.name || "") || "這位夥伴";
    const session = loadSession();
    if(!session){ showLock(); toast("請先輸入管理密碼", { warn:true }); return; }
    if(hasUnpublishedChanges()){
      toast("你還有尚未發布的修改。請先按「發布到網站」（或捨棄變更），再救回刪除的夥伴。", { warn:true, duration:9000 });
      return;
    }
    const g = DATA.find(x => x.id === it.gid);
    if(!confirm("救回「" + name + "」到「" + (g ? g.code + "・" + g.name : String(it.code || "?")) + "」？\n\n" +
                "會立刻寫進網站（不必再按發布），放回他被刪除前的位置。")) return;
    rcyBusy = true; renderRecycle();
    toast("救回中…");
    let res;
    try{ res = await workerFetch("/recycle-restore", { session, rid }); }
    finally{ rcyBusy = false; }
    if(res.ok){
      /* 換成線上資料之後清掉「上一步」:堆疊裡是救回之前的整份資料,按了再發布會把他無聲刪回去
         (而且版本基準已經是新的,不會被擋)。審核區的套用是同一個理由,見 resetHistory。 */
      try{ await loadData(); resetHistory(); }
      catch(e){ toast("已救回，但重新載入網站資料失敗，請重新整理頁面。", { warn:true, duration:9000 }); loadRecycle(); return; }
      renderAll(); validate();
      toast("已救回「" + (String(res.name || "") || name) + "」，幾分鐘後前台就會看到。", { duration:9000 });
      loadRecycle();
      return;
    }
    if(recycleSessionExpired(res)){ renderRecycle(); return; }
    const err = String(res.error || "");
    if(err === "already_present"){
      try{ await loadData(); resetHistory(); renderAll(); validate(); }catch(e){}
    }
    if(err === "restore_uncertain"){
      /* 寫入可能已經落地:先把網站資料重讀一次,名單上的「已經在名錄上」才對得上;
         讀不到也沒關係,說明裡教他按「重新整理」再看。 */
      try{ await loadData(); resetHistory(); renderAll(); validate(); }catch(e){}
      toast(recycleErrorText(res, name), { warn:true, duration:16000 });
    }else if(err === "already_present" || err === "recycle_gone" || err === "group_missing" || err === "forbidden_group" ||
       err === "group_renamed" || err === "stale_base" || err === "busy_retry_later" || err === "bad_data_file" ||
       err === "data_too_large" || err === "data_file_too_large" || err === "forbidden_path" || err === "update_store_failed" ||
       err === "pending_image_store_unavailable" || err === "read_only"){
      toast(recycleErrorText(res, name), { warn:true, duration:10000 });
    }else{
      /* 網路斷掉、GitHub 逾時、沒列到的碼:不能說「沒有寫入」—— 寫入可能其實成功了。
         再按一次是安全的:已經在名錄上時伺服器會回 already_present,不會變成兩個人。 */
      toast("不確定有沒有救回（" + (err || (res.httpStatus ? "HTTP " + res.httpStatus : "unknown")) + "）。" +
            "請等一下按「重新整理」：" + name + "如果顯示「已經在名錄上」就是救回了；還沒有的話再按一次「救回」（不會重複）。",
            { warn:true, duration:16000 });
    }
    loadRecycle();
  }

  /* 永久刪除:只刪回收區的那一筆,網站上的資料不變。給「確定是刻意刪的、不想留」用,只有總管理員。 */
  async function dropRecycled(rid){
    if(isLeader() || isViewer() || rcyBusy) return;
    const it = (rcyItems || []).find(x => x.rid === rid);
    if(!it) return;
    const name = String(it.name || "") || "這位夥伴";
    const session = loadSession();
    if(!session){ showLock(); toast("請先輸入管理密碼", { warn:true }); return; }
    if(!confirm("永久刪除「" + name + "」的回收紀錄？\n\n刪了之後就沒辦法再救回（網站上的資料不會改變）。" +
                "只有確定是刻意刪掉、不需要留的才這樣做。")) return;
    rcyBusy = true; renderRecycle();
    let res;
    try{ res = await workerFetch("/recycle-drop", { session, rid }); }
    finally{ rcyBusy = false; }
    if(res.ok){
      rcyItems = (rcyItems || []).filter(x => x.rid !== rid);
      renderRecycle();
      toast("已永久刪除「" + name + "」的回收紀錄。", { duration:7000 });
      return;
    }
    if(recycleSessionExpired(res)){ renderRecycle(); return; }
    toast(recycleErrorText(res, name), { warn:true, duration:9000 });
    loadRecycle();
  }

  /* 登出:清單(含姓名與刪除者)從畫面拿掉,路上的回應作廢 */
  function resetRecycle(){
    rcySeq++;
    rcyOpen = false; rcyItems = null; rcyTruncated = false; rcyUnknown = 0; rcyError = ""; rcyLoading = false; rcyBusy = false;
    renderRecycle();
  }

  /* ---------- 待認領區 ----------
     新夥伴自填表單送來的申請放在 data/_pending.json,所有組長都看得到。
     按「認領」是伺服器端交易(見 claimPending),立刻生效,不必再按發布。 */

  /* 待認領區的上限。與 Worker 的 MAX_PENDING 是同一個數字 —— 這裡只用來算「還剩幾筆」
     的提醒級距,真正擋下的永遠是伺服器。兩邊不一致的話,最壞情況是提醒早一點或晚一點
     出現,不會讓資料出錯。 */
  const PENDING_MAX = 30;

  /* 待認領照片的預覽。
     照片存在**私有** R2,沒有公開網址(刻意的:未認領者的名片不該有任何公開連結)。
     這裡不簽網址,而是每一張都經過 /pending-photo 當場驗 session 取回位元組,
     再包成 blob URL 給 <img> 用。

     ★ 為什麼要快取:renderAll() 會因為各種原因反覆呼叫 renderPending(),沒有快取
       就等於每次重繪都把所有照片重抓一輪。
     ★ 為什麼要撤銷:blob URL 不 revoke 會一直佔著記憶體;而且那是還沒被認領的人的
       照片,不該在分頁裡留得比需要更久。申請一從清單消失就撤掉。 */
  const pendPhotoUrls = new Map();     // "pid|field|index" → blob URL
  /* 同一張照片同時被要兩次時共用同一個請求。
     ★ 用 AdminLogic 的合流器而不是自己拿一個 Map 寫 —— 第一版就是自己寫而且錯了:
       early return 寫在 try 之外,finally 不會跑,於是「暫時拿不到」被記成永久失敗,
       整頁到重新載入為止都不再抓照片。那段歷史寫在 makeSingleFlight 的註解裡,
       並且有測試守著。 */
  const pendPhotoFlight = AdminLogic.makeSingleFlight();
  function pendPhotoKey(pid, field, index){ return pid + "|" + field + "|" + (index == null ? -1 : index); }
  function revokePendPhotos(keepPids){
    for(const [k, url] of [...pendPhotoUrls]){
      if(keepPids && keepPids.has(k.slice(0, k.indexOf("|")))) continue;
      try{ URL.revokeObjectURL(url); }catch(e){}
      pendPhotoUrls.delete(k);
    }
    // 清單整個換掉／登出時,進行中的請求結果已經沒有意義,別讓它們留在合流器裡
    if(!keepPids) pendPhotoFlight.clear();
  }
  /* 回傳 blob URL,或 null(沒權限、照片不在了、Worker 太舊、網路不通)。
     一律不丟例外 —— 預覽只是輔助,它失敗絕不能讓待認領區畫不出來。
     ★ 失敗不做負向快取:session 過期、Worker 冷啟動、caps 還沒回來,都是
       「等一下就會好」的暫時狀態,下一次重繪要能重試。 */
  function fetchPendPhoto(pid, field, index){
    const key = pendPhotoKey(pid, field, index);
    if(pendPhotoUrls.has(key)) return Promise.resolve(pendPhotoUrls.get(key));
    return pendPhotoFlight.run(key, async () => {
      const session = loadSession();
      if(!session || isViewer() || !workerCaps.pendingPhoto) return null;
      const url = loadWorkerUrl();
      if(!url) return null;
      try{
        const r = await fetch(url + "/pending-photo", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ session, pid, field, index: index == null ? -1 : index }),
        });
        /* 成功時回的是圖片位元組,不是 JSON。非 2xx 一律當成「這張看不到」——
           錯誤細節對操作者沒有用,他能做的只有「照樣認領」或「找總管理員」。 */
        if(!r.ok) return null;
        const type = String(r.headers.get("Content-Type") || "");
        if(!/^image\/(jpeg|png|webp)$/.test(type)) return null;
        const blob = await r.blob();
        const obj = URL.createObjectURL(blob);
        pendPhotoUrls.set(key, obj);
        return obj;
      }catch(e){ return null; }
    });
  }

  /* 這一筆申請有哪幾張照片。回傳 [{ field, index, label }]。
     舊格式(部署 R2 之前收到的申請)照片仍以 data URL 內嵌,那一種直接就地顯示。 */
  function pendingPhotoSlots(a){
    const pr = a && a.photoRefs;
    if(!pr || typeof pr !== "object") return [];
    const out = [];
    if(pr.image) out.push({ field:"image", index:-1, label:"形象照" });
    if(pr.card)  out.push({ field:"card",  index:-1, label:"名片" });
    (Array.isArray(pr.products) ? pr.products : []).forEach((r, i) => {
      if(r) out.push({ field:"product", index:i, label:"商品照 " + (i + 1) });
    });
    return out;
  }
  function pendingInlinePhoto(a){
    return /^data:image\//.test((a && a.image) || "") ? a.image : "";
  }
  function pendingPhotoCount(a){
    const slots = pendingPhotoSlots(a);
    if(slots.length) return slots.length;
    return pendingInlinePhoto(a) ? 1 : 0;
  }

  /* 認領前把照片放大看清楚(名片上的字在 64px 縮圖裡讀不出來)。
     每次開啟才抓,關閉時不撤 URL —— 撤了的話同一張再開一次又要重抓;
     真正的撤銷交給 revokePendPhotos(),時機是「這筆申請已經不在清單裡」。 */
  /* 燈箱的「第幾次開啟」。每開一次、每關一次都 +1。
     ★ 沒有它會出事,而且不需要運氣就會重現:燈箱是**一組共用的 DOM 節點**。
       先開一筆照片在 R2 的申請(要等網路)→ 按 Esc 關掉 → 再開一筆舊格式的
       (照片內嵌,整段同步跑完,立刻畫好)→ 第一次那批 await 這時才回來,
       把 #pv-body 換成前一位的照片,而 #pv-title 還寫著後一位的名字。
       組長於是看著「李美華」的標題、王小明的名片,據此決定要把人分到哪一組。 */
  let pvSeq = 0;
  async function openPendingPhotos(pid){
    const a = PENDING.find(x => x && x.pid === pid);
    if(!a) return;
    const overlay = byId("pv-overlay"), body = byId("pv-body"), title = byId("pv-title");
    if(!overlay || !body) return;
    const mySeq = ++pvSeq;
    title.textContent = (a.name || "(未填姓名)") + "　的申請照片";
    body.innerHTML = '<div class="pv-empty">載入中…</div>';
    overlay.hidden = false;

    const inline = pendingInlinePhoto(a);
    const slots = pendingPhotoSlots(a);
    const items = [];
    if(inline) items.push({ label:"形象照", url:inline });
    /* 平行抓,不要逐張等 —— 一筆最多 7 張,序列的話就是 7 次完整往返
       (每一次都是瀏覽器→Worker→GitHub→R2),畫面會停在「載入中…」好幾秒。 */
    const got = await Promise.all(slots.map(s =>
      fetchPendPhoto(pid, s.field, s.index).then(url => ({ label:s.label, url }))));
    for(const g of got) if(g.url) items.push(g);

    /* 這批結果還是不是「現在畫面上這一位」的。關掉了、或已經開了別位,就直接丟掉。 */
    if(overlay.hidden || mySeq !== pvSeq) return;
    body.innerHTML = items.length
      ? items.map(it =>
          '<figure class="pv-item"><img src="' + esc(it.url) + '" alt="' + esc(it.label) + '">' +
          '<figcaption>' + esc(it.label) + '</figcaption></figure>').join("")
      : '<div class="pv-empty">這筆申請目前沒有可顯示的照片' +
        '（可能已超過保存期限被清除，或發布服務尚未接上照片儲存空間）。</div>';
  }
  function closePendingPhotos(){
    const overlay = byId("pv-overlay"), body = byId("pv-body");
    if(!overlay) return;
    pvSeq++;                      // 還在路上的那一批結果作廢,別讓它畫回已經關掉的燈箱
    overlay.hidden = true;
    if(body) body.innerHTML = "";
  }

  /* 已經催過的那一批 pid。同一批申請只在畫面上跳一次 toast ——
     renderAll() 每次都跳的話,那則提醒很快就會變成被無視的雜訊。 */
  let pendingNudged = "";
  let pendingNudgeTimer = null;

  function renderPending(){
    const wrap = byId("pending-wrap"), list = byId("pending-list"), sub = byId("pending-sub");
    const notice = byId("pending-notice");
    if(!wrap || !list) return;
    // 認領＝在某一組建一張成員卡,是編輯行為。唯讀帳號整塊不顯示。
    if(isViewer()){ wrap.hidden = true; list.innerHTML = ""; revokePendPhotos(null); return; }
    if(!PENDING.length){
      wrap.hidden = true; list.innerHTML = "";
      if(notice) notice.hidden = true;
      revokePendPhotos(null);
      pendingNudged = "";
      return;
    }
    wrap.hidden = false;
    if(sub) sub.textContent = PENDING.length + " 位等待認領";

    // 已經不在清單裡的申請,把它的預覽 URL 撤掉
    revokePendPhotos(new Set(PENDING.map(a => a && a.pid)));

    /* 「請盡速認領」的提醒。文案與級距由 AdminLogic.pendingNotice 決定(有測試)，
       這裡只負責畫出來。 */
    const note = (typeof AdminLogic !== "undefined" && AdminLogic.pendingNotice)
      ? AdminLogic.pendingNotice(PENDING.length, PENDING_MAX) : null;
    if(notice){
      if(note){
        notice.className = "pend-notice " + note.level;
        notice.textContent = (note.level === "info" ? "🙋 " : "⚠ ") + note.text;
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
    }
    /* 提醒之外再跳一次 toast:待認領區在頁面下方,只放一列橫幅的話,
       進來就直接編輯自己那組的人可能整場都不會捲到這裡。

       ★ 要排在「目前這則 toast」之後才送出。toast 只有一個元素,後來的會蓋掉前面的 ——
         直接跳的話,登入流程接著送出的「已進入編輯模式」會把這則提醒洗掉,
         而登入的那一刻正是最需要看到它的時候。認領成功後的長訊息同理。 */
    const stamp = PENDING.map(a => a && a.pid).join(",");
    if(note && stamp !== pendingNudged){
      pendingNudged = stamp;
      clearTimeout(pendingNudgeTimer);
      pendingNudgeTimer = setTimeout(() => toast(note.text, {
        warn: note.level !== "info", duration: 9000,
      }), Math.max(400, toastUntil - Date.now() + 200));
    }

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
      const inline = pendingInlinePhoto(a);
      const count = pendingPhotoCount(a);
      const pickGroup = isLeader()
        ? ""
        : '<select class="input-sm" data-pick="' + esc(a.pid) + '">' +
          groups.map(g => '<option value="' + esc(g.id) + '">' + esc((g.code || "?") + " " + (g.name || "")) + '</option>').join("") +
          '</select>';
      /* 縮圖先畫成佔位,內容由 hydratePendingPhotos() 補上 —— 待認領區不能等網路。 */
      const thumb = inline
        ? '<div class="pend-photo has-img" data-zoom="' + esc(a.pid) + '">' +
          '<img src="' + esc(inline) + '" alt="' + esc(a.name || "") + ' 的照片"></div>'
        : '<div class="pend-photo" data-thumb="' + esc(a.pid) + '"' +
          ' title="照片存在私有空間，登入後才看得到">' + (count ? "📷 " + count : "") + '</div>';
      return '<div class="pend-card" data-pid="' + esc(a.pid) + '">' + thumb +
        '<div class="pend-body">' +
          '<div class="pend-name">' + esc(a.name || "(未填姓名)") + '</div>' +
          (meta ? '<div class="pend-meta">' + meta + '</div>' : "") +
          '<div class="pend-at">申請時間：' + esc(fmtStamp(a.at, true) || "—") + '</div>' +
          (count ? '<button class="pend-more" type="button" data-zoom="' + esc(a.pid) + '">' +
                   '🔍 查看照片（' + count + '）</button>' : "") +
          /* 收件時就有問題的照片(例如 Drive 拿不到縮圖)。醒目但不擋住其他操作 ——
             組長仍然可以照常認領,只是會知道這一筆少了什麼、之後要手動補。 */
          (Array.isArray(a.photoWarnings) && a.photoWarnings.length
            ? '<div class="pend-warn">⚠ 這筆申請有照片沒有帶進來：' +
              esc(a.photoWarnings.map(w => (w && w.field) || "?").join("、")) +
              '（可以照常認領，之後手動補上）</div>'
            : "") +
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
    list.querySelectorAll("[data-zoom]").forEach(el => {
      el.onclick = () => openPendingPhotos(el.dataset.zoom);
    });
    hydratePendingPhotos();
  }

  /* 把縮圖補上去。刻意與 renderPending() 分開而且不 await:
     待認領區必須先畫出來,照片再慢慢進來 —— 反過來的話網路一慢,整塊就是空白。 */
  function hydratePendingPhotos(){
    const list = byId("pending-list");
    if(!list) return;
    list.querySelectorAll("[data-thumb]").forEach(box => {
      const pid = box.dataset.thumb;
      const a = PENDING.find(x => x && x.pid === pid);
      const slots = pendingPhotoSlots(a);
      // 縮圖只用形象照;沒有形象照就退而用第一張(有畫面總比一個灰方塊好)
      const s = slots.find(x => x.field === "image") || slots[0];
      if(!s) return;
      fetchPendPhoto(pid, s.field, s.index).then(url => {
        if(!url) return;
        // 這段時間裡可能已經重繪過:找當下畫面上的那一格,而不是抓著舊的 DOM
        const cur = document.querySelector('.pend-photo[data-thumb="' + cssq(pid) + '"]');
        if(!cur) return;
        cur.textContent = "";
        cur.classList.add("has-img");
        cur.dataset.zoom = pid;
        cur.onclick = () => openPendingPhotos(pid);
        const img = document.createElement("img");
        img.src = url;
        img.alt = (a && a.name ? a.name : "") + " 的照片";
        cur.appendChild(img);
      });
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
    let res = await workerFetch("/claim", { session, pid, group: g.code });

    /* ★ 照片在暫存區找不到時**預設擋下**,而不是預設放行。
       要在明知缺圖的情況下認領,必須先把缺哪幾張列出來讓人確認 —— 那幾張之後只能
       手動補,不該在使用者不知情的情況下建出一張沒有照片的成員卡。 */
    if(res.error === "pending_image_missing"){
      const labels = { image:"形象照", card:"名片" };
      const miss = (res.fields || []).map(f => labels[f] || (f.indexOf("product") === 0 ? "商品照" + f.replace(/\D/g, "") : f));
      const go = confirm(
        `「${name}」有照片在暫存區找不到了。\n\n缺少：${miss.join("、") || "(未知)"}\n\n` +
        `仍要認領嗎？\n（認領後這幾張會是空的，需要之後手動補上。其他資料不受影響。）`);
      if(!go){ toast("已取消認領,這筆申請仍留在待認領區。", { duration:6000 }); return; }
      res = await workerFetch("/claim", { session, pid, group: g.code, allowMissingImages:true });
    }

    if(res.ok){
      await loadData(); resetHistory();
      /* 認領／刪除是伺服器端直接寫進網站;重讀之後畫面換成線上資料,舊的「上一步」紀錄
         還停在認領前的待認領清單。按上一步再發布,會把舊清單送回去、而且不會跳出任何衝突提示。
         這兩個動作本來就只在沒有未發布修改時才能做,清掉歷史不會丟掉任何東西。 */
      /* 先把選取切到目標組再畫面重繪 —— 反過來的話這一輪畫的還是舊的選取。
         loadData() 之後 DATA 是全新的物件,gid 不一定還在(例如同時被改名),
         所以要用 fixSelected() 兜底。 */
      selected = gid; fixSelected(); renderAll();
      toast(`已認領「${name}」到「${g.code}」，並且**已經寫進網站**（不必再按發布）。` +
            `已標記為「資料需確認」，請確認資料後再發布一次。`, { duration: 9000 });
      return;
    }
    if(res.error === "already_claimed"){
      await loadData(); resetHistory(); renderAll();
      toast(`「${name}」已經被其他組長認領走了，清單已更新。`, { warn:true, duration: 8000 });
      return;
    }
    if(res.error === "group_renamed"){
      toast("你這一組的代號已被總管理員改過，請重新整理頁面後再試。", { warn:true, duration: 8000 });
      return;
    }
    if(res.error === "pending_image_corrupt"){
      toast(`「${name}」的照片在暫存區壞掉了（${res.field || ""}），認領已中止，這筆申請仍完整保留。` +
            `請聯繫總管理員。`, { warn:true, duration: 10000 });
      return;
    }
    if(res.error === "pending_image_store_unavailable"){
      toast("發布服務還沒接上照片暫存空間，暫時無法認領。請聯繫總管理員完成設定。",
            { warn:true, duration: 9000 });
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
  /* ★ 刪申請改成伺服器端交易,與認領一致。
     原本走「改草稿 → 發布」:那只把記錄從 _pending.json 移除,**照片不會被刪** ——
     申請人的名片會留在暫存空間直到 lifecycle 過期。而且刪除與寫入不在同一個交易裡,
     語意也與認領(立即生效)不一致。 */
  async function dropPending(pid){
    if(isViewer()) return;   // 刪申請是破壞性的,而且這個函式原本一道角色檢查都沒有
    const a = PENDING.find(x => x.pid === pid);
    if(!a) return;
    const session = loadSession();
    if(!session){ showLock(); toast("請先輸入管理密碼", { warn:true }); return; }
    if(!workerCaps.drop){
      toast("發布服務尚未升級，暫時無法刪除申請。請稍候再試，或請總管理員更新 Worker。",
            { warn:true, duration:8000 });
      return;
    }
    if(hasUnpublishedChanges()){
      toast("你還有尚未發布的修改。請先按「發布到網站」（或捨棄變更），再刪除申請。",
            { warn:true, duration:9000 });
      return;
    }
    if(!confirm("刪除「" + (a.name || "這筆申請") + "」的申請？\n\n" +
                "會立刻從待認領區移除，連同暫存的照片一起刪掉，之後找不回來。")) return;
    toast("刪除中…");
    const res = await workerFetch("/drop-pending", { session, pid });
    if(res.ok){
      await loadData(); resetHistory(); renderAll();
      toast("已刪除「" + (a.name || "這筆申請") + "」，照片也一併清掉了。", { duration:7000 });
      return;
    }
    if(res.error === "already_claimed"){
      await loadData(); resetHistory(); renderAll();
      toast("這筆申請已經被別人處理掉了，清單已更新。", { warn:true, duration:7000 });
      return;
    }
    toast("刪除沒有成功（" + (res.error || "未知錯誤") + "），資料沒有被改動，請稍後再試。",
          { warn:true, duration:8000 });
  }

  /* ---------- 夥伴資料更新(待審核) ----------
     已上架的夥伴從「夥伴資料更新表單」送來的修改。送出後先進私有 R2 的待審核區 ——
     不進公開 repo:沒審過的內容(包括冒名送件與私人備註)一旦進了 git 歷史就刪不掉。
     由那一組的組長或總管理員在這裡逐欄確認;按「套用」是 Worker 端的交易,直接寫進
     data/<組>.json,不必再按發布。唯讀帳號整塊看不到(伺服器也會回 403)。

     為什麼要逐欄確認、而且好幾種情況預設不勾:表單不必登入,只靠「選自己的名字」辨識身分,
     任何拿到網址的人都能選別人的名字。預設勾選與警示的規則都在
     AdminLogic.memberUpdateRows / memberUpdateHeader(有測試),這裡只負責畫出來、
     收集勾選、呼叫 Worker、把錯誤碼翻成看得懂的話。 */

  /* 一次批次不採用的上限,與 Worker 的 MAX_DROP_BATCH 一致(真正擋下的是伺服器) */
  const MUPD_BATCH_MAX = 100;
  /* 清單欄位最多幾項,與 Worker 的 INTAKE_LIST_MAX 一致(「加在原本後面」的預覽用) */
  const MUPD_LIST_MAX = 12;
  const MUPD_UNSUPPORTED = "發布服務尚未升級，暫時無法處理夥伴資料更新。請稍候再試，或請總管理員更新 Worker。";
  const MUPD_REMIND = "⚠ 表單不會驗證是不是本人。公司、網站大改，或內容看起來不像本人寫的，請先 LINE 跟本人確認再套用。";
  const MUPD_CONFIRM_ONLY = "本人確認資料正確，沒有要修改。";
  const MUPD_OPT_LABEL = { replace:"整格換成新的", append:"加在原本後面", skip:"不套用" };
  const MUPD_APPLY_OFF = "沒有要套用的欄位；已經手動處理好就按「已處理」，不要的就按「不採用」。";
  /* Worker 的清單、查看、套用、不採用遇到「組長登入時的代號已經不在分會結構裡」都回 group_renamed */
  const MUPD_GROUP_RENAMED = "你這一組的代號已被總管理員改過，請重新整理頁面後再試。";

  /* 清單的重抓用合流器包起來:loadData() 之後、發布之後、按「重新整理」都會要求重抓,
     同一時間只發一個請求。合流期間又有人要求的話(例如剛套用完、資料已經變了),
     結束後再抓一次 —— 否則會拿到「套用之前」的那份清單,已處理的那筆又冒出來。 */
  const mupdFlight = AdminLogic.makeSingleFlight();
  let mupdLast = Promise.resolve();
  let mupdWanted = 0;
  let mupdEpoch = 0;               // 登出就 +1:路上還沒回來的結果一律作廢
  let mupdList = null;             // 最近一次成功的 /member-updates 回應
  let mupdError = "";              // 最近一次讀取失敗的錯誤碼;成功後清空
  let mupdCards = [];              // 最近一次畫出來的卡片(groupMemberUpdates 的結果)
  const mupdReqs = new Map();      // uid → 完整請求(/member-update-get)
  const mupdOpen = new Set();      // 展開中的請求 uid
  const mupdView = new Map();      // uid → 展開時算好的差異表與「當時看到的成員」
  const mupdChecked = new Set();   // 總管理員批次勾選的卡片
  let mupdNudged = "";             // 已經跳過 toast 的那一批(uid 串接)
  let mupdNudgedRank = -1;         // 上一次提醒的級距(info 0 / warn 1 / danger 2),升級時再催一次
  let mupdActing = false;          // 有套用/不採用在路上時,其他按鈕先停用
  let mupdAfter = null;            // 套用後常駐的備註提醒 { memberId, name, note, cleared }

  function mupdSupported(){ return workerCaps.memberUpdate === true; }
  /* 每個動作之前都再問一次:/ping 可能剛好失敗過(ensureCaps 會重問),
     Worker 也可能在這段時間被換成舊版。 */
  async function mupdReady(){
    await ensureCaps();
    if(mupdSupported()) return true;
    toast(MUPD_UNSUPPORTED, { warn:true, duration:8000 });
    return false;
  }
  function mupdSession(){
    const s = loadSession();
    if(!s){ showLock(); toast("請先輸入管理密碼", { warn:true }); }
    return s;
  }
  function mupdSessionExpired(res){
    if(res.error !== "session_expired" && res.httpStatus !== 401) return false;
    clearSession(); showLock();
    toast("登入逾時，請重新輸入密碼後再試一次。", { warn:true, duration:6000 });
    return true;
  }
  const mupdCode = res => String((res && res.error) || (res && res.httpStatus ? "HTTP " + res.httpStatus : "unknown"));
  const mupdKey = c => c.memberId ? "m:" + c.memberId : "u:" + c.items[0].uid;
  const mupdCardBusy = c => c.items.some(it => it.busy === true);
  const mupdLabel = f => Object.prototype.hasOwnProperty.call(AdminLogic.FIELD_LABELS, f) ? AdminLogic.FIELD_LABELS[f] : String(f);
  function findMemberById(id){
    if(!id) return null;
    for(const g of DATA){
      const m = (g.members || []).find(x => x && x.id === id);
      if(m) return { g, m };
    }
    return null;
  }
  /* 原始值(不正規化)。expect 要送「審核者畫面上那一欄的目前值」,Worker 會拿它跟
     線上的成員逐欄比對 —— 送正規化過的值也比得過,但原樣送最不會出意外。 */
  function mupdRawValue(m, f){
    const v = m ? m[f] : undefined;
    if(v == null) return AdminLogic.LIST_FIELDS.indexOf(f) >= 0 ? [] : "";
    return v;
  }

  /* toast 只有一個元素,後來的會蓋掉前面的。審核區的提醒(登入時的催促、套用後的
     「清單清除失敗」)要排在目前這則之後,而且彼此也要排隊。 */
  const mupdToastQueue = [];
  let mupdToastTimer = null;
  function mupdToastLater(msg, opts){
    mupdToastQueue.push({ msg, opts: opts || {} });
    if(!mupdToastTimer) mupdToastTimer = setTimeout(pumpMupdToast, Math.max(400, toastUntil - Date.now() + 200));
  }
  function pumpMupdToast(){
    mupdToastTimer = null;
    const wait = toastUntil - Date.now();
    if(wait > 0){ mupdToastTimer = setTimeout(pumpMupdToast, wait + 200); return; }
    const next = mupdToastQueue.shift();
    if(!next) return;
    toast(next.msg, next.opts);
    if(mupdToastQueue.length) mupdToastTimer = setTimeout(pumpMupdToast, (next.opts.duration || 2600) + 200);
  }

  function copyWithToast(text){
    copyPlain(text).then(ok => toast(ok ? "已複製，可以直接貼到 LINE 私訊給本人。" : "複製失敗，請再按一次",
                                     ok ? { duration:5000 } : { warn:true }));
  }

  /* ---- 讀清單 ---- */
  function refreshMemberUpdates(){
    mupdWanted++;
    const epoch = mupdEpoch;
    mupdLast = mupdFlight.run("list", async () => {
      let seen;
      do{
        seen = mupdWanted;
        await loadMemberUpdatesOnce(epoch);
      }while(seen !== mupdWanted && epoch === mupdEpoch);
    });
    return mupdLast;
  }
  async function loadMemberUpdatesOnce(epoch){
    const session = loadSession();
    if(!session || isViewer() || !mupdSupported()){
      // 唯讀帳號、沒登入、Worker 不支援:一個 /member-update* 都不打,整塊藏起來
      mupdList = null; mupdError = "";
      renderMemberUpdates();
      return;
    }
    const res = await workerFetch("/member-updates", { session });
    if(epoch !== mupdEpoch) return;           // 這段時間裡登出了
    if(res.ok && Array.isArray(res.items)){
      mupdList = res; mupdError = "";
    } else if(mupdSessionExpired(res)){
      return;
    } else {
      /* ★ 讀不到不可以當成 0 筆而把整塊藏起來 —— 那等於告訴組長「沒有人送更新」,
         夥伴卻一直等不到回音。上一次成功的清單留著,上面加一行錯誤。 */
      mupdError = mupdCode(res);
    }
    renderMemberUpdates();
  }
  /* 「重新整理」:手上沒有未發布的修改時,連網站資料一起重讀 —— 差異表的「目前（網站上）」
     是拿 DATA 比的,只重抓清單的話,別人剛發布的內容看不到,「看起來已經套用過了」也判斷不出來。
     有未發布的修改就只抓清單:重讀資料會把畫面換成線上版,下一次自動存檔就蓋掉草稿。 */
  async function mupdReloadAll(){
    if(!hasUnpublishedChanges()){
      try{
        await loadData();          // 成功的話它自己會重抓清單
        resetHistory();            // 重讀之前的快照不能再拿來復原(見 resetHistory)
        renderAll();
        await mupdLast;
        return;
      }catch(e){
        toast("重新載入網站資料失敗，請重新整理頁面。", { warn:true, duration:7000 });
      }
    }
    await refreshMemberUpdates();
  }

  /* ---- 畫清單 ---- */
  function renderMemberUpdates(){
    const wrap = byId("mupd-wrap"), list = byId("mupd-list");
    if(!wrap || !list) return;
    const sub = byId("mupd-sub"), notice = byId("mupd-notice"), errEl = byId("mupd-error"), batch = byId("mupd-batch");
    if(!loadSession() || isViewer() || !mupdSupported()){
      wrap.hidden = true; list.innerHTML = ""; mupdCards = []; mupdView.clear();
      return;
    }
    const items = mupdList && Array.isArray(mupdList.items) ? mupdList.items : [];
    const cards = AdminLogic.groupMemberUpdates(items);
    mupdCards = cards;
    const note = AdminLogic.memberUpdateNotice({
      count: items.length,
      openAll: mupdList && mupdList.openAll != null ? mupdList.openAll : items.length,
      max: mupdList && mupdList.max,
      oldestAt: cards.length ? cards[0].oldestAt : "",
      oldestName: cards.length ? cards[0].name : "",
    }, Date.now());
    const truncated = !!(mupdList && mupdList.truncated);
    const unknown = mupdList ? Number(mupdList.unknown) || 0 : 0;

    // 已經不在清單上的請求,快取與勾選一起清掉
    const live = new Set(items.map(it => it.uid));
    for(const u of [...mupdReqs.keys()]) if(!live.has(u)) mupdReqs.delete(u);
    for(const u of [...mupdOpen]) if(!live.has(u)) mupdOpen.delete(u);
    const keys = new Set(cards.map(mupdKey));
    for(const k of [...mupdChecked]) if(!keys.has(k)) mupdChecked.delete(k);
    mupdView.clear();

    const show = cards.length > 0 || !!note || !!mupdError || truncated || unknown > 0 || !!mupdAfter;
    if(!show){
      wrap.hidden = true; list.innerHTML = "";
      mupdNudged = ""; mupdNudgedRank = -1;
      return;
    }
    wrap.hidden = false;
    if(sub) sub.textContent = cards.length ? cards.length + " 位夥伴・" + items.length + " 筆待審核" : "目前沒有待審核的更新";

    if(notice){
      if(note){
        notice.className = "pend-notice " + note.level;
        notice.textContent = (note.level === "info" ? "✏️ " : "⚠ ") + note.text;
        notice.hidden = false;
      } else notice.hidden = true;
    }
    if(errEl){
      /* group_renamed:組長的代號被總管理員改了,登入時拿到的代號已經對不上 —— 按這裡的「重新整理」
         沒有用,要重新整理整個頁面(和發布、認領同一句話) */
      errEl.textContent = !mupdError ? ""
        : mupdError === "group_renamed" ? MUPD_GROUP_RENAMED
        : "待審核更新讀取失敗（" + mupdError + "），請按「重新整理」再試。";
      errEl.hidden = !mupdError;
    }
    /* 審核區在頁面下方,進來就直接編輯自己那組的人可能整場都不會捲到這裡。
       比照待認領區:同一批只跳一次,排在目前的 toast 之後。
       「同一批」= 沒有新進來的請求、提醒也沒有升級。處理掉幾筆之後剩下的那些不再催 ——
       否則每按一次「套用」,成功訊息後面就會再跳一次「有 N 筆等待審核」。 */
    const RANK = { info:0, warn:1, danger:2 };
    const seen = new Set(mupdNudged ? mupdNudged.split(",") : []);
    const fresh = items.some(it => !seen.has(it.uid));
    if(note && (fresh || RANK[note.level] > mupdNudgedRank)){
      mupdToastLater(note.text, { warn: note.level !== "info", duration: 9000 });
    }
    mupdNudged = items.map(it => it.uid).join(",");
    mupdNudgedRank = note ? RANK[note.level] : -1;
    renderMupdAfter();

    const admin = !isLeader() && !isViewer();
    if(batch) batch.hidden = !(admin && cards.some(c => !mupdCardBusy(c)));

    let top = "";
    if(truncated){
      top += '<div class="mupd-flag">⚠ 清單不完整（待審核太多），請先處理幾筆再按重新整理；仍然如此請聯繫總管理員。' +
             (unknown > 0 ? "有 " + unknown + " 筆格式不對，已略過。" : "") + '</div>';
    } else if(unknown > 0){
      top += '<div class="mupd-flag info">有 ' + unknown + ' 筆格式不對，已略過。</div>';
    }
    list.innerHTML = top + cards.map(c => mupdCardHTML(c, admin)).join("");
    list.querySelectorAll(".mupd-card").forEach(el => {
      const card = cards.find(c => c.items[0].uid === el.dataset.mupdUid);
      if(card) bindMupdCard(el, card);
    });
    updateMupdBatchUI();
  }

  /* 只重畫一張卡(展開/收起)。整份重畫會把其他已展開卡片上的勾選洗回預設值。 */
  function rerenderMupdCard(uid){
    const card = mupdCards.find(c => c.items[0].uid === uid);
    const el = byId("mupd-list") && byId("mupd-list").querySelector('.mupd-card[data-mupd-uid="' + cssq(uid) + '"]');
    if(!card || !el){ renderMemberUpdates(); return; }
    mupdView.delete(uid);
    const admin = !isLeader() && !isViewer();
    const tmp = document.createElement("div");
    tmp.innerHTML = mupdCardHTML(card, admin);
    const fresh = tmp.firstElementChild;
    el.replaceWith(fresh);
    bindMupdCard(fresh, card);
    updateMupdBatchUI();
  }

  function mupdCardHTML(card, admin){
    const first = card.items[0];
    const uid = first.uid;
    const n = card.items.length;
    const now = Date.now();
    const found = findMemberById(card.memberId);
    const title = (card.code || "?") + "・" + (card.name || "(未填姓名)") +
                  (card.groupMissing ? "（分組已不存在）" : "") + (found ? "" : "（名錄上找不到）");
    const when = AdminLogic.updateMonthDay(card.oldestAt) || "?";
    const days = AdminLogic.updateWaitDays(card.oldestAt, now);
    const sub = card.items.every(it => it.confirm === true)
      ? "本人確認資料正確・" + when + " 填寫（已等 " + days + " 天）"
      : n + " 筆・最早 " + when + " 填寫（已等 " + days + " 天）";
    const fields = (Array.isArray(first.fields) ? first.fields : []).map(mupdLabel);
    const fieldLine = (fields.length ? "要改：" + fields.join("、") : "") +
                      (first.hasNote ? (fields.length ? "・" : "") + "有給組長的備註" : "");
    const busy = first.busy === true;
    const open = mupdOpen.has(uid) && mupdReqs.has(uid);
    const pick = admin && !mupdCardBusy(card)
      ? '<label class="mupd-pick" title="勾選＝這位夥伴的所有待審核"><input type="checkbox" data-mupd-pick' +
        (mupdChecked.has(mupdKey(card)) ? " checked" : "") + ' aria-label="勾選 ' + esc(title) + '"></label>'
      : "";
    const btn = busy
      ? '<button class="btn btn-sm" type="button" disabled>處理中' + (first.lockBy ? "（" + esc(String(first.lockBy)) + "）" : "") + '</button>'
      : '<button class="btn btn-sm' + (open ? "" : " btn-primary") + '" type="button" data-mupd-view>' + (open ? "收起" : "查看") + '</button>';
    return '<div class="mupd-card' + (open ? " open" : "") + '" data-mupd-uid="' + esc(uid) + '">' +
      '<div class="mupd-card-head">' + pick +
        '<div class="mupd-card-main">' +
          '<div class="mupd-card-title">' + esc(title) + '</div>' +
          '<div class="mupd-card-sub">' + esc(sub) + '</div>' +
          (fieldLine ? '<div class="mupd-card-fields">' + esc(fieldLine) + '</div>' : "") +
          (n > 1 ? '<div class="mupd-card-newer">後面還有 ' + (n - 1) + ' 筆較新的，處理完這筆才會顯示</div>' : "") +
        '</div>' + btn +
      '</div>' +
      (open ? mupdDetailHTML(card, mupdReqs.get(uid)) : "") +
    '</div>';
  }

  /* 展開後的內容。順序照規格:標頭 → 標頭警示 → 固定提醒 → 備註 → 系統註記 → 差異表
     → 資料需確認 → 不採用原因 → 按鈕。 */
  function mupdDetailHTML(card, req){
    const hit = findMemberById(req.memberId);
    if(!hit) return mupdOrphanHTML(card, req);
    const { g, m } = hit;
    const now = Date.now();
    const head = AdminLogic.memberUpdateHeader(req, m, g.code, now);
    // 同一位後面較新的那幾筆也改了的欄位:這筆先不套用,免得舊內容蓋掉新的
    const newer = new Set();
    card.items.slice(1).forEach(it => (Array.isArray(it.fields) ? it.fields : []).forEach(f => newer.add(f)));
    const confirmOnly = req.confirmOnly === true;
    const rows = confirmOnly ? [] : AdminLogic.memberUpdateRows(m, req, newer, head.allSkip);
    const extras = AdminLogic.memberUpdateExtras(req, m);
    const allSame = !confirmOnly && rows.length > 0 && rows.every(r => r.identical);
    mupdView.set(req.uid, { req, rows, member: m, group: g, allSame, confirmOnly });

    const satIso = req.sat || req.at;
    const meta = "填寫：" + (AdminLogic.updateTimeText(satIso) || "?") + "（已等 " + head.days + " 天）" +
                 (head.late ? "・收到：" + (AdminLogic.updateTimeText(req.at) || "?") : "") +
                 "・這位夥伴的頁面最後更新：" + (AdminLogic.updateTimeText(m.updatedAt) || "（沒有紀錄）");
    let h = '<div class="mupd-detail">';
    h += '<div class="mupd-meta">' + esc(meta) + '</div>';
    head.warnings.forEach(w => { h += '<div class="mupd-warn">' + esc(w) + '</div>'; });
    // 「本人確認資料正確」在差異表的位置會再講一次,標頭就不重複
    head.info.filter(t => !(confirmOnly && t === MUPD_CONFIRM_ONLY)).forEach(t => { h += '<div class="mupd-info">' + esc(t) + '</div>'; });
    h += '<div class="mupd-remind">' + esc(MUPD_REMIND) + '</div>';
    const note = String(req.note == null ? "" : req.note).trim();
    if(note){
      h += '<div class="mupd-notebox">📝 給組長的備註：' + esc(note) +
           '<small>備註裡的要求（刪欄、改名、換組）要你手動到成員卡處理。</small></div>';
    }
    h += mupdExtrasHTML(extras, req);

    if(confirmOnly){
      h += '<div class="mupd-line">' + esc(MUPD_CONFIRM_ONLY) + '</div>';
    } else if(allSame){
      h += '<div class="mupd-line">這筆的內容和網站上目前一樣，看起來已經套用過了。</div>';
    } else if(!rows.length){
      h += '<div class="mupd-line">這筆沒有可以直接套用的欄位，請看上面的備註與系統註記。</div>';
    } else {
      h += '<table class="mupd-diff"><thead><tr><th>欄位</th><th>目前（網站上）</th><th>更新後</th><th>怎麼套用</th></tr></thead><tbody>' +
           rows.map(r => mupdRowHTML(req.uid, r)).join("") + '</tbody></table>';
    }

    if(!allSame && m.dataIssue === true){
      // 預設不勾:表單不驗證是不是本人,不能讓一筆未驗證的送件預設解除「資料需確認」(甲 7)
      h += '<label class="mupd-di"><input type="checkbox" data-mupd-di> <span>我已經跟本人確認過（同時取消前台的「資料需確認」提示）</span></label>';
    }
    if(!allSame){
      h += '<textarea class="mupd-reason" data-mupd-reason rows="2" maxlength="300" placeholder="原因（選填，只放進給本人的訊息，不會存檔）"></textarea>';
    }
    h += '<div class="mupd-actions">' +
      (allSame ? "" : '<button class="btn btn-primary btn-sm" type="button" data-mupd-act="apply">✅ 套用勾選的更新</button>') +
      '<button class="btn btn-sm" type="button" data-mupd-act="handled">✔ 已處理（我已手動改好）</button>' +
      (allSame ? "" : '<button class="btn btn-sm btn-danger" type="button" data-mupd-act="reject">✖ 不採用</button>') +
    '</div>';
    return h + '</div>';
  }

  function mupdExtrasHTML(x, req){
    const li = [];
    x.ignored.forEach(e => li.push(["", "系統：「" + e.label + "」填了「" + e.value + "」，沒有當成修改。"]));
    x.invalid.forEach(e => li.push(["", "系統：「" + e.label + "」填的「" + e.value + "」不是網址，沒有收進來。"]));
    if(x.untouched.length) li.push(["", "系統：" + x.untouched.join("、") + " 是連結帶入的內容，本人沒有改，已略過。"]);
    x.cleared.forEach(e => li.push(["w", "⚠ 本人把「" + e.label + "」清空了（網站上目前是：" + e.current + "）。" +
                                         "要刪掉的話，請手動到成員卡刪除，再按「已處理」或照常套用其他欄位。"]));
    const rid = String(req.responseId || "").trim() || "不明";
    x.truncated.forEach(e => li.push(["w", "⚠「" + e.label + "」夥伴寫了 " + e.total + " " + e.unit + "，只收進前 " +
                                           e.kept + " " + e.unit + "；完整內容在回應試算表（回應 ID " + rid + "）。"]));
    if(!li.length) return "";
    return '<ul class="mupd-sys">' + li.map(([cls, t]) => '<li' + (cls ? ' class="' + cls + '"' : "") + '>' + esc(t) + '</li>').join("") + '</ul>';
  }

  const mupdEmpty = '<span class="mupd-empty">（空白）</span>';
  function mupdItemsHTML(list, cls){
    if(!list.length) return mupdEmpty;
    return '<ul class="mupd-items">' + list.map(t => '<li' + (cls ? ' class="' + cls + '"' : "") + '>' + esc(t) + '</li>').join("") + '</ul>';
  }
  /* 清單欄位「更新後」那一格的預覽,跟著三選一即時改寫。
     不套用時照樣列出夥伴寫的內容(淡色)—— 預設不勾的那幾種情況,組長正是要看著它決定
     要不要改選「加在原本後面」。 */
  function mupdListPreview(r, choice){
    if(choice === "append"){
      const before = new Set(r.before);
      const full = AdminLogic.mergeList(r.before, r.after, 100000).items;
      const keep = full.slice(0, MUPD_LIST_MAX), drop = full.slice(MUPD_LIST_MAX);
      const html = '<ul class="mupd-items">' +
        keep.map(t => '<li class="' + (before.has(t) ? "kept" : "added") + '">' + (before.has(t) ? "" : "＋ ") + esc(t) + '</li>').join("") +
        drop.map(t => '<li class="dropped">' + esc(t) + '</li>').join("") + '</ul>';
      return { html, count: "套用後共 " + keep.length + " 項" +
               (drop.length ? "　⚠ 超過 " + MUPD_LIST_MAX + " 項，最後 " + drop.length + " 項不會放進去" : "") };
    }
    const html = '<ul class="mupd-items">' + r.items.map(it =>
      '<li class="' + it.state + '" title="' + (it.state === "removed" ? "會刪掉" : it.state === "added" ? "新增" : "保留") + '">' +
      (it.state === "added" ? "＋ " : "") + esc(it.text) + '</li>').join("") + '</ul>';
    if(choice === "replace") return { html, count: "套用後共 " + r.after.length + " 項" };
    return { html, count: "不套用（維持原本 " + r.before.length + " 項）" };
  }
  function mupdRowHTML(uid, r){
    const f = esc(r.field);
    const dis = r.identical ? " disabled" : "";      // 和目前一樣:沒有東西可套用
    let before, after, how;
    if(r.kind === "list"){
      before = mupdItemsHTML(r.before, "");
      const pv = mupdListPreview(r, r.defaultChoice);
      after = '<div data-mupd-preview="' + f + '">' + pv.html + '</div>';
      how = r.options.map(o =>
        '<label class="mupd-opt"><input type="radio" name="' + esc("mupd-" + uid + "-" + r.field) + '" value="' + o + '" data-mupd-choice="' + f + '"' +
        (o === r.defaultChoice ? " checked" : "") + dis + '><span>' + MUPD_OPT_LABEL[o] + '</span></label>').join("") +
        '<div class="mupd-count" data-mupd-count="' + f + '">' + esc(pv.count) + '</div>';
    } else {
      // 網站一律純文字(esc 過),不做成可點的連結
      before = r.before ? esc(r.before) : mupdEmpty;
      after = r.after ? esc(r.after) : mupdEmpty;
      how = '<label class="mupd-opt"><input type="checkbox" data-mupd-choice="' + f + '"' +
            (r.defaultChoice === "replace" ? " checked" : "") + dis + '><span>套用</span></label>';
    }
    const warn = r.warnings.length
      ? '<tr class="mupd-wrow"><td colspan="4">' + r.warnings.map(w =>
          '<div class="' + (w.charAt(0) === "⚠" ? "mupd-w" : "mupd-wi") + '">' + esc(w) + '</div>').join("") + '</td></tr>'
      : "";
    return '<tr class="mupd-row' + (warn ? "" : " solo") + (r.defaultChoice === "skip" ? " off" : "") + '" data-mupd-row="' + f + '">' +
      '<td class="mupd-f" data-th="欄位">' + esc(r.label) + '</td>' +
      '<td data-th="目前（網站上）">' + before + '</td>' +
      '<td class="mupd-new" data-th="更新後">' + after + '</td>' +
      '<td data-th="怎麼套用">' + how + '</td></tr>' + warn;
  }

  /* 名錄上找不到這位夥伴(被刪除、換組,或不在可見範圍):沒有「目前」可以比,差異表畫不出來。
     改成唯讀列出他送來的內容,可以一鍵複製,轉抄到他現在的成員卡(乙 12)。 */
  function mupdOrphanHTML(card, req){
    mupdView.set(req.uid, { req, rows: [], member: null, group: null, orphan: true });
    const changes = req.changes && typeof req.changes === "object" ? req.changes : {};
    const satIso = req.sat || req.at;
    const late = AdminLogic.memberUpdateHeader(req, {}, card.code, Date.now()).late;
    let h = '<div class="mupd-detail">';
    h += '<div class="mupd-meta">' + esc("填寫：" + (AdminLogic.updateTimeText(satIso) || "?") +
         "（已等 " + AdminLogic.updateWaitDays(satIso, Date.now()) + " 天）" +
         (late ? "・收到：" + (AdminLogic.updateTimeText(req.at) || "?") : "")) + '</div>';
    const rows = AdminLogic.UPDATE_FIELD_ORDER.filter(f => Object.prototype.hasOwnProperty.call(changes, f)).map(f => {
      const c = AdminLogic.canonUpdateValue(f, changes[f]);
      const v = Array.isArray(c) ? mupdItemsHTML(c, "") : (c ? esc(c) : mupdEmpty);
      return '<div class="mupd-ro-row"><div class="mupd-ro-f">' + esc(mupdLabel(f)) + '</div><div>' + v + '</div></div>';
    });
    if(req.confirmOnly === true) rows.push('<div class="mupd-line">' + esc(MUPD_CONFIRM_ONLY) + '</div>');
    if(rows.length) h += '<div class="mupd-ro">' + rows.join("") + '</div>';
    const note = String(req.note == null ? "" : req.note).trim();
    if(note) h += '<div class="mupd-notebox">📝 給組長的備註：' + esc(note) + '</div>';
    h += '<div class="mupd-actions"><button class="btn btn-sm" type="button" data-mupd-act="copy">📋 複製內容</button></div>';
    const same = AdminLogic.findMembersByName(DATA, req.name);
    if(same.length){
      same.forEach(s => {
        const hit = findMemberById(s.memberId);
        h += '<div class="mupd-same mupd-info"><span>' + esc("名錄上有「" + s.code + "・" + s.name +
             "」，如果是換組，請到他的成員卡貼上這些內容，發布後按「已處理」。") + '</span>' +
             (hit && canEditGroup(hit.g) ? '<button class="mupd-linkbtn" type="button" data-mupd-open="' + esc(s.memberId) + '">開啟成員卡</button>' : "") +
             '</div>';
      });
    } else {
      h += '<div class="mupd-info">這位夥伴已經不在名錄上。需要的話先複製內容，再按「已處理」或「不採用」。</div>';
    }
    h += '<textarea class="mupd-reason" data-mupd-reason rows="2" maxlength="300" placeholder="原因（選填，只放進給本人的訊息，不會存檔）"></textarea>';
    h += '<div class="mupd-actions">' +
      '<button class="btn btn-sm" type="button" data-mupd-act="handled">✔ 已處理（我已手動改好）</button>' +
      '<button class="btn btn-sm btn-danger" type="button" data-mupd-act="reject">✖ 不採用</button>' +
    '</div>';
    return h + '</div>';
  }

  function bindMupdCard(el, card){
    const uid = card.items[0].uid;
    const viewBtn = el.querySelector("[data-mupd-view]");
    if(viewBtn) viewBtn.onclick = () => mupdToggle(uid, viewBtn);
    const pick = el.querySelector("[data-mupd-pick]");
    if(pick) pick.onchange = () => {
      const k = mupdKey(card);
      if(pick.checked) mupdChecked.add(k); else mupdChecked.delete(k);
      updateMupdBatchUI();
    };
    const view = mupdView.get(uid);
    if(!view || !el.querySelector(".mupd-detail")) return;
    el.querySelectorAll("[data-mupd-choice]").forEach(inp => {
      inp.onchange = () => { mupdSyncRow(el, view, inp.dataset.mupdChoice); mupdSyncApply(el, view); };
    });
    const di = el.querySelector("[data-mupd-di]");
    if(di) di.onchange = () => mupdSyncApply(el, view);
    el.querySelectorAll("[data-mupd-open]").forEach(b => { b.onclick = () => openMemberCard(b.dataset.mupdOpen); });
    el.querySelectorAll("[data-mupd-act]").forEach(b => {
      const act = b.dataset.mupdAct;
      b.onclick = () => {
        if(act === "copy"){ copyPlain(AdminLogic.memberUpdateCopyText(view.req)).then(ok =>
          toast(ok ? "已複製這筆更新的內容，可以貼到他現在的成員卡。" : "複製失敗，請再按一次", ok ? {} : { warn:true })); return; }
        const reasonEl = el.querySelector("[data-mupd-reason]");
        const reason = reasonEl ? reasonEl.value : "";
        mupdRun(() => act === "apply" ? mupdApply(el, view) : mupdDrop(view, card, act, reason));
      };
    });
    mupdSyncApply(el, view);
  }

  function mupdReadChoices(el, view){
    const out = {};
    for(const r of view.rows){
      const sel = '[data-mupd-choice="' + cssq(r.field) + '"]';
      if(r.kind === "list"){
        const c = el.querySelector('input' + sel + ':checked');
        out[r.field] = c && r.options.indexOf(c.value) >= 0 ? c.value : "skip";
      } else {
        const c = el.querySelector('input' + sel);
        out[r.field] = c && c.checked ? "replace" : "skip";
      }
    }
    return out;
  }
  function mupdSyncRow(el, view, field){
    const r = view.rows.find(x => x.field === field);
    if(!r) return;
    const choice = mupdReadChoices(el, view)[field];
    const tr = el.querySelector('tr[data-mupd-row="' + cssq(field) + '"]');
    if(tr) tr.classList.toggle("off", choice === "skip");
    if(r.kind !== "list") return;
    const pv = mupdListPreview(r, choice);
    const box = el.querySelector('[data-mupd-preview="' + cssq(field) + '"]');
    const cnt = el.querySelector('[data-mupd-count="' + cssq(field) + '"]');
    if(box) box.innerHTML = pv.html;
    if(cnt) cnt.textContent = pv.count;
  }
  /* 「套用」只有在至少一欄要套用、或勾了「已經跟本人確認過」時才按得下去 */
  function mupdSyncApply(el, view){
    const btn = el.querySelector('[data-mupd-act="apply"]');
    if(!btn || mupdActing) return;
    const ch = mupdReadChoices(el, view);
    const di = el.querySelector("[data-mupd-di]");
    const ok = Object.keys(ch).some(f => ch[f] !== "skip") || !!(di && di.checked);
    btn.disabled = !ok;
    btn.title = ok ? "" : MUPD_APPLY_OFF;
  }

  function updateMupdBatchUI(){
    const btn = byId("mupd-batch-drop"), all = byId("mupd-batch-all");
    if(!btn || !all) return;
    const eligible = mupdCards.filter(c => !mupdCardBusy(c));
    const picked = eligible.filter(c => mupdChecked.has(mupdKey(c)));
    const total = picked.reduce((n, c) => n + c.items.length, 0);
    btn.textContent = picked.length ? "不採用勾選的 " + picked.length + " 位（共 " + total + " 筆）" : "不採用勾選的更新";
    btn.disabled = mupdActing || !picked.length || total > MUPD_BATCH_MAX;
    btn.title = total > MUPD_BATCH_MAX ? "一次最多 " + MUPD_BATCH_MAX + " 筆" : "";
    all.checked = eligible.length > 0 && picked.length === eligible.length;
    all.indeterminate = picked.length > 0 && picked.length < eligible.length;
  }

  /* 一次只做一個會改東西的動作。按下去到伺服器回來之間,審核區的按鈕全部停用 ——
     手機上連點兩下「套用」,第二下會撞上自己上的鎖,得到一則莫名其妙的「處理中」。 */
  async function mupdRun(fn){
    if(isViewer()) return;           // 唯讀帳號看不到審核區;函式本體也擋一道,不只靠隱藏
    if(mupdActing){ toast("上一個動作還在處理中，請稍候。"); return; }
    mupdActing = true;
    mupdLockButtons(true);
    try{ await fn(); }
    finally{
      mupdActing = false;
      mupdLockButtons(false);
      const list = byId("mupd-list");
      if(list) list.querySelectorAll(".mupd-card").forEach(el => {
        const v = mupdView.get(el.dataset.mupdUid);
        if(v && !v.orphan) mupdSyncApply(el, v);
      });
      updateMupdBatchUI();
    }
  }
  function mupdLockButtons(on){
    const wrap = byId("mupd-wrap");
    if(!wrap) return;
    if(on){
      wrap.querySelectorAll("button").forEach(b => { if(!b.disabled){ b.disabled = true; b.dataset.mupdLocked = "1"; } });
    } else {
      wrap.querySelectorAll("button[data-mupd-locked]").forEach(b => { b.disabled = false; delete b.dataset.mupdLocked; });
    }
  }
  /* 伺服器說處理掉了,就馬上從畫面拿掉,不等清單重抓。重抓要讀 GitHub 加 R2,手機上一兩秒;
     這段時間 mupdRun 已經把按鈕解鎖,舊卡還展開著 —— 組長以為沒成功再按一次,只會拿到
     「已經被別人處理掉了」,還把帶「複製給本人的訊息」的成功 toast 蓋掉(不採用的原因就找不回來了)。
     從清單濾掉再重畫(不是直接刪 DOM):同一位夥伴的下一筆會馬上接上。背景重抓照常進行。 */
  function mupdForget(uids){
    const gone = new Set([].concat(uids));
    gone.forEach(u => { mupdOpen.delete(u); mupdReqs.delete(u); });
    if(mupdList && Array.isArray(mupdList.items)){
      const before = mupdList.items.length;
      mupdList.items = mupdList.items.filter(it => !gone.has(it.uid));
      if(mupdList.openAll != null) mupdList.openAll = Math.max(0, (Number(mupdList.openAll) || 0) - (before - mupdList.items.length));
    }
    renderMemberUpdates();
  }

  /* ---- 查看(展開)---- */
  async function mupdToggle(uid, btn){
    if(mupdOpen.has(uid)){ mupdOpen.delete(uid); rerenderMupdCard(uid); return; }
    if(mupdReqs.has(uid)){ mupdOpen.add(uid); rerenderMupdCard(uid); return; }
    if(!(await mupdReady())) return;
    const session = mupdSession();
    if(!session) return;
    const epoch = mupdEpoch;
    if(btn){ btn.disabled = true; btn.textContent = "載入中…"; }
    const res = await workerFetch("/member-update-get", { session, uid });
    if(epoch !== mupdEpoch) return;
    if(res.ok && res.request && typeof res.request === "object" && res.request.uid === uid){
      mupdReqs.set(uid, res.request);
      mupdOpen.add(uid);
      rerenderMupdCard(uid);
      return;
    }
    if(btn && btn.isConnected){ btn.disabled = false; btn.textContent = "查看"; }
    if(mupdSessionExpired(res)) return;
    if(res.error === "update_gone"){
      toast("這筆更新已經被別人處理掉了，清單已更新。", { warn:true, duration:8000 });
      refreshMemberUpdates();
      return;
    }
    if(res.error === "forbidden_group"){ toast("你沒有修改這一組的權限。", { warn:true, duration:7000 }); return; }
    if(res.error === "group_renamed"){ toast(MUPD_GROUP_RENAMED, { warn:true, duration:8000 }); return; }
    toast("讀取這筆更新失敗（" + mupdCode(res) + "），請稍後再試。", { warn:true, duration:7000 });
  }

  /* ---- 套用 ---- */
  async function mupdApply(el, view){
    const req = view.req, m = view.member;
    if(!m || view.orphan) return;
    if(!(await mupdReady())) return;
    const session = mupdSession();
    if(!session) return;
    /* 套用會直接寫進網站,而本機草稿不會跟著送出去 —— 兩者混在一起,下一次發布的版本基準
       就對不上。和認領一樣用 hasUnpublishedChanges(),不是 dirty(見 claimPending 的說明)。 */
    if(hasUnpublishedChanges()){
      toast("你還有尚未發布的修改。請先按「發布到網站」（或捨棄變更），再套用夥伴的更新。", { warn:true, duration:9000 });
      return;
    }
    const choices = mupdReadChoices(el, view);
    const di = el.querySelector("[data-mupd-di]");
    const clearDataIssue = !!(di && di.checked);
    const applied = view.rows.filter(r => choices[r.field] !== "skip");
    if(!applied.length && !clearDataIssue){ toast(MUPD_APPLY_OFF, { warn:true, duration:7000 }); return; }
    const name = m.name || req.name || "這位夥伴";
    const lines = ["要把「" + name + "」的更新寫進網站嗎？", ""];
    if(applied.length) lines.push("會更新：" + applied.map(r => r.label + (choices[r.field] === "append" ? "（加在原本後面）" : "")).join("、"));
    const skipped = view.rows.filter(r => choices[r.field] === "skip").map(r => r.label);
    if(skipped.length) lines.push("不套用：" + skipped.join("、"));
    if(clearDataIssue) lines.push("同時取消「資料需確認」（你已經跟本人確認過）");
    lines.push("", "按「確定」後會直接寫進網站（不必再按發布）。");
    if(!confirm(lines.join("\n"))) return;

    /* expect = 審核者畫面上那一欄的「目前」原始值(展開當時的成員)。Worker 會拿它跟線上
       逐欄比對,對不上就回 member_changed —— 你看著 A 決定要換成 B,線上卻已經是 C 的話,
       不該悄悄把 C 蓋掉。 */
    const expect = {};
    applied.forEach(r => { expect[r.field] = mupdRawValue(m, r.field); });
    toast("套用中…");
    const res = await workerFetch("/member-update-apply", { session, uid: req.uid, choices, expect, clearDataIssue });
    const code = (view.group && view.group.code) || req.code || "?";

    if(res.ok){
      mupdOpen.delete(req.uid); mupdReqs.delete(req.uid);
      let reloaded = true;
      try{ await loadData(); resetHistory(); }catch(e){ reloaded = false; }
      const hit = findMemberById(req.memberId);
      if(hit) selected = hit.g.id;
      fixSelected(); renderAll();
      // 備註與「本人清空」套用功能做不到,要組長手動改:掛在審核區上方,直到按「知道了」
      const note = String(req.note == null ? "" : req.note).trim();
      const cleared = AdminLogic.memberUpdateExtras(req, {}).cleared.map(c => c.label);
      if(note || cleared.length){
        mupdAfter = { memberId: req.memberId, name, note, cleared };
        renderMupdAfter();
      }
      // 放在 mupdAfter 之後:這筆如果是最後一筆,先拿掉的話整塊會被藏起來,備註提醒就看不到
      mupdForget(req.uid);
      const extra = (Array.isArray(res.warnings) ? res.warnings : [])
        .filter(w => w && w.reason === "list_truncated")
        .map(w => "「" + mupdLabel(w.field) + "」超過 12 項，最後 " + (Number(w.dropped) || 0) + " 項沒有放進去。").join("");
      const thanks = name + " 你好，你在 " + (AdminLogic.updateMonthDay(req.sat || req.at) || "?") +
                     " 送出的名錄資料已經更新上線了，謝謝你！\n" +
                     SITE.SITE_BASE + "m/" + encodeURIComponent(req.memberId) + ".html";
      toast("已更新「" + name + "」並寫進網站（不必再按發布），幾分鐘後前台就會看到。" + extra,
            { duration:12000, actionLabel:"複製給本人的訊息", onAction: () => copyWithToast(thanks) });
      if(res.cleanupFailed){
        mupdToastLater("已更新，但清單清除失敗，這筆可能還會出現；看到時請按「已處理」移除。", { warn:true, duration:9000 });
      }
      if(!reloaded){
        mupdToastLater("已經寫進網站，但這邊重新載入資料失敗，請重新整理頁面再繼續編輯。", { warn:true, duration:9000 });
        refreshMemberUpdates();
      }
      return;
    }
    if(mupdSessionExpired(res)) return;
    const err = res.error;
    const W = (msg, ms) => toast(msg, { warn:true, duration: ms || 9000 });
    if(err === "update_gone"){ W("這筆更新已經被別人處理掉了，清單已更新。"); refreshMemberUpdates(); return; }
    if(err === "update_busy"){
      W("另一位組長或總管理員正在處理這筆" + (res.lockBy ? "（" + res.lockBy + "）" : "") + "，請稍後再看。");
      refreshMemberUpdates(); return;
    }
    if(err === "member_changed"){
      const fields = (Array.isArray(res.fields) ? res.fields : []).map(mupdLabel).join("、") || "部分欄位";
      await mupdReloadData();
      W("「" + fields + "」在你打開這筆之後被別人改過，已重新載入最新資料，請再確認一次。", 11000);
      return;
    }
    if(err === "update_already_applied"){ W("這筆之前已經套用過了，已從清單移除。"); refreshMemberUpdates(); return; }
    if(err === "no_effective_change"){ W("勾選的欄位和網站上目前一樣，沒有要改的。已經處理好的話請按「已處理」。"); return; }
    if(err === "member_missing" || err === "group_missing"){
      await mupdReloadData();
      W(err === "member_missing"
        ? "這位夥伴已經不在「" + code + "」組裡，可能被刪除或換組了。請先看這筆的內容，需要的話手動補到他現在的成員卡，再按「已處理」。"
        : "這筆更新所屬的分組已經不存在。請先看這筆的內容，需要的話手動補到他現在的成員卡，再按「已處理」。", 12000);
      return;
    }
    if(err === "group_renamed"){ W(MUPD_GROUP_RENAMED); return; }
    if(err === "forbidden_group" || err === "forbidden_path"){ W("你沒有修改這一組的權限。"); return; }
    if(err === "bad_data_file"){
      W("這一組的資料檔有格式問題（" + String(res.reason || "") + "），為了不讓整個網站停止更新，這次沒有寫入。請聯繫總管理員。", 11000);
      return;
    }
    if(err === "stale_base" || err === "busy_retry_later"){ W("剛好有人同時在發布，這次沒有寫入。請等幾秒再按一次。"); return; }
    if(err === "bad_choice" || err === "nothing_selected"){ W("套用的設定不正確（" + err + "），請重新整理後再試。"); return; }
    if(err === "pending_image_store_unavailable"){ W("發布服務還沒接上暫存空間（R2），暫時無法處理更新。請聯繫總管理員。"); return; }
    /* apply_uncertain、5xx、網路錯誤、沒列到的錯誤碼:不能說「沒有寫入」——
       ref 更新逾時的時候,GitHub 那邊可能其實已經寫進去了。教他怎麼判斷,
       並且保證再按一次不會重複寫入(Worker 用 lastUpdateFrom 擋)。 */
    W("不確定有沒有寫進網站（" + mupdCode(res) + "）。請按「重新整理」：這筆如果不見了，或顯示「看起來已經套用過了」，" +
      "就是已經寫入；還在的話再按一次「套用」（系統會自動判斷有沒有寫過，不會重複寫入）。如果顯示「處理中」，等 10 分鐘再試。", 16000);
    mupdReloadAll();
  }
  /* member_changed / member_missing 之後:重讀網站資料再重畫,展開中的卡會用新的「目前」重算 */
  async function mupdReloadData(){
    try{ await loadData(); resetHistory(); renderAll(); await mupdLast; }
    catch(e){ toast("重新載入網站資料失敗，請重新整理頁面。", { warn:true, duration:7000 }); }
  }

  /* ---- 已處理 / 不採用 ----
     兩顆都只刪 R2 上的請求,不碰網站資料,所以不需要先發布手上的修改。
     「不採用」的原因只放進剪貼簿給本人,不送給 Worker、也不存檔。 */
  async function mupdDrop(view, card, kind, reason){
    const req = view.req;
    if(!(await mupdReady())) return;
    const session = mupdSession();
    if(!session) return;
    const hit = findMemberById(req.memberId);
    const name = (hit && hit.m.name) || req.name || "這位夥伴";
    const md = AdminLogic.updateMonthDay(req.sat || req.at) || "?";
    const ok = kind === "handled"
      ? confirm("把這筆標記為已處理並從清單移除？（網站上的資料不會改變）")
      : confirm("不採用「" + name + "」" + md + " 填寫的這筆更新？\n\n這筆會直接刪掉，網站上的資料不會有任何改變，之後找不回來。");
    if(!ok) return;
    const res = await workerFetch("/member-update-drop", { session, uid: req.uid });
    if(res.ok){
      mupdForget(req.uid);
      if(kind === "handled"){
        toast("已從清單移除。");
      } else {
        const why = String(reason || "").trim();
        const link = nameOnlyUpdateLink(hit ? hit.g.code : card.code, hit ? hit.m.name : req.name);
        const msg = name + " 你好，你在 " + md + " 送出的名錄資料更新這次沒有採用" + (why ? "，原因：" + why : "") + "。\n" +
                    (link ? "需要修改可以再填一次：" + link : "需要修改的話，請直接跟組長說。");
        toast("已不採用這筆更新。", { duration:12000, actionLabel:"複製給本人的訊息", onAction: () => copyWithToast(msg) });
      }
      refreshMemberUpdates();
      return;
    }
    if(mupdSessionExpired(res)) return;
    if(res.error === "update_gone"){
      toast("這筆更新已經被別人處理掉了，清單已更新。", { warn:true, duration:9000 });
      refreshMemberUpdates(); return;
    }
    if(res.error === "update_busy"){
      toast("另一位組長或總管理員正在處理這筆" + (res.lockBy ? "（" + res.lockBy + "）" : "") + "，請稍後再看。",
            { warn:true, duration:9000 });
      refreshMemberUpdates(); return;
    }
    if(res.error === "group_renamed"){ toast(MUPD_GROUP_RENAMED, { warn:true, duration:8000 }); return; }
    if(res.error === "forbidden_group"){ toast("你沒有修改這一組的權限。", { warn:true, duration:7000 }); return; }
    toast("沒有成功（" + mupdCode(res) + "），請稍後再試。", { warn:true, duration:8000 });
  }

  /* ---- 總管理員:批次不採用(被灌單時用)---- */
  async function mupdBatchDrop(){
    if(isLeader() || isViewer()) return;
    const picked = mupdCards.filter(c => !mupdCardBusy(c) && mupdChecked.has(mupdKey(c)));
    const uids = [];
    picked.forEach(c => c.items.forEach(it => uids.push(it.uid)));
    if(!uids.length || uids.length > MUPD_BATCH_MAX) return;
    if(!(await mupdReady())) return;
    const session = mupdSession();
    if(!session) return;
    if(!confirm("不採用勾選的 " + uids.length + " 筆更新？\n\n這些會直接刪掉，網站上的資料不會有任何改變，之後找不回來，" +
                "也不會產生給本人的訊息。\n（正在處理中的會自動略過）")) return;
    const res = await workerFetch("/member-update-drop-batch", { session, uids });
    if(res.ok){
      const skipped = Array.isArray(res.skipped) ? res.skipped.length : 0;
      mupdChecked.clear();
      uids.forEach(u => { mupdOpen.delete(u); mupdReqs.delete(u); });
      // 正在處理中的(skipped)還在 R2 上,留著;其他的先從畫面拿掉
      const kept = new Set(Array.isArray(res.skipped) ? res.skipped : []);
      mupdForget(uids.filter(u => !kept.has(u)));
      toast("已不採用 " + (Number(res.dropped) || 0) + " 筆。" + (skipped ? skipped + " 筆正在處理或已經不在，沒有動。" : ""),
            { duration:8000 });
      refreshMemberUpdates();
      return;
    }
    if(mupdSessionExpired(res)) return;
    if(res.error === "admin_only"){ toast("只有總管理員可以一次不採用多筆。", { warn:true, duration:7000 }); return; }
    toast("沒有成功（" + mupdCode(res) + "），請稍後再試。", { warn:true, duration:8000 });
  }

  /* ---- 套用後常駐的備註提醒 ---- */
  function renderMupdAfter(){
    const el = byId("mupd-after");
    if(!el) return;
    if(!mupdAfter){ el.hidden = true; el.innerHTML = ""; return; }
    const a = mupdAfter;
    let h = "";
    if(a.note) h += '<div>📝 ' + esc(a.name) + ' 的備註還沒處理：' + esc(a.note) + '（備註裡的要求要手動到成員卡改，改完再按發布）</div>';
    if(a.cleared.length) h += '<div>' + esc(a.name) + ' 本人清空了：' + esc(a.cleared.join("、")) + '</div>';
    h += '<div class="mupd-note-btns">' +
         '<button class="btn btn-sm" type="button" data-mupd-after="open">開啟成員卡</button>' +
         '<button class="btn btn-sm" type="button" data-mupd-after="close">知道了</button></div>';
    el.innerHTML = h;
    el.hidden = false;
    el.querySelector('[data-mupd-after="open"]').onclick = () => openMemberCard(a.memberId);
    el.querySelector('[data-mupd-after="close"]').onclick = () => { mupdAfter = null; renderMemberUpdates(); };
  }

  /* 切到這位夥伴所在的組,捲到他的成員卡並閃一下 */
  function openMemberCard(memberId){
    const hit = findMemberById(memberId);
    if(!hit){ toast("名錄上找不到這位夥伴，可能已經被刪除或換組。", { warn:true, duration:7000 }); return; }
    if(!canEditGroup(hit.g)){ toast("你沒有修改這一組的權限", { warn:true }); return; }
    selected = hit.g.id;
    renderAll();
    closeDrawerIfMobile();
    const el = main.querySelector('.mem-card[data-mid="' + cssq(memberId) + '"]');
    if(el){
      el.scrollIntoView({ behavior:"smooth", block:"center" });
      el.classList.add("mem-flash");
      setTimeout(() => el.classList.remove("mem-flash"), 2400);
    }
  }

  /* 登出:清單、展開的內容(含私人備註)、批次勾選、提醒全部清掉 */
  function resetMemberUpdates(){
    mupdEpoch++;
    mupdFlight.clear();
    mupdList = null; mupdError = ""; mupdCards = [];
    mupdReqs.clear(); mupdOpen.clear(); mupdView.clear(); mupdChecked.clear();
    mupdNudged = ""; mupdNudgedRank = -1; mupdAfter = null;
    mupdToastQueue.length = 0;
    clearTimeout(mupdToastTimer); mupdToastTimer = null;
    const wrap = byId("mupd-wrap"), list = byId("mupd-list");
    if(list) list.innerHTML = "";
    if(wrap) wrap.hidden = true;
    renderMupdAfter();
    const all = byId("mupd-batch-all");
    if(all){ all.checked = false; all.indeterminate = false; }
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
    renderMergeNotice();      // 舊草稿合併的說明(沒有就收起來)
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
  // 最近刪除的夥伴:預設收起,按「查看」才去讀回收區
  byId("rcy-toggle").onclick = () => {
    rcyOpen = !rcyOpen;
    if(rcyOpen) loadRecycle(); else renderRecycle();
  };
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

  // 夥伴資料更新(待審核):重新整理、總管理員的全選與批次不採用
  byId("mupd-reload").onclick = async () => {
    const b = byId("mupd-reload");
    if(b.disabled) return;
    b.disabled = true; b.textContent = "整理中…";
    try{ await mupdReloadAll(); }
    finally{ b.disabled = false; b.textContent = "重新整理"; }
  };
  byId("mupd-batch-all").onchange = () => {
    const on = byId("mupd-batch-all").checked;
    mupdCards.filter(c => !mupdCardBusy(c)).forEach(c => { if(on) mupdChecked.add(mupdKey(c)); else mupdChecked.delete(mupdKey(c)); });
    byId("mupd-list").querySelectorAll("[data-mupd-pick]").forEach(cb => { cb.checked = on; });
    updateMupdBatchUI();
  };
  byId("mupd-batch-drop").onclick = () => mupdRun(mupdBatchDrop);

  byId("pv-close").onclick = closePendingPhotos;
  // 點背景關閉：燈箱只是看照片，關掉的門檻要低
  byId("pv-overlay").addEventListener("click", e => {
    if(e.target.id === "pv-overlay" || e.target.id === "pv-body") closePendingPhotos();
  });

  document.addEventListener("keydown", e => {
    if(e.key === "Escape"){
      if(!byId("pv-overlay").hidden){ closePendingPhotos(); return; }
      if(!byId("crop-modal").hidden){ byId("crop-cancel").click(); return; }
      if(!byId("batch-modal").hidden){ closeBatchModal(); return; }
      if(!byId("leave-modal").hidden){ closeLeaveModal(); return; }
      if(!byId("settings-modal").hidden){ closeSettings(); return; }
      if(document.body.classList.contains("drawer-open")){ closeDrawerIfMobile(); return; }
    }
    // 只有在編輯中（非鎖定、非彈窗）才吃 Ctrl+Z / Ctrl+Y
    const editing = byId("lock-overlay").hidden && byId("settings-modal").hidden && byId("crop-modal").hidden
                    && byId("leave-modal").hidden && byId("batch-modal").hidden && byId("pv-overlay").hidden;
    if(editing && (e.ctrlKey || e.metaKey)){
      if(e.key === "z" && !e.shiftKey){ e.preventDefault(); undo(); }
      else if((e.key === "z" && e.shiftKey) || e.key === "y"){ e.preventDefault(); redo(); }
    }
  });

  window.addEventListener("beforeunload", () => { if(dirty) saveDraft(); });
})();
