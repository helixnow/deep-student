# Fable SOTA Review Goal

> 目的：把 Claude Fable 5 用在最值得的位置：跨模块、长上下文、复杂状态机、数据一致性、前后端交互与移动端体验。  
> 本文是给 Fable 的审阅目标文档，不是普通 code review checklist。审阅必须以可复现问题、系统不变量、用户真实操作路径和最小修复建议为中心。

## 1. 审阅总目标

请以 SOTA 级别的软件系统审计标准，审查 DeepStudent 当前最复杂、最容易产生隐蔽缺陷的区域，找出会导致以下后果的问题：

- 数据丢失、静默跳过、不同设备最终状态不收敛。
- 备份、恢复、同步、迁移后出现不可见损坏、串库、重复上传、旧删除复活。
- Chat V2 流式对话、工具调用、多变体、重试、编辑、删除、停止、崩溃恢复之间出现状态错乱。
- VFS 与 Lance/SQLite/Blob/附件/索引之间出现双写不一致、孤儿数据、索引卡死。
- 前端交互状态与后端真实状态不一致，尤其是 loading/success/error/progress/conflict/quarantine 等状态误导用户。
- 移动端交互不可用或容易误触，包括安全区、软键盘、底部输入栏、手势滑动、底部导航、bottom sheet、滚动容器、横竖屏、小屏遮挡。
- 用户在高压真实场景下无法理解系统状态，无法恢复、重试、取消、撤销或定位错误。

审阅不能停留在“代码风格”“可读性”“建议重构”。必须优先寻找能造成真实损害的行为缺陷、边界条件、并发/时序问题、跨层契约破坏和缺失测试。

## 2. 项目背景

DeepStudent 是本地优先的 AI 学习工作台，技术栈为 Tauri 2 + Rust 后端 + React/TypeScript 前端。核心产品特征：

- 本地数据层：SQLite、VFS、Blob、附件、向量索引、Lance。
- 云同步与备份：WebDAV、FTP、S3 兼容存储，含备份恢复、增量同步、冲突处理。
- Chat V2：流式 LLM、工具调用、资源注入、上下文引用、多模型、多变体、子代理、工作区协作。
- 学习资源中心：笔记、教材、题库、导图、翻译、作文批改、Anki 制卡。
- 移动端体验：移动顶栏、底部导航、三屏滑动布局、移动输入栏、bottom sheet、触摸手势、安全区。

这不是单一模块系统。很多缺陷只会在“后端状态机 + 前端缓存 + 用户交互序列 + 移动布局”共同作用时出现。

### 2.1 必读背景文档

每批审阅开始前，Fable 应先读取与本批相关的背景文档。不要把这些文档当作事实终点；它们是历史审阅结论和设计意图，需要与当前代码重新核对。

- `docs/cloud-sync-remediation-plan.md`：云同步的权威不变量、缺陷矩阵、阶段性修复方案和全局验收要求。
- `docs/archive/DATA-MAPPING-REPORT.md`：当前数据库、废弃库、双数据空间、旧迁移/旧备份链路和数据治理覆盖面。
- `docs/archive/chat-v2-critical-review.md`：Chat V2 历史上已发现的流式、重试、多变体、崩溃恢复问题。
- `docs/reviews/vfs-learning-hub-chatv2-review-findings.md`：VFS、Learning Hub、practice、todo、pomodoro、chat_v2 互联审阅问题。
- `docs/design/learning-hub-core-contracts.md`：Learning Hub / DSTU / Chat 打开链核心契约。
- `ACCESSIBILITY-REVIEW.md`：WCAG 2.2 AA、移动/键盘/焦点/对比度/动画审计基线。
- `docs/archive/SECURITY_AUDIT_REPORT_202602.md`：Tauri 权限、路径遍历、XSS、敏感信息、依赖安全历史审计。
- `docs/design-tokens-and-color-semantics.md` 与 `docs/CODE_STYLE.md`：移动端布局、设计 token、touch target、safe area、滚动与 motion 约束。
- `docs/archive/llm-adapter-audit-fixes.md`：LLM 适配器协议差异、thinking 参数、供应商特例。
- `PR-REVIEW-2026-06-11.md`：近期 PR 审查中暴露的 FTP、移动端、依赖升级、路径安全、i18n、IPC 命令改名等风险模式。

### 2.2 当前工作区上下文

审阅时必须把当前未提交 diff 单独列为“正在变更的语义”，不要把它与 main/nightly 历史混淆。当前已知存在同步相关测试与 VFS repo 文件改动；Fable 应明确区分：

- 当前 diff 是否只改测试期望，还是改变了生产语义。
- 文档中的设计目标是否仍与当前 diff 一致。
- 当前 diff 是否要求补前端 UI、错误提示、审计日志、迁移或额外测试。
- 未提交改动是否影响某些历史 review 结论的有效性。

## 3. 审阅优先级

### P0: 云同步与数据治理

重点路径：

- `src-tauri/src/data_governance/sync/*`
- `src-tauri/src/data_governance/commands_sync.rs`
- `src-tauri/src/data_governance/commands_backup.rs`
- `src-tauri/src/data_governance/commands_restore.rs`
- `src-tauri/src/data_governance/backup/*`
- `src-tauri/src/cloud_storage/*`
- `src/api/dataGovernance.ts`
- `src/features/settings/components/DataGovernanceDashboard.tsx`
- `src/components/SyncConflictDialog.tsx`
- `src-tauri/tests/sync_*`
- `docs/cloud-sync-remediation-plan.md`

核心问题：

