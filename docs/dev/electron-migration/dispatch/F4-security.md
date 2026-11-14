# 派发：F4-security（安全与平台服务（续））

你是 Deep Student 桌面版从 Tauri/Rust 迁移到 Electron/Node（TypeScript）工程中 **F4-security** 的负责代理。
仓库：`/Volumes/macOS2T - Data/dev/deep-student`。只写：`host/platform/{secrets,settings,log,paths,errors,diagnostics}/`。

## 任务

基座阶段的 paths/secrets/settings/log 已完成。本轮任务：
1. **关键路径**：发布 `host/platform/errors/api.ts`——`AppError`（被 21 条 lane 消费，序列化形状
   `{error_type, message, details}`，见 `contracts/ipc/_shared.json`）及其构造函数（`AppError::database`、
   `validation` 等，与 `crates/dstu-core/src/models.rs` 逐个对应）、`CommandError`/`ErrorDetails`。
   **第一个提交就发布。**
2. 注册 F4 的 44 个命令（secure_*、debug log、diagnostics、包管理器检测等）。
3. dstu-core（77 个测试）、dstu-util（64 个测试）中被多条 lane 共用的类型与工具：放进
   `host/platform/` 下合适的位置并发布 api.ts。
4. **对账 TESTMAP**：基座阶段的移植记录在 `host/platform/TESTMAP.md`，ledger 只读
   `migration/testmap/F4-security.md`，逐行改为 `ported:<路径>`。
5. Argon2 性能：Electron 下 64 MiB 约 2.3 秒，评估 wasm 实现（hash-wasm）是否逐字节一致，一致则切换。

## 与本 lane 相关的已裁定事项

- **Electron 的 Node 没有 `crypto.argon2`**（BoringSSL）：DSBK 备份加密改用 `@noble/hashes`
  的 argon2（已改为直接依赖，1.8.0）。默认 64 MiB 参数在 Electron 下约需 2.3 秒，而 OpenSSL
  约 95 毫秒。换成 wasm 或原生实现（hash-wasm / @node-rs/argon2）的事交给 F7 评估。· F4/F7 · 待评估
- **密钥兼容向量（待补）**：
  - Rust 实际写出的 `.secure/*.enc`、`.master_key`、`api_configs` 与 DSBK 样本，等 F6 录制时导出；
  - Linux Secret Service 下 keyring 3.6.3 与 @napi-rs/keyring 能否互读，需要在 Linux 桌面验证；
  - Windows DPAPI 互操作，以及 `os.hostname()` 与 `GetComputerNameExW` 是否一致（影响 legacy v2 密钥），需要在 Windows 上验证。
  · F4/F6 · **待办（C 级）**
- **共享 crate 的测试归属**：dstu-core 的 77 个、dstu-util 的 64 个测试，随使用它们的 lane 迁移；
  `error_details_tests`（14 个）归 F1；`cloud_half_configured_credentials_tests`（5 个）归 L23。· F4 · 已决
- **日志与诊断中的细节差异**（不涉及持久化数据）：JS 的 `\b` 只认 ASCII；整数样键的对象顺序；
  f64 的 `1.0` 与 `1`；`io::Error` 文案只覆盖常见 errno。· F4 · 已接受

## 硬性要求（违反任意一条即视为任务失败）

**本任务的意图**：把 Rust 后端中属于 `F4-security` 的业务，**逐命令、逐行为**地迁移为 TypeScript Host 插件，
语义与原 Rust 完全一致，前端一行不改即可继续使用。这不是重新设计，也不是写原型。

必须：
1. **范围**：只迁移本 lane 拥有的 Rust 文件与命令（业务 lane 见 LANE.md；F lane 见 `migration/spec/` 与 `migration/testmap/` 下的 F*.md，及下文任务清单）。每个命令名、参数键、返回值形状、
   错误值、事件名与载荷、数据库读写都与 Rust 一致；以 `contracts/ipc/F4-security.json` 为线上形状的依据。
2. **逐个读 Rust 源码再写 TS**：每个函数的分支、默认值、边界条件、错误文案、排序、时间与 ID 格式都照搬。
3. **测试**：Rust 测试逐个移植为 TS 测试（测试标题包含 Rust 测试函数名），断言含义不变；先移植测试，再让实现通过。
4. **持续工作直到完成**：这是无人值守任务，**不要停下来提问或等待确认**。完成标准是：
   `npm run migration:ledger -- --check --no-write` 显示本 lane 全部命令达到 A 级、TESTMAP 没有 pending 行，
   或者剩余项在最终报告中逐条写明真实的阻塞原因。不要提前宣布完成。
5. **小步提交**：每完成一组命令及其测试并通过检查，就提交一次（命令见下文）。
6. **本 lane 自有的 Rust 代码不是阻塞**：LANE.md 中属于本 lane 的文件，无论多大都要迁移。真实阻塞只有三类：其他 lane 的服务未发布（先写最小接口+测试替身完成自己这边）、F7 未提供的原生依赖、协调者/用户明确暂缓的项。
7. 语义不确定时以 Rust 源码为准；源码也无法确定时，选与 Rust 最接近的实现，并在最终报告"语义歧义"一节写明。

