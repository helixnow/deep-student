# W32 同步安全：进度

分支 `assault/W32-sync-security`，开工基线 INT `390f244b`（合并 Already up to date）。

## 交接收集（`rg 'sync/|W32|S01r2|H1'` 落在 host/plugins/sync/** 的条目）

| 来源 | 条目 | 处理 |
| --- | --- | --- |
| HIGH-LEDGER S01r2-H1 / S01-security-r2 H1 | blob 清单 relative_path 越界写 | 本轮第 1 项 |
| S01-security-r2 M2 | 资产 key 顶层目录无白名单 | 本轮第 2 项 |
| S01-security-r3 开头、M1、"H1 补充" | M1 让 H1 只需写一个 JSON | 随第 1 项修复，攻击路径由测试覆盖 |
| V09-dispose-leaks P1-1 | run_sync 不响应命令 signal | 本轮第 3 项 |
| V05-error-texts:188/192/196 | 错误文本、ID 别名循环、单行 catch 抽查 | 非安全项，不在本轮范围，未改 |
| V06-mobile-runtime:143 | sync-pass 在移动端的 openFile | 只影响将来移动端移植，不在本轮范围 |
| V10-cross-platform:348、V01:245 | 描述性条目 | 无需处理 |

## 1. S01r2-H1 blob relative_path 越界写（RF-W32-blob-relative-path-traversal）

- 红：`tests/blob-relative-path.test.ts` 修复前 6 失败 / 1 通过（正向对照）：
  - 越界 `../../plugins/user.profile.json`：`expected true to be false`（profile 被写到 `<base>/plugins/`）
  - 绝对路径、盘符、反斜杠、符号链接桶、布局不符：`expected [] to deeply equal [hash]`（全部被下载）
