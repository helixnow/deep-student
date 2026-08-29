# R4 — Rust 超大模块拆分报告（SA-R4-09）

分支：`cursor/optimization0824-5575`
范围：`src-tauri`，禁碰 `model2_pipeline.rs` / `provider_quirks.rs` / `tool_loop.rs` / `session_export.rs`。

## 1. src-tauri 最大的 5 个 .rs（wc -l，排除禁碰文件）

| # | 文件 | 行数 |
|---|------|------|
| 1 | `src/chat_v2/tools/chatanki_executor.rs` | 15459 |
| 2 | `src/data_governance/sync/mod.rs` | 14673 |
| 3 | `src/database/mod.rs` | 9214 |
| 4 | `src/vfs/handlers.rs` | 8488 |
| 5 | `src/data_governance/migration/coordinator.rs` | 8030 |

本轮按任务优先级拆分了优先名单中最大的两个：`compaction.rs`（4093 行）与
`context_compiler.rs`（2109 行）。上表前 5 名均为万行级 god-file，需要独立
工作包逐个处理（改动面涉及 DB / 同步 / VFS 核心，不适合与本次合并）。

## 2. 拆分结果（对外 API 不变）

两个模块都保留原文件作为模块根（`foo.rs` + `foo/` 目录布局），原有的
`pub use compaction::*;`（`pipeline.rs`）与 `super::context_compiler::…`
调用点一律不需要改动；根文件内用 `pub(crate) use` / `pub use` 把子模块项
重导出到原路径。全仓库除这两个模块自身外**零调用点改动**。

### 2.1 `chat_v2/pipeline/compaction.rs`：4093 → 1430 行（根）

| 文件 | 行数 | 职责 |
|------|------|------|
| `compaction.rs`（根） | 1430 | 类型（`CompactionOutcome` / `CompactionSkipReason` / `PreparedCompaction`）、`run_compaction*` 主流程、事务提交与 lineage/指纹校验、`apply_compaction_view`、根级测试 |
| `compaction/budget.rs` | 279 | token 预算常量（`TRIGGER_RATIO` 等）、`usable_tokens` / `effective_usable_tokens`、`should_compact*` 触发判定、token 估算 |
| `compaction/segmentation.rs` | 383 | turn 划分、thinking-signature 保真扫描、tail 选择（`select_tail`） |
| `compaction/prompts.rs` | 588 | 学习/通用两套摘要 prompt 档案、结构校验、标识符保真审计、消息渲染 |
| `compaction/memory_flush.rs` | 1411 | 记忆冲刷台账（SQLite ledger + 带租约 worker + 崩溃恢复 + fail-closed 策略读取） |
| `compaction/test_fixtures.rs` | 100 | 子模块测试共享构造器（`#[cfg(test)]`） |
| **合计** | **4191** | （+98 行：模块声明 / 重导出 / 子模块文档头） |

### 2.2 `chat_v2/pipeline/context_compiler.rs`：2109 → 845 行（根）

| 文件 | 行数 | 职责 |
|------|------|------|
| `context_compiler.rs`（根） | 845 | `freeze_execution_context` / `compile_frozen_context` 编排、canonical 内容提取、快照兼容测试 |
| `context_compiler/images.rs` | 805 | 图片预算（`select_images_with_budget`）、运行时图片收集、派生产物（OCR/observation）复用 |
| `context_compiler/model_selection.rs` | 374 | 生成模型解析（text / MM / dedicated-OCR 分类、strict persona、model2 覆盖） |
| `context_compiler/preprocess.rs` | 165 | 视觉预处理阶段编排（辅助 MM → OCR 兜底、单阶段/单 turn 双层超时、可取消 runner） |
| **合计** | **2189** | （+80 行：模块声明 / 重导出 / 子模块文档头） |

## 3. 测试（cargo test，全绿）

- `cargo test --lib chat_v2::pipeline::compaction`：**30 passed / 0 failed**
  - 根 4、`budget` 7、`segmentation` 5、`prompts` 5、`memory_flush` 9
- `cargo test --lib chat_v2::pipeline::context_compiler`：**19 passed / 0 failed**
  - 根 1、`images` 6、`model_selection` 8、`preprocess` 4

原先集中在两个文件尾部的测试按职责就近下沉到对应子模块（共享构造器放
`test_fixtures.rs`），测试数量与断言不变。

## 4. unused import 清理

- 拆分自身引入的新警告：**0**（拆分前后 `cargo check` 警告清单逐条 diff 一致）。
- 顺手清理仓库中唯一的 `unused_imports` 警告：`src/exam_sheet_service.rs` 的
  `use image::GenericImageView;`（基线即存在，与本次拆分无关）。

## 5. cargo check 计时

环境：Linux x86_64（cloud VM，14 并行任务），rustc/cargo 1.98.0，lld 链接。
方法：先完成全量冷编译，然后 `touch` 两个模块根文件再计时 `cargo check`
（增量、公平对比同一 crate 的重编译量）。

| 场景 | real |
|------|------|
| 拆分前（touch `compaction.rs` + `context_compiler.rs`） | 22.4 s |
| 拆分后（同样 touch 两个模块根） | 23.2 s |
| 参考：拆分后全 crate 改动检查（首次含 4 个新文件） | 2 m 02 s |

结论：增量 check 时间持平（±1 s 噪声内）——同一 crate 内拆文件不改变
rustc 的编译单元粒度，收益在可维护性（单文件行数 4093→1430 / 2109→845、
职责边界显式化、测试就近），不在编译速度。
