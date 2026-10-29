<script setup lang="ts">
import { viewerDocument, viewerWindow, viewerRoot } from './environment.ts';

import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { createViewerStore, threadTitle, viewerKey } from './store.ts';
import Sidebar from './components/Sidebar.vue';
import Conversation from './components/Conversation.vue';
import SessionInfo from './components/SessionInfo.vue';
import Composer from './components/Composer.vue';
import ApprovalCard from './components/ApprovalCard.vue';
import FolderDialog from './components/FolderDialog.vue';
import NameDialog from './components/NameDialog.vue';
import SkillsDialog from './components/SkillsDialog.vue';
import UsageBar from './components/UsageBar.vue';
import WatchdogPanel from './components/WatchdogPanel.vue';
import SubagentPanel from './components/SubagentPanel.vue';
import { createTranscriptMemory, transcriptMemoryKey } from './transcript.ts';
const store = createViewerStore(); provide(viewerKey, store);
const transcriptMemory = createTranscriptMemory(); provide(transcriptMemoryKey, transcriptMemory);
const { current, draft, approvals } = store;
const folder = ref<InstanceType<typeof FolderDialog>>(), name = ref<InstanceType<typeof NameDialog>>(), skills = ref<InstanceType<typeof SkillsDialog>>();
const error = computed(() => {
  const detail=current.value?.turns?.at(-1)?.error;
  const message=detail && typeof detail==='object' && 'message' in detail ? String(detail.message) : detail ? String(detail) : '';
  return store.state.error || draft.value?.error || draft.value?.readError || (message==='Native outcome unknown; input was not replayed' ? '上一轮执行结果未知，旧消息未重发。' : message);
});
const conversation=ref<InstanceType<typeof Conversation>>();
const sidebarWidth = ref(280), sidebarCollapsed = ref(false), resizing = ref(false);
const sidebarVisible = computed(() => !sidebarCollapsed.value);
const auxiliary = ref<'watchdogs' | 'agents' | ''>(''), viewport = ref(viewerWindow().innerWidth), auxiliaryPanel = ref<HTMLElement>();
const overlay = computed(() => viewport.value - (sidebarVisible.value ? sidebarWidth.value : 36) - 360 < 640);
const watchdogCount = computed(() => store.state.watchdogs.filter(w => w.threadId === store.state.currentId && w.state !== 'deleted').length);
let panelTrigger: HTMLElement | null = null;
function closePanel() { auxiliary.value = ''; void nextTick(() => panelTrigger?.focus()); }
watch(()=>current.value?.id,()=>{if(current.value?.capabilities?.watchdogs===false)auxiliary.value='';});
function openPanel(panel: 'watchdogs' | 'agents') {
  if (auxiliary.value === panel) { closePanel(); return; }
  panelTrigger = viewerDocument().activeElement as HTMLElement;
  auxiliary.value = panel;
}
watch([overlay, auxiliary], ([modal, panel]) => {
  if (modal && panel && !viewerDocument().querySelector('dialog[open]')) void nextTick(() => auxiliaryPanel.value?.querySelector<HTMLButtonElement>('.auxiliary-tabs button')?.focus());
});
function panelKeys(event: KeyboardEvent) {
  if (!overlay.value || viewerDocument().querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
  if (event.key !== 'Tab') return;
  const controls = [...auxiliaryPanel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []].filter(el => el.getClientRects().length);
  const target = event.shiftKey ? controls.at(-1) : controls[0];
  if (viewerDocument().activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); target?.focus(); }
}
function windowResized() { viewport.value = viewerWindow().innerWidth; }
async function copyDirectory() { try { await viewerWindow().navigator.clipboard.writeText(current.value?.cwd || ''); store.toast('已复制项目路径'); } catch { store.toast('无法访问剪贴板，请选中路径复制'); } }
function setWidth(width: number) { if (Number.isFinite(width)) sidebarWidth.value = Math.min(480, Math.max(240, width)); }
try { setWidth(Number(viewerWindow().localStorage.getItem('viewer-sidebar-width') || 280)); sidebarCollapsed.value = viewerWindow().localStorage.getItem('viewer-sidebar-collapsed') === 'true'; } catch {}
watch([sidebarWidth, sidebarCollapsed], () => { try { viewerWindow().localStorage.setItem('viewer-sidebar-width', String(sidebarWidth.value)); viewerWindow().localStorage.setItem('viewer-sidebar-collapsed', String(sidebarCollapsed.value)); } catch {} });
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  void nextTick(() => viewerDocument().getElementById(sidebarVisible.value ? 'sidebar-collapse' : 'menu')?.focus());
}
function startResize(event: PointerEvent) { if (event.button !== 0) return; event.preventDefault(); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); resizing.value = true; }
function resize(event: PointerEvent) { if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) setWidth(event.clientX); }
function resizeKey(event: KeyboardEvent) {
  const width = { ArrowLeft: sidebarWidth.value - 16, ArrowRight: sidebarWidth.value + 16, Home: 240, End: 480 }[event.key];
  if (width !== undefined) { event.preventDefault(); setWidth(width); }
}
function hashChanged() { const id = location.hash.slice(1); if (id && id !== store.state.currentId) void store.selectThread(id); }
watch(() => store.state.currentId, id => { if (id && location.hash.slice(1) !== id) location.hash = id; else if(!id && location.hash) viewerWindow().history.replaceState(null,'',location.pathname+location.search); });
onMounted(() => { store.start(location.hash.slice(1)); viewerWindow().addEventListener('hashchange', hashChanged); viewerWindow().addEventListener('resize', windowResized); });
onBeforeUnmount(() => { store.dispose(); transcriptMemory.clear(); viewerWindow().removeEventListener('hashchange', hashChanged); viewerWindow().removeEventListener('resize', windowResized); });
</script>
<template>
  <a class="skip-link" href="#conversation">跳到对话正文</a>
  <div class="viewer-layout" :class="{ 'sidebar-collapsed': !sidebarVisible, resizing, 'panel-open': !!auxiliary && !overlay }" :style="{ '--sidebar-width': sidebarWidth + 'px' }">
  <Sidebar v-show="sidebarVisible" :inert="!!auxiliary && overlay" @new="folder?.show($event, !!$event)" @collapse="toggleSidebar" @find="conversation?.openSearch()" @rename="name?.show($event)">
    <div id="sidebar-resize" role="separator" tabindex="0" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="sidebar" :aria-valuenow="sidebarWidth" :aria-valuemin="240" :aria-valuemax="480" title="拖动调整宽度，双击恢复默认" @pointerdown="startResize" @pointermove="resize" @pointerup="($event.currentTarget as HTMLElement).releasePointerCapture($event.pointerId)" @lostpointercapture="resizing = false" @keydown="resizeKey" @dblclick="setWidth(280)"></div>
  </Sidebar>
  <aside v-if="!sidebarVisible" class="context-rail session-rail rail-collapsed" aria-label="会话栏" :inert="!!auxiliary && overlay">
    <button id="menu" class="rail-tab quiet" aria-label="展开会话栏" title="展开会话栏" aria-controls="sidebar" :aria-expanded="false" @click="toggleSidebar">展开会话</button>
  </aside>
  <main :inert="!!auxiliary && overlay">
    <header class="topbar"><div class="session-heading"><h1 id="title">{{ current ? threadTitle(current) : '开始一个新任务' }}</h1><div class="directory-line"><div id="cwd" class="subtle" :title="current?.cwd">{{ current?.cwd || '选择项目，让工作留在 WSL' }}</div><button v-if="current" class="quiet" aria-label="复制项目路径" @click="copyDirectory">复制路径</button></div></div><div class="topbar-actions"><SessionInfo v-if="current" :key="current.id" /><button id="rename" class="quiet" :hidden="!current" @click="name?.show()">重命名</button><button v-if="current?.capabilities?.watchdogs!==false" id="watchdogs-toggle" class="quiet" aria-label="展开 Watchdogs" aria-controls="watchdog-rail" :aria-expanded="auxiliary === 'watchdogs'" @click="openPanel('watchdogs')">Watchdog <span>{{ watchdogCount }}</span></button><button v-if="current?.capabilities?.subagents!==false" id="agents-toggle" class="quiet" aria-label="展开 Subagents" aria-controls="subagents" :aria-expanded="auxiliary === 'agents'" @click="openPanel('agents')">子代理 <span>{{ store.agents.value.length }}</span></button></div></header>
    <div id="error" role="alert" :hidden="!error">{{ error }}</div>
    <section class="reading-area"><Conversation ref="conversation" search-in-sidebar @find="sidebarCollapsed=false" :key="store.state.currentId" @new="folder?.show()" /></section>
    <section class="interaction-area" aria-label="输入与待处理请求">
    <section id="approvals" aria-label="待处理请求"><ApprovalCard v-for="r in approvals" :key="r.id" :request="r" /></section>
    <Composer @skills="skills?.show($event)" />
    </section>
    <div class="footnote"><UsageBar /><span class="copy-hint">选中复制保留 LaTeX · 回复可复制完整 Markdown</span></div>
  </main>
  <button v-if="auxiliary && overlay" class="panel-backdrop" aria-label="关闭辅助面板" tabindex="-1" @click="closePanel"></button>
  <section v-show="auxiliary" ref="auxiliaryPanel" class="auxiliary-panel" :class="{ overlay }" :role="overlay ? 'dialog' : undefined" :aria-modal="overlay ? true : undefined" aria-label="任务辅助面板" @keydown="panelKeys">
    <nav class="auxiliary-tabs" aria-label="辅助面板内容"><button class="quiet" :aria-pressed="auxiliary === 'watchdogs'" @click="auxiliary = 'watchdogs'">Watchdog</button><button class="quiet" :aria-pressed="auxiliary === 'agents'" @click="auxiliary = 'agents'">子代理</button></nav>
    <WatchdogPanel :expanded="auxiliary === 'watchdogs'" @close="closePanel" />
    <SubagentPanel :expanded="auxiliary === 'agents'" @close="closePanel" />
  </section>
  </div>
  <FolderDialog ref="folder" /><NameDialog ref="name" /><SkillsDialog ref="skills" />
  <div id="toast" role="status" :hidden="!store.state.toast">{{ store.state.toast }}</div>
</template>
