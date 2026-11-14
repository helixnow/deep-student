# W06 mac 原生入口集成验收（2026-11-07 18:21）

- 主编排批准mac-only最小产品集成：`cd326647` 固定Electron45.2.1主stub源码+签名前hook+严格native/JS联合审计；`6e03adf5` 既有缓存/portable只读回归脚本。
- 全新外置真实包：**smoke18/18、完整fuse13/13、既有398文件缓存+PORTABLE=1隔离4/4**；单测34/34+1/1。缓存目录不存在/Host userData cache存在硬断言保留，PID/标识/名单精确审计。
- W12 17:39 dist只读快照，不再用10:04旧dist；本轮不声称统一UI候选已验收，旧W06 dist保留在.cache。
- 产物 `/Volumes/DSWork/W06-native-stub-delivery-20261107-1816`；完整证据/命令/发布限制见 `electron/native-stub-delivery.md`。
- 仅arm64/ad-hoc实测；x64参数映射单测、不支持universal2，正式签名/升级链及Windows/Linux未验/未修。不改依赖、共享Electron或W12 smoke。

# W06 接管打包实测（2026-11-07 17:44）

- `891d75ed` 基线，本机外置盘真实打包 exit 0；migrations、332 个包闭包及测试二进制排除检查通过。未重建已有 dist。
- `5b23b1f5`：支持 `DS_ELECTRON_PACKAGE_OUTPUT` 外置输出，打包后校验跟随同一路径；默认 release 不变，新选中用例 1/1。
- 真实包 smoke **17/18**、静态签名/fuse 检查 **8/8**。唯一失败仍为旧交接的 main `NODE_COMPILE_CACHE` 缺口；未放宽断言，未假称已修。
- 金丝雀目录早于 main 清变量日志 120ms 创建，退出后 398 个缓存文件；JS relaunch/删目录不是修复。需协调 Electron 原生运行时初始化前处理，不能只改 JS；未擅改依赖或补丁运行时二进制。
- 现场保留于 `/Volumes/DSWork/W06-packaging-smoke-20261107-1745`。完整命令、证据、边界见 `electron/packaging-smoke.md`。

# W06 第十一轮进度（L02 建议 / Windows 安装器 ShellExecuteW / E 趟后续 / 交接）

开工：接上一任 tip `7d3d2286`（INT `1d1fdb78`）。E 趟在 `int/stage-1555`（`6800b072`）合并中，还没进 INT。

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | L02 F3：`lifecycle.quit` 绝对退出上限 | 完成；新 RF `RF-W06-quit-hard-deadline`（deliberate，proposed） | `15fcc31c` | `HOST_QUIT_DEADLINE_MS` = 预算 8000 + 3000；到点 `HostSupervisor.forceKill`（SIGKILL）后 `app.exit`。`app-lifecycle.test.ts` 新 4 例（含第二次 Cmd+Q 仍被拦、exit/restart 的退出码与 relaunch、按时退出不误杀且只 exit 一次），`host-shutdown-budget.test.ts` 新 1 例。反向：去掉上限后 2 例红 |
| 2 | L02 F6：预算两例阈值口径 | 完成 | `15fcc31c` | 第一例改为严格大于（与第二例的计时语义一致）。`host.ts` 注释等 W01 进 INT 时与 todo 一起改 |
| 3 | L02 F10：kernel32 加载失败不重试 | 完成 | `3f7eb2ee` | 新 `io-error-text-ffi.test.ts` 2 例（koffi 替身 + platform 设为 win32）；反向：去掉失败标记后红 |
| 4 | Windows 安装器改用 `ShellExecuteW` | 完成（需 Windows 实机验证） | `00feff45` | 与 `updater.rs:787-866` 同参：`(NULL, "open", file, args.join(" "), NULL, SW_SHOW)`，返回值不看，之后 exit(0)；在 koffi 工作线程调用（Rust 在 tokio 工作线程）；可注入；非 Windows 不加载 shell32。`updater-install.test.ts` Windows 段改为断言 ShellExecuteW 参数串；反向：回到 spawn 后 7 例红 |
| 5 | 安装器临时文件布局同 `write_to_temp` | 完成 | `e3bbedc0` | `{app}-{ver}-updater-XXXXXX/{app}-{ver}-installer.exe\|.msi`（原为 `…-installerXXXXXX/installer.exe`；未签名安装包的 UAC 提示显示这个文件名） |
| 6 | L08 F11：AppImage 替换失败无条件复原 | 完成 | `9b54d865` | 同 `updater.rs:1017/1026/1036`；注入 chmod 失败的新用例，旧代码下红（拿到的是新文件） |
| 7 | L08 F16：`electron/LANE.md:284` 过时 | 完成 | 本节提交 | `migration/spec/F2-shell.md:505` 不在 W06 路径，交接 |
| 8 | 800 行以上文件拆分 | 无需 | — | `electron/` 下最大的是 `browser-surface.ts` 636 行 |

# W06 第十轮进度（FM-11 后端 Sentry / AL-13 全局快捷键 / updater 拆分 / 打包冒烟）

开工：接上一任 tip `e6729de2`；INT 推进到 `1d1fdb78` 后合入（`d0b7b81e`，无冲突，lane 路径只有 RF 文件变动）。

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | FM-11 后端 Sentry：`@sentry/node` 真正在 Host 里初始化、发送 | 完成（Electron main 进程自身的崩溃不上报，见“遗留”） | `9ed330ec`（依赖单独提交）`04a04488` `b6846e85` | `tests/backend-sentry.test.ts` 23 例（假 DSN + 注入 transport；插件接线用例走本机 HTTP 收件端）；与 `shell-commands` 合跑 34/34 ×3 |
| 2 | 删掉未批准的 `RF-W06-backend-sentry-sdk-not-shipped` | 完成 | `04a04488` | JSON 与代码标记一并删除；`rust-fixes --check` 0 error |
| 3 | 新 RF `RF-W06-backend-sentry-rust-no-transport`（proposed） | 登记 | `04a04488` | 见下“Rust bug”；用例标题即 RF id |
| 4 | AL-13 / L02 F5：全局快捷键以 SEC-E05 原生事件进 Host 的测试 | 完成 | `546132c3` | `builtin-acl.test.ts` 新例（真实 `ShellRuntime`）；W23 真实 Electron `background-residency-wiring-host` 2/2 |
| 5 | AL-08 | 外壳无改动 | — | — |
| 6 | V09-P1-2 `it.todo` 转正 | 前提不满足，保持 todo | — | `git merge-base --is-ancestor dde2f603 assault/integration` → 否（`1d1fdb78`） |
| 7 | `writer-probe.ts:96-127`（V10 P2-1） | 第八轮 `7c4a519c` 已修且在 INT；按 Rust 复核 | — | `writer-probe.test.ts` 9 例；残留见下 |
| 8 | S01 `maybeRunHelper` 接入 bootstrap | 交接（边界不允许） | — | 见“交接” |
| 9 | `shell/updater.ts`（849 行）拆分 | 完成，行为不变 | `84b50e9a` | 安装器逐字搬到 `shell/updater-install.ts`（diff 证明除 3 个 `export` 外逐字一致）；580 + 273 行；新 `updater-install.test.ts` |
| 10 | MSI `LAUNCHAPPARGS` 转义与 Rust 不一致 | 已修 | `b7764016` | Rust 插件自带的 `it_escapes_correctly_for_msi` 11 个向量；修前 3 个带引号的失败 |
| 11 | 打包 + 打包冒烟 | 17/18；1 项真问题（不放宽） | — | 见“打包冒烟” |
| 12 | boundaries 新增的 `empty-catch`（`backend-sentry.ts` 上报失败的空 catch） | 已修：改为记 warn，仍不外溢 | `a8fb6af7` | boundaries 0 violation；对应用例加断言 |

### 交付闸门（INT `1d1fdb78`，一次）

| 闸门 | 结果 |
|---|---|
| `node scripts/electron-migration/boundaries.mjs` | 0 violation（修 `a8fb6af7` 之前 1 条，是本轮新增的） |
| `gate-checks/import-cycles.mjs --check` | 0 new / 0 stale（34 条均在基线） |
| `gate-checks/rust-fixes.mjs --check` | 94 条（approved 92 / proposed 2），131 个 RUST-FIX 标记，0 error |
| `gate-checks/portability.mjs --check` | NEW 0，mobile 违例 0 |
| `npm run -s contracts:check` | OK |
| `npm run -s licenses:check` | 仍红 2 项：pdfium 许可证源文件不在快照（交接） |
| `bin/heavy npx tsc --noEmit -p tsconfig.host.json` | exit 0 |
| `bin/heavy npx vitest run -c vitest.host.config.ts electron/ --maxWorkers=2` | 101 文件通过 / 1 跳过；648 通过 / 6 跳过 / 1 todo（V09-P1-2） |

### FM-11 后端 Sentry

- 位置：Host 进程的 `dstu.shell` 插件（`electron/index.ts`）。授权开关命令、启动读授权、未处理异常都在 Host；Rust 的后端也是一个进程。
- `electron/backend-sentry.ts`：
  - `createBackendSentry` 复刻 `set_backend_sentry_enabled` / setup：先存 `sentry_error_reporting_enabled`，开则初始化，关则 flush（2 s）后关闭客户端；
    启动时只有值为 `"true"` 才初始化，读失败按未授权，不写回。并发 invoke 用 promise 串行链复刻 Rust 的 Mutex。
  - DSN：`SENTRY_DSN` 运行时变量（存在即用，空串也算）→ 否则打包时写入的值（`build-info.ts` `bundledSentryDsn`，`package.mjs` 只在
    `SENTRY_DSN` 有值时写入，并打印 embedded / not embedded）。DSN 缺失或非法 → 保持 disabled，开关返回 false（同 Rust）。
  - `defaultSentryInit`：`defaultIntegrations: false`、`autoSessionTracking: false`、`sendClientReports: false`、`skipOpenTelemetrySetup: true`、
    `registerEsmLoaderHooks: false`、`spotlight: false`，`beforeSend` 删除 `server_name`；release 同 Rust `sentryRelease`；
    environment = `SENTRY_ENVIRONMENT` ?? debug/production。
  - 上报：`uncaughtExceptionMonitor`（随后 Host 退出）与 `unhandledRejection`，Fatal 事件 + 指纹（栈帧路径相对应用根，不带用户目录，`scrubPii`）。
  - 插件 dispose：flush 上限 1000 ms（W01 每插件 dispose 1500 ms）。
- 测试（`electron/tests/backend-sentry.test.ts`，23 例）：全部用假 DSN（`https://public@o0.ingest.example.invalid/42`、本机端口）与注入的
  transport，记录 envelope 与请求 URL；每例后断言全局 scope 没有残留客户端。覆盖：开/关/再开、关后不再上报、保存失败报 Rust 文案、
  DSN 缺失/非法（按 `Dsn::from_str` 判定）、运行时变量优先于构建时、启动只认 `"true"`、启动恢复与开关共用一把锁、关闭失败只记日志、
  只发事件（无 session / client report / trace）、事件不带 `server_name`/user/request、`sdk.integrations` 为空、
  envelope 发往 `/api/42/envelope/` 且 `sentry_key=public`、上报路径里的异常不外溢；插件接线用例在真实 `createTestHost` 里发 `uncaughtExceptionMonitor`，本机 HTTP
  收件端收到 Fatal 事件。
- 没有读取、打印或提交任何真实 DSN；打包时 `env -u SENTRY_DSN`，产物里没有 DSN 文件。

