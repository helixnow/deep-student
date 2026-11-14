结论：完成，WP-C2-VERIFY-019 在固定 main 33d1323a9 独验通过并签收 VERIFY009 N1 REAL 错误名子项；单文件 12 passed / 0 failed / 0 skipped、Errors 0，完整证据见文末本包专节。

# R2-review-agent 独立复核汇总（2026-11-04）

**最新结论（v2）：原19项已关闭11项（新增W1/O6），剩8项；原三lane仍不通过B。** 新增chat补审不通过，列C04-01…08八个新finding并复用X5-01；L06另引用已派修X6-UD-L06-01，不重复造编号。下方保留历史审读轨迹，以各ACCEPTANCE首节及文末最新证据为准。

## 初审范围与快照（v2新增范围及复验见文末）

- 工作树：`/home/dsdev/dev/ds-mig/R2-review-agent`；分支：`ds-mig/R2-review-agent`。
- 实现快照：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。中断恢复后按要求检查 git log/status，HEAD 未变、工作区干净，未重复既有测试。
- 撰写期间协调者自动生成了检查点（包括 `eff8b2906`、`4740343bc`、`806780a45`）；本分支累计差异仅包含本审读者撰写的四个允许文件，未改变实现快照。交付应合入本分支相对上述实现快照的完整报告差异，而非只摘取最后的补充提交。
- 只写三个 ACCEPTANCE 和本报告；未修改实现、测试、SPEC、TESTMAP、审批、ledger，未编译/运行 Rust。
- 依据：`docs/dev/electron-migration/README.md:162-207`、`quality.md`、`docs/plugins/ARCHITECTURE.md`、IPC 契约、Rust/TS 源码和亲跑结果。SPEC/decisions 仅用于核对“是否登记差异”，不作为实现正确性证明。
- 三个目录在此快照均没有原 ACCEPTANCE；报告中的“复核确认”均有本次源码或运行证据。
- 命令抽查数量限制如实处理：L05 全部 **12 IPC + 3 服务**；L06 全部 **17 IPC**；L03 **0 IPC + 15 服务**。后两种服务抽查均明确标为非命令，未凑造不存在的 `#[tauri::command]`。抽查原 ported 测试分别 **15 / 15 / 22** 条，共52条，逐项对照表见各 ACCEPTANCE。

## 汇总表

问题数按 ACCEPTANCE 的编号修复单元计，不按受影响命令数计；建议不计入。

| Lane | B 结论 | 必须修复数 | 亲跑 Vitest | 最严重的 3 个问题 |
|---|---|---:|---|---|
| L05-agent-workspace | 不通过 | 3（W1/W5已关） | W1最新1测试通过/13筛选跳过、exit0；此前4文件17通过 | W2真实三插件删除链；W3目标平台未验；W4剩余pending |
| L06-agent-orchestration | 不通过 | 原O项2 + X6复用1 | 最新6定向测试通过/67筛选跳过、exit0；此前87通过及O8协议探针 | O1完整runner/真实启动组合；O7真实L04导入链；X6 trustedProfile解码 |
| L03-chat-pipeline | 不通过 | 3（原6，P2/P3/P6已关） | 初审40文件424通过；最新定向3文件34通过、exit0 | P1 完整管线未闭合；P4 状态已退pending但生产接线/统计仍待闭合；P5 L17 cleanup接线仍缺 |
| L04-chat-session（v2新增） | 不通过 | 8新项 + 复用X5-01 | 抽查6文件126通过、exit0；2个缺陷探针exit0（复现失败行为） | C04-01导入panic；C04-02删除漏清理；X5-01无完整发送入口 |

详细结论：

- [L05 ACCEPTANCE](../../../../host/plugins/agent-workspace/ACCEPTANCE.md)
- [L06 ACCEPTANCE](../../../../host/plugins/agent-orchestration/ACCEPTANCE.md)
- [L03 ACCEPTANCE](../../../../host/plugins/chat-pipeline/ACCEPTANCE.md)
- [L04 v2 ACCEPTANCE](../../../../host/plugins/chat/ACCEPTANCE.md)

## 全部修复项索引

| 编号 | 问题 | 派回建议 |
|---|---|---|
| W1 | 前缀/主分支已亲跑；错误优先级候选a41769ee4/0dc99b5df已静态修复，待集成最小复验 | L05 / 集成 |
| W2 | L21真实guard已main；L05消费与L04删除有候选，待三插件真实整链 | L05 联合 L04/集成；L21提供方已有 |
| W3 | Windows handle 身份不等价、AppContainer runtime 固定拒绝 | L05 联合 F7 |
| W4 | 最新main及候选16 pending；21 obsolete批准/loader已解决，表头与完整闭合仍待 | L05/L04/F7 + 协调者统计 |
| W5 | 合法 usize cursor 被 Number.isSafeInteger 拒绝 | L05 |
| O1 | 通知顺序/retry及局部门控候选已修；完整runner/正式启动链未闭合；run失败规则已定，仅register政策待裁定 | L06 + L03/L04/F1/F3/F2 |
| O2 | 待办调用旧服务名 vfs.repo.core@1，提供方已是 vfsRepo | L06 |
| O3 | ensure disabled 短路/成功事件缺失；提前取依赖改变失败分支 | L06 |
| O4 | schedule 的省略字段被输出为 null | L06 |
| O5 | create/update/delete 事务文案扁平化；update ID 用 JS trim | L06 |
| O6 | 日志与取消事件候选已修，待集成后精确事件序列亲跑 | L06 / 集成 |
| O7 | SQL/Writer已替换为三*WithConn，legacy原边界候选已恢复；真实L04消费未闭合 | L06 联合 L04 |
| O8 | kill-switch 普通 Error 逃逸，变 Host handler panic | L06 |
| P1 | helper 集合尚未构成完整执行管线，84 pending | L03 联合依赖方 |
| P2 | 预算创建/超额/解绑的快照副作用和生产恢复接线未闭合 | L03 联合 L04 |
| P3 | Date.now 替代 Instant，校时会改变运行中预算 | L03 |
| P4 | 五行已退pending；生产memory-flush worker/recovery仍缺 | L03自有编排，L17供抽取/apply |
| P5 | 越权DELETE已删；L17真实cleanup API候选已有，L03尚未消费 | L03 联合 L17/集成 |
| P6 | u64::MAX 原向量改弱；“缺文件只读”指控撤回，见续审纠错证据 | L03 |

## 亲跑检查与原始输出摘要

环境 Linux，Node `v26.5.0`，Vitest `v3.2.7`。三次 suite 均退出0；共104文件、1118通过、21跳过。完整逐 lane 摘要已放入对应 ACCEPTANCE。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace
 Test Files  33 passed (33)
      Tests  396 passed | 21 skipped (417)
   Start at  11:35:02
   Duration  13.43s

$ npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration
 Test Files  31 passed (31)
      Tests  298 passed (298)
   Start at  11:35:52
   Duration  29.80s

$ npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline
 Test Files  40 passed (40)
      Tests  424 passed (424)
   Start at  11:37:00
   Duration  37.23s

$ node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts host/plugins/agent-orchestration/index.ts host/plugins/chat-pipeline/index.ts
importable: ok
(node:74395) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ node scripts/electron-migration/wiring.mjs --lane agent-workspace
合计 ported 354，其中所测模块未从 index.ts 接入 0（0.0%）
$ node scripts/electron-migration/wiring.mjs --lane agent-orchestration
合计 ported 239，其中所测模块未从 index.ts 接入 0（0.0%）
$ node scripts/electron-migration/wiring.mjs --lane chat-pipeline
合计 ported 367，其中所测模块未从 index.ts 接入 0（0.0%）

$ DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/agent-workspace host/plugins/agent-orchestration host/plugins/chat-pipeline
boundaries: scanned 264 files, 0 violation(s), 15 suppressed via boundary-allow
```

初次传 `--strict` 的 boundaries 运行只启用了普通模式；检查实现后用上面的环境变量真正启用 strict。只以第二次作为 strict 证据（`scripts/electron-migration/lib/boundary-rules.mjs:19-20`）。15条豁免都在 L05；例如忽略关闭状态更新失败符合 Rust 的 `let _`，不能无差别判为丢日志。O6 的非空 catch return 则确实丢掉 Rust warn。

中断恢复按用户指令执行，退出1：

```text
$ npm run migration:ledger -- --check --no-write
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

该250为**全仓**统计，未归因到本次三个 lane。只读逐行统计独立得到：

```text
agent-workspace {"obsolete:":21,"ported:":354,"pending":26} obsolete approved 0
agent-orchestration {"ported:":239} obsolete approved 0
chat-pipeline {"ported:":367,"pending":84} obsolete approved 0
```

另用 `node --input-type=module` 内联调用真实生产函数作只读/纯内存探针：授权列表读取 `{}`；撤销技能信任的 settings.delete 抛 `storage failure`；默认 heartbeat 列表映射；预算注入时钟从1000→7000→0。无文件/数据库写入。输出：

```text
W1 non-array authorized records: []
W1 revoke error: storage failure
O4 schedule: {"kind":"interval","time":"","weekday":null,"weekdays":null,"day_of_month":null,"interval_minutes":30,"date":null,"timezone":null}
P3 elapsed before rollback: 6
P3 elapsed after rollback: 0
```

Rust 源码预期分别为：非数组反序列化错误；`Failed to revoke skill trust: ...`；省略 Option::None 的 schedule 字段；Instant 不因墙钟回拨从6变0。具体文件:行见 W1/O4/P3。

## 共性问题：建议协调者回灌规范

1. **发布 helper/声明服务不代表生产步骤闭合（三个 lane）。** W2、O1、P1/P2 均有真实代码与绿色测试，但生产接缝仍缺失或固定抛错。必须分别核对提供方、实际消费方、成功/失败副作用；记录“缺依赖”不构成 B 通过。
2. **成功用例掩盖错误上下文/事件丢失（L05、L06）。** W1、O5/O6/O8 表明必须将固定业务前缀、warn后继续、提交后事件、CommandError 与普通 Error 分开审读。Host panic 会不回复，不能用一般 toThrow 代替 IPC 错误断言。
3. **只限制 SQL 目录不能保护表所有权（L06、L03）。** O7、P5 均将跨域写 SQL 放进自己的 repository，扫描依然0违规。所有者需发布事务语义接口，调用方不能复制其 CRUD。
4. **测试总数/ported 数/接线可达性是不同事实（三个 lane）。** W4 有过期统计与审批接入缺口（21项 obsolete 已获协调者批准）；L06 固定失败接缝也被测试为通过；P4 有 wiring 假阴性、P6 的 u64 原断言变弱。应要求逐原测试核对主体、原断言、实际生产调用点。

### 本次直接证实的 wiring 盲点

`scripts/electron-migration/wiring.mjs:50-64` 用所有插件入口的全局可达集，`:75-79` 用 `subjects.some(...)` 判断整测试文件；同文件混入一个可达模块即可让未接线被测模块的全部映射通过。L03 `tests/memory-flush.test.ts:7-13` 恰好同时导入未接线 repository 和已发布纯函数。建议协调者修正门禁；本次严格遵守写入范围，只记录证据。

## 已登记的平台差异与真实缺陷的边界

`decisions.md:34-35,52-59` 已接受有限的日志/IO诊断文本差异和时间精度差异。各 lane SPEC 还登记了 Number 限制、Windows 原生缺口、headless/send/删除服务缺口。后者属于待完成项，不能据“已登记”免除修复；没有证据表明协调者批准省略固定业务错误前缀、放弃预算落盘、无视开关或改变 null/省略语义。

修复后需按各 ACCEPTANCE 的未勾选项逐条复核，当前不授予任何 lane B 级。

## 协调者指令 1：续审与 P6 纠错（2026-11-04）

已执行 `git merge main`（退出0），合并提交 `c1b8765dc060687359e1c3bb8100cd1cbb6d894c`，合入 main `29bc10a470c9d50ed80671cfb232c0bdee972b1b`。相对上轮交付，三个 lane 只有 L05/L06 文档及 TESTMAP 更新，无实现/测试变更；未将其他 lane 新提交算作本次编号修复。合并动作引入 main 的其他文件，本轮主动编辑仅限三个允许的报告文件。

### P6 第二种描述的证据与派修纠正

原汇总及 L03 测试表称“缺文件只读测试被改弱”，该描述有误并撤回。Rust `budget.rs:573-598` 实际调用 `rusqlite::Connection::open(db_path)`，不是只读/must-exist 打开；原测试 `:1131-1135` 仅断言新路径 nope.db 返回 None，不断言文件不得创建。TS `host/plugins/chat-pipeline/tests/budget.test.ts:143-144` 先经平台 openFile 再调用真实 `repository/budget.ts:67-77`，缺表错误仍 warn 并返回 null。这不足以构成原行为改弱的证据，不应派发额外“只读打开”实现任务。

P6 继续只指 **reserve_shrinks_child_cap_when_parent_low 的 u64::MAX 向量**：TS `tests/budget.test.ts:340-347` 对 Rust `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:1457-1470`。已同步 ACCEPTANCE 的必须修复说明、测试表及语义差异清单。仅纠正报告范围，未勾选或宣告 P6 修复；问题编号总数仍19。

### 编号 → 修复提交 → 真实生产入口 → 本轮测试状态

| 编号 | 已合入的修复提交/证据 | 真实生产入口（待复核点） | 测试命令与退出码 |
|---|---|---|---|
| L05 W1/W5；receiver | 本次 main 无对应实现/测试变化；receiver 待提交及明确复现/编号 | `agent-workspace/index.ts:102-187` 的 IPC；receiver 具体入口待提供，未自行编号 | 未运行；收到修复后按入口定向选择测试，退出码不适用 |
| L05 W4 obsolete 子项 | 协调者04:25Z已确认21项逐ID批准；本地 approvals.json 仍未合入该记录，尚无可引用审批提交 | `migration/approvals.json` → ledger 消费；pending/统计仍待闭合 | 未运行 ledger；退出码不适用；不重复申请批准、不勾整项 |
| L06 O2–O8 | 本次 main 只有 BLOCKERS/LANE/SPEC 更新，无实现/测试修复提交 | `agent-orchestration/index.ts` 的命令/调度 provider；O7 session import 须经表所有者服务 | 未重复 `npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration`；本轮退出码不适用，初审退出0仅作历史证据 |
| L03 P2–P5 | 本次 main 无该 lane 实现/测试变化 | `chatPipeline` 预算服务（index.ts:236-247）及待接线 memory-flush 流程 | 未重复 `npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline`；本轮退出码不适用 |
| L03 P6 | 无实现修复提交；本次仅报告纠错、保留 u64 向量问题 | `chatPipeline.reserveChildSpec` → `src/budget.ts:370-377`；该函数原已发布 | 未重复 `npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts`；本轮退出码不适用 |

本轮文档检查：`git diff --check` 退出0；Python 对比 HEAD 与编辑后全部 Markdown checkbox 状态，退出0（`Report checkbox states unchanged; P6 remains open.`）。未将文档检查记为实现测试。

W2/W3、O1、P1 及跨平台未验证项仍保留；没有新的 Windows/macOS 动态证据。按指令结束本轮文档校正，等待上述修复编号与提交后逐项复核，不提前改变验收勾选。

## 04:40Z 补充：P3/P6 新提交静态复核

仅核 `a5a8ffa30fee4e744db24e4d6ed96cc0b4d5f9a7` 的新改动；P6“缺文件只读”误报未重新测试。当前运行基线 `c53af794f`，核对的 main 为 `c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`；修复提交不是此 main 的祖先（`git merge-base --is-ancestor a5a8ffa30 c7c15e5b5bfe139e11d2699bbd98bf9605d8beba` 退出1）。按指令走“main尚无修复”分支，只读提交内容后结束，无 cherry-pick/实现修改或旧基线重测。

| 编号 | 修复提交 | 真实生产入口及证据（行号属修复提交） | 指定 runner / 真实退出码 | 结论 |
|---|---|---|---|---|
| P3 | a5a8ffa30 | `host/plugins/chat-pipeline/index.ts:244-251` → BudgetLedger；`src/budget.ts:210-230,249-256` 分开 Unix 恢复锚点与 performance.now 运行耗时；新增测试 `tests/budget.test.ts:66-87` 覆盖校时及停机累计 | 下方两文件定向命令；未启动，退出码不适用 | 静态修复符合，运行验收待集成；保持未勾选 |
| P6 | a5a8ffa30 | `index.ts:249` → reserveChildSpec；`tests/budget.test.ts:364-373` 三个 u64::MAX 输入与 maxTokens 期望已恢复，新增 wall cap/u32 clamp 断言；Rust 原向量 `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:1457-1470` | 同上；未启动，退出码不适用 | 原向量静态恢复，未以实现者测试自述代替亲跑；保持未勾选 |
| 关联 adapter 测试（不新增/关闭 R2 编号） | a5a8ffa30 | `index.ts:280-282` → ChatV2StreamingAdapter；`src/llm-adapter.ts:260,441-442` reset 使用 elapsed，测试 `tests/llm-adapter.test.ts:53-67` 断言51ms/墙钟回拨/20ms | 同上；未启动，退出码不适用 | 记录静态证据，未扩大到 X5 验收 |

待运行基线含修复后的唯一指定命令：

```text
npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts host/plugins/chat-pipeline/tests/llm-adapter.test.ts
本轮：NOT RUN（main未含修复）；无 runner 退出码。
```

P1/P2/P4/P5 本轮不扩审。未改变任何验收勾选或 lane 结论；仍19个未关闭编号，其中 P3/P6 已有静态符合的候选修复，待集成与上述定向运行证据。

### W4 审批子项补证

`git show ds-mig/C1-app:migration/approvals.d/C1-app.json` 退出0。分片来源固定到 `100098a7d30ca65a839409517643971ef5e43e11`，JSON共42项；只读脚本逐ID核对 L05 obsolete，输出 `Shard total: 42 L05 IDs: 21 matched: 21`，退出0。已同步 L05 ACCEPTANCE，确认无需重新批准；机器消费和其他 pending 仍待闭合，ledger 本轮未跑、W4 未勾。`bf1620ea0` 的 receiver/checkpoint 修复未用于自动关闭 W1/W2/W3/W5。

## P2/P4/P5 新增量复核

收到 `c0f8fd3be` 报告后直接阅读实现提交 `95d9d7e5edd3984a974dcbbc074e7d5db896e364` 与账本/SQL修正 `9dcccfe042082223be794131d1027789e2e5c58d`，未以报告的 Node/Electron 43文件435通过作为自身运行证据。基线 HEAD=`32eaa2d6a`；核对 main=`d1b03dff9281f2e12df9b6602c1b17b06699713e`。三份候选（含先前 a5a8ffa30）的 `git merge-base --is-ancestor <候选> <该main>` 均退出1，故按指令仅静态核增量后结束。

| 编号/子项 | 提交 | 真实生产入口与静态证据 | 本轮真实 runner / 退出码 | 状态 |
|---|---|---|---|---|
| P2 生命周期 | 95d9d7e5e | `host/plugins/chat-pipeline/index.ts:145-147` configure→restore；`src/budget.ts:77-97,585-610,634-643,667-684` 创建/轮换、超额、解绑按 Rust 时点 upsert，失败 warn 且不标指纹，恢复借连接失败 error 后继续 | 未启动 / 不适用 | 主修复静态符合；待集成运行，不关闭 |
| P2 测试真实性 | 95d9d7e5e | `tests/budget-lifecycle.test.ts:6-67` 走真实 index/SQLite：启动恢复、成功扣减不写、解绑/超额写、指纹去重、一次写失败后重试；只 mock 故障的 DB run，不替换预算算法 | 未启动 / 不适用 | 断言方向真实；不是已亲跑证据 |
| P2 新增文件读取接口 | 95d9d7e5e | `index.ts:256-257` → `repository/budget.ts:81-91` 普通 open/2秒timeout/finally close；但 `host/platform/storage/connection.ts:63-64` 递归创建父目录，与 Rust open 失败分支不同 | 未启动 / 不适用 | 缺父目录副作用及日志分支待 L03/F3 对齐；不归为 P6 只读误报 |
| P4 状态纠正 | 9dcccfe04；c0f8fd3be | `TESTMAP.md:119-120,124-126` 5行退 pending；测试文件相对父提交无变化，断言保留；实际362/89，`:12`旧表头未刷新，c0f8fd3be `:17`补了实际统计 | 非runner：逐行统计脚本退出0；测试文件 `git diff --exit-code` 退出0 | 状态纠正子项静态确认；未集成、不代表flush接线完成，暂不勾 |
| P5 越权SQL | 9dcccfe04 | 删除 `repository/memory-flush.ts` 原cleanupMemoryFlushReceiptsWithDb直接DELETE；尚无 L17 cleanup API 调用替代原清理职责 | 未启动 / 不适用 | 仅越权SQL子项移除；P5仍未闭合 |

P2事务核对：当前 lifecycle 点为同步单条 upsert，成功返回后才记指纹；创建/轮换后、绑定登记前写，release先清绑定再写，未新增事务或事务内事件。L04 getConnSafe 通过平台主数据库句柄借连接（候选 `host/plugins/chat/src/service.ts:22-26`），不能据此证明 Rust pool 独立连接在外层业务事务下的所有语义；完整编排未完成，新增测试也不覆盖外层回滚，本次只确认上述明确写入点，不凭假设追加缺陷或宣称更强保证。

新增文件接口的差异可由新增测试本身触达：`95d9d7e5e:tests/budget.test.ts:172` 向 absent-parent/nope.db 读取时，平台 mkdir 导致新目录/库及“读取 settings 失败”，Rust `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:574-583` 则“打开主库 settings 失败”，均返回null但副作用/日志不同。原P6缺文件只读误报仍撤回；没有要求改成只读打开。

集成后的最小合并验证命令（本轮 **NOT RUN**，无runner退出码）：

```text
npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/budget.test.ts host/plugins/chat-pipeline/tests/llm-adapter.test.ts host/plugins/chat-pipeline/tests/budget-lifecycle.test.ts
```

未扩到P1完整管线；P3/P6沿用已有静态证据，不重做。P5的L17公开cleanup接线及其他未完成项继续记录；无新的Node/Electron/跨平台通过结论，所有验收勾选保持不变。

## 05:34Z L05 W1/W5 与 receiver 增量复核

只读复核最终候选 `55f709989` 的修复映射及实际代码、测试，遵循 main `8d161c00d417b76f7c42a8739157a4ac6ac5083d` 的 decisions D1–D6、quality§10。候选、`8aeccc36b`、`0f6b51ed1`、`bf1620ea0` 对该main的祖先检查均退出1；本工作树仍是 `31b3d26af` 旧运行基线，无实现摘取。详细文件:行对照新增于 L05 ACCEPTANCE 的同名节。

| 编号 | 提交 | 真实生产入口及复核结果 | 本轮runner退出码 / Errors |
|---|---|---|---|
| W1 错误前缀 | e6d8cce50 / 04b3b0db0 | index IPC→runtime-roots→CommandError；完整settings/trust/preview错误前缀已补，测试经host.invoke精确比对字符串 | 未启动 / 无输出；不是实现者报告的413passed |
| W1 serde顺序/身份 | 8aeccc36b及此前解码实现 | runtime-root-records按声明顺序重建identity，raw token→BigInt→rawJSON保持2^53+1/u64::MAX；真实stat用bigint，键反序的旧记录经IPC仍有效。**但整树先解析再字段校验仍改变混合错误优先级**，见下 | 未启动 / 无输出；W1继续未决 |
| W5 | 0f6b51ed1 / 4c990bf9b | list_runtime_directory→parseRuntimeDirectoryCursor→分页；64-bit范围、完整字符串匹配、目录耗尽早返、饱和nextCursor均有源码证据；测试走真实IPC、精确空页/错误/普通续页字段 | 未启动 / 无输出；静态符合，待集成定向运行 |
| 附加receiver/checkpoint | 6c25d23f3 / bf1620ea0 | agentWorkspace→liveExecutor每次重新借连接并apply(target,args)；维护前取得checkpoint句柄，checkpoint后关闭；真实F3生命周期测试创建/发消息/维护拒绝/重开/drain/重复关闭 | 未启动 / 无输出；两项静态修复，不连带关闭W2/W3 |
| W4审批与loader子项 | main 8d161c00d | ledger.mjs:193-202读取审批分片；main C1分片逐ID匹配候选21/21；候选实际354 ported /26 pending /21 obsolete | 只读核对脚本退出0；不是main上的ledger runner |

