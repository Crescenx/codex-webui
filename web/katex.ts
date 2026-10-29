import katex, { type KatexOptions } from 'katex';
import rehypeKatex from 'rehype-katex';
import type { Root, Element, RootContent } from 'hast';
import type { Plugin } from 'unified';
import { texDeclarations, type MathDefinitions } from '../shared/tex-macros.ts';

type Macros = NonNullable<KatexOptions['macros']>;
function compileDefinitions(definitions: MathDefinitions): Macros {
  let macros: Macros = {};
  for (const declaration of Object.values(definitions)) {
    const parsed = texDeclarations(declaration);
    // KaTeX does not implement newcommand's optional default argument.
    if (parsed.length !== 1 || parsed[0].source !== declaration || parsed[0].optionalDefault) continue;
    let source = declaration.replace(/^\\(?:newcommand|renewcommand)\b/, '\\providecommand');
    if (parsed[0].command === 'def' || parsed[0].command === 'gdef') {
      const parts = /^\\g?def\s*(?:\{\\[A-Za-z]+\}|\\[A-Za-z]+)\s*((?:#[1-9]\s*)*)(\{[\s\S]*\})$/.exec(declaration);
      if (!parts) continue;
      source = `\\providecommand{${parsed[0].name}}[${(parts[1].match(/#/g) || []).length}]${parts[2]}`;
    }
    const next = { ...macros };
    try {
      // Material declarations establish defaults, not executable document preambles.
      katex.renderToString(source, { macros: next, globalGroup: true, trust: false, maxExpand: 500, throwOnError: true });
      macros = next;
    } catch { /* Unsupported document macros do not prevent other definitions from loading. */ }
  }
  return macros;
}

export const renderMath: Plugin<[MathDefinitions?], Root> = (definitions = {}) => {
  let state = compileDefinitions(definitions);
  return (tree, file) => {
    // A formatter belongs to one message; global definitions never escape that message.
    const text = (node: RootContent): string => node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : '';
    const visit = (parent: Root | Element) => {
      parent.children = parent.children.flatMap(node => {
        if (node.type !== 'element') return [node];
        const code = node.tagName === 'pre' && node.children[0]?.type === 'element' ? node.children[0] : node;
        const classes = code.properties.className;
        if (code.tagName !== 'code' || !Array.isArray(classes) || !classes.some(c => ['language-math', 'math-inline', 'math-display'].includes(String(c)))) { visit(node); return [node]; }
        const source = text(code), macros = { ...state };
        // Explicit declarations in this formula take precedence over imported defaults.
        for (const { name, command } of texDeclarations(source)) if (command === 'newcommand' || command === 'DeclareMathOperator') delete macros[name];
        const subtree: Root = { type: 'root', children: [node] };
        const before = file.messages.length;
        rehypeKatex({ trust: false, maxExpand: 500, macros })(subtree, file);
        if (file.messages.length > before) {
          const reason = file.messages[before].message;
          const cause = file.messages[before].cause as { rawMessage?: string } | undefined;
          return [{ type: 'element' as const, tagName: 'code', properties: { className: ['math-unresolved'], title: `公式未能完整渲染：${cause?.rawMessage || reason}` }, children: [{ type: 'text' as const, value: source }] }];
        }
        for (const [name, value] of Object.entries(state)) if (!Object.hasOwn(macros, name)) macros[name] = value;
        state = macros;
        return subtree.children;
      });
    };
    visit(tree);
  };
};
