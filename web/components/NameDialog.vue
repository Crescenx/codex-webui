<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { threadTitle, useViewer } from '../store.ts';
const store = useViewer(), dialog = ref<HTMLDialogElement>(), input = ref<HTMLInputElement>();
const name = ref(''), error = ref(''), busy = ref(false);
let threadId = '', generation = 0;
function close() { ++generation; busy.value = false; }
async function show(id?:string) {
  const t = id ? store.threads.value.find(t=>t.id===id) : store.current.value; if (!t) return;
  close(); const gen = generation;
  threadId = t.id; name.value = threadTitle(t); error.value = ''; dialog.value?.showModal();
  await nextTick(); if (gen === generation) { input.value?.focus(); input.value?.select(); }
}
async function submit() {
  if (busy.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try { await store.rename(threadId, name.value); if (gen === generation) dialog.value?.close(); }
  catch (e) { if (gen === generation) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (gen === generation) busy.value = false; }
}
onBeforeUnmount(close);
defineExpose({ show });
</script>
<template>
  <dialog id="name-dialog" class="workspace-dialog" ref="dialog" aria-labelledby="name-heading" @close="close"><header class="dialog-header"><h2 id="name-heading">重命名对话</h2><button type="button" class="quiet" aria-label="关闭重命名" @click="dialog?.close()">关闭</button></header><form id="name-form" @submit.prevent="submit"><div class="dialog-body"><label for="thread-name">标题</label><input id="thread-name" ref="input" v-model="name" required autocomplete="off"><p class="subtle">保存到 Codex 会话；使用同一份会话存储的客户端可在刷新后读取。</p><p id="name-error" role="alert" :hidden="!error">{{ error }}</p></div><div class="dialog-actions"><button id="name-cancel" type="button" class="quiet" @click="dialog?.close()">取消</button><button id="name-save" type="submit" :disabled="busy">保存</button></div></form></dialog>
</template>
