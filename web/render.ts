import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkBracketMath } from './math.ts';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { highlightBlocks } from './highlight.ts';
import rehypeStringify from 'rehype-stringify';
import type { Root as MarkdownRoot, Data } from 'mdast';
import type { Root as HtmlRoot, Element } from 'hast';
import type { Extension } from 'mdast-util-from-markdown';
declare module 'mdast' { interface Data { fenceClosed?: boolean; fenceSeen?: boolean } }

// Observe the existing tokenizer: quoted/list fences and partial closing markers
// must have exactly the same meaning here as they do in Markdown.
function remarkFenceState(this: Processor) {
  const extension: Extension = { enter: { codeFencedFence() {
    const node = this.stack.findLast(node => node.type === 'code')!;
    node.data ??= {};
    node.data.fenceClosed = !!node.data.fenceSeen;
    node.data.fenceSeen = true;
  } } };
  (this.data().fromMarkdownExtensions ??= []).push(extension);
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkMath).use(remarkBracketMath).use(remarkFenceState);
type Node = { type: string; lang?: string | null; value?: string; data?: Data; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
export type MermaidBlock = { id: string; source: string; closed: boolean };
export type Rendered = { html: string; atoms: Map<string, string>; diagrams: MermaidBlock[] };
const converter = unified().use(remarkRehype);
const sanitizer = unified().use(rehypeSanitize, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] || []), 'dataAtom','dataCopyIgnore','dataMermaid'],
      a: [...(defaultSchema.attributes?.a || []), 'target', 'rel','dataFile','dataExternal','tabIndex','role'],
      small:['className','dataCopyIgnore'],
      code: [...(defaultSchema.attributes?.code || []).filter(a=>(Array.isArray(a)?a[0]:a)!=='className'), ['className', /^language-./, 'math-inline', 'math-display']],
    },
  });
const formatter = unified().use(highlightBlocks)
    .use(rehypeKatex, { trust: false, throwOnError: false, maxExpand: 500 }).use(rehypeStringify);
export function renderMarkdown(source: string, threadId?: string, cache = new Map<string, string>()): Rendered {
  const tree = parser.parse(source);
  const atoms = new Map<string,string>();
  const positions = new Map<string,string>();
  const diagrams: MermaidBlock[] = [];
  const visit = (node: Node) => {
    if (['math','inlineMath','code','inlineCode','link','linkReference','image','imageReference'].includes(node.type) && node.position) {
      const { start, end } = node.position;
      if (start.offset !== undefined && end.offset !== undefined) {
        const id = `a${atoms.size}`; atoms.set(id, source.slice(start.offset, end.offset));
        positions.set(`${start.offset}:${end.offset}`, id);
        if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' && node.data?.fenceSeen) {
          diagrams.push({ id: String(start.offset), source: node.value || '', closed: !!node.data.fenceClosed });
        }
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  const diagramStarts = new Set(diagrams.map(block => block.id));
  const root = converter.runSync(tree as MarkdownRoot);
  {
    const walk = (node: HtmlRoot | Element | HtmlRoot['children'][number]) => {
      if (node.type === 'element') {
        const key = `${node.position?.start.offset}:${node.position?.end.offset}`;
        const id = positions.get(key);
        if (id) node.properties.dataAtom = id;
        if (node.tagName === 'pre' && diagramStarts.has(String(node.position?.start.offset))) node.properties.dataMermaid = String(node.position!.start.offset);
        // Remote images must never load merely because a model emitted Markdown.
        if (node.tagName === 'img') {
          let target = '';
          try { target = decodeURIComponent(String(node.properties.src || '')); } catch { /* incomplete URL */ }
          if (threadId && target && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('//')) {
            node.properties.src = '/api/files/image?' + new URLSearchParams({ threadId, target });
            node.properties.title = target;
          } else {
            node.tagName = 'span'; node.children = [{ type:'text', value: `[图片：${node.properties.alt || 'image'}]` }];
            delete node.properties.src; delete node.properties.alt;
          }
        }
        if (node.tagName === 'a') {
          const href = String(node.properties.href || '');
          if (/^https?:\/\//i.test(href)) {try{new URL(href);node.properties.dataExternal=href;}catch{delete node.properties.href;}}
          else {
            delete node.properties.href;
            let target = '';
            // HAST URLs are URI-encoded; file APIs and the clipboard take native paths.
            try { target = decodeURIComponent(href); } catch { /* incomplete URL */ }
            if(target && !/[\x00-\x1f\x7f]/.test(target) && !/^[a-z][a-z\d+.-]*:/i.test(target.replace(/:\d+(?::\d+)?$/,'')) && !target.startsWith('//')) {
              node.properties.dataFile=target; node.properties.tabIndex=0;node.properties.role='button';
              node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+target.split('/').at(-1)}]});
            }
          }
          if(node.properties.dataExternal)node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+new URL(href).hostname}]});
          if(!node.properties.dataExternal&&!node.properties.dataFile&&href)node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+href+'（不可打开）'}]});
          node.properties.target = '_blank'; node.properties.rel = ['noopener','noreferrer'];
        }
      }
      if ('children' in node) {
        node.children.forEach(walk);
        node.children = node.children.map(child => {
          if (child.type !== 'element' || !child.properties.dataAtom) return child;
          // KaTeX replaces its input node; keep source ownership on an outer node.
          if (!['code','pre'].includes(child.tagName)) return child;
          const classes = child.properties.className || [];
          const math = Array.isArray(classes) && classes.some(c => /^(math-|language-math)/.test(String(c)));
          if (!math && child.tagName !== 'pre') return child;
          return {type:'element' as const,tagName:child.tagName === 'pre'?'div':'span',properties:{dataAtom:child.properties.dataAtom},children:[child]};
        });
      }
    };
    walk(root);
  }
  // Sanitize untrusted markup before the trusted KaTeX renderer adds its own MathML/styles.
  const clean = sanitizer.runSync(root);
  const next = new Map<string, string>();
  let cachedChars = 0;
  // Resolve references across the whole document before caching sanitized blocks.
  // ponytail: parsing still scans the full source; move it to a worker if long replies remain slow.
  const html = clean.children.map(child => {
    const key = JSON.stringify(child);
    const part = cache.get(key) ?? formatter.stringify(formatter.runSync({ type: 'root', children: [child] }) as HtmlRoot);
    if (cachedChars + key.length + part.length <= 2_000_000) {
      next.set(key, part);
      cachedChars += key.length + part.length;
    }
    return part;
  }).join('');
  cache.clear();
  for (const [key, part] of next) cache.set(key, part);
  return { html, atoms, diagrams };
}

