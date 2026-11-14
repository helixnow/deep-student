# Deep Student 插件架构

Deep Student 的桌面后端是一棵 Cordis 插件树（与 DeepSeek Harness 同一框架）。**官方功能全部以插件形式实现，
没有特权内核**。社区插件用同一套机制（提供服务、订阅事件、UI 贡献），另受插件生态 v1 约束：清单与权限在装载前检查，
id 不能用保留的发布者，服务名由 id 派生（`host/kernel/API.md` §16）。所以社区插件与官方插件**并存**，不能顶替官方
插件或官方服务；要换一种实现，就提供自己的服务（[SDK.md](SDK.md) §3.3）。

本文定义插件之间的约定。面向插件作者的上手指南见 [SDK.md](SDK.md)；当前全部服务、提供方与消费方见
自动生成的 [CAPABILITIES.md](CAPABILITIES.md)。

## 1. 分层

```
Electron 外壳（electron/）      窗口、协议、Tauri 兼容桥；不含业务
Host 内核（host/kernel/）        Cordis 运行时：命令路由与契约校验、事件、协议、profile、插件生命周期
平台服务（host/platform/）       storage · secrets · settings · log · paths · time · util · net-policy · native
业务插件（host/plugins/）        llm · chat · vfs · notes · qbank · anki · sync · …（官方，id 为 dstu.*）
社区插件                          与业务插件同一机制，经用户 profile 装载；装载前做清单与权限检查
```

依赖只能自上而下：业务插件依赖平台服务和其他插件**发布的服务**，平台服务不依赖业务插件。门禁
（`scripts/electron-migration/boundaries.mjs`）机械保证这一点：插件之间只能 import 对方的 `api.ts`；原生模块只能出现在平台层。

## 2. 扩展点

| 扩展点 | 机制 | 典型用途 |
|---|---|---|
| **服务**（seam） | 在 `api.ts` 声明接口，插件 `ctx.provide`，消费方 `inject` | 官方插件之间的接口；社区插件提供自己名字空间里的服务（如 `exampleWebSearch`） |
| **命令** | `ctx.commands.register(name, handler)`，按 `contracts/ipc` 校验 | 官方前端可调用的能力；名称和形状受契约约束，只给官方插件 |
| **远程方法** | `meta.remote` 列出服务方法，UI 半经 `plugin:host\|call` 调用 | 社区插件的 UI 半调用自己的 Host 半 |
| **事件** | `ctx.backendEvents.emit/listen`；插件间使用 Cordis 事件 | 前端通知、跨插件解耦的业务事实；`ctx.backendEvents` 只给官方插件（社区插件 `KERNEL_API_FORBIDDEN`） |
| **工具** | 智能体工具注册表（`agentTools`） | 官方插件给 AI 增加能力，无需改对话管线；目前不给社区插件用（`docs/plugins/SDK.md` §3.4） |
| **协议** | `ctx.protocols.register(scheme, handler)` | 流式文件、媒体 |

新增能力时，先问它属于哪个扩展点，再按下面的约定实现。**不要为了一个功能去修改另一个插件的实现文件。**

## 3. 服务约定

一项可替换能力 = **服务定义**（`api.ts` 中的接口与类型）+ **提供方**（实现它的插件）+ **消费方**。
三者分离，才能做到"换一个提供方就改变整个产品"。

**命名（新服务立即遵守，既有服务在迁移收尾时统一更名）**

- `ctx` 上的服务名使用 lowerCamelCase 标识符，**不带版本号、点号或 @**，例如：`ctx.llm`、`ctx.anki`、
  `ctx.vfsRepo`、`ctx.webSearch`、`ctx.syncProvider`。这样插件作者写 `ctx.anki`，而不是 `ctx['anki@1']`。
- 服务的**版本**通过 `api.ts` 导出的描述对象声明：

  ```ts
  // host/plugins/anki/api.ts
  export const ankiService = { name: 'anki', version: '1.0.0' } as const;
  ```

  采用语义化版本。**小版本只增不改**：可以新增可选方法和字段，不能改变已有方法的语义或形状。
  需要破坏性修改时，提供新名字的服务（例如 `ankiV2`），旧服务继续保留一个周期。
- 一个服务只有一个提供方。社区插件不能提供官方服务名（`SERVICE_NAME_INVALID`）；要换实现，提供自己的服务，
  由需要它的插件显式注入（`examples/plugins/community-web-search`）。官方服务换提供方是代码库内的修改。

**服务接口的写法**

