# 會員公司資料與對外產業圖

## 單一資料來源

會員主資料位於 `data/_index.json` 與各組 `data/<code>.json`。
`company` 是公司對外名稱，`companyPosition` 是獨立的公司內職稱；`title` 維持原有專業別。
公司或職稱缺漏時不推測，沒有以 BNI 幹部職務代填。

`node tools/build-data.mjs` 從主資料產生 `data.js` 及 `data/_public-profiles.json`。
後者僅是可重建的相容輸出：以會員 ID 為鍵，每列只有 `name`、`company`、`position`，不得手改或填入稽核資料。
圖表直接讀取主資料，因此過期的相容輸出不會蓋掉管理員更新。
管理頁可編輯公司內職稱，暫存、備份、一般發布 payload 及 CSV 匯出均保留該欄。
原有更新問卷與 v1 連結代碼的九欄契約維持原狀；沒有修改問卷或擴張 Worker 權限。

## 本地合併工具

先準備已核對的私有輸入，放在公開 repository 外。
每列需要目前會員 ID、姓名／編號／組別交叉身分、三個欄位的核對時基準值與欲採用值、欄位來源證據。
只允許合併姓名、公司、公司職稱；空白來源不會清除既有內容。
不以重複會員編號配對，不模糊比對姓名；ID 不存在、換組或身分不同時必須先核對 remap。
實際原回覆、姓名別名證據、公司校正對照與差異清單均留在 repository 外。

```sh
node tools/merge-company-profiles.mjs --input ../private/reviewed-input.json --report ../private/plan.json --dry-run
node tools/merge-company-profiles.mjs --input ../private/reviewed-input.json --plan ../private/plan.json --report ../private/applied.json --apply
node tools/build-data.mjs
node tools/build-roster.mjs
node tools/stamp-data-version.mjs
node tools/build-member-pages.mjs
```

輸入需提供核對時的 `baseCommit`。apply 必須使用 dry-run 計畫，會檢查 HEAD、來源檔雜湊及主資料檔雜湊。
原值已改且與候選值不同時列為衝突；有任何衝突不寫入主資料。
相同輸入重跑為零變更，不重新蓋時間戳或碰其他會員欄位。
這些命令不推送、不部署、不回寫問卷。

## 圖表

首頁／管理入口開啟 `groups.html?view=public-single`：四欄緊湊橫式完整單張，姓名下方顯示完整公司與公司職稱。
設計寬 2200px；姓名 24px，公司／職稱 20px；JPG／PNG 預設寬 6600px，長公司完整換行，PDF 為單頁橫式。
原內部圖、舊六欄對外總覽、每組大字版均保留。內部圖繼續顯示原專業別與組長、招募內容。
對外圖只顯示姓名、公司、公司職稱及分組標題；完整單張未填職稱留白。
此欄位選擇不是存取權限；公開 repository 內的檔案皆可被存取，不應提交私有問卷或內部報告。

## 驗證

- `tests/company-merge.test.mjs`：身分、重複編號、改 ID、來源證據、衝突、欄位範圍、dry-run/apply 與冪等性。
- `tests/company-admin-browser.test.mjs`：成員頁、管理編輯與重新載入、備份／CSV、資料重建、圖表及本地攔截的發布 payload。
- `tests/groups-view.test.mjs`：主資料優先、空職稱、欄位白名單、HTML 跳脫、內部功能、衍生資料一致。
- `tests/groups-browser.test.mjs`、`tests/groups-large.test.mjs`、`tests/groups-single.test.mjs`：真實匯出、長公司、手機與 PDF。
- `tools/check-dead-code.mjs` 及既有 regression tests。

瀏覽器驗證只連到本機，遠端服務皆封鎖或以本地測試回應替代。
`GROUPS_ARTIFACT_DIR` 指定非 repository 的驗證輸出資料夾；
`PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 可指定已安裝的測試 runtime。
