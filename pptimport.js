/* ============================================================
   PPT 匯入解析器 — 會員專業簡報(.pptx)→ 成員資料候選清單
   版型假設(依分會簡報範本,Google Slides 匯出、一頁一位成員):
     編號:頂端置中的純數字
     照片:頁面最大的一張圖(左側直式)
     姓名:上方中帶(x 30–55%、y ≤ 25%)的短文字
     專業別:右上(x > 55%、y ≤ 25%)
     服務項目:中欄上段(x 40–75%、y 20–50%),一段落=一項
     適合引薦對象:中欄下段(x 40–75%、y 50–80%)
     宣傳標語:右下(x > 70%、y > 65%)
     左下角的引薦人姓名(y > 80%)會自動忽略
   依賴:jszip.js
   ============================================================ */
window.PPTImport = (function(){
  "use strict";

  /* 從 shape XML 抓每個「段落」的文字(段內多個 run 直接相連) */
  function paraTexts(shapeXml){
    const out = [];
    const paras = shapeXml.split("<a:p>").slice(1);
    for(const p of paras){
      const runs = [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => decodeXml(m[1]));
      const line = runs.join("").trim();
      if(line) out.push(line);
    }
    return out;
  }
  function decodeXml(s){
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  function firstMatch(re, s){ const m = re.exec(s); return m ? m[1] : null; }

  /* 解析單張投影片 → 候選成員資料(photo 為 zip 內路徑,稍後取 blob) */
  function parseSlide(xml, rels, slideW, slideH){
    const cand = { number: "", name: "", title: "", services: [], targets: [], tagline: [], photoPath: null, unclassified: [] };

    /* 文字 shapes */
    const shapes = xml.split("<p:sp>").slice(1);
    for(const s of shapes){
      const x = parseInt(firstMatch(/<a:off x="(\d+)"/, s) || "-1", 10);
      const y = parseInt(firstMatch(/<a:off [^/]*y="(\d+)"/, s) || "-1", 10);
      const lines = paraTexts(s);
      if(!lines.length || x < 0 || y < 0) continue;
      const px = x / slideW, py = y / slideH;
      const joined = lines.join("");

      if(py < 0.10 && /^\d{1,4}$/.test(joined)){ cand.number = joined; continue; }
      if(py <= 0.25 && px >= 0.30 && px < 0.55 && joined.length <= 8 && !/\d/.test(joined) && lines.length === 1){
        cand.name = joined; continue;
      }
      if(py <= 0.28 && px >= 0.55){ cand.title = joined; continue; }          // 專業別(換行視為排版,併回一行)
      if(px > 0.68 && py > 0.60){ cand.tagline = lines; continue; }           // 標語在右下,要在服務/引薦之前判定
      if(px >= 0.40 && px <= 0.68 && py > 0.20 && py <= 0.50){ cand.services = lines; continue; }
      if(px >= 0.40 && px <= 0.68 && py > 0.50 && py <= 0.80){ cand.targets = lines; continue; }
      if(py > 0.80 && joined.length <= 6){ continue; }                        // 引薦人姓名等,忽略
      cand.unclassified.push(joined.slice(0, 40));
    }

    /* 照片:取面積最大的一張圖 */
    let best = null;
    const pics = xml.split("<p:pic>").slice(1);
    for(const p of pics){
      const embed = firstMatch(/r:embed="([^"]+)"/, p);
      const cx = parseInt(firstMatch(/<a:ext cx="(\d+)"/, p) || "0", 10);
      const cy = parseInt(firstMatch(/<a:ext [^/]*cy="(\d+)"/, p) || "0", 10);
      const area = cx * cy;
      if(embed && rels[embed] && (!best || area > best.area)) best = { area, path: rels[embed] };
    }
    /* 面積至少要佔頁面 8%,才不會抓到 logo 小圖 */
    if(best && best.area >= slideW * slideH * 0.08) cand.photoPath = best.path;
    return cand;
  }

  /* 解析 slideN.xml.rels → { rId: "ppt/media/imageX.ext" } */
  function parseRels(xml){
    const map = {};
    if(!xml) return map;
    for(const m of xml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)){
      map[m[1]] = ("ppt/slides/" + m[2]).replace(/\/slides\/\.\.\//, "/");
    }
    return map;
  }

  /* 主入口:File(.pptx)→ Promise<{slides:[cand...], count}> */
  async function parse(file){
    const zip = await JSZip.loadAsync(file);
    const pres = await (zip.file("ppt/presentation.xml") || { async: () => "" }).async("string");
    const slideW = parseInt((/<p:sldSz cx="(\d+)"/.exec(pres) || [])[1] || "12192000", 10);
    const slideH = parseInt((/<p:sldSz [^/]*cy="(\d+)"/.exec(pres) || [])[1] || "6858000", 10);

    const names = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

    const slides = [];
    for(const n of names){
      const xml = await zip.file(n).async("string");
      const relFile = zip.file(n.replace("slides/", "slides/_rels/") + ".rels");
      const rels = parseRels(relFile ? await relFile.async("string") : "");
      const cand = parseSlide(xml, rels, slideW, slideH);
      cand.slideNo = slides.length + 1;
      /* 照片轉 blob(存在才取) */
      if(cand.photoPath){
        const f = zip.file(cand.photoPath.replace(/^\//, ""));
        cand.photoBlob = f ? await f.async("blob") : null;
      }
      slides.push(cand);
    }
    return { slides, count: slides.length };
  }

  return { parse };
})();
