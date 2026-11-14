# L15-review-analytics 行为规格（`host/plugins/review/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 70 个 · 发出事件 1 种 · 契约：`contracts/ipc/L15-review-analytics.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：返回 `Option<T>` 的 `None` 序列化为 null；命令参数缺省与显式 null 均传 null（作文批改 `Option` 由服务按 Rust 语义处理）。
- [x] u64/i64 超过 2^53 的表示：本 lane 的整数参数/计数（limit、offset、round_number、batch_size、统计值）均远小于 2^53，沿用 JS number。
- [x] 字段顺序（serde_json preserve_order）：返回 DTO 使用生成契约类型；字段顺序不参与断言。
- [x] f32 精度：作文批改分数按服务返回的 JS number 透传，不做额外舍入；与 Rust f32 序列化值一致。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：`AppError` 以 `{error_type,message,details}` 经 `CommandError.value` 原样 reject；review_plan 保持纯字符串错误；handler panic 在生产中表现为 Promise 永不 settle。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：仅 `essay_grading_stream` 注入 `CallContext.signal` 并传给服务；其余命令无取消点。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：SQLite 同步写事务由 kernel 单连接串行化；作文批改/灵感卡服务自行管理其并发。
- [x] 时间与 ID：生成方式、格式、时区：时间与 ID 均由对应服务生成；review 侧保持 RFC3339 UTC 与本地日期约定。
- [x] 不对含 HashMap 的结构做序列化后比对：测试按字段断言，不比较 JSON 字符串。

> `review_plan_*` 中属于 `dstu-vfs` 仓储的部分统一经 L11 公开服务
> `vfsRepo`（旧名 `vfs.repo.core@1`；`questions` / `reviewPlans`）读写，
> 本 lane 不再复制 `review_plan_repo.rs` 的 SQL。L11 已在
> `host/plugins/vfs-repos/api.ts` 发布 `vfsRepo` 并由 `index.ts` 提供；命令层
> 通过 `ctx.get('vfsRepo')` 解析，服务缺失时返回 wiring 错误，不静默降级。
>
> FSRS 记忆模型（`DEFAULT_PARAMETERS`、`effectiveParameters`、遗忘曲线、
> `memoryState` / `nextStates`）统一引用 F7 平台模块 `host/platform/native/fsrs`；
> 本 lane 只保留 Anki 学习步 / 重学步 / fuzz / 逻辑日等调度规则。
>
> `essay_grading_*` 使用 L02 `host/plugins/llm/api.ts` 的 `EssayGradingService`，
> `insight_*` 使用 L17 `host/plugins/memory/api.ts` 的 `InsightCommandService`；
> 服务缺失时返回 Rust 的 `Database: VFS 数据库未初始化`。时间读数和 RFC3339
> 格式化使用 F4 `host/platform/time`，Rust `trim` 语义使用 F4
> `host/platform/util` 的 `rustTrim*`。

## 命令 `essay_grading_create_custom_mode`

<!-- BEGIN GENERATED:cmd:essay_grading_create_custom_mode -->
- Rust：`src-tauri/src/essay_grading/mod.rs:157` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:336`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：input: CreateModeInput
  - 结果：GradingMode · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_create_custom_mode -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_create_session`

<!-- BEGIN GENERATED:cmd:essay_grading_create_session -->
- Rust：`src-tauri/src/essay_grading/mod.rs:37` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:99`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：title: string, essayType: string, gradeLevel: string, customPrompt?: string | null
  - 结果：VfsEssaySession · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_create_session -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_delete_custom_mode`

<!-- BEGIN GENERATED:cmd:essay_grading_delete_custom_mode -->
- Rust：`src-tauri/src/essay_grading/mod.rs:175` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:358`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：modeId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_delete_custom_mode -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_delete_session`

<!-- BEGIN GENERATED:cmd:essay_grading_delete_session -->
- Rust：`src-tauri/src/essay_grading/mod.rs:79` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:151`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_delete_session -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_latest_round_number`

<!-- BEGIN GENERATED:cmd:essay_grading_get_latest_round_number -->
- Rust：`src-tauri/src/essay_grading/mod.rs:127` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:219`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string
  - 结果：integer(i32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_latest_round_number -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_mode`

<!-- BEGIN GENERATED:cmd:essay_grading_get_mode -->
- Rust：`src-tauri/src/essay_grading/mod.rs:144` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:306`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：modeId: string
  - 结果：GradingMode | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_mode -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_models`

<!-- BEGIN GENERATED:cmd:essay_grading_get_models -->
- Rust：`src-tauri/src/essay_grading/mod.rs:219` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:431`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：ModelInfo[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_models -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_modes`

<!-- BEGIN GENERATED:cmd:essay_grading_get_modes -->
- Rust：`src-tauri/src/essay_grading/mod.rs:136` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:293`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：GradingMode[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_modes -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_round`

<!-- BEGIN GENERATED:cmd:essay_grading_get_round -->
- Rust：`src-tauri/src/essay_grading/mod.rs:117` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:205`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string, roundNumber: integer(i32)
  - 结果：GradingRoundResponse | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_round -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_rounds`

<!-- BEGIN GENERATED:cmd:essay_grading_get_rounds -->
- Rust：`src-tauri/src/essay_grading/mod.rs:108` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:191`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string
  - 结果：GradingRoundResponse[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_rounds -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_get_session`

<!-- BEGIN GENERATED:cmd:essay_grading_get_session -->
- Rust：`src-tauri/src/essay_grading/mod.rs:56` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:115`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string
  - 结果：VfsEssaySession | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_get_session -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_has_builtin_override`

<!-- BEGIN GENERATED:cmd:essay_grading_has_builtin_override -->
- Rust：`src-tauri/src/essay_grading/mod.rs:210` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:411`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：builtinId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_has_builtin_override -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_list_custom_modes`

<!-- BEGIN GENERATED:cmd:essay_grading_list_custom_modes -->
- Rust：`src-tauri/src/essay_grading/mod.rs:184` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:369`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：GradingMode[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_list_custom_modes -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_list_sessions`

<!-- BEGIN GENERATED:cmd:essay_grading_list_sessions -->
- Rust：`src-tauri/src/essay_grading/mod.rs:88` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:165`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：offset?: integer(u32) | null, limit?: integer(u32) | null, query?: string | null
  - 结果：VfsEssaySession[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_list_sessions -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_reset_builtin_mode`

