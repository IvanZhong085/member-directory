/**
 * 雲榮鑽石分會・來賓參訪報名表單(Google Apps Script)
 *
 * 這個檔只做兩件事,各對應一個函式,彼此獨立、可以只跑其中一個:
 *   createVisitorForm()  建立「來賓參訪報名」表單 + 報名回應試算表(來賓 CRM)
 *   createRosterSheet()  建立「名冊鏡像」試算表(A1 放 IMPORTDATA,名錄一發布就自動跟上)
 *   setupVisitorNotify() 裝上「有人報名就寄信到分會信箱」的觸發器(做一次;之後用 checkVisitorNotify 確認)
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
 * ⚠ 重複執行 createVisitorForm 會被擋下(建立過就記在指令碼屬性裡)。
 *   要改題目請直接到表單編輯頁改;真的要重建請先跑 forgetForms_()。
 *
 * ── 夥伴資料更新表單(已上架的夥伴自己補公司等文字資料)──────────────
 * 送出後不會直接上線:先進私有的「待審核」區,組長在後台逐欄確認才寫進名錄。
 * 部署步驟、審核方式與常見問題(含「被灌單怎麼辦」)見 README「八、夥伴資料更新表單」。
 *   createMemberUpdateForm()       建立更新表單 + 回應試算表 + 兩個觸發器(做一次)
 *   checkMemberUpdateForm()        逐項檢查(只讀不改);全部 ✅ 才把網址發到 LINE
 *   syncMemberUpdateNames()        名字選單照公開名錄更新(觸發器每小時自動跑,也可以手動跑)
 *   printMemberUpdateLinkConfig()  重印要貼進 site-config.js 的兩行
 *   resendFailedMemberUpdates()    補送所有「可自動補送」的失敗送件
 *   resendMemberUpdate("回應 ID", "A1・正確姓名")   指定名字補送一筆(名字可省略)
 *   dismissFailedMemberUpdate("回應 ID")           處理完的那筆移出補送清單
 *   setupMemberUpdateTriggers()    觸發器不見或重複時重裝
 *   forgetMemberUpdateForm()       要重建更新表單時先跑(會先關閉舊表單,不影響另外兩份表單)
 */

/* 建立「來賓參訪報名」表單:回應進獨立試算表,當作來賓 CRM。
   五個欄位:姓名、電話、LINE ID、職業必填;引薦人姓名選填(自己找上門的來賓也收得到)。 */
function createVisitorForm() {
  guardAlreadyCreated_("VISITOR_FORM_EDIT_URL", "createVisitorForm", "來賓參訪報名");
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
  PropertiesService.getScriptProperties().setProperty("VISITOR_FORM_EDIT_URL", form.getEditUrl());
}

/* ══ 來賓表單的 entry 編號 ═══════════════════════════════════════════════
   visitor.html 上的內嵌報名表單,是把資料送到 Google 表單的 formResponse 端點;
   每一題要用它自己的「entry.<數字>」當欄位名。這兩支就是拿來取得與核對那些編號的。

   printVisitorFormEntryIds()  印出一段可以直接貼進 worker/publish-relay.js 的設定
   checkVisitorEntryIds()      核對 Worker 裡那份設定是不是還跟表單對得上

   編號怎麼來的:用官方 API createResponse().toPrefilledUrl() 產生預填網址,
   再從網址裡把 entry.<數字> 解析出來 —— 比自己去翻表單網頁原始碼可靠。
   ⚠ 改題目、刪掉重加一題,編號就會變,而且送出會**安靜地少一欄**。
     動過表單之後請跑一次 checkVisitorEntryIds()。 */
var VISITOR_FIELD_TITLES = {
  name:     "姓名",
  phone:    "電話",
  line:     "LINE ID",
  job:      "職業",
  referrer: "引薦人姓名",
};

/* 表單各題 → entry 編號。回傳 { 欄位鍵: "entry.123", … };對不上的欄位不會出現在結果裡。 */
function visitorEntryIds_() {
  var editUrl = PropertiesService.getScriptProperties().getProperty("VISITOR_FORM_EDIT_URL");
  if (!editUrl) throw new Error("指令碼屬性沒有 VISITOR_FORM_EDIT_URL —— 請先跑 createVisitorForm,或手動補上表單的編輯網址");
  var form = FormApp.openByUrl(editUrl);

  /* 給每一題填一個獨一無二的標記,再從預填網址反查它落在哪個 entry。
     直接比對題目標題會被全半形、空白差異卡住,標記則是我們自己給的,不會弄錯。 */
  var items = form.getItems(), marks = {}, resp = form.createResponse();
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.getType() !== FormApp.ItemType.TEXT) continue;   // 來賓表單五題都是單行文字
    var mark = "ZZMARK" + i + "ZZ";
    marks[mark] = normTitle_(it.getTitle());
    resp = resp.withItemResponse(it.asTextItem().createResponse(mark));
  }
  var url = resp.toPrefilledUrl();

  // 反查:網址裡每個 entry.NNN=ZZMARKiZZ,對回題目標題,再對回我們的欄位鍵
  var byTitle = {};
  var re = /[?&](entry\.\d+)=([^&]*)/g, m;
  while ((m = re.exec(url)) !== null) {
    var val = decodeURIComponent(m[2]);
    if (marks[val]) byTitle[marks[val]] = m[1];
  }
  var out = {};
  for (var key in VISITOR_FIELD_TITLES) {
    if (!Object.prototype.hasOwnProperty.call(VISITOR_FIELD_TITLES, key)) continue;
    var t = normTitle_(VISITOR_FIELD_TITLES[key]);
    if (byTitle[t]) out[key] = byTitle[t];
  }
  return { form: form, ids: out, seenTitles: byTitle };
}

/* 印出可以直接貼進 Worker 的設定 */
function printVisitorFormEntryIds() {
  var r = visitorEntryIds_();
  var formId = String(r.form.getPublishedUrl()).replace(/^.*\/forms\/d\/e\/([^\/]+)\/.*$/, "$1");
  var missing = [];
  for (var key in VISITOR_FIELD_TITLES) {
    if (Object.prototype.hasOwnProperty.call(VISITOR_FIELD_TITLES, key) && !r.ids[key]) missing.push(key + "(" + VISITOR_FIELD_TITLES[key] + ")");
  }
  Logger.log("把下面這兩段貼進 worker/publish-relay.js,取代原本的 VISITOR_FORM_ID 與 VISITOR_ENTRY:");
  Logger.log("");
  Logger.log('const VISITOR_FORM_ID = "' + formId + '";');
  Logger.log("const VISITOR_ENTRY = {");
  Logger.log('  name: "' + (r.ids.name || "") + '", phone: "' + (r.ids.phone || "") + '", line: "' + (r.ids.line || "") + '",');
  Logger.log('  job: "' + (r.ids.job || "") + '", referrer: "' + (r.ids.referrer || "") + '",');
  Logger.log("};");
  Logger.log("");
  if (missing.length) {
    Logger.log("⚠ 這些欄位對不上表單題目:" + missing.join("、"));
    Logger.log("  表單上實際有的文字題:" + objKeys_(r.seenTitles).join("、"));
    Logger.log("  題目改過名字的話,請一起改上面的 VISITOR_FIELD_TITLES。");
  } else {
    Logger.log("✅ 五個欄位都對得上。貼進 Worker 之後記得 Deploy。");
  }
}

/* 核對 Worker 裡的設定還對不對(改過表單之後跑這支) */
function checkVisitorEntryIds() {
  var r = visitorEntryIds_();
  var n = 0;
  for (var key in VISITOR_FIELD_TITLES) {
    if (!Object.prototype.hasOwnProperty.call(VISITOR_FIELD_TITLES, key)) continue;
    if (r.ids[key]) { Logger.log("  " + key + "(" + VISITOR_FIELD_TITLES[key] + ")→ " + r.ids[key]); n++; }
    else Logger.log("  ✗ " + key + "(" + VISITOR_FIELD_TITLES[key] + ")→ 表單上找不到這一題");
  }
  Logger.log(n === 5
    ? "✅ 五題都在。請比對這些編號與 Worker 裡的 VISITOR_ENTRY 是否一致,不一致就重跑 printVisitorFormEntryIds 並重貼。"
    : "⚠ 只對上 " + n + " 題 —— 這樣送出會安靜地少欄位,請先修好表單題目或 VISITOR_FIELD_TITLES。");
}

/* ══ 有人報名時寄信到分會信箱 ═══════════════════════════════════════════
   來賓在 visitor.html 送出報名後,資料只會靜靜地多一列在來賓 CRM 試算表裡 ——
   沒有人會每天去開那張表,於是「有人報名了」這件事常常隔好幾天才被發現。
   這一段掛一個「表單送出」觸發器,每收到一筆就寄一封信到分會信箱。

   收件人(依序找第一個有設的):
     VISITOR_NOTIFY_EMAIL  來賓報名通知專用(setVisitorNotifyEmail 設定)
     NOTIFY_EMAIL          新申請通知(組長群)
     ALERT_EMAIL           失敗通知(分會信箱)
     腳本擁有者            都沒設時的退路

   ★ 信裡會有電話與 LINE ID —— 那正是接待夥伴要聯繫來賓用的。所以這封信只寄到
     分會自己的信箱;不要在信箱設自動轉寄到群組,要轉寄前先想一下收件人是誰。

   設定(做一次):函式下拉選單選 setupVisitorNotify → 執行 → 看執行紀錄。
   它會裝好觸發器、印出收件人與授權狀態,並寄一封測試信;之後想再確認就跑 checkVisitorNotify。 */
var VISITOR_TRIGGER = "onVisitorSubmit";

function visitorNotifyEmail_() {
  var props = PropertiesService.getScriptProperties();
  var keys = ["VISITOR_NOTIFY_EMAIL", "NOTIFY_EMAIL", "ALERT_EMAIL"];
  for (var i = 0; i < keys.length; i++) {
    var v = String(props.getProperty(keys[i]) || "").trim();
    if (v) return v;
  }
  return alertEmail_();   // 退回腳本擁有者;取不到就回空字串,由呼叫端記錄「沒寄出」
}

/* 設定來賓報名通知的收件人;傳空字串就是清掉(退回 NOTIFY_EMAIL / ALERT_EMAIL / 擁有者)。 */
function setVisitorNotifyEmail(email) { return setNotifyProp_("VISITOR_NOTIFY_EMAIL", email, "來賓報名通知"); }

/* 表單回應 → { name, phone, line, job, referrer }。題目標題對照 VISITOR_FIELD_TITLES;
   對不上的題目一律忽略 —— 多一題或改了題目,信照寄,只是那一欄會是「(未填)」。 */
function visitorAnswers_(e) {
  var byTitle = {};
  var items = (e && e.response) ? e.response.getItemResponses() : [];
  for (var i = 0; i < items.length; i++) {
    var v = items[i].getResponse();
    byTitle[normTitle_(items[i].getItem().getTitle())] = v == null ? "" : String(v);
  }
  var out = {};
  for (var key in VISITOR_FIELD_TITLES) {
    if (!Object.prototype.hasOwnProperty.call(VISITOR_FIELD_TITLES, key)) continue;
    var t = normTitle_(VISITOR_FIELD_TITLES[key]);
    out[key] = Object.prototype.hasOwnProperty.call(byTitle, t) ? byTitle[t] : "";
  }
  return out;
}

/* 壓成一行:主旨與各欄位都不能被多行填答撐爆;超過上限就截。 */
function oneLine_(s, max) {
  var v = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  var cap = max || 200;
  return v.length > cap ? v.slice(0, cap) + "…" : v;
}

/* 組信件內容。獨立成純函式是為了能在本機測試(tests/google-form.test.mjs)。 */
function visitorMailText_(a, when, sheetUrl) {
  var who = shortName_(a.name);
  var job = oneLine_(a.job, 80);
  var subject = "【來賓報名】" + who + (job ? "(" + job + ")" : "");
  var body =
    "有一位來賓在名錄網站報名參訪，請接待夥伴用 LINE 聯繫，確認場次與座位。\n\n" +
    "姓名：" + who + "\n" +
    "電話：" + (oneLine_(a.phone) || "(未填)") + "\n" +
    "LINE ID：" + (oneLine_(a.line) || "(未填)") + "\n" +
    "職業：" + (job || "(未填)") + "\n" +
    "引薦人：" + (oneLine_(a.referrer) || "(沒有引薦人，自己找上門的)") + "\n" +
    "送出時間：" + when + "\n\n" +
    (sheetUrl ? "來賓 CRM 試算表（這一筆在最下面一列，記得填追蹤狀態）：\n" + sheetUrl + "\n\n" : "") +
    "⚠ 這封信含來賓的電話與 LINE ID，請不要轉寄到群組。" +
    MAIL_FOOTER_;
  return { subject: subject, body: body };
}

/* 「表單送出」觸發器的處理函式。這裡任何一步失敗都只記執行紀錄:
   來賓那一筆早就安全地寫進試算表了,寄不出通知不能變成例外去嚇人。 */
function onVisitorSubmit(e) {
  if (!e || !e.response) {
    Logger.log("這個函式是給「表單送出」觸發器跑的,不能直接按執行。要裝觸發器請跑 setupVisitorNotify。");
    return;
  }
  var to = visitorNotifyEmail_();
  var a = visitorAnswers_(e);
  if (!to) {
    Logger.log("✗ 沒有收件人(VISITOR_NOTIFY_EMAIL / NOTIFY_EMAIL / ALERT_EMAIL 都沒設,也取不到腳本擁有者),這筆報名沒有寄通知：" + shortName_(a.name));
    return;
  }
  var when = "";
  try { when = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm"); }
  catch (err) { when = String(new Date()); }
  var sheetUrl = "";
  try {
    var destId = (e.source && e.source.getDestinationId) ? e.source.getDestinationId() : "";
    if (destId) sheetUrl = SpreadsheetApp.openById(destId).getUrl();
  } catch (err) { /* 拿不到就不附連結,信照寄 */ }
  var mail = visitorMailText_(a, when, sheetUrl);
  var sent = sendMail_(to, mail.subject, mail.body);
  // 執行紀錄只放姓名、不放電話與 LINE:紀錄是另一個會被人看到的地方
  Logger.log(sent ? "✉ 來賓報名通知已寄到 " + to + "：" + shortName_(a.name)
                  : "✗ 來賓報名通知寄不出去：" + shortName_(a.name) + "(這筆資料仍在試算表裡)");
}

/* 裝上「表單送出」觸發器(先清掉同名舊的,不會累積),然後印狀態、寄測試信。 */
function setupVisitorNotify() {
  var editUrl = PropertiesService.getScriptProperties().getProperty("VISITOR_FORM_EDIT_URL");
  if (!editUrl) throw new Error("指令碼屬性沒有 VISITOR_FORM_EDIT_URL —— 請先跑 createVisitorForm,或到「專案設定 → 指令碼屬性」補上表單的編輯網址(結尾是 /edit)");
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === VISITOR_TRIGGER) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  var form = FormApp.openByUrl(editUrl);
  ScriptApp.newTrigger(VISITOR_TRIGGER).forForm(form).onFormSubmit().create();
  Logger.log("✅ 來賓報名觸發器已裝好(清掉舊的 " + removed + " 個):" + form.getTitle());
  visitorNotifyStatus_(true);
}

/* 不改任何東西:印出觸發器、收件人、授權狀態,並寄一封測試信。 */
function checkVisitorNotify() { visitorNotifyStatus_(true); }

function visitorNotifyStatus_(sendTest) {
  var n = 0, all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) if (all[i].getHandlerFunction() === VISITOR_TRIGGER) n++;
  Logger.log("來賓報名觸發器 :" + (n ? "✅ " + n + " 個" : "✗ 沒有 —— 請跑 setupVisitorNotify"));
  var own = String(PropertiesService.getScriptProperties().getProperty("VISITOR_NOTIFY_EMAIL") || "").trim();
  var to = visitorNotifyEmail_();
  Logger.log("VISITOR_NOTIFY_EMAIL:" + (own || "(沒設 → 依序退回 NOTIFY_EMAIL / ALERT_EMAIL / 腳本擁有者)"));
  Logger.log("實際收件人      :" + (to || "✗ 取不到 —— 請跑 setVisitorNotifyEmail(\"分會信箱\")"));
  if (needsReauth_()) {
    Logger.log("授權狀態        :🔴 需要重新授權 —— 授權完成前觸發器不會跑,報名不會寄信");
    Logger.log("   👉 用瀏覽器打開這個網址完成授權(複製整行):" +
      (reauthUrl_() || "(取不到授權網址 —— 到左側「觸發條件」頁,點觸發器的「⋮」→ 執行一次)"));
    return;
  }
  Logger.log("授權狀態        :✅ 不需要重新授權");
  if (!sendTest || !to) return;
  var ok = sendMail_(to, "【來賓報名】通知設定測試",
    "看到這封信代表來賓報名通知寄得出去。\n之後每一筆報名都會寄一封到這個信箱。" + MAIL_FOOTER_);
  Logger.log(ok ? "測試信          :✅ 已寄到 " + to : "測試信          :✗ 寄不出去(見上方錯誤)");
}

function objKeys_(o) { var a = []; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) a.push(k); return a; }

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
   4. 執行紀錄會印出表單網址,以及「還要手動加三個上傳題」的指示。
   5. 照著指示開表單編輯頁,用滑鼠加三個「上傳檔案」題(標題要一字不差)。
      —— Apps Script 沒有建立上傳題的方法,這是 Google 的限制,只能手動加。
   6. 回來執行 checkNewMemberForm 核對 13 題都對得上。
   7. 把「給新夥伴填的網址」貼進 site-config.js 的 MEMBER_FORM_URL,發布網站。
   8. 自己填一筆測試(三個上傳題都放一張圖),再執行 checkPhotoAccess 確認照片收得到。

   ── 收不到照片時 ────────────────────────────────────────────
   執行 checkPhotoAccess,它會拿最後一筆回應實測,直接告訴你斷在哪:
     「沒有上傳任何檔案」→ 表單那次就沒選圖,重填一次即可,程式沒問題。
     「Drive 讀不到」    → 腳本沒有 Drive 權限。這個函式本身會跳授權,允許後就好了。
                          (加了新權限之後觸發器會暫停,手動執行一次授權完就恢復。)
     「縮圖拿不到」      → 會自動改用原檔;原檔也超過 190KB 時這一張會失敗,
                           而失敗會讓**整筆申請不送出**(見 onNewMemberSubmit),
                           資料仍完整留在表單回應與 Drive,修好後可補送。
     「不是名錄收得下的圖片格式」→ 那個檔不是圖片(例如把 PDF 傳到照片題)。

   ⚠ 這份表單有「上傳照片」題,Google 會要求填答者**登入 Google 帳號**才能送出。
     這是 Google 的規定,沒有辦法關掉;不想要就把三個上傳題刪掉。
   ⚠ 重複執行 createNewMemberForm 會被擋下(建立過就記在指令碼屬性裡)。
     真的要重建(換 Google 帳號、表單被誤刪)請先跑 forgetForms_(),它會告訴你下一步。
     搬到另一個 Google 帳號的完整步驟見 docs/搬到另一個-google-帳號.md。
*/

var NEWMEMBER_TRIGGER = "onNewMemberSubmit";

/* 這兩支 create* 每跑一次就會多建一份表單、一份試算表、一個上傳資料夾,
   而且**舊的那份不會消失** —— 你會得到兩份同名的東西,分不出哪份是活的,
   還可能繼續收到填進舊表單的回應。註解寫「不要重複執行」擋不住手滑,所以改成程式擋。

   真的要重建(例如換 Google 帳號、或表單被誤刪)時:先跑 forgetForms_(),
   或到「專案設定 → 指令碼屬性」把對應那筆刪掉。
   ⚠ 忘掉之後舊表單仍然存在於 Drive,只是這個腳本不再指向它 —— 記得自己去刪。 */
/* forgetFn:要重建時該先跑哪一支。更新表單有自己的 forgetMemberUpdateForm() ——
   forgetForms_() 刻意不碰它,免得重建更新表單時把新夥伴表單與來賓表單的綁定一起忘掉。 */
function guardAlreadyCreated_(propKey, fnName, label, forgetFn) {
  var url = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!url) return;
  throw new Error(
    "「" + label + "」表單已經建立過了,不要再跑一次 " + fnName + " ——\n" +
    "  現有的表單:" + url + "\n" +
    "  要改題目請直接開上面那個網址。\n" +
    "  真的要重建(例如換 Google 帳號)請先執行 " + (forgetFn || "forgetForms_()") + ",它會告訴你接下來該做什麼。");
}

/* 讓這個腳本「忘記」目前綁定的表單,之後才能重新建立。
   不會刪掉 Drive 上的任何東西 —— 刪除要你自己確認過再手動做,程式不該替你決定。 */
