import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/render.ts';

test('math, code and links retain exact source; untrusted markup stays inert', () => {
  const code='```ts\nx\n\n\n y\n```';
  const r=renderMarkdown('$\\frac{1}{2}$\n\n$$\nx^2\n$$\n\n'+code+'\n\n[site](https://example.com)\n\n![remote](https://example.com/track)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)');
  assert.ok(r.html.includes('katex')); assert.ok(r.html.includes('data-atom'));
  assert.ok([...r.atoms.values()].includes(code)); assert.ok([...r.atoms.values()].includes('$$\nx^2\n$$'));
  assert.ok(!r.html.includes('<script')); assert.ok(!r.html.includes('<img')); assert.ok(!r.html.includes('href="javascript:'));
});
test('CJK punctuation emphasis and file citations preserve their original source',()=>{
  const source='目前最值得正式追查的是：**错误的成功判定是否进入论文统计、交易表是否被当作真实数据、人工提供的关键推导是否充分披露。**现阶段没有结论。\n\n[调用方](sample.py:2)';
  const r=renderMarkdown(source);assert.match(r.html,/<strong>错误.*披露。<\/strong>现阶段/);assert.match(r.html,/data-file="sample.py:2"/);
  assert.ok([...r.atoms.values()].includes('[调用方](sample.py:2)'));assert.ok(!renderMarkdown('[bad](https://)').html.includes('data-external'));
});
test('syntax highlighting preserves source and escapes code; unknown languages stay readable',()=>{
  const source='```ts\nconst title = "<script>alert(1)</script>";\n```';
  const r=renderMarkdown(source);
  assert.match(r.html,/hljs-keyword/);assert.match(r.html,/hljs-string/);
  assert.ok([...r.atoms.values()].includes(source));assert.ok(!r.html.includes('<script>'));
  assert.match(renderMarkdown('```unknown-language\n<unsafe>\n```').html,/(&lt;|&#x3C;)unsafe>/);
  assert.ok(renderMarkdown('$$x^2$$').html.includes('katex'));
});
