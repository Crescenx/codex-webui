import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AppServer} from '../server/adapter.ts';
import {RuntimeServers} from '../server/runtimes.ts';
import type {Obj} from '../shared/protocol.ts';

class Fake extends AppServer {
  calls:{method:string;params:Obj}[]=[];
  replies:unknown[]=[];
  override async start(){}
  override async call(method:string,params:Obj={}):Promise<Obj>{this.calls.push({method,params});
    if(method==='model/list')return {data:[{model:'model',displayName:'Model',supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'native',cwd:'/workspace',status:{type:'idle'},turns:[]},model:'model',approvalsReviewer:'user'};
    return {};
  }
  override respond(id:unknown,result:Obj){this.replies.push({id,result});}
  override stop(){}
}
test('Google terminal errors expose the model rejection in both history and live events',async()=>{
 const google=new Fake(),adapter=new RuntimeServers(new Fake(),google);
 const turn={id:'failed',status:'failed',items:[],error:{message:'Agent execution terminated due to error.',additionalDetails:null},
   nativeStop:{error:{modelErrorMessage:'FAILED_PRECONDITION (code 400): User location is not supported for the API use.'}}};
 google.call=async()=>({thread:{id:'native',cwd:'/workspace',turns:[turn]}});
 const result=await adapter.call('thread/read',{threadId:'agy:native'});
 const history=((result.thread as Obj).turns as Obj[])[0];
 assert.equal((history.error as Obj).message,turn.nativeStop.error.modelErrorMessage);
 const notices:Obj[]=[];adapter.on('notice',n=>notices.push(n));
 google.emit('notice',{method:'turn/completed',params:{threadId:'native',turn}});
 const live=(notices[0].params as Obj).turn as Obj;
 assert.equal((live.error as Obj).message,turn.nativeStop.error.modelErrorMessage);
});
test('late model and quota successes notify clients and are reusable without another slow read',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 for(const runtime of ['codex','antigravity'] as const){
  const codex=new Fake(),google=new Fake(),slow=runtime==='codex'?codex:google;
  const releases=new Map<string,(value:Obj)=>void>();let reads=0;
  slow.call=async(method)=>{reads++;return new Promise<Obj>(resolve=>releases.set(method,resolve));};
  const adapter=new RuntimeServers(codex,google),notices:Obj[]=[];
  adapter.on('notice',n=>notices.push(n));
  const models=adapter.call('model/list'),quota=adapter.call('account/rateLimits/read');
  await new Promise(setImmediate);t.mock.timers.tick(2000);
  assert.ok(((await models).runtimeErrors as Obj)[runtime]);assert.ok(((await quota).runtimeErrors as Obj)[runtime]);
  releases.get('model/list')!({data:[{model:'late'}],nextCursor:null});
  releases.get('account/rateLimits/read')!({rateLimitsByLimitId:{[runtime==='codex'?'codex':'antigravity-google']:{limitId:runtime}}});
  await new Promise(setImmediate);
  assert.equal(notices.length,2);assert.ok(notices.every(n=>n.method==='viewer/catalogUpdated'));
  const recovered=await adapter.call('model/list'),usage=await adapter.call('account/rateLimits/read');
  assert.deepEqual(recovered.runtimeErrors,{});assert.deepEqual(usage.runtimeErrors,{});
  assert.ok((recovered.data as Obj[]).some(m=>m.model===(runtime==='codex'?'late':'antigravity/late')));
  assert.equal(reads,2);
  slow.emit('offline');slow.call=async()=>{reads++;throw Error('provider offline');};
  assert.ok(((await adapter.call('model/list')).runtimeErrors as Obj)[runtime]);
  assert.equal(reads,3);
 }
});
test('slow catalog providers cannot block healthy results or multiply pending reads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const codex=new Fake(),google=new Fake(),adapter=new RuntimeServers(codex,google);
 let resolve!: (v:Obj)=>void,calls=0;
 google.call=async()=>{calls++;return new Promise<Obj>(r=>{resolve=r;});};
 codex.call=async()=>({data:[{id:'c',updatedAt:1}],nextCursor:null});
 const first=adapter.call('thread/list');
 await new Promise(setImmediate);
 t.mock.timers.tick(2000);
 const partial=await first;
 assert.deepEqual((partial.data as Obj[]).map(v=>v.id),['c']);
 assert.match(String((partial.runtimeErrors as Obj).antigravity),/响应过慢/);
 assert.ok(partial.nextCursor);
 const retry=adapter.call('thread/list',{cursor:partial.nextCursor});
 await new Promise(setImmediate);
 assert.equal(calls,1);
 resolve({data:[{id:'g'}],nextCursor:null});
 const recovered=await retry;
 assert.deepEqual((recovered.data as Obj[]).map(v=>v.id),['agy:g']);
 assert.equal(recovered.nextCursor,null);
 assert.equal(adapter.states().find(r=>r.id==='antigravity')?.error,undefined);
});
test('model and quota reads tolerate a stalled provider, while turn writes keep their acknowledgment',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const slow of ['codex','antigravity'] as const){
  const codex=new Fake(),google=new Fake(),adapter=new RuntimeServers(codex,google);
  const stalled=slow==='codex'?codex:google;
  const release:((v:Obj)=>void)[]=[];
  stalled.call=async()=>new Promise<Obj>(r=>release.push(r));
  const models=adapter.call('model/list'),quota=adapter.call('account/rateLimits/read');
  let finished=false;
  const turn=adapter.call('turn/start',{model:slow==='codex'?'model':'antigravity/model'}).then(()=>{finished=true;});
  await new Promise(setImmediate);
  t.mock.timers.tick(2000);
  assert.equal(((await models).data as Obj[]).length,1);
  assert.ok(((await quota).runtimeErrors as Obj)[slow]);
  assert.equal(finished,false);
  release.forEach(r=>r({}));
  await turn;
 }
});
test('dual app servers qualify identities and preserve request provenance',async()=>{
  const codex=new Fake(),google=new Fake(),adapter=new RuntimeServers(codex,google);
  const models=await adapter.call('model/list');
  assert.deepEqual((models.data as Obj[]).map(m=>m.model),['model','antigravity/model']);
  const started=await adapter.call('thread/start',{cwd:'/workspace',model:'antigravity/model'});
  assert.equal((started.thread as Obj).id,'agy:native');
  assert.equal((started.thread as Obj).runtimeId,'antigravity');
  assert.equal(google.calls.at(-1)?.params.model,'model');
  assert.equal(codex.calls.filter(c=>c.method==='thread/start').length,0);
  const notices:Obj[]=[];adapter.on('notice',n=>notices.push(n));
  google.emit('notice',{method:'native/event',params:{threadId:'native',event:{appStateUpdate:{raw:'diagnostic'}}}});
  assert.equal(notices.length,0);
  google.emit('notice',{method:'thread/tokenUsage/updated',params:{threadId:'native',tokenUsage:{total:{cachedInputTokens:50}}}});
  assert.equal((notices[0].params as Obj).threadId,'agy:native');
  const requests:Obj[]=[];adapter.on('request',r=>requests.push(r));
  google.emit('request',{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'native'}});
  codex.emit('request',{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'native'}});
  assert.notEqual(requests[0].id,requests[1].id);
  adapter.respond(requests[0].id,{decision:'accept'});
  assert.deepEqual(google.replies,[{id:1,result:{decision:'accept'}}]);
  assert.equal(codex.replies.length,0);
  adapter.stop();
});
test('runtime routing never weakens sandbox or silently converts reviewer',async()=>{
  const google=new Fake(),adapter=new RuntimeServers(new Fake(),google);
  const policy={type:'workspaceWrite',writableRoots:['/workspace'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  await adapter.call('turn/start',{threadId:'agy:native',sandboxPolicy:policy,approvalsReviewer:'auto_review',collaborationMode:{mode:'default',settings:{model:'antigravity/model',reasoning_effort:null}},additionalContext:{history:{kind:'application',value:'prior'}},input:[]});
  assert.deepEqual(google.calls.at(-1)?.params.sandboxPolicy,policy);
  assert.equal(google.calls.at(-1)?.params.approvalsReviewer,'auto_review');
  assert.equal(google.calls.at(-1)?.params.threadId,'native');
  assert.equal(((google.calls.at(-1)?.params.collaborationMode as Obj).settings as Obj).model,'model');
  adapter.stop();
});

test('list failures preserve healthy results and failed-provider pagination for recovery',async()=>{
 for(const method of ['thread/list','thread/loaded/list']){
  const codex=new Fake(),google=new Fake(),adapter=new RuntimeServers(codex,google);
  let fail=true;const cursors:unknown[]=[];let codexCalls=0;
  codex.call=async()=>{codexCalls++;return {data:method==='thread/list'?[{id:'c',updatedAt:1}]:['c'],nextCursor:null};};
  google.call=async(_method,p={})=>{cursors.push(p.cursor);if(fail)throw Error('Google cannot start');return {data:method==='thread/list'?[{id:'g',updatedAt:2}]:['g'],nextCursor:null};};
  const first=await adapter.call(method);assert.equal((first.data as unknown[]).length,1);assert.ok(first.nextCursor);
  assert.equal((first.runtimeErrors as Obj).antigravity,'Google cannot start');
  assert.equal(adapter.states().find(r=>r.id==='antigravity')?.error,'Google cannot start');
  const second=await adapter.call(method,{cursor:first.nextCursor});assert.deepEqual(second.data,[]);assert.equal(second.nextCursor,first.nextCursor);
  fail=false;const recovered=await adapter.call(method,{cursor:second.nextCursor});
  assert.equal(method==='thread/list'?(recovered.data as Obj[])[0].id:(recovered.data as string[])[0],'agy:g');
  assert.equal(recovered.nextCursor,null);assert.equal(codexCalls,1);assert.deepEqual(cursors,[null,null,null]);
  assert.equal(adapter.states().find(r=>r.id==='antigravity')?.error,undefined);
 }
});
test('mid-page failure retains the exact provider cursor and does not replay successful pages',async()=>{
 const codex=new Fake(),google=new Fake(),adapter=new RuntimeServers(codex,google);let fail=true;const seen:unknown[]=[];
 codex.call=async()=>{throw Error('Codex down');};
 google.call=async(_m,p={})=>{seen.push(p.cursor);if(p.cursor==='g2'&&fail)throw Error('temporary');return {data:[{id:p.cursor?'last':'first'}],nextCursor:p.cursor?null:'g2'};};
 const first=await adapter.call('thread/list');assert.equal((first.data as Obj[])[0].id,'agy:first');assert.ok((first.runtimeErrors as Obj).codex);
 const failed=await adapter.call('thread/list',{cursor:first.nextCursor});assert.deepEqual(failed.data,[]);assert.equal(failed.nextCursor,first.nextCursor);
 fail=false;const recovered=await adapter.call('thread/list',{cursor:failed.nextCursor});assert.equal((recovered.data as Obj[])[0].id,'agy:last');assert.deepEqual(seen,[null,'g2','g2']);
 assert.match(adapter.states().find(r=>r.id==='codex')?.error||'',/Codex down/);
});

test('quota aggregation preserves Codex and both Antigravity groups independently',async()=>{
 const codex=new Fake(),google=new Fake();
 const c={limitId:'codex',secondary:{usedPercent:27,windowDurationMins:10080}};
 const g={limitId:'antigravity-google',primary:{usedPercent:10,windowDurationMins:300},secondary:{usedPercent:20,windowDurationMins:10080}};
 const e={limitId:'antigravity-external',primary:{usedPercent:30,windowDurationMins:300},secondary:{usedPercent:40,windowDurationMins:10080}};
 codex.call=async()=>({rateLimits:c,rateLimitResetCredits:{availableCount:2}});
 google.call=async()=>({rateLimits:g,rateLimitsByLimitId:{'antigravity-google':g,'antigravity-external':e}});
 const adapter=new RuntimeServers(codex,google);
 const result=await adapter.call('account/rateLimits/read');
 assert.deepEqual(result.rateLimits,c);
 assert.deepEqual(result.rateLimitsByLimitId,{codex:c,'antigravity-google':g,'antigravity-external':e});
 assert.deepEqual(result.rateLimitResetCredits,{availableCount:2});
 google.call=async()=>{throw Error('Google quota down');};
 const partial=await adapter.call('account/rateLimits/read');
 assert.deepEqual(partial.rateLimits,c);
 assert.deepEqual(partial.runtimeErrors,{antigravity:'Google quota down'});
 codex.call=async()=>{throw Error('Codex quota down');};
 google.call=async()=>({rateLimitsByLimitId:{codex:{limitId:'wrong'},'antigravity-google':g}});
 const other=await adapter.call('account/rateLimits/read');
 assert.deepEqual(other.runtimeErrors,{codex:'Codex quota down'});
 assert.deepEqual(other.rateLimitsByLimitId,{'antigravity-google':g});
 const notices:Obj[]=[];adapter.on('notice',n=>notices.push(n.params));
 google.emit('notice',{method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex'},rateLimitResetCredits:{availableCount:99},rateLimitsByLimitId:{'antigravity-google':g,codex:c}}});
 assert.deepEqual(notices[0],{rateLimitsByLimitId:{'antigravity-google':g}});
});

test('Google child identities connect history and live tool items to the same agent tree',async()=>{
 const google=new Fake(),adapter=new RuntimeServers(new Fake(),google);
 const item={id:'call',type:'collabAgentToolCall',senderThreadId:'parent',receiverThreadIds:['child'],agentsStates:{child:{status:'completed'}},prompt:'child is literal text'};
 google.call=async()=>({thread:{id:'child',cwd:'/workspace',readOnly:false,nativeRuntime:'app-core-v1',source:{subAgent:{thread_spawn:{parent_thread_id:'parent'}}},turns:[{id:'turn',items:[item]}]}});
 const r=await adapter.call('thread/read',{threadId:'agy:child'}),t=r.thread as Obj;
 assert.equal(t.parentThreadId,'agy:parent');
 const projected=((t.turns as Obj[])[0].items as Obj[])[0];
 assert.equal(projected.senderThreadId,'agy:parent');assert.deepEqual(projected.receiverThreadIds,['agy:child']);assert.deepEqual(projected.agentsStates,{'agy:child':{status:'completed'}});assert.equal(projected.prompt,'child is literal text');
 const notices:Obj[]=[];adapter.on('notice',n=>notices.push(n.params));
 google.emit('notice',{method:'item/completed',params:{threadId:'parent',item}});
 google.emit('notice',{method:'turn/completed',params:{threadId:'parent',turn:{id:'turn',items:[item]}}});
 assert.deepEqual(notices[0].item,projected);assert.deepEqual(((notices[1].turn as Obj).items as Obj[])[0],projected);
});
