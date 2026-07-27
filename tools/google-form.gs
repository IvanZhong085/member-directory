/**
 * 雲榮鑽石分會・來賓參訪報名表單(Google Apps Script)
 *
 * 這個檔只做兩件事,各對應一個函式,彼此獨立、可以只跑其中一個:
 *   createVisitorForm()  建立「來賓參訪報名」表單 + 報名回應試算表(來賓 CRM)
 *   createRosterSheet()  建立「名冊鏡像」試算表(A1 放 IMPORTDATA,名錄一發布就自動跟上)
 *
 * ── 建立來賓報名表單(約 3 分鐘)────────────────────────────────
 * 1. 開 https://script.google.com → 「新增專案」,把這整個檔案內容貼進去、儲存。
 * 2. 上方函式下拉選單選 createVisitorForm → 按「執行」。
 *    第一次會跳授權:選你的 Google 帳號 →「進階」→「前往(不安全)」→「允許」。
 *    (這是 Google 對自己寫的腳本的標準提示,腳本只會建立表單與試算表。)
 * 3. 看下方「執行紀錄」,會印出兩個網址:
 *    - 給來賓填的網址 → 貼進 site-config.js 的 VISITOR_FORM_URL
 *    - 報名回應試算表 → 收藏起來,這就是你的來賓 CRM
 * 4. 把 VISITOR_FORM_URL 填好後發布網站,來賓頁的「我要報名參訪」按鈕就會直接開表單。
 *
 * ⚠ 不要重複執行 createVisitorForm,每跑一次就會多建一份新表單。
 *   要改題目請直接到表單編輯頁改;要重建請先把舊表單刪掉。
 */

/* 建立「來賓參訪報名」表單:回應進獨立試算表,當作來賓 CRM。
   五個欄位:姓名、電話、LINE ID、職業必填;引薦人姓名選填(自己找上門的來賓也收得到)。 */
function createVisitorForm() {
  var form = FormApp.create("雲榮鑽石分會・來賓參訪報名");
  form.setDescription(
    "感謝你的參訪意願!填寫約 1 分鐘,送出後分會夥伴會與你聯繫確認場次與細節。\n" +
    "例會時間:每週四 06:30–09:00(Zoom 線上會議)。"
  );

  form.addTextItem()
    .setTitle("姓名")
    .setRequired(true);

  form.addTextItem()
    .setTitle("電話")
    .setHelpText("僅供聯繫確認場次,不會公開")
    .setRequired(true);

  form.addTextItem()
    .setTitle("LINE ID")
    .setHelpText("方便加你好友、傳送會議連結與提醒")
    .setRequired(true);

  form.addTextItem()
    .setTitle("職業")
    .setHelpText("例:室內設計、稅務會計、進口紅酒")
    .setRequired(true);

  form.addTextItem()
    .setTitle("引薦人姓名")
    .setHelpText("邀請你來的分會夥伴;沒有引薦人也歡迎,留白即可")
    .setRequired(false);

  var ss = SpreadsheetApp.create("雲榮鑽石分會・來賓報名(CRM)");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  Logger.log("✅ 來賓報名表單建立完成");
  Logger.log("① 給來賓填的網址(貼進 site-config.js 的 VISITOR_FORM_URL):" + form.getPublishedUrl());
  Logger.log("② 報名回應試算表(來賓 CRM;建議手動加「追蹤狀態/到訪日/結果」三欄):" + ss.getUrl());
  Logger.log("③ 表單編輯網址(之後要改題目從這裡進):" + form.getEditUrl());
}

/* 建立「名冊鏡像」Google 試算表:A1 放 IMPORTDATA,名錄一發布就自動跟上(約每小時重抓)。
   與來賓表單無關,需要唯讀名冊時才跑。 */
function createRosterSheet() {
  var ss = SpreadsheetApp.create("會員名錄・名冊鏡像");
  var sheet = ss.getSheets()[0];
  sheet.setName("名冊(自動同步)");
  sheet.getRange("A1").setFormula('=IMPORTDATA("https://ivanzhong085.github.io/member-directory/roster.csv")');
  var memo = ss.insertSheet("使用說明");
  memo.getRange("A1:A6").setValues([
    ["「名冊(自動同步)」分頁是唯讀鏡像:名錄網站一發布,約一小時內自動更新,請勿直接編輯。"],
    ["要修改名錄:複製需要的列到新分頁改好 → 檔案 → 下載 → CSV → 名錄後台「匯入 CSV」→ 發布。"],
    ["做產業小組 PDF:新增分頁,用 =FILTER('名冊(自動同步)'!A:S, '名冊(自動同步)'!D:D=\"A1\") 之類擷取各組,排版後 檔案 → 下載 → PDF。"],
    ["催收缺資料:用 FILTER 篩「照片」「名片」「我有」「我要」等欄為空白的列。"],
    ["名冊鏡像固定網址:https://ivanzhong085.github.io/member-directory/roster.csv"],
    ["把這份試算表的網址貼進 site-config.js 的 ROSTER_SHEET_URL,後台工具列就會出現捷徑。"],
  ]);
  Logger.log("✅ 名冊鏡像試算表建立完成:" + ss.getUrl());
  Logger.log("把上面網址貼進 site-config.js 的 ROSTER_SHEET_URL。");
}
