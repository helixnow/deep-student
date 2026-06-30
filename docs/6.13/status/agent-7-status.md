# 代理 7 状态文档（round 2）—— 平台基座与全局体验

> 第一轮上下文见 `docs/6.12/status/agent-7-status.md`（F1–F30 / O1–O9 / X1–X9）。
> 本组同时是 `commands.rs` / `lib.rs` / `App.tsx` / `locales` 共享文件一致性仲裁人。
> feed_id（本轮会话）= **F-HKY76**（mcp-feedback-enhanced）。

## 当前状态
**用户指示「全都干完」——P1/P2/P3 本域任务已全部处理完毕。**
- P1：F15 死组件删除、F12 本域僵尸命令清理（+跨域核对上报）已落地。
- P2：F29（视图级 ErrorBoundary 统一降级 UI）、F21（console 桥 dev-only+节流）、F22（dev StrictMode 可选开启+诚实化）、F8（Windows ACL 收紧，best-effort）已落地；F3（备份公共流程抽取）已落地；F4/F5 属数据安全高风险，按纪律出方案+登记（F5 另加意图注释），未擅自落地。
- P3：F24 本域大头——ModernSidebar 8 处真·硬编码已外化；SkillsManagementPage 经核对**已基本 i18n 化**（原计 54 处实为 t() 兜底默认值/注释/console，非硬编码）。
- 验证：typecheck ✅、check:i18n ✅、本组改动文件 eslint 0 error（main.tsx/ModernSidebar 既有 baseline 问题非本轮引入）、cargo check（见「验证状态」）。
最后更新：2026-06-13。

## 本轮已实施（R2-O 系列）

| # | 类型 | 改动文件 | 说明 | 验证 |
|---|------|----------|------|------|
| R2-O1 | F15 死代码 | 删 `src/components/Dashboard.tsx`；`src/lazyComponents.tsx` 移除 `LazyDashboard` 导出 | 旧仪表盘已被 `SOTADashboardLite` 取代，`LazyDashboard` 全仓零引用；后端 `get_statistics` 命令不存在（`settingsApi.getStatistics` 已于审查后删除，统计走 `get_enhanced_statistics`） | typecheck（见下） |
| R2-O2 | F12 僵尸命令(data_space) | `src-tauri/src/data_space.rs` 删 4 个未注册 `#[tauri::command]`：`get_slot_size` / `verify_slot_integrity`(命令) / `verify_all_slots_integrity` / `check_switch_disk_space`，并删其专用 DTO `SlotSizeInfo` | 4 命令在 `generate_handler!` 未注册、前端零 invoke；**保留** `SlotManager::verify_slot_integrity` / `slot_size` / `check_space_for_switch` 方法（测试与潜在内部调用仍用，且为 pub 不产生 dead_code 警告） | cargo check（见下） |
| R2-O3 | F12 僵尸命令(debug) | `src-tauri/src/debug_commands.rs` 删 3 个未注册命令 `debug_get_raw_mistake` / `debug_get_raw_mistakes_batch` / `debug_verify_mistake_integrity` 及其专用类型 `DebugRawMistakeRecord` / `DebugIntegrityReport` | 三命令操作已废弃的「错题」表、未注册、前端包装器（见 R2-O4）亦无 UI 调用；**保留** `DebugRawChatMessage`（仍被已注册的 `debug_get_database_stats` 使用）及 `log_debug_message` / `tauri_lab_frontend_log` / `debug_vfs_*` 等已注册命令 | cargo check（见下） |
| R2-O4 | F12 死前端包装 | 删整文件 `src/api/debugDatabase.ts` | 全仓无任何 import 该模块（函数与类型均无外部引用）；`debugGetRawMistake/Batch/VerifyMistakeIntegrity` 指向未注册命令，`debugGetDatabaseStats` 指向已注册命令但同样无 UI 调用 | typecheck（见下） |
| R2-O5 | 仓库卫生 | 删 `src-tauri/_tmp_check_cmds.cjs` | 第一轮遗留的临时命令扫描脚本（非编译产物、无引用），属垃圾文件 | n/a |
| R2-O6 | F29 视图级容错 | `components/ErrorBoundary.tsx`（fallback 回调新增 `reset` 形参 + `resetError`）；新增 `components/ViewErrorFallback.tsx`（统一全高降级 UI）；`app/components/ViewLayerRenderer.tsx` 每视图 ErrorBoundary 接入该 fallback | 每视图 ErrorBoundary 已存在（ViewLayerRenderer），本轮补「统一降级 UI + 可重试」。单视图崩溃不再打穿到 TopLevel | typecheck ✅ / eslint 新文件 0 |
| R2-O7 | F21 性能 | `main.tsx` tauri_lab 前端日志桥：生产构建跳过安装 + 相同消息 5s 去重节流 | 后端命令无 TAURI_LAB_* 环境时本就 no-op，消除 prod 每条 warn/error 的无谓 IPC | typecheck ✅ |
| R2-O8 | F22 坏味道 | `main.tsx` StrictMode：改为 dev 可经 `VITE_ENABLE_STRICT_MODE=true` 显式开启 + 诚实化注释（prod 包裹为 no-op，保留）；默认行为不变 | 原「仅 prod 启用」等于全程无诊断；现提供真正可用的 dev 诊断路径，默认关闭以免双执行噪声冲击全员 | typecheck ✅ |
| R2-O9 | F8 安全 | `secure_store.rs` + `crypto/mod.rs`：Windows 下 best-effort `icacls` 收紧 `.secure`/`.master_key` 为 owner+SYSTEM+Administrators（well-known SID，移除继承），失败仅告警 | 等价 Unix 0600/0700；完全 fail-safe：失败即维持现状（绝不锁死 owner 的密钥）；无新依赖 | cargo check（见下） |
| R2-O10 | F3 重构 | `data_governance/backup/mod.rs`：抽 `backup_core()`，`backup_full`/`backup_with_assets` 复用（逐字搬移、语义不变）；`backup_tiered` 结构不同，未并入 | 消除两入口 ~70 行逐字重复 | cargo check（见下） |
| R2-O11 | F5 文档 | `data_governance/commands_asset.rs`：在 `restore_with_assets_to_dir` 调用处补意图注释（密钥全局、刻意不在此恢复，跨设备走主路径） | 澄清安全意图，防后续误改引入 F2 式数据丢失 | cargo check（见下） |
| R2-O12 | F24 i18n | `components/ModernSidebar.tsx` 外化 8 处硬编码（置顶/归档 aria、重命名菜单/对话框/取消/确认）；`locales/{zh-CN,en-US}/sidebar.json` 新增 `aria.*`/`actions.rename_session`/`rename.*` 键；取消/确认复用 `common:cancel`/`common:confirm` | check:i18n ✅；typecheck ✅ |

