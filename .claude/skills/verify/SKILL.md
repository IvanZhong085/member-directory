---
name: verify
description: 在本機跑起會員名錄網站並用瀏覽器實測(純靜態站,無建置步驟)
---

# 驗證會員名錄網站

純靜態站,無需 build。啟動:

```bash
python3 -m http.server 8899 --bind 127.0.0.1   # 在 repo 根目錄執行
```

用 Playwright + 預裝 Chromium(`executablePath: '/opt/pw-browsers/chromium'`)驅動,值得驅動的路徑:

- `index.html#/member/g3_m1` — 成員內頁 + 分享列(複製連結/QR/vCard/原生分享)
- `spotlight.html?m=<id>` — 聚光燈產生器(三種文案、AI 提示詞、4:5 與 1:1 分享卡下載)
- `m/<id>.html` — og 預覽頁,真人開啟應跳回 `index.html#/member/<id>`

注意事項:

- 剪貼簿測試要在 context 給 `permissions: ["clipboard-read","clipboard-write"]`。
- 分享卡 QR 別只看圖,用 `jsqr` + `pngjs` 解碼下載的 PNG 確認網址正確。
- 邊界成員:`g3_m7`(照片是 data: URL)、`g3_m1`/`g3_m4`(dataIssue 警示帶)。
- 名錄增刪成員後要重跑 `node tools/build-member-pages.mjs`(m/ 頁面才會同步)。
- 發布用的 Cloudflare Worker(admin 發布、瀏覽數)在本機測不到,靜默失敗屬正常。