- 修：`src/file-manifest.ts` 新增 `blobRelativePathProblem`（hash 64 位小写十六进制；路径恰好 `<hash[0..2]>/<hash>[.ext]`；拒绝 `/` 开头、`\`、`:`、控制字符）；`src/blob-sync.ts` 下载前 `downloadTarget` 再做包含性检查与逐级 lstat，不合法计入 download_failures、不建目录。
- 扩展名规则（第二轮更正）：扩展名不含点、其余字符不限。放宽的理由是 `dstu/handlers.rs:1347` 对没有显式映射的 MIME 用整个子类型作扩展名，会写出 `epub+zip`、`x-tar`、`octet-stream`、`markdown; charset=utf-8`，只允许字母数字会误伤它们；`image/svg+xml` 有显式映射写成 `svg`。上一轮报告说放宽是为了兼容 `vnd.ms-excel`，这是错的：它含点，本规则会拒绝它，而且它本来就下载不了（Rust 用 `file_stem` 作 key，`mod.rs:12382`，key 成了 `<hash>.vnd`，下载校验和必然不符）。另一个边角：POSIX 上扩展名含 `:` 或控制字符的 blob（`attachment_repo.rs:2684-2686` 不过滤字符）原本能在 POSIX 设备间同步，现在被拒绝并计入下载失败，已写进 RF evidence 并有用例固定。
- 绿：该文件 7/7，`blob-sync`、`unsynced-items`、`unsynced-classification` 原测试全绿；`rust-fixes --check` 0 错误。

## 2. S01r2-M2 资产顶层目录白名单（RF-W32-asset-top-allowlist）

- 红：`tests/asset-top-allowlist.test.ts` 修复前 4/4 失败：
  - 映射：`active/databases/vfs.db: expected '/var/folders/…' to be null`
  - 下载：数据库内容被伪造字节覆盖（Buffer 不等）
  - 墓碑：`ENOENT … databases/vfs.db`（未来 deleted_at 绕过“本地较新”后被删）
  - 诊断：`active/databases/vfs.db` 等被报为 downloadPending
- 修：`asset-filenames.ts` 新增 `SYNCED_ASSET_DIRS` / `isSyncedAssetKey`（与扫描同源）；`asset-paths.ts` 的扫描与 `assetLocalPath`、`asset-sync.ts` 下载映射、`file-tombstone-sync.ts` 墓碑应用、`unsynced-classification.ts` 诊断四处使用。白名单外：下载/墓碑记 warn 跳过（不计失败、清单条目原样保留），诊断报 invalidKey。结构校验 `validateRootAndTop` 不变（放进去会让整趟资产同步报错，见 RF evidence）。
- 绿：该文件 4/4，`asset-sync`、`file-deletions`、`file-level-sync`、`unsynced-*`、`asset-filenames` 原测试全绿；`rust-fixes`、`import-cycles` 门禁 0 错误/0 新增。G3 语料 `unsynced.seeded_classification` 的资产 key 全在白名单内或本就非法，不受影响。

## 3. V09 P1-1 run_sync 接命令 signal

- 语义（kernel/API.md §2.5）：Tauri 命令在页面重载/关窗时继续跑，所以 abandon（`'reloaded'`/`'window-closed'`）不取消；只有内核停止命令（`CommandStoppedError`）或插件副作用撤销才取消。用户取消通道 `data_governance_cancel_sync` 不变：仍只作用于带进度同步，普通同步仍返回 false（commands_sync.rs:1586 不装 token）。
- 红：`tests/run-sync-command-signal.test.ts` 修复前两条卸载用例失败 `expected 'still pending' to be 'settled'`（1361ms / 1260ms，卸载在 1 秒内结束不了，内核会一直等），abandon 不取消、用户取消照旧三条守护用例通过。兜底用例（先 abandon 再撤销插件副作用）后加，把兜底 effect 临时改成空操作复现红：两条 `expected 'still pending' to be 'settled'`。
- 修：`src/cancellation.ts` 新增 `runUntilPluginStops`，两个 run 命令用它把调用 signal（仅 `CommandStoppedError`）与插件 `disposed` signal 合成一个运行 signal；`SyncService.runSync/runSyncWithProgress` 加可选第 4 参 `signal`；`run-sync.ts` 把它接到本趟的 controller（普通同步新装一个仅本趟用的 provider cancel token，不进用户取消槽）。
- 绿：该文件 7/7（卸载后同步带“取消”结束、permit 释放一次；A03 实测卸载本身 1.3–3.3 ms，上一轮写的“约 0.6–1.1 秒”是整条用例的耗时），`run-sync`、`plugin`、`shared-permit-ipc`、`tombstone-ipc`、backup `cloud-config`、`governance-tool` 全绿。
- 已知边界：先 abandon 再停插件时调用 signal 已中止，内核 `_close` 的 `CommandStoppedError` 中止是空操作，`_closeOwnedBy` 会一直等到 W01 的 2 秒截止，之后 `fiber.dispose()` 撤销副作用才取消本趟同步（兜底用例覆盖这一段）。交接 W01：给 CallContext 一个独立的停止 signal。

## 4. 同类自查（云端字段 → 本地路径 / 删除）

逐个核过，sync 自有路径内没有其余可复现的越界写/删：

| 远端字段 | 落地位置 | 现有防护 |
| --- | --- | --- |
| 工作区清单 id、工作区 tombstone id | `workspace-sync.ts:89/179` `join(root, id + '.db')`，删除与下载 | `validateWorkspaceId` 只允许 `[a-zA-Z0-9_-]`、≤255 字节，删除循环前整体校验、下载循环逐条校验 |
| 工作区/资产 `object_key` | 只作云端对象 key，不落本地路径 | `validateRemoteObjectKey` / `validateAssetObjectKey`（前缀、`..`、`\`、`//`） |
| 资产 key（含 `app_data/pdf_ocr_sessions/**`） | `asset-sync.ts:124` 下载、`file-tombstone-sync.ts:102-111` 删除 | 本轮白名单 + `assetLocalPath` 的 `ordinary`（拒 `..`/绝对/Windows 反斜杠）与逐级符号链接检查；下载用编码后的规范 key，解码段不会落成 `..` |
| blob tombstone `relative_path` | sync-support `applyBlobTombstones` 删除 | W08 `validateBlobRelativePath`（两段、桶=hash 前两位、stem=hash、桶非符号链接） |
| blob 清单 `relative_path` | `blob-sync.ts` 下载 | 本轮第 1 项 |

交付后跟进（未修，均无可复现的越界写）：

