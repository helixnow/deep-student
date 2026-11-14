# L05-agent-workspace 独立验收（R2-review-agent，2026-11-04）

结论：不通过

审读快照：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。独立核对 Rust、契约、TS 和测试；未编译/运行 Rust，未修改实现。此快照没有既有 ACCEPTANCE。以下“通过”仅指明列抽查行为，不表示整个命令所有平台均等价。

## 必须修复

- [x] **W1：原列前缀/记录解码/精确身份/错误优先级已复核关闭。** a41769ee4/0dc99b5df已进入main运行基线eeaf5bdc7；在既有13项主分支验证基础上，只运行新增逐字段错误优先级IPC用例（八向量完整字符串/line/column），作业20261104110200-f9b05a退出0，1通过/13按筛选跳过，无Errors。旧身份/游标未重复运行；仅关闭已报告分支，不宣称自写JSON解析器全语法等价。X6具体断言边界分类见文末。
- [ ] **W2：真实共享guard已提供、L05消费与L04删除为候选，三插件链待闭合。** main 3b2758d7a 的backup/governance共用同步operations.tryAcquire；L05 531160218/ee5b57e54→31c01a2bb已绑定tryAcquireOperationGuard('delete_propagation')及按需deleteSessionV2。L04 b0ed6a135已提供真实immediate删除方法，但L05消费候选和L04方法均未入此main，测试仍替换L04端口，不能签整链。不是“永远缺guard”；责任为L05/L04正常集成与真实删除验证，详见08:21Z映射。
- [ ] **W3：Windows原生身份/沙箱尚未闭合。** identity大整数读取/写回已修，不再以“dev/ino全部转Number”描述当前实现；Node stat来源仍不能代替Windows opened-handle/reparse校验，requireWindowsSandboxRuntime仍缺原生实现。本轮只跑Linux，不签收Windows能力。候选静态证据见05:34Z节；Rust对照 `src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:2608-2635`、`tools/shell_sandbox/windows.rs:2309-2424`。
- [ ] **W4：16 pending及统计/完整复核仍未闭合。** 最新main 3b2758d7a及L05候选31c01a2bb逐行统计均为364 ported /16 pending /21 obsolete；旧26 pending已过期。剩余为L04 false/OCR两项、outbox九项、Windows五项。21项批准与loader已解决；不重复申请，也不因10项resolver状态变化签整个B。
- [x] **W5：完整64-bit usize cursor及分页已复核修复。** 0f6b51ed1/4c990bf9b已进入基线 `1297ac576`；生产IPC经BigInt解析、目录耗尽早返、nextCursor饱和，亲跑覆盖2^53/2^53+1/u64::MAX/前缀零、非法边界及实际limit=1续页。作业 `20261104064353-8d5d9f` 退出0。Rust对照 `runtime_roots.rs:1716-1726,1771-1781,1797-1801`；饱和边界为静态核对，不冒充巨目录动态覆盖。

## 04:40Z 审批来源补证（仅 W4 子项）

已读取 `git show ds-mig/C1-app:migration/approvals.d/C1-app.json`（退出0），并以该文件最后修改提交 `100098a7d30ca65a839409517643971ef5e43e11` 固定证据。该分片有42条 obsolete，逐ID比对本 lane TESTMAP 的21条 obsolete，**21/21 全命中**。这补齐了上轮只有协调者指令、没有可引用分片提交的来源缺口；W4 的机器消费、pending、表头同步仍未闭合，不勾整项、不再申请同一批准。本轮未运行 ledger，退出码不适用。L05 `bf1620ea0` 及先前 receiver/checkpoint 修复按协调者说明属于附加集成缺陷，本轮未据其关闭 W1/W2/W3/W5。

## 05:34Z 交付定向复核：W1 / W5 / receiver

候选快照 `55f709989`（实现映射见该提交 `BLOCKERS.md:62-68`），本轮只读 `git show` 实现与测试；没有采用其中 Node/Electron 37文件413通过/21跳过的实现者自述作为自身运行结果。运行基线仍是 `31b3d26af`；核对 main=`8d161c00d417b76f7c42a8739157a4ac6ac5083d`，候选及 `8aeccc36b`、`0f6b51ed1`、`bf1620ea0` 均非该 main 的祖先（各检查退出1），按指令只记录静态子项，不摘取实现、不重跑旧 suite。

