# ACR 终验报告（ACCEPTANCE）

> 任务：R3-05 + 协调者回填。日期：2026-07-10。分支：`nightly`（未提交）。  
> 依据：`DESIGN.md`（含 §8 实现偏差）、`STANDARDS.md`、`ERRORS.md`、`SCENARIOS.md`、`progress/R1-*` / `R2-*` / `R3-*` / `R*-ACCEPTANCE`。  
> 勾验以代码走查 + 已落盘单测/进度报告为证据。**运行时 tauri 冒烟与 DevPanel 采样仍待本机执行。**

## 结论

| 维度 | 状态 |
|------|------|
| 设计勘误 | `DESIGN.md` §8 已落盘 |
| 错误码 / 场景终版 | `ERRORS.md` / `SCENARIOS.md` 已对齐 |
| SOTA 五组勾验 | 见下；代码侧基本齐；运行时项标待冒烟 |
| 遗留分级 | 见 §6；**无代码侧 P0**；5 条 XAPP/会话切换运行时 BLOCKED |
| 协调者编译/单测门禁 | **已填**（见 §7）；tauri 冒烟仍待 |

---

## 1. SOTA 五组逐条勾验

图例：`[x]` 代码+单测证据充分 · `[~]` 部分完成 / 待姐妹卡 · `[ ]` 未验 · `N/A` 明确否决或非目标。

### A. 功能完备

| # | 条目 | 勾 | 证据 |
|---|------|----|------|
| A1 | 5 个 workbench_* 导航工具可用 | [x] | skill `workbench-tools.ts`；Rust `workbench_executor`；场景 S-APP-CHAT-01/02；`gates.test.ts` |
| A2 | 域写入可 probe→前端委托或后端回落 | [x] | canvas/mindmap 委托（R1-03/05、R2-01/03）；S-APP-NOTE-02/03、S-APP-MM-02/03 |
| A3 | 8 应用可操控（note/mm/todo/files/fc/exam/pomo/browser） | [x] | drivers + onActivation；S-APP-*；R2-10 focusQuestion/ControlMode |
| A4 | 跨应用编排（≥3 工具链） | [~] | R3-01：组件级 PASS；S-XAPP-01..04 **运行时 BLOCKED**（需 OS 模式冒烟） |
| A5 | 三平面路由 closed/clean/dirty/hot/frozen/disabled | [x] | `probe.ts` + DESIGN §8；S-DEG-*；`probe.test.ts` |
| A6 | 建议模式（笔记 AIDiff / 导图拒绝式） | [x] | R2-03 AIDiff；R2-02 否决预览；S-SUG-01..03 |
| A7 | 撤销（工具卡 / Strip / LRU20） | [x] | R3-01 修 S-REV-01/02（域工具 remap + Strip 4s）；S-REV-03 LRU；R2-05 undoExpired |
| A8 | 双闸 + 三档 control | [x] | R2-08 / ERRORS.md；`gates.test.ts`；S-DEG-02 |
| A9 | 域事件 entityIds → flash | [x] | R2-04 `domainEvents`；S-APP-TODO-02 / FC-02 / EXAM-01 |
| A10 | workbench_ops 持久化与恢复 | [x] | R2-05 block_type + remap；`workbenchBlockRemap.test.ts` |

### B. 交互质量

| # | 条目 | 勾 | 证据 |
|---|------|----|------|
| B1 | 语义聚光灯（光环 / Strip / flash / AI 光标） | [x] | R1-10 visuals；WindowShell；agentHighlight；S-APP-NOTE-02 |
| B2 | 不做假鼠标 | [x] | DESIGN §0.3 裁决落地 |
| B3 | 暂停 / 续放 / 停止 + partial | [x] | R2-06 仲裁矩阵；S-ARB-01/02；`arbitrationConsistency.r2-06.test.ts` |
| B4 | 输入误报过滤（滚轮/标题栏/Strip） | [x] | `inputProbe.ts`；R2-06 |
| B5 | pacing 三档 + reduced-motion→fast | [x] | R3-03 时序表；列表 150/300；`pacing.spec.ts`；S-PERF-04 |
| B6 | 双语文案（工具卡/Strip/错误/设置） | [x] | R3-03 终审；`check:i18n` PASS；`agent.core.*` / `agent.errors.*` |
| B7 | a11y：Strip 键盘 / aria-live 通告 / 非纯色区分 | [x] | R3-03：`announceWorkbench`；实线/虚线+圆/方点；forced-colors |
| B8 | HAX 对照 G1/G2/G7/G8/G9/G10/G11 | [x] | `progress/R3-03.md` HAX 证据表 |

