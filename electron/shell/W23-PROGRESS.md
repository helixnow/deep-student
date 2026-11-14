# W23 外壳内置插件 ACL 进度

分支 `assault/W23-shell-acl`，归属见 WAVE2-BRIEF §6 与 INTEGRATION-NOTES。本文件的两张表由
`electron/tests/builtin-acl-matrix.test.ts` 固定：新增放行、新增或去掉实现、作用域变化都必须同时改表，
两边实际可用不一致的行必须引用 RF 或写明交接，否则测试失败。

## ACL 对照表：内置插件命令 × 窗口

参照：Tauri 2.11.5 桌面正式版（tauri-utils 2.9.3 `acl/resolved.rs`，tauri 2.11.5 `ipc/authority.rs`、
`webview/mod.rs`），`src-tauri/capabilities/*.json`，各插件默认权限（`electron/shell/plugins/tauri-acl-manifest.ts`）。

- 窗口列：`✓` 放行，`·` 拒绝。每格同时等于 Electron `BuiltinAcl` 与测试里按 Tauri 规则独立推导的结果，
  linux / darwin / win32 三个平台相同。
  - main、quick-assistant、pomodoro-mini：同名本地窗口。
  - browser-content：远程 https 页面（挂在 main 下，以及 Linux 上的独立窗口），以及停在 `about:blank` 等本地 URL 的内容页（origin `null`）。
  - 其他：远程来源的 main、远程来源的 quick-assistant、未在 capability 里列出的本地窗口（例如 `settings`）。
- Tauri 列：`有`；`无`（桌面正式版不编译）；`debug`（只在 debug 构建编译）；`报错`（编译了但本构建恒返回错误）；
  `macOS` / `Windows`（只在该平台编译）。依据各 crate 的 `generate_handler!` 与 cfg，本机有 cargo registry 时测试会重新推导。
- Electron 列：`有`；`桩`（`unsupported()`，明确报不支持）；`无`（没有处理函数，ACL 放行时回 Tauri 的 `Command <name> not found`）；
  `debug`（只在开发构建可用，正式版回 `Command <name> not found`）；`报错`（实际调用后抛出与 Tauri 本构建相同的错误）。

