import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { References } from '../server/references.ts';
import { recordEntry, referenceSelectable, referenceText } from '../shared/references.ts';
import type { Thread, Obj } from '../shared/protocol.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

function source(): Thread {return {id:'source',cwd:'/tmp',name:'研究记录',turns:[{id:'turn',status:'completed',items:[
  {id:'user',type:'userMessage',content:[{type:'text',text:'问题正文'},{type:'localImage',path:'/private/image.png'}]},
  {id:'tool',type:'mcpToolCall',tool:'lookup',arguments:{query:'context',token:'private-token'},status:'completed',result:{content:[{type:'text',text:'工具证据'}],_meta:{secret:'private-state'}}},
  {id:'answer',type:'agentMessage',text:'回答正文'},
]}]};}
async function dbTest(run:(db:References,filename:string)=>Promise<void>|void){const dir=await mkdtemp('/tmp/viewer-ref-unit-');const filename=dir+'/references.sqlite';const db=new References(filename);try{await run(db,filename);}finally{db.close();await rm(dir,{recursive:true,force:true});}}

test('snapshots preserve explicit source order, remain immutable, and never expand into hidden tools or files',()=>dbTest(db=>{
  const t=source(),ref=db.create('target',t,'snapshot',[{turnId:'turn',itemId:'answer'},{turnId:'turn',itemId:'user'}]);
  assert.deepEqual(ref.entries?.map(e=>e.itemId),['user','answer']);
  assert.match(referenceText(ref),/未附带实体/);assert.doesNotMatch(referenceText(ref),/private\/image|工具证据/);
  t.turns![0].items[2].text='later edit';assert.equal(db.get('target',ref.id).entries![1].text,'回答正文');
  assert.equal(db.get('target',ref.id).active,false);assert.throws(()=>db.get('other',ref.id),/不属于/);
  const tool=db.create('target',t,'snapshot',[{turnId:'turn',itemId:'tool'}]);assert.match(referenceText(tool),/工具证据/);assert.doesNotMatch(referenceText(tool),/private-token|private-state/);
  assert.deepEqual(db.input('target',[]),[]);
}));
test('unfinished and unknown items are rejected; oversized snapshots are never silently truncated',()=>dbTest(db=>{
  const t=source();t.turns![0].status='inProgress';
  assert.equal(referenceSelectable(t.turns![0].items[0],t.turns![0]),true);
  assert.throws(()=>db.create('target',t,'snapshot',[{turnId:'turn',itemId:'answer'}]),/仍在生成/);
  assert.throws(()=>db.create('target',t,'snapshot',[{turnId:'turn',itemId:'absent'}]),/已变化/);
  t.turns![0].status='completed';t.turns![0].items[2].text='中'.repeat(30000);
  assert.throws(()=>db.create('target',t,'snapshot',[{turnId:'turn',itemId:'answer'}]),/64 KiB/);
  assert.equal(recordEntry({id:'x',type:'agentMessage',text:'Bearer top-secret sk-secret'},t.turns![0]).text,'[redacted] [redacted]');
}));
test('session grants are target-bound, live across queries, frozen across pages, and revocable on cached reads',()=>dbTest(async db=>{
  const t=source(),ref=db.create('target',t,'session');
  const read=async()=>t;
  await assert.rejects(db.tool('target','session_read',{referenceId:ref.id},read),/没有/);
  db.begin('target','send',[ref.id],'read source','hash');db.finish('target','send',{});
  const first=await db.tool('target','session_read',{referenceId:ref.id,mode:'items',limit:1},read) as Obj;
  assert.equal((first.entries as Obj[])[0].itemId,'user');assert.ok(first.nextCursor);
  t.turns![0].items.push({id:'new',type:'agentMessage',text:'后续消息'});
  const continuation=await db.tool('target','session_read',{referenceId:ref.id,mode:'items',cursor:first.nextCursor},read) as Obj;
  assert.deepEqual((continuation.entries as Obj[]).map(e=>e.itemId),['answer']);
  const latest=await db.tool('target','session_search',{referenceId:ref.id,query:'后续'},read) as Obj;
  assert.equal((latest.entries as Obj[])[0].itemId,'new');
  const noTools=await db.tool('target','session_search',{referenceId:ref.id,query:'工具证据'},read) as Obj;assert.deepEqual(noTools.entries,[]);
  const withTools=await db.tool('target','session_search',{referenceId:ref.id,query:'工具证据',includeTools:true},read) as Obj;assert.equal((withTools.entries as Obj[])[0].itemId,'tool');
  await assert.rejects(db.tool('other','session_read',{referenceId:ref.id},read),/不属于/);
  db.revoke('target',ref.id);await assert.rejects(db.tool('target','session_read',{referenceId:ref.id,mode:'items',cursor:first.nextCursor},read),/没有/);
}));
test('long Unicode records round-trip through bounded pages and reauthorize every cursor',()=>dbTest(async db=>{
  const t=source();t.turns![0].items=[{id:'long',type:'agentMessage',text:'😀中文\\\n'.repeat(5000)}];
  const ref=db.create('target',t,'session');db.begin('target','send',[ref.id],'','hash');
  let cursor:unknown, text='', reads=0;
  do {
    const page=await db.tool('target','session_read',{referenceId:ref.id,mode:'items',maxBytes:2048,...(cursor?{cursor}:{})},async()=>{reads++;return t;}) as Obj;
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=2048);
    text+=(page.entries as Obj[]).map(e=>e.text).join('');cursor=page.nextCursor;
  }while(cursor);
  assert.equal(text,t.turns![0].items[0].text);assert.ok(reads>2);
}));
test('delivery failure rolls back only new grants, uncertainty reconciles by native message ID, and receipts are idempotent',()=>dbTest(db=>{
  const ref=db.create('target',source(),'session');db.begin('target','failed',[ref.id],'','f');db.fail('target','failed',false);assert.equal(db.get('target',ref.id).active,false);
  db.begin('target','sent',[ref.id],'context','hash');db.fail('target','sent',true);
  assert.throws(()=>db.previous('target','sent','hash'),/尚未确认/);
  db.reconcile({id:'target',cwd:'/tmp',turns:[{id:'native',status:'completed',items:[{id:'item',type:'userMessage',clientId:'sent'}]}]});
  assert.equal(db.previous('target','sent','hash')?.turnId,'native');assert.throws(()=>db.previous('target','sent','changed'),/不同内容/);
}));