以下 TS 行号统一指 `55f709989:host/plugins/agent-workspace/`，Rust 路径根为 `src-tauri/crates/dstu-agent/src/chat_v2/`。

| 编号/子项 | 修复提交 | 真实生产入口、实现及测试证据 | 定向结论 |
|---|---|---|---|
| W1 固定错误上下文 | e6d8cce50、04b3b0db0 | `index.ts:125-132` reset 与现有 guard→CommandError；`src/runtime-roots.ts:145-169,243-268,474-506,516-523,594-600` 分别补读/解析/序列化/保存/撤销/preview前缀。`tests/runtime-root-errors.test.ts:15-47,86-108,111-132` 经 host.invoke 比对完整拒绝字符串，并使用真实文件读路径仅注入底层EIO。对照 Rust `runtime_roots.rs:639-664,973-994,1617-1652,1860-1865,2573` | 固定前缀修复静态符合；不是仅 toThrow 或替身算法。完整 serde 等价仍有下述剩余差异，W1不关闭 |
| W1 字段顺序/精确身份 | 8aeccc36b（及此前记录解码实现） | `src/runtime-root-records.ts:136-159,167-187,208-215` 按Rust声明顺序重建字段及kind/device/inode；`:174-179` 从原数字token用BigInt解码，`:5-7` rawJSON无引号写回。`src/runtime-roots.ts:108-123` 从BigInt stat提取identity，大于safe整数不转Number；`:104-105,391-420` 使用精确编码比较/摘要。`tests/runtime-root-errors.test.ts:78-83` 验证2^53+1/u64::MAX读写原数字，`:99-104` 经IPC验证identity键反序仍configured=true。对照Rust `runtime_roots.rs:148-200,611-635` | 顺序归一与高位整数链路静态符合D3；JSON.parse暂存的number不参与u64最终解码。未实际运行大inode平台，不代表Windows原生来源W3通过 |
| W5 64-bit cursor与分页 | 0f6b51ed1、4c990bf9b | `index.ts:149-154` normalize→parse→root→分页；`src/runtime-paths.ts:182-220` 原字符串完整匹配，不trim，BigInt解析至u64::MAX；迭代器耗尽立即返回空页，next offset按u64::MAX饱和后转十进制字符串。`tests/runtime-directory-cursor.test.ts:6-27` 经真实IPC覆盖2^53、2^53+1、usize::MAX、+前缀/前导零、越界/负数/尾换行拒绝，以及limit=1的nextCursor/scanned/truncated | 静态符合Rust `runtime_roots.rs:1713-1726,1771-1781,1795-1809`；近上界加法饱和为源码证据，现有空目录末尾测试不冒充该分支动态验证。未集成运行，W5不勾 |
| 附加 receiver/checkpoint | 6c25d23f3、bf1620ea0 | `index.ts:78-89` 注入真实F3 openFile/close；`src/workspace/coordinator.ts:72-89` 每次借用后 `method_.apply(target,args)` 保留SqlExecutor接收者；`src/workspace/database.ts:176-192` 先取得连接再置maintenance，checkpoint→close→清句柄，失败恢复flag并传播。`tests/workspace-storage-wiring.test.ts:4-28` 真迁移/建工作区/注册agent/发消息→维护拒绝→重开保留数据→drain/pending清零→重复close。`tests/host-support.ts:10-17` storage为真实F3，settings仅为测试存储 | receiver丢失与checkpoint自我拒绝两项静态修复，测试不止维护路径的toThrow；未亲跑。不连带关闭W2/W3；Rust pool的活动连接等待语义未由此单测试全面验证（Rust `workspace/database.rs:338-397`） |

