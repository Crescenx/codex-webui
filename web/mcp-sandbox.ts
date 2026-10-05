// Trusted relay; untrusted HTML only runs inside the inner sandbox.
const hostOrigin = document.querySelector<HTMLMetaElement>('meta[name="viewer-host"]')!.content;
if (window.parent === window || !/^http:\/\/127\.0\.0\.1:\d+$/.test(hostOrigin)) throw new Error('Invalid embedding host');
const inner = document.createElement('iframe');
inner.title = 'MCP App'; inner.style.cssText = 'width:100%;height:100%;border:0';
inner.sandbox.add('allow-scripts', 'allow-same-origin');
document.body.append(inner);
let loaded = false;
window.addEventListener('message', event => {
  if (!event.data || typeof event.data !== 'object' || event.data.jsonrpc !== '2.0') return;
  if (event.source === window.parent && event.origin === hostOrigin) {
    if (event.data.method === 'ui/notifications/sandbox-resource-ready') {
      if (loaded || typeof event.data.params?.html !== 'string') return;
      loaded = true; inner.srcdoc = event.data.params.html;
    } else inner.contentWindow?.postMessage(event.data, location.origin);
  } else if (event.source === inner.contentWindow && event.origin === location.origin) {
    // Inner content cannot forge the sandbox control handshake.
    if (event.data.method === 'ui/notifications/sandbox-proxy-ready' || event.data.method === 'ui/notifications/sandbox-resource-ready') return;
    window.parent.postMessage(event.data, hostOrigin);
  }
});
window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, hostOrigin);
