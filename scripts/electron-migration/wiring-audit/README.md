# X4 服务接线审计

从仓库根目录运行（Node 支持原生 TypeScript 类型擦除，依赖仓库已安装的 `typescript`）：

```sh
node scripts/electron-migration/wiring-audit/audit.mjs
node scripts/electron-migration/wiring-audit/audit.mjs --json
node scripts/electron-migration/wiring-audit/audit.mjs --check
node --test scripts/electron-migration/wiring-audit/audit.test.mjs
```

更新可读原始证据（不是手工维护的接线结论）：

```sh
node scripts/electron-migration/wiring-audit/audit.mjs --markdown > scripts/electron-migration/wiring-audit/evidence.md
```

- `--check` 在硬 inject 环、任一生产请求的名字无提供方、入口加载失败时退出 1。包括 `get`、子 inject、旧名回退、可选测试 seam；不会因为替身在测试里提供了该名就放行。不豁免 `browserSurface` 等有默认实现的可选入口；它们需要人工区分，不意味着功能必坏。
- 只运行模块导入读取真实 `default.meta` / `inject`；**不执行 apply，不安装插件，不打开用户数据库，不运行 Rust**。动态 commands 数组、import/spread 的 provides 与普通字面量同样正确读取。
- 扫描全部 `host/plugins/<dir>/index.ts`、平台同层入口和 desktop profile 中的入口。生产图是这些入口的非 type-only 导入可达闭包；profile 是否包含插件另外列出。不是函数级调用证明，也不是已成功启动的服务数。
- TypeScript AST + 本地符号识别 Cordis Context；不把同名工具 `ExecutionContext` / `PipelineContext` 的字段当成服务。支持属性、方括号、`get`、`reflect.get`、顶层 inject、子 inject、仓库的 `optionalService` / `ctxGet` / `lookup` / `attach` 包装器。纯类型/注释不会创造消费者。
- 当前动态表达式主要是上述包装器的声明体；具体调用点已展开。`unresolved` 保留未作通用数据流证明的位置。新包装器/动态生成服务名仍需人工审查，不能声称静态分析穷尽任意 JS。
- 环只用顶层必需 inject 建图；`ctx.inject` 子 fiber 不阻塞提供方父 apply，不能把它与顶层硬依赖混为一谈。
- 测试桥接包括 meta.provides、`ctx.provide` / `reflect.provide`、Service 的 `super(ctx, name)`、`createTestHost({ provide: { … } })`。只把正式提供或正式请求的名字列入桥接清单；不把测试 helper 服务混入生产提供方。
- 缺失诊断是候选，不是每条都算迁移缺陷：例如正常维护模式、Anki 未打开、移动平台不支持，均可能延续 Rust 原行为。入口不可达文件另标 `reachable=false`。
- `fallbacks` 另列 Context 读取（及局部变量初始化链）来源的 if/条件表达式/空值默认分支，以发现没有错误字样的静默降级；普通配置分支也可能命中，仍需对照 Rust 判断。
- 无其他插件消费者的服务由 `classifications.mjs` 记录已审读分类与证据。已知命令入口、`meta.remote` 前端入口、本插件内使用不误判为死功能；新出现的无消费者服务为 `needs-review`，不靠“插件有 commands”就自动豁免。

人工接线责任、Rust 调用点与接口要求见 `docs/dev/electron-migration/audits/X4-wiring-audit.md`；完整逐位置证据见 `evidence.md`。工具不修改插件与 profile。

## 集成门禁交接（执行 owner 由架构师决定）

在固定提交的仓库根目录执行的确切命令：

```sh
node scripts/electron-migration/wiring-audit/audit.mjs --check --json
```

集成门禁本身按架构师规则不走普通重任务队列；普通 lane 手动诊断仍先 `job.mjs submit -- <命令>`。集成 owner 保存原 stdout JSON、stderr、实际进程退出码及提交 SHA，不能只截取通过行。本 lane **不修改全局门禁配置，不给停放的 F5 排队**。

- **exit 0**：在当前工具发现/扫描范围内，`missing=[]`、`cycles=[]`、`loadErrors=[]`。不等于所有插件 apply 成功、Electron 启动或业务 A/B/C 验收通过。
- **exit 1 + 有效报告 JSON**：以上任意集合非空。正常审计发现，不当作 agent 异常退出；按 JSON 中的具体原因交回责任方。模块导入失败会保留在 `loadErrors`，不能当纯服务缺名忽略。
- **进程非零且缺有效 JSON、被信号杀死等**：工具/依赖/作业基础设施错误；原退出码、stderr/堆栈单独留证，不伪造一份“0 个问题”的报告。队列 `result` 的 75 只表示未完成，不是审计结论。
- **不触发该检查退出码的项**：孤岛分类、诊断候选、`profileOmissions` 本身；它们仍是报告内容。不能拿退出 0 推断这些项均为零。

`browserSurface` 是严格规则的已知语义边界：生产 `get` 该名而无插件提供它，但有正确的 `ShellBrowserSurface(ctx.shell)` 默认实现。现有 `--check` **仍将它列入 missing 并退出 1**（已在固定基线 `3b2758d7a` 实测；其他 SHA 以该次运行的 JSON 为准）。`--check` 目前是 report-only，上线规则由架构师/X6 决定。本交接不添加豁免、不删扫描、不造假 provider，也不建议因为这条告警再实现一个服务；架构师/执行 owner 决定在清单尚红时如何启用门禁，不能用 `|| true`、丢弃 JSON 或过滤日志冒充门禁通过。其他旧名或硬注入问题仍独立保留，不因可选 seam 存在被一并掩盖。

## 2026-11-04 刷新边界说明

前轮 `e1278b78e` 的 14 项 needs-review 已在 main `9c13dfc39` 逐项读对象/方法调用路径后分类，结果写回 `classifications.mjs`，未重写扫描算法。`rust-unwired-candidate`（llmRag）和 `not-approved`（nativeHeic/D5）不属于迁移必须激活的能力；不能用服务名猜功能。即使两个服务共用实例，也需区分已调用的 sync 子面与未接的 reset/delete 子面。

`dstu.shell` 现已进入 desktop profile，已发现的 36 个插件均在清单；“shell 漏装”仅对历史 e127 快照成立。现有工具可从 profile 导入其 meta，但静态枚举仍为 host/，因此 profile 全含/模块可导入不等于 shell 方法、startupGate finalizer 或全 Host 已跑通。详细逐项分类、固定 SHA、队列作业退出码以及保留的分支待集成项见上述报告。

夹具使用自己的结构类型 `fixtures/host/plugins/consumer/context.ts`，不声明真实 provider、不扩充生产 Cordis 类型；故意缺失的服务仍须被检出。可用全局队列执行定向类型检查：`job.mjs submit -- npx tsc --noEmit -p scripts/electron-migration/wiring-audit/tsconfig.fixtures.json`，以及上方单文件 Node 回归；重 CPU 命令不直接并发运行。

## 本工具测试覆盖（非 Rust TESTMAP）

本 lane 新增审计工具，不移植 Rust 单元测试，因此没有原 lane 的 TESTMAP 可续写。`audit.test.mjs` 覆盖：运行时计算 meta / 不调用 apply、各种服务读取与行号、同名非 Cordis 上下文排除、type-only 与不可达模块、测试桥不补生产依赖、诊断定位与无错误文案的条件分支、SCC / 自环、子注入不形成启动环、退出码规则、真实 CLI 的 0/1、命令/remote/未知服务分类、profile 遗漏。
