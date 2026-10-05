import { App } from '@modelcontextprotocol/ext-apps';

document.body.innerHTML = '<h1>Fixture app</h1><p id="input"></p><p id="value">waiting</p><p id="private"></p><p id="status"></p><button id="increment">Increment</button><button id="resource">Read resource</button><button id="context">Update context</button><button id="image-context">Image context</button><button id="message">Send message</button><button id="forbidden">Forbidden tool</button><input id="scratch" aria-label="Scratch"><div style="height:180px"></div>';
const app = new App({ name: 'viewer-fixture', version: '1.0.0' }, {});
Object.assign(window, { fixtureApp: app, fixtureInstance: crypto.randomUUID() });
const set = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };
let value = 0;
app.ontoolinput = ({ arguments: args }) => { set('input', JSON.stringify(args)); };
app.ontoolresult = result => { value = Number((result.structuredContent as { value: number })?.value || 0); set('value', String(value)); set('private', JSON.stringify(result._meta)); set('status', result.isError ? 'tool error' : 'tool result'); };
app.ontoolcancelled = () => set('status', 'cancelled');
app.onteardown = () => { localStorage.setItem('teardown', 'yes'); return {}; };
function button(id: string, fn: () => Promise<unknown>) { document.getElementById(id)!.onclick = () => { void fn().then(() => set('status', 'ok'), e => set('status', e.message)); }; }
button('increment', async () => { const result = await app.callServerTool({ name: 'increment', arguments: { value } }); value = Number((result.structuredContent as { value: number }).value); set('value', String(value)); });
button('resource', async () => { const result = await app.readServerResource({ uri: 'data://fixture' }); set('value', JSON.stringify(result)); });
button('context', () => app.updateModelContext({ content: [{ type: 'text', text: 'selected value ' + value }], structuredContent: { value } }));
button('image-context', async () => {
  if (!app.getHostCapabilities()?.updateModelContext?.image) throw new Error('Host did not advertise image context');
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(640, 480);
  // A valid image larger than the old 1 MiB message limit.
  for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
  ctx.putImageData(pixels, 0, 0);
  const data = canvas.toDataURL('image/png').split(',')[1];
  await app.updateModelContext({ content: [{ type: 'text', text: 'selected value ' + value }, { type: 'image', data, mimeType: 'image/png' }], structuredContent: { value } });
});
button('message', () => app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Please explain value ' + value }] }));
button('forbidden', () => app.callServerTool({ name: 'hidden', arguments: {} }));
void app.connect();
