# W07 数据兼容：进度记录

路径：`host/platform/paths/**`、`host/platform/secrets/**`、`host/platform/storage/**`（`api.ts`、`errors.ts`、迁移
runner 归 W14；`startup-finalizers.ts` 归 W10；`migration/backup.ts` 等恢复部分归 W20）、
`host/plugins/vfs-repos/repository/attachment*.ts`。分支 `assault/W07-data-compat`。

## 第六轮（上一个代理，末端 3f26d34e，报告 `.reports/agent-final/W07-1208-3d2d59a8.md`）

- 7a647743：browser.db 的 refinery 日志按 Rust target 写进主日志；删除从未生效的 `MigrationWorkerOptions.logTarget`。
- 2892b95f：测试库三个写命令改走 `getPersistentAppDataDir`（RF-W07-persistent-app-data-no-silent-relocation 追加测试）。
- 559ac6d4：compat 与 11 个叶子文件改从 `util/portable.ts` 导入，`--mobile-readiness` 网关 reach 合计 3587 → 3454。
- 65c1ba57：RF 测试标题对齐 rust-fixes 门禁。
- 3f26d34e：`BackupCrypto.encryptBackupStream/decryptBackupStream`、`FileCipherSession.encryptStream/decryptStream`
  （`secrets/dsbk-stream.ts`，无 Node 依赖）。
- 未做：§8 可选优化（没有点名给 W07 的条目）。

## 第七轮（本轮）

开工合并 INT `6c491e6f`（ba5478fc）。提交（按时间）：

| SHA | 内容 |
|---|---|
| 7aff719f | paths：`io::Error` Display 按平台取 strerror（macOS 的 EBUSY/EXDEV/ETIMEDOUT/EILSEQ 与 glibc 不同） |
| b8b44fd3 | storage：启动恢复与数据空间各处错误文案改成 Rust `io::Error` Display（W21 交接） |
| c19bab40 | storage：`writeState` 替换后目录 fsync 尽力而为，失败忽略 |
| 8af07905 | storage：`state.json` / `.tmp` 不是合法 UTF-8 时按读失败处理 |
| 6c6c6115 | paths：`device_id` 文件不是合法 UTF-8 时忽略（同 `read_to_string().ok()`） |
| c913672c | RF-W07-crypto-root-adopts-slot-master-key：启动时把活动槽位 `.master_key` 复制到应用根目录 |
| 83a8c2fc | RF-W07-legacy-root-security-entries-copy：旧版根目录迁移时 `.master_key`/`.secure` 留根目录并复制到 slotA |
| 556c1e76 | 非 ASCII 数据目录的迁移与主密钥复制测试 |
| e2e772f7 | storage `API.md`：持久/临时数据目录的调用方迁移说明 |
| 99b41176 | secrets `API.md`：流式备份加解密用法（password_proof、cloud_transfer） |
| e6d2bac9 | locations：忽略目录 fsync 失败的 catch 标注 boundary-allow |
| 2cfd86b9 | paths：设备 ID 纯函数移到不依赖 Node 的 `device-id-core.ts` |

### 任务 2：W14 的 api.ts 声明

W14 `ccabdba1`（尚未进 INT）在 `FileManagerPathsService` 上声明的 `getPersistentAppDataDir(): string`、
`getTempAppDataDir(): string` 与 `storage/index.ts:196-198` 的实现、`file-manager.ts:255/268` 的语义一致：持久目录只用活动槽、
不可写抛 `AppError.file_system`（普通值），临时目录走 Rust 回退链；`getWritableAppDataDir` 标 `@deprecated` 也一致。
`storage/index.ts:194` 那句「尚未声明」的注释要等 ccabdba1 进 INT 后再删（交付前合并时检查）。调用方迁移说明见 `API.md` §9.4。

### 任务 3：老用户升级的数据兼容审计（对照 Rust）

「一致」指逐行对过 Rust 并有测试；「已修」列出提交或 RF；「未修」写明原因。

