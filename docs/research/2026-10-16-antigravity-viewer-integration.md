# Codex Viewer 接入 Antigravity ACP 的能力与解耦调研

日期：2026-10-16。Google 端以本机官方 Antigravity ACP Server 1.4.0 的实现与实测为准。调研时 Viewer 基线为 `c00edda`，随后完成模型核对和 MCP Apps 的删除。本文保留调研时的建议与边界；同日已完成第一阶段双后端基础接入，当前实现与验证见 [基础接入说明](../antigravity-integration.md)，2026-10-17 已将混合执行收敛为接手与子智能体两种方式，当前实现见 [混合执行](../hybrid-execution.md)，本文其他编排建议不作为当前产品模式。

结论：Viewer 可以支持 Codex 与 Antigravity 长期并存，并承载异质 agent 协作。主要边界应是运行后端、会话管理和宿主环境。Vue 界面及目录、附件、阅读、引用、Watchdog 等应用能力可以继续复用。

| 能力 | 两端对应情况 | 建议归属 |
|---|---|---|
| 创建、发送、继续、取消 | 两端都有对应接口；Google 创建、跨进程恢复、取消已实测 | 统一运行接口 |
| 消息流、工具状态、执行过程 | Codex item 事件和 ACP session update 可以转换 | 共同会话数据与现有组件 |
| 模型与思考强度 | Google 返回 model、thinking_level 配置选项 | 共用选择器，选项来自后端 |
| 工具审批 | 两端都有请求和响应，允许范围不同 | 共用待处理区，保留原生选项 |
| 目录、附件、搜索、Markdown、阅读位置 | 大部分已属于 Viewer | 保持与运行后端无关 |
| Skills | SKILL.md 内容共通；发现、启停、显式调用不同 | 内容复用，管理接口分别适配 |
| 快照转发、Session 引用 | 授权和内容组织属于 Viewer | 共用引用服务，适配来源读取 |
| Watchdog | 调度、持久化和恢复属于 Viewer | 共用调度服务，通过运行接口执行 |
| 标题、排序、本地归档 | Google 当前列表的标题和元数据较弱 | Viewer 自有元数据，按能力同步原生状态 |

Google MCP 调用实测携带 `_meta["antigravity.google/conversation_id"]`，可以对应 Codex 的 `_meta.threadId`，在适配层转换成 Viewer 会话身份。当前引用初始化仍依赖 `mcpServerStatus/list` 和主动调用工具检查，MCP 启动参数也硬编码 Codex `-c` 配置，需随适配器一起拆出。

| 当前需按后端保留的能力 | 原因与处理 |
|---|---|
| Codex turn/steer | 未确认 Google ACP 提供等价语义；Google 应采用明确的排队或取消后续发策略 |
| 原生 Goal 面板 | Codex 有结构化读写、预算和状态接口；Google 产品有 /goal，但当前 ACP 未确认等价接口 |
| ChatGPT 周额度与额度重置 | 属于 Codex 账户能力；Google 用量另行适配 |
| 实验性上下文管理 | 现有实现依赖 Codex 配置和模型信息 |
| 原生子 agent 树与完整历史 | 现有实现依赖 Codex 子线程接口；Google 内部有 subagent，不代表 ACP 暴露同等历史 |
| 异步或自由文本问题、持久授权规则 | 按实际协议能力开放；Google 包的部分提问通过 permission 选项实现 |
| 工具完整原始结果 | 本次 Google 工具成功执行，但 ACP rawOutput 只有摘要，不能标为完整工具证据 |

Google 文档的 /goal、/schedule 页面标注 App、CLI、IDE。此次 ACP 返回的 available commands 只有 plan、logout、usage。产品文档中的功能不能直接视为 ACP 能力。Google 文档还区分会话内 schedule 和跨会话持久任务，因此 Viewer Watchdog 仍有独立价值。

四个必须保持清楚的边界：

1. **规划与权限。** Viewer 当前 Settings.mode 是 default 或 plan；Google mode 是 default、auto_edit、yolo，控制审批。模型、思考强度、规划行为、权限策略应分别表达。ACP 配置优先读取 configOptions，接受服务端返回的完整配置状态。
2. **历史与恢复。** Codex thread/read 是被动读取；Google session/load 会恢复 agent 并回放历史。此次 Google 列表无更新时间，消息流也没有可直接沿用的稳定消息 ID。Viewer 应保存自己的索引和已接收历史，引用读取快照并标明同步时间。历史回放应作为快照同步，避免重复追加。
3. **提交与完成。** 当前 adapter 使用统一 60 秒 RPC 超时；ACP session/prompt 要等整轮结束才返回。Viewer API 应快速返回操作编号，后端持续维护运行状态。发送前保存回执，无法确认是否交付时标为未知，不自动重发。
4. **审批与执行隔离。** Codex 每轮设置 workspaceWrite 与禁止网络；Google 官方包的终端沙箱分支要求 business 登录及管理配置。当前个人 OAuth 不能被标为同等隔离。此处是源码证据，尚未做操作系统隔离实测；统一执行边界需要独立落实运行环境。

