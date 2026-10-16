import { viewerDocument, viewerWindow, viewerRoot } from './environment.ts';
import { computed, inject, reactive, readonly } from 'vue';
import type { DeepReadonly, InjectionKey } from 'vue';
import { messageReceived, mergeThreadMetadata, reduceNotice, threadTitle, usageFrom, goalLabels } from '../shared/protocol.ts';
import type { GoalUpdate, Item, NewThreadOptions, PendingRequest, Settings, Skill, Thread, Turn, Usage, UsageResetOutcome } from '../shared/protocol.ts';
import { createClient } from './api.ts';
import type { Attachment, Catalog, Directories, Preview, Snapshot, Update } from './api.ts';
import type { Watchdog, WatchdogConfig, WatchdogRun } from '../shared/watchdogs.ts';
import { agentTree, mergeAgentHistory } from '../shared/agents.ts';
import { appContextLimit, appPath } from '../shared/mcp-apps.ts';
import type { AppContext, AppContextInput, AppDescription, AppTarget, AppView } from '../shared/mcp-apps.ts';
import type { Obj } from '../shared/protocol.ts';
import type { ConversationReference, ReferenceData, ReferencePosition } from '../shared/references.ts';

const emptyCatalog = (): Catalog => ({ models: [], modes: [], skills: [], errors: {}, skillErrors: [] });
type QueuedMessage = { id: string; turnId: string; text: string; attachments: Attachment[]; skills: Skill[]; references?: ConversationReference[]; forwardedAs?: string[] };
type Draft = { text: string; attachments: Attachment[]; skills: Skill[]; references: ConversationReference[]; referenceSubmission?: {id:string;signature:string}; queued: QueuedMessage[]; answers: Record<string, string[]>; desired?: Settings; dirty: boolean; catalog: Catalog; loading: boolean; sending: boolean; stopping: boolean; uploading: boolean; goalSaving: boolean; uncertain: boolean; error: string; readError: string };
type ReloadDraft = Pick<Draft, 'text' | 'attachments' | 'skills' | 'references' | 'referenceSubmission' | 'queued' | 'answers' | 'desired' | 'dirty' | 'uncertain'>;
const reloadKey = 'viewer-restart-drafts-v1';
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const questionPrefix = (item: DeepReadonly<Pick<Item, 'questions'>>) => '回答 Codex 提问：\n' + (item.questions || []).map((q, i) => `${i + 1}. ${q.title}`).join('\n') + '\n\n';

