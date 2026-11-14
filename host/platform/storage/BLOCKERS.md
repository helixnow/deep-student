# F3-storage 剩余阻塞（2026-11-04）

## WP-164 当前状态（2026-11-05，覆盖下方 WP-008 历史依赖描述）

F7 WP-161 已在 main `676b29852`：`native/api.ts` 公开 `NativeSqliteBusy` / `SqliteBusyHandler`，
`dstu.native` 提供 `ctx.nativeSqliteBusy`。F3 已将它接入 Connection / StartupDatabase，
同一 better-sqlite3 连接通过 F7 自身 loadExtension 安装 handler；不存在供方未发布阻塞。
`openStartupDatabase(path, { nativeSqliteBusy: ctx.nativeSqliteBusy })` 可在 ctx.storage 发布前使用。
异常按 rusqlite 0.40.1 busy.rs:60 吞为 false，不延后重抛；旧 WP-008 反向提案仅为历史。
余下边界：L20b 需在自己的生产 reserve 路径接入并复验 S06；F7 仅 Linux-x64 有预编译产物，
其他平台与 Rust panic hook 可观测性另行交付。本包没有修改 L20b 的 pending 或业务代码。

## WP-081 / D35：原完整诊断 5s 预算仍 open

接口不是阻塞：main正式MigrationWorker.runAll和L21消费者已存在。WP-005原件
`20261105150749-4d236e` 为10306.492ms > 5000。F3 Node新阶段证据
`20261105180542-66dab8`（direct runner，非kernel命令）为8666.51ms。
已分离冷worker/加载、执行、校验、真实原生同步I/O：C主要为逐项事务fsync，D主要为指纹scratch和schema读取。
保留Rust SQL/history/事务/备份恢复/顺序/日志/报告时，当前未证得足量可行等价优化。
详见 `WP-081-PERFORMANCE.md`；没有运行Rust或声称Rust同机也超时。
需要C2组合F3测量候选与L21现成原诊断红例，按原5s以及X1 85/175/180预算独立复验。
若仍红，需后继针对已测慢点继续证明等价优化；本包不以放预算、并发C/D、预热、缓存诊断或削弱持久性关闭D35。

## WP-008 / B5-D17 当前收据（2026-11-05）

本包已核 main `967f43c75`：`api.ts`/`openStartupDatabase`/`llmUsage` 均已发布。
旧文档的 D18 启动开库与 llmUsage 未提供说法不适用于本包。
已安装 better-sqlite3 13.0.3 **没有公开 busy handler/interrupt**；SQLite 内部 timeout
确实使用 handler，但不会给 JS 发在途争用通知。详细源码、可执行探针、真实 worker/双连接
回归与最小 native 签名见 `L20B-OBSERVABILITY.md` WP-008 节。

因此 S06 仍阻塞，需架构师裁定同一 N-API 绑定增补并由 F7 交付
`setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void`。
F3 再经 StartupDatabase 公开，L20b 在原 reserve 调用上验证回调暂停→writer COMMIT→放行→seq=2。
当前回归只证明真实 BUSY 返回后状态与 DEFERRED 读锁负控，不标成原测试 ported。
旧第 5 节关于必须原生 seam 的结论保留；旧“null 恢复 timeout”提案已纠正为 null 禁用等待。

本会话起点工作树干净；旧 §5 lane-gate 的 ledger dirty 阻塞是历史记录，不据此跳过本次自检。
合并 main 后实际 F3 TESTMAP 已是 324 ported / 8 merged / 30 obsolete / 0 pending，
下方两个 Anki 与 JPEG “3 条 pending”描述也属历史；本包不修改这三条已在 main 的映射。

最新候选证据：全目录 `20261104132512-ec2950` 40 files/544 passed/1 条既有条件跳过/
exit 0，无 Errors；typecheck/普通 boundaries exit 0。两条 timeout 的夹具已恢复 Rust 内存库，
默认 30s 未放宽。P0 config 缺省修复 `04e6c7ef7` 已单独告 F1/C2；新迁移 worker 和 retention
的 Node/Electron 最小集均 exit 0。工具故障轮按架构师指令忽略，非业务缺陷。

L21 公共迁移入口已发布：`createMigrationWorker({baseDir})`，`runAll(options)` / drain式
`close()`；内部唯一算法仍是 MigrationCoordinator.runAll。精确签名/上下文/错误/取消/guard
与日志见 API.md §11，最新 Node25 / Electron25 passed。等待 L21 正常 main 消费与命令整链复验。

