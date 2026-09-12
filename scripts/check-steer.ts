import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { NewThreadOptions, Thread } from '../shared/protocol.ts';

// Opt-in: real model calls and two harmless sleep commands, isolated from user sessions/config.
const dir=await mkdtemp('/tmp/viewer-steer-live-'),home=path.join(dir,'codex'),cwd=path.join(dir,'project');
let app:Awaited<ReturnType<typeof serve>>|undefined;
try {
  await mkdir(home,{mode:0o700});await mkdir(cwd);
  for(const name of ['auth.json','models_cache.json']) {
    await copyFile(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),name),path.join(home,name));
    await chmod(path.join(home,name),0o600);
  }
  await writeFile(path.join(home,'config.toml'),'model_reasoning_effort = "low"\napprovals_reviewer = "auto_review"\n');
  const adapter=new AppServer({cwd,env:{...process.env,CODEX_HOME:home}});
  app=await serve({roots:[cwd],dataDir:dir+'/viewer',runtimeDir:dir+'/run',port:0,adapter,codexHome:home});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(url:string,body?:unknown)=>{
    const response=await fetch(app!.origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app!.origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,200,result.error);return result;
  };
  const options=await http('/thread-options?cwd='+encodeURIComponent(cwd)) as NewThreadOptions;
  const {thread}=await http('/threads',{cwd,model:options.defaultModel});
  const route='/threads/'+thread.id;
  const snapshot=async()=> (await http(route)).thread as Thread;
  const waitFor=async(predicate:(t:Thread)=>boolean)=>{
    const until=Date.now()+120_000;
    while(Date.now()<until) {const t=await snapshot();if(predicate(t))return t;await delay(100);}
    throw new Error('Live steering check timed out');
  };
  const begin=async()=>{
    const result=await http(route+'/turns',{text:'Bounded UI integration test: call exec_command to run only `sleep 8` once, with yield_time_ms 10000. Do not call other tools or access files/network. After it finishes, reply exactly ORIGINAL unless another user message arrives.',attachments:[]});
    await waitFor(t=>!!t.turns?.find(v=>v.id===result.turn.id)?.items.some(i=>i.type==='commandExecution'&&i.status==='inProgress'));
    return result.turn.id as string;
  };
  const first=await begin();
  const receipt=await http(route+'/turns',{delivery:'steer',expectedTurnId:first,text:'When the current sleep finishes, reply exactly VIEWER_STEER_OK.',attachments:[]});
  const accepted=await snapshot();
  console.log({queuedAccepted:true,userMessagesAtAcknowledgement:accepted.turns![0].items.filter(i=>i.type==='userMessage').length,toolStillRunning:accepted.turns![0].items.some(i=>i.type==='commandExecution'&&i.status==='inProgress')});
  const queued=await waitFor(t=>t.turns?.at(-1)?.status==='completed');
  assert.equal(queued.turns!.length,1);assert.equal(queued.turns![0].items.findLast(i=>i.type==='agentMessage')?.text?.trim(),'VIEWER_STEER_OK');
  assert.equal(queued.turns![0].items.filter(i=>i.type==='userMessage').length,2);
  assert.ok(queued.turns![0].items.some(i=>i.type==='userMessage'&&i.clientId===receipt.messageId),'native clientId must confirm the queued receipt');
  console.log('Native steer consumed the queued message in the same turn after the tool.');
  const second=await begin();
  const messages = [];
  for (const text of ['Remember the exact word ORCHARD.', 'Remember the exact word RIVER.', 'When the wait is interrupted, without tools reply with the two words above, in order, separated by one space.']) {
    const receipt = await http(route+'/turns', { delivery: 'steer', expectedTurnId: second, text, attachments: [] });
    messages.push({ id: receipt.messageId, turnId: second, text, attachments: [] });
  }
  const pending = await snapshot();
  assert.ok(messages.every(q => !pending.turns!.flatMap(t => t.items).some(i => i.clientId === q.id)), 'probe must interrupt before the queue is consumed');
  const result=await http(route+'/turns',{delivery:'flush',expectedTurnId:second,text:'',attachments:[],queued:messages,batchId:'viewer-live-flush'});
  assert.notEqual(result.turn.id,second);
  assert.deepEqual(result.handledQueuedIds, messages.map(q => q.id));
  const replaced=await waitFor(t=>t.turns?.at(-1)?.status==='completed');
  assert.equal(replaced.turns!.find(t=>t.id===second)!.status,'interrupted');
  assert.equal(replaced.turns!.at(-1)!.items.findLast(i=>i.type==='agentMessage')?.text?.trim(),'ORCHARD RIVER');
  assert.ok(replaced.turns!.at(-1)!.items.some(i=>i.type==='userMessage'&&i.clientId==='viewer-live-flush'));
  console.log('Native interrupt followed by an empty-draft flush delivered all three queued messages in order, with a batch receipt.');
} finally {await app?.stop();await rm(dir,{recursive:true,force:true});}
