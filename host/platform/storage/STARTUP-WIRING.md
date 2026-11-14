# F3 启动接线：migrationsDir、purge 与 startupGate

日期：2026-11-04（C2 纠偏后）。迁移目录已接通；main 已有 F2 gate provider 与 F1
finishStartup 标记。F3 本分支补命令等待消费；W13 pre-storage 同步基线 reset 仍待 L20/F1。
各项需独立签收，不能把缺 F3 消费归到 F2。

## 1. 已闭合：迁移目录

Rust 打包时把 `src-tauri/migrations/**` 作为资源发布，迁移器按文件原文计算 checksum。
Electron 侧对应：

- `electron/main.ts:66-72`：打包态取 `process.resourcesPath/migrations`，开发态取
  `src-tauri/migrations`，并写入 `process.env.DS_MIGRATIONS_DIR`；
- `electron/main.ts:451`：`app.migrationsDir` shell 请求返回同一路径；
- `electron/electron-builder.config.cjs` 用 `extraResources` 逐字节复制迁移目录；
- `host/platform/storage/index.ts:107-115`：`config.migrationsDir` 优先，否则读取
  `DS_MIGRATIONS_DIR`；没有静默回退到仓库路径。
- `host/platform/storage/tests/startup.test.ts` 新增用例：把 `DS_MIGRATIONS_DIR`
  指向不存在的目录时启动必须失败，证明 Host 真的使用了 F2 传入的路径。

profile `host/profiles/desktop.json` 没有 storage 的 `config` 条目，因此生产路径实际
依赖环境变量。F2/X4 需要保证：Host 进程 fork 时继承该变量；打包资源路径存在；
`electron/scripts/verify-migrations.mjs`/`electron/scripts/package.mjs` 的校验与运行时
使用同一目录（逐字节一致，checksum 依赖原文）。

## 2. 已对齐：DataSpaceStartup 的 Rust 顺序

`src-tauri/src/lib.rs:1015-1055` 的顺序：

1. `should_purge_on_start`（`.purge_on_next_start` 标记）；
2. `purge_all_local_data(base, active, reset_sync_baseline)`：
   - 删除 active 目录内容（保留 `backups` / `temp_restore` / `migration_core_backups`）；
   - 删除并重建非活跃槽、清理 `.trash-*` 残留；
   - 调用 `reset_sync_baseline`（L20b 的 `reset_default_after_local_purge`）；
3. 有任何删除错误：保留标记、记录 `startup_cleanup` 失败、**不打开业务库**；
4. `clear_purge_marker`；
5. 之后才跑迁移/打开业务库。

`host/platform/storage/startup.ts:24-42` 已按同样顺序实现：

- `DataSpaceManager.initializeOnStart()`（pending 切换等）；
- active 目录 mkdir、清理 `temp_zip_export`；
- `purgeAllLocalData(base, active, resetSyncBaseline)`；
- `had_errors` → `startup_cleanup` 失败并保留标记；
- `clearPurgeMarker`。

`startup.test.ts` 的
`pending switch and purge complete before migrations.runAll opens the active databases`
覆盖“purge 在迁移/打开业务库之前完成”。

## 3. 未闭合 A：`storageStartupSync` 没有生产提供方

F3 在 `host/platform/storage/index.ts:71-75` 构造回调：

```ts
const startup = new DataSpaceStartup(ctx.app.dataDir, ctx.secrets.publication, async () => {
  const sync = ctx.get('storageStartupSync');
  if (!sync) throw new Error('L20 storageStartupSync 服务尚未就绪');
  await sync.resetDefaultAfterLocalPurge();
});
```

现状：

- 全仓没有任何插件 `provide('storageStartupSync')`；
- L20b 的 `host/plugins/sync-support/index.ts:40-60` 只发布 `syncSupport`，并且
  `inject: ['storage', 'notes']`；
- 真正的重置逻辑在 `host/plugins/sync-support/src/state.ts:224-238`，需要
  `storage.database('sync_state')` 的句柄；
- L20b 的 `api.ts:179-183` 注释说“对应 F2 启动时通过 `storageStartupSync` 调用”，
  但 F2 没有提供该服务，L20b 也没有暴露它。

