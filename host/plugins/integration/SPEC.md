# L22-app-commands 行为规格（`host/plugins/integration/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 0 个 · 发出事件 4 种 · 契约：`contracts/ipc/L22-app-commands.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：本 lane 无命令。事件载荷的 `Option` 字段由发送方 crate（`dstu-qbank`、`dstu-vfs`）的 serde 决定，迁移时随所属 lane 保持；这里只锁事件载荷形状（见各事件小节）。
- [x] u64/i64 超过 2^53 的表示：事件载荷没有超过 2^53 的整数（`total_chars`/`question_index` 等均为 usize 计数）；`latencyMs` 属 L02 的连接测试结果，不在本 lane 的事件里。
- [x] 字段顺序（serde_json preserve_order）：四个事件的键序固定为：`mistake_status_update` → `mistake_id`；`qbank://changed` → `exam_id`,`reason`；`question_import_progress` → `type` 在前（`#[serde(tag = "type")]`），`import_id` 由 `commands.rs:1177-1184` 追加到末尾；`csv_import_progress` → `type` 在前，其余为变体字段。
- [x] f32 精度：事件载荷不含 f32。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：本 lane 无命令；事件发送失败只记日志（`commands.rs:1186-1188`、`1757-1759`），不影响命令返回。命令错误按所属 lane 的 `AppError`（`{error_type,message,details}`）/ `CommandError`（`{code,message,data?,traceId?}`）契约处理。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：题目集导入在 `tokio::select!` 中监听取消令牌（`commands.rs:1220-1225`），取消后仍会排空进度通道再返回错误；CSV 导入在每行写入前检查令牌（`commands.rs:1775-1776`）。事件转发任务本身不因取消中止，通道关闭即结束。迁移属 L14，保持同样取消点。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：事件转发是独立 task + 无界 mpsc（`commands.rs:1162`、`1748`），发送顺序等于服务产生顺序；本 lane 的 `ctx.appCommandState.withTempSessions` 回调保持同步，等价持有 `temp_sessions` 的 Mutex 临界区，不跨 await。
- [x] 时间与 ID：生成方式、格式、时区：事件本身不生成时间/ID；`import_id` 由前端生成并通过 `commands.rs:1180-1183` 原样回填，空串被过滤（`commands.rs:1764`）。`qbank://changed` 的 `exam_id` 来自服务写入结果。
- [x] 不对含 HashMap 的结构做序列化后比对：本 lane 的测试不做此类比对；`audit/commands.json` 按命令名排序，不哈希序列化结果。

## 事件 `csv_import_progress`

<!-- BEGIN GENERATED:event:csv_import_progress -->
- 事件名 `csv_import_progress`
- 发送点：`src-tauri/src/commands.rs:1757`（emit）
<!-- END GENERATED:event:csv_import_progress -->

- [x] 载荷：`CsvImportProgress`（`crates/dstu-qbank/src/question_import_service.rs:4040-4062`，`#[serde(tag = "type")]`）：`Started{total_rows,file_path,exam_id}` / `Progress{current,total,success,skipped,failed,exam_id}` / `Completed(CsvImportResult)` / `Cancelled(CsvImportResult)` / `Failed{error,exam_id}`；`CsvImportResult` 见同文件 3938-3948（`cancelled` 带 `#[serde(default)]`）。
- [x] 触发时机与顺序：`start_questions_csv_import` 创建无界 mpsc 与独立转发 task（`commands.rs:1748-1762`），服务按行发送；命令结束前等待转发任务。
- [x] 节流/合并：无节流，逐行 `Progress` 直发。
- [x] 是否在事务提交后：CSV 导入逐行写库后发送进度，不是单一事务；取消保留已写入行（`commands.rs:1775-1776`）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit("csv_import_progress", payload)`（`commands.rs:1757`），全部监听者。

## 事件 `mistake_status_update`

<!-- BEGIN GENERATED:event:mistake_status_update -->
- 事件名 `mistake_status_update`
- 发送点：`src-tauri/src/commands.rs:969`（emit）
- 发送点：`src-tauri/src/commands.rs:999`（emit）
<!-- END GENERATED:event:mistake_status_update -->

- [x] 载荷：`{"mistake_id": string}`（`commands.rs:969-972`、`999-1002`）。
- [x] 触发时机与顺序：`update_exam_sheet_cards` / `rename_exam_sheet_session` 在服务更新成功后按 `updated_mistake_ids` 顺序逐个发送。
- [x] 节流/合并：不合并；每个 id 一条事件。
- [x] 是否在事务提交后：服务更新返回后再发送（服务层事务语义属 L18/L14 的实现）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit`，全部监听者；发送失败被忽略（`let _ =`）。

## 事件 `qbank://changed`

