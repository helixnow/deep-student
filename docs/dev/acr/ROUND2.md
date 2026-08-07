# ACR 第二轮 — 10 个分区接线/调试/优化任务卡

> 输入：R1 全部产物 + 协调者验收报告（编译错误清单、返工项、各卡"遗留给 R2"与"跨界申请"）。
> 每卡职责：让本区**端到端真正跑通**——补接线、修联调 bug、消化 R1 跨界申请、按 SCENARIOS.md 本区场景自验（代码层面走查 + 单测补齐；运行时验证由协调者执行后回填问题）。
> 纪律同 STANDARDS.md（仍禁 cargo）。R2 写权按"区"划分，区内可改 R1 多个任务的名下文件，跨区仍需申请。

### R2-01 Rust 管线区
范围：workbench_bridge / workbench_executor / canvas_executor / builtin_resource_executor(mindmap 段) / qbank / user_todo / fsrs emit / pipeline 注册 / 超时表。
- 消化协调者编译清单中本区全部错误与 R1-04 的 OCC 遗留。
- 统一错误码表（WORKBENCH_UNAVAILABLE / WINDOW_BUSY / STRICT_MODE / TODO_CONFLICT / ...）写入 `docs/dev/acr/ERRORS.md`，三端（Rust/driver/工具卡）对齐。
- 取消传播全链核查：cancel → acr:bridge-cancel → StageManager.abort → partial 回执 → tool_loop 不再重试。
- 桥 progress 转发与 5Hz 节流实测语义核对；apply_ops 超时预算公式落地。

### R2-02 导图链路区
范围：mindmapDriver / mindmap register / mindmapStore 瞬态字段 / MindMapCanvas className 通道 / builtin_resource_executor 委托分支（与 R2-01 协商 Rust 侧改动）。
- SCENARIOS 导图组场景逐条代码走查：委托判定、逐 op 演出、视口跟随节流（每 3-5 op）、entering 动画、账本 revert、大纲视图同步。
- destructive+dirty 的 suggestion 策略定稿（R1-11 的 v1 拒绝式 → 评估是否升级为预览）。
- 单例 store 双导图窗场景的防御测试。

### R2-03 笔记链路区
范围：noteDriver / agentHighlight / CrepeEditor agentInsert / NoteContentView / NotesCrepeEditor / noteBinding / canvas_executor 委托（与 R2-01 协商）。
- 打字机全链：委托→分批→decoration 高亮→渐隐→autosave 落盘→OCC 不冲突；用户同时在他处打字的 position mapping 正确性（补单测：并发 insert 交错）。
- 建议模式全链：dirty+replace → canvas:ai-edit-request → AIDiffPanel → accept 落盘 / reject 回执。
- canvasNoteId 绑定与 note_read 省略 noteId 的场景核对；watch 兜底（笔记未打开→后端写→打开的 Finder/其他窗刷新）。

### R2-04 列表应用区
范围：todoDriver / finderDriver / fsrsDriver / qbankDriver / 对应视图守卫与 data-agent-entity / ankiCardsBlock 的 flashcards workaround 收编。
- 域事件→flash 全链核查（entityIds 从 Rust 到 DOM 属性命名一致）。
- 三守卫落实：todo 详情草稿、finder inlineEdit、qbank 答题中。
- fsrs appendToQueue 会话中场景 + ankiCardsBlock 改走 onActivation startReview（消除旧 workaround 双路径）。

### R2-05 chat 呈现区
范围：workbenchOpsBlock / toolCall remap / 工具卡与 presence 的 runId 联动 / 审批聚焦 / 会话恢复。
- 恢复语义：重启后 workbench_ops 块从 DB 恢复的渲染（若 R1-01 未解决 block_type 持久化，此处定稿方案）。
- High 审批前 focus chat 窗策略接线（tool_approval_request 到达时）。
- 工具卡步骤流（block.content 行协议)与 AcrReceipt 展示打磨；撤销按钮失效态（账本过期）处理。
- AgentTaskPanel 是否增列 workbench 操作条目：评估后实施或书面否决。

### R2-06 仲裁一致性区
范围：arbitration / stageManager / 各 driver 的 checkPaused 接入 / WindowShell 输入探测 / AgentStrip 按钮。
- 全 driver 暂停/续放/中止行为一致性矩阵测试；userPatch 生成（暂停期间用户改动摘要：各 driver 提供 diff 概述回调，缺省"用户进行了手动编辑"）。
- 租约互斥与 TTL 心跳实测；presence 泄漏（run 异常挂死）自愈核查。
- 输入探测误报治理：滚动/标题栏/AgentStrip 自身按钮不触发暂停。

### R2-07 性能区
范围：pacing / 演出调度检查点 / scheduler 接线（reportSchedulerActivity/requestWakePrefetch）/ perfMonitor 降级钩子。
- 按 DESIGN §7 预算逐项代码审计：禁每字符 dispatch、禁每 op fitView、progress ≤5Hz、演出窗 ≤2、background 直落终态。
- 自动降级阶梯实现核查（perfMonitor 连续帧>33ms → fast）。
- 评估是否引入 tauri ipc Channel 替代 apply_ops 单请求批量（仅评估 + 报告，不实施除非发现瓶颈）。
- 长文档/大导图（5k 节点）走查渲染路径，补 `onlyRenderVisibleElements` 等护栏确认。

### R2-08 权限与降级区
范围：feature flag / 设置面 / gates / probe disabled 分支 / legacy 降级 / i18n。
- 三档行为端到端定稿：off=工具全拒（含 list_windows？定稿：off 时 list/query 允许只读、写与导航拒绝——写入 ERRORS.md）；background=不抢焦点；follow=自动聚焦。
- OS 模式运行中关闭的中断处理（活跃 run → abort partial）。
- 全部用户可见错误消息过 i18n；`check:i18n` 全绿。

### R2-09 生命周期边界区
范围：跨区只读 + 定点修复权（发现问题先记录，小修直接做，大修派回对应区）。
- 按 DESIGN §6 + 生命周期调研 16 条边界清单逐条写防御测试或走查记录：frozen 唤醒、freezeImminent、最小化窗演出、关窗中断 run（closeWindow 时 abort）、快照恢复后 windowId 失效、chat 无 instanceKey 窗、资源被删（pruneSnapshot + resourceSync 关窗时 run abort）、多窗去重。
- 产出 `docs/dev/acr/progress/R2-09-edgecases.md` 逐条结论表。

### R2-10 浏览器与长尾区
范围：browser 闭环（R1-05 产物）/ pomodoroDriver / content onActivation / 命令面板与 WorkbenchEventBridge 兼容。
- browser ControlMode：agent 操作中用户接管→工具被拒→回执可行动；前端镜像与 Rust 权威一致性。
- pomodoro strictMode、投影开窗时序。
- 遗留跨界申请清算：R1 各卡"跨界申请"未被 R2-01~09 消化的在此收口。