1. **vfs 读 blob 不校验 `relative_path`（W10 路径，读越界嫌疑）**：`blobs` 表是 RowSync（`classification-data/vfs-core.ts:340`），云端记录变更可以改写本地 `blobs.relative_path`；`vfs/repository/resources.ts:1017`、`vfs-repos/repository/blobs.ts:294`、`vfs-index/src/unified-retriever.ts:711` 直接 `join(blobsDir, relative_path)` 读取，`../` 可读 blobs 目录外的文件（`join` 会吃掉绝对路径前导 `/`，`..` 不会）。删除侧 `vfs-repos/repository/blobs.ts:125 safeBlobPath` 已拒 `..`。没有找到把读出内容回传云端的可复现链路，未申请进台账；交接 W10，见下。
2. **未同步诊断对不合规 blob 路径做存在性探测**：`unsynced-classification.ts:109` `existsSync(join(blobsDir, entry.relative_path))` 对第 1 项现在拒绝下载的路径仍会探测并可能报 downloadPending。只读、结果只在本机 UI，不写不删；与 Rust 镜像测试和 G3 语料（`11/wp243-a.pdf` 等非 hash 路径）耦合，改它会动 G3 输出，留待单独对齐（建议对 `blobRelativePathProblem` 非空的条目报 invalidKey）。
3. **先 abandon 再停插件**：见第 3 项“已知边界”，交接 W01。

## 第二轮：A03 复核（`W32-b773349b.md`）的非阻塞建议

基线：在 `b773349b` 之上合 INT `2be7ed80`（合并提交 `8532e87e`），只加新提交，不改已交付提交。

| 建议 | 提交 | 内容 |
| --- | --- | --- |
| C | `b070585b` | 经服务接口发起的同步在 sync 插件卸载时也取消 |
| B | `4ba883f7` | 墓碑用例改用当前时间加 30 秒，走生产的漂移校验和 mtime 判断 |
| E | `d026d2d8` | 桶目录符号链接用例在 win32 上改用 junction；补目标文件本身是悬空链接的用例 |
| A、D | `e85efd2e` | 扩展名放宽理由、Rust 行号、RF evidence 更正；固定扩展名含点、冒号、控制字符时被拒绝 |
| F | 未做 | 上一轮交付报告在 `.reports/agent-final/`，不在 W32 路径内，且交付后不改写 |

### C：服务接口发起的同步随插件卸载取消

- 问题：只有两条 IPC 命令经 `runUntilPluginStops` 合成了插件 `disposed` 信号；backup 的 governance-tool 走 `services.sync.runSync`，内核卸载 sync 插件时不等服务调用，这趟同步会一直挂着，permit 不释放。
- 红：`tests/run-sync-command-signal.test.ts` 新增 `services.sync.runSync|runSyncWithProgress: unloading the sync plugin cancels a sync started through the service, not only through the command`，修复前两条都在 `:108` 失败：`expected 'still pending' to be 'settled'`（卸载已结束，同步仍挂起）。
- 修：`src/cancellation.ts` 新增 `runUntilCallerOrPluginStops`，`index.ts` 的 `service.runSync` / `runSyncWithProgress` 把调用方的第 4 参 `signal` 与插件 `disposed.signal` 合成一个运行 signal（显式加、删监听，不用 `AbortSignal.any`，运行结束后两个源信号上都不留监听）。
- 不变的：命令路径仍经 `runUntilPluginStops`，abandon（`'reloaded'` / `'window-closed'`）不取消；`data_governance_cancel_sync` 仍只取消带进度同步。
- 绿：该文件 11/11（原 7 条不变，另加两条“调用方自己的 signal 仍能取消、结束后调用方信号上无残留监听”）；`run-sync`、`plugin`、`shared-permit-ipc`、backup `governance-tool` 全绿。

### B：墓碑用例走生产路径

- `tests/asset-top-allowlist.test.ts` 的未来墓碑用例：`deleted_at` 改为当前时间加 30 秒；`validateTombstoneTimestamp` 和 `pathModifiedAfter` 改用测试宿主里真实安装的 sync-support 插件的 `tombstones`（生产里 sync 拿到的就是它），不再 mock。
- 变异（验证完已恢复）：
  - `isSyncedAssetKey` 恒返回 true（去掉白名单）：红，`ENOENT … databases/vfs.db`（数据库被删）。
  - 只去掉 `file-tombstone-sync.ts:77` 那一道检查：红，`:113` 的 warn 日志断言 `expected false to be true`（`assetLocalPath` 的检查仍保住了数据库）。
  - 时间改回 `2099-01-01`：红，真实校验抛 `Clock drift suspected`，说明旧写法测的是生产中走不到的路径。

### E：win32 上用 junction

