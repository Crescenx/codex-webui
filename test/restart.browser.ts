import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('global restart loads new frontend assets and preserves each tab draft without replay', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/viewer-restart-ui-');
  await cp(path.resolve('dist'), dir + '/static', { recursive: true });
  const index = await readFile(dir + '/static/index.html', 'utf8');
  const build = async (version: string) => {
    await writeFile(dir + '/version', version);
    await writeFile(`${dir}/static/assets/restart-${version}.js`, `document.documentElement.dataset.restartBuild = '${version}';`);
    await writeFile(dir + '/static/index.html', index.replace('</head>', `<script src="/assets/restart-${version}.js"></script></head>`));
  };
  await build('before');
  const child = spawn(process.execPath, [path.resolve('test/restart-fixture.ts'), dir], { stdio: 'ignore' });
  const boot = async () => JSON.parse(await readFile(dir + '/boot.json', 'utf8'));
  try {
    await expect.poll(async () => (await boot().catch(() => null))?.marker).toBe('before');
    const app = await boot();
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
    await page.locator('#mode').selectOption('plan');
    await page.locator('#skills-button').click();
    await page.getByRole('button', { name: '用于本轮' }).click();
    await page.getByRole('button', { name: '关闭 Skills' }).click();
    const other = await context.newPage();
    await other.goto(app.origin + '/#' + thread.id);
    await expect(other.locator('#send')).toBeEnabled();
    await other.locator('#prompt').fill('other tab draft');
    const pid = app.codexPid;
    // A running task in another conversation must block this global operation.
    const second = await (await post('/threads', { cwd: dir })).json();
    await post(`/threads/${second.thread.id}/name`, { name: 'Other task' });
    await post(`/threads/${second.thread.id}/turns`, { text: 'approve', attachments: [] });
    await page.locator('.sidebar-more').evaluate(el => el.setAttribute('open', ''));await page.locator('#restart-backend').click();
    await expect(page.locator('#error')).toContainText(/未结束|正在运行/);
    await expect(page.locator('html')).toHaveAttribute('data-restart-build', 'before');
    expect((await boot()).codexPid).toBe(pid);
    await post(`/threads/${second.thread.id}/interrupt`);
    // A module-scope marker must be re-read, proving the Viewer itself was replaced.
    await build('after');
    const mainSession = (await context.cookies()).find(c => c.name === 'viewer')!.value;
    const otherContext = await page.context().browser()!.newContext();
    const independent = await otherContext.newPage();await independent.goto(app.launchUrl);
    await expect(independent.locator('#connection')).toHaveText('已连接');
    await page.locator('.sidebar-more').evaluate(el => el.setAttribute('open', ''));await page.locator('#restart-backend').click();
    await expect(page.locator('#toast')).toHaveText('整个后端已重启，页面已更新', { timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-restart-build', 'after');
    await expect(page.locator('#connection')).toHaveText('已连接');
    await expect(page.locator('#send')).toBeEnabled();
    const replacement = await boot();expect(replacement.instance).not.toBe(app.instance);expect(replacement.marker).toBe('after');expect(replacement.codexPid).not.toBe(pid);
    expect((await readFile(`/proc/${replacement.codexPid}/environ`,'utf8')).includes('VIEWER_RESTART_STATE=')).toBe(false);
    expect((await context.cookies()).find(c => c.name === 'viewer')!.value).toBe(mainSession);
    await expect(independent.locator('#connection')).toHaveText('已连接');
    expect((await independent.request.get(app.origin + '/api/threads')).status()).toBe(200);
    await otherContext.close();
    await expect(page.locator('#prompt')).toHaveValue('unsent draft');
    await expect(page.locator('#attachments')).toContainText('note.txt');
    await expect(page.locator('#mode')).toHaveValue('plan');
    await expect(page.locator('#selected-skills')).toContainText('sample-skill');
    const saved = await page.evaluate(() => sessionStorage.getItem('viewer-restart-drafts-v1'));
    expect(saved).toBeNull();
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(other.locator('#connection')).toHaveText('已连接');
    await expect(other.locator('html')).toHaveAttribute('data-restart-build', 'after');
    await expect(other.locator('#prompt')).toHaveValue('other tab draft');
    await expect(other.locator('#attachments .attachment')).toHaveCount(0);
    await expect(other.locator('#selected-skills .skill-chip')).toHaveCount(0);
    await expect(other.locator('.message.user')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/restart-desktop.png' });
    await page.setViewportSize({ width: 1920, height: 844 });
    await page.locator('.sidebar-more').evaluate(el => el.setAttribute('open', ''));await expect(page.locator('#restart-backend')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/restart-widescreen.png' });
    // If tab storage is unavailable, keep unsent inputs in memory instead of losing them on reload.
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'viewer-restart-drafts-v1') throw new DOMException('Storage full', 'QuotaExceededError');
        setItem.call(this, key, value);
      };
    });
    await build('third');
    await page.locator('.sidebar-more').evaluate(el => el.setAttribute('open', ''));await page.locator('#restart-backend').click();
    await expect(page.locator('#error')).toContainText('无法暂存草稿以刷新页面', { timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-restart-build', 'after');
    await expect(page.locator('#prompt')).toHaveValue('unsent draft');
    await expect(page.locator('#attachments')).toContainText('note.txt');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(other.locator('html')).toHaveAttribute('data-restart-build', 'third');
    await expect(other.locator('#prompt')).toHaveValue('other tab draft');
    await expect(other.locator('.message.user')).toHaveCount(1);
  } finally {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
    await rm(dir, { recursive: true, force: true });
  }
});
