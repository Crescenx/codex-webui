import {copyFile} from 'node:fs/promises';
await copyFile('obsidian-plugin/manifest.json','dist-obsidian/manifest.json');
console.log('Obsidian plugin: dist-obsidian/');
