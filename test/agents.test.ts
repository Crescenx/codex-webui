import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { agentTree, mergeAgentHistory } from '../shared/agents.ts';
import type { Thread } from '../shared/protocol.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

test('agent hierarchy separates dispatch completion from execution and retains unknown states', () => {
  const root: Thread = { id: 'root', cwd: '/tmp', turns: [{ id: 'dispatch', status: 'completed', items: [{ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['a', 'missing'], prompt: 'check tests', agentsStates: { a: { status: 'completed' } } }] }] };
  const child: Thread = { id: 'a', cwd: '/tmp', parentThreadId: 'root', agentNickname: 'Alpha', status: { type: 'active' } };
  const grandchild: Thread = { id: 'b', cwd: '/tmp', source: { subAgent: { thread_spawn: { parent_thread_id: 'a' } } }, status: { type: 'notLoaded' } };
  const unrelated: Thread = { id: 'other', cwd: '/tmp', parentThreadId: 'elsewhere' };
  const tree = agentTree(root, [child, grandchild, unrelated]);
  assert.deepEqual(tree.map(a => [a.id, a.depth, a.state]), [['a', 0, 'running'], ['b', 1, 'unknown'], ['missing', 0, 'unknown']]);
  assert.equal(tree[0]!.task, 'check tests');
  assert.equal(agentTree(root, [child], new Set(['a']))[0]!.state, 'waiting');
  child.status = { type: 'idle' }; child.turns = [{ id: 'work', status: 'failed', items: [] }];
  assert.equal(agentTree(root, [child])[0]!.state, 'errored');
  child.turns[0]!.status = 'interrupted'; assert.equal(agentTree(root, [child])[0]!.state, 'interrupted');
});

test('a stale rollout cannot erase live output; a later snapshot repairs missed completion', () => {
  const live: Thread = { id: 'a', cwd: '/tmp', status: { type: 'active' }, turns: [{ id: 'work', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'live output' }] }] };
  const fresh = structuredClone(live); fresh.turns![0]!.items[0]!.text = 'live';
  fresh.turns!.unshift({ id: 'older', status: 'completed', items: [] });
  const merged = mergeAgentHistory(fresh, live, true);
  assert.equal(merged.turns!.at(-1)!.items[0]!.text, 'live output'); assert.equal(merged.turns!.length, 2);
  fresh.status = { type: 'idle' }; fresh.turns!.at(-1)!.status = 'completed'; fresh.turns!.at(-1)!.items[0]!.text = 'live output finished';
  assert.equal(mergeAgentHistory(fresh, live, false).turns!.at(-1)!.status, 'completed');
  assert.equal(mergeAgentHistory(fresh, live, false).turns!.at(-1)!.items[0]!.text, 'live output finished');
  assert.equal(mergeAgentHistory(fresh, live, true).status!.type, 'active');
});

test('subagent reads include nested history, enforce directory boundaries and never resume or execute', async () => {
  const dir = await mkdtemp('/tmp/viewer-agents-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const get = (route: string) => fetch(app.origin + '/api' + route, { headers: { Cookie: cookie } });
    const root = (await adapter.call('thread/start', { cwd: dir })).thread as Thread;
    await adapter.call('mock/agent', { threadId: root.id, id: 'child', silent: true });
    await adapter.call('mock/agent', { threadId: 'child', id: 'grandchild', silent: true });
    await adapter.call('mock/agent', { threadId: root.id, id: 'outside', cwd: '/etc', silent: true });
    const calls: string[] = [], call = adapter.call.bind(adapter);
    adapter.call = async (method, params) => { calls.push(method); return call(method, params); };
    const list = await (await get(`/threads/${root.id}/subagents`)).json();
    assert.deepEqual(list.data.map((t: Thread) => t.id), ['child', 'grandchild']);
    const ordinary = await (await get('/threads')).json(); assert.deepEqual(ordinary.data.map((t: Thread) => t.id), [root.id]);
    await get('/threads/child?refresh=1');
    await call('mock/agentEvent', { threadId: 'child', delta: 'live output' });
    const snapshot = await (await get('/threads/child?refresh=1')).json();
    assert.equal(snapshot.thread.turns.at(-1).items.at(-1).text, 'live output');
    assert.equal((await get('/threads/outside?refresh=1')).status, 403);
    assert.ok(calls.every(m => ['thread/read', 'thread/list', 'thread/goal/get'].includes(m)), calls.join(','));
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
