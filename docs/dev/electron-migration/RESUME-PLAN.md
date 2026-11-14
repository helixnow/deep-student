# 恢复线上派发方案（第二阶段）

> 状态：**提案**，主 agent 审阅后执行（执行步骤见 `RESUME-RUNBOOK.md`）。W11 第四轮，2026-11-07。
> 依据：`ORCHESTRATION-LOG.md`、`ASSAULT-PLAN.md` §3/§6、`INTEGRATION-NOTES.md`、`plans/FRONTEND-PLUGINIZATION.md`、
> 各 `assault/*` 分支相对 `base-ae4efdf9e` 的提交，以及 `.transfer/inflight/*.patch` 逐文件吸收核对（方法见 §1.3）。

恢复后的线上 lane 不再做三件事：**补文档、刷映射、重复催办**；也不重做本机已完成的工作。为此：

- lane 集合按 §1 处置：60 条 lane 中 12 条退役、20 条并入、28 条继续；另新增 6 条第二阶段 lane（P1–P6）。
  处置写成机器可读的 `dispatch/DISPOSITION.proposed.json`，审阅后改名为 `DISPOSITION.json` 生效；
  生效后 `lib/lane-paths.mjs` 把退役 / 并入 lane 的路径交给接手 lane，`coord.mjs assign/restart` 与 `oc-dispatch launch` 拒绝退役 lane，
  `lane-paths.test.mjs` 校验“每条 lane 都有处置、没有无人负责的路径”。
- 工作只从 §2 的工作包表派发。每个包的验收只认提交号、测试结果、门禁结果、计数脚本输出；文档勾选、TESTMAP 去向、看板文字都不算。
- 协调者契约（C0/C1/C2/S0）已按新优先级更新（§3）。
- 恢复后盯 §4 的指标，空转按 §4.2 的定义判定并介入。

## 1. lane 处置

### 1.1 判据

| 处置 | 条件 | 处理 |
|---|---|---|
| 退役 | 在途工作已被突击吸收，或该 lane 的职责在第二阶段已无事可做 | 分支打 `retired/<lane>` 标签保留（不删）；`oc-dispatch park`；路径交给 `into` 指定的 lane |
| 并入 | 剩余工作与另一条 lane 同域、规模小，或复核/语料类工作改为集中做 | 同上打标签；未吸收的在途改动由接手 lane 以工作包形式重放 |
| 继续 | 有明确的第二阶段工作包 | 用新的任务卡范围；旧会话不续用（新会话，见 RESUME-RUNBOOK 第 6 步） |

“吸收”以代码为准，不以报告为准：对 `.transfer/inflight/<lane>.patch` 的每个文件，在接手分支的树上执行
`git apply --cached --check -R --include=<文件>`（能反向应用 = 已吸收）与正向 `--check`（能正向应用 = 未吸收），两者都不行记为“已分叉”。

### 1.2 处置表

在途补丁一列是 §1.3 核对结果（已吸收 / 未吸收 / 已分叉 的文件数）；“—”表示服务器上该 lane 没有相对 main 的在途改动。