| 场景 | 检查点 | Rust | TS 现状 | 结论 |
|---|---|---|---|---|
| 已有 Tauri 数据目录 | `slots/state.json` active/pending、restore cutover 租约 | data_space.rs:1289-1423 | 同语义，`data-space.test.ts`、`data-compat/data-space.test.ts` | 一致 |
| 已有 Tauri 数据目录 | `state.json` 含非法 UTF-8 | `read_to_string` 失败 → 读 `.tmp` → 按槽位推断 | 修前有损解码后照常解析 | 已修 8af07905（`slot-state-decode.test.ts`） |
| 已有 Tauri 数据目录 | 写 `state.json` 后目录 fsync 失败（exFAT/SMB） | `let _ = dir.sync_all()` 忽略 | 修前抛错 | 已修 c19bab40（`slot-state-write.test.ts`） |
| 已有 Tauri 数据目录 | `device_id` 文件含非法 UTF-8 | `read_to_string().ok()` 视为不存在 | 修前有损解码当成 ID | 已修 6c6c6115（`device-id.test.ts` 3 例） |
| 已有 Tauri 数据目录 | 启动失败时 `recovery_error` 文案 | `io::Error` Display，如 `File exists (os error 17)` | 修前是 Node 文案 `EEXIST: file already exists, mkdir …` | 已修 b8b44fd3、7aff719f（`startup-io-error-text.test.ts`、`portability.test.ts`） |
| 已有 Tauri 数据目录 | LLM API Key 主密钥位置 | LLMManager 用活动槽 `.master_key`（llm_manager/mod.rs:4757），备份/恢复用根目录 | llm 插件 `openCrypto(ctx.app.dataDir)` 用根目录，升级后新建密钥，API Key 解密失败并被清空 | 已修 RF-W07-crypto-root-adopts-slot-master-key（`master-key-adoption.test.ts`） |
| 已有 Tauri 数据目录 | 非活动槽位有自己的 `.master_key`（只在旧版 Rust 恢复后出现） | 切过去后读那个槽位的密钥 | 统一用根目录，那边的密文解不开 | 未修：已知限制，写在 RF dataCompat；Rust 恢复本身也解不开 |
| 凭据已存在 | SecureStore 目录 | 主库：`db_path.parent()`（活动槽）；云/MCP/bilibili：`app_data_dir` | `settings/index.ts:190` 活动槽；`secrets/commands.ts:6`、`mcp/index.ts:213`、`backup/src/zip-commands.ts:94` 根目录 | 一致 |
| 凭据已存在 | 钥匙串条目 | service `deep-student`，account `key_seed.<指纹>`，指纹由种子派生 | `keystore.ts:62` 相同 | 一致（macOS 实测）；Linux Secret Service 的属性兼容（@napi-rs/keyring 2.1.2 对 keyring 3.6.3）本机无法验证 |
| 凭据已存在 | Windows DPAPI 种子 | entropy `deep-student.key_seed.dpapi.v1` | 常量相同 | 一致（未在 Windows 上实跑） |
| 凭据已存在 | 安全目录建不出来 | 回退到系统临时目录 | 报错不回退 | 已登记 RF-W07-secure-store-temp-fallback（已批准，前几轮） |
| 旧版 schema / 迁移中断 | 无槽位布局的旧版根目录迁移，`.legacy_migration_pending` 重试 | ensure_layout data_space.rs:1035-1200 | 逐行一致（含冲突 fail-close、重试清目标） | 一致 |
| 旧版 schema / 迁移中断 | 旧版根目录的 `.master_key`、`.secure` | 整体搬进 slotA，根目录云凭据丢种子 | 修前留根目录、slotA 没有 → 主库敏感设置解不开 | 已修 RF-W07-legacy-root-security-entries-copy（`legacy-root-security-entries.test.ts`） |
| 旧版 schema / 迁移中断 | 恢复切换中断（crypto publication journal） | `recover_crypto_publication` 先于业务库 | 同序；主密钥复制排在它之后 | 一致 |
| 旧版 schema / 迁移中断 | 根目录条目名不是合法 UTF-8（仅 Linux） | `OsString` 原样 rename | `readdirSync` 有损解码后 rename 失败，启动进恢复模式 | 未修：只在 Linux 且存在这种文件名时触发，修法要改成 Buffer 版 readdir 并贯穿迁移、恢复、清理，本轮来不及 |
| 只读 / 外置盘 | 活动槽不可写时写持久数据 | 静默写到 `data_dir()/DeepStudent` 或临时目录 | 抛 `持久数据目录不可用（…）`，不回退 | 已登记 RF-W07-persistent-app-data-no-silent-relocation（已批准）；调用方迁移见 API.md |
| 只读 / 外置盘 | 数据目录只读时的启动错误 | `Read-only file system (os error 30)` | 同文案（b8b44fd3） | 一致 |
| 只读 / 外置盘 | macOS 外置盘持久化强度 | `sync_all` 走 `F_FULLFSYNC` | Node `fsync` 不发 `F_FULLFSYNC` | 未修：Node 无对应 API，需要原生模块 |
| 只读 / 外置盘 | Windows 上的 io 文案 | `FormatMessageW` 文本 + `(os error N)` | `io-error.ts` 在 win32 回退 Node message | 未修：W06 `electron/shell/errors.ts` 已有 Windows 表，可共用，需与 W06 约定导出位置 |
| 非 ASCII 路径 | 中文/重音/emoji/空格的数据目录：迁移、状态、启动、主密钥复制 | 字节原样 | 同上（`non-ascii-data-dir.test.ts`） | 一致 |
| 非 ASCII 路径 | 错误文案里的 `{:?}` 路径 | Debug 转义控制字符与组合附加符（如 NFD 的 `e\u{301}`） | `JSON.stringify` 只转义控制字符，写法 `\u0301`/`\u001f` 不同 | 未修：只影响错误文本，不影响数据；改动面跨所有 `{:?}` 调用点 |

### 任务 4：`--mobile-readiness` 对照

本轮开工（合并 INT 后）与交付前都是 26 个插件里 1 个 ready。我路径内的网关与触达 Node 的文件：

| 指标 | 开工 | 交付前 |
|---|---|---|
| 我路径内的网关文件 | 12 | 12 |
| 我路径内触达 Node 的文件 | 13 | 13 |
| 新增不依赖 Node 的入口 | — | `paths/device-id-core.ts`、`paths/io-error.ts`（已有，`ioMessageFor(error, platform)`） |

数字没变：剩下的网关都由消费方的导入决定，换成可移植入口要改别的 lane 的文件（见交接）。按交接改完后预计：

- sync-providers 去掉 `paths/index.ts` 网关（`device_id.ts:14` 改从 `device-id-core.ts` 导入）。
- chat、vfs、vfs-handlers 去掉 `secrets/crypto-service.ts` 网关（`decodeBase64Standard` 改从 `util/portable.ts` 导入）。
- agent-orchestration、agent-workspace、chat、llm、qbank、sync、translation 这 7 个插件去掉 `paths/compat.ts` 网关
  （`ioMessage(e)` 改成 `ioMessageFor(e, ctx.app.platform)`）。
- backup 的 `secrets/api.ts` 网关来自 `createBackupCrypto` 值导出（`secrets/api.ts:269`），`host/platform/API.md:367` 把它写成正式公开 API，挪走需要 W01/主代理决定。

### 任务 5

`host/platform/secrets/API.md`：流的所有权、错误文案、password_proof 用丢弃型 sink 试解、cloud_transfer 用
`openWrite(…, { mode: 'atomic' })` 代替临时文件 + rename。

### 交接

| 对象 | 位置 | 内容 |
|---|---|---|
| W05 | `host/plugins/llm/index.ts:107` | 保持 `openCrypto(ctx.app.dataDir)`（根目录），与 RF-W07-crypto-root-adopts-slot-master-key 和备份一致，不要改回槽位 |
| W05 | `host/plugins/llm/index.ts:182` | 没有 `fileManagerPaths` 时回退到 `join(ctx.app.dataDir, 'images')`，注释说活动槽，实际是根目录 |
| W05 | `host/plugins/llm/api.ts:155` | `getWritableAppDataDir` → `getTempAppDataDir` |
| W01 | `host/platform/API.md:356` | 文档写 `openCrypto(slotDir)`，实际约定是应用根目录（见上一条 RF） |
| W01 / 主代理 | `host/platform/API.md:367`、`host/platform/secrets/api.ts:269` | `createBackupCrypto` 值导出让 `secrets/api.ts` 闭包触达 Node，是否改由 node 入口导出 |
| W08 | `host/plugins/sync-providers/src/device_id.ts:14` | 改从 `platform/paths/device-id-core.ts` 导入 |
| W08 | `sync-providers/src/password_proof.ts:185-187`、`cloud_transfer.ts:158-172` | 改用流式解密，见 secrets `API.md` |
| W08 | `backup/BLOCKERS.md:96`、`SPEC.md:458` | `runAll` 签名去掉 `logTarget`（第六轮遗留） |
| W10 | `host/plugins/anki/src/plugin-handlers-media.ts:37` | `getWritableAppDataDir` → `getPersistentAppDataDir` |
| W10 | `host/plugins/chat/src/ocr.ts:2`、`vfs/src/tools/attachment-executor.ts:7` | `decodeBase64Standard` 改从 `platform/util/portable.ts` 导入 |
| W10 | `host/plugins/chat/src/agents-md.ts:7` | `isRealUserHomeUnderTest` 是 Vitest 专用、依赖 Node，移动端闭包会带上 `paths/index.ts` |
| W04 | `host/plugins/vfs-handlers/src/upload-file.ts:15` | 同上，`decodeBase64Standard` |
| W04 | `translation/index.ts:102`、`translation/src/ocr_extract.ts:20` | → `getTempAppDataDir` |
| W04 | `media/src/pdf-ocr-sessions.ts:50` | `pdf_ocr_temp` 拼在根目录，Rust 在活动槽 |
| 各插件 | 17 处 `import { ioMessage } from '…/platform/paths/compat.ts'` | 改为 `ioMessageFor(error, ctx.app.platform)`（`paths/io-error.ts`，无 Node 依赖） |
| 主代理 | `host/platform/settings/backup-commands.ts:85` | 自带回退链副本，备份配置应走持久目录（§6 无负责人） |
| W14 | `storage/api.ts`（ccabdba1） | 等进 INT；storage-mobile PENDING_IMPORTERS 名单（第六轮遗留） |
| W20 | `storage/migration/worker-tasks.ts:12` | 注释里的 `logTarget` 已删除（第六轮遗留） |