### Rust bug：`RF-W06-backend-sentry-rust-no-transport`（proposed）

`src-tauri/Cargo.toml` 的 `sentry 0.32.3` 用 `default-features = false`，features 只有 backtrace / contexts / panic / rustls / debug-images / anyhow，
没有任何 transport。有 DSN 时 `sentry::init` 走 `DefaultTransportFactory::create_transport`，直接 panic
“sentry crate was compiled without transport”（sentry-0.32.3 `src/transports/mod.rs:99`）。CI 构建注入 `SENTRY_DSN`
（`.github/workflows/reusable-build-{macos,windows,linux}.yml`），所以正式包里：打开开关 → 设置已存为 `"true"` → 初始化 panic → 命令报
“更新错误报告授权任务失败”、前端把开关拨回；之后每次启动在 setup（lib.rs:1328）读到 `"true"` 再次 panic。用最小 crate 同版本同 features
`cargo run --offline` 复现。Electron 用 `@sentry/node` 自带的 HTTP transport 真正发送，代码处有 `RUST-FIX(RF-W06-backend-sentry-rust-no-transport)`。

### 依赖（任务 1 流程）

- `package.json` 加 `"@sentry/node": "8.55.2"`；lock 在 `mktemp -d` 里 `npm install --package-lock-only --offline --ignore-scripts` 生成后拷回。
  lock：新增 69 条路径、删除 0；10 条失去 `dev: true`（@sentry/core、acorn、es-errors、function-bind、hasown、is-core-module、path-parse、resolve、
  supports-preserve-symlinks-flag、xtend——现在是生产依赖的传递依赖）。前端包清单只换哈希（`9be60aa0…` → `bb17b79a…`，469 包 / 77 份静态拷贝不变）。
- 共享 `node_modules`：只把缺的目录从临时安装里拷进去。前后清单对比：前 1419 项、后 1478 项，删除 0，新增 59（`@opentelemetry` scope 目录 + 34 个包、
  `@prisma/instrumentation`、`@sentry/node`、`@sentry/opentelemetry`、`@types/{connect,mysql,pg,pg-pool,shimmer,tedious}`、`import-in-the-middle`、
  `require-in-the-middle`、`pg-*`/`postgres-*` 等，另有 10 个嵌套在新包内）；已有的 `@sentry/core` 前后都是 8.55.2，没被覆盖。
  隐藏 lock `deep-student/node_modules/.package-lock.json` sha256 `857f014f…22cc1`、mtime/size 前后一致，无需复原。临时目录已删。
- 打包闭包：`node-modules-closure` 不再把 `@sentry/node` 当可选包；生产闭包 332 个包全部进 app.asar。

### 许可证

- `legal/THIRD_PARTY_NOTICES.txt` 按当前 Cargo.lock / package-lock 重新生成（`b6846e85`；Components 2140 → 2015，distinct texts 857）。
  生成需要的 pdfium 许可证与 `public/fonts/paper-export/OFL.txt` 不在仓库快照里，临时从本机原仓库拷来、生成后删除（内容逐字一致）。
- `npm run licenses:check`：4 项失败降到 2 项，剩下的都是“Missing bundled license source: `src-tauri/resources/pdfium/LICENSE.pdfium-binaries`
  / `.../licenses`”——文件不在快照里，需要有人把它们提交进仓库（交接）。

### AL-13

- W23 补丁的内容第九轮 `e6729de2` 已全覆盖（含 `main.ts` 里的 `sendNativeEvent`），本轮不再 apply。缺的是测试（L02 F5：没有用例断言
  快捷键事件带 `native: true`）。转发挪到 `shell/plugins/system.ts` 的 `forwardShortcutToHost(runtime)`（事件名用 `GLOBAL_SHORTCUT_TRIGGERED`
  常量），`builtin-acl.test.ts` 用真实 `ShellRuntime` 断言 Host 收到
  `{ kind: 'frontend-event', event: 'global-shortcut://triggered', target: { kind: 'App' }, source: main/main, native: true }`。
  W03 `quick-assistant.ts:86` 可以在本提交进 INT 后收紧为 `native === true`。
- AL-08：外壳侧不需要改。

### writer-probe 残留（不改）

`7c4a519c` 已把 WebView2 进程查询改成 Base64 编码的 PowerShell 并按用户数据目录匹配，与 Rust 一致。残留：CommandLine 读不到的
`msedgewebview2`（提权或其他用户）按“不是我们的”处理。没有 Windows 无法测试 PowerShell 分支，而且还有第二道检查，本轮不动。

### updater 拆分与测试

- `updater-install.ts`：`Update::install` 三平台实现原样搬出；`updater.ts` 只留 check/download/插件命令，去掉 fs/os/path/zlib/tar/child_process 导入
  （其中 `closeSync`、`openSync`、`readFileSync`、`readSync`、`writeSync`、`basename` 原本就没用到）。类型用 `import type` 取回，不形成运行时环。
- `updater-install.test.ts`（15 例）：ZIP store/deflate 解包、目录项跳过、`../` 与绝对路径拒绝且不写到外面、无 EOCD / 不支持的压缩方法；
  NSIS / MSI 转义按 Rust 插件自带向量；macOS `.app.tar.gz` 在临时目录真实替换（strip 一层、旧文件消失、临时目录清空、坏包时保留原包）；
  Linux AppImage 原始文件覆盖保持权限、tar.gz 取第一个 `.AppImage`、包里没有时复原；Windows 截获 `spawn`：NSIS 参数顺序
  （模式开关 → `/UPDATE /ARGS` → 转义后的当前参数 → installerArgs）、installMode 映射、msiexec 参数与 `LAUNCHAPPARGS`、zip 里优先 `.exe`、
  版本号里的 `/` 不能让临时目录越出 tmp、无安装器 / 未知格式报错。三个文件合跑 33/33 ×3。
- MSI 转义：Rust 把参数里的每个 `"` 换成 4 个引号（`r#""""""#` 是原始字符串 `""""`），移植版写成 6 个。MSI 不是现在的发布目标（CI 只出 NSIS），
  现有发布包用户无感。
- 未改、需 Windows 实机验证：Rust 用 `ShellExecuteW(open, file, args.join(" "))` 启动安装器；移植版用 `spawn`（CreateProcess）。两处差异：
  ① libuv 会再给含空格/引号的参数加一层引号，已转义的参数会被转义两次（只在当前进程带这类参数时出现）；② 安装器清单要求提权时
  CreateProcess 返回 ERROR_ELEVATION_REQUIRED，而 ShellExecute 会弹 UAC；`runtime.exit(0)` 紧跟其后，应用退出而安装器没起来。
  NSIS `installMode: "both"` 是否要求提权取决于模板，本机无法确认。建议：用已随包的 koffi 调 `ShellExecuteW`（与 Rust 同参），在 Windows 上验证。

### 打包冒烟（`bin/heavy`，macOS arm64）

- 打包：`DEEP_STUDENT_BUILD_NUMBER=20000 bin/heavy env -u SENTRY_DSN node electron/scripts/package.mjs --mac --dir` exit 0；迁移文件一致；
  生产闭包 332 包全在 app.asar，测试用的 sqlite-busy 没打进去；DSN 未嵌入。用上一任留下的 `dist/`（没有重建、没有删除）。
- 冒烟：`bin/heavy env -u SENTRY_DSN node electron/scripts/__tests__/packaged-smoke.mjs` → 17/18。冷启动首窗 4793 ms、Host ready 8250 ms、
  42/42 插件、SEC-E02 前端从包内加载、原生 `.node` 来自包内、koffi、better-sqlite3、sqlite、FSRS wasm、复习日志、worker 池、诊断导出、
  LLM 流、日志无 ERROR、开发变量记录并忽略、Host 入口/profile/capture 覆盖被忽略。
- 失败项：“SEC-E02: Host compile cache under userData, inherited NODE_COMPILE_CACHE ignored — canary dir CREATED”。Host 的缓存确实在
  `userdata/host-compile-cache`（4283 个文件），但金丝雀目录 `dev-overrides/compile-cache/v24.22.1-arm64-…` 也被写了 394 项。原因：Electron
  main 进程内嵌的 Node 在引导阶段（应用 JS 之前）就读取继承来的 `NODE_COMPILE_CACHE` 并启用编译缓存；fuses 不管这个变量，Node 也没有
  关闭编译缓存的 API（只有 enable/flush/get）。应用代码最多能在发现后去掉变量重启自己，限制持久写入，挡不住第一次加载读缓存。
  影响：能控制启动环境的人可以让 main 进程读写外部目录里的 V8 代码缓存（绕过 asar 完整性的一条路径）；没有做出利用，不按新高危报。
  金丝雀是第九轮加的、当时没跑打包。断言正确，不放宽；交主控 / 安全线决定（Electron 层面的修复或重启缓解）。
- 产物（`release/`、`$TMPDIR/ds-packaged-smoke/` 本轮的 app 副本与 run 目录、日志）已删除。

### 交接

- W01 `host/kernel/main.ts:49-51`：未捕获异常后 `exitSoon` 只等 500 ms 就 `process.exit`，Rust crash_logger 的 flush 等 2 s；后端 Sentry 在 `uncaughtExceptionMonitor` 同步
  入队，500 ms 内发不完的崩溃事件会丢。
- CI 打包工作流：给 `node electron/scripts/package.mjs` 传 `SENTRY_DSN: ${{ secrets.SENTRY_DSN }}`（同 Tauri 构建），否则正式包没有构建时 DSN。
- 仓库：提交 `src-tauri/resources/pdfium/LICENSE.pdfium-binaries` 与 `src-tauri/resources/pdfium/licenses/`（`licenses:check` 剩下的 2 项）。
- S01：`maybeRunHelper` 在 `host/plugins/agent-workspace/...`，`electron/` 不能 import `host/plugins/`（boundaries `electron-imports-plugin`），
  而且原生 runtime 不在。需要 S01 把 helper 挪到 `host/platform/`（或 electron 可见的位置）并导出，之后 `electron/shell/bootstrap.ts:81-86`
  把现在的拒绝换成：

  ```ts
  const helperArgv = shellSandboxHelperArgv(options.launch);
  if (helperArgv !== null) {
    let code: number;
    try { code = maybeRunHelper(helperArgv) ?? SHELL_SANDBOX_HELPER_FAILURE_CODE; }
    catch (error) { options.launch.stderr.write(`${SHELL_SANDBOX_HELPER_UNAVAILABLE}: ${message}\n`, () => app.exit(SHELL_SANDBOX_HELPER_FAILURE_CODE)); return; }
    app.exit(code); return;
  }
  ```
- W23：`queryResidencyState` 的 invoke 带 `caller: 'dstu.agent-orchestration'`（`electron/shell/background-residency.ts:163-167`）——
  `6daff78f` 与 `353cc707` 都不在 INT（`1d1fdb78`），当前代码没有 caller。
- W01 `dde2f603` 进 INT 后，`electron/tests/host-shutdown-budget.test.ts:55` 的 `it.todo` 可以转正。
- 主控 / 安全线：上面的 `NODE_COMPILE_CACHE` main 进程缺口。
- Windows 验证：updater 的 `spawn` vs `ShellExecuteW`（上文）。

### 遗留

- Electron main 进程自身的崩溃不上报 Sentry：授权与 DSN 在 Host，main 里没有客户端（Rust 只有一个进程，没有对应物）。需要时由 Host 把
  授权状态推给 main 再初始化，本轮没做。
- 打包冒烟的编译缓存金丝雀（上文），未修。

