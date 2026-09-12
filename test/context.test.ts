import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { contextKey, contextModels, contextReason } from '../server/context.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Model, Obj } from '../shared/protocol.ts';

test('context capabilities use fresh catalog evidence and account/provider eligibility', async () => {
  const dir=await mkdtemp('/tmp/viewer-capabilities-');
  const models=['supported','unsupported','unknown'].map(model=>({model})) as Model[];
  const cache={fetched_at:new Date().toISOString(),models:[{slug:'supported',supports_experimental_context:true},{slug:'unsupported',supports_experimental_context:false}]};
  try {
    assert.deepEqual((await contextModels(models,dir)).map(m=>m.supportsExperimentalContext),[null,null,null]);
    await writeFile(path.join(dir,'models_cache.json'),JSON.stringify(cache));
    assert.deepEqual((await contextModels(models,dir)).map(m=>m.supportsExperimentalContext),[true,false,null]);
    cache.fetched_at='2000-01-01';await writeFile(path.join(dir,'models_cache.json'),JSON.stringify(cache));
    assert.equal((await contextModels(models,dir))[0].supportsExperimentalContext,null);
    assert.equal((await contextModels([{...models[0],supportsExperimentalContext:false}],dir))[0].supportsExperimentalContext,false);
    const account={account:{type:'chatgpt',planType:'pro'}};
    assert.equal(contextReason(account,{}),'');
    assert.match(contextReason({account:{type:'apiKey'}},{}),/登录/);
    assert.match(contextReason({account:{type:'chatgpt',planType:'free'}},{}),/订阅/);
    assert.match(contextReason(account,{model_provider:'custom'}),/提供方/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('context choice is isolated per thread, validates turns and survives a viewer restart',async()=>{
  const dir=await mkdtemp('/tmp/viewer-context-http-');
  const calls:{method:string;params:Obj}[]=[], saved=new Map<string,Obj>();
  let restarted=false,eligible=true,app:Awaited<ReturnType<typeof serve>>;
  const start=async()=>{
    const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
    const call=adapter.call.bind(adapter);
    adapter.call=async(method,params={})=>{
      calls.push({method,params});
      if(method==='account/read'&&!eligible)return {account:{type:'apiKey'}};
      if(restarted&&['thread/read','thread/resume'].includes(method))return structuredClone(saved.get(String(params.threadId))!);
      const result=await call(method,params);
      if(method==='thread/start')saved.set(String((result.thread as Obj).id),structuredClone(result));
      return result;
    };
    return serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter,codexHome:dir});
  };
  app=await start();let cookie='';
  const login=async()=>{cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];};
  const request=(url:string,body?:unknown)=>fetch(app.origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    await login();
    const options=await(await request('/thread-options?cwd='+encodeURIComponent(dir))).json();
    assert.equal(options.defaultModel,'mock');assert.equal(options.contextReason,'');
    for(const body of [{model:'mock-fast',contextManagement:true},{model:'bogus',contextManagement:true},{model:'mock',contextManagement:'true'},{contextManagement:true}])assert.equal((await request('/threads',{cwd:dir,...body})).status,400);
    assert.equal(calls.filter(c=>c.method==='thread/start').length,0);
    eligible=false;
    assert.equal((await request('/threads',{cwd:dir,model:'mock',contextManagement:true})).status,400);eligible=true;
    const enabled=await(await request('/threads',{cwd:dir,model:'mock',contextManagement:true})).json();
    const ordinary=await(await request('/threads',{cwd:dir,model:'mock-fast',contextManagement:false})).json();
    assert.equal(enabled.thread.contextManagement,true);assert.equal(ordinary.thread.contextManagement,false);
    assert.deepEqual(calls.filter(c=>c.method==='thread/start').map(c=>(c.params.config as Obj)[contextKey]),[true,false]);
    const turnsBefore=calls.filter(c=>c.method==='turn/start').length;
    assert.equal((await request(`/threads/${enabled.thread.id}/turns`,{text:'check',attachments:[],settings:{model:'mock-fast',effort:'medium',mode:'default'}})).status,400);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,turnsBefore);
    assert.equal((await request(`/threads/${enabled.thread.id}/turns`,{text:'check',attachments:[]})).status,200);
    await app.stop();restarted=true;app=await start();await login();
    for(const [thread,choice]of [[enabled.thread,true],[ordinary.thread,false]]as const){
      const response=await request(`/threads/${thread.id}/open`,{});assert.equal(response.status,200);
      assert.equal((await response.json()).thread.contextManagement,choice);
      assert.equal((calls.filter(c=>c.method==='thread/resume').at(-1)!.params.config as Obj)[contextKey],choice);
    }
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