| lane | 处置 | 接手 | 在途补丁 | 理由与新范围 |
|---|---|---|---|---|
| C0-chief | 继续 | — | — | 判据改为第二阶段（§3） |
| C1-app | 继续 | — | 文档 0/1/0 | 只从 §2 派包；派发前查重（§3.2） |
| C2-platform | 继续 | — | 文档 0/1/0 | 集成、验证；核对黄金路径与 G3 正式录制结果 |
| S0-architect | 继续 | — | 0/4/1 | 编排层运维（W11 部署后的巡检、报告、质量反馈定时器）；`s0-selftest.mjs` 与 `gate-excerpt.mjs` 的在途改动按 WP2-067 评估 |
| F1-kernel | 继续 | — | 0/4/0 | 在途 serde 内部标签枚举校验未吸收（WP2-003）；FE-A3/FE-C4 的 kernel 增补；iLink/QR 迁出 kernel |
| F2-shell | 继续 | — | — | Agent 内嵌浏览器私网 DNS 检查（W06 交接）、FE-A5 preload 平台信息、FE-E2 插件协议 |
| F3-storage | 继续 | — | — | secure-store 临时目录回落禁用（W07 风险）、anki_media 槽位路径基准（W10 交接）、移动端 SQLite 适配 |
| F4-security | 继续 | — | — | W01 遗留“按 Rust 映射正确错误类型”的基础设施、lint 判据、日志敏感字段审计；`host/platform/util/` 交给 P1 |
| F5-contracts | 并入 | P3 | — | 提取器与生成物已由 W09 重做（extractor 1.6，`4b24d55`） |
| F7-native | 继续 | — | — | darwin-arm64 预编译（sqlite-busy 21 个本机失败）、WASM 模块在 WebView 内可用 |
| L01-llm-providers | 退役 | P1 | — | 系统代理等由 W05 完成（`746612f`） |
| L02-llm-manager | 退役 | P1 | **9/0/0** | 在途补丁全部被 W05 吸收（`5de772c`） |
| L03-chat-pipeline | 退役 | P1 | — | 看门狗与 schema 过滤由 W02/W05 完成（`10b4589`、`ed27ec1`、`aefa56b`） |
| L04-chat-session | 继续 | — | — | 发布 chat worker 运行时服务（WP2-010，解锁 3 个执行器）、AttachmentStage 外壳、chatanki 工具面 metadata |
| L05-agent-workspace | 继续 | — | 2/6/0 | 代码部分被 W02 吸收（`56e6b5d`），未吸收的 6 个是 LANE/SPEC/BLOCKERS 与 wp288 原件，不重放；新范围 WP2-013/014 |
| L06-agent-orchestration | 继续 | — | 1/2/0 | 测试被 W02 吸收；未吸收的 2 个是 G3 语料与说明，交 X7 评估；新范围 WP2-011/012 |
| L07-agent-skills-ptc | 继续 | — | — | 9 个技能/MCP/连接器执行器（WP2-015/016）、agent-skills 可移植性与共享 ZIP |
| L10-notes | 退役 | P1 | — | S03 由 W10 钉住（`706d632`） |
| L11-vfs-repos | 并入 | L14 | — | 剩余是 qbank 与 vfs-repos QuestionRepo 的 SQL 合并（WP2-038） |
| L12-vfs-index | 退役 | P1 | — | `mm_index_progress` 由 W09 发出（`489bd73`） |
| L13-vfs-api | 退役 | P1 | — | 命令 A 级已满，无在途 |
| L13b-vfs-handlers | 退役 | P1 | — | 重复发 `mm_index_progress` 的交接项在集成时处理 |
| L14-qbank | 继续 | — | — | W03 剩余题库工具、QuestionRepo 合并、共享 ZIP、`decodePreview` 去重 |
| L15-review-analytics | 退役 | L14 | — | ReviewTool/EssayGrading 由 W03 完成（`afaf490`、`7f72415`）；REVIEW_CONFLICT 归 WP2-023 |
| L16-anki | 继续 | — | — | 共享 ZIP 迁移、anki_media 槽位（与 F3）、并入的 chatanki 剩余 |
| L17-memory-research | 继续 | — | **0/14/0** | 在途补丁一个都没被吸收，且 WP-170 仍是 partial blocked；新范围 WP2-017/018 |
| L18-media-docs | 退役 | P1 | **29/0/1** | 被 W04 吸收（`be6d2b4`）；唯一分叉的 `media/index.ts` 已被 W04 拆分重写（`8104b9e`） |
| L19-mcp-browser | 继续 | — | — | browser 插件经 shell 下发私网策略（WP2-050，与 F2 配对）；mcp/browser 仅桌面声明 |
| L20-sync | 继续 | — | **0/3/0** | 学习者画像默认 merger 是真实缺陷修复（WP2-001）；变更日志漂移；sync 可移植性 |
| L20b-sync-support | 并入 | L20 | 0/5/0 | lazy-open 修复要在 W08 的异步 I/O（`dde1735`）之上重放（WP2-002） |
| L21-backup-governance | 继续 | — | 0/12/0 | WP-234 G3 语料与 migration-diagnostic 测试（WP2-004）；仅桌面声明与 Windows 路径交接（WP2-044） |
| L22-app-commands | 退役 | P1 | — | 命令 A 级 99.8%，收口结束 |
| L23-sync-providers | 继续 | — | 文档 0/1/0 | 可移植性最重的插件之一（约 43%，WP2-041）；在途只是说明文字，随包更新 |
| L24-chatanki | 并入 | L16 | 0/3/0 | 只有 BLOCKERS 说明与语料参数修正（`args: {}`），随 L16 的包重放 |
| R1-review-llm | 并入 | R3 | — | 第二阶段复核改为按包抽检，后端合为一条 |
| R2-review-agent | 并入 | R3 | — | 同上 |
| R3-review-vfs | 继续 | — | 文档 0/1/0 | 后端第二阶段工作包的独立复核（执行器安全、错误映射、可移植性） |
| R4-review-sync | 并入 | R3 | — | 同 R1 |
| R5-review-learning | 并入 | R3 | — | 同 R1 |
| R6-review-frontend | 继续 | — | — | 前端插件化包的独立复核（五层回归零差异） |
| U1-ui-boot | 继续 | — | 文档 0/1/0 | FE-00、FE-A3 前端半、FE-A5、FE-E1/E2；W16/W17 交付后的维护 |
| U2-ui-shell | 继续 | — | — | FE-B1、B4、B7、B9，之后 FE-D1 |
| U3-ui-settings | 继续 | — | — | FE-B10，之后 FE-D4 |
| U4-ui-content | 继续 | — | — | FE-B2、B3、B5、B6、B8，之后 FE-D3 |
| X1-e2e-smoke | 继续 | — | 14/46/0 | W12 吸收了启动器与探针（`f89c96e`）并写了 5 条黄金路径；新范围 WP2-060/061 |
| X2-frontend-contracts | 并入 | P3 | — | 前端调用键门禁由 W09 实现（`29f81d0`） |
| X3-data-compat | 退役 | X1 | — | localStorage 迁移由 W07 完成；冷启动读旧数据是 W12 黄金路径 1（`f8c0a7a`） |
| X4-wiring-audit | 并入 | P3 | — | 并入功能可达性门禁（`c65549b`） |
| X5-stream-parity | 退役 | X1 | — | X5-01/03 已关闭（`96719d7`） |
| X6-gate-checks | 并入 | P3 | — | 门禁与账本代码由 W09 重做 |
| X7-differential | 继续 | — | 34/0/3 | 代码被 W13 吸收（`cffae73`），3 个分叉的录制脚本以 W13 版本为准；新范围 G3 正式录制（WP2-062/063） |
| W-L04、W-L10、W-L13a、W-L13b、W-L14、W-L15、W-L16、W-L18、W-L19 | 并入（9 条） | X7 | — | G3 语料写入归正式录制 lane，按录制需要补，不再按命令数铺语料 |

