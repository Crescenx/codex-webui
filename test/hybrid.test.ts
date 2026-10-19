import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {serve} from '../server/main.ts';
import {AppServer} from '../server/adapter.ts';
import {AgentWorkspaces} from '../server/agent-workspace.ts';
import {HybridSessions} from '../server/hybrid.ts';
import {DatabaseSync} from 'node:sqlite';
import type {Thread,Obj} from '../shared/protocol.ts';

async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<250;i++){if(await check())return;await delay(20);}throw Error('condition not reached');}
async function fixture(dir:string){
  await mkdir(dir+'/project',{recursive:true});
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/codex.json'}});
  const app=await serve({roots:[dir+'/project'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(route:string,body?:unknown)=>{const response=await fetch(app.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value;};
  return {app,adapter,http};
}

test('retired runtime APIs reject requests while Codex creation remains available',async()=>{
  const dir=await mkdtemp('/tmp/viewer-retired-runtime-'),f=await fixture(dir);
  try{
    assert.deepEqual((await f.http('/runtimes')).data.map((r:Obj)=>r.id),['codex']);
    await assert.rejects(f.http('/threads',{cwd:dir+'/project',runtimeId:'antigravity'}),{status:400});
    await assert.rejects(f.http('/thread-options?cwd='+encodeURIComponent(dir+'/project')+'&runtimeId=antigravity'),{status:400});
    await assert.rejects(f.http('/runtimes/antigravity/usage'),{status:404});
    await assert.rejects(f.http('/runtimes/antigravity/sync',{}),{status:404});
    await assert.rejects(f.http('/threads/antigravity:retired/open',{}),{status:410});
    const t=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    assert.equal(t.runtimeId,'codex');assert.equal(t.capabilities.handoff,false);
    await assert.rejects(f.http('/threads/'+t.id+'/handoff',{operationId:'retired',runtimeId:'antigravity'}),{status:404});
    await assert.rejects(f.http('/threads/'+t.id+'/agents',{operationId:'retired',runtimeId:'antigravity',task:'must not run'}),{status:400});
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});

test('retired active bindings and pending child results stay untouched and never reach Codex',async()=>{
  const dir=await mkdtemp('/tmp/viewer-retired-history-'),file=dir+'/hybrid.sqlite';
  const snapshot={id:'old-parent',cwd:dir,status:{type:'idle'},turns:[]};
  const parent={id:'old-parent',active:'antigravity:old',bindings:[{runtimeId:'codex',sessionId:'old-parent',cursor:0},{runtimeId:'antigravity',sessionId:'antigravity:old',cursor:0}],snapshot,handoffs:[],inherited:[]};
  const child={id:'old-child',active:'old-child',bindings:[{runtimeId:'codex',sessionId:'old-child',cursor:0}],snapshot:{...snapshot,id:'old-child'},handoffs:[],inherited:[],agent:{parentId:parent.id,task:'old task',workspace:{root:dir,cwd:dir,source:dir,excluded:[]},state:'completed',resultRevision:1,deliveredRevision:0,deliveryState:'pending'}};
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  for(const c of [parent,child])db.prepare('INSERT INTO conversations VALUES (?,?)').run(c.id,JSON.stringify(c));
  db.close();
  let calls=0;
  const unexpected=async():Promise<never>=>{calls++;throw Error('retired runtime reached execution hooks');};
  const hybrid=new HybridSessions(file,dir+'/copies',{load:unexpected,create:unexpected,submit:unexpected,stop:unexpected,recover:unexpected,ready:()=>true,authorize:async cwd=>cwd,addWorkspace:()=>{}});
  try{
    assert.equal(hybrid.list().some(t=>t.id===parent.id),false);
    assert.throws(()=>hybrid.cached(parent.id),/运行时已移除/);
    await assert.rejects(hybrid.spawn(parent.id,{runtimeId:'codex',operationId:'no-replay',task:'must not run'}),/运行时已移除/);
    hybrid.observe({...snapshot,runtimeId:'codex'});
    await hybrid.tick();assert.equal(calls,0);
  }finally{await hybrid.stop();}
  const saved=new DatabaseSync(file);
  try{assert.equal(saved.prepare('SELECT data FROM conversations WHERE id=?').get(parent.id)?.data,JSON.stringify(parent));}
  finally{saved.close();await rm(dir,{recursive:true,force:true});}
});


test('delegation uses a dirty working copy, coexists with native children, returns once and applies only the inspected revision',async()=>{
  const dir=await mkdtemp('/tmp/viewer-delegate-'),f=await fixture(dir);
  try{
    await writeFile(dir+'/project/change.txt','uncommitted baseline\n');
    const parent=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    await f.adapter.call('mock/turn',{threadId:parent.id,turnId:'context',items:[{id:'selected',type:'agentMessage',text:'selected context'},{id:'private',type:'agentMessage',text:'not selected'}]});
    await f.adapter.call('mock/agent',{threadId:parent.id,id:'native-child'});
    const call=(name:string,args:Obj)=>f.adapter.call('mock/agents',{threadId:parent.id,name,arguments:args});
    const started=await call('spawn_agent',{operationId:'spawn-one',runtimeId:'codex',task:'Inspect fixture',context:{items:['selected']}});
    const childId=String((started.result as Obj).threadId);
    await until(()=>f.app.hybrid.cached(childId).agentState==='completed');
    const child=f.app.hybrid.cached(childId),workspace=child.hybrid!.agent!.workspace;
    assert.notEqual(workspace.cwd,dir+'/project');assert.equal(await readFile(workspace.cwd+'/change.txt','utf8'),'uncommitted baseline\n');
    const inherited=await f.app.hybrid.tool(child.hybrid!.activeSessionId,'read_context',{source:'inherited',index:0}) as Obj;
    assert.match(String(inherited.content),/selected context/);assert.doesNotMatch(String(inherited.content),/not selected/);
    const tree=(await f.http('/threads/'+parent.id+'/subagents')).data as Thread[];
    assert.ok(tree.some(t=>t.id==='native-child'));assert.ok(tree.some(t=>t.id===childId&&t.parentThreadId===parent.id));
    await writeFile(workspace.cwd+'/change.txt','child result\n');
    const diff=await call('agent_changes',{agentId:childId});
    await call('apply_agent',{agentId:childId,operationId:'apply-one',revision:diff.revision});
    assert.equal(await readFile(dir+'/project/change.txt','utf8'),'child result\n');
    await call('apply_agent',{agentId:childId,operationId:'apply-one',revision:diff.revision});
    await assert.rejects(f.adapter.call('mock/agents',{threadId:parent.id,noIdentity:true,name:'list_agents',arguments:{}}),/身份/);
    const sibling=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    await assert.rejects(f.adapter.call('mock/agents',{threadId:sibling.id,name:'apply_agent',arguments:{agentId:childId,operationId:'invalid',revision:diff.revision}}),/直接派发/);
    await until(()=>f.app.hybrid.cached(childId).hybrid?.agent?.deliveryState==='delivered');
    const receipts=f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result');assert.equal(receipts.length,1);
    await f.app.hybrid.tick();assert.equal(f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result').length,1);
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});

test('workspace merge detects stale revisions, parent conflicts, binary edits and symlink escapes',async()=>{
  const dir=await mkdtemp('/tmp/viewer-workspace-');
  try{
    const source=dir+'/source';await mkdir(source);await writeFile(source+'/a.txt','base\n');await writeFile(source+'/b.bin',Buffer.from([0,1,2]));
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    await writeFile(w.cwd+'/a.txt','child\n');let diff=await manager.changes(w);
    await writeFile(w.cwd+'/b.bin',Buffer.from([0,4,5]));await assert.rejects(manager.apply(w,'stale',diff.revision),/变化/);
    diff=await manager.changes(w);await writeFile(source+'/a.txt','parent\n');
    await assert.rejects(manager.apply(w,'conflict',diff.revision),/冲突/);assert.deepEqual(await readFile(source+'/b.bin'),Buffer.from([0,1,2]));
    await writeFile(source+'/a.txt','base\n');await manager.apply(w,'valid',diff.revision);assert.deepEqual(await readFile(source+'/b.bin'),Buffer.from([0,4,5]));
    await rm(w.cwd+'/a.txt');await symlink('/etc/passwd',w.cwd+'/a.txt');await assert.rejects(manager.changes(w),/链接/);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('three-way apply preserves independent parent edits and rejects a later changed parent on journal recovery',async()=>{
  const dir=await mkdtemp('/tmp/viewer-merge-recovery-');
  try{
    const source=dir+'/source';await mkdir(source);const base='one\ntwo\nthree\nfour\nfive\nsix\n';await writeFile(source+'/a.txt',base);
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    await writeFile(w.cwd+'/a.txt',base.replace('one','child'));await writeFile(source+'/a.txt',base.replace('six','parent'));
    const diff=await manager.changes(w);await manager.apply(w,'merge',diff.revision);
    assert.equal(await readFile(source+'/a.txt','utf8'),base.replace('one','child').replace('six','parent'));
    const journal=JSON.parse(await readFile(w.root+'/apply-merge.json','utf8'));journal.state='applying';await writeFile(w.root+'/apply-recovery.json',JSON.stringify({...journal,id:'recovery'}));
    await writeFile(source+'/a.txt','later user edit\n');await assert.rejects(manager.apply(w,'recovery',diff.revision),/来源发生变化/);
    assert.equal(await readFile(source+'/a.txt','utf8'),'later user edit\n');
  }finally{await rm(dir,{recursive:true,force:true});}
});
