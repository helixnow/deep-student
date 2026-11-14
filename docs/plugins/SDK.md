# 插件 SDK 指南（社区开发者）

本指南面向**官方 `host/plugins` 之外的社区插件**。一个社区插件是一个包：`package.json#deepStudent` 清单（v1）、
Host 半（Cordis 插件，跑在 Host 进程里），以及可选的 UI 半（跑在渲染进程的 UI 内核里）。Host 半的服务、监听都在
`apply(ctx)` 里登记，卸载时自动撤销。

先读：

- `examples/README.md`：可运行的示例、清单字段、由 id 派生的名字、脚手架 `examples/scripts/create-plugin.mjs`。
- `host/kernel/API.md` §15–§16：UI 引导清单与 `plugin:host|call`、v1 清单装载、id 与派生命名空间、配置、权限。
- `src/ui-sdk/README.md`：UI 半的 `@deepstudent/ui` API。
- `docs/plugins/CAPABILITIES.md`：官方插件的服务、命令、事件（自动生成）。
- `docs/plugins/SECURITY.md`：社区插件能做什么、不能做什么，哪些检查只防误用（社区插件现在没有隔离）。

| 想做的事 | 方式 | 参考 |
|---|---|---|
| 换一种实现（例如自建网页搜索） | 提供由自己 id 派生的服务，与官方服务**并存**；要用它的插件显式注入 | §3.3，`examples/plugins/community-web-search` |
| 在官方能力外面包一层（例如固定翻译提示词） | `permissions` 声明 `service:<服务名>`，`inject` 官方服务，再提供自己的服务 | §3.3，`examples/plugins/translation-prompt` |
| 给界面加视图、导航项、命令、设置分区 | UI 半（`@deepstudent/ui`） | §4，`examples/plugins/community-word-of-day`、`examples/plugins/study-goal` |
| UI 半调用 Host 半 | Host 半在 `meta.remote` 列出方法，UI 半调 `ctx.ui.host.<服务>.<方法>()` | §2，`examples/plugins/study-goal` |
| 关闭某个官方功能 | 用户 profile 写 `{ "id": "dstu.…", "disabled": true }` | §6 |
| 新增 IPC 命令 | 不开放：命令名由 `contracts/ipc` 锁定，只给官方插件 | §2 |
| 替换官方插件或官方服务 | 不支持：会被 `ID_MISMATCH` / `ID_RESERVED` / `SERVICE_NAME_INVALID` 拒绝 | §3.3 |

## 0. 导入

| 从哪里导入 | 用途 |
|---|---|
| `host/kernel/api.ts` | `definePlugin`、`CommandError`、`Schema`（配置 schema）、`WindowRef` 等类型 |
| `host/kernel/testing.ts` | 测试宿主 `createTestHost`（只在测试里导入） |
| `host/kernel/plugin-id.ts` | `pluginEventName`：Host 半派生自己的完整事件名 |
| 其他插件的 `api.ts` | 服务接口类型（`import type`）及其 `declare module '@deepseek-ai/cordis'` 增补 |
| `@deepstudent/ui`、`react`、`react-dom`、`i18next` | UI 半能导入的全部模块（宿主经 import map 共享，`src/ui-kernel/community.ts` `installCommunitySharedModules`） |

下文的 Host 代码都按放在 `examples/plugins/<目录>/` 里写相对路径，和仓库内示例、脚手架生成的插件一样。Host 用 Node
原生类型擦除直接 `import()` 插件模块（`host/kernel/profile.ts` `importProfile`），**没有**给仓库外的模块提供导入内核 API
的运行时模块名，仓库外的插件目录也没有 `node_modules`：插件要放在应用仓库旁边开发，用相对路径指向仓库里的
`host/kernel/api.ts`，运行时不要导入其他 npm 包（包括 `@deepseek-ai/cordis`）。`import type` 与 `declare module` 在运行时
被擦除，不受影响。

其余 kernel 文件、其他插件的 `src/` / `repository/` 都是内部实现，不得导入。

## 1. 最小插件

`package.json`（契约 `contracts/plugin-manifest/v1.schema.json`，字段说明见 `examples/README.md`）：

```json
{
  "name": "@alice/deepstudent-plugin-greeter",
  "version": "1.0.0",
  "type": "module",
  "engines": { "deepStudent": "^0.11" },
  "deepStudent": { "manifestVersion": 1, "id": "alice.greeter", "platforms": ["desktop"], "host": "./index.ts" }
}
```

```ts
// examples/plugins/alice-greeter/index.ts
import { CommandError, definePlugin, Schema } from '../../../host/kernel/api.ts';

export interface AliceGreeterConfig {
  greeting: string;
}

/** profile 里 `config` 的 schema：apply 之前校验并补默认值。 */
export const Config: Schema<Partial<AliceGreeterConfig>, AliceGreeterConfig> = Schema.object({
  greeting: Schema.string().default('Hello'),
});

export interface AliceGreeter {
  greet(name: string): string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    aliceGreeter: AliceGreeter;
  }
}

export default definePlugin<AliceGreeterConfig>({
  meta: { id: 'alice.greeter', version: '1.0.0', platforms: ['desktop'], provides: ['aliceGreeter'] },
  Config,
  apply(ctx, config) {
    ctx.provide('aliceGreeter', {
      greet(name) {
        if (name.trim() === '') throw new CommandError('name is required');
        return `${config.greeting}, ${name}`;
      },
    });
    ctx.logger('alice.greeter').info('greeter ready');
  },
});
```

