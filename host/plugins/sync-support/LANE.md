# L20b-sync-support：同步引擎支撑模块

> 本 lane 由 L20 拆出，`meta.lane` 仍写 `L20-sync`（inventory 归属 L20）。
> 目录：`host/plugins/sync-support/`；服务：`syncSupport`（1.0.0）；无 Tauri 命令、无事件。

## WP-011：测试宿主 mastery 装配

- `tests/service-host.ts` 的 `withSync` 路径由本 lane 接回；只安装真实
  `review/index.ts` provider 后再安装 sync，不沿用 `ca99bb4f9` 的 `mastery: {}`。
- 依赖已核对 main `967f43c75`：review/api.ts 发布 mastery；sync 的
  `src/mutation-commands.ts:26` 与多库 apply 使用该服务。该基线 inject 尚未列出 mastery，
  不能把现有目录测试通过误当成所有 mastery 消费路径都已装配。
- `tests/service-host.test.ts` 是宿主补充回归（真实 F3 迁移库、review provider 的记账/
  同事务重算/读取/profile 回流入口与 kernel overview 命令），不新增 Rust ported 映射。
- 原 state/tombstone/note-history/pomodoro 测试及断言不改；S06 busy-handler 继续 pending，
  不等待 WP-008，不代签 S04 或修改 L20 foreign diff。交 C2 先合 owner，再收口 foreign diff。

## 范围

| Rust 文件 | 行数 | 内联测试 | 本 lane 产物 |
|---|---:|---:|---|
| `src-tauri/crates/dstu-sync/src/data_governance/sync/tombstone.rs` | 3014 | 25 | `src/tombstones.ts` 服务组装、`src/tombstone-{model,events,manifests,files}.ts` |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/note_history.rs` | 731 | 5 | `src/note-history.ts`、`repository/note-history.ts` |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs` | 672 | 8 | `src/pomodoro.ts`、`repository/pomodoro.ts` |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/state.rs` | 664 | 2 | `src/state.ts`、`repository/state.ts` |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs` | 563 | 0 | `src/conflicts.ts`、`repository/conflicts.ts` |

`history.rs`（快照批次）属 L20，本 lane 通过 `SyncHistoryPort` 在
`createResolver(policy, history)` 调用点注入，不静默降级。

## 提供 / 消费

- 提供：`syncSupport`（`syncSupportService` 描述对象）
  - `state: SyncStateStore`（`sync_state` 库）
  - `tombstones: TombstoneSupport`
  - `noteHistory: NoteHistorySupport`
  - `pomodoroCounts: PomodoroCountsSupport`
  - `conflicts: ConflictSupport`
- inject：F3 `storage`（`ctx.storage.database('sync_state')`）；L10 `notes`（`ctx.notes`）；
  L11 `vfsRepo`（`ctx.vfsRepo.pomodoros` 的同事务全量重算）。
  L10 已提供新名，直接使用其公开 Context 类型。L20 `sync` 的
  `JsonValue` / `SyncChangeWithData` 仅为类型引用，不是运行时接线证明。
- notes.sync / format.blocks 与 L11 同事务 batch 接口已在 main，已删除本 lane 的
  notes/todo 写副本。正式 main `677f6727c` 已包含 L20 默认 note-history hooks 收敛：
  reader 用 syncSupport.noteHistory，writer 用 L10 owner；本 lane 未越权修改 L20。
- JSON 数字表示/解析从 L20 api.ts 导入同一实现，内部 bigint/JsonFloat 精确传递。
- codec：现有三类 tombstone I/O 接受同步或 Promise codec；`AsyncPayloadCodec` 与 L20
  基于 F4 DSBK 的异步加密对象结构兼容，同步 codec 保留原调用方式。
- 云存储：保留首发 `TombstoneStorage` 的 snake_case 方法；L23 `CloudStorage`
  经新增的 `adaptTombstoneStorage(storage)` 接入，适配器保持方法的接收者绑定。

## 约束

- 只写本目录；SQL 只在 `repository/`；生产代码无 mock/fake/stub。
- 语义以 Rust 源码为准；Rust 的已知 bug 保持原行为并记入最终报告。
- 测试映射写在 `TESTMAP.md`；`host/plugins/sync/TESTMAP.md` 由协调者同步。

## v2排雷清单（X6 报告 `0119143715c0bab2d8f698b7c1d58651358e85be`，源码基线 `2ee9a9cbe`）

编号与顺序按原报告固定，不重排。“候选已修”指本分支已修、尚未进 main；main 后由对应 R 复验前不算完成。

