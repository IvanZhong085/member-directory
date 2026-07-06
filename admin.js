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

  function uid(prefix){
    return prefix + "_" + Date.now().toString(36) + Math.floor(Math.random()*1e5).toString(36);
  }

  /* ---------- draft persistence ---------- */
  function showDraftBanner(on){ draftBanner.classList.toggle("show", !!on); }
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: DATA }));
      saveState.textContent = "已自動儲存 " + new Date().toLocaleTimeString("zh-Hant",{hour:"2-digit",minute:"2-digit"});
      showDraftBanner(true);
    }catch(e){
      saveState.textContent = "⚠ 草稿無法儲存（照片可能過多，請先下載備份）";
    }
  }
  function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); }

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
  function linesToArr(v){ const a = v.split("\n"); while(a.length && a[a.length-1].trim()==="") a.pop(); return a; }

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

  /* ---------- image resize ---------- */
  function fileToResizedDataURL(file, maxW, quality){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let {width:w, height:h} = img;
          if(w > maxW){ h = Math.round(h * maxW / w); w = maxW; }
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          try{ resolve(canvas.toDataURL("image/jpeg", quality)); }
          catch(e){ resolve(reader.result); }
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ---------- render: sidebar ---------- */
  function renderSidebar(){
    glist.innerHTML = DATA.map(g => `
      <div class="gitem ${g.id===selected?"active":""}" data-gid="${esc(g.id)}">
        <span class="gitem-code">${esc(g.code||"?")}</span>
        <span class="gitem-name">${esc(g.name||"（未命名）")}</span>
        <span class="gitem-count">${g.members.length}</span>
        <button class="gitem-del" data-del title="刪除此組" aria-label="刪除 ${esc(g.name||g.code)}">✕</button>
      </div>`).join("") +
      `<button class="gadd-tile" id="gadd-tile" type="button">＋ 新增分組</button>`;
    glist.querySelectorAll(".gitem").forEach(el => {
      el.addEventListener("click", e => {
        if(e.target.closest("[data-del]")) return;
        selected = el.dataset.gid; renderAll();
      });
      const del = el.querySelector("[data-del]");
      del.addEventListener("click", e => { e.stopPropagation(); deleteGroup(groupById(el.dataset.gid)); });
    });
    byId("gadd-tile").onclick = addGroup;
  }

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
            <button class="icon-btn" id="g-up" title="上移" ${gi===0?"disabled":""}>${ICON.up}</button>
            <button class="icon-btn" id="g-down" title="下移" ${gi===DATA.length-1?"disabled":""}>${ICON.down}</button>
            <button class="btn btn-danger btn-sm" id="g-del">${ICON.trash} 刪除整組</button>
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

    // group field bindings
    bindInput("g-code", v => { g.code = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindInput("g-name", v => { g.name = v; renderSidebar(); scheduleSaveAndValidate(); });
    bindInput("g-leader", v => { g.leader = v; scheduleSaveAndValidate(); });
    byId("g-up").onclick = () => moveGroup(gi, -1);
    byId("g-down").onclick = () => moveGroup(gi, 1);
    byId("g-del").onclick = () => deleteGroup(g);
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
    const textFields = ["number","name","title","company","business_items"];
    textFields.forEach(f => {
      const el = card.querySelector('[data-f="'+f+'"]');
      el.addEventListener("input", () => { m[f] = el.value; scheduleSaveAndValidate(); });
    });
    ["services","targets","tagline"].forEach(f => {
      const el = card.querySelector('[data-f="'+f+'"]');
      el.addEventListener("input", () => { m[f] = linesToArr(el.value); scheduleSave(); });
    });
    const chk = card.querySelector('[data-f="dataIssue"]');
    chk.addEventListener("change", () => { m.dataIssue = chk.checked; scheduleSave(); });

    const fileInput = card.querySelector('[data-act="file"]');
    card.querySelector('[data-act="photo"]').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      if(!file) return;
      try{
        toast("處理照片中…");
        m.image = await fileToResizedDataURL(file, 900, 0.82);
        renderMembers(g); saveDraft(); toast("照片已更新，記得最後下載 data.js");
      }catch(e){ toast("照片讀取失敗", {warn:true}); }
      fileInput.value = "";
    };
    card.querySelector('[data-act="rmphoto"]').onclick = () => {
      if(!m.image) return;
      m.image = ""; renderMembers(g); saveDraft();
    };
    card.querySelector('[data-act="up"]').onclick = () => moveMember(g, i, -1);
    card.querySelector('[data-act="down"]').onclick = () => moveMember(g, i, 1);
    card.querySelector('[data-act="dup"]').onclick = () => duplicateMember(g, i);
    card.querySelector('[data-act="del"]').onclick = () => deleteMember(g, i);
  }

  /* ---------- mutations ---------- */
  function moveGroup(i, dir){
    const j = i + dir; if(j<0||j>=DATA.length) return;
    [DATA[i], DATA[j]] = [DATA[j], DATA[i]];
    renderAll(); scheduleSave();
  }
  function deleteGroup(g){
    const idx = DATA.indexOf(g);
    if(idx < 0) return;
    DATA.splice(idx,1);
    if(selected === g.id) selected = DATA.length ? DATA[Math.max(0,idx-1)].id : null;
    renderAll(); scheduleSaveAndValidate();
    toast("已刪除整組「" + (g.name||g.code) + "」（含 " + g.members.length + " 人）", {
      actionLabel:"復原", duration:7000, onAction:() => {
        DATA.splice(Math.min(idx, DATA.length), 0, g);
        selected = g.id; renderAll(); scheduleSaveAndValidate();
      }
    });
  }
  function addGroup(){
    const g = { id: uid("g"), code:"新", name:"新分組", leader:"", room:"", members:[] };
    DATA.push(g); selected = g.id; renderAll(); scheduleSave();
    byId("g-code") && byId("g-code").focus();
    toast("已新增分組，請填代號與名稱");
  }
  function addMember(g, name, opts){
    opts = opts || {};
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
    const removed = g.members[i];
    g.members.splice(i,1);
    renderSidebar(); renderMembers(g); scheduleSaveAndValidate();
    toast("已刪除「" + (removed.name || "未命名") + "」", {
      actionLabel:"復原", duration:6000, onAction:() => {
        g.members.splice(Math.min(i, g.members.length), 0, removed);
        renderSidebar(); renderMembers(g); scheduleSaveAndValidate();
      }
    });
  }
  function moveMember(g, i, dir){
    const j = i + dir; if(j<0||j>=g.members.length) return;
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

  /* ---------- GitHub publish (one-click update to the live site) ---------- */
  const GH_SETTINGS_KEY = "member-directory-gh-settings-v1";
  const GH_TOKEN_ENC_KEY = "member-directory-gh-token-enc-v1";
  const GH_TOKEN_LEGACY_KEY = "member-directory-gh-token-v1";   // old plaintext storage — always removed
  // pre-filled for this deployment so the operator only needs to paste a token once
  const GH_DEFAULTS = { owner: "IvanZhong085", repo: "member-directory", branch: "main", path: "data.js" };
  let memToken = "";   // decrypted token, memory only — gone on reload until password re-entered

  function loadGhSettings(){
    let saved = {};
    try{ saved = JSON.parse(localStorage.getItem(GH_SETTINGS_KEY)) || {}; }catch(e){}
    return Object.assign({}, GH_DEFAULTS, saved);
  }
  function hasEncToken(){ try{ return !!localStorage.getItem(GH_TOKEN_ENC_KEY); }catch(e){ return false; } }
  function base64Utf8(str){
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for(const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  const b64 = {
    enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))),
    dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
  };

  /* password ⇆ token encryption: PBKDF2(SHA-256, 310k) → AES-256-GCM */
  async function deriveKey(password, salt){
    const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name:"PBKDF2", salt, iterations:310000, hash:"SHA-256" },
      raw, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]
    );
  }
  async function encryptToken(token, password){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, new TextEncoder().encode(token));
    localStorage.setItem(GH_TOKEN_ENC_KEY, JSON.stringify({v:1, salt:b64.enc(salt), iv:b64.enc(iv), ct:b64.enc(ct)}));
  }
  async function decryptToken(password){
    const raw = localStorage.getItem(GH_TOKEN_ENC_KEY);
    if(!raw) return null;
    let blob; try{ blob = JSON.parse(raw); }catch(e){ return null; }
    try{
      const key = await deriveKey(password, b64.dec(blob.salt));
      const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv:b64.dec(blob.iv)}, key, b64.dec(blob.ct));
      return new TextDecoder().decode(pt);
    }catch(e){ return null; }   // wrong password → AES-GCM auth fails
  }

  /* ---------- token write-permission check ---------- */
  const FIX_HINT = "修正方式：到 GitHub → Settings → Developer settings → Fine-grained tokens → 點你的權杖進去編輯：「Repository access」選 Only select repositories 並勾選 member-directory；「Permissions → Contents」設為 Read and write → Save。改完不用換權杖，回來按「我修好了，重新檢查」即可。";
  async function checkWriteAccess(token){
    const s = loadGhSettings();
    try{
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`, {
        headers:{ "Authorization":"Bearer "+token, "Accept":"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" }
      });
      if(r.status === 401) return {state:"invalid"};
      if(!r.ok) return {state:"norepo", status:r.status};
      const d = await r.json();
      return { state: (d.permissions && d.permissions.push) ? "ok" : "readonly" };
    }catch(e){ return {state:"network"}; }
  }
  function showPermBanner(msgHtmlSafe){
    byId("perm-banner-text").textContent = msgHtmlSafe;
    byId("perm-banner").hidden = false;
  }
  function hidePermBanner(){ byId("perm-banner").hidden = true; }
  async function runAccessCheck(silentOk){
    if(!memToken) return;
    const res = await checkWriteAccess(memToken);
    if(res.state === "ok"){
      hidePermBanner();
      if(!silentOk) toast("權杖檢查通過，可以正常發布 ✔");
    } else if(res.state === "readonly"){
      showPermBanner("你的權杖「只能讀、不能寫」，按發布會出現權限不足、修改不會真的上線。" + FIX_HINT);
    } else if(res.state === "invalid"){
      showPermBanner("權杖無效或已過期／被撤銷。請重新建立權杖後，用「初次設定／重設」重新貼上。");
    } else if(res.state === "norepo"){
      showPermBanner("權杖看不到這個 repo（HTTP " + res.status + "）。請確認設定裡的帳號與 repo 名稱，以及權杖的 Repository access 有勾選 member-directory。" + FIX_HINT);
    }
    /* network error → 不打擾，發布時自然會再報 */
  }

  /* ---------- lock screen ---------- */
  function showLock(){
    const setUp = hasEncToken();
    byId("lock-lead").textContent = setUp
      ? "輸入管理密碼進入編輯模式。"
      : "此裝置尚未設定管理權限。請管理員按「初次設定」貼上 GitHub 權杖並設定密碼。";
    byId("lock-pass-field").style.display = setUp ? "" : "none";
    byId("lock-enter").style.display = setUp ? "" : "none";
    byId("lock-error").hidden = true;
    byId("lock-overlay").hidden = false;
    if(setUp) byId("lock-pass").focus();
  }
  function hideLock(){ byId("lock-overlay").hidden = true; }
  async function tryUnlock(){
    const pass = byId("lock-pass").value;
    if(!pass) return;
    const btn = byId("lock-enter");
    btn.disabled = true; btn.textContent = "確認中…";
    const tok = await decryptToken(pass);
    btn.disabled = false; btn.textContent = "進入編輯模式";
    if(tok){
      memToken = tok;
      byId("lock-pass").value = "";
      hideLock();
      toast("已進入編輯模式");
      runAccessCheck(true);   // 登入後立即檢查權杖能否寫入，有問題馬上顯示橫幅
    } else {
      byId("lock-error").hidden = false;
      byId("lock-pass").select();
    }
  }

  /* ---------- settings ---------- */
  function openSettings(){
    const s = loadGhSettings();
    byId("s-owner").value = s.owner || "";
    byId("s-repo").value = s.repo || "";
    byId("s-branch").value = s.branch || "";
    byId("s-path").value = s.path || "";
    byId("s-token").value = "";
    byId("s-pass").value = "";
    byId("s-pass2").value = "";
    byId("settings-modal").hidden = false;
    byId("s-owner").focus();
  }
  function closeSettings(){ byId("settings-modal").hidden = true; }
  async function saveSettings(){
    const s = {
      owner: byId("s-owner").value.trim(),
      repo: byId("s-repo").value.trim(),
      branch: byId("s-branch").value.trim() || "main",
      path: byId("s-path").value.trim() || "data.js"
    };
    localStorage.setItem(GH_SETTINGS_KEY, JSON.stringify(s));
    const tok = byId("s-token").value.trim();
    const p1 = byId("s-pass").value;
    const p2 = byId("s-pass2").value;
    const tokenForEncrypt = tok || memToken;   // allow changing password while unlocked without re-pasting token
    if(tok || p1 || p2){
      if(!tokenForEncrypt){ toast("請貼上權杖（或先用密碼解鎖後再改密碼）", {warn:true, duration:5000}); return; }
      if(p1.length < 4){ toast("密碼至少 4 個字", {warn:true}); return; }
      if(p1 !== p2){ toast("兩次密碼不一致", {warn:true}); return; }
      await encryptToken(tokenForEncrypt, p1);
      memToken = tokenForEncrypt;
      hideLock();
      closeSettings();
      toast("設定完成！之後輸入密碼即可進入編輯模式");
      runAccessCheck(true);   // 設定完立即驗證權杖權限
      return;
    }
    closeSettings();
    toast("設定已儲存");
  }
  function clearToken(){
    try{ localStorage.removeItem(GH_TOKEN_ENC_KEY); }catch(e){}
    memToken = "";
    byId("s-token").value = ""; byId("s-pass").value = ""; byId("s-pass2").value = "";
    toast("已清除權杖與密碼（登出）");
  }

  let publishing = false;
  async function publish(){
    if(publishing) return;
    const s = loadGhSettings();
    if(!memToken){
      if(hasEncToken()){ showLock(); toast("請先輸入管理密碼", {warn:true}); }
      else { openSettings(); toast("請先完成初次設定（貼上權杖並設定密碼）", {warn:true, duration:5000}); }
      return;
    }
    const token = memToken;
    if(!s.owner || !s.repo){
      openSettings();
      toast("請先填寫 GitHub 帳號與 repo", {warn:true, duration:4000});
      return;
    }
    validate();
    publishing = true;
    const btn = byId("btn-publish");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.textContent = "發布中…";
    const branch = s.branch || "main";
    const path = (s.path || "data.js").replace(/^\/+/, "");
    const base = `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/` +
      path.split("/").map(encodeURIComponent).join("/");
    const headers = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    try{
      let sha;
      const getRes = await fetch(base + "?ref=" + encodeURIComponent(branch), {headers});
      if(getRes.ok){ sha = (await getRes.json()).sha; }
      else if(getRes.status === 401 || getRes.status === 403){ throw new Error("權杖無效或權限不足，請檢查設定"); }
      else if(getRes.status !== 404){ throw new Error("讀取失敗（" + getRes.status + "）"); }
      const body = { message: "更新會員名錄", content: base64Utf8(serialize()), branch };
      if(sha) body.sha = sha;
      const putRes = await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) });
      if(!putRes.ok){
        let msg = "發布失敗（" + putRes.status + "）";
        if(putRes.status === 401 || putRes.status === 403){
          msg = "權杖沒有寫入權限，這次修改「沒有」上線（放心，草稿都還在）。";
          showPermBanner("你的權杖「只能讀、不能寫」，剛才的發布沒有成功。" + FIX_HINT);
        }
        if(putRes.status === 404) msg = "找不到 repo 或路徑，請檢查設定裡的帳號與 repo 名稱";
        if(putRes.status === 409) msg = "版本衝突，請重新整理頁面後再發布一次";
        throw new Error(msg);
      }
      // published — the live draft now equals what's on GitHub
      clearTimeout(saveTimer);
      try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
      showDraftBanner(false);
      toast("已發布！約 1 分鐘後公開網站就會更新 ✔", {duration:6000});
    }catch(err){
      toast("發布失敗：" + (err && err.message || err), {warn:true, duration:7000});
    }finally{
      publishing = false; btn.disabled = false; btn.innerHTML = orig;
    }
  }

  /* ---------- small utils ---------- */
  function byId(id){ return document.getElementById(id); }
  function cssq(s){ return String(s).replace(/["\\]/g, "\\$&"); }
  function bindInput(id, cb){ const el = byId(id); if(el) el.addEventListener("input", () => cb(el.value)); }
  function scheduleSaveAndValidate(){ scheduleSave(); validate(); }

  function renderAll(){ renderSidebar(); renderMain(); }

  /* ---------- boot ---------- */
  try{ localStorage.removeItem(GH_TOKEN_LEGACY_KEY); }catch(e){}   // never keep plaintext tokens
  tryLoadDraft();
  renderAll();
  validate();
  showDraftBanner(hasDraft);
  saveState.textContent = "就緒";
  showLock();   // password gate: unlock (or first-time setup) before editing

  byId("btn-add-group").onclick = addGroup;
  byId("btn-export").onclick = download;
  byId("btn-publish").onclick = publish;
  byId("btn-settings").onclick = openSettings;
  byId("btn-discard").onclick = discardDraft;
  byId("s-save").onclick = saveSettings;
  byId("s-cancel").onclick = closeSettings;
  byId("s-clear").onclick = clearToken;
  byId("s-test").onclick = async () => {
    const tok = byId("s-token").value.trim() || memToken;
    if(!tok){ toast("請先貼上權杖（或先用密碼解鎖）", {warn:true}); return; }
    const b = byId("s-test"); b.disabled = true; b.textContent = "檢查中…";
    const res = await checkWriteAccess(tok);
    b.disabled = false; b.textContent = "測試權限";
    if(res.state === "ok"){ hidePermBanner(); toast("✔ 權杖可以寫入，發布沒問題"); }
    else if(res.state === "readonly"){ toast("✘ 權杖只能讀、不能寫 — 請照設定視窗下方說明修正", {warn:true, duration:8000}); }
    else if(res.state === "invalid"){ toast("✘ 權杖無效或已過期", {warn:true, duration:6000}); }
    else if(res.state === "norepo"){ toast("✘ 權杖看不到這個 repo（檢查帳號/repo 名稱與 Repository access）", {warn:true, duration:8000}); }
    else { toast("網路問題，稍後再試", {warn:true}); }
  };
  byId("perm-recheck").onclick = () => runAccessCheck(false);
  byId("lock-enter").onclick = tryUnlock;
  byId("lock-pass").addEventListener("keydown", e => { if(e.key === "Enter") tryUnlock(); });
  byId("lock-setup").onclick = () => { openSettings(); };
  byId("settings-modal").addEventListener("click", e => { if(e.target.id === "settings-modal") closeSettings(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && !byId("settings-modal").hidden) closeSettings(); });

  window.addEventListener("beforeunload", saveDraft);
})();