<!-- builtin-acl-matrix:begin -->
| 插件 | 命令 | main | quick-assistant | pomodoro-mini | browser-content | 其他 | Tauri | Electron | 说明 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| app | `app_hide`, `app_show`, `set_app_theme`, `set_dock_visibility` | · | · | · | · | · | 有 | 有 |  |
| app | `bundle_type`, `identifier`, `name`, `supports_multiple_windows`, `tauri_version`, `version` | ✓ | ✓ | ✓ | · | · | 有 | 有 | `core:app:default` |
| app | `default_window_icon`, `fetch_data_store_identifiers`, `remove_data_store` | · | · | · | · | · | 有 | 桩 | 没有窗口放行 |
| app | `register_listener`, `remove_listener` | ✓ | ✓ | ✓ | · | · | 无 | 无 | 只有移动端注册；两边都回 `Command <name> not found` |
| clipboard-manager | `clear`, `read_image`, `write_html`, `write_image` | · | · | · | · | · | 有 | 有 | `clipboard-manager:default` 为空 |
| clipboard-manager | `read_text`, `write_text` | ✓ | ✓ | · | · | · | 有 | 有 |  |
| dialog | `ask`, `confirm`, `message`, `open`, `save` | ✓ | · | · | · | · | 有 | 有 | 选中的路径进入 fs 运行时作用域 |
| event | `emit`, `emit_to`, `listen`, `unlisten` | ✓ | ✓ | ✓ | · | · | 有 | 有 | browser-content 不能 emit（SEC-E05） |
| fs | `copy_file`, `create`, `exists`, `fstat`, `ftruncate`, `lstat`, `mkdir`, `open`, `read`, `read_dir`, `read_file`, `read_text_file`, `read_text_file_lines`, `read_text_file_lines_next`, `remove`, `rename`, `seek`, `stat`, `truncate`, `write`, `write_file`, `write_text_file` | ✓ | · | · | · | · | 有 | 有 | 作用域见下表 |
| fs | `scope-app-index`, `scope-app-recursive`, `unwatch`, `watch` | ✓ | · | · | · | · | 无 | 无 | `scope-app-*` 不是命令：fs 清单把作用域权限名写进了 `create-app-specific-dirs` 等的命令列表；`watch` 要 fs 的 `watch` 特性（未开），`unwatch` 不存在。两边都回 `Command <name> not found` |
| fs | `size` | · | · | · | · | · | 有 | 有 |  |
| global-shortcut | `is_registered`, `register`, `unregister` | ✓ | · | · | · | · | 有 | 有 |  |
| global-shortcut | `register_all` | · | · | · | · | · | 无 | 无 | 清单有、2.3.2 没有编译 |
| global-shortcut | `unregister_all` | · | · | · | · | · | 有 | 有 |  |
| http | `fetch`, `fetch_cancel`, `fetch_cancel_body`, `fetch_read_body`, `fetch_send` | ✓ | · | · | · | · | 有 | 有 | 作用域见下表 |
| image | `from_bytes`, `from_path` | ✓ | ✓ | ✓ | · | · | 报错 | 报错 | 本构建没开 `image-ico`/`image-png`，两边都恒报 `<命令> is only supported if the ...`，不读文件也不解码（W06 `039b5794` 修正了此前 Electron 读任意路径的多放行） |
| image | `new`, `rgba`, `size` | ✓ | ✓ | ✓ | · | · | 有 | 有 |  |
| menu | `append`, `create_default`, `get`, `insert`, `is_checked`, `is_enabled`, `items`, `new`, `popup`, `prepend`, `remove`, `remove_at`, `set_accelerator`, `set_as_app_menu`, `set_as_help_menu_for_nsapp`, `set_as_window_menu`, `set_as_windows_menu_for_nsapp`, `set_checked`, `set_enabled`, `set_icon`, `set_text`, `text` | ✓ | ✓ | ✓ | · | · | 有 | 桩 | RF-W23-menu-tray-js-api-unprovided（proposed）：前端不调用，原生菜单由 `electron/shell/menu.ts` 构建 |
| notification | `batch`, `cancel`, `check_permissions`, `create_channel`, `delete_channel`, `get_active`, `get_pending`, `list_channels`, `permission_state`, `register_action_types`, `register_listener`, `remove_active`, `show` | ✓ | · | · | · | · | 无 | 无 | 只有移动端注册 |
| notification | `is_permission_granted`, `notify`, `request_permission` | ✓ | · | · | · | · | 有 | 有 |  |
| opener | `open_path`, `open_url`, `reveal_item_in_dir` | ✓ | · | · | · | · | 有 | 有 | 作用域见下表；`open_path` 另有 RF-W23-opener-open-path-executables（实现层拒绝可执行文件） |
| path | `basename`, `dirname`, `extname`, `is_absolute`, `join`, `normalize`, `resolve`, `resolve_directory` | ✓ | ✓ | ✓ | · | · | 有 | 有 |  |
| process | `exit`, `restart` | ✓ | · | · | · | · | 有 | 有 |  |
| resources | `close` | ✓ | ✓ | ✓ | · | · | 有 | 有 |  |
| tray | `get_by_id`, `new`, `remove_by_id`, `set_icon`, `set_icon_as_template`, `set_icon_with_as_template`, `set_menu`, `set_show_menu_on_left_click`, `set_temp_dir_path`, `set_title`, `set_tooltip`, `set_visible` | ✓ | ✓ | ✓ | · | · | 有 | 桩 | RF-W23-menu-tray-js-api-unprovided（proposed）：应用没有托盘图标 |
| updater | `check`, `download`, `download_and_install`, `install` | ✓ | · | · | · | · | 有 | 有 | RF-W23-updater-ignore-page-options（实现层忽略页面给的端点与参数） |
| webview | `clear_all_browsing_data`, `set_webview_background_color`, `set_webview_focus`, `webview_close`, `webview_hide`, `webview_show` | · | · | · | · | · | 有 | 有 |  |
| webview | `create_webview`, `reparent`, `set_webview_auto_resize`, `set_webview_position`, `set_webview_size` | · | · | · | · | · | 有 | 桩 | 没有窗口放行 |
| webview | `create_webview_window`, `print`, `set_webview_zoom` | ✓ | · | · | · | · | 有 | 有 | 页面建窗：正式版忽略页面给的 `devtools`；label 不能与在用的 browser-content 重名 |
| webview | `get_all_webviews`, `webview_position`, `webview_size` | ✓ | ✓ | ✓ | · | · | 有 | 有 |  |
| webview | `internal_toggle_devtools` | ✓ | ✓ | ✓ | · | · | debug | debug | 正式版两边都回 `Command internal_toggle_devtools not found` |
| window | `activity_name`, `scene_identifier` | ✓ | ✓ | ✓ | · | · | 无 | 无 | Android / iOS 专有 |
| window | `available_monitors`, `close`, `current_monitor`, `cursor_position`, `get_all_windows`, `inner_position`, `inner_size`, `internal_toggle_maximize`, `is_always_on_top`, `is_closable`, `is_decorated`, `is_enabled`, `is_focused`, `is_fullscreen`, `is_maximizable`, `is_maximized`, `is_minimizable`, `is_minimized`, `is_resizable`, `is_visible`, `monitor_from_point`, `outer_position`, `outer_size`, `primary_monitor`, `scale_factor`, `start_dragging`, `theme`, `title` | ✓ | ✓ | ✓ | · | · | 有 | 有 |  |
| window | `center`, `create`, `destroy`, `request_user_attention`, `set_always_on_bottom`, `set_background_color`, `set_badge_count`, `set_closable`, `set_content_protected`, `set_decorations`, `set_effects`, `set_enabled`, `set_focus`, `set_focusable`, `set_fullscreen`, `set_icon`, `set_ignore_cursor_events`, `set_max_size`, `set_maximizable`, `set_min_size`, `set_minimizable`, `set_position`, `set_progress_bar`, `set_resizable`, `set_shadow`, `set_simple_fullscreen`, `set_size`, `set_size_constraints`, `set_skip_taskbar`, `set_theme`, `set_title`, `set_title_bar_style`, `set_visible_on_all_workspaces`, `show`, `start_resize_dragging`, `toggle_maximize`, `unminimize` | · | · | · | · | · | 有 | 有 | 只有 Host 能调（等同 Rust 代码直接调用） |
| window | `hide` | · | ✓ | · | · | · | 有 | 有 |  |
| window | `maximize`, `minimize`, `unmaximize` | ✓ | · | · | · | · | 有 | 有 |  |
| window | `set_always_on_top` | · | ✓ | ✓ | · | · | 有 | 有 |  |
| window | `set_badge_label` | · | · | · | · | · | macOS | 有 |  |
| window | `set_cursor_grab`, `set_cursor_icon`, `set_cursor_position`, `set_cursor_visible` | · | · | · | · | · | 有 | 桩 |  |
| window | `set_overlay_icon` | · | · | · | · | · | Windows | 有 |  |
<!-- builtin-acl-matrix:end -->

不在表里的：
- `plugin:log|log`：Rust 注册了 tauri-plugin-log 2.8，但没有 capability 引用 `log:*`，Tauri 按 ACL 拒绝；Electron 不注册 log，
  调用转给 Host，Host 回 `commandNotFound`（正式版文本同为 `Command plugin:log|log not allowed by ACL`）。
- 应用命令（不带 `plugin:` 前缀）走 Host 的 kernel ACL（W01，`host/e2e/security/kernel-acl.test.ts`）。

## 作用域对照（main 窗口）

其他窗口与调用方放行的命令两边都没有作用域（测试检查）。作用域条目写成 Tauri 变量形式，三个平台相同。
`$ELECTRON_USERDATA` 是 Electron 的 userData 目录（`electron/shell/scope.ts`）。