- 桶目录符号链接用例去掉 `skipIf(win32)`，win32 上用 `symlinkSync(target, path, 'junction')`（不需要特权，Node 的 lstat 把 junction 报为符号链接），其他平台仍用 `'dir'`。
- 新增“目标文件本身是悬空符号链接”用例（A03 绕过测试里的场景）。文件符号链接在 Windows 上需要特权、junction 只能链目录，所以这一条仍 `skipIf(win32)`。
- 变异：去掉 `blob-sync.ts` 逐级 lstat 的符号链接判断，两条都红 `expected [] to deeply equal [ Array(1) ]`。
- 本机是 macOS，只验证了非 win32 分支；**Windows 上未实跑**。

### A、D：文字与证据

- `tests/blob-relative-path.test.ts` 正向用例：样例从 Rust 不会写出的 `svg+xml` 换成 `epub+zip`、`x-tar`、`octet-stream`、`markdown; charset=utf-8`、`pdf`、无扩展名，注释写明来源。变异：扩展名限为 `[A-Za-z0-9]{1,16}` 时红（downloaded 2 vs 6）。
- 新增 `extensions containing a dot, a colon or a control character are refused`，固定 RF evidence 里的边角。变异：放宽规则后红。
- `file-tombstone-sync.ts:76` 引用的 `mod.rs:12654`（blob 墓碑函数）改为 `mod.rs:12834`（资产墓碑应用处），已对照 Rust 源码核对。
- RF evidence：blob 一条补上多点扩展名和 POSIX 冒号/控制字符两种边角，`tests` 加两条新用例；资产一条把“未来时间”写准为“晚于本地 mtime、不超过漂移上限 60 秒”。

## 交接

### → W08：`backup/src/governance-tool.ts:601`（INT `2be7ed80`；上一轮写的是 `:589`）把本次取消/超时传进 runSync

`SyncService.runSync` 现在有可选第 4 参 `signal`（`host/plugins/sync/api.ts:112`），满足 `backup/BLOCKERS.md:43` 的请求。第二轮起 sync 插件卸载时服务发起的同步也会自己取消，所以这份交接只剩 governance-tool 自身的取消和超时。补丁：

```ts
// governance-tool.ts SYNC_RUN_TOOL
const stop = new AbortController();
const sync = services.sync.runSync(direction, config, strategy, stop.signal).catch(cause => { /* 原样 */ });
// onCancel 里先 stop.abort() 再 reject(SYNC_CANCELLED)
// 超时回调里先 stop.abort() 再 reject(syncTimeoutError())
```

验证：`backup/tests/governance-tool.test.ts` 加一例，cancellation_token abort 后 runSync mock 收到的第 4 参 `signal.aborted === true`，返回仍是 SYNC_CANCELLED；超时用例同理（假定时器）。真实链路可参考 `sync/tests/run-sync-command-signal.test.ts` 的挂起云端夹具，断言取消后 permit 释放一次。

### → W01：`kernel/commands.ts:312-318` 停止信号与 abandon 共用一个 controller

`_close` 用 `call.controller.abort(new CommandStoppedError(...))` 通知停止，但 abandon（`commands.ts:423`）已先中止同一个 controller 时这一步是空操作，处理函数无从得知插件正在停止，`_closeOwnedBy` 会一直等到截止。补丁思路：

```ts
// InFlight 增加 stop: AbortController；CallContext 增加 readonly stopping: AbortSignal
call.stop.abort(new CommandStoppedError(`command "${registration.name}" is being unregistered`));
call.controller.abort(new CommandStoppedError(`command "${registration.name}" is being unregistered`));
```

验证：`kernel/commands.test.ts` 加“abandon 后 unload，`call.stopping.aborted` 为真、reason 为 CommandStoppedError，且 unload 在处理函数响应后立即结束”。落地后 sync 的 `runUntilPluginStops` 改听 `stopping`，`run-sync-command-signal.test.ts` 的兜底用例可改为走 `host.unload` 并断言 1 秒内结束。

### → W10：vfs 读 blob 前校验 `relative_path`

`vfs/repository/resources.ts:1017`、`vfs-repos/repository/blobs.ts:294`（`getBlobPath`）、`vfs-index/src/unified-retriever.ts:711` 改用与 `vfs-repos/repository/blobs.ts:125 safeBlobPath` 同样的检查（建议导出复用，并补 `isAbsolute`/符号链接父目录检查）：

```ts
const data = readFileSync(safeBlobPath(blobsDir, blob.relative_path));
```

验证：在 vfs.db 插一行 `blobs(hash=H, relative_path='../outside.txt')`、blobs 目录外放 `outside.txt`，读取引用 H 的资源应报错/返回空，而不是返回该文件的 base64。