**W1 尚有 serde 错误优先级差异：** `src/runtime-root-records.ts:63-98,218-229` 先完整 `reader.read()` 构造所有字段，再由 `record` 校验，Rust `runtime_roots.rs:173-180,648` 则直接从JSON流反序列化带类型字段。输入 `{"path":null,"label":`：TS在读尾部时报 `EOF while parsing a value`；Rust在消费path字段时已因null不是PathBuf而拒绝（`invalid type: null, expected path string`），不应读到label才选错误。已有 `tests/runtime-root-errors.test.ts:59-68` 只测语法完整的单一字段错误，不能证明这种先后顺序。此为当前W1错误映射范围内的静态未决项，未运行Rust或声称有录制结果；不能将自写记录parser整体签为serde严格等价。

**公开API仅证实分支提供：** `api.ts:9,13,136-139` 的guard/root/manager/event导出确实存在；`tests/public-api-wiring.test.ts:11-39` 经真实F3任务/sleep及kernel事件断言关闭后receiver收到cancelled，`:42-60` 检查授权、撤销和白名单。符合quality§10的生产主体要求，但分支可用不等于main消费，本轮不扩为调用方验收。

**W4最新子项状态（覆盖此前“loader未接入”的历史描述）：** 固定main `8d161c00d` 的 `scripts/electron-migration/ledger.mjs:193-202` 已合并读取 approvals.d；其C1分片与候选TESTMAP的21个obsolete ID逐一匹配21/21。候选实际354 ported / 26 pending / 21 obsolete；26 pending仍在，表头亦未同步。因此审批来源与loader接入子项已静态确认进入main，W4整项不勾；不把旧R2运行基线的ledger结果当作main loader失败。

**运行证据与范围：** 本轮候选Vitest/Electron runner均 **NOT RUN**，无退出码、无Errors输出可引用；不能写“无Errors”。重启恢复按用户要求在旧R2基线执行 `npm run migration:ledger -- --check --no-write`，退出1：`commands 1058 (A 91.5% B 7.7% C 0%), tests 8036 (A 75.7% B 0.4%); problems: commands 0, tests 21, orphan registrations 0`，这是全仓旧基线统计，非候选测试。集成后定向运行 runtime-root-errors、runtime-directory-cursor、workspace-storage-wiring、public-api-wiring 四个测试文件，保留完整退出码及Errors；不重复三lane全量。W2仍需D2的共享backup许可及L04删除服务，W3 Windows未验证；所有验收勾选保持不变。

## 建议

- [ ] 把 settings 读/写失败的注入验证放在真实命令入口，断言完整字符串；成功 round trip 不会发现 W1。
- [ ] 接线验收应区分“服务已发布”和“执行器/dispatcher 真正消费”；现有静态 wiring 结果只证明有限的 import 可达性。

## 已核实通过

- [x] **复核确认**：12 条 IPC 均有注册，契约命令数亦为 12；`index.ts:50-55,102-187` 对应 `contracts/ipc/L05-agent-workspace.json:4` 的 commands。此 lane 不存在 15 条 IPC 命令，因此全部检查 12 条，另补 3 个服务操作，未将服务冒充 `#[tauri::command]`。
- [x] **复核确认**：审批模块的 15 个 ported 原测试行为保留，真实调用 `ApprovalManager`；`index.ts:23,74` 发布该实例，见下表。
- [x] **复核确认**：服务名 lowerCamelCase、meta/provide 对齐；跨插件导入经 api.ts。`index.ts:27-33,49,68-92`。所查 repository 写 workspace/agent/message/inbox/subagent_task、workspace_index、completion_outbox 等本领域表，VFS resolver 为读取；未发现直接写其他业务插件表。
- [x] **复核确认**：Linux 测试、原生导入、静态 wiring 通过；strict 检查未报告未豁免违规。没有发现生产 `console.*` 或生产引入测试模块。严格检查的 15 条豁免均在本 lane，不能把“0 violation”解读为“0 catch”；抽查 `coordinator.ts:172` 对应 Rust `coordinator.rs:244-248` 的 `let _`，允许忽略并非丢失 warn。

## 命令/服务逐项审读

简称：R=`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs`；I=`host/plugins/agent-workspace/index.ts`；T=`host/plugins/agent-workspace/src/runtime-roots.ts`；P=`host/plugins/agent-workspace/src/runtime-paths.ts`。

