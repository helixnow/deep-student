# 基座阶段（Foundation）：分工、冻结边界与规则

基座阶段的目标是让 29 条 lane 能以最大并行度开工，具体要做到四点：
- 冻结接口：lane 之间只通过已冻结的接口交互；
- 提供可直接使用的测试宿主：lane 的测试不需要 Electron，也不需要别的 lane；
- 契约与骨架自动生成：每条 lane 开工时，命令清单、契约和测试去向表都已预填；
- 不碰 Rust：只读 Rust 源码，不编译、不运行。

总方案见 [README.md](README.md)，lane 任务卡见 [lanes.md](lanes.md)。

## 冻结边界（协调者编写，已提交）

| 文件 | 内容 | 消费方 |
|---|---|---|
| `host/kernel/protocol.ts` | Electron main/preload 与 Host 之间的消息协议 | F1、F2 |
| `host/kernel/contract.ts` | `contracts/ipc/<lane>.json` 的格式 | F1、F5、全部 lane |
| `host/kernel/api.ts` | 插件编写接口（`definePlugin`、`ctx.commands`、`ctx.backendEvents`、`ctx.app`、`ctx.shell`、`CommandError`） | 全部 lane |

基座代理可以**增补**这些文件（新增可选字段、新增类型），不得改变已有语义。如果确实
需要不兼容的修改，先写进 `contracts/CHANGES.md`，在最终报告里说明。

## 基座代理分工

| 代理 | 拥有路径（只写这些） | 产出 |
|---|---|---|
| **K 内核**（F1） | `host/kernel/**`（三个冻结文件只能增补） | 基于 Cordis 的 Host 运行时：命令路由与契约校验、Tauri 框架错误、事件、MessagePort 连接、profile 加载、插件生命周期；`host/kernel/testing.ts` 测试宿主；`host/kernel/API.md` |
| **S 外壳**（F2） | `electron/**` | Electron main、preload 中的 Tauri 兼容桥（`__TAURI_INTERNALS__`、事件、window/webview/path API、10 个 Tauri 插件命令）、协议注册、utilityProcess 托管 Host；`npm run dev:electron` 能加载真实前端 |
| **C 契约**（F5） | `scripts/electron-migration/contracts/**`、`contracts/ipc/**` | 用 tree-sitter-rust（wasm）静态抽取全部命令、事件和 serde 类型，生成 `contracts/ipc/<lane>.json` 与 `UNRESOLVED.md`；再生成 TS 类型，以及 `--check` 漂移检查 |
| **D 存储**（F3） | `host/platform/storage/**` | 先发布 `api.ts` 接口；基于 better-sqlite3（Electron ABI）的连接、事务、批次；兼容 refinery 的迁移器（同一张 history 表、同样的校验和算法、同一批 SQL） |
| **P 平台服务**（F4 接口与实现） | `host/platform/{secrets,settings,log,paths}/**` | 先发布各自的 `api.ts`；keyring 与加密兼容、设置存储、日志、应用路径 |
| **G 骨架与门禁** | `scripts/electron-migration/{scaffold.mjs,ledger.mjs,boundaries.mjs,services-draft.mjs}`、`host/plugins/*/`（只建骨架）、`contracts/services/**`、`.github/workflows/electron-migration.yml` | 每条 lane 的插件骨架，SPEC/TESTMAP 预填全部命令与 Rust 测试；跨 lane 服务调用草稿；ledger 生成器；host 边界检查；CI |

这几个代理之间的依赖都只经过冻结文件，不需要互相等待：
- K 与 S 通过 `protocol.ts` 对接，S 的测试用自带的最小 Host 进程验证协议，不依赖 K 的实现进度。
- K 与 C 通过 `contract.ts` 对接，K 的测试用手写的小契约样例。
- G 只读 inventory 与 `contract.ts` 的格式；契约文件就绪后，`scaffold.mjs --refresh` 可以重跑。
- D 与 P 互相独立，只依赖 `api.ts` 的 Cordis `Service` 约定。

## 共同规则（每个代理必须遵守）

1. **不碰 Rust**：禁止运行 cargo、rustc，禁止启动 Tauri 应用。Rust 源码只读，Tauri 的
   行为依据 `~/.cargo/registry/src/*/tauri-2.11.5/` 的源码，refinery 的行为依据
   `refinery-core-0.9.0/`。
2. **只写自己的路径**。禁止修改 `package.json`、`package-lock.json`、`tsconfig*.json`、
   `vitest*.config.ts`、`src/**`（前端），也禁止修改其他代理的路径。需要新依赖时，写进
   最终报告，不要自己装。已预装：`@deepseek-ai/cordis@4.0.5`、cordis-plugin-loader/include、
   `better-sqlite3@13.0.3`、`ajv@8.20.0`、`electron@45.2.1`（内置 Node 24.22，ABI 150）、
   `@electron/rebuild`、`@napi-rs/keyring@2.1.2`、`web-tree-sitter@0.27.1`、`tree-sitter-wasms@0.1.13`（含
   `out/tree-sitter-rust.wasm`）。
3. **工作区里有别人未提交的试验改动**（`src/plugin-runtime/*`、`scripts/plugins/*`、
   `src/plugins/translation/*`、`src-tauri/crates/dstu-translation-core/*`、
   `docs/dev/plugin-migration/`、`examples/plugins/`），不得读取后依赖、修改或删除。
   已提交的 `src/plugin-runtime/host.ts`（f3958900）可以作为语义参考，但不受它约束。
4. **git 纪律**（AGENTS.md）：
   - 每完成一个可验证的单元，用 `git commit -m … -- <自己的路径>` 立即提交；
   - 禁止 `git add -A`、`stash`、`reset --hard`、`checkout --`、`clean`；
   - 不推送；
   - 提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
5. **不做冒充**：生产路径不得出现 mock、TODO、`unimplemented`、空 catch，也不得用"简化版"
   代替原语义。确实做不完的部分，在报告里如实列出，不要写成"已完成"。
6. **验证**：`npm run typecheck:host` 与 `npm run test:host` 必须通过。需要 better-sqlite3 的
   测试用 `npm run test:host:electron`。
7. **TS 风格**：ESM，`.ts` 扩展名导入（`allowImportingTsExtensions`），严格模式，Node 24 API。

## 基座完成定义（G0）

- K：`createTestHost()` 能加载插件、按契约校验 invoke、返回 Tauri 一致的错误、记录事件；
  真实 Host 进程能通过 MessagePort 接受 S 的连接。
- S：`npm run dev:electron` 打开真实前端；未注册命令返回 Tauri 一致的 not-found 错误；
  Tauri 插件命令、事件、窗口 API 在桥内实现，或者明确路由到 Host。
- C：全部命令有契约；`UNRESOLVED.md` 列出全部未确定的形状；`contracts:check` 可用。
- D：`api.ts` 已冻结；迁移器能从空库跑完全部迁移；已有库可以识别并继续迁移；校验和与
  refinery 一致（用 refinery 源码中的算法加测试向量证明）。
- P：`api.ts` 已冻结；密钥能按原 service/account 名读写；加密格式与 Rust 一致（向量取自
  Rust 测试断言或源码常量）。
- G：29 个 lane 骨架就绪，TESTMAP 预填 8036 行；`contracts/services/DRAFT-*.md` 已生成；
  CI 工作流能运行 typecheck、test:host、inventory 与契约检查。
