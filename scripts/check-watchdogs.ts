import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Watchdog, WatchdogRun } from '../shared/watchdogs.ts';

// Opt-in live acceptance: two model responses, isolated history/config, one local status file.
const root=await mkdtemp('/tmp/viewer-watchdog-live-'),home=path.join(root,'codex');
await mkdir(home,{mode:0o700});
await copyFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'auth.json'),path.join(home,'auth.json'));
await writeFile(path.join(home,'config.toml'),`model = "${process.env.VIEWER_LIVE_MODEL || 'gpt-6-astra'}"\nmodel_reasoning_effort = "low"\napprovals_reviewer = "user"\n`,{mode:0o600});
const statusFile=path.join(root,'status.txt');await writeFile(statusFile,'COMPLETE\n');
const env={...process.env,CODEX_HOME:home};
const previous=new AppServer({cwd:root,env});let app:Awaited<ReturnType<typeof serve>>|undefined;
try {
  const created=await previous.call('thread/start',{cwd:root,sandbox:'workspace-write',approvalPolicy:'on-request'});
  const threadId=(created.thread as {id:string}).id;
  await previous.call('thread/inject_items',{threadId,items:[{type:'message',role:'user',content:[{type:'input_text',text:`This is an isolated acceptance test. The monitored local task has status file ${statusFile}. Reading COMPLETE means the objective has been reached; otherwise ask me for input. Only reading this file is authorized.`}]}]});
  previous.stop();await delay(250);
  const adapter=new AppServer({cwd:root,env});
  app=await serve({roots:[root],dataDir:path.join(root,'data'),runtimeDir:path.join(root,'run'),port:0,adapter,codexHome:home});
  const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  async function http(p:string,b?:unknown) {
    const r=await fetch(app!.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app!.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});
    const result=await r.json();if(!r.ok)throw new Error(result.error);return result;
  }
  async function until<T>(read:()=>Promise<T>,accept:(result:T)=>boolean) {const end=Date.now()+240000;let value:T;do{value=await read();if(accept(value))return value;await delay(500);}while(Date.now()<end);throw new Error('Live watchdog check timed out: '+JSON.stringify(value!));}
  await http('/threads/'+threadId+'/open',{});await http('/threads/'+threadId+'/name',{name:'Isolated watchdog acceptance'});
  await http('/threads/'+threadId+'/turns',{text:'请根据刚才这项任务的上下文，建立一个每小时检查一次的 watchdog。保存完整检查指令供我查看和修改；第一次等一小时后再检查。只有读取那个状态文件的权限，不能修改任何文件。文件内容是 COMPLETE 就结束监控，否则暂停并向我询问。现在请直接创建并启用。',attachments:[]});
  await until(()=>http('/threads/'+threadId),value=>value.thread.turns?.at(-1)?.status==='completed');
  const tasks=(await http('/watchdogs')).data as Watchdog[];assert.equal(tasks.length,1,JSON.stringify((await http('/threads/'+threadId)).thread.turns?.at(-1)));
  const task=tasks[0];assert.equal(task.threadId,threadId);assert.equal(task.intervalMinutes,60);assert.ok(task.prompt.includes(statusFile));assert.equal(task.running,false);assert.equal(task.lastRunAt,null);
  console.log('PASS: resumed pre-existing native thread discovered the MCP tool and authored a durable scheduled prompt.');
  await http('/watchdogs/'+task.id,{revision:task.revision,action:'run_now'});
  const finished=await until(()=>http('/watchdogs/'+task.id),value=>['completed','needs_input'].includes(value.watchdog.state));
  const runs=(await http('/watchdogs/'+task.id+'/runs')).data as WatchdogRun[];
  assert.equal(finished.watchdog.state,'completed',JSON.stringify(runs));assert.equal(runs.length,1);assert.ok(runs[0].turnId);assert.equal(runs[0].report?.outcome,'complete');
  console.log('PASS: scheduled native turn read the local status, reported completion, persisted history and stopped the schedule.');
}finally{previous.stop();await app?.stop();await rm(root,{recursive:true,force:true});}
