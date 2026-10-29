<script setup lang="ts">
import {onMounted,ref,watch} from 'vue';
import {useViewer} from '../store.ts';
const store=useViewer(),mode=ref<'auto'|'manual'>('auto'),saved=ref<'auto'|'manual'>('auto'),busy=ref(true),error=ref('');
async function load(){try{const r=await store.readDefaultPermissions();mode.value=saved.value=r.mode;}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function change(){busy.value=true;error.value='';try{const r=await store.saveDefaultPermissions(mode.value);saved.value=r.mode;}catch(e){mode.value=saved.value;error.value=String(e);}finally{busy.value=false;}}
onMounted(load);watch(()=>store.state.permissionRevision,()=>{if(!busy.value)void load();});
</script>
<template>
  <label>默认审批 <select v-model="mode" aria-label="默认审批" :disabled="busy" @change="change"><option value="auto">Auto review · 自动审批</option><option value="manual">人工审批</option></select></label>
  <p v-if="error" role="alert">{{ error }}</p>
</template>
