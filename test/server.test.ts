import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { reduceNotice, windowsEvidence } from '../shared/protocol.ts';
import { directoryPath } from '../server/files.ts';
import type { Notice, Thread } from '../shared/protocol.ts';

test('authentication renews both deadlines on access, but never revives an expired or invalid cookie', async t => {
  const dir = await mkdtemp('/tmp/viewer-auth-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const read = () => fetch(app.origin + '/api/watchdogs', { headers: { cookie } });
    now += 23 * 3600_000;
    const renewed = await read(); assert.equal(renewed.status, 200);
    assert.equal(renewed.headers.get('set-cookie'), `${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    now += 2 * 3600_000;
    assert.equal((await read()).status, 200, 'still valid beyond the original 24 hours');
    const invalid = await fetch(app.origin + '/api/watchdogs', { headers: { cookie: 'viewer=invalid' } });
    assert.equal(invalid.status, 401); assert.equal(invalid.headers.get('set-cookie'), null);
    now += 86400_000;
    const expired = await read(); assert.equal(expired.status, 401);
    assert.equal(expired.headers.get('set-cookie'), null);
    assert.match((await expired.json()).error, /登录已过期/);
  } finally { t.mock.restoreAll(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('late turn/start cannot undo completion; Windows access is flagged', () => {
  const t: Thread = { id:'t',cwd:'/tmp',turns:[{id:'a',status:'completed',items:[]}],status:{type:'idle'} };
  reduceNotice(t,{method:'turn/started',params:{threadId:'t',turn:{id:'a',status:'inProgress',items:[]}}});
  assert.equal(t.status?.type,'idle'); assert.ok(windowsEvidence({command:'powershell.exe Get-Date'}).length); assert.equal(windowsEvidence({command:'pwd'}).length,0);
});
test('delta updates replace only their item and leave prior snapshots untouched', () => {
  const t: Thread = { id: 't', cwd: '/tmp', turns: [{ id: 'turn', status: 'inProgress', items: [
    { id: 'log', type: 'commandExecution', aggregatedOutput: 'old' },
    { id: 'reason', type: 'reasoning', summary: ['before'] },
  ] }] };
  const [log, reason] = t.turns![0].items;
  reduceNotice(t, { method: 'item/reasoning/summaryTextDelta', params: { threadId: 't', turnId: 'turn', itemId: 'reason', delta: '+after', summaryIndex: 0 } });
  assert.equal(t.turns![0].items[0], log);
  assert.notEqual(t.turns![0].items[1], reason);
  assert.deepEqual(reason.summary, ['before']);
  assert.deepEqual(t.turns![0].items[1].summary, ['before+after']);
  reduceNotice(t, { method: 'item/commandExecution/outputDelta', params: { threadId: 't', turnId: 'turn', itemId: 'log', delta: '+new' } });
  assert.equal(log.aggregatedOutput, 'old');
  assert.equal(t.turns![0].items[0].aggregatedOutput, 'old+new');
});
test('large SSE frames reach consuming clients, slow clients stay bounded, and only hashed assets are cached', { timeout: 15000 }, async () => {
  const dir = await mkdtemp('/tmp/viewer-transmission-');
  const staticDir = path.join(dir, 'static');
  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await Promise.all(['index.html', 'assets/main-12345678.js', 'assets/current.js'].map(file => writeFile(path.join(staticDir, file), 'test resource')));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter, staticDir });
  const connections: IncomingMessage[] = [], streams: ServerResponse[] = [];
  app.server.on('request', (req, res) => { if (req.url === '/api/events') streams.push(res); });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    for (const file of ['/', '/assets/current.js', '/api/threads']) {
      const response = await fetch(app.origin + file, { headers: { cookie } });
      assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer();
    }
    const cached = await fetch(app.origin + '/assets/main-12345678.js', { headers: { cookie } });
    assert.equal(cached.headers.get('set-cookie'), null);
    assert.equal(cached.headers.get('cache-control'), 'private, max-age=31536000, immutable'); await cached.arrayBuffer();
    assert.equal((await fetch(app.origin + '/assets/main-12345678.js')).status, 401);
    const { thread } = await (await fetch(app.origin + '/api/threads', { method: 'POST', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: dir }) })).json();
    const connect = () => new Promise<IncomingMessage>((resolve, reject) => {
      get(app.origin + '/api/events', { headers: { cookie } }, res => { connections.push(res); resolve(res); }).on('error', reject);
    });
    const fast = await connect(); let text = '';
    fast.setEncoding('utf8'); fast.on('data', chunk => { text += chunk; });
    const delta = 'x'.repeat(131072);
    const emit = () => adapter.emit('notice', { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: 'turn', itemId: 'answer', delta } });
    emit();
    for (let i = 0; i < 100 && !text.includes(delta); i++) await delay(5);
    assert.ok(text.includes(delta)); assert.equal(fast.destroyed, false);
    const slow = await connect(); slow.pause();
    // Yield between writes so the consuming connection can drain; the paused peer cannot.
    for (let i = 0; i < 200 && !streams[1].destroyed; i++) { text = ''; emit(); await delay(2); }
    assert.equal(streams[1].destroyed, true);
    assert.equal(fast.destroyed, false);
    text = ''; emit();
    for (let i = 0; i < 100 && !text.includes(delta); i++) await delay(5);
    assert.ok(text.includes(delta));
  } finally { for (const res of connections) res.destroy(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
test('active snapshots and automatic naming do not read an unfinished rollout; idle read failures remain visible', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-live-read-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter);
  let failReads = false, reads = 0;
  adapter.call = async (method, params = {}) => {
    if (method === 'thread/read') { reads++; if (failReads) throw new Error('failed to read thread: rollout at /tmp/session.jsonl is empty'); }
    return call(method, params);
  };
  const app = await serve({ roots: [dir], dataDir: path.join(dir, 'data'), runtimeDir: path.join(dir, 'run'), port: 0, adapter });
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0];
    const post = (url: string, data: unknown = {}) => fetch(app.origin + '/api' + url, { method: 'POST', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const { thread } = await (await post('/threads', { cwd: dir })).json();
    const named = new Promise<void>(resolve => {
      const finish = (n: Notice) => { if (n.method === 'thread/name/updated' && n.params.threadId === thread.id) { adapter.off('notice', finish); resolve(); } };
      adapter.on('notice', finish);
    });
    failReads = true;
    assert.equal((await post(`/threads/${thread.id}/turns`, { text: 'approve', attachments: [] })).status, 200);
    const opened = await post(`/threads/${thread.id}/open`);
    assert.equal(opened.status, 200);
    const snapshot = await opened.json();
    await named;
    assert.equal(snapshot.thread.status.type, 'active'); assert.equal(snapshot.thread.turns[0].items[0].content[0].text, 'approve');
    assert.equal(snapshot.requests.length, 1); assert.equal(reads, 0);
    assert.equal((await post('/threads/missing/open')).status, 502);
    const completed = new Promise<void>(resolve => {
      const finish = (n: Notice) => { if (n.method === 'turn/completed' && n.params.threadId === thread.id) { adapter.off('notice', finish); resolve(); } };
      adapter.on('notice', finish);
    });
    await post(`/threads/${thread.id}/interrupt`); await completed;
    assert.equal((await post(`/threads/${thread.id}/open`)).status, 502);
    failReads = false;
    assert.equal((await post(`/threads/${thread.id}/open`)).status, 200);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
test('authenticated HTTP, root boundaries, uploads, turns and single-use approval', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'viewer-test-'));
  const root = path.join(dir,'root'); await mkdir(root); await symlink(os.tmpdir(),path.join(root,'escape'));
  const app = await serve({ roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,
    adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}) });
  try {
    assert.equal((await fetch(app.origin+'/api/threads')).status,401);
    const login = await fetch(app.launchUrl,{redirect:'manual'}); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (p:string, data?:unknown, origin=app.origin) => fetch(app.origin+'/api'+p,{method:data === undefined?'GET':'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:data === undefined?undefined:JSON.stringify(data)});
    assert.equal((await request('/threads',{},'https://evil.example')).status,403);
    assert.equal((await request('/directories?path='+encodeURIComponent(path.join(root,'escape')))).status,403);
    const created = await (await request('/threads',{cwd:root})).json(); const id = created.thread.id;
    const usage = await (await request('/usage')).json();
    assert.equal(usage.weekly.usedPercent, 27); assert.equal(usage.resetCount, 2);
    const upload = await fetch(app.origin+'/api/attachments?name=hello.txt',{method:'POST',headers:{cookie,origin:app.origin},body:'hello'});
    assert.equal(upload.status,200); const file = await upload.json(); assert.equal(file.path,undefined);
    assert.equal(await (await fetch(app.origin+'/api/attachments/'+file.id,{headers:{cookie}})).text(),'hello');
    assert.equal((await request(`/threads/${id}/turns`,{text:'approve',attachments:[file.id]})).status,200);
    let snapshot;
    for (let i=0;i<30;i++) { snapshot = await (await request(`/threads/${id}`)).json(); if (snapshot.requests.length) break; await new Promise(r=>setTimeout(r,20)); }
    assert.equal(snapshot.requests.length,1); const approval = snapshot.requests[0]; assert.equal(approval.windows,true);
    assert.equal((await request('/requests/'+approval.id,{decision:'accept'})).status,200);
    assert.equal((await request('/requests/'+approval.id,{decision:'accept'})).status,409);
    for (let i=0;i<30;i++) { snapshot = await (await request(`/threads/${id}`)).json(); if (snapshot.thread.status.type==='idle') break; await new Promise(r=>setTimeout(r,20)); }
    assert.equal(snapshot.thread.turns[0].items.at(-1).text.includes('\\frac'),true);
    assert.equal(snapshot.thread.status.type,'idle'); assert.ok(snapshot.seq>0);
    assert.equal(snapshot.thread.tokenUsage.last.totalTokens, 25000);
  } finally { await app.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('native folder selection grants only the selected directory and survives restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-picker-'));
  const root = path.join(dir, 'root'), selected = path.join(dir, '中文 project'), sibling = path.join(dir, 'other');
  await Promise.all([mkdir(root), mkdir(selected), mkdir(sibling)]);
  await symlink(sibling, path.join(selected, 'escape'));
  let choice: string | null = selected, picks = 0;
  const start = () => serve({ roots: [root], dataDir: path.join(dir, 'data'), runtimeDir: path.join(dir, 'run'), port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }),
    picker: async initial => { assert.equal(initial, root); picks++; return choice; } });
  let app = await start();
  try {
    let cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const request = (p: string, data?: unknown, origin = app.origin) => fetch(app.origin + '/api' + p, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const browse = (p: string) => request('/directories?' + new URLSearchParams({ path: p }));
    assert.equal((await request('/directories/pick', {}, 'https://evil.example')).status, 403);
    assert.equal((await request('/directories/pick', { path: sibling })).status, 403);
    assert.equal(picks, 0);
    assert.equal((await browse(selected)).status, 403);
    assert.deepEqual(await (await request('/directories/pick', {})).json(), { path: selected });
    assert.equal((await browse(selected)).status, 200);
    assert.equal((await browse(path.join(selected, 'escape'))).status, 403);
    assert.equal((await browse(sibling)).status, 403);
    assert.equal((await request('/threads', { cwd: selected })).status, 200);
    choice = null;
    assert.deepEqual(await (await request('/directories/pick', {})).json(), { path: null });
    await app.stop(); app = await start();
    cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await browse(selected)).status, 200);
    assert.equal((await browse(sibling)).status, 403);
    assert.equal(await directoryPath('~/project'), path.join(os.homedir(), 'project'));
    await assert.rejects(directoryPath('../relative'), /完整/);
    await assert.rejects(directoryPath('/tmp/line\nbreak'), /无效/);
    if (process.env.WSL_DISTRO_NAME) {
      assert.equal(await directoryPath(`\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${selected.replaceAll('/', '\\')}`), selected);
      assert.equal(await directoryPath('C:\\Users'), '/mnt/c/Users');
    }
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
