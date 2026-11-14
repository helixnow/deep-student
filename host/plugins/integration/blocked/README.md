# L22 阻塞测试目录（当前为空）

此前保存在这里的 `sync-conflict-fast-path.test.ts.txt` / `sync-history-e2e.test.ts.txt`
（L20 冲突解决 / 快照回退命令未进 main 时的逐字副本）已不再需要：

- main `4dc4c8ed9` 的 `host/plugins/sync/index.ts:219-221` 真实注册
  `data_governance_resolve_record_conflict` / `data_governance_rollback_sync_snapshot_batch`。
- 两个副本由 `69a368177` 移除；原文可用
  `git show 69a368177^:host/plugins/integration/blocked/<文件>` 取回。
- live 用例在 `tests/sync-conflict-fast-path.test.ts`、`tests/sync-history-e2e.test.ts`
  （WP-114 改为真实 F3 storage + L21 备份许可 + L20 冲突守卫制造冲突 + worker 线程第二连接复现竞争窗口）。
- TESTMAP 对应 4 行均为 `ported:`。
