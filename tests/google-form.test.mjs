/* Apps Script 沒辦法在本機跑,但 tools/google-form.gs 是純 JS:
   把它丟進 vm 沙箱、用假的 MailApp / PropertiesService / ScriptApp 頂替 Google 的服務,
   就能驗證「來賓報名 → 寄信到分會信箱」這條路的行為。
   跑法:node tests/google-form.test.mjs */
import fs from "node:fs";
import vm from "node:vm";
import { FakeGitHub, FakeR2, FakeKV, loadWorker } from "./github-model.mjs";

const src = fs.readFileSync(new URL("../tools/google-form.gs", import.meta.url), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "  —— " + detail : "")); }
}

/* 建一個乾淨的沙箱。props = 指令碼屬性的初始值;owner = Session 取得的擁有者信箱。 */
function makeEnv(props = {}, opts = {}) {
  const sent = [], logs = [], triggers = [];
  const mkTrigger = fn => ({ getHandlerFunction: () => fn });
  (opts.triggers || []).forEach(fn => triggers.push(mkTrigger(fn)));
  const env = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: k => { delete props[k]; },
    }) },
    MailApp: {
      sendEmail: (to, subject, body) => { if (opts.mailFail) throw new Error("Service invoked too many times"); sent.push({ to, subject, body }); },
      getRemainingDailyQuota: () => 99,
    },
    Logger: { log: s => logs.push(String(s)) },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.owner || "" }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: fn => ({ forForm: () => ({ onFormSubmit: () => ({ create: () => { triggers.push(mkTrigger(fn)); } }) }) }),
      getAuthorizationInfo: () => ({
        getAuthorizationStatus: () => (opts.needsReauth ? "REQUIRED" : "ENABLED"),
        getAuthorizationUrl: () => "https://example.test/auth",
      }),
      AuthMode: { FULL: "FULL" },
      AuthorizationStatus: { REQUIRED: "REQUIRED" },
    },
    FormApp: { openByUrl: () => ({ getTitle: () => "雲榮鑽石分會・來賓參訪報名" }) },
    SpreadsheetApp: { openById: id => ({ getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit" }) },
    Utilities: { formatDate: () => "2026/09/12 08:00" },
  };
  Object.assign(env, { __sent: sent, __logs: logs, __triggers: triggers, __props: props });
  vm.createContext(env);
  vm.runInContext(src, env, { filename: "google-form.gs" });
  return env;
}

/* 假的「表單送出」事件:answers 是 { 題目標題: 填答 }。 */
function fakeEvent(answers, destId) {
  const items = Object.entries(answers).map(([title, v]) => ({
    getItem: () => ({ getTitle: () => title }),
    getResponse: () => v,
  }));
  return { response: { getItemResponses: () => items }, source: { getDestinationId: () => destId || "" } };
}
const FULL = { "姓名": "王小明", "電話": "0912345678", "LINE ID": "wang_ming", "職業": "室內設計", "引薦人姓名": "曾俊凱" };

console.log("① 完整填答 → 一封信到 VISITOR_NOTIFY_EMAIL,內容齊全");
{
  const env = makeEnv({ VISITOR_NOTIFY_EMAIL: "host@example.com", ALERT_EMAIL: "alert@example.com" });
  env.onVisitorSubmit(fakeEvent(FULL, "SHEET123"));
  const m = env.__sent[0];
  ok("寄出 1 封", env.__sent.length === 1);
  ok("收件人是 VISITOR_NOTIFY_EMAIL", m && m.to === "host@example.com", m && m.to);
  ok("主旨含姓名與職業", m && m.subject === "【來賓報名】王小明(室內設計)", m && m.subject);
  ok("內文含電話", m && m.body.includes("電話：0912345678"));
  ok("內文含 LINE ID", m && m.body.includes("LINE ID：wang_ming"));
  ok("內文含引薦人", m && m.body.includes("引薦人：曾俊凱"));
  ok("內文含送出時間", m && m.body.includes("送出時間：2026/09/12 08:00"));
  ok("內文含試算表連結", m && m.body.includes("https://docs.google.com/spreadsheets/d/SHEET123/edit"));
  ok("內文含不要轉寄的警語", m && m.body.includes("不要轉寄到群組"));
  ok("內文含共用頁尾", m && m.body.includes("Apps Script 自動寄出"));
  ok("執行紀錄不含電話與 LINE", env.__logs.join("\n").includes("已寄到 host@example.com") && !env.__logs.join("\n").includes("0912345678") && !env.__logs.join("\n").includes("wang_ming"));
}

console.log("② 收件人退路:VISITOR_NOTIFY_EMAIL → NOTIFY_EMAIL → ALERT_EMAIL → 擁有者");
{
  const a = makeEnv({ NOTIFY_EMAIL: "leaders@example.com", ALERT_EMAIL: "alert@example.com" });
  a.onVisitorSubmit(fakeEvent(FULL));
  ok("沒設專用信箱時寄到 NOTIFY_EMAIL", a.__sent[0] && a.__sent[0].to === "leaders@example.com", a.__sent[0] && a.__sent[0].to);
  const b = makeEnv({ ALERT_EMAIL: "yunrong@example.com" });
  b.onVisitorSubmit(fakeEvent(FULL));
  ok("只設 ALERT_EMAIL(分會信箱)時寄到它", b.__sent[0] && b.__sent[0].to === "yunrong@example.com", b.__sent[0] && b.__sent[0].to);
  const c = makeEnv({}, { owner: "owner@example.com" });
  c.onVisitorSubmit(fakeEvent(FULL));
  ok("都沒設時退回腳本擁有者", c.__sent[0] && c.__sent[0].to === "owner@example.com", c.__sent[0] && c.__sent[0].to);
  const d = makeEnv({ VISITOR_NOTIFY_EMAIL: "  " , ALERT_EMAIL: "alert@example.com" });
  d.onVisitorSubmit(fakeEvent(FULL));
  ok("專用信箱是空白時視同沒設", d.__sent[0] && d.__sent[0].to === "alert@example.com");
}

console.log("③ 沒有任何收件人 → 不寄、不拋錯、留紀錄");
{
  const env = makeEnv({});
  let threw = false;
  try { env.onVisitorSubmit(fakeEvent(FULL)); } catch (e) { threw = true; }
  ok("不拋例外", !threw);
  ok("沒寄信", env.__sent.length === 0);
  ok("紀錄說明沒有收件人", env.__logs.some(l => l.includes("沒有收件人")));
}

console.log("④ 惡作劇填答:多行、超長的姓名不會撐爆主旨");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  const longName = "王".repeat(500) + "\nBcc: evil@example.com";
  env.onVisitorSubmit(fakeEvent({ ...FULL, "姓名": longName, "電話": "09\n12" }));
  const m = env.__sent[0];
  ok("主旨單行", m && !/[\r\n]/.test(m.subject));
  ok("主旨截到 80 字加省略號", m && m.subject.includes("王".repeat(80) + "…") && m.subject.length < 120, m && m.subject.length);
  ok("電話欄位壓成一行", m && m.body.includes("電話：09 12"));
}

console.log("⑤ 沒填引薦人 → 明講是自己找上門");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  env.onVisitorSubmit(fakeEvent({ ...FULL, "引薦人姓名": "" }));
  ok("引薦人顯示為沒有引薦人", env.__sent[0] && env.__sent[0].body.includes("引薦人：(沒有引薦人"));
}

console.log("⑥ 題目標題有多餘空白或全形括號仍對得上;多出來的題目被忽略");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  env.onVisitorSubmit(fakeEvent({ " 姓名 ": "李小華", "LINE  ID": "lee", "電話": "0900", "職業": "會計", "引薦人姓名": "", "額外的題目": "x" }));
  const m = env.__sent[0];
  ok("姓名對得上", m && m.subject.includes("李小華"), m && m.subject);
  ok("LINE ID 對得上", m && m.body.includes("LINE ID：lee"));
  ok("多出來的題目不會出現在信裡", m && !m.body.includes("額外的題目"));
}

console.log("⑦ 寄信服務丟例外 → 不拋錯、紀錄寄不出去");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" }, { mailFail: true });
  let threw = false;
  try { env.onVisitorSubmit(fakeEvent(FULL)); } catch (e) { threw = true; }
  ok("不拋例外", !threw);
  ok("紀錄說寄不出去", env.__logs.some(l => l.includes("寄不出去")));
}

console.log("⑧ 直接按「執行」(沒有事件物件)→ 只印提示");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  let threw = false;
  try { env.onVisitorSubmit(); env.onVisitorSubmit({}); } catch (e) { threw = true; }
  ok("不拋例外", !threw);
  ok("沒寄信", env.__sent.length === 0);
  ok("提示要跑 setupVisitorNotify", env.__logs.some(l => l.includes("setupVisitorNotify")));
}

console.log("⑨ 試算表連結拿不到 → 信照寄、只是沒有連結");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  env.SpreadsheetApp.openById = () => { throw new Error("no access"); };
  env.onVisitorSubmit(fakeEvent(FULL, "SHEET123"));
  ok("照樣寄出", env.__sent.length === 1);
  ok("信裡沒有試算表段落", env.__sent[0] && !env.__sent[0].body.includes("來賓 CRM 試算表"));
}

console.log("⑩ setupVisitorNotify:清掉重複觸發器、裝一個新的、寄測試信");
{
  const env = makeEnv({ VISITOR_FORM_EDIT_URL: "https://docs.google.com/forms/d/x/edit", ALERT_EMAIL: "a@example.com" },
                      { triggers: ["onVisitorSubmit", "onVisitorSubmit", "onNewMemberSubmit"] });
  env.setupVisitorNotify();
  const mine = env.__triggers.filter(t => t.getHandlerFunction() === "onVisitorSubmit").length;
  const other = env.__triggers.filter(t => t.getHandlerFunction() === "onNewMemberSubmit").length;
  ok("同名觸發器只剩 1 個", mine === 1, mine);
  ok("別的觸發器不受影響", other === 1);
  ok("紀錄說清掉 2 個舊的", env.__logs.some(l => l.includes("清掉舊的 2 個")));
  ok("寄了一封測試信", env.__sent.length === 1 && env.__sent[0].subject.includes("通知設定測試"));
  ok("印出實際收件人", env.__logs.some(l => l.includes("實際收件人") && l.includes("a@example.com")));
}

console.log("⑪ setupVisitorNotify 沒有表單編輯網址 → 明確的錯誤訊息");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  let msg = "";
  try { env.setupVisitorNotify(); } catch (e) { msg = String(e.message || e); }
  ok("拋出含 createVisitorForm 的提示", msg.includes("createVisitorForm"), msg);
  ok("沒裝觸發器、沒寄信", env.__triggers.length === 0 && env.__sent.length === 0);
}

console.log("⑫ 需要重新授權時:印授權網址、不寄測試信");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" }, { needsReauth: true, triggers: ["onVisitorSubmit"] });
  env.checkVisitorNotify();
  ok("印出授權網址", env.__logs.some(l => l.includes("https://example.test/auth")));
  ok("不寄測試信", env.__sent.length === 0);
}

console.log("⑬ setVisitorNotifyEmail:寫入屬性、擋掉不像 email 的值、空字串清掉");
{
  const env = makeEnv({});
  env.setVisitorNotifyEmail("host@example.com");
  ok("寫入 VISITOR_NOTIFY_EMAIL", env.__props.VISITOR_NOTIFY_EMAIL === "host@example.com");
  let threw = false;
  try { env.setVisitorNotifyEmail("not an email"); } catch (e) { threw = true; }
  ok("不像 email 就拋錯", threw);
  env.setVisitorNotifyEmail("");
  ok("空字串清掉屬性", !("VISITOR_NOTIFY_EMAIL" in env.__props));
}

console.log("⑭ checkNotifySetup 也會印出來賓通知的收件人設定");
{
  const env = makeEnv({ ALERT_EMAIL: "a@example.com" });
  env.checkNotifySetup();
  ok("有 VISITOR_NOTIFY_EMAIL 那一行", env.__logs.some(l => l.startsWith("VISITOR_NOTIFY_EMAIL")));
}

/* ══════════════════════════════════════════════════════════════════════════
   夥伴資料更新表單(createMemberUpdateForm / onMemberUpdateSubmit / 補送 / 檢查)
   假物件照 Google 官方文件的行為:ListItem 的 setChoices([])、setChoiceValues([]) 會丟例外,
   createResponse(不在選項裡的值) 會丟例外;CacheService 期限最多 6 小時、單值 100 KB;
   指令碼屬性單值最多 9 KB。假的表單設定預設值故意放在「不安全」那一邊
   (收集 email、允許編輯、公開結果摘要、未發布),才驗得出程式有沒有明確關掉。
   ══════════════════════════════════════════════════════════════════════════ */
const SITE = "https://ivanzhong085.github.io/member-directory/";
const RELAY = "https://relay.example.test";
const SECRET = "s3cr3t-DO-NOT-LEAK-42";
const LOCKED_KEYS = ["UPDATE_FAILED_IDS", "UPDATE_MAIL_DEDUPE", "UPDATE_NOTIFY_LAST_AT", "UPDATE_NF_STATE"];
const ITEM = { LIST: "LIST", TEXT: "TEXT", PARAGRAPH_TEXT: "PARAGRAPH_TEXT", PAGE_BREAK: "PAGE_BREAK", SECTION_HEADER: "SECTION_HEADER", FILE_UPLOAD: "FILE_UPLOAD" };
const NAV = { CONTINUE: "CONTINUE", GO_TO_PAGE: "GO_TO_PAGE", RESTART: "RESTART", SUBMIT: "SUBMIT" };
const UPD_FIELDS = ["company", "business_items", "website", "have", "want", "title", "services", "targets", "tagline"];
const ENTRY_KEYS = ["member", "title", "company", "services", "targets", "have", "want", "tagline", "business_items", "website", "token"];
const NAME_Q = "請選你的名字", NF = "找不到我的名字";

