import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Watchdogs, watchdogConfig } from '../server/watchdogs.ts';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { watchdogLaunch } from '../server/watchdog-mcp.ts';
import type { Watchdog, WatchdogRun } from '../shared/watchdogs.ts';
import type { Obj, Settings } from '../shared/protocol.ts';

const config={name:'训练监控',prompt:'查看远端任务 job-42 的日志，严重错误时按已授权范围停止并修复。',intervalMinutes:60,model:'mock-fast',effort:'low'};
const foreground:Settings={model:'mock',effort:'medium',mode:'plan'};
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T> {const end=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await delay(40);}while(Date.now()<end);throw new Error('Timed out: '+JSON.stringify(value!));}

test('committed watchdog writes succeed when change notification fails', async t => {
  const dir = await mkdtemp('/tmp/watchdog-notification-');
  const warn = t.mock.method(console, 'warn', () => {});
  const db = new Watchdogs(dir + '/tasks.sqlite', () => { throw new Error('closed SSE client'); });
  try {
    const task = db.create('thread', dir, config);
    assert.equal(db.list().length, 1);
    assert.deepEqual(db.get(task.id), task);
    assert.equal(warn.mock.callCount(), 1);
    assert.throws(() => db.update(task.id, 0, config), /已被修改/);
    assert.deepEqual(db.get(task.id), task);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('per-instance watchdog launch configuration is absent from forked workers', async () => {
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_TEST_BASE: 'preserved' } });
  adapter.configureLaunch(watchdogLaunch('http://127.0.0.1:1/internal/watchdogs', 'test-only-token'));
  const worker = adapter.fork();
  try {
    await Promise.all([adapter.start(), worker.start()]);
    const env = async (a: AppServer) => (await readFile(`/proc/${a.child!.pid}/environ`, 'utf8')).split('\0');
    assert.ok((await env(adapter)).includes('VIEWER_WATCHDOG_TOKEN=test-only-token'));
    assert.ok(adapter.child!.spawnargs.some(arg => arg.includes('mcp_servers.viewer_watchdogs')));
    assert.ok(!(await env(worker)).some(value => value.startsWith('VIEWER_WATCHDOG_TOKEN=')));
    assert.ok(!worker.child!.spawnargs.some(arg => arg.includes('mcp_servers.viewer_watchdogs')));
    assert.ok((await env(worker)).includes('VIEWER_TEST_BASE=preserved'));
  } finally { adapter.stop(); worker.stop(); }
});

