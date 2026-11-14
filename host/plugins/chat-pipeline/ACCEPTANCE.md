# L03-chat-pipeline 独立验收（R2-review-agent，2026-11-04）

结论：不通过

审读快照：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。此快照没有既有 ACCEPTANCE。本 lane **没有 IPC 命令**（`index.ts:349` 的 commands=[]，contracts/ipc 无 L03 命令文件）；不能抽出 15 条 `#[tauri::command]`。本次改为明确列出 15 个公开服务方法与 Rust 对照，不把它们计作 IPC。

## 必须修复

- [ ] **P1：完整execute/tool-loop/multi-variant仍未闭合。** 最新745463f6b已有history/persistence生产编排候选，不再笼统称全部仅helper；它仍不能代表完整pipeline通过。逐行统计该候选363 ported /83 pending /5 obsolete，固定main 3b2758d7a为362/89/0，必须区分候选与已集成。完整Rust入口对照 `pipeline.rs:599,705,1062`、`pipeline/multi_variant.rs:86,3053`；本轮仅更新状态，不扩审或重跑P1。
- [x] **P2：预算生命周期持久化已复核修复。** `95d9d7e5e` 的启动configure/restore、创建/轮换/超额/解绑best-effort快照及失败后重试已进入运行基线 `364e0f3e4`；`5d871ce9d` 同时解决新增文件读取接口的缺父目录副作用。真实插件/SQLite定向作业 `20261104061531-b747b9` 退出0，见本报告最新运行节；Rust 对照 `budget.rs:670-693,846-883,947-950,1007-1009`、`database.rs:95-96`。只关闭所列生命周期缺陷，不将完整管线P1或任意外层事务隔离保证视为已验证。
- [x] **P3：运行中预算已改为单调计时并保留恢复墙钟。** `a5a8ffa30` 已集成至 `364e0f3e4`；真实BudgetLedger回拨/前跳、超时、停机900秒及恢复后单调累积测试通过，作业 `20261104061531-b747b9` 退出0。Rust 对照 `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:281,293-333,363-373`，实现与断言静态证据见此前P3节。
- [ ] **P4：误标ported已纠正，生产memory-flush仍待L03完成。** 9dcccfe04已将五行退pending并保留断言，最新745463f6b的TESTMAP:122-129仍如此，不再派修“把五行改pending”。当前index:37只导入memory-flush两个纯函数，没有claim/worker/recovery生产消费；需要接 `pipeline/compaction/memory_flush.rs:572-618,737-865` 的生产worker/恢复及失败路径，不以现有仓储单测证明闭合。owner：L03编排、L17抽取/apply/receipt公开服务，详见08:21Z精确映射。
- [ ] **P5：越权DELETE已删除，receipt所有者清理调用待接入。** 9dcccfe04已移除L03直接SQL，不再称最新实现仍越权DELETE。L17候选6a0e276be已真实提供MemoryService.cleanupFlushReceipts(segmentId)，但未入固定main，L03最新745463f6b也无消费。需L03在账本完成后及policy-disabled skip后调用L17，并保留失败warn后继续；对应Rust `pipeline/compaction/memory_flush.rs:300-311,659-669,849-865`。接口已存在于候选，不能继续笼统说L17未发布；P5整项仍未闭合。
- [x] **P6：u64 原边界向量已恢复并亲跑通过。** `a5a8ffa30` 恢复reserve测试的三个u64::MAX输入及maxTokens期望，并补maxWallClockSeconds/u32 clamp；已集成至 `364e0f3e4`，作业 `20261104061531-b747b9` 退出0。对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:1457-1470`。已撤回的“缺文件只读”误报不计入本项。

### 协调者指令 1：P6 描述纠正（2026-11-04）

合并 main 后的核对点为 `c1b8765dc060687359e1c3bb8100cd1cbb6d894c`。原汇总把 `settings_read_from_main_db_file` 称作“缺文件只读测试”，该描述撤回，不再作为 P6 派修子项：

- Rust 原测试只断言 `nope.db` 返回 None、不 panic（`src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:1131-1135`）；实际生产函数使用普通 `rusqlite::Connection::open`，并无只读或 must-exist 标志，随后查询缺失的 settings 表，warn 后返回 None（同文件 `:573-598`）。原测试也没有断言文件不得创建。
- TS 用 `local.openFile(...nope.db)` 后调用真实 `readSettingWithConn` 并断言 null（`host/plugins/chat-pipeline/tests/budget.test.ts:143-144`）；仓储查询失败 warn 后返回 null（`host/plugins/chat-pipeline/repository/budget.ts:67-77`）。不能仅因连接由平台层打开，就判此断言改弱。
- 因此 P6 仅保留上列 **u64::MAX 向量被缩小**。这是审读报告的纠错，不是实现修复验收；P6 未勾选。未重复运行测试，原 Linux suite 退出0的证据仍仅对应初审快照。

## 04:40Z 补充指令：仅 P3/P6 分支静态复核

待验提交：`a5a8ffa30fee4e744db24e4d6ed96cc0b4d5f9a7`。以下行号均指 **该提交**，不指本工作树初审源码。已通过 `git show` 独立阅读实现及测试，静态修复方向符合 P3/P6；两项仍未勾选，待修复进入运行基线后完成指定 runner 验证。

| 编号 | 分支修复证据 | 真实生产入口 | 本轮结论 |
|---|---|---|---|
| P3 | `src/budget.ts:210-230` 默认以 performance.now 计运行时间，createdAtUnix 仍取 Date.now；restore 只在恢复点算墙钟停机差并钳0，随后使用独立单调时钟。`:249-256` 用累计停机差加单调差判超时，符合 Rust `budget.rs:293-333,363-373` 的职责划分 | `index.ts:244-251` → `getOrEnsureLedger/attachChildToTree`（`src/budget.ts:556-560,630-638`）→真实 BudgetLedger；恢复入口调用其 restored | 静态符合；`tests/budget.test.ts:66-87` 验证回拨/前跳不影响运行预算、10.001秒拒绝、恢复计900秒及后续单调增至903秒；未亲跑新测试 |
| P6 | `tests/budget.test.ts:364-373` 恢复三个 u64::MAX bigint 剩余量及 maxTokens 原期望，并补 maxWallClockSeconds、u32 clamp 断言；`:396-399` 的并发测试也恢复 u64::MAX token 上限 | `index.ts:249` → `src/budget.ts` 的 reserveChildSpec（保留真实生产函数调用，未替换为测试算式） | 原 Rust `budget.rs:1457-1470` 数值向量已静态恢复；未亲跑，暂不关闭 |

同提交 `src/llm-adapter.ts:260` 把 reset 的活动时间更新改为 touchActivity；该方法 `:441-442` 与 idleElapsedMs `:166-168` 共用 elapsed 时钟，`index.ts:280-282` 构造真实 adapter。新增 `tests/llm-adapter.test.ts:53-67` 断言 reset 后51ms、墙钟回拨不变、content 后20ms。仅记录指定关联测试的静态证据，不据此扩大 R2 验收范围或关闭 X5 编号。

**运行基线缺口**：本工作树 HEAD=`c53af794f`；核对时 main=`c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`。`git merge-base --is-ancestor a5a8ffa30 c7c15e5b5bfe139e11d2699bbd98bf9605d8beba` 退出1，修复尚未进入 main。按协调者要求，仅静态核分支后结束；未切分支、未摘取实现、未在旧源码上运行测试冒充修复验证。

待基线包含该修复后运行：`npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts host/plugins/chat-pipeline/tests/llm-adapter.test.ts`。**本轮真实 runner 状态：未启动，退出码不适用**。初审424通过的历史结果不能证明这次修复；P1/P2/P4/P5 未重新审查，维持原状态。

## P2/P4/P5 增量复核（95d9d7e5e、9dcccfe04、c0f8fd3be）

本节为独立静态复核；下面 TS 行号均指注明的候选提交，原审读结论保留历史快照含义。核对时运行 HEAD=`32eaa2d6a`、main=`d1b03dff9281f2e12df9b6602c1b17b06699713e`。`95d9d7e5e`、`9dcccfe04`、`a5a8ffa30` 对该 main 的祖先检查均退出1，修复未进入可运行基线；未运行旧源码代替候选验证，未采用实现者 Node/Electron“43 files / 435 passed”自述作为亲跑证据。

**P2 主修复静态符合，待集成运行：**

- 真实入口：`95d9d7e5e:host/plugins/chat-pipeline/index.ts:145-147` 在服务安装时配置从 `ctx.chatSession.database.getConnSafe()` 重新借连接，随后恢复；effect 返回清理函数。`src/budget.ts:72-97` 的旧 provider 清理不会取消后来绑定，恢复取连接失败 error 后继续。Rust 对照：`src-tauri/crates/dstu-agent/src/chat_v2/database.rs:95-96`、`budget.rs:714-724`。
- 写入时点：`src/budget.ts:585-610,634-643,667-684` 在账本插入/轮换后、绑定登记前写初始快照；tryConsume 仅拒绝时写，recordUsage 仅耗尽时写；release 先按代际解绑/归还活跃计数，再写快照。对应 Rust `budget.rs:846-883,947-957,997-1009`；普通成功扣减没有额外写盘。
- 日志/重试：`src/budget.ts:77-87` 未配置或指纹相同跳过；借连接错误保留 `pool get failed`，upsert 错误保留 root 上下文，统一 warn 后继续。只在 persistSnapshot 成功返回后标指纹，失败保留下一写入点重试，匹配 Rust `budget.rs:670-693`。
- 事务时点：热路径仍是一条同步 upsert，未另加事务或把事件塞入事务；调用后才标指纹。该判断限于当前明确写入点。L04 的 getConnSafe 返回平台数据库句柄（`95d9d7e5e:host/plugins/chat/src/service.ts:22-26`），不同于 Rust pool 独立借连接；目前完整业务编排尚缺，不能凭此断言在任意外层业务事务回滚下仍具有独立落盘保证。新增 lifecycle 测试未覆盖该情景，不把它当成已验证保证，也不在本次推定新增缺陷。
- 测试真实性：`tests/budget-lifecycle.test.ts:6-43` 使用真实插件/迁移 SQLite 验证安装恢复、初始0、成功扣减不写、解绑1、实报超额11、重复拒绝不重写、轮换清零；`:45-67` 仅故障注入一次 DB run，验证完整 warn 文案、不改变准入、后续真实 SQLite 重试成功及指纹去重。`tests/chat-host.ts:18-30,38-42` 在安装插件前 seed 真实表，不 stub 被测预算算法。**未亲跑，不关闭 P2。**

**新增 readBudgetSettingFromFile 的普通 open 语义：** `95d9d7e5e:index.ts:256-257` → `repository/budget.ts:81-91` 使用独立 openFile、busyTimeoutMs=2000、finally close；缺 key/缺表回退 null 与 Rust `budget.rs:573-598` 主分支一致，未要求只读或文件不得创建。另有真实增量差异：平台 `host/platform/storage/connection.ts:63-64` 会递归 mkdir 父目录，Rust Connection::open 不创建缺失父目录；因此新测试 `tests/budget.test.ts:172` 的 absent-parent 路径在 TS 可能创建目录/空库并走“读取 settings 失败”，Rust 应走“打开主库 settings 失败”。当前断言只检查 null，不能证明这两个分支等价。该问题列为 **P2 文件读取增量待对齐（L03/F3）**，不是恢复已撤回的 P6“只读”指控；不要求改成只读打开。

**P4 账本纠正子项静态确认：** `9dcccfe04:TESTMAP.md:119-120,124-126` 将原5个错误 ported 改回 pending，3个已发布纯函数测试仍为 ported；同提交 `tests/memory-flush.test.ts` 相对父提交无变化（`git diff --exit-code ...` 退出0）。实际逐行计数为 **362 ported / 89 pending**，`c0f8fd3be:TESTMAP.md:17` 已补实际统计说明，但生成表头 `:12` 仍是367/84，待同步。仅纠正状态不代表 flush 已接入；运行基线未合入，P4 保持未勾选。

**P5 仅越权 SQL 子项移除：** `9dcccfe04` 删除 `repository/memory-flush.ts` 原 `:287-291` 的 cleanupMemoryFlushReceiptsWithDb 及直接 DELETE。未添加 L17 公开 cleanup 调用；Rust `pipeline/compaction/memory_flush.rs:300-308` 的清理职责仍待所有者 API 接入，**P5 不整体关闭**。P1 完整管线未完成，本轮不扩审。

**真实 runner：未启动，退出码不适用。** 集成后一次最小复核命令：`npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts host/plugins/chat-pipeline/tests/llm-adapter.test.ts host/plugins/chat-pipeline/tests/budget-lifecycle.test.ts`。没有新的 Node/Electron 或跨平台通过结论；P3/P6沿用上一轮静态结论，所有勾选保持不变。

## 06:00Z 指令后的集成定向验收（最新状态）

已按指令合并 main，运行基线 **`364e0f3e4fb2884c942c2814567494d6754182f5`**（合入main `15b23540a97ee19e1391859c3bc140e5c0daa182`）。祖先检查确认 `a5a8ffa30`、`95d9d7e5e`、`9dcccfe04`、`a7fdaf010`、`5d871ce9d` 均在此基线，退出0；本节覆盖此前“候选不可运行”的历史状态。

| 编号 | 修复与实际入口 | 亲跑证据及结论 |
|---|---|---|
| P2 | `95d9d7e5e`：index服务启动configure/restore及公开预算方法→生产BudgetLedger→真实chat数据库；生命周期/日志时点见前节。`5d871ce9d`：`repository/budget.ts:84-100` 在openFile前检查父目录，缺父目录保留打开失败分支 | `tests/budget-lifecycle.test.ts:8-22` 断言目录仍不存在、openFile未调用、完整warn；`:24-60` 验证恢复/各落盘时点；`:64-84` 验证失败不标指纹、下一超额写入点真实重试。全部通过，P2关闭 |
| P3 | `a5a8ffa30`：生产BudgetLedger使用performance.now，恢复停机仍用Unix时间锚点 | budget.test.ts校时/恢复测试通过，P3关闭 |
| P6 | `a5a8ffa30`：公开reserveChildSpec及真实u64向量 | budget.test.ts原u64::MAX断言及新增收窄断言通过，P6关闭 |

按架构师要求使用全局队列：

```text
$ node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts host/plugins/chat-pipeline/tests/llm-adapter.test.ts host/plugins/chat-pipeline/tests/budget-lifecycle.test.ts
20261104061531-b747b9