const maps = new WeakMap<HTMLElement, Map<string,string>>();
export function renderInto(el: HTMLElement, rendered: Rendered, preserved = new Map<string, HTMLElement>()) {
  const focused = document.activeElement;
  const template = document.createElement('template'); template.innerHTML = rendered.html;
  // Browsers reuse mounted images with the same URL even with no-store; files can be overwritten.
  for (const img of template.content.querySelectorAll<HTMLImageElement>('img[src^="/api/files/image?"]')) {
    img.setAttribute('src', img.getAttribute('src') + '&v=' + crypto.randomUUID());
  }
  for (const slot of template.content.querySelectorAll<HTMLElement>('[data-mermaid]')) {
    const existing = preserved.get(slot.dataset.mermaid!);
    if (existing) slot.replaceWith(existing);
  }
  el.replaceChildren(template.content); maps.set(el, rendered.atoms);
  if (focused instanceof HTMLElement && el.contains(focused) && focused !== document.activeElement) focused.focus({ preventScroll: true });
  for (const img of el.querySelectorAll<HTMLImageElement>('img:not(.mermaid-image)')) img.addEventListener('error', () => {
    const fallback = document.createElement('span'); fallback.dataset.atom = img.dataset.atom;
    fallback.textContent = `图片无法读取：${img.alt || img.title}`; fallback.title = img.title;
    img.replaceWith(fallback);
  }, { once: true });
}
function overlaps(range: Range, node: Node | globalThis.Node): boolean {
  const r = document.createRange(); r.selectNodeContents(node as globalThis.Node);
  const a = range.cloneRange(); a.collapse(true);
  const b = range.cloneRange(); b.collapse(false);
  const c = r.cloneRange(); c.collapse(true);
  const d = r.cloneRange(); d.collapse(false);
  return a.compareBoundaryPoints(Range.START_TO_START, d) < 0 && b.compareBoundaryPoints(Range.START_TO_START, c) > 0;
}

export function selectedSource(range: Range, scope: HTMLElement): string {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
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
    if (node instanceof HTMLElement && node.closest('[data-copy-ignore]')) return;
    if (node instanceof HTMLElement && node.dataset.atom) {
      const owner = node.closest<HTMLElement>('.markdown');
      const raw = owner ? maps.get(owner)?.get(node.dataset.atom) : undefined;
      if (raw !== undefined) {
        const code = node.matches('pre code') ? node : node.querySelector('pre code');
        if (code && overlaps(range, code)) {
          const part = document.createRange(); part.selectNodeContents(code);
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
    if (node instanceof HTMLElement && block.has(node.tagName)) boundary(node.tagName === 'ARTICLE' ? '\n\n' : '\n');
    if (node instanceof HTMLElement && node.tagName === 'BR') boundary();
    node.childNodes.forEach(walk);
    if (node instanceof HTMLElement && block.has(node.tagName)) boundary(node.tagName === 'ARTICLE' ? '\n\n' : '\n');
    if (node instanceof HTMLElement && ['TD','TH'].includes(node.tagName)) boundary('\t');
  };
  scope.childNodes.forEach(walk);
  return output.join('');
}

export function installCopy(scope: HTMLElement) {
  const copy = (event: ClipboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('textarea,input,[contenteditable="true"]')) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return;
    const text = selectedSource(range, scope);
    event.clipboardData.setData('text/plain',text); event.preventDefault();
  };
  scope.addEventListener('copy', copy);
  return () => scope.removeEventListener('copy', copy);
}
