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
    bindTextField("g-code", v => { g.code = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindTextField("g-name", v => { g.name = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindTextField("g-leader", v => { g.leader = v; scheduleSaveAndValidate(); });
    bindTextField("g-recruit", v => { g.recruiting = linesToArr(v); scheduleSave(); });
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

    /* 名片:不裁切,自動縮圖 */
    const cardFile = card.querySelector('[data-act="cardfile"]');
    card.querySelector('[data-act="cardbtn"]').onclick = () => cardFile.click();
    cardFile.onchange = async () => {
      const file = cardFile.files && cardFile.files[0];
      cardFile.value = "";
      if(!file) return;
      const url = await resizeFlat(file, 1400);
      if(url){ pushUndo(); m.card = url; renderMembers(g); saveDraft(); toast("名片已更新，記得最後按「發布到網站」"); }
      else toast("名片讀取失敗", {warn:true});
    };
    card.querySelector('[data-act="rmcard"]').onclick = () => {
      if(!m.card) return;
      pushUndo(); m.card = ""; renderMembers(g); saveDraft();
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
        renderMembers(g); saveDraft();
        toast("已加入 " + ok + " 張商品照" + (files.length > room ? "（超過 5 張上限，其餘略過）" : "") + "，記得最後按「發布到網站」");
      };
    }
    card.querySelectorAll('[data-act="rmprod"]').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.i, 10);
        if(!(m.products || [])[idx] && (m.products || [])[idx] !== "") return;
        pushUndo(); m.products.splice(idx, 1); renderMembers(g); saveDraft();
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
    const m = { id: uid(g.id+"_m"), number:"", name:name||"", title:"", services:[], targets:[], tagline:[], image:"", company:"", business_items:"", website:"", card:"", products:[], dataIssue:false };
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

  /* ==================================================================
     CSV 匯出／匯入 與 批次照片
     匯入原則：「空格＝不變更」「一個 - ＝清空」「刪除要在刪除欄標記」，
     且套用前一定先看差異預覽——一張錯表不會毀掉名錄。
     ================================================================== */
  const CSV_HEADERS = ["編號","姓名","行業職稱","分組代號","分組名稱","服務項目","適合引薦對象","宣傳標語","所屬公司","主要營業項目","公司網站","照片","名片","商品照片數","資料需確認","刪除"];
  const FIELD_DEFS = [
    { key:"number",         label:"編號",          type:"str" },
    { key:"name",           label:"姓名",          type:"str" },
    { key:"title",          label:"行業職稱",      type:"str" },
    { key:"services",       label:"服務項目",      type:"arr" },
    { key:"targets",        label:"適合引薦對象",  type:"arr" },
    { key:"tagline",        label:"宣傳標語",      type:"arr" },
    { key:"company",        label:"所屬公司",      type:"str" },
    { key:"business_items", label:"主要營業項目",  type:"str" },
    { key:"website",        label:"公司網站",      type:"str" },
    { key:"dataIssue",      label:"資料需確認",    type:"bool" },
  ];
  const YES_VALUES = ["是","y","yes","v","true"];
  const DEL_VALUES = ["是","y","yes","v","刪除","delete"];

  function csvEscape(v){
    v = String(v == null ? "" : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  /* 支援引號、跳脫引號、CRLF、BOM 的標準 CSV 解析 */
  function parseCSV(text){
    text = String(text).replace(/^\uFEFF/, "");
    const rows = []; let row = [], field = "", inQ = false;
    for(let i = 0; i < text.length; i++){
      const c = text[i];
      if(inQ){
        if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if(c === '"') inQ = true;
        else if(c === ","){ row.push(field); field = ""; }
        else if(c === "\n"){ row.push(field); rows.push(row); row = []; field = ""; }
        else if(c !== "\r") field += c;
      }
    }
    if(field !== "" || row.length){ row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ""));
  }

  function csvExport(){
    const rows = [CSV_HEADERS.slice()];
    DATA.forEach(g => g.members.forEach(m => {
      rows.push([
        m.number || "", m.name || "", m.title || "", g.code || "", g.name || "",
        (m.services || []).join("|"), (m.targets || []).join("|"), (m.tagline || []).join("|"),
        m.company || "", m.business_items || "", m.website || "",
        /^data:/.test(m.image || "") ? "(內嵌照片)" : (m.image || ""),
        /^data:/.test(m.card || "") ? "(內嵌名片)" : (m.card || ""),
        String((m.products || []).length),
        m.dataIssue ? "是" : "", "",
      ]);
    }));
    const csv = "\uFEFF" + rows.map(r => r.map(csvEscape).join(",")).join("\r\n");   // BOM：讓 Excel 直接開就是正確中文
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const d = new Date(), pad = n => String(n).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = "會員名錄_" + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    const total = DATA.reduce((n, g) => n + g.members.length, 0);
    toast("已匯出名冊：" + DATA.length + " 組、" + total + " 位成員");
  }

  /* ---------- 匯入：欄位對應（容忍常見別名） ---------- */
  function importColMap(header){
    const alias = {
      "編號":"number", "姓名":"name",
      "行業職稱":"title", "行業":"title", "職稱":"title", "行業/職稱":"title", "行業／職稱":"title",
      "分組代號":"gcode", "組別代號":"gcode", "組別":"gcode", "分組":"gcode",
      "分組名稱":"gname", "組名":"gname",
      "服務項目":"services", "適合引薦對象":"targets", "宣傳標語":"tagline",
      "所屬公司":"company", "主要營業項目":"business_items",
      "公司網站":"website", "網站":"website",
      "資料需確認":"dataIssue", "刪除":"del",
    };
    const map = {};
    header.forEach((h, i) => { const k = alias[String(h).trim()]; if(k && !(k in map)) map[k] = i; });
    return map;
  }

  function buildImportPlan(rows){
    const col = importColMap(rows[0]);
    const plan = { updates:[], moves:[], adds:[], dels:[], newGroups:[], errors:[], skipped:0, rowCount: rows.length - 1 };
    if(!("name" in col) && !("number" in col)){
      plan.errors.push("找不到「姓名」或「編號」欄位——請用「匯出 CSV」的檔案當範本修改後再匯入。");
      return plan;
    }
    const cell = (row, key) => (key in col) ? String(row[col[key]] == null ? "" : row[col[key]]).trim() : null;   // null＝整欄不存在
    function parseVal(def, raw){
      if(raw === null || raw === "") return undefined;                     // 空格＝不變更
      if(raw === "-") return def.type === "arr" ? [] : def.type === "bool" ? false : "";   // - ＝清空
      if(def.type === "arr") return raw.split("|").map(s => s.trim()).filter(Boolean);
      if(def.type === "bool") return YES_VALUES.includes(raw.toLowerCase());
      return raw;
    }

    const byNumber = new Map(), byName = new Map(), gByCode = new Map();
    DATA.forEach(g => {
      const c = (g.code || "").trim();
      if(c && !gByCode.has(c)) gByCode.set(c, g);
      g.members.forEach(m => {
        const n = (m.number || "").trim();
        if(n) byNumber.set(n, (byNumber.get(n) || []).concat([{ g, m }]));
        const nm = (m.name || "").trim();
        if(nm) byName.set(nm, (byName.get(nm) || []).concat([{ g, m }]));
      });
    });
    const pendingNewGroups = new Map();
    const seen = new Set();

    for(let r = 1; r < rows.length; r++){
      const row = rows[r], rowNo = r + 1;
      const number = cell(row, "number") || "";
      const name = cell(row, "name") || "";
      if(!number && !name){ plan.skipped++; continue; }

      /* 比對：編號優先、姓名備援 */
      let hit = null, matchedBy = "";
      if(number && byNumber.has(number)){
        const list = byNumber.get(number);
        if(list.length > 1){ plan.errors.push("第 " + rowNo + " 列：編號 " + number + " 在名錄中重複（" + list.map(x => x.m.name).join("／") + "），無法判定，此列略過"); continue; }
        hit = list[0]; matchedBy = "編號";
      } else if(name && byName.has(name)){
        const list = byName.get(name);
        if(list.length > 1){ plan.errors.push("第 " + rowNo + " 列：姓名「" + name + "」在名錄中有 " + list.length + " 位且無法用編號判定，此列略過"); continue; }
        hit = list[0]; matchedBy = "姓名";
      }
      if(hit && seen.has(hit.m.id)){ plan.errors.push("第 " + rowNo + " 列：與前面的列指向同一位成員（" + hit.m.name + "），此列略過"); continue; }

      /* 刪除：一定要明確標記 */
      const delRaw = cell(row, "del");
      if(delRaw && DEL_VALUES.includes(delRaw.toLowerCase())){
        if(!hit){ plan.errors.push("第 " + rowNo + " 列：標記刪除，但名錄中找不到「" + (name || number) + "」"); continue; }
        seen.add(hit.m.id);
        plan.dels.push({ g: hit.g, m: hit.m });
        continue;
      }

      /* 分組：填了代號才會移動；代號不存在但有填分組名稱＝建新組 */
      const gcode = cell(row, "gcode");
      let targetG = null, newGroupKey = null;
      if(gcode){
        targetG = gByCode.get(gcode) || null;
        if(!targetG){
          if(pendingNewGroups.has(gcode)){ newGroupKey = gcode; }
          else {
            const gname = cell(row, "gname") || "";
            if(gname){
              pendingNewGroups.set(gcode, { code: gcode, name: gname });
              plan.newGroups.push({ code: gcode, name: gname });
              newGroupKey = gcode;
            } else {
              plan.errors.push("第 " + rowNo + " 列：分組代號「" + gcode + "」不存在（要建新組請同時填「分組名稱」），此列略過");
              continue;
            }
          }
        }
      }

      if(!hit){
        if(!gcode){ plan.errors.push("第 " + rowNo + " 列：「" + (name || number) + "」是新成員，但沒有填分組代號，此列略過"); continue; }
        const fields = {};
        FIELD_DEFS.forEach(def => { const v = parseVal(def, cell(row, def.key)); if(v !== undefined) fields[def.key] = v; });
        plan.adds.push({ rowNo, name, number, targetG, newGroupKey, fields });
        continue;
      }
      seen.add(hit.m.id);

      if((targetG && targetG.id !== hit.g.id) || newGroupKey){
        plan.moves.push({ m: hit.m, from: hit.g, to: targetG, newGroupKey });
      }

      const changes = [];
      FIELD_DEFS.forEach(def => {
        const val = parseVal(def, cell(row, def.key));
        if(val === undefined) return;
        const cur = def.type === "arr" ? (hit.m[def.key] || []) : def.type === "bool" ? !!hit.m.dataIssue : (hit.m[def.key] || "");
        const same = def.type === "arr" ? JSON.stringify(cur) === JSON.stringify(val) : cur === val;
        if(!same) changes.push({ key: def.key, label: def.label, type: def.type, val,
          from: def.type === "arr" ? cur.join("|") : String(cur),
          to:   def.type === "arr" ? val.join("|") : String(val) });
      });
      if(changes.length) plan.updates.push({ m: hit.m, g: hit.g, matchedBy, changes });
    }
    return plan;
  }

  function groupCountRows(plan){
    const counts = [];
    const byGid = new Map();
    DATA.forEach(g => { const c = { code: g.code, name: g.name, before: g.members.length, after: g.members.length }; counts.push(c); byGid.set(g.id, c); });
    const byNew = new Map();
    plan.newGroups.forEach(ng => { const c = { code: ng.code, name: ng.name + "（新組）", before: 0, after: 0 }; counts.push(c); byNew.set(ng.code, c); });
    const target = mv => mv.newGroupKey ? byNew.get(mv.newGroupKey) : byGid.get(mv.to.id);
    plan.moves.forEach(mv => { byGid.get(mv.from.id).after--; const t = target(mv); if(t) t.after++; });
    plan.adds.forEach(a => { const t = a.newGroupKey ? byNew.get(a.newGroupKey) : byGid.get(a.targetG.id); if(t) t.after++; });
    plan.dels.forEach(d => { byGid.get(d.g.id).after--; });
    return counts;
  }

  function renderPlanHTML(plan){
    let h = "";
    const sec = (title, cnt, inner, cls) => cnt
      ? '<div class="batch-sec ' + (cls || "") + '"><h4>' + esc(title) + '<span class="cnt">' + cnt + "</span></h4>" + inner + "</div>" : "";
    h += sec("錯誤（這些列不會套用）", plan.errors.length, "<ul>" + plan.errors.map(e => "<li>" + esc(e) + "</li>").join("") + "</ul>", "err");
    h += sec("移動分組", plan.moves.length, "<ul>" + plan.moves.map(mv =>
      "<li><b>" + esc(mv.m.name) + "</b>：" + esc(mv.from.code) + " → " + esc(mv.newGroupKey || (mv.to && mv.to.code) || "?") + "</li>").join("") + "</ul>");
    h += sec("新增成員", plan.adds.length, "<ul>" + plan.adds.map(a =>
      "<li><b>" + esc(a.name || a.number) + "</b> → " + esc(a.newGroupKey || (a.targetG && a.targetG.code) || "?") + "</li>").join("") + "</ul>");
    h += sec("刪除成員", plan.dels.length, "<ul>" + plan.dels.map(d =>
      "<li><b>" + esc(d.m.name) + "</b>（" + esc(d.g.code) + "）</li>").join("") + "</ul>");
    h += sec("欄位更新", plan.updates.length, "<ul>" + plan.updates.map(u =>
      "<li><b>" + esc(u.m.name) + "</b>：" + u.changes.map(c => esc(c.label) + "「" + esc(c.from || "（空）") + "」→「" + esc(c.to || "（清空）") + "」").join("；") + "</li>").join("") + "</ul>");
    if(plan.newGroups.length){
      h += sec("將建立新分組", plan.newGroups.length, "<ul>" + plan.newGroups.map(g => "<li>" + esc(g.code) + "・" + esc(g.name) + "</li>").join("") + "</ul>");
    }
    const counts = groupCountRows(plan).filter(c => c.before !== c.after);
    if(counts.length){
      h += '<div class="batch-sec"><h4>各組人數變化</h4><table class="batch-table"><tr><th>組</th><th>套用前</th><th>套用後</th></tr>' +
        counts.map(c => "<tr><td>" + esc(c.code) + "・" + esc(c.name) + '</td><td>' + c.before + '</td><td class="up">' + c.after + "</td></tr>").join("") +
        "</table></div>";
    }
    h += '<div class="batch-note">規則：空格＝不變更；填一個 <b>-</b> ＝清空該欄；「服務項目／引薦對象／標語」多項用 <b>|</b> 分隔；要刪人請在「刪除」欄填「是」。照片欄僅供核對，匯入不會動照片（照片請用「批次照片」）。</div>';
    return h || "<p>沒有偵測到任何變更。</p>";
  }

  function applyImportPlan(plan){
    pushUndo();
    const createdByCode = new Map();
    plan.newGroups.forEach(ng => {
      const g = { id: uid("g"), code: ng.code, name: ng.name, leader: "", room: "", members: [] };
      DATA.push(g); createdByCode.set(ng.code, g);
    });
    const resolveG = (targetG, key) => key ? createdByCode.get(key) : (targetG ? groupById(targetG.id) : null);
    plan.updates.forEach(u => u.changes.forEach(c => { u.m[c.key] = c.val; }));
    plan.moves.forEach(mv => {
      const from = groupById(mv.from.id), to = resolveG(mv.to, mv.newGroupKey);
      if(!from || !to || from === to) return;
      const i = from.members.indexOf(mv.m);
      if(i >= 0){ from.members.splice(i, 1); to.members.push(mv.m); }
    });
    plan.adds.forEach(a => {
      const to = resolveG(a.targetG, a.newGroupKey);
      if(!to) return;
      const m = { id: uid(to.id + "_m"), number: a.number || "", name: a.name || "", title: "", services: [], targets: [], tagline: [], image: "", company: "", business_items: "", website: "", card: "", products: [], dataIssue: false };
      FIELD_DEFS.forEach(def => { if(def.key in a.fields) m[def.key] = a.fields[def.key]; });
      to.members.push(m);
    });
    plan.dels.forEach(d => {
      const g = groupById(d.g.id);
      if(!g) return;
      const i = g.members.indexOf(d.m);
      if(i >= 0) g.members.splice(i, 1);
    });
    fixSelected(); renderAll(); validate(); saveDraft();
  }

  function handleCsvFile(file){
    const readAs = enc => new Promise(res => { const fr = new FileReader(); fr.onerror = () => res(null); fr.onload = () => res(String(fr.result)); fr.readAsText(file, enc); });
    (async () => {
      let text = await readAs("utf-8");
      if(text == null){ toast("CSV 讀取失敗", { warn:true }); return; }
      // 舊版 Excel 另存的 CSV 是 Big5：出現大量亂碼替代字元時自動改用 Big5 重讀
      if((text.match(/�/g) || []).length > 2){
        const big5 = await readAs("big5");
        if(big5 && (big5.match(/�/g) || []).length === 0) text = big5;
      }
      processCsvText(text, "匯入 CSV");
    })();
  }

  /* 一段 CSV 文字 → 差異預覽 → 套用（檔案上傳與「抓表單回應」共用同一條路） */
  function processCsvText(text, sourceLabel){
    const rows = parseCSV(text);
    if(rows.length < 2){ toast((sourceLabel || "CSV") + " 裡沒有資料列（第一列需為欄位名稱）", { warn:true }); return; }
    const plan = buildImportPlan(rows);
    const total = plan.updates.length + plan.moves.length + plan.adds.length + plan.dels.length;
    openBatchModal(
      (sourceLabel || "匯入 CSV") + " — 變更預覽",
      renderPlanHTML(plan),
      "共 " + plan.rowCount + " 列：更新 " + plan.updates.length + "・移組 " + plan.moves.length + "・新增 " + plan.adds.length + "・刪除 " + plan.dels.length + (plan.errors.length ? "・錯誤 " + plan.errors.length : ""),
      total ? "套用 " + total + " 項變更" : "沒有可套用的變更",
      total ? () => {
        applyImportPlan(plan);
        toast("已套用 " + total + " 項變更（可用上一步復原）；確認沒問題後記得按「發布到網站」", { duration: 7000 });
      } : null
    );
  }

  /* ---------- 抓表單回應：直接拉「匯入用」分頁發布的 CSV，免下載免上傳 ---------- */
  const FORMCSV_KEY = "member-directory-formcsv-url-v1";
  let memFormCsvUrl = "";
  function loadFormCsvUrl(){
    let saved = ""; try{ saved = localStorage.getItem(FORMCSV_KEY) || ""; }catch(e){}
    return (saved || memFormCsvUrl || "").trim();
  }
  function saveFormCsvUrl(url){
    memFormCsvUrl = url;
    try{ localStorage.setItem(FORMCSV_KEY, url); }catch(e){}
  }
  async function pullFormResponses(){
    const url = loadFormCsvUrl();
    if(!url){
      toast("先到「設定」貼上表單回應的 CSV 發布網址（教學見該欄位說明）", { warn:true, duration: 7000 });
      openSettings();
      return;
    }
    const btn = byId("btn-pull-form");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "拉取中…";
    try{
      const res = await fetch(url, { cache: "no-store" });
      if(!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if(/<html/i.test(text.slice(0, 300))) throw new Error("not_csv");   // 拿到網頁＝網址不是「發布的 CSV」
      processCsvText(text, "表單回應");
    }catch(e){
      toast("拉不到表單資料：請確認「匯入用」分頁已「發布到網路（CSV）」且網址正確", { warn: true, duration: 8000 });
    }finally{
      btn.disabled = false; btn.textContent = orig;
    }
  }

  /* ---------- 批次照片：檔名配對 成員id → 編號 → 姓名 ---------- */
  function autoCropResize(file){
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const out = document.createElement("canvas");
          out.width = CROP_OUT_W; out.height = CROP_OUT_H;
          const ctx = out.getContext("2d");
          const s = Math.max(CROP_OUT_W / img.naturalWidth, CROP_OUT_H / img.naturalHeight);
          const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
          ctx.drawImage(img, (CROP_OUT_W - dw) / 2, (CROP_OUT_H - dh) / 2, dw, dh);
          let url; try{ url = out.toDataURL("image/jpeg", 0.85); }catch(e){ url = null; }
          resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function matchPhotoFiles(files){
    const byIdMap = new Map(), byNumber = new Map(), byName = new Map();
    const normNum = n => (String(n || "").trim().replace(/^0+/, "") || "0");
    DATA.forEach(g => g.members.forEach(m => {
      byIdMap.set(m.id, { g, m });
      const n = (m.number || "").trim();
      if(n) byNumber.set(normNum(n), (byNumber.get(normNum(n)) || []).concat([{ g, m }]));
      const nm = (m.name || "").trim();
      if(nm) byName.set(nm, (byName.get(nm) || []).concat([{ g, m }]));
    }));
    const matched = [], unmatched = [];
    const taken = new Set();
    for(const file of files){
      const stem = file.name.replace(/\.[^.]+$/, "").trim();
      let hit = null, how = "";
      if(byIdMap.has(stem)){ hit = byIdMap.get(stem); how = "成員id"; }
      else {
        const stemNoSuffix = stem.replace(/_x$/, "");
        if(byIdMap.has(stemNoSuffix)){ hit = byIdMap.get(stemNoSuffix); how = "成員id"; }
      }
      if(!hit && /\d/.test(stem)){
        const numPart = (stem.match(/^0*(\d+)/) || [])[1];
        if(numPart){
          const list = byNumber.get(normNum(numPart)) || [];
          if(list.length === 1){ hit = list[0]; how = "編號"; }
        }
      }
      if(!hit){
        const list = byName.get(stem) || [];
        if(list.length === 1){ hit = list[0]; how = "姓名"; }
        else if(list.length > 1){ unmatched.push({ name: file.name, why: "同名 " + list.length + " 位，請改用編號命名" }); continue; }
      }
      if(!hit){ unmatched.push({ name: file.name, why: "對不到編號、姓名或成員id" }); continue; }
      if(taken.has(hit.m.id)){ unmatched.push({ name: file.name, why: "與另一個檔案配到同一位（" + hit.m.name + "）" }); continue; }
      taken.add(hit.m.id);
      matched.push({ file, g: hit.g, m: hit.m, how });
    }
    return { matched, unmatched };
  }

  function handlePhotoFiles(fileList){
    const res = matchPhotoFiles(Array.from(fileList));
    let h = "";
    if(res.matched.length){
      h += '<div class="batch-sec"><h4>將更新照片<span class="cnt">' + res.matched.length + "</span></h4><ul class='batch-photo-list'>" +
        res.matched.map((it, i) => "<li><img class='batch-thumb' data-thumb='" + i + "' alt=''><b>" + esc(it.m.name) + "</b>（" + esc(it.g.code) + "）← " + esc(it.file.name) + "<span style='color:var(--faint);'>（以" + it.how + "配對）</span></li>").join("") + "</ul></div>";
    }
    if(res.unmatched.length){
      h += '<div class="batch-sec err"><h4>無法配對<span class="cnt">' + res.unmatched.length + "</span></h4><ul>" +
        res.unmatched.map(u => "<li>" + esc(u.name) + "——" + esc(u.why) + "</li>").join("") + "</ul></div>";
    }
    h += '<div class="batch-note">檔名配對規則（擇一即可）：<b>編號</b>（如 001.jpg、079小明.jpg 開頭是編號也可）、<b>姓名</b>（如 曾俊凱.jpg）、或成員id。照片會自動置中裁成名錄比例。</div>';
    const thumbs = res.matched.map(it => URL.createObjectURL(it.file));
    setTimeout(() => thumbs.forEach(u => URL.revokeObjectURL(u)), 120000);   // 取消不套用時的保底回收
    openBatchModal(
      "批次照片 — 配對預覽(縮圖請逐張目視審查)",
      h,
      "選了 " + fileList.length + " 個檔案：可配對 " + res.matched.length + "・無法配對 " + res.unmatched.length,
      res.matched.length ? "審查沒問題，套用 " + res.matched.length + " 張" : "沒有可套用的照片",
      res.matched.length ? async () => {
        thumbs.forEach(u => URL.revokeObjectURL(u));
        toast("照片處理中…", { duration: 60000 });
        pushUndo();
        let done = 0, failed = 0;
        for(const it of res.matched){
          const url = await autoCropResize(it.file);
          if(url){ it.m.image = url; done++; } else failed++;
        }
        renderAll(); validate(); saveDraft();
        const failNote = failed ? "（" + failed + " 張讀取失敗未更新）" : "";
        toast(workerCaps.files
          ? "已更新 " + done + " 張照片" + failNote + "，發布時會自動存成實體圖檔"
          : "已更新 " + done + " 張照片" + failNote + "。發布後照片會由自動同步機制轉成實體圖檔（1–2 分鐘）", { duration: 9000 });
      } : null
    );
    document.querySelectorAll(".batch-thumb").forEach(img => {
      const i = parseInt(img.dataset.thumb, 10);
      if(thumbs[i]) img.src = thumbs[i];
    });
  }

  /* ---------- 匯入 PPT:會員專業簡報 → 批次更新欄位與照片 ----------
     版型解析在 pptimport.js;這裡負責比對成員(編號優先、姓名備援)、
     差異預覽與套用。空欄位=不變更、找不到的人列為待處理,不會自動新增。 */
  function buildPptPlan(slides){
    const plan = { updates: [], photos: [], errors: [], unrecognized: [], slideCount: slides.length };
    const byNumber = new Map(), byName = new Map();
    DATA.forEach(g => g.members.forEach(m => {
      const n = (m.number || "").trim();
      if(n) byNumber.set(n.replace(/^0+/, "") || "0", (byNumber.get(n.replace(/^0+/, "") || "0") || []).concat([{ g, m }]));
      const nm = (m.name || "").trim();
      if(nm) byName.set(nm, (byName.get(nm) || []).concat([{ g, m }]));
    }));
    const seen = new Set();
    const PPT_FIELDS = [
      { key: "title",    label: "行業職稱", type: "str" },
      { key: "services", label: "服務項目", type: "arr" },
      { key: "targets",  label: "適合引薦對象", type: "arr" },
      { key: "tagline",  label: "宣傳標語", type: "arr" },
    ];
    for(const s of slides){
      if(!s.name && !s.number){
        if(s.photoPath || s.unclassified.length) plan.errors.push("第 " + s.slideNo + " 頁:抓不到姓名與編號,略過");
        continue;   // 封面、目錄等版型外頁面,靜默跳過
      }
      let hit = null;
      const normNum = (s.number || "").replace(/^0+/, "") || "";
      if(normNum && byNumber.has(normNum)){
        const list = byNumber.get(normNum);
        if(list.length === 1) hit = list[0];
      }
      if(!hit && s.name && byName.has(s.name)){
        const list = byName.get(s.name);
        if(list.length === 1) hit = list[0];
      }
      if(!hit){
        plan.errors.push("第 " + s.slideNo + " 頁:「" + (s.name || s.number) + "」在名錄找不到(簡報無分組資訊,請先在後台建好人再匯入)");
        continue;
      }
      if(seen.has(hit.m.id)){
        plan.errors.push("第 " + s.slideNo + " 頁:與前面頁面指向同一位成員(" + hit.m.name + "),略過");
        continue;
      }
      seen.add(hit.m.id);

      const changes = [];
      for(const def of PPT_FIELDS){
        const val = def.type === "arr" ? (s[def.key] || []) : String(s[def.key] || "").trim();
        const has = def.type === "arr" ? val.length > 0 : val !== "";
        if(!has) continue;                                     // 簡報空欄=不變更
        const cur = def.type === "arr" ? (hit.m[def.key] || []) : (hit.m[def.key] || "");
        const same = def.type === "arr" ? JSON.stringify(cur) === JSON.stringify(val) : cur === val;
        if(!same) changes.push({ key: def.key, label: def.label, type: def.type, val,
          from: def.type === "arr" ? cur.join("|") : String(cur),
          to: def.type === "arr" ? val.join("|") : String(val) });
      }
      if(changes.length) plan.updates.push({ m: hit.m, g: hit.g, changes });
      if(s.photoBlob) plan.photos.push({ m: hit.m, g: hit.g, blob: s.photoBlob, slideNo: s.slideNo });
      if(s.unclassified.length) plan.unrecognized.push("第 " + s.slideNo + " 頁(" + hit.m.name + "):" + s.unclassified.join("/"));
    }
    return plan;
  }

  function renderPptPlanHTML(plan){
    let h = "";
    const sec = (title, cnt, inner, cls) => cnt
      ? '<div class="batch-sec ' + (cls || "") + '"><h4>' + esc(title) + '<span class="cnt">' + cnt + "</span></h4>" + inner + "</div>" : "";
    h += sec("待處理(這些頁不會套用)", plan.errors.length, "<ul>" + plan.errors.map(e => "<li>" + esc(e) + "</li>").join("") + "</ul>", "err");
    h += sec("欄位更新", plan.updates.length, "<ul>" + plan.updates.map(u =>
      "<li><b>" + esc(u.m.name) + "</b>：" + u.changes.map(c => esc(c.label) + "「" + esc(c.from || "（空）") + "」→「" + esc(c.to) + "」").join("；") + "</li>").join("") + "</ul>");
    h += sec("照片更新(自動置中裁切)", plan.photos.length, "<ul>" + plan.photos.map(p =>
      "<li><b>" + esc(p.m.name) + "</b>（第 " + p.slideNo + " 頁的照片）</li>").join("") + "</ul>");
    h += sec("未辨識的文字(不影響套用,供人工確認)", plan.unrecognized.length,
      "<ul>" + plan.unrecognized.map(t => "<li>" + esc(t) + "</li>").join("") + "</ul>", "err");
    h += '<div class="batch-note">規則：以<b>編號</b>比對(姓名備援);簡報空欄位=不變更;名錄查無此人不會自動新增。套用後可用「上一步」復原,最後記得「發布到網站」。</div>';
    return h || "<p>沒有偵測到可更新的內容。</p>";
  }

  async function handlePptFile(file){
    if(typeof PPTImport === "undefined" || typeof JSZip === "undefined"){ toast("PPT 解析模組未載入", { warn: true }); return; }
    toast("解析簡報中…", { duration: 30000 });
    let parsed;
    try{ parsed = await PPTImport.parse(file); }
    catch(e){ toast("這個檔案無法解析(請確認是 .pptx)", { warn: true }); return; }
    hideToast();
    if(!parsed.count){ toast("簡報裡沒有投影片", { warn: true }); return; }
    const plan = buildPptPlan(parsed.slides);
    const total = plan.updates.length + plan.photos.length;
    openBatchModal(
      "匯入 PPT — 變更預覽",
      renderPptPlanHTML(plan),
      "共 " + plan.slideCount + " 頁：欄位更新 " + plan.updates.length + " 位・照片更新 " + plan.photos.length + " 位" + (plan.errors.length ? "・待處理 " + plan.errors.length : ""),
      total ? "套用 " + total + " 項變更" : "沒有可套用的變更",
      total ? async () => {
        toast("套用中(含照片裁切)…", { duration: 60000 });
        pushUndo();
        plan.updates.forEach(u => u.changes.forEach(c => { u.m[c.key] = c.val; }));
        let photoOk = 0, photoFail = 0;
        for(const p of plan.photos){
          const url = await autoCropResize(p.blob);
          if(url){ p.m.image = url; photoOk++; } else photoFail++;
        }
        renderAll(); validate(); saveDraft();
        toast("已套用:欄位 " + plan.updates.length + " 位、照片 " + photoOk + " 位" +
          (photoFail ? "(" + photoFail + " 張照片讀取失敗)" : "") + ";確認沒問題後記得按「發布到網站」", { duration: 8000 });
      } : null
    );
  }

  /* ---------- 缺資料清單:找出資料不齊的夥伴,產生可直接貼 LINE 的催收訊息 ---------- */
  const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLScgUOftNht1QcyNCq2YGBvnmiYVpPVLqqoRB9Rpfnw-JA7vgQ/viewform";   // 夥伴補資料表單(催收訊息自動附上)
  const SHEET_URL = "";   // Google 名冊試算表網址(建立後填在這裡,工具列會出現「名冊試算表」捷徑)
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
    DATA.forEach(g => g.members.forEach(m => {
      const miss = [];
      if(!m.image) miss.push("形象照");
      if(!(m.card || "").trim()) miss.push("名片圖檔");
      if(!(m.products || []).length) miss.push("商品照片");
      if(!(m.company || "").trim()) miss.push("所屬公司");
      if(!(m.business_items || "").trim()) miss.push("主要營業項目");
      if(!(m.services || []).filter(s => String(s).trim()).length) miss.push("服務項目");
      if(!(m.targets || []).filter(s => String(s).trim()).length) miss.push("適合引薦對象");
      if(!(m.tagline || []).filter(s => String(s).trim()).length) miss.push("宣傳標語");
      if(miss.length){ items.push({ g, m, miss }); miss.forEach(bump); }
    }));
    const total = DATA.reduce((n, g) => n + g.members.length, 0);
    const lines = items.map(it => "・" + it.m.name + "(" + (it.g.code || "?") + "):缺 " + it.miss.join("、"));
    const notice = [
      "【會員名錄・資料補齊通知】",
      "以下夥伴的名錄資料還有缺項,麻煩抽空補上,讓你的頁面更有引薦力 💪",
      FORM_URL ? "補資料表單:" + FORM_URL : "(補資料表單建立後會附上連結)",
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
    byId("s-formcsv-url").value = loadFormCsvUrl();
    byId("settings-modal").hidden = false;
    byId("s-worker-url").focus();
  }
  function closeSettings(){ byId("settings-modal").hidden = true; }
  function saveSettings(){
    const url = byId("s-worker-url").value.trim().replace(/\/+$/, "");
    if(url && !/^https:\/\//.test(url)){ toast("網址需以 https:// 開頭", {warn:true}); return; }
    const formCsv = byId("s-formcsv-url").value.trim();
    if(formCsv && !/^https:\/\//.test(formCsv)){ toast("表單 CSV 網址需以 https:// 開頭", {warn:true}); return; }
    saveFormCsvUrl(formCsv);
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

  /* ---------- Worker 能力偵測 + 發布附件（照片實體檔、分享預覽頁） ----------
     Worker 升級後 /ping 會回 caps.files=true：發布時把內嵌照片轉成 images/ 實體檔、
     並為異動過的成員重生 m/ 分享預覽頁，一併交給 Worker 寫入。
     Worker 未升級時完全維持舊行為（照片內嵌在 data.js 裡）。 */
  const PUB_SITE_BASE = "https://ivanzhong085.github.io/member-directory/";
  let workerCaps = {};
  async function refreshCaps(){
    const res = await workerFetch("/ping");
    workerCaps = (res && res.ok && res.caps) || {};
  }

  function b64EncodeUtf8(str){
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for(let i = 0; i < bytes.length; i += 0x8000){
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function fileSafeId(id){ return String(id).replace(/[^A-Za-z0-9_-]/g, ""); }

  /* 成員分享預覽頁（og 標籤＋跳轉）。內容需與 tools/build-member-pages.mjs 一致，兩邊要同步改。 */
  function memberStubHTML(m, g){
    const descParts = [];
    if((m.services || []).length) descParts.push("服務項目：" + m.services.join("、"));
    if((m.targets || []).length) descParts.push("適合引薦：" + m.targets.join("、"));
    const desc = (descParts.join("；") || "會員名錄成員介紹").slice(0, 150);
    const title = (m.name || "") + "｜" + (m.title || "");
    const img = (m.image && !/^data:/.test(m.image)) ? PUB_SITE_BASE + "images/" + encodeURIComponent(m.image) : PUB_SITE_BASE + "og-image.png";
    const target = "../index.html#/member/" + encodeURIComponent(m.id);
    const pageUrl = PUB_SITE_BASE + "m/" + encodeURIComponent(m.id) + ".html";
    return '<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      "<title>" + esc(title) + "｜會員名錄</title>\n" +
      '<meta name="description" content="' + esc(desc) + '">\n' +
      '<meta name="robots" content="noindex">\n' +
      '<meta property="og:type" content="profile">\n' +
      '<meta property="og:site_name" content="會員名錄">\n' +
      '<meta property="og:title" content="' + esc(title) + '">\n' +
      '<meta property="og:description" content="' + esc(desc) + '">\n' +
      '<meta property="og:url" content="' + esc(pageUrl) + '">\n' +
      '<meta property="og:image" content="' + esc(img) + '">\n' +
      '<meta name="twitter:card" content="summary">\n' +
      '<link rel="canonical" href="' + esc(PUB_SITE_BASE) + "#/member/" + encodeURIComponent(m.id) + '">\n' +
      '<meta http-equiv="refresh" content="0;url=' + esc(target) + '">\n' +
      '<link rel="icon" type="image/svg+xml" href="../favicon.svg">\n' +
      "</head>\n<body>\n" +
      "<script>location.replace(" + JSON.stringify(target) + ");<\/script>\n" +
      '<noscript><p style="font-family:sans-serif;padding:24px;">正在前往 <a href="' + esc(target) + '">' + esc(m.name || "") + " 的介紹頁</a>…</p></noscript>\n" +
      "</body>\n</html>\n";
  }

  function stubSig(m){
    return JSON.stringify([m.name, m.title, m.services, m.targets, /^data:/.test(m.image || "") ? "(inline)" : (m.image || "")]);
  }

  /* 組出這次發布的 data.js 內容與附件清單 */
  function buildPublishPayload(){
    const data = clone(DATA);
    const files = [];
    if(workerCaps.files){
      const base = new Map();
      (typeof GROUPS !== "undefined" ? GROUPS : []).forEach(g => g.members.forEach(m => base.set(m.id, stubSig(m))));
      data.forEach(g => g.members.forEach(m => {
        if(/^data:image\/jpeg;base64,/.test(m.image || "")){
          const fname = fileSafeId(m.id) + "_x.jpg";
          const b64 = (m.image.split(",")[1] || "").trim();
          if(b64){ files.push({ path: "images/" + fname, contentB64: b64 }); m.image = fname; }
        }
        if(/^data:image\/jpeg;base64,/.test(m.card || "")){
          const fname = fileSafeId(m.id) + "_card.jpg";
          const b64 = (m.card.split(",")[1] || "").trim();
          if(b64){ files.push({ path: "images/" + fname, contentB64: b64 }); m.card = fname; }
        }
        (m.products || []).forEach((p, i) => {
          if(/^data:image\/jpeg;base64,/.test(p || "")){
            const fname = fileSafeId(m.id) + "_p" + (i + 1) + ".jpg";
            const b64 = (p.split(",")[1] || "").trim();
            if(b64){ files.push({ path: "images/" + fname, contentB64: b64 }); m.products[i] = fname; }
          }
        });
        if(base.get(m.id) !== stubSig(m)){
          files.push({ path: "m/" + fileSafeId(m.id) + ".html", contentB64: b64EncodeUtf8(memberStubHTML(m, g)) });
        }
      }));
    }
    return { content: serialize(data), files };
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
      const payload = buildPublishPayload();
      const CHUNK = 20;   // 單次請求附件上限（Worker 限 25，留餘裕）；照片多時自動分批
      const chunks = [];
      for(let i = 0; i < payload.files.length; i += CHUNK) chunks.push(payload.files.slice(i, i + CHUNK));
      if(!chunks.length) chunks.push([]);
      let res = { ok:false, error:"network" };
      let sent = 0;
      for(let i = 0; i < chunks.length; i++){
        const isLast = i === chunks.length - 1;
        if(payload.files.length > CHUNK){
          sent += chunks[i].length;
          btn.textContent = "發布中…（檔案 " + sent + "/" + payload.files.length + "）";
        }
        // data.js 一定放在最後一批：附件先全部就位，公開網站才不會指到不存在的照片
        res = await workerFetch("/publish", isLast
          ? { session, content: payload.content, files: chunks[i] }
          : { session, files: chunks[i] });
        if(!res.ok) break;
      }
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
  byId("btn-csv-export").onclick = csvExport;
  byId("btn-csv-import").onclick = () => byId("csv-file").click();
  byId("csv-file").onchange = () => {
    const f = byId("csv-file").files && byId("csv-file").files[0];
    byId("csv-file").value = "";
    if(f) handleCsvFile(f);
  };
  byId("btn-photos").onclick = () => byId("photos-file").click();
  byId("photos-file").onchange = () => {
    const fs = Array.from(byId("photos-file").files || []);
    byId("photos-file").value = "";
    if(fs.length) handlePhotoFiles(fs);
  };
  byId("btn-pull-form").onclick = pullFormResponses;
  byId("btn-missing").onclick = missingReport;
  byId("btn-ppt").onclick = () => byId("ppt-file").click();
  byId("ppt-file").onchange = () => {
    const f = byId("ppt-file").files && byId("ppt-file").files[0];
    byId("ppt-file").value = "";
    if(f) handlePptFile(f);
  };
  if(SHEET_URL && byId("sheet-link")){ byId("sheet-link").href = SHEET_URL; byId("sheet-link").hidden = false; }
  byId("batch-cancel").onclick = closeBatchModal;
  byId("batch-apply").onclick = () => { const fn = batchApplyFn; closeBatchModal(); if(fn) fn(); };
  byId("batch-modal").addEventListener("click", e => { if(e.target.id === "batch-modal") closeBatchModal(); });
  refreshCaps();   // 問一次 Worker 是否支援附件（照片實體檔）；失敗就當不支援，行為同舊版
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
