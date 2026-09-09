import { renderInto, installCopy } from './render.ts';
import { reduceNotice } from '../server/protocol.ts';
import type { Thread, Notice, PendingRequest, Item, Settings, Model, Skill } from '../server/protocol.ts';
import { activity } from './activity.ts';
import { highlightInto, outputText } from './highlight.ts';
import { installLinks } from './links.ts';
import './style.css';
import 'katex/dist/katex.min.css';

type Attachment = { id: string; name: string; mime: string; size: number };
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<aside class="sidebar"><div class="brand"><span class="brand-mark">c/</span><span>Codex <small>VIEWER</small></span></div>
<button id="new" class="new-thread">＋ 新任务</button><label class="sr-only" for="search">搜索任务</label><input id="search" type="search" placeholder="搜索任务…">
<nav id="threads" aria-label="任务列表"></nav><button id="more" class="quiet" hidden>加载更多</button>
<footer><button id="refresh" class="quiet">↻ 刷新</button><button id="notifications" class="quiet">开启通知</button><span id="connection" role="status">连接中</span></footer></aside>
<main><header class="topbar"><button id="menu" class="quiet" aria-label="切换边栏">☰</button><div><h1 id="title">开始一个新任务</h1><div id="cwd" class="subtle">选择项目，让工作留在 WSL</div></div><span class="local-badge">LOCAL</span></header>
<div id="error" role="alert" hidden></div><div id="conversation" tabindex="0" aria-label="对话记录"><div class="welcome"><div class="eyebrow">YOUR WORK, IN FOCUS</div><h2>从一个项目开始。</h2><p>选择左侧已有对话，或选择项目目录新建任务。<br>选好项目后，即可设置模型、思考强度、Plan 和 Skills。</p><button id="welcome-new" class="primary">选择项目，新建任务</button></div></div>
<button id="latest" class="quiet" hidden>↓ 回到最新</button><section id="approvals" aria-label="待处理请求"></section>
<form id="composer" hidden><div class="controls"><label>模型 <select id="model" aria-label="模型" disabled><option>请先选择项目</option></select></label><label>思考 <select id="effort" aria-label="思考强度" disabled><option>请先选择项目</option></select></label><label>模式 <select id="mode" aria-label="模式" disabled><option>请先选择项目</option></select></label><button id="skills-button" type="button" class="quiet" disabled>Skills</button></div><div id="settings-state" class="subtle" role="status"></div><button id="controls-retry" type="button" class="quiet" hidden>重新加载配置</button><div id="selected-skills"></div><div id="attachments"></div><label class="sr-only" for="prompt">消息</label><textarea id="prompt" rows="3" placeholder="描述任务，或粘贴截图与文件…"></textarea>
<div class="composer-actions"><button id="attach" type="button" class="quiet" title="添加附件">＋ 附件</button><input id="files" type="file" multiple hidden><span id="hint">Enter 发送 · Shift+Enter 换行</span><button id="stop" type="button" class="quiet" hidden>■ 停止</button><button id="send" type="submit">发送 ↑</button></div></form>
<div class="footnote">选中内容后复制，公式会保留 LaTeX · 每条回复也可复制完整 Markdown</div></main>
<dialog id="folder-dialog"><form method="dialog"><button class="close quiet" aria-label="关闭">✕</button></form><h2>选择项目目录</h2><p id="folder-path" class="subtle"></p><div id="folders"></div><div class="dialog-actions"><button id="folder-up" class="quiet">上一级</button><button id="folder-select">在此新建任务</button></div></dialog>
<dialog id="skills-dialog"><form method="dialog"><button class="close quiet" aria-label="关闭 Skills">✕</button></form><h2>Skills</h2><p class="subtle">选择用于本轮消息。全局开关会影响 CLI 和其他客户端。</p><div id="skill-list"></div></dialog>
<div id="toast" role="status" hidden></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const conversation = $('conversation'); installCopy(conversation);
let current: Thread | undefined; let threads: Thread[] = []; let requests: PendingRequest[] = [];
let attachments: Attachment[] = []; let uploading = false; let sending = false; let uncertain = false;
let cursor: string | null = null; let folder: string | null = null; let folderRoots: string[] = [];
type Update = Notice & { seq?: number };
let selectedGeneration = 0; let hydrating = false; let buffered: Update[] = []; let snapshotSeq = 0; let scheduled = false; let follow = true;
const attachmentDrafts = new Map<string, Attachment[]>();
let toastTimer: ReturnType<typeof setTimeout>;
let read: Record<string,number> = {};
type Catalog={models:Model[];modes:{mode:string;name:string}[];skills:Skill[];errors:Record<string,string>;skillErrors:unknown[]};
let catalog:Catalog={models:[],modes:[],skills:[],errors:{},skillErrors:[]};
let desired:Settings|undefined;let selectedSkills:Skill[]=[];let controlsLoading=false;
const settingsDrafts=new Map<string,Settings>();const skillDrafts=new Map<string,Skill[]>();
const settingsDirty=new Set<string>();
let collapsed:Record<string,boolean>={};try{collapsed=JSON.parse(localStorage.getItem('viewer-projects')||'{}');}catch{}
installLinks(conversation,()=>current?.id,error);
try { read = JSON.parse(localStorage.getItem('viewer-read') || '{}'); } catch { /* fresh preferences */ }
function toast(text: string) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2500); }
function error(e: unknown) { $('error').textContent = e instanceof Error ? e.message : String(e); $('error').hidden = false; }
async function api<T>(url: string, data?: unknown): Promise<T> {
  const r = await fetch('/api' + url, data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  const result = await r.json(); if (!r.ok) throw new Error(result.error || r.statusText); return result;
}
function button(label: string, action: () => void, className = 'quiet') { const b = document.createElement('button'); b.textContent = label; b.type = 'button'; b.className = className; b.addEventListener('click',action); return b; }
const title = (t: Thread) => t.name || t.preview?.slice(0,60) || '新任务';
function state(t: Thread) {
  if (t.status?.activeFlags?.some(f => /waiting/.test(f)) || requests.some(r => r.params.threadId === t.id)) return ['attention','等待输入'];
  if (t.status?.type === 'active') return ['running','进行中'];
  if (t.status?.type === 'systemError' || t.turns?.at(-1)?.status === 'failed') return ['failed','失败'];
  if ((t.updatedAt || 0) > (read[t.id] || 0) && t.id !== current?.id) return ['unread','未读'];
  return ['idle','空闲'];
}
function renderThreads() {
  const nav = $('threads'); nav.replaceChildren(); const query = $<HTMLInputElement>('search').value.toLowerCase();
  const groups=new Map<string,Thread[]>();
  for(const t of [...threads].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))) {const root=t.projectRoot||t.cwd;if(!groups.has(root))groups.set(root,[]);groups.get(root)!.push(t);}
  for(const [root,members] of groups) {
    const visible=members.filter(t=>`${title(t)} ${t.cwd} ${root}`.toLowerCase().includes(query));if(!visible.length)continue;
    const group=document.createElement('section');group.className='project';
    const header=document.createElement('div');header.className='project-header';
    const toggle=button((collapsed[root]&&!query?'▸ ':'▾ ')+(root.split('/').at(-1)||root),()=>{collapsed[root]=!collapsed[root];localStorage.setItem('viewer-projects',JSON.stringify(collapsed));renderThreads();});toggle.title=root;toggle.setAttribute('aria-expanded',String(!collapsed[root]||!!query));
    const add=button('＋',()=>{void api<{thread:Thread}>('/threads',{cwd:root}).then(r=>selectThread(r.thread.id)).then(()=>loadThreads()).catch(error);});add.title='在此项目新建对话';
    const status=document.createElement('small');const running=members.filter(t=>state(t)[0]==='running').length;const waiting=members.filter(t=>state(t)[0]==='attention').length;
    status.textContent=waiting?`${waiting} 待审批`:running?`${running} 运行中`:`${members.length} 已加载`;status.className=waiting?'attention':running?'running':'';
    header.append(toggle,status,add);group.append(header);nav.append(group);
    if(collapsed[root]&&!query)continue;
  for (const t of visible) {
    const [kind,label] = state(t); const b = button('', () => { void selectThread(t.id).catch(error); }, 'thread ' + (t.id === current?.id ? 'selected' : ''));
    const name = document.createElement('strong'); name.textContent = title(t);
    const info = document.createElement('span'); info.className = 'thread-meta';
    const status = document.createElement('span'); status.className = `status ${kind}`; status.textContent = label;
    const cwd = document.createElement('span'); cwd.textContent = t.cwd.split('/').filter(Boolean).at(-1) || '/';
    info.append(status,cwd); b.append(name,info); group.append(b);
  }
  }
  $('more').hidden = !cursor;
}
async function loadThreads(more = false) {
  const result = await api<{data:Thread[];nextCursor:string|null}>('/threads' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  const map = new Map((more ? threads : []).map(t => [t.id,t])); result.data.forEach(t => map.set(t.id,t));
  if (current) map.set(current.id,current);
  threads = [...map.values()]; cursor = result.nextCursor; renderThreads();
}
const draftKey = () => 'viewer-draft:' + (current?.id || 'new');
let controlGeneration=0;
async function loadControls() {
  if(!current)return;const id=current.id;const gen=++controlGeneration;controlsLoading=true;renderControls();renderSkills();updateControls();
  try {const data=await api<Catalog>('/controls?threadId='+encodeURIComponent(id));if(current?.id!==id||gen!==controlGeneration)return;
    catalog=data;
  } catch(e) {
    if(current?.id===id&&gen===controlGeneration)catalog={models:[],modes:[],skills:[],skillErrors:[],errors:{load:e instanceof Error?e.message:String(e)}};
  } finally {if(gen===controlGeneration){controlsLoading=false;renderControls();renderSkills();updateControls();}}
}
function choices(id:string,values:{value:string;label:string}[],value:string) {
  const select=$<HTMLSelectElement>(id);select.replaceChildren();
  for(const v of values)select.append(new Option(v.label,v.value));
  if(!values.length)select.append(new Option('暂无可用选项',''));
  select.value=values.some(v=>v.value===value)?value:select.options[0].value;
  select.title=select.selectedOptions[0]?.textContent||'';
}
function renderControls() {
  if(!current||hydrating||controlsLoading){
    const label=!current?'请先选择项目':'正在加载…';
    for(const id of ['model','effort','mode']){choices(id,[{value:'',label}],'');$<HTMLSelectElement>(id).disabled=true;}
    $<HTMLButtonElement>('skills-button').disabled=true;renderSettingsState();return;
  }
  desired??=current?.settings;
  const models=catalog.models.map(m=>({value:m.model,label:m.displayName}));
  if(desired?.model&&!models.some(m=>m.value===desired!.model))models.unshift({value:desired.model,label:desired.model+'（当前配置）'});
  choices('model',models,desired?.model||'');
  const model=catalog.models.find(m=>m.model===desired?.model);
  choices('effort',[{value:'',label:'默认'},...(model?.supportedReasoningEfforts||[]).map(e=>({value:e.reasoningEffort,label:e.reasoningEffort}))],desired?.effort||'');
  choices('mode',catalog.modes.map(m=>({value:m.mode,label:m.mode==='plan'?'Plan · 规划':'普通 · 执行'})),desired?.mode||'default');
  for(const id of ['model','effort','mode'])$<HTMLSelectElement>(id).disabled=!catalog.models.length||!catalog.modes.length;
  $('skills-button').title=catalog.errors.skills||'选择与管理 Skills';
  $<HTMLButtonElement>('skills-button').disabled=false;
  renderSettingsState();
}
function renderSettingsState() {
  const effective=current?.settings;
  const description=(s:Settings)=>`${s.model} · ${s.effort||'默认强度'} · ${s.mode==='plan'?'Plan':'普通'}`;
  $('controls-retry').hidden=!current||hydrating||controlsLoading||!Object.keys(catalog.errors).length;
  $('settings-state').textContent=!current?'请先选择项目':hydrating||controlsLoading?'正在加载此项目的模型、模式和 Skills…':Object.values(catalog.errors).map(e=>'配置加载失败：'+e).join('；') || (effective?'已生效：'+description(effective)+(desired&&JSON.stringify(desired)!==JSON.stringify(effective)?' ｜下一轮：'+description(desired):''):'');
}
for(const id of ['model','effort','mode'])$(id).addEventListener('change',()=>{
  if(!current||!desired)return;
  const model=$<HTMLSelectElement>('model').value;
  desired={model,effort:id==='model'?catalog.models.find(m=>m.model===model)?.defaultReasoningEffort||null:$<HTMLSelectElement>('effort').value||null,mode:$<HTMLSelectElement>('mode').value==='plan'?'plan':'default'};
  settingsDrafts.set(current.id,desired);try{localStorage.setItem('viewer-settings:'+current.id,JSON.stringify(desired));}catch{}
  settingsDirty.add(current.id);
  renderControls();
});
function renderSkills() {
  $('selected-skills').replaceChildren();
  for(const skill of selectedSkills){const b=button('$'+skill.name+' ×',()=>{selectedSkills=selectedSkills.filter(s=>s.path!==skill.path);renderSkills();});b.className='skill-chip';$('selected-skills').append(b);}
  $('skill-list').replaceChildren();
  const message=!current?'请先选择项目。':hydrating||controlsLoading?'正在加载此项目的 Skills…':catalog.errors.load||catalog.errors.skills?`Skills 加载失败：${catalog.errors.load||catalog.errors.skills}`:!catalog.skills.length?'此项目没有发现可用的 Skill。':'';
  if(message){const p=document.createElement('p');p.textContent=message;p.setAttribute('role','status');$('skill-list').append(p);
    if(current&&!hydrating&&!controlsLoading)$('skill-list').append(button('重新加载',()=>{void loadControls();}));return;
  }
  for(const s of catalog.skills) {
    const row=document.createElement('div');row.className='skill-row';
    const name=document.createElement('strong');name.textContent=s.name;name.title=s.path;
    const detail=document.createElement('p');detail.textContent=s.description;row.append(name,detail);
    const use=button(selectedSkills.some(v=>v.path===s.path)?'已选中':'用于本轮',()=>{if(!selectedSkills.some(v=>v.path===s.path))selectedSkills.push(s);renderSkills();});use.disabled=!s.enabled;
    const global=button(s.enabled?'全局：已启用':'全局：已禁用',()=>{
      if(!current)return;const id=current.id;global.disabled=true;
      void api<{effectiveEnabled:boolean}>('/skills/config',{threadId:id,path:s.path,enabled:!s.enabled}).then(async r=>{
        if(r.effectiveEnabled===s.enabled)throw new Error('配置未生效：可能受上层策略限制');
        if(!r.effectiveEnabled)selectedSkills=selectedSkills.filter(v=>v.path!==s.path);
        await loadControls();
      }).catch(error).finally(()=>global.disabled=false);
    });row.append(use,global);$('skill-list').append(row);
  }
  if(catalog.skillErrors.length){const p=document.createElement('p');p.textContent='部分 Skill 加载失败：'+JSON.stringify(catalog.skillErrors);$('skill-list').append(p);}
}
$('skills-button').onclick=()=>{$<HTMLDialogElement>('skills-dialog').showModal();};
$('controls-retry').onclick=()=>{void loadControls();};
setInterval(()=>{document.querySelectorAll<HTMLElement>('time[data-since]').forEach(el=>el.textContent=` ${Math.max(0,Math.floor((Date.now()-Number(el.dataset.since))/1000))}s`);},1000);
function saveDraft() { try { localStorage.setItem(draftKey(),$<HTMLTextAreaElement>('prompt').value); } catch {} }
async function selectThread(id: string) {
  if (uploading || sending) { toast('请等待当前提交或上传完成'); return; }
  if (current) attachmentDrafts.set(current.id, attachments);
  if(current) {if(desired)settingsDrafts.set(current.id,desired);skillDrafts.set(current.id,selectedSkills);}
  saveDraft(); const gen = ++selectedGeneration; ++controlGeneration;controlsLoading=false;hydrating = true; buffered = []; sending = false;
  catalog={models:[],modes:[],skills:[],errors:{},skillErrors:[]};renderControls();renderSkills();updateControls();
  $('error').hidden = true;
  try {
    const result = await api<{ thread:Thread;requests:PendingRequest[];uncertain?:boolean;seq:number }>(`/threads/${encodeURIComponent(id)}/open`,{});
    if (gen !== selectedGeneration) return;
    current = result.thread; requests = result.requests; uncertain = !!result.uncertain;
    desired=settingsDrafts.get(id)||current.settings;selectedSkills=skillDrafts.get(id)||[];
    try {const saved=localStorage.getItem('viewer-settings:'+id);if(saved){desired=JSON.parse(saved);settingsDirty.add(id);}}catch{}
    snapshotSeq = result.seq;
    attachments = attachmentDrafts.get(id) || []; renderAttachments();
    window.getSelection()?.removeAllRanges();
    $<HTMLTextAreaElement>('prompt').value = localStorage.getItem(draftKey()) || '';
    location.hash = id; follow = true;
    read[id] = Date.now()/1000; localStorage.setItem('viewer-read',JSON.stringify(read));
    renderApprovals(); updateControls(); renderConversation(true); renderThreads();
    document.body.classList.remove('show-sidebar');
    void loadControls().catch(error);
  } finally { if (gen === selectedGeneration) { hydrating = false; const queue = buffered; buffered = []; queue.forEach(handleUpdate);renderControls();renderSkills(); updateControls(); } }
}
let resyncing = false;
async function resync() {
  if (resyncing || hydrating) return;
  resyncing = true;
  try {
    if (current) {
      const id = current.id;
      const gen = selectedGeneration;
      const r = await api<{thread:Thread;requests:PendingRequest[];uncertain?:boolean;seq:number}>(`/threads/${encodeURIComponent(id)}/open`,{});
      if (current?.id === id && gen === selectedGeneration) { current = r.thread; requests = r.requests; snapshotSeq = r.seq; uncertain = !!r.uncertain; renderApprovals(); updateControls(); renderSettingsState(); renderConversation(true); }
    }
    await loadThreads();
  } finally { resyncing = false; if (!hydrating) { const queue = buffered; buffered = []; queue.forEach(handleUpdate); } }
}
const rendered = new Map<string,{article:HTMLElement;body:HTMLElement;source:string;item:Item}>();
async function copy(text: string) { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('无法访问剪贴板，请选中文字后复制'); } }
function renderConversation(reset = false) {
  if (!current) return;
  // Keep the selected DOM stable while a user is selecting/copying streaming text.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.anchorNode && conversation.contains(selection.anchorNode)) return;
  $('title').textContent = title(current); $('cwd').textContent = current.cwd;
  if (reset) { conversation.replaceChildren(); rendered.clear(); }
  const items = (current.turns || []).flatMap(t => t.items.map(item=>({item,turn:t})));
  if (!conversation.querySelector('.message') && conversation.querySelector('.welcome')) conversation.replaceChildren();
  for (const {item,turn} of items) {
    const isMessage = ['agentMessage','userMessage','plan'].includes(item.type);
    let row = rendered.get(item.id);
    if (!row) {
      const article = document.createElement('article'); article.className = `message ${item.type === 'userMessage' ? 'user' : isMessage ? 'assistant' : 'tool'}`;
      const header = document.createElement('div'); header.className = 'message-header'; header.dataset.copyIgnore = '';
      const who = document.createElement('span'); who.textContent = item.type === 'userMessage' ? '你' : item.type==='plan'?'Codex · Plan':isMessage ? 'Codex' : item.type;
      if(isMessage)header.append(who);else header.hidden=true;
      const body = document.createElement(isMessage ? 'div' : 'details'); body.className = isMessage ? 'markdown' : 'activity';
      article.append(header,body); conversation.append(article);
      row = { article,body,source:'\u0000',item }; rendered.set(item.id,row);
      if (['agentMessage','plan'].includes(item.type)) header.append(button('复制 Markdown', () => { void copy(row!.source); }));
    }
    row.item = item;
    let source = item.text || '';
    if (item.type === 'userMessage') source = (item.content || []).map(part => part.type === 'text' ? String(part.text || '') : part.type==='skill'?'$'+String(part.name):'[图片附件]').join('\n');
    if (!isMessage) source = JSON.stringify([item,turn.status]);
    if (row.source === source) continue;
    row.source = source;
    if (['agentMessage','plan'].includes(item.type)) {
      renderInto(row.body,source);
      for (const pre of row.body.querySelectorAll('pre')) {
        const code = pre.querySelector('code'); if (!code) continue;
        const toolbar=document.createElement('div');toolbar.className='code-toolbar';toolbar.dataset.copyIgnore='';
        const language=document.createElement('span');language.textContent=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9)||'代码';
        const b = button('复制代码', () => { void copy(code.textContent || ''); }, 'code-copy quiet');
        toolbar.append(language,b);pre.prepend(toolbar);
      }
    } else if (item.type === 'userMessage') row.body.textContent = source;
    else {
      const a=activity(item,turn); const wasOpen=row.body instanceof HTMLDetailsElement&&row.body.open;
      const command=item.type==='commandExecution';const expandable=!!a.detail||(command&&!!a.subject);
      if(expandable!==(row.body instanceof HTMLDetailsElement)) {const body=document.createElement(expandable?'details':'div');row.body.replaceWith(body);row.body=body;}
      // Reuse expanded blocks so output scroll position and highlighter state survive deltas.
      const oldCommand=row.body.querySelector<HTMLElement>('.activity-command-full');
      const oldOutput=row.body.querySelector<HTMLElement>('.activity-output');
      const outputTop=oldOutput?.scrollTop||0,outputLeft=oldOutput?.scrollLeft||0;
      row.body.className='activity '+a.state;row.body.dataset.kind=item.type;row.body.replaceChildren();
      const summary=document.createElement(expandable?'summary':'div');summary.className='activity-title';
      const name=document.createElement('span');name.className='activity-label';name.textContent=a.label;summary.append(name);
      if(a.subject){const subject=document.createElement(command?'code':'span');subject.className=command?'activity-command':'activity-subject';
        if(command)highlightInto(subject,a.subject);else subject.textContent=a.subject;
        subject.title=a.subject;summary.append(subject);}
      const label=document.createElement('span');label.className='activity-state';label.textContent=({running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',unknown:'状态未知'} as Record<string,string>)[a.state]||a.state;summary.append(label);
      if(a.state==='running'&&item.startedAt){const time=document.createElement('time');time.dataset.since=String(item.startedAt);summary.append(time);}
      row.body.append(summary);
      if(command) {
        const block=(existing:HTMLElement|null,className:string,label:string,source:string,language:string)=>{
          const pre=existing||document.createElement('pre');pre.className=className;
          if(!existing){const toolbar=document.createElement('div');toolbar.className='code-toolbar';toolbar.dataset.copyIgnore='';
            const name=document.createElement('span');name.textContent=label;
            toolbar.append(name,button('复制'+label,()=>{void copy(language==='output'?outputText(row!.item.aggregatedOutput||''):row!.item.command||'');}));
            pre.append(toolbar,document.createElement('code'));
          }
          row!.body.append(pre);
          return ()=>{highlightInto(pre.querySelector('code')!,source,language);
            if(language==='output'){pre.scrollTop=outputTop;pre.scrollLeft=outputLeft;}
          };
        };
        const paints:(()=>void)[]=[];
        if(a.subject)paints.push(block(oldCommand,'activity-command-full','命令',a.subject,'bash'));
        if(a.detail)paints.push(block(oldOutput,'activity-output','输出',a.detail,'output'));
        const paint=()=>{if((row!.body as HTMLDetailsElement).open)paints.forEach(fn=>fn());};
        row.body.ontoggle=paint;
        (row.body as HTMLDetailsElement).open=wasOpen;paint();
      } else if(a.detail){
        const pre=document.createElement('pre');pre.textContent=a.detail;row.body.append(pre);
      }
      if(expandable)(row.body as HTMLDetailsElement).open=wasOpen;
    }
  }
  if (current.turns?.at(-1)?.error) error(JSON.stringify(current.turns.at(-1)!.error));
  if (follow) conversation.scrollTop = conversation.scrollHeight;
}
function scheduleRender() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; updateControls(); renderConversation(); renderThreads(); }); }
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) scheduleRender(); });
function updateControls() {
  $('composer').hidden=!current;
  const active = current?.status?.type === 'active' || uncertain;
  const unavailableChange=current&&settingsDirty.has(current.id)&&(!catalog.models.length||!catalog.modes.length);
  $<HTMLButtonElement>('send').disabled = !current || sending || uploading || active || hydrating || controlsLoading || !!unavailableChange;
  $('stop').hidden = !active;
  $('hint').textContent = uploading ? '正在上传…' : active ? requests.some(r=>r.params.threadId===current?.id)?'等待你的审批 / 回答':'任务进行中，可切换到其他任务' : 'Enter 发送 · Shift+Enter 换行';
  $('hint').classList.toggle('running',!!active&&!requests.some(r=>r.params.threadId===current?.id));
}
function renderApprovals() {
  $('approvals').replaceChildren();
  for (const r of requests.filter(r => r.params.threadId === current?.id)) {
    const card = document.createElement('article'); card.className = 'approval' + (r.windows ? ' windows' : '');
    const label = document.createElement('strong'); label.textContent = r.windows ? '可能涉及 Windows' : 'Codex 需要你的输入';
    const detail = document.createElement('pre'); detail.textContent = String(r.params.command || r.params.reason || JSON.stringify(r.params,null,2));
    const fields: Record<string,HTMLTextAreaElement> = {};
    card.append(label,detail);
    if(r.windowsEvidence?.length){const evidence=document.createElement('p');evidence.textContent='检测依据：'+r.windowsEvidence.join('、');card.append(evidence);}
    for (const q of (r.params.questions || []) as {id:string;question:string;options?:{label:string;description:string}[]}[]) {
      const l = document.createElement('label'); l.textContent = q.question;
      const input = document.createElement('textarea'); input.rows = 2; l.append(input); card.append(l); fields[q.id] = input;
      for (const opt of q.options || []) card.append(button(opt.label, () => { input.value = opt.label; }));
    }
    const reply = async (decision: string) => {
      try {
        card.querySelectorAll('button').forEach(b=>b.disabled=true);
        await api('/requests/' + r.id, { decision,answers:Object.fromEntries(Object.entries(fields).map(([k,v]) => [k,v.value])) });
        requests = requests.filter(p => p.id !== r.id); renderApprovals();
      } catch (e) { error(e);card.querySelectorAll('button').forEach(b=>b.disabled=false); }
    };
    card.append(button(r.method.endsWith('requestUserInput') ? '提交回答' : r.windows?'允许本次 Windows 操作':'单次允许', () => { void reply('accept'); },'primary'), button('拒绝', () => { void reply('decline'); }), button('取消', () => { void reply('cancel'); }));
    $('approvals').append(card);
  }
}
function renderAttachments() {
  $('attachments').replaceChildren();
  for (const a of attachments) {
    const chip = document.createElement('span'); chip.className = 'attachment';
    if (a.mime.startsWith('image/')) { const img = document.createElement('img'); img.src = '/api/attachments/' + a.id; img.alt = a.name; chip.append(img); }
    chip.append(document.createTextNode(a.name),button('×',() => { attachments = attachments.filter(v => v.id !== a.id); renderAttachments(); }));
    $('attachments').append(chip);
  }
}
async function addFiles(files: File[]) {
  if (!current || sending || hydrating) { toast('请先选择任务，并等待提交完成'); return; }
  if (uploading) { toast('请等待当前上传完成'); return; }
  if (attachments.length + files.length > 10) { toast('每轮最多 10 个附件'); return; }
  uploading = true; updateControls();
  try {
    for (const f of files) {
      if (f.size > 25*1024*1024) throw new Error(`${f.name} 超过 25 MB`);
      const response = await fetch('/api/attachments?name=' + encodeURIComponent(f.name), { method:'POST',body:f,headers:{'Content-Type':'application/octet-stream'} });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      attachments.push(data); renderAttachments();
    }
  } catch(e) { error(e); } finally { uploading = false; updateControls(); }
}
$('attach').onclick = () => $<HTMLInputElement>('files').click();
$<HTMLInputElement>('files').onchange = event => { const input = event.target as HTMLInputElement; void addFiles([...input.files || []]); input.value = ''; };
$('prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f);
  if (files.length) { event.preventDefault(); void addFiles(files); }
});
$('composer').addEventListener('dragover', event => { event.preventDefault(); $('composer').classList.add('drag'); });
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('drag'));
$('composer').addEventListener('drop', event => { event.preventDefault(); $('composer').classList.remove('drag'); void addFiles([...event.dataTransfer?.files || []]); });
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  if (!current || $<HTMLButtonElement>('send').disabled) return;
  const id = current.id; const prompt = $<HTMLTextAreaElement>('prompt'); const text = prompt.value;
  const sentSettings=desired;
  if (!text.trim() && !attachments.length) return;
  sending = true; updateControls(); $('error').hidden = true;
  void api(`/threads/${id}/turns`,{text,attachments:attachments.map(a => a.id),settings:catalog.models.length&&catalog.modes.length?desired:undefined,skills:selectedSkills.map(s=>s.path)}).then(async () => {
    if(desired===sentSettings){settingsDirty.delete(id);settingsDrafts.delete(id);localStorage.removeItem('viewer-settings:'+id);}
    if (current?.id === id) { if (prompt.value === text) { prompt.value = ''; saveDraft(); } attachments = [];selectedSkills=[];skillDrafts.delete(id);renderSkills(); renderAttachments(); }
    await resync();
  }).catch(error).finally(() => { sending = false; updateControls(); });
});
$('prompt').addEventListener('input',saveDraft);
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $<HTMLFormElement>('composer').requestSubmit(); } });
$('stop').onclick = () => { if (current) void api(`/threads/${current.id}/interrupt`,{}).catch(error); };
async function showFolders(value?: string) {
  const result = await api<{roots:string[];path:string|null;directories:string[]}>('/directories' + (value ? '?path=' + encodeURIComponent(value) : ''));
  folder = result.path; folderRoots = result.roots; $('folder-path').textContent = folder || '已授权根目录'; $('folders').replaceChildren();
  for (const dir of result.directories) $('folders').append(button('▱ ' + dir,() => { void showFolders(dir).catch(error); },'folder'));
  $<HTMLButtonElement>('folder-select').disabled = !folder;
  $<HTMLDialogElement>('folder-dialog').showModal();
}
$('new').onclick = () => { void showFolders().catch(error); };
$('welcome-new').onclick = () => { void showFolders().catch(error); };
$('folder-up').onclick = () => { void showFolders(folder && !folderRoots.includes(folder) ? folder.slice(0,folder.lastIndexOf('/')) : undefined).catch(error); };
$('folder-select').onclick = () => { if (folder) void api<{thread:Thread}>('/threads',{cwd:folder}).then(async r => { $<HTMLDialogElement>('folder-dialog').close(); await selectThread(r.thread.id); await loadThreads(); }).catch(error); };
$('search').oninput = renderThreads;
$('refresh').onclick = () => { void resync().catch(error); };
$('more').onclick = () => { void loadThreads(true).catch(error); };
$('menu').onclick = () => document.body.classList.toggle('show-sidebar');
$('notifications').onclick = () => { if ('Notification' in window) void Notification.requestPermission().then(p => toast(p === 'granted' ? '通知已开启' : '浏览器未允许通知')); };
conversation.addEventListener('scroll',() => { follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100; $('latest').hidden = follow; });
$('latest').onclick = () => { follow = true; conversation.scrollTop = conversation.scrollHeight; };
const notified=new Set<string>();
function notify(text: string,id:string) {if(notified.has(id))return;notified.add(id);if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(text); }
const events = new EventSource('/api/events');
events.onopen = () => { $('connection').textContent = '已连接'; };
events.onerror = () => { $('connection').textContent = '连接断开 · 重连中'; };
function handleUpdate(n: Update) {
  if(n.method==='skills/changed'){void loadControls().catch(error);return;}
  if (n.method === 'viewer/resync' || n.method === 'viewer/online') { $('connection').textContent = '已连接'; void resync().catch(error); return; }
  if (hydrating || resyncing) { buffered.push(n); return; }
  if (n.seq !== undefined && n.seq <= snapshotSeq && (n.params.threadId === current?.id || n.method.startsWith('viewer/request'))) return;
  if (n.method === 'viewer/offline') { $('connection').textContent = 'Codex 已离线 · 正在恢复'; if (current) current.status = {type:'systemError'}; requests = []; renderApprovals(); updateControls(); return; }
  if (n.method === 'viewer/request') { const r = n.params as unknown as PendingRequest; if(!requests.some(p=>p.id===r.id))requests.push(r); renderApprovals(); renderThreads();updateControls(); notify('Codex 需要你的输入',r.id); return; }
  if (n.method === 'viewer/requestResolved') { requests = requests.filter(r => r.id !== n.params.id); renderApprovals(); return; }
  if (n.method === 'serverRequest/resolved') { void resync().catch(error); return; }
  if (n.method === 'viewer/thread') { void loadThreads().catch(error); return; }
  if (current) reduceNotice(current,n);
  if(n.method==='thread/settings/updated'&&current&&current.id===n.params.threadId&&!settingsDirty.has(current.id)){desired=current.settings;renderControls();}
  for (const t of threads) if (t !== current) reduceNotice(t,n);
  if (n.method === 'turn/completed') {
    requests = requests.filter(r => r.params.threadId !== n.params.threadId); renderApprovals();
    if (current && current.id === n.params.threadId) { uncertain = false; read[current.id] = Date.now()/1000; }
    const turn=n.params.turn as {id:string;status:string};notify(turn.status==='completed'?'Codex 任务已完成':'Codex 任务已结束：'+turn.status,turn.id); void loadThreads().catch(error);
  }
  scheduleRender();
  renderSettingsState();
}
events.addEventListener('update', event => handleUpdate(JSON.parse((event as MessageEvent).data) as Update));
void loadThreads().then(() => { const id = location.hash.slice(1); if (id) return selectThread(id); }).catch(error);
updateControls();
