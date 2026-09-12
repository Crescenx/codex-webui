import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/render.ts';
import { checkMermaidSource, MAX_MERMAID_CHARS } from '../web/mermaid.ts';

test('cached blocks match fresh rendering as references, math, code and thread-owned images change', () => {
  const cache = new Map<string, string>();
  const prefix = '[late][ref] and $x^2$\n\n![local](plot.png)\n\n```ts\nconst x = 1;\n```\n\n';
  const sources = [prefix, prefix + '[ref]: notes.md\n\nTail', prefix + '[ref]: other.md\n\nTail $y$\n', '[ref][missing]\n\n' + prefix, '> $x^2$\n\n[^a]\n\n[^a]: footnote'];
  for (const threadId of ['first', 'second', undefined]) for (const source of sources) {
    assert.deepEqual(renderMarkdown(source, threadId, cache), renderMarkdown(source, threadId));
    assert.ok([...cache].reduce((n, [k, v]) => n + k.length + v.length, 0) <= 2_000_000);
  }
  const source = '$x$\n\n<script>bad()</script>\n\n[bad](javascript:alert)';
  renderMarkdown(source, undefined, cache);
  assert.doesNotMatch(renderMarkdown(source, undefined, cache).html, /<script|href="javascript:/);
});

test('Mermaid fences use Markdown completion and source positions, including streaming containers', () => {
  for (const prefix of ['', '> ', '- ']) for (const marker of ['```', '~~~~']) {
    const continuation = prefix === '- ' ? '  ' : prefix;
    const start = `${prefix}${marker}mermaid\n${continuation}flowchart LR\n${continuation}A-->B`;
    const open = renderMarkdown(start); assert.equal(open.diagrams.length, 1); assert.equal(open.diagrams[0].closed, false);
    const full = start + `\n${continuation}${marker}`;
    const closed = renderMarkdown(full); assert.equal(closed.diagrams[0].closed, true);
    assert.equal(closed.diagrams[0].source, 'flowchart LR\nA-->B');
    assert.equal(closed.diagrams[0].id, open.diagrams[0].id);
    assert.match(closed.html, /data-mermaid=/);
    assert.ok([...closed.atoms.values()].some(raw => raw.includes('A-->B')));
    const partial = renderMarkdown(start + `\n${continuation}${marker.slice(0, 2)}`);
    assert.equal(partial.diagrams[0].closed, false);
  }
  assert.equal(renderMarkdown('    mermaid\n    A-->B').diagrams.length, 0);
  assert.equal(renderMarkdown('```js\nmermaid\n```').diagrams.length, 0);
  assert.equal(renderMarkdown('```MERMAID\nflowchart LR\nA-->B\n```').diagrams.length, 1);
});

test('Mermaid rejects resource-bearing syntax and oversized source before rendering', () => {
  checkMermaidSource('flowchart LR\nA[中文<br/>换行] --> B');
  checkMermaidSource('flowchart LR\nimg["HTML img 元素"] --> document');
  for (const source of ['A@{ img: "relative.png" }', 'A@{ "img": "https://example.com/a" }', String.raw`A@{ "\u0069mg": "relative.png" }`, String.raw`A@{ "\x69mg": "relative.png" }`, String.raw`A@{ "\U00000069mg": "relative.png" }`,
    'A@{ anchor: &key img, ? *key : "/api/private.png" }', 'A@{ "im\\\n  g": "/api/private.png" }',
    'classDef x fill:url(/api/private)', String.raw`classDef x fill:\75rl(/api/private)`, '<img src=x>', '@import "x.css"', 'x'.repeat(MAX_MERMAID_CHARS + 1)]) {
    assert.throws(() => checkMermaidSource(source));
  }
});

test('math, code and links retain exact source; untrusted markup stays inert', () => {
  const code='```ts\nx\n\n\n y\n```';
  const r=renderMarkdown('$\\frac{1}{2}$\n\n$$\nx^2\n$$\n\n'+code+'\n\n[site](https://example.com)\n\n![remote](https://example.com/track)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)');
  assert.ok(r.html.includes('katex')); assert.ok(r.html.includes('data-atom'));
  assert.ok([...r.atoms.values()].includes(code)); assert.ok([...r.atoms.values()].includes('$$\nx^2\n$$'));
  assert.ok(!r.html.includes('<script')); assert.ok(!r.html.includes('<img')); assert.ok(!r.html.includes('href="javascript:'));
});
test('local images use the owning thread and preserve source without loading remote URLs', () => {
  const source = '![曲线](<plots/中文 plot.png>)', rendered = renderMarkdown(source, 'thread &1');
  assert.match(rendered.html, /<img /); assert.ok([...rendered.atoms.values()].includes(source));
  const src = rendered.html.match(/src="([^"]+)"/)![1].replaceAll('&#x26;', '&').replaceAll('&amp;', '&');
  const url = new URL(src, 'http://localhost');
  assert.equal(url.pathname, '/api/files/image'); assert.equal(url.searchParams.get('threadId'), 'thread &1');
  assert.equal(url.searchParams.get('target'), 'plots/中文 plot.png');
  assert.doesNotMatch(renderMarkdown(source).html, /<img /);
  for (const target of ['https://example.com/track', '//example.com/track', 'data:image/png;base64,AA', 'javascript:alert', '%6aavascript:alert']) {
    assert.doesNotMatch(renderMarkdown(`![remote](${target})`, 'thread').html, /<img /);
  }
});
test('local links decode URI paths once, preserve source and reject encoded protocols', () => {
  for (const [href, target] of [
    ['文档/中文 空格.md:2:3', '文档/中文 空格.md:2:3'],
    [encodeURI('/项目/中文 文件.md#L3'), '/项目/中文 文件.md#L3'],
    ['文档/记录%2520.md:2', '文档/记录%20.md:2'],
    ['文档/100%.md', '文档/100%.md'],
  ]) {
    const source = `[文件](<${href}>)`, rendered = renderMarkdown(source);
    assert.ok(rendered.html.includes(`data-file="${target}"`));
    assert.ok(rendered.html.includes(' · ' + target.split('/').at(-1)));
    assert.ok([...rendered.atoms.values()].includes(source));
  }
  for (const href of ['javascript%3Aalert', '%6aavascript:alert', '%2F%2Fexample.com/file', '%E6%A0.md', '文档/%00.md']) {
    assert.doesNotMatch(renderMarkdown(`[文件](<${href}>)`).html, /data-file=|data-external=|href=/);
  }
  const external = 'https://example.com/%E4%B8%AD%E6%96%87?q=%2520';
  assert.ok(renderMarkdown(`[网页](${external})`).html.includes(`href="${external}"`));
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
test('bracket math uses KaTeX while retaining original delimiters and source positions',()=>{
  const formulas=[
    String.raw`\(x=\frac{1}{2}\)`,
    String.raw`\[x=F_C\!\left(\theta B[s+(1-s)e^{-q(A,x)\tau(A,K)}]\right).\]`,
    '\\[\n\\begin{aligned}\na_1 &= b_1 \\\\\n a_2 &= b_2\n\\end{aligned}\n\\]',
    '\\[\nx^2\n\n+y^2\n\\]',
  ];
  for(const source of formulas) {
    const r=renderMarkdown(source);assert.match(r.html,/class="katex"/);assert.doesNotMatch(r.html,/katex-error/);
    assert.ok([...r.atoms.values()].includes(source));
    if(source.startsWith('\\['))assert.match(r.html,/katex-display/);else assert.doesNotMatch(r.html,/katex-display/);
  }
  const mixed='中文 '+formulas[0]+'，后面 '+formulas[1]+' 尾部。\n\n[源码](sample.py:2)';
  const r=renderMarkdown(mixed);assert.ok([...r.atoms.values()].includes(formulas[0]));assert.ok([...r.atoms.values()].includes(formulas[1]));assert.ok([...r.atoms.values()].includes('[源码](sample.py:2)'));
  const quoted=renderMarkdown('> '+formulas[2].replaceAll('\n','\n> '));assert.match(quoted.html,/class="katex"/);assert.doesNotMatch(quoted.html,/katex-error/);
  assert.match(renderMarkdown('- '+formulas[0]).html,/<li>.*katex/);
  for(const source of [formulas[2],formulas[3]])for(let end=2;end<=source.length;end++)assert.doesNotThrow(()=>renderMarkdown(source.slice(0,end)));
  for(const source of [formulas[2]+'  ',formulas[2]+' 后续中文','- '+formulas[2].replaceAll('\n','\n  ')])assert.match(renderMarkdown(source).html,/class="katex"/);
});
test('bracket delimiters do not alter code, URLs, ordinary escapes or incomplete streaming math',()=>{
  const literals=[String.raw`\[x\]`,String.raw`\(x\)`];
  for(const literal of literals)for(const code of ['`'+literal+'`','```python\n'+literal+'\n```','    '+literal]) {
    const r=renderMarkdown(code);assert.doesNotMatch(r.html,/class="katex"/);assert.ok([...r.atoms.values()].includes(code));
  }
  for(const source of [String.raw`[link](https://example.com/\[x\])`,String.raw`[link](https://example.com/\(x\))`,String.raw`\\[x\\]`,String.raw`\\(x\\)`, '[普通方括号] 和 (普通括号)'])assert.doesNotMatch(renderMarkdown(source).html,/class="katex"/);
  const formula=String.raw`\[x=\frac{1}{2}\]`;
  for(let i=2;i<formula.length;i++) {
    const source=formula.slice(0,i);const r=renderMarkdown(source);
    assert.doesNotMatch(r.html,/class="katex"/);assert.ok(r.html.includes(source));
  }
  assert.match(renderMarkdown(formula).html,/class="katex"/);
  for(const fence of ['```','~~~']) {
    const source='\\[\n\n'+fence+'text\n\\]\n'+fence;
    const r=renderMarkdown(source);assert.doesNotMatch(r.html,/class="katex"/);assert.match(r.html,/<pre/);
  }
  assert.doesNotMatch(renderMarkdown('\\['+'x'.repeat(33000)+'\\]').html,/class="katex"/);
  assert.doesNotMatch(renderMarkdown(String.raw`\[\href{javascript:alert(1)}{x}\]`).html,/href="javascript:/);
});
