import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discussionPrompt } from '../obsidian-plugin/discussion.ts';
import { desktopClient } from '../obsidian-plugin/client.ts';
import { renderMarkdown } from '../web/render.ts';
import { setMaterialHost } from '../web/environment.ts';
test('desktop SSE preserves Unicode line separators across chunks and adjacent events',{timeout:5000},async()=>{
 const text='x'.repeat(7340)+'\u2028后半段\u2029结束',events:unknown[]=[],errors:unknown[]=[];
 const server=createServer((_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const wire='id: one:1\nevent: update\ndata: '+JSON.stringify({method:'item/agentMessage/delta',params:{text}})+'\n\nid: one:2\nevent: update\ndata: '+JSON.stringify({method:'turn/completed',params:{}})+'\n\n';
  res.write(wire.slice(0,7355));setTimeout(()=>res.end(wire.slice(7355)),10);
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=desktopClient({endpoint:'http://127.0.0.1:'+(server.address() as {port:number}).port,token:'test',binding:{id:'v',name:'test',root:'/vault',windowsRoot:'D:\\vault'},open:async()=>{}});
 try{
  await new Promise<void>((resolve,reject)=>client.subscribe((event,id)=>{events.push({event,id});if(events.length===2)resolve();},()=>{},e=>{errors.push(e);reject(e);}));
  assert.deepEqual(errors,[]);assert.deepEqual(events,[{event:{method:'item/agentMessage/delta',params:{text}},id:'one:1'},{event:{method:'turn/completed',params:{}},id:'one:2'}]);
 }finally{client.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('discussion draft identifies the exact source and quotes only the requested selection',()=>{
 const path='论文/中文 [note] & figure #1.md',vault='我的 vault & notes';
 const text=discussionPrompt(vault,path,'这句话。\n第二行');
 const uri=new URL(/\]\((obsidian:[^)]+)\)/.exec(text)![1]);
 assert.equal(uri.searchParams.get('vault'),vault);assert.equal(uri.searchParams.get('file'),path);
 assert.ok(text.includes(JSON.stringify(path)));assert.ok(text.includes('> 这句话。\n> 第二行'));
 assert.ok(!discussionPrompt(vault,path).includes('选区：'));
 assert.ok(!discussionPrompt(vault,path,'  ').includes('选区：'));
});
test('desktop turns pass the editable prompt without implicit reading context',async()=>{
 let received:any;const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=desktopClient({endpoint:'http://127.0.0.1:'+(server.address() as any).port,token:'test',binding:{id:'v',name:'test',root:'/vault',windowsRoot:'D:\\vault'},open:async()=>{}});
 try{const prompt={text:discussionPrompt('test','note.md','选区'),attachments:[]};await client.request('/threads/t/turns',prompt);assert.deepEqual(received,prompt);assert.ok(!('vaultContext' in received));}
 finally{client.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Obsidian source links open files only in the connected vault',()=>{
 setMaterialHost(async()=>{},undefined,'test');
 try{const prompt=discussionPrompt('test','论文/中文 & note.md');assert.match(renderMarkdown(prompt).html,/data-file="论文\/中文 (?:&amp;|&#x26;) note.md"/);assert.doesNotMatch(renderMarkdown(discussionPrompt('other','note.md')).html,/data-file=/);assert.doesNotMatch(renderMarkdown('[unsafe](obsidian://command?id=delete)').html,/data-file=|href=/);}
 finally{setMaterialHost();}
});

test('Obsidian source links retain the vault path when shown in a project conversation',()=>{
 setMaterialHost(async()=>{},undefined,'test','/vault');
 try{
  assert.match(renderMarkdown(discussionPrompt('test','论文/note.md')).html,/data-file="\/vault\/论文\/note.md"/);
  assert.doesNotMatch(renderMarkdown(discussionPrompt('test','../private.md')).html,/data-file=/);
 }finally{setMaterialHost();}
});
