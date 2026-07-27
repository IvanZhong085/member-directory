/* 站台共用設定 — 分會名稱與正式網址的單一來源。
   分會名稱原本散落在 index/groups/visitor/admin/spotlight 與 sharecard.js 各自寫死,
   改一次要追七個地方且容易漏——一律改讀這一份。
   瀏覽器由各 html 以 <script> 載入(全域 SITE),Node 工具直接 import。 */
const SITE = {
  ORG_NAME:  "雲榮鑽石分會",                                        // 分會名稱(所有頁面的品牌字樣)
  BRAND_SUB: "MEMBER DIRECTORY",                                    // 品牌英文副標(標示頁面性質,非分會名)
  SITE_BASE: "https://ivanzhong085.github.io/member-directory/",    // 發布後的正式網址(QR、og、vCard 都以此為準)
};
if (typeof module !== "undefined") module.exports = SITE;