const baseGroups = () => [
  { code: "A1", name: "肉品海鮮批發組", members: [{ name: "曾俊凱" }, { name: "王大銘" }, { name: "李 小華" }] },
  { code: "B2", name: "蔬果點心供應組", members: [{ name: "陳美玲" }, { name: "張三" }] },
];
const dataJs = groups => "// 會員名錄資料檔\nconst GROUPS = " + JSON.stringify(groups, null, 2) + ";\n";
const bytes = s => Buffer.byteLength(String(s), "utf8");
const HOUR = 3600 * 1000;

class FakeChoice {
  constructor(value, nav, page) { this.value = value; this.nav = nav; this.page = page; }
  getValue() { return this.value; } getPageNavigationType() { return this.nav; } getGotoPage() { return this.page; }
}
class FakeItem {
  constructor(form, type) {
    this.form = form; this.type = type; this.id = form.st.nextItemId++; this.title = ""; this.help = "";
    this.required = false; this.choices = []; this.goTo = null; this.navType = null; this.choiceWrites = 0;
  }
  getId() { return this.id; } getType() { return this.type; }
  getTitle() { return this.title; } setTitle(t) { this.title = String(t); return this; }
  getHelpText() { return this.help; } setHelpText(t) { this.help = String(t); return this; }
  setRequired(b) { this.required = !!b; return this; } isRequired() { return this.required; }
  cast(t) { if (this.type !== t) throw new Error("Item " + this.id + " is not a " + t); return this; }
  asListItem() { return this.cast(ITEM.LIST); } asTextItem() { return this.cast(ITEM.TEXT); }
  asParagraphTextItem() { return this.cast(ITEM.PARAGRAPH_TEXT); } asPageBreakItem() { return this.cast(ITEM.PAGE_BREAK); }
  setChoiceValues(vals) {
    if (!vals || !vals.length) throw new Error("Array must not be empty");
    this.choices = vals.map(v => new FakeChoice(String(v), null, null)); this.choiceWrites++; return this;
  }
  setChoices(chs) {
    if (!chs || !chs.length || chs.some(c => c == null)) throw new Error("Array must not be empty or contain null");
    this.choices = chs.slice(); this.choiceWrites++; return this;
  }
  getChoices() { return this.choices.slice(); }
  createChoice(value, x) { return x instanceof FakeItem ? new FakeChoice(String(value), NAV.GO_TO_PAGE, x) : new FakeChoice(String(value), x || null, null); }
  createResponse(v) {
    if (this.type === ITEM.LIST && !this.choices.some(c => c.value === v)) throw new Error("Invalid response submitted to item");
    const item = this; return { item, value: v, getItem: () => item, getResponse: () => v };
  }
  setGoToPage(x) { if (x instanceof FakeItem) { this.goTo = x; this.navType = NAV.GO_TO_PAGE; } else { this.goTo = null; this.navType = x; } return this; }
  getGoToPage() { return this.goTo; } getPageNavigationType() { return this.navType; }
}
class FakeForm {
  constructor(st, title) {
    this.st = st; this.title = title; this.no = st.nextFormNo++; this.items = []; this.responses = new Map(); this.dest = ""; this.desc = "";
    this.f = { collectEmail: true, allowEdits: true, limitOne: true, summary: true, published: false, accepting: true, closedMsg: "", confirm: "" };
  }
  getTitle() { return this.title; } setDescription(d) { this.desc = String(d); return this; }
  getEditUrl() { return "https://docs.google.com/forms/d/FORM" + this.no + "/edit"; }
  getPublishedUrl() { return "https://docs.google.com/forms/d/e/1FAIpQLSe" + this.no + "/viewform"; }
  setCollectEmail(b) { this.f.collectEmail = !!b; return this; } collectsEmail() { return this.f.collectEmail; }
  setAllowResponseEdits(b) { this.f.allowEdits = !!b; return this; } canEditResponse() { return this.f.allowEdits; }
  setLimitOneResponsePerUser(b) { this.f.limitOne = !!b; return this; } hasLimitOneResponsePerUser() { return this.f.limitOne; }
  setPublishingSummary(b) { this.f.summary = !!b; return this; } isPublishingSummary() { return this.f.summary; }
  setPublished(b) { this.f.published = !!b; return this; } isPublished() { return this.f.published; }
  setAcceptingResponses(b) { this.f.accepting = !!b; return this; } isAcceptingResponses() { return this.f.accepting; }
  setCustomClosedFormMessage(m) { this.f.closedMsg = String(m); return this; }
  setConfirmationMessage(m) { this.f.confirm = String(m); return this; }
  setDestination(type, id) { this.dest = id; return this; }
  getDestinationId() { if (!this.dest) throw new Error("This form has no response destination"); return this.dest; }
  add(type) { const it = new FakeItem(this, type); this.items.push(it); return it; }
  addListItem() { return this.add(ITEM.LIST); } addTextItem() { return this.add(ITEM.TEXT); }
  addParagraphTextItem() { return this.add(ITEM.PARAGRAPH_TEXT); } addPageBreakItem() { return this.add(ITEM.PAGE_BREAK); }
  addSectionHeaderItem() { return this.add(ITEM.SECTION_HEADER); }
  getItems(type) { return type ? this.items.filter(i => i.type === type) : this.items.slice(); }
  getItemById(id) { return this.items.find(i => String(i.id) === String(id)) || null; }
  getResponse(id) { const r = this.responses.get(String(id)); if (!r) throw new Error("Invalid response ID"); return r; }
  createResponse() {
    const parts = [], form = this;
    const fr = {
      withItemResponse(ir) { parts.push(ir); return fr; },
      toPrefilledUrl() { return form.getPublishedUrl() + "?usp=pp_url&" + parts.map(p => "entry." + (p.item.id * 7 + 100000) + "=" + encodeURIComponent(p.value).replace(/%20/g, "+")).join("&"); },
    };
    return fr;
  }
  byTitle(t) { return this.items.find(i => i.title === t); }
}

/* 預設的 Worker:secret 對、有 name/group 就收件。回應照 §3.5-16 的形狀;
   ignored 帶「值」,用來驗證 Apps Script 的紀錄只記欄位鍵。 */
function defaultWorker(body, st) {
  const u = body.update || {};
  if (body.secret !== SECRET) return [401, { ok: false, error: "bad_secret" }];
  if (!u.name || !u.group) return [400, { ok: false, error: "bad_update" }];
  const fields = Object.keys(u.changes || {}).filter(k => String(u.changes[k]).trim());
  return [200, { ok: true, uid: "u_test" + String(++st.uidSeq).padStart(4, "0"), memberId: "g3_m1", name: u.name, code: u.group,
    fields, ignored: [{ field: "tagline", value: "佔位字內容Q" }], invalid: [{ field: "website", value: "不合格網址內容Q" }],
    untouched: ["title"], stalePrefill: [], cleared: [], truncated: [], confirmOnly: false, hasNote: !!u.note,
    open: 3, groupOpen: 1, oldestAt: new Date(Date.now() - 2 * 86400000 - 60000).toISOString() }];
}
const workerSays = (code, error) => () => [code, { ok: false, error }];

