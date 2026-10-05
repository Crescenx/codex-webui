<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Settings, Skill } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
import GoalPanel from './GoalPanel.vue';
import { matchingSkills, skillTrigger } from '../skills.ts';
const emit = defineEmits<{ skills: [query?: string] }>();
const store = useViewer(), { current, draft, active, approvals, canSend } = store;
const files = ref<HTMLInputElement>(), form = ref<HTMLFormElement>(), dragging = ref(false);
const goalPanel = ref<InstanceType<typeof GoalPanel>>();
const prompt = ref<HTMLTextAreaElement>(), caret = ref(0), suggest = ref(false), composing = ref(false), candidate = ref(0);
const trigger = computed(() => skillTrigger(draft.value?.text || '', caret.value));
const candidates = computed(() => trigger.value && !loading.value ? matchingSkills(catalog.value?.skills.filter(s => s.enabled) || [], trigger.value.query).slice(0, 8) : []);
const suggestionsOpen = computed(() => suggest.value && !composing.value && !!trigger.value && candidates.value.length > 0);
function trackCaret() { caret.value = prompt.value?.selectionStart || 0; suggest.value = true; candidate.value = 0; }
function edit(event: Event) { store.setText((event.target as HTMLTextAreaElement).value); trackCaret(); }
async function chooseSkill(skill: Skill) {
  const token = trigger.value; if (!token) return;
  const text = draft.value?.text || '';
  store.toggleSkill(skill);
  store.setText(text.slice(0, token.start) + text.slice(token.end));
  suggest.value = false;
  await nextTick(); prompt.value?.focus(); prompt.value?.setSelectionRange(token.start, token.start); caret.value = token.start;
}
watch(() => current.value?.id, () => { suggest.value = false; candidate.value = 0; });
watch(candidate, () => void nextTick(() => document.getElementById('skill-candidate-' + candidate.value)?.scrollIntoView({ block: 'nearest' })));
const loading = computed(() => !current.value || store.state.hydrating || draft.value?.loading);
const catalog = computed(() => draft.value?.catalog);
const desired = computed(() => draft.value?.desired || current.value?.settings);
const models = computed(() => {
  const list = (catalog.value?.models || []).map(m => ({ value: m.model, label: m.displayName, disabled: !!current.value?.contextManagement && m.supportsExperimentalContext !== true }));
  if (desired.value?.model && !list.some(m => m.value === desired.value!.model)) list.unshift({ value: desired.value.model, label: desired.value.model + '（当前配置）', disabled: !!current.value?.contextManagement });
  return list;
});
const model = computed(() => catalog.value?.models.find(m => m.model === desired.value?.model));
const description = (s: Settings) => `${s.model} · ${s.effort || '默认强度'} · ${s.mode === 'plan' ? 'Plan' : '普通'}`;
const settingsState = computed(() => {
  if (!current.value) return '请先选择项目';
  if (loading.value) return '正在加载此项目的模型、模式和 Skills…';
  const errors = Object.values(catalog.value?.errors || {}).map(e => '配置加载失败：' + e).join('；');
  const effective = current.value.settings;
  const reviewer=current.value.approvalsReviewer;
  return errors || (effective ? '已生效：' + description(effective) + ' · ' + (reviewer==='auto_review'?'自动审查':reviewer==='user'?'人工审批':'审批方式待确认') + (desired.value && JSON.stringify(desired.value) !== JSON.stringify(effective) ? ' ｜下一轮：' + description(desired.value) : '') : '');
});
const unavailable = computed(() => loading.value || !catalog.value?.models.length || !catalog.value?.modes.length);
const sendReason = computed(() => canSend.value ? active.value ? '保留当前执行；模型设置下轮生效' : 'Enter 发送 · Shift+Enter 换行' : draft.value?.uncertain ? '提交状态尚未确认，请先核对会话' : draft.value?.readError || (store.state.authExpired ? '登录已过期，请重新打开 Viewer' : store.contextBlocked.value ? '请选择支持实验上下文管理的模型' : store.state.hydrating ? '正在同步会话' : draft.value?.uploading ? '正在上传附件' : draft.value?.sending ? '正在提交消息' : draft.value?.stopping ? '正在停止任务' : draft.value?.goalSaving ? '正在保存 Goal' : store.state.restarting || store.state.restartPending ? '正在重启后端' : '等待会话与配置准备完成'));
function change(field: 'model' | 'effort' | 'mode', event: Event) {
  if (!desired.value) return;
  const value = (event.target as HTMLSelectElement).value;
  const settings = { ...desired.value };
  if (field === 'model') { settings.model = value; settings.effort = catalog.value?.models.find(m => m.model === value)?.defaultReasoningEffort || null; }
  else if (field === 'effort') settings.effort = value || null;
  else settings.mode = value === 'plan' ? 'plan' : 'default';
  store.setSettings(settings);
}
function upload(event: Event) { const input = event.target as HTMLInputElement; void store.addFiles([...input.files || []]); input.value = ''; }
function paste(event: ClipboardEvent) { const list = [...event.clipboardData?.items || []].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f); if (list.length) { event.preventDefault(); void store.addFiles(list); } }
function drop(event: DragEvent) { dragging.value = false; void store.addFiles([...event.dataTransfer?.files || []]); }
function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value) return;
  if (suggestionsOpen.value) {
    if (event.key === 'Escape') { event.preventDefault(); suggest.value = false; return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); candidate.value = (candidate.value + (event.key === 'ArrowDown' ? 1 : -1) + candidates.value.length) % candidates.value.length; return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void chooseSkill(candidates.value[candidate.value] || candidates.value[0]!); return; }
    if (event.key === 'Tab') suggest.value = false;
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.value?.requestSubmit(); }
}
</script>

