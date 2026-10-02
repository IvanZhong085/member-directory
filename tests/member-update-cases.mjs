/* 夥伴資料更新:canon 與雜湊的共用測資(規格 §3.3、§6.5)。

   為什麼要有這份:連結代碼是後台(admin-logic.js)算、Worker(worker/publish-relay.js)驗。
   兩邊各有一份 canonUpdateValue / updateValueHash,只要有一個字元的處理不同 ——
   一邊去控制字元、一邊沒有;一邊截到 400 字、一邊沒截;一邊用 UTF-16、一邊用 UTF-8 ——
   每一格都會被當成「本人改過」,夥伴從 LINE 點舊連結再填一次,就會把後來的更新改回去,
   而且沒有任何錯誤訊息。tests/logic.test.mjs 與 tests/member-update.test.mjs 都跑這一份。

   ★ 預期的 canon 是照規格**手寫**的;預期的 hash 是用另一套實作(Python,以預期的 canon
     做 JSON 序列化再算 FNV-1a)算出來貼上的,不是拿被測函式自己的輸出。
     測試另外用下面的 fnv1a32Ref(BigInt 版,跟被測函式的 Math.imul 寫法不同)再驗一次,
     而 fnv1a32Ref 本身先用 FNV 官方公布的測試向量驗過。三套實作互相對得上才算數。

   要新增案例:照規格手寫 canon;hash 用 fnv1a32Ref(JSON.stringify(canon)) 或其他獨立實作
   算出來再貼上,**不要**直接貼被測函式的輸出(那樣只是在測它跟自己一樣)。 */

/* FNV-1a 32 位元的參考實作:BigInt 乘法、Buffer 取 UTF-8 位元組。
   刻意和 admin-logic.js / Worker 的寫法(Math.imul、TextEncoder)不同,才有交叉驗證的意義。 */
