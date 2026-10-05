export type WireResponse = { effort: string | null; event: string; model: string | null; responseId: string | null; status: string | null };
export type WireCheck = { requestedModel: string; effort: string | null; transport: 'HTTP SSE'; recordedAt: string; responses: WireResponse[]; verdict: 'match' | 'different' | 'unknown' };
export function wireVerdict(model: string, responses: readonly WireResponse[]): WireCheck['verdict'] {
  if (responses.some(r => r.model && r.model !== model)) return 'different';
  const completed = responses.filter(r => r.event === 'response.completed');
  return completed.length && completed.every(r => r.model === model && r.status === 'completed' && r.responseId) ? 'match' : 'unknown';
}

// Parse only the transport logger's complete SSE JSON, never arbitrary text containing "model".
export function parseWireResponse(line: string): WireResponse | null {
  const marker = 'codex_api::sse::responses: SSE event: ';
  const at = line.indexOf(marker); if (at < 0) return null;
  try {
    const e = JSON.parse(line.slice(at + marker.length));
    if (!['response.created', 'response.completed', 'response.failed', 'response.incomplete'].includes(e.type)) return null;
    const scalar = (v: unknown) => typeof v === 'string' && /^[\w.:-]{1,200}$/.test(v) ? v : null;
    return { event: e.type, model: scalar(e.response?.model), effort: scalar(e.response?.reasoning?.effort), responseId: scalar(e.response?.id), status: scalar(e.response?.status) };
  } catch { return null; }
}
