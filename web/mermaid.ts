import { viewerDocument, viewerWindow, viewerRoot, isElement, isHTMLElement } from './environment.ts';
import type { InjectionKey } from 'vue';
import type { Mermaid, MermaidConfig } from 'mermaid';
import type { MermaidBlock } from './render.ts';

export const MAX_MERMAID_CHARS = 32_000;
const FONT = 'Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const PAPER = '#fffdf8';
let engine: Promise<Mermaid> | undefined, sequence = 0;
async function loadMermaid() {
  engine ??= import('mermaid').then(({ default: mermaid }) => {
    const config: MermaidConfig = {
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_CHARS, maxEdges: 500, htmlLabels: false,
      dompurifyConfig: { FORBID_TAGS: ['img', 'image', 'script', 'iframe', 'object', 'embed', 'style', 'link'], FORBID_ATTR: ['style', 'src', 'href', 'xlink:href'] },
      layout: 'dagre', look: 'classic', theme: 'base', fontFamily: FONT,
      themeVariables: { background: PAPER, primaryColor: '#ede9df', primaryTextColor: '#282620',
        primaryBorderColor: '#817766', lineColor: '#706759', secondaryColor: '#e7eeea',
        tertiaryColor: '#f2eadb', mainBkg: '#ede9df', textColor: '#282620', fontFamily: FONT },
      // Lock every root configuration key, including diagram-specific configuration.
      secure: [...new Set([...Object.keys(mermaid.mermaidAPI.defaultConfig), 'secure', 'htmlLabels'])],
    };
    mermaid.initialize(config);
    return mermaid;
  }).catch(() => { engine = undefined; throw new Error('图表组件加载失败，请检查本地服务后重试；若页面更新后仍失败，请刷新页面'); });
  return engine;
}

