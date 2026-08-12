/* 從 admin.js 抽出來的純邏輯：沒有 DOM、沒有網路、沒有全域狀態。

   抽出來的唯一理由是**可測試**。這幾段是併發正確性的關鍵，而它們原本埋在一個
   一千多行的 IIFE 裡，任何自動測試都碰不到。上一輪外部審查找到的兩個 P0 之中，
   前端那一個（認領前檢查 dirty 而不是 hasUnpublishedChanges）就不是被測試抓到的，
   是被人逐行讀出來的 —— 同一類錯誤還會再發生。

   改動這裡請一併更新 tests/logic.test.mjs。 */
var AdminLogic = (function(){
  "use strict";

  /* 三方比較：草稿當初的來源版本（draftBase）vs 剛從權威來源讀到的現況（liveHashes）。
     回傳「有衝突」的路徑清單。

     draftBase 為 null 代表舊格式草稿（那時還沒有存版本資訊）——整份都算衝突。
     不是因為它一定壞掉，而是因為**無法安全比對的東西不該被當成可以直接覆蓋**：
     原本這種草稿會變成「舊內容配新雜湊」，版本檢查會通過，於是靜默蓋掉別人的修改。 */
  function computeConflicts(draftBase, liveHashes){
    const paths = Object.keys(liveHashes || {});
    if(!draftBase) return paths.slice();
    const out = [];
    for(const p of paths){
      const b = draftBase[p];
      if(typeof b === "string" && b && b !== liveHashes[p]) out.push(p);
    }
    return out;
  }

  /* 改名時要一併刪掉的舊路徑。

     分組代號改了，檔案路徑就跟著變。新檔會被送出，但舊檔不會自己消失 —— 它會變成
     沒有人會讀的孤兒（build-data.mjs 只讀 _index 列出的檔），而持有舊分頁的組長還能
     繼續寫進去：兩邊都顯示成功，資料卻永遠不會出現在網站上。

     「改回原名」不會產生刪除（orig === now）。同一個舊路徑只會出現一次。 */
  function computeRenameRemovals(groups, originalPathByGroupId, dataPathOf){
    const out = [];
    for(const g of (groups || [])){
      const orig = originalPathByGroupId ? originalPathByGroupId[g.id] : null;
      const now = dataPathOf(g.code);
      if(orig && orig !== now && out.indexOf(orig) < 0) out.push(orig);
    }
    return out;
  }

  /* 誰是 primary 分頁：id 字典序最小的那一個。

     每個分頁各自算，結論必然一致，所以不需要協商 —— 也就不會出現「兩邊都把自己
     標成 secondary」而全都不存草稿的情況（那是用「先到先得」時的真實風險）。
     原分頁關閉後它的心跳停止、從 peers 裡被清掉，剩下的分頁自然接手。 */
  function isPrimaryTab(selfId, peerIds){
    for(const id of (peerIds || [])) if(id < selfId) return false;
    return true;
  }

  /* 待認領區要不要提醒、提醒什麼。回傳 { level, text } 或 null(不提醒)。

     為什麼需要:申請進了待認領區之後不會有任何人被通知,就這樣躺著等某位組長剛好
     打開後台。新夥伴那頭只會覺得「送出之後就沒下文」。在人一定會看到的位置(待認領
     區本身)放一則會隨筆數升級的提醒,是不動用信件也做得到的最低限度。

     三個級距不是隨手挑的:
       ≥2   有人在等 —— 一筆時清單本身就看得見,兩筆開始才需要催。
       ≥80% 快滿了 —— 滿了之後 /intake 會回 pending_full,新夥伴的申請**會被退回**,
            所以要在還來得及的時候講。
       =max 已經滿了 —— 這時候申請已經在掉了,措辭必須是「現在就處理」。
     max 由呼叫端傳入(對齊 Worker 的 MAX_PENDING),不在這裡寫死第二份。 */
  function pendingNotice(count, max){
    const n = Number(count) || 0;
    const cap = Number(max) > 0 ? Number(max) : 30;
    if(n >= cap){
      return { level:"danger",
               text:"待認領區已滿（" + n + "/" + cap + "）：新夥伴現在送出的申請會被退回，請立即認領或刪除幾筆。" };
    }
    if(n >= Math.ceil(cap * 0.8)){
      return { level:"warn",
               text:"待認領區快滿了（" + n + "/" + cap + "）：滿了之後新夥伴的申請會被退回，請組長盡速認領。" };
    }
    if(n >= 2){
      return { level:"info",
               text:"目前有 " + n + " 位新夥伴等待認領，請組長盡速認領組員。" };
    }
    return null;
  }

  return { computeConflicts, computeRenameRemovals, isPrimaryTab, pendingNotice };
})();
if(typeof module !== "undefined" && module.exports) module.exports = AdminLogic;