### C. 性能（对照 DESIGN §7）

| # | 条目 | 勾 | 证据 |
|---|------|----|------|
| C1 | 词级打字机 8–40 / 禁每字符 dispatch | [x] | R2-07 审计；noteDriver；`noteDriver.test.ts` |
| C2 | 导图禁每 op fitView；节流跟随 | [x] | R2-02/07；`mindmapDriver.test.ts` |
| C3 | progress ≤5Hz；单消息 <8KB（设计） | [x] | `bridge.emitAcrProgress` 200ms；载荷体积 **待 DevPanel 采样**（`PERF-REPORT.md`） |
| C4 | 同时演出 ≤2（超限直落） | [x] | R2-07 `applyStagingGates`；S-PERF-01；`stageManager.test.ts` |
| C5 | background / minimized 直落 | [x] | R2-09 `shouldInstantDrop`；S-PERF-03 |
| C6 | 慢帧→fast | [x] | `perfMonitor.advanceSlowFrameStreak`；R2-07 |
| C7 | p75 INP≤200ms；掉帧<5%；60fps 光环 | [~] | `PERF-REPORT.md` 审计 PASS；**运行时 fps/INP 待协调者采样** |
| C8 | Channel 升级 | N/A | R2-07 / R3-02 仍否决；触发条件见 PERF-REPORT §5 |

### D. 稳健性

| # | 条目 | 勾 | 证据 |
|---|------|----|------|
| D1 | 取消→partial/cancelled + 不回落后端 | [x] | R2-01；S-CAN-01/02；`parallel_exec_tests`（禁 cargo 未跑） |
| D2 | WINDOW_BUSY 租约互斥 | [x] | stageManager；S-ARB-03；仲裁单测 |
| D3 | presence TTL 自愈 / disposeAllDrivers | [x] | R2-06 |
| D4 | 关窗/删资源 abort run | [x] | R2-09；`lifecycleEdgecases.test.ts` |
| D5 | frozen follow 唤醒 / background 回落 | [x] | R2-09-edgecases #1；S-DEG-03 |
| D6 | 取消×完成竞态 / 桥超时 / driver 抛错收敛 | [x] | R3-04 `chaosRobustness.r3-04.test.ts`（含 ×1000）；apply 异常→failed |
| D7 | 幂等（todo/闪卡重放不双写） | [x] | R3-04：appendToQueue / todo 导航 / revert 两次；create_item 无幂等键=P1 |
| D8 | doom-loop：明确错误码 + 瞬态重试排除 | [x] | ERRORS.md；R2-01 tool_loop 排除 ACR 码 |
| D9 | 账本 LRU / 重启不续跑 | [x] | DESIGN §6；S-REV-03；R2-05 |

### E. 安全

| # | 条目 | 勾 | 证据 |
|---|------|----|------|
| E1 | High 工具审批（close_window） | [x] | 敏感度 High；S-APP-CHAT-02；R2-05 审批前 focus chat |
| E2 | 破坏性笔记 dirty→建议非静默覆盖 | [x] | S-SUG-01/02；R2-03 |
| E3 | agent 写不进用户 undo | [x] | skipHistory / addToHistory:false；S-APP-NOTE-02 |
| E4 | browser 密码 BLOCKED→take_over | [x] | R1-05 / R2-10 ControlMode |
| E5 | 注入防御（笔记/网页指令不进高危参数） | [x] | R3-04 走查表；内容进 context 分区；前端笔记正文未 escape=P1 |
| E6 | fail-closed 闸门 | [x] | flag 硬闸 + setting off；S-DEG-01/02 |
| E7 | OCC 冲突可行动（TODO/QBANK） | [~] | questions 路径 OK；**preview_json 无 OCC = P1** |

