(function(){
  "use strict";

  const app = document.getElementById("app");
  const searchInput = document.getElementById("search-input");
  const searchClear = document.getElementById("search-clear");
  const liveRegion = document.getElementById("live-region");
  const dirNav = document.getElementById("dir-nav");
  const dirToggle = document.getElementById("dir-toggle");
  const dirCollapse = document.getElementById("dir-collapse");
  const dirClose = document.getElementById("dir-close");
  const dirBackdrop = document.getElementById("dir-backdrop");

  /* 訪客瀏覽計數：透過自家 Cloudflare Worker 的 /views（公開、免密碼）累計。
     網址非機密，與 admin.js 相同。Worker 尚未更新到有 /views 時會靜默失敗、不顯示計數。 */
  const WORKER_URL = "https://member-directory-relay.retetrhjj123.workers.dev";
  let siteViews = "pending";   // "pending" | number | "failed"
  function fmtNum(n){ return Number(n||0).toLocaleString("en-US"); }
  async function bumpView(scope, id){
    if(!WORKER_URL) return null;
    try{
      const res = await fetch(WORKER_URL.replace(/\/+$/,"") + "/views", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(id ? { scope, id } : { scope }),
      });
      const data = await res.json().catch(() => ({}));
      if(data && data.ok && typeof data.count === "number") return data.count;
    }catch(e){ /* 離線或 Worker 尚未更新：安靜略過 */ }
    return null;
  }
  function updateSiteViewsUI(){
    const el = document.getElementById("stat-views");
    if(!el) return;
    if(typeof siteViews === "number"){
      const num = el.querySelector(".stat-num");
      if(num) num.textContent = fmtNum(siteViews);
    } else if(siteViews === "failed"){
      el.remove();   // Worker 沒回應就把這格移掉，不留一個「…」
    }
  }

  /* ---------- data indexes ---------- */
  const byId = new Map();
  const memberIndex = [];
  GROUPS.forEach(g => {
    byId.set(g.id, g);
    g.members.forEach((m, i) => {
      m._group = g;
      m._idx = i;
      // precomputed search haystack: name, title, number, group, services, targets, tagline
      m._haystack = [m.name, m.title, m.number, g.code, g.name,
        (m.services||[]).join(" "), (m.targets||[]).join(" "), (m.tagline||[]).join(" ")
      ].join(" ").toLowerCase();
      memberIndex.push(m);
    });
  });
  const TOTAL_MEMBERS = memberIndex.length;

  /* ---------- helpers ---------- */
  function esc(s){
    return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function joinLines(arr){ return (arr||[]).join("\n").replace(/\u000B/g, "\n"); }
  function safeDecode(s){ try { return decodeURIComponent(s); } catch(_){ return s; } }
  function isSearchHash(h){ return (h||"").startsWith("#/search/"); }
  function scrollTop(){ window.scrollTo({top:0, left:0, behavior:"instant"}); }
  /* photos may be a filename (images/…) or an inline data: URL from the editor */
  function imgSrc(image){
    return /^data:/.test(image) ? image : "images/" + encodeURIComponent(image);
  }

  /* ---------- inline SVG icons (Lucide) ---------- */
  const I = {
    chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    arrowL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
    arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>',
    tags: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/><path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="6.5" cy="9.5" r=".5" fill="currentColor"/></svg>',
    quote: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  function photoCard(m){
    if(m.image){
      return `<div class="member-photo-wrap">
        <img class="member-photo" src="${esc(imgSrc(m.image))}" alt="${esc(m.name)} 的照片" loading="lazy">
        <span class="member-num-tag">No.${esc(m.number)}</span>
      </div>`;
    }
    return `<div class="member-photo-wrap">
      <div class="member-photo-none">${I.camera}<span>照片待補</span></div>
      <span class="member-num-tag">No.${esc(m.number)}</span>
    </div>`;
  }

  function memberCardHTML(m, i, showGroup){
    const sub = showGroup ? `${esc(m.title)} · ${esc(m._group.code)} ${esc(m._group.name)}` : esc(m.title);
    return `
      <a class="member-card anim" style="--i:${Math.min(i,14)}" href="#/member/${encodeURIComponent(m.id)}" aria-label="${esc(m.name)}，${esc(m.title)}">
        ${photoCard(m)}
        <div class="member-info">
          <div class="member-name">${esc(m.name)}</div>
          <div class="member-title">${sub}</div>
        </div>
      </a>`;
  }

  /* ---------- directory sidebar (persistent group nav) ---------- */
  function buildSidebar(){
    if(!dirNav) return;
    let html = `<a class="dir-item dir-item-home" href="#/" data-gid="">
        <span class="dir-code dir-code-home">${I.grid}</span>
        <span class="dir-label"><span class="dir-name">總覽首頁</span></span>
      </a>`;
    GROUPS.forEach(g => {
      html += `<a class="dir-item" href="#/group/${encodeURIComponent(g.id)}" data-gid="${esc(g.id)}" title="${esc(g.code)}・${esc(g.name)}">
        <span class="dir-code">${esc(g.code)}</span>
        <span class="dir-label"><span class="dir-name">${esc(g.name)}</span></span>
        <span class="dir-count">${g.members.length}</span>
      </a>`;
    });
    dirNav.innerHTML = html;
  }
  function setActiveGroup(gid){
    if(!dirNav) return;
    let activeEl = null;
    dirNav.querySelectorAll(".dir-item").forEach(el => {
      const on = el.getAttribute("data-gid") === gid;
      el.classList.toggle("active", on);
      if(on){ el.setAttribute("aria-current", "true"); activeEl = el; }
      else el.removeAttribute("aria-current");
    });
    return activeEl;
  }

  /* ---------- drawer / collapse controls ---------- */
  const COLLAPSE_KEY = "memberdir_dir_collapsed";
  function openDrawer(){
    document.body.classList.add("dir-open");
    if(dirBackdrop) dirBackdrop.hidden = false;
    if(dirToggle) dirToggle.setAttribute("aria-expanded", "true");
  }
  function closeDrawer(){
    if(!document.body.classList.contains("dir-open")) return;
    document.body.classList.remove("dir-open");
    if(dirBackdrop) dirBackdrop.hidden = true;
    if(dirToggle) dirToggle.setAttribute("aria-expanded", "false");
  }

  /* ---------- router ----------
     Search is a real route (#/search/關鍵字) written with history.replaceState,
     so the browser Back button can return to (or leave) search results cleanly. */
  let prevHash = "#/";
  let searchTimer = null;

  /* 記住每個頁面離開時的捲動位置：按上一頁/下一頁回來時還原原位，
     點站內連結前進則清掉目的地的紀錄、從頁首開始。 */
  const scrollMem = new Map();
  let curHash = location.hash || "#/";
  window.addEventListener("scroll", () => { scrollMem.set(curHash, window.scrollY); }, {passive:true});
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest('a[href^="#/"]');
    if(a) scrollMem.delete(a.getAttribute("href"));
  });

  function render(){
    const hash = location.hash || "#/";
    curHash = hash;
    if(isSearchHash(hash) && safeDecode(hash.slice(9)).trim()){
      const q = safeDecode(hash.slice(9));
      if(searchInput.value.trim() !== q.trim()) searchInput.value = q;
      searchClear.hidden = !q;
      renderSearch(q);
      setActiveGroup(null);
    } else if(hash.startsWith("#/group/")){
      syncSearchCleared();
      const gid = safeDecode(hash.slice(8));
      renderGroup(gid);
      setActiveGroup(byId.has(gid) ? gid : null);
    } else if(hash.startsWith("#/member/")){
      syncSearchCleared();
      const mid = safeDecode(hash.slice(9));
      renderMember(mid);
      const mm = memberIndex.find(x => x.id === mid);
      setActiveGroup(mm ? mm._group.id : null);
    } else {
      syncSearchCleared();
      renderHome();
      setActiveGroup("");
    }
    const saved = scrollMem.get(hash);
    if(saved !== undefined) window.scrollTo({top:saved, left:0, behavior:"instant"});
    else scrollTop();
  }

  function syncSearchCleared(){
    if(searchInput.value){ searchInput.value = ""; }
    searchClear.hidden = true;
  }

  /* ---------- views ---------- */
  function renderHome(){
    let html = `
      <section class="hero">
        <svg class="hero-deco" viewBox="0 0 300 300" fill="none" aria-hidden="true">
          <circle cx="190" cy="110" r="100" stroke="var(--red-100)" stroke-width="2"/>
          <circle cx="190" cy="110" r="70" stroke="var(--red-200)" stroke-width="2"/>
          <circle cx="190" cy="110" r="40" stroke="var(--red-100)" stroke-width="2"/>
          <circle cx="260" cy="60" r="8" fill="var(--red)"/>
          <circle cx="120" cy="180" r="5" fill="var(--red-200)"/>
        </svg>
        <div class="hero-eyebrow anim" style="--i:0">Member Directory</div>
        <h1 class="anim" style="--i:1">會員<span class="accent">名錄</span></h1>
        <p class="hero-sub anim" style="--i:2">依專業分組瀏覽每一位成員的照片、專業項目與引薦資訊，點進個人頁面查看完整介紹。</p>
        <div class="hero-stats anim" style="--i:3">
          <div class="stat"><div class="stat-num">${GROUPS.length}</div><div class="stat-label">專業分組</div></div>
          <div class="stat"><div class="stat-num">${TOTAL_MEMBERS}</div><div class="stat-label">位成員</div></div>
          ${siteViews === "failed" ? "" : `<div class="stat" id="stat-views"><div class="stat-num">${typeof siteViews === "number" ? fmtNum(siteViews) : "…"}</div><div class="stat-label">累計瀏覽</div></div>`}
        </div>
      </section>
      <div class="section-head">
        <h2 class="section-title"><span class="dot" aria-hidden="true"></span>專業分組</h2>
        <span class="section-count">${GROUPS.length} 組</span>
      </div>
      <div class="grid-groups">`;
    GROUPS.forEach((g, i) => {
      const withPhoto = g.members.filter(m => m.image).slice(0,4);
      const rest = g.members.length - withPhoto.length;
      const stack = withPhoto.map(m =>
        `<img src="${esc(imgSrc(m.image))}" alt="" loading="lazy">`
      ).join("") + (rest > 0 ? `<span class="avatar-more">+${rest}</span>` : "");
      html += `
        <a class="group-card anim" style="--i:${Math.min(i,12)}" href="#/group/${encodeURIComponent(g.id)}" aria-label="${esc(g.code)} ${esc(g.name)}，共 ${g.members.length} 位成員">
          <div class="group-card-top">
            <span class="group-code">${esc(g.code)}</span>
            <span class="group-top-right">
              <span class="group-count-face">${g.members.length} 位成員</span>
              <span class="group-arrow">${I.chevR}</span>
            </span>
          </div>
          <div class="group-name">${esc(g.name)}</div>
          <div class="group-meta">
            <span class="group-leader">${I.crown} 組長 ${esc(g.leader||"—")}</span>
            <span class="avatar-stack" aria-hidden="true">${stack}</span>
          </div>
        </a>`;
    });
    html += `</div>`;
    app.innerHTML = html;
  }

  function renderGroup(gid){
    const g = byId.get(gid);
    if(!g){ return renderNotFound("找不到這個分組"); }
    let html = `
      <div class="page-top">
        <nav class="breadcrumb" aria-label="路徑">
          <a href="#/">總覽</a>
          ${I.chevR}
          <span class="current">${esc(g.code)}・${esc(g.name)}</span>
        </nav>
        <div class="group-hero">
          <div class="group-hero-code" aria-hidden="true">${esc(g.code)}</div>
          <div class="group-hero-info">
            <h1>${esc(g.name)}</h1>
            <div class="group-hero-meta">
              <span class="meta-chip">${I.crown} 組長 ${esc(g.leader||"—")}</span>
              <span class="meta-chip">${I.users} ${g.members.length} 位成員</span>
            </div>
          </div>
        </div>
      </div>
      <div class="grid-members">`;
    g.members.forEach((m, i) => { html += memberCardHTML(m, i, false); });
    html += `</div>`;
    app.innerHTML = html;
  }

  function renderMember(mid){
    const m = memberIndex.find(x => x.id === mid);
    if(!m){ return renderNotFound("找不到這位成員"); }
    const g = m._group;
    const prev = g.members[m._idx - 1] || null;
    const next = g.members[m._idx + 1] || null;

    const photo = m.image
      ? `<div class="detail-photo-wrap"><img class="detail-photo" src="${esc(imgSrc(m.image))}" alt="${esc(m.name)} 的照片"></div>`
      : `<div class="detail-photo-wrap"><div class="detail-photo-none">${I.camera}<span>照片待補</span></div></div>`;

    function navCard(target, isNext){
      if(!target) return `<div class="dnav empty" aria-hidden="true"></div>`;
      const ph = target.image
        ? `<img class="dnav-photo" src="${esc(imgSrc(target.image))}" alt="" loading="lazy">`
        : `<span class="dnav-photo"></span>`;
      return `
        <a class="dnav ${isNext ? "next" : ""}" href="#/member/${encodeURIComponent(target.id)}">
          <span class="dnav-arrow">${isNext ? I.arrowR : I.arrowL}</span>
          ${ph}
          <span class="dnav-text">
            <div class="dnav-label">${isNext ? "下一位" : "上一位"}</div>
            <div class="dnav-name">${esc(target.name)}</div>
          </span>
        </a>`;
    }

    const html = `
      <div class="page-top">
        <nav class="breadcrumb" aria-label="路徑">
          <a href="#/">總覽</a>
          ${I.chevR}
          <a href="#/group/${encodeURIComponent(g.id)}">${esc(g.code)}・${esc(g.name)}</a>
          ${I.chevR}
          <span class="current">${esc(m.name)}</span>
        </nav>
      </div>
      <article class="detail-card anim">
        <div class="detail-hero">
          ${photo}
          <div class="detail-main">
            <div class="detail-badges">
              <span class="badge badge-group">${I.users} ${esc(g.code)}・${esc(g.name)}</span>
              <span class="badge badge-num">編號 ${esc(m.number)}</span>
            </div>
            <h1 class="detail-name">${esc(m.name)}</h1>
            <div class="detail-title">${esc(m.title)}</div>
            ${m.tagline && m.tagline.length ? `<div class="detail-tagline">${I.quote}${esc(joinLines(m.tagline))}</div>` : ""}
          </div>
        </div>
        ${m.dataIssue ? `<div class="issue-banner">${I.alert}<span>原始投影片此頁內容與另一位成員重複，以下「服務項目／適合引薦對象」可能有誤，待向本人確認後更新。</span></div>` : ""}
        <div class="detail-body">
          <div class="info-card">
            <div class="info-head"><span class="info-icon">${I.briefcase}</span><span class="info-label">服務項目</span></div>
            <div class="info-text">${esc(joinLines(m.services)) || "—"}</div>
          </div>
          <div class="info-card">
            <div class="info-head"><span class="info-icon">${I.target}</span><span class="info-label">適合引薦對象</span></div>
            <div class="info-text">${esc(joinLines(m.targets)) || "—"}</div>
          </div>
          <div class="info-card placeholder">
            <div class="info-head"><span class="info-icon">${I.building}</span><span class="info-label">所屬公司</span><span class="pending-chip">待補充</span></div>
            <div class="info-text">${esc(m.company) || "資料尚未提供，補充後將顯示於此。"}</div>
          </div>
          <div class="info-card placeholder">
            <div class="info-head"><span class="info-icon">${I.tags}</span><span class="info-label">主要營業項目</span><span class="pending-chip">待補充</span></div>
            <div class="info-text">${esc(m.business_items) || "資料尚未提供，補充後將顯示於此。"}</div>
          </div>
        </div>
        <div class="detail-views" id="detail-views" hidden>${I.eye}<span>本頁已被瀏覽 <b>—</b> 次</span></div>
      </article>
      <nav class="detail-nav" aria-label="同組成員導覽">
        ${navCard(prev, false)}
        ${navCard(next, true)}
      </nav>`;
    app.innerHTML = html;

    // 計入這位成員的瀏覽數；回來後若已離開此頁就不更新（避免把數字寫到別人頁上）
    const targetHash = "#/member/" + encodeURIComponent(m.id);
    bumpView("member", m.id).then(n => {
      if(location.hash !== targetHash) return;
      const vEl = document.getElementById("detail-views");
      if(!vEl) return;
      if(n == null){ vEl.remove(); return; }
      const b = vEl.querySelector("b"); if(b) b.textContent = fmtNum(n);
      vEl.hidden = false;
    });
  }

  function renderSearch(q){
    const query = q.trim().toLowerCase();
    const results = memberIndex.filter(m => m._haystack.includes(query));
    if(liveRegion) liveRegion.textContent = `搜尋「${q}」，共 ${results.length} 筆結果`;
    let html = `
      <div class="result-head">
        <div class="result-title">「<span class="q">${esc(q)}</span>」的搜尋結果</div>
        <div class="result-sub">共 ${results.length} 筆</div>
      </div>`;
    if(results.length === 0){
      html += `
        <div class="empty-state">
          ${I.search}
          <p>沒有符合的成員</p>
          <div class="hint">試試姓名、行業關鍵字或成員編號</div>
        </div>`;
    } else {
      html += `<div class="grid-members">`;
      results.forEach((m, i) => { html += memberCardHTML(m, i, true); });
      html += `</div>`;
    }
    app.innerHTML = html;
  }

  function renderNotFound(msg){
    app.innerHTML = `
      <div class="empty-state" style="padding-top:90px;">
        ${I.search}
        <p>${esc(msg)}</p>
        <div class="hint"><a class="back-btn" style="margin-top:14px;" href="#/">${I.arrowL} 回到總覽</a></div>
      </div>`;
  }

  /* ---------- search wiring ---------- */
  function commitSearch(){
    const q = searchInput.value;                 // live value, never a stale capture
    if(q.trim()){
      if(!isSearchHash(location.hash)) prevHash = location.hash || "#/";
      history.replaceState(null, "", "#/search/" + encodeURIComponent(q.trim()));
      renderSearch(q.trim());
      scrollTop();
    } else {
      exitSearch(false);
    }
  }
  function exitSearch(refocus){
    clearTimeout(searchTimer);
    searchInput.value = "";
    searchClear.hidden = true;
    if(isSearchHash(location.hash)) history.replaceState(null, "", prevHash || "#/");
    render();
    if(refocus) searchInput.focus();
  }

  searchInput.addEventListener("input", () => {
    searchClear.hidden = !searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(commitSearch, 140);
  });
  searchClear.addEventListener("click", () => exitSearch(true));
  searchInput.addEventListener("keydown", e => { if(e.key === "Escape") exitSearch(true); });

  /* ---------- navigation wiring ---------- */
  window.addEventListener("hashchange", () => {
    clearTimeout(searchTimer);
    const hash = location.hash || "#/";
    if(!isSearchHash(hash)) prevHash = hash;
    closeDrawer();
    render();
    app.focus({preventScroll:true});   // move focus to fresh content for keyboard/SR users
  });

  const skipLink = document.querySelector(".skip-link");
  if(skipLink){
    skipLink.addEventListener("click", e => { e.preventDefault(); app.focus(); });
  }

  /* ---------- sidebar / drawer wiring ---------- */
  buildSidebar();

  try { if(localStorage.getItem(COLLAPSE_KEY) === "1") document.body.classList.add("dir-collapsed"); } catch(_){}

  if(dirToggle) dirToggle.addEventListener("click", () => {
    document.body.classList.contains("dir-open") ? closeDrawer() : openDrawer();
  });
  if(dirBackdrop) dirBackdrop.addEventListener("click", closeDrawer);
  if(dirClose) dirClose.addEventListener("click", closeDrawer);
  if(dirNav) dirNav.addEventListener("click", e => {
    if(e.target.closest(".dir-item")) closeDrawer();   // picking a group closes the mobile drawer
  });
  if(dirCollapse) dirCollapse.addEventListener("click", () => {
    const c = document.body.classList.toggle("dir-collapsed");
    try { localStorage.setItem(COLLAPSE_KEY, c ? "1" : "0"); } catch(_){}
    dirCollapse.setAttribute("aria-label", c ? "展開分組列" : "縮小分組列");
    dirCollapse.setAttribute("title", c ? "展開分組列" : "縮小分組列");
  });
  document.addEventListener("keydown", e => { if(e.key === "Escape") closeDrawer(); });
  // leaving mobile widths must dismiss the drawer so its backdrop never lingers on desktop
  const mqDesktop = window.matchMedia("(min-width:901px)");
  (mqDesktop.addEventListener ? mqDesktop.addEventListener.bind(mqDesktop, "change")
    : mqDesktop.addListener.bind(mqDesktop))(e => { if(e.matches) closeDrawer(); });

  if(!isSearchHash(location.hash)) prevHash = location.hash || "#/";
  render();

  // 全站瀏覽量：每次開啟網站累計一次（Worker 尚未支援 /views 時靜默隱藏此格）
  bumpView("site").then(n => { siteViews = (n == null ? "failed" : n); updateSiteViewsUI(); });
})();
