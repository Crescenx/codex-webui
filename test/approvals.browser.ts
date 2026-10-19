import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import type { Obj } from '../shared/protocol.ts';

test('MCP results remain readable as ordinary tool records', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-mcp-record-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    await adapter.call('mock/turn', { threadId: thread.id, turnId: 'mcp-record', items: [{ id: 'tool', type: 'mcpToolCall', server: 'fixture', tool: 'read', status: 'completed', appContext: { resourceUri: 'ui://legacy-app' }, result: { content: [{ type: 'text', text: 'Original tool evidence' }], structuredContent: { count: 2 } } }] });
    await page.goto(app.origin + '/#' + thread.id);
    await page.locator('.trace-toggle[data-turn-id="mcp-record"]').click();
    const tool = page.locator('[data-kind="mcpToolCall"]');
    await tool.locator('summary').click();
    await expect(tool).toContainText('Original tool evidence');
    await expect(tool).toContainText('"count": 2');
    await expect(page.getByRole('button', { name: '打开应用' })).toHaveCount(0);
    await expect(page.locator('iframe, #model-check')).toHaveCount(0);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

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

test('native MCP form and URL elicitations stay pending until submitted, declined or cancelled', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-mcp-prompts-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/form-data', runtimeDir: dir + '/form-run', port: 0, adapter });
  const responses: unknown[] = [];
  adapter.respond = (id, result) => { responses.push({ id, result }); };
  try {
    await page.goto(app.launchUrl);
    const headers = { origin: app.origin }, { thread } = await (await page.request.post(app.origin + '/api/threads', { headers, data: { cwd: dir } })).json();
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    adapter.emit('request', { id: 'form', method: 'mcpServer/elicitation/request', params: { threadId: thread.id, turnId: null, serverName: 'fixture', mode: 'form', message: 'Confirm fixture action', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: '名称', minLength: 2 }, count: { type: 'integer', title: '数量', minimum: 1 } }, required: ['name', 'count'], additionalProperties: false } } });
    const card = page.locator('#approvals .approval'); await expect(card).toContainText('Confirm fixture action');
    // Completion of an unrelated model turn must not discard a tool-originated request.
    await adapter.call('mock/turn', { threadId: thread.id, items: [] }); await expect(card).toBeVisible();
    await card.getByRole('button', { name: '提交', exact: true }).click(); expect(responses).toHaveLength(0);
    await card.getByLabel('名称', { exact: true }).fill('sample'); await card.getByLabel('数量', { exact: true }).fill('2');
    await card.getByRole('button', { name: '提交', exact: true }).click(); await expect(card).toHaveCount(0);
    expect(responses).toEqual([{ id: 'form', result: { action: 'accept', content: { name: 'sample', count: 2 }, _meta: null } }]);
    for (const [action, label] of [['decline', '拒绝'], ['cancel', '取消']]) {
      adapter.emit('request', { id: action, method: 'mcpServer/elicitation/request', params: { threadId: thread.id, turnId: null, serverName: 'fixture', mode: 'url', message: 'Open fixture URL', url: 'https://example.com/confirm', elicitationId: action } });
      await expect(card.getByRole('link')).toHaveAttribute('href', 'https://example.com/confirm');
      await card.getByRole('button', { name: label, exact: true }).click(); await expect(card).toHaveCount(0);
      expect(responses.at(-1)).toEqual({ id: action, result: { action, content: null, _meta: null } });
    }
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
