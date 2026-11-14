结论：部分完成，已定位完整 C/D 的冷加载、逐项落盘提交与校验慢阶段；未找到已证等价的主要开销优化，5秒性能验收阻塞，D35未闭合。

## 提交与范围

- 测量工具：`43837175f`、`9b99bda5c`（协调者自动检查点），明确测量提交 `0ffa29d69`。
- 测量分析与状态收据：`214f7e5ce`、`1bafe6f2f`、`b66a82a58`（自动检查点）；最终结论提交见交付tip。
- 无优化实现提交；本包没有修改生产迁移实现。`migration-worker.ts`、`worker-entry.ts`、
  `worker-pool.ts`、`connection.ts`、`migration/` 对 main diff 为空。
- 所有改动在允许的 storage/ 与 migration/spec/F3-storage.md；未修改 L21/X1 测试或预算。
  分支包含此前 WP-008/WP-059/WP-127 交付，不把它们计成本包产出。

## 测量结论

完整方法、单调时钟边界、命令与原件见 `host/platform/storage/WP-081-PERFORMANCE.md`。
固定输入 `/tmp/opencode/WP081-seed-20261106` 是独立真实F3启动迁移生成的active库；每轮新进程/冷worker，
新空C，C结束后在线克隆同一输入到D，再完整执行runAll。不是缓存C/D或预热诊断worker。

| 实际样本 | C worker / clone / D worker（ms） | 合计（ms） |
|---|---|---:|
| Node26 带阶段/原生I/O探针 | 6490.02 / 209.29 / 1964.07 | 8666.51 |
| Node26 无探针 | 11494.26 / 118.75 / 2213.16 | 13828.93 |
| Electron45.2.1 带探针 | 12970.73 / 226.98 / 2443.13 | 15643.01 |

核心定位（Node带探针样本，ms）：
- 冷worker到preload243.56；preload→task加载826.85；task构造/封装22.95。
- C迁移执行3676.42，其中COMMIT2415.64；**1084次真实fsync2398.11**。
- C校验1681.46 / D校验1707.38；其中scratch重放947.13 / 1039.35，各131条SQL。
- 慢库是VFS：C执行2473.56/校验1113.98；D执行149.97/校验1110.22。
- Electron样本fsync次数同为1084，但耗时8152.14ms；说明本机样本的实际同步I/O等待有明显波动。
  不以跨时刻样本差额判Node/Electron优劣或推算探针开销，不推断Rust同机耗时。

无探针Node及带探针Electron分别与Node测量原件比较：8库schema/history/checksum/
canonical fingerprint/PRAGMA/integrity、完整内部报告、364条业务日志级别和顺序一致。
可用磁盘量、快照时间/PID、路径/threadId/duration属于明确列出的运行时归一化量；错误原文不归一化。
首轮比较因磁盘量/快照ID动态量返回1，明确修正分析器后两次返回0；原件不变。
这证明探针未替换结果，**不是优化前后提速证据**（生产未改）。

## 为什么不作未经证明的优化

- 已完整阅读WP-005报告及原件`20261105150749-4d236e`：原kernel诊断10306.492ms > 5000，
  单条红例是最终5秒断言，完整报告此前断言已通过。
- Rust refinery `traits/sync.rs:84-99` / `drivers/rusqlite.rs:39-45` 要求SQL与history各自独立事务。
  不能把本次测得的COMMIT/fsync视为可以合并的冗余。
- Rust `coordinator.rs:4755-4768,5008-5079` 每次scratch完整重放求管理范围；TS与其一致。
  不能缓存C的诊断/校验结果代替D、跳scratch、删检查或更改SQL。
- `coordinator.rs:282-428` 预检、恢复重试、备份guard、依赖顺序、迁移/验证和失败恢复保持；
  `commands.rs:1199-1217` 串行完整C/D保持。FULL持久性保持。
- 文件读取/checksum只占较小部分，当前没有已证的足量等价优化。此结论不声称未来绝无可行优化。
  Node样本仅C/D coordinator.runAll已7346.75ms，完全消除外围/加载也不足以达5000ms。

## 验证与作业

