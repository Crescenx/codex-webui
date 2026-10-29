<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DefaultPermissions from './DefaultPermissions.vue';
import DeleteThreadDialog from './DeleteThreadDialog.vue';
import { threadTitle, useViewer } from '../store.ts';
import { inWorkspace, workspacePath } from '../workspace-path.ts';
const props=defineProps<{flat?:boolean;title?:string;busy?:boolean;embedded?:boolean;cwd?:string}>();
const emit = defineEmits<{ new: [path?: string]; selected: []; collapse: []; find: []; rename: [id:string] }>();
const deletion=ref<InstanceType<typeof DeleteThreadDialog>>();
const store = useViewer(), { threads } = store;
const query = ref('');
const scope = ref(''), autoBlocked = ref(false);
const positions = new Map<string, number>();
const nav = ref<HTMLElement>(), more = ref<HTMLElement>(), loading = ref(false);
let observer: IntersectionObserver | undefined, generation = 0;
const logo = new URL('../assets/icon.png', import.meta.url).href;
const groups = computed(() => {
  const projects = new Map<string, (typeof threads.value)[number][]>();
  for (const t of threads.value) {
    if (props.cwd && !inWorkspace(props.cwd, t.cwd)) continue;
    const root = props.flat ? props.title || 'Vault Assistant' : workspacePath(t.projectRoot || t.cwd);
    if (!projects.has(root)) projects.set(root, []);
    projects.get(root)!.push(t);
  }
  const search = query.value.trim().toLowerCase();
  return [...projects].map(([root, members]) => {
    members.sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const visible = members.filter(t => `${threadTitle(t)} ${t.cwd} ${root}`.toLowerCase().includes(search));
    const waiting = members.filter(t => store.status(t)[0] === 'attention').length, running = members.filter(t => store.status(t)[0] === 'running').length;
    return { root, members, visible, waiting, running };
  }).sort((a,b) => (b.members[0]?.updatedAt || 0) - (a.members[0]?.updatedAt || 0));
});
const visibleGroups = computed(() => groups.value.filter(g => (!scope.value || g.root === scope.value) && g.visible.length));
function sessions(g: (typeof groups.value)[number]) {
  if (props.flat || scope.value || query.value.trim() || g.members.length <= 6) return g.visible;
  const recent = g.visible.slice(0, 6), selected = g.visible.find(t => t.id === store.state.currentId);
  if (store.state.collapsed[g.root]) return selected ? [selected] : [];
  return selected && !recent.some(t => t.id === selected.id) ? [...recent, selected] : recent;
}
function shownCount() { return visibleGroups.value.reduce((count, g) => count + sessions(g).length, 0); }
async function loadMore() {
  if (loading.value || store.state.listLoading || store.state.moreLoading || store.state.authExpired || store.state.connection !== '已连接' || !store.state.cursor) return;
  const own = ++generation, root = scope.value, search = query.value, before = shownCount();
  let pages = 0;
  loading.value = true;
  try {
    do {
      await store.loadThreads(true);
      pages++;
      await nextTick();
      if (own !== generation || root !== scope.value || search !== query.value) break;
      if (store.state.listError || store.state.authExpired || store.state.connection !== '已连接' || shownCount() > before) break;
    // ponytail: five global pages per batch; use project-scoped native paging if it becomes available.
    } while (root && store.state.cursor && pages < 5);
  } finally {
    loading.value = false;
    if (own === generation) autoBlocked.value = shownCount() <= before;
  }
}
function checkOuter() {
  const el = nav.value, sentinel = more.value;
  if (!el || !sentinel || !el.clientHeight || query.value || autoBlocked.value || store.state.listError) return;
  // Short lists have explicit buttons. Capped/collapsed projects must not drain history.
  if (el.scrollHeight <= el.clientHeight + 1 && threads.value.length) return;
  if (sentinel.getBoundingClientRect().top < el.getBoundingClientRect().bottom + 80) void loadMore();
}
function toggleProject(root: string) { generation++; store.toggleProject(root); }
watch([scope, query], async ([root, search], [oldRoot, oldSearch]) => {
  generation++; autoBlocked.value = false;
  if (nav.value) positions.set(oldRoot + ':' + !!oldSearch, nav.value.scrollTop);
  await nextTick();
  if (nav.value) nav.value.scrollTop = positions.get(root + ':' + !!search) || 0;
});
function rowLabel(t: (typeof threads.value)[number]) { return `${threadTitle(t)} · ${store.status(t)[1]} · ${t.cwd}`; }
onMounted(() => {
  observer = new IntersectionObserver(checkOuter, { root: nav.value, rootMargin: '80px' });
  if (more.value) observer.observe(more.value);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); });
async function select(id: string) { await store.selectThread(id); emit('selected'); }
async function notifications() { if ('Notification' in window) store.toast(await Notification.requestPermission() === 'granted' ? '通知已开启' : '浏览器未允许通知'); }
</script>

