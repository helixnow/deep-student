# 派发：L20b-sync-support（同步支撑模块，从 L20 拆出）

你是 Deep Student 桌面版从 Tauri/Rust 迁移到 Electron/Node（TypeScript）工程中 **L20b-sync-support** 的负责代理。
仓库：`/Volumes/macOS2T - Data/dev/deep-student`。L20 同步引擎是全项目关键路径（L22、L23 共约 730 个测试在等它），
协调者把同步引擎中相对独立的支撑模块拆给你，L20 专注 `sync/mod.rs` 的 SyncManager 主体。

## 本 lane

| 项 | 内容 |
|---|---|
| 目录（只写这里） | `host/plugins/sync-support/` |
| Rust 范围 | `src-tauri/crates/dstu-sync/src/data_governance/sync/` 下的 `tombstone.rs`（3014 行）、`note_history.rs`、`pomodoro_counts.rs`、`state.rs`、`conflict_resolver.rs`，以及这些文件内的全部测试 |
| 规模 | 约 5.6K 行 Rust（含内联测试） |
| 提供 | `sync.support@1`（在 `api.ts` 中发布：tombstone 清单与 GC、note_history 依赖收集、番茄计数合并、同步状态持久化、冲突解析器），供 L20 的 SyncManager 调用 |
| 消费 | F3 存储、L10 notes 的 `api.ts`（note_history 相关）、L20 已发布的 `sync@1` 中的 HLC/LWW 等工具 |
| 特别注意 | 插件 `meta.lane` 写 `L20-sync`（这些代码在 inventory 中归 L20）。**第一个提交就发布 api.ts**，L20 正在等它。测试行记在 L20 的 `host/plugins/sync/TESTMAP.md` 中；你把移植后的测试放在自己的 `tests/`，在报告中列出 `测试 id → ported:<路径>` 对照，由协调者同步（你不能写 `host/plugins/sync/`）。表的写入只经 F3 存储接口，SQL 放在你自己的 `repository/`。 |

## 硬性要求（违反任意一条即视为任务失败）

**本任务的意图**：把 Rust 后端中属于 `L20b-sync-support` 的业务，**逐命令、逐行为**地迁移为 TypeScript Host 插件，
语义与原 Rust 完全一致，前端一行不改即可继续使用。这不是重新设计，也不是写原型。

必须：
1. **范围**：只迁移本 lane 拥有的 Rust 文件与命令（业务 lane 见 LANE.md；F lane 见 `migration/spec/` 与 `migration/testmap/` 下的 F*.md，及下文任务清单）。每个命令名、参数键、返回值形状、
   错误值、事件名与载荷、数据库读写都与 Rust 一致；以 `contracts/ipc/L20-sync.json` 为线上形状的依据。
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

## 必读（按顺序）

1. `AGENTS.md`：共享工作区并发纪律、HashMap 序列化禁令、rustfmt 规定（本任务不改 Rust）。
2. `docs/dev/electron-migration/README.md`：§2 架构、§3 契约与语义清单、§4 优先级、§5 三级完成定义。
3. `docs/dev/electron-migration/foundation.md`：「共同规则」一节**必须逐条遵守**。
4. `docs/dev/electron-migration/decisions.md`：已裁定的语义与已知缺口。
5. 插件编写：`host/kernel/API.md`（命令、错误、事件、协议、服务、`createTestHost`、profile）。
6. 平台服务：`host/platform/API.md`（paths/secrets/settings/log）、`host/platform/storage/API.md`
   （数据库、事务、`?N` 占位符、repository 约定、DQS=0 注意事项）。
7. **`docs/dev/electron-migration/quality.md`：质量规范（抽检发现的共性偏差，必须逐条遵守）。**
8. 本 lane 的预填文件：`host/plugins/<目录>/{LANE,SPEC,TESTMAP}.md`；契约
   `contracts/ipc/L20-sync.json` 和 `contracts/ipc/generated/L20-sync.ts`；未确定的形状见
   `contracts/ipc/UNRESOLVED.md`；跨 lane 依赖草稿 `contracts/services/DRAFT-L20-sync.md`。

## 工作方式

- **优先级**：A 迁移完成并跑通 > B 静态验证 > C 动态验证。录制暂缓，C 级本轮不做。
- **语义来源只有 Rust 源码和原测试**（只读）。不编译、不运行 Rust，不启动 Tauri。
  不接受"类似实现"；发现 Rust 的 bug 也保持原行为，写进报告，不顺手修。
- **先发布接口**：本 lane 提供给别人的服务，第一个提交就发布 `host/plugins/<目录>/api.ts`
  （类型 + Cordis `declare module` 增强），其他 lane 会照着它写代码。发布后只能增补。
- **消费别人的服务**：只 import 对方的 `host/plugins/<x>/api.ts` 或 `contracts/`，经 Cordis
  `inject` 取用，不引用对方的 `src/`。对方 `api.ts` 还没发布时，按 DRAFT 写出你需要的最小
  接口，测试里用 `createTestHost({ provide })` 提供替身；接口差异写进报告，由协调者对齐。
- **错误形状**：命令的 `Err` 以契约中的 `error` schema 为准。`AppError` 序列化为
  `{error_type, message, details}`（`details` 总是存在）；`CommandError` 为
  `{code, message, data?, traceId?}`。用 `CommandError(value)` 抛出。F4 会发布共享的构造函数，
  发布前按契约形状直接构造。
- **插件结构**：`host/plugins/<目录>/index.ts` 默认导出 `definePlugin({ meta: { id, lane, commands, provides }, inject, apply })`；
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
npx vitest run -c vitest.host.config.ts host/plugins/<目录>
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
