export type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Obj;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
export type Item = { id: string; type: string; text?: string; content?: Obj[]; summary?: string[]; command?: string; aggregatedOutput?: string; status?: string; viewerState?: string; startedAt?: number; [key: string]: unknown };
export type Settings = { model: string; effort: string | null; mode: 'default' | 'plan' };
export type Model = { model:string; displayName:string; supportedReasoningEfforts:{reasoningEffort:string}[]; defaultReasoningEffort:string };
export type Skill = { name:string; path:string; description:string; enabled:boolean; scope?:string };
export type Turn = { id: string; status: string; items: Item[]; error?: unknown };
export type Thread = { id: string; cwd: string; projectRoot?:string; settings?:Settings; name?: string | null; preview?: string; updatedAt?: number; status?: { type: string; activeFlags?: string[] }; turns?: Turn[] };
export type Notice = { method: string; params: Obj };
export type PendingRequest = { id: string; method: string; params: Obj; windows: boolean; windowsEvidence?:string[] };
export function threadFrom(value: unknown): Thread {
  const t = object(value);
  string(t.id); string(t.cwd);
  if (t.turns !== undefined && !Array.isArray(t.turns)) throw new Error('Invalid thread turns');
  return t as Thread;
}
export function windowsEvidence(value: unknown): string[] {
  const texts:string[]=[];
  const walk=(v:unknown) => { if(!v || typeof v!=='object') return;
    for(const [key,part] of Object.entries(v)) {
      if(['command','cwd','path','read','write','readableRoots','writableRoots'].includes(key)) {
        if(typeof part==='string') texts.push(part);
        if(Array.isArray(part)) texts.push(...part.filter((x):x is string=>typeof x==='string'));
      }
      if(typeof part==='object') walk(part);
    }
  }; walk(value);
  // Inspect raw values: JSON escaping turns Python `as z:` + newline into a fake Z: drive.
  const pattern=/(?:\/mnt\/[a-z](?:\/[^\s'"<>]*)?|(?<![\w])[a-z]:[\\/][^\s'"<>]+|\b[\w.-]+\.exe\b|\b(?:powershell|pwsh)\b)/gi;
  return [...new Set(texts.flatMap(t=>t.match(pattern)||[]))].slice(0,6);
}
export const windowsRisk=(value:unknown)=>windowsEvidence(value).length>0;
// One reducer is shared by live state and reconnect snapshots.
export function reduceNotice(thread: Thread, n: Notice): void {
  const p = n.params;
  if (p.threadId !== thread.id) return;
  if (n.method === 'thread/status/changed') thread.status = object(p.status) as Thread['status'];
  if(n.method==='thread/settings/updated') {
    const s=object(p.threadSettings); const mode=object(s.collaborationMode || {}).mode;
    thread.settings={model:string(s.model),effort:typeof s.effort==='string'?s.effort:null,mode:mode==='plan'?'plan':'default'};
  }
  if (n.method === 'thread/name/updated' && typeof p.threadName === 'string') thread.name = p.threadName;
  if (n.method === 'turn/started' || n.method === 'turn/completed') {
    const incoming = object(p.turn) as Turn;
    thread.turns ??= [];
    const previous = thread.turns.find(t => t.id === incoming.id);
    if (previous && previous.status !== 'inProgress' && n.method === 'turn/started') return;
    if (previous) Object.assign(previous, incoming, { items: incoming.items?.length ? incoming.items.map(i=>({...previous.items.find(p=>p.id===i.id),...i})) : previous.items });
    else thread.turns.push({ ...incoming, items: incoming.items || [] });
    thread.status = { type: n.method === 'turn/started' ? 'active' : 'idle' };
    thread.updatedAt = Date.now() / 1000;
  }
  if (!n.method.startsWith('item/')) return;
  const turn = thread.turns?.find(t => t.id === p.turnId);
  if (!turn) return;
  if (n.method === 'item/started' || n.method === 'item/completed') {
    const item = { ...object(p.item), viewerState:n.method==='item/started'?'running':'completed' } as Item;
    if(n.method==='item/started') item.startedAt=Date.now();
    const index = turn.items.findIndex(i => i.id === item.id);
    if (index < 0) turn.items.push(item);
    else turn.items[index] = { ...turn.items[index], ...item };
  } else if (typeof p.delta === 'string') {
    let item = turn.items.find(i => i.id === p.itemId);
    if (!item && ['item/agentMessage/delta','item/plan/delta'].includes(n.method)) {
      item = { id: string(p.itemId), type: n.method==='item/plan/delta'?'plan':'agentMessage', text: '' };
      turn.items.push(item);
    }
    if (!item) return;
    if (['item/agentMessage/delta','item/plan/delta'].includes(n.method)) item.text = (item.text || '') + p.delta;
    if(n.method==='item/reasoning/summaryTextDelta') { const index=Number(p.summaryIndex)||0; if(index>=0 && index<1000) {item.summary??=[];item.summary[index]=(item.summary[index]||'')+p.delta;} }
    if (n.method === 'item/commandExecution/outputDelta') {
      // ponytail: bound display output; full command logs remain in Codex history.
      item.aggregatedOutput = ((item.aggregatedOutput || '') + p.delta).slice(-100_000);
    }
  }
}
