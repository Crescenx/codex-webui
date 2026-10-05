import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { FileUpdateChange } from '../shared/protocol.ts';

test('file cards replace JSON with inline diffs and a persistent side-by-side review dialog', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/diff-browser-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const patch = '@@ -476,2 +476,4 @@ build_prompt\n     template = resolve()\n+    validate(template)\n+    budget = 100\n     return template\n@@ -500 +502 @@ run\n-old()\n+new()\n';
  const source = 'const value = "<img src=x onerror=alert(1)>";\r\n\r\n\r\n\tconsole.log(value);\r\n';
  const changes: FileUpdateChange[] = [
    { path: dir + '/pipelines/term_search/llm_ops.py', kind: { type: 'update', move_path: null }, diff: patch },
    { path: dir + '/web/check.ts', kind: { type: 'add' }, diff: source },
    { path: dir + '/web/legacy.ts', kind: { type: 'delete' }, diff: 'export const legacy = true;\n' },
    { path: dir + '/notes/old.md', kind: { type: 'update', move_path: dir + '/notes/new.md' }, diff: '' },
  ];
  try {
    await page.setViewportSize({ width: 1920, height: 1080 }); await context.grantPermissions(['clipboard-read', 'clipboard-write']); await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json();
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    await adapter.call('mock/fileChange', { threadId: thread.id, changes, status: 'inProgress' });
    const card = page.locator('#conversation .file-change'), entries = card.locator('.diff-file');
    await expect(card).toContainText('修改 4 个文件'); await expect(card).toContainText('修改中'); await expect(entries).toHaveCount(4);
    await expect(card.locator('.diff-code')).toHaveCount(0); await expect(card.locator('pre')).toHaveCount(0);
    await expect(entries.first()).toContainText('pipelines/term_search/llm_ops.py'); await expect(entries.first().locator('.diff-path')).toHaveAttribute('title', changes[0]!.path);
    await expect(entries.first().locator('.diff-added')).toHaveText('+3'); await expect(entries.first().locator('.diff-removed')).toHaveText('−1');
    await expect(entries.nth(3)).toContainText('notes/old.md → notes/new.md');
    await entries.first().locator('.diff-file-toggle').click(); await expect(entries.first().locator('.diff-row.hunk')).toHaveCount(2);
    await expect(entries.first().locator('.diff-row.context').first().locator('.diff-gutter')).toContainText('476');
    await expect(entries.first().locator('.diff-row.add')).toHaveCount(3); await expect(entries.first().locator('.hljs-number')).toContainText('100');
    await entries.first().getByRole('button', { name: '复制原始 diff' }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(patch);
    await adapter.call('mock/fileChange', { threadId: thread.id, changes, status: 'completed' }); await expect(card.locator('.activity-state')).toHaveText('已完成');
    await expect(entries.first().locator('.diff-file-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: 'test-results/diff-inline-1920.png' });
    const enlarge = entries.first().getByRole('button', { name: /^放大查看/ }); await enlarge.click();
    const modal = page.getByRole('dialog', { name: '查看文件变更' }); await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: '左右对比', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-side="old"] .diff-row.delete')).toHaveCount(1); await expect(modal.locator('[data-side="new"] .diff-row.add')).toHaveCount(3);
    for (const width of [1920, 2560]) { await page.setViewportSize({ width, height: 1080 }); await page.screenshot({ path: `test-results/diff-review-${width}.png` }); }
    // A selection in the teleported dialog survives a completed replacement snapshot.
    await modal.locator('[data-side="new"] .diff-code').first().evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    const selection = await page.evaluate(() => getSelection()!.toString());
    changes[0]!.diff = patch.replace('budget = 100', 'budget = 200');
    await adapter.call('mock/fileChange', { threadId: thread.id, changes, status: 'completed' });
    await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(selection);
    await expect(modal.locator('[data-side="new"]')).toContainText('budget = 100');
    await page.evaluate(() => getSelection()!.removeAllRanges()); await expect(modal.locator('[data-side="new"]')).toContainText('budget = 200');
    await modal.locator('.diff-file-nav button').nth(1).click();
    await expect(modal.locator('.diff-code img, .diff-code script')).toHaveCount(0);
    const copied = await modal.locator('[data-side="new"]').evaluate(pane => {
      const codes = pane.querySelectorAll('.diff-code'), range = document.createRange(); range.setStartBefore(codes[0]!); range.setEndAfter(codes[codes.length - 1]!);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); pane.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data })); selection.removeAllRanges(); return data.getData('text/plain');
    });
    expect(copied).toBe(source.slice(0, -2));
    await modal.getByRole('button', { name: '单栏', exact: true }).click(); await expect(modal.locator('[data-side="unified"]')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0); await expect(enlarge).toBeFocused();
    await enlarge.click(); await expect(modal.getByRole('button', { name: '单栏', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await modal.getByRole('button', { name: '关闭文件变更' }).click();
    await page.reload(); await expect(page.locator('#conversation .diff-file')).toHaveCount(4); await expect(page.locator('#conversation .diff-code')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('large diffs load in batches, synchronize split scrolling and keep complete raw copies', async ({ page }) => {
  const dir = await mkdtemp('/tmp/diff-large-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const raw = Array.from({ length: 1201 }, (_, i) => `const line${i} = "${'x'.repeat(150)}";`).join('\n') + '\n';
  try {
    await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json();
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    await adapter.call('mock/fileChange', { threadId: thread.id, changes: [{ path: dir + '/large.ts', kind: { type: 'add' }, diff: raw }] });
    await page.locator('.diff-file-toggle').click(); await expect(page.locator('#conversation .diff-code')).toHaveCount(500); await expect(page.locator('#conversation .diff-code [class^="hljs"]')).toHaveCount(0);
    await page.getByRole('button', { name: /放大查看/ }).click(); const modal = page.locator('.diff-dialog');
    const before = modal.locator('[data-side="old"]'), after = modal.locator('[data-side="new"]');
    await after.evaluate(el => { el.scrollTop = 320; el.scrollLeft = 200; });
    await expect.poll(() => before.evaluate(el => el.scrollTop)).toBe(320);
    expect(await after.evaluate(el => el.scrollLeft)).toBe(200);
    await modal.getByRole('button', { name: /继续显示/ }).click(); await expect(after.locator('.diff-code')).toHaveCount(1000); expect(await after.evaluate(el => el.scrollTop)).toBe(320);
    await modal.getByRole('button', { name: /继续显示/ }).click(); await expect(after.locator('.diff-code')).toHaveCount(1201); await expect(modal.getByRole('button', { name: /继续显示/ })).toHaveCount(0);
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { (window as unknown as { copiedDiff: string }).copiedDiff = text; } }); });
    await modal.getByRole('button', { name: '复制内容' }).click(); expect(await page.evaluate(() => (window as unknown as { copiedDiff: string }).copiedDiff)).toBe(raw);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('subagent file cards share the renderer and retain honest failure, refusal and fallback states', async ({ page }) => {
  const dir = await mkdtemp('/tmp/diff-agent-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json();
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    await adapter.call('mock/agent', { threadId: thread.id, id: 'child', name: '代码检查' }); await page.getByRole('button', { name: '展开 Subagents', exact: true }).click(); await page.locator('[data-agent-id="child"]').click();
    await adapter.call('mock/fileChange', { threadId: 'child', id: 'failed', status: 'failed', error: { message: '文件已被修改，补丁未应用' }, changes: [{ path: dir + '/bad.py', kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n-a\n+b\n' }] });
    const cards = page.locator('#agent-conversation .file-change'); await expect(cards.first()).toContainText('修改失败'); await expect(cards.first()).toContainText('补丁未应用');
    await cards.first().locator('.diff-file-toggle').click(); await expect(cards.first()).toContainText('行数未知'); await expect(cards.first().locator('.diff-raw')).toContainText('@@ -1,3 +1,3 @@');
    await expect(cards.first().locator('.diff-code')).toHaveCount(0);
    await adapter.call('mock/fileChange', { threadId: 'child', id: 'declined', status: 'declined', changes: [{ path: dir + '/new.py', kind: { type: 'add' }, diff: 'print("hello")\n' }] });
    await expect(cards.nth(1).locator('.activity-state')).toHaveText('已拒绝'); await expect(cards.nth(1)).not.toContainText('已完成');
    await cards.nth(1).locator('.diff-file-toggle').click(); await expect(cards.nth(1).locator('.diff-row.add')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/diff-subagent-1920.png' });
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
