import assert from 'node:assert/strict';
import test from 'node:test';
import { appDownloads } from '../web/mcp-download.ts';

test('MCP downloads use the source resource reader, validate identity and bound bytes', async () => {
  const uris: string[] = [];
  const files = await appDownloads([{ type: 'resource_link', uri: 'private://file', name: '../report.txt' }], async uri => {
    uris.push(uri); return { contents: [{ uri, text: 'hello' }] };
  });
  assert.deepEqual(uris, ['private://file']); assert.equal(files[0].name, '_report.txt');
  assert.equal(await files[0].blob.text(), 'hello');
  await assert.rejects(appDownloads([{ type: 'resource_link', uri: 'x://1', name: 'x' }], async () => ({ contents: [{ uri: 'x://2', text: 'wrong' }] })), /地址不匹配/);
  await assert.rejects(appDownloads([{ type: 'resource', resource: { uri: 'x', blob: '!!!' } }], async () => { throw new Error('must not fetch embedded resource'); }), /Base64/);
  await assert.rejects(appDownloads([{ type: 'resource', resource: { uri: 'x', text: 'x'.repeat(16 * 1024 * 1024 + 1) } }], async () => { throw new Error('must not fetch'); }), /16 MiB/);
});