## standard-v2 §5 官方 lane-gate 前置阻塞

自有改动提交并 merge main（`f7a447e9b`）后执行：
`node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`
返回 **exit 2**，原始原因：

```text
有未提交的改动，先提交再自检（自检结果按提交记录）：
M migration/LEDGER.md
 M migration/ledger.json
```

这两份 tracked 生成账本从本会话接手前已修改，不在 F3 允许路径内，原任务明确禁止提交
生成账本。官方脚本 `:28-31` 无排除参数；检查尚未入队，没有 selfgate 通过结果。
请协调者处理其生成改动状态或给出正式脚本规则；F3 不提交/丢弃他人改动或隐藏 dirty 状态。

## v2 接手门禁上报（2026-11-04）

**W13 新收据**：F1 bootstrap 生成接缝已交付责任分支 `c1efab411`（包含前序实现，
不是只摘末尾文档提交）。F3 已亲读代码并亲取 `20261104115116-c0797e` 3 passed /
exit 0、`20261104115117-be465f` typecheck exit 0；该 HEAD 尚非 main 祖先。
当前 main 未发现 L20 的 storageStartupSync provider。下一步是三方正常集成后的正式
profile 真实 reset 组合；F3 不新增 phase/finalizer、不改 inject、不重复旧 D2 八例。
具体断言范围见 STARTUP-WIRING.md §3。

**11:48 更新 / C2 自有 gate 消费已交付候选**：F3-V2-06 的真实 F2 gate 消费已实现；
Node 启动/导出三文件 job `20261104114016-056342` 20 passed / exit 0，Electron gate
`20261104114330-df8fd9` 5 passed / exit 0，无 Errors。类型检查 `20261104114016-807a86`
exit 0。STARTUP-WIRING/API/LANE 已纠正 F1 main mark/F2 profile/L11 main 注册事实，W13
采用 F1 刚发布的生成器 bootstrap 最小方案，未改 F3 inject、未增加框架、未把 reset 推迟。
后续 staged u64/featureFlags 版本修复与 repairs 让出：Node `20261104114423-bcc5c1`
47 passed / exit 0，Electron `20261104112959-c89686` 42 passed / exit 0，无 Errors。
11:22 全套重跑 exit 1（两处新增 fixture hook 10s 超时 + RPC Errors 1）已记录 LANE；
补 hook 预算与 repairs/startup 让出后按 C2 指令只验证最小集，不把旧基线绿色算作新全套绿色。

合并 main 的 `8c3c55f7d` 后 typecheck job `20261104105630-07c6fd` exit 0；此前通知中的
`notes/src/trash-commands.ts:118,173` 类型错误在当前分支未复现（F3 `526512c2c` 已有兼容重载）。
strict job `20261104105630-160796` exit 1，四项都在禁止 F3 修改的 L13 路径：
`host/plugins/vfs/repository/create.ts:41`、`resources.ts:126`、`update.ts:33` empty-catch，
`folders.ts:22` console.warn。请协调 L13 修复；F3 不越权修改。

F3 自有全套 job `20261104094622-53d660` 为 507 passed / 1 skipped / **Errors 2 / exit 1**。
F3-V2-04 修复长同步测试的 RPC 饥饿后，最新 `20261104110931-0395fc` 为 37 files passed、
514 passed / 1 skipped、**exit 0，无 Errors 行**；最新 typecheck `20261104111349-6d5cf4`
exit 0，普通 boundaries `20261104110800-a2a032` exit 0。请求以此新候选重跑集成门禁。
v2 接手盘点已由自动检查点 `bb54a530a` 保存，后续修复用 F3-V2 finding ID。

### F3-V2-01/02/03：请求 F4 发布已存在的共享解码原语

**更新：F4 已进入 main**。祖先检查 `2d9d56497 → main` exit 0，当前工作树
`host/platform/util/api.ts:91-102` 已可消费；此前已亲读该候选，
正式重导出 JsonReader/JsonSyntaxError/classifyJsonNumber/jsonUnexpected 与 decodeBase64Standard。
Reader 提供 nextKey→typed read→fieldError/end 的流式语义；不再把完整 AST 先读完当解码顺序等价。
下面是原始接口请求依据，不再称 F4 未发布。F3 的业务 decoder 仍需逐字段实现：恢复 pointer/
manifest/candidate/journal 的必填、Option/default、u64、BTreeSet；feature flags 的 map/enum/f32。
F3 可直接消费正式 API，不再以该依赖未发布/未集成为阻塞；词法库发布不是业务 validator 完成。

