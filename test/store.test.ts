import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerStore } from '../web/store.ts';
import { createClient } from '../web/api.ts';
import type { Snapshot, Update } from '../web/api.ts';
import { usageFrom } from '../shared/protocol.ts';
import type { Item, Thread } from '../shared/protocol.ts';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const thread = (id: string): Thread => ({ id, cwd: '/tmp/' + id, name: id, status: { type: 'idle' }, settings: { model: 'mock', effort: null, mode: 'default' }, turns: [] });
const snapshot = (id: string, seq = 0): Snapshot => ({ thread: thread(id), requests: [], seq });
const catalog = { models: [{ model: 'mock', displayName: 'Mock', supportedReasoningEfforts: [], defaultReasoningEffort: null }], modes: [{ mode: 'default', name: '普通' }], skills: [], errors: {}, skillErrors: [] };
function setup(nextCursor: string | null = null) {
  const pending: { path: string; data: unknown; signal?: AbortSignal; job: ReturnType<typeof deferred<unknown>> }[] = [];
  let listener: (n: Update, eventId: string) => void = () => {};
  let subscriptions = 0, disposals = 0;
  const records = [thread('a'), thread('b')];
  const held = new Set<string>();
  const calls: string[] = [];
  const client = createClient();
  client.request = async <T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> => {
    calls.push(path);
    if (path === '/watchdogs' && !held.has(path)) return {data:[]} as T;
    if (path.endsWith('/subagents') && !held.has(path)) return {data:[]} as T;
    if (path === '/usage' && !held.has(path)) return { weekly: null, resetCount: 2 } as T;
    if (path === '/threads' && data === undefined && !held.has(path)) return { data: structuredClone(records), nextCursor } as T;
    if (path.startsWith('/controls') && !held.has(path)) return catalog as T;
    const job = deferred<unknown>(); pending.push({ path, data, signal, job }); return await job.promise as T;
  };
  client.subscribe = update => { subscriptions++; listener = update; update({ method: 'viewer/resync', params: { online: true } }, 'one:0'); };
  client.dispose = () => { disposals++; };
  const saved = new Map<string, string>();
  const store = createViewerStore(client, { getItem: k => saved.get(k) ?? null, setItem: (k,v) => { saved.set(k,v); }, removeItem: k => { saved.delete(k); } });
  store.start();
  return { store, pending, held, records, calls, emit: (n: Update, epoch = 'one') => {
    const record = records.find(t => t.id === n.params.threadId);
    if (record && n.method === 'thread/name/updated') record.name = n.params.threadName as string;
    listener(n, epoch + ':' + (n.seq ?? 0));
  }, counts: () => ({ subscriptions, disposals }) };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('creation uses its snapshot and sends with effective settings while optional reads are pending', async () => {
  const h = setup();
  try {
    await tick(); h.held.add('/threads'); h.held.add('/controls?threadId=new');
    const creating = h.store.createThread('/tmp/new', { model: 'mock', contextManagement: true });
    h.pending.find(p => p.path === '/threads' && p.data)!.job.resolve({ ...snapshot('new', 1), thread: { ...thread('new'), contextManagement: true }, models: [{ ...catalog.models[0], supportsExperimentalContext: true }] });
    await creating;
    assert.equal(h.store.state.currentId, 'new'); assert.equal(h.store.state.hydrating, false);
    assert.equal(h.calls.some(p => p.endsWith('/open')), false);
    assert.equal(h.store.state.listLoading, true); assert.equal(h.store.draft.value?.loading, true);
    assert.equal(h.store.canSend.value, true);
    h.store.setText('send before optional reads');
    const sending = h.store.send();
    const submit = h.pending.find(p => p.path === '/threads/new/turns')!;
    assert.equal((submit.data as { settings?: unknown }).settings, undefined);
    submit.job.resolve({ turn: { id: 'first', status: 'inProgress', items: [] } }); await tick();
    h.pending.find(p => p.path === '/threads/new/open')!.job.resolve({ ...snapshot('new', 2), thread: { ...thread('new'), contextManagement: true } }); await sending;
    h.store.setSettings({ model: 'mock', effort: null, mode: 'default' });
    assert.equal(h.store.canSend.value, false, 'changed settings still wait for validation options');
    h.pending.find(p => p.path.startsWith('/controls'))!.job.resolve({ ...catalog, models: [{ ...catalog.models[0], supportsExperimentalContext: true }] });
    h.pending.find(p => p.path === '/threads' && !p.data)!.job.reject(new Error('history unavailable'));
    await tick();
    assert.equal(h.store.state.listError, 'history unavailable'); assert.equal(h.store.canSend.value, true);
    assert.equal(h.store.current.value?.id, 'new');
  } finally { h.store.dispose(); }
});

test('creation resyncs a snapshot overtaken by live events and does not steal a changed selection', async () => {
  const h = setup();
  try {
    await tick();
    const creating = h.store.createThread('/tmp/new');
    h.emit({ method: 'thread/started', params: { thread: thread('new') }, seq: 1 });
    h.emit({ method: 'thread/name/updated', params: { threadId: 'new', threadName: 'newer title' }, seq: 3 });
    h.pending[0].job.resolve(snapshot('new', 2)); await tick();
    assert.equal(h.store.state.hydrating, true);
    h.pending.find(p => p.path === '/threads/new/open')!.job.resolve({ ...snapshot('new', 3), thread: { ...thread('new'), name: 'newer title' } });
    await creating; assert.equal(h.store.current.value?.name, 'newer title');
    const another = h.store.createThread('/tmp/another');
    const selecting = h.store.selectThread('b');
    h.pending.find(p => p.path === '/threads/b/open')!.job.resolve(snapshot('b', 3)); await selecting;
    h.pending.findLast(p => p.path === '/threads' && p.data)!.job.resolve(snapshot('another', 4)); await another;
    assert.equal(h.store.state.currentId, 'b'); assert.equal(h.calls.includes('/threads/another/open'), false);
  } finally { h.store.dispose(); }
});

test('agent detail ignores old selections and merges concurrent live output without touching the parent draft', async () => {
  const h = setup();
  try {
    const opening = h.store.selectThread('a'); h.pending[0]!.job.resolve(snapshot('a')); await opening;
    h.store.setText('parent draft');
    for (const [index, id] of ['child', 'sibling'].entries()) h.emit({ method: 'thread/started', params: { thread: { ...thread(id), parentThreadId: 'a', status: { type: 'active' } } }, seq: index + 1 });
    h.store.selectAgent('child');
    const old = h.pending.find(p => p.path === '/threads/child?refresh=1')!;
    h.store.selectAgent('sibling'); assert.equal(old.signal?.aborted, true);
    h.emit({ method: 'item/agentMessage/delta', params: { threadId: 'sibling', turnId: 'work', itemId: 'answer', delta: 'live output' }, seq: 3 });
    const read = h.pending.find(p => p.path === '/threads/sibling?refresh=1')!;
    read.job.resolve({ thread: { ...thread('sibling'), parentThreadId: 'a', turns: [{ id: 'work', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'live' }] }] }, requests: [], seq: 2 });
    old.job.resolve({ ...snapshot('child'), thread: { ...thread('child'), parentThreadId: 'a' } });
    await tick();
    assert.equal(h.store.selectedAgent.value?.id, 'sibling');
    assert.equal(h.store.selectedAgent.value?.turns?.[0]?.items[0]?.text, 'live output');
    assert.equal(h.store.draft.value?.text, 'parent draft'); assert.equal(h.store.state.currentId, 'a');
    h.store.selectAgent('child'); await tick();
    h.pending.filter(p => p.path === '/threads/child?refresh=1').at(-1)!.job.reject(new Error('read failed')); await tick();
    assert.equal(h.store.state.agentError, 'read failed');
    assert.equal(h.store.agents.value.length, 2);
    h.store.selectAgent('child'); const held = h.pending.at(-1)!;
    h.store.selectAgent('sibling'); h.store.selectAgent('child');
    assert.notEqual(h.pending.at(-1), held);
    h.pending.at(-1)!.job.resolve({ ...snapshot('child'), thread: { ...thread('child'), parentThreadId: 'a' } });
    held.job.reject(new Error('stale failure')); await tick();
    assert.equal(h.store.selectedAgent.value?.id, 'child'); assert.equal(h.store.state.agentError, ''); assert.equal(h.store.state.agentLoading, false);
    h.held.add('/threads/a/subagents');
    const listing = h.store.loadSubagents(); h.store.selectAgent('sibling');
    h.pending.findLast(p => p.path === '/threads/a/subagents')!.job.resolve({ data: [{ ...thread('sibling'), parentThreadId: 'a' }] }); await listing;
    h.pending.findLast(p => p.path === '/threads/sibling?refresh=1')!.job.resolve({ thread: { ...thread('sibling'), parentThreadId: 'a', turns: [{ id: 'work', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'live output finished' }] }] }, requests: [], seq: 4 }); await tick();
    assert.equal(h.store.selectedAgent.value?.turns?.at(-1)?.status, 'completed');
    assert.ok(h.calls.filter(p => p.includes('child') || p.includes('sibling')).every(p => p.endsWith('?refresh=1')));
  } finally { h.store.dispose(); }
});

