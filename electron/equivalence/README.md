# WP-238 F2-shell 命令语料 v1（WAVE0 §3 v0）

这里的语料**没有跑过 A/B，不计 C 级**。`normalize` 一律为 `[]`；`expect:"error"` 只是注释，
判据以真实 Rust（A 端）的运行结果为准，文件里没有写任何预期值。TESTMAP/SPEC 没有改动。

文件：`shell-file-ops.json`（9 个场景）、`shell-platform.json`（8 个）、`shell-settings-backup.json`（4 个），
共 21 个场景、182 步，覆盖清单中的 20 条命令，另外补了 `get_app_data_dir` / `read_file_text` / `save_text_to_file` 三条的错误场景。
seed 全部为 `empty`。场景中有写入的一律 `capture.events=true, db=["*"]`；纯读场景为 `events=true, db=[]`。

## 运行器前提（交 X7）

- 写文件类场景用 `${0}/w0-f2/...`：第 0 步 `get_app_data_dir` 返回裸字符串，后面拼接后缀。
  B 端驱动已经支持这种写法（X1 WP-111，见其报告中 `${0}/w0-source-fidelity.pdf` 一例）；
  main 上的 `scripts/electron-migration/record/scenario-v0.mjs` `resolveReferences` 目前仍报
  `reference must occupy the whole value`。WP-054/WP-G3-L18 的 media 语料也是这种写法，已由 L18 报给 X7。
  所有场景只写当前场景自己的数据目录，不写固定的 `/tmp` 路径。
- 用到的系统固定路径都只读：`/usr/bin/true`（读取非 UTF-8 内容、读取目录外文件的大小、复制）、`/etc/passwd`（只做 pdfstream 白名单判断，不读内容）、
  `/etc/.w0-hidden/x`（不存在，只用来触发隐藏路径判断）。
- A 端 harness 不要设置 `SENTRY_DSN`；`set_backend_sentry_enabled(true)` 的返回值取决于构建/环境里有没有 DSN（见下表）。

## 逐命令覆盖表

Rust 路径相对 `src-tauri/`，行号指向 `fn` 所在行。"成功"/"错误"两列写的是场景 id（省略 `shell.` 前缀）及其覆盖的分支。

