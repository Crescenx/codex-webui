<script setup lang="ts">
import { computed } from 'vue';
import { useViewer } from '../store.ts';
const store = useViewer();
const percent = (used: number, total = 100) => Math.round(Math.max(0, Math.min(100, (1 - used / total) * 100))) + '%';
const context = computed(() => {
  const usage = store.current.value?.tokenUsage, used = usage?.last?.totalTokens, total = usage?.modelContextWindow;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 && typeof total === 'number' && Number.isFinite(total) && total > 0
    ? { left: percent(used, total), title: `当前上下文 ${used.toLocaleString()} / ${total.toLocaleString()} tokens（最近一次报告）` }
    : { left: '—', title: '等待当前会话的上下文用量报告' };
});
const weekly = computed(() => store.state.usage.weekly);
const weeklyTitle = computed(() => {
  if (store.state.usageError) return store.state.usageError;
  const reset = weekly.value?.resetsAt;
  return weekly.value ? '账户七天额度剩余' + (typeof reset === 'number' && Number.isFinite(reset) ? ` · 恢复时间：${new Date(reset * 1000).toLocaleString()}` : '') : '账户暂未提供七天额度';
});
</script>
<template>
  <div class="usage-bar" aria-label="上下文和账户额度">
    <span :title="context.title">Context left <b>{{ context.left }}</b></span>
    <span :title="weeklyTitle">Weekly left <b>{{ weekly ? percent(weekly.usedPercent) : '—' }}</b></span>
    <span :title="store.state.usageError || '剩余可用额度重置次数'">Resets <b>{{ store.state.usage.resetCount ?? '—' }}</b></span>
  </div>
</template>
