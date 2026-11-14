# 责任线任务卡（29 条）

每条 lane 由**一个**代理负责，从头做到 Wave 2 交叉验收。规模数据来自
`inventory/lanes.json`（行数含内联测试）；每条 lane 拥有的 Rust 文件与命令清单见
`inventory/commands.json` 的 `lane` 字段与 `scripts/electron-migration/inventory.mjs` 的
`LANE_RULES`——**以脚本为准**，本文只写职责与交付物。

## 通用规则（所有 lane 必读，派发时随卡附上）

**输入**：本 lane 的 Rust 源码（只读）、原 Rust 测试、`contracts/`（F5 生成）、
[`README.md`](README.md) §3 语义清单。录制数据（`fixtures/golden/`）是后期 C 级输入，
**不等待它**。

**优先级**：代码完整迁移并跑通（A）> 静态验证（B）> 动态验证（C），见 README §5.1。

**只能写**：自己的目录（见卡片"目录"）、`contracts/CHANGES.md` 的变更单、
`docs/dev/electron-migration/decisions.md` 的歧义条目。

**禁止**：
- 运行 cargo、启动 Rust 应用（F6 除外）。
- 修改 golden 与期望值文件、他人目录、生成文件。
- 在生产路径使用 mock/fake/TODO/unimplemented 或空 catch。
- 用"类似实现"替代原语义；改变功能（包括顺手修 bug——发现 bug 写入 decisions.md，
  保持原行为，另行评估）。
- 使用 `git stash`、`git reset --hard`、`git checkout --`、`git clean`。

**交付物**（每条业务 lane）：
1. `SPEC.md`（H8 前）：每个命令/服务方法的输入、输出、错误、事件、DB 读写、
   取消与并发语义、时间与 ID 的生成方式。
2. `TESTMAP.md`：每个原 Rust 测试一行，格式为
   `rust路径::测试名 → ported:<ts路径> | merged:<目标> | obsolete:<理由，待批准>`。
3. 插件实现：`manifest.ts`、`src/`、`repository/`、`tests/`。
4. Wave 2 冒烟脚本（`playwright-electron`）：覆盖本 lane 全部前端流程，F6 复用为录制剧本。
5. 交叉验收报告：写到被验收 lane 的 `ACCEPTANCE.md`。

**节奏**：每完成一个可验证单元（一组命令通过 CI）就提交；只提交自己的路径。

**完成定义**：见 README §5.1，由 CI 写入 ledger。代理自述的"已完成"不计入进度。

---

## 地基线（Wave 0 主力，G0 后转支援）

### F1 内核与插件运行时
- 目录：`host/kernel/`；Rust 参照 `dstu-kernel`、`dstu-agent-api`、`src/plugins`、
  `src/extensions.rs`、`src/agent_wiring`（约 7.2K 行，11 个命令，89 个测试）。
- 职责：
  - 接入 Cordis；在其上实现版本化服务契约层、命令路由（命令名→服务方法，带 schema
    校验）、事件总线（Tauri `listen/emit` 语义）、profile/patch 加载、插件管理器。
  - 把现有的 `src/plugin-runtime/host.ts` 及其测试迁入，语义不变。
  - 迁移 dstu-kernel 的 hookset、slot、disposer 语义。
- 里程碑：
  - H3 出 `host/kernel/API.md` 和 d.ts 草案；H4 冻结。
  - H8 跑通"插件注册→命令调用→事件→停用回滚"全链路。
  - H30 起负责全量 profile 装配。
- G0 后：支援 L03、L04。

### F2 Electron 外壳与 Tauri 兼容桥
- 目录：`electron/`；Rust 参照 `src/lib.rs`、`main.rs`、`menu.rs`、`system_*`、
  `external_file_opener`、`cmd/{window_effects,power}`、`dstu-platform` 的启动部分
  （约 6.4K 行，23 个命令）。
- 职责：
  - main 进程：窗口、菜单、托盘、单实例、更新器、全局快捷键、vibrancy、深链接。
  - preload 实现 `__TAURI_INTERNALS__`，覆盖 `@tauri-apps/api` 的
    core/event/window/webview/path/dpi，以及 10 个插件的 `plugin:<名>|<命令>`。
  - `protocol.handle` 实现 asset、pdfstream、filestream、bilistream。
  - 未注册命令返回与 Tauri 一致的错误。
  - utilityProcess 托管 Host，含崩溃重启与关闭顺序。