W1剩余差异具体证据（行号属55f709989）：`host/plugins/agent-workspace/src/runtime-root-records.ts:63-98,218-229` 先读完整JSON树，后作字段类型验证。`{"path":null,"label":` 在TS先报EOF；Rust `src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:173-180,648` 的带类型serde流式解码在path=null时就应报path string错误。现有 `tests/runtime-root-errors.test.ts:59-68` 仅覆盖语法完整的字段错误，不能证明错误优先级保留。该项归原W1，不新增修复编号；未执行Rust，不声称动态对照。

API补证：候选 `api.ts:9,13,136-139` 的guard/root/manager/event接口存在；`tests/public-api-wiring.test.ts:11-60` 经真实服务、F3与kernel事件验证任务/sleep取消及授权撤销。仅证明候选分支已提供，不表示L03/L04/L19在main已消费。

### 重启恢复的实际命令输出

按用户要求执行 `git log --oneline -20`、`git status`（退出0、工作树干净），查看当前L05 TESTMAP（表头仍359/21/21，区外统计354/26/21），再执行：

```text
$ npm run migration:ledger -- --check --no-write
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write
ledger: commands 1058 (A 91.5% B 7.7% C 0%), tests 8036 (A 75.7% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
exit 1
```

此结果来自旧R2基线，不是main `8d161c00d` 或L05候选；不得据其否定已入main的分片loader。main审批21项及loader子项已静态确认，W4仍因26 pending/统计/独立复验不关闭。

候选测试 **NOT RUN**，Node/Electron均无本审读者的runner退出码或Errors行；未重复旧suite。待集成后最小命令：

```text
npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/runtime-root-errors.test.ts host/plugins/agent-workspace/tests/runtime-directory-cursor.test.ts host/plugins/agent-workspace/tests/workspace-storage-wiring.test.ts host/plugins/agent-workspace/tests/public-api-wiring.test.ts
```

W2仍待backup共享许可及chat删除接缝（D2，不能局部锁替代），W3 Windows/native未验证；不据identity精度修正关闭W3，也不据receiver修复关闭W1/W2/W3/W5。所有验收勾选保持不变。

## 06:00Z 后合并 main：L03 实跑关闭 P2/P3/P6，L06 候选独立审读

执行 `git merge main` 退出0，得到运行基线 **`364e0f3e4fb2884c942c2814567494d6754182f5`**，合入main `15b23540a97ee19e1391859c3bc140e5c0daa182`。祖先检查：a5a8ffa30、95d9d7e5e、9dcccfe04、a7fdaf010、5d871ce9d均已包含（退出0）；L05 55f709989及L06 b3efce4fa/5652c9cad未包含（退出1）。此前“L03修复均不在运行基线”的说明不再适用于本轮。

### 全局队列亲跑（不直接执行重CPU命令）

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

读取了完整result输出：无Errors报告行/未捕获异常，只有WASI ExperimentalWarning。排队/执行期间完成L06只读审读，没有提交重复作业。此为Node亲跑证据；本轮未跑Electron及Windows/macOS。

| 编号 | 修复提交/生产入口 | 当前结论 |
|---|---|---|
| P2 | 95d9d7e5e：index启动configure/restore，预算公开服务→生产BudgetLedger→真实SQLite；5d871ce9d：repository/budget.ts:84-100预查父目录后再普通openFile | **关闭**。lifecycle的启动恢复、创建/超额/解绑/轮换落盘、失败warn/下一写入点重试及指纹去重亲跑通过。缺父目录增量已修：tests/budget-lifecycle.test.ts:8-22确认目录不存在、openFile未调用、精确打开失败日志，不再保留该副作用缺陷 |
| P3 | a5a8ffa30：BudgetLedger运行用performance.now、恢复停机差用Unix时间 | **关闭**。校时/停机累计/超额测试通过，生产入口及Rust对照已于前轮独立核过 |
| P6 | a5a8ffa30：公开reserveChildSpec→真实u64::MAX向量 | **关闭**。原边界输入/期望亲跑通过；不恢复已撤回的“只读”误报 |
| P1/P4/P5 | P4五行退pending、P5删越权SQL已集成，但完整flush/cleanup业务缺口仍在，P1执行管线未完成 | 保持未关闭；本轮不以预算测试推导其他功能完成 |

### L06 b3efce4fa 候选 O1–O8（未入运行基线）

已阅读 `5652c9cad:BLOCKERS.md` 的映射，但结论来自实现/测试及Rust对照；完整文件:行表放入 L06 ACCEPTANCE 新增节。没有运行旧L06 suite、没有继承提供方33files318结果。

| 编号 | 入口/候选修复摘要 | 结论及runner状态 |
|---|---|---|
| O1 | index的headless/inbox getter缺提供方时undefined，chat.send条件注册随linked作用域撤销；runtime已补结果/guard/named回存/通知 | 部分静态改善，真实L03/L04成功provider仍缺。新增通知分支仍有错误处理/时间格式差异；未启动runner，无退出码/Errors |
| O2 | index.ts:258-267消费vfsRepo.todos，项/回执共tx、提交后事件 | 旧服务名静态修复；命令测试用注入todos/shell，尚无本轮真实L11组合运行 |
| O3 | index.ts:484-509的disabled短路、ensure成功事件、getState失败回退 | 静态符合；host.invoke测试是真实L06入口，对方服务为替身，未亲跑 |
| O4 | repository/automations.ts:144-164,651-675按serde规则省略schedule null字段 | 静态符合；IPC测试严格比较对象键集合，未亲跑 |
| O5 | begin/count/insert/load/update/reload/check/delete/commit分步上下文，update ID用rustTrim | 静态符合本次修复点；真SQLite触发器验证写失败、begin/commit注入只验证分类。未亲跑 |
| O6 | finalize恢复info/warn/事件，但cancelCommand和service也传含emitChanged的hooks | **仍有缺陷**：Rust automations.rs:4635传None，取消时不发once_completed；候选index.ts:192-197,386-389→repository/automations.ts:1071,1093-1095会额外先发该事件，再cancel_run。未亲跑 |
| O7 | 删除chat三表INSERT，调用SessionImportWriter；legacy改settings所有者并保留事务后marker | 跨表SQL子项改善，真实L04 writer未发布。tests/session-tools-db.test.ts:45-89是自写INSERT/transaction替身，不证明生产提供方/同事务；TESTMAP:224仍ported，不能关闭 |
| O8 | index.ts:232-246将kill-switch Error转换validation CommandError | 静态正确；tests/automation-commands.test.ts:120-135 await真实host.invoke后精确比对字符串并排除HandlerPanic，不是只toThrow。但chatState为注入对象；未集成、未亲跑真实L04/IPC settle，保持未勾 |

O1通知增量问题证据：`b3efce4fa:src/automation-notifications.ts:162-188` 对清marker/retry时间的错误直接传播，而Rust `automations.rs:3098-3105,3113-3123,3132-3142,3173-3183` 都let _后继续；reserve异常缺Rust :3163-3168原位warn/Failed。候选:197将toISOString的Z时间写入retry字段，Rust:3200使用to_rfc3339的+00:00，属于持久化/比较语义，不能当日志文本豁免。沿用O1编号，未扩成全lane复审。

L05 W1错误优先级待修、W5/receiver静态状态继续沿用上轮，未入main不重测。W2/W3/W4其余缺口不连带关闭；总计仅P2/P3/P6三项从未勾变已勾，剩16项，三个lane仍不通过B。

## 06:20Z L06 D1/D2 增量（539945675）

仅对上轮b3efce4fa之后的 `57683699e` / `72e69f8d2` / `84a7d205c` 增量审读，候选最终 `539945675`。运行HEAD=`47953bc66`，main核对点=`2bf677b208dc798e0370658f05e491d5de899040`；539945675尚非该main祖先（退出1）。未摘实现、未运行旧suite、未重复已完成的L03 job。全部细节及文件:行对照已写入L06 ACCEPTANCE新增节。

| 编号/子项 | 候选与生产入口 | 静态结论 / 未决点 | 本轮job/result |
|---|---|---|---|
| O7 session import | 539945675 `src/session-tools.ts:1055-1065`，调用方IMMEDIATE事务传同tx给三项所有者*WithConn | 顺序及事务方向符合Rust `tools/session_executor.rs:551-574`。L04真实导出在44a15ca22/api.ts:27-32，但未入此main；L06仍无生产调用点，测试仓储为本地SQL替身，不能关闭 | NOT RUN；无job、无runner退出码/Errors |
| O7 legacy WithConn | `repository/automation-legacy.ts:145-154` 检测F4方法后把读取与marker写入移入事务 | **新增原事务偏差**：Rust `automations.rs:1223-1241,1263-1266` 是读取/解析在begin前，marker保存在commit后。marker失败时Rust保留插入，候选回滚；已迁移的短路与begin失败优先级也变。D1不能作为扩大原事务范围的依据 | NOT RUN |
| O7 legacy fallback | 同文件`:157-163` get-before/save-after | 保留原分段顺序、经所有者API，不能叫“D1跨所有者原子已完成”；Map版测试不证明settings回滚语义。新测试“marker失败插入回滚”本身与原Rust不同 | NOT RUN |
| O1 startup finalizer | `index.ts:364-401` 注册失败直接initialize、成功注册也立即启动interval | **顺序未保证**：无初始化完成闸门/after依赖，tick可先于finalizer；注册错误降级绕过F3排序/失败。Rust `automations.rs:5577-5609` await初始化后才进tick。测试Proxy+手动执行hook不覆盖生产装配 | NOT RUN |
| O1 backgroundTasks | `index.ts:390-400` spawn(runTick)，缺服务直接runTick | 有效跟踪接缝，不是启动闸门；不证明全部headless后台生命周期。没有对应备份/恢复/删除传播路径，不要求凭空新增L21治理许可 | NOT RUN |
| O1 通知 | `src/automation-notifications.ts:188-232,251-292` | 清理错误传播/reserve失败日志子项已静态改进；delivered/suppressed/error及预约释放分类存在。仍先reserve后调用F2做window判断，违反Rust先抑制后预约的错误顺序；补投时间toISOString仍未修 | NOT RUN |

**提供方状态必须更新**：固定main `2bf677b2` 已含F4 `7e063cfdd`（settings/api.ts:48-58、index.ts:81-93的真实WithConn实现）和F2 `e95356480`（electron/index.ts:31,39-44的systemNotification provider，desktop profile含dstu.shell），祖先检查均0；L06 BLOCKERS仍称两者branch-only已过期。F3 `bf8f7b439`、L04 `44a15ca22` 在此main祖先检查均1；分支接口存在不等于生产调用已闭合。

**F3生产装配证据**：bf8f7b439的storage/service.ts:184-193仅注册/运行封装；startup-finalizers.ts:29-46拒绝late/duplicate注册，:53-75显式run时才执行callback。在该提供方快照检索生产调用，没有组合根runStartupFinalizers调用。L06候选注册后直接开timer，没有证据保证先完成恢复收尾；即便未来组合根调用run，前序异步等待/失败仍允许当前timer抢跑。应核真实排序与失败路径，不能以测试手动调用hook作为启动顺序通过证据。

**通知具体剩余分支**：窗口活跃且reserve SQL失败时，Rust `automations.rs:3131-3147` 不预约、直接handled；候选先在:257-264预约失败即Failed，不会进入F2窗口判定。测试仅检查最终marker为空，不能证明未发生预约。F2实际窗口查询失败返回error（electron/system-notification.ts:57-66），Rust原:3039-3047回退不活跃；需L06/F2对齐。toISOString（候选:226）与Rust :3200的+00:00持久化格式差异继续保留。上述均归原O1，不新增编号。

本轮只有只读git/source核对（无Rust运行）及报告编辑；无新增测试job/退出码/Errors可引用，所有验收勾选不变，仍16个未关闭。后续仅在候选进入运行基线并修正后，通过全局队列跑automation-commands、automation-repository、automation-notifications、session-tools-db相关文件，不重复L03已经exit0的作业。

## 可运行基线更新后的最小验收：1297ac576

按协调者指令合并main，`git merge main`退出0；新基线 **1297ac576df147d46949f3f72e85f8c91eb6a68d**，合入main **9c13dfc39f2c29aaffda6c61f7dedee2273197f5**。L05 55f709989/bf1620ea0、L06 539945675已进入运行基线；此前不可运行说明仅属于历史记录。相关文件对候选做增量核对，未修分支仍在，不以suite全绿撤销缺陷。

### 本轮全局作业与真实退出码

三个作业均通过 `/home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- ...` 提交并用 `result <id>` 取得结果；执行期间继续核对当前源码/F4实际WithConn路径，没有排队重复提交。

| 作业号 | 命令/最小目标 | result原始汇总 | 退出码 / Errors |
|---|---|---|---|
| 20261104064353-8d5d9f | `npx vitest run -c vitest.host.config.ts` + L05 runtime-root-errors、runtime-directory-cursor、workspace-storage-wiring、public-api-wiring 四文件 | Test Files 4 passed (4); Tests 17 passed (17); Start at 14:43:55; Duration 17.07s | **0**；完整输出无Errors报告行/未捕获异常 |
| 20261104064353-512531 | 同一vitest配置 + L06 automation-commands、automation-crud-commands、automation-repository、super-commands、automation-notifications、session-tools-db 六文件 | Test Files 6 passed (6); Tests 87 passed (87); Start at 14:43:55; Duration 22.09s | **0**；完整log84行已读，无Errors报告行/未捕获异常 |
| 20261104065100-aee376 | `node --input-type=module -e <内联O8真实连接探针>`，完整脚本保留于job result | PASS: 2 actual InvokeRequest -> InvokeResponse error settlements; real ChatV2State, no HandlerPanic substitute. | **0**；无异常/Errors输出 |

原始result终行分别为：

```text
[作业 20261104064353-8d5d9f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064353-8d5d9f.log
[作业 20261104064353-512531] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064353-512531.log
[作业 20261104065100-aee376] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104065100-aee376.log
```

完整文件路径命令及输出摘要同步在L05/L06 ACCEPTANCE最新节。本轮Node/Linux；未运行Electron或Windows/macOS，不将原21平台skip转成通过。L03 job 20261104061531-b747b9已经关闭P2/P3/P6，**本轮没有重跑**。

### 编号 → 实现提交/生产入口 → 结论

| 编号 | 实现与入口 | 本轮判定 |
|---|---|---|
| W1 | e6d8cce50/04b3b0db0/8aeccc36b，index IPC→runtime-roots→记录解码 | 前缀/字段主分支/身份精度13测试通过；混合错误优先级仍未修，整项不关 |
| W5 | 0f6b51ed1/4c990bf9b，目录IPC→BigInt cursor→真实目录分页 | **关闭**。2^53及2^53+1/u64::MAX合法、越界等非法、空页及普通nextCursor断言通过；饱和算法有静态证据 |
| receiver/checkpoint附加集成项 | 6c25d23f3/bf1620ea0，agentWorkspace→liveExecutor.apply→真实F3→checkpoint/重开 | **复验通过**。创建/发消息/维护拒绝/重开持久数据/drain/重复关闭均实跑，公开manager事件也通过；不连带关闭W2/W3 |
| O2 | b3efce4fa中的vfsRepo键修复，L06命令→正确L11服务键→回执编排 | **关闭原键名断线**。真实IPC用同名对方接口替身触发并断言数据/事件；静态核对真实L11 api:127,132签名。非L11/F2整机验收 |
| O3 | fe4707440等，ensureSuperState/getSuperState命令/服务入口 | **关闭**。disabled无依赖/事件，ensure成功changed及getState fallback亲跑通过 |
| O4 | fe4707440等，scheduleObject→automationToListItem→IPC | **关闭**。存储及返回都省略None字段，严格对象形状断言通过 |
| O5 | fe4707440等，create/full update/delete分步error mapping和rustTrim | **关闭本项**。真SQLite触发器、begin/commit注入及Unicode ID命令断言通过；不扩大为所有数据库故障语义证明 |
| O8 | fe4707440等，真实serveHost→HostRuntime→L06 run_now→真实ChatV2State | **关闭**。缺状态/已触发两条invoke均在3秒内返回完整 `result,ok=false` 验证错误；不是只toThrow或把HandlerPanic当业务拒绝 |
| O1/O6/O7 | 当前539945675实现 | **不关闭**。见后文当前源码状态，不重复派修已解决子项 |

O8探针未写实现/测试文件：借用现有fixture profile仅完成kernel启动，加入仓库真实IPC契约及L06插件，临时目录内真实F3库、automation SQL迁移和F4 settings；HostTransport为内存载体，但命令路由与错误响应使用生产serveHost实现，不使用测试宿主的panic替代器。两次消息均严格deepEqual完整JSON：缺状态为 `VALIDATION_ERROR / AgentKillSwitch gate: ChatV2State is unavailable, admission denied (fail-closed).`；真实ChatV2State.trip后为 `VALIDATION_ERROR / AgentKillSwitch tripped: all agent activity is stopped. Call chat_v2_resume_agents to resume.`。检查后shutdown/dispose并清理自建临时目录。此证据不声称覆盖Electron原生MessagePort/前端UI。

### 未决项以当前实现为准

- **O1**：clearNotificationMarker/Pending已catch继续、reserve已catch原位warn，旧“直接传播SQL”子项不再派修。完整runner缺口、retryAt的toISOString、先预约后窗口抑制、finalizer/tick启动次序仍未修；测试finalizer手工调用不能关闭启动缺口。
- **O6**：info/warn已恢复，但取消路径仍额外once_completed，不能因一般finalize/取消用例通过就签收原事件序列。
- **O7**：当前为SessionImportRepository三*WithConn，不再旧三参数Writer/直接INSERT。F4真实SettingsWithConn已经在main且createSettingsStore实际实现；index传ctx.settings，legacy当前确实走同tx的`:145-154`分支。它把Rust事务前读取、提交后marker保存移进事务，是原边界偏差，**不是缺F4所以fallback**。会话导入的L04真实提供方/消费链仍未闭合，测试本地SQL仓储不能代替生产证明。
- W2/W3/W4继续不关；W4批准/loader子项已解决，但26pending仍在。P1/P4/P5按既有生产闭合要求保留。

本轮新增关闭6项（W5、O2/O3/O4/O5/O8），加此前P2/P3/P6，共关闭9项，余10项。所有lane仍不通过B；仅修改允许的验收/汇总文件。

## dbbfd4c2c 新候选：按拆分仓储更新 O1/O6/O7 子项

运行基线仍为79d94bf24；固定main d5cd234aa8a919807b65eeca250e5567cc527f95未含候选dbbfd4c2c及4cbc09634/bc965752a/6772ac1f0/1e6bab7ba/db42e4ea4（逐项祖先检查退出1）。未运行旧suite，不重复关闭项。C1报告提供方job20261104064508-d5f478三文件67通过/exit0仅记录来源，不列为独立亲跑证据。

| 编号 | 修复提交 → 实际入口/文件 | 本轮静态结论 | job/result |
|---|---|---|---|
| O6 | 4cbc09634；index.ts:217-221/463-466 → automations.ts聚合再导出 → **automation-runs.ts:225-260** | 入口只传日志hooks，内部再次剥离emitChanged；保留cancel token后finalize顺序，普通scheduler事件仍在。新真实IPC/service测试严格只见cancel_run且once已disabled。修复方向符合，待亲跑才勾 | NOT RUN，无退出码/Errors |
| O1 retry | 4cbc09634；automation-notifications.ts:222-229 → automation-schedule.ts:443-444 → chronoRfc3339 | 已修平台+00:00格式，候选不再列toISOString指控 | NOT RUN |
| O1窗口/预约 | bc965752a/6772ac1f0；automation-notifications.ts:254-287 | 先窗口预检再reserve，notify传false避免F2二次窗口查询；查询失败仍按不活跃继续。子项静态修复，未签整机通知 | NOT RUN |
| O7 legacy | db42e4ea4；automation-legacy.ts:137-151 | 先settings读/解析→IMMEDIATE插入commit→owner.save marker；已删除WithConn探测，F4接口是否存在不再改变边界。测试恢复marker失败后定义保留，与Rust automations.rs:1263-1266一致 | NOT RUN；真实L04导入仓储/消费仍缺，O7不关闭 |
| O1正常finalizer | 1e6bab7ba；index.ts:376-423 | timer移入startScheduler，初始化后才建立；新测试推进15秒证明hook前无spawn。**catch注册失败仍直接startScheduler（:413-415）**，绕F3排序/失败闸门未解，O1不整体关闭 | NOT RUN |

`dbbfd4c2c` 的automation仓储拆分已沿引用追溯：automations.ts:20-41仅聚合，定义在automation-definitions.ts，运行/取消/once在automation-runs.ts，共享类型在automation-model.ts。不用旧1391行文件位置判定实现是否存在；详细原Rust及新测试证据见L06 ACCEPTANCE文末新候选节。

正常注册的timer测试仍注入finalizer注册表/后台spawn，只证明L06门控，不覆盖真实F3组合根、注册失败与拓扑次序。完整headless/send提供方、O7真实L04生产导入接线仍未完成；无需凭空增加L21治理许可。已有修复子项不再要求重复实现，但候选未进入运行基线，本轮不新建测试job。后续只用队列最小automation-commands/automation-notifications/automation-repository三文件，保留真实退出码及Errors。所有编号勾选不变，仍10个未关闭。

## 07:19Z 两批精确新修复：O1 ready门控、W1错误优先级

本轮运行HEAD 4c0057f7c，固定main核对点679fd3e4d3bdaff9d38188aab851704e952b9ac0。d540b9166/d1b03b409、a41769ee4/0dc99b5df四个提交的祖先检查均退出1；仅通过git show读取候选，没有摘实现或重跑旧suite。补证已同步L05/L06 ACCEPTANCE，不改变勾选，仍10项未关闭。

| 编号/新子项 | 候选、真实入口与证据 | 本轮结论 | 独立job/result |
|---|---|---|---|
| O1拒绝注册 | d540b9166 index.ts:451-456 | catch仅error，不再调用startScheduler；**撤销对最新候选的旧catch启动指控**，静态子项修复 | NOT RUN，无自身退出码/Errors |
| O1 ready时点 | d1b03b409；index.ts:438-440初始化后异步waitStartupReady，:419-435仅ready=true且未disposed才创建timer | 局部门控方向符合；缺gate/超时/Promise失败不tick。没有把wait await进finalizer，避免等待所有finalizer成功的自锁；整体只在成功后markReady的规则仍须真实F3/F2组合根证明 | NOT RUN |
| O1测试真实性 | d540b9166 tests/automation-commands.test.ts:24-105、271-466 | registry/gate是自写模拟状态机，非正式F3/F2实例。局部拒绝/ready测试不能签“真实F3装配”；F2实际startup-gate.ts:8-22只有单调ready且guard可markReady，缺共享失败状态，整体规则仍待明确 | 提供方20261104071623-a25bc5的13pass/exit0仅注明来源，不继承 |
| W1组合错误优先级 | a41769ee4/0dc99b5df；runtime-root IPC→runtime-roots→runtime-root-records.ts:68-105,144-161,237-268 | 逐键/项即decode，path:null在后续label截断前报类型错误；文本container即时拒绝，authorized每条记录独立校验。所列缺陷静态修复，不泛称整个JSON实现等价 | NOT RUN |
| W1新增断言 | 0dc99b5df tests/runtime-root-errors.test.ts:111-135 | 经settings保存原输入→真实host.invoke，8向量严格错误字符串/line/column，包括前字段合法才落后续EOF；不stub解码器 | 提供方20261104063608-7cba5d Node14、20261104063810-b3f324 Electron47+1skip/exit0仅记来源 |

O7 legacy在d540b9166依然commit后owner.save（repository/automation-legacy.ts:137-151），沿用已审静态子项，不重做旧原子性指控；真实L04提供方接线未签。O1仍需要正式F3 registry+startupGate及整体失败/重试规则就绪后验证，不因最新局部catch已修就关完整执行/启动项。

后续最小作业：W1集成后只跑runtime-root-errors.test.ts中 `R2-W1 typed field errors precede later truncated JSON at the IPC boundary`（通过全局job队列）；L06只筛startup/finalizer拒绝相关用例，正式装配需实际registry+gate而非本地模拟。未重复旧身份/游标、已关闭L03或整lane；本轮未审Linux隔离，任何Linux新行为不构成Windows W3关闭证据。

