export type DiffLine = { kind: 'context' | 'add' | 'delete' | 'hunk' | 'note'; text: string; ending: string; oldLine?: number; newLine?: number; side?: 'old' | 'new' | 'both' };
export type FileDiff = { path: string; movePath: string; kind: string; label: string; raw: string | null; lines: DiffLine[]; added: number | null; removed: number | null; note: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sourceLines(raw: string) {
  if (!raw) return [];
  const parts = raw.split('\n'); if (raw.endsWith('\n')) parts.pop();
  return parts.map((text, i) => {
    const newline = i < parts.length - 1 || raw.endsWith('\n');
    return { text: newline && text.endsWith('\r') ? text.slice(0, -1) : text, ending: newline ? text.endsWith('\r') ? '\r\n' : '\n' : '' };
  });
}

export function parseFileDiff(value: unknown): FileDiff {
  const change = record(value), kind = record(change.kind);
  const result: FileDiff = { path: typeof change.path === 'string' ? change.path : '未知文件', movePath: typeof kind.move_path === 'string' ? kind.move_path : '', kind: typeof kind.type === 'string' ? kind.type : '', label: '', raw: typeof change.diff === 'string' ? change.diff : null, lines: [], added: null, removed: null, note: '' };
  result.label = result.movePath ? '重命名' : ({ add: '新增', delete: '删除', update: '修改' } as Record<string, string>)[result.kind] || '未知类型';
  const fallback = (note: string) => ({ ...result, lines: [], added: null, removed: null, note });
  if (result.raw === null) return fallback('记录中没有文本差异');
  if (result.raw.includes('\0') || (result.kind === 'update' && /^(?:GIT binary patch|Binary files .+ differ)/m.test(result.raw))) return fallback('非文本变更，无法显示逐行对比');
  const source = sourceLines(result.raw);
  if (result.kind === 'add' || result.kind === 'delete') {
    const add = result.kind === 'add';
    result.lines = source.map((line, i) => ({ ...line, kind: add ? 'add' : 'delete', ...(add ? { newLine: i + 1 } : { oldLine: i + 1 }) }));
    result.added = add ? source.length : 0; result.removed = add ? 0 : source.length;
    if (!source.length) result.note = add ? '新增空文件' : '删除空文件';
    else if (!result.raw.endsWith('\n')) result.lines.push({ kind: 'note', text: '文件末尾无换行', ending: '', side: add ? 'new' : 'old' });
    return result;
  }
  if (result.kind !== 'update') return fallback('无法识别变更类型，以下为原始记录');
  if (!source.length) {
    if (!result.movePath) return fallback('记录中没有文本差异');
    return { ...result, added: 0, removed: 0, note: '仅重命名，无文本修改' };
  }
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
  result.added = 0; result.removed = 0;
  for (const line of source) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line.text);
    if (header) {
      if (oldRemaining || newRemaining) return fallback('差异片段尚不完整，以下为原始记录');
      [oldLine, oldRemaining, newLine, newRemaining] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
      if (![oldLine, oldRemaining, newLine, newRemaining, oldLine + oldRemaining, newLine + newRemaining].every(Number.isSafeInteger) || (!oldLine && oldRemaining) || (!newLine && newRemaining)) return fallback('差异行号无效，以下为原始记录');
      result.lines.push({ ...line, kind: 'hunk' }); hunks++; continue;
    }
    if (line.text === '\\ No newline at end of file') {
      const previous = result.lines.at(-1);
      if (!previous || !['context', 'add', 'delete'].includes(previous.kind)) return fallback('差异换行标记无效，以下为原始记录');
      previous.ending = '';
      result.lines.push({ kind: 'note', text: '文件末尾无换行', ending: '', side: previous.kind === 'delete' ? 'old' : previous.kind === 'add' ? 'new' : 'both' }); continue;
    }
    if (!oldRemaining && !newRemaining) {
      if (/^(?:diff --git |index |--- |\+\+\+ |(?:old|new|deleted file|new file) mode |(?:dis)?similarity index |rename (?:from|to) )/.test(line.text) || !line.text) continue;
      return fallback('无法解析差异格式，以下为原始记录');
    }
    const prefix = line.text[0], text = line.text.slice(1);
    if (prefix === ' ' && oldRemaining > 0 && newRemaining > 0) {
      result.lines.push({ ...line, text, kind: 'context', oldLine: oldLine++, newLine: newLine++ }); oldRemaining--; newRemaining--;
    } else if (prefix === '-' && oldRemaining > 0) {
      result.lines.push({ ...line, text, kind: 'delete', oldLine: oldLine++ }); oldRemaining--; result.removed++;
    } else if (prefix === '+' && newRemaining > 0) {
      result.lines.push({ ...line, text, kind: 'add', newLine: newLine++ }); newRemaining--; result.added++;
    } else return fallback('差异片段尚不完整或格式无效，以下为原始记录');
  }
  if (!hunks || oldRemaining || newRemaining) return fallback('差异片段尚不完整，以下为原始记录');
  return result;
}

export function splitDiffRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let left: DiffLine[] = [], right: DiffLine[] = [];
  const flush = () => { for (let i = 0; i < Math.max(left.length, right.length); i++) rows.push({ left: left[i] || null, right: right[i] || null }); left = []; right = []; };
  for (const line of lines) {
    if (line.kind === 'delete' || (line.kind === 'note' && line.side === 'old')) left.push(line);
    else if (line.kind === 'add' || (line.kind === 'note' && line.side === 'new')) right.push(line);
    else { flush(); rows.push({ left: line, right: line }); }
  }
  flush(); return rows;
}

export function relativeDiffPath(path: string, cwd = ''): string {
  const root = cwd.replace(/\/+$/, '');
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
}

export function diffLanguage(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase() || '';
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', sh: 'bash', zsh: 'bash', json: 'json', css: 'css', html: 'xml', vue: 'xml', xml: 'xml', md: 'markdown', yaml: 'yaml', yml: 'yaml', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', java: 'java', sql: 'sql', toml: 'ini' } as Record<string, string>)[ext] || 'text';
}
