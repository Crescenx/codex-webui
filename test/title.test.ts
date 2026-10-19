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


test('Google titles use the Google worker with isolated storage and no tools', async () => {
  const {RuntimeServers} = await import('../server/runtimes.ts');
  const {access} = await import('node:fs/promises');
  const codex = new AppServer();
  codex.fork = () => {throw Error('Google title must not call Codex');};
  const google = new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const fork = google.fork.bind(google);
  let state = '', unloaded = false, catalogLoaded = false;
  google.fork = () => {
    const worker = fork();
    const configure = worker.configureLaunch.bind(worker);
    worker.configureLaunch = options => {state=options.env!.AGY_APP_SERVER_HOME!;configure(options);};
    const call = worker.call.bind(worker);
    worker.call = async (method, params = {}) => {
      if (method === 'model/list') catalogLoaded = true;
      if (method === 'thread/start') {
        assert.ok(catalogLoaded, 'load model variants before selecting a grouped Google model');
        assert.equal(params.model,'mock');assert.equal(params.ephemeral,true);
        assert.deepEqual(params.config,{tools_disabled:true,mcp_servers:{}});
        assert.equal(path.dirname(state),params.cwd);
        assert.ok(params.baseInstructions);assert.ok(params.developerInstructions);
      }
      if (method === 'turn/start') {assert.ok(params.outputSchema);assert.equal(params.effort,undefined);}
      if (method === 'thread/unload') unloaded=true;
      return call(method,params);
    };
    return worker;
  };
  const parent = new RuntimeServers(codex,google);
  assert.equal(await generateTitle(parent,'编写线性代数补习讲义','antigravity/mock'),'概括任务目的');
  assert.ok(unloaded);assert.ok(state);await assert.rejects(access(path.dirname(state)));
  assert.equal(codex.child,undefined);assert.equal(google.child,undefined);
  assert.equal(parent.listenerCount('offline'),0);
});