禁止：
- 修改本 lane 允许写入的路径以外的任何文件（若不是本 lane 的路径，就包括 `src/` 前端、`src-tauri/` Rust、`package.json`、`tsconfig*`、
  `vitest*`、`contracts/`、`host/kernel/`、`host/platform/`、其他 lane 的目录、`docs/`）。
  契约与 Rust 不符时写进报告，不要手改契约。
- 运行 cargo/rustc、启动 Tauri 应用、`npm install`/升级依赖、整仓格式化。
- 生产代码中出现 mock/fake/stub、TODO/FIXME、`unimplemented`/"not implemented"、空 catch、
  返回假数据或"暂时简化"的实现。做不到的命令就不要注册，留在报告里。
- 删除、跳过（`.skip`）或弱化测试断言来让测试通过；修改 SPEC/LANE/TESTMAP 中 `GENERATED` 标记之间的内容
  （可以勾选清单、填写状态列、在标记外补充说明）。
- 新增与迁移无关的抽象层、框架、工具函数库、文档或总结性 Markdown；"改进"原有行为或顺手修 Rust 的 bug。
- `git add -A`、`git stash`、`git reset --hard`、`git checkout --`、`git clean`、`git push`、修改 git 配置。

## 单元工作协议（每个命令 / 函数 / 服务方法都按这 7 步走）

1. **行为清单**：在 SPEC 对应小节写出 Rust 中的：输入校验、所有分支、返回形状、错误文案（含库错误的原样 Display）、
   **日志（每个 warn!/error!/info!）**、副作用及其相对事务提交的位置、事件、所用 crate 的隐式默认行为（重试、重定向、
   超时、Drop/kill、chrono 格式、regex 方言）。
2. **先移植测试**（标题含 Rust 测试名，断言含义不变，走生产代码路径）。
3. **实现**：只照行为清单写，不新增、不简化、不"改进"。
4. **补全隐式部分**：清单中的每条日志都用 ctx.log / 插件 logger 记录；每个"Rust 忽略错误后继续"的位置照做；
   事务与提交后副作用的位置和 Rust 一致。
5. **接入**：命令已注册 / 工具已登记 / 服务已 provide，且确实有生产调用方。没有接入就不能算完成。
6. **自检**：typecheck、本插件测试、`node scripts/electron-migration/importable.mjs <目录>/index.ts`（Node 原生类型擦除能否加载）、`npm run migration:boundaries:strict`、`npm run migration:wiring -- --lane <目录>`。
7. **提交**，然后进入下一个单元。

## 完成协议（结束本轮前必须执行）

- 运行并在最终报告中**原样粘贴**以下输出：`npm run migration:ledger -- --check --no-write` 的最后一行、
  `npm run migration:wiring -- --lane <目录>`、`npm run migration:boundaries:strict` 中属于本 lane 的行。
- 逐条列出本 lane 仍为 pending 的项及**证据**：阻塞类别（其他 lane 未发布的具体 api 符号 / F7 未提供的具体能力 /
  协调者暂缓），写不出证据的就不是阻塞，继续做。
- 不要因为"本轮做了很多"就结束；只要还有自有的 pending 且没有证据阻塞，就继续。

## 钻空子对照表（左边的写法一律视为违规，按右边做）

| 禁止 | 正确做法 |
|---|---|
| `catch { void 0 }`、`catch (e) { void e }`、拆字符串躲过扫描器 | 按 Rust 记录日志后继续，或写属实理由的 boundary-allow |
| boundary-allow 理由与 Rust 不符（如写"Rust 仅 warn"却不记 warn） | 理由必须属实，且行为一致 |
| 测试未接入的模块然后标 ported | 先接入；不能接入就保持 pending 并注明缺什么 |
| 断言自己构造的字面量 / Math.min / 源码 grep / stub 掉被测逻辑 | 调用生产代码，断言 Rust 测试断言的同一事实 |
| 自行标 obsolete | 在报告中申请，协调者批准后才生效 |
| 删除或削弱断言、.skip 让测试通过 | 修实现；做不到就保持 pending |
| 复制其他 lane 的逻辑或直接写其表 | 调用对方 api.ts；没有就写最小接口并在报告中提出 |
| 手写替代成熟库（丢失其默认行为） | 在报告中申请安装同源 npm 库 |
| 把自有代码说成"依赖/阻塞" | 自有代码不是阻塞，继续迁移 |

## 必读（按顺序）

1. `AGENTS.md`：共享工作区并发纪律、HashMap 序列化禁令、rustfmt 规定（本任务不改 Rust）。
2. `docs/dev/electron-migration/README.md`：§2 架构、§3 契约与语义清单、§4 优先级、§5 三级完成定义。
3. `docs/dev/electron-migration/foundation.md`：「共同规则」一节**必须逐条遵守**。
4. `docs/dev/electron-migration/decisions.md`：已裁定的语义与已知缺口。
5. 插件编写：`host/kernel/API.md`（命令、错误、事件、协议、服务、`createTestHost`、profile）。
6. 平台服务：`host/platform/API.md`（paths/secrets/settings/log）、`host/platform/storage/API.md`
   （数据库、事务、`?N` 占位符、repository 约定、DQS=0 注意事项）。
