<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Item, Turn } from '../../shared/protocol.ts';
import { activity } from '../activity.ts';
import { highlightInto, outputText } from '../highlight.ts';
const props = defineProps<{ item: Item; turn: Turn }>();
const emit = defineEmits<{ copy: [text: string] }>();
const info = computed(() => activity(props.item, props.turn));
const command = computed(() => props.item.type === 'commandExecution');
const expandable = computed(() => !!info.value.detail || (command.value && !!info.value.subject));
const open = ref(false), subject = ref<HTMLElement>(), commandCode = ref<HTMLElement>(), output = ref<HTMLElement>(), now = ref(Date.now());
watch(() => info.value.state, (state, _, cleanup) => {
  if (state !== 'running') return;
  const timer = setInterval(() => { now.value = Date.now(); }, 1000);
  cleanup(() => clearInterval(timer));
}, { immediate: true });
watch([subject, commandCode, output, open, info], () => {
  if (command.value && subject.value) { highlightInto(subject.value, info.value.subject); subject.value.title = info.value.subject; }
  if (!open.value) return;
  if (commandCode.value) highlightInto(commandCode.value, info.value.subject);
  if (output.value) { const pre = output.value.parentElement!, top = pre.scrollTop, left = pre.scrollLeft; highlightInto(output.value, info.value.detail, 'output'); pre.scrollTop = top; pre.scrollLeft = left; }
}, { flush: 'post' });
const labels: Record<string, string> = { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态未知' };
</script>
<template>
  <component :is="expandable ? 'details' : 'div'" class="activity" :class="info.state" :data-kind="item.type" :open="expandable ? open : undefined" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <component :is="expandable ? 'summary' : 'div'" class="activity-title"><span class="activity-label">{{ info.label }}</span><code v-if="command && info.subject" ref="subject" class="activity-command" :title="info.subject"></code><span v-else-if="info.subject" class="activity-subject" :title="info.subject">{{ info.subject }}</span><span class="activity-state">{{ labels[info.state] || info.state }}</span><time v-if="info.state === 'running' && item.startedAt" :data-since="item.startedAt"> {{ Math.max(0, Math.floor((now - item.startedAt) / 1000)) }}s</time></component>
    <template v-if="command">
      <pre v-if="info.subject" class="activity-command-full"><div class="code-toolbar" data-copy-ignore><span>命令</span><button type="button" class="quiet" @click="emit('copy', item.command || '')">复制命令</button></div><code ref="commandCode"></code></pre>
      <pre v-if="info.detail" class="activity-output"><div class="code-toolbar" data-copy-ignore><span>输出</span><button type="button" class="quiet" @click="emit('copy', outputText(item.aggregatedOutput || ''))">复制输出</button></div><code ref="output"></code></pre>
    </template>
    <pre v-else-if="info.detail">{{ info.detail }}</pre>
  </component>
</template>
