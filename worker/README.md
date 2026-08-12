# 發布中介服務部署教學（Cloudflare Worker）

這是「密碼登入編輯模式」背後真正保管 GitHub 權杖的地方。任何人打開編輯頁只會跟這個 Worker
交換「密碼」，GitHub 權杖本人永遠留在這裡、不會出現在瀏覽器裡。全程在 Cloudflare 網站上點一點，
**不需要安裝任何軟體、不需要 CLI**。大約 10 分鐘。

## 需要準備的東西

- 一個免費的 Cloudflare 帳號（https://dash.cloudflare.com 註冊即可，不用綁信用卡）。
- 你原本已經建立的 GitHub 權杖（fine-grained token，Contents: Read and write，只授權
  `member-directory` 這個 repo）。
- 一份**管理帳號密碼表**（給操作者日常登入用，跟 GitHub 權杖不同東西；可以開多組給不同的人）。
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
| `ADMIN_USERS` | 帳號密碼表（JSON，格式見下方「管理帳號」一節） |
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

### 3-1. 管理帳號（`ADMIN_USERS`）

後台是**帳號＋密碼**登入，分三種角色：

| 角色 | 看得到 | 能做 |
|---|---|---|
| **總管理員** `owner` | 全會 12 組 | 全部功能：連線設定、增刪分組、編輯任何人 |
| **組長** `leader` | **只有自己那一組** | 編輯本組成員與照片、改組長姓名與招募席位、匯出 CSV、下載備份、缺資料清單、發布 |
| **唯讀** `viewer` | 全會 12 組 | **只能看與匯出**：匯出 CSV、下載備份、缺資料清單、聚光燈產生器、產業小組表。改不了任何資料，也不能發布 |

組長**看不到也改不到**別組；組別代號與分組名稱為唯讀（代號是他自己的綁定鍵，改了會把自己鎖在外面）。

唯讀帳號適合給「需要拿資料做圖、做表，但不該改到名錄」的人共用。它連編輯表單都不會被渲染出來，待認領區也不顯示（認領＝在某一組建一張成員卡，是編輯行為）。

`ADMIN_USERS` 的值是一段 JSON，一個人一組。總管理員可以直接寫密碼字串，組長與唯讀要用物件指定角色：

```json
{
  "ivan": "總管理員的密碼",
  "主席": {"password":"密碼","role":"owner","note":"九長，編輯權限全開"},
  "a1": {"password":"密碼","role":"leader","group":"A1","note":"曾俊凱"},
  "a2": {"password":"密碼","role":"leader","group":"A2","note":"鍾宇軒"},
  "123": {"password":"密碼","role":"viewer","note":"通用後台，只能看與匯出"}
}
```

- `group` 要填 **`data.js` 裡該組的「組別代號」**（A1、B2、C…），不是組名。只有 `leader` 需要。
- `note` 是給你自己看的備註（記錄現任是誰），程式不會用到，換人時改這裡就好。
- 組長換人時：改該帳號的 `password` 與 `note` 即可，帳號本身不用動。
- **`role` 寫 `leader` 卻沒填合法 `group` 的帳號一律不生效**，不會變成隱形的總管理員。
- **`role` 只認得 `owner` / `leader` / `viewer` 三個字**（大小寫與前後空白會自動忽略）。打成別的字（例如 `readonly`、`editor`）那個帳號**整筆不生效**，登不進來——這是刻意的：寧可讓人發現登不進去，也不要讓一個本來要唯讀的帳號安靜地變成總管理員。
- `role` 留空或不寫 = `owner`（舊設定沿用得下去）。

- **要新增一個人**：在大括號裡加一組 `,"新帳號":"新密碼"` → Save and deploy。
- **要刪掉一個人**：把那一組整段刪掉（連同前面的逗號）→ Save and deploy。對方的登入會立刻失效。
- **要改某人密碼**：改冒號後面那串 → Save and deploy。

注意事項：

- **帳號不分大小寫**（`Ivan` 和 `ivan` 是同一人），**密碼分大小寫**。
- 帳號可以用中文，但不能有空白。
- 每個人請用**不同密碼**——commit 紀錄是靠帳號辨識誰發布的。
- 這是 JSON，所以**必須用半形的 `"` 和 `,`**。用全形引號或中文逗號會讓整份設定失效，屆時**所有人都登不進去**，登入畫面會顯示「還沒有設定任何帳號」提醒你回來檢查。
- 密碼裡若要用 `"` 或 `\`，前面要加一個反斜線（`\"`、`\\`）。建議直接避開這兩個字元。

