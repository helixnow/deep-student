# W6b：Tauri WebView 本地存储 → Electron 迁移设计（WP-045 / WP-137）

状态（W07，2026-11-07）：**main 侧编排与三平台解码已实现并有构造文件测试**（§8）；W06 已接入
`electron/main.ts` 与 preload（§8.2）。macOS/Windows 的真实落盘仍**未实测**（U-001），格式依据见 §8。
下文 §1–§7 为原设计与取证记录，保留原文。
D-004 要求：老 Tauri 用户的 localStorage/IndexedDB 必须迁移或证明无需迁移，不得默认丢失。
WP-137 按 **D-054 已裁定**修正下文。当前阻断是正式启动路径缺少可靠的旧 writer 停止核验，
不是等待方案批准；证据见 `WP-137.md`。不得将 WP-045 的夹具成功当成生产接线完成。

## 1. 结论

| 存储类 | 结论 | 依据 |
|---|---|---|
| localStorage（`tauri://localhost` / Win `http://tauri.localhost`） | **必须迁移**。113 个静态键、8 个键模式、42 处动态键，散布在 111 个生产文件 | §3 盘点；§4 实测 |
| sessionStorage | **无需迁移**：两端都不跨进程持久化。WebKitGTK 实测重启后读回为 `null` | §4 `session: null` |
| IndexedDB | **未闭合**：WP-045 只排除 `src/` 直接 open；WP-137 当前工作树无 `dist`，传递依赖静态分析和真实产品运行均未验，不能签无需迁移 | §3；§7 |
| Cookie / CacheStorage / Service Worker | WP-045 在 `src/` 未见直接调用；不外推传递依赖、远程页面或浏览器 profile 无持久状态 | 静态检索范围 |
| 内置浏览器 profile（`<activeDir>/browser-profiles/default`） | **仍未迁移，D-054 不批准丢弃登录态**。Tauri 端为 WebKitGTK/WebView2 格式（`dstu-browser/src/browser/window.rs:470,558`），Electron 端为 Chromium（`electron/shell/browser-surface.ts`）；文件名不冲突不等于登录态已迁 | 源码；迁移缺口保留 |
| `webview_settings.json`（后端快照） | **不能替代全量源**：仅含 19 个白名单键，且每 10 分钟才写一次（`src/app/hooks/useWebviewSettingsPersistence.ts`、`src/utils/systemApi.ts:97-125`），可能过期；不得因迁移失败加载默认值或此快照压住旧键 | 源码；D-054 |

## 2. 原路径 / 目标路径

Tauri 2.11.5 `crates/tauri/src/manager/webview.rs:534-545`：Linux/Windows 未指定 `data_directory` 时强制设为
`resolve(identifier, BaseDirectory::LocalData)`；wry 0.55.1 `src/webkitgtk/web_context.rs:33-46` 把它同时作为
WebKit 的 `base_data_directory` 与 `base_cache_directory`。macOS 不设，WKWebView 使用默认数据存储。
identifier 为 `com.deepstudent.app`（`src-tauri/tauri.conf.json:5`）。

| 平台 | 源（Tauri） | 源状态 | 目标（Electron；LevelDB 格式在 Linux 隔离 userData 实测，各平台目录按 Electron `appData` 约定推断） |
|---|---|---|---|
| Linux | `$XDG_DATA_HOME/com.deepstudent.app/localstorage/tauri_localhost_0.localstorage`（SQLite，WAL），兼查下述 recovery/legacy-root | 此布局**实测**（WebKitGTK 2.50.6）；`storage/<salt>/<hash>/LocalStorage/localstorage.sqlite3` 未见，不能自动按同格式处理 | `$XDG_CONFIG_HOME/com.deepstudent.app.electron/Local Storage/leveldb`（`electron/main.ts:79`；origin `tauri://localhost`，`main.ts:165`） |
| Windows | `%LOCALAPPDATA%\com.deepstudent.app\EBWebView\Default\Local Storage\leveldb`（Chromium LevelDB，origin `http://tauri.localhost`） | **未实测** | `%APPDATA%\com.deepstudent.app.electron\Local Storage\leveldb`，origin 同为 `http://tauri.localhost` |
| macOS | `~/Library/WebKit/com.deepstudent.app/WebsiteData/LocalStorage/tauri_localhost_0.localstorage` 或新版 `.../WebsiteData/Default/<salt>/<hash>/LocalStorage/localstorage.sqlite3`（未启用 app-sandbox，`src-tauri/Entitlements.plist`） | **未实测** | `~/Library/Application Support/com.deepstudent.app.electron/Local Storage/leveldb`，origin `tauri://localhost` |