## 第八轮（本轮）

开工合并 INT `fe5feb68`（d536ab3a）。提交（按时间）：

| SHA | 内容 |
|---|---|
| 027ea23c | V09 P2-1：插件卸载后 storage 终态关库，`database`/`openFile`/`switchToPath`/`coordinator`/`prepareMigrations` 抛 `TX_CLOSED`；裸实例 `dispose()` 仍可重开，`shutdown()` 为终态；`beforeShutdown` 让 llm_usage 收集器在关库前 flush（Cordis 并发释放 effect） |
| c7f0c133 | V01-06：paths 的设备身份日志每条现取 log 服务，log 未装载或已卸载时回落 Cordis logger |
| fd705cf9 | RF-W07-windows-rename-retry（proposed）：win32 上 EPERM/EACCES/EBUSY 退避重试，我路径内 9 个文件的 rename 接入（文件布局见 433dac40） |
| bb669942 | 删掉 `storage/index.ts` 的「尚未声明」注释和中间变量；RF-W07-pending-memory-candidates-schema 的 `fix.behavior` 写明调用点 |
| c4b97d47 | `isEncryptedBackup` 移到可移植的 `secrets/dsbk-stream.ts`，`backup-crypto.ts` 重导出同一函数（W08 交接） |
| efd57051 | `secrets/api.ts` 的 `openCrypto` 注释写明 API Key 实例用应用根目录 |
| f93cdc98 | 15 个 storage 测试/夹具改从 `node.ts` 取 Node 值，`PENDING_IMPORTERS` 清空（W14 交接） |
| 0bbcb15a | V06-L5：桌面把整数 number 按 INTEGER 绑定（同 rusqlite、sqlite-wasm）；V06-L6：`lastInsertRowid` 超过 2^53 返回 bigint |
| 5f8db341 | `API.md` 的导入说明（W14-1353 交接）；`node.ts` 头注释漏提交，见 0cf3a1b5 |
| 8f9c34fa | 本节初稿 |
| c698b9c4 | V01-06 回归：`log.logger()` 返回空时回落 Cordis logger（browser index-status-wiring 测试暴露） |
| 9c50054c | 合并 INT `390f244b` |
| 0cf3a1b5 | `node.ts` 头注释：导入方已全部改到本入口 |
| ede2a0cb | `diagnostics/tests/sql-row-decoding.test.ts` 的 REAL 种子改用 `CAST(? AS REAL)`（跟随 V06-L5；该路径 brief 无归属，断言未改） |
| 433dac40 | RF-W07-windows-rename-retry 移位：策略放进不依赖 Node 的 `paths/rename-retry.ts`（平台与单次 rename 由调用方传入），fs 包装在 `paths/compat.ts`（paths、secrets 用）和 `storage/data-space-files.ts`（storage 用）；`paths/rename.ts` 删除。revert 这条 RF 需同时 revert fd705cf9 与 433dac40 |
| e55aa4ce | 本节补全 |
| 48525805 | 门禁 tsc 发现 c698b9c4 的类型错误（Cordis logger 与 log 插件 `Logger` 不同型）：缓存类型收窄到两者共有的 info/warn/error |

### 结论

- 任务 4（W29 的 `recoverAssetDeletions` 启动接线）：W29 `58ea9f0a` 已按 Rust `lib.rs:3646-3768` 的顺序调用，我路径不用改。
- V10：目录 fsync 在我路径内都有 win32 守卫（`data-space-files.ts:17`、`locations.ts:164`、`crypto-publication.ts:30`），其余是文件 fsync；P2-1 写者探针在 `electron/storage-migration/`，归 W06。
- V07、V08：没有分给 W07 的条目；V07 把我的两条 RF 列为对 Rust 打开无影响。
- W14 建议把 RF-W07-pending-memory-candidates-schema 的选择器改成整表：违反 WAVE2-BRIEF §7（不能只写表名，门禁也会拒绝），且是已批准条目，未改。
- `fix.files` 加 `storage-mobile/migrations.ts`：门禁要求列出的文件带 `RUST-FIX` 标记，该文件归 W14 且没有标记，需 W14 加标记时同提交补上。
- Windows 的 io 文案仍不复刻：Rust 用 `FormatMessageW` 按系统语言输出（中文 Windows 上是中文），Node 在 Windows 上只给 libuv 码，原始 Win32 码已丢失。
- V09 P2-1 调用方：生产只有 `service.ts` 的 Cordis effect（drains 后 `shutdown()`）、`worker-entry.ts:71/81`（每请求一个裸实例，finally 里 dispose，不复用）、`index.ts:176`（`beforeShutdown`）、`index.ts:300`（`switchToPath`）；`e2e/data-compat/migrations.test.ts:81,107` dispose 后复用，所以裸实例 `dispose()` 保持可重开。
- V06-L5 后整数除法与 Rust 一致（`5/2` 为 2）；需要 REAL 语义的 SQL 写 `CAST(? AS REAL)`（API.md §2）。V06-L6 只做了 rowid；BLOB 读出是 Buffer 还是 Uint8Array 的差异在 `storage-mobile`，归 W14。
- mobile-readiness：fd705cf9 的 `paths/rename.ts` 直接依赖 Node，reach 2759 → 2835；433dac40 后回到 2759（ready 2、gateways 97，与 INT 相同）。
- Windows 行为本机无法实测，重试与 `path.win32` 路径只用 `process.platform = 'win32'` 加注入的 fs 错误验证。