test('restart is single-use while pending; failed replacement preserves drafts and permits a manual retry', async () => {
  const h = setup();
  try {
    const selected = h.store.selectThread('a');
    h.pending[0].job.resolve(snapshot('a')); await selected; await tick();
    h.store.setText('keep this draft');
    const restart = h.store.restartBackend();
    await h.store.restartBackend();
    assert.equal(h.calls.filter(p => p === '/restart').length, 1);
    assert.equal(h.store.canSend.value, false);
    h.emit({ method: 'viewer/restarting', params: {}, seq: 1 });
    h.emit({ method: 'viewer/offline', params: { restarting: true }, seq: 2 });
    assert.equal(h.store.state.restarting, true);
    h.emit({ method: 'viewer/restartFailed', params: {}, seq: 3 });
    assert.equal(h.store.state.restarting, false);
    h.pending.find(p => p.path === '/restart')!.job.reject(new Error('replacement failed')); await restart;
    assert.equal(h.store.state.restartPending, false);
    assert.equal(h.store.draft.value?.text, 'keep this draft');
    assert.equal(h.store.state.error, 'replacement failed');
    assert.equal(h.calls.some(p => p.endsWith('/turns')), false);
    const retry = h.store.restartBackend();
    h.pending.filter(p => p.path === '/restart')[1].job.resolve({ ok: true, epoch: 'one' }); await retry;
    assert.equal(h.store.state.restartPending, true);assert.notEqual(h.store.state.toast,'整个后端已重启并重新连接');
    h.emit({method:'viewer/resync',params:{online:true}},'one');
    assert.equal(h.store.state.restartPending,true);
    h.emit({method:'viewer/resync',params:{online:false}},'two');
    assert.equal(h.store.state.restartPending,true);
    h.emit({method:'viewer/online',params:{},seq:1},'two');
    h.pending.filter(p=>p.path==='/threads/a/open').at(-1)!.job.resolve(snapshot('a'));await tick();
    assert.equal(h.store.state.toast, '整个后端已重启并重新连接');assert.equal(h.store.state.restartPending,false);
    assert.equal(h.store.draft.value?.text,'keep this draft');
  } finally { h.store.dispose(); }
});