**统计**：退役 12、并入 20、继续 28，合计 60。新增 6 条：P1-plugin-health、P2-portability、P3-gates-ledger、P4-mobile-proto、P5-plugin-sdk、P6-ui-features（任务卡在 `dispatch/P*.md`，路径在处置表 `paths` 段）。

服务器上实际的 `ds-mig/*` 分支以 `git branch --list 'ds-mig/*'` 为准。本表覆盖全部 60 份 v3 任务卡；分支存在但不在表里的，按“退役、接手 P1”处理，并在 RESUME-RUNBOOK 第 3 步的清单里列出。

### 1.3 在途补丁核对（2026-11-07 本机）

`.transfer/inflight/` 是 01:43 从服务器取的“分支相对 main”的差异，不含工作树里未提交的改动。逐文件核对的接手分支：
F1→W01，L02→W05，L05/L06→W02，L17→W03，L18→W04，L20/L24→W10，L20b/L21/L23→W08，S0→W09 与 W11，X1→W12，X7→W13，文档类→integration。
结论里需要注意的三点：

1. **L17 没有被吸收**。W03 只按 ASSAULT-PLAN 把 L17 补丁当作“参考”，自己另写了 Memory 执行器；L17 的 HPIAS 研究链路（14 个文件，含 `hpias-research.ts`、`hpias-service.ts`）仍在分支上，WP-170 自述 partial blocked。WP2-018 按 Rust 真实 backend 路径重做 retrieval，L17 分支只作参考。
2. **L20 / L20b 是真实缺陷修复**，不是文档：前者让 sync 在没有显式 merger 时使用 memory 安装的学习者画像 merger（Rust `SYNC_FIELD_MERGER` 槽位），后者让 `sync_state.db` 首次读写时才打开（Rust 只在同步命令里 `open_default()`）。都带回归测试，优先重放（WP2-001/002）。
3. **X1 的 46 个未吸收文件**大多是 B 端驱动、seed 捕获、job barrier 等检查脚本与报告；W12 用真实窗口重写了冒烟。WP2-061 逐个评估，有价值的检查并入 W12 的 harness，其余在报告里列为过时。

## 2. 第二阶段工作包

### 2.1 约定

- **编号** `WP2-NNN`（前端插件化沿用 W15 的 `FE-xx`）；协调者派发时转成 `coord.mjs assign <lane> WP-2NNN …`（`assign` 只接受 `WP-` 前缀）。
- **验收只认机器结果**：①提交号进 main（`coord.mjs integrate` 输出的 `<lane>: 已合入` 行）；②指定测试在全测里 failed=0（`.oc-runs/fulltest/latest.json`，sha 覆盖到该提交）；
  ③门禁 / 计数脚本的 exit 与数字（附 job id）；④需要变异证明的，给出“去掉修复后用例失败”的 job id。文档、勾选、TESTMAP 去向一律不作为验收。
- **派发前查重**（C1 必做，§3.2）：查 main 上是否已有等价改动（名册状态、`git log --grep`、对在途补丁做 §1.3 的反向应用检查）。已满足验收的包直接关闭，不派。
- **优先级**：P0 = 解锁他人或建立判据，先派；P1 = 主线功能与正确性；P2 = 健康、可移植性与生态，按空位填。
- 第一阶段若已合入某包的内容（W02/W03/W04/W06/W09 第二、三轮仍在跑），该包改为“验收核对”，不重做。

### 2.2 承接第一阶段的在途改动

