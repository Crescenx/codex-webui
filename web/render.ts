import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { highlightBlocks } from './highlight.ts';
import rehypeStringify from 'rehype-stringify';
import type { Root as MarkdownRoot } from 'mdast';
import type { Root as HtmlRoot, Element } from 'hast';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkMath);
type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
export type Rendered = { html: string; atoms: Map<string, string> };
export function renderMarkdown(source: string): Rendered {
  const tree = parser.parse(source);
  const atoms = new Map<string,string>();
  const positions = new Map<string,string>();
  const visit = (node: Node) => {
    if (['math','inlineMath','code','inlineCode','link','linkReference','image','imageReference'].includes(node.type) && node.position) {
      const { start, end } = node.position;
      if (start.offset !== undefined && end.offset !== undefined) {
        const id = `a${atoms.size}`; atoms.set(id, source.slice(start.offset, end.offset));
        positions.set(`${start.offset}:${end.offset}`, id);
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  const processor = unified().use(remarkRehype).use(() => (root: HtmlRoot) => {
    const walk = (node: HtmlRoot | Element | HtmlRoot['children'][number]) => {
      if (node.type === 'element') {
        const key = `${node.position?.start.offset}:${node.position?.end.offset}`;
        const id = positions.get(key);
        if (id) node.properties.dataAtom = id;
        // Remote images must never load merely because a model emitted Markdown.
        if (node.tagName === 'img') {
          node.tagName = 'span'; node.children = [{ type:'text', value: `[图片：${node.properties.alt || 'image'}]` }];
          delete node.properties.src; delete node.properties.alt;
        }
        if (node.tagName === 'a') {
          const href = String(node.properties.href || '');
          if (/^https?:\/\//i.test(href)) {try{new URL(href);node.properties.dataExternal=href;}catch{delete node.properties.href;}}
          else {
            delete node.properties.href;
            if(href && !/^[a-z][a-z\d+.-]*:/i.test(href.replace(/:\d+(?::\d+)?$/,'')) && !href.startsWith('//')) {
              node.properties.dataFile=href; node.properties.tabIndex=0;node.properties.role='button';
              node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+href.split('/').at(-1)}]});
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
  }).use(rehypeSanitize, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] || []), 'dataAtom','dataCopyIgnore'],
      a: [...(defaultSchema.attributes?.a || []), 'target', 'rel','dataFile','dataExternal','tabIndex','role'],
      small:['className','dataCopyIgnore'],
      code: [...(defaultSchema.attributes?.code || []), ['className', /^language-./, 'math-inline', 'math-display']],
    },
  }).use(highlightBlocks)
    .use(rehypeKatex, { trust: false, throwOnError: false, maxExpand: 500 }).use(rehypeStringify);
  // Sanitize untrusted markup before the trusted KaTeX renderer adds its own MathML/styles.
  const html = processor.stringify(processor.runSync(tree as MarkdownRoot));
  return { html, atoms };
}

const maps = new WeakMap<HTMLElement, Map<string,string>>();
export function renderInto(el: HTMLElement, source: string) {
  const rendered = renderMarkdown(source);
  el.innerHTML = rendered.html; maps.set(el, rendered.atoms);
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
      if (raw !== undefined) { append(raw); return; }
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
  scope.addEventListener('copy', event => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('textarea,input,[contenteditable="true"]')) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return;
    const text = selectedSource(range, scope);
    event.clipboardData.setData('text/plain',text); event.preventDefault();
  });
}