## F12 僵尸命令——逐项核对结论（重要：原清单含误报）

原 agent-7.md / F12 列出的「24 僵尸命令」经逐个核对，**并非都可由本组直接删**，纠正如下：

| 命令 | 原归类 | 核对结论 | 处置 |
|------|--------|----------|------|
| `get_slot_size` / `verify_slot_integrity`(cmd) / `verify_all_slots_integrity` / `check_switch_disk_space` | data_space 4 | ✅ 真僵尸（未注册+前端零调用），本域 | **已删**(R2-O2) |
| `debug_get_raw_mistake` / `debug_get_raw_mistakes_batch` / `debug_verify_mistake_integrity` | debug 3 | ⚠️ 前端 `api/debugDatabase.ts` **有** invoke 包装（但包装器本身无 UI 调用，整链死）；操作已废弃错题表 | **已删** Rust+前端(R2-O3/O4) |
| `check_anki_connect_availability` | 误报 | ❌ **非僵尸**：是 `anki_connect_service.rs` 的内部函数，被 chatanki_executor/cmd/anki_connect 多处调用；anki 域属**代理 5** | 不删，上报代理 5（仅核对结论） |
| `resource_get_content_from_vfs` | 跨域 | `chat_v2/handlers/resource_handlers.rs`，属**代理 1**（chat_v2） | 上报代理 1 |
| `test_rmcp_streamable_http` | 跨域 | `cmd/mcp.rs` + `mcp/rmcp.rs`，被 `cmd/mcp.rs:486` 内部调用；MCP 属**代理 1** | 上报代理 1（注意内部有调用，非纯死） |
| `test_web_search_connectivity` | 误报/半接线 | ❌ 前端 `src/utils/settingsApi.ts:260` **有** invoke 调用；命令在 `cmd/web_search.rs` 已实现但**未注册** → 若该前端路径可达则是 F13 式「调用未注册命令」运行时 bug；web_search 属**代理 1** | 上报代理 1（需判定：注册 or 删前端调用） |
| `research_list_reports` / `research_get_report` / `research_delete_report` / `research_export_all_reports_zip` | research 4 | 前端 `src/utils/chatApi.ts:335-351` 有包装（X6 称包装器无人调用）；命令在 `commands.rs` 已实现未注册；research/chat 属**代理 1** | **上报代理 1**（虽在 commands.rs 仲裁域，但功能取舍属代理 1，未擅删） |
| `textbooks_*`(9) | data 域 | 属**代理 2/3**（agent-7.md 已注明代理 2 处理） | 上报代理 2/3 |

