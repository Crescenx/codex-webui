<script setup lang="ts">
import { computed, ref } from 'vue';
import { useViewer } from '../store.ts';
import type { RateWindow } from '../../shared/protocol.ts';
const store = useViewer();
const dialog = ref<HTMLDialogElement>(), loading = ref(false), error = ref(''), result = ref('');
const unavailable = computed(() => store.state.connection !== '已连接' || store.state.restarting || store.state.restartPending || store.state.usageResetPending);
const canReset = computed(() => !unavailable.value && !loading.value && (!!store.state.usageResetKey || (store.state.usage.resetCount ?? 0) > 0));
const refreshing = ref(false);
async function refreshUsage() { refreshing.value = true; try { await store.loadUsage(true); } finally { refreshing.value = false; } }
async function showReset() {
  error.value = ''; result.value = ''; loading.value = true;
  dialog.value?.showModal();
  try { await store.loadUsage(true); } finally { loading.value = false; }
}
async function reset() {
  if (!canReset.value || result.value) return;
  error.value = '';
  try {
    const outcome = await store.resetUsage();
    if (outcome) result.value = { reset: '额度已重置。', nothingToReset: '当前额度无需重置。', noCredit: '当前没有可用的重置卡。', alreadyRedeemed: '本次请求对应的重置卡已使用。' }[outcome];
  } catch (e) { error.value = (e instanceof Error ? e.message : String(e)) + '。请先核对额度；重试会沿用本次请求，不会另开一次重置。'; }
}
const percent = (used: number, total = 100) => Math.round(Math.max(0, Math.min(100, (1 - used / total) * 100))) + '%';
const context = computed(() => {
  const usage = store.current.value?.tokenUsage;
  const used=usage?.last?.totalTokens,total=usage?.modelContextWindow;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 && typeof total === 'number' && Number.isFinite(total) && total > 0
    ? { left: percent(used, total), title: `当前上下文 ${used.toLocaleString()} / ${total.toLocaleString()} tokens（最近一次报告）` }
    : { left: '—', title: usage?.lastScope ? '后端未提供上下文窗口大小；累计消耗与缓存命中不代表当前上下文占用' : '等待当前会话的上下文用量报告' };
});
const codexAccount = computed(() => store.current.value?.runtimeId !== 'antigravity');
const cache = computed(() => {
  const usage=store.current.value?.tokenUsage, input=usage?.last?.inputTokens, cached=usage?.last?.cachedInputTokens;
  if(typeof input!=='number'||input<=0||typeof cached!=='number')return null;
  return {rate:Math.round(100*cached/input)+'%',title:'最近用量报告：缓存输入 '+cached.toLocaleString()+' / '+input.toLocaleString()+' tokens'+(usage?.total?.cachedInputTokens!==undefined?'；累计缓存输入 '+usage.total.cachedInputTokens.toLocaleString():'')};
});
const weekly = computed(() => store.state.usage.weekly);
const quotaError = computed(() => store.state.usageError || store.state.usage.errors?.[codexAccount.value ? 'codex' : 'antigravity'] || '');
const googleGroups = computed(() => [
  { id: 'google', label: 'Google', quota: store.state.usage.antigravity?.google },
  { id: 'external', label: '外部模型', quota: store.state.usage.antigravity?.external },
]);
const quotaTitle = (w: RateWindow | null | undefined) => w
  ? '账户额度剩余' + (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? ' · 恢复时间：' + new Date(w.resetsAt * 1000).toLocaleString() : '')
  : '账户未提供此窗口额度';
const weeklyTitle = computed(() => {
  if (store.state.usageError) return store.state.usageError;
  const reset = weekly.value?.resetsAt;
  return weekly.value ? '账户七天额度剩余' + (typeof reset === 'number' && Number.isFinite(reset) ? ` · 恢复时间：${new Date(reset * 1000).toLocaleString()}` : '') : '账户暂未提供七天额度';
});
</script>
<template>
  <div class="usage-bar" aria-label="上下文和账户额度">
    <span :title="context.title">Context left <b>{{ context.left }}</b></span>
    <span v-if="cache" :title="cache.title">Cache hit <b>{{ cache.rate }}</b></span>
    <span v-if="codexAccount" :title="weeklyTitle">Weekly left <b>{{ weekly ? percent(weekly.usedPercent) : '—' }}</b></span>
    <template v-else>
      <span v-for="group in googleGroups" :key="group.id" :data-quota-group="group.id">
        {{ group.label }} · <span :title="quotaTitle(group.quota?.primary)">5h 剩余 <b>{{ group.quota?.primary ? percent(group.quota.primary.usedPercent) : '—' }}</b></span>
        · <span :title="quotaTitle(group.quota?.secondary)">7d 剩余 <b>{{ group.quota?.secondary ? percent(group.quota.secondary.usedPercent) : '—' }}</b></span>
      </span>
      <button id="refresh-google-usage" class="quiet" :disabled="refreshing || unavailable" @click="refreshUsage">{{ refreshing ? '刷新中…' : '刷新额度' }}</button>
    </template>
    <span v-if="quotaError" role="status" :title="quotaError">额度暂不可用：{{ quotaError }}</span>
    <span v-if="codexAccount" :title="store.state.usageError || '剩余可用额度重置次数'">Resets <b>{{ store.state.usage.resetCount ?? '—' }}</b></span>
    <button v-if="codexAccount" id="reset-usage" class="quiet" :disabled="unavailable" @click="showReset">重置额度</button>
  </div>
  <dialog id="usage-reset-dialog" class="workspace-dialog" ref="dialog" aria-labelledby="usage-reset-title" aria-describedby="usage-reset-description" @cancel="store.state.usageResetPending && $event.preventDefault()">
    <header class="dialog-header"><h2 id="usage-reset-title">使用重置卡</h2></header><div class="dialog-body">
    <p id="usage-reset-description">确认使用 1 张重置卡，重置当前账户的 Codex 使用额度？</p>
    <p>剩余重置卡：<strong>{{ loading ? '读取中…' : store.state.usage.resetCount ?? '未知' }}</strong></p>
    <p class="subtle">重置作用于账户额度，保留对话历史、草稿和项目文件。</p>
    <p v-if="store.state.usageResetKey && !store.state.usageResetPending" class="subtle">上次请求尚未确认，再次确认只会重试同一次重置。</p>
    <p v-if="store.state.usageError" role="status">{{ store.state.usageError }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="result" role="status">{{ result }}</p>
    </div><div class="dialog-actions">
      <button id="usage-reset-cancel" class="quiet" autofocus :disabled="store.state.usageResetPending" @click="dialog?.close()">{{ result ? '关闭' : '取消' }}</button>
      <button v-if="!result" id="usage-reset-confirm" class="primary" :disabled="!canReset" @click="reset">{{ store.state.usageResetPending ? '正在重置…' : store.state.usageResetKey ? '重试本次重置' : '确认使用 1 张重置卡' }}</button>
    </div>
  </dialog>
</template>
