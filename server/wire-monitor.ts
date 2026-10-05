import type { Notice } from '../shared/protocol.ts';

// Codex 0.154: the request context is logged alongside timing_metrics.response_id.
// That ID joins the actual WebSocket response body without guessing from arrival order.
// Source: openai/codex rust-v0.154.0, codex-api/src/endpoint/responses_websocket.rs.
export const modelCaptureLog = 'tungstenite::protocol=trace,tungstenite::protocol::frame=off,codex_api::responses_websocket_timing=trace';
const scalar = (value: unknown): string | null => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : null;
type Scope = { threadId: string; turnId: string; requestedModel: string };
type Response = { effort: string | null; event: string; model: string | null; status: string | null; recordedAt: string };

export function createWireMonitor(emit: (notice: Notice) => void) {
  const pending = new Map<string, { scope?: Scope | null; responses: Map<string, Response>; sent: Set<string> }>();
  let buffer = '', truncated = false;
  function entry(id: string) {
    let value = pending.get(id);
    if (!value) {
      value = { responses: new Map(), sent: new Set() }; pending.set(id, value);
      // ponytail: bound unmatched/recent response metadata; missing joins stay unknown.
      if (pending.size > 512) pending.delete(pending.keys().next().value!);
    }
    return value;
  }
  function flush(id: string) {
    const value = pending.get(id)!;
    if (!value.scope) return;
    for (const [event, response] of value.responses) {
      if (value.sent.has(event)) continue;
      value.sent.add(event);
      emit({ method: 'viewer/modelResponse', params: { ...value.scope, ...response, responseId: id, transport: 'WebSocket' } });
    }
  }
  function line(raw: string) {
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+TRACE\s+(tungstenite::protocol|codex_api::responses_websocket_timing): (.*)$/.exec(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!match) return;
    const [, recordedAt, target, message] = match;
    try {
      if (target === 'tungstenite::protocol') {
        if (!message.startsWith('Received message ')) return;
        const event = JSON.parse(message.slice('Received message '.length));
        if (!['response.created', 'response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return;
        const id = scalar(event.response?.id); if (!id) return;
        const value = entry(id); if (value.scope === null) return;
        value.responses.set(event.type, { event: event.type, model: scalar(event.response.model), effort: scalar(event.response.reasoning?.effort), status: scalar(event.response.status), recordedAt });
        flush(id);
      } else {
        if (!message.startsWith('responses websocket timing ')) return;
        const split = message.indexOf(' payload='); if (split < 0) return;
        const header = message.slice(0, split);
        const payload = JSON.parse(JSON.parse(message.slice(split + ' payload='.length)));
        if (payload.type !== 'responsesapi.websocket_timing') return;
        const id = scalar(payload.timing_metrics?.response_id); if (!id) return;
        const field = (key: string) => {
          const found = new RegExp(`(?:^| )${key}=("(?:[^"\\\\]|\\\\.)*")`).exec(header);
          return found ? scalar(JSON.parse(found[1]!)) : null;
        };
        const threadId = field('thread_id'), turnId = field('turn_id'), requestedModel = field('model');
        const value = entry(id);
        if (/(?:^| )warmup=true(?: |$)/.test(header)) { value.scope = null; value.responses.clear(); return; }
        if (!threadId || !turnId || !requestedModel || !/(?:^| )warmup=false(?: |$)/.test(header)) return;
        // Conflicting identity is not safe to attribute, even if the models happen to agree.
        if (value.scope === null) return;
        if (value.scope && (value.scope.threadId !== threadId || value.scope.turnId !== turnId || value.scope.requestedModel !== requestedModel)) { value.scope = null; return; }
        value.scope = { threadId, turnId, requestedModel }; flush(id);
      }
    } catch { /* Malformed/unrecognized logs are never evidence and never forwarded. */ }
  }
  return (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (buffer.length + part.length > 4_000_000) { buffer = ''; truncated = true; }
      if (!truncated) buffer += part;
      if (part.endsWith('\n')) {
        if (!truncated) line(buffer.trimEnd());
        buffer = ''; truncated = false;
      }
    }
  };
}