### 验证（INT `390f244b` 合入后）

- `bin/heavy npx vitest run -c vitest.host.config.ts host/platform/storage/ host/platform/paths/ host/platform/secrets/ host/platform/diagnostics/ host/platform/storage-mobile/ host/e2e/data-compat/ host/plugins/vfs-repos/`（433dac40 上）：164 个文件 163 通过，1565 条通过、7 条跳过；唯一失败是 `temp-sessions-seeds.test.ts`，原因是钉住的提交 `cf9e3e01` 里没有该 seed 文件（环境，非本 lane）。
- 本轮中途分两批跑过 storage 的下游插件（746 + 463 个文件），除已知环境失败外通过；browser `index-status-wiring` 暴露的 V01-06 回归已由 c698b9c4 修复，`diagnostics` 的 REAL 种子由 ede2a0cb 修复。
- 门禁：boundaries 0 违规；import-cycles 0 新增 0 过期；rust-fixes 79 条 0 错误；scan `--check` 移动端 0 触达 Node；`--mobile-readiness` ready 2 / gateways 97 / reach 2759（与 INT 相同）；`contracts:check` OK；`tsc -p tsconfig.host.json` 0 错误（48525805 之后）。

### 交接（本轮新增）

| 对象 | 位置 | 内容 |
|---|---|---|
| W14 / 合并代理 | `storage-mobile/tests/storage-entries.test.ts:31` | 与 W14 `c250bf14` 合并必冲突：取 `PENDING_IMPORTERS = {}`；W14 新测试要求 `api.ts` 的 Node 重导出与名单一致，所以同时删掉 `api.ts:27-52,165,174-175` 的 Node 重导出（`file-names.ts` 的纯函数保留） |
| W14 | `storage-mobile/service.ts:400-410`（`dispose`）、`:132-137`（`database`）、`:155`（`openFile`） | 与 V09 P2-1 同类：`dispose` 只清空句柄表，之后 `database`/`openFile` 会重开，可照桌面 `shutDown` 标志处理；`errors.ts` 可加专用 `DISPOSED` 码 |
| W14 | `host/platform/files/index.ts:517`（原子写）、`:610`（`rename`） | rename 接入重试：`retryRename(process.platform, () => rename(a, b))`（`paths/rename-retry.ts`，不依赖 Node，不增加 mobile-readiness reach） |
| W14 | `storage-mobile/migrations.ts:87-88` | mistakes 迁移后没有 pending_memory_candidates 修复（桌面在 `migration/coordinator.ts:270`）；补上时加 `// RUST-FIX(RF-W07-pending-memory-candidates-schema)` 并同提交把该文件加进 RF 的 `fix.files`（我同意改这个 JSON） |
| W08 / W10 / W02 | `backup/src/crypto-restore.ts`、`vfs-repos/repository/blobs.ts`、`agent-skills/src/skill-package.ts` 的 rename | 接入重试：已依赖 `paths/compat.ts` 的用其 `renameWithRetry` / `renameSyncWithRetry`，否则用 `paths/rename-retry.ts` 的 `retryRename(Sync)(process.platform, () => …)`，免得把 compat 拉进移动端闭包 |
| W08 | `sync-providers/src/delta_restore.ts:42`、`delta_gc.ts:30`（导入）、`repo_check.ts:379`（手写魔数比较） | `isEncryptedBackup` 可改从 `platform/secrets/dsbk-stream.ts` 导入（无 Node 依赖） |
| W06 | `electron/shell/errors.ts:57-70` | Windows 表是英文，Rust 按系统语言输出，中文 Windows 上对不上 |
| W04 | `vfs-index/src/chat-embeddings.ts:161-173` | A 独有的 `lance.optimize.last.*`（mistakes.db `settings`）需在第七轮之后的录制上判断；本地只有 09:29 的 smoke |

## 第九轮（本轮，lane 编排派单）

开工合并 INT `2be7ed80`（17264548）。唯一冲突 `storage-mobile/tests/storage-entries.test.ts`（W14 路径）取 INT 版；
INT 版的 `PENDING_IMPORTERS` 仍列着第八轮已迁走的 15 个测试，所以本分支上该棘轮 1 例红，等 INT 前进到 M4 的
`int/stage-1505`（已把名单清空并删掉 `api.ts` 的 Node 重导出）再合一次即消失，不归我修。

| SHA | 内容 |
|---|---|
| 17264548 | 合并 INT `2be7ed80` |
| 74932faa | FM-04：RF-W07-crypto-root-adopts-slot-master-key 的根目录 `.master_key` 副本在 rename 前收紧权限（POSIX 0600；Windows 与新建主密钥同一个 icacls 调用）；`crypto-service.ts` 导出 `restrictMasterKeyFile`（可注入 `execFile`），`data-space-files.ts` 新增 `atomicWriteBytesBeforeRename` |
| 11082472 | H4 第三项：RF-W07-diagnostic-sandbox-no-fsync（proposed）。`profiles.ts` 的 `diagnosticSandboxProfile(dir)` 只对 `slots/slotC|slotD` 给出 plain + MEMORY + OFF；coordinator / MigrationWorker 的 `diagnosticSandbox` 选项；调用点在 W08 `governance.ts:90-96`，补丁 `.reports/W07-handoffs/W08-diagnostic-sandbox-profile.patch` |
| a24a21e9 | 本节初稿 |
| e8a9e5af | V07 P3-2：迁移前磁盘预检（coordinator.rs:5256）改走与备份插件同一份 `get_available_disk_space`（statfs → `df -k` / `wmic` 回退 → 失败按 `u64::MAX`），实现移到叶子文件 `storage/disk-space.ts`，`backup-common.ts` 重导出；日志文案、df/wmic 输出的 u64 解析对齐 backup_common.rs:632-930 |
| 55b2383b | secrets：云凭据纯函数（密码策略、状态与序列化、暂存记录读写）从 `secure-store.ts` 移到 `cloud-credentials.ts`，原导出名照旧重导出，行为不变 |
| 031abde7 | secrets：`.key_seed` 文件函数与安全文件权限（指纹、种子分类、keystore/DPAPI 文案、原子写、限长读取）移到 `seed-file.ts`，`secure-store.ts` 只留 AES、进程级种子锁与 `SecureStoreImpl`，原导出名照旧，行为不变 |
| 80b33706 | `disk-space.ts` 去掉 Node 导入（注入 `DiskSpaceSystem`，Node 侧 statfs / df / wmic 在 `data-space-files.ts` 的 `getAvailableDiskSpace`），e8a9e5af 带来的 mobile-readiness reach 2748 → 2804 回到 2748 |
| 7c6f440a | llm-usage 按 Rust 模块拆成 `llm-usage-models.ts`、`llm-usage-repo.ts`（repo.rs + database.rs）、`llm-usage-collector.ts`；`llm-usage.ts` 只留 mod.rs 的记录入口并重导出，运行时导出 55 个不变 |
| 966018f1 | 合并 INT `1d1fdb78`（D 趟）。唯一冲突同上一次，取 INT 版 `PENDING_IMPORTERS = {}` |
| b665de2f | RF-W07-llm-usage-session-caller-id 的 `fix.files` 改成 `llm-usage-repo.ts`：7c6f440a 把 `getSessionUsage` 与 `RUST-FIX` 标记移过去后没改登记，`rust-fixes.mjs --check` 报 2 个错误 |
| ae1484c7 | 按 W13 `g3-rf-check` 改四条 RF 的 G3 选择器（见下） |

