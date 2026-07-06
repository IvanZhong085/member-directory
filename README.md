# 會員名錄網站

純靜態的一頁式會員名錄（白底紅襯色）。公開名錄是**唯讀**的；只有拿到 GitHub 權杖的管理員能發布新增/移除。日常操作很簡單，設計成連小朋友也能上手。

## 檔案結構

```
member-site/            ← 這個資料夾的內容 = 網站根目錄
├─ index.html    公開名錄（總覽 → 分組 → 成員內頁 + 搜尋）
├─ styles.css
├─ app.js
├─ admin.html    編輯頁（改資料、換照片、增刪成員、一鍵發布）
├─ admin.js
├─ data.js       ★ 全部資料都在這一個檔（12 組 / 97 人）
├─ images/       成員照片
├─ README.md
└─ QUALITY-REPORT.md   夜間自評報告（自動更新）
```

---

## 一、部署到 GitHub Pages（設定一次）

1. 在 GitHub 建立一個**新的公開 repo**（例如 `member-directory`）。
2. 把 **`member-site/` 裡面的所有檔案**放到這個 repo 的**根目錄**（讓 `index.html` 在最上層），推上去。
3. repo → **Settings → Pages** → Source 選 **Deploy from a branch** → Branch 選 `main`、資料夾 `/(root)` → Save。
4. 等一下，網站會出現在 `https://<你的帳號>.github.io/<repo 名稱>/`。把這個網址存成書籤。

> 建議用「新的、獨立的公開 repo」，不要和其他專案混在一起。

---

## 二、開啟一鍵發布（設定一次，由大人做）

這一步做完後，之後編輯只要按一顆「發布」按鈕，網站就會自動更新，完全不用碰檔案或 Git 指令。

1. 到 GitHub → 右上頭像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
2. 設定：
   - **Repository access** 選「Only select repositories」→ 只勾**這個名錄的 repo**。
   - **Permissions → Repository permissions → Contents** 設為 **Read and write**。
   - 其他不用動，建立後**複製權杖**（只會顯示一次）。
3. 打開名錄網站 → 點右下角**小齒輪** → 進到編輯頁 → 右上「**⚙ 設定**」，填入：
   - GitHub 帳號、repo 名稱、分支（`main`）、資料檔路徑（`data.js`）
   - 貼上剛剛的**權杖** → 儲存。
4. 完成。權杖只會存在**你這台電腦的瀏覽器**，不會出現在網站原始碼，別人拿不到。

> ⚠️ 權杖等於管理權限，**不要貼給別人、不要放進網頁檔案**。要換人或電腦遺失時，回 GitHub 把該權杖 Revoke（撤銷）即可。

---

## 三、日常怎麼更新（小朋友也會）

1. 打開名錄網站，點右下角**小齒輪**進入編輯頁。
2. 修改：
   - **加人**：上面輸入框打姓名，按 Enter 就新增一位（可連續加）。
   - **刪人／刪組**：成員卡的刪除鈕、左邊分組滑過的 ✕；刪錯了右下角按「**復原**」就回來。
   - **換照片**：成員卡「更換照片」選圖，會自動縮圖，不用另外處理圖片。
   - **複製**：資料相似的人可用「複製」鈕。
3. 改好後，按右上角紅色「**發布到網站**」。
4. 等大約 1 分鐘，公開網站就更新好了 ✔

> 「下載備份」按鈕會存一份 `data.js` 到電腦，當備份用（平常用不到）。

---

## 資料欄位（data.js）

每個分組：`code`（代號）、`name`（名稱）、`leader`（組長）、`members`（成員陣列）。

每位成員：
| 欄位 | 說明 |
|------|------|
| `number` | 編號 |
| `name` | 姓名 |
| `title` | 行業／職稱 |
| `services` | 服務項目（一項一行） |
| `targets` | 適合引薦對象 |
| `tagline` | 宣傳標語 |
| `image` | 照片：檔名或內嵌圖片；空＝無照片 |
| `company` | 所屬公司（預留，待補充） |
| `business_items` | 主要營業項目（預留，待補充） |
| `dataIssue` | `true` 時前台顯示「資料需確認」 |

## 已知資料備註

- **鐘文成**（A1・205）原始投影片沒有照片，顯示「照片待補」。
- **蕭淑芬**（F・000）原始投影片內容與另一位成員重複，已標記 `dataIssue`，待本人確認。
