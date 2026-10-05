import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

test('calendar editor creates and restores all schedules using the backend timezone', async ({ browser }, testInfo) => {
  const dir = await mkdtemp('/tmp/watchdog-calendar-browser-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  try {
    await page.goto(app.launchUrl); await page.locator('#welcome-new').click(); await page.locator('.folder').filter({ hasText: dir }).click(); await page.locator('#folder-select').click(); await expect(page.locator('#send')).toBeEnabled();
    await page.getByRole('button', { name: '展开 Watchdogs', exact: true }).click();
    const dialog = page.locator('#watchdog-dialog');
    const schedules = [
      { choice: 'daily', name: '每日检查', schedule: { kind: 'daily', everyDays: 1, startDate: '2099-01-01', time: '09:30' }, label: '每天 09:30' },
      { choice: 'days', name: '隔天检查', schedule: { kind: 'daily', everyDays: 2, startDate: '2099-01-01', time: '09:30' }, label: '每 2 天 09:30' },
      { choice: 'weekly', name: '每周整理', schedule: { kind: 'weekly', weekdays: [1, 3, 5], time: '09:30' }, label: '每周一、三、五 09:30' },
      { choice: 'once', name: '单次检查', schedule: { kind: 'once', at: '2099-01-01T09:30' }, label: '单次 2099-01-01 09:30' },
    ];
    for (const item of schedules) {
      await page.getByRole('button', { name: '新建 Watchdog', exact: true }).click();
      await dialog.getByLabel('名称', { exact: true }).fill(item.name);
      await dialog.getByLabel('完整检查指令').fill('watchdog-continue\n按保存的指令检查，目标尚未结束时继续。');
      await dialog.getByLabel('调度方式').selectOption(item.choice);
      if (item.choice === 'once') await dialog.getByLabel('执行日期时间').fill('2099-01-01T09:30');
      else {
        await dialog.getByLabel('执行时刻').fill('09:30');
        if (item.choice === 'weekly') {
          await dialog.getByLabel('周一', { exact: true }).uncheck();
          await dialog.getByRole('button', { name: '保存并启用' }).click();
          await expect(dialog.getByRole('alert')).toContainText('至少选择一个星期');
          for (const weekday of ['周一', '周三', '周五']) await dialog.getByLabel(weekday, { exact: true }).check();
        } else {
          await dialog.getByLabel('开始日期').fill('2099-01-01');
          if (item.choice === 'days') await dialog.getByLabel('间隔天数').fill('2');
        }
      }
      await dialog.getByRole('button', { name: '保存并启用' }).click();
      const card = dialog.locator('.watchdog-card').filter({ hasText: item.name });
      await expect(card).toContainText(item.label);
      const { data, timeZone } = await (await page.request.get(app.origin + '/api/watchdogs')).json();
      const saved = data.find((w: { name: string }) => w.name === item.name);
      expect(saved.schedule).toEqual(item.schedule); expect(saved.intervalMinutes).toBeUndefined();
      await expect(card).toContainText(timeZone);
      if (item.choice !== 'weekly') expect(saved.nextRunAt).toBe(+new Date('2099-01-01T09:30'));
      await card.getByRole('button', { name: '编辑指令' }).click();
      await expect(dialog.getByLabel('调度方式')).toHaveValue(item.choice);
      if (item.choice === 'once') await expect(dialog.getByLabel('执行日期时间')).toHaveValue('2099-01-01T09:30');
      else await expect(dialog.getByLabel('执行时刻')).toHaveValue('09:30');
      if (item.choice === 'weekly') for (const weekday of ['周一', '周三', '周五']) await expect(dialog.getByLabel(weekday, { exact: true })).toBeChecked();
      if (item.choice === 'weekly') {
        await expect(dialog.getByRole('button', { name: '保存并更新' })).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath('watchdog-weekly-editor-1920.png') });
      }
      await dialog.getByRole('button', { name: '关闭 Watchdogs' }).click();
    }
    await page.reload();await page.getByRole('button', { name: '展开 Watchdogs', exact: true }).click(); await expect(page.locator('.watchdog-chip')).toHaveCount(4);
    // The browser uses Los Angeles time, but the appointment and displayed deadline use the server timezone.
    await expect(page.locator('.watchdog-chip').filter({ hasText: '单次检查' }).locator('span').last()).toContainText('09:30');
    await page.screenshot({ path: testInfo.outputPath('watchdog-calendar-rail-1920.png') });
    await page.locator('.watchdog-chip').filter({ hasText: '单次检查' }).click();
    const once = dialog.locator('.watchdog-card').filter({ hasText: '单次检查' });
    await page.screenshot({ path: testInfo.outputPath('watchdog-calendar-cards-1920.png') });
    await once.getByRole('button', { name: '立即检查' }).click(); await expect(once).toContainText('已完成');
    await once.getByRole('button', { name: '启用', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('单次任务已完成');
    await once.getByRole('button', { name: '编辑指令' }).click();
    await dialog.getByLabel('执行日期时间').fill('2000-01-01T09:30');
    await dialog.getByRole('button', { name: '保存并更新' }).click(); await expect(dialog.getByRole('alert')).toContainText('未来时间');
    await dialog.getByLabel('调度方式').selectOption('interval');
    await dialog.getByRole('button', { name: '保存并更新' }).click(); await expect(once).toContainText('每 1 小时');
    await once.getByRole('button', { name: '启用', exact: true }).click(); await expect(once).toContainText('已启用');
    const { data } = await (await page.request.get(app.origin + '/api/watchdogs')).json();
    expect(data.find((w: { name: string }) => w.name === '单次检查').schedule).toBeUndefined();
  } finally { await context.close(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('session watchdog cards, prompt preview, editor recovery and conversation jump',async({page, context}, testInfo)=>{
  const dir=await mkdtemp('/tmp/watchdog-browser-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    await page.setViewportSize({width:1920,height:1080});
    await page.goto(app.launchUrl);await page.locator('#welcome-new').click();await page.locator('.folder').filter({hasText:dir}).click();await page.locator('#folder-select').click();await expect(page.locator('#send')).toBeEnabled();
    const threadId=new URL(page.url()).hash.slice(1);await expect(page.locator('#watchdogs')).toHaveCount(0);
    await page.getByRole('button',{name:'展开 Watchdogs',exact:true}).click();await page.getByRole('button',{name:'新建 Watchdog',exact:true}).click();
    const dialog=page.locator('#watchdog-dialog');await expect(dialog).toBeVisible();
    const prompt = 'watchdog-hold\n检查远端训练任务 job-42 的日志。\n核对最近输出和任务状态。\n不要重复启动任务。\n发现异常时留在对话中说明。\n达到结束条件后停止后续检查。';
    await dialog.getByLabel('名称',{exact:true}).fill('云端训练');await dialog.getByLabel('完整检查指令').fill(prompt);
    await dialog.getByLabel('模型',{exact:true}).selectOption('mock-fast');await dialog.getByLabel('思考强度').selectOption('low');await dialog.getByRole('button',{name:'保存并启用'}).click();
    const card=dialog.locator('.watchdog-card').filter({hasText:'云端训练'});await expect(card).toContainText('已启用');await expect(card).toContainText('每 1 小时');
    await expect(card.getByRole('button',{name:'查看最近执行'})).toBeDisabled();
    await expect(dialog.getByLabel('查看',{exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'＋ 新建',exact:true})).toHaveCount(0);
    await expect(dialog.locator('.watchdog-thread, .watchdog-summary')).toHaveCount(0);
    const preview=card.locator('.watchdog-prompt-preview');await expect(preview).toHaveText(prompt);await expect(preview).toHaveCSS('-webkit-line-clamp','3');
    expect(await preview.evaluate(el=>el.clientHeight)).toBeLessThanOrEqual(65);
    await card.getByText('展开指令',{exact:true}).click();await expect(card.locator('.watchdog-prompt > p')).toHaveText(prompt);await expect(card.locator('.watchdog-prompt > p')).toBeVisible();
    await card.getByText('收起指令',{exact:true}).click();await expect(card.locator('.watchdog-prompt > p')).toBeHidden();
    await page.screenshot({path:testInfo.outputPath('watchdogs-session-1920.png')});
    await dialog.getByRole('button',{name:'关闭 Watchdogs'}).click();await expect(page.locator('.watchdog-chip')).toContainText('云端训练');
    const second=await context.newPage();await second.goto(page.url());await second.getByRole('button', { name: '展开 Watchdogs', exact: true }).click();await expect(second.locator('.watchdog-chip')).toHaveCount(1);
    // A model-created task appears through SSE without reloading the page.
    await adapter.call('mock/watchdog',{threadId,name:'watchdog_create',arguments:{name:'日志监控',prompt:'watchdog-continue',intervalMinutes:30}});await expect(page.locator('.watchdog-chip')).toHaveCount(2);
    await expect(second.locator('.watchdog-chip')).toHaveCount(2);
    await page.locator('.watchdog-chip').first().click();await card.getByRole('button',{name:'编辑指令'}).click();
    await dialog.getByLabel('完整检查指令').fill('watchdog-hold\n保留这份草稿');await page.route('**/api/watchdogs/*',route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'任务已被修改，当前草稿仍保留'})}):route.continue());
    await dialog.getByRole('button',{name:'保存并更新'}).click();await expect(dialog.getByRole('alert')).toContainText('草稿仍保留');await expect(dialog.getByLabel('完整检查指令')).toHaveValue('watchdog-hold\n保留这份草稿');
    await page.unroute('**/api/watchdogs/*');await dialog.getByRole('button',{name:'保存并更新'}).click();await expect(card).toContainText('已启用');
    await card.getByRole('button',{name:'立即检查'}).click();await expect(card).toContainText('运行中');await card.getByRole('button',{name:'暂停',exact:true}).click();await expect(card).toContainText('本轮运行中 · 后续已停止');
    await dialog.getByRole('button',{name:'关闭 Watchdogs'}).click();await expect(page.locator('#stop')).toBeVisible();
    // Reload while the watchdog uses another model: foreground selection must remain intact.
    await page.reload();await expect(page.locator('#model')).toHaveValue('mock');await page.getByRole('button', { name: '展开 Watchdogs', exact: true }).click();
    await page.locator('#model').selectOption('mock-fast');await page.locator('#effort').selectOption('high');
    const snapshot=await(await page.request.get(app.origin+'/api/threads/'+threadId)).json();await adapter.call('mock/release',{threadId,turnId:snapshot.thread.turns.at(-1).id});await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('#model')).toHaveValue('mock-fast');await expect(page.locator('#effort')).toHaveValue('high');
    await page.locator('.watchdog-chip').first().click();await expect(card).toContainText('已暂停');
    await expect(card.getByRole('button',{name:'运行记录'})).toHaveCount(0);
    await card.getByRole('button',{name:'查看最近执行'}).click();await expect(dialog).not.toBeVisible();await expect(page.locator('.target-turn').first()).toBeInViewport();
    await page.locator('.watchdog-chip').first().click();await card.getByRole('button',{name:'启用',exact:true}).click();await expect(card).toContainText('已启用');await card.getByRole('button',{name:'删除',exact:true}).click();await expect(card).toHaveCount(0);
    const {data}=await(await page.request.get(app.origin+'/api/watchdogs')).json();const deleted=data.find((w:{name:string})=>w.name==='云端训练');
    expect(deleted.state).toBe('deleted');expect((await(await page.request.get(app.origin+'/api/watchdogs/'+deleted.id+'/runs')).json()).data).toHaveLength(1);
    await expect(dialog.getByLabel('查看',{exact:true})).toHaveCount(0);
    await dialog.getByRole('button',{name:'关闭 Watchdogs'}).click();await expect(page.locator('.watchdog-chip')).toHaveCount(1);
    await expect(second.locator('.watchdog-chip')).toHaveCount(1);await second.close();
    await page.screenshot({path:testInfo.outputPath('watchdogs-rail-1920.png')});
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('watchdog dialogs stay in their session and ignore stale jump and save responses', async ({ page }) => {
  const dir = await mkdtemp('/tmp/watchdog-dialog-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  let releaseHistory!: () => void, releaseSave!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  try {
    await page.setViewportSize({width:1920,height:1080});
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();
    await page.locator('.folder').filter({ hasText: dir }).click();
    await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();
    const threadId = new URL(page.url()).hash.slice(1);
    const { thread: other } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json();
    await adapter.call('mock/watchdog', { threadId: other.id, name: 'watchdog_create', arguments: { name: '其他会话任务', prompt: '只检查另一个会话', intervalMinutes: 60 } });
    const { watchdog } = await adapter.call('mock/watchdog', { threadId, name: 'watchdog_create', arguments: { name: '默认强度', prompt: 'watchdog-continue', intervalMinutes: 60, effort: null } });
    const taskId = (watchdog as { id: string }).id;
    await page.getByRole('button', { name: '展开 Watchdogs', exact: true }).click();await page.locator('.watchdog-chip').click();
    const dialog = page.locator('#watchdog-dialog');
    const card = dialog.locator('.watchdog-card').filter({ hasText: '默认强度' });
    const create = page.getByRole('button', { name: '新建 Watchdog', exact: true });
    await expect(dialog.locator('.watchdog-card')).toHaveCount(1);await expect(dialog).not.toContainText('其他会话任务');
    await card.getByRole('button', { name: '编辑指令' }).click();
    await expect(dialog.getByLabel('思考强度').locator('option:checked')).toHaveText('默认');
    await dialog.getByLabel('完整检查指令').fill('watchdog-continue\n只修改指令');
    await dialog.getByRole('button', { name: '保存并更新' }).click();
    await expect(card).toBeVisible();
    expect((await (await page.request.get(app.origin + '/api/watchdogs/' + taskId)).json()).watchdog.effort).toBeNull();
    await card.getByRole('button', { name: '立即检查' }).click();
    await expect.poll(async () => (await (await page.request.get(app.origin + '/api/watchdogs/' + taskId + '/runs')).json()).data[0]?.status).toBe('completed');
    await expect(card.getByRole('button', { name: '查看最近执行' })).toBeEnabled();

    let historyEntered!: () => void;
    const historyStarted = new Promise<void>(resolve => { historyEntered = resolve; });
    await page.route('**/api/watchdogs/*/runs?*', async route => { historyEntered(); await historyGate; await route.continue(); });
    await card.getByRole('button', { name: '查看最近执行' }).click();
    await historyStarted;
    // Hash navigation can switch sessions while a modal is open.
    await page.evaluate(id => { location.hash = id; }, other.id);
    await expect(dialog).toBeHidden();await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('.watchdog-chip')).toHaveCount(1);await expect(page.locator('.watchdog-chip')).toContainText('其他会话任务');
    await page.locator('.watchdog-chip').click();
    await expect(create).toBeEnabled();
    const historyDone = page.waitForResponse(response => response.url().includes('/runs?'));
    releaseHistory();
    await historyDone;
    await expect(dialog).toBeVisible();await expect(dialog.locator('.watchdog-card')).toHaveCount(1);await expect(dialog).toContainText('其他会话任务');
    await expect(create).toBeEnabled();
    await page.unroute('**/api/watchdogs/*/runs?*');
    await dialog.getByRole('button', { name: '关闭 Watchdogs' }).click();
    await page.locator(`[data-thread-id="${threadId}"]`).click();await expect(page.locator('#send')).toBeEnabled();await page.locator('.watchdog-chip').click();

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
    await page.locator(`[data-thread-id="${other.id}"]`).click();await expect(page.locator('#send')).toBeEnabled();
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
