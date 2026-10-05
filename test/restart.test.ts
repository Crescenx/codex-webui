import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Thread } from '../shared/protocol.ts';

test('restart replaces the process once, preserves launch options, and can recover after launch failure', async () => {
  const dir = await mkdtemp('/tmp/viewer-restart-adapter-');
  const entry = path.join(dir, 'codex.mjs');
  const source = "import { createInterface } from 'node:readline'; createInterface({input:process.stdin}).on('line', l => {const m=JSON.parse(l); if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid,setting:process.env.VIEWER_RESTART_TEST}})+'\\n');});";
  const adapter = new AppServer({ command: process.execPath, args: [entry] });
  adapter.configureLaunch({ env: { VIEWER_RESTART_TEST: 'preserved' } });
  try {
    await writeFile(entry, source);
    const before = await adapter.call('probe');
    let starts = 0; adapter.on('online', () => starts++);
    const restart = adapter.restart();
    assert.equal(adapter.restart(), restart);
    const [after] = await Promise.all([adapter.call('probe'), restart]);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.setting, 'preserved'); assert.equal(starts, 1);
    await rm(entry);
    await assert.rejects(adapter.restart(), /process exited/);
    await writeFile(entry, source);
    await adapter.restart(); assert.equal(starts, 2);
    adapter.stop(); await assert.rejects(adapter.restart(), /stopped/);
  } finally { adapter.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('restart checks authorization, all native threads, in-flight requests, and saved history before replacing Codex', async () => {
  const dir = await mkdtemp('/tmp/viewer-restart-server-');
  const stateFile = path.join(dir, 'state.json');
  const makeAdapter = () => new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_FAKE_STATE: stateFile } });
  let adapter = makeAdapter();
  let app: Awaited<ReturnType<typeof serve>>;
  let restartFailure = false;
  const launch = () => serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter, restart: async state => {
    if (restartFailure) throw new Error('replacement failed');
    await app.stop(); adapter = makeAdapter(); process.env.VIEWER_RESTART_STATE = state; app = await launch();
  } });
  app = await launch();
  let release = () => {};
  try {
    await adapter.start();
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const post = (url: string, data: unknown = {}, origin = app.origin) => fetch(app.origin + '/api' + url, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await fetch(app.origin + '/api/restart', { method: 'POST', headers: { origin: app.origin } })).status, 401);
    assert.equal((await post('/restart', {}, 'https://evil.example')).status, 403);
    assert.equal((await post('/restart', [])).status, 400);
    const { thread } = await (await post('/threads', { cwd: dir })).json();
    const pid = adapter.child!.pid;
    // This loaded native thread is deliberately absent from the bridge's cache.
    const hidden = (await adapter.call('thread/start', { cwd: dir })).thread as Thread;
    const { turn } = await adapter.call('turn/start', { threadId: hidden.id, input: [{ type: 'text', text: 'hold-tool' }] });
    assert.equal((await post('/restart')).status, 409); assert.equal(adapter.child!.pid, pid);
    const completion = new Promise<void>(resolve => {
      const finished = (n: { method: string }) => { if (n.method === 'turn/completed') { adapter.off('notice', finished); resolve(); } };
      adapter.on('notice', finished);
    });
    await adapter.call('turn/interrupt', { threadId: hidden.id, turnId: (turn as { id: string }).id }); await completion;
    const call = adapter.call.bind(adapter);
    let held = 'thread/read';
    adapter.call = async (method, params = {}) => {
      if (method === held) { held = ''; await new Promise<void>(resolve => { release = resolve; }); }
      return call(method, params);
    };
    const opening = post(`/threads/${hidden.id}/open`);
    while (held) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post('/restart')).status, 409);
    release(); assert.equal((await opening).status, 200);
    held = 'thread/loaded/list';
    const restarting = post('/restart');
    while (held) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post('/restart')).status, 409);
    assert.equal((await post(`/threads/${thread.id}/turns`, { text: 'must not run', attachments: [] })).status, 409);
    release(); assert.equal((await restarting).status, 202);
    for (let i = 0; i < 100 && (!adapter.child || adapter.child.pid === pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual(adapter.child!.pid, pid);
    assert.equal((await post(`/threads/${hidden.id}/open`)).status, 200);
    const restored = await (await post(`/threads/${thread.id}/open`)).json();
    assert.equal(restored.thread.id, thread.id); assert.equal(restored.thread.turns.length, 0);
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved.threads.find((t: Thread) => t.id === hidden.id).turns.length, 1);
    const replacementCall = adapter.call.bind(adapter);
    adapter.call = async (method, params = {}) => {
      if (method === 'thread/read') throw new Error('no rollout found');
      return replacementCall(method, params);
    };
    const replacement = adapter.child!.pid;
    assert.equal((await post('/restart')).status, 409); assert.equal(adapter.child!.pid, replacement);
    adapter.call = replacementCall; restartFailure = true;
    assert.equal((await post('/restart')).status, 202);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await post(`/threads/${hidden.id}/open`)).status, 200);
  } finally { release(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
