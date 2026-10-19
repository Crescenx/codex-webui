import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {HybridSessions} from '../server/hybrid.ts';
import type {Thread,Settings} from '../shared/protocol.ts';
import type {RuntimeId} from '../shared/runtime.ts';

test('provider switches reuse native sessions and deliver only missing history',async()=>{
  const dir=await mkdtemp('/tmp/viewer-runtime-switch-');
  const native=new Map<string,Thread>();let creations=0;
  native.set('codex-native',{id:'codex-native',cwd:dir,runtimeId:'codex',status:{type:'idle'},turns:[{id:'c1',status:'completed',items:[{id:'c1-answer',type:'agentMessage',text:'original codex answer'}]}]});
  const hooks={load:async(id:string)=>structuredClone(native.get(id)!),create:async(runtime:RuntimeId,cwd:string,settings?:Settings)=>{creations++;const t:Thread={id:'agy:google-native',cwd,runtimeId:runtime,status:{type:'idle'},settings,turns:[]};native.set(t.id,t);return structuredClone(t);},submit:async()=>{throw Error('switch must not execute model');},stop:async()=>{},recover:async()=>{},ready:()=>true,authorize:async(cwd:string)=>cwd,addWorkspace:()=>{}};
  const hybrid=new HybridSessions(dir+'/sessions.sqlite',dir+'/copies',hooks);
  try{
    const g=await hybrid.selectModel('codex-native',{model:'antigravity/model',effort:null,mode:'default'});
    assert.equal(g.id,'agy:google-native');assert.equal(creations,1);
    const first=hybrid.pendingContext(g.id)!;assert.match(first,/original codex answer/);
    hybrid.contextDelivered(g.id,first);
    native.get(g.id)!.turns!.push({id:'g1',status:'completed',items:[{id:'g1-answer',type:'agentMessage',text:'new google answer'}]});
    hybrid.observe(native.get(g.id)!,true);
    const c=await hybrid.selectModel('codex-native',{model:'codex-model',effort:null,mode:'default'});
    assert.equal(c.id,'codex-native');assert.equal(creations,1);
    const delta=hybrid.pendingContext(c.id)!;assert.match(delta,/new google answer/);assert.doesNotMatch(delta,/original codex answer/);
    hybrid.contextDelivered(c.id,delta);
    assert.equal(hybrid.pendingContext(c.id),undefined);
    const again=await hybrid.selectModel(c.id,{model:'antigravity/other-model',effort:null,mode:'default'});
    assert.equal(again.id,g.id);assert.equal(creations,1);assert.equal(hybrid.pendingContext(g.id),undefined);
    assert.equal(hybrid.cached('codex-native').id,'codex-native');
    assert.equal(hybrid.cached('codex-native').runtimeId,'antigravity');
  }finally{await hybrid.stop();await rm(dir,{recursive:true,force:true});}
});

test('unacknowledged context delivery survives restart and is never replayed',async()=>{
 const dir=await mkdtemp('/tmp/viewer-context-ack-');
 const native=new Map<string,Thread>([['c',{id:'c',cwd:dir,runtimeId:'codex',status:{type:'idle'},turns:[{id:'t',status:'completed',items:[{id:'a',type:'agentMessage',text:'history'}]}]}]]);
 const hooks={load:async(id:string)=>structuredClone(native.get(id)!),create:async(runtime:RuntimeId,cwd:string,settings?:Settings)=>{const t:Thread={id:'agy:g',cwd,runtimeId:runtime,status:{type:'idle'},settings,turns:[]};native.set(t.id,t);return structuredClone(t);},submit:async()=>({}),stop:async()=>{},recover:async()=>{},ready:()=>true,authorize:async(cwd:string)=>cwd,addWorkspace:()=>{}};
 let hybrid=new HybridSessions(dir+'/sessions.sqlite',dir+'/copies',hooks);
 let attempts=0;
 try{
  const g=await hybrid.selectModel('c',{model:'antigravity/model',effort:null,mode:'default'});
  await assert.rejects(hybrid.deliverPendingContext(g.id,async()=>{attempts++;throw Error('acknowledgement lost');}),/acknowledgement lost/);
  assert.ok(hybrid.pendingContext(g.id));
  assert.equal(hybrid.uncertain(g.id),true);
  await hybrid.stop();
  hybrid=new HybridSessions(dir+'/sessions.sqlite',dir+'/copies',hooks);
  await assert.rejects(hybrid.deliverPendingContext(g.id,async()=>{attempts++;}),/尚未确认/);
  assert.equal(attempts,1);
  assert.ok(hybrid.pendingContext(g.id));
 }finally{await hybrid.stop();await rm(dir,{recursive:true,force:true});}
});
