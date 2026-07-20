/**
 * 會員名錄・夥伴資料補齊表單(Google Apps Script)
 *
 * 用法(一次設定,約 3 分鐘):
 * 1. 開 https://script.google.com → 新增專案,把整個檔案內容貼上、儲存。
 * 2. 執行 setupAll(第一次會要求授權,一路允許)——會一次建好:
 *    表單、回應試算表、以及「每筆回應自動更新『匯入用』分頁」的綁定。
 * 3. 看「執行紀錄」:會印出 表單網址(給夥伴填)、編輯網址、回應試算表網址。
 * 4. ⚠ 手動補 2 題「檔案上傳」(Google 不開放程式建立這種題型,要在表單編輯頁加,約 2 分鐘):
 *    - 名片圖檔(選填):新增題目 → 檔案上傳 → 只允許「圖片」→ 檔案數量上限 2(正反面)
 *    - 商品/服務照片(選填):同上,上限 5
 *    (表單裡已放好「照片上傳區」標題,把兩題加在它下面即可;形象照不開表單題,另外收)
 * 5. 把表單網址填回名錄後台 admin.js 最上方的 FORM_URL(或告訴網管助理 AI,一分鐘改好),
 *    之後「缺資料」按鈕產生的催收訊息就會自動附表單連結。
 *
 * 收到回應之後:
 * - 執行 refreshImportTab:把最新回應整理成「匯入用」分頁(多行欄位自動轉 | 分隔、
 *   同一人多次填答取最新)→ 檔案 → 下載 → CSV → 名錄後台「匯入 CSV」→ 發布。
 * - 執行 renameUploads:把夥伴上傳的照片自動改名成「姓名_名片1.jpg」等格式,
 *   下載後對照檔名,到後台各成員卡用「更換名片」「加商品照」放入(順便審查)。
 */

var FIELDS = {
  required: [
    { title: "姓名", help: "請填與名錄相同的姓名,方便自動比對", type: "text" },
    { title: "所屬公司", help: "公司或商號全名(會顯示在名錄)", type: "text" },
    { title: "主要營業項目", help: "一句話說明主要業務(會顯示在名錄)", type: "text" },
  ],
  /* 2026/7 決定精簡:編號/專業別/服務項目/宣傳標語 不開放表單填寫(比對以姓名為準,
     這幾欄改由網管透過 CSV/PPT 維護);表單只留下面兩個選填。 */
  optional: [
    { title: "適合引薦對象", help: "一行一項;留白=沿用名錄現有資料", type: "para" },
    { title: "公司網站", help: "請含 https:// 開頭", type: "url" },
  ],
  consent: "我同意以上資料與上傳的照片,公開顯示於分會會員名錄網站",
};

/* ★ 一鍵完成:建表單 + 回應試算表 + 「回應→匯入用 CSV」自動綁定(每筆回應即時更新)
   只要執行這一個函式就好。 */
function setupAll() {
  createMemberForm();
  installAutoRefresh_();
  Logger.log("✅ 全部完成:表單回應會自動即時整理進「匯入用」分頁,下載 CSV 即可匯入名錄後台。");
}

/* 每有夥伴送出表單,自動重整「匯入用」分頁(表單回應 → 名錄可匯入的 CSV 格式) */
function installAutoRefresh_() {
  var ssId = PropertiesService.getScriptProperties().getProperty("SS_ID");
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onFormSubmitAuto") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("onFormSubmitAuto")
    .forSpreadsheet(ssId)
    .onFormSubmit()
    .create();
}
function onFormSubmitAuto(e) {
  try { refreshImportTab(); } catch (err) { /* 下次提交會再試,亦可手動執行 refreshImportTab */ }
}

/* 表單已經建好、只想把「回應→匯入用」自動更新重綁到最新表單的試算表時,執行這個。
   (⚠ 不要用 setupAll 重綁——重跑會多建一份全新表單。) */
function reinstallAutoRefresh() {
  installAutoRefresh_();
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SS_ID"));
  Logger.log("✅ 觸發器已重綁到:" + ss.getName() + " " + ss.getUrl());
  Logger.log("之後每筆回應會自動更新這份試算表的「匯入用」分頁。");
}

