/* 發布後重整就看得到。

   問題:GitHub Pages 對每個檔案都回 `cache-control: max-age=600`,index.html 也不例外。
   而 data.js 的版本戳就寫在 index.html 裡面。所以發布後 10 分鐘內,已經開過名錄的
   瀏覽器會拿到快取的 index.html → 舊的戳記 → 舊的 data.js,看起來就像「改了沒生效」。
   版本戳擋得住「data.js 網址沒變就永遠拿舊的」,但擋不住裝著戳記的那份 index.html
   自己被快取 —— 這是雞生蛋的問題,只靠 index.html 裡的東西解不開。

   做法:載入後跟伺服器問一次真正的版本(no-store,不吃瀏覽器快取),對不上就換一個
   網址重新載入。換網址是關鍵 —— 同一個網址 reload 仍然會命中那份快取的 index.html,
   換成 ?v=<新版本> 才是瀏覽器沒看過的網址,一定會走網路。

   打轉的防線有兩道,因為只有第一道擋不住所有情況:
   ① 同一個版本只重載一次 —— 版本檔與頁面談不攏(部署壞掉)時就停在這裡。
   ② 整個分頁最多重載兩次 —— 萬一版本檔每次回的值都不一樣,第一道會每次都放行,
      那就變成無限重載、而且是打在伺服器上。寧可讓人看到舊資料,也不要這樣。
   抓不到版本檔就當作沒事發生:離線、或這個檔還沒被 Action 產生出來,都不該影響看名錄。 */
(function () {
  var tag = document.querySelector('script[src^="data.js"]');
  var mine = tag ? (tag.getAttribute("src").split("v=")[1] || "") : "";
  if (!mine) return;   // 還沒蓋過版本戳(例如本機直接開檔),沒有可比的基準

  fetch("data-version.txt?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (text) {
      var latest = String(text || "").trim();
      if (!latest) return;
      if (!/^[A-Za-z0-9]{1,32}$/.test(latest)) return;   // 版本檔內容不對勁就不要拿去組網址
      if (latest === mine) {
        /* 版本對上了 → 把重載次數歸零。②那個上限是用來擋「版本檔每次回不同值」的
           無限打轉,不是要一個分頁一輩子只更新兩次 —— 不歸零的話,長時間開著的
           分頁經過兩次發布之後就再也不會自動更新了。 */
        try { sessionStorage.removeItem("dv:n"); } catch (e) {}
        return;
      }
      var key = "dv:" + latest;
      try {
        if (sessionStorage.getItem(key)) return;              // ① 這個版本試過了
        var n = Number(sessionStorage.getItem("dv:n") || 0);
        if (n >= 2) return;                                   // ② 這個分頁已經重載夠多次了
        sessionStorage.setItem(key, "1");
        sessionStorage.setItem("dv:n", String(n + 1));
      } catch (e) { return; }   // 沒有 sessionStorage 就不重載,寧可慢一點也不要無限打轉
      /* 只換掉 v,其餘查詢參數原樣保留。spotlight.html?m=<成員id> 是靠參數決定
         顯示誰的,整個 query 換掉會變成顯示第一位 —— 分享出去的連結就開錯人了。 */
      var u = new URL(location.href);
      u.searchParams.set("v", latest);
      location.replace(u.href);
    })
    .catch(function () {});
})();