1. `host/plugins/sync-providers/src/json_exact.ts:15-128` 已有保留 number token、重复对象键、
   字节列号的 ExactJsonDocument/Number/Object/Array；但它是 L23 私有实现，F3 不可跨私有导入或
   再复制一份 parser。请 F4 与 L23 协调移至共享 util 并从 `api.ts` 发布。F3 的恢复 pointer /
   incident / candidate / BTreeSet journal，以及 feature_flags HashMap/FeatureState 的逐字段
   decoder 仍由 F3 实现；需要原语保留 u64 原文、区分 `1`/`1.0`、已知字段重复及错误行列。
   现有 F1 `kernel/serde.ts` 只检查解析后的 Value（且未公开），不能代替持久化 from_str。
2. `host/platform/secrets/crypto-service.ts:37` 已有 `decodeBase64Standard(text)`，能返回 Rust
   base64 0.22 的 padding / last-symbol / invalid-byte Display；`secrets/api.ts` 未导出。
   请 F4 从公共 api 或 util 发布该原语，F3 staged append 在已有错误前缀
   `Invalid chunk base64: ` 后使用它；不继续维护本 lane 的通用错误文本副本。

这两项是共享原语的公共接缝请求；F3 仍需自行完成结构解码、版本比较、生产接线和断言。

### F3-V2-05：D1 所有权接缝仍不完整（不能凭现有注释判通过）

**L10 提案已确认并公开类型**：registerDeletionJournal(repo):Disposer；六个同步方法按提案，
null/false 留 F3 构造 DuplicateOperation/InvalidState，SQL 错误 owner 原样抛。
DeletionJournalIntent/PrepareDeletionJournalIntent 的 size 用 bigint|null；旧 PreparedDeletionIntent
增补 bigint 支持。registerNoteAssetRetention 也已改为真实 Slot/Disposer，需 L10 scope 持有。
L10 正在实现仓储，F3 尚未用空 owner 替代现有 SQL；待真实提供方集成后完成委托。

**L05 子项已修复为候选**：`registerWorkspaceIndexDeletionOwner` 与 workspace 四个编排方法
已从 F3 api.ts 公开，F3 不再直接 DELETE workspace_index。回调在同一 savepoint 的 prepared
INSERT 后、RELEASE 前执行；错误回滚，Slot/Disposer 与 L05 scope 对接。L05 已确认签名，
等待 F3 正常进入 main 后在 index 注册；双方联合生产验证仍 pending。此修复不关闭下述
journal/outbox 或 NoteAssetRetention 的余项。

L05 收据：提供方代码 `4e9072bd4`，自检头 `2ec550ff1`（基线 main `16a254adf`）；
已亲取 `20261104135141-6c5547` exit 0/五项通过。其 `workspace-journal-wiring.test.ts`
Node `20261104124629-fd8a10`、Electron `20261104124629-32c3cf` 各 2 passed / exit 0，
证明准备失败/PRAGMA 失败路径保存元数据和文件、释放借用连接。不是 F3/L05 注册联合验收；
main 缺 F3 register 导出时，L05 仍等正常集成后从 index ctx.effect 绑定并释放。

接手审读时确认 `file-deletion-queue.ts:403,433,442,492,581,715-771` 直接写
workspace_index / __file_deletion_journal / __asset_deletion_queue / __workspace_deletion_queue；
之前“只提供 executor、不复制表写入”的 API 注释并不代表真实实现。D1 明确笔记与删除 journal
归 L10，而 main `host/plugins/notes/api.ts` 未提供 journal 的准备/查询/取消/ready 发布/失败更新
WithConn 方法。需要 L10 发布这些业务接缝，再由 F3 文件编排调用，且仍使用原同一 SqlExecutor；
workspace_index 删除归属需协调 L05 对齐。不得把准备行和业务删除拆事务，也不得为规避扫描
仅把越权 SQL 移入 F3 repository。已发现的本 lane 调用整改仍由 F3 完成。

接手时同模块 `registerNoteAssetRetention` 为全局 first-wins、返回 void，未保留 Rust
`file_deletion_queue.rs:29-39` 的 SlotOccupied/Disposer 生命周期；F1 公共 API 已有 Slot/Disposer。
L10 `repository/asset-retention.ts:86-91` 当前不返回/保存 disposer，需协同改为 scope 持有。
本分支已修复为 Slot/Disposer，新增真实 prepare 路径的释放/重注册回归；L10 scope 消费仍待
集成，不以单侧接口测试关闭整链运行时审查。

