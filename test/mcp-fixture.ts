import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Obj } from '../shared/protocol.ts';
import type { AppServer } from '../server/adapter.ts';

export const fixtureUri = 'ui://viewer-fixture/app';
export const fixtureTools = {
  show: { name: 'show', title: '交互测试', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: fixtureUri } } },
  increment: { name: 'increment', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }, _meta: { ui: { visibility: ['app'], resourceUri: fixtureUri } } },
  hidden: { name: 'hidden', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } },
  confirm: { name: 'confirm', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
};
export function fixtureResource(html: string) {
  return { contents: [{ uri: fixtureUri, mimeType: 'text/html;profile=mcp-app', text: html, _meta: { ui: { csp: {} } } }] };
}
export function installMcpFixture(adapter: AppServer, html: string) {
  const call = adapter.call.bind(adapter), calls: { method: string; params: Obj }[] = [];
  adapter.call = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'fixture', tools: fixtureTools, resources: [], resourceTemplates: [], authStatus: 'unsupported' }], nextCursor: null };
    if (method === 'mcpServer/resource/read') return params.uri === fixtureUri ? fixtureResource(html) : { contents: [{ uri: params.uri, text: 'resource data' }] };
    if (method === 'mcpServer/tool/call') return { content: [{ type: 'text', text: String(Number((params.arguments as Obj).value) + 1) }], structuredContent: { value: Number((params.arguments as Obj).value) + 1 }, _meta: { private: 'app-only result' } };
    return call(method, params);
  };
  return calls;
}

// A local stdio MCP server for the opt-in native smoke check. No model or account is needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let ui = false;
  const waiting = new Map<string, unknown>();
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line), p = m.params || {};
    if (m.id === undefined) return;
    if (!m.method) {
      if (waiting.has(String(m.id))) { send({ id: waiting.get(String(m.id)), jsonrpc: '2.0', result: { content: [{ type: 'text', text: m.result?.action || 'error' }], structuredContent: m.result || {} } }); waiting.delete(String(m.id)); }
      return;
    }
    let result: unknown;
    if (m.method === 'initialize') { ui = p.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes?.includes('text/html;profile=mcp-app') === true; result = { protocolVersion: p.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'viewer-fixture', version: '1.0.0', description: JSON.stringify(p.capabilities) } }; }
    else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: Object.values(fixtureTools).map(tool => process.env.VIEWER_MCP_REQUIRE_UI && !ui ? { ...tool, _meta: undefined } : tool) };
    else if (m.method === 'resources/list') result = { resources: [{ uri: fixtureUri, name: 'app', mimeType: 'text/html;profile=mcp-app' }] };
    else if (m.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (m.method === 'resources/read') result = fixtureResource(process.env.VIEWER_MCP_FIXTURE_HTML ? readFileSync(process.env.VIEWER_MCP_FIXTURE_HTML, 'utf8') : '<html><body>native MCP resource</body></html>');
    else if (m.method === 'tools/call' && p.name === 'confirm') {
      const id = 'confirmation-' + m.id; waiting.set(id, m.id);
      send({ id, jsonrpc: '2.0', method: 'elicitation/create', params: { mode: 'form', message: 'Local fixture confirmation', requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] } } }); return;
    }
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'native MCP tool result' }], structuredContent: { value: Number(p.arguments?.value || 0) + 1 }, _meta: { private: 'native metadata' } };
    else { process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', error: { code: -32601, message: 'Unsupported method' } }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }) + '\n');
  });
}