export function fnv1a32Ref(text) {
  let h = 0x811c9dc5n;
  for (const b of Buffer.from(String(text), "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x01000193n) % 0x100000000n;
  }
  return h.toString(16).padStart(8, "0");
}

/* FNV 官方公布的 FNV-1a 32 位元測試向量(用來證明上面的參考實作本身是對的) */
export const FNV_VECTORS = [
  { text: "", hex: "811c9dc5" },
  { text: "a", hex: "e40c292c" },
  { text: "foobar", hex: "bf9cf968" },
];

/* 空白格的雜湊固定值 */
export const HASH_EMPTY = "00000000";

/* canon 與 hash 的案例。
   field 決定是清單還是文字:services / targets / have / want / tagline 是清單,其他是文字。
   rawFnv 只出現在「FNV-1a 剛好算出 0」的兩筆:那兩筆的 hash 依規格改成 "00000001"。 */
export const VALUE_CASES = [
  /* ── 空值:一律是 "00000000" ── */
  { name: "空字串(文字)", field: "company", input: "", canon: "", hash: "00000000" },
  { name: "null(文字)", field: "company", input: null, canon: "", hash: "00000000" },
  { name: "undefined(文字)", field: "title", input: undefined, canon: "", hash: "00000000" },
  { name: "只有空白、控制字元與全形空白(文字)", field: "business_items", input: " \u0000\t\r\n\u3000\u007f ", canon: "", hash: "00000000" },
  { name: "空陣列(清單)", field: "services", input: [], canon: [], hash: "00000000" },
  { name: "空字串(清單)", field: "services", input: "", canon: [], hash: "00000000" },
  { name: "null(清單)", field: "targets", input: null, canon: [], hash: "00000000" },
  { name: "只有空行(清單)", field: "have", input: "\n\r\n  \n\t\n", canon: [], hash: "00000000" },
  { name: "陣列裡只有空白項目(清單)", field: "want", input: ["", "  ", "\u0000"], canon: [], hash: "00000000" },

  /* ── 文字欄位 ── */
  { name: "前後空白(文字)", field: "company", input: "  雲榮肉品有限公司  ",
    canon: "雲榮肉品有限公司", hash: "476ca004" },
  { name: "控制字元被去掉(文字)", field: "company", input: "\u0000雲榮\u0007肉品\u001b有限\u007f公司\u000b\u000c",
    canon: "雲榮肉品有限公司", hash: "476ca004" },
  { name: "段落中間的 \\r\\n 與 tab 保留、前後的被 trim(文字)", field: "business_items",
    input: "\r\n冷凍肉品批發\r\n肉品加工\t零售\n", canon: "冷凍肉品批發\r\n肉品加工\t零售", hash: "bf852fc9" },
  { name: "全形空白與 BOM 也會被 trim(文字)", field: "title", input: "\uFEFF\u3000國產羊肉批發\u3000",
    canon: "國產羊肉批發", hash: "59439ae0" },
  { name: "全形英數字不轉半形(canon 不做 NFKC)", field: "company", input: "ＡＢＣ食品（股）公司",
    canon: "ＡＢＣ食品（股）公司", hash: "ca56eb54" },
  { name: "emoji(文字)", field: "title", input: " 🐷 國產豬肉專門家 💪 ",
    canon: "🐷 國產豬肉專門家 💪", hash: "8d9afe6e" },
  { name: "雙引號與反斜線(JSON 跳脫)", field: "company", input: "雲榮\"肉品\"\\分店",
    canon: "雲榮\"肉品\"\\分店", hash: "7b4b0674" },
  { name: "網址前後空白", field: "website", input: " https://www.example.com.tw/產品?id=1&a=b ",
    canon: "https://www.example.com.tw/產品?id=1&a=b", hash: "b564ddae" },
  { name: "數字轉成字串(文字)", field: "title", input: 123, canon: "123", hash: "ac58341b" },
  { name: "超過 400 字不截斷(文字)", field: "business_items", input: "營".repeat(600),
    canon: "營".repeat(600), hash: "8f7ff81d" },

  /* ── 清單欄位 ── */
  { name: "\\r\\n 分行(清單)", field: "services", input: "冷藏/凍豬肉原料批發\r\n豬肉絲/丁/片/塊精切\r\n",
    canon: ["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切"], hash: "e2047e26" },
  { name: "空行與每項前後空白(清單)", field: "targets", input: "\n  連鎖滷味店/豬腳店  \n\n\n小家庭豬肉箱\n\n",
    canon: ["連鎖滷味店/豬腳店", "小家庭豬肉箱"], hash: "6f94509c" },
  { name: "陣列項目各自 trim、去控制字元、去空項(清單)", field: "services",
    input: [" 冷藏/凍豬肉原料批發 ", "", "豬肉絲/丁/片/塊精切\u0000", "  "],
    canon: ["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切"], hash: "e2047e26" },
  { name: "陣列項目裡的換行不再切開(只有字串才依換行切)", field: "tagline",
    input: ["國產豬肉專門家\n品質保證攏抵家"], canon: ["國產豬肉專門家\n品質保證攏抵家"], hash: "1560ca06" },
  { name: "陣列裡的非字串項目(清單)", field: "have", input: [1, null, "肉品", undefined],
    canon: ["1", "肉品"], hash: "b3c77834" },
  { name: "超過 12 項不截斷(清單)", field: "services",
    input: Array.from({ length: 15 }, (_, i) => "項目" + String(i + 1).padStart(2, "0")).join("\n"),
    canon: Array.from({ length: 15 }, (_, i) => "項目" + String(i + 1).padStart(2, "0")), hash: "c5f31293" },
  { name: "單項超過 400 字不截斷(清單)", field: "want", input: ["長".repeat(450), "短"],
    canon: ["長".repeat(450), "短"], hash: "3d3e9d22" },
  { name: "emoji、ZWJ 組合與國旗(清單)", field: "tagline", input: "👨\u200D👩\u200D👧 全家都愛吃\n🇹🇼 台灣豬",
    canon: ["👨\u200D👩\u200D👧 全家都愛吃", "🇹🇼 台灣豬"], hash: "a27018ff" },
  { name: "全形標點(清單)", field: "have", input: "我有國產羊肉爐資源，歡迎洽詢！\n（限中南部）",
    canon: ["我有國產羊肉爐資源，歡迎洽詢！", "（限中南部）"], hash: "a25f4902" },

  /* ── FNV-1a 剛好算出 0:依規格改成 "00000001"(8 個 0 留給「空白格」)──
     這兩個值是用 meet-in-the-middle 反推出來的:FNV-1a 的乘數是奇數,每一步都可逆,
     所以從「最後是 0」往回推 3 個字元、從開頭往前推 3 個字元,兩邊對上就是答案。 */
  { name: "FNV-1a 剛好是 0 的文字 → 00000001", field: "company", input: "fnv0-pxNbKU",
    canon: "fnv0-pxNbKU", rawFnv: "00000000", hash: "00000001" },
  { name: "FNV-1a 剛好是 0 的清單 → 00000001", field: "services", input: "fnv0-g3eb98",
    canon: ["fnv0-g3eb98"], rawFnv: "00000000", hash: "00000001" },
];

/* sameUpdateValue 的案例 */
export const SAME_CASES = [
  { name: "陣列 vs 換行字串", field: "services", a: ["a", "b"], b: "a\nb", same: true },
  { name: "\\r\\n、前後空白、空項都不算差異", field: "services", a: "a\r\nb\r\n", b: [" a ", "b", ""], same: true },
  { name: "順序不同算改過", field: "services", a: ["a", "b"], b: ["b", "a"], same: false },
  { name: "清單:空字串 vs 空陣列", field: "targets", a: "", b: [], same: true },
  { name: "清單:null vs 空陣列", field: "targets", a: null, b: [], same: true },
  { name: "文字:前後空白不算差異", field: "company", a: " 雲榮 ", b: "雲榮", same: true },
  { name: "文字:內容不同", field: "company", a: "雲榮", b: "雲榮肉品", same: false },
  { name: "文字:中間的換行和空白不同", field: "business_items", a: "a\nb", b: "a b", same: false },
  { name: "文字:空字串 vs null", field: "company", a: "", b: null, same: true },
  { name: "全形 vs 半形算不同(不做 NFKC)", field: "title", a: "ＡＢＣ", b: "ABC", same: false },
  { name: "★ 14 項只改第 14 項 → 不一樣(比對不截斷)", field: "services",
    a: Array.from({ length: 14 }, (_, i) => "項" + i),
    b: Array.from({ length: 14 }, (_, i) => (i === 13 ? "改過的第14項" : "項" + i)), same: false },
];

/* 連結代碼:"v1." + 成員 id + "." + 依 company,business_items,website,have,want,title,services,targets,tagline
   串起 9 段雜湊。預期值同樣是另一套實作算的。 */
export const TOKEN_CASES = [
  {
    name: "data/a1.json 曾俊凱(公司、營業項目、網站、我有、我要都是空的)",
    member: {
      id: "g3_m1", name: "曾俊凱", title: "豬肉屠宰批發零售",
      services: ["冷藏/凍豬肉原料批發", "豬肉絲/丁/片/塊精切"],
      targets: ["連鎖滷味店/豬腳店", "小家庭豬肉箱"],
      have: [], want: [], tagline: ["國產豬肉專門家", "品質保證攏抵家"],
      company: "", business_items: "", website: "",
    },
    token: "v1.g3_m1.000000000000000000000000000000000000000003e70d07e2047e266f94509c151b017c",
  },
];
