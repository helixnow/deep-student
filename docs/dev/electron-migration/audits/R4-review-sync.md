# R4-review-sync 独立交叉审读汇总

日期：2026-11-04。验收人：R4-review-sync（独立上下文）。

结论：**三个 lane 均不通过，B 级均不成立。** 测试可运行、入口可导入及 wiring 通过，不足以证明命令等价、测试真实性或真实消费链完整。

**越界验收文件处置（2026-11-05）**：`host/plugins/sync/ACCEPTANCE.md` 不在 R4 的 `scripts/electron-migration/lib/lane-paths.mjs` 允许路径中；R4 无权修改全局白名单，经用户 2026-11-05 明确授权，已将原文件相对 main 的全部 R4 自有内容无损迁入本文末节「原 `host/plugins/sync/ACCEPTANCE.md` 全文无损迁入」，并仅撤销本 lane 自己新增的这条越界 diff。原 blob SHA、提交链、21 个作业号、原 exit 与未决均保留在末节；未改 main 原内容、他人改动、白名单或门禁脚本。

**定向复核更新（2026-11-04，L20b）**：固定审读并测试 `7f8b92ed7`。S03/S05 均为**部分修复**，S02/S06 仅确认撤回虚假 ported；S01/S04 保持未关闭。最小集4文件25例通过，但另有 S03 JSON 文本大整数反例，六个 S 组仍有未决项。L20b 为 **28 ported / 12 pending**，详见其 ACCEPTANCE §5；本次续审未重复该25例。

**后续更新（2026-11-04，L23）**：固定 `c7c15e5b5` 审查指定修复，亲跑53例及S3原失败lookup一例通过。**P01/P02/P05 关闭，另六组仍未决**；actual TESTMAP 为235 ported/624 pending，20条Docker未运行。P03 与真实L21候选 `46bb99a298` 组合探针复现小写kind→prune、持锁invoke→HandlerPanic；缺ID/release的guard仍可下载成功。身份优先级及manifest serde也有反例。详见末节及L23 ACCEPTANCE §5；不采信 main 中实现者自验全勾或自报B14。

**授权合并更新（2026-11-04）**：已合并固定main `e303957124`，唯一冲突为允许路径 `host/plugins/sync-providers/ACCEPTANCE.md`，保留独立P组/新子项。按D1/D4撤回“仅因公开SqlExecutor参数”产生的建议，S04/B05仍按实际写表方与同事务判断；D2/D3和quality §10不豁免P03守卫或S03存储JSON反例。合并类型检查exit=0，相关命令入口15例通过且exit=0；未重复原54/25例全套。六个P组、六个S组、11个B组的未决计数不变。

**最新候选补审（2026-11-04，L23 P03/P08）**：L23固定 `1da6dadc5`、真实L21固定 `e4dd1772f`、可见性main固定 `15b23540a`。队列作业29例通过；真实同kernel组合另证实许可释放有效，但busy/IO得到 `must be object` IPC契约错误，kind再次不兼容，未知TypeError被L23转换为Unknown。P08候选统计242 ported/615 pending/2 merged已同步，但merged目标未证明原子进程/隔离保证、移动profile新ported未保留原断言；“merged缺批准”理由已按C2纠正撤回。P03/P08不关闭；main仍无L21新方法，不把候选结果当main集成。完整作业号与退出码见末节。

**L21 B组定向更新**：固定e4dd树新增审查B01/B02/B03/B08/B09，队列最小集19例通过。**B01、B08在候选树签收关闭**；真实F3正常屏障写阻断已证，但已有维护态借用/Drop重试仍缺；FK违规被未结束iterator的close忙错误覆盖；备份等待锁时不能及时取消。B02/B03/B09仅部分修复。B05/B06继续未关、B04/B10/B11完整修复未在本轮逐组签收。main可见性固定f67db2080仍无新guard方法。当前未决组数 **L23=6、L20b=6、L21=9，共21**；原失败输出均保留。

**规则纠正与新候选增量**：merged无需单独审批，“缺批准”已于4014c45be撤回，保留原子进程/隔离及profile/FTP的行为反证。继续B组检查固定L21 19c023cd6 + L23 cb9d683d0：提供方新结构化忙锁/IO用例通过，选择最小集11passed/exit0；真实Node组合在L23参数属性处导入失败，作业exit1，尚未执行真实guard调用。此加载阻塞归P09；不把e4dd旧wire反例说成19c当前行为，也不把单测绿说成新pair已接通。main f37426009仍无新guard接口。

**P06正式消费更新**：接到F4交付后发现L23已有新消费提交da290fd2e，已删除本地optional/env/WeakMap桥。固定da290 + F4 679b53948，安装真实两插件、复用env/primary/legacy及生产日志探针，5场景断言通过，作业20261104072250-8b8a5a exit0。**P06在候选组合签收**，不是仅因API发布勾选；main679fd3e4d仍无该API。da290入口原生导入成功也修复了cb9语法阻塞子项，P09整体未重签。当前未决 **L23=5、L20b=6、L21=9，共20组**。

**正式许可基线d5cd234aa / L23 624cfe251最新签收**：L21结构化错误已正式进入协调者指定main，624候选包含该main、删除镜像并直接消费所有者API；真实持锁/IO及加密上传释放有证据。**新增关闭P03消费侧、P07、P09**；P08原子进程/profile/FTP反证已修且实跑，账本仍未闭合。P04旧token/u64解码/Z问题已修，但未知字段/必填判定、错误位置和内部Number仍有反证。最新未决 **L23=2（P04/P08）、L20b=6、L21=9，共17组**，三lane仍不通过。作业775a11末段的错误取消预期exit1完整保留，不伪装全绿。

## 审读范围与基线

- 工作树/分支：`/home/dsdev/dev/ds-mig/R4-review-sync` / `ds-mig/R4-review-sync`。
- 被审实现基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。中断恢复后按指令执行 `git log --oneline -20`、`git status`，确认该基线和 clean 工作树；未重做已完成检查。
- 依据：`contracts/ipc/L23-sync-providers.json`、`L20-sync.json`、`L21-backup-governance.json`，只读 Rust 源码、TS 生产代码、实际 TESTMAP 行、亲自运行结果；质量要求见 `README.md:164-196`、`quality.md`、`docs/plugins/ARCHITECTURE.md`。
- 只写三个 ACCEPTANCE 和本汇总。未修改实现、测试、SPEC、TESTMAP、契约；未编译或运行 Rust。运行使用测试临时目录/内存库，没有生产数据操作。
- 覆盖：L23 全部 **14 条命令**及 createStorage 服务（契约没有第 15 条）；L20b **0 条命令**，改查 **19 个公开服务方法**；L21 抽查 **17 条命令**并追踪完整备份后台主链。逐项证据在对应 ACCEPTANCE。
- ported 测试逐条交叉阅读 **22 / 25 / 24 条，共 71 条**。此为抽查，不将未审读部分宣称为严格等价。

## 汇总与派回

问题数按 ACCEPTANCE 中未勾选的“必须修复”编号组计数，同组可含同根因的多个分支；跨lane共性分别记到责任lane。首次26组，依次关闭P01/P02/P05、B01/B08、P06、P03/P07/P09后为17组；不表示17个互不相关根因，也不意味着所有候选均已集成main。

| lane | 结论 | 必须修复组数 | 最严重的 3 项 | 详细结论 |
|---|---|---:|---|---|
| L23-sync-providers | 不通过 | 2 | P04未知字段影响必填/误拒未知重复键、错误位置和内部精度未等价；P08剩余账本/未执行项 | [ACCEPTANCE](../../../../host/plugins/sync-providers/ACCEPTANCE.md) |
| L20b-sync-support | 不通过 | 6 | S01 服务无真实 L20 消费链、notes.blocks 缺失；S02 六条真实 apply 集成仍缺（虚假 ported 已撤回）；S03 JSON 文本比较仍丢大整数精度 | [ACCEPTANCE](../../../../host/plugins/sync-support/ACCEPTANCE.md) |
| L21-backup-governance | 不通过 | 9 | B02已有维护态/Drop收尾缺失；B03锁错误契约/等待取消/进程锁等价未闭合；B09未结束FK迭代器掩盖错误 | [ACCEPTANCE](../../../../host/plugins/backup/ACCEPTANCE.md) |
| 合计 | B 均不成立 | **17** | 逐组派回原 lane，跨服务问题联合修复 | |

> 链接以仓库相对路径为准：`host/plugins/{sync-providers,sync-support,backup}/ACCEPTANCE.md`。

### L23 必须修复与已关闭项（624cfe251）

- P01/P02/P03/P05/P06/P07/P09 已独立确认相应修复；历史反例限各固定旧SHA，最新勾选见ACCEPTANCE。
- P04：解码/encode保真和UTC Z等已修；未知extension重复键误拒、未知原型字段使缺version仍被接受、错误文案/位置及内部Number转换未闭合。
- P08：240ported/618pending/0merged/1obsolete；子进程/退出状态/隔离环境/profile/FTP原断言已补并实跑。身份集成在未装F4 API的裸树仍门控pending，Docker20未运行；不因部分用例通过关闭全部账本。

### L20b 其余必须修复

- S04：直接写 notes/VFS 表，与 L20/表所有者重复实现。
- S05：BEGIN/COMMIT/列解析已修；prepare/bind-query/step 阶段错误上下文仍未闭合。
- S06：writer 用例已退 pending；仍只有固定延时，未确认 contender 已进入锁争用点。

### L21 其余必须修复（未逐组复核项保留历史证据）

- B04：includeAssets=true 完整备份要求可被降级为 partial 成功；无效 assetTypes 默认分支不同。
- B05：直接写 sync_state/VFS 恢复表，绕过已发布/应发布的所有者服务。
- B06：ported 测试内重写被测实现；feature-off 测试反转预期；ZIP 错误断言弱化。
- B07：e4dd实查306ported/17pending；首次两次RPC Errors=1/exit1保留，owner报告新全套358passed未由本轮19例替代验证。
- B01/B08：在e4dd候选签收关闭；真实命令字符串出口、锁内选择/审计已有独立运行证据。
- B09：readonly已修；实际FK违规被close忙错误掩盖、准备/读取阶段映射不完整。
- B10：坏 manifest/命令失败/取消/迁移/任务状态转换等 warn/error 丢失。
- B11：命令校验顺序、缺备份文案、目录类型/路径解析与错误前缀差异。

## 亲自运行的证据

所有命令从上述独立工作树执行。本节保留首次基线的全套结果，定向复核结果见后文；不能把历史DNS失败或旧TESTMAP统计当作新提交现状。运行摘要原文另附于各 ACCEPTANCE。

| 检查 | sync-providers | sync-support | backup |
|---|---|---|---|
| `npx vitest run -c vitest.host.config.ts host/plugins/<dir>` | 27 文件：26 passed/1 failed；304 测试：303 passed/1 failed；26.80s；exit 1 | 8 文件、67 测试 passed；4.19s；exit 0 | 19 文件、333 测试 passed；1 unhandled error；365.92s；exit 1 |
| `node scripts/electron-migration/importable.mjs host/plugins/<dir>/index.ts` | `importable: ok` | `importable: ok` | `importable: ok` |
| `node scripts/electron-migration/wiring.mjs --lane <dir>` | ported 206，未接入 0 | ported 35，未接入 0 | ported 308，未接入 0 |
| 实际 TESTMAP 行数 | 206 ported / 653 pending | 35 ported / 5 pending | 308 ported / 15 pending |

L23 实际失败：

```text
CommandError: S3 上传失败: ENOTFOUND: getaddrinfo ENOTFOUND test-bucket.localhost
 ❯ S3Storage.put host/plugins/sync-providers/src/s3.ts:627:13
 ❯ host/plugins/sync-providers/tests/s3.test.ts:364:7
```

这是 Linux 测试域名解析依赖，不能据此声称 S3 网络实现错误；同时不能签成全绿。

L21 为区分并发争用，仅补跑一次 `npx vitest run -c vitest.host.config.ts host/plugins/backup --maxWorkers=1`，仍然：

```text
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 Test Files  19 passed (19)
      Tests  333 passed (333)
     Errors  1 error
   Duration  289.69s
exit=1
```

未定位到 RPC 超时根因，不将其归因为业务算法；保留为运行门禁未闭合。

日志位置：`/tmp/opencode/R4-sync-providers-vitest.log`、`R4-sync-support-vitest.log`、`R4-backup-vitest.log`、`R4-backup-vitest-single.log`（后三者同目录）。摘要已经入库，不依赖临时日志永久存在。

中断恢复后还按用户要求运行：

```text
$ npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
exit=1
```

这是全仓结果，不把 250 条全归给本次三个 lane，也不以账本自动 A 状态推翻源码反证。三张 TESTMAP 无 obsolete/merged 行；`migration/approvals.json` 未批准本次发现的测试替代/预期反转。

### 额外定向探针

没有添加或修改测试。使用 Node 原生 TS 导入生产模块与临时 TestHost/内存 Connection，证实下列可观察结果：

```text
createStorage missing config: CloudStorageConfigError null 缺少 WebDAV 配置
unit-map HTTP config accepted: WebDavStorage
decodeManifest accepted: {"versions":[]}
decodeManifest accepted: {"version":1,"versions":[{"id":"a","checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":-1,"timestamp":"invalid","deviceId":"d"}],"latest":"a","updatedAt":"bad"}
nanosecond merge latest= z updatedAt= 2026-11-04T00:00:00.123000001Z
state cursor input= 9007199254740993 readback= 9007199254740992
data_governance_run_backup HandlerPanic command "data_governance_run_backup" panicked (in production the frontend promise would never settle): Incremental backup has been removed; use full backup or cloud sync
data_governance_get_audit_logs HandlerPanic command "data_governance_get_audit_logs" panicked (in production the frontend promise would never settle): 无效的状态过滤值: invalid。可选值: Completed, Failed, Partial
```

输入/复现入口：

- P01/P02：`createStorage({})`；`createStorage({provider:{webdav:null},webdav:{endpoint:'http://dav.example.com',username:'u',password:'p'}})`，没有发网络请求。
- P04/P05：`decodeManifest('manifest.json', Buffer.from(JSON.stringify(input)))`；`mergeManifest` 输入 `z@2026-11-04T00:00:00.123000001Z` 与 `a@2026-11-04T00:00:00.123999999Z`，各 size=1、checksum='a'.repeat(64)、deviceId='d'。Rust 应 latest=a 且 updatedAt 为较新时刻。
- S03：真实 `host/platform/storage/connection.ts` 的 `Connection(':memory:', {label:'R4-safe-integers',profile:PROFILES.plain})`，构造 `SqliteSyncStateStore`，setCursor/getCursor，同 instance/device。
- B01：`createBackupHost()` → `host.invoke('data_governance_run_backup',{backupType:'incremental'})` 和 `host.invoke('data_governance_get_audit_logs',{status:'invalid'})` → `host.dispose()`；不会启动实际备份。

## 共性问题（供协调者规范回灌）

1. **错误文案相同不等于 IPC 错误等价。** L23 普通 ConfigError、L21 普通 Error 都会被 kernel 当 panic。移植用例须同时检查 Err 的 wire 形状、类别与 Promise 是否 settle；直接 `.toThrow('片段')` 会掩盖边界错误。证据：L23 P01/P08、L21 B01/B06。
2. **wiring 可达不等于被测逻辑真实或有生产消费方。** L20b 的测试文件导入生产 recompute，却用自写 apply；L21 文件导入生产 migration 模块，却在同文件重写初始化/锁策略。扫描器给 0 未接入仍可是假阳性。要逐项核对 Rust 原测试调用链和断言，不只核对标题/文件。证据：S01/S02/S06、B06。
3. **“接口未发布”不能成为复制逻辑或宣布完成的理由。** L23 用自造 optional guard 注册不可用命令；L20b/L21 复制其它表写入，L20 还保留平行副本。应联合发布最小业务 API、维护单一表所有者并接真消费方。证据：P03、S01/S04、B03/B05。
4. **锁/屏障必须改变真实操作，而不只是元数据。** JS 对象生存期不提供 Drop；私有 FIFO 不等于全局/跨进程锁；blocked_components 数组不等于冻结数据库。证据：P03、B02/B03/B08。
5. **平台数值/时间替代不能损伤已有数据。** Number→BigInt 不能修复精度损失；Date.parse 毫秒精度不能排序旧 Rust 纳秒时间。需要在读取和比较时保留原精度，而非仅给 TS 类型写 bigint。证据：P05、S03。
6. **日志属于失败语义。** 原 warn 后继续不可改为静默 continue，也不可改为抛错。对真实无日志 `let _ =` 不误报；日志走插件 logger。证据：P06、B10；正例 S 已核实 pomodoro echo 分支。
7. **未处理测试错误必须保留到验收结论。** 333 passed + Errors 1 不是绿；平台 DNS 失败应定位夹具依赖，也不能忽略退出码。与 pending、批准清单分别记账。

## 已登记的平台差异

- `decisions.md:24-31`：Electron Argon2 实现及密钥跨平台动态向量待补；本次未冒称完成 C 级。
- `decisions.md:52-59`：SQLite 平台差异、毫秒级生成时间、异步 backup 已登记；不能替代一致性屏障，也不能豁免读取已有纳秒时间/大整数的精度。
- L23 `SPEC.md:19`：进度 f32→double 已登记，尚需协调者明确裁定；不能以“前端只展示”自行证明严格等价。
- L20b/L21 SPEC 中对精度损失、安全整数限制的自述不视为协调者批准。与可修缺陷分开记录于各 ACCEPTANCE。

## 完成状态

- 三份独立 ACCEPTANCE 已写入逐项命令/服务审读、至少 15 条 ported 测试抽查、原始运行摘要、架构及语义差异。
- L23 原自写 ACCEPTANCE 已替换，核实正确的条目标为“复核确认”；原“全绿/所有错误等价”声明未继承。
- 必须修复的编号组均仍有未决项；已复核通过的修复子项单独勾选。本次不修改实现或代填批准。

## C2 指定 L20b 修复复核（7f8b92ed7）

复核包含 `e5e55daa5`、`21dd2e62a`、`5ab819dc1`、`06a9550f9` 的改动。已按要求执行分支 TESTMAP/SPEC 的 git show，并自行审查实际代码及测试。分支在读取期间移动，测试使用固定 `7f8b92ed7c12e7892a19efae718814445e606cce` 的 git archive 临时副本，未改 R4 实现、未切换分支、未写其它 lane 工作树。

| 编号 | 已确认的修复/修正 | 未决部分 |
|---|---|---|
| S01 | 未关闭 | L20 无 syncSupport 消费，L10 无 format.blocks，原5条 note_history pending |
| S02 | 删除测试自写 apply，六行退回 pending，重算补充测试明确标注 | 真实 apply/LWW/replay/Delete/quarantine 未迁完 |
| S03 | state/record safeIntegers、i64 CAS、echo bigint、内部载荷与 JSON 写入保真 | **JSON 文本解析仍丢大整数**：相邻值被视为同内容，冲突/历史不变量受损；L20 编码接线仍待 S01 |
| S04 | 未关闭 | 表所有者 API/平行 SQL 尚未收敛 |
| S05 | 三类 BEGIN/COMMIT 上下文、延迟约束回滚重试、游标/历史列解析通过 | prepare、bind/query、step 缺阶段区分；已亲测 prepare 文案仍错 |
| S06 | 原 writer 用例退回 pending、标注 final-sequence only | 缺真实 busy 通知/释放握手；固定300ms不证明争锁 |

亲跑最小集：`integer-precision.test.ts`（5）、`state-errors.test.ts`（9）、`pomodoro-counts.test.ts`（9）、`state.test.ts`（2），使用 `--no-cache --maxWorkers=1`，命令 cwd 为 R4 工作树、Vitest root 为 `/tmp/opencode/R4-L20b-7f8b92ed7-1CZ8h7`。

```text
 Test Files  4 passed (4)
      Tests  25 passed (25)
   Start at  12:38:26
   Duration  3.66s
exit=0
```

初次测试副本漏归档 `tsconfig.node.json`，在收集前报 ENOENT/4 failed suites/no tests；补同提交原文件后得到上述结果。此为复核环境准备错误，不归因于 lane，也没有修改被测代码。没有把实现者报告的81例当作本轮亲跑全套。

**S03 新的定向反例**（真实 F3 + 安装后的公开服务）：SQLite TEXT `props_json` 中的 `9007199254740992` / `9007199254740993` 仍经普通 JSON.parse 折叠。实际输出：

```text
adjacent JSON-text hashes equal: true
different JSON-text resolveOne: null
different JSON-text conflict inserts: true false
changed immutable props_json: ACCEPTED
cursors missing-table prepare error: Database error: 查询消费游标失败: no such table: consume_cursor
```

证据：`7f8b92ed7:host/plugins/sync-support/src/json.ts:127-135,153-164,196-207`；Rust `src-tauri/crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs:525-561`、`note_history.rs:222-235` 保留 i64 整数并应拒绝不可变版本差异。S05 prepare 反例对照 `state.rs:419-423`，应“读取消费游标失败”。完整输入、步骤、原始输出与已勾选修复子项见 `host/plugins/sync-support/ACCEPTANCE.md` §5。

**该轮派回结论**：L20b 仍不通过，S03/S05 的通过子项已明确勾选；S02/S06 的状态撤回不计作迁移完成。该轮结束时编号组未决数为 L23=9、L20b=6、L21=11；后续L23签收更新见下节。共性反馈新增：**safeIntegers 只修 SQLite INTEGER 读取，不会修 JSON 字符串字段的二次解析；精度验收必须覆盖比较、hash/去重和不可变历史校验的实际消费路径。**

## C2 续审 L23 新修复（c7c15e5b5）

固定 SHA：L23/main=`c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`；L21候选=`46bb99a298b7b3920b51c0b8ad6a163e46414a97`。候选代码并未进入被审c7 main；后者backup仍无tryAcquireOperation。只在 `/tmp/opencode` 创建原样git archive测试副本，命令cwd保持R4工作树，未修改实现/测试或其它lane工作树。

### 已签收

- **P01**：配置错误转换；真实invoke断言完整AppError值，不再HandlerPanic。
- **P02**：unit-enum map与string统一校验，公网HTTP拒绝、loopback接受、凭据校验一致。
- **P05**：timestamp/updatedAt/lastSyncTime使用纳秒比较；原同毫秒反例、ID tie-break、incoming覆盖均通过。
- P07的创建/打开/短头/解密失败分类及密码筛选；P08的Validation类型断言与S3 lookup；P09的平台trim复用，分别勾选通过子项，不整组关闭。

### 仍未签收的关键反例

1. **P03**：L23 `index.ts:54-62,138-150` 的guard自造且release/ID可选，空对象仍可下载成功并发空operationId。真实L21 `index.ts:46-48` 接受大写kind，L23传小写，实际backup/restore都变prune。持有真实Backup许可后，真实L23 upload invoke抛HandlerPanic；释放后可取Restore许可。不是只检查finally文本，也没有将局部互斥行为当完整快照屏障通过。
2. **P04**：`src/sync_manager.ts:166-241` 先JSON.parse导致 `version:1.0` 和重复version字段被接受；u64范围收窄到MAX_SAFE_INTEGER；错误消息缺serde位置且可能含已舍入值。DateTime<Utc> serde应输出Z，实装输出+00:00，新测试反而固定错误预期。依据项目Rust derive/字段及Cargo.lock锁定的chrono 0.4.41 Serialize源码（链接见ACCEPTANCE §5），未运行Rust。
3. **P06**：复用paths却走了L20的旧根优先包装；env-id/primary-id/legacy-id共存时返回legacy-id，违反L23 Rust env→primary→legacy。平台paths生产默认console日志，测试注入logger并未证明生产logger接通。
4. **P07/P09**：上传done先于密文临时文件dispose，Rust先drop再done；业务编排仍留在index。
5. **P08**：逐行235 ported/624 pending，表头旧206/653；20条Docker门控未执行，不能用实现者“354passed”替代独立验收。本轮没有开Docker服务。

### 最小集原始输出摘要

六文件：commands_errors、manifest_decode、cloud_transfer、device_identity、commands_transfer、mod；使用固定副本及 `--no-cache --maxWorkers=1`。

```text
 Test Files  6 passed (6)
      Tests  53 passed (53)
   Start at  13:05:03
   Duration  5.25s
exit=0
```

另对s3.test.ts仅选 `keeps the endpoint path prefix for virtual-hosted requests`：

```text
 Test Files  1 passed (1)
      Tests  1 passed | 42 skipped (43)
   Start at  13:05:09
   Duration  2.29s
exit=0
```

54个实际执行用例通过；42个是名称过滤未执行，20个Docker测试另行保留未执行，不混为通过。代码/真实invoke定向探针的关键原文：

```text
device priority {"DEVICE_ID":"env-id"} actual= legacy-id
device priority {} actual= legacy-id
guard without operationId/release download= true event operationIds= [""]
real L21 guard backup => prune
real L21 guard restore => prune
real L21 guard Backup => backup
real L21 guard Restore => restore
real L21 held -> real L23 invoke: HandlerPanic command "cloud_sync_upload" panicked (in production the frontend promise would never settle): 已有数据治理操作正在运行（当前 Backup，operation_id=42015ec3-dea1-4055-a264-e67e9cc7e014）
real L21 permit after release: restore
```

完整manifest输出、输入与原始命令在 `host/plugins/sync-providers/ACCEPTANCE.md` §5。L21 ACCEPTANCE追加此组合证据，但不替代其完整B组复核。

**当前未决组数：L23=6、L20b=6、L21=11，共23。** 新共性反馈：共享平台函数不一定与原调用入口语义相同（设备ID包装优先级）；serde的wire枚举不等于服务参数约定；可选release和空ID回退会掩盖未接线；测试预期也必须审查库默认Serialize行为，不能把to_rfc3339与DateTime serde混为一谈。

## 授权合并 main 与 D1–D4 / quality §10 对齐（e303957124）

合并对象锁定 `e303957124ac220f55bee1b04cca5d3937983b92`，合并前R4为 `6ad31f6f2`。执行 `git merge --no-commit --no-ff <上述SHA>`，只在 `host/plugins/sync-providers/ACCEPTANCE.md` 发生内容冲突，初次merge exit=1；无越权路径冲突。按架构师授权保留独立结论，main的Docker门控/pending/BLOCKERS线索保留为事实或定位来源，不继承未复核的全勾、类型检查绿或B14声明。未手改实现/测试/契约；main已有实现随授权merge进入。

### 裁定如何影响验收

- **D1/D4**（`decisions.md:106-110,123-124`）：所有者可发布带可选SqlExecutor的业务 `*WithConn`，调用方可在平台事务中向多个所有者传同一连接。撤回sync-support建议中仅对“公开连接参数”的疑虑；不要求拆事务。S04/B05依然针对消费者亲自执行他表SQL与复制业务写入，检查项是实际所有者、同事务、提交/回滚与日志。
- **D2**（`:113-116`）：L21唯一共享许可；guard.release必需，L23的optional release、空ID回退和大小写错配仍是缺陷；候选分支API不能写成main可用。main e303的相关L21接口与c7相同，46bb99a298仍仅为候选组合证据。
- **D3**（`:118-121`）：数据库及Host内部整数/纳秒保真；IPC边界按Rust/Tauri JSON number。S03是SQLite TEXT的JSON二次解析后内部错误比较/去重，不是允许的IPC舍入。P04也不能用MAX_SAFE_INTEGER拒绝Rust合法u64；P05的纳秒修复保留签收。
- **quality §10**（`quality.md:116-128`）：生产入口、原断言、业务Err和日志依旧必须；保留所有历史Errors与退出码。main/候选分支能力分开记录。