function forgetForms_() {
  var props = PropertiesService.getScriptProperties();
  var keys = ["MEMBER_FORM_EDIT_URL", "VISITOR_FORM_EDIT_URL"];
  var removed = [];
  for (var i = 0; i < keys.length; i++) {
    var v = props.getProperty(keys[i]);
    if (v) { props.deleteProperty(keys[i]); removed.push(keys[i] + " → " + v); }
  }
  if (!removed.length) { Logger.log("目前沒有綁定任何表單,直接跑 create… 就可以了。"); return; }
  Logger.log("已忘記以下綁定(Drive 上的檔案沒有被刪除):");
  for (var j = 0; j < removed.length; j++) Logger.log("   " + removed[j]);
  Logger.log("");
  Logger.log("接下來:");
  Logger.log("  1. 上面那些舊表單如果不要了,請自己到 Drive 刪掉(連同它們的回應試算表與上傳資料夾)");
  Logger.log("  2. 確認 RELAY_URL 與 INTAKE_SECRET 兩筆指令碼屬性還在");
  Logger.log("  3. 重新執行 createNewMemberForm / createVisitorForm");
  Logger.log("  4. 手動加三個上傳題,再跑 checkNewMemberForm 核對");
  Logger.log("  5. 把新的表單網址貼回 site-config.js 的 MEMBER_FORM_URL / VISITOR_FORM_URL");
}

/* 表單題目是靠**標題**對應到欄位的,但手動加的題目很容易打出看不出差別的字:
   全形「／」與半形「/」、刪節號「…」與三個點、多打一個空白。
   比對前先把這些差異抹平,免得使用者盯著兩個看起來一樣的字串找半天。
   (完全不同的字仍然對不上,那時 checkNewMemberForm 會把實際標題印出來。) */
function normTitle_(s) {
  return String(s == null ? "" : s)
    .replace(/[\uFF0F\u2215\u2044]/g, "/")   // ／ ∕ ⁄ → /
    .replace(/\uFF08/g, "(").replace(/\uFF09/g, ")")   // （ ） → ( )
    .replace(/\u2026/g, "...")                 // … → ...
    .replace(/\s+/g, "")
    .toLowerCase();
}
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
  image:          "形象照",
  card:           "名片照片",
  products:       "商品照片(商品圖、示意圖、證書皆可)",
};

/* 同一個欄位也接受這些寫法。表單題目是給人看的,遲早有人會覺得某個詞更好懂而改掉;
   與其每次都要回頭改程式,不如把用過的說法都收進來。
   比對一律經過 normTitle_(),所以括號全半形、斜線、空白的差異不用列在這裡。 */
var NEWMEMBER_ALIASES = {
  image:    ["個人照片", "大頭照", "半身照", "個人照"],
  card:     ["名片"],
  products: ["商品／服務照片", "商品照片", "服務照片"],
};

/* 這個欄位在表單上叫什麼(主要標題 + 所有別名),正規化後的清單 */
function titlesFor_(key) {
  var out = [normTitle_(NEWMEMBER_Q[key])];
  var alt = NEWMEMBER_ALIASES[key] || [];
  for (var i = 0; i < alt.length; i++) out.push(normTitle_(alt[i]));
  return out;
}
/* 從「正規化標題 → 值」的表裡,挑出這個欄位對得上的第一個 */
function pickByTitle_(map, key) {
  var names = titlesFor_(key);
  for (var i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(map, names[i])) return map[names[i]];
  }
  return undefined;
}

function createNewMemberForm() {
  guardAlreadyCreated_("MEMBER_FORM_EDIT_URL", "createNewMemberForm", "新夥伴資料填寫");
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

  /* ⚠ 三個「上傳檔案」題不在這裡建立。
     Apps Script 的 FormApp **沒有**建立上傳題的方法(沒有 addFileUploadItem),
     這是 Google 的限制,上傳題只能在表單編輯畫面用滑鼠加。
     所以這裡只建文字題,上傳題請照下方執行紀錄印出的步驟手動補三題,
     題目名稱必須一字不差,送出處理是靠標題對應欄位的。
     沒補也不會壞:那三題不存在時,申請一樣會進待認領區,只是沒有照片。 */

  var ss = SpreadsheetApp.create("雲榮鑽石分會・新夥伴資料填寫(回應)");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  ScriptApp.newTrigger(NEWMEMBER_TRIGGER).forForm(form).onFormSubmit().create();
  PropertiesService.getScriptProperties().setProperty("MEMBER_FORM_EDIT_URL", form.getEditUrl());

  Logger.log("✅ 文字題已建立,送出觸發器已掛上");
  Logger.log("① 給新夥伴填的網址(貼進 site-config.js 的 MEMBER_FORM_URL):" + form.getPublishedUrl());
  Logger.log("② 回應試算表(備份用,主要流程不靠它):" + ss.getUrl());
  Logger.log("③ 表單編輯網址(下一步要用):" + form.getEditUrl());
  Logger.log("");
  Logger.log("⚠ 還差三個上傳題,要手動加(Apps Script 建不了上傳題,這是 Google 的限制)");
  Logger.log("   開上面第 ③ 個網址 → 右下「+」新增問題 → 題型選「上傳檔案」→ 依序加這三題:");
  Logger.log("   1. 標題「" + NEWMEMBER_Q.image + "」    必填、只允許圖片、最多 1 個檔案");
  Logger.log("   2. 標題「" + NEWMEMBER_Q.card + "」    選填、只允許圖片、最多 1 個檔案");
  Logger.log("   3. 標題「" + NEWMEMBER_Q.products + "」  選填、只允許圖片、最多 5 個檔案");
  Logger.log("   ★ 標題要一字不差(含全形括號與空格),送出處理是靠標題對應欄位的。");
  Logger.log("   加完回來執行 checkNewMemberForm,它會逐題核對。");
}

/* 核對表單題目與程式的欄位對應表。手動加完上傳題之後跑這個,
   它會列出每一題「有沒有、題型對不對」,不改任何東西。 */
function checkNewMemberForm() {
  var editUrl = PropertiesService.getScriptProperties().getProperty("MEMBER_FORM_EDIT_URL");
  if (!editUrl) throw new Error("找不到 MEMBER_FORM_EDIT_URL —— 請先跑 createNewMemberForm,或到「專案設定 → 指令碼屬性」手動填入表單的編輯網址");

  var form = FormApp.openByUrl(editUrl);
  var actual = {}, realTitle = {};
  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    var k = normTitle_(items[i].getTitle());
    actual[k] = items[i].getType();
    realTitle[k] = items[i].getTitle();
  }

  var wantUpload = { image: 1, card: 1, products: 1 };
  var missing = 0, wrongType = 0, used = {};
  Logger.log("表單:" + form.getTitle());
  Logger.log("─────────────────────────────────────────────");
  for (var key in NEWMEMBER_Q) {
    var title = NEWMEMBER_Q[key];
    var names = titlesFor_(key), norm = null;
    for (var n = 0; n < names.length; n++) if (actual[names[n]]) { norm = names[n]; break; }
    var type = norm ? actual[norm] : undefined;
    if (type) {
      used[norm] = 1;
      if (norm !== names[0]) title = realTitle[norm] + "（別名，對應「" + NEWMEMBER_Q[key] + "」）";
    }
    var isUpload = !!wantUpload[key];
    if (!type) {
      Logger.log("✗ 缺少「" + title + "」" + (isUpload ? "(上傳題,要手動加)" : ""));
      missing++;
    } else if (isUpload && String(type) !== "FILE_UPLOAD") {
      Logger.log("✗ 「" + title + "」題型是 " + type + ",應該是「上傳檔案」");
      wrongType++;
    } else {
      Logger.log("✓ " + title + "  (" + type + ")");
    }
  }
  Logger.log("─────────────────────────────────────────────");
  if (!missing && !wrongType) {
    Logger.log("✅ 13 題全部對得上,可以開始收件了");
  } else {
    Logger.log("還有 " + missing + " 題缺少、" + wrongType + " 題題型不對。缺上傳題不影響其他資料,只是收不到照片。");
    // 把「表單上有、但程式不認得」的題目印出來 —— 標題打錯時一眼就看得出來
    var extras = [];
    for (var nk in actual) if (!used[nk]) extras.push("「" + realTitle[nk] + "」(" + actual[nk] + ")");
    if (extras.length) {
      Logger.log("");
      Logger.log("表單上這些題目程式不認得,對照上面缺少的,多半是標題打錯:");
      for (var x = 0; x < extras.length; x++) Logger.log("   " + extras[x]);
      Logger.log("改標題時請直接複製上面「缺少」那行的字串,不要自己打。");
    }
  }

  var n = 0, all = ScriptApp.getProjectTriggers();
  for (var j = 0; j < all.length; j++) if (all[j].getHandlerFunction() === NEWMEMBER_TRIGGER) n++;
  Logger.log(n ? "送出觸發器:✓ 已掛上" : "送出觸發器:✗ 沒有 —— 請跑 setupNewMemberTrigger");
  Logger.log("給新夥伴填的網址:" + form.getPublishedUrl());
}

/* 表單送出時自動觸發:把這份回應整理好,送到 Worker 的 /intake。
   任何一步失敗都寫進執行紀錄,回應本身仍留在試算表裡,不會遺失。 */
/* ══ 通知 ═════════════════════════════════════════════════════════════════
   為什麼需要這一段:先前申請沒送成功時,只寫進 Logger.log 就 return。
   Apps Script 只有在函式**拋例外**時才會寄失敗信給擁有者,而這裡是正常 return ——
   一封信都不會發。而執行紀錄沒有人會主動去看。

   結果就是:填表的新夥伴看到「已送出」,名錄這邊零感知,申請一筆一筆掉,
   要等到有人剛好想起來去翻執行紀錄才會發現。R2 還沒綁的那段時間正是這樣過去的。

   兩個獨立的收件人,都是「專案設定 → 指令碼屬性」裡的一筆:
     ALERT_EMAIL  失敗通知。這封是「東西壞了要修」,一定要寄;沒設就退回腳本擁有者。
     NOTIFY_EMAIL 新申請進待認領區的通知。這封是「有人在等你認領」,
                  沒設就不寄 —— 不是每個分會都想要每一筆都收信。

   ★ 信裡只放姓名、錯誤碼與處理建議。不放照片、不放 secret、不放完整申請內容 ——
     信會被轉寄、會留在收件匣,那不是放未認領者資料的地方。

   ⚠⚠ 貼上這一版之後**必須手動執行一次任一函式重新授權**(建議 checkNotifySetup)。
       MailApp 與 Session.getEffectiveUser 是這份腳本原本沒用過的 API,Apps Script
       靠靜態分析整個專案推導所需權限,而「送出表單」那個觸發器用的是**建立當下那份
       授權** —— 專案的權限集合一變大,舊授權就覆蓋不了,觸發器會以授權錯誤失敗。

       這個失敗模式正好就是這段程式碼要消滅的東西:觸發器根本沒跑,所以連失敗通知
       都發不出來;後台待認領區是空的,看起來就只是「最近沒人申請」。
       checkNewMemberSetup 會偵測這件事並印出紅字,請務必跑一次。 */
function alertEmail_() {
  var v = String(PropertiesService.getScriptProperties().getProperty("ALERT_EMAIL") || "").trim();
  if (v) return v;
  // 沒設就寄給腳本擁有者。取不到(權限或帳號類型)就回空字串,由呼叫端記錄「沒寄出」。
  try { return String(Session.getEffectiveUser().getEmail() || "").trim(); }
  catch (err) { return ""; }
}

/* 寄信本身失敗絕不能影響上面的結論。配額用完、收件人打錯都只記一行紀錄。 */
function sendMail_(to, subject, body) {
  if (!to) return false;
  try { MailApp.sendEmail(to, subject, body); return true; }
  catch (err) { Logger.log("⚠ 通知信寄不出去(不影響上面的結果):" + err); return false; }
}

var MAIL_FOOTER_ = "\n\n———\n這封信由會員名錄的 Apps Script 自動寄出，內容不含照片與密碼。";

/* 姓名來自表單,長度沒有保證(Worker 那頭會砍到 80,但這裡拿到的是原始值)。
   直接組進主旨的話,一個貼了幾千字的惡作劇填答會讓主旨爆掉、信件難讀。 */
function shortName_(s) {
  var v = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim();
  if (!v) return "(未填姓名)";
  return v.length > 80 ? v.slice(0, 80) + "…" : v;
}

function notifyIntakeFailure_(name, why, hint) {
  var who = shortName_(name);
  var to = alertEmail_();
  var sent = sendMail_(to, "【會員名錄】新夥伴申請沒有進待認領區：" + who,
    "有一筆新夥伴自填表單的申請沒有進到待認領區。\n\n" +
    "姓名：" + who + "\n" +
    "原因：" + why + "\n\n" +
    hint + "\n\n" +
    "表單回應與上傳的原始檔都完整保留在 Google 表單的回應試算表裡，修正後可以補送，不會遺失。" +
    MAIL_FOOTER_);
  Logger.log(sent ? "   ✉ 已通知 " + to
                  : "   ✉ 沒有寄出通知(沒設 ALERT_EMAIL,也取不到腳本擁有者信箱)");
}

function notifyIntakeSuccess_(name, pending) {
  var to = String(PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || "").trim();
  if (!to) return;                       // 選用功能,沒設就安靜略過
  var who = shortName_(name);
  sendMail_(to, "【會員名錄】有新夥伴等待認領：" + who,
    "「" + who + "」的自填資料已經進到待認領區。\n" +
    "目前共 " + pending + " 筆等待認領。\n\n" +
    "請組長到編輯頁的「新夥伴待認領」區認領：\n" +
    SITE_BASE_URL + "admin.html" +
    MAIL_FOOTER_);
}

/* 不改任何東西,只把通知設定印出來、並實際寄一封測試信。
   「以為有設好」與「真的收得到」是兩件事,而這條路只有在出事時才會被用到 ——
   那時候才發現寄不出去就太晚了。 */
/* 專案的權限集合變大之後,舊授權會失效,而**觸發器會安靜地停擺**。
   回傳 true 代表需要重新授權。這是唯一能在「申請開始掉」之前發現的方法。 */
function needsReauth_() {
  try {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    return info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED;
  } catch (err) { return false; }        // 取不到就別嚇人,下面的測試信照樣會驗到
}

/* 授權用的網址。
   ★ 為什麼需要它:這支腳本把 MailApp / Session 的呼叫都包在 try/catch 裡(寄信失敗
     絕不能連累申請送出),而「權限不足」正是以例外的形式出現 —— 於是它被一起吞掉,
     函式順順跑完,編輯器也就**不會跳出同意畫面**。
     結果是一個死結:檢查函式告訴你「要重新授權」,但你怎麼跑它都不會出現授權畫面。
     把 Google 給的授權網址直接印出來,是唯一一定走得到的路。 */
function reauthUrl_() {
  try { return ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizationUrl() || ""; }
  catch (err) { return ""; }
}

/* 設定失敗通知的收件人。用函式而不是叫人去「指令碼屬性」手動加一筆 ——
   屬性名稱打錯一個字就完全沒有效果,而且不會有任何提示。 */
function setAlertEmail(email) { return setNotifyProp_("ALERT_EMAIL", email, "失敗通知"); }

/* 設定「有新申請/有夥伴送來資料更新」的通知收件人(選用)。傳空字串就是關掉。 */
function setNotifyEmail(email) { return setNotifyProp_("NOTIFY_EMAIL", email, "新申請與資料更新通知"); }

function setNotifyProp_(key, email, label) {
  var v = String(email == null ? "" : email).trim();
  var props = PropertiesService.getScriptProperties();
  if (!v) {
    props.deleteProperty(key);
    Logger.log("已清掉 " + key + "(" + label + "改為不寄／退回腳本擁有者)");
    return;
  }
  // 只做基本形狀檢查:擋掉貼錯的網址或整段文字,不試圖驗證信箱真的存在
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error('看起來不像 email:「' + v + '」。用法:setAlertEmail("someone@gmail.com")');
  }
  props.setProperty(key, v);
  Logger.log("✅ " + key + " 已設為 " + v + "(" + label + ")");
  Logger.log("   接著跑 checkNotifySetup 確認授權並收一封測試信。");
}

function checkNotifySetup() {
  var props = PropertiesService.getScriptProperties();
  var alertTo = String(props.getProperty("ALERT_EMAIL") || "").trim();
  var notifyTo = String(props.getProperty("NOTIFY_EMAIL") || "").trim();
  var effective = alertEmail_();
  Logger.log("ALERT_EMAIL   :" + (alertTo || "(沒設 → 用腳本擁有者)"));
  Logger.log("實際收件人    :" + (effective || "✗ 取不到 —— 失敗通知會寄不出去,請設 ALERT_EMAIL"));
  Logger.log("NOTIFY_EMAIL  :" + (notifyTo ? notifyTo + "(新申請與夥伴資料更新通知)" : "(沒設 → 不寄新申請與夥伴資料更新通知)"));
  var visitorTo = String(props.getProperty("VISITOR_NOTIFY_EMAIL") || "").trim();
  Logger.log("VISITOR_NOTIFY_EMAIL:" + (visitorTo || "(沒設 → 來賓報名通知依序退回 NOTIFY_EMAIL / ALERT_EMAIL / 擁有者)"));
  try { Logger.log("今日可寄額度  :" + MailApp.getRemainingDailyQuota() + " 封"); }
  catch (err) { Logger.log("今日可寄額度  :取不到(通常就是還沒授權)"); }

  if (needsReauth_()) {
    var url = reauthUrl_();
    Logger.log("授權狀態      :🔴 需要重新授權");
    Logger.log("");
    Logger.log("   ⚠ 在授權完成之前,送出表單的觸發器不會執行,新夥伴申請與夥伴資料更新都會靜默失敗。");
    Logger.log("");
    /* 一定要把網址印出來:直接按「執行」不會跳出同意畫面(見 reauthUrl_ 的說明),
       只看到這段紅字卻找不到授權入口的話,人就卡在這裡了。 */
    Logger.log("   👉 用瀏覽器打開這個網址完成授權(複製整行,含結尾):");
    Logger.log("   " + (url || "(取不到授權網址 —— 改用編輯器左側「觸發條件」頁," +
                               "點任一觸發器的「⋮」→ 執行一次,那裡會強制跳出同意畫面)"));
    Logger.log("");
    Logger.log("   同意之後回來再跑一次 checkNotifySetup,這段紅字消失就代表好了。");
    return;                     // 還沒授權就別往下試寄信 —— 一定失敗,徒增困惑
  }
  Logger.log("授權狀態      :✅ 不需要重新授權");
  if (!effective) {
    Logger.log("測試信        :跳過(沒有收件人)—— 跑 setAlertEmail(\"你的信箱\") 設一個");
    return;
  }
  var ok = sendMail_(effective, "【會員名錄】通知設定測試",
    "看到這封信代表失敗通知寄得出去。\n" +
    "真正的通知只會在新夥伴的申請沒有進到待認領區時寄出。" + MAIL_FOOTER_);
  Logger.log(ok ? "測試信        :✅ 已寄到 " + effective : "測試信        :✗ 寄不出去(見上方錯誤)");
}

function onNewMemberSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  if (!relay || !secret) {
    Logger.log("✗ 沒設 RELAY_URL / INTAKE_SECRET,這筆沒有送出");
    notifyIntakeFailure_("(設定未完成)", "Apps Script 少了 RELAY_URL 或 INTAKE_SECRET",
      "請到「專案設定 → 指令碼屬性」補上這兩筆,再跑一次 checkNewMemberSetup 確認。");
    return;
  }

  var byTitle = {};
  var items = e.response.getItemResponses();
  for (var i = 0; i < items.length; i++) {
    byTitle[normTitle_(items[i].getItem().getTitle())] = items[i].getResponse();
  }
  var text = function (key) { var v = pickByTitle_(byTitle, key); return v == null ? "" : String(v); };
  var files = function (key) {
    var v = pickByTitle_(byTitle, key);
    if (!v) return [];
    return (Object.prototype.toString.call(v) === "[object Array]" ? v : [v]).filter(String);
  };

  var photos = files("image"), cards = files("card"), products = files("products");
  // 照片沒進來時,這行決定要往哪查:0 張是表單沒上傳,有張數才是這邊抓不到
  Logger.log("收到照片:形象照 " + photos.length + " 張、名片 " + cards.length + " 張、商品 " + products.length + " 張");

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
    image:          "",
    card:           "",
    products:       [],
  };

  /* ★ 轉圖失敗不可以變成空字串送出去。
     先前的做法是「拿不到就回 ""」,而 Worker 看到空值只會當成「使用者沒有上傳這一張」——
     於是 /intake 回報成功、photoWarnings 是空的、後台也只覺得照片比較少,
     沒有任何人知道其實有一張照片處理失敗了。表單那頭更是完全無感。
     現在:表單上傳了幾張,就必須成功轉出幾張;任何一張失敗就**整筆不送**,
     資料與原檔都還在 Form/Drive,修好之後可以補送。
     ★ 商品照也不再先 .filter() —— 那會讓索引與原始欄位對不起來,查問題時找錯張。 */
  var photoFails = [];
  var conv = function (id, label, field) {
    var url = driveImageDataUrl_(id, 900, label);
    if (!url) photoFails.push(field);
    return url;
  };
  if (photos.length) applicant.image = conv(photos[0], "形象照", "image");
  if (cards.length)  applicant.card  = conv(cards[0], "名片照片", "card");
  var prodIds = products.slice(0, 5);
  for (var pi = 0; pi < prodIds.length; pi++) {
    applicant.products.push(conv(prodIds[pi], "商品照片 " + (pi + 1), "product[" + pi + "]"));
  }

  Logger.log("照片處理結果:形象照 " + (photos.length ? (applicant.image ? "✓" : "✗") : "—") +
             "、名片 " + (cards.length ? (applicant.card ? "✓" : "✗") : "—") +
             "、商品 " + applicant.products.filter(String).length + "/" + prodIds.length + " 張");

  if (photoFails.length) {
    Logger.log("✗ 這一筆【沒有】送出:" + applicant.name +
               " —— 有上傳照片但轉檔失敗(" + photoFails.join("、") + ")。" +
               "\n   常見原因:Drive 還沒產出縮圖(稍後重試即可)、原檔超過上限、或不是圖片格式。" +
               "\n   表單回應與原始檔都完整保留,修正後可請網管補送 —— 不會遺失。");
    notifyIntakeFailure_(applicant.name, "照片轉檔失敗(" + photoFails.join("、") + ")",
      "常見原因:Drive 還沒產出縮圖(稍後重跑一次通常就好)、原檔太大、或上傳的不是圖片格式。");
    return;
  }

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
    notifyIntakeFailure_(applicant.name, "連不到發布服務(Cloudflare Worker)",
      "請確認 Worker 還在線上、RELAY_URL 沒有打錯。網路只是暫時抖動的話,補送一次即可。");
    return;
  }
  /* ★ 真的把回應解析出來,不要只用字串比對。
     照片改存私有 R2 之後,Worker 會在照片有問題時**整筆退回**(而不是像以前那樣
     靜默丟掉一張照片仍回報成功)。所以這裡的紀錄必須讓人一眼看出:
     這一筆到底進去了沒有、卡在哪一個欄位、要不要人工補送。 */
  var code = res.getResponseCode(), body = res.getContentText();
  var out = null;
  try { out = JSON.parse(body); } catch (err2) { out = null; }

  if (code === 200 && out && out.ok === true) {
    Logger.log("✅ 已送進待認領區:" + applicant.name +
               "(pid " + out.pid + "、照片 " + (out.photos || 0) + " 張、目前共 " + out.pending + " 筆)");
    /* Worker 回報的警告:記下是哪一位、哪一個欄位、什麼原因,但**不記照片內容**。 */
    if (out.warnings && out.warnings.length) {
      for (var wi = 0; wi < out.warnings.length; wi++) {
        Logger.log("   ⚠ " + out.pid + " 欄位 " + out.warnings[wi].field + ":" + out.warnings[wi].reason);
      }
    }
    notifyIntakeSuccess_(applicant.name, out.pending);
  } else {
    var why = out && out.error ? out.error : ("HTTP " + code);
    var where = out && out.field ? "(欄位 " + out.field + ")" : "";
    var hint =
      why === "pending_image_store_unavailable" ? "Worker 還沒接上待認領照片的儲存空間(R2),請先完成設定再重送。" :
      why === "pending_image_too_large"         ? "照片超過單張上限,請用較小的圖或降低表單上傳解析度。" :
      why === "invalid_pending_image"           ? "照片格式不是名錄收得下的 JPEG/PNG/WebP。" :
      why === "pending_full"                    ? "待認領區已滿,請組長先認領或刪除幾筆再重送。" :
      why === "pending_entry_too_large"         ? "文字欄位太長,請縮短後重送。" :
      "請把這行紀錄提供給網管。";
    Logger.log("✗ 這一筆【沒有】進待認領區:" + applicant.name + " —— " + why + where +
               "\n   " + hint +
               "\n   回應仍完整留在試算表裡,修正後可請網管手動補送(不會遺失)。");
    notifyIntakeFailure_(applicant.name, why + where, hint);
  }

  /* 照片歸檔(選用,見 setPhotoArchiveFolder)。
     刻意排在送出「之後」而且整段包起來:歸檔只是整理,失敗絕不能讓新夥伴的申請掉了。
     照片這時已經讀成 base64 送出去了,搬動檔案不影響上面任何一步。 */
  try {
    archiveSubmissionPhotos_(applicant.name, [
      { ids: photos.slice(0, 1),   label: "形象照" },
      { ids: cards.slice(0, 1),    label: "名片" },
      { ids: products.slice(0, 5), label: "商品照" },
    ]);
  } catch (err) {
    Logger.log("⚠ 照片歸檔略過(不影響上面的申請):" + err);
  }
}

/* Drive 上的照片 → data:image/jpeg;base64,…(名錄後台認得的格式)。
   用 Drive 的縮圖服務指定寬度,而不是原檔——手機照片動輒 3–5MB,原檔送不過去。
   太大就再降一級寬度重試。

   縮圖有三個實際會踩到的狀況,所以不是「一次拿不到就放棄」:
   ① 表單剛上傳完就觸發,Drive 還沒把縮圖產出來,前幾秒問會是 404 —— 等一下再問。
   ② 縮圖網址有兩種,不是每個環境兩種都通(見 thumbBlob_)—— 兩種都試。
   ③ 有些檔案 Drive 始終不產縮圖 —— 退回用原檔,小張的照片這樣就夠了。
   全部失敗才回傳空字串(照片沒了,其他資料照樣進待認領區),並在紀錄裡寫清楚卡在哪。 */
function driveImageDataUrl_(fileId, maxWidth, label) {
  /* 從 900 開始往下降,取**位元組上限之內能拿到的最大解析度**(不是「取最小的圖」)。
     原本階梯是 [maxWidth, 600, 400],而呼叫端傳進來的 maxWidth 偏大,於是一張名片
     進來 665KB。900px 寬的名片字仍然看得清楚,檔案約 80~150KB;拿不到才降到 700、500。
     照片現在存在私有 R2、不進公開 repo,所以這個階梯只跟「畫質 vs 單張上限」有關,
     與「同時能有幾筆待認領」已經完全脫鉤(見 worker 的 MAX_PENDING_ENTRY_BYTES)。 */
  var widths = [Math.min(maxWidth || 900, 900), 700, 500];
  var tag = (label || "照片") + "(" + fileId + ")";
  var state = { code: 0, note: "" };

  for (var round = 0; round < 3; round++) {
    if (round) Utilities.sleep(2000);   // ① 等 Drive 把縮圖產出來
    var gotThumb = false;
    for (var i = 0; i < widths.length; i++) {
      var blob = thumbBlob_(fileId, widths[i], state);
      if (!blob) continue;
      gotThumb = true;
      var out = blobToDataUrl_(blob, tag);
      if (out) return out;
    }
    if (gotThumb) break;   // 縮圖拿得到,只是每一級都太大 —— 再等也不會變小
  }

  try {   // ③ 縮圖始終拿不到,改用原檔
    var out2 = blobToDataUrl_(DriveApp.getFileById(fileId).getBlob(), tag);
    if (out2) { Logger.log("· " + tag + ":改用原檔(拿不到縮圖)"); return out2; }
    Logger.log("⚠ " + tag + ":原檔超過上限(190KB)又沒有縮圖 —— 這一筆申請不會送出,請改用較小的圖重新上傳");
  } catch (err2) {
    Logger.log("⚠ " + tag + ":讀不到檔案(縮圖最後回 HTTP " + state.code + ")" + err2 +
               (state.note ? "\n   " + state.note : "") +
               "\n   多半是這個腳本還沒拿到 Drive 權限 —— 手動執行一次 checkPhotoAccess 重新授權。");
  }
  return "";
}

/* 指定寬度的縮圖 blob;拿不到回 null,並把最後看到的 HTTP 碼寫進 state 讓上層報告。
   兩條路都試,因為它們的認證方式不一樣:
   ① Drive API 的 thumbnailLink —— 官方文件寫的做法。用 OAuth token 問到一個
      短效的圖片網址,再去抓那個網址。私人檔案要拿縮圖,這條才是正規路徑。
   ② drive.google.com/thumbnail —— 網頁版在用的網址。它本來是給瀏覽器帶
      cookie 用的,不保證認 Bearer token,私人檔案很可能怎麼問都是 404;
      但有些環境走得通,所以留著當備援。 */
function thumbBlob_(fileId, width, state) {
  try {
    var meta = UrlFetchApp.fetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?fields=thumbnailLink",
      { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    state.code = meta.getResponseCode();
    if (state.code === 200) {
      var link = "";
      try { link = String(JSON.parse(meta.getContentText()).thumbnailLink || ""); }
      catch (e) { state.note = "thumbnailLink 解不開:" + e; }
      if (link) {
        // 結尾的 =s220 之類是尺寸參數,換成我們要的寬度。只有在最後一個「/」之後
        // 出現的「=」才是尺寸,不然會把網址本身切壞。
        var cut = link.lastIndexOf("=");
        var sized = (cut > link.lastIndexOf("/") ? link.slice(0, cut) : link) + "=w" + width;
        var img = UrlFetchApp.fetch(sized, { muteHttpExceptions: true });   // 短效網址,不要再帶 token
        if (img.getResponseCode() === 200) return img.getBlob();
        state.code = img.getResponseCode();
      }
    }
  } catch (err) { state.note = String(err); }

  try {
    var res = UrlFetchApp.fetch(
      "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w" + width,
      { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (res.getResponseCode() === 200) return res.getBlob();
    state.code = res.getResponseCode();
  } catch (err2) { state.note = String(err2); }

  return null;
}

/* 照片收不到時跑這個(手動執行,不是觸發器)。做兩件事:
   ① 用到 DriveApp,所以會跳授權 —— 腳本拿到 Drive 權限,縮圖那條路才會通。
      (加了新權限之後觸發器會暫停,手動執行一次授權完就會恢復。)
   ② 拿表單「最後一筆回應」裡真正上傳的檔案來實測,把每一關的結果印出來:
      Drive 讀不讀得到、縮圖回幾號、轉出來多大。這樣不必猜是哪一段斷掉。 */
function checkPhotoAccess() {
  var editUrl = PropertiesService.getScriptProperties().getProperty("MEMBER_FORM_EDIT_URL");
  if (!editUrl) throw new Error("請先在「專案設定 → 指令碼屬性」加一筆 MEMBER_FORM_EDIT_URL(表單的編輯網址,結尾是 /edit)");

  var responses = FormApp.openByUrl(editUrl).getResponses();
  if (!responses.length) { Logger.log("表單還沒有任何回應,先去填一筆(記得上傳照片)再跑這個。"); return; }

  var items = responses[responses.length - 1].getItemResponses();
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].getItem().getType() !== FormApp.ItemType.FILE_UPLOAD) continue;
    var v = items[i].getResponse();
    var list = (Object.prototype.toString.call(v) === "[object Array]" ? v : [v]).filter(String);
    Logger.log("「" + items[i].getItem().getTitle() + "」:" + list.length + " 個檔案");
    for (var j = 0; j < list.length; j++) ids.push(list[j]);
  }
  Logger.log("─────────────────────────────────────────────");
  if (!ids.length) {
    Logger.log("最後一筆回應沒有上傳任何檔案 —— 所以照片是空的,程式這邊沒問題。");
    Logger.log("請再填一次表單,三個上傳題都選一張圖再送出。");
    return;
  }

  for (var k = 0; k < ids.length; k++) {
    var id = ids[k];
    try {
      var file = DriveApp.getFileById(id);
      Logger.log("✓ Drive 讀得到:" + file.getName() + "(" + Math.round(file.getSize() / 1024) + " KB, " + file.getMimeType() + ")");
    } catch (err) {
      Logger.log("✗ Drive 讀不到 " + id + ":" + err);
      continue;
    }
    var state = { code: 0, note: "" };
    var thumb = thumbBlob_(id, 900, state);
    Logger.log(thumb ? "   縮圖 ✓(" + thumb.getContentType() + ")"
                     : "   縮圖拿不到(最後回 HTTP " + state.code + (state.note ? "," + state.note : "") + "),會改用原檔");
    var url = driveImageDataUrl_(id, 900, "測試");
    Logger.log(url ? "   → 轉出 " + Math.round(url.length / 1024) + " KB 的圖,這張沒問題 ✓"
                   : "   → 轉不出來 ✗(上面那行寫了原因)");
  }
  Logger.log("─────────────────────────────────────────────");
  Logger.log("全部 ✓ 的話,重填一次表單照片就會跟著進待認領區了。");
}

/* 名錄只收這三種格式(Worker 的 DATA_IMG_RE 也是這樣把關),其餘一律先轉檔 */
var DATA_URL_TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1 };

/* 圖片 blob → data URL;超過 Worker 的單張上限就回空字串,讓呼叫端換小一級再試。
   格式不對的先轉成 JPEG —— iPhone 預設拍的是 HEIC,直接送出去會被 Worker
   當成不合格的照片默默丟掉,人只會看到「照片沒有進來」而查不出原因。
   真的轉不了(例如把 PDF 傳到照片題)就回空字串,不要硬掰成 image/jpeg:
   標錯型別送出去照樣過得了驗證,但名錄上會是一張破圖,更難查。 */
function blobToDataUrl_(blob, tag) {
  var type = String(blob.getContentType() || "");
  if (!DATA_URL_TYPES[type]) {
    try { blob = blob.getAs("image/jpeg"); type = "image/jpeg"; }
    catch (err) {
      Logger.log("⚠ " + (tag || "照片") + ":不是名錄收得下的圖片格式(" + (type || "未知") + "),略過");
      return "";
    }
  }
  var bytes = blob.getBytes();
  /* Worker 端單張上限是**解碼後 200KB**(PENDING_IMG_BYTES_MAX),這裡以同樣的單位
     留一點餘裕。照片改存私有 R2 之後,7 張都保得住,不會再因為「單筆總額」而被
     靜默丟掉其中幾張 —— 所以這裡也不再做任何總額判斷。 */
  if (bytes.length > 190 * 1024) return "";
  return "data:" + type + ";base64," + Utilities.base64Encode(bytes);
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

  var fromProp = props.getProperty("PHOTO_ARCHIVE_FOLDER_ID");
  var archiveId = fromProp || PHOTO_ARCHIVE_FOLDER_ID_DEFAULT;
  var source = fromProp ? "指令碼屬性" : "程式碼預設值";
  if (!archiveId) {
    Logger.log("照片歸檔      :未啟用(要開就跑 setPhotoArchiveFolder(\"資料夾網址\"),或填 PHOTO_ARCHIVE_FOLDER_ID_DEFAULT)");
  } else {
    try {
      var af = DriveApp.getFolderById(archiveId);
      Logger.log("照片歸檔      :✅ " + af.getName() + "/新夥伴照片/(來源:" + source + ")");
      Logger.log("                " + af.getUrl());
      Logger.log("                ⚠ 照片會繼承這個資料夾的共用設定,請確認它不是「知道連結的任何人」");
    } catch (err) {
      Logger.log("照片歸檔      :✗ 資料夾打不開(可能被刪或沒權限,來源:" + source + "):" + err);
    }
  }

  var cn = 0;
  for (var k = 0; k < all.length; k++) if (all[k].getHandlerFunction() === CLEANUP_TRIGGER) cn++;
  Logger.log("每月清理照片  :" + (cn ? "✅ 已排定(每月 1 號)" : "未啟用(要開就跑 setupPhotoCleanupTrigger)"));

  /* 申請沒送成功時唯一會主動通知人的路徑。沒設定的話,失敗就只留在執行紀錄裡 ——
     而那正是「表單看起來正常、申請卻一直沒進來」最常見的原因。 */
  Logger.log("失敗通知      :" + (alertEmail_() ? "✅ 寄給 " + alertEmail_() + "(細節與測試信跑 checkNotifySetup)"
                                                : "✗ 沒有收件人 —— 申請送失敗時不會有人知道,請設 ALERT_EMAIL"));

  /* ★ 最容易被忽略、後果卻最嚴重的一項。放在最後印,因為它會蓋掉上面所有的 ✅ ——
     授權沒完成的話,觸發器根本不會跑,上面每一行設定得多正確都沒有用。 */
  if (needsReauth_()) {
    Logger.log("");
    Logger.log("🔴🔴🔴 授權需要更新 —— 目前每一筆新夥伴申請都會靜默失敗 🔴🔴🔴");
    Logger.log("   這一版的程式碼用到了新的 Google 權限(寄信、讀取自己的帳號信箱)。");
    Logger.log("   Apps Script 的觸發器用的是「建立當時那份授權」,權限一變大它就會停擺,");
    /* 措辭修正:Google **會**寄「Summary of failures for Google Apps Script」給腳本擁有者。
       但那是每日彙總、標題長得像系統雜訊、而且在它寄達之前申請已經在掉了;
       這支腳本自己的失敗通知信更是完全發不出去(觸發器根本沒跑到那一行)。
       把話說準比說重要 —— 講成「完全沒有通知」的話,收到彙總信的人會以為是別的問題。 */
    Logger.log("   自己的失敗通知信完全發不出去(觸發器根本沒跑到那一行);");
    Logger.log("   Google 只會寄每日的「Summary of failures」彙總,很容易被當成雜訊略過。");
    Logger.log("   ⚠ 直接按「執行」不會跳出同意畫面(權限錯誤被 try/catch 吞掉了),");
    Logger.log("     請跑 checkNotifySetup,它會印出可以直接打開的授權網址。");
  } else {
    Logger.log("授權狀態      :✅ 不需要重新授權");
  }

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

/* ══ 照片自動歸檔 ══════════════════════════════════════════════════════
   表單上傳的照片一律落在 Google 自己建的「(File responses)」資料夾,檔名是
   「題目名稱 - 填答者姓名.jpg」全部混在一起,而且你手動整理完,下一筆送出又掉回去。
   所以歸檔要讓程式在每次送出時自己做:

       <你指定的資料夾>/新夥伴照片/<姓名>_<日期>/姓名_形象照.jpg
                                                  姓名_名片.jpg
                                                  姓名_商品照1.jpg …

   幾個刻意的決定:
   ① 用「移動」而不是「複製」——複製會佔兩份空間,而且日後看到兩張不知道哪張是本尊。
      移動不改檔案 ID,所以回應試算表裡那條連結照樣點得開,這支腳本讀照片也不受影響。
   ② 移進去之後,照片會**繼承目的資料夾的分享設定** —— 這正是重點:資料夾分享給誰,
      誰就看得到照片,不必一張一張開權限。
   ③ 沒設 PHOTO_ARCHIVE_FOLDER_ID 就整個跳過,不影響原本的運作(這是選用功能)。
   ④ 整段包在 try/catch 裡、而且排在送出待認領區「之後」——歸檔失敗絕不能連累新夥伴
      的申請送不出去。

   設定方式:執行一次 setPhotoArchiveFolder("<資料夾網址或 ID>")。 */

/* 指定歸檔資料夾。參數可以直接貼 Drive 網址,也可以只給 ID。
   會實際寫入一次做權限測試 —— 設定當下就知道行不行,而不是等到有人填表才發現。 */
function setPhotoArchiveFolder(folderIdOrUrl) {
  var raw = String(folderIdOrUrl || "").trim();
  if (!raw) throw new Error('請帶入資料夾網址或 ID,例如 setPhotoArchiveFolder("https://drive.google.com/drive/folders/xxxx")');
  /* 從網址裡挑出 ID;直接給 ID 也吃得下。挑不出來就當場說清楚 ——
     不然會把整串網址當成 ID 送去 Drive,錯誤訊息變成一長串網址,看不出是貼錯了。 */
  var m = raw.match(/\/folders\/([-\w]+)/) || raw.match(/^([-\w]+)$/);
  if (!m) throw new Error('看不出資料夾 ID。請貼資料夾網址(像 https://drive.google.com/drive/folders/xxxx)或只貼 ID,你給的是:' + raw);
  var id = m[1];
  var folder = DriveApp.getFolderById(id);  // 找不到或沒權限會在這裡拋錯,訊息比自己寫的清楚
  var probe = childFolder_(folder, "新夥伴照片");   // 建得出子資料夾 = 真的有寫入權
  PropertiesService.getScriptProperties().setProperty("PHOTO_ARCHIVE_FOLDER_ID", id);
  Logger.log("✅ 照片歸檔資料夾已設定:" + folder.getName());
  Logger.log("   照片會放進:" + folder.getName() + "/" + probe.getName() + "/<姓名>_<日期>/");
  Logger.log("   " + folder.getUrl());
  Logger.log("提醒:照片會繼承這個資料夾的分享設定,請確認它分享給的是你想給的人。");
}

/* 預設的歸檔資料夾。填了就不必再執行 setPhotoArchiveFolder ——
   貼上這份程式碼、掛好觸發器,照片就會自動歸檔。留空字串則代表不啟用。

   ⚠ 這個 repo 是公開的,任何人都讀得到下面這串 ID。
      ID 本身不是密碼,能不能打開**完全取決於這個資料夾的「共用」設定**:
        設成「限制」+ 逐一加人  → 拿到 ID 也打不開,安全。
        設成「知道連結的任何人」→ 等於把裡面的來賓電話、LINE ID 公開給所有讀得到
                                  這個 repo 的人,而且若權限是「編輯者」還能被刪檔。
      所以填在這裡的前提是:那個資料夾的共用設定必須是「限制」。 */
var PHOTO_ARCHIVE_FOLDER_ID_DEFAULT = "1wDCAN41GguTkRKN-6PKHxWjjXhZigZBt";

/* 取得歸檔資料夾;沒設定或拿不到就回 null(呼叫端會安靜跳過歸檔)。
   指令碼屬性優先於上面的預設值 —— 換帳號或臨時改目的地時,不必動程式碼。 */
function photoArchiveFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty("PHOTO_ARCHIVE_FOLDER_ID")
        || PHOTO_ARCHIVE_FOLDER_ID_DEFAULT;
  if (!id) return null;
  try { return DriveApp.getFolderById(id); }
  catch (err) { Logger.log("⚠ 照片歸檔資料夾打不開(" + err + "),這次跳過歸檔"); return null; }
}

