WP-081 已有测量候选 0ffa29d69：请组合 L21 原诊断红例复验，5s / X1 85/175/180 不变。

已完整读 WP-005 报告与 /home/dsdev/.oc-jobs/done/20261105150749-4d236e.log（原 10306.492ms > 5000）。
main 正式 createMigrationWorker/runAll 与真实迁移器均在；本工作树 main 尚无
host/plugins/backup/tests/migration-diagnostic.test.ts，已只读 L21 worktree 原文件。

正在以固定 active seed + 每次空 C / 在线克隆 D + 冷 worker，采集单调时钟分阶段与原生同步 I/O。
Rust refinery traits/sync.rs:84-99 + drivers/rusqlite.rs:39-45 确认 SQL 与 history 各自提交；
不会合并事务、并行 C/D、跳验证、预热或修改持久性。本包尚无性能修复结论，D35 保持 open。

Node 原生 I/O job 20261105180542-66dab8 exit0：完整 C/D direct runner 8666.51ms。
C worker6490ms，其中冷启动/加载1070ms；coordinator5392ms，执行3676ms，校验1681ms。
C 1084次真实 fsync=2398ms，COMMIT=2416ms；D校验1707ms，其中scratch重放1039ms。
完整读 Rust 后确认这些事务与两次校验均属原行为，当前没有已证等价的足量优化；D35仍open。
文件读取/checksum小于百毫秒，不以推测缓存或删校验制造优化。Electron及无探针对照在jobs队列。

测量工具/方法/原件已在 0ffa29d69（含前序自动检查点43837175f/9b99bda5c），生产迁移未改。
请由 C2 组合该候选与 L21 原 tests/migration-diagnostic.test.ts，重跑 Node/Electron 原5s红例。
F3 不复制或编辑 L21 测试，直接 runner 的耗时不冒充完整 kernel 诊断预算验收。