`git diff c7c15e5b5 e303957124 -- host/plugins/sync-providers host/plugins/backup/api.ts host/plugins/backup/index.ts host/plugins/backup/src/operations.ts host/plugins/sync-support host/platform/paths` 无输出；本次没有新的上述实现修复要重新签收。为完成合并协议，只对合并后的工作树运行类型检查及两个命令入口文件，不重跑54例、25例或Docker套件。

### 合并后门禁原始摘要

```text
$ npm run typecheck:host
> deep-student@0.11.0 typecheck:host
> tsc -p tsconfig.host.json
exit=0
```

完整类型检查输出保留在 `/tmp/opencode/R4-merge-e303-typecheck.log`，本次无诊断错误。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/sync-providers/tests/commands_errors.test.ts host/plugins/sync-providers/tests/commands_transfer.test.ts --no-cache --maxWorkers=1
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R4-review-sync
 ✓ host/plugins/sync-providers/tests/commands_errors.test.ts (9 tests) 801ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (6 tests) 2457ms
 Test Files  2 passed (2)
      Tests  15 passed (15)
   Start at  13:31:45
   Duration  5.44s
exit=0
```

本次Vitest没有输出Errors行，没有截掉错误；它只证明所选命令入口用例在合并树通过，其中外部L21 guard仍是测试侧契约替身，不能反向关闭先前真实组合失败的P03。首次L21两次Errors=1/exit=1及本轮其它反例原文继续保留。独立结论仍为三lane不通过，未决组数6/6/11。

## L23 P03/P08 新候选补审与全局作业队列

### 固定范围

- L23：`1da6dadc5580a6ff9a6cfe59abf1a3a77aef7e1c`。
- 最新读取到的真实L21提供方：`e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`，不同于上轮46bb99a298。
- main可见性：`15b23540a97ee19e1391859c3bc140e5c0daa182`；两个候选均非其祖先（merge-base检查exit=1），main backup/api.ts:91-98仍无tryAcquireOperation。
- 本轮没有合入候选代码、改实现/测试或运行Rust。原样git archive测试副本位于 `/tmp/opencode`；cwd为R4。测试和Node组合探针均经全局job.mjs提交，等待时静态审读Rust/API/TESTMAP，没有直接跑重CPU命令。

### 编号判定

| 编号 | 复核确认 | 未决/反例 |
|---|---|---|
| P03 | 删除optional调用与空ID回退；类型要求operationId/release；真实provider在配置失败、成功下载后许可均可重取 | 最新L21改回snake_case，L23大写镜像再次漂移；L21忙锁/IO为CommandError(string)，L23透传后违反AppError契约；消息猜类型且未知TypeError被转换为Unknown；缺release TypeError被warn catch吸收，下载仍成功 |
| P08 | 表头/实际行数一致；防降级message/value及warn增强断言通过 | 615 pending，20Docker未运行；merged目标未证明原子进程/环境隔离/退出保证；新mobile_feature_profiles遗漏Rust两个真实profile及FTP断言；新guard错误替身形状与真实L21不同。审批缺失理由已撤回 |
| P07 | 未重复测试/未签收新修复 | 上传done仍在临时密文dispose之前；与许可finally释放是不同问题 |
| S04 | 没有根据L11新API存在就关闭 | 等待真实消费者把写SQL交所有者并保持同一事务 |

P03重要证据：1da `index.ts:112-150,246,291,323`；镜像 `src/backup_operation_guard.ts:15-29`。e4dd `backup/api.ts:150-157`、`index.ts:53-54`、`src/operations.ts:26-33,51-54,80-90,227-239`。详细反例与Rust对照在L23 ACCEPTANCE §7、backup ACCEPTANCE §6。

### 作业结果（result 返回的退出码）

**作业20261104061655-9d17c0**：固定L23树，三个文件commands_transfer/mod/sync_android_platform，`--no-cache --maxWorkers=1`；没有运行未变的P04/P07文件或全套363例。

```text
 ✓ host/plugins/sync-providers/tests/mod.test.ts (12 tests) 19ms
 ✓ host/plugins/sync-providers/tests/sync_android_platform.test.ts (9 tests) 16ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (8 tests) 2286ms
 Test Files  3 passed (3)
      Tests  29 passed (29)
   Start at  14:16:56
   Duration  4.75s