<!-- builtin-acl-scopes:begin -->
| 插件 | 命令 | 相同 allow 数 | 相同 deny 数 | 仅 Electron 的 allow | 仅 Tauri 的 deny | 仅 Electron 的 deny | 仅 Tauri 的 allow | 说明 |
|---|---|:-:|:-:|---|---|---|---|---|
| fs | `copy_file`, `create`, `ftruncate`, `mkdir`, `remove`, `rename`, `truncate`, `write`, `write_file`, `write_text_file` | 20 | 0 | — | — | `$APPDATA/plugins`, `$APPDATA/plugins/**`, `$APPDATA/slots/*/browser-profiles`, `$APPDATA/slots/*/browser-profiles/**`, `$APPLOCALDATA/EBWebView/**`, `$ELECTRON_USERDATA/**` | `$DESKTOP`, `$DESKTOP/**` | RF-W23-fs-read-write-scope-split（`$DESKTOP` 只读授权不放行写）；RF-W23-fs-deny-host-plugin-dir；RF-W23-fs-deny-browser-profiles；RF-W23-fs-deny-webview-data-user-data（userData 与 Windows 上 Tauri 版遗留的 WebView2 数据） |
| fs | `exists`, `fstat`, `lstat`, `open`, `read`, `read_dir`, `read_file`, `read_text_file`, `read_text_file_lines`, `read_text_file_lines_next`, `seek`, `stat`, `unwatch`, `watch` | 22 | 0 | — | — | `$APPDATA/plugins`, `$APPDATA/plugins/**`, `$APPDATA/slots/*/browser-profiles`, `$APPDATA/slots/*/browser-profiles/**`, `$APPLOCALDATA/EBWebView/**`, `$ELECTRON_USERDATA/**` | — | RF-W23-fs-deny-host-plugin-dir；RF-W23-fs-deny-browser-profiles；RF-W23-fs-deny-webview-data-user-data。以写模式 `open` 时按 `write_file` 的作用域判定（RF-W23-fs-read-write-scope-split） |
| fs | `scope-app-index`, `scope-app-recursive` | 0 | 0 | — | — | `$APPDATA/plugins`, `$APPDATA/plugins/**`, `$APPDATA/slots/*/browser-profiles`, `$APPDATA/slots/*/browser-profiles/**`, `$APPLOCALDATA/EBWebView/**`, `$ELECTRON_USERDATA/**` | `$APPCACHE`, `$APPCACHE/**`, `$APPCONFIG`, `$APPCONFIG/**`, `$APPDATA`, `$APPDATA/**`, `$APPLOCALDATA`, `$APPLOCALDATA/**`, `$APPLOG`, `$APPLOG/**`, `$DESKTOP`, `$DESKTOP/**`, `$DOCUMENT`, `$DOCUMENT/**`, `$DOWNLOAD`, `$DOWNLOAD/**`, `$PICTURE`, `$PICTURE/**`, `$RESOURCE`, `$RESOURCE/**`, `$TEMP`, `$TEMP/**` | 不是命令，两边都没有处理函数（见上表）。RF-W23-fs-read-write-scope-split 把只有作用域的权限绑定到同一权限集里的命令，这两个名字因此在 Electron 里没有 allow |
| http | `fetch`, `fetch_cancel`, `fetch_cancel_body`, `fetch_read_body`, `fetch_send` | 42 | 0 | — | — | — | — | 与 Tauri 相同 |
| opener | `open_path` | 13 | 0 | — | — | — | — | 与 Tauri 相同 |
| opener | `open_url`, `reveal_item_in_dir` | 4 | 0 | — | — | — | — | 与 Tauri 相同 |
<!-- builtin-acl-scopes:end -->

表里的 deny 在 macOS / Windows 上另按大小写折叠后的写法匹配（RF-W23-fs-deny-case-insensitive），Windows 上还去掉 NTFS 流后缀
（RF-W23-fs-deny-ntfs-stream-suffix），asset 作用域同样；allow 与 Linux 仍逐字比较。

## 对拍结论（任务 4）

- 命令级：三个平台、五类调用方上，Electron 放行的内置插件命令与 Tauri 完全相同，没有多放行或少放行。
- 实现级：
  - 本轮修掉的多放行（`58ddcbc0`）：正式版里页面能通过 `create_webview_window` 打开 DevTools，`internal_toggle_devtools` 也可用；
    Tauri 正式版没有 `devtools` 特性，两者都不存在。同一提交让页面建窗不能占用在用的 browser-content label。
  - `image|from_bytes` / `from_path` 的多放行已由 W06 `039b5794` 修正（INT `2be7ed80`），矩阵测试按实际抛出的错误文本固定。
  - 少放行：menu / tray 的 JS API，登记 RF-W23-menu-tray-js-api-unprovided（proposed），外壳在 ACL 之后明确报不支持，不再转给 Host（`5f585e05`）。
- 报错文本：ACL 放行但桌面版没有编译的命令，页面现在得到与 Tauri 相同的 `Command <name> not found`（`e5a0a1e5`）。
- 作用域：Electron 只会比 Tauri 更严，每一处差异都引用了已登记的 RF。

## 审查（任务 3，依据 reviews/ELECTRON-SHELL-SECURITY.md SEC-E05）

### W01 `host/kernel/protocol.ts:73-79`（FrontendEvent）

问题：`FrontendEvent` 没有字段区分“main 根据 browser-content 原生回调生成的事件”和“页面经 `plugin:event|emit` 发出的事件”，
Host 侧只能看 `source.webview` 这个 label。

利用路径：browser 插件把 `source.webview === 'browser-content'` 的 `dstu-browser://page-finished` / `title-changed` /
`navigation-blocked` 当作内容页的真实状态交给 Agent。现在挡住伪造的只有两层：外壳 ACL（browser-content 没有任何 `plugin:event` 命令，SEC-E05）
和 label 唯一性（`58ddcbc0` 之后，页面不能在 browser-content 存活时占用它的 label）。只要以后有一个 capability 给 browser-content
加上 `core:event`（例如为某个功能把 `core:default` 放进 `browser-content.json`），或者出现 label 复用（见 W06 交接第 5 条），
页面脚本就能 `emit('dstu-browser://page-finished', { url: '<伪造地址>' })`，Agent 会把伪造的地址和标题当作当前页面，或者收到伪造的“导航被拦截”。

W01 已按此实现（`assault/W01-kernel` `2919cc58`，尚未进 INT）：Host 只认消息顶层的 `native === true`，交给监听者为
`source.native === true`，`source` 里自称的 `native` 丢弃。

### W05 `host/plugins/browser/src/surface-host.ts:182-185`

问题：`fromContent` 只检查 `source?.webview !== BROWSER_CONTENT_LABEL`。label 由应用选择、可以复用（Linux 上独立的 browser-content 窗口也叫这个名字），
不能证明事件来自 main 的原生回调。

