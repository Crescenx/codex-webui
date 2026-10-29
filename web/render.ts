import { viewerDocument, viewerWindow, isElement, isHTMLElement, materialImage } from './environment.ts';
import type { Rendered } from './markdown.ts';
export type { Rendered, MermaidBlock } from './markdown.ts';

const maps = new WeakMap<HTMLElement, Map<string,string>>();
const mounted = new WeakMap<HTMLElement, {html:string;nodes:globalThis.Node[]}[]>();
export function clearRendered(el:HTMLElement){maps.delete(el);mounted.delete(el);}
export async function renderInto(el: HTMLElement, rendered: Rendered, preserved = new Map<string, HTMLElement>(), current = () => true) {
  const focused = el.ownerDocument.activeElement;
  let previous=mounted.get(el);
  if(!previous){el.replaceChildren();previous=[];mounted.set(el,previous);}
  maps.set(el, rendered.atoms);
  let deadline=performance.now()+8;
  for(let index=0;index<rendered.blocks.length;index++){
    if(!current())return false;
    const html=rendered.blocks[index],old=previous[index];
    if(old?.html===html)continue;
    const template = el.ownerDocument.createElement('template'); template.innerHTML = html;
  // Browsers reuse mounted images with the same URL even with no-store; files can be overwritten.
  for (const img of template.content.querySelectorAll<HTMLImageElement>('img[src^="/api/files/image?"]')) {
    const target=new URL(img.getAttribute('src')!, 'http://localhost').searchParams.get('target');
    img.setAttribute('src', target && materialImage(target) || img.getAttribute('src') + '&v=' + crypto.randomUUID());
  }
  for (const slot of template.content.querySelectorAll<HTMLElement>('[data-mermaid]')) {
    const existing = preserved.get(slot.dataset.mermaid!);
    if (existing) slot.replaceWith(existing);
  }
    const nodes=[...template.content.childNodes];
    const anchor=old?.nodes.find(node=>node.parentNode===el);
    el.insertBefore(template.content,anchor||null);
    for(const node of old?.nodes||[])if(node.parentNode===el)el.removeChild(node);
    previous[index]={html,nodes};
    if(performance.now()>=deadline){
      const scheduler=(globalThis as typeof globalThis & {scheduler?:{yield:()=>Promise<void>}}).scheduler;
      if(scheduler?.yield)await scheduler.yield();else await new Promise(resolve=>setTimeout(resolve,0));
      deadline=performance.now()+8;
    }
  }
  if(!current())return false;
  for(const block of previous.splice(rendered.blocks.length))for(const node of block.nodes)if(node.parentNode===el)el.removeChild(node);
  if (isHTMLElement(focused) && el.contains(focused) && focused !== el.ownerDocument.activeElement) focused.focus({ preventScroll: true });
  for (const img of el.querySelectorAll<HTMLImageElement>('img:not(.mermaid-image):not([data-error-bound])')) {img.dataset.errorBound='';img.addEventListener('error', () => {
    const fallback = el.ownerDocument.createElement('span'); fallback.dataset.atom = img.dataset.atom;
    fallback.textContent = `图片无法读取：${img.alt || img.title}`; fallback.title = img.title;
    img.replaceWith(fallback);
  }, { once: true });}
  return true;
}
function overlaps(range: Range, node: Node | globalThis.Node): boolean {
  const r = (node as globalThis.Node).ownerDocument!.createRange(); r.selectNodeContents(node as globalThis.Node);
  const a = range.cloneRange(); a.collapse(true);
  const b = range.cloneRange(); b.collapse(false);
  const c = r.cloneRange(); c.collapse(true);
  const d = r.cloneRange(); d.collapse(false);
  return a.compareBoundaryPoints(Range.START_TO_START, d) < 0 && b.compareBoundaryPoints(Range.START_TO_START, c) > 0;
}

export function selectedSource(range: Range, scope: HTMLElement): string {
  const start = isElement(range.startContainer) ? range.startContainer : range.startContainer.parentElement;
  const selectedCode = start?.closest('pre code');
  // Highlight spans are presentation only: a selection inside code is literal text.
  if (selectedCode && selectedCode.contains(range.endContainer)) return range.toString();
  const output: string[] = [];
  const block = new Set(['P','DIV','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','PRE','TR']);
  let separator = '';
  const boundary = (value = '\n') => { if (value.length > separator.length) separator = value; };
  const append = (value: string) => { if (!value) return; if (output.length && separator && !output.at(-1)!.endsWith(separator)) output.push(separator); separator = ''; output.push(value); };
  const walk = (node: globalThis.Node) => {
    if (!overlaps(range, node)) return;
    if (isHTMLElement(node) && node.closest('[data-copy-ignore]')) return;
    if (isHTMLElement(node) && node.dataset.atom) {
      const owner = node.closest<HTMLElement>('.markdown');
      const raw = owner ? maps.get(owner)?.get(node.dataset.atom) : undefined;
      if (raw !== undefined) {
        const code = node.matches('pre code') ? node : node.querySelector('pre code');
        if (code && overlaps(range, code)) {
          const part = viewerDocument().createRange(); part.selectNodeContents(code);
          const startsInside = range.compareBoundaryPoints(Range.START_TO_START, part) > 0;
          const endsInside = range.compareBoundaryPoints(Range.END_TO_END, part) < 0;
          if (startsInside || endsInside) {
            if (startsInside) part.setStart(range.startContainer, range.startOffset);
            if (endsInside) part.setEnd(range.endContainer, range.endOffset);
            boundary(); append(part.toString()); boundary(); return;
          }
        }
        append(raw); return;
      }
    }
    if (node.nodeType === globalThis.Node.TEXT_NODE) {
      const begin = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.textContent!.length;
      append(node.textContent!.slice(begin,end)); return;
    }
    if (isHTMLElement(node) && block.has(node.tagName)) boundary(node.tagName === 'ARTICLE' ? '\n\n' : '\n');
    if (isHTMLElement(node) && node.tagName === 'BR') boundary();
    node.childNodes.forEach(walk);
    if (isHTMLElement(node) && block.has(node.tagName)) boundary(node.tagName === 'ARTICLE' ? '\n\n' : '\n');
    if (isHTMLElement(node) && ['TD','TH'].includes(node.tagName)) boundary('\t');
  };
  scope.childNodes.forEach(walk);
  return output.join('');
}

export function installCopy(scope: HTMLElement) {
  const copy = (event: ClipboardEvent) => {
    const target = event.target;
    if (isHTMLElement(target) && target.closest('textarea,input,[contenteditable="true"]')) return;
    const selection = viewerWindow().getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return;
    const text = selectedSource(range, scope);
    event.clipboardData.setData('text/plain',text); event.preventDefault();
  };
  scope.addEventListener('copy', copy);
  return () => scope.removeEventListener('copy', copy);
}