- 当前实现是否满足 `docs/cloud-sync-remediation-plan.md` 中 INV-1 到 INV-7。
- 下载游标、水位线、seq、manifest、prune、snapshot、restore baseline 是否会导致永久漏同步。
- 解密失败、解析失败、SQL 约束失败、FK 失败、未知表、内部表写入、SQLITE_BUSY、IO 错误是否分类正确。
- 单条失败隔离、批次继续应用的语义是否完整贯穿后端返回、审计日志、进度事件、前端 UI、重试入口。
- quarantine/conflict/warning/failure 是否对用户可见，是否会被错误地当成 success。
- 同一记录的 UPDATE/DELETE/重建/软删除/墓碑是否在任意同步顺序下收敛。
- FTP/WebDAV/S3 是否满足同一传输契约：递归 list、原子 put、not-found 与错误区分、截断显式报错、超时、重试、root 边界。
- 备份恢复后 device identity、consume cursor、upload baseline、旧设备目录、云端 manifest 是否可能串库或漏同步。
- prune 是否会删除新设备或长期离线设备仍需的 changes。

当前工作区特别需要关注：

- `src-tauri/tests/sync_scenarios_tests.rs` 中部分测试语义已经从“整批失败/回滚”改为“单条隔离/批次继续”。请检查产品语义、后端实现、测试命名、UI 反馈和 remediation plan 是否一致。

### P0: Chat V2 前后端状态机

重点路径：

- `src-tauri/src/chat_v2/pipeline/*`
- `src-tauri/src/chat_v2/handlers/*`
- `src-tauri/src/chat_v2/repo.rs`
- `src-tauri/src/chat_v2/state.rs`
- `src-tauri/src/chat_v2/events.rs`
- `src-tauri/src/chat_v2/tools/*`
- `src-tauri/src/chat_v2/workspace/*`
- `src/features/chat/adapters/TauriAdapter.ts`
- `src/features/chat/core/store/*`
- `src/features/chat/core/middleware/*`
- `src/features/chat/components/*`
- `src/features/chat/components/input-bar/*`
- `src/features/chat/components/Variant/*`
- `src/features/chat/components/renderers/*`
- `docs/archive/chat-v2-critical-review.md`

核心问题：

- 发送、停止、重试、编辑重发、删除、切换会话、多变体重试、批量重试、工具审批、ask-user 阻塞、恢复继续执行是否互相破坏状态。
- 后端 session stream lock、variant cancel token、frontend operation lock 是否一致。
- 流式事件是否可能乱序、重复、丢失或被 sequence 去重误伤。
- 前端 optimistic update 是否能在后端失败时完整回滚。
- 崩溃或强退后，message/block/variant/tool status 是否能恢复到用户可理解的状态。
- 上下文截断、附件注入、VFS refs、PDF page refs、图片 payload 是否在发送、重试、编辑、变体重试后保持一致。
- token usage、model id、display name、provider icon、usage metadata 是否前后端字段语义一致。
- 长对话、长工具循环、网络中断、LLM stream reconnect 是否会重复写块、漏写块、出现幽灵 block。

必须覆盖的用户序列：

- 正在流式输出时切换会话，然后返回。
- 正在工具调用时停止，再重试。
- 多变体输出中删除其中一个变体，再重试全部变体。
- 带 PDF/图片/笔记上下文发送，随后编辑用户消息并换上下文重发。
- 工具审批弹出时切换移动端屏幕、收起/展开底部输入栏。
- 后端 stream 已结束但前端未收到 complete 事件。
- 前端收到 reconnect/complete/error 的顺序异常。

### P0: 使用体验、用户旅程与产品信任感

体验审阅不能只检查组件是否渲染、按钮是否可点。Fable 必须从真实学习用户的连续旅程出发，判断用户是否能理解当前状态、相信系统反馈、从错误中恢复，并在桌面与移动端之间保持同一套心智模型。

重点路径：

- `src/App.tsx`
- `src/components/layout/*`
- `src/components/UnifiedNotification.tsx`
- `src/components/ui/NotionDialog.tsx`
- `src/features/chat/pages/ChatV2Page.tsx`
- `src/features/chat/components/*`
- `src/features/learning-hub/*`
- `src/features/notes/*`
- `src/features/mindmap/*`
- `src/features/practice/*`
- `src/features/settings/*`
- `src/features/template-management/*`
- `src/command-palette/*`
- `src/features/command-palette/*`
- `src/voice-input/*`
- `src/features/voice-input/*`
- `src/locales/*`
- `README_CN.md`
- `ACCESSIBILITY-REVIEW.md`
- `docs/CODE_STYLE.md`
- `docs/design-tokens-and-color-semantics.md`

核心问题：

- 首次启动、未配置模型、无学习资料、无同步账号、无索引结果、无历史对话时，用户是否知道下一步该做什么。
- 用户是否能发现核心闭环：导入资料 -> 索引/引用 -> Chat 提问 -> 生成笔记/导图/题目/Anki -> 复习 -> 同步/恢复。
- 空状态、加载态、长任务进度、部分成功、失败、隔离、冲突、取消、重试、恢复是否有一致且真实的表达。
- 成功提示是否会夸大事实：例如“已同步”“已导入”“已生成”“已保存”是否真的代表后端持久化、索引、变更日志、同步队列都已达到对应状态。
- 用户是否能理解 AI 实际看到了什么上下文，哪些资源被引用，哪些内容被截断，哪些工具被调用，哪些结果只是草稿。
- 长 PDF、长对话、长工具循环、导入导出、OCR、索引、备份恢复这些长任务是否能在用户切页、锁屏、重启后继续被发现和管理。
- 破坏性操作是否有清晰确认、撤销或恢复路径：删除资料、清空索引、重置进度、覆盖恢复、批量导入、批量导出、模板覆盖。
- 桌面端、平板端、手机端对同一工作流是否保留同一套入口、状态文案、错误恢复动作和信息层级。
- 高级功能是否渐进披露：MCP、模板、模型参数、同步诊断、数据治理、日志导出不能压垮普通用户，但必须能被需要的人找到。
- 错误文案是否给出可执行下一步，而不是裸露 JSON、Rust error、provider error 或内部状态名。
- 关键入口是否可发现：命令面板、右键菜单、移动端底部导航、资源引用、工具审批、同步状态、系统状态、导入导出。
- 系统是否避免“看起来还能用但实际已失效”的体验：后台任务卡死、离线状态误判、索引落后、恢复后 UI 使用旧缓存、AI 输出引用已删除资源。
- 国际化、长文本、系统字体放大、深色模式、高对比度、reduced motion 是否不会让核心任务变得不可理解。
- 感知性能是否合理：用户操作后是否立刻有反馈，慢任务是否解释原因，安全的 optimistic update 是否能回滚。

