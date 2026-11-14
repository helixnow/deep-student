# 社区插件示例

四个按 v1 清单写的社区插件，都能在本机测试。规则的出处写在每条后面，以代码为准。写插件的完整指南是
`docs/plugins/SDK.md`；示例覆盖了哪些 API 见 `examples/W27-PROGRESS.md` 的覆盖面表。

| 目录 | id | 演示 |
|---|---|---|
| `plugins/community-word-of-day` | `example.word-of-day` | Host 半 + UI 半：侧栏视图、导航项、命令，`meta.remote` 放行的远程调用，按 id 派生的文案命名空间；视图里的 `DsButton` / `DsDialog`、持久化的插件 store（收藏夹）、按 `usePlatform()` 显示的快捷键、`reportError`；聊天里词典 MCP 工具结果下方的“收藏”按钮（`chat.toolResults`） |
| `plugins/study-goal` | `example.study-goal` | Host 半 + UI 半：Host 半声明 `service:storage`，把数据存进自己的 SQLite 文件（`docs/plugins/SDK.md` §7.2）；设置分区（带 `navigation`、前端插件存储、`SegmentedControl`），命令经 Host 半处理后用命令面板通知回显结果，`CommandError` 的值原样到 UI；学习资源库里资源的右键菜单行（`resource.contextMenu`） |
| `plugins/community-web-search` | `example.web-search` | 只有 Host 半：带 `Config` 校验的服务，与官方 `webSearch` 并存（不能替换它，见该目录 README） |
| `plugins/translation-prompt` | `example.translation-prompt` | 只有 Host 半：声明 `service:translation` 权限后注入官方翻译服务 |

## 脚手架

```bash
node examples/scripts/create-plugin.mjs alice.study-stats --out ../study-stats             # Host 半 + UI 半
node examples/scripts/create-plugin.mjs alice.study-stats --out ../study-stats --host-only # 只有 Host 半
```

按 id 生成 `package.json`（v1 清单，`engines.deepStudent` 取当前应用的 `^主.次`）、`index.ts`（Host 半，服务名由 id 派生）、
`ui.tsx` 与 `i18n.ts`（视图、导航项、命令，经 `ctx.ui.host` 调 Host 半）、`test.profile.json`、`user.profile.json`、
`__tests__/<name>.test.tsx` 和 `README.md`。不合法或保留的 id（`community.*`、`dstu.*` 等）直接拒绝；目标目录非空时要加 `--force`。
派生名字用的是 Host 装载检查同一份代码（`host/kernel/plugin-id.ts` `pluginNamespaces`）。

生成的 Host 半和测试按相对路径导入应用仓库里的 `host/kernel/api.ts` 与 `examples/testing/harness.ts`，`build:ui` 调用仓库里的
`examples/scripts/build-ui.mjs`（`--app` 指定仓库，默认是脚本所在的仓库）：Host 目前没有给社区模块提供导入内核 API 的运行时模块名，
插件要放在应用仓库旁边开发，用源码运行的应用（`npm run dev:electron`）试用。生成后的全程（生成的 `README.md` 里也有，路径已填好）：

```bash
(cd ../study-stats && npm run build:ui)                                                     # 1. 构建 UI 半 → dist/ui.js
DS_PLUGIN_DIR=../study-stats DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts  # 2. 测试
DS_HOST_PROFILE="$PWD/../study-stats/user.profile.json" npm run dev:electron                 # 3. 在应用里试用
```

- 第 1 步在插件目录里运行，用的是应用仓库的 esbuild：仓库外的插件目录没有 `node_modules`，`esbuild` 也不在 PATH 上。
- 第 2 步在仓库根目录运行。`DS_PLUGIN_DIR` 让 `examples/vitest.config.ts` 只收该目录下的测试，共享依赖按应用仓库解析。
- 第 3 步：`DS_HOST_PROFILE` 只在开发态生效（打包版启动时删除，`electron/shell/launch-env.ts` `DEV_ONLY_ENV`）；想和日常数据分开时再加
  `DS_APP_DATA_DIR=<空目录>`。常驻装载见下文「Host 半」最后的「装载」。