| ID | 基线位置 | 当前状态 | 证据 / 修复 SHA |
|---|---|---|---|
| X6-SW-0085 | repository/note-history.ts:42 UPDATE note_learning_relations | 候选已修待复核 | `6d183b75f` 删除写SQL；retarget 经 L10 `notes.sync`（src/note-history.ts:29-30），同一 SqlExecutor |
| X6-SW-0086 | repository/note-history.ts:58 UPDATE note_document_formats | 候选已修待复核 | 同上 `6d183b75f`；当前 repository/note-history.ts 仅 SELECT |
| X6-SW-0087 | repository/note-history.ts:72 UPDATE note_learning_relations | 候选已修待复核 | 同上 `6d183b75f` |
| X6-SW-0088 | repository/note-history.ts:93 UPDATE note_document_revisions | 候选已修待复核 | `6d183b75f`；pin 经 `notes.revisions.setPinned`（src/note-history.ts:103） |
| X6-SW-0089 | repository/note-history.ts:132 INSERT note_document_revisions | 候选已修待复核 | `6d183b75f`；快照经 `notes.revisions.snapshot`（src/note-history.ts:102） |
| X6-SW-0090 | repository/pomodoro.ts:24 UPDATE todo_items | 候选已修待复核 | `6d183b75f` 删除 repository/pomodoro.ts；src/pomodoro.ts:12-18 调 L11 `recomputeCompletedPomodorosForSyncBatch` |
| X6-SW-0091 | repository/pomodoro.ts:38 UPDATE todo_items | 候选已修待复核 | 同上 `6d183b75f` |
| X6-UD-0083 | repository/records.ts:135 parseLlmUsageDailyRecordId | 候选已修待复核 | `34a1e737e`：JSON.parse 结果先按 `unknown` 收窄为对象再取字段。对照 Rust `sync/mod.rs:9240-9288`：四字段 as_str 非空、`splitn(4,'_')` 回退、失败后调用方继续通用解析，行为不变 |
| X6-UD-0084 | src/json.ts:133 canonicalizeForCompare | 候选已修待复核 | `1aacd0184` 改用 L20 `parseJsonLossless`；仅 SyntaxError 回退原字符串（Rust `conflict_resolver.rs:552-559`），source-access 错误传播 |
| X6-UD-0085 | src/tombstone-manifests.ts:140 decodeTombstoneFile | 候选已修待复核 | `66fc09e96`，C2 裁定后：公开 helper 返回缩窄为 `unknown \| null` / `Promise<unknown \| null>`，删除无依据 `as T`；运行时值、null、错误前缀与 sync/async 时序不变。各清单仍由 `decodeManifest` 的 normalize 给出 typed 结果（Rust `tombstone.rs:767-786` 的 serde 形状校验）。测试仅去掉不真实的类型参数 |
| X6-AP-0429 | tests/tombstone.test.ts:359 | 已逐条对照，无缺口 | Rust `tombstone.rs:2125-2175` 7 条断言：future>valid、blob len==1+contains good、blob max==valid、asset len==1+contains good、asset max==valid。TS 用 `Object.keys(...).toEqual([key])` 同时断言长度与包含项（更严格），5 个 expect 覆盖全部 7 条语义，不补重复 expect |

本插件 PR=0、LP=0。

## 当前状态（未完成；本 lane 可自行推进的事项已清空）

- S03事件JSON自查发现读回的普通JSON.parse舍入合法大u64，已候选改接L20公开parser；
  新两条真实服务回归有效输入修前 `20261104200941-f251ff` 2fail/exit1，
  修后 `20261104201022-5d0c16` 2pass/exit0，无Errors/Unhandled Errors。详见REPORT，
  不改公开通用manifest helper运行时值、不改变39P/1Q、不替R4签收。
- 当前分支恢复完整目录通过：`7b5ca5178` / `6361462a6` 的原目录作业分别
  `20261104173512-c53cb8` / `20261104175750-d8056d`，均123/123、exit0、无Errors/Unhandled。
  174833原72项集成差异尚未解释，固定组合最小复验未复现，已交C2请求保留原root完整栈；
  不因本地自检绿撤销该反馈。详见REPORT/BLOCKERS。
- 165250 新集成红灯已定位 SlotOccupied：固定组合与原root/候选及最小复验均记入 REPORT。
  本lane修 note-history fixture 为单应用+两真实库，原断言保留；跨用例 dispose 后注册未释放
  已由 L10 `5f9082dbf` 修复进main。随后本lane宿主补真实F3 maintenance registry/app目录，
  `20261104173204-d56061` 四入口通过（24项标题过滤）、exit0、无 Errors/Unhandled Errors。
  旧红灯不删，未跳过业务测试或用 no-op 注册换绿。
- 自检：lane-gate 5 项通过于 `b343559bc`（基线 main `ad11a8394`）。
- S05：F3 phase 合入后两条 prepare 原断言通过；首 step 映射已按 Rust 修正（`cae04c341`，作业 `20261104123619-eb8627` 15/15）。签收归 R4。
- L10 `7a6783fdb` / `7df6fff90` 已在正式 main：补负大整数 CAS 与软删笔记快照/事务回滚回归，作业 `20261104145316-0d5433` 两文件 10/10、exit 0、无 Errors/Unhandled Errors；原断言保留。不增加 Rust ported 数，不冒充 L20 apply 整链签收。
- L20 默认 reader/owner 接线已到 main `677f6727c`；新增 5 条真实完整链测试 `tests/note-history-apply.test.ts`，Node 作业 `20261104160636-53cfb7` 5/5、exit 0、无 Errors/Unhandled Errors。映射恢复为 39 ported / 1 pending，原函数级断言保留。S01/S04 待 R4 独立签收。
- 外部阻塞：
  - S06：缺 F3 真实 SQLite busy_handler 通知能力，`tombstone_sequence_waits_for_writer_before_reading` pending。