利用路径：同上。label 一旦被冒用，或者 browser-content 拿到 `core:event`，伪造的事件就会进入 `pageFinished` / `titleChanged` / `navigationBlocked`。

### SEC-E05 外壳侧最终接口（本轮，`48c21aa6`）

- 外壳发给 Host 的 `frontend-event` 都由 `electron/shell/events.ts` 构造：
  - `pageFrontendEvent(source, event, payload, target)`：页面经 `plugin:event|emit` / `emit_to` 转发（`plugins/event.ts` `forwardToHost`）。
    新建对象，只有 `kind / event / payload / target / source` 五个键，`source` 只取 `window / webview`；类型为 `FrontendEvent & { native?: never }`。
  - `nativeFrontendEvent(source, event, payload, target = App)`：main 自己生成的事件，消息顶层 `native: true`。入口是
    `ShellRuntime.sendNativeEvent(event, payload, source, target?)`（`runtime.ts`）；`nativeBrowserContentEvent`（`browser-content-events.ts`）现在是它的别名，签名不变。
- 字段可选：W01 的字段进 INT 之前，Host 收到多出的 `native` 不报错，只是不交给监听者。
- `host/e2e/security/shell-builtin-acl.test.ts` 的 “SEC-E05 [W23] a page emit never reaches the Host with the native marker…”：
  主窗口、快速助手、番茄钟三个能 emit 的窗口，把 `native` 放在参数顶层、payload、伪造的 source、target 里，或经 JSON `__proto__`，
  转给 Host 的消息都恰好五个键、没有 `native`；只有 `sendNativeEvent` 发出的带 `native: true`。
- 后续（见“交接”）：W05 `surface-host.ts:184` 要求 `source?.native === true`；W06 把全局快捷键事件切到 `sendNativeEvent`；W03 快速助手监听可要求同一标记。

## ELECTRON-SHELL-SECURITY.md 中仍归 W23 的事项（任务 6）

- SEC-E01 / E03 / E04 / E07：已在前几轮完成，`host/e2e/security/shell-builtin-acl.test.ts` 不再有 `it.fails`。
- SEC-E05：外壳侧完成（ACL 拒绝 browser-content 的 emit；页面事件与原生事件分开构造，原生事件带 `native: true`，见上一节）。Host 侧等 W01 进 INT 后由 W05 / W03 收紧监听。
- SEC-T01：RF-W23-opener-open-path-executables 已批准。
- SEC-E06 中与 fs 相关的一项：`capabilities.ts` 已写明插件管理器只能经 Host 安装（`5a3a48e0`），RF-W23-fs-deny-host-plugin-dir 挡住 `$APPDATA/plugins`。
  其余部分（同意流程、社区 UI 隔离）归 W01 / W17。

## 后台驻留（V04-02，本轮）

模块 `electron/shell/background-residency.ts`（`772be8d0`），测试 `electron/tests/background-residency.test.ts`。main 的接线归 W06（见交接）。

| 项 | Rust（`src-tauri/src/lib.rs`） | Electron |
| --- | --- | --- |
| 触发 | 主窗口 `CloseRequested`（:1714） | 主窗口 `close` 事件，挂在 WindowManager 自己的监听之后 |
| 显式退出不拦截 | `automation_app_is_exiting()`，`ExitRequested` 时标记（:3249-3252） | `markExiting()`：`before-quit`、Windows `session-end`、`powerMonitor` `shutdown`、main 有序退出（`process` 插件 exit / restart） |
| 条件：快速助手 | `quick_assistant.background_enabled == "true"`，读不到为 false | 相同 |
| 条件：自动化 | `should_keep_automation_background`（automations.rs:4779-4792）：`automation_background_enabled != "false"`（读取失败为 true）且有启用的自动化（读取失败为 false） | 相同。Host 入口直接用 `shouldKeepBackground`；降级用 `get_setting` + `chat_v2_automation_list` |
| 条件：Super | `super_agent.enabled` trim 后为 `"true"` / `"1"`，读不到为 false | 相同，trim 用 `rustTrim`（Rust 的空白定义） |
| 驻留动作 | `prevent_close` + `hide` | `preventDefault` + `hide`。判定要异步问 Host，所以先隐藏再问；页面自己接管关闭时不先隐藏 |
| 通知 | 策略不是 `never` 才发；标题 “Deep Student 正在后台运行”；正文按自动化、Super、快速助手的顺序用“；”连接、“。”结尾 | 相同文本与顺序；通知失败只记日志 |
| 只弹一次 | 没有这条规则：每次驻留关闭都发 | 相同，测试固定为每次都发 |
| 都不满足：macOS | 标记退出 + `app.exit(0)`（:1770） | `markExiting` + 有序退出 `shutdown.quit(0)` |
| 都不满足：Windows / Linux | 不处理，最后一个窗口关闭即退出 | 相同；另有 RF-W23-close-main-quits-with-only-hidden-windows（只剩隐藏窗口时退出） |
| 唤回 | 第二实例 show + unminimize + set_focus（:695-701）；macOS Reopen show + set_focus + activate（:3270-3285） | `showFromSecondInstance` / `showFromReopen`（`app.focus({ steal: true })`），同时取消尚未执行的判定 |
| 读取 | 同步读设置 | Host 5 s 内没有回答按“读不到”处理（三项都为 false，照常关闭）；只执行最新一次关窗请求的判定 |

## 跨平台自查（任务 4，本轮）

V10（`.reports/reviews/V10-cross-platform.md`）没有 `electron/shell/**` 的条目，并把 scope / glob / asset-protocol 列为与 Tauri 一致。自查结果：

