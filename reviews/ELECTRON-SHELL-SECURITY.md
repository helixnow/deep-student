# Electron 外壳与 Host 通道安全审查

审查人：S01（第三轮）　基线：INT `4384a313`　日期：2026-11-07

范围：`electron/**`（main、preload、shell 内置插件、协议、打包、更新）、Host 连接与 kernel 命令分发（`host/kernel/{acl,commands,runtime,profile}.ts`）、插件生态 v1（`decisions/2026-11-07-plugin-ecosystem-v1.md`）。
对照物：Tauri 版的 `src-tauri/capabilities/*.json`、`src-tauri/permissions/*.toml`、`src-tauri/tauri.conf.json`。

回归测试在 `host/e2e/security/`：存在漏洞的行为写成"安全时应有的断言"并用 `it.fails` 标注（修好后会转红，提示改成 `it`）；已经正确的行为写成普通测试守住。测试只调用被审代码，没有改动它。

## 结论

Electron 版在 Host 命令这一半做得很好：kernel 的 `CapabilityAcl` 忠实移植了 Tauri `authority.rs`，origin 只从 main 持有的 `WebFrameMain` 读取，远程页面拿不到任何应用命令。**问题集中在外壳自己实现的 Tauri 内置插件**（`plugin:fs|*`、`plugin:http|*`、`plugin:opener|*`、`plugin:updater|*`、`plugin:process|*`、`plugin:event|*`、`plugin:window|*` 等）：它们在 main 进程里直接执行，不经过任何按 webview、按 origin 的授权，`capabilities.ts` 文件头也写明了"只合并 scope，不做逐窗口的命令授权检查"。在 Tauri 里，browser-content 的远程页面只有 `allow-browser-content-user-input` 一个权限；在 Electron 里，Agent 浏览器打开的任意网页都能读写用户文档、发任意 HTTP 请求、启动下载目录里的文件。这是迁移引入的严重回归，应在开放 Agent 浏览器之前修复。

## 问题清单（按严重度排序）

| 编号 | 严重度 | 归属 | 摘要 | Tauri 是否同样存在 | 测试 |
|---|---|---|---|---|---|
| SEC-E01 | 严重 | W06 | 外壳内置插件无逐 webview ACL，browser-content 远程页面可调 fs/http/opener/updater/process 等 | 否（回归） | 2 个 `it.fails` + 2 个守护 |
| SEC-E02 | 高 | W06 | 打包版仍读取 `DS_HOST_ENTRY` 等开发环境变量，可执行任意代码、把远程 origin 当作本地应用 | 否（回归） | 无（见说明） |
| SEC-E05 | 高 | W06 | 远程页面可用 `plugin:event|emit` 伪造 `dstu-browser://` 内容事件，并向应用窗口全部监听者广播 | 否（回归） | 1 个 `it.fails` |
| SEC-E06 | 高 | W01 / W17 / W06 | 插件生态 v1：`service:` 注入不是安全边界；社区 UI 半在主窗口主世界运行，拥有主窗口全部权限 | 不适用（新功能） | 无（设计缺口） |
| SEC-E03 | 中 | W06 | quick-assistant、pomodoro-mini 窗口拿到全部内置插件（capability 只给了剪贴板与窗口操作） | 否（回归） | 1 个 `it.fails` + 1 个守护 |
| SEC-E04 | 中 | W06 | fs 读写权限合并成一个全局 scope：`$DESKTOP` 只读权限也放行了写入 | 否（回归） | 1 个 `it.fails` + 3 个守护 |
| SEC-E07 | 中 | W06 | 渲染进程消息无运行时校验：非字符串 `cmd` 在 main 抛异常、弹主进程错误框；载荷无大小上限 | 否（回归） | 1 个 `it.fails` |
| SEC-E08 | 中 | W06 | Windows 上 ASAR 完整性未验证（`signAndEditExecutable: false`，`verify-fuses` 只查 macOS） | 不适用 | 无（需 Windows 打包验证） |
| SEC-E09 | 低 | W06 | fuses 留默认：`EnableCookieEncryption` 关（浏览器会话 cookie 明文落盘）、`GrantFileProtocolExtraPrivileges` 开 | 部分（WebView2 用 DPAPI 加密 cookie） | 无 |
| SEC-E10 | 低 | W06 | main 不加校验地把 `drag-drop` 消息里的路径加入 fs/asset 作用域 | 否 | 无 |
| SEC-E11 | 低 | W01 | kernel 命令（`plugin:host|call/status`、`plugin:ui|manifest`）对所有本地窗口开放 | 不适用 | 无 |
| SEC-E12 | 低 | W01 | `meta.ui` 可用 `../` 指到插件包外，`ds-plugin://` 的服务根随之上移 | 不适用 | 无 |

