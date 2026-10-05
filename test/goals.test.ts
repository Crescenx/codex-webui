import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj, Thread, ThreadGoal } from '../shared/protocol.ts';

async function setup() {
  const dir = await mkdtemp('/tmp/viewer-goals-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_FAKE_STATE: dir + '/native.json' } });
  const native = adapter.call.bind(adapter), calls: { method: string; params: Obj }[] = [];
  let intercept: ((method: string, params: Obj, result: Obj) => Promise<Obj>) | undefined;
  adapter.call = async (method, params = {}) => { calls.push({ method, params }); const result = await native(method, params); return intercept ? intercept(method, params, result) : result; };
  let restarts = 0;
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter, restart: async () => { restarts++; } });
  const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
  const http = (route: string, data?: Obj) => fetch(app.origin + '/api' + route, { method: data ? 'POST' : 'GET', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const { thread } = await (await http('/threads', { cwd: dir })).json();
  const route = '/threads/' + thread.id;
  return { dir, adapter, native, calls, http, route, id: thread.id as string, restarts: () => restarts,
    intercept(fn?: typeof intercept) { intercept = fn; },
    snapshot: async () => (await (await http(route + '/open', {})).json()).thread as Thread,
    goal: async () => (await (await http(route + '/goal')).json()).goal as ThreadGoal | null,
    close: async () => { await app.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 150; i++) { if (await check()) return; await delay(30); } assert.fail('condition did not settle'); }

test('goal lifecycle preserves native usage, syncs settings, pauses stop, and resumes only after replacement input', async () => {
  const h = await setup();
  try {
    for (const bad of [{ objective: '' }, { objective: 'x'.repeat(4001) }, { objective: 'x', tokenBudget: 0 }, { tokenBudget: -1 }, { tokenBudget: 1.5 }, { status: 'complete' }, {}])
      assert.equal((await h.http(h.route + '/goal', bad)).status, 400);
    assert.equal(h.calls.filter(c => c.method === 'thread/goal/set').length, 0);
    const settings = { model: 'mock-fast', effort: 'low', mode: 'plan' };
    assert.equal((await h.http(h.route + '/goal', { objective: '完成迁移并通过验收', tokenBudget: 1000, status: 'active', settings })).status, 200);
    const set = h.calls.findLastIndex(c => c.method === 'thread/goal/set');
    assert.deepEqual(h.calls.slice(0, set).findLast(c => c.method === 'thread/settings/update')!.params.collaborationMode,
      { mode: 'plan', settings: { model: 'mock-fast', reasoning_effort: 'low', developer_instructions: null } });
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 0, 'goal activation already starts a native turn');
    assert.equal((await h.snapshot()).turns!.length, 1);
    await h.native('mock/goal', { threadId: h.id, tokensUsed: 120, timeUsedSeconds: 65 });
    await h.http(h.route + '/goal', { status: 'paused' });
    assert.equal((await h.snapshot()).status?.type, 'active', 'pause leaves this turn running');
    assert.equal(h.calls.filter(c => c.method === 'turn/interrupt').length, 0);
    await h.http(h.route + '/goal', { tokenBudget: 2000 });
    assert.equal((await h.goal())!.tokensUsed, 120);
    await h.http(h.route + '/goal', { tokenBudget: null });
    assert.equal((await h.goal())!.tokenBudget, null);
    await h.http(h.route + '/goal', { status: 'active', settings });
    const first = (await h.snapshot()).turns!.at(-1)!;
    assert.equal((await h.http(h.route + '/turns', { text: 'hold-tool', attachments: [], delivery: 'interrupt', expectedTurnId: first.id, settings })).status, 200);
    const next = await h.snapshot();
    assert.equal(next.turns!.length, 2); assert.equal(next.goal!.status, 'active'); assert.equal(next.goal!.tokensUsed, 120);
    const lastSet = h.calls.findLastIndex(c => c.method === 'thread/goal/set');
    assert.ok(h.calls.findLastIndex(c => c.method === 'turn/start') < lastSet);
    assert.equal((await h.http(h.route + '/interrupt', {})).status, 200);
    assert.equal((await h.goal())!.status, 'paused');
    assert.equal((await h.snapshot()).turns!.at(-1)!.status, 'interrupted');
    await h.adapter.restart();
    assert.equal((await h.snapshot()).goal!.tokensUsed, 120, 'native goal survives backend reconnect');
    await h.http(h.route + '/goal', { objective: '新的验收目标', status: 'paused' });
    assert.equal((await h.goal())!.tokensUsed, 0);
    await h.http(h.route + '/goal/clear', {});
    assert.equal(await h.goal(), null);
    assert.equal((await h.snapshot()).turns!.length, 2);
  } finally { await h.close(); }
});

test('late reads and write replies cannot resurrect cleared goals; failed writes reconcile without replay', async () => {
  const h = await setup();
  try {
    await h.http(h.route + '/goal', { objective: 'race test', status: 'paused' });
    let once = true;
    h.intercept(async (method, p, result) => {
      if (method === 'thread/goal/get' && once) { once = false; await h.native('thread/goal/clear', p); }
      return result;
    });
    assert.equal(await h.goal(), null);
    h.intercept(async (method, p, result) => { if (method === 'thread/goal/set') await h.native('thread/goal/clear', p); return result; });
    const cleared = await (await h.http(h.route + '/goal', { objective: 'clear before reply', status: 'paused' })).json();
    assert.equal(cleared.goal, null);
    h.intercept(async (method, _p, result) => { if (method === 'thread/goal/set') throw new Error('Codex request timed out; check state before retrying'); return result; });
    const before = h.calls.filter(c => c.method === 'thread/goal/set').length;
    assert.equal((await h.http(h.route + '/goal', { objective: 'accepted once', status: 'paused' })).status, 502);
    assert.equal(h.calls.filter(c => c.method === 'thread/goal/set').length, before + 1);
    assert.equal((await h.snapshot()).goal!.objective, 'accepted once');
    h.intercept(async (method, _p, result) => { if (method === 'thread/goal/get') throw new Error('temporarily unavailable'); return result; });
    const failed = await h.snapshot();
    assert.equal(failed.goal!.objective, 'accepted once'); assert.match(failed.goalError!, /待同步/);
    assert.equal((await h.http(h.route + '/turns', { text: 'hold-tool', attachments: [] })).status, 200, 'goal reads do not block ordinary input');
    h.intercept();
    const goal = (await h.goal())!;
    assert.equal(goal.objective, 'accepted once');
  } finally { await h.close(); }
});

test('active goals block watchdog dispatch and restart between turns; running watchdogs block goal activation', async () => {
  const h = await setup();
  try {
    await h.http(h.route + '/goal', { objective: 'long task', status: 'active' });
    await h.native('mock/goalTurnEnd', { threadId: h.id });
    assert.equal((await h.http('/restart', {})).status, 409); assert.equal(h.restarts(), 0);
    const { watchdog } = await (await h.http('/watchdogs', { threadId: h.id, name: 'test', prompt: 'watchdog-hold', intervalMinutes: 60, model: 'mock', effort: 'medium' })).json();
    await h.http('/watchdogs/' + watchdog.id, { action: 'run_now', revision: watchdog.revision });
    await delay(1100);
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 0);
    await h.http(h.route + '/goal', { status: 'paused' });
    await until(async () => h.calls.some(c => c.method === 'turn/start'));
    assert.equal((await h.http(h.route + '/goal', { status: 'active' })).status, 409);
    assert.equal((await h.goal())!.status, 'paused');
    await h.http(h.route + '/interrupt', {});
  } finally { await h.close(); }
});