Linux 特有风险：Tauri 的 app data 与 WebView 数据目录**是同一个目录**（`~/.local/share/com.deepstudent.app`），
WebKit 的 `localstorage/`、`databases/`、`storage/`、`WebKitCache/` 等在 F3 看来都是"旧版根目录条目"
（`host/platform/storage/locations.ts:34-37` 只排除 `slots/logs/recovery/.purge_on_next_start` 与安全工件）。
`startup-recovery.ts:112-122` 建立恢复事件时会把它们移到 `recovery/incidents/<id>/legacy-root/`。
因此：(a) 源快照必须在 **main 启动 Host 之前**完成（Host 启动即跑 F3 恢复）；(b) 定位源时还要找
`recovery/incidents/*/legacy-root/localstorage/…`。这一路径在 Rust 版本中同样存在，不属于 F2 改动范围。

## 3. 持久化键盘点（只读静态分析）

生成：`node electron/scripts/webview-storage-inventory.mjs electron/storage-migration/webview-storage-inventory.json`
（作业 `20261105160155-d6398b`）。逐键的所有者文件、读写方法、调用行号、是否模块求值期、是否在 try 内见该 JSON。

| 指标 | 值 |
|---|---|
| 含 localStorage 调用的文件（含测试） / 生产文件 | 152 / 111（brief 的"222 处"是含注释和测试的文本命中数） |
| 生产调用点 | 338 |
| 静态键 / 键模式（`epub-reader:*`、`qbank:lastQuestion:*`、`essay_draft_*`、`mindmap-recite-stats:*`、`preview-prefs-*`、`qbank:dailyTarget:*`、`template_debug_*_*`、MCP `*::*`） | 113 / 8 |
| 动态键调用点（`settingsApi` 非 Tauri 分支、workbench snapshot、草稿键等） | 42 |
| zustand `persist`（`chat-v2-sidebar-filter-prefs`、`learning-hub-desktop`、`finderPersistKey(bucketId)`、`learning-hub-recent`、`pdf-settings`、`pomodoro-storage`、`dstu-auto-sync`（自定义 storage）、`dstu-ui-store`） | 8 |
| 模块求值期读取（`App.tsx:184` workbench 预热、`utils/pdfDebug.ts:23`；其余在 demo） | 5 |
| 不在 try 内的调用点 | 39 |
| i18next 语言检测缓存 | `i18nextLng`（`src/i18n.ts:97-99`） |

所有者按目录聚合（键或动态调用点数）：workbench 23、chat 12、settings 10、debug-panel 16、learning-hub 10、mcp 8、
EssayGradingWorkbench 8、updater 6、todo 6、mindmap 5、useTheme 4、其余 ≤3。

读写时点：绝大多数在 React 初始化（zustand 同步 hydrate、`useState` 初值）或用户操作时；`App.tsx:184`、
`pdfDebug.ts:23`、i18next 初始化在**首个模块求值期**同步读取。所以迁移数据必须在页面任何脚本执行前就位。

失败语义（现状，不改）：生产代码对 localStorage 异常普遍是 catch 后用默认值继续；39 处无 try 的调用
主要可能因配额抛错。迁移是逐键 `setItem`，单键配额错误要计入回报并按 §5 第 5 步处理。两端配额差异未实测。

## 4. Linux 真实格式取证（隔离目录）

