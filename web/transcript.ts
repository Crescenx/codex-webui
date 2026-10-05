import { reactive } from 'vue';
import type { InjectionKey } from 'vue';
import type { VirtualItem } from '@tanstack/vue-virtual';
import type { Item, Turn } from '../shared/protocol.ts';
import { itemResource } from '../shared/mcp-apps.ts';
import { activity, activityState } from './activity.ts';
import { renderMarkdown } from './render.ts';
import type { Rendered } from './render.ts';

export type ItemView = { open: boolean; files: string[]; traceActive?: boolean };
export type ReasoningGroup = { firstKey: string; lastKey: string; state: string };
export type TraceGroup = { key: string; firstKey: string; count: number; active: boolean };
export type TranscriptRow = { key: string; original: Item; turn: Turn; reasoning?: ReasoningGroup; trace?: TraceGroup; traceHeader?: boolean; traceOpen?: boolean };
const reasoningStates = ['running', 'failed', 'cancelled', 'unknown', 'completed'];
export function groupReasoning(rows: TranscriptRow[]): TranscriptRow[] {
  // Group only the display metadata; native rows retain their keys and search/scroll anchors.
  let previous: TranscriptRow | undefined;
  for (const row of rows) {
    if (row.original.type === 'reasoning') {
      const state = activityState(row.original, row.turn);
      const group = previous?.turn.id === row.turn.id ? previous.reasoning : undefined;
      row.reasoning = group || { firstKey: row.key, lastKey: row.key, state };
      row.reasoning.lastKey = row.key;
      if (reasoningStates.indexOf(state) < reasoningStates.indexOf(row.reasoning.state)) row.reasoning.state = state;
    }
    previous = row;
  }
  return rows;
}
export function groupTraces(rows: TranscriptRow[]): TranscriptRow[] {
  let previous: TranscriptRow | undefined;
  const pending: TraceGroup[] = [];
  for (const row of rows) {
    if (previous?.turn.id !== row.turn.id) { previous = undefined; pending.length = 0; }
    const item = row.original;
    if (['agentMessage', 'userMessage', 'plan'].includes(item.type) || item.type === 'mcpToolCall' && itemResource(item)) {
      if (['agentMessage', 'plan'].includes(item.type) && (item.text?.trim() || item.questions?.length)) {
        for (const group of pending) group.active = false;
        pending.length = 0;
      }
    } else {
      const group = previous?.trace || { key: `trace:${row.key}`, firstKey: row.key, count: 0, active: row.turn.status === 'inProgress' };
      if (!previous?.trace) pending.push(group);
      row.trace = group; group.count++;
    }
    previous = row;
  }
  return rows;
}
export function traceRows(rows: TranscriptRow[], reading: Reading, heldTrace = '', openApps?: ReadonlySet<string>): TranscriptRow[] {
  return rows.flatMap(row => {
    const group = row.trace;
    if (!group) return [row];
    const view = itemView(reading, group.key);
    if (view.traceActive !== group.active) { view.traceActive = group.active; view.open = group.active; }
    const open = view.open || heldTrace === group.key;
    const header = group.firstKey === row.key ? [{ ...row, key: group.key, traceHeader: true, traceOpen: open }] : [];
    return open || openApps?.has(row.key) ? [...header, row] : header;
  });
}
export type Reading = { follow: boolean; anchor: string; inset: number; offset: number; width: number; measurements: VirtualItem[]; items: Map<string, ItemView> };
export function createTranscriptMemory() {
  const views = new Map<string, Reading>();
  const rendered = new Map<string, { source: string; result: Rendered; bytes: number }>();
  let bytes = 0;
  return {
    reading(id: string): Reading {
      const value = views.get(id) || { follow: true, anchor: '', inset: 0, offset: 0, width: 0, measurements: [], items: new Map() };
      views.delete(id); views.set(id, value);
      while (views.size > 8) views.delete(views.keys().next().value!);
      return value;
    },
    render(key: string, source: string, threadId: string | undefined, blocks: Map<string, string>, complete: boolean) {
      const previous = rendered.get(key);
      if (previous?.source === source && complete) { rendered.delete(key); rendered.set(key, previous); return previous.result; }
      if (previous) { bytes -= previous.bytes; rendered.delete(key); }
      const result = renderMarkdown(source, threadId, blocks);
      if (complete) {
        const size = 2 * (key.length + source.length + result.html.length + [...result.atoms.values()].reduce((n, s) => n + s.length, 0) + result.diagrams.reduce((n, d) => n + d.source.length, 0));
        if (size <= 16 * 1024 * 1024) { rendered.set(key, { source, result, bytes: size }); bytes += size; }
        while (rendered.size > 200 || bytes > 16 * 1024 * 1024) { const first = rendered.keys().next().value!; bytes -= rendered.get(first)!.bytes; rendered.delete(first); }
      }
      return result;
    },
    clear() { views.clear(); rendered.clear(); bytes = 0; },
  };
}
export const transcriptMemoryKey: InjectionKey<ReturnType<typeof createTranscriptMemory>> = Symbol('transcriptMemory');
export function itemView(reading: Reading, key: string): ItemView {
  let value = reading.items.get(key);
  if (!value) { value = reactive({ open: false, files: [] as string[] }); reading.items.set(key, value); }
  return value;
}
export function messageSource(item: Item): string {
  return item.type === 'userMessage' ? (item.content || []).map(p => p.type === 'text' ? String(p.text || '') : p.type === 'skill' ? '$' + String(p.name) : '[图片附件]').join('\n') : item.text || '';
}
export function searchableText(item: Item, turn: Turn): string {
  if (item.type === 'fileChange') return (item.changes || []).map(f => [f.path, f.kind.type === 'update' ? f.kind.move_path : '', f.diff].filter(Boolean).join('\n')).join('\n');
  if (['agentMessage', 'userMessage', 'plan'].includes(item.type)) return [messageSource(item), ...(item.questions || []).map(q => q.title)].filter(Boolean).join('\n');
  const info = activity(item, turn); return [info.title, info.detail].filter(Boolean).join('\n');
}
