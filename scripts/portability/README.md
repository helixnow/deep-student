# 可移植性扫描：判定规则

`node scripts/portability/scan.mjs`（实现在 `lib/portability.mjs`，测试 `node --test scripts/portability/scan.test.mjs`）。

## 什么算 Node 依赖

逐文件做语法分析，不做类型检查：

- `node:*` 和裸写的内置模块（`fs`、`node:fs/promises` 都记为 `node:fs`）；
- 原生模块（better-sqlite3、koffi、sharp、`@lancedb/*` 等）；
- Node 专用的 npm 包（undici、ws、jsdom 等）；
- 值位置的 Node 全局量，例如 `Buffer`、`process`、`setImmediate`、`global`。`declare global {}`、属性名和被本地变量遮蔽的同名标识符都不算。

`import type`、`export type` 和类型位置的引用记成 `-type` 键：它们参与工作量估算，但不进入运行时闭包，profile 检查不管它们。

运行时闭包只沿非 `import type` 的相对导入走。注意 `import { type X, y }` 这种混合导入在 `verbatimModuleSyntax` 下仍然会加载该模块。

## `--check`：全局基线（只拦新增）

1. 扫描 `host/plugins/*/` 的生产文件（不含测试），把 (文件, 依赖键) 和 `baseline.json` 比较，基线里没有的报 `NEW`，退出码为 1。
2. 仅桌面豁免：
   - 插件入口 `index.ts` 的 `meta.platforms` 恰好是 `['desktop']` 时，该插件的文件不报 `NEW`。
   - **没有声明 `platforms` 的插件不豁免**。缺省进桌面只是历史状态，不是一个决定。
   - **共享面不豁免**：仅桌面插件里，凡是能从“可移植根”在运行时走到的文件，照常报 `NEW`，并标出 `（仅桌面插件的共享面：经 X 在运行时可达）`。可移植根包括：所有未豁免插件的生产文件，以及任何插件目录下的 `mobile.ts`。典型例子：notes 值导入了 `agent-skills/api.ts`，那么即使 agent-skills 声明了仅桌面，`api.ts` 及其闭包里的新增 Node 依赖也会报出来。
3. 只要存在 `host/profiles/mobile.json`，就同时执行下面的 profile 检查，任一模块失败退出码即为 1。`--no-profile` 可以跳过这一步。
4. 基线只能收紧。依赖减少后运行 `--write-baseline`。不得把别人路径里的 `NEW` 写进基线，正确做法是消除依赖，或者声明仅桌面。
   已有基线时，`--write-baseline` 对豁免文件只保留旧基线里已有且仍存在的键，不会把 `--check` 不报的新依赖写进去；`--check` 为 0 新增时，重写结果就是旧基线减去已消除的条目。

## `--profile <profile.json>`：装配闭包

- 只检查 profile 实际装配的模块：对每个条目的 `module`，看它的运行时闭包（含插件外的平台、kernel 文件）是否触达 Node 依赖。没装配的插件不管，不论它声明了什么平台。
- profile 由 `host/profiles/generate.ts` 生成：插件按 `meta.platforms` 进入对应平台，平台目录有 `mobile.ts` 时，移动端用它代替 `index.ts`。手改 `mobile.json` 会被 `generate.ts --check` 和 `host/profiles/platforms.test.ts` 拦下。要把插件装进移动端，正确做法是让插件声明 `platforms: ['desktop', 'mobile']`。
- 移动端 Host 的引导模块（`host/kernel/connection.ts` 等）不在 profile 里，不受这项检查。它们剩下的 `node:path` / `node:fs` / `node:url` 由 `mobile/` 构建的 shim 接住；构建时，任何没有 shim 的 `node:*` 都会直接报错。

## `--mobile-readiness`：哪些插件可以装进移动端

对每个插件入口（有 `mobile.ts` 时用它）输出 `ready` 或 `blocked`。阻塞来源分两类：

- `own`：插件自己的哪些文件含 Node 依赖；
- `gateways`：插件值导入的插件外模块中，哪些模块的闭包含 Node 依赖。

装配哪些插件以这个结果为准：先 `ready`，再由插件 owner 声明 `mobile`。
