# 社区插件的安全边界

本文按当前代码的实际行为写：社区插件能做什么、不能做什么，以及哪些限制只防误用、挡不住恶意插件。每条都给出做检查的代码和
守住它的测试；`examples/testing/docs.test.ts` 核对文中的路径与符号，最后一列是“测试”的表格每行都要引用测试文件，行里的错误码要
出现在引用的测试里。插件的写法见 `docs/plugins/SDK.md`。

## 1. 结论

**社区插件没有物理隔离。** Host 半在 Host 进程里运行，UI 半在主窗口页面的主世界里运行，与应用代码同一个 realm。
当前 `restricted`（受限）与 `full`（完全信任）是同意及权限声明分档，不是沙箱：full 仅跳过 `service:*` 声明限制，
不豁免 K1/K7、精确版本/权限同意及安全模式。安装或启用前仍须理解同进程执行代码的风险。

本轮 K1 收口堵住框架 API 的直接上下文遍历与 installer 对象转发，**不宣称能阻止同进程的所有越权方式**。
恶意插件仍可能利用共享闭包、原型、其他原生对象或 Node 能力绕过框架防误用检查；不要把访问一个受限 `ctx` 当成可信代码审查
或进程隔离的替代。第三批 K4–K6 的独立进程、受控 RPC 与能力代理才负责物理隔离，本轮没有实现它们。

隔离的设计与进度：Host 半见 `host/kernel/SEC-E06-HOST-ISOLATION-PLAN.md`（K0–K7），UI 半见
`src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md`。

## 2. 插件代码执行之前：清单筛查

Host 启动时先读社区条目旁边的 `package.json#deepStudent`（`host/kernel/profile.ts` `screenProfileEntry`、`host/kernel/manifest.ts`
`checkManifest`），不通过的包**不会被导入**，代码一行也不执行；该插件降级，原因带错误码，启动照常继续。这一步对恶意包同样有效
（例外是第 6 节的 `data:` 条目）。

| 规则 | 错误码 | 测试 |
|---|---|---|
| 清单存在、`manifestVersion` 支持、字段符合契约 | `MANIFEST_MISSING`、`MANIFEST_VERSION_UNSUPPORTED`、`MANIFEST_INVALID` | `host/kernel/tests/plugin-manifest-load.test.ts` |
| `engines.deepStudent` 包含应用版本 | `ENGINE_INCOMPATIBLE` | `host/kernel/tests/plugin-manifest-load.test.ts`、`examples/testing/security.test.ts` |
| 不能用 `dstu.*` 和禁用的 publisher，profile 条目 id 与清单 id 一致：社区插件替换不了官方插件 | `ID_RESERVED`、`ID_MISMATCH` | `host/kernel/tests/plugin-manifest-load.test.ts`、`examples/testing/security.test.ts`、`examples/plugins/community-web-search/__tests__/web-search.test.ts` |
| `platforms` 包含当前平台 | `UNSUPPORTED_ON_PLATFORM` | `host/kernel/tests/plugin-manifest-load.test.ts` |
| profile 只能装 Host 半，模块必须是清单的 `host` 入口 | `HOST_ENTRY_MISMATCH` | `host/kernel/tests/plugin-manifest-load.test.ts` |
| 权限只有 `service:<服务名>` 一种 | `PERMISSION_UNKNOWN_KIND` | `host/kernel/tests/plugin-manifest-load.test.ts` |

## 3. Host 半：导入之后、`apply` 之前的检查

通过筛查的模块被导入（**模块顶层代码此时已经执行**），然后核对模块导出的 `meta` 与清单（`host/kernel/manifest.ts`
`checkPluginModule`），再看服务冲突、`requires` 与配置。不通过的插件不 `apply`。