> **從舊版單一密碼升級**：如果你原本設的是 `ADMIN_PASSWORD`，不改也還能用，帳號固定是 `admin`、密碼就是原本那組。改設 `ADMIN_USERS` 之後，`ADMIN_PASSWORD` 就會被忽略（可以刪掉）。

### 3-2. 權限的真實邊界（請務必讀完）

**權限是在 Worker 端擋的，不是靠介面藏按鈕。** 資料拆成 `data/<代號>.json` 之後，發布送出的是「哪幾個檔案」，Worker 逐檔檢查這個帳號有沒有資格寫：

| 角色 | 寫得了 | 擋在哪 |
|---|---|---|
| 總管理員 | `data/` 底下全部 | — |
| 組長 | 只有 `data/<自己的代號>.json` 與待認領區 | `canWriteDataFile()`，回 `forbidden_path` |
| 唯讀 | **什麼都寫不了** | `handlePublish()` 開頭的總開關，回 `read_only` |

唯讀那道刻意放在最前面，因為**照片（`images/`）不經過 `canWriteDataFile()`**——它走的是檔名白名單那條，不看角色。只擋 `data/` 的話，唯讀帳號仍然可以往 repo 塞圖片蓋掉別人的照片。這兩道不能互相取代。

編輯頁也會依角色隱藏按鈕、不渲染編輯表單，但那是**體驗，不是安全**：懂得使用開發者工具的人可以把按鈕叫回來。真正的界線只有一條——送不送得上去。

所以請這樣理解：

- ✅ 組長送別組的檔案會被伺服器擋下，改前端沒有用
- ✅ 唯讀帳號連一個位元組都寫不進去（含照片）
- ✅ 每次發布都留下 `更新會員名錄（a1・A1）` 的提交紀錄，事後查得到是誰
- ✅ 出事可用 GitHub 的歷史紀錄還原
- ⚠️ 組長仍可寫**自己那一組的任何內容**——把組長帳號給誰，等同於信任那個人管好自己那組

> 密碼強度是另一回事。4 位數字只有一萬種組合；Worker 有「同一 IP 15 分鐘內錯 5 次就鎖」的保護，但換 IP 就能繞過節流。給的是編輯權限的帳號，建議至少 6 位以上、或混英數。

### 3-3. 版本落後偵測（多人同時編輯必備）

12 位組長各自的瀏覽器都握著**整份**草稿。如果 A 在 10:30 發布、B 的頁面是 10:05 開的，B 在 10:40 發布時送出的內容裡沒有 A 的修改——**A 的心血就被無聲蓋掉了**。

Worker 因此會比對「這份草稿是根據哪個版本改的」：不符就**擋下這次發布**並回報 `stale_base`。這與權限無關，是多人協作的正確性保護，總管理員與組長一體適用。

**一次發布 = 一個 commit。** 所有檔案（照片 + 分組檔 + 結構檔）先做成 blob、組成一棵 tree、建一個 commit，最後只更新一次 ref，而且是 fast-forward-only。**全成功或全失敗，不會有「前幾個檔已上線、卻回報沒上線」的半套狀態。** 別人在這中間推過東西，ref 更新會被拒，Worker 重讀重試（最多 4 次），仍失敗才回 `busy_retry_later`。

讀不到現行檔案時**擋下**而不是放行（`version_check_failed`）——放行等於同時關掉雜湊比對與樂觀鎖，一次網路抖動就足以讓舊草稿無聲蓋掉別人剛寫的內容。

沒有 baseHash 的路徑（使用者新增分組）採 **create-only**：檔案已存在就回 `already_exists`，不會靜默覆蓋另一個人剛建好的同代號分組。

組長發布時還會確認**自己的代號仍在 `_index.json` 裡**；總管理員改過代號之後，舊分頁的發布會被 `group_renamed` 擋下，而不是寫進一個沒有人會讀的孤兒檔。

### 3-4. 其他端點

