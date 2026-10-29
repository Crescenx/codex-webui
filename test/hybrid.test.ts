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
import {reduceNotice} from '../shared/protocol.ts';

async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<250;i++){if(await check())return;await delay(20);}throw Error('condition not reached');}
async function fixture(dir:string){
  await mkdir(dir+'/project',{recursive:true});
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/codex.json'}});
  const app=await serve({roots:[dir+'/project'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(route:string,body?:unknown)=>{const response=await fetch(app.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value;};
  return {app,adapter,http};
}

test('hybrid checkpoints migrate legacy history and persist only changed items',async()=>{
  const dir=await mkdtemp('/tmp/viewer-hybrid-incremental-'),file=dir+'/hybrid.sqlite';
  const snapshot:Thread={id:'incremental',cwd:dir,status:{type:'idle'},turns:[{id:'old',status:'completed',items:[{id:'large',type:'agentMessage',text:'history '.repeat(100000)}]},{id:'current',status:'completed',items:[{id:'answer',type:'agentMessage',text:'before'}]}]};
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  db.prepare('INSERT INTO conversations VALUES (?,?)').run(snapshot.id,JSON.stringify({id:snapshot.id,active:snapshot.id,bindings:[{runtimeId:'codex',sessionId:snapshot.id,cursor:0}],snapshot,handoffs:[],inherited:[{text:'context '.repeat(100000)}]}));
  const unexpected=async():Promise<never>=>{throw Error('must not execute');};
  const hooks={load:unexpected,create:unexpected,submit:unexpected,stop:unexpected,recover:unexpected,ready:()=>true,authorize:async(cwd:string)=>cwd,addWorkspace:()=>{}};
  let hybrid=new HybridSessions(file,dir+'/copies',hooks);
  try{
    db.exec('CREATE TABLE written(id TEXT); CREATE TRIGGER record_item_write AFTER INSERT ON conversation_items BEGIN INSERT INTO written VALUES(NEW.id); END;');
    const notice={method:'item/agentMessage/delta',params:{threadId:snapshot.id,turnId:'current',itemId:'answer',delta:' after'}};
    reduceNotice(snapshot,notice);hybrid.observe(snapshot,false,notice);
    hybrid.observe(snapshot,false,{method:'thread/tokenUsage/updated',params:{threadId:snapshot.id}});
    hybrid.rename(snapshot.id,'saved');
    assert.deepEqual(db.prepare('SELECT id FROM written').all().map(row=>row.id),['answer']);
    assert.ok(String(db.prepare('SELECT data FROM conversations').get()!.data).length<1000);
    assert.equal(hybrid.cached(snapshot.id).turns![1].items[0].text,'before after');
    await hybrid.stop();
    hybrid=new HybridSessions(file,dir+'/copies',hooks);
    assert.deepEqual(hybrid.cached(snapshot.id).turns!.map(t=>t.items.map(i=>i.text)),snapshot.turns!.map(t=>t.items.map(i=>i.text)));
  }finally{await hybrid.stop();db.close();await rm(dir,{recursive:true,force:true});}
});

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
    const receipts=f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result');assert.ok(receipts.length<=1);
    await f.app.hybrid.tick();assert.equal(f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result').length,receipts.length);
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

test('unread results enter an active parent as tools and polling consumes results once',async()=>{
  const dir=await mkdtemp('/tmp/viewer-result-delivery-'),f=await fixture(dir);
  try{
    const parent=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    const call=(name:string,args:Obj)=>f.adapter.call('mock/agents',{threadId:parent.id,name,arguments:args});
    const started=await call('spawn_agent',{operationId:'push-child',task:'Return one result'});
    const childId=String((started.result as Obj).threadId);
    await f.adapter.call('turn/start',{threadId:parent.id,input:[{type:'text',text:'hold-tool'}]});
    await until(()=>f.app.hybrid.cached(childId).hybrid?.agent?.deliveryState==='delivered');
    const native=await f.adapter.call('thread/read',{threadId:parent.id,includeTurns:true});
    const turns=(native.thread as Thread).turns!;
    assert.equal(turns.length,1);assert.equal(turns[0].status,'inProgress');
    assert.equal(turns[0].items.filter(i=>i.type==='userMessage').length,1);
    assert.equal(turns[0].items.filter(i=>i.type==='functionCallOutput').length,1);
    await until(()=>f.app.hybrid.cached(parent.id).turns!.some(t=>t.items.some(i=>i.type==='collabAgentToolCall'&&i.tool==='agentResult')));
    const read=await call('wait_agent',{agentId:childId,timeoutMs:0});assert.equal(read.alreadyDelivered,true);assert.equal(read.result,undefined);
    f.app.hybrid.pauseResultWake(parent.id,true);
    const second=await call('spawn_agent',{operationId:'read-child',task:'Return another result'});
    const secondId=String((second.result as Obj).threadId);
    await until(()=>f.app.hybrid.cached(secondId).agentState==='completed');
    const readOnce=await call('wait_agent',{agentId:secondId,timeoutMs:0});assert.ok(readOnce.result);
    f.app.hybrid.pauseResultWake(parent.id,false);await f.app.hybrid.tick();
    assert.equal(f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result').length,1);
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});

test('unread completed revisions retain their own turn when a child continues',async()=>{
  const dir=await mkdtemp('/tmp/viewer-result-queue-'),f=await fixture(dir);
  try{
    const parent=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    const call=(name:string,args:Obj)=>f.adapter.call('mock/agents',{threadId:parent.id,name,arguments:args});
    await f.app.hybrid.selectModel(parent.id,{model:'fake-model',effort:null,mode:'default'});f.app.hybrid.pauseResultWake(parent.id,true);
    const started=await call('spawn_agent',{operationId:'queue-first',task:'First result'});
    const childId=String((started.result as Obj).threadId);
    await until(()=>f.app.hybrid.cached(childId).agentState==='completed');
    const firstTurn=f.app.hybrid.cached(childId).turns!.at(-1)!.id;
    await call('send_input',{agentId:childId,operationId:'queue-second',message:'Second result'});
    await until(()=>f.app.hybrid.cached(childId).hybrid!.agent!.resultRevision===2);
    const first=await call('wait_agent',{agentId:childId,timeoutMs:0});
    assert.equal((first.result as Obj).resultRevision,1);assert.equal((first.result as Obj).turnId,firstTurn);
    const second=await call('wait_agent',{agentId:childId,timeoutMs:0});
    assert.equal((second.result as Obj).resultRevision,2);assert.notEqual((second.result as Obj).turnId,firstTurn);
    assert.equal((await call('wait_agent',{agentId:childId,timeoutMs:0})).alreadyDelivered,true);
    f.app.hybrid.pauseResultWake(parent.id,false);await f.app.hybrid.tick();
    assert.equal(f.app.hybrid.operations(parent.id).filter(r=>r.kind==='child-result').length,0);
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});

test('lost result replies reconcile exact native history without a second delivery',async()=>{
  const dir=await mkdtemp('/tmp/viewer-result-unknown-'),f=await fixture(dir);
  try{
    const parent=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    await f.app.hybrid.selectModel(parent.id,{model:'fake-model',effort:null,mode:'default'});f.app.hybrid.pauseResultWake(parent.id,true);
    const call=(name:string,args:Obj)=>f.adapter.call('mock/agents',{threadId:parent.id,name,arguments:args});
    const children:string[]=[];
    for(let i=0;i<2;i++){
      const started=await call('spawn_agent',{operationId:'batch-'+i,task:'Batch result '+i});
      children.push(String((started.result as Obj).threadId));
    }
    await until(()=>children.every(id=>f.app.hybrid.cached(id).agentState==='completed'));
    const original=f.adapter.call.bind(f.adapter);let sends=0;
    f.adapter.call=async(method,params)=>{
      const result=await original(method,params);
      if(method==='turn/start'&&params?.toolOutput){sends++;throw Error('fixture: response lost after acceptance');}
      return result;
    };
    f.app.hybrid.pauseResultWake(parent.id,false);await f.app.hybrid.tick();
    const receipt=f.app.hybrid.operations(parent.id).find(r=>r.kind==='child-result')!;
    assert.equal(receipt.state,'unknown');assert.equal((receipt.result!.results as Obj[]).length,2);
    // Polling cannot repeat an outcome that the push may already have delivered.
    for(const child of children)assert.equal((await call('wait_agent',{agentId:child,timeoutMs:0})).result,undefined);
    await until(async()=>{await f.app.hybrid.tick();return children.every(id=>f.app.hybrid.cached(id).hybrid!.agent!.deliveryState==='delivered');});
    assert.equal(sends,1);
    assert.equal(f.app.hybrid.operations(parent.id).find(r=>r.id===receipt.id)!.state,'completed');
    const native=await original('thread/read',{threadId:parent.id,includeTurns:true});
    assert.equal((native.thread as Thread).turns!.flatMap(t=>t.items).filter(i=>i.type==='functionCallOutput').length,1);
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});

test('new empty Codex parents and children use creation state until the first turn',async()=>{
  const dir=await mkdtemp('/tmp/viewer-empty-delegation-'),f=await fixture(dir);
  try{
    const original=f.adapter.call.bind(f.adapter),empty=new Set<string>();
    f.adapter.call=async(method,params)=>{
      if(method==='thread/read'&&empty.has(String(params?.threadId)))
        throw Error('fixture: unmaterialized rollout is empty');
      const result=await original(method,params);
      if(method==='thread/start')empty.add(String((result.thread as Thread).id));
      if(method==='turn/start')empty.delete(String(params?.threadId));
      return result;
    };
    const parent=(await f.http('/threads',{cwd:dir+'/project'})).thread;
    const started=await f.adapter.call('mock/agents',{threadId:parent.id,name:'spawn_agent',arguments:{operationId:'empty-parent',task:'Reply once'}});
    const childId=String((started.result as Obj).threadId);
    await until(()=>f.app.hybrid.cached(childId).hybrid?.agent?.deliveryState==='delivered');
    const native=await original('thread/read',{threadId:parent.id,includeTurns:true});
    const items=(native.thread as Thread).turns!.flatMap(t=>t.items);
    assert.equal(items.filter(i=>i.type==='userMessage').length,0);
    assert.equal(items.filter(i=>i.type==='functionCallOutput').length,1);
  }finally{await f.app.stop();await rm(dir,{recursive:true,force:true});}
});
