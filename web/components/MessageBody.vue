<script setup lang="ts">
import { viewerDocument, viewerWindow } from '../environment.ts';

import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { clearRendered, renderInto } from '../render.ts';
import { cancelMarkdown, markdownContextKey, renderMarkdownAsync } from '../markdown-client.ts';
import { mermaidKey, type DiagramView } from '../mermaid.ts';
import { transcriptMemoryKey } from '../transcript.ts';
import type { MathDefinitions } from '../../shared/tex-macros.ts';
const props = defineProps<{ source: string; markdown: boolean; threadId?: string; itemKey?: string; complete?: boolean; mathDefinitions?: MathDefinitions }>();
const emit = defineEmits<{ copy: [text: string]; layout: [element?: HTMLElement] }>();
const body = ref<HTMLElement>();
const painted = ref(false);
const mermaid = inject(mermaidKey)!;
const memory = inject(transcriptMemoryKey);
const diagrams = new Map<string, DiagramView>();
const owner=crypto.randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined, nextRenderAt = 0, pending = false, rendering=false, generation=0, disposed=false;
function clear() { generation++;cancelMarkdown(owner);clearTimeout(timer); timer = undefined;if(body.value)clearRendered(body.value);for (const view of diagrams.values()) view.dispose(); diagrams.clear(); }
watch(() => props.threadId, clear);
function selecting(){const selection=viewerWindow().getSelection();return !!(selection&&!selection.isCollapsed&&selection.anchorNode&&body.value?.closest('.conversation')?.contains(selection.anchorNode));}
async function paint() {
  timer = undefined;
  if (!body.value||disposed||rendering||selecting()) return;
  pending = false;
  if (!props.markdown) { clear(); body.value.textContent = props.source; painted.value=true; emit('layout', body.value); return; }
  rendering=true;
  const version=generation,source=props.source,threadId=props.threadId,complete=!!props.complete;
  const current=()=>!disposed&&generation===version&&!selecting();
  try{
  const key=JSON.stringify([threadId,props.itemKey||owner,markdownContextKey(props.mathDefinitions)]);
  const load=()=>renderMarkdownAsync(owner,source,threadId,props.mathDefinitions);
  const rendered = memory ? await memory.render(key,source,load,complete) : await load();
  if(!current()){if(!disposed)pending=true;return;}
  body.value.removeAttribute('title');
  const startedAt=performance.now();
  for (const [id, view] of diagrams) {
    if (!rendered.diagrams.some(block => block.id === id && block.source === view.source)) { view.dispose(); diagrams.delete(id); }
  }
  if(!await renderInto(body.value, rendered, new Map([...diagrams].map(([id, view]) => [id, view.element])),current)){if(!disposed)pending=true;return;}
  painted.value=true;
  for (const block of rendered.diagrams) {
    let view = diagrams.get(block.id);
    if (!view) {
      view = mermaid.create(block, body.value.querySelector<HTMLElement>(`pre[data-mermaid="${block.id}"]`)!, text => emit('copy', text), () => emit('layout'));
      diagrams.set(block.id, view);
    }
    view.update(block.closed || !!props.complete);
  }
  for (const pre of body.value.querySelectorAll('pre:not(.mermaid-block pre)')) {
    if(pre.querySelector('.code-toolbar'))continue;
    const code = pre.querySelector('code'); if (!code) continue;
    const toolbar = viewerDocument().createElement('div'); toolbar.className = 'code-toolbar'; toolbar.dataset.copyIgnore = '';
    const language = viewerDocument().createElement('span'); language.textContent = [...code.classList].find(c => c.startsWith('language-'))?.slice(9) || '代码';
    const button = viewerDocument().createElement('button'); button.type = 'button'; button.className = 'code-copy quiet'; button.textContent = '复制代码'; button.onclick = () => emit('copy', code.textContent || '');
    toolbar.append(language, button); pre.prepend(toolbar);
  }
  // Leave input/scrolling time between expensive long-message paints.
  nextRenderAt = performance.now() + Math.max(100, (performance.now() - startedAt) * 2);
  emit('layout', body.value);
  }catch(error){
    if(current()&&body.value){clear();body.value.textContent=source;body.value.title='Markdown 渲染失败：'+String(error);painted.value=true;emit('layout', body.value);}
  }finally{rendering=false;if(pending&&!disposed)schedule();}
}
function schedule() {
  if (!pending||rendering||disposed) return;
  clearTimeout(timer);
  const wait = props.complete || !props.markdown ? 0 : nextRenderAt - performance.now();
  if (wait <= 0) void paint(); else timer = setTimeout(()=>void paint(), wait);
}
watch([body, () => props.source, () => props.markdown, () => props.threadId, () => props.itemKey, () => props.complete, () => markdownContextKey(props.mathDefinitions)], () => { generation++;pending = true; schedule(); }, { flush: 'post' });
onMounted(() => viewerDocument().addEventListener('selectionchange', schedule));
onBeforeUnmount(() => { disposed=true;clear(); viewerDocument().removeEventListener('selectionchange', schedule); });
</script>
<template><div ref="body" class="markdown" :data-layout-pending="markdown && !painted ? '' : undefined"></div></template>
