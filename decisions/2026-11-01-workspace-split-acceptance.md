# 后端拆分（dstu-* Cargo workspace）验收报告

日期：2026-11-01
分支：`wt/split-main`（本地，未推送）
计划：`C:\Users\Administrator\.config\openchamber\projects\path_RDovZGVlcC1zdHVkZW50\plans\1793421619826-dstu-cargo-workspace.md`（12 步）
执行记录与门禁日志：`C:\Users\Administrator\AppData\Local\Temp\opencode\arch\`（`gate-*.txt`、`final-*.log`、`itests-results.txt`）

## 1. 结果

`src-tauri` 由单 crate（约 76 万行、89 个模块互相成环）拆成 25 个 workspace 成员（24 个 `dstu-*` + app），
分层守卫 `scripts/check-crate-layers.mjs` 通过，新增规则「agent 层不得依赖 domain 层」。

| 层 | crate（行数） |
|---|---|
| core | dstu-core（7.8k）、dstu-kernel（1.2k） |
| base | dstu-util（2.8k）、dstu-platform（3.1k）、dstu-security（6.3k） |
| infra | dstu-storage（43.3k）、dstu-docs（5.8k）、dstu-testkit（dev-only） |
| service | dstu-llm（63.4k）、dstu-vfs（121.4k） |
| capability | dstu-agent-api（1.7k）、dstu-mcp（13.5k）、dstu-vision（6.3k）、dstu-learning（2.9k）、dstu-memory（14.6k） |
| domain | dstu-anki（42.9k）、dstu-qbank（28.9k）、dstu-notes（6.8k）、dstu-media（15.1k）、dstu-tutor（7.5k）、dstu-research（5.1k）、dstu-browser（8.2k）、dstu-sync（67.6k） |
| agent | dstu-agent（196.3k，chat_v2 管线 / 注册表 / hooks / 审批 / 会话存储） |
| app | deep-student（135.3k：组合根、AppState、唯一的 `generate_handler!`、37 个与业务域耦合的工具执行器、依赖 AppState 的薄命令包装） |

关键机制：
- 依赖反转统一走 `dstu-kernel`（`Slot` / `HookSet` / `PluginHost`），所有注册集中在 `src/extensions.rs` 组合根。
- chat_v2 管线通过注入的 `ExecutorRoster` 取得执行器花名册（app 的 `AppExecutorRoster`），分发顺序与拆分前逐字一致，
  由 oracle 测试锁定（`agent_wiring/tests/roster_tests.rs`、`legacy_tests.rs`）。
- AppState 保留为 app 内聚合；共享服务另行 `manage(Arc<T>)`（同一实例），agent 侧只读托管的 Arc。

## 2. 验收（全部在本机执行）

| 项目 | 结果 |
|---|---|
| `cargo check --workspace --all-targets` | 通过；无新增警告类别 |
| `cargo build` | 通过 |
| `cargo fmt --all --check`、分层守卫、迁移静态门禁、第三方许可 | 通过 |
| mobile-slim feature 组合 | 通过 |
| 接口快照（命令、handler、事件） | 与基线一致；唯一新增是 OpenCode Go 的 `opencode_go_get_usage`（功能新增，非拆分回归）；19 处注入 State 类型变化（均换成已托管的同一 Arc） |
| 单元测试 `cargo test --workspace --lib`（25 个测试程序） | ok 6770 / FAILED 21 / ignored 11；基线 ok 6695。**按测试函数名对比回归 0**，21 个失败全部属于基线既有的环境类失败 |
| 集成测试 `src-tauri/tests`（94 个，基线未覆盖） | 83 通过、11 失败；11 个在拆分前基线（main `04932be8`）上同样失败，失败位置一致；`sync_scenarios_tests` 拆分后失败 3 个，为基线 6 个的子集。**无拆分引入的回归** |
| `tsc --noEmit` | 通过 |
| `vitest run`（1567 文件） | 5 个失败：3 个单独重跑通过（全量并发负载抖动），2 个 KaTeX 用例因验收环境的 node_modules 路径被 Vite 拒绝；无与拆分相关的失败 |
| `npm run tauri dev` 冒烟 | 应用启动，主窗口 "Deep Student" 出现且响应；启动日志无新增错误 |

已知、既有、未在拆分中修改的问题：
- `question_bank_service` 的 4 个「今日」测试在本地时间 00:00–08:00 运行会失败（本地日期 vs UTC 时间戳），白天通过。
- `sync_r12_backup_lease::source_lock_backup_lease_has_zero_production_wiring` 在 Windows 上失败（路径分隔符比较），拆分前相同。
- `get_auto_backup_status` / `test_web_search_connectivity` 未注册（parallel-plan §7.4）。

## 3. 编译体验

基线（拆分前，`measure-before.txt`）：改 `translation/pipeline.rs` 后增量 `cargo build` 188s、增量 `cargo check` 255s；
默认 dev 配置下测试编译会内存不足失败（本次在基线上复测集成测试时，单体 crate 的 rustc 仍因内存耗尽崩溃，需关闭调试信息才能编过）。

拆分后：完整测试程序编译 3m40s 一次通过；改业务域代码只重编对应 crate + app。具体对比数据见第 4 节。

## 4. 增量编译对比

同一机器、同一源文件（翻译管线；拆分后位于 `crates/dstu-tutor/src/translation/pipeline.rs`）：

| 场景 | 拆分前 | 拆分后 |
|---|---|---|
| 改文件后增量 `cargo check` | 254.7s | **7.4s** |
| 冷启动后的完整 dev build | 499.0s（warm-build） | 268s |

增量 build 在桌面端运行期间未测（运行中的 exe 被占用，无法重新链接）。

## 5. OpenCode Go

`feat/opencode-go`（67f840bc）已移植到拆分后的结构并合入：请求门控与 `opencode_go.rs` 在 dstu-llm，headless / 压缩 / 标题在 dstu-agent，
作文批改模型过滤在 dstu-tutor。见 `decisions/2026-10-31-opencode-go-integration.md`。

## 6. 发版前追加合入与复验（2026-11-01）

在拆分验收之后，同一分支又合入：

| 内容 | 说明 |
|---|---|
| OpenCode Go 调整 | 供应商图标、列表置顶第二、一键分配（对话默认 / 会话标题 / 上下文压缩 → DeepSeek V4.1 Flash）、去掉备注；「仅限 Agent 对话」改为建议，用户可手动配给任意功能 |
| 前端架构优化第一波 | `openchamber/frontend-arch`（27 个提交：App.tsx 拆分、TauriAdapter / MCP 设置 / LearningHubSidebar / mindmapStore 拆分、分层守卫、lint 棘轮、UI 规范文档）。冲突 2 处（package.json 脚本、一个源码契约测试的路径），两边保留 |
| Super-agent（实验） | 由会话 deep-student-c9 的未提交工作移植并补完，见 `decisions/2026-11-01-super-agent.md` |

复验结果（本机）：

| 项目 | 结果 |
|---|---|
| fmt / crate 分层 / 前端分层 / 迁移门禁 | 通过 |
| 接口快照 | 新增仅为 `opencode_go_get_usage` 与 9 个 `superagent_*` 命令（发布前已重做为 6 个 `super_session_*` / `chat_v2_super_deliver_inbox` 命令，见 `2026-11-01-super-agent.md`） |
| `cargo build` | 通过 |
| Rust 单元测试（workspace --lib） | ok 6821 / FAILED 23 / ignored 11；按函数名对比基线回归 0。比第 2 节多出的 2 个失败是 `cloud_storage::webdav` 的连接测试，单独运行通过（并行时被其他测试置位的全局“云同步已取消”标志干扰），非代码回归 |
| clippy `-D clippy::correctness`（workspace --all-targets） | 通过 |
| mobile-slim（`--no-default-features --features mobile-slim`）、许可清单 | 通过 |
| tsc / eslint | 通过；eslint 0 error，lint 棘轮无新增 |
| vitest 全量 | 12521 通过；3 个失败：KaTeX（验收环境路径）、2 个负载抖动（单独重跑通过） |
| CI 脚本测试（`scripts/__tests__`） | 与基线一致（仅 NDK 探测 1 个 Windows 环境失败） |
| 桌面端 + 真实模型 | Super-agent 端到端通过（见其决策记录）；测试产生的数据已清理 |

本轮顺带修复的 CI 问题：
- AppContainer 边界测试随 chat_v2 移到 dstu-agent，CI 里的 `cargo test --lib <filter>` 只跑根包，会以 0 个测试“通过”；已改为 `-p dstu-agent`。
- `check-migrations` 脚本的测试夹具仍按拆分前的 MigrationDef 位置生成 `include_str!` 路径，9 个用例失败；已同步。