test('HTTP and MCP references work with legacy turns, native identity, revoked grants, and duplicate delivery',async()=>{
  const dir=await mkdtemp('/tmp/viewer-ref-http-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const http=async(p:string,b?:unknown)=>{const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;};
    const idle=async(id:string)=>{for(let i=0;i<100;i++){if((await http(`/threads/${id}?refresh=1`)).thread.status.type==='idle')return;await delay(20);}throw new Error('fixture did not finish');};
    const a=(await http('/threads',{cwd:dir})).thread.id,b=(await http('/threads',{cwd:dir})).thread.id;
    await adapter.call('mock/turn',{threadId:a,turnId:'source-turn',items:source().turns![0].items});
    const capabilities=await http('/controls?threadId='+b);assert.equal(capabilities.capabilities.references.session,true);
    await http(`/threads/${b}/turns`,{text:'legacy message',attachments:[]});await idle(b);
    const {reference}=await http(`/threads/${b}/references`,{kind:'session',sourceThreadId:a});
    await assert.rejects(adapter.call('mock/references',{threadId:b,name:'session_read',arguments:{referenceId:reference.id}}),/没有/);
    const input={text:'inspect',attachments:[],references:[reference.id],clientMessageId:'ref-send'};
    await http(`/threads/${b}/turns`,input);await http(`/threads/${b}/turns`,input);await idle(b);
    const view=await http(`/threads/${b}?refresh=1`);assert.equal(view.thread.turns.length,2);assert.equal(view.thread.referenceMessages[0].id,'ref-send');
    const result=await adapter.call('mock/references',{threadId:b,name:'session_read',arguments:{referenceId:reference.id,mode:'items'}});assert.equal((result.entries as Obj[]).length,2);
    await assert.rejects(adapter.call('mock/references',{threadId:b,noIdentity:true,name:'references_list',arguments:{}}),/会话身份/);
    await http(`/threads/${b}/references/${reference.id}`,{action:'revoke'});
    await assert.rejects(adapter.call('mock/references',{threadId:b,name:'session_read',arguments:{referenceId:reference.id}}),/没有/);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('reference queues validate the entire batch before interrupting and preserve mixed attachment display on flush',async()=>{
  const dir=await mkdtemp('/tmp/viewer-ref-queue-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const native=adapter.call.bind(adapter);let interrupts=0;
  adapter.call=async(method,params={})=>{if(method==='turn/interrupt')interrupts++;return native(method,params);};
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const headers={Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'};
    const request=(p:string,b?:unknown)=>fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers,body:b===undefined?undefined:JSON.stringify(b)});
    const http=async(p:string,b?:unknown)=>{const r=await request(p,b),v=await r.json();assert.equal(r.status,200,v.error);return v;};
    const a=(await http('/threads',{cwd:dir})).thread.id,b=(await http('/threads',{cwd:dir})).thread.id,route=`/threads/${b}`;
    await adapter.call('mock/turn',{threadId:a,turnId:'source',items:[{id:'large',type:'agentMessage',text:'a'.repeat(33000)},{id:'small',type:'agentMessage',text:'small record'}]});
    const create=async(itemId:string)=>(await http(route+'/references',{kind:'snapshot',sourceThreadId:a,selected:[{turnId:'source',itemId}]})).reference;
    const large=await create('large'),another=await create('large'),small=await create('small');
    const {turn}=await http(route+'/turns',{text:'hold-tool',attachments:[]});
    const receipt=await http(route+'/turns',{text:'queued with reference',attachments:[],references:[large.id],clientMessageId:'queued-ref',delivery:'steer',expectedTurnId:turn.id});
    const queued=[{id:receipt.messageId,turnId:turn.id,text:'queued with reference',attachments:[],references:[large.id]}];
    const oversized=await request(route+'/turns',{text:'replacement',attachments:[],references:[another.id],queued,batchId:'too-large',delivery:'flush',expectedTurnId:turn.id});
    assert.equal(oversized.status,413);assert.equal(interrupts,0);
    const upload=await(await fetch(app.origin+'/api/attachments?name=note.txt',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:'attached text'})).json();
    await http(route+'/turns',{text:'replacement',attachments:[upload.id],references:[small.id],queued,batchId:'valid-flush',delivery:'flush',expectedTurnId:turn.id});
    assert.equal(interrupts,1);
    const view=await http(route);const message=view.thread.referenceMessages.find((m:Obj)=>m.id==='valid-flush');
    assert.deepEqual(message.references,[large.id,small.id]);assert.match(message.text,/queued with reference/);assert.match(message.text,/note.txt/);assert.doesNotMatch(message.text,/transcript_snapshot/);
    const item=view.thread.turns.at(-1).items.find((i:Obj)=>i.type==='userMessage');
    assert.equal(item.clientId,'valid-flush');assert.ok(item.content.some((p:Obj)=>String(p.text).includes('small record')));
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