<template>
  <aside id="sidebar" class="sidebar" :class="{'flat-sessions':flat}" :aria-label="flat?'会话':'项目与会话'">
    <div class="brand"><img class="brand-mark" :src="logo" alt="" width="36" height="36"><span>{{flat?title||'Vault Assistant':'Codex'}} <small v-if="!flat">VIEWER</small></span><button id="sidebar-collapse" class="quiet" aria-label="收起侧栏" title="收起侧栏" @click="emit('collapse')">⇤</button></div>
    <button id="new" class="new-thread" :disabled="busy || store.state.restarting || store.state.restartPending" @click="emit('new')">＋ {{flat?'新对话':'新任务'}}</button>
    <label class="sr-only" for="search">搜索任务</label><input id="search" v-model="query" type="search" :placeholder="flat?'搜索会话标题…':'搜索已加载任务…'">
    <button type="button" class="quiet conversation-find" :disabled="!store.current.value" @click="emit('find')">查找对话</button>
    <div id="sidebar-conversation-search"></div>
    <div v-if="!flat" class="sidebar-heading"><button v-if="scope" id="all-projects" class="quiet" @click="scope = ''">← 全部项目</button><span v-else>项目概览 · {{ groups.length }}</span></div>
    <label v-if="!flat" class="sr-only" for="project-scope">查看项目</label><select v-if="!flat" id="project-scope" v-model="scope"><option value="">全部项目</option><option v-for="g in groups" :key="g.root" :value="g.root">{{ g.root.split('/').at(-1) || g.root }}</option></select>
    <nav ref="nav" id="threads" aria-label="任务列表" @scroll.passive="checkOuter">
      <p v-if="store.state.listLoading && !threads.length" class="subtle" role="status">正在读取会话…</p><p v-else-if="!visibleGroups.length" class="subtle" role="status">{{ query ? '已加载会话中没有匹配。可清空搜索或继续加载历史。' : scope ? '此项目暂无已加载会话。' : flat ? '从新对话开始。' : '选择项目，新建你的第一个任务。' }}<button v-if="scope && query" class="quiet" @click="scope = ''">搜索全部项目</button><button v-if="query" class="quiet" @click="query = ''">清空搜索</button></p>
      <section v-for="g in visibleGroups" :key="g.root" class="project">
        <div v-if="!flat" class="project-header">
          <button class="project-toggle quiet" :title="g.root" :disabled="!!scope || g.members.length <= 6" :aria-expanded="!!scope || g.members.length <= 6 || !store.state.collapsed[g.root] || !!query" @click="!scope && toggleProject(g.root)"><span v-if="!scope && g.members.length > 6" class="project-chevron" aria-hidden="true">{{ store.state.collapsed[g.root] && !query ? '▸' : '▾' }}</span><svg class="project-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15Z"/></svg><span class="project-name">{{ g.root.split('/').at(-1) || g.root }}</span></button>
          <small :class="g.waiting ? 'attention' : g.running ? 'running' : ''" :title="`已加载 ${g.members.length} 个会话 · ${g.waiting} 待输入 · ${g.running} 运行中`">{{ g.waiting ? `${g.waiting} 待输入` : g.running ? `${g.running} 运行中` : g.members.length }}</small>
          <button class="project-new quiet" title="在此项目新建对话" :aria-label="`在 ${g.root.split('/').at(-1)} 新建会话`" @click="emit('new', g.root)">＋</button>
        </div>
        <div v-show="flat || scope || g.members.length <= 6 || !store.state.collapsed[g.root] || query || g.members.some(t => t.id === store.state.currentId)" class="project-sessions" :aria-label="`${g.root.split('/').at(-1)} 的会话`">
          <div v-for="t in sessions(g)" :key="t.id" class="thread-row"><button class="thread" :data-thread-id="t.id" :class="{ selected: t.id === store.state.currentId }" :aria-current="t.id === store.state.currentId ? 'page' : undefined" :title="rowLabel(t)" :aria-label="rowLabel(t)" :disabled="busy" @click="select(t.id)">
            <strong>{{ threadTitle(t) }}</strong><span class="thread-state" :class="store.status(t)[0]" aria-hidden="true">{{ { attention: '◆', running: '▶', failed: '▲', unread: '●', idle: '' }[store.status(t)[0]] }}</span>
          </button><div class="thread-actions"><button type="button" class="quiet" :disabled="busy" :aria-label="'重命名 '+threadTitle(t)" title="重命名会话" @click="emit('rename',t.id)">✎</button><button type="button" class="quiet" :disabled="busy" :aria-label="'删除 '+threadTitle(t)" title="删除会话" @click="deletion?.show(t.id)">×</button></div></div>
          <button v-if="!flat && !scope && !query.trim() && g.members.length > sessions(g).length" class="quiet project-more" @click="scope = g.root">查看全部已加载会话 · {{ g.members.length }} →</button>
        </div>
      </section>
      <div ref="more" class="thread-pagination">
        <p v-if="store.state.listError" role="alert">{{ store.state.listError }}</p>
        <button id="more" class="quiet" :hidden="!store.state.cursor" :disabled="loading || store.state.listLoading || store.state.moreLoading || store.state.authExpired" @click="loadMore()">{{ loading || store.state.moreLoading ? '加载中…' : store.state.listError ? '重试加载' : flat || scope ? '加载更早会话' : '加载更多项目与会话' }}</button>
      </div>
    </nav>
    <footer><span id="connection" role="status">{{ store.state.connection }}</span><details v-if="!flat" class="sidebar-more"><summary>更多操作</summary><div><DefaultPermissions v-if="!embedded"/><button id="refresh" class="quiet" @click="store.resync()">刷新会话</button><button id="notifications" class="quiet" @click="notifications">开启通知</button><button v-if="!embedded" id="restart-backend" class="quiet" :disabled="store.state.restarting || store.state.restartPending" title="重启 Viewer 和 Codex，随后自动刷新页面；保留当前对话、草稿和附件，运行中的任务须先结束" @click="store.restartBackend()">{{ store.state.restarting || store.state.restartPending ? '正在重启…' : '重启整个后端' }}</button></div></details></footer>
    <slot />
    <DeleteThreadDialog ref="deletion"/>
  </aside>
</template>
