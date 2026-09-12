import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import type { Obj } from '../shared/protocol.ts';

test('approval reasons, scoped persistent choices and widescreen layout', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-approval-ui-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const replies: Obj[] = []; adapter.respond = (_, result) => { replies.push(result); };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    const id = (thread as Obj).id;
    await page.goto(app.launchUrl + '#' + id); await expect(page.locator('#cwd')).toHaveText(dir);
    const inject = (params: Obj, method = 'item/commandExecution/requestApproval') => adapter.emit('request', { id: 'controlled', method, params: { threadId: id, turnId: 'turn', cwd: dir, ...params } });
    inject({ command: 'ssh test-host status', reason: '查询远端任务状态，需要网络访问。', proposedExecpolicyAmendment: ['ssh', 'test-host'] });
    const card = page.locator('.approval');
    await expect(card).toContainText('申请原因：查询远端任务状态，需要网络访问。');
    await expect(card).toContainText('ssh test-host status');
    await card.locator('summary').click();
    await expect(card).toContainText('跨会话生效'); await expect(card).toContainText('["ssh","test-host"]');
    await page.screenshot({ path: 'test-results/approval-scopes-desktop.png' });
    await page.setViewportSize({ width: 1920, height: 844 });
    await card.getByRole('button', { name: '允许并保存命令规则', exact: true }).scrollIntoViewIfNeeded();
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/approval-scopes-widescreen.png' });
    await card.getByRole('button', { name: '允许并保存命令规则', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect(replies[0]).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ssh', 'test-host'] } } });
    inject({ permissions: { network: { enabled: true } }, reason: '本会话需要访问网络' }, 'item/permissions/requestApproval');
    await card.locator('summary').click(); await card.getByRole('button', { name: '本会话允许', exact: true }).click();
    await expect(card).toHaveCount(0); expect(replies[1]).toEqual({ permissions: { network: { enabled: true } }, scope: 'session' });
    inject({ command: 'sco --help', availableDecisions: ['accept', 'decline', 'cancel'] });
    await expect(card).toContainText('Codex 未提供具体原因'); await expect(card.locator('summary')).toHaveCount(0);
    await card.getByRole('button', { name: '拒绝', exact: true }).click(); await expect(card).toHaveCount(0);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