| 端點 | 用途 |
|---|---|
| `/read` | 編輯頁的**權威讀取**。回傳內容與雜湊，來源是 GitHub API（立即一致）。編輯頁不再直接讀 GitHub Pages —— Pages 是最終一致的，發布後 1~4 分鐘內讀到的是舊版，會讓其他人的發布一直被判 `stale_base`，而且待認領區會列出已經被別人認領走的人。 |
| `/claim` | **認領新夥伴的伺服器端交易**。輸入 `pid` 與目標分組，Worker 在同一個交易裡確認「這筆還在待認領區」、建立成員卡（帶 `claimedFrom`）、抽出照片、把三者寫進同一個 commit。兩位組長同時認領同一人時，第二位會收到 `already_claimed`，而且他那組**一個位元組都不會被寫入**。這件事只有伺服器做得到：兩個瀏覽器看不到彼此。 |
| `/drop-pending` | 刪掉一筆待認領申請。先原子移除記錄，ref 更新成功之後才刪 R2 物件 —— 順序與 `/claim` 相同，所以不會留下孤兒。 |
| `/pending-photo` | **待認領照片的授權預覽**。輸入 `pid` + 欄位（`image`／`card`／`product` + `index`），回傳圖片位元組本身（不是 JSON），標頭帶 `Cache-Control: private, no-store`。<br>刻意**不簽任何網址**：簽出去的 URL 就是一條公開連結，只是難猜而已，一旦被複製、被貼進聊天室就收不回來。改成每次預覽都當場驗 session。<br>R2 的 key 一律從 `data/_pending.json` 查出來，呼叫端指定的 key 完全無效 —— 否則任何登入者都能拿猜的 key 把整個 bucket 讀一遍，而 bucket 裡放的正是還沒被認領的人的名片。唯讀帳號一律 403。 |
| `/pending-audit` | **孤兒物件的唯讀盤點**（僅總管理員）。把 bucket 裡 `pending/` 的物件與 `_pending.json` 引用的 key 對起來，回報物件數、孤兒數與佔用空間、最舊的孤兒放了幾天，以及反向的 `missingRefs`（被引用但物件已不存在 —— 那是「認領會失敗」的預告）。<br>**它不刪任何東西。** 盤點與刪除混在同一支工具裡，最後總會有人在不確定的情況下按下去。<br>列舉超過頁數上限時回 `truncated: true` 且 `missingRefs: null` —— 沒看完整份清單就不下那個結論。 |

### 4. 綁定「錯誤次數限制」用的儲存空間（KV）

還在同一個 Worker 的 Settings 頁：

1. 找到 **Bindings**（可能叫 KV Namespace Bindings）→ **Add binding**
2. **Variable name** 填：`RATE_LIMIT`
3. **KV namespace** 選「Create new」，取個名字（例如 `member-directory-rate-limit`），建立後選它
4. **Save and deploy**

（這一步是用來擋「密碼亂猜」的：同一個來源 15 分鐘內錯 5 次就會被暫時鎖住。）

#### 選配：訪客瀏覽計數（`VIEWS`）

前台名錄上的「瀏覽次數」需要**另一個獨立的 KV**，沒綁就不顯示，其餘功能完全不受影響。

1. 一樣在 **Bindings** → **Add binding**
2. **Variable name** 填：`VIEWS`
3. **KV namespace** 選「Create new」（例如 `member-directory-views`）
4. **Save and deploy**

**一定要用獨立的命名空間，不要和 `RATE_LIMIT` 共用。** `/views` 是公開端點、免密碼、不限流，而且每次呼叫都寫一次 KV——前台每個訪客開名錄就會打一次。免費方案每天 1000 次寫入，兩者共用的話額度用完時，登入那條路的 KV 寫入也會一起失敗，**全會（含總管理員）都登不進後台**，而畫面上只會顯示「連不到發布服務」，很難查。

所以程式現在不再退而求其次：沒綁 `VIEWS` 就單純不計數。

### 4-2. 綁定待認領照片的儲存空間（R2，**必要**）

新夥伴填完表單、還沒被任何組長認領之前，他的照片（尤其是**名片**，上面通常有手機、Email、地址）要有地方放。這些照片**不可以**放進 `data/_pending.json` —— 那個檔在**公開 repo**，等於把還沒加入分會的人的名片公開給全世界，而且進了 git 歷史之後刪檔也移不掉。

所以照片改存 Cloudflare R2 的**私有** bucket，`_pending.json` 只留文字與「不可公開讀取的物件引用」。**認領成功的那一刻**才把 web 版照片寫進 repo 的 `images/`。

