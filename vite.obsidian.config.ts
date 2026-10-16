import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaultStyles } from './scripts/vault-styles.ts';

export default defineConfig({
 plugins:[vue()],
 css:{postcss:{plugins:[vaultStyles()]}},
 build:{outDir:'dist-obsidian',emptyOutDir:true,cssCodeSplit:false,minify:false,
 lib:{entry:'obsidian-plugin/main.ts',formats:['cjs'],fileName:()=> 'main.js',cssFileName:'styles'},
 rollupOptions:{external:['obsidian',/^node:/],output:{inlineDynamicImports:true}},
 },
});