---

## 2. SCENARIOS 覆盖与判定（R3-01 回填）

全库 **44** 条主表 + 3 交叉。详见 `progress/R3-01.md`。

| 判定 | 条数 |
|------|------|
| PASS | **39**（含交叉结构/单测） |
| FAIL→已修 | **3**（S-SUG-04 / S-REV-01 / S-REV-02） |
| BLOCKED（运行时） | **5**（S-XAPP-01..04 + 会话切换 UI） |

协调者运行时抽 10 条（ROUND3）：`S-APP-NOTE-02`、`S-APP-MM-02`、`S-ARB-01`、`S-DEG-02`、`S-SUG-01`、`S-XAPP-01`、`S-CAN-01`、`S-REV-01`、`S-PERF-01`、`S-DEG-01` → **待本机 `tauri dev` 冒烟回填**。

---

## 3. 单测与报告证据索引

| 来源 | 路径 / 说明 |
|------|-------------|
| R1 验收 | `progress/R1-ACCEPTANCE.md`（agent 110 passed @当时） |
| R2 验收 | `progress/R2-ACCEPTANCE.md`（agent **177 passed / 22 files**） |
| R3 验收 | `progress/R3-ACCEPTANCE.md`（agent **196 passed / 24 files**；typecheck/cargo/i18n PASS） |
| 核心仲裁 | `arbitrationConsistency.r2-06.test.ts`、`lifecycleEdgecases.test.ts`、`gates.test.ts` |
| 混沌 | `chaosRobustness.r3-04.test.ts` |
| 交叉 | `crossScenarios.r3-01.test.ts` |
| Drivers | `mindmapDriver` / `noteDriver` / `todoFinder` / `fsrsQbank` / `pomodoroDriver` |
| chat 卡 | `WorkbenchOpsBlock` / `approval` / `workbenchBlockRemap` |
| browser | `controlModeSync.test.ts`、`sessionStore.takeOver.test.ts` |
| 性能审计 | `PERF-REPORT.md`；`progress/R3-02.md` |
| HAX / a11y | `progress/R3-03.md` |
| 边界表 | `progress/R2-09-edgecases.md` |
| 错误码 | `ERRORS.md` |
| 设计偏差 | `DESIGN.md` §8 |

---

## 4. 姐妹卡回填状态

| 卡 | 回填内容 | 状态 |
|----|----------|------|
| R3-01 | 44 场景 PASS/FAIL/BLOCKED + 交叉 | **已回填** → §2 |
| R3-02 | `PERF-REPORT.md` + §7 审计 + Channel 否决 | **已回填** → §1.C；运行时采样仍待 |
| R3-03 | 文案/a11y/HAX | **已回填** → §1.B |
| R3-04 | 混沌×1000 / 幂等 / 注入 | **已回填** → §1.D/E |
| 协调者 | cargo / typecheck / agent vitest / i18n | **已填** §7；全量 vitest/lint/tauri 仍待 |

---

## 5. Progress 索引

### R0 / R1

| ID | 报告 | 状态 |
|----|------|------|
| R0.5 | `progress/R0.5.md` | 脚手架完成 |
| R1-01..20 | `progress/R1-01.md` … `R1-20.md` | 完成（部分协调者回填） |
| R1 统一验收 | `progress/R1-ACCEPTANCE.md` | 通过 → R2 |

### R2

| ID | 报告 | 状态 |
|----|------|------|
| R2-01..10 | `progress/R2-01.md` … `R2-10.md` | 完成 |
| R2-09 边界 | `progress/R2-09-edgecases.md` | 16 条结论表 |
| R2 统一验收 | `progress/R2-ACCEPTANCE.md` | 通过 → R3 |

