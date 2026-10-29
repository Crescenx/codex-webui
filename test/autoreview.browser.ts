import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {serve} from '../server/main.ts';
import {AppServer} from '../server/adapter.ts';
for(const runtime of ['codex','antigravity'] as const)test(runtime+': persisted default and review failure choices require explicit consent',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-autoreview-ui-');
 const native=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,...(runtime==='codex'?{adapter:native}:{adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),antigravity:native})});
 try{
  await page.goto(app.launchUrl);await page.getByText('更多操作',{exact:true}).click();
  const defaults=page.getByRole('combobox',{name:'默认审批',exact:true});await expect(defaults).toHaveValue('auto');await defaults.selectOption('manual');await expect(defaults).toBeEnabled();
  await page.reload();await page.getByText('更多操作',{exact:true}).click();await expect(defaults).toHaveValue('manual');await defaults.selectOption('auto');await expect(defaults).toBeEnabled();await page.getByText('更多操作',{exact:true}).click();
  const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir,model:runtime==='codex'?'mock':'antigravity/mock'}})).json();
  await page.goto(app.origin+'/#'+thread.id);await expect(page.locator('#approval-mode')).toBeEnabled();
  await page.locator('#prompt').fill('long-stream');await page.locator('#send').click();await expect(page.locator('#approval-mode')).toBeDisabled();await expect(page.locator('#stop')).toBeVisible();await expect(page.locator('#stop')).toBeEnabled();
  const snap=await(await page.request.get(app.origin+'/api/threads/'+thread.id)).json();const turnId=snap.thread.turns.at(-1).id;
  const emit=(reviewId:string)=>native.emit('notice',{method:'item/autoApprovalReview/completed',params:{threadId:thread.id.replace(/^agy:/,''),turnId,reviewId,...(runtime==='codex'?{review:{status:'denied',rationale:'Model is at capacity',riskLevel:null,userAuthorization:null}}:{result:{error:'Model is at capacity'},allowed:false})}});
  emit('review-1');const panel=page.getByRole('region',{name:'自动审批失败处理'});
  await expect(panel).toBeVisible();await expect(panel).toContainText('at capacity');
  expect((await(await page.request.get(app.origin+'/api/threads/'+thread.id+'/permissions')).json()).mode).toBeNull();
  await page.reload();await expect(panel).toBeVisible();await panel.getByRole('button',{name:'保持自动审批'}).click();await expect(panel).toHaveCount(0);await expect(page.locator('#approval-mode')).toBeDisabled();
  emit('review-2');await expect(panel).toBeVisible();await page.locator('#prompt').fill('保留未提交的草稿');
  await page.screenshot({path:'test-results/autoreview-'+runtime+'.png',fullPage:true});
  await panel.getByRole('button',{name:runtime==='codex'?'切换人工审批':'切换 Bypass',exact:true}).click();await expect(panel).toHaveCount(0);
  await expect(page.locator('#approval-mode')).toHaveValue(runtime==='codex'?'manual':'bypass');await expect(page.locator('#approval-mode')).toBeEnabled();await expect(page.locator('#prompt')).toHaveValue('保留未提交的草稿');
  const done=await(await page.request.get(app.origin+'/api/threads/'+thread.id+'?refresh=1')).json();expect(done.thread.turns).toHaveLength(1);expect(done.thread.turns[0].status).toBe('interrupted');
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
