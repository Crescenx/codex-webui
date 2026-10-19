# Codex 与 Antigravity 的历史互见和任务接续

日期：2026-10-16。实测环境为本机 Codex CLI 0.162.1 的 App Server、Google Antigravity ACP Server 1.4.0。推理使用 gpt-6.1-sol 与 gemini-3.8-flash-high。本调研使用官方现有接口，没有修改两个运行时，也没有接入产品代码。

结论：两端默认不自动共享会话。Viewer 可以让它们读取对方公开记录、共享任务资料、交换消息，并把界面做成同一段对话里的按轮交接。短文本的 Codex 到 Google 再回原 Codex 会话接力已实测通过；Codex 还支持补入模型可见历史，并能在重启后继续使用。原生执行状态、未公开推理、加密压缩状态和待执行工具调用没有共同的迁移接口，因此不能把这种接续解释为整个 agent 状态的无损移植。

| 层级 | 体验 | 当前判断 |
|---|---|---|
| 原生独立运行 | 同机启动两个服务 | 不自动互见历史；相互使用对方原生会话 ID 实测失败 |
| 单次交接 | 将已完成记录作为资料交给另一端 | 已验证双向可行 |
| 持续互读 | agent 按需读取或检索另一端的已公开记录 | 可由 Viewer 历史服务和 MCP 实现；现有 Session 引用提供基础 |
| 多轮交流 | agent 向另一端提问、回应、引用证据 | 需要 Viewer 路由和交付回执；可复用现有服务接口与 MCP |
| 同一可见对话里切换后端 | 保留各自原生会话，切换时补齐新增历史与任务状态 | 接续机制已通过短文本实验；完整产品体验尚未实现 |
| 整个原生运行状态迁移 | 连正在执行的工具、审批、私有上下文一起无损转移 | 当前接口不能提供 |

“可见”至少有三种不同含义：Viewer 收到并能展示；另一位 agent 被授权检索；内容已经被送入那位 agent 的本轮模型上下文。授权一个历史工具只建立第二种可见性，agent 仍需调用工具。把全文放入提示建立第三种可见性，但仍受上下文容量和模型实际处理能力限制。

| 内容 | 互见或接续能力 | 重要边界 |
|---|---|---|
| 用户消息、最终答复、计划 | 可以保留作者和顺序转交已输出文字 | 长记录需分段、检索或摘要；保存全文与每轮装入全文是两件事 |
| 公开的思考文本或摘要 | 接口明确输出的部分可以转交 | 不代表完整内部推理；当前 Viewer 引用没有开放 reasoning 类型 |
| 工具参数、结果、diff、检验记录 | 可以转交接口实际提供的字段 | Google ACP 部分工具结果只有摘要；缺失字段不能补写成完整证据 |
| 文件、图片、其他产物 | 可以通过共同工作目录或受控附件访问 | 当前引用只传文字与非文字占位，不携带图片或文件实体 |
| 项目规则、skills、任务约束 | 可以分别向两端提供同一份来源 | 各运行时的系统策略、工具定义和优先级仍不同 |
| 原生权限、审批、工具调用 ID | 可以展示来源状态，操作仍路由到原服务 | 不能把 Google 的请求 ID 当成 Codex 待处理调用 |
| 运行中 shell、浏览器、subagent | 外部状态和产物可记录或共享 | 相同路径和进程存在不等于继承另一端的控制句柄 |
| 原生私有压缩与推理状态 | 保留在各自原生会话中 | Codex ResponseItem 包含 encrypted_content；Google trajectory 包含模型相关 thought signatures，不是共同文本格式 |

Codex 的接收能力比单纯附加文字更强。公开的 `thread/inject_items` 可以将预构造的 Responses API items 追加到已加载线程的模型可见历史，不启动用户轮次。官方文档说明这些 items 会持久化，后续模型请求可以使用。本机已验证：注入 Google 的已完成答复，停止测试 App Server，重启并恢复同一 thread 后，Codex 能据此继续计算。

注入并不自动等价于 Viewer 的轮次展示。本次在注入后立即调用 thread/read，返回 turns 为空；但重启后的模型请求确实能使用注入内容。Viewer 应保存自己的交接记录与作者来源，不能只依赖原生 UI 轮次投影来证明“补入了什么”。Google 的答复可以作为归因明确的外部记录，避免把 peer 发言误记为接收 agent 自己的结论。

Codex 还有 `thread/resume.history`。本机导出的接口明确将其标为“[UNSTABLE] FOR CODEX CLOUD - DO NOT USE.”。研究探针用它创建新的 Codex 会话并继续 Google 答复，成功；正式实现优先使用公开的 inject_items 或 additionalContext，不把内部历史入口作为共同基础。

