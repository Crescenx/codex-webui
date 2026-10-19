# Antigravity 基础接入

> 历史记录：本文下文记录已移除的旧 ACP 实现。当前已接入独立 Rust app-server，与 Codex 共存；启动配置见 [README](../README.md#接入-antigravity)，不要按本文旧依赖、权限或状态目录配置新后端。

## 当前接入验证（2026-10-19）

- 模型菜单与思考档位共用现有控件；切换时复用原生会话，Goal 激活前交付待注入历史。
- `/api/usage` 保留 Google 和外部模型两组额度，各自显示 5 小时、7 天窗口，未知窗口不当作零；故障与重试独立于 Codex 的周额度及重置卡。
- 使用正式 `antigravity-app-server` 二进制名称，兼容旧名称；状态固定在 Viewer 数据目录下，不受父进程其他客户端的状态目录设置影响。
- 全部 132 项单元/API 回归通过，Web 与 Obsidian 构建通过；桌面浏览器检查涵盖模型档位、Plan、steer、两组额度、缺失窗口、查询失败恢复、Codex 额度、审批及子任务。
- 隔离 Viewer 使用真实 Rust app-server 查询元数据，读到 5 个模型（均有思考档位），两组额度读取成功，并保留 Codex 测试后端模型。本次未提交真实推理或 Goal，也未重启生产服务；不将元数据检查视为真实模型执行验收。

2026-10-16。基于 [接入调研](research/2026-10-16-antigravity-viewer-integration.md) 实现第一阶段双后端；Google 实测版本为官方 ACP Server 1.4.0。

## 外骨骼接入（2026-10-18）

Viewer 使用本地依赖 `@andantex/antigravity-acp-exoskeleton`，安装位置为相邻的 `../antigravity-acp-exoskeleton`。外骨骼状态保存在 Viewer 数据目录的 `antigravity-harness/`；SQLite 保留界面投影、归档状态和旧引用身份。旧记录首次打开时导入，不重新执行任务或替换已有消息 ID。

Google Goal 通过输入区 Goal 面板创建，支持轮数、执行时间和原生主轨迹 token 预算。Token 按轮次边界结算，可能超额；缺失为未知，不能显示成零或继续按 token 预算运行。修改未完成目标保留用量；已完成目标可新建替换。默认完成来源为代理；宿主可通过 `serve({googleVerifiers})` 注册独立验证器，面板只列出实际注册的验证器。模型使用外骨骼的 Goal MCP 查询、报告进展和申请完成，创建及预算控制属于用户。重启后活动目标暂停，须显式继续。

Google 的首条原始文字经现有 Codex 临时工作者生成短标题，使用 Codex 默认模型及登录；不发送附加引用、技能指令或完整历史作为标题输入。标题保存在 Viewer，不计入 Google 任务用量；失败保留预览，手动标题优先。外骨骼不承担标题生成。

本次验证：134 项 Node 回归通过，新增测试覆盖预算边界、未知用量、独立完成验证、手动标题保护和编码后的审批 ID；Web、Obsidian 构建通过。独立真实会话已通过新接入路径返回“外骨骼接入验证成功”，Codex 生成标题“验证外骨骼会话接入”，证据保存在忽略目录 `.runtime/exoskeleton-live-1792253221241/result.json`。这验证了独立测试实例，不代表现有后端或 Windows Obsidian 已重启加载。

## 已接入

Google 用量栏读取外骨骼的独立上下文与账户额度快照：上下文来自原生报告；额度保留原生分组、窗口、剩余比例和恢复时间。`GET /api/runtimes/antigravity/usage?refresh=1` 请求刷新，外骨骼负责缓存、合并并发和等待会话空闲；账户事件 `viewer/googleRateLimits` 只广播一次。查询不加入对话历史，不触发模型任务。过期、等待刷新和不可用分别显示，不套用 Codex 重置卡。

额度查询中断后，会话可能进入 `usageQuery.state=unknown`。输入区提供核实入口，通过 `/recover` 调用外骨骼的 `reconcileUsageQuery`；原连接仍有请求时保持阻塞，已结束时解除。旧记录缺少自动证据时可提供 `terminationEvidence`。此证据只处理额度查询，不能替代未知模型任务的 `outcome` 与 `evidence`。

用量接入验证（2026-10-18）：35 项 ACP/前端状态测试和 5 项桌面浏览器测试通过，Web 与 Obsidian 构建通过。独立真实测试会话读到两组周额度与五小时额度，查询前后 Viewer 历史一致，证据在 `.runtime/google-usage-live-result.json`；未重启生产服务。

- 新建时选择 Codex / Antigravity；旧会话默认 Codex，原有 URL 和 ID 不迁移。
- Google 原生模型、思考强度及审批模式动态配置；模式不映射为 Codex Plan。
- 流式回答、公开思考文本、计划、工具状态与原始工具字段；审批仅接受原生请求提供的选项。
- 取消、会话恢复、列表、本地改名及本地归档。归档不删除 Google 原生历史。
- 共用目录、上传、阅读和引用。图片经 ACP 图像块发送，普通附件提供文件路径，由运行时读取。
- 双向快照 / Session 来源读取复用既有授权。Google MCP 的 conversation_id 先映射为 Viewer 会话身份，再执行引用范围校验。
- 浏览器与 Obsidian 共用界面；桌面浏览器验证与插件构建分别验收，不把构建通过当作 Windows Obsidian 原生运行证明。

## 后续任务接续接口

`Thread.runtimeId`、`nativeSessionId` 和能力声明区分应用与运行时身份。新 Google 会话使用 `antigravity:<UUID>`；SQLite 保存原生身份映射、Viewer 历史及操作回执。外部编排应引用 Viewer ID、turn ID 和 item ID，不依赖 Google 磁盘格式。

`POST /api/threads/:id/turns` 要求稳定的 `clientMessageId`，返回 HTTP 202 和 operation。状态为 `accepted / running / completed / cancelled / failed / unknown`；accepted 表示外骨骼已持久化接受，running 表示已开始处理执行，均不等于任务成功。`GET /api/threads/:id/operations` 查询回执。相同 ID 与请求体返回既有回执；不同请求体返回冲突。断线及重启不自动重放。

`POST /api/threads/:id/recover` 默认仅调用执行核实接口；缺少原生证据时返回冲突并保留 unknown。人工核对须提供 `outcome: completed | cancelled | failed` 与非空 `evidence`，明确记录最终结果；普通重连不解除未知执行。引用只授权读取，不授权自动派发、停止或修改来源会话。接手与跨后端子任务见 [混合执行](hybrid-execution.md)。

## 持久化与运行边界

首次导入原生历史用 `session/load`；已有 Viewer 记录用 `session/resume`，不重放覆盖历史 ID。来源引用读取 Viewer 已收到的记录，不启动来源模型，也不自动合并其他客户端后来写入的原生历史。界面显示最近历史保存时间。外骨骼先持久化事件，Viewer 逐事件保存投影与游标；重启补齐未投影事件，不重发模型请求。

ACP 生成请求没有普通控制 RPC 的短超时；取消需要原生确认。一个后端断线不会删除另一后端的活动状态和审批。现阶段没有 Google 运行中追加、Watchdog、Skills 全局启停及网页登录界面；使用本机已有登录，原生认证错误向用户显示。

Google 使用原生审批与执行权限。新原生会话在提供该选项时默认设为 YOLO，覆盖新建、接手和子任务入口；Viewer 首次打开旧会话时将旧的 default 模式迁移为 YOLO，保留其他显式模式，迁移后用户仍可自行更改。Viewer 目录授权约束应用入口和引用访问，不是模型进程的 OS 沙箱，不能把 Codex 的网络或文件限制当作 Google 的限制。

2026-10-18 额度排查：Gemini Apps 的 `gemini.google.com/usage` 与 Antigravity 原生额度分别统计。官方 ACP、外骨骼和 Viewer 返回的数值一致；消费者账号按官方 onboarding 路由使用 daily CCPA 端点，不应拿其他端点结果替换。实测原生套餐元数据为 Google AI Ultra。额度接口返回所有模型组，不表示当前客户端可选择所有模型。原始额度提供剩余比例及重置时间，没有逐次消耗明细，因此不能仅凭剩余百分比解释异常消耗来源。

ACP 1.4.0 按自报客户端名称过滤第三方模型，只允许 JetBrains、Zed、Xcode。按用户要求，Viewer 的发现连接与外骨骼执行连接均在 initialize 中自报 `clientInfo.name = zed`，保留现有客户端版本和能力声明。模型仍从当前账号原生返回的配置列表读取，不硬编码或增加账号未提供的模型。此兼容方式依赖当前官方客户端名称判断逻辑，升级 ACP 后需重新验证。

跨模型族切换时先单独设置模型，再读取更新后的配置并提交其他选项。Claude 的思考档位在模型 ID 中，原生可能移除 Gemini 的独立 `thinking_level`；Viewer 丢弃已失效的思考参数，避免旧草稿或重试阻止发送。审批及其他配置继续按原生选项校验。

## 基础接入的历史验证证据（2026-10-16）

- Node 回归：原有 115 项加 4 项 ACP 接入测试全部通过；随后增加原生历史导入测试，5 项 ACP 测试全部通过。覆盖幂等回执、内容冲突、并发拒绝、配置、取消审批、进程丢失、未知执行恢复、目录授权及跨重启稳定历史。
- 桌面浏览器：完整 50 项测试通过，包括新增后端选择、模型与审批配置、工具审批、刷新历史和切回 Codex；截图检查后修正 Google 会话中的遗留 Goal 状态栏。Web 与 Obsidian 构建通过。
- 真实 Google：经 Viewer HTTP 创建会话，发送标记后关闭并重新启动服务，原生会话 ID 与 Viewer 历史不变，下一轮正确回忆标记；第三轮经真实 MCP 读取显式附加的 Codex 测试会话。三次有界推理成功，测试中禁用了内置文件与命令工具。
- 真实结果存于本机忽略目录 `.runtime/acp-live/result.json`，未保存账户凭据；该文件不作为仓库可重现测试依赖。自动化测试使用本地 ACP fixture。

## 共享 Skills（2026-10-17）

共享技能通过 `~/.gemini/config/skills` 中的受管理链接发现，源文件仍由 `~/agent-skills` 或原所属项目维护。Viewer 的 Google 会话提供 Skills 按钮和 `$` 搜索，可显式选择本轮技能；本地目录扫描与 ACP 的四个搜索根一致，并沿用进程的 `GEMINI_HOME`。全局启停仍交由原生配置，不显示无效开关。

官方 ACP 1.4.0 能发现链接技能，但 native `view_file` 按真实路径检查工作区，会拒绝共享源目录。每个 Viewer Google 会话因此注册 `viewer_skills` 只读 MCP：`skills_list` 返回发现清单，`read_skill` 读取技能及其目录内的文本资源。它拒绝未发现技能、目录穿越、指向技能目录外的资源链接及超限文件，不提供写入或执行。Google 按描述主动选择或按用户本轮选择调用，保留原生审批。

验证包含符号链接共享、YAML 元数据、资源越界拒绝、显式调用路径校验和浏览器选择；独立真实 Google 会话已根据 PDF 排版任务自主选择并读取共享 `pdf/SKILL.md`，准确回报文件中的章节及操作指引。
