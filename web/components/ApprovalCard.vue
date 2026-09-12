<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { DeepReadonly } from 'vue';
import type { PendingRequest } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
import { approvalChoices } from '../../shared/approvals.ts';
const props = defineProps<{ request: DeepReadonly<PendingRequest> }>();
const store = useViewer(), answers = reactive<Record<string, string>>({});
const choices = computed(() => approvalChoices(props.request));
const lasting = computed(() => choices.value.filter(c => c.description));
const network = computed(() => props.request.params.networkApprovalContext as { host: string; protocol: string } | undefined);
const question = computed(() => props.request.method === 'item/tool/requestUserInput');
const questions = computed(() => (props.request.params.questions || []) as { id: string; question: string; options?: { label: string; description: string }[] }[]);
</script>
<template>
  <article class="approval" :class="{ windows: request.windows }">
    <strong>{{ question ? 'Codex 需要你的输入' : network ? '请求网络访问' : request.windows ? '可能涉及 Windows' : '请求授权' }}</strong>
    <p v-if="!question" class="approval-reason">申请原因：{{ request.params.reason || 'Codex 未提供具体原因，请查看下方操作范围。' }}</p>
    <p v-if="network">目标：<code>{{ network.protocol }} · {{ network.host }}</code></p>
    <p v-if="request.params.cwd">工作目录：<code>{{ request.params.cwd }}</code></p>
    <pre v-if="request.params.command && !network">{{ request.params.command }}</pre>
    <pre v-if="request.params.permissions || request.params.additionalPermissions">{{ JSON.stringify(request.params.permissions || request.params.additionalPermissions, null, 2) }}</pre>
    <p v-if="request.params.grantRoot">请求写入范围：<code>{{ request.params.grantRoot }}</code></p>
    <p v-if="request.windowsEvidence?.length">检测依据：{{ request.windowsEvidence.join('、') }}</p>
    <template v-for="q in questions" :key="q.id"><label>{{ q.question }}<textarea v-model="answers[q.id]" rows="2"></textarea></label><button v-for="opt in q.options || []" :key="opt.label" class="quiet" :disabled="store.state.replying[request.id]" @click="answers[q.id] = opt.label">{{ opt.label }}</button></template>
    <button v-for="choice in choices.filter(c => !c.description)" :key="choice.id" :class="choice.id === 'accept' ? 'primary' : 'quiet'" :disabled="store.state.replying[request.id]" @click="store.reply(request.id, choice.id, { ...answers })">{{ choice.label }}</button>
    <details v-if="lasting.length" class="approval-lasting"><summary>持续授权选项</summary>
      <div v-for="choice in lasting" :key="choice.id" class="approval-scope">
        <p>{{ choice.description }}</p><pre v-if="choice.detail">{{ choice.detail }}</pre>
        <button class="quiet" :disabled="store.state.replying[request.id]" @click="store.reply(request.id, choice.id, {})">{{ choice.label }}</button>
      </div>
    </details>
  </article>
</template>