### 方案与结论

- FM-04：副本先写临时文件，`restrictMasterKeyFile(temp)` 后再 rename，根目录主密钥从不以继承 ACL 出现；icacls 非零退出、spawn 失败、缺 USERNAME 都只告警（同 Rust `create_master_key`），收紧函数抛错时删临时文件、不落根密钥。测试用注入的 `platform: 'win32'` + `execFile` 替身经 `DataSpaceStartup` 验证：只调用一次、作用于 rename 前的临时文件、参数与新建 `.master_key` 完全相同。
- H4：本机单文件 `migration-diagnostic.test.ts` ×3，X1 改前 4135 / 3277 / 2531 ms，本地套上 W08 补丁后 2143 / 768 / 816 ms；只设 OFF 为 1914 / 1614 / 1102 ms，所以保留 MEMORY（仍能 ROLLBACK）。W08 补丁未合入前生产不生效。
- AL-07（W10 `5f4df9a8`）与 W14 `readMigrationSql`（`d8656a26`）开工时都未进 INT，跳过；交付前再查。
- 合并 `1d1fdb78` 后：`storage-entries.test.ts` 的棘轮绿（7/7）。`git show --remerge-diff 966018f1` 只有该文件一处冲突，解法是删掉本分支旧名单、取 INT 的空名单，合理。M4 删掉了 `api.ts` 的 13 个 Node 值重导出（只留 `export type`），我路径内的代码与测试都已从 `node.ts` 取这些值（第八轮 f93cdc98），棘轮测试按导入说明符逐文件核对，0 个文件还从 `api.ts` 取 Node 值。
- RF 选择器（W13 查出）：
  - RF-W07-llm-usage-session-caller-id：scenario `llm_usage.*` 没有场景，改成 `storage.llm_usage.*`（3 个场景 9 步）。**没有加 jsonPath**：A 报 `no such column: caller_id`，B 返回汇总，差异记录是 `outcome-kind`；`g3-rust-fixes.mjs` 的 `placeCovered` 对 `outcome-kind` 只认不带 jsonPath 的 ipc 选择器（`place.path` 为 null），加了 jsonPath 这条就永远不会豁免。理由写在登记的 `notes`。
  - RF-W07-crypto-root-adopts-slot-master-key、RF-W07-legacy-root-security-entries-copy：fs 选择器 `.master_key`、`.secure` 永远不会命中（G3 只采 SQLite，fs 面只覆盖一侧独有的数据库文件），删除，`affects` 改 false，`notes` 写明 G3 覆盖不到。核对过：G3 种子里没有 `.master_key`、`.secure`，场景的数据目录都是新建的槽位布局，两条修复在 G3 里不产生差异。
  - RF-W07-pending-memory-candidates-schema：删掉 db 选择器（A 不建这张表，差异是 `table` 行，db 选择器只覆盖 value / storageClass 行）。三个 ipc 选择器仍不带 jsonPath（同样是 `outcome-kind`），scenario 从 `*` 收窄到实际调用它们的 `g3w.anki.*`（g3w-anki-02.json）与 `anki.memory.*`（memory-candidates.seeded.json），共 5 个选择器，今天的覆盖面不变。
  - 验证：`rust-fixes.mjs --check` 95 条 0 错误。W13 `638c8ea8` 临时工作树里拷入四个 JSON 跑 `g3-rf-check.mjs --strict`：W07 条目 0 个问题（改前 1 no-scenario、1 no-table、3 fs-path），只剩 `whole-outcome` 提示（理由如上）；`--strict` 仍退出 1，全部来自 RF-S01-shell-environment-failure 的两个 `*local_shell*` no-scenario，不是我的登记。临时工作树已删除。
- H4 补丁：`.reports/W07-handoffs/W08-diagnostic-sandbox-profile.patch` 在 INT `1d1fdb78` 的临时工作树里 `git apply --check` 通过，不用重新生成。INT 里还没有 `diagnosticSandbox` 选项（随 11082472 进 INT），W08 应在 W07 本分支落地后再应用，否则选项被忽略、生产不生效。
- AL-07 / AL-15 与 `readMigrationSql`：交付前再查，INT `1d1fdb78` 里仍没有 W10 `5f4df9a8`（`b6693579` 是其后的一个测试提交）与 W14+W35 `8cb83906`（`readMigrationSql` 首次导出在 `8ad4d1f8`），按派单不合别 lane 的分支，跳过，补丁片段见交接。
- mobile-readiness：ready 3 / gateways 76 / reach 2298，与 INT `1d1fdb78` 完全相同（临时工作树对照）。

### 验证（ae1484c7 上）

- `bin/heavy npx vitest run -c vitest.host.config.ts host/platform/storage host/platform/secrets host/platform/paths host/platform/storage-mobile/tests host/plugins/backup/tests/migration-diagnostic.test.ts --maxWorkers=2`：103 个文件全部通过，1040 条通过、6 条跳过（214 s）。
- 门禁：boundaries 0 违规（294 条 boundary-allow）；import-cycles 0 新增 0 过期；rust-fixes 95 条 0 错误；scan `--check` 移动端 profile 0 触达 Node；`--mobile-readiness` ready 3 / gateways 76 / reach 2298（与 INT 相同）；`tsc -p tsconfig.host.json` 0 错误（`version:generate` 后跑，跑完删除 `src/version.ts`）。

### 交接（第九轮）

