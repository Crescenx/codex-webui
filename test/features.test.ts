import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { windowsEvidence, reduceNotice, shortTitle, threadTitle, mergeThreadMetadata } from '../shared/protocol.ts';
import type { Thread, Turn } from '../shared/protocol.ts';
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
test('short titles and metadata refresh preserve live state and explicit cleared names',()=>{
  assert.equal(shortTitle(' \n# 修复   会话标题\n完整任务要求'),'修复 会话标题');
  assert.equal(Array.from(shortTitle('😀'.repeat(80))).length,60);
  const t:Thread={id:'a',cwd:'/tmp',name:'旧标题',preview:'',status:{type:'active'},turns:[{id:'turn',status:'inProgress',items:[]}],settings:{model:'mock',effort:'high',mode:'plan'}};
  const turns=t.turns,settings=t.settings;
  mergeThreadMetadata(t,{id:'a',cwd:'/tmp',name:'新标题',preview:'首条消息',status:{type:'idle'},turns:[]});
  assert.equal(threadTitle(t),'新标题');assert.equal(t.turns,turns);assert.equal(t.settings,settings);assert.equal(t.status?.type,'active');
  reduceNotice(t,{method:'thread/name/updated',params:{threadId:'a',threadName:null}});assert.equal(threadTitle(t),'首条消息');
});
test('partial turn snapshots and early items never erase accepted user messages',()=>{
  const t:Thread={id:'thread',cwd:'/tmp',turns:[]};const params={threadId:t.id,turnId:'turn'};
  const user={id:'user',type:'userMessage',content:[{type:'text',text:'并发实验'}]};
  const answer={id:'answer',type:'agentMessage',text:'你想测试多个对话同时运行？'};
  reduceNotice(t,{method:'item/started',params:{...params,item:user}});
  reduceNotice(t,{method:'turn/started',params:{threadId:t.id,turn:{id:'turn',status:'inProgress',items:[]}}});
  reduceNotice(t,{method:'item/completed',params:{...params,item:answer}});
  reduceNotice(t,{method:'turn/completed',params:{threadId:t.id,turn:{id:'turn',status:'completed',items:[answer]}}});
  assert.deepEqual(t.turns![0].items.map(i=>i.id),['user','answer']);
  // A late turn/start RPC response can add missing input, but cannot restart a finished turn.
  reduceNotice(t,{method:'turn/started',params:{threadId:t.id,turn:{id:'turn',status:'inProgress',items:[user]}}});
  assert.equal(t.turns![0].status,'completed');assert.equal(t.status?.type,'idle');
  assert.equal(t.turns![0].items.filter(i=>i.type==='userMessage').length,1);
  const late:Thread={id:'thread',cwd:'/tmp',turns:[{id:'turn',status:'completed',items:[answer]}],status:{type:'idle'}};
  reduceNotice(late,{method:'turn/started',params:{threadId:late.id,turn:{id:'turn',status:'inProgress',items:[user]}}});
  assert.deepEqual(late.turns![0].items.map(i=>i.id),['user','answer']);assert.equal(late.status?.type,'idle');
});
test('naming persists, manual edits win, fresh metadata wins over cache, and naming failure does not fail sending',{timeout:10000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-naming-'));
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const call=adapter.call.bind(adapter);let failNaming=false;let delayList=false;
  let releaseList:()=>void=()=>{};let listStarted:()=>void=()=>{};
  const externalNames=new Map<string,string|null>();
  adapter.call=async(method,params={})=>{
    if(method==='thread/name/set' && failNaming)throw new Error('Simulated naming failure');
    const result=await call(method,params);
    if(method==='thread/read') {const t=result.thread as Thread;if(externalNames.has(t.id))t.name=externalNames.get(t.id);}
    if(method==='thread/list') {
      for(const t of result.data as Thread[])if(externalNames.has(t.id))t.name=externalNames.get(t.id);
      if(delayList){listStarted();await new Promise<void>(resolve=>{releaseList=resolve;});}
    }
    return result;
  };
  const app=await serve({roots:[dir],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter});
  try{
    const login=await fetch(app.launchUrl,{redirect:'manual'});const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const request=(url:string,data?:unknown)=>fetch(app.origin+'/api'+url,{method:data===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const create=async()=>((await (await request('/threads',{cwd:dir})).json()).thread as Thread).id;
    const id=await create();
    assert.equal((await request(`/threads/${id}/name`,{name:'\n'})).status,400);
    assert.equal((await request(`/threads/${id}/name`,{name:'x'.repeat(121)})).status,400);
    assert.equal((await request(`/threads/${id}/turns`,{text:'# 标题同步\n详细需求',attachments:[]})).status,200);
    // A manual edit while the summary is generating must remain authoritative.
    assert.equal((await request(`/threads/${id}/name`,{name:'手动标题'})).status,200);
    assert.equal(((await call('thread/read',{threadId:id})).thread as Thread).name,'手动标题');
    externalNames.set(id,'其他客户端的标题');
    const listed=(await (await request('/threads')).json()).data.find((t:Thread)=>t.id===id);
    assert.equal(listed.name,'其他客户端的标题');assert.ok(listed.preview);
    const opened=(await (await request(`/threads/${id}/open`,{})).json()).thread;
    assert.equal(opened.name,'其他客户端的标题');assert.equal(opened.turns.length,1);assert.equal(opened.turns[0].items[0].content[0].text,'# 标题同步\n详细需求');
    const started=new Promise<void>(resolve=>{listStarted=resolve;});delayList=true;
    const stale=request('/threads');await started;
    await call('thread/name/set',{threadId:id,name:'最新通知标题'});releaseList();
    assert.equal((await (await stale).json()).data.find((t:Thread)=>t.id===id).name,'最新通知标题');delayList=false;
    const autoId=await create();
    const named=new Promise<void>(resolve=>{const listener=(n:{method:string;params:{threadId?:string}})=>{if(n.method==='thread/name/updated'&&n.params.threadId===autoId){adapter.off('notice',listener);resolve();}};adapter.on('notice',listener);});
    await request(`/threads/${autoId}/turns`,{text:'# 自动标题\n后续要求',attachments:[]});await named;
    assert.equal(((await call('thread/read',{threadId:autoId})).thread as Thread).name,'概括任务目的');
    assert.equal(((await call('thread/read',{threadId:id})).thread as Thread).name,'最新通知标题');
    const preset=await create();await request(`/threads/${preset}/name`,{name:'预设标题'});
    await request(`/threads/${preset}/turns`,{text:'不要覆盖',attachments:[]});
    assert.equal(((await call('thread/read',{threadId:preset})).thread as Thread).name,'预设标题');
    failNaming=true;const failed=await create();
    assert.equal((await request(`/threads/${failed}/turns`,{text:'任务仍然成功发送',attachments:[]})).status,200);
    const snap=(await (await request(`/threads/${failed}`)).json()).thread;
    assert.equal(threadTitle(snap),'任务仍然成功发送');assert.equal(snap.turns.length,1);
    assert.equal((await request(`/threads/${failed}/name`,{name:'重试'})).status,502);
  }finally{releaseList();await app.stop();await rm(dir,{recursive:true,force:true});}
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
