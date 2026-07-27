/* 站台共用設定 — 分會名稱與正式網址的單一來源。
   分會名稱原本散落在 index/groups/visitor/admin/spotlight 與 sharecard.js 各自寫死,
   改一次要追七個地方且容易漏——一律改讀這一份。
   瀏覽器由各 html 以 <script> 載入(全域 SITE),Node 工具直接 import。 */
const SITE = {
  ORG_NAME:  "雲榮鑽石分會",                                        // 分會名稱(所有頁面的品牌字樣)
  BRAND_SUB: "MEMBER DIRECTORY",                                    // 品牌英文副標(標示頁面性質,非分會名)
  SITE_BASE: "https://ivanzhong085.github.io/member-directory/",    // 發布後的正式網址(QR、og、vCard 都以此為準)

  /* ── 兩個外部連結(Google 表單/試算表)──────────────────────────────
     都由 tools/google-form.gs 的對應函式建立,執行後把「執行紀錄」印出的網址貼到這裡。
     ⚠ 留空不會壞掉:相關按鈕會自動隱藏或改走替代文案,填上去才出現。 */
  VISITOR_FORM_URL: "https://docs.google.com/forms/d/e/1FAIpQLSeiNaJ_FywZtFL52-2fERiaWstx-iJlp8a8R4f5NR7T9qnppw/viewform",
                            // 來賓參訪報名表單(createVisitorForm)→ visitor.html 的「我要報名參訪」按鈕
  ROSTER_SHEET_URL: "",     // 名冊鏡像試算表(createRosterSheet)→ 後台工具列「名冊試算表」捷徑
};
if (typeof module !== "undefined") module.exports = SITE;
