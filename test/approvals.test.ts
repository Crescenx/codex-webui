import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approvalChoices } from '../shared/approvals.ts';
import type { Obj, PendingRequest } from '../shared/protocol.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

const request = (params: Obj = {}, method = 'item/commandExecution/requestApproval'): PendingRequest => ({ id: 'request', method, params, windows: false });
test('approval choices preserve offered scopes, exact rules and permission subsets', () => {
  assert.ok(approvalChoices(request()).some(c => c.id === 'acceptForSession'));
  assert.deepEqual(approvalChoices(request({ availableDecisions: ['decline', 'cancel'], proposedExecpolicyAmendment: ['ssh'] })).map(c => c.id), ['decline', 'cancel']);
  assert.ok(!approvalChoices(request({ proposedExecpolicyAmendment: [] })).some(c => c.id === 'rememberCommand'));
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ssh', 'test-host'] } };
  const choices = approvalChoices(request({ proposedExecpolicyAmendment: ['ssh', 'test-host'], availableDecisions: ['accept', decision, 'cancel'] }));
  assert.deepEqual(choices.find(c => c.id === 'rememberCommand')?.result, { decision });
  assert.ok(!choices.some(c => c.id === 'acceptForSession'));
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.test' } } };
  assert.deepEqual(approvalChoices(request({ proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }], availableDecisions: [network] }))[0].result, { decision: network });
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/tmp/project'] } };
  assert.deepEqual(approvalChoices(request({ permissions }, 'item/permissions/requestApproval')).find(c => c.id === 'acceptForSession')?.result, { permissions, scope: 'session' });
  assert.deepEqual(approvalChoices(request({ permissions }, 'item/permissions/requestApproval')).find(c => c.id === 'decline')?.result, { permissions: {}, scope: 'turn' });
  assert.ok(approvalChoices(request({}, 'item/fileChange/requestApproval')).some(c => c.id === 'acceptForSession'));
  assert.ok(!approvalChoices(request({}, 'item/tool/requestUserInput')).some(c => c.description));
  assert.match(approvalChoices(request({proposedExecpolicyAmendment:['/usr/bin/zsh','-lc','ssh host script']})).find(c=>c.id==='rememberCommand')!.description!,/整段 shell 脚本/);
});

test('HTTP grants only server-proposed rules and preserves the configured approvals reviewer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-approvals-'));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter), calls: { method: string; params: Obj }[] = [], replies: Obj[] = [];
  let reviewer='auto_review',ignoreUpdate=false;
  adapter.call = async (method, params = {}) => { calls.push({ method, params }); if(method==='config/read')return {config:{approvals_reviewer:reviewer}};if(method==='thread/settings/update'&&ignoreUpdate)return {};return call(method, params); };
  adapter.respond = (_, result) => { replies.push(result); };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const login = await fetch(app.launchUrl, { redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0];
    const http = async (url: string, body?: unknown) => fetch(app.origin + '/api' + url, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const { thread } = await (await http('/threads', { cwd: dir })).json();
    assert.equal(thread.approvalsReviewer,'auto_review');
    const external = await call('thread/start', { cwd: dir });
    assert.equal((external.thread as Obj).approvalsReviewer,'user');
    const restored=await(await http(`/threads/${(external.thread as Obj).id}/open`, {})).json();assert.equal(restored.thread.approvalsReviewer,'auto_review');
    await http(`/threads/${thread.id}/turns`, { text: 'approve', attachments: [] });
    for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
      const observed = calls.filter(c => c.method === method && !c.params.excludeTurns); assert.ok(observed.length);
      assert.ok(observed.every(c => c.params.approvalsReviewer==='auto_review'));
    }
    assert.ok(calls.some(c=>c.method==='thread/settings/update'&&c.params.approvalsReviewer==='auto_review'));
    reviewer='user';
    await http(`/threads/${(external.thread as Obj).id}/turns`,{text:'approve',attachments:[]});
    assert.equal(calls.filter(c=>c.method==='turn/start').at(-1)!.params.approvalsReviewer,'user');
    reviewer='auto_review';
    const active=await(await http(`/threads/${(external.thread as Obj).id}/open`,{})).json();
    assert.equal(active.thread.approvalsReviewer,'auto_review');assert.equal(active.thread.status.type,'active');assert.equal(active.requests.length,1);
    assert.ok(calls.some(c=>c.method==='turn/settings/update'&&c.params.approvalsReviewer==='auto_review'));
    reviewer='user';ignoreUpdate=true;
    assert.equal((await http(`/threads/${thread.id}/open`,{})).status,502);
    reviewer='auto_review';ignoreUpdate=false;
    const inject = async (params: Obj) => {
      adapter.emit('request', { id: 'controlled', method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: 'turn', ...params } });
      const snapshot = await (await http(`/threads/${thread.id}`)).json();
      return snapshot.requests.at(-1).id;
    };
    let id = await inject({ availableDecisions: ['accept', 'decline', 'cancel'] });
    assert.equal((await http('/requests/' + id, { decision: 'acceptForSession' })).status, 400);
    assert.equal(replies.length, 0);
    await http('/requests/' + id, { decision: 'decline' });
    id = await inject({ proposedExecpolicyAmendment: ['ssh', 'test-host'] });
    assert.equal((await http('/requests/' + id, { decision: 'rememberCommand', proposedExecpolicyAmendment: ['sh'] })).status, 200);
    assert.deepEqual(replies.at(-1), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ssh', 'test-host'] } } });
    assert.equal((await http('/requests/' + id, { decision: 'rememberCommand' })).status, 409);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