<!-- BEGIN GENERATED:event:qbank://changed -->
- 事件名 `qbank://changed`
- 发送点：`src-tauri/src/commands.rs:1378`（emit）
- 发送点：`src-tauri/src/commands.rs:1446`（emit）
- 发送点：`src-tauri/src/commands.rs:1523`（emit）
- 发送点：`src-tauri/src/commands.rs:1569`（emit）
- 发送点：`src-tauri/src/commands.rs:1605`（emit）
- 发送点：`src-tauri/src/commands.rs:1626`（emit）
<!-- END GENERATED:event:qbank://changed -->

- [x] 载荷：五处是 `{"exam_id": string, "reason": string}`：`authoring_committed`（1378-1381）、`group_updated`（1523-1526）、`legacy_migrated`（1569-1572）、`reparse_resolved`（1605-1608）、`group_deleted`（1626-1629）；**例外** `qbank_update_material`（1442-1449）发 `{"reason":"material_updated","material_id": string}`，没有 `exam_id`。前端监听器若只读 `exam_id`，材料更新事件会得到 `undefined`；迁移时须原样保留该形状，除非协调者决定修正 Rust 契约。
- [x] 触发时机与顺序：各自业务服务返回成功后发送；`qbank_commit_authoring_draft` 仅在 `receipt.committed` 时发送（1375-1382），`qbank_update_material` 在 `update_material` 成功后发送（1442-1449）。
- [x] 节流/合并：不合并，每次成功写操作一条。
- [x] 是否在事务提交后：服务返回即写库完成（同步服务），随后发送；发送失败被忽略。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit`，全部监听者。

## 事件 `question_import_progress`

<!-- BEGIN GENERATED:event:question_import_progress -->
- 事件名 `question_import_progress`
- 发送点：`src-tauri/src/commands.rs:1186`（emit）
- 发送点：`src-tauri/src/commands.rs:1324`（emit）
<!-- END GENERATED:event:question_import_progress -->

- [x] 载荷：`QuestionImportProgress`（`crates/dstu-qbank/src/question_import_service.rs:63-133`，`#[serde(tag = "type")]`）：`Preprocessing{stage,message,percent}`、`RenderingPages{current,total}`、`OcrImageCompleted{image_index,total_images}`、`OcrPhaseCompleted{total_images,total_chars}`、`SessionCreated{session_id,name,total_chunks}`、`ExtractingFigures{current,total}`、`StructuringQuestion{current,total}`、`QuestionParsed{question,question_index,total_parsed}`、`ChunkStart{chunk_index,total_chunks}`、`ChunkCompleted{chunk_index,total_chunks,questions_in_chunk,total_parsed}`、`Completed{session_id,name,total_questions,partial,failed_count}`、`Failed{session_id,error,total_parsed}`。
- [x] 触发时机与顺序：流式导入（`commands.rs:1162-1191`）与恢复导入（`1312-1329`）各自建立转发 task；`import_id` 非空时追加到对象末尾，空串被过滤（1300-1301、1764）。
- [x] 节流/合并：无节流，服务每次 `send` 一条事件。
- [x] 是否在事务提交后：按解析/写库阶段产生；`Completed.failed_count` 统计写库失败题数，不表示整体事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit`，全部监听者；发送失败只记 error 日志。

## 服务 `appCommandState`

<!-- 本 lane 无命令；服务是本 lane 唯一的生产扩展点。 -->

- [x] 服务名与版本：`appCommandStateService = { name: 'appCommandState', version: '1.0.0' }`（`api.ts`）；Cordis `declare module` 声明 `ctx.appCommandState: AppCommandState`；`index.ts` 的 `meta.provides` 为 `['appCommandState']`，`AppCommandStateService` 构造器用描述符 `.name` 注册。依据 `docs/plugins/ARCHITECTURE.md` 附录 A。
- [x] `activeDatabase`：`'production' | 'test'`，默认 `'production'`，对应 `commands.rs:655-666` 的 `ActiveDatabaseKind::{Production,Test}`；Rust 侧由 `RwLock<ActiveDatabaseKind>` 持有（`commands.rs:719`），Host 侧单线程直接读写字段，不提供跨 `await` 的快照保证。
- [x] `withTempSessions(operation)`：同步回调接收内存 `Map<temp_id, StreamContext>`，在返回前执行容量驱逐；等价于 Rust `cache_temp_session` 持 `temp_sessions.lock().await` 的临界区（`commands.rs:202-210`）。“回调必须同步”是 API 约定（`api.ts` 注释），实现不检测返回值是否为 Promise；回调中 `await` 之后对 Map 的修改不会再触发本次驱逐，因此调用方不得跨 `await` 使用该临界区（2026-11-04 v2 自查更正：旧文说“实现中抛错”不属实）。
- [x] 容量与驱逐：`TEMP_SESSION_MEMORY_CAP = 8`（`commands.rs:181`）。当 `sessions.size > 8` 时反复驱逐最旧项：先按 `created_at` 的 chrono `DateTime` 比较（F4 `parseRfc3339(...).epochNanos`，含闰秒归一化与原始纳秒精度），相同则按 `temp_id` 的 Rust `String` 字典序（UTF-8 字节序，`Buffer.compare`），逐个删除直到 `size === 8`（`commands.rs:185-200`）。
- [x] 持久化边界：驱逐只删内存，不删除 `temp_sessions` 表记录；DB 始终是完整数据源，驱逐后可回读（`commands.rs:178-180`）。`withTempSessions` 本身不写回持久层（Rust 同：只有 `modify_temp_session` 持久化）。
- [x] 错误：`created_at` 不是合法 chrono RFC3339 时抛 `TypeError('Invalid chrono DateTime: …')`（Rust 的 `DateTime` 在反序列化阶段就会失败，不会进入驱逐）；没有事件、没有日志、没有网络副作用。Rust 该函数无 `warn!`/`error!` 日志点。
- [x] 所有权拆分：`APP_STATE_OWNERS` 把 `commands.rs:681-719` 的 23 个字段映射到所属 lane；本服务只保留 `activeDatabase` 与临时会话内存，不构造聚合 `AppState`、不创建第二份共享服务实例。消费者应注入各 owner 的服务，不得把本服务当数据库句柄。
- [x] 消费契约：`host/platform/storage/index.ts:124` 通过 `ctx.get('appCommandState')` 读取 `activeDatabase` 以选择生产/测试槽位；该平台代码没有 Cordis `inject` 元数据，能力目录因此报告“已提供但无运行时消费方”。待接线：`host/platform/storage` 声明 `inject: ['appCommandState']` 并改经 `ctx.appCommandState` 访问（F3/协调者）。
- [x] 测试：`tests/app-state.test.ts` 4 条 `commands.rs::tests::temp_session_cap` 用例，经 `ctx.appCommandState` 生产服务调用；v2 自查后逐条对应 Rust 断言（`commands.rs:5989-5991` 长度不变、`6005-6007` 长度=8/无 t0/有 t8、`6021-6025` 长度=8/无 t00..t02、`6038-6040` 长度=8/无 t00），ID 格式按 Rust `t{i}` / `t{i:02}`。另 2 条补充用例（纳秒精度、服务卸载）不占 TESTMAP 行。
- [x] 完整性说明：Rust `cache_temp_session` / `remove_temp_session` / `get_or_restore_temp_session`（`commands.rs:202-240`）在 Rust 中**无调用者**（死代码），不移植；唯一被调用的是 `modify_temp_session`（下一节）。`withTempSessions` 的 Map 值为完整 `StreamContext`（api.ts）。

### `modifyTempSession`（L18 pin/unpin 消费，已发布 api.ts，服务 1.1.0）

- [x] 入口：Rust `commands.rs:248-285`；L18 `pin_images`/`unpin_images`（`:356-395`）经 `ctx.appCommandState.modifyTempSession(tempId, mutator)` 消费，返回更新后的 StreamContext 副本（Rust `Result<StreamContext>`）。
- [x] 回调同步修改完整 `StreamContext`；错误以 `CommandError(AppError)` 抛出。

| Rust 分支 | 实现（`src/app-state.ts`） |
|---|---|
| :258-263 内存命中 | 原地修改缓存记录，克隆用于持久化；不读 DB |
| :266-272 未命中 | `repository/temp-sessions.ts::getTempSessionRecord`；null → `AppError.not_found('临时会话不存在')`；读失败 → `AppError.database('读取临时会话失败: ' + anyhow 外层文案)`（serde 失败 = `Failed to deserialize stream context`，SQLite/维护屏障 = 存储消息） |
| :273-278 回读成功 | 修改后回填 Map 并在同一临界区按 8 条上限驱逐；驱逐不删 DB |
| :281-282 两路完成 | `upsertTempSession`（mod.rs:4170-4194 同 SQL：`created_at` 列 `to_rfc3339()`、`updated_at` 当前时刻、ON CONFLICT 不改 created_at）；失败 → `AppError.database('持久化临时会话失败: ' + cause)`；已修改的内存不回滚（Rust 同序） |
| 模型 :180-210 | `src/stream-context.ts`：serde 编解码（字段声明序、`mistake_id` 别名、重复/缺失字段失败、`#[serde(default)]`、`None` 省略、未知字段丢弃、chrono `DateTime<Utc>` 规范化为 AutoSi+`Z`）；更深 typed 结构按 Value 精确往返（残余见 BLOCKERS） |

- [x] 真实 SQLite 测试（`tests/temp-session-modify.test.ts`，真实迁移后的 mistakes 库，经 `ctx.appCommandState`）：命中、未命中回读（旧数据别名/未知字段/时区规范化）、unpin 省略字段、缺失、反序列化失败、别名重复、写失败及内存副作用、超 cap 淘汰仍持久化。
- 设置表 `pinned_images:<id>` 的保存/删除仍由 L18 经 ctx.settings 负责。
