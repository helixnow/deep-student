# 学习 OS 导航迁移清单（P11 维护）

- 日期：2026-07-08
- 语义：workbench **开启**时，全局导航发起点改走 workbenchBus / 桌面层事件桥
  （`WorkbenchEventBridge`）；**关闭**时 `legacyNavigationMap` 把 bus 请求翻译回
  现有 CustomEvent，legacy 路径 100% 原样。
- 图例：✅ 已迁移 ／ ➖ 无需迁移（说明原因）／ ⏭ 暂缓（后续批次）

## 一、workbench 关闭 → bus 降级映射（legacyNavigationMap.ts）

- [x] ✅ `launch/activate chat`（含 instanceKey）→ `NAVIGATE_TO_VIEW chat-v2` + `navigate-to-session`（0/400/1200ms 三连发，与命令面板同节奏）
- [x] ✅ `activate chat setInput` → 追加 `CHAT_V2_SET_INPUT`
- [x] ✅ `launch note/textbook/exam/translation/essay/image/file/mindmap` → `NAVIGATE_TO_VIEW learning-hub + openResource=/{resourceId}`（App.tsx 现有 handleNavigateToView 消费）
- [x] ✅ `launch files` → `NAVIGATE_TO_VIEW learning-hub`
- [x] ✅ `launch settings/todo/skills/templates/taskDashboard/sandbox` → 对应 `NAVIGATE_TO_VIEW`
- [x] ➖ `launch pomodoro` → no-op（GlobalPomodoroWidget 常驻，无对应页面）
- [x] ✅ 注册点：`installLegacyNavigationFallback()` 由 App.tsx 启动 effect 调用（幂等）

## 二、workbench 开启 → 导航发起点接管（WorkbenchEventBridge.tsx，桌面层单份监听）

- [x] ✅ `navigate-to-session`（命令面板 openSessionFromPalette、TaskDashboardPage onNavigateToChat 的 legacy 分支、ModernSidebar）→ `bus.launch({typeId:'chat', instanceKey:sessionId})`
- [x] ✅ `CHAT_V2_SET_INPUT`（App.tsx PREFILL_CHAT_INPUT 中转、MarkdownRenderer 等）→ activate 最近聚焦 chat 窗 setInput；无 chat 窗时 `launchNewChatSession()` 后 setInput
- [x] ✅ `CHAT_NEW_SESSION`（标题栏新建按钮 / 命令面板 / modern-sidebar:group-action 同款守卫）→ `launchNewChatSession()`
- [x] ✅ `CHAT_OPEN_ATTACHMENT_PREVIEW`（消息附件 / 引用徽章）→ `bus.launch(资源窗)`（id 前缀映射 typeId，附件类回退 file）
- [x] ✅ `context-ref:preview`（上下文引用）→ vfs_get_resource 解析 sourceId → 资源窗
- [x] ✅ `pdf-ref:open`（带 sourceId）→ launch textbook/file 窗 + `pdf-ref:focus`（0/250/800ms 三连发）
- [x] ✅ `navigateToNote` / `navigateToTranslation` / `navigateToEssay`（chat 工具跳转）→ 对应内容窗
- [x] ✅ 页面级弹层宿主 `AnkiPanelHost`（open-anki-panel）桌面层挂载一次（lazy）
- [x] ➖ App.tsx 既有 listeners（NAVIGATE_TO_VIEW / navigateToNote 等）保持原样——workbench 开启时它们只改 currentView 状态（不渲染）与派发无人监听的 learningHubOpen* 事件，无副作用，保证开关关闭瞬间 legacy 立即可用
- [x] ✅ files 窗内双击资源（P8 FilesAppWindow 已内建 `bus.launch({reason:'files'})`）
- [x] ✅ taskDashboard 窗内跳会话（P9 TaskDashboardAppWindow 已内建 `bus.launch(chat)`）

## 三、暂缓项（记录原因，不阻塞验收）

- [ ] ⏭ `pdf-ref:open` 无 sourceId 时的会话附件扫描解析（legacy 在 ChatV2Page 内遍历
  当前会话消息附件推断 PDF；workbench 下 console.warn 忽略。需要把该解析逻辑抽为
  可复用工具后接入，涉及 chat 文件归属）
- [ ] ⏭ `navigateToExamSheet`（按 chat sessionId 定位题目集，legacy 由 LearningHubPage
  解析 sessionId→exam 资源；workbench 下暂走 legacy no-op。需 learning-hub 暴露
  sessionId→examId 查询）
- [ ] ⏭ `OPEN_MARKDOWN_EDITOR` / `OPEN_NOTES`（设置→关于 的入口，频度极低；workbench
  开启时无效果，可后续映射为 launch files 窗）
- [ ] ⏭ 命令面板 `openFileFromPalette`（走 learning-hub OpenResourceHandler 等待挂载；
  workbench 下 learning-hub 页不挂载，等待 4s 后放弃。后续应在 workbench 开启时改调
  `bus.launch(资源窗)`——涉及 command-palette 文件，本批次未动）
- [ ] ⏭ LearningHubSidebar 的 `useCommandEvents`（新建文件夹/聚焦搜索）依赖
  `useViewVisibility('learning-hub')`，files 窗内不生效（P8 遗留 5，涉及 learning-hub 文件）