夹具：`electron/tests/fixtures/webview-storage/`。`webkit-probe.c` 按 wry 的方式建 WebsiteDataManager、
注册 secure `tauri` scheme，在 `HOME/XDG_*` 都指向 mktemp 目录的环境中写入后另起进程读回。
作业 `20261105153605-3a27bc`（首轮，末尾 `xxd` 缺失 exit 127，数据部分有效）、`20261105155237-c7af9a`（exit 0）。

- 页面 origin `tauri://localhost`、`isSecureContext=true`。
- `localstorage/tauri_localhost_0.localstorage`：`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)`；
  值为 **UTF-16LE 码元原样**：`dark` → `6400610072006B00`，空串长度 0，孤立代理 `\uD800x` → `00D87800`，
  NUL 保留 → `610000006200`，70000 字符 → 140000 字节。运行中存在 `-wal`，正常退出后合并。
- IndexedDB：`databases/indexeddb/v1/tauri_localhost_0/<sha256>/IndexedDB.sqlite3`，值为 WebKit
  SerializedScriptValue 二进制（Records 表），Date/Uint8Array/Map 在 WebKit 内读回类型正确，但**外部不可解码**。
- 同时生成 `storage/<salt>/<salt>/origin`（新版按 origin 分区的目录），本版本 localStorage 未放入其中。

## 5. 最窄迁移方案（D-054 批准范围，未实现）

原则：不删、不改、不在原处打开源文件；逐字节保留 UTF-16 码元；**目标已有键优先**（target wins）；可断点恢复；
不新建通用迁移框架，只做 localStorage 一类。

1. **前置与快照（main，Host 启动前）**：首先可靠核实旧应用及其 WebKit 存储 writer 已停止，且复制期间保持停止；
   当前公开能力未满足，见 `WP-137.md`，不得猜测锁或自动停止他人进程。
   标记文件 `<userData>/webview-migration/state.json` 不存在或为 `snapshotting` 时，
   仅定位 §2 已验证布局（含 recovery legacy-root 候选）；在停机条件成立后把 `db`/`-wal`/`-shm` 复制到
   `<userData>/webview-migration/source/`，在副本上 `PRAGMA integrity_check`，记录必要源路径，**不加 hash 清单**，
   状态写 `snapshotted`（原子写）。已是 `snapshotted` 时**复用旧快照**，不重新读源，避免两次启动间源变化导致不一致。
   找不到源（新用户）→ 直接写 `done`（`source: null`）。
2. **解码（main）**：`node:sqlite`（Electron 45 内置 Node 24.22.1，无需新依赖；已实测）读 `ItemTable`，
   BLOB 逐码元还原（不经 TextDecoder），TEXT 原样；字节数为奇数视为损坏。
3. **写入（preload，sandbox）**：Linux 首个 `tauri://localhost` 文档的 preload 用同步 IPC 取全量待写列表，
   对 `getItem(key) === null` 的键 `setItem`，已有键保留并计数，然后同步回报；此时页面脚本尚未执行。
4. **落盘与完成**：main 收到回报后 `session.defaultSession.flushStorageData()`，状态写 `done`（含写入/保留键数）。
   在 `done` 之前崩溃：下次启动从 `snapshotted` 重放第 3 步，已落盘的键按 target wins 保留，未落盘的补写；重放幂等。
5. **失败与重试**：前置核验、快照、解码或写入失败时**不放行页面脚本/默认值**（否则默认值会被当作"目标已有键"永久压住旧值）。
   仅允许重试 / 退出；禁止本次跳过及永久 `skipped`。preload 抛错本身不能保证阻止页面脚本，生产实现必须另证失败阻断。
   各分支写日志 `[webview-migration] …`，不吞错、不新增业务 Err。
6. **源数据**：F2 永不删除、不改名、不覆盖源；`done` 之后源与快照仍保留，不增加清理期限。
   F3 既有启动恢复的移动行为见 §2，不属于本包授权修改范围，不能宣称原路径始终不变。

