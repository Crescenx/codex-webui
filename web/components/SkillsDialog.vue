<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { Skill } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
const store = useViewer(), { current, draft } = store, dialog = ref<HTMLDialogElement>();
const busy = reactive<Record<string, boolean>>({});
const loading = computed(() => store.state.hydrating || draft.value?.loading);
const message = computed(() => !current.value ? '请先选择项目。' : loading.value ? '正在加载此项目的 Skills…' : draft.value?.catalog.errors.load || draft.value?.catalog.errors.skills ? 'Skills 加载失败：' + (draft.value.catalog.errors.load || draft.value.catalog.errors.skills) : !draft.value?.catalog.skills.length ? '此项目没有发现可用的 Skill。' : '');
async function toggle(skill: Skill) {
  const id = current.value?.id; if (!id) return;
  const key = id + ':' + skill.path; if (busy[key]) return; busy[key] = true;
  try { await store.setSkillEnabled(id, skill, !skill.enabled); } catch (e) { store.report(e, id); } finally { delete busy[key]; }
}
defineExpose({ show: () => dialog.value?.showModal() });
</script>
<template>
  <dialog id="skills-dialog" ref="dialog"><form method="dialog"><button class="close quiet" aria-label="关闭 Skills">✕</button></form><h2>Skills</h2><p class="subtle">选择用于本轮消息。全局开关会影响 CLI 和其他客户端。</p>
    <div id="skill-list">
      <template v-if="message"><p role="status">{{ message }}</p><button v-if="current && !loading" class="quiet" @click="store.loadControls()">重新加载</button></template>
      <template v-else><div v-for="s in draft?.catalog.skills || []" :key="s.path" class="skill-row"><strong :title="s.path">{{ s.name }}</strong><p>{{ s.description }}</p>
        <button class="quiet" :disabled="!s.enabled" @click="store.toggleSkill(s)">{{ draft?.skills.some(v => v.path === s.path) ? '已选中' : '用于本轮' }}</button>
        <button class="quiet" :disabled="busy[(current?.id || '') + ':' + s.path]" @click="toggle(s)">{{ s.enabled ? '全局：已启用' : '全局：已禁用' }}</button>
      </div><p v-if="draft?.catalog.skillErrors.length">部分 Skill 加载失败：{{ JSON.stringify(draft.catalog.skillErrors) }}</p></template>
    </div>
  </dialog>
</template>
