import { createInterface } from 'node:readline';
import type { Obj, Thread, Turn } from '../server/protocol.ts';
export const answer = '你好 **world**，公式 $\\frac{1}{2}$。\n\n[OpenAI](https://openai.com)\n\n```ts\nconst x = 1;\n\n\nconsole.log(x);\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n目前最值得正式追查的是：**错误的成功判定是否进入论文统计、交易表是否被当作真实数据、人工提供的关键推导是否充分披露。**现阶段没有结论。\n\n[调用方](sample.py:2)';
const threads = new Map<string, Thread>(); let next = 0;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notice = (method: string, params: Obj) => send({ method, params });
const waiting = new Map<string, () => void>();
let enabled=true;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const p = m.params || {};
  if (!m.method) { waiting.get(String(m.id))?.(); waiting.delete(String(m.id)); return; }
  const reply = (result: unknown) => send({ id: m.id, result });
  if (m.method === 'initialize') return reply({});
  if(m.method==='model/list')return reply({data:['mock','mock-fast'].map(model=>({model,displayName:model,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]})),nextCursor:null});
  if(m.method==='collaborationMode/list')return reply({data:[{mode:'default',name:'Default'},{mode:'plan',name:'Plan'}]});
  if(m.method==='skills/list')return reply({data:p.cwds.map((cwd:string)=>({cwd,skills:[{name:'sample-skill',path:'/mock/skills/sample/SKILL.md',description:'A test skill',enabled}],errors:[]}))});
  if(m.method==='skills/config/write'){enabled=p.enabled;return reply({effectiveEnabled:enabled});}
  if (m.method === 'thread/list') return reply({ data: [...threads.values()], nextCursor: null });
  if (m.method === 'thread/start') {
    const t: Thread = { id: 'thread-' + ++next, cwd: p.cwd, preview: '测试任务 ' + next, status: { type: 'idle' }, turns: [],settings:{model:'mock',effort:'medium',mode:'default'} };
    threads.set(t.id, t); return reply({ thread: t,model:'mock',reasoningEffort:'medium' });
  }
  const t = threads.get(p.threadId);
  if (m.method === 'thread/read' || m.method === 'thread/resume') return reply({ thread: t,model:t?.settings?.model,reasoningEffort:t?.settings?.effort });
  if (m.method === 'turn/start' && t) {
    if(p.collaborationMode){t.settings={model:p.collaborationMode.settings.model,effort:p.collaborationMode.settings.reasoning_effort,mode:p.collaborationMode.mode};notice('thread/settings/updated',{threadId:t.id,threadSettings:{...t.settings,collaborationMode:p.collaborationMode}});}
    const turn: Turn = { id: 'turn-' + ++next, status: 'inProgress', items: [{ id: 'user-' + next, type: 'userMessage', content: p.input }] };
    t.turns!.push(turn); t.status = { type: 'active' };
    reply({ turn }); notice('turn/started', { threadId: t.id, turn });
    const finish = () => {
      for(const activity of [{id:'reason-'+turn.id,type:'reasoning',summary:[]},{id:'search-'+turn.id,type:'webSearch',query:'Markdown source copy',action:{type:'search',query:'Markdown source copy'}},{id:'cmd-'+turn.id,type:'commandExecution',command:'/usr/bin/zsh -lc '+JSON.stringify('rg -n "long-command-and-visible-output" src/prompts/example.ts; '+ 'printf "<safe>"; '.repeat(12)),aggregatedOutput:'\x1b[32mPASS\x1b[0m <safe>\n\x1b[33mWARN\x1b[0m sample warning\n\x1b[31mERROR\x1b[0m sample error (fixture only)\nCommand output is plain text.',exitCode:0}]){turn.items.push(activity);notice('item/started',{threadId:t.id,turnId:turn.id,item:activity});notice('item/completed',{threadId:t.id,turnId:turn.id,item:activity});}
      const item = { id: 'agent-' + turn.id, type: t.settings?.mode==='plan'?'plan':'agentMessage', text: '' };
      turn.items.push(item); notice('item/started', { threadId: t.id, turnId: turn.id, item });
      const longStream = p.input[0]?.text === 'long-stream';
      const chunks = longStream ? Array.from({length:40},(_,i)=>`\n\n第 ${i+1} 段。**中文强调应当清晰可见。**${'长篇阅读保持当前位置，Chinese 与 English 以及公式 $x^2$ 协调呈现。'.repeat(4)}`) : [answer.slice(0,30), answer.slice(30,70), answer.slice(70)];
      chunks.forEach((delta,index) => setTimeout(() => {
        if (turn.status !== 'inProgress') return;
        item.text += delta; notice(item.type==='plan'?'item/plan/delta':'item/agentMessage/delta', { threadId: t.id, turnId: turn.id, itemId: item.id, delta });
        if(index === chunks.length-1) {
          notice('item/completed', { threadId: t.id, turnId: turn.id, item });
          turn.status = 'completed'; t.status = { type: 'idle' }; notice('turn/completed', { threadId: t.id, turn });
        }
      },index*(longStream?250:200)));
    };
    if (String(p.input[0]?.text).includes('approve')) {
      const id = 'approval-' + next; waiting.set(id, finish);
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: t.id, turnId: turn.id, itemId: 'cmd', command: 'powershell.exe Get-Date', availableDecisions: ['accept','decline','cancel'] } });
    } else setTimeout(finish, 100);
  }
  if (m.method === 'turn/interrupt' && t) {
    const turn = t.turns!.at(-1)!; turn.status = 'interrupted'; t.status = { type:'idle' }; notice('turn/completed', {threadId:t.id,turn}); reply({});
  }
});