test('watchdog schedule claims, anchored coalescing, immutable snapshots and restart history',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-store-');let db=new Watchdogs(dir+'/tasks.sqlite');
  try {
    assert.throws(()=>watchdogConfig({...config,intervalMinutes:0}));assert.throws(()=>watchdogConfig({...config,prompt:''}));
    const a=db.create('thread','/tmp',config,0),b=db.create('thread','/tmp',{...config,name:'第二个'},0);
    assert.deepEqual(db.due(3599999), []);
    assert.deepEqual(db.due(3600000), db.list());
    assert.equal(a.nextRunAt,3600000);assert.equal(db.claim(a.id,foreground,0),undefined);
    const r=db.claim(a.id,foreground,3600000)!;assert.ok(r);assert.equal(db.claim(b.id,foreground,3600000),undefined);
    assert.deepEqual(db.due(3600000).map(w => w.id), [b.id]);
    db.bind(r.id,'turn');db.report(r.id,'thread',{outcome:'continue',summary:'运行正常'});db.finish(r.id,'completed','',4.5*3600000);
    assert.equal(db.get(a.id).nextRunAt,5*3600000);assert.equal(db.get(a.id).state,'enabled');assert.equal(db.runs(a.id)[0].turnId,'turn');
    const second=db.claim(a.id,foreground,5*3600000)!;
    const edited=db.update(a.id,a.revision,{...config,prompt:'新指令',intervalMinutes:30},5*3600000);
    assert.throws(()=>db.update(a.id,a.revision,config),/已被修改/);
    db.report(second.id,'thread',{outcome:'complete',summary:'旧指令完成'});db.finish(second.id,'completed','',5*3600000+100);
    assert.equal(db.get(a.id).state,'enabled');assert.equal(db.get(a.id).prompt,'新指令');assert.equal(db.run(second.id).config.prompt,config.prompt);
    db.control(a.id,edited.revision,'pause',6*3600000);assert.equal(db.get(a.id).nextRunAt,null);
    const resumed=db.control(a.id,db.get(a.id).revision,'resume',7*3600000);assert.equal(resumed.nextRunAt,7.5*3600000);
    const immediate=db.control(a.id,resumed.revision,'run_now',8*3600000);assert.equal(immediate.nextRunAt,8*3600000);
    const missing=db.claim(a.id,foreground,8*3600000)!;db.finish(missing.id,'completed');assert.equal(db.get(a.id).state,'needs_input');assert.match(db.get(a.id).lastSummary,/缺少结果报告/);
    const interrupted=db.claim(b.id,foreground,9*3600000)!;db.report(interrupted.id,'thread',{outcome:'complete',summary:'不能覆盖失败'});db.finish(interrupted.id,'failed','native failure');assert.equal(db.run(interrupted.id).status,'failed');
    db.control(a.id,db.get(a.id).revision,'delete');db.close();db=new Watchdogs(dir+'/tasks.sqlite');
    assert.equal(db.get(a.id).state,'deleted');assert.equal(db.runs(a.id).length,3);assert.equal(db.runs(b.id)[0].summary,'native failure');
    assert.deepEqual(db.due(Number.MAX_SAFE_INTEGER), []);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('scheduler uses native MCP thread scope, waits for idle, restores settings and preserves edits during a run',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-http-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
    const {thread:t}=await http('/threads',{cwd:dir});await http('/threads/'+t.id+'/name',{name:'监控会话'});
    const tool=(name:string,args:Obj={},id=t.id)=>adapter.call('mock/watchdog',{threadId:id,name,arguments:args});
    const read=async()=>((await http('/watchdogs')).data as Watchdog[]);
    await http('/threads/'+t.id+'/turns',{text:'hold-tool',attachments:[],settings:foreground});
    const result=await tool('watchdog_create',{name:'上下文监控',prompt:'watchdog-hold',intervalMinutes:60});const a=result.watchdog as Watchdog;
    assert.equal(a.model,foreground.model);assert.equal(a.effort,foreground.effort);assert.ok(a.nextRunAt!>Date.now()+3500000);
    const {watchdog:b}=await http('/watchdogs',{threadId:t.id,...config});
    await http('/watchdogs/'+a.id,{revision:a.revision,action:'run_now'});await http('/watchdogs/'+b.id,{revision:b.revision,action:'run_now'});
    await delay(1150);assert.ok((await read()).every(w=>!w.running));
    const held=await http('/threads/'+t.id);await adapter.call('mock/release',{threadId:t.id,turnId:held.thread.turns[0].id});
    await until(read,rows=>!!rows.find(w=>w.id===a.id)?.running);
    assert.equal((await read()).find(w=>w.id===b.id)?.running,false);
    const runs=async()=>((await http('/watchdogs/'+a.id+'/runs')).data as WatchdogRun[]);
    const run=(await until(runs,rows=>!!rows[0]?.turnId))[0];assert.equal(run.config.prompt,'watchdog-hold');
    await assert.rejects(tool('watchdog_create',{name:'recursive',prompt:'x',intervalMinutes:1}),/不能创建或修改/);
    const liveA=(await read()).find(w=>w.id===a.id)!;
    await http('/watchdogs/'+a.id,{...config,prompt:'改后的检查指令',revision:liveA.revision});
    await adapter.call('mock/release',{threadId:t.id,turnId:run.turnId});
    const completed=await until(read,rows=>rows.find(w=>w.id===b.id)?.state==='completed');
    assert.equal(completed.find(w=>w.id===a.id)?.state,'enabled');assert.equal(completed.find(w=>w.id===a.id)?.prompt,'改后的检查指令');
    const settings=await adapter.call('thread/resume',{threadId:t.id});assert.equal(settings.model,foreground.model);assert.equal(settings.reasoningEffort,foreground.effort);
    const final=await http('/threads/'+t.id);assert.deepEqual(final.thread.settings,foreground);
    const {thread:other}=await http('/threads',{cwd:dir});
    await assert.rejects(tool('watchdog_control',{id:a.id,revision:completed.find(w=>w.id===a.id)!.revision,action:'delete'},other.id),/当前会话/);
    const forbidden=await fetch(app.origin+'/internal/watchdogs',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(forbidden.status,401);
    const csrf=await fetch(app.origin+'/api/watchdogs',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
    const missing=(await http('/watchdogs',{threadId:other.id,...config,prompt:'watchdog-no-report'})).watchdog;
    await http('/watchdogs/'+missing.id,{revision:missing.revision,action:'run_now'});
    await until(read,rows=>rows.find(w=>w.id===missing.id)?.state==='needs_input');
    const stopping=(await http('/watchdogs',{threadId:other.id,...config,prompt:'watchdog-hold'})).watchdog;
    await http('/watchdogs/'+stopping.id,{revision:stopping.revision,action:'run_now'});
    await until(async()=>((await http('/watchdogs/'+stopping.id+'/runs')).data as WatchdogRun[]),rows=>!!rows[0]?.turnId);
    await http('/threads/'+other.id+'/interrupt',{});
    assert.equal((await read()).find(w=>w.id===stopping.id)?.state,'paused');
    assert.equal((await http('/watchdogs/'+stopping.id+'/runs')).data[0].status,'interrupted');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('restart preserves idle schedules and never replays an unfinished native run',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-restart-');
  const launch=()=>serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/native.json'}})});
  let app=await launch(),cookie='';
  const login=async()=>{cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];};
  async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
  try {
    await login();const {thread:a}=await http('/threads',{cwd:dir}),{thread:b}=await http('/threads',{cwd:dir});
    const held=(await http('/watchdogs',{threadId:a.id,...config,prompt:'watchdog-hold'})).watchdog as Watchdog;
    const idle=(await http('/watchdogs',{threadId:b.id,...config})).watchdog as Watchdog;
    await http('/watchdogs/'+held.id,{revision:held.revision,action:'run_now'});
    const runs=async()=>((await http('/watchdogs/'+held.id+'/runs')).data as WatchdogRun[]);
    const run=(await until(runs,rows=>!!rows[0]?.turnId))[0];
    await app.stop();app=await launch();await login();
    const recovered=await until(async()=>(await http('/watchdogs/'+held.id)).watchdog as Watchdog,w=>!w.running);
    assert.equal(recovered.state,'needs_input');assert.equal((await runs())[0].status,'uncertain');assert.equal((await runs())[0].id,run.id);
    assert.equal((await http('/watchdogs/'+idle.id)).watchdog.nextRunAt,idle.nextRunAt);
    await http('/watchdogs/'+idle.id,{revision:idle.revision,action:'run_now'});
    await until(async()=>(await http('/watchdogs/'+idle.id)).watchdog as Watchdog,w=>w.state==='completed');
    const native=await app.adapter.call('thread/read',{threadId:a.id,includeTurns:true});assert.equal((native.thread as {turns:unknown[]}).turns.length,1);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('lost submit acknowledgements reconcile once; unavailable models and pending approvals stay explicit',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-failures-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  let lost:''|'receipt'|'none'='',unavailable=false;const call=adapter.call.bind(adapter);
  adapter.call=async(method,p={})=>{
    if(method==='turn/start' && p.clientUserMessageId && lost) {const mode=lost;lost='';if(mode==='receipt')await call(method,p);throw new Error('Codex request timed out; check state before retrying');}
    const result=await call(method,p);if(method==='model/list' && unavailable)result.data=(result.data as {model:string}[]).filter(m=>m.model!=='mock-fast');return result;
  };
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const result=await r.json();if(!r.ok)throw new Error(result.error);return result;}
    const make=async(prompt:string)=>{const {thread}=await http('/threads',{cwd:dir});return (await http('/watchdogs',{threadId:thread.id,...config,prompt})).watchdog as Watchdog;};
    const run=async(w:Watchdog)=>http('/watchdogs/'+w.id,{revision:w.revision,action:'run_now'});
    const read=async(w:Watchdog)=>(await http('/watchdogs/'+w.id)).watchdog as Watchdog;
    const runs=async(w:Watchdog)=>(await http('/watchdogs/'+w.id+'/runs')).data as WatchdogRun[];
    const accepted=await make('watchdog-hold');lost='receipt';await run(accepted);
    const receipt=(await until(()=>runs(accepted),v=>!!v[0]?.turnId))[0];await delay(1100);assert.equal((await runs(accepted)).length,1);
    await adapter.call('mock/release',{threadId:accepted.threadId,turnId:receipt.turnId});await until(()=>read(accepted),v=>v.state==='completed');
    const unknown=await make('unknown submission');lost='none';await run(unknown);await until(()=>read(unknown),v=>v.state==='needs_input');assert.equal((await runs(unknown))[0].status,'uncertain');
    assert.equal((await http('/threads/'+unknown.threadId)).thread.turns.length,0);
    await http('/watchdogs/'+unknown.id,{revision:(await read(unknown)).revision,action:'run_now'});await until(()=>read(unknown),v=>v.state==='completed');assert.equal((await runs(unknown)).length,2);
    const removed=await make('model gone');unavailable=true;await run(removed);await until(()=>read(removed),v=>v.state==='needs_input');assert.equal((await runs(removed))[0].status,'failed');assert.match((await read(removed)).lastSummary,/模型不在/);unavailable=false;
    const approval=await make('watchdog-approval');await run(approval);
    const pending=await until(()=>http('/threads/'+approval.threadId),v=>v.requests.length===1);assert.equal((await read(approval)).running,true);
    const next=(await http('/watchdogs',{threadId:approval.threadId,...config})).watchdog as Watchdog;await run(next);await delay(1100);assert.equal((await runs(next)).length,0);
    await http('/requests/'+pending.requests[0].id,{decision:'accept'});await until(()=>read(next),v=>v.state==='completed');assert.equal((await read(approval)).state,'completed');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('watchdog completion during a foreground steer is reconciled before the next dispatch', async () => {
  const dir = await mkdtemp('/tmp/watchdog-steer-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter);
  let signalEntered!: () => void, releaseSteer!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseSteer = resolve; });
  adapter.call = async (method, params = {}) => {
    const result = await call(method, params);
    if (method === 'turn/steer') { signalEntered(); await released; }
    return result;
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    async function http(p: string, body?: unknown) {
      const response = await fetch(app.origin + '/api' + p, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    }
    const { thread } = await http('/threads', { cwd: dir });
    await http('/threads/' + thread.id + '/turns', { text: 'hello', attachments: [], settings: foreground });
    await until(() => http('/threads/' + thread.id), r => r.thread.turns.at(-1).status === 'completed');
    const { watchdog: first } = await http('/watchdogs', { threadId: thread.id, ...config, prompt: 'watchdog-hold' });
    const { watchdog: second } = await http('/watchdogs', { threadId: thread.id, ...config });
    await http('/watchdogs/' + first.id, { revision: first.revision, action: 'run_now' });
    const { data: [run] } = await until(() => http('/watchdogs/' + first.id + '/runs'), r => !!r.data[0]?.turnId);
    const steer = http('/threads/' + thread.id + '/turns', { text: '继续检查', attachments: [], delivery: 'steer', expectedTurnId: run.turnId });
    await Promise.race([entered, steer]);
    await http('/watchdogs/' + second.id, { revision: second.revision, action: 'run_now' });
    await adapter.call('mock/release', { threadId: thread.id, turnId: run.turnId });
    await until(() => http('/threads/' + thread.id), r => r.thread.turns.at(-1).status === 'completed');
    assert.equal((await http('/watchdogs/' + first.id)).watchdog.running, true);
    releaseSteer();
    await steer;
    await until(() => http('/watchdogs/' + first.id), r => r.watchdog.state === 'completed' && !r.watchdog.running);
    await until(() => http('/watchdogs/' + second.id), r => r.watchdog.state === 'completed');
    assert.equal((await http('/watchdogs/' + first.id + '/runs')).data.length, 1);
    assert.deepEqual((await http('/threads/' + thread.id)).thread.settings, foreground);
  } finally { releaseSteer(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