1. Cloudflare 左側 **R2 Object Storage** → **Create bucket**
2. 名稱填 `member-directory-pending-images`（可自訂，binding 才是關鍵）
3. **不要**開啟 Public Access／不要接自訂網域 —— 這個 bucket 必須是私有的
4. 回到 Worker → **Settings** → **Bindings** → **Add binding** → **R2 bucket**
5. **Variable name** 填 `PENDING_IMAGES`，bucket 選剛才建立的那個
6. **Save and deploy**

#### 設一條 lifecycle rule（建議，但請先讀完這一段）

7. 回到該 bucket → **Settings** → **Object lifecycle rules** → **Add rule**
8. Prefix 填 `pending/`，設定「**90 天後刪除**」

> ⚠ **這條規則不只會清掉孤兒。** R2 的 lifecycle 只看 prefix 與物件年齡，**不知道**某個物件是不是還被 `data/_pending.json` 引用著。所以它實際上等於一條業務政策：
>
> **「申請超過 90 天還沒被任何組長認領，照片就會被自動清掉。」**
>
> 之後認領那一筆會得到 `pending_image_missing`，組長必須明確確認才能在缺圖的情況下認領。文字資料不受影響。
>
> 天數請依分會的實際節奏決定。設太短會刪到還在等待處理的有效申請；設太長則孤兒會留久一點 —— 但孤兒現在**很少**：認領成功會刪、`/drop-pending` 刪申請也會刪，只有「Git commit 已成功、R2 還沒刪就中斷」這個很窄的窗口才會留下。
>
> **天數不必用猜的**：用總管理員身分打一次 `/pending-audit`，它會回報現在有幾個孤兒、佔多少空間、最舊的那個放了幾天。那是唯一能看見這件事的地方 —— lifecycle 規則本身不會告訴你它清掉了什麼。
>
> 若不希望有任何自動刪除，可以不設這條規則，改為定期人工檢查；代價是那個窄窗口留下的孤兒會一直佔空間。

> **沒綁 `PENDING_IMAGES` 會怎樣**：`/intake` 一律回 `pending_image_store_unavailable`（HTTP 503），表單那頭會收到明確的失敗訊息，資料仍完整留在 Google 表單的回應試算表裡，可以補送。
>
> **程式刻意不提供「退回把照片寫進 `_pending.json`」的備援** —— 那個退路正是要消滅的東西：一旦退回去，未認領者的名片又會進公開 repo，而且是在沒有人察覺的情況下。

#### 確認有沒有設定成功

部署後打一次 `/ping`，`caps.pendingImages` 要是 `"r2-v1"`：

```json
{ "ok": true, "caps": { "pendingImages": "r2-v1", "claim": true, "read": true, "atomic": true } }
```

是 `false` 就代表 binding 沒生效，**這時候不要更新 Apps Script**（見下方部署順序）。

### 5. 拿到網址、貼進編輯頁

1. 回到 Worker 總覽頁，複製網址（長得像 `https://member-directory-relay.你的帳號.workers.dev`）
2. 打開名錄網站 → 右下角小齒輪 → 「連線設定」→ 貼上網址 → 可以先按「測試連線」確認 ✔ → 儲存
3. 回到登入畫面，輸入你剛才設定的**帳號與密碼** → 進入編輯模式

完成！之後任何裝置只要知道這組密碼，都可以直接進來編輯。GitHub 權杖從頭到尾沒有出現在任何瀏覽器裡。

## 安全設計的取捨（誠實說明）

- **密碼錯太多次會暫時鎖住**（15 分鐘內錯 5 次），且每次登入都刻意加了一點點延遲，讓大量嘗試密碼變得更慢、更不划算。
- **登入後的「通行證」（session）存在瀏覽器分頁的暫存區**，關掉分頁就消失，最長 30 分鐘要重新輸入密碼一次。這張通行證在有效期內可以用來發布——這是為了操作簡單所做的合理取捨，而不是遺漏。
- Worker 的**程式碼本身**（這個 `publish-relay.js`）沒有任何密碼或權杖，可以放心保留在公開的 repo 裡。真正的機密（密碼、GitHub 權杖、簽章密鑰）只存在 Cloudflare 後台的「Secret」欄位，且該頁面只有登入 Cloudflare 的管理員看得到。

## 升級到「待認領照片存私有 R2」的部署順序

**順序不能顛倒。** 每一步都有一個明確的檢查點，沒過就不要往下走。