### Linux 需要重跑

`electron/tests/backend-sentry.test.ts`、`build-info.test.ts`、`shell-commands.test.ts`、`node-modules-closure.test.ts`、`third-party-notices.test.ts`、
`builtin-acl.test.ts`、`updater-install.test.ts`、`updater.test.ts`、`updater-page-options.test.ts`、`writer-probe.test.ts`、`background-residency-wiring-host.test.ts`（真实 Electron）。

# W06 第九轮进度（V04-02 关窗后台驻留接线 / V09-P1-2 关停预算设计 / 交接收尾 / 生命周期拆分）

开工：合 INT `390f244b`（无冲突）。

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | V04-02 关窗后台驻留接进 main | 完成 | `84dc82e8` `73dcee75` | `tests/app-lifecycle.test.ts`（44 例，真实 WindowManager + 替身）；`tests/background-residency-wiring-host.test.ts`（真实 Electron，2/2） |
| 2 | 生命周期从 main.ts 拆到 `electron/app-lifecycle.ts` | 完成 | `84dc82e8` | 同上；7 处变异逐一使测试失败 |
| 3 | 关停中再次 quit 不再让 Electron 抢先结束进程 | 完成 | `73dcee75` | `app-lifecycle.test.ts`“a second app.quit …” |
| 4 | V09-P1-2 关停预算 | 外壳半已满足 W01 合同（8000 ≥ 7000 ms）；W01 的 `dde2f603` 未进 INT | `b5d5450e`（作废的 it.fails 版）、`e7396135` | `tests/host-shutdown-budget.test.ts`（2 例 + 1 todo） |
| 5 | W12 #35：Host 编译缓存放 userData | 完成 | `e029e4d4` `2d9ca210` | `host-readiness.test.ts` 2 例；真实 Electron 接线测试断言 Host 拿到 `<userData>/host-compile-cache`；打包冒烟加金丝雀（未跑打包） |
| 6 | 窗口尺寸按客户区（Tauri inner size） | 完成 | `056aedca` | `tests/window-content-size.test.ts`（真实 Electron）；去掉修正后客户区少 32 px，测试失败 |
| 7 | main.ts 拆分：Host 代办请求 → `electron/shell-requests.ts` | 完成 | `4efc8f58` | `tests/shell-requests.test.ts` 15 例，8 处变异全被抓；真实 Electron `browser-label-taken-host` 通过 |
| 8 | main.ts 拆分：渲染进程 IPC → `electron/renderer-ipc.ts` | 完成 | `2722eb3f` | `tests/renderer-ipc.test.ts` 10 例，8 处变异全被抓；真实 Electron `renderer-ipc-host`、`inbound-json-renderer` 通过 |
| 9 | W28 notices 补丁 | 无需应用 | — | 补丁内容与 `eaf234b5` 已入库的改动逐字一致 |
| 10 | 遗留三项（android osName / Windows io 文案委托 / S01 F7 helper） | 前提未满足，未动 | — | 见下“遗留项” |
| 11 | main.ts 拆分：localStorage 迁移装配 → `electron/webview-migration-wiring.ts` | 完成 | `8660cff6` | 真实 Electron `webview-migration-host` 2/2、`webview-migration-gate` 18/18 |
| 12 | W07-1450：Windows io 文案按系统语言（Rust FormatMessageW） | 完成（Windows 实机未验） | `68aa97e8` | `tests/io-error-text.test.ts` 13 例 + 1 例仅 Windows；去掉系统文案后失败 |
| 13 | 合 INT `2be7ed80` | 无冲突 | `0719d6fd` | — |
| 14 | INT 带来的红：`node-modules-closure` 报 `@smithy/types`（W08 `s3_http.ts` 的 `import type`，只靠 `@aws-sdk/client-s3` 传递才解析得到） | 声明到 dependencies（`^4.19.0`，与 AWS 包同范围，打包闭包不变）；前端包清单按新 lock 重新生成（469 个包不变，只换哈希） | `ceb1bb51` | `node-modules-closure` 4/4、`third-party-notices` 10/10，另 5 个读 package.json 的用例文件 44/44 |

main.ts：841 → 547 行（生命周期、Host 代办请求、渲染进程 IPC、localStorage 迁移装配四块拆出，行为不变）。

## 与 Rust 对照：主窗口关闭（lib.rs:1714-1783）与退出（3249-3285）

| Rust | Electron（W23 `BackgroundResidency` + W06 `app-lifecycle.ts`） | 用例 |
|---|---|---|
| 三个条件任一成立即驻留：`quick_assistant.background_enabled == "true"`；自动化后台开关 + 有启用的自动化；Super 会话启用 | 同；Host 入口 `agentAutomation.backgroundResidency()` 优先，缺席时读同样的设置 / 自动化列表 | 每个条件 × 三平台；非 Rust 取值（`"TRUE"`、`"yes"`、未启用的自动化）不驻留 |
| `prevent_close` + `hide` | 先隐藏再问 Host（查询是异步的），驻留则保持隐藏 | 同上 |
| 提示文案：原因顺序 自动化 → Super → 快速助手，`；` 连接、`。` 结尾 | 同 | 多原因顺序 |
| `notifications_disabled`（“从不”档）时不提示 | 同 | never 档 |
| 每次驻留关窗都提示一次 | 每次关窗一条；连点两次关闭只出一条 | double-click / repeat close |
| 已在退出（`automation_app_is_exiting`）时不拦截 | `markExiting` 之后不拦截；挂起中的决定作废 | 进程 exit 发生在决定之前 |
| 无条件：macOS 标记退出 + `app.exit(0)`；Windows/Linux 照常关窗，末窗关闭即退出 | macOS `markExiting` + 隐藏 + 有序退出；Windows/Linux 销毁窗口，`window-all-closed` → 有序退出 | none × 三平台 |
| `ExitRequested`：标记退出，同步等插件关停、后台任务、flush 日志 | `before-quit` 一律 preventDefault 并走有序退出（先关 Host 再 exit）；关停中再次 quit 也被拦下 | app.quit；second app.quit |
| `Reopen`（macOS Dock）：show + set_focus + 激活 | `activate` → `showFromReopen` | macOS Reopen |
| single-instance：show + unminimize + set_focus | `second-instance` → `showFromSecondInstance`（含查询未决时） | second-instance ×2 |
| — | powerMonitor `shutdown`（macOS/Linux）、Windows `session-end`：不拦截，走有序退出 | 对应 3 例 |

差异（不改）：Electron 先隐藏后决定，Host 不可用 / 查询超时（5 s）时按“无条件”处理并记日志——Rust 同步读库，没有这种失败模式。

## 与 Rust 对照：窗口 / 托盘 / 全局快捷键 / 深链 / 单实例 / 菜单

| 项 | Rust（src-tauri） | Electron | 结论 |
|---|---|---|---|
| 窗口尺寸 | `inner_size(width, height)`、`inner_size_constraints(min/max)`（tauri-runtime-wry-2.11.4 lib.rs:932、957-972） | 原来按外框尺寸建窗；带框窗口客户区少一个标题栏 | 已修（`056aedca`，`useContentSize`）；Linux 独立 browser-content 窗口（dstu-browser window.rs:523）一并修 |
| Linux 主窗口最小客户区兜底 | `enforce_linux_main_window_min_logical_size`（lib.rs:407-447，tao 在 X11 HiDPI 下按物理像素处理的绕行） | Chromium 全程用 DIP，且最小尺寸现在约束客户区 | 不需要移植 |
| macOS 启动显示并聚焦主窗口 | lib.rs:1810-1822（UI 自动化开发模式不抢焦点） | `visible`/`focus` 默认 true → `show()` | 一致（开发自动化分支不移植） |
| 窗口销毁清理笔记编辑租约 | `on_window_event(Destroyed)` → `cleanup_note_editor_leases` | `WindowManager` 发 `window` 生命周期 `destroyed`，notes 插件 `lease-lifecycle.ts:75` 处理 | 一致 |
| 全局快捷键 | 只在 `Pressed` 时调 `quick_assistant::toggle` | `globalShortcut` 回调发 `global-shortcut://triggered`（`state: 'Pressed'`），memory 插件只认 Pressed | 一致 |
| 单实例 | 最先注册；`TAURI_LAB_INSTANCE_ID` 时跳过 | `requestSingleInstanceLock` 在 `shell/bootstrap.ts:95`；测试用 `DS_ELECTRON_USER_DATA` 隔离锁 | 一致 |
| 菜单 | 仅 macOS：应用/File/Edit/View/Window/Help，7 个自定义项 `emit(menu://*, ())` | `shell/menu.ts` 同结构同快捷键；Windows/Linux `setApplicationMenu(null)` | 一致 |
| 托盘 / 深链 | 无（Cargo.toml、tauri.conf.json、capabilities 都没有） | 无 | 无需实现 |

## 遗留项（任务 5）

- `preload/bridge.ts:44` android 分支：W23 的 `bridge-messages.ts:221` `osName` 仍是 `'macos' | 'windows' | 'linux'`，前提未满足。
- `shell/errors.ts:72-92` Windows io 文案：`host/platform/paths/io-error.ts` 只有 POSIX errno 表，没有 Windows `os error N` 文案，
  语义也不同（它给 Host 的错误分类，外壳这里要逐字复刻 Rust `io::Error` 的 Display），不委托。
- S01 F7 `maybeRunHelper`：S01 的模块没有导出它，bootstrap 不接（不改 S01 文件）。

## 其他

- **共享 `node_modules` 的隐藏 lock 被写过一次，已复原**：在工作树里跑 `npm install --package-lock-only --offline` 会顺着软链把
  `deep-student/node_modules/.package-lock.json`（npm 对已装树的缓存）按本工作树的 lock 重写——10 个版本与磁盘不符、1 个不存在、
  11 个已装的包（`electron-updater`、`js-tiktoken` 等）丢失。已按根工程 `package-lock.json` 只取磁盘上真实存在的包重建：1575 条，
  版本全部与磁盘一致、磁盘上每个包都在列；`npm ls` 恢复正确。其他文件没被写。以后改 lock 一律在临时目录里做：拷 `package.json`、
  `package-lock.json`、`.npmrc` 到 `mktemp -d`，在那里跑 `npm install --package-lock-only --offline --ignore-scripts`，再把 lock
  拷回（本轮验证过：结果与原地跑逐字节相同，共享缓存不动）。之后照旧跑 `licenses:frontend-packages`（走 `bin/heavy`）。
- `@smithy/node-http-handler` 已无任何 import（W08 `64d9b56d` 换成了自写 handler），但仍随 `@aws-sdk/client-s3` 进打包闭包；
  根依赖里这条可以删，本轮不再动 lock。
- `npm run licenses:check` 本来就红（与本轮无关）：`legal/THIRD_PARTY_NOTICES.txt` 还是基线快照 `21c9d808` 的，记录的 lock 哈希
  `c42a02ff…` 与 HEAD 前的 `1ebe0e92…` 也不符；pdfium 许可证源文件不在快照里，`licenses:generate` 在本机重新生成不了完整内容。
- W07-1450 交给 W06 的两条：`errors.ts:57-70` 已改（`68aa97e8`：Windows 上取 `FormatMessageW(FROM_SYSTEM | IGNORE_INSERTS, 0)`，
  与 Rust std `error_string` 相同，去掉结尾空白；英文表只在拿不到系统文案时用）；`writer-probe.ts:96-127`（V10 P2-1）第八轮
  `7c4a519c` 已修并在 INT。
