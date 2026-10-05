<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { useViewer } from '../store.ts';
import { createClient } from '../api.ts';
import type { WireCheck } from '../../shared/model-check.ts';
const { current } = useViewer();
const client = createClient(), checking = ref(false), error = ref('');
const results = ref<Record<string, WireCheck>>({});
const result = computed(() => results.value[current.value?.id || '']);
onBeforeUnmount(() => client.dispose());
async function check() {
  if (!current.value || checking.value) return;
  const id = current.value.id; checking.value = true; error.value = '';
  try { results.value[id] = await client.request<WireCheck>(`/threads/${encodeURIComponent(id)}/model-check`, {}); }
  catch (e) { error.value = e instanceof Error ? e.message : 'HTTP 探测失败'; }
  finally { checking.value = false; }
}
const events = computed(() => current.value?.modelEvidence || []);
const turnId = computed(() => current.value?.turns?.at(-1)?.id);
const rerouted = computed(() => events.value.some(e => e.turnId === turnId.value && e.source === 'model/rerouted'));
const wire = computed(() => events.value.filter(e => e.turnId === turnId.value && e.source === 'viewer/modelResponse'));
const different = computed(() => wire.value.some(e => e.model && e.requestedModel !== e.model));
const summary = computed(() => {
  if (different.value) return '本轮返回模型名不同';
  if (rerouted.value) return '本轮收到重路由通知';
  const latest = wire.value.at(-1);
  return latest ? `${latest.requestedModel} → ${latest.model || '未返回 model'} · ${new Set(wire.value.map(e => e.responseId)).size} 次响应` : '实际模型尚无法确认';
});
function download() {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ threadId: current.value?.id, scope: '真实 WebSocket 响应正文与请求上下文按 response ID 关联；最多 100 条元数据，不含完整请求正文', events: events.value, independentHttpProbe: result.value }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'model-evidence.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <details v-if="current" id="model-check" :class="{ rerouted: rerouted || different }">
    <summary aria-live="polite">模型核对 · {{ summary }}</summary>
    <div class="model-check-body">
      <p>当前会话设置：{{ current.settings?.model || '未知' }}。设置值不是实际模型的证据。</p>
      <p>自动捕获当前会话真实 WebSocket 响应的 model，按响应 ID 精确关联请求模型和轮次。通常在每次响应结束、归属元数据到达后更新；无需另发测试请求，也不改变传输或服务商。</p>
      <p>只保留最近 100 条模型元数据，刷新保留，后端重启清空。历史响应无法补抓；HTTP 回退、连接中断或缺少关联字段时保持未知。返回 effort 取自 response.reasoning.effort，缺失时不以请求值补齐；它不是实际推理计算量。模型名一致不等于能力保证。</p>
      <button class="quiet" :disabled="!events.length && !result" @click="download">导出证据 JSON</button>
      <p v-if="!events.length">尚无证据。通过 Viewer 发送新一轮后开始记录。</p>
      <table v-else>
        <thead><tr><th>时间 / 轮次</th><th>证据来源</th><th>请求 → 返回模型</th></tr></thead>
        <tbody><tr v-for="(e, i) in [...events].reverse()" :key="i">
          <td>{{ e.recordedAt }}<br>{{ e.turnId }}</td>
          <td>{{ e.source === 'viewer/turnModel' ? '已接受的 turn/start 请求' : e.source === 'model/rerouted' ? 'model/rerouted 通知' : `真实 ${e.transport} · ${e.event}` }}<br v-if="e.responseId">{{ e.responseId }}</td>
          <td v-if="e.source === 'viewer/modelResponse'">{{ e.requestedModel }} → {{ e.model || '未返回 model' }}<br>返回 effort：{{ e.effort || '未知（未返回）' }} · {{ e.status }}</td>
          <td v-else-if="e.source === 'viewer/turnModel'">{{ e.model || '未显式指定（继承设置）' }} · {{ e.effort || '默认 / 继承' }}</td>
          <td v-else>{{ e.fromModel }} → {{ e.model }}<br>原因：{{ e.reason || '未提供' }}</td>
        </tr></tbody>
      </table>
      <details class="independent"><summary>独立 HTTP 诊断（可选）</summary>
      <button class="quiet" :disabled="checking" @click="check">{{ checking ? '正在抓取 HTTP 响应…' : '发送短请求实测 HTTP' }}</button>
      <p>实测使用当前会话模型和推理强度，另发一次“只回复 OK”的官方 HTTP 请求，消耗少量额度。读取响应正文的 model 和响应 ID；结果仅代表这次独立探测，不代表当前长会话。刷新前可导出。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div v-if="result" class="wire-result">
        <strong>HTTP 实测：{{ { match: '返回模型名一致', different: '返回模型名不同', unknown: '响应证据不足' }[result.verdict] }}</strong>
        <p>{{ result.recordedAt }} · 请求 {{ result.requestedModel }} · 推理 {{ result.effort || '默认' }}</p>
        <p v-for="(r, i) in result.responses" :key="i">{{ r.event }} → {{ r.model || '未返回 model' }} · 返回 effort：{{ r.effort || '未知（未返回）' }} · {{ r.responseId || '无响应 ID' }}</p>
      </div>
      </details>
    </div>
  </details>
</template>
<style scoped>
details { margin: 0 24px; font-size: 12px; flex: 0 0 auto; }
.independent { margin: 8px 0; }
summary { cursor: pointer; padding: 6px 0; }
.rerouted summary { color: var(--status-attention); font-weight: 600; }
.model-check-body { max-height: 300px; overflow: auto; padding: 8px; border: 1px solid var(--border-medium); }
p { margin: 6px 0; }
table { width: 100%; text-align: left; border-collapse: collapse; }
td, th { padding: 6px; border-bottom: 1px solid var(--border-subtle); overflow-wrap: anywhere; }
</style>
