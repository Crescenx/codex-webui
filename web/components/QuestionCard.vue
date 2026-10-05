<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Item, Turn } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
const props = defineProps<{ item: Item; turn: Turn }>();
const store = useViewer(), error = ref('');
const questions = computed(() => props.item.questions || []);
const answers = computed(() => store.draft.value?.answers[props.item.id] || []);
const response = computed(() => store.questionResponse(props.item));
const status = computed(() => response.value.status);
const sent = computed(() => status.value === 'received' || status.value === 'queued');
const ready = computed(() => store.canSend.value && questions.value.every((_, i) => answers.value[i]?.trim()));
async function submit() {
  error.value = '';
  if (!await store.send('steer', props.item.id)) error.value = store.draft.value?.error || '回答未发送，请确认状态后重试。';
}
</script>
<template>
  <section class="question-card" aria-label="Codex 提问">
    <p class="question-state" role="status">{{ status === 'received' ? '回答已被 Codex 接收' : status === 'queued' ? '回答已排队，等待 Codex 接收' : status === 'history' ? '提问后已有新消息 · 可补充回答' : turn.status === 'inProgress' ? '待回答 · Codex 可继续执行' : '本轮已结束 · 仍可回答' }}</p>
    <form @submit.prevent="submit">
      <fieldset v-for="(q, i) in questions" :key="i" :disabled="sent || !store.canSend.value">
        <legend>{{ q.title }}</legend>
        <template v-if="!sent">
          <div class="question-options" data-copy-ignore><button v-for="option in q.options || []" :key="option" type="button" class="quiet" :aria-pressed="answers[i] === option" @click="store.setAnswer(item.id, i, option)">{{ option }}</button></div>
          <label>你的回答<textarea :aria-label="q.title" :value="answers[i] || ''" rows="2" maxlength="10000" placeholder="选择上方选项，或填写自己的回答" @input="store.setAnswer(item.id, i, ($event.target as HTMLTextAreaElement).value)" /></label>
        </template>
      </fieldset>
      <div v-if="sent" class="question-answer"><p class="subtle" data-copy-ignore>你的回答</p><div class="question-answer-text">{{ response.text }}</div></div>
      <template v-if="!sent"><p class="subtle">选择后点击发送才会提交。{{ store.active.value ? '回答会排队追加到当前任务。' : '发送将继续这段对话。' }}</p><button type="submit" class="primary" :disabled="!ready">{{ store.draft.value?.sending ? '正在发送…' : '发送回答' }}</button></template>
      <p v-if="status === 'queued'" class="subtle">可在输入区查看待接收队列，或打断并发送全部。</p>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>
