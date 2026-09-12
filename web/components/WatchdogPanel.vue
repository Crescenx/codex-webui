<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useViewer, threadTitle } from '../store.ts';
import type { DeepReadonly } from 'vue';
import type { Model } from '../../shared/protocol.ts';
import type { Watchdog, WatchdogConfig, WatchdogRun } from '../../shared/watchdogs.ts';
import { watchdogLabels } from '../../shared/watchdogs.ts';
const store=useViewer(), dialog=ref<HTMLDialogElement>(), filter=ref('all'), view=ref<'list'|'edit'|'history'>('list');
const error=ref(''), saving=ref(false), editing=ref<Watchdog>(), historyTask=ref<Watchdog>(), history=ref<WatchdogRun[]>([]), more=ref(false), catalog=ref<Model[]>([]);
const threadId=ref(''), name=ref(''), prompt=ref(''), interval=ref(1), unit=ref(60), model=ref(''), effort=ref<string|null>(null);
let generation=0;
const currentTasks=computed(()=>store.state.watchdogs.filter(w=>w.threadId===store.state.currentId && w.state!=='deleted'));
const preference = ref<boolean | null>(null);
try { const saved = localStorage.getItem('viewer-watchdogs-collapsed'); if (saved !== null) preference.value = saved === 'true'; } catch {}
const expanded = computed(() => preference.value === null ? currentTasks.value.length > 0 : !preference.value);
function toggle() { preference.value = expanded.value; try { localStorage.setItem('viewer-watchdogs-collapsed', String(preference.value)); } catch {} }
const tasks=computed(()=>store.state.watchdogs.filter(w=>(filter.value==='deleted'?w.state==='deleted':w.state!=='deleted') && (filter.value!=='current' || w.threadId===store.state.currentId)));
const efforts=computed(()=>catalog.value.find(m=>m.model===model.value)?.supportedReasoningEfforts || []);
const date=(n:number|null)=>n===null?'—':new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const frequency=(w:DeepReadonly<Watchdog>)=>w.intervalMinutes%60===0?`${w.intervalMinutes/60} 小时`:`${w.intervalMinutes} 分钟`;
function status(w:DeepReadonly<Watchdog>) {
  if(w.running) {const t=store.state.entities[w.threadId];return t && store.status(t)[0]==='attention'?'等待审批或输入':w.state==='paused'||w.state==='deleted'?'本轮运行中 · 后续已停止':'运行中';}
  return w.state==='enabled' && w.nextRunAt!==null && w.nextRunAt<=Date.now()?'待执行 · 等待会话空闲':watchdogLabels[w.state];
}
function resetView(next: 'list' | 'edit' | 'history' = 'list') {
  generation++;
  saving.value = false;
  error.value = '';
  view.value = next;
  return generation;
}
async function show(scope = 'all') {
  resetView();
  filter.value = scope;
  dialog.value?.showModal();
  await store.loadWatchdogs();
}
function showEditor(task: DeepReadonly<Watchdog>) {
  void show('current');
  void edit(task);
}
function close() {
  resetView();
  dialog.value?.close();
}
async function edit(task?: DeepReadonly<Watchdog>) {
  const id = task?.threadId || store.state.currentId;
  if (!id) return;
  const own = resetView('edit');
  editing.value = task ? { ...task } : undefined;
  threadId.value = id;
  name.value = task?.name || '';
  prompt.value = task?.prompt || '';
  unit.value = task && task.intervalMinutes % 60 !== 0 ? 1 : 60;
  interval.value = (task?.intervalMinutes || 60) / unit.value;
  model.value = task?.model || store.current.value?.settings?.model || '';
  effort.value = task ? task.effort : store.current.value?.settings?.effort ?? null;
  catalog.value = [];
  try {
    const result = await store.watchdogCatalog(id);
    if (own !== generation) return;
    catalog.value = result.models;
    if (result.errors.models) error.value = result.errors.models;
  } catch (e) {
    if (own === generation) error.value = String(e);
  }
  await nextTick();
  if (own === generation) dialog.value?.querySelector<HTMLInputElement>('#watchdog-name')?.focus();
}
async function save() {
  if (saving.value) return;
  const own = generation;
  saving.value = true;
  error.value = '';
  try {
    const config: WatchdogConfig = { name: name.value, prompt: prompt.value, intervalMinutes: interval.value * unit.value, model: model.value, effort: effort.value };
    await store.saveWatchdog(threadId.value, config, editing.value?.id, editing.value?.revision);
    if (own !== generation) return;
    resetView();
    store.toast('Watchdog 已保存');
  } catch (e) {
    if (own === generation) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (own === generation) saving.value = false;
  }
}
async function control(w: DeepReadonly<Watchdog>, action: string) {
  if (saving.value) return;
  const own = generation;
  saving.value = true;
  error.value = '';
  try {
    await store.controlWatchdog(w.id, w.revision, action);
  } catch (e) {
    if (own === generation) {
      error.value = e instanceof Error ? e.message : String(e);
      store.toast(error.value);
    }
  } finally {
    if (own === generation) saving.value = false;
  }
}
async function runs(w: DeepReadonly<Watchdog>, append = false) {
  const own = resetView('history');
  historyTask.value = { ...w };
  if (!append) { history.value = []; more.value = false; }
  saving.value = true;
  try {
    const result = await store.watchdogRuns(w.id, append ? history.value.length : 0);
    if (own !== generation) return;
    history.value.push(...result.data);
    more.value = result.data.length === 50;
  } catch (e) {
    if (own === generation) error.value = String(e);
  } finally {
    if (own === generation) saving.value = false;
  }
}
onBeforeUnmount(() => resetView());
async function jump(run:WatchdogRun) {close();await store.jumpToRun(run);}
function modelChanged() {effort.value=catalog.value.find(m=>m.model===model.value)?.defaultReasoningEffort || null;}
defineExpose({show});
</script>
<template>
  <aside id="watchdog-rail" class="context-rail watchdog-rail" :class="{ 'rail-collapsed': !expanded }" aria-label="当前会话的 Watchdogs">
    <button v-if="!expanded" class="rail-tab quiet" aria-label="展开 Watchdogs" :aria-expanded="false" @click="toggle">Watchdogs · {{ currentTasks.length }}</button>
    <template v-else>
    <header class="rail-header"><div><strong>Watchdogs</strong><span class="subtle">当前会话 · {{ currentTasks.length }} 个</span></div><button class="quiet" aria-label="收起 Watchdogs" :aria-expanded="true" @click="toggle">‹</button></header>
    <section class="watchdog-strip">
    <p v-if="!currentTasks.length" class="subtle">当前会话没有 Watchdog</p>
    <div v-for="w in currentTasks" :key="w.id" class="watchdog-compact"><button class="watchdog-chip" @click="show('current')"><strong>◷ {{ w.name }}</strong><span>{{ status(w) }} · 每 {{ frequency(w) }}</span><span>下次 {{ date(w.nextRunAt) }}</span><span v-if="w.lastSummary" class="watchdog-last">{{ w.lastSummary }}</span></button><div class="watchdog-actions"><button class="quiet" :disabled="saving" :aria-label="'编辑 '+w.name" @click="showEditor(w)">编辑</button><button class="quiet" :disabled="saving" :aria-label="(w.state==='enabled'?'暂停 ':'启用 ')+w.name" @click="control(w,w.state==='enabled'?'pause':'resume')">{{ w.state==='enabled'?'暂停':'启用' }}</button></div></div>
    </section>
    <button class="quiet rail-manage" @click="show('current')">管理 Watchdogs</button>
    </template>
  </aside>
  <dialog ref="dialog" id="watchdog-dialog" aria-labelledby="watchdog-title" @close="!dialog?.open && resetView()" @cancel.prevent="close">
    <button class="quiet close" aria-label="关闭 Watchdogs" @click="close">✕</button>
    <h2 id="watchdog-title">{{ view==='edit'?(editing?'编辑 Watchdog':'新建 Watchdog'):view==='history'?'运行记录':'Watchdogs' }}</h2>
    <p class="subtle">关闭浏览器后仍会按计划检查。需要后台服务和电脑保持运行；会话忙碌时等待空闲。</p>
    <p v-if="error || store.state.watchdogError" role="alert">{{ error || store.state.watchdogError }}</p>
    <template v-if="view==='list'">
      <div class="watchdog-toolbar"><label>查看 <select v-model="filter" aria-label="查看"><option value="all">全部任务</option><option value="current">当前会话</option><option value="deleted">已删除记录</option></select></label><button :disabled="!store.state.currentId || saving" @click="edit()">＋ 新建</button></div>
      <p v-if="!tasks.length" class="subtle">还没有 Watchdog。可以在对话中说：“每小时检查这个任务，遇到严重错误就停止并修复。”</p>
      <article v-for="w in tasks" :key="w.id" class="watchdog-card">
        <div class="watchdog-heading"><strong>{{ w.name }}</strong><span :class="{'attention':w.state==='needs_input'}">{{ status(w) }}</span></div>
        <p class="subtle">每 {{ frequency(w) }} · {{ w.model }} / {{ w.effort || '默认' }}<br>下次 {{ date(w.nextRunAt) }} · 上次 {{ date(w.lastRunAt) }}</p>
        <p class="watchdog-summary">{{ w.lastSummary || '尚未运行' }}</p>
        <button class="quiet watchdog-thread" @click="close();store.selectThread(w.threadId)">{{ store.state.entities[w.threadId]?threadTitle(store.state.entities[w.threadId]!):w.cwd }}</button>
        <div class="watchdog-actions">
          <button v-if="w.state!=='deleted'" :disabled="saving" @click="edit(w)">编辑指令</button><button :disabled="saving" @click="runs(w)">运行记录</button>
          <template v-if="w.state!=='deleted'"><button :disabled="saving" @click="control(w,w.state==='enabled'?'pause':'resume')">{{ w.state==='enabled'?'暂停':'启用' }}</button><button :disabled="saving || w.running" @click="control(w,'run_now')">立即检查</button><button class="quiet" :disabled="saving" @click="control(w,'delete')">删除</button></template>
        </div>
      </article>
    </template>
    <form v-else-if="view==='edit'" class="watchdog-form" @submit.prevent="save">
      <label>名称<input id="watchdog-name" v-model="name" required maxlength="120"></label>
      <label>完整检查指令<textarea v-model="prompt" required maxlength="50000" rows="10" placeholder="目标、远端主机与任务 ID、检查方法、严重错误判断、已授权的停止与修复范围、结束条件…"></textarea></label>
      <div class="watchdog-toolbar"><label>每隔<input v-model.number="interval" type="number" min="1" :max="525600/unit" step="1" required></label><label>单位<select v-model.number="unit"><option :value="60">小时</option><option :value="1">分钟</option></select></label></div>
      <div class="watchdog-toolbar"><label>模型<select v-model="model" aria-label="模型" required @change="modelChanged"><option v-if="model && !catalog.some(m=>m.model===model)" :value="model">{{ model }}</option><option v-for="m in catalog" :key="m.model" :value="m.model">{{ m.displayName }}</option></select></label><label>思考强度<select v-model="effort" aria-label="思考强度"><option :value="null">默认</option><option v-for="e in efforts" :key="e.reasoningEffort" :value="e.reasoningEffort">{{ e.reasoningEffort }}</option></select></label></div>
      <p class="subtle">首次检查在一个间隔后开始。运行中的检查保留原指令，修改用于后续检查。暂停或删除仅停止后续调度；要停止当前检查，请使用对话中的停止按钮。</p>
      <div class="dialog-actions"><button type="button" :disabled="saving" @click="resetView()">返回</button><button type="submit" class="primary" :disabled="saving || !model">{{ saving?'保存中…':'保存并'+(editing?'更新':'启用') }}</button></div>
    </form>
    <template v-else>
      <button class="quiet" @click="resetView()">← 返回任务列表</button><h3>{{ historyTask?.name }}</h3>
      <p v-if="!history.length" class="subtle">{{ saving?'正在读取…':'尚无运行记录' }}</p>
      <article v-for="r in history" :key="r.id" class="watchdog-card"><div class="watchdog-heading"><strong>{{ date(r.startedAt) }}</strong><span>{{ {running:'运行中',completed:'已完成',failed:'失败',uncertain:'待核实',interrupted:'已中断'}[r.status] }}</span></div><p>{{ r.summary || r.report?.summary || '等待检查结果' }}</p><p class="subtle">{{ r.config.model }} / {{ r.config.effort || '默认' }} · 结束 {{ date(r.endedAt) }}</p><details><summary>本轮指令快照</summary><pre>{{ r.config.prompt }}</pre></details><button :disabled="!r.turnId" @click="jump(r)">查看对应对话</button></article>
      <button v-if="more && historyTask" :disabled="saving" @click="runs(historyTask,true)">加载更早记录</button>
    </template>
  </dialog>
</template>
