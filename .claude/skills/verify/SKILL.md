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

後台(admin.html)驗證:

- 密碼鎖只是 UI 閘門,測試時 `document.getElementById("lock-overlay").hidden = true` + 寫入 sessionStorage `member-directory-session-v1` 即可操作。
- Worker 用 `page.route("https://member-directory-relay.retetrhjj123.workers.dev/**")` 攔截模擬:/ping 回 `caps:{files:true}` 可測附件發布管線,/publish 收到的 payload 直接斷言。
- 套用結果從 localStorage 草稿(`member-directory-draft-v1`)讀出來驗,DATA 在 IIFE 裡拿不到。
- Worker 本體可在 Node 直接 import(改名 .mjs),stub globalThis.fetch 假裝 GitHub API 來驗路由與順序。

環境陷阱:

- 容器 LANG 為空,Playwright `setInputFiles` 會丟棄中文檔名的檔案——改在頁面內用 `DataTransfer` + `new File()` 合成中文檔名再 dispatch change 事件。
- 殺本機伺服器用 `fuser -k 8899/tcp`;`pkill -f` 的樣式會匹配到自己這條指令而自殺(exit 144)。
