<script setup lang="ts">
import { computed, ref } from 'vue';
import { diffLanguage, splitDiffRows } from '../diff.ts';
import type { DiffLine, FileDiff } from '../diff.ts';
import { codeHtml, MAX_COLOR_CHARS } from '../highlight.ts';
const props = defineProps<{ diff: FileDiff; split?: boolean }>();
const limit = ref(500), viewport = ref<HTMLElement>();
const paired = computed(() => props.split ? splitDiffRows(props.diff.lines) : []);
const total = computed(() => props.diff.added === null ? (props.diff.raw || '').split('\n').length : props.split ? paired.value.length : props.diff.lines.length);
const fallback = computed(() => (props.diff.raw || '').split('\n').slice(0, limit.value).join('\n'));
const columns = computed(() => {
  const language = (props.diff.raw?.length || 0) > MAX_COLOR_CHARS ? 'text' : diffLanguage(props.diff.movePath || props.diff.path);
  const decorate = (line: DiffLine | null) => ({ line, html: line && ['context', 'add', 'delete'].includes(line.kind) ? codeHtml(line.text, language) : '' });
  return props.split
    ? [{ side: 'old', rows: paired.value.slice(0, limit.value).map(r => decorate(r.left)) }, { side: 'new', rows: paired.value.slice(0, limit.value).map(r => decorate(r.right)) }]
    : [{ side: 'unified', rows: props.diff.lines.slice(0, limit.value).map(decorate) }];
});
function scrollPane(event: Event) {
  if (!props.split) return;
  const source = event.currentTarget as HTMLElement;
  for (const pane of viewport.value?.querySelectorAll<HTMLElement>('.diff-pane') || []) if (pane !== source && pane.scrollTop !== source.scrollTop) pane.scrollTop = source.scrollTop;
}
function copySelection(event: ClipboardEvent) {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData || !viewport.value) return;
  const range = selection.getRangeAt(0);
  if (!viewport.value.contains(range.startContainer) || !viewport.value.contains(range.endContainer)) return;
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const pane = element?.closest<HTMLElement>('.diff-pane');
  const column = columns.value.find(c => c.side === pane?.dataset.side);
  if (!pane || !column) {
    if (!element?.closest('.diff-raw')) return;
    event.clipboardData.setData('text/plain', range.toString()); event.preventDefault(); event.stopPropagation(); return;
  }
  const pieces: { text: string; ending: string }[] = [];
  for (const code of pane.querySelectorAll<HTMLElement>('.diff-code')) {
    if (!range.intersectsNode(code)) continue;
    const part = document.createRange(); part.selectNodeContents(code);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    const line = column.rows[Number(code.dataset.row)]?.line;
    pieces.push({ text: part.toString(), ending: line?.ending || '\n' });
  }
  event.clipboardData.setData('text/plain', pieces.map((p, i) => p.text + (i < pieces.length - 1 ? p.ending : '')).join(''));
  event.preventDefault(); event.stopPropagation();
}
</script>
<template>
  <div class="diff-view">
    <p v-if="diff.note" class="diff-note" data-copy-ignore>{{ diff.note }}</p>
    <div ref="viewport" class="diff-scroll" tabindex="0" aria-label="文件差异" @copy="copySelection">
      <pre v-if="diff.added === null && diff.raw" class="diff-raw">{{ fallback }}</pre>
      <div v-else class="diff-columns" :class="{ split }">
        <section v-for="column in columns" :key="column.side" class="diff-pane" :data-side="column.side" :aria-label="column.side === 'old' ? '修改前片段' : column.side === 'new' ? '修改后片段' : '单栏差异'" @scroll="scrollPane">
          <div v-if="split" class="diff-side-title" data-copy-ignore>{{ column.side === 'old' ? '修改前' : '修改后' }}</div>
          <div class="diff-lines">
            <div v-for="(row, index) in column.rows" :key="index" class="diff-row" :class="row.line?.kind || 'empty'">
              <span v-if="row.line?.kind === 'hunk' || row.line?.kind === 'note'" class="diff-meta" data-copy-ignore>{{ row.line.text }}</span>
              <template v-else-if="row.line">
                <span class="diff-gutter" data-copy-ignore aria-hidden="true"><span v-if="column.side !== 'new'">{{ row.line.oldLine }}</span><span v-if="column.side !== 'old'">{{ row.line.newLine }}</span><span class="diff-sign">{{ row.line.kind === 'add' ? '+' : row.line.kind === 'delete' ? '−' : ' ' }}</span></span>
                <code class="diff-code" :data-row="index" v-html="row.html"></code>
              </template>
              <span v-else class="diff-gap" data-copy-ignore aria-hidden="true">&nbsp;</span>
            </div>
          </div>
        </section>
      </div>
    </div>
    <button v-if="total > limit" type="button" class="quiet diff-more" @click="limit += 500">继续显示 · 还有 {{ total - limit }} 行</button>
  </div>
</template>
