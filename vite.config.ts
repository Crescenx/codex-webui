import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  build: { modulePreload: { polyfill: false }, rollupOptions: { output: { manualChunks: { katex: ['katex'], highlight: ['lowlight'] } } } },
});
