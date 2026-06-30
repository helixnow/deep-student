# DeepStudent 第二轮收尾审阅与优化 —— 8 子代理分工总览(2026-06-13)

本目录是「第二轮(round 2)」工作的**唯一权威分工文档**。
第一轮(`docs/6.12/`)已完成全域审阅 + 首批优化,并由一次收尾会话(2026-06-13)修复了一批
跨组遗留与高危项(见第 2 节)。本轮目标:**完成各域剩余的登记/待决策项 + 对第一轮未覆盖区
做二轮深审 + 收尾**。

> 每个子代理启动后**必须先读本文件**,再读自己的 `docs/6.13/agent-{N}.md`,
> 并通读自己的第一轮状态文档 `docs/6.12/status/agent-{N}-status.md`(里面有 F 编号、O 编号、
> 待决策项的完整上下文),然后开始工作。

## 1. 分工总表(沿用第一轮的域划分)

| 编号 | 负责域 | 第二轮任务文档 | 第一轮状态(上下文) |
|------|--------|----------------|----------------------|
| 1 | 对话引擎与 AI 能力扩展(Chat V2、LLM 管理、技能/MCP、搜索、记忆、语音) | [agent-1.md](./agent-1.md) | [status](../6.12/status/agent-1-status.md) |
| 2 | 统一数据层与资源中心(VFS、向量、DSTU、SQLite、文件管理) | [agent-2.md](./agent-2.md) | [status](../6.12/status/agent-2-status.md) |
| 3 | 文档解析与阅读(解析、OCR 六引擎、多模态、PDF/DOCX 阅读器) | [agent-3.md](./agent-3.md) | [status](../6.12/status/agent-3-status.md) |
| 4 | 题库与练习(题库服务族、AI 判分、试卷切题、练习界面) | [agent-4.md](./agent-4.md) | [status](../6.12/status/agent-4-status.md) |
| 5 | 制卡与间隔重复(Anki 服务族、SRS、复习计划、模板系统) | [agent-5.md](./agent-5.md) | [status](../6.12/status/agent-5-status.md) |
| 6 | 内容创作工作台(笔记、知识导图、翻译、作文批改) | [agent-6.md](./agent-6.md) | [status](../6.12/status/agent-6-status.md) |
| 7 | 平台基座与全局体验(数据治理、云同步、加密、应用壳、设置、UI 库) | [agent-7.md](./agent-7.md) | [status](../6.12/status/agent-7-status.md) |
| 8 | 移动端 UI/UX 体验(Android/iOS、响应式、触控) | [agent-8.md](./agent-8.md) | [status](../6.12/status/agent-8-status.md) |

## 2. 收尾会话(2026-06-13)已完成项 —— 各代理**不要重复**

以下已实现并通过验证(`cargo check` exit 0 / 警告数 100 = 基线不变;`tsc` exit 0;
`eslint` 改动文件 0 error;`vitest` markerParser 5/5;`clippy` 改动零新增)。**禁止回退或重做**:

| 域 | 已完成 |
|----|--------|
| 1 | `web_search` 移除 3 个死熔断器配置字段(F18);`rebuild_chat_fts` 命令实现+注册(F14) |
| 2 | 记忆笔记/去重删除改用 `purge_index_artifacts_by_resource`(入孤儿队列, A2-X1) |
| 3 | `paper_save_executor` 3 处字节切片→`truncate_utf8`(A3-X4);`embedding_service` 死降级链修复(A3-X5);Windows OCR `Lines()` 逐行 `\n`(+ `Foundation_Collections` feature, C2);`exam_engine` 熔断器 `cancel_probe()` + `call_ocr_page_with_fallback` 接入熔断器(X1/X2) |
| 6 | `builtin_resource_executor` AI 改导图 `text` 清 `blankedRanges` + `add_node` 去重 id(A6-27);删死组件 `AnnotatedText`/`TranslationHistory`/`GradingHistory`/`NoteEditorView` |
| 7 | `capabilities/test.json` 删除 + 通配诚实化并入 `default.json`(F16);crypto 密钥损坏可操作诊断(F7,**未自动重置**);`list_sensitive_keys` 改扫描 `.enc`(F9);`lint:css` glob 修 Windows(F26);F13「清空数据」实现 `purge_all_database_files`/`purge_active_data_dir_now`(复用 `startup_cleanup` 标记+重启,规避 Windows 文件锁) |
| 跨 | 删死包装 `cardAccessTracker.ts`、`vfsRefApi.updateResourceHashV2` |

