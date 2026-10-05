<script setup lang="ts">
import { computed, defineAsyncComponent, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, toRaw, watch } from 'vue';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual';
import type { DeepReadonly } from 'vue';
import type { Item, Thread } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
import { installCopy } from '../render.ts';
import { installLinks } from '../links.ts';
import { createMermaidRenderer, mermaidKey } from '../mermaid.ts';
import { groupReasoning, groupTraces, traceRows, itemView, messageSource, searchableText, transcriptMemoryKey, type TranscriptRow } from '../transcript.ts';
import MessageBody from './MessageBody.vue';
import ActivityBlock from './ActivityBlock.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import QuestionCard from './QuestionCard.vue';
const McpAppBlock = defineAsyncComponent(() => import('./McpAppBlock.vue'));
const emit = defineEmits<{ new: [] }>();
const props = defineProps<{ thread?: DeepReadonly<Thread>; readonly?: boolean }>();
const store = useViewer(), current = computed(() => props.readonly ? props.thread : store.current.value);
const threadId = computed(() => current.value?.id || (props.readonly ? store.state.selectedAgentId : store.state.currentId));
const targetTurn = computed(() => props.readonly ? '' : store.state.targetTurn);
const memory = inject(transcriptMemoryKey)!;
const reading = memory.reading(threadId.value), follow = ref(reading.follow);
function project(): TranscriptRow[] {
  // Only lightweight references span the whole history; detached copies are made for mounted rows.
  return groupTraces(groupReasoning((toRaw(current.value)?.turns || []).flatMap(turn => turn.items.map(item => ({ key: `${threadId.value}:${turn.id}:${item.id}`, original: toRaw(item) as Item, turn: { id: turn.id, status: turn.status, items: [] } })))));
}
const conversation = ref<HTMLElement>(), allRows = shallowRef(project()), heldTrace = ref('');
const openApps = ref(new Set<string>());
const rows = computed(() => traceRows(allRows.value, reading, heldTrace.value, openApps.value));
const mermaid = createMermaidRenderer(() => conversation.value); provide(mermaidKey, mermaid);
const focusKey = ref(''), selectionRange = shallowRef<[number, number] | null>(null);
// ponytail: explicitly opened apps stay mounted; close unused apps to release their memory.
function retainApp(key: string, open: boolean) { if (open) openApps.value.add(key); else openApps.value.delete(key); }
const estimate = (index: number) => ['agentMessage', 'plan'].includes(rows.value[index]?.original.type || '') ? 320 : rows.value[index]?.original.type === 'userMessage' ? 100 : 65;
const initialOffset = reading.follow ? rows.value.reduce((n, _, i) => n + estimate(i), 0) : reading.offset;
const virtualizer = useVirtualizer(computed(() => {
  const list = rows.value, focused = list.findIndex(row => row.key === focusKey.value), held = selectionRange.value, pinned = [...openApps.value];
  return { count: list.length, getScrollElement: () => conversation.value || null, estimateSize: estimate, getItemKey: (index: number) => list[index]!.key,
    anchorTo: follow.value ? 'end' as const : 'start' as const, scrollEndThreshold: 100,
    overscan: 4, paddingStart: props.readonly ? 16 : 40, paddingEnd: props.readonly ? 16 : 40,
    initialOffset, initialMeasurementsCache: reading.measurements, initialRect: { width: reading.width || 860, height: 800 },
    rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = new Set(defaultRangeExtractor(range));
      if (focused >= 0) indices.add(focused);
      for (const key of pinned) { const index = list.findIndex(row => row.key === key); if (index >= 0) indices.add(index); }
      if (held) for (let i = held[0]; i <= held[1] && i < list.length; i++) indices.add(i);
      return [...indices].sort((a, b) => a - b);
    },
  };
}));
const snapshots = new Map<string, { original: Item; item: Item }>();
const visible = computed(() => {
  const items = virtualizer.value.getVirtualItems();
  const keep = new Set(items.map(v => String(v.key)));
  for (const key of snapshots.keys()) if (!keep.has(key)) snapshots.delete(key);
  return items.flatMap(v => {
    const row = rows.value[v.index]; if (!row) return [];
    let cached = snapshots.get(row.key);
    if (cached?.original !== row.original) { cached = { original: row.original, item: JSON.parse(JSON.stringify(row.original)) as Item }; snapshots.set(row.key, cached); }
    const item = cached!.item;
    return [{ ...row, item, source: messageSource(item), message: ['agentMessage', 'userMessage', 'plan'].includes(item.type), virtual: v, view: itemView(reading, row.key) }];
  });
});
let frame = 0, layoutFrame = 0, disposed = false, restoring = true, jumpedTo = '', lastOffset = 0;
let removeCopy = () => {}, removeLinks = () => {}, resize: ResizeObserver | undefined;
async function copy(text: string) { try { await navigator.clipboard.writeText(text); store.toast('已复制'); } catch { store.toast('无法访问剪贴板，请选中文字后复制'); } }
function selected() { const s = getSelection(); return !!s && !s.isCollapsed && !!s.anchorNode && !!conversation.value?.contains(s.anchorNode); }
function rowKey(node: Node | null) { const el = node instanceof Element ? node : node?.parentElement; return el && conversation.value?.contains(el) ? el.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey || '' : ''; }
function hold(event?: Event) {
  const s = getSelection(), a = rows.value.findIndex(r => r.key === rowKey(s?.anchorNode || null)), b = rows.value.findIndex(r => r.key === rowKey(s?.focusNode || null));
  selectionRange.value = selected() && a >= 0 && b >= 0 ? [Math.min(a, b), Math.max(a, b)] : null;
  const focused = rowKey(event?.type === 'pointerdown' ? event.target as Node : document.activeElement);
  if (focused || !document.querySelector('dialog[open]')) focusKey.value = focused;
  heldTrace.value = document.querySelector('dialog[open]') ? allRows.value.find(row => row.key === focusKey.value)?.trace?.key || '' : '';
  if (event?.type === 'selectionchange' && !selected()) schedule();
}
function measure(el: unknown) { virtualizer.value.measureElement(el instanceof HTMLElement ? el : null); }
function savePosition() {
  const el = conversation.value; if (!el || restoring) return;
  const v = virtualizer.value.getVirtualItems().find(v => v.end > el.scrollTop);
  reading.follow = follow.value; reading.offset = el.scrollTop; reading.width = el.clientWidth;
  if (v) { reading.anchor = String(v.key); reading.inset = el.scrollTop - v.start; }
}
async function jump(index: number, inset = 0) {
  if (index < 0) return;
  restoring = true;
  // Expanding a trace changes row indices; let the virtualizer consume the new list first.
  await nextTick(); if (disposed) return;
  virtualizer.value.scrollToIndex(index, { align: 'start', behavior: 'auto' });
  void nextTick(() => {
    const v = virtualizer.value.getVirtualItems().find(v => v.index === index);
    if (v && inset) virtualizer.value.scrollToOffset(v.start + inset);
    requestAnimationFrame(() => { if (!disposed) { restoring = false; savePosition(); } });
  });
}
function toggleTrace(row: TranscriptRow) {
  const position = virtualizer.value.getVirtualItems().find(v => v.key === row.key);
  const inset = position && conversation.value ? conversation.value.scrollTop - position.start : 0;
  follow.value = false;
  itemView(reading, row.key).open = !row.traceOpen;
  jump(rows.value.findIndex(r => r.key === row.key), inset);
}
function layout() {
  if (layoutFrame || disposed) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0; if (disposed || selected()) return;
    // A single write follows growth without leaving an index scroll fighting the user's wheel.
    if (follow.value && conversation.value) { conversation.value.scrollTop = conversation.value.scrollHeight; lastOffset = conversation.value.scrollTop; }
  });
}
async function paint() {
  frame = 0; if (disposed || selected()) return;
  savePosition(); allRows.value = project();
  await nextTick(); if (disposed) return;
  if (targetTurn.value && targetTurn.value !== jumpedTo) {
    const index = rows.value.findIndex(row => row.turn.id === targetTurn.value);
    if (index >= 0) { jumpedTo = targetTurn.value; follow.value = false; jump(index); return; }
  }
  if (restoring && rows.value.length) {
    if (follow.value) virtualizer.value.scrollToEnd();
    else jump(rows.value.findIndex(row => row.key === reading.anchor), reading.inset);
    requestAnimationFrame(() => { if (!disposed) restoring = false; });
  } else layout();
}
function schedule() { if (!frame && !disposed) frame = requestAnimationFrame(() => { void paint(); }); }
watch(() => store.state.revisions[threadId.value], schedule);
watch(virtualizer, layout);
watch(targetTurn, () => { jumpedTo = ''; schedule(); });
function scroll() {
  const el = conversation.value; if (!el) return;
  // Allow layout slack while following; after a manual scroll, only resume at the actual bottom.
  if (!restoring && Math.abs(el.scrollTop - lastOffset) > 1) follow.value = el.scrollHeight - el.clientHeight - el.scrollTop < (follow.value ? 100 : 1);
  lastOffset = el.scrollTop; savePosition();
}
function manualScroll(event: WheelEvent | KeyboardEvent | PointerEvent) {
  const el = conversation.value; if (!el || el.scrollHeight <= el.clientHeight) return;
  const editing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]');
  const readingUp = event instanceof WheelEvent ? event.deltaY < 0 : event instanceof KeyboardEvent ? !editing && ['ArrowUp', 'PageUp', 'Home'].includes(event.key) : event.target === el && event.clientX >= el.getBoundingClientRect().right - (el.offsetWidth - el.clientWidth);
  if (readingUp) { follow.value = false; restoring = false; }
}
function latest() { follow.value = true; restoring = true; virtualizer.value.scrollToEnd(); requestAnimationFrame(() => { if (!disposed) { restoring = false; savePosition(); } }); }