### R4-SYNC-06：L20 worker / 文件入口候选已发布

`api.ts` 公开 createDatabaseWorkerPool、DatabaseWorker*/MultiDatabaseWorker* 类型和
isVirtualUri/rejectDoubleEncodedVirtualUri/queuePersistableSafUri/copyFileVerified。
`pool.runWithDatabases` 在一个真实 worker 内执行多库任务，openExisting 不创建缺库；
默认 readonly 与显式 read-write-existing 均支持。Rust open_sync_connection 实际读写打开，
L20 应显式 readonly=false 保持原打开条件；task timeoutMs=0、不绑定前端取消。
完整签名/维护注册/日志/清理责任见 API.md §11；Node/Electron 最新各 24 passed / exit 0。
这仅解除 F3 候选接口缺口，尚待正常集成与 L20 的生产 export 接入；Memory merge 接口仍归 L17。

旧账本记录本 lane 33 个命令 A 级；v2 自查中，SPEC 的整数/f32 与未闭合语义已取消旧勾选。
`migration/testmap/F3-storage.md` 仅剩 3 条 pending，全部依赖下列跨 lane 接口或 F7
原生能力，本 lane 不在其他 lane 目录写实现，也不以测试替身冒充完成。

此外有两项不计入本 lane 362 行 ledger 的跨 lane 集成缺口：L20b 的 SQL 观测/busy
回调（第 5 节）与 F2/X4 的启动接线（第 6 节）。它们同样不能在 F3 内伪造。

## 0. `anki-domain.test.ts` 断言数 122 → 92 的说明

2026-11-04 自动质量反馈指出 `host/platform/storage/tests/anki-domain.test.ts` 断言数下降。
原因是 `c676eae3b` 删除了与 L16 重复的 `host/platform/storage/repository/anki-domain.ts`
及依赖它的 3 条测试（`generic_anki_writes…`、`agent_library_reads…`、
`agent_library_cards_by_ids…`，共 30 条断言）。这不是为让测试通过而削弱断言：
这些 SQL 属于 Anki 领域，按 `quality.md §2.1` 由 L16 的 repository 提供。
`generic_anki_writes…` 已用 main 的 `insertAnkiCard` + `updateCardRows` 恢复为 ported；
余下 2 条等 L16 分支的 Agent Library/CAS 方法合入 main 后恢复，不用测试替身补数。

## 1. L16 Anki：`insertAnkiCard`（已解除）

main 的 `host/plugins/anki/repository/anki-cards.ts:546` 已提供 `insertAnkiCard`，生产消费方
`streaming-anki.ts:1600,1647` 已调用；`updateCardRows`、`saveDocumentTaskWithCardsAtomic` 也在 main。
本 lane 已在 `host/platform/storage/tests/anki-domain.test.ts` 恢复
`generic_anki_writes_reject_tombstoned_cards_and_parent_tasks`（9 条断言）并标 ported。

## 2. L16 Anki：Agent Library 读取与 CAS 写入

- **缺什么**（对应 `dstu-storage/src/database/mod.rs:112-146, 7740-8060`）：
  - `listAnkiAgentLibraryCards(db, scope, templateId, search, scheduleFilter, diagnosticFilter, page, pageSize)`
    → `{ items, total, page_size }`；Agent 作用域 `page_size` 固定钳位为 20。
  - `updateAnkiCardIfVersionForLibrary(db, scope, card, expectedUpdatedAt)`
    → `Updated(record)` / `Conflict(record)` / `NotFound`；成功时递增 `local_version`。
  - `updateAnkiCardIfVersionForSession(db, card, expectedUpdatedAt, sessionId)`
    → 只允许该会话拥有的卡片，否则 `NotFound`。
  - `getAnkiAgentLibraryCardsByIds(db, ids)`：按入参顺序返回活卡，任一缺失/软删即抛
    `library_cards_unavailable: <ids>`，消息中不回显已找到的 id。
- **当前状态**：
  - L16 分支 HEAD `fbed2b6c8` 的 `AnkiService` 已提供
    `listAnkiAgentLibraryCards`、`updateAnkiCardIfVersionForLibrary`、
    `updateAnkiCardIfVersionForSession`、`getAnkiAgentLibraryCardsByIds`；仓库层另有
    `updateLibraryCardRow`、`getLibraryCardsByIds`，且 `generation-service.ts:31` 的导入已修复。
  - 这些方法尚未合入 main；main 目前只有 `getLibraryCardRecord`、
    `listAnkiLibraryCardsFiltered`、`insertAnkiCard` 等基础函数。
  - L24 的 `host/plugins/chatanki/api.ts:177-195` 仍只有 `ChatAnkiCardRepository` 接口，
    生产实现缺失；`tests/chatanki-card-double.ts:140,173` 是测试替身。