function makeUpd(opts = {}) {
  const props = Object.assign({ RELAY_URL: RELAY, INTAKE_SECRET: SECRET, ALERT_EMAIL: "alert@example.com", NOTIFY_EMAIL: "leaders@example.com" }, opts.props || {});
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  const st = {
    groups: baseGroups(), dataStatus: 200, dataThrow: false, siteConfig: null,
    ping: { ok: true, caps: { memberUpdate: true }, memberUpdateSite: SITE },
    worker: null, onPost: null, posts: [], fetches: [], sent: [], logs: [], triggers: [], quota: 99, mailThrow: false,
    cache: new Map(), cachePuts: [], lockHeld: false, lockMisses: 0, unlockedWrites: [], propFail: null,
    forms: new Map(), nextItemId: 1, nextFormNo: 1, nextSheet: 1, sleeps: 0, uidSeq: 0, createCalls: 0, needsReauth: false,
  };
  const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const propsSvc = {
    getProperty: k => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
    setProperty: (k, v) => {
      if (st.propFail && st.propFail(k)) throw new Error("Exception: 服務暫時無法使用");
      const s = String(v);
      if (bytes(s) > 9 * 1024) throw new Error("Exception: Argument too large: value");
      if (LOCKED_KEYS.includes(k) && !st.lockHeld) st.unlockedWrites.push(k);
      props[k] = s; return propsSvc;
    },
    deleteProperty: k => { delete props[k]; return propsSvc; },
  };
  const mkTrigger = (fn, kind) => ({ getHandlerFunction: () => fn, kind });
  const pad = n => String(n).padStart(2, "0");
  const env = {
    PropertiesService: { getScriptProperties: () => propsSvc },
    MailApp: {
      sendEmail: (to, subject, body) => { if (st.mailThrow) throw new Error("Service invoked too many times"); st.sent.push({ to, subject, body }); },
      getRemainingDailyQuota: () => st.quota,
    },
    Logger: { log: s => st.logs.push(String(s)) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }), getScriptTimeZone: () => "Asia/Taipei" },
    Utilities: {
      formatDate: (d, tz, fmt) => fmt.replace("yyyy", d.getUTCFullYear()).replace("MM", pad(d.getUTCMonth() + 1)).replace("dd", pad(d.getUTCDate()))
                                     .replace("HH", pad(d.getUTCHours())).replace("mm", pad(d.getUTCMinutes())),
      sleep: () => { st.sleeps++; },
    },
    LockService: { getScriptLock: () => {
      let mine = false;
      return {
        tryLock: () => { if (st.lockHeld) { st.lockMisses++; return false; } st.lockHeld = true; mine = true; return true; },
        releaseLock: () => { if (mine) { st.lockHeld = false; mine = false; } },
        hasLock: () => mine,
      };
    } },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = st.cache.get(k); if (!e) return null; if (e.exp <= Date.now()) { st.cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => {
        if (!(ttl >= 1 && ttl <= 21600)) throw new Error("Exception: 期限超出範圍(最多 21600 秒)");
        if (String(k).length > 250 || bytes(v) > 100 * 1024) throw new Error("Exception: Argument too large");
        st.cachePuts.push({ k, ttl }); st.cache.set(k, { v: String(v), exp: Date.now() + ttl * 1000 });
      },
      remove: k => { st.cache.delete(k); },
    }) },
    UrlFetchApp: { fetch: (url, o = {}) => {
      st.fetches.push(url);
      if (url.startsWith(SITE)) {
        const path = url.slice(SITE.length).replace(/[?&]t=\d+$/, "");
        if (path === "data.js") {
          if (st.dataThrow) throw new Error("Exception: DNS error: ivanzhong085.github.io");
          return resp(st.dataStatus, st.dataStatus === 200 ? dataJs(st.groups) : "<h1>oops</h1>");
        }
        if (path === "site-config.js") return st.siteConfig == null ? resp(404, "") : resp(200, st.siteConfig);
        return resp(404, "");
      }
      /* st.relay:把對 Worker 的請求整個交給測試(㊱ 用它把請求轉給真正的 Worker) */
      if (st.relay && url.startsWith(RELAY + "/")) {
        const [code, out] = st.relay(url, o);
        return resp(code, typeof out === "string" ? out : JSON.stringify(out));
      }
      /* 跟真正的 Worker 一樣:POST 以外一律 405。UrlFetch 預設是 GET,忘了寫 method 這裡就會露餡 */
      if (url.startsWith(RELAY + "/") && String(o.method || "get").toLowerCase() !== "post") {
        return resp(405, JSON.stringify({ ok: false, error: "method_not_allowed" }));
      }
      if (url === RELAY + "/ping") return resp(200, JSON.stringify(st.ping));
      if (url === RELAY + "/member-update") {
        const body = JSON.parse(o.payload);
        st.posts.push(body);
        if (st.onPost) st.onPost(body);
        const [code, out] = (st.worker || defaultWorker)(body, st);
        if (code === "throw") throw new Error("Exception: Address unavailable: " + RELAY + "/member-update");
        return resp(code, typeof out === "string" ? out : JSON.stringify(out));
      }
      return resp(404, JSON.stringify({ ok: false, error: "not_found" }));
    } },
    ScriptApp: {
      getProjectTriggers: () => st.triggers.slice(),
      deleteTrigger: t => { const i = st.triggers.indexOf(t); if (i >= 0) st.triggers.splice(i, 1); },
      newTrigger: fn => ({
        forForm: () => ({ onFormSubmit: () => ({ create: () => { st.triggers.push(mkTrigger(fn, "submit")); } }) }),
        timeBased: () => ({
          everyHours: n => ({ create: () => { if (![1, 2, 4, 6, 8, 12].includes(n)) throw new Error("everyHours 只接受 1,2,4,6,8,12"); st.triggers.push(mkTrigger(fn, "hourly:" + n)); } }),
          onMonthDay: () => ({ atHour: () => ({ create: () => { st.triggers.push(mkTrigger(fn, "monthly")); } }) }),
        }),
      }),
      getAuthorizationInfo: () => ({ getAuthorizationStatus: () => (st.needsReauth ? "REQUIRED" : "ENABLED"), getAuthorizationUrl: () => "https://example.test/auth" }),
      AuthMode: { FULL: "FULL" }, AuthorizationStatus: { REQUIRED: "REQUIRED" },
    },
    FormApp: {
      create: title => { st.createCalls++; const f = new FakeForm(st, title); st.forms.set(f.getEditUrl(), f); return f; },
      openByUrl: url => { const f = st.forms.get(String(url)); if (!f) throw new Error("No item with the given ID could be found."); return f; },
      ItemType: ITEM, PageNavigationType: NAV, DestinationType: { SPREADSHEET: "SPREADSHEET" },
    },
    SpreadsheetApp: {
      create: title => { const id = "SHEET" + (st.nextSheet++); return { getId: () => id, getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit", title }; },
      openById: id => ({ getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit" }),
    },
  };
  for (const fn of (opts.triggers || [])) st.triggers.push(mkTrigger(fn, "old"));
  vm.createContext(env);
  vm.runInContext(src, env, { filename: "google-form.gs" });
  env.__st = st; env.__props = props;
  return env;
}

/* 建好表單並清掉建立過程的紀錄,回傳假表單 */
function setupForm(env) {
  env.createMemberUpdateForm();
  const form = env.__st.forms.get(env.__props.UPDATE_FORM_EDIT_URL);
  const st = env.__st;
  st.logs.length = 0; st.sent.length = 0; st.fetches.length = 0; st.posts.length = 0;
  return form;
}
let ridSeq = 0;
/* 模擬一筆表單送出:answers = { 題目標題: 填答 }。noTrigger 時只建回應(給補送用)。 */
function answer(env, form, answers, o = {}) {
  const rid = o.rid || "2_ABaOnud" + String(++ridSeq).padStart(6, "0");
  const ts = o.ts || new Date();
  const irs = [];
  for (const [title, v] of Object.entries(answers)) {
    const it = form.byTitle(title);
    if (!it) throw new Error("測試寫錯了:表單上沒有「" + title + "」");
    irs.push({ getItem: () => it, getResponse: () => v });
  }
  const r = { getId: () => rid, getTimestamp: () => ts, getItemResponses: () => irs };
  form.responses.set(rid, r);
  const out = o.noTrigger ? null : env.onMemberUpdateSubmit({ response: r, source: form });
  return { rid, out };
}
const failedOf = env => JSON.parse(env.__props.UPDATE_FAILED_IDS || "[]");
const failedRid = (env, rid) => failedOf(env).find(x => x.rid === rid);
const logText = env => env.__st.logs.join("\n");
const mailText = env => env.__st.sent.map(m => m.subject + "\n" + m.body).join("\n=====\n");

console.log("⑮ createMemberUpdateForm:讀不到名錄 → 在 FormApp.create 之前就停下,不寫任何屬性");
{
  const cases = [
    ["data.js 404", st => { st.dataStatus = 404; }],
    ["抓 data.js 丟例外(DNS)", st => { st.dataThrow = true; }],
    ["名錄 0 位夥伴", st => { st.groups = [{ code: "A1", name: "x", members: [] }]; }],
    ["某一組缺 members", st => { st.groups = [{ code: "A1", name: "x" }]; }],
  ];
  for (const [why, tweak] of cases) {
    const env = makeUpd();
    tweak(env.__st);
    const before = JSON.stringify(env.__props);
    let msg = "";
    try { env.createMemberUpdateForm(); } catch (e) { msg = String(e.message || e); }
    ok(why + " → 丟出「表單還沒建立」", msg.includes("表單還沒建立"), msg);
    ok(why + " → 沒有呼叫 FormApp.create", env.__st.createCalls === 0);
    ok(why + " → 沒有寫入任何屬性", JSON.stringify(env.__props) === before);
  }
  const env = makeUpd({ props: { INTAKE_SECRET: undefined } });
  let msg = "";
  try { env.createMemberUpdateForm(); } catch (e) { msg = String(e.message || e); }
  ok("少 INTAKE_SECRET → 和新夥伴表單相同的提示,也沒建表單", msg.includes("RELAY_URL 與 INTAKE_SECRET") && env.__st.createCalls === 0, msg);
}

console.log("⑯ createMemberUpdateForm:題目、設定、換頁、屬性、觸發器、執行紀錄");
{
  const env = makeUpd({ triggers: ["onNewMemberSubmit"] });
  const nm = new FakeForm(env.__st, "雲榮鑽石分會・新夥伴資料填寫");
  env.__st.forms.set(nm.getEditUrl(), nm);
  env.__props.MEMBER_FORM_EDIT_URL = nm.getEditUrl();
  env.createMemberUpdateForm();
  const form = env.__st.forms.get(env.__props.UPDATE_FORM_EDIT_URL);
  ok("建了 1 份表單,標題照定稿", env.__st.createCalls === 1 && form && form.getTitle() === "雲榮鑽石分會・夥伴資料更新");
  const titles = form.items.map(i => i.title);
  const want = [NAME_Q, "要更新的內容", "補上還沒有的資料", "所屬公司", "主要營業項目", "公司網站", "我有…", "我要…",
    "修改名錄上已經有的內容", "行業／職稱", "服務項目", "適合引薦對象", "25 秒自我介紹 Slogan", "給組長的備註", "連結代碼",
    "找不到自己的名字？", "你的姓名", "想更新什麼"];
  ok("18 題的順序照定稿", JSON.stringify(titles) === JSON.stringify(want), titles.join("|"));
  const types = form.items.map(i => i.type).join(",");
  ok("題型照定稿", types === "LIST,PAGE_BREAK,SECTION_HEADER,TEXT,PARAGRAPH_TEXT,TEXT,PARAGRAPH_TEXT,PARAGRAPH_TEXT,SECTION_HEADER,TEXT,PARAGRAPH_TEXT,PARAGRAPH_TEXT,PARAGRAPH_TEXT,PARAGRAPH_TEXT,TEXT,PAGE_BREAK,TEXT,PARAGRAPH_TEXT", types);
  const req = form.items.filter(i => i.required).map(i => i.title);
  ok("只有「請選你的名字」和「你的姓名」是必填", JSON.stringify(req) === JSON.stringify([NAME_Q, "你的姓名"]), req.join(","));
  ok("沒有上傳題", form.getItems(ITEM.FILE_UPLOAD).length === 0);

  const nameItem = form.byTitle(NAME_Q), nfPage = form.byTitle("找不到自己的名字？");
  const vals = nameItem.choices.map(c => c.value);
  ok("名字選項依組別排好,最後是「找不到我的名字」", JSON.stringify(vals) === JSON.stringify(["A1・曾俊凱", "A1・王大銘", "A1・李 小華", "B2・陳美玲", "B2・張三", NF]), vals.join("|"));
  ok("名字選項 → 繼續到第 2 頁", nameItem.choices.slice(0, -1).every(c => c.nav === NAV.CONTINUE));
  ok("「找不到我的名字」→ 跳到出口頁", nameItem.choices[vals.length - 1].page === nfPage);
  ok("出口頁設成「送出」:第 2 頁填完直接送出", nfPage.navType === NAV.SUBMIT);
  ok("名字題說明列出各組", nameItem.help.includes("名字依組別排列：A1 肉品海鮮批發組、B2 蔬果點心供應組") && nameItem.help.includes("找不到我的名字"), nameItem.help);
  ok("第 2 頁說明附名錄網址", form.byTitle("要更新的內容").help.includes(SITE));
  ok("連結代碼的說明請夥伴不要動", form.byTitle("連結代碼").help.includes("不要修改"));
  ok("說明最後一行是新夥伴表單網址", form.desc.includes("・還沒上架名錄的新夥伴，請改填新夥伴表單：" + nm.getPublishedUrl()), form.desc);
  ok("出口頁也附新夥伴表單網址", nfPage.help.includes(nm.getPublishedUrl()));

  ok("★ 結果摘要關閉(isPublishingSummary 是 false)", form.isPublishingSummary() === false);
  ok("已發布", form.isPublished() === true);
  ok("不收集 email、不允許編輯回覆、不限一人一次", !form.collectsEmail() && !form.canEditResponse() && form.f.limitOne === false);
  ok("確認訊息照定稿", form.f.confirm.startsWith("✅ 收到了，謝謝你！") && form.f.confirm.includes("要換照片：直接用 LINE 傳給你的組長"));
  ok("回應進試算表", /^SHEET\d+$/.test(form.dest));

  ok("UPDATE_FORM_EDIT_URL 已存", env.__props.UPDATE_FORM_EDIT_URL === form.getEditUrl());
  ok("UPDATE_FORM_NAME_ITEM_ID 是名字題的 ID", env.__props.UPDATE_FORM_NAME_ITEM_ID === String(nameItem.id));
  ok("UPDATE_FORM_NOTFOUND_PAGE_ID 是出口頁的 ID", env.__props.UPDATE_FORM_NOTFOUND_PAGE_ID === String(nfPage.id));
  ok("UPDATE_NAMES_SYNCED_AT 是剛剛", Math.abs(Date.parse(env.__props.UPDATE_NAMES_SYNCED_AT) - Date.now()) < 60000);
  const trig = env.__st.triggers;
  ok("送出觸發器 1 個", trig.filter(t => t.getHandlerFunction() === "onMemberUpdateSubmit" && t.kind === "submit").length === 1);
  ok("每小時同步觸發器 1 個", trig.filter(t => t.getHandlerFunction() === "syncMemberUpdateNames" && t.kind === "hourly:1").length === 1);
  ok("新夥伴表單的觸發器不受影響", trig.filter(t => t.getHandlerFunction() === "onNewMemberSubmit").length === 1);

  const log = env.__st.logs;
  ok("執行紀錄 ① 是表單網址", log.some(l => l.startsWith("①") && l.includes(form.getPublishedUrl())));
  ok("執行紀錄 ④ 是已發布", log.some(l => l.startsWith("④") && l.includes("✅ 已發布")));
  ok("執行紀錄 ⑤ 是 5 位", log.some(l => l.startsWith("⑤") && l.includes("5 位")));
  const entLine = log.find(l => l.includes("UPDATE_FORM_ENTRIES:")) || "";
  const ents = Object.fromEntries([...entLine.matchAll(/(\w+):"(entry\.\d+)"/g)].map(m => [m[1], m[2]]));
  ok("執行紀錄印出 11 個 entry", ENTRY_KEYS.every(k => ents[k]), entLine);
  ok("member 的 entry 對得上名字題", ents.member === "entry." + (nameItem.id * 7 + 100000), ents.member);
  ok("token 的 entry 對得上連結代碼題", ents.token === "entry." + (form.byTitle("連結代碼").id * 7 + 100000), ents.token);
  ok("執行紀錄印出 UPDATE_FORM_URL", log.some(l => l.trim() === 'UPDATE_FORM_URL: "' + form.getPublishedUrl() + '",'));

  let msg = "";
  try { env.createMemberUpdateForm(); } catch (e) { msg = String(e.message || e); }
  ok("再跑一次被擋下,並指向 forgetMemberUpdateForm()", msg.includes("forgetMemberUpdateForm()") && env.__st.createCalls === 1, msg);
}
{
  const env = makeUpd();
  env.__st.groups[0].members.push({ name: "王 大銘" });   // 同組同名(去掉空白後相同)
  env.createMemberUpdateForm();
  const form = env.__st.forms.get(env.__props.UPDATE_FORM_EDIT_URL);
  ok("沒有新夥伴表單時,說明改成跟組長索取", form.desc.includes("請跟你的組長索取新夥伴表單"));
  const vals = form.byTitle(NAME_Q).choices.map(c => c.value);
  ok("同組同名只留第一位", vals.filter(v => v.replace(/\s/g, "") === "A1・王大銘").length === 1, vals.join("|"));
}

console.log("⑰ syncMemberUpdateNames:讀不到就不動、一樣就不寫、同名去重、用 item ID 找題目");
{
  const env = makeUpd();
  const form = setupForm(env);
  const item = form.byTitle(NAME_Q);
  const snapshot = () => item.choices.map(c => c.value).join("|");
  const before = snapshot(), w0 = item.choiceWrites;

  env.__props.UPDATE_NAMES_SYNCED_AT = "2026-01-01T00:00:00.000Z";
  env.syncMemberUpdateNames();
  ok("名錄沒變 → 不寫入選項", item.choiceWrites === w0);
  ok("名錄沒變 → 只更新同步時間", Date.parse(env.__props.UPDATE_NAMES_SYNCED_AT) > Date.now() - 60000);
  ok("同步成功時順便寫名錄索引快取(600 秒)", env.__st.cachePuts.some(p => p.k === "mupd:nameidx" && p.ttl === 600));

  for (const [why, tweak, undo] of [
    ["data.js 500", st => { st.dataStatus = 500; }, st => { st.dataStatus = 200; }],
    ["抓 data.js 丟例外", st => { st.dataThrow = true; }, st => { st.dataThrow = false; }],
    ["名錄 0 人", st => { st.saved = st.groups; st.groups = [{ code: "A1", name: "x", members: [] }]; }, st => { st.groups = st.saved; }],
  ]) {
    tweak(env.__st);
    let threw = false;
    try { env.syncMemberUpdateNames(); } catch (e) { threw = true; }
    ok(why + " → 不丟例外、選項不動", !threw && snapshot() === before && item.choiceWrites === w0);
    undo(env.__st);
  }
  ok("同步才失敗幾次(上次成功不到 24 小時)→ 不寄信", env.__st.sent.length === 0);

  env.__st.groups[1].members.push({ name: "林志明" });
  env.syncMemberUpdateNames();
  const vals = item.choices.map(c => c.value);
  ok("新夥伴上架 → 選單更新", vals.includes("B2・林志明") && vals[vals.length - 1] === NF && item.choiceWrites === w0 + 1, vals.join("|"));
  ok("更新後「找不到我的名字」仍然跳出口頁", item.choices[vals.length - 1].page === form.byTitle("找不到自己的名字？"));

  item.setTitle("請選擇你的大名(網管改過)");
  env.__st.groups[1].members.push({ name: "黃小琪" });
  env.syncMemberUpdateNames();
  ok("名字題改了標題 → 仍然用 item ID 找到並更新", item.choices.some(c => c.value === "B2・黃小琪"));

  env.__st.groups[0].members.push({ name: "王 大銘" });
  env.syncMemberUpdateNames();
  env.syncMemberUpdateNames();
  const dupMails = env.__st.sent.filter(m => m.subject.includes("同一組有同名的夥伴"));
  ok("同組同名 → 選單只列一位", item.choices.filter(c => c.value.replace(/\s/g, "") === "A1・王大銘").length === 1);
  ok("同組同名 → ALERT 一天只寄一次", dupMails.length === 1 && dupMails[0].to === "alert@example.com", dupMails.length);
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__props.UPDATE_NAMES_SYNCED_AT = new Date(Date.now() - 25 * HOUR).toISOString();
  env.__st.dataStatus = 500;
  env.syncMemberUpdateNames();
  env.syncMemberUpdateNames();
  const m = env.__st.sent.filter(x => x.subject.includes("超過一天沒更新"));
  ok("超過 24 小時沒同步成功 → ALERT 一天一封", m.length === 1 && m[0].to === "alert@example.com", m.length);
  ok("ALERT 內文寫明手動執行 syncMemberUpdateNames", m[0] && m[0].body.includes("手動執行 syncMemberUpdateNames"));
  ok("記下今天已經警示過", /^\d{4}-\d{2}-\d{2}$/.test(env.__props.UPDATE_SYNC_ALERTED_DAY || ""));
  ok("選項沒被動到", form.byTitle(NAME_Q).choices.length === 6);
}
{
  const env = makeUpd();
  let threw = false;
  try { env.syncMemberUpdateNames(); } catch (e) { threw = true; }
  ok("還沒建表單時同步 → 只記一行,不丟例外", !threw && logText(env).includes("還沒有建立夥伴資料更新表單"));
}

console.log("⑱ 送出:body 的格式、先記後送、紀錄與信件不含內容");
{
  const env = makeUpd();
  const form = setupForm(env);
  const token = "v1.g3_m1." + "0123abcd".repeat(9);
  const ts = new Date("2026-10-02T13:14:41.000Z");
  const { rid, out } = answer(env, form, {
    [NAME_Q]: "A1・曾俊凱", "所屬公司": "雲榮肉品有限公司Q", "服務項目": "第一項Q\n第二項Q", "公司網站": "",
    "給組長的備註": "私人備註ABC", "連結代碼": "  " + token + "  ",
  }, { ts });
  const b = env.__st.posts[0], u = (b && b.update) || {};
  ok("送了 1 次 /member-update", env.__st.posts.length === 1);
  ok("帶 INTAKE_SECRET", b && b.secret === SECRET);
  ok("label / name / group 正確", u.label === "A1・曾俊凱" && u.name === "曾俊凱" && u.group === "A1", JSON.stringify([u.label, u.name, u.group]));
  ok("★ 九欄都在(沒填的是空字串)", JSON.stringify(Object.keys(u.changes || {}).sort()) === JSON.stringify(UPD_FIELDS.slice().sort()) &&
     u.changes.website === "" && u.changes.title === "" && u.changes.want === "", JSON.stringify(u.changes));
  ok("清單欄位保留換行", u.changes && u.changes.services === "第一項Q\n第二項Q");
  ok("備註原文送出", u.note === "私人備註ABC");
  ok("responseId 是回應 ID", u.responseId === rid);
  ok("★ submittedAt 等於 getTimestamp", u.submittedAt === "2026-10-02T13:14:41.000Z", u.submittedAt);
  ok("★ linkToken 是第 15 題的值(去掉前後空白)", u.linkToken === token, u.linkToken);
  ok("沒換組 → pickedLabel 是空字串", u.pickedLabel === "");
  ok("回傳 ok 與 uid", out && out.code === "ok" && /^u_test\d+$/.test(out.uid), JSON.stringify(out));
  ok("成功後不在補送清單", !failedRid(env, rid));
  const m = env.__st.sent[0];
  ok("成功通知寄 NOTIFY_EMAIL", env.__st.sent.length === 1 && m.to === "leaders@example.com");
  ok("成功通知主旨與內文照定稿", m && m.subject === "【會員名錄】有夥伴送來資料更新：A1・曾俊凱" && m.body.includes("目前共 3 筆待審核（最久的已等 2 天）") && m.body.includes(SITE + "admin.html"), m && m.body);
  const leak = ["雲榮肉品有限公司Q", "第一項Q", "私人備註ABC", SECRET, "佔位字內容Q", "不合格網址內容Q", token];
  ok("★ 執行紀錄不含欄位內容、備註、secret、連結代碼", leak.every(x => !logText(env).includes(x)), leak.filter(x => logText(env).includes(x)).join(","));
  ok("★ 通知信不含欄位內容、備註、secret", leak.every(x => !mailText(env).includes(x)));
  ok("執行紀錄有欄位鍵(company、services)", logText(env).includes("company") && logText(env).includes("services"));
  ok("★ 補送清單等屬性都在鎖裡寫入", env.__st.unlockedWrites.length === 0, env.__st.unlockedWrites.join(","));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  // 第一次 POST 時偷看:這時補送清單上必須已經有這筆(code pending)
  let seen = null;
  env.__st.onPost = body => { seen = failedRid(env, body.update.responseId); };
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("★ 呼叫 Worker 時,回應 ID 已經以 pending 記在補送清單", seen && seen.code === "pending", JSON.stringify(seen));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  form.byTitle(NAME_Q).setTitle("請選擇您的大名");
  answer(env, form, { "請選擇您的大名": "A1・王大銘", "所屬公司": "x" });
  ok("名字題改了標題 → 送出時仍用 item ID 認得出名字", env.__st.posts[0] && env.__st.posts[0].update.label === "A1・王大銘");
}

console.log("⑲ 再查一次組別:在別組唯一同名 → 改送新組並帶 pickedLabel");
{
  const env = makeUpd();
  const form = setupForm(env);
  answer(env, form, { [NAME_Q]: "A1・張三", "所屬公司": "x" });
  const u = env.__st.posts[0].update;
  ok("改送到 B2", u.group === "B2" && u.label === "B2・張三", JSON.stringify([u.group, u.label]));
  ok("★ pickedLabel 是本人選的選項", u.pickedLabel === "A1・張三");
  ok("紀錄寫明改送", logText(env).includes("改送到 B2"));

  env.__st.groups[0].members.push({ name: "陳美玲" });   // 兩組都有陳美玲
  env.__st.cache.clear();
  answer(env, form, { [NAME_Q]: "A1・陳美玲", "所屬公司": "x" });
  const u2 = env.__st.posts[1].update;
  ok("全名錄有兩位同名 → 維持選項上的代號", u2.group === "A1" && u2.pickedLabel === "");

  env.__st.cache.clear(); env.__st.dataStatus = 500;
  answer(env, form, { [NAME_Q]: "A1・張三", "所屬公司": "x" });
  const u3 = env.__st.posts[2].update;
  ok("名錄索引讀不到 → 沿用選項上的代號,照樣送出", u3 && u3.group === "A1" && u3.pickedLabel === "");
}

console.log("⑳ 「找不到我的名字」:不送 Worker、彙整信、姓名過濾、屬性大小");
{
  const env = makeUpd();
  const form = setupForm(env);
  for (let i = 0; i < 300; i++) {
    env.__st.cache.forEach((v, k) => { if (k.startsWith("mupd:h:")) env.__st.cache.delete(k); });   // 熔斷另外測(㉔),這裡只看彙整信
    const name = i % 3 === 0 ? "https://evil.example/login?x=" + i
               : i % 3 === 1 ? "<script>alert(" + i + ")</script>"
               : "王" + "長".repeat(4998) + i;
    answer(env, form, { [NAME_Q]: NF, "你的姓名": name, "想更新什麼": "請點 https://phish.example/" + i + " 領獎" });
  }
  const st = env.__st;
  ok("★ 300 筆都沒有呼叫 Worker", st.posts.length === 0 && !st.fetches.some(u => u.startsWith(RELAY)));
  ok("沒有抓 data.js", !st.fetches.some(u => u.includes("data.js")));
  ok("★ 最多寄 1 封", st.sent.length === 1, st.sent.length);
  const m = st.sent[0] || { subject: "", body: "" };
  ok("寄給 NOTIFY_EMAIL", m.to === "leaders@example.com");
  const nameLine = (m.body.split("\n").find(l => l.startsWith("留下的姓名：")) || "").slice("留下的姓名：".length);
  ok("★ 姓名那一行沒有網址、<script>、冒號、斜線、句點", nameLine && !/[:\/.<>]/.test(nameLine) && !nameLine.includes("script>"), nameLine);
  const listed = nameLine.replace(/等$/, "").split("、").filter(Boolean);
  ok("★ 姓名最多 10 位、每位 ≤ 10 字", listed.length <= 10 && listed.every(x => Array.from(x).length <= 10), JSON.stringify(listed));
  ok("★ 信裡沒有「想更新什麼」的內容", !m.body.includes("phish") && !m.body.includes("領獎"));
  ok("★ 信裡沒有填答者寫的網址或標籤", !mailText(env).includes("evil.example") && !mailText(env).includes("<script>"));
  ok("信裡附回應試算表網址", m.body.includes("https://docs.google.com/spreadsheets/d/" + form.dest + "/edit"));
  ok("★ UPDATE_NF_STATE ≤ 9 KB", bytes(env.__props.UPDATE_NF_STATE || "") <= 9 * 1024);
  ok("★ UPDATE_MAIL_DEDUPE ≤ 9 KB", bytes(env.__props.UPDATE_MAIL_DEDUPE || "") <= 9 * 1024);
  ok("300 筆都不在補送清單", failedOf(env).length === 0);
  const nf = JSON.parse(env.__props.UPDATE_NF_STATE);
  ok("第 1 封寄出後,累計 299 人", nf.n === 299 && nf.names.length <= 10, JSON.stringify({ n: nf.n, names: nf.names.length }));

  nf.last -= 6 * HOUR + 60000;
  env.__props.UPDATE_NF_STATE = JSON.stringify(nf);
  env.syncMemberUpdateNames();
  ok("★ 6 小時後每小時同步 → 寄出第 2 封彙整信", st.sent.length === 2, st.sent.length);
  ok("★ 第 2 封的人數正確(299)並加「等」", st.sent[1] && st.sent[1].subject === "【會員名錄】有 299 位夥伴在更新表單找不到自己的名字" &&
     /留下的姓名：[^\n]*等\n/.test(st.sent[1].body), st.sent[1] && st.sent[1].subject);
  ok("寄出後累計歸零", JSON.parse(env.__props.UPDATE_NF_STATE).n === 0);
  env.syncMemberUpdateNames();
  ok("沒有新的累計就不再寄", st.sent.length === 2);
}
{
  const env = makeUpd();
  const form = setupForm(env);
  form.dest = "";
  env.__st.quota = 10;
  answer(env, form, { [NAME_Q]: NF, "你的姓名": "林志明" });
  ok("額度不足 → 彙整信先不寄,累計保留", env.__st.sent.length === 0 && JSON.parse(env.__props.UPDATE_NF_STATE).n === 1);
  env.__st.quota = 99;
  env.syncMemberUpdateNames();
  const m = env.__st.sent[0];
  ok("額度恢復後補寄", m && m.body.includes("留下的姓名：林志明"));
  ok("沒有試算表時改成文字指引,整封信沒有任何網址符號", m && m.body.includes("（請網管打開表單 → 回覆 → 試算表查看）") && !/[:\/]/.test(m.body), m && m.body);
}
{
  const env = makeUpd({ props: { NOTIFY_EMAIL: undefined } });
  const form = setupForm(env);
  env.__st.mailThrow = true;
  answer(env, form, { [NAME_Q]: NF, "你的姓名": "林志明" });
  ok("寄信失敗 → 累計加回去,下次再寄", JSON.parse(env.__props.UPDATE_NF_STATE).n === 1);
  env.__st.mailThrow = false;
  answer(env, form, { [NAME_Q]: NF, "你的姓名": "黃小琪" });
  const m = env.__st.sent[0];
  ok("沒設 NOTIFY_EMAIL → 退回 ALERT_EMAIL,兩人一起寄", m && m.to === "alert@example.com" && m.subject.includes("有 2 位"), m && m.subject);
}

console.log("㉑ 全部空白 → 不送出、不寄信、不留在補送清單");
{
  const env = makeUpd();
  const form = setupForm(env);
  const { rid, out } = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "   ", "給組長的備註": "" });
  ok("沒有呼叫 Worker", env.__st.posts.length === 0);
  ok("沒寄信", env.__st.sent.length === 0);
  ok("不在補送清單", !failedRid(env, rid));
  ok("紀錄寫「什麼都沒填」", logText(env).includes("什麼都沒填") && out.code === "empty");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "給組長的備註": "請刪掉我的公司網站" });
  ok("只有備註 → 照樣送出", env.__st.posts.length === 1);
}

