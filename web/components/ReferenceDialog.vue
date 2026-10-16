<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import { threadTitle, useViewer } from '../store.ts';
import type { ConversationReference, ReferencePosition } from '../../shared/references.ts';
import { workspacePath } from '../workspace-path.ts';
const store=useViewer(), dialog=ref<HTMLDialogElement>(), heading=useId(), search=ref('');
const kind=ref<'snapshot'|'session'>('snapshot'), sourceId=ref(''), targetId=ref(''), chooseSource=ref(false);
const folder=ref(''), locations=ref<string[]>([]), loadingFolders=ref(false);
const newTarget='__new__', createNew=computed(()=>!chooseSource.value && targetId.value===newTarget);
const selected=ref<ReferencePosition[]>([]), preview=ref<ConversationReference>(), busy=ref(false), error=ref('');
let generation=0, picker:AbortController|undefined;
const folders=computed(()=>[...new Map([...store.threads.value.map(t=>t.cwd),store.current.value?.cwd||'',...locations.value].filter(Boolean).map(path=>[workspacePath(path),path])).values()].sort());
const choices=computed(()=>store.threads.value.filter(t=>workspacePath(t.cwd)===workspacePath(folder.value) && (chooseSource.value?t.id!==targetId.value:t.id!==sourceId.value) && threadTitle(t).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())));
function changeFolder(path:string){folder.value=path;search.value='';error.value='';if(chooseSource.value)sourceId.value='';else targetId.value='';}
function reset(){generation++;picker?.abort();busy.value=false;loadingFolders.value=false;preview.value=undefined;error.value='';search.value='';folder.value='';locations.value=[];}
async function loadFolders(){
 const gen=generation;loadingFolders.value=true;
 await Promise.all([store.loadThreads(),store.directories().then(data=>{if(gen===generation)locations.value=data.roots;}).catch(e=>{if(gen===generation)error.value=String(e);})]);
 if(gen===generation)loadingFolders.value=false;
}
async function pickFolder(){
 if(busy.value)return;const gen=generation;busy.value=true;error.value='';picker=new AbortController();
 try{const result=await store.pickDirectory(folder.value||undefined,picker.signal);if(gen===generation && result.path){locations.value.push(result.path);changeFolder(result.path);}}
 catch(e){if(gen===generation)error.value=String(e);}finally{if(gen===generation)busy.value=false;}
}
async function showSnapshot(source:string,positions:ReferencePosition[]){reset();kind.value='snapshot';sourceId.value=source;targetId.value='';chooseSource.value=false;selected.value=positions;dialog.value?.showModal();await loadFolders();}
async function showSession(source?:string){reset();kind.value='session';chooseSource.value=!source;sourceId.value=source || '';targetId.value=source?'':store.state.currentId;selected.value=[];dialog.value?.showModal();await loadFolders();}
async function prepare(){
  if(busy.value)return;
  if(!folder.value || !sourceId.value || !targetId.value){error.value='请先选择文件夹，再选择会话或新建对话';return;}
  const gen=generation;busy.value=true;error.value='';
  try{
    if(createNew.value)targetId.value=await store.referenceTarget(folder.value);
    const result=await store.createReference(targetId.value,sourceId.value,kind.value,selected.value);
    if(gen===generation)preview.value=result.reference;
  }catch(e){if(gen===generation)error.value=e instanceof Error?e.message:String(e);}finally{if(gen===generation)busy.value=false;}
}
async function remove(position:ReferencePosition){
  if(busy.value)return;
  if(selected.value.length<=1){error.value='至少保留一条记录，或取消转发';return;}
  const before=selected.value;selected.value=before.filter(p=>p.turnId!==position.turnId || p.itemId!==position.itemId);
  await prepare();if(error.value)selected.value=before;
}
async function confirm(){if(!preview.value || busy.value)return;busy.value=true;error.value='';try{await store.attachReference(preview.value);dialog.value?.close();await nextTick();}catch(e){error.value=String(e);}finally{busy.value=false;}}
onBeforeUnmount(reset);
defineExpose({showSnapshot,showSession});
</script>
<template>
  <dialog ref="dialog" class="workspace-dialog reference-dialog" :aria-labelledby="heading" @close="reset" @cancel="busy && $event.preventDefault()">
    <header class="dialog-header"><h2 :id="heading">{{ preview?'预览':kind==='snapshot'?'转发聊天记录':'引用 Session' }}</h2><button type="button" class="quiet" :disabled="busy" @click="dialog?.close()">关闭</button></header>
    <form @submit.prevent="preview?confirm():prepare()">
      <div class="dialog-body">
        <template v-if="!preview">
          <p>{{ kind==='snapshot'?`已选 ${selected.length} 条记录。仅转发选中的内容，不授予原会话读取权限。`:'发送后，AI 可按需读取来源会话的最新历史；可随时撤销后续读取权限。' }}</p>
          <label>{{ chooseSource?'来源文件夹':'目标文件夹' }}
            <select :value="folder" :disabled="busy" @change="changeFolder(($event.target as HTMLSelectElement).value)">
              <option value="">{{ loadingFolders?'正在读取文件夹…':'先选择文件夹…' }}</option><option v-for="path in folders" :key="path" :value="path">{{ path }}</option>
            </select>
          </label>
          <button type="button" class="quiet" :disabled="busy" @click="pickFolder">选择其他文件夹…</button>
          <label v-if="folder">搜索会话 <input v-model="search" type="search" placeholder="搜索此文件夹内的会话" :disabled="busy"></label>
          <label>{{ chooseSource?'来源会话':'目标会话' }}
            <select :value="chooseSource?sourceId:targetId" :disabled="!folder || busy" @change="chooseSource?sourceId=($event.target as HTMLSelectElement).value:targetId=($event.target as HTMLSelectElement).value">
              <option value="">{{ folder?'请选择会话…':'请先选择文件夹' }}</option><option v-if="!chooseSource" :value="newTarget">＋ 在此文件夹新建对话</option><option v-for="thread in choices" :key="thread.id" :value="thread.id">{{ threadTitle(thread) }}</option>
            </select>
          </label>
          <p v-if="folder && !choices.length" class="subtle">{{ loadingFolders?'正在读取会话…':search?'此文件夹中没有匹配的已加载会话。':'此文件夹暂无已加载会话。' }}</p>
          <button v-if="store.state.cursor" type="button" class="quiet" :disabled="store.state.moreLoading" @click="store.loadThreads(true)">加载更多会话</button>
          <p v-if="createNew" class="subtle">将在 {{ folder }} 新建对话，引用先加入草稿，由你确认发送。</p>
        </template>
        <template v-else>
          <p><strong>{{ preview.kind==='snapshot'?'固定聊天记录':'持续只读 Session' }}</strong> · {{ preview.title }}</p>
          <p class="subtle">{{ preview.kind==='snapshot'?'以下是完整转发内容；不附带图片、文件实体。敏感凭据字段不打包。':'只发送来源信息及工具入口；不会自动附加全文。授权仅属于目标会话。' }}</p>
          <div v-for="entry in preview.entries || []" :key="entry.turnId+':'+entry.itemId" class="reference-preview-entry"><header><strong>{{ entry.role }} · {{ entry.type }}</strong><button type="button" class="quiet" :disabled="busy" @click="remove(entry)">移除此条</button></header><pre>{{ entry.text }}</pre></div>
        </template>
        <p v-if="error" role="alert">{{ error }}</p>
      </div>
      <div class="dialog-actions"><button type="button" class="quiet" :disabled="busy" @click="preview?preview=undefined:dialog?.close()">{{ preview?'返回':'取消' }}</button><button type="submit" :disabled="busy">{{ busy?'正在准备…':preview?'加入目标草稿':'预览' }}</button></div>
    </form>
  </dialog>
</template>
<style scoped>
.reference-dialog{width:min(760px,85vw)}label{display:block;margin:12px 0}select{width:100%;max-width:100%}.dialog-body{max-height:65vh;overflow:auto}.reference-preview-entry{border-top:1px solid var(--line,#d9d1c4);margin-top:12px}.reference-preview-entry header{display:flex;justify-content:space-between;align-items:center}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6}
</style>
