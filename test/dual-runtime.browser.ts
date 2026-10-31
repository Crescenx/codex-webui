import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {serve} from '../server/main.ts';
import {AppServer} from '../server/adapter.ts';
test('Google model controls and native cache usage render in the shared UI',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-google-browser-');
 const make=()=>new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const codex=make(),google=make();
 const googleCall=google.call.bind(google);let quotaFails=false;
 google.call=async(method,params={})=>{
  if(method==='account/rateLimits/read'){
   if(quotaFails)throw Error('Google quota unavailable');
   return {rateLimitsByLimitId:{
    'antigravity-google':{primary:{usedPercent:10,windowDurationMins:300},secondary:{usedPercent:20,windowDurationMins:10080}},
    'antigravity-external':{primary:{usedPercent:30,windowDurationMins:300},secondary:null},
   }};
  }
  const result=await googleCall(method,params);
  if(method==='model/list')return {...result,data:(result.data as {model:string}[]).map(m=>({...m,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'},{reasoningEffort:'high',description:'High'}],defaultReasoningEffort:'high'}))};
  return result;
 };
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
 try{
  await page.goto(app.launchUrl);
  const response=await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir,model:'antigravity/mock'}});
  expect(response.ok()).toBe(true);const {thread}=await response.json();
  await page.goto(app.origin+'/#'+thread.id);
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#model')).toHaveValue('antigravity/mock');
  await expect(page.locator('#effort option[value="high"]')).toHaveCount(1);
  await page.locator('#effort').selectOption('high');
  await expect(page.locator('#mode option[value="plan"]')).toHaveCount(1);
  await page.locator('#mode').selectOption('plan');
  await expect(page.locator('#plan-mode-note')).toContainText('只读');
  await page.locator('#goal-button').click();
  await page.locator('#goal-objective').fill('Plan should not start a goal');
  await expect(page.locator('#goal-save')).toBeDisabled();
  await page.getByRole('button',{name:'关闭 Goal',exact:true}).click();
  await page.locator('#mode').selectOption('default');
  await expect(page.locator('#plan-mode-note')).toHaveCount(0);
  google.emit('notice',{method:'thread/tokenUsage/updated',params:{threadId:thread.nativeSessionId,tokenUsage:{total:{inputTokens:200,cachedInputTokens:150,totalTokens:230},last:{inputTokens:100,cachedInputTokens:80,totalTokens:115},modelContextWindow:null,lastScope:'nativeUsageUpdateDelta'}}});
  await expect(page.locator('.usage-bar')).toContainText('Cache hit 80%');
  await expect(page.locator('.usage-bar')).toContainText('Context left 未提供');
  const reportContext = (tokenUsage: Record<string, unknown>) => google.emit('notice', {
   method: 'thread/tokenUsage/updated', params: { threadId: thread.nativeSessionId, tokenUsage },
  });
  reportContext({total:{totalTokens:2_000_000},last:{inputTokens:25_000,totalTokens:25_000},
   modelContextWindow:100_000,lastScope:'nativeContextWindowEstimate',
   contextWindow:{estimatedTokensUsed:25_000,maxContextTokens:100_000,tokenBreakdown:{},truncationReason:'test'}});
  await expect(page.locator('.usage-bar')).toContainText('Context left 75%');
  reportContext({total:{totalTokens:2_010_000},last:{inputTokens:30_000,cachedInputTokens:24_000,outputTokens:5_000,totalTokens:35_000},
   modelContextWindow:100_000,lastScope:'nativeModelInvocation',
   contextWindow:{estimatedTokensUsed:25_000,maxContextTokens:100_000}});
  await expect(page.locator('.usage-bar')).toContainText('Context left 65%');
  await expect(page.locator('.usage-bar')).toContainText('Cache hit 80%');
  reportContext({total:{totalTokens:2_010_000},last:{totalTokens:10_000},modelContextWindow:null,lastScope:'nativeUsageUpdateDelta'});
  await expect(page.locator('.usage-bar')).toContainText('Context left 未提供');
  await expect(page.locator('.usage-bar')).not.toContainText('Weekly');
  await expect(page.locator('#reset-usage')).toHaveCount(0);
  await page.locator('#refresh-google-usage').click();
  await expect(page.locator('[data-quota-group="google"]')).toContainText('5h 剩余 90%');
  await expect(page.locator('[data-quota-group="google"]')).toContainText('7d 剩余 80%');
  await expect(page.locator('[data-quota-group="external"]')).toContainText('5h 剩余 70%');
  await expect(page.locator('[data-quota-group="external"]')).toContainText('7d 剩余 —');
  const quota=await (await page.request.get(app.origin+'/api/usage')).json();
  expect(quota.weekly.usedPercent).toBe(27);
  expect(quota.antigravity.google.primary.usedPercent).toBe(10);
  quotaFails=true;await page.locator('#refresh-google-usage').click();
  await expect(page.locator('.usage-bar [role="status"]')).toContainText('Google quota unavailable');
  await expect(page.locator('[data-quota-group="google"]')).toContainText('5h 剩余 —');
  quotaFails=false;await page.locator('#refresh-google-usage').click();
  await expect(page.locator('.usage-bar [role="status"]')).toHaveCount(0);
  await page.screenshot({path:'test-results/google-model-cache.png'});
  await page.locator('#prompt').fill('hold-tool');await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeVisible();
  await page.locator('#prompt').fill('Google live queued message');
  await expect(page.locator('#send')).toBeEnabled();await page.locator('#send').click();
  await expect(page.locator('#queued-inputs')).toContainText('Google live queued message');
  const read=await google.call('thread/read',{threadId:thread.nativeSessionId});
  const held=(read.thread as {turns:{id:string;status:string}[]}).turns.find(t=>t.status==='inProgress')!;
  await google.call('mock/release',{threadId:thread.nativeSessionId,turnId:held.id});
  await expect(page.locator('#queued-inputs')).toHaveCount(0);
  const codexResponse=await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir,model:'mock'}});
  expect(codexResponse.ok()).toBe(true);
  await page.goto(app.origin+'/#'+(await codexResponse.json()).thread.id);
  await expect(page.locator('#model')).toHaveValue('mock');
  await expect(page.locator('#reset-usage')).toBeVisible();
  await expect(page.locator('.usage-bar')).toContainText('Weekly left 73%');
  await expect(page.locator('[data-quota-group]')).toHaveCount(0);
  // Quota follows the selected model even before a cross-provider turn is sent.
  await page.locator('#model').selectOption('antigravity/mock');
  await expect(page.locator('[data-quota-group="google"]')).toContainText('5h 剩余 90%');
  await expect(page.locator('#reset-usage')).toHaveCount(0);
  await expect(page.locator('.usage-bar')).not.toContainText('Weekly left');
  await page.locator('#model').selectOption('mock');
  await expect(page.locator('.usage-bar')).toContainText('Weekly left 73%');
  await expect(page.locator('#reset-usage')).toBeVisible();
  await expect(page.locator('[data-quota-group]')).toHaveCount(0);
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('an unavailable Google backend preserves Codex history and offers a recovering retry',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-partial-browser-');
 const codex=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const google=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const original=google.call.bind(google);let fail=true;
 google.call=async(method,p={})=>{if(fail)throw Error('Google fixture unavailable');return original(method,p);};
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
 try{
  const seeded=await codex.call('thread/start',{cwd:dir});const id=(seeded.thread as {id:string}).id;
  await page.goto(app.launchUrl);
  await expect(page.locator('[data-thread-id="'+id+'"]')).toBeVisible();
  await expect(page.locator('#threads [role="alert"]')).toContainText('Antigravity 列表暂不可用');
  await page.locator('#more').click();
  await expect(page.locator('#more')).toHaveText('重试加载');
  await expect(page.locator('[data-thread-id="'+id+'"]')).toHaveCount(1);
  fail=false;const g=await original('thread/start',{cwd:dir});const gid=(g.thread as {id:string}).id;
  await page.locator('#more').click();
  await expect(page.locator('[data-thread-id="agy:'+gid+'"]')).toBeVisible();
  await expect(page.locator('#threads [role="alert"]')).toHaveCount(0);
  await expect(page.locator('[data-thread-id="'+id+'"]')).toHaveCount(1);
  await page.screenshot({path:'test-results/provider-recovery.png'});
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
