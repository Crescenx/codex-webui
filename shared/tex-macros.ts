export type MathDefinitions = Readonly<Record<string, string>>;
export type TexDeclaration = { name: string; command: string; source: string; optionalDefault?: boolean };

// Extract declarations, not arbitrary TeX programs. KaTeX handles their expansion later.
export function texDeclarations(input: string): TexDeclaration[] {
  // shortcut: cap source, declaration count and body size; larger preambles need explicit import support.
  const source = input.slice(0, 500_000).replace(/\\[\s\S]|%[^\r\n]*/g, token => token.startsWith('%') ? '' : token);
  const declarations: TexDeclaration[] = [];
  const commands = /\\([A-Za-z]+|[^])/g;
  const space = (at: number) => { while (/\s/.test(source[at] || '') && at < source.length) at++; return at; };
  const group = (at: number, open: string, close: string): number => {
    if (source[at] !== open) return -1;
    let depth = 1;
    for (let i = at + 1; i < source.length && i - at <= 8192; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (open === '[' && source[i] === '{') { const end = group(i, '{', '}'); if (end < 0) return -1; i = end - 1; continue; }
      if (source[i] === open) depth++;
      if (source[i] === close) { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  for (let match; (match = commands.exec(source)) && declarations.length < 256;) {
    const command = match[1];
    if (!['newcommand', 'renewcommand', 'providecommand', 'DeclareMathOperator', 'def', 'gdef'].includes(command)) continue;
    let at = space(commands.lastIndex);
    let optionalDefault = false;
    if (source[at] === '*') at = space(at + 1);
    let name: string;
    if (source[at] === '{') {
      const end = group(at, '{', '}'); if (end < 0) continue;
      name = source.slice(at + 1, end - 1).trim(); at = space(end);
    } else {
      const token = /^\\[A-Za-z]+/.exec(source.slice(at)); if (!token) continue;
      name = token[0]; at = space(at + name.length);
    }
    if (!/^\\[A-Za-z]+$/.test(name)) continue;
    if (command === 'def' || command === 'gdef') {
      let parameter = 1;
      while (source[at] === '#' && source[at + 1] === String(parameter) && parameter <= 9) { at = space(at + 2); parameter++; }
    } else if (command !== 'DeclareMathOperator' && source[at] === '[') {
      const end = group(at, '[', ']'); if (end < 0 || !/^[0-9]$/.test(source.slice(at + 1, end - 1).trim())) continue;
      at = space(end);
      if (source[at] === '[') { const end = group(at, '[', ']'); if (end < 0) continue; at = space(end); optionalDefault = true; }
    }
    const end = group(at, '{', '}'); if (end < 0) continue;
    declarations.push({ name, command, source: source.slice(match.index, end), ...(optionalDefault ? {optionalDefault:true} : {}) });
    commands.lastIndex = end;
  }
  return declarations;
}
