import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { launchUrl, psQuote, waitForViewer, powershell } from '../scripts/open.ts';

test('Windows launcher uses PowerShell 7 from PATH or the explicit installation path', t => {
  const saved = process.env.VIEWER_PWSH;
  let command = '';
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[]) => {
    command = file;
    assert.deepEqual(args.slice(0, 4), ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
    assert.ok(Buffer.from(args[4], 'base64').toString('utf16le').endsWith('Write-Output VIEWER_OK'));
    return 'VIEWER_OK\r\n';
  });
  syncBuiltinESMExports();
  try {
    delete process.env.VIEWER_PWSH;
    assert.equal(powershell('Write-Output VIEWER_OK'), 'VIEWER_OK'); assert.equal(command, 'pwsh.exe');
    process.env.VIEWER_PWSH = '/mnt/c/Program Files/PowerShell/7/pwsh.exe';
    powershell('Write-Output VIEWER_OK'); assert.equal(command, process.env.VIEWER_PWSH);
  } finally {
    if (saved === undefined) delete process.env.VIEWER_PWSH; else process.env.VIEWER_PWSH = saved;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('launcher opens only a ready local URL, rereading a stale token', async () => {
  const token = 'a'.repeat(43);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-startup-'));
  const file = path.join(dir, 'url');
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    if (req.url === '/?token=' + token) res.writeHead(303, { Location: '/' }).end();
    else { await writeFile(file, url); res.writeHead(401).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/?token=${token}`;
  try {
    assert.equal(launchUrl(url + '\n'), url);
    for (const bad of [url.replace('127.0.0.1', 'example.com'), url.replace('http:', 'https:'), url + "'; calc.exe", url + '&redirect=https://example.com', url.replace(/:\d+\//, ':0/'), url.replace(/:\d+\//, ':65536/')]) {
      assert.throws(() => launchUrl(bad));
    }
    assert.equal(psQuote("a'b$(calc.exe)"), "'a''b$(calc.exe)'");
    await writeFile(file, url.replace(token, 'b'.repeat(43)));
    assert.equal(await waitForViewer(file, 3000), url);
    assert.equal(requests, 2);
    await assert.rejects(waitForViewer(path.join(dir, 'missing'), 10), /did not become ready/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
