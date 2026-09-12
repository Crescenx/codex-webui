import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

test('desktop rails show nested agents, live read-only records and watchdogs without moving the parent', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/agents-browser-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(app.launchUrl);
    const post = (url: string, data: object) => page.request.post(app.origin + '/api' + url, { data, headers: { Origin: app.origin } });
    const { thread } = await (await post('/threads', { cwd: dir })).json();
    await post(`/threads/${thread.id}/name`, { name: '检查实现与验证结果' });
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#prompt').fill('保留主对话草稿');
    await adapter.call('mock/watchdog', { threadId: thread.id, name: 'watchdog_create', arguments: { name: '每小时检查实验', prompt: '检查日志与任务状态', intervalMinutes: 60 } });
    await adapter.call('mock/agent', { threadId: thread.id, id: 'review', name: '实现检查', prompt: '检查数据读取与并发更新是否正确。' });
    await adapter.call('mock/agent', { threadId: 'review', id: 'tests', name: '回归验证', prompt: '验证状态变化、刷新和读取失败。' });
    await adapter.call('mock/agent', { threadId: thread.id, id: 'docs', name: '文档整理', prompt: '核对功能说明。' });
    await adapter.call('mock/agentEvent', { threadId: 'docs', delta: '已核对现有说明。', status: 'completed' });
    const node = (id: string) => page.locator(`[data-agent-id="${id}"]`);
    await expect(node('review')).toContainText('执行中'); await expect(node('tests')).toContainText('由 实现检查 派发'); await expect(node('docs')).toContainText('已完成');
    expect((await node('tests').boundingBox())!.x).toBeGreaterThan((await node('review').boundingBox())!.x);
    const scroll = await page.locator('#conversation').evaluate(el => el.scrollTop);
    await node('review').click();
    await adapter.call('mock/agentEvent', { threadId: 'review', delta: '正在核对 **状态更新**。\n\n```ts\nconst healthy = true;\n```' });
    await expect(page.locator('#agent-conversation')).toContainText('状态更新');
    await expect(page.locator('#agent-conversation strong')).toContainText('状态更新');
    await expect(page.locator('#prompt')).toHaveValue('保留主对话草稿');
    expect(await page.locator('#conversation').evaluate(el => el.scrollTop)).toBe(scroll);
    expect(new URL(page.url()).hash).toBe('#' + thread.id);
    await expect(page.locator('#subagents textarea')).toHaveCount(0);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#agent-conversation').getByRole('button', { name: '复制 Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('**状态更新**');
    for (const width of [1920, 2560]) {
      await page.setViewportSize({ width, height: 1080 });
      const left = (await page.locator('#watchdog-rail').boundingBox())!, main = (await page.locator('main').boundingBox())!, right = (await page.locator('#subagents').boundingBox())!;
      expect(left.x + left.width).toBeLessThanOrEqual(main.x); expect(main.x + main.width).toBeLessThanOrEqual(right.x); expect(left.y).toBe(main.y);
      expect(await page.locator('main .watchdog-strip').count()).toBe(0);
      await page.screenshot({ path: `test-results/subagents-${width}.png` });
    }
    // Polling repairs missing notifications without a resume or a message send.
    await adapter.call('mock/agentEvent', { threadId: 'review', delta: '\n已补齐持久化结果。', status: 'completed', silent: true });
    await expect(page.locator('#agent-conversation')).toContainText('已补齐持久化结果'); await expect(node('review')).toContainText('已完成');
    await page.route('**/api/threads/tests?refresh=1', route => route.fulfill({ status: 502, json: { error: '暂时无法读取' } }));
    await node('tests').click(); await expect(page.locator('.agent-detail [role="alert"]')).toContainText('暂时无法读取');
    await expect(node('review')).toBeVisible(); await page.unroute('**/api/threads/tests?refresh=1');
    await page.locator('.agent-detail').getByRole('button', { name: '重试', exact: true }).click(); await expect(page.locator('.agent-detail [role="alert"]')).toHaveCount(0);
    await page.getByRole('button', { name: '收起 Subagents', exact: true }).click(); await expect(page.locator('#subagents')).toHaveCSS('width', '36px');
    await page.getByRole('button', { name: '收起 Watchdogs', exact: true }).click();
    await page.reload(); await expect(page.locator('#subagents')).toHaveCSS('width', '36px'); await expect(page.locator('#watchdog-rail')).toHaveCSS('width', '36px');
    await page.getByRole('button', { name: '展开 Subagents', exact: true }).click(); await expect(node('tests')).toBeVisible();
    await node('review').click(); await expect(page.locator('#agent-conversation')).toContainText('已补齐持久化结果');
    expect(errors).toEqual([]);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