test('restart waits for a new backend epoch and times out without replaying the request', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=setup();
  try {
    const selected=h.store.selectThread('a');h.pending[0].job.resolve(snapshot('a'));await selected;await tick();
    h.store.setText('retain after timeout');
    const restart=h.store.restartBackend();h.pending.find(p=>p.path==='/restart')!.job.resolve({ok:true,epoch:'one'});await restart;
    t.mock.timers.tick(60_000);
    assert.match(h.store.state.error,/60 秒/);assert.equal(h.store.state.restartPending,false);assert.equal(h.store.state.connection,'重连未完成 · 请检查服务');
    assert.equal(h.store.draft.value?.text,'retain after timeout');assert.equal(h.calls.filter(p=>p==='/restart').length,1);
    assert.equal(h.calls.some(p=>p.endsWith('/turns')),false);
  } finally {h.store.dispose();}
});

test('pagination coalesces callers, retains its cursor after failure and exposes retry state', async () => {
  const h = setup('page2');
  try {
    await tick();
    const first = h.store.loadThreads(true), joined = h.store.loadThreads(true);
    assert.equal(h.pending.length, 1); assert.equal(h.store.state.moreLoading, true);
    h.pending[0].job.reject(new Error('page unavailable'));
    await Promise.all([first, joined]);
    assert.equal(h.store.state.moreLoading, false); assert.equal(h.store.state.cursor, 'page2');
    assert.equal(h.store.state.listError, 'page unavailable');
    const retry = h.store.loadThreads(true);
    h.pending[1].job.resolve({ data: [thread('c')], nextCursor: 'page3' }); await retry;
    assert.equal(h.store.state.listError, ''); assert.equal(h.store.state.cursor, 'page3');
    assert.deepEqual([...h.store.state.ids], ['a', 'b', 'c']);
  } finally { h.store.dispose(); }
});

test('401 stops SSE and further requests, marks login expired and retains the draft', async () => {
  const h = setup();
  const originalFetch = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let calls = 0, closed = 0;
  let events: Events | undefined;
  class Events { constructor() { events = this; } onerror?: () => void; close() { closed++; } addEventListener() {} }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: 'expired' }), { status: 401 }); };
  const client = createClient();
  try {
    const open = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a')); await open;
    h.store.setText('keep this unsent draft');
    client.subscribe(() => {}, () => {}, h.store.report);
    events!.onerror!(); events!.onerror!(); await tick();
    assert.equal(closed, 1); assert.equal(h.store.state.authExpired, true);
    assert.equal(h.store.state.connection, '登录已过期'); assert.equal(h.store.canSend.value, false);
    assert.equal(h.store.draft.value?.text, 'keep this unsent draft');
    events!.onerror!();
    await assert.rejects(client.request('/threads')); assert.equal(calls, 1);
    client.subscribe(() => {}, () => {}, h.store.report);
  } finally {
    client.dispose(); h.store.dispose(); globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('metadata refresh preserves loaded pages and an independent pagination request', async () => {
  const h = setup('page2');
  try {
    await tick();
    const more = h.store.loadThreads(true);
    h.pending[0].job.resolve({ data: [thread('c'), thread('d')], nextCursor: 'page3' }); await more;
    h.held.add('/threads');
    h.emit({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'done', status: 'completed', items: [] } }, seq: 1 });
    await tick();
    const last = h.store.loadThreads(true);
    assert.equal(h.pending[2].path, '/threads?cursor=page3');
    h.pending[2].job.resolve({ data: [thread('e')], nextCursor: null }); await last;
    h.pending[1].job.resolve({ data: [thread('new'), thread('a')], nextCursor: 'obsolete-head' }); await tick();
    assert.deepEqual([...h.store.state.ids].sort(), ['a', 'b', 'c', 'd', 'e', 'new']);
    assert.equal(h.store.state.cursor, null);
    assert.ok(h.pending.slice(1).every(p => !p.signal?.aborted));
  } finally { h.store.dispose(); }
});