## 08:21Z 积压处置：顶部摘要订正与精确owner映射

已将三个ACCEPTANCE顶部更新为最新候选状态，不再先写“仍无修复”再用脚注反转。运行HEAD=f4fee7d93；固定main=3b2758d7ac8e69263377ab7356206c94af9d8a24；L05候选31c01a2bb、L06候选d540b9166、L03候选745463f6b，以及L04 b0ed6a135/L17 6a0e276be均未入该main（祖先检查1）。仅核每项关键证据，没有重复关闭项目测试、没有摘实现。

| 编号 | 最新候选关键证据（独立源码核对） | 明确剩余去向 / 原Rust路径与验证 |
|---|---|---|
| W2 | L05 31c01a2bb index.ts:95-107真实获取governance同步delete_propagation及按需deleteSessionV2；coordinator.ts:185-203 finally release。main backup/index.ts:55,86-89同operations.tryAcquire。L04 b0ed6a135 service.ts:90真实immediate deleteSessionHard | **L05/L04集成真实链**。现有测试真实L21/F3但L04回调为替身。Rust `src-tauri/crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:266-294,913-950`；持backup锁删除不得改sleep/root/DB，成功只删worker，runtime-root失败不删对应会话、继续其他worker并聚合，许可始终释放 |
| O1通知/ready | dbbfd4c2c notification.ts:254-287先窗口后预约且notify(false)，retry走平台；d540b9166 index.ts:419-456等ready且拒绝不自启 | 候选已修，不重复派旧顺序指控。**L06/F2集成复验 + F1/F3正式组合**；Rust automations.rs:3039-3047,3086-3209,5577-5630。完整runner由L03/L04仍待 |
| O6 | 4cbc09634→d540b9166；automation-runs.ts:225-260内部剥emitChanged，index日志-only hooks | 候选已修。**L06最小取消事件复验**，Rust automations.rs:4596-4638,4666-4667。不重做代码 |
| O7 legacy/import | db42e4ea4→d540b9166 legacy.ts:137-151commit后owner.save；SessionImportRepository传同tx三*WithConn | legacy候选已修；**L06/L04真实仓储生产调用**仍待。Rust automations.rs:1223-1266、tools/session_executor.rs:551-574；marker失败保留定义，导入块失败则同事务会话/消息/块全回滚。别用测试内INSERT证明真实provider |
| P4 | 745463f6b index.ts:37仍仅纯函数；生产src/api/index未查到claim/worker/recovery消费；五行在TESTMAP:122-129为pending | **L03自有worker/recovery**，非笼统外部阻塞。Rust pipeline/compaction/memory_flush.rs:572-618,737-865；预置两同session段，首段未完成次段不可越过；已存extraction+部分receipt崩溃后重启复用、不重复fact，原测试:1125-1171,1201-1412 |
| P5 | L17 6a0e276be api.ts:181-188公开cleanup，service.ts:879-880委托repository/idempotency.ts:91-103,159-160真实prefix删除；L03最新无消费、直接DELETE已删 | **L03消费L17候选并正常集成**。Rust memory_flush.rs:300-311,659-669,849-865：先skip/complete账本，再cleanup，失败warn继续；保留其他segment回执，禁止恢复L03跨表SQL |

原Rust相对路径均以 `src-tauri/crates/dstu-agent/src/chat_v2/` 为根；每项仅记录必要关键证据，完整对应表在各ACCEPTANCE文末08:21Z节。

### F3/F1失败规则：run已定，register政策待裁定

已独立读F1 fa4e03485的 `host/kernel/connection.ts:67-79,111-127`：正常启动await所有finalizer，run失败记录详情并向上抛，HostFatal退出1、不发HostReady/不mark gate、不自动重试；恢复模式跳业务finalizer但mark gate。F3 39d81465b的 `startup-finalizers.ts:53-83`：拓扑/回调失败置failed，显式重run跳过已完成项。两候选尚未入固定main，但**规则已明确**，旧报告“整体run失败规则待定”不再作为当前请求。

只剩必需钩子register被拒时是否应提升为全局失败待裁定（F1 :77-79）；目前不能用L06自写registry/gate测试签正式F3装配。责任为F1/F3组合根与F2/L06消费，需真实registry的后续失败→无ready/无tick/HostFatal证据，不新造本地失败状态机。

### TESTMAP与恢复检查（不把台账绿当B验收）

只读行计数：main 3b2758d7a与L05候选31c01a2bb均 **364 ported /16 pending /21 obsolete**；L03 main为 **362/89/0**，候选745463f6b为 **363/83/5**。顶部旧26/84统计已订正并区分候选。未修改任何TESTMAP或ledger。

重启后按用户要求执行git log --oneline -20、git status并查看本工作树TESTMAP；无需重复已完成源码审读。要求的ledger通过全局队列仅提交一次：

```text
job 20261104085026-171df2
command: npm run migration:ledger -- --check --no-write
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 77.1% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104085026-171df2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104085026-171df2.log
```

该结果来自当前R2工作树，为台账检查非新候选Vitest/Electron通过证据。本轮没有新业务测试job，不复跑P2/P3/P6；所有候选修复仍等待main可运行基线及必要最小验证，勾选不变，剩10项。W3跨平台范围不因Linux隔离或persona模型校验续派而改变。

## v2优先闭环、门禁复现及新增chat补审（eeaf5bdc7）

### 基线/范围

门禁失败通知后先合并main至154704588；三项要求的检查均经队列提交，未改实现/测试/断言。随后按架构师/C1新增授权将 `host/plugins/chat/ACCEPTANCE.md` 加入独立报告写入范围，读取 `standard-v2.md`，合并v2 main至 **eeaf5bdc7ae95a336c34b3a75b19f844726fe064**。本轮只写原4份允许报告及新增chat报告；不替实现者修实现。

### 原门禁失败的复跑结果

| 作业 | 原要求命令 | 真实结果 |
|---|---|---|
| 20261104091758-ddc201 | npm run typecheck:host | exit0；tsc无错误输出 |
| 20261104091759-88c16f | npm run migration:boundaries | exit0；2337文件，0 violation，166 suppressed |
| 20261104091758-bffb22 | npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline | exit0；50文件488通过；112.79s，完整result无Errors |

完整日志均在 `/home/dsdev/.oc-jobs/done/<job>.log`。原stream-sink-wiring/completion-finalizer失败在此合并基线未复现；不能把旧失败归因到验收文档，也不能声称本审读者修改了实现修复它。此次全L03测试由明确门禁复现请求触发，不是重复P2/P3/P6签收作业。

恢复检查按用户请求读取git log/status、TESTMAP，并取回一次只读ledger作业20261104105720-09c0bb：

```text
ledger: commands 1058 (A 92% B 5.9% C 0%), tests 8036 (A 80.4% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104105720-09c0bb] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105720-09c0bb.log
```

### 已修项最小复验闭环（独立亲跑）

| 编号 | 生产证据/修复 | 本轮job、退出码、结论 |
|---|---|---|
| W1 | a41769ee4/0dc99b5df逐字段visitor，新增8向量经settings+真实IPC严格比对完整错误 | **20261104110200-f9b05a**，1文件1通过/13筛选跳过，7.75s，exit0、无Errors；结合既有主分支证据关闭W1 |
| O6 | index日志-only hooks及automation-runs内部剥emit，取消once仅cancel_run | **20261104110200-99af33** 中cancel endpoints，exit0；关闭O6 |
| O1子项 | 预约前窗口判断、失败补投+00:00时间 | 同作业3条通知筛选用例通过，已修子项不再派回；完整runner/正式启动装配不关闭 |
| O7子项 | legacy marker提交后保存、已迁移marker先于解析 | 同作业2条legacy筛选用例通过；真实L04生产导入仓储仍未闭合，O7不关闭 |

O作业命令：`npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration/tests/automation-commands.test.ts host/plugins/agent-orchestration/tests/automation-repository.test.ts host/plugins/agent-orchestration/tests/automation-notifications.test.ts -t 'cancel endpoints finalize once|legacy_json_migration_commits_definitions|legacy_json_migration_reads_the_marker|prechecks window activity|a failed OS delivery|releases the F2 reservation'`。

```text
Test Files 3 passed (3)
Tests 6 passed | 67 skipped (73)
Duration 7.65s
[作业 20261104110200-99af33] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110200-99af33.log
```

筛选跳过不作obsolete/平台通过。两个result完整读过，未出现Errors报告。没有新增Electron/Windows/macOS证据。

### 新增chat补审：C1关键路径直报

在main基线eeaf5bdc7，chat目录相对1297ac576实现无差异：**ChatSessionService仍只有CRUD，未注册send/retry四命令，未提供完整headless/ToolExecutorRegistry生产入口**。已知缺口复用 **X5-01**（C1 coordination:1081），不新造同义缺陷；owner L04与L03/L02需真实执行端口。此结论针对main，不否认L04分支中已有公开helper/候选，不能将候选API当main闭合。

本次按v2审读19条已注册真实IPC，另核4条X5-01缺入口；逐项表包括Rust/TS入口、默认/校验/错误/事务/事件落点，TESTMAP对照15条生产函数测试及2条字面量反例。报告见新增 `host/plugins/chat/ACCEPTANCE.md`。新finding：

| ID | 缺陷与精确owner | 最短证据/复现 |
|---|---|---|
| C04-01 | L04 snapshot内嵌JSON缺serde解码/错误wire | snapshot.ts:102 as断言→:138缺session解引用；Rust snapshot_handlers.rs:160-169,202-204先serde报Validation。真实IPC缺session输入变HandlerPanic |
| C04-02 | L04生命周期省略L05 runtime roots/L11 refs | deletion.ts:40-45,85-130；Rust manage_session.rs:933-946,995-1024；真实IPC删除行后artifact仍在。FS失败应先阻断、refs按原best-effort，不能混同 |
| C04-03 | L04 goal_resume漏idle续跑 | register.ts:285-290只改状态/事件；Rust goal_handlers.rs:167还spawn续跑 |
| C04-04 | L04技能状态解码/legacy flag/顺序/u64 | session-actions.ts:235-314，legacyMigrated=true；Rust manage_session.rs:2097/types.rs:1296为false；真实IPC存false后库内true |
| C04-05 | L04事务begin/commit错误漏命令转换 | session-actions.ts:124-140直接transaction，handlers.ts只捕ChatV2Error；真实双连接BEGIN IMMEDIATE竞争令update IPC变HandlerPanic，Rust ?为业务DB错误 |
| C04-06 | L04关键日志缺失 | create group失败warn、authority入口info、cancel请求/成功、variant更新info，逐条行号见报告 |
| C04-07 | L04 TESTMAP/测试真实性 | 173 ported/354 pending；events.test.ts:50-85,205-239只构字面量JSON.stringify，不能证明生产serde/codec |
| C04-08 | L04跨L11 folders/cache写入 | group-actions.ts:223/230→本lane vfs-folders.ts:144,198,207及path_cache DELETE；应调用L11所有者API |

**独立运行：** 作业20261104110900-10cd5d跑chat六个相关文件（session-commands、snapshot、deletion、variants、error、events），6文件126通过，46.77s，exit0，无Errors。原生importable及wiring（173/0）exit0。没有全chat suite/整机通过声明。

缺陷探针经队列、真实kernel/SQLite及测试临时目录，未修改任何实现/测试文件：

```text
job 20261104111123-b6ceed / exit0
C04-01 observed: HandlerPanic command "chat_v2_import_session" panicked (in production the frontend promise would never settle): Cannot read properties of undefined (reading 'metadata')
C04-02 observed: deleted session row, retained session artifact file
X5-01 observed: chat_v2_send_message not allowed. Command not found

job 20261104111811-6339e2 / exit0
C04-04 persisted legacyMigrated: true (Rust sets false)
C04-05 real SQLite contention: HandlerPanic command "chat_v2_update_session_settings" panicked (in production the frontend promise would never settle): database is locked
```

探针exit0表示**复现了缺陷**，不是被验收能力通过；真实SQL竞争只把自建库busy_timeout缩短，未stub transaction，清理时rollback/关闭/删除临时目录。完整脚本和输出可由job result取回。所有Rust依据只读，不执行Rust。

### X6具体断言边界分类（不批准全文件skip）

- **runtime-root-records.ts:39**：已扫描闭合字符串token后的JSON.parse，用途是decoder内部字符串反转义，不是直接将业务JSON断言为结构体。可按**单表达式**窄分类。
- **同文件:255/266/276**：调用schema/readRecord/record/identity字段验证及finish后结果收窄；可按三个具体return分类，不等于认可整parser全语法语义。已有W1生产用例涵盖原缺陷，未知字段/内部tagged内容等未穷举；不改代码规避扫描。
- **X6-UD-L06-01**：automation-definitions.ts:92确是数据库trusted_profile_json直接parse as类型，无字段解码，独立确认并复用X6原编号，列L06未决附加项；不要因O4输出字段已关豁免它。
- **automation-definitions.ts:150**：版本冲突payload中automationToListObject输出收窄为JsonValue，属出站类型边界，不与:92入站parse混类。可从入站规则窄排该表达式，但仍依赖上游解码及D3/输出形状正确，不构成整个函数/文件豁免。

待C1转交X6门禁分类，不修改审批或门禁配置。新增chat属于架构师/C1授权补审，已遵守报告-only边界；原19项现关闭11、余8，chat8新finding及X5-01复用、X6-UD-L06-01单独跟踪，不把共享问题重复计为两个新编号。

## chat交付映射补证：C04-08 = X6-SW-CHAT-01

收到C1对181f4e96a/849255bc7的确认后，仅核796ec7c9d实际修复与95ff22b9f交付清单。固定main=4c6cd1ba8f377e7200310ae1930fe7def9c61ee3，796ec7c9d祖先检查退出1；没有在旧main重复运行或将提供方550pass当独立结果。

候选 `repository/vfs-folders.ts:4-6,21-36` 已删除folders/folder_items/path_cache写SQL，改为L11 api的FolderRepository同conn委托；index.ts:129-130,148-151真实注入/撤销folders，group-actions.ts:217-245真实调用；候选groups.test安装真实L11提供方。这是**C04-08 / X6-SW-CHAT-01同一修复**的静态成立证据，已更新chat ACCEPTANCE顶部，未把旧eeaf5bdc7发现外推成候选仍缺陷。

两编号关联，不重复派修或计数；候选未main故保持未勾，独立job/result为NOT RUN。正常集成后只经队列跑chat/tests/groups.test.ts签收，不重复W1或整lane。其余C04 finding等待L04按当前候选逐项映射/反例；W2/P4/P5沿现有接缝任务，不开展新全套。

## L06返工95432befd：X6-UD-L06-01仍未达到serde/D3等价

固定HEAD=f64e1fc47，main=4c6cd1ba8f377e7200310ae1930fe7def9c61ee3；95432befd43e60cc141b5f4043a52dba20d1c7b4未入该main（祖先检查1）。该命名提交为空，已直接读取候选完整代码及检查点差异，不仅看提交自述；未摘实现、未重跑旧suite。详细原Rust/TS证据和raw-token向量写入L06 ACCEPTANCE新增节。

| 编号/子项 | 独立静态结论 | 精确证据 |
|---|---|---|
| X6生产解码调用 | 已新增真实decoder入口，必填/unknown/枚举/Vec校验及读取不validate方向正确 | 候选automation-definitions.ts:91-95→trusted-profile.ts:279-318；Rust automations.rs:298-318,989-1003 |
| X6 u64 | **仍有缺陷**：JSON.parse先丢高位，decodeUnsigned返回number；u64上界常量也舍入，MAX+1可被接受 | trusted-profile.ts:210-214,294；raw timeoutSeconds=9007199254740993、maxOutputBytes=18446744073709551616。不得用业务validate或拒绝全部非safe整数替代D3 |
| X6原始token语义 | **仍有缺陷**：1.0/1e0变整数1、重复字段被JSON.parse覆盖后再校验 | 同文件:260-275,294；应保留serde对浮点token/duplicate field的拒绝 |
| X6错误上下文 | **仍有缺陷**：代码显式不保留serde行列，新增IPC精确期望也删了后缀 | 同文件:286-290,316-318；Rust serde错误经FromSqlConversionFailure原样嵌入automations.rs:995-1000，v2未批准扁平化 |
| V2-01 | settings错误true、load错误false静态符合 | index.ts:515-522对Rust automations.rs:4779-4792；真实坏表/坏schedule服务用例 |
| V2-02 | 失败sentinel越出IMMEDIATE回调使todo与receipt一起回滚，步骤warn保留，成功后emit，静态符合本修复点 | automation-todo.ts:77-133对Rust automations.rs:2559-2609；real-plugin-composition.test.ts真实L11/F3，触发器拒receipt及独立连接观察提交 |

provider job20261104113053-b17b43的40/40及其余提交列job不继承为本审读者运行。此次独立runner NOT RUN，无新job/result退出码/Errors；X6不勾，其他既有finding勾选不变。automation-definitions.ts:150出站JsonValue收窄未改，保持与:92入站decoder区别；不批准整个文件skip、不要求换语法隐藏门禁命中。

## L04 ba462056e 新差异：候选子项已修与剩余typed解码分开

固定运行HEAD1934442f8、main d84e29565f06f233f8ea6787487a5f9a11e17743，ba462056e祖先检查退出1。仅核相对95ff22b9f的新实现/测试，不将旧main探针外推到已修候选，也未继承provider558/74测试结果。详细证据同步chat ACCEPTANCE文末。

| finding | 实际修复/测试证据（属ba462056e） | 静态结论 |
|---|---|---|
| C04-01 wire子项 | 4b6741e8b的snapshotCommandResult；三snapshot入口plain Display | 修复符合Rust snapshot_handlers.rs:83-151,202-218；snapshot.ts:102仍直接parse as，完整serde decoder未闭合 |
| C04-05 | settings/block/undo transaction被databaseOperation包住；snapshot.ts:268-283区分begin raw与commit前缀 | 静态符合Rust manage_session.rs:1231/1275、snapshot_handlers.rs:461-485。transaction-errors.test.ts:25-64是真实第二连接BEGIN锁及延迟FK COMMIT失败，完整错误/回滚/重试，无事务替身；待main亲跑 |
| C04-04已修子项 | session-skill-state.ts:18-81、session-actions.ts:244-255 | Vec整体解码、legacy=false、手工顺序比较、skip_empty、大整数及饱和均静态符合；数字parser实际用reviver source区分JsonFloat，1.0不被当整数，不能照搬L06 Number问题 |
| C04-04剩余 | L20 parseJsonLossless最终JSON.parse丢重复键，typed parseSkillState无重复检查 | 重复version应令Rust serde失败并回退existing，候选用最后值；具体种子/incoming原字符串见chat报告。仍归原finding，不重复造编号 |
| C04-07反例子项 | events.test.ts:51-68真实chunk工厂，:188-209真实Emitter sequence7/generation42 | 原12+8断言保留；测试sink仅接收结果，静态认可修复。候选334ported/174pending/19obsolete不是初审173/354，不能签整账本 |

branch/variant/deletion附加测试的持久空Vec改缺键，是对齐Rust types.rs:1199-1208 skip_empty，保留其他字段和内存空Vec断言；不判为为实现改弱。C04-02硬删roots/refs在候选已接（deletion.ts:113-116,128-136），create仍缺；03续跑/06日志仍owner自有续作；08沿已审796ec7c9d，不重复派修。

provider 20261104115653-81f7b3（558pass/2平台skip）、20261104115653-4324af（74pass）及typecheck仅记来源；本轮无独立job/result退出码/Errors、未运行旧suite。main后最小transaction-errors、skill-state-save及两个events用例复验，C04-04还需补重复字段拒绝/回退。验收勾选全部不变。

## L04 d3eee89ad：新增create roots与日志（不扩审其他项）

候选对main 45c3250b0d4bd67ade44c04fcab27e650db86c13祖先检查退出1，运行HEAD70cd003ef。相对ba462056e独立核对：index经L05 api依次artifactRoot/tempRoot(create=true)，session-actions在createSession成功后初始化，失败warn后仍返回session，最终Created info；对应Rust manage_session.rs:386-405、runtime_roots.rs:805-808。

`tests/lifecycle-logs.test.ts:24-41` 真实IPC/FS覆盖目录成功与artifact容器被普通文件阻塞，确认已保存会话及warn→Created顺序；`:43-85` 真实logger exporter和事件监听验证group warn、authority解析后info、cancel双info、variant cancel info/debug与delete事件先于info。代码/断言静态符合原列C04-02 create、C04-06日志子项，不外推已修候选仍缺create或这些日志。

本轮独立候选runner NOT RUN；提供方11/61pass作业与typecheck不是R2运行证据。C04-02整链、C04-06签收待main最小lifecycle-logs/reference-lifecycle；其他C04 finding不重做，勾选保持不变。已启动的R2 lane-gate只检报告分支合main状态，不等于候选测试。

## 集成拒绝：chat新增复核授权未同步到精确路径表

收到“改动超出范围：host/plugins/chat/ACCEPTANCE.md”后，已先 `git merge --no-edit main`，正常合并main ad11a83943de411a75c87364fd8893a174ce63f9。核实：

- 架构师standard-v2新增覆盖指令及C1“v2新增chat覆盖”明确将L04/chat交给R2独立审计；本报告相应C04单元已完成，C1随后确认181f4e96a/849255bc7并派回C04-01…08。独立chat报告全部由本R2撰写，未改任何chat实现/测试。
- 当前 `scripts/electron-migration/lib/lane-paths.mjs:35` 的 `EXTRA_PATHS['R2-review-agent']` 仍只有agent-workspace、agent-orchestration、chat-pipeline三份ACCEPTANCE及本汇总，缺少 `host/plugins/chat/ACCEPTANCE.md`。main的 `git ls-tree` 该路径无结果，因此范围门禁将新增报告判越界。这不是候选测试或业务实现失败。
- **所需协调动作**：由有权限的基础设施owner把 `host/plugins/chat/ACCEPTANCE.md` 加入R2的精确允许路径，并保持实现/测试只读。R2不擅改共享白名单、派发任务卡或测试规则，也不删除已验收派修的证据来隐藏授权不一致。
- 本轮只在原允许的审计汇总追加此证据。其余原报告与finding勾选不变；范围门禁解除前，不能声明本分支可集成。按standard-v2 §5提交、合main及lane-gate自检另行记录结果，普通自检不替代该范围校验。

## 归档：L04-chat-session 独立验收（原 `host/plugins/chat/ACCEPTANCE.md`）

- 原因：R2 的精确允许路径白名单不含 `host/plugins/chat/ACCEPTANCE.md`，自动集成据此拒绝。main 在该路径无文件；本文件 196 行全部由本 lane 的文档提交撰写，无他人内容。
- 来源提交（均为 R2 自有文档提交）：`849255bc7`（初版）、`f64e1fc47`、`15232dee4`、`b541bb576`；撤回前 blob SHA：`e458f28a3da88a7c8521a7fa889db212035ca2f8`。
- 下列正文原样保留（含 finding、勾选、命令/测试原始证据）。此操作只是把同一份审计报告保存到本 lane 允许路径，**不构成新的独立验收、不新增业务增量、不改变任何 finding 勾选或 lane 结论**；原 chat 实现/测试未改动。

# L04-chat-session 独立验收（R2-review-agent，2026-11-04，standard-v2）

结论：不通过

架构师/C1新增补审范围；**只读实现**，本报告不修改实现、测试或TESTMAP。固定审读/运行基线 `eeaf5bdc7ae95a336c34b3a75b19f844726fe064`；该基线chat目录与先前1297ac576没有实现差异。依据 standard-v2 §1八类规则、§2命令清单、契约、Rust源码及本次亲跑证据。没有编译/运行Rust，证据等级为生产入口测试/缺陷探针及静态审读，非Rust动态差分。

## 必须修复

