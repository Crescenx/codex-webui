<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, provide, ref, watch } from 'vue';
import Sidebar from '../web/components/Sidebar.vue';
import NameDialog from '../web/components/NameDialog.vue';
import Conversation from '../web/components/Conversation.vue';
import Composer from '../web/components/Composer.vue';
import ApprovalCard from '../web/components/ApprovalCard.vue';
import SkillsDialog from '../web/components/SkillsDialog.vue';
import FolderDialog from '../web/components/FolderDialog.vue';
import { createTranscriptMemory, transcriptMemoryKey } from '../web/transcript.ts';
import { viewerKey, threadTitle } from '../web/store.ts';
import type { ViewerStore } from '../web/store.ts';
import type { VaultBinding } from '../shared/vault.ts';
const props=defineProps<{store:ViewerStore;host:{binding:VaultBinding;lastSession?:string;save(text:string):Promise<void>;selection():string;remember(id:string):void}}>();
const store=props.store;provide(viewerKey,store);
const memory=createTranscriptMemory();provide(transcriptMemoryKey,memory);
const {current,draft,approvals}=store;
const skills=ref<InstanceType<typeof SkillsDialog>>(),composer=ref<InstanceType<typeof Composer>>();
const folder=ref<InstanceType<typeof FolderDialog>>();
const sidebarCollapsed=ref(false),conversation=ref<InstanceType<typeof Conversation>>(),name=ref<InstanceType<typeof NameDialog>>();
const preparing=ref(false),error=ref('');
async function create(){
 const id=await store.createThread(props.host.binding.root);
 if(!id)throw new Error('会话准备未完成，请重试');return id;
}
async function preparePrompt(text:string){
 if(preparing.value)throw new Error('正在准备会话');preparing.value=true;error.value='';
 try{await store.resync(false);await create();store.setText(text);await nextTick();composer.value?.focus();}
 catch(e){error.value=String(e);throw e;}finally{preparing.value=false;}
}
async function newConversation(){if(preparing.value)return;preparing.value=true;try{await create();await nextTick();composer.value?.focus();}catch(e){error.value=String(e);}finally{preparing.value=false;}}
async function saveDiscussion(){
 const text=props.host.selection().trim() || current.value?.turns?.flatMap(t=>t.items).findLast(i=>i.type==='agentMessage' && !i.delivery)?.text;
 if(!text){store.toast('请先选中讨论正文，或等待助手回复');return;}
 try{await props.host.save(text);store.toast('已保存到笔记');}catch(e){error.value=String(e);}
}
watch(()=>current.value?.id,id=>props.host.remember(id||''));
onMounted(()=>store.start(props.host.lastSession||''));
onBeforeUnmount(()=>{store.dispose();memory.clear();});
defineExpose({preparePrompt});
</script>
<template>
<div class="vault-assistant-shell">
<div v-if="store.state.error||draft?.error||draft?.readError||error" role="alert" class="va-error">{{store.state.error||draft?.error||draft?.readError||error}}</div>
<div class="va-workspace">
<Sidebar embedded flat :cwd="host.binding.root" v-show="!sidebarCollapsed" :title="host.binding.name" :busy="preparing" @new="folder?.show(host.binding.root, true)" @collapse="sidebarCollapsed=true" @find="conversation?.openSearch()" @rename="name?.show($event)"><button type="button" class="quiet va-save" @click="saveDiscussion">保存讨论</button></Sidebar>
<main class="va-main"><header class="va-header">
 <button v-if="sidebarCollapsed" type="button" class="quiet va-sidebar-toggle" aria-label="展开会话侧栏" @click="sidebarCollapsed=false"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M7.5 3v14"/></svg>会话</button>
 <strong :title="current?threadTitle(current):'Vault Assistant'">{{current?threadTitle(current):'Vault Assistant'}}</strong>
 <span v-if="current" class="subtle" :title="current.cwd">执行目录：{{current.cwd}}</span>
 </header>
 <section class="va-reading" aria-label="会话阅读区">
 <Conversation v-if="current" ref="conversation" search-in-sidebar @find="sidebarCollapsed=false" :key="current.id" :thread="current"/>
 <div v-else class="va-empty"><h2>聊论文，聊笔记，聊它们的联系。</h2><p>直接提到 vault 中的文件，或在 Obsidian 中右键选择“讨论该文章／讨论该选区”。</p><button :disabled="preparing" @click="newConversation">开始一个会话</button></div>
 </section>
 <section v-if="current" class="va-interaction" aria-label="消息与审批">
 <div v-if="approvals.length" class="approvals"><ApprovalCard v-for="request in approvals" :key="request.id" :request="request"/></div>
 <Composer ref="composer" @skills="skills?.show($event)"/>
 </section>
</main>
</div>
<SkillsDialog ref="skills"/><NameDialog ref="name"/><FolderDialog ref="folder"/>
<div v-if="store.state.toast" class="toast" role="status">{{store.state.toast}}</div>
</div>
</template>