`examples/scripts/__tests__/walkthrough.test.tsx` 按这个顺序原样执行生成的 `README.md` 里的命令（生成、构建、测试），再按生产路径装载：
用户 profile 放进 `<应用数据目录>/plugins/user.profile.json`，Host 经真实握手装载，外壳经 `ds-plugin://` 提供 `dist/ui.js`，UI 内核
用共享模块的 import map 装上它并调用 Host 半。脚手架自己的测试（`examples/scripts/__tests__/create-plugin.test.ts`）跑下文的
全部一致性检查、类型检查、plugin-manifest 门禁。

## 清单（`package.json`）

契约：`contracts/plugin-manifest/v1.schema.json`。门禁（`scripts/electron-migration/gate-checks/plugin-manifest.mjs`）与
Host 装载（`host/kernel/manifest.ts` `checkManifest`）用同一份。下面合并了示例用到的全部字段：

```json
{
  "name": "deepstudent-plugin-my-plugin",
  "version": "1.0.0",
  "engines": { "deepStudent": "^0.11" },
  "deepStudent": {
    "manifestVersion": 1,
    "id": "example.my-plugin",
    "platforms": ["desktop"],
    "permissions": ["service:translation"],
    "host": "./index.ts",
    "ui": "./dist/ui.js"
  }
}
```

- `engines.deepStudent` 在顶层（不在 `deepStudent` 里）。只认 `^X.Y[.Z]`、`~X.Y[.Z]`、`X.Y.Z`、`>=X.Y.Z[ <A.B.C]`；
  不包含当前应用版本时 `ENGINE_INCOMPATIBLE`。预发布版本的应用不满足任何范围（`host/kernel/API.md` §16.1 第 3 步）。
- `deepStudent` 必填 `manifestVersion`（1）、`id`、`platforms`，以及 `host`、`ui` 至少一个；不认识的字段是错误。
- `id` = `<publisher>.<name>`。`ds`、`deepstudent`、`deep-student`、`official`、`builtin`、`system`、`community`
  任何插件不得用；`dstu` 只给应用内置插件（社区来源 `ID_RESERVED`）；示例目录的 id 必须以 `example.` 开头（门禁 id-context）。
  出处：`host/kernel/plugin-id.ts` `FORBIDDEN_PUBLISHERS` / `ASSIGNED_PUBLISHERS`。
- `host` 必须就是 profile 条目的模块文件（否则 `HOST_ENTRY_MISMATCH`）。Host 模块导出的 `meta.id`、`meta.version`
  必须等于清单的 `id` 与 `version`（`checkPluginModule`，`ID_MISMATCH` / `VERSION_MISMATCH`）。
- 只有 `ui` 的包能过清单校验，但装不上：profile 只装 Host 半，UI 半由 Host 半的 `meta.ui` 列进 UI 引导清单
  （`host/kernel/profile.ts` `screenProfileEntry` 报 `HOST_ENTRY_MISMATCH`）。纯界面插件也要一个 Host 半，可以只有 `meta.ui`、不提供服务。
- `permissions`：每项 `service:<服务名>`。社区插件的 `inject` 必须 ⊆ 声明的服务 ∪ `log`，否则 `PERMISSION_UNDECLARED`
  （`host/kernel/manifest.ts` `IMPLICIT_SERVICE_GRANTS`、`grantedServices`）。
- `platforms` 不含当前平台时拒绝装载（`UNSUPPORTED_ON_PLATFORM`）；示例都只声明 `["desktop"]`。

## 由 id 派生的名字

`host/kernel/plugin-id.ts` `pluginNamespaces(id)`，前端与 Host 共用（`host/kernel/API.md` §16.2）：

