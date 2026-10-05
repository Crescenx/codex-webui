<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { goalLabels } from '../../shared/protocol.ts';
import type { GoalUpdate } from '../../shared/protocol.ts';
import { useViewer } from '../store.ts';
const store = useViewer(), { current, draft } = store;
const dialog = ref<HTMLDialogElement>(), objective = ref(''), budget = ref<number | string>('');
const goal = computed(() => current.value?.goal);
const unknown = computed(() => !!current.value?.goalError || current.value?.goal === undefined);
const disabled = computed(() => unknown.value || store.state.connection !== '已连接' || store.state.hydrating || store.state.restarting || store.state.restartPending || draft.value?.goalSaving || draft.value?.sending || draft.value?.stopping || draft.value?.uncertain);
const replacing = computed(() => !!goal.value && (objective.value.trim() !== goal.value.objective || goal.value.status === 'complete'));
const number = (n: number) => n.toLocaleString('zh-CN');
const elapsed = computed(() => { const seconds = Math.floor(goal.value?.timeUsedSeconds || 0); return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; });
function show() { objective.value = goal.value?.objective || ''; budget.value = goal.value?.tokenBudget ?? ''; dialog.value?.showModal(); }
async function save() {
  const id = current.value?.id;
  const update: GoalUpdate = { tokenBudget: budget.value === '' ? null : Number(budget.value) };
  if (!goal.value || replacing.value) { update.objective = objective.value.trim(); update.status = goal.value?.status === 'paused' ? 'paused' : 'active'; }
  if (await store.saveGoal(update) && current.value?.id === id) dialog.value?.close();
}
watch(() => current.value?.id, () => dialog.value?.close());
defineExpose({ show });
</script>

<template>
  <section v-if="goal || unknown" id="goal-state" aria-label="Goal 状态" class="goal-state">
    <div v-if="unknown" class="goal-heading"><span role="status">{{ current?.goalError || 'Goal 状态待同步' }}</span><button type="button" class="quiet" :disabled="store.state.connection !== '已连接' || draft?.goalSaving" @click="store.refreshGoal()">重新同步 Goal</button></div>
    <template v-if="goal">
      <div class="goal-heading"><strong>Goal · {{ unknown ? '待同步' : goalLabels[goal.status] }}</strong><span class="subtle">{{ number(goal.tokensUsed) }} / {{ goal.tokenBudget === null ? '无上限' : number(goal.tokenBudget) }} tokens · {{ elapsed }}</span>
        <div class="goal-actions"><button type="button" class="quiet" :disabled="disabled" @click="show">编辑</button><button v-if="goal.status === 'active'" id="goal-pause" type="button" class="quiet" :disabled="disabled" title="暂停后续续跑，当前轮次继续" @click="store.saveGoal({ status: 'paused' })">暂停</button><button v-else-if="goal.status !== 'complete'" id="goal-resume" type="button" class="quiet" :disabled="disabled || store.contextBlocked.value || draft?.loading" title="使用当前选择的模型和模式继续" @click="store.saveGoal({ status: 'active' })">继续</button><button id="goal-clear" type="button" class="quiet" :disabled="disabled" title="移除目标及其用量记录，保留对话" @click="store.saveGoal(null)">清除</button></div>
      </div>
      <details :key="current?.id" class="goal-objective"><summary>{{ goal.objective.split('\n')[0] }}</summary><p>{{ goal.objective }}</p></details>
    </template>
  </section>
  <Teleport to="body">
    <dialog ref="dialog" class="goal-dialog workspace-dialog" aria-labelledby="goal-title">
      <header class="dialog-header"><h2 id="goal-title">{{ goal ? '管理 Goal' : '设置 Goal' }}</h2><button type="button" class="quiet" aria-label="关闭 Goal" @click="dialog?.close()">关闭</button></header>
      <p v-if="draft?.error || unknown" role="alert">{{ draft?.error || current?.goalError || 'Goal 状态待同步' }}</p>
      <form @submit.prevent="save"><div class="dialog-body">
        <label>目标<textarea id="goal-objective" v-model="objective" rows="4" required placeholder="描述目标及可验证的完成条件，最多 4,000 字符" /></label>
        <label>Token 预算（可选）<input id="goal-budget" v-model="budget" type="number" min="1" step="1" :max="Number.MAX_SAFE_INTEGER" placeholder="无上限"></label>
        <p class="subtle">{{ replacing ? '替换目标将重置累计用量。' : goal ? '调整预算保留累计用量；留空取消上限。' : '设置后按当前模型和模式开始；预算留空表示无上限。' }}</p>
        </div><div class="dialog-actions"><button type="button" @click="dialog?.close()">取消</button><button id="goal-save" type="submit" :disabled="disabled || draft?.loading || store.contextBlocked.value || !objective.trim() || Array.from(objective.trim()).length > 4000">{{ draft?.goalSaving ? '保存中…' : replacing ? '替换目标' : goal ? '保存预算' : '设置并开始' }}</button></div>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.goal-state { margin: 8px 0; padding: 9px 12px; border: 1px solid var(--border-medium); border-radius: 8px; background: var(--bg-surface); }
.goal-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; }
.goal-actions { display: flex; gap: 4px; margin-left: auto; }
.goal-actions button { padding: 3px 6px; }
.goal-objective { margin-top: 5px; font-size: 13px; }
.goal-objective summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.goal-objective p { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow-y: auto; margin: 8px 0 0; }
.goal-dialog { width: min(560px, 70vw); }
.goal-dialog label { display: grid; gap: 10px; }
.goal-dialog form { gap: 0; }
.goal-dialog .dialog-body { display: grid; gap: 16px; }
.goal-dialog textarea { width: 100%; resize: vertical; }
</style>