<!-- BEGIN GENERATED:cmd:essay_grading_reset_builtin_mode -->
- Rust：`src-tauri/src/essay_grading/mod.rs:201` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:400`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：builtinId: string
  - 结果：GradingMode · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_reset_builtin_mode -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_save_builtin_override`

<!-- BEGIN GENERATED:cmd:essay_grading_save_builtin_override -->
- Rust：`src-tauri/src/essay_grading/mod.rs:192` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:389`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：input: SaveBuiltinOverrideInput
  - 结果：GradingMode · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_save_builtin_override -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_stream`

<!-- BEGIN GENERATED:cmd:essay_grading_stream -->
- Rust：`src-tauri/src/essay_grading/mod.rs:27` · async
- 前端：app（1 处，例 `src/essay-grading/useEssayGradingStream.ts:403`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：request: GradingRequest
  - 结果：GradingResponse | null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:essay_grading_stream -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_toggle_favorite`

<!-- BEGIN GENERATED:cmd:essay_grading_toggle_favorite -->
- Rust：`src-tauri/src/essay_grading/mod.rs:99` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:180`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：sessionId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_toggle_favorite -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_update_custom_mode`

<!-- BEGIN GENERATED:cmd:essay_grading_update_custom_mode -->
- Rust：`src-tauri/src/essay_grading/mod.rs:166` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:347`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：input: UpdateModeInput
  - 结果：GradingMode · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_update_custom_mode -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `essay_grading_update_session`

<!-- BEGIN GENERATED:cmd:essay_grading_update_session -->
- Rust：`src-tauri/src/essay_grading/mod.rs:68` · async
- 前端：app（1 处，例 `src/essay-grading/essayGradingApi.ts:131`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：session: VfsUpdateEssaySessionParams
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:essay_grading_update_session -->

- [x] 输入：按契约接收参数并原样传给 `EssayGradingService`（名称/顺序与 Rust 相同；未传的 `Option` 归一为 null）。
- [x] 输出：直接返回服务结果；`null` 对应 Rust `Option::None` / `()`，不做二次包装。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `get_vfs_db`）。
- [x] 事件：`essay_grading_stream` 把服务 emit 的事件以 `WebviewWindow` 目标发回调用窗口；其余命令不发事件。
- [x] DB 读写：由作文批改服务负责（VFS essay 会话/轮次/自定义模式）；本命令层不直接读写。
- [x] 取消/并发：`essay_grading_stream` 把 `CallContext.signal` 传给服务；其余命令无共享可变状态。
- [x] 时间/ID：由 `dstu_tutor::essay_grading` 对应服务生成。

## 命令 `fsrs_bury_card`

<!-- BEGIN GENERATED:cmd:fsrs_bury_card -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:470` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsBuryResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_bury_card -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsBuryResult`；已处于目标埋藏状态时 `changed=false` 且不写库。
- [x] 错误：`Validation`（空 id）、`NotFound`（state 不存在）、`Database`。
- [x] 事件：`changed=true` 时 emit `fsrs://changed`（source=user、action=bury）。
- [x] DB 读写：immediate 事务读 `fsrs_card_states` / `anki_decks`，更新 `buried_until_ms`、`updated_at`、`local_version+1`。
- [x] 取消/并发：同步 immediate 事务，读改写原子；无中途取消点。
- [x] 时间/ID：`nowMs` 计算次日逻辑日边界；`utcNow()`（chrono AutoSi 单次读数） 写 `updated_at`。

## 命令 `fsrs_enqueue_cards`

<!-- BEGIN GENERATED:cmd:fsrs_enqueue_cards -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:107` · async
- 前端：app（3 处，例 `src/features/flashcards/store/fsrsReviewStore.ts:569`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：ankiCardIds: string[]
  - 结果：FsrsEnqueueResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_enqueue_cards -->

- [x] 输入：`ankiCardIds`（trim、去重；空 id 报错）。内部作用域无 100 条上限（会话/文档选择器另有上限）。
- [x] 输出：`FsrsEnqueueResult`（enqueued / skipped / enqueuedStateIds / states / reviewCards）。
- [x] 错误：`Validation`（空 id、诊断卡，后者带 `details.errorCode=fsrs_diagnostic_card_not_reviewable`）、`NotFound`（卡不存在）、`Database`（标签 JSON 损坏则整批回滚）。
- [x] 事件：有新增 state 时 emit `fsrs://changed`（source=user、action=enqueue），`cards` 为完整卡片内容；全部跳过时不 emit。
- [x] DB 读写：immediate 事务；确保默认牌组，读 `anki_cards` / `document_tasks` / `anki_decks`，写 `fsrs_card_states`（软删除旧 state 时连同日志清除）。
- [x] 取消/并发：整批原子；IMMEDIATE 事务防止并发重复入队。
- [x] 时间/ID：state id = `crypto.randomUUID()`；`created_at` / `updated_at` = `utcNow()`（chrono AutoSi 单次读数）；`due_ms` = now。

## 命令 `fsrs_get_card_memory_history`

<!-- BEGIN GENERATED:cmd:fsrs_get_card_memory_history -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:544` · async
- 前端：app（1 处，例 `src/features/flashcards/memoryCurve.ts:382`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsCardMemoryHistory · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_card_memory_history -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsCardMemoryHistory`（当前状态 + 复习日志 + 遗忘曲线）。
- [x] 错误：`Validation`（空 id）、`NotFound`（state 不存在）、`Database`。
- [x] 事件：无。
- [x] DB 读写：只读 mistakes（`fsrs_card_states` / `fsrs_review_logs` / `anki_decks`），日志最多 2000 条。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：`generatedAtMs` = now；逻辑日按牌组 `dayRolloverHour`。

## 命令 `fsrs_get_due`

<!-- BEGIN GENERATED:cmd:fsrs_get_due -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:129` · async
- 前端：app（3 处，例 `src/features/flashcards/components/FsrsParamsPanel.tsx:100`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：limit?: integer(u32) | null
  - 结果：FsrsDueCard[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_due -->

- [x] 输入：`limit` 可选（默认 50，夹紧到 0..500）。
- [x] 输出：`FsrsDueCard[]`；学习卡优先，其余按 `reviewOrder` / `newReviewOrder` 组合并受每日限额、埋藏、暂停、诊断卡过滤。
- [x] 错误：`Database`；记忆状态升级与掌握度补偿失败只告警，不影响到期列表。
- [x] 事件：无。
- [x] DB 读写：只读 mistakes 查询；补偿路径可能写 vfs mastery（outbox 确认）。
- [x] 取消/并发：只读，无事务；补偿逐条尽力而为。
- [x] 时间/ID：now、逻辑日边界、当日计数。

## 命令 `fsrs_get_memory_overview`

<!-- BEGIN GENERATED:cmd:fsrs_get_memory_overview -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:533` · async
- 前端：app（1 处，例 `src/features/flashcards/memoryCurve.ts:376`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：recentLimit?: integer(u32) | null
  - 结果：FsrsMemoryOverview · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_memory_overview -->

