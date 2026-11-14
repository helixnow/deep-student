# 插件生态 v1：必须现在定的 7 项决策

日期：2026-11-07（用户拍板）
依据：`plans/DSH-ECOSYSTEM-STUDY.md` 第 5 节（对照 DeepSeek Harness `fcc0ad46` / 0.2.2-rc.1）

## 现状（2026-11-07 核实，集成提交 `68d37526`）

- 两种 manifest 并存（`plugin.json` 的 schema 和 `package.json#deepStudent`），Host 和前端加载器运行时都不读取；社区插件靠 `user.profile.json` 的 `module` 路径装载。
- 示例插件 `examples/plugins/community-word-of-day/package.json` 写的是 `engines.deepStudent: "^1.0"`，应用版本却是 `0.11.0`。
- host 里只有 1 处 `@stable` 标注（`host/plugins/chat-pipeline/api.ts`）。

## 决策

1. **API 稳定性：最小稳定面。** 只承诺“插件 API v1”，包括三部分：UI SDK、kernel `api.ts` 中面向插件的导出、显式标注 `@stable` 的服务。主版本内只增不改；共享模块的主版本也算 API 的一部分。其余 API 一律视为实验 API，社区插件要使用必须显式选择加入。
2. **插件 id：`<publisher>.<name>`。** 保留 `dstu` 等官方前缀；id 发布后不可修改；服务名、槽位贡献 id、存储、i18n 命名空间、数据目录全部由 id 派生。示例插件从 `community.*` 改为 `example.*`。
3. **Manifest：唯一使用 `package.json#deepStudent`。** 带 `manifestVersion: 1`，废弃 `plugin.json`。`engines` 放在 `package.json` 顶层；`requires` 带版本范围。Host 装载时先检查 engines，再严格校验其余字段。
4. **权限：`kind:target` 语法。** kind 是封闭集合，v1 只有 `service:<服务名>`；遇到未知 kind 一律拒绝。权限增加时需要用户重新同意。社区插件只会被注入它声明过的服务。
5. **版本协商：使用应用版本号。** `engines.deepStudent` 是针对应用版本的 semver 范围，必填。安装时不兼容就拒绝；启动时不兼容只降级该插件，不阻断启动。示例插件改为 `^0.11`。
   - 后果一：semver 在 `0.x` 阶段，`^0.11` 不包含 `0.12.0`，1.0 之前每个小版本都可能让社区插件失配。这与“1.0 前不开放社区插件”一致。开放社区时应用随之发布 1.0。
   - 后果二：从 1.0 起，应用版本号的语义受插件 API 约束。破坏稳定面（决策 1）的改动必须升应用主版本；应用的小版本和补丁版本不得破坏插件 API v1。
6. **配置 schema：Schemastery `Config`。** 在 `apply` 之前校验配置并补默认值；配置归属插件 id；凭据不得写进配置；插件主版本内只能新增带默认值的字段。依赖用 `@deepseek-ai/schemastery`（已在 `node_modules` 中，需补为直接依赖）。待核实：我们自写的 profile 装载路径是否会触发 Cordis 对 `Config` 的校验。
7. **前后端配对：一个包 = 一个 id = 一个版本。** Host 半和 UI 半同版本发布；跨半调用只走 `meta.remote`；`platforms` 在包级别声明。

## 落地分工（P0，在各 lane 当前轮次交付后接续）

顺序：W09 先在 `contracts/plugin-manifest/v1.schema.json` 定出 manifest 契约，这是唯一来源。W01 的 Host 运行时校验和 W17 的 UI 加载器、校验器都按它实现，并各自带一致性测试，不另写一份 schema。

- **W01（kernel）**：
  - Host 装载时读取并校验 `package.json#deepStudent`，按应用版本检查 engines；
  - 校验 id 格式和保留前缀，由 id 派生各命名空间；
  - 在 `apply` 前用 Schemastery 校验 `Config`，并核实 profile 装载路径；
  - 实现 `service:` 权限注入限制；
  - 给 kernel `api.ts` 做类型快照、补 `@stable` 标注、开 `no-deprecated` lint。
- **W17（UI 内核）**：
  - UI 半读取同一份 manifest，按决策 7 配对；
  - 社区插件不能向未登记的槽位贡献；
  - `plugin.json` 校验器改为校验 `package.json#deepStudent`；
  - 示例插件改为 `example.*`、`^0.11`。
- **W09（门禁）**：校验官方插件和示例插件的 manifest、id 格式，以及 engines 必填。
- **W06（依赖）**：把 `@deepseek-ai/schemastery` 补为直接依赖（只改 lock 文件）。

P1、P2（离线插件包与回滚、安全模式、配置表单、签名索引等）见调研文档第 4 节，迁移完成后再排。