- **影响测试**：
  - `agent_library_reads_and_content_cas_cover_null_and_foreign_sessions`
  - `agent_library_cards_by_ids_preserve_order_and_fail_closed`
- **解除条件**：L16 分支合入 main 后，在 `anki-domain.test.ts` 补两个用例并标 ported。
  L24 的接口不能替代 L16 的生产实现。

## 3. L04 Chat：mistakes `chat_messages` 回合写入（已按 C2 批准落地，非阻塞）

- **缺什么**（对应 `dstu-storage/src/database/mod.rs:3345-3450, 3843-3945`）：
  `appendMistakeChatMessages`、`listTurnMessageIds`、`deleteChatTurn`。
- **C2 结论**：已批准 `obsolete:dead-in-rust`；merge main 后 `migration/approvals.d/C2-platform.json`
  已聚合，TESTMAP 行已改为 `obsolete:dead-in-rust`，ledger 不再计 pending。批准文件在
  `ds-mig/C2-platform:migration/approvals.d/C2-platform.json`，blob
  `48279ae9c5551a15b5cdb5217e52e3787a287c3f`，内容 SHA-256
  `bc8c9349f749b73a15b5c9caf81e2ba1012198848e3fcd03fc96227a6ffc59b1`；
  核对时分支 HEAD `89bc4d8a5`。
- **批准原文**：
  > `obsolete:dead-in-rust`；C2 2026-11-04 于 `bccaf6201` 核实。全仓 rs/ts/tsx/js/mjs
  > 检索 `append_mistake_chat_messages`（含 with_context）、`list_turn_message_ids`、
  > `delete_chat_turn`（含 detail），仅命中 `database/mod.rs:3345-3357,3843-3896`
  > 定义/内部委托与 `:8504,8532,8559,8562,8568` 本测试调用。已读测试
  > `:8480-8589` 的 turn metadata/upsert/scoped deletion 断言；无生产入口，不要求
  > L04 另造 legacy 写服务。

## 4. F7 原生：图片缩放 + JPEG 编码

- **main 状态**：`host/platform/native/image/api.ts` 目前只有 `dimensions` / `decodeRgba`，
  **没有** `resizeAndEncodeJpeg`。因此 main 上的 `ctx.nativeImage` 还不能直接作为
  `ImageQualityCodec` 传给 `ctx.imageQuality`，L12 也尚不能真正接线。
- **F7 候选分支**：`ds-mig/F7-native`（HEAD `f8e38e9c4`）的 `NativeImage` 已发布
  `resizeAndEncodeJpeg(bytes, { maxDimension, quality })`，以及 `resizeTriangleJpeg`、
  `cropRgba`、`encode` 等；该分支尚未合入 main。先前“F7 已发布”指的是候选分支，
  现按 main / 分支分开记录。
- **已对齐**：解码使用同一 `image 0.24` WASM；Triangle 权重/两阶段采样按
  image 0.24.9 `imageops/sample.rs` 实现；`resizeDimensions` 复刻
  `DynamicImage::resize` 的包围盒和 `f64 as u32` 截断。
- **F3 策略已实现**（`host/platform/storage/file-manager.ts`）：
  - `high`/未知策略原字节返回；invalid decode/encode 原字节回退；
  - `auto` 按 Rust 的 2MP/4MP 阈值选择 medium/low，否则原字节；
  - 不需缩放且原始字节 <500KB 时原字节返回；
  - 需要编码时调用 `codec.resizeAndEncodeJpeg(bytes, { maxDimension, quality })`，
    low=768/60、medium=1024/75；生产调用方必须传真实 `ctx.nativeImage`。
  - 已通过 `ctx.imageQuality` 正式服务入口提供，L12 不再需要跨私有 `file-manager.ts` 导入。
  - `bytes_quality_preserves_original_on_noop_or_invalid_image` **已 ported**：
    `image-quality-service.test.ts` 用真实 64×32 PNG、真实 `ctx.nativeImage.dimensions`
    （`image 0.24` WASM）与真实 invalid decode 经 `ctx.imageQuality` 验证；该测试不触发
    encode，因此不需要 F7 分支的 `resizeAndEncodeJpeg`。