**Rust/Tauri 版同样存在的问题**（按 RF 政策由负责 lane 决定是否修，修了要登记 RF）：

| 编号 | 归属 | 内容 |
|---|---|---|
| SEC-T01 | W06 | `opener:allow-open-path` 覆盖 `$DOWNLOAD/**`、`$TEMP/**`、`$DESKTOP/**`，`open_path` 交给系统默认程序打开，可直接启动可执行文件（Windows `.exe/.bat/.lnk`，macOS `.app`）。在 Tauri 中只有主 webview 能调；在 Electron 中和 SEC-E01 组合成"写文件再启动"的代码执行链。建议 `open_path` 拒绝可执行类型，或仅允许打开应用自己导出的文件。 |
| SEC-T02 | W06 | `plugin:updater|check` 的 `allowDowngrades`、`proxy`、`headers` 由调用方页面给出（`updater.ts:800-806`）。签名仍会校验，但能装回更旧的已签名版本。建议主进程忽略来自页面的 `allowDowngrades`。 |
| SEC-T03 | W06 | macOS 仍是 ad-hoc 签名、未开 hardened runtime（`electron-builder.config.cjs:103-107`；Tauri 版 `signingIdentity: "-"`）。发布前需正式签名、公证并开启 hardened runtime，否则 `DYLD_*` 注入、篡改 `.app` 都不受系统阻止。 |
| SEC-T04 | W12 / W06 | CSP 的 `img-src … https:` 与 `style-src 'unsafe-inline'`（`tauri.conf.json:38`）：一旦出现 HTML 注入，可用图片或 CSS 外带数据。W12 冒烟 #15（迁移页 `default-src 'none'` 下注入样式报错）不是安全问题，修法见 W12-PROGRESS #15。 |

---

## 详细说明

### SEC-E01（严重，W06）外壳内置插件没有逐 webview / 逐 origin 的授权

**位置**
- `electron/shell/runtime.ts:224-234` `runBuiltin`：`plugin:<name>|<cmd>` 只要在插件表里就执行。
- `electron/shell/runtime.ts:247-259` `handleBrowserInvoke` → `:285` `dispatchInvoke` 先走 `runBuiltin`；origin 只对转发给 Host 的命令生效（`:308`）。
- `electron/shell/capabilities.ts:9`：自述"不做逐窗口的命令授权检查"。
- `electron/main.ts:241-269`：注册 `fs`、`http`、`opener`、`process`、`updater`、`clipboard-manager`、`dialog`、`window`、`webview`、`global-shortcut`、`notification`、`event`。
- browser-content 与应用窗口用同一个 preload（`browser-surface.ts:158`、`:241`），`IPC_CHANNEL_INIT` 给它安装完整的 `__TAURI_INTERNALS__`（`main.ts:424-438`）。

**Tauri 对照**：`src-tauri/capabilities/browser-content.json` 只给 `allow-browser-content-user-input`（`browser_content_user_input` 一条命令），描述里明确写了"不继承 main/default、core、fs、http、dialog、opener、window 权限"。

