/* ============================================================
   分享工具模組 — 分享卡(canvas)、QR code、vCard、貼文文案
   被 index.html(成員內頁分享列)與 spotlight.html(聚光燈產生器)共用。
   依賴:data.js(GROUPS)、qrcode.js(QR 產生器,MIT)
   ============================================================ */
window.ShareTools = (function(){
  "use strict";

  /* 站台設定:發布後的正式網址(og 預覽頁、QR、vCard 都以此為準)。
     BRAND_* 會印在分享卡上;若分會想放名稱,改 BRAND_TITLE 即可。 */
  const SITE_BASE   = "https://ivanzhong085.github.io/member-directory/";
  const BRAND_TITLE = "會員名錄";
  const BRAND_SUB   = "MEMBER DIRECTORY";

  const C = {
    red:"#C8102E", redDark:"#A50D26", redDeep:"#7C0A1D",
    red50:"#FDF3F5", red100:"#FAE4E8", red200:"#F3C4CD",
    ink:"#1B1C22", muted:"#6E727E", faint:"#82868F",
    bgSoft:"#F8F8F9", border:"#EAEBEF",
  };
  const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC",sans-serif';

  /* ---------- 小工具 ---------- */
  function lines(arr){ return (arr||[]).map(s => String(s).trim()).filter(Boolean); }
  function shareUrl(m){ return SITE_BASE + "m/" + encodeURIComponent(m.id) + ".html"; }
  function hashUrl(m){ return SITE_BASE + "#/member/" + encodeURIComponent(m.id); }
  function displayUrl(m){ return shareUrl(m).replace(/^https?:\/\//,""); }
  function imgSrc(image){ return /^data:/.test(image) ? image : "images/" + encodeURIComponent(image); }

  function loadImage(src){
    return new Promise((resolve) => {
      if(!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
  }

  /* 逐字換行(中英混排都適用),回傳行陣列;maxLines 超出時最後一行加「…」 */
  function wrapText(ctx, text, maxWidth, maxLines){
    const out = [];
    let line = "";
    for(const ch of String(text)){
      if(ch === "\n"){ out.push(line); line = ""; continue; }
      const test = line + ch;
      if(ctx.measureText(test).width > maxWidth && line){
        out.push(line); line = ch;
      } else line = test;
    }
    if(line) out.push(line);
    if(maxLines && out.length > maxLines){
      const cut = out.slice(0, maxLines);
      cut[maxLines-1] = cut[maxLines-1].replace(/.$/,"") + "…";
      return cut;
    }
    return out;
  }

  function drawCover(ctx, img, x, y, w, h, r){
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w-dw)/2, y + (h-dh)/2, dw, dh);
    ctx.restore();
  }

  /* ---------- QR ---------- */
  function makeQRCanvas(text, px){
    const qr = qrcode(0, "M");   // typeNumber 0 = 自動選擇
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 3;                        // 靜區(模組數)
    const cell = px / (n + quiet*2);
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = C.ink;
    for(let r = 0; r < n; r++){
      for(let col = 0; col < n; col++){
        if(qr.isDark(r, col)){
          ctx.fillRect(quiet*cell + col*cell, quiet*cell + r*cell, Math.ceil(cell)+0.4, Math.ceil(cell)+0.4);
        }
      }
    }
    return c;
  }

  /* ---------- vCard ---------- */
  function vEsc(s){ return String(s||"").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n"); }
  function buildVCard(m){
    const g = m._group || {};
    const note = [
      lines(m.services).length ? "服務項目:" + lines(m.services).join("、") : "",
      lines(m.targets).length ? "適合引薦:" + lines(m.targets).join("、") : "",
      g.code ? "分組:" + g.code + "・" + (g.name||"") : "",
    ].filter(Boolean).join("\n");
    return [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:" + vEsc(m.name) + ";;;;",
      "FN:" + vEsc(m.name),
      m.company ? "ORG:" + vEsc(m.company) : "ORG:" + vEsc(BRAND_TITLE),
      "TITLE:" + vEsc(m.title),
      "URL:" + shareUrl(m),
      note ? "NOTE:" + vEsc(note) : "",
      "END:VCARD",
    ].filter(Boolean).join("\r\n");
  }
  function downloadVCard(m){
    const blob = new Blob([buildVCard(m)], {type:"text/vcard;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (m.name||"member") + ".vcf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- 分享卡(canvas) ---------- */
  async function renderCard(m, format){
    const g = m._group || {};
    const isSquare = format === "square";
    const W = 1080, H = isSquare ? 1080 : 1350;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const M = 72;                              // 外邊距

    /* 底 */
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);
    /* 右上角淡紅光暈、頂部紅條 */
    const glow = ctx.createRadialGradient(W, 0, 60, W, 0, 560);
    glow.addColorStop(0, "rgba(250,228,232,.9)");
    glow.addColorStop(1, "rgba(250,228,232,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(W-620, 0, 620, 620);
    const band = ctx.createLinearGradient(0, 0, W, 0);
    band.addColorStop(0, C.red); band.addColorStop(1, C.redDeep);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, W, 14);

    /* 頁首:品牌 + 分組徽章 */
    let y = 64;
    const markS = 62;
    roundRect(ctx, M, y, markS, markS, 16);
    ctx.fillStyle = band; ctx.fill();
    ctx.fillStyle = "#FFF";
    ctx.font = "800 30px " + FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("會", M + markS/2, y + markS/2 + 2);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.ink;
    ctx.font = "800 34px " + FONT;
    ctx.fillText(BRAND_TITLE, M + markS + 22, y + 30);
    ctx.fillStyle = C.red;
    ctx.font = "700 16px " + FONT;
    const sub = BRAND_SUB.split("").join("  ");
    ctx.fillText(sub, M + markS + 22, y + 56);
    if(g.code){
      ctx.font = "800 26px " + FONT;
      const chipText = g.code + "・" + (g.name||"");
      const tw = ctx.measureText(chipText).width;
      const chipW = tw + 56, chipH = 54;
      const chipX = W - M - chipW, chipY = y + (markS-chipH)/2;
      roundRect(ctx, chipX, chipY, chipW, chipH, 27);
      ctx.fillStyle = C.red50; ctx.fill();
      ctx.strokeStyle = C.red100; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = C.redDark;
      ctx.fillText(chipText, chipX + 28, chipY + 37);
    }
    y += markS + 44;

    /* 照片 */
    const phW = isSquare ? 340 : 430;
    const phH = isSquare ? 375 : 470;
    const phX = (W - phW) / 2;
    const img = m.image ? await loadImage(imgSrc(m.image)) : null;
    ctx.save();
    ctx.shadowColor = "rgba(124,10,29,.22)";
    ctx.shadowBlur = 46; ctx.shadowOffsetY = 18;
    roundRect(ctx, phX, y, phW, phH, 30);
    ctx.fillStyle = "#E8EAEE"; ctx.fill();
    ctx.restore();
    if(img){
      drawCover(ctx, img, phX, y, phW, phH, 30);
    } else {
      const ph = ctx.createLinearGradient(phX, y, phX+phW, y+phH);
      ph.addColorStop(0, C.red100); ph.addColorStop(1, C.red50);
      roundRect(ctx, phX, y, phW, phH, 30);
      ctx.fillStyle = ph; ctx.fill();
      ctx.fillStyle = C.red;
      ctx.font = "900 " + Math.round(phH*.34) + "px " + FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText((m.name||"?").charAt(0), phX + phW/2, y + phH/2);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    if(m.number){
      ctx.font = "800 24px " + FONT;
      const numText = "No." + m.number;
      const nw = ctx.measureText(numText).width + 40;
      roundRect(ctx, phX + 16, y + 16, nw, 46, 12);
      ctx.fillStyle = "#FFF"; ctx.fill();
      ctx.fillStyle = C.red;
      ctx.fillText(numText, phX + 36, y + 48);
    }
    y += phH + (isSquare ? 56 : 76);

    /* 姓名/行業 */
    ctx.textAlign = "center";
    ctx.fillStyle = C.ink;
    ctx.font = "900 " + (isSquare ? 62 : 80) + "px " + FONT;
    ctx.fillText(m.name || "", W/2, y);
    y += isSquare ? 54 : 66;
    ctx.fillStyle = C.red;
    ctx.font = "800 " + (isSquare ? 32 : 40) + "px " + FONT;
    ctx.fillText(m.title || "", W/2, y);
    ctx.textAlign = "left";
    y += isSquare ? 40 : 52;

    /* 標語(紅底圓角框) */
    const tags = lines(m.tagline);
    if(tags.length && !isSquare){
      ctx.font = "600 32px " + FONT;
      const boxLines = [];
      tags.forEach(t => wrapText(ctx, t, 760, 2).forEach(l => boxLines.push(l)));
      const show = boxLines.slice(0, 2);
      const lh = 48, pad = 26;
      const boxW = Math.min(860, Math.max(...show.map(l => ctx.measureText(l).width)) + pad*2 + 40);
      const boxH = show.length*lh + pad*2 - 10;
      const boxX = (W - boxW)/2;
      roundRect(ctx, boxX, y, boxW, boxH, 22);
      ctx.fillStyle = C.red50; ctx.fill();
      ctx.fillStyle = C.redDeep;
      ctx.textAlign = "center";
      show.forEach((l, i) => ctx.fillText("「" + l + "」", W/2, y + pad + 24 + i*lh));
      ctx.textAlign = "left";
      y += boxH + 44;
    } else {
      y += isSquare ? 6 : 10;
    }

    /* 服務項目 / 適合引薦對象(雙欄) */
    const footH = 176;                          // 底部 QR 列高度(含間距)
    const colGap = 44;
    const colW = (W - M*2 - colGap) / 2;
    const colX1 = M, colX2 = M + colW + colGap;
    const maxItems = isSquare ? 3 : 4;
    const itemFont = "500 29px " + FONT, itemLH = 44;

    function drawCol(x, label, items){
      let cy = y;
      ctx.fillStyle = C.red;
      roundRect(ctx, x, cy - 20, 12, 12, 3); ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.font = "800 30px " + FONT;
      ctx.fillText(label, x + 26, cy - 6);
      cy += 34;
      ctx.font = itemFont;
      ctx.fillStyle = C.muted;
      let used = 0;
      for(const it of items.slice(0, maxItems)){
        const ls = wrapText(ctx, it, colW - 34, 2);
        for(const l of ls){
          if(used >= maxItems + 1) return cy;
          ctx.fillStyle = C.red200;
          ctx.fillText("・", x, cy + used*itemLH);
          ctx.fillStyle = "#3A3C45";
          ctx.fillText(l, x + 30, cy + used*itemLH);
          used++;
        }
      }
      return cy + used*itemLH;
    }
    const b1 = drawCol(colX1, "服務項目", lines(m.services));
    const b2 = drawCol(colX2, "適合引薦對象", lines(m.targets));
    y = Math.max(b1, b2);

    /* 底部列:QR + 導引文字(固定貼齊底部) */
    const fy = H - footH - M + 40;
    ctx.strokeStyle = C.border; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, fy - 28); ctx.lineTo(W - M, fy - 28); ctx.stroke();
    const qrS = 150;
    const qr = makeQRCanvas(shareUrl(m), qrS * 3);
    ctx.save();
    roundRect(ctx, W - M - qrS - 14, fy - 8, qrS + 28, qrS + 28, 18);
    ctx.fillStyle = "#FFF"; ctx.fill();
    ctx.strokeStyle = C.border; ctx.stroke();
    ctx.restore();
    ctx.drawImage(qr, W - M - qrS, fy + 6, qrS, qrS);
    ctx.fillStyle = C.ink;
    ctx.font = "800 32px " + FONT;
    ctx.fillText("掃描 QR code,看完整介紹", M, fy + 44);
    ctx.fillStyle = C.faint;
    ctx.font = "500 24px " + FONT;
    ctx.fillText(displayUrl(m), M, fy + 86);
    ctx.fillStyle = C.red;
    ctx.font = "700 22px " + FONT;
    ctx.fillText(BRAND_TITLE + "・" + (g.code ? g.code + "・" + (g.name||"") : BRAND_SUB), M, fy + 128);

    return canvas;
  }

  function downloadCanvas(canvas, filename){
    canvas.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  }

  /* ---------- 貼文文案(模板產生;要更潤飾可用 aiPrompt 丟給 AI) ---------- */
  function bullets(arr, max){ return lines(arr).slice(0, max || 99).map(s => "・" + s).join("\n"); }

  function postText(m, style){
    const g = m._group || {};
    const url = shareUrl(m);
    const tag = lines(m.tagline).join("\n");
    const hashTitle = (m.title||"").replace(/[\s/、,,]/g, "");
    if(style === "pro"){
      return [
        "【夥伴聚光燈】" + m.name + "|" + m.title,
        "",
        (tag ? "「" + lines(m.tagline).join("、") + "」\n" : "") +
        m.name + " 為 " + (g.code||"") + "・" + (g.name||"") + " 成員,主要服務包括" + lines(m.services).join("、") + "。",
        "若您或身邊的朋友屬於:" + lines(m.targets).join("、") + ",歡迎與他聯繫,或透過名錄引薦。",
        "",
        "完整介紹:" + url,
      ].join("\n");
    }
    if(style === "short"){
      return [
        "🌟 本週夥伴聚光燈",
        m.name + "|" + m.title,
        (lines(m.tagline)[0] ? "「" + lines(m.tagline)[0] + "」" : ""),
        "🔧 " + lines(m.services).slice(0,2).join("、"),
        "🎯 歡迎引薦:" + lines(m.targets).slice(0,2).join("、"),
        "👉 " + url,
      ].filter(Boolean).join("\n");
    }
    /* 預設:warm(FB/IG) */
    return [
      "🌟 夥伴聚光燈|" + m.name,
      "",
      (tag ? tag + "\n" : "") +
      "來自 " + (g.code||"") + "・" + (g.name||"") + " 的 " + m.name + ",專注於「" + m.title + "」。",
      "",
      "🔧 可以幫上忙的地方",
      bullets(m.services),
      "",
      "🎯 這樣的朋友,請引薦給他",
      bullets(m.targets),
      "",
      "認識更多好夥伴 👇",
      url,
      "",
      "#夥伴聚光燈 #商務引薦 #" + hashTitle + " #" + m.name,
    ].join("\n");
  }

  function aiPrompt(m){
    const g = m._group || {};
    return [
      "你是台灣商務分會的社群小編,請為以下夥伴寫一篇 Facebook 介紹貼文。",
      "要求:台灣繁體中文、300 字以內、語氣溫暖專業、分段清楚、適量 emoji、最後附上連結與 3 個 hashtag。",
      "重要:只能使用以下提供的資料,不可編造未提供的經歷、數字或頭銜。",
      "",
      "=== 夥伴資料 ===",
      "姓名:" + m.name,
      "行業/職稱:" + m.title,
      "分組:" + (g.code||"") + "・" + (g.name||""),
      "服務項目:" + lines(m.services).join("、"),
      "適合引薦對象:" + lines(m.targets).join("、"),
      "宣傳標語:" + lines(m.tagline).join("、"),
      "個人介紹連結:" + shareUrl(m),
    ].join("\n");
  }

  return {
    SITE_BASE, shareUrl, hashUrl, displayUrl,
    makeQRCanvas, buildVCard, downloadVCard,
    renderCard, downloadCanvas, postText, aiPrompt,
  };
})();