/* 找同名子資料夾,沒有才建 —— 每次送出都會呼叫,不能每次都長一個新的出來 */
function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* Drive 檔名安全字元:斜線會被當成路徑分隔、控制字元會讓檔名看起來像空的。
   中文、空白、連字號都是合法檔名字元,不動它們(把「陳 大文」變成「陳大文」只會讓人找不到)。
   控制字元用 charCodeAt 逐字剔除,不寫進正規表示式 —— 這個檔要整份貼進 Apps Script 編輯器,
   原始碼裡不該出現真的控制位元組。 */
function safeFileName_(s) {
  var raw = String(s == null ? "" : s).replace(/[\/\\:*?"<>|]/g, "");
  var out = "";
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charCodeAt(i);
    if (c > 31 && c !== 127) out += raw.charAt(i);
  }
  out = out.trim();
  return out.slice(0, 60) || "未具名";
}

/* 把這一筆送出的照片全部搬進歸檔資料夾並改成看得懂的檔名。
   groups = [{ ids:[Drive 檔案 id…], label:"形象照" }, …] */
function archiveSubmissionPhotos_(name, groups) {
  var root = photoArchiveFolder_();
  if (!root) return;                       // 沒設定 = 沒開這個功能
  var person = safeFileName_(name);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
  var dest = childFolder_(childFolder_(root, "新夥伴照片"), person + "_" + stamp);

  var moved = 0, failed = 0;
  for (var g = 0; g < groups.length; g++) {
    var ids = groups[g].ids || [], label = groups[g].label;
    for (var i = 0; i < ids.length; i++) {
      try {
        var file = DriveApp.getFileById(ids[i]);
        var ext = String(file.getName()).match(/\.[A-Za-z0-9]{1,5}$/);
        file.setName(person + "_" + label + (ids.length > 1 ? (i + 1) : "") + (ext ? ext[0] : ""));
        /* moveTo 是現行做法;萬一這個環境的 DriveApp 沒有(舊版執行階段),
           退回「加到新資料夾 + 從舊資料夾移除」的老寫法,效果一樣。 */
        try { file.moveTo(dest); }
        catch (err) {
          dest.addFile(file);
          var parents = file.getParents();
          while (parents.hasNext()) {
            var p = parents.next();
            if (p.getId() !== dest.getId()) { try { p.removeFile(file); } catch (e2) {} }
          }
        }
        moved++;
      } catch (err) { failed++; Logger.log("⚠ " + label + " 歸檔失敗:" + err); }
    }
  }
  Logger.log("📁 照片已歸檔 " + moved + " 張" + (failed ? "(失敗 " + failed + " 張)" : "") +
             " → " + root.getName() + "/新夥伴照片/" + dest.getName());
}

/* ══ 每月清理:把「已經推上 GitHub」的照片從 Drive 移掉 ═══════════════════════
   照片認領發布之後就變成 repo 裡 images/ 的實體檔,Drive 那份只是中繼站,
   放著只是佔空間。這支每月自動清一次。

   ★ 判斷「已經推上 GitHub」的依據,是去讀**公開網站上的名錄**:
     某位夥伴出現在 data.js 裡、而且 image 欄是實體檔名(不是 data: 內嵌),
     就代表他的照片確實已經在 repo 裡了。不需要 GitHub 權杖,也不需要任何 AI ——
     就是一支定時執行的 Apps Script。

   刪之前要同時滿足三個條件,少一個就留著:
     ① 資料夾建立超過 CLEANUP_MIN_AGE_DAYS 天(剛送出的絕對不碰)
     ② 這個人不在待認領區(還沒被認領的當然不能刪)
     ③ 這個人在名錄上、而且有照片(這就是「已經推上 GitHub」的證據)

   而且:
   - 讀不到線上資料(網路問題、網址改了、格式變了)就**整批不刪** —— 寧可這個月
     沒清到,也不要因為查不到而誤刪。
   - 刪除是「移到垃圾桶」不是永久刪除,30 天內都救得回來。
   - 第一次請先跑 previewPhotoCleanup(),它只列出「會刪哪些」,不動任何東西。

   ⚠ repo 裡那份是寬度 900 的縮圖,不是原檔。清掉 Drive 這份等於放棄原始解析度。 */
var CLEANUP_TRIGGER = "cleanupArchivedPhotos";
var CLEANUP_MIN_AGE_DAYS = 30;                                        // 幾天內的一律不碰
var SITE_BASE_URL = "https://ivanzhong085.github.io/member-directory/";   // 公開名錄網址

/* 排定每月執行一次。會先清掉同名的舊觸發器,不會累積。 */
function setupPhotoCleanupTrigger() {
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === CLEANUP_TRIGGER) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  ScriptApp.newTrigger(CLEANUP_TRIGGER).timeBased().onMonthDay(1).atHour(3).create();
  Logger.log("✅ 每月清理已排定:每月 1 號凌晨 3 點左右執行(清掉舊的 " + removed + " 個)");
  Logger.log("   建議先手動跑一次 previewPhotoCleanup(),看它會刪哪些再決定。");
}

/* 只列出「會刪哪些」,不動任何東西 */
function previewPhotoCleanup() { photoCleanup_(true); }
/* 真的清理(觸發器呼叫的就是這支) */
function cleanupArchivedPhotos() { photoCleanup_(false); }

/* 比對姓名用:去掉所有空白、轉小寫。表單填的與名錄上的偶爾差一個空白。 */
function normName_(s) { return String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase(); }

/* 夥伴資料更新表單「請選你的名字」的選項文字:「A1・曾俊凱」。
   中間是 U+30FB「・」,和網站徽章「代號・組名」同一種寫法。
   ★ 後台 admin-logic.js 有一支逐字相同的 memberUpdateLabel:組長複製的預填連結靠這串字
     預選名字。兩邊只要差一個字(例如一邊用 U+00B7「·」),預填就選不到人,夥伴只會看到
     空白的選單 —— 而且不會有任何錯誤。所以 tests/logic.test.mjs 會載入這個檔比對兩邊的輸出,
     改這裡請一起改 admin-logic.js。 */
function memberUpdateLabel_(code, name) { return String(code).trim() + "・" + String(name).trim(); }

/* 抓公開網站上的檔案。加時間戳避開 GitHub Pages 的快取 —— 讀到舊版就可能誤判。 */
function fetchSite_(path) {
  var url = SITE_BASE_URL + path + (path.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* 公開名錄 data.js 的分組陣列。回 null 代表讀不到或看不懂 —— 呼叫端各自決定怎麼保守處理
   (照片清理整批不刪、名字選單維持原樣、建表單直接停下)。
   ★ 整段包在 try/catch 裡:fetchSite_ 用的 UrlFetchApp.fetch 遇到 DNS 失敗或逾時會直接丟例外,
     muteHttpExceptions 只吞得掉 HTTP 錯誤碼。漏接的話,每小時同步會變成一封封 Google 的失敗信。
   ★ data.js 是一段 JS(const GROUPS = [...];),只取第一個「[」到最後一個「]」交給 JSON.parse,
     不把網站上抓來的內容當程式執行。 */
function publishedGroups_() {
  try {
    var r = fetchSite_("data.js");
    if (r.code !== 200) { Logger.log("✗ 讀不到名錄 data.js(HTTP " + r.code + ")"); return null; }
    var a = r.text.indexOf("["), b = r.text.lastIndexOf("]");
    if (a < 0 || b <= a) { Logger.log("✗ data.js 格式看不懂"); return null; }
    var groups = JSON.parse(r.text.slice(a, b + 1));
    // 空名錄或缺欄位一律當作異常:拿它去同步選單會把所有人都清掉,拿去清照片會判成「查無此人」
    if (Object.prototype.toString.call(groups) !== "[object Array]" || !groups.length) {
      Logger.log("✗ 名錄是空的 —— 不正常,當作讀不到"); return null;
    }
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || typeof g.code !== "string" || Object.prototype.toString.call(g.members) !== "[object Array]") {
        Logger.log("✗ data.js 第 " + (i + 1) + " 組缺 code 或 members —— 不正常,當作讀不到"); return null;
      }
    }
    return groups;
  } catch (err) {
    Logger.log("✗ 讀不到名錄 data.js:" + errText_(err));
    return null;
  }
}

/* 名錄上「有實體照片」的成員姓名。回 null 代表讀不到或看不懂 —— 呼叫端會整批不刪。 */
function publishedNamesWithPhoto_() {
  var groups = publishedGroups_();
  if (!groups) return null;
  var map = {}, n = 0;
  for (var i = 0; i < groups.length; i++) {
    var ms = groups[i].members || [];
    for (var j = 0; j < ms.length; j++) {
      var img = String(ms[j].image || "");
      if (img && img.indexOf("data:") !== 0) { map[normName_(ms[j].name)] = true; n++; }
    }
  }
  Logger.log("名錄上有實體照片的成員:" + n + " 位");
  return map;
}

/* 待認領區的姓名。回 null 代表讀不到 —— 呼叫端會整批不刪。 */
function pendingNames_() {
  var r = fetchSite_("data/_pending.json");
  if (r.code === 404) { Logger.log("待認領區:沒有這個檔(等於空的)"); return {}; }
  if (r.code !== 200) { Logger.log("✗ 讀不到待認領區(HTTP " + r.code + ")"); return null; }
  var arr;
  try { arr = JSON.parse(r.text); } catch (err) { Logger.log("✗ 待認領區解析失敗:" + err); return null; }
  if (Object.prototype.toString.call(arr) !== "[object Array]") { Logger.log("✗ 待認領區格式看不懂"); return null; }
  var map = {};
  for (var i = 0; i < arr.length; i++) map[normName_(arr[i] && arr[i].name)] = true;
  Logger.log("待認領區:" + arr.length + " 筆");
  return map;
}

