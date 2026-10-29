import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texDeclarations } from '../shared/tex-macros.ts';
import { createMathContextIndex } from '../web/math-context.ts';
import { renderMarkdown } from '../web/markdown.ts';
import type { Item } from '../shared/protocol.ts';

test('TeX declaration extraction handles nested arguments, comments and incomplete streams',()=>{
  const source=String.raw`% \newcommand{\Ignored}{x}
\\newcommand{\Escaped}{x}
\newcommand{\norm}[1]{\left\lVert {#1}\right\rVert}
\newcommand*\Optional[2][{[x]}]{#1 + #2 + \%}
\DeclareMathOperator*{\op}{op}
\def\pair#1#2{\{#1,#2\}}
\newcommand{\Partial}[1]{unfinished`;
  const found=texDeclarations(source);
  assert.deepEqual(found.map(d=>d.name),['\\norm','\\Optional','\\op','\\pair']);
  for(const declaration of found)assert.ok(source.includes(declaration.source));
  const complete=String.raw`\newcommand{\deep}[1]{\frac{#1}{\sqrt{2}}}`;
  for(let end=0;end<complete.length;end++)assert.equal(texDeclarations(complete.slice(0,end)).length,0);
  assert.equal(texDeclarations(complete).length,1);
  assert.equal(texDeclarations(String.raw`\newcommand{\large}{`+'x'.repeat(9000)+'}').length,0);
});

test('material macros follow transcript order without retroactively changing prior messages',()=>{
  const command=(id:string,value:string):Item=>({id,type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:value});
  const message=(id:string):Item=>({id,type:'agentMessage',text:String.raw`$\Null(B)$`});
  const first=String.raw`\newcommand{\Null}{\operatorname{Null}}`;
  const second=String.raw`\newcommand{\Null}{\mathcal{N}}`;
  const items:Item[]=[message('before'),command('read-homework',first),message('homework'),
    {id:'read-cheatsheet',type:'dynamicToolCall',status:'completed',success:true,result:{content:[{type:'text',text:JSON.stringify({content:second})}]}},message('cheatsheet'),
    {...command('failed',String.raw`\newcommand{\Null}{WRONG}`),exitCode:1},message('after-failed')];
  const index=createMathContextIndex(),contexts=index(items);
  assert.deepEqual(contexts.get('before'),{});
  assert.equal(contexts.get('homework')?.['\\Null'],first);
  assert.equal(contexts.get('cheatsheet')?.['\\Null'],second);
  assert.equal(contexts.get('after-failed')?.['\\Null'],second);
  const render=(id:string)=>renderMarkdown(String.raw`$\Null(B)$`,undefined,undefined,{mathDefinitions:contexts.get(id)}).html;
  assert.match(render('before'),/math-unresolved/);
  assert.match(render('homework'),/<mi mathvariant="normal">Null/);
  assert.match(render('cheatsheet'),/<mi mathvariant="script">N/);
  assert.deepEqual(index([message('other-thread')]).get('other-thread'),{});
  assert.equal(index(items).get('homework')?.['\\Null'],first);
});

test('running tools and assistant examples do not become material macro defaults',()=>{
  const source=String.raw`\newcommand{\Example}{x}`;
  const items:Item[]=[{id:'running',type:'commandExecution',status:'inProgress',aggregatedOutput:source},
    {id:'assistant',type:'agentMessage',text:'```tex\n'+source+'\n```'}, {id:'reply',type:'agentMessage'}];
  const index=createMathContextIndex();
  assert.deepEqual(index(items).get('reply'),{});
  items[0]={...items[0],status:'completed',exitCode:0};
  assert.equal(index(items).get('reply')?.['\\Example'],source);
});