Google ACP 的 session/new 创建自己的原生会话；session/load 和 session/resume 按 ID 查找自己的 trajectory。load 会恢复 agent 并向客户端回放历史，resume 恢复而不回放。当前安装包没有与 Codex inject_items 对应的公开方法。可通过 session/prompt 的 text、embedded resource 或 MCP 工具结果传入别人的记录。本机源码将 embedded resource 的文本格式化后交给 agent.chat，作为当前消息内容，而不是重新建立外来 user、assistant、tool 的原生历史角色。

运行中交流也不对称。Codex turn/steer 可向当前轮次追加输入。Google ACP 当前调用的 SDK Conversation.send 在前一轮未结束时会先收完剩余步骤或等待 idle，再发送新消息。这是安装包源码证据，本轮没有另外运行并发提示实验。可靠的共同策略是在已完成轮次边界交接；Codex 的运行中追加作为单独能力保留。

同一 Viewer 对话里切换后端，可以采用一个共同记录和两个原生会话绑定：

```text
Viewer 对话 V
  共同记录：用户输入、各参与者答复、完成的工具记录、产物引用
  Codex 绑定：thread C，已同步至记录序号 c
  Google 绑定：session G，已同步至记录序号 g
  当前接手者：Codex 或 Google
```

Codex 切到 Google 时，固定交接边界，整理目标、约束、已经完成的事实、尚未解决的问题和当前工作区版本，再给 Google 补齐 g 之后它尚未接收的共同记录。切回 Codex 时恢复原来的 C，仅补齐 c 之后产生的增量。两端各自已有上下文继续保留。上下文过长时使用有来源的摘要与可检索全文，不宣称摘要等价于全部历史。

这种切换与辩论可以共用数据和投递机制，但运行规则不同：接手任务时通常只有一位 agent 负责当前工作；辩论时两位拥有各自观点与上下文，并明确读取对方的发言。两种场景都应保留作者、顺序、引用位置和对应产物。

最低可用通信约定可以很薄：

- 历史读取复用 `session_read`、`session_search`，来源身份由 Viewer 绑定，不接受模型任意冒充调用者。
- 新增消息投递操作，记录 messageId、from、to、正文或记录引用、replyTo 和交接截止位置。
- 返回已保存、排队、已提交、轮次完成或未知状态。已入队不表示模型已读取，更不表示已经理解。
- Codex 可映射为 turn/start、turn/steer、additionalContext 或 inject_items；Google 映射为 session/prompt 加资料块，在可用边界消费。

两种原生协议负责客户端控制各自的 agent。Viewer 可复用现有 HTTP、事件流和普通 MCP 承载以上约定，不需要为了本机互通先建立另一套独立网络协议或恢复 MCP Apps。

当前 Viewer 引用的具体基础与缺口：快照最多 64 KiB，支持用户消息、agent 答复、计划及选中的已结束工具记录；Session 引用默认只读文字，includeTools 才包含工具，不自动附带全文，不继承子会话或文件权限。reasoning 不在当前允许类型中；图片、文件显示为未附带实体的占位。跨后端互见需要先归一化会话与记录身份，再决定哪些类型开放和如何交付实体。

实测过程与结果：

| 检查 | 输入或机制 | 结果 |
|---|---|---|
| 原生会话 ID 互认 | Google load Codex ID；Codex read Google ID | 两端拒绝，分别为 session not found 和 thread not loaded |
| Codex 初始状态 | 标记 JASPER-7281，数值 17，每次加 5，禁止乘法 | 原生会话输出四字段 JSON |
| Codex 到 Google | 从 Codex thread/read 取得可见记录，作为 ACP embedded resource 交付 | Google 输出 22，保留标记、操作和约束 |
| Google 到原 Codex | Google load 回放记录，以 Codex additionalContext 交付 | 原 Codex 输出 27，保留标记、操作和约束 |
| Codex 内部 history 导入 | 用 Google 答复创建新的 Codex 会话 | 可继续到 27；入口明确标为内部不稳定 |
| Codex 公开 inject_items | 注入 Google 答复，重启 App Server，恢复同一 thread，再开始新轮次 | 输出 27，标记和约束保留，持久化接续通过 |

这些测试验证短文本内容和约束的接续，没有验证长历史、压缩后的保真度、多模态实体、工程修改、并发提示、待审批或进行中的工具迁移。所有推理探针均禁止工具操作，未改产品运行服务。

本机证据：[双向接力结果](../../.runtime/interop-research/result.json)、[公开注入与重启结果](../../.runtime/interop-research/inject-result.json)、[接力探针](../../.runtime/interop-research/probe.mjs)、[注入探针](../../.runtime/interop-research/probe-inject.mjs)。本地运行文件被 Git 忽略，可能随清理删除；上述表格保存影响结论的结果。

