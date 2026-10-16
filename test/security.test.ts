import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { inside, directory } from '../server/security.ts';

test('case aliases require filesystem identity and preserve directory boundaries', async () => {
  const base = await mkdtemp('/tmp/viewer-path-case-');
  try {
    const root = base + '/Vault', alias = base + '/vault', other = base + '/VAULT';
    await mkdir(root); await mkdir(root + '/notes'); await mkdir(other);
    await symlink(root, alias);
    assert.equal(inside(root, alias), true);
    assert.equal(inside(root, alias + '/notes'), true);
    assert.equal(inside(root, alias + '-private'), false);
    assert.equal(inside(root, other), false);
    assert.equal(inside(root, other + '/notes'), false);
    assert.equal(inside(root, alias + '/../VAULT'), false);
    await symlink(other, root + '/escape');
    await assert.rejects(directory(alias + '/escape', [root]), /授权/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