- [x] 输入：`recentLimit` 可选（1..20，默认 5）。
- [x] 输出：`FsrsMemoryOverview`（最近复习卡、平均可提取率、近 30 天真实保留率、遗忘曲线）。
- [x] 错误：`Database`。
- [x] 事件：无。
- [x] DB 读写：只读 mistakes；复用复习统计的 30 天窗口。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：`generatedAtMs` = now；窗口按逻辑日。

## 命令 `fsrs_get_review_statistics`

<!-- BEGIN GENERATED:cmd:fsrs_get_review_statistics -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:523` · async
- 前端：app（2 处，例 `src/features/flashcards/components/RetentionInsightsPanel.tsx:134`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：days?: integer(u32) | null
  - 结果：FsrsReviewStatistics · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_review_statistics -->

- [x] 输入：`days` 可选（夹紧到 7..730，默认 365）。
- [x] 输出：`FsrsReviewStatistics`（每日聚合 / 评分分布 / 状态构成 / 留存 / 限额 / 15 天到期预测 / 记忆分布）。
- [x] 错误：`Database`。
- [x] 事件：无。
- [x] DB 读写：只读 mistakes（`fsrs_review_logs`、`fsrs_card_states`、`anki_cards`、`document_tasks`、`anki_decks`）。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：窗口 `[dayStart-(days-1), nextDayStart)`；日期键按 `dayRolloverHour` 的逻辑日。

## 命令 `fsrs_get_scheduler_config`

<!-- BEGIN GENERATED:cmd:fsrs_get_scheduler_config -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:555` · async
- 前端：app（2 处，例 `src/features/flashcards/components/FsrsOptimizerPanel.tsx:45`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：FsrsSchedulerConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_scheduler_config -->

- [x] 输入：无。
- [x] 输出：`FsrsSchedulerConfig`（snake_case config_json 与默认值合并，未知键忽略）。
- [x] 错误：`Database`。
- [x] 事件：无。
- [x] DB 读写：只读 `anki_decks`（默认牌组不存在时返回默认配置，不写库）。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `fsrs_get_stats`

<!-- BEGIN GENERATED:cmd:fsrs_get_stats -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:515` · async
- 前端：app（5 处，例 `src/features/flashcards/screens/TodayScreen.tsx:146`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：FsrsStats · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_get_stats -->

- [x] 输入：无。
- [x] 输出：`FsrsStats`（total/new/learning/review/relearning/suspended/buried/leech、due、今日配额、backlog、learningWaiting）。
- [x] 错误：`Database`；记忆状态升级失败只告警。
- [x] 事件：无。
- [x] DB 读写：只读 mistakes 统计；升级路径可能写 `fsrs_card_states` / `anki_decks`。
- [x] 取消/并发：只读为主；升级为 immediate 事务。
- [x] 时间/ID：now、逻辑日边界、当日计数。

## 命令 `fsrs_optimize_parameters`

<!-- BEGIN GENERATED:cmd:fsrs_optimize_parameters -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:572` · async
- 前端：app（1 处，例 `src/features/flashcards/components/FsrsOptimizerPanel.tsx:54`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：（无）
  - 结果：FsrsOptimizeResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_optimize_parameters -->

- [ ] 输入：无。
- [ ] 输出：`FsrsOptimizeResult`（not_enough_data / optimized / already_optimal）。
- [ ] 错误：`Validation` / 内部错误。
- [ ] 事件：`recomputedCards > 0` 时 emit `fsrs://changed`（action=optimize）。
- [ ] DB 读写：读复习历史；写优化参数并重算记忆状态。
- [ ] 取消/并发：Rust 在阻塞线程池执行。
- [ ] 时间/ID：优化时间与复习数写入 config。
- 未注册：TS 侧缺少 fsrs-rs 原生训练器，见 `native-needs.md` 第 1 节与
  `migration/spec/F7-native.md`「FSRS 优化器：binding 与 `=6.6.2` 不一致，未注册」；
  仅 `not_enough_data` 分支已在 `src/review-memory.ts::optimizeParameters()` 实现，
  因命令未注册，对应 Rust 测试保持 pending。

## 命令 `fsrs_preview_intervals`

<!-- BEGIN GENERATED:cmd:fsrs_preview_intervals -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:237` · async
- 前端：app（1 处，例 `src/features/flashcards/store/fsrsReviewStore.ts:1334`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsPreviewResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_preview_intervals -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsPreviewResult`（Again/Hard/Good/Easy 四档 due / interval）。
- [x] 错误：`Validation`（诊断卡 / 暂停卡）、`NotFound`（state 不存在）、`Database`。
- [x] 事件：无（只读预览不写库）。
- [x] DB 读写：只读 mistakes + vfs mastery（concept 掌握度分数）。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：now；掌握度 due 偏置与评分共用。

## 命令 `fsrs_rate`

<!-- BEGIN GENERATED:cmd:fsrs_rate -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:250` · async
- 前端：app（2 处，例 `src/features/flashcards/store/fsrsReviewStore.ts:1386`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string, rating: integer(u8), durationMs?: integer(i64) | null, clientOpId?: string | null, enforceExpectedLastReview?: boolean | null, expectedLastReviewMs?: integer(i64) | null
  - 结果：FsrsRateResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_rate -->

- [x] 输入：`cardStateId`、`rating`（1..4）、`durationMs?`、`clientOpId?`、`enforceExpectedLastReview?`、`expectedLastReviewMs?`。
- [x] 输出：`FsrsRateResult`（cardState / logId / scheduledDays / dueMs / buriedSiblings）。
- [x] 错误：`Validation`（rating、UUID、诊断卡、暂停卡）、`NotFound`、`Conflict`（clientOpId 复用 / CAS 失败）。
- [x] 事件：成功后 emit `fsrs://changed`（action=rate，卡片带 logId）；掌握度补偿失败只告警。
- [x] DB 读写：immediate 事务更新 `fsrs_card_states`、插入 `fsrs_review_logs`、埋藏同笔记兄弟；vfs mastery 走 outbox。
- [x] 取消/并发：CAS 校验 `last_review_ms`；`clientOpId` 幂等重放；最新日志被撤销后拒绝复用。
- [x] 时间/ID：nowMs、`utcNow()`（chrono AutoSi 单次读数）；logId = clientOpId 或 UUID。

