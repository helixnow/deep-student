# X2 → L18：X2-D01 补充用例（抄送 C1）

R22 已直发；这是同一根因的补充，不新开任务编号。

**根因**：`host/plugins/media/index.ts:98-105` `mediaFailure` 对 MediaError / BiliRequestError 以外的异常原样重抛，内核把它当处理函数 panic，生产中前端 Promise 永不 settle。L18 分支 `bd64e1ff5` 的 :100-107 相同。

| 用例 | Rust 期望 | Host 当前（main 4c6cd1ba8） | 复现 |
|---|---|---|---|
| media_transcribe_cancel 上游失败 | dstu-media commands.rs:375-377 → `{"code":"database-failed","message":...}` | HandlerPanic | batch2 `X2-R22` |
| media_checkpoints SQL 失败 | ledger.rs:255-257 → `e.to_string()` 纯字符串 | HandlerPanic `no such table: questions` | batch3 `X2-R24` |
| media_study_ledger SQL 失败 | ledger.rs:466-476 → `e.to_string()` 纯字符串 | HandlerPanic `no such table: document_tasks` | batch3 `X2-R25` |

注意三个命令的 Rust 错误形态不同（cancel 是 MediaError JSON 字符串，ledger 两条是纯字符串），不能用一个统一包装。只在 DB/上游失败时可达。修复进 main 后 X2 只重跑这三个用例并翻转断言。

同批已对齐、无需动作：media_checkpoints / media_study_ledger 成功 DTO、textbooks_relink NotFound、media_bilibili_playback_error 事件。
测试文件：`scripts/electron-migration/frontend-audit/batch{2,3}.test.ts`。
