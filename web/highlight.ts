import { common, createLowlight } from 'lowlight';
import { toHtml } from 'hast-util-to-html';
import Convert from 'ansi-to-html';
import ansiRegex from 'ansi-regex';
import type { Element, Root, RootContent } from 'hast';

// One engine for Markdown and commands, not one grammar registry per streamed render.
const syntax = createLowlight(common);
const cache = new Map<string, RootContent[]>();
let cachedChars = 0;
export const MAX_COLOR_CHARS = 32_768;
const CACHE_CHARS = 262_144;
const plain = (value:string): RootContent[] => [{type:'text',value}];

/** Cached trees are read-only to callers. Source text is never normalized. */
export function highlightCode(source:string, language:string): RootContent[] {
  // ponytail: synchronous coloring is bounded; larger blocks keep all text uncolored.
  // Move tokenization to a worker only if large-block coloring becomes necessary.
  if(source.length>MAX_COLOR_CHARS || !syntax.registered(language))return plain(source);
  const key=language+'\0'+source;
  const hit=cache.get(key);
  if(hit){cache.delete(key);cache.set(key,hit);return hit;}
  let nodes:RootContent[];
  try {nodes=syntax.highlight(language,source).children;} catch {return plain(source);}
  cache.set(key,nodes);cachedChars+=key.length;
  while(cache.size>64 || cachedChars>CACHE_CHARS){const oldest=cache.keys().next().value!;cachedChars-=oldest.length;cache.delete(oldest);}
  return nodes;
}

export function codeHtml(source:string, language='bash'):string {
  return toHtml({type:'root',children:highlightCode(source,language)});
}

/** Rehype adapter: run after sanitization, before KaTeX. */
export function highlightBlocks() {
  return (root:Root) => {
    const walk=(node:Root|RootContent,parent?:Root|Element):void=>{
      if(node.type==='element' && node.tagName==='code' && parent?.type==='element' && parent.tagName==='pre') {
        const classes=Array.isArray(node.properties.className)?node.properties.className.map(String):[];
        const language=classes.find(c=>c.startsWith('language-'))?.slice(9);
        if(language && !['math','text','txt'].includes(language) && !classes.some(c=>c==='no-highlight'||c==='nohighlight')) {
          const source=node.children.map(c=>c.type==='text'?c.value:'').join('');
          node.children=highlightCode(source,language) as Element['children'];
        }
        return;
      }
      if('children' in node)node.children.forEach(child=>walk(child,node));
    };
    walk(root);
  };
}

const sgr=/^\u001b\[[\d;]*m$/;
// Remove non-SGR controls (including OSC links/clipboard commands). Not a terminal emulator.
function cleanControls(source:string, keepColor=false):string {
  return source.replace(ansiRegex(),seq=>keepColor&&sgr.test(seq)?seq:'')
    .replace(/\u001b(?:\[[\d;]*|\][^\u0007\u001b]*)?$/,'');
}
export const outputText=(source:string)=>cleanControls(source);

const ansi=new Convert({escapeXML:true,stream:false,newline:false,
  fg:'var(--text-primary)',bg:'var(--bg-sidebar)',
  colors:['#aaa092','#dc9a8b','#a5b995','#d3b779','#acbbc6','#c5b3cb','#acbeb0','#e6dfd3',
    '#b8afa1','#e6aa9b','#bacaa8','#e3c793','#bdcbd5','#d5c3db','#bed0c2','#eee7db']});

export function outputHtml(source:string):string {
  if(source.length>MAX_COLOR_CHARS)return toHtml({type:'root',children:plain(outputText(source))});
  // Full snapshots reset styling: independent commands and split SSE codes cannot leak state.
  return ansi.toHtml(cleanControls(source,true))
    // Logs must not hide text or blink, even if the terminal stream asks for it.
    .replaceAll(' style="display:none"','').replaceAll('<blink>','').replaceAll('</blink>','');
}

const rendered=new WeakMap<HTMLElement,{source:string;language:string}>();
/** Skip unchanged DOM; outputs are only passed here when their details are open. */
export function highlightInto(el:HTMLElement,source:string,language='bash') {
  const previous=rendered.get(el);
  if(previous?.source===source && previous.language===language)return;
  const top=el.scrollTop,left=el.scrollLeft;
  el.innerHTML=language==='output'?outputHtml(source):codeHtml(source,language);
  el.scrollTop=top;el.scrollLeft=left;
  rendered.set(el,{source,language});
  el.title=source.length>MAX_COLOR_CHARS?'长文本以纯文本显示，保留完整内容':'';
}
