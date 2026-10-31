<script setup lang="ts">
import { viewerDocument, viewerWindow, viewerRoot, isElement, isHTMLElement } from '../environment.ts';

import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, toRaw, watch } from 'vue';
import { defaultRangeExtractor, observeElementOffset, useVirtualizer } from '@tanstack/vue-virtual';
import type { DeepReadonly } from 'vue';
import type { Item, Thread } from '../../shared/protocol.ts';
import { runtimeName } from '../../shared/runtime.ts';
import { useViewer } from '../store.ts';
import { installCopy } from '../render.ts';
import { installLinks } from '../links.ts';
import { createMermaidRenderer, mermaidKey } from '../mermaid.ts';
import { groupReasoning, groupTraces, traceRows, itemView, messageSource, searchableText, transcriptMemoryKey, type TranscriptRow } from '../transcript.ts';
import MessageBody from './MessageBody.vue';
import ActivityBlock from './ActivityBlock.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import QuestionCard from './QuestionCard.vue';
import ReferenceDialog from './ReferenceDialog.vue';
import ReferenceCard from './ReferenceCard.vue';
import { referenceCategory, referenceSelectable } from '../../shared/references.ts';
import { createMathContextIndex } from '../math-context.ts';
const emit = defineEmits<{ new: []; find: [] }>();
const props = defineProps<{ thread?: DeepReadonly<Thread>; readonly?: boolean; searchInSidebar?:boolean }>();
const store = useViewer(), current = computed(() => props.readonly ? props.thread : store.current.value);
const threadId = computed(() => current.value?.id || (props.readonly ? store.state.selectedAgentId : store.state.currentId));
const targetTurn = computed(() => props.readonly ? '' : store.state.targetTurn);
const targetItem = computed(() => props.readonly ? '' : store.state.targetItem);
const referenceDialog=ref<InstanceType<typeof ReferenceDialog>>(), selecting=ref(false), selectedRecords=ref(new Set<string>());
const selectedTools=computed(()=>allRows.value.filter(r=>selectedRecords.value.has(r.key) && referenceCategory(r.original)==='tool').length);
function toggleRecord(row:TranscriptRow){const next=new Set(selectedRecords.value);if(next.has(row.key))next.delete(row.key);else next.add(row.key);selectedRecords.value=next;}
function clearToolRecords(){selectedRecords.value=new Set(allRows.value.filter(r=>selectedRecords.value.has(r.key) && referenceCategory(r.original)!=='tool').map(r=>r.key));}
function selectedInTrace(key:string){return selectedRecords.value.size?allRows.value.filter(r=>r.trace?.key===key && selectedRecords.value.has(r.key)).length:0;}
function forwardRecords(){const positions=allRows.value.filter(r=>selectedRecords.value.has(r.key)).map(r=>({turnId:r.turn.id,itemId:r.original.id}));void referenceDialog.value?.showSnapshot(threadId.value,positions);}
function referenceMessage(item:Item){return item.type==='userMessage'?current.value?.referenceMessages?.find(m=>m.id===item.clientId):undefined;}
function messageReferences(item:Item){const ids=referenceMessage(item)?.references || [];return current.value?.references?.filter(r=>ids.includes(r.id)) || [];}
const memory = inject(transcriptMemoryKey)!;
const reading = memory.reading(threadId.value), follow = ref(reading.follow);
function project(): TranscriptRow[] {
  // Only lightweight references span the whole history; detached copies are made for mounted rows.
  return groupTraces(groupReasoning((toRaw(current.value)?.turns || []).flatMap(turn => turn.items.map(item => ({ key: `${threadId.value}:${turn.id}:${item.id}`, original: toRaw(item) as Item, turn: { id: turn.id, status: turn.status, items: [] } })))));
}
const conversation = ref<HTMLElement>(), allRows = shallowRef(project()), heldTrace = ref('');
const mathIndex = createMathContextIndex();
const mathContexts = computed(() => mathIndex(allRows.value.map(row => row.original)));
const rows = computed(() => traceRows(allRows.value, reading, heldTrace.value, follow.value));
const rowIndices = computed(() => new Map(rows.value.map((row, index) => [row.key, index])));
const mermaid = createMermaidRenderer(() => conversation.value); provide(mermaidKey, mermaid);
const focusKey = ref(''), selectionRange = shallowRef<[number, number] | null>(null);
const estimate = (index: number) => ['agentMessage', 'plan'].includes(rows.value[index]?.original.type || '') ? 320 : rows.value[index]?.original.type === 'userMessage' ? 100 : 65;
const initialRect = { width: reading.width || 860, height: 800 }, padding = props.readonly ? 16 : 40;
const initialSizes = new Map(reading.measurements.map(item => [item.key, item.size]));
// The scroll offset is the viewport's top, not the end of the transcript.
const initialOffset = reading.follow ? Math.max(0, 2 * padding + rows.value.reduce((n, row, i) => n + (initialSizes.get(row.key) ?? estimate(i)), 0) - initialRect.height) : reading.offset;
let syncOffset:((scrolling?:boolean)=>void)|undefined;
const observeOffset:typeof observeElementOffset<HTMLElement>=(instance,callback)=>{
  const sync=(scrolling=false)=>{if(instance.scrollElement)callback(instance.scrollElement.scrollTop,scrolling);};
  syncOffset=sync;
  const cleanup=observeElementOffset(instance,callback);
  return ()=>{if(syncOffset===sync)syncOffset=undefined;cleanup?.();};
};
const virtualizer = useVirtualizer(computed(() => {
  const list = rows.value, focused = list.findIndex(row => row.key === focusKey.value), held = selectionRange.value;
  return { count: list.length, getScrollElement: () => conversation.value || null, estimateSize: estimate, getItemKey: (index: number) => list[index]!.key,
    anchorTo: 'start' as const,
    overscan: 4, paddingStart: padding, paddingEnd: padding,
    initialOffset, initialMeasurementsCache: reading.measurements, initialRect, observeElementOffset:observeOffset,
    rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = new Set(defaultRangeExtractor(range));
      if (focused >= 0) indices.add(focused);
      if (held) for (let i = held[0]; i <= held[1] && i < list.length; i++) indices.add(i);
      return [...indices].sort((a, b) => a - b);
    },
  };
}));
// This component owns scroll anchoring; the virtualizer only measures/positions rows.
virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = () => false;
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
    return [{ ...row, item, source: messageSource(item), message: ['agentMessage', 'userMessage', 'plan', 'handoff'].includes(item.type), virtual: v, view: itemView(reading, row.key) }];
  });
});
let frame = 0, layoutQueued = false, disposed = false, jumpedTo = '';
let userScrolling = false, waitingForScroll = false, resumeAtBottom = false, writtenOffset = initialOffset;
let removeCopy = () => {}, removeLinks = () => {}, resize: ResizeObserver | undefined;
async function copy(text: string) { try { await viewerWindow().navigator.clipboard.writeText(text); store.toast('已复制'); } catch { store.toast('无法访问剪贴板，请选中文字后复制'); } }
function selected() { const s = viewerWindow().getSelection(); return !!s && !s.isCollapsed && !!s.anchorNode && !!conversation.value?.contains(s.anchorNode); }
function rowKey(node: Node | null) { const el = isElement(node) ? node : node?.parentElement; return el && conversation.value?.contains(el) ? el.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey || '' : ''; }
function hold(event?: Event) {
  const s = viewerWindow().getSelection(), a = rows.value.findIndex(r => r.key === rowKey(s?.anchorNode || null)), b = rows.value.findIndex(r => r.key === rowKey(s?.focusNode || null));
  selectionRange.value = selected() && a >= 0 && b >= 0 ? [Math.min(a, b), Math.max(a, b)] : null;
  const focused = rowKey(event?.type === 'pointerdown' ? event.target as Node : viewerDocument().activeElement);
  if (focused || !viewerDocument().querySelector('dialog[open]')) focusKey.value = focused;
  heldTrace.value = viewerDocument().querySelector('dialog[open]') ? allRows.value.find(row => row.key === focusKey.value)?.trace?.key || '' : '';
  if (event?.type === 'selectionchange' && !selected()) schedule();
}
function measure(el: unknown) {
  if (isHTMLElement(el) && el.querySelector('[data-layout-pending]')) return;
  virtualizer.value.measureElement(isHTMLElement(el) ? el : null);
}
function contentLayout(element?: HTMLElement) {
  void nextTick(() => { if (!disposed) { measure(element?.closest('.virtual-row')); layout(); } });
}
function savePosition() {
  const el = conversation.value; if (!el) return;
  const v = virtualizer.value.getVirtualItems().find(v => v.end > el.scrollTop);
  reading.follow = follow.value; reading.offset = el.scrollTop; reading.width = el.clientWidth;
  if (v) { reading.anchor = String(v.key); reading.inset = el.scrollTop - v.start; }
}
function jump(index: number, inset = 0) {
  if (index < 0) return;
  follow.value = false; userScrolling = waitingForScroll = resumeAtBottom = false;
  reading.anchor = rows.value[index]!.key; reading.inset = inset;
  layout();
}
function toggleTrace(row: TranscriptRow) {
  const position = virtualizer.value.getVirtualItems().find(v => v.key === row.key);
  const inset = position && conversation.value ? conversation.value.scrollTop - position.start : 0;
  follow.value = false;
  itemView(reading, row.key).open = !row.traceOpen;
  jump(rows.value.findIndex(r => r.key === row.key), inset);
}
function layout() {
  if (layoutQueued || disposed) return;
  layoutQueued = true;
  // Commit row transforms and the anchor correction before the same browser paint.
  void nextTick(() => {
    layoutQueued = false;
    const el = conversation.value;
    if (!el || disposed || selected() || waitingForScroll) return;
    const index = rowIndices.value.get(reading.anchor);
    // Unmeasured rows can overflow the sizer; anchoring to that overflow remounts them in a loop.
    const offset = follow.value ? Math.max(0, virtualizer.value.getTotalSize() - el.clientHeight) : index === undefined ? el.scrollTop
      : (virtualizer.value.getOffsetForIndex(index, 'start')?.[0] ?? el.scrollTop) + reading.inset;
    if (Math.abs(el.scrollTop - offset) > 1) el.scrollTop = offset;
    writtenOffset = el.scrollTop;
    if (Math.abs((virtualizer.value.scrollOffset ?? 0) - el.scrollTop) > 1) syncOffset?.();
    reading.follow = follow.value; reading.offset = el.scrollTop; reading.width = el.clientWidth;
  });
}
async function paint() {
  frame = 0; if (disposed || selected()) return;
  allRows.value = project();
  await nextTick(); if (disposed) return;
  if (targetTurn.value && targetTurn.value !== jumpedTo) {
    if(targetItem.value){const found=allRows.value.find(r=>r.turn.id===targetTurn.value && r.original.id===targetItem.value);if(found?.trace)itemView(reading,found.trace.key).open=true;}
    const index = rows.value.findIndex(row => row.turn.id === targetTurn.value && (!targetItem.value || row.original.id===targetItem.value && !row.traceHeader));
    if (index >= 0) { jumpedTo = targetTurn.value; follow.value = false; jump(index); return; }
  }
  layout();
}
function schedule() { if (!frame && !disposed) frame = requestAnimationFrame(() => { void paint(); }); }
watch(() => store.state.revisions[threadId.value], schedule);
watch(virtualizer, layout);
watch(targetTurn, () => { jumpedTo = ''; schedule(); });
watch(targetItem, () => { jumpedTo = ''; schedule(); });
function scroll() {
  const el = conversation.value; if (!el) return;
  syncOffset?.(true);
  // Focus and scrollIntoView can move the viewport without a wheel/key event.
  if (Math.abs(el.scrollTop - writtenOffset) > 1) {
    if (!userScrolling) follow.value = el.scrollHeight - el.clientHeight - el.scrollTop < 1;
    waitingForScroll = false;
    if (resumeAtBottom && el.scrollHeight - el.clientHeight - el.scrollTop < 1) follow.value = true;
    savePosition();
  }
  layout();
}
function manualScroll(event: WheelEvent | KeyboardEvent | PointerEvent) {
  const el = conversation.value; if (!el || el.scrollHeight <= el.clientHeight) return;
  if ('deltaY' in event && event.ctrlKey) return;
  const editing = isElement(event.target) && event.target.closest('input, textarea, select, [contenteditable]');
  const readingUp = 'deltaY' in event ? event.deltaY < 0 : 'key' in event ? !editing && ['ArrowUp', 'PageUp', 'Home'].includes(event.key) : event.target === el && event.clientX >= el.getBoundingClientRect().right - (el.offsetWidth - el.clientWidth);
  const readingDown = 'deltaY' in event ? event.deltaY > 0 : 'key' in event ? !editing && ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) : readingUp;
  if (readingUp || readingDown) {
    resumeAtBottom = !readingUp || 'pointerId' in event;
    userScrolling = true;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 1;
    follow.value = resumeAtBottom && atBottom; savePosition();
    waitingForScroll = !('pointerId' in event) && (readingUp ? el.scrollTop > 0 : !atBottom);
  }
}
function scrollEnd() { userScrolling = waitingForScroll = resumeAtBottom = false; layout(); }
function latest() { userScrolling = waitingForScroll = resumeAtBottom = false; follow.value = true; layout(); }

