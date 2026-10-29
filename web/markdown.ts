import { unified, type Processor } from 'unified';
import { materialVault, materialVaultRoot } from './environment.ts';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkBracketMath } from './math.ts';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { renderMath } from './katex.ts';
import type { MathDefinitions } from '../shared/tex-macros.ts';
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
export type Rendered = { html: string; blocks: string[]; atoms: Map<string, string>; diagrams: MermaidBlock[] };
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
export type MarkdownContext = { vault?: string; vaultRoot?: string; mathDefinitions?: MathDefinitions };
export function renderMarkdown(source: string, threadId?: string, cache = new Map<string, string>(), context: MarkdownContext = {vault:materialVault(),vaultRoot:materialVaultRoot()}): Rendered {
  const formatter = unified().use(highlightBlocks).use(renderMath, context.mathDefinitions).use(rehypeStringify);
  const mathContext = JSON.stringify(context.mathDefinitions || {});
  // Cached HTML cannot replay global macro definitions and their effects on later formulas.
  const cacheable = !/\\(?:gdef|xdef|global)\b/.test(source + Object.values(context.mathDefinitions || {}).join('\n'));
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
            if(/^file:/i.test(href)) {
              target='';
              try {
                const uri=new URL(href);
                if(!uri.hostname || uri.hostname==='localhost') {
                  target=decodeURIComponent(uri.pathname);
                  target=target.replace(/^\/([a-z]):\//i,(_,drive:string)=>'/mnt/'+drive.toLowerCase()+'/');
                  if(uri.hash && /^#L\d+$/.test(uri.hash))target+=uri.hash;
                }
              } catch { /* malformed local file URL */ }
            }
            if(href.startsWith('obsidian://open?') && context.vault){
              try{const uri=new URL(href);target=uri.searchParams.get('vault')===context.vault?uri.searchParams.get('file')||'':'';
                if(target.startsWith('/') || target.includes('\\') || target.split('/').some(p=>p==='..'||p==='.'))target='';
                if(target && context.vaultRoot)target=context.vaultRoot+'/'+target;
              }catch{target='';}
            }
            if(target && !/[\x00-\x1f\x7f]/.test(target) && !/^[a-z][a-z\d+.-]*:/i.test(target.replace(/:\d+(?::\d+)?$/,'')) && !target.startsWith('//')) {
              node.properties.dataFile=target; node.properties.tabIndex=0;node.properties.role='button';
              node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+target.split('/').at(-1)}]});
            }
          }
          if(node.properties.dataExternal)node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+new URL(href).hostname}]});
          if(!node.properties.dataExternal&&!node.properties.dataFile&&href)node.children.push({type:'element',tagName:'small',properties:{dataCopyIgnore:'',className:['link-target']},children:[{type:'text',value:' · '+href+'（暂不支持此链接格式）'}]});
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
  const blocks = clean.children.map(child => {
    const key = mathContext + JSON.stringify(child);
    const part = (cacheable ? cache.get(key) : undefined) ?? formatter.stringify(formatter.runSync({ type: 'root', children: [child] }) as HtmlRoot);
    if (cachedChars + key.length + part.length <= 2_000_000) {
      next.set(key, part);
      cachedChars += key.length + part.length;
    }
    return part;
  });
  cache.clear();
  for (const [key, part] of next) cache.set(key, part);
  return { html: blocks.join(''), blocks, atoms, diagrams };
}

