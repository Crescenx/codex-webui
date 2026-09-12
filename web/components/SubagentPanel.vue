<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useViewer, threadTitle } from '../store.ts';
import Conversation from './Conversation.vue';
const store = useViewer();
const preference = ref<boolean | null>(null);
try { const saved = localStorage.getItem('viewer-agents-collapsed'); if (saved !== null) preference.value = saved === 'true'; } catch {}
const expanded = computed(() => preference.value === null ? store.agents.value.length > 0 || !!store.state.agentsError : !preference.value);
const selected = computed(() => store.agents.value.find(a => a.id === store.state.selectedAgentId));
const running = computed(() => store.agents.value.filter(a => ['running', 'pendingInit'].includes(a.state)).length);
function toggle() { preference.value = expanded.value; try { localStorage.setItem('viewer-agents-collapsed', String(preference.value)); } catch {} }
watch(expanded, value => store.setAgentsVisible(value), { immediate: true });
onBeforeUnmount(() => store.setAgentsVisible(false));
</script>
<template>
  <aside id="subagents" class="context-rail agent-rail" :class="{ 'rail-collapsed': !expanded }" aria-label="Subagents">
    <button v-if="!expanded" class="rail-tab quiet" aria-label="展开 Subagents" :aria-expanded="false" @click="toggle">Subagents · {{ store.agents.value.length }}</button>
    <template v-else>
      <header class="rail-header"><div><strong>Subagents</strong><span class="subtle">{{ store.agents.value.length }} 个 · {{ running }} 个执行中</span></div><button class="quiet" aria-label="收起 Subagents" :aria-expanded="true" @click="toggle">›</button></header>
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
        <header class="rail-header"><div><strong>{{ selected.name }}</strong><span class="subtle">只读 · {{ selected.label }}</span></div><button class="quiet" aria-label="关闭子代理详情" @click="store.selectAgent('')">×</button></header>
        <p v-if="store.state.agentLoading && !store.selectedAgent.value?.turns?.length" class="subtle rail-note">正在读取记录…</p>
        <p v-else-if="!store.state.agentError && !store.selectedAgent.value?.turns?.length" class="subtle rail-note">暂无已保存的执行记录</p>
        <div v-if="store.state.agentError" class="rail-error" role="alert">{{ store.state.agentError }}<button class="quiet" @click="store.loadAgent()">重试</button></div>
        <Conversation :thread="store.selectedAgent.value" readonly />
      </section>
    </template>
  </aside>
</template>
