import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWorkspace } from '../web/workspace-path.ts';

test('display filtering accepts Windows mount casing but preserves Linux paths and directory boundaries', () => {
  assert.equal(inWorkspace('/mnt/d/Documents/obsidian/knowbase', '/mnt/d/documents/obsidian/knowbase'), true);
  assert.equal(inWorkspace('/mnt/d/Documents/obsidian/knowbase/', '/mnt/d/documents/obsidian/knowbase/sub'), true);
  assert.equal(inWorkspace('/mnt/d/Documents/obsidian/knowbase', '/mnt/d/documents/obsidian/knowbase-other'), false);
  assert.equal(inWorkspace('/home/user/Notes', '/home/user/notes'), false);
});