test('bootstrap reads once; batched notices coalesce and changes during a read cause one follow-up', async () => {
  const h = setup();
  try {
    await tick();
    for (const path of ['/threads', '/usage', '/watchdogs']) assert.equal(h.calls.filter(p => p === path).length, 1);
    const changed = (seq: number) => h.emit({ method: 'viewer/watchdogsChanged', params: {}, seq });
    h.calls.length = 0;
    for (let i = 1; i <= 5; i++) changed(i);
    await tick(); assert.deepEqual(h.calls, ['/watchdogs']);
    h.held.add('/watchdogs'); changed(6); await tick();
    for (let i = 7; i <= 11; i++) changed(i);
    assert.equal(h.pending.length, 1); assert.equal(h.pending[0].signal?.aborted, false);
    h.pending[0].job.resolve({ data: [] }); await tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].job.resolve({ data: [] }); await tick();
    assert.equal(h.calls.length, 3);
    const reading = h.store.loadWatchdogs(), explicit = h.store.resync();
    await tick(); assert.equal(h.pending.length, 3);
    h.pending[2].job.resolve({ data: [] }); await tick();
    assert.equal(h.pending.length, 4);
    h.pending[3].job.resolve({ data: [] }); await Promise.all([reading, explicit]);
  } finally { h.store.dispose(); }
});

test('successful resync clears its read failure while preserving action errors and live messages', async () => {
  const h = setup();
  try {
    const select = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a')); await select;
    const failed = h.store.resync();
    h.pending[1].job.reject(new Error('rollout is empty')); await failed;
    assert.equal(h.store.draft.value?.readError, 'rollout is empty');
    h.emit({ method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 'turn', itemId: 'answer', delta: 'still running' }, seq: 1 });
    assert.equal(h.store.current.value?.turns?.[0].items[0].text, 'still running');
    h.store.report(new Error('approval failed'), 'a');
    const recovered = h.store.resync(); h.pending[2].job.resolve(snapshot('a', 1)); await recovered;
    assert.equal(h.store.draft.value?.readError, ''); assert.equal(h.store.draft.value?.error, 'approval failed');
  } finally { h.store.dispose(); }
});

test('usage keeps account scope, authoritative reset count and live context across snapshots', async () => {
  const window = { usedPercent: 35, windowDurationMins: 10080 };
  assert.deepEqual(usageFrom({ rateLimits: { limitId: 'other', secondary: window } }), { weekly: null, resetCount: null });
  assert.deepEqual(usageFrom({ rateLimits: { primary: { ...window, windowDurationMins: 300 } } }), { weekly: null, resetCount: null });
  assert.deepEqual(usageFrom({ rateLimitsByLimitId: { codex: { primary: window } }, rateLimitResetCredits: { availableCount: 4, credits: [] } }), { weekly: window, resetCount: 4 });
  const h = setup();
  try {
    await tick(); h.held.add('/usage');
    const read = h.store.loadUsage();
    h.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', secondary: window } }, seq: 1 });
    h.pending[0].job.resolve({ weekly: { ...window, usedPercent: 10 }, resetCount: 0 }); await read;
    assert.equal(h.store.state.usage.weekly?.usedPercent, 35); assert.equal(h.store.state.usage.resetCount, 0);
    h.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'other', secondary: { ...window, usedPercent: 99 } } }, seq: 2 });
    assert.equal(h.store.state.usage.weekly?.usedPercent, 35);
    const opening = h.store.selectThread('a');
    h.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'a', tokenUsage: { last: { totalTokens: 25 }, modelContextWindow: 100 } }, seq: 4 });
    h.pending[1].job.resolve(snapshot('a', 3)); await opening;
    assert.equal(h.store.current.value?.tokenUsage?.last.totalTokens, 25);
    const other = h.store.selectThread('b'); h.pending[2].job.resolve(snapshot('b', 4)); await other;
    assert.equal(h.store.current.value?.tokenUsage, undefined);
    assert.equal(h.store.state.usage.weekly?.usedPercent, 35);
    const failed = h.store.loadUsage(); h.pending[3].job.reject(new Error('not supported')); await failed;
    assert.equal(h.store.state.usage.resetCount, null); assert.equal(h.store.state.error, '');
  } finally { h.store.dispose(); }
});

test('list refresh repairs status without replacing history or racing live events and snapshots', async () => {
  const h = setup();
  try {
    await tick();
    h.records[1].status = { type: 'active' }; await h.store.loadThreads();
    assert.equal(h.store.state.entities.b.status?.type, 'active');
    h.held.add('/threads');
    const list = h.store.loadThreads();
    h.emit({ method: 'thread/status/changed', params: { threadId: 'b', status: { type: 'idle' } }, seq: 1 });
    const opening = h.store.selectThread('a'), fresh = snapshot('a', 2);
    fresh.thread.status = { type: 'active' };
    fresh.thread.turns = [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'live history' }] }];
    h.pending[1].job.resolve(fresh); await opening;
    h.pending[0].job.resolve({ data: structuredClone(h.records), nextCursor: null }); await list;
    assert.equal(h.store.state.entities.b.status?.type, 'idle');
    assert.equal(h.store.current.value?.status?.type, 'active');
    assert.equal(h.store.current.value?.turns?.[0].items[0].text, 'live history');
    h.held.delete('/threads');
    h.emit({ method: 'viewer/offline', params: {}, seq: 3 });
    const recovery = h.store.resync(); h.pending[2].job.resolve(snapshot('a', 3)); await recovery;
    assert.equal(h.store.state.entities.b.status?.type, 'active');
    assert.equal(h.store.current.value?.status?.type, 'idle');
  } finally { h.store.dispose(); }
});

