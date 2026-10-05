import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { installMcpFixture } from './mcp-fixture.ts';
import type { Item } from '../shared/protocol.ts';

let dir: string, html: string;
test.beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-mcp-browser-'));
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir + '/fixture', lib: { entry: path.resolve('test/mcp-fixture-app.ts'), formats: ['iife'], name: 'Fixture', fileName: () => 'fixture.js' } } });
  const script = await readFile(dir + '/fixture/fixture.js', 'utf8');
  html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' + script.replaceAll('</script', '<\\/script') + '</script></body></html>';
});
test.afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('standard SDK app: tool/resource calls, message preview, context, isolation, scrolling, and teardown', async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const calls = installMcpFixture(adapter, html);
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(app.launchUrl);
    const headers = { origin: app.origin };
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { headers, data: { cwd: dir } })).json();
    await page.goto(app.origin + '/#' + thread.id);
    await expect(page.locator('#send')).toBeEnabled();
    await adapter.call('mock/mcpApp', { threadId: thread.id, turnId: 'first-app' });
    await page.locator('.trace-toggle[data-turn-id="first-app"]').click();
    await expect(page.getByRole('button', { name: '打开应用' })).toBeVisible();
    expect(calls.filter(c => c.method === 'mcpServer/resource/read')).toHaveLength(0);
    await page.getByRole('button', { name: '打开应用' }).click();
    const outer = page.frameLocator('.mcp-app > iframe').first(), inner = outer.frameLocator('iframe');
    await expect(inner.locator('#value')).toHaveText('1');
    await expect(inner.locator('#input')).toContainText('initial');
    await expect(inner.locator('#private')).toContainText('original metadata');
    const instance = await inner.locator('body').evaluate(() => (window as unknown as { fixtureInstance: string }).fixtureInstance);
    await page.locator('.trace-toggle[data-turn-id="first-app"]').click();
    await expect(inner.locator('#value')).toHaveText('1');
    expect(await inner.locator('body').evaluate(() => (window as unknown as { fixtureInstance: string }).fixtureInstance)).toBe(instance);
    await page.locator('.trace-toggle[data-turn-id="first-app"]').click();
    await inner.getByRole('button', { name: 'Increment', exact: true }).click(); await expect(inner.locator('#value')).toHaveText('2');
    await inner.getByRole('button', { name: 'Update context', exact: true }).click(); await expect(inner.locator('#status')).toHaveText('ok');
    await inner.getByRole('button', { name: 'Image context', exact: true }).click();
    await expect(page.locator('.mcp-app')).toContainText('应用已提供 1 张图片');
    await inner.getByRole('button', { name: 'Forbidden tool', exact: true }).click(); await expect(inner.locator('#status')).toContainText('不允许应用调用');
    await inner.getByRole('button', { name: 'Read resource', exact: true }).click(); await expect(inner.locator('#value')).toContainText('resource data');
    const starts = calls.filter(c => c.method === 'turn/start').length;
    await page.locator('#prompt').fill('existing draft');
    await inner.getByRole('button', { name: 'Send message', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '应用消息预览' }); await expect(dialog).toBeVisible();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(starts);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await inner.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(dialog).toBeVisible();
    await dialog.locator('textarea').fill('edited app message'); await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.locator('#prompt')).toHaveValue('existing draft');
    const sent = calls.findLast(c => c.method === 'turn/start')!.params;
    expect(JSON.stringify(sent.input)).toContain('edited app message'); expect(JSON.stringify(sent.additionalContext)).toContain('selected value 2');
    const sentImage = (sent.input as { type: string; url?: string }[]).find(p => p.type === 'image');
    expect(sentImage?.url).toMatch(/^data:image\/png;base64,/); expect(sentImage!.url!.length).toBeGreaterThan(1_048_576);
    expect(JSON.stringify(sent.additionalContext)).not.toContain('base64');
    expect((sent.input as { type: string }[]).filter(p => p.type === 'image')).toHaveLength(1);
    await expect(page.locator('#send')).toBeEnabled();
    // A real second instance uses its own origin; identical apps cannot inspect one another.
    await adapter.call('mock/mcpApp', { threadId: thread.id, turnId: 'second-app' });
    await page.locator('.trace-toggle[data-turn-id="second-app"]').click();
    await expect(page.locator('.trace-toggle[data-turn-id="second-app"]')).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '打开应用' }).click();
    const frames = page.locator('.mcp-app > iframe'); await expect(frames).toHaveCount(2);
    const second = page.frameLocator('.mcp-app > iframe').nth(1).frameLocator('iframe'); await expect(second.locator('#value')).toHaveText('1');
    const urls = await frames.evaluateAll(elements => elements.map(e => (e as HTMLIFrameElement).src)); expect(new URL(urls[0]).origin).not.toBe(new URL(urls[1]).origin);
    const isolation = await inner.locator('body').evaluate(async (_, viewerOrigin) => {
      let host = false, sibling = false, api = false;
      try { void window.top!.document.body; host = true; } catch {}
      try { void window.top!.frames[1].document.body; sibling = true; } catch {}
      try { await fetch(viewerOrigin + '/api/threads', { credentials: 'include' }); api = true; } catch {}
      return { host, sibling, api, cookie: document.cookie };
    }, app.origin);
    expect(isolation).toEqual({ host: false, sibling: false, api: false, cookie: '' });
    // A forged host message and a message from a sibling source must not reach the bridge.
    const toolCalls = calls.filter(c => c.method === 'mcpServer/tool/call').length;
    await page.evaluate(() => window.postMessage({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name: 'increment', arguments: { value: 900 } } }, location.origin));
    await inner.locator('#scratch').fill('keep this');
    const padding: Item[] = Array.from({ length: 160 }, (_, i) => ({ id: 'padding-' + i, type: 'agentMessage', text: 'Long history row ' + i + '\n\n' + 'text '.repeat(100) }));
    await adapter.call('mock/mcpApp', { threadId: thread.id, turnId: 'padding', items: padding });
    await page.locator('#conversation').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(frames).toHaveCount(2);
    const body = inner.locator('body');
    expect(await body.evaluate(() => (window as unknown as { fixtureInstance: string }).fixtureInstance)).toBe(instance);
    await expect(inner.locator('#scratch')).toHaveValue('keep this');
    expect(calls.filter(c => c.method === 'mcpServer/tool/call')).toHaveLength(toolCalls);
    // Cyclic structured-clone payloads from the actual app cannot break the listener.
    await body.evaluate(() => { const data: Record<string, unknown> = { jsonrpc: '2.0' }; data.loop = data; window.parent.postMessage(data, window.parent.location.origin); });
    await page.getByRole('button', { name: '关闭应用' }).first().click(); await expect(frames).toHaveCount(1);
    await page.getByRole('button', { name: '打开应用' }).first().click(); await expect(frames).toHaveCount(2);
    await expect(inner.locator('#value')).toHaveText('1');
    expect(await inner.locator('body').evaluate(() => (window as unknown as { fixtureInstance: string }).fixtureInstance)).not.toBe(instance);
    await expect(inner.locator('#scratch')).toHaveValue('');
    const secondThread = await (await page.request.post(app.origin + '/api/threads', { headers, data: { cwd: dir } })).json();
    await page.goto(app.origin + '/#' + secondThread.thread.id); await expect(frames).toHaveCount(0);
    // Main HTTP routes retain script restrictions and authenticated access.
    expect((await page.request.get(app.origin)).headers()['content-security-policy']).toContain("script-src 'self';");
    expect(errors).toEqual([]);
  } finally { await app.stop(); }
});