<template>
  <form id="composer" ref="form" :hidden="!current" :class="{ drag: dragging }" @submit.prevent="store.send()" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="drop">
    <div class="controls">
      <label>模型 <select id="model" aria-label="模型" :disabled="unavailable" :value="loading ? '' : desired?.model" :title="models.find(m => m.value === desired?.model)?.label || ''" @change="change('model', $event)">
        <option v-if="loading" value="">{{ current ? '正在加载…' : '请先选择项目' }}</option><option v-else-if="!models.length" value="">暂无可用选项</option><template v-else><option v-for="m in models" :key="m.value" :value="m.value" :disabled="m.disabled">{{ m.label }}{{ m.disabled ? '（不支持实验上下文）' : '' }}</option></template>
      </select></label>
      <label>思考 <select id="effort" aria-label="思考强度" :disabled="unavailable" :value="loading ? '' : desired?.effort || ''" :title="desired?.effort || '默认'" @change="change('effort', $event)">
        <option v-if="loading" value="">{{ current ? '正在加载…' : '请先选择项目' }}</option><template v-else><option value="">默认</option><option v-for="e in model?.supportedReasoningEfforts || []" :key="e.reasoningEffort" :value="e.reasoningEffort">{{ e.reasoningEffort }}</option></template>
      </select></label>
      <label>模式 <select id="mode" aria-label="模式" :disabled="unavailable" :value="loading ? '' : desired?.mode || 'default'" :title="desired?.mode === 'plan' ? 'Plan · 规划' : '普通 · 执行'" @change="change('mode', $event)">
        <option v-if="loading" value="">{{ current ? '正在加载…' : '请先选择项目' }}</option><option v-else-if="!catalog?.modes.length" value="">暂无可用选项</option><template v-else><option v-for="m in catalog.modes" :key="m.mode" :value="m.mode">{{ m.mode === 'plan' ? 'Plan · 规划' : '普通 · 执行' }}</option></template>
      </select></label>
      <button id="skills-button" type="button" class="quiet" :disabled="loading" :title="catalog?.errors.skills || '选择与管理 Skills'" @click="emit('skills')">Skills</button>
      <button id="goal-button" type="button" class="quiet" :disabled="loading || draft?.goalSaving || store.state.connection !== '已连接'" @click="goalPanel?.show()">Goal</button>
    </div>
    <GoalPanel ref="goalPanel" />
    <details class="settings-details" :open="loading || !!Object.keys(catalog?.errors || {}).length"><summary id="settings-toggle">配置与审批状态</summary><div id="settings-state" class="subtle" role="status">{{ settingsState }}</div></details>
    <div v-if="current?.contextManagement" id="context-state" class="subtle" role="status" title="此会话创建时启用，恢复时保留；模型须支持实验上下文管理">实验上下文管理 · {{ loading?'正在检查模型…':store.contextBlocked.value?'当前模型不支持或能力未确认，请选择兼容模型或重新加载配置':'已开启' }}</div>
    <button id="controls-retry" type="button" class="quiet" :hidden="loading || !Object.keys(catalog?.errors || {}).length" @click="store.loadControls()">重新加载配置</button>
    <div id="selected-skills"><button v-for="s in draft?.skills || []" :key="s.path" type="button" class="skill-chip" @click="store.toggleSkill(s, false)">${{ s.name }} ×</button></div>
    <details v-if="draft?.queued.length" id="queued-inputs" open>
      <summary>待接收消息 · {{ draft.queued.length }}</summary>
      <div v-for="q in draft.queued" :key="q.id" class="queued-input">
        <span class="subtle">{{ current?.turns?.some(t => t.id === q.turnId && t.status === 'inProgress') ? '已排队，等待 Codex 接收' : '接收尚未确认，内容保留在此' }}</span>
        <pre>{{ q.text }}</pre><span v-for="s in q.skills" :key="s.path">${{ s.name }} </span>
        <a v-for="a in q.attachments" :key="a.id" :href="'/api/attachments/' + a.id" target="_blank" rel="noopener">{{ a.name }} </a>
        <button v-if="!current?.turns?.some(t => t.id === q.turnId && t.status === 'inProgress')" type="button" class="quiet" title="只移除此提示，不会撤回或重新发送消息" @click="store.dismissQueued(q.id)">清除此提示</button>
      </div>
    </details>
    <div id="attachments"><span v-for="a in draft?.attachments || []" :key="a.id" class="attachment"><img v-if="a.mime.startsWith('image/')" :src="'/api/attachments/' + a.id" :alt="a.name">{{ a.name }}<button type="button" class="quiet" @click="store.removeAttachment(a.id)">×</button></span></div>
    <div class="prompt-area"><div v-if="suggestionsOpen" id="skill-suggestions" class="skill-suggestions"><div id="skill-candidates" role="listbox" aria-label="匹配的技能"><div v-for="(s, i) in candidates" :id="'skill-candidate-' + i" :key="s.path" role="option" :aria-selected="candidate === i" :class="{ highlighted: candidate === i }" @pointerdown.prevent="chooseSkill(s)"><strong>{{ s.name }} <small v-if="draft?.skills.some(v => v.path === s.path)">已选</small></strong><span>{{ s.description }}</span><small v-if="candidates.filter(other => other.name === s.name).length > 1">{{ s.path }}</small></div></div><button type="button" class="quiet" @pointerdown.prevent @click="suggest = false; emit('skills', trigger?.query)">在技能窗口中搜索全部匹配 →</button></div>
    <label class="sr-only" for="prompt">消息</label><textarea id="prompt" ref="prompt" :value="draft?.text || ''" rows="3" placeholder="描述任务，输入 $ 查找技能，或粘贴截图与文件…" :aria-controls="suggestionsOpen ? 'skill-candidates' : undefined" :aria-activedescendant="suggestionsOpen ? 'skill-candidate-' + candidate : undefined" aria-autocomplete="list" @input="edit" @click="trackCaret" @keyup.left="trackCaret" @keyup.right="trackCaret" @compositionstart="composing = true" @compositionend="composing = false; trackCaret()" @blur="suggest = false" @keydown="keydown" @paste="paste"></textarea></div>
    <div class="composer-actions"><button id="attach" type="button" class="quiet" title="添加附件" @click="files?.click()">＋ 附件</button><input id="files" ref="files" type="file" multiple hidden @change="upload">
      <span id="hint" :class="{ running: active && !approvals.length }">{{ draft?.stopping ? '正在停止…' : draft?.sending ? '正在提交…' : draft?.uploading ? '正在上传…' : active ? approvals.length ? '等待审批 / 回答；可追加消息或打断' : 'Enter 排队追加 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行' }}</span>
      <button id="stop" type="button" class="quiet" :hidden="!active && current?.goal?.status !== 'active'" :disabled="draft?.sending || draft?.stopping || draft?.goalSaving" :title="current?.goal?.status === 'active' ? '暂停 Goal 并停止当前轮次' : '停止当前轮次'" @click="store.interrupt()">■ 停止</button>
      <button v-if="active" id="send-interrupt" type="button" class="quiet" :disabled="!canSend || store.contextBlocked.value || (!draft?.queued.length && !draft?.text.trim() && !draft?.attachments.length)" title="停止当前任务，将全部待接收消息和输入框内容按顺序一起发送" @click="store.send('interrupt')">{{ draft?.queued.length ? '打断并发送全部' : '打断并发送' }}</button>
      <button id="send" type="submit" :disabled="!canSend" :title="sendReason">{{ active ? '排队追加 ↑' : draft?.queued.length ? '发送全部 ↑' : '发送 ↑' }}</button>
    </div>
  </form>
</template>