test('skills changes refresh only the current catalog; switching reloads the other catalog', async () => {
  const h = setup();
  try {
    const a = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a')); await a;
    const b = h.store.selectThread('b'); h.pending[1].job.resolve(snapshot('b')); await b;
    h.calls.length = 0;
    h.emit({ method: 'skills/changed', params: {}, seq: 1 }); await tick();
    assert.deepEqual(h.calls, ['/controls?threadId=b']);
    const back = h.store.selectThread('a'); h.pending[2].job.resolve(snapshot('a', 1)); await back;
    assert.equal(h.calls.filter(p => p.startsWith('/controls')).at(-1), '/controls?threadId=a');
  } finally { h.store.dispose(); }
});

test('cached selection is immediate, gates sends until revalidated, and retains history and drafts on failure', async () => {
  const h = setup();
  try {
    const cached = snapshot('a'); cached.thread.turns = [{ id: 'history', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'cached answer' }] }];
    const first = h.store.selectThread('a'); h.pending[0]!.job.resolve(cached); await first; h.store.setText('draft A');
    const second = h.store.selectThread('b'); assert.equal(h.store.state.currentId, 'b'); h.pending[1]!.job.resolve(snapshot('b')); await second;
    const back = h.store.selectThread('a');
    assert.equal(h.store.current.value?.id, 'a'); assert.equal(h.store.current.value?.turns?.[0]?.items[0]?.text, 'cached answer');
    assert.equal(h.store.draft.value?.text, 'draft A'); assert.equal(h.store.canSend.value, false);
    h.emit({ method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 'history', itemId: 'answer', delta: '+live' }, seq: 1 });
    h.pending[2]!.job.reject(new Error('read failed')); await back;
    assert.equal(h.store.canSend.value, false); assert.equal(h.store.current.value?.turns?.[0]?.items[0]?.text, 'cached answer+live');
    const retry = h.store.selectThread('a'); h.pending[3]!.job.resolve({ ...cached, seq: 1 }); await retry;
    assert.equal(h.store.canSend.value, true); assert.equal(h.store.draft.value?.text, 'draft A'); assert.equal(h.store.draft.value?.readError, '');
  } finally { h.store.dispose(); }
});

test('A→B→A ignores stale success, failure and cleanup without losing the latest selection', async () => {
  const h = setup();
  try {
    const first = h.store.selectThread('a'), second = h.store.selectThread('b'), third = h.store.selectThread('a');
    assert.equal(h.pending[0].signal?.aborted, true);
    const latest = snapshot('a', 10); latest.thread.name = 'new A'; h.pending[2].job.resolve(latest); await third;
    h.pending[0].job.reject(new Error('obsolete A failed')); h.pending[1].job.resolve(snapshot('b', 1)); await Promise.all([first, second]);
    assert.equal(h.store.current.value?.id, 'a'); assert.equal(h.store.current.value?.name, 'new A');
    assert.equal(h.store.state.hydrating, false); assert.equal(h.store.draft.value?.loading, false);
    assert.equal(h.store.state.error, ''); assert.equal(h.store.draft.value?.error, '');
  } finally { h.store.dispose(); }
});

test('snapshot replay deduplicates deltas and preserves other threads and approvals', async () => {
  const h = setup();
  try {
    await tick(); const opening = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a', 5)); await opening;
    const sync = h.store.resync();
    const delta: Update = { method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 'turn', itemId: 'answer', delta: '+live' }, seq: 11 };
    h.emit(delta); h.emit(delta);
    h.emit({ method: 'thread/name/updated', params: { threadId: 'b', threadName: 'B live' }, seq: 12 });
    h.emit({ method: 'viewer/request', params: { id: 'b-request', method: 'approve', params: { threadId: 'b' }, windows: false }, seq: 13 });
    h.emit({ method: 'viewer/request', params: { id: 'a-request', method: 'approve', params: { threadId: 'a' }, windows: false }, seq: 14 });
    h.emit({ method: 'viewer/requestResolved', params: { id: 'snapshot-only' }, seq: 15 });
    h.emit({ method: 'viewer/request', params: { id: 'buffered', method: 'approve', params: { threadId: 'a' }, windows: false }, seq: 16 });
    h.emit({ method: 'viewer/requestResolved', params: { id: 'buffered' }, seq: 17 });
    const fresh = snapshot('a', 10);
    fresh.thread.turns = [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'base' }] }];
    fresh.requests = [{ id: 'snapshot-only', method: 'approve', params: { threadId: 'a' }, windows: false }];
    h.pending[1].job.resolve(fresh); await sync;
    assert.equal(h.store.current.value?.turns?.[0].items[0].text, 'base+live');
    assert.equal(h.store.state.entities.b.name, 'B live');
    assert.deepEqual(Object.keys(h.store.state.requests).sort(), ['a-request', 'b-request']);
    // A later snapshot from A must not suppress an older valid event belonging to B.
    const next = h.store.resync(); h.pending[2].job.resolve(snapshot('a', 100)); await next;
    h.emit({ method: 'thread/name/updated', params: { threadId: 'b', threadName: 'B after A snapshot' }, seq: 18 });
    assert.equal(h.store.state.entities.b.name, 'B after A snapshot');
  } finally { h.store.dispose(); }
});