export function createViewerStore(client = createClient(), storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = viewerWindow().localStorage, options: { reloadOnRestart?: boolean } = {}) {
  const read = <T>(key: string, fallback: T): T => { try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const save = (key: string, value: unknown) => { try { if (value === undefined) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); } catch {} };
  const state = reactive({
    entities: {} as Record<string, Thread>, ids: [] as string[], currentId: '', hydrating: false, cursor: null as string | null,
    revisions: {} as Record<string, number>,
    drafts: {} as Record<string, Draft>, requests: {} as Record<string, PendingRequest>, replying: {} as Record<string, boolean>,
    read: read<Record<string, number>>('viewer-read', {}), collapsed: read<Record<string, boolean>>('viewer-projects', {}),
    connection: '连接中', restarting: false, restartPending: false, authExpired: false, error: '', toast: '',
    listLoading: false, moreLoading: false, listError: '',
    usage: { weekly: null, resetCount: null } as Usage, usageError: '', usageResetPending: false, usageResetKey: read<string>('viewer-usage-reset-key', ''),
    watchdogs: [] as Watchdog[], watchdogError: '', watchdogTimeZone: '', targetTurn: '', targetItem: '',
    selectedAgentId: '', agentsVisible: false, agentsLoading: false, agentLoading: false, agentsError: '', agentError: '',
  });
  let alive = true, started = false, connectionGeneration = 0, selectionGeneration = 0;
  let targetId = '', epoch = '', lastSeq = -1;
  let restartEpoch = '', restartTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined, usageRevision = 0;
  let agentTimer: ReturnType<typeof setInterval> | undefined;
  const reads = new Map<string, AbortController>();
  const snapshots = new Map<string, number>();
  const syncing = new Map<string, Update[]>();
  const notified = new Set<string>();
  const appContexts = new Map<string, Map<string, AppContextInput>>();
  let listLoaded = false;
  const refreshes = new Map<string, { running: boolean; dirty: boolean; promise: Promise<void> }>();
  function refresh(scope: string, read: () => Promise<void>, changed = false): Promise<void> {
    const pending = refreshes.get(scope);
    if (pending) {
      if (changed && pending.running) pending.dirty = true;
      return pending.promise;
    }
    const job = { running: false, dirty: false, promise: Promise.resolve() };
    refreshes.set(scope, job);
    job.promise = (async () => {
      try {
        // Batch event invalidations; explicit reads start immediately and join an existing read.
        if (changed) await Promise.resolve();
        do {
          if (!alive || refreshes.get(scope) !== job) return;
          job.dirty = false;
          job.running = true;
          await read();
          job.running = false;
        } while (job.dirty);
      } finally { if (refreshes.get(scope) === job) refreshes.delete(scope); }
    })();
    return job.promise;
  }

  function draftFor(id: string): Draft {
    if (!state.drafts[id]) {
      const desired = read<Settings | undefined>('viewer-settings:' + id, undefined);
      let text = ''; try { text = storage.getItem('viewer-draft:' + id) || ''; } catch {}
      state.drafts[id] = { text, attachments: [], skills: [], references: read<ConversationReference[]>('viewer-references:' + id, []), referenceSubmission: read('viewer-reference-submission:' + id, undefined), queued: read<QueuedMessage[]>('viewer-queued:' + id, []), answers: read<Record<string, string[]>>('viewer-answers:' + id, {}), desired, dirty: !!desired, catalog: emptyCatalog(), loading: false, sending: false, stopping: false, uploading: false, goalSaving: false, uncertain: false, error: '', readError: '' };
    }
    return state.drafts[id];
  }
  let pageRestored = false;
  try {
    const saved = viewerWindow().sessionStorage.getItem(reloadKey);
    if (saved) {
      const drafts = JSON.parse(saved) as Record<string, ReloadDraft>;
      for (const [id, draft] of Object.entries(drafts)) Object.assign(draftFor(id), draft);
      viewerWindow().sessionStorage.removeItem(reloadKey);
      pageRestored = true;
    }
  } catch { /* Browser storage can be unavailable; keep the existing drafts. */ }
  const current = computed(() => state.entities[state.currentId]);
  const draft = computed(() => state.drafts[state.currentId]);
  const threads = computed(() => state.ids.map(id => state.entities[id]).filter((t): t is Thread => !!t));
  const approvals = computed(() => Object.values(state.requests).filter(r => r.params.threadId === state.currentId));
  const agents = computed(() => {
    const nodes = current.value ? agentTree(current.value, Object.values(state.entities), new Set(Object.values(state.requests).map(r => String(r.params.threadId)))) : [];
    return state.connection === '已连接' ? nodes : nodes.map(a => ({ ...a, state: 'unknown', label: '连接中断 · 待同步' }));
  });
  const selectedAgent = computed(() => state.entities[state.selectedAgentId]);
  const active = computed(() => current.value?.status?.type === 'active' || !!draft.value?.uncertain);
  const activeTurn = computed(() => current.value?.turns?.findLast(t => t.status === 'inProgress'));
  const contextBlocked = computed(() => {
    const settings = draft.value?.desired || current.value?.settings;
    const model = draft.value?.catalog.models.find(m => m.model === settings?.model);
    return !!current.value?.contextManagement && model?.supportsExperimentalContext !== true;
  });
  const canSend = computed(() => {
    const d = draft.value;
    if (!current.value || !d || state.authExpired || state.restarting || state.restartPending || state.hydrating || d.readError || d.sending || d.stopping || d.uploading || d.goalSaving || d.uncertain) return false;
    if (active.value) return !!activeTurn.value;
    const settingsUnavailable = d.dirty && (d.loading || !d.catalog.models.length || !d.catalog.modes.length);
    return !contextBlocked.value && !settingsUnavailable;
  });
  const archived=new Set<string>();
  function removeThread(id:string){archived.add(id);reads.get('open:'+id)?.abort();state.ids=state.ids.filter(v=>v!==id);delete state.entities[id];if(state.currentId===id){++selectionGeneration;targetId='';state.currentId='';state.hydrating=false;}}
  async function archiveThread(id:string){await client.request(`/threads/${encodeURIComponent(id)}/archive`,{});if(!alive)return;removeThread(id);toast('已删除会话');}
  function report(e: unknown, id?: string) {
    if (!alive || (e instanceof Error && e.name === 'AbortError')) return;
    if (e instanceof Error && 'status' in e && e.status === 401) {
      invalidate(); state.authExpired = true; state.connection = '登录已过期';
      state.error = 'Viewer 登录已过期，请重新打开启动链接'; return;
    }
    if (id) draftFor(id).error = message(e); else state.error = message(e);
  }
  function toast(text: string) { if (!alive) return; state.toast = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { state.toast = ''; }, 2500); }
  function begin(scope: string) {
    reads.get(scope)?.abort();
    const controller = new AbortController(), generation = connectionGeneration;
    reads.set(scope, controller);
    return { signal: controller.signal, valid: () => alive && generation === connectionGeneration && reads.get(scope) === controller && !controller.signal.aborted };
  }
  function markRead(id: string) { state.read[id] = Date.now() / 1000; save('viewer-read', state.read); }
  function notify(text: string, id: string) {
    if (notified.has(id)) return; notified.add(id);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && viewerDocument().hidden) new Notification(text, { icon: new URL('./assets/icon.png', import.meta.url).href });
  }
  function status(t: DeepReadonly<Pick<Thread, 'id' | 'status' | 'turns' | 'updatedAt'>>): [string, string] {
    if (t.status?.activeFlags?.some(f => /waiting/.test(f)) || Object.values(state.requests).some(r => r.params.threadId === t.id)) return ['attention', '等待输入'];
    if (t.status?.type === 'active') return ['running', '进行中'];
    if (t.status?.type === 'systemError' || t.turns?.at(-1)?.status === 'failed') return ['failed', '失败'];
    return (t.updatedAt || 0) > (state.read[t.id] || 0) && t.id !== state.currentId ? ['unread', '未读'] : ['idle', '空闲'];
  }
  async function loadThreads(more = false, changed = false) {
    if (!alive || state.authExpired || (more && !state.cursor)) return;
    return refresh(more ? 'more' : 'list', async () => {
      const job = begin(more ? 'more' : 'list'), previousNames = new Map(Object.values(state.entities).map(t => [t.id, t.name]));
      const revisions = { ...state.revisions };
      const loading = more ? 'moreLoading' : 'listLoading';
      state[loading] = true; state.listError = '';
      try {
        const result = await client.request<{ data: Thread[]; nextCursor: string | null }>('/threads' + (more && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''), undefined, job.signal);
        if (!job.valid()) return;
        for (const t of result.data) {
          if(archived.has(t.id))continue;
          const live = state.entities[t.id];
          if (live) {
            if (live.name !== previousNames.get(t.id)) t.name = live.name;
            mergeThreadMetadata(live, t);
            // Accept list status only if no live event or snapshot arrived during the read.
            if (t.status && state.revisions[t.id] === revisions[t.id]) live.status = t.status;
          }
          else state.entities[t.id] = t;
        }
        state.ids = [...new Set([...state.ids, ...result.data.filter(t=>!archived.has(t.id)).map(t => t.id), ...(state.currentId ? [state.currentId] : [])])];
        if (more && result.nextCursor && result.nextCursor === state.cursor) throw new Error('历史分页未前进，请刷新后重试');
        if (more || !listLoaded) state.cursor = result.nextCursor;
        listLoaded = true;
      } catch (e) { if (job.valid()) state.listError = message(e); }
      finally { if (job.valid()) state[loading] = false; }
    }, changed);
  }
  async function loadUsage(changed = false) {
    if (!alive) return;
    return refresh('usage', async () => {
      const job = begin('usage'), revision = usageRevision;
      try {
        const usage = await client.request<Usage>('/usage', undefined, job.signal);
        if (job.valid()) { state.usage = { ...usage, weekly: revision === usageRevision ? usage.weekly : state.usage.weekly }; state.usageError = ''; }
      } catch (e) { if (job.valid()) { state.usage = { weekly: null, resetCount: null }; state.usageError = '额度暂不可用：' + message(e); } }
    }, changed);
  }
  async function resetUsage() {
    if (!alive || state.usageResetPending || state.restarting || state.restartPending || state.connection !== '已连接') return;
    state.usageResetPending = true;
    state.usageResetKey ||= read<string>('viewer-usage-reset-key', '') || crypto.randomUUID();
    try {
      // Persist before spending a credit; uncertain requests retain the same native idempotency key.
      try { storage.setItem('viewer-usage-reset-key', JSON.stringify(state.usageResetKey)); }
      catch { throw new Error('无法保存重置请求，请允许浏览器存储后重试；尚未使用重置卡'); }
      const result = await client.request<{ outcome: UsageResetOutcome }>('/usage/reset', { confirm: true, idempotencyKey: state.usageResetKey });
      state.usageResetKey = ''; save('viewer-usage-reset-key', undefined);
      return result.outcome;
    } finally {
      if (alive) await loadUsage(true);
      state.usageResetPending = false;
    }
  }
  async function loadSubagents(changed = false) {
    const rootId = state.currentId;
    if (!alive || !rootId || state.restarting) return;
    return refresh('agents:' + rootId, async () => {
      const job = begin('agents'), revisions = { ...state.revisions };
      state.agentsLoading = true;
      try {
        const result = await client.request<{ data: Thread[] }>(`/threads/${encodeURIComponent(rootId)}/subagents`, undefined, job.signal);
        if (!job.valid() || state.currentId !== rootId) return;
        for (const t of result.data) {
          const live = state.entities[t.id];
          if (!live) state.entities[t.id] = t;
          else { mergeThreadMetadata(live, t); if (revisions[t.id] === state.revisions[t.id]) live.status = t.status; }
        }
        state.agentsError = '';
      } catch (e) { if (job.valid() && state.currentId === rootId) state.agentsError = message(e); }
      finally { if (job.valid() && state.currentId === rootId) state.agentsLoading = false; }
    }, changed);
  }
  async function loadAgent(id = state.selectedAgentId) {
    if (!alive || !id || state.restarting) return;
    return refresh('agent:' + id, async () => {
      const job = begin('agent'), rootId = state.currentId, revision = state.revisions[id];
      state.agentLoading = true;
      try {
        const result = await client.request<Snapshot>(`/threads/${encodeURIComponent(id)}?refresh=1`, undefined, job.signal);
        if (!job.valid() || state.currentId !== rootId || state.selectedAgentId !== id) return;
        const live = state.entities[id];
        state.entities[id] = live ? mergeAgentHistory(result.thread, live, revision !== state.revisions[id]) : result.thread;
        snapshots.set(id, result.seq);
        state.revisions[id] = (state.revisions[id] || 0) + 1;
        state.agentError = '';
      } catch (e) { if (job.valid() && state.selectedAgentId === id) state.agentError = message(e); }
      finally { if (job.valid()) state.agentLoading = false; }
    });
  }
  function selectAgent(id: string) {
    if (!alive || (id && !agents.value.some(a => a.id === id))) return;
    refreshes.delete('agent:' + state.selectedAgentId);
    reads.get('agent')?.abort(); state.selectedAgentId = id; state.agentError = ''; state.agentLoading = false;
    if (id) void loadAgent(id);
  }
  function setAgentsVisible(visible: boolean) {
    state.agentsVisible = visible;
    if (visible) { void loadSubagents(); void loadAgent(); }
    else { reads.get('agents')?.abort(); reads.get('agent')?.abort(); refreshes.delete('agents:' + state.currentId); refreshes.delete('agent:' + state.selectedAgentId); state.agentsLoading = false; state.agentLoading = false; }
  }
  function refreshAgents() {
    if (!state.agentsVisible || state.restarting || state.connection !== '已连接' || (typeof document !== 'undefined' && viewerDocument().hidden)) return;
    if (current.value?.status?.type === 'active' || selectedAgent.value?.turns?.at(-1)?.status === 'inProgress' || agents.value.some(a => ['running', 'pendingInit', 'waiting'].includes(a.state))) {
      void loadSubagents(); void loadAgent();
    }
  }
  function refreshUsage() { if (typeof document === 'undefined' || !viewerDocument().hidden) void loadUsage(); }
  async function loadWatchdogs(changed = false) {
    if (!alive) return;
    return refresh('watchdogs', async () => {
      const job = begin('watchdogs');
      try {
        const result = await client.request<{ data: Watchdog[]; timeZone: string }>('/watchdogs', undefined, job.signal);
        if (job.valid()) { state.watchdogs = result.data; state.watchdogTimeZone = result.timeZone; state.watchdogError = ''; }
      } catch (e) { if (job.valid()) state.watchdogError = message(e); }
    }, changed);
  }
  async function saveWatchdog(threadId: string, config: WatchdogConfig, id?: string, revision?: number) {
    const path = id ? '/watchdogs/' + encodeURIComponent(id) : '/watchdogs';
    const result = await client.request<{ watchdog: Watchdog }>(path, { threadId, ...config, revision });
    await loadWatchdogs(true);
    return result.watchdog;
  }
  async function controlWatchdog(id: string, revision: number, action: string) {
    await client.request('/watchdogs/' + encodeURIComponent(id), { revision, action });
    await loadWatchdogs(true);
    if (draft.value?.uncertain) await openThread(state.currentId);
  }
  async function jumpToRun(run: Pick<WatchdogRun,'threadId'|'turnId'>) {await selectThread(run.threadId);if(state.currentId===run.threadId)state.targetTurn=run.turnId || '';}
  async function loadControls(id = state.currentId) {
    if (!id || !alive) return;
    const job = begin('controls:' + id), d = draftFor(id); d.loading = true;
    try { const catalog = await client.request<Catalog>('/controls?threadId=' + encodeURIComponent(id), undefined, job.signal); if (job.valid()) d.catalog = catalog; }
    catch (e) { if (job.valid()) d.catalog = { ...emptyCatalog(), errors: { load: message(e) } }; }
    finally { if (job.valid()) d.loading = false; }
  }
  function apply(n: Update, scope?: string) {
    const id = scope || (typeof n.params.threadId === 'string' ? n.params.threadId : undefined);
    if (id && n.seq !== undefined && n.seq <= (snapshots.get(id) ?? -1)) return;
    if (n.method === 'viewer/request') {
      const r = n.params as unknown as PendingRequest; state.requests[r.id] = r;
      notify('Codex 需要你的输入', r.id); return;
    }
    if (n.method === 'viewer/requestResolved') { delete state.requests[String(n.params.id)]; return; }
    if (n.method === 'viewer/nameError') { report(n.params.message, id); return; }
    if (id && state.entities[id]) {
      const previousGoal = state.entities[id].goal;
      reduceNotice(state.entities[id], n);
      const goal = state.entities[id].goal;
      if (n.method === 'thread/goal/updated' && goal && goal.status !== previousGoal?.status && ['complete', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status)) {
        notify('Goal ' + goalLabels[goal.status], `goal:${id}:${goal.createdAt}:${goal.status}:${goal.updatedAt}`);
        if (typeof n.params.turnId === 'string') notified.add(n.params.turnId);
      }
      if (n.method === 'turn/started' || n.method === 'turn/completed' || (n.params.item as { type?: string } | undefined)?.type === 'userMessage') reconcileQueued(id);
      state.revisions[id] = (state.revisions[id] || 0) + 1;
      if (n.method === 'thread/settings/updated' && !n.params.watchdogRunId && !draftFor(id).dirty) draftFor(id).desired = state.entities[id].settings;
    }
    if (n.method === 'turn/completed' && id) {
      for (const [key, r] of Object.entries(state.requests)) if (r.params.threadId === id && (r.method !== 'mcpServer/elicitation/request' || r.params.turnId === (n.params.turn as Turn).id)) delete state.requests[key];
      draftFor(id).uncertain = false; if (state.currentId === id) markRead(id);
      const turn = n.params.turn as { id: string; status: string };
      if (state.entities[id]?.goal?.status !== 'active') notify(turn.status === 'completed' ? 'Codex 本轮已完成' : 'Codex 本轮已结束：' + turn.status, turn.id);
      void loadThreads(false, true);
    }
  }
  async function openThread(id: string, initial?: Snapshot): Promise<boolean> {
    if (!alive || archived.has(id)) return false;
    const job = begin('open:' + id);
    // Preserve already-buffered events when a newer read supersedes an older read.
    const queue = syncing.get(id) || []; syncing.set(id, queue);
    try {
      // Reuse creation's snapshot unless newer events already arrived; ordinary opens still resync.
      const result = initial && initial.seq >= lastSeq ? initial : await client.request<Snapshot>(`/threads/${encodeURIComponent(id)}/open`, {}, job.signal);
      if (!job.valid() || archived.has(id)) return false;
      state.entities[id] = result.thread; if (!state.ids.includes(id)) state.ids.push(id);
      state.revisions[id] = (state.revisions[id] || 0) + 1;
      for (const [key, r] of Object.entries(state.requests)) if (r.params.threadId === id) delete state.requests[key];
      for (const r of result.requests) state.requests[r.id] = r;
      snapshots.set(id, result.seq);
      const d = draftFor(id); d.uncertain = !!result.uncertain; d.readError = '';
      reconcileQueued(id);
      if (!d.dirty) d.desired = result.thread.settings;
      return true;
    } catch (e) { if (job.valid()) draftFor(id).readError = message(e); return false; }
    finally {
      if (job.valid()) { syncing.delete(id); for (const n of queue) apply(n, id); }
    }
  }
  async function selectThread(id: string, initial?: Snapshot) {
    if (!alive) return;
    if (draft.value?.sending || draft.value?.uploading) { toast('请等待当前提交或上传完成'); return; }
    const generation = ++selectionGeneration; targetId = id; state.targetTurn=''; state.targetItem=''; state.hydrating = true; state.error = ''; draftFor(id).error = '';
    if (state.currentId !== id) { reads.get('agent')?.abort(); reads.get('agents')?.abort(); refreshes.delete('agents:' + state.currentId); refreshes.delete('agent:' + state.selectedAgentId); state.selectedAgentId = ''; state.agentError = ''; state.agentsError = ''; state.agentLoading = false; }
    // Show the cached transcript immediately; hydration still gates submissions.
    state.currentId = id;
    const opened = await openThread(id, initial);
    if (!alive || generation !== selectionGeneration) return;
    state.hydrating = false;
    if (opened) {
      state.currentId = id; markRead(id); void loadControls(id); void loadSubagents();
    }
    else { state.error = draftFor(id).readError; targetId = state.currentId; }
  }
  async function resync(fresh = true) {
    if (!alive || state.restarting || state.authExpired) return;
    void loadUsage(fresh);
    void loadWatchdogs(fresh);
    const id = targetId || state.currentId;
    if (id) {
      if (id !== state.currentId || state.hydrating) await selectThread(id);
      else { await openThread(id); if (alive) void loadControls(id); }
    }
    if (alive) await loadThreads(false, fresh);
    if (alive) { void loadSubagents(fresh); if (state.agentsVisible) void loadAgent(); }
  }
  function invalidate() {
    ++connectionGeneration; ++selectionGeneration;
    for (const controller of reads.values()) controller.abort(); reads.clear();
    refreshes.clear();
    state.listLoading = false; state.moreLoading = false;
    syncing.clear(); snapshots.clear();
    state.hydrating = false;
    for (const d of Object.values(state.drafts)) { d.loading = false; if (d.sending) d.uncertain = true; d.sending = false; d.stopping = false; d.uploading = false; d.goalSaving = false; }
    state.replying = {};
    state.agentsLoading = false; state.agentLoading = false;
    state.usage = { weekly: null, resetCount: null };
    for (const t of Object.values(state.entities)) { delete t.tokenUsage; t.goalError = 'Goal 状态待同步'; }
  }
  function receive(n: Update, eventId = '') {
    if (!alive) return;
    const nextEpoch = eventId.includes(':') ? eventId.slice(0, eventId.lastIndexOf(':')) : '';
    if (nextEpoch && epoch && nextEpoch !== epoch) { invalidate(); lastSeq = -1; }
    if (nextEpoch) epoch = nextEpoch;
    if (n.seq !== undefined) { if (n.seq <= lastSeq) return; lastSeq = n.seq; }
    if (n.method === 'viewer/restarting') { beginRestart(); return; }
    if (n.method === 'viewer/restartFailed') { finishRestart('后端重启失败，请重试；未发送的草稿仍保留'); return; }
    if (n.method === 'viewer/offline') { state.restarting = !!restartEpoch || n.params.restarting === true; invalidate(); state.connection = state.restarting ? '整个后端正在重启…' : 'Codex 已离线 · 正在恢复'; state.requests = {}; for (const t of Object.values(state.entities)) t.status = { type: 'systemError' }; return; }
    if (n.method === 'viewer/online' || n.method === 'viewer/resync') {
      const restored = restartEpoch && epoch !== restartEpoch && n.params.online !== false ? restartEpoch : '';
      state.restarting = n.params.restarting === true || !!restartEpoch && !restored;
      state.connection = state.restarting ? '整个后端正在重启…' : n.params.online === false ? 'Codex 已离线 · 正在恢复' : '已连接';
      void resync(false).then(() => {
        if (!alive) return;
        if (restored && restartEpoch === restored) finishRestart();
        else if (pageRestored && state.connection === '已连接' && !state.hydrating && !draft.value?.readError) {
          pageRestored = false; toast('整个后端已重启，页面已更新');
        }
      });
      return;
    }
    if (n.method === 'skills/changed') { void loadControls(); return; }
    if (n.method === 'viewer/usageChanged') { void loadUsage(true); return; }
    if (n.method === 'viewer/watchdogsChanged') {void loadWatchdogs(true);return;}
    if (n.method === 'viewer/referencesChanged' && typeof n.params.threadId==='string') {void loadReferences(n.params.threadId);return;}
    if (n.method === 'account/rateLimits/updated') {
      const weekly = usageFrom(n.params).weekly;
      if (weekly) { state.usage.weekly = weekly; ++usageRevision; }
      return;
    }
    if(n.method==='viewer/threadArchived' || n.method==='thread/archived'){if(typeof n.params.threadId==='string')removeThread(n.params.threadId);return;}
    if (n.method === 'viewer/thread') { void loadThreads(false, true); return; }
    if (n.method === 'thread/started') {
      const t = n.params.thread as Thread | undefined;
      if (t?.id && t.cwd) {
        const live = state.entities[t.id];
        if (live) { mergeThreadMetadata(live, t); } else state.entities[t.id] = t;
        state.revisions[t.id] = (state.revisions[t.id] || 0) + 1;
        void loadSubagents(true);
      }
      return;
    }
    if (n.method === 'serverRequest/resolved') { void resync(); return; }
    let id = typeof n.params.threadId === 'string' ? n.params.threadId : undefined;
    if (n.method === 'viewer/request') { const r = n.params as unknown as PendingRequest; id = String(r.params.threadId); }
    if (n.method === 'viewer/requestResolved') id = state.requests[String(n.params.id)]?.params.threadId as string | undefined;
    if (id && syncing.has(id)) { syncing.get(id)!.push(n); return; }
    // A resolved request may first appear in a snapshot which is still in flight.
    if (!id && n.method === 'viewer/requestResolved') for (const queue of syncing.values()) queue.push(n);
    apply(n, id);
    const item = n.params.item as Item | undefined;
    if (item && ['collabAgentToolCall', 'subAgentActivity'].includes(item.type)) void loadSubagents(true);
  }
  function setText(text: string) { if (!alive || !state.currentId) return; draftFor(state.currentId).text = text; try { storage.setItem('viewer-draft:' + state.currentId, text); } catch {} }
  function setAnswer(itemId: string, index: number, text: string) {
    if (!alive || !current.value || !Number.isInteger(index) || index < 0) return;
    const item = current.value.turns?.flatMap(t => t.items).find(i => i.id === itemId);
    if (item?.delivery !== 'async' || !item.questions?.[index] || text.length > 10_000) return;
    const d = draftFor(current.value.id); (d.answers[itemId] ??= item.questions.map(() => ''))[index] = text;
    save('viewer-answers:' + current.value.id, d.answers);
  }
  function questionResponse(item: DeepReadonly<Pick<Item, 'id' | 'questions'>>): { status: 'received' | 'queued' | 'history' | ''; text: string } {
    const items = current.value?.turns?.flatMap(t => t.items) || [], position = items.findIndex(i => i.id === item.id);
    if (position < 0) return { status: '', text: '' };
    // ponytail: correlate quoted replies within history; use native question receipt IDs if the protocol adds them.
    const prefix = questionPrefix(item);
    const later = items.slice(position + 1).filter(i => i.type === 'userMessage');
    const received = later.flatMap(i => i.content || []).find(p => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith(prefix));
    if (received) return { status: 'received', text: (received.text as string).slice(prefix.length) };
    const queued = draft.value?.queued.find(q => q.text.startsWith(prefix));
    if (queued) return { status: 'queued', text: queued.text.slice(prefix.length) };
    return { status: later.length ? 'history' : '', text: '' };
  }
  function reconcileQueued(id: string) {
    const d = draftFor(id); if (!d.queued.length) return;
    const received = new Set(state.entities[id]?.turns?.flatMap(t => t.items.filter(i => i.type === 'userMessage').map(i => i.clientId)));
    d.queued = d.queued.filter(q => !messageReceived(q, received)); save('viewer-queued:' + id, d.queued);
  }
  function dismissQueued(messageId: string) {
    if (!alive || !draft.value) return;
    draft.value.queued = draft.value.queued.filter(q => q.id !== messageId); save('viewer-queued:' + state.currentId, draft.value.queued);
  }
  function setSettings(settings: Settings) { if (!alive || !state.currentId) return; const d = draftFor(state.currentId); d.desired = settings; d.dirty = true; save('viewer-settings:' + state.currentId, settings); }
  async function saveGoal(update: GoalUpdate | null): Promise<boolean> {
    const id = state.currentId, d = draft.value, generation = connectionGeneration;
    if (!alive || !id || !d || d.goalSaving || d.sending || d.stopping || state.hydrating || state.restarting || state.connection !== '已连接') return false;
    const desired = d.desired || current.value?.settings;
    d.goalSaving = true; d.error = '';
    try {
      await client.request(`/threads/${encodeURIComponent(id)}/goal${update === null ? '/clear' : ''}`, update === null ? {} : { ...update, settings: desired });
      if (!alive || generation !== connectionGeneration) return false;
      if ((update?.status === 'active' || update?.objective !== undefined && update.status !== 'paused') && d.desired === desired) { d.dirty = false; save('viewer-settings:' + id, undefined); }
      return await openThread(id);
    } catch (e) {
      if (alive && generation === connectionGeneration) { report(e, id); await openThread(id); }
      return false;
    } finally { if (alive && generation === connectionGeneration) d.goalSaving = false; }
  }
  function toggleSkill(skill: Skill, selected = true) { if (!alive || !draft.value) return; const list = draft.value.skills.filter(s => s.path !== skill.path); if (selected) list.push({ ...skill }); draft.value.skills = list; }
  function removeAttachment(id: string) { if (alive && draft.value) draft.value.attachments = draft.value.attachments.filter(a => a.id !== id); }
  async function addFiles(files: File[]) {
    if (!alive) return;
    const id = state.currentId, d = draft.value, generation = connectionGeneration;
    if (!id || !d || d.sending || state.hydrating || state.restarting || state.restartPending) { toast('请先选择任务，并等待提交或重启完成'); return; }
    if (d.uploading) { toast('请等待当前上传完成'); return; }
    if (d.attachments.length + files.length > 10) { toast('每轮最多 10 个附件'); return; }
    d.uploading = true;
    try { for (const file of files) { if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MB`); const attachment = await client.upload(file); if (!alive || generation !== connectionGeneration) return; d.attachments.push(attachment); } }
    catch (e) { if (generation === connectionGeneration) report(e, id); }
    finally { if (alive && generation === connectionGeneration) d.uploading = false; }
  }
  async function send(action: 'steer' | 'interrupt' = 'steer', questionId?: string, appMessage?: { threadId: string; text: string }): Promise<boolean> {
    if (!alive || !canSend.value || appMessage && appMessage.threadId !== state.currentId) return false;
    const id = state.currentId, d = draftFor(id), generation = connectionGeneration;
    const question = questionId === undefined ? undefined : current.value?.turns?.flatMap(t => t.items).find(i => i.id === questionId && i.type === 'agentMessage' && i.delivery === 'async' && i.questions?.length);
    if (questionId !== undefined) {
      if (!question || ['received', 'queued'].includes(questionResponse(question).status)) return false;
      if (question.questions!.some((_, i) => !d.answers[questionId]?.[i]?.trim())) return false;
    }
    const flushQueued = !question && !appMessage && (!active.value || action === 'interrupt');
    const queued = flushQueued ? d.queued.map(q => ({ ...q, attachments: q.attachments.map(a => a.id), skills: q.skills.map(s => s.path), ...(q.references?.length?{references:q.references.map(r=>r.id)}:{}) })) : [];
    const delivery = queued.length ? 'flush' : active.value ? action : 'start', expectedTurnId = activeTurn.value?.id;
    const text = appMessage?.text ?? (question ? questionPrefix(question) + question.questions!.map((_, i) => `${i + 1}. ${d.answers[question.id]![i]!.trim()}`).join('\n') : d.text);
    const desired = d.desired, attachments = question || appMessage ? [] : d.attachments.map(a => a.id), skills = question || appMessage ? [] : d.skills.map(s => s.path);
    const queuedAttachments = question || appMessage ? [] : d.attachments.slice(), queuedSkills = question || appMessage ? [] : d.skills.slice();
    const sentReferences=question || appMessage?[]:d.references.slice();
    const hasReferences=sentReferences.length>0 || queued.some(q=>q.references?.length);
    if(hasReferences && (!d.catalog.capabilities?.references?.snapshot || [...sentReferences,...d.queued.flatMap(q=>q.references || [])].some(r=>r.kind==='session') && !d.catalog.capabilities?.references?.session)) {report('当前后端不支持这些引用；草稿已保留，请重新加载配置',id);return false;}
    if (!text.trim() && !attachments.length && !queued.length && !sentReferences.length) return false;
    let batchId: string | undefined = queued.length ? crypto.randomUUID() : undefined;
    d.sending = true; d.error = ''; state.error = '';
    try {
      const settings = delivery !== 'steer' && d.catalog.models.length && d.catalog.modes.length ? desired : undefined;
      const signature=JSON.stringify({text,attachments,skills,references:sentReferences.map(r=>r.id),queued:queued.map(({forwardedAs,...q})=>q),delivery,settings});
      if(hasReferences) {
        if(d.referenceSubmission?.signature!==signature)d.referenceSubmission={id:crypto.randomUUID(),signature};
        save('viewer-reference-submission:'+id,d.referenceSubmission);
        if(queued.length)batchId=d.referenceSubmission!.id;
      }
      if(batchId){for(const q of d.queued)q.forwardedAs=[...new Set([...q.forwardedAs || [],batchId])];save('viewer-queued:'+id,d.queued);}
      const result = await client.request<{ turn?: Turn; messageId?: string; turnId?: string; handledQueuedIds?: string[]; goalWarning?: string }>(
        `/threads/${encodeURIComponent(id)}/turns`,
        { text, attachments, delivery, expectedTurnId, settings, skills, ...(hasReferences?{references:sentReferences.map(r=>r.id),clientMessageId:d.referenceSubmission!.id}:{}), ...(appContexts.get(id)?.size ? { appContexts: [...appContexts.get(id)!.values()] } : {}), ...(queued.length ? { queued, batchId } : {}) },
      );
      if (!alive || generation !== connectionGeneration) return false;
      if (delivery === 'steer' && result.messageId && result.turnId) {
        d.queued.push({ id: result.messageId, turnId: result.turnId, text, attachments: queuedAttachments, skills: queuedSkills, ...(sentReferences.length?{references:sentReferences}:{}) });
        reconcileQueued(id);
      }
      if (result.handledQueuedIds) {
        d.queued = d.queued.filter(q => !result.handledQueuedIds!.includes(q.id)); save('viewer-queued:' + id, d.queued);
      }
      if (question && result.turn) {
        reduceNotice(state.entities[id]!, { method: 'turn/started', params: { threadId: id, turn: result.turn } });
        state.revisions[id] = (state.revisions[id] || 0) + 1;
      }
      if (delivery !== 'steer' && (delivery !== 'flush' || result.turn) && d.desired === desired) { d.dirty = false; save('viewer-settings:' + id, undefined); }
      if (!question && !appMessage && d.text === text) { d.text = ''; try { storage.setItem('viewer-draft:' + id, ''); } catch {} }
      d.attachments = d.attachments.filter(a => !attachments.includes(a.id)); d.skills = d.skills.filter(s => !skills.includes(s.path));
      d.references=d.references.filter(r=>!sentReferences.some(s=>s.id===r.id));save('viewer-references:'+id,d.references);
      if(hasReferences){d.referenceSubmission=undefined;save('viewer-reference-submission:'+id,undefined);}
      if (delivery === 'steer') toast('已排队追加，Codex 将在下次接收输入时处理');
      await openThread(id);
      if (result.goalWarning) report(result.goalWarning, id);
      return true;
    } catch (e) { if (generation === connectionGeneration) { if (/timed out|中断尚未确认/i.test(message(e))) d.uncertain = true; report(e, id); } }
    finally { if (alive && generation === connectionGeneration) d.sending = false; }
    return false;
  }
  async function reply(id: string, decision: string, answers: Record<string, unknown>) {
    const request = state.requests[id], generation = connectionGeneration;
    if (!alive || !request || state.replying[id]) return;
    state.replying[id] = true;
    try { await client.request('/requests/' + encodeURIComponent(id), { decision, answers }); if (alive && generation === connectionGeneration) delete state.requests[id]; }
    catch (e) { if (generation === connectionGeneration) report(e, String(request.params.threadId)); }
    finally { if (alive && generation === connectionGeneration) delete state.replying[id]; }
  }
  async function interrupt() {
    const id = state.currentId, d = draft.value, generation = connectionGeneration;
    if (!alive || !id || !d || d.sending || d.stopping || d.goalSaving) return;
    d.stopping = true; d.error = '';
    try { await client.request(`/threads/${encodeURIComponent(id)}/interrupt`, {}); if (alive && generation === connectionGeneration) await openThread(id); }
    catch (e) { if (generation === connectionGeneration) { if (/timed out|中断尚未确认/i.test(message(e))) d.uncertain = true; report(e, id); } }
    finally { if (alive && generation === connectionGeneration) d.stopping = false; }
  }
  async function restartBackend() {
    if (!alive || state.restarting || state.restartPending) return;
    if (Object.values(state.drafts).some(d => d.sending || d.stopping || d.uploading || d.goalSaving || d.uncertain)) { toast('请等待提交或上传完成，并确认任务状态后再重启'); return; }
    state.restartPending = true; state.error = '';
    try {
      const result = await client.request<{ epoch?: string }>('/restart', {});
      if (!alive) return;
      if (!result.epoch) { finishRestart('当前 Viewer 尚未加载完整重启功能，请先重启 Viewer 服务'); return; }
      if (result.epoch === epoch) beginRestart();
    } catch (e) { if (alive && !restartEpoch) finishRestart(message(e)); }
  }
  function beginRestart() {
    if (restartEpoch) return;
    restartEpoch = epoch; state.restarting = true; state.restartPending = true; state.connection = '整个后端正在重启…';
    restartTimer = setTimeout(() => finishRestart('重启后未能在 60 秒内重新连接，草稿仍保留；请检查服务后重试'), 60_000);
  }
  function finishRestart(error = '') {
    if (error && restartEpoch) state.connection = '重连未完成 · 请检查服务';
    clearTimeout(restartTimer); restartEpoch = ''; state.restarting = false; state.restartPending = false;
    if (error) { report(new Error(error)); return; }
    if (options.reloadOnRestart === false || typeof window === 'undefined') { toast('整个后端已重启并重新连接'); return; }
    try {
      // One-shot, per-tab handoff: localStorage alone mixes drafts from different tabs.
      const drafts = Object.fromEntries(Object.entries(state.drafts).map(([id, { text, attachments, skills, references, referenceSubmission, queued, answers, desired, dirty, uncertain }]) =>
        [id, { text, attachments, skills, references, referenceSubmission, queued, answers, desired, dirty, uncertain } satisfies ReloadDraft]));
      viewerWindow().sessionStorage.setItem(reloadKey, JSON.stringify(drafts));
      state.restartPending = true;
      viewerWindow().location.reload();
    } catch {
      state.restartPending = false;
      report(new Error('后端已重启，但无法暂存草稿以刷新页面；请先保存草稿和附件，再手动刷新'));
    }
  }
  async function setSkillEnabled(id: string, skill: Skill, enabled: boolean) {
    if (!alive) return;
    const generation = connectionGeneration;
    try {
      const result = await client.request<{ effectiveEnabled: boolean }>('/skills/config', { threadId: id, path: skill.path, enabled });
      if (!alive || generation !== connectionGeneration) return;
      if (result.effectiveEnabled !== enabled) throw new Error('配置未生效：可能受上层策略限制');
      if (!enabled) for (const d of Object.values(state.drafts)) d.skills = d.skills.filter(s => s.path !== skill.path);
      await loadControls(id);
    } catch (e) { if (alive && generation === connectionGeneration) throw e; }
  }
  async function createThread(cwd: string, options?: { model: string; contextManagement: boolean }) {
    if (!alive) return;
    const generation = connectionGeneration, selection = selectionGeneration;
    try {
      const result = await client.request<Snapshot & { models?: Catalog['models'] }>('/threads', { cwd, ...options });
      if (!alive || generation !== connectionGeneration) return;
      if (selection === selectionGeneration) {
        if (result.models) draftFor(result.thread.id).catalog.models = result.models;
        await selectThread(result.thread.id, result);
      }
      if (alive && generation === connectionGeneration) void loadThreads();
      return alive && state.currentId === result.thread.id ? result.thread.id : undefined;
    } catch (e) { if (alive && generation === connectionGeneration) throw e; }
  }
  async function rename(id: string, name: string) {
    if (!alive) return;
    if (!name.trim() || Array.from(name.trim()).length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('标题须为 1–120 个字符的单行文字');
    const generation = connectionGeneration;
    try {
      await client.request(`/threads/${encodeURIComponent(id)}/name`, { name: name.trim() });
      if (!alive || generation !== connectionGeneration) return;
      await openThread(id);
      if (!alive || generation !== connectionGeneration) return;
      await loadThreads(); if (generation === connectionGeneration) toast('标题已保存');
    } catch (e) { if (alive && generation === connectionGeneration) throw e; }
  }
  function start(id = '') {
    if (started || !alive) return;
    started = true;
    targetId = id;
    // The server sends an initial resync; it owns bootstrap and reconnect reads.
    client.subscribe(receive, online => { state.connection = state.restarting ? '整个后端正在重启…' : online ? '已连接' : '连接断开 · 重连中'; }, report);
    usageTimer = setInterval(refreshUsage, 60_000);
    agentTimer = setInterval(refreshAgents, 2000);
    if (typeof document !== 'undefined') viewerDocument().addEventListener('visibilitychange', refreshUsage);
  }
  function updateAppContext(target: AppTarget, context: AppContext) {
    if (!alive || target.threadId !== state.currentId) throw new Error('应用会话已切换');
    const entries = appContexts.get(target.threadId) || new Map<string, AppContextInput>();
    const key = `${target.turnId}:${target.itemId}`, value = { ...target, context };
    const values = [...entries.entries()].filter(([id]) => id !== key).map(([, value]) => value).concat(value);
    if (values.length > 64 || JSON.stringify(values).length > appContextLimit) throw new Error('应用上下文过大');
    entries.set(key, value); appContexts.set(target.threadId, entries);
  }
  function dispose() { if (!alive) return; invalidate(); alive = false; appContexts.clear(); client.dispose(); clearTimeout(toastTimer); clearTimeout(restartTimer); clearInterval(usageTimer); clearInterval(agentTimer); if (typeof document !== 'undefined') viewerDocument().removeEventListener('visibilitychange', refreshUsage); }
  async function loadReferences(id=state.currentId) {
    if(!alive || !state.entities[id])return;
    return refresh('references:'+id,async()=>{
      const generation=connectionGeneration;
      try {const data=await client.request<ReferenceData>(`/threads/${encodeURIComponent(id)}/references`);if(alive && generation===connectionGeneration && state.entities[id])Object.assign(state.entities[id],data);}
      catch(e){if(alive && generation===connectionGeneration)report(e,id);}
    },true);
  }
  async function attachReference(reference:ConversationReference) {
    const id=reference.targetThreadId,d=draftFor(id);
    if(d.references.length>=10)throw new Error('每条消息最多 10 个引用');
    if(!d.references.some(r=>r.id===reference.id))d.references.push(reference);
    save('viewer-references:'+id,d.references);
    await selectThread(id);
  }
  function removeReference(refId:string) {const d=draft.value;if(!d)return;d.references=d.references.filter(r=>r.id!==refId);save('viewer-references:'+state.currentId,d.references);}
  async function revokeReference(refId:string) {await client.request(`/threads/${encodeURIComponent(state.currentId)}/references/${encodeURIComponent(refId)}`,{action:'revoke'});await loadReferences();}
  async function referenceTarget(cwd:string) {
    const {thread}=await client.request<Snapshot>('/threads',{cwd});state.entities[thread.id]=thread;if(!state.ids.includes(thread.id))state.ids.unshift(thread.id);return thread.id;
  }
  async function jumpToReference(sourceThreadId:string,position?:ReferencePosition) {
    await selectThread(sourceThreadId);if(state.currentId===sourceThreadId){state.targetTurn=position?.turnId || '';state.targetItem=position?.itemId || '';}
  }
  return {
    attachReference, removeReference, revokeReference, loadReferences, referenceTarget, jumpToReference,
    createReference: (target:string,sourceThreadId:string,kind:'snapshot'|'session',selected?:ReferencePosition[])=>client.request<{reference:ConversationReference}>(`/threads/${encodeURIComponent(target)}/references`,{sourceThreadId,kind,selected}),
    describeApp: (target: AppTarget, signal?: AbortSignal) => client.request<{ app: AppDescription | null }>(appPath(target), undefined, signal),
    openApp: (target: AppTarget, signal?: AbortSignal) => client.request<AppView>(appPath(target) + '/open', {}, signal),
    appRpc: (id: string, method: string, params: Obj, signal?: AbortSignal) => client.request<Obj>(`/mcp-apps/${id}/rpc`, { method, params }, signal),
    closeApp: (id: string) => client.request<Obj>(`/mcp-apps/${id}/close`, {}),
    keepApp: (id: string) => client.request<Obj>(`/mcp-apps/${id}/keepalive`, {}),
    updateAppContext,
    state: readonly(state), current: computed(() => current.value && readonly(current.value)), draft: computed(() => draft.value && readonly(draft.value)),
    threads: computed(() => readonly(threads.value)), approvals: computed(() => readonly(approvals.value)), active, canSend, contextBlocked,
    start, dispose, receive, archiveThread, selectThread, loadThreads, loadControls, loadUsage, resetUsage, resync, report, toast, setText, setAnswer, questionResponse, setSettings, saveGoal, refreshGoal: () => openThread(state.currentId), toggleSkill, removeAttachment, addFiles, send, dismissQueued, reply, setSkillEnabled, createThread, rename,
    status,
    agents, selectedAgent: computed(() => selectedAgent.value && readonly(selectedAgent.value)), loadSubagents, loadAgent, selectAgent, setAgentsVisible,
    loadWatchdogs, saveWatchdog, controlWatchdog, jumpToRun,
    watchdogRuns: (id:string,offset=0)=>client.request<{data:WatchdogRun[]}>('/watchdogs/'+encodeURIComponent(id)+'/runs?offset='+offset),
    watchdogCatalog: (threadId:string)=>client.request<Catalog>('/controls?threadId='+encodeURIComponent(threadId)),
    toggleProject(root: string) { if (!alive) return; state.collapsed[root] = !state.collapsed[root]; save('viewer-projects', state.collapsed); },
    interrupt, restartBackend,
    directories: (path?: string, signal?: AbortSignal) => client.request<Directories>('/directories' + (path ? '?path=' + encodeURIComponent(path) : ''), undefined, signal),
    newThreadOptions: (cwd: string, signal?: AbortSignal) => client.request<NewThreadOptions>('/thread-options?cwd=' + encodeURIComponent(cwd), undefined, signal),
    pickDirectory: (path?: string, signal?: AbortSignal) => client.request<{ path: string | null }>('/directories/pick', { path }, signal),
    preview: (threadId: string, target: string, signal?: AbortSignal) => client.request<Preview>('/files/preview?' + new URLSearchParams({ threadId, target }), undefined, signal),
    openFile: (threadId: string, target: string) => { if (!alive) return Promise.resolve(); state.error = ''; return client.request('/files/open', { threadId, target }); },
    revealFile: (threadId: string, target: string) => { if (!alive) return Promise.resolve(); state.error = ''; return client.request('/files/reveal', { threadId, target }); },
  };
}

export type ViewerStore = ReturnType<typeof createViewerStore>;
export const viewerKey: InjectionKey<ViewerStore> = Symbol('viewer');
export function useViewer() { const store = inject(viewerKey); if (!store) throw new Error('Viewer store is missing'); return store; }
export { threadTitle };