| 编号 | 范围 | 验收 | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-001 | 重放 L20 在途补丁：`setDefaultProfileMerger` / 默认学习者画像 merger（`sync/src/field-merge.ts`、`repository/apply-record.ts`） | `sync/tests/plugin.test.ts` 的 `regression_j8c_resources_data_merges_learner_profiles` 在全测 failed=0；变异（不安装 merger）该用例失败 | 第一阶段合入 | P0 | L20 |
| WP2-002 | 重放 L20b：`SqliteSyncStateStore` 首次读写才打开，基于 W08 异步 I/O 后的 `sync-support` | `sync-support/tests/state-lazy-open.test.ts` 通过；sync-support 目录全测 failed=0 | 第一阶段合入 | P0 | L20 |
| WP2-003 | 重放 F1：serde 内部标签 struct 变体的严格校验（`host/kernel/serde.ts`） | `host/kernel/tests/cloud-config-inbound.test.ts` 通过；`host/kernel` 全测 failed=0 | 第一阶段合入（W01 改了同目录） | P1 | F1 |
| WP2-004 | L21 的 WP-234 G3 语料与 `backup/tests/migration-diagnostic.test.ts`，在 W08 流式 ZIP 之后重验 | 测试通过；语料通过 W13 `g3-manifest` 校验 exit 0 | WP2-062 的 manifest 工具在 main | P1 | L21 |
| WP2-067 | S0 在途：`s0-selftest.mjs`、`lib/gate-excerpt.mjs` 与 W11 现状对账（`jobs/runner.mjs` 已分叉，以 W09 版本为准） | `s0-selftest.mjs` 在服务器 exit 0（macOS 上会卡住，不在本机跑）；对账结果附 diff 统计 | W11 部署 | P1 | S0 |

### 2.3 Agent 执行器（W02 剩余，加 W01 遗留的错误类型）

第一阶段后名册里仍缺 20 个执行器（W02 名册 32 个 `missing`，减去 W03 的 3 个、W04 的 9 个）：
InsightRecall、Connector、Fetch、McpPropose、McpManage、Automation、PaperSave、Knowledge、SessionTool（W02 第二轮在做）、AttachmentStage、
SkillInstall、SkillMarketRead、SkillMarketInstall、SkillLifecycle、Git、LocalShellExecute、Workbench、WorkspaceTool、Subagent、SuperSession；
另有 AcademicSearch、LearningOverview 只有元数据。共同验收：名册测试断言这些执行器为 `executable`，`orderExecutorsByRoster(...).missing` 不再含它们；
`sensitivityLevel` 与 Rust 一致（有测试，缺省 low 会绕过审批）；`name()` 与名册一字不差，`canHandle` 接受 `builtin-` 前缀；真实工具循环测试至少一条往返。

| 编号 | 范围 | 验收（在共同验收之外） | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-010 | 把 chat 的 worker 运行时（`runWorkspaceAgentBackend`、`cancelWorkspaceAgentBackend`、会话存储）发布为服务；AttachmentStage 执行器外壳（逻辑已在 `chat/src/attachment-stage.ts`） | 服务有“卸载即撤销”测试；AttachmentStage 往返测试通过 | 第一阶段合入 | P0 | L04 |
| WP2-011 | SubagentExecutor、SuperSessionExecutor（ASSAULT-PLAN W02 任务 3 未完成部分） | 真实工具循环里子代理启动、返回、取消三条测试 | WP2-010 | P0 | L06 |
| WP2-012 | AutomationExecutor；SessionToolExecutor（W02 第二轮已合入则只做验收核对） | 两个执行器的往返测试 | 第一阶段合入 | P1 | L06 |
| WP2-013 | WorkspaceToolExecutor；agent-workspace `api.ts` 导出 `writeBytes`，并接上 media 的 `workspaceWriter`（W04 交接，media 部分由 P1 配对提交） | `output_target=workspace` 的 Office 工具测试由“显式报错”变为写入成功 | WP2-010 | P1 | L05 |
| WP2-014 | Git、LocalShellExecute 执行器（shell 执行与授权，ASSAULT-PLAN 要求单独做并配安全测试） | 安全测试：未审批拒绝、路径越界拒绝（含 macOS `/var`→`/private/var`）、沙箱不可用时明确失败；R3 复核结论为通过 | 第一阶段合入 | P1 | L05 |
| WP2-015 | McpPropose、McpManage、ConnectorTool、Fetch（Fetch 走 W14 的 `ctx.http`，公网目的地策略） | Fetch 对私网/回环目的地拒绝的测试 | WP2-040 的 `ctx.http` 在 main | P1 | L07 |
| WP2-016 | SkillInstall、SkillMarketRead、SkillMarketInstall、SkillLifecycle、WorkbenchTool | 安装/卸载往返；市场读取用假服务端 | — | P2 | L07 |
| WP2-017 | InsightRecall、PaperSave、Knowledge 执行器；AcademicSearch、LearningOverview 由元数据改为可执行 | 同共同验收 | — | P1 | L17 |
| WP2-018 | `memory_write` 写入次数与 Rust 对齐（W10 交接，变更日志漂移源之一）；HPIAS retrieval 按 Rust `hpias/service.rs` 真实 backend 路径（解除 WP-170 partial） | 写入次数断言与 Rust 测试一致；下一次 G3 正式录制里 memory 相关 `__change_log` 差异组消失 | WP2-062 基线 | P1 | L17 |
| WP2-019 | chatanki 会话工具面冻结 metadata 与 Rust 一致（W10 交接） | 对照 Rust 的 metadata 快照测试 | — | P2 | L04 |
| WP2-020 | 错误映射基础设施（W01 遗留）：按 `deep-student.log` 中 `[ERROR][dstu_host::commands]` 统计热点的脚本；“命令处理函数内 `throw new Error`”的 lint 判据交 P3；`error` 为 `string` 的命令里抛裸 `AppError` 的清单 | 热点脚本输出按插件计数（附命令）；lint 基线 exit 0、注入违规 exit 1 | — | P0 | F4 |
| WP2-021 | 按热点逐插件把异常映射成 Rust 原有的 `Err` 分类，先 llm、agent-orchestration（各插件 owner 各一包；llm 归 P1） | 每个改动命令有断言 Rust `Err` 形状的用例；lint 基线计数下降，数字写进报告 | WP2-020 | P1 | P1、L06 等 owner |
| WP2-022 | 插件日志敏感字段审计（apiKey、token、password、cookie 等），扫描测试发现即红 | 扫描测试 exit 0；注入一条带密钥的日志 exit 1 | — | P1 | F4 |
| WP2-023 | `review_suspend/resume/delete` 的版本冲突透出 `REVIEW_CONFLICT`（Rust 原有缺陷，有意偏离并在报告里写明） | 冲突用例断言错误码 | — | P2 | L14 |