| # | 命令（完整名称）/服务 | 结论与核对行为 | TS / Rust 证据 |
|---|---|---|---|
| 1 | chat_v2_authorize_runtime_root | 问题 W1；canonicalize→identity→同 path/identity 幂等→排序→保存顺序一致 | I:130-133、T:271-294 / R:1872-1881、973-994 |
| 2 | chat_v2_delete_artifact | 通过所查 Linux 路径：空相对路径先拒绝、root 不存在报原文、禁止目录、结果 snake_case | I:102-109、P:210-221 / R:1966-1986 |
| 3 | chat_v2_list_runtime_directory | 问题 W5；常规输入先 normalize、parse cursor，再查 root；默认 40，clamp 1..100，scan 1000，目录优先排序、size null 一致 | I:146-152、P:182-207 / R:1698-1810 |
| 4 | chat_v2_list_runtime_roots | 问题 W1；缺省/null/空白 session 为 session-preview，workspace→authorized→artifacts→temp 顺序一致 | I:99-100,111、T:364-370 / R:1660-1684 |
| 5 | chat_v2_read_runtime_file | 问题 W3；先解析目标，默认 64KiB、clamp 1..1MiB、多读 1 byte 判 truncated、lossy UTF-8 一致；readSync 失败也缺 `Failed to read file:` 前缀（纳入 W1 错误映射修复范围） | I:154-155、T:552-596 / R:2552-2583 |
| 6 | chat_v2_reset_workspace_root | 问题 W1；删除后重列 roots 一致，但 `Failed to reset workspace runtime root:` 丢失 | I:125-127 / R:1855-1868 |
| 7 | chat_v2_resolve_runtime_path | 通过所查分支：相对路径校验在 root 解析前、存在性和 canonical 包含关系校验、返回字符串 | I:143-144、T:532-549 / R:1910-1957 |
| 8 | chat_v2_revert_artifact_write | 通过所查分支：先校验 expected hash，再 relative/root；空 backupRef 删除、非空恢复，deleted 模式省略 bytes_restored | I:157-171 / R:2455-2503 |
| 9 | chat_v2_revert_workspace_change | 通过所查编排：解码 receipt→workspace 归属→configured→read_write→revalidate→rollback，输出 receipt | I:174-183 / R:2511-2540；底层所有文件系统故障文案未穷举 |
| 10 | chat_v2_revoke_runtime_root | 问题 W1；未找到 ID 报原文、保留其余记录后重列 roots 一致 | I:135-140、T:233-251 / R:1885-1901 |
| 11 | chat_v2_set_skill_trust | 问题 W1/W3；ID 校验先于 trusted 分支，revoke 的 package_sha256=null，grant 必须 package root、重算摘要、chrono 时间一致 | I:186-187、T:445-482 / R:1602-1657 |
| 12 | chat_v2_set_workspace_root | 问题 W1/W3；默认 read_only、拒绝 critical write、label trim/目录名回退、保存后列 roots 一致 | I:113-122、T:59-66,182-185 / R:1814-1851 |
| 13 | agentWorkspace.closeWorkspace（服务） | 通过：先取消 sleep，再 completed、移除缓存、更新 index、发关闭事件；两条失败传播分支保留 | host/plugins/agent-workspace/src/workspace/coordinator.ts:155-182 / src-tauri/crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:229-263 |
| 14 | agentWorkspace.deleteWorkspace（服务） | 问题 W2：生产缺守卫/删除回调 | 同上 TS:185-203 / Rust:266-292 |
| 15 | agentWorkspace.registerAgent（服务） | 通过：只计 idle/queued/running/interrupted，满额原错误，保存后发 joined | 同上 TS:206-232 / Rust:297-334 |

同步无 await 的设置/文件临界区对应 Rust mutex；未增加异步交错。时间使用平台 chrono；文件大小及身份仍有 Number 精度限制（T:69-71,118-121），不据此签署全域整数等价。

## ported 测试真实性：15 条

下表 TS 路径统一为 `host/plugins/agent-workspace/tests/approval-manager.test.ts`；Rust 为 `src-tauri/crates/dstu-agent/src/chat_v2/approval_manager.rs`；映射在 `TESTMAP.md:75-89`。各项均通过、复核确认，且不是只断言替身。

