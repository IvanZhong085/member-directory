/* 夥伴聚光燈產生器 — 選夥伴 → 產出貼文文案 + 分享卡
   依賴:data.js、qrcode.js、sharecard.js */
(function(){
  "use strict";

  const $ = id => document.getElementById(id);
  const groupSel = $("sp-group"), memberSel = $("sp-member");
  const textEl = $("sp-text"), canvasHost = $("sp-canvas");
  const mini = $("sp-mini"), live = $("live-region");

  /* 建索引(與 app.js 相同的 _group/_idx 附掛) */
  const memberIndex = [];
  GROUPS.forEach(g => g.members.forEach((m, i) => {
    m._group = g; m._idx = i; memberIndex.push(m);
  }));
  if(!memberIndex.length) return;

  let cur = memberIndex[0];
  let style = "warm";
  let fmt = "portrait";
  let renderSeq = 0;

  function esc(s){
    return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function imgSrc(image){ return /^data:/.test(image) ? image : "images/" + encodeURIComponent(image); }

  /* ---------- 選單 ---------- */
  function fillGroups(){
    groupSel.innerHTML = GROUPS.map(g =>
      `<option value="${esc(g.id)}">${esc(g.code)}・${esc(g.name)}(${g.members.length})</option>`).join("");
  }
  function fillMembers(g){
    memberSel.innerHTML = g.members.map(m =>
      `<option value="${esc(m.id)}">${esc(m.name)}|${esc(m.title)}</option>`).join("");
  }

  function setCurrent(m, syncSelects){
    cur = m;
    if(syncSelects !== false){
      groupSel.value = m._group.id;
      if(memberSel.options.length === 0 || memberSel.options[0].value.indexOf(m._group.id) !== 0 || !memberSel.querySelector(`option[value="${CSS.escape(m.id)}"]`)){
        fillMembers(m._group);
      }
      memberSel.value = m.id;
    }
    const ph = m.image
      ? `<img src="${esc(imgSrc(m.image))}" alt="">`
      : `<span class="sp-mini-ph">${esc((m.name||"?").charAt(0))}</span>`;
    mini.innerHTML = `${ph}<div><div class="sp-mini-name">${esc(m.name)}</div><div class="sp-mini-title">${esc(m.title)}</div></div>
      <a class="sp-mini-link" href="./#/member/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">內頁 ↗</a>`;
    textEl.value = ShareTools.postText(m, style);
    drawCard();
    if(live) live.textContent = "已選擇 " + m.name;
    try{
      const u = new URL(location.href);
      u.searchParams.set("m", m.id);
      history.replaceState(null, "", u.pathname + "?" + u.searchParams.toString());
    }catch(_){}
  }

  /* ---------- 分享卡預覽 ---------- */
  async function drawCard(){
    const seq = ++renderSeq;
    const c = await ShareTools.renderCard(cur, fmt);
    if(seq !== renderSeq) return;         // 使用者已切到別人,丟棄舊結果
    canvasHost.width = c.width; canvasHost.height = c.height;
    canvasHost.getContext("2d").drawImage(c, 0, 0);
  }

  /* ---------- 複製 ---------- */
  function flash(btn, ok){
    const orig = btn.dataset.orig || (btn.dataset.orig = btn.textContent);
    btn.textContent = ok ? "已複製 ✓" : "複製失敗";
    setTimeout(() => { btn.textContent = orig; }, 1400);
  }
  async function copyText(t, btn){
    try{
      await navigator.clipboard.writeText(t);
      flash(btn, true);
    }catch(_){
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      let ok = false;
      try{ ok = document.execCommand("copy"); }catch(e){}
      ta.remove();
      flash(btn, ok);
    }
  }

  /* ---------- 事件 ---------- */
  groupSel.addEventListener("change", () => {
    const g = GROUPS.find(x => x.id === groupSel.value);
    if(!g) return;
    fillMembers(g);
    setCurrent(g.members[0]);
  });
  memberSel.addEventListener("change", () => {
    const m = memberIndex.find(x => x.id === memberSel.value);
    if(m) setCurrent(m);
  });
  $("sp-prev").addEventListener("click", () => {
    const i = memberIndex.indexOf(cur);
    setCurrent(memberIndex[(i - 1 + memberIndex.length) % memberIndex.length]);
  });
  $("sp-next").addEventListener("click", () => {
    const i = memberIndex.indexOf(cur);
    setCurrent(memberIndex[(i + 1) % memberIndex.length]);
  });
  document.querySelectorAll(".sp-tab[data-style]").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".sp-tab[data-style]").forEach(x => x.classList.toggle("active", x === b));
      style = b.dataset.style;
      textEl.value = ShareTools.postText(cur, style);
    });
  });
  document.querySelectorAll(".sp-fmt").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".sp-fmt").forEach(x => x.classList.toggle("active", x === b));
      fmt = b.dataset.fmt;
      drawCard();
    });
  });
  $("sp-copy").addEventListener("click", e => copyText(textEl.value, e.currentTarget));
  $("sp-copy-ai").addEventListener("click", e => copyText(ShareTools.aiPrompt(cur), e.currentTarget));
  $("sp-download").addEventListener("click", async () => {
    const c = await ShareTools.renderCard(cur, fmt);   // 用原始尺寸重繪,確保輸出不是縮圖
    ShareTools.downloadCanvas(c, "聚光燈_" + (cur.name||"member") + (fmt === "square" ? "_1x1" : "_4x5") + ".png");
  });

  /* ---------- 啟動(支援 ?m=<id> 直接帶入) ---------- */
  fillGroups();
  const qid = new URLSearchParams(location.search).get("m");
  const start = qid ? memberIndex.find(x => x.id === qid) : null;
  fillMembers((start || memberIndex[0])._group);
  setCurrent(start || memberIndex[0]);
})();