## 命令 `fsrs_reset_card_progress`

<!-- BEGIN GENERATED:cmd:fsrs_reset_card_progress -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:595` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:231`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsResetResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_reset_card_progress -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsResetResult`（新 New state + clearedLogs）。
- [x] 错误：`Validation`、`NotFound`、`Database`。
- [x] 事件：成功后总是 emit `fsrs://changed`（action=reset）。
- [x] DB 读写：immediate 事务删除该卡全部复习日志并重建 `fsrs_card_states`（新 id）。
- [x] 取消/并发：单事务原子；无中途取消点。
- [x] 时间/ID：新 state id = UUID；`created_at` / `updated_at` = `utcNow()`（chrono AutoSi 单次读数）。

## 命令 `fsrs_suspend_card`

<!-- BEGIN GENERATED:cmd:fsrs_suspend_card -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:455` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:164`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsSuspendResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_suspend_card -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsSuspendResult`；重复暂停 `changed=false` 且不写库。
- [x] 错误：`Validation`、`NotFound`、`Conflict`（更新时状态变化）、`Database`。
- [x] 事件：`changed=true` 时 emit `fsrs://changed`（action=suspend）。
- [x] DB 读写：immediate 事务更新 `suspended`、`updated_at`、`local_version+1`。
- [x] 取消/并发：单事务原子；`suspended` 旧值参与 UPDATE 条件。
- [x] 时间/ID：`utcNow()`（chrono AutoSi 单次读数）。

## 命令 `fsrs_unbury_card`

<!-- BEGIN GENERATED:cmd:fsrs_unbury_card -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:485` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsBuryResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_unbury_card -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsBuryResult`；未埋藏时 `changed=false` 且不写库。
- [x] 错误：`Validation`、`NotFound`、`Database`。
- [x] 事件：`changed=true` 时 emit `fsrs://changed`（action=unbury）。
- [x] DB 读写：immediate 事务清空 `buried_until_ms` 并递增 `local_version`。
- [x] 取消/并发：单事务原子。
- [x] 时间/ID：`utcNow()`（chrono AutoSi 单次读数）。

## 命令 `fsrs_undo_last_review`

<!-- BEGIN GENERATED:cmd:fsrs_undo_last_review -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:415` · async
- 前端：app（2 处，例 `src/features/flashcards/store/fsrsReviewStore.ts:1640`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：expectedLogId: string, cardStateId: string
  - 结果：FsrsUndoResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_undo_last_review -->

- [x] 输入：`expectedLogId`、`cardStateId`（均 trim 后非空）。
- [x] 输出：`FsrsUndoResult`（恢复后的 state / changed / undoneLogId）。
- [x] 错误：`Validation`（快照缺失或损坏）、`NotFound`、`Conflict`（非最新日志 / 状态已变化）。
- [x] 事件：`changed=true` 时 emit `fsrs://changed`（action=undo）；掌握度回滚补偿失败只告警。
- [x] DB 读写：immediate 事务按 `state_before_json` 恢复 state、软删除日志、标记 `mastery_revert_pending=1`；vfs mastery 回滚。
- [x] 取消/并发：校验最新 active log、`last_review_ms`、`updated_at` 三重一致。
- [x] 时间/ID：`utcNow()`（chrono AutoSi 单次读数）；恢复后 `local_version+1`。

## 命令 `fsrs_unsuspend_card`

<!-- BEGIN GENERATED:cmd:fsrs_unsuspend_card -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:500` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:168`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：cardStateId: string
  - 结果：FsrsSuspendResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:fsrs_unsuspend_card -->

- [x] 输入：`cardStateId`（trim 后非空）。
- [x] 输出：`FsrsSuspendResult`；重复恢复 `changed=false` 且不写库。
- [x] 错误：`Validation`、`NotFound`、`Conflict`、`Database`。
- [x] 事件：`changed=true` 时 emit `fsrs://changed`（action=unsuspend）。
- [x] DB 读写：immediate 事务更新 `suspended`、`updated_at`、`local_version+1`。
- [x] 取消/并发：单事务原子。
- [x] 时间/ID：`utcNow()`（chrono AutoSi 单次读数）。

## 命令 `fsrs_update_scheduler_config`

<!-- BEGIN GENERATED:cmd:fsrs_update_scheduler_config -->
- Rust：`src-tauri/src/cmd/fsrs_review.rs:562` · async
- 前端：app（2 处，例 `src/features/flashcards/components/FsrsOptimizerPanel.tsx:74`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：update: FsrsSchedulerConfigUpdate
  - 结果：FsrsSchedulerConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fsrs_update_scheduler_config -->

- [x] 输入：`update`（部分字段；未知键保留，camelCase 重复键删除）。
- [x] 输出：合并后的 `FsrsSchedulerConfig`。
- [x] 错误：`Validation`（learnAhead ≤60、retention (0,1)、leechAction、steps、maximumInterval、rollover、reviewOrder/newReviewOrder、maxAnswerSeconds、fsrsParams 17/19/21 有限）。
- [x] 事件：无。
- [x] DB 读写：immediate 事务写 `anki_decks.config_json`；`fsrs_params` 变化时按新参数重算全部记忆状态。
- [x] 取消/并发：单事务原子；默认牌组缺失时先创建。
- [x] 时间/ID：`utcNow()`（chrono AutoSi 单次读数） 更新 `updated_at` / `local_version`。

## 命令 `insight_add_relation`

<!-- BEGIN GENERATED:cmd:insight_add_relation -->
- Rust：`src-tauri/src/insight/handlers.rs:125` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：fromId: string, toId: string, relationType: string, scope?: string | null, evidence?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_add_relation -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_confirm`

<!-- BEGIN GENERATED:cmd:insight_confirm -->
- Rust：`src-tauri/src/insight/handlers.rs:31` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string, edits?: InsightCorrectInput | null
  - 结果：InsightCard · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_confirm -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_correct`