### R3

| ID | 报告 | 状态 |
|----|------|------|
| R3-01 | `progress/R3-01.md` | 完成（39/3/5） |
| R3-02 | `progress/R3-02.md` + `PERF-REPORT.md` | 完成（运行时待采样） |
| R3-03 | `progress/R3-03.md` | 完成 |
| R3-04 | `progress/R3-04.md` | 完成 |
| R3-05 | `progress/R3-05.md` | 完成（文档） |
| R3 统一验收 | `progress/R3-ACCEPTANCE.md` | 编译/单测通过；冒烟待 |

---

## 6. 遗留分级

### P0（必修 — 阻断宣布落地）

| 项 | 说明 | 归属 |
|----|------|------|
| （空） | 代码侧无 P0；若冒烟出现双写/静默成功/闸门失效则升 P0 | 协调者冒烟 |
| 运行时抽 10 场景 + DevPanel | 宣布「落地完成」前必做 | 协调者 §7 |

### P1（可后补）

| 项 | 说明 | 来源 |
|----|------|------|
| preview_json qbank 无 OCC | 双轨无 `updated_at` | R2-01 |
| 域事件 source `ai`→`agent` 全量 emit | 前端已双认 | R2-01 / R1-04 |
| 用户侧 todo_handlers 补 emit | create 等可能不刷列表 | R1-04 |
| `ACR_ERROR_CODES` 补 CONFLICT/CANCELLED/UNSUPPORTED | types 冻结子集 | ERRORS |
| 真实 driver 细粒度 userPatch | 现为 typeId 静态文案 | R2-06 |
| ~~finder `reveal` 不进父目录~~ | **勘误（2026-07-19，ACR 4.0 A6）**：已实现——`filesActivation.reveal` 走 `getResourceLocation` + `enterFolder` 自动进入父目录并选中/flash；目标行不在可视区时回执 message 注明未定位 | R2-04 / R3-01 |
| 前端笔记正文 `escapeXmlContent` | R3-04 注入走查 | R3-04 |
| `user_todo_create_item` 幂等键 | 重放可造重复 | R3-04 |
| S-XAPP-01..04 运行时冒烟 | 组件通、端到端未验 | R3-01 |

### P2（建议）

| 项 | 说明 | 来源 |
|----|------|------|
| translation/essay 真标题锚点 | 需编辑器 API | R2-10 |
| 导图 suggestion 真·树 diff 预览 | R2-02 否决升级 | R2-02 |
| Channel 流式 apply_ops | 仅当 IPC 成瓶颈 | R2-07 / R3-02 |
| `AcrReceipt` Rust 强类型 | 仍 Value | R2-01 |
| chatanki/fsrs cmd 侧 runId | 无 ExecutionContext | R2-01 |
| browser claim 清接管闩锁产品策略 | R1-05 遗留 | R2-10 |
| 笔记 Crepe 全文虚拟化 | 靠批+直落控压 | R2-07 |
| chat null-key 快照恢复产品决策 | R2-09 #6 | R2-09 |

---

## 7. 协调者终验命令

### 7.1 本轮生命周期整改（2026-07-10）

本轮在既有 R1–R3 验收后继续审阅 ACR 全生命周期，并完成以下代码侧整改：

