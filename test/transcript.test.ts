import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptMemory, groupReasoning, groupTraces, traceRows, itemView, searchableText, type TranscriptRow } from '../web/transcript.ts';

test('trace defaults follow actual replies, preserve manual choices and retain every native search row', () => {
  const reading = createTranscriptMemory().reading('thread');
  const row = (key: string, type: string, text = ''): TranscriptRow => ({ key, original: { id: key, type, text }, turn: { id: 'turn', status: 'inProgress', items: [] } });
  const native = [row('user', 'userMessage'), row('r', 'reasoning'), row('tool', 'commandExecution'), row('reply', 'agentMessage')];
  const project = () => groupTraces(native.map(r => ({ ...r })));
  let all = project(), visible = traceRows(all, reading);
  assert.deepEqual(visible.map(r => r.key), ['user', 'trace:r', 'r', 'tool', 'reply']);
  assert.equal(all[1]!.trace, all[2]!.trace); assert.equal(all[1]!.trace!.count, 2);
  itemView(reading, 'trace:r').open = false;
  assert.deepEqual(traceRows(project(), reading).map(r => r.key), ['user', 'trace:r', 'reply']);
  itemView(reading, 'trace:r').open = true;
  native[3]!.original.text = 'Here is the result.';
  all = project(); visible = traceRows(all, reading);
  assert.equal(all[1]!.trace!.active, false);
  assert.deepEqual(visible.map(r => r.key), ['user', 'trace:r', 'reply']);
  assert.deepEqual(traceRows(all, reading, '', new Set(['tool'])).map(r => r.key), ['user', 'trace:r', 'tool', 'reply']);
  assert.equal(traceRows(all, reading, 'trace:r').length, 5);
  assert.deepEqual(all.map(r => r.original), native.map(r => r.original));
  itemView(reading, 'trace:r').open = true;
  assert.equal(traceRows(project(), reading).length, 5);
  native.push(row('next', 'reasoning'));
  all = project(); assert.equal(all.at(-1)!.trace!.active, true);
  for (const r of native) r.turn.status = 'completed';
  assert.equal(traceRows(project(), reading).at(-1)!.traceOpen, false);
  const app = row('app', 'mcpToolCall'); app.original.appContext = { resourceUri: 'ui://result' };
  assert.equal(groupTraces([app])[0]!.trace, undefined);
  const long = groupTraces(Array.from({ length: 1000 }, (_, i) => ({ ...row(String(i), 'reasoning'), turn: { id: 'done', status: 'completed', items: [] } })));
  assert.equal(traceRows(long, reading).length, 1); assert.equal(long[0]!.trace!.count, 1000);
});

test('reasoning groups preserve native rows, stop at messages and turns, and update their shared state', () => {
  const row = (key: string, type = 'reasoning', state = 'completed', turnId = 'turn'): TranscriptRow => ({ key, original: { id: key, type, viewerState: state, summary: ['**Original summary**'] }, turn: { id: turnId, status: 'inProgress', items: [] } });
  const native = [row('a'), row('b', 'reasoning', 'running'), row('tool', 'commandExecution'), row('c'), row('message', 'agentMessage'), row('d'), row('e', 'reasoning', 'completed', 'next')];
  const source = JSON.stringify(native.map(r => r.original));
  const project = () => groupReasoning(native.map(r => ({ ...r })));
  let rows = project();
  assert.deepEqual(rows.map(r => r.key), native.map(r => r.key));
  rows.forEach((r, i) => assert.equal(r.original, native[i]!.original));
  assert.equal(rows[0]!.reasoning, rows[1]!.reasoning);
  assert.deepEqual(rows[0]!.reasoning, { firstKey: 'a', lastKey: 'b', state: 'running' });
  assert.equal(rows[2]!.reasoning, undefined);
  for (const index of [3, 5, 6]) assert.equal(rows[index]!.reasoning!.firstKey, rows[index]!.key);
  assert.equal(JSON.stringify(native.map(r => r.original)), source);
  for (const state of ['completed', 'failed', 'cancelled', 'unknown']) {
    native[1]!.original.viewerState = state;
    assert.equal(project()[0]!.reasoning!.state, state);
  }
  native[1]!.original.viewerState = 'running'; native[1]!.turn.status = 'interrupted';
  assert.equal(project()[0]!.reasoning!.state, 'cancelled');
  native[1]!.turn.status = 'inProgress';
  native.splice(2, 0, row('appended', 'reasoning', 'running'));
  rows = project();
  assert.equal(rows[0]!.reasoning!.firstKey, 'a'); assert.equal(rows[0]!.reasoning!.lastKey, 'appended');
  assert.match(searchableText(rows[1]!.original, rows[1]!.turn), /\*\*Original summary\*\*/);
});

test('transcript memory reuses complete source renders, bounds caches and clears all session state', () => {
  const memory = createTranscriptMemory(), blocks = new Map<string, string>();
  const render = (key: string, source = '$x^2$ **source**', complete = true) => memory.render(key, source, 'a', blocks, complete);
  const first = render('a'); assert.equal(render('a'), first); assert.ok(first.atoms.size);
  assert.notEqual(render('a', 'changed'), first);
  assert.notEqual(render('a', 'changed', false), render('a', 'changed', false));
  const recent = render('recent'), oldest = render('0', 'text'); for (let i = 1; i < 199; i++) render(String(i), 'text');
  assert.equal(render('recent'), recent); render('overflow', 'text');
  assert.notEqual(render('0', 'text'), oldest);
  const large = 'x'.repeat(2_100_000), largeFirst = render('large-first', large);
  render('large-second', large); assert.notEqual(render('large-first', large), largeFirst);
  const reading = memory.reading('a'); itemView(reading, 'row').open = true; reading.anchor = 'row';
  for (let i = 0; i < 7; i++) memory.reading(String(i));
  assert.equal(memory.reading('a'), reading); memory.reading('extra');
  assert.equal(itemView(memory.reading('a'), 'row').open, true);
  for (let i = 0; i < 8; i++) memory.reading('other-' + i);
  assert.notEqual(memory.reading('a'), reading);
  const cached = render('clear'); memory.clear(); assert.notEqual(render('clear'), cached); assert.equal(memory.reading('a').anchor, '');
});

test('full-history search reads raw math, questions, command output and file diffs', () => {
  const turn = { id: 'turn', status: 'completed', items: [] };
  assert.match(searchableText({ id: 'q', type: 'agentMessage', text: '$x^2$', questions: [{ title: '选择处理方式' }] }, turn), /\$x\^2\$\n选择处理方式/);
  assert.match(searchableText({ id: 'c', type: 'commandExecution', command: 'run', aggregatedOutput: 'buried output' }, turn), /buried output/);
  assert.equal(searchableText({ id: 'f', type: 'fileChange', changes: [{ path: '/old', kind: { type: 'update', move_path: '/new' }, diff: '+hidden' }] }, turn), '/old\n/new\n+hidden');
});