| 命令 | 前端调用点 | Rust | 成功场景 | 错误 / 提前返回场景 | 理由 / 不可达分支 |
|---|---|---|---|---|---|
| `copy_file` | src/utils/chatApi.ts:86（同时传 camelCase 和 snake_case 两套键，照原样保留） | src/commands.rs:4265 → crates/dstu-storage/src/unified_file_manager.rs:252 | `file.write_read_copy.roundtrip`：复制时自动建 `dst/deep`；长文件被短文件覆盖后截断（truncate）；`file.copy.errors` 中复制 `/usr/bin/true`（复制没有隐藏路径检查）、自我复制（先截断，结果为 0 字节，保留原行为） | `file.copy.errors`：源路径为空 / 目标路径为空 →`路径不能为空`(:76)；源不存在→`读取文件失败`(:123)；目标是目录→`写入文件失败`(:162)；父路径是文件→ENOTDIR(:162)；祖父路径是文件→`创建目录失败`(:150)；双重编码 `content%3A…`→:430；`foo://`→`无法解析系统路径`(:113) 或 fs 打开失败(:173)；源是目录→读取时 EISDIR，`digest_copy` 报错(:311)，目标已被截断创建（后一步 `get_file_size` 记录这个副作用） | `源文件路径无效`/`目标路径无效`(:258/:263)：`classify_path` 已拒绝空串，Virtual 不可能为空，不可达。`目标回读失败`/`回读校验失败`(:282/:351) 需要存储层延迟提交（Android DocumentsProvider），在 Linux 本地文件上不可达 |
| `export_unified_backup_data` | src/utils/graphApi.ts:1180 | src/commands.rs:6553 | `backup.export_unified_backup_data.options`：全 false / 全 true / `{}` / 非 bool 当 false / `null` / 数组；`settings.sentry_toggle_and_export`：`settings` 表为空、以及有一行时的 `include_settings` | `{}` 缺 `options`→参数反序列化错误 | 取连接 / prepare / 读行 / `get_api_configs` / `get_model_assignments` 失败需要坏库或坏 keyring，空 seed 下不可达。**owner 需要的 seed**：要让 `api_configurations` 非空，需要 L02-llm-manager 提供带 API 配置的 seed（本包未提供，场景照样提交）。返回值里的 `timestamp` 是 `Utc::now()`，属于候选规范化字段，等 A1/A2 双录后再决定 |
| `get_app_version` | src/utils/systemApi.ts:307 | src/commands.rs:500 | `platform.version_and_updater_probe`（另含一步多余参数 `{unexpected:1}`） | 无 | 返回值是 `String`，没有 Err |
| `get_file_size` | src/components/shared/UnifiedDragDropZone.tsx:459；FileContentView.tsx:502/520 | src/commands.rs:4194 → unified_file_manager.rs:677 | roundtrip / content_boundaries（0 字节、URL 编码路径）；`file.get_size.errors_and_outside_app_dir`：读取应用目录外 `/usr/bin/true` 的大小 | `file.get_size.errors_and_outside_app_dir`：空路径→:76；`/etc/.w0-hidden/x`、24 个 `../` 逃逸到 `/etc/.w0-hidden-escape`→`拒绝读取隐藏路径`(:481)；不存在→`获取文件信息失败`(:683)；双重编码→:430；`foo://`→Virtual 分支 `parse_safe_path`/open 失败(:113/:134) | Virtual 分支读流失败(:696) 需要能打开但读失败的 URI，桌面上不可达 |
| `get_prevent_sleep` | src/features/anki-tasks/AnkiTasksApp.tsx:203 | src/cmd/power.rs:78 | `platform.prevent_sleep.toggle`：开启前、开启中、关闭后各查一次 | 无 | 唯一的 Err 是 mutex 中毒(:81)，只有持锁 panic 才会出现，不可达。子进程状态依赖 `systemd-inhibit`（本机 `/usr/bin/systemd-inhibit` 存在），子进程如果立刻退出则 `try_wait` 返回 false，由 A 端实测决定 |
| `install_apk` | src/hooks/useAppUpdater.ts:597 | src/commands.rs:533 | **无可达成功分支** | `platform.install_apk.desktop_rejects`：真实 apk 路径 / 空路径都返回 `install_apk is only supported on Android`(:556)；缺 `path`→参数错误 | 成功分支只在 `cfg(target_os="android")` 下编译（:535-552），Linux A 端不可达；在 README 登记为平台例外，不能拿错误冒充成功 |
| `open_file_externally` | src/utils/systemFileOpener.ts:38 | src/external_file_opener.rs:177 | **无可达成功分支** | `platform.open_file_externally.mode_and_platform`：`view`/`share`/`"  share  "`(trim)/`""`/`null`/缺省 → 解析通过后报 `only supported on Android`(:243)；`edit`、`Share`（大小写敏感）→`不支持的打开方式`(:72)；`content://` 路径 | 成功与 Android 插件分支（:184-243）只在 Android 编译；平台例外 |
| `open_system_permission_settings` | src/features/settings/systemPermissions.ts:93 | src/system_permissions.rs:130 | **Linux 无成功分支** | `platform.open_system_permission_settings.linux`：`notifications`/`microphone`→Linux 固定报错(system_permissions.rs:122-127)；`camera`、`Notifications`(snake_case 大小写)、缺参→enum 反序列化错误 | macOS/Windows 的打开成功分支(:80-119) 在 Linux 不编译；spawn_blocking join 失败(:134) 不可构造 |
| `pdfstream_check_access` | src/hooks/usePdfLoader.ts:128；TextbookContentView.tsx:257 | src/commands.rs:4213（白名单 crates/dstu-vfs/src/pdf_protocol.rs:259） | `file.pdfstream_check_access.branches`：应用目录内 `.pdf`（`available:true,size`）；`.PDF` 大写扩展名；带 `..`/`.` 的路径经 canonicalize 后通过 | 同一场景（命令总是 `Ok`，以下是 4 个提前返回的 `available:false` 分支）：不存在 / 空串→`文件不存在或不可读`(:4225)；`/etc/passwd`→`路径不在 pdfstream 白名单目录内`(:4235)；目录内 `.txt`→`非 PDF 文件`(:4244)；名为 `folder.pdf` 的目录→`路径不是常规文件`(:4248) | 没有 Err 返回。`metadata` 失败时 `size:null`(:4251) 需要 TOCTOU 删除，不可达 |
| `plugin:clipboard-manager\|read_text` | src/utils/clipboardUtils.ts:63（及 :55 插件封装） | tauri-plugin-clipboard-manager-2.2.3 src/commands.rs:35 → desktop.rs:62 | `platform.clipboard.roundtrip`：写后读、写空串后读、再写再读 | 无确定性场景 | `get_text` 的 ContentNotAvailable 需要剪贴板为空/非文本；剪贴板初始化失败(desktop.rs:68) 需要没有 X/Wayland。并行实例共享同一个 Xvfb 剪贴板时结果有竞态，所以不写；写空串后读取的结果交 A 端实测 |
| `plugin:clipboard-manager\|write_text` | src/utils/clipboardUtils.ts:16（及 :8） | 同上 commands.rs:11 → desktop.rs:31 | 同上（中文 + 换行、空串） | 同上：缺 `text`、`text:7`→参数反序列化错误 | `set_text` 失败 / 初始化失败(desktop.rs:40) 需要没有显示服务，同上不可达 |
| `read_file_bytes` | src/components/shared/UnifiedDragDropZone.tsx:472；FileContentView.tsx:510/528；crepe imageUpload.ts:435 | src/commands.rs:4172 → unified_file_manager.rs:206 | roundtrip；`file.read_bytes.max_bytes_bounds`：`maxBytes` 等于文件大小、`null`、`2^53-1`（被 `min(200MB)` 收紧）；0 字节文件 + `maxBytes:0` | `max_bytes_bounds`：`maxBytes` 4 / 0 < 5 字节→`文件过大: …`(:223)；`-1`→u64 反序列化错误；读目录→EISDIR(:236)。`file.read_bytes.errors`：空路径→:76；隐藏路径、`%2E` 编码的隐藏路径、`..` 逃逸→:481；不存在→:216；双重编码→:430；`foo://`→:113/:134 | 二次截断上限(:239) 只在 Virtual URI（无法预检）或读取期间文件变大时出现，桌面上不可达。spawn_blocking join 失败(commands.rs:4185) 不可构造 |
| `save_webview_settings` | src/utils/systemApi.ts:94（调用方 useWebviewSettingsPersistence.ts:27、DataImportExport.tsx:763） | src/commands.rs:7476 | `settings.save_webview_settings.write_and_read_back`：字符串 map（键序打乱、含 `\n` `"` `\t` `\` 与空值）、`{}`、`null`、嵌套/浮点/null 值；每次写后用 `read_file_text(${n.path})` 读回 pretty JSON 原文 | 同场景：缺 `settings`→参数错误；`settings.save_webview_settings.write_failed`：先用 `save_text_to_file` 把 `webview_settings.json` 建成目录，再写→`写入 WebView 设置文件失败`(:7491) | `to_string_pretty` 序列化失败(:7488) 对 `Value` 不可达。假设 `get_app_data_dir` 与 `get_writable_app_data_dir` 在空 seed 下指向同一目录（file_manager.rs:198-200 primary 可写即返回）；如果不一致，A 端结果会如实暴露 |
| `set_android_immersive_mode` | src/utils/androidImmersiveMode.ts:27 | src/system_bars.rs:44 | `platform.android_immersive.non_android`：true / false →`Ok(())` | 缺 `enabled`→参数错误 | Android 插件未初始化 / 调用失败(:51/:59) 只在 Android 编译 |
| `set_backend_sentry_enabled` | src/features/settings/components/GeneralTab.tsx:787 | src/lib.rs:331 | `settings.sentry_toggle_and_export`：false→true→false→false；每次切换后用 export(`include_settings`) 读回 `settings.sentry_error_reporting_enabled` | 缺 `enabled`、`"true"`(字符串)→参数错误 | `save_setting` 失败(lib.rs:344) 需要坏库，不可达；没有 DSN 时 `true` 返回 `false`（lib.rs:298-302 warn）——返回值取决于构建环境，以 A 端实测为准 |
| `set_prevent_sleep` | src/features/anki-tasks/AnkiTasksApp.tsx:209/351 | src/cmd/power.rs:27 | `platform.prevent_sleep.toggle`：未开启时关闭、开启、重复开启（幂等）、关闭、重复关闭；最后一步保证子进程被关掉 | 缺 `enabled`→参数错误 | spawn 失败(power.rs:50-53) 需要系统里没有 `systemd-inhibit`，本机存在，不可达；mutex 中毒同上 |
| `set_sidebar_vibrancy` | src/utils/sidebarTranslucency.ts:70；TopLevelFallback.tsx:112 | src/cmd/window_effects.rs:172 | `platform.window_effects.non_macos`：true/false→`Ok(false)` | 缺 `enabled`→参数错误 | 主线程调度 / 超时 / vibrancy 失败(:196-202) 只在 macOS 编译 |
| `set_window_appearance` | src/utils/sidebarTranslucency.ts:31 | src/cmd/window_effects.rs:215 | 同上：dark true/false | `dark:"yes"`→参数错误 | NSAppearance/NSWindow 失败(:242-258) 只在 macOS |
| `sync_titlebar_sidebar_material` | src/utils/sidebarTranslucency.ts:45 | src/cmd/window_effects.rs:271 | 同上：`width` 240.5 / 0 / -1 | 缺 `width`→参数错误 | 同上只在 macOS |
| `updater_install_supported` | src/hooks/useAppUpdater.ts:483 | src/commands.rs:516 | `platform.version_and_updater_probe` | 无 | 返回值是 `bool`，没有 Err；值取决于 A/B 进程环境里有没有 `APPIMAGE` 变量，两端需要在同一环境下运行 |

### 补充：已有成功场景的三条命令

| 命令 | 前端 | Rust | 本包新增错误场景 | 无法覆盖的分支 |
|---|---|---|---|---|
| `get_app_data_dir` | src/utils/systemApi.ts:296 | src/commands.rs:563 | 无 | 函数体只有 `Ok(...)`，`to_string_lossy` 不会失败；**没有可达错误分支** |
| `read_file_text` | src/utils/chatApi.ts:73；settingsApi.ts:129 | src/commands.rs:4150 → unified_file_manager.rs:247 | `file.read_text.errors`：空路径→:76；隐藏路径 / `..` 逃逸→:481；不存在、`foo://`→:123/:113/:134；读目录→EISDIR(:195)；`/usr/bin/true` 与 `file:///usr/bin/true`（ELF 头）→`文件编码不是有效的 UTF-8`(:249)；双重编码→:430 | 无 |
| `save_text_to_file` | src/utils/settingsApi.ts:125 | src/commands.rs:4272 → unified_file_manager.rs:375 | `file.save_text.errors`：空路径→:76；目标是目录→:162；父路径是文件→:162(ENOTDIR)；祖父路径是文件→:150；双重编码→:430；`foo://`→:113/:173；缺 `content`→参数错误。最后读回 blocker，确认失败的写没有改动它 | `write_all`/`flush` 失败(:380/:383) 需要磁盘满或 I/O 错误，不可达 |