### 2.4 插件架构健康（ASSAULT-PLAN §6）

| 编号 | 范围 | 验收 | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-030 | 发布 `host/platform/util`，收拢 95 个重复工具函数；S0 在 `quality-feedback.mjs` 的 DUPES 里加规则，把各插件的替换以 文件:行 路由给 owner | util 测试通过；质量反馈的重复函数计数逐周下降（报告给数字） | — | P2 | P1（规则：S0） |
| WP2-031 | lint：`no-floating-promises`、`no-explicit-any` 设为 error，现状为基线只拦新增 | 基线 exit 0；注入违规 exit 1 | — | P2 | P3 |
| WP2-032 | 边界规则：platform 不依赖 plugins、host 不依赖 `electron/`、kernel↔platform 单向 | 同上 | — | P1 | P1 |
| WP2-033 | 模块级单例改服务实例或 `ctx.effect` 回收，按插件拆包（有专属 lane 的插件由 owner 做） | 每个插件“加载→卸载→再加载，状态不残留”测试 | — | P2 | P1 与 owner |
| WP2-034 | `inject` 与实际使用对齐；消除 `ctx.get` 失败静默返回 `[]` | 扫描脚本计数降到 0（附前后数字） | — | P2 | P1 与 owner |
| WP2-035 | iLink、QR 业务代码迁出 `host/kernel` | `host/kernel` 下无相关文件；WP2-032 的 kernel 规则覆盖；功能测试不回退 | WP2-032 | P2 | F1 |
| WP2-036 | 剩余巨型 `apply()` 拆分（参考 W04：先冻结插件表面再拆） | 插件表面冻结测试不变；`apply()` 行数下降（附数字） | — | P2 | P1 与 owner |
| WP2-037 | 共享 `host/platform/zip`（W08）迁移 agent-skills、qbank、anki | 三处不再 import 自带 ZIP 实现（grep 计数 0）；各自 ZIP 测试通过 | — | P2 | L07、L14、L16 |
| WP2-038 | `qbank/repository/questions.ts` 与 vfs-repos `QuestionRepo` 的重复 SQL 按 W03 报告四步合并 | qbank、vfs-repos 测试全绿；重复 SQL 语句数降到 0 | — | P2 | L14 |

### 2.5 可移植性与平台

| 编号 | 范围 | 验收 | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-040 | 边界检查加入“业务插件不得直接 import Node 专有模块 / 原生模块”（W14 扫描器白名单为基线，只拦新增）；仅桌面插件声明 `platforms: ["desktop"]`；`mobile.json` 生成 `--check` | 门禁注入违规 exit 1；`--check` 无漂移；扫描计数作为指标 | 第一阶段合入（W14） | P1 | P2 |
| WP2-041 | sync-providers 改用 `ctx.files` / `ctx.crypto` / `ctx.http`；`device_identity` 测试不依赖 Linux XDG 默认路径 | 扫描器里该插件 Node 依赖文件数下降（目标在派包时定）；目录测试全绿 | WP2-040 | P2 | L23 |
| WP2-042 | sync 同上 | 同上 | WP2-040 | P2 | L20 |
| WP2-043 | agent-skills 可移植部分改造，桌面专属部分声明 | 同上 | WP2-040 | P2 | L07 |
| WP2-044 | backup 声明仅桌面；核对 W07 交接的 Windows 路径（`backup/src/zip.ts:319,324`、`assets.ts:250` 只认 `/`），W08 未修则修 | Windows 路径单测（`path.win32`）通过 | 第一阶段合入 | P1 | L21 |
| WP2-045 | `secure-store` 主目录不可用时不再回落系统临时目录（W07 风险）；`anki_media` 与 `original_path` 槽位路径基准统一（W10 交接） | 两组测试：回落被拒并给出可读错误；同一附件两种路径解析一致 | — | P1 | F3（anki 部分 L16 配对） |
| WP2-046 | `startup-busy-handler` / `sqlite-busy` 的 darwin-arm64 预编译 | macOS 上这 21 个用例通过（本机 job） | — | P2 | F7 |

