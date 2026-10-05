import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('running composer can queue or interrupt, preserves failed drafts and fits widescreen',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-steer-ui-');
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    await page.setViewportSize({width:1280,height:900});await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();await page.locator('.folder').filter({hasText:dir}).click();await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#prompt').fill('hold-tool');await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeVisible();await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#prompt').fill('first queued');await page.locator('#prompt').press('Enter');
    await expect(page.locator('#prompt')).toHaveValue('');await expect(page.locator('#send')).toHaveText('排队追加 ↑');
    await expect(page.locator('#queued-inputs')).toContainText('first queued');
    await page.reload();await expect(page.locator('#queued-inputs')).toContainText('first queued');
    await page.screenshot({path:'test-results/steer-queued-desktop.png'});
    await page.setViewportSize({width:1920,height:844});
    await expect(page.locator('#send')).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/steer-queued-widescreen.png'});await page.setViewportSize({width:1280,height:900});
    const id=decodeURIComponent(new URL(page.url()).hash.slice(1));
    let snapshot=await(await page.request.get(app.origin+'/api/threads/'+id)).json();
    expect(snapshot.thread.turns).toHaveLength(1);const turnId=snapshot.thread.turns[0].id;
    await adapter.call('mock/release',{threadId:id,turnId});
    await expect(page.locator('.message.user').filter({hasText:'first queued'})).toHaveCount(1);
    await expect(page.locator('#queued-inputs')).toHaveCount(0);
    await expect(page.locator('#stop')).toBeHidden();
    await page.locator('#prompt').fill('hold-tool');await page.locator('#send').click();await expect(page.locator('#stop')).toBeVisible();
    await page.locator('#prompt').fill('keep if not received');await page.locator('#send').click();await expect(page.locator('#prompt')).toHaveValue('');
    await page.locator('#prompt').fill('second pending');await page.locator('#send').click();await expect(page.locator('#prompt')).toHaveValue('');
    await expect(page.locator('#queued-inputs .queued-input')).toHaveCount(2);
    await expect(page.locator('#send-interrupt')).toBeEnabled();await expect(page.locator('#send-interrupt')).toHaveText('打断并发送全部');
    await page.locator('#prompt').fill('replacement');await page.screenshot({path:'test-results/steer-desktop.png'});
    await page.setViewportSize({width:1920,height:844});await expect(page.locator('#send-interrupt')).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/steer-widescreen.png'});
    await page.route('**/api/threads/*/turns',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'中断未确认，消息未发送'})}));
    await page.locator('#send-interrupt').click();await expect(page.locator('#prompt')).toHaveValue('replacement');await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#queued-inputs .queued-input')).toHaveCount(2);
    await page.unroute('**/api/threads/*/turns');await page.locator('#send-interrupt').click();
    await expect(page.locator('.message.user').filter({hasText:'replacement'})).toHaveCount(1);await expect(page.locator('#stop')).toBeHidden();
    await page.reload();await expect(page.locator('#send')).toBeEnabled();
    // Virtualized history mounts earlier messages when scrolled into view.
    await expect.poll(async () => {
      await page.locator('#conversation').evaluate(el=>{el.scrollTop=0;});
      return page.locator('.message.user').filter({hasText:'first queued'}).count();
    }).toBe(1);
    await page.locator('#conversation').evaluate(el=>{el.scrollTop=el.scrollHeight;});await expect(page.locator('.message.user').filter({hasText:'replacement'})).toHaveCount(1);
    await expect(page.locator('#queued-inputs')).toHaveCount(0);
    const combined = page.locator('.message.user').filter({hasText:'replacement'});
    await expect(combined).toContainText('keep if not received');await expect(combined).toContainText('second pending');
    expect((await combined.innerText()).indexOf('keep if not received')).toBeLessThan((await combined.innerText()).indexOf('second pending'));
    expect((await combined.innerText()).indexOf('second pending')).toBeLessThan((await combined.innerText()).indexOf('replacement'));
    await page.locator('#prompt').fill('hold-tool');await page.locator('#send').click();await expect(page.locator('#stop')).toBeVisible();
    for (const text of ['queue only one', 'queue only two']) {
      await page.locator('#prompt').fill(text);await page.locator('#send').click();await expect(page.locator('#prompt')).toHaveValue('');
    }
    await page.reload();await expect(page.locator('#queued-inputs .queued-input')).toHaveCount(2);
    await expect(page.locator('#prompt')).toHaveValue('');await page.locator('#send-interrupt').click();
    await expect(page.locator('#stop')).toBeHidden();await expect(page.locator('#queued-inputs')).toHaveCount(0);
    await expect(page.locator('.message.user').filter({hasText:'queue only one'})).toContainText('queue only two');
    snapshot=await(await page.request.get(app.origin+'/api/threads/'+id)).json();
    expect(snapshot.thread.turns.map((t:{status:string})=>t.status)).toEqual(['completed','interrupted','completed','interrupted','completed']);
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