function createMemberForm() {
  var form = FormApp.create("會員名錄・資料補齊表單");
  form.setDescription(
    "感謝撥空補齊你的名錄資料!\n" +
    "・只有前三題與同意聲明必填,其餘選填——留白就沿用名錄現有內容。\n" +
    "・照片上傳需登入 Google 帳號。\n" +
    "・填完資料會由網管審查後更新到名錄網站。"
  );
  form.setCollectEmail(true);

  FIELDS.required.forEach(function (f) { addQ(form, f, true); });

  form.addSectionHeaderItem().setTitle("以下皆為選填").setHelpText("留白=沿用名錄現有資料;想更新哪項就填哪項。");
  FIELDS.optional.forEach(function (f) { addQ(form, f, false); });

  form.addSectionHeaderItem()
    .setTitle("照片上傳區(選填)")
    .setHelpText("網管會在這個標題下面手動加入兩題檔案上傳:名片圖檔(至多 2 張,正反面)、商品/服務照片(至多 5 張)。若你看得到上傳題,直接使用即可。");

  form.addCheckboxItem()
    .setTitle("同意聲明")
    .setChoiceValues([FIELDS.consent])
    .setRequired(true);

  var ss = SpreadsheetApp.create("會員名錄・表單回應");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  PropertiesService.getScriptProperties().setProperty("SS_ID", ss.getId());
  PropertiesService.getScriptProperties().setProperty("FORM_ID", form.getId());

  Logger.log("✅ 表單建立完成");
  Logger.log("給夥伴填的網址:" + form.getPublishedUrl());
  Logger.log("表單編輯網址(記得手動加 3 題檔案上傳):" + form.getEditUrl());
  Logger.log("回應試算表:" + ss.getUrl());
}

function addQ(form, f, required) {
  var item = f.type === "para" ? form.addParagraphTextItem() : form.addTextItem();
  item.setTitle(f.title).setRequired(!!required);
  if (f.help) item.setHelpText(f.help);
  if (f.type === "url") {
    try {
      item.setValidation(FormApp.createTextValidation().requireTextIsUrl().build());
    } catch (e) { /* 驗證器不支援就跳過,不影響表單 */ }
  }
}

/* 把回應整理成後台「匯入 CSV」能直接吃的「匯入用」分頁(同一人多次填答取最新) */
function refreshImportTab() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SS_ID"));
  var src = getResponseSheet_(ss);
  var data = src.getDataRange().getValues();
  if (data.length < 2) { Logger.log("還沒有回應。"); return; }
  var head = data[0].map(String);
  var col = function (name) { return head.indexOf(name); };
  var pick = function (row, name) { var i = col(name); return i < 0 ? "" : String(row[i] || "").trim(); };
  var toPipe = function (v) {
    return String(v || "").split("\n").map(function (s) { return s.trim(); }).filter(String).join("|");
  };

  var OUT_HEAD = ["編號", "姓名", "行業職稱", "服務項目", "適合引薦對象", "宣傳標語", "所屬公司", "主要營業項目", "公司網站"];
  var byKey = {};   // 同一人取最新(回應由舊到新,後蓋前)
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var name = pick(row, "姓名");
    if (!name) continue;
    var number = pick(row, "編號");
    byKey[number || name] = [
      number, name,
      pick(row, "專業別(行業職稱)"),
      toPipe(pick(row, "服務項目")),
      toPipe(pick(row, "適合引薦對象")),
      toPipe(pick(row, "宣傳標語")),
      pick(row, "所屬公司"),
      pick(row, "主要營業項目"),
      pick(row, "公司網站"),
    ];
  }
  var rows = Object.keys(byKey).map(function (k) { return byKey[k]; });

  var out = ss.getSheetByName("匯入用") || ss.insertSheet("匯入用");
  out.clearContents();
  out.getRange(1, 1, 1, OUT_HEAD.length).setValues([OUT_HEAD]);
  if (rows.length) out.getRange(2, 1, rows.length, OUT_HEAD.length).setValues(rows);
  Logger.log("✅「匯入用」分頁已更新:" + rows.length + " 位(檔案 → 下載 → CSV,丟名錄後台「匯入 CSV」)");
}

/* 把上傳的照片改名成「姓名_名片1.jpg」等格式(有填編號會自動加編號前綴),
   下載後對照檔名放進各成員卡 */