### 2.6 外壳、验证与判据

| 编号 | 范围 | 验收 | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-050 | Agent 控制内嵌浏览器时，对每次顶层导航和重定向做私网 DNS 检查（对齐 Rust）；browser 插件经 shell 操作下发策略（W06 第三轮已做则改为验收核对） | 私网、回环、重定向到私网被拒，公网放行；electron 测试全绿 | — | P1 | F2 + L19 |
| WP2-060 | W12 的 5 条黄金路径在服务器 xvfb 下常跑（经作业队列，每次自动集成合入后与每 2 小时），结果写 `.oc-runs/golden/latest.json`，S0 让 pipeline-check 读取 | 连续 3 次 5/5 通过（job id）；任一路径失败时 pipeline-check 报警 | W11 部署、W12 合入 | **P0** | X1（读取：S0） |
| WP2-061 | X1 在途补丁余下 46 个文件逐个评估：有价值的检查并入 W12 harness，其余列为过时 | 并入部分的测试通过；评估清单逐文件给结论 | WP2-060 | P2 | X1 |
| WP2-062 | G3 正式录制：固定 main sha，记录 B 端提交号与构建回执，`g3-night` 改为参数化托管运行（W13 的 `supervise.mjs` / `g3-worker.mjs`），A/A2 smoke 不再挂起 | 录制产物里 B 端提交号 = 当次 main；挂起次数 0；一致率成为第一个正式基线 | 第一阶段合入（W13） | **P0** | X7 |
| WP2-063 | 按正式基线的差异组排序，把产品差异按 owner 拆成修复包（C1 派发）；环境与基线差异列表，不修 | 每个修复包对应的差异组在下一次正式录制中消失 | WP2-062 | P1 | X7（拆包）+ 各 owner |
| WP2-064 | 账本自动化：每次合入后经作业队列重算，记录 main sha；账本与全测同源 | `ledger-history.jsonl` 新记录都带 `mainSha`；与全测同 sha 的比例在报告里给出 | 第一阶段合入（W09 账本改造） | **P0** | P3 |
| WP2-065 | B 级口径拆成 B-test / B-doc；功能可达性门禁（前端调用键、事件发射点、执行器覆盖、权限拦截）各出 gap 计数，棘轮只减不增（W11→W09 交接，W09 第二轮已有一部分） | 账本输出两个分值；四个 gap 计数写入 `.oc-runs/reports/`；注入违规 exit 1 | 第一阶段合入 | **P0** | P3 |

### 2.7 前端插件化（W15 的 28 个包）

范围、改动、验收全部以 `plans/FRONTEND-PLUGINIZATION.md` §3.2 为准（验收本来就是机器核对：槽位快照、IPC 轨迹、截图、构建图、计数棘轮）。这里只给 owner 与优先级。
FE-A1（W16）、FE-A2（W17）在本机进行中，第一阶段合入后只做收尾与验收核对。

| 包 | lane | 优先级 | 包 | lane | 优先级 |
|---|---|---|---|---|---|
| FE-00 裁定与清理 | U1 | P1 | FE-B6 remark/rehype、生成式 UI | U4 | P2 |
| FE-A1 回归安全网 | U1（W16 收尾） | P0 | FE-B7 调试面板 | U2 | P2 |
| FE-A2 UI 内核 v2 | U1（W17 收尾） | P0 | FE-B8 仪表盘小部件 | U4 | P2 |
| FE-A3 全栈清单与配对装配 | F1 + U1 | P1 | FE-B9 菜单族 | U2 | P2 |
| FE-A4 前端边界门禁 | P3 | **P0** | FE-B10 设置分区（可拆 3 包） | U3 | P2 |
| FE-A5 平台服务与移动端装配 | U1 + F2 | P1 | FE-C1 按功能重切（7 子包） | P6 | P1 |
| FE-B1 命令面板 | U2 | P1 | FE-C2 类型化客户端 | P3（生成器）+ P6（迁移） | P2 |
| FE-B2 聊天 block / 事件 / 模式 | U4 | P1 | FE-C3 资源类型注册表 | P6 | P2 |
| FE-B3 工具结果槽位 | U4 | P1 | FE-C4 Host 推 UI 与 remote | F1 + U1 | P2 |
| FE-B4 工作台应用 | U2 | P2 | FE-C5 工具 schema 归 Host | L07 + U4 | P2 |
| FE-B5 编辑器扩展 | U4 | P2 | FE-D1～D4 枢纽组件 | U2、P6、U4、U3 | P2 |
| FE-E1 插件管理页 | U1 | P2 | FE-E2 第三方加载加固 | F2 + U1 | P2 |
| FE-E3 SDK 与样板 | P5（= WP2-084） | P2 | | | |

