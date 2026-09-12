<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Settings } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
const emit = defineEmits<{ skills: [] }>();
const store = useViewer(), { current, draft, active, approvals, canSend } = store;
const files = ref<HTMLInputElement>(), form = ref<HTMLFormElement>(), dragging = ref(false);
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
function keydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.value?.requestSubmit(); } }
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
    </div>
    <div id="settings-state" class="subtle" role="status">{{ settingsState }}</div>
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
    <label class="sr-only" for="prompt">消息</label><textarea id="prompt" :value="draft?.text || ''" rows="3" placeholder="描述任务，或粘贴截图与文件…" @input="store.setText(($event.target as HTMLTextAreaElement).value)" @keydown="keydown" @paste="paste"></textarea>
    <div class="composer-actions"><button id="attach" type="button" class="quiet" title="添加附件" @click="files?.click()">＋ 附件</button><input id="files" ref="files" type="file" multiple hidden @change="upload">
      <span id="hint" :class="{ running: active && !approvals.length }">{{ draft?.stopping ? '正在停止…' : draft?.sending ? '正在提交…' : draft?.uploading ? '正在上传…' : active ? approvals.length ? '等待审批 / 回答；可追加消息或打断' : 'Enter 排队追加 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行' }}</span>
      <button id="stop" type="button" class="quiet" :hidden="!active" :disabled="draft?.sending || draft?.stopping" @click="store.interrupt()">■ 停止</button>
      <button v-if="active" id="send-interrupt" type="button" class="quiet" :disabled="!canSend || store.contextBlocked.value || (!draft?.queued.length && !draft?.text.trim() && !draft?.attachments.length)" title="停止当前任务，将全部待接收消息和输入框内容按顺序一起发送" @click="store.send('interrupt')">{{ draft?.queued.length ? '打断并发送全部' : '打断并发送' }}</button>
      <button id="send" type="submit" :disabled="!canSend" :title="active ? '保留当前执行，将消息交给 Codex 在下一次接收输入时处理；模型设置下轮生效' : ''">{{ active ? '排队追加 ↑' : draft?.queued.length ? '发送全部 ↑' : '发送 ↑' }}</button>
    </div>
  </form>
</template>