function photoCleanup_(dryRun) {
  var root = photoArchiveFolder_();
  if (!root) { Logger.log("沒有設定照片歸檔資料夾,沒東西可清"); return; }
  var it = root.getFoldersByName("新夥伴照片");
  if (!it.hasNext()) { Logger.log("還沒有「新夥伴照片」資料夾,沒東西可清"); return; }
  var box = it.next();

  /* 先把兩份線上資料都拿到手再動任何東西。任一份拿不到就整批放棄 ——
     「查不到」不等於「可以刪」,這是這支程式最重要的一條。 */
  var published = publishedNamesWithPhoto_();
  var pending = pendingNames_();
  if (!published || !pending) {
    Logger.log("⚠ 線上資料查不到,這次一個都不刪(寧可沒清到,也不要誤刪)");
    return;
  }

  var now = Date.now(), del = 0, keep = 0;
  var subs = box.getFolders();
  while (subs.hasNext()) {
    var f = subs.next(), fname = f.getName();
    var cut = fname.lastIndexOf("_");
    var person = normName_(cut > 0 ? fname.slice(0, cut) : fname);
    var ageDays = Math.floor((now - f.getDateCreated().getTime()) / 86400000);

    var why = "";
    if (ageDays < CLEANUP_MIN_AGE_DAYS) why = "才 " + ageDays + " 天,未滿 " + CLEANUP_MIN_AGE_DAYS + " 天";
    else if (pending[person]) why = "還在待認領區,尚未認領";
    else if (!published[person]) why = "名錄上查不到他的照片(還沒發布?被刪了?)";

    if (why) { keep++; Logger.log("  保留 " + fname + " —— " + why); continue; }
    if (dryRun) Logger.log("  [試算] 會刪 " + fname + "(" + ageDays + " 天前,照片已在名錄上)");
    else { f.setTrashed(true); Logger.log("  已移到垃圾桶 " + fname + "(" + ageDays + " 天前)"); }
    del++;
  }
  Logger.log(dryRun
    ? "試算結果:會刪 " + del + " 個、保留 " + keep + " 個。確認沒問題再執行 cleanupArchivedPhotos 或排定觸發器。"
    : "清理完成:刪 " + del + " 個、保留 " + keep + " 個。檔案在 Drive 垃圾桶,30 天內都救得回來。");
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

/* ══════════════════════════════════════════════════════════════════════════
   夥伴資料更新表單(已上架的夥伴自己更新文字資料)
   ══════════════════════════════════════════════════════════════════════════
   夥伴在下拉選單選「A1・曾俊凱」,只填要改的格子(空著＝不改),送出後由
   onMemberUpdateSubmit 轉給 Worker 的 /member-update,進私有 R2 的「待審核」區;
   組長在後台逐欄確認後,Worker 才寫進 data/<組>.json。完整說明見 README「八」。

   幾個刻意的決定(細節在各函式的註解):
   ① 這裡只負責「讀表單、轉送」。佔位字、網址補 https、和名錄現值比對全部交給 Worker ——
      規則集中在一處,測試也集中在一處。
   ② 先記錄、後送出:送件一進來就把回應 ID 記進補送清單(UPDATE_FAILED_IDS),確定成功才移除。
      中途任何例外、寄信失敗、執行逾時,都不會讓一筆送件無聲無息地消失。
   ③ 熔斷:1 小時超過 60 筆就自動暫停收件。這個帳號的觸發器時間、UrlFetch 與寄信額度,
      是新夥伴申請與來賓報名共用的,被灌單時要先保住它們。
   ④ 通知信只放過濾後的「代號・姓名」、錯誤碼與回應 ID,不放填答內容與備註 ——
      表單不必登入,任何拿到網址的人寫的字都不能原樣出現在信裡。
   ⑤ 執行紀錄同樣不記欄位內容。紀錄是另一個會被人看到的地方。 */

var UPDATE_TRIGGER      = "onMemberUpdateSubmit";
var UPDATE_SYNC_TRIGGER = "syncMemberUpdateNames";
var UPDATE_NOT_FOUND    = "找不到我的名字";
var UPDATE_FORM_TITLE   = "雲榮鑽石分會・夥伴資料更新";
var UPDATE_Q = {                       // 更新表單專用的題目(九個資料欄位沿用 NEWMEMBER_Q 的標題)
  member: "請選你的名字",
  page:   "要更新的內容",
  secNew: "補上還沒有的資料",
  secEdit:"修改名錄上已經有的內容",
  note:   "給組長的備註",
  token:  "連結代碼",
  nfPage: "找不到自己的名字？",
  nfName: "你的姓名",
  nfWhat: "想更新什麼",
};
/* 九個資料欄位。順序 = admin-logic.js 的 UPDATE_FIELD_ORDER = Worker 的 UPDATE_TOKEN_ORDER,
   tests/logic.test.mjs 會比對三份 —— 連結代碼的 9 段雜湊就是照這個順序排的。 */
var UPDATE_FIELD_KEYS = ["company","business_items","website","have","want","title","services","targets","tagline"];
/* site-config.js 的 UPDATE_FORM_ENTRIES 固定是這 11 個鍵(後台組預填連結用) */
var UPDATE_ENTRY_KEYS = ["member","title","company","services","targets","have","want","tagline","business_items","website","token"];
var UPDATE_MAIL_MIN_QUOTA      = 20;              // 剩餘額度低於這個數字時,只寄系統類失敗通知
var UPDATE_SUCCESS_MAIL_GAP_MS = 6 * 3600 * 1000;
var UPDATE_NF_MAIL_GAP_MS      = 6 * 3600 * 1000; // 「找不到名字」彙整信的間隔
var UPDATE_FLOOD_PER_HOUR      = 60;              // 熔斷門檻(全分會才 90 人,正常不會到)
var UPDATE_NAMEIDX_CACHE_S     = 600;             // 名錄索引快取 10 分鐘
var UPDATE_DEDUPE_MAX_KEYS     = 50;
var UPDATE_FAILED_MAX          = 100;
var UPDATE_RESEND_BUDGET_MS    = 5 * 60 * 1000;   // 補送迴圈的時間上限(Apps Script 單次最多 6 分鐘)
var UPDATE_MANUAL_CODES = ["member_not_found","member_ambiguous","update_too_large","bad_label","bad_update","flood_paused"];
var UPDATE_NF_NAMES_MAX  = 10;                    // 彙整信最多列幾個姓名
var UPDATE_PROP_MAX_BYTES = 8800;                 // 指令碼屬性單一值上限 9 KB,留一點餘裕
/* 這些結果代表「這筆處理完了」,補送時算成功 */
var UPDATE_DONE_CODES = ["ok","duplicate","unchanged","nothing_to_update","empty","name_not_found"];
var UPDATE_FLOOD_CLOSED_MSG = "這份表單暫停收件中，請稍後再試，或直接 LINE 你的組長。";
var UPDATE_RETIRED_MSG      = "這份夥伴資料更新表單已經停用，請跟你的產業小組組長要新的連結。";

/* 錯誤碼 → 信件類別與處理方式。cls:"sys" 寄 ALERT、同一碼 1 小時一封;"sub" 寄 NOTIFY(沒設退回 ALERT)、
   同一位同一碼每天一封。哪些會自動補送由 UPDATE_MANUAL_CODES 決定。
   「原因」取 hint 第一個「。」之前那一句;{rid} 寄信時換成回應 ID。 */
var UPDATE_SITE_HINT_ = "Worker 讀不到公開網站上的名錄（GitHub Pages）。請確認網站打得開；Worker 讀的網址可以在 checkMemberUpdateForm 的「Worker」那一行看到。修好後補送。";
var UPDATE_RETRY_HINT_ = "Worker 或 Apps Script 暫時出錯，稍後補送即可。";
var UPDATE_LABEL_HINT_ = "名字選項的格式不對（可能有人改了選項文字）。先執行 syncMemberUpdateNames；再到回應試算表看這筆選的是誰，執行 resendMemberUpdate(\"{rid}\", \"A1・正確姓名\")。";
var UPDATE_ERRORS_ = {
  config_missing:   { cls: "sys", hint: "Apps Script 少了 RELAY_URL 或 INTAKE_SECRET。請到「專案設定 → 指令碼屬性」補上，再跑 checkMemberUpdateForm。" },
  bad_secret:       { cls: "sys", hint: "Apps Script 的 INTAKE_SECRET 和 Cloudflare 上的不一樣。請兩邊改成完全一樣，再跑 checkMemberUpdateForm。" },
  intake_disabled:  { cls: "sys", hint: "Cloudflare 上還沒設 INTAKE_SECRET。設好之後跑 checkMemberUpdateForm，再補送。" },
  too_many_submissions: { cls: "sys", hint: "密碼錯太多次，Worker 暫停收件 15 分鐘。請先確認兩邊的 INTAKE_SECRET 一致，15 分鐘後再補送。" },
  rate_limit_unavailable: { cls: "sys", hint: "Worker 沒綁 RATE_LIMIT（KV），請總管理員檢查 Cloudflare 設定。" },
  pending_image_store_unavailable: { cls: "sys", hint: "Worker 還沒綁 R2（PENDING_IMAGES），待審核的更新沒地方放。請先完成 worker/README.md 4-2。" },
  not_found:        { cls: "sys", hint: "Worker 還沒更新到支援夥伴資料更新的版本。請總管理員重新部署 publish-relay.js。" },
  update_store_failed: { cls: "sys", hint: "Worker 寫入暫存空間失敗（通常是暫時的），稍後補送即可。" },
  site_unreachable: { cls: "sys", hint: UPDATE_SITE_HINT_ },
  group_unreadable: { cls: "sys", hint: UPDATE_SITE_HINT_ },
  server_error:     { cls: "sys", hint: UPDATE_RETRY_HINT_ },
  script_error:     { cls: "sys", hint: UPDATE_RETRY_HINT_ },
  bad_label:        { cls: "sys", hint: UPDATE_LABEL_HINT_ },
  bad_update:       { cls: "sys", hint: UPDATE_LABEL_HINT_ },
  flood_paused:     { cls: "sys", hint: "表單疑似被灌單、自動暫停收件那一刻進來的送件。確定是夥伴送的，執行 resendMemberUpdate(\"{rid}\")；其他的執行 dismissFailedMemberUpdate(\"{rid}\")。" },
  group_not_found:  { cls: "sub", hint: "選單上的組代號已經不存在（可能剛改名）。系統每小時會更新選單，補送時會用新的代號重找。" },
  member_not_found: { cls: "sub", hint: "名錄上找不到這位（可能剛改名、被刪除，或選錯人）。如果是改名或選錯人：請網管在 Apps Script 執行 resendMemberUpdate(\"{rid}\", \"A1・正確姓名\")；如果他已經不在名錄上：請組長 LINE 本人，處理完由網管執行 dismissFailedMemberUpdate(\"{rid}\")。" },
  member_ambiguous: { cls: "sub", hint: "同一組有兩位同名的夥伴，系統無法判斷是誰。請組長直接跟本人確認後在後台手動修改，再由網管執行 dismissFailedMemberUpdate(\"{rid}\")。" },
  update_too_large: { cls: "sub", hint: "內容太長。請組長 LINE 本人，請他縮短後重填；之後由網管執行 dismissFailedMemberUpdate(\"{rid}\")。" },
  too_many_updates_for_member: { cls: "sub", hint: "這位夥伴已經有 3 筆更新在等審核。請組長先到後台處理他的待審更新（如果那幾筆不是本人送的，直接按「不採用」）。之後補送或請本人重填，擇一即可（內容相同的不會重複建立）。" },
  updates_full:     { cls: "sub", hint: "待審核更新已經滿 100 筆。請組長盡快到後台處理（總管理員可以勾選後一次不採用），處理後再補送。" },
};

/* ── 小工具 ───────────────────────────────────────────────────────────── */

/* 例外訊息壓成一行、截短。只用在執行紀錄,訊息本身不含 secret(secret 只放在 payload 裡)。 */
function errText_(err) {
  return oneLine_(err && err.message ? err.message : String(err), 200);
}
function isArr_(a) { return Object.prototype.toString.call(a) === "[object Array]"; }
function hasOwn_(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

/* 指令碼屬性單一值上限是 9 KB(以 UTF-8 計),所以要自己數位元組 */
function utf8Len_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function scriptTz_() {
  try { return Session.getScriptTimeZone() || "Asia/Taipei"; } catch (err) { return "Asia/Taipei"; }
}
function fmtTime_(d, fmt) {
  try { return Utilities.formatDate(d, scriptTz_(), fmt); } catch (err) { return d.toISOString(); }
}

/* 屬性的讀改寫都包在這裡。觸發器可能同時跑好幾個(夥伴同時按送出、補送與送出交錯),
   不加鎖的話後寫的會蓋掉先寫的,補送清單就少一筆。
   10 秒拿不到鎖照樣執行:寧可多一點競態,也不要漏記。
   UrlFetch、寄信、sleep 一律不要放進來 —— 那會讓別的送件排隊等一個網路請求。 */
function withScriptLock_(fn) {
  var lock = null, got = false;
  try { lock = LockService.getScriptLock(); got = lock.tryLock(10000); }
  catch (err) { got = false; }
  if (!got) Logger.log("⚠ 拿不到鎖，照常寫入");
  try { return fn(); }
  finally {
    if (got) { try { lock.releaseLock(); } catch (err2) { /* 執行結束時 Google 會自己放掉 */ } }
  }
}

function readJsonProp_(key, fallback) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return fallback;
  try { var v = JSON.parse(raw); return v == null ? fallback : v; }
  catch (err) { return fallback; }
}

/* 「代號・姓名」拆開。代號要是 1–8 個英數字、姓名不能是空的,否則回 null。 */
function splitUpdateLabel_(label) {
  var s = String(label == null ? "" : label);
  var at = s.indexOf("・");
  if (at < 0) return null;
  var code = s.slice(0, at).trim(), name = s.slice(at + 1).trim();
  if (!/^[A-Za-z0-9]{1,8}$/.test(code) || !name) return null;
  return { code: code, name: name };
}

/* 信件裡的姓名只留「文字」:字母、組合符號、「・·」與空白。
   冒號、斜線、句點全部濾掉,就不可能組成網址;角括號濾掉,就不可能出現標籤。
   表單不必登入,任何人都能在姓名欄寫一段釣魚文字,這是它進到信裡之前唯一的關卡。 */
function safeNameText_(s, max) {
  var v = String(s == null ? "" : s);
  try { v = v.normalize("NFKC"); } catch (err) { /* 沒有 normalize 就照原樣過濾 */ }
  var kept = (v.match(/[\p{L}\p{M}・· ]/gu) || []).join("").replace(/ {2,}/g, " ").trim();
  return Array.from(kept).slice(0, max || 10).join("").trim();   // 以字(code point)計,不切壞罕用字
}
function safeName_(s, max) { return safeNameText_(s, max) || "(未留可辨識的姓名)"; }
/* 選項文字「A1・曾俊凱」過濾後再放進信裡。bad_label 的信會把選項原文寄出去,所以一樣要濾。 */
function safeLabel_(label) {
  var s = String(label == null ? "" : label);
  try { s = s.normalize("NFKC"); } catch (err) { /* 同上 */ }
  var at = s.indexOf("・");
  if (at < 0) return "(選項格式不對)";
  var code = s.slice(0, at).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return (code || "?") + "・" + safeName_(s.slice(at + 1), 20);
}

/* 欄位鍵清單(Worker 回的 ignored/invalid 是 {field, value},只取 field)。只給執行紀錄用。 */
function updateFieldKeys_(arr) {
  if (!isArr_(arr)) return [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = typeof arr[i] === "string" ? arr[i] : (arr[i] && typeof arr[i].field === "string" ? arr[i].field : "");
    if (/^[a-z_]{1,20}$/.test(k)) out.push(k);
  }
  return out;
}
function safeUid_(u) { return /^u_[a-z0-9]{6,40}$/.test(String(u)) ? String(u) : "?"; }

/* ── 補送清單(UPDATE_FAILED_IDS)───────────────────────────────────────
   [{rid, code, n, at}]:code 是最後一次的錯誤碼,n 是失敗次數,at 是第一次失敗的時間。
   code 是 "pending" 代表「收到了、還沒確定送進去」—— 執行中途當掉的就會停在這裡。 */
function failedRead_() {
  var a = readJsonProp_("UPDATE_FAILED_IDS", []);
  if (!isArr_(a)) return [];
  return a.filter(function (x) { return x && typeof x.rid === "string" && x.rid; });
}
function failedWrite_(arr) {
  var props = PropertiesService.getScriptProperties();
  if (!arr.length) { props.deleteProperty("UPDATE_FAILED_IDS"); return; }
  var dropped = [];
  while (arr.length > UPDATE_FAILED_MAX) dropped.push(arr.shift().rid);
  var s = JSON.stringify(arr);
  // 回應 ID 很長,100 筆可能超過 9 KB;超過就從最舊的丟 —— 內容仍在回應試算表裡
  while (utf8Len_(s) > UPDATE_PROP_MAX_BYTES && arr.length > 1) { dropped.push(arr.shift().rid); s = JSON.stringify(arr); }
  if (dropped.length) {
    Logger.log("⚠ 補送清單太長,丟掉最舊的 " + dropped.length + " 筆(回應 ID:" + dropped.join("、") + ";內容仍在回應試算表)");
  }
  props.setProperty("UPDATE_FAILED_IDS", s);
}
function failedPut_(rid, code) {
  try {
    withScriptLock_(function () {
      var arr = failedRead_(), hit = null;
      for (var i = 0; i < arr.length; i++) if (arr[i].rid === rid) { hit = arr[i]; break; }
      if (hit) {
        hit.code = code;
        if (code !== "pending") hit.n = (Number(hit.n) || 0) + 1;   // pending 不是失敗,不計次
      } else {
        arr.push({ rid: rid, code: code, n: code === "pending" ? 0 : 1, at: new Date().toISOString() });
      }
      failedWrite_(arr);
    });
    return true;
  } catch (err) {
    Logger.log("✗ 補送清單寫不進去(回應 ID " + rid + "、" + code + "):" + errText_(err));
    return false;
  }
}
function failedRemove_(rid) {
  var hit = null;
  try {
    withScriptLock_(function () {
      var arr = failedRead_();
      for (var i = 0; i < arr.length; i++) if (arr[i].rid === rid) { hit = arr.splice(i, 1)[0]; break; }
      if (hit) failedWrite_(arr);
    });
  } catch (err) {
    Logger.log("⚠ 補送清單移除失敗(回應 ID " + rid + "):" + errText_(err));
  }
  return hit;
}
/* auto:resendFailedMemberUpdates 會自動補送;manual:只列出來,等網管照建議處理 */
function failedList_() {
  var all = failedRead_(), out = { auto: [], manual: [] };
  for (var i = 0; i < all.length; i++) {
    (UPDATE_MANUAL_CODES.indexOf(all[i].code) >= 0 ? out.manual : out.auto).push(all[i]);
  }
  return out;
}

/* ── 寄信 ───────────────────────────────────────────────────────────────
   一般 Gmail 帳號每天只能寄給 100 位收件人,而且和來賓報名通知共用。
   所以每一類信都有節流,送件類與成功通知在額度快用完時直接略過,把額度留給系統類失敗通知。 */
function lowMailQuota_() {
  try { return MailApp.getRemainingDailyQuota() < UPDATE_MAIL_MIN_QUOTA; }
  catch (err) { return false; }          // 取不到就照寄,sendMail_ 自己會吞掉失敗
}
function notifyOrAlert_() {
  var v = String(PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || "").trim();
  return v || alertEmail_();
}

/* 同一個 key 在 ms 毫秒內只放行一次。回 true = 這次可以寄。
   UPDATE_MAIL_DEDUPE 是 {"去重鍵": ms};寫入時順便刪掉超過 1 天的鍵,最多留 50 個(屬性單值上限 9 KB)。
   讀寫丟例外時:系統類照常寄出(東西壞了一定要有人知道),送件類略過。 */
function mailOnce_(key, ms) {
  try {
    return withScriptLock_(function () {
      var now = Date.now();
      var map = readJsonProp_("UPDATE_MAIL_DEDUPE", {});
      if (!map || typeof map !== "object" || isArr_(map)) map = {};
      var last = hasOwn_(map, key) ? Number(map[key]) || 0 : 0;
      if (last && now - last < ms) return false;
      var keys = [];
      for (var k in map) {
        if (!hasOwn_(map, k) || k === key) continue;
        var t = Number(map[k]) || 0;
        if (now - t <= 86400000) keys.push(k);
      }
      keys.sort(function (a, b) { return (Number(map[a]) || 0) - (Number(map[b]) || 0); });
      while (keys.length > UPDATE_DEDUPE_MAX_KEYS - 1) keys.shift();   // 留一個位子給這次的鍵
      var keep = {};
      for (var i = 0; i < keys.length; i++) keep[keys[i]] = Number(map[keys[i]]);
      keep[key] = now;
      PropertiesService.getScriptProperties().setProperty("UPDATE_MAIL_DEDUPE", JSON.stringify(keep));
      return true;
    });
  } catch (err) {
    var sys = String(key).indexOf("sub:") !== 0;
    Logger.log("⚠ 寄信去重紀錄讀寫失敗(" + (sys ? "系統類照常寄出" : "送件類這次略過") + "):" + errText_(err));
    return sys;
  }
}

function updateErrorInfo_(code) {
  if (hasOwn_(UPDATE_ERRORS_, code)) return UPDATE_ERRORS_[code];
  if (/^http_5\d\d$/.test(code)) return UPDATE_ERRORS_.server_error;
  return { cls: "sys", hint: "Worker 回了這支程式不認得的錯誤。請把錯誤碼提供給總管理員；修好後補送。" };
}
function updateErrorHint_(code, rid) { return updateErrorInfo_(code).hint.split("{rid}").join(rid || "回應 ID"); }

/* 送失敗的通知。o = {code, rid, label, name};label 與 name 可能沒有(還沒讀到選項就失敗)。 */
function notifyUpdateFailure_(o) {
  var code = String(o.code || "script_error"), rid = String(o.rid || "");
  var info = updateErrorInfo_(code);
  var hint = updateErrorHint_(code, rid);
  var why = hint.split("。")[0];
  var manual = UPDATE_MANUAL_CODES.indexOf(code) >= 0;
  var who = o.label ? safeLabel_(o.label) : "";
  var body =
    (who ? who + " 從更新表單送出的資料沒有進到後台。" : "有一筆從更新表單送出的資料沒有進到後台。") + "\n" +
    "原因：" + why + "（錯誤碼 " + code + "）\n" +
    "處理方式：" + hint + "\n\n" +
    "這筆的內容完整留在表單的回應試算表裡（回應 ID：" + rid + "）。\n" +
    (manual ? "・這一類不會自動補送，請照上面的處理方式做；\n"
            : "・修好之後，網管可以在 Apps Script 執行 resendFailedMemberUpdates() 一次補送所有可以自動補送的；\n") +
    "・也可以請組長 LINE 本人，請他重新填一次（和補送擇一即可，內容相同的不會重複建立）。";

  if (info.cls === "sys") {
    if (!mailOnce_("sys:" + code, 3600 * 1000)) { Logger.log("   (同一個錯誤 1 小時內已經通知過,這次不另外寄信:" + code + ")"); return false; }
    var to = alertEmail_();
    var sent = sendMail_(to, "【會員名錄】夥伴資料更新表單出問題了：" + code,
      body + "\n\n同一個錯誤 1 小時內只會寄一封；這段時間其他送件可能也失敗了，修好後執行 resendFailedMemberUpdates() 會一次補送。" +
      MAIL_FOOTER_);
    Logger.log(sent ? "   ✉ 已通知 " + to : "   ✉ 沒有寄出通知(沒設 ALERT_EMAIL,也取不到腳本擁有者信箱)");
    return sent;
  }
  if (lowMailQuota_()) { Logger.log("   ⚠ 今天剩下的寄信額度不到 " + UPDATE_MAIL_MIN_QUOTA + " 封,這封送件類通知略過(額度留給系統類通知)"); return false; }
  var key = code === "updates_full" ? "sub:updates_full" : "sub:" + code + ":" + normName_(o.name).slice(0, 20);
  var gap = code === "updates_full" ? 6 * 3600 * 1000 : 24 * 3600 * 1000;
  if (!mailOnce_(key, gap)) { Logger.log("   (這位夥伴的同一個錯誤已經通知過,這次不另外寄信)"); return false; }
  var to2 = notifyOrAlert_();
  var sent2 = sendMail_(to2, "【會員名錄】夥伴資料更新沒有送進後台：" + (who || "(選項格式不對)"), body + MAIL_FOOTER_);
  Logger.log(sent2 ? "   ✉ 已通知 " + to2 : "   ✉ 沒有寄出通知(沒有收件人)");
  return sent2;
}

/* 送進待審核的通知:寄 NOTIFY_EMAIL(沒設就不寄),6 小時最多一封,內容是「目前共 N 筆」。
   一筆一封的話,全員補資料的那天組長會收到幾十封,也會吃光寄信額度。 */
function notifyUpdateSuccess_(label, out) {
  var to = String(PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || "").trim();
  if (!to) return false;
  if (lowMailQuota_()) { Logger.log("   ⚠ 今天剩下的寄信額度不到 " + UPDATE_MAIL_MIN_QUOTA + " 封,成功通知這次略過(額度留給失敗通知)"); return false; }
  var now = Date.now(), go = false;
  try {
    go = withScriptLock_(function () {
      var props = PropertiesService.getScriptProperties();
      var last = Number(props.getProperty("UPDATE_NOTIFY_LAST_AT")) || 0;
      if (now - last < UPDATE_SUCCESS_MAIL_GAP_MS) return false;
      props.setProperty("UPDATE_NOTIFY_LAST_AT", String(now));
      return true;
    });
  } catch (err) { Logger.log("   ⚠ 成功通知的節流紀錄寫不進去,這次不寄:" + errText_(err)); return false; }
  if (!go) { Logger.log("   (6 小時內已經寄過成功通知,這筆不另外寄信)"); return false; }
  var who = safeLabel_(label);
  var open = Math.max(1, Math.floor(Number(out && out.open) || 1));
  var oldest = Date.parse(out && out.oldestAt);
  var days = isFinite(oldest) ? Math.max(0, Math.floor((now - oldest) / 86400000)) : 0;
  return sendMail_(to, "【會員名錄】有夥伴送來資料更新：" + who,
    who + " 送來了名錄資料更新，等組長審核。\n" +
    "目前共 " + open + " 筆待審核（最久的已等 " + days + " 天）。\n\n" +
    "請組長到後台「夥伴資料更新（待審核）」區確認後套用：\n" +
    SITE_BASE_URL + "admin.html\n\n" +
    "（為了不洗版，之後 6 小時內的新送件不會再個別寄信，請直接到後台查看。）" +
    MAIL_FOOTER_);
}

/* ── 「找不到我的名字」彙整信 ─────────────────────────────────────────
   UPDATE_NF_STATE = {n: 累積人數, last: 上一封的 ms, names: [過濾後的姓名,最多 10 個]}。
   以「人數」累計而不是靠姓名去重,所以沒留可辨識姓名的人也算得到。 */
function nfState_() {
  var s = readJsonProp_("UPDATE_NF_STATE", null), out = { n: 0, last: 0, names: [] };
  if (s && typeof s === "object") {
    out.n = Math.max(0, Math.floor(Number(s.n) || 0));
    out.last = Number(s.last) || 0;
    if (isArr_(s.names)) out.names = s.names.filter(function (x) { return typeof x === "string" && x; }).slice(0, UPDATE_NF_NAMES_MAX);
  }
  return out;
}
function nfRecord_(rawName) {
  var name = safeNameText_(rawName, 10);
  try {
    withScriptLock_(function () {
      var st = nfState_();
      st.n += 1;
      if (name && st.names.indexOf(name) < 0 && st.names.length < UPDATE_NF_NAMES_MAX) st.names.push(name);
      PropertiesService.getScriptProperties().setProperty("UPDATE_NF_STATE", JSON.stringify(st));
    });
  } catch (err) { Logger.log("⚠ 「找不到名字」的累計寫不進去:" + errText_(err)); }
}
/* 有累積、距離上一封滿 6 小時、額度夠,才寄。先在鎖裡「認領」這一批再寄,
   兩個觸發器同時跑時不會各寄一封;沒寄出就把這一批加回去,等下一次。 */
function nfFlush_(form) {
  var st0 = nfState_();
  if (st0.n <= 0 || Date.now() - st0.last < UPDATE_NF_MAIL_GAP_MS) return false;
  if (lowMailQuota_()) { Logger.log("⚠ 今天剩下的寄信額度不多,「找不到名字」彙整信先不寄(累計 " + st0.n + " 人,下次再寄)"); return false; }
  var claim = null;
  try {
    claim = withScriptLock_(function () {
      var st = nfState_(), now = Date.now();
      if (st.n <= 0 || now - st.last < UPDATE_NF_MAIL_GAP_MS) return null;
      PropertiesService.getScriptProperties().setProperty("UPDATE_NF_STATE", JSON.stringify({ n: 0, last: now, names: [] }));
      return st;
    });
  } catch (err) { Logger.log("⚠ 「找不到名字」的累計讀不到,這次不寄:" + errText_(err)); return false; }
  if (!claim) return false;

  var sheet = "";
  try {
    var f = form || FormApp.openByUrl(PropertiesService.getScriptProperties().getProperty("UPDATE_FORM_EDIT_URL"));
    var destId = f.getDestinationId();
    if (destId) sheet = "https://docs.google.com/spreadsheets/d/" + destId + "/edit";
  } catch (err) { sheet = ""; }
  var names = [];
  for (var i = 0; i < claim.names.length; i++) { var s = safeNameText_(claim.names[i], 10); if (s) names.push(s); }
  var to = notifyOrAlert_();
  var sent = sendMail_(to, "【會員名錄】有 " + claim.n + " 位夥伴在更新表單找不到自己的名字",
    "最近有 " + claim.n + " 人在夥伴資料更新表單選了「找不到我的名字」。\n" +
    "留下的姓名：" + (names.length ? names.join("、") + (claim.n > UPDATE_NF_NAMES_MAX ? "等" : "") : "（都沒有留下可以辨識的姓名）") + "\n" +
    "可能是選單還沒同步、看錯組，或還沒上架名錄。請組長跟他們聯絡。\n\n" +
    "他們想更新的內容在回應試算表裡（「請選你的名字」那一欄是「找不到我的名字」的那幾列）：\n" +
    (sheet || "（請網管打開表單 → 回覆 → 試算表查看）") + "\n" +
    "（試算表在網管的 Google 帳號裡，打不開的話請轉給網管。為了安全，這封信只列出姓名，不放填答者寫的其他文字。）" +
    MAIL_FOOTER_);
  if (sent) { Logger.log("✉ 「找不到名字」彙整信已寄到 " + to + "(" + claim.n + " 人)"); return true; }

  Logger.log("✗ 「找不到名字」彙整信沒寄出,累計保留到下次");
  try {
    withScriptLock_(function () {
      var cur = nfState_();
      var merged = claim.names.slice();
      for (var j = 0; j < cur.names.length; j++) if (merged.indexOf(cur.names[j]) < 0 && merged.length < UPDATE_NF_NAMES_MAX) merged.push(cur.names[j]);
      PropertiesService.getScriptProperties().setProperty("UPDATE_NF_STATE",
        JSON.stringify({ n: cur.n + claim.n, last: claim.last, names: merged }));
    });
  } catch (err) { Logger.log("⚠ 「找不到名字」的累計加不回去:" + errText_(err)); }
  return false;
}

/* ── 名錄 → 名字選單 ───────────────────────────────────────────────────
   labels 依 data.js 的分組順序 + 組內順序,手機上的選單就會依組別排好。
   同一組同名(normName_ 相同)只留第一位:選項文字一樣,Google 選單分不出兩個人。 */
function memberUpdateChoices_(groups) {
  var labels = [], dupes = [], parts = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i], code = String(g.code || "").trim();
    if (!code) continue;
    parts.push(code + (g.name ? " " + String(g.name).trim() : ""));
    var seen = {}, ms = isArr_(g.members) ? g.members : [];
    for (var j = 0; j < ms.length; j++) {
      var name = String((ms[j] && ms[j].name) || "").trim();
      if (!name) continue;
      var k = "n:" + normName_(name);
      if (seen[k]) { dupes.push(memberUpdateLabel_(code, name)); continue; }
      seen[k] = true;
      labels.push(memberUpdateLabel_(code, name));
    }
  }
  return { labels: labels, dupes: dupes, groupLine: parts.join("、") };
}