**利用路径**（攻击者只需让 Agent 或用户在内置浏览器里打开一个网页）：
1. 读取用户文档：`__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file', { path: '<home>/Documents/…' })`。可读范围是 default.json 授予的全部目录（`$DOCUMENT`、`$DOWNLOAD`、`$PICTURE`、`$DESKTOP`、`$TEMP`、`$RESOURCE`；Windows 上还有 `$APPDATA`，其中有数据库与设置）。
2. 外带与内网探测：`plugin:http|fetch` 绕过 CORS，且 `http://127.0.0.1:*`、`http://localhost:*` 在允许列表里，可以读本机服务的响应。
3. 代码执行：先 `plugin:fs|write_file` 写入 `$DOWNLOAD/x.bat`（或 `$DESKTOP`、`$TEMP`），再 `plugin:opener|open_path` 交给系统打开（与 SEC-T01 组合）。
4. 持久化（Windows）：`$APPDATA` 可写，写入 `<APPDATA>/plugins/user.profile.json` 和一个 `.mjs`，下次启动时 Host 按 profile 动态 `import()`，以完整 Node 权限执行（`host/kernel/profile.ts:164`、`:297`）。macOS 与 Linux 上 `$APPLOCALDATA` 与 `$APPDATA` 是同一目录，`fs:default` 的 deny-default 挡住了这一步（已用守护测试固定）。
5. 其他：`plugin:clipboard-manager|read_text` 读剪贴板，`plugin:updater|check {allowDowngrades:true}` 后安装旧的已签名版本，`plugin:process|exit/restart`，`plugin:window|*` 关闭或移动主窗口，`plugin:global-shortcut|register` 抢占全局快捷键。

**修法建议**：在 `dispatchInvoke` 调用 `runBuiltin` 之前做 ACL 判定，规则与 kernel 的 `CapabilityAcl` 相同：按 `src-tauri/capabilities` 与各插件的权限清单（如 `fs:allow-read-text-file`、`core:window:allow-close`）把命令映射到 window/webview 与 origin。在完整实现之前，至少做两件事：browser-content 和所有非本地 origin 的调用一律拒绝内置插件命令；其他窗口按各自的 capability 文件配置白名单。scope 也应按命令区分（见 SEC-E04）。

**测试**（`host/e2e/security/shell-builtin-acl.test.ts`）
- `it.fails` "SEC-E01 [W06] a remote page in browser-content cannot read the user documents through plugin:fs…"
- `it.fails` "SEC-E01 [W06] a remote page in browser-content cannot write into the user documents through plugin:fs"
- 守护："…Host-bound commands from browser-content carry the remote origin…"、"…a browser-content page parked on a local-looking URL is still treated as remote"
- 守护（`kernel-acl.test.ts`）：应用命令与 kernel 命令对远程页面都被拒绝；browser-content 只保留 trusted-input 命令，且只对 http(s) origin 生效。

### SEC-E02（高，W06）打包版仍接受开发用环境变量

**位置**：`electron/main.ts` 中，除 `DS_MIGRATIONS_DIR` 的默认值外，没有任何变量受 `app.isPackaged` 约束。
- `:279` `DS_HOST_ENTRY`：Host 入口，任意 JS 文件以 utilityProcess 运行，拥有完整 Node 权限。
- `:281` `DS_HOST_PROFILE`：任意 profile，即任意插件模块。
- `:213` `DS_ELECTRON_DEV_URL`：页面基址改为任意 URL，`windowOrigin` 和 `localOrigin` 随之改变。远程页面被当作本地应用，拿到主窗口的全部 ACL 与内置插件。
- `:414` `DS_ELECTRON_FRONTEND_DIST`：从任意目录提供 `tauri://localhost`。
- `:115` `DS_ELECTRON_USER_DATA`、`:193` `DS_APP_DATA_DIR`：数据目录重定向。
- `:541` `DS_ELECTRON_CAPTURE`：把主窗口截图写到任意路径。

**利用路径**：能设置用户环境变量的本地低权限进程（`launchctl setenv`、Windows 用户环境变量、`.desktop` 文件、快捷方式）让已签名的 Deep Student 执行它的代码。这样就继承了应用的 TCC 授权（麦克风、文件夹访问）和"已签名应用"的信任（应用白名单、EDR），等于把 fuses 关掉的 `RunAsNode` / `NODE_OPTIONS` 换个名字放了回来（`electron/scripts/app-hardening.cjs:5-7` 的设计意图）。

**修法建议**：`app.isPackaged` 时忽略上述变量，只保留确有需要的、并改为命令行开关加签名校验的方式。冒烟测试需要的隔离目录改由测试构建的标志位开启。

**测试**：`electron/main.ts` 在模块加载时就导入 `electron`，在 vitest 里无法直接调用；这条是静态证据。建议 W06 在 `electron/tests/packaging.test.ts` 的打包产物测试里加一条：带 `DS_HOST_ENTRY` 启动打包版时，必须被忽略。

### SEC-E05（高，W06）远程页面可伪造 browser-content 内容事件