const searchOpen = ref(false), query = ref(''), searchInput = ref<HTMLInputElement>(), hitIndex = ref(0);
const hits = shallowRef<{ key: string; text: string }[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchedQuery = '';
function search() {
  searchTimer = undefined;
  const previous = hits.value[hitIndex.value]?.key;
  const needle = query.value.trim().toLocaleLowerCase();
  const reset = needle !== searchedQuery; searchedQuery = needle;
  hits.value = needle ? allRows.value.flatMap(row => {
    const answer = !props.readonly && row.original.delivery === 'async' ? store.questionResponse(row.original).text : '';
    const text = searchableText(row.original, row.turn) + (answer ? '\n' + answer : '');
    const at = text.toLocaleLowerCase().indexOf(needle);
    return at < 0 ? [] : [{ key: row.key, text: text.slice(Math.max(0, at - 40), at + needle.length + 100).replace(/\s+/g, ' ') }];
  }) : [];
  hitIndex.value = reset ? 0 : Math.max(0, hits.value.findIndex(hit => hit.key === previous));
  if (reset && hits.value.length) goHit(0);
}
watch(query, () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 150); });
watch(allRows, () => { if (searchOpen.value && query.value && !searchTimer) searchTimer = setTimeout(search, 150); });
function goHit(step: number) {
  if (!hits.value.length) return;
  hitIndex.value = (hitIndex.value + step + hits.value.length) % hits.value.length;
  const hit = hits.value[hitIndex.value]!, row = allRows.value.find(row => row.key === hit.key); if (!row) return;
  if (row.trace) itemView(reading, row.trace.key).open = true;
  const view = itemView(reading, row.key); view.open = true;
  if (row.original.type === 'fileChange') view.files = (row.original.changes || []).filter(f => [f.path, f.diff, f.kind.type === 'update' ? f.kind.move_path : ''].join('\n').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())).map(f => f.path);
  follow.value = false; jump(rows.value.findIndex(row => row.key === hit.key));
}
function openSearch() { searchOpen.value = true; void nextTick(() => { searchInput.value?.focus(); searchInput.value?.select(); }); }
function closeSearch() { searchOpen.value = false; query.value = ''; hits.value = []; conversation.value?.focus(); }
function keys(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || document.querySelector('dialog[open]')) return;
  const inAgent = !!(document.activeElement as Element | null)?.closest('.agent-detail');
  if (!!props.readonly !== inAgent || !threadId.value) return;
  event.preventDefault(); openSearch();
}
onMounted(() => {
  removeCopy = installCopy(conversation.value!);
  removeLinks = installLinks(conversation.value!, () => threadId.value || undefined, store.report, store);
  document.addEventListener('selectionchange', hold); document.addEventListener('focusin', hold); document.addEventListener('keydown', keys);
  let width = reading.width;
  resize = new ResizeObserver(() => {
    const next = conversation.value?.clientWidth || 0;
    if (width && next && next !== width) { savePosition(); reading.measurements = []; virtualizer.value.measure(); if (follow.value) layout(); else jump(rows.value.findIndex(r => r.key === reading.anchor), reading.inset); }
    width = next;
  }); resize.observe(conversation.value!); schedule();
});
onBeforeUnmount(() => {
  savePosition(); reading.measurements = virtualizer.value.takeSnapshot();
  if (selected()) getSelection()?.removeAllRanges();
  disposed = true; clearTimeout(searchTimer); resize?.disconnect(); mermaid.dispose(); cancelAnimationFrame(frame); cancelAnimationFrame(layoutFrame);
  document.removeEventListener('selectionchange', hold); document.removeEventListener('focusin', hold); document.removeEventListener('keydown', keys); removeCopy(); removeLinks();
});
</script>
<template>
  <div v-if="threadId" class="conversation-tools" data-copy-ignore>
    <span v-if="!readonly && store.state.hydrating" class="subtle" role="status">正在同步历史…</span>
    <button v-if="!searchOpen" type="button" class="quiet conversation-find" @click="openSearch">查找对话</button>
    <div v-else class="conversation-search" role="search" aria-label="查找对话">
      <input ref="searchInput" v-model="query" type="search" aria-label="查找当前对话" placeholder="查找完整对话记录" @keydown.enter.prevent="goHit($event.shiftKey ? -1 : 1)" @keydown.esc.prevent="closeSearch">
      <span class="subtle" role="status">{{ hits.length ? `${hitIndex + 1} / ${hits.length} 条` : query ? '没有匹配' : '' }}</span>
      <button class="quiet" :disabled="!hits.length" aria-label="上一条匹配" @click="goHit(-1)">↑</button><button class="quiet" :disabled="!hits.length" aria-label="下一条匹配" @click="goHit(1)">↓</button><button class="quiet" aria-label="关闭查找" @click="closeSearch">×</button>
      <p v-if="hits[hitIndex]" class="search-excerpt">{{ hits[hitIndex]!.text }}</p>
    </div>
  </div>
  <div :id="readonly ? 'agent-conversation' : 'conversation'" class="conversation" :class="{ 'has-history': rows.length }" ref="conversation" tabindex="0" :aria-label="readonly ? '子代理执行记录' : '对话记录'" @scroll="scroll" @pointerdown="hold($event); manualScroll($event)" @wheel.passive="manualScroll" @keydown="manualScroll">
    <div v-if="!current && !readonly && !threadId" class="welcome"><div class="eyebrow">YOUR WORK, IN FOCUS</div><h2>从一个项目开始。</h2><p>选择左侧已有对话，或选择项目目录新建任务。<br>选好项目后，即可设置模型、思考强度、Plan 和 Skills。</p><button id="welcome-new" class="primary" @click="emit('new')">选择项目，新建任务</button></div>
    <p v-if="!rows.length && !readonly && store.state.hydrating" class="subtle">正在读取对话…</p>
    <button v-if="!readonly && store.draft.value?.readError" class="quiet" @click="store.selectThread(threadId)">重新读取对话</button>
    <div v-if="rows.length" class="virtual-list" :style="{ height: virtualizer.getTotalSize() + 'px' }">
      <div v-for="row in visible" :key="row.key" :ref="measure" class="virtual-row" :data-index="row.virtual.index" :data-row-key="row.key" :style="{ transform: `translateY(${row.virtual.start}px)` }">
        <button v-if="row.traceHeader" type="button" class="quiet trace-toggle" :aria-expanded="row.traceOpen" :data-turn-id="row.turn.id" data-copy-ignore @pointerdown="follow = false" @click="toggleTrace(row)">
          <span aria-hidden="true">{{ row.traceOpen ? '▾' : '▸' }}</span><span>思考与工具</span><span class="subtle">{{ row.trace!.count }} 条<span v-if="row.trace!.active"> · 进行中</span></span><span class="trace-action">{{ row.traceOpen ? '收起' : '展开' }}</span>
        </button>
        <article v-else class="message" :data-turn-id="row.turn.id" :class="[row.item.type === 'userMessage' ? 'user' : row.message ? 'assistant' : 'tool', { 'trace-item': row.trace, 'reasoning-continues': row.reasoning && row.reasoning.lastKey !== row.key, 'target-turn': row.turn.id === targetTurn, 'search-hit': hits[hitIndex]?.key === row.key }]">
          <div class="message-header" data-copy-ignore :hidden="!row.message"><span v-if="row.message">{{ row.item.type === 'userMessage' ? (readonly ? '任务输入' : '你') : row.item.type === 'plan' ? 'Codex · Plan' : 'Codex' }}</span><button v-if="row.item.type === 'agentMessage' || row.item.type === 'plan'" type="button" class="quiet" @click="copy(row.source)">复制 Markdown</button></div>
          <QuestionCard v-if="!readonly && row.item.type === 'agentMessage' && row.item.delivery === 'async' && row.item.questions?.length" :item="row.item" :turn="row.turn" />
          <MessageBody v-else-if="row.message" :source="row.source" :markdown="row.item.type !== 'userMessage'" :thread-id="threadId" :item-key="row.key" :complete="row.turn.status !== 'inProgress'" @copy="copy" @layout="layout" />
          <ReasoningBlock v-else-if="row.reasoning" :item="row.item" :turn="row.turn" :group="row.reasoning" :thread-id="threadId" :item-key="row.key" @copy="copy" @layout="layout" />
          <McpAppBlock v-else-if="row.item.type === 'mcpToolCall'" :item="row.item" :turn="row.turn" :thread-id="threadId" :cwd="current?.cwd" :view="row.view" :readonly="readonly" @copy="copy" @active="retainApp(row.key, $event)" @layout="layout" />
          <ActivityBlock v-else :item="row.item" :turn="row.turn" :cwd="current?.cwd" :view="row.view" @copy="copy" />
        </article>
      </div>
    </div>
  </div>
  <button :id="readonly ? 'agent-latest' : 'latest'" class="quiet latest" :hidden="follow" @click="latest">↓ 回到最新</button>
</template>
