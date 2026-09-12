import { computed, inject, reactive, readonly } from 'vue';
import type { DeepReadonly, InjectionKey } from 'vue';
import { messageReceived, mergeThreadMetadata, reduceNotice, threadTitle, usageFrom } from '../shared/protocol.ts';
import type { Item, NewThreadOptions, PendingRequest, Settings, Skill, Thread, Turn, Usage } from '../shared/protocol.ts';
import { createClient } from './api.ts';
import type { Attachment, Catalog, Directories, Preview, Snapshot, Update } from './api.ts';
import type { Watchdog, WatchdogConfig, WatchdogRun } from '../shared/watchdogs.ts';
import { agentTree, mergeAgentHistory } from '../shared/agents.ts';

const emptyCatalog = (): Catalog => ({ models: [], modes: [], skills: [], errors: {}, skillErrors: [] });
type QueuedMessage = { id: string; turnId: string; text: string; attachments: Attachment[]; skills: Skill[]; forwardedAs?: string[] };
type Draft = { text: string; attachments: Attachment[]; skills: Skill[]; queued: QueuedMessage[]; answers: Record<string, string[]>; desired?: Settings; dirty: boolean; catalog: Catalog; loading: boolean; sending: boolean; stopping: boolean; uploading: boolean; uncertain: boolean; error: string; readError: string };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const questionPrefix = (item: DeepReadonly<Pick<Item, 'questions'>>) => '回答 Codex 提问：\n' + (item.questions || []).map((q, i) => `${i + 1}. ${q.title}`).join('\n') + '\n\n';