function memberUpdateNameHelp_(groupLine) {
  return "名字依組別排列：" + groupLine + "\n" +
    "組長傳給你的連結如果已經幫你選好名字，確認是你本人再往下。\n" +
    "找不到自己？選最後一個「找不到我的名字」。";
}

/* 名字題:先用 item ID 找(網管改了題目文字也不會壞),找不到才用標題備援。 */
function updateNameItemById_(form) {
  var id = PropertiesService.getScriptProperties().getProperty("UPDATE_FORM_NAME_ITEM_ID");
  if (!id) return null;
  try { var it = form.getItemById(Number(id)); return it ? it.asListItem() : null; }
  catch (err) { return null; }
}
function findUpdateNameItem_(form) {
  var it = updateNameItemById_(form);
  if (it) return it;
  var items = form.getItems(FormApp.ItemType.LIST), want = normTitle_(UPDATE_Q.member);
  for (var i = 0; i < items.length; i++) if (normTitle_(items[i].getTitle()) === want) return items[i].asListItem();
  return null;
}
function updateNotFoundPageById_(form) {
  var id = PropertiesService.getScriptProperties().getProperty("UPDATE_FORM_NOTFOUND_PAGE_ID");
  if (!id) return null;
  try { var it = form.getItemById(Number(id)); return it ? it.asPageBreakItem() : null; }
  catch (err) { return null; }
}
function findUpdateNotFoundPage_(form) {
  var it = updateNotFoundPageById_(form);
  if (it) return it;
  var items = form.getItems(FormApp.ItemType.PAGE_BREAK), want = normTitle_(UPDATE_Q.nfPage);
  for (var i = 0; i < items.length; i++) if (normTitle_(items[i].getTitle()) === want) return items[i].asPageBreakItem();
  return null;
}

function sameStrings_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* 把名錄寫進名字選單(含換頁設定與說明文字)。內容沒變就不寫:每小時跑一次,
   沒必要每次都改表單。回傳 {ok, changed, n, dupes, why}。
   ★ 任何一項找不到就整個不動:寧可選單舊一點,也不要寫出一份沒有出口頁的選單。 */
function applyMemberUpdateChoices_(form, groups) {
  var ch = memberUpdateChoices_(groups);
  var res = { ok: false, changed: false, n: ch.labels.length, dupes: ch.dupes, why: "" };
  if (!ch.labels.length) { res.why = "名錄上一位夥伴都沒有"; return res; }
  var item = findUpdateNameItem_(form);
  if (!item) { res.why = "找不到名字題(UPDATE_FORM_NAME_ITEM_ID 對不上,標題「" + UPDATE_Q.member + "」也找不到)"; return res; }
  var page = findUpdateNotFoundPage_(form);
  if (!page) { res.why = "找不到「" + UPDATE_Q.nfPage + "」那一頁"; return res; }
  var want = ch.labels.concat([UPDATE_NOT_FOUND]);
  var help = memberUpdateNameHelp_(ch.groupLine);
  var cur = item.getChoices().map(function (c) { return c.getValue(); });
  if (sameStrings_(cur, want) && item.getHelpText() === help) { res.ok = true; return res; }
  var choices = ch.labels.map(function (l) { return item.createChoice(l, FormApp.PageNavigationType.CONTINUE); });
  choices.push(item.createChoice(UPDATE_NOT_FOUND, page));
  item.setChoices(choices);
  item.setHelpText(help);
  res.ok = true; res.changed = true;
  return res;
}

/* 名錄索引 {normName_(姓名): [組代號, …]}。只給送出時「再查一次組別」用。
   只存姓名與代號(約 3 KB);data.js 本身約 70 KB,接近 CacheService 單值 100 KB 上限,不整份快取。 */
function cacheNameIndex_(groups) {
  var idx = Object.create(null);           // 沒有原型:姓名剛好叫 __proto__ 也只是一個普通的鍵
  for (var i = 0; i < groups.length; i++) {
    var code = String(groups[i].code || "").trim(), ms = isArr_(groups[i].members) ? groups[i].members : [];
    if (!code) continue;
    for (var j = 0; j < ms.length; j++) {
      var k = normName_(ms[j] && ms[j].name);
      if (!k) continue;
      if (!hasOwn_(idx, k)) idx[k] = [];
      if (isArr_(idx[k])) idx[k].push(code);
    }
  }
  try { CacheService.getScriptCache().put("mupd:nameidx", JSON.stringify(idx), UPDATE_NAMEIDX_CACHE_S); }
  catch (err) { Logger.log("⚠ 名錄索引寫不進快取(不影響這一筆):" + errText_(err)); }
  return idx;
}
function publishedNameIndex_() {
  try {
    var hit = CacheService.getScriptCache().get("mupd:nameidx");
    if (hit) { var o = JSON.parse(hit); if (o && typeof o === "object" && !isArr_(o)) return o; }
  } catch (err) { /* 快取壞了就重抓 */ }
  var groups = publishedGroups_();
  return groups ? cacheNameIndex_(groups) : null;
}

/* 每小時觸發一次(也可以手動跑):把名字選單對齊公開名錄。
   讀不到名錄、0 人、找不到題目時,現有選項一律不動 —— 拿空資料去「同步」只會把所有人清掉。 */
function syncMemberUpdateNames() {
  var props = PropertiesService.getScriptProperties();
  var editUrl = props.getProperty("UPDATE_FORM_EDIT_URL");
  if (!editUrl) { Logger.log("還沒有建立夥伴資料更新表單(沒有 UPDATE_FORM_EDIT_URL),這次不同步。"); return; }
  var form = null, why = "";
  try {
    form = FormApp.openByUrl(editUrl);
    var groups = publishedGroups_();
    if (!groups) why = "讀不到公開名錄的 data.js";
    else {
      var r = applyMemberUpdateChoices_(form, groups);
      if (!r.ok) why = r.why;
      else {
        props.setProperty("UPDATE_NAMES_SYNCED_AT", new Date().toISOString());
        Logger.log(r.changed ? "✅ 名字選單已更新:" + r.n + " 位 +「" + UPDATE_NOT_FOUND + "」"
                             : "✅ 名字選單和名錄一樣(" + r.n + " 位),不用寫入");
        if (r.dupes.length) notifySyncDupes_(r.dupes);
        cacheNameIndex_(groups);       // 順便更新送出時用的名錄索引
      }
    }
  } catch (err) {
    why = "同步時出錯:" + errText_(err);
  }
  if (why) syncFailed_(why);
  try { nfFlush_(form); } catch (err2) { Logger.log("⚠ 「找不到名字」彙整信這次沒處理:" + errText_(err2)); }
}

function notifySyncDupes_(dupes) {
  var names = dupes.map(safeLabel_).join("、");
  Logger.log("⚠ 名錄裡同一組有同名的夥伴,選單只列第一位:" + names);
  if (!mailOnce_("sync-dupe", 24 * 3600 * 1000)) return;
  sendMail_(alertEmail_(), "【會員名錄】名錄裡同一組有同名的夥伴：" + names,
    "更新表單的選單只能列一個，另一位夥伴送不出更新。請組長在後台把其中一位的姓名加註區別（例如加上公司簡稱）。" + MAIL_FOOTER_);
}

/* 同步失敗:記一行。超過 24 小時沒成功過,才寄 ALERT,而且一天最多一封 ——
   偶爾一次讀不到網站很正常,不值得每小時寄一封信。 */
function syncFailed_(why) {
  Logger.log("✗ 名字選單這次沒有同步(現有選項不動):" + why);
  var props = PropertiesService.getScriptProperties();
  var lastRaw = props.getProperty("UPDATE_NAMES_SYNCED_AT") || "";
  var last = Date.parse(lastRaw);
  if (isFinite(last) && Date.now() - last <= 24 * 3600 * 1000) return;
  var today = fmtTime_(new Date(), "yyyy-MM-dd");
  if (props.getProperty("UPDATE_SYNC_ALERTED_DAY") === today) return;
  props.setProperty("UPDATE_SYNC_ALERTED_DAY", today);
  sendMail_(alertEmail_(), "【會員名錄】夥伴資料更新表單的名字選單已經超過一天沒更新",
    "syncMemberUpdateNames 已經超過 24 小時沒有成功（最後成功：" +
    (isFinite(last) ? fmtTime_(new Date(last), "yyyy/MM/dd HH:mm") : "從來沒有成功過") + "）。\n" +
    "新上架或改名的夥伴會在選單裡找不到自己。\n" +
    "常見原因：網站網址（程式裡的 SITE_BASE_URL）改了、名錄 data.js 讀不到。\n" +
    "請在 Apps Script 手動執行 syncMemberUpdateNames，看執行紀錄。" +
    MAIL_FOOTER_);
}

/* ── 建立表單 ─────────────────────────────────────────────────────────── */

function newMemberFormUrl_() {
  var u = PropertiesService.getScriptProperties().getProperty("MEMBER_FORM_EDIT_URL");
  if (!u) return "";
  try { return String(FormApp.openByUrl(u).getPublishedUrl() || ""); } catch (err) { return ""; }
}

function memberUpdateDescription_(newMemberUrl) {
  return "已經在分會名錄上的夥伴，用這份表單補上或修改自己的資料，例如補公司名稱、主要營業項目、我有／我要。\n" +
    "・只填要改的格子，其他空著就好 —— 空著＝維持名錄上原本的內容，不會被清掉。\n" +
    "・送出後由你的產業小組組長確認，確認後才會出現在名錄上。\n" +
    "・不用登入 Google，約 2 分鐘。\n" +
    "・要換形象照、補名片或商品照：請直接用 LINE 傳給你的組長。\n" +
    (newMemberUrl ? "・還沒上架名錄的新夥伴，請改填新夥伴表單：" + newMemberUrl
                  : "・還沒上架名錄的新夥伴，請跟你的組長索取新夥伴表單。");
}

/* 建立「夥伴資料更新」表單。題目、說明與換頁規則都是定稿(見 README「八」)。
   ★ 順序有講究:會丟例外的檢查(屬性、讀名錄、0 人)全部排在 FormApp.create 之前;
     建立之後立刻記下編輯網址,之後任何一步失敗,重跑都會被擋下,不會多出一份同名表單。 */
