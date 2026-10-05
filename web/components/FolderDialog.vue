<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { NewThreadOptions } from '../../shared/protocol.ts';
import type { Directories } from '../api.ts';
import { useViewer } from '../store.ts';
const store = useViewer(), dialog = ref<HTMLDialogElement>();
const folders = ref<Directories>({ roots: [], path: null, directories: [] }), creating = ref(false), loading = ref(false), picking = ref(false);
const location = ref(''), error = ref(''), fixedDirectory = ref(false);
const options = ref<NewThreadOptions>(), model = ref(''), context = ref(false), optionsLoading = ref(false), optionsError = ref('');
const contextReason = computed(() => {
  if(optionsLoading.value) return '正在检查模型能力…';
  if(!options.value) return '模型能力暂不可用，可重试或使用默认设置创建普通任务';
  if(options.value.contextReason) return options.value.contextReason;
  const support=options.value.models.find(m=>m.model===model.value)?.supportsExperimentalContext;
  return support===true?'':support===false?'所选模型不支持实验上下文管理':'所选模型的上下文能力尚未确认';
});
watch(contextReason, reason => { if(reason)context.value=false; });
let controller: AbortController | undefined;
let optionsController: AbortController | undefined;
async function loadOptions(path: string) {
  optionsController?.abort();const job=new AbortController();optionsController=job;
  optionsLoading.value=true;optionsError.value='';options.value=undefined;context.value=false;model.value='';
  try { const result=await store.newThreadOptions(path,job.signal);if(!job.signal.aborted){options.value=result;model.value=result.defaultModel;} }
  catch(e){if(!job.signal.aborted)optionsError.value=e instanceof Error?e.message:String(e);}
  finally{if(!job.signal.aborted)optionsLoading.value=false;}
}
async function show(path?: string, fixed = false) {
  close(); const job = new AbortController(); controller = job;
  fixedDirectory.value = fixed && !!path;
  optionsController?.abort(); options.value=undefined;context.value=false;model.value='';optionsLoading.value=false;optionsError.value='';
  if (!dialog.value?.open) dialog.value?.showModal();
  error.value = '';
  if (fixedDirectory.value && path) {
    folders.value = { roots: [], path, directories: [] };
    location.value = path;
    void loadOptions(path);
    return;
  }
  loading.value = true; error.value = '';
  try { const result = await store.directories(path, job.signal); if (!job.signal.aborted) { folders.value = result; location.value = result.path || ''; if(result.path)void loadOptions(result.path); } }
  catch (e) { if (!job.signal.aborted) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (!job.signal.aborted) loading.value = false; }
}
function close() { controller?.abort(); optionsController?.abort(); creating.value = false; loading.value = false; picking.value = false; optionsLoading.value=false; }
async function pick() {
  if (picking.value || loading.value || creating.value) return;
  controller?.abort(); const job = new AbortController(); controller = job;
  picking.value = true; error.value = '';
  try {
    const result = await store.pickDirectory(folders.value.path || undefined, job.signal);
    if (!job.signal.aborted && result.path) { picking.value = false; await show(result.path); }
  } catch (e) { if (!job.signal.aborted) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (controller === job) picking.value = false; }
}
async function create() {
  if (!folders.value.path || creating.value || loading.value || picking.value || error.value) return; creating.value = true;
  const opened = controller;
  const valid = () => opened === controller && !opened?.signal.aborted;
  try {
    await store.createThread(folders.value.path, model.value ? { model: model.value, contextManagement: context.value && !contextReason.value } : undefined);
    if (valid()) dialog.value?.close();
  } catch (e) { if (valid()) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (valid()) creating.value = false; }
}
onBeforeUnmount(close);
defineExpose({ show });
</script>
<template>
  <dialog id="folder-dialog" class="workspace-dialog" ref="dialog" aria-labelledby="folder-title" @close="!dialog?.open && close()"><header class="dialog-header"><h2 id="folder-title">新建任务</h2><button type="button" class="quiet" aria-label="关闭" @click="dialog?.close()">关闭</button></header><div class="dialog-body">
    <template v-if="!fixedDirectory">
    <p class="subtle">选择 Windows 本地文件夹，或浏览 WSL 中的项目。</p>
    <button id="folder-native" class="primary" :disabled="picking || loading || creating" @click="pick">{{ picking ? '请在系统窗口中选择…' : '浏览本地文件夹…' }}</button>
    <button v-if="picking" id="folder-cancel-pick" class="quiet" @click="close">取消选择，返回目录浏览</button>
    <form class="folder-location" @submit.prevent="show(location || undefined)">
      <label class="sr-only" for="folder-location">文件夹路径</label><input id="folder-location" v-model="location" placeholder="WSL 路径或 C:\Users\…" :disabled="picking || creating" autocomplete="off" spellcheck="false"><button class="quiet" :disabled="picking || creating || loading">前往</button>
    </form>
    </template>
    <p id="folder-error" role="alert" :hidden="!error">{{ error }}</p>
    <div v-if="!fixedDirectory" class="folder-navigation"><button id="folder-up" class="quiet" :disabled="picking || loading || creating || !folders.path" @click="show(folders.path && !folders.roots.includes(folders.path) ? folders.path.slice(0, folders.path.lastIndexOf('/')) || '/' : undefined)">↑ 上一级</button><button class="quiet" :disabled="picking || loading || creating" @click="show()">项目位置</button></div>
    <p id="folder-path" class="subtle">{{ folders.path || '项目位置' }}</p><div v-if="!fixedDirectory" id="folders" :aria-busy="loading"><p v-if="loading" class="subtle">正在读取文件夹…</p><template v-else><button v-for="dir in folders.directories" :key="dir" class="folder" :disabled="picking || creating" @click="show(dir)">▱ {{ dir }}</button><p v-if="!folders.directories.length" class="subtle">此目录没有子文件夹，可直接在此新建任务。</p></template></div>
    <fieldset v-if="folders.path" class="new-thread-settings" :disabled="creating || picking || loading || optionsLoading">
      <legend>会话设置</legend>
      <label for="new-model">模型</label><select id="new-model" v-model="model" :disabled="!options?.models.length">
        <option v-if="!model || !options?.models.some(m=>m.model===model)" :value="model">{{ optionsLoading?'正在加载…':model || '使用项目默认模型' }}</option>
        <option v-for="m in options?.models || []" :key="m.model" :value="m.model">{{ m.displayName }}</option>
      </select>
      <label class="context-choice"><input id="new-context" v-model="context" type="checkbox" :disabled="!!contextReason" aria-describedby="new-context-help">实验上下文管理</label>
      <p id="new-context-help" class="subtle">{{ contextReason || '通过笔记和历史检索延续长任务；仅用于此会话，创建后固定。' }}</p>
      <p v-if="optionsError" class="subtle" role="status">配置加载失败：{{ optionsError }} <button type="button" class="quiet" @click="loadOptions(folders.path!)">重试</button></p>
    </fieldset>
    </div><div class="dialog-actions"><span v-if="!fixedDirectory" class="subtle">{{ picking ? '取消系统选择器即可返回' : '任务将在所选目录中运行' }}</span><button id="folder-select" :disabled="!folders.path || creating || loading || picking || !!error" @click="create">{{ creating ? '正在新建…' : optionsLoading ? '使用项目默认设置新建' : fixedDirectory ? '新建任务' : '在此新建任务' }}</button></div>
  </dialog>
</template>
