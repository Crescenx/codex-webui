# 交互式架构地图

用桌面浏览器直接打开 [index.html](index.html)。这是单文件离线页面，无 CDN、字体下载、模型调用或后端服务依赖，可单独复制给其他开发者。

包含三个视图：

- **系统耦合**：23 个架构分区，区分调用、共享契约、HTTP/SSE、stdio 子进程、回调、持久化与构建关系。点击节点查看职责、边的解释、证据位置及文件清单。
- **源码依赖**：总览聚合跨模块依赖；双击模块或点击“展开文件依赖”查看内部文件；点击文件展示完整的一跳依赖与被依赖邻域，包括测试引用。右侧列出导出符号、外部依赖和 import 行号。
- **关键链路**：发送与恢复、审批、托管子任务、Watchdog/Goal、Obsidian/引用、Markdown/构建。图为相关模块的耦合子图，右侧编号说明实际执行顺序。

空白区域拖动平移；Ctrl/⌘ + 滚轮或加减按钮缩放；“适应画布”恢复全景。画布聚焦后可用方向键移动、`+`/`-` 缩放、`0` 适应画布。模块可用 Tab/Enter 选择。搜索支持路径、模块名、导出符号。

## 如何读耦合

最重要的执行链为 `web/components → web/store → web/api → server/main → server/runtimes → server/adapter → 原生 app-server`，通知沿反方向返回。Obsidian 注入 `desktopClient` 替换传输，同时复用 store 与组件。

`server/main.ts` 是组合根：除静态调用外，还向 HybridSessions 注入 load/create/submit/stop/recover 等执行回调，并协调 Watchdog。`shared/protocol.ts` 的 DTO 和事件归并同时影响前后端。源码图的 type 边仅代表类型依赖；import 边也不能单独证明函数调用或执行顺序。

## 状态由谁持有

| 状态 | 所有者 / 位置 | 关键边界 |
| --- | --- | --- |
| 模型执行、Goal、原生历史 | Codex / Antigravity 原生进程 | Viewer 缓存不是在线执行证明 |
| 逻辑会话、绑定、操作收据 | HybridSessions / `hybrid.sqlite` | 未知结果不自动重发 |
| 托管副本与合并日志 | AgentWorkspaces / `agent-workspaces/` | 按检查的 revision 合并 |
| Watchdog 配置与运行 | Watchdogs / `watchdogs.sqlite` | main 启动轮次，报告推动调度状态 |
| 会话引用授权与快照 | References / `references.sqlite` | 只读历史不增加文件写权限 |
| Vault 绑定 | VaultAssistant / `vault-assistant.sqlite` | Obsidian 凭据放 SecretStorage |
| 上传、项目目录 | Uploads、main / `attachments/`、`projects.json` | UI 根目录限制不等于执行沙箱 |
| 权限与上下文选择 | permissions、context / `thread-permissions/`、`default-permissions.json`、`thread-settings/` | 与原生有效设置同步 |
| 活跃快照、pending、SSE ring | main 内存 | seq/epoch 与客户端快照恢复协调 |
| 会话实体、草稿、展示缓存 | store、transcript | 原始内容与展示缓存分离 |
| 草稿/布局、重启交接 | localStorage、sessionStorage | 普通刷新与受保护重启的保留行为不同 |

## 更新与验证

在项目根目录、已安装现有依赖的环境中运行：

```sh
node docs/architecture/build.mjs
node docs/architecture/check.mjs
```

`build.mjs` 使用现有 TypeScript AST 和 Vue SFC parser，读取 `server/`、`shared/`、`web/`、`obsidian-plugin/`、`scripts/`、`test/` 及根构建配置，生成 HTML 内嵌数据。无需增加依赖。修改展示逻辑应编辑 `template.html`，不要直接修改生成的 `index.html`。

系统模块描述与运行时关系保存在 `build.mjs`；六条流程说明保存在 `template.html`，它们需随架构变更人工核对。源码 import/export/dynamic import 边自动更新，`@markdown-worker` 映射到实际 Worker。图片等资源不计入源码节点；文档自身工具也不计入产品源码清单。HTML 标注生成时间与 HEAD，但实际内容来自包含未提交修改的工作区。

`check.mjs` 使用项目现有 Playwright/Chromium，以 1920×1080 验证主要交互、无外网请求和无浏览器异常；截图保存于 `.tmp/architecture/`。不调用真实模型，不重启或部署服务。

未自动建模 CSS 选择器、模板事件、动态计算路径或外部原生后端的内部调用；因此这是源码架构地图，不是完整函数调用图或线上动态追踪。
