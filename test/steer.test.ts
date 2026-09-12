import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj, Thread } from '../shared/protocol.ts';

test('steer appends to the expected turn; interrupt waits for completion and validates before cancelling', async () => {
  const dir = await mkdtemp('/tmp/viewer-steer-');
  const adapter = new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const call=adapter.call.bind(adapter), calls:{method:string;params:Obj}[]=[], completed=new Set<string>();
  let rejectInterrupt=false;
  adapter.on('notice',n=>{if(n.method==='turn/completed')completed.add(n.params.turn.id);});
  adapter.call=async(method,params={})=>{
    calls.push({method,params});
    if(method==='turn/interrupt'&&rejectInterrupt)throw new Error('Interrupt failed');
    if(method==='turn/start'&&calls.some(c=>c.method==='turn/interrupt')) assert.ok(completed.has(String(calls.findLast(c=>c.method==='turn/interrupt')!.params.turnId)),'start must wait beyond interrupt acknowledgement');
    return call(method,params);
  };
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const http=(url:string,body?:unknown)=>fetch(app.origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app.origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const {thread}=await(await http('/threads',{cwd:dir})).json();
    const route=`/threads/${thread.id}`, send=(text:string,extra:Obj={})=>http(route+'/turns',{text,attachments:[],...extra});
    const first=await(await send('hold-tool')).json(), expectedTurnId=first.turn.id;
    const steer={delivery:'steer',expectedTurnId};
    assert.equal((await send('cannot start')).status,409);
    assert.equal((await send('wrong turn',{...steer,expectedTurnId:'wrong'})).status,409);
    assert.equal((await send('bad delivery',{delivery:['steer'],expectedTurnId})).status,400);
    assert.equal((await send('no model override',{...steer,settings:{model:'mock'}})).status,400);
    assert.equal((await send('first queued',steer)).status,200);
    assert.equal((await send('second queued',steer)).status,200);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,0);
    const snapshot=async()=> (await(await http(route)).json()).thread as Thread;
    assert.equal((await snapshot()).turns!.length,1);
    await call('mock/release',{threadId:thread.id,turnId:expectedTurnId});
    const messages=(await snapshot()).turns![0].items.filter(i=>i.type==='userMessage').map(i=>i.content![0].text);
    assert.deepEqual(messages,['hold-tool','first queued','second queued']);
    assert.equal((await send('bad attachment',{delivery:'interrupt',expectedTurnId,attachments:['missing']})).status,400);
    assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,0);
    rejectInterrupt=true;
    assert.equal((await send('must not start',{delivery:'interrupt',expectedTurnId})).status,502);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    rejectInterrupt=false;
    const replacing=send('replacement',{delivery:'interrupt',expectedTurnId});
    while(calls.filter(c=>c.method==='turn/interrupt').length<2)await new Promise(r=>setTimeout(r,5));
    assert.equal((await send('duplicate',{delivery:'interrupt',expectedTurnId})).status,409);
    const response=await replacing;assert.equal(response.status,200);
    const replacement=await response.json();assert.notEqual(replacement.turn.id,expectedTurnId);
    const final=await snapshot();assert.equal(final.turns![0].status,'interrupted');assert.equal(final.turns!.length,2);
    assert.equal((await send('stale queued',steer)).status,409);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,2);
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('queue flush preserves order and attachments, excludes received messages and supports empty drafts', async () => {
  const dir = await mkdtemp('/tmp/viewer-flush-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter), starts: Obj[] = [];
  let interrupts = 0, failInterrupt = false, consumeOnInterrupt = 0;
  adapter.call = async (method, params = {}) => {
    if (method === 'turn/interrupt') {
      interrupts++;
      if (failInterrupt) throw new Error('Interrupt failed');
      if (consumeOnInterrupt) await call('mock/receiveQueued', { ...params, count: consumeOnInterrupt });
    }
    if (method === 'turn/start') starts.push(params);
    return call(method, params);
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const http = (url: string, data?: Obj) => fetch(app.origin + '/api' + url, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const { thread } = await (await http('/threads', { cwd: dir })).json(), route = `/threads/${thread.id}/turns`;
    const { turn } = await (await http(route, { text: 'hold-tool', attachments: [] })).json();
    const file = await (await fetch(app.origin + '/api/attachments?name=note.txt', { method: 'POST', headers: { cookie, origin: app.origin }, body: 'keep this attachment' })).json();
    const queue: Obj[] = [];
    for (let i = 0; i < 20; i++) {
      const message = { text: `queued ${i}`, attachments: [file.id] };
      const receipt = await (await http(route, { ...message, delivery: 'steer', expectedTurnId: turn.id })).json();
      queue.push({ ...message, id: receipt.messageId, turnId: turn.id });
    }
    assert.equal(starts.length, 1); assert.equal(interrupts, 0);
    const flush = { delivery: 'flush', expectedTurnId: turn.id, text: '', attachments: [], queued: queue, batchId: 'batch-one' };
    for (const bad of [{ queued: [{ ...queue[0], attachments: ['missing'] }] }, { queued: [queue[0], queue[0]] }, { queued: [{ ...queue[0], turnId: 'another-thread' }] }, { batchId: '' }]) {
      assert.equal((await http(route, { ...flush, ...bad })).status, 400);
    }
    assert.equal(interrupts, 0);
    failInterrupt = true; assert.equal((await http(route, flush)).status, 502); assert.equal(starts.length, 1); failInterrupt = false;
    await call('mock/receiveQueued', { threadId: thread.id, turnId: turn.id, count: 1 });
    consumeOnInterrupt = 1;
    const response = await http(route, flush); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).handledQueuedIds, queue.map(q => q.id));
    const input = starts.at(-1)!.input as Obj[];
    assert.deepEqual(input.filter(i => String(i.text).startsWith('queued ')).map(i => i.text), queue.slice(2).map(q => q.text));
    assert.equal(input.filter(i => String(i.text).includes('note.txt')).length, 18);
    assert.equal(starts.at(-1)!.clientUserMessageId, 'batch-one');
    // A lost HTTP acknowledgement must not make an already-forwarded batch repeat.
    const newest = await (await http('/threads/' + thread.id)).json();
    const repeated = await http(route, { ...flush, expectedTurnId: newest.thread.turns.at(-1).id, queued: queue.map(q => ({ ...q, forwardedAs: ['batch-one', 'unconfirmed-retry'] })), batchId: 'batch-two' });
    assert.equal(repeated.status, 200); assert.equal(starts.length, 2); assert.equal(interrupts, 2);

    const { thread: second } = await (await http('/threads', { cwd: dir })).json(), secondRoute = `/threads/${second.id}/turns`;
    const secondTurn = (await (await http(secondRoute, { text: 'hold-tool', attachments: [] })).json()).turn.id;
    const one = await (await http(secondRoute, { text: 'received during interruption', attachments: [], delivery: 'steer', expectedTurnId: secondTurn })).json();
    const race = { text: '', attachments: [], delivery: 'flush', expectedTurnId: secondTurn, batchId: 'batch-race', queued: [{ id: one.messageId, turnId: secondTurn, text: 'received during interruption', attachments: [] }] };
    assert.equal((await http(secondRoute, race)).status, 200);
    assert.deepEqual(starts.at(-1)!.input, [], 'resume the interrupted context without duplicating the message');

    const { thread: third } = await (await http('/threads', { cwd: dir })).json(), thirdRoute = `/threads/${third.id}/turns`;
    const thirdTurn = (await (await http(thirdRoute, { text: 'hold-tool', attachments: [] })).json()).turn.id;
    const pending = await (await http(thirdRoute, { text: 'before draft', attachments: [], delivery: 'steer', expectedTurnId: thirdTurn })).json();
    consumeOnInterrupt = 0;
    await http(`/threads/${third.id}/interrupt`, {});
    assert.equal((await http(thirdRoute, { text: 'after queue', attachments: [], delivery: 'flush', batchId: 'batch-idle', queued: [{ id: pending.messageId, turnId: thirdTurn, text: 'before draft', attachments: [] }] })).status, 200);
    assert.deepEqual((starts.at(-1)!.input as Obj[]).map(i => i.text), ['before draft', 'after queue']);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