console.log("㉒ Worker 5xx → 等 5 秒重送一次;還是失敗才寄 ALERT 並記進補送清單");
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(502, "server_error");
  const { rid } = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("送了 2 次、sleep 1 次", env.__st.posts.length === 2 && env.__st.sleeps === 1, env.__st.posts.length + "/" + env.__st.sleeps);
  const f = failedRid(env, rid);
  ok("★ 補送清單記下 {rid, code}", f && f.code === "server_error" && f.n === 1 && /^\d{4}-/.test(f.at), JSON.stringify(f));
  const m = env.__st.sent;
  ok("寄 1 封 ALERT(系統類)", m.length === 1 && m[0].to === "alert@example.com" && m[0].subject === "【會員名錄】夥伴資料更新表單出問題了：server_error", m[0] && m[0].subject);
  ok("ALERT 內文有回應 ID 與補送方法", m[0] && m[0].body.includes(rid) && m[0].body.includes("resendFailedMemberUpdates()") && m[0].body.includes("1 小時內只會寄一封"));
  ok("被歸到可自動補送", env.failedList_().auto.some(x => x.rid === rid));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  let n = 0;
  env.__st.worker = (b, st) => (++n === 1 ? [503, "<html>Service Unavailable</html>"] : defaultWorker(b, st));
  const { rid, out } = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("第一次 503、重送成功 → 不寄 ALERT,只寄成功通知", out.code === "ok" && env.__st.sent.length === 1 && env.__st.sent[0].to === "leaders@example.com");
  ok("成功後不在補送清單", !failedRid(env, rid));
  env.__st.worker = () => [503, "<html>Service Unavailable</html>"];
  const r2 = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "y" });
  ok("回的不是 JSON → 記成 http_503", failedRid(env, r2.rid) && failedRid(env, r2.rid).code === "http_503");
}

