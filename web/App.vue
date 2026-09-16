<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { createViewerStore, threadTitle, viewerKey } from './store.ts';
import Sidebar from './components/Sidebar.vue';
import Conversation from './components/Conversation.vue';
import Composer from './components/Composer.vue';
import ApprovalCard from './components/ApprovalCard.vue';
import FolderDialog from './components/FolderDialog.vue';
import NameDialog from './components/NameDialog.vue';
import SkillsDialog from './components/SkillsDialog.vue';
import UsageBar from './components/UsageBar.vue';
import WatchdogPanel from './components/WatchdogPanel.vue';
import SubagentPanel from './components/SubagentPanel.vue';
const store = createViewerStore(); provide(viewerKey, store);
const { current, draft, approvals } = store;
const folder = ref<InstanceType<typeof FolderDialog>>(), name = ref<InstanceType<typeof NameDialog>>(), skills = ref<InstanceType<typeof SkillsDialog>>();
const error = computed(() => store.state.error || draft.value?.error || draft.value?.readError || (current.value?.turns?.at(-1)?.error ? JSON.stringify(current.value.turns.at(-1)!.error) : ''));
const sidebarWidth = ref(280), sidebarCollapsed = ref(false), resizing = ref(false);
const sidebarVisible = computed(() => !sidebarCollapsed.value);
function setWidth(width: number) { if (Number.isFinite(width)) sidebarWidth.value = Math.min(480, Math.max(240, width)); }
try { setWidth(Number(localStorage.getItem('viewer-sidebar-width') || 280)); sidebarCollapsed.value = localStorage.getItem('viewer-sidebar-collapsed') === 'true'; } catch {}
watch([sidebarWidth, sidebarCollapsed], () => { try { localStorage.setItem('viewer-sidebar-width', String(sidebarWidth.value)); localStorage.setItem('viewer-sidebar-collapsed', String(sidebarCollapsed.value)); } catch {} });
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  void nextTick(() => document.getElementById(sidebarVisible.value ? 'sidebar-collapse' : 'menu')?.focus());
}
function startResize(event: PointerEvent) { if (event.button !== 0) return; event.preventDefault(); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); resizing.value = true; }
function resize(event: PointerEvent) { if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) setWidth(event.clientX); }
function resizeKey(event: KeyboardEvent) {
  const width = { ArrowLeft: sidebarWidth.value - 16, ArrowRight: sidebarWidth.value + 16, Home: 240, End: 480 }[event.key];
  if (width !== undefined) { event.preventDefault(); setWidth(width); }
}
function hashChanged() { const id = location.hash.slice(1); if (id && (id !== store.state.currentId || store.state.hydrating)) void store.selectThread(id); }
watch(() => store.state.currentId, id => { if (id && location.hash.slice(1) !== id) location.hash = id; });
onMounted(() => { store.start(location.hash.slice(1)); window.addEventListener('hashchange', hashChanged); });
onBeforeUnmount(() => { store.dispose(); window.removeEventListener('hashchange', hashChanged); });
</script>
<template>
  <div class="viewer-layout" :class="{ 'sidebar-collapsed': !sidebarVisible, resizing }" :style="{ '--sidebar-width': sidebarWidth + 'px' }">
  <Sidebar v-show="sidebarVisible" @new="folder?.show($event, !!$event)" @collapse="toggleSidebar">
    <div id="sidebar-resize" role="separator" tabindex="0" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="sidebar" :aria-valuenow="sidebarWidth" :aria-valuemin="240" :aria-valuemax="480" title="拖动调整宽度，双击恢复默认" @pointerdown="startResize" @pointermove="resize" @pointerup="($event.currentTarget as HTMLElement).releasePointerCapture($event.pointerId)" @lostpointercapture="resizing = false" @keydown="resizeKey" @dblclick="setWidth(280)"></div>
  </Sidebar>
  <WatchdogPanel />
  <main>
    <header class="topbar"><button id="menu" class="quiet" aria-label="切换边栏" aria-controls="sidebar" :aria-expanded="sidebarVisible" @click="toggleSidebar">☰</button><div><h1 id="title">{{ current ? threadTitle(current) : '开始一个新任务' }}</h1><div id="cwd" class="subtle">{{ current?.cwd || '选择项目，让工作留在 WSL' }}</div></div><button id="rename" class="quiet" :hidden="!current" @click="name?.show()">重命名</button><span class="local-badge">LOCAL</span></header>
    <div id="error" role="alert" :hidden="!error">{{ error }}</div>
    <Conversation @new="folder?.show()" />
    <section id="approvals" aria-label="待处理请求"><ApprovalCard v-for="r in approvals" :key="r.id" :request="r" /></section>
    <Composer @skills="skills?.show()" />
    <div class="footnote"><UsageBar /><span class="copy-hint">选中复制保留 LaTeX · 回复可复制完整 Markdown</span></div>
  </main>
  <SubagentPanel />
  </div>
  <FolderDialog ref="folder" /><NameDialog ref="name" /><SkillsDialog ref="skills" />
  <div id="toast" role="status" :hidden="!store.state.toast">{{ store.state.toast }}</div>
</template>