类型/缺省/事务：Web Storage 只有 string→string，空串与缺省（`null`）区分保留；zustand 的 `{state, version}`
JSON 原文不解析不改写，版本迁移仍由前端自己的 `migrate` 执行。WebKit localStorage 没有跨键事务，
分别复制 SQLite db/WAL 后做 integrity_check **不保证并发快照一致性**；一致性必须以前述已核实停机条件为基础。
写入通过"幂等重放 + done 标记"恢复；完成标记与持久化的崩溃边界仍须走生产路径实测。

Windows 源为 Chromium LevelDB：建议用 `session.fromPath(<源 EBWebView 的副本>)` 打开隐藏窗口在同一 origin 读出，
避免引入 leveldb 原生依赖；能否打开 WebView2 写入的 LevelDB 版本**未验证**。

## 6. 可复跑验证场景

`bash electron/tests/fixtures/webview-storage/run-scenario.sh [输出目录]`（经作业队列，Linux，需要 gcc、
webkit2gtk-4.1 开发包、xvfb-run、sqlite3）：

1. WebKitGTK 写入 8 个键（含空串、中文+emoji、NUL、孤立代理、JSON、70000 字符）、一条 IndexedDB 记录；新进程读回。
2. Electron（与 `protocols.ts` 相同的 scheme 特权、sandbox preload）先 `seed` 一个冲突键 `dstu-theme-mode=light`。
3. `import-kill`：快照副本 → node:sqlite 解码 → preload 写入 → `flushStorageData` → 1 秒后 SIGKILL。
4. `verify`：新进程读回逐键比对。

结果（作业 `20261105155237-c7af9a`，exit 0，`SCENARIO PASS`）：origin `tauri://localhost`；副本 integrity ok；
源文件 sha256/mtime 前后不变；页面第一条语句读到 `i18nextLng=zh-CN`（preload 早于页面脚本）；冲突键保留
`light`；其余 7 键码元完全一致；SIGKILL 后数据仍在。该夹具不是生产迁移实现。

## 7. 缺口与待裁定

| 项 | 状态 |
|---|---|
| D-W6b-1 方案（§5）、target wins、失败时阻塞首窗 | D-054 已窄批准；停机核验能力阻断见 WP-137 |
| D-W6b-2 内置浏览器 profile 登录态不迁移 | D-054 不予签收，保留迁移缺口 |
| D-W6b-3 快照/源保留期限、`skipped` 是否允许 | 源与快照保留；失败仅重试或退出，不准 skipped |
| macOS WKWebView 实际路径与新/旧布局 | 未实测（U-001） |
| Windows WebView2 LevelDB 能否被 Electron 45 Chromium 读取 | 未实测（U-001） |
| 较新 WebKitGTK 的 `storage/.../LocalStorage/localstorage.sqlite3` 布局 | 未在本机出现，未实测 |
| 构建后 `dist` 中传递依赖是否使用 IndexedDB | WP-137 当前树无 dist；静态与运行均未验。单个文本匹配零命中也不能覆盖别名或动态调用 |
| AppImage 内置 WebKit 与系统 WebKit 版本差异 | 未实测 |
| 用户同时运行 Tauri 版与 Electron 版 | 不在首包范围；旧 writer 未可靠确认停止就不得迁移，integrity_check 不能解除此前置 |
| 实现归属 | F2（main + preload），本包未实现 |

## 8. W07 实现（2026-11-07）与接线约定

### 8.1 模块