- 清单 `id`、模块 `meta.id`、profile 条目 `id` 三者相同；`meta.version` 等于 `package.json#version`
  （`host/kernel/manifest.ts` `checkPluginModule`：`ID_MISMATCH`、`VERSION_MISMATCH`）。
- id 是 `<publisher>.<name>`。`ds`、`deepstudent`、`deep-student`、`official`、`builtin`、`system`、`community` 任何插件不得用；
  `dstu` 只给应用内置插件（社区来源 `ID_RESERVED`）；`local`、`test` 只能启动时装载、不能安装；`example` 只给仓库内示例
  （`host/kernel/plugin-id.ts` `reservedIdProblem`）。id 发布后不能改，改名等于新插件。
- `meta.provides` 里的服务名必须是由 id 派生的主服务名（`alice.greeter` → `aliceGreeter`），或它再接一个大写开头的后缀
  （`aliceGreeterCache`），否则 `SERVICE_NAME_INVALID`（`host/kernel/plugin-id.ts` `isServiceNameOwnedBy`）；还必须与运行时
  实际提供的服务完全一致，多一个少一个都会让装载失败（`host/kernel/runtime.ts`）。
- `inject` 里每一项都是**必需**依赖（Cordis 4 没有可选 inject）。社区插件的 `inject` 必须 ⊆ 清单 `permissions` 里的
  `service:<服务名>` ∪ `log`，否则 `PERMISSION_UNDECLARED`（`host/kernel/manifest.ts` `grantedServices`）。可选发现用
  `ctx.get(name)`；运行时目前还不拦截对未声明服务的访问（`host/kernel/API.md` §16.4），但审查按 `permissions` 看，不要依赖没声明的服务。
- `Config` 不合法 → `CONFIG_INVALID`；schema 里有凭据字段（`role('secret')`，或 `apiKey`、`token`、`password` 等字段名）→
  `CONFIG_CREDENTIAL`（`host/kernel/plugin-config.ts` `resolvePluginConfig`）。凭据走 §7.1 的安全存储。
- 社区插件不写 `meta.commands`（§2）。
- `apply` 可以是 async。抛错时 Cordis 撤销本插件已产生的副作用，只降级这一个插件（§6）。
- 示例与脚手架的 `platforms` 都写 `["desktop"]`；只有声明了当前平台的插件才会装载。

## 2. 命令与 UI 调用

IPC 命令（`ctx.commands.register`）是**官方前端的线缆**：命令名必须存在于 `contracts/ipc/*.json`（从 Rust 的
`#[tauri::command]` 抽取），同一个命令只能有一个插件注册，而这些命令都已由官方插件注册。社区插件不注册命令，也不能发明新命令。

社区插件的 UI 半调用 Host 半走内核通道 `plugin:host|call`（`host/kernel/API.md` §15）：

- Host 半在 `meta.remote` 里按服务列出 UI 可以调用的方法；没列出的方法以 `Validation` 拒绝（`host/kernel/runtime.ts` `remoteCall`）。
- UI 半调用 `ctx.ui.host.<服务>.<方法>(...args)`，得到 Promise；参数和返回值必须是纯 JSON。每次调用带上本插件 id（`caller`），
  Host 只放行该插件自己 Host 半的服务；插件之外（`kernel.ui().host`）没有调用方，直接拒绝（`src/ui-kernel/kernel.ts` `caller`）。
- 方法抛 `CommandError(value)` 时 UI 收到 `value`；其他异常 UI 收到 `{ error_type: 'Unknown', message, details: null }`，Host 记日志。
- Host 调用方法时在参数末尾多传一个 `{ signal }`，调用方放弃时中止。

```ts
// examples/plugins/alice-word-count/index.ts
import { CommandError, definePlugin } from '../../../host/kernel/api.ts';

export interface AliceWordCount {
  count(text: string): number;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    aliceWordCount: AliceWordCount;
  }
}

export default definePlugin({
  meta: {
    id: 'alice.word-count',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['aliceWordCount'],
    ui: './dist/ui.js',
    remote: { aliceWordCount: ['count'] },
  },
  apply(ctx) {
    ctx.provide('aliceWordCount', {
      count(text) {
        if (typeof text !== 'string') throw new CommandError({ error_type: 'Validation', message: 'text must be a string', details: null });
        return text.split(/\s+/).filter(Boolean).length;
      },
    });
  },
});
```

```tsx
// examples/plugins/alice-word-count/ui.tsx
import { definePlugin } from '@deepstudent/ui';

export default definePlugin({
  meta: { id: 'alice.word-count', version: '1.0.0', host: true },
  apply(ctx) {
    const t = ctx.ui.i18n.addBundles({
      'zh-CN': { count: '统计剪贴板字数', result: '共 {{n}} 个词' },
      'en-US': { count: 'Count clipboard words', result: '{{n}} words' },
    });
    ctx.ui.commands.register({
      id: 'alice.word-count.count',
      name: `${ctx.ui.i18n.namespace}:count`,
      category: 'global',
      // 返回 { success, message } 时命令面板弹出通知（src/command-palette/registry/commandRegistry.ts）。
      execute: async () => {
        const n = (await ctx.ui.host.aliceWordCount!.count!(await navigator.clipboard.readText())) as number;
        return { success: true, message: t('result', { n }) };
      },
    });
  },
});
```