- **仍不等价/未闭合（仅剩真实 JPEG 路径）**（详见 `native-needs.md`）：
  1. main 没有编码器；F7 候选分支的 `resizeAndEncodeJpeg` 也尚未合入 main，
     不能用它宣称 main 已闭合；
  2. 只接受 RGBA8；16-bit / 灰度 / CMYK 会在缩放前量化，Rust 保留原始像素类型；
  3. 没有 Rust 生成的 byte-level/像素级交叉向量，F7 自己的 1200×900 用例只断言
     JPEG SOI 和尺寸；D5 JPEG PSNR 独立未签。
- **仍 pending 的测试**：
  - `image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions`
    （1200×900 low → 真实 JPEG 格式/尺寸/像素等价；需 F7 分支合入 main）
- **影响生产调用方**：L12 的 `pdf_processing_service.rs:483` 使用
  `adjust_image_quality_bytes("low")`。
- **解除条件**：F7 把 `resizeAndEncodeJpeg` 合入 main 后恢复第二条测试；若协调者接受
  带交叉向量和容差的编码降级，也可按裁定解除，但不改变 main 当前缺编码器的事实。


## 5. L20b：SQL 阶段观测与 SQLite busy 回调

详见 `L20B-OBSERVABILITY.md`。摘要：

- **S05（F3 已发布，L20b 待映射）**：F3 已给 `StorageError` 增加
  `phase: 'prepare' | 'bind' | 'execute'`（不解析文案），并在 `Connection` 的
  prepare / bind / execute 分层处打标；三条回归在 `tests/database.test.ts`。
  L20b 用 `iterate()` 区分首次 step 与后续遍历，列类型错误由 L20b 自己解码时产生。
- **S06**：Rust 测试用 `Connection::busy_handler` 暂停 contender，证明 writer 可以
  提交且 contender 不持有读锁。`better-sqlite3 13.0.3` 只调用
  `sqlite3_busy_timeout`（`database.cpp:167`），没有 `sqlite3_busy_handler`；
  `Statement.busy` 是同连接并发保护，不是锁争用回调。JS 层 sleep/重试不能证明
  busy handler 路径。需要 F7/架构师提供带 busy handler 的原生绑定；在此之前 L20b
  的 `tombstone_sequence_waits_for_writer_before_reading` 保持 pending，现有
  `[final-sequence only]` 补充用例明确不冒充 S06。

## 5.1 D1/D2/D4：公共事务 / 启动钩子 / worker 端口（已发布）

F3 已按协调者 D1/D2/D4 发布三个接缝，等待消费方接线：

- **D1/D4 journal**：`host/platform/storage/file-deletion-queue.ts` 的
  `prepareAssetDeletionWithConn` / `finishAssetDeletionWithConn` /
  `recoverWorkspaceDeletions` / `prepareWorkspaceDeletion` /
  `finishWorkspaceDeletion` / `cancelReadyWorkspaceDeletion` 现在只声明
  `SqlExecutor`；`NoteAssetRetention.assetIsReferenced` 也不再泄露
  `Database.Database`。表所有者仍是 L10，F3 不复制表写入；L10 需在同一事务中
  调 prepare + 删业务元数据，提交后再 finish。旧 notes 调用点的 raw 连接由内部
  运行时适配层兼容，L10 迁移完成后删除。
- **D2 finalizer**：`ctx.storage.registerFinalizer(name, fn, { after })` +
  `runStartupFinalizers()`；组合根在全部插件 apply 后调用，L21 恢复收尾、F2
  startupGate、L20b baseline 重试在这里挂接。F3 不 import 业务插件。执行失败保持
  failed/已完成列表，无自动重试；失败后的注册只抛错、不执行 callback。顺序与失败语义
  见 `API.md` §9。**F1 候选真实组合已过**：证据分支 `a612c4496`（F1 `5d373dbf2` + F3
  `9900d8dda`，测试 `7fdd36afe`）经 `serveHost` 使用真实 `StorageCordisService` +
  `StartupFinalizerRegistry` + F2 gate，job `20261104075748-2c9c0f` 8 passed / exit 0；
  F1 finishStartup 已在 main，F3 registry 尚待集成；集成后仍需重跑。注册失败是
  fatal / 插件 inactive / 可重试的政策边界尚未裁定，未裁定前不擅自全 fatal。