test('offline invalidates pending work, resets event epoch and never retries writes', async () => {
  const h = setup();
  try {
    const select = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a')); await select; await tick();
    h.store.setText('exact draft'); const send = h.store.send();
    assert.equal(h.pending[1].path, '/threads/a/turns');
    h.emit({ method: 'viewer/offline', params: {}, seq: 100 });
    h.emit({ method: 'viewer/resync', params: { online: true } }, 'two');
    h.pending[2].job.resolve(snapshot('a', 1)); await tick();
    h.pending[1].job.resolve({}); await send;
    h.emit({ method: 'thread/name/updated', params: { threadId: 'a', threadName: 'new epoch' }, seq: 2 }, 'two');
    assert.equal(h.store.current.value?.name, 'new epoch');
    assert.equal(h.store.draft.value?.text, 'exact draft');
    assert.equal(h.pending.filter(r => r.path.endsWith('/turns')).length, 1);
    assert.equal(h.store.draft.value?.sending, false);
    h.store.start(); h.store.dispose(); h.store.dispose();
    assert.deepEqual(h.counts(), { subscriptions: 1, disposals: 1 });
    h.store.setText('stale UI callback'); await h.store.send();
    assert.equal(h.store.draft.value?.text, 'exact draft');
    assert.equal(h.pending.filter(r => r.path.endsWith('/turns')).length, 1);
    h.emit({ method: 'thread/name/updated', params: { threadId: 'a', threadName: 'disposed' }, seq: 3 }, 'two');
    assert.equal(h.store.current.value?.name, 'new epoch');
  } finally { h.store.dispose(); }
});

test('running sends target one turn, keep next-turn settings and retain failed or edited drafts', async () => {
  const h=setup();
  try {
    const live=snapshot('a');live.thread.status={type:'active'};live.thread.turns=[{id:'running',status:'inProgress',items:[]}];
    const selected=h.store.selectThread('a');h.pending[0].job.resolve(live);await selected;await tick();
    h.store.setSettings({model:'mock',effort:'high',mode:'default'});
    h.store.setText('queued');assert.equal(h.store.canSend.value,true);
    const send=h.store.send();await h.store.send();
    const payload=h.pending[1].data as Record<string,unknown>;
    assert.equal(payload.delivery,'steer');assert.equal(payload.expectedTurnId,'running');assert.equal(payload.settings,undefined);
    assert.equal(h.pending.filter(p=>p.path.endsWith('/turns')).length,1);
    h.store.setText('typed while sending');h.pending[1].job.resolve({turnId:'running',messageId:'queued-id'});await tick();
    h.pending[2].job.resolve(live);await send;
    assert.equal(h.store.draft.value?.text,'typed while sending');assert.equal(h.store.draft.value?.dirty,true);
    assert.equal(h.store.draft.value?.queued.length,1);
    h.emit({method:'item/started',params:{threadId:'a',turnId:'running',item:{id:'other-user',type:'userMessage',content:[{type:'text',text:'queued'}]}},seq:1});
    assert.equal(h.store.draft.value?.queued.length,1);
    h.emit({method:'item/started',params:{threadId:'a',turnId:'running',item:{id:'native-id',clientId:'queued-id',type:'userMessage',content:[{type:'text',text:'queued'}]}},seq:2});
    assert.equal(h.store.draft.value?.queued.length,0);
    const failed=h.store.send('interrupt');
    assert.equal((h.pending[3].data as Record<string,unknown>).delivery,'interrupt');
    h.pending[3].job.reject(new Error('Interrupt failed'));await failed;
    assert.equal(h.store.draft.value?.text,'typed while sending');assert.equal(h.store.draft.value?.sending,false);
    const stopped=h.store.interrupt();assert.equal(h.store.canSend.value,false);
    await h.store.send();assert.equal(h.pending.filter(p=>p.path.endsWith('/turns')).length,2);
    h.emit({method:'turn/completed',params:{threadId:'a',turn:{id:'running',status:'interrupted',items:[]}},seq:3});
    assert.equal(h.store.canSend.value,false);
    h.pending[4].job.resolve({});await tick();h.pending[5].job.resolve(snapshot('a',3));await stopped;
    assert.equal(h.store.canSend.value,true);assert.equal(h.store.draft.value?.text,'typed while sending');
    const timeout=h.store.send();h.pending[6].job.reject(new Error('Codex request timed out'));await timeout;
    assert.equal(h.store.canSend.value,false);assert.equal(h.store.draft.value?.text,'typed while sending');
  } finally {h.store.dispose();}
});

test('approval is sent once and late completion cannot remove a different request', async () => {
  const h = setup();
  try {
    await tick();
    h.emit({ method: 'viewer/request', params: { id: 'r', method: 'approve', params: { threadId: 'a' }, windows: false }, seq: 1 });
    const first = h.store.reply('r', 'accept', {}); await h.store.reply('r', 'accept', {});
    h.emit({ method: 'viewer/request', params: { id: 'other', method: 'approve', params: { threadId: 'b' }, windows: false }, seq: 2 });
    h.pending[0].job.resolve({}); await first;
    assert.equal(h.pending.length, 1); assert.deepEqual(Object.keys(h.store.state.requests), ['other']);
  } finally { h.store.dispose(); }
});