必须覆盖的用户序列：

- 新用户首次启动，没有 API key，没有资料，导入第一份 PDF，提出第一个问题。
- 用户导入 200 页 PDF，索引仍在进行时切换到 Chat 引用它，再切到移动端查看状态。
- 同步配置失败，用户从设置页、系统状态、数据治理页发现原因并完成恢复。
- 用户在移动端上传图片或 PDF，选择上下文，发起 Chat，审批工具，查看结果并保存为笔记或题目。
- AI 生成题目/Anki 卡片失败一半，用户能区分已保存、草稿、失败项，并能重试或撤销。
- 用户删除或恢复资源后，Chat 引用、学习中心、搜索、复习计划、同步状态都给出一致反馈。
- 后台备份或恢复过程中用户关闭应用，重开后能知道任务是否完成、失败或需要继续。
- 模型或网络错误发生时，用户能判断是账号配置、网络、provider 限制、上下文过长还是应用内部错误。
- 用户在桌面端开始的学习任务，在窄屏或手机上继续，不丢失上下文、不出现入口消失。

### P0: 前端交互逻辑与移动端体验

重点路径：

- `src/components/layout/MobileSlidingLayout.tsx`
- `src/components/layout/MobileLayoutContext.tsx`
- `src/config/mobileLayout.ts`
- `src/config/zIndex.ts`
- `src/config/breakpoints.ts`
- `src/features/chat/components/input-bar/*`
- `src/features/chat/components/MessageList.tsx`
- `src/features/chat/components/MessageItem.tsx`
- `src/features/chat/components/ToolApprovalCard.tsx`
- `src/features/chat/components/AgentTaskPanel.tsx`
- `src/features/chat/components/Variant/*`
- `src/components/ui/unified-sidebar/*`
- `src/features/learning-hub/*`
- `src/features/notes/*`
- `src/features/mindmap/*`
- `src/features/settings/components/*`
- `src/features/todo/*`
- `src/features/practice/*`
- `src/components/translation/*`
- `docs/CODE_STYLE.md`
- `docs/design-tokens-and-color-semantics.md`

核心问题：

- 移动端顶栏、底部 TabBar、输入栏、bottom sheet、toast、modal、popover、context menu 是否会互相遮挡。
- iOS/Android 安全区是否正确处理：`env(safe-area-inset-*)`、`--android-safe-area-bottom`、软键盘弹起、横屏、刘海屏。
- `MobileSlidingLayout` 的水平手势是否会误拦截垂直滚动、文本选择、代码块滚动、PDF 缩放、导图拖拽、slider、textarea 光标操作。
- 三屏布局 left/center/right 的状态是否能与路由、view visibility、bottom tab fullscreen claim、side panel open 状态一致。
- 输入栏高度 ResizeObserver、placeholder height、textarea max height、附件 chips、context refs、model mentions、blocking bars 是否会导致布局跳动或遮挡最后一条消息。
- mobile bottom sheet 是否能被键盘、safe area、z-index、portal target、focus trap 正确处理。
- 所有主要工作流是否支持单手触控：聊天、资源选择、上传附件、选择上下文、批准工具、解决冲突、同步进度、查看错误、重试。
- 长文本、长文件名、多语言、动态翻译缺失、超长模型名、超多附件、低端机慢渲染时是否造成布局崩坏。
- 前端成功提示是否真实反映后端状态，尤其是 sync/backup/restore/import/indexing/chat tool execution。
- 视图保持 mounted 的架构下，隐藏 view 是否仍在监听事件、占用 fullscreen claim、显示 notification、更新不该更新的 store。

移动端必须覆盖的设备/视口：

- 360x740 Android 小屏。
- 390x844 iPhone 常见屏。
- 430x932 大屏手机。
- 768x1024 平板窄屏。
- 横屏手机，高度小于 430。
- 软键盘打开状态。
- 系统字体放大或浏览器/系统文本缩放。
- 深色和浅色主题。

移动端必须覆盖的用户序列：

- 在聊天输入框输入多行文本，打开附件面板，选择资源引用，软键盘保持打开。
- 流式输出过程中打开工具审批卡，批准/拒绝，再滑到资源侧栏。
- 在三屏布局中快速左右滑动，同时列表区域垂直滚动。
- 打开 bottom sheet 后旋转屏幕或切换到横屏。
- 在资源中心长按/多选/拖拽/上传文件，再返回聊天引用该资源。
- 同步进度弹窗显示时切换设置页和数据治理页。
- 网络错误或同步隔离项出现时，用户能在移动端发现、理解并重试。

### P0: 学习闭环、SSOT 与跨子应用数据一致性

重点路径：

- `src-tauri/src/question_bank_service.rs`
- `src-tauri/src/vfs/repos/question_repo.rs`
- `src-tauri/src/vfs/repos/review_plan_repo.rs`
- `src-tauri/src/review_plan_service.rs`
- `src-tauri/src/chat_v2/tools/qbank_executor.rs`
- `src-tauri/src/chat_v2/vfs_resolver.rs`
- `src-tauri/src/vfs/ref_handlers.rs`
- `src/features/practice/*`
- `src/hooks/useQuestionBankSession.ts`
- `src/stores/reviewPlanStore.ts`
- `src/features/todo/*`
- `src/features/pomodoro/*`
- `src/features/learning-hub/*`
- `docs/reviews/vfs-learning-hub-chatv2-review-findings.md`

核心问题：

