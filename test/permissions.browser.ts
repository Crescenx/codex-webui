import { test,expect } from '@playwright/test';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
for(const runtime of ['codex','antigravity'] as const)test(runtime+': approval selector sits beside mode, saves, restores after refresh, and rolls back errors',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-permissions-ui-');
 const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,...(runtime==='codex'?{adapter}:{adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),antigravity:adapter})});
 try {
  await page.goto(app.launchUrl);
  const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir,model:runtime==='codex'?'mock':'antigravity/mock'}})).json();
  await page.goto(app.origin+'/#'+thread.id);
  const select=page.getByRole('combobox',{name:'审批方式'});
  await expect(select).toBeEnabled();
  expect(await select.evaluate(el=>el.closest('label')?.previousElementSibling?.querySelector('select')?.id)).toBe('mode');
  await select.selectOption('manual');await expect(select).toBeEnabled();
  await page.reload();await expect(select).toHaveValue('manual');
  await select.selectOption('bypass');await expect(select).toBeEnabled();await expect(page.locator('.permission-feedback')).toHaveCount(0);
  await page.route('**/permissions',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:409,json:{error:'任务正在执行，请稍后重试'}});else await route.continue();});
  await select.selectOption('auto');await expect(page.getByRole('alert').filter({hasText:'任务正在执行'})).toBeVisible();await expect(select).toHaveValue('bypass');
  await page.unroute('**/permissions');
  await select.selectOption('auto');await expect(select).toBeEnabled();
  await page.locator('#prompt').fill('long-stream');await page.locator('#send').click();await expect(select).toBeDisabled();await page.locator('#stop').click();await expect(select).toBeEnabled();
  await page.screenshot({path:'test-results/permissions-'+runtime+'.png',fullPage:true});
 } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('legacy Google conversation displays history and a read-only notice',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-legacy-ui-');
 const google=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const call=google.call.bind(google);
 google.call=async(method,params={})=>{const result=await call(method,params);if(method==='thread/read'&&result.thread)result.thread={...(result.thread as object),readOnly:true,nativeRuntime:'legacy-sdk',turns:[{id:'history',status:'completed',items:[{id:'answer',type:'agentMessage',text:'保留下来的旧会话内容'}]}]};return result;};
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),antigravity:google});
 try{
  await page.goto(app.launchUrl);
  const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir,model:'antigravity/mock'}})).json();
  await page.goto(app.origin+'/#'+thread.id);
  await expect(page.getByText('旧版 Antigravity 会话仅供查看。请新建会话继续，历史记录已保留。')).toBeVisible();
  await expect(page.getByText('保留下来的旧会话内容')).toBeVisible();
  await expect(page.locator('#composer')).toHaveCount(0);
  await page.screenshot({path:'test-results/app-core-legacy.png',fullPage:true});
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