- W17-1358：SEC-E06 需要 W06 的 `ds-plugin-sandbox:` 协议（`src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md` §2、§6，估 2 人日：协议、
  CSP、子 frame 无 preload 的 E2E、主窗口 CSP 收紧）。不在本轮任务里，没开工，等主控排期。
- W28 交来的 `W06-third-party-notices-host-target.patch` 与 `eaf234b5` 已入库的内容一致，不重复提交。
- 遗留进程：pid 75892（`Electron … wt/W06/electron/main.ts`，父进程已是 launchd，本轮开工前约 1 小时已在运行），是上一任跑
  `browser-label-taken-host` 时中断留下的；测试本身在 `afterAll` 里 SIGKILL 子进程，只有 vitest 被强杀时才会漏掉。按规则不杀，交主控处理。

## V04-02：关窗后台驻留接线

- 上一任的补丁（`.reports/W06-handoffs/W06-background-residency-wiring.patch`）与 W23 交来的三份材料逐字一致；`git apply --3way`
  只在 import 行与 INT 新增的 `BackendEvent` 冲突，手工合并。
- 接线不再散在 main.ts：`electron/app-lifecycle.ts` 的 `createAppLifecycle({ platform, app, powerMonitor, invokeHost, shutdownHost,
  allWindows, log })` 负责有序退出（原 `orderedShutdown`）、驻留（W23 `BackgroundResidency`）、`second-instance`、`before-quit`、
  `window-all-closed`；main 只在 `afterCreate` 调 `lifecycle.windowCreated(win)`、在原 `wireAppLifecycle` 的位置调 `lifecycle.install()`。
- 测试：`app-lifecycle.test.ts` 用 `vi.mock('electron')` 换 BrowserWindow，跑真实 WindowManager（它自己的 close 监听、`destroying`、
  页面监听 close-requested）+ 真实 BackgroundResidency + 真实 queryResidencyState。反向验证：分别去掉 attachMainWindow、quit 里的
  markExiting、residency.install、second-instance、before-quit、window-all-closed、“先关 Host 再 exit”，各自有用例失败（26/2/4/3/2/4/10 例）。
- 替身 app 的 `quit()` 按 Electron 文档：没被 preventDefault 时关窗后直接结束、不发 `window-all-closed`。据此发现：有序退出进行中再按一次
  Cmd+Q，原 `if (quitting) return` 不拦截，Electron 自己结束进程、打断 Host 关停（`73dcee75` 修正；Rust 在 ExitRequested 里同步等待）。
- Host 入口切换：W02 的 `agentAutomation.backgroundResidency()` + `meta.remote` 上线后，`queryResidencyState` 先问入口、得到合法四布尔值
  就不再读设置——main 不用改（用例“once W02's Host entry answers …”）。唯一的后续点：内核 `plugin:host|call` 切到 `require` caller
  模式（`host/kernel/runtime.ts:320`）后，main 不带 `caller` 的调用会被拒，退回降级路径（行为仍对，但每次关窗记一行降级日志）；
  届时 W23 在 `background-residency.ts:166` 的参数里加 `caller: 'dstu.agent-orchestration'`。

## V09-P1-2：Host 关停预算（外壳半）

W01 的接口文档（`.reports/W01-handoffs/backgroundTasks-interface.md`，14:34）和实现（`assault/W01-kernel` `65436d49`、`dde2f603`，
还不在 INT）走的是“Host 自己封顶”的路线：shutdown 先 abort 后台任务、只再等 1000 ms；在途命令 ≤ 2000 ms，插件 dispose 每个
≤ 1500 ms、整段 ≤ 3000 ms，加 `exitSoon` 500 ms，合计 ≤ 5500 ms；要求外壳预算 ≥ 7000 ms。外壳现在是 8000 ms
（`shell/host.ts` `HOST_SHUTDOWN_BUDGET_MS`，main 调 `shutdown()` 不传超时），已满足，代码不用改。

- 本轮前半段按“外壳从 Host 得知等待”的思路写过 4 个 `it.fails`（`shutdown-progress` 消息、动态期限、15 s 上限）和一份外壳原型补丁；
  W01 定下的接口不发进度消息，这套设计作废：`it.fails` 换成按 W01 合同的用例，原型补丁已从 `.reports/W06-handoffs/` 删除。
- `tests/host-shutdown-budget.test.ts`：预算 ≥ 5500 + 1500 ms；Host 用满 7000 ms 后退出不被强杀；`it.todo` 等 `dde2f603` 进 INT 后
  改为直接引用 `COMMAND_CLOSE_TIMEOUT_MS` / `DISPOSE_PHASE_BUDGET_MS`。反向：预算改 5000 ms 两例失败，默认超时改 6000 ms 一例失败。
- 现有 `host-readiness.test.ts`“ordered shutdown leaves the Host 2s … after its full background-task wait”按实际 background-tasks
  的等待计算，W01 的 1000 ms 宽限进来后照样成立。
- 台账状态：外壳半已满足 W01 的要求；关闭要等 `dde2f603` 进 INT（Host 半是 W01 的）。

# W06 第八轮进度（沙箱 helper 拦截 / 渲染进程消息校验 / 原生事件标记 / 应用图标 / §16.7 实测 / W23 交接 / 审计 V04 V08 V09 V10）

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | `--deep-student-shell-sandbox-helper` 在单实例锁之前拦截 | 完成（拒绝；原生 helper 属 F7） | `058fd8f3` `3077bb54` | `tests/bootstrap.test.ts`；`tests/sandbox-helper-host.test.ts`（真实 Electron：退出 126、无主窗口、不建 userData） |
| 2 | 渲染进程消息先过 `checkRendererMessage`（W23） | 完成 | `507d278a` | `tests/renderer-ipc-host.test.ts`（真实 ipcMain 投递 10 种畸形消息） |
| 3 | browser-content 事件用 `nativeBrowserContentEvent`（W23，SEC-E05 外壳侧） | 完成 | `cb6cf0a3` | `tests/browser-surface-host.test.ts`（含 Agent 私网拦截的 `navigation-blocked` 事件带 `native: true`） |
| 4 | 应用图标 | 完成 | `19e9812a` | `tests/app-icons.test.ts`；mac 打包后 `CFBundleIconFile` 与入库 icns 逐字节一致，冒烟 16/16 |
| 5 | Windows exe 图标与版本信息 | 完成（实机未验） | `19e9812a` | `tests/win-asar-integrity.test.ts`：resedit 写入后完整性资源与 fuses 仍通过 |
| 6 | Linux 窗口默认图标 | 完成（实机未验） | `ce6074f7` | `tests/app-icons.test.ts` |
| 7 | sqlite-busy 预编译不进包 / darwin-arm64 进 `PLATFORMS` | 第七轮已做，复核 | `fc8f2ced` | `packaging.test.ts` 不进包清单；`package.mjs` 打包后核对 |
| 8 | §16.7 社区 Host 半隔离 | 方案 + 实测，未实现 | — | 见下 |
| 9 | W08 / W14 交接：net-policy 纯函数移到叶子模块 | 第七轮 `6defbb76` 已做（`ip.ts`） | — | 该提交在 `int/stage-1245` 中，INT 快进后可见 |
| 10 | W23：main 把 `app.getPath('userData')` 交给 ShellRuntime 与全局 fs 作用域；Windows 日志目录用 bundle identifier | 完成 | `b93c6d75` | `tests/user-data-scope-host.test.ts`（真实 main.ts）；`main-log` / `os-dirs` 单测；冒烟新增日志目录核对 |
| 11 | 拖放目录按 Tauri 递归加入 fs 作用域 | 完成 | `9321f80d` | `tests/user-data-scope-host.test.ts`（嵌套文件放行、未拖放的对照被拒） |
| 12 | W23：`image` 插件 from_path / from_bytes / JsImage 与本 Tauri 构建一致（未开 `image-png`/`image-ico`） | 完成 | `c0a79457` | `tests/images.test.ts` |
| 13 | browser-content 不覆盖同名应用窗口 | 完成（RF-W06-browser-content-label-taken，proposed） | `263ccf0a` | `tests/browser-label-taken-host.test.ts` |
| 14 | V04-11 后端 Sentry 启动读授权；不随包 `@sentry/node` | 完成（RF-W06-backend-sentry-sdk-not-shipped，proposed） | `dd4f4447` `d9594ad5` | `tests/shell-commands.test.ts` |
| 15 | V10 P2-5 notices 测试按本机平台（W28 handoff）+ 类型补 `libc` | 完成 | `eaf234b5` `cb121cca` | `tests/third-party-notices.test.ts` |
| 16 | V09 P1-2（外壳半）：Host 关停预算 8 s，大于 Host 内部 5 s 后台任务等待 | 完成 | `e5728fbd` | `tests/host-readiness.test.ts`（用真实 `createBackgroundTasks` 量等待时长） |
| 17 | V08-10（外壳半）：事件载荷 stringify 失败时记日志、不投递，不在 MessagePort 监听里抛错 | 完成 | `f8a5ad4d` | `tests/event-payload-host.test.ts`（真实 main.ts；去掉修复时主进程报 uncaught exception 并卡在错误框） |
| 18 | V10 P2-1：WebView2 写者探针在非 ASCII 用户目录下漏报 | 完成（Windows 实机未验） | `7c4a519c` | `storage-migration/tests/writer-probe.test.ts` |
| 19 | V04-02 后台驻留接线（W23 模块） | 补丁已备、未提交（依赖未进 INT） | — | 见下 |
| 20 | W05 交接：`browser/src/policy.ts` 的 IP 判定改从 `net-policy/ip.ts` 转出 | 完成 | `faff7dfa` | browser `policy` / `window-policy` / `browser-service` 测试；portability `--check` |

## 沙箱 helper 参数（S01 交接 7）

Rust `main.rs:5` 在 Windows 上先于一切处理 `--deep-student-shell-sandbox-helper`。Electron 入口原先不认识它：Host 以该参数
重新启动应用自身时，子进程抢不到单实例锁、exit 0，还把主窗口拉到前台（S01 报告的 fail-open 根因）。现在
`shell/bootstrap.ts` 在 `requestSingleInstanceLock` 之前识别（打包版 argv[1]，开发版 argv[2]，与 Host 的
`isWindowsShellHelperInvocation` 判定位置相同），写 stderr 后 `app.exit(126)`，不建窗口、不建 userData。Windows 上的说明是
"需要 F7 原生运行时"；macOS / Linux 也拒绝（RF-W06-shell-sandbox-helper-flag-all-platforms，Rust 在这两个平台会把它当普通参数
启动应用）。接上原生 helper 时，在同一拦截点调用 `maybeRunHelper(shellSandboxHelperArgv(...), runtime)`（交接 S01 / F7）。

## 渲染进程消息与原生事件标记

- `wireRendererIpc`：`IPC_CHANNEL_TO_MAIN` 收到的值一律当不可信输入；invoke 交给已有的 `checkInvokeMessage` 路径，其余消息先过
  `checkRendererMessage(value, MAX_REMOTE_INVOKE_PAYLOAD)`，不合法时记一行日志并忽略（原先 `null` 会让监听器抛 TypeError）。
- `sendBrowserContentEvent` 改用 `nativeBrowserContentEvent`：消息级 `native: true` 只有 main 能加，Host（W01 `2919cc58`）与
  browser 插件（W05）据此只信任原生事件。

## userData 作用域（安全缺口）

