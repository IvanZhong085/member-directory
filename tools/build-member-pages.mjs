#!/usr/bin/env node
/* 產生每位成員的分享預覽頁(m/<id>.html)。
   這些小頁面只做兩件事:給 LINE/FB 爬蟲正確的 og 標籤(姓名、介紹、照片),
   然後把真人導回名錄的成員內頁(index.html#/member/<id>)。

   用法:在 repo 根目錄執行  node tools/build-member-pages.mjs
   注意:名錄成員有增刪時要重跑一次再發布;舊成員的頁面會自動清掉。 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_BASE = "https://ivanzhong085.github.io/member-directory/";
const OUT_DIR = join(ROOT, "m");

const src = readFileSync(join(ROOT, "data.js"), "utf8");
const GROUPS = new Function(src + ";return GROUPS;")();

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ogImage(m){
  // 內嵌 data: 圖片無法當 og:image,退回站台預設圖
  if(m.image && !/^data:/.test(m.image)) return SITE_BASE + "images/" + encodeURIComponent(m.image);
  return SITE_BASE + "og-image.png";
}

function pageHTML(m, g){
  const title = `${m.name}｜${m.title}`;
  const descParts = [];
  if((m.services || []).length) descParts.push("服務項目：" + m.services.join("、"));
  if((m.targets || []).length) descParts.push("適合引薦：" + m.targets.join("、"));
  const desc = (descParts.join("；") || "會員名錄成員介紹").slice(0, 150);
  const target = "../index.html#/member/" + encodeURIComponent(m.id);
  const pageUrl = SITE_BASE + "m/" + encodeURIComponent(m.id) + ".html";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}｜會員名錄</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="會員名錄">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(ogImage(m))}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${esc(SITE_BASE)}#/member/${encodeURIComponent(m.id)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
</head>
<body>
<script>location.replace(${JSON.stringify(target)});</script>
<noscript><p style="font-family:sans-serif;padding:24px;">正在前往 <a href="${esc(target)}">${esc(m.name)} 的介紹頁</a>…</p></noscript>
</body>
</html>
`;
}

mkdirSync(OUT_DIR, { recursive: true });

const wanted = new Set();
let count = 0;
for(const g of GROUPS){
  for(const m of g.members){
    if(!m.id){ console.warn("略過沒有 id 的成員:", m.name); continue; }
    const file = m.id + ".html";
    wanted.add(file);
    writeFileSync(join(OUT_DIR, file), pageHTML(m, g));
    count++;
  }
}

// 清掉已不存在的成員頁,避免刪人之後留下殭屍連結
let removed = 0;
for(const f of readdirSync(OUT_DIR)){
  if(f.endsWith(".html") && !wanted.has(f)){ unlinkSync(join(OUT_DIR, f)); removed++; }
}

console.log(`已產生 ${count} 頁成員分享頁(m/),清除 ${removed} 頁失效頁。`);
