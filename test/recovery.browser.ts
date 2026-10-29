import {test,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppServer} from '../server/adapter.ts';
import {serve} from '../server/main.ts';
import type {Obj} from '../shared/protocol.ts';

test('disconnected Antigravity executions remain readable and recover without replaying consumed input',async({page})=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-unknown-recovery-'));
  const fake=()=>new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const codex=fake(),google=fake(),original=google.call.bind(google);
  let status='unknown',revision=15,connected=false,conflict=false,reviewer='user';
  const calls:{method:string;params:Obj}[]=[];
  const history=[{id:'old-turn',status:'failed',error:{message:'Native outcome unknown; input was not replayed'},items:[
    {id:'initial',type:'userMessage',content:[{type:'text',text:'implicit b question'}]},
    {id:'received',type:'userMessage',clientId:'queued-message',content:[{type:'text',text:'Ridge Regression question'}]},
  ]}];
  const thread=(includeTurns=true)=>({id:'native',cwd:dir,name:'Unknown execution',revision,
    status:{type:status==='unknown'?'systemError':status==='running'?'active':'idle'},
    turns:includeTurns?history:[],settings:{model:'mock',effort:'medium',mode:'default'}});
  google.call=async(method,params={})=>{
    await google.start();calls.push({method,params});
    if(method==='thread/list')return {data:[thread(false)],nextCursor:null};
    if(method==='thread/read')return {thread:thread(params.includeTurns!==false)};
    if(method==='thread/resume'){
      if(status==='unknown')throw Error('reconcile unknown execution before resuming');
      return {thread:thread(),model:'mock',reasoningEffort:'medium',approvalsReviewer:reviewer};
    }
    if(method==='thread/reconcile'){
      assert.equal(params.threadId,'native');assert.equal(params.acknowledgeUnknownOutcome,true);
      if(connected)throw Error('unresolved native connection');
      if(conflict){revision++;conflict=false;}
      if(params.expectedRevision!==revision)throw Error('revision conflict');
      status='idle';revision++;return {thread:thread()};
    }
    if(method==='thread/settings/update'){reviewer=String(params.approvalsReviewer);return {};}
    if(method==='thread/goal/get')return {goal:null};
    return original(method,params);
  };
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  const route=app.origin+'/api/threads/agy%3Anative';
  const headers={Origin:app.origin};
  try {
    await page.setViewportSize({width:1440,height:900});await page.goto(app.launchUrl);
    for(let i=0;i<2;i++){
      const opened=await page.request.post(route+'/open',{headers,data:{}});
      assert.equal(opened.status(),200);const snapshot=await opened.json();
      assert.equal(snapshot.uncertain,true);assert.equal(snapshot.thread.executionUncertain,true);
      assert.equal(snapshot.thread.turns[0].items[1].clientId,'queued-message');
    }
    assert.equal(calls.filter(c=>c.method==='thread/resume').length,0);
    assert.equal((await page.request.post(route+'/recover',{headers,data:{}})).status(),400);
    status='running';
    assert.equal((await page.request.post(route+'/recover',{headers,data:{acknowledge:true}})).status(),409);
    assert.equal(calls.filter(c=>c.method==='thread/reconcile').length,0);
    status='unknown';connected=true;
    const blocked=await page.request.post(route+'/recover',{headers,data:{acknowledge:true}});
    assert.match((await blocked.json()).error,/unresolved native connection/);assert.equal(status,'unknown');
    connected=false;conflict=true;
    const stale=await page.request.post(route+'/recover',{headers,data:{acknowledge:true}});
    assert.match((await stale.json()).error,/revision conflict/);assert.equal(status,'unknown');
    await page.evaluate(()=>localStorage.setItem('viewer-queued:agy:native',JSON.stringify([
      {id:'queued-message',turnId:'old-turn',text:'Ridge Regression question',attachments:[],skills:[]},
    ])));
    await page.reload();await page.locator('[data-thread-id="agy:native"]').click();
    await expect(page.locator('#conversation')).toContainText('implicit b question');
    await expect(page.locator('#error')).toHaveText('上一轮执行结果未知，旧消息未重发。');
    await expect(page.locator('#queued-inputs')).toHaveCount(0);
    await page.locator('#prompt').fill('a new question');await expect(page.locator('#send')).toBeDisabled();
    await page.getByRole('button',{name:'确认未知结果并恢复'}).click();
    await expect(page.locator('.runtime-recovery')).toHaveCount(0);
    await expect(page.locator('#send')).toBeEnabled();
    assert.equal(status,'idle');assert.equal(revision,17);
    assert.equal(calls.some(c=>['turn/start','turn/steer'].includes(c.method)),false);
    const restored=await(await page.request.post(route+'/open',{headers,data:{}})).json();
    assert.equal(restored.thread.executionUncertain,false);
    assert.equal(restored.thread.turns[0].status,'failed');
    assert.equal(restored.thread.turns[0].items[1].clientId,'queued-message');
    google.emit('notice',{method:'turn/completed',params:{threadId:'native',turn:{id:'location-error',status:'failed',items:[],
      error:{message:'Agent execution terminated due to error.'},nativeStop:{error:{modelErrorMessage:'FAILED_PRECONDITION (code 400): User location is not supported for the API use.'}}}}});
    await expect(page.locator('#error')).toContainText('User location is not supported for the API use.');
    google.emit('notice',{method:'viewer/nameError',params:{threadId:'native',message:'自动标题生成未完成，暂用首句预览。'}});
    await expect(page.locator('#toast')).toContainText('自动标题生成未完成');
    await expect(page.locator('#error')).toContainText('User location is not supported for the API use.');
    await expect(page.locator('#error')).not.toContainText('自动标题');
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