// Resource-bearing Mermaid syntax is rejected before its temporary DOM is built.
// ponytail: conservatively reject resource tokens in node metadata, even in labels;
// use per-diagram AST validation if needed. YAML aliases can turn a value into a key.
export function checkMermaidSource(source: string) {
  if (source.length > MAX_MERMAID_CHARS) throw new Error('图表超过 32,000 字符，请缩小图表后重试');
  const decoded = source.replace(/\\(?:\r\n?|\n)[ \t]*/g, '').replace(/\\(?:u([\da-fA-F]{4})|U([\da-fA-F]{8})|x([\da-fA-F]{2})|([\da-fA-F]{1,6})\s?|([^\r\n]))/g,
    (_, unicode: string, long: string, hex: string, css: string, escaped: string) => escaped ?? String.fromCodePoint(Math.min(parseInt(unicode || long || hex || css, 16), 0x10ffff)));
  if ((/@\s*\{/.test(decoded) && /\bimg\b/i.test(decoded)) || /\b(?:url|image|image-set)\s*\(|@import|<\s*(?:img|image|script|iframe|object|embed|style|link)\b/i.test(decoded)) {
    throw new Error('图表不支持外部资源、HTML 元素或 CSS 资源引用');
  }
}

export function standaloneSvg(svg: string): { svg: string; width: number; height: number } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || doc.querySelector('parsererror')) throw new Error('图表没有生成有效 SVG');
  // Mermaid already sanitizes output. Fail closed for features that would become
  // active when a downloaded SVG is opened as a document instead of as an image.
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== root.namespaceURI || ['script', 'foreignobject', 'image', 'iframe', 'object', 'embed', 'animate', 'set', 'animatetransform', 'animatemotion'].includes(element.localName.toLowerCase())) throw new Error('图表包含不支持的 SVG 元素');
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || (['href', 'src'].includes(attr.localName) && !attr.value.startsWith('#'))) throw new Error('图表包含外部引用或事件');
      if (attr.localName === 'style') checkCss(attr.value);
    }
    if (element.localName === 'style') checkCss(element.textContent || '');
  }
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('图表尺寸无效');
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.setAttribute('width', String(box[2])); root.setAttribute('height', String(box[3]));
  root.removeAttribute('style');
  const background = doc.createElementNS(root.namespaceURI, 'rect');
  for (const [key, value] of Object.entries({ x: box[0], y: box[1], width: box[2], height: box[3], fill: PAPER })) background.setAttribute(key, String(value));
  root.insertBefore(background, root.firstChild);
  return { svg: new XMLSerializer().serializeToString(root), width: box[2], height: box[3] };
}
function checkCss(css: string) {
  if (/@import|\\|(?:image|image-set)\s*\(/i.test(css) || /url\s*\(/i.test(css.replace(/url\(\s*["']?#[\w:.-]+["']?\s*\)/gi, ''))) throw new Error('图表包含不支持的 CSS 资源引用');
}

type Result = ReturnType<typeof standaloneSvg>;
type Cached = { result?: Result; error?: string; bytes: number };
type Job = { source: string; signal: AbortSignal; done: (value: Cached) => void };
export type DiagramView = { element: HTMLElement; source: string; update: (ready: boolean) => void; dispose: () => void };
export const mermaidKey: InjectionKey<ReturnType<typeof createMermaidRenderer>> = Symbol('mermaid');

export function createMermaidRenderer(root: () => HTMLElement | undefined) {
  const cache = new Map<string, Cached>(), views = new Set<DiagramView>();
  const visible = new Map<Element, (value: boolean) => void>();
  let bytes = 0, queue: Job[] = [], running = false, disposed = false;
  let observer: IntersectionObserver | undefined;
  let dialog: HTMLDialogElement | undefined, activeView: DiagramView | undefined;
  let scratch: HTMLDivElement | undefined;

  function remember(source: string, value: Cached) {
    const old = cache.get(source); if (old) bytes -= old.bytes;
    cache.delete(source); cache.set(source, value); bytes += value.bytes;
    while (cache.size > 32 || bytes > 4 * 1024 * 1024) {
      const first = cache.keys().next().value!; bytes -= cache.get(first)!.bytes; cache.delete(first);
    }
  }
  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        // ponytail: layouts require the DOM; serialize and yield between bounded
        // graphs. Move rendering to an isolated document if measured stalls warrant it.
        await new Promise(resolve => setTimeout(resolve, 0));
        const job = queue.shift(); if (!job) continue;
        if (job.signal.aborted) continue;
        const cached = cache.get(job.source);
        if (cached) { remember(job.source, cached); job.done(cached); continue; }
        let value: Cached;
        try {
          checkMermaidSource(job.source);
          const mermaid = await loadMermaid(); await viewerDocument().fonts.ready;
          if (job.signal.aborted || disposed) continue;
          scratch = viewerDocument().createElement('div'); scratch.className = 'mermaid-scratch';
          scratch.setAttribute('aria-hidden', 'true'); scratch.inert = true; viewerRoot().append(scratch);
          const { svg } = await mermaid.render(`viewer-mermaid-${++sequence}`, job.source, scratch);
          const result = standaloneSvg(svg);
          value = { result, bytes: new Blob([job.source, result.svg]).size };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          value = { error: message.slice(0, 600), bytes: new Blob([job.source, message]).size };
        } finally { scratch?.remove(); scratch = undefined; }
        if (!disposed) remember(job.source, value);
        if (!disposed && !job.signal.aborted) job.done(value);
      }
    } finally { running = false; }
  }
  function enqueue(source: string, signal: AbortSignal, done: Job['done']) {
    queue.push({ source, signal, done }); void drain();
  }
  function button(label: string, action: () => void) {
    const el = viewerDocument().createElement('button'); el.type = 'button'; el.className = 'quiet'; el.textContent = label; el.onclick = action; return el;
  }
  function download(url: string) {
    const link = viewerDocument().createElement('a'); link.href = url; link.download = 'diagram.svg'; link.click();
  }
  function enlarge(view: DiagramView, url: string, result: Result) {
    dialog?.close(); dialog?.remove(); activeView = view;
    const opener = viewerDocument().activeElement;
    const modal = viewerDocument().createElement('dialog'); dialog = modal; modal.className = 'mermaid-dialog';
    modal.setAttribute('aria-label', 'Mermaid 图表放大查看'); modal.dataset.copyIgnore = '';
    const toolbar = viewerDocument().createElement('div'); toolbar.className = 'mermaid-toolbar';
    const viewport = viewerDocument().createElement('div'); viewport.className = 'mermaid-viewport'; viewport.tabIndex = 0; viewport.setAttribute('aria-label', '图表，可拖动或使用方向键滚动');
    const img = viewerDocument().createElement('img'); img.src = url; img.alt = 'Mermaid 图表'; img.draggable = false;
    viewport.append(img);
    const scaleLabel = viewerDocument().createElement('output'); scaleLabel.setAttribute('aria-label', '缩放比例');
    let scale = 1;
    const fitScale = () => Math.min(1, (viewport.clientWidth - 32) / result.width, (viewport.clientHeight - 32) / result.height);
    function zoom(next: number) {
      const old = scale, cx = viewport.scrollLeft + viewport.clientWidth / 2, cy = viewport.scrollTop + viewport.clientHeight / 2;
      scale = Math.max(Math.min(.1, fitScale()), Math.min(4, next)); img.style.width = `${result.width * scale}px`; img.style.height = `${result.height * scale}px`;
      scaleLabel.textContent = scale < .01 ? '<1%' : `${Math.round(scale * 100)}%`;
      viewport.scrollLeft = cx * scale / old - viewport.clientWidth / 2; viewport.scrollTop = cy * scale / old - viewport.clientHeight / 2;
    }
    function fit() { zoom(fitScale()); }
    toolbar.append(button('适应窗口', fit), button('原始大小', () => zoom(1)), button('缩小', () => zoom(scale / 1.25)), scaleLabel,
      button('放大', () => zoom(scale * 1.25)), button('下载 SVG', () => download(url)), button('关闭', () => modal.close()));
    let drag: { x: number; y: number; left: number; top: number } | undefined;
    viewport.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); viewport.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; };
    viewport.onpointermove = e => { if (drag) { viewport.scrollLeft = drag.left - e.clientX + drag.x; viewport.scrollTop = drag.top - e.clientY + drag.y; } };
    viewport.onpointerup = e => { if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId); };
    viewport.onlostpointercapture = () => { drag = undefined; };
    modal.onkeydown = e => { if (['+', '=', '-', '0'].includes(e.key)) { e.preventDefault(); if (e.key === '0') fit(); else zoom(scale * (e.key === '-' ? 1 / 1.25 : 1.25)); } };
    modal.onclose = () => {
      modal.remove();
      if (dialog === modal) { dialog = undefined; activeView = undefined; }
      if (!disposed && isHTMLElement(opener) && opener.isConnected) opener.focus({ preventScroll: true });
    };
    modal.append(toolbar, viewport); viewerRoot().append(modal); modal.showModal(); fit();
  }

  function create(block: MermaidBlock, pre: HTMLElement, copy: (text: string) => void, changed: () => void): DiagramView {
    const element = viewerDocument().createElement('div'); element.className = 'mermaid-block'; element.dataset.mermaid = block.id;
    const toolbar = viewerDocument().createElement('div'); toolbar.className = 'mermaid-toolbar'; toolbar.dataset.copyIgnore = '';
    const label = viewerDocument().createElement('span'); label.textContent = 'Mermaid';
    const image = viewerDocument().createElement('img'); image.className = 'mermaid-image'; image.alt = 'Mermaid 图表（可切换源码或放大查看）'; image.hidden = true; image.draggable = false;
    const status = viewerDocument().createElement('p'); status.className = 'mermaid-status'; status.dataset.copyIgnore = ''; status.setAttribute('role', 'status');
    let ready = false, near = false, mode = false, dead = false, url = '', result: Result | undefined, failed = false;
    let request: AbortController | undefined, pending: Cached | undefined;
    const toggle = button('源码', () => { mode = !mode; display(); requestRender(); }); toggle.setAttribute('aria-pressed', 'false');
    const larger = button('放大', () => { if (result) enlarge(view, url, result); }); larger.disabled = true;
    const save = button('下载 SVG', () => download(url)); save.disabled = true;
    const retry = button('重试', () => { const hit = cache.get(block.source); if (hit) { bytes -= hit.bytes; cache.delete(block.source); } failed = false; pending = undefined; request?.abort(); request = undefined; requestRender(); }); retry.hidden = true;
    toolbar.append(label, toggle, button('复制源码', () => copy(block.source)), larger, save);
    pre.removeAttribute('data-mermaid'); pre.removeAttribute('data-atom');
    // The current outer source atom owns selection-copy, even when this subtree is reused.
    pre.querySelectorAll('[data-atom]').forEach(node => node.removeAttribute('data-atom'));
    pre.replaceWith(element); element.append(toolbar, image, status, retry, pre);
    function display() {
      image.hidden = !result || mode; pre.hidden = !!result && !mode;
      toggle.setAttribute('aria-pressed', String(mode));
      status.hidden = !!result;
      retry.hidden = !failed;
      if (!failed) status.textContent = !ready ? '等待图表代码完成…' : request ? '正在渲染图表…' : '图表进入阅读区域后渲染';
      changed();
    }
    function hasSelection() {
      const selection = viewerWindow().getSelection(); return !!selection && !selection.isCollapsed && !!selection.anchorNode && !!root()?.contains(selection.anchorNode);
    }
    function commit() {
      if (!pending || dead || hasSelection()) return;
      viewerDocument().removeEventListener('selectionchange', commit);
      const value = pending; pending = undefined; request = undefined;
      if (value.result) {
        result = value.result; url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
        image.onload = changed;
        image.onerror = () => {
          if (dead) return;
          if (activeView === view) dialog?.close();
          URL.revokeObjectURL(url); url = ''; result = undefined; failed = true;
          larger.disabled = true; save.disabled = true; status.textContent = 'SVG 图片无法加载，请重试或查看源码'; display();
        };
        image.src = url; larger.disabled = false; save.disabled = false;
      } else { failed = true; status.textContent = `无法渲染图表：${value.error}`; retry.hidden = false; }
      display();
    }
    function requestRender() {
      if (!ready || !near || mode || request || pending || result || failed || dead) return;
      request = new AbortController();
      enqueue(block.source, request.signal, value => { pending = value; commit(); if (pending) viewerDocument().addEventListener('selectionchange', commit); });
      display();
    }
    const view: DiagramView = { element, source: block.source,
      update(value) { ready = value; display(); requestRender(); },
      dispose() {
        if (dead) return;
        dead = true; request?.abort(); queue = queue.filter(job => !job.signal.aborted);
        observer?.unobserve(element); visible.delete(element); viewerDocument().removeEventListener('selectionchange', commit);
        if (activeView === view) { dialog?.close(); dialog?.remove(); dialog = undefined; activeView = undefined; }
        if (url) URL.revokeObjectURL(url); image.onload = null; image.onerror = null; pending = undefined; views.delete(view);
      },
    };
    observer ??= new IntersectionObserver(entries => { for (const entry of entries) visible.get(entry.target)?.(entry.isIntersecting); }, { root: root(), rootMargin: '200px' });
    visible.set(element, value => {
      near = value;
      if (!near && request && !pending) { request.abort(); request = undefined; queue = queue.filter(job => !job.signal.aborted); display(); }
      requestRender();
    });
    observer.observe(element); views.add(view); return view;
  }
  return { create, dispose() {
    disposed = true; for (const view of [...views]) view.dispose(); observer?.disconnect();
    queue = []; cache.clear(); bytes = 0; dialog?.close(); dialog?.remove();
    // An in-flight Mermaid render still owns its measuring DOM until it settles.
  } };
}
