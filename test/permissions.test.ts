import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { permissionMode, permissionPolicy, readPermissionMode, savePermissionMode } from '../server/permissions.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj } from '../shared/protocol.ts';

test('Google open reuses preflight metadata and reads metadata in parallel without fetching native approval defaults',async()=>{
  const dir=await mkdtemp('/tmp/viewer-open-path-');
  const make=()=>new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const codex=make(),google=make(),calls:{runtime:string;method:string}[]=[];
  let active=0,peak=0,warm=false;
  for(const [runtime,adapter] of [['codex',codex],['antigravity',google]] as const){
    const call=adapter.call.bind(adapter);
    adapter.call=async(method,params={})=>{
      calls.push({runtime,method});
      if(warm&&['thread/read','thread/goal/get','config/read'].includes(method)){
        active++;peak=Math.max(peak,active);
        try{await new Promise(resolve=>setTimeout(resolve,20));return await call(method,params);}finally{active--;}
      }
      return call(method,params);
    };
  }
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  try{
    const raw=await google.call('thread/start',{cwd:dir}),id='agy:'+(raw.thread as Obj).id;
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const open=()=>fetch(app.origin+'/api/threads/'+id+'/open',{method:'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:'{}'});
    calls.length=0;assert.equal((await open()).status,200);
    assert.equal(calls.filter(c=>c.method==='thread/read').length,1);
    calls.length=0;warm=true;assert.equal((await open()).status,200);
    assert.equal(calls.filter(c=>c.method==='config/read').length,0);
    assert.ok(calls.every(c=>c.runtime==='antigravity'));
    assert.equal(peak,2);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('permission modes persist per thread, reset explicitly, and reject malformed data', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-permissions-'));
  try {
    assert.equal(await readPermissionMode(dir,'a'),null);
    for(const mode of ['auto','manual','bypass',null] as const) {
      await savePermissionMode(dir,'a',mode);assert.equal(await readPermissionMode(dir,'a'),mode);
      assert.equal(await readPermissionMode(dir,'b'),null);
    }
    for(const value of [undefined,'never',{},true])assert.throws(()=>permissionMode(value));
    await writeFile(path.join(dir,'thread-permissions/a.json'),'{"mode":"invalid"}');
    await assert.rejects(readPermissionMode(dir,'a'));
    assert.deepEqual(permissionPolicy('bypass',dir),{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
    for(const mode of ['auto','manual',null] as const) {
      const p=permissionPolicy(mode,dir);assert.equal(p.approvalPolicy,'on-request');
      assert.equal(p.sandboxPolicy.type,'workspaceWrite');assert.equal(p.sandboxPolicy.networkAccess,false);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

for(const runtime of ['codex','antigravity'] as const)test(runtime+': permissions API authenticates, rejects active changes, and sends each saved mode on subsequent turns', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-permissions-api-'));
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const calls:{method:string;params:Obj}[]=[];const call=adapter.call.bind(adapter);
  adapter.call=async(method,params={})=>{calls.push({method,params});return call(method,params);};
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,...(runtime==='codex'?{adapter}:{adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),antigravity:adapter})});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const request=(route:string,method='GET',data?:unknown)=>fetch(app.origin+'/api'+route,{method,headers:{cookie,origin:app.origin,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const {thread}=await (await request('/threads','POST',{cwd:dir,model:runtime==='codex'?'mock':'antigravity/mock'})).json();
    const route=`/threads/${thread.id}/permissions`;
    assert.equal((await fetch(app.origin+'/api'+route)).status,401);
    assert.equal((await fetch(app.origin+'/api'+route,{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({mode:'bypass'})})).status,403);
    assert.equal((await request(route,'PUT',{mode:'invalid'})).status,400);
    for(const mode of ['bypass','manual','auto',null] as const) {
      const changed=await request(route,'PUT',{mode});assert.equal(changed.status,200,await changed.clone().text());
      assert.equal((await changed.json()).effectiveOn,'nextTurn');
      assert.equal((await (await request(route)).json()).mode,mode);
      assert.equal(await readPermissionMode(dir+'/data',thread.id),mode);
      assert.equal((await request(`/threads/${thread.id}/turns`,'POST',{text:'long-stream',attachments:[]})).status,200);
      const sent=calls.findLast(c=>c.method==='turn/start')!.params;
      assert.equal(sent.approvalPolicy,mode==='bypass'?'never':'on-request');
      assert.equal((sent.sandboxPolicy as Obj).type,mode==='bypass'?'dangerFullAccess':'workspaceWrite');
      assert.equal(sent.approvalsReviewer,mode==='bypass'||mode==='manual'?'user':'auto_review');
      assert.equal((await request(route,'PUT',{mode:'manual'})).status,409);
      assert.equal((await request(`/threads/${thread.id}/interrupt`,'POST',{})).status,200);
    }
    await adapter.call('mock/goal',{threadId:thread.id.replace(/^agy:/,''),objective:'test active goal',status:'active'});
    assert.equal((await request(route,'PUT',{mode:'bypass'})).status,409);
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('legacy Google history opens read-only without resuming or accepting turns',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-legacy-'));
 const google=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const call=google.call.bind(google),calls:string[]=[];
 google.call=async(method,params={})=>{calls.push(method);if(method==='thread/read')return {thread:{id:'old',cwd:dir,readOnly:true,nativeRuntime:'legacy-sdk',status:{type:'idle'},turns:[{id:'old-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'preserved history'}]}]}};return call(method,params);};
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),antigravity:google});
 try{
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const post=(route:string,data:unknown)=>fetch(app.origin+'/api/threads/agy:old/'+route,{method:'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const opened=await post('open',{});assert.equal(opened.status,200);const {thread}=await opened.json();assert.equal(thread.readOnly,true);assert.equal(thread.turns[0].items[0].text,'preserved history');
  const sent=await post('turns',{text:'must not execute',attachments:[]});assert.equal(sent.status,409);assert.match(await sent.text(),/仅供查看/);
  assert.equal(calls.includes('thread/resume'),false);assert.equal(calls.includes('turn/start'),false);
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
