<script setup lang="ts">
import type { DeepReadonly } from 'vue';
import type { ConversationReference } from '../../shared/references.ts';
import { useViewer } from '../store.ts';
defineProps<{ reference: DeepReadonly<ConversationReference>; removable?: boolean }>();
const emit=defineEmits<{remove:[]}>(), store=useViewer();
</script>
<template>
  <details class="conversation-reference">
    <summary><strong>{{ reference.kind==='snapshot'?'聊天记录':'Session 引用' }}</strong> · {{ reference.title }} <span class="subtle">{{ reference.revoked?'已撤销':reference.kind==='snapshot'?`${reference.entries?.length || 0} 条 · 固定内容`:reference.active?'持续只读 · 可读取最新历史':'发送后授权读取' }}</span></summary>
    <div class="reference-body">
      <p class="subtle">{{ reference.kind==='snapshot'?'仅包含选中的文字及工具记录；图片和文件未附带实体，也未授予原会话访问权限。':'AI 按需检索和阅读最新已结束记录；不会自动把整段历史加入上下文。' }}</p>
      <button type="button" class="quiet" @click="store.jumpToReference(reference.sourceThreadId,reference.entries?.[0]).catch(store.report)">查看来源</button>
      <button v-if="removable" type="button" class="quiet" @click="emit('remove')">从草稿移除</button>
      <div v-for="entry in reference.entries || []" :key="entry.turnId+':'+entry.itemId" class="reference-entry"><small>{{ entry.role }} · {{ entry.type }} <span v-if="entry.status">· {{ entry.status }}</span></small><pre>{{ entry.text }}</pre></div>
    </div>
  </details>
</template>
<style scoped>
.conversation-reference{border:1px solid var(--line,#d9d1c4);border-radius:8px;padding:8px 12px;margin:6px 0;text-align:left;overflow-wrap:anywhere}
summary{cursor:pointer}summary strong{font-weight:600}.reference-body{max-height:360px;overflow:auto}.reference-entry{border-top:1px solid var(--line,#d9d1c4);padding-top:8px;margin-top:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6}small{color:var(--muted,#746c60)}
</style>