| 原测试名 | 同一行为断言 | TS 行 / Rust 行 |
|---|---|---|
| media_transcription_approval_names_external_provider_and_file | 文件名、SiliconFlow、artifact 三词 | 9 / 1278 |
| test_approval_flow | respond 成功且 waiter 收到 approved | 18 / 1295 |
| dstu_purge_user_rejection_is_delivered_and_never_remembered | 拒绝理由、pending 清零、两种记忆都为空 | 27 / 1320 |
| test_approval_timeout | cancel 后迟到响应失败；Rust 本来也模拟取消，非真实 timer | 59 / 1361 |
| test_remembered_choices | 精确 scope 命中、另一路径不命中、clear 生效 | 70 / 1385 |
| reject_all_pending_drains_all_waiters_with_rejection | 两 waiter 都收到拒绝及身份字段，晚响应失败、重复 drain=0 | 86 / 1427 |
| cancel_without_session_refuses_ambiguous_cross_session_match | 双会话重名拒绝宽取消，单剩一个可取消 | 117 / 1477 |
| cancel_delivers_explicit_cancellation_decision_to_waiter | 明确 CANCELLED_REASON、身份字段、重复取消 false | 133 / 1504 |
| cancel_with_session_delivers_cancellation_decision | 精确取消唤醒 waiter、pending=0 | 149 / 1530 |
| medium_readonly_shell_can_be_session_remembered_with_precise_scope | 同命令允许，换 cwd/高敏命令重新审批 | 160 / 1550 |
| remembered_shell_approval_cannot_change_operand_payload_or_environment | 六种 operand/env/timeout/track 改变均不命中 | 185 / 1604 |
| remembered_wrapper_approval_cannot_swap_inner_command | wrapper 内命令替换四向量不记忆 | 230 / 1696 |
| arbitrary_runner_and_path_executable_cannot_be_remembered | Python/相对可执行文件、settingKey=null、waiter 标志被清除 | 253 / 1743 |
| session_remember_for_regular_tools_keeps_tool_level_semantics | 普通工具仍按 tool 级 session 记忆 | 273 / 1782 |
| response_tool_name_cannot_poison_shell_session_or_setting_scope | 伪造 toolName 被纠正，不污染其他工具记忆 | 288 / 1807 |

## 亲自运行：原始输出摘要

环境 Linux，Node v26.5.0。所有命令从本独立 worktree 执行，退出码均 0（全仓 ledger 另见汇总）。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 Test Files  33 passed (33)
      Tests  396 passed | 21 skipped (417)
   Start at  11:35:02
   Duration  13.43s

$ node scripts/electron-migration/wiring.mjs --lane agent-workspace
合计 ported 354，其中所测模块未从 index.ts 接入 0（0.0%）

$ node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts host/plugins/agent-orchestration/index.ts host/plugins/chat-pipeline/index.ts
importable: ok
(node:74395) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/agent-workspace host/plugins/agent-orchestration host/plugins/chat-pipeline
boundaries: scanned 264 files, 0 violation(s), 15 suppressed via boundary-allow
```

21 skipped 是本机平台覆盖限制，不等于 obsolete 批准，也不计为通过；354 为 TESTMAP 原测试映射数，与 417 个 TS 用例非一对一。

## 语义差异分类

**缺陷/未完成（应修）**：W1 错误前缀及解码差异（含 read preview 失败前缀）、W2 删除缺接线、W3 Windows 能力/身份精度缺口、W4 测试与批准未闭合、W5 cursor 范围收窄。

**已登记但未获等价豁免**：`SPEC.md:17` 的 Number 精度限制、`:50-56` 的删除服务缺口、`:38-41` 的 Windows pending；登记不使 B 成立。**已接受平台差异**：`docs/dev/electron-migration/decisions.md:34-35` 限定常见 errno 之外的 IO 诊断细节；它不批准删除 W1 的固定业务前缀。同步单线程替代这些无 await 临界区不构成已发现缺陷。

## 最新集成实跑：基线1297ac576（覆盖此前不可运行状态）

已合并main得到 `1297ac576df147d46949f3f72e85f8c91eb6a68d`（main `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`），包含L05 55f709989及receiver/checkpoint修复。通过全局队列提交既定四文件最小验证：

```text
job 20261104064353-8d5d9f
command: npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/runtime-root-errors.test.ts host/plugins/agent-workspace/tests/runtime-directory-cursor.test.ts host/plugins/agent-workspace/tests/workspace-storage-wiring.test.ts host/plugins/agent-workspace/tests/public-api-wiring.test.ts
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 ✓ runtime-root-errors.test.ts (13 tests)
 ✓ runtime-directory-cursor.test.ts (1 test)
 ✓ workspace-storage-wiring.test.ts (1 test)
 ✓ public-api-wiring.test.ts (2 tests)
 Test Files  4 passed (4)
      Tests  17 passed (17)
   Start at  14:43:55
   Duration  17.07s
