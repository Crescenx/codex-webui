import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { vaultStyles } from '../scripts/vault-styles.ts';

test('Obsidian CSS retains pseudo-elements, selector specificity and root overrides without leaking',async()=>{
 const {root}=await postcss([vaultStyles()]).process([
  ':root {--accent:blue} body, #app {margin:0}',
  '*, *::before, *::after {box-sizing:border-box}',
  '#send, .quiet {height:auto}',
  'dialog::backdrop {background:#0007}',
  '.vault-assistant {color:inherit}',
  '.vault-assistant button {height:auto}',
  '.vault-assistant-shell {display:flex}',
  '@keyframes pulse {from {opacity:0} 50%, to {opacity:1}}',
 ].join('\n'),{from:undefined});
 const selectors:string[]=[];root.walkRules(rule=>{selectors.push(rule.selector)});
 assert.deepEqual(selectors,[
  '.vault-assistant','.vault-assistant, .vault-assistant',
  '.vault-assistant *, .vault-assistant *::before, .vault-assistant *::after',
  '.vault-assistant #send, .vault-assistant .quiet',
  '.vault-assistant dialog::backdrop','.vault-assistant','.vault-assistant button',
  '.vault-assistant .vault-assistant-shell','from','50%, to',
 ]);
});
