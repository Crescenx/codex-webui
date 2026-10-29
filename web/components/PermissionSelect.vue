<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useViewer } from '../store.ts';
import type { PermissionSettings } from '../api.ts';
const store=useViewer(),{current,draft,active,approvals}=store;
const id=current.value!.id;
const saved=ref<PermissionSettings>(),selected=ref(''),loading=ref(true),saving=ref(false),error=ref(''),message=ref('');
let alive=true;
onUnmounted(()=>{alive=false;});
const blocked=computed(()=>active.value||!!approvals.value.length||current.value?.goal?.status==='active'||draft.value?.sending||draft.value?.stopping||draft.value?.goalSaving||store.state.hydrating||store.state.restarting||store.state.restartPending||store.state.authExpired);
const note=computed(()=>loading.value?'正在读取审批设置…':saving.value?'正在保存审批设置…':blocked.value?'结束当前任务并暂停 Goal 后可修改审批方式':selected.value==='bypass'?'Bypass：下一轮不审批，关闭沙箱限制':message.value||'审批设置从下一轮生效');
async function load(){
  loading.value=true;error.value='';
  try {const value=await store.readPermissions(id);if(alive){saved.value=value;selected.value=value.mode||'';}}
  catch(e){if(alive)error.value=e instanceof Error?e.message:String(e);}
  finally{if(alive)loading.value=false;}
}
async function change(){
  saving.value=true;error.value='';message.value='';
  try {const value=await store.savePermissions(id,(selected.value||null) as PermissionSettings['mode']);if(alive){saved.value=value;message.value='已保存，下一轮生效';}}
  catch(e){if(alive){selected.value=saved.value?.mode||'';error.value=e instanceof Error?e.message:String(e);}}
  finally{if(alive)saving.value=false;}
}
onMounted(load);
watch(()=>store.state.permissionRevision,()=>{if(!saving.value)void load();});
</script>
<template>
  <label class="permission-control">审批
    <select id="approval-mode" v-model="selected" aria-label="审批方式" aria-describedby="approval-mode-note" :disabled="loading||saving||blocked||!saved" :title="note" @change="change">
      <option value="">{{ loading?'正在加载…':saved?'跟随默认'+(saved.mode===null?' · '+(saved.approvalsReviewer==='auto_review'?'自动':'人工'):''):'暂不可用' }}</option>
      <option value="auto">自动审批</option><option value="manual">人工审批</option><option value="bypass">Bypass · 完全访问</option>
    </select>
    <span id="approval-mode-note" class="sr-only" role="status">{{ note }}</span>
  </label>
  <span v-if="error" class="permission-feedback" role="alert">{{ error }} <button type="button" class="quiet" :disabled="loading||saving" @click="load">重试</button></span>
</template>