- Rust 桥调用增加 drop-cancel 保护与执行器超时下限，外层取消不再漏发 `acr:bridge-cancel`。
- AgentBridge 改为 App 根全局挂载，并按实际 `workbenchActive` 有序启停；桌面关闭或小屏时不再因桥未挂载等待 3–15 秒超时。
- StageManager 停止时保留旧 run 身份与窗口租约直至 apply 结算，并以 15 秒 orphan deadline 有界排空；inactive 写/导航立即返回 `WORKBENCH_DISABLED`。
- 域事件订阅支持 stop/start 后重新建立；receipt summary 有实际生产者，并拒绝重复 run/correlation 覆盖终态。
- Driver/ledger 仅记录真实可逆操作：FSRS 不再制造空逆操作，QBank 恢复旧题目，Pomodoro 仅暴露可逆前缀；取消不再过早封账。
- 失败 receipt 不再把 presence 标为 done；`close_window` 先完成 `canClose`，background 命令不抢焦点，资源缺失不再打开空壳窗口。
- Chat 工具卡区分不可撤销、部分撤销可重试、账本耗尽与恢复块过期；恢复标记改为有界 blockId LRU，避免对象身份失效。
- Feature flag 仅在键缺失时默认 Enabled；已持久化的显式 Disabled 保持关闭。

### 7.2 本轮定向验证

| 验证 | 结果 |
|------|------|
| StageManager / gates / lifecycle / chaos 定向套件 | **44/44 PASS** |
| Chat 工具卡与恢复映射定向套件 | **21/21 PASS**（3 files） |
| 最终 ACR + Chat 合并回归 | **257/257 PASS**（31 files；使用 `--no-file-parallelism`） |
| `npm run typecheck` | **PASS** |
| `npm run check:i18n` | **PASS**（exit 0；i18n 键完整，仍报告仓库既有硬编码中文） |
| `git diff --check` | **PASS** |
| Rust 定向测试 | **未完成**：共享 Cargo build directory 锁阻塞；未终止其他任务的 Cargo/rustc 进程 |
| Tauri runtime 10 场景冒烟 | **未执行** |
| DevPanel / PERF 运行时采样 | **未执行** |

> 说明：最终前端合并回归、typecheck、i18n 检查与 diff 检查均已通过。仅 Rust 定向测试因共享 Cargo 锁未完成，Tauri runtime 冒烟与 DevPanel/PERF 运行时采样尚未执行；本文不宣称这些未执行项通过。

### 7.3 历史协调者门禁记录

| 命令 | 结果 |
|------|------|
| `cargo check -p deep-student --lib`（cwd=`src-tauri`） | **PASS**（100 既有 warning，无 error）@2026-07-10 |
| clippy（若配置） | 未跑（非阻断） |
| `npm run typecheck` | **PASS** |
| `npm run lint` | 未跑全量（非本轮强制） |
| `npx vitest run src/features/workbench/agent/__tests__` | **196 passed / 24 files**（R3 历史基线；本轮新增验证见 §7.2） |
| `npx vitest run`（全仓） | 未跑（建议后续） |
| `npm run check:i18n` | **PASS**（键/ns 一致；存量硬编码统计非阻断） |
| `npm run tauri dev` 抽 10 场景冒烟 | **未执行** |
| DevPanel 对照 PERF-REPORT 抽验 | **未执行**（步骤见 `PERF-REPORT.md` §2） |

**代码侧宣布条件**：上表编译/typecheck/agent vitest/i18n 已绿 + §1 无未解释 `[ ]` + P0 空。  
**产品侧宣布落地**：另需抽 10 场景冒烟 + DevPanel 采样通过。

---

## 8. 三轮变更文件总清单（基于 progress 汇总）

> 非 `git diff` 全库；以各卡「名下文件」去重归纳。并行区可能有重叠修改。

### 8.1 Rust（`src-tauri`）

- `src/chat_v2/tools/workbench_bridge.rs`、`workbench_executor.rs`（新建于 R1）
- `src/chat_v2/tools/canvas_executor.rs`、`builtin_resource_executor.rs`（mindmap 段）
- `src/chat_v2/tools/browser_executor.rs`、`qbank_executor.rs`、`user_todo_executor.rs`、`chatanki_executor.rs`、`tool_pack_executor.rs`、`executor.rs`
- `src/chat_v2/context.rs`、`pipeline.rs`、`pipeline/tool_loop.rs`、`pipeline/history.rs`、`pipeline/parallel_exec_tests.rs`
- `src/chat_v2/events.rs` / `types.rs`（block_types，R1-01）
- `src/tools/mod.rs`（mod 声明，R1-01）
- `src/feature_flags.rs`（R1-17）
- `src/browser/service.rs`、`session.rs`；`src/cmd/browser.rs`、`fsrs_review.rs`
- `src/vfs/repos/todo_repo.rs`、`question_repo.rs`；`todo_handlers.rs`；`vfs/types.rs`

