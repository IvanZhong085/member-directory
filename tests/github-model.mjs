/* 併發測試用的假 GitHub。
   忠實模擬三件與正確性相關的事:
     ・contents API 的 ?ref=<sha> 讀的是**那個 commit 的快照**,不是當下的 main
     ・contents API 的 content 欄位只在檔案 ≤1MB 時才有內容(超過改走 git blobs)
     ・ref 更新是 fast-forward-only:parent 必須正好是現在的 head,否則 422
   有了這三點,交錯情境才有意義;少了任何一點,測試都會過得太輕鬆。 */
import crypto from "node:crypto";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
export const blobShaOf = s => "b" + sha256(s).slice(0, 39);

export class FakeGitHub {
  constructor(files){
    this.trees = new Map();      // treeSha → Map(path → content)
    this.commits = new Map();    // commitSha → { tree, parent, message }
    this.blobs = new Map();      // blobSha → content
    this.trees.set("t0", new Map(Object.entries(files)));
    for(const c of Object.values(files)) this.blobs.set(blobShaOf(c), c);   // 供 git/blobs 的 GET 取用
    this.commits.set("c0", { tree:"t0", parent:null, message:"init" });
    this.head = "c0";
    this.refRejects = 0;
    this.subrequests = 0;        // 子請求計數(Cloudflare 免費方案上限 50)
    this.failReadOnce = null;
    this.hooks = {};
  }
  files(commitSha){ return this.trees.get(this.commits.get(commitSha || this.head).tree); }
  treeShaFor(map){
    return "t" + sha256([...map.entries()].sort().map(([k,v]) => k + ":" + sha256(v || "")).join("|")).slice(0, 20);
  }
  install(hooks = {}){
    this.hooks = hooks;
    const self = this;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), method = init.method || "GET";
      self.subrequests++;
      const J = (o, status = 200) => new Response(JSON.stringify(o), { status });
      if(self.hooks.before) await self.hooks.before(u, method, self);

      let m;
      if((m = u.match(/\/git\/ref\/heads\/(.+)$/)) && method === "GET") return J({ object:{ sha:self.head } });

      if((m = u.match(/\/git\/commits\/([^/?]+)$/)) && method === "GET"){
        const c = self.commits.get(m[1]);
        return c ? J({ sha:m[1], tree:{ sha:c.tree } }) : J({}, 404);
      }
      if((m = u.match(/\/git\/trees\/([^/?]+)/)) && method === "GET"){
        const map = self.trees.get(m[1]);
        if(!map) return J({}, 404);
        return J({ sha:m[1], truncated:false,
          tree:[...map.entries()].map(([path, c]) => ({ path, type:"blob", sha: blobShaOf(c) })) });
      }
      /* git blobs 的 GET:contents API 對 >1MB 的檔案不給內容,Worker 會改走這裡。
         少了這一段,只要待認領區超過 1MB 測試就會假性失敗(而那正是要驗的路徑)。 */
      if((m = u.match(/\/git\/blobs\/([^/?]+)$/)) && method === "GET"){
        const c = self.blobs.get(m[1]);
        if(c === undefined) return J({}, 404);
        return J({ sha:m[1], size: Buffer.byteLength(c), encoding:"base64",
                   content: Buffer.from(c).toString("base64").replace(/(.{60})/g, "$1\n") });
      }
      if(u.endsWith("/git/blobs") && method === "POST"){
        const b = JSON.parse(init.body);
        const content = Buffer.from(b.content, "base64").toString("utf8");
        const sha = blobShaOf(content);
        self.blobs.set(sha, content);
        return J({ sha });
      }
      if(u.endsWith("/git/trees") && method === "POST"){
        const b = JSON.parse(init.body);
        const next = new Map(self.trees.get(b.base_tree));
        for(const e of b.tree){
          if(e.sha === null) next.delete(e.path);
          else next.set(e.path, self.blobs.get(e.sha));   // POST 建立時已記進 blobs
        }
        const sha = self.treeShaFor(next);
        self.trees.set(sha, next);
        return J({ sha });
      }
      if(u.endsWith("/git/commits") && method === "POST"){
        const b = JSON.parse(init.body);
        const sha = "c" + sha256(b.tree + b.parents[0] + b.message + self.commits.size).slice(0, 20);
        self.commits.set(sha, { tree:b.tree, parent:b.parents[0], message:b.message });
        return J({ sha });
      }
      if((m = u.match(/\/git\/refs\/heads\/(.+)$/)) && method === "PATCH"){
        const b = JSON.parse(init.body);
        const c = self.commits.get(b.sha);
        if(!c || c.parent !== self.head){ self.refRejects++; return J({ message:"not a fast forward" }, 422); }
        self.head = b.sha;
        return J({ object:{ sha:b.sha } });
      }
      if((m = u.match(/\/contents\/(.+?)(\?|$)/))){
        const path = decodeURIComponent(m[1]);
        /* contents API 的 PUT(/intake 用它寫待認領區)。
           sha 是樂觀鎖:帶了就必須與現行相符,否則 409 —— 與真實行為一致,
           少了這一段就測不出 /intake 的併發保護。 */
        if(method === "PUT"){
          const b = JSON.parse(init.body);
          const f = self.files();
          const cur = f.has(path) ? blobShaOf(f.get(path)) : null;
          if(cur !== null && b.sha && b.sha !== cur) return J({ message:"conflict" }, 409);
          const nc = Buffer.from(b.content, "base64").toString("utf8");
          f.set(path, nc); self.blobs.set(blobShaOf(nc), nc);
          return J({ content:{ path } });
        }
        const refM = u.match(/[?&]ref=([^&]+)/);
        const ref = refM ? decodeURIComponent(refM[1]) : "main";
        // ★ ?ref=<commit sha> 讀的是那個 commit 的快照
        const commitSha = self.commits.has(ref) ? ref : self.head;
        if(self.failReadOnce === path){ self.failReadOnce = null; return J({}, 500); }
        const f = self.files(commitSha);
        if(!f.has(path)) return J({}, 404);
        const c = f.get(path);
        const size = Buffer.byteLength(c);
        if(size > 1024 * 1024) return J({ sha: blobShaOf(c), size, encoding:"none", content:"" });
        return J({ sha: blobShaOf(c), size, encoding:"base64", content: Buffer.from(c).toString("base64") });
      }
      return J({}, 404);
    };
  }
}

export function loadWorker(path, fs){
  const src = fs.readFileSync(path, "utf8").replace(/^export default/m, "const __worker =");
  return new Function(`${src}\nreturn { __worker, makeSession };`)();
}
