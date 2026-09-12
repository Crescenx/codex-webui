import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import 'katex/dist/katex.min.css';

export function mountViewer(element: Element) {
  const app = createApp(App);
  app.mount(element);
  return () => app.unmount();
}

export const unmount = mountViewer(document.querySelector('#app')!);
if (import.meta.hot) import.meta.hot.dispose(unmount);
