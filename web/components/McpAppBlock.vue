<script setup lang="ts">
import { viewerDocument, viewerWindow, viewerRoot } from '../environment.ts';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult, ReadResourceResult, ListResourcesResult, ListResourceTemplatesResult, Transport, JSONRPCMessage } from '@modelcontextprotocol/client';
import type { AppContext, AppDescription, AppView } from '../../shared/mcp-apps.ts';
import { appContextLimit, itemResource, record } from '../../shared/mcp-apps.ts';
import type { Item, Turn } from '../../shared/protocol.ts';
import type { ItemView } from '../transcript.ts';
import { useViewer } from '../store.ts';
import ActivityBlock from './ActivityBlock.vue';
import { appDownloads } from '../mcp-download.ts';
import type { Download } from '../mcp-download.ts';

const props = defineProps<{ item: Item; turn: Turn; threadId: string; cwd?: string; view: ItemView; readonly?: boolean }>();
const emit = defineEmits<{ copy: [text: string]; active: [open: boolean]; layout: [] }>();
const store = useViewer();
const target = { threadId: props.threadId, turnId: props.turn.id, itemId: props.item.id };
const description = shallowRef<AppDescription | null>(itemResource(props.item) ? { title: String(record(props.item.appContext).appName || props.item.tool), resourceUri: itemResource(props.item)! } : null);
const app = shallowRef<AppView>(), opened = ref(false), loading = ref(false), closing = ref(false), error = ref(''), ready = ref(false);
const frame = ref<HTMLIFrameElement>(), height = ref(420), button = ref<HTMLButtonElement>();
const modal = ref<HTMLDialogElement>(), message = ref(''), sending = ref(false), pendingMessage = ref(false);
const contextImages = ref(0);
const downloadModal = ref<HTMLDialogElement>(), downloads = shallowRef<Download[]>([]);
let downloading = false;
let resolveDownload: ((result: { isError?: boolean }) => void) | undefined;
const readOnly = computed(() => !!props.readonly || !!app.value?.readonly);
let bridge: AppBridge | undefined, controller = new AbortController(), describeController = new AbortController(), disposed = false, generation = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined, handshake: ReturnType<typeof setTimeout> | undefined, resize: ResizeObserver | undefined;
let resolveMessage: ((result: { isError?: boolean }) => void) | undefined, inputSent = false, resultSent = false;
const fail = (e: unknown) => { if (!disposed && !(e instanceof Error && e.name === 'AbortError')) error.value = e instanceof Error ? e.message : String(e); };
function syncTool() {
  if (!ready.value || !bridge) return;
  if (!inputSent) { inputSent = true; void bridge.sendToolInput({ arguments: record(props.item.arguments) }).catch(fail); }
  if (resultSent) return;
  const result = record(props.item.result);
  if (Array.isArray(result.content)) {
    resultSent = true;
    void bridge.sendToolResult({ ...result, isError: props.item.status === 'failed' || result.isError === true } as CallToolResult).catch(fail);
  } else if (props.item.status === 'failed') {
    resultSent = true;
    void bridge.sendToolResult({ content: [{ type: 'text', text: String(record(props.item.error).message || '工具调用失败') }], isError: true }).catch(fail);
  } else if (props.turn.status !== 'inProgress' && props.item.status !== 'completed') {
    resultSent = true; void bridge.sendToolCancelled({ reason: '原工具调用已结束，未取得结果' }).catch(fail);
  }
}
watch(() => [props.item, props.turn.status], syncTool);
async function describe() {
  error.value = '';
  try { const result = await store.describeApp(target, describeController.signal); if (!disposed) description.value = result.app; }
  catch (e) { fail(e); }
}
onMounted(() => { if (!description.value) void describe(); });
async function open() {
  if (opened.value || loading.value || disposed) return;
  const run = ++generation;
  opened.value = true; loading.value = true; error.value = ''; emit('active', true);
  controller = new AbortController(); inputSent = false; resultSent = false;
  try {
    const loaded = await store.openApp(target, controller.signal);
    if (disposed || run !== generation) { void store.closeApp(loaded.id).catch(() => {}); return; }
    app.value = loaded; await nextTick();
    if (disposed || run !== generation || !frame.value) return;
    const iframe = frame.value, origin = new URL(loaded.sandboxUrl).origin, source = iframe.contentWindow!;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      if (disposed || run !== generation || closing.value) throw new Error('应用已关闭');
      return store.appRpc(loaded.id, method, params, controller.signal);
    };
    const current = new AppBridge(null, { name: 'codex-viewer', version: '0.2.0' }, {
      serverResources: {}, downloadFile: {}, openLinks: {}, logging: {}, sandbox: { csp: loaded.csp, permissions: {} },
      ...(readOnly.value ? {} : { serverTools: {}, message: { text: {} }, updateModelContext: { text: {}, image: {} } }),
    }, { hostContext: {
      theme: 'dark', platform: 'web', displayMode: 'inline', availableDisplayModes: ['inline'],
      containerDimensions: { width: iframe.clientWidth, maxHeight: 1200 },
    } });
    bridge = current;
    current.oncalltool = async params => { if (readOnly.value) throw new Error('此应用为只读'); return await rpc('tools/call', params) as CallToolResult; };
    current.onreadresource = async params => await rpc('resources/read', params) as ReadResourceResult;
    current.onlistresources = async params => await rpc('resources/list', params || {}) as unknown as ListResourcesResult;
    current.onlistresourcetemplates = async params => await rpc('resources/templates/list', params || {}) as unknown as ListResourceTemplatesResult;
    current.ondownloadfile = async ({ contents }) => {
      if (closing.value || disposed || run !== generation || downloading) return { isError: true };
      downloading = true;
      try {
      const files = await appDownloads(contents, async uri => await rpc('resources/read', { uri }) as ReadResourceResult);
      if (closing.value || disposed || run !== generation) return { isError: true };
      downloads.value = files;
      const result = new Promise<{ isError?: boolean }>(resolve => { resolveDownload = resolve; });
      await nextTick(); downloadModal.value?.showModal(); return await result;
      } finally { downloading = false; }
    };
    current.onloggingmessage = () => {}; // App logs never enter conversation history.
    current.onrequestdisplaymode = async () => ({ mode: 'inline' });
    current.onopenlink = async ({ url }) => {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('无效外部链接');
      // Present a real link so opening a tab retains a browser user gesture.
      store.toast('应用请求打开链接，请点击卡片下方链接'); externalLink.value = parsed.href; return {};
    };
    current.onupdatemodelcontext = async params => {
      if (readOnly.value || closing.value || disposed || run !== generation) throw new Error('此应用不能更新对话');
      if (params.content?.some(p => p.type !== 'text' && p.type !== 'image')) throw new Error('仅支持文字和图片上下文');
      store.updateAppContext(target, params as AppContext);
      contextImages.value = params.content?.filter(p => p.type === 'image').length || 0; return {};
    };
    current.onmessage = async ({ content }) => {
      if (readOnly.value || closing.value || disposed || run !== generation) return { isError: true };
      if (content.some(p => p.type !== 'text') || pendingMessage.value) return { isError: true };
      const text = content.map(p => p.type === 'text' ? p.text : '').join('\n\n');
      if (!text.trim() || text.length > 100_000) return { isError: true };
      message.value = text; pendingMessage.value = true;
      const result = new Promise<{ isError?: boolean }>(resolve => { resolveMessage = resolve; });
      await nextTick(); modal.value?.showModal(); return result;
    };
    current.onsizechange = size => {
      if (Number.isFinite(size.height) && size.height! > 0) height.value = Math.max(120, Math.min(1200, Math.ceil(size.height!)));
      void nextTick(() => emit('layout'));
    };
    current.onrequestteardown = () => { void close(); };
    current.oninitialized = () => { if (run !== generation || disposed) return; clearTimeout(handshake); ready.value = true; loading.value = false; syncTool(); };
    current.onerror = fail;
    // The SDK's PostMessageTransport uses '*'. Bind both send and receive to this
    // instance's origin as well as its Window, including after frame navigation.
    let resourceSent = false;
    const receive = (event: MessageEvent) => {
      if (event.source !== source || event.origin !== origin || !event.data || event.data.jsonrpc !== '2.0') return;
      try {
        if (JSON.stringify(event.data).length > appContextLimit + 4096) {
          if (typeof event.data.id === 'string' || typeof event.data.id === 'number') source.postMessage({ jsonrpc: '2.0', id: event.data.id, error: { code: -32602, message: '应用消息过大' } }, origin);
          return;
        }
      } catch { return; }
      if (event.data.method === 'ui/notifications/sandbox-proxy-ready') {
        if (!resourceSent) { resourceSent = true; void current.sendSandboxResourceReady({ html: loaded.html, csp: loaded.csp, permissions: {} }).catch(fail); }
      } else transport.onmessage?.(event.data as JSONRPCMessage);
    };
    const transport: Transport = {
      async start() { viewerWindow().addEventListener('message', receive); },
      async send(data) { source.postMessage(data, origin); },
      async close() { viewerWindow().removeEventListener('message', receive); transport.onclose?.(); },
    };
    await current.connect(transport);
    if (disposed || run !== generation) { await current.close(); return; }
    handshake = setTimeout(() => { error.value = '应用初始化超时，可关闭后重新打开'; loading.value = false; }, 15_000);
    resize = new ResizeObserver(() => { if (ready.value) void Promise.resolve(current.sendHostContextChange({ containerDimensions: { width: iframe.clientWidth, maxHeight: 1200 } })).catch(fail); });
    resize.observe(iframe);
    heartbeat = setInterval(() => { void store.keepApp(loaded.id).catch(e => { fail(e); void close(); }); }, 60_000);
    iframe.src = loaded.sandboxUrl;
  } catch (e) { if (run === generation) { fail(e); loading.value = false; } }
}
const externalLink = ref('');
function cancelDownload() { resolveDownload?.({ isError: true }); resolveDownload = undefined; downloads.value = []; downloadModal.value?.close(); }
function saveDownload() {
  for (const file of downloads.value) {
    const url = URL.createObjectURL(file.blob), link = viewerDocument().createElement('a');
    link.href = url; link.download = file.name; viewerRoot().append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  resolveDownload?.({}); resolveDownload = undefined; downloads.value = []; downloadModal.value?.close();
}
function cancelMessage() { if (sending.value) return; resolveMessage?.({ isError: true }); resolveMessage = undefined; pendingMessage.value = false; modal.value?.close(); }
async function sendMessage() {
  if (sending.value || !message.value.trim()) return;
  sending.value = true;
  try {
    if (await store.send('steer', undefined, { threadId: target.threadId, text: message.value })) {
      resolveMessage?.({}); resolveMessage = undefined; pendingMessage.value = false; modal.value?.close();
    }
  } finally { sending.value = false; }
}
async function close() {
  if (closing.value || !opened.value) return;
  cancelDownload();
  closing.value = true; ++generation; controller.abort(); clearInterval(heartbeat); clearTimeout(handshake); resize?.disconnect();
  resolveMessage?.({ isError: true }); resolveMessage = undefined; pendingMessage.value = false; modal.value?.close();
  const previous = bridge, id = app.value?.id; bridge = undefined;
  if (previous) { try { if (ready.value) await previous.teardownResource({}, { timeout: 500 }); } catch {} finally { await previous.close(); } }
  if (id) void store.closeApp(id).catch(() => {});
  app.value = undefined; opened.value = false; closing.value = false; loading.value = false; ready.value = false; externalLink.value = ''; emit('active', false);
  if (!disposed) { await nextTick(); button.value?.focus(); emit('layout'); }
}
watch(() => store.state.connection, value => { if (value !== '已连接' && opened.value) { error.value = '连接已中断，请重新打开应用'; void close(); } });
onBeforeUnmount(() => { disposed = true; describeController.abort(); void close(); });
</script>
<template>
  <ActivityBlock :item="item" :turn="turn" :cwd="cwd" :view="view" @copy="emit('copy', $event)" />
  <section v-if="description || error" class="mcp-app" :class="{ 'mcp-app-open': opened }" data-copy-ignore>
    <div class="mcp-app-toolbar">
      <strong>{{ description?.title || 'MCP App' }}</strong><span v-if="readonly" class="subtle">只读</span>
      <button v-if="!opened && description" ref="button" class="quiet" @click="open">打开应用</button>
      <button v-else-if="opened" class="quiet" :disabled="closing" @click="close">关闭应用</button>
      <button v-else class="quiet" @click="describe">重新检查应用</button>
    </div>
    <p v-if="loading" class="subtle" role="status">正在加载应用…</p>
    <p v-if="contextImages" class="subtle" role="status">应用已提供 {{ contextImages }} 张图片，将随下次发送附上。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <iframe v-if="app" ref="frame" :title="description?.title || 'MCP App'" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" :style="{ height: height + 'px' }"></iframe>
    <a v-if="externalLink" :href="externalLink" target="_blank" rel="noopener noreferrer">打开应用链接：{{ externalLink }}</a>
    <Teleport to="body">
      <dialog v-if="downloads.length" ref="downloadModal" class="mcp-message-dialog workspace-dialog" aria-label="应用文件下载" @cancel.prevent="cancelDownload">
        <header class="dialog-header"><h2>下载应用文件</h2><button class="quiet" aria-label="关闭应用文件下载" @click="cancelDownload">关闭</button></header><div class="dialog-body">
        <p v-for="(file, index) in downloads" :key="index">{{ file.name }} · {{ file.blob.size.toLocaleString() }} 字节</p>
        </div><div class="dialog-footer"><button class="quiet" @click="cancelDownload">取消</button><button class="primary" @click="saveDownload">下载</button></div>
      </dialog>
      <dialog v-if="pendingMessage" ref="modal" class="mcp-message-dialog workspace-dialog" aria-label="应用消息预览" @cancel.prevent="cancelMessage">
        <header class="dialog-header"><h2>来自 {{ description?.title }} 的消息</h2><button class="quiet" :disabled="sending" aria-label="关闭应用消息预览" @click="cancelMessage">关闭</button></header><div class="dialog-body">
        <label>发送到当前对话<textarea v-model="message" rows="8" :disabled="sending"></textarea></label>
        <p v-if="store.draft.value?.error" class="error">{{ store.draft.value.error }}</p>
        </div><div class="dialog-footer"><button class="quiet" :disabled="sending" @click="cancelMessage">取消</button><button class="primary" :disabled="sending || !message.trim() || !store.canSend.value" @click="sendMessage">{{ store.active.value ? '排队追加' : '发送' }}</button></div>
      </dialog>
    </Teleport>
  </section>
</template>
