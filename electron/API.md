# F2 Host 公共接口

## 当前应用窗口（`shellWindows`）

从 `electron/api.ts` 导入类型/Context 增强，并在插件既有依赖中加 `inject: ['shellWindows']`。
提供者是 `dstu.shell`，底层经 `ctx.shell` 查询 Electron main 的实时窗口注册表。

```ts
import type {} from '../../../electron/api.ts';

const windows = await ctx.shellWindows.listWindows();
const emitWindow = windows.find(window => window.isMain) ?? windows[0] ?? null;
// emitWindow?.label 为目标窗口标签；不要用 focused 替代 Rust 的 main 优先规则。
```

- `listWindows(): Promise<ShellWindowSnapshot[]>`
  返回 `{ label: string, isMain: boolean, focused: boolean }[]`。包括消费者插件启动前已存在的窗口；
  只枚举本外壳管理的存活应用 webview 窗口，不包括 BrowserView/系统窗口。
- `getMainWindow(): Promise<ShellWindowSnapshot | null>`
  只查询 label 为 `main` 的存活窗口；不存在则 `null`，不自动改选其他窗口。
- 空窗口集为 `[]`。排序不作语义保证（Rust `Manager::webview_windows()` 是 HashMap）；
  `goal/runtime.rs:435-440` 的策略是同一快照中 main 优先，否则任意一个存活窗口。
- 这是当前状态快照，不预留窗口生命期。`focused` 读取原生 `BrowserWindow.isFocused()`。
  main 不可用/传输失败会 reject，不伪装成空列表。
- 原始 shell ops：`window.listWindows`、`window.getMainWindow`，参数均为 `{}`。
  返回值与服务相同；Host 服务逐元素检查响应字段类型，不信任无校验泛型断言。

证据：`tests/window-catalog-host.test.ts` 启动真实 Electron main 与真实 F2 Host 服务，
故意不重放 `host/window` 创建事件，验证既有 main、原生 focus 查询、创建 fallback、销毁 main。
`tests/window-catalog.test.ts` 验证空值/错误响应/服务不可用的边界。Linux/xvfb 不代表目标平台实测。

## 应用目录（shell op `app.dataDirs`）

操作系统目录只有一种传递方式：main 在 fork Host 之前写入环境变量 `DS_SHELL_OS_DIRS`
（`{home,data,dataLocal,config,cache}`，由 `shell/os-dirs.ts` 的 `resolveShellOsDirs` 计算；Windows 的
`dataLocal` 经 koffi 调 `SHGetKnownFolderPath(FOLDERID_LocalAppData)`，失败回落 `%LOCALAPPDATA%` 并记日志）。
Host 侧 `host/platform/paths/os-dirs.ts` 以它为准，启动时同步需要的目录（storage 的 sync 状态库、`.secure`、日志）
直接读 `ctx.paths.os`。`DS_APP_DATA_DIR` 生效时这五个目录一起换到 `<DS_APP_DATA_DIR>.os/home` 下按平台默认布局推导。

`await ctx.shell.request('app.dataDirs', {})` 返回同一次计算的结果（不会与环境变量出现两套值），供异步场景使用：

- `data: string | null`：与握手 `appDataDir` 相同（含 `DS_APP_DATA_DIR` 覆盖），即 Tauri `app_data_dir()`。
- `localData: string | null` / `cache: string | null`：Tauri `app_local_data_dir()` / `app_cache_dir()`。
- `dataLocalDir: string | null`：`dirs::data_local_dir()`（macOS `~/Library/Application Support`，
  Linux `$XDG_DATA_HOME`（绝对路径）否则 `~/.local/share`，Windows `FOLDERID_LocalAppData`）。
  Rust 的 `<data_local_dir>/deep-student/sync/sync_state.db` 与 `.secure` 回退目录以它为根。

证据：`tests/shell-restart-host.test.ts`（真实 main 往返，校验 `DS_SHELL_OS_DIRS` 与 `app.dataDirs` 一致且已隔离）、
`tests/os-dirs.test.ts`（三平台计算与隔离、Host 解析往返）、`tests/known-folders.test.ts`（Windows 查询桩与回落）、
`tests/logic.test.ts`（三平台算法）。

## 页面平台信息（`window.__DS_PLATFORM__`，FE-A5）

preload 在页面任何脚本之前用 `contextBridge.exposeInMainWorld` 暴露（`preload/preload.ts`），每个加载了本外壳 preload 的
webview 都有（应用窗口与内嵌浏览器同等，信息量不超过已有的 `__TAURI_INTERNALS__` / OS 名）：

```ts
interface DsPlatformInfo {
  readonly kind: 'desktop';           // 移动端外壳以同一全局给出 'mobile'
  readonly os: NodeJS.Platform;       // process.platform：'darwin' | 'win32' | 'linux'
  readonly arch: NodeJS.Architecture; // process.arch：'arm64' | 'x64' …
}
```

- 对象已冻结，`window` 上的属性不可写、不可重定义：页面脚本改不了字段，也换不掉整个对象。
- 供前端平台服务（`src/ui-kernel/services/platform.ts`，W17）选择实现；没有本外壳 preload 的环境（浏览器开发、单元测试）里该全局不存在，消费方须容忍缺失。
- 只是只读描述，不携带任何能力；不要据此跳过权限检查。

证据：`tests/smoke.test.ts`（真实 Electron 页面读到 `{ kind: 'desktop', os: process.platform, arch: process.arch }`，
冻结、不可写、不可重定义；页面尝试改写后值不变）。