- [ ] **X5-01（复用原编号，不重复造缺陷）：发送/重试生产入口及完整执行链未闭合。** 契约包含chat_v2_send_message/retry_message/retry_variant/retry_variants（`contracts/ipc/L04-chat-session.json:2834,2910,3010,3359`），本基线 `host/plugins/chat/index.ts:45-72` 未注册；`api.ts:109-123` 只有CRUD，没有headless执行/ToolExecutorRegistry服务。亲跑真实host.invoke返回 `chat_v2_send_message not allowed. Command not found`。Rust入口 `src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:461,919`、`handlers/variant_handlers.rs` retry分支；已有协调证据 `docs/dev/electron-migration/coordination/C1-app.md:1081`。**owner L04与L03/L02接缝**；registry/helper/API候选不算完整send执行，不能用固定失败命令补注册。
- [ ] **C04-01：快照导入缺serde结构解码，错误可变handler panic，错误wire也被统一改写。** `src/snapshot.ts:100-118` 使用JSON.parse as ConversationSnapshot，只检查format/version，不验证必填session/字段类型/Vec；`:138`直接解引用session。输入 `{"format":"deepstudent-conversation-snapshot","version":1,"messages":[],"blocks":[]}` 经真实IPC触发HandlerPanic（生产不回复）。Rust `handlers/snapshot_handlers.rs:160-169,194-218` 先serde全结构校验、返回Validation Display字符串；TS `register.ts:161-166` 的commandResult统一转JSON code/message，连export meta缺会话等原`.to_string()`错误也改变形状。**owner L04**；修真实decoder与各命令错误边界，不改断言迎合实现。TS路径本报告未加前缀时均相对 `host/plugins/chat/`。
  - 候选4b6741e8b→ba462056e已将三条snapshot命令切到plain Display边界，wire子项静态修复；完整snapshot serde decoder仍未实现，不能整体关闭。初审panic与统一JSON错误证据仅指eeaf5bdc7，不外推已修wire子项。
- [ ] **C04-02：已注册会话生命周期静默省略runtime roots与VFS引用计数。** `src/register.ts:302-306` 创建后不初始化roots；`src/deletion.ts:40-45,85-106,109-130` 删除消息/会话/回收站省略VFS refs，硬删除也不先清runtime roots。亲跑会话行已删除而真实artifact文件仍留存。Rust `handlers/manage_session.rs:388-397,933-946,995-1024`、`handlers/block_actions.rs:300-376` 要求相应动作（roots失败应阻断硬删，refs尽力重试/日志，不能混为同一种失败语义）。**owner L04，调用L05/L11公开业务接口**；对正常删除、FS失败保留行可重试、refs重复计数与失败日志分别验证。不是仅缺“非可见优化”。
  - 12c075dd5→44a15ca22→ba462056e候选已接硬删roots/refs（deletion.ts:113-116,128-136，reference-counts.ts:19-69），该删除子项不再当作候选漏步骤派回；创建roots仍缺，三方真实生产闭环仍待main复验。
  - 更晚候选d3eee89ad已补create剩余：实际index经L05 api依次artifactRoot/tempRoot(create=true)，持久化后调用，失败warn并保留session，最后Created info。此候选不再派“create roots未实现”；静态证据及未集成运行边界见文末。
- [ ] **C04-03：goal_resume少了提交后的idle续跑。** `src/register.ts:285-290` 仅改goal与发事件，注释称调度“不observable”；Rust `handlers/goal_handlers.rs:151-168` 在释放连接后发goal_updated并 `spawn_goal_continuation_if_idle`。paused/blocked/budget_limited/usage_limited恢复为active后应尝试后端续跑，当前没有生产调用。**owner L04（与goal运行提供方接缝）**；保留幂等无变化分支、顺序和取消条件，不能凭状态更新测试绿签收完整命令。
- [ ] **C04-04：保存会话技能状态的语义/解码/D3不等价。** `src/session-actions.ts:235-260,281-314` 无类型校验parse、过滤非法数组项，version用number并直接+1；`:307`强制legacyMigrated=true，而Rust `handlers/manage_session.rs:2075-2098`、`types.rs:1290-1297`设Some(false)。Rust手工技能序列比较保留顺序，TS `:303`排序后比较会漏掉仅顺序变化的版本递增；TS `applySkillState:268-277`写空数组，而Rust `types.rs:1196-1212`有skip-empty，u64按饱和递增。**owner L04**；通过chat_v2_save_session覆盖typed JSON错误回退、原字段/顺序与u64值，不把解析成功视为业务解码成功。
  - 5040938b7→ba462056e已补typed字段、保序、legacy=false、skip-empty及精确u64饱和，静态修复这些子项；仍缺重复字段的serde拒绝/整体回退，具体raw输入见文末。不是否定其数字无损改进，也不重复派修已改字段。
- [ ] **C04-05：事务开始/提交错误可能绕过ChatV2Error，命令不settle。** `src/session-actions.ts:124-140`、`snapshot.ts:268-275` 直接调用平台transaction；`src/handlers.ts:10-20`只捕获ChatV2Error，F3 begin/commit抛StorageError会变panic。Rust `handlers/manage_session.rs:1231-1232,1274-1275` 用?转ChatV2Error再映射命令错误。**owner L04**；边界应映射真实事务错误，保持回滚/提交后副作用，不能只测仓储SQL内部的databaseOperation。
  - 4b6741e8b→ba462056e已将settings/block/undo事务置于databaseOperation，snapshot区分begin原Display与commit固定前缀；新增真实F3锁/延迟FK失败测试，无事务替身。静态修复符合原列边界，待main独立最小运行才签收，不再要求重做该实现。
- [ ] **C04-06：有业务意义的warn/info被省略。** 例：create的group缺失/非active warn（Rust `handlers/manage_session.rs:371-380`）在TS `session-actions.ts:61-65`只throw；set_authority_mode入口info（Rust `:2139-2143`）在TS `register.ts:329-330`缺失；cancel_stream请求/成功日志（Rust `handlers/send_message.rs:866-878`）在TS `register.ts:210-216`缺失；variant switch/delete业务info（Rust `handlers/variant_handlers.rs:204-207,375-378`）也未保留。**owner L04**；按v2映射级别/关键字段，现有logger存在不代表这些分支有日志。
  - d3eee89ad已补上列group warn、authority解析后info、cancel请求/成功、variant switch/cancel/delete日志；真实IPC/日志收集用例静态核对符合，待main独立最小运行，未将所有lane日志映射一并签收。
- [ ] **C04-07：TESTMAP未闭合且存在只测字面量的ported。** 实际173 ported/354 pending（527），无obsolete/merged，原测试大量未迁。`tests/events.test.ts:50-85,205-239` 手工构造wire对象再JSON.stringify，仅测JS省略undefined；原Rust测试调用结构体serde，生产codec/构造规则在TS并未被这两用例触达，仍在TESTMAP:81,92标ported。**owner L04**；改走生产工厂/事件发送/codec或保持pending，不删除原断言。下面另列15条确实测生产函数的对照，不能据它们推断其余全部真实。
  - 上述173/354是初审eeaf5bdc7统计；候选ba462056e为334 ported/174 pending/19 obsolete。两个字面量反例已分别改BackendEvent.chunk工厂及真实Emitter生成，12+8原断言保留，静态确认该子项修复；其余pending未闭合，不因反例改完签整个C04-07。
- [ ] **C04-08 / X6-SW-CHAT-01（同一问题）：初审跨表写已在候选修复，待main独立签收。** 初审eeaf5bdc7的 `src/group-actions.ts:223,230` → `repository/vfs-folders.ts:144,198,207` 直接写folders/folder_items/path_cache；该结论仅限该版本。实际修复796ec7c9d（交付清单95ff22b9f）已改为从L11 api取得FolderRepository，create/update传同一conn，不再执行这些SQL。候选未入本轮固定main 4c6cd1ba8，静态修复确认但不勾选；Rust对照 `handlers/group_handlers.rs:89,101`。两编号关联一个修复单元，不重复派修/计数；owner L04/L11，详细候选证据见文末。

## 建议

- 按上述finding分别提交修复，并优先向C1提供X5-01完整send所需的精确L03/L02端口；不要以本报告新增审计阻止现有入口实现工作。
- 事务/文件清理错误与缺结构字段都需要真实命令边界测试；已有成功CRUD测试不覆盖这些失败保证。

## 已核实通过

- [x] chatState/chatSession服务命名及provide对应（`index.ts:82-84`、`api.ts:125-132`）；常规chat SQL在本域repository，跨域folders写入例外为C04-08。
- [x] cancel_stream不重复发stream_cancelled；cancel_variant先核会话归属再取消`${session}:${variant}` token；delete_variant保留“最后一个/streaming拒绝、success优先、块失败warn继续、事件失败warn继续”的所查行为（见命令表）。完整发送取消链仍受X5-01限制。
- [x] update settings读-改-写主体使用IMMEDIATE事务，后端metadata键保留/删除规则主路径有生产测试；事务错误边界另列C04-05。
- [x] 本次六文件126测试全部通过、退出0；真实IPC缺陷探针另行复现C04-01/02和X5-01，不将探针exit0当作行为等价通过。
- [x] 原生Node导入 `importable: ok`；wiring报173 ported/0未接入，退出0。扫描只是import可达性，不能消除C04-07字面量及X5-01调用链缺口。

## v2命令抽查（19条实际IPC + 4条缺入口，非helper凑数）

简称：R=`src-tauri/crates/dstu-agent/src/chat_v2/`；T=`host/plugins/chat/`。所有返回/错误核对以具体Rust入口为准，不能统一将String错误都包成JSON。

| 命令 | Rust入口/分支 | TS真实入口/结果 | v2结论 |
|---|---|---|---|
| chat_v2_create_session | R handlers/manage_session.rs:330-405：mode→group→写DB→roots best-effort | T register.ts:302-306→session-actions.ts:48-79；显式title锁、group空白/null、错误类型主路径一致 | 问题C04-02/06：roots和warn缺失 |
| chat_v2_get_session | R manage_session.rs:414-429：三前缀校验、Option | T register.ts:235-238→getSession；缺会话null、非法前缀原label | 通过所查分支；只读无事务/事件 |
| chat_v2_update_session_settings | R manage_session.rs:449-477,1222-1277：校验、IMMEDIATE、保留runtime metadata | T register.ts:307-310→session-actions.ts:119-140 | 主体顺序通过；C04-05/06，错误及日志未完整 |
| chat_v2_archive_session | R manage_session.rs:523-546,1351-1400：前缀→会话→Super拒绝→归档 | T register.ts:311-315→session-actions.ts:150-165 | 主体通过；业务日志缺失归C04-06；无新事务要求 |
| chat_v2_save_session | R manage_session.rs:563-582,2045-2098：存在检查→技能合并→UPSERT | T register.ts:316-319→session-actions.ts:235-321 | 问题C04-04：legacy/顺序/version/typed decode |
| chat_v2_restore_session | R manage_session.rs:846-871,1435：清归档标记、旧Super退役、group状态 | T register.ts:320-323→session-actions.ts:185-214 | 所查group阻断/metadata分支通过；日志C04-06 |
| chat_v2_soft_delete_session | R manage_session.rs:772-831：前缀→stream/anki→标记→清sequence→Super hook | T register.ts:402-404→deletion.ts:66-83 | 正常分支顺序/日志通过；缺Super服务新增预检失败未获完整等价证明 |
| chat_v2_delete_session | R manage_session.rs:893-961：stream/anki→前缀→roots→refs→级联→hook | T register.ts:357-360→deletion.ts:86-107 | 问题C04-02；数据库级联主路径测试绿不足 |
| chat_v2_empty_deleted_sessions | R manage_session.rs:980-1066：快照IDs→全部FS清理→refs→逐个重查→删除→hooks，u32数量 | T register.ts:361-364→deletion.ts:110-130，返回purged.length | 问题C04-02；FS/refs步骤缺失 |
| chat_v2_export_session_meta | R snapshot_handlers.rs:83-108：读session/state/messages，pageSize100，时间+00:00，Display错误 | T register.ts:161-162→snapshot.ts:47-61 | 正常形状/nullable state通过；错误被JSON化归C04-01 |
| chat_v2_export_session_messages | R snapshot_handlers.rs:117-151：limit默认100、最小1、offset clamp、所有变体块、nextOffset null | T register.ts:163-164→snapshot.ts:65-82 | 常规分页/排序主路径通过；数据库错误Display形状C04-01，大usize未作全域证明 |
| chat_v2_import_session | R snapshot_handlers.rs:190-491：50MiB UTF8→serde→format/version→remap→事务 | T register.ts:165-166→snapshot.ts:96-282 | C04-01/05；正常remap、draft清空、孤儿告警已测，不抵消坏输入panic |
| chat_v2_cancel_stream | R send_message.rs:860-882：cancel token，有效null，idle Other，不重发事件 | T register.ts:210-217 | token/错误/无重复事件通过；日志C04-06，完整provider取消X5-01 |
| chat_v2_switch_variant | R variant_handlers.rs:153-209：可写→所属→存在→非error→更新→skill sync | T register.ts:186-189→variant-actions.ts:78-90 | 正常选择/拒绝通过；日志C04-06，skill数字字段见C04-04 |
| chat_v2_delete_variant | R variant_handlers.rs:225-384：末个/streaming拒绝、块warn继续、更新、事件warn继续 | T register.ts:190-205→variant-actions.ts:93-146 | 所查逻辑及返回可null的新active一致；业务info缺失C04-06 |
| chat_v2_cancel_variant | R variant_handlers.rs:1086-1127：所属校验→scoped token | T register.ts:206-209→variant-actions.ts:159-165 | 所查状态行为通过；Rust取消/未找到日志缺失C04-06 |
| chat_v2_set_authority_mode | R manage_session.rs:2128-2144 / repo.rs:2864-2879 | T register.ts:329-330→session-actions.ts:377-393：parse、退出plan清plan、存metadata | 主体通过；入口info C04-06 |
| chat_v2_set_permission_preset | R manage_session.rs:2154-2179：parse→danger确认→清session审批→DB | T register.ts:331-332→session-actions.ts:396-425 | 确认/default与清缓存先于失败写入主路径通过；不宣告所有metadata解码正确 |
| chat_v2_goal_resume | R goal_handlers.rs:127-168：可写→允许状态→更新→事件→idle续跑 | T register.ts:285-290→goal-actions.ts:27-36 | C04-03：只有持久状态/事件，无续跑 |
| send_message/retry_message/retry_variant/retry_variants | R send_message.rs:461,919；variant_handlers.rs retry入口；契约4条真实命令 | T index.ts无注册，api无完整执行服务；精确命令名见X5-01 | 问题复用X5-01，未作为已实现命令通过 |

事件/事务审读不擅自加强Rust：delete_variant原来不是单一大事务，TS按块warn继续符合该原行为，未要求人为加一层原子事务；update_settings原有IMMEDIATE则必须保持。创建时间格式及字符串helper使用平台实现不等于所有u64或持久JSON已对齐。

## TESTMAP真实性抽查：15条 + 2条反例

下表前5条来自TESTMAP:76-80，TS `tests/error.test.ts`，Rust `R error.rs`；后10条来自TESTMAP:82-91，TS `tests/events.test.ts`，Rust `R events.rs`。已逐断言比较输入、取值、方向；合并deepEqual可同时承载多条Rust字段断言，不机械要求一字段一个expect。

| 原测试名 | 核实同一断言行为 | TS行 / Rust行 | 结论 |
|---|---|---|---|
| test_error_display | session/message/block/Cancelled四个Display | error:5-10 / error:184-196 | 通过 |
| test_variant_error_display | 五种variant错误及状态格式 | 11-17 / 199-217 | 通过 |
| test_error_to_string_conversion | code+message两个字段，真实ChatV2Error转换 | 18-22 / 220-228 | 通过 |
| test_command_error_code_stability | 四code及timeout原因 | 23-31 / 231-254 | 通过 |
| test_timeout_error | timeout完整Display | 32-35 / 257-264 | 通过 |
| test_backend_event_start_creation | 序列、type、phase、消息/块、payload、无variant | events:88-105 / events:1947-1964 | 通过 |
| test_backend_event_start_with_variant | 序列5、var_001 | 107-112 / 1967-1979 | 通过 |
| test_backend_event_chunk_creation | thinking中文chunk、无message/variant | 114-124 / 1982-1992 | 通过 |
| test_backend_event_chunk_with_variant | 序列10、var_002 | 126-131 / 1995-2001 | 通过 |
| test_backend_event_end_creation | RAG result深比较、end阶段、无variant | 133-143 / 2004-2016 | 通过 |
| test_backend_event_error_creation | tool_call/error/完整中文错误 | 145-153 / 2019-2027 | 通过 |
| test_backend_event_variant_start | id/model、phase、无block/status | 155-166 / 2030-2041 | 通过 |
| test_backend_event_variant_end_success | success、无error/message/usage | 168-179 / 2044-2055 | 通过 |
| test_backend_event_variant_end_error | error、var、中文原因、usage空 | 181-189 / 2058-2066 | 通过 |
| test_backend_event_variant_end_with_usage | 100/50/150及usage存在 | 191-203 / 2069-2082 | 通过 |

上述事件测试调用实际生产工厂（`src/events.ts:262-268` 绑定同一backendEvent*函数，Emitter实际复用；index导入events、api也公开Emitter），替身仅为接收sink，不是替换被测事件算法。**反例**：test_backend_event_serialization、test_session_event_serialization仅JSON.stringify测试自己的对象，不能按同文件可达推为真实移植，见C04-07。无obsolete/merged审批问题，但354 pending未闭合。

## 亲自运行证据

全部从本独立worktree，经全局job队列运行；不调用Rust工具链，不接用户正式数据库。

```text
job 20261104110900-10cd5d
command: npx vitest run -c vitest.host.config.ts host/plugins/chat/tests/session-commands.test.ts host/plugins/chat/tests/snapshot.test.ts host/plugins/chat/tests/deletion.test.ts host/plugins/chat/tests/variants.test.ts host/plugins/chat/tests/error.test.ts host/plugins/chat/tests/events.test.ts
Test Files 6 passed (6)
Tests 126 passed (126)
Start at 19:09:02
Duration 46.77s
[作业 20261104110900-10cd5d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110900-10cd5d.log

node scripts/electron-migration/importable.mjs host/plugins/chat/index.ts
importable: ok
node scripts/electron-migration/wiring.mjs --lane chat
合计 ported 173，其中所测模块未从 index.ts 接入 0（0.0%）
```

以上完整result输出无Errors报告或未捕获异常。只跑抽查所需6文件，不宣称全chat suite通过；没有Electron或Windows/macOS新运行。

**缺陷探针**（真实kernel命令、真实迁移SQLite、自建临时文件，VFS为未使用的契约替身；探针断言缺陷存在，所以exit0不是验收通过）：

```text
job 20261104111123-b6ceed; node --input-type=module -e <完整脚本可从job result回取>
C04-01 observed: HandlerPanic command "chat_v2_import_session" panicked (in production the frontend promise would never settle): Cannot read properties of undefined (reading 'metadata')
C04-02 observed: deleted session row, retained session artifact file
X5-01 observed: chat_v2_send_message not allowed. Command not found
No Rust execution; probes verify defects, not successful parity.
[作业 20261104111123-b6ceed] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104111123-b6ceed.log
```

另一个真实入口探针用有效skillStateJson保存并查真实SQLite，随后在第二个真实连接持有BEGIN IMMEDIATE、将测试库busy_timeout设1ms后调用update settings；未替换事务方法：

```text
job 20261104111811-6339e2; node --input-type=module -e <job result保留完整脚本>
C04-04 persisted legacyMigrated: true (Rust sets false)
C04-05 real SQLite contention: HandlerPanic command "chat_v2_update_session_settings" panicked (in production the frontend promise would never settle): database is locked
[作业 20261104111811-6339e2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104111811-6339e2.log
```

探针结束rollback竞争事务、关闭测试连接并清理临时目录。这里的HandlerPanic为测试宿主明确检测到的缺陷输出，不能写成“测试无Errors所以行为正确”。

## v2八类规则与命令完成清单汇总

| 规则 | 结论/关键证据 |
|---|---|
| 生产接线 | X5-01不通过；已列19条IPC有真实注册与测试/源码落点 |
| 单一所有者 | C04-08不通过；VFS folders/cache写入必须回L11 |
| serde/整数边界 | C04-01/04不通过；IPC外层schema不能校验snapshotJson/skillStateJson内部 |
| 日志与错误 | C04-01/05/06不通过；命令自身决定plain Display还是JSON，普通异常不能逃逸 |
| 测试真实性 | 15条抽查通过，2条字面量反例与354 pending使整体不通过 |
| 完整分支 | C04-02/03及X5-01阻断；FS/refs/续跑都不是可省略步骤 |
| 运行时语义 | 局部token/事务/事件主路径有证据，完整cancel/provider/cleanup未闭合；同步导入/JSONL writeFileSync也尚未给出v2 worker执行证据（register.ts:169-184、snapshot.ts:96-275） |
| 修复闭环 | 本报告仅列缺陷；需带ID实现提交合main，再独立最小复验 |

每条抽查命令的Rust/TS入口与主要分支见命令表；数据/错误/日志/所有权/运行时未通过项逐号列出，不能在SPEC完成清单中全部勾选。已登记平台差异（如毫秒时间精度）不批准缺文件清理、类型断言、数据库错误panic或跨所有者复制。当前共 **8个新finding（C04-01…08）+复用X5-01**，不新增第二个发送入口编号。

## C04-08 / X6-SW-CHAT-01 候选静态复核（95ff22b9f）

本次只核交付对应修复，不将初审旧main发现外推到新候选。HEAD=`849255bc7`；固定main=`4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`，`git merge-base --is-ancestor 796ec7c9d <该main>` 退出1。

- **实际修复提交796ec7c9d，95ff22b9f只补交付文档**。两者的vfs-folders.ts/group-actions.ts无后续差异。`95ff22b9f:repository/vfs-folders.ts:4-6,21-36` 仅经对方api类型和FolderRepository方法委托，不含folders/path_cache写SQL；create/update直接传入调用者conn，不另开事务、不复制所有者缓存清理。
- **生产接线存在于候选**：`index.ts:129-130,148-151` 从ctx.inject vfsRepo取得folders，并随提供方撤销清空；`src/group-actions.ts:217-245` 从vfs数据库取conn后委托同一folders.get/exists/generateUnique/create/update。不是仅发布接口无调用。
- **候选测试安装真实L11**：`tests/groups.test.ts:1-45` 安装vfs-repos/index与chat/index，group create/rename等用例通过真实IPC读写；paths/runtimeRoots为与本次表写主体无关的接缝替身。静态证据不继承提供方job20261104111841-a0dcc4的550pass。

**本轮独立runner：NOT RUN，无新job/result退出码或Errors。** main正常集成后只需通过队列运行 `host/plugins/chat/tests/groups.test.ts` 最小签收，检查真实folder所有者写入及cache行为；不重跑W1/旧chat全套。本次不修改实现或测试，未更改其他finding勾选，等待owner反例或可运行main通知。

## ba462056e C04-01/04/05/07新差异独立静态复核

运行HEAD=1934442f8；固定main=d84e29565f06f233f8ea6787487a5f9a11e17743。候选ba462056e不在该main（祖先检查退出1）；没有在旧源码重复运行，没有摘实现。命名提交为文档，实际实现从4b6741e8b/5040938b7及后续检查点核对。下列行号均属候选ba462056e，旧main缺陷探针不外推为最新候选仍有同一已修子项。

### C04-01 wire与C04-05事务：静态修复符合，decoder未闭合

- `src/handlers.ts:17-23` snapshotCommandResult仅将ChatV2Error/StorageError的message变CommandError；`src/register.ts:170-175` 三条snapshot入口改用它，保留Rust `handlers/snapshot_handlers.rs:83-108,117-151,190-218` 的plain Display。不会把未知TypeError错误伪装业务错误；完整snapshot decoder仍在 `src/snapshot.ts:102` 直接parse as，原缺session结构问题尚不能关闭。
- settings、block content/tool output、undo-compaction的transaction全域在databaseOperation内，开始/提交阶段StorageError也能转Database再通过命令JSON映射；undo的StreamGuard仍finally释放。snapshot `src/snapshot.ts:268-283` 区分callback未完成与readyToCommit，commit StorageError固定 `Failed to commit import transaction:`，begin保留原DB Display。Rust `snapshot_handlers.rs:461-485` 正是begin raw、业务写入各自Display、commit前缀；没有把这两种错误扁平为统一前缀。
- `tests/transaction-errors.test.ts:25-38` 第二条真实F3连接BEGIN IMMEDIATE竞争，严格检查settings JSON与snapshot plain错误、无新增行，释放后重试成功；`:40-64` 用DEFERRABLE INITIALLY DEFERRED FK及触发器制造**真实COMMIT失败**，检查settings/import/block回滚、无半写记录、错误完整文本及之后重试。未替换transaction方法，不只toThrow。这是合入后可直接独立运行的有效证据设计，本轮未亲跑。