## 未覆盖与例外

- 成功分支在 Linux 上编译不到：`install_apk`、`open_file_externally`（只有 Android）、`open_system_permission_settings`（只有 macOS/Windows）。
  这三条只有错误场景，**不计为成功覆盖**，按 G3-LEDGER §6 作为平台例外交 C2 登记。
- macOS/Android 专有的错误分支（window_effects、system_bars、apk/external-file 插件）在 Linux A 端不可达，覆盖率例外按同一理由登记。
- 需要别的域提供 seed：`export_unified_backup_data` 的 `api_configurations`/`model_assignments` 非空需要 L02-llm-manager 的 seed。
- 剪贴板错误分支、剪贴板读取结果对共享显示有竞态，见上表；如果 X7 的 8 组实例共用一个 Xvfb，需要给 clipboard 场景单独一个显示，或者串行运行。

## WP-273：5 条命令的“Rust 可达 Err”判定

文件 `g3w-shell-01.json`（1 个场景，seed `empty`，`capture {events:true, db:["*"]}`，`normalize []`）。
Tauri 源码行号指 `~/.cargo/registry/.../tauri-2.11.5/src/`。上表 `pdfstream_check_access`“没有 Err 返回”只指函数体，参数反序列化错误以本节为准。

| 命令 | 判定 | 依据 |
|---|---|---|
| `pdfstream_check_access` | `g3w.shell.pdfstream_check_access.err_missing_path` | 函数体（`src-tauri/src/commands.rs:4213-4257`）只有 `Ok(denied(..))` 和 `Ok(PdfStreamAccess{..})`，白名单解析 `resolve_allowed_dirs`（`crates/dstu-vfs/src/pdf_protocol.rs:259-286`）用 `filter_map(.ok())`/`unwrap_or` 吞错。唯一可达 Err 是 `path: String`（:4215）参数缺失：`command pdfstream_check_access missing required key path`（`ipc/command.rs:96-101`），包成 `invalid args \`path\` for command ...`（`ipc/command.rs:68`、`error.rs:59`）。args `{}` 只省略调用点 `usePdfLoader.ts:127`、`TextbookContentView.tsx:256` 用的 `path` 键；`AppHandle` 提取不会失败 |
| `get_app_data_dir` | 无可达 Err | 函数体 `src-tauri/src/commands.rs:563-569` 只有 `Ok(..)`，`FileManager::get_app_data_dir` 返回 `&Path`（`crates/dstu-storage/src/file_manager.rs:1282-1284`），`to_string_lossy` 不会失败；无参数，没有反序列化错误。唯一 Err 是 `State<AppState>` 未 manage 时 Tauri 的 `state not managed for field \`state\` ...`（`state.rs:62-67`）。`AppState` 只在 `lib.rs:1336` manage；setup 进入恢复启动模式时在此之前 `return Ok(())`（`lib.rs:959`、`:972`、`:986`、`:1043`、`:1053`、`:1062`、`:1317`）。`seed:"empty"` 不进这些模式，所以本包不写；做法同 WP-246，需要 X3 提供能进恢复模式的种子后再加一步 `{"cmd":"get_app_data_dir","args":{},"expect":"error"}` |
| `get_app_version` | 无可达 Err | `src-tauri/src/commands.rs:500-507` 返回 `String`（非 `Result`），无参数、无 State；只有 `format!` 拼编译期 `env!` 常量。命令在 `application-commands.toml:403` 放行，ACL 拒绝不可达 |
| `get_prevent_sleep` | 无可达 Err | 唯一 Err 是 `SLEEP_GUARD.lock()` 中毒（`src-tauri/src/cmd/power.rs:79-81`）。中毒要求持锁线程 panic；两个持锁函数 `set_prevent_sleep`（:27-74）和 `get_prevent_sleep`（:78-98）内部只有 `try_wait`/`kill`/`wait` 的 `Result` 匹配或 `let _ =`，`spawn_inhibitor`（macOS :101-109、Linux :112-128）用 `map_err` 返回错误，没有 `unwrap`/`expect`/索引，前端调用不会让持锁线程 panic。无参数，没有反序列化错误 |
| `updater_install_supported` | 无可达 Err | `src-tauri/src/commands.rs:516-525` 返回 `bool`（非 `Result`），Linux 只读 `APPIMAGE` 环境变量，其他平台固定 `true`；无参数、无 State。`application-commands.toml:930` 放行 |
