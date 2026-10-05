import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from './adapter.ts';
import { object, type Settings, type Notice } from '../shared/protocol.ts';
import { parseWireResponse, wireVerdict, type WireCheck, type WireResponse } from '../shared/model-check.ts';

// A separate ephemeral session makes captured HTTP responses attributable to this probe.
export async function checkModelWire(runtimeDir: string, settings: Settings, adapter = new AppServer()): Promise<WireCheck> {
  const cwd = await mkdtemp(path.join(runtimeDir, 'model-check-'));
  adapter.configureLaunch({ args: ['-c', 'model_provider="viewer-wire-check"', '-c', 'model_providers.viewer-wire-check={name="OpenAI wire check",base_url="https://chatgpt.com/backend-api/codex",wire_api="responses",requires_openai_auth=true,supports_websockets=false}'], env: { RUST_LOG: 'error,codex_api::sse::responses=trace', NO_COLOR: '1' } });
  const responses: WireResponse[] = [];
  let buffer = '', truncated = false, timer: NodeJS.Timeout | undefined;
  adapter.on('request', m => adapter.unsupported(m.id));
  const run = async () => {
    await adapter.start();
    adapter.child!.stderr.setEncoding('utf8');
    adapter.child!.stderr.on('data', (chunk: string) => {
      // Bound partial lines; never persist raw payloads or forward stderr.
      for (const part of chunk.split(/(?<=\n)/)) {
        if (buffer.length + part.length > 2_000_000) { buffer = ''; truncated = true; }
        if (!truncated) buffer += part;
        if (part.endsWith('\n')) {
          if (!truncated) { const e = parseWireResponse(buffer.trimEnd()); if (e && responses.length < 100) responses.push(e); }
          buffer = ''; truncated = false;
        }
      }
    });
    const created = await adapter.call('thread/start', { cwd, model: settings.model, sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true });
    const threadId = object(created.thread).id;
    const completed = new Promise<void>((resolve, reject) => {
      adapter.once('offline', () => reject(new Error('模型探测连接中断')));
      adapter.on('notice', (n: Notice) => {
        if (n.method === 'turn/completed' && n.params.threadId === threadId) {
          if (object(n.params.turn).status === 'completed') resolve();
          else reject(new Error('模型探测未完成；不能判断模型是否一致'));
        }
      });
    });
    void completed.catch(() => {});
    await adapter.call('turn/start', { threadId, input: [{ type: 'text', text: 'Reply only OK. Do not use tools.', text_elements: [] }], model: settings.model, effort: settings.effort });
    await completed;
    return { requestedModel: settings.model, effort: settings.effort, transport: 'HTTP SSE' as const, recordedAt: new Date().toISOString(), responses, verdict: wireVerdict(settings.model, responses) };
  };
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP 模型探测超时')), 90_000); })]);
  } finally { clearTimeout(timer); adapter.stop(); await rm(cwd, { recursive: true, force: true }); }
}