完整的例子（含失败时的通知、测试）是 `examples/plugins/study-goal`。`ctx.commands.register` 的参数校验、返回值与错误语义
（官方插件用）见 `host/kernel/API.md` §2。

## 3. 服务：发现、提供、并存

服务是插件之间**唯一**的编程接口。服务名就是 `ctx` 上的属性名，类型由提供方 `api.ts` 的
`declare module '@deepseek-ai/cordis'` 增补。

### 3.1 发现

1. 查 `docs/plugins/CAPABILITIES.md`：服务名、提供方、消费方、命令与事件数、边界问题。
2. 在清单 `permissions` 里声明 `service:<服务名>`，再在代码里 `inject: ['<服务名>']`。
3. 类型只从声明该服务的 `api.ts` 导入（例如 `host/plugins/translation/api.ts` 的 `TranslationService`）。

不要复制其他插件的实现或表结构。需要别人的数据或行为时，用对方 `api.ts` 暴露的服务；没有合适接口时向上游提需求。

### 3.2 提供服务

把服务接口放进自己的 `api.ts`，让别的插件只做类型导入：

```ts
// examples/plugins/alice-search/api.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    aliceSearch: AliceSearch;
  }
}

export interface AliceSearch {
  query(text: string): Promise<string[]>;
}

/** 服务版本描述（同官方 api.ts 的写法）：小版本只增不改，不兼容的修改换新服务名（如 aliceSearchV2）。 */
export const aliceSearchService = { name: 'aliceSearch', version: '1.0.0' } as const;
```

```ts
// examples/plugins/alice-search/index.ts
import { definePlugin } from '../../../host/kernel/api.ts';
import type { AliceSearch } from './api.ts';

export default definePlugin({
  meta: { id: 'alice.search', version: '1.0.0', platforms: ['desktop'], provides: ['aliceSearch'] },
  apply(ctx) {
    const index: string[] = [];
    const service: AliceSearch = {
      query: async (text) => index.filter((entry) => entry.includes(text)),
    };
    ctx.provide('aliceSearch', service);
  },
});
```

- 官方插件常用 Cordis `Service` 子类（`new XService(ctx)`）；那需要在运行时导入 `@deepseek-ai/cordis`，仓库外的社区插件
  解析不到（§0），所以社区插件用普通对象 `ctx.provide`。
- 需要清理的资源用 `ctx.effect(() => { open(); return () => close(); })` 登记（§7.2）。

### 3.3 不能替换官方服务；正确做法

Cordis 同一时刻只允许一个同名服务提供方，而 v1 规则下社区插件拿不到官方的名字：

| 做法 | 结果 | 出处 |
|---|---|---|
| 用户 profile 写官方 id（如 `dstu.browser`），`module` 指向社区包 | 包清单 id 与条目 id 不同 → `ID_MISMATCH`；同 id 条目已经替掉继承来的官方条目，官方插件也没了 | `host/kernel/manifest.ts` `checkManifest`；`examples/plugins/community-web-search/__tests__/fixtures/override.profile.json` |
| 清单 id 写 `dstu.*` | `ID_RESERVED` | `host/kernel/plugin-id.ts` `reservedIdProblem` |
| 提供 `webSearch` 等不在自己名字空间里的服务 | `SERVICE_NAME_INVALID` | `host/kernel/manifest.ts` `checkPluginModule` |
| 与另一个插件提供同名服务 | 社区插件降级 `SERVICE_CONFLICT` | `host/kernel/API.md` §16.1 |
| UI 半用官方 UI 插件的 id | 社区 UI 模块的 `meta.id` 必须等于它的 Host 条目 id，后者不能是 `dstu.*` | `src/ui-kernel/loader.ts` `UiPluginLoader` |

能做的是：

**A. 并存**：提供自己的服务，让需要它的插件显式注入。`examples/plugins/community-web-search` 提供
`exampleWebSearch`，形状沿用官方的 `WebSearchService`（`host/plugins/mcp/api.ts`），官方 `webSearch` 原样保留。

**B. 包一层**：注入官方服务，提供自己的服务。清单声明权限
（`"permissions": ["service:translation"]`，见 `examples/plugins/translation-prompt/package.json`）：

```ts
// examples/plugins/alice-translate/index.ts
import { definePlugin } from '../../../host/kernel/api.ts';
import type { TranslationRequest, TranslationResponse } from '../../../host/plugins/translation/api.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    aliceTranslate: { translate(request: TranslationRequest): Promise<TranslationResponse | null> };
  }
}

export default definePlugin({
  meta: { id: 'alice.translate', version: '1.0.0', platforms: ['desktop'], provides: ['aliceTranslate'] },
  inject: ['translation'],
  apply(ctx) {
    ctx.provide('aliceTranslate', {
      translate: (request) => ctx.translation.translateTextStream({ ...request, prompt_override: 'Keep drug names in English.' }),
    });
  },
});
```

`inject` 是硬依赖：profile 里没有提供 `translation` 的插件时，本插件以 `missing service "translation"` 降级。

**C. 关闭官方插件**：用户 profile 写 `{ "id": "dstu.…", "disabled": true }`。它提供的服务随之消失，注入这些服务的官方插件
级联停用（§6）。这只用来关功能，社区插件仍然不能提供同名服务。

**D. 需要真正可替换的扩展点**：向上游提，由官方插件开放 provider 层或拆出独立服务。不要导入官方 `src/` 来“借”实现。

