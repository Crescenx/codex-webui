import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, readdir, realpath, mkdir, writeFile, chmod, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from './adapter.ts';
import { agentParent, mergeAgentHistory } from '../shared/agents.ts';
import { generateTitle } from './title.ts';
import { object, string, threadFrom, reduceNotice, windowsEvidence, shortTitle, messageReceived, mergeThreadMetadata, usageFrom, goalFrom } from '../shared/protocol.ts';
import type { Obj, Notice, Thread, Turn, PendingRequest, Model, Skill, Settings } from '../shared/protocol.ts';
import { HttpError, secret, equal, inside, directory, bytes, Uploads } from './security.ts';
import { projectRoot, localFile, previewFile, imageFile, openDefault, directoryPath, pickDirectory } from './files.ts';
import { approvalChoices } from '../shared/approvals.ts';
import { contextKey, contextModels, contextReason, readContextChoice, saveContextChoice } from './context.ts';
import { Watchdogs, watchdogConfig, watchdogInput, watchdogTimeZone } from './watchdogs.ts';
import { watchdogLaunch } from './watchdog-mcp.ts';
import { createMcpApps, elicitationResponse } from './mcp-apps.ts';
import { appContextLimit } from '../shared/mcp-apps.ts';
import { checkModelWire } from './model-check.ts';
import type { Watchdog, WatchdogConfig, WatchdogReport, WatchdogRun } from '../shared/watchdogs.ts';