| 对象 | 位置 | 内容 | 验证 |
|---|---|---|---|
| W07 下一轮 / 合并代理 | `storage/service.ts:234-236` | AL-07 / AL-15：W10 `5f4df9a8` 进 INT 后把 disposer 返回出去，见下方片段 1 | `storage/tests/startup-finalizers.test.ts`、W10 的 `startup-finalizers-lifecycle.test.ts` |
| W14（api.ts 归属） | `storage/api.ts:526`、`storage-mobile/service.ts:351` | 同一改动的接口与移动端：声明返回 `() => void` 并接受 `late` / `signal`，否则插件拿不到 disposer（片段 1） | 同上 + `storage-mobile/tests` |
| W07 下一轮 / W14 | `storage/migration/definitions.ts:5,64-66`、`storage/migration/repairs.ts:19,25,39-41` | W14+W35 `8cb83906` 进 INT 后改用 `readMigrationSql`，见片段 2；`refinery.ts` 只导入 `refinery-core.ts`，不会成环 | `storage/tests/refinery-sql-cache.test.ts`、`migration-worker.test.ts`、`startup-migration-report.test.ts`、`pending-memory-candidates-schema.test.ts` |
| W08 | `backup/src/governance.ts:90-96` | 应用 `.reports/W07-handoffs/W08-diagnostic-sandbox-profile.patch`（INT `1d1fdb78` 上 `git apply --check` 通过）；须在 11082472 进 INT 之后 | `backup/tests/migration-diagnostic.test.ts`（本机套补丁后 X1 2143 / 768 / 816 ms） |
| S01 | `host/e2e/differential/rust-fixes/RF-S01-shell-environment-failure.json` | 两个 `*local_shell*` 选择器没有场景（g3-rf-check no-scenario），W13 脚本 `--strict` 因此退出 1 | `g3-rf-check.mjs --strict` |

片段 1（`5f4df9a8` 已在 `startup-finalizers.ts` 导出 `StartupFinalizerRegistration` 并让 `register()` 返回 disposer）：

```ts
// storage/service.ts
import { StartupFinalizerRegistry, type StartupFinalizerRegistration } from './startup-finalizers.ts';

  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerRegistration): () => void {
    return this.finalizers.register(name, fn, options);
  }

// storage/api.ts:526（W14）：类型放在 api.ts，startup-finalizers.ts 改为从 api.ts 取，避免 api.ts 反向 import
export type StartupFinalizerLatePolicy = 'throw' | 'skip' | 'run';
export interface StartupFinalizerRegistration extends StartupFinalizerOptions {
  readonly late?: StartupFinalizerLatePolicy;
  readonly signal?: AbortSignal;
}
  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerRegistration): () => void;
```

`service.ts:556` 的门面是 `this.impl.registerFinalizer.bind(this.impl)`，返回值自动透传，不用改。

片段 2：

```ts
// storage/migration/definitions.ts：删掉 `import fs from 'node:fs'`（path 仍用）
import { readMigrationSql } from './refinery.ts';

export function loadMigrationSql(migrationsDir: string, file: string): string {
  return readMigrationSql(path.join(migrationsDir, file));
}

// storage/migration/repairs.ts：删掉 `import fs from 'node:fs'`
import { chronoRfc3339Now, readMigrationSql, type Runner } from './refinery.ts';

function readSql(migrationsDir: string, file: string): string {
  return readMigrationSql(path.join(migrationsDir, file));
}
```

## 第十轮（本轮，lane 编排派单）

开工时 tip `72f00951`（第九轮，L07 复核中，不改写），INT 仍是 `1d1fdb78`。先做不依赖 E 趟的第 3、4、6、7 项，
E 趟进 INT 后合并再做第 1、2 项。

| SHA | 内容 |
|---|---|
| 8f74fdd5 | 本节初稿（任务 3、6、7） |
| f69ba724 | 合并 INT `065a68f3`（E 趟，含 W10 `b6693579`、W14+W35 `162c693f`、W02 `be279661`、W01 `6e4d9c7f`），无冲突 |
| c4958902 | AL-07 / AL-15：`registerFinalizer` 返回 registry 的 disposer，接受 `late` / `signal`；`late: 'run'` 异步失败写 `dstu_storage::lifecycle` error 日志 |
| be586c11 | `migration/definitions.ts`、`migration/repairs.ts` 改用 refinery 的 `readMigrationSql` |
| f1ce71ef | `API.md` §9.4 调用点表更新成现状 |

### 任务 1：AL-07 / AL-15

- `service.ts`：`registerFinalizer(name, fn, options?: StartupFinalizerRegistration): () => void`，直接返回
  `this.finalizers.register(...)`。门面 `:557` 是 `bind`，返回值原样透传给 `ctx.storage`。
- 构造 registry 时传 `onLateError`（W10 接口文档里的可选项）。否则 `late: 'run'` 立即执行的钩子一旦 reject，
  就成了未处理拒绝，生产上只写到 Host 的 stderr（`host/kernel/main.ts:70`），进不了主日志。现在写
  `storageLog('dstu_storage::lifecycle', 'error', '启动收尾钩子 <name> 晚注册执行失败: <cause>')`。
  Rust 没有晚注册这一说，它启动期的后台任务失败也是记日志、不崩。
- `api.ts:541` 仍声明返回 `void`，`StartupFinalizerOptions` 也还没有 `late` / `signal`（W14 的类型补丁不在 INT）。
  实现返回函数、参数类型更宽，在现有声明下 `tsc -p tsconfig.host.json` 0 错误。W14 补上类型之后，插件才能直接拿到
  disposer 并在对象字面量里写 `late`。在那之前，W10 的写法（`signal` + 先声明成 `StartupFinalizerRegistration`
  类型的变量）照样可用。
- 测试（`storage/tests/startup-finalizers.test.ts` 新增 3 例）：disposer 与 `late` / `signal` 透传；晚注册 reject 进日志；
  经 `ctx.storage` 门面拿到 disposer。变异检查：把实现改回丢弃返回值并去掉 `onLateError`，3 例全红，
  vitest 另报 1 个 Unhandled Rejection；改回后全绿。W10 的 `startup-finalizers-lifecycle.test.ts` 14 例在本分支通过。

### 任务 2：`readMigrationSql` 接入

- `definitions.ts` 的 `loadMigrationSql`、`repairs.ts` 的 `readSql` 都改成 `readMigrationSql(path.join(dir, file))`，
  两个文件不再导入 `node:fs`。`refinery.ts` 只导入 `refinery-core.ts`，`refinery-core.ts` 只导入 `errors.ts`、
  `api.ts`（类型）、`time.ts` 和 `time/index.ts`，不成环：`import-cycles --check` 0 新增、0 过期。