$ node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104061531-b747b9
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 ✓ host/plugins/chat-pipeline/tests/llm-adapter.test.ts (15 tests) 24ms
 ✓ host/plugins/chat-pipeline/tests/budget.test.ts (16 tests) 130ms
 ✓ host/plugins/chat-pipeline/tests/budget-lifecycle.test.ts (3 tests) 13821ms
 Test Files  3 passed (3)
      Tests  34 passed (34)
   Start at  14:15:32
   Duration  21.25s
[作业 20261104061531-b747b9] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061531-b747b9.log
```

已读取完整result输出，只有WASI ExperimentalWarning，没有 Errors 报告行或未捕获错误。Node定向验证通过；本轮未运行Electron、Windows/macOS。P1/P4/P5继续未决，lane结论仍不通过；P4状态回退与P5删除SQL的证据保留，不据本次预算测试关闭其他项。下方初审表及旧快照“缺陷”列表为历史记录，以本节及最上方复核勾选为最新状态。

## 后续建议

- 预算服务真实插件入口/SQLite验证建议已由budget-lifecycle落实，证据见最新运行节。
- [ ] 修正共享 wiring 门禁为逐被测符号/模块验证；“文件里有一个 import 可达”不足以证明每条 ported 已进入生产。

## 已核实通过

- [x] **复核确认**：chatPipeline 名称/版本、meta.provides 与 Service 注册一致（`host/plugins/chat-pipeline/api.ts:476-479`、`host/plugins/chat-pipeline/index.ts:134-136,348-351`）。无虚构发送 IPC 注册。
- [x] **复核确认**：所查预算内存算法保留 saturating u64 加减、原子 all-or-nothing、按代际释放绑定和耗尽且闲置时轮换；快照大数使用 JSON source/rawJSON，未经 Number 丢失高位（`src/budget.ts:186-194,287-317,406-462,597-605,629-650`，本节相对路径以 `host/plugins/chat-pipeline/` 为前缀）。P2/P3 不因此豁免。
- [x] **复核确认**：摘要失败不提交、提交失败不 flush 的测试调用真实 runSummaryCommitPost；Rust 原测试本身也是注入三个回调，不属于伪造测试替身（TS `tests/compaction-outcome.test.ts:23-60` / Rust `pipeline/compaction.rs:1945-1995`）。
- [x] **复核确认**：亲跑 40 文件/424 用例通过，原生导入及 wiring 通过；strict 无未豁免违规。跨插件 import 经 api.ts、没有发现生产 console 或测试模块 import；表所有权存在 P5。
- [x] **复核确认**：TESTMAP 实际 367 ported / 84 pending / 0 obsolete / 0 merged，表头准确（`TESTMAP.md:12`），没有 obsolete/merged 审批需求；但 P4 的 ported 状态需纠正。

## 服务等价：15 项（非 IPC 命令）

简称：B=`host/plugins/chat-pipeline/src/budget.ts`；C=`host/plugins/chat-pipeline/src/compaction-outcome.ts`；R=`src-tauri/crates/dstu-agent/src/chat_v2/budget.rs`；RC=`src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`。这些方法由 `index.ts:236-247,267-274` 发布。

| # | chatPipeline 方法 | 结论与核对内容 | TS / Rust 证据 |
|---|---|---|---|
| 1 | resolveBudgetLimits | 通过：正整数 setting、非法逐维 warn+回默认、+号及 u64 上界 | B:99-133 / R:125-148 |
| 2 | effectiveBudgetLimits | 通过：实时 settings 覆盖默认，读失败日志后回退 | B:78-92 / R:573-604 |
| 3 | attachChildToTree | 问题 P2/P3；parent root 复用、代际、仅 idle exhausted 轮换、子预算 min 一致 | B:629-660 / R:912-975 |
| 4 | treeKeyForSession | 通过：未绑定 null，子/孙同根 | B:547-548 / R:834-837 |
| 5 | budgetLedgerForTree | 通过：不存在 null，存在返回同一 ledger | B:551-552 / R:841-842 |
| 6 | tryConsumeTreeBudget | 问题 P2/P3；wall→calls→tokens 检查、拒绝不扣、u64 饱和保留 | B:287-309,568-570 / R:412-440,866-873 |
| 7 | recordTreeUsage | 问题 P2/P3；实报允许越顶、返回饱和剩余一致 | B:313-317,573-574 / R:445-451,877-884 |
| 8 | reserveChildSpec | 通过实现：工具次数收窄 u32，其余保持 u64，缺声明继承；测试有 P6 | B:362-377 / R:511-528 |
| 9 | persistBudgetSnapshot | 通过显式调用：JSON 整数不加引号、upsert、chrono +00:00、失败带 root；不代表自动调用成立 | B:422-425,465-474、repository/budget.ts:44-54 / R:639-670 |
| 10 | restoreBudgetLedgersFromDb | 通过主体：无表 no-op、坏行跳过、已有 ledger 不覆盖；恢复后运行计时有 P3 | B:481-525 / R:714-797 |
| 11 | compactionStatus | 通过：compacted/notNeeded/skipped/failed 原码 | C:30-33 / RC:149-155 |
| 12 | compactionReasonCode | 通过：Compacted=null，其余原 reason，未替换为 undefined | C:35-37 / RC:158-162 |
| 13 | cooldownSecondsForOutcome | 通过：failed=120，指定 notNeeded=60，其余 null | C:58-66 / RC:204-212 |
| 14 | validatedCompactionModelId | 通过：Rust trim，缺省/null/空串为空；无副作用 | C:70-74 / RC:215-217 |
| 15 | runSummaryCommitPost | 通过：summary→persist→post，None/false/错误均短路，事务职责在 persist 回调 | C:85-100 / RC:220-239 |

日志核对：settings 读失败 warn、snapshot 读失败 error、坏行 warn 均有 logger；坏 JSON 的 parse 细节被统一为 `limits_json/usage_json parse failed`（B:495-504），按 decisions.md:34-35 的诊断差异记录，不宣称逐字日志等价。P2 则是整个落盘与失败日志分支缺失，不能作为诊断细节豁免。

## ported 测试真实性：22 条

下表前 14 条映射在 `TESTMAP.md:20-33`，TS=`host/plugins/chat-pipeline/tests/budget.test.ts`，Rust=R。它们直接测生产 BudgetLedger/仓储，非替身；通过表示列明原断言保留，生命周期的生产集成保证仍受 P2/P3 限制。

| 原测试名 | 结论及断言对照 | TS 行 / Rust 行 |
|---|---|---|
| settings_resolve_limits_valid_and_invalid | 通过：默认、合法覆盖、五种非法逐维回退、空白；另补 bigint 向量 | 65 / 1058 |
| settings_read_from_main_db_file | 通过所查原断言：真实 SQLite settings/key/非法值与默认、nope.db 返回 null；Rust 实际普通 open，并非只读打开（纠错见 P6 说明） | 129-149 / 1104-1144；生产读取 R:573-598 |
| snapshot_persist_and_restore_roundtrip | 通过：三计数/上限/createdAt、恢复继续累积、重复恢复不覆盖 | 152 / 1150 |
| snapshot_restore_preserves_exhaustion | 通过：停机 7200 秒及工具次数耗尽，恢复后仍拒绝 | 185 / 1183 |
| snapshot_restore_tolerates_missing_table_and_bad_rows | 通过：缺表不抛、坏行跳过且好行恢复 | 222 / 1264 |
| tree_aggregation_parent_and_two_children_share_one_ledger | 通过：总数3、bindings2、release 后两子解绑 | 246 / 1318 |
| grandchild_rolls_up_to_same_root | 通过：孙共根、消耗汇总 | 274 / 1357 |
| exceed_blocks_without_going_negative | 通过：calls/tokens all-or-nothing、实报越顶、wall耗尽；wall 使用注入时钟 | 287 / 1379 |
| reserve_shrinks_child_cap_when_parent_low | 问题 P6：一般 min/继承保留，但 u64::MAX 改弱 | 327 / 1426 |
| sub_calls_accounted_into_tree | 通过：同 session 模拟子调用 1+3+2 共6；Rust 亦模拟该层 | 350 / 1477 |
| concurrent_consume_is_race_free | 通过所需单线程模型：8任务×50，await 交错，精确200成功、不超扣；非 worker-thread 共享内存保证 | 367 / 1501 |
| binding_guard_respects_generation | 通过：旧代 release 不删新代，active 精确归还 | 390 / 1534 |
| exhausted_and_idle_ledger_rotates_on_next_attach | 通过：活绑定不轮换、全释放后新实例计数0 | 411 / 1556 |
| exceeded_message_is_explicit | 通过：原中文、used/limit、工具名、最终回答、运行时长 | 442 / 1595 |

第 2 条“缺文件只读”指控已按生产源码撤回；没有原断言要求只读打开或禁止创建文件，不再要求为此重映射平台测试。P6 仍针对第 9 条的 u64 边界向量。

| 原测试名 | 结论及同一行为 | TS / Rust 证据 |
|---|---|---|
| summary_failure_prevents_transaction_and_memory_flush | 通过：None 返回，persist/post 次数均0 | tests/compaction-outcome.test.ts:23 / RC:1945 |
| transaction_failure_prevents_memory_flush | 通过：错误传播，persist1/post0 | tests/compaction-outcome.test.ts:43 / RC:1972 |
| cooldown_duration_mapping | 通过：120/60/null 原映射 | tests/compaction-outcome.test.ts:106 / RC:2058 |
| missing_or_malformed_memory_settings_fail_closed | 问题 P4：原断言保留但仓储不在生产路径 | tests/memory-flush.test.ts:50 / src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:1005 |
| privacy_and_auto_extract_off_disable_memory_flush | 问题 P4：privacy/off 两分支保留但未接线 | tests/memory-flush.test.ts:59 / 同一 Rust 文件:1024 |
| legacy_memory_flush_ledger_backfills_stable_ordinals | 问题 P4：真实 SQLite 两旧行回填0/1但未接线 | tests/memory-flush.test.ts:99 / 同一 Rust 文件:1091 |
| claim_never_overtakes_an_earlier_segment_in_the_same_session | 问题 P4：首段未完成次段不可claim，完成后可claim；未接线 | tests/memory-flush.test.ts:121 / 同一 Rust 文件:1125 |
| ledger_enqueue_rolls_back_with_compaction_transaction | 问题 P4：真事务回滚后count0；未接线 | tests/memory-flush.test.ts:141 / 同一 Rust 文件:1175 |

## 亲自运行：原始输出摘要

Linux / Node v26.5.0，以下退出码均 0。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 Test Files  40 passed (40)
      Tests  424 passed (424)
   Start at  11:37:00
   Duration  37.23s

$ node scripts/electron-migration/wiring.mjs --lane chat-pipeline
合计 ported 367，其中所测模块未从 index.ts 接入 0（0.0%）

$ node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts host/plugins/agent-orchestration/index.ts host/plugins/chat-pipeline/index.ts
importable: ok
(node:74395) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/agent-workspace host/plugins/agent-orchestration host/plugins/chat-pipeline
boundaries: scanned 264 files, 0 violation(s), 15 suppressed via boundary-allow
```

