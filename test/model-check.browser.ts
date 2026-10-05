import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('model check records submitted settings, shows reroutes and survives page reload', async ({ page }) => {
  const dir = await mkdtemp('/tmp/viewer-model-check-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter);
  adapter.call = async (method, params = {}) => {
    const r = await call(method, params);
    if (method === 'config/read') r.config = { ...r.config as object, model_provider: null, chatgpt_base_url: 'https://chatgpt.com/backend-api/' };
    return r;
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click(); await page.locator('.folder').filter({ hasText: dir }).click(); await page.locator('#folder-select').click();
    await page.locator('#model-check > summary').click();
    await expect(page.locator('#model-check')).toContainText('尚无证据');
    await page.getByText('独立 HTTP 诊断（可选）', { exact: true }).click();
    await page.route('**/api/threads/*/model-check', route => route.fulfill({ json: { requestedModel: 'mock', effort: 'medium', transport: 'HTTP SSE', recordedAt: '2026-09-19T00:00:00Z', verdict: 'different', responses: [{ event: 'response.completed', model: 'wire-other', responseId: 'resp_check', status: 'completed' }] } }));
    await page.getByRole('button', { name: '发送短请求实测 HTTP' }).click();
    await expect(page.locator('.wire-result')).toContainText('返回模型名不同');
    await expect(page.locator('.wire-result')).toContainText('wire-other');
    await expect(page.locator('.wire-result')).toContainText('resp_check');
    // Exercise the real HTTP route and child lifecycle; the fake has no wire response evidence.
    await page.unroute('**/api/threads/*/model-check');
    await page.getByRole('button', { name: '发送短请求实测 HTTP' }).click();
    await expect(page.locator('.wire-result')).toContainText('响应证据不足');
    await page.locator('#prompt').fill('hold-tool'); await page.locator('#send').click();
    await expect(page.locator('#model-check')).toContainText('已接受的 turn/start 请求');
    const threadId = new URL(page.url()).hash.slice(1);
    const snapshot = await adapter.call('thread/read', { threadId, includeTurns: true });
    const turnId = (snapshot.thread as { turns: { id: string }[] }).turns.at(-1)!.id;
    // Use the same parser as the child stderr stream, then exercise SSE, reducer and UI.
    const { createWireMonitor } = await import('../server/wire-monitor.ts');
    const consume = createWireMonitor(n => adapter.emit('notice', n));
    const prefix = '2026-09-19T00:48:45.896481Z TRACE ';
    const capture = (responseId: string, model: string) => {
      consume(prefix + 'tungstenite::protocol: Received message ' + JSON.stringify({ type: 'response.completed', response: { id: responseId, model, reasoning: { effort: 'high' }, status: 'completed' } }) + '\n');
      consume(prefix + 'codex_api::responses_websocket_timing: responses websocket timing ' + `model="mock" thread_id="${threadId}" turn_id="${turnId}" warmup=false payload=` + JSON.stringify(JSON.stringify({ type: 'responsesapi.websocket_timing', timing_metrics: { response_id: responseId } })) + '\n');
    };
    capture('resp_real_1', 'mock');
    await expect(page.locator('#model-check > summary')).toContainText('mock → mock · 1 次响应');
    await expect(page.locator('#model-check')).toContainText('resp_real_1');
    await expect(page.locator('#model-check')).toContainText('返回 effort：high');
    capture('resp_real_2', 'other-model');
    await expect(page.locator('#model-check > summary')).toContainText('本轮返回模型名不同');
    adapter.emit('notice', { method: 'model/rerouted', params: { threadId, turnId, fromModel: 'requested', toModel: 'reported-model', reason: 'other' } });
    await expect(page.locator('#model-check > summary')).toContainText('本轮返回模型名不同');
    await expect(page.locator('#model-check')).toContainText('requested → reported-model');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出证据 JSON' }).click();
    expect((await download).suggestedFilename()).toBe('model-evidence.json');
    await page.reload();
    await expect(page.locator('#model-check > summary')).toContainText('本轮返回模型名不同');
    await page.locator('#model-check > summary').click();
    await expect(page.locator('#model-check')).toContainText('resp_real_2');
    await expect(page.locator('#model-check')).toContainText('reported-model');
    await page.screenshot({ path: 'test-results/model-check-desktop.png' });
    await page.locator('#stop').click();
    await page.locator('#prompt').fill('next'); await page.locator('#send').click();
    await expect(page.locator('#model-check > summary')).toContainText('实际模型尚无法确认');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
