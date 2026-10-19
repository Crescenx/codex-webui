import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {serve} from '../server/main.ts';
import {AppServer} from '../server/adapter.ts';
import type {Obj} from '../shared/protocol.ts';
class Recording extends AppServer {
  calls:{method:string;params:Obj}[]=[];
  override async call(method:string,params:Obj={}){this.calls.push({method,params:structuredClone(params)});return super.call(method,params);}
}
async function until(check:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await delay(25);}throw Error('fixture did not settle');}
test('Viewer sends, switches back, and delegates through the same model interface',async()=>{
  const dir=await mkdtemp('/tmp/viewer-dual-api-');await mkdir(dir+'/workspace');
  const make=(name:string)=>new Recording({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/'+name+'.json'}});
  const codex=make('codex'),google=make('google');
  const app=await serve({roots:[dir+'/workspace'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(route:string,body?:unknown)=>{const response=await fetch(app.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
  const settings=(model:string)=>({model,effort:null,mode:'default'});
  try{
    assert.ok((await http('/thread-options?cwd='+encodeURIComponent(dir+'/workspace'))).models.some((m:Obj)=>m.model==='antigravity/mock'));
    const parent=(await http('/threads',{cwd:dir+'/workspace',model:'mock'})).thread;
    const send=(text:string,model:string,attachments:string[]=[])=>http('/threads/'+parent.id+'/turns',{text,attachments,settings:settings(model)});
    await send('codex first','mock');
    await until(async()=>((await codex.call('thread/read',{threadId:parent.id})).thread as {status?:{type:string}}).status?.type==='idle');
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2czsAAAAASUVORK5CYII=','base64');
    const upload=await fetch(app.origin+'/api/attachments?name=pixel.png',{method:'POST',headers:{cookie,origin:app.origin,'content-type':'image/png'},body:image});
    assert.equal(upload.status,200);const attachment=await upload.json();
    await send('google second','antigravity/mock',[attachment.id]);
    const native=app.hybrid.native(parent.id);assert.match(native,/^agy:/);
    const input=google.calls.findLast(c=>c.method==='turn/start')!.params;
    assert.match(JSON.stringify(input.additionalContext),/codex first/);
    assert.ok((input.input as Obj[]).some(p=>p.type==='image'&&String(p.url).startsWith('data:image/png;base64,')));
    assert.equal(input.additionalDirectories,undefined);
    await until(async()=>((await google.call('thread/read',{threadId:native.slice(4)})).thread as {status?:{type:string}}).status?.type==='idle');
    const held=await send('hold-tool','antigravity/mock');
    const steered=await http('/threads/'+parent.id+'/turns',{text:'google queued',attachments:[],delivery:'steer',expectedTurnId:held.turn.id});
    assert.equal(google.calls.findLast(c=>c.method==='turn/steer')?.params.threadId,native.slice(4));
    await google.call('mock/release',{threadId:native.slice(4),turnId:google.calls.findLast(c=>c.method==='turn/steer')!.params.expectedTurnId});
    await until(async()=>((await google.call('thread/read',{threadId:native.slice(4)})).thread as {status?:{type:string}}).status?.type==='idle');
    const googleHistory=(await google.call('thread/read',{threadId:native.slice(4)})).thread as {turns:{items:Obj[]}[]};
    assert.equal(googleHistory.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage'&&i.clientId===steered.messageId).length,1);
    await send('codex third','mock');
    assert.equal(app.hybrid.native(parent.id),parent.id);
    assert.equal(google.calls.filter(c=>c.method==='thread/start').length,1);
    const switched=codex.calls.findLast(c=>c.method==='turn/start')!.params;
    assert.match(JSON.stringify(switched.additionalContext),/google second/);
    assert.doesNotMatch(JSON.stringify(switched.additionalContext),/codex first/);
    const child=await http('/threads/'+parent.id+'/agents',{operationId:'google-child',task:'fixture delegation',settings:settings('antigravity/mock'),context:{inherit:true}});
    assert.match(app.hybrid.native(child.operation.result.threadId),/^agy:/);
    assert.equal(google.calls.filter(c=>c.method==='thread/start').length,2);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('Goal activation delivers switched history without an extra user turn in both directions',async()=>{
  const dir=await mkdtemp('/tmp/viewer-goal-switch-');await mkdir(dir+'/workspace');
  const make=(name:string)=>new Recording({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/'+name+'.json'}});
  const codex=make('codex'),google=make('google');
  const app=await serve({roots:[dir+'/workspace'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(route:string,body?:unknown)=>{const response=await fetch(app.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  const settings=(model:string)=>({model,effort:null,mode:'default'});
  try{
    const parent=(await http('/threads',{cwd:dir+'/workspace',model:'mock'})).thread;
    const route='/threads/'+parent.id;
    await http(route+'/turns',{text:'original Codex work',attachments:[]});
    await until(async()=>((await codex.call('thread/read',{threadId:parent.id})).thread as {status?:{type:string}}).status?.type==='idle');
    await http(route+'/goal',{objective:'finish switched task',tokenBudget:1000,settings:settings('antigravity/mock')});
    const native=app.hybrid.native(parent.id);
    const injection=google.calls.findIndex(c=>c.method==='thread/inject_items');
    const activation=google.calls.findIndex(c=>c.method==='thread/goal/set');
    assert.ok(injection>=0&&activation>injection);
    assert.match(JSON.stringify(google.calls[injection].params.items),/original Codex work/);
    assert.equal(google.calls.filter(c=>c.method==='turn/start').length,0,'Goal bootstrap must not create a synthetic paid user turn');
    assert.equal(app.hybrid.pendingContext(native),undefined);
    await http(route+'/goal',{status:'paused'});
    await google.call('mock/goalTurnEnd',{threadId:native.slice(4)});
    await http(route+'/turns',{text:'Google followup result',attachments:[],settings:settings('antigravity/mock')});
    await until(async()=>((await google.call('thread/read',{threadId:native.slice(4)})).thread as {status?:{type:string}}).status?.type==='idle');
    await http(route+'/goal',{objective:'continue back in Codex',settings:settings('mock')});
    const back=codex.calls.findIndex(c=>c.method==='thread/inject_items');
    assert.ok(back>=0&&codex.calls.findIndex(c=>c.method==='thread/goal/set')>back);
    assert.match(JSON.stringify(codex.calls[back].params.items),/Google followup result/);
    assert.equal(app.hybrid.pendingContext(parent.id),undefined);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});


test('a new Google conversation gets an automatic title through its own backend',async()=>{
  const dir=await mkdtemp('/tmp/viewer-google-title-');await mkdir(dir+'/workspace');
  const codex=new Recording({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const google=new Recording({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  codex.fork=()=>{throw Error('Google title cannot fork Codex');};
  const app=await serve({roots:[dir+'/workspace'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const http=async(route:string,body?:unknown)=>{const response=await fetch(app.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  try {
    const {thread}=await http('/threads',{cwd:dir+'/workspace',model:'antigravity/mock'});
    await http('/threads/'+thread.id+'/turns',{text:'编写线性代数补习讲义',attachments:[]});
    await until(async()=>((await http('/threads/'+thread.id)).thread).name==='概括任务目的');
    assert.equal(google.calls.filter(c=>c.method==='thread/start').length,1);
    assert.equal(google.calls.filter(c=>c.method==='thread/name/set').length,1);
    assert.equal(codex.calls.filter(c=>c.method==='thread/name/set').length,0);
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