export function createViewerStore(client = createClient(), storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {
  const read = <T>(key: string, fallback: T): T => { try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const save = (key: string, value: unknown) => { try { if (value === undefined) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); } catch {} };
  const state = reactive({
    entities: {} as Record<string, Thread>, ids: [] as string[], currentId: '', hydrating: false, cursor: null as string | null,
    revisions: {} as Record<string, number>,
    drafts: {} as Record<string, Draft>, requests: {} as Record<string, PendingRequest>, replying: {} as Record<string, boolean>,
    read: read<Record<string, number>>('viewer-read', {}), collapsed: read<Record<string, boolean>>('viewer-projects', {}),
    connection: '连接中', restarting: false, restartPending: false, error: '', toast: '',
    usage: { weekly: null, resetCount: null } as Usage, usageError: '',
    watchdogs: [] as Watchdog[], watchdogError: '', targetTurn: '',
    selectedAgentId: '', agentsVisible: false, agentsLoading: false, agentLoading: false, agentsError: '', agentError: '',
  });
  let alive = true, started = false, connectionGeneration = 0, selectionGeneration = 0;
  let targetId = '', epoch = '', lastSeq = -1;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined, usageRevision = 0;
  let agentTimer: ReturnType<typeof setInterval> | undefined;
  const reads = new Map<string, AbortController>();
  const snapshots = new Map<string, number>();
  const syncing = new Map<string, Update[]>();
  const notified = new Set<string>();
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
      state.drafts[id] = { text, attachments: [], skills: [], queued: read<QueuedMessage[]>('viewer-queued:' + id, []), answers: read<Record<string, string[]>>('viewer-answers:' + id, {}), desired, dirty: !!desired, catalog: emptyCatalog(), loading: false, sending: false, stopping: false, uploading: false, uncertain: false, error: '', readError: '' };
    }
    return state.drafts[id];
  }
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
    if (!current.value || !d || state.restarting || state.restartPending || state.hydrating || d.loading || d.sending || d.stopping || d.uploading || d.uncertain) return false;
    if (active.value) return !!activeTurn.value;
    const settingsUnavailable = d.dirty && (!d.catalog.models.length || !d.catalog.modes.length);
    return !contextBlocked.value && !settingsUnavailable;
  });
  function report(e: unknown, id?: string) {
    if (!alive || (e instanceof Error && e.name === 'AbortError')) return;
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
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification(text, { icon: new URL('./assets/icon.png', import.meta.url).href });
  }
  function status(t: DeepReadonly<Pick<Thread, 'id' | 'status' | 'turns' | 'updatedAt'>>): [string, string] {
    if (t.status?.activeFlags?.some(f => /waiting/.test(f)) || Object.values(state.requests).some(r => r.params.threadId === t.id)) return ['attention', '等待输入'];
    if (t.status?.type === 'active') return ['running', '进行中'];
    if (t.status?.type === 'systemError' || t.turns?.at(-1)?.status === 'failed') return ['failed', '失败'];
    return (t.updatedAt || 0) > (state.read[t.id] || 0) && t.id !== state.currentId ? ['unread', '未读'] : ['idle', '空闲'];
  }
  async function loadThreads(more = false, changed = false) {
    if (!alive || (more && !state.cursor)) return;
    return refresh(more ? 'more' : 'list', async () => {
      const job = begin(more ? 'more' : 'list'), previousNames = new Map(Object.values(state.entities).map(t => [t.id, t.name]));
      const revisions = { ...state.revisions };
      try {
        const result = await client.request<{ data: Thread[]; nextCursor: string | null }>('/threads' + (more && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''), undefined, job.signal);
        if (!job.valid()) return;
        for (const t of result.data) {
          const live = state.entities[t.id];
          if (live) {
            if (live.name !== previousNames.get(t.id)) t.name = live.name;
            mergeThreadMetadata(live, t);
            // Accept list status only if no live event or snapshot arrived during the read.
            if (t.status && state.revisions[t.id] === revisions[t.id]) live.status = t.status;
          }
          else state.entities[t.id] = t;
        }
        state.ids = [...new Set([...state.ids, ...result.data.map(t => t.id), ...(state.currentId ? [state.currentId] : [])])];
        if (more || !listLoaded) state.cursor = result.nextCursor;
        listLoaded = true;
      } catch (e) { if (job.valid()) report(e); }
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
    if (!state.agentsVisible || state.restarting || state.connection !== '已连接' || (typeof document !== 'undefined' && document.hidden)) return;
    if (current.value?.status?.type === 'active' || selectedAgent.value?.turns?.at(-1)?.status === 'inProgress' || agents.value.some(a => ['running', 'pendingInit', 'waiting'].includes(a.state))) {
      void loadSubagents(); void loadAgent();
    }
  }
  function refreshUsage() { if (typeof document === 'undefined' || !document.hidden) void loadUsage(); }
  async function loadWatchdogs(changed = false) {
    if (!alive) return;
    return refresh('watchdogs', async () => {
      const job = begin('watchdogs');
      try {
        const result = await client.request<{ data: Watchdog[] }>('/watchdogs', undefined, job.signal);
        if (job.valid()) { state.watchdogs = result.data; state.watchdogError = ''; }
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
      reduceNotice(state.entities[id], n);
      if (n.method === 'turn/started' || n.method === 'turn/completed' || (n.params.item as { type?: string } | undefined)?.type === 'userMessage') reconcileQueued(id);
      state.revisions[id] = (state.revisions[id] || 0) + 1;
      if (n.method === 'thread/settings/updated' && !n.params.watchdogRunId && !draftFor(id).dirty) draftFor(id).desired = state.entities[id].settings;
    }
    if (n.method === 'turn/completed' && id) {
      for (const [key, r] of Object.entries(state.requests)) if (r.params.threadId === id) delete state.requests[key];
      draftFor(id).uncertain = false; if (state.currentId === id) markRead(id);
      const turn = n.params.turn as { id: string; status: string };
      notify(turn.status === 'completed' ? 'Codex 任务已完成' : 'Codex 任务已结束：' + turn.status, turn.id);
      void loadThreads(false, true);
    }
  }
  async function openThread(id: string): Promise<boolean> {
    if (!alive) return false;
    const job = begin('open:' + id);
    // Preserve already-buffered events when a newer read supersedes an older read.
    const queue = syncing.get(id) || []; syncing.set(id, queue);
    try {
      const result = await client.request<Snapshot>(`/threads/${encodeURIComponent(id)}/open`, {}, job.signal);
      if (!job.valid()) return false;
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
  async function selectThread(id: string) {
    if (!alive) return;
    if (draft.value?.sending || draft.value?.uploading) { toast('请等待当前提交或上传完成'); return; }
    const generation = ++selectionGeneration; targetId = id; state.targetTurn=''; state.hydrating = true; state.error = ''; draftFor(id).error = '';
    const opened = await openThread(id);
    if (!alive || generation !== selectionGeneration) return;
    state.hydrating = false;
    if (opened) {
      if (state.currentId !== id) { reads.get('agent')?.abort(); reads.get('agents')?.abort(); refreshes.delete('agents:' + state.currentId); refreshes.delete('agent:' + state.selectedAgentId); state.selectedAgentId = ''; state.agentError = ''; state.agentsError = ''; state.agentLoading = false; }
      state.currentId = id; markRead(id); void loadControls(id); void loadSubagents();
    }
    else { state.error = draftFor(id).readError; targetId = state.currentId; }
  }
  async function resync(fresh = true) {
    if (!alive || state.restarting) return;
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
    syncing.clear(); snapshots.clear();
    state.hydrating = false;
    for (const d of Object.values(state.drafts)) { d.loading = false; if (d.sending) d.uncertain = true; d.sending = false; d.stopping = false; d.uploading = false; }
    state.replying = {};
    state.agentsLoading = false; state.agentLoading = false;
    state.usage = { weekly: null, resetCount: null };
    for (const t of Object.values(state.entities)) delete t.tokenUsage;
  }
  function receive(n: Update, eventId = '') {
    if (!alive) return;
    const nextEpoch = eventId.includes(':') ? eventId.slice(0, eventId.lastIndexOf(':')) : '';
    if (nextEpoch && epoch && nextEpoch !== epoch) { invalidate(); lastSeq = -1; }
    if (nextEpoch) epoch = nextEpoch;
    if (n.seq !== undefined) { if (n.seq <= lastSeq) return; lastSeq = n.seq; }
    if (n.method === 'viewer/restarting') { state.restarting = true; state.connection = 'Codex 后端正在重启…'; return; }
    if (n.method === 'viewer/offline') { state.restarting = n.params.restarting === true; invalidate(); state.connection = state.restarting ? 'Codex 后端正在重启…' : 'Codex 已离线 · 正在恢复'; state.requests = {}; for (const t of Object.values(state.entities)) t.status = { type: 'systemError' }; return; }
    if (n.method === 'viewer/online' || n.method === 'viewer/resync') { state.restarting = n.params.restarting === true; state.connection = state.restarting ? 'Codex 后端正在重启…' : n.params.online === false ? 'Codex 已离线 · 正在恢复' : '已连接'; void resync(false); return; }
    if (n.method === 'skills/changed') { void loadControls(); return; }
    if (n.method === 'viewer/watchdogsChanged') {void loadWatchdogs(true);return;}
    if (n.method === 'account/rateLimits/updated') {
      const weekly = usageFrom(n.params).weekly;
      if (weekly) { state.usage.weekly = weekly; ++usageRevision; }
      return;
    }
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
  function questionStatus(item: DeepReadonly<Pick<Item, 'id' | 'questions'>>): 'received' | 'queued' | 'history' | '' {
    const items = current.value?.turns?.flatMap(t => t.items) || [], position = items.findIndex(i => i.id === item.id);
    if (position < 0) return '';
    // ponytail: correlate quoted replies within history; use native question receipt IDs if the protocol adds them.
    const prefix = questionPrefix(item);
    if (items.slice(position + 1).some(i => i.type === 'userMessage' && i.content?.some(p => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith(prefix)))) return 'received';
    if (draft.value?.queued.some(q => q.text.startsWith(prefix))) return 'queued';
    return items.slice(position + 1).some(i => i.type === 'userMessage') ? 'history' : '';
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
  function toggleSkill(skill: Skill, selected = true) { if (!alive || !draft.value) return; const list = draft.value.skills.filter(s => s.path !== skill.path); if (selected) list.push({ ...skill }); draft.value.skills = list; }
  function removeAttachment(id: string) { if (alive && draft.value) draft.value.attachments = draft.value.attachments.filter(a => a.id !== id); }
  async function addFiles(files: File[]) {
    if (!alive) return;
    const id = state.currentId, d = draft.value, generation = connectionGeneration;
    if (!id || !d || d.sending || state.hydrating) { toast('请先选择任务，并等待提交完成'); return; }
    if (d.uploading) { toast('请等待当前上传完成'); return; }
    if (d.attachments.length + files.length > 10) { toast('每轮最多 10 个附件'); return; }
    d.uploading = true;
    try { for (const file of files) { if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MB`); const attachment = await client.upload(file); if (!alive || generation !== connectionGeneration) return; d.attachments.push(attachment); } }
    catch (e) { if (generation === connectionGeneration) report(e, id); }
    finally { if (alive && generation === connectionGeneration) d.uploading = false; }
  }
  async function send(action: 'steer' | 'interrupt' = 'steer', questionId?: string): Promise<boolean> {
    if (!alive || !canSend.value) return false;
    const id = state.currentId, d = draftFor(id), generation = connectionGeneration;
    const question = questionId === undefined ? undefined : current.value?.turns?.flatMap(t => t.items).find(i => i.id === questionId && i.type === 'agentMessage' && i.delivery === 'async' && i.questions?.length);
    if (questionId !== undefined) {
      if (!question || ['received', 'queued'].includes(questionStatus(question))) return false;
      if (question.questions!.some((_, i) => !d.answers[questionId]?.[i]?.trim())) return false;
    }
    const flushQueued = !question && (!active.value || action === 'interrupt');
    const queued = flushQueued ? d.queued.map(q => ({ ...q, attachments: q.attachments.map(a => a.id), skills: q.skills.map(s => s.path) })) : [];
    const delivery = queued.length ? 'flush' : active.value ? action : 'start', expectedTurnId = activeTurn.value?.id;
    const text = question ? questionPrefix(question) + question.questions!.map((_, i) => `${i + 1}. ${d.answers[question.id]![i]!.trim()}`).join('\n') : d.text;
    const desired = d.desired, attachments = question ? [] : d.attachments.map(a => a.id), skills = question ? [] : d.skills.map(s => s.path);
    const queuedAttachments = question ? [] : d.attachments.slice(), queuedSkills = question ? [] : d.skills.slice();
    if (!text.trim() && !attachments.length && !queued.length) return false;
    const batchId = queued.length ? crypto.randomUUID() : undefined;
    if (batchId) {
      for (const q of d.queued) q.forwardedAs = [...q.forwardedAs || [], batchId];
      save('viewer-queued:' + id, d.queued);
    }
    d.sending = true; d.error = ''; state.error = '';
    try {
      const settings = delivery !== 'steer' && d.catalog.models.length && d.catalog.modes.length ? desired : undefined;
      const result = await client.request<{ turn?: Turn; messageId?: string; turnId?: string; handledQueuedIds?: string[] }>(
        `/threads/${encodeURIComponent(id)}/turns`,
        { text, attachments, delivery, expectedTurnId, settings, skills, ...(queued.length ? { queued, batchId } : {}) },
      );
      if (!alive || generation !== connectionGeneration) return false;
      if (delivery === 'steer' && result.messageId && result.turnId) {
        d.queued.push({ id: result.messageId, turnId: result.turnId, text, attachments: queuedAttachments, skills: queuedSkills });
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
      if (!question && d.text === text) { d.text = ''; try { storage.setItem('viewer-draft:' + id, ''); } catch {} }
      d.attachments = d.attachments.filter(a => !attachments.includes(a.id)); d.skills = d.skills.filter(s => !skills.includes(s.path));
      if (delivery === 'steer') toast('已排队追加，Codex 将在下次接收输入时处理');
      await openThread(id);
      return true;
    } catch (e) { if (generation === connectionGeneration) { if (/timed out|中断尚未确认/i.test(message(e))) d.uncertain = true; report(e, id); } }
    finally { if (alive && generation === connectionGeneration) d.sending = false; }
    return false;
  }
  async function reply(id: string, decision: string, answers: Record<string, string>) {
    const request = state.requests[id], generation = connectionGeneration;
    if (!alive || !request || state.replying[id]) return;
    state.replying[id] = true;
    try { await client.request('/requests/' + encodeURIComponent(id), { decision, answers }); if (alive && generation === connectionGeneration) delete state.requests[id]; }
    catch (e) { if (generation === connectionGeneration) report(e, String(request.params.threadId)); }
    finally { if (alive && generation === connectionGeneration) delete state.replying[id]; }
  }
  async function interrupt() {
    const id = state.currentId, d = draft.value, generation = connectionGeneration;
    if (!alive || !id || !d || d.sending || d.stopping) return;
    d.stopping = true; d.error = '';
    try { await client.request(`/threads/${encodeURIComponent(id)}/interrupt`, {}); if (alive && generation === connectionGeneration) await openThread(id); }
    catch (e) { if (generation === connectionGeneration) { if (/timed out|中断尚未确认/i.test(message(e))) d.uncertain = true; report(e, id); } }
    finally { if (alive && generation === connectionGeneration) d.stopping = false; }
  }
  async function restartBackend() {
    if (!alive || state.restarting || state.restartPending) return;
    if (Object.values(state.drafts).some(d => d.sending || d.stopping || d.uploading || d.uncertain)) { toast('请等待提交或上传完成，并确认任务状态后再重启'); return; }
    state.restartPending = true; state.error = '';
    try { await client.request('/restart', {}); if (alive) toast('Codex 后端已重启'); }
    catch (e) { if (alive) { state.restarting = false; report(e); } }
    finally { if (alive) state.restartPending = false; }
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
      const result = await client.request<{ thread: Thread }>('/threads', { cwd, ...options });
      if (!alive || generation !== connectionGeneration) return;
      if (selection === selectionGeneration) await selectThread(result.thread.id);
      if (alive && generation === connectionGeneration) await loadThreads();
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
    client.subscribe(receive, online => { state.connection = online ? '已连接' : '连接断开 · 重连中'; }, report);
    usageTimer = setInterval(refreshUsage, 60_000);
    agentTimer = setInterval(refreshAgents, 2000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refreshUsage);
  }
  function dispose() { if (!alive) return; invalidate(); alive = false; client.dispose(); clearTimeout(toastTimer); clearInterval(usageTimer); clearInterval(agentTimer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refreshUsage); }
  return {
    state: readonly(state), current: computed(() => current.value && readonly(current.value)), draft: computed(() => draft.value && readonly(draft.value)),
    threads: computed(() => readonly(threads.value)), approvals: computed(() => readonly(approvals.value)), active, canSend, contextBlocked,
    start, dispose, receive, selectThread, loadThreads, loadControls, loadUsage, resync, report, toast, setText, setAnswer, questionStatus, setSettings, toggleSkill, removeAttachment, addFiles, send, dismissQueued, reply, setSkillEnabled, createThread, rename,
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
    openFile: (threadId: string, target: string) => client.request('/files/open', { threadId, target }),
  };
}

export type ViewerStore = ReturnType<typeof createViewerStore>;
export const viewerKey: InjectionKey<ViewerStore> = Symbol('viewer');
export function useViewer() { const store = inject(viewerKey); if (!store) throw new Error('Viewer store is missing'); return store; }
export { threadTitle };