| # | 動作 | 檢查點 |
|---|---|---|
| 1 | 建立 private R2 bucket（見 4-2） | bucket 存在、**沒有** Public Access |
| 2 | 綁 `PENDING_IMAGES`、設 `pending/` 的 30 天 lifecycle rule | Bindings 清單裡看得到 |
| 3 | **先**部署新版 Worker | 打 `/ping`，`caps.pendingImages === "r2-v1"` |
| 4 | 更新 Apps Script（`tools/google-form.gs`）與前端 | 跑 `checkNewMemberSetup`，「失敗通知」那一行是 ✅ |
| 5 | 送一份**含 7 張照片**的測試申請 | R2 裡有 7 個物件、`_pending.json` 只有幾 KB、認領後 `images/` 有 7 張且 R2 被清空 |
| 6 | 確認無誤後才處理／清掉舊的待認領資料 | — |

> **第 3 步沒過就不要往下走。** `caps.pendingImages` 回 `false` 代表 binding 沒生效，這時 `/intake` 會把**每一筆**新夥伴申請都退回（503）。
>
> 這件事在後台原本完全看不出來：待認領區是空的，看起來就只是「最近沒人申請」。所以現在 `/health` 也會回報 `pendingImages`，總管理員一登入就會看到橫幅；而 Apps Script 那頭會把每一筆失敗寄信給 `ALERT_EMAIL`。兩道提示都設好，才不會再有一次「表單看起來正常、申請卻一直沒進來」。

> 早期版本有一支一次性的 `/migrate-pending`，用來把部署 R2 之前收到的、照片還內嵌在 `data/_pending.json` 裡的申請搬進 R2。待認領區已經沒有那種資料，端點也已經移除（現在會回 404）——留著等於多一支沒人維護、卻能寫入 `_pending.json` 的端點。
>
> **認領**這條路的舊格式相容仍然保留：舊格式的照片以 data URL 內嵌、尺寸上限是當年的 512 KiB，`/claim` 依舊認得（有回歸測試守住）。

### 回滾

⚠ **不要直接部署只認得舊 data URL 的舊版 Worker。** 新格式的申請把照片放在 `photoRefs` 指向的 R2 物件裡，舊版 Worker 讀不懂那個欄位，認領時會建出一張**沒有照片**的成員卡，而申請已經從待認領區消失 —— 照片就再也接不回去了。

要回滾的話，二選一：

- **先把待認領區清空**（全部認領完或刪掉），確認 `_pending.json` 是 `[]`，再部署舊版；或
- 回滾到**仍然看得懂 `photoRefs` 的版本**（本次的 Worker 同時支援新舊兩種格式，所以往前回滾到它是安全的）。

## 之後要做的維護

- **換密碼／增刪帳號**：回 Worker 的 Settings 改 `ADMIN_USERS` 那段 JSON，Save and deploy 即可，
  不用動編輯頁那邊任何設定。
- **權杖過期或需要換一支**：把新的權杖貼到 `GH_TOKEN`，Save and deploy。
- **忘記密碼**：只有能登入 Cloudflare 的管理員能改 `ADMIN_USERS`——這是刻意設計，避免密碼
  被任何操作者自行更改。
- **免費額度**：Cloudflare Workers 與 Workers KV 都有夠用的免費額度，這個名錄網站的流量遠遠用不完，
  不會產生費用。

---

## 升級：發布時支援附件（照片實體檔）

2026/7 之後的 `publish-relay.js` 支援「附件」：編輯頁發布時，照片會存成 `images/` 實體圖檔（而不是內嵌在 data.js 裡）。成員的分享預覽頁 `m/` 則一律由 GitHub Action 在發布後 1–2 分鐘重建（唯一產生器是 `tools/build-member-pages.mjs`），不走 Worker。

**已經部署過舊版的話，升級只要一步：**

1. 到 Cloudflare 該 Worker → **Edit code** → 全選清空，貼上新版 `publish-relay.js` 完整內容 → **Deploy**。

不需要新增或修改任何變數／Secret。升級後把後台編輯頁重新整理一次，之後照常按「發布到網站」即可（照片較多時會自動分批上傳，按鈕上會顯示進度）。

安全性不變：附件只允許寫入 `images/` 一個資料夾、限定副檔名與大小，其他路徑一律拒絕。`m/` 分享頁一律由 GitHub Action 的 `build-member-pages.mjs` 重建，Worker 不接受寫入 `m/`（若開放瀏覽器寫 `.html`，同源下就能植入 JS 偷登入憑證，因此刻意不給這個能力）。