<!-- BEGIN GENERATED:cmd:insight_correct -->
- Rust：`src-tauri/src/insight/handlers.rs:41` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string, input: InsightCorrectInput
  - 结果：InsightCard · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_correct -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_create_draft`

<!-- BEGIN GENERATED:cmd:insight_create_draft -->
- Rust：`src-tauri/src/insight/handlers.rs:22` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：input: InsightDraftInput
  - 结果：InsightCard · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_create_draft -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_delete`

<!-- BEGIN GENERATED:cmd:insight_delete -->
- Rust：`src-tauri/src/insight/handlers.rs:51` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_delete -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_get`

<!-- BEGIN GENERATED:cmd:insight_get -->
- Rust：`src-tauri/src/insight/handlers.rs:57` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string
  - 结果：InsightCard | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_get -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_list`

<!-- BEGIN GENERATED:cmd:insight_list -->
- Rust：`src-tauri/src/insight/handlers.rs:66` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：status?: string | null, limit?: integer(i64) | null, offset?: integer(i64) | null
  - 结果：InsightCard[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_list -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

### WP-159：精确分页消费（main b17264b88，含 L17 WP-158/9f5a99787）

| Rust 分支 | TS 生产落点 / 证据 |
|---|---|
| `handlers.rs:67-78`：Option<i64>、status/limit/offset 顺序、缺省/null→100/0、显式0 | `src/insight-commands.ts:70,99-100`：仅 ListArgs 的 limit/offset 使用 F1 `IpcInteger`；已有直接转发正确，保留运行时实现 |
| `dstu-research/src/insight/service.rs:406-424`：limit.min(500)，offset 原样，逐 id 读卡 | 已 main 的 `memory/src/insight-service.ts:318-326`；L15 只消费 `memory/api.ts` 重导出的 `InsightCommandService`，不复制 clamp/SQL/解码 |
| `repo.rs:210-247`：Some(status)/None 两条 SQL | `memory/repository/insight-cards.ts:541-554` 保 deleted 过滤、updated_at DESC、参数顺序；F3 bigint 参数原样绑定 |
| repo prepare/query 与 service get_card 的 `?` | L17 公共服务映射 Database，L15 保留 CommandError；真实缺表/缺列到 kernel 出口仍为原文、details=null |

- 入站使用 F1 正式 `argsJson` + 生成契约 `x-int:i64`，合法超安全整数由 kernel 解码为 bigint；本命令不另造 serde 解码器、不经 Number。
- 复用 `memory/tests/insight-pagination.test.ts` 的六条真实 provider 回归：普通分页/排序/过滤/revision、100/0/显式0、500/501与正负i64、两SQL分支实际绑定及两阶段SQL失败。
- 补缺口 `tests/insight-pagination-inbound.test.ts` 三例：真实 `host.runtime.dispatchInvoke(argsJson)` → review 注册命令 → memory 公共服务 → storage/SQLite。原文包含正负相邻2^53与i64端点；旧 args 故意冲突。call-through 只观察真实 db.all 参数，查询仍执行；不能以两个大 offset 均为空代替精度断言。夹具调用F3真实迁移器，卡片经真实创建命令与L11 owner创建；158原六例直接复用运行，不跨域导入其私有测试helper。
- 此只读列表路径没有业务日志、事件、写事务或新取消点；资源由既有服务/测试 finally 清理。TESTMAP 无新增迁移映射，证据等级为生产命令测试+源码审读。
- Node/Electron内置Node结果见本包报告；GUI/F2原文精度归WP-135，listEvents/reviewPlan精度及完整insight等价不由此签收。

## 命令 `insight_list_events`

<!-- BEGIN GENERATED:cmd:insight_list_events -->
- Rust：`src-tauri/src/insight/handlers.rs:104` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string, limit?: integer(i64) | null
  - 结果：InsightEvent[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_list_events -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_list_evidence`

<!-- BEGIN GENERATED:cmd:insight_list_evidence -->
- Rust：`src-tauri/src/insight/handlers.rs:88` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string
  - 结果：InsightEvidence[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_list_evidence -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_list_relations`

<!-- BEGIN GENERATED:cmd:insight_list_relations -->
- Rust：`src-tauri/src/insight/handlers.rs:96` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string
  - 结果：InsightRelation[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_list_relations -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_list_revisions`

<!-- BEGIN GENERATED:cmd:insight_list_revisions -->
- Rust：`src-tauri/src/insight/handlers.rs:80` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string
  - 结果：InsightRevision[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_list_revisions -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_record_feedback`

<!-- BEGIN GENERATED:cmd:insight_record_feedback -->
- Rust：`src-tauri/src/insight/handlers.rs:114` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：insightId: string, feedback: string, sessionId?: string | null
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_record_feedback -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `insight_run_jobs`

<!-- BEGIN GENERATED:cmd:insight_run_jobs -->
- Rust：`src-tauri/src/insight/handlers.rs:144` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：batchSize?: integer(u32) | null
  - 结果：integer(u32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:insight_run_jobs -->

- [x] 输入：按契约接收参数并原样传给 `InsightService`；`insight_list` 默认 limit=100/offset=0，`insight_list_events` 默认 limit=50，`insight_run_jobs` 默认 batch=5（同 `handlers.rs`）。
- [x] 输出：直接返回服务结果；delete/record_feedback 返回 null（Rust `()`）。
- [x] 错误：服务的 `AppError` 经 `CommandError.value` 原样透传；服务未安装时返回 `Database: VFS 数据库未初始化`（同 Rust `make_service`）。
- [x] 事件：无。
- [x] DB 读写：由灵感卡服务负责（vfs insights/revisions/evidence/relations/events）；本命令层不直接读写。
- [x] 取消/并发：无跨调用共享状态；事务与并发由服务保证。
- [x] 时间/ID：由 `dstu_research::insight` 服务生成。

## 命令 `mastery_get_overview`

<!-- BEGIN GENERATED:cmd:mastery_get_overview -->
- Rust：`src-tauri/crates/dstu-learning/src/mastery/mod.rs:23` · async
- 前端：app（1 处，例 `src/components/dashboard/WeakConceptsStrip.tsx:17`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：limit?: integer(u32) | null
  - 结果：MasteryOverviewSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:mastery_get_overview -->

- [x] 输入：`limit?`（默认 6，夹紧到 1..30）。
- [x] 输出：`MasteryOverviewSummary`（总体统计 + weakest 列表 + todayPriorityReview）。
- [x] 错误：`CommandError` 值为纯字符串（`Result<_, String>`）。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `mastery_states` / `mastery_events`。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `review_plan_batch_create`

<!-- BEGIN GENERATED:cmd:review_plan_batch_create -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:908` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:466`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：questionIds: string[], examId: string
  - 结果：BatchCreateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_batch_create -->

- [x] 输入：`questionIds[]`、`examId`。
- [x] 输出：`BatchCreateResult`（created / skipped / failed / plans）。
- [x] 错误：逐题失败不抛出（计入 failed）；列表为空时返回全 0；DB 级错误以纯字符串抛出。
- [x] 事件：无。
- [x] DB 读写：逐题调用 create（读 questions、写 review_plans）。
- [x] 取消/并发：逐题独立；已存在计入 skipped。
- [x] 时间/ID：同 review_plan_create。

## 命令 `review_plan_create`

<!-- BEGIN GENERATED:cmd:review_plan_create -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:762` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:444`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：questionId: string, examId: string
  - 结果：ReviewPlan · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_create -->

- [x] 输入：`questionId`、`examId`（均原样使用，不 trim）。
- [x] 输出：新建的 `ReviewPlan`（snake_case 字段；status=`new`、interval=0、repetitions=0、EF=2.5、next_review_date=本地今天）。
- [x] 错误：纯字符串（`CommandError` 值）：题目不存在 `Question not found: <id>`；题目集不匹配 `Question <id> belongs to exam_id=<actual>, but got exam_id=<given>`；已存在或 DB 错误统一为 Rust `with_context` 最外层文案 `Failed to create review plan for question_id=<id>`。
- [x] 事件：无。
- [x] DB 读写：读 vfs `questions`（deleted_at IS NULL），事务写 `review_plans`。
- [x] 取消/并发：创建前查重；并发重复创建时后到者返回 already exists。
- [x] 时间/ID：id = `rp_` + nanoid(10)；`created_at`/`updated_at` = UTC RFC3339；`next_review_date` = 本地日期。

## 命令 `review_plan_create_for_exam`

<!-- BEGIN GENERATED:cmd:review_plan_create_for_exam -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:921` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:487`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：examId: string
  - 结果：BatchCreateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_create_for_exam -->

- [x] 输入：`examId`。
- [x] 输出：聚合 `BatchCreateResult`。
- [x] 错误：题目分页读取失败时纯字符串抛出；单题创建失败计入 failed。
- [x] 事件：无。
- [x] DB 读写：按 `created_at ASC, id ASC` 分页（每页 100，仓储夹紧）读 `questions`，批量写 `review_plans`。
- [x] 取消/并发：逐页、逐题独立；重复运行已存在计划计入 skipped。
- [x] 时间/ID：同 review_plan_create。

## 命令 `review_plan_delete`

<!-- BEGIN GENERATED:cmd:review_plan_delete -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:885` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:506`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_delete -->

- [x] 输入：`planId`。
- [x] 输出：`null`（Rust `()`）。
- [x] 错误：纯字符串：计划不存在 `review_plan not found: <id>`；DB 错误。
- [x] 事件：无。
- [x] DB 读写：删除 vfs `review_plans` 行；`review_history` 由外键级联删除。
- [x] 取消/并发：单条 DELETE；受影响行数为 0 视为 NotFound。
- [x] 时间/ID：无。

## 命令 `review_plan_get`

<!-- BEGIN GENERATED:cmd:review_plan_get -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:855` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string
  - 结果：ReviewPlan | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get -->

- [x] 输入：`planId`。
- [x] 输出：`ReviewPlan | null`。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans`。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `review_plan_get_by_question`

<!-- BEGIN GENERATED:cmd:review_plan_get_by_question -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:843` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:567`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：questionId: string
  - 结果：ReviewPlan | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_by_question -->

- [x] 输入：`questionId`。
- [x] 输出：`ReviewPlan | null`。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans`。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `review_plan_get_calendar_data`

<!-- BEGIN GENERATED:cmd:review_plan_get_calendar_data -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:960` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:783`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：startDate?: string | null, endDate?: string | null, examId?: string | null
  - 结果：CalendarHeatmapData[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_calendar_data -->

- [x] 输入：`startDate?`、`endDate?`、`examId?`。
- [x] 输出：`CalendarHeatmapData[]`（date / count / passed / failed），按日期升序。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_history` INNER JOIN `review_plans`，按 `DATE(reviewed_at)` 分组。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：日期过滤为日期字符串比较（含边界）。

## 命令 `review_plan_get_due`

<!-- BEGIN GENERATED:cmd:review_plan_get_due -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:794` · async
- 前端：app（2 处，例 `src/features/learning-today/dueMistakesReview.ts:53`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：examId?: string | null, untilDate?: string | null
  - 结果：DueReviewsResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_due -->

- [x] 输入：`examId?`、`untilDate?`（默认本地今天）。
- [x] 输出：`DueReviewsResult`（plans / total / has_more），limit 固定 500、offset 0。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans`；排除 `status='suspended'`，按 next_review_date、is_difficult、consecutive_failures 排序。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：默认 until_date = 本地日期。

## 命令 `review_plan_get_due_with_filter`

<!-- BEGIN GENERATED:cmd:review_plan_get_due_with_filter -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:807` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:352`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：filter: DueReviewsFilter
  - 结果：DueReviewsResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_due_with_filter -->

- [x] 输入：`filter`（exam_id / until_date / status[] / difficult_only / limit / offset，均 snake_case 字段）。
- [x] 输出：`DueReviewsResult`；limit 默认 50、offset 默认 0，until_date 默认本地今天。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans`；支持题目集 / 状态 / 困难题筛选与分页。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：默认 until_date = 本地日期。

## 命令 `review_plan_get_history`

<!-- BEGIN GENERATED:cmd:review_plan_get_history -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:895` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:608`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string, limit?: integer(u32) | null
  - 结果：ReviewHistory[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_history -->

- [x] 输入：`planId`、`limit?`（默认 100）。
- [x] 输出：`ReviewHistory[]`，按 reviewed_at 倒序。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_history`。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `review_plan_get_or_create`

<!-- BEGIN GENERATED:cmd:review_plan_get_or_create -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:947` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:554`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：questionId: string, examId: string
  - 结果：ReviewPlan · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_or_create -->

- [x] 输入：`questionId`、`examId`。
- [x] 输出：已有或新建的 `ReviewPlan`。
- [x] 错误：同 review_plan_create（仅在需要创建时校验题目与题目集）。
- [x] 事件：无。
- [x] DB 读写：先只读查 `review_plans`，缺失时创建。
- [x] 取消/并发：先查后建；并发下后到者可能得到 already exists 字符串错误（Rust 同）。
- [x] 时间/ID：已有计划原样返回；新建同 review_plan_create。

## 命令 `review_plan_get_stats`

<!-- BEGIN GENERATED:cmd:review_plan_get_stats -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:819` · async
- 前端：app（3 处，例 `src/features/learning-hub/apps/views/useExamDueReviewCount.ts:22`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：examId?: string | null
  - 结果：ReviewStats · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_get_stats -->

- [x] 输入：`examId?`（缺省为全局统计）。
- [x] 输出：`ReviewStats`（各状态计数、due_today、overdue、difficult、正确率、平均 EF）。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans` 聚合；不写 `review_stats` 缓存。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：today = 本地日期；updated_at = 当前 UTC RFC3339。

## 命令 `review_plan_list_by_exam`

<!-- BEGIN GENERATED:cmd:review_plan_list_by_exam -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:933` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:415`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：examId: string, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：DueReviewsResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_list_by_exam -->

- [x] 输入：`examId`、`limit?`（默认 100）、`offset?`（默认 0）。
- [x] 输出：`DueReviewsResult`（plans / total / has_more），按 next_review_date ASC。
- [x] 错误：纯字符串 DB 错误。
- [x] 事件：无。
- [x] DB 读写：只读 vfs `review_plans`。
- [x] 取消/并发：只读同步查询。
- [x] 时间/ID：无。

## 命令 `review_plan_process`

<!-- BEGIN GENERATED:cmd:review_plan_process -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:775` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:584`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string, quality: integer(u8), userAnswer?: string | null, timeSpentSeconds?: integer(u32) | null
  - 结果：ProcessReviewResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_process -->

- [x] 输入：`planId`、`quality`（0..255，>5 直接错误 `Quality must be between 0 and 5`；服务内再 `min(5)`）、`userAnswer?`、`timeSpentSeconds?`。
- [x] 输出：`ProcessReviewResult`（更新后的 plan、passed、new_interval、next_review_date、history）。
- [x] 错误：纯字符串（`CommandError` 值）：quality 越界；计划不存在 `Review plan not found: <id>`；更新时 `updated_at` 冲突返回 `REVIEW_CONFLICT: review plan ... changed after revision ...`；DB 错误。
- [x] 事件：无。
- [x] DB 读写：deferred 事务更新 `review_plans`、插入 `review_history`；同事务经掌握度服务写 `mastery_events`/状态（无标签或掌握度失败时静默跳过，不阻塞复习）；提交后同步学习者画像，失败只告警。
- [x] 取消/并发：`UPDATE ... WHERE id=? AND updated_at=?` 乐观并发；冲突时整事务回滚，不产生第二条历史。
- [x] 时间/ID：history id = `rh_` + nanoid(10)；`reviewed_at` = UTC RFC3339；`last_review_date` = 本地今天；下次日期 = 本地今天 + 模糊后间隔。

## 命令 `review_plan_refresh_stats`

<!-- BEGIN GENERATED:cmd:review_plan_refresh_stats -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:831` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:394`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：examId?: string | null
  - 结果：ReviewStats · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_refresh_stats -->

- [x] 输入：`examId?`。
- [x] 输出：`ReviewStats`（与 `review_plan_get_stats` 相同的聚合结果）。
- [x] 错误：纯字符串 DB 错误（含 `review_stats.exam_id` 外键失败）。
- [x] 事件：无。
- [x] DB 读写：读 `review_plans` 聚合并 upsert 到 vfs `review_stats`（冲突键 exam_id）。
- [x] 取消/并发：单条 upsert；无显式事务。
- [x] 时间/ID：today = 本地日期；updated_at = 当前 UTC RFC3339。

## 命令 `review_plan_resume`

<!-- BEGIN GENERATED:cmd:review_plan_resume -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:875` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:536`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string
  - 结果：ReviewPlan · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_resume -->

- [x] 输入：`planId`。
- [x] 输出：更新后的 `ReviewPlan`；status 按 repetitions/interval 恢复为 new / learning / reviewing / graduated。
- [x] 错误：纯字符串：计划不存在 `review_plan not found: <id>`；DB 错误。
- [x] 事件：无。
- [x] DB 读写：读 `review_plans` 判定状态，写 status、next_review_date、updated_at。
- [x] 取消/并发：先读后写，无版本校验（Rust 同）。
- [x] 时间/ID：next_review_date = 本地今天；updated_at = 当前 UTC RFC3339。

## 命令 `review_plan_suspend`

<!-- BEGIN GENERATED:cmd:review_plan_suspend -->
- Rust：`src-tauri/crates/dstu-qbank/src/review_plan_service.rs:865` · async
- 前端：app（1 处，例 `src/stores/reviewPlanStore.ts:520`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：planId: string
  - 结果：ReviewPlan · 错误：string · 注入：state
<!-- END GENERATED:cmd:review_plan_suspend -->

- [x] 输入：`planId`。
- [x] 输出：更新后的 `ReviewPlan`（status=`suspended`）。
- [x] 错误：纯字符串：计划不存在 `review_plan not found: <id>`；DB 错误。
- [x] 事件：无。
- [x] DB 读写：写 vfs `review_plans`（status、updated_at）。
- [x] 取消/并发：单条 UPDATE；受影响行数为 0 视为 NotFound。
- [x] 时间/ID：updated_at = 当前 UTC RFC3339。

## 命令 `study_time_add`

<!-- BEGIN GENERATED:cmd:study_time_add -->
- Rust：`src-tauri/crates/dstu-learning/src/study_loop/study_time.rs:116` · async
- 前端：app（1 处，例 `src/features/study-time/studyTimeTracker.ts:35`）
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：seconds: integer(i64), date?: string | null
  - 结果：StudyTimeDay · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:study_time_add -->

- [x] 输入：seconds 1..=3600；date trim 后为空或 null 用本地今天，允许今天 ±2 天（study_time.rs:35-51,122-127）。
- [x] 输出：{date, seconds}，累计封顶 86400（study_time.rs:56-81）。
- [x] 错误：AppError，details 始终 null；校验文案及 study_time_add failed: 前缀照源码（study_time.rs:35-51,140）。
- [x] 事件：无（study_time.rs:117-144）。
- [x] DB 读写：vfs.study_time_daily UPSERT 后读取累计，负数在内部 add_seconds 夹到 0（study_time.rs:62-77）。
- [x] 取消/并发：不响应前端放弃；同步 SQLite 单语句原子累加，无 await 交错（study_time.rs:130-143）。
- [x] 时间/ID：本地日期 YYYY-MM-DD；updated_at 为 UTC 毫秒；不生成 ID（study_time.rs:122,129,138）。

## 命令 `study_time_range`

<!-- BEGIN GENERATED:cmd:study_time_range -->
- Rust：`src-tauri/crates/dstu-learning/src/study_loop/study_time.rs:147` · async
- 前端：none
- 契约：`contracts/ipc/L15-review-analytics.json`
  - 参数：from: string, to: string
  - 结果：StudyTimeDay[] · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:study_time_range -->

- [x] 输入：from/to trim 后解析日期，to >= from，跨度 <=3700 天（study_time.rs:153-162）。
- [x] 输出：闭区间日期升序，仅 seconds > 0 的行（study_time.rs:85-97）。
- [x] 错误：AppError Validation / Database，原文及 study_time_range failed: 前缀（study_time.rs:153-173）。
- [x] 事件：无（study_time.rs:148-177）。
- [x] DB 读写：只读 vfs.study_time_daily（study_time.rs:87-90）。
- [x] 取消/并发：不监听 AbortSignal，同步查询（study_time.rs:168-176）。
- [x] 时间/ID：输入规范化为 YYYY-MM-DD，不生成时间或 ID（study_time.rs:164-167）。

## 事件 `fsrs://changed`

<!-- BEGIN GENERATED:event:fsrs://changed -->
- 事件名 `fsrs://changed`
- 发送点：`src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:5496`（emit）
- 发送点：`src-tauri/src/cmd/fsrs_review.rs:101`（emit）
- 发送点：`src-tauri/src/cmd/fsrs_review.rs:291`（emit）
<!-- END GENERATED:event:fsrs://changed -->

- [x] 载荷：`{ source, action, entityIds, cardStateIds, cards }`。`action` 为 enqueue / rate / undo / suspend / unsuspend / bury / unbury / reset / optimize；`entityIds` 为 anki 卡 id（无 state 时回退请求卡 id），`cardStateIds` 为 FSRS state id；`cards` 在 enqueue 时为完整 `FsrsEnqueuedCard`，rate 时带 `logId`。
- [x] 触发时机与顺序：写操作成功且确有写入后同步 emit；重复 bury/unbury/suspend/unsuspend/undo 的 no-op 不 emit；enqueue 全部跳过时不 emit；optimize 仅在 `recomputedCards > 0` 时 emit。
- [x] 节流/合并：无，逐次写操作独立 emit。
- [x] 是否在事务提交后：是；服务事务提交后由命令层发送（`fsrs_rate` 的掌握度补偿也在提交后）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`emit`，广播给全部监听者。

## V2-S4 / D3：Agent review@1 CAS 版本边界（修复候选，待独立复验）

- Rust `FsrsAgentReviewStateSnapshot.review_version: i64`（fsrs_review_service.rs:235），
  `row.get::<i64>`（:4812）→ `repository/fsrs.ts:loadAgentStateRecord/exactReviewVersion`。
  SQLite INTEGER 从 TEXT 精确读成 bigint，非 INTEGER 仍报 Database；不按 MAX_SAFE 拒合法值。
- `set_suspended_for_agent_scope`（:2871–2967）、`undo_last_review_for_agent_scope`（:3007–3185）
  → `src/review.ts` 同名 Agent scope 方法。`expectedReviewVersion` 接 `number | bigint`，
  归一到 bigint 后按 `0..=i64::MAX` 检查，与 bigint record 比较/绑定；SQLite 原 SQL 做 `+1`。
- 分支：scope/ownership/diagnostic/not_found 顺序不变；stale→conflict 并保留精确 current；
  suspension 同值→updated/changed=false；成功更新→读回新 bigint 版本；i64::MAX+1 时 SQLite
  转 REAL，后续读取按 Rust 报 Database，整笔事务回滚（不夹值，不提前拒 i64::MAX 输入）。
- 内部 `ReviewService` 快照 `reviewVersion: bigint`，旧整数 number 输入仍接受；超过 2^53
  的精确调用传 bigint。只有 kernel `toWireJson` 最外 IPC 边界转 number，沿原 Tauri 行为。
  表所有者仍为 review；消费者不得复制 FSRS SQL 或提前 Number 化。
- 生产入口证据：`tests/agent-review-version.test.ts` 经 `host.ctx.review` 真实 provider（无替身），
  用 `9007199254740993n`、`9223372036854774784n`、`9223372036854775807n` 验 read、
  suspension/undo CAS、相邻 stale、幂等、SQL 递增与溢出回滚；原小版本断言仅换精确内部表示。
- 范围：本节只覆盖 CAS `local_version`，不是所有 i64 时间戳的签收；snapshot 时间戳等差异仍在 LANE。

## SW anki_decks：L16 owner 同连接写接缝（候选，待 main 组合复验）

- 默认插入（Rust fsrs_review_service.rs:1346–1353）与配置写入（:3634–3644、:3680–3690）
  在 `repository/fsrs.ts` 只调用 `anki/api.ts` 正式导出的
  `ensureDefaultFsrsDeckWithConn` / `writeFsrsDeckConfigWithConn`（L16 `474e38f29`）。
- 传原有 tx/conn，不新增事务/连接；JSON.stringify 仍在原 try/catch 内由 L15 执行。
  owner 抛底层存储错误，L15 原 Database 前缀与顺序不变，不双包。
- 默认字段、INSERT OR IGNORE 不重置/复活既有行、配置 UPDATE 的 deleted 过滤与
  `COALESCE(local_version, 0) + 1` 由 L16 负责；FSRS 算法、只读 deck 查询仍留 L15。
- 回归：`tests/deck-owner-transaction.test.ts` 的真实命令断言覆盖默认行/FSRS 写同事务、
  ensure/config 同事务、错误前缀、已有配置字段、i64 SQL 版本递增、deleted no-op。
  `tests/service-transaction-api.test.ts` 保留导入调用方事务回滚证据。