> 结论：本组可直接删的 data_space(4)+debug(3) 已删；其余多为**跨域**或**误报**或**「调用未注册命令」的半接线 bug**，按纪律未越域改动，集中上报对应代理（见「跨组问题」）。

## 跨组问题（本组牵头核对 X1–X9 + F12 反向 invoke，需对应代理处理）
沿用第一轮 X1–X9（见 `docs/6.12/status/agent-7-status.md`），本轮补充/复核：

| # | 涉及 | 结论 | 建议归属 |
|---|------|------|----------|
| X-A | `cmd/web_search.rs::test_web_search_connectivity` 未注册，但 `settingsApi.ts:260` 在 invoke | 半接线：注册或删前端调用，二选一 | 1 |
| X-B | `commands.rs` research 4 命令未注册，`chatApi.ts` 包装无 UI 调用 | 删 Rust 命令+前端包装，或补注册（取决于产品是否保留调研报告） | 1 |
| X-C | `chat_v2/handlers/resource_handlers.rs::resource_get_content_from_vfs` 未注册 | 确认可达性后删或注册 | 1 |
| X-D | `cmd/mcp.rs::test_rmcp_streamable_http` 未注册（内部有调用，非命令面僵尸可直接删，但 `#[tauri::command]` 包装可去） | 评估后处理 | 1 |
| X-E | `anki_connect_service.rs::check_anki_connect_availability` 原列僵尸属**误报**（内部活跃使用） | 无需删；如曾标 `#[tauri::command]` 可考虑去注解 | 5 |
| X1–X9 | 见第一轮文档（chat_v2_send / generate_anki_cards_for_segment / get_document_state / unified_* / get_statistics / resource_* / textbooks_* / vfs_update_resource_hash） | 死前端包装在各域文件，按纪律不越域改 | 1/2/5/6 |

## 已完成（本轮全部）

### P2 — 健壮性 / 性能（已落地）
- [x] **F21** tauri_lab 桥 dev-only + 5s 去重节流（R2-O7）。
- [x] **F22** dev StrictMode 经 `VITE_ENABLE_STRICT_MODE` 可选开启 + 诚实化注释（R2-O8）。
- [x] **F29** 每视图 ErrorBoundary 已接入统一降级 UI `ViewErrorFallback` + 可重试（R2-O6）。
- [x] **F8** Windows `.master_key`/`.secure` best-effort ACL 收紧（R2-O9）。

### P2 — 备份（F3 已落地；F4/F5 高风险，出方案+登记）
- [x] **F3** 抽 `backup_core()` 复用（R2-O10）。
- [ ] **F4（出方案，未落地）** lance 备份一致性。
  - 现状：`lance/` 作 Rebuildable tier 按普通目录复制；备份期 LanceDB 若并发写入 → 快照可能不一致（恢复后 `IndexMaintenance` 可重建兜底）。
  - 方案：真一致性需在备份期 **quiesce LanceDB 写入**（或对 `.lance` 做一致快照），这属 **VFS/向量域（代理 2）** 的写入协调能力，跨域；本组备份侧只负责拷贝。
  - 建议：①（代理 2）在备份窗口暴露「向量写入静默/快照」钩子，备份前调用；或 ② 维持现状并在恢复后强制触发 lance 重建（当前已可手动重建）。**待用户在 ①/② 间拍板**；本组不擅自改 lance 写入路径。
- [ ] **F5（出方案+已加意图注释，未改逻辑）** `data_governance_restore_with_assets` 不恢复密钥。
  - 现状：该命令恢复到**非活跃插槽**，刻意不恢复全局密钥（密钥在 app_data_dir，非插槽内）；前端 UI 未用此命令（走主路径 `data_governance_restore`）。
  - 风险：若在此恢复密钥，会**立即作用于活跃插槽**解密，且需主路径同款 `.pre_restore` 快照+回滚（F2）保护，否则跨设备恢复失败将永久丢失旧密文。
  - 方案：若要让本命令支持跨设备，须移植 `commands_restore.rs` 的密钥快照/回滚机制并仅在「插槽切换生效后」应用密钥——工程量与风险与主路径相当。**鉴于 UI 未使用，建议维持现状（已加注释澄清）**，或由用户确认后按上法补齐。

