# WP00 — Notes 升级基线

记录日期：2026-09-21。状态：研究与合成样本交付；没有实现本文提出的升级。

## 1. 基线身份与范围

- 实际 HEAD：`c7248a222191eef28b5f175d4a7217289594240e`，提交标题 `fix(startup): keep React runtime in one production chunk`。
- `git describe --tags --always`：`v0.9.63-3-gc7248a222`；`package.json` 和 `src-tauri/Cargo.toml` 均为 `0.9.63`。
- 用户方案的 `ee830c6 / v0.9.64` **不是本次基线**。本地 `git rev-parse --verify 'ee830c6^{commit}'` 失败，无法把该方案版本的代码行为认作本仓库事实；没有 fetch 或切换分支。
- 初始唯一未跟踪目录是 `docs/dev/perf-audit-2026-09/`，保留。检测到其他工作区的 `cargo test --no-run` / `rustc` 正在编译，按共享环境操作。
- 本次只新增本目录的文档与合成 Markdown。按用户要求使用 `apply_patch`，不执行 commit、stash、reset、checkout、clean，不改生产代码、迁移、锁文件或真实数据库。
- 收尾检查时 HEAD 仍为 c7248a222，但共享工作区已出现其他会话的 Crepe/toggle、搜索、AI review、全文模型等修改和新增文件。本会话未编辑或回退这些文件。本文是本轮读取时的基线记录，不把其他会话在途成果计入 WP00，也不将既有 smoke 结果扩展到它们的最终版本。
- WP00 服务于用户的 WP00–WP10 / S0–S4 方案。当前提供的信息没有各 WP 的完整原文；下面的 S0–S4 是本次建议的接入门槛，不冒充原方案逐项编号或完成状态。仓库根部的 [2026-09-16 设计审视](../../../deep-student-notes-design-review-20260916.md) 是另一份研究资料，也不能替代本次源码核验。

本目录入口：[架构决策](architecture-decisions.md)、[F01–F08 样本及验收契约](fixtures/README.md)。所有标为“应当／建议／待验证”的描述都是目标契约，不能作为已通过证据。

## 2. 环境与依赖

| 项目 | 本次观测 |
|---|---|
| 系统 | macOS 26.5.2，build 25F84，arm64 |
| Node / npm | v26.5.0 / 11.17.0 |
| Rust / Cargo | rustc 1.98.1 (48a229cea 2026-09-01) / cargo 1.98.1 (797e8a9bc 2026-08-05) |
| 编辑器（已安装） | `@milkdown/crepe`、`@milkdown/kit` 7.21.3 |
| 前端（已安装） | React 18.3.1，Vite 6.4.3，Vitest 3.2.7，`@tauri-apps/api` 2.11.1 |
| 后端（声明约束，未构建核实解析版本） | Tauri 2，rusqlite 0.40.1 bundled，refinery =0.9.0 optional，lancedb 0.22.1 optional |
| 验证环境 | Vitest/jsdom；Tauri API 在 `vitest.config.ts` 中映射到 mock，不是真实 IPC |

版本来自版本命令和 `npm ls --depth=0 @milkdown/crepe @milkdown/kit react vitest vite @tauri-apps/api`。未安装或升级依赖。项目 `serde_json` 开启 `preserve_order`，因此也不能把对象的普通 JSON 字符串相等当成内容相等；含 HashMap 的对象更不能直接序列化后哈希。

## 3. 已存在的能力与边界

这里“已存在”表示读取到生产实现；除第 6 节的最小 smoke 外，均不是运行时验收结果。链接行号以本次 HEAD 为准，函数名作为后续定位依据。

