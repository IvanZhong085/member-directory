/* 名冊 CSV 的共用定義:欄位順序、「成員 → 一列」對應、跳脫規則。
   後台 admin.js(匯出 CSV)與 tools/build-roster.mjs(roster.csv 鏡像)共用,
   改欄位只改這一份。瀏覽器由 admin.html 以 <script> 載入,Node 直接 import。 */
const CSV_SCHEMA = {
  HEADERS: ["編號","姓名","行業職稱","分組代號","分組名稱","服務項目","適合引薦對象","宣傳標語","所屬公司","主要營業項目","公司網站","照片","名片","商品照片數","資料需確認","刪除"],
  memberRow(g, m){
    return [
      m.number || "", m.name || "", m.title || "", g.code || "", g.name || "",
      (m.services || []).join("|"), (m.targets || []).join("|"), (m.tagline || []).join("|"),
      m.company || "", m.business_items || "", m.website || "",
      /^data:/.test(m.image || "") ? "(內嵌照片)" : (m.image || ""),
      /^data:/.test(m.card || "") ? "(內嵌名片)" : (m.card || ""),
      String((m.products || []).length),
      m.dataIssue ? "是" : "", "",
    ];
  },
  escape(v){
    v = String(v == null ? "" : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  },
};
if (typeof module !== "undefined") module.exports = CSV_SCHEMA;
