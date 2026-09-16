<script setup lang="ts">
import { computed, ref } from 'vue';
import { threadTitle, useViewer } from '../store.ts';
const emit = defineEmits<{ new: [path?: string]; selected: []; collapse: [] }>();
const store = useViewer(), { threads } = store;
const query = ref('');
const logo = new URL('../assets/icon.png', import.meta.url).href;
const groups = computed(() => {
  const roots = [...new Set(threads.value.map(t => t.projectRoot || t.cwd))];
  return roots.map(root => {
    const members = threads.value.filter(t => (t.projectRoot || t.cwd) === root).slice().sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const visible = members.filter(t => `${threadTitle(t)} ${t.cwd} ${root}`.toLowerCase().includes(query.value.toLowerCase()));
    const waiting = members.filter(t => store.status(t)[0] === 'attention').length, running = members.filter(t => store.status(t)[0] === 'running').length;
    return { root, members, visible, waiting, running };
  }).filter(g => g.visible.length).sort((a,b) => (b.members[0]?.updatedAt || 0) - (a.members[0]?.updatedAt || 0));
});
async function select(id: string) { await store.selectThread(id); emit('selected'); }
async function notifications() { if ('Notification' in window) store.toast(await Notification.requestPermission() === 'granted' ? '通知已开启' : '浏览器未允许通知'); }
</script>

<template>
  <aside id="sidebar" class="sidebar" aria-label="项目与会话">
    <div class="brand"><img class="brand-mark" :src="logo" alt="" width="36" height="36"><span>Codex <small>VIEWER</small></span><button id="sidebar-collapse" class="quiet" aria-label="收起侧栏" title="收起侧栏" @click="emit('collapse')">⇤</button></div>
    <button id="new" class="new-thread" :disabled="store.state.restarting || store.state.restartPending" @click="emit('new')">＋ 新任务</button>
    <label class="sr-only" for="search">搜索任务</label><input id="search" v-model="query" type="search" placeholder="搜索任务…">
    <div class="sidebar-heading"><span>项目</span><span>{{ groups.length }}</span></div>
    <nav id="threads" aria-label="任务列表">
      <section v-for="g in groups" :key="g.root" class="project">
        <div class="project-header">
          <button class="project-toggle quiet" :title="g.root" :aria-expanded="!store.state.collapsed[g.root] || !!query" @click="store.toggleProject(g.root)"><span class="project-chevron" aria-hidden="true">{{ store.state.collapsed[g.root] && !query ? '▸' : '▾' }}</span><svg class="project-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15Z"/></svg><span class="project-name">{{ g.root.split('/').at(-1) || g.root }}</span></button>
          <small :class="g.waiting ? 'attention' : g.running ? 'running' : ''" :title="`${g.members.length} 个会话`">{{ g.waiting ? `${g.waiting} 待审批` : g.running ? `${g.running} 运行中` : g.members.length }}</small>
          <button class="project-new quiet" title="在此项目新建对话" :aria-label="`在 ${g.root.split('/').at(-1)} 新建会话`" @click="emit('new', g.root)">＋</button>
        </div>
        <div v-if="!store.state.collapsed[g.root] || query" class="project-sessions">
          <button v-for="t in g.visible" :key="t.id" class="thread" :data-thread-id="t.id" :class="{ selected: t.id === store.state.currentId }" :aria-current="t.id === store.state.currentId ? 'page' : undefined" :title="threadTitle(t)" @click="select(t.id)">
            <strong>{{ threadTitle(t) }}</strong><span class="thread-meta"><span class="status" :class="store.status(t)[0]">{{ store.status(t)[1] }}</span><span v-if="t.cwd !== g.root" :title="t.cwd">{{ t.cwd.split('/').filter(Boolean).at(-1) || '/' }}</span></span>
          </button>
        </div>
      </section>
    </nav>
    <button id="more" class="quiet" :hidden="!store.state.cursor" @click="store.loadThreads(true)">加载更多</button>
    <footer><button id="refresh" class="quiet" @click="store.resync()">↻ 刷新</button><button id="notifications" class="quiet" @click="notifications">开启通知</button><button id="restart-backend" class="quiet" :disabled="store.state.restarting || store.state.restartPending" title="重启所有对话共用的 Codex 后端，重新加载程序和配置；保留历史与草稿，运行中的任务须先停止" @click="store.restartBackend()">{{ store.state.restarting || store.state.restartPending ? '正在重启…' : '重启 Codex 后端' }}</button><span id="connection" role="status">{{ store.state.connection }}</span></footer>
    <slot />
  </aside>
</template>