建议的最小结构是：浏览器、Obsidian、下游应用通过稳定 Viewer API 访问会话服务；引用、Watchdog、辩论编排也调用同一会话服务；会话服务通过 Codex 和 Antigravity 两个适配器连接原生服务。

- 运行适配器负责原生进程、认证、协议、配置和事件转换，对上提供创建、恢复、提交、取消、回答请求及能力描述。Goal、额度和上下文控制是可选能力。
- 会话服务拥有 Viewer 会话 ID，并保存 runtimeId 与 nativeSessionId 的绑定。历史、操作回执、队列、引用授权归这一层；每个后端分别维护在线状态。当前单个 adapter 断线会清空全局状态，需要调整。
- 共同数据协议表达消息、工具、轮次、待处理请求和运行状态，原生方法名停在适配器内部；必要原生字段保留供诊断。
- 宿主接口提供传输、文件打开、存储、DOM 容器。Obsidian 当前通过 ReturnType<typeof createClient> 依赖 Web 实现，环境还有模块级全局变量；改成显式接口即可，无需重写 Vue。
- 自动标题是可选服务。现有实现使用 Codex 临时线程、工具限制和结构化输出；共同会话层先支持本地标题与重命名。

异质辩论中的每位参与者拥有独立原生会话，选择不同后端。编排层负责明确转交哪些消息或快照、记录交付与完成状态、处理预算与停止。原生子 agent 树表示模型内部委派，辩论关系表示 Viewer 管理的协作。应沿用现有引用机制，避免另造一套文件传话系统。

建议实施顺序：抽出 Codex 适配器并保持现有行为；建立共同会话数据与持久回执；接入 Google；复用引用和 Watchdog；以两位参与者验证辩论。首批验收覆盖超过一分钟的任务、单后端断线、审批中取消、历史回放不重复、进程退出后未知任务不被重发。

本轮已完成的产品变更：删除模型核对和 MCP Apps 的界面、接口、模型日志采集、iframe 桥接、依赖及脚本。保留普通 MCP 工具结果、审批、表单和 URL 问答。115 项单元与集成测试、12 项浏览器测试、Web 与 Obsidian 构建通过。此处验证针对删除后的 Viewer，不能当作双后端验收。

实测摘要与证据：

- 官方包：<https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip>，SHA-256 `fbb2d54dd94fb897845308d3b6b46187c627f1c60078ded81adeeaf8b90c5d7a`。
- 个人 OAuth 登录成功；新会话回复 ACP_OK 与测试标记；重启官方服务后无需再次浏览器授权，load 回放历史，后续提示未重复标记仍能恢复标记。
- MCP audit_echo 返回 ZIRCON-2048，模型正确复述；audit_wait 运行中取消后返回 stopReason cancelled。
- Google MCP 参数中包含原生 conversation_id；ACP 工具完成通知的 rawOutput 是 Audit echo call，未完整透出 MCP content 或 structuredContent。
- 本机详细记录位于 [会话与恢复探针](../../.runtime/acp-probe/result.json)、[MCP 与取消探针](../../.runtime/acp-audit/result.json)、[MCP 实际入参](../../.runtime/acp-audit/mcp-calls.jsonl)。这些是忽略的本地运行产物，可能随清理删除；上面的实测摘要保留了影响结论的结果。

主要代码入口：[后端主服务](../../server/main.ts)、[Codex adapter](../../server/adapter.ts)、[共享协议](../../shared/protocol.ts)、[引用 MCP](../../server/references-mcp.ts)、[Watchdog MCP](../../server/watchdog-mcp.ts)、[自动标题](../../server/title.ts)、[前端 store](../../web/store.ts)、[宿主环境](../../web/environment.ts)、[Obsidian transport](../../obsidian-plugin/client.ts)。

官方资料：[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[ACP Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)、[Google Skills](https://antigravity.google/docs/skills/)、[Google Goal](https://antigravity.google/docs/commands/goal/)、[Google Schedule](https://antigravity.google/docs/commands/schedule/)、[Codex App Server](https://developers.openai.com/codex/app-server)。

后续补充：[历史互见与任务接续调研](2026-10-16-codex-antigravity-context-handoff.md)使用本机 Codex 0.162.1，验证了双向文本接力和公开 thread/inject_items 接口的跨进程持久化，并进一步区分模型可见历史、界面轮次和原生执行状态。