- 一致：glob 逐字符比较、区分大小写（Tauri `case_sensitive: true`）；Windows 上 `/` 与 `\` 等价，`*` 不跨任一分隔符；
  Unix 要求前导点字面匹配、Windows 不要求；UNC、设备命名空间、verbatim 前缀的组件重组；
  8.3 短名与 subst 盘经 `realpathSync.native`（libuv `GetFinalPathNameByHandleW`）展开，与 Rust `canonicalize` 相同；Linux 大小写敏感。
- 修正（`6c9268d4`，对齐移植，不是 RF）：libuv 的 realpath 去掉 `\\?\` / `\\?\UNC\` 前缀，Rust `canonicalize` 保留，
  于是模式集合和待判定路径的形态都与 Tauri 不同：不存在的 verbatim 路径被误拒，verbatim UNC 目录下不存在的路径被误放。
  现在补回前缀；Tauri 的 `windows_root_paths` / `push_pattern_generated_paths` 用例移植为测试。
- RF-W23-fs-scope-missing-path-canonical-ancestor（`f00053fa`，rust-bug，proposed）：不存在的路径按最近的已存在祖先 canonicalize 后再判定。
  修复前在 macOS / Windows 上写 `$APPDATA/PLUGINS/x.js` 能绕过 `$APPDATA/plugins/**` 的 deny（Rust 版同样可以）。
  它只覆盖“`plugins` 已按小写存在”这一种情况；其余写法由第二轮的 RF-W23-fs-deny-case-insensitive 处理（见下一节）。
- RF-W23-fs-win32-verbatim-parent-segment（`4f770f00`，deliberate，proposed）：Windows 上 `plugin:fs` 的路径按两种分隔符逐段查 `..`，
  因为 Node 的 fs 会把 `\\?\UNC\srv\share/../other` 这类 Rust 交给系统时非法的路径规范化成别处。
- 测试：`fs-scope-platforms.test.ts`、`fs-scope-missing-path.test.ts`、`fs-safe-path-win32.test.ts`，文件系统经 `ScopeFileSystem` 注入（`tests/__fixtures__/scope-fs.ts`）。

## 其他（本轮）

- V09 P3-5（`728a5fd8`）：`start_dragging` 每次挂的 `once('blur')` 在拖动正常结束时撤掉，不再随拖动次数累积。
- S01 复审第 2 轮 I1（`plugins/system.ts:113-118` `openWith`，Windows 上 `cmd /c start "" program target` 不加引号）：未改实现，加测试固定“不可达”。
  - 复审说 open crate 在这里用 `wrap_in_quotes`，但本构建不走这条路：tauri-plugin-opener 2.5.3 给 open 5.3.3 开了 `shellexecute-on-windows`，
    `with_detached` 在 Windows 上是 `ShellExecuteExW(lpFile = app, lpParameters = path)`，没有 cmd，也没有 `%VAR%` 展开。
  - Electron 没有原生模块就调不到 `ShellExecuteExW`；`cmd` 加引号挡不住 `%VAR%`，`rundll32 ShellExec_RunDLL` 的参数切分没有文档，本机也验证不了 Windows 行为，所以不在这里改。
  - 三个平台的 capability 都没有带 `app` 的 opener 条目，`openWith` 不可达。`opener-executables.test.ts` 的 “S01-r2 I1 [W23] …” 用 `deriveScopes` 读真实 capability 固定这一点：
    以后谁给 opener 条目加上 `app`，测试就失败，届时须先把 Windows 分支换成 ShellExecute 语义。

## 第二轮接手（2026-11-07，基于 INT `390f244b`）

### V04-02 外壳侧收尾

- `353cc707`：驻留查询带 `caller: 'dstu.agent-orchestration'`（`RESIDENCY_HOST_CALL.caller`）。不带时，内核切到 `require` 模式
  （`DS_HOST_CALL_CALLER=require`）后 `plugin:host|call` 直接被拒，外壳每次关窗都退回降级读取。
  - `background-residency.test.ts` 新增 “the Host entry agentAutomation.backgroundResidency (W02 37847c93)” 组 4 例，用真实内核加 stub 插件，
    覆盖 `warn` / `require` 两种模式、别的插件冒充提供方时降级、`caller` 与 `host/profiles/desktop.json` 一致。
  - 另用 W02 `37847c93` 的真实插件临时核对过一次，结果见 `.reports/W23-handoffs/README.md`。
- W06 接线补丁按 INT 重做：`.reports/W23-handoffs/W06-background-residency-390f244b.patch`；INT 前进后又按 `2be7ed80` 重做一份
  `W06-background-residency-2be7ed80.patch`（改动相同，`git apply` 直接打上，打上后 `tsc -p tsconfig.host.json` 通过）。旧的 `W06-background-residency.patch` 保留。
  真实 Electron 接线测试在 390f244b 上临时打上补丁跑过一次，2/2 通过，已还原；本轮只允许起一次 Electron，2be7ed80 上没有重跑。
  W06 自己的 `84dc82e8` / `73dcee75` 先进 INT 时这份补丁作废。

### S01 第三轮 M2：`$APPDATA/plugins` 的 deny 区分大小写

- RF-W23-fs-deny-case-insensitive（deliberate，proposed），`68b9fe41`、`d75ca829`。
- 在 INT 390f244b 上仍能绕过的写法（macOS 不区分大小写的 APFS 实测）：
  1. `plugins` 还不存在时，`mkdir $APPDATA/Plugins`（或 `PLUGINS`、`pluginſ`）后写入 `user.profile.json`；
  2. 先在 `$APPDATA/staging` 写好 profile，再 `rename staging → $APPDATA/Plugins`，一步落地；
  3. 目录在 fs 命令的作用域建好之后才以另一种大小写建出来时，任何写法（包括小写 `plugins`）都能写入，
     因为 `aclScope` 按建作用域那一刻的磁盘大小写快照 deny 模式；
  4. `slots/<slot>/browser-profiles` 同理，可以预先建出 `Browser-Profiles` 并读出其中内容。
- 修复（`scope.ts`）：
  - macOS / Windows 上 deny 另外按 `foldForDeny` 比较：NFD 后每个字符 lower → upper → lower，再 NFD。
    这样覆盖 APFS 的完整大小写折叠与规范化不敏感（`ſ`、`K`（开尔文）、`ß`/`ẞ` ≡ `ss`、`ﬁ` ≡ `fi`、NFC ≡ NFD，本机实测都指向同一目录）；
  - 原来的逐字匹配保留；allow 仍是 Tauri 的逐字 glob；Linux 不变。
- 测试：
  - 单元 `electron/tests/fs-scope-deny-case.test.ts`，6 例：折叠等价、目录不存在、建作用域后才以另一种大小写建出（含 Win32 8.3 短名）、Windows 写法、Linux 保持逐字、allow 不变；
  - e2e `host/e2e/security/shell-builtin-acl.test.ts` 4 例，只在不区分大小写的 macOS 上运行：一例固定 S01 原复现（`568a720f`），三例 RF。
- HANDOVER.md 第 16 行与 W27 报告称 M2 已由 `f00053fa` 完全修复，不准确：`f00053fa` 只修了 S01 给出的那一种复现。

### 交付后跟进（未做）

- Windows NTFS 流写法：已按 RF-W23-fs-deny-ntfs-stream-suffix 在 deny 侧去掉流后缀（`stripNtfsStreams`，单元测试 `fs-scope-deny-ntfs-stream.test.ts`）。
  `plugins::$INDEX_ALLOCATION` 就是目录本身，有 Git CVE-2019-1352 为证；但本机是 macOS，没有在真实 Windows 上跑 e2e，需要 Windows 实机补一次
  （`mkdir` / `write_text_file` / `rename` 到 `$APPDATA\plugins::$INDEX_ALLOCATION` 都应得到 forbidden path）。
  ~~Win32 结尾点、空格不构成绕过~~：只对盘符路径和 `\\?\` 路径成立；`\\.\` 设备路径 Node 不加前缀，会被 Win32 去掉，第三轮已修（见下）。
- ~~RF-W23-fs-scope-missing-path-canonical-ancestor（已批准）的 userVisible 说明只写了“已存在目录的大小写写法”~~：第三轮已按 A08 文本改准。
- fs 命令作用域（`plugins/fs.ts` `aclScope`）按首次建出时的磁盘大小写缓存 deny 模式；有了折叠后不再影响 deny，但 allow 侧的 canonical 形态同样是快照，与 Tauri（构造时一次 canonicalize）相同，没有改。

## 第三轮（2026-11-07 15:28，INT `2be7ed80`，A08 复核 `6daff78f` 有条件通过）

- **MF-1**（`4a2bbf42`，并入 RF-W23-fs-deny-ntfs-stream-suffix，标题改为“Windows 名称等价”）：`\\.\` 设备路径（含 `//./`、`\\.\UNC\`、
  `\\.\GLOBALROOT\`、`\\.\Volume{…}\`）Node 不加 `\\?\`，Win32 规范化去掉组件末尾的点和空格；`plugins` / `browser-profiles` 还不存在时
  `rename staging → \\.\C:\…\plugins.` 判为允许，系统却落到真正的 `plugins`。修法：win32 上 deny 候选再加 `trimWin32Trailing`
  （根之后每个组件去掉末尾点和空格，空组件丢弃），对流后缀剥离后的形态也做；只多拒。
  - 假文件系统（`__fixtures__/scope-fs.ts`）按 Win32 规则规范化 `\\.\C:\`、`\\.\UNC\` 路径。
  - 单元 `fs-scope-deny-win32-trailing.test.ts` 4 例；修复前目录不存在时 12 种写法 10 种判为允许。
  - e2e `shell-builtin-acl.test.ts` 新增 2 例，只在 Windows 运行（`\\.\` 尾点 / 空格、NTFS 流）。
- **MF-2**（`7da701ef`）：已批准的 RF-W23-fs-scope-missing-path-canonical-ancestor 的 userVisible 换成 A08 给的文本，status 不动。
- e2e 条件（`29aa7264`）：harness 在 Windows 上改用 win32 路径与作用域（原来一律按 linux），四例大小写用例改为“大小写不敏感的非 Linux 平台”运行。
- 测试替身（`97cec746`）：`background-residency.test.ts` 的 stub `meta.remote` 与 W02 `37847c93` 一致，只有 `backgroundResidency`。
- Win32 其他等价写法自查：8.3 短名、`\\?\`、UNC 回环、正反斜杠混用都没有找到绕过，依据写在交付报告里。
  ~~重复分隔符不构成绕过~~：A14 指出设备前缀或 UNC 前缀后多一个分隔符（`\\.\\C:\…`、`\\srv\\share\…`）的不存在路径会被压成无盘符的根路径，第四轮已修（见下）。
- 未做（写成设计放进报告）：受保护目录里已有的符号链接本身不判 deny；改名 `slots` / `slots/<x>` 这类 deny 根的祖先后能读到 `browser-profiles`。第四轮已按设计完成。

## 第四轮（2026-11-07 16:00，INT `1d1fdb78`，A14 复核 `28d9d042` 无必修项）

- 合 INT `1d1fdb78`（`92934f2d`），无冲突，本 lane 用例都在。
- **A14-1**（`bd3d4b82`，RF-W23-fs-scope-literal-win32-normalize，deliberate，proposed）：win32 上不存在的路径先 `path.win32.normalize` 再取字面形态。
  修复前用户授权过 `C:\` 时，`mkdir \\.\\C:\…\plugins` 判为允许（deny 不命中、运行时 allow 命中）。假文件系统改为按 Node 先 normalize 非 `\\?\` 路径、无盘符的根路径落到 `C:`。
  单元 `fs-scope-literal-win32.test.ts` 2 例。
- **3c-a**（`4fb22176`，RF-W23-fs-deny-protected-ancestor，deliberate，proposed）：`plugin:fs|rename` 两端、递归 `remove` 的目录，
  只要某条 deny 能匹配到它之下的路径（`mayMatchBelow`，逐组件匹配，`**` 视为可达）就拒绝。
  - 修复前可行：改名 `slots` / `slots/<x>` / `$APPDATA`（`scope-appdata-recursive` 放行 `$APPDATA` 本身）把 `browser-profiles`、`plugins` 带出 deny；
    把准备好的目录改名到新 slot 或 `$APPDATA` 植入 `plugins/user.profile.json`；Windows 上改名 `EBWebView` 目录本身。
  - 前端核对：`src/**` 没有 `plugin:fs` 的 rename；remove 只有两处，都是非递归删除托管目录里的单个文件
    （`libraryStore.ts:499` 的 `$APPDATA/tmp_apkg_import/*`、`wallpaperLibrary.ts:358` 的 `$APPDATA/workbench-wallpapers/*`）。槽位切换、备份恢复在 Host 里用 Node fs 完成，不经外壳。
    e2e 固定这些以及槽位内文件与其他目录的改名、递归删除仍然可用。
  - 单元 `fs-scope-deny-ancestor.test.ts` 5 例；e2e `shell-builtin-acl.test.ts` 4 例。
- **3c-b**（`2a1825b7`，RF-W23-fs-deny-symlink-entry，deliberate，proposed）：deny 另按请求的字面形态与目录项本身的位置（父目录规范化后拼回最后一个组件）判定，
  受保护目录里指向 allow 区的链接不能被改名覆盖、删除、读取或经它写入；相对链接目标按链接所在目录解析（原来按进程 cwd）。
  单元 `fs-scope-deny-symlink-entry.test.ts` 5 例（真实文件系统一例不在 Windows 上跑）；e2e 1 例（不在 Windows 上跑）。
- **K2**（`7f203b82`）：驻留查询自 `353cc707` 起就带 `caller`；新增测试在内核默认 caller 模式下拿到 Host 回答（W01 `412c9fef` 进 INT 后默认是 `require`），
  并固定它是 `electron/` 源码里唯一的 `plugin:host|call`。
- **osName**（`609dcd2e`，LA-07 / LA-09）：`BridgeInit.osName` 加上 `'android' | 'ios'`，类型测试 `bridge-init-os-name.test.ts`。`preload/bridge.ts:44` 归 W06（见交接）。
- 未做：A14 跟进 3（假文件系统支持 `\\.\GLOBALROOT\`、`\\.\Volume{…}\`）、跟进 5（UNC 路径的 deny，低）；Windows 实机 e2e 仍缺。

## 第五轮（2026-11-07 16:50，INT `065a68f3`，A19b 复核 `faaf6d40` 通过）

- 合 INT `065a68f3`（`75dd3920`），无冲突；与 INT 的差异只有本 lane 的 20 个文件。
- **asset 作用域 deny**（`b3672ab7`、`8848efac`，RF-W23-asset-scope-protected-deny，deliberate，proposed）：`capabilities.ts` 从 fs 的两张表推出
  `PROTECTED_FS_DENY`，`withProtectedDeny(deny)` 把它补在 asset 作用域的 deny 后面；`fsScopeFromPatterns` 不变，opener 不受影响。
  单元 `asset-scope-protected-deny.test.ts` 3 例；e2e 2 例。Cookies 一例读 `main.ts` 的 assetScope 行：未接线时是 `it.fails`，接线后自动按 `it` 跑。
  `main.ts` 一行接线和 `asset-protocol.test.ts` 一例归 W06：`.reports/W23-handoffs/W06-asset-scope-deny.{md,patch}`。
- **LA-11 / L02 F12**（`4da3d84d`，RF-W23-residency-host-unavailable-closes，deliberate，proposed）：只登记、不改行为。Host 不可用时
  降级读取并告警，读取全部失败时按 Rust 的读取失败缺省（全不成立）关闭或退出。另一种做法（超时只隐藏、不退出）的理由写在本轮交付报告里。
- **RF 措辞**（`7d48f839`、`5dea3427`、`8b71907d`）：A19b 跟进 4，只改文字，含三条 RF 的撤回步骤。
- **K2 扫描**（`41916128`）：跳过点开头的目录（`electron/.build/`）。
- **A14 跟进 3**（`d2a5a482`）：假文件系统支持 `\\?\` / `\\.\` 加 `Volume{…}` 或 `GLOBALROOT\Device\HarddiskVolumeN`，`fs-scope-win32-volume-paths.test.ts` 3 例。
  scope.ts 无需改动：canonicalizeParent 经 realpath 还原为 `C:\…`，deny 照常命中。
- 未做：A19b 跟进 3（Windows junction 实例，需要 Windows 环境）、跟进 2（相对链接按词法拼接，低）。

## 交接

W06 各条按 INT `2be7ed80`（含 W06 交付 `039b5794`）核对；下面 0–6 条的原始行号对应 W06 `ed79ba46`。

| 条目 | INT 2be7ed80 |
|---|---|
| 0 后台驻留接线 | **仍未接**。W06 分支上的 `84dc82e8` / `73dcee75` 不在 `039b5794` 里。可用 `.reports/W23-handoffs/W06-background-residency-2be7ed80.patch` |
| 1 拖放目录递归放行 | 已改（`main.ts:524`） |
| 2 browser-content 事件带 `native` | 已改（`main.ts:359-360` `nativeBrowserContentEvent`） |
| 3 渲染进程消息先过 `checkRendererMessage` | 已改（`main.ts:475`） |
| 4 全局作用域展开 `$ELECTRON_USERDATA` | 已改（`main.ts:199-202` `fsScopeFromPatterns`） |
| 5 页面已建出 `browser-content` 应用窗口时拒绝注册同名内容页 | 已改（RF-W06-browser-content-label-taken，`browser-surface.ts:142-143`） |
| 6 `image\|from_path` / `from_bytes` 按本构建报错 | 已改（`images.ts:49-58`）；上面 ACL 表 image 一行的说明仍写着“Electron 多放行”，按 INT 现状已不成立，见下 |

全局快捷键事件（`main.ts:262`）在 INT 上仍是手写的 `frontend-event`，没有 `native: true`；接线补丁里包含这一处。

- **W06**
  0. 后台驻留接线：对 INT 用 `.reports/W23-handoffs/W06-background-residency-390f244b.patch`（`git apply` 直接打上，说明见同目录 `README.md`）；
     下面是旧版 `.reports/W23-handoffs/W06-background-residency.patch`（对 `ed79ba46`）的内容，两版改动相同。
     需要 W23 的 `48c21aa6`（`ShellRuntime.sendNativeEvent`）已在 INT。内容：
     - `:22` 引入 `BrowserWindow`、`powerMonitor`；`:33` 前引入 `BackgroundResidency`、`countShownWindows`、`queryResidencyState`；
     - `:234-244` `orderedShutdown(runtime, beforeQuit)`，`quit` 开头调用 `beforeQuit()`（Rust 在 `ExitRequested` 时标记退出）；
     - `:280-281` 全局快捷键事件改用 `runtime.sendNativeEvent('global-shortcut://triggered', event, { window: 'main', webview: 'main' })`；
     - `:340`、`:350-353` `createWindowManager` 多一个 `residency` 参数，`afterCreate` 里 `if (win.label === 'main') residency.attachMainWindow(win)`；
     - `:547-557` `wireAppLifecycle` 多一个 `residency` 参数：`second-instance` 改为 `residency.showFromSecondInstance()`，并 `residency.install(app, powerMonitor)`；
     - `:732` 之前构造 `new BackgroundResidency({ platform, queryState: () => queryResidencyState((cmd, args) => invokeHostCommand(runtime, cmd, args), log), quit: () => shutdown.quit(0), log, shownWindowCount: () => countShownWindows(BrowserWindow.getAllWindows()) })`，
       `orderedShutdown(runtime, () => residency.markExiting())`；`:747`、`:753` 传入 `residency`。
     接线后应变绿的测试：`.reports/W23-handoffs/W06-background-residency-wiring.test.ts` → `electron/tests/background-residency-wiring-host.test.ts`，
     `.reports/W23-handoffs/W06-background-residency-host.ts` → `electron/tests/fixtures/background-residency-host.ts`。
  1. `:525`：拖放的目录以 `fsRuntime.allowDirectory(path, false)` 加入，只放行一层；Tauri 是递归的
     （tauri-plugin-fs-2.4.5 `src/lib.rs:455` `allow_directory(path, true)`），应改为 `true`。asset 作用域（`:526`）已是递归的。
  2. ~~`sendBrowserContentEvent` 改用 `nativeBrowserContentEvent`~~：W06 已完成（`:362-364`）。
  3. ~~渲染进程消息先过 `checkRendererMessage`~~：W06 已完成（`:477`）。
  4. `:721-731`：`new ShellRuntime({...})` 传 `userDataDir: app.getPath('userData')`；`:161-181` 的 `scopeFrom` 换成
     `fsScopeFromPatterns(paths, platform, allow, deny, app.getPath('userData'))`，让全局 fs 作用域也能展开 `$ELECTRON_USERDATA`。
  5. `:385-386`（`registerWebview`）：已有同名应用窗口（例如页面先用 `create_webview_window` 建了 `browser-content`）时，
     不应再注册 browser-content，按 Tauri 报 `a window with label ... already exists` / `a webview with label ... already exists`。
     可用 `runtime.windows.get(label)` 判断；反方向（页面建窗撞上在用的 browser-content）已在 `plugins/window.ts` 处理。
  6. `electron/shell/images.ts:41,49-50`：`from_path` / `from_bytes` 改为按本构建的 Tauri 报错（`from_path is only supported if the
     \`image-ico\` or \`image-png\` Cargo features are enabled`，`from_bytes` 同理）；`resolveImage` 收到路径或字节时报
     `expected RGBA image data, found a file path` / `found raw bytes`（tauri-2.11.5 `image/mod.rs:213-227`）。前端没有调用方。
     改完后把上表 image 一行的 Electron 列改成与实际一致。
- **W02**（`host/plugins/agent-orchestration/`）：1、2 已由 W02 `37847c93` 完成，3 由 `6f7c442e` 完成（订阅 `host/exiting` 并在 dispose 时兜底），都在 `assault/W02-agent-core`，尚未进 INT。
  外壳侧对应的 `caller` 见第二轮 `353cc707`。原交接内容保留如下。
  1. `index.ts:496` 的 `agentAutomation` 服务加 `backgroundResidency()`，返回
     `{ automation, superAgent, quickAssistant, notificationsDisabled }` 四个布尔值，口径与 `electron/shell/background-residency.ts`
     的 `residencyStateFromCommands` 相同：`automation` 即 `:544` 的 `shouldKeepBackground()`；`superAgent` 为 `super_agent.enabled`
     经 `rustTrim` 后是 `"true"` 或 `"1"`（读不到为 false）；`quickAssistant` 为 `quick_assistant.background_enabled === "true"`；
     `notificationsDisabled` 为 `system-notification-policy === "never"`（读不到为 false）。`api.ts:212` 的 `AgentAutomationService` 同步加上。
  2. `index.ts:120-131` 的 `meta` 加 `remote: { agentAutomation: ['backgroundResidency'] }`（内核 `runtime.ts:289` 据此放行
     `plugin:host|call`，且只放行本地窗口）。不要把 `markAppExiting` 放进 `remote`。
  3. Host 关停时调用 `markAutomationAppExiting()`（`src/automation-runtime.ts:57`）：Rust 在 `ExitRequested` 时标记（lib.rs:3249-3252），
     `automation-runtime.ts:497` 据此把退出时被取消的运行归类；现在 Host 从不调用它。可放在 `index.ts:377` 这个 `ctx.effect` 的清理函数开头。
  在此之前外壳自动用 `get_setting` / `chat_v2_automation_list` 按同一口径判定，每次关窗记一行降级日志。
- **W01**：`2919cc58` 已在 INT `2be7ed80`，与外壳接口一致，没有新的交接。
- **W05**：前提都已在 INT `2be7ed80`（W01 `2919cc58`；main 的 browser-content 事件经 `nativeBrowserContentEvent` 带 `native`，`main.ts:359-360`）。
  `host/plugins/browser/src/surface-host.ts:184` 现在可以改为
  `if (source?.native !== true || source.webview !== BROWSER_CONTENT_LABEL) return;`。
  验证：`host/e2e/security/shell-builtin-acl.test.ts` 的 “SEC-E05 [W23] a page emit never reaches the Host with the native marker…” 加上 W05 自己的 surface-host 测试。
- **W03**：`host/plugins/memory/src/quick-assistant.ts:86` 监听 `GLOBAL_SHORTCUT_TRIGGERED`。INT 上全局快捷键事件（`main.ts:262`）还不带 `native`，
  要等 W06 交接 0（补丁里含改用 `sendNativeEvent` 的一行）进 INT 后，回调才能要求 `source?.native === true`；提前改会让快捷键失效。
  不改时任意能 emit 的应用页面都能切换快速助手窗口（低危）。

W23 对外接口保持不变：`fsScopeFromPatterns`、`ShellRuntime` 的 `userDataDir` 选项、`checkRendererMessage`、`nativeBrowserContentEvent`。
本轮新增：`ShellRuntime.sendNativeEvent`、`nativeFrontendEvent` / `pageFrontendEvent`（`events.ts`）、`BackgroundResidency` 及其辅助函数
（`background-residency.ts`）、`FsScope` 的 `fs` 选项与 `ScopeFileSystem`（`scope.ts`）、`traversesParent`（`plugins/fs.ts`）、
`electronNotificationHooks` 改为导出（`plugins/system.ts`）。
第二轮新增：`foldForDeny`、`stripNtfsStreams`（`scope.ts`）、`RESIDENCY_HOST_CALL.caller`（`background-residency.ts`）。
