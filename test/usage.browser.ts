import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

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