| 用途 | 规则 | `example.word-of-day` |
|---|---|---|
| Host 服务名 | lowerCamelCase，或它再接大写开头的后缀；其他名字 `SERVICE_NAME_INVALID` | `exampleWordOfDay` |
| i18n / 设置命名空间 | id 本身 | `example.word-of-day` |
| 前端存储键前缀 | `ds:plugin:<id>:` | `ds:plugin:example.word-of-day:` |
| 槽位贡献 id | `<id>/<localId>`（`pluginSlotId`） | `example.word-of-day/today` |
| 自定义事件 | `<id>:<event>`（`pluginEventName`：id 里的 `.` 换成 `/`） | `example/word-of-day:refreshed` |

命令 id 沿用命令面板的 `{module}.{action}`（`src/command-palette/registry/types.ts`），示例用 `example.word-of-day.open`。
社区插件通过 `ctx.uiEvents.emit` 发事件、`ctx.ui.host.on` 订阅；study-goal 展示提交后更新已挂载设置分区。
`ctx.backendEvents` 仍只给官方插件。命名与生命周期见 `docs/plugins/SDK.md` §5。

社区插件不能接管官方能力：服务名必须在自己的名字空间里，profile 里写官方 id 指向社区包会 `ID_MISMATCH`。
要换一种实现，就提供自己的服务（`community-web-search`）或包一层官方服务（`translation-prompt`）。

## Host 半

两个示例合起来的样子（`translation-prompt` 的 `inject` + `Config`，`community-word-of-day` 的 `meta.remote`）：

```ts
// examples/plugins/readme-host-half/index.ts
import { definePlugin, Schema } from '../../../host/kernel/api.ts';
import type { TranslationRequest } from '../../../host/plugins/translation/api.ts';

interface ReadmeConfig {
  prompt: string;
}

const Config: Schema<Partial<ReadmeConfig>, ReadmeConfig> = Schema.object({ prompt: Schema.string().default('Be brief.') });

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleReadmeHostHalf: { prompt(request: TranslationRequest): TranslationRequest };
  }
}

export default definePlugin<ReadmeConfig>({
  meta: {
    id: 'example.readme-host-half', version: '1.0.0', platforms: ['desktop'], provides: ['exampleReadmeHostHalf'],
    ui: './dist/ui.js', remote: { exampleReadmeHostHalf: ['prompt'] },
  },
  inject: ['translation'], // ⊆ permissions ∪ log
  Config, // Schemastery；可省略
  apply(ctx, config) {
    ctx.provide('exampleReadmeHostHalf', { prompt: (request) => ({ ...request, prompt_override: config.prompt }) });
  },
});
```

- `meta.remote`：服务名 → 允许 UI 经 `plugin:host|call` 调用的方法；没列出的方法以 `Validation` 拒绝
  （`host/kernel/core.ts` `PluginMeta.remote`）。
- `Config`：`apply` 之前校验并补默认值；不合法 `CONFIG_INVALID`，schema 里有凭据字段（`role('secret')`、`apiKey`、`token`
  等）`CONFIG_CREDENTIAL`（`host/kernel/plugin-config.ts`）。
- `inject` 是硬依赖：profile 里没有提供该服务的插件时，本插件以 `missing service "<名字>"` 降级。
- 任一检查失败只降级这一个插件，原因 `"<CODE>: <detail>"` 出现在 `plugin:host|status` 与 UI 清单 v2 的 `degraded`。

装载：把 `user.profile.json`（`extends: "official"` + 本插件条目）放到 `<应用数据目录>/plugins/user.profile.json`，
`module` 写成 `index.ts` 的绝对路径，重启应用（外壳在启动时选它，`electron/shell/host-profile.ts` `resolveHostProfile`；
Host 按 `host/kernel/profile.ts` `loadStartupProfile` 装载）。多个插件就在 `plugins` 里写多条。应用数据目录是
`DS_APP_DATA_DIR`（设置了的话），否则是系统数据目录下的 `com.deepstudent.app`（`electron/shell/paths.ts` `appDataDir`）：

