import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import type { Obj } from '../shared/protocol.ts';

test('goal controls, native model events, reconnect and wide desktop layout', async ({ page }) => {
  const dir = await mkdtemp('/tmp/viewer-goals-browser-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter), calls: { method: string; params: Obj }[] = [];
  adapter.call = async (method, params = {}) => { calls.push({ method, params }); return call(method, params); };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click(); await page.locator('.folder').filter({ hasText: dir }).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#goal-state')).toHaveCount(0);
    await page.locator('#mode').selectOption('plan');
    await page.locator('#goal-button').click();
    await page.locator('#goal-objective').fill('完成迁移并通过验收\n保留所有已有交互及历史记录。');
    await page.locator('#goal-budget').fill('10000');
    await page.screenshot({ path: 'test-results/goal-editor-desktop.png' });
    await page.locator('#goal-save').click();
    await expect(page.locator('.goal-dialog')).not.toBeVisible();
    await expect(page.locator('#goal-state')).toContainText('Goal · 进行中');
    await expect(page.locator('#mode')).toHaveValue('plan');
    const threadId = decodeURIComponent(new URL(page.url()).hash.slice(1));
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(0);
    await call('mock/goal', { threadId, tokensUsed: 1234, timeUsedSeconds: 125 });
    await expect(page.locator('#goal-state')).toContainText('1,234 / 10,000');
    await page.locator('#goal-state summary').click();
    await expect(page.locator('#goal-state')).toContainText('保留所有已有交互');
    await page.locator('#goal-pause').click();
    await expect(page.locator('#goal-state')).toContainText('已暂停');
    await expect(page.locator('#stop')).toBeVisible();
    await page.locator('#goal-button').click(); await page.locator('#goal-budget').fill(''); await page.locator('#goal-save').click();
    await expect(page.locator('#goal-state')).toContainText('1,234 / 无上限');
    await page.locator('#stop').click(); await expect(page.locator('#stop')).toBeHidden();
    await page.reload(); await expect(page.locator('#goal-state')).toContainText('1,234 / 无上限');
    await page.locator('#mode').selectOption('default');
    await expect(page.locator('#goal-state')).toContainText('已暂停');
    await page.locator('#goal-resume').click(); await expect(page.locator('#goal-state')).toContainText('进行中');
    await expect(page.locator('#settings-state')).toContainText('普通');
    for (const [status, label] of [['blocked', '受阻'], ['usageLimited', '用量受限'], ['budgetLimited', '预算耗尽'], ['complete', '已完成']]) {
      await call('mock/goal', { threadId, status }); await expect(page.locator('#goal-state')).toContainText(label);
    }
    await call('mock/goalTurnEnd', { threadId });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({ path: 'test-results/goal-complete-widescreen.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#send')).toBeInViewport();
    await page.locator('#goal-clear').click(); await expect(page.locator('#goal-state')).toHaveCount(0);
    // A model/native tool can create a goal without clicking Goal or calling the Viewer write route.
    await page.locator('#prompt').fill('hold-tool'); await page.locator('#send').click(); await expect(page.locator('#stop')).toBeVisible();
    await call('thread/goal/set', { threadId, objective: '模型通过原生工具创建的目标', status: 'active', tokenBudget: 5000 });
    await expect(page.locator('#goal-state')).toContainText('模型通过原生工具创建的目标');
    await page.locator('#prompt').fill('保留尚未发送的草稿');
    await page.reload(); await expect(page.locator('#goal-state')).toContainText('模型通过原生工具创建的目标');
    await expect(page.locator('#prompt')).toHaveValue('保留尚未发送的草稿');
    await page.locator('#stop').click(); await expect(page.locator('#goal-state')).toContainText('已暂停');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
