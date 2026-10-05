import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('quota reset requires confirmation and preserves one attempt through a lost response and reload', async ({ page, context }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-usage-reset-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter), keys: string[] = [];
  let count = 2, used = 100, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  adapter.call = async (method, params = {}) => {
    if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', secondary: { usedPercent: used, windowDurationMins: 10080 } }, rateLimitResetCredits: { availableCount: count } };
    if (method === 'account/rateLimitResetCredit/consume') {
      keys.push(String(params.idempotencyKey));
      if (keys.length === 1) { await held; count--; used = 0; throw new Error('reset response lost'); }
      return { outcome: 'alreadyRedeemed' };
    }
    return call(method, params);
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click(); await page.getByRole('button', { name: '▱ ' + dir, exact: true }).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('keep draft');
    const other = await context.newPage(); await other.goto(page.url());
    await expect(other.locator('.usage-bar')).toContainText('Resets 2');
    const dialog = page.getByRole('dialog', { name: '使用重置卡' });
    await page.locator('#reset-usage').click();
    await expect(dialog).toContainText('确认使用 1 张重置卡');
    await expect(page.locator('#usage-reset-cancel')).toBeFocused();
    await expect(page.locator('#usage-reset-confirm')).toBeEnabled();
    await page.screenshot({ path: 'test-results/usage-reset-confirmation.png' });
    await page.locator('#usage-reset-cancel').click(); expect(keys).toEqual([]);
    await page.locator('#reset-usage').click(); await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); expect(keys).toEqual([]);
    await page.locator('#reset-usage').click(); await page.locator('#usage-reset-confirm').click();
    await expect.poll(() => keys.length).toBe(1);
    await expect(page.locator('#usage-reset-confirm')).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    release(); await expect(dialog.getByRole('alert')).toContainText('reset response lost');
    await expect(other.locator('.usage-bar')).toContainText('Resets 1');
    await expect(other.locator('.usage-bar')).toContainText('Weekly left 100%');
    const key = keys[0]; expect(key).toMatch(/^[a-f0-9-]{36}$/);
    await page.reload(); await expect(page.locator('#prompt')).toHaveValue('keep draft');
    await page.locator('#reset-usage').click();
    await expect(page.locator('#usage-reset-confirm')).toHaveText('重试本次重置');
    await page.locator('#usage-reset-confirm').click();
    await expect(dialog).toContainText('本次请求对应的重置卡已使用');
    expect(keys).toEqual([key, key]); expect(count).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('viewer-usage-reset-key'))).toBeNull();
    await page.locator('#usage-reset-cancel').click();
    count = 0;
    await page.locator('#reset-usage').click(); await expect(dialog).toContainText('剩余重置卡：0');
    await expect(page.locator('#usage-reset-confirm')).toBeDisabled();
    await page.locator('#usage-reset-cancel').click();
    await page.route('**/api/usage', route => route.fulfill({ status: 502, json: { error: 'quota unavailable' } }));
    await page.locator('#reset-usage').click(); await expect(dialog).toContainText('未知');
    await expect(page.locator('#usage-reset-confirm')).toBeDisabled();
    expect(keys).toHaveLength(2);
    await other.close();
  } finally { release(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('unobtrusive usage restores context, streams account quota and fits widescreen', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-usage-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: path.join(dir, 'data'), runtimeDir: path.join(dir, 'run'), port: 0, adapter });
  try {
    // A persisted session not yet opened by the viewer restores usage before resume returns.
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    const id = (thread as { id: string }).id;
    await adapter.call('turn/start', { threadId: id, input: [{ type: 'text', text: 'usage check' }] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(app.launchUrl + '#' + id);
    const bar = page.locator('.usage-bar');
    await expect(bar).toContainText('Context left 75%');
    await expect(bar).toContainText('Weekly left 73%');
    await expect(bar).toContainText('Resets 2');
    await expect(bar.locator('span').nth(1)).toHaveAttribute('title', /恢复时间/);
    adapter.emit('notice', { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080 } } } });
    await expect(bar).toContainText('Weekly left 60%');
    await expect(bar).toContainText('Resets 2');
    await page.screenshot({ path: 'test-results/usage-desktop.png' });
    await page.reload();
    await expect(bar).toContainText('Context left 75%');
    await page.setViewportSize({ width: 1920, height: 844 });
    await expect(bar).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/usage-widescreen.png' });
    await page.locator('.project-new').click();
    await page.locator('#folder-select').click();
    await expect(bar).toContainText('Context left —');
    await expect(bar).toContainText('Resets 2');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