function renameUploads() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SS_ID"));
  var src = getResponseSheet_(ss);
  var data = src.getDataRange().getValues();
  if (data.length < 2) { Logger.log("還沒有回應。"); return; }
  var head = data[0].map(String);
  var uploadCols = [];
  head.forEach(function (h, i) {
    if (h.indexOf("形象照") >= 0) uploadCols.push({ i: i, tag: "形象照" });
    else if (h.indexOf("名片") >= 0) uploadCols.push({ i: i, tag: "名片" });
    else if (h.indexOf("商品") >= 0) uploadCols.push({ i: i, tag: "商品" });
  });
  if (!uploadCols.length) { Logger.log("找不到檔案上傳欄位(表單還沒加上傳題,或尚無人上傳)。"); return; }

  var renamed = 0, failed = 0;
  for (var r = 1; r < data.length; r++) {
    var name = String(data[r][head.indexOf("姓名")] || "").trim();
    var number = String(data[r][head.indexOf("編號")] || "").trim();
    var prefix = (number ? number + "_" : "") + (name || "未具名");
    uploadCols.forEach(function (c) {
      var urls = String(data[r][c.i] || "").split(",").map(function (s) { return s.trim(); }).filter(String);
      urls.forEach(function (u, idx) {
        var m = u.match(/[?&]id=([\w-]+)/) || u.match(/\/d\/([\w-]+)/);
        if (!m) return;
        try {
          var file = DriveApp.getFileById(m[1]);
          var ext = (file.getName().match(/\.[A-Za-z0-9]+$/) || [".jpg"])[0];
          var suffix = (c.tag === "商品" || urls.length > 1) ? c.tag + (idx + 1) : c.tag;
          file.setName(prefix + "_" + suffix + ext);
          renamed++;
        } catch (e) { failed++; }
      });
    });
  }
  Logger.log("✅ 改名完成:" + renamed + " 個檔案" + (failed ? "(" + failed + " 個失敗,可能無權限)" : ""));
  Logger.log("到 Drive 的表單上傳資料夾整批下載,對照檔名到後台各成員卡放入(更換名片/加商品照)。");
}

/* 建立「來賓參訪報名」表單:回應進獨立試算表,當作來賓 CRM(自行加「追蹤狀態」欄) */
function createVisitorForm() {
  var form = FormApp.create("雲榮鑽石分會・來賓參訪報名");
  form.setDescription(
    "感謝你的參訪意願!填寫約 1 分鐘,送出後分會夥伴會與你確認場次與細節。\n" +
    "建議提早 15 分鐘到場交流,著商務服裝、攜帶名片。"
  );
  form.addTextItem().setTitle("姓名").setRequired(true);
  form.addTextItem().setTitle("公司/品牌").setRequired(true);
  form.addTextItem().setTitle("專業別(你的行業)").setRequired(true).setHelpText("例:室內設計、稅務會計、進口紅酒");
  form.addTextItem().setTitle("手機").setRequired(true).setHelpText("僅供聯繫確認場次,不會公開");
  form.addTextItem().setTitle("邀請你的分會夥伴").setHelpText("填夥伴姓名;沒有邀請人也歡迎,留白即可");
  form.addTextItem().setTitle("想參訪的日期").setHelpText("例:下週四;不確定可留白,由我們與你確認");
  form.addParagraphTextItem().setTitle("想認識哪類產業或夥伴?").setHelpText("選填,幫你先安排同桌交流");

  var ss = SpreadsheetApp.create("雲榮鑽石分會・來賓報名(CRM)");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log("✅ 來賓報名表單建立完成");
  Logger.log("給來賓填的網址(貼進 visitor.html 的 VISITOR.formUrl):" + form.getPublishedUrl());
  Logger.log("報名回應試算表(來賓 CRM;建議手動加「追蹤狀態/到訪日/結果」三欄):" + ss.getUrl());
}

/* 建立「名冊鏡像」Google 試算表:A1 放 IMPORTDATA,名錄一發布就自動跟上(約每小時重抓) */
function createRosterSheet() {
  var ss = SpreadsheetApp.create("會員名錄・名冊鏡像");
  var sheet = ss.getSheets()[0];
  sheet.setName("名冊(自動同步)");
  sheet.getRange("A1").setFormula('=IMPORTDATA("https://ivanzhong085.github.io/member-directory/roster.csv")');
  var memo = ss.insertSheet("使用說明");
  memo.getRange("A1:A6").setValues([
    ["「名冊(自動同步)」分頁是唯讀鏡像:名錄網站一發布,約一小時內自動更新,請勿直接編輯。"],
    ["要修改名錄:複製需要的列到新分頁改好 → 檔案 → 下載 → CSV → 名錄後台「匯入 CSV」→ 發布。"],
    ["做產業小組 PDF:新增分頁,用 =FILTER('名冊(自動同步)'!A:P, '名冊(自動同步)'!D:D=\"A1\") 之類擷取各組,排版後 檔案 → 下載 → PDF。"],
    ["催收缺資料:用 FILTER 篩「照片」「名片」「所屬公司」等欄為空白的列。"],
    ["名冊鏡像固定網址:https://ivanzhong085.github.io/member-directory/roster.csv"],
    ["把這份試算表的網址告訴網管助理 AI,可加進名錄後台工具列捷徑。"],
  ]);
  Logger.log("✅ 名冊鏡像試算表建立完成:" + ss.getUrl());
}

function getResponseSheet_(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getFormUrl()) return sheets[i];
  }
  return sheets[0];
}
