<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import type { Item, Thread, Turn } from '../../shared/protocol.ts';
import type { DeepReadonly } from 'vue';
import { useViewer } from '../store.ts';
import { installCopy } from '../render.ts';
import { installLinks } from '../links.ts';
import { createMermaidRenderer, mermaidKey } from '../mermaid.ts';
import MessageBody from './MessageBody.vue';
import ActivityBlock from './ActivityBlock.vue';
import QuestionCard from './QuestionCard.vue';
const emit = defineEmits<{ new: [] }>();
const props = defineProps<{ thread?: DeepReadonly<Thread>; readonly?: boolean }>();
const store = useViewer(), current = computed(() => props.readonly ? props.thread : store.current.value);
const threadId = computed(() => current.value?.id || '');
const targetTurn = computed(() => props.readonly ? '' : store.state.targetTurn);
type Row = { key: string; original: DeepReadonly<Item>; item: Item; turn: Turn; source: string; message: boolean };
const conversation = ref<HTMLElement>(), rows = shallowRef<Row[]>([]), follow = ref(true);
const mermaid = createMermaidRenderer(() => conversation.value); provide(mermaidKey, mermaid);
let frame = 0, disposed = false, jumpedTo = '';
let removeCopy = () => {}, removeLinks = () => {};
async function copy(text: string) { try { await navigator.clipboard.writeText(text); store.toast('已复制'); } catch { store.toast('无法访问剪贴板，请选中文字后复制'); } }
function selected() { const selection = getSelection(); return !!selection && !selection.isCollapsed && !!selection.anchorNode && !!conversation.value?.contains(selection.anchorNode); }
async function paint() {
  frame = 0; if (disposed || selected()) return;
  const t = current.value;
  const previous = new Map(rows.value.map(r => [r.key, r]));
  // ponytail: scan loaded items once per frame; virtualize only when long histories warrant it.
  // Detached display rows keep live mutations out of DOM while text is selected.
  rows.value = (t?.turns || []).flatMap(turn => turn.items.map(item => {
    const key = `${t!.id}:${turn.id}:${item.id}`;
    const cached = previous.get(key);
    if (cached?.original === item && cached.turn.status === turn.status) return cached;
    const source = item.type === 'userMessage' ? (item.content || []).map(p => p.type === 'text' ? String(p.text || '') : p.type === 'skill' ? '$' + String(p.name) : '[图片附件]').join('\n') : item.text || '';
    return { key, original: item, item: cached?.original === item ? cached.item : JSON.parse(JSON.stringify(item)) as Item, turn: { id: turn.id, status: turn.status, items: [] }, source, message: ['agentMessage', 'userMessage', 'plan'].includes(item.type) };
  }));
  await nextTick();
  if(targetTurn.value && targetTurn.value!==jumpedTo) {
    const target=conversation.value?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(targetTurn.value)}"]`);
    if(target){jumpedTo=targetTurn.value;follow.value=false;target.scrollIntoView({block:'start'});return;}
  }
  if (!disposed && follow.value && !selected() && conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight;
}
function schedule() { if (!frame && !disposed) frame = requestAnimationFrame(() => { void paint(); }); }
function installReferences() { removeLinks(); if (conversation.value) removeLinks = installLinks(conversation.value, () => threadId.value || undefined, store.report, store); }
watch(() => [threadId.value, store.state.revisions[threadId.value]], schedule);
watch(targetTurn,()=>{jumpedTo='';schedule();});
watch(threadId, () => { if (selected()) getSelection()?.removeAllRanges(); follow.value = true; rows.value = []; installReferences(); });
function scroll() { const el = conversation.value; if (el) follow.value = el.scrollHeight - el.clientHeight - el.scrollTop < 100; }
function latest() { follow.value = true; if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight; }
onMounted(() => { removeCopy = installCopy(conversation.value!); installReferences(); document.addEventListener('selectionchange', schedule); schedule(); });
onBeforeUnmount(() => { disposed = true; mermaid.dispose(); cancelAnimationFrame(frame); document.removeEventListener('selectionchange', schedule); removeCopy(); removeLinks(); });
</script>
<template>
  <div :id="readonly ? 'agent-conversation' : 'conversation'" class="conversation" ref="conversation" tabindex="0" :aria-label="readonly ? '子代理执行记录' : '对话记录'" @scroll="scroll">
    <div v-if="!current && !readonly" class="welcome"><div class="eyebrow">YOUR WORK, IN FOCUS</div><h2>从一个项目开始。</h2><p>选择左侧已有对话，或选择项目目录新建任务。<br>选好项目后，即可设置模型、思考强度、Plan 和 Skills。</p><button id="welcome-new" class="primary" @click="emit('new')">选择项目，新建任务</button></div>
    <article v-for="row in rows" :key="row.key" class="message" :data-turn-id="row.turn.id" :class="[row.item.type === 'userMessage' ? 'user' : row.message ? 'assistant' : 'tool', { 'target-turn': row.turn.id === targetTurn }]">
      <div class="message-header" data-copy-ignore :hidden="!row.message"><span v-if="row.message">{{ row.item.type === 'userMessage' ? (readonly ? '任务输入' : '你') : row.item.type === 'plan' ? 'Codex · Plan' : 'Codex' }}</span><button v-if="row.item.type === 'agentMessage' || row.item.type === 'plan'" type="button" class="quiet" @click="copy(row.source)">复制 Markdown</button></div>
      <QuestionCard v-if="!readonly && row.item.type === 'agentMessage' && row.item.delivery === 'async' && row.item.questions?.length" :item="row.item" :turn="row.turn" />
      <MessageBody v-else-if="row.message" :source="row.source" :markdown="row.item.type !== 'userMessage'" :thread-id="current?.id" :complete="row.turn.status !== 'inProgress'" @copy="copy" @layout="schedule" />
      <ActivityBlock v-else :item="row.item" :turn="row.turn" @copy="copy" />
    </article>
  </div>
  <button :id="readonly ? 'agent-latest' : 'latest'" class="quiet latest" :hidden="follow" @click="latest">↓ 回到最新</button>
</template>
