<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { Item, Turn } from '../../shared/protocol.ts';
import { activity } from '../activity.ts';
import { parseFileDiff, relativeDiffPath } from '../diff.ts';
import DiffView from './DiffView.vue';
import type { ItemView } from '../transcript.ts';
const props = defineProps<{ item: Item; turn: Turn; cwd?: string; view: ItemView }>();
const emit = defineEmits<{ copy: [text: string] }>();
const shown = shallowRef(props.item), openPaths = computed(() => new Set(props.view.files)), zoom = ref(''), dialog = ref<HTMLDialogElement>();
const layout = ref('split');
try { if (localStorage.getItem('viewer-diff-layout') === 'unified') layout.value = 'unified'; } catch {}
watch(layout, value => { try { localStorage.setItem('viewer-diff-layout', value); } catch {} });
const files = computed(() => Array.isArray(shown.value.changes) ? shown.value.changes.map(parseFileDiff) : []);
const selected = computed(() => files.value.find(f => f.path === zoom.value));
const info = computed(() => activity(shown.value, props.turn));
const status = computed(() => shown.value.status === 'declined' ? '已拒绝' : ({ running: '修改中', completed: '已完成', failed: '修改失败', cancelled: '已中断', unknown: '状态未知' } as Record<string, string>)[info.value.state] || '状态未知');
const totals = computed(() => files.value.some(f => f.added === null || f.removed === null) ? null : files.value.reduce((sum, f) => ({ added: sum.added + f.added!, removed: sum.removed + f.removed! }), { added: 0, removed: 0 }));
const failure = computed(() => typeof shown.value.error === 'string' ? shown.value.error : (shown.value.error as { message?: string } | undefined)?.message || '');
const path = (value: string) => relativeDiffPath(value, props.cwd);
let trigger: HTMLElement | undefined;
function heldSelection() { const selection = getSelection(); return !!selection && !selection.isCollapsed && !!selection.anchorNode && !!dialog.value?.contains(selection.anchorNode); }
function refresh() { if (!heldSelection()) shown.value = props.item; }
watch(() => props.item, refresh);
function toggle(file: string) { const next = new Set(openPaths.value); if (next.has(file)) next.delete(file); else next.add(file); props.view.files = [...next]; }
async function show(file: string, event: MouseEvent) {
  trigger = event.currentTarget as HTMLElement; zoom.value = file;
  document.addEventListener('selectionchange', refresh);
  await nextTick(); dialog.value?.showModal();
}
function close() {
  dialog.value?.close(); zoom.value = ''; document.removeEventListener('selectionchange', refresh); shown.value = props.item;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}
watch(files, () => { if (zoom.value && !selected.value) close(); });
onBeforeUnmount(() => { document.removeEventListener('selectionchange', refresh); dialog.value?.close(); });
</script>
<template>
  <section class="activity file-change" :class="[info.state, { declined: shown.status === 'declined' }]" data-kind="fileChange" aria-label="文件修改记录">
    <header class="activity-title file-change-heading"><span class="activity-label">修改 {{ files.length }} 个文件</span><span v-if="totals" class="diff-stats"><span class="diff-added">+{{ totals.added }}</span><span class="diff-removed">−{{ totals.removed }}</span></span><span class="activity-state">{{ status }}</span></header>
    <p v-if="failure" class="diff-note" role="alert">{{ failure }}</p>
    <p v-if="!files.length" class="diff-note">记录中没有可读取的文件变更</p>
    <div v-for="file in files" :key="file.path" class="diff-file" :data-path="file.path">
      <div class="diff-file-heading">
        <button type="button" class="diff-file-toggle quiet" :aria-expanded="openPaths.has(file.path)" @click="toggle(file.path)"><span class="diff-chevron" aria-hidden="true">{{ openPaths.has(file.path) ? '⌄' : '›' }}</span><span class="diff-path" :title="file.movePath ? file.path + ' → ' + file.movePath : file.path">{{ path(file.path) }}<template v-if="file.movePath"> → {{ path(file.movePath) }}</template></span><span class="diff-kind" :data-kind="file.kind">{{ file.label }}</span></button>
        <span v-if="file.added !== null" class="diff-stats"><span class="diff-added">+{{ file.added }}</span><span class="diff-removed">−{{ file.removed }}</span></span><span v-else class="diff-unknown">行数未知</span>
        <button type="button" class="quiet diff-expand" :aria-label="'放大查看 ' + path(file.movePath || file.path)" @click="show(file.path, $event)">放大查看</button>
      </div>
      <template v-if="openPaths.has(file.path)">
        <div class="diff-toolbar" data-copy-ignore><span>本次修改</span><button type="button" class="quiet" :disabled="file.raw === null" @click="emit('copy', file.raw!)">{{ file.kind === 'update' ? '复制原始 diff' : '复制内容' }}</button></div>
        <DiffView :diff="file" />
      </template>
    </div>
  </section>
  <Teleport to="body">
    <dialog v-if="zoom && selected" ref="dialog" class="diff-dialog" aria-label="查看文件变更" @cancel.prevent="close" @close="zoom && close()">
      <header class="diff-dialog-heading"><div><strong>文件变更</strong><span class="subtle">{{ files.length }} 个文件 · {{ status }}</span></div><div class="diff-layout" role="group" aria-label="对比方式"><button type="button" class="quiet" :aria-pressed="layout === 'unified'" @click="layout = 'unified'">单栏</button><button type="button" class="quiet" :aria-pressed="layout === 'split'" @click="layout = 'split'">左右对比</button></div><button type="button" class="quiet" aria-label="关闭文件变更" autofocus @click="close">✕</button></header>
      <div class="diff-workbench">
        <nav class="diff-file-nav" aria-label="变更文件"><button v-for="file in files" :key="file.path" type="button" class="quiet" :aria-current="file.path === zoom ? 'true' : undefined" :title="file.path" @click="zoom = file.path"><span class="diff-path">{{ path(file.movePath || file.path) }}</span><span class="diff-nav-meta"><span>{{ file.label }}</span><span v-if="file.added !== null" class="diff-stats"><span class="diff-added">+{{ file.added }}</span><span class="diff-removed">−{{ file.removed }}</span></span><span v-else>行数未知</span></span></button></nav>
        <section class="diff-focus">
          <div class="diff-toolbar"><span class="diff-path" :title="selected.path">{{ path(selected.path) }}<template v-if="selected.movePath"> → {{ path(selected.movePath) }}</template></span><button type="button" class="quiet" :disabled="selected.raw === null" @click="emit('copy', selected.raw!)">{{ selected.kind === 'update' ? '复制原始 diff' : '复制内容' }}</button></div>
          <DiffView :key="selected.path" :diff="selected" :split="layout === 'split'" />
        </section>
      </div>
    </dialog>
  </Teleport>
</template>