| 系统 | 应用数据目录 |
|---|---|
| macOS | `~/Library/Application Support/com.deepstudent.app` |
| Windows | `%APPDATA%\com.deepstudent.app` |
| Linux | `$XDG_DATA_HOME/com.deepstudent.app`，未设置时 `~/.local/share/com.deepstudent.app` |

用户 profile 文件本身无效（解析失败、模块导入失败）时 Host 记错误、发 `host://plugin-profile-failed`，改用官方 profile 启动；
单个插件不合格只降级它自己。

## UI 半

只从 `@deepstudent/ui`、`react`、`react-dom`、`i18next` 导入：宿主经 import map 只共享这四个模块
（`src/ui-kernel/community.ts` `installCommunitySharedModules`）。完整 API 见 `src/ui-sdk/README.md`，导出见
`src/ui-sdk/index.ts`。示例用到的：

| API | 用法 |
|---|---|
| `definePlugin({ meta, apply })` | `meta.apiVersion` 缺省为 2；`meta.host: true` 与同 id 的 Host 半配对，Host 半缺失时撤下、回来后装回 |
| `ctx.ui.i18n.addBundles({ 'zh-CN': {...}, 'en-US': {...} })` | 登记到派生命名空间；`ctx.ui.i18n.namespace` 给出它，用于 `labelKey` 等 `ns:key` |
| `ctx.ui.views.register` / `ctx.ui.nav.register` / `ctx.ui.commands.register` | 视图、侧栏导航项、命令；卸载时全部撤销 |
| `ctx.ui.navigate(viewId)` | 打开视图 |
| `ctx.ui.host.<服务>.<方法>(...)` | 调 Host 半在 `meta.remote` 放行的方法 |
| `useT()`、`withPluginScope(ctx, Component)` | 组件里取本插件的 `t`；由外壳渲染的组件要用 `withPluginScope` 包一层 |
| `createPluginStore(ctx, init, { persist })`、`usePluginStore(store, selector)` | 插件状态；卸载时重置，`persist` 经插件存储跨重启保留 |
| `usePlatform()` | 当前平台（`kind`、`os`、`capabilities`） |
| `ctx.ui.reportError(error, { slot, entryId })` | 自报错误，计入错误预算（社区插件 3 次即卸载） |
| `DsButton`、`DsDialog`、`SegmentedControl` | 设计系统组件；样式用 CSS 变量和行内样式 |

这些 API 的常见错误见 `docs/plugins/SDK.md` §4。

文案隔离：社区插件写非派生命名空间时，API v2 直接报错；`t` 只查本插件命名空间，不回落到官方或其他插件
（`src/ui-kernel/kernel.ts` `ctx.ui.i18n.addBundle`）。

构建：插件的 `build:ui` 是 `node <到应用仓库的相对路径>/examples/scripts/build-ui.mjs`，在插件目录里 `npm run build:ui`。
它用应用仓库的 esbuild 把 `ui.tsx` 打成清单 `deepStudent.ui` 指向的一个 ESM 文件，四个共享模块设为 external
（`examples/scripts/build-ui.mjs` `SHARED_MODULES`）。宿主不提供 `react/jsx-runtime`，所以按经典 JSX 编译成 `React.createElement`，
并且不读外层 tsconfig（仓库根的 `"jsx": "react-jsx"` 会盖过这项设置）。产物 `dist/` 不提交。

## 测试

```bash
DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts examples/plugins/community-word-of-day
DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts examples/testing/conformance.test.ts
```

