<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { renderInto, renderMarkdown } from '../render.ts';
import { mermaidKey, type DiagramView } from '../mermaid.ts';
const props = defineProps<{ source: string; markdown: boolean; threadId?: string; complete?: boolean }>();
const emit = defineEmits<{ copy: [text: string]; layout: [] }>();
const body = ref<HTMLElement>();
const mermaid = inject(mermaidKey)!;
const diagrams = new Map<string, DiagramView>();
const cache = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined, nextRenderAt = 0, pending = false;
function clear() { clearTimeout(timer); timer = undefined; cache.clear(); for (const view of diagrams.values()) view.dispose(); diagrams.clear(); }
watch(() => props.threadId, clear);
function paint() {
  timer = undefined;
  if (!body.value) return;
  const selection = getSelection();
  if (selection && !selection.isCollapsed && selection.anchorNode && body.value.closest('#conversation')?.contains(selection.anchorNode)) return;
  pending = false;
  if (!props.markdown) { clear(); body.value.textContent = props.source; emit('layout'); return; }
  const startedAt = performance.now();
  const rendered = renderMarkdown(props.source, props.threadId, cache);
  for (const [id, view] of diagrams) {
    if (!rendered.diagrams.some(block => block.id === id && block.source === view.source)) { view.dispose(); diagrams.delete(id); }
  }
  renderInto(body.value, rendered, new Map([...diagrams].map(([id, view]) => [id, view.element])));
  for (const block of rendered.diagrams) {
    let view = diagrams.get(block.id);
    if (!view) {
      view = mermaid.create(block, body.value.querySelector<HTMLElement>(`pre[data-mermaid="${block.id}"]`)!, text => emit('copy', text), () => emit('layout'));
      diagrams.set(block.id, view);
    }
    view.update(block.closed || !!props.complete);
  }
  for (const pre of body.value.querySelectorAll('pre:not(.mermaid-block pre)')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar'; toolbar.dataset.copyIgnore = '';
    const language = document.createElement('span'); language.textContent = [...code.classList].find(c => c.startsWith('language-'))?.slice(9) || '代码';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'code-copy quiet'; button.textContent = '复制代码'; button.onclick = () => emit('copy', code.textContent || '');
    toolbar.append(language, button); pre.prepend(toolbar);
  }
  if (props.complete) cache.clear();
  // Leave input/scrolling time between expensive long-message paints.
  nextRenderAt = performance.now() + Math.max(100, (performance.now() - startedAt) * 2);
  emit('layout');
}
function schedule() {
  if (!pending) return;
  clearTimeout(timer);
  const wait = props.complete || !props.markdown ? 0 : nextRenderAt - performance.now();
  if (wait <= 0) paint(); else timer = setTimeout(paint, wait);
}
watch([body, () => props.source, () => props.markdown, () => props.threadId, () => props.complete], () => { pending = true; schedule(); }, { flush: 'post' });
onMounted(() => document.addEventListener('selectionchange', schedule));
onBeforeUnmount(() => { clear(); document.removeEventListener('selectionchange', schedule); });
</script>
<template><div ref="body" class="markdown"></div></template>
