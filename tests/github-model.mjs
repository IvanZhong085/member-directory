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
          if(e.sha === null){ next.delete(e.path); continue; }
          /* tree entry 可以直接帶 content(GitHub 會在同一個請求裡建好 blob)。
             小型 JSON 走這條:省一個子請求,而且不可能發生「內容變了卻沿用舊 blob」。 */
          if(typeof e.content === "string"){
            next.set(e.path, e.content);
            self.blobs.set(blobShaOf(e.content), e.content);
            continue;
          }
          next.set(e.path, self.blobs.get(e.sha));   // POST 建立時已記進 blobs
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
          const cur0 = self.files();
          const cur = cur0.has(path) ? blobShaOf(cur0.get(path)) : null;
          if(cur !== null && b.sha && b.sha !== cur) return J({ message:"conflict" }, 409);
          const nc = Buffer.from(b.content, "base64").toString("utf8");
          /* ★ 建一個**新的** tree 與 commit,而不是就地改動現有的 tree。
             真實的 contents PUT 就是一次 commit;而且 tree 是不可變的 ——
             先前就地改動會讓「內容定址的 tree sha」與實際內容脫節,兩棵內容相同的
             tree 還會互相覆蓋(head 指向的那一棵因此被別人的計算結果換掉)。
             那是測試模型的缺陷,會讓真正的錯誤被蓋過去。 */
          const next = new Map(cur0);
          next.set(path, nc);
          self.blobs.set(blobShaOf(nc), nc);
          const tsha = self.treeShaFor(next);
          self.trees.set(tsha, next);
          const csha = "c" + sha256(tsha + self.head + "put" + self.commits.size).slice(0, 20);
          self.commits.set(csha, { tree:tsha, parent:self.head, message:"contents PUT " + path });
          self.head = csha;
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

/* 假的 R2 bucket。介面對齊 Cloudflare Workers 的 R2Bucket:put/get/delete/head。
   ★ 可以指定某個操作失敗 —— 「第 N 張上傳失敗時前 N-1 張要被清掉」這種保證,
     只有能注入失敗才驗得出來。 */
export class FakeR2 {
  constructor(){
    this.objects = new Map();     // key → Uint8Array
    this.meta = new Map();        // key → { contentType }
    this.uploaded = new Map();    // key → Date(盤點要用它算孤兒放了多久)
    this.calls = [];              // { op, key } 依序記錄
    this.fail = null;             // { op, key?, nth? } 符合就丟錯
    /* list 每頁幾筆。真實 R2 是 1000,測「列舉被截斷時不可以下結論」那條保證時
       調小它,否則要先塞一千多個假物件才驗得到。 */
    this.pageSize = 1000;
    this._n = { put:0, get:0, delete:0, head:0, list:0 };
  }
  _check(op, key){
    this.calls.push({ op, key });
    this._n[op]++;
    const f = this.fail;
    if(!f || f.op !== op) return;
    if(f.key !== undefined && f.key !== key) return;
    if(typeof f.nth === "number" && f.nth !== this._n[op]) return;
    if(f.once) this.fail = null;
    throw new Error("FakeR2 injected failure: " + op + " " + key);
  }
  async put(key, bytes, opts){
    this._check("put", key);
    this.objects.set(key, new Uint8Array(bytes));
    this.meta.set(key, { contentType: opts && opts.httpMetadata && opts.httpMetadata.contentType });
    this.uploaded.set(key, new Date());
    return { key };
  }
  async get(key){
    this._check("get", key);
    if(!this.objects.has(key)) return null;
    const bytes = this.objects.get(key);
    return {
      key,
      async arrayBuffer(){ return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  async delete(key){
    this._check("delete", key);
    this.objects.delete(key); this.meta.delete(key); this.uploaded.delete(key);
  }
  /* 依 key 字典序分頁。cursor 就是「上一頁最後一個 key」——夠用而且好推理。
     真實 R2 的 cursor 是不透明字串,但呼叫端只會原封帶回來,行為等價。 */
  async list(opts){
    const prefix = (opts && opts.prefix) || "";
    this._check("list", prefix);
    const all = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = opts && opts.cursor ? all.indexOf(opts.cursor) + 1 : 0;
    const page = all.slice(start, start + this.pageSize);
    const truncated = start + this.pageSize < all.length;
    return {
      objects: page.map(k => ({ key:k, size:this.objects.get(k).length,
                                uploaded: this.uploaded.get(k) || new Date(0) })),
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined,
    };
  }
  /* 把某個物件的上傳時間往回撥,用來測「孤兒放了幾天」。 */
  age(key, days){ this.uploaded.set(key, new Date(Date.now() - days * 86400000)); }
  async head(key){
    this._check("head", key);
    return this.objects.has(key) ? { key, size: this.objects.get(key).length } : null;
  }
  keys(){ return [...this.objects.keys()].sort(); }
  /* 直接把某個物件的內容換掉(不經過 put),用來模擬毀損 */
  corrupt(key, bytes){ this.objects.set(key, new Uint8Array(bytes)); }
}

export function loadWorker(path, fs){
  const src = fs.readFileSync(path, "utf8").replace(/^export default/m, "const __worker =");
  return new Function(`${src}\nreturn { __worker, makeSession };`)();
}
