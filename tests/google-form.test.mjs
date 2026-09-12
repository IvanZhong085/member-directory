/* Apps Script 沒辦法在本機跑,但 tools/google-form.gs 是純 JS:
   把它丟進 vm 沙箱、用假的 MailApp / PropertiesService / ScriptApp 頂替 Google 的服務,
   就能驗證「來賓報名 → 寄信到分會信箱」這條路的行為。
   跑法:node tests/google-form.test.mjs */
import fs from "node:fs";
import vm from "node:vm";

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

console.log(`\n${pass} 項通過、${fail} 項失敗`);
if (fail) process.exitCode = 1;