**位置**：`electron/shell/plugins/event.ts:32-40`、`:58-73`。`emit` / `emit_to` 先把事件广播给全部 JS 监听者（`emitJs(event, payload, null)`），再以 `source: { window: ctx.windowLabel, webview: ctx.webviewLabel }` 转给 Host。browser-content 的调用里 `webviewLabel` 就是 `browser-content`，与 main 为真实原生回调发出的事件（`main.ts:344-349` `sendBrowserContentEvent`）来源完全相同。Host 的 browser 插件只按来源判定可信（`host/plugins/browser/src/surface-host.ts:182-196`）。

**利用路径**：网页 `invoke('plugin:event|emit', { event: 'dstu-browser://page-finished', payload: { url: 'https://bank.example/account' } })`，Agent 就会认为自己停在一个可信站点上；`navigation-blocked`、`title-changed` 同理。它还能向应用窗口的任意前端事件监听者发事件。

**Tauri 对照**：browser-content 没有 `core:event:*` 权限，`emit` 被 ACL 拒绝。

**修法建议**：并入 SEC-E01 的 ACL。另外，原生回调由 main 直接发出，可以在 FrontendEvent 上加一个只有 main 能设置的字段（例如 `native: true`），Host 的 browser 插件只接受带这个字段的事件。

**测试**：`it.fails` "SEC-E05 [W06] a remote page in browser-content cannot forge dstu-browser:// content events…"

### SEC-E06（高，W01 / W17 / W06）插件生态 v1：`service:` 权限不构成隔离

决策 4 规定"社区插件只会被注入它声明过的服务"。对照现状：
1. **Host 半与内核同进程。** `host/kernel/profile.ts:164` 直接 `import()` 社区模块，插件可以自己 `import('node:fs')`、`node:child_process`，读 `process.env`（main 的完整环境会传给 Host），因此服务注入限制管不住它。W01 的 P0 若只做注入过滤，需要在文档中明确它"防误用、不防恶意"；真正的隔离需要每个社区插件一个 utilityProcess 或 Worker，只通过 RPC 暴露已声明的服务。
2. **UI 半在主窗口主世界运行。** `src/ui-kernel/loader.ts` 用 `import('ds-plugin://…')` 加载，CSP 为此放行了 `ds-plugin:` 和 `blob:`（`electron/shell/plugin-ui-protocol.ts:217-242`）。社区 UI 代码因此拥有主窗口的全部能力：所有应用命令、内置插件（读写文档、`http`、`opener`）、`plugin:host|call` 调用其他插件的 `meta.remote` 方法。决策 7 的"跨半调用只走 `meta.remote`"目前只是约定，`hostCall`（`host/kernel/runtime.ts:279-317`）不知道调用方是哪个插件的 UI。
3. **同意流程。** "权限增加需重新同意"尚未落地；`user.profile.json` 就是安装入口，谁能写这个文件谁就能装插件（见 SEC-E01 第 4 步）。

**修法建议**：
- W17：社区 UI 半放进 sandbox iframe（独立 origin、无 bridge），经 postMessage SDK 调用，由宿主按 manifest 权限转发。
- W01：Host 半进程隔离；`plugin:host|call` 校验"调用方插件 id = 服务所属插件 id"（需要 UI 半带身份）；profile 写入要经过同意流程，不能只靠文件存在。
- W06：社区 UI 隔离后，主窗口 CSP 不再需要在 `script-src` 放行 `ds-plugin:` 与 `blob:`。
- 决策文档注明：v1 开放社区插件之前，这些是阻断项。

### SEC-E03（中，W06）其他窗口的最小权限丢失

quick-assistant 的 capability 只有 `allow-quick-assistant-commands`、日志、`core:*`、几个窗口操作和剪贴板读写；pomodoro-mini 类似。在 Electron 中，这两个窗口与主窗口共用全部内置插件（原因同 SEC-E01）。页面是应用自身代码，所以风险低于 SEC-E01，但窗口的 XSS 会直接升级为文件读写。Host 命令这一半是正确的（`kernel-acl.test.ts` 守护：quick-assistant 能调自己的 `save_setting`，调不了主窗口专用的 `textbooks_add`）。

修法同 SEC-E01。测试：`it.fails` "SEC-E03 [W06] the quick-assistant window cannot use plugin:fs…"