因此只要启动时存在 purge 标记，F3 的 `startup.start()` 会在
`purgeAllLocalData` 内抛错，`recovery.setFailure('startup_cleanup', ...)`，业务库
保持关闭。这是真实缺陷，不是测试替身可以掩盖的。

### 为什么现有 sync-support 不能提供前置 reset

`host/kernel/runtime.ts:257-264` 的 `installAll` 是 **逐个 `await start(entry)`**：
F3 的 `apply` 全部完成后，后面的 L20b 才开始 `apply`。F3 的 `startup.start()` 在
`apply` 内同步等待 purge 完成，所以 L20b 不可能在 F3 purge 时提供任何服务。
即使把 L20b 放到 profile 最前面，它 `inject: ['storage']` 也会等 F3 提供
`ctx.storage`；而 `ctx.storage` 是在 `startup.start()` 之后才构造的
（`index.ts:106-110`）。把 `storage` 提前 provide 也不够：`sync_state` 句柄要求
数据空间已经初始化，仍绕不开启动时序。

### 正式时序：L20 提供 storage-independent 的 pre-storage 服务

purge 在 F3 的 `apply` 内、`ctx.storage` 发布之前执行；因此它只能是 storage 的前置步骤，
**不能进入 D2 finalizer**（finalizer 在全部插件 apply 之后、迁移之后才运行）。要保持
Rust `lib.rs:1021` 的边界，L20 必须提供一个**独立于 storage 的启动插件**：

```ts
// host/plugins/<L20 startup bootstrap>/index.ts（名称由 L20 定，建议 dstu.sync-startup）
definePlugin({
  meta: { id: 'dstu.sync-startup', lane: 'L20-sync', provides: ['storageStartupSync'] },
  inject: ['paths'], // 不能 inject 'storage' / 'syncSupport' / 'notes'
  apply(ctx) {
    ctx.provide('storageStartupSync', {
      resetDefaultAfterLocalPurge() {
        // Rust SyncStateStore::open_default() + reset_default_after_local_purge()
        // 路径：syncStateDatabasePath(ctx.paths.os.dataLocal)
        // 独立 better-sqlite3 连接；mkdir -p deep-student/sync；
        // CREATE TABLE IF NOT EXISTS ...；同一 IMMEDIATE 事务删除
        // consume_cursor / legacy_processed_key / tombstone_watermark /
        // instance_binding / device_history，保留 upload_seq。
      },
    });
  },
});
```

约束：

- 该 provider 的 apply 必须先于 storage apply 完成。目录扫描顺序不等于安装顺序：
  `host/profiles/generate.ts:4-7,71-75` 明确 loader 按 inject 拓扑排序。
  F1 已给出最小方案：生成器找到唯一 meta.provides 含 storageStartupSync 的插件，放在
  kernel 固定首条之后、所有 platform 条目之前，并要求 inject 仅 paths。稳定拓扑于是
  保证 paths → bootstrap → storage，不改 F3 inject，不新增通用启动框架。
  L20 provider 不得 inject storage/syncSupport/notes。方案、真实 L20 交付与 main 集成状态分开记。
  **F1 候选已交付**：责任分支 HEAD `c1efab411`（含前序实现检查点，不能只摘末尾文档提交）。
  已亲读该版本 generate.ts 的唯一 provider 校验、仅 paths 约束及固定位置重排；亲取
  `20261104115116-c0797e`：真实生成器/loader 3 passed / exit 0，无 Errors；
  `20261104115117-be465f`：typecheck exit 0。祖先检查确认该 HEAD 尚未进入 main。
  当前 main/本工作树仍未发现 L20 生产 provider；排序机制通过不等于 reset 业务通过。
  F1 接缝、F3 API 与 L20 provider 正常进入 main 后，使用正式 desktop.json 验证
  无标记、purge 成功、reset 失败、清 marker 失败四条路径，检查五表重置/保留 upload_seq、
  marker/业务库/恢复状态。旧 D2 八例不重复，亦不混合合入 F1/F3 证据分支。
