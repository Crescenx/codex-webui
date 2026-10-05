<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useViewer } from '../store.ts';
import type { DeepReadonly } from 'vue';
import type { Model } from '../../shared/protocol.ts';
import type { Watchdog, WatchdogConfig } from '../../shared/watchdogs.ts';
import { watchdogLabels } from '../../shared/watchdogs.ts';
const store=useViewer(), dialog=ref<HTMLDialogElement>(), view=ref<'list'|'edit'>('list');
const props = defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ close: [] }>();
const error=ref(''), saving=ref(false), editing=ref<Watchdog>(), catalog=ref<Model[]>([]);
const threadId=ref(''), name=ref(''), prompt=ref(''), interval=ref(1), unit=ref(60), model=ref(''), effort=ref<string|null>(null);
const timing=ref<'interval'|'daily'|'days'|'weekly'|'once'>('interval'), everyDays=ref(2), startDate=ref(''), time=ref('09:00'), at=ref(''), weekdays=ref<number[]>([1]);
const weekLabels = ['一','二','三','四','五','六','日'];
const timeZone = computed(() => store.state.watchdogTimeZone);
let generation=0;
const currentTasks=computed(()=>store.state.watchdogs.filter(w=>w.threadId===store.state.currentId && w.state!=='deleted'));
const efforts=computed(()=>catalog.value.find(m=>m.model===model.value)?.supportedReasoningEfforts || []);
const date=(n:number|null)=>n===null?'—':new Date(n).toLocaleString(undefined,{timeZone:timeZone.value || undefined,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function frequency(w: DeepReadonly<Watchdog>) {
  const s = w.schedule;
  if (!s) return w.intervalMinutes%60===0?`每 ${w.intervalMinutes/60} 小时`:`每 ${w.intervalMinutes} 分钟`;
  if (s.kind === 'once') return `单次 ${s.at.replace('T', ' ')}`;
  if (s.kind === 'weekly') return `每周${s.weekdays.map(d => weekLabels[d-1]).join('、')} ${s.time}`;
  return `${s.everyDays === 1 ? '每天' : `每 ${s.everyDays} 天`} ${s.time} · 自 ${s.startDate}`;
}
function status(w:DeepReadonly<Watchdog>) {
  if(w.running) {const t=store.state.entities[w.threadId];return t && store.status(t)[0]==='attention'?'等待审批或输入':w.state==='paused'||w.state==='deleted'?'本轮运行中 · 后续已停止':'运行中';}
  return w.state==='enabled' && w.nextRunAt!==null && w.nextRunAt<=Date.now()?'待执行 · 等待会话空闲':watchdogLabels[w.state];
}
function resetView(next: 'list' | 'edit' = 'list') {
  generation++;
  saving.value = false;
  error.value = '';
  view.value = next;
  return generation;
}
async function show() {
  if (!store.state.currentId) return;
  resetView();
  dialog.value?.showModal();
  await store.loadWatchdogs();
}
function close() {
  resetView();
  dialog.value?.close();
}
async function edit(task?: DeepReadonly<Watchdog>) {
  const id = task?.threadId || store.state.currentId;
  if (!id || id !== store.state.currentId) return;
  const own = resetView('edit');
  dialog.value?.showModal();
  editing.value = task ? { ...task } : undefined;
  threadId.value = id;
  name.value = task?.name || '';
  prompt.value = task?.prompt || '';
  unit.value = task?.intervalMinutes && task.intervalMinutes % 60 !== 0 ? 1 : 60;
  interval.value = (task?.intervalMinutes || 60) / unit.value;
  const s = task?.schedule;
  timing.value = s?.kind === 'daily' ? (s.everyDays === 1 ? 'daily' : 'days') : s?.kind || 'interval';
  everyDays.value = s?.kind === 'daily' ? Math.max(2, s.everyDays) : 2;
  startDate.value = s?.kind === 'daily' ? s.startDate : '';
  time.value = s && s.kind !== 'once' ? s.time : '09:00';
  at.value = s?.kind === 'once' ? s.at : '';
  weekdays.value = s?.kind === 'weekly' ? [...s.weekdays] : [1];
  model.value = task?.model || store.current.value?.settings?.model || '';
  effort.value = task ? task.effort : store.current.value?.settings?.effort ?? null;
  catalog.value = [];
  try {
    const [result] = await Promise.all([store.watchdogCatalog(id), store.loadWatchdogs()]);
    if (own !== generation) return;
    catalog.value = result.models;
    if (!startDate.value && timeZone.value) startDate.value = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone.value, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
    if (timing.value !== 'interval' && !timeZone.value) throw new Error('请等待定时时区加载后保存');
    if (timing.value === 'weekly' && !weekdays.value.length) throw new Error('请至少选择一个星期');
    const config: WatchdogConfig = { name: name.value, prompt: prompt.value, model: model.value, effort: effort.value,
      ...(timing.value === 'interval' ? { intervalMinutes: interval.value * unit.value } : { schedule:
        timing.value === 'once' ? { kind: 'once' as const, at: at.value } :
        timing.value === 'weekly' ? { kind: 'weekly' as const, weekdays: [...weekdays.value].sort((a,b)=>a-b), time: time.value } :
        { kind: 'daily' as const, everyDays: timing.value === 'daily' ? 1 : everyDays.value, startDate: startDate.value, time: time.value }
      }) };
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
async function jump(w: DeepReadonly<Watchdog>) {
  if (saving.value) return;
  const own = generation;
  error.value = '';
  saving.value = true;
  try {
    const { data: [run] } = await store.watchdogRuns(w.id);
    if (own !== generation) return;
    if (!run?.turnId) { error.value = '本轮尚未生成对话，请稍后重试'; return; }
    close();
    await store.jumpToRun(run);
  } catch (e) {
    if (own === generation) error.value = String(e);
  } finally {
    if (own === generation) saving.value = false;
  }
}
watch(() => store.state.currentId, close, { flush: 'sync' });
onBeforeUnmount(() => resetView());
function modelChanged() {effort.value=catalog.value.find(m=>m.model===model.value)?.defaultReasoningEffort || null;}
</script>
<template>
  <aside v-show="props.expanded" id="watchdog-rail" class="context-rail watchdog-rail" aria-label="当前会话的 Watchdogs">
    <template v-if="props.expanded">
    <header class="rail-header"><div><strong>Watchdogs</strong><span class="subtle">{{ currentTasks.length }} 个</span></div><button class="quiet" aria-label="新建 Watchdog" :disabled="!store.state.currentId || saving" @click="edit()">＋</button><button class="quiet" aria-label="收起 Watchdogs" @click="emit('close')">关闭</button></header>
    <section class="watchdog-strip">
    <p v-if="!currentTasks.length" class="subtle">当前会话没有 Watchdog</p>
    <div v-for="w in currentTasks" :key="w.id" class="watchdog-compact"><button class="watchdog-chip" @click="show()"><strong>◷ {{ w.name }}</strong><span>{{ status(w) }} · {{ frequency(w) }}</span><span>下次 {{ date(w.nextRunAt) }} · {{ timeZone }}</span></button><div class="watchdog-actions"><button class="quiet" :disabled="saving" :aria-label="'编辑 '+w.name" @click="edit(w)">编辑</button><button class="quiet" :disabled="saving" :aria-label="(w.state==='enabled'?'暂停 ':'启用 ')+w.name" @click="control(w,w.state==='enabled'?'pause':'resume')">{{ w.state==='enabled'?'暂停':'启用' }}</button></div></div>
    </section>
    <button class="quiet rail-manage" :disabled="!store.state.currentId" @click="show()">管理 Watchdogs</button>
    </template>
  </aside>
  <dialog ref="dialog" id="watchdog-dialog" class="workspace-dialog" aria-labelledby="watchdog-title" @close="!dialog?.open && resetView()" @cancel.prevent="close">
    <header class="dialog-header"><h2 id="watchdog-title">{{ view==='edit'?(editing?'编辑 Watchdog':'新建 Watchdog'):'Watchdogs' }}</h2><button class="quiet" aria-label="关闭 Watchdogs" @click="close">关闭</button></header><div class="dialog-body">
    <p class="subtle">关闭浏览器后仍会按计划检查。需要后台服务和电脑保持运行；会话忙碌时等待空闲。</p>
    <p class="subtle">定时时区：{{ timeZone || '加载中…' }} · 错过多个时刻只补执行一次。</p>
    <p v-if="error || store.state.watchdogError" role="alert">{{ error || store.state.watchdogError }}</p>
    <template v-if="view==='list'">
      <p v-if="!currentTasks.length" class="subtle">还没有 Watchdog。可以在会话的 Watchdog 栏点击 ＋ 新建，或在对话中安排定时任务。</p>
      <article v-for="w in currentTasks" :key="w.id" class="watchdog-card">
        <div class="watchdog-heading"><strong>{{ w.name }}</strong><span :class="{'attention':w.state==='needs_input'}">{{ status(w) }}</span></div>
        <details class="watchdog-prompt"><summary><span class="watchdog-prompt-preview">{{ w.prompt }}</span><span class="prompt-expand">展开指令</span><span class="prompt-collapse">收起指令</span></summary><p>{{ w.prompt }}</p></details>
        <p class="subtle">{{ frequency(w) }} · {{ timeZone }} · {{ w.model }} / {{ w.effort || '默认' }}<br>下次 {{ date(w.nextRunAt) }} · 上次 {{ date(w.lastRunAt) }}</p>
        <div class="watchdog-actions">
          <button :disabled="saving" @click="edit(w)">编辑指令</button><button :disabled="saving || w.lastRunAt === null" @click="jump(w)">查看最近执行</button>
          <button :disabled="saving" @click="control(w,w.state==='enabled'?'pause':'resume')">{{ w.state==='enabled'?'暂停':'启用' }}</button><button :disabled="saving || w.running" @click="control(w,'run_now')">立即检查</button><button class="quiet" :disabled="saving" @click="control(w,'delete')">删除</button>
        </div>
      </article>
    </template>
    <form v-else class="watchdog-form" @submit.prevent="save">
      <label>名称<input id="watchdog-name" v-model="name" required maxlength="120"></label>
      <label>完整检查指令<textarea v-model="prompt" required maxlength="50000" rows="6" placeholder="目标、远端主机与任务 ID、检查方法、严重错误判断、已授权的停止与修复范围、结束条件…"></textarea></label>
      <label>调度方式<select v-model="timing"><option value="interval">固定间隔</option><option value="daily">每天</option><option value="days">每 N 天</option><option value="weekly">每周</option><option value="once">单次</option></select></label>
      <div v-if="timing==='interval'" class="watchdog-toolbar"><label>每隔<input v-model.number="interval" type="number" min="1" :max="525600/unit" step="1" required></label><label>单位<select v-model.number="unit"><option :value="60">小时</option><option :value="1">分钟</option></select></label></div>
      <label v-else-if="timing==='once'">执行日期时间<input v-model="at" type="datetime-local" min="1000-01-01T00:00" max="9999-12-31T23:59" step="60" required></label>
      <template v-else>
        <div class="watchdog-toolbar">
          <label v-if="timing==='days'">间隔天数<input v-model.number="everyDays" type="number" min="2" max="365" step="1" required></label>
          <label v-if="timing!=='weekly'">开始日期<input v-model="startDate" type="date" min="1000-01-01" max="9999-12-31" required></label>
          <label>执行时刻<input v-model="time" type="time" step="60" required></label>
        </div>
        <fieldset v-if="timing==='weekly'" class="watchdog-weekdays"><legend>执行星期</legend><label v-for="(label,index) in weekLabels" :key="index"><input v-model="weekdays" type="checkbox" :value="index+1">周{{ label }}</label></fieldset>
      </template>
      <div class="watchdog-toolbar"><label>模型<select v-model="model" aria-label="模型" required @change="modelChanged"><option v-if="model && !catalog.some(m=>m.model===model)" :value="model">{{ model }}</option><option v-for="m in catalog" :key="m.model" :value="m.model">{{ m.displayName }}</option></select></label><label>思考强度<select v-model="effort" aria-label="思考强度"><option :value="null">默认</option><option v-for="e in efforts" :key="e.reasoningEffort" :value="e.reasoningEffort">{{ e.reasoningEffort }}</option></select></label></div>
      <p class="subtle">{{ timing==='interval'?'首次检查在一个间隔后开始。':timing==='once'?'单次任务成功执行后结束；再次执行请修改时间后启用，或使用立即检查。':'按所选日期和时刻执行；立即检查不改变原时间表。' }}运行中的检查保留原指令，修改用于后续检查。暂停或删除仅停止后续调度；要停止当前检查，请使用对话中的停止按钮。</p>
      <div class="dialog-actions watchdog-save-actions"><button type="button" :disabled="saving" @click="resetView()">返回</button><button type="submit" class="primary" :disabled="saving || !model">{{ saving?'保存中…':'保存并'+(editing?'更新':'启用') }}</button></div>
    </form>
    </div>
  </dialog>
</template>
