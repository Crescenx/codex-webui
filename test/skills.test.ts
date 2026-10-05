import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingSkills, skillTrigger } from '../web/skills.ts';

test('skills match names before descriptions, and dollar triggers preserve ordinary syntax', () => {
  const list = ['audit-tools', 'pre-audit', 'audit', 'other'].map((name, i) => ({ name, path: '/skills/' + i, description: i === 3 ? 'Audit reports' : '说明', enabled: true }));
  assert.deepEqual(matchingSkills(list, 'AUDIT').map(s => s.name), ['audit', 'audit-tools', 'pre-audit', 'other']);
  assert.equal(matchingSkills(list, 'missing').length, 0);
  assert.equal(matchingSkills(list, '').length, 4);
  assert.deepEqual(skillTrigger('任务 $au 后文', 6), { start: 3, end: 6, query: 'au' });
  assert.deepEqual(skillTrigger('$', 1), { start: 0, end: 1, query: '' });
  for (const text of ['$$x', '$123', '$(cmd)', '${ENV}', 'cost$foo', '$x$']) assert.equal(skillTrigger(text, text.length), null, text);
  assert.equal(skillTrigger('$x$', 2), null);
});