- **L13b worker**：`createDatabaseWorkerPool` + `workerTasks` 模块契约，worker 内
  自建连接、任务收到 `DatabaseHandle`，结果/业务 Err 以数据返回；不接受 SQL 文本。
  `pool.pause()`/`pool.resume()` 已提供暂停-在途 drain-terminate-恢复语义。仍需 L11
  确认 todo 仓储函数可直接接收 `SqlExecutor`，L13b 再用 `pool.run(...)` 替换
  “Promise 包同步 SQL”的假线程实现。**注意：worker 内每任务新建的 StorageService 不会
  自动被主线程维护屏障看到；必须由实际 parent `ctx.storage` 注册参与者（`pool.pause/resume`
  或 L11 `pauseAndDrain/resume`），否则备份/恢复不会冻结该连接。**

## 5.2 L03 精确 open 语义 / L11 worker 维护纳管（已发布，待消费）

- **L03 `readBudgetSettingFromFile`**：对应 Rust `Connection::open`，缺库创建、缺父目录打开失败。
  `OpenFileOptions.createParentDirs?: boolean` 已发布（默认 `true` 保持既有行为；`false` 不 mkdir，
  父目录存在时允许创建库文件）。缺父目录失败统一为
  `StorageError { code: 'SQLITE', sqliteCode: 'SQLITE_CANTOPEN', phase: 'execute' }`，L03 的
  `try/catch` 原 warn 日志可以保持不变。L03 应删除 `statSync(dirname(path))` 预检并改为
  `storage.openFile(path, { profile: { busyTimeoutMs: 2000 }, createParentDirs: false })`。
  真实文件回归见 `service.test.ts`：父目录存在缺库 → 创建；父目录缺失 → 不建目录、不建库、抛
  `SQLITE_CANTOPEN`；未显式设置 `createParentDirs: false` 时仍递归建父目录。
- **L11 `vfsWorker`**：`StorageService.registerMaintenanceParticipant(name, participant)` 已发布。
  L11 注册：
  ```ts
  ctx.storage.registerMaintenanceParticipant('vfsWorker', {
    databases: ['vfs'],
    enterMaintenance: () => worker.pauseAndDrain(), // drain + terminate 线程内连接
    exitMaintenance: () => worker.resume(),
  });
  ```
  F3 在关闭主线程连接前调用 enter、lease 释放后按注册逆序 exit；重叠 lease 按引用计数。
  L11 分支的 `src/worker-service.ts` 已实现 `pauseAndDrain(timeoutMs?)`/`resume()`（拒绝新请求、
  等待已接受请求与 short-lived search、terminate），只需在 `index.ts` apply 里注册；不得为异线程
  绕过维护另开裸连接。
- **测试覆盖**：`service.test.ts` 覆盖参与者进入/退出顺序、跨库 scope、引用计数、enter 失败回滚、
  维护期间拒绝注册；`worker-pool.test.ts` 覆盖 pause drain、排队任务在 resume 前不执行、
  resume 后重建执行，以及通过实际 parent `ctx.storage` 注册后 `enterMaintenance` 暂停/release 恢复。
- **消费者注册：候选与 main 分开核对（2026-11-04）**：
  - L11 候选分支 `30272e2c4` 的 `index.ts:160-174` **已按 F3 签名注册** `vfs-worker`
    （`databases: ['vfs']`，enter `await worker.pauseAndDrain()`、失败自行 `resume()`，exit
    `resume()`，卸载撤销）。这是候选接线，不是“完全未实现”。
  - L11 的消费者注册已在 main `index.ts:175-193`；main 仍没有 F3 的 `registerMaintenanceParticipant`，注册会因能力探测跳过；
    `host/plugins/vfs-repos/src/worker-entry.ts:40` 仍是 `new SqliteDatabase(...)`（正是需要被
    pause/drain 的线程内连接）；L13b 生产代码尚无 `createDatabaseWorkerPool` 调用。本分支
    merged tree 已有 L11 注册，不能继续称 L11 未写。
  - L11 测试 `tests/maintenance-registration.test.ts` 使用真实 worker + 注册接口替身，验证的是
    L11 接线与生命周期，不是 F3 真实维护屏障组合。因此 **main 待 F3 接缝集成**；F3 合入
    main 后必须在真实 `StorageService` 上重跑 `enterMaintenance`/release 才能签收。

## 6. F2/X4：启动接线

详见 `STARTUP-WIRING.md`。摘要：

- **已闭合**：F2 在 `electron/main.ts:66-72` 解析并导出
  `DS_MIGRATIONS_DIR`（打包 `Resources/migrations` / 开发态仓库目录），F3
  `index.ts:107-115` 读取它；无效目录启动即失败，有
  `startup.test.ts` 回归。
