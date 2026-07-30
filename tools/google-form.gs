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

/* ══════════════════════════════════════════════════════════════════════════
   新夥伴自填資料表單
   ══════════════════════════════════════════════════════════════════════════
   跟來賓表單不同,這份表單送出後會**自動把資料送進名錄網站的「待認領區」**,
   組長登入後台就看得到,按「認領」就成為他那一組的成員。

   ── 建立步驟(約 5 分鐘,做一次)────────────────────────────────
   1. 先在 Cloudflare 的 Worker 設定裡新增一個加密變數(Secret):
        名稱:INTAKE_SECRET      值:一串長亂碼(請 Claude 產給你,或自己亂打 40 字以上)
      存檔並 Deploy。
   2. 回到這個 Apps Script 專案 → 左邊齒輪「專案設定」→ 最下面「指令碼屬性」
      → 新增兩筆:
        RELAY_URL      = https://member-directory-relay.retetrhjj123.workers.dev
        INTAKE_SECRET  = 跟上面 Cloudflare 填的那一串「完全一樣」
      (放在這裡而不是寫進程式碼,所以這串密碼不會進到 GitHub。)
   3. 上方函式下拉選單選 createNewMemberForm → 按「執行」。
      第一次會多要幾個權限(建立表單、讀 Drive 上的照片、連外部網址),都要允許。
   4. 執行紀錄會印出表單網址 → 貼進 site-config.js 的 MEMBER_FORM_URL,發布網站。

   ⚠ 這份表單有「上傳照片」題,Google 會要求填答者**登入 Google 帳號**才能送出。
     這是 Google 的規定,沒有辦法關掉;不想要就把三個上傳題刪掉。
   ⚠ 不要重複執行 createNewMemberForm,每跑一次就會多建一份新表單。
*/

var NEWMEMBER_TRIGGER = "onNewMemberSubmit";
/* 題目標題就是對應欄位的鍵。改題目文字的話這裡要一起改,否則對不上。 */
var NEWMEMBER_Q = {
  name:           "姓名",
  title:          "行業／職稱",
  company:        "所屬公司",
  services:       "服務項目",
  targets:        "適合引薦對象",
  have:           "我有…",
  want:           "我要…",
  tagline:        "25 秒自我介紹 Slogan",
  business_items: "主要營業項目",
  website:        "公司網站",
  image:          "個人照片",
  card:           "名片照片",
  products:       "商品／服務照片",
};

function createNewMemberForm() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("RELAY_URL") || !props.getProperty("INTAKE_SECRET")) {
    throw new Error("請先到「專案設定 → 指令碼屬性」設好 RELAY_URL 與 INTAKE_SECRET(見檔案開頭步驟 1、2)");
  }

  var form = FormApp.create("雲榮鑽石分會・新夥伴資料填寫");
  form.setDescription(
    "歡迎加入雲榮鑽石分會!請填寫你的介紹資料,送出後會由你的產業小組組長確認並上架到分會名錄。\n" +
    "填寫約 5 分鐘。有上傳照片的題目,Google 會要求你先登入 Google 帳號。"
  );

  form.addTextItem().setTitle(NEWMEMBER_Q.name).setRequired(true);
  form.addTextItem().setTitle(NEWMEMBER_Q.title)
    .setHelpText("會顯示在名錄上的一句話行業說明。例:國產羊肉批發、水禽契約養殖").setRequired(true);
  form.addTextItem().setTitle(NEWMEMBER_Q.company)
    .setHelpText("公司或商號全名").setRequired(true);

  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.services)
    .setHelpText("你提供什麼服務或產品,一項一行。例:\n國產羊肉批發零售\n活羊批發零售").setRequired(true);
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.targets)
    .setHelpText("希望夥伴幫你介紹什麼樣的對象,一項一行。例:\n火鍋餐廳\n外燴團隊").setRequired(true);

  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.have)
    .setHelpText("你手上有什麼可以給出去的資源、產能、通路、人脈或專長,一項一行。\n例:我有國產羊肉爐資源").setRequired(false);
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.want)
    .setHelpText("你想被引薦到誰,一項一行。例:\n羊肉特色小吃店\n肉舖").setRequired(false);

  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.tagline)
    .setHelpText("你在例會上做 25 秒自我介紹時的那句 slogan,兩句一組、一句一行。\n例:\n國產羊肉找阿成\n老饕全部都點頭").setRequired(false);
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.business_items)
    .setHelpText("公司登記的主要營業項目(選填)").setRequired(false);
  form.addTextItem().setTitle(NEWMEMBER_Q.website)
    .setHelpText("有官網才填,要完整網址(https://…);沒有請留白").setRequired(false);

  addImageUpload_(form, NEWMEMBER_Q.image, "半身或大頭照,横幅直幅都可以,系統會自動裁成名錄用的比例", 1, true);
  addImageUpload_(form, NEWMEMBER_Q.card, "名片正面照片(選填)", 1, false);
  addImageUpload_(form, NEWMEMBER_Q.products, "你的商品或服務照片,最多 5 張(選填)", 5, false);

  var ss = SpreadsheetApp.create("雲榮鑽石分會・新夥伴資料填寫(回應)");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  ScriptApp.newTrigger(NEWMEMBER_TRIGGER).forForm(form).onFormSubmit().create();

  Logger.log("✅ 新夥伴資料表單建立完成,送出後會自動進到名錄的待認領區");
  Logger.log("① 給新夥伴填的網址(貼進 site-config.js 的 MEMBER_FORM_URL):" + form.getPublishedUrl());
  Logger.log("② 回應試算表(備份用,主要流程不靠它):" + ss.getUrl());
  Logger.log("③ 表單編輯網址(之後要改題目從這裡進):" + form.getEditUrl());
}

