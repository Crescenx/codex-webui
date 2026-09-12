import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { generateTitle } from '../server/title.ts';

test('title generation is isolated, ephemeral, bounded and validates model output', async () => {
  const parent = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const fork = parent.fork.bind(parent);
  let worker: AppServer | undefined;
  parent.fork = () => {
    worker = fork(); const call = worker.call.bind(worker);
    worker.call = async (method, params = {}) => {
      if (method === 'thread/start') {
        assert.equal(params.ephemeral, true); assert.equal(params.sandbox, 'read-only');
        assert.equal(params.approvalPolicy, 'never'); assert.equal(params.model, 'mock');
        assert.equal((params.config as Record<string, unknown>)['features.shell_tool'], false);
        assert.notEqual(params.cwd, process.cwd());
      }
      if (method === 'turn/start') {
        assert.equal(JSON.parse((params.input as {text:string}[])[0].text).task.length, 8000); assert.ok(params.outputSchema);
      }
      return call(method, params);
    };
    return worker;
  };
  assert.equal(await generateTitle(parent, '先写一长段背景\n最后才描述实际目的'.repeat(1000), 'mock'), '概括任务目的');
  assert.equal(parent.child, undefined); assert.equal(worker?.child?.killed ?? true, true);
  assert.equal(parent.listenerCount('offline'), 0);
  for (const output of ['not json', '{"title":""}', '{"title":"line\\nbreak"}', JSON.stringify({title:'长'.repeat(41)})]) {
    const malformed = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: {...process.env, VIEWER_FAKE_TITLE:output} });
    await assert.rejects(generateTitle(malformed, '任务', 'mock'));
    assert.equal(malformed.listenerCount('offline'), 0);
  }
});
