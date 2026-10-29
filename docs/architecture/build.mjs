import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import assert from 'node:assert/strict';
process.chdir(path.resolve(import.meta.dirname,'../..'));
const groups=[
 ['ui','应用与组件','web/main.ts、App.vue、components/','App 创建 store 并 provide；组件通过 useViewer/inject 调用具名操作，拥有交互和局部视图状态。',0,0],
 ['state','会话状态','web/store.ts','唯一会话实体、草稿、审批、请求代次与快照水位。重连读取状态，不自动重发写操作。',1,0],
 ['client','浏览器传输','web/api.ts','fetch、上传、EventSource；每个 client 拥有连接、取消与 dispose 生命周期。',2,0],
 ['http','HTTP / SSE 组装中心','server/main.ts','认证、路由、快照、事件 ring、重连与受保护重启；创建领域服务并注入回调，是主要运行时耦合中心。',3,0],
 ['runtime','多运行时路由','server/runtimes.ts','聚合模型/额度，以 agy:、antigravity/ 标识路由；保持审批请求归属，隔离部分后端故障。',4,0],
 ['adapter','stdio 进程适配','server/adapter.ts','启动子进程，以逐行 JSON-RPC 匹配请求/响应，发出 notice/request/online/offline；断线不重放操作。',5,0],
 ['render','内容呈现流水线','web/markdown*、render、math、katex、mermaid、highlight','Markdown worker → AST/清洗/数学与高亮 → DOM 增量挂载；保留原文映射用于复制。Mermaid 按需加载。',0,1],
 ['present','展示与宿主辅助','web/transcript、activity、diff、links、environment 等','有界展示缓存、虚拟列表行、差异与链接；environment 适配 Obsidian 独立窗口的 document 和文件打开。',1,1],
 ['shared','共享协议与纯逻辑','shared/','Thread/Turn/Item DTO、事件归并、能力、审批、引用/调度/协作类型。前后端共同依赖的高扇入契约层。',2,1],
 ['policy','权限 / 文件 / 配置','server/security、files、permissions、context、approvals','目录、上传、路径与审批响应校验，有效权限及实验上下文配置。UI 授权目录不等于执行沙箱。',3,1],
 ['hybrid','协作会话','server/hybrid.ts','逻辑/原生会话绑定、历史交付、操作收据与托管子任务；通过 main 注入的 hooks 访问实际执行。',4,1],
 ['workspace','独立工作副本','server/agent-workspace.ts','复制目录、检查变更版本、三方合并与恢复日志；应用需携带已检查的 revision。',5,1],
 ['plugin','Obsidian 宿主','obsidian-plugin/','main 配对与 SecretStorage；desktopClient 使用 Node HTTP/Bearer/SSE；VaultApp 复用 store/组件，讨论入口预填草稿。',0,2],
 ['vault','Vault 服务','server/vault.ts','vault 绑定与讨论相关持久化；通过 main 路由接入，配对不再作为全局会话隔离边界。',1,2],
 ['refs','会话引用','server/references.ts','来源授权与快照，校验目标会话、游标、读取范围；只读历史不扩大写权限。',2,2],
 ['watch','Watchdog 调度','server/watchdogs.ts','SQLite 任务/运行记录、调度截止时间与报告。main 启动实际轮次，完成须有报告而非仅文本声明。',3,2],
 ['mcp','MCP 进程桥','server/*-mcp.ts','agents/references/watchdog 独立 stdio MCP 进程，通过带内部令牌的 HTTP 回调 Viewer。',4,2],
 ['title','标题生成','server/title.ts','独立只读临时 AppServer 会话生成短标题；失败保留预览，避免覆盖用户改名。',5,2],
 ['scripts','运维与验证脚本','scripts/','systemd/Windows 启动、快捷方式、Obsidian 打包与 CLI，以及独立真实路径验证脚本。',0,3],
 ['config','构建与配置','根配置、HTML、manifest','Vite → dist；Obsidian CJS → dist-obsidian，外置 obsidian/node、worker 内联；TS 与 Playwright 配置。',1,3],
 ['tests','测试与夹具','test/','Node 单元/集成测试与 Playwright 桌面验证。fake-codex 等替身不能证明真实模型端到端行为。',2,3],
 ['native','外部原生运行时','Codex / 可选 Antigravity','项目外的执行与历史所有者；Codex app-server 与可选 Rust app-server 通过 stdio 接入，执行原生 Goal、工具与沙箱。',5,3],
 ['disk','本地持久化','Viewer dataDir / CODEX_HOME / 浏览器','SQLite、附件、设置、工作副本；原生历史；localStorage 草稿/布局与 sessionStorage 重启交接。',4,3],
].map(([id,label,scope,description,x,y])=>({id,label,scope,description,x,y}));
function group(f){
 if(f.startsWith('test/'))return 'tests';if(f.startsWith('scripts/'))return 'scripts';if(f.startsWith('shared/'))return 'shared';if(f.startsWith('obsidian-plugin/'))return f.endsWith('.json')?'config':'plugin';
 if(f.startsWith('web/')){if(/components\/|App.vue|main.ts/.test(f))return 'ui';if(f==='web/store.ts')return 'state';if(f==='web/api.ts')return 'client';return /markdown|render|math|katex|mermaid|highlight/.test(f)?'render':'present';}
 if(f.startsWith('server/')){const n=path.basename(f,'.ts');return ({main:'http',runtimes:'runtime',adapter:'adapter',hybrid:'hybrid','agent-workspace':'workspace',vault:'vault',references:'refs',watchdogs:'watch',title:'title'})[n]|| (n.endsWith('-mcp')?'mcp':'policy');}return 'config';
}
const files=execFileSync('rg',['--files','server','shared','web','obsidian-plugin','scripts','test'],{encoding:'utf8'}).trim().split('\n').filter(f=>/\.(ts|vue|mjs|css|json)$/.test(f));
files.push(...fs.readdirSync('.').filter(f=>/^(vite.*\.ts|tsconfig.*\.json|playwright.config.ts|package.json|index.html)$/.test(f)));
const nodes=files.sort().map(id=>({id,group:group(id),lines:fs.readFileSync(id,'utf8').split('\n').length,exports:[],external:[]}));
const ids=new Set(files),edges=[],assets=[];
for(const n of nodes){
 let source=fs.readFileSync(n.id,'utf8');
 if(n.id.endsWith('.vue')){const d=parse(source).descriptor;source=[d.script,d.scriptSetup].filter(Boolean).map(b=>'\n'.repeat(b.loc.start.line-1)+b.content).join('\n');}
 const ast=ts.createSourceFile(n.id,source,ts.ScriptTarget.Latest,true);
 function add(spec,node,kind){let target=spec==='@markdown-worker'?'web/markdown.worker.ts':spec.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(n.id),spec.split('?')[0])):null;
 const line=ast.getLineAndCharacterOfPosition(node.getStart()).line+1;
 if(target){if(!ids.has(target))target=[target+'.ts',target+'.vue',target+'/index.ts'].find(x=>ids.has(x))||target;if(ids.has(target))edges.push({from:n.id,to:target,kind,line});else assets.push({file:n.id,spec,line});}
 else n.external.push({spec,kind,line});}
 function visit(node){
 if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
 let typeOnly=node.isTypeOnly||node.importClause?.isTypeOnly;const b=node.importClause?.namedBindings;
 if(b&&ts.isNamedImports(b)&&b.elements.length&&!node.importClause.name)typeOnly ||=b.elements.every(e=>e.isTypeOnly);
 add(node.moduleSpecifier.text,node,typeOnly?'type':'import');}
 if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))add(node.arguments[0].text,node,'dynamic');
 if(node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)&&node.name)n.exports.push(node.name.text);
 if(ts.isVariableStatement(node)&&node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))for(const d of node.declarationList.declarations)n.exports.push(d.name.getText(ast));
 ts.forEachChild(node,visit);
 }visit(ast);
}
assert(assets.every(e=>/\.(png|ico|svg|jpg)$/.test(e.spec)),JSON.stringify(assets));
const relations=[];
function edge(from,to,kind,label,evidence,detail){relations.push({from,to,kind,label,evidence,detail});}
edge('ui','state','call','具名操作 / provide-inject','web/App.vue:18; web/store.ts:794','组件读取状态并调用 store 操作；App 管理生命周期。');
edge('state','client','call','ViewerClient 接口','web/store.ts:23; web/api.ts','可注入客户端；浏览器默认 createClient，插件使用 desktopClient。');
edge('client','http','http','HTTP 命令 / SSE 事件','web/api.ts; server/main.ts:871','写请求由用户操作发起；快照与 seq/epoch 事件恢复状态，重连不重新提交消息。');
edge('http','runtime','call','call / reply / 事件监听','server/main.ts:65,150','原生 notice 归并为线程快照并发布 SSE；审批响应返回所属 runtime。');
edge('runtime','adapter','call','后端选择 / ID 映射','server/runtimes.ts:12','RuntimeServers 继承 AppServer 并持有两个 AppServer 实例：继承与组合耦合。');
edge('adapter','native','process','spawn + JSON-RPC stdio','server/adapter.ts:39','请求 ID 匹配、逐行解析、超时与断线传播。');
edge('ui','render','call','消息渲染与复制','web/components/MessageBody.vue','Worker 结果由 renderInto 挂载；组件控制 Mermaid 与源码复制。');
edge('render','present','call','宿主 / 展示缓存','web/render.ts; web/markdown-client.ts','环境提供目标 document、vault 上下文；展示缓存与原始会话分离。');
edge('state','shared','contract','DTO + reduceNotice','web/store.ts','前后端消费同一事件归并逻辑；协议变化需同步两侧。');
edge('http','shared','contract','DTO + reduceNotice','server/main.ts:23','seq/epoch 防止旧快照覆盖新事件。');
edge('http','policy','call','认证 / 文件 / 设置','server/main.ts:25','Host/Origin/cookie 与 Bearer 入口结合目录、大小及响应内容校验。');
edge('http','hybrid','callback','构造 + 双向 hooks','server/main.ts:99','main → hybrid 领域操作；hybrid → hooks.load/create/submit/stop/recover 回调 main，静态 import 无法显示反向关系。');
edge('hybrid','workspace','call','检查 / 应用副本','server/hybrid.ts:7','检查 revision 后三方合并采用改动。');
edge('plugin','state','call','注入 desktopClient','obsidian-plugin/main.ts; obsidian-plugin/VaultApp.vue:15','复用会话状态和 provide/inject 契约。');
edge('plugin','ui','call','复用 Vue 组件','obsidian-plugin/VaultApp.vue','共享组件源码；宿主生命周期和文件打开不同。');
edge('plugin','http','http','Bearer HTTP / Node SSE','obsidian-plugin/client.ts','不使用浏览器 cookie/EventSource；SecretStorage 保存配对凭据。');
edge('http','vault','call','配对 / 绑定','server/main.ts:68; server/vault.ts:15','vault 根目录加入授权集合，保存讨论经服务端验证。');
edge('http','refs','call','授权 / 快照 / 读取','server/main.ts:94','引用来源需绑定目标会话，游标及工具记录范围受限。');
edge('http','watch','callback','调度 / 完成报告','server/main.ts:97; server/watchdogs.ts','调度器维护任务状态；main 启动实际轮次，避免与活跃 Goal 等竞争。');
edge('native','mcp','process','启动 stdio MCP 工具','server/agents-mcp.ts:5; server/references-mcp.ts; server/watchdog-mcp.ts','main 注入 launch 配置；原生 runtime 调用工具进程。');
edge('mcp','http','http','内部令牌 HTTP 回调','server/agents-mcp.ts:32','runtime → MCP bridge → main → 协作/引用/调度服务；MCP 不直接操纵数据库。');
edge('http','title','call','异步生成标题','server/main.ts:22; server/title.ts','临时独立进程完成概括，主会话继续运行。');
edge('title','adapter','process','独立 AppServer','server/title.ts','标题进程与主执行进程分离。');
for(const [id,label] of [['hybrid','hybrid.sqlite'],['refs','references.sqlite'],['watch','watchdogs.sqlite'],['vault','vault-assistant.sqlite'],['workspace','agent-workspaces/'],['policy','attachments / permissions / settings'],['state','浏览器草稿与重启交接'],['native','原生会话历史']])edge(id,'disk','data',label,groups.find(g=>g.id===id).scope,'各模块拥有对应存储；Viewer 快照不能证明原生执行仍在线。');
edge('scripts','http','process','systemd / 启动与探测','scripts/service.ts; scripts/open.ts','build 不会自动重启运行中的服务。');
edge('config','ui','build','Vite → dist','vite.config.ts; index.html','浏览器入口编译。');
edge('config','plugin','build','Vite → dist-obsidian','vite.obsidian.config.ts','CJS 插件、外置宿主模块、内联 worker。');
edge('tests','http','test','模拟服务 / 回归','test/; playwright.config.ts','真实模型检查独立在 scripts。');
const data={generated:new Date().toISOString(),revision:execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(),groups,nodes,edges,relations,assets};
assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);assert(edges.length>100);assert(nodes.every(n=>groups.some(g=>g.id===n.group)));
assert(edges.some(e=>e.from==='web/markdown-client.ts'&&e.to==='web/markdown.worker.ts'&&e.kind==='import'));
assert(edges.some(e=>e.from==='server/runtimes.ts'&&e.to==='shared/runtime.ts'&&e.kind==='type'));
assert(relations.every(e=>groups.some(g=>g.id===e.from)&&groups.some(g=>g.id===e.to)));
const template=fs.readFileSync('docs/architecture/template.html','utf8');
fs.writeFileSync('docs/architecture/index.html',template.replace('/*ARCHITECTURE_DATA*/',JSON.stringify(data).replaceAll('<','\\u003c')));
console.log(`${nodes.length} files, ${edges.length} static edges, ${relations.length} runtime relations → docs/architecture/index.html`);