### 8.2 前端 agent 核心（`src/features/workbench/agent/`）

- `types.ts`（R0.5 脚手架，只读冻结）
- `stageManager.ts`、`arbitration.ts`、`ledger.ts`、`presenceStore.ts`、`bridge.ts`、`AgentBridge.tsx`、`probe.ts`、`pacing.ts`、`gates.ts`、`inputProbe.ts`、`userPatch.ts`、`domainEvents.ts`、`noteBinding.ts`、`queryProviders.ts`
- `drivers/*`（mindmap/note/todo/finder/fsrs/qbank/pomodoro + `index.ts`）
- `visuals/AgentStrip.tsx`、`agentFlash.ts`、`agent-visuals.css`
- `__tests__/*`（含 R2/R3：arbitrationConsistency / lifecycleEdgecases / gates / chaos / crossScenarios 等）

### 8.3 Workbench / 应用壳

- `components/WorkbenchDesktop.tsx`、`WindowShell.tsx`、`WorkbenchDevPanel.tsx`
- `core/workbenchBus.ts`、`core/types.ts`、`core/perfMonitor.ts`
- `apps/mindmap/register.ts`；`apps/content/register.ts`、`createContentApp.tsx`；`apps/system/register.tsx`、`pomodoroSource.ts`；`apps/browser/register.tsx`
- `index.ts` 导出

### 8.4 域 UI / chat / browser / i18n

- mindmap：`MindMapCanvas.tsx`、`mindmapStore.ts`、`OutlineView.tsx`、`mindmap.css`
- notes：`agentHighlight.ts`、`NoteContentView`、`NotesCrepeEditor`、`useCanvasAIEditHandler.ts`、`CrepeEditor.css`
- learning-hub：`ExamContentView.tsx`、`LearningHubSidebar.tsx`；`QuestionInlineEditor` / `QuestionBankEditor`
- chat：`workbench-tools.ts`、`workbenchOpsBlock.tsx`、`toolCall.ts`、`approval.ts`、`restoreActions.ts`、`workbenchBlockRemap.ts`、`ankiCardsBlock.tsx`、adapters/types
- browser：`controlModeSync.ts`、`sessionStore.ts`、`browserApi.ts`、`useBrowserSession.ts`
- settings：`WorkbenchSettingsSection.tsx`
- locales：`zh-CN|en-US/workbench.json`、`chatV2.json`（及 skills 名，R1-08）

### 8.5 文档（`docs/dev/acr/`）

- `DESIGN.md`、`STANDARDS.md`、`ROUND1.md`、`ROUND2.md`、`ROUND3.md`
- `ERRORS.md`、`SCENARIOS.md`、`ACCEPTANCE.md`、`PERF-REPORT.md`
- `progress/R0.5.md`、`R1-*.md`、`R1-ACCEPTANCE.md`、`R2-*.md`、`R2-09-edgecases.md`、`R2-ACCEPTANCE.md`、`R3-01..05.md`、`R3-ACCEPTANCE.md`

### 8.6 测试（摘录）

- `src/features/workbench/agent/__tests__/**`
- `src/features/browser/__tests__/**`
- `src/features/workbench/apps/**/__tests__/**`
- `tests/vitest/chat-v2/plugins/blocks/WorkbenchOpsBlock.test.tsx`
- `tests/vitest/chat-v2/plugins/events/approval.test.ts`
- `tests/vitest/chat-v2/utils/workbenchBlockRemap.test.ts`

更细的「卡→文件」映射见各 `progress/<ID>.md` 名下文件节；切分 commit 时建议按 R2 十区 / R1 组边界拆。