console.log("㉓ 先記後送:中途丟例外也不會漏記,函式不往外丟");
{
  const env = makeUpd();
  const form = setupForm(env);
  env.publishedNameIndex_ = () => { throw new Error("boom"); };
  let threw = false, r;
  try { r = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" }); } catch (e) { threw = true; }
  ok("publishedNameIndex_ 丟例外 → 不往外丟", !threw);
  const f = r && failedRid(env, r.rid);
  ok("★ 回應 ID 仍在補送清單(script_error)", f && (f.code === "script_error" || f.code === "pending"), JSON.stringify(f));
  ok("寄系統類 ALERT", env.__st.sent.some(m => m.subject.includes("script_error")));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = () => ["throw"];
  let threw = false, r;
  try { r = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" }); } catch (e) { threw = true; }
  ok("UrlFetch 兩次都丟例外 → 不往外丟、有重送", !threw && env.__st.posts.length === 2);
  const f = r && failedRid(env, r.rid);
  ok("★ 回應 ID 仍在補送清單", f && (f.code === "script_error" || f.code === "pending"), JSON.stringify(f));
  ok("紀錄不含 secret", !logText(env).includes(SECRET));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(500, "server_error");
  let second = null, nested = false;
  env.__st.onPost = () => {
    if (nested) return;
    nested = true;
    second = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "y" });   // 第一筆的 UrlFetch 進行中,第二筆觸發
  };
  const first = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  const ids = failedOf(env).map(x => x.rid);
  ok("★ 交錯執行:兩個回應 ID 都在補送清單", ids.includes(first.rid) && second && ids.includes(second.rid), ids.join(","));
  ok("★ 交錯執行時屬性寫入都在鎖裡", env.__st.unlockedWrites.length === 0, env.__st.unlockedWrites.join(","));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  delete env.__props.INTAKE_SECRET;
  const { rid } = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("少 INTAKE_SECRET → 不送、記 config_missing、寄 ALERT", env.__st.posts.length === 0 && failedRid(env, rid).code === "config_missing" &&
     env.__st.sent.some(m => m.to === "alert@example.com" && m.subject.endsWith("config_missing")));
  ok("config_missing 歸到可自動補送", env.failedList_().auto.some(x => x.rid === rid));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  const { rid } = answer(env, form, { [NAME_Q]: "選項被改壞了 https://evil.example", "所屬公司": "x" });
  const f = failedRid(env, rid);
  ok("選項沒有「・」→ bad_label、不送 Worker", f && f.code === "bad_label" && env.__st.posts.length === 0);
  ok("bad_label 歸到需人工處理", env.failedList_().manual.some(x => x.rid === rid));
  const m = env.__st.sent[0];
  ok("bad_label 寄 ALERT,內文教怎麼指定正確姓名補送", m && m.to === "alert@example.com" && m.body.includes('resendMemberUpdate("' + rid + '", "A1・正確姓名")'));
  ok("信裡看不到選項裡的網址", !mailText(env).includes("evil.example"));
}

console.log("㉔ 熔斷:同一小時第 61 筆起暫停收件,不抓 data.js、不呼叫 Worker");
{
  const env = makeUpd();
  const form = setupForm(env);
  const key = "mupd:h:" + env.Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMddHH");
  env.__st.cache.set(key, { v: "60", exp: Date.now() + 7200e3 });
  const a = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("★ 第 61 筆沒有任何 UrlFetch", env.__st.fetches.length === 0, env.__st.fetches.join(","));
  ok("★ 表單停止收件", form.isAcceptingResponses() === false);
  ok("★ 停用訊息已設定", form.f.closedMsg.includes("暫停收件"));
  const alerts = env.__st.sent.filter(m => m.subject.includes("自動暫停收件"));
  ok("★ ALERT 1 封", alerts.length === 1 && alerts[0].to === "alert@example.com");
  ok("ALERT 內文有編輯網址與處理步驟", alerts[0] && alerts[0].body.includes(form.getEditUrl()) && alerts[0].body.includes("dismissFailedMemberUpdate"));
  const f = failedRid(env, a.rid);
  ok("★ 記成 flood_paused,歸到需人工處理", f && f.code === "flood_paused" && env.failedList_().manual.some(x => x.rid === a.rid));
  const b = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "y" });
  ok("★ 第 62 筆不再寄信", env.__st.sent.length === 1 && failedRid(env, b.rid).code === "flood_paused");
  ok("快取期限 7200 秒", env.__st.cachePuts.some(p => p.k === key && p.ttl === 7200));
  const out = env.resendMemberUpdate(a.rid);
  ok("★ resend 不受熔斷影響", out && out.code === "ok" && env.__st.posts.length === 1 && !failedRid(env, a.rid), JSON.stringify(out));
}

console.log("㉕ 名錄索引快取:10 分鐘內第二筆不再抓 data.js");
{
  const env = makeUpd();
  const form = setupForm(env);
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "y" });
  ok("★ 兩筆只抓 1 次 data.js", env.__st.fetches.filter(u => u.includes("data.js")).length === 1);
  ok("索引快取 600 秒", env.__st.cachePuts.some(p => p.k === "mupd:nameidx" && p.ttl === 600));
  const idx = JSON.parse(env.__st.cache.get("mupd:nameidx").v);
  ok("索引只有姓名與代號", JSON.stringify(idx["曾俊凱"]) === '["A1"]' && JSON.stringify(idx["李小華"]) === '["A1"]', JSON.stringify(idx));
}

console.log("㉖ 通知節流:成功 6 小時一封;額度 < 20 只寄系統類;系統類每碼 1 小時一封");
{
  const env = makeUpd();
  const form = setupForm(env);
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "y" });
  ok("★ 兩筆成功只寄 1 封", env.__st.sent.length === 1);
  env.__props.UPDATE_NOTIFY_LAST_AT = String(Number(env.__props.UPDATE_NOTIFY_LAST_AT) - 6 * HOUR - 1000);
  answer(env, form, { [NAME_Q]: "B2・陳美玲", "所屬公司": "z" });
  ok("6 小時後再寄 1 封", env.__st.sent.length === 2 && env.__st.sent[1].subject.includes("B2・陳美玲"));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.quota = 10;
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("★ 額度 < 20 → 略過成功通知", env.__st.sent.length === 0);
  env.__st.worker = workerSays(404, "member_not_found");
  const r = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "x" });
  ok("★ 額度 < 20 → 略過送件類通知(但照樣記進補送清單)", env.__st.sent.length === 0 && failedRid(env, r.rid));
  env.__st.worker = workerSays(500, "server_error");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "y" });
  ok("★ 額度 < 20 → 系統類照寄", env.__st.sent.length === 1 && env.__st.sent[0].to === "alert@example.com");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "z" });
  ok("★ 同一個系統錯誤 1 小時只寄一封", env.__st.sent.length === 1);
  env.__st.worker = workerSays(401, "bad_secret");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "w" });
  ok("不同的錯誤碼另外寄", env.__st.sent.length === 2 && env.__st.sent[1].subject.endsWith("bad_secret"));
  const ded = JSON.parse(env.__props.UPDATE_MAIL_DEDUPE);
  ded["sys:server_error"] -= HOUR + 1000;
  env.__props.UPDATE_MAIL_DEDUPE = JSON.stringify(ded);
  env.__st.worker = workerSays(500, "server_error");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "v" });
  ok("1 小時後同一個錯誤再寄", env.__st.sent.length === 3);
}
{
  const env = makeUpd({ props: { NOTIFY_EMAIL: undefined } });
  const form = setupForm(env);
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  ok("沒設 NOTIFY_EMAIL → 不寄成功通知", env.__st.sent.length === 0);
  env.__st.worker = workerSays(404, "member_not_found");
  answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "x" });
  ok("沒設 NOTIFY_EMAIL → 送件類退回 ALERT_EMAIL", env.__st.sent.length === 1 && env.__st.sent[0].to === "alert@example.com");
}

console.log("㉗ UPDATE_MAIL_DEDUPE:最多 50 個鍵;屬性寫不進去時系統類照寄、送件類略過");
{
  const env = makeUpd();
  for (let i = 0; i < 60; i++) env.mailOnce_("sub:member_not_found:" + "名".repeat(18) + i, 24 * HOUR);
  const keys = Object.keys(JSON.parse(env.__props.UPDATE_MAIL_DEDUPE));
  ok("★ 60 個不同的鍵 → 只留 50 個", keys.length === 50, keys.length);
  ok("丟掉的是最舊的", !keys.includes("sub:member_not_found:" + "名".repeat(18) + "0") && keys.includes("sub:member_not_found:" + "名".repeat(18) + "59"));
  ok("≤ 9 KB", bytes(env.__props.UPDATE_MAIL_DEDUPE) <= 9 * 1024);
  ok("同一個鍵在期限內第二次 → false", env.mailOnce_("sys:x", HOUR) === true && env.mailOnce_("sys:x", HOUR) === false);
  ok("寫入都在鎖裡", env.__st.unlockedWrites.length === 0);
  const stale = JSON.parse(env.__props.UPDATE_MAIL_DEDUPE);
  stale["sys:old"] = Date.now() - 25 * HOUR;
  env.__props.UPDATE_MAIL_DEDUPE = JSON.stringify(stale);
  env.mailOnce_("sys:y", HOUR);
  ok("超過 1 天的鍵在下次寫入時刪掉", !("sys:old" in JSON.parse(env.__props.UPDATE_MAIL_DEDUPE)));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.propFail = k => k === "UPDATE_MAIL_DEDUPE";
  env.__st.worker = workerSays(500, "server_error");
  let threw = false;
  try { answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" }); } catch (e) { threw = true; }
  ok("★ 去重紀錄寫不進去 → 系統類照寄、不往外丟", !threw && env.__st.sent.length === 1 && env.__st.sent[0].to === "alert@example.com");
  env.__st.worker = workerSays(404, "member_not_found");
  try { answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "x" }); } catch (e) { threw = true; }
  ok("★ 去重紀錄寫不進去 → 送件類略過、不往外丟", !threw && env.__st.sent.length === 1);
  ok("兩筆都在補送清單", failedOf(env).length === 2);
}

console.log("㉘ 信裡的姓名一律過濾(safeName_ / safeLabel_)");
{
  const env = makeUpd();
  ok("一般選項原樣", env.safeLabel_("A1・曾俊凱") === "A1・曾俊凱");
  ok("全形代號轉半形、網址的符號被濾掉", env.safeLabel_("Ａ１・https://evil.example/x") === "A1・httpsevilexamplex", env.safeLabel_("Ａ１・https://evil.example/x"));
  ok("切不開 → (選項格式不對)", env.safeLabel_("沒有點點") === "(選項格式不對)");
  ok("代號最多 8 字", env.safeLabel_("ABCDEFGHIJK・王").startsWith("ABCDEFGH・"));
  ok("空的 → (未留可辨識的姓名)", env.safeName_("") === "(未留可辨識的姓名)" && env.safeName_("://..//") === "(未留可辨識的姓名)");
  ok("<script> 只剩文字", env.safeName_("<script>") === "script");
  ok("最多 10 字(預設)", Array.from(env.safeName_("王".repeat(50))).length === 10);
  ok("連續空白縮成一個", env.safeName_("Mary   Jane") === "Mary Jane");
  ok("保留「・」", env.safeName_("約翰・史密斯") === "約翰・史密斯");
  ok("罕用字(UTF-16 代理對)不被切壞", env.safeName_("𠮷".repeat(12)) === "𠮷".repeat(10));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(404, "member_not_found");
  answer(env, form, { [NAME_Q]: "A1・https://evil.example/login", "所屬公司": "x" });
  ok("★ 選項含網址 → 信裡看不到網址", env.__st.sent.length === 1 && !mailText(env).includes("evil.example") && !mailText(env).includes("https://evil"), mailText(env));
}