- mobile-readiness：ready 3、gateways 74，与 INT `065a68f3` 相同。reach 2234，比 INT 多 1，是重复计数：
  backup 插件（`platforms=desktop`）经 `governance.ts:11` 的 `definitions/index.ts` 网关多列了一次 `refinery.ts`，
  而它早已经由 `audit-log.ts` 网关进了同一插件的闭包，插件实际触达的 Node 文件集合没变。
- `storage-mobile/DESIGN.md:133` 还写着“`definitions.ts:64` 用 `fs.readFileSync`”，已过时（W14 / W31 的文档）。

### 任务 4：服务器分诊

- C 趟（`TRIAGE.md` v1）与 D 趟（`.reports/server/land-test-D/`，host 16402 例失败 10、fe 13204 例失败 15）都没有落在
  我路径里的红。D 的 host 红：`mcp-service:440`（W21）、`llm-routes-b`（W05，E 趟已修）、`g3-lifecycle`（W13）、
  `migration-diagnostic` ×2、`vfs/tests/portable-entry`（W04 / W10）、`boot-diagnostics-host`（W06）、
  `node-modules-closure` ×3（W06，E 趟已修）。fe 全在 `src/`、`tests/vitest/`。
- `migration-diagnostic`（H4，W08 的测试）：D 趟（服务器 `878fb226` = INT `1d1fdb78`，host 和 fe 首次同时跑）
  X1 12280 ms，“preserves full current-database report”一例 30 s 超时。整文件 89 s，另外三例通过。
  C 趟是 5224 ms，B 趟 8196 ms。D 的 SHA 里没有 E 趟的两项缓存，也没有 11082472。
- 本机记录（合 E 后的本分支 `f1ce71ef`，负载 19–21，单文件跑 3 次，取 vitest 用例耗时）：
  - 只有 E 趟缓存：X1 1996 / 2269 / 2083 ms，整文件 6.4 / 7.3 / 6.2 s。
  - 再套上 W08 补丁（`diagnosticSandbox`）：X1 2147 / 1803 / 2018 ms；`RF-W08-diagnostic-slots-concurrent` 那一例
    975–1426 → 785–941 ms；整文件 5.9 / 6.0 / 6.0 s。
  - 单跑远低于 5000 ms，按派单口径算负载。W08 补丁在合 E 后的树上 `git apply --check` 仍通过。
    W08 的 `governance.ts` 还没有传 `diagnosticSandbox`，所以 11082472 在生产路径上还没生效。

### 任务 3：`getWritableAppDataDir` 去留——删（本轮不删）

- Rust：`apkg_import.rs:88-91,308-311` 的 `anki_media` 用 `file_manager.get_writable_app_data_dir()`（`dstu-storage/src/file_manager.rs:169`
  回退链）。但 `anki_media` 是持久数据：卡片 `images` 存的是落盘路径，活动槽不可写时 Rust 把媒体写进
  `data_dir()/DeepStudent` 或 temp，槽位恢复后 `read_anki_media` 又回到活动槽，图片就读不到了。已批准的
  RF-W07-persistent-app-data-no-silent-relocation 的 `rust.behavior` 和 `evidence` 点名了 `apkg_import.rs:90/310`，
  `fix.behavior` 写的是“持久数据调用方迁到 getPersistentAppDataDir 后生效”。所以 anki 应走持久目录，不是保留可写目录的理由。
- 唯一调用方 `host/plugins/anki/src/plugin-handlers-media.ts:37` 归 W10。W10 已在 `f87d01e2`（15:15）改为
  `getPersistentAppDataDir()`，并加了测试 `media.test.ts`“the media root is the persistent app data dir…”。
  这个提交在 E 趟的 W10 `b6693579` 里（`git merge-base --is-ancestor` 已核对），INT `1d1fdb78` 还没有。
  给 anki 归属 lane 的交接已经由 W10 自己完成，不用再发。
- 合 E 趟 INT `065a68f3` 后核对：`plugin-handlers-media.ts:38` 已是 `getPersistentAppDataDir()`；W05 已删掉
  `llm/api.ts` 的 `LlmFileManagerPaths.getWritableAppDataDir`；`getWritableAppDataDir` 在生产代码里没有调用方。
  它和 `getTempAppDataDir` 行为完全相同（`file-manager.ts:285` 直接委托），删掉不丢任何 Rust 行为。
  本轮只把 `API.md` §9.4 的调用点表更新成现状。删除步骤（下一轮，W07 与 W14 同趟）：
  - W07：`file-manager.ts:281-287`、`index.ts:38,195`、`API.md` §9.4 那一条；`tests/f3-owner-services.test.ts:192`
    改测 `getTempAppDataDir`；`tests/persistent-app-data-dir.test.ts:51` 的标题与 RF 登记 `tests[2].name` 同步改。
  - W14：`storage/api.ts:680-684` 删掉接口成员。
  - W08（`host/platform/settings/tests/backup-commands.test.ts:165`）：对象字面量标注为 `FileManagerPathsService`，
    接口删成员后这一行会触发多余属性检查，同趟删掉。

### 任务 6：交接收集（15:30 之后）

| 来源 | 内容 | 处理 |
|---|---|---|
| AL-15（15:46）/ AL-07 | `service.ts` 把 disposer 返回出去 | 任务 1，E 趟进 INT 后做 |
| AL-17（16:29） | 没有给 W07 的条目；W14 的 mobile registry 委托与 W10 `5439f6f2` 修复相关 | 不涉及 |
| LA-14（16:13）、W14-1606 报告“W07：无需改动” | rename 统一用 W07 的 `paths/rename-retry.ts`；W07 路径内用 `paths/compat.ts` | 已是现状；调用点登记方式等 LR-07 |
| W14-1606、LR-07 第三点 | `storage-mobile/migrations.ts:128` 要不要加 `RUST-FIX(RF-W07-pending-memory-candidates-schema)` | 等主编排裁定；加的话由 W14 同提交把该文件加进 RF 的 `fix.files`（第八轮已同意） |
| W10-1625 `c31979c5`、W02-1627 `b6e48d5a` | 各自的 rename 接入 W07 重试 | 知会，不用改 |
| W05 复核 `W05-7417751f.md:156` | `getWritableAppDataDir` 只剩 anki 调用方 | 任务 3 |
| W35-1544 | `readMigrationSql` 接入可照常进行 | 任务 2 |
| W13-1546 | 四条 RF 选择器 | 第九轮 `ae1484c7` 已处理 |
| M4-1537 | 冲突解法、`api.ts` 仅类型转出 | 第九轮已核对 |

