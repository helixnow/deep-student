# W30 进度（自动备份调度器与备份侧审计修复）

分支 `assault/W30-auto-backup`，起点 INT `6c491e6f`。

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| V04-01 自动备份调度器 | 完成 | `src/auto-backup-scheduler.ts`，逐项对齐 `backup_config.rs:278-711`；假时钟测试 + 桌面 profile 接线测试 |
| V03-02 方案 A | 完成 | 启动期 `data-governance-migration-status` / `backup-jobs-resumable` 改为 Cordis `ctx.emit`，只到 Host 内部监听者；拉取兜底 `data_governance_get_migration_status` 形状核对过 |
| V01-01 governance-tool 服务取用 | 完成 | `services.get('backup' / 'sync')` + undefined 检查；`sync_run` 只把 `CloudConfigSsotError` 映射为云配置错误 |
| V02-02 cloud_config_ssot 未配置视图 | 完成 | get / save / clear / publish 省略为 None 的 `provider` / `root` / `config` |
| backup.* 设置键读点审计 | 完成 | 结论写在交付报告；`loadAutoBackupStatus`（`src/backup-commands.ts`）无生产调用方，Rust `get_auto_backup_status` 未注册 |

## 第二轮（A01 复核 W30-a6e4ccb7 的测试缺口，起点 a6e4ccb7 + INT `390f244b`）

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 到期后再次备份 | 完成 | `auto-backup-scheduler.test.ts`：LAST = 当前 − 24h 边界用例（LAST / next_due_at 取完成时刻）；首次成功后第 24 个整点轮产出第二个 ZIP（max_backup_count=2 照常轮转）。变异 `shouldBackup = lastBackupTime === null` 时这两条变红，其余 18 条仍绿 |
| 失败后重试 | 完成 | 同文件：失败后 3600 s 的检查再次尝试，目录恢复后产出 ZIP、清掉 last_error。变异“检查失败后停止调度”时只有这一条变红 |
| 恢复模式 | 完成 | `auto-backup-profile.test.ts`：真实恢复路径（损坏的 `recovery/current-startup-incident.json`）+ 生产组合根 `serveHostCore` + 官方 profile；插件装配并注册 finalizer，但 120 s + 1 h 后没有任何 `[AutoBackup]` 日志。上一轮报告称该文件覆盖恢复模式，当时并没有 |
| /tmp 遗留 | 完成 | `/tmp/W30-startup-events.new.ts`（V03-02 测试草稿）、`/tmp/W30-v02-02.patch`（已作为 6559a2c1 落地）已删除 |

| 合 INT 后的语义冲突 | 完成 | `host/platform/settings/backup-config.ts:68`：W07 `7aff719f` 把 `ioMessageFor` 第二个参数改成平台字符串，W30 上一轮仍传布尔值（TS2345）；改为 `process.platform`，单独提交 |

调度器源码没有改动：新测试没有揭示调度器 bug。

## Rust 修复（status: proposed）

- `RF-W30-auto-backup-operation-guard`：自动备份取完整数据治理租约（当前操作 + 跨进程锁），Rust 只拿全局限流许可。
- `RF-W30-auto-backup-job-stuck-running`：任务创建后读状态失败时任务记 failed，Rust 停在 running。
- `RF-W30-auto-backup-staging-sweep`：持租约清理中断留下的 `auto-backup-staging-*`（含明文密钥），Rust TempDir 崩溃后永久残留。
- `RF-W30-auto-backup-portable-verify-result`：剥离密钥后校验 `isValid=false` 时本次失败，Rust 忽略后照常发布。

## 决定

- 调度器放在备份插件内（desktop-only）；移动端没有备份插件，见交付报告的交接。
- 调度器文件本身不 import Node 模块；文件系统操作复用 `host/platform/settings/backup-config.ts` 的既有 helper
  （`getEffectiveBackupDir` / `createAutoBackupStagingDir` / `cleanupOldBackups` / `sweepStaleAutoBackupStagingDirs`），备份插件的 portability gateway 因此 +1。
- 启动：finalizer `backup.auto-backup-scheduler`（after `backup.resumable-jobs`），恢复模式跳过 finalizer = Rust setup 提前返回。
- V03-02 用 Cordis `ctx.emit` 而不是删掉事件：Rust 的 setup 期 emit 存在但前端还没挂监听，结构上丢失；Host 保留同名内部事件，
  前端提示靠挂载后拉取。`backup-jobs-resumable` 同理（Rust 启动不弹“发现 N 个可恢复任务”，面板挂载时自己拉 `listResumableJobs`）。
