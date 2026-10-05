import type { Skill } from '../shared/protocol.ts';

export function matchingSkills(skills: readonly Skill[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const rank = (s: Skill) => {
    const name = s.name.toLocaleLowerCase();
    return !needle || name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : s.description.toLocaleLowerCase().includes(needle) ? 3 : 4;
  };
  return skills.filter(s => rank(s) < 4).sort((a, b) => rank(a) - rank(b));
}

export function skillTrigger(text: string, caret: number) {
  const match = /(?:^|\s)\$([^\s$]*)$/.exec(text.slice(0, caret));
  if (!match || /^[\d({]/.test(match[1]!) || text[caret] === '$') return null;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
}
