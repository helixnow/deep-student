# R4-SYNC-05 Memory owner 公共接口请求

2026-11-05 WP-004 实核：`git show main:host/plugins/memory/api.ts` 第60行已公开 `mergeProfileJsonForSync(localJson, remoteJson): string | null`。旧“未公开/待main”依赖阻塞解除；剩余为 L20 消费接线及原向量验证，按本包 brief 留待后续工作包。消费后仍需区分 R5-M4 浮点词法/非string fingerprint 已知 owner 差异，不能因原向量绿统签该解码器。

生产调用：sync 的 resources.data 字段合并；需在默认 apply 与冲突应用中使用同一 owner 实现。原 Rust 向量在 `src-tauri/src/sync_app_tests.rs:13-50`：version 3/4、时间 `2026-07-19T10:00:00+00:00` / `2026-07-19T11:00:00+00:00`、目标“本地目标”/“远端目标”，结果 version 5 且保留两目标。原测试已退回 pending，自写 merger 不能作为迁移证据。

# R4-SYNC-06 F3 worker / 文件公开接缝请求

2026-11-05 WP-004 实核：`git show main:host/platform/storage/api.ts` 已公开 createDatabaseWorkerPool、多库任务 context 及 isVirtualUri/rejectDoubleEncodedVirtualUri/queuePersistableSafUri/copyFileVerified；接口发布阻塞解除，剩余消费实现仍属 L20 后续包。

Rust `commands_sync.rs:2374-2504` 把整段导出放 spawn_blocking：依次打开 vfs/llm_usage/chat_v2/mistakes，收集状态/完整变更，写缓冲 JSON，虚拟 URI 先落 appData/temp_sync_export 再 owner copy，成功/失败均清 staging。

原请求契约现已发布：跨四库 open-existing 任务跳过缺失库，消费者只经公共 api 引用；若桌面不可写 URI，也应由文件 owner 在 staging 之后按原 copy 错误返回。

L20 可先完成缓冲序列化，但 worker/URI 生产闭环继续 pending，不将 async 包装宣称线程迁移。