| 能力 | 代码证据 | 实际边界／升级建议 |
|---|---|---|
| Markdown 正文 + 独立元数据 | [`VfsNoteRepo::create_note_with_conn`](../../../src-tauri/src/vfs/repos/note_repo.rs#L480)、[`get_note_content_with_conn`](../../../src-tauri/src/vfs/repos/note_repo.rs#L909) | `notes.resource_id → resources.data`；没有持久化 ProseMirror JSON 权威文档。维持这一路径。 |
| 正文事务更新、按笔记加盐的内容寻址 | [`update_note_with_conn`](../../../src-tauri/src/vfs/repos/note_repo.rs#L613) | SAVEPOINT 内创建／复用资源、切换指针、重建出链；正文没变则复用资源。**资源 ID 不是历史版本 ID**。 |
| 乐观锁 OCC | 同文件 `next_updated_at`、更新中的 `expected_updated_at`；[`dstu_update`](../../../src-tauri/src/dstu/handlers.rs#L1368) | Repo 支持 CAS，令牌至少推进 1ms；调用方可以不传。DSTU 的毫秒比较为 `current_ms > expected_ms`，不是新的严格文档版本契约。 |
| 元数据原子写入 | [`update_note_metadata_with_conn`](../../../src-tauri/src/vfs/repos/note_repo.rs#L1898) | title/tags/is_favorite/props 一条 CAS UPDATE；与正文保存是不同入口，历史不能只挂在正文更新处。 |
| 保存队列与草稿 | [`NotesCrepeEditor`](../../../src/features/notes/NotesCrepeEditor.tsx#L645) 的按 note 绑定保存目标、queueSave／drain、重试、flush | 草稿主要是组件内 Map/ref；此证据不能证明崩溃后草稿可恢复。最新内容和保存状态已有保护，不需要重写整套保存框架。 |
| 长文分段与完整保存 | [`markdownWindow.ts`](../../../src/features/notes/markdownWindow.ts#L87)、[`NoteContentView.handleSave`](../../../src/features/learning-hub/apps/views/NoteContentView.tsx#L496) | 保存时拼接已编辑前缀与原始未加载后缀；`getFullMarkdown` 位于宿主 API。版本快照必须接收该完整正文，不能只取可见编辑器内容。 |
| 冲突反馈 | [`NoteContentView`](../../../src/features/learning-hub/apps/views/NoteContentView.tsx#L597) | 元数据改变但正文未变时重试；真实冲突会刷新服务器版本，并用闭包／事件提供“恢复我的版本”。不能当作持久化冲突副本。 |
| AI 检查点 | [`useCanvasAIEditHandler.ts`](../../../src/features/notes/hooks/useCanvasAIEditHandler.ts#L39) | 保留原／结果全文，最多 5 条，顶端回滚前检查内容；React state/ref 保存，切换笔记清空。不是跨重启历史。 |
| 软删除／回收站恢复 | [`notes_restore`](../../../src-tauri/src/cmd/notes.rs#L929)、Repo `restore_note_with_conn` | 恢复 deleted_at、处理标题冲突／目录条目，安排重新索引；不是指定文档版本恢复。 |
| 导入导出 | [`notes_exporter.rs`](../../../src-tauri/src/notes_exporter.rs#L43)、[`notesApi.ts`](../../../src/utils/notesApi.ts#L216) | 当前 Markdown + 元数据／附件 ZIP；`include_versions` 为兼容空操作，`version_count` 为 0，导入跳过 `_versions/`。不能承诺备份包含笔记历史。 |
| 双链／反链 | [`extract_note_links`](../../../src-tauri/src/vfs/repos/note_repo.rs#L242)、[`V20260725__note_links.sql`](../../../src-tauri/migrations/vfs/V20260725__note_links.sql) | 支持 wiki 标题／别名／heading 和 note ID；出链是派生表，以 UTF-8 字节偏移定位一次出现。不是稳定块 ID 或历史引用。 |
| 现有编辑器扩展 | [`callout/schema.ts`](../../../src/components/crepe/plugins/callout/schema.ts)、[`toggle/schema.ts`](../../../src/components/crepe/plugins/toggle/schema.ts)、[`wikilink/schema.ts`](../../../src/components/crepe/plugins/wikilink/schema.ts) | callout/toggle 标题是字符串 attrs，正文是 `block+`，wiki 为 inline atom。已审阅的 schema 没有持久化稳定块 ID。 |
| 引用协议 | [`mention/protocol.ts`](../../../src/components/crepe/plugins/mention/protocol.ts)、[`pdfRef/protocol.ts`](../../../src/components/crepe/plugins/pdfRef/protocol.ts) | `note://id#heading` 和 `pdfref://id?page=N` 已有解析；note 解析会忽略 query，不能直接假定 `?version=` 已受支持。 |
| 聊天里的笔记上下文 | [`context/definitions/note.ts`](../../../src/features/chat/context/definitions/note.ts#L53) | 使用 VFS 实时解析内容，metadata 没有文档 versionId；未审计全部聊天快照路径，不据此否认聊天自身已有消息快照，但不能称为 notes 历史解析器。 |
| 图片／附件 | [`cmd/notes.rs`](../../../src-tauri/src/cmd/notes.rs#L948) 的保存、解析、孤儿扫描、删除 | notes_assets 实体文件独立于正文。孤儿扫描 SQL 仅查未删除笔记的当前资源；没有历史保留引用集。 |

### 3.1 特别需要纠正的“历史”误读

1. [`V20260130__init.sql`](../../../src-tauri/migrations/vfs/V20260130__init.sql#L86) 曾创建 `notes_versions(version_id, note_id, resource_id, title, tags, label, created_at)`。
2. [`V20260214__drop_notes_versions.sql`](../../../src-tauri/migrations/vfs/V20260214__drop_notes_versions.sql) 明确 DROP 此表。删除理由包括缺乏同步、逐次保存膨胀和无清理策略。当前迁移注册保留这个删除步骤。
3. `update_note_with_conn` 的 611/627 行注释仍提“保存旧版本／create_version”，但实际函数没有创建版本；761–780 行会在旧资源无 notes 引用时删除旧资源并清理索引。以实际执行代码为准。
4. [`notes_db_stats`](../../../src-tauri/src/cmd/notes.rs#L2017) 的 `total_versions` 恒为 0；同步分类中 `notes_versions` 是 [`Deprecated`](../../../src-tauri/src/data_governance/sync/classification.rs#L538)。不能只把旧表重新建回来。
5. 另一个可借鉴的模块是 [`mindmap_repo.rs`](../../../src-tauri/src/vfs/repos/mindmap_repo.rs#L1510)：有版本分页、读取、恢复、30 分钟自动保存合并、20 条普通版本保留和 chat 来源豁免。它是**思维导图已有功能**；不能称为笔记已有，也不能直接复制其“返回旧版本 ID”的合并策略用于精确历史引用。

## 4. 当前 schema：源码重建结果

未读取用户的真实 SQLite 文件，没有声称已经检查其迁移状态。

| 对象 | 已有结构与用途 | 本次升级缺口 |
|---|---|---|
| `resources` | `id/hash/type/source_id/source_table/storage_mode/data/metadata_json/ref_count`，索引状态等；正文资源通常 inline | 旧资源会回收；单靠 source_id 追溯不可靠 |
| `notes` | `id/resource_id/title/tags/is_favorite/created_at/updated_at/deleted_at`；[`V20260824`](../../../src-tauri/migrations/vfs/V20260824__note_props.sql) 增加 `props TEXT`；通用同步字段见 [`V20260201`](../../../src-tauri/migrations/vfs/V20260201__add_sync_fields.sql) | 没有已读到的文档格式版本、当前文档版本指针或稳定块映射字段 |
| `notes_versions` | 初始化创建，V20260214 删除 | 当前不存在可依赖的笔记历史表 |
| `note_links` | source_id + position 主键；target_id/title/heading/alias/link_type | 没有 target_version_id / target_block_id；只反映当前出链 |
| `note_tags` / `notes_fts` | 当前标签／全文派生索引，迁移与触发器维护 | 历史预览不能污染当前搜索；恢复后应按当前正文更新 |
| `__change_log` | [`V20260131`](../../../src-tauri/migrations/vfs/V20260131__add_change_log.sql) 包含 notes/resources 变化日志触发器 | 变化日志不是完整文档快照；新表还需同步分类与备份覆盖决策 |

`notes.props` 是用户属性，不能用来偷偷承载升级格式开关。标题只校验非空、最多 500 字符及控制字符，不会自动剥掉 Markdown 标记；导入从 H1 提取标题也不是富文本解析器。

## 5. 后端历史 MVP：建议的落地位置

推荐**独立完整快照表 + 当前文档版本指针**，快照自带 Markdown，不引用会被删除的旧 `resources` 行。保留现有资源寻址与当前索引链路。详细字段、事务、引用与恢复语义见 ADR-04～06。

| 工作 | 实施文件（均未在本次修改） | 原因 |
|---|---|---|
| 增量 schema | `src-tauri/migrations/vfs/V<分配的新编号>__note_document_revisions.sql`；`src-tauri/src/data_governance/migration/vfs.rs`；`src-tauri/migrations/migration-lock.json` | 使用新表名，追加迁移，注册 expected tables/indexes；按仓库机制更新迁移锁，不能改旧迁移或复活 Deprecated 表 |
| 快照 CRUD／restore | 建议新增 `src-tauri/src/vfs/repos/note_revision_repo.rs`；接入 `repos/mod.rs`、`vfs/types.rs` | list/get/append/restore 在同一连接下复用；快照不依赖当前资源存活 |
| 所有当前文档写入 | `vfs/repos/note_repo.rs` 的 create/update/metadata、回收站恢复自动改名；`notes_manager.rs`；`dstu/handlers.rs`；`dstu/handler_utils/content_helpers.rs` | 覆盖正文、标题、tags、props、Canvas、DSTU／legacy VFS 入口。收藏／目录是工作区状态，可不生成文档版本，但仍不能绕过现有 OCC |
| 导入和同步写入 | `notes_exporter.rs` 的 VFS overwrite 分支；`data_governance/sync/` 的 notes/resources 应用链 | 导入不能绕过版本事务；远端行同步可能绕开 Repo，必须有明确接入或拒绝规则，再开放 opt-in 页跨设备写入 |
| 命令与前端接线 | `cmd/notes.rs`、`src-tauri/src/lib.rs`（现有命令注册）；`src/utils/notesApi.ts`；DSTU 返回 metadata | 新增分页历史、指定版本读取、CAS 恢复接口，命名避免混淆现有 `notes_restore` |
| 附件留存 | `cmd/notes.rs` 的 scan_orphans/delete/bulk_delete/hard_delete/empty_trash；`data_governance/file_deletion_queue.rs` | 清理前检查当前／回收站／历史附件引用；物理删除继续使用原有日志队列 |
| 数据治理 | `data_governance/sync/classification.rs`、备份与恢复覆盖测试；`notes_exporter.rs` | 本地历史 MVP 可先用 `BackupOnly`，完整 SQLite 备份与笔记 ZIP 分开验证；不能对外声称 RowSync 已覆盖 |
| 编辑宿主 | `NoteContentView.tsx`、`NotesCrepeEditor.tsx`、`useCanvasAIEditHandler.ts` | 历史读取只读；恢复处理未保存草稿、完整正文、当前版本令牌、切页期间异步结果 |

**不能只加一个历史弹窗**：那样关闭／重启仍没有历史，旧附件也仍可能被孤儿清理。最小后端闭环是“保存生成完整版本 → 分页／读取 → 恢复生成新版本 → 冲突不覆盖 → 历史附件不被清理”。稳定块导航可在这个闭环之后接入。

## 6. 已执行验证与未执行验证

执行命令（单 worker，不调用全量测试、Rust 构建或桌面启动）：

```sh
./node_modules/.bin/vitest run \
  src/features/notes/__tests__/markdownWindow.test.ts \
  src/components/crepe/plugins/toggle/__tests__/roundtrip.test.ts \
  src/components/crepe/plugins/wikilink/__tests__/roundtrip.test.ts \
  --maxWorkers=1 --minWorkers=1
```

2026-09-21 18:55 本地结果：**3 文件、39 tests 通过，2.34s**。分别是 19 个长文窗口测试、6 个 toggle 测试、14 个 wikilink 测试。执行目的是确认现有窗口拼接和两种扩展的基础往返能力是否可作为设计起点；它们通过，因此建议复用现有实现。

这次测试运行在当时的共享工作树，没有冻结独立 checkout；收尾已经看到相关前端文件被其他会话继续修改。因此该结果有明确时间边界，不等同于“并发改动完成后的整个工作树通过”。后端关键历史／schema 证据所在文件在收尾 status 中未出现修改。

没有执行：F01–F08 的真实桌面往返、稳定块 ID、文档历史读写／恢复、故障注入、附件回收、跨设备同步、ZIP 历史往返、性能和移动端视觉验收。样本与 ADR 的存在只证明规格已写，**不证明这些用例通过**。将来视觉验证必须用 `npm run tauri dev` 的真实桌面应用。

## 7. WP00 向后续阶段移交

| 阶段 | 本次建议的门槛 | 本次状态 |
|---|---|---|
| S0 基线 | 锁定实际 HEAD；区分已有实现／期望；固定 F01–F08 | 本文与样本已交付；39 个既有 smoke 通过 |
| S1 无损兼容 | Markdown 权威、纯文本标题、未知语法保护、逐页显式升级／撤回规则 | ADR 已选择；实现与应用验证待完成 |
| S2 文档历史 | 持久化完整快照、所有写入口接入、CAS 恢复、附件保留 | 仅建议；必须先于对用户承诺历史可恢复 |
| S3 块与引用 | 稳定块 ID 往返、历史／实时引用区分、版本固定与只读定位 | 仅契约与样本；依赖 S1/S2 |
| S4 发布与迁移 | 真实桌面＋移动端、备份／同步兼容、数据量／保留策略验收 | 未执行；WP01–WP10 执行者按原方案分工接入 |

后续优先验证的两个问题：新格式标记能否被整套 Crepe parse/serialize 无损保留，以及保存／metadata／同步入口是否能共用一个原子文档版本事务。任一未闭环时，不扩大 opt-in 范围。
