import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { fixtureUri } from '../test/mcp-fixture.ts';
import { record } from '../shared/mcp-apps.ts';

// No model turns, global configuration changes, or real external tool calls.
const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-native-mcp-'));
const adapter = new AppServer({ cwd: dir, env: { ...process.env, CODEX_HOME: dir }, args: ['app-server', '--listen', 'stdio://',
  '-c', `mcp_servers.viewer_fixture.command=${JSON.stringify(process.execPath)}`,
  '-c', `mcp_servers.viewer_fixture.args=${JSON.stringify([path.resolve('test/mcp-fixture.ts')])}`,
] });
try {
  const { thread } = await adapter.call('thread/start', { cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  const threadId = record(thread).id;
  const catalog = await adapter.call('mcpServerStatus/list', { threadId, detail: 'full' });
  const server = (catalog.data as Record<string, unknown>[]).find(server => server.name === 'viewer_fixture');
  assert.ok(server, 'Native MCP server was discovered');
  assert.ok(Object.values(record(server.tools)).some(tool => record(tool).name === 'show' && record(record(record(tool)._meta).ui).resourceUri === fixtureUri), 'Native catalog preserves tool UI metadata');
  const capabilities = JSON.parse(String(record(server.serverInfo).description));
  const negotiated = !!record(capabilities.extensions)['io.modelcontextprotocol/ui'];
  console.log('MCP UI capability forwarded:', negotiated);
  const resource = await adapter.call('mcpServer/resource/read', { threadId, server: 'viewer_fixture', uri: fixtureUri });
  assert.match(JSON.stringify(resource.contents), /native MCP resource/);
  const result = await adapter.call('mcpServer/tool/call', { threadId, server: 'viewer_fixture', tool: 'increment', arguments: { value: 2 } });
  assert.equal(record(result.structuredContent).value, 3);
  assert.equal(record(result._meta).private, 'native metadata');
  for (const action of ['accept', 'decline', 'cancel']) {
    let received = false;
    const respond = (request: { id: unknown; method: string; params: Record<string, unknown> }) => {
      assert.equal(request.method, 'mcpServer/elicitation/request'); assert.equal(request.params.threadId, threadId);
      received = true; adapter.respond(request.id, { action, content: action === 'accept' ? { approved: true } : null, _meta: null });
    };
    adapter.on('request', respond);
    try {
      const confirmed = await adapter.call('mcpServer/tool/call', { threadId, server: 'viewer_fixture', tool: 'confirm', arguments: {} });
      assert.ok(received); assert.equal(record(confirmed.structuredContent).action, action);
    } finally { adapter.off('request', respond); }
  }
  console.log('Native catalog, resource, app-only tool and accept/decline/cancel checks passed; no model turn started.');
  if (!negotiated) {
    console.warn('This Codex build does not forward MCP UI capabilities. Servers that gate UI metadata on negotiation will not offer apps.');
    if (process.argv.includes('--require-ui-negotiation')) process.exitCode = 1;
  }
} finally {
  const child = adapter.child;
  const closed = child && child.exitCode === null ? new Promise<void>(resolve => child.once('close', () => resolve())) : Promise.resolve();
  adapter.stop(); await closed; await rm(dir, { recursive: true, force: true });
}