function createMemberUpdateForm() {
  guardAlreadyCreated_("UPDATE_FORM_EDIT_URL", "createMemberUpdateForm", "夥伴資料更新", "forgetMemberUpdateForm()");
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("RELAY_URL") || !props.getProperty("INTAKE_SECRET")) {
    throw new Error("請先到「專案設定 → 指令碼屬性」設好 RELAY_URL 與 INTAKE_SECRET(見檔案開頭步驟 1、2)");
  }
  var groups = publishedGroups_();
  if (!groups) throw new Error("讀不到公開名錄的 data.js，表單還沒建立。請確認網站正常後再執行一次。");
  var ch = memberUpdateChoices_(groups);
  if (!ch.labels.length) throw new Error("公開名錄上一位夥伴都沒有，表單還沒建立。請確認網站正常後再執行一次。");
  var newMemberUrl = newMemberFormUrl_();

  var form = FormApp.create(UPDATE_FORM_TITLE);
  props.setProperty("UPDATE_FORM_EDIT_URL", form.getEditUrl());
  form.setDescription(memberUpdateDescription_(newMemberUrl));
  form.setCollectEmail(false);            // 收集 email(驗證過的)會強制登入
  form.setAllowResponseEdits(false);      // 開了的話每編輯一次就是一筆新的待審核
  form.setLimitOneResponsePerUser(false); // 開了會強制登入
  form.setPublishingSummary(false);       // 開了的話,送出過的人看得到所有回覆的摘要(包括別人的備註)
  form.setConfirmationMessage(
    "✅ 收到了，謝謝你！\n" +
    "接下來由你的產業小組組長確認（通常一週內），確認後幾分鐘內就會出現在名錄上，你不用再做任何事。\n" +
    "・發現填錯了：再填一次這份表單，只填要改正的那一格就好。\n" +
    "・一週後名錄還是沒變：請直接 LINE 你的組長。\n" +
    "・要換照片：直接用 LINE 傳給你的組長。");

  // 第 1 頁:先放沒有換頁設定的選項(選項不能是空陣列),後面 applyMemberUpdateChoices_ 再補換頁
  var nameItem = form.addListItem().setTitle(UPDATE_Q.member).setRequired(true).setChoiceValues(ch.labels);
  props.setProperty("UPDATE_FORM_NAME_ITEM_ID", String(nameItem.getId()));

  // 第 2 頁
  form.addPageBreakItem().setTitle(UPDATE_Q.page).setHelpText(
    "⚠ 先確認第 1 頁選的是你自己的名字（按「返回」可以看）。\n" +
    "只填要改的格子，其他空著就好（空著＝維持名錄上原本的內容，不會被清掉）。\n" +
    "例：只想補公司名稱 → 只填「所屬公司」，其他全部空著，直接按最下面的按鈕送出。\n" +
    "・格子裡已經有字，是組長的連結幫你帶入的「目前名錄上的內容」：直接改要改的地方就好，沒動的格子不會被當成修改。\n" +
    "・不用改的格子請空著，不要寫「無」「同上」「不變」。\n" +
    "・想把某一格整個刪掉，請寫在最下面的「給組長的備註」。\n" +
    "・目前名錄上的內容可以在這裡查（搜尋自己的名字）：" + SITE_BASE_URL);
  form.addSectionHeaderItem().setTitle(UPDATE_Q.secNew)
    .setHelpText("這幾格大部分夥伴都還沒填，填了就會出現在你的頁面上。");
  form.addTextItem().setTitle(NEWMEMBER_Q.company).setRequired(false)
    .setHelpText("公司或商號全名。不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.business_items).setRequired(false)
    .setHelpText("公司登記的主要營業項目。不用改就空著。");
  form.addTextItem().setTitle(NEWMEMBER_Q.website).setRequired(false)
    .setHelpText("有官網才填。從瀏覽器網址列整段複製貼上最準，例：https://www.example.com.tw。不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.have).setRequired(false)
    .setHelpText("你手上有什麼可以給出去的資源、產能、通路、人脈或專長，一項一行。例：我有國產羊肉爐資源\n" +
                 "⚠ 會整格換掉：原本有寫的項目要保留，請一起寫上。不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.want).setRequired(false)
    .setHelpText("你想被引薦到誰，一項一行。例：\n羊肉特色小吃店\n肉舖\n" +
                 "⚠ 會整格換掉：原本有寫的項目要保留，請一起寫上。不用改就空著。");
  form.addSectionHeaderItem().setTitle(UPDATE_Q.secEdit)
    .setHelpText("⚠ 這一段的格子會整格換掉：你寫什麼，名錄上那一格就變成什麼，原本的會被拿掉。只想多加一項，請把原本要保留的也一起寫上，一項一行。");
  form.addTextItem().setTitle(NEWMEMBER_Q.title).setRequired(false)
    .setHelpText("名錄上的一句話行業說明。例：國產羊肉批發。不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.services).setRequired(false)
    .setHelpText("你提供什麼服務或產品，一項一行。例：\n國產羊肉批發零售\n活羊批發零售\n不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.targets).setRequired(false)
    .setHelpText("希望夥伴幫你介紹什麼樣的對象，一項一行。例：\n火鍋餐廳\n外燴團隊\n不用改就空著。");
  form.addParagraphTextItem().setTitle(NEWMEMBER_Q.tagline).setRequired(false)
    .setHelpText("例會上 25 秒自我介紹的那句 slogan，兩句一組、一句一行。例：\n國產羊肉找阿成\n老饕全部都點頭\n不用改就空著。");
  form.addParagraphTextItem().setTitle(UPDATE_Q.note).setRequired(false)
    .setHelpText("要刪掉某一格、改名字、換組，或其他想跟組長說的，寫在這裡。只有組長和網管看得到，不會公開。例：請刪掉我的公司網站。");
  form.addTextItem().setTitle(UPDATE_Q.token).setRequired(false)
    .setHelpText("組長的連結會自動帶入，用來判斷哪些格子你沒有改。不用理它，也不要修改；空白也沒關係。");

  // 第 3 頁(出口頁)。這個分頁設「送出」:第 2 頁填完直接送出,不會掉進第 3 頁
  var nfPage = form.addPageBreakItem().setTitle(UPDATE_Q.nfPage).setHelpText(
    "可能是這幾種情況：\n" +
    "① 選單依組別排列，你可能在別的組 —— 按「返回」再找一次。\n" +
    "② 剛加入或剛改名，選單每小時更新一次，晚一點再試。\n" +
    "③ 還沒上架名錄：" + (newMemberUrl ? "請改填新夥伴表單 " + newMemberUrl : "請跟你的組長索取新夥伴表單。") + "\n" +
    "都不是的話，留下你的名字，我們會請組長跟你聯絡。");
  nfPage.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  props.setProperty("UPDATE_FORM_NOTFOUND_PAGE_ID", String(nfPage.getId()));
  form.addTextItem().setTitle(UPDATE_Q.nfName).setRequired(true)
    .setHelpText("寫全名，組長會跟你聯絡。");
  form.addParagraphTextItem().setTitle(UPDATE_Q.nfWhat).setRequired(false)
    .setHelpText("簡單寫就好，例如：補公司名稱「○○有限公司」。");

  var applied = applyMemberUpdateChoices_(form, groups);
  if (!applied.ok) Logger.log("✗ 名字選單的換頁設定沒有寫進去:" + applied.why + " —— 稍後執行 syncMemberUpdateNames 再試一次");
  if (applied.dupes.length) notifySyncDupes_(applied.dupes);

  var ss = SpreadsheetApp.create(UPDATE_FORM_TITLE + "(回應)");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  installMemberUpdateTriggers_(form);

  /* Google 官方文件:2026/6/30 之後用 API 建立的表單預設是「未發布」。沒寫清楚 FormApp 算不算,
     所以一律主動發布,再由 checkMemberUpdateForm 核對 isPublished()。舊帳號沒有這個方法就略過。 */
  if (typeof form.setPublished === "function") {
    try { form.setPublished(true); }
    catch (err) { Logger.log("✗ 自動發布失敗(" + errText_(err) + "),請照下面第 ④ 行手動發布"); }
  }
  props.setProperty("UPDATE_NAMES_SYNCED_AT", new Date().toISOString());

  var published = "";
  if (typeof form.isPublished === "function") {
    try { published = form.isPublished() ? "✅ 已發布" : "✗ 未發布 —— 打開第 ③ 個網址,按右上角「發布」,回應者選「知道連結的任何人」"; }
    catch (err) { published = "? 讀不到發布狀態,請用第 ③ 個網址打開確認"; }
  } else published = "? 這個帳號的表單沒有發布設定,略過";
  var lines = ["(entry 編號取不到,建好後執行 printMemberUpdateLinkConfig 重印)", ""];
  try { lines = memberUpdateConfigLines_(form.getPublishedUrl(), memberUpdateEntryIds_(form).ids); }
  catch (err) { Logger.log("⚠ entry 編號這次取不到:" + errText_(err)); }

  Logger.log("✅ 夥伴資料更新表單已建立(不需要登入、不收照片)");
  Logger.log("① 表單網址(之後貼進 site-config.js):" + form.getPublishedUrl());
  Logger.log("② 回應試算表(每一筆送件都留在這裡,補送時用得到):" + ss.getUrl());
  Logger.log("③ 表單編輯網址:" + form.getEditUrl());
  Logger.log("④ 發布狀態:" + published);
  Logger.log("⑤ 名字選單:" + ch.labels.length + " 位 +「" + UPDATE_NOT_FOUND + "」");
  Logger.log("⑥ 要貼進 site-config.js 的兩行(現在先不要貼,等 README 部署表第 7 步):");
  Logger.log(lines[0]);
  Logger.log(lines[1]);
  Logger.log("接下來:");
  Logger.log("  1. 用手機的無痕視窗打開第 ① 個網址,確認看得到題目、沒有出現「要求存取權」或「請登入」。");
  Logger.log("  2. 執行 checkMemberUpdateForm,除了 site-config 那一行之外都要是 ✅。");
  Logger.log("  ⚠ 不要在表單上加「上傳檔案」題 —— 加了整份表單就會要求登入,從 LINE 點進來的夥伴多半會卡住。照片請夥伴用 LINE 傳給組長。");
  Logger.log("  ⚠ 不要刪掉或改名「連結代碼」那一題 —— 它讓夥伴用舊連結再填一次時,不會把後來的修改改回去。");
}

/* ── 送出 ───────────────────────────────────────────────────────────────
   e 有兩種來源:表單送出觸發器 {response, source};補送 {response, source, resend:true, labelOverride}。
   回傳 {code, rid, uid?} 給補送函式印結果;觸發器不看回傳值。
   ★ 從第 2 步起整段包在 try/catch:任何例外都記成 script_error、寄系統類通知,然後正常結束。
     往外丟的話,Google 只會寄每日彙總的失敗信,這筆送件就沒人知道了。 */
function onMemberUpdateSubmit(e) {
  if (!e || !e.response) {
    Logger.log("這個函式是給「表單送出」觸發器跑的,不能直接按執行。要補送請用 resendMemberUpdate(\"回應 ID\")。");
    return null;
  }
  var rid = "";
  try { rid = String(e.response.getId() || ""); } catch (err) { rid = ""; }
  if (!rid) { Logger.log("✗ 這筆回應拿不到回應 ID,沒辦法處理(內容仍在回應試算表)"); return null; }
  try {
    return memberUpdateSubmit_(e, rid);
  } catch (err) {
    Logger.log("✗ 夥伴資料更新處理到一半出錯(回應 ID " + rid + "):" + errText_(err) + " —— 已記進補送清單");
    failedPut_(rid, "script_error");
    try { notifyUpdateFailure_({ code: "script_error", rid: rid }); }
    catch (err2) { Logger.log("⚠ 失敗通知也寄不出去:" + errText_(err2)); }
    return { code: "script_error", rid: rid };
  }
}

function memberUpdateSubmit_(e, rid) {
  var props = PropertiesService.getScriptProperties();
  var form = e.source || FormApp.openByUrl(props.getProperty("UPDATE_FORM_EDIT_URL"));

  // 熔斷:補送是網管手動做的,不算
  if (!e.resend) {
    var count = floodCount_();
    if (count > UPDATE_FLOOD_PER_HOUR) { floodPause_(form, rid, count); return { code: "flood_paused", rid: rid }; }
  }

  // 先記錄:確定成功才移除。之後任何一步當掉,這筆都還在清單上
  failedPut_(rid, "pending");

  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  if (!relay || !secret) {
    Logger.log("✗ 沒設 RELAY_URL / INTAKE_SECRET,這筆沒有送出(回應 ID " + rid + ")");
    failedPut_(rid, "config_missing");
    notifyUpdateFailure_({ code: "config_missing", rid: rid });
    return { code: "config_missing", rid: rid };
  }

  var a = memberUpdateAnswers_(e.response);

  // 選了「找不到我的名字」:不送 Worker,累計進彙整信
  if (!e.labelOverride && a.picked === UPDATE_NOT_FOUND) {
    nfRecord_(a.byTitle[normTitle_(UPDATE_Q.nfName)]);
    Logger.log("・有人選了「" + UPDATE_NOT_FOUND + "」(回應 ID " + rid + "),記進彙整信,不送 Worker");
    nfFlush_(form);
    failedRemove_(rid);
    return { code: "name_not_found", rid: rid };
  }

  var label = String(e.labelOverride ? e.labelOverride : (a.picked == null ? "" : a.picked)).trim();
  var parsed = splitUpdateLabel_(label);
  if (!parsed) {
    Logger.log("✗ 名字選項的格式不對:" + safeLabel_(label) + "(回應 ID " + rid + ")");
    failedPut_(rid, "bad_label");
    notifyUpdateFailure_({ code: "bad_label", rid: rid, label: label });
    return { code: "bad_label", rid: rid };
  }

  /* 九欄一律送出,空字串也送:Worker 要靠它判斷「本人把預填的內容清空了」。
     佔位字、網址補 https、和名錄現值比對全部交給 Worker,這裡只轉送原文。 */
  var changes = {}, any = false;
  for (var i = 0; i < UPDATE_FIELD_KEYS.length; i++) {
    var v = pickByTitle_(a.byTitle, UPDATE_FIELD_KEYS[i]);
    changes[UPDATE_FIELD_KEYS[i]] = v == null ? "" : String(v);
    if (changes[UPDATE_FIELD_KEYS[i]].trim()) any = true;
  }
  var noteRaw = a.byTitle[normTitle_(UPDATE_Q.note)];
  var note = noteRaw == null ? "" : String(noteRaw);
  var linkToken = String(a.byTitle[normTitle_(UPDATE_Q.token)] || "").trim().slice(0, 200);
  if (!any && !note.trim()) {
    Logger.log("・" + safeLabel_(label) + " 什麼都沒填，不送出(回應 ID " + rid + ")");
    failedRemove_(rid);
    return { code: "empty", rid: rid };
  }

  /* 再確認一次組別:選單最多晚一小時,夥伴可能剛換組。全名錄只有一位同名時改用他現在的組,
     並把本人選的選項一起送(pickedLabel),審核時整筆預設不勾。找不到或多位同名就照選項送。 */
  var code = parsed.code, name = parsed.name, pickedLabel = "";
  var idx = publishedNameIndex_(), key = normName_(name);
  if (idx && hasOwn_(idx, key) && isArr_(idx[key]) && idx[key].length === 1) {
    var cur = String(idx[key][0] || "");
    if (/^[A-Za-z0-9]{1,8}$/.test(cur) && cur !== code) {
      Logger.log("・" + safeLabel_(label) + " 目前在 " + cur + " 組,改送到 " + cur + "(回應 ID " + rid + ")");
      /* 用拆好的代號與姓名重組,不直接放原文:Worker 只收「代號・姓名」(/^[A-Za-z0-9]{1,8}・\S/),
         網管補送時打成「A1 ・王大銘」這種多了空白的寫法,原文會被 Worker 清成空字串,
         審核畫面就看不到「系統改送到別組」的警示。選單上的選項本來就是這樣組出來的,正常情況兩者相同。 */
      pickedLabel = memberUpdateLabel_(parsed.code, parsed.name);
      code = cur;
    }
  }

  var sendLabel = memberUpdateLabel_(code, name);
  var payload = JSON.stringify({ secret: secret, update: {
    label: sendLabel, name: name, group: code, changes: changes, note: note,
    responseId: rid, submittedAt: a.submittedAt, linkToken: linkToken, pickedLabel: pickedLabel } });
  return memberUpdateResult_(rid, sendLabel, name, postMemberUpdate_(relay, payload));
}

/* 逐題讀取。名字題用 item ID 認(標題被改也認得到),其他題用正規化後的標題。 */
function memberUpdateAnswers_(response) {
  var nameId = String(PropertiesService.getScriptProperties().getProperty("UPDATE_FORM_NAME_ITEM_ID") || "");
  var byTitle = Object.create(null), picked = null;
  var items = response.getItemResponses() || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i].getItem(), v = items[i].getResponse();
    var val = v == null ? "" : String(v);
    if (picked === null && nameId && String(item.getId()) === nameId) { picked = val; continue; }
    byTitle[normTitle_(item.getTitle())] = val;
  }
  if (picked === null) {
    var t = normTitle_(UPDATE_Q.member);
    if (hasOwn_(byTitle, t)) picked = byTitle[t];
  }
  var submittedAt = "";
  try { var ts = response.getTimestamp(); if (ts) submittedAt = new Date(ts.getTime()).toISOString(); }
  catch (err) { submittedAt = ""; }        // 拿不到時 Worker 會改用收件時間
  return { picked: picked, byTitle: byTitle, submittedAt: submittedAt };
}

/* 熔斷計數:這一小時收到第幾筆。快取壞了就回 0(照常處理),不能因為計數器壞掉就擋下正常送件。 */
function floodCount_() {
  try {
    var cache = CacheService.getScriptCache();
    var key = "mupd:h:" + fmtTime_(new Date(), "yyyyMMddHH");
    return withScriptLock_(function () {
      var n = (Number(cache.get(key)) || 0) + 1;
      cache.put(key, String(n), 7200);
      return n;
    });
  } catch (err) {
    Logger.log("⚠ 熔斷計數讀寫失敗,這筆照常處理:" + errText_(err));
    return 0;
  }
}

/* 超過門檻:不抓 data.js、不呼叫 Worker,直接暫停表單收件。
   暫停之後 Google 會直接擋下送件,觸發器也不會再跑,帳號共用的額度就保住了。
   暫停那一刻進來的記成 flood_paused(需人工處理),免得之後一鍵補送又把垃圾單送一次。 */
function floodPause_(form, rid, count) {
  failedPut_(rid, "flood_paused");
  try {
    if (form.isAcceptingResponses()) form.setCustomClosedFormMessage(UPDATE_FLOOD_CLOSED_MSG).setAcceptingResponses(false);
  } catch (err) { Logger.log("✗ 表單沒辦法自動暫停收件:" + errText_(err)); }
  Logger.log("🔴 1 小時內收到第 " + count + " 筆,超過 " + UPDATE_FLOOD_PER_HOUR + " 筆,表單已自動暫停收件(回應 ID " + rid + " 記成 flood_paused)");
  if (!mailOnce_("sys:flood_paused", 3600 * 1000)) return;
  var editUrl = "";
  try { editUrl = form.getEditUrl(); } catch (err2) { editUrl = "(請從 Apps Script 的指令碼屬性 UPDATE_FORM_EDIT_URL 找)"; }
  sendMail_(alertEmail_(), "【會員名錄】夥伴資料更新表單已自動暫停收件（疑似被灌單）",
    "更新表單在 1 小時內收到超過 " + UPDATE_FLOOD_PER_HOUR + " 筆送件，看起來不像正常使用，系統已經自動暫停收件（填表的人會看到「暫停收件中」）。\n" +
    "這樣做是為了保住同一個 Google 帳號的每日額度 —— 新夥伴申請和來賓報名也靠這份額度。\n\n" +
    "1. 已經進到後台的送件，仍在「夥伴資料更新（待審核）」裡。不是夥伴本人送的，總管理員可以在後台勾選後一次「不採用」。\n" +
    "2. 確認沒問題之後，打開表單編輯頁 " + editUrl + " →「回覆」分頁 → 打開「接受回覆」。\n" +
    "3. 在 Apps Script 執行 checkMemberUpdateForm。「需人工處理」裡錯誤碼是 flood_paused 的，是暫停那一刻進來的送件：\n" +
    "   確定是夥伴送的，執行 resendMemberUpdate(\"回應 ID\")；其他的執行 dismissFailedMemberUpdate(\"回應 ID\")。\n" +
    "如果重新打開之後又被灌單：表單網址可能已經流到 LINE 群以外，請看 README「八」的常見問題「被灌單怎麼辦」。" +
    MAIL_FOOTER_);
}

/* POST /member-update。連線例外或 5xx 時等 5 秒重送一次(Worker 依回應 ID 去重,送兩次也不會多一筆)。
   第二次還是連線例外就往外丟,由 onMemberUpdateSubmit 記成 script_error。 */
function postMemberUpdate_(relay, payload) {
  var url = relay + "/member-update";
  var opts = { method: "post", contentType: "application/json", payload: payload, muteHttpExceptions: true };
  var r = null;
  try { r = parseRelayResponse_(UrlFetchApp.fetch(url, opts)); }
  catch (err) { Logger.log("・連不到 Worker(" + errText_(err) + "),5 秒後重送一次"); }
  if (r && r.status < 500) return r;
  if (r) Logger.log("・Worker 回 HTTP " + r.status + ",5 秒後重送一次");
  Utilities.sleep(5000);
  return parseRelayResponse_(UrlFetchApp.fetch(url, opts));
}
function parseRelayResponse_(res) {
  var out = null;
  try { out = JSON.parse(res.getContentText()); } catch (err) { out = null; }
  return { status: res.getResponseCode(), out: out && typeof out === "object" ? out : null };
}

/* Worker 的回應 → 清單、紀錄與通知。紀錄只放欄位鍵,不放內容。 */
function memberUpdateResult_(rid, label, name, r) {
  var out = r.out, who = safeLabel_(label);
  if (r.status === 200 && out && out.ok === true) {
    if (out.duplicate) {
      Logger.log("・" + who + ":同一筆已經在待審核(" + safeUid_(out.uid) + "),不重複建立");
      failedRemove_(rid);
      return { code: "duplicate", rid: rid, uid: safeUid_(out.uid) };
    }
    if (out.unchanged) {
      Logger.log("・" + who + ":內容和名錄上一樣，沒有建立待審核");
      failedRemove_(rid);
      return { code: "unchanged", rid: rid };
    }
    var parts = [], tags = [["fields", "欄位"], ["ignored", "佔位字"], ["invalid", "不合格"], ["untouched", "連結帶入沒改"],
                            ["stalePrefill", "連結過期"], ["cleared", "本人清空"], ["truncated", "截斷"]];
    for (var i = 0; i < tags.length; i++) {
      var ks = updateFieldKeys_(out[tags[i][0]]);
      if (ks.length) parts.push(tags[i][1] + " " + ks.join("、"));
    }
    if (out.confirmOnly === true) parts.push("只確認資料正確");
    Logger.log("✅ " + who + " 的更新已進待審核(uid " + safeUid_(out.uid) + (parts.length ? ";" + parts.join(";") : "") +
               ";目前共 " + (Math.floor(Number(out.open)) || "?") + " 筆)");
    failedRemove_(rid);
    notifyUpdateSuccess_(label, out);
    return { code: "ok", rid: rid, uid: safeUid_(out.uid) };
  }
  if (r.status === 400 && out && out.error === "nothing_to_update") {
    Logger.log("・" + who + ":沒有可以更新的內容(例如只寫了「同上」),不建立待審核");
    failedRemove_(rid);
    return { code: "nothing_to_update", rid: rid };
  }
  var code = out && typeof out.error === "string" && /^[a-z0-9_]{1,40}$/.test(out.error) ? out.error : "http_" + r.status;
  Logger.log("✗ " + who + " 的更新沒有送進後台:" + code + "(回應 ID " + rid + ")");
  failedPut_(rid, code);
  notifyUpdateFailure_({ code: code, rid: rid, label: label, name: name });
  return { code: code, rid: rid };
}

/* ── 補送 ───────────────────────────────────────────────────────────── */

function openUpdateForm_() {
  var u = PropertiesService.getScriptProperties().getProperty("UPDATE_FORM_EDIT_URL");
  if (!u) throw new Error("指令碼屬性沒有 UPDATE_FORM_EDIT_URL —— 請先執行 createMemberUpdateForm");
  return FormApp.openByUrl(u);
}
function describeUpdateResult_(out) {
  if (!out) return "沒有處理(見上面的紀錄)";
  if (out.code === "ok") return "✅ 已進待審核(uid " + out.uid + ")";
  if (UPDATE_DONE_CODES.indexOf(out.code) >= 0) return "✅ 處理完畢(" + out.code + ")";
  return "✗ " + out.code + " —— " + updateErrorHint_(out.code, out.rid);
}

/* 補送一筆。label 選填:夥伴改名或選錯人時,指定正確的「代號・姓名」。
   用法:resendMemberUpdate("回應 ID") 或 resendMemberUpdate("回應 ID", "A1・正確姓名") */
function resendMemberUpdate(responseId, label) {
  var id = String(responseId == null ? "" : responseId).trim();
  if (!id) throw new Error('用法:resendMemberUpdate("回應 ID") 或 resendMemberUpdate("回應 ID", "A1・正確姓名")');
  var form = openUpdateForm_();
  var r = null;
  try { r = form.getResponse(id); } catch (err) { r = null; }
  if (!r) { Logger.log("找不到這筆回應：" + id); return null; }
  var out = onMemberUpdateSubmit({ response: r, source: form, resend: true, labelOverride: label ? String(label) : "" });
  Logger.log("補送結果:" + describeUpdateResult_(out));
  return out;
}

/* 一次補送所有「可自動補送」的。需人工處理的(找不到人、同名、內容太長、選項格式不對、
   灌單暫停)原封不動 —— 那些照樣再送一次只會再失敗一次,或把垃圾單送進後台。 */
function resendFailedMemberUpdates() {
  var list = failedList_();
  if (!list.auto.length && !list.manual.length) { Logger.log("補送清單是空的,沒有要補送的。"); return; }
  var form = list.auto.length ? openUpdateForm_() : null;
  var start = Date.now(), ok = 0, still = 0, left = 0;
  for (var i = 0; i < list.auto.length; i++) {
    if (Date.now() - start > UPDATE_RESEND_BUDGET_MS) { left = list.auto.length - i; break; }
    var rid = list.auto[i].rid, r = null;
    try { r = form.getResponse(rid); } catch (err) { r = null; }
    if (!r) {
      Logger.log("✗ 找不到這筆回應：" + rid + "(可能已從表單刪除;確認不需要就執行 dismissFailedMemberUpdate(\"" + rid + "\"))");
      still++; continue;
    }
    var out = onMemberUpdateSubmit({ response: r, source: form, resend: true, labelOverride: "" });
    if (out && UPDATE_DONE_CODES.indexOf(out.code) >= 0) ok++; else still++;
  }
  if (left) Logger.log("還有 " + left + " 筆沒補送，請再執行一次");
  var after = failedList_();
  Logger.log("成功 " + ok + " 筆、仍失敗 " + still + " 筆；需人工處理 " + after.manual.length + " 筆");
  logManualFailures_(after.manual);
}

function logManualFailures_(manual) {
  for (var i = 0; i < manual.length; i++) {
    Logger.log("   " + manual[i].rid + "・" + manual[i].code + "・" + updateErrorHint_(manual[i].code, manual[i].rid));
  }
}

/* 處理完的(已經請組長手動改好、確定是垃圾單)移出補送清單 */
function dismissFailedMemberUpdate(responseId) {
  var id = String(responseId == null ? "" : responseId).trim();
  var hit = failedRemove_(id);
  Logger.log(hit ? "已移出補送清單：" + id + "（" + hit.code + "）" : "清單上沒有這筆：" + id);
  return !!hit;
}

/* ── entry 編號與 site-config ──────────────────────────────────────────
   做法同 visitorEntryIds_:給每一題填一個標記,從官方 toPrefilledUrl() 反查 entry 編號。
   名字題是下拉選單,只能填真的選項,所以用第一個名字當標記。 */
function memberUpdateEntryIds_(form) {
  var items = form.getItems(), marks = {}, resp = form.createResponse(), memberMark = "";
  var nameItem = findUpdateNameItem_(form), nameId = nameItem ? String(nameItem.getId()) : "";
  for (var i = 0; i < items.length; i++) {
    var it = items[i], type = it.getType();
    if (nameId && String(it.getId()) === nameId) {
      var chs = nameItem.getChoices();
      if (chs.length) { memberMark = chs[0].getValue(); resp = resp.withItemResponse(nameItem.createResponse(memberMark)); }
      continue;
    }
    var mark = "ZZMARK" + i + "ZZ";
    if (type === FormApp.ItemType.TEXT) resp = resp.withItemResponse(it.asTextItem().createResponse(mark));
    else if (type === FormApp.ItemType.PARAGRAPH_TEXT) resp = resp.withItemResponse(it.asParagraphTextItem().createResponse(mark));
    else continue;
    marks[mark] = normTitle_(it.getTitle());
  }
  var url = resp.toPrefilledUrl(), byTitle = Object.create(null), memberEntry = "";
  var re = /[?&](entry\.\d+)=([^&]*)/g, m;
  while ((m = re.exec(url)) !== null) {
    var val;
    try { val = decodeURIComponent(m[2].replace(/\+/g, " ")); } catch (err) { continue; }
    if (hasOwn_(marks, val)) byTitle[marks[val]] = m[1];
    else if (memberMark && val === memberMark) memberEntry = m[1];
  }
  var ids = {};
  if (memberEntry) ids.member = memberEntry;
  for (var k = 0; k < UPDATE_FIELD_KEYS.length; k++) {
    var names = titlesFor_(UPDATE_FIELD_KEYS[k]);
    for (var n = 0; n < names.length; n++) if (hasOwn_(byTitle, names[n])) { ids[UPDATE_FIELD_KEYS[k]] = byTitle[names[n]]; break; }
  }
  var tk = normTitle_(UPDATE_Q.token);
  if (hasOwn_(byTitle, tk)) ids.token = byTitle[tk];
  return { form: form, ids: ids, seenTitles: byTitle };
}

/* 要貼進 site-config.js 的兩行 */
function memberUpdateConfigLines_(publishedUrl, ids) {
  var parts = [];
  for (var i = 0; i < UPDATE_ENTRY_KEYS.length; i++) parts.push(UPDATE_ENTRY_KEYS[i] + ':"' + (ids[UPDATE_ENTRY_KEYS[i]] || "") + '"');
  return ['  UPDATE_FORM_URL: "' + publishedUrl + '",',
          "  UPDATE_FORM_ENTRIES: { " + parts.join(", ") + " },"];
}

/* 設定遺失(或改過題目)時重印 site-config.js 的兩行 */
function printMemberUpdateLinkConfig() {
  var form = openUpdateForm_();
  var r = memberUpdateEntryIds_(form);
  var lines = memberUpdateConfigLines_(form.getPublishedUrl(), r.ids);
  Logger.log("到 GitHub 網頁版打開 site-config.js,用下面兩行取代原本的 UPDATE_FORM_URL 與 UPDATE_FORM_ENTRIES:");
  Logger.log("");
  Logger.log(lines[0]);
  Logger.log(lines[1]);
  Logger.log("");
  var missing = UPDATE_ENTRY_KEYS.filter(function (k) { return !r.ids[k]; });
  if (missing.length) {
    Logger.log("⚠ 這些鍵在表單上對不上:" + missing.join("、") + " —— 題目被刪掉或改了標題(對照 checkMemberUpdateForm 的「題目」那一段)");
  } else {
    Logger.log("✅ 11 個 entry 都對得上。");
  }
}

/* 網站上目前的 site-config.js 寫了什麼。用正規表示式取值,不把網站上的檔案當程式執行。 */
function siteConfigUpdateForm_() {
  try {
    var r = fetchSite_("site-config.js");
    if (r.code !== 200) return { error: "HTTP " + r.code };
    var mu = /UPDATE_FORM_URL\s*:\s*(["'])([^"'\n]*)\1/.exec(r.text);
    var me = /UPDATE_FORM_ENTRIES\s*:\s*\{([^}]*)\}/.exec(r.text);
    var entries = {};
    if (me) {
      var re = /["']?([A-Za-z_]+)["']?\s*:\s*(["'])([^"'\n]*)\2/g, m;
      while ((m = re.exec(me[1])) !== null) if (UPDATE_ENTRY_KEYS.indexOf(m[1]) >= 0) entries[m[1]] = m[3].trim();
    }
    return { url: mu ? mu[2].trim() : "", entries: entries };
  } catch (err) {
    return { error: errText_(err) };
  }
}
function normFormUrl_(u) { return String(u || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, ""); }
function normSiteBase_(u) { return String(u || "").trim().replace(/\/*$/, "/"); }

/* ── 觸發器與重建 ───────────────────────────────────────────────────── */

function installMemberUpdateTriggers_(form) {
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    var h = all[i].getHandlerFunction();
    if (h === UPDATE_TRIGGER || h === UPDATE_SYNC_TRIGGER) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  ScriptApp.newTrigger(UPDATE_TRIGGER).forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger(UPDATE_SYNC_TRIGGER).timeBased().everyHours(1).create();
  Logger.log("✅ 夥伴資料更新的觸發器已裝好:送出 1 個、每小時同步 1 個(清掉舊的 " + removed + " 個)");
}

/* 觸發器不見了、重複了,或搬到新的 Apps Script 專案之後,用這支重裝(不會累積) */
function setupMemberUpdateTriggers() { installMemberUpdateTriggers_(openUpdateForm_()); }

/* 讓腳本「忘記」更新表單,之後才能重新 createMemberUpdateForm。
   ① 補送清單還有東西就停下來(傳 true 才強制):忘記之後,那些送件就再也補送不了。
   ② 先關閉舊表單並設停用訊息:LINE 裡散落的舊連結(包括組長私訊的預填連結)送出時,
      夥伴會看到「已經停用」,而不是以為送出了、其實沒有任何人收到。
   ③ 只刪更新表單自己的屬性與觸發器;新夥伴表單、來賓表單的綁定完全不碰。 */
function forgetMemberUpdateForm(force) {
  var props = PropertiesService.getScriptProperties();
  var failed = failedRead_();
  if (failed.length && force !== true) {
    var ids = failed.slice(0, 10).map(function (x) { return x.rid; }).join("、") + (failed.length > 10 ? "…" : "");
    throw new Error("還有 " + failed.length + " 筆送失敗的更新沒有處理（回應 ID：" + ids + "）。" +
      "請先執行 resendFailedMemberUpdates，或用 dismissFailedMemberUpdate 逐筆處理，再忘記這份表單。" +
      "確定要丟掉，請執行 forgetMemberUpdateForm(true)。");
  }
  var editUrl = props.getProperty("UPDATE_FORM_EDIT_URL");
  if (editUrl) {
    try {
      FormApp.openByUrl(editUrl).setCustomClosedFormMessage(UPDATE_RETIRED_MSG).setAcceptingResponses(false);
      Logger.log("✅ 舊表單已關閉收件(填表的人會看到「已經停用」):" + editUrl);
    } catch (err) {
      Logger.log("✗ 舊表單沒有關閉，請自己打開它 →「回覆」→ 關掉「接受回覆」，否則 LINE 裡的舊連結送出後不會有任何人收到");
    }
  }
  var keys = ["UPDATE_FORM_EDIT_URL", "UPDATE_FORM_NAME_ITEM_ID", "UPDATE_FORM_NOTFOUND_PAGE_ID",
              "UPDATE_NAMES_SYNCED_AT", "UPDATE_FAILED_IDS", "UPDATE_NF_STATE"];
  for (var i = 0; i < keys.length; i++) props.deleteProperty(keys[i]);
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var j = 0; j < all.length; j++) {
    var h = all[j].getHandlerFunction();
    if (h === UPDATE_TRIGGER || h === UPDATE_SYNC_TRIGGER) { ScriptApp.deleteTrigger(all[j]); removed++; }
  }
  Logger.log("已忘記夥伴資料更新表單(刪掉 " + keys.length + " 筆屬性、" + removed + " 個觸發器;新夥伴表單與來賓表單不受影響)");
  Logger.log("接下來:");
  Logger.log("  1. 舊表單和回應試算表仍在 Drive,不要就自己刪掉");
  Logger.log("  2. 執行 createMemberUpdateForm 建新的,再跑 checkMemberUpdateForm");
  Logger.log("  3. site-config.js 的 UPDATE_FORM_URL 與 UPDATE_FORM_ENTRIES 兩行要換成新的,並通知組長舊的預填連結作廢");
}

/* ── 檢查(只讀不改)─────────────────────────────────────────────────
   每一行 ✅/✗,最後彙總。「可自動補送」「需人工處理」「找不到名字」三行只是資訊,不算 ✗。 */
function checkMemberUpdateForm() {
  var props = PropertiesService.getScriptProperties();
  var editUrl = props.getProperty("UPDATE_FORM_EDIT_URL");
  if (!editUrl) { Logger.log("✗ 還沒有夥伴資料更新表單(沒有 UPDATE_FORM_EDIT_URL)—— 先執行 createMemberUpdateForm"); return { bad: 1 }; }
  var form = FormApp.openByUrl(editUrl);
  var bad = 0;
  var line = function (label, ok, text) { if (ok === false) bad++; Logger.log(label + ":" + text); };

  line("表單          ", true, form.getTitle());

  if (typeof form.isPublished === "function") {
    var pub = null;
    try { pub = !!form.isPublished(); } catch (err) { pub = null; }
    if (pub === null) line("發布狀態      ", true, "? 讀不到發布狀態,略過");
    else line("發布狀態      ", pub, pub ? "✅ 已發布" : "✗ 未發布 —— 開表單編輯頁按右上角「發布」,回應者選「知道連結的任何人」");
  } else line("發布狀態      ", true, "? 這個帳號的表單沒有發布設定,略過");

  var acc = form.isAcceptingResponses();
  line("接受回應      ", acc, acc ? "✅" : "✗ 已關閉 —— 編輯頁「回覆」分頁打開「接受回覆」(如果是被熔斷自動關掉的,先看 README「八」的「被灌單怎麼辦」再打開)");
  var edits = form.canEditResponse();
  line("編輯回覆      ", !edits, !edits ? "✅ 關閉" : "✗ 開著 —— 夥伴每編輯一次就多一筆待審核,請到「設定 → 回覆」關掉「允許編輯回覆」");
  var summary = form.isPublishingSummary();
  line("結果摘要      ", !summary, !summary ? "✅ 不公開" : "✗ 填答者看得到所有人的回覆(包括備註)—— 到「設定 → 回覆」關掉「查看結果摘要」");
  /* 上傳題、收集電子郵件、「限制只能回覆 1 次」三種都會強制登入(建表時已關掉,這裡防網管事後打開;
     被灌單後很容易想用「限制只能回覆 1 次」擋重複送件)。原因分開列,網管才知道要關哪一個。
     讀不到「限制只能回覆 1 次」(舊環境沒有這個方法或讀取出錯)時視同沒開,不誤報。 */
  var uploads = form.getItems(FormApp.ItemType.FILE_UPLOAD).length, emails = form.collectsEmail();
  var limitOne = false;
  try { limitOne = typeof form.hasLimitOneResponsePerUser === "function" && !!form.hasLimitOneResponsePerUser(); } catch (err) { limitOne = false; }
  var loginWhy = [];
  if (uploads) loginWhy.push("刪掉上傳題(照片請夥伴用 LINE 傳給組長)");
  if (emails) loginWhy.push("到「設定 → 回覆」關掉「收集電子郵件」");
  if (limitOne) loginWhy.push("到「設定 → 回覆」關掉「限制只能回覆 1 次」(擋灌單請看 README「八」的「被灌單怎麼辦」)");
  line("登入要求      ", !loginWhy.length, !loginWhy.length ? "✅ 不需要登入"
    : "✗ 會要求登入,從 LINE 點進來的夥伴多半會卡住;請" + loginWhy.join("、"));

  // 名字選單
  var nameItem = updateNameItemById_(form);
  var syncedRaw = props.getProperty("UPDATE_NAMES_SYNCED_AT") || "", synced = Date.parse(syncedRaw);
  var syncedText = isFinite(synced) ? fmtTime_(new Date(synced), "yyyy/MM/dd HH:mm") : "從來沒有";
  var vals = nameItem ? nameItem.getChoices().map(function (c) { return c.getValue(); }) : [];
  if (!nameItem) line("名字選單      ", false, "✗ 找不到名字題(UPDATE_FORM_NAME_ITEM_ID 對不上)—— 名字題被刪掉重加過的話,請重建表單");
  else if (vals[vals.length - 1] !== UPDATE_NOT_FOUND) line("名字選單      ", false, "✗ 最後一個選項不是「" + UPDATE_NOT_FOUND + "」—— 執行 syncMemberUpdateNames");
  else if (!isFinite(synced) || Date.now() - synced > 2 * 3600 * 1000) line("名字選單      ", false, "✗ 超過 2 小時沒同步(上次同步 " + syncedText + ")—— 執行 syncMemberUpdateNames 看原因");
  else line("名字選單      ", true, "✅ " + (vals.length - 1) + " 位 +「" + UPDATE_NOT_FOUND + "」(上次同步 " + syncedText + ")");

  // 題目
  var qs = memberUpdateQuestionChecks_(form, nameItem), qbad = qs.filter(function (q) { return !q.ok; }).length;
  line("題目          ", !qbad, qbad ? "✗ 有 " + qbad + " 項不對(見下面)" : "✅ 全部對得上");
  for (var qi = 0; qi < qs.length; qi++) Logger.log("               " + (qs[qi].ok ? "✅ " : "✗ ") + qs[qi].label);

  // 觸發器
  var ns = 0, nh = 0, all = ScriptApp.getProjectTriggers();
  for (var t = 0; t < all.length; t++) {
    var h = all[t].getHandlerFunction();
    if (h === UPDATE_TRIGGER) ns++; else if (h === UPDATE_SYNC_TRIGGER) nh++;
  }
  var trigOk = ns === 1 && nh === 1;
  line("觸發器        ", trigOk, (trigOk ? "✅ " : "✗ ") + "送出 " + ns + " 個、每小時同步 " + nh + " 個" +
       (trigOk ? "" : "(都要剛好 1 個)—— 執行 setupMemberUpdateTriggers"));

  if (needsReauth_()) {
    line("授權狀態      ", false, "🔴 需要重新授權 —— 授權完成前觸發器不會跑,夥伴的更新會全部靜默失敗");
    Logger.log("   👉 用瀏覽器打開這個網址完成授權(複製整行):" +
      (reauthUrl_() || "(取不到授權網址 —— 到左側「觸發條件」頁,點觸發器的「⋮」→ 執行一次)"));
  } else line("授權狀態      ", true, "✅ 不需要重新授權");

  // Worker
  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  if (!relay) line("Worker        ", false, "✗ 沒設 RELAY_URL —— 到「專案設定 → 指令碼屬性」補上");
  else {
    var ping = null;
    /* ★ 一定要用 POST:Worker 對 POST 以外的方法一律回 405 method_not_allowed(後台的 /ping 也是 POST)。
       用 UrlFetch 預設的 GET 的話,這一行永遠是 ✗「Worker 太舊」,網管會被引導去重新部署一個沒問題的 Worker。 */
    try {
      ping = parseRelayResponse_(UrlFetchApp.fetch(relay + "/ping", {
        method: "post", contentType: "application/json", payload: "{}", muteHttpExceptions: true }));
    } catch (err) { ping = null; }
    var caps = ping && ping.out && ping.out.caps;
    if (!caps || caps.memberUpdate !== true) {
      line("Worker        ", false, "✗ Worker 太舊或沒綁 R2(/ping 的 caps.memberUpdate 不是 true)—— 請總管理員重新部署 publish-relay.js,並確認綁好 R2");
    } else {
      var site = String(ping.out.memberUpdateSite || "");
      var siteShow = /^https?:\/\/\S{1,200}$/.test(site) ? site : "(看不懂的網址)";
      if (normSiteBase_(site) !== normSiteBase_(SITE_BASE_URL)) {
        line("Worker        ", false, "✗ Worker 讀的網址(" + siteShow + ")和 SITE_BASE_URL(" + SITE_BASE_URL + ")不一樣 —— 請總管理員在 Cloudflare 設 SITE_BASE(見 worker/README)");
      } else line("Worker        ", true, "✅ caps.memberUpdate,讀名錄的網址 " + siteShow);
    }
  }

  // 連線與密碼:故意送空白,secret 對的話會回 bad_update
  if (!relay || !secret) line("連線與密碼    ", false, "✗ 沒設 RELAY_URL 或 INTAKE_SECRET");
  else {
    var probe = null;
    try {
      probe = parseRelayResponse_(UrlFetchApp.fetch(relay + "/member-update", {
        method: "post", contentType: "application/json", muteHttpExceptions: true,
        payload: JSON.stringify({ secret: secret, update: {} }) }));
    } catch (err) { probe = null; }
    var perr = probe && probe.out && typeof probe.out.error === "string" ? probe.out.error : "";
    if (perr === "bad_update") line("連線與密碼    ", true, "✅ 回 bad_update(預期,因為刻意送空白)");
    else if (perr === "bad_secret") line("連線與密碼    ", false, "✗ bad_secret —— INTAKE_SECRET 和 Cloudflare 上的不一樣");
    else if (perr === "intake_disabled") line("連線與密碼    ", false, "✗ intake_disabled —— Cloudflare 上還沒設 INTAKE_SECRET");
    else if (perr === "not_found") line("連線與密碼    ", false, "✗ not_found —— Worker 太舊,還沒有 /member-update(請總管理員重新部署)");
    else line("連線與密碼    ", false, "✗ " + (probe ? "HTTP " + probe.status + (/^[a-z0-9_]{1,40}$/.test(perr) ? " " + perr : "") : "連不到 Worker"));
  }

  // site-config
  var sc = siteConfigUpdateForm_();
  if (sc.error) line("site-config   ", false, "✗ 讀不到網站上的 site-config.js(" + sc.error + ")");
  else if (!sc.url && !objKeys_(sc.entries).length) line("site-config   ", false, "— 尚未貼進 site-config.js(README 部署表第 7 步;printMemberUpdateLinkConfig 會印出要貼的兩行)");
  else {
    var want = {};
    try { want = memberUpdateEntryIds_(form).ids; } catch (err) { want = {}; }
    var diffs = [];
    if (normFormUrl_(sc.url) !== normFormUrl_(form.getPublishedUrl())) diffs.push("UPDATE_FORM_URL");
    for (var k = 0; k < UPDATE_ENTRY_KEYS.length; k++) {
      var key = UPDATE_ENTRY_KEYS[k];
      if (!want[key] || sc.entries[key] !== want[key]) diffs.push(key);
    }
    line("site-config   ", !diffs.length, !diffs.length ? "✅ 網站上的 UPDATE_FORM_URL 與 11 個 entry 都對得上"
      : "✗ 對不上:" + diffs.join("、") + " —— 執行 printMemberUpdateLinkConfig 重貼");
  }

  var notifyTo = String(props.getProperty("NOTIFY_EMAIL") || "").trim();
  line("通知          ", !!notifyTo, notifyTo ? "NOTIFY_EMAIL ✅ " + notifyTo
    : "NOTIFY_EMAIL ✗ 沒設 —— 有人送出更新時,不會有任何人收到通知(執行 setNotifyEmail(\"組長群信箱\"))");
  try { Logger.log("今日可寄額度  :" + MailApp.getRemainingDailyQuota() + " 封"); }
  catch (err) { Logger.log("今日可寄額度  :取不到(通常就是還沒授權)"); }

  var fl = failedList_();
  Logger.log("可自動補送    :" + fl.auto.length + " 筆" + (fl.auto.length ? "(修好原因後執行 resendFailedMemberUpdates)" : ""));
  Logger.log("需人工處理    :" + fl.manual.length + " 筆" + (fl.manual.length ? ",逐筆照建議做法處理:" : ""));
  logManualFailures_(fl.manual);
  Logger.log("找不到名字    :累積 " + nfState_().n + " 人尚未寄出彙整信");
  Logger.log("─────");
  Logger.log(bad ? "⚠ 還有 " + bad + " 項沒過,先修好再發到 LINE。" : "✅ 全部正常,可以把表單網址發到 LINE。");
  return { bad: bad };
}

/* checkMemberUpdateForm 的「題目」逐項 */
function memberUpdateQuestionChecks_(form, nameItem) {
  var items = form.getItems(), byTitle = Object.create(null);
  for (var i = 0; i < items.length; i++) byTitle[normTitle_(items[i].getTitle())] = items[i];
  var has = function (titles) { for (var j = 0; j < titles.length; j++) if (hasOwn_(byTitle, titles[j])) return byTitle[titles[j]]; return null; };
  var out = [];
  for (var k = 0; k < UPDATE_FIELD_KEYS.length; k++) {
    out.push({ label: "「" + NEWMEMBER_Q[UPDATE_FIELD_KEYS[k]] + "」", ok: !!has(titlesFor_(UPDATE_FIELD_KEYS[k])) });
  }
  out.push({ label: "「" + UPDATE_Q.note + "」", ok: !!has([normTitle_(UPDATE_Q.note)]) });
  out.push({ label: "「" + UPDATE_Q.token + "」(不要刪掉或改名)", ok: !!has([normTitle_(UPDATE_Q.token)]) });
  var page = updateNotFoundPageById_(form);
  out.push({ label: "「" + UPDATE_Q.nfPage + "」那一頁", ok: !!page });
  var nf = has([normTitle_(UPDATE_Q.nfName)]), nfReq = false;
  try { nfReq = !!(nf && nf.asTextItem().isRequired()); } catch (err) { nfReq = false; }
  out.push({ label: "「" + UPDATE_Q.nfName + "」是必填", ok: nfReq });
  var navOk = false;
  try {
    var chs = nameItem ? nameItem.getChoices() : [], last = chs[chs.length - 1];
    var dest = last && last.getValue() === UPDATE_NOT_FOUND ? last.getGotoPage() : null;
    navOk = !!(page && dest && String(dest.getId()) === String(page.getId()) &&
               chs[0].getPageNavigationType() === FormApp.PageNavigationType.CONTINUE &&
               page.getPageNavigationType() === FormApp.PageNavigationType.SUBMIT);
  } catch (err) { navOk = false; }
  out.push({ label: "換頁設定(名字 → 第 2 頁、「" + UPDATE_NOT_FOUND + "」→ 出口頁、第 2 頁填完直接送出)", ok: navOk });
  return out;
}
