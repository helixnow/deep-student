# W29 启动期恢复与清扫接线（V04-03～V04-07）

分支 `assault/W29-startup-recovery`，起点 INT `6c491e6f`。

## Rust 对照（`src-tauri/src/lib.rs` build_app_state，setup 内同步执行，StartupReadyGuard 在 setup 结束才释放）

| 项 | Rust 位置 | 同步/后台 | 失败处理 | TS finalizer | 是否 await |
|---|---|---|---|---|---|
| V04-05 qbank 中断任务 → failed | 3512-3514；`qbank_generation/mod.rs:35-39`、`task_repo.rs:321-342` | 同步，最早 | warn 后继续 | `qbank.recover-interrupted-tasks` | 是（同步，ready 前） |
| V04-03 PDF 补预览 | 3610-3613；`pdf_processing_service.rs:4111` | 同步查询，渲染 spawn | warn 后继续 | `vfs-index.startup-recovery` 第 1 步 | 查询同步；渲染沿用 runtime 的后台任务 |
| V04-03 PDF 复位卡死 | 3615-3632；`pdf_processing_service.rs:3034-3090` | 同步 | warn 后继续 | 同上第 2 步 | 是 |
| V04-03 PDF 续跑 | 3621-3626；`pdf_processing_service.rs:3101-3139` | `async_runtime::spawn` | 单个文件 warn | 同上第 3 步 | 否：startupGate 放行后经 backgroundTasks 运行 |
| V04-04 索引复位 | 3635-3644；`indexing.rs:1978-2053` | 同步 | warn 后继续 | 同上第 4 步 | 是 |
| V04-07 启动清扫（资产删除、blob、retrieval 24h、孤儿笔记/导图 24h、孤儿索引单元） | 3646-3768 | `spawn_blocking`；先 try_acquire DeletePropagation，忙则整体跳过 | 每项 warn 后继续 | `notes.startup-sweep`（单一许可、Rust 顺序） | 否：startupGate 放行后经 backgroundTasks 运行 |
| V04-06 Anki 卡住任务 → Paused（10 分钟） | 3770-3780；`database/mod.rs:7389-7427` | 同步 | warn 后继续 | `anki.recover-stuck-document-tasks` | 是 |

清扫最后一步 `backfill_note_links_once(500)` 已由 W10 的 `notes.note-links-backfill`（ready 前）接好，本 lane 不改。

## 进度

- [x] V04-05 qbank（06f2722f）
- [x] V04-06 anki（4a49b96b）
- [x] V04-03/04 vfs-index（9e79bbca）
- [x] V04-07 notes（58ea9f0a）：原计划拆到 notes + vfs 两处，改为 notes 一处，保证同一把许可与 Rust 顺序
- [x] desktop profile 接线测试（46c04736、0285cf2d）
- [x] 移动端：scan `--check` / `--mobile-readiness` 与开工前基线对比无退化
- [x] V04 §3.2 其余启动项：其余 ✗ 项不是“已移植未调用”，或在他人路径（V04-08 W10、V04-12 W01）
- [x] 无 finalizer API 的 storage 替身只 warn，不中断插件 apply（3a85c2a1）
- [x] 合入 INT `fe5feb68`（0c827e48）后复验：四插件目录 + e2e 194 文件全过；启动/profile 17 文件全过；tsc、boundaries、import-cycles、rust-fixes、check-boundaries、contracts:check 通过；scan `--mobile-readiness` 与 INT `fe5feb68` 一致

## 小修复轮（审计复核 A02 `W29-5e5cecd2.md`，V04-03 关闭条件）

- [x] 必须修 ①：首个用例种满 `recover_stuck_tasks` 的 11 种卡死阶段（PDF/音频 MIME 混用）+ completed、error、pending、completed_with_issues、cancelled、NULL 六种稳定状态；断言 11 行复位、6 行不动、续跑 id 正好这 11 个且 stage 为 null（89b9f690）。变异：从 `pdf-service.ts` 卡死列表删 `decode` / `indexing` 各一次 → 红；恢复后绿
- [x] R1：卸载自身空出槽位时不再启动续跑（f6ea67a3）。变异：删 `startup-recovery.ts` 循环后的停止检查 → 红（3/3）；恢复后绿
- [x] R2：gate 超时或 reject 后照样续跑（22c55626）。Rust `lib.rs:3623-3626` 直接 spawn，`resume_recovered_tasks` 只等并发槽位，不等任何启动条件；与 Rust 对齐，不登记 RF
- [x] F2 交给 W04：`recoverStuckTasks` 逐行 catch 吞掉 owner 缺失 → 补丁与验证测试在 `.reports/W29-handoffs/W04-recover-stuck-tasks-owner-missing.patch`
