(function(){
  "use strict";

  const DRAFT_KEY = "member-directory-draft-v1";
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
  let DATA = clone(typeof GROUPS !== "undefined" ? GROUPS : []);
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
  function pushUndo(){
    undoStack.push(clone(DATA));
    if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    pendingSnap = null;
    updateHistoryButtons();
  }
  function fixSelected(){ if(!DATA.some(g => g.id === selected)) selected = DATA.length ? DATA[0].id : null; }
  function undo(){
    if(!undoStack.length) return;
    redoStack.push(clone(DATA));
    DATA = undoStack.pop();
    fixSelected(); renderAll(); validate(); saveDraft(); updateHistoryButtons();
    toast("已回上一步");
  }
  function redo(){
    if(!redoStack.length) return;
    undoStack.push(clone(DATA));
    DATA = redoStack.pop();
    fixSelected(); renderAll(); validate(); saveDraft(); updateHistoryButtons();
    toast("已重做");
  }

  /* ---------- draft persistence ---------- */
  function showDraftBanner(on){ draftBanner.classList.toggle("show", !!on); }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: DATA }));
      saveState.textContent = "已自動儲存 " + new Date().toLocaleTimeString("zh-Hant",{hour:"2-digit",minute:"2-digit"});
      showDraftBanner(true);
      dirty = false;
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
    let raw; try{ raw = localStorage.getItem(DRAFT_KEY); }catch(e){ return; }
    if(!raw) return;
    let parsed; try{ parsed = JSON.parse(raw); }catch(e){ return; }
    if(!parsed || !Array.isArray(parsed.data) || !parsed.data.length) return;
    DATA = parsed.data;
    if(!DATA.some(g => g.id === selected)) selected = DATA.length ? DATA[0].id : null;
    hasDraft = true;
  }
  function discardDraft(){
    if(!confirm("捨棄尚未發布的變更，改回目前公開網站的內容？")) return;
    clearTimeout(saveTimer);
    dirty = false;
    try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
    DATA = clone(typeof GROUPS !== "undefined" ? GROUPS : []);
    selected = DATA.length ? DATA[0].id : null;
    showDraftBanner(false);
    renderAll(); validate(); toast("已捨棄變更");
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
  function imgSrc(image){ return /^data:/.test(image) ? image : "images/" + encodeURIComponent(image); }
  function linesToArr(v){ const a = v.replace(/\u000B/g, "\n").split("\n"); while(a.length && a[a.length-1].trim()==="") a.pop(); return a; }

  /* ---------- validation ---------- */
  function validate(){
    const problems = [];
    const ids = new Map();
    const nums = new Map();
    DATA.forEach(g => {
      if(!g.name.trim()) problems.push("有分組沒有名稱（" + (g.code||"?") + "）");
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
    glist.innerHTML = DATA.map(g => `
      <div class="gitem ${g.id===selected?"active":""}" data-gid="${esc(g.id)}" title="${esc(g.code||"?")}・${esc(g.name||"（未命名）")}">
        <span class="gitem-code">${esc(g.code||"?")}</span>
        <span class="gitem-name">${esc(g.name||"（未命名）")}</span>
        <span class="gitem-count">${g.members.length}</span>
      </div>`).join("") +
      `<button class="gadd-tile" id="gadd-tile" type="button">＋ 新增分組</button>`;
    glist.querySelectorAll(".gitem").forEach(el => {
      el.addEventListener("click", () => {
        selected = el.dataset.gid; renderAll();
        closeDrawerIfMobile();
      });
    });
    byId("gadd-tile").onclick = () => { addGroup(); closeDrawerIfMobile(); };
  }
  function closeDrawerIfMobile(){ document.body.classList.remove("drawer-open"); }

  /* ---------- render: main ---------- */
  function renderMain(){
    const g = groupById(selected);
    if(!g){ main.innerHTML = `<div class="adm-card">尚無分組，請按左上「+ 新增組」。</div>`; return; }
    const gi = DATA.indexOf(g);

    main.innerHTML = `
      <div class="adm-card">
        <div class="adm-group-head">
          <div class="field" style="width:120px;">
            <label>組別代號</label>
            <input id="g-code" value="${esc(g.code)}" placeholder="如 A1">
          </div>
          <div class="field grow">
            <label>分組名稱</label>
            <input id="g-name" value="${esc(g.name)}" placeholder="如 健康營養照護組">
          </div>
          <div class="field" style="width:150px;">
            <label>組長</label>
            <input id="g-leader" value="${esc(g.leader||"")}" placeholder="組長姓名">
          </div>
          <div style="display:flex; gap:6px; align-self:flex-end; padding-bottom:1px;">
            <button class="icon-btn" id="g-up" title="分組上移" ${gi===0?"disabled":""}>${ICON.up}</button>
            <button class="icon-btn" id="g-down" title="分組下移" ${gi===DATA.length-1?"disabled":""}>${ICON.down}</button>
          </div>
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
    bindTextField("g-code", v => { g.code = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindTextField("g-name", v => { g.name = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindTextField("g-leader", v => { g.leader = v; scheduleSaveAndValidate(); });
    byId("g-up").onclick = () => moveGroup(gi, -1);
    byId("g-down").onclick = () => moveGroup(gi, 1);
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
            <span class="chk"><input type="checkbox" data-f="dataIssue" ${m.dataIssue?"checked":""}> 標記資料需確認</span>
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
          <div class="field"><label>宣傳標語<span class="hint">（每行一句）</span></label><textarea data-f="tagline" style="min-height:56px;">${esc((m.tagline||[]).join("\n"))}</textarea></div>
          <div class="row2">
            <div class="field"><label>所屬公司</label><input data-f="company" value="${esc(m.company||"")}" placeholder="待補充"></div>
            <div class="field"><label>主要營業項目</label><input data-f="business_items" value="${esc(m.business_items||"")}" placeholder="待補充"></div>
          </div>
        </div>
      </div>`;
  }

  function bindMember(g, m, i){
    const card = main.querySelector('.mem-card[data-mid="'+cssq(m.id)+'"]');
    if(!card) return;
    ["number","name","title","company","business_items"].forEach(f => {
      wireTextInput(card.querySelector('[data-f="'+f+'"]'), v => { m[f] = v; scheduleSaveAndValidate(); });
    });
    ["services","targets","tagline"].forEach(f => {
      wireTextInput(card.querySelector('[data-f="'+f+'"]'), v => { m[f] = linesToArr(v); scheduleSave(); });
    });
    const chk = card.querySelector('[data-f="dataIssue"]');
    chk.addEventListener("change", () => { pushUndo(); m.dataIssue = chk.checked; scheduleSave(); });

    const fileInput = card.querySelector('[data-act="file"]');
    card.querySelector('[data-act="photo"]').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      if(!file) return;
      try{
        const dataUrl = await cropAndResize(file);   // 開啟裁剪視窗；取消回傳 null
        if(dataUrl){
          pushUndo();
          m.image = dataUrl;
          renderMembers(g); saveDraft(); toast("照片已更新，記得最後按「發布到網站」");
        }
      }catch(e){ toast("照片讀取失敗", {warn:true}); }
      fileInput.value = "";
    };
    card.querySelector('[data-act="rmphoto"]').onclick = () => {
      if(!m.image) return;
      pushUndo();
      m.image = ""; renderMembers(g); saveDraft();
    };
    card.querySelector('[data-act="up"]').onclick = () => moveMember(g, i, -1);
    card.querySelector('[data-act="down"]').onclick = () => moveMember(g, i, 1);
    card.querySelector('[data-act="dup"]').onclick = () => duplicateMember(g, i);
    card.querySelector('[data-act="del"]').onclick = () => deleteMember(g, i);
  }

  /* ---------- mutations（每個結構性動作先 pushUndo() 記錄一步） ---------- */
  function moveGroup(i, dir){
    const j = i + dir; if(j<0||j>=DATA.length) return;
    pushUndo();
    [DATA[i], DATA[j]] = [DATA[j], DATA[i]];
    renderAll(); scheduleSave();
  }
  function addGroup(){
    pushUndo();
    const g = { id: uid("g"), code:"新", name:"新分組", leader:"", room:"", members:[] };
    DATA.push(g); selected = g.id; renderAll(); scheduleSave();
    byId("g-code") && byId("g-code").focus();
    toast("已新增分組，請填代號與名稱");
  }
  function addMember(g, name, opts){
    opts = opts || {};
    pushUndo();
    const m = { id: uid(g.id+"_m"), number:"", name:name||"", title:"", services:[], targets:[], tagline:[], image:"", company:"", business_items:"", dataIssue:false };
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
  function serialize(){
    return "// 會員名錄資料檔 — 由後台編輯器 admin.html 產生/更新\n" +
           "// 直接用文字編輯器修改也可以；欄位說明見 README.md\n" +
           "const GROUPS = " + JSON.stringify(DATA, null, 2) + ";\n" +
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
  function loadSession(){
    let raw = null; try{ raw = sessionStorage.getItem(SESSION_KEY); }catch(e){}
    if(raw){
      let s; try{ s = JSON.parse(raw); }catch(e){ s = null; }
      if(s && s.token && s.exp && Date.now() < s.exp) return s.token;
    }
    if(memSession && memSession.token && Date.now() < memSession.exp) return memSession.token;
    return null;
  }
  function saveSession(token, expiresInSeconds){
    memSession = { token, exp: Date.now() + expiresInSeconds*1000 };
    try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(memSession)); }catch(e){}
  }
  function clearSession(){
    memSession = null;
    try{ sessionStorage.removeItem(SESSION_KEY); }catch(e){}
  }

  async function workerFetch(path, payload, urlOverride){
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
      ? "輸入管理密碼進入編輯模式。"
      : "尚未設定發布服務。請按下方「連線設定」貼上 Worker 網址。";
    byId("lock-pass-field").style.display = configured ? "" : "none";
    byId("lock-enter").style.display = configured ? "" : "none";
    byId("lock-error").hidden = true;
    byId("lock-overlay").hidden = false;
    if(configured) byId("lock-pass").focus();
  }
  function hideLock(){ byId("lock-overlay").hidden = true; }

  async function tryUnlock(){
    const pass = byId("lock-pass").value;
    if(!pass){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "請先輸入密碼。";
      byId("lock-pass").focus();
      return;
    }
    if(!loadWorkerUrl()){ openSettings(); return; }
    const btn = byId("lock-enter");
    btn.disabled = true; btn.textContent = "確認中…";
    const res = await workerFetch("/login", { password: pass });
    btn.disabled = false; btn.textContent = "進入編輯模式";
    if(res.ok && res.session){
      saveSession(res.session, res.expiresInSeconds || 1800);
      byId("lock-pass").value = "";
      hideLock();
      hidePermBanner();
      toast("已進入編輯模式");
      checkHealth(res.session);   // 登入後順便確認伺服器上的 GitHub 權杖還能不能寫入
    } else if(res.error === "too_many_attempts"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "密碼錯誤次數過多，請等約 " + Math.ceil((res.retryAfter||60)/60) + " 分鐘後再試。";
    } else if(res.error === "no_worker_url" || res.error === "network"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "連不到發布服務，請檢查「連線設定」裡的網址是否正確。";
    } else if(res.error === "rate_limit_unavailable" || res.error === "misconfigured_missing_allowed_origin"){
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "發布服務尚未設定完成，請管理員檢查 Cloudflare Worker 的設定（見 worker/README.md）。";
    } else {
      byId("lock-error").hidden = false;
      byId("lock-error").textContent = "密碼不正確，請再試一次。";
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
    const url = byId("s-worker-url").value.trim().replace(/\/+$/, "");
    if(url && !/^https:\/\//.test(url)){ toast("網址需以 https:// 開頭", {warn:true}); return; }
    const changed = url !== loadWorkerUrl();
    saveWorkerUrl(url);
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

  let publishing = false;
  async function publish(){
    if(publishing) return false;
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
      const res = await workerFetch("/publish", { session, content: serialize() });
      if(res.ok){
        clearTimeout(saveTimer);
        dirty = false;
        try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
        showDraftBanner(false);
        hidePermBanner();
        ok = true;
        toast("已發布！約 1 分鐘後公開網站就會更新 ✔", {duration:6000});
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

  function renderAll(){ renderSidebar(); renderMain(); }

  /* ---------- boot ---------- */
  // 清掉舊版（權杖存本機加密）留下的機密，遷移到新架構後這些不該再存在
  try{
    localStorage.removeItem("member-directory-gh-token-v1");
    localStorage.removeItem("member-directory-gh-token-enc-v1");
    localStorage.removeItem("member-directory-gh-settings-v1");
  }catch(e){}
  tryLoadDraft();
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
  byId("btn-undo").onclick = undo;
  byId("btn-redo").onclick = redo;
  byId("s-save").onclick = saveSettings;
  byId("s-cancel").onclick = closeSettings;
  byId("s-test").onclick = testConnection;
  byId("lock-enter").onclick = tryUnlock;
  byId("lock-pass").addEventListener("keydown", e => { if(e.key === "Enter") tryUnlock(); });
  byId("s-worker-url").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); saveSettings(); } });
  byId("lock-setup").onclick = () => { openSettings(); };
  byId("perm-recheck").onclick = () => { hidePermBanner(); toast("已隱藏提醒，發布時若還有問題會再顯示"); };
  byId("settings-modal").addEventListener("click", e => { if(e.target.id === "settings-modal") closeSettings(); });

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
      if(!byId("leave-modal").hidden){ closeLeaveModal(); return; }
      if(!byId("settings-modal").hidden){ closeSettings(); return; }
      if(document.body.classList.contains("drawer-open")){ closeDrawerIfMobile(); return; }
    }
    // 只有在編輯中（非鎖定、非彈窗）才吃 Ctrl+Z / Ctrl+Y
    const editing = byId("lock-overlay").hidden && byId("settings-modal").hidden && byId("crop-modal").hidden && byId("leave-modal").hidden;
    if(editing && (e.ctrlKey || e.metaKey)){
      if(e.key === "z" && !e.shiftKey){ e.preventDefault(); undo(); }
      else if((e.key === "z" && e.shiftKey) || e.key === "y"){ e.preventDefault(); redo(); }
    }
  });

  window.addEventListener("beforeunload", () => { if(dirty) saveDraft(); });
})();
