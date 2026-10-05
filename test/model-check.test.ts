import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceNotice, type Thread } from '../shared/protocol.ts';
import { mergeAgentHistory } from '../shared/agents.ts';
import { parseWireResponse, wireVerdict } from '../shared/model-check.ts';
import { createWireMonitor } from '../server/wire-monitor.ts';
import type { Notice } from '../shared/protocol.ts';

test('native WebSocket capture joins by response ID under concurrent and reordered logs', () => {
  const notices: Notice[] = [], consume = createWireMonitor(n => notices.push(n));
  const prefix = '2026-09-19T00:48:45.896481Z TRACE ';
  const response = (id: string, model: string | null, event = 'response.completed') => prefix + 'tungstenite::protocol: Received message ' + JSON.stringify({ type: event, response: { id, model, reasoning: { effort: 'high' }, status: 'completed', instructions: 'PRIVATE', output: [{ text: 'PRIVATE' }] } }) + '\n';
  const timing = (id: string, thread: string, turn: string, warmup = false) => prefix + 'codex_api::responses_websocket_timing: responses websocket timing ' + `model="requested" thread_id="${thread}" turn_id="${turn}" warmup=${warmup} payload=` + JSON.stringify(JSON.stringify({ type: 'responsesapi.websocket_timing', timing_metrics: { response_id: id } })) + '\n';
  consume(response('resp_A', 'actual_A') + response('resp_B', 'actual_B'));
  assert.equal(notices.length, 0); // A model name alone is not attributable.
  const chunk = timing('resp_B', 'thread_B', 'turn_B');
  consume(chunk.slice(0, 90)); consume(chunk.slice(90)); consume(timing('resp_A', 'thread_A', 'turn_A'));
  assert.deepEqual(notices.map(n => [n.params.threadId, n.params.turnId, n.params.model]), [['thread_B', 'turn_B', 'actual_B'], ['thread_A', 'turn_A', 'actual_A']]);
  consume(timing('resp_C', 'thread_C', 'turn_C')); consume(response('resp_C', 'actual_C', 'response.created')); consume(response('resp_C', 'actual_C'));
  assert.equal(notices.length, 4);
  assert.equal(notices[0]!.params.effort, 'high');
  consume(response('resp_C', 'actual_C')); // Duplicate trace does not repeat UI records.
  consume(timing('warmup', 'thread_D', '', true) + response('warmup', 'requested'));
  consume(response('unjoined', 'requested') + timing('unjoined', 'thread_D', ''));
  consume(prefix + 'tungstenite::protocol: Sending frame: ' + response('spoof', 'requested'));
  consume('x'.repeat(4_000_001) + response('oversize', 'requested'));
  consume(timing('oversize', 'thread_D', 'turn_D'));
  assert.equal(notices.length, 4);
  assert.ok(!JSON.stringify(notices).includes('PRIVATE'));
  consume(timing('missing', 'thread_D', 'turn_D') + response('missing', null));
  assert.equal(notices.at(-1)!.params.model, null);
  const t: Thread = { id: 'thread_B', cwd: '/' };
  reduceNotice(t, notices[0]!); reduceNotice(t, notices[0]!);
  assert.equal(t.modelEvidence?.length, 1);
  assert.equal(t.modelEvidence?.[0]?.responseId, 'resp_B');
  assert.equal(t.modelEvidence?.[0]?.effort, 'high');
});

test('HTTP evidence comes from response.model, never nested output or requested model text', () => {
  const line = '2026-09-19T00:37:35Z TRACE codex_api::sse::responses: SSE event: ';
  const event = { type: 'response.completed', response: { id: 'resp_123', model: 'actual', status: 'completed', output: [{ text: 'model=requested secret' }] } };
  const parsed = parseWireResponse(line + JSON.stringify(event))!;
  assert.deepEqual(parsed, { event: 'response.completed', model: 'actual', effort: null, responseId: 'resp_123', status: 'completed' });
  for (const effort of ['low', 'medium', 'high', null, { untrusted: 'high' }]) {
    const value = parseWireResponse(line + JSON.stringify({ ...event, response: { ...event.response, reasoning: { effort } } }));
    assert.equal(value?.effort, typeof effort === 'string' ? effort : null);
  }
  assert.equal(wireVerdict('actual', [parsed]), 'match');
  assert.equal(wireVerdict('requested', [parsed]), 'different');
  assert.equal(wireVerdict('actual', []), 'unknown');
  assert.equal(wireVerdict('actual', [{ ...parsed, model: null }]), 'unknown');
  assert.equal(wireVerdict('actual', [{ ...parsed, event: 'response.created' }]), 'unknown');
  assert.equal(parseWireResponse(JSON.stringify(event)), null);
  assert.equal(parseWireResponse(line + '{bad json'), null);
  assert.equal(parseWireResponse(line + JSON.stringify({ ...event, type: 'response.output_text.delta' })), null);
});

test('model evidence is scoped, bounded and survives history refresh without inferring identity', () => {
  const t: Thread = { id: 't', cwd: '/', settings: { model: 'requested', effort: 'high', mode: 'default' } };
  const reroute = { method: 'model/rerouted', params: { threadId: 't', turnId: '1', fromModel: 'requested', toModel: 'reported', reason: 'test' } };
  reduceNotice(t, { ...reroute, params: { ...reroute.params, threadId: 'other' } });
  assert.equal(Boolean(t.modelEvidence), false);
  reduceNotice(t, reroute); // Notifications may precede the turn/start response.
  reduceNotice(t, { method: 'viewer/turnModel', params: { threadId: 't', turnId: '1', model: 'requested', effort: 'high' } });
  assert.deepEqual(t.modelEvidence?.map(e => e.model), ['reported', 'requested']);
  assert.equal(t.settings?.model, 'requested');
  assert.equal(mergeAgentHistory({ id: 't', cwd: '/', turns: [] }, t, false).modelEvidence?.length, 2);
  reduceNotice(t, { ...reroute, params: { ...reroute.params, toModel: 7 } });
  assert.equal(t.modelEvidence?.length, 2);
  for (let i = 0; i < 110; i++) reduceNotice(t, { method: 'viewer/turnModel', params: { threadId: 't', turnId: String(i) } });
  assert.equal(t.modelEvidence?.length, 100);
  assert.equal(t.modelEvidence?.at(-1)?.model, null);
});