| 社区插件不能 | 错误码 | 测试 |
|---|---|---|
| 提供 id 派生命名空间之外的服务（例如 `settings`），也不能顶替其他插件已提供的服务 | `SERVICE_NAME_INVALID`、`SERVICE_CONFLICT` | `host/kernel/tests/plugin-manifest-load.test.ts`、`examples/testing/security.test.ts` |
| `inject` 没在 `permissions` 里声明的服务（`log` 隐式授予，`storage` 不隐式授予） | `PERMISSION_UNDECLARED` | `host/kernel/tests/plugin-manifest-load.test.ts`、`examples/testing/security.test.ts` |
| 声明 `meta.commands`（应用命令），或注入 kernel 专有服务（`commands`、`protocols`、`backendEvents`、`shell`、`dstuPluginInstaller`） | `KERNEL_API_FORBIDDEN` | `host/kernel/tests/community-kernel-surface.test.ts` |
| 调用 `ctx.commands.register`、`ctx.protocols.register`、`ctx.backendEvents` 的收发、`ctx.shell.request`（在 `apply` 里调用即降级；只读的 `ctx.commands.has()` 不限制） | `KERNEL_API_FORBIDDEN` | `host/kernel/tests/community-kernel-surface.test.ts` |
| 在 `Config` 里声明凭据字段（`role: 'secret'` 或像凭据的键名；密钥走 `ctx.settings.saveSecret`，`docs/plugins/SDK.md` §7.1） | `CONFIG_CREDENTIAL` | `host/kernel/tests/plugin-config.test.ts` |
| 配置不符合 `Config` | `CONFIG_INVALID` | `examples/plugins/community-web-search/__tests__/web-search.test.ts` |

这些检查看的是插件**声明**的东西：`meta`、`inject`、通过 `ctx` 调用的 kernel 接口。插件代码不经过它们就能做到的事见第 5 节。

### 3.1 社区上下文与工坊安装能力（K1 防误用收口）

受限和完全信任社区插件的 `apply` 均收到收窄后的上下文，而不是原始 Cordis Context。`root`、`registry`、`fiber`、`runtime`、
`scope`、服务的 `ctx`、内核私有字段，以及反射存储/注册表遍历入口均抛 `KERNEL_API_FORBIDDEN`；`get`/`reflect.get` 也不能取回
这些入口。继承/扩展上下文保持收窄，内部框架事件不能用来取回其他插件的上下文。官方插件的上下文保持原状。

`dstuPluginInstaller` 只按显式 inject 注入内置插件。桌面 Host 为插件 apply、命令、remote 和事件回调维护执行期 owner；
installer 的四个方法每次调用都同时核对注入授权及当前执行 fiber，异步 await 不转移 owner。把 installer 放进普通对象提供给
社区插件，不会把内置插件的执行身份一起转交；缺少执行身份的捕获对象调用同样拒绝。社区服务/回调进入自身 owner，不能借用
触发它的官方调用栈提升身份。内置插件仍需避免把“代社区执行高权限操作”的闭包当作服务暴露：闭包内实际执行的代码和共享原型
不由本轮检查自动证明安全。

实现：`host/kernel/community-context.ts`、`host/kernel/plugin-execution.ts`、`host/kernel/plugin-installer.ts`。
回归：`host/kernel/tests/plugin-manager.test.ts`（审计 registry 遍历、普通对象转发及 async/remote/事件调用）、
`host/kernel/tests/community-kernel-surface.test.ts`（K1 及官方路径）。这些用例不是物理隔离证明。

## 4. UI 半

UI 半由 Host 半的 `meta.ui` 带进来（没有单独装 UI 半的入口），经 `ds-plugin://` 加载到主窗口。