- 题目、答题状态、解析、复习计划、统计、Chat 注入是否有明确 SSOT。
- `exam_sheets.preview_json` 与 `questions` 表是否出现双轨写入、读取陈旧快照或互相矛盾。
- “导入资料 -> 出题/做题 -> 错题/复习计划 -> 到期复习 -> Chat 辅助解释 -> Anki 制卡”是否端到端接通。
- 删除题目、重置进度、批改、复习、导出、Chat 工具调用是否同时维护 review_plans、stats、history、preview_json 或明确不维护。
- UTC 日期、本地日期、due date、todo、pomodoro、review_plan 是否有一致的“今天”语义。
- 子应用之间是否存在“后端功能完成但 UI 无入口”“前端入口存在但后端命令未注册”“死字段让用户误以为支持”的断层。
- 用户中断、关闭应用、系统休眠后，练习会话、复习会话、番茄钟、媒体处理、导入任务是否可恢复。
- 大题集、长教材、长 PDF、全量分页拉取、base64 IPC、LRU 缓存是否会让学习主流程卡死或内存暴涨。

必须覆盖的用户序列：

- 用户导入试卷，AI 识别题目后手动改答案，再让 Chat 解释同一题。
- 用户做错题后退出应用，第二天打开复习入口检查是否出现。
- 用户删除题目后查看到期复习、统计和 Chat 引用。
- 用户在移动端做题/批改/查看解析/加入复习计划。
- 用户上传 200 页 PDF 后立刻引用给 Chat，再重启应用。

### P1: VFS、资源、索引与 Lance 双写

重点路径：

- `src-tauri/src/vfs/handlers.rs`
- `src-tauri/src/vfs/indexing.rs`
- `src-tauri/src/vfs/repos/*`
- `src-tauri/src/vfs/lance_store.rs`
- `src-tauri/src/vfs/pdf_processing_service.rs`
- `src-tauri/src/vfs/multimodal_service.rs`
- `src-tauri/src/vfs/unit_builder/*`
- `src/features/learning-hub/*`
- `src/features/chat/context/*`
- `src/dstu/*`

核心问题：

- SQLite、blob 文件、Lance vector rows、index unit rows 是否有跨存储一致性保证。
- upload/import/index/reindex/delete 是否事务边界清晰。
- 失败补偿是否完整：Lance rollback、orphan queue、pending queue、retry_count、abandoned entries。
- `vfs_upload_file`、`vfs_upload_attachment`、`vfs_reindex_resource`、`delete_resource_index` 等多步操作中是否可能部分落地。
- PDF OCR、page rasterization、embedding dimension、text/multimodal index 是否会出现状态不一致。
- 前端 resource list、index status、chat context selector 是否能展示真实 index 状态。

### P1: 迁移、备份、恢复

重点路径：

- `src-tauri/src/data_governance/migration/*`
- `src-tauri/src/data_governance/backup/*`
- `src-tauri/src/database/*`
- `src-tauri/src/chat_v2/migration/*`
- `src-tauri/tests/migration_tests.rs`
- `src-tauri/src/data_governance/migration_tests.rs`

核心问题：

- migration 是否幂等，失败后是否可恢复。
- schema registry、migration defs、expected tables/indexes 是否漂移。
- restore 前置备份与 rollback 是否覆盖所有数据库和资产目录。
- 旧版本升级、新安装、半迁移状态、用户手动替换数据库是否安全。
- 迁移状态事件是否真实反映成功/失败/阻塞。
- 旧备份、旧导入、旧笔记导入导出、data_space 双插槽迁移是否绕过数据治理、维护模式、审计日志或同步 baseline。
- 已废弃库与活跃库之间是否仍有读写路径，是否可能让恢复/同步漏掉真实用户数据。
- 动态 workspace 数据库、audit.db、message queue、LLM usage 聚合是否在备份/恢复/迁移中语义明确。

### P1: LLM manager、工具协议与供应商适配

重点路径：

- `src-tauri/src/llm_manager/*`
- `src-tauri/src/providers/*`
- `src-tauri/src/vendors/*`
- `src-tauri/src/adapters/*`
- `src-tauri/src/chat_v2/tools/*`
- `src/features/settings/components/*Api*`
- `src/features/settings/components/Mcp*`

核心问题：

- 流式协议转换、工具调用、重连、超时、取消、token usage 是否在不同供应商下语义一致。
- API 配置、模型 ID、display name、vendor metadata、默认模型选择是否前后端一致。
- 错误分类是否能给用户可操作反馈，而不是泛化为 unknown。
- 工具执行预算、参数过大 retry hint、attempt_completion、ask_user、subagent、workspace tool 是否可恢复。

### P1: 学习产物生成、导入导出与集成入口

重点路径：

- `src-tauri/src/enhanced_anki_service.rs`
- `src-tauri/src/streaming_anki_service.rs`
- `src-tauri/src/apkg_exporter_service.rs`
- `src-tauri/src/anki_connect_service.rs`
- `src-tauri/src/question_import_service.rs`
- `src-tauri/src/notes_exporter.rs`
- `src-tauri/src/question_export_service.rs`
- `src-tauri/src/essay_grading/*`
- `src-tauri/src/qbank_grading/*`
- `src-tauri/src/translation/*`
- `src-tauri/src/chat_v2/tools/chatanki_executor.rs`
- `src-tauri/src/chat_v2/tools/template_executor.rs`
- `src-tauri/src/chat_v2/tools/docx_executor.rs`
- `src-tauri/src/chat_v2/tools/pptx_executor.rs`
- `src-tauri/src/chat_v2/tools/xlsx_executor.rs`
- `src/components/anki/*`
- `src/features/template-management/*`
- `src/components/translation/*`
- `src/components/essay-grading/*`
- `src/essay-grading/*`
- `src/translation/*`
- `src/components/DataImportExport.tsx`

核心问题：