### C04-04：typed字段/数值/写回已改，重复字段仍待

- `src/session-skill-state.ts:30-54` 经L20公开parseJsonLossless后逐Vec/string/u64/bool检查，任一字段错则整体undefined回退；`:18-20` BigInt精确饱和；`:63-81`空Vec省略、legacy列独立排序投影。`src/session-actions.ts:244-255`手工列表比较按原顺序、legacy=false、branch清空时饱和+1；branch/history/variant保存复用该模块，不是测试专用实现。
- 已读真实数字parser `host/plugins/sync/src/json.ts:93-106`：JSON.parse reviver source把大整数还原BigInt，把小数/指数token标JsonFloat，因此候选确实拒绝version:1.0并保留2^53+1/u64::MAX。不能把L06候选的Number缺陷照搬到这个不同parser。
- **仍有可达typed-serde差异**：同一个parseJsonLossless最终仍使用JSON.parse，因此重复字段只保留末值；`parseSkillState`没有重复键检查。例：先持久化 `{"manualPinnedSkillIds":["old"],"version":10}`，调用save时incoming skillStateJson为 `{"manualPinnedSkillIds":["new"],"version":1,"version":2}`、activeSkillIdsJson为 `["legacy"]`。Rust `handlers/manage_session.rs:2075-2098` 的serde from_str遇duplicate version失败，回退existing，再改manual到legacy并增至11；候选采用incoming末值2及new，不走回退。此为原C04-04的入站typed解码剩余项，未执行Rust或虚构动态结果。新测试 `tests/skill-state-save.test.ts:34-42` 覆盖1.0/越界/错误Vec，但未覆盖duplicate。
- 五条新save IPC测试不替换解码器；原附加branch/variant/deletion测试将**持久化JSON**空Vec期望改为not.toHaveProperty，与Rust `types.rs:1199-1208` skip_empty一致，不属于改弱；内存态Vec空断言保留。已核其他匹配字段未删。C04-04不全关，已修子项不重复派回。

### C04-07两个反例：生产路径与原断言确实保留

`tests/events.test.ts:51-68` 改为实际BackendEvent.chunk(42,...)再序列化，12条原字段/缺省断言保留；`:188-209` 实际Emitter.withStreamGeneration(42)，先发7次start推进序列，再streamComplete，读sink末事件，固定系统时间，dispose；8条原JSON字段/sequence7/generation42断言保留。sink仅记录生产Emitter输出，不替换被测构造/序列分配。静态确认两个反例已修；不能因此声称174 pending全部闭合。

### 保留范围与运行记录

C04-02硬删roots/refs候选 `src/deletion.ts:113-116,128-136` 与reference-counts.ts:19-69已实现先清理/业务调用/重试日志，按候选静态子项记录；create roots仍未完成。C04-03 idle续跑、C04-06日志本轮未有修复交付，继续原owner工作；C04-08沿796ec7c9d同conn所有者候选证据，不重审。

本轮独立runner **NOT RUN**，无新job/result退出码/Errors，不继承提供方20261104115653-81f7b3的558pass/2skip或20261104115653-4324af的74pass。main正常集成后，仅按finding运行transaction-errors、skill-state-save、events中对应用例，不跑63文件全套；重复字段需修复并有原断言对应测试后才能签C04-04。所有勾选保持不变，C04-01只认可wire候选子项，完整decoder仍待。

## d3eee89ad：C04-02 create / C04-06所列日志静态补证

候选d3eee89ad，代码主体已由7073cafb5检查点保存；本次相对ba462056e只核新增create与日志。运行HEAD=70cd003ef，固定main=45c3250b0d4bd67ade44c04fcab27e650db86c13，候选祖先检查退出1，不在旧main重跑测试。

- **真实生产入口**：候选 `index.ts` 从 `../agent-workspace/api.ts` 导入artifactRoot/tempRoot，传给registerChatCommands的initializeRuntimeRoots依次调用两者，create=true；`register.ts` 的create命令传真实log与该回调。`session-actions.ts` 在createSession(db,session)成功返回后调用初始化，catch仅warn，最后写Created info并返回session。与Rust `handlers/manage_session.rs:386-405`、`runtime_roots.rs:805-808` 的artifact先、temp后、失败仍保留会话顺序一致；没有直接复制L05路径实现。
- **真实失败路径测试**：`tests/lifecycle-logs.test.ts:24-41` 经host.invoke创建会话并检查两真实目录；阻塞用例将chat_v2_artifacts写为普通文件，确认会话仍可读取、warn先于最终Created info。测试未mock初始化回调/文件系统，不把简单exists参数测试当生产行为。
- **日志子项**：group不存在/非active在抛错前warn；authority只在parse成功后info，invalid不写该info；cancel_stream请求与成功两info，idle不会伪造成功日志；variant switched在更新/sync后，cancel分别info/debug，delete info在事件尝试后。对应Rust manage_session.rs:371-380,2133-2144、send_message.rs:866-881、variant_handlers.rs:204-207,1086-1123,357-378。
- **断言路径**：`lifecycle-logs.test.ts:43-85` 收集真实ctx.logger exporter的level/message，真实IPC触发group拒绝、cancel、authority与variant操作；对delete用实际backendEvents监听插入观察标记，断言event先于最终info。证明设计覆盖原列日志子项；未动态穷举事件发射失败等所有路径，也不声称本lane所有info/warn已闭合。

本轮独立候选runner **NOT RUN**，没有新job/result退出码/Errors。提供方20261104121136-10ce79（11pass）、20261104120333-4da4ef（61pass）及typecheck只作交付来源，不继承。main后最小lifecycle-logs与reference-lifecycle复验即可；C04-02沿既有硬删roots/refs候选继续三方验证，C04-06仅以上列原finding范围复验，未更改勾选。R2自检lane-gate是旧main报告分支门禁，不是d3eee89ad测试。

## L05 W02 固定 normal-main 独立复验（2026-11-05）

固定普通 main `915b4b9936beb12aa7946ee3fb8fa68b4a6f023b`（main 工作树干净），经全局队列亲跑一次，不继承供方 profile 单例 `067eb3` 的 471 passed / 24 skipped：

```text
job 20261105091325-21131e
command: npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/workspace-fs-contribution.test.ts
 ✓ host/plugins/agent-workspace/tests/workspace-fs-contribution.test.ts (1 test) 42986ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  17:13:28
   Duration  55.67s (transform 32.19s, setup 0ms, collect 11.04s, tests 42.99s, environment 0ms, prepare 282ms)
[作业 20261105091325-21131e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105091325-21131e.log
```

原始输出无 Errors 报告行、无未捕获异常；0 skipped。候选 `697197f2a`、合并 `3c627f154`、集成 `3430654fc` 均为该 main 祖先（退出 0）。

### 核对的窄签范围（只签本贡献，不扩为整 lane）

| 检查点 | 生产/测试证据 | 结论 |
|---|---|---|
| 唯一注册 | `index.ts:125-133` 在 `ctx.inject(['agentTools'])` 的 scope.effect 注册单个 `WorkspaceFsContribution`；测试 `:26-35` 以实例类型且 `toHaveLength(1)` 断言；重装段 `:146-172` 继续验证不会叠加 | 通过 |
| 实际 L04 同 conn context | 测试 `:62-78` 用 `chat.database.getConnSafe()` 建组/会话，再以真实 `createExecutionContext` 执行；spy 断言 preferred root 的 owner 查询参数恰为 `[['sess_w02'],['group_w02']]`。实现 `workspace-fs-contribution.ts` 的 `preferredRoot` 借 `context.chat_v2_db.getConnSafe()` 后调用 `getSessionWithConn`/`getGroupWithConn`，未另开连接或复制 owner SQL | 通过（本路径） |
| 只读拒写 | 测试 `:66,104-110` 设 `access:'read_only'` 后写返回精确错误 `Workspace is read-only; the user must explicitly grant write access`，目标文件不存在、block 为 error | 通过 |
| `window_ref` panic 外抛 | 测试 `:112-120` 无 window 执行 artifact write，`rejects.toThrow('ExecutionContext.window_ref() called without a Tauri window')`；实现 `requireWindow: () => { context.windowRef(); }` 不捕获；断言仅 start 事件、无 block、无文件 | 通过 |
| skill Map 信任与撤销 | 测试 `:127-145` 经真实 `chat_v2_set_skill_trust` 信任后按 `skill_package_roots` 读到 `SKILL.md`（root access read_only），撤销信任后返回 `Skill 'w02-skill' is not trusted by the backend` | 通过 |
| Disposer 卸载/重装 | 测试 `:147-172` 明确先卸载真实依赖 `dstu.chat-pipeline`，再卸载 `dstu.agent-workspace` 后贡献为空；重装后又恰一个注册且 active；卸载后旧 Disposer inactive；再装并 dispose 旧注册只留 replacement，replacement registry 仍可读 | 通过 |
| group 错误为受控 StorageError 注入 | 测试 `:98-108` 仅对 `FROM chat_v2_session_groups` 的 `conn.get` 注入 `new StorageError('SQLITE','group read denied',{database:'chat_v2'})`，断言回退 workspace 且 warn 文本精确；其余查询仍走真实连接，不伪造生产算法 | 通过（受控注入，不等同真实 IO 故障验收） |

明确不签：全 IO 失败矩阵、活跃依赖热拔、full-roster 缺口（测试 `:40-48` 明确不填其他缺失 owner 的替身，只证明本贡献被消费）、`chatToolRuntime`、Windows ACL。此复验只对应 W02 贡献注册与上述路径，不改变 L05 其他 finding 勾选。

## chat 审计迁移后的机器判定与红灯保留证据

- HEAD 原 `host/plugins/chat/ACCEPTANCE.md` 全部由 R2 文档提交 `849255bc7`/`f64e1fc47`/`15232dee4`/`b541bb576` 写入，main 该路径原本无文件；撤回前 blob `e458f28a3da88a7c8521a7fa889db212035ca2f8`，正文已完整保存在上方归档节，含 9 个 `- [ ]` finding（X5-01 + C04-01…08）。
- `scripts/electron-migration/ledger.mjs:72-79` 的 `review(lane)` 对 L04 只扫描 `host/plugins/chat/ACCEPTANCE.md`（lanes.md L04 目录为 `chat/`）：文件不存在时 `present=[]`，返回 **`{ok:false, state:'missing'}`**，不会返回 ok；`scripts/electron-migration/lib/ledger-core.mjs:120-122` 的 B 级仍要求 `review.ok`，故 L04 的 B 判定保持 false。迁移前状态为 `open:9`，迁移后为 `missing`，二者均非 ok，红灯仍在机器视野内，不是“改为通过”。
- 未改动 ledger、未新增/勾选任何 checkbox；本 lane 其他允许 ACCEPTANCE 的原未决项保持原样（agent-workspace 5、agent-orchestration 5、chat-pipeline 4 个未勾选项）。若架构希望保留 `open:9` 的计数可见性，唯一精确修复仍是由有权限 owner 在 `scripts/electron-migration/lib/lane-paths.mjs` 的 `EXTRA_PATHS['R2-review-agent']` 加入精确路径 `host/plugins/chat/ACCEPTANCE.md`；R2 无权改共享白名单。当前选择是“允许路径内归档 + 撤回 lane 自有越界新增文件”，不把该文件搬移当作新验收或业务增量。

## WP-C2-D1-002：L17/L18 验收草案与 L05 phase0 抽检（2026-11-05）

结论：部分完成。L05 九条映射已逐条核对断言并亲自运行；L17/L18 各写出一份可直接落盘的验收初稿，两份都**不通过、未覆盖全域**，不算 B 级；正式 ACCEPTANCE 路径尚未授权。

### 基线与口径

- 工作树 `/home/dsdev/dev/ds-mig/R2-review-agent`，分支 `ds-mig/R2-review-agent`。开工时工作区干净；当时有其他工作树在并行跑 vitest，本包所有检查都经共享作业队列执行。
- 开工 `git merge --no-edit main`：`76a386437 → 967f43c7547d1ed29a7e3d736b8118fb95d3661e`（fast-forward）。**本节所有实现、测试、Rust、契约行号都以 967f43c75 为固定审读快照**；L05 的固定 diff 是 `87b1032a7..967f43c75`。
- C2 通知之后，main 已前进到 `1f3d621f0`，其中含 L17 自动检查点 `a80ba453c`（合并提交 `baa74ccb9`）。`git merge-base --is-ancestor a80ba453c 967f43c75` 退出 1，所以 **a80 不在本草案的审读基线内，本草案也不把它当通过**。`git diff 967f43c75 main -- host/plugins/memory` 只改了 `TESTMAP.md`（47 行），没有实现改动，因此下面的 L17 代码缺陷对当前 main 同样成立。
- 已完整阅读 WORKER、R2 任务卡、ORCHESTRATION-v3、standard-v2，以及 memory/media/agent-workspace 的 LANE/BLOCKERS/TESTMAP。实现者的自述只用来定位代码，结论以代码、契约和本次亲跑结果为准。
- 账本目录（`docs/dev/electron-migration/lanes.md:148-149`）：L17 只有 `memory/`，L18 只有 `media/`，这次没有漏掉同 lane 的其他插件目录。`scripts/electron-migration/ledger.mjs:72-79` 只从 lane 目录读取 ACCEPTANCE，所以本 audit 里的草案不会让 `review.ok` 成立。
- 本包只写了本文件。没有改实现、测试、SPEC、TESTMAP、超时或审批，没有编译或运行 Rust。

### L05：两个映射提交全部抽检

| 提交 | 映射改动 | 最低抽检数 ceil(10%) | 本次核对 |
|---|---|---|---|
| `00d70cb5947296293bfc288fe13863d5cfa6d44e` | 10 条 pending → ported | 1 | 10/10（保留的 9 条，加上被撤回的 CHECK） |
| `a8b71a187c20a1760768d21c56bd022f0de39318` | `g03_target_state_check_constraint` 恢复为 pending | 1 | 1/1 |

**撤回确实生效**：固定 tip 的 `host/plugins/agent-workspace/TESTMAP.md:453`（CHECK）和 `:445`（`g03_migration_creates_completion_outbox_table`）都是 pending。TS 副本 `tests/workspace-completion-outbox.test.ts:241-255` 用的是测试自带的建表语句，证明不了 Rust 走完整迁移后得到的 CHECK 约束，所以保持 pending 是对的。

断言对照（Rust 路径前缀 `src-tauri/crates/dstu-agent/src/chat_v2/`，TS 路径前缀 `host/plugins/agent-workspace/tests/`，测试 id 前缀为 `<文件>::tests::`）：

| 测试 id | Rust 原测试 → TS 用例：断言逐条对照 | 结论 |
|---|---|---|
| `test_non_multimodal_image_request_downgrades_to_ocr` | `vfs_resolver.rs:2918-2925` → `vfs-resolver.test.ts:76-81`。输入 `['image'], false`；3 条断言 `[includeImage, includeOcr, downgraded] = [false, true, true]` | 一致 |
| `test_non_multimodal_pdf_image_request_downgrades_to_ocr` | `vfs_resolver.rs:2939-2948` → `vfs-resolver.test.ts:93-99`。输入相同；4 条断言 `[text, ocr, image, downgraded] = [false, true, false, true]` | 一致 |
| `g03_enqueue_is_idempotent_by_run_id` | `workspace/completion_outbox.rs:443-462` → `workspace-completion-outbox.test.ts:99-110`。5 条：首次 inserted；同一 run 返回 duplicate_run；没有 d-2；按 run 查到 d-1；另一个 run 返回 inserted | 一致 |
| `g03_claim_grace_period_skips_fresh_rows` | `:465-507` → `:112-128`。3 条：截止时间为当前时刻时可认领 1 行；截止时间为 60 秒前时排除新行 d-2；再用当前时刻认领时包含 d-2。比较方向没有反转 | 一致 |
| `g03_claim_excludes_already_claimed_and_terminal` | `:510-539` → `:130-145`。4 条：owner-a 认领 2 行；owner-b 认领为空；markDelivered 成功；再次认领时不含已投递的 d-1 | 一致 |
| `g03_reclaim_expired_claims_returns_rows_to_pending` | `:542-582` → `:147-172`。10 条：过期和有效认领各 1 行；回收数为 1；过期行回到 pending 且 owner 为空；有效行仍是 claimed 且 owner 不变；重新认领 1 行，id 相同，attempt 为 2 | 一致 |
| `g03_release_claim_and_owner_guards` | `:585-628` → `:174-193`。11 条：初次认领 1 行；其他 owner 的 release/delivered/expired 三个操作都返回 false，行仍是 claimed；正确的 owner release 后回到 pending；再次认领 1 行；delivered 成功，状态正确，投递时间非空 | 一致 |
| `g03_terminal_states_reject_further_transitions` | `:631-659` → `:195-210`。7 条：pending 直接投递返回 true；重复投递返回 false；状态为 delivered；首次 expire 返回 true，重复 expire 返回 false；已过期的行不能投递；再认领为空 | 一致 |
| `g03_completion_message_exists_matches_by_run_id` | `:662-696` → `:212-239`。3 条：同一 workspace 的 result 消息按 run 命中；progress 类型不算；其他 workspace 不算 | 一致 |

**生产路径**：`agent-workspace/index.ts:87,92` 发布 resolver 和 outbox。`src/vfs-resolver/assets.ts:37,105` 和 `pdf.ts:245` 调用的正是被测的两个 mode 函数；L04 的 `chat/index.ts:224-225,327,340` 消费这些服务，`chat/src/variant-retry.ts:115` 传入模型的 isMultimodal（可以是 false）。七条 outbox 测试调用的是生产仓储里的 SQL；L04 `completion-dispatcher.ts:226` 查重并在 finally 中关闭连接，`:326-340` 执行 reclaim/claim/release。

**签收范围**：九条的断言对应和生产可达性都通过，**没有发现只按名字映射的条目，所以不需要通知 C2 整包拒收**。七条 outbox 测试用的是内存 SQLite 和测试自带的建表语句，只能证明仓储的状态转换，不能证明生产迁移、dispatcher 整条链路或 CHECK 约束。

**TESTMAP 计数**（按表格行统计，不看已过时的表头）：L05 在 87b 时为 ported 359 / pending 21 / obsolete 21，在 967f 时为 368 / 12 / 21。**本包开始和结束都是 368/12/21，本包新增映射为 0。** L17 在 967f 时为 109/57，L18 为 236/7，本包都没有改动。

---

### 可直接落盘的草案一：`host/plugins/memory/ACCEPTANCE.md`

# L17-memory-research 独立验收初稿（R2-review-agent，2026-11-05）

结论：**不通过。这是初稿，未覆盖全域。** 审读基线是 `967f43c75`，不包含之后合入 main 的 `a80ba453c` 映射（相关反证见本节末尾）。本次只对三个高风险命令做了全分支静态审读，并补查了服务层的取消边界；没有达到 15 条命令和 15 条 Rust 测试对照的门槛。

本草案中的 TS 路径省略前缀 `host/plugins/memory/`；Rust 路径省略前缀 `src-tauri/crates/dstu-memory/src/memory/`。

#### 审读清单

| 入口 | 已审分支与生产路径 | 判断 |
|---|---|---|
| `memory_add_relation`（契约 `contracts/ipc/L17-memory-research.json:6`，SPEC:26，Rust `handlers.rs:365`） | `index.ts:159-164` → `src/service.ts:633-663`。覆盖：先读取 A 和 B；同一 id 拒绝；校验在记忆根目录内；第二次读取时不存在；分别校验 A、B 的版本；已有引用时不重复写，缺少引用时经 L10 写入；第二个写入失败时回滚；成功后先写 audit 再发 changed 事件；返回 null。对照 Rust `service.rs:3588-3705`。命令层 `index.ts:17-35` 对 StorageError 保留 `Database error:` 前缀，其他错误转成字符串 | 双向 OCC 和所有权正确；事务边界和成功日志与 Rust 不一致（M03、M04） |
| `memory_batch_delete`（契约:58，SPEC:44，Rust `handlers.rs:479-519`） | `index.ts:193-203` → `src/write-store.ts:247-260,158-180`。覆盖：空数组时全为 0；按顺序逐条 await；失败计入 failed，只保留前 5 条错误；只有 succeeded > 0 时才做维护并发事件；changedIds 不出现在返回值里。单条 delete 的顺序：校验后主删除，索引清理失败时 warn，再标记 disabled、清理反向引用，最后写 audit。对照 Rust `service.rs:3416-3488` | 批量控制流和返回形状一致；索引删除失败时缺少独立 purge，也缺最终 info（M02、M03） |
| `memory_get_audit_logs`（契约:280，SPEC:134，Rust `handlers.rs:948-966`） | `index.ts:280-282` → `service.ts:174-177` → `repository/audit.ts:5-25`。覆盖：limit 默认 50 并夹在 1..200；offset 默认 0；三个可选过滤条件按 source、operation、success 的顺序绑定；空字符串过滤会保留，false 不会丢；按 id 倒序分页；可空字段保留；confidence 按 f32 处理；SQL 错误返回字符串。对照 Rust `audit_log.rs:307-377` | 普通取值一致；i64 在 Host 内部丢精度（M01） |

另外补查了 `service.ts:853-882` 和 `:1038-1057`（flush 和 extraction）：输入过短时跳过；signal 原样传下去；失败时分别加上前缀 `Memory flush LLM call failed:` 和 `LLM extraction call failed:`。这两条路径缺少的 L02 接口见下文依赖一节。

#### 必须修复

- [ ] **D1-L17-M01（L17）audit 读取 i64 时丢精度。** `repository/audit.ts:15-24` 只做了类型断言，没有逐行解码，也没有开启 safeIntegers。F3 的 `host/platform/storage/connection.ts:166` 默认关闭 safeIntegers，所以 `id` 和 `duration_ms` 在 Host 内部已经被转成 Number。Rust `audit_log.rs:291,304,358,371` 使用精确的 i64。standard-v2 第 49 行（D3）要求内部值保持精确，wire 边界的投影是另一个问题。复核标准：SQLite 中合法的 `9007199254740993` 读出来不能变成 `9007199254740992`。现有的小数值 confidence 测试通过，不能用来关闭这一项。
- [ ] **D1-L17-M02（L17，需协调 L12 vfs-index；purge 所涉表归 L11）向量删除失败后仍要独立 purge。** Rust `service.rs:3426-3450` 在主删除之后，即使 Lance 删除失败也只 warn，然后照常调用 `purge_index_artifacts_by_resource`，把孤儿向量排进队列。TS `write-store.ts:169-175` 只 await L12 的 `deleteResourceIndex`；真实实现 `host/plugins/vfs-index/src/full-indexing.ts:692-699` 在 multimodal 删除失败时直接 throw，不会执行到 `:699` 的 purge；L17 捕获异常后直接去标记 disabled。L10 的笔记删除只把 units 标成 disabled，不能代替 purge。修复要求：通过所有者的公开 API 做独立的 best-effort purge，主删除仍算成功并保留 warn。复核要用真实的所有者组合注入 Lance 失败，然后检查 units、segments 和 `__lance_orphan_queue`。
- [ ] **D1-L17-M03（L17）缺少两条成功 info 日志。** Rust `service.rs:3470` 的 `[Memory] Deleted note: ...` 和 `:3686` 的 `[Memory] Added relation: ... <-> ...`，在 TS（`write-store.ts:175-179`、`service.ts:659-662`）里都没有，代码直接写 audit。audit 持久化不能代替日志。复核：成功和重复关联两种情况，以及删除时出现 warn 但最终成功的情况，info 都要出现在 audit 之前。
- [ ] **D1-L17-M04（L17）relation 的事务开始位置和方式与 Rust 不同。** Rust `service.rs:3620-3637` 先读取并校验两端版本，然后才开 SAVEPOINT。TS `service.ts:645-659` 先 BEGIN IMMEDIATE，再读取和校验。F3 的 `host/platform/storage/database.ts:426-445` 会立即 begin，如果已经在事务中就报错，不会自动退化成 savepoint。因此在写锁竞争时，TS 可能在版本校验之前就报 busy，而 Rust 会先报版本冲突；可嵌套的 savepoint 语义也丢了。修复：恢复“先校验、后在同一连接上开 savepoint”的顺序，同时保证第二个写入失败时撤回第一个。这一项的证据来自源码；现有的单连接 OCC 测试覆盖不到锁竞争，本次也没有动态复现。