接口与源码证据：[Codex 本机历史注入参数](../../.runtime/interop-research/schema/v2/ThreadInjectItemsParams.ts)、[Codex 内部历史入口](../../.runtime/interop-research/schema/v2/ThreadResumeParams.ts)、[Codex 原生 ResponseItem](../../.runtime/interop-research/schema/ResponseItem.ts)、[Google ACP 实现](../../.runtime/acp-audit/bundled-source/server.py)、[Google SDK Conversation](../../.runtime/interop-research/google-conversation.py)、[Google trajectory 存储](../../.runtime/acp-audit/bundled-source/session_store.py)、[Viewer 引用数据规则](../../shared/references.ts)、[Viewer 引用服务](../../server/references.ts)。

官方资料：[Codex App Server 历史注入与轮次接口](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)、[ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[ACP Content](https://agentclientprotocol.com/protocol/v1/content)、[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。

后续讨论：缓存代价与三种协作操作（2026-10-16）。以下为产品设计建议，尚未实现；“parawell”暂按 parallel 并行协作理解。

跨运行时交接可以自动整理材料、延续同一任务，但界面应明确标记执行者和交接边界。建议提供“接手”“送检”“并行”三种操作，共用原生会话绑定、资料交付、执行回执和结果引用。

| 操作 | 谁负责当前主任务 | 接收方上下文 | 结果如何回到主线 |
|---|---|---|---|
| 接手 | 从 A 转给 B；A 保留原生会话，在已完成轮次或确认工具停止后交出执行权 | 当前目标、约束、工作区状态、必要历史；已有 B 会话则补齐尚未收到的增量 | B 继续主线，界面插入归因明确的交接记录 |
| 送检 | A 保持主任务负责人 | 新原生会话，接收固定版本的任务、产物、证据和具体检查问题；默认不携带 A 的完整推导、自我评价 | B 的报告作为独立结果返回，A 或用户决定如何采用 |
| 并行 | 多个独立分支各自执行；预先指定谁汇总或由用户选择 | 共同的固定输入，各自积累上下文；可同题独立求解，也可分工 | 在明确节点交换结果；需要时再进入多轮讨论 |

送检的“干净”指没有继承源会话的任务轨迹，项目规则及运行时自身配置是否加入应另行确定。可以先让 reviewer 独立判断，再按需开放源会话记录。并行修改代码时使用独立工作副本；仅分析资料时不必复制整个仓库。源 agent 继续工作时，送检和并行任务仍绑定送出时的版本，避免检查对象在过程中悄悄变化。

缓存不能从 Codex 搬到 Google。第一次交接时，目标模型需要处理对它而言尚未缓存的任务内容；这不等于目标端所有公共前缀都必然未命中。切回原来的原生会话时，追加增量能保留已有前缀，从而仍有缓存复用的机会。上下文重建、压缩、系统与工具定义变化，以及缓存保留策略都可能改变命中情况。原生会话仍存在，也不保证缓存仍可用。

复查上一轮已经完成的接力日志，Codex 报告如下；本次没有新增推理请求：

| 请求 | 输入 tokens | 命中缓存的输入 tokens | 观察 |
|---|---:|---:|---|
| 原 Codex 会话第一轮 | 8,930 | 0 | 该轮未报告缓存命中 |
| Google 完成后，回到同一个 Codex 会话 | 13,568 | 8,704 | 约 64.2% 输入命中；交接并未使这一轮缓存全部失效 |
| 通过内部 history 入口建立的新 Codex 会话 | 9,700 | 3,840 | 新会话也可能命中缓存；不能据此判定具体哪些前缀被复用 |

这是短文本功能实验的附带观测，不是缓存效果对照实验，不能推出频繁切换的平均损失、延迟增幅或订阅额度折算。Google 此次 ACP 的 usage_update 只给出 used 和 size，没有给出命中明细，不能估算 Google 侧缓存比例。原始证据为[接力事件日志](../../.runtime/interop-research/events.jsonl)中的 thread/tokenUsage/updated 与 usage_update。

[OpenAI 官方缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)建议稳定已有前缀、追加新消息，并指出重写或压缩历史可能影响复用；[Gemini API 缓存文档](https://ai.google.dev/gemini-api/docs/caching)同样建议把共同内容放在前面，在较短间隔内复用相似前缀。这些公开 API 文档支持一般机制，不能直接当作本机 Codex 或 Antigravity 订阅渠道的计费和缓存保证。

界面可在“让 Google 接手”动作旁说明“将载入任务资料，首轮可能较慢；原 Codex 会话保留”，并展示实际交付范围。没有测量依据时，不显示虚构的成本金额或固定折损百分比。实现上保留每个 agent 自己的会话并追踪已交付记录，按需补充资料；不在每次切换时重建、重排双方全部历史。

相关调研：[Viewer 接入 Antigravity 的能力与解耦](2026-10-16-antigravity-viewer-integration.md)。