### SEC-E04（中，W06）fs 读写权限合并

**位置**：`electron/shell/capabilities.ts:114-117`。`fs:allow-<dir>-(read|write|meta)` 三种权限都调用同一个 `addDir(fsAllow, …)`，得到一个读写不分的全局 scope；`fsPlugin` 的写命令和读命令查的是同一个 scope（`plugins/fs.ts:107-127`）。

**影响**：default.json 对 `$DESKTOP` 只给了 `fs:allow-desktop-read-recursive`，Electron 却允许写桌面（如 `dropped.command`），可与 SEC-T01 组合。

**修法建议**：分开维护读、写、meta 三个 scope，按命令所属的权限集合选择。tauri-plugin-fs 的 `read-*` / `write-*` 权限各自附带命令列表，可从插件的权限清单生成。

**测试**：`it.fails` "SEC-E04 [W06] the main window cannot write to $DESKTOP…"。守护三条：主窗口照常能读 `$DESKTOP`、写 `$DOCUMENT`；macOS/Linux 上 deny-default 挡住应用数据目录；scope 拒绝 `..` 穿越与点文件。

### SEC-E07（中，W06）渲染进程消息没有运行时校验

**位置**：`electron/main.ts:457` 把 `message` 直接当作 `RendererToMain` 使用；`runtime.ts:225` `cmd.startsWith`；`runtime.ts:280` 在主线程 `JSON.parse(message.payload.data)`。

**利用路径**：页面调用 `__TAURI_INTERNALS__.invoke({ toString: 'x' })`（对象经 contextBridge 结构化克隆后原样到达 main），`runBuiltin` 抛 `TypeError`。main 只注册了 `uncaughtExceptionMonitor`（`electron/shell/bootstrap.ts:68-73`），Electron 默认会弹出"主进程 JavaScript 错误"对话框，这次 invoke 也永远不会 settle。远程页面可以反复触发。另外载荷没有大小上限，页面可以发送数百 MB 的 ArrayBuffer 或 JSON，在 main 线程解析时阻塞整个界面。

**修法建议**：`IPC_CHANNEL_TO_MAIN` 入口对 `type`、`cmd`（字符串、长度上限）、`callback/error`（u32）、`payload`（类型与大小上限，例如 JSON 64 MB）、`headers`（字符串字典）做形状校验，不合格的直接丢弃并记日志；`dispatchInvoke` 用 try/catch 包住同步阶段，保证有回复。

**测试**：`it.fails` "SEC-E07 [W06] a non-string cmd from a page is answered with an error instead of throwing in the main process"

### SEC-E08（中，W06）Windows ASAR 完整性未验证

`electron-builder.config.cjs:119` 设置了 `signAndEditExecutable: false`。electron-builder 通过编辑 exe 资源写入 Windows 上的 ASAR 完整性信息；`electron/scripts/verify-fuses.mjs:88-89`、`:134` 只验证 macOS 的 `Info.plist`。需要在 Windows 打包产物上确认两点：一、完整性资源确实存在；二、篡改 `app.asar` 后应用拒绝启动。否则 `EnableEmbeddedAsarIntegrityValidation` 在 Windows 上要么失效，要么让应用无法启动。Linux 上 Electron 本身不做 ASAR 完整性校验，应写进发布说明。

### SEC-E09（低，W06）未设置的 fuses

`electron/scripts/app-hardening.cjs:14-20` 只设置了五个 fuse：
- `EnableCookieEncryption` 保持关闭：browser-content 会话（`session.fromPath(profileDir)`）里用户登录网站的 cookie 明文写盘。WebView2 版用 DPAPI 加密，所以 Windows 上是回归。打开它需要处理已有 cookie 的迁移（Electron 会自动迁移明文 cookie）。
- `GrantFileProtocolExtraPrivileges` 保持开启：应用不使用 `file://`，应关闭。

### SEC-E10（低，W06）拖放路径未经校验就扩大作用域

`electron/main.ts:478-492` 把 `drag-drop` 消息的 `paths` 直接加入 `fsRuntime` 与 `assetScope`。目前只有隔离世界的 preload 能发这种消息（页面拿不到 `transport`），属于纵深防御问题。建议 main 记录最近一次 `will-drag`/OS 拖放事件，或至少只在窗口 `dragDropEnabled` 时接受，并限制路径数量。