| 规则 | 做检查的地方 | 测试 |
|---|---|---|
| `meta.ui` 必须在包根目录（`package.json` 所在目录）之内，否则不进 UI 清单（SEC-E12） | `host/kernel/runtime.ts` `communityUiFile` | `host/kernel/tests/ui-file-containment.test.ts` |
| `ds-plugin://<id>/` 只提供 UI 文件所在目录下的文件；`..`、绝对路径、HTML / TS 文件都拒绝 | `electron/shell/plugin-ui-protocol.ts` `servePluginUiRequest` | `electron/tests/plugin-ui-protocol.test.ts` |
| UI 半经 `plugin:host\|call` 只能调 `meta.remote` 列出的方法，参数和返回值必须是纯 JSON | `host/kernel/runtime.ts` `remoteCall` | `host/kernel/tests/ui-bridge.test.ts`、`examples/plugins/community-word-of-day/__tests__/word-of-day.test.tsx` |
| `ctx.ui.host` 的调用带上本插件 id（`caller`），Host 只放行它自己 Host 半的服务；不带 `caller` 的调用以 Validation 错误拒绝 | `host/kernel/runtime.ts` `DEFAULT_HOST_CALL_CALLER_MODE` | `host/kernel/tests/ui-bridge.test.ts`、`src/ui-kernel/__tests__/community-example.test.tsx` |
| kernel 命令（`plugin:ui\|manifest`、`plugin:host\|call`）只对主窗口的本地页面开放（SEC-E11） | `host/kernel/commands.ts` `KERNEL_COMMAND_WINDOWS` | `host/kernel/tests/kernel-command-windows.test.ts` |
| 文案只能写进 id 派生的命名空间，`t` 不回落到官方或其他插件。API v1 插件经 `addBundle` 写别的新命名空间也报错（`STRICT_COMMUNITY_NAMESPACES` 现在是 `true`，改回 `false` 时只告警） | `src/ui-kernel/kernel.ts` `STRICT_COMMUNITY_NAMESPACES` | `src/ui-kernel/__tests__/i18n.test.tsx`、`examples/plugins/community-word-of-day/__tests__/word-of-day.test.tsx` |
| 贡献的组件抛错只影响自己；错误超出预算时整个插件被卸载 | `src/ui-kernel/outlet.tsx` | `src/ui-kernel/__tests__/outlet.test.tsx` |
| 能 import 的裸模块只有四个共享模块，其余依赖要打进 `dist/ui.js` | `examples/scripts/build-ui.mjs` `SHARED_MODULES`、`src/ui-kernel/shared.ts` `installSharedModules` | `examples/testing/conformance.test.ts`、`examples/scripts/__tests__/walkthrough.test.tsx` |

## 5. 不是边界的地方

下面这些是现状，写在这里是为了评估风险，不是给插件用的接口。

| 现状 | 原因 | 测试 / 出处 |
|---|---|---|
| 被模块检查拒绝的插件，顶层代码已经执行过 | 第 3 节的检查需要模块导出的 `meta`，只能在导入之后做 | `examples/testing/security.test.ts` |
| Host 半没声明权限，也能用 `ctx.get('<服务名>')` 拿到官方服务，能 `import` `node:fs`、`node:child_process` | 与应用同进程（`host/kernel/API.md` §16.4：`service:` 权限防误用，不是安全边界） | `examples/testing/security.test.ts` |
| UI 半能拿到应用的 IPC 桥、主窗口 DOM 和 `localStorage`，能调用主窗口能调的任何命令 | 在主窗口主世界里 `import()`（`src/ui-kernel/community.ts` `startCommunityUiPlugins`） | `src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md` 第 1 节 |
| `plugin:host\|call` 的 `caller` 由调用方自己填，Host 不核实：UI 半直接调用这个命令、填别的插件 id，就能调到那个插件 `meta.remote` 里的方法 | 所有 UI 半在同一个主世界里运行（上一行），Host 分不出调用来自哪个插件；不填 `caller` 的调用已经拒绝（K2） | `host/kernel/tests/ui-bridge.test.ts` |
| 原生对象、闭包和原型仍处在共享进程中；内置插件主动暴露的高权限闭包也可能成为绕过路径 | 社区 `ctx.root`/注册表的直接遍历已按第 3.1 节拒绝，但收窄上下文不是物理沙箱，第三批 K4–K6 才实现独立进程 | `host/kernel/tests/community-kernel-surface.test.ts`、`host/kernel/SEC-E06-HOST-ISOLATION-PLAN.md` |

## 6. 插件目录是信任的起点

