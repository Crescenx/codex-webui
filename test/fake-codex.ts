import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Obj, Thread, Turn } from '../shared/protocol.ts';
import { referenceTools } from '../server/references-mcp.ts';
export const answer = '你好 **world**，公式 $\\frac{1}{2}$。\n\n[OpenAI](https://openai.com)\n\n```ts\nconst x = 1;\n\n\nconsole.log(x);\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n目前最值得正式追查的是：**错误的成功判定是否进入论文统计、交易表是否被当作真实数据、人工提供的关键推导是否充分披露。**现阶段没有结论。\n\n[调用方](sample.py:2)';
const archived=new Set<string>();
const threads = new Map<string, Thread>(); let next = 0;
const ephemeral = new Set<string>();
const stateFile=process.env.VIEWER_FAKE_STATE;
if(stateFile) {try{const state=JSON.parse(readFileSync(stateFile,'utf8'));for(const t of state.threads)threads.set(t.id,t);next=state.next;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
const send = (value: unknown) => {if(stateFile)writeFileSync(stateFile,JSON.stringify({threads:[...threads.values()].filter(t=>!ephemeral.has(t.id)),next}));return process.stdout.write(JSON.stringify(value) + '\n');};
const notice = (method: string, params: Obj) => send({ method, params });
const waiting = new Map<string, () => void>();
const queued = new Map<string, Obj[]>();
let enabled=true;
const reordered=process.env.VIEWER_FAKE_REORDER_TURNS==='1';
const bracketAnswer=String.raw`\[
x=F_C\!\left(\theta B[s+(1-s)e^{-q(A,x)\tau(A,K)}]\right).
\]

再写共同体能力递推：

\[
\boxed{K_{t+1}=(1-\delta)K_t+\underbrace{\beta(A,K_t)x_t+\varepsilon(A,K_t)(1-x_t)}_{M(A,K_t,x_t)}.}
\]

行内也支持 \(x=\frac{1}{2}\)，美元符号仍支持 $y^2$。`+'\n\n```text\n\\[这段代码不渲染\\]\n```';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const p = m.params || {};
  if (!m.method) { waiting.get(String(m.id))?.(); waiting.delete(String(m.id)); return; }
  const reply = (result: unknown) => send({ id: m.id, result });
  if (m.method === 'initialize') return reply({});
  if (m.method === 'account/read') return reply({ account: { type:'chatgpt', planType:'pro' } });
  if (m.method === 'config/read') return reply({ config: { model:'mock', model_provider:'openai', approvals_reviewer:'auto_review' } });
  if(m.method==='mock/agents'){
    void fetch(process.env.VIEWER_AGENTS_URL!,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.VIEWER_AGENTS_TOKEN},body:JSON.stringify({name:p.name,arguments:p.arguments,_meta:p.noIdentity?{}:{threadId:p.threadId}})}).then(async r=>{const data=await r.json();if(r.ok)reply(data);else send({id:m.id,error:{message:data.error}});});return;
  }
  if (m.method === 'mcpServerStatus/list')return reply({data:process.env.VIEWER_FAKE_NO_REFERENCES?[]:[{name:'viewer_references',tools:Object.fromEntries(referenceTools.map(t=>[t.name,t]))}],nextCursor:null});
  if ((m.method==='mcpServer/tool/call' && p.server==='viewer_references') || m.method==='mock/references') {
    void fetch(process.env.VIEWER_REFERENCES_URL!,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.VIEWER_REFERENCES_TOKEN}`},body:JSON.stringify({name:p.tool || p.name,arguments:p.arguments,_meta:p.noIdentity?{}:{threadId:p.threadId}})}).then(async r=>{const value=await r.json();if(m.method==='mock/references'){if(r.ok)reply(value);else send({id:m.id,error:{message:value.error}});}else reply({isError:!r.ok,content:[{type:'text',text:JSON.stringify(value)}]});});return;
  }
  if (m.method === 'account/rateLimits/read') return reply({ rateLimits: { limitId: 'codex', secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1900000000 } }, rateLimitResetCredits: { availableCount: 2, credits: [] } });
  if(m.method==='model/list')return reply({data:['mock','mock-fast'].map(model=>({model,displayName:model,supportsExperimentalContext:model==='mock',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]})),nextCursor:null});
  if(m.method==='collaborationMode/list')return reply({data:[{mode:'default',name:'Default'},{mode:'plan',name:'Plan'}]});
  if(m.method==='skills/list')return reply({data:p.cwds.map((cwd:string)=>({cwd,skills:[{name:'sample-skill',path:'/mock/skills/sample/SKILL.md',description:'A test skill',enabled}],errors:[]}))});
  if(m.method==='skills/config/write'){enabled=p.enabled;return reply({effectiveEnabled:enabled});}
  if (m.method === 'thread/list') {
    const descendant = (t: Thread) => {
      const seen = new Set<string>(); let parent = t.parentThreadId;
      while (parent && !seen.has(parent)) { if (parent === p.ancestorThreadId) return true; seen.add(parent); parent = threads.get(parent)?.parentThreadId; }
      return false;
    };
    return reply({ data: [...threads.values()].filter(t => !archived.has(t.id) && (!p.ancestorThreadId || descendant(t)) && (!p.sourceKinds || p.sourceKinds.includes(t.parentThreadId ? 'subAgentThreadSpawn' : 'appServer'))), nextCursor: null });
  }
  if(m.method==='thread/archive'){archived.add(p.threadId);notice('thread/archived',{threadId:p.threadId});return reply({});}
  if (m.method === 'thread/loaded/list') return reply({ data: [...threads.keys()], nextCursor: null });
  if (m.method === 'thread/start') {
    const t: Thread = { id: 'thread-' + ++next, cwd: p.cwd, name:null, preview:'', status: { type: 'idle' }, turns: [],settings:{model:p.model||'mock',effort:'medium',mode:'default'} };
    t.approvalsReviewer=p.approvalsReviewer||'user';threads.set(t.id, t);if(p.ephemeral)ephemeral.add(t.id); return reply({ thread: t,model:t.settings!.model,reasoningEffort:'medium',approvalsReviewer:t.approvalsReviewer });
  }
  const t = threads.get(p.threadId);
  if (m.method === 'thread/inject_items' && t) { (t as unknown as Obj).injectedContext=p.items;return reply({}); }
  if (m.method === 'thread/goal/get') return reply({ goal: t?.goal || null });
  if (m.method === 'thread/goal/clear' && t) { const cleared = !!t.goal; t.goal = null; notice('thread/goal/cleared', { threadId: t.id }); return reply({ cleared }); }
  if (['thread/goal/set', 'mock/goal'].includes(m.method) && t) {
    const now = Date.now() / 1000;
    const replacing = p.objective !== undefined && (!t.goal || p.objective !== t.goal.objective || t.goal.status === 'complete');
    if (replacing) t.goal = { threadId: t.id, objective: p.objective, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now };
    if (!t.goal) return send({ id: m.id, error: { code: -32602, message: 'No goal' } });
    t.goal = { ...t.goal, ...Object.fromEntries(['status', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds'].filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]])), updatedAt: now };
    notice('thread/goal/updated', { threadId: t.id, turnId: p.turnId || null, goal: t.goal });
    reply({ goal: t.goal });
    if (m.method === 'thread/goal/set' && t.goal.status === 'active' && !t.turns?.some(v => v.status === 'inProgress')) {
      const turn = { id: 'goal-turn-' + ++next, status: 'inProgress', items: [] };
      t.turns!.push(turn); t.status = { type: 'active' }; notice('turn/started', { threadId: t.id, turn });
    }
    return;
  }
  if (m.method === 'mock/goalTurnEnd' && t) {
    const turn = t.turns?.at(-1);
    if (turn) { turn.status = 'completed'; t.status = { type: 'idle' }; notice('turn/completed', { threadId: t.id, turn }); }
    return reply({});
  }
  if (m.method === 'mock/turn' && t) {
    const turn: Turn = { id: p.turnId || 'mock-turn-' + ++next, status: p.status || 'completed', items: p.items || [] };
    t.turns ??= []; t.turns.push(turn); notice('turn/completed', { threadId: t.id, turn }); return reply({ turn });
  }
  if (m.method === 'mock/fileChange' && t) {
    let turn = t.turns?.at(-1);
    if (!turn) { turn = { id: 'files-' + t.id, status: 'inProgress', items: [] }; t.turns = [turn]; t.status = { type: 'active' }; notice('turn/started', { threadId: t.id, turn }); }
    const item = { id: p.id || 'files', type: 'fileChange', changes: p.changes, status: p.status || 'completed', error: p.error };
    const index = turn.items.findIndex(i => i.id === item.id); if (index < 0) turn.items.push(item); else turn.items[index] = item;
    notice(item.status === 'inProgress' ? 'item/started' : 'item/completed', { threadId: t.id, turnId: turn.id, item }); return reply({});
  }
  if (m.method === 'mock/agent' && t) {
    const id = p.id || 'agent-' + ++next;
    const child: Thread = { id, cwd: p.cwd || t.cwd, parentThreadId: t.id, source: { subAgent: { thread_spawn: { parent_thread_id: t.id, depth: 1 } } }, agentNickname: p.name || id, agentRole: 'worker', preview: p.prompt || '检查测试与实现', status: { type: 'active' }, turns: [{ id: 'work-' + id, status: 'inProgress', items: [{ id: 'input-' + id, type: 'userMessage', content: [{ type: 'text', text: p.prompt || '检查测试与实现' }] }] }] };
    threads.set(id, child);
    if (!t.turns?.length) t.turns = [{ id: 'dispatch-' + t.id, status: 'completed', items: [] }];
    const turn = t.turns!.at(-1)!;
    const item = { id: 'spawn-' + id, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: t.id, receiverThreadIds: [id], prompt: child.preview, agentsStates: { [id]: { status: 'running', message: null } } };
    turn.items.push(item);
    if (!p.silent) { notice('thread/started', { thread: child }); notice('item/completed', { threadId: t.id, turnId: turn.id, item }); }
    return reply({ thread: child });
  }
  if (m.method === 'mock/agentEvent' && t) {
    const turn = t.turns!.at(-1)!;
    if (typeof p.delta === 'string') {
      let item = turn.items.find(i => i.id === 'output-' + t.id);
      if (!item) { item = { id: 'output-' + t.id, type: 'agentMessage', text: '' }; turn.items.push(item); }
      item.text += p.delta;
      if (!p.silent) notice('item/agentMessage/delta', { threadId: t.id, turnId: turn.id, itemId: item.id, delta: p.delta });
    }
    if (p.status) {
      turn.status = p.status; t.status = { type: p.status === 'inProgress' ? 'active' : 'idle', activeFlags: p.waiting ? ['waitingOnUserInput'] : [] };
      if (!p.silent) { notice('thread/status/changed', { threadId: t.id, status: t.status }); if (p.status !== 'inProgress') notice('turn/completed', { threadId: t.id, turn }); }
    }
    return reply({ thread: t });
  }
  if (m.method === 'mock/watchdog' && t) {
    void fetch(process.env.VIEWER_WATCHDOG_URL!,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.VIEWER_WATCHDOG_TOKEN}`},body:JSON.stringify({name:p.name,arguments:p.arguments,_meta:{threadId:t.id}})}).then(async r=>{const value=await r.json();if(r.ok)reply(value);else send({id:m.id,error:{message:value.error}});});return;
  }
  if (m.method === 'mock/question' && t) {
    const turn = t.turns!.at(-1)!;
    const item = { id: 'question-' + ++next, type: 'agentMessage', delivery: 'async' as const, questions: p.questions, text: p.questions.map((q: {title:string;options?:string[]}) => q.title + '\n' + (q.options || []).map(o => '- ' + o).join('\n')).join('\n\n') };
    turn.items.push(item); notice('item/completed', { threadId: t.id, turnId: turn.id, item }); return reply({ item });
  }
  if (m.method === 'turn/steer' && t) {
    const turn = t.turns?.findLast(v => v.status === 'inProgress');
    if (!turn || turn.id !== p.expectedTurnId) return send({id:m.id,error:{message:'Active turn changed'}});
    const item = {id:'steer-'+ ++next,clientId:p.clientUserMessageId || null,type:'userMessage',content:p.input};
    if (waiting.has('tool-'+turn.id)) queued.set(turn.id,[...queued.get(turn.id)||[],item]);
    else {turn.items.push(item);notice('item/started',{threadId:t.id,turnId:turn.id,item});notice('item/completed',{threadId:t.id,turnId:turn.id,item});}
    return reply({turnId:turn.id});
  }
  if (m.method === 'mock/release' && t) { const key='tool-'+p.turnId, resume=waiting.get(key);waiting.delete(key);resume?.();return reply({}); }
  if (m.method === 'mock/receiveQueued' && t) {
    const turn = t.turns!.find(turn => turn.id === p.turnId)!;
    for (const item of (queued.get(turn.id) || []).splice(0, p.count || 1)) {
      turn.items.push(item as typeof turn.items[number]); notice('item/started', { threadId: t.id, turnId: turn.id, item }); notice('item/completed', { threadId: t.id, turnId: turn.id, item });
    }
    return reply({});
  }
  if(t && ['thread/settings/update','turn/settings/update'].includes(m.method)) {
    if(p.approvalsReviewer)t.approvalsReviewer=p.approvalsReviewer;
    if(p.collaborationMode)t.settings={model:p.collaborationMode.settings.model,effort:p.collaborationMode.settings.reasoning_effort,mode:p.collaborationMode.mode};
    const threadSettings={...t.settings,approvalsReviewer:t.approvalsReviewer,collaborationMode:{mode:t.settings?.mode}};
    if(m.method==='thread/settings/update')notice('thread/settings/updated',{threadId:t.id,threadSettings});
    return reply(m.method==='thread/settings/update'?{}:{status:'applied'});
  }
  if(m.method==='thread/unload')return reply({});
  if(m.method==='thread/name/set' && t){t.name=p.name;notice('thread/name/updated',{threadId:t.id,threadName:t.name});return reply({});}
  if (m.method === 'thread/read' || m.method === 'thread/resume') {
    // Like native loaded threads, resume returns existing settings; updates use their own RPC.
    if (m.method === 'thread/resume' && t?.tokenUsage) notice('thread/tokenUsage/updated', { threadId: t.id, turnId: t.turns?.at(-1)?.id, tokenUsage: t.tokenUsage });
    return reply({ thread: t ? { ...t, tokenUsage: undefined, goal: undefined } : t,model:t?.settings?.model,reasoningEffort:t?.settings?.effort,approvalsReviewer:t?.approvalsReviewer });
  }
  if (m.method === 'turn/start' && t) {
    if(ephemeral.has(t.id)) {
      const turn={id:'title-turn',status:'inProgress',items:[]};reply({turn});
      setTimeout(()=>{
        const item={id:'title-answer',type:'agentMessage',text:process.env.VIEWER_FAKE_TITLE || JSON.stringify({title:'概括任务目的'})};
        notice('item/completed',{threadId:t.id,turnId:turn.id,item});
        notice('turn/completed',{threadId:t.id,turn:{...turn,status:'completed',items:[item]}});
      },250);
      return;
    }
    if(p.approvalsReviewer)t.approvalsReviewer=p.approvalsReviewer;
    if(!t.preview)t.preview=p.input[0]?.text || '附件任务';
    if(p.collaborationMode)t.settings={model:p.collaborationMode.settings.model,effort:p.collaborationMode.settings.reasoning_effort,mode:p.collaborationMode.mode};
    notice('thread/settings/updated',{threadId:t.id,threadSettings:{...t.settings,approvalsReviewer:t.approvalsReviewer,collaborationMode:p.collaborationMode||{mode:t.settings?.mode}}});
    const turn: Turn = { id: 'turn-' + ++next, status: 'inProgress', items: [{ id: reordered?'user':'user-' + next, clientId:p.clientUserMessageId || null, type: 'userMessage', content: p.input }] };
    t.turns!.push(turn); t.status = { type: 'active' };
    t.tokenUsage = { last: { totalTokens: 25000 }, modelContextWindow: 100000 };
    notice('thread/tokenUsage/updated', { threadId: t.id, turnId: turn.id, tokenUsage: { ...t.tokenUsage, total: { totalTokens: 500000 } } });
    notice('account/rateLimits/updated', { rateLimits: { limitId: 'codex', secondary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1900000000 } } });
    if(reordered) {
      notice('item/started',{threadId:t.id,turnId:turn.id,item:turn.items[0]});
      notice('turn/started',{threadId:t.id,turn:{...turn,items:[]}});
      setTimeout(()=>reply({turn:{...turn,items:[]}}),60);
    }else {reply({ turn }); notice('turn/started', { threadId: t.id, turn });}
    const finish = () => {
      if (turn.status !== 'inProgress') return;
      for (const item of queued.get(turn.id)||[]) {turn.items.push(item as typeof turn.items[number]);notice('item/started',{threadId:t.id,turnId:turn.id,item});notice('item/completed',{threadId:t.id,turnId:turn.id,item});}
      queued.delete(turn.id);
      for(const activity of [{id:'reason-'+turn.id,type:'reasoning',summary:[]},{id:'search-'+turn.id,type:'webSearch',query:'Markdown source copy',action:{type:'search',query:'Markdown source copy'}},{id:'cmd-'+turn.id,type:'commandExecution',command:'/usr/bin/zsh -lc '+JSON.stringify('rg -n "long-command-and-visible-output" src/prompts/example.ts; '+ 'printf "<safe>"; '.repeat(12)),aggregatedOutput:'\x1b[32mPASS\x1b[0m <safe>\n\x1b[33mWARN\x1b[0m sample warning\n\x1b[31mERROR\x1b[0m sample error (fixture only)\nCommand output is plain text.',exitCode:0}]){turn.items.push(activity);notice('item/started',{threadId:t.id,turnId:turn.id,item:activity});notice('item/completed',{threadId:t.id,turnId:turn.id,item:activity});}
      const item = { id: 'agent-' + turn.id, type: t.settings?.mode==='plan'?'plan':'agentMessage', text: '' };
      turn.items.push(item); notice('item/started', { threadId: t.id, turnId: turn.id, item });
      const longStream = p.input[0]?.text === 'long-stream';
      const bracketStream=p.input[0]?.text==='bracket-math';const split=bracketAnswer.indexOf('\\]')+1;
      const responseText=String(p.input[0]?.text).startsWith('render-markdown\n')?p.input[0].text.slice('render-markdown\n'.length):answer;
      const chunks = longStream ? Array.from({length:40},(_,i)=>`\n\n第 ${i+1} 段。**中文强调应当清晰可见。**${'长篇阅读保持当前位置，Chinese 与 English 以及公式 $x^2$ 协调呈现。'.repeat(4)}`) : bracketStream?[bracketAnswer.slice(0,split),bracketAnswer.slice(split)]:[responseText.slice(0,30), responseText.slice(30,70), responseText.slice(70)];
      chunks.forEach((delta,index) => setTimeout(() => {
        if (turn.status !== 'inProgress') return;
        item.text += delta; notice(item.type==='plan'?'item/plan/delta':'item/agentMessage/delta', { threadId: t.id, turnId: turn.id, itemId: item.id, delta });
        if(index === chunks.length-1) {
          notice('item/completed', { threadId: t.id, turnId: turn.id, item });
          turn.status = 'completed'; t.status = { type: 'idle' }; notice('turn/completed', { threadId: t.id, turn:reordered?{...turn,items:[item]}:turn });
        }
      },index*(longStream?250:bracketStream?800:200)));
    };
    const watchdogRun=/^\[Scheduled Watchdog check\][\s\S]*?\nRun ID: ([\w-]+)/.exec(String(p.input[0]?.text));
    if(watchdogRun && !String(p.input[0]?.text).includes('watchdog-no-report')) {
      const report=()=>fetch(process.env.VIEWER_WATCHDOG_URL!,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.VIEWER_WATCHDOG_TOKEN}`},body:JSON.stringify({name:'watchdog_report',arguments:{runId:watchdogRun[1],outcome:String(p.input[0]?.text).includes('watchdog-continue')?'continue':'complete'},_meta:{threadId:t.id}})}).then(finish);
      if(String(p.input[0]?.text).includes('watchdog-approval')) {const id='approval-'+next;waiting.set(id,()=>{void report();});send({id,method:'item/commandExecution/requestApproval',params:{threadId:t.id,turnId:turn.id,itemId:'cmd',command:'read remote status',availableDecisions:['accept','decline','cancel']}});}
      else if(String(p.input[0]?.text).includes('watchdog-hold'))waiting.set('tool-'+turn.id,()=>{void report();});else void report();
    } else if (p.input[0]?.text === 'reasoning-stream') {
      let item = { id: 'summary-' + turn.id, type: 'reasoning', status: 'inProgress', summary: [] as string[] };
      const params = { threadId: t.id, turnId: turn.id, itemId: item.id };
      turn.items.push(item); notice('item/started', { ...params, item });
      const summarize = (summaryIndex: number, delta: string) => {
        // Match model presets whose default is none: summaries require an explicit request.
        if (!p.summary || p.summary === 'none') return;
        if (item.summary[summaryIndex] === undefined) { item.summary[summaryIndex] = ''; notice('item/reasoning/summaryPartAdded', { ...params, summaryIndex }); }
        item.summary[summaryIndex] += delta; notice('item/reasoning/summaryTextDelta', { ...params, summaryIndex, delta });
      };
      summarize(0, '**Preparing parallel preflight**');
      waiting.set('tool-' + turn.id, () => {
        summarize(0, '\n\nCheck literal `*.py` and 2 * 3.'); summarize(1, '**Monitoring preflight validation**');
        item.status = 'completed'; notice('item/completed', { ...params, item });
        item = { id: 'summary-next-' + turn.id, type: 'reasoning', status: 'inProgress', summary: [] };
        params.itemId = item.id; turn.items.push(item); notice('item/started', { ...params, item });
        summarize(0, '**Cancelling read-only scan**');
        waiting.set('tool-' + turn.id, () => {
          summarize(1, '**Keeping preflight serial**');
          item.status = 'completed'; notice('item/completed', { ...params, item }); finish();
        });
      });
    } else if (p.input[0]?.text === 'hold-tool') {
      const item={id:'tool-'+turn.id,type:'commandExecution',command:'sleep 8',status:'inProgress'};
      turn.items.push(item);notice('item/started',{threadId:t.id,turnId:turn.id,item});
      waiting.set(item.id,()=>{item.status='completed';notice('item/completed',{threadId:t.id,turnId:turn.id,item});finish();});
    } else if (String(p.input[0]?.text).includes('approve')) {
      const id = 'approval-' + next; waiting.set(id, finish);
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: t.id, turnId: turn.id, itemId: 'cmd', command: 'powershell.exe Get-Date', availableDecisions: ['accept','decline','cancel'] } });
    } else setTimeout(finish, 100);
  }
  if (m.method === 'turn/interrupt' && t) {
    const turn = t.turns!.find(v=>v.id===p.turnId)!;
    reply({});
    setTimeout(()=>{turn.status = 'interrupted'; t.status = { type:'idle' };queued.delete(turn.id);waiting.delete('tool-'+turn.id); notice('turn/completed', {threadId:t.id,turn});},80);
  }
});
