import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Watchdogs, watchdogConfig, nextWatchdogAt, watchdogTimeZone } from '../server/watchdogs.ts';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { watchdogLaunch, watchdogTools } from '../server/watchdog-mcp.ts';
import type { Watchdog, WatchdogRun, WatchdogReport, WatchdogSchedule } from '../shared/watchdogs.ts';
import type { Obj, Settings } from '../shared/protocol.ts';

const config={name:'训练监控',prompt:'查看远端任务 job-42 的日志，严重错误时按已授权范围停止并修复。',intervalMinutes:60,model:'mock-fast',effort:'low'};
const foreground:Settings={model:'mock',effort:'medium',mode:'plan'};
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T> {const end=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await delay(40);}while(Date.now()<end);throw new Error('Timed out: '+JSON.stringify(value!));}

const calendarConfig = (schedule: WatchdogSchedule) => watchdogConfig({ ...config, intervalMinutes: undefined, schedule });
const instant = (at: string) => +new Date(at);

test('calendar deadlines validate input and follow local dates across weeks, leap days and DST', () => {
  const cases: [WatchdogSchedule, string, string][] = [
    [{ kind: 'daily', everyDays: 1, startDate: '2026-09-16', time: '09:00' }, '2026-09-16T08:59', '2026-09-16T09:00'],
    [{ kind: 'daily', everyDays: 1, startDate: '2026-09-16', time: '09:00' }, '2026-09-16T09:00', '2026-09-17T09:00'],
    [{ kind: 'daily', everyDays: 2, startDate: '2026-09-16', time: '09:00' }, '2026-09-19T17:00', '2026-09-20T09:00'],
    [{ kind: 'daily', everyDays: 2, startDate: '2026-12-30', time: '09:00' }, '2026-12-31T17:00', '2027-01-01T09:00'],
    [{ kind: 'daily', everyDays: 1, startDate: '2028-02-28', time: '09:00' }, '2028-02-28T17:00', '2028-02-29T09:00'],
    [{ kind: 'daily', everyDays: 2, startDate: '2028-02-28', time: '09:00' }, '2028-02-28T17:00', '2028-03-01T09:00'],
    [{ kind: 'daily', everyDays: 3, startDate: '2026-10-01', time: '09:00' }, '2026-09-16T17:00', '2026-10-01T09:00'],
    [{ kind: 'weekly', weekdays: [1, 3, 7], time: '09:00' }, '2026-09-16T09:00', '2026-09-20T09:00'],
    [{ kind: 'weekly', weekdays: [1, 3, 7], time: '09:00' }, '2026-09-20T09:00', '2026-09-21T09:00'],
    [{ kind: 'weekly', weekdays: [3], time: '09:00' }, '2026-09-16T09:00', '2026-09-23T09:00'],
    [{ kind: 'once', at: '2026-09-16T09:00' }, '2026-09-16T08:59', '2026-09-16T09:00'],
  ];
  for (const [schedule, after, expected] of cases) assert.equal(nextWatchdogAt(calendarConfig(schedule), instant(after)), instant(expected), JSON.stringify(schedule));
  assert.equal(nextWatchdogAt(calendarConfig({ kind: 'once', at: '2026-09-16T09:00' }), instant('2026-09-16T09:00')), null);
  assert.deepEqual(calendarConfig({ kind: 'weekly', weekdays: [7, 1, 1], time: '09:00' }).schedule, { kind: 'weekly', weekdays: [1, 7], time: '09:00' });
  for (const schedule of [null, {}, { kind: 'once', at: '2026-02-30T09:00' }, { kind: 'once', at: '2026-09-16T09:00Z' }, { kind: 'weekly', weekdays: [], time: '09:00' }, { kind: 'weekly', weekdays: [0], time: '09:00' }, { kind: 'weekly', weekdays: [1.5], time: '09:00' }, { kind: 'daily', everyDays: 0, startDate: '2026-09-16', time: '09:00' }, { kind: 'daily', everyDays: 2, startDate: '2026-09-31', time: '09:00' }, { kind: 'weekly', weekdays: [1], time: '24:00' }, { kind: 'once', at: '2026-09-16T09:00', intervalMinutes: 1 }])
    assert.throws(() => watchdogConfig({ ...config, intervalMinutes: undefined, schedule }));
  assert.throws(() => watchdogConfig({ ...config, schedule: cases[0][0] }), /只能选择一种/);
  assert.throws(() => watchdogConfig({ ...config, intervalMinutes: undefined }), /只能选择一种/);
  const dst = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { nextWatchdogAt, watchdogConfig } from './server/watchdogs.ts';
    const c = {name:'DST',prompt:'check',model:'mock',effort:null,schedule:{kind:'daily',everyDays:1,startDate:'2026-03-07',time:'09:00'}};
    assert.equal(new Date(nextWatchdogAt(c, +new Date('2026-03-07T09:00'))).toISOString(), '2026-03-08T13:00:00.000Z');
    c.schedule = {kind:'weekly',weekdays:[7],time:'09:00'};
    assert.equal(new Date(nextWatchdogAt(c, +new Date('2026-10-31T09:00'))).toISOString(), '2026-11-01T14:00:00.000Z');
    assert.throws(() => watchdogConfig({...c,schedule:{kind:'once',at:'2026-03-08T02:30'}}));
  `], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(dst.status, 0, dst.stderr);
});

test('calendar schedules coalesce overdue dates, preserve anchors and recover stored deadlines', async () => {
  const dir = await mkdtemp('/tmp/watchdog-calendar-'); let db = new Watchdogs(dir + '/tasks.sqlite');
  try {
    const c = calendarConfig({ kind: 'daily', everyDays: 2, startDate: '2026-09-16', time: '09:00' });
    const w = db.create('thread', dir, c, instant('2026-09-16T08:00'));
    db.close(); db = new Watchdogs(dir + '/tasks.sqlite');
    assert.equal(db.get(w.id).nextRunAt, instant('2026-09-16T09:00'));
    assert.deepEqual(db.due(instant('2026-09-23T17:00')).map(t => t.id), [w.id]);
    const r = db.claim(w.id, foreground, instant('2026-09-23T17:00'))!;
    db.report(r.id, 'thread', { outcome: 'continue' }); db.finish(r.id, 'completed', '', instant('2026-09-25T17:00'));
    assert.equal(db.get(w.id).nextRunAt, instant('2026-09-26T09:00')); assert.equal(db.runs(w.id).length, 1);
    let task = db.control(w.id, w.revision, 'pause', instant('2026-09-25T18:00'));
    task = db.control(w.id, task.revision, 'resume', instant('2026-09-27T18:00'));
    assert.equal(task.nextRunAt, instant('2026-09-28T09:00'));
    task = db.control(w.id, task.revision, 'run_now', instant('2026-09-27T19:00'));
    const manual = db.claim(w.id, foreground, instant('2026-09-27T19:00'))!;
    db.report(manual.id, 'thread', { outcome: 'continue' }); db.finish(manual.id, 'completed', '', instant('2026-09-27T20:00'));
    assert.equal(db.get(w.id).nextRunAt, instant('2026-09-28T09:00'));
    const converted = db.update(w.id, task.revision, config, instant('2026-09-27T20:00'));
    assert.equal(converted.schedule, undefined); assert.equal(converted.nextRunAt, instant('2026-09-27T21:00'));
    const restored = db.update(w.id, converted.revision, c, instant('2026-09-27T20:00'));
    assert.equal(restored.intervalMinutes, undefined); assert.equal(restored.nextRunAt, instant('2026-09-28T09:00'));
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one-off completion, retries and edits never replay a consumed appointment or discard a new one', async () => {
  const dir = await mkdtemp('/tmp/watchdog-once-'), db = new Watchdogs(dir + '/tasks.sqlite');
  const before = instant('2026-09-16T08:00'), due = instant('2026-09-16T09:00'), later = instant('2026-09-17T10:00');
  const c = calendarConfig({ kind: 'once', at: '2026-09-16T09:00' });
  try {
    assert.throws(() => db.create('past', dir, c, due), /未来时间/);
    for (const outcome of ['continue', 'complete', 'needs_input'] as const) {
      const task = db.create(outcome, dir, c, before), run = db.claim(task.id, foreground, later)!;
      db.update(task.id, task.revision, { ...c, prompt: 'edited during run' }, later);
      db.report(run.id, outcome, { outcome }); db.finish(run.id, 'completed', '', later);
      assert.equal(db.get(task.id).state, outcome === 'needs_input' ? 'needs_input' : 'completed');
      assert.equal(db.get(task.id).nextRunAt, null); assert.equal(db.claim(task.id, foreground, later + 1), undefined);
      assert.equal(db.run(run.id).config.prompt, config.prompt);
      if (outcome !== 'needs_input') {
        assert.throws(() => db.control(task.id, db.get(task.id).revision, 'resume', later), /单次任务已完成/);
        db.control(task.id, db.get(task.id).revision, 'pause', later);
        assert.throws(() => db.control(task.id, db.get(task.id).revision, 'resume', later), /单次任务已完成/);
      } else {
        assert.equal(db.control(task.id, db.get(task.id).revision, 'resume', later).nextRunAt, later);
      }
    }
    const task = db.create('failure', dir, c, before), run = db.claim(task.id, foreground, due)!;
    db.report(run.id, 'failure', { outcome: 'complete' }); db.finish(run.id, 'failed', 'native failure', due);
    assert.equal(db.get(task.id).state, 'needs_input');
    db.control(task.id, db.get(task.id).revision, 'resume', later);
    const retry = db.claim(task.id, foreground, later)!;
    const newConfig = calendarConfig({ kind: 'once', at: '2026-09-17T11:00' });
    db.update(task.id, db.get(task.id).revision, newConfig, later);
    db.report(retry.id, 'failure', { outcome: 'complete' }); db.finish(retry.id, 'completed', '', instant('2026-09-17T12:00'));
    assert.equal(db.get(task.id).state, 'enabled'); assert.equal(db.get(task.id).nextRunAt, instant('2026-09-17T11:00'));
    const changed = db.claim(task.id, foreground, instant('2026-09-17T12:00'))!;
    db.report(changed.id, 'failure', { outcome: 'continue' }); db.finish(changed.id, 'completed', '', instant('2026-09-17T12:01'));
    db.control(task.id, db.get(task.id).revision, 'run_now', instant('2026-09-17T12:02'));
    assert.ok(db.claim(task.id, foreground, instant('2026-09-17T12:02')));
    const future = calendarConfig({ kind: 'once', at: '2026-09-18T09:00' });
    const done = db.list().find(w => w.threadId === 'complete')!;
    const edited = db.update(done.id, done.revision, future, later);
    assert.equal(db.control(done.id, edited.revision, 'resume', later).nextRunAt, instant('2026-09-18T09:00'));
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('committed watchdog writes succeed when change notification fails', async t => {
  const dir = await mkdtemp('/tmp/watchdog-notification-');
  const warn = t.mock.method(console, 'warn', () => {});
  const db = new Watchdogs(dir + '/tasks.sqlite', () => { throw new Error('closed SSE client'); });
  try {
    const task = db.create('thread', dir, config);
    assert.equal(db.list().length, 1);
    assert.deepEqual(db.get(task.id), task);
    assert.equal(warn.mock.callCount(), 1);
    assert.throws(() => db.update(task.id, 0, config), /已被修改/);
    assert.deepEqual(db.get(task.id), task);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('adaptive reports commit timing and instructions only on success and preserve concurrent user changes', async () => {
  const dir = await mkdtemp('/tmp/watchdog-adaptive-'); let db = new Watchdogs(dir + '/tasks.sqlite');
  const minute = 60000, due = 60 * minute, end = 65 * minute;
  try {
    const task = db.create('thread', dir, config, 0), run = db.claim(task.id, foreground, due)!;
    const next = { revision: task.revision, delayMinutes: 10, intervalMinutes: 30, prompt: 'new authorized inspection instructions' };
    db.report(run.id, task.threadId, { outcome: 'continue', next }, due);
    assert.equal(db.get(task.id).prompt, config.prompt);
    db.close(); db = new Watchdogs(dir + '/tasks.sqlite');
    assert.deepEqual(db.run(run.id).report?.next, next);
    db.finish(run.id, 'completed', '', end);
    let saved = db.get(task.id);
    assert.equal(saved.nextRunAt, end + 10 * minute); assert.equal(saved.intervalMinutes, 30);
    assert.equal(saved.prompt, next.prompt); assert.equal(saved.revision, task.revision + 1);
    assert.equal(db.run(run.id).config.prompt, config.prompt);
    const followup = db.claim(task.id, foreground, saved.nextRunAt!)!;
    assert.equal(followup.config.prompt, next.prompt);
    db.report(followup.id, task.threadId, { outcome: 'continue' });
    db.finish(followup.id, 'completed', '', end + 11 * minute);
    assert.equal(db.get(task.id).nextRunAt, end + 40 * minute);

    for (const action of ['edit', 'pause', 'delete', 'failed', 'uncertain', 'interrupted'] as const) {
      const w = db.create(action, dir, config, 0), r = db.claim(w.id, foreground, due)!;
      db.report(r.id, action, { outcome: 'continue', next: { ...next, revision: w.revision } }, due);
      if (action === 'edit') db.update(w.id, w.revision, { ...config, prompt: 'user edit', intervalMinutes: 20 }, due);
      if (action === 'pause' || action === 'delete') db.control(w.id, w.revision, action, due);
      db.finish(r.id, ['failed','uncertain','interrupted'].includes(action) ? action as 'failed' | 'uncertain' | 'interrupted' : 'completed', '', end);
      saved = db.get(w.id);
      assert.equal(saved.prompt, action === 'edit' ? 'user edit' : config.prompt);
      assert.equal(saved.state, action === 'edit' ? 'enabled' : action === 'pause' ? 'paused' : action === 'delete' ? 'deleted' : 'needs_input');
      assert.equal(saved.nextRunAt, action === 'edit' ? due + 20 * minute : null);
    }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('adaptive reports validate scope, conflicts, timing and one-off/calendar semantics', async () => {
  const dir = await mkdtemp('/tmp/watchdog-adaptive-validation-'), db = new Watchdogs(dir + '/tasks.sqlite');
  const due = instant('2026-09-16T09:00'), end = instant('2026-09-16T09:05');
  try {
    const c = calendarConfig({ kind: 'weekly', weekdays: [3], time: '09:00' });
    const task = db.create('weekly', dir, c, due - 1), run = db.claim(task.id, foreground, due)!;
    for (const next of [null, [], { revision: 1, unknown: true }, { revision: 1, delayMinutes: 0 }, { revision: 1, delayMinutes: -1 }, { revision: 1, delayMinutes: '10' }, { revision: 1, delayMinutes: Infinity }, { revision: 1, delayMinutes: 1e300 }, { revision: 1, prompt: '' }, { revision: 1, intervalMinutes: 0 }, { revision: 1, intervalMinutes: 10, schedule: c.schedule }, { revision: 1, schedule: { kind: 'once', at: '2000-01-01T09:00' } }]) {
      assert.throws(() => db.report(run.id, task.threadId, { outcome: 'continue', next } as WatchdogReport, due));
      assert.equal(db.run(run.id).report, null);
    }
    assert.throws(() => db.report(run.id, 'other', { outcome: 'continue', next: { revision: 1, delayMinutes: 10 } }, due), /当前会话/);
    assert.throws(() => db.report(run.id, task.threadId, { outcome: 'complete', next: { revision: 1 } }, due), /只有 continue/);
    assert.throws(() => db.report(run.id, task.threadId, { outcome: 'continue', next: { revision: 2 } }, due), /计划已变更/);
    db.report(run.id, task.threadId, { outcome: 'continue', next: { revision: 1, delayMinutes: 0.5 } }, due);
    db.finish(run.id, 'completed', '', end);
    assert.equal(db.get(task.id).nextRunAt, end + 30000);
    const second = db.claim(task.id, foreground, end + 30000)!;
    db.report(second.id, task.threadId, { outcome: 'continue' }); db.finish(second.id, 'completed', '', end + 60000);
    assert.equal(db.get(task.id).nextRunAt, instant('2026-09-23T09:00'));
    for (const next of [{ delayMinutes: 10 }, { schedule: { kind: 'once' as const, at: '2026-09-16T09:06' } }, { intervalMinutes: 10 }]) {
      const w = db.create(JSON.stringify(next), dir, calendarConfig({ kind: 'once', at: '2026-09-16T09:00' }), due - 1);
      const r = db.claim(w.id, foreground, due)!;
      db.report(r.id, w.threadId, { outcome: 'continue', next: { revision: w.revision, ...next } }, due);
      db.finish(r.id, 'completed', '', end + 120000);
      const saved = db.get(w.id);
      assert.equal(saved.state, 'enabled');
      assert.equal(saved.nextRunAt, 'schedule' in next ? end + 120000 : end + 720000);
    }
    const w = db.create('conflict', dir, config, 0), r = db.claim(w.id, foreground, 3600000)!;
    db.update(w.id, w.revision, { ...config, prompt: 'user changed this' });
    assert.throws(() => db.report(r.id, w.threadId, { outcome: 'continue', next: { revision: w.revision, delayMinutes: 10 } }), /已被修改/);
    db.report(r.id, w.threadId, { outcome: 'continue' });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('per-instance watchdog launch configuration is absent from forked workers', async () => {
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_TEST_BASE: 'preserved' } });
  adapter.configureLaunch(watchdogLaunch('http://127.0.0.1:1/internal/watchdogs', 'test-only-token'));
  const worker = adapter.fork();
  try {
    await Promise.all([adapter.start(), worker.start()]);
    const env = async (a: AppServer) => (await readFile(`/proc/${a.child!.pid}/environ`, 'utf8')).split('\0');
    assert.ok((await env(adapter)).includes('VIEWER_WATCHDOG_TOKEN=test-only-token'));
    assert.ok(adapter.child!.spawnargs.some(arg => arg.includes('mcp_servers.viewer_watchdogs')));
    assert.ok(!(await env(worker)).some(value => value.startsWith('VIEWER_WATCHDOG_TOKEN=')));
    assert.ok(!worker.child!.spawnargs.some(arg => arg.includes('mcp_servers.viewer_watchdogs')));
    assert.ok((await env(worker)).includes('VIEWER_TEST_BASE=preserved'));
  } finally { adapter.stop(); worker.stop(); }
});

test('watchdog schedule claims, anchored coalescing, immutable snapshots and restart history',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-store-');let db=new Watchdogs(dir+'/tasks.sqlite');
  try {
    assert.throws(()=>watchdogConfig({...config,intervalMinutes:0}));assert.throws(()=>watchdogConfig({...config,prompt:''}));
    const a=db.create('thread','/tmp',config,0),b=db.create('thread','/tmp',{...config,name:'第二个'},0);
    assert.deepEqual(db.due(3599999), []);
    assert.deepEqual(db.due(3600000), db.list());
    assert.equal(a.nextRunAt,3600000);assert.equal(db.claim(a.id,foreground,0),undefined);
    const r=db.claim(a.id,foreground,3600000)!;assert.ok(r);assert.equal(db.claim(b.id,foreground,3600000),undefined);
    assert.deepEqual(db.due(3600000).map(w => w.id), [b.id]);
    db.bind(r.id,'turn');db.report(r.id,'thread',{outcome:'continue',summary:'运行正常'});db.finish(r.id,'completed','',4.5*3600000);
    assert.equal(db.get(a.id).nextRunAt,5*3600000);assert.equal(db.get(a.id).state,'enabled');assert.equal(db.runs(a.id)[0].turnId,'turn');
    const second=db.claim(a.id,foreground,5*3600000)!;
    const edited=db.update(a.id,a.revision,{...config,prompt:'新指令',intervalMinutes:30},5*3600000);
    assert.throws(()=>db.update(a.id,a.revision,config),/已被修改/);
    db.report(second.id,'thread',{outcome:'complete',summary:'旧指令完成'});db.finish(second.id,'completed','',5*3600000+100);
    assert.equal(db.get(a.id).state,'enabled');assert.equal(db.get(a.id).prompt,'新指令');assert.equal(db.run(second.id).config.prompt,config.prompt);
    db.control(a.id,edited.revision,'pause',6*3600000);assert.equal(db.get(a.id).nextRunAt,null);
    const resumed=db.control(a.id,db.get(a.id).revision,'resume',7*3600000);assert.equal(resumed.nextRunAt,7.5*3600000);
    const immediate=db.control(a.id,resumed.revision,'run_now',8*3600000);assert.equal(immediate.nextRunAt,8*3600000);
    const missing=db.claim(a.id,foreground,8*3600000)!;db.finish(missing.id,'completed');assert.equal(db.get(a.id).state,'needs_input');assert.match(db.get(a.id).lastSummary,/缺少结果报告/);
    const interrupted=db.claim(b.id,foreground,9*3600000)!;db.report(interrupted.id,'thread',{outcome:'complete',summary:'不能覆盖失败'});db.finish(interrupted.id,'failed','native failure');assert.equal(db.run(interrupted.id).status,'failed');
    db.control(a.id,db.get(a.id).revision,'delete');db.close();db=new Watchdogs(dir+'/tasks.sqlite');
    assert.equal(db.get(a.id).state,'deleted');assert.equal(db.runs(a.id).length,3);assert.equal(db.runs(b.id)[0].summary,'native failure');
    assert.deepEqual(db.due(Number.MAX_SAFE_INTEGER), []);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('watchdog outcomes work without a duplicate summary and still validate input and native failures', async () => {
  const dir = await mkdtemp('/tmp/watchdog-outcomes-'), db = new Watchdogs(dir + '/tasks.sqlite');
  try {
    assert.deepEqual(watchdogTools.find(t => t.name === 'watchdog_report')!.inputSchema.required, ['runId', 'outcome']);
    for (const outcome of ['continue', 'complete', 'needs_input'] as const) {
      const task = db.create(outcome, dir, config, 0), run = db.claim(task.id, foreground, 3600000)!;
      assert.throws(() => db.report(run.id, outcome, { outcome: 'invalid' } as unknown as WatchdogReport), /调度结果/);
      for (const summary of [null, 42, '', 'x'.repeat(10001)]) assert.throws(() => db.report(run.id, outcome, { outcome, summary } as WatchdogReport), /摘要/);
      assert.equal(db.run(run.id).report, null);
      db.report(run.id, outcome, { outcome }); db.finish(run.id, 'completed', '', 3600001);
      assert.deepEqual(db.run(run.id).report, { outcome });
      assert.equal(db.get(task.id).state, outcome === 'continue' ? 'enabled' : outcome === 'complete' ? 'completed' : 'needs_input');
      assert.equal(db.get(task.id).nextRunAt, outcome === 'continue' ? 7200000 : null);
    }
    const task = db.create('failed', dir, config, 0), run = db.claim(task.id, foreground, 3600000)!;
    db.report(run.id, 'failed', { outcome: 'complete' }); db.finish(run.id, 'failed', 'native failure');
    assert.equal(db.get(task.id).state, 'needs_input'); assert.equal(db.run(run.id).summary, 'native failure');
    const deleted = db.control(task.id, db.get(task.id).revision, 'delete');
    db.problem(task.id, 'late dispatch failure'); assert.deepEqual(db.get(task.id), deleted);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('calendar HTTP and MCP use the same execution, snapshot and report path', async () => {
  const dir = await mkdtemp('/tmp/watchdog-calendar-http-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const http = async (p: string, b?: unknown) => {
      const response = await fetch(app.origin + '/api' + p, { method: b === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    };
    const { thread } = await http('/threads', { cwd: dir });
    const tool = async (name: string, args: Obj = {}) => await adapter.call('mock/watchdog', { threadId: thread.id, name, arguments: args }) as { watchdog: Watchdog; timeZone: string };
    assert.equal((await tool('watchdog_list')).timeZone, watchdogTimeZone());
    assert.equal((await http('/watchdogs')).timeZone, watchdogTimeZone());
    const c = { ...calendarConfig({ kind: 'weekly', weekdays: [1, 3, 5], time: '09:30' }), prompt: 'watchdog-continue' };
    const { watchdog: weekly } = await tool('watchdog_create', c);
    await http('/watchdogs/' + weekly.id, { revision: weekly.revision, action: 'run_now' });
    await until(() => http('/watchdogs/' + weekly.id + '/runs'), r => r.data[0]?.status === 'completed');
    assert.equal((await http('/watchdogs/' + weekly.id)).watchdog.state, 'enabled');
    const { data: [weeklyRun] } = await http('/watchdogs/' + weekly.id + '/runs');
    assert.deepEqual(weeklyRun.config.schedule, c.schedule);
    assert.equal((await http('/watchdogs/' + weekly.id)).watchdog.nextRunAt, nextWatchdogAt(c, weeklyRun.endedAt));
    const onceConfig = { ...calendarConfig({ kind: 'once', at: '2099-01-01T09:30' }), prompt: 'watchdog-continue' };
    const { watchdog: once } = await http('/watchdogs', { threadId: thread.id, ...onceConfig });
    await tool('watchdog_control', { id: once.id, revision: once.revision, action: 'run_now' });
    await until(() => http('/watchdogs/' + once.id), r => r.watchdog.state === 'completed');
    const { data: [onceRun] } = await http('/watchdogs/' + once.id + '/runs');
    assert.deepEqual(onceRun.config.schedule, onceConfig.schedule); assert.equal(onceRun.report.outcome, 'continue');
    const current = (await http('/watchdogs/' + once.id)).watchdog;
    await assert.rejects(tool('watchdog_control', { id: once.id, revision: current.revision, action: 'resume' }), /单次任务已完成/);
    await assert.rejects(http('/watchdogs', { threadId: thread.id, ...onceConfig, intervalMinutes: 5 }), /只能选择一种/);
    await assert.rejects(tool('watchdog_create', { ...onceConfig, schedule: { kind: 'once', at: '2000-01-01T09:00' } }), /未来时间/);
    const daily = calendarConfig({ kind: 'daily', everyDays: 2, startDate: '2099-01-01', time: '09:30' });
    const updated = (await tool('watchdog_update', { id: weekly.id, revision: (await http('/watchdogs/' + weekly.id)).watchdog.revision, ...daily })).watchdog;
    assert.deepEqual(updated.schedule, daily.schedule); assert.equal(updated.nextRunAt, instant('2099-01-01T09:30'));
    const { watchdog: adaptive } = await tool('watchdog_create', { ...config, prompt: 'watchdog-adaptive watchdog-continue' });
    await tool('watchdog_control', { id: adaptive.id, revision: adaptive.revision, action: 'run_now' });
    const { data: [adaptiveRun] } = await until(() => http('/watchdogs/' + adaptive.id + '/runs'), r => r.data[0]?.status === 'completed');
    const saved = (await http('/watchdogs/' + adaptive.id)).watchdog;
    assert.equal(saved.state, 'enabled'); assert.equal(saved.intervalMinutes, 30);
    assert.equal(saved.prompt, 'updated inspection instructions');
    assert.equal(saved.nextRunAt, adaptiveRun.endedAt + 10 * 60000);
    assert.equal(saved.revision, adaptiveRun.revision + 1);
    assert.equal(adaptiveRun.config.prompt, 'watchdog-adaptive watchdog-continue');
    assert.deepEqual(adaptiveRun.report.next, { revision: adaptiveRun.revision, delayMinutes: 10, intervalMinutes: 30, prompt: saved.prompt });
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP deletes only current-session watchdogs, including during scheduled checks, without rescheduling them', async () => {
  const dir = await mkdtemp('/tmp/watchdog-delete-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0];
    const http = async (p: string, b?: unknown) => {
      const response = await fetch(app.origin + '/api' + p, { method: b === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      assert.equal(response.ok, true); return response.json();
    };
    const { thread: a } = await http('/threads', { cwd: dir }), { thread: b } = await http('/threads', { cwd: dir });
    const tool = async (name: string, args: Obj = {}, threadId = a.id) => await adapter.call('mock/watchdog', { threadId, name, arguments: args }) as { watchdog: Watchdog; data: Watchdog[] };
    const { watchdog: other } = await tool('watchdog_create', config, b.id);
    const { watchdog: ordinary } = await tool('watchdog_create', config);
    await assert.rejects(tool('watchdog_control', { id: other.id, revision: other.revision, action: 'delete', threadId: b.id }), /当前会话/);
    await tool('watchdog_control', { id: ordinary.id, revision: ordinary.revision, action: 'pause' });
    await assert.rejects(tool('watchdog_control', { id: ordinary.id, revision: ordinary.revision, action: 'delete' }), /已被修改/);
    assert.equal((await tool('watchdog_control', { id: ordinary.id, revision: ordinary.revision + 1, action: 'delete' })).watchdog.state, 'deleted');
    const { watchdog: running } = await tool('watchdog_create', { ...config, prompt: 'watchdog-hold watchdog-continue' });
    const { watchdog: sibling } = await tool('watchdog_create', config);
    await tool('watchdog_control', { id: running.id, revision: running.revision, action: 'run_now' });
    const { data: [run] } = await until(() => http('/watchdogs/' + running.id + '/runs'), r => !!r.data[0]?.turnId);
    await assert.rejects(tool('watchdog_control', { id: other.id, revision: other.revision, action: 'delete' }), /当前会话/);
    await assert.rejects(tool('watchdog_create', config), /不能创建或修改/);
    await assert.rejects(tool('watchdog_update', { ...config, id: sibling.id, revision: sibling.revision }), /不能创建或修改/);
    for (const action of ['pause', 'resume', 'run_now']) await assert.rejects(tool('watchdog_control', { id: sibling.id, revision: sibling.revision, action }), /不能创建或修改/);
    const { data } = await tool('watchdog_list');
    for (const task of [running, sibling]) {
      const latest = (data as Watchdog[]).find(w => w.id === task.id)!;
      await tool('watchdog_control', { id: task.id, revision: latest.revision, action: 'delete' });
    }
    assert.equal((await http('/watchdogs/' + running.id)).watchdog.running, true);
    await adapter.call('mock/release', { threadId: a.id, turnId: run.turnId });
    const result = await until(() => http('/watchdogs/' + running.id), r => !r.watchdog.running);
    assert.equal(result.watchdog.state, 'deleted'); assert.equal(result.watchdog.nextRunAt, null);
    const { data: history } = await http('/watchdogs/' + running.id + '/runs');
    assert.equal(history.length, 1); assert.equal(history[0].status, 'completed'); assert.deepEqual(history[0].report, { outcome: 'continue' });
    assert.equal((await http('/watchdogs/' + other.id)).watchdog.state, 'enabled');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('scheduler uses native MCP thread scope, waits for idle, restores settings and preserves edits during a run',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-http-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
    const {thread:t}=await http('/threads',{cwd:dir});await http('/threads/'+t.id+'/name',{name:'监控会话'});
    const tool=(name:string,args:Obj={},id=t.id)=>adapter.call('mock/watchdog',{threadId:id,name,arguments:args});
    const read=async()=>((await http('/watchdogs')).data as Watchdog[]);
    await http('/threads/'+t.id+'/turns',{text:'hold-tool',attachments:[],settings:foreground});
    const result=await tool('watchdog_create',{name:'上下文监控',prompt:'watchdog-hold',intervalMinutes:60});const a=result.watchdog as Watchdog;
    assert.equal(a.model,foreground.model);assert.equal(a.effort,foreground.effort);assert.ok(a.nextRunAt!>Date.now()+3500000);
    const {watchdog:b}=await http('/watchdogs',{threadId:t.id,...config});
    await http('/watchdogs/'+a.id,{revision:a.revision,action:'run_now'});await http('/watchdogs/'+b.id,{revision:b.revision,action:'run_now'});
    await delay(1150);assert.ok((await read()).every(w=>!w.running));
    const held=await http('/threads/'+t.id);await adapter.call('mock/release',{threadId:t.id,turnId:held.thread.turns[0].id});
    await until(read,rows=>!!rows.find(w=>w.id===a.id)?.running);
    assert.equal((await read()).find(w=>w.id===b.id)?.running,false);
    const runs=async()=>((await http('/watchdogs/'+a.id+'/runs')).data as WatchdogRun[]);
    const run=(await until(runs,rows=>!!rows[0]?.turnId))[0];assert.equal(run.config.prompt,'watchdog-hold');
    await assert.rejects(tool('watchdog_create',{name:'recursive',prompt:'x',intervalMinutes:1}),/不能创建或修改/);
    const liveA=(await read()).find(w=>w.id===a.id)!;
    await http('/watchdogs/'+a.id,{...config,prompt:'改后的检查指令',revision:liveA.revision});
    await adapter.call('mock/release',{threadId:t.id,turnId:run.turnId});
    const completed=await until(read,rows=>rows.find(w=>w.id===b.id)?.state==='completed');
    assert.equal(completed.find(w=>w.id===a.id)?.state,'enabled');assert.equal(completed.find(w=>w.id===a.id)?.prompt,'改后的检查指令');
    const settings=await adapter.call('thread/resume',{threadId:t.id});assert.equal(settings.model,foreground.model);assert.equal(settings.reasoningEffort,foreground.effort);
    const final=await http('/threads/'+t.id);assert.deepEqual(final.thread.settings,foreground);
    const {thread:other}=await http('/threads',{cwd:dir});
    await assert.rejects(tool('watchdog_control',{id:a.id,revision:completed.find(w=>w.id===a.id)!.revision,action:'delete'},other.id),/当前会话/);
    const forbidden=await fetch(app.origin+'/internal/watchdogs',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(forbidden.status,401);
    const csrf=await fetch(app.origin+'/api/watchdogs',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
    const missing=(await http('/watchdogs',{threadId:other.id,...config,prompt:'watchdog-no-report'})).watchdog;
    await http('/watchdogs/'+missing.id,{revision:missing.revision,action:'run_now'});
    await until(read,rows=>rows.find(w=>w.id===missing.id)?.state==='needs_input');
    const stopping=(await http('/watchdogs',{threadId:other.id,...config,prompt:'watchdog-hold'})).watchdog;
    await http('/watchdogs/'+stopping.id,{revision:stopping.revision,action:'run_now'});
    await until(async()=>((await http('/watchdogs/'+stopping.id+'/runs')).data as WatchdogRun[]),rows=>!!rows[0]?.turnId);
    await http('/threads/'+other.id+'/interrupt',{});
    assert.equal((await read()).find(w=>w.id===stopping.id)?.state,'paused');
    assert.equal((await http('/watchdogs/'+stopping.id+'/runs')).data[0].status,'interrupted');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('restart preserves idle schedules and never replays an unfinished native run',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-restart-');
  const launch=()=>serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_STATE:dir+'/native.json'}})});
  let app=await launch(),cookie='';
  const login=async()=>{cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];};
  async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
  try {
    await login();const {thread:a}=await http('/threads',{cwd:dir}),{thread:b}=await http('/threads',{cwd:dir});
    const held=(await http('/watchdogs',{threadId:a.id,...calendarConfig({kind:'once',at:'2099-01-01T09:00'}),prompt:'watchdog-hold'})).watchdog as Watchdog;
    const idle=(await http('/watchdogs',{threadId:b.id,...config})).watchdog as Watchdog;
    const calendarIdle=(await http('/watchdogs',{threadId:b.id,...calendarConfig({kind:'daily',everyDays:2,startDate:'2099-01-01',time:'09:00'})})).watchdog as Watchdog;
    await http('/watchdogs/'+held.id,{revision:held.revision,action:'run_now'});
    const runs=async()=>((await http('/watchdogs/'+held.id+'/runs')).data as WatchdogRun[]);
    const run=(await until(runs,rows=>!!rows[0]?.turnId))[0];
    await app.stop();app=await launch();await login();
    const recovered=await until(async()=>(await http('/watchdogs/'+held.id)).watchdog as Watchdog,w=>!w.running);
    assert.equal(recovered.state,'needs_input');assert.equal((await runs())[0].status,'uncertain');assert.equal((await runs())[0].id,run.id);
    assert.equal((await http('/watchdogs/'+idle.id)).watchdog.nextRunAt,idle.nextRunAt);
    assert.equal((await http('/watchdogs/'+calendarIdle.id)).watchdog.nextRunAt,calendarIdle.nextRunAt);
    assert.deepEqual((await runs())[0].config.schedule,held.schedule);
    await http('/watchdogs/'+idle.id,{revision:idle.revision,action:'run_now'});
    await until(async()=>(await http('/watchdogs/'+idle.id)).watchdog as Watchdog,w=>w.state==='completed');
    const native=await app.adapter.call('thread/read',{threadId:a.id,includeTurns:true});assert.equal((native.thread as {turns:unknown[]}).turns.length,1);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('lost submit acknowledgements reconcile once; unavailable models and pending approvals stay explicit',async()=>{
  const dir=await mkdtemp('/tmp/watchdog-failures-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  let lost:''|'receipt'|'none'='',unavailable=false;const call=adapter.call.bind(adapter);
  adapter.call=async(method,p={})=>{
    if(method==='turn/start' && p.clientUserMessageId && lost) {const mode=lost;lost='';if(mode==='receipt')await call(method,p);throw new Error('Codex request timed out; check state before retrying');}
    const result=await call(method,p);if(method==='model/list' && unavailable)result.data=(result.data as {model:string}[]).filter(m=>m.model!=='mock-fast');return result;
  };
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    async function http(p:string,b?:unknown) {const r=await fetch(app.origin+'/api'+p,{method:b===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const result=await r.json();if(!r.ok)throw new Error(result.error);return result;}
    const make=async(prompt:string)=>{const {thread}=await http('/threads',{cwd:dir});return (await http('/watchdogs',{threadId:thread.id,...config,prompt})).watchdog as Watchdog;};
    const run=async(w:Watchdog)=>http('/watchdogs/'+w.id,{revision:w.revision,action:'run_now'});
    const read=async(w:Watchdog)=>(await http('/watchdogs/'+w.id)).watchdog as Watchdog;
    const runs=async(w:Watchdog)=>(await http('/watchdogs/'+w.id+'/runs')).data as WatchdogRun[];
    const accepted=await make('watchdog-hold');lost='receipt';await run(accepted);
    const receipt=(await until(()=>runs(accepted),v=>!!v[0]?.turnId))[0];await delay(1100);assert.equal((await runs(accepted)).length,1);
    await adapter.call('mock/release',{threadId:accepted.threadId,turnId:receipt.turnId});await until(()=>read(accepted),v=>v.state==='completed');
    const unknown=await make('unknown submission');lost='none';await run(unknown);await until(()=>read(unknown),v=>v.state==='needs_input');assert.equal((await runs(unknown))[0].status,'uncertain');
    assert.equal((await http('/threads/'+unknown.threadId)).thread.turns.length,0);
    await http('/watchdogs/'+unknown.id,{revision:(await read(unknown)).revision,action:'run_now'});await until(()=>read(unknown),v=>v.state==='completed');assert.equal((await runs(unknown)).length,2);
    const removed=await make('model gone');unavailable=true;await run(removed);await until(()=>read(removed),v=>v.state==='needs_input');assert.equal((await runs(removed))[0].status,'failed');assert.match((await read(removed)).lastSummary,/模型不在/);unavailable=false;
    const approval=await make('watchdog-approval');await run(approval);
    const pending=await until(()=>http('/threads/'+approval.threadId),v=>v.requests.length===1);assert.equal((await read(approval)).running,true);
    const next=(await http('/watchdogs',{threadId:approval.threadId,...config})).watchdog as Watchdog;await run(next);await delay(1100);assert.equal((await runs(next)).length,0);
    await http('/requests/'+pending.requests[0].id,{decision:'accept'});await until(()=>read(next),v=>v.state==='completed');assert.equal((await read(approval)).state,'completed');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('watchdog completion during a foreground steer is reconciled before the next dispatch', async () => {
  const dir = await mkdtemp('/tmp/watchdog-steer-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter);
  let signalEntered!: () => void, releaseSteer!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseSteer = resolve; });
  adapter.call = async (method, params = {}) => {
    const result = await call(method, params);
    if (method === 'turn/steer') { signalEntered(); await released; }
    return result;
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    async function http(p: string, body?: unknown) {
      const response = await fetch(app.origin + '/api' + p, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    }
    const { thread } = await http('/threads', { cwd: dir });
    await http('/threads/' + thread.id + '/turns', { text: 'hello', attachments: [], settings: foreground });
    await until(() => http('/threads/' + thread.id), r => r.thread.turns.at(-1).status === 'completed');
    const { watchdog: first } = await http('/watchdogs', { threadId: thread.id, ...config, prompt: 'watchdog-hold' });
    const { watchdog: second } = await http('/watchdogs', { threadId: thread.id, ...config });
    await http('/watchdogs/' + first.id, { revision: first.revision, action: 'run_now' });
    const { data: [run] } = await until(() => http('/watchdogs/' + first.id + '/runs'), r => !!r.data[0]?.turnId);
    const steer = http('/threads/' + thread.id + '/turns', { text: '继续检查', attachments: [], delivery: 'steer', expectedTurnId: run.turnId });
    await Promise.race([entered, steer]);
    await http('/watchdogs/' + second.id, { revision: second.revision, action: 'run_now' });
    await adapter.call('mock/release', { threadId: thread.id, turnId: run.turnId });
    await until(() => http('/threads/' + thread.id), r => r.thread.turns.at(-1).status === 'completed');
    assert.equal((await http('/watchdogs/' + first.id)).watchdog.running, true);
    releaseSteer();
    await steer;
    await until(() => http('/watchdogs/' + first.id), r => r.watchdog.state === 'completed' && !r.watchdog.running);
    await until(() => http('/watchdogs/' + second.id), r => r.watchdog.state === 'completed');
    assert.equal((await http('/watchdogs/' + first.id + '/runs')).data.length, 1);
    assert.deepEqual((await http('/threads/' + thread.id)).thread.settings, foreground);
  } finally { releaseSteer(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
