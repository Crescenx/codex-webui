<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { DeepReadonly } from 'vue';
import type { PendingRequest } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
import { approvalChoices } from '../../shared/approvals.ts';
import { elicitationFields, externalUrl } from '../../shared/mcp-apps.ts';
const props = defineProps<{ request: DeepReadonly<PendingRequest> }>();
const store = useViewer(), answers = reactive<Record<string, string>>({});
const error = ref('');
async function reply(decision: string, values: Record<string, unknown>) {
  error.value = '';
  await store.reply(props.request.id, decision, values);
  if (store.state.requests[props.request.id]) error.value = store.draft.value?.error || store.state.error || '请求未提交，请核对连接状态后重试。';
}
const choices = computed(() => approvalChoices(props.request));
const lasting = computed(() => choices.value.filter(c => c.description));
const network = computed(() => props.request.params.networkApprovalContext as { host: string; protocol: string } | undefined);
const question = computed(() => props.request.method === 'item/tool/requestUserInput');
const questions = computed(() => (props.request.params.questions || []) as { id: string; question: string; options?: { label: string; description: string }[] }[]);
const elicitation = computed(() => props.request.method === 'mcpServer/elicitation/request');
const fields = computed(() => elicitationFields(props.request.params));
const form = reactive<Record<string, string | number | boolean | string[] | undefined>>({});
watch(fields, list => { for (const field of list || []) if (field.default !== undefined) form[field.name] = field.default as typeof form[string]; }, { immediate: true });
const submitted = () => elicitation.value ? Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined && value !== '')) : { ...answers };
</script>
<template>
  <article class="approval" :class="{ windows: request.windows }">
    <strong>{{ elicitation ? `${request.params.serverName} 需要你的输入` : question ? 'Codex 需要你的输入' : network ? '请求网络访问' : request.windows ? '可能涉及 Windows' : '请求授权' }}</strong>
    <p v-if="!question && !elicitation" class="approval-reason">申请原因：{{ request.params.reason || 'Codex 未提供具体原因，请查看下方操作范围。' }}</p>
    <template v-if="elicitation">
      <p>{{ request.params.message }}</p>
      <a v-if="request.params.mode === 'url' && externalUrl(request.params.url)" :href="externalUrl(request.params.url)" target="_blank" rel="noopener noreferrer">{{ request.params.url }}</a>
      <p v-if="!choices.some(c => c.id === 'accept')">暂不支持此输入格式，可拒绝或取消。</p>
      <label v-for="field in fields || []" :key="field.name">{{ field.title }}<span v-if="field.description" class="subtle"> {{ field.description }}</span>
        <select v-if="field.type === 'boolean'" v-model="form[field.name]"><option :value="undefined">未填写</option><option :value="true">是</option><option :value="false">否</option></select>
        <select v-else-if="field.choices.length" v-model="form[field.name]" :multiple="field.type === 'array'"><option v-if="field.type !== 'array'" :value="undefined">未填写</option><option v-for="choice in field.choices" :key="choice.value" :value="choice.value">{{ choice.title }}</option></select>
        <input v-else-if="field.type === 'number' || field.type === 'integer'" v-model.number="form[field.name]" type="number" :step="field.type === 'integer' ? 1 : 'any'">
        <input v-else v-model="form[field.name]" type="text">
      </label>
    </template>
    <p v-if="network">目标：<code>{{ network.protocol }} · {{ network.host }}</code></p>
    <p v-if="request.params.cwd">工作目录：<code>{{ request.params.cwd }}</code></p>
    <pre v-if="request.params.command && !network">{{ request.params.command }}</pre>
    <pre v-if="request.params.permissions || request.params.additionalPermissions">{{ JSON.stringify(request.params.permissions || request.params.additionalPermissions, null, 2) }}</pre>
    <p v-if="request.params.grantRoot">请求写入范围：<code>{{ request.params.grantRoot }}</code></p>
    <p v-if="request.windowsEvidence?.length">检测依据：{{ request.windowsEvidence.join('、') }}</p>
    <template v-for="q in questions" :key="q.id"><label>{{ q.question }}<textarea v-model="answers[q.id]" rows="2"></textarea></label><button v-for="opt in q.options || []" :key="opt.label" class="quiet" :disabled="store.state.replying[request.id]" @click="answers[q.id] = opt.label">{{ opt.label }}</button></template>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-for="choice in choices.filter(c => !c.description)" :key="choice.id" :class="choice.id === 'accept' ? 'primary' : 'quiet'" :disabled="store.state.replying[request.id]" @click="reply(choice.id, submitted())">{{ store.state.replying[request.id] ? '正在提交…' : choice.label }}</button>
    <details v-if="lasting.length" class="approval-lasting"><summary>持续授权选项</summary>
      <div v-for="choice in lasting" :key="choice.id" class="approval-scope">
        <p>{{ choice.description }}</p><pre v-if="choice.detail">{{ choice.detail }}</pre>
        <button class="quiet" :disabled="store.state.replying[request.id]" @click="reply(choice.id, {})">{{ store.state.replying[request.id] ? '正在提交…' : choice.label }}</button>
      </div>
    </details>
  </article>
</template>