#### 已核实通过（仅限所列子项）

- [x] 笔记的写入和删除经 L10 公开方法，索引状态经 L11 公开方法（`repository/vfs.ts:499-508,527-538`），所选写路径中没有复制 notes 主表的写 SQL。`removeIncomingRefs`（`:547-561`）调用 L10 的 `rewriteTagsWithoutTouchingUpdatedAtWithConn`，使用同一连接，不推进 updatedAt。`tests/note-content-owner.test.ts:98-116` 用真实的 L10/L11 组合覆盖了这条路径，本次已亲自运行。
- [x] `TESTMAP.md:104` 的 Rust 测试 `service.rs:4861-4942 relation_occ_is_atomic_and_advances_both_versions` 与 `tests/service-occ.test.ts:40-64` 的 10 条断言一一对应：changed 为 true；两端版本都推进；双向关联建立；用旧版本解除时报冲突；失败后关联仍在；用最新版本解除成功；两端关联都为空。本次已亲自运行。但 support 中的 notes 和 repos 是替身，所以这一条不能用来签“第二个写入失败时回滚”，也不能签 M04。
- [x] `tests/config.test.ts:120-142` 通过真实命令和 SQL 验证了 audit 的过滤、夹值、可空字段和小数 f32。上述三条抽样：3 passed / 14 skipped（-t 过滤掉的），job `20261105140653-3e0078`，exit 0，没有 Errors 行。

#### 依赖与未审范围

- [ ] **L02 接口尚未提供。** `api.ts:103-115` 要求 `callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal): Promise<{ assistantMessage: string }>`，但固定基线的 `host/plugins/llm/api.ts` 里没有这个方法；`service.ts:853-862` 在缺少接口时明确报错，没有偷偷退回普通 model2。原语义见 `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:8842-8852`：使用 memory_decision 角色（回退到 model2）、force_json、Memory caller、memory_decision task。需要 L02 发布真实接口，flush、search、compressor、extraction 都在等这个接口。
- [ ] 没有达到 15 条命令和 15 条映射的门槛。其余 memory CRUD、search/rerank、smart-write/dedupe、HPIAS、insight、mastery、quick-assistant、flush ledger 和后台维护都还没审。
- [ ] `a80ba453c` 新增的 47 条映射（45 条 ported、2 条 merged）不在本草案基线内，**完整的 ceil(10%) 复核留给后续工作包**。按 C2 指令，本次只优先核了下面三类反证。

#### a80 反证（main `1f3d621f0`，实现代码与 967f 相同）

本节只记录证据，不改 TESTMAP，纠正由 C1 提交。行号是 main 上 `host/plugins/memory/TESTMAP.md` 的行号。

| 条目 | 证据 | 判断 |
|---|---|---|
| `academic_search_executor.rs::tests::academic_sources_share_reply_citation_ledger`（TESTMAP:153） | Rust `src-tauri/src/chat_v2/tools/academic_search_executor.rs:1043-1071` 使用共享的 `crate::chat_v2::context::CitationLedger`，也就是每条回复共用的编号账本。TS `tests/chat-tools.test.ts:30-49` 测的是 `src/academic-search.ts:175-192` 里本地复制的 `CitationLedger` 和 `buildNumberedSources`。在生产代码中，`academic-search.ts` 只有 `tool-metadata.ts:3` 导入，而且只用 canHandle/sensitivity；真实的每回复账本是 L03 的 `chat-pipeline/src/citations.ts:21`（`citationLedgerForReply`），由 `vfs/src/tools/retrieval-executor.ts:197` 消费。断言文本虽然一样，但被测对象是没有生产调用方的复制品 | **反证**，应恢复 pending |
| `learning_overview_executor.rs::tests::normal_aggregation_and_pagination_preserve_full_totals`（:166），以及同文件中 a80 映射的 `overview_*`、`daily_parser_*`（:163-165） | 断言与 Rust `:1202-1247` 一致，但被测函数 `aggregateActivities`、`aggregatePomodoro`、`mergeDaily`、`paginate`（`src/learning-overview.ts:206-275`）在非测试代码中没有调用方。`index.ts:77-80` 只注册了 `toolMetadata.learningOverview`，而 `src/tool-metadata.ts:38-43` 只提供 name/canHandle/sensitivity/concurrency，没有执行器。模块因为元数据被导入，所以按模块检查 wiring 会显示“可达”，但这些聚合函数在生产中并没有被调用 | **反证**：只能证明孤立的纯函数，不能算生产路径已迁移 |
| `learning_overview_executor.rs::tests::learning_activity_and_pomodoro_aggregate_real_migrated_rows` 和 `learning_activity_sql_failures_are_reported_as_partial_sources`（:168-169） | `tests/learning-overview-db.test.ts` 直接调用 `repository/learning.ts` 中的 `collectLearningActivities`、`pomodoroDailyStats`。在 host 的非测试代码中，没有任何模块导入 `repository/learning.ts`，它从 `index.ts` 完全不可达。迁移后的真实数据库 fixture 是真的，但没有生产调用方 | **反证**，应恢复 pending，等待真实的 learning_overview 执行器接入 |
| `hpias/service.rs::tests::request_carries_session_and_intent`（:125） | Rust `src-tauri/crates/dstu-research/src/hpias/service.rs:114-126` 构造的是具名类型 `HpiasResearchSessionRequest {session_id, question, intent}`，生产调用在 `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:355`。TS `tests/hpias.test.ts:178-183` 构造的是没有类型标注的对象字面量，`sessionId` 的断言只是读回自己刚写入的值。TS 的 `HpiasResearchSessionRequest`（`src/hpias-research.ts:34-38`）在生产中没有使用；真实请求类型是 `api.ts:39-46` 的 `{window, sessionId, title, intent}`，字段是 `title` 而不是 `question`。唯一有意义的断言 `intentHasResearchBlocks` 确实能经 `hpias-service.ts:81` 到达生产 | **部分反证**：请求类型的绑定没有被证明，只有 intent 的门控断言成立 |

上面四条中，“真实调用方”和“learning 数据库聚合”两类各条都没有生产调用方，“请求类型绑定”一条只有门控断言成立。a80 中其他 41 条映射本次没有审，结论不外推。

**C2 后续裁定（转述 C2-platform 协调者指令，R2 未重跑）**：C2 另抽了 5/47 条。`validateMergeDecision`、`backendKindFromConfig`、`parseArxivAtom`、`parseBatchMoveArgs` 四个函数只有定义和测试调用；`service.ts:518-526` 明确跳过 semantic dedup；`hpias-service.ts` 只导入 `shouldStartResearchSession`；`tool-metadata.ts` 只导入分类函数。只有 think_tag 一条经 `parseDecisionResponse`/fact-decision 有真实生产链。C2 已裁定 a80 的 47 条映射整体退回，待锁 `2070379` 释放后回滚 a80（只动 TESTMAP，不动生产代码）。本草案保留这些缺口：**按模块计算的 wiring 为绿，不代表这些映射已完成**。

---

### 可直接落盘的草案二：`host/plugins/media/ACCEPTANCE.md`

# L18-media-docs 独立验收初稿（R2-review-agent，2026-11-05）

结论：**不通过。这是初稿，未覆盖全域。** 审读基线是 `967f43c75`。本次对三个高风险入口做了全分支静态审读，没有达到 15 条命令和 15 条 Rust 测试对照的门槛。

TS 相对路径省略前缀 `host/plugins/media/`。

#### 审读清单

| 入口 | 已审分支与生产路径 | 判断 |
|---|---|---|
| `handout_llm_complete`（契约 `contracts/ipc/L18-media-docs.json:503`，SPEC:268，Rust `src-tauri/src/cmd/handout.rs:45-94`） | `index.ts:1206-1226` → `src/handout-llm.ts:120-127` / `src/handout.ts:7-62`。覆盖：按 Rust 的 trim 判断空 prompt；按 Unicode 标量计数，上限 120000；jsonMode 缺省为 false；requestId 为空或缺省时用临时 token，非空时复用；预先取消时不调用模型；正常返回、输出中 cancelled、在途取消、L02 AppError 原样传播；release 只从表中移除，不取消旧请求。caller 和 task 都是 media_handout | 参数、返回值和错误一致；取消不能停止 HTTP，监听器会泄漏（M01） |
| `media_progress_set`（契约:1560，SPEC:701，Rust `src-tauri/crates/dstu-media/src/media/commands.rs:545-567`） | `index.ts:446-458` → `src/media-commands.ts:52-58,199-217` → L11 `host/plugins/vfs-repos/repository/media-transcripts.ts:250-301`。覆盖：按 file id 或 resource id 查找；找不到时报 NotFound，不是媒体时报 InvalidInput；缺省或 null 时保留旧值；负的 position 归 0；duration 非正时保留旧值；delta 夹在 0..120000；显式的 finished 优先，否则沿用已有的 true，或在播放到 95% 时自动完成；没有旧行时用默认值；upsert；输出 camelCase | 使用调用者的连接、写入归所有者，普通取值正确；i64 饱和上限和错误映射有缺陷（M02、M03） |
| `upload_pdf_ocr_page`（契约:2927，SPEC:1368，Rust `src-tauri/src/commands.rs:748-772`） | `index.ts:303-309` → `src/pdf-ocr-service.ts:359-362,822-858`。覆盖：会话不存在时报 NotFound；data URL 的扩展名；mkdir 失败；data URL 缺少 base64 标记；base64 解码失败；写文件失败；width 和 height 都为正时直接使用，否则读取图片尺寸，读取失败也覆盖；先保存图片，再 await 有界通道的 send；接收端关闭时返回 Unknown `OCR session closed`。对照 Rust `src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:140-157,874-919`。上传会话不进入 cancel/pause 控制表，这是 Rust 原本的行为，不算缺陷 | 普通上传和取尺寸路径有真实文件测试；worker 退出后没有关闭接收端，“会话已关闭”分支实际上走不到（M04） |

#### 必须修复

- [ ] **D1-L18-M01（L18 与 L02）取消必须真正终止在途的模型调用，完成后要释放监听器。** Rust `src-tauri/src/cmd/handout.rs:6,45-62` 用 select 在取消时 drop future，从而中断 HTTP。TS `src/handout.ts:54-59` 只是 race，然后吞掉迟到的 reject；`src/handout-llm.ts:125-126` 没有传 AbortSignal；L02 的 `host/plugins/llm/api.ts:312-313`（`callModel2RawPromptOpts`）和 `host/plugins/llm/src/raw_prompt_service.ts:261-264` 都没有取消参数。另外，`CancellationToken.cancelled()`（`src/handout.ts:18-20`）每次调用都挂一个监听器，成功或失败后都不会移除，同一个 requestId 多次调用会不断累积。修复：由 L02 发布支持取消的文本接口，由 L18 传入 token 并清理监听器。现有测试只断言了“前端收到 cancelled”和“迟到的 reject 不会变成 unhandled”，不能证明 HTTP 已经停止。
- [x] **（WP-C2-VERIFY-009 复核：owner 读算写已消除，签收范围与新问题见文末该节）D1-L18-M02（主要所有者 L11 vfs-repos，L18 消费）progress 的 i64 被 Number 截断。** L11 `media-transcripts.ts:32-38,256-262` 把 bigint 转成 Number，`:281` 在累加观看时长时饱和到 `Number.MAX_SAFE_INTEGER`。Rust `src-tauri/crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs:454-535` 全程使用 i64，`:500` 的 saturating_add 上限是 i64::MAX。这改变了持久化的数值，不只是显示精度问题。修复由 L11 负责内部精确读取、计算和写入，L18 保持合法的 wire 投影。
- [ ] **D1-L18-M03（L18）progress 的数据库错误变成了 panic。** `index.ts:116-123` 的 `mediaFailure` 只识别 MediaError 和 BiliRequestError；`loadMediaFile` 直接执行 SQL，可能抛出 StorageError；L11 的 `repository/errors.ts:5-12` 会把 SQL 错误转成 VfsRepositoryError。这两种错误都会被原样重新抛出。kernel `host/kernel/commands.ts:14-19` 把非 CommandError 的异常当作 panic 处理，前端拿不到正常的业务错误。Rust `commands.rs:554-566` 对每一步都做了 map_err，`src-tauri/crates/dstu-media/src/media/mod.rs:82,93-117` 统一输出 `database-failed` 的 JSON 字符串。修复：只转换预期的数据库错误并保留 message，不要把未知的程序错误也吞成 Database。
- [ ] **D1-L18-M04（L18）上传 worker 退出时必须关闭接收端。** `src/pdf-ocr-service.ts:353-355,389-397,433-445` 中，不论是配置失败提前返回、正常完成还是异常，都没有调用上传通道的 `closeReceiver()`；该方法唯一的生产调用在 `:615`，属于另一个后端渲染通道。Rust 的 page_rx 归 worker 所有（`pdf_ocr_service.rs:874-919`），worker 返回时就被 drop，之后的 send 会报 `OCR session closed`（`:150-154`）。TS 在 worker 退出后仍然能成功放入 32 页，之后的 send 会一直等待容量，永远不会返回。修复：在上传 worker 结束时（finally）关闭接收端，保持“先保存图片、后 send”的原顺序。
- [ ] **D1-L18-M05（L18，需协调 L11）字幕投影仍直接写 files 表。** `repository/media-commands.ts:41-42` 仍在执行 `UPDATE files SET extracted_text`，真实调用方是 `src/media-commands.ts:185`（importSubtitle）；文件头说的“写入都在 L11”与代码不符。对应 Rust `src-tauri/crates/dstu-media/src/media/pipeline.rs:331`（`write_transcript_text`）。这是历史问题 R1-MD-01/L18-M02/L18-B01 中尚未解决的部分。修复：由 L11 公开一个使用同一连接的投影 API，L18 委托调用。

#### 已核实通过（仅限所列子项）

- [x] progress 命令把调用者的连接交给 `vfsRepo.mediaTranscripts`，L18 中没有复制 media_progress 的写 SQL；缺省/null、普通 delta 和 finished 的各个分支与 Rust 一致。`tests/media-commands.test.ts` 安装了真实的 media 命令和真实的 L11 仓储，并跑了 F3 迁移；vfsDatabase 的装配用的是替身。
- [x] `tests/handout-llm.test.ts:74-120` 覆盖了 caller/task、jsonMode 缺省和 true、空 prompt、超长 prompt、120000 个 emoji、预先取消、输出中 cancelled、在途取消返回 cancelled，以及 L02 AppError 的传播。rawPrompt 是受控的替身，所以这些测试不能证明 HTTP 已经停止。
- [x] `tests/pdf-ocr-service.test.ts:114-156` 使用真实命令、临时目录、真实文件以及生产 worker 和通道，覆盖了两种尺寸来源、路径、FreeText、事件、缓存和会话不存在。注意第二个用例里的坏 base64 断言针对的是 init 的 PDF，不是上传的图片。
- [x] 上述七条抽样：7 passed / 40 skipped（-t 过滤掉的），job `20261105140653-7a29aa`，exit 0，没有 Errors 行。测试通过不能关闭 M01–M05。

#### 依赖与未审范围

- [ ] 需要 L02 提供支持取消的 model2 文本 raw 接口（对应 Rust `handout.rs:84-92` 调用的 LLM 方法）。已有的图片可取消接口 `callRawPromptWithConfigIdAndImagesCancellable` 不能代替文本接口。L11 负责 progress 的 i64 精度和 files 投影的写接口。
- [ ] 没有达到 15 条命令和 15 条映射的门槛。DOCX 导出、图片 pin/unpin、B 站网络/登录/播放桥、字幕流水线、OCR 后端重试和 pdfium 生命周期、VLM 选型、题目导入、TTS 等都还没有审。

---

### 本包亲自运行的记录（基线 967f43c75）