- `sync_state.db` 在 `<dataLocalDir>/deep-student/sync/sync_state.db`，**不在**数据空间槽内
  （Rust `state.rs:22-29`）。在数据空间初始化前打开它不违反“业务库必须在迁移后打开”；
  Rust 的 reset 也是独立 `open_default()`，不经过存储注册表。
- F3 已发布 `syncStateDatabasePath(dataLocalDir)`（`host/platform/storage/api.ts`），L20 用它
  取路径，避免复制 F3 的路径规则；busy_timeout 5000 与 Rust 一致。
- 重置失败必须抛错；F3 会包成 `重置同步消费基线失败: <message>`，保留
  `.purge_on_next_start`、记录 `startup_cleanup`，业务库保持关闭。
- **不要**在 L20 `sync-support` 里 provide 该服务：它 inject `storage`，F3 purge 时尚未
  apply。也**不要**用 `.sync_baseline_reset_pending` 标记把 reset 推迟到迁移后：那会把
  “reset 成功后才清 purge 标记”的崩溃安全边界改成“先清标记、后 reset”，并让空白业务库
  在同步基线未复位时打开；与 Rust 顺序不一致，不作为正式方案。
- 如果 L20 认为必须由组合根提供 pre-storage 入口而不是新增插件，需要协调者/架构师裁定
  入口形式；在该裁定前 F3 侧保持 fail-closed，不造空服务、不复制 L20 表写入。

F3 侧消费点保持不变：

```ts
const startup = new DataSpaceStartup(ctx.app.dataDir, ctx.secrets.publication, async () => {
  const sync = ctx.get('storageStartupSync');
  if (!sync) throw new Error('L20 storageStartupSync 服务尚未就绪');
  await sync.resetDefaultAfterLocalPurge();
});
```

`startup.test.ts` 已用“provider 插件排在 storage 之前”的真实组合验证：reset 在 storage
发布前、purge 之后、`.purge_on_next_start` 仍存在时执行；reset 成功后标记才清除，随后
迁移/业务库打开。没有 provider 时仍保持 fail-closed（标记保留、`startup_cleanup` 失败）。
这只证明 F3 的时序契约，不替代 L20 的真实 provider；L20 插件合入 main 后仍需重跑。


## 4. F3-V2-06：消费 main 已发布的 startupGate

Rust：

- `dstu-platform/src/startup_gate.rs:24`：`STARTUP_READY_WAIT = 120s`；
- `lib.rs:838`：setup 闭包首行 `StartupReadyGuard::new()`，所有退出路径（含恢复
  模式提前返回）都会 `mark_startup_ready()`；
- `data_space.rs:2172-2186`：`get_startup_recovery_status` 先
  `wait_startup_ready(120s)`，超时报
  `应用启动初始化超时（120 秒），请重启应用`；
- `data_governance/commands.rs:430-438` 的维护状态命令同样等待。

main 已有：`host/profiles/generate.ts:27,74` 纳入 electron/index.ts；F2 `dstu.shell`
provide startupGate；F1 `host/kernel/connection.ts:111-127` 的 finishStartup 正常路径先
执行 finalizers 再 mark，恢复模式跳过业务 finalizers 后 mark。失败走 HostFatal，不能在
finally 无条件 Ready。F3 registry 尚未合入 main、必需钩子注册失败政策仍是另外两项。

F3 本分支的 `get_startup_recovery_status` 在调用时通过 F2 `electron/api.ts` 类型契约取
真实 gate，等待 120000ms 成功后才读 startup.status；超时返回 Rust 精确 AppError 文案，
状态读取异常返回 `读取启动恢复状态失败: …`。gate 缺失是明确的配置错误
`启动完成闸门服务未注册`，不把缺失等同就绪。采用按需获取，不使纯存储服务依赖完整 shell。

`tests/startup-gate-command.test.ts` 装真实 F2 shell + F3，覆盖正常/恢复模式等待、
晚订阅、120s 超时、状态读取错误和缺 provider；只推进测试时钟，不替换 wait 实现。
原 startup/recovery-export fixtures 安装真实 shell 并在 fixture 初始化完成后 mark，
原业务断言均保留。该 fixture 不冒充 F1 serveHost 组合根测试。