FE-B3 排在 P1：第二阶段新增的执行器结果卡片要通过 `chat.toolResults` 贡献，否则会继续改 `mcpTool.tsx`。

### 2.8 移动端原型与二次开发

| 编号 | 范围 | 验收 | 依赖 | 优先级 | lane |
|---|---|---|---|---|---|
| WP2-080 | SQLite 接入方式：原生插件与 Worker 内 SQLite WASM + OPFS 各跑同一组 storage 一致性测试 | 两组 passed/failed 与性能数字；C1 写入 DECISIONS | — | P2 | P4 |
| WP2-081 | Argon2、FSRS、分词器 WASM 在 WebView / Worker 内可用 | 无头 Chromium Worker 测试通过 | — | P2 | P4 + F7 |
| WP2-082 | Capacitor 外壳、移动桥（`invoke` / `listen` 与 preload 一致）、Worker host（`messagePortTransport`）、`mobile.json` 装配 | 冒烟“启动到首个 App” exit 0；与桌面同步往返一次 | FE-A5、FE-C1 a–d、WP2-040 | P2 | P4 |
| WP2-083 | 低端安卓启动时间与内存 | 模拟器数字；真机由用户安排 | WP2-082 | P2 | P4 |
| WP2-084 | 全栈样板插件 `community.study-stats`、SDK、脚手架、开发者指南（= FE-E3 加后端半） | 脚手架生成的插件 `ds-plugin test` 一次通过；样板全栈测试通过；文档链接检查 exit 0 | FE-A2、FE-A3、FE-B8、FE-C4 | P2 | P5 |

### 2.9 统计与前 10 优先级

共 **75 个工作包**：§2.2 承接 5、§2.3 执行器与错误 14、§2.4 健康 9、§2.5 可移植性 7、§2.6 外壳与验证 7、§2.7 前端 28、§2.8 移动与生态 5。
优先级 P0 共 12 个。恢复后第一批派发（前 10，按顺序；判据先于功能，解锁他人的先于被解锁的）：

| 序 | 包 | lane | 为什么排这里 |
|---|---|---|---|
| 1 | WP2-060 黄金路径常跑 | X1 | 第二阶段所有“效果不变”的判断都要它；没有它，只能看账本 |
| 2 | WP2-062 G3 正式录制基线 | X7 | 差分修复要有可追溯的基线，之前 937 组差异的 B 端提交未知 |
| 3 | WP2-065 B-test/B-doc 与可达性门禁 | P3 | 让“补文档”不再计分，是防空转的判据本身 |
| 4 | WP2-064 账本自动化同源 | P3 | 账本、全测、main 三者同 sha，进展数字才可信 |
| 5 | WP2-010 chat worker 运行时服务 | L04 | 解锁 Subagent、SuperSession、WorkspaceTool 三个执行器 |
| 6 | WP2-011 Subagent / SuperSession | L06 | ASSAULT-PLAN W02 任务 3 的遗留，Agent 主线能力 |
| 7 | WP2-001 学习者画像默认 merger | L20 | 在途的真实缺陷修复，带回归测试，重放成本低 |
| 8 | WP2-002 sync_state 延迟打开 | L20 | 同上（与 WP2-001 同一 lane，顺序执行） |
| 9 | WP2-020 错误映射基础设施 | F4 | W01 遗留；后续每个插件的错误映射包都依赖它 |
| 10 | FE-A4 前端边界门禁 | P3 | FE-C1 及以后所有前端拆分的护栏 |

第一批 10 个包分布在 8 条 lane（X1、X7、P3×3、L04、L06、L20×2、F4），其余继续 lane 同时按 P1 填空位；并发上限照旧（执行者 24）。

## 3. 协调者契约更新

C0、C1、C2、S0 的任务卡已改（各文件开头的“第二阶段（恢复派发后）”一节优先于旧文）。要点：

### 3.1 共同规则

- 工作只来自 §2 的工作包表（或 X7 由正式录制拆出的修复包）；表外新增工作包要写明来源（交接项、门禁失败、差分组）和机器验收，C1 记入 DECISIONS。
- 不派“只改 TESTMAP / SPEC / BLOCKERS / LANE.md”的包；文档随代码包更新，不单独成包。
- 退役 / 并入 lane 不派活（工具会拒绝）；它们的路径归处置表里的接手 lane。
- 进展口径：只有“代码进 main + 全测覆盖到该 head + 账本同源”才算推进（沿用 C0 判据），B-doc 不计。
- **关闭空闲自动续派**（`ops/oc-orchestrator/systemd/ds-migration.service.d/z-phase2.conf`，`DS_AUTO_CONTINUE_MAX=0`）：旧续派消息让空闲 lane 按 LANE.md
  补 pending 测试、复核勾选项，正是“补文档、刷映射”的来源。第二阶段 lane 做完一个包就结束，下一个包由 C1 `assign`（新会话）。
- 新 lane（P1–P6）首次 `launch` 只做起点检查后结束（任务卡“首次启动”一节），之后同样只经 `assign` 接包。

### 3.2 C1 派发前查重（新增，必做）