test('native MCP form and URL elicitations stay pending until submitted, declined or cancelled', async ({ page }) => {
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
    await adapter.call('mock/mcpApp', { threadId: thread.id, items: [] }); await expect(card).toBeVisible();
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
  } finally { await app.stop(); }
});

test('resource failures, readonly subagents, and live tool failure/cancellation retain honest app states', async ({ page }) => {
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  installMcpFixture(adapter, html);
  const app = await serve({ roots: [dir], dataDir: dir + '/readonly-data', runtimeDir: dir + '/readonly-run', port: 0, adapter });
  try {
    await page.goto(app.launchUrl);
    const headers = { origin: app.origin }, { thread } = await (await page.request.post(app.origin + '/api/threads', { headers, data: { cwd: dir } })).json();
    const { thread: child } = await adapter.call('mock/agent', { threadId: thread.id }) as { thread: { id: string } };
    const { turn } = await adapter.call('mock/mcpApp', { threadId: child.id }) as { turn: { id: string } };
    const base = `/api/threads/${child.id}/mcp-apps/${turn.id}/app-item`;
    const view = await (await page.request.post(app.origin + base + '/open', { headers, data: {} })).json();
    expect(view.readonly).toBe(true);
    const denied = await page.request.post(app.origin + `/api/mcp-apps/${view.id}/rpc`, { headers, data: { method: 'tools/call', params: { name: 'increment', arguments: { value: 1 } } } });
    expect(denied.status()).toBe(403);
    const call = adapter.call.bind(adapter);
    adapter.call = async (method, params) => { if (method === 'mcpServer/resource/read') throw new Error('fixture resource failed'); return call(method, params); };
    await page.goto(app.origin + '/#' + thread.id); await expect(page.locator('#send')).toBeEnabled();
    const failedApp = await adapter.call('mock/mcpApp', { threadId: thread.id }) as { turn: { id: string } };
    await page.locator(`.trace-toggle[data-turn-id="${failedApp.turn.id}"]`).click();
    await page.getByRole('button', { name: '打开应用' }).click(); await expect(page.locator('.mcp-app')).toContainText('fixture resource failed');
    await page.locator('[data-kind="mcpToolCall"] summary').click(); await expect(page.locator('[data-kind="mcpToolCall"]')).toContainText('original result');
    await expect(page.locator('#send')).toBeEnabled();
    await page.getByRole('button', { name: '关闭应用' }).click(); adapter.call = call;
    for (const outcome of ['failed', 'interrupted']) {
      const pending: Item = { id: 'live-' + outcome, type: 'mcpToolCall', server: 'fixture', tool: 'show', status: 'inProgress', arguments: { initial: true }, appContext: { resourceUri: 'ui://viewer-fixture/app' } };
      const { turn } = await adapter.call('mock/mcpApp', { threadId: thread.id, turnId: outcome, status: 'inProgress', items: [pending] }) as { turn: { id: string } };
      await page.locator(`[data-turn-id="${turn.id}"]`).getByRole('button', { name: '打开应用' }).click();
      const inner = page.locator(`[data-turn-id="${turn.id}"] .mcp-app > iframe`).contentFrame().frameLocator('iframe');
      await expect(inner.locator('#input')).toContainText('initial'); await expect(inner.locator('#value')).toHaveText('waiting');
      adapter.emit('notice', { method: 'turn/completed', params: { threadId: thread.id, turn: { id: turn.id, status: outcome, items: [{ ...pending, ...(outcome === 'failed' ? { status: 'failed', error: { message: 'native failure' } } : {}) }] } } });
      await expect(inner.locator('#status')).toHaveText(outcome === 'failed' ? 'tool error' : 'cancelled');
      await page.locator(`[data-turn-id="${turn.id}"]`).getByRole('button', { name: '关闭应用' }).click();
    }
  } finally { await app.stop(); }
});