| 项目 | job | exit | 结果 |
|---|---|---:|---|
| 起点 typecheck | `20261105175622-aa74cf` | 0 | 无Errors |
| Node 最小migration-worker回归 | `20261105175622-cc1210` | 0 | passed3 / failed0 / skipped0，无Errors |
| Electron同一最小回归 | `20261105181208-64625c` | 0 | passed3 / failed0 / skipped0，无Errors |
| 独立active seed生成 | `20261105180111-0c7c17` | 0 | 真实四库迁移 |
| Linux只测量I/O探针编译 | `20261105180111-e7551c` | 0 | 现有cc，零警告、未装依赖 |
| Node分阶段和真实I/O | `20261105180542-66dab8` | 0 | 8库integrity=ok、C71/8/29/23、D全0 |
| 无探针Node | `20261105180837-040b37` | 0 | 同输入正常完整返回，仍超过5秒 |
| Electron分阶段和真实I/O | `20261105180837-e11cb6` | 0 | 同输入同结果，仍超过5秒 |
| 无探针Node与Node测量原件比较 | `20261105182658-f24fa1` | 0 | 8库/完整内部报告/364日志一致 |
| Electron与Node测量原件比较 | `20261105182658-89ff15` | 0 | 同上 |
| ledger --check --no-write | `20261105181604-f477e4` | 0 | commands/tests/orphan problems均0 |
| wiring `--lane storage` | `20261105181604-925b47` | 0 | 该工具只扫描host/plugins，未扫描F3平台台账 |
| 全量strict边界（静态） | `20261105181604-f1996a` | 0 | 3069 files /0 violations |
| lane-gate typecheck | `20261105181209-de9bc8` | 0 | 无Errors |
| lane-gate boundaries | `20261105181209-123305` | 0 | 无违规 |
| lane-gate strict(changed) | `20261105181209-ae0445` | 0 | 9 files /0 violations |
| lane-gate importable | `20261105181209-1b0ca2` | 0 | storage/index.ts可原生类型擦除加载 |
| lane-gate 自动F3目录测试 | `20261105181209-b6dfd4` | 0 | 49 files /606 passed /0 failed /1既有fixture环境skip，无Errors |

自检：官方lane-gate exit0，5/5全部通过；记录头`0ffa29d69`，基线main`4723d8d46`，
收据`.oc-runs/selfgate/F3-storage.json`，完成时间2026-11-05T18:23:04.685Z。
上述各检查job均exit0；最终收尾文档及汇总器动态日志归一化不冒充已在该记录头中。
汇总器最终版本由`20261105182658-f24fa1`/`89ff15`两项同输入原件比较单独验证，未重复全目录测试。
除协议门禁自动F3目录测试外仅做上面的最小F3回归。所有旧断言/超时/fixture环境skip未改。

strict中F3相关原文：
```text
(allowed) host/platform/storage/tests/busy-capability-probe.mjs:8:3 [console-log]
boundaries: scanned 3069 files, 0 violation(s), 239 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

wiring原文（不将0项当362条接线证明）：
```text
合计 ported 0，其中所测模块未从 index.ts 接入 0（0%）
```

ledger最后一行原文：
```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 89.1% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 14 (unknown 3619, not vetoed)
```
该命令输出为全局口径，不把它改写为F3性能或独立B/C验收百分比；本包没有增加业务A/B/C完成量。

## TESTMAP

pending前0 → 后0；实际324 ported /8 merged /30已批准obsolete，共362行。
本包更改Rust测试去向条目：**无**。性能脚本无Rust测试ID，不新增ported，不改GENERATED区块。
已在storage/TESTMAP、LANE、BLOCKERS顶部说明本包证据与D35状态。
api.ts无本包新增签名/不兼容变化，无npm/native依赖申请。

## 未完成、阻塞与交接

1. 原完整诊断5s未达；X1 85/175/180也未改、未重跑全量，不宣称验收绿。
2. 已经coord queue两次请求C2组合本候选与L21现成原
   `host/plugins/backup/tests/migration-diagnostic.test.ts`跑Node/Electron；F3未编辑该测试。
   direct runner不代替kernel整条8段报告、清槽和5s断言；等待独立组合收据。
3. L21等待的是已测慢阶段的等价性能处置，不是缺MigrationWorker接口。
   本包未证得足量等价优化，按brief如实保持D35 open，请C2/C1安排后继针对同步提交/校验继续论证。

## 供抽检

1. Node原件中的`sqlite.disk.COMMIT`270次/2415.64ms与I/O TSV中1084次fsync/2398.11ms，
   对照Rust refinery SQL/history分事务源码；确认不是把整个COMMIT都冒充纯I/O。
2. `migration-profile-hooks.mjs`只追加原函数pass-through；同seed比较8库和364日志；
   对照L21原测试最后5000ms断言未改，D35未因direct runner正常返回而关闭。
