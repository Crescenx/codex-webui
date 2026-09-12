import type { Preview } from './api.ts';
// One popover per mounted transcript, outside source copying. The application owns I/O.
export function installLinks(scope:HTMLElement,threadId:()=>string|undefined,report:(e:unknown)=>void, io: {
  preview: (id:string,target:string,signal?:AbortSignal)=>Promise<Preview>;
  openFile: (id:string,target:string)=>Promise<unknown>;
}) {
  const listeners = new AbortController(); let preview:AbortController|undefined;
  const card=document.createElement('div');card.className='reference-card';card.setAttribute('popover','auto');document.body.append(card);
  let active:HTMLElement|undefined;let generation=0;let timer:ReturnType<typeof setTimeout>;
  const act=(name:string,fn:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=name;b.onclick=fn;return b;};
  async function open(target:string,id:string) {
    await io.openFile(id,target);
  }
  async function show(el:HTMLElement) {
    if(active===el && card.matches(':popover-open'))return;
    const id=threadId();if(!id)return; const gen=++generation;active=el;
    preview?.abort();preview=new AbortController();const signal=preview.signal;
    const target=el.dataset.file||el.dataset.external!;
    card.replaceChildren();const title=document.createElement('code');title.textContent=target;card.append(title);
    card.append(act('复制路径 / URL',()=>{void navigator.clipboard.writeText(target).catch(report);}));
    if(el.dataset.file)card.append(act('在 VS Code 打开',()=>{void open(target,id).catch(report);}));
    card.showPopover();const rect=el.getBoundingClientRect();
    card.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-560))+'px';card.style.top=Math.max(8,Math.min(rect.bottom+8,window.innerHeight-330))+'px';
    if(el.dataset.file) {
      const pre=document.createElement('pre');pre.textContent='读取预览…';card.append(pre);
      try {const result=await io.preview(id,target,signal);if(gen!==generation || signal.aborted)return;
        pre.replaceChildren();result.lines.forEach((line:string,i:number)=>{const span=document.createElement('span');const n=result.start+i;span.textContent=`${n}  ${line}\n`;if(n===result.line)span.className='target-line';pre.append(span);});
        title.textContent=`${result.path}:${result.line}`;
      }catch(e){if(gen===generation && !signal.aborted)pre.textContent=e instanceof Error?e.message:String(e);}
    }
  }
  const link=(target:EventTarget|null)=>target instanceof Element?target.closest<HTMLElement>('a[data-file],a[data-external]'):null;
  const options={signal:listeners.signal};
  scope.addEventListener('pointerover',e=>{const el=link(e.target);if(el && el!==active){clearTimeout(timer);timer=setTimeout(()=>void show(el),350);}},options);
  scope.addEventListener('pointerout',e=>{if(link(e.target)!==link(e.relatedTarget))clearTimeout(timer);},options);
  // Pointer focus is followed by click; opening here would be light-dismissed on pointerup.
  scope.addEventListener('focusin',e=>{const el=link(e.target);if(el?.matches(':focus-visible'))void show(el);},options);
  scope.addEventListener('click',e=>{const el=link(e.target);if(!el?.dataset.file)return;e.preventDefault();clearTimeout(timer);const id=threadId();if(!id)return;
    if(e.ctrlKey||e.metaKey)void open(el.dataset.file,id).catch(report);else void show(el);
  },options);
  scope.addEventListener('keydown',e=>{const el=link(e.target);if(el?.dataset.file && ['Enter',' '].includes(e.key)){e.preventDefault();const id=threadId();if((e.ctrlKey||e.metaKey)&&id)void open(el.dataset.file,id).catch(report);else void show(el);}},options);
  card.addEventListener('toggle',()=>{if(!card.matches(':popover-open')){active=undefined;++generation;preview?.abort();}},options);
  return () => { ++generation;listeners.abort();preview?.abort();clearTimeout(timer);card.remove(); };
}