### 3.4 智能体工具（`agentTools`）

`agentTools`（`host/plugins/agent-skills/api.ts` `AgentToolsService`）是官方插件登记工具执行器的接口，目前不给社区插件用，
没有示例，也不保证兼容：

- 执行器接口跟着 Rust 迁移走（`src-tauri/src/agent_wiring/roster.rs` 的分发顺序），还在变化。
- 花名册之外的执行器排在固定尾部（ToolPack、PTC、General）之前（`host/kernel/agent-roster.ts` `orderExecutorsByRoster`），
  分发取第一个 `canHandle` 为真的执行器（`host/plugins/chat/src/executor-registry.ts` `getExecutor`；外部 MCP 工具按名字直接交给
  General），一个对什么工具名都说“能处理”的执行器会截走本该由尾部处理的调用。
- 声明 `service:agentTools` 能过清单检查，但这只防误用，不是隔离（`docs/plugins/SECURITY.md` 第 5 节）。

想给 AI 加工具，现在的做法是写成 MCP 服务器，由用户在设置里添加。

## 4. UI 半

UI 半是 `@deepstudent/ui` 的 `definePlugin`，`meta.host: true` 表示与同 id 的 Host 半配对：Host 半缺失时内核撤下 UI 半，
回来后装回。Host 把社区插件的 UI 模块列进 UI 引导清单（`plugin:ui|manifest`），渲染进程按清单加载
（`src/ui-kernel/loader.ts` `UiPluginLoader`）。

| 贡献 | API | 示例 |
|---|---|---|
| 视图、侧栏导航项 | `ctx.ui.views.register`、`ctx.ui.nav.register`；打开视图 `ctx.ui.navigate(viewId)` | `examples/plugins/community-word-of-day/ui.tsx` |
| 命令面板命令 | `ctx.ui.commands.register(UiCommand)`；`execute` 返回 `{ success, message }` 时弹通知 | `examples/plugins/study-goal/ui.tsx` |
| 设置分区 | `ctx.ui.contribute('settings.sections', …)`，值的字段见 `src/ui-kernel/contracts/settings.ts` `SettingsSection`，带 `navigation` 才出现在设置侧栏 | `examples/plugins/study-goal/ui.tsx` |
| 文案 | `ctx.ui.i18n.addBundles({ 'zh-CN': …, 'en-US': … })`，命名空间就是插件 id | 同上 |
| 前端存储 | `ctx.ui.storage`、`usePluginStorage(key, initial)`，键加 `ds:plugin:<id>:` 前缀 | `examples/plugins/study-goal/ui.tsx` |
| 插件状态 | `createPluginStore(ctx, init, { persist: { key } })` 建 store，组件里 `usePluginStore(store, selector)` 订阅 | `examples/plugins/community-word-of-day/ui.tsx` |
| 平台 | `usePlatform()` 返回 `{ kind, os, arch?, capabilities }`，外壳补全时重渲染 | 同上（命令面板快捷键按 `os` 显示 ⌘K 或 Ctrl+K） |
| 自报错误 | `ctx.ui.reportError(error, { slot?, entryId? })`，计入错误预算 | 同上（加载失败） |
| 设计系统组件 | `SegmentedControl`；`DsButton`、`DsDialog` | `examples/plugins/study-goal/ui.tsx`；`examples/plugins/community-word-of-day/ui.tsx` |
| 聊天里的工具结果卡片 | `ctx.ui.contribute('chat.toolResults', { id, key: <基础工具名>, value: { placement, component, when?, match? } })`，值的字段见 `src/ui-kernel/contracts/chat.ts` `ChatToolResultContribution` | `examples/plugins/community-word-of-day/ui.tsx`（词典 MCP 工具结果下方的“收藏”按钮） |
| 资源右键菜单行 | `ctx.ui.contribute('resource.contextMenu', { id, value })`，值的类型是 SDK 导出的 `ScopedResourceMenuContribution`（`src/ui-kernel/contracts/content.ts`） | `examples/plugins/study-goal/ui.tsx`（学习资源库里资源上的“学完了，记一个番茄钟”） |
| 调 Host 半 | `ctx.ui.host.<服务>.<方法>(...)` | §2 |

设置外壳、视图外壳、聊天的工具块都不经 `<SlotOutlet>` 渲染贡献的组件，组件里要用 `useT`、`usePluginStorage` 时用
`withPluginScope(ctx, Component)` 包一层。

**工具结果卡片**：聊天的工具块（`src/features/chat/plugins/blocks/mcpTool.tsx`）按工具名先查 `chat.toolResults`，再查内置表，都没有时用通用视图
（`src/features/chat/plugins/blocks/toolResultSlot.ts` `resolveToolResult`）。社区插件加不了智能体工具（§3.4），能配卡片的是用户在设置里
接入的 MCP 服务器的工具：它们在聊天块里的名字带 `mcp_` 前缀（`host/plugins/chat-pipeline/src/canonical-tools.ts` `EXTERNAL_MCP_TOOL_PREFIX`），
所以 `key` 写基础工具名并加 `match: 'qualified'`（再去掉 `mcp_`、`mcp.tools.`、`<命名空间>.` 前缀后匹配，`qualifiedToolBaseName`）。
`placement` 取 `block`（替换整个工具块，运行中、失败也归你渲染）、`output`（替换成功态的输出区）或 `actions`（追加在成功态输出区下方）。
外部 MCP 工具的输出格式由服务器决定，从模型传的参数 `toolInput` 取数据更可靠；`when` 返回 false 时这次调用回落到通用视图。
同一个 key 已被别的插件贡献时 `contribute` 抛 `SlotError`（`src/ui-kernel/slots.ts`）。