W31 的共用模块建议（`W31-1527-9c146fb4.md:159`，只有一句建议，没有具体方案）。评估结论：**可行，建议做，本轮不实施**。
- 两边的 `Scope`（含 savepoint 命名、回滚、回调并入）、`runAsyncCallbacks`、`AsyncTx`（状态机、abort、`TX_CLOSED`）逐行同构，
  只有三处差异：桌面 `Scope` 收连接的 thunk（`database.ts:379` 的同步事务传 `() => conn`），移动端直接收连接；
  `runSyncCallbacks` 的告警桌面写 `storageLog('dstu_storage::database', 'warn', …)`，移动端走注入的 `warn`；
  连接类型分别是 `Connection` 与 `MobileConnection`。
- 做法：在 `host/platform/storage/` 新建不依赖 Node 的叶子 `tx-scope.ts`，只导入 `errors.ts`、`writer-slot.ts` 和 `api.ts` 的类型。
  用结构接口 `ScopeConnection` 描述两边连接的公共部分（`get/all/pluck/iterate/run/exec/inTransaction/commit/rollback/label`），
  `Scope` 统一收 thunk（移动端传 `() => conn`），`runSyncCallbacks(callbacks, warn)` 收告警函数（桌面传
  `(m) => storageLog('dstu_storage::database', 'warn', m)`，文案不变）。W07 先建模块并改桌面，W31 下一轮改移动端，
  同时把 `tx-scope.ts` 加进 `storage-mobile/tests/shared-modules.test.ts` 的 `SHARED`（已有 `params.ts`、`writer-slot.ts`
  的先例，会校验可移植）。
- 回归保护：W31 的 `storage-transactions.differential.test.ts`（`77f85984`，还没进 INT）加桌面 `storage/tests/` 的事务测试。
  `database.ts` 不能直接共用：它导入 `connection.ts`（better-sqlite3），会把 Node 带进移动端闭包。

### 任务 7：审计台账

- `.reports/audit/HIGH-LEDGER.md` 没有 W07 行。
- `.reports/reviews/` 里点名 W07 的条目都已关闭，或者归别的 lane：
  - V01-06：第八轮 `c7f0c133` / `c698b9c4`。
  - V04（`recoverAssetDeletions` 启动调用）：W29 `58ea9f0a`。
  - V06-L5，以及 V06-L6 的 rowid：第八轮 `0bbcb15a`；BLOB 读出类型在 `storage-mobile`，归 W14。
  - V07 P3-2：第九轮 `e8a9e5af`。V07 的 P2-1 / P3-1 / P3-3 归 W14 / W20，P2-2 归 W10。
  - V09 P2-1：第八轮 `027ea23c`。
  - V10 rename：第八轮 `fd705cf9` / `433dac40`。
- 审计复核里点名 W07 的只有 `audit/reviews/W10-b6693579.md:220`（即任务 1）和 `W29-5e5cecd2.md:104`（知会）。

### 任务 5：LR-07

截至 16:54（`FROM-MAIN.md` 最后修改于 16:52），全文没有出现 LR-07。按派单不动 RF-W07-windows-rename-retry 的 `fix.files`。

### 验证（`be586c11` 上，之后只改文档）

- `bin/heavy npx vitest run -c vitest.host.config.ts host/platform/storage host/platform/secrets host/platform/paths host/platform/storage-mobile/tests host/plugins/backup/tests/migration-diagnostic.test.ts host/plugins/anki/tests/media.test.ts --maxWorkers=2`：
  108 个文件全部通过，1091 条通过、6 条跳过（147 s）。
- 门禁：boundaries 0 违规（305 条 boundary-allow）；import-cycles 0 新增 0 过期；rust-fixes 108 条 0 错误；
  scan `--check` 基线 0 新增 0 消除，移动端 profile 0 触达 Node；`--mobile-readiness` ready 3 / gateways 74 / reach 2234
  （INT `065a68f3` 为 3 / 74 / 2233，差异见任务 2）；`tsc -p tsconfig.host.json` 0 错误（`version:generate` 后跑，跑完删除 `src/version.ts`）。

### 交接（第十轮）

| 对象 | 位置 | 内容 | 验证 |
|---|---|---|---|
| W10（`vfs/**`） | `host/plugins/vfs/api.ts:17`、`vfs/portable.ts`、`vfs/tests/portable-entry.test.ts:28` | D 趟新红（确定性，FM-16）：M4 删掉 `storage/api.ts` 的 Node 值重导出后，`vfs/repository/database.ts` 的闭包已不含 Node，棘轮要求把 `readSchemaVersion` 挪进 `portable.ts`。补丁见下方片段 3；`checkModulesClosure([portable.ts, repository/database.ts])` 本机为 `[]` | `vfs/tests/portable-entry.test.ts`、`import-cycles --check`、`scan.mjs --mobile-readiness` |
| W14 | `storage/api.ts:541`、`:566-568`；`storage-mobile/service.ts:351` | AL-07 / AL-15 的接口与移动端：`StartupFinalizerOptions` 加 `late` / `signal`，`registerFinalizer` 声明返回 `() => void`；移动端委托 `StartupFinalizerRegistry`（W10 接口文档的写法）。桌面实现已在 c4958902 返回 disposer | `storage/tests/startup-finalizers.test.ts`、`startup-finalizers-lifecycle.test.ts`、`storage-mobile/tests`、`tsc -p tsconfig.host.json` |
| W14 / W31 | `storage-mobile/DESIGN.md:133` | “`definitions.ts:64` 用 `fs.readFileSync`”已过时，现在经 `readMigrationSql` | — |
| W08 | `backup/src/governance.ts:90-96` | 应用 `.reports/W07-handoffs/W08-diagnostic-sandbox-profile.patch`（合 E 后的树上 `git apply --check` 通过）；须等 11082472 进 INT | `backup/tests/migration-diagnostic.test.ts` |
| W07 下一轮 + W14 + W08 | 见任务 3 | 删除 `getWritableAppDataDir`（同趟） | `f3-owner-services`、`persistent-app-data-dir`、`settings/tests/backup-commands.test.ts`、`tsc` |
| W31 | `storage-mobile/database.ts:40-200` | 共用 `storage/tx-scope.ts` 的方案见任务 6；W07 先建模块并改桌面，之后 W31 改移动端 | `storage-transactions.differential.test.ts`、`storage-mobile/tests/shared-modules.test.ts` |

片段 3（W10）：

```ts
// host/plugins/vfs/api.ts：删除第 17 行
-export { readSchemaVersion } from './repository/database.ts';
// host/plugins/vfs/portable.ts：在 VfsError 一行（:25）附近加
+export { readSchemaVersion } from './repository/database.ts';
// host/plugins/vfs/tests/portable-entry.test.ts：DESKTOP_ONLY 删除第 28 行
-  'host/plugins/vfs/repository/database.ts': ['readSchemaVersion'],
```
