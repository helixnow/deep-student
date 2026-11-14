# WP-063 历史 workspace seed

`ws_ws_old.db` 是 C2 作业 `20261105164200-825edc`（exit 0）的只读字节复制：

`/tmp/opencode/c2-wp063-seed-20261105-1643/historical-wp013-v1/app-data/slots/slotA/workspaces/ws_ws_old.db`

来源为 X3 `historical-wp013-v1` / `sql-constructed`，历史 SQL 对照
`41a5ca8f1ff92f761eabd7594b676bcbc75d9e04:src-tauri/src/chat_v2/workspace/database.rs:13–124,142–144`。
这是 SQL 构造的历史 schema 夹具，不是 A 二进制或历史发行版产物；本 lane 未重造 SQL。

V1 八业务表另含 `sqlite_sequence`，`ws_old` / `worker_old` / `message_old`，
inbox id `9007199254740993`、status `unread`。测试只复制到 Host 临时活动槽后打开，
经真实 F3 / agentWorkspace 迁移为 V2；连续 peek 比较所有旧行，drain 只改变对应 inbox 状态，
后续 send 与卸载重装验证共享恢复队列。原 X3-L05-02 断言由 C2/X3 组合验收。