console.log("㉙ member_not_found:寄 NOTIFY,教怎麼指定名字補送;歸到需人工處理");
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(404, "member_not_found");
  const { rid } = answer(env, form, { [NAME_Q]: "A1・王大明", "所屬公司": "x" });
  const m = env.__st.sent[0];
  ok("寄給 NOTIFY_EMAIL", m && m.to === "leaders@example.com" && m.subject === "【會員名錄】夥伴資料更新沒有送進後台：A1・王大明", m && m.subject);
  ok("★ 內文有回應 ID 和 resendMemberUpdate(\"{rid}\", \"A1・正確姓名\")", m && m.body.includes("回應 ID：" + rid) && m.body.includes('resendMemberUpdate("' + rid + '", "A1・正確姓名")'));
  ok("內文寫明不會自動補送", m && m.body.includes("這一類不會自動補送"));
  ok("內文原因照對照表", m && m.body.includes("原因：名錄上找不到這位（可能剛改名、被刪除，或選錯人）（錯誤碼 member_not_found）"));
  ok("★ 歸到需人工處理", env.failedList_().manual.some(x => x.rid === rid) && !env.failedList_().auto.some(x => x.rid === rid));
  answer(env, form, { [NAME_Q]: "A1・王大明", "所屬公司": "y" });
  ok("同一位同一個錯誤一天只寄一封", env.__st.sent.length === 1);
  env.__st.worker = workerSays(404, "group_not_found");
  const g = answer(env, form, { [NAME_Q]: "A1・王大明", "所屬公司": "z" });
  ok("group_not_found 歸到可自動補送", env.failedList_().auto.some(x => x.rid === g.rid));
  env.__st.worker = workerSays(409, "updates_full");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "z" });
  answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "z" });
  ok("updates_full 不分夥伴,6 小時一封", env.__st.sent.filter(x => x.body.includes("updates_full")).length === 1);
}

console.log("㉚ duplicate / unchanged / nothing_to_update:移出補送清單、不寄成功信");
{
  for (const [why, worker] of [
    ["duplicate", () => [200, { ok: true, duplicate: true, uid: "u_dup0001", memberId: "g3_m1", name: "曾俊凱", code: "A1" }]],
    ["unchanged", () => [200, { ok: true, unchanged: true, memberId: "g3_m1", name: "曾俊凱", code: "A1", ignored: [], untouched: [] }]],
    ["nothing_to_update", () => [400, { ok: false, error: "nothing_to_update", ignored: [{ field: "tagline", value: "同上" }] }]],
  ]) {
    const env = makeUpd();
    const form = setupForm(env);
    env.__props.UPDATE_FAILED_IDS = JSON.stringify([{ rid: "2_OLD", code: "server_error", n: 1, at: "2026-10-01T00:00:00.000Z" }]);
    env.__st.worker = worker;
    const { rid, out } = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
    ok(why + " → 不在補送清單(別筆不受影響)", !failedRid(env, rid) && failedRid(env, "2_OLD"));
    ok(why + " → 不寄任何信", env.__st.sent.length === 0);
    ok(why + " → 回傳 " + why, out && out.code === why, JSON.stringify(out));
  }
}

console.log("㉛ 補送:resendMemberUpdate / resendFailedMemberUpdates / dismissFailedMemberUpdate");
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(404, "member_not_found");
  const { rid } = answer(env, form, { [NAME_Q]: "A1・王大明", "所屬公司": "x" });
  env.__st.worker = null;
  const out = env.resendMemberUpdate(rid, "A1・王大銘");
  const u = env.__st.posts[env.__st.posts.length - 1].update;
  ok("★ 用指定的選項送出", u.label === "A1・王大銘" && u.name === "王大銘" && u.group === "A1" && u.responseId === rid, JSON.stringify([u.label, u.responseId]));
  ok("成功後移出補送清單", out && out.code === "ok" && !failedRid(env, rid));
  ok("印出補送結果", logText(env).includes("補送結果:✅ 已進待審核"));

  const r2 = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "x" }, { noTrigger: true });
  const bad = env.resendMemberUpdate(r2.rid, "王大銘");
  ok("指定的選項格式不對 → bad_label", bad && bad.code === "bad_label" && failedRid(env, r2.rid).code === "bad_label");
  env.__st.logs.length = 0;
  ok("找不到回應 → 印「找不到這筆回應」", env.resendMemberUpdate("2_NOPE") === null && logText(env).includes("找不到這筆回應：2_NOPE"));
}
{
  const env = makeUpd();
  const form = setupForm(env);
  env.__st.worker = workerSays(500, "server_error");
  const a1 = answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  const a2 = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "y" });
  env.__st.worker = workerSays(404, "member_not_found");
  const m1 = answer(env, form, { [NAME_Q]: "A1・王大明", "所屬公司": "z" });
  env.__st.worker = null;
  env.__st.posts.length = 0; env.__st.logs.length = 0;
  env.resendFailedMemberUpdates();
  const sentRids = env.__st.posts.map(p => p.update.responseId);
  ok("★ 只補送 auto", sentRids.includes(a1.rid) && sentRids.includes(a2.rid) && !sentRids.includes(m1.rid), sentRids.join(","));
  ok("★ manual 原封不動", failedOf(env).length === 1 && failedRid(env, m1.rid).code === "member_not_found");
  ok("最後印出統計", logText(env).includes("成功 2 筆、仍失敗 0 筆；需人工處理 1 筆"));
  ok("需人工處理逐筆列出建議做法", env.__st.logs.some(l => l.includes(m1.rid + "・member_not_found・") && l.includes("resendMemberUpdate(")));
  env.__st.logs.length = 0;
  ok("dismiss 移除指定那筆", env.dismissFailedMemberUpdate(m1.rid) === true && failedOf(env).length === 0 && logText(env).includes("已移出補送清單：" + m1.rid + "（member_not_found）"));
  ok("不在清單上 → 印「清單上沒有這筆」", env.dismissFailedMemberUpdate(m1.rid) === false && logText(env).includes("清單上沒有這筆"));
}

console.log("㉜ forgetMemberUpdateForm:清單沒處理完就擋下;force 時先關閉舊表單,只刪自己的東西");
{
  const env = makeUpd({ props: { MEMBER_FORM_EDIT_URL: "https://docs.google.com/forms/d/NEW/edit", VISITOR_FORM_EDIT_URL: "https://docs.google.com/forms/d/VIS/edit" },
                        triggers: ["onNewMemberSubmit", "onVisitorSubmit"] });
  const form = setupForm(env);
  env.__st.worker = workerSays(500, "server_error");
  answer(env, form, { [NAME_Q]: "A1・曾俊凱", "所屬公司": "x" });
  const before = JSON.stringify(env.__props);
  let msg = "";
  try { env.forgetMemberUpdateForm(); } catch (e) { msg = String(e.message || e); }
  ok("★ 補送清單不是空的 → 丟出例外", msg.includes("還有 1 筆送失敗的更新") && msg.includes("forgetMemberUpdateForm(true)"), msg);
  ok("★ 沒有刪任何屬性、表單照常收件", JSON.stringify(env.__props) === before && form.isAcceptingResponses());

  env.__props.UPDATE_NF_STATE = JSON.stringify({ n: 1, last: 0, names: [] });
  env.forgetMemberUpdateForm(true);
  ok("★ 舊表單停止收件", form.isAcceptingResponses() === false);
  ok("★ 停用訊息已設定", form.f.closedMsg.includes("已經停用"));
  const gone = ["UPDATE_FORM_EDIT_URL", "UPDATE_FORM_NAME_ITEM_ID", "UPDATE_FORM_NOTFOUND_PAGE_ID", "UPDATE_NAMES_SYNCED_AT", "UPDATE_FAILED_IDS", "UPDATE_NF_STATE"];
  ok("更新表單的屬性都刪了", gone.every(k => !(k in env.__props)), gone.filter(k => k in env.__props).join(","));
  ok("★ MEMBER_FORM_EDIT_URL、VISITOR_FORM_EDIT_URL、RELAY_URL 不動", env.__props.MEMBER_FORM_EDIT_URL && env.__props.VISITOR_FORM_EDIT_URL && env.__props.RELAY_URL === RELAY);
  const hs = env.__st.triggers.map(t => t.getHandlerFunction()).sort().join(",");
  ok("只刪更新表單的兩種觸發器", hs === "onNewMemberSubmit,onVisitorSubmit", hs);
  ok("提醒舊表單仍在 Drive、site-config 要換", logText(env).includes("仍在 Drive") && logText(env).includes("site-config.js"));
  env.__st.createCalls = 0;
  env.createMemberUpdateForm();
  ok("忘記之後可以重建", env.__st.createCalls === 1);
}
{
  const env = makeUpd();
  setupForm(env);
  env.__st.forms.clear();          // 舊表單打不開(被刪了或沒權限)
  let threw = false;
  try { env.forgetMemberUpdateForm(); } catch (e) { threw = true; }
  ok("舊表單打不開 → 印 ✗ 提醒自己關閉,照樣忘記", !threw && logText(env).includes("✗ 舊表單沒有關閉") && !env.__props.UPDATE_FORM_EDIT_URL);
}
{
  const env = makeUpd({ triggers: ["onMemberUpdateSubmit", "onMemberUpdateSubmit", "syncMemberUpdateNames", "syncMemberUpdateNames", "syncMemberUpdateNames", "onNewMemberSubmit"] });
  setupForm(env);   // 建表單時已經清過一次
  env.setupMemberUpdateTriggers();
  env.setupMemberUpdateTriggers();
  const count = h => env.__st.triggers.filter(t => t.getHandlerFunction() === h).length;
  ok("★ setupMemberUpdateTriggers 不會累積", count("onMemberUpdateSubmit") === 1 && count("syncMemberUpdateNames") === 1 && count("onNewMemberSubmit") === 1);
  ok("紀錄說清掉舊的 2 個", logText(env).includes("清掉舊的 2 個"));
}
{
  const env = makeUpd({ triggers: ["onMemberUpdateSubmit", "onMemberUpdateSubmit", "syncMemberUpdateNames"] });
  env.createMemberUpdateForm();
  ok("建表單時也清掉殘留的舊觸發器(清掉舊的 3 個)", logText(env).includes("清掉舊的 3 個") &&
     env.__st.triggers.filter(t => t.getHandlerFunction() === "onMemberUpdateSubmit").length === 1);
}