修复前 main 没把 `app.getPath('userData')` 交给 ShellRuntime 与全局 fs 作用域：W23 的 deny-webview-data
（`$ELECTRON_USERDATA/**`）按 runtime 自己推导的目录展开，与真实 userData 不是同一个目录，页面经 `plugin:fs` 能读到
Electron 的 Cookies / Local Storage。现在两处都用同一个 userData；测试里把 userData 放到推导不到的位置，少传任何一处都会失败。

## 后台驻留接线（V04-02）

W23 的 `.reports/W23-handoffs/W06-background-residency.patch` 在一次性分支（W06 tip + `assault/W23-shell-acl`）上应用：
`background-residency-wiring-host.test.ts` 2/2、`background-residency.test.ts` 30/30 通过；还原 `main.ts` 后接线测试 2/2 失败。
依赖 W23 `772be8d0`、`48c21aa6`（以及 W01 `2919cc58`）都还没进 INT（`fe5feb68`），W06 分支上单独提交会编译失败，所以只把
`main.ts` 改动和两个测试文件存成 `.reports/W06-handoffs/W06-background-residency-wiring.patch`（已核对能直接应用到 W06 tip）。
W23 的模块进 INT 后由集成方或下一轮 W06 应用；W02 还要提供 `backgroundResidency()` 汇总与 remote meta。

## 应用图标

`src-tauri/icons/` 从未入库（deep-student 历史与 `.transfer/ds-main-ae4efdf9e.tar.zst` 都没有）：`npm run icons`
（`tauri icon public/app-icon.png`）与 `scripts/build_*.sh` 在构建时由 `public/app-icon.png`（1024×1024）生成。
本机没有 tauri-cli 原生绑定，electron-builder 自带的转换要联网下载工具集，所以按 tauri-cli 的输出规格写了
`electron/scripts/generate-icons.mjs`（sharp Lanczos3），产物入库到 `electron/resources/icons/`：

- `icon.icns`：iconset 十档 PNG（`iconutil` 可往返；不写 `icp6`，iconutil 把它当 48 像素槽位），1024 条目即源图原字节；
- `icon.ico`：32/16/24/48/64 为 32 位 BMP、256 为 PNG（tauri-cli 的顺序）；
- `png/{32,128,256,512}x….png`：Tauri `bundle.icon` 安装到 hicolor 的四档。

electron-builder 对 `.icns`、≥256 的 `.ico`、`NxN.png` 目录原样采用，不调转换工具（测试直接调用它的 `convertIcon` 核对）。
Windows：`signAndEditExecutable: false` 会连图标与版本信息一起跳过，exe 一直是 Electron 默认图标、版本信息为 Electron；
改为 `signExecutable: false`（只跳过签名），electron-builder 26 用纯 JS 的 resedit 写资源，不需要 wine 或下载。写入发生在
完整性资源与 fuses 之后，测试按同一顺序核对二者仍通过 `verify-fuses --win`。Linux 窗口：Tauri 给每个桌面窗口设
`bundle.icon` 第一张 PNG，main 在 Linux 上对所有 `BrowserWindow` 调 `setIcon`（该 PNG 是唯一进 app.asar 的图标文件）。
macOS 26 会给非 Icon Composer 图标加玻璃效果，Tauri 版同样如此。

## §16.7 社区 Host 半隔离：实测与方案

实测（Electron 45.2.1 / Node 24.22.1，macOS arm64，一次性探针，未入库）：

| 项 | 结果 |
|---|---|
| `utilityProcess.fork` 显式传 `env` | 子进程只看到给定变量 + macOS 注入的 2 个（`MACH_PORT_RENDEZVOUS_PEER_VALDATION`、`__CF_USER_TEXT_ENCODING`）：环境白名单可行 |
| `execArgv: ['--permission' 或 '--experimental-permission', '--allow-fs-read=<插件目录>/*']` | 参数出现在 `process.execArgv`，但不生效：`process.permission` 不存在，子进程照样读 `/etc/hosts`、写文件、执行 `/bin/echo` |
| 子进程内存（最小 ESM 子进程） | RSS 65 MB（`app.getAppMetrics` 工作集同为 65 MB），高于 API.md 估计的 30–40 MB |
| 隐藏的沙箱渲染进程（`sandbox: true`、独立 partition） | `getAppMetrics().sandboxed === true`；无 `require` / `process`；partition 的 `webRequest` 可取消全部网络；`file://` 被拒；工作集 82 MB |

结论：`utilityProcess` 只给崩溃、内存与环境变量隔离，**不限制文件、网络与子进程**——Electron 不为启用 Node 的
utilityProcess 提供 OS 沙箱，Node 权限模型在其中也不生效。API.md §16.7 第 1 项"挡住恶意插件靠进程隔离"在这一形态下不成立。

可选方案（需主代理 / W01 决定）：

- **A（API.md 现方案）**：每插件一个 utilityProcess。只能防误用和单插件崩溃拖垮 Host，不是安全边界。
- **B（建议）**：社区 Host 半必须是可移植代码（不用 Node 内建模块，与 §16.6 可移植引导、移动端方向一致），跑在 Chromium 沙箱
  渲染进程里：每插件一个隐藏 `BrowserWindow`（`sandbox: true`、无 Node 预加载、partition `plugin:<id>` 上取消全部网络，HTTP 只经
  Host 的 `ctx.http` 代理与 net-policy），代码经只映射该插件目录的协议加载。main 建 `MessageChannelMain`，一端
  `postMessage` 给 Host utilityProcess，一端 `webContents.postMessage` 给沙箱进程的最小预加载再转进页面。崩溃走
  `render-process-gone` → Host 降级；Host 重启或卸载插件即销毁窗口。代价约 82 MB/插件；多个插件共用一个沙箱进程可省内存，
  但插件之间不再隔离。

B 中 W06 的工作：沙箱宿主（拉起 / 销毁、partition 断网、插件目录协议与 CSP）、与 Host 的端口转交消息
（`plugin-sandbox-spawn {requestId, pluginId, entry}` → `plugin-sandbox-port` + port、`plugin-sandbox-exit`、`plugin-sandbox-kill`）、
生命周期与真实 Electron 测试，约 3 人日。依赖 W01 先定子运行时形态（A 或 B）和服务代理协议，所以本轮不实现。

## 交接事项（第八轮）

- **W23**：`electron/shell/runtime.ts:186-190` `encodeBody` 的 `JSON.stringify` 对循环引用 / BigInt 抛错，调用点 `:430` 在
  `HostSupervisor` 的 MessagePort 监听里同步执行（`host.ts:236`）：主进程报 uncaught exception（弹错误框），页面的 invoke 永不结束。
  与 `f8a5ad4d` 修的事件路径同类（代码核对，未写复现）。建议 `replyTo` 里捕获后以错误回复。
- **W23**：`W23-PROGRESS.md` 的 image 一行改为“与本 Tauri 构建一致”（`c0a79457`）。
- **W23 + W14**：V06-L7。`bridge-messages.ts:221` 的 `osName` 加 `'android' | 'ios'`；之后 W06 在 `preload/bridge.ts:44` 按
  tauri-2.11.5 `scripts/core.js:16` 加 `|| osName === 'android'`；W14 在 `mobile/src/main.ts:55` 传真实平台。
- **W23 / 集成**：V04-02 接线补丁 `.reports/W06-handoffs/W06-background-residency-wiring.patch`（见上）。
- **W02**：`backgroundResidency()` 汇总与 remote meta；`markAutomationAppExiting`（V09 P1-5）。
- **W07**（回应 W07-1316 “Windows io 文案由谁导出”）：表放在 Host 可移植侧——`host/platform/paths/io-error.ts` 的
  `ioMessageFor` 改收平台（`'darwin' | 'linux' | 'win32'`），并入 `electron/shell/errors.ts:57-70` 的 Windows 表（electron 可以
  导入 host/platform，反向不行）；进 INT 后 W06 把 `errors.ts:72-92` 的 `formatIoError` 改为委托它。另：`io-error.ts:17`、`:19`
  的 EBUSY / EXDEV 是 glibc 文案，macOS 上是 `Resource busy` / `Cross-device link`（见 `errors.ts:37`、`:40`、`:52-55`）。
- **W01**：V09 P1-2 的 Host 半（`host/platform/diagnostics/background-tasks.ts:27-48` 任务归属与 abort、等待上限）、P1-1
  （`host/kernel/commands.ts:305-312` 无上限等待）；V08-10 的 Host 半（`commands.ts:446,463`、`events.ts:125-127` 生产环境的原型检查）。
- **W05**：`host/plugins/browser/src/surface-host.ts:184` 只看 `source.webview`，应再要求原生标记（`native === true`，W01 `2919cc58`）；
  `surface-host.ts:6` 改从 `net-policy/ip.ts` 导入后，browser 不再经 `net-policy/index.ts` 触达 `node:dns`（`policy.ts` 已改，`faff7dfa`）。
- **W14**：`host/platform/http/pinned-policy.ts:7` 改从 `../net-policy/ip.ts` 导入，portability 测试改为期望 `[]`。
  **W21 / W02 / W10**：`mcp/src/{auth-token,endpoint,oauth-manager}.ts`、`agent-skills/src/tools/mcp-propose-executor.ts:11`、
  `sync-providers/src/config.ts:1` 的 `isLoopbackHost` 同样改从 `ip.ts` 导入（不拉进 `node:dns`）。
- **S01 / F7**：原生 helper 接到 `shell/bootstrap.ts` 的拦截点，调用 `shell-sandbox-windows.ts:719` `maybeRunHelper`。
- **主代理**：RF-W06-backend-sentry-sdk-not-shipped 是否补 `@sentry/node` 与构建期 DSN；§16.7 选 A / B；
  `.github/workflows/ci.yml:138` 前端 vitest 未跑 `examples/vitest.config.ts`（W27 #6，`.github` 无主）；
  Windows exe 图标、Linux 窗口图标、WebView2 探针（中文用户名）需实机核对；正式签名。

# W06 第七轮进度（安全收尾 SEC-E02/E08/E09/E10/T03 / net-policy 拆分 / 打包修复）

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | sqlite-busy darwin-arm64 测试预编译 | 完成 | `fc8f2ced` | 可复现构建（@rpath、minos 12.0）；预编译/源码不进包，打包后核对 |
| 2 | `@deepseek-ai/schemastery` 直接依赖 | 第五轮已做，复核 | `4609b983` | package.json 与 lock 根依赖均为 3.18.5，与 node_modules 一致 |
| 3 | host-failure-log 退出码 0/1 | 第五轮 `e4b2692c` 已修，复核 | — | 其他 lane 重任务并发下连跑 15/15；boot-diagnostics 同条件 6/6 |
| 4 | node-modules-closure 把 emitting/subscribing 当包 | 完成 | `746bc9db` | AST 扫描 + require 绑定解析，删掉按名字排除 |
| 5 | `worker.mjs` 从 asar 运行 | 完成 | `ad12fc49` | `tests/wasm-worker-asar-host.test.ts`（真实 utilityProcess，同步 + 异步两条路径） |
| 6 | SEC-E02 打包版忽略开发环境变量 | 完成 | `442a3464` | `tests/launch-env.test.ts`；冒烟 3 项金丝雀 |
| 7 | SEC-E10 拖放路径校验 | 完成 | `f42a3a02` | `tests/drag-drop.test.ts` |
| 8 | SEC-E09 / SEC-T03 / SEC-E08 | 完成 | `7adf7be5` | `tests/app-hardening.test.ts`、`tests/packaging.test.ts`、`tests/win-asar-integrity.test.ts`；`verify-fuses.mjs` 13/13 |
| 9 | net-policy 纯 IP 判定拆成可移植模块 | 完成（pinned-policy 切换交接 W14） | `6defbb76` | `host/platform/net-policy/tests/portability.test.ts` |
| 10 | 打包版 Host 启动即退出（缺 plugin-manifest schema） | 完成 | `5ebb22b7` | 新守护：进包代码的相对 import 必须解析到进包文件；冒烟 16/16 |
| 11 | 冒烟中途失败时保留现场 | 完成 | `97e4160a` | — |
| 12 | `shell-restart-host.test.ts:84` | 保留原断言，另加更强断言 | `9e257d30` | 见下 |

