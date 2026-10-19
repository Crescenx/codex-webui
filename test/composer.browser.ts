import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('composer can shrink and grow by dragging at desktop zoom levels', async ({ page }, testInfo) => {
  const dir = await mkdtemp('/tmp/viewer-composer-');
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }) });
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    await page.goto(app.origin + '/#' + thread.id);
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#composer .runtime-status, #composer #settings-state, #composer #context-state')).toHaveCount(0);
    const composerBefore=await page.locator('#composer').boundingBox();
    await page.locator('#settings-toggle').click();
    await expect(page.locator('.session-info-panel')).toBeVisible();
    expect(await page.locator('#composer').boundingBox()).toEqual(composerBefore);
    await page.screenshot({path:'test-results/session-info-desktop.png'});
    await page.keyboard.press('Escape');
    await expect(page.locator('.session-info-panel')).toBeHidden();
    await expect(page.locator('#settings-toggle')).toBeFocused();
    const prompt = page.locator('#prompt');
    for (const zoom of [1, 1.5, 2]) {
      // Browser zoom reduces the available CSS viewport on the same desktop screen.
      await page.setViewportSize({ width: Math.round(2560 / zoom), height: Math.round(1440 / zoom) });
      await prompt.fill('保留草稿\n第二行\n第三行');
      const drag = async (delta: number) => {
        const box = (await prompt.boundingBox())!;
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4 + delta, { steps: 12 });
        await page.mouse.up();
      };
      await drag(-200);
      await expect.poll(async () => (await prompt.boundingBox())!.height).toBeLessThanOrEqual(41);
      const compact = (await page.locator('#composer').boundingBox())!.height;
      await page.screenshot({ path: testInfo.outputPath(`compact-${zoom}.png`) });
      await drag(100);
      expect((await prompt.boundingBox())!.height).toBeGreaterThan(80);
      expect((await page.locator('#composer').boundingBox())!.height).toBeGreaterThan(compact);
      await expect(prompt).toHaveValue('保留草稿\n第二行\n第三行');
      const send = (await page.locator('#send').boundingBox())!;
      expect(send.y + send.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
