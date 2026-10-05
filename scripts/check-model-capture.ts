import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { object, type Notice } from '../shared/protocol.ts';

// Opt-in live verification: two concurrent native WebSocket turns; no provider or transport override.
const root = path.resolve('.model-capture-check'); await mkdir(root, { recursive: true, mode: 0o700 });
const cwd = await mkdtemp(path.join(root, 'workspace-'));
const adapter = new AppServer({ cwd }); adapter.configureLaunch({ captureModels: true });
const captured: Notice[] = [];
adapter.on('request', m => adapter.unsupported(m.id));
adapter.on('notice', (n: Notice) => { if (n.method === 'viewer/modelResponse') captured.push(n); });
try {
  await adapter.start();
  const ids = await Promise.all([1, 2].map(async index => {
    const created = await adapter.call('thread/start', { cwd, model: 'gpt-6-astra', sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true });
    const threadId = object(created.thread).id;
    let timer: NodeJS.Timeout;
    const completed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Live capture timed out')), 90_000);
      adapter.on('notice', (n: Notice) => { if (n.method === 'turn/completed' && n.params.threadId === threadId) { clearTimeout(timer); resolve(); } });
    });
    const result = await adapter.call('turn/start', { threadId, input: [{ type: 'text', text: `Reply only OK${index}. Do not use tools.`, text_elements: [] }], model: 'gpt-6-astra', effort: index === 1 ? 'low' : 'medium' });
    await completed;
    return { threadId, requestedEffort: index === 1 ? 'low' : 'medium', turnId: object(result.turn).id };
  }));
  // Drain both streams before asserting, regardless of stdout/stderr scheduling.
  const closed = new Promise<void>(resolve => adapter.child!.once('close', () => resolve()));
  adapter.stop(); await closed;
  for (const { threadId, turnId } of ids) {
    const rows = captured.filter(n => n.params.threadId === threadId && n.params.turnId === turnId && n.params.event === 'response.completed');
    assert.ok(rows.length, 'Missing real response evidence for a turn');
    assert.ok(rows.every(n => n.params.requestedModel === 'gpt-6-astra' && typeof n.params.model === 'string' && typeof n.params.responseId === 'string'));
  }
  assert.ok(captured.every(n => ids.some(id => id.threadId === n.params.threadId && id.turnId === n.params.turnId)), 'Warmup/unrelated response leaked');
  const evidence = path.join(root, `evidence-${Date.now()}.json`);
  await writeFile(evidence, JSON.stringify({ verifiedAt: new Date().toISOString(), ids, captured }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ turns: ids.length, completedResponses: captured.filter(n => n.params.event === 'response.completed').length, models: [...new Set(captured.map(n => n.params.model))], efforts: ids.map(id => ({ requested: id.requestedEffort, returned: captured.filter(n => n.params.threadId === id.threadId && n.params.event === 'response.completed').map(n => n.params.effort) })), evidence }));
} finally { adapter.stop(); await rm(cwd, { recursive: true, force: true }); }
