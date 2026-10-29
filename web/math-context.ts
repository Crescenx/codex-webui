import type { Item } from '../shared/protocol.ts';
import { texDeclarations, type MathDefinitions } from '../shared/tex-macros.ts';

function materialDefinitions(item: Item): MathDefinitions {
  const definitions: Record<string, string> = {};
  let remaining = 500_000, visited = 0;
  const read = (value: unknown, depth = 0) => {
    if (remaining <= 0 || depth > 12 || ++visited > 2048) return;
    if (typeof value === 'string') {
      const text = value.slice(0, remaining); remaining -= text.length;
      if (/^\s*[\[{]/.test(text)) {
        try { const decoded: unknown = JSON.parse(text); read(decoded, depth + 1); return; } catch { /* plain tool output */ }
      }
      for (const declaration of texDeclarations(text)) {
        if (Object.keys(definitions).length >= 256) break;
        if (declaration.command !== 'providecommand' || !Object.hasOwn(definitions, declaration.name)) definitions[declaration.name] = declaration.source;
      }
    } else if (Array.isArray(value)) value.forEach(part => read(part, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach(part => read(part, depth + 1));
  };
  if (item.type === 'userMessage') {
    for (const part of item.content || []) if (part.type === 'text') read(part.text);
  } else if (item.type === 'commandExecution') read(item.aggregatedOutput);
  else { read(item.result); read(item.contentItems); }
  return definitions;
}

export function createMathContextIndex() {
  const extracted = new WeakMap<Item, MathDefinitions>();
  return (items: readonly Item[]) => {
    let definitions: MathDefinitions = {};
    const contexts = new Map<string, MathDefinitions>();
    for (const item of items) {
      contexts.set(item.id, definitions);
      if (!['userMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) || item.status === 'inProgress' || item.status === 'failed' || item.success === false || typeof item.exitCode === 'number' && item.exitCode !== 0) continue;
      let found = extracted.get(item);
      if (!found) { found = materialDefinitions(item); extracted.set(item, found); }
      const changed = Object.entries(found).filter(([name, source]) => definitions[name] !== source);
      if (changed.length) {
        const next = { ...definitions };
        for (const [name, source] of changed) if (Object.hasOwn(next, name) || Object.keys(next).length < 256) next[name] = source;
        definitions = next;
      }
    }
    return contexts;
  };
}