test('async question answers require explicit completion, preserve drafts, and distinguish queued from received', async () => {
  const h = setup();
  const question: Item = { id: 'question', type: 'agentMessage', delivery: 'async', questions: [{title:'比较范围？',options:['DeepSeek','全部模型']},{title:'图的用途？'}] };
  const live = snapshot('a'); live.thread.status = {type:'active'}; live.thread.turns = [{id:'running',status:'inProgress',items:[{id:'initial-user',type:'userMessage',content:[{type:'text',text:'请比较历史实验'}]},question]}];
  try {
    const select = h.store.selectThread('a'); h.pending[0].job.resolve(live); await select; await tick();
    h.store.setText('另一个任务的草稿'); h.store.setAnswer(question.id, 0, 'DeepSeek');
    assert.equal(await h.store.send('steer', question.id), false); assert.equal(h.pending.length, 1);
    h.store.setAnswer(question.id, 1, '用于组会');
    const failed = h.store.send('steer', question.id);
    const data = h.pending[1].data as Record<string, unknown>;
    assert.equal(data.delivery, 'steer'); assert.equal(data.expectedTurnId, 'running');
    assert.deepEqual(data.attachments, []); assert.deepEqual(data.skills, []);
    assert.match(String(data.text), /比较范围？[\s\S]*图的用途？[\s\S]*DeepSeek[\s\S]*用于组会/);
    h.pending[1].job.reject(new Error('回答发送失败')); assert.equal(await failed, false);
    assert.deepEqual(h.store.questionResponse(question), { status: '', text: '' }); assert.deepEqual(h.store.draft.value?.answers.question, ['DeepSeek','用于组会']);
    const send = h.store.send('steer', question.id);
    assert.equal(await h.store.send('steer', question.id), false);
    h.pending[2].job.resolve({turnId:'running',messageId:'reply-id'}); await tick();
    h.pending[3].job.resolve(live); assert.equal(await send, true);
    h.store.setAnswer(question.id, 0, '尚未提交的草稿');
    assert.deepEqual(h.store.questionResponse(question), { status: 'queued', text: '1. DeepSeek\n2. 用于组会' }); assert.equal(h.store.draft.value?.text, '另一个任务的草稿');
    assert.equal(await h.store.send('steer', question.id), false);
    h.emit({method:'item/completed',params:{threadId:'a',turnId:'running',item:{id:'native-reply',clientId:'reply-id',type:'userMessage',content:[{type:'text',text:data.text}]}},seq:1});
    assert.deepEqual(h.store.questionResponse(question), { status: 'received', text: '1. DeepSeek\n2. 用于组会' }); assert.equal(h.store.draft.value?.queued.length, 0);
    // The same question asked later is a new decision, despite matching text.
    const later = {...question,id:'later-question'};
    h.emit({method:'item/completed',params:{threadId:'a',turnId:'running',item:later},seq:2});
    assert.deepEqual(h.store.questionResponse(later), { status: '', text: '' });
    h.emit({method:'item/completed',params:{threadId:'a',turnId:'running',item:{id:'manual',type:'userMessage',content:[{type:'text',text:'我先补充一点背景'}]}},seq:3});
    assert.deepEqual(h.store.questionResponse(later), { status: 'history', text: '' });
    const other = h.store.selectThread('b'); h.pending[4].job.resolve(snapshot('b',3)); await other;
    assert.equal(await h.store.send('steer', question.id), false);
    assert.equal(h.store.state.drafts.a.text, '另一个任务的草稿');
  } finally { h.store.dispose(); }
});

test('configuration requests and local drafts retain thread ownership across switching', async () => {
  const h = setup(); h.held.add('/controls?threadId=a');
  try {
    const a = h.store.selectThread('a'); h.pending[0].job.resolve(snapshot('a')); await a;
    h.store.setText('A draft'); h.store.setSettings({ model: 'mock', effort: 'high', mode: 'plan' });
    const b = h.store.selectThread('b'); h.pending[2].job.resolve(snapshot('b')); await b;
    h.store.setText('B draft');
    const back = h.store.selectThread('a'); h.pending[3].job.resolve(snapshot('a', 5)); await back;
    assert.equal(h.pending[1].signal?.aborted, true);
    h.pending[4].job.resolve({ ...catalog, models: [{ ...catalog.models[0], displayName: 'Newest catalog' }] }); await tick();
    h.pending[1].job.reject(new Error('old catalog failed')); await tick();
    assert.equal(h.store.draft.value?.catalog.models[0].displayName, 'Newest catalog');
    assert.deepEqual(h.store.draft.value?.catalog.errors, {}); assert.equal(h.store.draft.value?.loading, false);
    assert.equal(h.store.draft.value?.text, 'A draft'); assert.equal(h.store.draft.value?.desired?.mode, 'plan');
    assert.equal(h.store.state.drafts.b.text, 'B draft'); assert.equal(h.store.state.drafts.b.desired?.mode, 'default');
  } finally { h.store.dispose(); }
});

