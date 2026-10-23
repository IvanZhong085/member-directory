import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { serializeDataJs, serializePublicProfiles } from '../tools/build-data.mjs';
const require=createRequire(import.meta.url),groups=require('../data.js');
const root=fileURLToPath(new URL('../',import.meta.url));
const out=process.env.GROUPS_ARTIFACT_DIR||join(tmpdir(),'company-admin-browser');
await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{try{
 const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
 if(!path.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain'}[extname(path)];
 res.setHeader('Content-Type',(mime||'application/octet-stream')+'; charset=utf-8');res.end(await readFile(path));
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(30000+Math.floor(Math.random()*10000),'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[],published=[];
 // Every remote request is blocked or fulfilled locally. No real authentication or publish request is sent.
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='127.0.0.1')return route.continue();
  if(u.hostname==='member-directory-relay.retetrhjj123.workers.dev'){
   if(u.pathname==='/publish')published.push(route.request().postDataJSON());
   return route.fulfill({contentType:'application/json',body:JSON.stringify(u.pathname==='/ping'?{ok:true,caps:{files:true,read:false}}:{ok:true})});
  }
  return route.abort();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const m=groups[0].members[0],title=m.title,role='測試職稱（僅隔離測試）';
 await page.goto(base+'/index.html#/member/'+m.id);
 await page.locator('.detail-name').waitFor();
 assert.equal(await page.locator('.detail-title').innerText(),title);
 assert.ok((await page.locator('.info-card').allTextContents()).some(t=>t.includes(m.company)&&t.includes(m.companyPosition)));
 await page.screenshot({path:join(out,'member-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:join(out,'member-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await page.addInitScript(()=>sessionStorage.setItem('member-directory-session-v1',JSON.stringify({token:'isolated-test-only',exp:Date.now()+3600000,user:'Local Test',role:'owner'})));
 await page.goto(base+'/admin.html');
 const card=page.locator('.mem-card[data-mid="'+m.id+'"]');
 await card.waitFor();const position=card.locator('[data-f="companyPosition"]');
 assert.equal(await position.inputValue(),m.companyPosition);
 assert.equal(await card.locator('[data-f="title"]').inputValue(),title);
 await position.fill(role);await position.blur();await page.locator('#btn-save').click();
 await page.waitForFunction(([id,role])=>JSON.parse(localStorage.getItem('member-directory-draft-v2:all')||'null')?.data?.flatMap(g=>g.members).find(m=>m.id===id)?.companyPosition===role,[m.id,role]);
 await page.reload();await card.waitFor();assert.equal(await position.inputValue(),role);
 await card.screenshot({path:join(out,'admin-role-field.png')});
 const waiting=page.waitForEvent('download');await page.locator('#btn-export').click();
 const download=await waiting;await download.saveAs(join(out,'admin-backup-test.js'));
 const exported=new Function((await readFile(join(out,'admin-backup-test.js'),'utf8'))+';return GROUPS;')();
 const changed=exported.flatMap(g=>g.members).find(x=>x.id===m.id);
 assert.equal(changed.companyPosition,role);assert.equal(changed.title,title);
 assert.equal(changed.company,m.company);assert.equal(changed.number,m.number);
 assert.equal(exported[0].members[1].updatedAt,groups[0].members[1].updatedAt,'unmodified member timestamps remain unchanged');
 const rebuilt=new Function(serializeDataJs(exported)+';return GROUPS;')();
 assert.equal(rebuilt[0].members[0].companyPosition,role);
 assert.equal(JSON.parse(serializePublicProfiles(rebuilt))[m.id].position,role);
 const csvWaiting=page.waitForEvent('download');await page.locator('#btn-csv-export').click();
 const csv=await csvWaiting;await csv.saveAs(join(out,'admin-csv-test.csv'));
 const csvText=await readFile(join(out,'admin-csv-test.csv'),'utf8');assert.ok(csvText.includes('公司內職稱')&&csvText.includes(role));
 const publishWaiting=page.waitForResponse(r=>new URL(r.url()).pathname==='/publish');
 await page.locator('#btn-publish').click();await publishWaiting;
 assert.equal(published.length,1,'one locally intercepted publish payload');
 const file=published[0].files.find(f=>f.path==='data/a1.json');assert.ok(file);
 const payload=JSON.parse(Buffer.from(file.contentB64,'base64').toString('utf8'));
 assert.equal(payload.members.find(x=>x.id===m.id).companyPosition,role);
 assert.equal(payload.members.find(x=>x.id===m.id).title,title);
 await page.route('**/data.js?*',r=>r.fulfill({contentType:'text/javascript',body:serializeDataJs(rebuilt)}));
 await page.goto(base+'/groups.html?view=public-single');
 await page.waitForFunction(()=>document.getElementById('public-status').dataset.state==='ready');
 assert.equal(await page.locator('.position').first().innerText(),role,'chart uses the rebuilt edited master');
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'company-admin-verification.json'),JSON.stringify({passed:true,roleEdit:true,reload:true,backup:true,csv:true,build:true,chart:true,isolatedPublishPayload:true,noRemoteWrites:true},null,2)+'\n');
 console.log('company-admin-browser: PASS (member page, admin edit/reload/backup/CSV, rebuild, chart, locally mocked publish only)');
}finally{await browser.close();await new Promise(r=>server.close(r));}
