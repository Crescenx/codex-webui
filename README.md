# Codex Viewer

Windows 浏览器里的本地 Codex 工作台；Node.js 和 `codex app-server` 都运行在 WSL，不需要 Codex Desktop。

## 为什么做这个

我们想要的是 **Gemini 网页版那样易读、易复制的回答体验，加上 Codex CLI 的实际工作能力**。终端适合执行任务，但长篇 Markdown、公式、图片和多个并行对话，在网页里更容易阅读和管理。这个项目把交互搬进浏览器，执行仍交给 WSL 中已有的 Codex。

- **看渲染，拿源码。** 公式、表格和代码应当清晰可读；原始 Markdown / LaTeX 始终保留，渲染只是展示层，不能损坏复制、历史或后续使用。
- **少一点来回切换。** 用“项目 → 对话”管理多任务，直接粘贴截图、拖入文件，在同一个界面选择模型、思考强度、Plan 和 Skills。
- **看得懂正在发生什么。** 命令、输出、等待、审批和失败有明确区别；代码与命令共享高亮能力，输出保留 ANSI 颜色，但展示不等于执行。
- **适合长时间阅读。** 以暖色、低眩光和现代感为方向，正文使用衬线字体，界面保持简洁，代码使用等宽字体；颜色表达含义，不把整个界面涂成一种状态色。“防蓝光”在这里是视觉设计偏好，不是护眼功效承诺。

它定位于本地、单用户的轻量工作台，不另造 Agent 框架，也不追求完整复刻 Desktop 或终端。复用现有 CLI 的登录、会话与执行能力；审批和工作目录应当透明可见。**运行在 WSL 不代表与 Windows 完全隔离**，浏览器也不是额外的执行沙箱，具体边界见下文。

## 启动

需要 Node.js 24+、已登录的 Codex CLI（开发验证版本 0.153.4）。在 WSL 项目目录执行：

```sh
npm ci
npm run build
npm start -- --root /home/andantex/projects
```

打开启动时打印的完整链接。服务只监听 `127.0.0.1:8787`，浏览器登录后会移除 URL 中的令牌。不要分享启动链接。默认授权目录为 `~/projects`，可重复传入 `--root`，通过 `--port` 更改端口。

侧栏新建/切换任务；任务在服务端继续运行，关浏览器不会中断。刷新会恢复历史和待审批请求。停止 WSL、服务或 Codex 子进程则不是“后台继续”：连接恢复后查询状态，不自动重发用户操作。

## 功能与边界

- GFM Markdown、表格、代码和 KaTeX。完整回复的“复制 Markdown”保留原文；“复制代码”只复制代码内容。选区复制时公式、代码、链接作为完整源码单元，普通文本按可见文本复制，不补回粗体等标记。
- 文件选择、拖放、截图粘贴；PNG/JPEG/WebP 显示缩略图并通过 `localImage` 发送，其他文件通过 WSL 文件路径交给 Codex。不自动运行上传内容。每轮最多 10 个、单文件 25 MiB、总空间 512 MiB。
- 单次批准、拒绝、取消、问题回答。检测到 Windows 路径或程序的审批会显示命中依据，并在卡片上一次确认，不再弹出第二个确认窗口；不提供“本会话全部允许”。多行 Python 等原始命令不会因 JSON 换行转义而被误判。
- Windows 互操作保留。**这是审批提示，不是 Windows 隔离沙箱**；命令间接调用或其他路径表示不一定被识别。`--root` 限定 UI 可选工作目录，不等于限制模型读取范围。真正的执行边界由 Codex/WSL 决定。
- 每轮使用 `workspaceWrite`、`on-request`、人工审批、默认禁止网络；不使用 unrestricted/danger-full-access。既有 MCP 工具仍可能拥有独立权限，不能把 WebUI 当成整个主机的安全边界。
- 仅本地单用户；校验 Host/Origin、HttpOnly SameSite cookie。Markdown 不允许原始 HTML、危险链接或自动下载远程图片。没有 LAN、SSH、PTY、Git 管理或 Desktop 功能克隆。

## 日常操作

