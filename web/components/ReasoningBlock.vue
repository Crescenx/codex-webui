<script setup lang="ts">
import { computed } from 'vue';
import type { Item, Turn } from '../../shared/protocol.ts';
import { activity } from '../activity.ts';
import type { ReasoningGroup } from '../transcript.ts';
import MessageBody from './MessageBody.vue';
import type { MathDefinitions } from '../../shared/tex-macros.ts';
const props = defineProps<{ item: Item; turn: Turn; group: ReasoningGroup; threadId: string; itemKey: string; mathDefinitions?: MathDefinitions }>();
const emit = defineEmits<{ copy: [text: string]; layout: [element?: HTMLElement] }>();
const info = computed(() => activity(props.item, props.turn));
const labels: Record<string, string> = { failed: '失败', cancelled: '已取消', unknown: '状态未知' };
</script>
<template>
  <div class="activity reasoning" :class="group.state" data-kind="reasoning">
    <div v-if="group.firstKey === itemKey" class="activity-title" data-copy-ignore>
      <span class="activity-label">{{ group.state === 'running' ? '思考中' : '思考' }}</span>
      <span v-if="labels[group.state]" class="activity-state">{{ labels[group.state] }}</span>
    </div>
    <MessageBody v-if="info.detail" class="reasoning-summary" :source="info.detail" markdown :thread-id="threadId" :item-key="itemKey" :complete="info.state !== 'running'" :math-definitions="mathDefinitions" @copy="emit('copy', $event)" @layout="emit('layout', $event)" />
  </div>
</template>
