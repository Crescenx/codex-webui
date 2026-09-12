import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('global restart preserves history, unsent text, attachments and other tabs without replay', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/viewer-restart-ui-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_FAKE_STATE: dir + '/state.json' } });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.goto(app.launchUrl);
    const post = (url: string, data: unknown = {}) => page.request.post(app.origin + '/api' + url, { headers: { origin: app.origin }, data });
    const { thread } = await (await post('/threads', { cwd: dir })).json();
    await post(`/threads/${thread.id}/name`, { name: 'Restart test' });
    await post(`/threads/${thread.id}/turns`, { text: 'saved history', attachments: [] });
    await page.goto(app.origin + '/#' + thread.id);
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('.message.assistant')).toContainText('你好');
    await page.locator('#prompt').fill('unsent draft');
    await page.locator('#files').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment contents') });
    await expect(page.locator('#attachments')).toContainText('note.txt');
    const other = await context.newPage();
    await other.goto(app.origin + '/#' + thread.id);
    await expect(other.locator('#send')).toBeEnabled();
    await other.locator('#prompt').fill('other tab draft');
    const pid = adapter.child!.pid;
    // A running task in another conversation must block this global operation.
    const second = await (await post('/threads', { cwd: dir })).json();
    await post(`/threads/${second.thread.id}/name`, { name: 'Other task' });
    await post(`/threads/${second.thread.id}/turns`, { text: 'approve', attachments: [] });
    await page.locator('#restart-backend').click();
    await expect(page.locator('#error')).toContainText(/未结束|正在运行/);
    expect(adapter.child!.pid).toBe(pid);
    await post(`/threads/${second.thread.id}/interrupt`);
    await page.locator('#restart-backend').click();
    await expect(page.locator('#toast')).toHaveText('Codex 后端已重启');
    await expect(page.locator('#connection')).toHaveText('已连接');
    await expect(page.locator('#send')).toBeEnabled();
    expect(adapter.child!.pid).not.toBe(pid);
    await expect(page.locator('#prompt')).toHaveValue('unsent draft');
    await expect(page.locator('#attachments')).toContainText('note.txt');
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(other.locator('#connection')).toHaveText('已连接');
    await expect(other.locator('#prompt')).toHaveValue('other tab draft');
    await expect(other.locator('.message.user')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/restart-desktop.png' });
    await page.setViewportSize({ width: 1920, height: 844 });
    await expect(page.locator('#restart-backend')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/restart-widescreen.png' });
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