- 参照：`src/demo/mockIpc.ts` 已证明在 IPC 层接管、前端零改动可行；在桥上加录制钩子供 F6 复用。
- 里程碑：H6 外壳启动真实前端；H36–H44 负责三平台打包 CI 与原生模块 ABI 预编译。

### F3 存储平台
- 目录：`host/platform/storage/`；Rust 参照 `dstu-storage`（database、migration、
  data_space、file_manager、staged_upload、audit、llm_usage 存储层）、`tests/migration_*`
  （约 46K 行，33 个命令，362 个测试）。
- 职责：
  - 基于 better-sqlite3 做连接管理（每库）、事务句柄、批次、WAL 配置。
  - 实现兼容 refinery 的迁移器：同一张 history 表，同样的 137 个迁移文件。
  - 实现 schema registry、data_space 切换、启动清理、文件删除队列、staged upload。
  - 用 `fixtures/db` 的历史库做升级对照。
- 里程碑：H8 存储服务和迁移器可用（G0 必需）；之后支援 L11、L13 的 vfs.db 跨域事务。

### F4 安全、设置、日志、平台服务
- 目录：`host/platform/{secrets,settings,log,diagnostics}/`；Rust 参照 `dstu-security`、
  `dstu-core`、`dstu-util`、`dstu-platform`（除启动部分）、`secure_store`、`crash_logger`、
  `diagnostics`、`debug_commands`、`backup_config`、`cloud_config_commands`
  （约 22.8K 行，44 个命令，300 个测试）。
- 职责：
  - keyring 读出既有密钥。
  - aes-gcm/argon2/hostname 派生密钥逐字节兼容。
  - 设置存储、日志（pino，格式和路径与原版一致）、Sentry、诊断与调试日志命令、
    后台任务注册、包管理器检测。
- 里程碑：H10。之后支援 L22。

### F5 契约与账本
- 目录：`contracts/`、`scripts/electron-migration/`、`migration/`。
- 职责：
  - 写 tree-sitter-rust 抽取器：全部命令、事件、错误类型、serde 属性→JSON 契约，
    再生成 TS 类型和运行时校验器。不认识的形状报错，交人工处理。
  - 汇总各 lane 的"提供/消费"服务清单，形成 `contracts/services/`。
  - 维护 `inventory --check`、ledger 生成器、CI 门禁（README §5.2）。
  - 维护契约变更单流程。
- 里程碑：H3 草案；H8 冻结（G0）；之后负责变更单窗口和 ledger。

### F6 录制与动态验证（唯一可运行 Rust 的 lane，独立排期，不阻塞任何人）
- 目录：`fixtures/`、`scripts/electron-migration/record/`。
- 职责（README §4.1）：
  - 脚本化假供应商：OpenAI/Anthropic/DeepSeek 兼容的 SSE 和 JSON 接口，按剧本输出固定流，
    包括错误、重试、中途断流。搜索和抓取同理。两边都指向它，**不需要 API key**。
  - 同步与备份用 `scripts/dev/docker-compose.sync-test.yml`（MinIO、WebDAV、FTP），
    **不需要云账号**。
  - 前端侧录制器：包装 `__TAURI_INTERNALS__`，记录 invoke、事件、错误，不改 Rust。
    每个场景前后做 SQLite 规范化快照：按主键排序，易变列按契约的 `volatile` 声明归一。
  - 剧本依据前端流程与各 lane 的 SPEC 自行编写，Wave 2 后合并各 lane 的冒烟脚本。
  - 在机器空闲时段用隔离 identifier、复用 `target/` 增量构建，**一次**批量录制。
    纯函数向量（FSRS、KDF、分块等）同批产出。
  - 用旧版本迁移链和现有 migration fixture 生成 ≥3 个旧 schema 版本的历史库。
  - 维护 golden 校验和；H28 起把回放接入 CI；Wave 3 跑历史库升级 E2E。
- 录制延迟或失败只影响 C 级，不影响任何 lane 的 A、B 级进度。

### F7 原生依赖适配器
- 目录：`host/platform/native/*`、`host/platform/vector/`。
- 职责：按 README §3.4 逐项实现适配器和等价性测试，覆盖 lancedb、pdfium wasm、
  fsrs（ts-fsrs 加优化器绑定）、starlark wasm、tiktoken、prost/zstd、Office 解析、
  音频、HEIC、图像。四个目标平台的预编译产物进 CI。
- 里程碑：H16。之后支援 L18。