- **未闭合 A（W13）**：F3 purge 调 `ctx.get('storageStartupSync')`，但 main 全仓
  没有该服务；L20b 只发布 `syncSupport`，且 `inject: ['storage', 'notes']`，在 F3
  apply 时不可能就绪（`runtime.ts:257-264` 逐个 await 插件 apply）。只要启动时有
  purge 标记，`startup.start()` 会以 `startup_cleanup` 失败、业务库不打开。
  **正式时序已定**（见 `STARTUP-WIRING.md` §3）：L20 必须新增一个**不 inject
  `storage`** 的 pre-storage 插件（建议 `dstu.sync-startup`，`inject: ['paths']`），
  在 profile 中排在 `dstu.platform.storage` 之前，`provide('storageStartupSync', ...)`；
  其 `resetDefaultAfterLocalPurge` 用 F3 公开的 `syncStateDatabasePath(dataLocalDir)`
  独立打开 `sync_state.db`，按 Rust `state.rs:528-552` 在同一事务删除
  `consume_cursor` / `legacy_processed_key` / `tombstone_watermark` /
  `instance_binding` / `device_history`，保留 `upload_seq`。不能把服务挂在
  `sync-support`（会形成 storage 环），也不能用 `.sync_baseline_reset_pending`
  推迟到迁移后或 D2 finalizer（破坏“reset 成功后才清 purge 标记”的边界）。
  F3 侧已补齐 `syncStateDatabasePath` 契约与真实组合测试（provider 排在 storage
  之前、reset 时 storage 未发布、标记仍在、活槽已清空）；**L20 真实 provider 尚未
   合入 main，purge 标记路径仍 fail-closed**。安装顺序是 inject 拓扑与就绪顺序，
   不能按目录扫描推断；F1 正在核实 provider-before-storage 的最小显式保证，
   详见 `STARTUP-WIRING.md` §3。
- **F3-V2-06 自有 gate 消费**：main 已有 `dstu.shell` 官方 profile 条目（generate.ts:27,74）
  与 F1 `finishStartup`（connection.ts:111-127）。F3 本分支已补真实 gate 的 120s 等待、
  超时与状态读取错误映射；缺 gate 明确报配置错误。正在验证最小生产组合，未把这部分归为
  F2/X4 阻塞。finalizer 执行失败不 mark，不能建议 finally 无条件 Ready。

## 7. 解除顺序建议

1. **L12 图片接线**：L12 把 `deps.adjustImage` 改为
   `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)`，删除自有
   `image-codec.ts` 策略；真实 64×32 PNG/真实 invalid decode 已由
   `image-quality-service.test.ts` 覆盖，但 F7 的 `resizeAndEncodeJpeg` 未合入 main，
   `ctx.nativeImage` 仍不能直接作为 codec。
2. **F7 image**：决定严格 `image` 编码器或编码器降级 + 交叉向量。解除真实 JPEG
   格式/尺寸/PSNR 测试；F3 策略单元已完成。
3. **L16**：把 `fbed2b6c8` 已实现的 Agent Library/CAS 方法合入 main。解除剩余 2 条
   Anki 测试；`generic_anki_writes…` 已恢复 ported。
4. **C2 approvals 聚合**：已随 main 聚合；F3 只更新 TESTMAP 说明，不手改 ledger。
5. **L20b S05/S06**：F3 的 `StorageError.phase` 已完成，L20b 映射文案；S06 等
   F7/架构师的原生 busy handler。
6. **D2 接线**：L21 / L20b 在 apply 中注册 finalizer；F1 main 组合根在 installAll 后
   调用 `runStartupFinalizers()`，成功后再 mark startupGate。候选分支 `a612c4496` 已用真实
   registry 通过 8 项测试；main 合入后再重跑，并裁定注册失败的 fatal vs 插件 inactive 政策。
7. **L13b worker**：L11 确认仓储签名后，L13b 提供 `workerTasks` 模块并改用
   `createDatabaseWorkerPool().run()`；L11/L13b 同时注册维护参与者、接 `pause()/resume()`，
   确保备份/恢复关闭线程内连接。
8. **启动**：F2 gate / F1 mark 已在 main，F3 验证命令等待；W13 还需 L20 新增 pre-storage
   `storageStartupSync` provider（不 inject `storage`，排在 storage 之前）。两项都完成前，
   不宣称 Electron 启动链与 Rust `lib.rs` setup 等价。
