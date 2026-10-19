<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useViewer, threadTitle } from '../store.ts';
import Conversation from './Conversation.vue';
import ApprovalCard from './ApprovalCard.vue';
import { runtimeName } from '../../shared/runtime.ts';
const store = useViewer();
const props = defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ close: [] }>();
const selected = computed(() => store.agents.value.find(a => a.id === store.state.selectedAgentId));
const running = computed(() => store.agents.value.filter(a => ['running', 'pendingInit'].includes(a.state)).length);
const managed=computed(()=>store.selectedAgent.value?.hybrid?.agent);
const requests=computed(()=>Object.values(store.state.requests).filter(r=>r.params.threadId===store.state.selectedAgentId));
const message=ref(''), busy=ref(false), error=ref('');
const operations=new Map<string,string>();
watch(()=>store.state.selectedAgentId,()=>{message.value='';error.value='';});
async function act(action:string){
  const id=store.state.selectedAgentId,key=JSON.stringify([id,action,message.value]);
  const operationId=operations.get(key)||crypto.randomUUID();operations.set(key,operationId);
  busy.value=true;error.value='';
  try {await store.agentAction(id,action,{operationId,message:message.value});operations.delete(key);if(action==='send_input')message.value='';}
  catch(e){error.value=e instanceof Error?e.message:String(e);}
  finally{busy.value=false;}
}
watch(() => props.expanded, value => store.setAgentsVisible(value), { immediate: true });
onBeforeUnmount(() => store.setAgentsVisible(false));
</script>
<template>
  <aside v-show="expanded" id="subagents" class="context-rail agent-rail" aria-label="Subagents">
    <template v-if="expanded">
      <header class="rail-header"><div><strong>子代理</strong><span class="subtle">{{ store.agents.value.length }} 个 · {{ running }} 个执行中</span></div><button class="quiet" aria-label="收起 Subagents" @click="emit('close')">关闭</button></header>
      <div class="agent-tree" :class="{ 'has-selection': selected }" aria-label="子代理层级">
        <div class="agent-root">{{ store.current.value ? threadTitle(store.current.value) : '尚未选择对话' }}</div>
        <p v-if="!store.agents.value.length" class="subtle">{{ store.state.agentsLoading ? '正在读取…' : '当前对话没有子代理' }}</p>
        <button v-for="agent in store.agents.value" :key="agent.id" class="agent-node" :class="{ selected: selected?.id === agent.id }" :style="{ '--agent-depth': agent.depth }" :data-agent-id="agent.id" :aria-pressed="selected?.id === agent.id" @click="store.selectAgent(agent.id)">
          <span class="agent-node-heading"><strong>{{ agent.name }}</strong><span class="agent-state" :data-state="agent.state">{{ agent.label }}</span></span>
          <span v-if="agent.depth" class="agent-parent subtle">由 {{ store.agents.value.find(a => a.id === agent.parentId)?.name || agent.parentId }} 派发</span>
          <span v-if="agent.task" class="agent-task">{{ agent.task }}</span>
          <span v-if="agent.summary" class="agent-summary subtle">{{ agent.summary }}</span>
        </button>
      </div>
      <div v-if="store.state.agentsError" class="rail-error" role="alert">{{ store.state.agentsError }}<button class="quiet" @click="store.loadSubagents()">重试</button></div>
      <section v-if="selected" class="agent-detail" aria-label="子代理详情">
        <header class="rail-header"><div><strong>{{ selected.name }}</strong><span class="subtle">{{ managed?runtimeName(store.selectedAgent.value || {}):'只读' }} · {{ selected.label }}</span></div><button class="quiet" aria-label="关闭子代理详情" @click="store.selectAgent('')">×</button></header>
        <div v-if="managed" class="rail-note agent-controls">
          <p class="subtle">独立工作目录：{{ managed.workspace.cwd }}</p>
          <p v-if="managed.deliveryState==='unknown'" role="alert">结果回传未确认，未自动重发；可让主智能体读取此子任务。</p>
          <button v-if="store.selectedAgent.value?.executionUncertain" class="quiet" :disabled="busy" @click="store.recoverAgent(selected.id).catch(store.report)">核实执行状态</button>
          <template v-if="!store.selectedAgent.value?.executionUncertain">
            <label>追加任务<textarea v-model="message" :disabled="busy" rows="2" /></label>
            <button :disabled="busy || !message.trim() || ['running','pendingInit','waiting'].includes(selected.state)" @click="act('send_input')">发送</button>
            <button class="quiet" :disabled="busy || !['running','pendingInit','waiting'].includes(selected.state)" @click="act('interrupt_agent')">停止</button>
            <button class="quiet" :disabled="busy || selected.state==='shutdown'" @click="act('close_agent')">关闭子任务</button>
          </template>
          <p v-if="error" role="alert">{{ error }}</p>
          <ApprovalCard v-for="request in requests" :key="request.id" :request="request" />
        </div>
        <p v-if="store.state.agentLoading && !store.selectedAgent.value?.turns?.length" class="subtle rail-note">正在读取记录…</p>
        <p v-else-if="!store.state.agentError && !store.selectedAgent.value?.turns?.length" class="subtle rail-note">暂无已保存的执行记录</p>
        <div v-if="store.state.agentError" class="rail-error" role="alert">{{ store.state.agentError }}<button class="quiet" @click="store.loadAgent()">重试</button></div>
        <Conversation :key="store.state.selectedAgentId" :thread="store.selectedAgent.value" readonly />
      </section>
    </template>
  </aside>
</template>