**资源菜单**：学习资源库（`src/features/learning-hub/components/LearningHubContextMenu.tsx`）和笔记树每次打开菜单都把
`resource.contextMenu` 的每一行对当前上下文求值。行写 `scopes`（`empty`、`folder`、`resource`、`trash-empty`、`trash-item`、
`notes-tree`）时内核保证它只在这些界面出现（`src/ui-kernel/resource-menu.ts` `scopeResourceMenuRow`）。回调的 `context`
类型只对笔记树收窄：`ScopedResourceMenuContribution<'notes-tree'>` 拿到 `NotesTreeMenuContext`；写成学习资源库的界面（如
`ScopedResourceMenuContribution<'resource'>`）时 `context` 被推成 `never`（`src/ui-kernel/contracts/content.ts`
`ResourceMenuContextOf`），所以学习资源库的行用缺省泛型，在 `visible` 里先判断 `context.scope`（示例这样写）。
`resource` 界面也包括资源本身是文件夹的情况，要排除就查 `context.isFolder`。几点和别的贡献不同：

- 标签由菜单用它自己的 `t` 解析（学习资源库是 `learningHub` 命名空间），`labelKey` 要写成 `<命名空间>:<键>`，命名空间取
  `ctx.ui.i18n.namespace`。`labelKey`、`labelParams` 都可以是函数，每次打开菜单时求值。
- 菜单不替插件关闭：`run` 里先调 `context.closeMenu()`。`run` 在点击回调里执行，抛出的异常和被拒绝的 Promise 都没有错误边界接，
  自己处理（示例把 Host 半的拒绝包成 `Error` 交给 `reportError`）。
- SDK 没有通知接口，菜单行做完的结果只能显示在插件自己的界面或下次打开菜单时的标签里（示例用插件 store 记下当天累计）。
- v1 的 `ctx.ui.contextMenu.register({ id, resourceTypes, labelKey, run })` 还能用：内核替它补命名空间、先关菜单，`run` 的异常计入
  错误预算（`src/ui-kernel/ui-service.ts` `toContentMenuContribution`），但只能按资源类型筛选，拿不到上下文。

上表 API 的常见错误：

- `createPluginStore` 的 store 归插件所有：卸载时先停止写回存储，再重置为初始值、断开订阅，之后的 `setState` 被忽略并告警
  （`src/ui-kernel/services/store.ts`）。跨重启要保留的状态用 `persist`；存储里的对象与初始状态浅合并，字段改名后旧值不会自动迁移。
- `reportError` 每调用一次计一次错。社区插件累计 3 次（`<SlotOutlet>` 捕获的渲染错误也算）就被卸载并记为停用，重新安装才清零
  （`src/ui-kernel/services/errors.ts` `UiErrorBudget`）。用户可以重试的失败（网络、输入）只显示，不要上报。
- `reportError` 只记录 `Error` 的 `message`，其他值记成 `String(value)`。Host 半经 `CommandError` 拒绝时 UI 收到的是普通对象，
  直接上报会记成 `[object Object]`，先包成 `Error`。
- 插件卸载后再调用 `ctx.ui` 的服务会抛错（`src/ui-kernel/scope.ts` `assertActive`）。异步回调里先确认组件还挂着，
  word-of-day 的视图在 effect 清理时置标志，之后到达的结果不再处理。
- SDK 只导出 `DsDialog` 本身，没有导出标题、正文、底栏子组件：自己写内容，用 `aria-label` 给对话框起名。插件里的 Tailwind
  类名不进应用的样式构建（`tailwind.config.js` 只扫描 `src/`），只有应用自己也用到的类才有样式；颜色用应用主题的 CSS 变量
  （`src/styles/shadcn-variables.css`，HSL 分量，写成 `hsl(var(--foreground))`、`hsl(var(--muted))`，深浅色自动切换）。
- 平台信息里 `os` 可能是 `unknown`（外壳还没补全、浏览器开发环境），要有缺省分支。

**槽位**：社区插件往已声明的槽位贡献（上表的 `views`、`nav`、`settings.sections`，全部内置槽位见 `src/ui-kernel/kernel.ts`
`BUILTIN_SLOTS`），贡献 id 用 `<id>/<localId>`。`defineSlot` + `ctx.ui.declareSlot` 是给框架插件开放新槽位的：声明不检查槽位名
属于谁，也不随插件卸载撤销（`src/ui-kernel/slots.ts` `declare`），社区插件不要用，示例也没有演示。

**其余 `ctx.ui` 接口**（`src/ui-kernel/kernel.ts` `UiService`）现在不建议社区插件用，没有示例：