console.log("㉝ checkMemberUpdateForm:全部正常 → ✅;各種設定錯誤 → ✗");
function goodCheckEnv() {
  const env = makeUpd();
  const form = setupForm(env);
  const lines = env.memberUpdateConfigLines_(form.getPublishedUrl(), env.memberUpdateEntryIds_(form).ids);
  env.__st.siteConfig = "const SITE = {\n  SITE_BASE: \"" + SITE + "\",\n" + lines.join("\n") + "\n};\n";
  return { env, form };
}
function runCheck(env) {
  env.__st.logs.length = 0;
  const r = env.checkMemberUpdateForm();
  const lineOf = label => env.__st.logs.find(l => l.startsWith(label)) || "";
  return { r, lineOf, text: logText(env) };
}
{
  const { env } = goodCheckEnv();
  const propsBefore = JSON.stringify(env.__props);
  const { r, lineOf, text } = runCheck(env);
  ok("★ 全部設定正確 → 0 項沒過", r.bad === 0 && text.includes("✅ 全部正常,可以把表單網址發到 LINE。"), text);
  ok("名字選單 5 位", lineOf("名字選單").includes("✅ 5 位"));
  ok("Worker 那一行印出讀名錄的網址", lineOf("Worker").includes(SITE));
  ok("連線與密碼 → bad_update 是預期", lineOf("連線與密碼").includes("✅ 回 bad_update"));
  ok("探測請求送的是空白 update", env.__st.posts.some(p => p.secret === SECRET && JSON.stringify(p.update) === "{}"));
  ok("site-config 對得上", lineOf("site-config").includes("✅"));
  ok("只讀不改(屬性完全沒變)", JSON.stringify(env.__props) === propsBefore);
}
const checkCases = [
  ["未發布", "發布狀態", (env, form) => { form.f.published = false; }],
  ["允許編輯回覆", "編輯回覆", (env, form) => { form.f.allowEdits = true; }],
  ["★ 結果摘要公開", "結果摘要", (env, form) => { form.f.summary = true; }],
  ["有上傳題", "登入要求", (env, form) => { form.add(ITEM.FILE_UPLOAD).setTitle("形象照"); }],
  ["收集電子郵件", "登入要求", (env, form) => { form.f.collectEmail = true; }],
  ["★ 限制只能回覆 1 次", "登入要求", (env, form) => { form.f.limitOne = true; }],
  ["停止收件", "接受回應", (env, form) => { form.f.accepting = false; }],
  ["少了每小時同步觸發器", "觸發器", env => { env.__st.triggers = env.__st.triggers.filter(t => t.getHandlerFunction() !== "syncMemberUpdateNames"); }],
  ["送出觸發器重複", "觸發器", env => { env.__st.triggers.push({ getHandlerFunction: () => "onMemberUpdateSubmit" }); }],
  ["caps.memberUpdate 是 false", "Worker", env => { env.__st.ping.caps.memberUpdate = false; }],
  ["memberUpdateSite 和 SITE_BASE_URL 不同", "Worker", env => { env.__st.ping.memberUpdateSite = "https://other.example/"; }],
  ["entry 對不上(token)", "site-config", env => { env.__st.siteConfig = env.__st.siteConfig.replace(/token:"entry\.\d+"/, 'token:"entry.1"'); }],
  ["UPDATE_FORM_URL 對不上", "site-config", env => { env.__st.siteConfig = env.__st.siteConfig.replace(/UPDATE_FORM_URL: "[^"]*"/, 'UPDATE_FORM_URL: "https://docs.google.com/forms/d/e/OLD/viewform"'); }],
  ["還沒貼進 site-config", "site-config", env => { env.__st.siteConfig = "const SITE = { SITE_BASE: \"x\" };"; }],
  ["secret 不一樣", "連線與密碼", env => { env.__props.INTAKE_SECRET = "wrong"; }],
  ["Worker 太舊(not_found)", "連線與密碼", env => { env.__st.worker = workerSays(404, "not_found"); }],
  ["超過 2 小時沒同步", "名字選單", env => { env.__props.UPDATE_NAMES_SYNCED_AT = new Date(Date.now() - 3 * HOUR).toISOString(); }],
  ["名字題 ID 對不上", "名字選單", env => { env.__props.UPDATE_FORM_NAME_ITEM_ID = "99999"; }],
  ["「連結代碼」題被改名", "題目", (env, form) => { form.byTitle("連結代碼").setTitle("代碼"); }],
  ["「你的姓名」不是必填", "題目", (env, form) => { form.byTitle("你的姓名").setRequired(false); }],
  ["出口頁不是「送出」", "題目", (env, form) => { form.byTitle("找不到自己的名字？").setGoToPage(NAV.CONTINUE); }],
  ["沒設 NOTIFY_EMAIL", "通知", env => { delete env.__props.NOTIFY_EMAIL; }],
  ["需要重新授權", "授權狀態", env => { env.__st.needsReauth = true; }],
];
for (const [why, label, tweak] of checkCases) {
  const { env, form } = goodCheckEnv();
  tweak(env, form);
  const { r, lineOf, text } = runCheck(env);
  const ln = lineOf(label);
  ok(why + " → 「" + label + "」印 ✗", /✗|🔴|—/.test(ln) && !ln.includes("✅ ") && r.bad >= 1 && text.includes("⚠ 還有"), ln);
}
{
  // 「登入要求」要分開列原因,網管才知道該關哪一個設定
  const reasons = tweak => {
    const { env, form } = goodCheckEnv();
    tweak(env, form);
    return runCheck(env).lineOf("登入要求");
  };
  const lo = reasons((env, form) => { form.f.limitOne = true; });
  ok("★ 限制只能回覆 1 次 → 文案叫網管關掉它,不誤指上傳題或收集電子郵件",
     lo.includes("關掉「限制只能回覆 1 次」") && !lo.includes("收集電子郵件") && !lo.includes("上傳題"), lo);
  const em = reasons((env, form) => { form.f.collectEmail = true; });
  ok("收集電子郵件 → 文案只叫網管關掉收集電子郵件", em.includes("關掉「收集電子郵件」") && !em.includes("限制只能回覆"), em);
  const all3 = reasons((env, form) => { form.add(ITEM.FILE_UPLOAD).setTitle("形象照"); form.f.collectEmail = true; form.f.limitOne = true; });
  ok("三種同時開著 → 三個原因都列出來", all3.includes("上傳題") && all3.includes("收集電子郵件") && all3.includes("限制只能回覆 1 次"), all3);
  // 讀不到(舊環境沒有這個方法、或讀取丟例外)視同沒開,不能讓正常的表單誤報 ✗
  for (const [why, tweak] of [
    ["沒有 hasLimitOneResponsePerUser", (env, form) => { form.hasLimitOneResponsePerUser = undefined; }],
    ["hasLimitOneResponsePerUser 丟例外", (env, form) => { form.hasLimitOneResponsePerUser = () => { throw new Error("boom"); }; }],
  ]) {
    const { env, form } = goodCheckEnv();
    tweak(env, form);
    const { r, lineOf } = runCheck(env);
    ok(why + " → 視同沒開,「登入要求」仍是 ✅", lineOf("登入要求").includes("✅ 不需要登入") && r.bad === 0, lineOf("登入要求"));
  }
}
{
  const { env } = goodCheckEnv();
  const { lineOf } = runCheck(env);
  ok("沒有問題時「題目」是 ✅", lineOf("題目").includes("✅"));
  env.__props.UPDATE_FAILED_IDS = JSON.stringify([
    { rid: "2_AUTO", code: "server_error", n: 1, at: "2026-10-01T00:00:00.000Z" },
    { rid: "2_MANUAL", code: "member_not_found", n: 2, at: "2026-10-01T00:00:00.000Z" },
  ]);
  env.__props.UPDATE_NF_STATE = JSON.stringify({ n: 4, last: Date.now(), names: ["王"] });
  const c = runCheck(env);
  ok("補送清單與找不到名字只是資訊,不算 ✗", c.r.bad === 0);
  ok("可自動補送 1 筆並提示", c.lineOf("可自動補送").includes("1 筆") && c.lineOf("可自動補送").includes("resendFailedMemberUpdates"));
  ok("★ 需人工處理逐筆列出建議做法", c.lineOf("需人工處理").includes("1 筆") && env.__st.logs.some(l => l.includes("2_MANUAL・member_not_found・") && l.includes('resendMemberUpdate("2_MANUAL", "A1・正確姓名")')));
  ok("找不到名字累積 4 人", c.lineOf("找不到名字").includes("累積 4 人"));
}

console.log("㉞ printMemberUpdateLinkConfig 與 entry 編號");
{
  const env = makeUpd();
  const form = setupForm(env);
  env.printMemberUpdateLinkConfig();
  ok("印出 UPDATE_FORM_URL", env.__st.logs.some(l => l.trim() === 'UPDATE_FORM_URL: "' + form.getPublishedUrl() + '",'));
  ok("11 個都對得上", logText(env).includes("✅ 11 個 entry 都對得上"));
  const ids = env.memberUpdateEntryIds_(form).ids;
  ok("每一題的 entry 都對", ENTRY_KEYS.every(k => ids[k]) && ids.company === "entry." + (form.byTitle("所屬公司").id * 7 + 100000));
  form.byTitle("連結代碼").setTitle("代碼(改過)");
  env.__st.logs.length = 0;
  env.printMemberUpdateLinkConfig();
  ok("對不上的鍵另外列出來", env.__st.logs.some(l => l.includes("對不上") && l.includes("token")));
}

console.log("㉟ 其他:不用 eval、既有函式的文字修正、publishedGroups_ 共用");
{
  ok("★ 原始碼沒有 eval(", !/\beval\s*\(/.test(src));
  ok("★ 原始碼沒有 new Function", !/new\s+Function\b/.test(src));
  const env = makeUpd({ props: { VISITOR_FORM_EDIT_URL: "https://docs.google.com/forms/d/VIS/edit", UPDATE_FORM_EDIT_URL: "https://docs.google.com/forms/d/UPD/edit" } });
  let msg = "";
  try { env.createVisitorForm(); } catch (e) { msg = String(e.message || e); }
  ok("既有的 guard 沒給第 4 個參數時仍指向 forgetForms_()", msg.includes("forgetForms_()") && !msg.includes("forgetMemberUpdateForm"), msg);
  env.forgetForms_();
  ok("forgetForms_ 不碰更新表單的屬性", !("VISITOR_FORM_EDIT_URL" in env.__props) && env.__props.UPDATE_FORM_EDIT_URL === "https://docs.google.com/forms/d/UPD/edit");
  env.__st.logs.length = 0;
  env.checkNotifySetup();
  ok("checkNotifySetup 的 NOTIFY_EMAIL 寫明也管資料更新", env.__st.logs.some(l => l.startsWith("NOTIFY_EMAIL") && l.includes("夥伴資料更新")));
  env.__st.logs.length = 0;
  env.setNotifyEmail("leaders2@example.com");
  ok("setNotifyEmail 的說明是「新申請與資料更新通知」", logText(env).includes("新申請與資料更新通知"));
  env.__st.groups[0].members[0].image = "images/a1/zeng.jpg";
  env.__st.groups[1].members[0].image = "data:image/jpeg;base64,xx";
  const map = env.publishedNamesWithPhoto_();
  ok("publishedNamesWithPhoto_ 改用 publishedGroups_ 後照常運作", map && map["曾俊凱"] === true && !map["陳美玲"]);
  env.__st.dataThrow = true;
  ok("讀不到名錄 → publishedNamesWithPhoto_ 回 null(照片清理整批不刪)", env.publishedNamesWithPhoto_() === null);
}
{
  const env = makeUpd();
  const form = setupForm(env);
  let threw = false;
  try { env.onMemberUpdateSubmit(); env.onMemberUpdateSubmit({}); } catch (e) { threw = true; }
  ok("直接按「執行」→ 只印提示,不丟例外", !threw && logText(env).includes("resendMemberUpdate"));
  ok("沒有呼叫 Worker", env.__st.posts.length === 0 && form);
}

/* ══════════════════════════════════════════════════════════════════════════
   ㊱ 三方介面。上面的案例用的是「照規格寫的假 Worker」—— 兩邊都照規格寫、卻各自理解錯同一個
   細節時,那種測試抓不到。這裡換成真正的 worker/publish-relay.js,後台那一端用真正的
   admin-logic.js 與 site-config.js:
     ・Apps Script 送出的每一個請求(HTTP 方法、欄位名稱),真正的 Worker 都認得;Worker 的回應 Apps Script 也讀得懂
     ・printMemberUpdateLinkConfig 印的兩行貼進 site-config.js 之後,後台組得出連結;夥伴點那條連結、
       只改一格送出,Worker 認得出其他格是「連結帶入、本人沒改」
     ・系統改送到別組時,本人選的選項一路傳到審核畫面的警示
     ・Worker /member-update 會回的錯誤碼,Apps Script 的對照表都有;對照表裡的碼 Worker 也真的會回
   UrlFetchApp 是同步的、Worker 是非同步的,所以分兩段:先讓 Apps Script 跑一次、記下它送出的請求,
   交給 Worker;再讓 Apps Script 用 Worker 真正的回應重跑一次(兩次送出的請求必須一模一樣)。
   ══════════════════════════════════════════════════════════════════════════ */
console.log("㊱ ★ 三方介面:Apps Script ↔ 真正的 Worker ↔ admin-logic.js / site-config.js");
await (async () => {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const W = loadWorker(new URL("../worker/publish-relay.js", import.meta.url), fs);
  const alCtx = vm.createContext({ TextEncoder, URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(new URL("../admin-logic.js", import.meta.url), "utf8"), alCtx, { filename: "admin-logic.js" });
  const AL = alCtx.AdminLogic;

  /* 公開網站上的名錄(Worker 讀 data/*.json)和 Apps Script 讀的 data.js 是同一份 */
  const M = (id, name, extra) => Object.assign({ number: "", name, title: "", services: [], targets: [], have: [], want: [],
    tagline: [], image: "", card: "", products: [], company: "", business_items: "", website: "", id, dataIssue: false,
    updatedAt: "2026-07-28T07:14:10.402Z" }, extra || {});
  const A1 = [
    M("g3_m1", "曾俊凱", { title: "豬肉屠宰批發零售", services: ["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切"],
      targets: ["連鎖滷味店/豬腳店"], tagline: ["國產豬肉專門家", "品質保證攏抵家"] }),
    M("g3_m2", "李 小華", { title: "甲" }),
  ];
  const B2 = [M("g5_m1", "陳美玲", { title: "蔬果" }), M("g5_m2", "張三", { title: "點心" }),
              M("g5_m3", "王大銘", { title: "水產批發", company: "大銘水產" })];      // 剛從 A1 換到 B2
  const IDX = [{ code: "A1", name: "肉品海鮮批發組", id: "g3" }, { code: "B2", name: "蔬果點心供應組", id: "g5" }];
  const gsGroups = () => [{ code: "A1", name: IDX[0].name, members: A1 }, { code: "B2", name: IDX[1].name, members: B2 }];
  const grp = members => JSON.stringify({ leader: "組長", room: "", members, recruiting: [] }, null, 2) + "\n";
  const gh = new FakeGitHub({ "data/_index.json": JSON.stringify(IDX, null, 2) + "\n", "data/a1.json": grp(A1),
                              "data/b2.json": grp(B2), "data/_pending.json": "[]\n" });
  gh.install({});
  const r2 = new FakeR2();
  const wenv = { GH_OWNER: "IvanZhong085", GH_REPO: "member-directory", GH_BRANCH: "main", GH_TOKEN: "t",
                 ALLOWED_ORIGIN: "https://ivanzhong085.github.io", SESSION_SECRET: "x".repeat(48),
                 INTAKE_SECRET: SECRET, RATE_LIMIT: new FakeKV(), PENDING_IMAGES: r2 };
  const reqs = () => r2.keys().filter(k => k.startsWith("updates/req/")).map(k => r2.peekJson(k));

  /* Apps Script 的一個 UrlFetch 原封不動轉成 Worker 的請求(方法、Content-Type、內容都照抄) */
  const toWorker = async (url, o) => {
    const method = String(o.method || "get").toUpperCase();
    const init = { method, headers: o.contentType ? { "Content-Type": o.contentType } : {} };
    if (method !== "GET" && o.payload != null) init.body = String(o.payload);
    const res = await W.__worker.fetch(new Request("https://relay.worker.test" + url.slice(RELAY.length), init), wenv);
    return [res.status, await res.text()];
  };
  const sig = (url, o) => url + " " + String(o.method || "get").toLowerCase() + " " + (o.payload == null ? "" : String(o.payload));
  const viaWorker = async (env, run) => {
    const st = env.__st, sent = [];
    // 第一段:先回中性的假回應,只為了記下請求
    st.relay = (url, o) => { sent.push({ url, o, sig: sig(url, o) }); return url.endsWith("/ping") ? [200, st.ping] : [200, { ok: true, unchanged: true }]; };
    run();
    const replies = [];
    for (const s of sent) replies.push(await toWorker(s.url, s.o));
    // 第二段:照順序回 Worker 真正的回應
    st.logs.length = 0; st.sent.length = 0;
    let i = 0, alike = true;
    st.relay = (url, o) => {
      const s = sent[i], r = replies[i]; i++;
      if (!s || s.sig !== sig(url, o)) { alike = false; return [599, "{}"]; }
      return r;
    };
    const out = run();
    st.relay = null;
    return { out, sent, replies, alike: alike && i === sent.length };
  };
  const postedBody = r => { const s = r.sent.find(x => x.url.endsWith("/member-update")); return s ? JSON.parse(s.o.payload) : null; };

  // ── checkMemberUpdateForm 對真正的 Worker
  {
    const env = makeUpd();
    env.__st.groups = gsGroups();
    setupForm(env);
    const r = await viaWorker(env, () => env.checkMemberUpdateForm());
    const line = k => env.__st.logs.find(l => l.startsWith(k)) || "(沒有這一行)";
    ok("兩次送出的請求一樣", r.alike);
    ok("★ /ping 用 POST(Worker 對其他方法一律回 405)", r.sent.some(s => s.url.endsWith("/ping") && String(s.o.method || "get").toLowerCase() === "post"));
    ok("★ 真正的 Worker:「Worker」那一行是 ✅(caps.memberUpdate、讀名錄的網址 = SITE_BASE_URL)", line("Worker").includes("✅"), line("Worker"));
    ok("★ 真正的 Worker:「連線與密碼」那一行是 ✅(刻意送空白 → bad_update)", line("連線與密碼").includes("✅"), line("連線與密碼"));
  }

  // ── 後台的預填連結 → 夥伴只改一格 → Apps Script → Worker
  {
    const env = makeUpd();
    const st = env.__st;
    st.groups = gsGroups();
    const form = setupForm(env);
    const ids = env.memberUpdateEntryIds_(form).ids;
    const lines = env.memberUpdateConfigLines_(form.getPublishedUrl(), ids);
    const scSrc = fs.readFileSync(new URL("../site-config.js", import.meta.url), "utf8");
    /* 照 README 部署表第 7 步:用印出來的兩行取代 site-config.js 裡原本那兩行。
       (site-config.js 還是舊版、沒有這兩行時,改成貼在 SITE 的最後,只驗證印出來的東西本身) */
    const hasSlots = /^[ \t]*UPDATE_FORM_URL:/m.test(scSrc) && /^[ \t]*UPDATE_FORM_ENTRIES:/m.test(scSrc);
    const pasted = hasSlots
      ? scSrc.replace(/^[ \t]*UPDATE_FORM_URL:.*$/m, lines[0]).replace(/^[ \t]*UPDATE_FORM_ENTRIES:.*$/m, lines[1])
      : scSrc.replace(/\n\};/, "\n" + lines[0] + "\n" + lines[1] + "\n};");
    if (hasSlots) ok("site-config.js 裡找得到要被取代的兩行", pasted.includes(lines[0]) && pasted.includes(lines[1]) && pasted !== scSrc);
    else console.log("  ·  site-config.js 還沒有 UPDATE_FORM_URL / UPDATE_FORM_ENTRIES,改成貼在 SITE 的最後");
    const scCtx = vm.createContext({ module: { exports: null } });
    vm.runInContext(pasted, scCtx, { filename: "site-config.js" });
    const SITECFG = scCtx.module.exports;
    ok("★ printMemberUpdateLinkConfig 印的兩行貼進 site-config.js 之後照樣載得進來", !!SITECFG && SITECFG.UPDATE_FORM_URL === form.getPublishedUrl());
    const E = SITECFG ? SITECFG.UPDATE_FORM_ENTRIES : {};
    ok("★ UPDATE_FORM_ENTRIES 剛好是規格的 11 個鍵,而且都有 entry 編號",
       same(Object.keys(E).sort(), [...ENTRY_KEYS].sort()) && ENTRY_KEYS.every(k => /^entry\.\d+$/.test(E[k])), Object.keys(E).join(","));
    st.siteConfig = pasted;
    const parsed = env.siteConfigUpdateForm_();
    ok("checkMemberUpdateForm 讀網站上的 site-config.js,讀到的就是這 11 個", parsed.url === form.getPublishedUrl() && ENTRY_KEYS.every(k => parsed.entries[k] === ids[k]));

    const pv = AL.memberPrefillValues("A1", A1[0]);
    const link = AL.updatePrefillUrl(SITECFG.UPDATE_FORM_URL, E, pv);
    ok("後台組得出完整的預填連結(沒有退回只帶名字)", !!link && !link.trimmed && !link.nameless);
    // 模擬 Google 表單打開預填連結:每個 entry 對回一題
    const answers = {};
    let unknown = 0;
    for (const [k, v] of new URL(link.url).searchParams) {
      if (k === "usp") continue;
      const m = /^entry\.(\d+)$/.exec(k);
      const it = m ? form.getItemById((Number(m[1]) - 100000) / 7) : null;
      if (!it) { unknown++; continue; }
      answers[it.getTitle()] = v;
    }
    ok("連結上的每一個 entry 都對得到表單上的題目,一格不少", !unknown && Object.keys(answers).length === Object.keys(pv).length,
       Object.keys(answers).join("、"));
    ok("★ 預選的名字是選單上的一個選項(Google 只預選得到一模一樣的字)",
       form.byTitle(NAME_Q).getChoices().some(c => c.getValue() === answers[NAME_Q]), answers[NAME_Q]);
    ok("連結代碼帶進了「連結代碼」那一題", /^v1\.g3_m1\.[0-9a-f]{72}$/.test(answers["連結代碼"] || ""));

    answers["所屬公司"] = "雲榮肉品有限公司";               // 夥伴只補了公司
    const ts = new Date(Date.now() - 60 * 1000);
    const { rid } = answer(env, form, answers, { noTrigger: true, ts });
    const submitOnce = () => env.onMemberUpdateSubmit({ response: form.getResponse(rid), source: form });
    const r = await viaWorker(env, submitOnce);
    const body = postedBody(r);
    ok("兩次送出的請求一樣", r.alike);
    ok("Apps Script 送的 body:update 剛好是規格 §3.5 的 9 個欄位,changes 九欄都在",
       !!body && same(Object.keys(body.update).sort(), ["changes", "group", "label", "linkToken", "name", "note", "pickedLabel", "responseId", "submittedAt"].sort()) &&
       same(Object.keys(body.update.changes).sort(), [...UPD_FIELDS].sort()), body && Object.keys(body.update).join(","));
    ok("★ 真正的 Worker 收下(200 ok),Apps Script 判成功、移出補送清單",
       !!r.out && r.out.code === "ok" && /^u_[a-z0-9]{6,40}$/.test(r.out.uid) && !failedRid(env, rid),
       JSON.stringify(r.out) + " ← " + (r.replies[0] || []).join(" ").slice(0, 200));
    const req = reqs().find(x => x.responseId === rid);
    ok("★ 只有本人改的那一格變成修改", !!req && same(req.changes, { company: "雲榮肉品有限公司" }), req && JSON.stringify(req.changes));
    ok("★ 連結帶入、本人沒改的格子被認出來(舊連結再填一次也不會把後來的修改改回去)",
       !!req && req.tokenUsed === true && ["title", "services", "targets", "tagline"].every(f => req.untouched.includes(f)) &&
       !req.cleared.length && !req.stalePrefill.length, req && JSON.stringify({ untouched: req.untouched, cleared: req.cleared, stale: req.stalePrefill }));
    ok("回應 ID、填寫時間、選項文字照 Apps Script 送的存下來",
       !!req && req.sat === ts.toISOString() && req.label === "A1・曾俊凱" && req.memberId === "g3_m1" && req.pickedLabel === "");

    const again = await viaWorker(env, submitOnce);
    ok("★ 同一筆再送一次 → Worker 回 duplicate,Apps Script 當成處理完畢,沒有多一筆",
       !!again.out && again.out.code === "duplicate" && reqs().length === 1 && !failedRid(env, rid), JSON.stringify(again.out));
  }

  // ── 系統改送到別組:本人選的選項一路傳到審核畫面
  {
    const env = makeUpd();
    env.__st.groups = gsGroups();
    const form = setupForm(env);
    // 選單還沒同步,本人選的是舊的「A1・王大銘」
    const { rid } = answer(env, form, { [NAME_Q]: "A1・王大銘", "所屬公司": "大銘水產股份有限公司" }, { noTrigger: true });
    const r = await viaWorker(env, () => env.onMemberUpdateSubmit({ response: form.getResponse(rid), source: form }));
    const body = postedBody(r);
    ok("Apps Script 改送到 B2,帶 pickedLabel", !!body && body.update.group === "B2" && body.update.pickedLabel === "A1・王大銘",
       body && JSON.stringify({ group: body.update.group, picked: body.update.pickedLabel }));
    const req = reqs().find(x => x.responseId === rid);
    ok("★ Worker 找到 B2 的王大銘,也存下本人選的選項", !!req && req.code === "B2" && req.memberId === "g5_m3" && req.pickedLabel === "A1・王大銘",
       req && JSON.stringify({ code: req.code, picked: req.pickedLabel }));
    const head = req ? AL.memberUpdateHeader(req, B2[2], "B2", Date.now()) : { allSkip: false, warnings: [] };
    ok("★ 審核畫面整筆預設不勾,警示寫出本人選的與系統改送的", head.allSkip && head.warnings.some(w => w.includes("A1・王大銘") && w.includes("B2・王大銘")),
       JSON.stringify(head.warnings));

    // 網管照通知信補送,選項多打了空白
    const r2nd = answer(env, form, { [NAME_Q]: "A1・王大銘", "我有…": "冷凍水產通路" }, { noTrigger: true });
    await viaWorker(env, () => env.resendMemberUpdate(r2nd.rid, "A1 ・ 王大銘"));
    const req2 = reqs().find(x => x.responseId === r2nd.rid);
    ok("★ 補送時選項多了空白:pickedLabel 仍是 Worker 認得的「A1・王大銘」,審核畫面照樣有警示",
       !!req2 && req2.pickedLabel === "A1・王大銘" && AL.memberUpdateHeader(req2, B2[2], "B2", Date.now()).allSkip,
       req2 && JSON.stringify(req2.pickedLabel));
  }

  // ── 錯誤碼對照:Worker 會回的,Apps Script 都認得;Apps Script 對照表裡的,Worker 也真的會回
  {
    const env = makeUpd();
    const wsrc = fs.readFileSync(new URL("../worker/publish-relay.js", import.meta.url), "utf8");
    const fnBody = name => { const m = new RegExp("\\nasync function " + name + "\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}").exec(wsrc); return m ? m[1] : ""; };
    const codesIn = s => [...s.matchAll(/error:\s*"([a-z_]+)"/g)].map(m => m[1]);
    const body = fnBody("handleMemberUpdate");
    // 收件裡的錯誤碼,加上讀公開網站的兩支 helper 與路由(沒有這支端點 → not_found,例外 → server_error)
    const worker = new Set([...codesIn(body), ...codesIn(fnBody("readSiteJson")), ...codesIn(fnBody("readIndexMapSite")), "not_found", "server_error"]);
    const table = new Set(Object.keys(env.UPDATE_ERRORS_ || {}));
    const done = new Set(["nothing_to_update"]);   // Apps Script 當成「處理完了」
    const never = new Set(["bad_request"]);         // Apps Script 一律送合法 JSON,遇不到
    const gsOnly = new Set(["config_missing", "script_error", "bad_label", "flood_paused"]);   // Apps Script 自己產生的
    ok("抓得到收件端點的原始碼", body.length > 1000 && worker.has("bad_update") && worker.has("site_unreachable"), [...worker].join(","));
    const missing = [...worker].filter(c => !table.has(c) && !done.has(c) && !never.has(c));
    ok("★ Worker /member-update 會回的錯誤碼,Apps Script 的對照表都有", !missing.length, missing.join("、"));
    const stray = [...table].filter(c => !worker.has(c) && !gsOnly.has(c));
    ok("★ Apps Script 對照表裡的錯誤碼,Worker 都真的會回(沒有拼錯的)", !stray.length, stray.join("、"));
  }
})();

console.log(`\n${pass} 項通過、${fail} 項失敗`);
if (fail) process.exitCode = 1;
