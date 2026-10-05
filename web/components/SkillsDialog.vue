<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { Skill } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
import { matchingSkills } from '../skills.ts';
const store = useViewer(), { current, draft } = store, dialog = ref<HTMLDialogElement>();
const busy = reactive<Record<string, boolean>>({});
const search = ref(''), view = ref<'all' | 'selected' | 'manage'>('all'), input = ref<HTMLInputElement>();
const selected = computed(() => new Set(draft.value?.skills.map(s => s.path) || []));
const nameCounts = computed(() => { const counts = new Map<string, number>(); for (const s of draft.value?.catalog.skills || []) counts.set(s.name, (counts.get(s.name) || 0) + 1); return counts; });
const matches = computed(() => matchingSkills(draft.value?.catalog.skills || [], search.value).filter(s => view.value !== 'selected' || selected.value.has(s.path)));
async function show(query = '') { search.value = query; view.value = 'all'; dialog.value?.showModal(); await nextTick(); input.value?.focus(); }
watch(() => current.value?.id, () => dialog.value?.close());
const loading = computed(() => store.state.hydrating || draft.value?.loading);
const message = computed(() => !current.value ? '请先选择项目。' : loading.value ? '正在加载此项目的 Skills…' : draft.value?.catalog.errors.load || draft.value?.catalog.errors.skills ? 'Skills 加载失败：' + (draft.value.catalog.errors.load || draft.value.catalog.errors.skills) : !draft.value?.catalog.skills.length ? '此项目没有发现可用的 Skill。' : '');
async function toggle(skill: Skill) {
  const id = current.value?.id; if (!id) return;
  const key = id + ':' + skill.path; if (busy[key]) return; busy[key] = true;
  try { await store.setSkillEnabled(id, skill, !skill.enabled); } catch (e) { store.report(e, id); } finally { delete busy[key]; }
}
defineExpose({ show });
</script>
<template>
  <dialog id="skills-dialog" ref="dialog" aria-labelledby="skills-title" aria-describedby="skills-description">
    <header class="dialog-header"><h2 id="skills-title">Skills</h2><button type="button" class="quiet" aria-label="关闭 Skills" @click="dialog?.close()">关闭</button></header>
    <div class="skills-search"><label class="sr-only" for="skill-search">搜索技能名称或描述</label><input id="skill-search" ref="input" v-model="search" type="search" placeholder="输入技能名称或描述，即时查找…"><div class="skill-filters"><button v-for="tab in (['all', 'selected', 'manage'] as const)" :key="tab" type="button" class="quiet" :aria-pressed="view === tab" @click="view = tab">{{ { all: '全部', selected: '已选', manage: '管理启停' }[tab] }}</button><span role="status">{{ matches.length }} 项匹配</span></div><p id="skills-description" class="subtle">{{ view === 'manage' ? '全局启停影响 CLI 和其他客户端；禁用会移除本轮选择。' : '选择即时加入本轮消息，也可以在输入区键入 $ 查找。' }}</p></div>
    <div id="skill-list" class="dialog-body">
      <template v-if="message"><p role="status">{{ message }}</p><button v-if="current && !loading" class="quiet" @click="store.loadControls()">重新加载</button></template>
      <template v-else><p v-if="!matches.length" role="status">{{ view === 'selected' && !search ? '本轮尚未选择技能。' : '没有匹配的技能，试试名称中的一部分或说明关键词。' }} <button v-if="search" class="quiet" @click="search = ''">清空搜索</button></p><div v-for="s in matches" :key="s.path" class="skill-row" :class="{ 'skill-selected': selected.has(s.path) }"><div class="skill-row-heading"><strong :title="s.path">{{ s.name }}</strong>
        <button v-if="view !== 'manage'" type="button" class="quiet" :aria-pressed="selected.has(s.path)" :disabled="!s.enabled" @click="store.toggleSkill(s, !selected.has(s.path))">{{ selected.has(s.path) ? '取消选择' : s.enabled ? '用于本轮' : '已禁用' }}</button>
        <button v-else type="button" class="quiet" :disabled="busy[(current?.id || '') + ':' + s.path]" @click="toggle(s)">{{ busy[(current?.id || '') + ':' + s.path] ? '保存中…' : s.enabled ? '全局：已启用' : '全局：已禁用' }}</button></div>
        <details class="skill-description"><summary><span>{{ s.description || '暂无说明' }}</span></summary><p>{{ s.description }}</p><code>{{ s.path }}</code></details>
        <small v-if="(nameCounts.get(s.name) || 0) > 1" class="subtle">{{ s.path }}</small>
      </div><p v-if="draft?.catalog.skillErrors.length" role="status">部分 Skill 加载失败：{{ JSON.stringify(draft.catalog.skillErrors) }}</p></template>
    </div>
    <footer class="dialog-footer"><span role="status">已选 {{ selected.size }} 项 · 关闭后保留</span><button type="button" class="primary" @click="dialog?.close()">完成</button></footer>
  </dialog>
</template>