`examples/vitest.config.ts` 就是根配置加上 `@deepstudent/ui` 别名，只收 `examples/**`。测试文件用
`// @vitest-environment node`（Host 测试宿主按 `file:` URL 找模块与 `package.json`），渲染时用 `installDom()` 建 DOM。
设计系统组件的动画库在导入时就取 `requestAnimationFrame`，早于 `installDom()`，所以配置多一个 setup
（`examples/testing/setup.ts`）先补上它，否则 `DsDialog` 关闭后不会离开 DOM。测试要渲染的官方模块在导入时就读 `window`
（聊天工具块的滚动区 OverlayScrollbars 没有 DOM 就换成空对象）时，测试文件第一个 import 写 `examples/testing/with-dom.ts`，
导入前就装好 DOM（word-of-day、study-goal 的测试）。

`examples/testing/harness.ts`：

- `loadExample(profile, { provide?, official?, storage?, dataDir? })`：以真实应用版本建测试宿主（`createTestHost` 默认的
  `0.0.0-test` 是预发布版本，不满足任何 `engines`），再走生产的 `loadProfile`（含社区清单筛查）。`provide` 给其他服务的替身，
  `official` 替换 `extends: "official"` 指向的文件；`storage: true` 提供真实的存储服务（`host/platform/storage/service.ts`
  `StorageCordisService`）；`dataDir` 指定数据目录，由调用方清理，两个宿主先后用它就能测重启后的数据。
- `createUiKernel(host, adapters)`：真实 UI 内核，`invoke` 接到测试宿主，命令默认走内存注册表；`study-goal` 的测试改传
  `src/ui-kernel/legacy-adapters.ts` `createLegacyRegistryAdapters` 包装的真实 `commandRegistry`，由它执行命令、发通知。
- `installUiHalf(kernel, uiHalf)`：安装 UI 半，交出它在 `apply` 里拿到的 `ctx.ui.host`。调用带上插件 id，Host 只放行它自己 Host 半的
  服务；插件之外的 `kernel.ui().host` 没有调用方，调用被拒绝。
- `recordingI18n()`：记录内核写入的每个语言包（`<lng>/<ns>`），用来断言命名空间隔离。
- `renderView(kernel, viewId)`：按外壳的方式渲染 `views` 槽位里的视图，返回 testing-library 的查询和 `unmount`。脚手架生成的
  测试用它：仓库外的插件目录没有 `node_modules`，自己导入不了 `@testing-library/react`。

`examples/testing/conformance.test.ts` 对每个示例跑门禁检查、Host 启动期与安装期检查、模块检查、profile 条目 id，
并按 `build:ui` 实际构建 UI 半，确认产物只依赖四个共享模块。

`examples/testing/docs.test.ts` 防文档过时：`docs/plugins/` 与本目录 README 里的 ts/tsx 代码块第一行写
`// examples/plugins/<目录>/<文件>`，按放在那里的插件做类型检查（Host 半按 `tsconfig.host.json`，UI 半按
`examples/tsconfig.json`，都开 strict）；第一行是仓库里已有的文件时，代码块是它的摘录，每一行都要按顺序出现在该文件里。
文中反引号里的仓库路径必须存在，`路径:行号` 不能超出文件长度，紧跟在路径后面的 `符号` 必须出现在该文件里。
`docs/plugins/SECURITY.md` 里最后一列是“测试”的表格，每行都要引用测试文件，行里的错误码要出现在引用的测试里。
它还按同样的设置检查每个示例的 Host 半。

`examples/testing/security.test.ts` 是 `docs/plugins/SECURITY.md` 第 3、5 节的证据：清单筛查在导入之前、模块检查在导入
之后；装上的社区 Host 半没声明权限也拿得到官方服务和 Node 内置模块。

类型检查（UI 半）：`npx tsc --noEmit -p examples/tsconfig.json`。

node 环境的测试里，react-dom 由根 `vitest.setup.ts` 在 `installDom()` 之前加载，文本输入框的 `onChange` 触发不了；
需要交互的界面测试用点击（`study-goal` 的目标选择用 `SegmentedControl`）。改用 `// @vitest-environment jsdom` 不行：
`loadExample` 在收集阶段就报 `TypeError: The URL must be of scheme file`。