## SEC-E09：fuses 按平台

- 翻转从 electron-builder 的 `electronFuses` 移到 afterPack（`context.packager.addElectronFuses`），按目标平台取
  `expectedFuses(platform, { signed })`：
  - `GrantFileProtocolExtraPrivileges` 关：页面走 `tauri://`，不加载 `file://`（`file-ops.ts` 只解析 file:// 字符串）。
  - `EnableCookieEncryption`：win32 / linux 开；macOS 只在正式签名时开。macOS 的 cookie 密钥存在钥匙串里，访问权限绑定
    代码签名，ad-hoc 签名每次更新都会变，用户每次升级都会被钥匙串弹窗询问。Tauri 的 WKWebView / WebKitGTK 本来不加密
    cookie，WebView2 用 DPAPI——所以 Windows 上开启是为了不比 Tauri 版差。
- `verify-fuses.mjs` 从 codesign 读出签名方式，再与 `expectedFuses('darwin', …)` 逐项比对。

## SEC-T03：macOS 签名 / hardened runtime / 公证

- 默认（无证书）：ad-hoc 签名（`identity: '-'`）+ hardened runtime，与 Tauri `signingIdentity: "-"`、
  `hardenedRuntime: true` 一致；entitlements = Tauri `Entitlements.plist`（audio-input、disable-library-validation）+
  allow-jit（V8 需要）。`timestamp: 'none'`：osx-sign 默认 `--timestamp` 要联网。Info.plist 麦克风用途说明与 Tauri 相同。
- 正式签名：设置 `CSC_LINK` 或 `CSC_NAME` 即切换为 Developer ID + hardened runtime + 公证，entitlements 去掉
  disable-library-validation（原生模块与主程序同一团队签名）。缺公证凭据时 `package.mjs` 直接失败，避免产出签了名却没公证、
  被 Gatekeeper 拦下的包。
- 实测（ad-hoc 产物）：签名有效，主程序与 4 个 helper 都带 runtime 标志，entitlements 与 `electron/signing/` 一致；
  `DYLD_INSERT_LIBRARIES` 探针 dylib 能注入对照程序、注入不了应用；koffi、better-sqlite3、FSRS WASM、worker 都正常。
- 发布清单（需要真证书，本轮无法验证）：
  1. 设置 `CSC_LINK`（+ `CSC_KEY_PASSWORD`）或 `CSC_NAME`；公证凭据三选一：`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
     `APPLE_TEAM_ID`、`APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`、`APPLE_KEYCHAIN_PROFILE`。
  2. `node electron/scripts/package.mjs --mac`，再 `node electron/scripts/verify-fuses.mjs --app <产物>`：各项应为
     “release signed”模式、`EnableCookieEncryption` 开、entitlements 等于 `entitlements.mac.plist`。
  3. `spctl -a -vv <app>` 与 `xcrun stapler validate <app>`；首次启动麦克风授权弹窗文字正确。
  4. 升级安装后不弹钥匙串（正式签名身份不变）。

## SEC-E08：Windows asar 完整性

- 审查前提有误：electron-builder 在 `beforeCopyExtraFiles` 里无条件写 exe 资源 `INTEGRITY/ELECTRONASAR`，与
  `signAndEditExecutable` 无关；`EnableEmbeddedAsarIntegrityValidation` 在 win32 上也开。配置里注明了这一点。
- 本机没有 win32 版 Electron，所以 `verify-fuses.mjs --win|--linux --unpacked <dir>` 做静态校验（fuses、布局、exe 内完整性
  资源等于 asar 头部 SHA256、原生模块解包），`tests/win-asar-integrity.test.ts` 用合成 PE + electron-builder 自己的
  `addWinAsarIntegrity` / `computeData` 跑完整流程，篡改头部、缺资源、未翻转 fuses 都会失败。Linux 没有 asar 完整性。
- 真实 Windows 产物上“改 app.asar 后拒绝启动”需在 Windows 机器上手工验证（交接）。

## net-policy 拆分

`ip.ts`（纯 IP 判定，无 Node 依赖）← `index.ts` 原样再导出并保留 `isSafeRemoteUrl`（`node:dns`）与
`fetchBinaryWithCache`；`navigation.ts` 改从 `ip.ts` 导入，现在可移植。`pinned-policy.ts` 在 W14 路径下，仍从 `index.ts`
导入，所以 W14 的棘轮测试照旧成立；W14 改一行 import 后它即可移植，棘轮测试改为 `toEqual([])`。

## 打包版 Host 启动失败

W01 `0efd763b` 起 `host/kernel/manifest.ts`、`plugin-id.ts` 用 JSON import 读 `contracts/plugin-manifest/v1.schema.json`，
而 `files` 只收 `contracts/ipc`：打包版 Host 启动即 `ERR_MODULE_NOT_FOUND` 退出 1（合入 INT 后的包都有这个问题）。
`packaging.test.ts` 的运行时文件清单是手写的，漏掉了。现在 `node-modules-closure.test.ts` 扫描所有进包的源文件，每个
相对 import 都必须解析到同样进包的文件；这条守护在本轮只报出这两处。

## `shell-restart-host.test.ts:84`

`expect(dataLocalDir.startsWith(homedir() + '/')).toBe(false)` 检查的是测试自己由 `tmpdir()` 拼出的期望值，不是应用的输出；
在 Windows 上 `homedir() + '/'` 永远匹配不上（分隔符是 `\`），这条断言恒真；若改成正确的 home 前缀判断，Windows 默认
`%TEMP%` 在用户目录下又会恒假。没有同等强度、又能对真实平台目录成立的替代，所以原断言保留。另加：Host 实际收到的
`DS_SHELL_OS_DIRS` 每一项不等于真实平台目录（dirs-sys 规则按本进程环境推导，子进程继承同一环境），且不在真实的
`<目录>/<identifier>` 之内（按应用目录判定，因为 Windows 的 %TEMP% 本身在 %LOCALAPPDATA% 下）。

## 打包冒烟（mac arm64 `--dir`，ad-hoc + hardened runtime）

冒烟 16/16（42/42 插件，含 SEC-E02 三项），`verify-fuses.mjs` 13/13；首窗 728 ms、Host 就绪 1955 ms（单次）。
应用图标仍是 Electron 默认：`src-tauri/icons/` 不在本仓库快照里（配置引用的 `icon.icns/.ico/.png` 都不存在），此前各轮同样如此。

## 交接事项（第七轮）

- **W23**：`electron/main.ts` 的 `sendBrowserContentEvent` 等你的 `nativeBrowserContentEvent` 合入后切换；
  `DS_CAPABILITIES_DIR` 已在 `shell/launch-env.ts` 的 `DEV_ONLY_ENV` 里（变量本身只在你的分支上）。
- **W14**：`host/platform/http/pinned-policy.ts` 改从 `../net-policy/ip.ts` 导入；`host/platform/http/tests/portability.test.ts`
  的期望改为 `[]`。
- **S01 / W14**：`node scripts/portability/scan.mjs --check` 在基线 `56a25cff` 上就失败：
  `host/plugins/agent-skills/src/tools/fetch-chat-executor.ts` 9 条 NEW（node:crypto/dns/fs/http/https/net/path、NodeJS、Buffer），
  baseline 没有该文件的条目。需更新 baseline 或把该文件改为仅桌面。
- **主代理 / 发布**：真实 Developer ID 签名 + 公证（上面的发布清单）；Windows 实机篡改 app.asar 拒绝启动的验证；
  品牌图标文件（`src-tauri/icons/`）。
- **SEC-E02 偏差记录**：打包版仍认 `DS_APP_DATA_DIR`、`DS_ELECTRON_USER_DATA`（等价于 Tauri 以 `$HOME` 推导数据目录；
  冒烟隔离要测的就是发布产物本身），其余开发变量启动时删除并记日志。

# W06 第六轮进度（许可证清单 / image-size / 打包冒烟 / identifier / sqlite-busy 方案）

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | 许可证生成器按“实际进产品的包”收录 | 完成 | `c8b67515` | `tests/third-party-notices.test.ts`（react 等前端库在、vite/typescript/esbuild 等构建工具不在、清单与 lock 不一致即报错） |
| 2 | image-size 1.2.1 → 2.1.0（overrides） | 完成 | `01e0c53f` | `npm audit --omit=dev` 0 漏洞；临时目录装 pptxgenjs 4.0.1 + image-size 2.1.0 生成带图 pptx；media office 4 个文件 57/57 |
| 3 | 新 INT 上 Mac arm64 打包冒烟 | 完成 | — | 冒烟 13/13（42/42 插件）、fuses 9/9；体积与启动见下 |
| 4 | `DS_APP_DATA_DIR` 时把 identifier 交给 Host | 外壳侧完成，Host 侧交接 W01 | `90cd5a6c` | `tests/os-dirs.test.ts` |
| 5 | sqlite-busy 预编译方案 | 方案（交接 W01） | — | 见下；darwin-arm64 临时编译实测、darwin-x64 交叉编译通过 |

## 许可证清单

- 进产品的 npm 包 = Electron 运行时闭包（按 lock 解析，覆盖 darwin/win32/linux × arm64/x64 的可选依赖）∪ 前端产物里
  实际渲染出代码的模块和静态拷贝（`legal/frontend-bundle-packages.json`，由 `npm run licenses:frontend-packages`
  跑一次真实 vite 构建收集；产物里每个文件都必须能归到 Rollup 输出 / public / 已记录的拷贝，否则失败）。
  dev / prod 类型不再参与判断。清单带 lock 哈希，lock 变了不重新生成会直接报错。
- `legal/THIRD_PARTY_NOTICES.txt` 本轮未重新生成：生成器需要 `cargo metadata --offline` 和 pdfium 许可证源文件，
  当前快照里缺；`check-license-compliance.mjs` 仍报 Cargo.lock / package-lock 哈希过期和 pdfium 许可证缺失（第五轮前就有）。

## image-size

pptxgenjs 4.0.1 声明 `image-size ^1.2.1`，但 dist 里没有任何调用（唯一相关代码 `getSizeFromImage` 整段注释掉、
标注“currently unused”，且用的是 `sizeof`），`browser` 字段还把它映射为 `false`；仓库里 host / electron / src
都不直接用 image-size。故用 `overrides.pptxgenjs.image-size = 2.1.0` 只改 lock（`--package-lock-only`，共享
node_modules mtime 未变），顺带去掉 `queue`。注意：共享 node_modules 仍是 1.2.1，下次 `npm ci` 后才生效。

## 打包冒烟（INT `4384a313` + 本轮提交，mac arm64 `--dir`）

| 指标 | 第五轮 | 第六轮 |
|---|---|---|
| bundle（字节） | 465,276,842 | 465,358,428（+81.6 KB） |
| app.asar | 119,694,916 | 119,776,502 |
| app.asar.unpacked | 80,355,056 | 80,355,056 |
| 文件 / 包 | 7,921 / 225 | 7,927 / 225 |
| 首个窗口 / Host ready | 2535 / 3805 ms | 2356 / 3905 ms（单次，约 20 个 agent 并发，属噪声） |

## identifier

外壳在 fork Host 前额外写 `DS_APP_IDENTIFIER`（= `tauri.conf.json` identifier），`DS_SHELL_OS_DIRS` 语义不变。
Host 目前仍取 `basename(appDataDir)`（`host/platform/paths/index.ts:284`），隔离冒烟时 app_log_dir 为
`Library/Logs/data`，`appLocalDataDir` / `appConfigDir` / `appCacheDir` 也落在 `.../data`，与外壳 path 插件的
`.../com.deepstudent.app` 不一致。外壳主日志（`shell/main-log.ts`）暂时保持与 Host 同一规则，避免两份日志分家；
W01 改完 Host 后，外壳主日志同步改用 identifier（W06 下一轮）。

## sqlite-busy 预编译方案

- 结论先行：**sync 墓碑序列的生产路径不需要这个原生模块。** Rust `dstu-sync/.../sync/state.rs:33` 生产连接只设
  `busy_timeout(5s)`，`:237` 用 `TransactionBehavior::Immediate`；`busy_handler` 只出现在 `#[cfg(test)]`
  （`:560` 之后、`:627`，用来让竞争确定性地暂停）。better-sqlite3 的 `timeout: 5000` 就是同一个
  `sqlite3_busy_timeout`，加 `BEGIN IMMEDIATE` 即与 Rust 一致，纯 JS、无需预编译。原生模块只是等价性测试的工具。
