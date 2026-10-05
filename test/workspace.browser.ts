import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('desktop workspace keeps one navigation scroller, compact rows and reachable skill controls', async ({ page }, info) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-ux-'));
  const roots = [0, 1, 2].map(i => path.join(dir, 'project-' + i));
  await Promise.all(roots.map(root => mkdir(root)));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const original = adapter.call.bind(adapter);
  const records = Array.from({ length: 90 }, (_, i) => ({ id: 'listed-' + i, cwd: roots[Math.floor(i / 30)]!, name: '研究会话 ' + i, updatedAt: 90 - i, status: { type: 'idle' }, settings: { model: 'mock', effort: 'medium', mode: 'default' }, approvalsReviewer: 'auto_review', turns: [] }));
  adapter.call = async (method, params = {}) => {
    if (method === 'thread/list' && !params.ancestorThreadId) return { data: records, nextCursor: null };
    const record = records.find(t => t.id === params.threadId);
    if (record && ['thread/read', 'thread/resume'].includes(method)) return { thread: record, model: 'mock', reasoningEffort: 'medium', approvalsReviewer: 'auto_review' };
    return original(method, params);
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(app.launchUrl);
    await expect(page.locator('.thread')).toHaveCount(18);
    expect((await page.locator('.thread').first().boundingBox())!.height).toBe(32);
    expect(await page.locator('.project-sessions').evaluateAll(els => els.every(el => getComputedStyle(el).overflowY !== 'auto'))).toBe(true);
    await page.locator('.project-more').first().click(); await expect(page.locator('.thread')).toHaveCount(30);
    await page.locator('[data-thread-id="listed-29"]').click(); await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#all-projects').click(); await expect(page.locator('.thread')).toHaveCount(19);
    await expect(page.locator('[data-thread-id="listed-29"]')).toHaveAttribute('aria-current', 'page');
    await page.locator('#search').fill('研究会话 8'); await expect(page.locator('.thread')).toHaveCount(11); await page.locator('#search').fill('');
    await page.route('**/api/controls?*', async route => {
      const response = await route.fetch(), data = await response.json();
      data.skills = Array.from({ length: 120 }, (_, i) => ({ name: 'skill-' + String(i).padStart(3, '0'), path: '/mock/skills/' + i + '/SKILL.md', description: '研究与验证 · ' + i, enabled: true }));
      await route.fulfill({ response, json: data });
    });
    await page.locator('#skills-button').click();
    await page.getByRole('button', { name: '重新加载', exact: true }).count().then(async n => { if (n) await page.getByRole('button', { name: '重新加载', exact: true }).click(); });
    await page.getByRole('button', { name: '关闭 Skills', exact: true }).click();
    await page.locator('.sidebar-more summary').click(); await page.locator('#refresh').click();
    await page.locator('#skills-button').click(); await expect(page.locator('.skill-row')).toHaveCount(120);
    const list = page.locator('#skill-list'); await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const closeBox = (await page.getByRole('button', { name: '关闭 Skills', exact: true }).boundingBox())!;
    expect(closeBox.y).toBeGreaterThanOrEqual(0); expect(closeBox.y + closeBox.height).toBeLessThan(1080);
    await page.locator('#skill-search').fill('skill-119'); await expect(page.locator('.skill-row')).toHaveCount(1);
    await page.getByRole('button', { name: '用于本轮', exact: true }).click(); await expect(page.locator('.skill-chip')).toHaveCount(1);
    await page.getByRole('button', { name: '取消选择', exact: true }).click(); await expect(page.locator('.skill-chip')).toHaveCount(0);
    await page.getByRole('button', { name: '完成', exact: true }).click(); await expect(page.locator('#skills-button')).toBeFocused();
    await page.locator('#prompt').fill('检查 $skill-119'); await expect(page.locator('#skill-suggestions')).toBeVisible();
    await page.locator('#prompt').press('Enter'); await expect(page.locator('.skill-chip')).toContainText('skill-119'); await expect(page.locator('#prompt')).toHaveValue('检查 ');
    await expect(page.locator('.user')).toHaveCount(0);
    await page.locator('#prompt').fill('$skill'); await page.locator('#prompt').press('ArrowDown'); await page.locator('#prompt').press('Escape'); await expect(page.locator('#skill-suggestions')).toHaveCount(0);
    await page.locator('#prompt').fill('$123'); await expect(page.locator('#skill-suggestions')).toHaveCount(0);
    await page.locator('#sidebar-resize').press('End');
    await page.locator('#watchdogs-toggle').click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('.auxiliary-tabs button').first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator('.auxiliary-panel').evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#watchdogs-toggle')).toBeFocused();
    await page.locator('#sidebar-resize').dblclick();
    for (const width of [1280, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 720 });
      await page.locator('#watchdogs-toggle').click(); await expect(page.locator('#watchdog-rail')).toBeVisible();
      await page.locator('.auxiliary-tabs').getByRole('button', { name: '子代理', exact: true }).click(); await expect(page.locator('#subagents')).toBeVisible(); await expect(page.locator('#watchdog-rail')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.locator('#conversation').boundingBox())!.height).toBeGreaterThanOrEqual(160);
      await page.getByRole('button', { name: '收起 Subagents', exact: true }).click();
      const send = (await page.locator('#send').boundingBox())!; expect(send.y + send.height).toBeLessThanOrEqual(720);
      await page.screenshot({ path: info.outputPath('workspace-' + width + '.png') });
    }
    expect(errors).toEqual([]);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