## 5. 推荐启动顺序（接线完成后）

> F1 main 组合根在 `host/kernel/connection.ts:111-127` 的 `finishStartup`：正常启动
> `await runStartupFinalizers()` 后直接 `startupGate.markStartupReady()`，不是由 F2 注册
> gate finalizer；下方 F2 finalizer 仅为可选接线。候选证据分支 `a612c4496` 已用真实
> `StorageCordisService` + `StartupFinalizerRegistry` + F2 gate 经 `serveHost` 通过
> job `20261104075748-2c9c0f`（8 passed / exit 0）；组合根已在 main，F3 registry 仍待集成。

```text
Electron main
  ├─ 解析 migrationsDir（打包 Resources/migrations / 开发态 src-tauri/migrations）
  ├─ process.env.DS_MIGRATIONS_DIR = migrationsDir
  └─ fork Host（继承 env）
Host loadStartupProfile
   ├─ F2 dstu.shell apply：createStartupGate + provide('startupGate')（已在官方 profile）
  ├─ L20 sync-startup apply（profile 中必须在 storage 之前）
  │    ├─ inject: ['paths']（不 inject storage / syncSupport / notes）
  │    └─ provide('storageStartupSync', { resetDefaultAfterLocalPurge })
  ├─ F3 storage apply
  │    ├─ 构造 DataSpaceStartup（provide dataSpace）
  │    ├─ initializeOnStart（pending 切换）
  │    ├─ purge（若标记存在）
  │    │    ├─ 删除 active / 非活跃槽
  │    │    ├─ ctx.get('storageStartupSync').resetDefaultAfterLocalPurge()
  │    │    │    ├─ 独立打开 sync_state.db（Rust open_default）
  │    │    │    └─ 删除消费游标/tombstone/instance/device_history，保留 upload_seq
  │    │    ├─ 失败 → startup_cleanup，保留标记，业务库不打开
  │    │    └─ 成功 → 清 .purge_on_next_start
  │    ├─ 构造 StorageCordisService（migrationsDir = config ?? DS_MIGRATIONS_DIR）
  │    └─ migrations.runAll()
  ├─ L20b sync-support apply：storage.database('sync_state') + provide('syncSupport')
  └─ 其余业务插件
        └─ L21：registerFinalizer('restore_activation', finalizeRestoreActivation)
Host profile 安装完成
   ├─ 非恢复模式：await ctx.storage.runStartupFinalizers()
   └─ 成功后 startupGate.markStartupReady()（恢复模式跳过 finalizers 后 mark；失败不 mark）
前端调用 get_startup_recovery_status
  └─ waitStartupReady(120s) → status / 超时错误
```

## 6. X4 验收建议

- 打包资源检查：`Resources/migrations` 与仓库目录逐字节一致（checksum 敏感）；
- 启动测试：无标记、正常标记、purge 失败、重置失败、恢复模式五条路径；
- 时序测试：L20 前置 provider 在 storage 发布前完成 reset；成功才清 purge 标记；
  reset 失败时标记保留；
- gate 测试：启动完成前命令阻塞、完成后返回；120 秒超时文案与 Rust 完全一致
  （推进真实 gate 的测试时钟，不真等）；
- 不把 `app.migrationsDir` shell 请求当作 Host 的唯一来源；Host 读 env，shell
  请求保留给需要该路径的渲染进程/调试。

## 7. 相关文件

- `electron/main.ts`、`electron/electron-builder.config.cjs`
- `electron/index.ts`、`electron/startup-gate.ts`、`electron/api.ts`
- `host/kernel/profile.ts`、`host/kernel/runtime.ts`、`host/profiles/generate.ts`
- `host/platform/storage/index.ts`、`startup.ts`、`startup-cleanup.ts`
- `host/plugins/sync-support/index.ts`、`src/state.ts`、`api.ts`
- `src-tauri/src/lib.rs:1015-1058`
- `src-tauri/crates/dstu-platform/src/startup_gate.rs`
- `src-tauri/crates/dstu-storage/src/data_space.rs:2172-2186`
- `src-tauri/crates/dstu-storage/src/startup_cleanup.rs:114-198`