[作业 20261104061655-9d17c0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061655-9d17c0.log
```

**作业20261104062036-519809**：同一kernel的真实候选组合。先提取e4dd完整host/contracts，再覆盖1da sync-providers原目录，两插件共用同一个CommandError类，避免跨快照instanceof误差。真实guard/Operations/锁文件未替换，临时recovery普通文件真实触发IO；真实L21 hydrate读取测试SSOT输入，真实L23通过本地DAV下载。未知异常注入部分单独标记，不冒称真实provider故意返回坏对象。

```text
provider kind Backup ledger= Backup
provider kind Restore ledger= Restore
provider kind Prune ledger= Prune
provider kind backup ledger= backup
provider kind restore ledger= restore
provider kind prune ledger= prune
provider busy error value= "已有数据治理操作正在运行（当前 Backup，operation_id=0d5b9119-9550-4efb-bf3a-738ad2294038）"
invoke busy= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
provider IO error value= "创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-A4P3bL/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-A4P3bL/recovery'"
invoke IO= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
invoke config failure= {"error_type":"Validation","message":"缺少 WebDAV 配置","details":null}
real permit after command failure= restore
real-provider download= true next permit= backup
download operationIds nonempty= true
unknown TypeError => {"error_type":"Unknown","message":"unexpected provider bug","details":null}
missing provider => {"error_type":"Unknown","message":"ctx.backup.tryAcquireOperation is not a function","details":null}
guard empty => HandlerPanic: command "cloud_sync_upload" panicked (in production the frontend promise would never settle): guard.operationId is not a function
guard lacks release => {"error_type":"Validation","message":"缺少 WebDAV 配置","details":null}
[作业 20261104062036-519809] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062036-519809.log
```

**作业20261104062334-d22bc2**：定向验证“必需release声明”是否真的排除了缺实现后的成功路径。仅替外部guard返回operationId，无release，真实L23/DAV下载仍成功：

```text
guard missing release successful download= v1 done= true
[作业 20261104062334-d22bc2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062334-d22bc2.log
```

后两者是捕获并打印错误的观测探针；exit=0表示运行完成，**不代表业务验收通过**。三个result输出均保留作业号、退出码与日志路径；首个Vitest没有Errors行。原历史失败未删除。

### 新测试映射真实性

候选TESTMAP:12统计242/615/2，已逐行计数确认。新增mobile_feature_profiles_exclude_s3_backend（:244）只断言DESKTOP/ANDROID常量；Rust `sync_android_device_switch.rs:657-685` 实际锁定两个Cargo移动profile、无独立FTP feature、default启用S3，不能无批准替换为不连接构建面的布尔测试。

两条merged（:248 r09_device_id_probe_subprocess、:263 sync_r07_device_id_probe）无需额外批准，原“无批准”理由撤回。目标device_identity测试只重建同进程Paths对象，原Rust子进程/环境隔离/退出状态保证仍未证明。另一个mobile-only profile用例的obsolete批准也不能代替新的desktop控制组/profile/FTP等价证明。Docker未开启；363passed/20skip声明未继承。

**反馈给协调者**：P03类型镜像正造成“双方相互追赶但持续错配”，应以唯一L21公开api.ts固定kind/guard/结构化失败契约并一起集成；CommandError只是kernel包装，不保证value满足各命令error schema。真实provider测试必须与消费者共享相同kernel实例；self-made plain Error/raw AppError测试无法揭示所有者扁平化后的损失。仍为L23六组、L20b六组、L21十一组未决，三lane不通过。

## L21 e4dd1772f 的 B01/B02/B03/B08/B09 定向签收

### 基线与判定

读取 `ds-mig/L21-backup-governance:SPEC.md/REPORT.md`，仅作修复定位；独立核对完整固定树 `e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`（含2a3738008/31ad462b2）、Rust及实际测试。main固定 `f67db20801c2d787a06f3277f9afd9499dc30fac`，其backup/api.ts仍无tryAcquireOperation，候选祖先检查exit=1；本轮没有merge候选或编辑实现/测试。

| 编号 | 签收结论 | 证据摘要 |
|---|---|---|
| B01 | **候选已修** | stringErrorCommand用于error:string注册；五条真实invoke精确字符串断言通过；不包含P03跨服务AppError错误形状 |
| B02 | 部分修复 | 独立真实F3维护期旧句柄写入/新借用均拒绝、释放后恢复；既有mistakes维护态下备份错误拒绝；工作区首次退出失败只调用1次，缺Rust Drop重试 |
| B03 | 部分修复 | 真实L21跨服务共享、等待、超时不补授通过；复用上一轮同e4dd/1da真实持锁/IO契约反例；备份等待锁取消仍等到持有者释放；wx/PID文件锁仍未证明fs2等价 |
| B08 | **候选已修** | 等待时才新增备份、命令选中新备份；真实审计INSERT发生时许可仍被持有；返回后可重取许可 |
| B09 | 部分修复 | readonly+5秒timeout已修；真实孤儿FK触发close忙错误覆盖原诊断，迭代prepare/query/step边界仍未区分 |

B05删除本地sync-state轮换文件、改调syncSupport是源码进展；VFS本地写SQL仍在，两条VFS TESTMAP仍pending，取消skip不授权越权SQL。B06退回7+1条init/registry映射也不等于生产入口已迁完；仍保留部分本地初始化helpers，未按报告自述关闭。B04/B10/B11本轮未逐组验证全部修复，保持待复核；不将首轮反例当作e4dd未经检查的当前事实。

### 作业与 result 原退出码

原样git archive副本 `/tmp/opencode/R4-L21-e4dd1772f-QPkqOg`，含原host/contracts/迁移SQL/测试配置，未改代码。所有运行经全局队列submit，cwd R4；没有直接tsc/vitest/build或重复排队。

**20261104063704-2fbc80**：acceptance-fixes.test.ts，仅 `-t 'B0[12389] '`，`--no-cache --maxWorkers=1`。

```text
 ✓ host/plugins/backup/tests/acceptance-fixes.test.ts (14 tests | 5 skipped) 3977ms
 Test Files  1 passed (1)
      Tests  9 passed | 5 skipped (14)
   Start at  14:37:04
   Duration  9.58s
[作业 20261104063704-2fbc80] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063704-2fbc80.log
```

**20261104063704-f51a4e**：operation-and-sync-ports.test.ts，同样禁cache/单worker。

```text
 ✓ host/plugins/backup/tests/operation-and-sync-ports.test.ts (10 tests) 4510ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  14:37:06
   Duration  9.64s
[作业 20261104063704-f51a4e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063704-f51a4e.log
```

共19例实际执行通过，无Errors行；5 skipped是名称过滤排除B04/B11，不是跳过失败测试。既有真实L21+L23的同树组合未变化，沿用作业20261104062036-519809，不重跑；owner的22文件358passed/exit0仅记声明，不冒充本轮独立全套结果。

### 不能仅采信 supplied storage 的原因与补充探针

`tests/acceptance-fixes.test.ts:115-127` 的B02测试把enterMaintenance替成布尔标签，baseEnter未调用；`tests/helpers.ts:269-320` 包装真实Connection但维护no-op，且没有iterate。B09只断言profiles及无“只读打开失败”，容许未运行FK检查也通过。它们验证接线调用，不能证明完整生产屏障/诊断。

作业 **20261104064052-6f8b96** 因此使用真实StorageServiceImpl/SqliteDatabase，未替换enterMaintenance，通过真实host.invoke：

```text
B02 actual held-handle write blocked= MAINTENANCE Database vfs is in maintenance mode
B02 new database borrow blocked= MAINTENANCE
B02 actual storage job= completed after-release write= 1
B02 pre-existing maintenance job= failed message= 无法建立一致备份快照: 数据库进入备份快照屏障失败: Database mistakes is already in maintenance mode
B02 release failure job= failed exit calls= 1 message= 退出备份快照屏障失败: 工作区: transient exit failure
B09 actual FK issue= ["有 70 个迁移待执行 (当前: v20260130, 目标: v20261027)","数据库完整性检查失败: This database connection is busy executing a query"]
[作业 20261104064052-6f8b96] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064052-6f8b96.log
```

实际维护写阻断正常路径已修；既有维护态应按Rust `commands_backup.rs:1098-1104` 借用而非拒绝。三个staging入口release失败直接return，未调用已声明dispose：`src/backup-commands.ts:295-296,447-448`、`src/zip-commands.ts:519-520` 对Rust `commands_backup.rs:1161-1179` 的Drop重试。故障注入只替外部工作区退出失败，不替内部许可/存储。

FK反例用真实库 `parent/child` 孤儿行，readonly检查next返回第一条后未结束generator，finally close抛busy覆盖“检测到外键约束违规”。证据：`src/governance.ts:354-362`、平台 `connection.ts:167-190`；Rust `commands.rs:918-923`。待迁移70项是最小旧schema夹具背景，本轮不运行迁移。

作业 **20261104064219-4aad86** 用真实F3+L21，审计仅加透传run观察器：

```text
B08 selected= added-while-waiting audit observed= true audit lock held= true next permit acquired=true
B03 cancelled while held status= queued phase= queued
B03 status after holder release= cancelled
[作业 20261104064219-4aad86] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064219-4aad86.log
```

B08修复有真实选择/审计/释放证据（`src/backup-commands.ts:187-230` 对Rust `commands_backup.rs:1512-1535,1572-1605`）。B03备份等待期间取消后450ms仍queued，因为`:260`先await许可、`:272`才检查取消；Rust `commands_backup.rs:999-1016` 在等待中200ms轮询取消。超时API通过不代表该取消分支已迁完。

后两作业是观测探针，exit0表示捕获/打印完成，**不是反例验收通过**。完整步骤在backup ACCEPTANCE §7，原Errors及退出码不删除。

### 反馈与结论

- 共享许可、备份快照屏障、业务等待取消、临时文件清理以及数据库statement生命周期分别验收，不能用一种finally覆盖所有Drop保证。
- 测试fixture名为createRealStorage仍可能只是真实SQLite加假维护接口；检查其实际能力。没有iterate的fixture可能让健康检查一直降级而测试仍绿。
- 异常清理（generator.return/连接close）会覆盖业务错误，必须通过真实坏数据路径检查，而不仅传入readonly选项。
- 当前候选签收B01/B08，其它9个B组未决；L23六组、L20b六组未变，共21组。三lane仍不通过。main能力另记待集成，未因所有者API或取消skip而关闭B05/S04。

## C2规则纠正与owner接线基线（9c13dfc39）

**撤回错误理由**：已读 `scripts/electron-migration/lib/ledger-core.mjs:40-44,51-78`。仅obsolete需审批；merged由目标文件、目标标题与执行结果判定，不要求单独批准。28c7db303/7d10485eb中“两个merged缺批准”不成立，已从P08正文及汇总删除。P08仍有原子进程/环境隔离/退出状态未证明、真实profile/FTP断言缺失等有效反证，不能将“无需审批”反向当作行为等价。未决编号组数保持6/6/9，本次纠正文档不重复排队求绿。

**新main接口基线**：固定 `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`，`notes/api.ts:70-99` 已发布format.blocks和notes.sync事务业务面，`vfs-repos/api.ts:360-370` 已发布recomputeCompletedPomodorosForSyncBatch。后续不能再简单以“所有者API不存在”说明S04；必须复核具体消费提交、真实写者与同一事务。

**精度不变量随所有权迁移继续验**：只读核实 `notes/repository/sync.ts:81-90` 使用JSON.parse做_json比较，`:157-159` revision查询无safeIntegers后才BigInt，`:223-229` history读取同样未启用safe整数。此为9c13的源码风险基线，已由C2派C1/L10；本次未对新所有者执行探针，不把旧L20b的动态输出伪称为新notes实测。未来S04联合复核要同时重验S03的相邻大整数JSON、CAS/i64、不可变历史与事务回滚；SQL转交本身不能关闭语义缺陷。

## 继续 B03 新增量：19c023cd6 + cb9d683d0 的可加载性阻塞

完成上述规则纠正后，发现L21确有新代码增量，固定 `19c023cd63ff456e0dadc4d2cfd841924455b935` 与读取到的最新L23 `cb9d683d0fd782a04188cc1661dd6598fdbc1771`，仅检查守卫相关新改动。main另固定 `f37426009bc33c55093be35a1fa82aa31b271965`；其backup/api.ts仍无tryAcquireOperation/OperationGuardError。B02/B09相关实现从e4dd到19c无变化，未重复旧测试。

新提供方 `src/operation-errors.ts:39-79` 把value与app_error统一成完整AppError，busy/lock_io有稳定reason/code，`src/operations.ts:64-86` 按已知对象类型转换且普通Error透传；L21自己的字符串命令出口仍按原契约取message。新消费者kind改snake_case并移除按中文message前缀猜类别，新增未知TypeError/缺release拒绝测试。旧e4dd/1da的kind/wire输出保留为历史，不能说新pair仍已动态复现相同缺陷。

原样组合副本 `/tmp/opencode/R4-P03-19c0-cb9d-aCHUJq`，全局队列作业 **20261104070640-d367ed**：两个guard相关文件按用例名选择1条新L21真实忙锁/IO用例和10条L23错误/生命周期用例（消费者外部guard在这些单测中为测试侧替身）。

```text
 ✓ host/plugins/backup/tests/operation-and-sync-ports.test.ts (11 tests | 10 skipped) 612ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (13 tests | 3 skipped) 3040ms
 Test Files  2 passed (2)
      Tests  11 passed | 13 skipped (24)
   Start at  15:06:41
   Duration  7.01s
[作业 20261104070640-d367ed] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070640-d367ed.log
```

13 skipped为过滤未选，无Errors行。随后使用Node原生类型擦除加载真实L21/L23的组合探针作业 **20261104070755-b0ffa4** 在任何业务调用之前失败：

```text
file:///tmp/opencode/R4-P03-19c0-cb9d-aCHUJq/host/plugins/sync-providers/src/sync_manager.ts:171
  constructor(message: string, readonly line?: number, readonly column?: number) {
                                        ^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
Node.js v26.5.0
[作业 20261104070755-b0ffa4] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104070755-b0ffa4.log
```

P09归因明确：cb9 ManifestDecodeError参数属性，以及 `src/json_exact.ts:14-20,32-36,46-51` 的三处同类语法，违反quality §9。没有转译绕过、改实现或删失败求绿；该作业计划的真实持锁/IO/下载/释放均未执行。提供方结构化错误子项承认测试进展，但组合必须等Host可加载后验证，P03不关闭。

main/候选、测试编译器/生产原生Node、provider单测/真实组合分别记账。当前6/6/9组未决不变；L21旧B02/B09反例仍限e4dd（相关19c代码未变），新cb9其余P组广泛修改待后续针对性签收，不能凭文件新增宣布通过。

## F4 P06交付后的新实际消费复核（da290fd2e / 679b53948）

最初仅准备记录F4提供方，不因C2的35/35声明先签P06；读取发现L23确有新提交 `da290fd2efd1fd11346b08653941d9b70d4bc620`，`src/device_identity.ts:17-22` 已仅调用必需dataSpaceDeviceId，原optional检测、env读取、WeakMap及WithoutMethod桥已删除。按既有P06复核计划，仅对此新消费路径提交一次探针，没有重复F4全套或B组旧测试。

固定F4 `679b5394896df3acde87eb29e04219db1acf9bb8`（包含d85995b4b）。其 `paths/api.ts:119-125` 发布方法，`index.ts:301-309,386-387` 为底层env→primary→legacy语义，旧deviceId包装单独保留；`:424-434` 的生产插件接入ctx log/logger。L23 `index.ts:170-172,296` manager和命令均走所有者。main固定 `679fd3e4d3bdaff9d38188aab851704e952b9ac0` 仍无该API，两个候选均未被该main包含；签收候选修复不宣称main可用。

组合副本 `/tmp/opencode/R4-P06-da290-679b-pG5aIx` 原样提取两固定树，安装真实F4 paths插件和L23插件，通过真实host.invoke运行5个场景，**没有注入dataSpaceDeviceId替身、没有用WithoutMethod绕过生产接线**。log服务只是契约级日志接收器，生产paths.apply负责把logger传入工厂。5场景用Node assert，不符合期望即非零退出。

全局作业 **20261104072250-8b8a5a**，`job.mjs result ... --tail 150` 原文：

```text
native imports: ok
env > primary > legacy PASS env-id []
primary > legacy PASS primary-id []
legacy migrates only when primary absent PASS legacy-id ["info"]
migration failure logs via production log service PASS legacy-readable ["warn"]
persistence failure logs and preserves process identity PASS device-76637d2f ["error","error"]
P06 owner-plugin/consumer-command assertions: 5 scenarios passed
[作业 20261104072250-8b8a5a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104072250-8b8a5a.log
```

无Errors输出；这是实际消费方的新增验证，不继承C2作业20261104063141-9a504c的35例为本次亲跑。临时目录/env隔离、每例清理并还原作业进程环境。Linux运行只验证日志接收端被正确调用，不声称验证日志文件落盘或Win/macOS动态行为。

**P06候选组合已修，main待共同集成。** 同次Node原生加载整个L23入口成功，da290显式字段写法修复cb9参数属性阻塞；旧exit1仍保留历史，但不再说新树不可加载。P09整体架构与其它新P组未因此自动签收，P03完整新provider组合本轮未重跑。未决组数更新为5/6/9，共20。

## 正式 main d5cd234aa 后的 L23 增量复核（624cfe251）

### 基线与状态迁移

协调者指定main=`d5cd234aa8a919807b65eeca250e5567cc527f95`，已核其backup/api.ts:92-123,174-188正式提供结构化许可，不再重复要求集成旧e4dd。L23=`624cfe2515b5c6cb1dd49ba010e58930f01847c3`包含该main（祖先检查exit0），删除guard镜像、直接导入正式api。原样测试副本 `/tmp/opencode/R4-L23-624c-d5cd-dgU4Ql` 添加固定F4 679b的paths供成功传输/子进程使用；该F4依赖仍单独标待集成。

- **P03消费侧关闭**：当前snake_case、完整AppError直接透传、未知异常不猜文案、显式release均接正式API。真实持锁/IO的invoke得到正确对象，真实上传账本kind正确、返回后许可可再取。供方B03跨进程原语及等待取消并未因此关闭。
- **P07关闭**：cloud_commands.ts:111-118先清临时密文再done，finally处理失败；真实加密上传在实际done时观察temp=0，新两个workflow测试也验证成功/失败清理。
- **P09关闭**：策略/文件/清理/进度工作流已归src，index保留注册、服务构造、生命周期接线；平台trim/身份共享、guard镜像删除，可原生加载；33个生产TS静态扫描无console/tests导入。parser行为缺陷仍归P04。
- **P04部分修复**：token分类、已知字段重复、u64解码/encode、UTC Z已修；新的未知字段及内部精度/错误诊断问题保留。
- **P08行为子项通过**：子进程实际spawn/环境隔离/exit检查、原Cargo profile/FTP/default断言均已补并亲跑，不再引用旧仅实例重建/常量测试反证。240ported/618pending/1obsolete（批准已核）及20 Docker未执行仍不闭合。

### 已排队最小集结果（中断后仅取结果）

作业 **20261104074106-d92aa8**：manifest_decode、cloud_transfer、device_identity、sync_android_platform，用例名筛选增量；P05两条合并测试未重跑。

```text
 ✓ host/plugins/sync-providers/tests/manifest_decode.test.ts (11 tests | 2 skipped) 64ms
 ✓ host/plugins/sync-providers/tests/cloud_transfer.test.ts (13 tests | 11 skipped) 935ms
 ✓ host/plugins/sync-providers/tests/sync_android_platform.test.ts (9 tests | 4 skipped) 28ms
 ✓ host/plugins/sync-providers/tests/device_identity.test.ts (8 tests | 6 skipped) 5080ms
 Test Files  4 passed (4)
      Tests  18 passed | 23 skipped (41)
   Start at  15:41:07
   Duration  10.64s
[作业 20261104074106-d92aa8] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074106-d92aa8.log
```

23 skipped为过滤未选，无Errors行；18实际通过为9解码、2清理、2子进程、5平台/profile。身份子进程在真实F4组合中执行，不用WithoutMethod或同进程实例代替；未把组合通过写回TESTMAP或声称main已具备F4 API。

### 真实组合的有效证据与错误预期失败

作业 **20261104074838-775a11** 无supplied guard，真实L21+L23+F4 crypto+本地HTTP。成功断言原文：

```text
P03 real busy= {"error_type":"Validation","message":"已有数据治理操作正在运行（当前 Backup，operation_id=4e175dd5-099c-454b-b92c-b65eab8404bc）","details":null}
P03 real IO= {"error_type":"FileSystem","message":"创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-8juoWY/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-8juoWY/recovery'","details":null}
P03/P07 real encrypted upload done temp= 0 kind= backup next permit=restore
```

随后复核者在transferring回调abort令牌并要求reject，实际成功而断言失败：

```text
AssertionError [ERR_ASSERTION]: Missing expected rejection.
    at async file:///home/dsdev/dev/ds-mig/R4-review-sync/[eval1]:28:6
Node.js v26.5.0
[作业 20261104074838-775a11] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104074838-775a11.log
```

**不把失败删去，也不误归因实现**：补读Rust cloud_storage/webdav.rs:1119-1269，令牌仅在退避/限流等待点使用（:1178/acquire_request_slot），首轮成功PUT没有该即时取消点；TS webdav.ts:543-569一致。错误的是本探针强加的取消保证，未改实现、未重跑已成功前段求绿。该作业整体不能写“全绿”；P03消费接口、P07成功清理使用实际已成功断言及独立通过用例佐证，未认证供方全部B03或取消路径。

### P04独立反例（前一作业失败后尚未执行的部分）

只补交作业 **20261104075808-88807e**，调用真实decodeManifest/encodeManifest：

```text
P04 unknown extension duplicate REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: duplicate field `x` at line 1 column 82","details":null}
P04 unknown proto supplies required version ACCEPTED {"version":1,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}
P04 boolean timestamp REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: invalid type: boolean, expected a string for `updatedAt` at line 1 column 46","details":null}
P04 missing version REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: missing field `version` at line 1 column 16","details":null}
[作业 20261104075808-88807e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075808-88807e.log
```

输入及完整源码依据见L23 ACCEPTANCE §11。未知extension内部重复键本应随未知字段忽略；未知__proto__不应补出必填version。TS parser的普通对象赋值/统一duplicate检查及 `field in object` 改变serde默认未知字段语义（json_exact.ts:123,136,142；sync_manager.ts:206,215,238）。仍有自造 `for field` 与非number错误使用文档终点的诊断差异，以及首块计划/续传比较前的 `Number(version.size)`（:860,1082）。观察探针exit0仅表示打印完成，不是语义通过。

### 恢复要求与ledger

服务器恢复通知期间，已执行git log --oneline -20/git status，读取候选TESTMAP并取已排作业结果，HEAD8d4cbdf82、工作树干净；未重复提交测试。用户要求的ledger在R4工作树（实现仍为e303，非本轮624组合）通过队列运行：

```text
ledger: commands 1058 (A 91.5% B 5.9% C 0%), tests 8036 (A 76.6% B 0.7%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104074530-11f04a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074530-11f04a.log
```

机械ledger绿不替代独立语义证据。当前 **L23=2、L20b=6、L21=9，共17组未决**；三lane仍不通过。main正式许可已交付与F4待集成分开，旧反例/旧非零结果按其SHA保存，不据owner自评覆盖。

## S组候选证据落盘与v2切换（82d123466 / 32e423cb2）

L23 3628c40c5相对已审624仅说明文档不同，未重跑；中间缺release人工测试失败在“文件必须不存在”，此额外保证不属于Rust Drop/下载语义，详见L23 §12。原exit1保留，不据删除用例个数判定弱化原不变量。

已完成的S组新作业（未重复旧25例）：

| 作业 | 固定树与范围 | result原结果 |
|---|---|---|
| 20261104083351-f20459 | 82d：pomodoro-counts/json-text-precision/owner-transactions | 16passed/1failed，exit1；真实pomodoro 9/9、owner事务3/3通过，props_json历史仍错误放行 |
| 20261104083351-301570 | 82d：只选新CAS/INTEGER历史与missing-table/首step | 1passed/4failed/13过滤skip，exit1；CAS舍入、相同INTEGER历史误冲突、两个prepare前缀错误 |
| 20261104083352-6f6575 | 82d + L10 32e候选：只选受owner改动影响的5例 | 5passed/9过滤skip，exit0；正向CAS/INTEGER历史/props_json及事务回滚通过 |
| 20261104085310-226c92 | 同kernel候选owner坏JSON/负整数定向观察 | exit0；坏历史JSON报Database、冲突比较回退文本正确；负CAS仍舍入 |

完整stdout、Errors情况、源码行与原日志路径已写 `host/plugins/sync-support/ACCEPTANCE.md` §8：两原树非零作业无额外Unhandled Errors但有5个真实断言失败，不把组合通过覆盖原树失败。日志均在 `/home/dsdev/.oc-jobs/done/<job>.log`。

候选S02已不再自写apply：安装真实sync公开服务，六条原测试保留双设备、Delete/replay及success/failure_count原断言，9/9通过。按新standard-v2 §1.8，候选通过不算main闭环，S02仍保持待main复验（main eeaf的support表仍六条pomodoro pending）。S04 support本身已删note/todo写SQL，实际owner同事务回滚通过；但L20默认createNoteHistoryHooks仍直接写notes/formats/relations/revisions，整链不能签收。

S03三项conflicts大整数JSON已修；L10新候选读写正向精度通过，但 `notes/repository/sync.ts:158` 只比较MAX_SAFE，-9007199254740994n+1实际变number -9007199254740992，原i64应为-9007199254740993。该关系revision迁移列无正数CHECK。严格历史坏JSON报错与宽松conflict比较回退的差别有Rust `note_history.rs:213-235` / `conflict_resolver.rs:552-559` 直接依据，不要求统一catch。

S05新增iterate后仍不能按是否产出行猜query/step：锁定rusqlite0.40.1 Statement::query仅bind并返回Rows，第一次next失败同样属于遍历（项目state.rs:424-430）。两个prepare新测试失败属实，首次overflow测试虽然绿但期望错误，S05不关闭。

已读取正式main的 `standard-v2.md` §1八类规则与§2清单；新增补审sync由R4负责，写入 `host/plugins/sync/ACCEPTANCE.md`（该路径后于2026-11-05授权无损迁入本报告末节）。复验闭环优先，后续固定main验证已合修复，不能把候选勾选当v2完成；不动实现/测试/SPEC/TESTMAP。新main e60e已含L10精度修复、eeaf已含L21维护/取消/FK修复，下一单元按真实main最小复验，旧候选状态不覆盖新main。

## v2正式main复验与新增sync补审（eeaf5bdc7）

恢复已执行`git log --oneline -20`、`git status`，HEAD=8e22805b4且工作区干净，未重做已提交候选审计。固定main `eeaf5bdc7ae95a336c34b3a75b19f844726fe064` 原样快照 `/tmp/opencode/R4-v2-main-eeaf-FoYvZ8`，未切分支或改实现。备份签收文档已单独提交`be8ac89c0`。

| 作业 | 结果与范围 |
|---|---|
| 20261104105548-dc7233 | 已有R4工作树ledger作业亲取result：exit0，commands1058/tests8036，problems commands0/tests0/orphan0；不是eeaf快照行为证据 |
| 20261104111500-ac6715 | 正式main备份最小集：exit0，10passed/9标题过滤skip，无Failed/Unhandled Errors；B01五条、B08、B02外部lease借用/首错重试、B03排队取消、B09真实坏FK |
| 20261104112233-364289 | 上次过滤遗漏的新B03锁IO分支：exit0，1passed/18标题过滤skip，无Errors；真实F3下保留“获取全局备份锁失败:”上下文 |
| 20261104111500-af42b6 | 正式main sync：**exit1**，31passed/4failed/6skip；Failed Suite1 + Failed Tests4，未有额外Unhandled Errors。缺dataSpaceDeviceId的测试paths导致list/quarantine宿主安装失败，非业务断言通过 |
| 20261104112304-515659 | 正式main真实F4/F3/notes/vfs-repos/support/sync生产组合观察：exit0但确认3个精度偏差和2个维护分支缺口；观察脚本不把exit0当绿 |

日志均为 `/home/dsdev/.oc-jobs/done/<job-id>.log`，详细命令、原stdout、过滤/失败原因在各ACCEPTANCE。

### 复验签收

- B01/B08从候选转main签收。B02外部维护借用不解除原lease、release失败同调用重试且保留首错通过；B03排队取消与锁IO上下文通过；B09iterator.return先于close、坏FK不再被busy遮蔽通过。B02启动、B03跨进程原语、B09完整SQL阶段仍未闭合，九个B组状态没有因局部绿变成整组绿。
- S01/S04：生产默认hook仍是L20本地写者。S03：真实默认apply对revision=9007199254740993返回`Relation revision exhausted`，而Rust应+1；正式main owner对-9007199254740994+1仍舍入到-9007199254740992。原坏JSON的历史严格/冲突回退差别继续保留，未误报。
- S02：支持方表28ported/12pending，与L20把11条真实apply映射到自己测试文件不同；L20实际211ported/47pending/5obsolete，页首182/81过期。不能仅拿support旧表头断言全链没实现，也不能把main测试fixture失败掩盖为通过。

### 新增sync验收已完成抽查要求

新增 `host/plugins/sync/ACCEPTANCE.md`（该路径后于2026-11-05授权无损迁入本报告末节）：**16条命令**依v2核入口、分支/边界、错误日志、所有权/运行时；**20条ported原测试**逐项核断言与生产可达。发现R4-SYNC-01–07：平行写者、D3内部整数、维护/日志、SQL阶段/行解码、画像合并替身、导出阻塞、生产入口/fixture与pending闭环。

尤其画像原测试虽在31passed中，TS测试自写merger且将原3/4→5向量换成1/2→3；生产index未注入merger，不能因expect更多签收。其它19条样本原断言保留；纯函数通过不是整插件通过。

当前四插件总体均不通过。旧L23 P04/P08、support S06及未验证组不因本轮扩签。下一精确增量为协调者通知的P04正式main `4c6cd1ba8`/`b7e140795` 解码修复，只核变化子项；numericSize/首块u64 API/f32进度/P08仍单列，owner 775passed不作为独立通过。

## P04正式main增量闭环与L20b后续交接

P04固定 `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`（b7e140795祖先exit0），原样快照 `/tmp/opencode/R4-P04-main-4c6c-HjJFPR`。仅两个新作业，均已取result：

| 作业 | 原结果 | 独立判定 |
|---|---|---|
| 20261104113403-cfe2f1 | exit0，4passed/10标题过滤skip，无Errors | 未知extension内重复、已知字段重复、__proto__必填隔离、boolean实际值/位置及嵌套缺字段位置的新定向断言通过 |
| 20261104113432-5aae59 | exit0的捕获打印观察，无Errors | 顶层未知重复接受正确；emoji列59≠57、-0误接受、类型错误被trailing覆盖、duplicate被第二值语法错误覆盖，P04仍未闭合 |

P04仅未知字段/必填和两类ASCII错误位置子项在正式main勾选。原serde_json1.0.149/serde_derive1.0.228源码已只读核实错误顺序、负零及字节column，具体URL/行与原输出记L23 ACCEPTANCE §13。首块numericSize→Number/F4 objectLen:number仍未修；续传manifest.size的BigInt保留是进展，不将旧Number(version.size)行号继续套新树。f32/Docker/P08不随本次关闭；不重跑775全套。

P06可见性纠偏：eeaf/4c6c正式F4已有dataSpaceDeviceId，本轮真实F4+L11组合确实消费；旧“main没有身份API”仅属679fd历史，不再列为当前P08统一阻塞。不重复既有P06五场景。

L20b新交接 `4c15a5c8e6fec556632acd93c3ff8e7de2c05fca` / `301ab4267935a79b2d1a82e8d3d5d6432fb9c236` 已审源码增量：相对82d无生产实现变化，宿主补dataSpaceDeviceId，另更新说明。亲取实现者既有 **20261104112222-1c0a5d**：13files=12passed/1failed，114passed/2failed，exit1，无额外Unhandled Errors；两条prepare前缀失败没有被排除门禁。未重跑。上述候选均非固定main4c6c祖先，S03负数/默认hook新main反例不被候选正向绿覆盖；S05除F3 phase还有首step分类算法未改，S06真实busy握手继续pending。

新增sync补审与eeaf主链证据已提交 `e4170ddf3`；本单元继续只改授权ACCEPTANCE/聚合审计，未改实现、测试、SPEC、TESTMAP或审批。所有本轮独立排队作业结果已取回，没有待重复提交的作业。

## B04/B11正式main下一最小闭环（4c6cd1ba8）

依C2后续指令，先比对实现：当前main仍4c6cd1ba8，backup相对eeaf无差异，但相对首次f23确已修B04/B11，且这些特定分支此前未独立运行。仅补未签部分，没有重跑已签B01/B02/B03/B08/B09，也暂停相同S05/P04旧失败。

- **20261104115609-eaa58a**：固定main原样acceptance-fixes，仅过滤`B04 |B11 `，**5passed/14过滤skip、exit0、无Failed/Unhandled Errors**。includeAssets partial必须失败、全非法assetTypes回默认、缺备份中文、删除FileNotFound前缀、目标路径非目录拒绝均通过。
- **20261104115805-ab41d2**：真实StorageServiceImpl + kernel invoke双错误探针。audit维护与status非法并存时先报“获取审计数据库连接失败”，前段两个断言通过；备份根为普通文件时空间检查裸报ENOTDIR，缺Rust“获取备份列表失败:”前缀，末段AssertionError，**原exit1**。完整日志保留，未删失败或重跑求绿。
- **签收**：B04原两项main闭环；B11审计优先级、缺备份、删除前缀、目标is_dir/canonicalize原子项已修，但上述新上下文缺口使B11总框仍未勾选。
- **B10源码逐点**：list/delete错误、getBackupList坏manifest、取消结果、pending迁移/健康依赖及非法转换日志已补；verify/restore的findBackup仍使用no-op默认warn，空间检查IO error/汇总info和两个开始info缺失。旧process.emitWarning副本已删除，不再用旧行号当现状；仍不整体签收，详backup ACCEPTANCE §11映射表。

当前backup为B01/B04/B08三个整组签收，余八组未闭合。仅改授权两份验收/审计文档；所有新作业已取result，原非零/Errors与替身使用范围均注明。

## §5首次自检的原始失败（316015db1 / main d84e29565）

按架构师新流程，先提交全部审计，再`git merge --no-edit main`形成`316015db14acfb44a8ded007726f8c02211d31b5`，基线`d84e29565f06f233f8ea6787487a5f9a11e17743`，无冲突且相对main只剩5个授权审计文件。运行官方lane-gate，不修改其检查范围；4项经全局队列：

| 作业 | 检查与原结果 |
|---|---|
| 20261104120815-382374 | typecheck exit0 |
| 20261104120815-e6a411 | boundaries exit0，2430files/0violations/167明确suppressed |
| 20261104120815-9879dd | 四插件importable exit0 |
| 20261104120815-df2e91 | 四插件tests **exit1**；22failed/113passed/1skipped files；36failed/1420passed/187skipped tests；Failed Suites10、Failed Tests36，无额外Unhandled Errors |

主因是L20旧宿主缺dataSpaceDeviceId，部分afterAll另报未初始化dispose；另L23 `w69_ten_thousand_tiny_records`耗时30577ms超过30000ms，原失败保留，不由计时一项推断业务不变量坏。selfgate记录`ok:false, failed:[tests]`，没有签收整分支。完整原日志均在`/home/dsdev/.oc-jobs/done/<id>.log`。

## L20 f53290429及后继候选最小增量（2ed5f1491）

固定候选`2ed5f1491fc5ba05ee714c96df5b214adff31645`（含f53290429），main可见性固定`44b66353c42a80e3769aceaefec29226f66697b2`；两者非祖先关系，候选通过不等于main签收。实现归属：history早返回`112ca0bc6`（f532本身仅报告）；fixture `7775325d9`；max `c0c2e5843`；维护`4accc4cf6`/测试`9638468aa`；SQL阶段/ID `94e4fcb2b`/回归`b9d2d0de3`。未重做eeaf七组全审，完整最新结论、范围与原stdout已写sync ACCEPTANCE §5。

| 作业 | 结果及独立边界 |
|---|---|
| 20261104130700-1f88b4 | 3个新增文件最小集：13passed/1failed、exit1。03维护日志3/3、04坏行/prepare-bind-step6/6、02 max/分页/隔离ID通过；echo旧用户日志误标失败 |
| 20261104130739-f91838 | 只选五条note默认hook/精度/事务，**Failed Suite1、no tests、exit1**；依赖SkillsExecutor静态name在Vitest转换后赋值只读属性，未到业务断言 |
| 20261104130934-9eb153 | 同一候选原生Node真实kernel/F4/F3/owner/default sync：无history仍成功且readerCalls0、正CAS真实写回9007199254740994；断言全部过，exit0 |
| 20261104131323-c945a6 | 原生Node仅补未执行的owner同tx回滚：真实updateInferredFormat先执行再注入故障，原content恢复before、history1→1、tx非外部handle，断言全部过，exit0 |

两个非零Vitest作业无额外Unhandled Errors，原失败不隐藏。原生Node通过说明不能把Vitest转换兼容阻塞误报为该业务链必然运行失败，但不覆盖原测试收集exit1。

**新未决反例R4-SYNC-02**：`apply-refcounts.ts:65-68`仍将MAX(change_log.id)转Number；旧用户ID9007199254740993的sync_version原0被错误改成1793797633。Rust `mod.rs:7104-7134,7287-7292`用i64阈值，原`:17831-17840`明确保留旧用户日志。仅把suppressEchoChangeLog参数注解改bigint无效。owner负CAS实现无变化，未重复旧失败。

**候选进展**：01笔记hook所有者链、03、04的上述范围验证通过，仍等main；通用业务表SQL尚在，不关闭01整组。05画像原测试已如实退pending，保留supplemental但无真实owner；06增加8KiB缓冲写仍无worker；不拿替身或缓冲写代替正式功能。L23等待实际消费新F4 JsonReader再复验，B04/B11已签子项未重跑。

**范围门禁阻塞**：集成拒绝`host/plugins/sync/ACCEPTANCE.md`，已核旧dispatch R4表和`scripts/electron-migration/lib/lane-paths.mjs:37`仍只列原三插件，未同步架构师v2新增sync补审授权。保持报告与原finding，不越权修改白名单。请协调者将该精确路径加入R4允许范围；这类拒绝不能靠重新跑测试修复。**2026-11-05处置**：按用户明确授权，将该文件相对main的全部R4自有内容无损迁入本报告末节，并仅撤销本lane自己新增的越界文件；白名单仍未改。

## 自动续派：新增修复最小复验与main单写者接缝

先执行`git merge --no-edit main`，得到`09a94a65935cdd8e3f61ea142fb0c42897345779`，固定main `16a254adfb53d24b971d27b2a7f34bf899d2bec7`。发现门禁工具有新增main基线判定，按要求运行一次lane-gate；同时只读对照各owner新SHA，以下只验证真正变化的分支。

| finding | 修复/固定树 | 本轮证据与状态 |
|---|---|---|
| R4-SYNC-02 echo | 修复476d0d463，候选205380d59 | **20261104134904-f722fb**：只重验上一轮失败的production echo，1passed/4过滤skip、exit0；MAX(log.id)已bigint直传，旧用户日志保留0。候选未main，原1f88b4 exit1保留 |
| S05 prepare/step | 修复cae04c341，候选3b7a8aa14 | **20261104135131-38b468**：原生Node真实syncSupport/F3，两个缺表prepare、游标首次/后续step、设备轮换首次step，5条精确错误断言全部通过、exit0。删除produced猜阶段为正确新修复；未main，S06不联动关闭 |
| B10/B11新增上下文/日志 | 2272e79d8实现，3f10668bd记录/测试；候选090d225cb | **20261104135156-ee95cb**：7passed/25过滤skip、exit0；三个验证/恢复warn入口、取消请求、健康开始、空间info及列表IO前缀/error。未重复B04/B11已签子项；候选未main |
| B05 VFS所有者 | main已含dac4927af | 复用既有**20261104132355-e8e497**中backup-manager19例/restore11例通过的结果，补核真实L11安装、schema-aware落库与完整/legacy组件分支；main VFS单写者子项签收。整个旧作业仍exit1，不篡改。真实syncSupport恢复激活组合仍待 |

三项新作业无额外Errors，完整路径 `/home/dsdev/.oc-jobs/done/<id>.log`。详细源码行、Rust依据和真实/fixture边界分别写入sync §6、support §9、backup §12。所有候选相对固定main16a祖先检查exit1；dac4927af祖先检查exit0。

L23候选2ec5ea3c6虽将json_exact拆为流式serde_struct，但manifest仍import本地serde_struct，尚未消费正式F4 JsonReader；依C2要求暂停P04旧反例运行。本轮不因本地新parser直接签收，也不重跑775全套。

### 两轮自检原结果与“新增”边界

上一轮`e0cb3df79`/main ad11a8394的结果：typecheck **20261104132355-5e712a**、boundaries **-66260d**、importable **-884c14**均exit0；tests **20261104132355-e8e497** exit1，21failed/119passed/1skipped files，35failed/1505passed/187skipped tests，Failed Suites10、Failed Tests35，无额外Unhandled Errors。

本轮`09a94a659`/main16a的官方门禁作业：

| 作业 | 原结果 |
|---|---|
| 20261104134503-fe6019 | typecheck exit0 |
| 20261104134503-7a7d94 | boundaries exit0 |
| 20261104134503-1ea7e0 | importable exit0 |
| 20261104134503-f86f4a | tests **exit1**，21failed/119passed/1skipped files；35failed/1505passed/187skipped tests；Failed Suites10、Failed Tests35，无额外Unhandled Errors |

新门禁将35个main既有用例失败排除，但把10个suite标为“新增”，最终仍`ok:false`。只读调用同一`failedTestKeys`解析上两次原日志：两者都45个失败标识，`newVersusPreviousGate=[]`、`removed=[]`。因此“新增10”仅是相对全量基线收录口径，不是这次审计或merge新引入的10个回归；仍保留门禁失败，不自行改判通过/白名单。

全局实际`/home/dsdev/dev/deep-student/scripts/electron-migration/lib/lane-paths.mjs:37`也仍缺sync/ACCEPTANCE授权。需协调者同步架构师追加范围；剩余实现/fixture修复由owner提交后再复验。**2026-11-05处置**：该越界文件内容已按用户授权无损迁入本报告末节，越界文件已撤销，白名单未改。作为独立验收人不修改实现、测试、SPEC、TESTMAP或门禁配置；当前显然仍有剩余闭环项，不写“无剩余工作”。

## realistic s03收敛交接（b520109b7 / L10 a38068281）

已亲取C2既有作业 **20261104140353-20cbc8**：business25全过、realistic14过/1失败，合计**39passed/1failed、exit1、无额外Errors/skip**。唯一失败是`s03_delete_note_tombstone_sync_propagates`目标deleted_at仍null（原assert:not.toBeNull未改）。这不是R4新运行的独立结果；C2提供基线b520109b7，原输出与归因记sync ACCEPTANCE §7。旧7个同名失败不能当该树现状，原8回归仍由L20闭环，旧观察a9856a的exit0也不作正确性证明。

只读核对L10 `a38068281dddfcaf67a89a92f729216e67b1705b`：updateInferredFormat按Rust `note_history.rs:285-286`使用同conn原SELECT正文，不滤deleted_at；普通getNoteContent未变。固定main `8d7b05d148521c3437619b3e75859e6f4a7c1bcd`尚不含a380或b520（祖先检查均1）。本轮不新增业务测试；主线到位后只复验原s03，不重跑40例、不改测试、不联动关闭R4-SYNC-01/05/06。

## main306签收：S02/S03/S05、B10/B11；新pending metadata候选

自动续派先合main至`d5a50907b4b5074ea8cb27b3faded99515e94971`，固定main `306eb8bbbe74ad8f225da9313d24dd8eb0a8ef40`。核实此前候选3f10668bd、cae04c341及notes负CAS修复7a6783fdb已main，而L20 b520/c1e4与软删正文修复a380仍非祖先。

### 主线闭环（复用已有独立作业，不重复已过集合）

复用**20261104142355-6832bc**（固定main8d7b05d14；相关插件/测试相对306无差异）原结果：

- backup acceptance-fixes **32/32**，包含此前B10/B11新增的7条；源实现与已审090d候选无差异。因此**B10按原枚举日志漏项、B11按已记录错误顺序/上下文整组main签收**，历史§11根目录ENOTDIR原exit1保留。
- support pomodoro **9/9**，原六条apply真正调用公开sync；与82d已核原断言无差异，**S02 main签收**。
- support state-errors **13/13**，prepare/首次及后续step分类已修，**S05 main签收**，不带S06 busy握手。
- support JSON **5/5**、INTEGER **6/6**、owner事务 **3/3**通过。再仅补新7a6783fdb的旧负CAS反例：**20261104144646-f3d9a4**，原样main306快照，真实support→notes owner返回`-9007199254740993 bigint`且strict equal通过、exit0；因此**S03就support/notes owner原反例main签收**。

整个门禁作业仍因L20其它suite而exit1，没有把局部通过改写为整作业全绿。L20旧本地hook/field merge/echo等D3消费链继续列R4-SYNC-02；小写realistic s03删除传播是另一测试，仍待a380主线，不被本次S03精度签收覆盖。S04整链单写者与S01笔记生产覆盖不因support函数级通过关闭。

最新未决组：backup剩B02/B03/B05/B06/B07/B09六组；support剩S01/S04/S06三组；sync七组主线仍有未决；L23 P04/P08继续未决。主线TESTMAP逐行状态：support34ported/6pending，backup313ported/10pending，sync211ported/47pending/5obsolete，providers637ported/221pending/1obsolete。账本数量本身不授予B。

### 新候选：pending日志元数据无损读取→enrich→ack

固定L20 **c1e4e70f12ea4ebfa093c03cf1d55e673166ea80**，修复标记e408548ff、实际代码aab3cd060。相对b520确有getPendingChanges启用safeIntegers、field_deltas_json使用lossless、API内部ID允许bigint的增量。只提交**20261104144742-d7a5e6**：新增`pending metadata stays exact`用例 **1passed/5过滤skip、exit0、无Errors**，通过正式服务读取相邻ID、enrich保留大整数及REAL字面量、只确认higher且lower仍pending。详sync ACCEPTANCE §8；未main，不能替整个R4-SYNC-02关闭。

### 自检原失败与实际协调反馈

本轮官方自检：typecheck **20261104144254-006acf**、boundaries **-cb0916**、importable **-d79402**均exit0；tests **20261104144254-14617c** exit1，21failed/120passed/1skipped files，35failed/1523passed/187skipped tests，Failed Suites10/Failed Tests35，无额外Unhandled Errors。与142355原日志的45个failedTestKeys完全相同（added/removed空），保留官方“相对全量基线新增10项”判定，未自行改绿。

已通过正式协调信箱`coord.mjs queue C2-platform - --from R4-review-sync`实际投递两项阻塞：①架构师追加sync验收授权尚未同步到全局lane-paths.mjs:37；②10个suite未被全量基线归类，但与多轮已知失败相同。只发普通排队消息，未打断/重启任何会话，未改调度状态或门禁白名单。等待协调者修配置、owner把实际消费修复合main；本lane继续只写授权审计文档，不以改实现/测试绕过独立复核角色。

## s03依赖解锁后的真实消费复验与归档配置纠偏

固定main`5f5c750a7f8c373d3c5abd7a76e505ca73d95297`发现L10软删正文修复已以**7df6fff90c5439ad816993ddbc9902a4f9d35a30**进入main（a38068281 cherry-pick，生产sync.ts无差异）。不能因原a380不是祖先而继续称修复未main。

固定L20 **016f9bbee6e52b5c3aef40f8dea719382bfd7849**自然包含正式7df，只验证原realistic s03，不人工替换owner目录、不改原测试/fixture。相对b520原s03文件与harness无变化；Rust `sync_realistic_scenarios.rs:879-899`的deleted_at非空且非空串断言完整保留，真实两设备F3迁移库经公开getPending/enrich/apply传输。

| 作业 | 原结果与归因 |
|---|---|
| 20261104153107-70d2d6 | 初次归档遗漏tsconfig，SkillsExecutor.name收集失败，Failed Suite1/no tests、exit1；不是s03业务断言失败 |
| 20261104153914-22be3e | 同016f补原SHA配置后只跑原s03，**1passed/14过滤skip、exit0** |
| 20261104153914-f36472 | 旧2ed归档同样补配置，仅补跑130739-f91838从未执行到的五条hook/精度/事务，**5passed/10过滤skip、exit0** |

**归因更正**：原tsconfig.json包含ES2022/useDefineForClassFields=true；漏归档时Vitest把静态字段转成`this.name=...`触碰只读函数name。分别从016f/2ed补齐原tsconfig.json、tsconfig.host.json、tsconfig.node.json后，同代码/同测试的收集问题消失。原项目配置、实现、测试都未改。撤回“需依赖方解决SkillsExecutor”的归因，旧130739及153107原exit1仍保留为复核环境失败。主线工作树门禁以及Node原生探针不受此问题影响。

两个纠偏作业均无Failed/Unhandled Errors，完整命令/输出在`/home/dsdev/.oc-jobs/done/<id>.log`；不将不同树的旧39pass+新1pass拼成单作业40全绿。**L10供方已main、s03在L20真实候选消费树通过**；016f和b520仍非固定main5f5祖先，整个L20主线闭环及01/05/06其它项不连带签收。原8回归最终责任仍L20。

已通过coord信箱实际发送归档纠偏预告和最终通过结果给C2；并上报架构师范围白名单遗漏，记录`2026-11-04T153639859Z-R4-review-sync.md`。本轮没有修改调度配置或为测试求绿改变合法类字段。

P04源码可见性另校正：本地流式serde_struct已main，但还没有F4 JsonReader消费；因此按C2指令暂不运行四个旧反例、不把4c6c旧失败直接描述为新解析器现状。内部numericSize仍在password_proof.ts:113/122/132/147转Number，P04/P08维持待闭环。

### 本轮自检过程（不覆盖业务复验）

main在合并后又推进，两次lane-gate前置检查exit2，均未提交测试；随后在同一串行命令中merge main并启动gate，固定tip60ac224f3/base4525e11ac后正式执行。typecheck **20261104152843-f716b5**、boundaries **-1396b5**、importable **-ac04ea**均exit0；tests **20261104152843-3bc441** exit1：21failed/120passed/1skipped files，35failed/1523passed/187skipped tests。45个失败标识与150552-6aa602完全相同，added/removed均空。官方仍报相对基线新增10个suite，保留原失败状态；此真实工作树的paths fixture问题与归档配置遗漏是两件事。

## L20进入main后的正式签收与07新fixture反例（677f6727c）

固定main **677f6727c691ac3a2b33ca4c0a9b637476d0feb9**，L20 016f、echo及metadata修复均已进入，`git diff 016f main -- host/plugins/sync`为空。已在R4分支ceb5c77be执行官方gate，本次是真正原exit0：

| 作业 | 原结果 |
|---|---|
| 20261104161615-cbc5bf | typecheck exit0 |
| 20261104161616-0f65b3 | boundaries exit0 |
| 20261104161616-22fdd4 | importable exit0 |
| **20261104161616-fddb22** | **tests原exit0**，147passed/1skipped files，1758passed/20skipped tests，无Failed/Unhandled Errors；不是judgeAgainstBaseline豁免 |

按原输出文件计：backup25文件400例、support13文件117例、sync52文件425例、providers57文件816例通过；另外20skip全部是providers的Docker契约suite。旧45个main失败现已消失，不再列为当前运行阻塞；旧各次exit1仍保留。

### 明确签收范围

- **R4-SYNC-02主线签收原整数反例范围**：main integer-internal6/6（max、落库、echo、分页、隔离ID、pending/enrich/ack）通过；负CAS已由此前main306探针签收；只补原main完整默认apply CAS反例 **20261104162815-5c7d94**，在原样main677快照（包含原tsconfig）经真实F4/F3迁移及notes/vfs-repos/support/sync，严格断言success1/failure0、写回9007199254740994n，exit0。
- **R4-SYNC-03主线签收**：maintenance-order3/3，维护拒绝与info顺序/最终统计都经kernel验证。
- **R4-SYNC-04主线签收**：query-decoding6/6，原隔离/冲突/retry-all的prepare/bind/step、严格列类型、flatten均闭环；不外推其它未审查询。
- **原s03删除传播主线复验通过**：main realistic_scenarios15/15含原s03，与016f已经核验的代码/断言相同；不重复business25或再跑s03。
- 01笔记专用hook的默认reader/owner已main，旧本地业务副本消除；仍有apply-record/refcounts及本地__sync_conflicts平行写者，01总框不关。05真实画像owner、06worker仍待；07宿主/注册已修（24条），但完整性/测试语义仍未闭合。

### 07内新增静态测试真实性反例

逐行对照Rust五条note_history原用例，main `tests/note-history.test.ts:308-333`的direct_remote_resource_update在源库createNote/手动snapshot，并两次回放到同一handle；Rust `note_history.rs:417-467`明确使用独立source/target、在target应用/查询。Rust payloads`:408-409`抑制回声，目标没有该源端已有pending；TS源库的既有pending被正确保留，所走分支不同。一个错误地只在本地pending时作resource前快照的实现可漏过当前同源fixture，而原target场景能检出。

这不是指控当前实现必然丢快照，当前apply-record:433确有快照调用；问题是15绿不能证明该原场景等价。其余四个原用例的目标库角色、CAS1/1/2/2、pin/Delete、future格式失败/目标空库、before/after/restoreCopy及immutable冲突断言已核。具体逐项表写sync ACCEPTANCE §10。

C2已亲读确认此fixture偏差，保留在**原R4-SYNC-07**内交架构的parked L20接管者，R4不向L20追加任务、不改测试、不动原s03/8回归。support S01因此保留原测试完整性待办；S04保留通用写者、S06 busy握手仍未闭合。当前sync为02/03/04三组签收，01/05/06/07四组未决；四插件总体仍不通过。

主线TESTMAP当前：sync212ported/46pending/5obsolete，support34ported/6pending，backup313ported/10pending，providers637ported/221pending/1obsolete。全套绿不覆盖这些pending与架构问题。范围白名单缺口继续沿已上报申请处理。

## 677f全绿后的新集成回归：retention Slot与worker宿主契约

最新失败**不是旧45个paths失败**。tip e4d8616b1/main **fb463060d162d6c261ebb731180bcfaa833e95a2**的官方门禁：typecheck165954-6a2573、boundaries165954-255bb5、importable165954-c829d5均exit0；tests **20261104165954-fab2ca**原exit1，11failed/136passed/1skipped files，64failed/1694passed/20Docker skip，无额外Unhandled Errors。

逐FAIL块归类：**62个SlotOccupied**（61个support初始化失败、1个L20 relation第二Host安装失败），另**b04大型inline数据30000ms超时**、**w69 40666ms超过30000ms断言**各一项。两项耗时单列，未改阈值、未推断为无害噪声；没有重跑整个64例。

源码链：F3 **91cdc7d61**将retention注册从`??=`改为F1 Slot.provide返回Disposer；main fb463的L10 wrapper仍返回void并丢弃guard，index直接调用。Rust storage/file_deletion_queue.rs:29-38允许原语返回SlotOccupied；真正消费方vfs/repos/note_revision_repo.rs:522-528却是**if let Ok(disposer){scope.add(disposer)}**。不能把低层Slot拒重复说成原语错误，也不能忽略高层成功guard的Scope或原来的重复处理。

| 作业 | 固定树/范围 | 原结果与边界 |
|---|---|---|
| **20261104172008-b2036f** | 原样fb463，真实notes/vfs/support first.install→first.dispose→second.install | 第二次SlotOccupied，**exit1**；原生Node，不是归档tsconfig问题 |
| **20261104173312-2fabc7** | 明确组合fb463 + notes候选4d363afa4，同kernel真实StorageService/createPaths | 顺序重装返回；保持第二Host活跃再装第三Host在registerDeletionJournal冲突，**整体exit1**，不称候选全修 |
| **20261104174905-f091b7** | 审计期间新main **7f4fb688b6a9f2929b671432c2b7c1ce5dd292b7**，真实F3两个顺序宿主 | 每次安装后assert.ok(ctx.notes)、完整dispose均成功，**exit0**；notes的disposer消费已正式进入main，不能继续套旧fb描述 |
| **20261104175042-bd0522** | 同7f4 main现有support service-host首次安装 | **exit1**，`TypeError ctx.storage.registerMaintenanceParticipant is not a function`；旧小型storage facade不满足新notes worker实际使用的正式接口，业务断言尚未执行 |

7f4的notes index/asset-retention与4d候选完全相同，ctx.effect立即持有释放两个注册，顺序生命周期已改善；多Host的journal Slot冲突及retention高层策略还需协调，现有notes候选测试甚至把retention预占用时安装失败作为期望，不能不对照Rust调用方就签收。

原677f的算法修复签收按其SHA保留，但当前宿主组合不可用；62个安装栈不等于62个整数/codec/状态算法回退。L20 relation用例已过前段CAS断言后才到第二Host失败，不能将它也称为no-tests。详sync ACCEPTANCE §11与support S01最新阻塞。

已实际向C2分次投递root cause、候选/新main结果，请其协调F3/L10/L20b；未向parked L20新增任务，未修改实现、测试、门禁或添加optional/no-op worker fallback。所有原非零、成功子阶段及完整脚本保存在`/home/dsdev/.oc-jobs/done/<job-id>.log`。

## 新主线123例支撑恢复、S01签收与两项耗时诊断

门禁base **01c074ecfb2fa79ae5db30add1a04c4abe48943d** / tip74c4a7f78：typecheck181546-62cf65、boundaries181546-88361c、importable181546-7414a8均exit0；tests **20261104181546-28458e**原exit1，146passed/3failed/1skipped files，1772passed/3failed/20Docker skip，无额外Unhandled Errors。剩余仅L20 relation第二Host的journal Slot冲突、providers b04超时、w69=43180ms。旧support62个初始化失败已消失，不能继续用旧fb463结果描述新主线。

### S01真实五场景已main闭环

support本轮14文件123例全通过，其中新增 **note-history-apply.test.ts 5/5**。只读对照Rust `note_history.rs:393-731`后，确认这个文件用一个正式应用owner、两个独立实际迁移库、公开pending/enrich/default apply；source/target角色和全部原断言保留，call-through spy还验证reader/writer同tx。`4f3fbbd83`的fixture不再重复安装全局owner，`7b5ca5178`的service-host实际委托F3 maintenance registry与app目录，没有no-op注册。

因此**S01按本插件实际消费和原五测试范围主线签收**，详support ACCEPTANCE §11；本表已39ported/1pending，S06 busy握手仍不关闭，S04通用跨表写者仍未闭合。L20全局TESTMAP:204-208仍引用其旧note-history文件，旧同源fixture/第二Host冲突没有消失，继续按原R4-SYNC-07交架构接管流程，R4不改TESTMAP或旧测试，也不向parked L20加任务。

### 耗时诊断：原exit均保留，不靠改阈值求绿

固定main **ccba0483745be0bb95cdb1f03c14f6d0994fa41d**（与01c的相关插件/测试无差异），完整配置快照`/tmp/opencode/R4-main-ccba-timing-nXl5kv`。仅两个失败用例：

| 作业 | 原result及执行边界 |
|---|---|
| 20261104184816-a399d8 | 2failed/39过滤skip、exit1；b04默认30000ms超时，w69=36152ms。虽然命令请求maxWorkers1，但runner注入VITEST_MAX_FORKS（默认3），Vitest池设置优先；不能声称此作业单worker |
| 20261104185552-6b22e9 | 显式env MAX/MIN_FORKS=1、MAX/MIN_THREADS=1，仍用原测试/阈值；b04在28554ms通过，w69=31882ms仍失败；1passed/1failed/39过滤skip、exit1，无额外Errors |

不改全局runner，仅修正这个诊断作业的并发环境；单fork不等于机器无其它负载。停止重复，窄集b04通过不覆盖整门禁超时。

源码核对发现两个性能要求不能混用：Rust b04（`sync_real_business_tables_tests.rs:417-460`）无30秒断言，且本地原4MB x被TS通用resource helper的`{}`替代；最终5MB/y两个断言保留。Rust W69（`sync_weird_tests.rs:2114-2142`）确有Instant测得as_secs<30；TS保留30秒断言但改Date.now，且Rust new_db(:16-17)内存库变成TS newDb文件库。记录P08原fixture/测量差异，请协调统一处理，未擅自改原8回归或放宽真实性能不变量。详细原输出与源码见providers ACCEPTANCE §14。

P04旧ASCII子项另收窄说明：chrono0.4.41 DateTimeVisitor的expecting是RFC3339专用文本，不是普通a string；旧签收仅限false实际值和字节结束位置。当前流式源码已采用正确标签，继续等F4 JsonReader实际消费后按原反例复验，没有新增P04测试或扩大签收。

### 本轮落盘状态

S01已在support ACCEPTANCE §11勾选，依据是独立逐行审读+本会话已跑主线5/5，而不是owner REPORT自述。S01/S02/S03/S05四组按各自已记录范围完成主线闭环，S04/S06两组仍开；global L20旧TESTMAP引用和旧fixture问题保留R4-SYNC-07，未自行改账本。main01c与后继ccba的support/notes/sync文件无差异，故复用181546结果而不重复五场景。

性能窄集的有效运行环境已明确：第一条184816虽请求maxWorkers1，实际受pool环境覆盖；第二条185552通过env显式限制该作业进程为单fork后仍有W69失败，停止追加重复运行。两个原exit1及整门禁3failed都保留。未将b04的窄集通过写成完整原Rust fixture通过，未删除W69的30秒原断言，未把机器负载猜测当证据。

## b04原fixture主线签收、B06依赖单元修复与剩余假聚合（74252e624）

自动续派先合main，固定 **74252e62407fe2a607693d9195d4068b6cd64bbd**。本轮没有新增手工测试作业；官方gate已覆盖变化文件，其他未变已签用例不另行排队。

### P08 / b04子项

当前`business_tables_sync.test.ts:226-265`已恢复Rust `sync_real_business_tables_tests.rs:26-64,417-460`的内存库、原resources/change_log字段与触发器、本地4MiB x→远端5MiB y及原两个最终断言；实际修复c7a197cfc，cd20f3370补说明。仍走正式published apply，原无history表的生产门负责跳过不适用的格式检测，未替换hook、未放宽默认超时。

主线 **20261104195643-18bfdd** 的business文件25/25通过，因此P08这个fixture真实性/运行子项勾选；不再用旧`{}`输入/超时描述新main。它不签完整迁移schema下额外格式检测成本，亦不关闭W69、Docker或整个P08。详providers ACCEPTANCE §15。

### B06 / 三个dependency报告用例

main **a8fc93a40**将三个用例从错误的SchemaRegistry对象改成真实MigrationCoordinator.checkDependencies + CoreMigrationReport；该方法由正式runAll调用。对照Rust migration_tests.rs:885-934及tests.rs:507-556，空report的MigrationError变体/两个ID，以及20260203/count真实集合、20260131/count2两种成功fixture都保留。main同一gate的migrations-metadata19/19通过，签这三个子项。

但同文件的`test_schema_registry_aggregation_after_migration`及`test_schema_registry_dependency_check_passes`仍用空文件+latestOpener的伪造SQL结果，未执行原Rust明确要求的run_all；真实迁移即使完全没执行，预制版本仍能令其通过。B06整体不签，不能用三个unit修复覆盖集成测试真实性，详backup ACCEPTANCE §14。

### 门禁原结果与W69可评估候选

tip **965e7746c** / base74252：typecheck **20261104195643-dac99f**、boundaries **-8e03f0**、importable **-6a97b2**均exit0；tests **20261104195643-18bfdd** **原exit1**，1812passed/2failed/20Docker skip，151passed/2failed/1skipped files，无额外Unhandled Errors。仍失败的是关系第二Host Slot和W69=34985.511698ms。selfgate因两项属main既有失败判ok=true，不能称测试原始全绿。

亲取已有L23诊断**20261104194043-6655ea**，原exit0，无Errors：当前DELETE缺失查询7103.67ms，先record_id筛选4383.61ms，先upper(operation)10210.89ms；三者计划均SCAN，混合大小写/其它表记录/后续UPDATE仍返回同latest。仅交换两个纯等值谓词，保持绑定编号/过滤/排序/LIMIT的候选可进入owner最小验证；没有生产修改，微基准不算W69通过。

已将结果投递C2，并经正式escalation **2026-11-04T203354165Z-R4-review-sync.md**请求架构安排有权限的parked L20接管者；R4/L23不越权改apply-record.ts，不向L20追加任务，不改原30秒断言。范围白名单仍沿原申请；当前仍有未决项，不写“无剩余工作”。

## B02启动等待签收但外部维护状态实测漏报；B05真实owner闭环（5b1b19055）

固定main **5b1b190553712eaddfee1e862c10f61ab11a55f3**，已完成门禁tip **9e93decc730410a2f70c098434099156ebe2ad4f**。恢复上下文后先核git状态/历史、backup TESTMAP及现成作业账本，未重启已完成检查。详细源码、原断言、证据边界记backup ACCEPTANCE §15。

- **B02启动等待子项签收**：e4b5bbdaa接入正式F2 gate，生产invoke确实先等ready，真实gate fake-clock测试保留119999ms不settle和120000ms精确中文错误。startup-readiness三条在195643-18bfdd及203745-e6de2c均通过，未重复提交。
- **B02外部维护状态反例成立**：已取回先前提交的 **20261104210356-780ffc**，固定main归档`/tmp/opencode/R4-main-5b1-maintenance-b8YbjR`。真实F2已ready，F3外部`enterMaintenance(['mistakes'])`后新借用抛MAINTENANCE，但kernel状态命令输出`is_in_maintenance_mode:false, blocked_components:[], current_operation:null`。断言false!==true、**原exit1**；普通Node探针，无Vitest Errors/skip计数，无额外运行错误；finally释放并dispose。`governance.ts:437-446`只看Operations数组，Rust `commands.rs:440-488`看实际组件状态。沿原B02保留缺口，不另换ID、不把启动等待通过写成整个状态命令等价。
- **B05原所有权finding main签收**：startup-finalizer实际注册入口调用真实syncSupport和paths；原cursor17/legacy键/watermark42经owner事务清理，身份文件及轮换历史、marker/lease清理和重复runner均有真实断言。main两次gate该文件各3/3；TS状态重置→身份落盘→lease commit→marker删除→完成cutover的顺序对齐Rust commands_restore.rs:173-208。结合先前VFS所有者闭环，原B05关闭。测试预置已完成的活动槽切换，不冒称完整F1/bootstrap或全部恢复错误语义验证。

最新门禁 **20261104203745-e6de2c** 原exit1：1812passed/2failed/20Docker skip，151passed/2failed/1skipped files，无额外Unhandled Errors；两失败分别为旧关系第二Host journal SlotOccupied及W69 **38490.490397ms**。typecheck **-d57a1b**、boundaries **-eecbe0**、importable **-73dd05**均exit0。selfgate9e93decc7/base5b1于20:50记录ok=true仅是政策通过，保留原失败与30秒阈值。

当前backup未决缩为 **B02/B03/B06/B07/B09五组**；其它lane的既有P04/P08、S04/S06及sync未决项不因本次局部签收关闭。本轮仅编辑授权审计文档，没有改实现/测试/TESTMAP，也没有运行Rust。

## B06真实registry与B09阶段错误补签；纠正沿用旧源码的状态（90538c240）

本轮先merge main，结果Already up to date；HEAD **139cee6561822dfb55d51f3cf86e1d38b2aa9ffd** 对应已完成selfgate/base **90538c2404a6c479bb91f6c1a6835f8f0e840edb**，无未提交改动。没有为这一步重复提交整套测试。

**审计订正**：主线已含B06 `6d0c885093317367192a7d0c57c1431ead12de32`真实registry测试修复、B09 `1783a548fb860c9cb631db50233e257aa7f7fac3`阶段消费修复；两者也都是上轮5b1祖先。本轮通过源码、git祖先和既有原始日志补核。此前报告继续把latestOpener/无phase描述为主线缺口不准确，现撤回这两个当前状态判断；历史旧树反例与原exit不删除。

- **B06四个子项main签收**：migrations-metadata:29-48真实F3 worker runAll成功后读取实际SQLite迁移历史，再调用生产aggregateSchemaRegistry。Rust migration_tests.rs:1148-1214/tests.rs:696-755四个聚合/依赖用例的前置、4库/正版本/真实迁移集合latest/依赖成功均保留。211150-fa2d6b该文件19/19通过。原空文件+latestOpener已删除；B06仍有初始化报告/策略副本等缺口。
- **B09原finding main签收**：F3物理prepare/bind/iterator执行边界提供phase，L21首next catch按prepare→准备、bind→执行、execute→读取映射，收尾仍先return再close。实际不唯一父键的FK mismatch生产入口回归精确得到“准备失败”而非“读取失败”，211150-fa2d6b该例575ms通过、acceptance-fixes35/35，原只读/5秒timeout与孤儿FK收尾回归亦通过。其余分类按源码核对，未把代码审读冒称三类故障实跑，也不虚构无参数PRAGMA的绑定反例。
- **L21初始化新候选另记**：只读930fac664（428211444说明）三个初始化用例已走真实F3插件生命周期，原输入/断言对照无弱化；亲取Node **20261104210258-0b127b** / Electron **-224e82** 各3passed/89过滤skip、exit0、无Errors。审计记录/新库pending-count **20261104202728-944320** 也是3passed/89过滤skip、exit0。均属owner现成候选证据，尚未main，不恢复旧初始化pending或全组签收。

复用门禁 **20261104211150-fa2d6b**：原exit1，1812passed/2failed/20Docker skip、151passed/2failed/1skipped files，无额外Unhandled Errors；旧关系第二Host SlotOccupied与W69 **39563.847364ms**仍失败。typecheck **-e280a1**、boundaries **-24d832**、importable **-14aa89**均exit0，政策ok=true不等于原测试全绿。详细证据见backup ACCEPTANCE §16。

当前backup原finding未决 **B02/B03/B06/B07四组**。本轮只更新授权文档；B02独立外部状态漏报反例仍成立，B03跨进程锁、P04正式decoder消费、P08/W69、S04/S06与sync未决继续保留。

## 新main源码增量：租约纳秒、事件u64及真实初始化（9b3c18601）

先合并固定main **9b3c18601f674826479ed0e7f6ac7d13edca2b70**，得到 **c242be19a6b4c00ab26ddafbf5735e71b47f222d**，工作区干净；已启动官方lane-gate，结果待通知。本节记录独立源码审查和已完成旧作业，不把正在运行的检查预写为通过。

- **P04首块旧状态订正/子项签收**：37a441513早已让三个F4首块API直接接收version.size bigint，F4内部长度/末块判断精确，仅有界分块分配转换number。真实F4密文前缀+生产manager的9007199254740993n回归在既有main212749-278ab2中随sync_manager33/33通过，相关实现/测试与新main无差异。原numericSize缺口不能再描述为当前代码。详providers ACCEPTANCE §16；lstat尺寸与正式JsonReader消费不据此扩签。
- **P04租约新源码**：45843cf78/f5a6768bd/dedc94240改为F4纳秒创建/续租/排序/到期/fallback/held文本；28f5173c4统一Rust trim。两新文件分别14条，对应Rust同毫秒先比较真实时间、等时UUID、到期边界、损坏对象fallback及holder合法性/自持判定。亲取owner纳秒修前20261104202337-f23627为8failed/exit1，修后20261104203016-212292为五文件48passed/exit0，无skip/额外Errors。实际main新增用例结果待本轮gate，不能泛签整个P04或sync消费者。
- **S03事件JSON**：70605832e将上传回验/下载两处JSON.parse改为公开parseJsonLossless，仍保留字段/hash/key/水位校验。亲取有效修前20261104200941-f251ff两条失败/exit1，修后20261104201022-5d0c16两条通过/exit0，无skip/额外Errors；早期错kind/version/import的失败不混成有效生产反例。大奇数seq/size实际通过已安装服务，不替换state或解析器。详support ACCEPTANCE §12，main运行待gate。
- **B06已审候选实际入main**：d25ccf1d7/5e27abda5等代码经674d65cde合入；与930fac664相比测试逻辑/断言相同，仅三段说明不同。实际F3安装/重装替代三个本地初始化用例；剩两个本地报告、两个策略用例依旧，正式main运行待gate。详backup ACCEPTANCE §17。

本轮无Rust运行，无实现/测试/TESTMAP修改；没有再排旧decoder、Slot、W69或已完成精度窄集。范围白名单仍未包含已获架构授权的sync/ACCEPTANCE.md，原升级记录保留（该文件已于2026-11-05按授权无损迁入本报告末节，白名单未改）。

### c242主线运行回执与局部签收

已取回官方 **20261104220300-b694ec**：lease_time14/14、lease_holder14/14、event-json-precision2/2，以及migration-behavior92/92均通过，无这些文件skip。后者两条真实初始化后pending-count用例4992/3898ms，跨初始化资源保留6584ms。由此将上节待运行项转为main签收：P04租约纳秒/holder、S03事件JSON，以及B06三个真实初始化和实际审计save/query子项。各组原未决范围、正式JsonReader阻塞、两个报告/两个策略替身及原pending继续保留。

完整作业仍**原exit1**，1842passed/2failed/20Docker skip、154passed/2failed/1skipped files，无额外Unhandled Errors；旧关系第二Host SlotOccupied和W69 **38593.657126ms > 30000**未修。typecheck **20261104220300-7fc4a5**、boundaries **-9c02bf**、importable **-164155**均exit0；selfgate tipc242/base9b3政策ok=true。源码记录已保存89c3717fa/336f76620，本次只补真实运行签收，不重复提交已完成窄集。

## C2三文件限定复核：650dd新增维护参与者fixture红项（c6309183c）

依最新C2指令，不重跑1842全集、不改白名单/不移动sync验收。本轮合main **c6309183c4cddc06b3647530f3306f7906f2295b** → HEAD **731efa7fab09c5f1706ef90e0dcca634dad27d56**，只核backup-manager/restore/zip-integration三个受影响测试文件及其B05接缝。实现修复 **ecff332205b70e292a24d31609f05c0208e3ebc2** 已main，三个文件相对该提交无差异。

亲取fulltest/latest.json：head **650ddffbef3c755dce9fc3b3eb2fe5502bf72382** / at23:26:51.932Z，四例均在L11 index.ts:172→installVfsRestoreOwner因`registerMaintenanceParticipant is not a function`失败，384.83–471.91ms，非timeout；原聚合success=false/11966passed/32failed/79pending保留，JSON未提供进程exit/Errors时不补造。

ecff将四例装配换为完整真实StorageServiceImpl，卸载host后dispose，保留L11参与者pause/drain/resume和正式vfsMaintenance恢复重置；原资源/索引重置、legacy/完整组件、恢复候选槽与lease、ZIP数据等全部断言及60s/120s预算无变化。详backup ACCEPTANCE §18。

已亲取owner既有Electron **20261104233518-7302dd**：4passed/38过滤skip、exit0；Node **-5a602c**：27文件437passed/0skip、exit0，均无额外Errors/Unhandled Errors，不重复owner目录运行。本轮唯一新增作业 **20261105003031-628a63** 在R4实际main运行三文件四原红项：**4passed/38标题过滤skip、3文件通过、exit0**，无Errors/Unhandled Errors；耗时2787/1797/21717/22704ms。四个fixture红项闭环，B05维持原限定签收，所有其它父组/原Slot/W69未决保留。

当前lane-gate无过滤参数，会按验收路径重跑四插件全目录，与C2限定相冲突；已queue C2请求明确限定自检方式，暂未启动广域gate，也未改脚本或伪造selfgate。窄集通过不写成新HEAD全门禁通过。其它审计/实现增量本轮不借机扩审，按C2接管/签收安排继续。

**C2门禁口径已澄清**：三文件限定仅约束额外手工专项，不豁免standard-v2 §5最终官方gate；接受64e4e8456/c630四例闭环，ecff已main，不再派L21重做。按此澄清补记并提交、合main后运行一次现有lane-gate，不另排专项、不改白名单或selfgate。上段暂缓状态仅保留历史，工具范围问题由架构处理。

## a968 relation原Slot子项复核与规定gate真实新增红灯

固定main **a9683a43b8b9001e5c73fea04cc1263fb35401b6**，受测tip **d8967449780aec6e23fb3586c194c8a050f14317**。按C2要求复用唯一正在运行的规定gate，不另排relation或1842专项。

### R4-SYNC-07：仅第二Host Slot子项闭环

Rust `note_history.rs:471-533`原例本身使用独立source/target连接，最后直接`NoteRelationRepo::get(&target_conn,None,"relation")`检查两个reference字段，不经IPC。TS `note-history.test.ts:33-39,335-381`保留实际迁移的独立目标库；getPending/enrich/apply仍由已安装公开sync服务执行，目标的1/1/2/2 CAS、未虚构missing-target资源以及两个reference=true断言完整。

a968仅把并存第二notesHost换为实际`noteRelationRepository.get(target.handle,target.storage.database('mistakes'),'relation')`。这正是`notes/index.ts:345-347`的生产查询；仓储`:158-160`真实读目标关系，`:64-114`读目标resources等来计算reference。成功whole locator不访问Anki连接，因此Rust None与TS target mistakes不改变此例被测结果。确实不再走kernel wire转换/notes错误包装，但原Rust此例不验证这两项，未见绕过原业务不变量。

新私import仅获架构test boundary-allow，不是新增公开API。**20261105004819-87e02a**中该relation **20685ms通过**，note-history文件**15/15通过**；原Slot失败在此实际main用例消失，按源码+本例运行完成该子项复核。整作业有下述Errors1，不能宣称全文件/全链无任何运行风险或完整门禁通过。

**07父组继续开放**：direct_remote_resource_update仍在`:307-333`源库handle()回放并提前snapshot，未恢复Rust`:417-467`独立target场景；原覆盖反证及TESTMAP问题不删除。sync/ACCEPTANCE白名单仍缺；该文件已于2026-11-05按授权无损迁入授权总审计末节并撤销越界文件，未越权改白名单。

### 规定gate原结果：政策也失败

**20261105004819-87e02a原exit1**，1916passed/2failed/20Docker skip，156passed/2failed/1skipped files，**Failed Suites1、Errors1**。新增S108 test timed out180000ms（184280ms）及同stress文件afterAll h.dispose hook timed out10000ms；未处理错误为`[vitest-worker]: Timeout calling "onTaskUpdate"`。W69仍47523.31812900001ms，30秒断言原样。selfgate于01:09:16.167Z记录ok=false/failed=[tests]，不是既有失败豁免绿。

typecheck **04819-f9aee7**、boundaries **-2c3eac**、importable **-09fd22**均exit0。压力测试/harness在9b3→a968无变化，日志尚不能确定迁移、apply、卸载或调度何者为根因；不凭无源码变化断言是机器负载，不把RPC错误隐去。已向C2完整回报并请求owner最小定位，保持原10设备/100条及全部预算，R4未改生产或测试。详细故障位置见providers ACCEPTANCE §17。

## C2质量澄清落盘：arbitrary_precision pending不授权skip

本轮先merge main **536aad0958f4fe5830da347b1f37a1f57089ce93** → HEAD **ab0533ca7923f2e0dc78add6e60dd9a8353e2286**。当前main audit-decode.test.ts:237两个合法Value正例仍为it.skip.each。明确保留C2已见事实：pending是未完成状态，从未授权禁用测试；R4分列2skip不是批准skip，不能按450passed或39passed/2skip签完整Value。

候选 **91067dab299d13753538181847856ccd74030b50**已恢复普通it.each，原1e999对象、±1e999/高精度小数数组及精确数字重存断言不变；尚不是该main祖先。亲取owner现成 **20261105022638-b0d5a2** / **-5547a9**，Node/Electron各**2failed/4passed/35标题过滤skip、exit1**，无Errors/Unhandled；两例真实失败均为details=null，控制项通过。测试恢复与业务修复分开记录，未复跑已知失败专项；详backup ACCEPTANCE §19。

补存已有R4门禁 **20261105020220-6dc310**（tip37ebd065c/base628b4192e）：原exit1、1930passed/1failed/22skip＝20Docker＋2未授权审计skip；governance工具5/5、审计39passed/2skip，W69=38571.015932999995ms；无额外Errors。S10837894ms本次通过不撤销先前超时；selfgate政策ok=true不构成完整Value或全部运行等价。工具普通sync_run取消/超时仍缺本次任务实际停止接缝，全App roster也不由owner子集registry测试证明。

按C2要求等待F4＋L21真实同树修复后复核原正例，不以旧registry未复现宣称根因修复；没有修改实现、断言、白名单或自检记录。本次仅新增质量边界审计记录，提交合main后执行规定gate，不另排压力/Value专项。

## cf92主线限定闭环：WebDAV单调窗口、A13原调用不变量

固定main **cf92ce1ebb41de93af216755d896a2c5076a62a7**，受测tip **040d49ddad9fc4c389e007b6878c436b22a07a92**。只复用官方 **20261105041136-cca61a**，webdav41/41、adversarial38/38通过，无这些文件skip。源码对照及已有owner先红后绿证据见providers ACCEPTANCE §18。

- d476cf29e的窗口Date.now→performance.now对齐Rust Instant，真实请求都消费同一限流器；四个墙钟跳变/控制用例未替换sleep或被测逻辑。签L23-V2-1.7该单调窗口范围，保留修前032931-233f31的2fail/2pass/37过滤skip、原exit1与修后033052-311154的41pass/exit0。
- 4b476f44c的A13保留原字符串counter到INTEGER列、真实公开apply调用；Rust原只要求不panic并忽略Result，TS无catch吞异常、无自造计数/值断言。确认P08该单一原测试移植，不因零expect否定其不崩溃不变量，也不扩签A33/其它pending。owner033816-193e72的1pass/37过滤skip/exit0与main38/38分开记录。

原整作业exit1：1935passed/1failed/22skip（20Docker＋2未授权审计Value），158passed/1failed/1skipped files，无额外Errors/Unhandled；唯一失败W69=41280.440107ms。S10850476ms本次通过不解释旧根因。typecheck041136-231286、boundaries-023413、importable-982a1f均exit0；政策ok不授予完整迁移签收。P04/P08、B02/B03/B06/B07、S04/S06、07同源快照等仍开放，未修改任何实现/测试/TESTMAP。

## 92365主线限定闭环：A33原观察调用、W55真实只读apply

固定main **92365bc5c85d947c12d442a2b02fbf1ab0675b7c** / tip **1279d32aa35da81f9844cd1b6a039e6fb521e585**。复用 **20261105044538-d2557a**：adversarial39/39含A33通过，W55亦92ms通过，同文件16passed/1W69failed。A33对照Rust:1224-1263保留不一致ID的真实apply及两次COUNT unwrap观察，不将打印0/0扩成ID策略断言；W55对照Rust:1531-1561保留建库关闭/真实readonly驱动重开/生产Database只读错误，非任意throw。详providers ACCEPTANCE §19，P08仅新增这两个原测试子项签收。

owner现成040401-7d0bcb（1pass/38标题过滤）及035916-111d65（1pass/16标题过滤）均原exit0，无Errors，已亲取未重复。main整作业仍原exit1，1937passed/1failed/22skip（20Docker＋2未授权审计Value），158passed/1failed/1skipped files，无额外Errors/Unhandled；W69=41079.445253ms，S10835995ms本次通过不解释旧失败。tsc044538-4cd246/boundaries-3c7826/importable-d55e3b均0，政策ok=true不扩大验收。L21注册生命周期b1f090a2f仍未main，保持已向C2报告的候选静态结论，不借本次其他用例通过签该候选或全App。

## eaa17主线限定闭环：P20原500ms与W12原精确u64观察

固定main **eaa17bc7e27ea6e522d3b51e093a7d2e05b2c290** / tip **8ca5571da1da4e36cd26d7b35f1cd5fae4abf2fb**，复用规定gate **20261105045657-34fbab**，pathological33/33、weird40/40通过。P20保Rust原内存schema/trigger/refinery、万条已同步日志/deferred提交、构造fresh变更前起计及<500ms，实测8.211741999999504ms。W12保u64::MAX-1精确bigint输入/原内存schema与Result观察，不吞异常、不强加成功或截断策略。仅签P08这两个测试子项，详providers§20；不推断W69/P36或全整数域已修。

owner旧042830-151b20（1pass/32过滤skip/73.875603ms）、043559-8d4b33（1pass/39过滤skip）均原exit0、无Errors，已亲取未重排。main整体原exit1/1939passed/1failed/22skip（20Docker＋2未授权Value），158passed/1failed/1skipped files，无额外Errors/Unhandled；唯一失败W69=31510.610106ms。tsc045657-36c6b7/boundaries-719a95/importable-3c7929均0，政策通过不等于原测试全绿；其余父组/候选边界保持。

## P36固定main签收与混合树回执隔离（6d759e81c）

固定main **6d759e81c0bf474cb4d3367d4fc2158886da0e02** / tip **b9db66007d693423a3b51671109bdfd746cfd255** 的 **20261105052304-887d64** 实际执行pathological34/34通过，P36=26795.298263ms。已核原Rust1475-1504内存schema/refinery、5000次独立单条apply、原ID/ts、构造与调用计时不含COUNT、COUNT5000及严格<60s；runner120s不替代原断言。仅签P08-P36原测试子项，不签W69或旧S108/RPC根因，详providers§21。

此前 **20261105051007-ead04a** 起始记录tipbc0bb941a/baseeaa17，但自动续派在运行期间合入b9db66007；日志实际跑到新增P36/34例（25691.316571ms），已证不是起始固定树。其原exit1/1940passed/1failed/22skip、W69=39477.812446ms、无Errors保留为混合树回执，不作为新main签收；未篡改selfgate记录。后续规定gate活跃时先保持受测树，收尾再合并，避免重复此问题。

本次固定树结果原exit1/1940passed/1failed/22skip（20Docker＋2未授权Value），158passed/1failed/1skipped files，无额外Errors/Unhandled，W69=35630.57872ms。tsc052304-0a8c4e/boundaries-f3eb65/importable-0cb2e6均0，政策ok=true；运行期间无新合并/编辑，结束HEAD/状态已核。复用owner旧045404-bcaeff的1pass/33过滤skip/exit0/23890.568476ms，无Errors，无另排P36专项。

## 原 `host/plugins/sync/ACCEPTANCE.md` 全文无损迁入（越界路径处置，2026-11-05）

**来源与完整性**：原文件 `host/plugins/sync/ACCEPTANCE.md` 相对 main 为 R4 新增（main 无此路径），迁移前 blob SHA 为 `9c47bdd805da8e176c2ad1f80337c03b9c65908a`；本 lane 对该文件的提交链为 `e4170ddf3`、`b8ecbd6d5`、`4f23caa28`、`d65c99389`、`0cc6e4b24`、`37b873088`、`fbc9316b7`、`09f65389c`、`9e652d7c2`。下列全文对该 blob 逐字保留，未删改任何结论、断言、失败、作业号或退出码。

**为何迁入**：`scripts/electron-migration/lib/lane-paths.mjs` 的 R4 allowlist 仅含 `host/plugins/sync-providers/ACCEPTANCE.md`、`host/plugins/sync-support/ACCEPTANCE.md`、`host/plugins/backup/ACCEPTANCE.md`、`docs/dev/electron-migration/audits/R4-review-sync.md`，不含 `host/plugins/sync/ACCEPTANCE.md`。该白名单属全局门禁配置，R4 无权限修改；按用户 2026-11-05 明确授权作无损迁移，随后仅撤销本 lane 自己新增的这条越界 diff，main 原内容和他人改动未触碰。未改白名单、门禁脚本或 selfgate 记录。

**原作业与未决**：原文保留的 21 个队列作业从 `20261104105548-dc7233` 至 `20261104175042-bd0522`，均按原编号与 exit 保留；核心正式门禁为 `20261104161616-fddb22`（原 exit0），后继真实红灯 `20261104165954-fab2ca`（原 exit1，64 failed）及 `20261105004819-87e02a`（原 exit1，W69/S108/Errors1）也保留。未决仍为 **R4-SYNC-01、05、06、07**（02/03/04 已按记录范围签收），以及 S01/S04、05 画像 owner、06 worker/导出、07 direct-resource fixture 与 pending 完整性；§11 的注册生命周期/宿主契约需 L10/L20b/F3 协调。迁移不表示这些项已关闭。

**引用**：本文历史段落（如“v2正式main复验”“范围门禁阻塞”等节）提到的 `host/plugins/sync/ACCEPTANCE.md` 均指下列原文；该路径已不再单独存在，内容以本节为准。

以下为原文件全文（431 行，逐字保留）：

````markdown
# L20-sync 独立验收（R4，v2，2026-11-04）

**结论：不通过。** 首次基线eeaf，已签算法修复基线677f（§10）；后继fb463/7f4出现新的依赖注册/宿主契约回归，见§11。首次覆盖16条命令、20条ported原测试，后续按finding最小闭环；02/03/04原范围签收保留，不代表后继组合可用，01/05/06/07仍未决。没有修改实现、测试或账本，没有编译/运行Rust。

依据：`docs/dev/electron-migration/standard-v2.md` §1八类硬规则、§2完成清单及D1–D4。TS路径相对本插件；Rust命令简称`commands_sync.rs`，位于`src-tauri/src/data_governance/`；引擎简称文件位于`src-tauri/crates/dstu-sync/src/data_governance/sync/`。以下新ID `R4-SYNC-*` 不替换既有support的S01–S06。

**候选增量复核（最新，非main签收）**：按C2固定`f53290429d213e6c752b96ea94c6e0cfaa927ed6`及后继`2ed5f1491fc5ba05ee714c96df5b214adff31645`。默认hook无history先返回、正式owner正CAS与事务回滚已亲核；bigint max/分页/隔离ID、03维护日志、04坏行与SQL阶段的选定用例通过。02仍有旧用户change-log被误确认的真实失败、owner负CAS未变；笔记Vitest收集另被SkillsExecutor.name转换错误阻断。05已退pending、06仅增加缓冲写而无worker，均未关闭。七组主框仍等待main闭环，eeaf原证据不覆盖新候选；详细SHA/作业见§5。

## 必须修复

**最新主线证据补充（01c074ecf）**：support已新增一个应用+两个独立迁移库的`note-history-apply.test.ts`，五个原场景在181546-28458e中5/5通过，R4已逐条对照Rust并在support S01签收。它补上了正确场景覆盖，但本lane TESTMAP:204-208仍指旧文件；旧direct-resource同源回放偏差和relation第二Host Slot冲突继续归07。当前门禁已从64失败降至3失败（第二Host+两耗时），旧support worker facade初始化失败不再是当前主线状态。

**07新增集成阻塞（fb463→7f4）**：新门禁165954-fab2ca的64失败中，62个为notes安装时SlotOccupied，另2个耗时失败单列。Rust retention原语返回占用Err，调用方`if let Ok`保存Disposer到Scope；fb463的L10仍丢弃返回值且不处理占用。原生最小顺序重装172008-b2036f复现exit1。后继7f4已消费disposer，真实F3顺序重装174905-f091b7通过；但双Host组合仍有journal注册冲突，旧support storage facade首次安装又缺registerMaintenanceParticipant（175042-bd0522，exit1）。这不是62个整数/codec/状态算法回退，也不是归档tsconfig问题；沿07及support S01交F3/L10/L20b协调，详§11。

**正式main闭环（最新，677f6727c）**：L20 016f及后继精度/入口修复已main，官方门禁20261104161616-fddb22为**1758passed/20skip、原exit0**，不是基线豁免。02整数、03维护日志、04列表SQL阶段按原finding范围签收；默认reader/notes owner、原s03和宿主修复已在main运行。01的通用业务/冲突表写者、05真实画像owner、06worker与07测试/完整性仍未闭合。新增发现07中的一条原笔记快照测试把独立目标库改为源库回放，见§10；不因整套绿而替它签原场景等价。

**s03供方主线修复及复核环境纠偏（最新）**：L10修复已以`7df6fff90`（a38068281 cherry-pick）进入main。固定已自然合入它的L20候选`016f9bbee`，原s03最小测试20261104153914-22be3e **1passed/14过滤skip、exit0**，删除传播反例在该消费树通过；L20本身仍非固定main5f5c750a7祖先，01/05/06等不连带签收。另确认旧130739-f91838及新153107-70d2d6的SkillsExecutor.name收集错误是R4归档漏tsconfig所致；补同SHA原配置后旧2ed五条hook/精度/事务用例153914-f36472 **5passed/10过滤skip、exit0**。撤回依赖实现故障归因，原exit1保留为复核环境失败。详§9。

**main306 owner子项及新候选进展**：正式notes owner负CAS修复7a6783fdb已main，R4在原样main快照经真实support→notes服务严格复验-9007199254740994+1=-9007199254740993n（20261104144646-f3d9a4，exit0）。下方02中“owner负CAS仍舍入”仅属eeaf旧基线，该子项main签收；L20自己的默认hook/整数/echo消费改动未main，02总框仍开。另c1e4e70f1候选的pending metadata无损读取→enrich→定点ack新用例通过（20261104144742-d7a5e6，1passed/5过滤skip、exit0），详§8。

**s03删除传播收敛交接（与S03整数finding不同）**：C2标注L20基线`b520109b7fc56fea424b990f8c2bd7b344245837`的既有作业20261104140353-20cbc8已亲取原result：business25/25、realistic14/15，合计39passed/1failed、exit1，无额外Errors；唯一失败为`s03_delete_note_tombstone_sync_propagates`的目标deleted_at仍null。L10 `a38068281dddfcaf67a89a92f729216e67b1705b`源码改为Rust无deleted_at过滤的同连接SELECT，普通getNoteContent不变。两个SHA均非固定main8d7b05d14祖先；本轮未新增测试，待主线实际组合后只复验原s03。原8条回归闭环仍归L20，不能用旧7失败描述这一新结果，也不关闭01/05/06其它项。详§7。

**02后继候选更新（205380d59）**：`476d0d4637af42ee3ffe48bb24d50e614dda3a79`已把`changeLogMaxId`改成bigint直传，删除旧Number转换。本轮固定`205380d59b89bfd4bb346e39e98442c71b0ff699`，仅复验上一轮失败的生产echo用例，作业20261104134904-f722fb **1passed/4过滤skip、exit0**，旧用户ID保持sync_version=0且只确认新回声。此候选未进入固定main16a254adf，02总框仍待主线及owner负CAS闭环；§5的2ed原exit1保留。

- [ ] **R4-SYNC-01：笔记hook所有者已接main，通用业务/冲突表平行写者仍未闭合。** main `index.ts:94-97`与`repository/note-history.ts`已委托正式notes.sync及support reader，本地formats/revisions/关系业务副本已删除；原eeaf描述仅属历史。剩余`apply-record.ts:373,526-535,561-587`通用UPSERT/派生索引重置、`apply-refcounts.ts:92-106,218-232`直接写L11资源/索引；`conflicts.ts:132`等还写正式归sync-support所有的__sync_conflicts（owner-rulings.json）。D1/D4要求通过所有者业务方法且保持原事务；D7将apply编排归L20不等于批准所有跨表SQL。整组仍不关闭。
- [x] **R4-SYNC-02：已记录的D3整数反例main复验签收。** 默认完整apply正CAS旧反例由20261104162815-5c7d94验证，9007199254740993→9007199254740994n精确落库；负CAS由7a6783fdb及主线144646-f3d9a4闭环。主线integer-internal6例覆盖max/wasMerged、SQL落库、旧日志echo界限、分页先比较后IPC转换、精确隔离ID及pending元数据enrich/定点ack。原13130700误确认失败不删除，现据修复后的原主线断言签收；范围不扩大为所有未审数字字段皆正确。
- [x] **R4-SYNC-03：维护拒绝、顺序及业务日志main复验签收。** `index.ts:147-159`恢复status前置检查及双空resolve的info→maintenance，status末尾汇总info亦接回。主线maintenance-order3/3覆盖维护早于DB/设备ID、非空停用分支不额外检查、统计日志先于设备ID，原eeaf两个反例已闭环。
- [x] **R4-SYNC-04：原隔离/冲突列表及retry-all查询阶段/列解码main复验签收。** `repository/conflicts.ts:151-190`按F3 phase区分prepare/bind/step，逐列匹配Text/Integer/Null，隔离坏行fail-fast，冲突/retry-all保留原flatten行为。query-decoding6/6主线通过，包括缺列精确prepare前缀、首/后step及坏行/坏ID；不将这组签收扩展为所有其它查询的错误阶段均已审完。
- [ ] **R4-SYNC-05：虚假ported已撤回，真实画像owner仍未接。** main将旧自写merger测试改为supplemental，恢复3/4→5向量并将原测试退pending；这是记账纠正，不是owner合并能力通过。index仍不注入真实profileMerger，apply-record/guard最终回退冲突；继续等待正式memory接口和生产apply证据。
- [ ] **R4-SYNC-06：已改缓冲写，但导出仍未离开Host线程。** 主线已有jsonChunksLossless/8KiB缓冲，不能再说仍整包stringify；然而同步查库/序列化/writeSync仍在Host，async外壳不等于Rust `commands_sync.rs:2374-2378`的spawn_blocking。虚拟URI/正式文件所有者接缝亦未完成原支路；继续等待真实worker，不能仅凭测试绿关闭。
- [ ] **R4-SYNC-07：宿主和缺注册已修，测试真实性/完整覆盖仍未闭合。** main已补dataSpaceDeviceId且`index.ts:61-85`注册24条，旧35失败已消失；这两子项main确认。新增具体fixture偏差：`tests/note-history.test.ts:308-333`的direct_remote_resource_update在已建笔记的源库handle()中回放，并提前snapshot；Rust `note_history.rs:417-467`是独立source/target、在target应用/读取。原纯远端目标场景与源库已有pending场景不同，不能以assert更多或15绿证明等价。其它relation/row_sync用例有真实独立目标库，证据见§10；TESTMAP现212ported/46pending/5obsolete，其余完整性仍需逐项闭环。

## 1. 命令完成清单审读（16条）

命令均以`data_governance_`开头。每行同时核对入口、分支/边界、错误日志、所有权/运行时及证据范围。注册位置`index.ts:172-199`。证据以源码对照为主；“主路对应”不表示整命令v2签收。

| 命令 / Rust入口 | TS入口与分支/边界核对 | 错误、日志、所有权及运行时判定 |
|---|---|---|
| count_record_conflicts / :4551-4584 | `local-commands.ts:19-36`；四库存在→开库→按(table,record)计组/行，失败0、省略无组库；输出per_database/total_groups/total_rows对应 | Rust本来静默跳过开库/计数失败，不补造warn；读sync元表，finally close；内部计数number未证明全u64，证据=审读 |
| discard_quarantine / :4257-4282 | `local-commands.ts:38-49`；未知库→打开→表缺失false→DELETE id→changes>0 | 字符串错误上下文对应；只写sync拥有的隔离表，无业务表写入；finally close；IPC i64与内部number限制见02 |
| discard_all_quarantine / :4352-4384 | `local-commands.ts:51-64`；缺库/开库失败/缺表跳过，逐库删，success累计/failed0/errors[] | DELETE失败必须“批量清除失败”，已保留；原本非跨库事务，不追加原子性要求；finally close |
| get_sync_status / :1026-1186 | `status.ts:27-138`；缺库跳过，开库/统计/最后时间失败unknown与partial，表缺失known，last_sync取字节序max，Option明确null | **03**缺维护拒绝及汇总info；读变更日志；finally close；本轮kernel在维护标志true时仍返回成功，不能签收 |
| list_sync_snapshot_batches / :5187-5222 | `history-commands.ts:20-50`；默认50/上限500，逐库读取、batch_id倒序、全局截断；六个字段及rolled_back_at=null对应 | “读取<库>的快照批次失败”存在；读sync history，finally close；原无全局锁要求，没加锁不是缺陷；证据=审读 |
| purge_resolved_conflicts / :5011-5049 | `history-commands.ts:53-69`；默认30天、墙钟cutoff、仅resolved且早于cutoff删除 | 原SQL错误unwrap_or(0)，TS continue等价，不误报吞错；只写sync元表；finally close，未强加事务 |
| list_quarantine / :4168-4229 | `list-commands.ts:26-49`；默认200/上限2000、跨库last_attempt降序/id降序、offset分页，snake_case及nullable payload输出 | **02/04**内部ID舍入和准备/读取错误归类、无列解码；原开库失败静默，不能要求新增日志；finally close；命令测试未执行到断言 |
| list_record_conflicts / :4407-4502 | `list-commands.ts:52-86`；未解决筛选、日期/id排序、组分页保留选中组所有行 | **02/04**；Rust tuple组key，TS分隔符拼接不等于类型解码证明；未就任意构造字符另扩finding；只读元表，finally close |
| resolve_conflicts / :1429-1459 | `list-commands.ts:90-97`；任一非空返回完全相同停用消息；双空应继续info/maintenance再策略错误 | **03**空输入维护错误顺序缺失；非空分支无需数据库/permit，不要求恢复Rust停用后不可达主体；kernel空输入反例已取 |
| retry_quarantine / :4233-4253 | `quarantine-commands.ts:21-45`；未知库、开库错误、缺表false、重试失败前缀；下游校验payload hash/baseline并走guarded apply | **01/02/04**重试最终业务写者、ID与解码；连接finally关闭，真实apply具事务/SAVEPOINT；本轮套件安装失败，未验证六个行为断言 |
| retry_all_quarantine / :4294-4348 | `quarantine-commands.ts:48-88`；按库/ID顺序逐项，true成功、false/异常记录errors，不因单项失败终止 | **02/04**IDs过早Number、query阶段/坏行过滤有差异；最后结果字段一致，finally close；不得将逐项容错误改fail-fast |
| cancel_sync / :2811-2824 | `index.ts:125-129,193 → cancellation.ts:12-16`；无token false，有token abort/true+info | 局部槽行为对应；**07**真实token安装点在未注册run-sync，不能以测试手装slot声称端到端取消成立。Rust仅协作式检查点，不要求成功PUT即时中止 |
| export_sync_data / :2369-2505 | `transfer-commands.ts:110-155,185-200`；四库收集、补全失败warn继续、默认活动槽路径、输出四字段 | info/warn方向正确；**06**阻塞Host/整串内存及虚拟URI缺支路；create→serialize→write错误顺序与close finally存在，不能因此统签 |
| repo_check / :5151-5166 | `cloud-commands.ts:10-23`；先维护拒绝→backup hydrate→syncProvider create→正式runRepoCheck | 两个错误前缀对应，使用L23 api而非复制巡检；只读网络，原入口无新增warn/error；底层L23的P04/P08另列，证据=审读 |
| detect_conflicts / :1281-1381 | `detect-conflicts.ts:82-128`；info→维护→本地manifest；显式JSON优先、否则hydrate/cloud/decrypt；无云返回false/空/null | 正式decoder入口、codec finally dispose、创建/下载/检测错误前缀和业务info存在；Number(local/cloud_version)只在最终响应，不误归为02内部损失；manifest decoder完整serde另待闭环 |
| detect_prune_gap / :5071-5143 | `prune-gap.ts:14-73`；维护→hydrate→本地最小发布版本(仅诊断)→云端游标gap；格式/实例/gap_details nullable形状对应 | 内部since bigint、末端IPC才Number符合D3；无库/坏状态原本静默；codec finally与业务info存在。使用syncSupport.state为真实可达服务，不等于笔记默认hook也已改用它 |

已对照Rust中上述缺库/开库失败的`continue`、`unwrap_or(false/0)`：这些是原容错分支，不因空catch形式额外派修。对本次未运行的命令不写“测试通过”。

## 2. TESTMAP真实性抽查（20条）

前15条Rust为`field_merge.rs`，TS为`tests/field-merge.test.ts`；第16–19为`hlc.rs`/`tests/hlc.test.ts`；第20为app扩展测试。均在固定main TESTMAP标ported。

字段合并生产可达链：`index.ts:132 → apply-batch.ts:130 → apply-record.ts:604 → src/field-merge.ts:80`，另guarded apply:120；HLC由`index.ts:111-112`公开。纯函数直调证据低于生产入口，但不是未接线副本；画像例外如下。

| 原测试名 | Rust行 / TS行 | 原断言对照结论 |
|---|---|---|
| test_tag_union | 357-372 / 15-23 | 三标签存在、长度3、merged=true五项保留，经生产dispatch调用 |
| test_max_value | 376-380 / 25-29 | 10/7→10、merged=true保留；不覆盖02的大整数域 |
| test_boolean_or | 383-387 / 31-35 | false/true→true、merged=true保留 |
| regression_m14_boolean_or_accepts_sqlite_integer_bool | 390-394 / 37-41 | SQLite 0/1两断言保留 |
| regression_td02_completed_pomodoros_is_not_field_merged | 397-428 / 43-55 | 排除派生字段、completed和estimated各远端5/不合并/冲突七项保留 |
| regression_r02_non_monotonic_fields_are_not_max_merged | 431-463 / 57-75 | 三列逐项不在picklist、10→2不回弹；真正单调total_reviews仍max且无冲突 |
| regression_r04_question_counters_are_not_max_merged | 466-486 / 77-85 | attempt/correct两列均可归零、不max、不丢冲突 |
| regression_m21_ordered_json_arrays_fall_back_to_lww_conflict | 490-501 / 87-98 | 完整remote对象数组、false/true三项保留 |
| regression_m21_deep_json_falls_back_to_lww_conflict | 504-515 / 100-111 | 嵌套remote整体LWW、不深合并、冲突三项保留 |
| regression_m22_ref_count_is_not_auto_merged | 518-524 / 113-118 | remote7、未合并、有冲突三项保留 |
| regression_m22_picklist_only_exposes_convergent_strategies | 527-535 / 120-125 | questions精确数组、其它三列排除保留 |
| regression_m22_registry_is_single_source_for_picklist | 538-546 / 127-131 | 遍历实际registry，各表非空断言保留 |
| regression_m22_classification_field_merge_requires_registered_columns | 549-566 / 133-142 | RowSync/FieldMerge筛选及每表非空保留 |
| note_props_uses_whole_object_lww_not_unsafe_deep_merge | 569-581 / 144-152 | props排除、remote整体、未合并、有冲突四项保留 |
| anki_export_receipt_columns_fall_back_to_row_level_lww | 584-611 / 154-165 | receipt四列排除及远端完整时间/false/true保留 |
| test_hlc_encoding_is_lex_sortable | 69-76 / 4-11 | 同一a/b/c三个次序关系保留 |
| test_hlc_parse_roundtrip | 79-83 / 12-15 | 原millis/counter完整struct回读相等 |
| test_hlc_u64_roundtrip | 86-90 / 16-19 | 同一原值pack/unpack完整相等 |
| test_lex_order_matches_hlc_order_for_sequence | 93-108 / 20-27 | 10×2值、结构序与字符串序parse后全序列相等 |
| regression_j8c_resources_data_merges_learner_profiles | `src/sync_app_tests.rs:13-51` / 260-328 | **不真实，05**：生产扩展改为自写merger，原version3/4→5改为1/2→3。expect更多也不能掩盖测替身及原向量变更 |

这20条的运行结果包含在下方31passed中；第20条绿仍不签收。其它10条field-merge文件用例虽运行，本表不冒称逐条已完成独立断言核对。

## 3. 原始作业与生产探针

### 3.1 原样main移植测试

全局作业 **20261104111500-af42b6**，原样快照`/tmp/opencode/R4-v2-main-eeaf-FoYvZ8`，命令：

```text
node <R4>/node_modules/vitest/vitest.mjs run --root <snapshot> -c <snapshot>/vitest.host.config.ts --no-cache --maxWorkers=1 host/plugins/sync/tests/field-merge.test.ts host/plugins/sync/tests/hlc.test.ts host/plugins/sync/tests/list-commands.test.ts host/plugins/sync/tests/quarantine-commands.test.ts
field-merge.test.ts (26 tests) passed
hlc.test.ts (5 tests) passed
list-commands.test.ts: 4 failed
quarantine-commands.test.ts: Failed Suite, 6 skipped
TypeError: paths.dataSpaceDeviceId is not a function
  host/plugins/vfs-repos/index.ts:161:34
Test Files 2 failed | 2 passed (4)
Tests 4 failed | 31 passed | 6 skipped (41)
退出码 1
```

无额外Unhandled Errors段，但有**Failed Suites 1及Failed Tests 4**，不能写成31例全绿。六个skip是beforeAll失败导致，不是主动按名过滤。原日志`/home/dsdev/.oc-jobs/done/20261104111500-af42b6.log`。没有修测试替身或重跑相同集合求绿。

### 3.2 新生产入口观察（真实owner、正式F4、默认hooks）

作业 **20261104112304-515659**，同一eeaf快照，通过kernel安装真实vfs-repos、notes、sync-support、sync；使用真实StorageServiceImpl及原迁移创建隔离目录、正式createPaths（提供真实dataSpaceDeviceId）。没有调用setDefaultNoteHistory覆盖生产hook，也没有导入测试host-fixture。

notes.repository真实建笔记；先直接观察正式owner负CAS，后通过公开sync.applyDownloadedChanges更新关系。未用的backup/provider/secrets/compression端口为空对象，不执行网络/加密；只为维护拒绝反例注入`vfsDatabase.isInMaintenanceMode()=true`，这部分是命令依赖输入探针，不声称实际建立了F3维护屏障。最后纯函数定向观察大整数max。

```text
MAIN_OWNER_NEGATIVE_CAS -9007199254740992 number expected -9007199254740993
MAIN_DEFAULT_APPLY {"success_count":0,"failure_count":1,"skipped_count":0,"skipped_incomplete_count":0,"failures":[{"table_name":"note_learning_relations","record_id":"r4","operation":"UPDATE","error":"Database error: Relation revision exhausted"}],"applied_keys":{}}
STATUS_MAINTENANCE_TRUE {"partial":false,"errors":[],"has_pending_changes":true,"total_pending_changes":8,"total_synced_changes":1,...,"device_id":"r4-main-observer"}
EMPTY_RESOLVE_MAINTENANCE_TRUE 未知的合并策略: 。可选值: keep_local, use_cloud, keep_latest, manual
MAX_MERGE [9007199254740992,false,false]
退出码 0
```

完整status响应及命令在`/home/dsdev/.oc-jobs/done/20261104112304-515659.log`；上文仅缩写重复库状态。**这是打印观察、捕获预期拒绝的探针，exit0不代表行为正确**。具体偏差与Rust依据见02/03。能装起真实服务说明之前移植测试的dataSpaceDeviceId失败来自测试fixture，不能误报为正式F4缺API。

### 3.3 ledger与范围

恢复时亲取既有作业 **20261104105548-dc7233**（在R4工作树运行，不是eeaf快照）：`npm run migration:ledger -- --check --no-write`，exit0；commands1058、tests8036、commands/tests/orphan problems均0。只证明该工作树机械账本，不替代本次main行为验证。

main TESTMAP逐行真实分布为**211ported/47pending/5obsolete**（263行），页首182/81未刷新。support自己表28ported/12pending与L20将11条真实apply映射到本lane不是同一范围，不能合并成虚假的全绿；obsolete批准须另按审批账本核对，本次不凭字段文字再次授予批准。

## 4. 签收边界

- 已确认：16命令的真实注册/函数可达关系；多数纯字段合并/HLC原断言保留且运行通过；默认apply真实事务/SAVEPOINT存在；support.state已有消费、番茄计数已转L11 owner。没有把这些局部事实写成整个插件通过。
- 未闭合：默认笔记/通用业务写者、内部大整数、维护/日志、持久化行和SQL错误阶段、真实画像合并、worker导出、命令生产覆盖及失败测试。对应R4-SYNC-01–07均待main修复后最小复验。
- S01/S03/S04共享问题保持原ID并引用本报告；不以本报告新ID重开已验证的L23 P03/P06或备份无变化用例。所有当前结论只描述eeaf固定树，后续候选不得覆盖本main反例。

## 5. f53290429及后继候选的最小复核（2ed5f1491）

### 5.1 固定树与修复归属

本轮未重做§1–§2的16命令/20原测试审计。候选原样快照 `/tmp/opencode/R4-L20-2ed5-iFEYE8` 来自 `2ed5f1491fc5ba05ee714c96df5b214adff31645`，包含C2指定f53290429；不叠加其它owner分支。main可见性固定`44b66353c42a80e3769aceaefec29226f66697b2`，f532/2ed/522dfea98/94e4fcb2b/9638468aa祖先检查均exit1。候选验证通过不勾main完成框。

| finding / 接缝 | 实际修复SHA与候选代码 | 本轮判定 |
|---|---|---|
| 01/S01：无history特性门 | `112ca0bc6`的`repository/note-history.ts:92-102`；f532本身仅LANE/REPORT记录 | validateIncoming/affectedNotes在无version_id时先return，不调用reader；Rust `note_history.rs:264-266,371-373`。真实默认apply探针成功且readerCalls=0 |
| 01/S04：默认笔记owner | f532已含本地写SQL删除与`index.ts:83-88`正式notes/support接线；`note-history.ts:103-107`直接委托notes.sync并传同一tx | 正CAS真实写回、owner真实写入后故障的行SAVEPOINT回滚通过；不能再以“候选仍用旧平行笔记仓储”否决。通用apply-record和refcounts仍直接写业务表，整组不关闭 |
| 02：bigint max及标签整数 | `c0c2e5843`，`src/field-merge.ts:179-185,246-261` | 相邻正负i64、wasMerged、超i64回退、REAL与标签数字用例及真实apply落库通过；不把最终安全范围Number视为超界损失 |
| 02：内部隔离/冲突ID | `94e4fcb2b`，`repository/conflicts.ts:39-65,98-104,140-142`，`list-commands.ts:48-49,74,87-90`，quarantine.ts:180-207 | safeIntegers读取→bigint排序/重试/SQL绑定→响应末端才Number；两相邻ID分页顺序和各自attempts递增均通过 |
| 02：旧日志回声界限 | `apply-shared.ts:123`虽改bigint类型，但`apply-refcounts.ts:65-68`仍Number(pluckSafe(MAX(id))) | **未修且亲跑失败**：原ID9007199254740993被误标sync_version=1793797633；不能只改参数注解就保真。Rust `mod.rs:7104-7134,7287-7292`取i64阈值，`:17831-17840`明确旧用户日志应保持0 |
| 02/S03：notes owner负CAS | 候选与固定main的`notes/repository/sync.ts:154-158`无差异 | 只比较MAX_SAFE后Number的旧负下界缺陷仍在；未重复相同旧失败。正CAS主链修复不替该owner分支签收 |
| 03：维护/日志 | `4accc4cf6`实现，`9638468aa`定向回归；index.ts:129-142、status.ts:129 | 三个kernel用例通过：status拒绝早于开库/设备ID；双空resolve info→维护拒绝；非空停用请求不检查维护/不发该info；最终统计info先于deviceId |
| 04：SQL阶段与坏行 | `94e4fcb2b`实现、`b9d2d0de3`最新回归；conflicts.ts:151-190 | 六例通过：坏隔离行fail、坏冲突行flatten且保留后行、prepare三前缀、坏ID过滤、首/后step与bind分类。按F3 phase而非是否已yield；不联动关闭support S05 |
| 07：宿主/注册进展 | `7775325d9`补host-fixture dataSpaceDeviceId；2ed index新增import/resolveRecord/rollback三命令 | 本轮整数/维护/查询真实宿主已安装，不再报旧paths错误；未扩大这三条新命令的独立审读/签收。run_sync两入口仍待，另有下述Vitest依赖收集阻塞 |

### 5.2 亲跑最小作业

Vitest统一使用 `<R4>/node_modules/vitest/vitest.mjs run --root <snapshot> -c <snapshot>/vitest.host.config.ts --no-cache --maxWorkers=1`，全部由全局job队列提交。

**20261104130700-1f88b4**：仅新增`integer-internal.test.ts`、`maintenance-order.test.ts`、`query-decoding.test.ts`。

```text
query-decoding.test.ts (6 tests) passed
maintenance-order.test.ts (3 tests) passed
integer-internal.test.ts (5 tests | 1 failed)
FAIL production echo suppression does not acknowledge an older adjacent i64 log ID
Expected: { id: 9007199254740993n, sync_version: 0n }
Received: { id: 9007199254740993n, sync_version: 1793797633n }
Test Files 1 failed | 2 passed (3)
Tests 1 failed | 13 passed (14)
退出码 1
```

测试真实性：max纯函数之外，落库、分页、retry-all均经安装的sync公开服务/kernel，F3实际SQLite；query-decoding前两例走kernel和真实坏表/坏列，后三类SQL故障以Proxy只替换SQL输入、仍执行真实F3 iterate，不伪造StorageError/phase。维护服务输入为true与路径探针，用来验证命令顺序；不冒称实际建立F3维护屏障。均不替换被测命令实现。

**20261104130739-f91838**：note-history只选 `S01: public apply|R4 S03:|R4 S04:|W18: history owner`，未重复整个原note测试集。

```text
Failed Suites 1
FAIL host/plugins/sync/tests/note-history.test.ts
TypeError: Cannot assign to read only property 'name' of function 'class SkillsExecutor ...'
  host/plugins/agent-skills/src/tools/skills-executor.ts:207:19
  static readonly name = 'SkillsExecutor';
Test Files 1 failed (1)
Tests no tests
退出码 1
```

这是当时归档漏带项目tsconfig造成的复核环境收集失败，五个目标用例当时均未执行，不能写成“5skip/5pass”，也不能归责notes/L07生产实现。现已按§9补齐同SHA原配置并跑到5条断言全部通过；没有改项目依赖、配置或测试来求绿。两Vitest原作业都无额外Unhandled Errors段，但各自Failed Tests/Failed Suite与原exit1完整保留。

**20261104130934-9eb153**：原生Node加载同一候选真实kernel/F4/F3/vfs-repos/notes/support/sync，安装后不覆盖默认hooks。只执行无history门及此前main失败的正大整数CAS。

```text
NO_HISTORY_DEFAULT_APPLY {"success_count":1,"failure_count":0,"skipped_count":0,"skipped_incomplete_count":0,"failures":[],"applied_keys":{}} readerCalls 0
DEFAULT_POSITIVE_CAS {"success_count":1,"failure_count":0,"skipped_count":0,"skipped_incomplete_count":0,"failures":[],"applied_keys":{}} stored 9007199254740994
退出码 0
```

读者计数包装只观察并转发原方法；第一段真实legacy SQLite无note_document_revisions，第二段正式迁移库、真实owner建笔记，本地revision=9007199254740993n，调用公开sync.applyDownloadedChanges，最终safeIntegers读回9007199254740994n并断言。与main的`Relation revision exhausted`反例形成有效对照；未重复owner负数旧反例。

**20261104131323-c945a6**：补收集失败未执行的真实owner事务回滚。原生Node同一正式服务组合，包装notes.sync.updateInferredFormat，先执行真实owner写入再注入故障；不重写apply，不制造替身写SQL。

```text
REAL_OWNER_ROLLBACK {"success_count":0,"failure_count":1,"skipped_count":0,"skipped_incomplete_count":0,"failures":[{"table_name":"resources","record_id":"res_ALE5ssVifG","operation":"UPDATE","error":"Database error: R4 owner injected failure after real update"}],"applied_keys":{}} calls 1 content before historyBefore 1 historyAfter 1
退出码 0
```

断言owner收到tx而不是外部handle、在tx内能读到after、真实owner执行后故障被计为一条隔离失败、最终正文恢复before且历史条数1→1。这里failure_count=1是预定故障的正确结果，Node断言全部通过；两个Node作业不是仅打印exit0。完整脚本/输出均在`/home/dsdev/.oc-jobs/done/<job-id>.log`。

### 5.3 未扩大关闭项与范围门禁

- 05：candidate `tests/field-merge.test.ts:260`已改为supplemental名称，恢复原3/4→5向量，但仍注入自写merger；TESTMAP相应原测试已退pending。这是记账纠正，不是画像owner实现通过，没有重复跑替身。
- 06：`transfer-commands.ts:187-219`新增8KiB缓冲/token流写，已不再整包stringify；依然Host同步writeSync，虚拟URI/worker接缝待提供。不把进展说成原源码完全未变，也不据此关闭worker缺口。
- 本轮未运行L23 P04旧失败、B04/B11已签子项或全lane测试；等待F4 JsonReader实际消费增量再按既有反例复验。
- 集成通知称`host/plugins/sync/ACCEPTANCE.md`超范围。已定位`lib/lane-paths.mjs:37`及旧dispatch仍只列原三插件；架构师v2追加sync授权尚未同步到该白名单。报告保留，未越权修改门禁配置；由协调者同步授权路径后再集成，不以删除独立报告绕过范围判定。

## 6. 02精确回声阈值修复候选（476d0d463 / 205380d59）

自动续派后先合main，发现确有5行生产增量：`repository/apply-refcounts.ts:65-68`的返回类型从number改bigint、`Number(pluckSafe(...))`改为`pluckSafe<bigint>(...) ?? 0n`。固定候选`205380d59b89bfd4bb346e39e98442c71b0ff699`、原样快照`/tmp/opencode/R4-L20-205380-SmVPby`，不重复已过max/分页/维护/查询用例。

作业**20261104134904-f722fb**：仅`tests/integer-internal.test.ts -t 'production echo suppression'`，仍采用§5相同Vitest root/config/no-cache/maxWorkers=1参数。真实公开apply与SQLite触发器、safeIntegers读取断言保留不变：旧ID9007199254740993仍sync_version=0、新ID9007199254740994已确认。

```text
 ✓ host/plugins/sync/tests/integer-internal.test.ts (5 tests | 4 skipped)
 Test Files 1 passed (1)
 Tests 1 passed | 4 skipped (5)
 退出码 0
```

无Failed/Unhandled Errors，4skip仅标题过滤；日志`/home/dsdev/.oc-jobs/done/20261104134904-f722fb.log`。对照Rust `mod.rs:7104-7134,7287-7292,17831-17840`，本次修复的是阈值读取与后续SQL比较本身，而不是放宽断言。`476d0d463`/205380均非固定main `16a254adfb53d24b971d27b2a7f34bf899d2bec7`祖先，因此只签候选行为；主线仍待，owner负CAS/通用跨表写者/画像与导出等不联动关闭。

## 7. realistic s03删除传播：最新已知失败与L10候选

亲取C2提供的既有作业**20261104140353-20cbc8**（运行目录L20工作树，C2标注固定b520109b7；不是R4新归档独立运行）：

```text
✓ host/plugins/sync-providers/tests/business_tables_sync.test.ts (25 tests)
❯ host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts (15 tests | 1 failed)
× s03_delete_note_tombstone_sync_propagates
  expected null not to be null
  realistic_scenarios_sync.test.ts:285 expect(deleted).not.toBeNull()
Test Files 1 failed | 1 passed (2)
Tests 1 failed | 39 passed (40)
退出码 1
```

无skip及额外Unhandled Errors段，原日志`/home/dsdev/.oc-jobs/done/20261104140353-20cbc8.log`。其它business25及realistic14已过，不把旧7个同名失败继续列为这棵树的现状；原8条回归仍由L20最终闭环，测试未改。

静态核对L10 **a38068281dddfcaf67a89a92f729216e67b1705b**：`notes/repository/sync.ts::updateInferredFormat`不再调用过滤软删的getNoteContent，而是在现有noteTransaction(conn)中执行 `SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1`；与Rust `note_history.rs:285-286`相同，不过滤deleted_at。普通getNoteContent未变，缺行/NULL分别报Query returned no rows/列类型错误。这能解释tombstone UPDATE后原“Note not found”回滚的来源，但静态方向正确不等于端到端删除传播已通过。

固定main **8d7b05d148521c3437619b3e75859e6f4a7c1bcd**，a380与b520祖先检查均exit1。依C2要求，待L10正式main及L20消费后只运行原s03最小入口，不再跑两文件40例、不用旧a9856a观察exit0替代断言通过。当前为待主线复验，不新增签收，不连带关闭R4-SYNC-01/05/06其它问题。

## 8. main负CAS修复与pending metadata候选（306 / c1e4）

### 已进入main的owner子项

固定main`306eb8bbbe74ad8f225da9313d24dd8eb0a8ef40`已含`7a6783fdb2a3e1bd3843c5643dbc19ff640583cb`。notes.sync.prepareRelation只在双边安全整数区间转Number；新主线探针**20261104144646-f3d9a4**返回`MAIN_NEGATIVE_CAS -9007199254740993 bigint`，strict equal断言通过、exit0。实际调用安装后的syncSupport.noteHistory→正式notes owner，不改实现/测试；完整脚本和fixture范围见support ACCEPTANCE §10。原eeaf观察的负整数错误不再作为当前owner现状，L20旧本地hook仍属另一未合消费链，未借此签收02整组。

### c1e4候选的新读取/确认链

固定`c1e4e70f12ea4ebfa093c03cf1d55e673166ea80`；修复标记`e408548ff`，实际代码在自动检查点`aab3cd06067bc5784fe7d6454b4ee36c207e85ff`。相对b520的真实增量：`repository/change-log.ts`在SQL读取启用safeIntegers，id/sync_version仅在双边安全范围转number；field_deltas_json从普通JSON.parse换成共享lossless解析；`src/change-log.ts`及api允许number|bigint，enrich不丢原change_log_id及REAL字面量。

Rust依据：`mod.rs:4205-4254`公开pending查询，`:9902-9938`的id/sync_version为i64、field_deltas为serde_json::Value，`:9821-9841`enrich携带原ID与元数据，`:4293-4358`按所传ID确认。没有把错误类型/全部查询阶段等其它分支也声明通过。

仅新增作业**20261104144742-d7a5e6**，原样快照`/tmp/opencode/R4-L20-c1e4-UYgfB0`，选`integer-internal.test.ts -t 'pending metadata stays exact'`，统一root/config/no-cache/maxWorkers=1。

```text
✓ R4-SYNC-02/X6-UD-0072: pending metadata stays exact through public enrich and acknowledgement
Tests 1 passed | 5 skipped (6)
退出码 0
```

真实F3 SQLite放入相邻ID9007199254740992/9007199254740993及metadata中的大整数和1.0；公开getPendingChanges带/不带表过滤一致，enrich序列化原ID/大整数/REAL文本保留，markSyncedWithTimestamp仅确认higher，lower仍pending。测试不重写被测算法，5skip只是过滤，无额外Errors。完整命令/stdout在`/home/dsdev/.oc-jobs/done/20261104144742-d7a5e6.log`。

该L20候选非固定main306祖先；只记候选通过，不重跑已过max/分页/echo/维护/坏行集合。s03删除传播仍等待L10 a380与L20主线组合，05真实画像owner、06worker等继续未决。

## 9. s03原反例通过及归档配置纠偏（016f / 7df）

### 供方正式main、消费方仍候选

固定main`5f5c750a7f8c373d3c5abd7a76e505ca73d95297`已含**7df6fff90c5439ad816993ddbc9902a4f9d35a30**，其提交明确cherry-pick自a38068281，`notes/repository/sync.ts`两SHA无差异。故不能再因原a380不是祖先而称修复未main；代码已通过不同提交号正式交付。

固定L20 **016f9bbee6e52b5c3aef40f8dea719382bfd7849**，其自然merge main包含7df，未人工叠加owner目录；L20自身仍非固定main5f5祖先。相对b520，原`realistic_scenarios_sync.test.ts`及`realistic_sync_harness.ts`没有改动。仅验证此前40例中剩余s03，不重复business25和其它realistic14。

原Rust `src-tauri/tests/sync_realistic_scenarios.rs:879-899`先同步笔记，再源端软删，再同步，最后要求目标deleted_at Some且非空。TS`:273-286`两条not-null/not-empty断言保留；`:188-199`通过公开getPendingChanges→enrichChangesWithData→applyDownloadedChanges传输，`:212-234`安装真实vfs-repos/notes/support/sync和两台真实F3迁移库。非被测backup/provider端口是未使用替身，不改apply逻辑。

### 最初归档错误与修正

快照`/tmp/opencode/R4-L20-016f-s03-oAkxkK`初次归档漏了根tsconfig。原作业**20261104153107-70d2d6**因此在收集时失败：

```text
Failed Suites 1
TypeError: Cannot assign to read only property 'name' of function 'class SkillsExecutor ...'
  host/plugins/agent-skills/src/tools/skills-executor.ts:207
Tests no tests
退出码 1
```

追查发现原项目`tsconfig.json:3-4`包含ES2022及useDefineForClassFields=true；缺配置使转换输出静态赋值`this.name = ...`，触碰函数只读name。§5旧2ed快照同样漏了配置。分别从**各自固定SHA**原样归档tsconfig.json/tsconfig.host.json/tsconfig.node.json补入临时快照；实现、测试及项目配置本身均未改，也没有调低断言或替换依赖。此前将其描述为“依赖收集阻塞”缺少归档归因，现明确更正为复核环境问题，不要求L07改合法类字段。

### 正确原配置下的两个最小结果

| 作业 | 固定树/选择 | 原result |
|---|---|---|
| **20261104153914-22be3e** | 016f原realistic文件，仅`s03_delete_note_tombstone_sync_propagates` | **1passed/14过滤skip、exit0** |
| **20261104153914-f36472** | 原2ed树，仅`S01: public apply\|R4 S03:\|R4 S04:\|W18: history owner` | **5passed/10过滤skip、exit0** |

两个均无Failed/Unhandled Errors；命令沿原snapshot root/config/no-cache/maxWorkers=1，仅补齐漏归档的原配置。第二个不是重跑已完成的旧五例：130739-f91838原来在收集阶段零用例，只有Node补探针完成了部分运行证据。此次确认原五条默认reader/owner同tx、props_json不变式、正CAS、INTEGER历史、owner失败回滚全部实际通过。

所有原日志仍在`/home/dsdev/.oc-jobs/done/<id>.log`：130739-f91838与153107-70d2d6的原exit1保留；153914两项不覆盖旧错误。Node原生探针不依赖这份tsconfig，结果不受该归档问题影响；实际工作树lane-gate的paths.dataSpaceDeviceId失败也不是这个问题。

结论：L10修复已main、s03在真实L20候选消费链通过；待L20整体合入后完成主线签收。原8回归责任仍L20，不将跨树的39+1拼成一次40全绿，不关闭01/05/06其它问题。配置纠偏及最终结果均已通过coord信箱通知C2。

## 10. L20主线闭环与原测试fixture复核（677f6727c）

固定main **677f6727c691ac3a2b33ca4c0a9b637476d0feb9**已含016f9bbee及其精度/入口修复；`git diff 016f9bbee 677f6727c -- host/plugins/sync`为空。R4分支tipceb5c77be按官方lane-gate实际运行完整配置，不是临时漏配置归档。

### 原始主线结果

作业**20261104161616-fddb22**：

```text
✓ host/plugins/sync/tests/note-history.test.ts (15 tests)
✓ host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts (15 tests)
✓ host/plugins/sync/tests/integer-internal.test.ts (6 tests)
✓ host/plugins/sync/tests/query-decoding.test.ts (6 tests)
✓ host/plugins/sync/tests/maintenance-order.test.ts (3 tests)
Test Files 147 passed | 1 skipped (148)
Tests 1758 passed | 20 skipped (1778)
退出码 0
```

20skip全部来自`sync_provider_contract.test.ts` Docker契约套件，未隐藏新的失败；无Failed/Unhandled Errors。这次门禁tests本身exit0，**不是**judgeAgainstBaseline豁免。其它三项typecheck161615-cbc5bf、boundaries161616-0f65b3、importable161616-22fdd4亦exit0。整个sync目录52文件425例均运行通过；该统计不能替代语义审读。

原s03删除传播位于该main realistic15/15中，原断言、正式owner消费与016f已核版本相同，现完成这个回归的主线复验；不由它关闭01/05/06其它事项。

为直接对照§3旧main的完整默认apply CAS失败，只补一个确实变化的主线生产探针 **20261104162815-5c7d94**。原样快照`/tmp/opencode/R4-main-677-CAS-Qg4ADd`包含原tsconfig三文件；实际F4/F3迁移、真实notes/vfs-repos/support/sync、不覆盖默认hooks。本地revision9007199254740993，经公开apply后safeIntegers读取：

```text
MAIN_DEFAULT_FULL_APPLY_CAS {"success_count":1,"failure_count":0,"skipped_count":0,"skipped_incomplete_count":0,"failures":[],"applied_keys":{}} revision 9007199254740994 bigint
退出码 0
```

严格断言success=1/failure=0及精确bigint写回，非仅打印观察。负CAS已在306主线验证，相关owner代码未再变化，不重复跑。结合主线integer6例（含旧echo及metadata）、维护3例、查询6例，**R4-SYNC-02/03/04按已记录反例范围签收**。04原eeaf缺source_seq列应prepare却统一execute的源码反例已由生产phase映射修复；不扩大到其它未审SQL调用。原所有非零作业保留。

### 07新发现：direct-resource原fixture角色被改变

逐行对照五个Rust note_history原测试：

| 原测试 | 原向量/断言与当前TS对照 |
|---|---|
| direct_remote_resource_update_keeps_both_full_document_snapshots（Rust:417-467） | **仍未签真实性**：Rust独立source/target，先把source初始包应用到target，再仅更新target的resource并在target查两个完整快照；TS:308-333在源库创建笔记/手动snapshot，两次都apply到同一handle并从同一db读取 |
| relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it（Rust:471-533） | TS:336-382保留独立目标库、出站无revision、1/1/2/2回放CAS、缺目标不造resources、reference两项true |
| remote_pin_is_retained_after_unpinned_replay_and_prune（Rust:537-579） | TS:385-406与Rust均为同一库的pin/unpin/Delete链，failure_count两次0及最终pin保留；不能把此处原本单库误报为上行fixture问题 |
| row_sync_transmits_history_dependencies_and_preserves_remote_before_after（Rust:583-675） | TS:146-178保留独立target、未来format/能力失败且目标空、无seq/有pin、before/after及restoreCopy回before |
| immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins（Rust:680-729） | TS:409-443保留tampered failure1、正文/pin、合法retry failure0、Delete不删pin、未来版本failure1且不存在 |

direct-resource不是仅“多写一个expect”的问题：源库已有本地pending，而原target从远端apply后回声被确认；`apply-batch.ts:113,129`据pending选择字段合并分支。错误地只在本地pending时做resource前快照的实现，可被同源库fixture漏检，原独立target场景则会检出。这里记录的是**测试覆盖偏差**，没有声称当前实现必然丢快照；当前代码:433确实调用快照。应恢复原source/target角色与原断言，或提供可核实的等价依据，不能据15绿统签五个原场景。已发C2在现有07范围内处理，未改测试或s03原8回归。

01当前剩余的是通用业务/冲突表实际SQL写者，不是旧note-history副本；07宿主和24命令注册已补但仍有上述fixture及46pending完整性。05原画像测试退pending、06仅缓冲写未worker都按新代码表述，不沿用旧未接事实。四组仍未决，整个插件仍不通过。

## 11. main新注册生命周期/宿主契约回归（fb463 / 7f4）

### 原门禁失败不是此前的paths问题

tip **e4d8616b16ffba8b5c3ef7baba0f0ff11496a65a**、main **fb463060d162d6c261ebb731180bcfaa833e95a2**：typecheck165954-6a2573、boundaries165954-255bb5、importable165954-c829d5均exit0；tests **20261104165954-fab2ca**原exit1：

```text
Test Files 11 failed | 136 passed | 1 skipped (148)
Tests 64 failed | 1694 passed | 20 skipped (1778)
Failed Tests 64
```

无额外Unhandled Errors段。逐FAIL块归类恰为：**62个SlotOccupied**（notes初始化栈，含relation目标Host及support多文件后续宿主）；**1个business b04大型内联数据30000ms超时**；**1个w69 40666ms超过30000ms断言**。后两项不改阈值、不猜测为无害争用，不扩大成算法失败；本轮未重跑其旧向量。

### Root cause与Rust真实默认行为

相对677f，相关sync/notes实现没有改动，F3 `91cdc7d61`将file-deletion-queue.ts:102-106从`??=`改为F1 Slot.provide并返回Disposer。L10旧`asset-retention.ts:15-17`仍返回void、index.ts:169直接调用，既不保存释放也不处理SlotOccupied。

Rust `dstu-storage/src/file_deletion_queue.rs:29-38`的Slot拒重复是正确原语；但消费方 `dstu-vfs/src/vfs/repos/note_revision_repo.rs:522-528`是 **if let Ok(disposer) { scope.add(disposer) }**，占用不导致该安装函数失败，成功注册则由Scope持有/Drop。不能把修复做成低层Slot覆盖先注册者，也不能忽略成功guard的生命周期。

作业**20261104172008-b2036f**，原样fb463快照`/tmp/opencode/R4-main-fb463-retention-PX7ZAQ`，包含原tsconfig，原生Node调用真实notes/vfs/support的既有serviceHost：

```text
first real notes/vfs/support host installed
first host disposed
second real host failed: SlotOccupied service slot already occupied
  registerNoteAssetRetention → registerNotesAssetRetention → notes/index.ts:169
退出码 1
```

实际执行完整first.dispose后仍失败；没有替换注册函数/伪造错误，也没有Vitest转换层，因此与§9归档配置错误不同。

### 候选修复与审计期间新main分开

已读L10候选 **4d363afa4c5871d4f1dd77a018d3c9db1511da15**：注册包装返回Disposer，index:212-219以ctx.effect立即保存并释放journal/retention注册；这确实修复了顺序重装泄漏的一部分。

**20261104173312-2fabc7** 是明确的同kernel组合：fb463主树 + 仅notes目录4d363，真实StorageServiceImpl、createPaths、vfs-repos/notes，未用不完整storage facade。

```text
candidate first host installed
candidate sequential reinstall passed
candidate concurrent host failed: SlotOccupied service slot already occupied
  registerDeletionJournal → notes/index.ts:213
退出码 1
```

前段安装/释放/重装返回，整体仍失败；候选不能称全修。第二Host保持活跃时再装一个Host，是现有note-history关系测试使用的真实组合；新journal重复策略与retention的Rust if-let-Ok消费需由owner协调，不能为了绿删除原业务断言。

审计期间L10进入main **7f4fb688b6a9f2929b671432c2b7c1ce5dd292b7**，两个注册消费文件与该候选无差异。只补主线真实F3顺序生命周期验证 **20261104174905-f091b7**，每次安装后assert.ok(ctx.notes)、随后完整dispose：

```text
main7f4 real host installed 1
main7f4 host disposed 1
main7f4 real host installed 2
main7f4 host disposed 2
退出码 0
```

不能再把fb463“不释放disposer”描述成新7f4消费者现状。但7f4旧support测试宿主仍缺notes新worker实际使用的正式F3接口。只测首次安装的 **20261104175042-bd0522** 结果：

```text
main7f4 support fixture startup: TypeError ctx.storage.registerMaintenanceParticipant is not a function
  notes/index.ts:118 → sync-support/tests/service-host.ts:13
退出码 1
```

同main用真实StorageService可顺序安装，现有facade却失败，清楚区分生产注册改进和测试宿主契约缺失。support的这些失败尚未到业务断言；L20 relation用例则已完成早前CAS检查，到第二Host安装时失败，不能把整条用例称为未运行。677f下的02/03/04、support S02/S03/S05签收按原SHA保留，不凭setup错误判为算法回退，也不宣称当前组合全可用。

所有原日志/完整脚本在`/home/dsdev/.oc-jobs/done/<id>.log`。证据已经coord信箱送C2协调F3/L10/L20b，未向parked L20追加任务，未修改任何实现/测试或增加兼容fallback。本轮没有重复完整64用例，后继主线合入后再最小闭环。
````

## WP-C2-D1-004：F3/F4 独立验收初稿与 F4 phase0 映射抽检（2026-11-05）

结论：**草案及五条映射审读完成；F3/F4 均为初稿、非全域通过，B 级不成立。** 五条 CorpusManifest 映射未发现硬映射；F3 仍有结构解码、Host 同步 IO、journal 所有权缺口，F4 journal 字节域首错顺序存在偏差。下方两份完整草案仅寄存在本 audit，待协调者授权最终路径。

### 固定基线、授权与计数口径

- 本包独立工作树 `/home/dsdev/dev/ds-mig/R4-review-sync`，分支 `ds-mig/R4-review-sync`。开工 clean；有其他会话的 Vitest/集成作业，全部验证经共享绝对路径 `jobs/job.mjs` 排队。
- 完整阅读 WORKER、R4 任务卡、ORCHESTRATION-v3、standard-v2，以及本包目标域 F3 的 LANE/BLOCKERS/TESTMAP、F4 的 secrets/LANE、util/BLOCKERS、platform/TESTMAP、两份 migration SPEC。R4 没有独立的实现 LANE/TESTMAP；旧 sync/backup 审计历史保留，不将本包变成旧任务续修。
- 开工执行 `git merge --no-edit main`：从 `74d303b42` fast-forward，实际 HEAD/main 均为 **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**。以下源码行号及实跑均固定于这棵树；没有混用候选分支。
- phase0 base **`87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494`**，tip **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**；映射提交 **`247143c989c61ef003714b29ace191dc44e63774`**。已实际读取 `git diff 87b1032a7 967f43c75 -- migration/testmap/F4-security.md`。
- `git show main:<路径>` 核实：共享 JsonReader/base64、L07 build/validate/notice、F3 owner 注册 API、L10 实际 journal repository/注册、L11 `getInlineDataWithConn` 都已在 main。不能继续沿用旧 LANE 的“供方尚未合入”作为这些接缝的阻塞理由。
- 唯一人工写入 `docs/dev/electron-migration/audits/R4-review-sync.md`。未改实现、测试、SPEC、TESTMAP、契约、超时或审批；未编译/运行 Rust，未装依赖。
- **路径授权阻塞**：最终应为 `migration/acceptance/F3-storage.md`、`migration/acceptance/F4-security.md`，均不在本包 allowlist。`scripts/electron-migration/ledger.mjs:72-77` 对 F lane 只读这两个最终路径，且任何 `- [ ]` 都使 review 不成立；audit 中的草案不计 B。请 C2/C1 授权后原文落盘，不能绕过白名单或抹去未勾选项。

以下按实际表格 ID 行统计（包含 `tokio::test` 等类型，不仅筛选 `test`，不使用旧 generated header）：

| 域 | phase0 base | phase0 tip / 本包开始 | 本包结束应保持 |
|---|---|---|---|
| F3，362 行 | 321 ported / 8 merged / 30 obsolete / 3 pending | 324 / 8 / 30 / 0 | 同左；本包零映射改动 |
| F4，300 行 | 245 ported / 29 merged / 9 obsolete / 17 pending | 245 / 34 / 9 / 12 | 同左；本包零映射改动 |

F3 的三条 pending→ported 同时新增真实测试实现，**不放入 F4 纯映射批的分母**。本轮抽查其中图片一条，另外两条 Anki 不冒称已独立签收。F3 本地 LANE/BLOCKERS/TESTMAP 仍写 pending=3、F4 SPEC/平台摘要仍有旧 pending 数；本包无这些文件写权限，只在此订正，不沿用旧数字。

### phase0：五条 CorpusManifest 映射逐断言核对

共同 Rust 前缀为 `src-tauri/crates/dstu-core/src/task_objects.rs::tests::`，共同 TS 文件为 `host/plugins/agent-skills/tests/task-objects-manifests.test.ts`，权威映射位置 `migration/testmap/F4-security.md:80-84`。抽检 **5/5（100%）**；不是仅核标题。

| Rust id 后缀及原位置 | 原 assert → TS expect（逐项） | 结论 |
|---|---|---|
| `corpus_manifest_keeps_same_name_files_as_distinct_entries`，1517-1533 | total=2（1523→154）；entries.len=2（1525→156）；两个 display_name 均为报告.pdf（1526/1527→157/158）；handle 不同（1528-1531→159）；全部 ref_count=1（1532→160）。6→6 | 对应成立 |
| `corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count`，1536-1565 | total=2（1550→171）；首次出现 a/b 顺序（1553/1555→173/175）；引用计数3/1（1554/1556→174/176）；全页 ref_sum=4（1558-1564→177-180）。6→6 | 对应成立 |
| `corpus_manifest_notice_states_totals_and_readback_path`，1568-1584 | 21、第1页20、corpus_abc、共2页、artifacts:corpus/corpus_abc.json、object_read、totalCount=21、分母：1573/1574/1575/1576/1577-1580/1581/1582/1583→189/190/191/192/193/194/195/196。8→8 | 对应成立 |
| `corpus_manifest_pages_are_snapshot_immutable_after_source_change`，1587-1611 | before=after（1596→206）；旧页 handle=sha_v1（1597-1600→207-208）；含v1/不含v2（1601/1602→209/210）；新清单 handle=v2（1606-1609→213-214）；manifest id 不同（1610→215）。6→6 | 对应成立；原测试只构造新 handle，未测试修改传入对象的 alias/deep-freeze，不把此映射扩张为该保证 |
| `corpus_manifest_validate_rejects_bad_shape`，1614-1673 | page_size=0（1616→219-221）；total_count错（1621→224-225）；未来schema（1626→226-229）；跨页重复handle（1638→235-236）；第二页号7（1642→240）；非末页不满（1662→251-252）；空页（1672→259）。7→7，TS额外约束错误片段 | 七种坏shape均是实际调用同一生产 validate/builder，没有自写替身 |

夹具也已核：Rust 的 `corpus_handle`/`distinct_corpus_handles` 与 TS `:18-35` 构造相同 handleId/name/sha；同名与去重不是拿两个不同输入冒充同一情形。原测试 33 条 assert 均有 33 条 expect 对应。

**真实调用链（已逐跳阅读）**：

1. `chat/index.ts:185-194` 在 `vfsRepo.attachments.getInlineDataWithConn` 存在时注册；真实 provider 方法位于 `vfs-repos/repository/attachments.ts:385`，不是只有测试接口。
2. `chat/src/stage-context-command.ts:11-14` 注册 `chat_v2_stage_context_attachments`，调用 `stageContextAttachments`；`attachment-stage.ts:20-24` 从 **agent-skills/api.ts** 导入，不用 L05 objects 副本。
3. `attachment-stage.ts:632-651` 检查 session/4096 上限、逐项 stage，超过64才走 `materializeCorpusManifest`；`:598-628` 调公共 builder、落真实 JSON 文件、计算产物 handle/hash 并调用 notice。
4. `agent-skills/src/tools/task-objects.ts:259-301` 按 handleId 去重/计数/分页，`:300` 调 `validateCorpusManifest`；`:305-344` 的 schema/id/pageSize、页号/空页/过大页/非末页不满、refCount=0、重复和总数分支对应 Rust `:635-692`。
5. TS 原名测试从 `../api.ts:8-16` 调同一实现。chat 补充回归 `tests/stage-context-attachments.test.ts:212-235` 经真实 `host.invoke`，核页数、实际落盘字节、大小/hash、notice。**其 VFS attachment 端口是显式 Map fixture（:143-151），不是实库 VFS 端到端测试**；kernel、chat 编排、L07 builder/validate、文件 IO 为真实。这不妨碍五条纯 manifest 原测试映射，但不能借它签收整个附件/VFS 域。

保留四条 pending 的理由未被这五条消除：分页原测试 `task_objects.rs:1473-1513` 还含 decoder roundtrip；derived edge/schema-v1/batch 的完整生产消费不在本包签收范围。未发现硬映射，不触发整包拒收候选上报。

### 本包亲跑结果（共享 jobs）

所有命令均由 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- <命令>` 启动，cwd 为本 lane。完整原日志统一在 `/home/dsdev/.oc-jobs/done/<job>.log`。

| 范围 / 实际命令 | job | passed / failed / skipped | Errors / exit |
|---|---|---|---|
| `npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/task-objects-manifests.test.ts host/plugins/chat/tests/stage-context-attachments.test.ts -t 'corpus_manifest_(keeps_same_name\|dedupes_repeated\|notice_states\|pages_are_snapshot\|validate_rejects)\|paginates above MAX_AUTO_STAGE_ITEMS'` | `20261105140241-79ddaf` | 6 / 0 / 27（标题过滤） | 无 Errors 行 / 0 |
| `npx vitest run -c vitest.host.config.ts host/platform/storage/tests/workspace-deletion-owner.test.ts host/platform/storage/tests/staged-upload-runtime.test.ts host/platform/storage/tests/feature-flags-service.test.ts host/platform/storage/tests/image-quality-native.test.ts` | `20261105140442-39cb76` | 33 / 0 / 0 | 无 Errors 行 / 0；有 WASI ExperimentalWarning |
| `npx vitest run -c vitest.host.config.ts host/platform/settings/tests/backup-decoding.test.ts host/platform/secrets/tests/credential-decoding.test.ts host/platform/secrets/tests/publication-typed.test.ts` | `20261105140443-6875bb` | 40 / 0 / 0 | 无 Errors 行 / 0 |

原始汇总：`Test Files 2 passed (2); Tests 6 passed | 27 skipped (33)`；`Test Files 4 passed (4); Tests 33 passed (33)`；`Test Files 3 passed (3); Tests 40 passed (40)`。共 **79 passed / 0 failed / 27 标题过滤 skipped**；不是 F3/F4 全目录结果，也不是79条原 Rust 测试的独立映射签收。提交后的绝对路径 lane-gate 收据进入工作包交付报告。

其他共享作业收据：

| 检查 | job | 原输出 / exit |
|---|---|---|
| `npm run typecheck:host`（开工基线） | `20261105140241-1f898c` | `tsc -p tsconfig.host.json`，无诊断 / 0 |
| `node scripts/electron-migration/importable.mjs host/platform/storage/index.ts host/platform/secrets/index.ts host/platform/settings/index.ts host/platform/settings/backup-commands.ts` | `20261105141108-baab8b` | `importable: ok` / 0 |
| `node --input-type=module -e <下述临时数据探针>` | `20261105141020-e28a2c` | 下列观测原文 / 0；不是Vitest，无passed/failed/skipped计数，无Errors行 |

探针安装真实 `log`、`secrets`、`storage`、`settings` 插件及 `createPaths`，不替换业务实现；将三个输入依次写入本次临时宿主的 `feature_flags.config`，调用 `ctx.featureFlags.load({getSetting: ctx.settings.get, saveSetting: ctx.settings.save}, '1.0')`（实际用闭包绑定方法）。publication 输入为 `Buffer.concat([Buffer.from('{"version":false,"extension":"'), Buffer.from([255]), Buffer.from('"}')])`，写入本次临时根的journal，再调用 `ctx.secrets.publication.recover(root,null)`；最后用Node assert逐字节确认journal未变，finally dispose整个临时宿主。

```text
F3 flags [] ACCEPTED defaults
F3 flags {"broken":{}} ACCEPTED {}
F3 flags null REJECTED Cannot convert undefined or null to object
F4 journal known-type-before-invalid-byte InvalidData 密钥发布 journal 损坏，拒绝在不确定密钥状态上启动: invalid utf-8 sequence of 1 bytes from index 30
F4 journal bytes preserved=true
```

这是反例观测，exit0表示探针执行完成，不表示业务等价通过。Rust `feature_flags.rs:121` 的HashMap必须拒绝顶层数组/null，空FeatureFlag缺必填字段；TS前两项却接受，第三项缺Rust parse前缀。F4错误顺序依据 `serde_json-1.0.149/src/de.rs:269-290,319-341,1506`：u32遇false即报invalid_type，不预读后面的非法UTF8字节；本机只读源码位于 `/home/dsdev/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/serde_json-1.0.149/src/de.rs`。TS `util/index.ts:137-143` 预验整份bytes，确实先报index30。没有运行Rust，也未将“拒绝坏journal且文件保留”误写为密钥安全回退。

### 可直接落盘草案一：`migration/acceptance/F3-storage.md`

以下围栏内为完整文件内容；当前不创建该路径。

~~~markdown
# F3-storage 独立验收（R4-review-sync，2026-11-05）

结论：**不通过（初稿，非全域通过）**。固定审读树 `967f43c7547d1ed29a7e3d736b8118fb95d3661e`，工作包 WP-C2-D1-004。本轮完整分支审读3个高风险入口：1条 IPC 命令、2个公共服务入口；仅1条原 Rust 测试完成独立断言抽查，均不足15条命令/15条原测试。补充回归33 passed 不能充抵这个审读门槛。

## 必须修复 / 验收阻塞

- [ ] **R4-F3-D1-01：feature flags 持久化边界及 f32 未等价。** `host/platform/storage/feature-flags.ts:177-190` 直接 `JSON.parse as Record<string, FeatureFlag>` 后 `Object.entries`，没有 Rust `src-tauri/crates/dstu-storage/src/feature_flags.rs:20-32,115-131` 的 struct/enum/必填字段校验；重复已知字段被覆盖。`null` 的 Object.entries 错误也越过 parse 包装。`:85-95,130-134,221-225` 使用 f64 bucket/阈值/随机数，Rust `:15,29,176-183,435-445` 是 f32。必须由 F3 用已发布的共享 reader 完成领域解码/错误优先级与 f32 行为；不能再写成 F4 原语未发布的依赖阻塞。
- [ ] **R4-F3-D1-02：staged append 仍占 Host 线程。** Rust `staged_upload.rs:477-479` 把写盘放 spawn_blocking；`host/platform/storage/index.ts:425-430` 直接调 `staged-upload.ts:194-217`，其中 open/write/close 为同步 IO，最大块16MiB。保留原偏移串行和 abort 顺序迁出 Host 线程；现有短写/u64测试通过不证明线程边界通过。异常 close 与原写入错误优先级也尚无运行证据（`:210` finally close 可覆盖 write 错误；Rust File Drop 不把 close 错误覆盖 Result）。
- [ ] **R4-F3-D1-03：workspace journal 仍绕过 L10 所有者且存在 number 存储路径。** `file-deletion-queue.ts:380-418,483-535` 在 F3 直接 INSERT/SELECT `__file_deletion_journal`，`:393-397,489,508-521` 用 number size/普通查询；Rust `file_deletion_queue.rs:249-254,348-422` 保留 u64→i64 位级转换/比较。D1/D3 要求在同一 savepoint 调 L10 的业务仓储，不能拆事务。供方已在 main：`host/plugins/notes/repository/deletion-journal.ts:18-23,40-83` 有 safeIntegers/bigint，`notes/index.ts:213-216` 已注册；F3 `deletion-journal-owner.ts:23-41` 的正式接缝已发布却未被本路径消费。L05 workspace_index 已委托 owner，不应把这部分已完成的进展与 journal 余项混在一起。
- [ ] **R4-F3-D1-04：补足未审域与故障分支证据。** 启动恢复完整 decoder/切槽续作、migration coordinator/maintenance/finalizers、llm_usage 整数聚合、其他 staged 命令、跨平台路径/IO错误、Anki两条新增移植尚未全审。至少15条命令/15条原测试的独立审读门槛未达；本初稿不授全域 B。
- [ ] **R4-F3-D1-AUTH：正式验收路径未授权。** 当前文件内容仅寄存 `docs/dev/electron-migration/audits/R4-review-sync.md`；需 C2/C1 授权 `migration/acceptance/F3-storage.md` 后落盘，并保留上述未勾选项。ledger.mjs:72-77 不读取 audit。

## 已审入口：完整分支表（证据为静态审读，实跑覆盖另列）

### 1. `staged_upload_append`

定位：契约 `contracts/ipc/F3-storage.json:893-914`（Request 注入、u64结果、string错误）；SPEC `migration/spec/F3-storage.md:642-658`；Rust `src-tauri/crates/dstu-storage/src/staged_upload.rs:251-298,379-479` → Host `storage/index.ts:425-430` / `staged-upload.ts:194-227,287-370`。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| header offset先解析；trim、前导+、非法/溢出拒绝 | :384-390 → :302-309,326 | bigint保持完整u64；header失败早于body分支，已确认 |
| Raw：缺id→缺offset→块长；复制输入 | :392-400 → :328-334 | 文案/顺序已对应 |
| JSON对象：body合法id/offset优先、否则header；data必填→UTF8长度上限→base64 | :401-423 → :352-367 | 默认/顺序对应；base64通过F4公共API。已投影JS number不能证明原始JSON number token/大整数的全部入站语义，留给后继kernel联合验证 |
| 数字数组：header→长度→逐元素u8；其他类型拒绝 | :424-443 → :336-350,370 | 已审；没有为坏body改默认值 |
| append：块长→登记项→偏移→超声明abort | :251-276 → :194-207 | 累计received受4GiB上传上限约束；header超安全整数仍精确比较/报原十进制 |
| open/write_all失败abort；成功后才received/last_touch | :277-288 → :208-217,287-300 | 短写循环、EINTR重试、WriteZero、单调时钟已实现；线程边界及close错误见D1-02 |
| abort无登记幂等；有登记先移除再删文件 | :292-298 → :220-227 | 删除失败仍best-effort；TS多一条debug，不把它说成Rust原warn |
| IPC失败 | :472-479 → index:428-430 | 字符串CommandError；Rust阻塞任务join错误路径未由当前同步实现提供 |

所有权仅暂存目录/登记表，无SQL；Rust Mutex 在 TS 无 await 的 append 段内无交错。迁线程必须继续保留每上传偏移原子性。本轮没有将 StagedFile 所有消费者的 dispose 路径签收。

### 2. `featureFlags.load` → `isFeatureEnabled`

定位：这是服务而非新增IPC命令；SPEC `F3-storage.md:64-79`，生产提供方 `storage/index.ts:94-109`，正式类型 `storage/api.ts`；Rust `feature_flags.rs:115-194,262-445` → `feature-flags.ts:177-227,268-335`。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| get_setting失败；无值初始化；有值解析失败/成功 | :115-131 → :177-190 | 读取错误前缀已保留；无值默认表对应；有值typed边界未完成，见D1-01 |
| 补齐缺省但不覆盖已有flag，继承userId | :135-144 → :203-210 | 已确认；18个默认flag及debug浏览器分支逐项读过（:262-395 → :268-300） |
| 缺flag→false；min/max版本→依赖→state | :156-173,407-432 → :213-218,322-330 | 次序对应；Vec<u64>字典序、不补尾零、非法段=0、溢出=0已实现 |
| Disabled/Enabled；Gradual有/无用户；UserSpecific有/无用户 | :173-193 → :219-226 | 分支存在，f32精度及随机采样域未等价；不因原测试绿而全勾 |

设置读写走F4业务store，无复制settings SQL。所审 Rust load/evaluate 无 warn/error；没有为它虚构日志要求。原语 JsonReader 已在 main，但本入口尚未消费。

### 3. `prepareWorkspaceDeletion`

定位：D1/D4公共事务服务，SPEC `F3-storage.md:49-54`；Rust `file_deletion_queue.rs:238-292,340-422,704-763` → `storage/file-deletion-queue.ts:380-418,458-535,792-847`。真实调用 `agent-workspace/src/workspace/database.ts:262`；owner在 `agent-workspace/index.ts:68` 注册，`storage/workspace-deletion-owner.ts:15-18` 消费。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| autocommit检查→PRAGMA FULL→路径验证/根内普通文件 | :243-250,340-345,704-750 → :385-395,459-462,792-831 | 次序可见；非autocommit拒绝；路径/平台完整等价未签收，TS把反斜杠统一当分隔符，与Unix Path规则不同 |
| 文件存在：hash/metadata；缺文件：None/None | :249-257,752-763 → :392-398,834-847 | hash内容/64KiB循环对应；fs.existsSync会把部分IO错误折成false，而try_exists传播非NotFound；open/stat/close错误包装不完全统一。不能据正常文件测试签全部故障路径 |
| UUID/存储路径→SAVEPOINT→prepared INSERT/读回比对 | :258-271,348-422 → :399-404,483-535 | 原子边界存在；直接SQL/size精度待D1-03；operationId冲突拒绝，不做覆盖 |
| 同连接删workspace_index→RELEASE→返回 | :272-282 → :405-408 | 已经由真实L05 owner删除；物理文件尚未删除，已核实 |
| 内部失败ROLLBACK TO+RELEASE后抛原错 | :284-289 → :409-416 | 真实owner SQL失败用例证明回滚两条元数据且留文件；TS还将RELEASE失败纳入catch并多记rollback warn，与Rustmatch外release错误路径不同，未签故障全等价 |

## 已核实通过及测试证据

- [x] 三个高风险入口都有真实注册/provide/消费路径；L05删除在prepared之后、release之前，以同一SqlExecutor完成。SQL失败回滚没有拆成两个事务。
- [x] 定向测试 job `20261105140442-39cb76`：workspace-deletion-owner 3、staged-upload-runtime 19、feature-flags-service 10、image-quality-native 1，共 **33 passed / 0 failed / 0 skipped / exit0，无Errors行**；WASI warning保留，不当失败或屏蔽。命令为 `npx vitest run -c vitest.host.config.ts` 加上述四个 `host/platform/storage/tests/*.test.ts` 路径，经共享jobs运行。
- [x] 原测试 `src-tauri/crates/dstu-storage/src/file_manager.rs:1513-1527::bytes_quality_matches_base64_policy_and_limits_dimensions` 对 `tests/image-quality-native.test.ts:18-27`：同1200×900黑色PNG，JPEG标识加真实解码尺寸768×576、base64解码字节等于bytes。F7真实image WASM经 `native/image/index.ts` 消费；F3 `storage/index.ts:124` 发布imageQuality。不是只改TESTMAP。仅确认本原测试，不授所有像素类型/质量路径或C级差分签收。
- [x] 权威TESTMAP保持 **324 ported / 8 merged / 30 obsolete / 0 pending（362行）**，本包前后零改动。pending清零不消除上述v2缺口。
- [x] 类型检查 `20261105140241-1f898c` exit0；原生入口导入 `20261105141108-baab8b` 为 `importable: ok` / exit0。真实插件/SQLite探针 `20261105141020-e28a2c` 复现 `[]` 接受为默认表、`{"broken":{}}` 接受空flag、`null` 返回无parse前缀的 `Cannot convert undefined or null to object`；该作业exit0为观测完成，不是反例通过。

## 未审范围与建议

其余32条F3命令没有完成逐分支独立审读；另外两个服务入口不冒充命令数。Anki两条新增真实移植未逐assert签收。storage事务/维护、恢复状态、迁移、文件流、预算和llm_usage尚需后继按风险拆包。现存SPEC部分全勾及LANE旧自验记录不是独立通过证据；后继由owner更新过时文档，并由独立复核人回签本文件。
~~~

### 可直接落盘草案二：`migration/acceptance/F4-security.md`

~~~markdown
# F4-security 独立验收（R4-review-sync，2026-11-05）

结论：**不通过（初稿，非全域通过）**。固定审读树 `967f43c7547d1ed29a7e3d736b8118fb95d3661e`，WP-C2-D1-004。完整分支审读3个高风险入口：`get_backup_config`、`commitStagedCloudCredentials`、`publication.recover`；后两者是公共服务，不充作IPC命令。独立原测试映射抽查5条，不足15命令/15原测试；40条补充回归不等于40条原测试已验收。

## 必须修复 / 验收阻塞

- [ ] **R4-F4-D1-01：journal的整文件UTF-8预解码改变首错顺序。** `host/platform/secrets/crypto-publication.ts:66-67` 先 `decodeUtf8Strict(bytes)` 才进入typed reader；Rust `src-tauri/crates/dstu-security/src/crypto_publication.rs:139-145` 是流式 `serde_json::from_slice`。若首字段 `version:false`、后续字符串含非法字节，Rust应在version的u32 visitor处返回invalid type，TS先报告后面的UTF8错误。`publication-typed.test.ts:36-49` 只覆盖文本trailing，未覆盖此字节域。要求保持原错误顺序/Display；坏journal仍先拒绝且不改密钥的修复应保留。未运行Rust，Rust预期依据锁定serde_json 1.0.149源码，不冒称差分实测。
- [ ] **R4-F4-D1-02：密钥/Drop全退出路径证据不足。** 已确认 `secure-store.ts:809-873` 对device/legacy key及读取buffer有finally清零，`backup-crypto.ts:99-124,169-178,467-473,575-594` 有password buffer、one-shot key、session cache清理。Rust `crypto/backup_crypto.rs:876-887` Drop同时zeroize密码与key；JS `this.password=''` 不能证明不可变string物理清零。尚需审实际消费方finally、异步派生在途dispose及平台keystore生命周期；不因局部fill(0)或测试绿关闭全域Drop。此项是未完成验收，不声称本轮复现所有这些路径有缺陷。
- [ ] **R4-F4-D1-03：范围门槛及跨owner完整链未完成。** 其余43条命令、paths/time/net-policy完整分支、util reader全部字节/数字域、log/diagnostics错误日志、secure store跨实例并发和Win/macOS keystore未全审。cloud_config_publish的L21外层SSOT/许可组合亦未完整复验，不以F4 commit局部审读代签消费者。
- [ ] **R4-F4-D1-AUTH：正式路径授权待C2/C1。** 本文仅存于 `docs/dev/electron-migration/audits/R4-review-sync.md`；未获 `migration/acceptance/F4-security.md` 写权限，不计B。落盘时保留所有未勾选项。

## 已审范围：三入口完整分支表

### 1. `get_backup_config` / typed `BackupConfig`

定位：契约 `contracts/ipc/F4-security.json:480-500`，SPEC `migration/spec/F4-security.md:337-353`；Rust `src-tauri/src/backup_config.rs:28-83,115-118` → Host `settings/backup-commands.ts:29-50,98-104` / `settings/backup-config.ts:35-44,73-153`。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| settings查询失败；无记录；有记录 | :74-82 → commands:42-50 | 数据库错误包装独立；无记录Default.max=5，有记录{}的字段default.max=None，两者未混淆 |
| 6字段按声明顺序解码 | :28-52 → config:108-127 | directory/tiers/max为Option，bool显式null拒绝，interval/u32上限精确；tiers None省略，Some空数组保留 |
| 对象已知重复/未知字段；非对象拒绝 | derive → :139-146 | seen在读取第二值之前拒绝；unknown走IgnoredAny；不因未知重复键误拒 |
| positional struct数组，短尾default/满六项收尾 | derive → :128-137 | 每字段有serde(default)，短尾补值；额外项优先endArray而非读取坏额外值 |
| tier字符串/外标签unit map、alias/未知变体 | BackupTier定义由SPEC定位 → :73-98 | 支持core_config_chat/vfs_full/large_files；原型名不当alias；unit值与额外键收尾已核；完整serde库错误全集未签 |
| 字段失败与尾随输入 | serde from_str → :148-152 | 已测文本首错及UTF8列；统一“解析备份配置失败”并由commands:34映射CommandError |

真实SQL读路径 `settings/index.ts:42-61` → 自有 `settings/repository/settings.ts:27-30`；对应 Rust `dstu-storage/src/database/mod.rs:4122-4130`。无写入、无事务、无新增取消点；Rust此命令没有warn/error，不加虚构日志要求。此审读没有把同一文件其余调度/目录清理命令算作完成。

### 2. `secrets.openStore().commitStagedCloudCredentials(expectedGeneration: bigint)`

定位：`contracts/ipc/F4-security.json:182-237` 的cloud_config_publish由SPEC `F4-security.md:157-173`定位到提供方；真实消费者 `backup/src/cloud-config.ts:870-911` 调stage→SSOT save→commit。F4 provider `secrets/index.ts:64-94,109-111`；Rust `dstu-security/src/secure_store.rs:2518-2540,2585-2659` → `secrets/secure-store.ts:1030-1045,1064-1100`。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| active缺失=0；pointer损坏拒绝 | :2518-2527 → :1030-1035,557-563 | trim/+ASCII/u64范围，bigint不经Number；错误不默认为0 |
| active=expected：无staged成功；同代删除；异代拒绝 | :2593-2607 → :1066-1073 | 幂等清障三分支均存在，不删除其他代记录 |
| active不同：staged缺失；代不符；active+1溢出/不等 | :2610-2625 → :1075-1082 | KeyNotFound/GenerationConflict文案及顺序对应；MAX_u64精确 |
| typed staged解析先于发布 | :2397-2399,2534-2538 → :570-600,1038-1045 | generation/credentials必填，known重复、u64浮点、Option/default、map/seq按字段处理；unknown走共享IgnoredAny |
| 快照旧active；新有secret写入、空则删除 | :2627-2636 → :1083-1085 | 快照失败/active写失败均不推进pointer；无数据库事务或凭据明文SQL |
| pointer成功；失败回滚有/无旧active；回滚再失败warn；最后删除staged | :2640-2659 → :1086-1099 | 顺序保持，失败抛原pointer错误、staged留待重放；warn不输出凭据JSON。删除staged失败发生于已提交之后，不回滚pointer |

底层 `saveSecret/getSecret` 的device/legacy key清零及legacy迁移best-effort日志已读（`:809-873`）；命令串行队列仅在 `secrets/commands.ts:13-34`，不能据它断言所有openStore实例/服务调用共享锁。外层L21并发与完整失败注入矩阵仍在D1-03。此局部结果不授cloud_config四命令全通过。

### 3. `secrets.publication.recover(root, activeLease)`

定位：SPEC `F4-security.md:25` 的crypto publication及F3启动接缝；Rust `dstu-security/src/crypto_publication.rs:25-38,59-83,112-231` → `secrets/crypto-publication.ts:28-47,66-110,116-198`。真实消费 `storage/data-space.ts:100-110` 先验证active slot/lease后调用；`storage/index.ts:87`注入真实publication。

| 分支 / 次序 | Rust → Host | 独立结论 |
|---|---|---|
| 读journal NotFound清旧rollback→Clean；其他IO抛 | :130-138 → :168-174 | 不把权限错误当无journal；清理失败传播 |
| struct解码先于任何key/rollback副作用 | :139-145 → :175-180 | 对象必填/Option/重复、八位数组、u32/布尔已审；整字节预解码的首错差异见D1-01 |
| backup/slot都Some且与lease匹配→前滚；有lease但不匹配→InvalidData | :147-168 → :181-190 | 先删rollback再删journal再info；错误分支不动key，日志无密钥内容 |
| 无lease：按master→secure顺序回滚 | :172-187 → :192-193 | 顺序相同；各步失败立即停止，后续journal保留 |
| saved存在：删除target→rename旧文件→权限恢复；saved缺失且无旧/有安装：删新target；其他不动 | :195-218 → :129-145 | symlink_metadata.is_ok对应lstat；remove按目录/文件分类，NotFound幂等；恢复权限含secure直属普通文件 |
| rollback清理→目录fsync→journal删除/fsync→warn | :188-192 → :194-198 | Unix fsync有finally close；Windows no-op分支存在但未原生实跑；清理IO失败不写成功日志 |
| 权限遍历失败best-effort | :220-230 → :116-126 | read_dir失败允许继续；底层restrictPermissions跨平台全部分支未签收 |

此入口不解析/打印密钥内容，操作文件归F4；无额外前端取消点。Rust File的Drop对应TS finally close，仅确认代码落点，尚未故障注入验证所有close错误优先级。

## 已核实通过

- [x] 上述F4三入口生产可达，设置表写者仍在F4自有repository；L21仅调用公开secrets能力。服务/命令计数没有混用。
- [x] job `20261105140443-6875bb`：`settings/tests/backup-decoding.test.ts` 10、`secrets/tests/credential-decoding.test.ts` 12、`secrets/tests/publication-typed.test.ts` 18，**40 passed / 0 failed / 0 skipped / exit0，无Errors行**。运行 `npx vitest run -c vitest.host.config.ts` 加这三个完整 `host/platform/` 路径，经共享jobs；使用真实settings SQLite、kernel或安装后的secrets服务和真实临时文件，不是JSON形状自断言。
- [x] phase0五条Corpus映射 **5/5逐assert核实**，原33 assert对应33 expect；Rust `task_objects.rs:1517-1672` → `agent-skills/tests/task-objects-manifests.test.ts:150-259`。同名6、去重6、notice8、快照6、坏shape7，包含七种坏shape及旧/新manifest独立断言。真实chat→公共builder→validate/notice链已核；job `20261105140241-79ddaf` 五条原名加一个kernel产物样本 **6 passed / 0 failed / 27标题过滤skip / exit0，无Errors行**。VFS供方是测试fixture，未冒称VFS全链验收。
- [x] 五条映射未发现硬映射；phase0 base `87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494`、tip `967f43c7547d1ed29a7e3d736b8118fb95d3661e`、提交 `247143c989c61ef003714b29ace191dc44e63774`。逐断言/生产链完整证据在同包audit，不能扩展为其余四条L07 pending已通过。
- [x] 权威TESTMAP保持 **245 ported / 34 merged / 9 obsolete / 12 pending（300行）**；本包不改去向。F3另外3条真实新增移植未混入这5条纯映射分母。
- [x] 类型检查 `20261105140241-1f898c` exit0、原生导入 `20261105141108-baab8b` exit0。临时真实secrets插件探针 `20261105141020-e28a2c` 把 `{"version":false,"extension":"` + 单字节FF + `"}` 写入journal，得到 `InvalidData ... invalid utf-8 sequence of 1 bytes from index 30`，文件逐字节保留。Rust首错应来自前面的false/u32：锁定serde_json 1.0.149 `src/de.rs:269-290,319-341,1506`；未执行Rust，故是源码对照+TS反例，不是动态差分。

## 未审与已登记平台差异

paths/time/util/net-policy只追踪了本包消费到的公开原语、未做全域逐分支审读；未签Windows DPAPI、Linux桌面keyring、macOS交互、Rust写出密文动态向量。JS字符串清零、字节decoder首错是独立事项，不能用平台差异自述直接豁免。原SPEC全勾/自报A级与本次独立范围分开；本文件保留未勾选项，不建立B级。
~~~

## WP-C2-VERIFY-014：L19 包外 browser 映射与密码接管独立核验（2026-11-06）

结论：**第1项映射通过；第2项 c741 自有逻辑与 Rust 一致，但新增断言只覆盖测试夹具，生产 Electron 路径不触发接管，不通过（不能据此关闭 X6-LP-0089 / BLOCKERS §5）。**

### 固定基线与范围

- 审读树固定为 **`ebe5aee1ec34e03e5257421b3a012212c6032f6a`**（L19 交付，父 `902f4736b`），含 `bee7e50b5`（TESTMAP 一行 pending→ported）与 `c741b5a3e`（`bridgeMaybeTakeover` + 5 条新增用例）；`ebe5` 本身只改 `host/plugins/browser/BLOCKERS.md`。没有读取 L19 活树或后继 WP118 WIP。
- **与 main `136320e68` 的区别**：三个提交都不是 `136320e68` 或本包合入后 main `1defd30af` 的祖先。main 上的 TESTMAP:119 仍是 `pending`，`browser-tool-executor.ts` 没有 `bridgeMaybeTakeover`（出现 0 次）；`ebe5..main` 在 browser 目录内的差异正好是这三个提交的反向 diff（5 文件 +17/−153）。`index-status-wiring.test.ts` 在 ebe5/136320e68/main 三处 md5 相同（`34aeab6a…`）。`vfs-index` 在 ebe5→main 之间有大量改动，但 main 的 `vfs-index/index.ts:110` 仍保留 `getStatusSummary`。下面的结论只对 ebe5 有效；L19 合入 main 时需要重新跑一遍。
- 本包只写这一个 audit 文件。没有改 L19 的实现、测试、TESTMAP 或 ACCEPTANCE，没有运行 Rust。

### 1. bee7e50b5：`webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state` → `browser/tests/index-status-wiring.test.ts`

Rust 原测试位于 `src-tauri/src/chat_v2/tools/index_webpage_executor.rs:1327-1368`；TS 用例位于 `index-status-wiring.test.ts:80-122`。原测试共 9 个 assert 和 7 个 expect（结果可用性），全部核对如下：

| Rust | 断言 | TS | 结论 |
|---|---|---|---|
| :1332-1333 expect | `persist_webpage` 成功 | :84-85 `saved.success` | 对应。TS 走 `execute`，比直接调核心函数更外层 |
| :1335 | disposition=Created | :87 `'created'` | 对应。生产映射在 executor `:557-558` |
| :1336 | units_created>0 | :88 | 对应 |
| :1337-1340 | file 存在且 extracted_text==markdown | :90-91，`formatWebpageMarkdown` 是同一生产函数 | 对应 |
| :1341 | blob_hash.is_some | :92 toBeTruthy | 对应 |
| :1343-1352 | resource.metadata.source==url | :93-94 | 对应 |
| :1353-1356 | index_state=="pending" | :95 | 对应 |
| :1357-1360 | `get_status_summary` 成功，total_units≥units_created | :97-100 经 `builtin-index_status`，:101 与 `vfsIndex.getStatusSummary()` 相等 | 对应，且更强 |
| :1361-1362 | `ensure_rebuild_target` 通过 | :105-112 rebuild 在第 2 个 isCancelled 返回 CANCELLED（"after target validation"） | 对应。第 2 个检查点只在 `ensureRebuildTarget` 返回后才执行（executor `:414-424`，Rust `:198-224`）；目标缺失时会先报 RESOURCE_NOT_FOUND，所以收到 CANCELLED 就证明目标校验已通过 |
| :1364-1366 | 重复保存 Existing | :114-116 `'deduplicated'` | 对应。Existing→deduplicated 是生产标签（Rust `:443-446` / TS `:559`） |
| :1367 | 重复保存 file.id 相同 | :117 | 对应 |

**获取状态摘要与真实执行入口的区别**：Rust 测试直接 `VfsIndexService::new(db).get_status_summary()`。TS 不调用替身，而是走生产注册路径：`browser/index.ts:136-157` 构造 `IndexWebpageToolExecutor`，`:161-169` 经 `agentTools.registerToolExecutors` 注册；测试 `:62-63` 从 `host.ctx.agentTools.toolExecutors()` 取回同一实例。`statusSummary` 端口（`index.ts:152-155`）→ `vfsIndex.getStatusSummary`（`vfs-index/index.ts:104`）→ `VfsUnitIndexService.getStatusSummary`（`unit-sync-service.ts:190`），读真实迁移后的 SQLite。L12 早已发布的 `getStatusSummary` 只是被测入口下游的一个依赖；被测入口是 `executeStatus` / `executeRebuild` / `executeWebpageSave`。宿主安装真实插件 paths/vfs-repos/notes/vfs-index/vfs/agent-skills/browser，storage 是真实 `createStorageService` 加迁移。设置和 feature flags 是测试提供的值，与本条断言无关。

结论：**通过**。11 项全部对应，没有弱化，被测符号都从生产入口可达。附带建议，不影响本条：
- TS 走 `execute`，所以会执行 `validateWebUrlForSave` 的 DNS 解析（executor `:162-185`，与 Rust `:897-899` 同源语义）。Rust 测试直接调 `persist_webpage`，不依赖网络。离线沙箱里 TS 用例会因 DNS 失败；这是环境脆弱性，不是映射差异。
- TESTMAP 的 GENERATED 表头 `:12` 仍写“pending 2 · ported 104”，与行内实际状态（1 pending）不符，应由协调者重新生成。

**超出本条断言范围的生产差异（未在此签收；按 C2 指令另留后继工作包，本包不扩展）**：Rust `persist_webpage` 在活跃文件已存在时（`:640-652`），只有 `folder_id` 有值才调 `add_item_to_folder`，否则不碰 folder_items。TS `persistWebpage`（executor `:595-611`）无论是否已存在都会调 `createFileWithDocDataInFolderOutcome`；后者在已存在分支 `vfs-repos/repository/files.ts:357-371` 无条件执行 `ensureFolderAssignment(null)`，`folders.ts:1058-1066` 会先 DELETE 再插入根目录行。结果是：不带 folder_id 重复保存一个已放在文件夹里的网页，TS 会把它移到根目录，Rust 不会。本测试中首次保存也在根目录，观察不到这个差异。

### 2. c741b5a3e：密码 BLOCKED → take_over

对照 Rust `src-tauri/src/chat_v2/tools/browser_executor.rs:190-223,338-356`，调用点为 `:604` click、`:658` type、`:845` set_input_files。

| 项 | Rust | TS（ebe5） | 结论 |
|---|---|---|---|
| 判定 | `:205-223`：仅 `BridgeError::Bridge`；code 用 ASCII 忽略大小写比较 BLOCKED；`reason=="password_field"` 或 message 的 ASCII 小写含 "password" | `tool-executor.ts:114-119` 同一条件；`browser-tool-executor.ts:262-263` 还要求不是 `BrowserFailure` 且有字符串 `kind` | 等价（JS `toLowerCase` 是 Unicode 小写，与 ASCII 比较只在 U+212A 这类字符上有理论差异，是既有代码，不计入本包） |
| 调用点 | 只有 click/type/set_input_files 三处，snapshot `:459` 与 scroll `:940` 用普通 `map_bridge_err` | `:410/:441/:583-585` 三处，其他调用点未改 | 对应 |
| 接管与事件 | `take_over_with_reason("password_blocked")`（`service.rs:993-1003`）：守卫关闭、take_over、emit control-mode-changed(user, reason) | `browser-service.ts:586-591,994-1007` 相同顺序；payload 是 camelCase，与 `events.rs:72-74` 的 `rename_all` 一致 | 对应 |
| 接管失败 | warn `password BLOCKED take_over failed: {Display}`，`NotFound` 显示为 `Not found: no active browser session` | `:268-269` warn，`errorText(BrowserFailure)` 来自 `command-result.ts:25`，文本相同 | 对应 |
| 接管成功 | info `password BLOCKED → forced user take_over` | `:267` 相同 | 对应 |
| 原错误传播 | 无论接管成功与否都返回 `map_bridge_err(e)` → `[BROWSER_PASSWORD_BLOCKED] 密码/OTP…` | `:271` 原样 rethrow，`execute`→`mapAnyError`（`:190-196`）→`mapBrowserToolBridgeError`，前缀相同 | 对应 |
| 非密码 BLOCKED | `[BROWSER_BLOCKED] msg \| details=…`，不接管 | 测试 `:314-326` 断言该文本、controlMode 保持 agent、无事件、无日志 | 对应 |

新增 5 条用例（`tool-executor-execute.test.ts:281-367`）覆盖了 click 带 details.reason、type 只靠 message 和小写 code、非密码分支、接管失败 warn 分支、setInputFiles 调用点，断言都是精确值。用例使用真实 `BrowserRuntimeService` 和真实 `BrowserToolExecutor.execute`。

**不通过的原因：夹具不是生产错误形状。** 测试中的 `FakeSurface`（`:54-63,84-97`）直接 reject 一个普通对象 `{kind:'Bridge',code,message,details}`。生产中 browser 插件只用 `ShellBrowserSurface`：`index.ts:107-108` 取 `ctx.get('browserSurface')`，而 host 或 electron 中没有任何代码 provide `browserSurface`。`ShellBrowserSurface` 的 click/typeText/setInputFiles（`surface-host.ts:114-124`）走 `ctx.shell.request`，错误链是：
1. `electron/shell/browser-protocol.ts:145-152` 先丢掉 details，再 `throw new Error("bridge error <code>: <message>")`；
2. 协议 `host/kernel/protocol.ts:198-200` 的 `ShellResponse` 只有 `error: string`；
3. `host/kernel/shell.ts:64` reject 为 `ShellError(op, string)`。

`ShellError` 是 `Error`，没有 `error` 或 `kind` 属性，所以 `browser-tool-executor.ts:262` 的条件恒为假，不会接管。`mapAnyError:195` 把它映射为 `[BROWSER_BRIDGE_ERROR] bridge error BLOCKED: …`，前缀也不同于 Rust 的 `BROWSER_PASSWORD_BLOCKED`。全仓唯一能产生 `{kind:'Bridge'}` 的是 `browser/src/bridge.ts:58` 的 `intoResult()`，它返回 Result 而不是 throw，也不在这条调用链上。ebe5 的 BLOCKERS §5 自己也写了“Electron 真实路径上不会触发移交”。以上是源码推断，没有另写动态探针。

因此，任何“浏览器目录全绿”（无论 457 还是 462 条）都只能证明夹具形状下的自有逻辑，不能证明生产 Shell 错误链已打通。（更正：WP118 是 MCP probe，与 browser Shell 错误链无关；本节早先写的“WP118 壳桥探针”有误。）

**生产修复范围**：
- **F2/F1**：browser-protocol 与 ShellResponse/ShellError 需要把 code/message/details 带回 Host（由 owner 决定传输形式）。
- **L19**：随后让 `ShellBrowserSurface` 还原 typed BridgeError，或在 `bridgeMaybeTakeover` 识别正式错误面；并在测试中用真实 `ShellService` 加 shell-result 失败回复替换普通对象夹具，同时断言接管和 `BROWSER_PASSWORD_BLOCKED` 前缀。
- **c741 自有逻辑本身不需要改**。

### 运行证据（与上面的源码推断分开）

为避免接触活 L19 树，我建了私有 detached worktree `/tmp/opencode/wp014-ebe5`（HEAD `ebe5aee1e`，clean，node_modules 软链到本 lane 的依赖），在其中经共享 jobs 运行：

| 命令 | job | 结果 |
|---|---|---|
| `npx vitest run -c vitest.host.config.ts host/plugins/browser/tests/index-status-wiring.test.ts host/plugins/browser/tests/tool-executor-execute.test.ts -t 'webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state\|summary read failure\|map_bridge_err_maybe_takeover\|password BLOCKED from setInputFiles'` | `20261105192348-e619d5` | `Test Files 2 passed (2)`；`Tests 7 passed \| 11 skipped (18)`（被标题过滤跳过）；没有 Errors 行；exit 0 |

7 条 = index-status 2 条 + takeover 4 条 + setInputFiles 1 条。没有修改预算或断言。较早的 L19 作业 `20261104152324-d8eca2`（index-status 2 passed）在 L19 活树上运行，且早于 L11 在 ebe5 之前合入的 vfs-repos 改动（`9c69c4776` 等），所以不作为 ebe5 的证据。`20261105191023-73ccb8`（462 passed）的工作目录也是活树，树状态没有固定，不予采信。

**资格结论**：第1项映射可登记为 ported；第2项自有逻辑等价，但生产路径不可达，X6-LP-0089 保持未签，等待生产 typed 错误链打通（C2 已将依赖转 C1→F2/F1/L19）。最终裁定由 C2 作出。
