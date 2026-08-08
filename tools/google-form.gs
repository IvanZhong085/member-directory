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
 * ⚠ 重複執行 createVisitorForm 會被擋下(建立過就記在指令碼屬性裡)。
 *   要改題目請直接到表單編輯頁改;真的要重建請先跑 forgetForms_()。
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
     「縮圖拿不到」      → 不必處理,會自動改用原檔;只有原檔也超過 650KB 才會略過。
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
function guardAlreadyCreated_(propKey, fnName, label) {
  var url = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!url) return;
  throw new Error(
    "「" + label + "」表單已經建立過了,不要再跑一次 " + fnName + " ——\n" +
    "  現有的表單:" + url + "\n" +
    "  要改題目請直接開上面那個網址。\n" +
    "  真的要重建(例如換 Google 帳號)請先執行 forgetForms_(),它會告訴你接下來該做什麼。");
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
function onNewMemberSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var relay = String(props.getProperty("RELAY_URL") || "").replace(/\/+$/, "");
  var secret = props.getProperty("INTAKE_SECRET");
  if (!relay || !secret) { Logger.log("✗ 沒設 RELAY_URL / INTAKE_SECRET,這筆沒有送出"); return; }

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
    image:          photos.length ? driveImageDataUrl_(photos[0], 900, "形象照") : "",
    card:           cards.length ? driveImageDataUrl_(cards[0], 900, "名片照片") : "",
    products:       products.slice(0, 5).map(function (id, n) { return driveImageDataUrl_(id, 900, "商品照片 " + (n + 1)); })
                      .filter(function (s) { return !!s; }),
  };
  Logger.log("照片處理結果:形象照 " + (applicant.image ? "✓" : "✗") +
             "、名片 " + (applicant.card ? "✓" : "✗") +
             "、商品 " + applicant.products.length + "/" + Math.min(products.length, 5) + " 張");

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
   太大就再降一級寬度重試。

   縮圖有三個實際會踩到的狀況,所以不是「一次拿不到就放棄」:
   ① 表單剛上傳完就觸發,Drive 還沒把縮圖產出來,前幾秒問會是 404 —— 等一下再問。
   ② 縮圖網址有兩種,不是每個環境兩種都通(見 thumbBlob_)—— 兩種都試。
   ③ 有些檔案 Drive 始終不產縮圖 —— 退回用原檔,小張的照片這樣就夠了。
   全部失敗才回傳空字串(照片沒了,其他資料照樣進待認領區),並在紀錄裡寫清楚卡在哪。 */
function driveImageDataUrl_(fileId, maxWidth, label) {
  var widths = [maxWidth, 600, 400];
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
    Logger.log("⚠ " + tag + ":原檔超過 650KB 又沒有縮圖,這張略過");
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
  var b64 = Utilities.base64Encode(blob.getBytes());
  if (b64.length > 650 * 1024) return "";   // Worker 端單張上限約 700KB base64,留一點餘裕
  return "data:" + type + ";base64," + b64;
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