- 因此建议：生产代码用 `timeout` + `BEGIN IMMEDIATE`；`nativeSqliteBusy` 仅供测试，预编译只需覆盖开发机与 CI
  （linux-x64 已有，补 darwin-arm64）。INT 现有 8 条 `startup-busy-handler` 失败就是缺 darwin-arm64。
- 若 W01 仍要在产品里带它（例如以后要自定义 handler），按下面做：
  1. 产出：darwin-arm64 / darwin-x64 用现有 `build.sh`（实测：本机 arm64 编译后 Node 26 + 共享 better-sqlite3 下
     handler 依次收到 0,1,2,3 后返回 `SQLITE_BUSY`；`-arch x86_64` 交叉编译通过，导出 `napi_register_module_v1` 与
     `sqlite3_f7busy_init`）。N-API 与 sqlite3ext（经 `pApi`）都是 ABI 稳定的，同一份文件 Node 与 Electron 通用，
     不需要 electron-rebuild。win32-x64 需在 Windows runner 上用 MSVC + node-gyp（`binding.gyp`，node-gyp 自带
     `win_delay_load_hook` 让 napi 符号解析到 electron.exe），提交 `.node` + `.sha256`，与 linux-x64 同样入库。
  2. **asar 路径必须改**：`index.ts` 把 `import.meta.url` 推出的路径交给 `db.loadExtension`，打包后这是
     `app.asar/host/...` 虚拟路径；`require` 由 Electron 重定向到 `app.asar.unpacked`，但 SQLite 自己 `dlopen`
     看不到 asar，会失败。需把路径中的 `app.asar` 段换成 `app.asar.unpacked` 后再 `loadExtension`。
  3. 打包（W06）：`asarUnpack` 已覆盖 `**/*.node`，`host/**/*` 已收录 prebuilds，无需新规则。届时 W06 补：
     只带目标平台的 `f7-sqlite-busy.${platform}-${arch}.node`，排除 `busy_handler.c` / `build.sh`；`package.mjs`
     打包后核对目标平台文件在 `app.asar.unpacked` 且 sha256 与 `.sha256` 一致；打包冒烟加一项真实 busy handler 检查。

## 交接事项（第六轮）

- **W01**：
  - `host/platform/paths/index.ts:284` 的 identifier 改为优先读 `DS_APP_IDENTIFIER`（外壳已写入，见
    `electron/shell/os-dirs.ts` 的 `APP_IDENTIFIER_ENV`），缺省才回落 `basename(appDataDir)`；建议常量移到
    `host/platform/paths/os-dirs.ts` 与 `SHELL_OS_DIRS_ENV` 并列，`API.md`“paths”同步。改完通知 W06 切外壳主日志。
  - sqlite-busy：按上节决定“生产用 busy_timeout、原生仅测试”，或补 darwin/win32 预编译 + `index.ts` 的 asar 路径修正。
  - `host/platform/API.md` 补 net-policy 导航策略一节（第五轮遗留）。
- **W10**：`host/plugins/vfs/tests/paper-library.test.ts(64,58)` host tsc 报错（`PaperSaveExecutorDeps` 不匹配）。
- **主代理 / W09**：`legal/THIRD_PARTY_NOTICES.txt` 需在有 Cargo 依赖缓存与 pdfium 许可证源的环境重新生成；
  以后改 lock 的 lane 都要跑 `npm run licenses:frontend-packages`（重任务，走 `bin/heavy`）。
- **产品决策候选（未做）**：`@sentry/node` 未声明（崩溃上报目前是空操作）；`electronLanguages` 只留 en / zh。

# W06 第五轮进度（瘦身 / 审计 / 边界 / CSP / Host 退出码 / FE-A5）

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | 安装包瘦身 | 完成 | `c8014583`、`6bf47b97` | `.app` 1.3 GB → 464 MB；`app.asar` 930.7 MB → 114.0 MB；`node electron/scripts/package-size-report.mjs`；`tests/packaging.test.ts`、`tests/node-modules-closure.test.ts` |
| 2 | npm audit（tar / tough-cookie 及生产依赖） | 完成 | `c8014583`、`8bdc150b` | `npm audit --omit=dev`：5 high → 2 high（剩 pptxgenjs 依赖的 image-size 1.x，需大版本，交接） |
| 3 | 合入 INT 后重新打包 | 完成 | — | 打包版冒烟 13/13（42/42 插件）、`verify-fuses.mjs` 9/9；打包后校验闭包 253 个包全部在 app.asar |
| 4 | electron 边界违规清零 | 完成 | `96db7da9` | `node scripts/electron-migration/boundaries.mjs`：electron 0 条 |
| 5 | 迁移页 CSP 报错 | 完成 | `58cf4104` | `tests/webview-migration-host.test.ts`（修前 4 条 CSP console error，修后 0）、`tests/smoke.test.ts`（computed app-region） |
| 6 | host-failure-log 偶发失败 | 完成 | `e4b2692c` | 根因见下；`tests/host-readiness.test.ts`；真实 Electron 连跑 3 次通过（修前本机必现） |
| 7 | FE-A5 `__DS_PLATFORM__` | 完成 | `7801dbba` | `tests/smoke.test.ts`；`API.md`“页面平台信息” |
| 8 | Schemastery 直接依赖、门禁脚本、RF 回填 | 完成 | `4609b983`、`93275e61`、`0c5c2220`、`3d7acd1b` | `npm run migration:rust-fixes`：0 errors |

## 瘦身

- 根因：闭包 FileSet 用 `['**/*']`（source map 258 MB、`.d.ts` 66 MB、其他平台预编译都进包）；前端打包进 `dist` 的库声明在
  `dependencies` 里被当成运行时依赖；host 的等价性夹具（`vfs/equivalence` 48.5 MB）与 wp280 证据进包。
- `dependencies` 只留 Host / main 运行时真正 import 的 26 个包，其余移到 `devDependencies`；删除无人使用的 6 个
  （cordis-plugin-include / loader、@hyzyla/pdfium、electron-updater、jpeg-js、js-tiktoken）。host 实际 import 却没声明的
  mdast-util-*、micromark-extension-gfm、upng-js、tar、tough-cookie、@smithy/node-http-handler 补为直接依赖；
  `tests/node-modules-closure.test.ts` 断言每个进包的裸 import 都已声明且在闭包里。
- 嵌套版本：electron-builder 的过滤器丢弃相对 `from` 恰为 `node_modules` 的目录，所以嵌套版本（`tar/node_modules/yallist`
  等 28 个）从来没有随父目录进包——第四轮能跑是因为臃肿的顶层恰好有同名包（版本不一定对）。现在每个嵌套版本单独一个
  FileSet，`package.mjs` 打包后逐个核对闭包里的包都在 app.asar 中，缺一个就失败。
- 第四轮 `packaging.test.ts` 的“ships sharp”断言是错的：进包代码不用 sharp（图片走 F7 WASI 编码器），已改为断言不进包。

## host-failure-log 偶发失败的根因

Host 发出 HostFatal 后会先释放运行时、再以 1 退出；外壳收到 fatal 时立即 `child.kill()`，被 kill 的 utility process 在 `exit`
事件里报告退出码 0。谁先到决定日志写 “exited (code 1)” 还是 “(code 0)”——不是日志冲刷问题。产品上同样有害：fatal 被记成
正常退出码，且 Host 的清理（关库等）被打断。改为等 Host 自己退出，5 s 内没退出才 kill 并记日志。

## 交接事项（第五轮）

- 许可证（W09 / 主代理）：`scripts/generate-third-party-notices.mjs:108`、`scripts/check-license-compliance.mjs:88` 跳过
  lock 里 `dev: true` 的条目；前端打包进 `dist` 的库现在是 devDependencies，生成器须把“前端打包的包”也计入。
- image-size：`npm audit --omit=dev` 剩 2 个 high 都来自 pptxgenjs 依赖的 image-size 1.2.1，修复只有 2.x（大版本），需评估 pptxgenjs。
- `host/platform/API.md`（W01）：补 net-policy 导航策略一节（`host/platform/net-policy/navigation.ts`）。
- `@sentry/node` 未声明为依赖：`backend-sentry.ts` 缺包时退化为 null，要启用崩溃上报须先声明。
- 可选：`electronLanguages` 只留 en / zh 可再省约 9 MB（影响 Chromium 自带对话框、右键菜单的语言）。

# W06 第四轮进度（打包 / 打包冒烟 / fuses / 浏览器事件）

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | 本机打出可运行 macOS `.app`（未签名，`--dir`） | 完成 | `398e914e`、`4f257a97` | `tests/node-modules-closure.test.ts`、`tests/packaging.test.ts`；`DEEP_STUDENT_BUILD_NUMBER=20000 bin/heavy node electron/scripts/package.mjs --mac --dir` |
| 2 | 打包版冒烟 | 完成 | 同上 | `node electron/scripts/__tests__/packaged-smoke.mjs`：13/13（冷启动、39/39 插件、koffi / better-sqlite3 从包内 dlopen、SQLite 读写回读、FSRS WASM、两个 worker_threads、假 LLM 流式对话、日志无 ERROR） |
| 3 | fuses + asar 完整性 | 完成 | `4f257a97` | `tests/app-hardening.test.ts`；`node electron/scripts/verify-fuses.mjs`：9/9（对未加 fuse 的 asar 产物先跑为 2/10 红） |
| 4 | browser-content 标题 / URL 事件交给 Host | 完成 | `c4ff4a93` | `tests/browser-content-events-host.test.ts`（真实 Electron）、`tests/browser-surface-host.test.ts`、`host/plugins/browser/tests/surface-host.test.ts` |
| 5 | 收尾全量测试 + tsc | 见下 | — | — |

## 打包