| 文件 | 内容 |
|---|---|
| `sources.ts` | 定位唯一迁移源。Linux：`<data_local>/<id>/localstorage/tauri_localhost_0.localstorage`（实测布局）→ 新布局 `storage/<h>/<h>/LocalStorage/localstorage.sqlite3` 优先 → 都没有时取 `recovery/incidents/*/legacy-root/` 中最近一次事件的副本。macOS：`~/Library/WebKit/<id>/WebsiteData/` 下新布局 `Default/<h>/<h>/…` 优先于旧 `LocalStorage/tauri_localhost_0.localstorage`。Windows：`<data_local>/<id>/EBWebView/Default/Local Storage/leveldb`（有 `CURRENT` 才算）。新布局只接受顶层与帧目录同名（第一方）且 `origin` 文件同时含 `tauri`、`localhost` 的目录；多于一个即 `SOURCE_AMBIGUOUS`，不猜。 |
| `formats.ts` | WebKit：在**快照副本**上 `PRAGMA integrity_check`，要求存在 `ItemTable`，BLOB 逐码元 UTF-16LE 还原（奇数字节即损坏），TEXT 原样。Chromium：`VERSION` 必须为 `1`；只取 `_<origin>\x00` 前缀的键；键与值首字节 0=UTF-16LE、1=Latin-1，其他前缀即损坏。 |
| `leveldb.ts`、`snappy.ts` | 纯 TS 只读 LevelDB：CURRENT → MANIFEST（VersionEdit 新增/删除文件、log number）→ 存活 table 与 log，按序列号合并、删除标记生效；校验每条 log 记录与每个 block 的 masked CRC32C；块压缩支持 none/snappy，其它（如 zstd）报错。log 尾部被截断的记录按 EOF（写入方崩溃的正常形态）。不依赖原生 leveldb，不需要 W08 加依赖。 |
| `writer-probe.ts` | §5.1 停机核验的证据来源：Linux 扫 `/proc/*/fd`；macOS `/usr/sbin/lsof -F pc -- <源文件>`；Windows 用 PowerShell CIM 查 `msedgewebview2.exe` 命令行里的 `--user-data-dir` 是否仍指向 Tauri 版 `EBWebView`。取不到证据一律 `unknown`。 |
| `migration.ts` | 状态机（§5.1/§5.4）：`snapshotting` → 源指纹 → 核验 → 复制 → 再核验 → 指纹比对 → 解码副本 → `snapshotted`；`snapshotted` 只解码快照；`done` 由 `completeWebviewMigration` 在 preload 回报且 flush 之后写入。快照目录 `<userData>/webview-migration/source/`，LevelDB 不复制 `LOCK`/`LOG`。 |
| `apply.ts` | preload 侧 `applyWebviewMigrationEntries(localStorage, entries)`：target wins，逐键写入，单键失败计入 `failed`。无任何 import，可被 esbuild 打进沙箱 preload。 |

错误统一为 `WebviewMigrationError`，`code` ∈ `WRITER_RUNNING`、`WRITER_UNVERIFIED`、`SOURCE_CHANGED`、
`SOURCE_AMBIGUOUS`、`SOURCE_UNREADABLE`、`SNAPSHOT_FAILED`、`TARGET_WRITE_FAILED`、`TARGET_VERIFY_FAILED`、`NOT_SNAPSHOTTED`，
`userMessage` 是给用户看的中文说明（例如“请先完全退出旧版，再点‘重试’”）。

### 8.2 W06 接线约定（W06 已接入：`electron/main.ts`、`electron/shell/webview-migration.ts`、`electron/preload/webview-migration.ts`）

接入后的偏差与补充：开发服务器模式（`DS_ELECTRON_DEV_URL`）不迁移、不改状态（页面 origin 不是 `tauri://localhost`）；
空白迁移页为 `<应用 origin>/__dstu__/webview-migration.html`（`tauri` 协议直接返回空文档）；迁移页加载完成却没有回报也按失败处理；
Electron 45 的 `flushStorageData()` 同步返回、无完成回调，因此标记 `done` 之前加一道确认（W06 第三轮）：
flush 后再加载一次迁移页（核对页），preload 用 `readBackWebviewMigrationKeys` 读回全部键，经 `WEBVIEW_MIGRATION_VERIFIED_CHANNEL`
回报；写入的键必须等于快照值、`keptKeys`（target wins 保留的键）必须仍存在；随后 main 轮询 `<userData>/Local Storage/leveldb`
（本目录的只读 LevelDB 解码器），读回的每个键值都在磁盘上才 `completeWebviewMigration`。任一不一致为 `TARGET_VERIFY_FAILED`
（重试从写入页重来）。每次重新加载迁移页都等上一次加载结束，避免迟到的 `did-finish-load` 被算到新页面上。
证据：`electron/tests/webview-migration-gate.test.ts`、`electron/tests/webview-migration-persisted.test.ts`、
`electron/tests/webview-migration-host.test.ts`（真实 Electron；含“确认落盘后、写 done 前 SIGKILL → 下次启动重放，written 0、全部 kept”）。

