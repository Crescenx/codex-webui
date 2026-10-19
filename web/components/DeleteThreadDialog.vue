<script setup lang="ts">
import { computed, ref } from 'vue';
import { threadTitle, useViewer } from '../store.ts';
const store=useViewer(),dialog=ref<HTMLDialogElement>(),id=ref(''),title=ref(''),busy=ref(false),error=ref('');
function show(threadId:string){id.value=threadId;const t=store.threads.value.find(t=>t.id===threadId);title.value=t?threadTitle(t):threadId;error.value='';dialog.value?.showModal();}
async function submit(){if(busy.value)return;busy.value=true;error.value='';try{await store.archiveThread(id.value);dialog.value?.close();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
defineExpose({show});
</script>
<template>
<dialog ref="dialog" id="delete-thread-dialog" class="workspace-dialog" aria-labelledby="delete-thread-title" @cancel="busy && $event.preventDefault()">
 <header class="dialog-header"><h2 id="delete-thread-title">删除会话</h2></header>
 <form @submit.prevent="submit"><div class="dialog-body"><p>删除“{{title}}”？</p><p class="subtle">会话将从列表移除，Codex 历史保留在归档中。</p><p v-if="error" role="alert">{{error}}</p></div><div class="dialog-actions"><button type="button" class="quiet" :disabled="busy" @click="dialog?.close()">取消</button><button type="submit" :disabled="busy">{{busy?'删除中…':'删除'}}</button></div></form>
</dialog>
</template>