- 只暴露业务语义的方法（例如 `createNoteInFolder`），不暴露数据库连接或内部表结构。
- 输入输出使用 `contracts/` 生成的类型或本插件 `api.ts` 中定义的类型；不得引用其他插件的实现文件类型。
- 异步方法接受 `AbortSignal`；错误使用平台的 `AppError` / `CommandError` 形状。
- 每个公开方法都有一行注释，说明对应的 Rust 来源（迁移期）或语义。

## 4. 数据所有权

- **每张表只有一个写入插件。** 其他插件需要读写时，调用它的服务。
- SQL 只出现在插件的 `repository/` 中；连接、事务和迁移由平台 `storage` 提供。
- 跨插件的原子操作必须由提供方插件在一个事务里完成，并作为服务方法暴露。不要在调用方拼接多个插件的写入。

## 5. Profile

`host/profiles/desktop.json` 由 `host/profiles/generate.ts` 扫描 `host/plugins/*/index.ts` 生成，列出全部官方插件。
用户 profile（`extends: "official"`）可以：

- 设置 `disabled: true`，不装载某个官方插件（注入它服务的插件随之停用）；
- 追加社区插件。

同 id 条目替换先前的条目，但社区包的清单 id 必须等于条目 id，而 `dstu.*` 是保留的：把官方 id 指向社区包会以
`ID_MISMATCH` 拒绝（`host/kernel/manifest.ts` `checkManifest`）。任何插件的 `meta.provides` 都必须与实际提供的服务
一致，否则装载失败。装载、降级与回退的完整规则见 [SDK.md](SDK.md) §6 与 `host/kernel/API.md` §8、§16。

## 6. 稳定性承诺

| 级别 | 内容 | 承诺 |
|---|---|---|
| 稳定 | 内核 `api.ts`、平台服务的 `api.ts`、标注 `@stable` 的业务服务 | 遵守语义化版本 |
| 实验 | 未标注的业务服务 | 可能变化，会写进 CHANGES |
| 内部 | 插件的 `src/`、`repository/` | 不对外，门禁禁止引用 |

跨应用版本升级和插件数据保留见 [UPGRADES.md](UPGRADES.md)。

## 7. 与 DeepSeek Harness 的对应关系

| DSH | Deep Student |
|---|---|
| Cordis 插件树、无特权内核 | 同一框架；内核只做路由、校验和生命周期 |
| capability seam（定义、提供方、消费方） | 服务约定（第 3 节）与 CAPABILITIES.md |
| profile、组合包、patch | profile JSON：`extends`、`disabled`、追加社区插件 |
| `ctx.tools`、`ctx.llm` 等可替换注册表 | 智能体工具注册表、`ctx.llm` 及其适配器 |
| 事件三分（会话、Agent、能力） | 前端事件（契约约束）与插件间 Cordis 事件 |

## 附录 A：既有服务更名表（2026-11-03 起执行）

提供方 lane 负责修改自己 `api.ts` 中的 `declare module` 键、`meta.provides`、`ctx.provide(...)`，并导出版本描述
（`export const <名字>Service = { name: '<名字>', version: '1.0.0' } as const;`）。消费方一律使用新名字。

| 旧名 | 新名 | 提供方 |
|---|---|---|
| `agent.approval@1` | `agentApproval` | agent-workspace |
| `agent.workspace@1` | `agentWorkspace` | agent-workspace |
| `agent.automation@1` | `agentAutomation` | agent-orchestration |
| `agent.subagent@1` | `agentSubagent` | agent-orchestration |
| `agent.skills@1` | `agentSkills` | agent-skills |
| `agent.tools@1` | `agentTools` | agent-skills |
| `anki@1` | `anki` | anki |
| `chat.pipeline@1` | `chatPipeline` | chat-pipeline |
| `chat.session@1` | `chatSession` | chat |
| `chat.state@1` | `chatState` | chat |
| `docs@1` | `docs` | media |
| `media@1` | `media` | media |
| `ocr@1` | `ocr` | media |
| `lance@1` | `lanceEngine` | vfs-index |
| `retrieval@1` | `retrieval` | vfs-index |
| `vfs.index@1` | `vfsIndex` | vfs-index |
| `vfs.repo.core@1` | `vfsRepo` | vfs-repos |
| `llm.adapter@1` | `llmAdapters` | llm-providers |
| `notes@1` | `notes` | notes |
| `qbank@1` | `qbank` | qbank |
| `sync@1` | `sync` | sync |
| `sync.provider@1` | `syncProvider` | sync-providers |
| `websearch` | `webSearch` | browser |