## 3. 全局规则(必须遵守,沿用第一轮)

### 3.1 职责边界
- 只修改自己 `agent-{N}.md` 列出的职责域内文件。
- 发现域外问题:**不要直接改**,记录到自己状态文档的「跨组问题」并注明建议归属代理。

### 3.2 共享文件(高冲突风险)
仅修改与自己域直接相关的段落,并在状态文档登记:
`src-tauri/src/commands.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/models.rs`、
`src/App.tsx`、`src/main.tsx`、`src/locales/**`。一致性负责人:命令/壳层=代理 7,模型=代理 2。

### 3.3 改动纪律
- 小步修改,每个内聚改动跑一次验证,保持随时可构建。
- 高风险/破坏性/产品取舍类:**只登记方案,等用户确认**,不擅自落地。
- 禁止大规模重命名/移动文件、禁止引入新依赖、禁止改构建配置(除非用户明确同意)。
- **未经用户明确要求,不执行 `git commit`/`push`。**
- 不删除、不重写其他代理的状态文档。

### 3.4 验证命令
前端(任何 `src/` 改动后):`npm run typecheck` → `npm run lint` → `npm test -- <pattern>`。
后端(任何 `src-tauri/` 改动后,在 `src-tauri/` 下):`cargo check` →(可选)`cargo clippy`。
i18n 改动后:`npm run check:i18n`。
> 环境注意:本机 PowerShell 不支持 `&&`,用 `;` 或分开执行;`cargo` 基线 100 个 rustc 警告、
> clippy 有 ~805 警告/25 错误(含 `parser.rs` look-around 正则等**预存在**问题),**以现状为基线,
> 不引入新警告/错误**即可;`cargo test` 在本机曾因 DLL 入口点问题(E1)被阻塞,验证以 `cargo check` +
> 代码评审为主,前端 `vitest` 可正常跑。

## 4. 状态文档规范

- 各代理在自己第一轮的 `docs/6.12/status/agent-{N}-status.md` 上**追加** round 2 章节(禁止清空重写),
  或新建 `docs/6.13/status/agent-{N}-status.md`(二选一,推荐后者保持轮次清晰)。
- 每完成一个审阅单元/一次改动/一次重要发现,立即更新。

## 5. MCP 反馈工作流(每个子代理启动后立即执行)

本项目用 `mcp-feedback-enhanced` 与用户交互。每个子代理启动后:
1. 先调用 `feed-register`(传入 `project_directory=e:\2026ds\deep-student`、`name=<本代理名>`、`model=<当前模型>`),牢记返回的 `feed_id`。
2. 立即 `feed-poll(feed_id)` 等待用户指令;返回"暂无指令"立即再轮询;超时报错也继续轮询;**绝不重复 feed-register**。
3. 收到指令后执行任务,关键节点用 `feed-task-update(feed_id)` 记录目标/进度/上下文(供中断接力)。
4. 始终用 `interactive_feedback(feed_id)` 汇报进展并收集反馈,直到用户说完成。

## 6. 优先级建议(跨域统一口径)

1. **P0 真 bug / 运行时破损**:先修(本轮各域剩余里这类已不多,主要在二轮深审中新发现的)。
2. **P1 死代码清理**:确认无引用后删除(`cargo check`/`tsc` 兜底),降低维护面。
3. **P2 体验/性能**:低风险直接做;涉及前后端契约或大重构的登记待确认。
4. **P3 产品取舍**:只出方案 + 影响分析,等用户拍板。

## 7. 项目快速事实

- 技术栈:Tauri 2(Rust)+ React 18 + TS 5.6 + Vite 6;SQLite(rusqlite)+ LanceDB + 本地 Blob;Zustand 5 + Immer;Tailwind 3 + Radix UI。
- 平台:Windows / macOS / Linux / Android(iOS 可本地构建)。版本 v0.9.38。
- 全局架构:`README_CN.md`;代码风格:`docs/CODE_STYLE.md`;设计令牌:`docs/design-tokens-and-color-semantics.md`。
