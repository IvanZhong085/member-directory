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

  /* 草稿鍵含角色範圍:組長只握有自己那組,不能跟總管理員的整份草稿混用 */
  const DRAFT_PREFIX = "member-directory-draft-v2:";
  function draftKey(){ return DRAFT_PREFIX + (isLeader() ? myGroupCode().toLowerCase() : "all"); }
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
  const baseHashes = {};       // 路徑 → 載入當下的 SHA-256(發布時給 Worker 做版本落後偵測)

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
  async function sha256Hex(bytes){
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function fetchData(path){
    const res = await fetch(path + "?ts=" + Date.now(), { cache: "no-store" });
    if(!res.ok) throw new Error(path + " HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    return { json: JSON.parse(text), text, hash: await sha256Hex(buf) };
  }
  /* 依角色載入:總管理員 13 個檔,組長 2 個(結構 + 自己那組) */
  async function loadData(){
    const idx = await fetchData("data/_index.json");
    INDEX = idx.json;
    baseHashes["data/_index.json"] = idx.hash;
    loadedBody["data/_index.json"] = idx.text;

    const code = myGroupCode().trim().toLowerCase();
    const wanted = isLeader() ? INDEX.filter(e => String(e.code).trim().toLowerCase() === code) : INDEX;
    const next = [];
    for(const e of wanted){
      const path = dataPathOf(e.code);
      const f = await fetchData(path);
      baseHashes[path] = f.hash;
      loadedBody[path] = serializeBody(groupBody(f.json));
      next.push({ code: e.code, name: e.name, leader: f.json.leader ?? "", room: f.json.room ?? "",
                  members: f.json.members ?? [], id: e.id, recruiting: f.json.recruiting ?? [] });
    }
    DATA = next;

    /* 待認領區:新夥伴自填表單送來的申請。所有角色都載入——組長要能認領自己那組的人。
       檔案可能還不存在(還沒有人申請過),那不是錯誤,當成空清單。 */
    try{
      const p = await fetchData(PENDING_PATH);
      PENDING = Array.isArray(p.json) ? p.json : [];
      baseHashes[PENDING_PATH] = p.hash;
      loadedBody[PENDING_PATH] = p.text;
    }catch(e){
      PENDING = [];
      delete baseHashes[PENDING_PATH];
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
  function showDraftBanner(on){ draftBanner.classList.toggle("show", !!on); }
  /* 唯讀帳號不留草稿。除了「本來就沒東西可存」之外還有一個實際理由:草稿的鍵對
     非組長一律是 "all",同一台電腦上唯讀帳號與總管理員會共用同一份 —— 唯讀帳號
     會載到別人還沒發布的內容,自己的暫存也會反過來污染對方。 */
  function saveDraft(){
    if(isViewer()) return;
    try{
      localStorage.setItem(draftKey(), JSON.stringify({ savedAt: Date.now(), data: DATA, pending: PENDING }));
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
    DATA = parsed.data;
    // 舊版草稿沒有 pending 欄位,那時就沿用剛從伺服器載到的清單
    if(Array.isArray(parsed.pending)) PENDING = parsed.pending;
    if(!DATA.some(g => g.id === selected)) selected = DATA.length ? DATA[0].id : null;
    hasDraft = true;
  }
  function discardDraft(){
    if(!confirm("捨棄尚未發布的變更，改回目前公開網站的內容？")) return;
    clearTimeout(saveTimer);
    dirty = false;
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
  function validate(){
    const problems = [];
    const ids = new Map();
    const nums = new Map();
    visibleGroups().forEach(g => {
      if(!g.name.trim()) problems.push("有分組沒有名稱（" + (g.code||"?") + "）");
      if(!GROUPCODE_RE.test(String(g.code||"").trim())){
        problems.push("分組代號「" + (g.code||"(空白)") + "」不合法：只能用英文字母或數字、最多 8 個字（例如 A1、B2、C），改好才能發布");
      }
      g.members.forEach(m => {
        ids.set(m.id, (ids.get(m.id)||0)+1);
        if(!m.name.trim()) problems.push("「" + (g.code||"?") + "」組有成員未填姓名");
        const n = (m.number||"").trim();
        if(n) nums.set(n, (nums.get(n)||[]).concat((m.name||"?")));
      });
    });
    [...ids.entries()].filter(([,c])=>c>1).forEach(([id,c]) => problems.push("成員 id 重複：" + id + "（×" + c + "）"));
    const dupNums = [...nums.entries()].filter(([,names])=>names.length>1);
    if(dupNums.length){
      problems.push("編號重複（僅提醒，可接受）：" + dupNums.map(([n,names])=>n+"→"+names.join("/")).join("；"));
    }
    if(problems.length){
      validationBox.innerHTML = ICON.warn + "<div>" + problems.map(esc).join("<br>") + "</div>";
      validationBox.classList.add("show");
    } else {
      validationBox.classList.remove("show");
    }
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
  async function refreshCaps(){
    const res = await workerFetch("/ping");
    workerCaps = (res && res.ok && res.caps) || {};
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
  function embeddedPhoto(value, base){
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(value || ""));
    if(!m) return null;
    const b64 = m[2].trim();
    return b64 ? { name: base + "." + DATA_IMG_EXT[m[1]], b64 } : null;
  }

  /* 組出這次發布要寫的檔案:照片附件 + 「內容真的有變」的分組檔。
     沒改到的組完全不送,才不會在別組組長同時編輯時互相踩到。 */
  function buildPublishPayload(){
    const data = clone(DATA);
    const files = [];
    if(workerCaps.files){
      data.forEach(g => g.members.forEach(m => {
        const pic = embeddedPhoto(m.image, fileSafeId(m.id) + "_x");
        if(pic){ files.push({ path: "images/" + pic.name, contentB64: pic.b64 }); m.image = pic.name; }
        const card = embeddedPhoto(m.card, fileSafeId(m.id) + "_card");
        if(card){ files.push({ path: "images/" + card.name, contentB64: card.b64 }); m.card = card.name; }
        (m.products || []).forEach((p, i) => {
          const prod = embeddedPhoto(p, fileSafeId(m.id) + "_p" + (i + 1));
          if(prod){ files.push({ path: "images/" + prod.name, contentB64: prod.b64 }); m.products[i] = prod.name; }
        });
      }));
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
    return { files };
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
    validate();
    publishing = true;
    let ok = false;
    const btn = byId("btn-publish");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.textContent = "發布中…";
    try{
      const payload = buildPublishPayload();
      if(!payload.files.length){
        toast("沒有偵測到任何變更，不需要發布");
        return false;
      }
      /* 照片與分組檔一起送:Worker 會先寫照片、再寫分組檔,任一步失敗就整批中止,
         公開網站不會出現「資料檔指向不存在照片」的狀態。單次上限 25 檔,
         12 組 + 結構檔 + 照片極少同時超過,超過時由 Worker 明確回報 too_many_files。 */
      const CHUNK = 20;
      const chunks = [];
      for(let i = 0; i < payload.files.length; i += CHUNK) chunks.push(payload.files.slice(i, i + CHUNK));
      let res = { ok:false, error:"network" };
      let sent = 0;
      for(const chunk of chunks){
        if(payload.files.length > CHUNK){
          sent += chunk.length;
          btn.textContent = "發布中…（檔案 " + sent + "/" + payload.files.length + "）";
        }
        res = await workerFetch("/publish", { session, files: chunk, baseHashes });
        if(!res.ok) break;
      }
      if(res.ok){
        // 接上新版本,不必重新整理就能再發布一次;同時把「已載入內容」對齊,避免重複送同一份
        Object.assign(baseHashes, res.newHashes || {});
        payload.files.forEach(f => {
          if(f.path.startsWith("data/")) loadedBody[f.path] = new TextDecoder().decode(
            Uint8Array.from(atob(f.contentB64), c => c.charCodeAt(0)));
        });
        clearTimeout(saveTimer);
        dirty = false;
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
      } else if(res.error === "stale_base"){
        // 別人在你編輯期間發布過:硬送出去會把對方的修改蓋掉,所以擋在這裡
        toast("「" + String(res.path || "").replace(/^data\/|\.json$/g, "").toUpperCase() +
              "」在你編輯期間被其他人發布過，這次「沒有」上線。請先「下載備份」保留你的修改，" +
              "重新整理頁面取得最新資料後再改一次。", {warn:true, duration:12000});
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
  /* 文字欄位：focus 時先拍一張，第一次輸入才把那張存進復原堆疊 → 一整段編輯只算「一步」 */
  function wireTextInput(el, onInput){
    if(!el) return;
    el.addEventListener("focus", () => { pendingSnap = clone(DATA); });
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

  /* 申請 → 成員卡。用 newMember() 當樣板,確保每個欄位都存在、id 由本機產生
     (表單送來的 pid 只是待認領清單的鍵,不會變成成員 id) */
  function applicantToMember(a, gid){
    const m = newMember(gid, a.name || "");
    m.title = a.title || "";
    m.company = a.company || "";
    m.business_items = a.business_items || "";
    m.website = a.website || "";
    ["services", "targets", "have", "want", "tagline", "products"].forEach(k => {
      m[k] = Array.isArray(a[k]) ? a[k].slice() : [];
    });
    m.image = a.image || "";
    m.card = a.card || "";
    m.dataIssue = true;        // 自填資料請組長過目一次,前台會顯示「資料需確認」
    touch(m);
    return m;
  }
  function claimPending(pid, gid){
    const i = PENDING.findIndex(x => x.pid === pid);
    const g = DATA.find(x => x.id === gid);
    if(i < 0 || !g) return;
    if(!canEditGroup(g)){ toast("你沒有修改這一組的權限", { warn:true }); return; }
    pushUndo();
    const m = applicantToMember(PENDING[i], g.id);
    g.members.push(m);
    PENDING.splice(i, 1);
    selected = g.id;
    renderAll(); scheduleSaveAndValidate();
    toast("已認領「" + (m.name || "新夥伴") + "」到「" + (g.code || "?") + "」，" +
          "請確認資料後按「發布到網站」。已先標記為「資料需確認」。", { duration: 8000 });
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
  if(loadSession()) bootData();   // 已有有效 session（重新整理頁面）就直接載入
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