命令都加了前缀 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run --`，完整日志在 `/home/dsdev/.oc-jobs/done/<job>.log`。skipped 是被 `-t` 过滤掉的已有用例，不是新增的 skip。

| job | 命令 | 结果 |
|---|---|---|
| `20261105140043-81961c` | `npm run typecheck:host` | exit 0，没有 tsc 错误 |
| `20261105140239-26ca66` | `npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts host/plugins/agent-workspace/tests/vfs-resolver.test.ts -t 'g03_(enqueue\|claim\|reclaim\|release\|terminal\|completion_message)\|test_non_multimodal'` | 2 个文件通过；9 passed / 12 skipped（共 21）；7.51s；exit 0；没有 Errors 行 |
| `20261105140653-3e0078` | `npx vitest run -c vitest.host.config.ts host/plugins/memory/tests/service-occ.test.ts host/plugins/memory/tests/config.test.ts host/plugins/memory/tests/note-content-owner.test.ts -t 'relation_occ_is_atomic\|audit command filters\|memory_delete removes incoming'` | 3 个文件通过；3 passed / 14 skipped（共 17）；33.14s；exit 0；没有 Errors 行 |
| `20261105140653-7a29aa` | `npx vitest run -c vitest.host.config.ts host/plugins/media/tests/handout-llm.test.ts host/plugins/media/tests/pdf-ocr-service.test.ts host/plugins/media/tests/media-commands.test.ts -t 'handout_llm_complete calls\|check_prompt rejects\|run_cancellable:\|L02 AppError\|upload session:\|upload_pdf_ocr_page on\|media_progress_get and media_progress_set'` | 3 个文件通过；7 passed / 40 skipped（共 47）；30.51s；exit 0；没有 Errors 行 |

表格中的 `\|` 只是 Markdown 转义，实际正则用的是 `|`。合计 8 个文件、19 passed、0 failed。这些不是两个域的全量测试。

#### 缺陷探针与只读检查

缺陷探针 `/tmp/opencode/r2-d1-probe.mjs` 直接导入固定基线的生产模块，只用临时目录里的数据库（跑完即删），不在仓库里留测试文件。job `20261105143026-3bd7be`，exit 0，输出原文：

```
PROBE L17 audit i64: stored 9007199254740993 -> id=9007199254740992 (number), durationMs=9007199254740992 (number)
PROBE L18 progress i64: stored 9007199254740993 read=9007199254740992; after +1 returned=9007199254740991, persisted=9007199254740991 (Rust i64: 9007199254740994)
PROBE L18 progress SQL error: rejected HandlerPanic=true value=command "media_progress_set" panicked (in production the frontend promise would never settle): Database error: no such table: media_progress
PROBE L18 upload after worker exit: worker Completed(failed_count=1) then addPage resolved (Rust: OCR session closed)
PROBE L18 handout listener cleanup: two successful calls leave 2 cancellation listeners
```

这五行依次动态复现了 D1-L17-M01、D1-L18-M02（读出时已丢精度，+1 后持久化值反而变小）、D1-L18-M03、D1-L18-M04、D1-L18-M01 的监听器泄漏部分。D1-L17-M02/M03/M04 和 D1-L18-M05 仍只有源码证据。

| job | 命令 | 结果 |
|---|---|---|
| `20261105143027-2c2b71` | `node scripts/electron-migration/importable.mjs host/plugins/memory/index.ts host/plugins/media/index.ts` | `importable: ok`，exit 0 |
| `20261105143028-333df3` | `node scripts/electron-migration/wiring.mjs --lane memory` | `合计 ported 109，其中所测模块未从 index.ts 接入 0（0.0%）`，exit 0 |
| `20261105143029-9d20d5` | `node scripts/electron-migration/wiring.mjs --lane media` | `合计 ported 236，其中所测模块未从 index.ts 接入 0（0.0%）`，exit 0 |
| `20261105142917-f434a0` | `npm run migration:ledger -- --check --no-write` | exit 0，原文：`ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 89.5% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 14 (unknown 3660, not vetoed)` |

wiring 是按模块检查的：只要被测文件能从 index.ts 导入到，就算接入。所以它不能发现 a80 里的函数级不可达，例如 `learning-overview.ts` 因 tool-metadata 被导入，但聚合函数没有调用方。memory 的 109 是 967f 基线的计数，不含 a80。

### 交付说明

- 路径授权阻塞：两份草案只能放在本 audit 中，由协调者决定授权给谁落盘到正式路径。本包没有创建新的 ACCEPTANCE。
- 修复派发：L17 有 4 项代码缺陷，另有 L02 memory-decision 接口依赖；a80 的反证交给 C1 纠正。L18 有 5 项缺陷，其中精度问题主要归 L11，取消涉及 L02，files 投影涉及 L11。两个 lane 的共性问题是：内部 i64 不保持精确，以及 Rust 中 Drop 或失败后的清理在 TS 中丢失。
- 供抽检：① L05 `g03_release_claim_and_owner_guards` 的 11 条断言对照，以及 CHECK 副本使用测试自带建表语句的问题；② a80 `academic_sources_share_reply_citation_ledger` 测的是没有生产调用方的本地账本副本。

### WP-C2-D1-002 交付回执

```
结论：部分完成，L05 九条映射全部签收；L17/L18 两份验收初稿均不通过、非全域（L17 M01–M04，L18 M01–M05），只能放在本 audit 中；a80 反证已记录，C2 裁定整批退回。
提交：5b8c597bb、af8782cf7（合并 main 后分支 tip c4d8c753c，基线 main 14d1848d0）
自检：lane-gate（直接运行，不经 job.mjs 包装）exit 0，“自检全部通过（c4d8c753c，基线 main 14d1848d0）”，typecheck 与 boundaries 两项均通过。此前两次经 job.mjs 包装的父作业：20261105144824-bae79b 因执行器重启 exit -1；20261105150742-42bcb1 在 30 分钟时被 SIGTERM（code 128），按 C2 说明属编排超时，其子作业 boundaries 20261105150846-a09e10 exit 0，0 violation。另单独补跑 typecheck 20261105153942-a61800 exit 0。
测试：L05 2 个文件 9 passed / 0 failed / 12 skipped（20261105140239-26ca66）；memory 3 个文件 3/0/14（20261105140653-3e0078）；media 3 个文件 7/0/40（20261105140653-7a29aa）；skipped 均为 -t 过滤。缺陷探针 20261105143026-3bd7be 复现 5 项缺陷；importable ok（20261105143027-2c2b71）；wiring 中 memory 和 media 均为 0 未接入（…333df3、…9d20d5，按模块计算，不能作为完成证据）；ledger 20261105142917-f434a0 problems 0。
TESTMAP：本包没有改动。L05 前后均为 368/12/21（合并 main 14d1848d0 后仍是 368 ported）。L17 在 967f 为 109/57；L18 为 236/7。
未完成：L17/L18 都没有达到 15 条命令和 15 条映射的门槛，未审范围见两份草案；a80 的完整 ceil(10%) 复核留给后续包（C2 已裁定整批退回）。
阻塞：①正式 ACCEPTANCE 路径未授权；②L17 需要 L02 提供 callMemoryDecisionRawPrompt(prompt, signal?) → {assistantMessage}，对应 Rust model2_pipeline.rs:8842-8852，flush/search/compressor/extraction 在等；③L18 handout 需要 L02 提供可取消的 model2 文本 raw 接口，对应 Rust cmd/handout.rs:84-92。截至 main 14d1848d0，这两个接口都还没有。L11 负责 progress 的 i64 精度和 files 投影写接口。
供抽检：L05 g03_release_claim_and_owner_guards 的 11 条断言对照；a80 academic_sources_share_reply_citation_ledger 测的是没有生产调用方的本地账本副本。
```

## WP-C2-VERIFY-009：D1-L18-M02 / L11 WP100 在 main 上的独立复验（2026-11-06）

结论：D1-L18-M02 原本要求的部分已经消除：L11 owner 对 media_progress 的读、算、写以及落库值都已精确。公开的 getProgress/setProgress 仍返回 Number，但这是 D3 允许的线上投影，与 Tauri 前端看到的数值相同。另外发现两个新问题，都不属于 M02 回归：N1 是错误文案里把 REAL 报成 Integer；N2 是 L18 自己的 SELECT 在 2^53 以上读取时会舍入。

### 基线与口径

- 固定基线 main `b3264ae78`，已包含 WP020 `9a0b540f8` 和 WP100 `32a8b9be4`（两者对 HEAD 执行 `merge-base --is-ancestor` 都退出 0）。开工时 `git merge --no-edit main` 合到 `6898abaae`，新增的提交只涉及 L03。`git diff b3264ae78 HEAD -- host/plugins/vfs-repos host/plugins/media host/kernel host/platform contracts src-tauri` 为空，所以下面的行号对固定基线同样成立。
- 只读：实现、测试、SPEC、TESTMAP 都没有改；没有编译或运行 Rust。Rust 的行为全部来自源码；rusqlite 的版本按 `src-tauri/Cargo.lock:10621-10622` 取 0.40.1，读的是本机 cargo registry 里的源码。WP100 报告只用来定位代码，结论都来自下面的亲跑结果和源码核对。
- 探针 `/tmp/opencode/r2-wp-c2-verify-009/probe.mjs` 用真实的 F3 迁移在临时目录建库（跑完即删），通过 `createTestHost` 真实安装 `vfs-repos` 和 `media` 两个插件。`ctx.vfsRepo.mediaTranscripts` 是 L11 插件自己装配的 `MediaTranscriptRepo`，不是测试手工 new 出来的；`media_progress_*` 命令走真实 kernel 的 invoke 路径。替身只有 settings、paths、notes 和 vfsDatabase 外壳，vfsDatabase 返回的连接就是迁移后的真实库。存储类型用 `typeof()` 和 `CAST(... AS TEXT)` 直接从 SQLite 读。

### 原 M02 三个保证（job `20261105180506-13a2ca`，exit 0，原文摘录）

```
PROBE owner identity: ctx.vfsRepo.mediaTranscripts constructor=MediaTranscriptRepo
PROBE M02 original 993 +1: exact.watched=9007199254740993(bigint) proj.watched=9007199254740992(number); setProgress returned watched=9007199254740994 pos=9007199254740992 dur=9007199254740996; stored pos=9007199254740993(integer) dur=9007199254740995(integer) watched=9007199254740994(integer) finished=1(integer)
PROBE M02 i64::MAX saturation: MAX-1 +120000 -> 9223372036854775807; +1 -> 9223372036854775807; stored pos=9007199254740993(integer) dur=9007199254740995(integer) watched=9223372036854775807(integer) finished=1(integer)
PROBE M02 command wire (media_progress_get/set via kernel): get.watchedMs=9007199254740992; set.watchedMs=9007199254740994 (number); Tauri-frontend JSON.parse("9007199254740994")=9007199254740994 equal=true; stored pos=0(integer) dur=null(null) watched=9007199254740994(integer) finished=0(integer)
PROBE M02 f64 auto-finished order: Number(p)=17113678584007884 Number(d)*0.95=17113678584007884; exact-int p*20>=d*19 is false, f64 is true; repo finished=true (p-1: false); stored pos=17113678584007883(integer) dur=18014398509481984(integer) watched=0(integer) finished=1(integer)
```

| 原保证 | 本次证据 | 判断 |
|---|---|---|
| 读取 993 时不丢精度 | `getProgressExact` 返回 993n（bigint）；实现见 `vfs-repos/repository/media-transcripts.ts:52-54`（safeIntegers 查询）和 `:303-316`（`readI64` 只接受 bigint）。对照 Rust `media_transcript_repo.rs:454-475`，六列都是 `row.get`，读取顺序都是 0→5 | 已消除 |
| +1 后持久化为 994 | 落库值 `9007199254740994`，存储类型 integer；同一行中未参与计算的 position 993 和 duration 995 也保持原值（integer）。旧基线 `143026-3bd7be` 落库的是 991 | 已消除 |
| 饱和上限为 i64::MAX | MAX-1 加 120000，再加 1，结果都是 `9223372036854775807`（integer）；见 `:330-331`，对照 Rust `:496-500`，先 clamp 再 saturating_add | 已消除 |
| auto-finished 保留 f64 转换顺序 | `:332-333` 是 `Number(position) >= Number(duration) * 0.95`。Rust `:501-503` 是 `position as f64 >= d as f64 * 0.95`，`i64 as f64` 和 `Number(bigint)` 都按 IEEE-754 就近取偶舍入，乘法和比较也都是 f64。p=17113678584007883、d=2^54 时，精确整数比较 `p*20>=d*19` 为 false，f64 比较为 true，实现得到 true；p-1 时得到 false。说明实现没有改成整数比例算法 | 一致 |

把 position 归 0、duration 只接受大于 0、显式 finished 优先，以及读取失败时不写入这些分支，与 Rust `:486-535` 逐行对照后一致。读取失败时不写入这一点，本次用 `-1e19` 的行动态确认过：报错之后行内容没有变。

### 边界 1：哪些值已经精确，哪些仍被舍入

- **owner 内部的读、算、写都是精确的**：`setProgressExact`（`:318-349`）全程用 bigint，并以 bigint 绑定写回。原来的 `getProgress`/`setProgress`（`:294-301`）委托给同一份精确实现，只在返回值上调用 `wireProgress`（`:81-90`），对每个字段做 `Number(bigint)`。
- **公开 wire 与 Tauri 一致**：`media_progress_set` 返回的 `watchedMs` 等于 `JSON.parse("9007199254740994")`，也就是 Rust serde_json 输出精确十进制、前端再解析后得到的值；`get` 读 993 返回 …992，与 JSON.parse 的就近取偶结果相同。kernel 的 `host/kernel/json.ts:97-99`（`toWireJson`）也是做 `Number(bigint)`，所以在 owner 处投影还是在 kernel 边界投影，结果是同一个 double。这符合 `decisions.md:118-121` 的 D3 和 WAVE0 §1 G3“前端可见返回值和数据库终态一致”的判定。
- **入参**：`host/kernel/commands.ts:204-214` 总会调用 `checkArgs`，`host/kernel/serde.ts:131-151` 按 serde 的 i64 规则拒绝小数和超出范围的值，所以 `optionalI64` 里的 `BigInt()` 不会收到非整数。前端能发送的值只有 double，两端都按同一个十进制值解码。
- **L18 的 Number 消费点**（`media/src/media-commands.ts:91/115` 的 TranscriptView durationMs、`:173` 的 `!= null` 判断、`:195-218` 的命令返回值，以及 `media/src/pipeline.ts:221` 的 estimate 返回值）都只是把值透传到 wire 或做空值判断，不会写回数据库，也不参与和 Rust 结果有差异的运算。`getProgressExact`/`setProgressExact` 目前在 vfs-repos 之外没有调用方（rg 只命中 L11）。
- **签收范围**：owner 的读、算、写和落库存储类型，以及 media_progress_get/set 的线上返回值。不签：完整的 IPC 保真（这里只用 kernel 的 invoke 路径做了验证，没有跑 Electron 实际的 IPC 传输），也不签 M03。只为类型风格改公开接口不是本项要求的。

### 边界 2：valueKind 把整数值的 REAL 报成 Integer（新问题 N1）

同一个 job 的原文：

```
PROBE valueKind integral REAL 1e20: stored pos=0(integer) dur=null(null) watched=1.0e+20(real) finished=0(integer); safeIntegers JS value=100000000000000000000 (number); repo -> VfsRepositoryError(VFS_STORAGE): Database error: Invalid column type Integer at index: 3, name: watched_ms; command -> HandlerPanic: command "media_progress_get" panicked (in production the frontend promise would never settle): Database error: Invalid column type Integer at index: 3, name: watched_ms; rusqlite expected text (source): "Database error: Invalid column type Real at index: 3, name: watched_ms"
PROBE valueKind fractional REAL 1.5 / integral 5.0: 1.5: stored pos=0(integer) dur=null(null) watched=1.5(real) finished=0(integer) -> Database error: Invalid column type Real at index: 3, name: watched_ms; 5.0: stored pos=0(integer) dur=null(null) watched=5(integer) finished=0(integer) -> watched=5(bigint)
PROBE valueKind negative integral REAL -1e19 at index 1: stored pos=-1.0e+19(real) dur=null(null) watched=1.5(real) finished=0(integer) -> Database error: Invalid column type Integer at index: 1, name: last_position_ms; after: pos=-1.0e+19(real) dur=null(null) watched=1.5(real) finished=0(integer)
```

- **存储类型是数据库允许的**：建表语句 `src-tauri/migrations/vfs/V20261005__media_transcripts.sql:24-31` 不是 STRICT，也没有 CHECK。按 INTEGER 亲和性，5.0 会被转成 integer；1e20 和 -1e19 超出 i64 范围，无法无损转换，所以仍以 real 存储。
- **Rust 的行为（源码，未运行）**：`rusqlite-0.40.1/src/types/from_sql.rs:165-169` → `value_ref.rs:41-46`，只要不是 Integer 就返回 InvalidType；`row.rs:288-293` 用 `value.data_type()`，也就是 Real，构造 `InvalidColumnType`；`error.rs:295-297` 的格式是 `Invalid column type {t} at index: {i}, name: {name}`；`dstu-vfs/src/vfs/error.rs:173,269-272` 再加上 `Database error: ` 前缀。所以 Rust 对这两行应报 `Real at index: 3, name: watched_ms` 和 `Real at index: 1, name: last_position_ms`。
- **TS 的差异**：`media-transcripts.ts:56-62` 的 `valueKind` 用 `Number.isInteger` 判断 number，但在 safeIntegers 读取中，INTEGER 一定是 bigint，number 一定是 REAL。错误种类（VFS_STORAGE）、首个出错列的下标和顺序、不写入这几点都与 Rust 一致，**只有类型名错了**（Integer 应为 Real）。1.5 这类小数会正确报 Real。
- **可达性**：上面的输入是用直接 SQL 在临时库中构造的。`dstu-sync/src/data_governance/sync/mod.rs:5774-5785` 会把非 i64/u64 的 JSON 数字按 f64 绑定，看上去是一条历史输入的来源，但本次**没有端到端复现**同步写入 media_progress 的路径。目前前端也看不到这条文案，因为命令层会先变成 HandlerPanic（M03 在 main 上依然存在，见 `media/index.ts:116-122`）。
- **最窄修复（L11）**：在 media-transcripts 的 safeIntegers 读取路径里，把 `typeof value === 'number'` 一律报成 `Real`，并补一条 1e20 的回归。L11 的另外 11 个文件里也有同样形状的 `valueKind`（例如 `files.ts:61`、`index-units.ts:69`、`todo-utils.ts:39`），它们是否用 safeIntegers 读取、是否有同样的问题，本包没有审，不外推。

### 边界 3：L18 直接 SELECT media_progress（新问题 N2，不在 M02 签收范围）

```
PROBE L18 direct SELECT (out of M02 sign scope): media-ledger watchedMinutes: watched_ms=9007199254799999: TS watchedMinutes=150119987580, Rust i64 9007199254799999/60000=150119987579
```

- `media/repository/media-ledger.ts:180-189` 不用 safeIntegers 读取，`:29-35` 的 `int()` 和 `:211` 先转成 Number 再 `Math.floor(/60000)`；Rust `dstu-media/src/media/ledger.rs:317` 是 i64 整除。上面的值在 2^53 以上，TS 比 Rust 多 1。这是在**输出**上与 Rust 不同（学习概览工具的 watchedMinutes），不只是线上投影的问题。
- `media/repository/media-library.ts:70-83` 同样用 Number 读取。`watchedMs`/`lastPositionMs`/`durationMs` 只是透传，与线上投影相同。但 `media/src/media-library.ts:247-251` 用 Number 按 `lastActivityAt` 排序，Rust `library.rs:343-351` 用 i64 比较；两个超过 2^53 且舍入后相等的时间戳在 TS 中会退回按 id 排序。这一条**只有源码推断，没有复现**。
- 这两条路径只读，不写 media_progress，也不经过 L11 接口，WP100 之前就已存在，不是 WP100 引入的回归，也不阻塞 M02 签收。最窄 owner 需求（L18）：这两个 SELECT 改用 safeIntegers 或改用 L11 的精确读取接口，在 bigint 上完成整除和排序后再投影。是否值得为 2^53 以上的毫秒数排期，由 C1 判断。

### 运行记录

| job | 命令 | 结果 |
|---|---|---|
| `20261105180506-13a2ca` | `node /tmp/opencode/r2-wp-c2-verify-009/probe.mjs` | exit 0；8 行 PROBE，没有 PROBE-ERROR，原文见上 |
| `20261105180714-bb6628` | `npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos/tests/media-transcripts.test.ts host/plugins/media/tests/media-commands.test.ts -t 'media_transcript_repo.rs\|WP-100\|media_progress_get and media_progress_set'` | 2 个文件通过；12 passed / 0 failed / 29 skipped（共 41，skipped 是 media-commands 中被 -t 过滤掉的）；exit 0；日志里没有 error 字样。media-transcripts 的 11 例全部运行（5 例原有 + 6 例 WP-100） |

本包没有重跑 vfs-repos 整个 lane 的 311 条（C2 集成刚跑过）。没有改断言、预算或超时。TESTMAP：本包没有改动，也不新增映射，不涉及命令 B/C 资格。

### 未决与最窄 owner 需求

- 原 M02：owner 的读、算、写和落库，以及 get/set 的线上值，**签收**（上方草案中的 M02 已勾选并指向本节）。
- M03（L18，HandlerPanic）：在 main 上仍然存在，没有变化，不属于本包。
- N1（L11）：safeIntegers 读取中的 REAL 被报成 Integer。修复见上文，范围只在 `media-transcripts.ts:56-62`。
- N2（L18）：`media-ledger.ts` 的 watchedMinutes 已动态证明差 1；`media-library.ts` 的排序只是推断。两条都不在 M02 范围内。

### WP-C2-VERIFY-009 交付回执

- 提交：`4cd82ca16`（本节正文）；之后正常合并 main `4723d8d46`，得到 `b53988e16`；本回执是一个只改文档的提交，在 `b53988e16` 之后。
- 合并后核对：`git diff 6898abaae 4723d8d46` 在 media-transcripts.ts、types/content.ts、media/、kernel 的 json/commands/serde 以及 vfs 迁移这些路径上为空，所以复验结论对新的 main 依然成立。
- 自检：直接运行 `node lane-gate.mjs`（没有经 job.mjs 包一层父作业），输出原文 `✅ 自检全部通过（b53988e16，基线 main 4723d8d46）`。typecheck job `20261105181103-f5d3dc` exit 0；boundaries job `20261105181103-82651d` exit 0（扫描 3062 个文件，0 violation）。

## WP-C2-VERIFY-017：WP104 relation OCC/savepoint/info 窄独验

结论：完成，三个所派子项均接受；D1-L17-M04 的当前生产调用路径与 D1-L17-M03 的 relation 日志子项签收，外层事务嵌套不在签收范围。

### 固定源码与证据范围

- 固定 main：`f3753b68228afed1d70bb3422d681bddce6533e3`；包含正式 WP104 tip `05417353c72b088a65279f08ca771b8d2d55e1bd`（祖先检查 exit 0）。两提交之间本次 service、两个测试、L10 notes API/仓储与 F3 API/database 的 diff 为空。
- 执行目录/分支：`/home/dsdev/dev/ds-mig/R2-review-agent` / `ds-mig/R2-review-agent`。开工工作区干净，有其他 lane 测试并行；正常合并 main 至 `0764800b3`，但审读及定向运行始终使用独立 detached worktree `/tmp/opencode/WP-C2-VERIFY-017-f3753b6`，HEAD 固定为上述 f375。运行前后 tracked status 均为空；只复用现成 node_modules，没有安装依赖。
- 已完整阅读 WORKER、R2 任务卡、memory 的 LANE/BLOCKERS/TESTMAP 与 standard-v2；本包 brief 的窄范围优先于旧卡的全域扫描。WP104 原报告仅作定位线索，其 Node/Electron 各 11 passed 和旧版反证均不算本次独验。
- 下列源码行号全部属于 **f375 固定快照**；T=`host/plugins/memory/`，R=`src-tauri/crates/dstu-memory/src/memory/`。未读取 L17 活跃 WP158 工作树。唯一编辑文件是本 audit，未改实现、测试、SPEC、TESTMAP、ACCEPTANCE 或共享管线。

### 分项判定与签收

| finding 子项 | 判定 | 独立证据 |
|---|---|---|
| D1-L17-M04 / OCC 先后 | **接受** | T `src/service.ts:639–645,667–675,695–704`：相同 ID 拒绝→根目录验证 A、B→固定同一 db→读 A（缺失即报）→读 B（缺失即报）→校验 A→校验 B；全部在 `relationSavepoint` 前。对应 R `service.rs:3614–3637,3732–3758`。真实第二连接持写锁且 B 版本过期时仍报 `CONFLICT(notes.conflict)`，不报 BUSY/locked。 |
| D1-L17-M04 / 双端回滚、版本/revision | **接受** | T `src/service.ts:648–654,676–684,1210–1211` 将 A→B 两次 owner 写包在同连接 deferred transaction + savepoint 内；L10 的内层 `update_note` 已 release 后，B 的真实触发器失败仍撤回 A。add/remove 两例均验证双端 tags、updated_at、revision 数与先前快照完全相等，事务结束、无成功 info/audit；移除触发器重试成功。 |
| D1-L17-M03 / relation info→audit（含 remove 同类增量） | **接受** | T `src/service.ts:655–657,685–687` 在保存点 release、外层 transaction 返回后才 info，再 audit；对应 R `service.rs:3686–3702,3815–3831`。真实命令成功与重复 add 都输出精确 info，日志回调现场查到 audit 分别为 0、1，命令返回后为 1、2；remove 成功也为 info 时 0、返回后 1。 |

- [x] **M04/OCC 顺序子项签收**：不再将旧 BEGIN IMMEDIATE 抢先报 BUSY 的指控用于 f375。
- [x] **M04/第二端失败回滚子项签收**：真实 L10/F3 组合保持双端和 owner revision 的事务回滚。
- [x] **M03/relation 日志子项签收**：Added 与 Removed 均在 audit 前；重复 add 保留日志和 audit。

上方 D1 草案的旧 M03/M04 未勾总项保留历史范围：M03 还包含 deletion 日志（属 WP166），M04 的一般外层事务嵌套不作已支持声明；本节明确签收上述具体子项，不保留已修顺序/日志的重复派修要求。

### 源码核对：同一连接、真实 owner、错误与日志顺序

1. **入口和公开调用**：T `index.ts:159–170` 的两个 IPC 只执行 `commandResult`→`addRelation/removeRelation`→changed→null，没有外层事务；`:23–29` 只作异常转换。R `handlers.rs:365–396` 同样成功后才发 changed。T `src/service.ts:633–637,661–665` 和 R `service.rs:3588–3599,3708–3719` 都先取得最新两端版本，再进入 OCC 实现，因此不把 wrapper 的前置读取误当重复缺陷。
2. **读取与校验的失败优先级**：T `src/service.ts:697–703` 固定 db，只在读 A 成功后读 B；B 缺失优先于 A 的版本冲突，两次读取成功才先 A 后 B 校验。`src/memory-utils.ts:147–154` 对空白版本先报 `Invalid argument 'expected_updated_at': expected_updated_at must not be empty`，非匹配版本报 `CONFLICT(notes.conflict): The memory note has changed since it was read; refresh before retrying.`。同 ID 的 add 中文错误与 remove InvalidArgument 仍各自保留。错误组合的顺序为源码证据，未冒称全部组合均有动态用例。
3. **L10 真正接线**：T `src/service.ts:129–140` 取得 notes/vfsRepo；`repository/vfs.ts:13,40–54,309–311,499–502` 只经 L10 `api.ts` 的 `getNote(id,conn)` / `updateNote(id,params,conn)`（`host/plugins/notes/api.ts:50,55`），bind 保留 receiver。`notes/index.ts:181–193` 提供真实 `noteRepository`；`notes/repository/notes.ts:333–337,436–437` 使用传入 executor。没有 memory 自行写 notes 或另取 owner 连接。
4. **F3 与 deferred 的边界**：`host/platform/storage/service.ts:98–113` 返回同名缓存 handle；`database.ts:344–361,386–389,426–445` 的普通读与同步事务均绑定同一 primary Connection。`api.ts:275–286` 的 savepoint 位于 TransactionScope，不在 DatabaseHandle。T `relationSavepoint` 使用显式 deferred；`connection.ts:268–278` 实际执行 BEGIN DEFERRED/COMMIT/ROLLBACK，首次写才争写锁。`database.ts:164–188` 在子作用域错误时 ROLLBACK TO + RELEASE，`:451–455` 再整体 rollback/重抛；成功是 RELEASE→COMMIT→返回→info→audit。当前自动提交入口与 Rust 顶层 SAVEPOINT→RELEASE 的提交点一致，不能简写成所有情况下完全相同的事务原语。
5. **A/B 写入和历史快照**：add 仅给缺失端追加 ref，remove 过滤对应 ref，未变化端返回读快照，不推进版本；两次写均传读取到的 updatedAt，让 owner 在真正 UPDATE 时再次 CAS。L10 `notes.ts:453–530` 的 `SAVEPOINT update_note` 覆盖 baseline snapshot→UPDATE→edit snapshot，包含错误回滚；`revisions.ts:197–230` 比较 tags 并写真实 revision，不是只改内存。两端都未变化时仍无条件 info/audit。动态 revision 断言为**行数回到原值**，不是逐列比较 revision 内容；内容同事务回滚的保证另有上述源码证据。
6. **日志落点**：T `src/service.ts:144–145` 调生产 host logger；`:1176–1181` 使用 handler/null 默认值写 audit。`repository/audit.ts:129–141` 是真实 INSERT，失败仅 warn，未把 audit 失败变成 relation 回滚。当前 IPC 与 Rust wrapper 的 Handler/None 相符；本包不验证尚无公开生产调用的 ToolCall/session 来源透传。

### 外层事务边界（不是新增可达缺陷包）

- 固定快照的 host 非测试调用检索确认，这组 memory relation 仅由 T `index.ts:161,167` 消费；另外的 insight `addRelation` 是不同服务。T `api.ts:220–297` 的公开 MemoryService 没有 relation/OCC/WithConn 入口。`withDbOverride` 的实际消费者是 smart-write，并无 relation 调用。
- **现有差异明确存在**：若调用者已在该 primary 上开事务，T `relationSavepoint` 仍调用 `DatabaseHandle.transaction`，F3 `database.ts:428–432` 会抛 `cannot start a transaction within a transaction`；Rust 直接 SAVEPOINT 可以嵌套。不能把“当前命令未嵌套”写成未来、全域或任意调用者支持。
- 当前可达的嵌套方向是 **memory 外层→L10 update_note 内层**，本次两种触发器回滚用例已经覆盖；**调用者外层→memory 内层** 没有本快照公开生产调用，也没有本次动态签收。记录为边界，不为假设性调用制造新工作。若后续确实发布该消费链，接缝归 L17 与 F3（DatabaseHandle 保存点能力），届时再按实际调用拆包。
- 不把真实第二连接竞争的结果推广到同一 handle 异步事务写者槽或所有 I/O/COMMIT 故障；不新增这些未被本包要求的测试矩阵。

### 两个测试文件的独立核验

**`tests/relation-savepoint.test.ts`（5 例全部运行）**：

- `:29–82` 通过正式插件入口安装 paths/vfs-repos/notes/vfs-index/vfs/media/vfs-handlers/memory，使用真实 storage；`fixtures/migrated-schema.ts:63–75,95–100` 实际 runAll、关闭空迁移库后复制独立数据目录。仅 logger 是观察器，未替换被测事务、owner 或 relation 算法。
- `:75–80,112–138` 用 `storage.openFile(pathOf('vfs'),{profile:'vfs',mustExist:true})` 得到第二条真实 SQLite 连接；BEGIN IMMEDIATE 持锁，A 版本有效、B='stale-version'，finally ROLLBACK。严格断言 CONFLICT、排除 busy/locked、调用耗时 <2500ms、无事务残留、双端快照和 revision 数不变、无 info/audit。原 profile 的 5000ms busy_timeout 和断言预算未改。raw 的 2226ms 是**整条测试**耗时，不当作内部竞争调用耗时。
- `:140–168` 走真实 `memory_add_relation`，断言两个 updated_at 均前进、双向 ref、info 级别/精确文本和现场 audit 数；再次调用要求 tags/version/revision 数完全不变，但新增 info/audit。
- `:105–109,170–188,209–234` 的 BEFORE UPDATE OF tags trigger 对 B 执行 RAISE(ABORT)，不是 spy 模拟错误；A 已先写且 owner 内层已 release，随后双端快照恢复。add 和 remove 都检查无成功日志/audit与事务退出，删除 trigger 后原命令重试可成功。
- `:190–207` 覆盖已有单向 ref 只写缺失端，以及空白版本拒绝、不写库。重复 remove、缺失端与两端同时版本错误的穷举未动态运行；其分支落点来自源码，不外推为用例覆盖。

**`tests/service-occ.test.ts`（6 例全部运行）**：其中原 Rust `relation_occ_is_atomic_and_advances_both_versions` 全文 R `service.rs:4861–4943` 已逐条核对；对应 TS `:40–64`。10 条原 assert 均保留取值和方向：

| Rust assert 行 | TS expect 行 | 原保证 |
|---|---|---|
| 4892 | 49 | add changed=true |
| 4893、4894 | 50、51 | A、B 版本各自不等于旧版 |
| 4895–4900、4901–4906 | 52、53 | A→B、B→A 的精确列表 |
| 4916 | 55–56 | 旧 A 版本 remove 必须为 Conflict |
| 4917–4922 | 57 | 失败后 A 关联仍为 [B] |
| 4934 | 61 | 用最新两端版本 remove changed=true |
| 4935–4938、4939–4942 | 62、63 | remove 后双端列表分别为空 |

TS 使用同样的 Relation A/alpha、Relation B/beta 输入，没有改弱断言或超时。`service-occ` 的 `support.ts:91,138,173` 仍用 notes owner 替身，因此它只能证明 memory 的原 OCC 断言，不独自证明真实 owner/revision 回滚；该缺口由上面的真实插件测试补证。Rust 测试传 ToolCall/session-relation，但其原 assert 不检查 audit 来源，本次不宣称该额外语义已移植。其余五例只随指定文件执行，不扩成 idempotency/tag/move 独立签收。

### 独立运行原件（只投递一次，Node/Linux）

- job **`20261105203104-61f65c`**，提交/启动 `2026-11-05T20:31:04Z`，结束 `20:31:48Z`，**exit 0**。队列在 R2 工作目录提交，job 中 Node 子进程的 cwd 明确指定固定私有 worktree；原件含实际 HEAD、tracked status 和完整命令。
- raw：`/home/dsdev/.oc-jobs/done/20261105203104-61f65c.log`（25 行全文已读）；job 原件：同目录 `20261105203104-61f65c.json`（含 cwd、完整脚本、起止时刻、code）；Vitest JSON：`/tmp/opencode/WP-C2-VERIFY-017-result.json`（success=true，11 passed / 0 failed / 0 pending / 0 todo，文件集合恰为下面两项）。
- **Errors：raw 无 Errors 报告行、无未捕获异常；不能把 JSON 中没有提供的 unhandledErrors 字段冒填为 0。** 无 `-t` 筛选、无 skip；relation-savepoint 5 passed，service-occ 6 passed，共 **2 文件 / 11 passed / 0 failed / 0 skipped**。
- fork1=`--pool=forks --maxWorkers=1 --minWorkers=1`；沿原 `vitest.host.config.ts:9–10` 的 30000ms testTimeout、默认 hookTimeout 与原 <2500ms 断言，无预算扩张。没有运行 Electron、Rust、全测、ledger 或 media probe。

```text
HEAD=f3753b68228afed1d70bb3422d681bddce6533e3
TRACKED_STATUS=
COMMAND=/opt/node26/bin/node node_modules/vitest/vitest.mjs run -c vitest.host.config.ts host/plugins/memory/tests/relation-savepoint.test.ts host/plugins/memory/tests/service-occ.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=verbose --reporter=json --outputFile=/tmp/opencode/WP-C2-VERIFY-017-result.json
 RUN  v3.2.7 /tmp/opencode/WP-C2-VERIFY-017-f3753b6
 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  04:31:07
   Duration  40.85s (transform 22.75s, setup 0ms, collect 37.29s, tests 23.28s, environment 1ms, prepare 665ms)
