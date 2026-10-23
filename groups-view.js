/* 產業圖只挑選所需欄位；title 是專業別，不能當作公司職位。 */
(function(root){
  "use strict";
  function esc(value){
    return String(value || "").replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function publicProfile(member){
    // Read master fields directly so a chart cannot override a later admin edit with an old sidecar.
    return {
      company: member.company || "",
      position: member.companyPosition || ""
    };
  }
  function groupColor(code){
    var ch = String(code || "").trim().charAt(0).toUpperCase();
    if(ch === "A" || ch === "B") return "var(--c-blue)";
    if(ch === "C" || ch === "D") return "var(--c-yellow)";
    if(ch === "E" || ch === "F") return "var(--c-green)";
    return "var(--c-peach)";
  }
  function renderGroups(groups, mode){
    var single = mode === "public-single", external = mode === "public" || single, html = "";
    groups.forEach(function(g){
      html += '<section class="g"><div class="g-h" style="--gc:' + groupColor(g.code) + '">' +
        esc(g.code) + "/" + esc(g.name) + "(" + g.members.length + ')</div><ul class="g-list">';
      g.members.forEach(function(m){
        if(external){
          var p = publicProfile(m);
          if(single){
            html += '<li><span class="n">' + esc(m.name) + '</span><span class="details"><span class="company">' +
              esc(p.company || "公司待補") + '</span>' + (p.position ? '<span class="detail-sep"> · </span>' : "") +
              '<span class="position">' + esc(p.position) + "</span></span></li>";
          } else html += '<li><span class="n">' + esc(m.name) + '</span><span class="company">' +
            esc(p.company || "公司待補") + '</span><span class="position">' +
            esc(p.position || "職位待確認") + "</span></li>";
        } else {
          var leader = (g.leader || "").trim() && (m.name || "").trim() === g.leader.trim();
          html += '<li class="' + (leader ? "leader" : "") + '"><span class="n">' + esc(m.name) +
            '</span><span class="sep">|</span><span class="t">' + esc(m.title) + "</span></li>";
        }
      });
      if(!external) (g.recruiting || []).forEach(function(r){
        html += '<li class="recruit"><span class="t">' + esc(r) + "</span></li>";
      });
      html += "</ul></section>";
    });
    return html;
  }
  var api = { publicProfile: publicProfile, renderGroups: renderGroups };
  if(typeof module !== "undefined") module.exports = api;
  else root.GroupSheet = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