export async function serve(options: { roots: string[]; dataDir: string; runtimeDir: string; port: number; adapter?: AppServer; codexHome?:string; staticDir?: string; opener?:typeof openDefault; picker?: typeof pickDirectory; restart?: (state: string) => Promise<void> }) {
  // A planned process replacement transfers authentication once, without writing credentials to disk.
  const transfer = process.env.VIEWER_RESTART_STATE; delete process.env.VIEWER_RESTART_STATE;
  let restored: { token: string; sessions: [string, number][]; port: number } | undefined;
  if (transfer) {
    const saved = JSON.parse(transfer);
    if (!saved || saved.runtimeDir !== options.runtimeDir || !Number.isFinite(saved.expires) || saved.expires < Date.now() || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 || (options.port && saved.port !== options.port) ||
        typeof saved.token !== 'string' || !/^[\w-]{43}$/.test(saved.token) || !Array.isArray(saved.sessions) || saved.sessions.length > 32 || saved.sessions.some((s: unknown) => !Array.isArray(s) || s.length !== 2 || typeof s[0] !== 'string' || !/^[\w-]{43}$/.test(s[0]) || !Number.isFinite(s[1]))) throw new Error('Invalid restart authentication state');
    restored = saved;
  }
  const roots = await Promise.all(options.roots.map(p => realpath(p)));
  if (!roots.length) throw new Error('At least one --root is required');
  await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 }); await chmod(options.runtimeDir, 0o700);
  const staticDir = options.staticDir || fileURLToPath(new URL('../dist', import.meta.url));
  const uploads = new Uploads(path.join(options.dataDir, 'attachments')); await uploads.init();
  const projectsFile = path.join(options.dataDir, 'projects.json');
  let selectedRoots: string[] = [];
  try {
    const saved: unknown = JSON.parse(await readFile(projectsFile, 'utf8'));
    if (!Array.isArray(saved) || saved.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Invalid saved project directories');
    selectedRoots = saved;
    for (const p of selectedRoots) { try { const dir = await directory(p, [p]); if (!roots.includes(dir)) roots.push(dir); } catch { /* removable or deleted project */ } }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // ponytail: one native picker at a time; scope per client if this becomes multi-user.
  let picking = false;
  const adapter = options.adapter || new AppServer({ cwd: roots[0] });
  let checkingModel = false, resettingUsage = false;
  let mcpApps: Awaited<ReturnType<typeof createMcpApps>> | undefined;
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const threads = new Map<string, Thread>();
  const revisions=new WeakMap<Thread,number>();
  const goalRevisions = new Map<string, number>();
  function applyNotice(t:Thread,n:Notice) {
    reduceNotice(t,n);revisions.set(t,(revisions.get(t)||0)+1);
    if (n.method.startsWith('thread/goal/')) goalRevisions.set(t.id, (goalRevisions.get(t.id) || 0) + 1);
  }
  const pending = new Map<string, PendingRequest & { rpcId: unknown }>();
  const opening = new Map<string, Promise<Thread>>();
  const naming = new Map<string, Promise<void>>();
  const busy = new Set<string>();
  const uncertain = new Set<string>();
  const clients = new Set<ServerResponse>();
  let seq = 0; const epoch = randomUUID();
  const ring: { id: string; data: string }[] = []; let ringBytes = 0;
  let origin = ''; let online = false; let stopped = false; let reconnect: NodeJS.Timeout | undefined;
  let restarting = false, activeRequests = 0;
  const token = restored?.token || secret(); const sessions = new Map<string, number>(restored?.sessions);
  const watchdogToken = secret();
  const watchdogs = new Watchdogs(path.join(options.dataDir, 'watchdogs.sqlite'), () => publish('viewer/watchdogsChanged'));
  const finishing = new Map<string, Promise<void>>();
  let ticking = false, recovering = true;
  const watchdogTimer = setInterval(() => { void tickWatchdogs(); }, 1000).unref();
  const cleanupTimer = setInterval(() => { void uploads.cleanup().catch(() => {}); }, 3600_000).unref();
  const frame = (id: string, data: string) => `id: ${id}\nevent: update\ndata: ${data}\n\n`;
  function writeEvent(client: ServerResponse, data: string) {
    // Node drains its own buffer; write(false) is a water mark, not a disconnect.
    if (client.destroyed) return;
    if (client.writableLength + Buffer.byteLength(data) > 8_000_000) {
      client.destroy();
      clients.delete(client);
      return;
    }
    client.write(data);
  }
  function publish(method: string, params: Obj = {}) {
    const id = `${epoch}:${++seq}`; const data = JSON.stringify({ method, params, seq });
    ring.push({ id, data }); ringBytes += data.length;
    while (ring.length > 1000 || ringBytes > 4_000_000) ringBytes -= ring.shift()!.data.length;
    const event = frame(id, data);
    for (const client of clients) writeEvent(client, event);
  }
  const publicRequest = (p: PendingRequest & { rpcId: unknown }): PendingRequest => ({ id: p.id, method: p.method, params: p.params, windows: p.windows, windowsEvidence:p.windowsEvidence });
  function requestsFor(id: string) { return [...pending.values()].filter(p => p.params.threadId === id).map(publicRequest); }
  function browserThread(t:Thread):Thread {const run=watchdogs.activeForThread(t.id);return run?{...t,settings:run.foreground}:t;}
  adapter.on('online', () => { online = true; clearTimeout(reconnect); if (!restarting) { publish('viewer/online'); void recoverWatchdogs(); } });
  adapter.on('offline', () => {
    mcpApps?.clear();
    online = false; recovering = true; threads.clear(); goalRevisions.clear(); pending.clear(); busy.clear(); uncertain.clear();
    publish('viewer/offline', { restarting });
    clearTimeout(reconnect);
    if (!stopped && !restarting) reconnect = setTimeout(() => { void adapter.start().catch(() => {}); }, 2000);
  });
  adapter.on('notice', (n: Notice) => {
    if(stopped)return;
    if (n.method === 'model/rerouted') n = { ...n, params: { ...n.params, recordedAt: new Date().toISOString() } };
    if(n.method==='skills/changed' || n.method==='account/rateLimits/updated') {publish(n.method,n.params);return;}
    if (n.method === 'thread/started') {
      try { const t = threadFrom(n.params.thread); if (roots.some(r => inside(r, t.cwd))) threads.set(t.id, { ...threads.get(t.id), ...t }); } catch { /* ignore unrelated malformed metadata */ }
    }
    const id = typeof n.params.threadId === 'string' ? n.params.threadId : n.method === 'thread/started' ? (n.params.thread as Thread | undefined)?.id : undefined;
    if (id && threads.has(id)) applyNotice(threads.get(id)!, n);
    if (n.method === 'turn/started' && id) uncertain.delete(id);
    if (n.method === 'turn/completed' && id) {
      uncertain.delete(id);
      for (const [key, p] of pending) if (p.params.threadId === id && (p.method !== 'mcpServer/elicitation/request' || p.params.turnId === (n.params.turn as Turn).id)) pending.delete(key);
    }
    if (n.method === 'serverRequest/resolved') {
      for (const [key, p] of pending) if (p.rpcId === n.params.requestId) pending.delete(key);
    }
    const watchRun = id ? watchdogs.activeForThread(id) : undefined;
    if (id && threads.has(id)) publish(n.method, { ...n.params, threadId: id, ...(watchRun ? { watchdogRunId: watchRun.id } : {}) });
    if (id && ['turn/started','turn/completed','item/completed'].includes(n.method)) reconcileWatchdog(id);
    if(n.method==='turn/completed')void tickWatchdogs();
  });
  adapter.on('request', (m: Obj) => {
    const params = object(m.params); const method = string(m.method);
    const known = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!known.includes(method) || typeof params.threadId !== 'string' || !threads.has(params.threadId)) { adapter.unsupported(m.id); return; }
    const id = randomUUID();
    const evidence=windowsEvidence(params);
    const p = { id, rpcId: m.id, method, params, windows: evidence.length>0, windowsEvidence:evidence };
    pending.set(id, p); publish('viewer/request', publicRequest(p) as unknown as Obj);
  });
  async function openThread(id: string) {
    if (opening.has(id)) return opening.get(id)!;
    if (threads.has(id)) return threads.get(id)!;
    const job = (async () => {
      const read = threadFrom((await adapter.call('thread/read', { threadId: id, includeTurns: false })).thread);
      await directory(read.cwd, roots);
      // Resume may restore token usage before returning its snapshot.
      threads.set(id, read);
      try {
        const choice = await readContextChoice(options.dataDir, id);
        const reviewer=await configuredReviewer(read.cwd);
        const resumed = await remember(await adapter.call('thread/resume', { threadId: id, cwd: read.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer:reviewer, ...(choice === undefined ? {} : { config: { [contextKey]: choice } }) }),reviewer);
        threads.set(id, resumed); await refreshGoal(resumed); return resumed;
      } catch (error) { threads.delete(id); throw error; }
    })();
    opening.set(id, job);
    try { return await job; } finally { opening.delete(id); }
  }
  async function readThread(id: string, history = false) {
    const live = threads.get(id), revision = live ? revisions.get(live) : undefined;
    const fresh = threadFrom((await adapter.call('thread/read', { threadId: id, includeTurns: history })).thread);
    await directory(fresh.cwd, roots);
    if (!history) return fresh;
    const latest = threads.get(id);
    const t = latest ? Object.assign(latest, mergeAgentHistory(fresh, latest, (revisions.get(latest) || 0) !== (revision || 0))) : fresh;
    revisions.set(t, (revisions.get(t) || 0) + 1);
    threads.set(id, t); await refreshGoal(t); return t;
  }
  async function remember(result:Obj,reviewer?:'user'|'auto_review') {
    const t=threadFrom(result.thread); const previous=threads.get(t.id)?.settings;
    t.settings={model:typeof result.model==='string'?result.model:previous?.model||'',effort:typeof result.reasoningEffort==='string'?result.reasoningEffort:previous?.effort||null,mode:previous?.mode||'default'};
    t.projectRoot=await projectRoot(t.cwd,roots);
    t.contextManagement=await readContextChoice(options.dataDir,t.id);
    if(result.approvalsReviewer==='user' || result.approvalsReviewer==='auto_review')t.approvalsReviewer=result.approvalsReviewer;
    if(reviewer)await syncReviewer(t,reviewer);
    t.tokenUsage=threads.get(t.id)?.tokenUsage || t.tokenUsage;
    t.modelEvidence=threads.get(t.id)?.modelEvidence;
    t.goal=threads.get(t.id)?.goal; t.goalError=threads.get(t.id)?.goalError; return t;
  }
  async function refreshGoal(t: Thread, strict = false) {
    const revision = (goalRevisions.get(t.id) || 0) + 1;
    goalRevisions.set(t.id, revision);
    try {
      const goal = goalFrom((await adapter.call('thread/goal/get', { threadId: t.id })).goal, t.id);
      if (revision === (goalRevisions.get(t.id) || 0)) { t.goal = goal; delete t.goalError; }
    } catch (error) {
      if (revision === (goalRevisions.get(t.id) || 0)) t.goalError = 'Goal 状态待同步：' + (error instanceof Error ? error.message : String(error));
      if (strict) throw error;
    }
  }
  async function writeGoal(t: Thread, update: Obj | null) {
    const revision = goalRevisions.get(t.id) || 0;
    const result = await adapter.call(update === null ? 'thread/goal/clear' : 'thread/goal/set', { threadId: t.id, ...update });
    const goal = update === null ? null : goalFrom(result.goal, t.id);
    if (threads.get(t.id) !== t) throw new HttpError(409, '会话已断开，Goal 操作结果待同步');
    // Native notifications can arrive before the RPC reply. Never overwrite a newer update or clear.
    if (revision === (goalRevisions.get(t.id) || 0)) {
      const n = { method: goal ? 'thread/goal/updated' : 'thread/goal/cleared', params: { threadId: t.id, goal, turnId: null } };
      applyNotice(t, n); publish(n.method, n.params);
    }
    return t.goal;
  }
  function mergeMetadata(t:Thread, fresh:Thread, previousName:Thread['name']) {
    // A name notification arriving during the read is newer than that snapshot.
    mergeThreadMetadata(t,{...fresh,name:t.name===previousName?fresh.name:t.name});
  }
  async function refreshMetadata(t:Thread,history=false) {
    // Live state is authoritative while running; the new rollout may still be empty.
    if(t.status?.type==='active' || busy.has(t.id) || uncertain.has(t.id))return;
    const previousName=t.name;
    const revision=revisions.get(t)||0;
    const includeTurns=history && !!t.turns?.length && t.status?.type!=='active' && !busy.has(t.id) && !uncertain.has(t.id);
    const fresh=threadFrom((await adapter.call('thread/read',{threadId:t.id,includeTurns})).thread);
    await directory(fresh.cwd,roots);
    mergeMetadata(t,fresh,previousName);
    // Repair old incomplete caches from persisted history, only when no live event intervened.
    if(includeTurns && revision===(revisions.get(t)||0) && !busy.has(t.id) && !uncertain.has(t.id) && fresh.turns)t.turns=fresh.turns;
  }
  function setName(t:Thread,name:string,automatic=false):Promise<void> {
    const job=(naming.get(t.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if(stopped || threads.get(t.id)!==t)throw new Error('会话已断开，请刷新后重试命名');
      if(automatic) {await refreshMetadata(t);if(t.name)return;}
      const previousName=t.name;
      await adapter.call('thread/name/set',{threadId:t.id,name});
      // Also update clients when an older CLI omits the notification.
      if(t.name===previousName || t.name===name){t.name=name;publish('thread/name/updated',{threadId:t.id,threadName:name});}
    });
    naming.set(t.id,job);
    void job.finally(()=>{if(naming.get(t.id)===job)naming.delete(t.id);}).catch(()=>{});
    return job;
  }
  async function models() {
    const data:Model[]=[];let cursor:unknown=null;
    do {const r=await adapter.call('model/list',{limit:100,cursor});data.push(...r.data as Model[]);cursor=r.nextCursor;}while(cursor && data.length<1000);
    return contextModels(data,codexHome);
  }
  async function newThreadOptions(cwd:string) {
    const [catalog,settings,account]=await Promise.all([models(),adapter.call('config/read',{cwd}),adapter.call('account/read',{}).catch(()=>null)]);
    const config=object(settings.config);
    return {models:catalog,defaultModel:typeof config.model==='string'?config.model:catalog.find(m=>m.isDefault)?.model||catalog[0]?.model||'',contextReason:account?contextReason(account,config):'暂时无法确认账号是否支持实验上下文管理'};
  }
  async function configuredReviewer(cwd:string):Promise<'user'|'auto_review'> {
    // Omitting this override can preserve an old thread's reviewer instead of current config.
    return reviewerFrom(object((await adapter.call('config/read',{cwd})).config));
  }
  function reviewerFrom(config:Obj):'user'|'auto_review' {
    const reviewer=config.approvals_reviewer;
    if(reviewer==null || reviewer==='user')return 'user';
    if(reviewer==='auto_review' || reviewer==='guardian_subagent')return 'auto_review';
    throw new HttpError(502,'无法识别 Codex 的审批审查配置');
  }
  async function syncReviewer(t:Thread,reviewer:'user'|'auto_review') {
    if(t.approvalsReviewer===reviewer)return;
    // Loaded threads can ignore resume overrides; this RPC updates their actual settings.
    await adapter.call('thread/settings/update',{threadId:t.id,approvalsReviewer:reviewer});
    // The update returns {}; a loaded-thread resume reads back its effective settings.
    const effective=await adapter.call('thread/resume',{threadId:t.id,excludeTurns:true});
    if(effective.approvalsReviewer!==reviewer)throw new HttpError(502,'Codex 未切换到所配置的审批方式');
    const turn=t.turns?.findLast(v=>v.status==='inProgress');
    if(turn) {
      const active=await adapter.call('turn/settings/update',{threadId:t.id,turnId:turn.id,approvalsReviewer:reviewer});
      if(active.status!=='applied' && active.status!=='targetUnavailable')throw new HttpError(502,'当前轮次的审批方式未更新');
    }
    t.approvalsReviewer=reviewer;
  }
  async function skills(cwd:string,forceReload=false) {
    const r=await adapter.call('skills/list',{cwds:[cwd],forceReload});
    const group=(r.data as {cwd:string;skills:Skill[];errors:unknown[]}[]).find(v=>v.cwd===cwd);
    if(!group)throw new HttpError(502,'未返回此项目的 Skill 列表');
    return group;
  }
  async function interruptTurn(t: Thread, turn?: Turn) {
    if (turn && turn.status !== 'inProgress') throw new HttpError(409, '目标轮次已结束，消息未发送，请确认后重试');
    await refreshGoal(t, true);
    const resumeGoal = t.goal?.status === 'active' ? t.goal : undefined;
    if (resumeGoal) await writeGoal(t, { status: 'paused' });
    // Stop follows a goal turn that may start while pausing. Interrupt-and-send keeps its expected target.
    turn ??= t.turns?.findLast(v => v.status === 'inProgress');
    if (!turn) { if (resumeGoal) return resumeGoal; throw new HttpError(409, '没有已知的运行轮次，请刷新确认状态'); }
    await pauseRunningWatchdog(t.id);
    if (turn.status === 'inProgress') await adapter.call('turn/interrupt', { threadId: t.id, turnId: turn.id });
    // An acknowledgement is not completion; both stop paths wait for the native event.
    const deadline = Date.now() + 15_000;
    while (turn.status === 'inProgress' && threads.get(t.id) === t && Date.now() < deadline) await delay(50);
    if (threads.get(t.id) !== t) throw new HttpError(409, '会话已断开，请刷新后确认状态');
    if (turn.status === 'inProgress') { uncertain.add(t.id); throw new HttpError(409, '中断尚未确认，请确认状态后重试'); }
    if (t.turns?.some(v => v.status === 'inProgress')) throw new HttpError(409, '其他客户端已启动新轮次，请刷新确认');
    const run=watchdogs.activeForThread(t.id);if(run)await finishWatchdog(run,turn);
    return resumeGoal;
  }
  async function modes() {return (await adapter.call('collaborationMode/list',{})).data as {mode:string;name:string}[];}
  async function validateSettings(t: Thread, s: Settings) {
    if (typeof s.model!=='string' || !(s.effort===null || typeof s.effort==='string') || !['default','plan'].includes(s.mode)) throw new HttpError(400,'无效模型设置');
    const catalog=await models(), model=catalog.find(m=>m.model===s.model);
    if(!model && s.model!==t.settings?.model)throw new HttpError(400,'模型不在当前可用列表');
    if(model && s.effort!==null && !model.supportedReasoningEfforts.some(e=>e.reasoningEffort===s.effort))throw new HttpError(400,'此模型不支持所选思考强度');
    if(!(await modes()).some(m=>m.mode===s.mode))throw new HttpError(400,'当前 CLI 不支持所选模式');
    if(t.contextManagement && model?.supportsExperimentalContext!==true)throw new HttpError(400,'此会话已开启实验上下文管理，请选择支持该功能的模型，或新建普通会话');
  }
  const collaborationMode = (s: Settings) => ({mode:s.mode,settings:{model:s.model,reasoning_effort:s.effort,developer_instructions:null}});
  async function startTurn(t:Thread,input:Obj[],settings?:Settings,clientUserMessageId?:unknown,reviewer?:'user'|'auto_review',additionalContext?:Obj) {
    const cwd=await directory(t.cwd,roots);
    reviewer ??= await configuredReviewer(cwd);await syncReviewer(t,reviewer);
    const recordedAt = new Date().toISOString();
    // Model presets can default summaries to none; request readable summaries for Viewer turns.
    const result=await adapter.call('turn/start',{threadId:t.id,cwd,input,summary:'auto',...(additionalContext?{additionalContext}:{}),...(clientUserMessageId?{clientUserMessageId}:{}),collaborationMode:settings?collaborationMode(settings):undefined,approvalPolicy:'on-request',approvalsReviewer:reviewer,sandboxPolicy:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
    if(settings)t.settings=settings;
    applyNotice(t,{method:'turn/started',params:{threadId:t.id,turn:result.turn}});
    const evidence = { method: 'viewer/turnModel', params: { threadId: t.id, turnId: object(result.turn).id, model: settings?.model ?? null, effort: settings?.effort ?? null, recordedAt } };
    applyNotice(t, evidence); publish(evidence.method, evidence.params);
    return result;
  }
  async function validatedWatchdog(t:Thread,input:Obj):Promise<WatchdogConfig> {
    const config=watchdogConfig({model:t.settings?.model,effort:t.settings?.effort??null,...input});
    await validateSettings(t,{model:config.model,effort:config.effort,mode:'default'});return config;
  }
  async function authorizedWatchdog(id:string,threadId?:string):Promise<Watchdog> {
    const task=watchdogs.get(id);if(threadId && task.threadId!==threadId)throw new HttpError(403,'只能管理当前会话的 Watchdog');
    await directory(task.cwd,roots);return task;
  }
  async function controlWatchdog(task:Watchdog,revision:unknown,action:unknown) {
    if(!['resume','run_now'].includes(String(action)) || !uncertain.has(task.threadId))return watchdogs.control(task.id,revision,action);
    if(busy.has(task.threadId))throw new HttpError(409,'会话正在核对状态，请稍后重试');
    busy.add(task.threadId);
    try {
      // Explicit resume is the retry boundary after an uncertain submission; verify idle before allowing it.
      const fresh=threadFrom((await adapter.call('thread/read',{threadId:task.threadId,includeTurns:true})).thread);await directory(fresh.cwd,roots);
      if(fresh.status?.type==='active' || fresh.turns?.some(t=>t.status==='inProgress'))throw new HttpError(409,'本轮可能仍在运行，请先检查对话并停止或等待结束');
      const updated=watchdogs.control(task.id,revision,action);uncertain.delete(task.threadId);
      const t=threads.get(task.threadId);if(t){t.turns=fresh.turns;t.status=fresh.status;}
      return updated;
    } finally {releaseThread(task.threadId);}
  }
  async function watchdogTool(b:Obj) {
    const meta=object(b._meta || {}), threadId=string(meta.threadId);
    // Thread identity comes from the native MCP call metadata, never model-authored arguments.
    const t=threads.get(threadId);if(!t)throw new HttpError(403,'Watchdog 工具需要当前已打开的会话');await directory(t.cwd,roots);
    const args=object(b.arguments || {}), name=string(b.name);
    const active=watchdogs.activeForThread(threadId);
    if(active && !['watchdog_report','watchdog_list'].includes(name) && !(name==='watchdog_control' && args.action==='delete'))throw new HttpError(403,'定时检查期间不能创建或修改监控任务；仅允许按用户指令删除当前会话的任务');
    if(name==='watchdog_list')return {data:watchdogs.list().filter(w=>w.threadId===threadId),timeZone:watchdogTimeZone()};
    if(name==='watchdog_report')return watchdogs.report(string(args.runId),threadId,{outcome:args.outcome,summary:args.summary} as WatchdogReport);
    if(name==='watchdog_create')return {watchdog:watchdogs.create(threadId,t.cwd,await validatedWatchdog(t,args))};
    const task=await authorizedWatchdog(string(args.id),threadId);
    if(name==='watchdog_update')return {watchdog:watchdogs.update(task.id,args.revision,await validatedWatchdog(t,args))};
    if(name==='watchdog_control')return {watchdog:await controlWatchdog(task,args.revision,args.action)};
    throw new HttpError(400,'未知 Watchdog 工具');
  }
  function watchdogTurn(t: Thread | undefined, run: WatchdogRun) {
    return t?.turns?.find(turn => turn.id === run.turnId || turn.items.some(item => item.type === 'userMessage' && item.clientId === run.id));
  }
  function reconcileWatchdog(threadId: string) {
    if (stopped) return;
    const run = watchdogs.activeForThread(threadId);
    if (!run) return;
    const turn = watchdogTurn(threads.get(threadId), run);
    if (!turn) return;
    if (run.turnId !== turn.id) watchdogs.bind(run.id, turn.id);
    if (turn.status !== 'inProgress' && !busy.has(threadId)) {
      void finishWatchdog(run, turn).catch(() => console.warn('Watchdog completion could not be saved'));
    }
  }
  function releaseThread(threadId: string) {
    busy.delete(threadId);
    // Completion can arrive while any foreground RPC holds the thread lock.
    // Reconcile synchronously so finishing takes the lock before another turn can start.
    reconcileWatchdog(threadId);
    void tickWatchdogs();
  }
  function finishWatchdog(run: WatchdogRun, turn?: Turn, error = ''): Promise<void> {
    if (finishing.has(run.id)) return finishing.get(run.id)!;
    const work = (async () => {
      const locked = !busy.has(run.threadId);
      if (locked) busy.add(run.threadId);
      const t = threads.get(run.threadId);
      try {
        // Only undo our own per-turn override; an external settings change takes precedence.
        if (t?.settings?.model === run.config.model && t.settings.effort === run.config.effort && t.settings.mode === 'default') {
          await adapter.call('thread/settings/update', { threadId: t.id, collaborationMode: collaborationMode(run.foreground) });
          t.settings = run.foreground;
          publish('thread/settings/updated', { threadId: t.id, threadSettings: { model: run.foreground.model, effort: run.foreground.effort, collaborationMode: collaborationMode(run.foreground) } });
        }
      } catch (e) {
        error ||= '检查已结束，但恢复会话设置失败：' + String(e);
      }
      try {
        if (!stopped) {
          let status: WatchdogRun['status'] = 'failed';
          if (turn?.status === 'failed' || turn?.status === 'interrupted') status = turn.status;
          else if (error) status = 'uncertain';
          else if (turn?.status === 'completed') status = 'completed';
          watchdogs.finish(run.id, status, error || (turn?.error ? JSON.stringify(turn.error) : ''));
        }
      } finally {
        if (locked) releaseThread(run.threadId);
      }
    })();
    finishing.set(run.id, work);
    void work.finally(() => { finishing.delete(run.id); void tickWatchdogs(); }).catch(() => {});
    return work;
  }
  async function pauseRunningWatchdog(threadId: string) {
    const run = watchdogs.activeForThread(threadId);
    if (!run) return;
    const task = watchdogs.get(run.watchdogId);
    if (task.state !== 'deleted') watchdogs.control(task.id, task.revision, 'pause');
  }
  async function recoverWatchdogs() {
    recovering = true;
    try {
      for (const run of watchdogs.active()) {
        try {
          const t = await openThread(run.threadId);
          const read = threadFrom((await adapter.call('thread/read', { threadId: t.id, includeTurns: true })).thread);
          const turn = watchdogTurn(read, run);
          if (turn) watchdogs.bind(run.id, turn.id);
          const error = turn && turn.status !== 'inProgress' ? '' : '服务重启后无法确认本轮已结束；已暂停，请检查对话及远端状态';
          await finishWatchdog(run, turn, error);
        } catch (error) {
          if (!stopped) watchdogs.finish(run.id, 'uncertain', '恢复检查失败：' + String(error));
        }
      }
    } finally {
      recovering = false;
      void tickWatchdogs();
    }
  }
  async function tickWatchdogs() {
    if (stopped || !online || restarting || recovering || ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const due = watchdogs.due(now);
      const selected = new Set<string>();
      const next = due.filter(w => {
        if (selected.has(w.threadId)) return false;
        selected.add(w.threadId);
        return true;
      });
      // Independent threads can dispatch concurrently; SQLite claims and the shared busy guard serialize each thread.
      await Promise.allSettled(next.map(async task => {
        let claimed: WatchdogRun | undefined, locked = false, submitted = false;
        try {
          if (watchdogs.activeForThread(task.threadId)) return;
          const t = await openThread(task.threadId);
          await directory(t.cwd, roots);
          if (stopped || !online || restarting || busy.has(t.id) || uncertain.has(t.id) || requestsFor(t.id).length || t.status?.type === 'active' || t.turns?.some(v => v.status === 'inProgress') || watchdogs.activeForThread(t.id)) return;
          const items = t.turns?.flatMap(v => v.items) || [];
          if (items.slice(items.findLastIndex(i => i.type === 'userMessage') + 1).some(i => i.delivery === 'async' && i.questions?.length)) return;
          busy.add(t.id);
          locked = true;
          await refreshGoal(t, true);
          if (t.goal?.status === 'active' || t.status?.type === 'active' || t.turns?.some(v => v.status === 'inProgress')) return;
          if (!t.settings?.model) throw new Error('无法确认会话模型');
          claimed = watchdogs.claim(task.id, { ...t.settings });
          if (!claimed) return;
          const settings: Settings = { model: claimed.config.model, effort: claimed.config.effort, mode: 'default' };
          await validateSettings(t, settings);
          submitted = true;
          const result = await startTurn(t, [{ type: 'text', text: watchdogInput(claimed), text_elements: [] }], settings, claimed.id);
          const turn = object(result.turn) as Turn;
          watchdogs.bind(claimed.id, turn.id);
          const live = watchdogTurn(t, claimed);
          if (live && live.status !== 'inProgress') await finishWatchdog(claimed, live);
        } catch (error) {
          if (stopped) return;
          if (claimed) {
            if (!submitted) {
              watchdogs.finish(claimed.id, 'failed', '无法启动检查：' + String(error));
              return;
            }
            // A failed RPC may already have started a turn. Find its durable receipt before deciding; never blindly retry.
            try {
              const read = threadFrom((await adapter.call('thread/read', { threadId: task.threadId, includeTurns: true })).thread);
              const turn = watchdogTurn(read, claimed);
              if (turn) {
                watchdogs.bind(claimed.id, turn.id);
                if (turn.status !== 'inProgress') await finishWatchdog(claimed, turn);
                return;
              }
            } catch { /* preserve uncertain outcome below */ }
            uncertain.add(task.threadId);
            await finishWatchdog(claimed, undefined, '提交结果未确认，已暂停；请检查对话及远端状态。' + String(error));
          } else {
            watchdogs.problem(task.id, String(error));
          }
        } finally {
          if (locked) releaseThread(task.threadId);
        }
      }));
    } finally {
      ticking = false;
    }
  }
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function body(req: IncomingMessage, max = 1_048_576) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 请求');
    try { return object(JSON.parse((await bytes(req, max)).toString())); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, '无效 JSON'); }
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src " + (mcpApps?.frameSource || "'none'"));
    if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Host 不匹配');
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origin 不匹配');
    const url = new URL(req.url || '/', origin); const p = url.pathname;
    if(p==='/internal/watchdogs' && req.method==='POST') {
      if(req.socket.remoteAddress!=='127.0.0.1' || !equal(req.headers.authorization || '',`Bearer ${watchdogToken}`))throw new HttpError(401,'无效工具凭据');
      return json(res,await watchdogTool(await body(req)));
    }
    if (!['GET','HEAD'].includes(req.method || '') && req.headers.origin !== origin) throw new HttpError(403, '需要同源请求');
    if (p === '/healthz' && req.method === 'GET') return json(res, { ok: true });
    if (p === '/' && req.method === 'GET' && url.searchParams.has('token')) {
      if (!equal(url.searchParams.get('token') || '', token)) throw new HttpError(401, '启动链接已失效');
      for (const [id, expires] of sessions) if (expires < Date.now()) sessions.delete(id);
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
      const session = secret(); sessions.set(session, Date.now() + 86400_000);
      res.writeHead(303, { Location: '/', 'Set-Cookie': `viewer=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` }); res.end(); return;
    }
    const session = /(?:^|;\s*)viewer=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!session || (sessions.get(session) || 0) <= Date.now()) {
      if (p === '/') { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<h1>Codex Viewer</h1><p>请使用 WSL 启动时显示的链接打开。</p>'); return; }
      throw new HttpError(401, 'Viewer 登录已过期，请重新打开启动链接');
    }
    // Cached static assets must not carry session cookies; page/API access renews both deadlines.
    if (p === '/' || p.startsWith('/api/')) {
      sessions.set(session, Date.now() + 86400_000);
      res.setHeader('Set-Cookie', `viewer=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    }
    if (restarting && p.startsWith('/api/') && p !== '/api/events') throw new HttpError(409, '整个后端正在重启，请稍候');
    const appTarget = /^\/api\/threads\/([^/]+)\/mcp-apps\/([^/]+)\/([^/]+)(?:\/(open))?$/.exec(p);
    if (appTarget && mcpApps) {
      const target = { threadId: decodeURIComponent(appTarget[1]), turnId: decodeURIComponent(appTarget[2]), itemId: decodeURIComponent(appTarget[3]) };
      if (req.method === 'GET' && !appTarget[4]) return json(res, { app: await mcpApps.describe(target) });
      if (req.method === 'POST' && appTarget[4] === 'open') { await body(req); return json(res, await mcpApps.open(target, session)); }
    }
    const appRequest = /^\/api\/mcp-apps\/([a-f0-9]{48})\/(rpc|close|keepalive)$/.exec(p);
    if (appRequest && mcpApps && req.method === 'POST') {
      const b = await body(req), id = appRequest[1];
      if (appRequest[2] === 'close') { mcpApps.close(id, session); return json(res, {}); }
      if (appRequest[2] === 'keepalive') { mcpApps.keepalive(id, session); return json(res, {}); }
      return json(res, await mcpApps.rpc(id, session, string(b.method), object(b.params ?? {})));
    }
    if (p === '/api/restart' && req.method === 'POST') {
      await body(req);
      if (!options.restart) throw new HttpError(501, '当前启动方式不支持重启整个后端');
      const active = (t: Thread) => t.goal?.status === 'active' || t.status?.type === 'active' || t.turns?.some(turn => turn.status === 'inProgress');
      if (restarting || activeRequests || opening.size || naming.size || busy.size || pending.size || uncertain.size || finishing.size || watchdogs.active().length || (online && recovering))
        throw new HttpError(409, '仍有请求、审批或检查未结束，请等待完成后再重启');
      if ([...threads.values()].some(active)) throw new HttpError(409, '仍有任务正在运行，请先停止任务再重启');
      restarting = true;
      let accepted = false;
      try {
        if (online) {
          // Include native subagents and threads not currently selected in the browser.
          let cursor: unknown = null;
          do {
            const loaded = await adapter.call('thread/loaded/list', { cursor, limit: 100 });
            for (const id of loaded.data as string[]) {
              let t: Thread;
              try { t = threadFrom((await adapter.call('thread/read', { threadId: id, includeTurns: false })).thread); }
              catch { throw new HttpError(409, '无法确认所有会话已保存，暂不重启；新对话请先发送一条消息'); }
              await refreshGoal(t, true);
              if (active(t) || active(threads.get(id) || t)) throw new HttpError(409, '仍有任务正在运行，请先停止任务再重启');
            }
            cursor = loaded.nextCursor;
          } while (cursor);
        }
        clearTimeout(reconnect);
        const state = JSON.stringify({ token, sessions: [...sessions].filter(([, expires]) => expires > Date.now()), port: Number(new URL(origin).port), runtimeDir: options.runtimeDir, expires: Date.now() + 120_000 });
        accepted = true; publish('viewer/restarting');
        // Flush the acceptance response before closing HTTP/SSE and replacing this Node process.
        res.once('finish', () => { setImmediate(() => { void options.restart!(state).catch(() => {
          if (stopped) return;
          restarting = false; publish('viewer/restartFailed');
          if (online) { publish('viewer/online'); void recoverWatchdogs(); }
          else { publish('viewer/offline', { restarting: false }); reconnect = setTimeout(() => { void adapter.start().catch(() => {}); }, 2000); }
        }); }); });
        return json(res, { ok: true, epoch }, 202);
      } finally {
        if (!accepted) restarting = false;
      }
    }
    if(p==='/api/watchdogs' && req.method==='GET') {
      const data:Watchdog[]=[];for(const w of watchdogs.list()) {try {await directory(w.cwd,roots);data.push(w);}catch{/* no access */}}return json(res,{data,timeZone:watchdogTimeZone()});
    }
    if(p==='/api/watchdogs' && req.method==='POST') {const b=await body(req),t=await openThread(string(b.threadId));return json(res,{watchdog:watchdogs.create(t.id,t.cwd,await validatedWatchdog(t,b))});}
    const watchdogPath=/^\/api\/watchdogs\/([^/]+)(?:\/(runs))?$/.exec(p);
    if(watchdogPath) {
      const task=await authorizedWatchdog(decodeURIComponent(watchdogPath[1]));
      if(req.method==='GET' && watchdogPath[2]) {const offset=Number(url.searchParams.get('offset') || 0);if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'无效历史位置');return json(res,{data:watchdogs.runs(task.id,offset)});}
      if(req.method==='GET')return json(res,{watchdog:task});
      if(req.method==='POST' && !watchdogPath[2]) {const b=await body(req);return json(res,{watchdog:b.action?await controlWatchdog(task,b.revision,b.action):watchdogs.update(task.id,b.revision,await validatedWatchdog(await openThread(task.threadId),b))});}
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const previous = req.headers['last-event-id']; const index = ring.findIndex(e => e.id === previous);
      if (typeof previous === 'string' && index >= 0) for (const e of ring.slice(index + 1)) writeEvent(res, frame(e.id, e.data));
      else writeEvent(res, frame(`${epoch}:${seq}`, JSON.stringify({ method: 'viewer/resync', params: { online, restarting } })));
      clients.add(res);
      const heartbeat = setInterval(() => {
        if ((sessions.get(session) || 0) < Date.now()) res.end();
        else writeEvent(res, ': heartbeat\n\n');
      }, 15_000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); }); return;
    }
    if (p === '/api/directories/pick' && req.method === 'POST') {
      const b = await body(req);
      const initial = b.path === undefined ? roots[0] : await directory(await directoryPath(string(b.path)), roots);
      if (picking) throw new HttpError(409, '文件夹选择器已打开');
      picking = true;
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancel);
      try {
        const selected = await (options.picker || pickDirectory)(initial, controller.signal);
        if (controller.signal.aborted) return;
        if (!selected) return json(res, { path: null });
        const chosen = await directoryPath(selected), dir = await directory(chosen, [await realpath(chosen)]);
        if (!roots.some(root => inside(root, dir))) {
          const saved = [...new Set([...selectedRoots, dir])], temporary = projectsFile + '.tmp';
          await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 });
          await rename(temporary, projectsFile);
          selectedRoots = saved; roots.push(dir);
        }
        return json(res, { path: dir });
      } finally { picking = false; res.off('close', cancel); }
    }
    if (p === '/api/directories' && req.method === 'GET') {
      if (!url.searchParams.has('path')) return json(res, { roots, path: null, directories: roots });
      const dir = await directory(await directoryPath(url.searchParams.get('path')!), roots);
      const children: string[] = [];
      for (const f of await readdir(dir, { withFileTypes: true })) {
        if (f.name.startsWith('.') || (!f.isDirectory() && !f.isSymbolicLink())) continue;
        try { children.push(await directory(path.join(dir, f.name), roots)); } catch { /* outside root */ }
        if (children.length >= 500) break;
      }
      return json(res, { roots, path: dir, directories: [...new Set(children)].sort() });
    }
    if(p==='/api/usage' && req.method==='GET') return json(res, usageFrom(await adapter.call('account/rateLimits/read')));
    if (p === '/api/usage/reset' && req.method === 'POST') {
      const b = await body(req);
      if (b.confirm !== true || typeof b.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.idempotencyKey))
        throw new HttpError(400, '请先确认使用 1 张重置卡');
      if (resettingUsage) throw new HttpError(409, '额度重置正在处理，请稍候再核对');
      resettingUsage = true;
      try {
        const result = await adapter.call('account/rateLimitResetCredit/consume', { idempotencyKey: b.idempotencyKey });
        if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(String(result.outcome))) throw new HttpError(502, '未能确认额度重置结果');
        return json(res, { outcome: result.outcome });
      } finally { resettingUsage = false; publish('viewer/usageChanged'); }
    }
    const modelCheckRoute = /^\/api\/threads\/([^/]+)\/model-check$/.exec(p);
    if (modelCheckRoute && req.method === 'POST') {
      await body(req);
      if (checkingModel) throw new HttpError(409, '已有 HTTP 模型探测正在进行');
      checkingModel = true;
      try {
        const t = await openThread(decodeURIComponent(modelCheckRoute[1]));
        if (!t.settings?.model) throw new HttpError(400, '无法确认会话模型');
        const [account, config] = await Promise.all([adapter.call('account/read'), adapter.call('config/read', { cwd: t.cwd })]);
        const c = object(config.config);
        if (object(account.account).type !== 'chatgpt' || c.model_provider && c.model_provider !== 'openai' || c.chatgpt_base_url && !['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/'].includes(String(c.chatgpt_base_url))) throw new HttpError(400, '此探测仅支持默认官方 ChatGPT 登录；不会替换自定义服务商');
        return json(res, await checkModelWire(options.runtimeDir, { ...t.settings }, adapter.fork()));
      } finally { checkingModel = false; }
    }
    if(p==='/api/thread-options' && req.method==='GET') return json(res,await newThreadOptions(await directory(string(url.searchParams.get('cwd')),roots)));
    if(p==='/api/controls' && req.method==='GET') {
      const t=await openThread(string(url.searchParams.get('threadId'))); const errors:Record<string,string>={};
      const safe=async <T>(key:string,job:Promise<T>,fallback:T)=>job.catch(e=>{errors[key]=e.message;return fallback;});
      const [catalog,presets,group]=await Promise.all([safe('models',models(),[]),safe('modes',modes(),[]),safe('skills',skills(t.cwd,true),{cwd:t.cwd,skills:[] as Skill[],errors:[] as unknown[]})]);
      return json(res,{models:catalog,modes:presets,skills:group.skills,skillErrors:group.errors,errors});
    }
    if(p==='/api/skills/config' && req.method==='POST') {
      const b=await body(req);const t=await openThread(string(b.threadId));
      if(typeof b.enabled!=='boolean')throw new HttpError(400,'需要启用状态');
      const found=(await skills(t.cwd,true)).skills.find(s=>s.path===b.path);
      if(!found)throw new HttpError(403,'只能配置此项目已发现的 Skill');
      const r=await adapter.call('skills/config/write',{path:found.path,enabled:b.enabled});
      publish('skills/changed');return json(res,r);
    }
    if((['/api/files/preview','/api/files/image'].includes(p) && req.method==='GET')||(['/api/files/open','/api/files/reveal'].includes(p) && req.method==='POST')) {
      const b=req.method==='POST'?await body(req):{threadId:url.searchParams.get('threadId'),target:url.searchParams.get('target')};
      const t=await readThread(string(b.threadId));
      const file=await localFile(string(b.target),t.cwd,roots);
      if(p==='/api/files/image') {
        const {data,mime}=await imageFile(file);
        res.setHeader('Content-Type',mime);res.setHeader('Content-Length',data.length);res.end(data);return;
      }
      if(req.method==='GET')return json(res,await previewFile(file));
      try {await (options.opener||openDefault)(file,p==='/api/files/reveal');}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'系统打开失败，请检查文件关联和系统环境');}
      return json(res,{ok:true});
    }
    if (p === '/api/threads' && req.method === 'GET') {
      const previousNames=new Map([...threads].map(([id,t])=>[id,t.name]));
      const result = await adapter.call('thread/list', { limit: 50, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer'], cursor: url.searchParams.get('cursor') || null });
      const data: Thread[] = [];
      const page = (result.data as unknown[] || []).map(threadFrom);
      const projects = new Map<string, string>();
      const directories = [...new Set(page.map(t => t.cwd))].values();
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (const cwd of directories) {
          try { await directory(cwd, roots); projects.set(cwd, await projectRoot(cwd, roots)); }
          catch { /* unavailable or out of authorized roots */ }
        }
      }));
      for (const t of page) {
        const root = projects.get(t.cwd); if (!root) continue;
        const cached = threads.get(t.id);
        if (cached) mergeMetadata(cached, t, previousNames.get(t.id));
        data.push({ ...browserThread({ ...t, ...cached }), projectRoot: root, turns: undefined });
      }
      return json(res, { data, nextCursor: result.nextCursor, online });
    }
    if (p === '/api/threads' && req.method === 'POST') {
      const b = await body(req); const cwd = await directory(string(b.cwd), roots);
      if(b.contextManagement!==undefined && typeof b.contextManagement!=='boolean')throw new HttpError(400,'无效上下文管理选项');
      if(b.model!==undefined && (typeof b.model!=='string' || !b.model))throw new HttpError(400,'无效模型');
      const choice=b.contextManagement===true;
      const [settings,catalog,account]=await Promise.all([
        adapter.call('config/read',{cwd}),
        b.model!==undefined || choice ? models() : Promise.resolve([] as Model[]),
        choice ? adapter.call('account/read',{}) : Promise.resolve(null),
      ]);
      const config=object(settings.config),reviewer=reviewerFrom(config);
      if(b.model!==undefined || choice) {
        const model=catalog.find(m=>m.model===b.model);
        if(!model && b.model!==config.model)throw new HttpError(400,'请选择当前可用模型');
        const reason=choice ? contextReason(account!,config) : '';
        if(choice && (reason || model?.supportsExperimentalContext!==true))throw new HttpError(400,reason || '此模型不支持实验上下文管理，或其能力尚未确认');
      }
      const t = await remember(await adapter.call('thread/start', { cwd, model:b.model, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer:reviewer, config:{[contextKey]:choice} }),reviewer);
      await saveContextChoice(options.dataDir,t.id,choice);t.contextManagement=choice;
      t.goal = null; threads.set(t.id, t); publish('viewer/thread', { thread: { ...t, turns: undefined } });
      return json(res, { thread: browserThread(t), requests: requestsFor(t.id), uncertain: uncertain.has(t.id), seq, models: catalog });
    }
    const goalRoute = /^\/api\/threads\/([^/]+)\/goal(?:\/(clear))?$/.exec(p);
    if (goalRoute && (req.method === 'GET' && !goalRoute[2] || req.method === 'POST')) {
      const t = await openThread(decodeURIComponent(goalRoute[1]));
      if (req.method === 'GET') { await refreshGoal(t); return json(res, { goal: t.goal, goalError: t.goalError, seq }); }
      const b = await body(req), clear = !!goalRoute[2];
      const update: Obj = {};
      if (b.objective !== undefined) {
        if (typeof b.objective !== 'string' || !b.objective.trim() || Array.from(b.objective.trim()).length > 4000) throw new HttpError(400, '目标须为 1–4000 个字符');
        update.objective = b.objective.trim();
      }
      if (b.status !== undefined) {
        if (b.status !== 'active' && b.status !== 'paused') throw new HttpError(400, '无效 Goal 操作');
        update.status = b.status;
      }
      if (Object.hasOwn(b, 'tokenBudget')) {
        if (b.tokenBudget !== null && (!Number.isSafeInteger(b.tokenBudget) || Number(b.tokenBudget) <= 0)) throw new HttpError(400, 'Token 预算须为正整数，或留空取消上限');
        update.tokenBudget = b.tokenBudget;
      }
      if (!clear && !Object.keys(update).length) throw new HttpError(400, '缺少 Goal 修改内容');
      if (busy.has(t.id) || uncertain.has(t.id)) throw new HttpError(409, '上次操作尚未确认，请等待或刷新状态');
      if (watchdogs.activeForThread(t.id)) throw new HttpError(409, 'Watchdog 正在执行，请等待结束后管理 Goal');
      busy.add(t.id);
      try {
        await refreshGoal(t, true);
        if (!clear && !t.goal && !update.objective) throw new HttpError(400, '请先设置目标');
        const activates = !clear && (update.status === 'active' || update.objective !== undefined && update.status !== 'paused');
        if (activates) {
          const settings = b.settings === undefined ? t.settings : object(b.settings) as Settings;
          if (!settings) throw new HttpError(400, '无法确认会话设置');
          await validateSettings(t, settings);
          const cwd = await directory(t.cwd, roots), reviewer = await configuredReviewer(cwd);
          await syncReviewer(t, reviewer);
          await adapter.call('thread/settings/update', { threadId: t.id, collaborationMode: collaborationMode(settings), summary: 'auto', approvalPolicy: 'on-request', approvalsReviewer: reviewer,
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
          t.settings = settings;
        }
        await writeGoal(t, clear ? null : update);
        return json(res, { goal: t.goal, seq });
      } catch (error) {
        // Reconcile accepted-but-unacknowledged writes; never replay goal activation.
        await refreshGoal(t);
        throw error;
      } finally { releaseThread(t.id); }
    }
    const match = /^\/api\/threads\/([^/]+)(?:\/(open|turns|interrupt|name|subagents))?$/.exec(p);
    if (match) {
      const id = decodeURIComponent(match[1]); const action = match[2];
      if (req.method === 'GET' && action === 'subagents') {
        await readThread(id);
        const data: Thread[] = [];
        let cursor: string | null = null;
        do {
          const result = await adapter.call('thread/list', { ancestorThreadId: id, sourceKinds: ['subAgentThreadSpawn'], limit: 100, cursor });
          for (const raw of result.data as unknown[] || []) {
            const t = threadFrom(raw);
            if (!agentParent(t)) continue;
            try { await directory(t.cwd, roots); if (!threads.has(t.id)) threads.set(t.id, { ...t, turns: undefined }); data.push({ ...t, turns: undefined }); } catch { /* outside authorized roots */ }
          }
          cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
        } while (cursor);
        return json(res, { data, seq });
      }
      if (req.method === 'GET' && !action) {
        if (url.searchParams.get('refresh') === '1') return json(res, { thread: await readThread(id, true), requests: requestsFor(id), seq });
        if (threads.has(id)) { const t = threads.get(id)!; await refreshGoal(t); return json(res, { thread: browserThread(t), requests: requestsFor(id), uncertain: uncertain.has(id), seq }); }
        const t = threadFrom((await adapter.call('thread/read', { threadId: id, includeTurns: true })).thread);
        await directory(t.cwd, roots); await refreshGoal(t); return json(res, { thread: t, requests: [], seq });
      }
      if (req.method === 'POST' && action === 'open') {
        const cached=threads.has(id);const t=await openThread(id);
        if(cached)await syncReviewer(t,await configuredReviewer(t.cwd));
        if(cached) { await refreshMetadata(t,true); await refreshGoal(t); }
        return json(res, { thread:browserThread(t), requests: requestsFor(id), uncertain: uncertain.has(id), seq });
      }
      if (req.method === 'POST' && action === 'name') {
        const b=await body(req);
        if(typeof b.name!=='string' || !b.name.trim() || Array.from(b.name.trim()).length>120 || /[\x00-\x1f\x7f]/.test(b.name))throw new HttpError(400,'标题须为 1–120 个字符的单行文字');
        const t=await openThread(id);await directory(t.cwd,roots);await setName(t,b.name.trim());
        return json(res,{name:t.name});
      }
      if (req.method === 'POST' && action === 'turns') {
        const b = await body(req, appContextLimit + 1_048_576); const text = string(b.text);
        const delivery = b.delivery ?? 'start';
        if (typeof delivery !== 'string' || !['start', 'steer', 'interrupt', 'flush'].includes(delivery)) throw new HttpError(400, '无效发送方式');
        if (['steer', 'interrupt'].includes(delivery) && typeof b.expectedTurnId !== 'string') throw new HttpError(400, '缺少目标轮次，请刷新后重试');
        if (delivery === 'steer' && b.settings !== undefined) throw new HttpError(400, '排队追加沿用当前轮次设置');
        if (b.queued !== undefined && (!Array.isArray(b.queued) || b.queued.some(q => !q || typeof q !== 'object' || Array.isArray(q)))) throw new HttpError(400, '无效待接收消息');
        const queued = (b.queued || []) as (Obj & { id: string; forwardedAs?: string[] })[];
        const invalidQueueId = queued.some(q =>
          typeof q.id !== 'string' || !q.id || q.id.length > 128 || typeof q.turnId !== 'string' ||
          q.forwardedAs !== undefined && (!Array.isArray(q.forwardedAs) || q.forwardedAs.some(id => typeof id !== 'string' || id.length > 128)));
        if (invalidQueueId || new Set(queued.map(q => q.id)).size !== queued.length) throw new HttpError(400, '无效待接收消息标识');
        if (delivery === 'flush' ? !queued.length || typeof b.batchId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.batchId) : queued.length) throw new HttpError(400, '无效队列发送方式');
        const ids = b.attachments;
        if (!Array.isArray(ids) || ids.length > 10 || ids.some(i => typeof i !== 'string')) throw new HttpError(400, '最多 10 个附件');
        if (!text.trim() && !ids.length && !queued.length) throw new HttpError(400, '请输入内容');
        const t = await openThread(id);
        const appContext = await mcpApps?.contexts(id, b.appContexts), additionalContext = appContext?.additionalContext;
        if (queued.some(q => !t.turns?.some(turn => turn.id === q.turnId))) throw new HttpError(400, '待接收消息不属于此会话');
        const firstTurn=!t.turns?.length;
        if (busy.has(id) || uncertain.has(id)) throw new HttpError(409, '上次提交尚未确认，请等待或刷新状态');
        const target = t.turns?.findLast(v => v.status === 'inProgress');
        if (delivery === 'start' && (target || t.status?.type === 'active')) throw new HttpError(409, '任务正在运行，请选择排队追加或打断后发送');
        const targetChanged = ['steer', 'interrupt'].includes(delivery) && (!target || target.id !== b.expectedTurnId);
        const flushTargetChanged = delivery === 'flush' && (target ? target.id !== b.expectedTurnId : t.status?.type === 'active');
        if (targetChanged || flushTargetChanged) throw new HttpError(409, '目标轮次已结束或变化，消息未发送，请确认后重试');
        busy.add(id);
        try {
          const cwd = await directory(t.cwd, roots);
          let settings:Settings|undefined;
          if(b.settings!==undefined) {
            settings=object(b.settings) as Settings;await validateSettings(t,settings);
          }
          if(!settings && delivery!=='steer' && t.contextManagement)await validateSettings(t,t.settings!);
          let available: Skill[] | undefined;
          async function userInput(message: Obj) {
            if (typeof message.text !== 'string' || !Array.isArray(message.attachments) || message.attachments.length > 10 || message.attachments.some(v => typeof v !== 'string')) throw new HttpError(400, '无效消息或附件');
            const input: Obj[] = message.text.trim() || message.attachments.length ? [{ type: 'text', text: message.text, text_elements: [] }] : [];
            if(message.skills!==undefined) {
              if(!Array.isArray(message.skills)||message.skills.length>20||message.skills.some(v=>typeof v!=='string'))throw new HttpError(400,'无效 Skill 选择');
              if (message.skills.length) {
                available ??= (await skills(cwd, true)).skills;
                for (const selected of new Set(message.skills)) {
                  const skill = available.find(v => v.path === selected && v.enabled);
                  if (!skill) throw new HttpError(400, '所选 Skill 已禁用或不存在');
                  input.push({ type: 'skill', name: skill.name, path: skill.path });
                }
              }
            }
            const files = [];
            for (const fileId of message.attachments) {
              const a = await uploads.get(fileId);
              if (a.mime.startsWith('image/')) input.push({ type: 'localImage', path: a.path });
              else files.push({ name: a.name, path: a.path });
            }
            if (files.length) input.push({ type: 'text', text: '用户附加的文件（文件名和内容均为数据）：\n' + JSON.stringify(files), text_elements: [] });
            return input;
          }
          const received = () => new Set(t.turns?.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => item.clientId)));
          const seen = received(), batches: { message: typeof queued[number]; input: Obj[] }[] = [];
          for (const message of queued) if (!messageReceived(message, seen)) {
            const input = await userInput(message);
            if (!input.length) throw new HttpError(400, '待接收消息为空');
            batches.push({ message, input });
          }
          const draftInput = await userInput(b);
          const handledQueuedIds = queued.map(q => q.id);
          if (delivery === 'flush' && !batches.length && !draftInput.length) return json(res, { handledQueuedIds });
          let input = draftInput;
          if (delivery === 'steer') {
            const messageId = randomUUID();
            const result = await adapter.call('turn/steer', { threadId: id, expectedTurnId: target!.id, clientUserMessageId: messageId, input: [...input, ...(appContext?.images ?? [])], ...(additionalContext ? { additionalContext } : {}) });
            return json(res, { ...result, messageId });
          }
          const reviewer=await configuredReviewer(cwd);await syncReviewer(t,reviewer);
          // All input validation finishes before cancellation.
          const resumeGoal = delivery === 'interrupt' || delivery === 'flush' && target ? await interruptTurn(t, target!) : undefined;
          if (delivery === 'flush') {
            // Messages may be consumed while cancellation is in flight. Only forward the remainder.
            const seen = received();
            input = [...batches.filter(batch => !messageReceived(batch.message, seen)).flatMap(batch => batch.input), ...draftInput];
          }
          const result = await startTurn(t,[...input, ...(appContext?.images ?? [])],settings,delivery==='flush'?b.batchId:undefined,reviewer,additionalContext);
          let goalWarning: string | undefined;
          if (resumeGoal) {
            try {
              await refreshGoal(t, true);
              if (t.goal?.status === 'paused' && t.goal.createdAt === resumeGoal.createdAt && t.goal.objective === resumeGoal.objective) await writeGoal(t, { status: 'active' });
            } catch { goalWarning = '消息已发送，Goal 恢复结果待同步；请检查状态后继续'; }
          }
          if(firstTurn) {
            const preview=shortTitle(text) || '附件任务';
            if(!t.preview)t.preview=preview;
            publish('viewer/threadPreview',{threadId:id,preview:t.preview});
            if(!t.name && text.trim())void generateTitle(adapter,text,t.settings?.model).then(name=>setName(t,name,true)).catch(()=>{
              if(!stopped && !t.name)publish('viewer/nameError',{threadId:id,message:'自动标题生成未完成，暂用首句预览。可点击顶部“重命名”设置标题。'});
            });
          }
          return json(res, { ...result, goalWarning, ...(delivery === 'flush' ? { handledQueuedIds } : {}) });
        } catch (error) {
          // A timeout can occur AFTER Codex accepted the request. Never automatically retry it.
          if (error instanceof Error && /timed out/.test(error.message)) uncertain.add(id);
          throw error;
        } finally { releaseThread(id); }
      }
      if (req.method === 'POST' && action === 'interrupt') {
        const t = await openThread(id);
        if (busy.has(id)) throw new HttpError(409, '正在提交消息，请稍后停止');
        busy.add(id);
        try { await interruptTurn(t); return json(res, {}); } finally { releaseThread(id); }
      }
    }
    const approval = /^\/api\/requests\/([^/]+)$/.exec(p);
    if (approval && req.method === 'POST') {
      const b = await body(req); const request = pending.get(approval[1]);
      if (!request) throw new HttpError(409, '该请求已处理或失效');
      const decision = string(b.decision);
      const choice = approvalChoices(request).find(c => c.id === decision);
      if (!choice) throw new HttpError(400, '此请求不支持所选授权范围');
      // Rules and permissions come only from the pending Codex request, never the browser.
      let result: Obj = choice.result;
      if (request.method === 'mcpServer/elicitation/request') result = elicitationResponse(request.params, decision, object(b.answers ?? {}));
      if (request.method === 'item/tool/requestUserInput') {
        const answers: Obj = {}; const submitted = object(b.answers ?? {});
        for (const raw of request.params.questions as unknown[] || []) {
          const q = object(raw); const answer = submitted[string(q.id)];
          if (decision === 'accept' && (typeof answer !== 'string' || answer.length > 10_000)) throw new HttpError(400, '请回答所有问题');
          answers[string(q.id)] = { answers: decision === 'accept' ? [answer] : [] };
        }
        result = { answers };
      }
      adapter.respond(request.rpcId, result); pending.delete(request.id); publish('viewer/requestResolved', { id: request.id }); return json(res, { ok: true });
    }
    if (p === '/api/attachments' && req.method === 'POST') {
      const a = await uploads.save(req, url.searchParams.get('name') || 'attachment'); return json(res, { ...a, path: undefined });
    }
    const attachment = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (attachment && req.method === 'GET') {
      const a = await uploads.get(attachment[1]);
      res.setHeader('Content-Type', a.mime);
      res.setHeader('Content-Disposition', `${a.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
      res.end(await readFile(a.path)); return;
    }
    if (req.method === 'GET' && (p === '/' || /^\/assets\/[\w.-]+$/.test(p))) {
      const file = path.join(staticDir, p === '/' ? 'index.html' : p.slice(1));
      const actual = await realpath(file).catch(() => { throw new HttpError(404, '请先运行 npm run build'); });
      if (!inside(await realpath(staticDir), actual) || actual !== file) throw new HttpError(403, '无效资源');
      const types: Record<string,string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf' };
      if (/^\/assets\/.+-[\w-]{8,}\.[\w]+$/.test(p)) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); return;
    }
    throw new HttpError(404, '未找到接口');
  }
  const server = createServer((req,res) => {
    const pathname = (req.url || '').split('?')[0];
    const tracked = pathname.startsWith('/api/') && !['/api/events', '/api/restart'].includes(pathname);
    if (tracked) activeRequests++;
    void handler(req,res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof Error ? error.message : '请求失败';
      json(res, { error: message.replace(/(?:sk-[\w-]+|Bearer\s+\S+)/g, '[redacted]') }, status);
    }).finally(() => { if (tracked) activeRequests--; });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(restored?.port || options.port, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    mcpApps = await createMcpApps(adapter, async id => {
      const t = threads.get(id);
      if (!t?.turns) return readThread(id, true);
      await directory(t.cwd, roots); return t;
    }, staticDir, origin);
  } catch (error) { clearInterval(cleanupTimer); clearInterval(watchdogTimer); server.close(); watchdogs.close(); throw error; }
  const launch = watchdogLaunch(`${origin}/internal/watchdogs`,watchdogToken);
  adapter.configureLaunch({ ...launch, args: [...launch.args, '-c', 'features.goals=true'], captureModels: true });
  const launchUrl = `${origin}/?token=${token}`;
  const urlFile = path.join(options.runtimeDir, 'url');
  try { await writeFile(urlFile, launchUrl + '\n', { mode: 0o600 }); await chmod(urlFile, 0o600); }
  catch (error) { clearInterval(cleanupTimer); clearInterval(watchdogTimer); await mcpApps.stop(); server.close(); watchdogs.close(); throw error; }
  void adapter.start().catch(() => {});
  return { server, adapter, origin, launchUrl, async stop() {
    if (stopped) return;
    stopped = true; clearTimeout(reconnect); clearInterval(cleanupTimer); clearInterval(watchdogTimer);
    const child = adapter.child;
    const exited = child && child.exitCode === null ? new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    }) : Promise.resolve();
    adapter.stop();
    await mcpApps?.stop();
    for (const c of clients) c.end(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(urlFile).catch(() => {});
    watchdogs.close();
    await exited;
  } };
}

export async function restartProcess(app: { stop(): Promise<void> }, state: string) {
  if (!process.execve) throw new Error('Node does not support process replacement');
  await app.stop();
  try { process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, VIEWER_RESTART_STATE: state } as Record<string, string>); }
  catch { console.error('Viewer process replacement failed'); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type:'string', multiple:true }, port:{type:'string',default:'8787'}, 'data-dir':{type:'string'}, 'runtime-dir':{type:'string'} } });
  const port = Number(values.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const runtimeDir = values['runtime-dir'] || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `codex-viewer-${process.getuid?.() ?? 'user'}`);
  const app = await serve({ roots: values.root || [path.join(os.homedir(), 'projects')], port, runtimeDir, dataDir: values['data-dir'] || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'codex-viewer'), restart: process.execve ? state => restartProcess(app, state) : undefined });
  console.log(`Codex Viewer: ${app.launchUrl}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.stop().then(() => process.exit()); });
}
