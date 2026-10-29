import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('late provider catalogs repair the page automatically and do not warn on a healthy Codex model',async({page})=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-late-catalog-'));
  const fake=()=>new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const codex=fake(),google=fake(),original=google.call.bind(google);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  google.call=async(method,params={})=>{
    if(['model/list','account/rateLimits/read'].includes(method))await gate;
    if(method==='account/rateLimits/read')return {rateLimitsByLimitId:{'antigravity-google':{primary:{usedPercent:10,windowDurationMins:300}}}};
    return original(method,params);
  };
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:codex,antigravity:google});
  try{
    await page.setViewportSize({width:1440,height:900});await page.goto(app.launchUrl);
    const created=await(await page.request.post(app.origin+'/api/threads',{headers:{Origin:app.origin},data:{cwd:dir}})).json();
    const partial=page.waitForResponse(r=>r.url().includes('/api/controls?')&&r.url().includes('section=settings'));
    await page.reload();await page.locator(`[data-thread-id="${created.thread.id}"]`).click();
    const result=await(await partial).json();
    expect(result.errors['models:antigravity']).toContain('响应过慢');
    await expect(page.getByRole('button',{name:'重新加载模型',exact:true})).toHaveCount(0);
    await page.locator('#prompt').fill('keep this draft');await expect(page.locator('#send')).toBeEnabled();
    release();
    await expect(page.locator('#model option[value="antigravity/mock"]')).toHaveCount(1);
    await page.locator('#model').selectOption('antigravity/mock');
    await expect(page.getByRole('button',{name:'重新加载模型',exact:true})).toHaveCount(0);
    await expect(page.locator('#prompt')).toHaveValue('keep this draft');
    await expect(page.locator('#send')).toBeEnabled();
    const googleThread=await(await page.request.post(app.origin+'/api/threads',{headers:{Origin:app.origin},data:{cwd:dir,runtimeId:'antigravity',model:'antigravity/mock'}})).json();
    await page.locator(`[data-thread-id="${googleThread.thread.id}"]`).click();
    await expect(page.locator('[data-quota-group="google"]')).toContainText('90%');
    await expect(page.locator('.usage-bar')).not.toContainText('额度暂不可用');
    await page.locator('#prompt').fill('catalog recovered');
    const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/turns'));
    await page.locator('#send').click();expect((await sent).status()).toBe(200);
  }finally{release();await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('missing model catalog keeps current effort visible and offers recovery', async ({page}) => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-model-recovery-'));
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]})});
  let failed=true;
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.route('**/api/controls?*',async route=>{
      if(failed && new URL(route.request().url()).searchParams.get('section')==='settings') {
        const response=await route.fetch(),data=await response.json();
        await route.fulfill({json:{...data,models:[],errors:{'models:codex':'timeout'}}});
      } else await route.continue();
    });
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();
    await page.getByRole('button',{name:'▱ '+dir,exact:true}).click();await page.locator('#folder-select').click();
    await expect(page.getByRole('button',{name:'重新加载模型',exact:true})).toBeVisible();
    await expect(page.locator('#effort')).toHaveValue('medium');
    await expect(page.locator('#effort option:checked')).toContainText('medium');
    await expect(page.locator('#model option:checked')).not.toContainText('不支持实验上下文');
    failed=false;
    await page.getByRole('button',{name:'重新加载模型',exact:true}).click();
    await expect(page.locator('#model')).toBeEnabled();
    await expect(page.getByRole('button',{name:'重新加载模型',exact:true})).toHaveCount(0);
    await expect(page.locator('#effort')).toHaveValue('medium');
  } finally {await page.unrouteAll({behavior:'wait'});await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('settings are usable while optional controls remain pending', async ({page}) => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-controls-ui-'));
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]})});
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.route('**/api/controls?*',async route=>{
      if(new URL(route.request().url()).searchParams.get('section')==='extras')await blocked;
      await route.continue();
    });
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();
    await page.getByRole('button',{name:'▱ '+dir,exact:true}).click();await page.locator('#folder-select').click();
    await expect(page.locator('#model')).toBeEnabled();
    await page.locator('#model').selectOption('mock-fast');
    await page.locator('#effort').selectOption('high');
    await page.locator('#mode').selectOption('plan');
    await page.locator('#prompt').fill('settings ready');
    await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#skills-button').click();
    await expect(page.locator('#skill-list')).toContainText('正在加载');
    release();await expect(page.locator('.skill-row')).toHaveCount(1);
    await page.getByRole('button',{name:'关闭 Skills',exact:true}).click();
    await expect(page.locator('#model')).toHaveValue('mock-fast');
    await expect(page.locator('#effort')).toHaveValue('high');
    await expect(page.locator('#mode')).toHaveValue('plan');
  } finally { release();await page.unrouteAll({behavior:'wait'});await app.stop();await rm(dir,{recursive:true,force:true}); }
});