Host 每次启动都会装载 `<应用数据目录>/plugins/user.profile.json` 里的条目（`host/kernel/profile.ts` `loadStartupProfile`），
社区装载前核对 Host 所有的 K3 精确 ID/版本/权限同意账本，账本与插件目录分离。它不是代码安全证明；同进程代码或能改写
插件和同意账本的本地进程仍属于可信基底。现有的目录保护与已知缺口：

| 写入途径 | 现状 | 测试 / 出处 |
|---|---|---|
| 页面脚本经 fs 插件写 `$APPDATA/plugins` | 拒绝：macOS / Windows 上换大小写、Windows 短名、经符号链接的父目录也拒绝；`plugins` 还不存在时（应用不会预先建它），用另一种大小写（`Plugins`、`PLUGINS`）建它同样拒绝，建好之后里面的任何写法也拒绝（S01 第 3 轮 M2）。Linux 上大小写不同就是另一个目录，Host 不读它 | `electron/shell/capabilities.ts`、`electron/shell/scope.ts`、`electron/tests/builtin-acl.test.ts`、`electron/tests/fs-scope-missing-path.test.ts`、`electron/tests/fs-scope-deny-case.test.ts`、`host/e2e/security/shell-builtin-acl.test.ts` |
| 打包版用 `DS_HOST_PROFILE` / `DS_HOST_ENTRY` 换 profile 或 Host 入口 | 打包版启动时删除这些变量 | `electron/shell/launch-env.ts` `DEV_ONLY_ENV`、`electron/tests/launch-env.test.ts` |
| profile 条目写成 `data:` 模块 | 拒绝：用户 profile（以及它 extends 的非官方文件）里条目的 `module` 只收文件路径（`./`、`../`、绝对路径、`file:`），`data:`、`node:`、包名等写法报 ProfileError，启动时回退到官方 profile 并报告原因（S01 第 3 轮 M1） | `host/kernel/profile.ts`、`host/kernel/tests/profile-data-url.test.ts` |
| Agent 的 shell 在包含数据目录的读写工作区里写入 | 沙箱模式下拒绝：可写根覆盖 `<数据目录>/plugins` 时先建出该目录，再设为受保护写根（macOS Seatbelt、Linux bwrap），工作区其余位置照常可写；沙箱不可用时不执行命令。用户把权限档位设为 `full_access` / `danger_full_access` 时命令不进沙箱，这层保护也就没有了。测试只在有沙箱的系统上运行（macOS；装了 `bwrap` 和 `prlimit` 的 Linux） | `host/plugins/agent-workspace/src/tools/shell-execute/context.ts` `protectHostPluginDir`、`host/plugins/agent-workspace/tests/shell-host-plugin-dir.test.ts` |
| Agent 文件工具写入包含数据目录的工作区 | 未修（S01 第 3 轮 L1 / L2，W02） | `host/plugins/agent-workspace/src/runtime-roots.ts` |
| 同步下载的 blob 路径越出 blobs 目录 | 拒绝：云端清单里不符合 `<hash 前两位>/<hash>[.扩展名]` 的路径、绝对路径、盘符、反斜杠、越出 blobs 目录或经过符号链接的目标都不下载（S01 第 2 轮 H1） | `host/plugins/sync/src/blob-sync.ts` `downloadTarget`、`host/plugins/sync/tests/blob-relative-path.test.ts` |

## 7. 对插件作者的要求

- 只 `inject` 声明过的服务，只在 `meta.remote` 里列 UI 半真正要调的方法；不要用 `ctx.commands`、`ctx.protocols`、
  `ctx.backendEvents`、`ctx.shell`。
- 凭据不进配置，用 `ctx.settings.saveSecret` / `getSecret`（需要 `service:settings`）。
- UI 半的依赖全部打包，只把四个共享模块留作外部依赖（`examples/scripts/build-ui.mjs` `SHARED_MODULES`）。
- 不要在模块顶层做有副作用的事：导入发生在模块检查之前，检查失败时副作用已经发生；启动时导入抛错会让整个用户 profile 回退到
  官方 profile。