- AI 生成的卡片、模板、翻译、作文批改、题目导入、导出文件是否有结构化校验、幂等键、可恢复任务和用户可见错误。
- AnkiConnect、APKG 导出、模板渲染、Mustache/HTML/CSS 预览是否保持安全边界，避免 XSS、模板注入或损坏卡片。
- 流式制卡、批量导入、导出 ZIP/CSV/APKG/DOCX/PPTX/XLSX 是否能在中断、失败、取消、重试后保持一致。
- LLM 结构化输出解析是否有 schema、fallback、错误定位和最小重试，而不是把坏 JSON/坏 marker 静默吞掉。
- 导入导出是否绕过 VFS、数据治理、change log、审计日志或同步状态。
- 大批量卡片、长作文、长翻译、复杂模板、图片附件是否有内存和 token 预算。
- 前端任务看板、进度条、取消/重试按钮、移动端编辑器是否真实反映后端任务状态。

### P1: 应用外壳、命令入口与扩展表面

重点路径：

- `src/command-palette/*`
- `src/features/command-palette/*`
- `src/voice-input/*`
- `src/features/voice-input/*`
- `src/mcp/*`
- `src-tauri/src/mcp/*`
- `src-tauri/src/package_manager.rs`
- `src-tauri/src/backup_job_manager.rs`
- `src-tauri/src/background_tasks.rs`
- `src-tauri/src/menu.rs`
- `src/menu/*`
- `src/hooks/useAppUpdater.ts`
- `src/hooks/useTauriEventListener.ts`
- `src/hooks/useBackupJobListener.ts`
- `src/components/system-status/*`
- `src/stores/systemStatusStore.ts`

核心问题：

- Command Palette、菜单、快捷键、voice input、MCP tools 是否调用同一业务主链，而不是绕过权限、状态锁或数据治理。
- 全局快捷键、命令搜索、语音输入目标选择是否在移动端、输入框、modal、bottom sheet、focus trap 中行为一致。
- MCP 配置、工具执行、OAuth/auth、stdio/SSE/HTTP transport 是否有超时、取消、凭据保护和错误可见性。
- App updater、background task、backup job、system status 是否有恢复、幂等、用户通知和失败重试。
- 调试面板、request audit、console log、debug database 是否可能泄露 prompt、附件、API key、云存储密码或用户资料。
- 入口级功能是否有 discoverability：用户能否从 command palette、菜单、移动端导航到达对应功能。

### P1: 安全、隐私、权限与供应链

重点路径：

