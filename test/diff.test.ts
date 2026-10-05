import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileDiff, relativeDiffPath, splitDiffRows } from '../web/diff.ts';
const update = (diff: string, move_path: string | null = null) => parseFileDiff({ path: '/project/a.py', kind: { type: 'update', move_path }, diff });

test('native headerless hunks and Git file headers retain old/new line numbers and accurate counts', () => {
  const raw = '@@ -476,2 +476,4 @@\n     template = resolve()\n+    validate(template)\n+    budget = 100\n     return template\n@@ -500 +502 @@ run\n-old()\n+new()\n';
  const diff = update(raw);
  assert.equal(diff.added, 3); assert.equal(diff.removed, 1); assert.equal(diff.raw, raw); assert.equal(diff.note, '');
  assert.deepEqual(diff.lines.filter(l => l.kind !== 'hunk').map(l => [l.oldLine, l.newLine]), [[476, 476], [undefined, 477], [undefined, 478], [477, 479], [500, undefined], [undefined, 502]]);
  const prefixed = update('diff --git a/a.py b/a.py\nindex a1..b2 100644\n--- a/a.py\n+++ b/a.py\n' + raw);
  assert.deepEqual(prefixed.lines, diff.lines);
  const inserted = update('@@ -0,0 +1 @@\n+hello\n'); assert.equal(inserted.lines[1]!.newLine, 1); assert.equal(inserted.lines[1]!.oldLine, undefined);
  const deleted = update('@@ -1 +0,0 @@\n-hello\n'); assert.equal(deleted.removed, 1);
});

test('add/delete are full source, including leading patch characters, empty files and CRLF', () => {
  const raw = '+literal\r\n\r\n\tlast';
  for (const kind of ['add', 'delete']) {
    const diff = parseFileDiff({ path: 'file', kind: { type: kind }, diff: raw });
    assert.equal(diff.raw, raw); assert.equal(diff.lines[0]!.text, '+literal'); assert.equal(diff.lines[0]!.ending, '\r\n');
    assert.equal(diff.lines[1]!.text, ''); assert.equal(diff.lines[2]!.text, '\tlast'); assert.equal(diff.lines[3]!.kind, 'note');
    assert.equal(kind === 'add' ? diff.added : diff.removed, 3);
    const empty = parseFileDiff({ path: 'empty', kind: { type: kind }, diff: '' }); assert.equal(empty.added, 0); assert.equal(empty.removed, 0); assert.equal(empty.lines.length, 0);
  }
  const newline = parseFileDiff({ path: 'empty-line', kind: { type: 'add' }, diff: '\n' }); assert.equal(newline.added, 1);
});

test('rename-only changes and no-newline markers do not invent content or extra changed lines', () => {
  const renamed = update('', '/project/b.py'); assert.equal(renamed.label, '重命名'); assert.equal(renamed.added, 0); assert.equal(renamed.lines.length, 0);
  const diff = update('@@ -1 +1 @@\r\n-before\r\n\\ No newline at end of file\r\n+after\r\n\\ No newline at end of file\r\n');
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1); assert.equal(diff.lines[1]!.ending, ''); assert.equal(diff.lines[3]!.ending, '');
  const rows = splitDiffRows(diff.lines); assert.equal(rows.length, 3);
  assert.equal(rows[1]!.left!.text, 'before'); assert.equal(rows[1]!.right!.text, 'after'); assert.equal(rows[2]!.left!.kind, 'note');
});

test('incomplete, binary and malformed data preserve the original and report unknown statistics', () => {
  for (const raw of ['@@ -1,2 +1,2 @@\n-a\n+b\n', '@@@ -1 +1 @@@\n-a\n+b\n', '@@ -99999999999999999999 +1 @@\n-a\n+b', 'Binary files a/x and b/x differ', 'a\0b', '']) {
    const diff = update(raw); assert.equal(diff.added, null); assert.equal(diff.removed, null); assert.equal(diff.raw, raw); assert.equal(diff.lines.length, 0); assert.ok(diff.note);
  }
  assert.equal(parseFileDiff(null).raw, null);
  assert.equal(parseFileDiff({ path: 'a', kind: { type: 'wat' }, diff: 'content' }).added, null);
});

test('split view pairs replacement runs without dropping unpaired lines or context', () => {
  const diff = update('@@ -1,3 +1,4 @@\n context\n-old one\n-old two\n+new one\n+new two\n+new three\n');
  const rows = splitDiffRows(diff.lines);
  assert.equal(rows.length, 5); assert.equal(rows.at(-1)!.left, null); assert.equal(rows.at(-1)!.right!.text, 'new three');
  assert.equal(relativeDiffPath('/project/a.py', '/project'), 'a.py'); assert.equal(relativeDiffPath('/project-other/a.py', '/project'), '/project-other/a.py');
});
