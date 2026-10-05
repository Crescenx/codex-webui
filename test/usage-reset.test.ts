import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('quota reset validates confirmation, serializes redemption and forwards native outcomes without retry', async () => {
  const dir = await mkdtemp('/tmp/viewer-usage-reset-api-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const call = adapter.call.bind(adapter), keys: unknown[] = [];
  let outcome = 'reset', fail = false, release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  adapter.call = async (method, params = {}) => {
    if (method !== 'account/rateLimitResetCredit/consume') return call(method, params);
    keys.push(params.idempotencyKey); started(); await held;
    if (fail) throw new Error('native reset unavailable');
    return { outcome };
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    const cookie = (await fetch(app.launchUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const key = randomUUID(), data = { confirm: true, idempotencyKey: key };
    const post = (body: unknown, origin = app.origin, auth = cookie) => fetch(app.origin + '/api/usage/reset', { method: 'POST', headers: { cookie: auth, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(data, app.origin, '')).status, 401);
    assert.equal((await post(data, 'https://evil.example')).status, 403);
    for (const invalid of [{}, { ...data, confirm: false }, { ...data, idempotencyKey: 'bad' }]) assert.equal((await post(invalid)).status, 400);
    assert.equal(keys.length, 0);
    const pending = post(data); await entered;
    assert.equal((await post({ ...data, idempotencyKey: randomUUID() })).status, 409);
    release(); assert.deepEqual(await (await pending).json(), { outcome: 'reset' });
    for (outcome of ['nothingToReset', 'noCredit', 'alreadyRedeemed']) assert.deepEqual(await (await post(data)).json(), { outcome });
    outcome = 'unexpected'; assert.equal((await post(data)).status, 502);
    fail = true; assert.equal((await post(data)).status, 502);
    assert.deepEqual(keys, Array(6).fill(key));
  } finally { release(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
