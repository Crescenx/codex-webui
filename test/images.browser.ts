import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, symlink, truncate, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('local Markdown images load, fit widescreen and copy source within file permissions', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/viewer-images-'), root = path.join(dir, 'project'); await mkdir(root);
  const file = '中文 plot.png';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, file), png); await writeFile(path.join(root, '.hidden.png'), png);
  await writeFile(path.join(dir, 'outside.png'), png); await symlink(path.join(dir, 'outside.png'), path.join(root, 'escape.png'));
  await writeFile(path.join(root, 'fake.png'), '<html>not an image</html>');
  await writeFile(path.join(root, 'large.png'), png); await truncate(path.join(root, 'large.png'), 25 * 1024 * 1024 + 1);
  const app = await serve({ roots: [root], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }) });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
    await page.goto(app.launchUrl);
    const created = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: root } })).json();
    const id = created.thread.id; await page.goto(app.origin + '/#' + id);
    const imageUrl = (target: string) => app.origin + '/api/files/image?' + new URLSearchParams({ threadId: id, target });
    expect((await fetch(imageUrl(file))).status).toBe(401);
    const good = await page.request.get(imageUrl(file)); expect(good.status()).toBe(200);
    expect(good.headers()['content-type']).toBe('image/png'); expect(await good.body()).toEqual(png);
    for (const [target, status] of [['.hidden.png', 403], ['../outside.png', 403], ['escape.png', 403], ['fake.png', 415], ['large.png', 413], ['missing.png', 404]] as const) {
      expect((await page.request.get(imageUrl(target))).status(), target).toBe(status);
    }
    const source = `曲线如下。\n\n![绝对路径](<${root}/${file}>)\n\n![相对路径](<${file}>)\n\n![缺失图片](missing.png)\n\n![远程图片](https://example.com/tracker.png)`;
    let remoteRequests = 0; page.on('request', r => { if (r.url().startsWith('https://example.com/')) remoteRequests++; });
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('render-markdown\n' + source); await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeHidden();
    const images = page.locator('.assistant .markdown img'); await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(nodes => nodes.every(n => (n as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await expect(page.locator('.assistant .markdown')).toContainText('图片无法读取：缺失图片');
    expect(remoteRequests).toBe(0);
    await page.getByRole('button', { name: '复制 Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    const copied = await page.locator('.assistant .markdown').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data })); selection.removeAllRanges(); return data.getData('text/plain');
    });
    expect(copied).toContain(`![绝对路径](<${root}/${file}>)`); expect(copied).toContain('![缺失图片](missing.png)');
    // Force a wide intrinsic layout without relying on a new image fixture or dependency.
    await images.first().evaluate(el => el.setAttribute('width', '1600'));
    await page.setViewportSize({ width: 1920, height: 844 });
    expect(await images.first().evaluate(el => el.getBoundingClientRect().width <= el.parentElement!.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload(); await expect(page.locator('.assistant .markdown img')).toHaveCount(2);
    await expect.poll(() => page.locator('.assistant .markdown img').evaluateAll(nodes => nodes.every(n => (n as HTMLImageElement).naturalWidth > 0))).toBe(true);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