- `src-tauri/capabilities/*`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/secure_store.rs`
- `src-tauri/src/cloud_storage/*`
- `src-tauri/src/commands.rs`
- `src-tauri/src/package_manager.rs`
- `src-tauri/src/mcp/*`
- `src/features/settings/components/*`
- `src/utils/cloudStorageApi.ts`
- `src/components/*Preview*`
- `src/features/chat/components/renderers/*`
- `.github/workflows/*`
- `docs/archive/SECURITY_AUDIT_REPORT_202602.md`
- `PR-REVIEW-2026-06-11.md`

核心问题：

- API key、FTP/WebDAV/S3 密码、加密密码是否只进 secure store，不进 localStorage、日志、debug payload、request audit 或 crash report。
- Tauri 文件系统、opener、pdfstream、自定义协议、MCP 子进程是否有路径规范化、白名单和最小权限。
- Markdown、HTML、SVG、Mermaid、Excel/DOC/PPT/PDF 预览是否保持 sanitize 与 CSP 边界。
- 用户可配置命令、MCP server、package install、shell 调用是否有明确可信边界。
- CI/release workflow 是否保持 pin、签名、公证、versionCode/versionName 单调性。
- 大文件解密/下载/导入是否原子，失败不会留下半明文或损坏密文。
- PR/贡献者改动是否带入个人文件、二进制教材、planning 数据库、API key 文件或 workflow 供应链回退。

### P1: 无障碍、国际化、视觉系统与可感知反馈

重点路径：

- `ACCESSIBILITY-REVIEW.md`
- `src/i18n.ts`
- `src/locales/*`
- `src/components/ui/*`
- `src/components/shared/*`
- `src/features/chat/components/*`
- `src/features/settings/components/*`
- `src/features/pomodoro/*`
- `src/features/todo/*`
- `src/styles/*`
- `src/components/UnifiedNotification.tsx`
- `src/components/ui/NotionDialog*`

核心问题：

- 移动端和桌面端是否满足键盘可达、焦点可见、focus trap、Escape/back 行为、ARIA name/role/value。
- 错误、进度、同步状态、工具审批、后台任务完成是否通过 aria-live/status message 正确暴露。
- 表单错误是否设置 `aria-invalid`、`aria-describedby`，并提供可操作修复建议。
- `prefers-reduced-motion`、系统文本缩放、对比度、dark mode、semantic token 是否被遵守。
- destructive action 是否统一使用可访问对话框，而不是 `window.confirm`。
- en-US/zh-CN 是否同时补齐，硬编码中文是否进入英文 UI。
- 长文案、翻译缺失 key、模型名、文件名、错误 JSON 是否破坏布局或可读性。

## 4. SOTA 审阅标准

请按照以下标准审阅，而不是只读 diff：

### 4.1 系统不变量优先

先写出每个区域必须满足的不变量，再找代码是否破坏它们。例如：

- 同步游标只在数据安全落地或显式检疫后推进。
- 任何失败不能被展示为成功。
- 前端 success 状态必须能追溯到后端真实成功。
- 删除不能复活。
- 重试不能改变原始上下文，除非用户明确编辑。
- 移动端关键操作不能被软键盘或安全区遮挡。
- 隐藏页面不能抢占全局移动端 fullscreen claim。

### 4.2 反例驱动

每个高价值问题都应尽量给出反例序列：

1. 初始状态。
2. 用户或设备 A/B 的操作序列。
3. 网络、进程、云端或 UI 时序扰动。
4. 预期结果。
5. 实际风险。
6. 最小测试或日志断言。

不要只说“可能 race condition”。要说明什么事件先后顺序会触发它。

### 4.3 跨层契约检查

对每条关键链路，必须检查 Rust 后端、Tauri command、TypeScript API、React store、UI 状态是否语义一致。

示例：

- `SyncResult.success=false` 是否会让设置页弹失败，而不是 completed toast。
- quarantine count 是否进入前端 dashboard。
- stream error 是否清理 active stream、operation lock、input disabled state。
- mobile sheet close 是否同步 store 的 panel state。

### 4.4 真实用户工作流优先

优先审查用户最可能执行且损害最大的流程：

- 学习资料导入、索引、聊天引用。
- 长对话工具调用中断后恢复。
- 多设备同步、冲突、恢复。
- 移动端聊天、上传、审批、资源选择。
- 备份恢复后继续使用。

### 4.5 测试缺口必须具体

如果发现缺少测试，必须给出：

- 测试文件建议。
- 测试名称。
- 测试数据。
- 断言。
- 是否需要 fake cloud provider、temp sqlite、Playwright/mobile viewport、Vitest source test。

### 4.6 可观测性与可恢复性

任何后台任务、长事务、跨设备同步、LLM 工具循环、媒体处理、导入导出，都必须审查：

- 是否有可关联的 job id / session id / resource id / request id。
- 日志是否足够定位问题，但不泄露敏感信息。
- 进度是否单调、可取消、可重试、可恢复。
- 崩溃或重启后是否能发现 stuck/in-progress 状态，并自动恢复或提示用户。
- UI 是否能区分 pending、running、warning、partial success、failed、quarantined、conflicted、completed。
- 用户是否知道下一步能做什么。

### 4.7 性能与内存预算

Fable 必须主动寻找“功能正确但规模一大就失效”的问题：

- base64 全量 IPC、一次性读入大文件、JSON 巨对象、LRU 只按条数不按字节。
- N+1 IPC、N 个事务、全量分页拉取、全库 LIKE 扫描、每次发送重解引用历史上下文。
- 前端隐藏视图仍在监听事件、刷新 store、抢占 fullscreen claim。
- 移动端低端机上的重渲染、动画、虚拟列表缺失、长列表选择性能。
- 向量索引、OCR、PDF 渲染、LLM 工具结果是否有硬预算和 truncated 标记。

### 4.8 使用体验评估标准

Fable 必须把使用体验作为独立风险来源，而不是 P3 美化项。体验问题在以下情况下应升级严重级别：

- 用户无法发现核心入口，导致关键任务不能开始。
- 用户收到成功提示，但真实后端状态仍失败、部分成功、隔离、冲突或未持久化。
- 用户无法判断长任务是否还在运行、是否可取消、是否能恢复。
- 用户不知道 AI 使用了哪些上下文、哪些内容被截断、哪些工具产生了结果。
- 用户在移动端、窄屏、系统字体放大或软键盘打开时无法完成同一核心流程。
- 用户做出破坏性操作后没有撤销、恢复、预览差异或明确确认。
- 错误文案无法指导下一步，或者暴露内部实现却隐藏真正的用户动作。

每个体验类 finding 必须区分：

- `Task blocked:` 用户无法完成任务。
- `User misled:` 用户能继续操作，但会基于错误反馈做错决定。
- `Flow friction:` 用户可完成任务，但路径过长、入口隐蔽、反馈不连续。
- `Polish:` 不影响理解和恢复的局部打磨。

体验审阅必须优先采用旅程视角，而不是孤立组件视角。一个小组件问题如果破坏“导入 -> 提问 -> 生成学习产物 -> 复习 -> 同步”的连续性，应按旅程影响定级。

## 5. 输出格式要求

请输出结构化报告，必须包含以下部分：

### 5.1 Executive Summary

- 本轮审查覆盖了哪些路径。
- 最高风险结论。
- 是否发现会导致数据丢失、状态不收敛、移动端不可用的问题。

### 5.2 Findings

每个 finding 必须使用以下格式：

```text
[Severity] Title
Area:
Files:
Invariant Violated:
Evidence:
Reproduction / Counterexample:
User Impact:
Current Diff Relevance:
Affected User Journey:
Observability Gap:
Why Existing Tests Miss It:
Minimal Fix Direction:
Suggested Test:
Confidence:
```

Severity 定义：

- P0：数据丢失、永久不收敛、安全边界破坏、关键移动端流程不可用、用户无法恢复。
- P1：常见路径状态错乱、错误成功提示、重试/恢复失败、显著移动端遮挡或误触。
- P2：边界路径错误、性能/可观测性不足、测试缺口会放大未来风险。
- P3：代码质量、维护性、局部 UX 打磨。

字段说明：

- `Current Diff Relevance:` 该问题是否由当前未提交 diff 引入、修复或暴露。
- `Affected User Journey:` 影响哪个真实学习/同步/移动端流程。
- `Observability Gap:` 现有日志/UI/测试为什么难以及时发现它。

### 5.3 Cross-Layer Contract Matrix

对重点链路列矩阵：

```text
Backend state -> Tauri command -> TS API -> Store -> UI -> Mobile UI -> Tests
```

标出每一层是否有：

- 状态字段。
- 错误字段。
- loading/progress。
- retry/cancel/recover 操作。
- 测试覆盖。

### 5.4 Mobile Interaction Audit

必须单独列一节移动端审计：

- 被遮挡元素。
- 手势冲突。
- 键盘冲突。
- z-index/portal/focus trap 问题。
- 安全区问题。
- 小屏文本溢出或按钮不可点。
- 移动端缺失的恢复/重试入口。
- 横屏、系统字体放大、深色模式、reduced motion 下的差异。
- 与硬件 Back、Escape、全局快捷键、底部导航之间的冲突。

### 5.5 User Experience Audit

必须单独列一节使用体验审计：

- 覆盖了哪些真实用户旅程。
- 每条旅程的入口、空状态、加载态、成功态、失败态、恢复动作是否完整。
- 用户在哪些点可能被误导：错误成功提示、过度乐观进度、AI 上下文不透明、部分成功未说明、后台任务失联。
- 哪些入口难以发现或只在桌面端存在。
- 哪些状态文案、toast、dialog、empty state、系统状态提示需要改写。
- 桌面端、平板端、手机端的同一任务是否保持一致心智模型。
- 体验问题的严重级别：Task blocked / User misled / Flow friction / Polish。
- 建议输出一份 friction map，按“触发点 -> 用户看到什么 -> 用户可能误解什么 -> 最小修复”组织。

### 5.6 Accessibility, I18n, Security Notes

即使本批不是专门的安全或无障碍审阅，也要列出：

- 是否发现敏感信息泄露、权限扩大、路径逃逸、未 sanitize 渲染。
- 是否新增硬编码中文、缺失翻译 key、错误 JSON 直出。
- 是否破坏 keyboard/focus/aria-live/reduced-motion/contrast。
- 若未覆盖，必须明确写成 open question，而不是默认通过。

### 5.7 Test Plan

按优先级给出测试计划：

- Rust unit/integration tests。
- Sync provider contract tests。
- Vitest store/source tests。
- Playwright mobile viewport tests。
- Tauri desktop/manual E2E。
- Accessibility checks：axe/role/focus/manual keyboard。
- Memory/performance checks：large PDF、large question bank、long chat、low-end mobile viewport。
- UX journey checks：first-run、empty state、long task、partial success、mobile continuation、restore after restart。

### 5.8 Fix Plan

不要直接大改架构。请给出分阶段修复建议：

- Phase 0：低风险止血，修用户可见错误状态。
- Phase 1：补测试和观测。
- Phase 2：修核心状态机/契约。
- Phase 3：清理结构债。

## 6. 禁止事项

- 不要泛泛建议“增加错误处理”“改善 UX”“重构代码”。
- 不要把单纯文件大当作问题。
- 不要在没有反例的情况下声称存在 race。
- 不要只审后端，忽略 TypeScript API、store、UI 和移动端。
- 不要只审桌面宽屏。
- 不要只看 happy path。
- 不要建议一次性重写整个系统，除非证明现有不变量无法局部修复。
- 不要把测试通过当作正确性证明；必须看测试是否覆盖关键反例。
- 不要把历史文档里的“已修复”当作当前代码事实；必须重新核对当前文件。
- 不要忽略“功能未接线”的问题：后端存在、前端无入口，或前端入口存在、后端命令未注册，都算真实缺陷。
- 不要把“用户可手动刷新/重启”当作恢复策略，除非 UI 明确告知并且数据不会丢。
- 不要输出只适用于桌面鼠标的修复建议；移动端必须有等价路径。

## 7. 推荐审阅批次

### Batch A: Cloud Sync SOTA Audit

输入：

- `docs/cloud-sync-remediation-plan.md`
- `src-tauri/src/data_governance/sync/*`
- `src-tauri/src/data_governance/commands_sync.rs`
- `src-tauri/src/data_governance/commands_backup.rs`
- `src-tauri/src/data_governance/commands_restore.rs`
- `src-tauri/src/cloud_storage/*`
- `src-tauri/tests/sync_*`
- `src/api/dataGovernance.ts`
- `src/features/settings/components/DataGovernanceDashboard.tsx`
- `src/components/SyncConflictDialog.tsx`

目标：

- 验证 INV-1 到 INV-7。
- 找游标、水位、隔离、冲突、墓碑、恢复、provider contract 的反例。
- 重点检查当前“单条隔离、批次继续”语义是否全链路一致。

### Batch B: Chat V2 + Frontend State Audit

输入：

- `docs/archive/chat-v2-critical-review.md`
- `src-tauri/src/chat_v2/*`
- `src/features/chat/*`
- `src/features/chat/adapters/TauriAdapter.ts`

目标：

- 找发送、停止、重试、编辑、删除、多变体、工具审批、崩溃恢复的状态机反例。
- 检查 event sequence、stream lock、operation lock、optimistic update、context snapshot。
- 同时审桌面和移动端聊天体验。

### Batch C: Mobile UX and Interaction Audit

输入：

- `src/components/layout/MobileSlidingLayout.tsx`
- `src/components/layout/MobileLayoutContext.tsx`
- `src/config/mobileLayout.ts`
- `src/config/zIndex.ts`
- `src/features/chat/components/input-bar/*`
- `src/components/ui/unified-sidebar/*`
- `src/features/learning-hub/*`
- `src/features/notes/*`
- `src/features/mindmap/*`
- `src/features/settings/components/*`
- `docs/CODE_STYLE.md`
- `docs/design-tokens-and-color-semantics.md`

目标：

- 审查小屏、触摸、软键盘、安全区、bottom sheet、手势冲突、z-index、portal、focus trap。
- 找关键工作流在移动端不可完成或状态不可理解的问题。
- 给出 Playwright/mobile viewport 验证清单。

### Batch D: VFS Indexing and Resource Consistency Audit

输入：

- `src-tauri/src/vfs/*`
- `src-tauri/src/vfs/repos/*`
- `src/features/learning-hub/*`
- `src/features/chat/context/*`
- `src/dstu/*`

目标：

- 找 SQLite/Lance/blob/index status 的双写不一致。
- 审查 resource import/delete/reindex/search/context injection。
- 检查前端是否展示真实 indexing 状态。

### Batch E: Learning Lifecycle and SSOT Audit

输入：

- `docs/reviews/vfs-learning-hub-chatv2-review-findings.md`
- `docs/design/learning-hub-core-contracts.md`
- `src-tauri/src/question_bank_service.rs`
- `src-tauri/src/vfs/repos/question_repo.rs`
- `src-tauri/src/vfs/repos/review_plan_repo.rs`
- `src-tauri/src/review_plan_service.rs`
- `src-tauri/src/chat_v2/tools/qbank_executor.rs`
- `src-tauri/src/chat_v2/vfs_resolver.rs`
- `src-tauri/src/vfs/ref_handlers.rs`
- `src/features/practice/*`
- `src/features/todo/*`
- `src/features/pomodoro/*`
- `src/features/learning-hub/*`

目标：

- 审查题库、复习计划、todo、pomodoro、Chat 引用和 Learning Hub 是否构成真实学习闭环。
- 找 `preview_json`/`questions`/stats/review_plan/history 的 SSOT 分裂。
- 找“后端功能无 UI 入口”“前端入口命令未注册”“死字段误导用户”的端到端断点。
- 覆盖移动端做题、复习、上传、引用和恢复路径。

### Batch F: Security, Accessibility, Performance Audit

输入：

- `ACCESSIBILITY-REVIEW.md`
- `docs/archive/SECURITY_AUDIT_REPORT_202602.md`
- `docs/design-tokens-and-color-semantics.md`
- `docs/CODE_STYLE.md`
- `PR-REVIEW-2026-06-11.md`
- `src-tauri/capabilities/*`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/secure_store.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/cloud_storage/*`
- `src/components/ui/*`
- `src/components/UnifiedNotification.tsx`
- `src/features/settings/components/*`
- `src/features/chat/components/renderers/*`
- `src/locales/*`

目标：

- 审查敏感信息、路径权限、Tauri capabilities、自定义协议、预览 sanitize、CI/release 供应链。
- 审查 keyboard/focus/ARIA/reduced-motion/contrast/i18n/hardcoded text。
- 找大文件、大列表、长会话、移动端低性能环境下的内存和渲染风险。

### Batch G: Artifact Generation and Integration Audit

输入：

- `src-tauri/src/enhanced_anki_service.rs`
- `src-tauri/src/streaming_anki_service.rs`
- `src-tauri/src/apkg_exporter_service.rs`
- `src-tauri/src/anki_connect_service.rs`
- `src-tauri/src/question_import_service.rs`
- `src-tauri/src/notes_exporter.rs`
- `src-tauri/src/question_export_service.rs`
- `src-tauri/src/essay_grading/*`
- `src-tauri/src/qbank_grading/*`
- `src-tauri/src/translation/*`
- `src-tauri/src/chat_v2/tools/chatanki_executor.rs`
- `src-tauri/src/chat_v2/tools/template_executor.rs`
- `src-tauri/src/chat_v2/tools/docx_executor.rs`
- `src-tauri/src/chat_v2/tools/pptx_executor.rs`
- `src-tauri/src/chat_v2/tools/xlsx_executor.rs`
- `src/components/anki/*`
- `src/features/template-management/*`
- `src/command-palette/*`
- `src/voice-input/*`
- `src/mcp/*`

目标：

- 审查制卡、模板、导入导出、翻译、作文批改、命令入口、语音输入、MCP 扩展表面是否形成可靠闭环。
- 找任务中断、坏结构化输出、模板渲染安全、大批量导出、移动端编辑与进度反馈问题。
- 检查这些入口是否绕过主业务链、权限、安全存储、同步状态或审计日志。

### Batch H: End-to-End User Experience Audit

输入：

- `src/App.tsx`
- `README_CN.md`
- `ACCESSIBILITY-REVIEW.md`
- `docs/CODE_STYLE.md`
- `docs/design-tokens-and-color-semantics.md`
- `src/components/layout/*`
- `src/components/UnifiedNotification.tsx`
- `src/components/ui/*`
- `src/features/chat/pages/ChatV2Page.tsx`
- `src/features/chat/components/*`
- `src/features/learning-hub/*`
- `src/features/notes/*`
- `src/features/mindmap/*`
- `src/features/practice/*`
- `src/features/settings/*`
- `src/features/template-management/*`
- `src/command-palette/*`
- `src/features/command-palette/*`
- `src/voice-input/*`
- `src/features/voice-input/*`
- `src/locales/*`

目标：

- 审查首次启动、空状态、导入资料、Chat 引用、学习产物生成、复习、同步、备份恢复的端到端体验。
- 找“用户被误导”的风险：错误成功提示、AI 上下文不透明、部分成功未说明、任务卡死却无提示、恢复后旧缓存继续显示。
- 检查桌面、平板、手机是否保留一致入口、状态文案、恢复动作和信息层级。
- 检查所有长任务是否有可信进度、取消/重试/恢复、后台状态可见性和重启后续接体验。
- 输出一份 friction map，并把每个摩擦点映射到具体文件、状态字段、文案或缺失测试。

## 8. Fable 使用提示词模板

```text
你是 SOTA 级系统审计员。请按 docs/FABLE_SOTA_GOAL.md 的要求审查本批文件。

本轮批次：[填写 Batch A/B/C/D/E/F/G/H]
重点问题：[填写本轮最关心的 3-5 个问题]

要求：
1. 先读取本批相关背景文档，并列出你认为本批代码必须满足的不变量。
2. 用反例驱动方式找 P0/P1 问题，必须说明事件顺序或用户操作序列。
3. 必须跨 Rust 后端、Tauri command、TypeScript API、React store、UI、移动端交互、使用体验检查契约。
4. 每个 finding 必须包含 Evidence、Counterexample、User Impact、Affected User Journey、Suggested Test、Current Diff Relevance。
5. 不要输出泛泛重构建议；没有可复现反例或明确证据的问题降级为 open question。
6. 对移动端必须覆盖软键盘、安全区、手势、bottom sheet、z-index、小屏遮挡、系统字体放大和横屏。
7. 对使用体验必须覆盖首次启动、空状态、长任务、部分成功、错误恢复、AI 上下文透明度、桌面/移动端连续性。
8. 对安全/隐私/a11y/i18n/性能如未覆盖，必须显式列为 open question。
9. 区分历史文档结论、当前代码事实和当前未提交 diff。
```

## 9. 成功标准

一次合格的 Fable 审阅应产出：

- 至少一组可执行的高风险反例，或者明确说明未发现 P0/P1 并给出覆盖依据。
- 一份跨层契约矩阵。
- 一份移动端交互问题清单。
- 一份使用体验/用户旅程 friction map，或者明确说明已覆盖的旅程和剩余 open questions。
- 一份安全/隐私/a11y/i18n/性能补充清单或明确 open questions。
- 一份最小测试计划。
- 一份按阶段排序的修复计划。
- 所有结论都能回指到具体文件、函数、状态字段或用户序列。

如果报告无法指导工程师写测试或修复，则视为不合格审阅。
