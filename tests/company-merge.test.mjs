import assert from 'node:assert/strict';
import { planMerge, runMerge } from '../tools/merge-company-profiles.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const groups = [{code:'A1',id:'g1',leader:'甲褔',recruiting:['原招募'],members:[
  {id:'one',name:'甲褔',number:'224',company:'',title:'專業別',image:'original.jpg',updatedAt:'old'},
  {id:'two',name:'乙',number:'224',company:'原公司',companyPosition:'',services:['原服務']}
]}];
const row=(id,name,company,position)=>({memberId:id,identity:{name,number:'224',groupCode:'A1',groupId:'g1'},
  expected:{name,company:id==='one'?'':'原公司',companyPosition:''},values:{name,company,companyPosition:position},
  evidence:{name:'reviewed-alias',company:'form:D2',companyPosition:'form:G2'},sourceRow:2});
const input={schemaVersion:1,rows:[row('one','甲褔','來源公司','經理'),row('two','乙','原公司','')]};
input.rows[0].values.name='甲福';
const result=planMerge(groups,input);
assert.equal(result.summary.changedMembers,1);assert.equal(result.summary.changedFields,3);
assert.equal(result.next[0].leader,'甲福');assert.equal(result.next[0].members[0].title,'專業別');
assert.equal(result.next[0].members[0].image,'original.jpg');assert.equal(result.next[0].members[0].updatedAt,'old');
assert.deepEqual(result.next[0].members[1],groups[0].members[1]);assert.equal(groups[0].members[0].name,'甲褔');
assert.equal(planMerge(result.next,input).changes.length,0,'repeated merge is a no-op');
const edit=structuredClone(groups);edit[0].members[0].company='使用者的新公司';
assert.ok(planMerge(edit,input).conflicts.some(x=>x.reason==='field_changed_since_review'));
const move=structuredClone(groups);move[0].members[0].id='new-id';
assert.ok(planMerge(move,input).conflicts.some(x=>x.reason==='member_id_missing_review_remap'),'never guess remapped ID from duplicate number');
const reused=structuredClone(groups);reused[0].members[0].name='另一人';
assert.ok(planMerge(reused,input).conflicts.some(x=>x.reason==='identity_changed_review_remap'));
const duplicate=structuredClone(input);duplicate.rows.push(duplicate.rows[0]);assert.throws(()=>planMerge(groups,duplicate),/duplicate input/);
const privateField=structuredClone(input);privateField.rows[0].values.taxId='PRIVATE';assert.throws(()=>planMerge(groups,privateField),/Only explicit/);
const missing=structuredClone(input);missing.rows[0].evidence.companyPosition='';assert.ok(planMerge(groups,missing).conflicts.some(x=>x.reason==='source_evidence_missing'));
const hasRole=structuredClone(groups);hasRole[0].members[1].companyPosition='新職稱';
assert.equal(planMerge(hasRole,input).next[0].members[1].companyPosition,'新職稱','blank questionnaire cannot erase current role');

const temp=mkdtempSync(join(tmpdir(),'company-merge-test-')),root=join(temp,'repo'),git=process.env.GIT_EXECUTABLE||'git';
try{
 mkdirSync(join(root,'data'),{recursive:true});
 execFileSync(git,['init','-q'],{cwd:root});
 execFileSync(git,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture'],{cwd:root});
 input.baseCommit=execFileSync(git,['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 writeFileSync(join(root,'data/_index.json'),JSON.stringify([{code:'A1',id:'g1',name:'原分組'}]));
 writeFileSync(join(root,'data/a1.json'),JSON.stringify({leader:groups[0].leader,members:groups[0].members,recruiting:['原招募']}));
 const inputPath=join(temp,'input.json'),plan=join(temp,'plan.json'),report=join(temp,'apply.json');
 writeFileSync(inputPath,JSON.stringify(input));
 const before=readFileSync(join(root,'data/a1.json'),'utf8');
 runMerge({root,input:inputPath,report:plan});assert.equal(readFileSync(join(root,'data/a1.json'),'utf8'),before,'dry-run does not edit');
 assert.throws(()=>runMerge({root,input:inputPath,report:join(root,'private.json')}),/outside/);
 const newer=JSON.parse(before);newer.members[0].image='new-photo.jpg';writeFileSync(join(root,'data/a1.json'),JSON.stringify(newer));
 assert.throws(()=>runMerge({root,input:inputPath,report,plan,apply:true}),/changed after dry-run/);
 runMerge({root,input:inputPath,report:plan});runMerge({root,input:inputPath,report,plan,apply:true});
 const after=readFileSync(join(root,'data/a1.json'),'utf8');assert.equal(JSON.parse(after).members[0].image,'new-photo.jpg');
 const noop=runMerge({root,input:inputPath,report,plan,apply:true});assert.equal(noop.summary.changedFields,0);
 assert.equal(readFileSync(join(root,'data/a1.json'),'utf8'),after);
}finally{
 if(!temp.startsWith(join(tmpdir(),'company-merge-test-')))throw Error('Unexpected cleanup target');
 rmSync(temp,{recursive:true,force:true});
}
console.log('company-merge: PASS (reviewed identity, duplicate numbers, renamed IDs, conflicts, scope, dry-run/apply, idempotence)');
