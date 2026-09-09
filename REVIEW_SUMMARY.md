# Codex Viewer 前端候选交付说明

本次在 `/work` 继承父运行 `run-1788951327474-1322848` 的候选，完成作者侧实现与自测。未应用到源工作区，未重启在线服务；独立评审与复核由 harness 后续安排。

## 已完成的改动

- **焦点与对比度（R3）**：降低配置选择器默认样式的优先级，将共享交互状态放在组件默认样式之后，移除会覆盖键盘轮廓的 `outline: none`。实际 Tab / Shift+Tab 检查覆盖模型、思考强度、模式、Skills 与消息输入框；模型等选择器在悬停时仍保留浅绿焦点边框，最终轮廓为 2px solid。配置状态使用 `#9aa89e` / `#0a0e0c`，对比度约 **7.83:1**，浏览器测试从计算样式读取颜色并检查至少 4.5:1。
- **中文强调（R5）**：Markdown 强调与标题恢复 `font-synthesis: weight`。使用仅有常规字形的 AR PL KaitiM GB 渲染同一中文强调：禁用合成时 700 与 400 截图相同；恢复合成后的截图不同，且已目视确认笔画加粗。检查实际渲染，未将 `font-weight: 700` 单独当作成功依据。
- **窄屏短操作（R6）**：390×844 输入区的状态提示独立成行，附件、停止、发送不收缩、不折字。待审批时逐个检查文本只有一行且处于视口内。长 Skill、目录与说明保留换行；长芯片的末尾移除标记可见且可点击。
- **流式与长内容（R1、R2）**：保留父候选直接跟随底部、手动上滚停止跟随及选区期间保持 DOM 的实现。补修刷新时先定位滚动、后显示输入区造成的布局变化：先更新审批与输入区，再渲染并定位阅读区。桌面与 390px 均检查持续跟随、真实滚轮上滚停留、选区保护、清除选区补齐、回到最新及流式刷新恢复。
- **阅读与组件**：保留原有深色布局和间距体系，补充本机无衬线中文回退字体，修正代码块内二次缩小的字号至 13px，短表格按内容收拢。提高辅助文字亮度，长模型选择器提供完整原生标题提示，长顶栏目录可换行，24 个 Skills 的长名称与说明不造成横向溢出。已选 Skills 区域限制高度并可滚动。`hidden` 属性保持有效，避免工具活动的空消息头被 flex 样式重新显示。
- **交付准确性（R4）**：重写本文件及 `FRONTEND_IMPROVEMENTS.md`，删除旧的 Windows 平台已验证、仅 CSS 改动、全局无回归等过度声明。README 明确每个独立检出安装依赖；`test:browser` 的前置脚本自行构建前端，不依赖另一检查目录生成的产物。

## 作者侧实际执行

- `npm ci`：依赖安装完成，没有增加新依赖。
- `npm run build`：TypeScript 与 Vite 构建通过；浏览器流程还会再次执行同一构建。
- `npm test`：原有 **8 项 Node 测试通过**，没有删除实质覆盖。
- `npx playwright install chromium --no-shell`：安装隔离测试使用的 Chromium。
- `npm run test:browser`：**3 项 Chromium 流程通过**，包括原有完整功能流程与新增的桌面 / 窄屏长内容流程。

原有浏览器流程保留首页不预选会话、配置失败与重试、空 Skills、普通 / Plan、Skill 调用与模拟全局启停、上传 / 图片粘贴、Windows 审批及刷新恢复、多任务切换、Markdown / 代码复制、公式与链接源码选区、受控文件预览和编辑器测试替身等覆盖。新增检查也覆盖 reduced-motion 的运行脉冲关闭与即时滚动。测试通过限定于这些用例，不代表所有平台和输入均已验证。

## 截图与视觉检查

实际渲染来自模拟 App Server，截图位于 `/work/test-results/`，并已由作者打开查看：

- `viewer-home.png`、`viewer-home-390.png`：首页引导及未选项目状态。
- `viewer-focus.png`、`viewer-config.png`：真实键盘焦点、已生效 / 下一轮配置、选中 Skill 与附件。
- `viewer-reading.png`（1440×1080）、`viewer-reading-mobile-top.png`、`viewer-mobile.png`：中文强调、中英混排、KaTeX、代码、表格和文件引用。
- `viewer-cjk-bold.png`、`viewer-cjk-regular.png`：固定常规中文字体的可见字重对照。
- `viewer-skills.png`、`viewer-many-skills-1280.png`、`viewer-many-skills-390.png`：常规与 24 项 Skills 列表。
- `viewer-folder-390.png`、`viewer-long-config-390.png`：长目录、长模型名与长 Skill 芯片。
- `viewer-approval.png`、`viewer-approval-mobile.png`：桌面与 390×844 待审批状态。
- `viewer-preview.png`、`viewer-preview-390.png`、`viewer-stream-390.png`：文件预览和持续流式阅读。

观察到中文正文与 UI 的字体更一致，强调笔画可辨；配置状态和焦点更清楚，代码保持可读字号，窄屏短操作单行，长内容在自己的区域换行或滚动。保留侧栏、阅读区与输入区的既有视觉层级，没有引入新的设计框架。

## 平台范围与运行边界

**实际环境是 Linux、Node 24.19.0 和 Playwright 管理的 Chromium 153**，使用本机 Linux 字体，主要视口为 1280×720、390×844，另查看 1440×1080 阅读截图。390px 是桌面 Chromium 的视口模拟，不是真实移动设备测试。

**尚未验证**真实 Windows 浏览器访问 WSL 的连接、Segoe UI / Microsoft YaHei / Cascadia / Consolas 实际渲染、Windows Edge、ClearType、系统 DPI 与浏览器缩放效果，也未验证 Safari / Firefox。保留 Windows 优先字体栈是一项实现选择，不是平台验收结论。

全部自动化流程使用模拟 App Server 与临时测试目录；Skill 开关只改模拟内存，编辑器调用由测试替身记录。未运行 `test:live`，未调用真实付费模型，未修改真实全局 Skills，未打开用户编辑器。候选等待用户明确 `apply`。
