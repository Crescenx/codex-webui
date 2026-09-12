import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

test('watchdog cards, editor conflict recovery, run history and widescreen layout',async({page})=>{
  const dir=await mkdtemp('/tmp/watchdog-browser-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    await page.goto(app.launchUrl);await page.locator('#welcome-new').click();await page.locator('.folder').filter({hasText:dir}).click();await page.locator('#folder-select').click();await expect(page.locator('#send')).toBeEnabled();
    const threadId=new URL(page.url()).hash.slice(1);await page.locator('#watchdogs').click();
    const dialog=page.locator('#watchdog-dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'＋ 新建',exact:true}).click();
    await dialog.getByLabel('名称',{exact:true}).fill('云端训练');await dialog.getByLabel('完整检查指令').fill('watchdog-hold');
    await dialog.getByLabel('模型',{exact:true}).selectOption('mock-fast');await dialog.getByLabel('思考强度').selectOption('low');await dialog.getByRole('button',{name:'保存并启用'}).click();
    const card=dialog.locator('.watchdog-card').filter({hasText:'云端训练'});await expect(card).toContainText('已启用');await expect(card).toContainText('每 1 小时');await expect(card).toContainText('尚未运行');
    await dialog.getByRole('button',{name:'关闭 Watchdogs'}).click();await expect(page.locator('.watchdog-chip')).toContainText('云端训练');
    // A model-created task appears through SSE without reloading the page.
    await adapter.call('mock/watchdog',{threadId,name:'watchdog_create',arguments:{name:'日志监控',prompt:'watchdog-continue',intervalMinutes:30}});await expect(page.locator('.watchdog-chip')).toHaveCount(2);
    await page.locator('.watchdog-chip').first().click();await card.getByRole('button',{name:'编辑指令'}).click();
    await dialog.getByLabel('完整检查指令').fill('watchdog-hold\n保留这份草稿');await page.route('**/api/watchdogs/*',route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'任务已被修改，当前草稿仍保留'})}):route.continue());
    await dialog.getByRole('button',{name:'保存并更新'}).click();await expect(dialog.getByRole('alert')).toContainText('草稿仍保留');await expect(dialog.getByLabel('完整检查指令')).toHaveValue('watchdog-hold\n保留这份草稿');
    await page.unroute('**/api/watchdogs/*');await dialog.getByRole('button',{name:'保存并更新'}).click();await expect(card).toContainText('已启用');
    await card.getByRole('button',{name:'立即检查'}).click();await expect(card).toContainText('运行中');await card.getByRole('button',{name:'暂停',exact:true}).click();await expect(card).toContainText('本轮运行中 · 后续已停止');
    await dialog.getByRole('button',{name:'关闭 Watchdogs'}).click();await expect(page.locator('#stop')).toBeVisible();
    // Reload while the watchdog uses another model: foreground selection must remain intact.
    await page.reload();await expect(page.locator('#model')).toHaveValue('mock');
    await page.locator('#model').selectOption('mock-fast');await page.locator('#effort').selectOption('high');
    const snapshot=await(await page.request.get(app.origin+'/api/threads/'+threadId)).json();await adapter.call('mock/release',{threadId,turnId:snapshot.thread.turns.at(-1).id});await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('#model')).toHaveValue('mock-fast');await expect(page.locator('#effort')).toHaveValue('high');
    await page.locator('.watchdog-chip').first().click();await expect(card).toContainText('已暂停');await expect(card).toContainText('远端检查完成');
    await card.getByRole('button',{name:'运行记录'}).click();await expect(dialog).toContainText('本轮指令快照');await dialog.getByText('本轮指令快照',{exact:true}).click();await expect(dialog.locator('pre')).toContainText('保留这份草稿');await dialog.getByRole('button',{name:'查看对应对话'}).click();await expect(dialog).not.toBeVisible();await expect(page.locator('.target-turn').first()).toBeInViewport();
    await page.locator('.watchdog-chip').first().click();await card.getByRole('button',{name:'启用',exact:true}).click();await expect(card).toContainText('已启用');await card.getByRole('button',{name:'删除',exact:true}).click();await expect(card).toHaveCount(0);
    await dialog.getByLabel('查看',{exact:true}).selectOption('deleted');await expect(card).toContainText('已删除');await card.getByRole('button',{name:'运行记录'}).click();await expect(dialog).toContainText('远端检查完成');
    await page.setViewportSize({width:1920,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/watchdogs-widescreen.png',fullPage:true});
    await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/watchdogs-desktop.png',fullPage:true});
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('watchdog dialog discards stale requests and preserves an explicit default effort', async ({ page }) => {
  const dir = await mkdtemp('/tmp/watchdog-dialog-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  let releaseHistory!: () => void, releaseSave!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  try {
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();
    await page.locator('.folder').filter({ hasText: dir }).click();
    await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();
    const threadId = new URL(page.url()).hash.slice(1);
    const { watchdog } = await adapter.call('mock/watchdog', { threadId, name: 'watchdog_create', arguments: { name: '默认强度', prompt: 'watchdog-continue', intervalMinutes: 60, effort: null } });
    const taskId = (watchdog as { id: string }).id;
    await page.locator('#watchdogs').click();
    const dialog = page.locator('#watchdog-dialog');
    const card = dialog.locator('.watchdog-card').filter({ hasText: '默认强度' });
    const create = dialog.getByRole('button', { name: '＋ 新建', exact: true });
    await card.getByRole('button', { name: '编辑指令' }).click();
    await expect(dialog.getByLabel('思考强度').locator('option:checked')).toHaveText('默认');
    await dialog.getByLabel('完整检查指令').fill('watchdog-continue\n只修改指令');
    await dialog.getByRole('button', { name: '保存并更新' }).click();
    await expect(card).toBeVisible();
    expect((await (await page.request.get(app.origin + '/api/watchdogs/' + taskId)).json()).watchdog.effort).toBeNull();

    let historyEntered!: () => void;
    const historyStarted = new Promise<void>(resolve => { historyEntered = resolve; });
    await page.route('**/api/watchdogs/*/runs?*', async route => { historyEntered(); await historyGate; await route.continue(); });
    await card.getByRole('button', { name: '运行记录' }).click();
    await historyStarted;
    await dialog.getByRole('button', { name: '关闭 Watchdogs' }).click();
    await page.locator('#watchdogs').click();
    await expect(create).toBeEnabled();
    const historyDone = page.waitForResponse(response => response.url().includes('/runs?'));
    releaseHistory();
    await historyDone;
    await expect(create).toBeEnabled();
    await page.unroute('**/api/watchdogs/*/runs?*');

    // A pending save may complete after a different editor is already open.
    let saveEntered!: () => void;
    const saveStarted = new Promise<void>(resolve => { saveEntered = resolve; });
    await page.route('**/api/watchdogs/' + taskId, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      saveEntered();
      await saveGate;
      await route.fulfill({ response });
    });
    await card.getByRole('button', { name: '编辑指令' }).click();
    await dialog.getByRole('button', { name: '保存并更新' }).click();
    await saveStarted;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.locator('#watchdogs').click();
    await create.click();
    await dialog.getByLabel('名称', { exact: true }).fill('保留新草稿');
    const saveDone = page.waitForResponse(response => response.url().endsWith('/watchdogs/' + taskId) && response.request().method() === 'POST');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/watchdogs');
    releaseSave();
    await saveDone;
    await refreshed;
    // The save refreshes the global task list before its completion reaches the panel.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('保留新草稿');
    await expect(dialog.getByRole('button', { name: '保存并启用' })).toBeEnabled();
  } finally {
    releaseHistory(); releaseSave();
    await page.unrouteAll({ behavior: 'wait' });
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