function addImageUpload_(form, title, help, maxFiles, required) {
  var item = form.addFileUploadItem().setTitle(title).setHelpText(help).setRequired(!!required);
  try {
    item.setAllowedFileTypes([FormApp.FileType.IMAGE]);
    item.setMaxFiles(maxFiles);
    item.setMaxFileSize(10 * 1024 * 1024);   // Drive 端上限;送到網站前會自己縮圖
  } catch (err) {
    Logger.log("⚠ 上傳題的細部設定失敗(" + title + "):" + err + " —— 題目仍會建立");
  }
  return item;
}

/* 表單送出時自動觸發:把這份回應整理好,送到 Worker 的 /intake。
   任何一步失敗都寫進執行紀錄,回應本身仍留在試算表裡,不會遺失。 */
function onNewMemberSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  if (!relay || !secret) { Logger.log("✗ 沒設 RELAY_URL / INTAKE_SECRET,這筆沒有送出"); return; }

  var byTitle = {};
  var items = e.response.getItemResponses();
  for (var i = 0; i < items.length; i++) {
    byTitle[items[i].getItem().getTitle()] = items[i].getResponse();
  }
  var text = function (key) { var v = byTitle[NEWMEMBER_Q[key]]; return v == null ? "" : String(v); };
  var files = function (key) {
    var v = byTitle[NEWMEMBER_Q[key]];
    if (!v) return [];
    return (Object.prototype.toString.call(v) === "[object Array]" ? v : [v]).filter(String);
  };

  var photos = files("image"), cards = files("card"), products = files("products");
  var applicant = {
    name:           text("name"),
    title:          text("title"),
    company:        text("company"),
    services:       text("services"),
    targets:        text("targets"),
    have:           text("have"),
    want:           text("want"),
    tagline:        text("tagline"),
    business_items: text("business_items"),
    website:        text("website"),
    image:          photos.length ? driveImageDataUrl_(photos[0], 900) : "",
    card:           cards.length ? driveImageDataUrl_(cards[0], 900) : "",
    products:       products.slice(0, 5).map(function (id) { return driveImageDataUrl_(id, 900); })
                      .filter(function (s) { return !!s; }),
  };

  var res;
  try {
    res = UrlFetchApp.fetch(relay + "/intake", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ secret: secret, applicant: applicant }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log("✗ 連不到發布服務:" + err + "(回應仍在試算表裡,可請網管手動處理)");
    return;
  }
  var code = res.getResponseCode(), body = res.getContentText();
  if (code === 200 && body.indexOf('"ok":true') >= 0) {
    Logger.log("✅ 已送進待認領區:" + applicant.name + " " + body);
  } else {
    Logger.log("✗ 送出失敗(HTTP " + code + "):" + body + "\n   回應仍在試算表裡,可請網管手動處理。");
  }
}

/* Drive 上的照片 → data:image/jpeg;base64,…(名錄後台認得的格式)。
   用 Drive 的縮圖服務指定寬度,而不是原檔——手機照片動輒 3–5MB,原檔送不過去。
   太大就再降一級寬度重試;都失敗回傳空字串(照片沒了,其他資料照樣進待認領區)。 */