---

## 业务线（Wave 0 静态规格，Wave 1 实现）

| Lane | 目录 `host/plugins/…` | Rust 范围 | 行 / 命令(前端) / 测试 | 主要提供 | 主要消费 | 特别注意 |
|---|---|---|---|---|---|---|
| L01 LLM 供应商 | `llm-providers/` | dstu-llm 的 providers、adapters、openai_codex、multimodal、ocr_adapters | 20.6K / 5(1) / 246 | `llm.adapter@1` | F4 secrets | SSE 解析、重试分类、各供应商特殊处理（quirk）、reasoning 映射 |
| L02 LLM 管理与翻译 | `llm/`、`translation/` | dstu-llm 的 llm_manager、dstu-tutor、translation-core、src/translation，以及 translation 和 settings_models 工具 | 56.3K / 26(13) / 709 | **`llm@1`（H16 里程碑）**、`translation@1` | L01、F3、F4 | 吸收现有 `src/plugins/translation` 及其三方对照；模型配置冻结、llm_usage、路由、单次流式 |
| L03 Chat 管线 | `chat-pipeline/` | chat_v2 的 pipeline、prompt_builder、budget、context、finalizer | 47.6K / 0 / 451 | `chat.pipeline@1` | L02、L04、L05、L07 | tool_loop、压缩、context_compiler、多变体、前缀快照 fork，以及取消与重试缺口测试 |
| L04 Chat 会话 | `chat/` | chat_v2 的 handlers（101 个命令）、repo、events、types，以及 src/chat_v2 的 handlers | 54.5K / 107(90) / 527 | `chat.session@1` | L03、F3 | 会话、消息、块的持久化；事件流（stream_start→block→complete）与前端严格一致 |
| L05 工作区与审批 | `agent-workspace/` | workspace、approval_*、runtime_roots、vfs_resolver、adapters，以及 shell、git、lsp、fs 工具 | 41.1K / 12(11) / 401 | `agent.workspace@1`、`agent.approval@1` | F4、L13 | shell 沙箱跨平台；审批键 canonical 化（`canonical_scope_value`） |
| L06 编排 | `agent-orchestration/` | super_session、automations、headless，以及 subagent、goal、todo、ask_user、session 等工具 | 27.4K / 17(17) / 239 | `agent.subagent@1`、`agent.automation@1` | L03、L04 | superagent.db；Worker 生命周期，取消后再关闭的顺序 |
| L07 技能、PTC、MCP 工具 | `agent-skills/` | skill_*、skill_taps，以及 ptc、mcp_*、connector、fetch、canvas、workbench 工具 | 32.0K / 22(17) / 351 | `agent.skills@1`、`agent.tools@1` 注册表 | F7 starlark、L19 | PTC 走 starlark wasm；fetch 的 SSRF 校验顺序 |
| L10 笔记 | `notes/` | vfs 的 note_* 仓储、dstu-notes、cmd/notes，以及 canvas、user_todo、notes_import 工具 | 23.8K / 81(60) / 135 | `notes@1` | F3、L11 | 修订、租约、历史恢复；pulldown-cmark 块边界要找等价解析器，用向量对照 |
| L11 VFS 仓储 | `vfs-repos/` | vfs 的 repos（非笔记部分） | 42.0K / 0 / 158 | `vfs.repo.*@1`（H16 里程碑） | F3 | vfs.db 多写入方；id_alias 与 path_cache 语义 |
| L12 索引与检索 | `vfs-index/` | indexing、embedding、lance 存储、unified_retriever、retrieval_planner、multimodal、pdf_processing | 25.7K / 3(2) / 79 | `vfs.index@1`、`retrieval@1` | F7 lance/pdfium、L02 | 分块边界、向量维度表、检索打分顺序 |
| L13 VFS 与 DSTU API | `vfs/` | vfs 的 handlers（91 个命令）、ref_handlers、question_sync、dstu（54 个命令），以及其余资源类工具 | 56.2K / 214(131) / 381 | **`vfs@1`（H18 里程碑）**、`dstu@1` | L11、L12、F3 | 命令最多；filestream 和 pdfstream 协议的数据源 |
| L14 题库 | `qbank/` | dstu-qbank、src/qbank_*、question_bank_service、commands.rs 的 qbank 命令，以及 qbank、essay、review 工具和测试 | 39.4K / 88(73) / 241 | `qbank@1` | F3、L02、L15 | 判分、掌握度、同步标记的同库原子性 |
| L15 复习与学习分析 | `review/` | fsrs_review_service、review_plan、mastery、insight、essay_grading、dstu-learning | 16.5K / 70(53) / 128 | `review@1`、`mastery@1` | F7 fsrs、L14 | FSRS 数值逐项对照 |
| L16 Anki | `anki/` | dstu-anki（除 fsrs）、cmd 下的 anki 与 apkg 命令、tests/anki_* | 40.8K / 51(36) / 630 | `anki@1` | F3、L02 | apkg 导入导出字节格式、AnkiConnect、遮挡卡 |
| L17 记忆与研究 | `memory/` | dstu-memory、dstu-research、quick_assistant，以及 memory、academic、paper、knowledge 等工具 | 27.3K / 34(33) / 168 | `memory@1` | L02、L12 | 内化任务队列 |
| L18 媒体与文档 | `media/` | dstu-media、vision、docs、src/media、tts、voice、heic，cmd 下的 ocr、handout、textbooks，以及 office 类工具 | 37.4K / 74(50) / 243 | `media@1`、`docs@1`、`ocr@1` | F7 | bilistream 协议；PDF OCR 会话的暂停、恢复、跳页 |
| L19 MCP 与浏览器 | `mcp/`、`browser/` | dstu-mcp、dstu-browser，cmd 下的 mcp、network、web_search，以及 browser、index_webpage 工具 | 27.1K / 70(33) / 206 | `mcp@1`、`browser@1`、`websearch@1` | F4 | MCP stdio 子进程生命周期；搜索重试分类（402 不重试） |
| L20 同步引擎 | `sync/` | dstu-sync 的 data_governance/sync、src 的 commands_sync | 36.2K / 24(24) / 263 | `sync@1` | F3、L23 | 最高数据风险：协议锁、租约、增量格式、E2EE |
| L21 备份与数据治理 | `backup/` | dstu-sync 的 backup、src/data_governance（除 sync），以及 data_governance 工具、tests/restore 和 zip 相关测试 | 37.5K / 33(33) / 323 | `backup@1`、`governance@1` | F3、F4 | zip 导出、导入、恢复往返；恢复码 |
| L22 集成测试与命令收口 | `integration/` | tests/ 的跨域 e2e 与 ACL、tests/sync_r1x_*、commands.rs 收口 | 25.8K / 1(1) / 243 | — | 全部 | 对 50 个前端调用但 Rust 未定义的命令，复现 Tauri 的"command not found"；对 292 个前端未调用的命令做 dead-proven 审计 |
| L23 同步传输与供应商 | `sync-providers/` | dstu-sync 的 cloud_storage（S3、WebDAV、FTP）、tests/sync_*、webdav、e2ee | 53.5K / 14(14) / 859 | `sync.provider@1` | F4、F7 | 测试量最大（859 个），以移植为主；断点续传、截断、文件名跨平台 |
| L24 ChatAnki | `chatanki/` | src/chat_v2/tools 的 chatanki、template、fsrs_settings，以及 tests/chatanki_* | 28.5K / 0 / 286 | `chatanki.tools@1` | L16、L03、F7 starlark | chatanki_executor 单文件 21K 行；转换脚本 |

### 业务线时间点

- **H0–H1**：开 worktree，建骨架，通读任务卡。
- **H1–H4**：读码；基于 F5 契约草案提交"提供/消费"清单。
- **H4–H8**：完成 SPEC.md，移植测试（先标记为待实现）。
- **H8（G0）–H28**：实现，**目标 A 级**；移植测试随实现转绿。
  - 服务里程碑：L02 H16、L11 H16、L13 H18。
  - 其余 lane 在 H26 前达到 A 级。
- **H28–H32**：在真实 Electron 中接真依赖，冒烟自己的全部前端流程，留存冒烟脚本。
- **H30–H36**：按 README §5.4 交叉审读；修复别人提出的问题。
- **H36–H44**：闭合 TESTMAP（obsolete 条目申请批准）；修复 C 级回放发现的差异。

## 机动与弹性

- 上限 30：29 条 lane 加 1 个机动名额。机动名额给检查点上 A 级完成率最低的 lane。
- F 线完成里程碑后的转岗：F1→L03/L04，F3→L11/L13，F4→L22，F7→L18，F5、F6 保持本职。
- 转岗代理领的是被支援 lane 拆出的**子包**：目录独立，SPEC 由原 lane 提供，不共用文件。