test('disposing the HTTP client aborts reads and closes each replaced SSE connection', async () => {
  const fetch = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let closed = 0, signal: AbortSignal | null | undefined;
  class Events { onopen = null; onerror = null; addEventListener() {} close() { closed++; } }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: Events });
  globalThis.fetch = async (_, init) => {
    signal = init?.signal;
    return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  };
  const client = createClient();
  try {
    client.subscribe(() => {}, () => {}, () => {}); client.subscribe(() => {}, () => {}, () => {});
    assert.equal(closed, 1);
    const pending = client.request('/threads'); const rejected = assert.rejects(pending, { name: 'AbortError' });
    client.dispose(); client.dispose(); await rejected;
    assert.equal(signal?.aborted, true); assert.equal(closed, 2);
    await assert.rejects(client.request('/threads'), { name: 'AbortError' });
    client.subscribe(() => {}, () => {}, () => {}); assert.equal(closed, 2);
  } finally { client.dispose(); globalThis.fetch = fetch; if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor); else Reflect.deleteProperty(globalThis, 'EventSource'); }
});

test('flush captures all queued inputs, preserves new typing and reconciles a lost batch acknowledgement', async () => {
  const h = setup();
  try {
    const live = snapshot('a'); live.thread.status = { type: 'active' }; live.thread.turns = [{ id: 'running', status: 'inProgress', items: [] }];
    const select = h.store.selectThread('a'); h.pending[0].job.resolve(live); await select; await tick();
    for (let i = 0; i < 3; i++) {
      h.store.setText('queued ' + i); const next = h.pending.length, sending = h.store.send();
      h.pending[next].job.resolve({ turnId: 'running', messageId: 'message-' + i }); await tick(); h.pending[next + 1].job.resolve(live); await sending;
    }
    h.store.setSettings({model:'mock',effort:'high',mode:'default'});
    assert.equal(h.store.draft.value!.text, '');
    const index = h.pending.length, flush = h.store.send('interrupt');
    const payload = h.pending[index].data as { delivery: string; text: string; queued: { id: string; text: string }[]; batchId: string; settings: unknown };
    assert.equal(payload.delivery, 'flush'); assert.equal(payload.text, ''); assert.equal(payload.queued.length, 3);
    assert.deepEqual(payload.queued.map(q => q.text), ['queued 0', 'queued 1', 'queued 2']);
    assert.deepEqual(payload.settings,{model:'mock',effort:'high',mode:'default'});
    assert.ok(payload.batchId); assert.equal(h.store.canSend.value, false);
    h.store.setText('typed during interruption'); h.pending[index].job.reject(new Error('Interrupted request failed')); await flush;
    assert.equal(h.store.draft.value!.queued.length, 3); assert.equal(h.store.draft.value!.text, 'typed during interruption');
    const retryIndex = h.pending.length, retry = h.store.send('interrupt');
    h.store.setText('typed during retry');
    h.emit({method:'turn/started',params:{threadId:'a',turn:{id:'next',status:'inProgress',items:[{id:'native-batch',clientId:payload.batchId,type:'userMessage',content:[]}]}},seq:1});
    assert.equal(h.store.draft.value!.queued.length, 0);
    h.pending[retryIndex].job.reject(new Error('Codex request timed out')); await retry;
    assert.equal(h.store.draft.value!.text, 'typed during retry'); assert.equal(h.store.canSend.value, false);
  } finally { h.store.dispose(); }
});

test('goal notifications distinguish continuation from completion and replay clear after a stale snapshot', async () => {
  const messages: string[] = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: true, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: class { static permission = 'granted'; constructor(text: string) { messages.push(text); } } });
  const h = setup();
  const goal = { threadId: 'a', objective: 'finish task', status: 'active' as const, tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 10, createdAt: 1, updatedAt: 2 };
  try {
    const opening = h.store.selectThread('a'); h.pending[0].job.resolve({ ...snapshot('a'), thread: { ...thread('a'), goal: null } }); await opening;
    h.store.setText('keep draft');
    h.emit({ method: 'thread/goal/updated', params: { threadId: 'a', goal }, seq: 1 });
    h.emit({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'first', status: 'completed', items: [] } }, seq: 2 });
    assert.deepEqual(messages, []);
    h.emit({ method: 'thread/goal/updated', params: { threadId: 'a', turnId: 'second', goal: { ...goal, status: 'complete', updatedAt: 3 } }, seq: 3 });
    h.emit({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'second', status: 'completed', items: [] } }, seq: 4 });
    assert.deepEqual(messages, ['Goal 已完成']);
    const refresh = h.store.refreshGoal();
    h.emit({ method: 'thread/goal/cleared', params: { threadId: 'a' }, seq: 6 });
    h.pending.findLast(p => p.path === '/threads/a/open')!.job.resolve({ ...snapshot('a', 5), thread: { ...thread('a'), goal } });
    await refresh;
    assert.equal(h.store.current.value!.goal, null); assert.equal(h.store.draft.value!.text, 'keep draft');
    h.emit({ method: 'thread/goal/updated', params: { threadId: 'b', goal: { ...goal, threadId: 'b' } }, seq: 7 });
    assert.equal(h.store.current.value!.goal, null); assert.equal(h.store.state.entities.b.goal!.status, 'active');
  } finally {
    h.store.dispose();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification); else Reflect.deleteProperty(globalThis, 'Notification');
  }
});
