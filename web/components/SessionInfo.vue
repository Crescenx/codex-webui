<script setup lang="ts">
import { computed, ref } from "vue";
import type { Settings } from "../../shared/protocol.ts";
import { runtimeName } from "../../shared/runtime.ts";
import { useViewer } from "../store.ts";
const store=useViewer(), {current,draft}=store;
const details=ref<HTMLDetailsElement>();
const loading=computed(()=>!current.value || store.state.hydrating || draft.value?.loading);
const catalog=computed(()=>draft.value?.catalog);
const desired=computed(()=>draft.value?.desired || current.value?.settings);
const runtime=computed(()=>store.state.runtimes.find(r=>r.id===(current.value?.runtimeId || "codex")));
const attention=computed(()=>runtime.value?.online===false || !!Object.keys(catalog.value?.errors || {}).length || store.contextBlocked.value);
const description = (s: Settings) => `${s.model} · ${s.effort || '默认强度'} · ${s.mode === 'plan' ? 'Plan' : '普通'}`;
const settingsState = computed(() => {
  if (!current.value) return '请先选择项目';
  if (loading.value) return '正在加载此项目的模型、模式和 Skills…';
  const errors = Object.values(catalog.value?.errors || {}).map(e => '配置加载失败：' + e).join('；');
  const effective = current.value.settings;
  const reviewer=current.value.approvalsReviewer;
  return errors || (effective ? '已生效：' + description(effective) + ' · ' + (reviewer==='auto_review'?'自动审查':reviewer==='user'?'人工审批':'审批方式待确认') + (desired.value && JSON.stringify(desired.value) !== JSON.stringify(effective) ? ' ｜下一轮：' + description(desired.value) : '') : '');
});
function close(){if(details.value){details.value.open=false;details.value.querySelector("summary")?.focus();}}
</script>
<template>
  <details ref="details" class="session-info" @keydown.esc.stop.prevent="close">
    <summary id="settings-toggle">会话信息<span v-if="attention"> · 需处理</span></summary>
    <div class="session-info-panel">
    <div class="runtime-status subtle" role="status">{{ runtimeName(current || {}) }} · {{ runtime ? runtime.online?'已连接':'未连接':'正在确认连接' }}<button v-if="runtime && !runtime.online" type="button" class="quiet" :disabled="loading" @click="store.reloadSession()">重新连接</button></div>
      <div id="settings-state" class="subtle" role="status">{{ settingsState }}</div>
    <div v-if="current?.contextManagement" id="context-state" class="subtle" role="status" title="此会话创建时启用，恢复时保留；模型须支持实验上下文管理">实验上下文管理 · {{ loading?'正在检查模型…':store.contextBlocked.value?'当前模型不支持或能力未确认，请选择兼容模型或重新加载配置':'已开启' }}</div>
    <button id="controls-retry" type="button" class="quiet" :hidden="loading || !Object.keys(catalog?.errors || {}).length" @click="store.loadControls()">重新加载配置</button>
    </div>
  </details>
</template>
