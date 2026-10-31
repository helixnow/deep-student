# 2026-10-31 dstu-kernel 插件内核

- 状态：已落地（本轮）
- 分支：`refactor/dstu-workspace`（lane `wt/lane-kernel`）
- crate：`src-tauri/crates/dstu-kernel`（layer `core`）
- 相关：`src/vfs/hooks.rs`、`src/llm_manager/web_search_fallback.rs`、`src/extensions.rs`

## 背景

`src-tauri` 拆成 Cargo workspace 后，分层规则要求：
- agent 层不得依赖 domain 层；
- domain 层之间不得互相依赖。

因此“低层调用上层能力”必须依赖反转。拆分过程中出现了三种各写各的写法：

1. `llm_manager/web_search_fallback.rs`：`OnceLock<fn>`，单提供方，先注册者生效；
2. `vfs/hooks.rs`：`RwLock<Vec<Arc<dyn Hook>>>`（多订阅者）+ `OnceLock<Arc<dyn T>>`（单提供方），
   其中 `NoteDeleteHook` 是“删除前取上下文、删除成功后执行收尾闭包”的两段式；
3. `extensions.rs`：`Once` 集中接线。

这些写法分散、没有统一的生命周期/回滚语义，后续 llm/vfs/storage/domain 各条线会继续复制。
本 ADR 记录统一内核原语及其使用约定。

## 原语与 Cordis 对应

| Cordis 概念 | dstu-kernel | 语义 |
|---|---|---|
| 服务注入 | `Slot<T: ?Sized>` | 单提供方；`provide` 返回 `Disposer`，drop 后清空；占用时先注册者生效，显式 `replace` 才替换 |
| 事件/钩子 | `HookSet<T: ?Sized>` | 多订阅者；注册返回 `Disposer`；遍历取快照，不持锁回调；锁中毒恢复 |
| 有序插件 | `Plugin` + `Scope` + `PluginHost` | 显式有序 apply；`Scope` 收集 `Disposer`，卸载按注册逆序回滚；按名幂等/卸载 |
| 带语义的钩子链 | `Kernel` | `Kernel` 带不可移除、恒先于 `Default` 带；observe / gate / waterfall 三种调用语义 |

`dstu-kernel` 不依赖任何内部 crate、不依赖 tauri，只提供机制，不放业务类型。

## 使用约定

1. 低层在**消费方旁边**声明槽位/钩子集：
   ```rust
   static MEDIA_TRANSCRIBER: Slot<dyn MediaTranscriber> = Slot::new();
   static NOTE_DELETE_HOOKS: HookSet<dyn NoteDeleteHook> = HookSet::new();
   ```
   并提供薄的 `register_* -> Disposer` / `get()` 函数，业务代码只通过它们访问。
2. 上层实现 trait，在 `Plugin::apply(&mut scope)` 里调用低层 `register_*` 并 `scope.add(disposer)`。
3. 组合根唯一：`src-tauri/src/extensions.rs` 的显式有序插件列表，由进程级 `PluginHost` apply。
   禁止 `inventory`/`linkme` 等链接期自动收集（Android staticlib 和不同链接器下会被裁剪）。
4. 进程生命周期内插件不卸载；局部 `Scope`/`PluginHost` 只用于测试回滚与卸载逆序。
5. 同名插件 apply 幂等；apply 失败时该插件的 `Scope` 整体 drop，按逆序回滚，错误带插件名。

## 优先级分带与安全约定

- `Kernel` 带：不可移除、始终先于 `Default` 带执行。审批（ApprovalGate）、Kill Switch 这类安全关键钩子
  只能放 Kernel 带；后注册的普通插件不能插到它前面。
- `Default` 带：按注册顺序执行。
- `gate`：按顺序调用，第一个 `Block` 短路，后续钩子不执行。
- `observe`：全部调用，不能失败。
- `waterfall`：按顺序传递可变上下文。
- 本轮不迁移 `chat_v2/pipeline/hooks.rs`；内核只在单测里模拟“ApprovalGate 在前、Audit 在后”的场景，
  证明分带和 gate 短路语义可用。

## 本轮迁移

| 旧写法 | 新写法 |
|---|---|
| `OnceLock<Arc<dyn MediaTranscriber>>` | `Slot<dyn MediaTranscriber>`；`register_media_transcriber -> Result<Disposer, SlotOccupied>` |
| `OnceLock<Arc<dyn ExamDocumentExporter>>` | `Slot<dyn ExamDocumentExporter>` |
| `RwLock<Vec<Arc<dyn NoteDeleteHook>>>` | `HookSet<dyn NoteDeleteHook>`；两段式 capture/continuation 不变 |
| `RwLock<Vec<Arc<dyn ResourceCreatedHook>>>` | `HookSet<dyn ResourceCreatedHook>`；先快照再通知不变 |
| `OnceLock<WebSearchFallbackFn>` | `Slot<dyn WebSearchFallback>`；`tools::install_web_search_fallback` 兼容入口保留 |
| `extensions.rs` 的 `Once` + 四次 install | `PluginHost` + `WebSearchFallbackPlugin` / `MemoryVfsPlugin` / `MediaVfsPlugin` / `QbankVfsPlugin` |

`register_extensions()` 保留为兼容入口；`run()` 第一行、`ChatV2Pipeline::new` 的
`install_web_search_fallback` 幂等调用、相关测试的调用点都不变。

## 后续迁移（本轮不做）

1. `PipelineHook` → `HookPoint`：把审批、审计、Kill Switch 纳入 Kernel 带；保留现有顺序和私有字段语义。
2. 工具注册改为 executor + descriptor + schema 同源提交：替换 `chat_v2/pipeline.rs` 的 push 列表、
   `headless.rs` 白名单、`EXPECTED_ROSTER`；`ToolProvider` 自带 descriptor，builder 校验重名/缺失。
3. domain crate 做成 Tauri v2 插件：每个域通过 `Plugin::apply` 注册工具/命令/钩子，app 只保留组装。

## 硬约束：会话内工具面只追加、字节冻结

插件动态增删工具时，必须服从 `docs/dev/wave2-A-agent-architecture.md` 原则一：
**会话内工具面只追加、字节冻结**。卸载插件不能导致已经发给模型的 schema 消失；
必须等下一次显式换代（新的会话/显式刷新）才生效。`ToolProvider` 迁移时必须用固定的工具快照，
而不是每轮重新收集。

## 不做

- 不修改 `chat_v2/pipeline/hooks.rs`、`tool_loop.rs`、`ApprovalGateHook`，不改审批/Kill Switch。
- 不改工具注册、Tauri 命令注册、`AppState`，不新增业务 crate。
- 不引入 WASM/脚本运行时/第三方插件加载。

## 验收

- `cargo test -p dstu-kernel`：22 个测试全绿（Slot 先注册/重新 provide、HookSet 快照/移除/锁中毒、
  分带顺序、gate 短路、waterfall、Plugin 幂等、apply 失败回滚、卸载逆序）。
- `cargo check --lib`、`cargo clippy -p dstu-kernel -- -D warnings`、`cargo fmt --all` 通过。
- `node scripts/check-crate-layers.mjs` 通过，输出含 `dstu-kernel core`。
- 受影响模块定向测试：`vfs::` 475 通过，唯一失败是基线已知的
  `attachment_repo::tests::test_build_original_path_candidates_cross_platform_remap`（baseline FAILED，
  storage/vfs 门禁同样失败）；`media::` 106、`memory::` 111、`question_export_service::` 4、
  `web_search` 33 通过。