const searchHost=computed(()=>props.searchInSidebar?viewerRoot().querySelector<HTMLElement>('#sidebar-conversation-search'):null);
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
function openSearch() { emit('find'); searchOpen.value = true; void nextTick(() => { searchInput.value?.focus(); searchInput.value?.select(); }); }
function closeSearch() { searchOpen.value = false; query.value = ''; hits.value = []; conversation.value?.focus(); }
function keys(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || viewerDocument().querySelector('dialog[open]')) return;
  const inAgent = !!(viewerDocument().activeElement as Element | null)?.closest('.agent-detail');
  if (!!props.readonly !== inAgent || !threadId.value) return;
  event.preventDefault(); openSearch();
}
onMounted(() => {
  removeCopy = installCopy(conversation.value!);
  removeLinks = installLinks(conversation.value!, () => threadId.value || undefined, store.report, store);
  viewerDocument().addEventListener('selectionchange', hold); viewerDocument().addEventListener('focusin', hold); viewerDocument().addEventListener('keydown', keys);
  let width = reading.width;
  resize = new ResizeObserver(() => {
    const next = conversation.value?.clientWidth || 0;
    if (width && next && next !== width) { reading.measurements = []; virtualizer.value.measure(); }
    width = next;
    layout();
  }); resize.observe(conversation.value!); schedule();
});
onBeforeUnmount(() => {
  reading.follow = follow.value; reading.measurements = virtualizer.value.takeSnapshot();
  if (selected()) viewerWindow().getSelection()?.removeAllRanges();
  disposed = true; clearTimeout(searchTimer); resize?.disconnect(); mermaid.dispose(); cancelAnimationFrame(frame);
  viewerDocument().removeEventListener('selectionchange', hold); viewerDocument().removeEventListener('focusin', hold); viewerDocument().removeEventListener('keydown', keys); removeCopy(); removeLinks();
});
defineExpose({openSearch});
</script>
<template>
  <div v-if="threadId" :class="searchInSidebar?'conversation-search-portal':'conversation-tools'" data-copy-ignore>
    <span v-if="!searchInSidebar && !readonly && store.state.hydrating" class="subtle" role="status">正在同步历史…</span>
    <button v-if="!searchOpen && !searchInSidebar" type="button" class="quiet conversation-find" @click="openSearch">查找对话</button>
    <div v-if="!readonly && store.draft.value?.catalog.capabilities?.references?.snapshot" class="conversation-reference-actions">
      <button type="button" class="quiet" :aria-pressed="selecting" @click="selecting=!selecting;selectedRecords=new Set()">{{ selecting?'取消多选':'选择转发' }}</button>
      <button type="button" class="quiet" :disabled="!store.draft.value?.catalog.capabilities?.references?.session" :title="store.draft.value?.catalog.capabilities?.references?.reason" @click="referenceDialog?.showSession(threadId)">引用此 Session 到…</button>
    </div>
    <Teleport :to="searchHost||'body'" :disabled="!searchHost"><div v-if="searchOpen" class="conversation-search" role="search" aria-label="查找对话">
      <input ref="searchInput" v-model="query" type="search" aria-label="查找当前对话" placeholder="查找完整对话记录" @keydown.enter.prevent="goHit($event.shiftKey ? -1 : 1)" @keydown.esc.prevent="closeSearch">
      <span class="subtle" role="status">{{ hits.length ? `${hitIndex + 1} / ${hits.length} 条` : query ? '没有匹配' : '' }}</span>
      <button class="quiet" :disabled="!hits.length" aria-label="上一条匹配" @click="goHit(-1)">↑</button><button class="quiet" :disabled="!hits.length" aria-label="下一条匹配" @click="goHit(1)">↓</button><button class="quiet" aria-label="关闭查找" @click="closeSearch">×</button>
      <p v-if="hits[hitIndex]" class="search-excerpt">{{ hits[hitIndex]!.text }}</p>
    </div></Teleport>
  </div>
  <div v-if="selecting" class="reference-selection-bar" role="region" aria-label="转发选择">
    <span role="status">已选 {{ selectedRecords.size }} 条 · 其中工具 {{ selectedTools }} 条</span><span class="subtle">默认只选文字；展开工具后可逐条勾选</span>
    <button v-if="selectedTools" type="button" class="quiet" @click="clearToolRecords">清除所选工具</button><button type="button" :disabled="!selectedRecords.size" @click="forwardRecords">转发到…</button>
  </div>
  <div :id="readonly ? 'agent-conversation' : 'conversation'" class="conversation" :class="{ 'has-history': rows.length }" ref="conversation" tabindex="0" :aria-label="readonly ? '子代理执行记录' : '对话记录'" @scroll="scroll" @scrollend="scrollEnd" @pointerdown.capture="scroll()" @pointerdown="hold($event); manualScroll($event)" @wheel.passive="manualScroll" @keydown="manualScroll">
    <div v-if="!current && !readonly && !threadId" class="welcome"><div class="eyebrow">YOUR WORK, IN FOCUS</div><h2>从一个项目开始。</h2><p>选择左侧已有对话，或选择项目目录新建任务。<br>选好项目后，即可设置模型、思考强度、Plan 和 Skills。</p><button id="welcome-new" class="primary" @click="emit('new')">选择项目，新建任务</button></div>
    <p v-if="!rows.length && !readonly && store.state.hydrating" class="subtle">正在读取对话…</p>
    <button v-if="!readonly && store.draft.value?.readError" class="quiet" @click="store.selectThread(threadId)">重新读取对话</button>
    <div v-if="rows.length" class="virtual-list" :style="{ height: virtualizer.getTotalSize() + 'px' }">
      <div v-for="row in visible" :key="row.key" :ref="measure" class="virtual-row" :data-index="row.virtual.index" :data-row-key="row.key" :style="{ transform: `translateY(${row.virtual.start}px)`, '--pending-height': row.virtual.size + 'px' }">
        <button v-if="row.traceHeader" type="button" class="quiet trace-toggle" :aria-expanded="row.traceOpen" :data-turn-id="row.turn.id" data-copy-ignore @pointerdown="follow = false" @click="toggleTrace(row)">
          <span aria-hidden="true">{{ row.traceOpen ? '▾' : '▸' }}</span><span>思考与工具</span><span class="subtle">{{ row.trace!.count }} 条<span v-if="row.trace!.active"> · 进行中</span></span><span class="trace-action">{{ row.traceOpen ? '收起' : '展开' }}</span>
          <strong v-if="selectedInTrace(row.trace!.key)">已选 {{ selectedInTrace(row.trace!.key) }} 条工具记录</strong>
        </button>
        <article v-else class="message" :data-turn-id="row.turn.id" :class="[row.item.type === 'userMessage' ? 'user' : row.message ? 'assistant' : 'tool', { 'trace-item': row.trace, 'reasoning-continues': row.reasoning && row.reasoning.lastKey !== row.key, 'target-turn': row.turn.id === targetTurn, 'search-hit': hits[hitIndex]?.key === row.key }]">
          <label v-if="selecting && referenceCategory(row.item)" class="record-select" data-copy-ignore><input type="checkbox" :checked="selectedRecords.has(row.key)" :disabled="!referenceSelectable(row.item,row.turn)" @change="toggleRecord(row)"> {{ referenceCategory(row.item)==='tool'?'选择此工具记录':'选择此消息' }}<span v-if="!referenceSelectable(row.item,row.turn)">（仍在生成）</span></label>
          <div class="message-header" data-copy-ignore :hidden="!row.message"><span v-if="row.message">{{ row.item.type === 'userMessage' ? (readonly ? '任务输入' : '你') : row.item.type === 'handoff' ? '接手记录' : runtimeName((row.item.source || current || {}) as {runtimeId?: 'codex'}) + (row.item.type === 'plan' ? ' · Plan' : '') }}</span><button v-if="row.item.type === 'agentMessage' || row.item.type === 'plan'" type="button" class="quiet" @click="copy(row.source)">复制 Markdown</button></div>
          <QuestionCard v-if="!readonly && row.item.type === 'agentMessage' && row.item.delivery === 'async' && row.item.questions?.length" :item="row.item" :turn="row.turn" />
          <MessageBody v-else-if="row.message" :source="referenceMessage(row.item)?.text ?? row.source" :markdown="row.item.type !== 'userMessage'" :thread-id="threadId" :item-key="row.key" :complete="row.turn.status !== 'inProgress'" :math-definitions="mathContexts.get(row.item.id)" @copy="copy" @layout="contentLayout" />
          <ReasoningBlock v-else-if="row.reasoning" :item="row.item" :turn="row.turn" :group="row.reasoning" :thread-id="threadId" :item-key="row.key" :math-definitions="mathContexts.get(row.item.id)" @copy="copy" @layout="contentLayout" />
          <ActivityBlock v-else :item="row.item" :turn="row.turn" :cwd="current?.cwd" :view="row.view" @copy="copy" />
          <ReferenceCard v-for="r in messageReferences(row.item)" :key="r.id" :reference="r" @toggle="layout" />
        </article>
      </div>
    </div>
  </div>
  <button :id="readonly ? 'agent-latest' : 'latest'" class="quiet latest" :hidden="follow" @click="latest">↓ 回到最新</button>
  <ReferenceDialog v-if="!readonly" ref="referenceDialog" />
</template>
<style scoped>
.reference-selection-bar{display:flex;align-items:center;gap:12px;padding:8px 20px;flex-wrap:wrap;border-bottom:1px solid var(--line,#d9d1c4)}.record-select{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px}.record-select input{accent-color:var(--accent,#8d6545)}
.conversation-reference-actions{display:flex;justify-content:flex-end;gap:8px}
</style>
