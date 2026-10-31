import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // Markdown also runs in a Worker, where the browser entity decoder has no document.
  resolve: { alias: {'@markdown-worker':fileURLToPath(new URL('./web/markdown.worker.ts',import.meta.url))+'?worker',...Object.fromEntries(['decode-named-character-reference','hast-util-from-html-isomorphic'].map(name=>[name,fileURLToPath(import.meta.resolve(name))]))} },
  plugins: [vue()],
  // Keep fonts and images compatible with the backend's self-only resource CSP.
  build: { assetsInlineLimit: 0, modulePreload: { polyfill: false }, rollupOptions: { output: { manualChunks: { katex: ['katex'], highlight: ['lowlight'] } } } },
});
