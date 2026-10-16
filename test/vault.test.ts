import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { VaultAssistant } from '../server/vault.ts';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { object } from '../shared/protocol.ts';
import { desktopClient } from '../obsidian-plugin/client.ts';
test('plugin shares authorized projects with the browser while filesystem roots and authentication stay enforced',async()=>{
 const dir=await mkdtemp('/tmp/vault-server-'),a=dir+'/a',b=dir+'/b';await mkdir(a+'/.obsidian',{recursive:true});await mkdir(b+'/.obsidian',{recursive:true});await writeFile(a+'/note.md','Alpha');await writeFile(b+'/private.md','Other vault');
 const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 let emptyNeedsMetadata=false;
 const call=adapter.call.bind(adapter);adapter.call=async(method,params={})=>{if(emptyNeedsMetadata && method==='thread/read' && params.includeTurns===true)throw new Error('list_turns is not supported yet');if(method==='thread/start')assert.equal(params.dynamicTools,undefined);if(method==='turn/start'){const context=object(params.additionalContext || {});assert.ok(!context['vault:reading']);assert.ok(!String(object(context['vault:environment'] || {}).value).includes('material_read'));}return call(method,params);};
 const opened:string[]=[];
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter,opener:async file=>{opened.push(file.path);}});
 try{
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const browser=(pathname:string,body?:unknown)=>fetch(app.origin+'/api'+pathname,{method:body?'POST':'GET',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  // Simulate desktop pairing without depending on Windows interop in unit tests.
  const v=new VaultAssistant(dir+'/data');v.db.prepare('INSERT INTO vaults VALUES(?,?,?,?,?)').run('v','a',a,'D:\\a','dummy');v.close();
  const crypto=await import('node:crypto');const token='test-plugin-token';
  const state=new VaultAssistant(dir+'/data');state.db.prepare('UPDATE vaults SET tokenHash=? WHERE id=?').run(crypto.createHash('sha256').update(token).digest('hex'),'v');state.close();
  const plugin=(pathname:string,body?:unknown)=>fetch(app.origin+'/api'+pathname,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal((await fetch(app.origin+'/api/threads')).status,401);
  assert.equal((await plugin('/restart',{})).status,403);
  assert.equal((await plugin('/threads',{cwd:b})).status,200);
  const own=await (await plugin('/threads',{cwd:a})).json(),other=await(await browser('/threads',{cwd:b})).json();
  await writeFile(a+'/paper.pdf',Buffer.alloc(300000));await writeFile(a+'/private.md','Same name in the vault');
  const materials:string[]=[];
  const desktop=desktopClient({endpoint:app.origin,token,binding:{id:'v',name:'a',root:a,windowsRoot:'D:\\a'},open:async target=>{materials.push(target);}});
  try{
   await desktop.request('/files/open',{threadId:own.thread.id,target:'paper.pdf#page=3'});
   assert.deepEqual(materials,[a+'/paper.pdf#page=3'],'PDF opening does not depend on a text preview');
   await desktop.request('/files/open',{threadId:other.thread.id,target:'private.md'});
   assert.deepEqual(opened,[b+'/private.md'],'project-relative paths never open a same-named vault file');
   await assert.rejects(desktop.request('/files/open',{threadId:own.thread.id,target:'/etc/passwd'}),/授权目录/);
  }finally{desktop.dispose();}
  assert.equal((await plugin('/threads/'+other.thread.id)).status,200);
  const listed=await(await plugin('/threads')).json();assert.ok(listed.data.some((t:any)=>t.cwd===a));assert.ok(listed.data.some((t:any)=>t.cwd===b));
  assert.equal((await plugin('/files/preview?'+new URLSearchParams({threadId:own.thread.id,target:b+'/private.md'}))).status,200);
  assert.equal((await plugin('/files/preview?'+new URLSearchParams({threadId:own.thread.id,target:'/etc/passwd'}))).status,403);
  assert.equal((await plugin('/threads',{cwd:'/etc'})).status,403);
  assert.equal((await plugin('/directories?'+new URLSearchParams({path:b}))).status,200);
  assert.equal((await plugin('/directories?'+new URLSearchParams({path:'/etc'}))).status,403);
  assert.equal((await plugin('/threads/'+other.thread.id+'/archive',{})).status,200);
  const deletable=await(await plugin('/threads',{cwd:a})).json();emptyNeedsMetadata=true;assert.equal((await plugin('/threads/'+deletable.thread.id+'/archive',{})).status,200);emptyNeedsMetadata=false;
  assert.ok(!(await(await plugin('/threads')).json()).data.some((t:any)=>t.id===deletable.thread.id));
  assert.equal(object((await adapter.call('thread/read',{threadId:deletable.thread.id,includeTurns:true})).thread).id,deletable.thread.id,'native history stays recoverable');
  const running=await(await plugin('/threads',{cwd:a})).json();await plugin('/threads/'+running.thread.id+'/turns',{text:'hold-tool',attachments:[]});assert.equal((await plugin('/threads/'+running.thread.id+'/archive',{})).status,409);
  await plugin('/threads/'+running.thread.id+'/interrupt',{});assert.equal((await plugin('/threads/'+running.thread.id+'/archive',{})).status,200);
  const sent=await plugin('/threads/'+own.thread.id+'/turns',{text:'read',attachments:[]});
  assert.equal(sent.status,200);
  const obsolete=await plugin('/threads/'+own.thread.id+'/turns',{text:'read',vaultContext:{materials:[]}});assert.equal(obsolete.status,400);
  assert.equal((await plugin('/vault/materials?threadId='+own.thread.id)).status,403);
  const pending=await browser('/threads/'+own.thread.id);assert.equal(pending.status,200);
  assert.equal((await browser('/watchdogs')).status,200,'internal tools must retain their own authentication');
  const project=await(await plugin('/threads',{cwd:b})).json();
  const connect=(lastId?:string)=>fetch(app.origin+'/api/events',{headers:{Authorization:'Bearer '+token,...(lastId?{'Last-Event-ID':lastId}:{})},signal:AbortSignal.timeout(5000)});
  const stream=await connect(),reader=stream.body!.getReader();let buffer='';
  const approvalTurn=await browser('/threads/'+project.thread.id+'/turns',{text:'approve project command',attachments:[]});assert.equal(approvalTurn.status,200,await approvalTurn.text());
  while(!buffer.includes('viewer/request')){const chunk=await reader.read();assert.ok(!chunk.done);buffer+=new TextDecoder().decode(chunk.value);}
  const frame=buffer.split('\n\n').find(frame=>frame.includes('"method":"viewer/request"'))!;
  const event=JSON.parse(/^data: (.+)$/m.exec(frame)![1]),lastId=/^id: (.+)$/m.exec(frame)![1];
  assert.equal(event.params.params.threadId,project.thread.id,'project approvals reach the plugin');
  await reader.cancel();
  assert.equal((await plugin('/requests/'+event.params.id,{decision:'accept'})).status,200);
  const replay=(await connect(lastId)).body!.getReader();buffer='';
  try{while(!buffer.includes('viewer/requestResolved')){const chunk=await replay.read();assert.ok(!chunk.done);buffer+=new TextDecoder().decode(chunk.value);}assert.ok(buffer.includes(project.thread.id));}finally{await replay.cancel();}
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