function driveImageDataUrl_(fileId, maxWidth) {
  var widths = [maxWidth, 600, 400];
  for (var i = 0; i < widths.length; i++) {
    try {
      var res = UrlFetchApp.fetch(
        "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w" + widths[i],
        { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) continue;
      var blob = res.getBlob();
      var b64 = Utilities.base64Encode(blob.getBytes());
      // Worker 端單張上限約 700KB base64,這裡留一點餘裕
      if (b64.length <= 650 * 1024) {
        var type = String(blob.getContentType() || "image/jpeg");
        if (type.indexOf("image/") !== 0) type = "image/jpeg";
        return "data:" + type + ";base64," + b64;
      }
    } catch (err) {
      Logger.log("⚠ 取照片失敗(" + fileId + ", w" + widths[i] + "):" + err);
    }
  }
  Logger.log("⚠ 照片太大或取不到,這張略過:" + fileId);
  return "";
}

/* 觸發器不見了(手動刪掉、或表單重建過)時用這個補回來。
   需要先在「指令碼屬性」加一筆 MEMBER_FORM_EDIT_URL = 表單的**編輯**網址
   (createNewMemberForm 執行紀錄印的第 ③ 個,結尾是 /edit)。
   會先清掉同名的舊觸發器,不會累積成好幾個。 */
function setupNewMemberTrigger() {
  var editUrl = PropertiesService.getScriptProperties().getProperty("MEMBER_FORM_EDIT_URL");
  if (!editUrl) throw new Error("請先在「專案設定 → 指令碼屬性」加一筆 MEMBER_FORM_EDIT_URL(表單的編輯網址,結尾是 /edit)");

  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === NEWMEMBER_TRIGGER) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  var form = FormApp.openByUrl(editUrl);
  ScriptApp.newTrigger(NEWMEMBER_TRIGGER).forForm(form).onFormSubmit().create();
  Logger.log("✅ 觸發器已重建(清掉舊的 " + removed + " 個):" + form.getTitle());
}

/* 不改任何東西,只檢查設定對不對:屬性有沒有設、Worker 連得上嗎、觸發器在不在。
   表單一直沒有進待認領區時先跑這個。 */
function checkNewMemberSetup() {
  var props = PropertiesService.getScriptProperties();
  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  Logger.log("RELAY_URL     :" + (relay || "✗ 沒設"));
  Logger.log("INTAKE_SECRET :" + (secret ? "已設(" + String(secret).length + " 個字)" : "✗ 沒設"));

  var n = 0, all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) if (all[i].getHandlerFunction() === NEWMEMBER_TRIGGER) n++;
  Logger.log("送出觸發器    :" + (n ? n + " 個" : "✗ 沒有 —— 請跑 setupNewMemberTrigger"));

  if (!relay || !secret) return;
  // 故意送一份不完整的申請:secret 對的話會回 bad_applicant,代表這條路是通的
  var res = UrlFetchApp.fetch(relay + "/intake", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ secret: secret, applicant: {} }), muteHttpExceptions: true });
  var body = res.getContentText();
  if (body.indexOf("bad_applicant") >= 0)      Logger.log("連線與密碼    :✅ 正常(回 bad_applicant 是預期的,因為刻意送空白)");
  else if (body.indexOf("bad_secret") >= 0)    Logger.log("連線與密碼    :✗ INTAKE_SECRET 與 Cloudflare 上的不一樣");
  else if (body.indexOf("intake_disabled") >= 0) Logger.log("連線與密碼    :✗ Cloudflare 上還沒設 INTAKE_SECRET");
  else Logger.log("連線與密碼    :? HTTP " + res.getResponseCode() + " " + body);
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
    ["要修改名錄:請到名錄後台逐欄編輯後發布。本站沒有匯入功能,在這裡改字不會影響網站。"],
    ["做產業小組 PDF:新增分頁,用 =FILTER('名冊(自動同步)'!A:S, '名冊(自動同步)'!D:D=\"A1\") 之類擷取各組,排版後 檔案 → 下載 → PDF。"],
    ["催收缺資料:用 FILTER 篩「照片」「名片」「我有」「我要」等欄為空白的列。"],
    ["名冊鏡像固定網址:https://ivanzhong085.github.io/member-directory/roster.csv"],
    ["把這份試算表的網址貼進 site-config.js 的 ROSTER_SHEET_URL,後台工具列就會出現捷徑。"],
  ]);
  Logger.log("✅ 名冊鏡像試算表建立完成:" + ss.getUrl());
  Logger.log("把上面網址貼進 site-config.js 的 ROSTER_SHEET_URL。");
}