### P3 — i18n（已完成本域大头 + 纠正口径）
- [x] **F24** ModernSidebar 8 处真·硬编码已外化（R2-O12）。
- 口径纠正：原计 `ModernSidebar(47)/SkillsManagementPage(54)` 经核对**含大量 `t('key','中文')` 兜底默认值、注释、console 文案**——这些非「硬编码 UI 文案」。ModernSidebar 真·硬编码仅 ~8 处（已清）；SkillsManagementPage 用户可见文案**已全部走 t()**，无需改动。
- 全仓 2464 处同理大概率虚高（应剔除 t() 兜底/注释/日志后再统计）。**全仓协同方案建议**：先用「Chinese 字符 ∧ 不在 `t(` 调用 ∧ 不在注释/console」的精确规则重新扫描出真·硬编码清单，再按域分配；勿按裸 Chinese 计数派活。

## 二轮深审发现（D 系列，针对第一轮仅抽查/快审区）

| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|-----------|------|--------|------|------|
| D1 | `backup_job_manager.rs::cleanup_completed_jobs`（Phase 3 超时分支） | bug | 中 | 运行超过 `max_duration`(默认 4h) 的任务被 `mark_failure` 标记为失败，但**未置 cancel_flag**——底层协作式取消的执行体不会中止，继续在后台消耗资源直到自然结束；其后 `complete()` 因状态机已终态被静默丢弃（任务实际完成了却显示失败） | **已修复**：超时分支先 `request_cancel(job_id)` 再 `mark_failure`，让执行体在下个 `check_continue()` 尽快中止（R2-O13） |
| D2 | `anr_watchdog.rs` + `lib.rs:316` 心跳驱动 | 健壮性 | 中 | ANR 看门狗文档称检测「主线程/后端线程阻塞」，但心跳由 **Tokio async task** 驱动（`tauri::async_runtime::spawn` + `interval`），跑在 Tokio worker 池上——只要池里有**任意**空闲 worker 心跳就照常，故实际只能检出**整个 Tokio 运行时饿死**，检不出主线程(事件循环)卡顿，也检不出单个被阻塞的 task | 登记（观测性，未擅改）。建议：心跳改用 `app_handle.run_on_main_thread(\|\| anr_watchdog::heartbeat())` 投递到主线程执行——主线程卡住时闭包排不进队 → 心跳变陈旧 → 真正检出主线程 ANR。属遥测行为变更，未在目标平台实测前不擅自改，待确认 |
| D3 | `data_governance/sync/conflict_resolver.rs::with_tolerance` | 死代码 | 低 | `with_tolerance(self, secs)` 全仓零调用，且方法体 `let _ = secs; self` 是**静默 no-op**（名字暗示设置时间容差但什么都不做） | **已删**（R2-O14，pub 死方法，无调用方） |
| D4 | 复审：pomodoro store / GlobalPomodoroWidget / crash_logger / todo 回收站 / commands_backup | 信息 | 信息 | 上述近期/抽查区复审：番茄钟墙钟计时与每日目标阈值逻辑、tick 定时器清理、崩溃 hook 链式调用+catch_unwind+PII 脱敏+日志数量上限、todo 回收站 restore 正确 reload、备份任务状态机单调性与防锁中毒——**均健康，无新问题** | 无需处理 |

> 备注（跨域，上报）：`vfs/repos/pomodoro_repo.rs:6` `unused import: Connection`（baseline 警告，属代理 2 的 VFS 数据层文件，未越域改）。

### 本轮新增改动（接 R2-O 系列）
| # | 类型 | 文件 | 说明 | 验证 |
|---|------|------|------|------|
| R2-O13 | D1 bug 修复 | `backup_job_manager.rs` | 超时任务先 `request_cancel` 再 `mark_failure` | cargo check（见下） |
| R2-O14 | D3 死代码 | `data_governance/sync/conflict_resolver.rs` | 删 `with_tolerance` 死 no-op 方法 | cargo check（见下） |