- 侧栏按最近的 Git 仓库根目录显示“项目 → 对话”，兼容子目录和 worktree；非 Git 目录或仓库根超出授权范围时按 cwd 分组。折叠状态只保存在浏览器。数量为已加载对话数，更多历史仍通过“加载更多”获取。
- 输入区可选模型、思考强度和普通／Plan 模式。选项来自实际 App Server；“已生效”和“下一轮”分开显示。更改不打断当前轮次，切出 Plan 不会自动开始实现。旧 CLI 不支持的入口显示错误并禁用，不自动升级或改写提示词冒充协议能力。
- Skills 面板的“用于本轮”添加消息标签；“全局：已启用／已禁用”会通过 Codex 配置接口持久修改该 Skill 状态，影响 CLI 和其他客户端。全局开关不修改 Skill 文件、不安装插件。每次写入后检查有效状态；策略阻止更改时显示错误。
- 活动只显示一行摘要。空 reasoning 不可展开；有公开摘要、搜索详情或命令输出时才展开。状态文字、颜色、图标及运行耗时区分等待与结果，不读取或承诺提供隐藏推理。
- 中文强调使用 CJK 友好的 Markdown 解析，修复 `**句号在内。**后面紧接中文` 的加粗；原始 Markdown 与源码复制保持不变。
- 本地文件引用展示文件名和行号。悬停、聚焦或点击显示完整路径及前后各五行；Ctrl+点击或预览卡按钮调用 WSL 的 `code --reuse-window --goto`。需要安装 VS Code 与 Remote WSL 扩展。程序只在用户明确点击后启动，失败会显示错误。
- 文件引用支持绝对路径、相对 cwd 的路径、`:行号[:列号]` 和 `#L行号`。预览只允许授权目录内、非隐藏的 UTF-8 普通文件，最大 256 KiB；越界、隐藏配置、二进制、失效行号均明确报错。文件引用装饰与预览不会进入源码复制。
- 外部网页链接显示域名，悬停／聚焦显示完整 URL 并可复制；不自动访问网页获取摘要。系统通知只有用户主动授权且页面隐藏时才发送，刷新不重复提醒。

历史仍由 Codex 管理。上传副本保存到 `~/.local/share/codex-viewer/attachments`（尊重 `XDG_DATA_HOME`，也可指定 `--data-dir`），30 天后自动删除，仅删除本应用命名的上传副本；原文件不受影响，旧任务附件届时可能无法再次读取。文本草稿保存在此浏览器 localStorage，附件草稿仅保存在当前页面内存；刷新前请先发送附件。

## 验证

每个独立检出都需要安装依赖，不共享其他构建或检查目录的 `node_modules`。

```sh
npm ci
npm test
```

Linux Chromium 浏览器流程（中文像素回归需要本机 `AR PL KaitiM GB` 常规字体，Debian/Ubuntu 包名为 `fonts-arphic-gkai00mp`）：

```sh
npm ci
npx playwright install chromium --no-shell
npm run test:browser
```

`test:browser` 的前置脚本会自行构建前端。上述 Node 与浏览器流程使用受控模拟 App Server，不调用模型；Skill 全局开关写入模拟服务内存，VS Code 打开由测试替身记录，不修改真实全局 Skills 或启动编辑器。截图位于 `test-results/viewer*.png`，包括首页、键盘焦点、阅读区、输入配置、Skills、审批、文件预览及 390px 布局。

可单独运行 `npm run test:live`：它使用实际 CLI 登录，查询模型／模式／Skill 列表并发起一个短小只读临时任务，会产生模型用量；拒绝所有工具请求，不让模型读取用户文件。该流程中的 Skill 配置写入在临时 `CODEX_HOME` 中测试。前端候选测试不运行这个命令。

Linux Chromium 的截图与视口模拟不能证明真实 Windows 字体、Windows Edge、WSL 浏览器连接或系统缩放效果；这些平台差异尚需在目标设备验收。

## 可选后台服务

WSL 已启用 systemd 时：

```sh
npm run service:install -- /home/andantex/projects
systemctl --user enable --now codex-viewer
```

安装命令只创建新的用户 unit，不覆盖旧文件、不自动启动。服务启动链接位于 `$XDG_RUNTIME_DIR/codex-viewer-<uid>/url`，未设置该变量时位于 `/tmp/codex-viewer-<uid>/url`；也可用 `--runtime-dir` 指定。不修改 Codex 全局配置、不安装 Windows 服务。Node 路径写入 unit，升级/迁移 Node 后需手动更新。

## 实现与参考

TypeScript + Node HTTP/SSE + Vanilla DOM/Vite；unified/remark 解析、rehype-sanitize 清洗、KaTeX 排版。原始 Markdown 与展示分离，AST 源码位置用于复制，服务端有序事件与快照用于重连。

代码块与命令共用 `web/highlight.ts` 的 lowlight 高亮，命令输出通过同一模块安全呈现 ANSI 颜色。不猜测普通日志的语言；折叠内容按需渲染，缓存有上限，超长文本退回纯文本，复制仍取源码。这里不是完整终端模拟器，不重放光标控制或执行输出中的链接。

协议以已安装 CLI 生成的 schema 为准；官方文档：[Codex App Server](https://developers.openai.com/codex/app-server/)。先保持这一条运行链路；只有需要原生窗口、系统托盘或独立打包时才考虑 Rust/Tauri。