| 接口 | 状态 | 原因 |
|---|---|---|
| `ctx.ui.attach(point, register)` | 社区插件用不了 | 要一个懒加载贡献点，只能由 `src/ui-sdk/lazy.ts` `createLazyContributionPoint` 创建，它不在 `@deepstudent/ui` 里；给官方插件接自己的懒加载 chunk 用（如 `src/ui-plugins/official/workbench/index.ts`） |
| `markdown.codeBlocks`、`ctx.ui.markdown.registerCodeBlock` | 形状未公开 | 渲染器的类型依赖官方内部的渲染器模块，不随 SDK 导出（`src/ui-sdk/README.md`），快捷方式的参数是 `unknown` |
| `ctx.ui.chat.registerBlock` / `registerEvent` / `registerMode` | 形状跟着内部代码变 | 值类型直接是应用注册表的内部类型（`src/ui-kernel/contracts/registries.ts` `UiChatBlock`），没有独立契约；块类型和流事件由后端聊天管线产生，社区插件发不出新的 |
| `ctx.ui.workbench.registerApp` | 形状跟着内部代码变，只有桌面端 | 值类型是工作台内部的 `AppDefinition`（`src/ui-kernel/contracts/registries.ts` `UiWorkbenchApp`）；官方工作台插件只在桌面端装载（`src/ui-plugins/official/workbench/index.ts`） |
| `ctx.ui.host.on(event, handler)` | 已开放 | Host 插件通过 `ctx.uiEvents.emit` 向自己的 UI 半推事件；形状见 §5，study-goal 展示已挂载界面更新 |

完整 API 见 `src/ui-sdk/README.md`，导出见 `src/ui-sdk/index.ts`。构建（在插件目录里 `npm run build:ui`，即应用仓库的
`examples/scripts/build-ui.mjs`：经典 JSX、四个共享模块 external）与组件约定见 `examples/README.md`。

## 5. 事件

```ts
// examples/plugins/alice-events/index.ts
import { definePlugin } from '../../../host/kernel/api.ts';

export default definePlugin({
  meta: { id: 'alice.events', version: '1.0.0', platforms: ['desktop'] },
  apply(ctx) {
    const log = ctx.logger('alice.events');
    // 内核派发的窗口生命周期（host/kernel/core.ts 的 Events 增补）
    ctx.on('host/window', (ref, state) => {
      if (state === 'destroyed') log.info(`window ${ref.window} closed`);
    });
  },
});
```

- 社区插件通过 Host 半的 `ctx.uiEvents.emit` 与 UI 半的 `ctx.ui.host.on` 发/收自己的事件：
  - `ctx.backendEvents`（`host/kernel/core.ts` `BackendEvents`：`emit` / `emitTo` / `listen` / `listenWindow`）只给官方插件；
    社区插件调用其中任何一个都被拒绝（`KERNEL_API_FORBIDDEN`，在 `apply` 里调用即降级，`docs/plugins/SECURITY.md` 第 3 节）。
    也不要借用 `contracts/ipc/*.json` 里官方的事件名。
  - UI 半先订阅通知，首次显示仍用 §2 的远程方法读取当前值；事件不回放历史。
- 事件名只允许字母数字与 `- / : _`（`host/kernel/events.ts` `isEventNameValid`）。插件自己的完整名字用
  `host/kernel/plugin-id.ts` `pluginEventName` 派生：id 里的 `.` 换成 `/`，再接 `:<event>`，例如
  `example.study-goal` + `today` → `example/study-goal:today`；`event` 自己不能含 `.`。
- Host 半 `ctx.uiEvents.emit(完整名字, 载荷)`，同步返回，只接受本插件前缀，
  载荷必须是纯 JSON，插件卸载后保留的 emitter 不能再发；UI 半 `ctx.ui.host.on<T>(事件名, handler)` 返回同步生效的
  退订函数，事件名可以是裸名（`today`）或完整名字（`example/study-goal:today`），内核按本插件 id 校验并补前缀，
  外来与近似前缀在注册前抛错，插件卸载时自动退订，插件之外调用直接拒绝，handler 的异常计入插件错误预算。
  完整名字由 `host/kernel/plugin-id.ts` `pluginEventName` 派生，规则由 `examples/testing/events.test.ts` 锁住。
- 事件是**通知**，不是请求/响应。需要返回值或错误语义时用服务。

## 6. Profile：装载与卸载

Host 启动时加载 `<应用数据目录>/plugins/user.profile.json`（存在时），通常 `extends: "official"` 再加上社区插件
（`host/kernel/profile.ts` `loadStartupProfile`，`host/kernel/API.md` §8）。各系统的应用数据目录见 `examples/README.md` 的「装载」；
开发时也可以不动它，用 `DS_HOST_PROFILE=<profile 路径> npm run dev:electron` 指定 profile（只在开发态生效）：

```json
{
  "extends": "official",
  "plugins": [
    { "id": "alice.greeter", "module": "/path/to/alice-greeter/index.ts", "config": { "greeting": "Hi" } },
    { "id": "dstu.anki", "disabled": true }
  ]
}
```

- `extends` 先按顺序展开；本文件条目在后。`module` 相对声明它的 profile 文件解析，也可以是绝对路径或 `file:` URL。
  用户 profile 和它 extends 的非官方文件里 `module` 只能是这几种文件路径（`./`、`../`、绝对路径、`file:`），写成包名、`data:`、
  `node:` 等时整份 profile 无效（`host/kernel/profile.ts` `ProfileError`，见最后一条）。
- 后出现的同 id 条目替换先出现的条目；`disabled: true` 删除该 id 的先前条目。条目里不认识的键报错。
- **社区条目**（模块不在 `host/`、`electron/` 里，`host/kernel/module-origin.ts` `isAppModuleUrl`）先读包清单检查，导入前就被拒的
  条目不执行任何代码；导入后再查 `meta.id`、`meta.version`、服务名空间和权限（`host/kernel/API.md` §16.1）。