1. `app.setPath('userData', …)` 之后、`runtime.host.start()` 之前：
   `const prepared = await prepareWebviewMigration({ platform, homeDir: paths.home(), dataLocalDir: paths.localDataDir(), appDataDir, identifier: config.identifier, userDataDir: app.getPath('userData'), log })`。
   Linux 必须在 Host 启动前完成快照（Host 启动即跑 F3 启动恢复，会移动旧根目录条目，见 §2）。
2. 抛 `WebviewMigrationError` 时：`dialog.showMessageBox` 展示 `userMessage`，按钮只有“重试”（重新调用第 1 步）和“退出”。不得创建主窗口、不得标记跳过。
3. `prepared.status === 'pending'`：`ipcMain.on(WEBVIEW_MIGRATION_PENDING_CHANNEL, e => { e.returnValue = JSON.stringify(prepared.entries) })`；
   preload 在**首个** `tauri://localhost`（Windows 为 `http://tauri.localhost`）主窗口文档、页面脚本执行前：
   `const entries = JSON.parse(ipcRenderer.sendSync(PENDING) ?? 'null')`，非空时
   `ipcRenderer.sendSync(APPLIED, applyWebviewMigrationEntries(localStorage, entries))`。
   只 import `electron/storage-migration/apply.ts`。
4. main 收到 `APPLIED`：`report.failed.length > 0` 时按第 2 步处理（`completeWebviewMigration` 会抛 `TARGET_WRITE_FAILED`）；
   否则 `await session.defaultSession.flushStorageData()` 后调用 `completeWebviewMigration({ userDataDir }, report)`，再放行页面。
   §5.5 要求“失败时阻断页面脚本”：preload 抛错本身不能保证阻断，建议首窗先加载空白页，迁移完成后再 `loadURL` 正式入口。
5. `DS_APP_DATA_DIR`（冒烟隔离）生效时同时隔离 `homeDir`/`dataLocalDir`，否则会去读真实用户的 Tauri WebView 数据。

### 8.3 仍未闭合

- macOS / Windows 真实落盘格式未实测：WKWebView 新布局的 `origin` 文件按“含 `tauri`、`localhost`”识别；WebView2 LevelDB 按 leveldb 公共格式与 Chromium `dom_storage` 键约定解码，若真实数据用了 zstd 块压缩或别的 `VERSION` 会明确报 `SOURCE_UNREADABLE`，不会静默丢数据。
- 停机核验：三种探针都只能证明“核验窗口内没有进程打开源文件 / 没有 WebView2 进程使用该目录”，并以源文件指纹包住整个窗口；它们不是 WP-137 要求的“源目录绑定的离线租约”。是否接受这一证据级别需 C1/主代理裁定；不接受时保持 `WRITER_UNVERIFIED` 的 fail-closed 行为即可。
- Windows 探针依赖 PowerShell；在 AppLocker/受限语言模式下会得到 `unknown` → 迁移暂停并提示，用户无法自行解除。替代方案：W06 改用 Electron 侧可用的进程枚举（或在打包时附带的小型原生探针）后注入 `probe`。
- IndexedDB：`src/` 仅 `dev.commands.ts` 的 `databases()/deleteDatabase()`（调试命令，不存数据）；构建后传递依赖仍未验（§7）。
- 内置浏览器 profile 登录态仍未迁移（§1、§7）。
