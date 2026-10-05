import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { appCsp, sandboxCsp } from '../server/mcp-apps.ts';
import { installMcpFixture } from './mcp-fixture.ts';

test('MCP Apps enforce original call, session ownership, tool schema and visibility, and defer context to user input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-mcp-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const calls = installMcpFixture(adapter, '<html><body>test</body></html>');
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (url: string, data?: unknown, owner = cookie) => fetch(app.origin + '/api' + url, { method: data === undefined ? 'GET' : 'POST', headers: { cookie: owner, origin: app.origin, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const { thread } = await (await request('/threads', { cwd: dir })).json();
    const { turn } = await adapter.call('mock/mcpApp', { threadId: thread.id }) as { turn: { id: string } };
    const target = { threadId: thread.id, turnId: turn.id, itemId: 'app-item' }, base = `/threads/${thread.id}/mcp-apps/${turn.id}/app-item`;
    const described = await (await request(base)).json(); assert.equal(described.app.resourceUri, 'ui://viewer-fixture/app');
    assert.equal(calls.filter(c => c.method === 'mcpServer/resource/read').length, 0);
    const view = await (await request(base + '/open', {})).json(); assert.match(view.sandboxUrl, /^http:\/\/[a-f0-9]+\.localhost:\d+\/$/);
    assert.equal(view.html, '<html><body>test</body></html>');
    assert.equal((await request(base.replace('app-item', 'missing') + '/open', {})).status, 404);
    assert.equal((await request(`/mcp-apps/${view.id}/rpc`, { method: 'tools/call', params: { name: 'hidden' } })).status, 403);
    assert.equal((await request(`/mcp-apps/${view.id}/rpc`, { method: 'tools/call', params: { name: 'increment', arguments: { value: 'bad' } } })).status, 400);
    assert.equal((await request(`/mcp-apps/${view.id}/rpc`, { method: 'fs/readFile', params: {} })).status, 400);
    const result = await (await request(`/mcp-apps/${view.id}/rpc`, { method: 'tools/call', params: { name: 'increment', arguments: { value: 2 }, _meta: { threadId: 'other' }, server: 'other' } })).json();
    assert.equal(result.structuredContent.value, 3);
    assert.deepEqual(calls.findLast(c => c.method === 'mcpServer/tool/call')!.params, { threadId: thread.id, server: 'fixture', tool: 'increment', arguments: { value: 2 } });
    assert.equal((await request(`/mcp-apps/${view.id}/rpc`, { method: 'tools/call', params: {} }, '')).status, 401);
    const otherCookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request(`/mcp-apps/${view.id}/rpc`, { method: 'resources/list', params: {} }, otherCookie)).status, 410);
    const before = calls.filter(c => c.method === 'turn/start').length;
    const context = { ...target, context: { content: [{ type: 'text', text: 'selection' }], structuredContent: { value: 3 } } };
    assert.equal((await request(`/threads/${thread.id}/turns`, { text: 'question', attachments: [], appContexts: [{ ...context, threadId: 'other' }] })).status, 400);
    assert.equal(calls.filter(c => c.method === 'turn/start').length, before);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const image = { type: 'image', data: png, mimeType: 'image/png' };
    for (const bad of [{ ...image, mimeType: 'image/jpeg' }, { ...image, data: '<svg>script</svg>' }, { ...image, data: 'a'.repeat(5_592_409) }, { ...image, data: png + '!' }]) {
      assert.equal((await request(`/threads/${thread.id}/turns`, { text: 'question', attachments: [], appContexts: [{ ...context, context: { content: [bad] } }] })).status, 400);
    }
    const imageContext = { ...context, context: { ...context.context, content: [...context.context.content, image] } };
    const started = await request(`/threads/${thread.id}/turns`, { text: 'hold-tool', attachments: [], appContexts: [imageContext] }); assert.equal(started.status, 200);
    const active = await started.json();
    const added = calls.findLast(c => c.method === 'turn/start')!.params.additionalContext as Record<string, { kind: string; value: string }>;
    assert.equal(added[`mcp-app:${turn.id}:app-item`].kind, 'untrusted'); assert.match(added[`mcp-app:${turn.id}:app-item`].value, /selection/);
    assert.ok(!JSON.stringify(added).includes(png));
    assert.deepEqual((calls.findLast(c => c.method === 'turn/start')!.params.input as { type: string }[]).filter(p => p.type === 'image'), [{ type: 'image', url: 'data:image/png;base64,' + png }]);
    assert.equal((await request(`/threads/${thread.id}/turns`, { text: 'followup', attachments: [], delivery: 'steer', expectedTurnId: active.turn.id, appContexts: [imageContext] })).status, 200);
    const steered = calls.findLast(c => c.method === 'turn/steer')!.params;
    assert.deepEqual((steered.input as { type: string }[]).filter(p => p.type === 'image'), [{ type: 'image', url: 'data:image/png;base64,' + png }]);
    assert.ok(!JSON.stringify(steered.additionalContext).includes(png));
    await request(`/mcp-apps/${view.id}/close`, {});
    assert.equal((await request(`/mcp-apps/${view.id}/keepalive`, {})).status, 410);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('sandbox CSP rejects local origins and directive injection without weakening the Viewer', () => {
  for (const value of ['*', 'http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://0177.0.0.1', "https://example.com; script-src *", 'https://example.com\n']) assert.throws(() => appCsp({ connectDomains: [value] }));
  const csp = sandboxCsp(appCsp({ resourceDomains: ['https://cdn.example.com'], connectDomains: ['https://api.example.com'] }), 'http://127.0.0.1:8787');
  assert.match(csp, /connect-src https:\/\/api.example.com/); assert.match(csp, /form-action 'none'/); assert.doesNotMatch(csp, /'unsafe-eval'/);
});
