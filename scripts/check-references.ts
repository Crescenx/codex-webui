import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj, Thread } from '../shared/protocol.ts';

// Three short native model turns. All history and bridge configuration are isolated.
const root=await mkdtemp('/tmp/viewer-references-live-'),home=path.join(root,'codex');
await mkdir(home,{mode:0o700});
await copyFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'auth.json'),path.join(home,'auth.json'));
await writeFile(path.join(home,'config.toml'),`model = "${process.env.VIEWER_LIVE_MODEL || 'gpt-6.1-sol'}"\nmodel_reasoning_effort = "low"\napprovals_reviewer = "user"\n`,{mode:0o600});
const env={...process.env,CODEX_HOME:home},prior=new AppServer({cwd:root,env});
let app:Awaited<ReturnType<typeof serve>>|undefined;
async function completed(adapter:AppServer,id:string) {
  const end=Date.now()+180000;
  while(Date.now()<end){const t=(await adapter.call('thread/read',{threadId:id,includeTurns:true})).thread as Thread;const turn=t.turns?.at(-1);if(turn && turn.status!=='inProgress'){assert.equal(turn.status,'completed',JSON.stringify(turn.error));return t;}await delay(250);}
  throw new Error('Native reference check timed out');
}
try{
  const source=(await prior.call('thread/start',{cwd:root,sandbox:'workspace-write',approvalPolicy:'on-request'})).thread as Thread;
  const target=(await prior.call('thread/start',{cwd:root,sandbox:'workspace-write',approvalPolicy:'on-request'})).thread as Thread;
  await prior.call('turn/start',{threadId:source.id,input:[{type:'text',text:'Isolated reference test. The source fact is: archive code ORCHID-731. Reply only OK. Do not use tools.',text_elements:[]}]});
  await completed(prior,source.id);
  await prior.call('turn/start',{threadId:target.id,input:[{type:'text',text:'Isolated target session. Reply only READY. Do not use tools.',text_elements:[]}]});
  await completed(prior,target.id);
  const priorChild=prior.child!;const priorClosed=new Promise<void>(resolve=>priorChild.once('close',()=>resolve()));prior.stop();await priorClosed;
  const adapter=new AppServer({cwd:root,env});
  const start=async()=>serve({roots:[root],dataDir:path.join(root,'data'),runtimeDir:path.join(root,'run'),port:0,adapter,codexHome:home});
  app=await start();
  let cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(p:string,b?:unknown)=>{const r=await fetch(app!.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app!.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;};
  await http('/threads/'+target.id+'/open',{});
  const caps=await http('/controls?threadId='+target.id);
  assert.equal(caps.capabilities.references.session,true,JSON.stringify(caps.capabilities));
  console.log('Native MCP discovery and caller identity: passed (resumed existing session)');
  const {reference}=await http(`/threads/${target.id}/references`,{sourceThreadId:source.id,kind:'session'});
  await http(`/threads/${target.id}/turns`,{text:'Use viewer_references session_search or session_read on the attached Session to find its archive code. Read the source with the reference tools, then reply with only that code. Do not use shell, filesystem, or other tools.',attachments:[],references:[reference.id],clientMessageId:'native-ref-check'});
  const finished=await completed(adapter,target.id);
  const items=finished.turns!.at(-1)!.items;
  assert.ok(items.some(i=>i.type==='mcpToolCall' && i.server==='viewer_references' && ['session_read','session_search'].includes(String(i.tool))),'Model must actually call the reference tool');
  assert.match(items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n'),/ORCHID-731/);
  console.log('Native model retrieved source fact through authorized Session: passed');
  const turn=finished.turns!.at(-1)!;
  const {reference:snapshot}=await http(`/threads/${target.id}/references`,{sourceThreadId:source.id,kind:'snapshot',selected:[{turnId:(await completed(adapter,source.id)).turns![0].id,itemId:(await completed(adapter,source.id)).turns![0].items.find(i=>i.type==='userMessage')!.id}]});
  assert.match(JSON.stringify(snapshot.entries),/ORCHID-731/);
  // Restart proves a persisted grant can still be read with a fresh bridge token.
  await app.stop();app=await serve({roots:[root],dataDir:path.join(root,'data'),runtimeDir:path.join(root,'run2'),port:0,adapter:new AppServer({cwd:root,env}),codexHome:home});
  cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  await http('/threads/'+target.id+'/open',{});
  assert.equal((await http('/controls?threadId='+target.id)).capabilities.references.session,true);
  const call=async()=>app!.adapter.call('mcpServer/tool/call',{threadId:target.id,server:'viewer_references',tool:'session_read',arguments:{referenceId:reference.id,mode:'items'}});
  const result=await call();assert.ok(!result.isError);assert.match(JSON.stringify(result),/ORCHID-731/);
  await http(`/threads/${target.id}/references/${reference.id}`,{action:'revoke'});assert.equal((await call()).isError,true);
  console.log('Snapshot, restart persistence, and revocation: passed');
}catch(error){console.error(error instanceof Error?error.message:String(error));throw error;}
finally{const child=prior.child;const ended=child && child.exitCode===null?new Promise<void>(resolve=>child.once('close',()=>resolve())):Promise.resolve();prior.stop();await ended;await app?.stop();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