### SEC-E11（低，W01）kernel 命令对所有本地窗口开放

`host/kernel/commands.ts:376-378` 只要求 origin 为 local，不看 window/webview。quick-assistant、pomodoro-mini 也能调 `plugin:host|call`（社区插件声明的 `meta.remote` 方法）。目前官方插件都没有声明 `meta.remote`，所以影响有限。建议 kernel 命令按 window/webview 白名单（默认只给 `main`）。

### SEC-E12（低，W01）`meta.ui` 可以指到插件包外

`host/kernel/runtime.ts:193-204` `communityUiFile` 返回 `resolve(dirname(moduleFile), ui)`，没有限制在插件包内；`ds-plugin://` 以 `dirname(file)` 为根提供文件（`plugin-ui-protocol.ts:176-188`）。`meta.ui: '../../../../ui.js'` 会让根变成 `/` 之类的目录，于是该目录下所有允许扩展名的文件都能被应用页面读取（响应带 `Access-Control-Allow-Origin: *`）。社区 Host 半本身已经能读任何文件，所以风险低，但修复很便宜：要求解析结果位于插件包根目录（`package.json` 所在目录）之内。

## 已核实无问题的部分

- 所有窗口与 browser-content：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`（`windows.ts:136-140`、`browser-surface.ts:156-161`、`:239-244`）；没有开启 `nodeIntegrationInSubFrames`，子 frame 不运行 preload，拿不到 IPC。
- IPC 来源：origin 只从 main 的 `event.senderFrame` / `webContents` 读取（`frame-origin.ts`），不读页面自报的 `Origin` 头；`tauri:` 与 opaque origin 的处理与 Tauri `is_local_url` 一致；browser-content 即使停在本地 URL 也按远程处理（`runtime.ts:252`）。
- 导航与窗口（`web-security.ts`）：`setWindowOpenHandler` 一律拒绝，只把 opener 作用域内的 URL 交给系统浏览器（协议白名单 `mailto:`、`tel:`、`http(s):`）；应用窗口只能停留在应用 origin，`will-redirect` 到外部直接拒绝；`will-attach-webview` 一律阻止；权限请求与检查默认拒绝，应用帧只放行实际用到的权限，麦克风限于音频。
- browser-content 使用独立会话（`session.fromPath`），默认会话上注册的自定义协议（`asset:`、`ds-plugin:`、`pdfstream:`、`filestream:`）对它不可见。
- 自定义协议：`tauri:` 的 dist 服务做了 `normalize` + 前缀检查；`ds-plugin:` 做了解码、包含检查、realpath 二次检查、扩展名白名单、`no-store`；`asset:` 走与 Tauri 相同的 scope（`tauri.conf.json` `assetProtocol.scope`），CORS 只放行窗口 origin。
- Host ACL：`host/kernel/acl.ts` 的 deny 优先、remote URL 匹配、window/webview glob 与 Tauri 2.11.5 一致；kernel 命令对远程 origin 一律拒绝（`commands.ts:376-378`）。
- fuses：`RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments` 关闭，`EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar` 开启；macOS 上有完整性验证脚本（含"篡改后拒绝启动"的实测）。
- 更新：minisign 校验与 tauri-plugin-updater 一致（密钥 ID 比对、全局签名、trusted comment）；endpoint 必须是 https；公钥来自打包的配置。
- 本机监听：bilibili 桥（`bilibili-bridge-server.ts`）只绑定 127.0.0.1，并校验 Host/Origin、需要配对；MCP OAuth 回调只绑定 127.0.0.1。
- `test_web_search_connectivity` 加入生产 ACL（W09 `c51d6415`）是相对 Tauri 的放宽，已登记为 `RF-W05-web-search-connectivity-unregistered`。

## 修复优先级建议

1. SEC-E01 + SEC-E05 + SEC-E03（同一处修复：内置插件 ACL）。在此之前，不要让 Agent 浏览器打开不受信任的网页。
2. SEC-E02（打包版忽略开发环境变量）。
3. SEC-E04、SEC-E07。
4. SEC-E06：作为社区插件开放（1.0）前的阻断项，列入 W01/W17 的 P0/P1。
5. 其余低危项与 SEC-T01…T04 按各 lane 排期，修 SEC-T* 时按 RF 政策登记。
