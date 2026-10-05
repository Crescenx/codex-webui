import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('default creation and the first send do not wait for options, controls or history', async ({ page }, info) => {
  const dir = await mkdtemp('/tmp/viewer-create-fast-');
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }) });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/threads'), page.goto(app.launchUrl)]);
    page.on('request', request => requests.push(request.method() + ' ' + new URL(request.url()).pathname));
    for (const pattern of ['**/api/thread-options?*', '**/api/controls?*', '**/api/threads']) await page.route(pattern, async route => {
      if (route.request().method() === 'GET') await gate;
      await route.continue();
    });
    await page.locator('#welcome-new').click(); await page.locator('.folder').filter({ hasText: dir }).click();
    await expect(page.locator('#new-model')).toBeDisabled();
    await expect(page.locator('#folder-select')).toHaveText('使用项目默认设置新建');
    const begin = performance.now();
    await page.locator('#folder-select').click();
    await expect(page.locator('#folder-dialog')).not.toBeVisible();
    await expect(page.locator('#send')).toBeEnabled();
    const readyMs = Math.round(performance.now() - begin);
    await expect(page.locator('#model')).toBeDisabled();
    expect(requests.some(r => r.endsWith('/open'))).toBe(false);
    expect(requests.filter(r => r === 'POST /api/threads')).toHaveLength(1);
    await page.locator('#prompt').fill('first message without waiting');
    const sent = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/turns'));
    await page.locator('#send').click(); expect((await sent).status()).toBe(200);
    await info.attach('creation-timing', { body: JSON.stringify({ readyMs, held: ['options', 'controls', 'history'], requests }), contentType: 'application/json' });
    release(); await page.unrouteAll({ behavior: 'wait' });
  } finally { release(); await page.close(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('new sessions link context to model capability and preserve it across navigation',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-context-ui-');
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]})});
  try{
    await page.setViewportSize({width:1280,height:900});await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();await page.locator('.folder').filter({hasText:dir}).click();
    const model=page.locator('#new-model'),context=page.locator('#new-context');
    await expect(model).toHaveValue('mock');await expect(context).toBeEnabled();await expect(context).not.toBeChecked();
    await context.check();await model.selectOption('mock-fast');await expect(context).toBeDisabled();await expect(context).not.toBeChecked();
    await expect(page.locator('#new-context-help')).toContainText('不支持');
    await model.selectOption('mock');await expect(context).not.toBeChecked();await context.check();
    await page.screenshot({path:'test-results/context-new-desktop.png'});
    await page.setViewportSize({width:1920,height:844});await page.locator('#folder-select').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('#folder-select')).toBeInViewport();await page.screenshot({path:'test-results/context-new-widescreen.png'});
    await page.locator('#folder-select').click();await expect(page.locator('#context-state')).toContainText('已开启');
    const experiment=new URL(page.url()).hash;
    await expect(page.locator('#model option[value="mock-fast"]')).toHaveJSProperty('disabled',true);
    await page.locator('#prompt').fill('context check');await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeHidden();await page.reload();await expect(page.locator('#context-state')).toContainText('已开启');
    await page.locator('.project-new').click();
    await expect(page.locator('#folder-path')).toHaveText(dir);
    await expect(page.locator('#folder-native')).toHaveCount(0);
    await expect(page.locator('#folder-location')).toHaveCount(0);
    await expect(page.locator('.folder-navigation')).toHaveCount(0);
    await expect(page.locator('#folders')).toHaveCount(0);
    await expect(model).toHaveValue('mock');await expect(context).toBeEnabled();
    await page.screenshot({path:'test-results/context-project-new-widescreen.png'});
    await expect(context).not.toBeChecked();await model.selectOption('mock-fast');await page.locator('#folder-select').click();
    await expect(page.locator('#model')).toHaveValue('mock-fast');await expect(page.locator('#context-state')).toHaveCount(0);
    await expect(page.locator('#cwd')).toHaveText(dir);
    await page.locator('#new').click();
    await expect(page.locator('#folder-native')).toBeVisible();
    await expect(page.locator('#folder-location')).toBeVisible();
    await page.locator('#folder-dialog button[aria-label="关闭"]').click();
    await page.goto(app.origin+'/'+experiment);await expect(page.locator('#context-state')).toContainText('已开启');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