- 根因：工作树 `node_modules` 是指向共享安装的软链，`npm ls` 把包间依赖全部报 missing，electron-builder 的 npm
  收集器因此漏掉传递依赖（首个报错 `@deepseek-ai/cosmokit`）和所有平台原生包（`@koromix/koffi-darwin-arm64`、
  `@img/sharp-*`、`@lancedb/lancedb-darwin-arm64` 等），产物启动即 ERR_MODULE_NOT_FOUND，只弹“启动失败”对话框。
  在仓库内运行产物会被沿父目录找到的 node_modules 掩盖：冒烟必须用仓库外副本（脚本自动 `ditto`）。
- 修复：`scripts/node-modules-closure.cjs` 按 Node 解析规则从 package.json 走出生产闭包（dependencies、已安装的
  peer、os/cpu 匹配的 optional）；`beforeBuild` 返回 false 让 electron-builder 跳过重编译与自带收集，闭包作为各平台
  `files` 的 FileSet 进包。另有守卫测试扫描随包源码的裸导入：`tough-cookie`（shell/http-client.ts）与 `tar`
  （shell/updater.ts）被导入但未声明为依赖，列在 `UNDECLARED_RUNTIME_PACKAGES`。
- `package.mjs` 对本机平台传 `-c.electronDist=node_modules/electron/dist`（离线，不下载 Electron）；
  electron-builder 对本地 dist 不删 `default_app.asar`，`afterExtract` 里删除。
- 体积（fuse 版）：.app 1.3 GB = Electron Frameworks 252 MB + app.asar 944 MB + app.asar.unpacked 133 MB +
  migrations 0.8 MB。asar 内：node_modules 765 MB、host 88 MB（其中 native/wasm 7.8 MB）、dist 43 MB、contracts 3 MB、
  electron 0.9 MB；`.wasm` 合计 28 MB。解包的原生模块：lancedb 72 MB、@napi-rs/canvas 25 MB、better-sqlite3 16 MB
  （含全平台 prebuilds）、sharp-libvips 15 MB、其余 < 2 MB。

## 打包冒烟（`scripts/packaged-smoke.mjs`）

- 不能用 Playwright `_electron.launch`（依赖 `--inspect`，被 fuse 禁用）：以 `--remote-debugging-port=0` 启动产物，
  `chromium.connectOverCDP` 驱动渲染进程。隔离方式同 W12（HOME/TMPDIR/XDG/DS_APP_DATA_DIR/userData、黑洞代理）。
- 原生模块用 `lsof` 看进程树真实映射的 `.node`：koffi（主进程，browser-occlusion 顶层导入）、better-sqlite3（Host）
  都来自 `app.asar.unpacked`，没有包外路径。worker_threads 两个入口（存储工作池 `notes_list_tags`、诊断包导出）
  从 asar 内的 `.ts` 正常启动。冷启动首窗约 1.0 s、Host 就绪约 3.9 s。

## fuses（`scripts/app-hardening.cjs` / `scripts/verify-fuses.mjs`）

- 关：RunAsNode、EnableNodeOptionsEnvironmentVariable、EnableNodeCliInspectArguments；开：
  EnableEmbeddedAsarIntegrityValidation、OnlyLoadAppFromAsar；macOS 翻转后 ad-hoc 重签（`codesign --verify --deep
  --strict` 通过）。完整性哈希由 electron-builder 写入（macOS Info.plist、Windows exe 资源）。
- 行为校验：`ELECTRON_RUN_AS_NODE=1 -e` 不执行脚本、`--inspect` 不开调试端口、改 app.asar 头部一个字节后
  Electron `FATAL ... Integrity check failed for asar archive entry '<header>'` 退出、放回散装 `Resources/app` 不被加载。
  NODE_OPTIONS 只做静态校验：打包应用里 Electron 本就只接受 `--max-http-header-size` / `--http-parser`，探针区分不了。
- 与 Tauri 对比：Tauri 是 Rust 原生二进制，前端资源编进可执行文件，本来就没有 Node 入口（无 RUN_AS_NODE /
  NODE_OPTIONS / `--inspect` 可关），资源完整性只靠代码签名。前三个 fuse 是补齐 Electron 相对 Tauri 的缺口；
  asar 完整性是新增的：未签名产物也会在运行时按块哈希校验全部 JS（Host、node_modules、前端），Tauri 未签名
  二进制被改写不会被发现。仍与 Tauri 一样未签名、未公证。

## 交接事项（第四轮）

- 图标：`src-tauri/icons` 在本检出中不存在，产物用 Electron 默认图标。
- `tough-cookie`、`tar` 应移入 package.json `dependencies`（之后从 `UNDECLARED_RUNTIME_PACKAGES` 删除）。
- 体积：大量仅前端使用、已被 vite 打进 dist 的包（@tabler 139 MB、echarts、lucide-react、mermaid、typescript 等）
  声明在 `dependencies`，闭包照单全收；移到 devDependencies 可省数百 MB。better-sqlite3 带全平台 prebuilds；
  `host/platform/native/wasm` 含 vendor crate 源码。
- `--remote-debugging-port` 是 Chromium 开关，fuse 管不到；冒烟依赖它。若要在发布版禁用，需在 main.ts 对打包产物
  拒绝该开关，并给冒烟留测试专用入口。
- 根 `.gitignore` 缺 `/release`（不在 W06 范围）；打包产物从未提交。
- 跨架构打包（如 arm64 机器打 mac x64）需要目标架构的平台包已安装，闭包按本机架构取 optional 包。
- dmg / zip 目标未在本机验证（electron-builder 26 的 dmg 需下载 dmgbuild）；Windows / Linux 产物与 Windows 的
  asar 完整性资源未验证。
- `GrantFileProtocolExtraPrivileges`、`EnableCookieEncryption` 保持 Electron 默认，未评估。

# W06 第三轮进度

| # | 项 | 状态 | 提交 | 证据 |
|---|---|---|---|---|
| 1 | Host 早期失败进主进程日志 | 完成 | 见 git log `[W06] host log` | `tests/main-log.test.ts`、`tests/host-failure-log-host.test.ts`（真实 Electron：HostFatal / 加载期崩溃 / SIGKILL） |
| 1+ | 内置命令兜底（每个 invoke 都 settle） | 完成 | 同上 | `tests/runtime-fallback.test.ts` |
| 2 | path 插件隔离 | 完成 | 见 git log `[W06] path isolation` | `tests/os-dirs.test.ts`（23 个 BaseDirectory 无一落到真实用户目录；未设置时与 Tauri 逐项相同）、`tests/shell-restart-host.test.ts`（真实 Electron 经 `plugin:path|resolve_directory`） |
| 3 | 迁移落盘回读确认 | 完成 | 见 git log `[W06] migration durability` | `tests/webview-migration-gate.test.ts`、`tests/webview-migration-persisted.test.ts`、`tests/webview-migration-host.test.ts`（真实 Electron：确认后、标记前 SIGKILL → 重放 written 0） |
| 4 | Agent 控制浏览器私网防护 | 完成 | 见 git log `[W06] agent network guard` | `tests/browser-agent-guard.test.ts`（判定与 DNS 失败文案逐条对齐 Rust）、`tests/browser-agent-guard-host.test.ts`（真实 Electron：302 到内网域名 / 内网字面量、DNS 失败、重绑定、页面自发导航；代理与源服务器记录证明被拦请求未发出）、`host/plugins/browser/tests/{browser-service,surface-host}.test.ts` |
| 5 | 收尾全量测试 + tsc | 完成 | 见 git log `[W06] final` | `electron/` 78 文件 486 通过 / 5 跳过、无未处理错误；`host/plugins/browser/tests` 25 文件 198 通过；`host/kernel/tests` 35 文件 228 通过；`tsc -p tsconfig.host.json` 0 错误 |

## 设计记录

- 主进程日志：`<app_log_dir>/electron-main.log`（与 Host `deep-student.log` 同目录，标识取 app data 目录名），
  逐行同步追加、启动前的行先缓存、超过 5 MiB 打开时轮转为 `.1`；写失败只停用文件日志。
- Host stderr 改为 pipe：`pipe(process.stderr, { end: false })` 转发（背压等价于 inherit），另保留最后 16 KiB；
  非有序退出时等 stderr 读完（最多 500 ms）后把尾部写进主日志。`child-process-gone` 晚于 `exit` 到达，
  用它的 `reason` 区分信号终止（`killed`/`crashed` 时 exitCode 为信号编号）。
- path 隔离：`resolveShellOsDirs` 同时返回解析器本身，main 的 path 插件 / asset / fs / opener 作用域都用它，
  因此与 `DS_SHELL_OS_DIRS` 出自同一个隔离环境；AppData 直接等于 `DS_APP_DATA_DIR`（Tauri 中 app_data_dir 即
  Host 的 appDataDir，隔离后保持这一等式）。另外不再继承 `XDG_BIN_HOME` / `XDG_RUNTIME_DIR`，Windows 用户文件夹
  按默认布局放到隔离 profile 下（下载、文档目录在冒烟中仍可用）。Linux 隔离 home 没有 `user-dirs.dirs`，
  Desktop/Download 等与 Tauri 在新用户上的行为一样为 unknown path。App* 目录仍用配置 identifier（Tauri 语义），
  而 Host 的 app 日志目录用 appDataDir 的目录名：两者仅在 `DS_APP_DATA_DIR` 目录名不是 identifier 时不同。
- 迁移持久性：只“重载页面读回”证明不了落盘（读到的是浏览器进程内存里的 DOMStorage），所以读回之后再从
  Electron 自己的 `Local Storage/leveldb` 轮询解码（复用 W07 的只读 LevelDB 解码器，10 s 超时），两层都一致才写 `done`。
  读回比较：写入的键 = 快照值；target wins 保留的键（apply 报告新增 `keptKeys`）只要求存在。
- Agent 私网防护（Rust `window.rs::navigation_allowed` / `validate_agent_target_for_agent` / `BoundedDnsResolver`）：
  browser 插件在开关或 http 策略变化时经 `browser.setAgentNavigationPolicy` 推给外壳（初始关闭不推；Host 进程
  退出时外壳复位为关闭）。插件侧 preflight 的 DNS 经 `browser.resolveAgentHost` 用同一解析器——此前生产环境
  resolver 为 null，Agent 打开任何域名都被 “DNS resolution is unavailable” 拦下。外壳：`will-navigate` /
  `will-redirect` 同步判定规范策略与地址字面量；`webRequest.onBeforeRequest`（主框架，每个重定向跳都会再触发）
  用该会话的 `resolveHost` 做完整判定（2 s 超时、超时未返回期间 busy、无结果 / 失败 / 任一私网地址均拒绝，文案与 Rust
  相同）；`onHeadersReceived` 按 Chromium 实际连接的 IP 再判一次防重绑定，经代理时连接的是代理地址，跳过。
  有意偏离：请求层取消时 Chromium 在被拦 URL 上提交 ERR_BLOCKED_BY_CLIENT 错误页（Rust 同步拦截停在原页）；
  重绑定只能在响应头阶段识别，请求已到达目标但响应被丢弃（Rust 对重绑定没有防护）；子帧与子资源与 Rust 一样不判。

## 交接事项

- 真机：macOS / Windows 的嵌入式 browser-content 在 Agent 控制下打开公网域名、302 到内网被拦且插件收到
  navigation-blocked；Clash 等 fake-ip 代理（198.18.0.0/15）会让 Agent 浏览全部被判为私网，与 Rust 相同。
- 外壳仍未把 browser-content 的标题 / URL 变化事件交给 Host（本轮未涉及；第四轮 `c4ff4a93` 已完成）。
- Windows 上迁移确认读取 `Local Storage/leveldb` 时的文件共享锁需真机确认。