- 任何一项检查失败、缺注入的服务、`apply` 抛错，都只降级这一个插件（依赖它服务的插件级联停用），其余照常装载。
  降级列表由 `plugin:host|status` 返回、经 `host://plugins-degraded` 广播，`reason` 是 `"<CODE>: <detail>"`，前端用
  `host/kernel/plugin-load-error.ts` `parseDegradedReason` 拆出错误码。
- 社区模块缺失或导入抛错以 `IMPORT_FAILED` 降级对应插件。profile 解析失败或官方模块导入失败时才回退官方 profile。

**卸载**：从用户 profile 删掉条目（或写 `disabled`）后重启。运行时卸载（`host/kernel/runtime.ts` `unload`，测试宿主的
`host.unload(id)`）停止插件并撤销它的服务、注册和监听；仍有插件 `inject` 它的服务时拒绝卸载。

**测试**：不要在测试里模拟合并逻辑，直接用真实的 `host/kernel/profile.ts` `loadProfile`。
`examples/testing/harness.ts` `loadExample` 以真实应用版本建测试宿主后调用它（`createTestHost` 默认的 `0.0.0-test` 是预发布版本，
不满足任何 `engines` 范围）。

## 7. 存储

### 7.1 配置与凭据

- UI 半的偏好：`ctx.ui.storage`（前端 key-value，键加 `ds:plugin:<id>:` 前缀，卸载后数据保留）。
- Host 半的配置：profile 的 `config` 加 `Config` schema（§1），用户编辑 profile 修改。
- 需要应用设置服务时声明 `service:settings` 并 `inject: ['settings']`：`ctx.settings.get` / `save` / `listByPrefix`，
  键以插件 id 开头（`pluginNamespaces(id).settingsNamespace` 就是 id）；凭据用 `ctx.settings.saveSecret` / `getSecret` /
  `deleteSecret`（`host/platform/settings/api.ts`）。不要把 API key 写进普通设置、profile 或日志。

### 7.2 数据库

社区插件**不要**打开 `ctx.storage.database(...)` 的注册库，也不要在官方的表上写 SQL：每张表只有一个写入方，需要业务数据时用
对应服务。自己的持久化状态放在 `<数据目录>/plugins/<id>/` 下的独立文件（`host/kernel/plugin-id.ts` `pluginNamespaces` 的
`dataDirSegments`），声明 `service:storage`（不隐式授予，`host/kernel/API.md` §16.4）后用 `ctx.storage.openFile` 打开，卸载时关闭：

```ts
// examples/plugins/alice-journal/index.ts
import { definePlugin } from '../../../host/kernel/api.ts';
import type { DatabaseHandle } from '../../../host/platform/storage/api.ts';

export default definePlugin({
  meta: { id: 'alice.journal', version: '1.0.0', platforms: ['desktop'] },
  inject: ['storage'],
  apply(ctx) {
    let db: DatabaseHandle | undefined;
    ctx.effect(() => {
      const handle = ctx.storage.openFile(`${ctx.app.dataDir}/plugins/alice.journal/journal.db`);
      handle.exec('CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
      db = handle;
      return () => ctx.storage.close(handle);
    });
    ctx.on('host/window', async (_ref, state) => {
      if (state !== 'created' || !db) return;
      // 异步代码写库用 write（等待写者槽 + BEGIN IMMEDIATE）；同步事务的回调不得返回 Promise（ASYNC_IN_SYNC_TX）。
      await db.write((tx) => tx.run('INSERT INTO entries (text) VALUES (?)', ['window opened']));
    });
  },
});
```

- 自己的 schema 自己管（例如 `PRAGMA user_version`），不要塞进核心库的迁移链。
- 提交**之后**才做的副作用（发事件、通知）用事务的 `afterCommit` 登记，不要塞进事务闭包（`host/platform/storage/api.ts`）。

可运行的完整示例是 `examples/plugins/study-goal/index.ts`：每天的学习分钟数存在 `<数据目录>/plugins/example.study-goal/study-goal.db`，
`PRAGMA user_version` 管 schema，`log` 在 `db.write` 里读出当天的值、检查上限、再写回。它的测试用
`loadExample(profile, { storage: true, dataDir })`（`examples/testing/harness.ts`）给测试宿主提供真实的存储服务，先后起两个 Host
共用一个数据目录，验证重启后数据还在。常见错误：

| 现象 | 原因 |
|---|---|
| 降级，`PERMISSION_UNDECLARED: injects "storage" without declaring "service:storage" …` | 清单 `deepStudent.permissions` 没写 `service:storage` |
| 降级，`missing service "storage"` | 宿主没有存储服务：测试宿主默认不提供，`loadExample` 要传 `storage: true` |
| `ASYNC_IN_SYNC_TX` | `transaction` 的回调返回了 Promise；有 `await` 的读改写用 `write` |
| `UNKNOWN_DATABASE` | `close` 的句柄不是 `openFile` 打开的，或已经关过 |

`openFile` 不检查路径，放在 `plugins/<id>/` 下是约定，不是隔离（`docs/plugins/SECURITY.md` 第 5 节）。

## 8. 日志与错误

