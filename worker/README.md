# 發布中介服務部署教學（Cloudflare Worker）

這是「密碼登入編輯模式」背後真正保管 GitHub 權杖的地方。任何人打開編輯頁只會跟這個 Worker
交換「密碼」，GitHub 權杖本人永遠留在這裡、不會出現在瀏覽器裡。全程在 Cloudflare 網站上點一點，
**不需要安裝任何軟體、不需要 CLI**。大約 10 分鐘。

## 需要準備的東西

- 一個免費的 Cloudflare 帳號（https://dash.cloudflare.com 註冊即可，不用綁信用卡）。
- 你原本已經建立的 GitHub 權杖（fine-grained token，Contents: Read and write，只授權
  `member-directory` 這個 repo）。
- 一組你想設定的**管理密碼**（給所有操作者日常登入用，跟 GitHub 權杖不同東西）。
- 一組**自己產生的隨機亂碼**（給 Worker 當簽章密鑰用，設定完就不用再記得它）：
  隨手在鍵盤上亂打 **40 個以上**的英文數字混合字元即可，例如打一長串不重複的亂碼。
  ⚠️ 這組亂碼**不可以**抄自任何公開的地方（包括本說明檔的舊版本）、不可以跟別人共用、
  也不要存在任何會被推上 GitHub 的檔案裡——它只該存在 Cloudflare 的 Secret 欄位中。

## 步驟

### 1. 建立 Worker

1. 登入 https://dash.cloudflare.com
2. 左側選單 **Workers & Pages** → **Create** → **Create Worker**
3. 取個名字（例如 `member-directory-relay`），按 **Deploy**（先用預設的 Hello World 部署一次）

### 2. 貼上程式碼

1. 部署完成後按 **Edit code**（或「Configure Worker」→「Edit code」，介面偶爾會改版，找
   「編輯程式碼」相關的按鈕即可）
2. 把整個編輯區清空，貼上這個資料夾裡 **`publish-relay.js`** 的完整內容
3. 按右上角 **Deploy** / **Save and deploy**

### 3. 設定變數（最重要的一步）

到這個 Worker 的 **Settings → Variables and Secrets**：

**加密變數（Secret，選 Encrypt）：**

| 名稱 | 值 |
|---|---|
| `ADMIN_PASSWORD` | 你要設定的管理密碼（跟 GitHub 權杖是兩回事） |
| `SESSION_SECRET` | 你自己亂打的那組 40+ 字元亂碼（不可抄公開範例） |
| `GH_TOKEN` | 你的 GitHub fine-grained 權杖（`github_pat_...` 開頭） |

**一般變數（Plaintext 即可）：**

| 名稱 | 值 |
|---|---|
| `GH_OWNER` | `IvanZhong085` |
| `GH_REPO` | `member-directory` |
| `GH_BRANCH` | `main` |
| `GH_PATH` | `data.js` |
| `ALLOWED_ORIGIN` | `https://ivanzhong085.github.io` |

填完按 **Save and deploy**。

> ⚠️ `ALLOWED_ORIGIN` 一定要填，而且要跟公開網站的網址完全一致（含 `https://`、不要有結尾斜線）。
> 這一項沒填對，瀏覽器會擋下所有請求（安全機制正常運作，只是連不上，不是壞掉）。

### 4. 綁定「錯誤次數限制」用的儲存空間（KV）

還在同一個 Worker 的 Settings 頁：

1. 找到 **Bindings**（可能叫 KV Namespace Bindings）→ **Add binding**
2. **Variable name** 填：`RATE_LIMIT`
3. **KV namespace** 選「Create new」，取個名字（例如 `member-directory-rate-limit`），建立後選它
4. **Save and deploy**

（這一步是用來擋「密碼亂猜」的：同一個來源 15 分鐘內錯 5 次就會被暫時鎖住。）

### 5. 拿到網址、貼進編輯頁

1. 回到 Worker 總覽頁，複製網址（長得像 `https://member-directory-relay.你的帳號.workers.dev`）
2. 打開名錄網站 → 右下角小齒輪 → 「連線設定」→ 貼上網址 → 可以先按「測試連線」確認 ✔ → 儲存
3. 回到登入畫面，輸入你剛才設定的**管理密碼** → 進入編輯模式

完成！之後任何裝置只要知道這組密碼，都可以直接進來編輯。GitHub 權杖從頭到尾沒有出現在任何瀏覽器裡。

## 安全設計的取捨（誠實說明）

- **密碼錯太多次會暫時鎖住**（15 分鐘內錯 5 次），且每次登入都刻意加了一點點延遲，讓大量嘗試密碼變得更慢、更不划算。
- **登入後的「通行證」（session）存在瀏覽器分頁的暫存區**，關掉分頁就消失，最長 30 分鐘要重新輸入密碼一次。這張通行證在有效期內可以用來發布——這是為了操作簡單所做的合理取捨，而不是遺漏。
- Worker 的**程式碼本身**（這個 `publish-relay.js`）沒有任何密碼或權杖，可以放心保留在公開的 repo 裡。真正的機密（密碼、GitHub 權杖、簽章密鑰）只存在 Cloudflare 後台的「Secret」欄位，且該頁面只有登入 Cloudflare 的管理員看得到。

## 之後要做的維護

- **換密碼**：回 Worker 的 Settings 把 `ADMIN_PASSWORD` 改成新的值，Save and deploy 即可，
  不用動編輯頁那邊任何設定。
- **權杖過期或需要換一支**：把新的權杖貼到 `GH_TOKEN`，Save and deploy。
- **忘記密碼**：只有能登入 Cloudflare 的管理員能改 `ADMIN_PASSWORD`——這是刻意設計，避免密碼
  被任何操作者自行更改。
- **免費額度**：Cloudflare Workers 與 Workers KV 都有夠用的免費額度，這個名錄網站的流量遠遠用不完，
  不會產生費用。

---

## 升級：發布時支援附件（照片實體檔）

2026/7 之後的 `publish-relay.js` 支援「附件」：編輯頁發布時，照片會存成 `images/` 實體圖檔（而不是內嵌在 data.js 裡）。成員的分享預覽頁 `m/` 則一律由 GitHub Action 在發布後 1–2 分鐘重建（唯一產生器是 `tools/build-member-pages.mjs`），不走 Worker。

**已經部署過舊版的話，升級只要一步：**

1. 到 Cloudflare 該 Worker → **Edit code** → 全選清空，貼上新版 `publish-relay.js` 完整內容 → **Deploy**。

不需要新增或修改任何變數／Secret。升級後把後台編輯頁重新整理一次，之後照常按「發布到網站」即可（照片較多時會自動分批上傳，按鈕上會顯示進度）。

安全性不變：附件只允許寫入 `images/` 與 `m/` 兩個資料夾、限定副檔名與大小，其他路徑一律拒絕。