[作业 20261104064353-8d5d9f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064353-8d5d9f.log
```

已读取job result完整输出，无Errors报告行/未捕获异常。W5关闭；附加receiver/checkpoint已由真实F3创建→消息→维护拒绝→重开→drain→重复关闭验证通过，公开manager/event/guard接口也经真实实例验证。W1只关闭前缀/主分支子项，完整错误优先级仍未修；W2删除接缝、W3 Windows/native、W4剩余pending不连带关闭。Node/Linux结果不代表Electron或Windows/macOS；本轮未运行这些平台，未重跑L03已关闭项。

## 07:19Z W1错误优先级新候选（仅新增修复）

候选 `a41769ee4` / `0dc99b5df`；运行HEAD=`4c0057f7c`，固定main核对点=`679fd3e4d3bdaff9d38188aab851704e952b9ac0`，两提交祖先检查均退出1。没有切分支/摘实现或在旧基线上重复测试。

- **真实入口未变**：runtime-root IPC → loadWorkspaceRecord/loadAuthorizedRecords → `src/runtime-root-records.ts`。下列行号属 `0dc99b5df`。
- **所报错误优先级静态修复**：`RecordReader.read(visitor)` 在`:88-93`读取每个键/项时调用visitor；`readRecord:144-161`立即执行该字段decode，完成后才让reader请求下一个字段。字符串字段在`:237-240`的container回调甚至不读取错误map/seq的内部。decodeWorkspaceRootRecord与authorized数组入口在`:250-268`都经过该路径，而非另造测试专用解析。
- 对原输入 `{"path":null,"label":`，`:147-148`在path值读完即调用string校验并抛path string错误，尚未读取label，符合原Rust `runtime_roots.rs:173-180,648`的类型解码顺序。重复字段在键读到后即拒绝，authorized数组每项在进入下一项前完成record校验；这些是针对本次已报告分支的判断，不泛称整个自写JSON语法与serde全部等价。
- **新断言真实**：`tests/runtime-root-errors.test.ts:111-135` 经settings保存原输入后调用真实 `host.invoke('chat_v2_list_runtime_roots')`，严格比对八组完整字符串及line/column：path null、label boolean、path map、重复path、结构体序列null、authorized id类型、authorized缺字段，以及前字段合法时真正的后续EOF。未stub被测decoder。
- 提供方报告 `20261104063608-7cba5d`（Node14）及 `20261104063810-b3f324`（Electron47+1skip）退出0仅为协调者转述来源，**不是本审读者运行证据**；本轮runner NOT RUN，无独立job/result退出码或Errors输出。

静态子项确认，W1保持未勾选至集成后亲跑。后续仅经队列执行 `npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/runtime-root-errors.test.ts -t 'R2-W1 typed field errors precede later truncated JSON at the IPC boundary'`，不重复身份/游标全套。新增Linux隔离不计作Windows W3证据，本轮未扩审沙箱policy。

## 08:21Z W2最新链路映射（限量静态补证）

固定main=`3b2758d7ac8e69263377ab7356206c94af9d8a24`；L05最新候选=`31c01a2bb`（接线代码531160218/ee5b57e54，e540fbb61/127cfcb25记录）。L05候选与L04 b0ed6a135均非该main祖先，退出1，本轮不在旧运行树重复测试。

1. **guard是正式同一提供方**：main的 `host/plugins/backup/index.ts:55,86-89` 均委托同一operations.tryAcquire，`api.ts:203`发布governance.tryAcquireOperationGuard。L05候选 `index.ts:95-107` 每次从ctx取真实governance，调用同步 `'delete_propagation'`，错误保留message；没有另建锁或等待型acquire。`src/workspace/coordinator.ts:185-203` 先guard，再close/DB/index/worker清理，finally.release。对应Rust `src-tauri/crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:266-294`。
2. **真实L04方法有候选，整链尚未验证**：`b0ed6a135:host/plugins/chat/src/service.ts:90` 的deleteSessionV2在immediate事务内调用deleteSessionHard；L05 `index.ts:104-107` 按需调用此方法，`coordinator.ts:679-707` 先清runtime roots再删worker，单worker失败继续聚合。对应Rust `coordinator.rs:913-950`。候选 `tests/workspace-delete-wiring.test.ts:7,12-22,41-90` 确实安装真实L21+F3并覆盖busy/持锁清理/finally释放，但**L04 deleteSessionV2仍是注入回调**，不能据此签真实会话行删除。

**剩余owner/精确验收场景**：L05与L04合入后安装真实L21/L05/L04，预建coordinator及两个worker会话/roots；持backup许可调用deleteWorkspace应立即失败，workspace/sleep/roots保持不变；释放后删除应仅清worker会话及roots，删除失败聚合且许可必释放，coordinator会话保留。不要把“回调收到了worker ID”当作真实chat库级联清理证明。原Rust路径分别为上列266-294和913-950。本轮不新增测试job，也不继承提供方workspace-delete-wiring的通过结果；W2仍开放，W1/W5/receiver已核证据不重做。

## v2复验与X6具体解码边界判定（基线eeaf5bdc7）

```text
job 20261104110200-f9b05a
command: npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/runtime-root-errors.test.ts -t 'R2-W1 typed field errors precede later truncated JSON at the IPC boundary'
Test Files 1 passed (1)
Tests 1 passed | 13 skipped (14)
Duration 7.75s
[作业 20261104110200-f9b05a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110200-f9b05a.log
```

已读完整result，无Errors报告。13 skipped是-t筛选，不是平台能力豁免。W1关闭；W2真实L04删除链、W3Windows、W4剩余pending不连带关闭。L05给出的W2 Node/Electron3通过仅为提供方回调替身证据，未转录为本审读者三插件整链结果。

**X6窄范围可分类（不是整个文件skip）：**

- `src/runtime-root-records.ts:39` 的 `JSON.parse(this.text.slice(start,this.offset)) as string` 输入不是未校验业务对象：本方法仅在已读到引号时进入（:35-39），扫描到闭合引号、验证控制字符/escape/UTF16配对（:40-63），JSON.parse只解一个字符串token。可将**该表达式**分类为decoder内部token解码，不按“持久业务JSON直接as T”阻断。不得据此豁免上层字段校验或整个parser。
- `:255/:266/:276` 的返回断言在schema/record校验之后：字段清单:237-247、逐字段read/decode:144-161、record必填/重复/default/顺序:165-188、identity标签和u32/u64检查:196-216；返回前finish检查尾随输入。三处cast本身未绕过这些检查，可各自分类为**已验证解码器结果类型收窄**。对本次已报path/label/id字段、非数组、identity大数已有生产路径测试和源码证据。
- **边界限制**：扫描器的窄例外只说明这些cast的位置/用途，不代表所有入站token已逐向量覆盖。unknown字段、内部tagged identity内容缓冲及access枚举map仍由自写reader负责；发现新可达语义差异须在其真实解码分支报告，不用删除cast或全文件allow隐藏。没有批准 `JSON.parse(raw) as WorkspaceRootRecord` 这种旧绕过方式，也没有修改X6配置/任何测试。

请协调者将上述四个具体表达式/return位置交X6分类，按符号与验证调用链限定，文件变更需复核调用链仍存在；不要求为门禁换写法规避检测。
