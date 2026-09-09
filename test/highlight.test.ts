import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightCode, codeHtml, outputHtml, outputText, MAX_COLOR_CHARS } from '../web/highlight.ts';

test('shared syntax cache reuses tokens; source, unknown language and size fallback stay intact',()=>{
  const source='echo "$HOME" # <img src=x onerror=alert(1)>';
  const first=highlightCode(source,'bash');
  assert.equal(first,highlightCode(source,'bash'));
  assert.match(codeHtml(source),/hljs-(built_in|string|variable)/);
  assert.ok(!codeHtml(source).includes('<img'));
  assert.deepEqual(highlightCode(source,'unknown'),[{type:'text',value:source}]);
  const large='x'.repeat(MAX_COLOR_CHARS+1);
  assert.deepEqual(highlightCode(large,'bash'),[{type:'text',value:large}]);
  for(let i=0;i<70;i++)highlightCode('echo '+i,'bash');
  assert.notEqual(first,highlightCode(source,'bash'),'cache must evict old entries');
});

test('ANSI colors reset per output, escape HTML and never create OSC links or clipboard actions',()=>{
  const raw='\x1b[31mERROR <script>alert(1)</script>\x1b[0m\nplain';
  const html=outputHtml(raw);
  assert.match(html,/color:#dc9a8b/);assert.ok(!html.includes('<script>'));
  assert.equal(outputText(raw),'ERROR <script>alert(1)</script>\nplain');
  assert.equal(outputHtml('plain'),'plain');
  assert.ok(!/display:none|blink/.test(outputHtml('\x1b[8mvisible\x1b[0m\x1b[5msteady')));
  const osc='\x1b]8;;https://example.com\x07label\x1b]8;;\x07\x1b]52;c;YWJj\x07';
  assert.equal(outputHtml(osc),'label');assert.equal(outputText(osc),'label');
  assert.ok(!outputHtml('first\x1b[3').includes('\x1b'));
  assert.match(outputHtml('first\x1b[32msecond'),/color:#a5b995/);
  assert.match(outputHtml('\x1b[38;5;196mred\x1b[0m'),/#ff0000/);
  assert.match(outputHtml('\x1b[38;2;10;20;30mcolor\x1b[0m'),/#0a141e/);
  const large='\x1b[31m'+'x'.repeat(MAX_COLOR_CHARS+1)+'\x1b[0m';
  assert.equal(outputHtml(large),'x'.repeat(MAX_COLOR_CHARS+1));
});