输出还包括 llm-content-crash 13 tests、llm-content-retry-gap 7 tests 全绿；其 TESTMAP 已保持 pending，这 20 个测试内模拟用例未作为本次通过证据。

## 语义差异分类

**缺陷/未完成（应修）**：P1 完整执行与84 pending；P2 热路径落盘缺失；P3 非单调计时；P4 仓储未接线但 ported；P5 越界写表；P6 u64 向量改弱。“缺文件只读”描述撤回，见 P6 纠错证据。

**已登记但非平台豁免**：`SPEC.md:56-66,115-121` 记录模拟测试/完整执行时序未闭合，`src/budget.ts:8-10` 注释说明热路径未接线；两者均不能替代功能。**已接受平台差异**：`docs/dev/electron-migration/decisions.md:34-35,52-59` 的诊断文本及毫秒时间精度。使用 bigint 保留快照整数是已核实的正确实现；Date.now 受校时影响不在该豁免内。

## 08:21Z P4/P5精确生产续作映射

候选固定 `745463f6b4efad030e0cf2b982fedeb859105182`，main固定 `3b2758d7a`。本轮只检查P4/P5相关导入、实际所有者实现与Rust调用点；不重跑P2/P3/P6、不扩审history/persistence新工作。

| 编号 | 最新关键证据 | owner及未修的精确场景 |
|---|---|---|
| P4 | 745463f6b的index.ts:37只导入buildMemoryFlushSegmentId/splitMemoryFlushSegment；生产src/api/index未检出claimNextPendingMemoryFlush或flush worker消费。TESTMAP:122-123,127-129五行已pending，:130崩溃恢复仍pending | **L03自有生产编排**：接恢复/锁/策略→按序claim→复用已存extraction/receipt→逐项进度→完成账本；L17供抽取/apply。Rust `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:572-618,737-865`。复现/验收：预置两同session待处理段，第二段不得越过首段；在抽取已存、部分fact落receipt后中断重启，不再次抽取、不重复写已落fact，完成后账本/进度正确。对应原测试:1125-1171、1201-1412。纯函数和孤立仓储测试不能完成此项 |
| P5 | L03越权DELETE已删。L17 `6a0e276be:host/plugins/memory/api.ts:181-188` 正式声明query/get/cleanup；`src/service.ts:879-880`真实委托所有者，`repository/idempotency.ts:91-103,159-160` 按segment的fact前缀删除，**不是只有类型** | **L03消费L17**（候选未合main，且745463f6b未调用cleanupFlushReceipts）。Rust memory_flush.rs:659-669策略关闭先skip再逐段清理，:849-865先complete账本再best-effort清receipt，失败warn继续。验收：成功与privacy/off两路径均删除该段receipt、保留他段；注入cleanup失败，不回滚completed/skipped、不重放已完成工作，记录对应warn |

L17接口候选已提供，不再将P5记为“接口不存在”，也不得恢复L03直接SQL。原清理函数Rust `memory_flush.rs:300-311` 的固定错误上下文需在所有者/调用层分工中保留。745463f6b、6a0e276be对固定main祖先检查均退出1，暂无合并后的完整生产链，本轮没有测试作业或runner退出码/Errors；不继承实现者回归结果。P4状态纠正与P5越权SQL移除是已确认子项，整项按协调者要求保留到生产闭合。
