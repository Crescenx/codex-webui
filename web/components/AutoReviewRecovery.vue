<script setup lang="ts">
import {computed,ref} from 'vue';
import {materialVault} from '../environment.ts';
import {useViewer} from '../store.ts';
const embedded=!!materialVault();
const store=useViewer(),error=ref(''),busy=ref(false);
const failure=computed(()=>store.current.value?.autoReviewFailure);
async function choose(mode:'manual'|'bypass'|'dismiss'){
 const id=store.current.value?.id,f=failure.value;if(!id||!f)return;
 busy.value=true;error.value='';
 try{await store.resolveAutoReview(id,f.id,mode);if(mode!=='dismiss')store.toast('已切换审批方式，下一轮生效；失败操作未自动重试');}
 catch(e){error.value=e instanceof Error?e.message:String(e);}
 finally{busy.value=false;}
}
</script>
<template>
  <section v-if="failure" class="approval auto-review-recovery" aria-label="自动审批失败处理">
    <div role="alert"><strong>{{ failure.kind==='denied'?'自动审批未放行':'自动审批失败' }}</strong><p>{{ failure.reason }}</p></div>
    <p>是否为当前会话切换审批方式？切换会暂停 Goal 和当前 Watchdog、停止正在执行的轮次，下一轮生效。失败操作不会自动重试。</p>
    <p>人工审批保留沙箱并逐次询问；Bypass 关闭沙箱和后续审批。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="embedded">请在浏览器 Viewer 中切换审批方式。</p>
    <template v-else>
    <button type="button" :disabled="busy||!!store.state.permissionSaving" @click="choose('manual')">切换人工审批</button>
    <button type="button" class="quiet" :disabled="busy||!!store.state.permissionSaving" @click="choose('bypass')">切换 Bypass</button>
    <button type="button" class="quiet" :disabled="busy||!!store.state.permissionSaving" @click="choose('dismiss')">保持自动审批</button>
    </template>
  </section>
</template>
