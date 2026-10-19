import type { Thread, Item } from './protocol.ts';

export function agentParent(t: Thread): string | undefined {
  const source = typeof t.source === 'object' ? t.source.subAgent as { thread_spawn?: { parent_thread_id?: string } } | undefined : undefined;
  return t.parentThreadId || source?.thread_spawn?.parent_thread_id;
}

export type AgentNode = { id: string; parentId: string; depth: number; name: string; task: string; summary: string; state: string; label: string };
const labels: Record<string, string> = { pendingInit: '准备中', running: '执行中', waiting: '等待输入', completed: '已完成', interrupted: '已中断', errored: '失败', shutdown: '已关闭', notFound: '不可用', idle: '空闲', unknown: '状态未知' };
export function agentTree(root: Thread, threads: Thread[], waiting: Set<string> = new Set()): AgentNode[] {
  const records = new Map(threads.map(t => [t.id, t])); records.set(root.id, root);
  const parents = new Map<string, string>(), tasks = new Map<string, string>(), states = new Map<string, { status: string; message?: string | null }>();
  for (const t of records.values()) { const parent = agentParent(t); if (parent) parents.set(t.id, parent); }
  for (const t of records.values()) for (const turn of t.turns || []) for (const item of turn.items) {
    if (item.type !== 'collabAgentToolCall') continue;
    for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
      if (typeof id !== 'string') continue;
      if (item.tool === 'spawnAgent') { if (!parents.has(id)) parents.set(id, t.id); if (typeof item.prompt === 'string') tasks.set(id, item.prompt); }
    }
    if (item.agentsStates && typeof item.agentsStates === 'object') for (const [id, state] of Object.entries(item.agentsStates)) {
      if (state && typeof state.status === 'string') states.set(id, state);
    }
  }
  const result: AgentNode[] = [], visited = new Set([root.id]);
  function append(parentId: string, depth: number) {
    for (const [id, parent] of parents) {
      if (parent !== parentId || visited.has(id)) continue;
      visited.add(id);
      const t = records.get(id), reported = states.get(id), turn = t?.turns?.at(-1);
      let state = reported?.status || 'unknown';
      if (waiting.has(id) || t?.status?.activeFlags?.some(f => /waiting/.test(f))) state = 'waiting';
      else if (t?.status?.type === 'active') state = 'running';
      else if (t?.status?.type === 'systemError') state = 'errored';
      else if (!['shutdown', 'notFound'].includes(state)) {
        if (turn?.status === 'failed') state = 'errored';
        else if (turn?.status === 'interrupted') state = 'interrupted';
        else if (turn?.status === 'completed') state = 'completed';
        else if (t?.status?.type === 'idle' && (!reported || state === 'running' || state === 'pendingInit')) state = 'idle';
        else if (t?.status?.type === 'notLoaded' && state === 'running') state = 'unknown';
      }
      if (t?.agentState && state !== 'waiting') state = t.agentState;
      const answer = t?.turns?.flatMap(v => v.items).findLast(i => i.type === 'agentMessage' && i.text)?.text;
      result.push({ id, parentId, depth, name: t?.agentNickname || t?.name || t?.agentRole || id, task: t?.hybrid?.agent?.task || tasks.get(id) || t?.preview || '', summary: answer || reported?.message || '', state, label: labels[state] || labels.unknown! });
      append(id, depth + 1);
    }
  }
  append(root.id, 0); return result;
}

// Rollout reads can lag live deltas. Merge history without shortening live text or losing items.
export function mergeAgentHistory(fresh: Thread, live: Thread, changed: boolean): Thread {
  const turns = new Map((fresh.turns || []).map(t => [t.id, t]));
  for (const turn of live.turns || []) {
    const stored = turns.get(turn.id);
    if (!stored) { turns.set(turn.id, turn); continue; }
    const items = new Map<string, Item>(stored.items.map(i => [i.id, i]));
    for (const item of turn.items) {
      const saved = items.get(item.id), merged = { ...saved, ...item };
      for (const key of ['text', 'aggregatedOutput'] as const) if (saved?.[key] && (!item[key] || saved[key]!.startsWith(item[key]!))) merged[key] = saved[key];
      if (!changed && saved?.status === 'completed') merged.status = saved.status;
      items.set(item.id, merged);
    }
    turns.set(turn.id, { ...stored, ...turn, status: changed || turn.status !== 'inProgress' ? turn.status : stored.status, items: [...items.values()] });
  }
  return { ...live, ...fresh, ...(changed ? { status: live.status } : {}), turns: [...turns.values()] };
}
