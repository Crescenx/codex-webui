import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj, Thread } from '../shared/protocol.ts';

// Real Codex engine and Viewer, deterministic local model transport; no credentials or paid requests.
const dir = await mkdtemp('/tmp/viewer-native-goals-');
let requests = 0;
let targetId = '';
const names = new Set<string>();
const provider = createServer((req, res) => {
  void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const main = body.client_metadata?.thread_id === targetId;
    const walk = (value: unknown) => { if (!value || typeof value !== 'object') return; const obj = value as Obj; if (typeof obj.name === 'string') names.add(obj.name); for (const v of Object.values(obj)) walk(v); };
    walk(body.tools);
    // Current Codex also supplies native tool declarations in the developer input.
    if (main && requests === 0) for (const name of ['create_goal', 'get_goal', 'update_goal']) if (JSON.stringify(body.input).includes(name)) names.add(name);
    const n = main ? ++requests : 0;
    const item = n === 1 || n === 3 ? { type: 'function_call', id: 'fc-' + n, call_id: 'call-' + n, name: n === 1 ? 'create_goal' : 'update_goal', arguments: JSON.stringify(n === 1 ? { objective: '验证原生 Goal 跨轮续跑并完成', token_budget: 2000 } : { status: 'complete' }), status: 'completed' }
      : { type: 'message', id: 'msg-' + n, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: !main ? JSON.stringify({ title: '原生 Goal 验证' }) : n === 2 ? '第一轮检查完成，继续下一轮验证。' : '原生 Goal 验证完成。', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: Obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { id: 'response-' + n, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'response-' + n, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.end();
  })().catch(error => { res.writeHead(500); res.end(String(error)); });
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address(); assert.ok(address && typeof address !== 'string');
const config = { model_provider: 'goal_probe', model: 'gpt-5.6-sol', 'model_providers.goal_probe.name': 'Goal probe',
  'model_providers.goal_probe.base_url': `http://127.0.0.1:${address.port}/v1`, 'model_providers.goal_probe.wire_api': 'responses',
  'features.enable_request_compression': false, check_for_update_on_startup: false };
const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: dir + '/codex' }; delete env.OPENAI_API_KEY;
for (const key of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
env.NO_PROXY = '127.0.0.1,localhost';
await mkdir(env.CODEX_HOME!, { mode: 0o700 });
const adapter = new AppServer({ cwd: dir, env, args: ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([k, v]) => ['-c', k + '=' + JSON.stringify(v)])] });
const states: string[] = [], turns = new Set<string>(), errors: unknown[] = [];
adapter.on('notice', n => { if (n.params.threadId !== targetId) return; if (n.method === 'thread/goal/updated') states.push(n.params.goal.status); if (n.method === 'turn/completed') { turns.add(n.params.turn.id); if (n.params.turn.error) errors.push(n.params.turn.error); } if (n.method === 'error') errors.push(n.params); });
const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter, codexHome: env.CODEX_HOME });
try {
  const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
  const http = async (route: string, data?: Obj) => {
    const r = await fetch(app.origin + '/api' + route, { method: data ? 'POST' : 'GET', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result;
  };
  const { thread } = await http('/threads', { cwd: dir });
  targetId = thread.id;
  const route = '/threads/' + thread.id;
  await http(route + '/goal', { objective: '暂停状态下检查预算接口', status: 'paused', tokenBudget: 100 });
  await http(route + '/goal', { tokenBudget: null }); assert.equal((await http(route + '/goal')).goal.tokenBudget, null);
  await http(route + '/goal/clear', {}); assert.equal(requests, 0);
  // The natural-language input follows the ordinary message path, without any Viewer goal write.
  await http(route + '/turns', { text: '请创建 Goal：验证原生 Goal 跨轮续跑并完成，token 预算 2000。第一轮报告检查完成，第二轮确认完成目标。', attachments: [] });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !errors.length && (!states.includes('complete') || turns.size < 2)) await delay(100);
  assert.ok(names.has('create_goal') && names.has('get_goal') && names.has('update_goal'), 'native goal tools must be available: ' + JSON.stringify({ names: [...names], errors, requests, states }));
  assert.ok(states.includes('active') && states.includes('complete'), JSON.stringify({ states, requests }));
  assert.equal(turns.size, 2, 'Codex must continue the active goal across turns');
  const before = (await http(route + '/open', {})).thread as Thread;
  assert.equal(before.goal!.status, 'complete'); assert.ok(before.goal!.tokensUsed !== null && before.goal!.tokensUsed > 0);
  await adapter.restart();
  const after = (await http(route + '/open', {})).thread as Thread;
  assert.equal(after.goal!.status, 'complete'); assert.equal(after.goal!.tokensUsed, before.goal!.tokensUsed);
  console.log('Native goal tools, natural-language message path, automatic continuation, usage, budget clearing, and restart recovery passed.');
} finally { await app.stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
