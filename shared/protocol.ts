export type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Obj;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
export type AsyncQuestion = { title: string; options?: string[] | null };
export type FileUpdateChange = { path: string; kind: { type: 'add' | 'delete' } | { type: 'update'; move_path?: string | null }; diff: string };
export type Item = { id: string; type: string; text?: string; content?: Obj[]; summary?: string[]; delivery?: 'async' | null; questions?: AsyncQuestion[] | null; command?: string; aggregatedOutput?: string; changes?: FileUpdateChange[]; status?: string; viewerState?: string; startedAt?: number; [key: string]: unknown };
export type Settings = { model: string; effort: string | null; mode: 'default' | 'plan' };
export type ModelEvidence = { turnId: string; source: 'viewer/turnModel' | 'model/rerouted' | 'viewer/modelResponse'; model: string | null; effort?: string | null; fromModel?: string; reason?: string; recordedAt: string; requestedModel?: string; responseId?: string; event?: string; status?: string | null; transport?: string };
export const goalLabels = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算耗尽', complete: '已完成' };
export type ThreadGoal = { threadId: string; objective: string; status: keyof typeof goalLabels; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number };
export type GoalUpdate = { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null };
export function goalFrom(value: unknown, threadId: string): ThreadGoal | null {
  if (value === null) return null;
  const g = object(value);
  if (g.threadId !== threadId || typeof g.objective !== 'string' || !Object.hasOwn(goalLabels, String(g.status)) ||
      !(g.tokenBudget === null || Number.isSafeInteger(g.tokenBudget) && Number(g.tokenBudget) > 0) ||
      ['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].some(k => typeof g[k] !== 'number' || !Number.isFinite(g[k]) || Number(g[k]) < 0)) throw new Error('无效 Goal 数据');
  return g as ThreadGoal;
}
export type Model = { model:string; displayName:string; supportedReasoningEfforts:{reasoningEffort:string}[]; defaultReasoningEffort:string; isDefault?:boolean; supportsExperimentalContext?:boolean | null };
export type NewThreadOptions = { models: Model[]; defaultModel: string; contextReason: string };
export type Skill = { name:string; path:string; description:string; enabled:boolean; scope?:string };
export type Turn = { id: string; status: string; items: Item[]; error?: unknown };
export type TokenUsage = { last: { totalTokens: number }; modelContextWindow?: number | null };
export type RateWindow = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };
export type Usage = { weekly: RateWindow | null; resetCount: number | null };
export type UsageResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export function usageFrom(result: Obj): Usage {
  const buckets = result.rateLimitsByLimitId as Record<string, Obj> | null | undefined;
  const bucket = buckets?.codex || result.rateLimits as Obj | undefined;
  const weekly = !bucket?.limitId || bucket.limitId === 'codex'
    ? [bucket?.primary, bucket?.secondary].find(w => w && (w as RateWindow).windowDurationMins === 10080 && Number.isFinite((w as RateWindow).usedPercent)) as RateWindow | undefined : undefined;
  const count = (result.rateLimitResetCredits as Obj | null)?.availableCount;
  return { weekly: weekly || null, resetCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null };
}
export type Thread = { modelEvidence?: ModelEvidence[]; id: string; cwd: string; parentThreadId?: string | null; source?: string | Obj; agentNickname?: string | null; agentRole?: string | null; projectRoot?:string; settings?:Settings; contextManagement?:boolean; approvalsReviewer?:'user'|'auto_review'; name?: string | null; preview?: string; updatedAt?: number; status?: { type: string; activeFlags?: string[] }; turns?: Turn[]; tokenUsage?: TokenUsage; goal?: ThreadGoal | null; goalError?: string };
export type Notice = { method: string; params: Obj };
export type PendingRequest = { id: string; method: string; params: Obj; windows: boolean; windowsEvidence?:string[] };
export function shortTitle(text: string): string {
  const line = text.trim().split(/\r?\n/).find(line => line.trim()) || '';
  const chars = Array.from(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+/g, ' ').trim());
  return chars.length > 60 ? chars.slice(0,59).join('') + '…' : chars.join('');
}
export const threadTitle = (t: Pick<Thread, 'name' | 'preview' | 'goal'>) => t.name || shortTitle(t.preview || t.goal?.objective || '') || '新任务';
// Metadata refreshes must not replace live turns, status, or effective settings.
export function mergeThreadMetadata(target: Thread, source: Thread): void {
  if (source.name !== undefined) target.name = source.name;
  if (source.preview || !target.preview) target.preview = source.preview;
  if (source.projectRoot !== undefined) target.projectRoot = source.projectRoot;
  for (const key of ['parentThreadId', 'source', 'agentNickname', 'agentRole'] as const) if (source[key] !== undefined) Object.assign(target, { [key]: source[key] });
  target.updatedAt = Math.max(target.updatedAt || 0, source.updatedAt || 0);
}
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
export function messageReceived(message: { id: unknown; forwardedAs?: readonly string[] }, received: ReadonlySet<unknown>): boolean {
  return received.has(message.id) || !!message.forwardedAs?.some(id => received.has(id));
}
function mergeItems(previous:Item[],incoming:Item[]):Item[] {
  const items=previous.slice();
  for(const item of incoming) {
    const index=items.findIndex(i=>i.id===item.id);
    if(index>=0)items[index]={...items[index],...item};
    // The first user item is the turn's input, even if its notification arrives late.
    else if(item.type==='userMessage' && !items.some(i=>i.type==='userMessage'))items.unshift(item);
    else items.push(item);
  }
  return items;
}
// One reducer is shared by live state and reconnect snapshots.
export function reduceNotice(thread: Thread, n: Notice): void {
  const p = n.params;
  if (p.threadId !== thread.id) return;
  if (n.method === 'viewer/modelResponse') {
    if (typeof p.turnId !== 'string' || typeof p.responseId !== 'string' || typeof p.requestedModel !== 'string' || typeof p.event !== 'string') return;
    const evidence: ModelEvidence = { source: n.method, turnId: p.turnId, responseId: p.responseId, requestedModel: p.requestedModel, event: p.event, effort: typeof p.effort === 'string' ? p.effort : null, model: typeof p.model === 'string' ? p.model : null, status: typeof p.status === 'string' ? p.status : null, transport: 'WebSocket', recordedAt: typeof p.recordedAt === 'string' ? p.recordedAt : new Date().toISOString() };
    thread.modelEvidence = [...(thread.modelEvidence || []).filter(e => !(e.source === n.method && e.responseId === evidence.responseId && e.event === evidence.event)), evidence].slice(-100);
    return;
  }
  if (n.method === 'viewer/turnModel' || n.method === 'model/rerouted') {
    if (typeof p.turnId !== 'string') return;
    if (n.method === 'model/rerouted' && (typeof p.fromModel !== 'string' || typeof p.toModel !== 'string')) return;
    const evidence: ModelEvidence = n.method === 'model/rerouted'
      ? { turnId: p.turnId, source: n.method, model: p.toModel as string, fromModel: p.fromModel as string, reason: typeof p.reason === 'string' ? p.reason : undefined, recordedAt: typeof p.recordedAt === 'string' ? p.recordedAt : new Date().toISOString() }
      : { turnId: p.turnId, source: n.method, model: typeof p.model === 'string' ? p.model : null, effort: typeof p.effort === 'string' ? p.effort : null, recordedAt: typeof p.recordedAt === 'string' ? p.recordedAt : new Date().toISOString() };
    // ponytail: retain 100 metadata events per loaded thread; export for a durable audit.
    thread.modelEvidence = [...(thread.modelEvidence || []), evidence].slice(-100);
    return;
  }
  if (n.method === 'thread/goal/updated' || n.method === 'thread/goal/cleared') {
    thread.goal = n.method === 'thread/goal/cleared' ? null : goalFrom(p.goal, thread.id);
    delete thread.goalError;
  }
  if (n.method === 'thread/tokenUsage/updated') thread.tokenUsage = object(p.tokenUsage) as TokenUsage;
  if (n.method === 'thread/status/changed') thread.status = object(p.status) as Thread['status'];
  if(n.method==='thread/settings/updated') {
    const s=object(p.threadSettings); const mode=object(s.collaborationMode || {}).mode;
    thread.settings={model:string(s.model),effort:typeof s.effort==='string'?s.effort:null,mode:mode==='plan'?'plan':'default'};
    if(s.approvalsReviewer==='user' || s.approvalsReviewer==='auto_review')thread.approvalsReviewer=s.approvalsReviewer;
  }
  if (n.method === 'thread/name/updated' && (typeof p.threadName === 'string' || p.threadName === null)) thread.name = p.threadName;
  if (n.method === 'viewer/threadPreview' && typeof p.preview === 'string' && !thread.preview) thread.preview = p.preview;
  if (n.method === 'turn/started' || n.method === 'turn/completed') {
    const incoming = object(p.turn) as Turn;
    thread.turns ??= [];
    const previous = thread.turns.find(t => t.id === incoming.id);
    if (previous && previous.status !== 'inProgress' && n.method === 'turn/started') {
      previous.items=mergeItems(previous.items,incoming.items||[]);return;
    }
    if (previous) Object.assign(previous, incoming, { items:mergeItems(previous.items,incoming.items||[]) });
    else thread.turns.push({ ...incoming, items: incoming.items || [] });
    thread.status = { type: n.method === 'turn/started' ? 'active' : 'idle' };
    thread.updatedAt = Date.now() / 1000;
  }
  if (!n.method.startsWith('item/')) return;
  let turn = thread.turns?.find(t => t.id === p.turnId);
  if (!turn) {
    if(typeof p.turnId!=='string')return;
    // Item notifications can precede turn/started or its RPC response.
    turn={id:p.turnId,status:'inProgress',items:[]};(thread.turns??=[]).push(turn);
  }
  if (n.method === 'item/started' || n.method === 'item/completed') {
    const item = { ...object(p.item), viewerState:n.method==='item/started'?'running':'completed' } as Item;
    if(n.method==='item/started') item.startedAt=Date.now();
    turn.items=mergeItems(turn.items,[item]);
  } else if (typeof p.delta === 'string') {
    let item = turn.items.find(i => i.id === p.itemId);
    if (!item && ['item/agentMessage/delta','item/plan/delta'].includes(n.method)) {
      item = { id: string(p.itemId), type: n.method==='item/plan/delta'?'plan':'agentMessage', text: '' };
      turn.items.push(item);
    }
    if (!item) return;
    // Stable identities let displays reuse unchanged history without serializing it.
    item = { ...item, ...(item.summary ? { summary: item.summary.slice() } : {}) };
    turn.items[turn.items.findIndex(i => i.id === item!.id)] = item;
    if (['item/agentMessage/delta','item/plan/delta'].includes(n.method)) item.text = (item.text || '') + p.delta;
    if(n.method==='item/reasoning/summaryTextDelta') { const index=Number(p.summaryIndex)||0; if(index>=0 && index<1000) {item.summary??=[];item.summary[index]=(item.summary[index]||'')+p.delta;} }
    if (n.method === 'item/commandExecution/outputDelta') {
      // ponytail: bound display output; full command logs remain in Codex history.
      item.aggregatedOutput = ((item.aggregatedOutput || '') + p.delta).slice(-100_000);
    }
  }
}