7. **`docs/dev/electron-migration/quality.md`：质量规范（抽检发现的共性偏差，必须逐条遵守）。**
8. 本 lane 的预填文件：`<本 lane 路径>/{LANE,SPEC,TESTMAP}.md`；契约
   `contracts/ipc/F4-security.json` 和 `contracts/ipc/generated/F4-security.ts`；未确定的形状见
   `contracts/ipc/UNRESOLVED.md`；跨 lane 依赖草稿 `contracts/services/DRAFT-F4-security.md`。

## 工作方式

- **优先级**：A 迁移完成并跑通 > B 静态验证 > C 动态验证。录制暂缓，C 级本轮不做。
- **语义来源只有 Rust 源码和原测试**（只读）。不编译、不运行 Rust，不启动 Tauri。
  不接受"类似实现"；发现 Rust 的 bug 也保持原行为，写进报告，不顺手修。
- **先发布接口**：本 lane 提供给别人的服务，第一个提交就发布 `<本 lane 路径>/api.ts`
  （类型 + Cordis `declare module` 增强），其他 lane 会照着它写代码。发布后只能增补。
- **消费别人的服务**：只 import 对方的 `host/plugins/<x>/api.ts` 或 `contracts/`，经 Cordis
  `inject` 取用，不引用对方的 `src/`。对方 `api.ts` 还没发布时，按 DRAFT 写出你需要的最小
  接口，测试里用 `createTestHost({ provide })` 提供替身；接口差异写进报告，由协调者对齐。
- **错误形状**：命令的 `Err` 以契约中的 `error` schema 为准。`AppError` 序列化为
  `{error_type, message, details}`（`details` 总是存在）；`CommandError` 为
  `{code, message, data?, traceId?}`。用 `CommandError(value)` 抛出。F4 会发布共享的构造函数，
  发布前按契约形状直接构造。
- **插件结构**：`<本 lane 路径>/index.ts` 默认导出 `definePlugin({ meta: { id, lane, commands, provides }, inject, apply })`；
  SQL 只放在 `repository/`；测试放在 `tests/`。
- **测试移植**：每个 Rust 测试移植成 TS 测试，**测试标题包含 Rust 测试函数名**；TESTMAP 状态写
  `ported:<ts 测试文件路径>`、`merged:<目标路径>` 或 `obsolete:<理由>`（obsolete 需协调者批准，
  先写 pending 并在报告里申请）。SPEC 每个命令的勾选项按 Rust 源码逐条核对后勾上。
- **原生依赖**（LanceDB、pdfium、starlark、tiktoken、FSRS 优化器、Office 解析等）由 F7 在
  `host/platform/native/*` 提供。需要时先写出你需要的接口（放在本 lane 目录的
  `native-needs.md`），测试里用替身；不要自己引入原生模块。
- **进度**：只看 `npm run migration:ledger -- --check --no-write` 的计算结果，不自报。

## 每个工作单元提交前必须通过

```sh
npm run typecheck:host
npx vitest run -c vitest.host.config.ts <本 lane 路径>
npm run migration:boundaries:strict
npm run migration:ledger -- --check --no-write
```

用到 better-sqlite3 等原生模块的测试，再用 `npm run test:host:electron` 跑一遍。

## git 纪律（独立工作树）

你在**本 lane 专属的 git worktree** 中工作（路径与分支见本提示开头），其他 lane 各有自己的工作树，
协调者负责把各分支合入 main。
- 只写本 lane 允许的路径；改动超出范围的分支**不会被合入**。
- 每完成一个可验证单元立即 `git add <本 lane 路径> && git commit -m "…"`，不要积攒大量未提交改动
  （协调者每 10 分钟会把未提交改动自动存为 WIP 提交，但那只是兜底）。
- 开工时和每次提交前执行 `git merge --no-edit main`，获取其他 lane 已发布的 `api.ts` 与协调者的修正；
  如出现冲突，执行 `git merge --abort`，继续工作并在报告里说明。
- ledger 检查请用 `npm run migration:ledger -- --check --no-write`（不要提交 `migration/` 下的生成文件）。
- 禁止 `git push`、`git stash`、`git reset --hard`、`git checkout --`、`git clean`、`git rebase`、切换分支、修改 git 配置。
- 提交信息末尾加 `Co-Authored-By: <你的模型名>`。
- **中断恢复**：如果你是被"继续"消息唤醒的，先看 `git log --oneline -20`、`git status` 和 TESTMAP，从中断处继续，
  不要重做已提交的工作。

## 最终报告

1. ledger 中本 lane 的 A/B 百分比，以及未达 A 的命令和原因；
2. TESTMAP 统计（ported/merged/obsolete 申请/pending）；
3. 发布的 `api.ts` 摘要，与 DRAFT 不一致之处；
4. 对其他 lane 的接口需求、原生依赖需求、新 npm 依赖需求；
5. 发现的 Rust bug（保持原行为）、语义歧义（建议写入 decisions.md 的条目）；
6. 提交哈希。