派一个包前回答三个问题，答案写进 brief 的“查重”一行：
1. main 上是否已满足验收？（跑一次验收命令；执行器包查名册状态。）
2. 突击分支是否已有等价改动？（`git log main --grep` 关键字、§1.3 的反向应用检查。）
3. 是否与在跑的包改同一文件？（`coord.mjs status` 与处置表路径。）
任何一条为“是”就不派，改为验收核对或合并到在跑的包。

### 3.3 各协调者的变化

| 协调者 | 变化 |
|---|---|
| C0 | 本轮阻塞先看 §4 指标是否越线；空转按 §4.2 判定；“补文档”判为空转而不是进展；第一周每天给用户一次第二阶段进展（P0 包状态、指标趋势） |
| C1 | 只从 §2 派发，P0 先行；派发前查重；模型沿用 C1 任务卡的名额规则（xhh 只给最难、最关键路径，其余 `ai98pro/claude-opus-5-5#high`，不用 `gpt-6.1-sol`），新 lane 建议 P3、X7 与 L05 的安全执行器包用 astra，其余用 ai98pro；R3/R6 保持异模型复核 |
| C2 | 集成之外负责核对黄金路径与 G3 正式录制结果；执行器包与 Git/LocalShell 安全包必须经 R3 复核才算验收；B-test/B-doc 上线后，BASELINE 只记 B-test |
| S0 | 运维 W11 部署的巡检、报告、质量反馈定时器；接线：pipeline-check 读取黄金路径结果与可达性 gap；在质量反馈里加 DUPES 规则（WP2-030）；处置表生效后的工具问题 |

## 4. 恢复后的指标

### 4.1 看什么

| 指标 | 来源 | 期望方向 | 越线（需要介入） |
|---|---|---|---|
| 净代码合入 | `progress` 报告的产品提交 / 文档提交；`coord.mjs integrate` 合入行 | 每小时 ≥3 条 lane 有代码进 main | 连续 2 小时为 0，且有已交付未集成的包 |
| B-test 与 B-doc（W09 拆分后的两个分值） | 账本（WP2-064/065 之后） | B-test 上升；B-doc 不计 | B-doc 涨而 B-test 2 小时不动 |
| 功能可达性 gap（前端调用键、事件发射点、执行器 `missing`、权限拦截） | P3 门禁计数（`.oc-runs/reports/`） | 只减不增；执行器 `missing` 20→0 | 任一计数上升（门禁应已拦截，出现即为门禁漏洞） |
| G3 正式录制一致率 | X7 的正式录制报告（同一 main sha） | 每次录制上升 | 下降，或连续两次录制没有包关闭任何差异组 |
| 黄金路径 | `.oc-runs/golden/latest.json` | 5/5 | 任一失败持续超过 1 次集成 |
| main 全测失败数与落后提交数 | `.oc-runs/fulltest/latest.json`、`history.jsonl` | 失败数为基线值（服务器 Linux 上应为 0）；落后 ≤ 1 轮 | 新增失败；落后超过 2 轮 |
| 可移植性 | W14 扫描器的 Node 依赖文件数 | 下降 | 上升（门禁漏洞） |
| 质量反馈 | `.oc-runs/reports/quality-feedback.json` 与投递日志 | 状态新鲜，按 lane 投递 | C0 摘要出现“已 N 分钟未生成 / 生成失败” |
| 催办闸 | `nudge-log.jsonl` 中 `blocked` | 少 | 同一协调者 2 小时内被拒 ≥3 次 |

### 4.2 什么算空转

满足任一条即判为空转，由 C0 按“结构 → 流动 → 交付”的顺序处理（不催“继续”）：

1. `progress` 判定“空转”：两小时内 ≥40 步、零提交，连续两轮。
2. “只改文档”：非评审 lane 两小时内的提交只涉及 `*.md`、TESTMAP、SPEC、BLOCKERS、语料以外的文档。
3. **重做已完成的工作**：交付的包与 main 的差异为空，或其验收在派发前已满足（C1 查重漏掉）。由 C2 在验收时判定并记一次，C1 当轮复盘查重。
4. 同一个包被同一 lane 交付 ≥2 次仍不满足验收，且第二次没有新证据。
5. 自动集成连续 3 轮 0 合入，同时有 ≥5 个已交付未集成的包。
6. 协调者同一主题 2 小时内第 3 次发消息被催办闸拒绝（`nudge-log` 的 `blocked`）。

介入顺序：先查结构（权限、锁、门禁工具故障、hold/维护标记残留，`repair check`）；不是结构问题就换包或换会话（C1）；连续两次换包仍空转的 lane 停放（`oc-dispatch park`），工作并入相邻 lane。

## 5. 主 agent 裁定

已于 2026-11-07 裁定，见 RESUME-RUNBOOK 开头“主 agent 裁定”：采纳处置表（恢复前复核）；P3 用 astra、其余新 lane 用 ai98pro；继续的 lane 先打 `inflight/` 标签再重置，有未吸收真实修复的先吸收、后重置。
