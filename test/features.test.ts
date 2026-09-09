import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { windowsEvidence, reduceNotice } from '../server/protocol.ts';
import type { Thread, Turn } from '../server/protocol.ts';
import { activity } from '../web/activity.ts';
import { projectRoot, localFile, previewFile } from '../server/files.ts';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('raw Windows evidence ignores Python newlines and unrelated metadata',()=>{
  assert.deepEqual(windowsEvidence({command:"python - <<'PY'\nwith zipfile.ZipFile(p) as z:\n for c in row:\n  print(c)\nPY",reason:'Use powershell.exe',itemId:'cmd'}),[]);
  for(const command of ['powershell.exe Get-Date','cat /mnt/c/file.txt','cat C:\\Users\\file.txt'])assert.ok(windowsEvidence({command}).length);
  assert.deepEqual(windowsEvidence({command:'echo fine',reason:'C:\\test'}),[]);
});
test('activity lifecycle, summaries and plans are reduced without empty details',()=>{
  const turn:Turn={id:'a',status:'inProgress',items:[]};const t:Thread={id:'t',cwd:'/tmp',turns:[turn]};
  const params={threadId:'t',turnId:'a'};
  reduceNotice(t,{method:'item/started',params:{...params,item:{id:'r',type:'reasoning',summary:[]}}});
  assert.equal(activity(turn.items[0],turn).detail,'');assert.equal(activity(turn.items[0],turn).state,'running');
  reduceNotice(t,{method:'item/reasoning/summaryTextDelta',params:{...params,itemId:'r',summaryIndex:0,delta:'checking'}});
  assert.equal(activity(turn.items[0],turn).detail,'checking');
  turn.status='interrupted';assert.equal(activity(turn.items[0],turn).state,'cancelled');
  assert.equal(activity({id:'c',type:'commandExecution',status:'completed',exitCode:1},turn).state,'failed');
  reduceNotice(t,{method:'item/plan/delta',params:{...params,itemId:'p',delta:'a plan'}});assert.equal(turn.items[1].text,'a plan');
});
test('Git grouping and file preview enforce root, type and line boundaries',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-files-'));
  try {
    const repo=path.join(dir,'repo');await mkdir(repo);execFileSync('git',['init','-q',repo]);const child=path.join(repo,'src');await mkdir(child);
    assert.equal(await projectRoot(child,[dir]),repo);assert.equal(await projectRoot(child,[child]),child);
    const nested=path.join(child,'nested');await mkdir(nested);execFileSync('git',['init','-q',nested]);assert.equal(await projectRoot(nested,[dir]),nested);
    execFileSync('git',['-C',repo,'-c','user.name=Viewer Test','-c','user.email=viewer@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','test']);
    const worktree=path.join(dir,'worktree');execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','worktree','add','-q','-b','test-worktree',worktree]);assert.equal(await projectRoot(worktree,[dir]),worktree);
    await writeFile(path.join(child,'中文 sample.py'),'first\nsecond\nthird\n');
    const file=await localFile('中文 sample.py:2',child,[dir]);assert.equal((await previewFile(file)).lines[1],'second');
    assert.equal((await localFile('中文 sample.py#L3',child,[dir])).line,3);
    await writeFile(path.join(child,'.env'),'SECRET');await assert.rejects(localFile('.env',child,[dir]),/敏感/);
    await symlink('/etc/passwd',path.join(child,'outside'));await assert.rejects(localFile('outside',child,[dir]),/授权/);
    await writeFile(path.join(child,'binary.bin'),Buffer.from([0,1,2]));await assert.rejects(previewFile(await localFile('binary.bin',child,[dir])),/二进制/);
    await assert.rejects(previewFile(await localFile('中文 sample.py:50',child,[dir])),/行号/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('controls, scoped skill writes, settings and editor endpoint',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-controls-'));await writeFile(path.join(dir,'sample.py'),'one\ntwo');
  const opened:string[]=[];
  const app=await serve({roots:[dir],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),editor:async f=>{opened.push(`${f.path}:${f.line}`);}});
  try{
    const login=await fetch(app.launchUrl,{redirect:'manual'});const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const request=(url:string,data?:unknown)=>fetch(app.origin+'/api'+url,{method:data===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const {thread}=await (await request('/threads',{cwd:dir})).json();const threadId=thread.id;
    const catalog=await (await request('/controls?threadId='+threadId)).json();assert.equal(catalog.models.length,2);assert.equal(catalog.modes.length,2);
    const skill=catalog.skills[0];assert.equal((await request('/skills/config',{threadId,path:'/unknown',enabled:false})).status,403);
    assert.equal((await (await request('/skills/config',{threadId,path:skill.path,enabled:false})).json()).effectiveEnabled,false);
    assert.equal((await request(`/threads/${threadId}/turns`,{text:'x',attachments:[],skills:[skill.path]})).status,400);
    await request('/skills/config',{threadId,path:skill.path,enabled:true});
    const settings={model:'mock-fast',effort:'high',mode:'plan'};
    assert.equal((await request(`/threads/${threadId}/turns`,{text:'x',attachments:[],skills:[skill.path],settings})).status,200);
    const snap=await (await request(`/threads/${threadId}`)).json();assert.deepEqual(snap.thread.settings,settings);
    assert.equal(snap.thread.turns[0].items[0].content[1].type,'skill');
    assert.equal((await request('/files/open',{threadId,target:'sample.py:2'})).status,200);assert.deepEqual(opened,[path.join(dir,'sample.py')+':2']);
    assert.equal((await request('/files/open',{threadId,target:'/etc/passwd'})).status,403);
    assert.equal((await request('/files/preview?'+new URLSearchParams({threadId,target:'sample.py:2'}))).status,200);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