RUNNER_EXIT=0
```

raw Start at 为进程本地时间；UTC 起止采用 job JSON。该独验在 20:55Z 进展节点前已完成，无等待后台而重投作业。

### TESTMAP、交付边界与供抽检

- **TESTMAP：pending 57 → 57，ported 109、obsolete 2；本包新增/改动映射 0。** 按 `a80ba453c^..a80ba453c` 实际变更 ID 与 f375 表格逐 ID 比较：原 47 条全部仍 pending（47/47），不恢复任何资格。原 relation 测试映射 `crates/dstu-memory/src/memory/service.rs::tests::relation_occ_is_atomic_and_advances_both_versions` → `host/plugins/memory/tests/service-occ.test.ts:40–64` 保留，逐断言证据如上。
- 未通过项：本包三个当前路径子项无失败；未完成运行范围为外层事务/全域能力，已经明确为边界，不派假设性修复。WP103 delete-hook/smart-write 属 WP166，WP102 精度及 media WP162/163 不在本包。任何 lane 的 B/C/A 运行资格均不据本包恢复。
- 阻塞：本次窄独验无 owner 接口阻塞；审计提交后正常 merge main，直接执行官方 lane-gate，其原回执与精确交付 tip 由 `WP-C2-VERIFY-017.report.md` 保存。该门禁是报告分支自检，不替代 f375 的测试原件。
- 供抽检：① `relation-savepoint.test.ts:112–138` 的真实第二连接、有效 A/过期 B 与 CONFLICT 非 BUSY；② `:170–188,209–234` 的真实 trigger 回滚及 `:154–166,230–233` 的 info 现场 audit 数，与 L10 revision/F3 savepoint 源码交叉核对。

## WP-C2-VERIFY-018：WP163 watchedMinutes / 原 VERIFY009 N2 窄独验

结论：**通过，签收 N2 的 watchedMinutes 子项**。原反例 `9007199254799999 → 150119987579` 已由真实 media 服务、真实 SQLite 和独立运行证实；本子项无残差。历史 VERIFY009 中的差 1 描述由本节更新。

### 固定源码与证据来源

- 固定 HEAD：`b17264b88b951bd611fc7e9100d7b2d6697ac026`（派发指定 main）。`a175635b9`、实现 `365f04f0c`、测试 `601319376` 对该 HEAD 的祖先检查均 exit 0。
- 审计工作目录/分支：`/home/dsdev/dev/ds-mig/R2-review-agent` / `ds-mig/R2-review-agent`。开工工作区干净，正常 merge main 得 `8b995d3fbafb847103f3ff115eb971a3b3746fc0`；实现、测试、服务接线、存储适配、Rust 对照及 Vitest 配置与固定 HEAD 比较无差异。
- 单次运行隔离在 detached worktree `/tmp/opencode/WP-C2-VERIFY-018-b17264b`；运行前后 HEAD 均为固定值，tracked status 为空。只链接已有 node_modules，未安装依赖。作业从 lane 目录提交，子进程 cwd 指向该隔离树；未接触活 ds-fulltest 源码或集成锁。
- 已读正式 `.oc-runs/board/wp/WP-163.report.md`、本报告 VERIFY009 全节及原 `/tmp/opencode/r2-wp-c2-verify-009/probe.mjs`。原 N2 probe 在 `:122–134` 用 bigint 绑定该值、调用真实仓储，原 job `20261105180506-13a2ca` 得 …580。WP163 作者 job `20261105193631-fef2d4`、反证 `20261105193123-3175d2` 仅作来源定位；本次签收依据是下列自身 job。

### 逐源码复核（行号均适用于固定 HEAD）

| 核对点 | 独立证据与结论 |
|---|---|
| 真实生产入口 | `host/plugins/media/index.ts:190–192` 实例化 `MediaCordisService`；`src/service.ts:14,57–69,121` 经 `super(ctx, 'media')` 发布真实仓储方法；`api.ts:311` 是公开方法签名。测试 `tests/media-ledger.test.ts:168–175,198` 安装真实插件并调用取得的 `host.ctx.media.mediaLearningSummary(conn,10)`，没有替换 SELECT 或计算函数。测试取得服务后 dispose host，再用保留的方法和仍存活的真实连接调用；该同步无状态仓储不依赖 host 生命周期。此证据是公开生产服务入口，不是学习概览工具全链验收。 |
| 精确读取 | `repository/media-ledger.ts:180–200` 的命名查询带 `options.safeIntegers:true`。`host/platform/storage/api.ts:215–219` 保留 options；`connection.ts:160–172,195–201` 真正执行 `stmt.safeIntegers(true)` 后 `all()`。INTEGER 因而是 bigint，不经过默认 Number 读取。Rust `src-tauri/crates/dstu-media/src/media/ledger.rs:283–294` 按 i64 读取。 |
| 运算及无损投影 | TS `repository/media-ledger.ts:174–177,219` 先在 bigint 上执行 `(value > 0n ? value : 0n) / 60_000n`，与 Rust `ledger.rs:317` 的 `watched_ms.max(0) / 60_000` 一致。对全部 i64 值，结果在 `[0,153722867280912]`，严格小于 `2^53`，最后 `Number()` 精确；不是把先舍入的毫秒再除。查询本身 `watched_ms > 0` 排除零/负值，max 分支按源码确认，无需新增负数探针。 |
| SQL 与排序 | 对照实现提交父版本及 Rust `:273–281`：JOIN、active/deleted 过滤、`watched_ms > 0`、`ORDER BY p.updated_at DESC`、LIMIT 全保留。SQLite 在投影前按原 INTEGER 排序，随后仅 map，没有 JS Number 重排；safeIntegers 不改变排序。测试 `:200–202` 精确断言六行顺序，含 i64::MAX 时间戳。 |
| finished 布尔 | TS `:29–30,220` 是 `int(row.finished) !== 0`，先将 bigint 转 Number 再比零；任意非零 i64 都不会被转成零，因此与 Rust `:290` 的 i64 `!=0` 等价，也没有 `0n !== 0` 陷阱。测试 `:218` 动态断言 `0n` 行为 false；非零方向为源码证明，不声称新增动态覆盖。 |
| 同行其他投影 | `:203–204,216–221` 的 position/duration 保留 `/1000` 后 u32 饱和，Rust `:296` 同义：未饱和范围内毫秒小于约 `2^42`，整数可精确表示；超过 2^53 的正数已必然饱和，负数归零。duration NULL 保持 null；updated_at 仍只在输出转 Number，与原默认读取以及 Rust JSON 前端投影相同。测试 `:213–222` 断言最大时钟、引用、lastWatchedAt 类型/值及普通值。 |

### 原断言、边界与单次独验

- 完整读过 Rust `ledger.rs:555–697` 原测试和 TS 同名测试 `:67–142`。原 summary 五断言（Rust `:646–653`）对应 TS `:116–120`：`25:10`、对应媒体引用、32 分钟、错题引用 `1:02:03`、attempts=2；原值与方向保持，未弱化。
- 新 WP163 用例 `:168–223` 用迁移后真实 SQLite，六行值均以 bigint 参数绑定（`:179–195`）。明确断言原 N2 的 **…579**，同时保留旧 Number 表达式得 **…580** 的区分断言（`:203–205`）；`59999→0`、`60000→1`、`119999→1`（`:206–208`）；`i64::MAX→153722867280912` 同时有 bigint 除法和独立常数两条期望（`:210–211`）；普通 `1920000/1510000/2880000→32/'25:10'/'48:00'`（`:222`）。此文件足以证实 N2，未另跑 probe。
- **独立原 job：`20261105212112-d4a5a9`，exit 0**；UTC `2026-11-05T21:21:12.435Z` 开始、`21:21:34.206Z` 结束。取得原 wait 回执，没有重投。
- raw：`/home/dsdev/.oc-jobs/done/20261105212112-d4a5a9.log`（18 行全文已读）；原任务 JSON：同目录 `20261105212112-d4a5a9.json`，含提交 cwd、完整子进程命令、起止与 code。
- Vitest JSON：`/tmp/opencode/WP-C2-VERIFY-018-result.json`，`success=true`；**Test Files 1 passed / 0 failed / 0 skipped；Tests 4 passed / 0 failed / 0 skipped / 0 todo**。实际文件集合只有 `host/plugins/media/tests/media-ledger.test.ts`（JSON 的绝对路径根为上述隔离树）。四条均执行：cards、questions/summary、X2-D01、WP163。
- **Errors：raw 无 Errors 报告行，无未捕获异常；JSON 四条 failureMessages 均为空、文件 message 为空。** 未把作者结果或其他 suite 的通过数并入本次统计。
- runner 保持原 `testTimeout=30000`（`vitest.host.config.ts:10`）及 before/afterAll 的 `120000`（测试 `:28,33`），无断言/配置修改、无筛选、无额外超时参数。完整命令及原输出摘要：

```text
npx vitest run -c vitest.host.config.ts host/plugins/media/tests/media-ledger.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=verbose --reporter=json --outputFile=/tmp/opencode/WP-C2-VERIFY-018-result.json
 RUN  v3.2.7 /tmp/opencode/WP-C2-VERIFY-018-b17264b
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  05:21:15
   Duration  18.57s (transform 6.08s, setup 0ms, collect 8.87s, tests 7.60s, environment 0ms, prepare 244ms)
AFTER_HEAD=b17264b88b951bd611fc7e9100d7b2d6697ac026
AFTER_TRACKED_STATUS=""
```

### 签收、边界及交付

- [x] **VERIFY009 N2 / watchedMinutes（owner L18）：独立复验签收。** 原差 1 已消除，整数读取→整除→输出路径符合 Rust；本子项无待派修残差。
- **TESTMAP：media pending 7 → 7，ported 236；新增/改变映射 0。** 按固定 HEAD 表格实际行统计，不采用历史生成表头。原映射 `crates/dstu-media/src/media/ledger.rs::tests::tallies_questions_by_resource_ids_and_assembles_in_request_order` → `host/plugins/media/tests/media-ledger.test.ts:67` 保留；WP163 是回归用例，不新增 Rust id。
- 未完成/范围外：N1/WP162（L11）、WP138 候选 OCR（L18）、library 排序（L18，VERIFY009 源码推断）沿用原状态；不以本次关闭它们。原 M02、VERIFY017 不重复签收；raw 全链及 A/B/C 资格不作结论。非 INTEGER 的数据库类型错误不是本次 i64 运算签收面。
- 本包只改本审计文件；未改实现、测试、SPEC、TESTMAP、ACCEPTANCE 或管线，未跑全 media/全测/ledger，未编译或运行 Rust。
- 阻塞：本次 N2 窄独验无阻塞。审计提交后正常 merge main，再直接运行绝对路径 lane-gate（无父 job）；精确提交 tip、自检原回执与子作业号记录在 `WP-C2-VERIFY-018.report.md` 交付报告。门禁检查报告分支，不替代固定 HEAD 的独验原件。
- 供抽检：① `tests/media-ledger.test.ts:179,203–205` 原 N2 值与不同的旧/新分钟数；② `repository/media-ledger.ts:174–200,220` 的精确读取/有界无损投影/零布尔，与 Rust `ledger.rs:283–296,317–319` 对照。

## WP-C2-VERIFY-019：WP162 / 原 VERIFY009 N1 REAL 错误名窄独验

结论：**通过，签收 N1 子项（owner L11-vfs-repos）**。真实 SQLite 中 `-1e19`、`1e20` 的存储类型为 REAL，四个 progress 仓储入口均返回与锁定 rusqlite 一致的完整 `Real` 错误，保持首个错误列顺序及失败后数据不变；正常 INTEGER 精确读取仍为 bigint。本子项无残差，VERIFY009 的 N1 未决状态由本节更新。

### 固定源码与独立性

- 固定 HEAD：`33d1323a9df2205f3c13cacf89f157242ada9b90`（派发指定、已入 main）。WP162 实现 `012ddf57c`、L11 合入 `be646` 对该 HEAD 的祖先检查均 exit 0；已读正式 `.oc-runs/board/wp/WP-162.report.md` 与本文件 VERIFY009 全节。作者 job/probe 只作定位，不计入本次亲跑证据。
- 审计目录/分支：`/home/dsdev/dev/ds-mig/R2-review-agent` / `ds-mig/R2-review-agent`。开工工作区干净，检测到其他 lane 并行测试；正常 merge main 得 `47527061cbc16b3f656dc44f234e5c1dd8857baa`。已用 `git show main:host/plugins/vfs-repos/repository/media-transcripts.ts` 核实修复存在。
- 独立 detached worktree：`/tmp/opencode/WP-C2-VERIFY-019-33d1323`；运行前后 HEAD 都是上述固定值，tracked status 都为空。命令从 lane 目录提交，job 内仅让测试子进程使用固定树 cwd；链接现有 node_modules，无安装依赖。实现/指定测试/生产接线/存储适配/Rust 对照/锁文件/配置与上述审计分支 HEAD 的针对性 diff 为空。
- 证据为生产仓储入口测试加锁定 Rust 源码审读；未编译或运行 Rust。`src-tauri/Cargo.lock:10621–10624` 锁定 rusqlite **0.40.1**，对应源码取自 `/home/dsdev/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/rusqlite-0.40.1/src/`。

### 源码与断言核对（仓库行号均属固定 HEAD）

| 核对点 | 独立证据与结论 |
|---|---|
| 真实生产接线与数据库 | `host/plugins/vfs-repos/index.ts:23,60,133,167` 装配并发布真实 `MediaTranscriptRepo`；测试 `tests/media-transcripts.test.ts:19–29` 安装该插件，调用 `host.ctx.vfsRepo.mediaTranscripts`。`tests/support/vfs-test-storage.ts:16–40` 经真实 F3 migrations 建模板，再为每例复制独立 SQLite。notes/paths 为宿主替身，未替换 progress 仓储、SQL 或类型解码。 |
| safeIntegers 确实生效 | `repository/media-transcripts.ts:52–54,304–306` 使用 `safeIntegerQuery`；`repository/sql-integers.ts:5–6` 设置 `options.safeIntegers:true`；F3 `host/platform/storage/connection.ts:160–179` 每次执行前调用 `stmt.safeIntegers(true)`。因此 INTEGER 是 bigint，REAL 是 number，不能按 `Number.isInteger(number)` 推断 SQLite 类型。 |
| 错误名及完整文案 | TS `media-transcripts.ts:56–72` 对 number 一律报 `Real`，bigint 才是 `Integer`，`readI64` 只接受 bigint。Rust `types/from_sql.rs:165–169` → `types/value_ref.rs:41–46` 拒绝非 INTEGER；`row.rs:288–293` 用实际 `value.data_type()`，`types/value_ref.rs:26–33` 将 REAL 映为 Real，`types/mod.rs:126–135` 输出 `Real`。`error.rs:295–297` 拼列下标/名称，项目 `src-tauri/crates/dstu-vfs/src/vfs/error.rs:173,269–272` 加 `Database error: `。TS `repository/errors.ts:5–12` 不会给已构造的 VfsRepositoryError 重复加前缀。 |
| 列顺序及失败先于写入 | Rust `src-tauri/crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs:460–470` 按 0→5 读取，`:487` 的读取失败在 `:508` 写入前传播；TS `media-transcripts.ts:295–321,338` 同序。先 `last_position_ms` index 1，再跳过合法 NULL duration，才到 `watched_ms` index 3；set 的输入即使给 position=5，也不能掩盖旧行第 1 列错误。 |
| 可达的 REAL 值 | 原 schema `src-tauri/migrations/vfs/V20261005__media_transcripts.sql:24–31` 无 STRICT/CHECK。测试 `:275–281` 直接向该真实表写入 `-1e19 / NULL / 1e20`，以 SQLite `typeof()` 严格断言 `{p:'real',d:'null',w:'real'}`，不是 JS 整数性猜测。 |
| 四入口精确错误及行不变 | 新 WP162 测试 `:282–303` 对 `getProgressExact/getProgress/setProgress/setProgressExact` 全部检查 `name='VfsRepositoryError'`、`code='VFS_STORAGE'` 和完整 message（对象字段相等，非子串）。先精确报 index 1；仅将 position 修为 7 后，四入口精确报 index 3。两轮之后分别 `toEqual` 完整五个数据列，确认 REAL 值、NULL、finished=0n、updated_at=1n 不变。 |
| 合法 INTEGER 与其他种类 | 测试 `:305–311` 保留 Text/Blob 完整错误；`:313–317` 写入 i64::MAX bigint 后，真实 exact 入口返回 position=7n、watched=i64::MAX、updatedAt=1n，duration=null、finished=false。已有 `:260–270` 的 fractional REAL duration=2.5/watched=1.5 也通过，未把合法 INTEGER 判成 REAL。 |

两条关键错误全文：

```text
Database error: Invalid column type Real at index: 1, name: last_position_ms
Database error: Invalid column type Real at index: 3, name: watched_ms
```

WP162 的测试提交 `982815f75` 仅新增 47 行，原 11 例断言与时限未变。本次保留固定配置 `vitest.host.config.ts:10` 的 30000ms，以及测试文件 hooks、两个 describe 的既有 120000ms（`:23,28,35,149`）；没有筛选或超时覆盖。指定文件已经足证 N1，未另跑 probe。

### 唯一独验 job 与原始结果

- **job `20261105223553-1fc24f`，exit 0**；UTC `2026-11-05T22:35:53.699Z` 开始，`22:36:20.214Z` 结束。通过绝对路径 `job.mjs run` 提交一次；Node v26.5.0、Vitest v3.2.7、forks 单 worker。
- 原 raw：`/home/dsdev/.oc-jobs/done/20261105223553-1fc24f.log`（27 行全文已读）；原 job 元数据：同目录 `20261105223553-1fc24f.json`（含提交 cwd、完整子进程命令、起止及 code）。
- Vitest 原 JSON：`/tmp/opencode/WP-C2-VERIFY-019-result.json`。`success=true`，**Test Files 1 passed / 0 failed / 0 skipped；Tests 12 passed / 0 failed / 0 skipped / 0 todo**。文件集合只有指定 media-transcripts 文件，含新增 WP162 用例。JSON 的 suite 计数含 describe，未将它误记成 3 个文件。
- **Errors 0：raw 无 Errors 报告行/未捕获异常；JSON 12 条 failureMessages 均为空、文件 message 为空。** 原件保留，未重投求绿。

```text
COMMAND=npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos/tests/media-transcripts.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=verbose --reporter=json --outputFile=/tmp/opencode/WP-C2-VERIFY-019-result.json
 RUN  v3.2.7 /tmp/opencode/WP-C2-VERIFY-019-33d1323
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  06:35:56
   Duration  23.29s (transform 3.96s, setup 0ms, collect 5.90s, tests 15.45s, environment 1ms, prepare 279ms)
AFTER_HEAD=33d1323a9df2205f3c13cacf89f157242ada9b90
AFTER_TRACKED_STATUS=""
[作业 20261105223553-1fc24f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105223553-1fc24f.log
```

### 签收与交付

- [x] **VERIFY009 N1 / media_progress REAL 错误名（L11，WP162）：独立复验签收。** `valueKind` 已按 safeIntegers 的实际 SQLite 类型报告 Real，首错列、错误类型/全文和失败后行状态与 Rust 一致；无待派修残差。
- **TESTMAP：vfs-repos pending 0 → 0、ported 158；本包新增/改变映射 0。** 按固定树表格行统计；WP162 为补充回归，无新增 Rust 测试 id。
- 未完成：本包 N1 无。M02、N2/VERIFY018、VERIFY017 保留既有签收；L18 M03、WP138 OCR、其它仓储及 library 排序沿用各自状态，本次不授予整 lane 或全 raw/A-B-C 资格。
- 本包只编辑本审计文件，旧审计及提交保留；未改实现、测试、TESTMAP、ACCEPTANCE，未跑全域/全测/ledger，未操作活 ds-fulltest、main 冻结或集成锁。
- 阻塞：N1 窄独验无阻塞。审计提交后正常 merge main，再直接运行绝对路径 lane-gate（不包父 job）；提交 tip、自检原回执和门禁子作业号随 `WP-C2-VERIFY-019.report.md` 交付，门禁不替代固定 HEAD 的测试原件。
- 供抽检：① `tests/media-transcripts.test.ts:275–303` 的 SQLite typeof、四入口首错列及失败后完整行；② `repository/media-transcripts.ts:52–72,304–321` 对照 rusqlite `row.rs:288–293` / `types/mod.rs:126–135`，以及测试 `:313–317` 正常 INTEGER→bigint。