- 生产代码不用 `console.*`，用 `ctx.logger('<id>')`（§1，`host/kernel/API.md` §10）。日志保留原错误的具体文本，凭据先脱敏。
- 空 catch、`catch { void 0; }`、`catch (e) { void e; }` 都视为规避扫描。
- 远程方法（§2）的错误用 `CommandError(<可序列化的值>)` 抛出，UI 收到的就是这个值；其他异常对 UI 只是 `Unknown`。
- 服务方法按提供方 `api.ts` 声明的错误类型抛出，不要擅自改成字符串或吞掉。
- 耗时操作接受 `AbortSignal`；插件卸载时，`ctx.effect` 登记的资源自动清理。

## 9. 测试

测试跑真实 kernel（同一套注册表、契约校验、错误、事件、生命周期），只把 Electron main 换成内存记录。`provide` 是唯一放
其他服务替身的地方。

```ts
// examples/plugins/alice-greeter/__tests__/greeter.test.ts
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../../host/kernel/testing.ts';
import plugin from '../index.ts';

describe('alice.greeter', () => {
  it('greets with the configured greeting', async () => {
    const host = await createTestHost({ plugins: [[plugin, { greeting: 'Hi' }]] });
    try {
      expect(host.ctx.get('aliceGreeter')!.greet('Ada')).toBe('Hi, Ada');
      expect(() => host.ctx.get('aliceGreeter')!.greet(' ')).toThrow('name is required');
    } finally {
      await host.dispose(); // 每个测试都要调用
    }
  });
});
```

- 要走社区清单筛查、UI 半、`plugin:host|call` 时，用 `examples/testing/harness.ts`：`loadExample(profile)` 按生产路径装载 profile，
  `createUiKernel(host)` 建真实 UI 内核并接到测试宿主（示例见 `examples/plugins/study-goal/__tests__/study-goal.test.tsx`），
  `installUiHalf(kernel, uiHalf)` 安装 UI 半并交出它的 `ctx.ui.host`，用来直接测 `meta.remote` 方法。
- 发布前的检查：`examples/testing/conformance.ts` `describeConformance`（W09 清单门禁、Host 启动期与安装期检查、模块检查、UI 构建产物只依赖共享模块）。
- 只测生产路径：调用真实服务、`host.invoke`、内核；不要断言测试自己构造的字面量。
- 测试放在插件目录的 `__tests__/` 里，用 `examples/vitest.config.ts` 运行；仓库外的插件目录用 `DS_PLUGIN_DIR=<目录>`（`examples/README.md`）。

## 10. 版本兼容

| 对象 | 兼容规则 |
|---|---|
| 插件 id | 发布后不变；改名等于新插件 |
| `engines.deepStudent` | 针对应用版本（根 `package.json#version`）；0.x 阶段 `^0.11` 不包含 0.12.0；预发布版本的应用不满足任何范围 |
| `engines.deepStudentPluginApi` | 可选的独立插件 API 主版本，当前支持字符串 `"1"`。应用升级与发版验收见 [UPGRADES.md](UPGRADES.md) |
| `manifestVersion` | v1 固定为 1；更高的版本被旧应用以 `MANIFEST_VERSION_UNSUPPORTED` 拒绝 |
| 服务名 | 由 id 派生；版本由 `api.ts` 导出的描述对象声明，破坏性变更换新名字，旧服务保留一个发布周期 |
| 服务方法 | 只能新增可选参数或方法；删除、改语义、改错误类型都算不兼容 |
| 事件名与载荷 | 新增兼容；删除或改载荷不兼容 |
| Kernel API | 只依赖 `host/kernel/api.ts` 与 `host/kernel/testing.ts`；标 `@stable` 的导出只做向后兼容扩展（`host/kernel/API.md` §16.5） |

Host 用 Node 原生类型擦除运行 TypeScript，只能用**可擦除的语法**：不要用构造函数参数属性（`constructor(private x)`）、`enum`、
带实现的 `namespace`。字段显式声明并在构造函数里赋值，枚举用 `as const` 常量对象加同名类型。

发布社区插件时，在 README 写明测试过的应用版本，以及依赖的服务名与 `version`。

## 11. 提交前检查清单

- [ ] 清单通过 `contracts/plugin-manifest/v1.schema.json`；`id`、`version` 与 Host 半、UI 半的 `meta` 一致。
- [ ] `meta.provides` 都在自己的服务名空间里，且与实际提供的服务完全一致；`inject` 都在 `permissions` 里。
- [ ] Host 半只从 kernel `api.ts`、其他插件 `api.ts`（类型）导入；UI 半只导入四个共享模块。
- [ ] 没有 `console.*`、空 catch、`void e` 规避；日志走 `ctx.logger`。
- [ ] 远程方法都列在 `meta.remote`，错误用 `CommandError`。
- [ ] 资源用 `ctx.effect` 登记，卸载后无泄漏；没有打开官方注册库。
- [ ] 测试调用生产路径，`createTestHost` 后 `dispose()`；`describeConformance` 全部通过。

## 12. 参考

- `host/kernel/API.md`：命令、事件、协议、生命周期、Profile、测试宿主、插件生态 v1 的完整语义。
- `docs/plugins/CAPABILITIES.md`：官方服务 seam、命令、事件。
- `docs/plugins/FRONTEND.md`：前端插件化的总体设计。
- `examples/`：可运行的示例、脚手架与测试工具。
- 文档里的 ts/tsx 代码块由 `examples/testing/docs.test.ts` 做类型检查，引用的仓库路径与符号由它核对。