test('stop catches a goal continuation that starts while the pause request is in flight', async () => {
  const h = await setup();
  try {
    await h.http(h.route + '/goal', { objective: 'continuation race', status: 'active' });
    await h.native('mock/goalTurnEnd', { threadId: h.id });
    let once = true;
    h.intercept(async (method, _p, result) => {
      if (method === 'thread/goal/get' && once) { once = false; await h.native('thread/goal/set', { threadId: h.id, status: 'active' }); }
      return result;
    });
    assert.equal((await h.http(h.route + '/interrupt', {})).status, 200);
    const t = await h.snapshot();
    assert.equal(t.goal!.status, 'paused'); assert.equal(t.turns!.at(-1)!.status, 'interrupted');
    assert.equal(t.turns!.length, 2);
  } finally { await h.close(); }
});

test('failed interrupt-and-send leaves the goal paused; failed resume still acknowledges the submitted message', async () => {
  const h = await setup();
  try {
    await h.http(h.route + '/goal', { objective: 'keep this objective', status: 'active' });
    const turn = (await h.snapshot()).turns!.at(-1)!;
    const send = { text: 'hold-tool', attachments: [], delivery: 'interrupt', expectedTurnId: turn.id };
    h.intercept(async (method, _p, result) => { if (method === 'turn/interrupt') throw new Error('interrupt acknowledgement lost'); return result; });
    assert.equal((await h.http(h.route + '/turns', send)).status, 502);
    assert.equal((await h.goal())!.status, 'paused');
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 0);
    h.intercept(); await until(async () => (await h.snapshot()).turns!.at(-1)!.status === 'interrupted');
    await h.http(h.route + '/goal', { status: 'active' });
    send.expectedTurnId = (await h.snapshot()).turns!.at(-1)!.id;
    h.intercept(async (method, p, result) => { if (method === 'thread/goal/set' && p.status === 'active') throw new Error('resume acknowledgement lost'); return result; });
    const response = await h.http(h.route + '/turns', send);
    assert.equal(response.status, 200, 'a received message must not be offered for resubmission');
    assert.match((await response.json()).goalWarning, /消息已发送/);
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal((await h.goal())!.status, 'active', 'accepted resume is visible even if its acknowledgement was lost');
  } finally { await h.close(); }
});
