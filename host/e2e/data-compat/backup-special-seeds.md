# W21：G3 backup special seeds

基线：独占 `wt/W21`，初始 status 干净，已 `merge --ff-only bead2d18`。

## 完成范围

补齐五个 **SQL/synthetic** fixture，支撑现有 pending JSON 的六个场景；不移动语料、不改变 expect：

- `l21-assets-root-symlink`：`slots/slotA/images -> asset-target`，目标有实际文件。
- `l21-assets-nested-symlink`：`images/link -> ../asset-target`。
- `l21-assets-nested-fifo`：`images/pipe` 是 `mkfifo` 创建的真实 FIFO。
- `l21-live-vfs-not-sqlite`：完成 slot SQL replay 后，以固定非 SQLite 字节替换 `databases/vfs.db`；诊断和 metadata 两个场景共用。
- `l21-backups-symlink-escape`：`recovery/backups/20260107_000000_symlink_out -> ../outside-backup`，目标有合法 v3 manifest。逃逸 backup root，但仍在各自隔离 seed 内，不需要外部用户文件。

均保持 `sql-constructed` 分类；没有 A/B 应用输出，没有创建 PROVENANCE，没有更名正常备份冒充特殊 seed。A-produced 的三个 seed 不在本次产出中。

## 核心公用 fixture 变动（明确清单）

- `__fixtures__/scenario-seeds.ts`：复用原 empty/overlap 检查，复制改调 `seed-files.ts`。
- 新增 `__fixtures__/seed-files.ts`：lstat 分流，普通文件 COPYFILE_EXCL、目录递归、link 原文重建、FIFO 用 mkfifo 重建；其它特殊类型明确拒绝。原 `cpSync` 不支持 FIFO；尝试 filter 拦截时 Electron Node 对已存在空目标根报 EEXIST，故改为短小同步遍历，不新增框架。
- `__fixtures__/database-state.ts`：不跟随 link，不打开特殊文件；非 SQLite 后缀文件/损坏 SQLite 保存 size+sha256 原始证据。只有 NOTADB/CORRUPT 被转为证据，权限等其它异常不吞。比较器新增 file 差异；普通快照 shape 不变，特殊证据放可选 `files`，不污染 `.databases[*].tables` 消费者。
- `__fixtures__/seed-determinism.ts`：link 文本、special 类型比较，不再盲读 FIFO。
- `__fixtures__/backup-seeds.ts`：种子注册及真实构造。
- `SCENARIO-V0.md`：同步特殊证据约定；旧 scenario-v0 测试更新坏库期望，原 backup 测试与特殊文件断言分开，避免旧字节 digest 读 FIFO。

W13 record 脚本和 `g3-inputs.mjs` **均未修改**。现有 digestSeedFiles 已支持 link/special；定向测试直接调用 seedDirectoryDigest 验证五类输入及 A1/A2/B 拷贝摘要相同。normalizer 当前通过 `{...state, databases}` 保留可选 files。

## Rust 路径与静态预期

- `src-tauri/crates/dstu-sync/src/data_governance/backup/assets.rs:1556-1619`：scan_assets 用 symlink_metadata；根 link → “资产扫描根不是普通目录”；递归 link → “资产扫描不允许符号链接”；FIFO → “资产扫描包含非常规条目”。`src-tauri/src/data_governance/commands_asset.rs:25-40` 包装为扫描失败。种子精确落在这些路径。
- `src-tauri/src/data_governance/commands_backup.rs:953-969`：canonicalize 后不在 backup root 内 → “备份路径越界”；相对 link 在每个 copy 中均指向各自 recovery/outside-backup，不回指 catalog。
- `src-tauri/src/data_governance/commands.rs:500,739,823,1006,1061`：schema registry/迁移状态/健康检查/数据库状态/诊断读 live DB，坏 VFS 不应被 fixture 准备阶段提前拒绝。maintenance status（:431）是独立状态；沿用现有 metadata scenario 非 error 预期。**本次只对照源码与原语料，不宣称启动行为或真实 Rust IPC 已验证**；若 A 启动重建/改变坏 VFS，实际录制快照会保留结果供差分。

## 本机定向验证

`npm run test:host:electron -- host/e2e/data-compat/g3-backup-special-seeds.test.ts host/e2e/data-compat/g3-backup-seeds.test.ts host/e2e/data-compat/scenario-v0.test.ts --maxWorkers=2`

结果：3 files / 26 tests passed（2026-11-07，macOS，约 3.6 秒）。包括五类种子注册/六场景映射、A1/A2/B 复制快照与 W13 摘要、坏库字节变化、外部 dangling link 不跟随、损坏 SQLite header、独立重建指纹。FIFO `.db` 复制/快照另在 15 秒硬 deadline 子进程运行，无写端，防止误读挂死。

TypeScript compiler API 按 tsconfig.host 编译并筛选本次改动文件：0 diagnostics。未跑全量、未 SSH、未重编 A、未正式录制；worker 最大 2。

## 交接边界

这是静态 fixture 执行能力就绪，**不是 G3 正式通过**。现有六场景仍留在 pending-seed；真实 A1/A2/B 行为、Linux 原生环境、receipt/source tree、正式新指纹/录制由主代理/W13 后续确认。三类 A-produced 原料必须等 Linux 绿与真实 producer 窗口后另交，不能以本机 fixture 测试替代。
