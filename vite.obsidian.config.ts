import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaultStyles } from './scripts/vault-styles.ts';
import { fileURLToPath } from 'node:url';

export default defineConfig({
 resolve:{alias:{'@markdown-worker':fileURLToPath(new URL('./web/markdown.worker.ts',import.meta.url))+'?worker&inline',...Object.fromEntries(['decode-named-character-reference','hast-util-from-html-isomorphic'].map(name=>[name,fileURLToPath(import.meta.resolve(name))]))}},
 plugins:[vue()],
 css:{postcss:{plugins:[vaultStyles()]}},
 build:{outDir:'dist-obsidian',emptyOutDir:true,cssCodeSplit:false,minify:false,
 lib:{entry:'obsidian-plugin/main.ts',formats:['cjs'],fileName:()=> 'main.js',cssFileName:'styles'},
 rollupOptions:{external:['obsidian',/^node:/],output:{inlineDynamicImports:true}},
 },
});