## 验证状态（本轮收尾，全绿）
- `npm run typecheck`：**exit 0**（含 F15/F12/F29/F21/F22/F24 全部前端改动）。
- `npm run check:i18n`：**exit 0**（sidebar.json 新增键 zh-CN/en-US 对齐）。
- `eslint`（本组改动文件）：新文件 `ViewErrorFallback.tsx`、`ErrorBoundary.tsx`、`ViewLayerRenderer.tsx`、`lazyComponents.tsx` **0 问题**；`main.tsx`/`ModernSidebar.tsx` 报出的 no-empty/no-native-button/no-restricted-syntax/no-console 均为**既有 baseline**（非本轮引入，行号因新增行位移）。
- `cargo check`（src-tauri，Windows 本机，含 `#[cfg(windows)]` F8 代码）：**exit 0**。本组改动文件（data_space.rs / debug_commands.rs / backup/mod.rs / crypto/mod.rs / secure_store.rs / commands_asset.rs）**零新增 warning**；输出中的 unused-import 警告（crypto/tests.rs、commands_asset.rs、commands_backup.rs、commands_restore.rs）首检即在，属 baseline。
- 备注：早前一次基线 `cargo check` 曾因**代理 4** `question_import_service.rs` 的 `QuestionImportProgress` 缺 `partial` 字段报 6×E0063，已在其后续提交中修复；本轮最终复检 exit 0。
- ⚠️ 多代理并发改 Rust，warning 总数随他组改动在 94–100 间浮动；本组以「本组文件零新增 error/warning」为达标口径，已满足。

## 共享文件改动登记（本轮）
| # | 文件 | 段落 | 原因 |
|---|------|------|------|
| RS1 | `src/lazyComponents.tsx` | 移除 `LazyDashboard` 懒加载导出（+注释说明） | F15 死组件清理（应用壳，本域） |
| RS2 | `src-tauri/src/data_space.rs` | 删 `SlotSizeInfo` + 4 僵尸 `#[tauri::command]`（与他组 F13 purge 改动不在同一段落，无冲突） | F12（数据空间/数据治理，本域） |
| RS3 | `src/main.tsx`（**共享文件**） | tauri_lab 桥 dev-only+节流（F21）；StrictMode dev 可选开启+注释（F22）——均为应用壳启动段落 | F21/F22（应用壳，本域） |
| RS4 | `src/locales/zh-CN/sidebar.json` + `src/locales/en-US/sidebar.json`（**共享文件**） | `aria.{pin,unpin,archive,confirm_archive}_session`、`actions.rename_session`、`rename.{title,label}` 新增键（两语言对齐） | F24（sidebar 文案属本域） |

> 注：`commands.rs` / `lib.rs` / `App.tsx` / `models.rs` 本轮**未改**（research 命令未越域删除；data_space/debug 删的是 .rs 内定义，`generate_handler!` 本就未注册它们；F29 经 `app/components/ViewLayerRenderer.tsx`+`components/ErrorBoundary.tsx` 落地，未动 App.tsx 主体）。

## 接力须知
- feed_id=F-HKY76。P1 本域清理已落地，等 typecheck/cargo 复检结果 + 用户对 P2/P3 与跨域上报项的指示。
- 严禁回退收尾会话已完成项（F7/F9/F13/F16/F26）。
- 未经用户明确要求不得 git commit/push；不使用子代理。

## 审查后补丁（2026-06-13，feed F-XNMJT 三轮审查）

| # | 说明 |
|---|------|
| AR-1 | `settingsApi.getStatistics` 删除；`getEnhancedStatistics` 失败不再 fallback 到死命令 |
| AR-2 | sync.json `notifications.*` 三键补全 + 删除已废弃 `resource_sync_*` 错误文案键 |
| AR-3 | 错题 save stub（`updateMistake`/`runtimeAutosaveCommit`）从 `chatApi.ts` 迁至 `testApi.ts`（dev 专用） |
| AR-4 | `EssayGradingWorkbench` Ctrl+Enter / `LEARNING_GRADE_ESSAY` 改 `useEventRegistry` |
| AR-5 | `style-lab/scan-data.json` 移除已删 `saveRequestHandler`/`DocumentViewer` 引用 |
| AR-6 | 注：`templateService.getStatistics()` 为**本地模板统计**，不 invoke 后端（docs/6.12 X5 误报） |
| AR-7 | 建议 amend 未 push 的 `d0c27d1` commit message 为 `refactor(round2): dead-code cleanup, security fixes, agent docs` |
