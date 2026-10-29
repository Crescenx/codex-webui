import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import type { Obj } from '../shared/protocol.ts';
import { serve } from '../server/main.ts';

test('partial runtime model failures reach controls and are not cached as success', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-partial-models-'));
  const fake=()=>new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const adapter=fake(),call=adapter.call.bind(adapter);
  let failed=true;
  t.mock.method(adapter,'call',async(method:string,params:Obj={})=>{
    if(method==='model/list'&&failed)throw Error('catalog timeout');
    return call(method,params);
  });
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter,antigravity:fake()});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const headers={cookie,origin:app.origin,'Content-Type':'application/json'};
    const {thread}=await(await fetch(app.origin+'/api/threads',{method:'POST',headers,body:JSON.stringify({cwd:dir})})).json();
    const url=app.origin+'/api/controls?threadId='+thread.id+'&section=settings';
    const partial=await(await fetch(url,{headers})).json();
    assert.equal(partial.errors['models:codex'],'catalog timeout');
    assert.ok(partial.models.every((m:{model:string})=>m.model.startsWith('antigravity/')));
    failed=false;
    const recovered=await(await fetch(url,{headers})).json();
    assert.ok(recovered.models.some((m:{model:string})=>m.model==='mock'));
    assert.deepEqual(recovered.errors,{});
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('settings bypass blocked skills and MCP, share cached reads, and support explicit refresh', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'viewer-controls-speed-'));
  const adapter = new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app = await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  let release!:()=>void;
  const blocked = new Promise<void>(resolve=>{release=resolve;});
  try {
    const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    const request=(url:string,data?:unknown)=>fetch(app.origin+'/api'+url,{method:data===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    const {thread}=await request('/threads',{cwd:dir});
    const call=adapter.call.bind(adapter),calls:{method:string;params:Obj}[]=[];
    t.mock.method(adapter,'call',async(method:string,params:Obj={})=>{
      calls.push({method,params});
      if(method==='skills/list'||method==='mcpServerStatus/list')await blocked;
      return call(method,params);
    });
    const url='/controls?threadId='+thread.id;
    const extras=request(url+'&section=extras');
    const [first,second]=await Promise.all([request(url+'&section=settings'),request(url+'&section=settings')]);
    assert.equal(first.models.length,2);assert.deepEqual(first.models,second.models);
    assert.equal(calls.filter(c=>c.method==='model/list').length,1);
    assert.equal(calls.filter(c=>c.method==='collaborationMode/list').length,1);
    await request(url+'&section=settings');
    assert.equal(calls.filter(c=>c.method==='model/list').length,1);
    await request(url+'&section=settings&refresh=true');
    assert.equal(calls.filter(c=>c.method==='model/list').length,2);
    release();const extra=await extras;
    assert.equal(extra.skills.length,1);assert.equal(extra.capabilities.references.session,true);
    assert.equal(calls.find(c=>c.method==='skills/list')!.params.forceReload,false);
    await request(url+'&section=extras&refresh=true');
    assert.equal(calls.filter(c=>c.method==='skills/list').at(-1)!.params.forceReload,true);
    const full=await request(url);assert.equal(full.models.length,2);assert.equal(full.skills.length,1);
    t.mock.method(adapter,'call',async(method:string,params:Obj={})=> method==='model/list'
      ? Promise.reject(new Error('catalog timeout')) : call(method,params));
    const partial=await request(url+'&section=settings&refresh=true');
    assert.equal(partial.errors.models,'catalog timeout');
    t.mock.method(adapter,'call',call);
    const recovered=await request(url+'&section=settings');
    assert.equal(recovered.models.length,2,'partial results must not remain cached');
    assert.deepEqual(recovered.errors,{});
  } finally { release();await app.stop();await rm(dir,{recursive:true,force:true}); }
});
