import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('local folder picking, WSL paths, project hierarchy and persistent sidebar controls', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-navigation-'));
  const root = path.join(dir, 'projects'), selected = path.join(dir, '研究项目');
  await Promise.all([mkdir(root), mkdir(selected)]);
  let choice: string | null = null, picks = 0, waitForCancel = false, cancelled = 0;
  const app = await serve({ roots: [root], dataDir: path.join(dir, 'data'), runtimeDir: path.join(dir, 'run'), port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }),
    picker: async (_, signal) => {
      picks++;
      if (waitForCancel) await new Promise<void>(resolve => signal?.addEventListener('abort', () => { cancelled++; resolve(); }, { once: true }));
      return choice;
    } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(app.launchUrl);
    await expect(page.locator('.brand-mark')).toBeVisible();
    expect(await page.locator('.brand-mark').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 256)).toBe(true);
    const icon = await page.locator('link[rel="icon"]').getAttribute('href');
    const iconResponse = await page.request.get(new URL(icon!, app.origin).href);
    expect(iconResponse.headers()['content-type']).toBe('image/png');
    expect((await iconResponse.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await page.locator('#welcome-new').click();
    await page.locator('#folder-native').click();
    await expect(page.locator('#folder-native')).toBeEnabled();
    expect(picks).toBe(1);
    await expect(page.locator('#folder-dialog')).toBeVisible();
    await expect(page.locator('#folder-select')).toBeDisabled();
    waitForCancel = true;
    await page.locator('#folder-native').click();
    await expect.poll(() => picks).toBe(2);
    await page.locator('#folder-cancel-pick').click();
    await expect(page.locator('#folder-native')).toBeEnabled();
    await expect(page.locator('#folder-dialog')).toBeVisible();
    await expect.poll(() => cancelled).toBe(1);
    waitForCancel = false;
    choice = selected;
    await page.locator('#folder-native').click();
    await expect(page.locator('#folder-path')).toHaveText(selected);
    if (process.env.WSL_DISTRO_NAME) {
      await page.locator('#folder-location').fill(`\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${selected.replaceAll('/', '\\')}`);
      await page.getByRole('button', { name: '前往', exact: true }).click();
      await expect(page.locator('#folder-location')).toHaveValue(selected);
    }
    await page.screenshot({ path: 'test-results/viewer-folder-picker.png', fullPage: true });
    await page.locator('#folder-select').click();
    await expect(page.locator('#cwd')).toHaveText(selected);
    await expect(page.locator('.project-sessions .thread')).toHaveCount(1);
    await page.locator('.project-new').click();
    await page.locator('#folder-select').click();
    await expect(page.locator('.project-sessions .thread')).toHaveCount(2);
    await page.locator('.project-toggle').click();
    await expect(page.locator('.project-sessions')).toHaveCount(0);
    await expect(page.locator('.project-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.project-toggle').click();
    await expect(page.locator('.project-sessions .thread')).toHaveCount(2);
    await expect(page.locator('.thread[aria-current="page"]')).toHaveCount(1);
    let releaseOld!: () => void, releaseNew!: () => void, creates = 0;
    const oldCreate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newCreate = new Promise<void>(resolve => { releaseNew = resolve; });
    await page.route('**/api/threads', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (++creates === 1) { await oldCreate; await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'obsolete creation failed' }) }); }
      else { await newCreate; await route.continue(); }
    });
    await page.locator('.project-new').click(); await page.locator('#folder-select').click();
    await expect.poll(() => creates).toBe(1);
    await page.keyboard.press('Escape'); await expect(page.locator('#folder-dialog')).toBeHidden();
    await page.locator('.project-new').click(); await expect(page.locator('#folder-select')).toBeEnabled();
    await page.locator('#folder-select').click(); await expect.poll(() => creates).toBe(2);
    // A close event queued by the previous view must not reset this open dialog.
    await page.locator('#folder-dialog').evaluate(el => el.dispatchEvent(new Event('close')));
    const obsolete = page.waitForResponse(r => r.url().endsWith('/api/threads') && r.status() === 502);
    releaseOld(); await obsolete;
    await expect(page.locator('#folder-error')).toBeHidden();
    await expect(page.locator('#folder-select')).toBeDisabled();
    releaseNew(); await expect(page.locator('#folder-dialog')).toBeHidden();
    await expect(page.locator('.project-sessions .thread')).toHaveCount(3);
    await page.unroute('**/api/threads');
    const handle = page.locator('#sidebar-resize'), box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200); await page.mouse.down();
    await page.mouse.move(380, box.y + 200); await page.mouse.up();
    await expect(page.locator('#sidebar')).toHaveCSS('width', '380px');
    await handle.focus(); await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#sidebar')).toHaveCSS('width', '364px');
    await page.reload();
    await expect(page.locator('#sidebar')).toHaveCSS('width', '364px');
    const assets = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.startsWith('/assets/')).map(e => (e as PerformanceResourceTiming).transferSize));
    expect(assets.length).toBeGreaterThan(0); expect(assets.every(bytes => bytes === 0)).toBe(true);
    await page.locator('#sidebar-collapse').click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#menu')).toBeFocused();
    await page.reload();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.locator('#menu').click();
    await expect(page.locator('#sidebar')).toBeVisible();
    await page.screenshot({ path: 'test-results/viewer-sidebar-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(handle).toBeVisible();
    await page.screenshot({ path: 'test-results/viewer-sidebar-widescreen.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
