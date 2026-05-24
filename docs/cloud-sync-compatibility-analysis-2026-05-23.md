# 云同步兼容性分析报告

日期：2026-05-23  
范围：`src-tauri/src/data_governance/**`、`src-tauri/migrations/**`、`src-tauri/src/cloud_storage/**`、`src-tauri/src/chat_v2/workspace/**`、前端同步入口。

## 判断

当前云同步可以处理已接入同步模型的部分业务数据，但不能保证完整应用数据在多端之间可靠一致。

它当前更接近以下组合：

- 13 张表的行级增量同步。
- VFS blob、通用资产目录、workspace 数据库的文件级同步。
- ZIP 云端版本备份和恢复。

风险最大的地方不是冲突回放器本身，而是数据结构范围远大于行级同步覆盖范围。大量表会参与业务运行或 checksum，但不会产生可上传、可回放的变更。

## 当前同步实现

### ZIP 云备份路径

文件：`src-tauri/src/cloud_storage/sync_manager.rs`

用途：

- 云端 `manifest.json` 管理备份版本。
- 备份文件位于 `backups/*.zip`。
- 支持上传、下载、版本保留。

该路径是快照级备份，不做记录级合并。

### Data Governance 增量同步路径

文件：

- `src-tauri/src/data_governance/commands_sync.rs`
- `src-tauri/src/data_governance/sync/mod.rs`
- `src-tauri/src/data_governance/commands_backup.rs`
- `src-tauri/src/data_governance/sync/conflict_resolver.rs`

主要流程：

1. 遍历治理范围内的数据库。
2. 读取每个库的 `__change_log` 中 `sync_version = 0` 的记录。
3. 对 INSERT/UPDATE 补全完整行 JSON，形成 `SyncChangeWithData`。
4. 上传到 `data_governance/changes/{device_id}/{timestamp}-{uuid}.json.zst`。
5. 上传设备清单到 `data_governance/manifests/{device_id}.json`。
6. 下载其他设备变更后，按 `database_name` 路由到对应数据库回放。
7. 行级冲突写入每个库自己的 `__sync_conflicts`。
8. 同步结束后再执行文件级同步：workspace db、VFS blobs、资产目录。

加密范围：

- 文本 payload、manifest、tombstone、文件 manifest 支持 DSBK 加密。
- VFS raw blob 和 workspace `.db` 文件不加密。

## 数据结构范围

治理数据库共 4 个：

| 数据库 | 路径 | 说明 |
|---|---|---|
| `vfs` | `<active_dir>/databases/vfs.db` | VFS 资源、笔记、文件、题库、复习、索引、todo |
| `chat_v2` | `<active_dir>/chat_v2.db` | 会话、消息、块、附件、会话状态、workspace 索引 |
| `mistakes` | `<active_dir>/mistakes.db` | 错题、Anki、回顾分析、设置、RAG、搜索日志 |
| `llm_usage` | `<active_dir>/llm_usage.db` | LLM 调用日志和日汇总 |

额外文件级数据：

- `<active_dir>/workspaces/ws_*.db`
- `<active_dir>/vfs_blobs/**`
- `<active_dir>/images`
- `<active_dir>/notes_assets`
- `<active_dir>/documents`
- `<active_dir>/subjects`
- `<active_dir>/textbooks`
- `<active_dir>/audio`
- `<active_dir>/videos`
- `<app_data_dir>/pdf_ocr_sessions`

workspace 独立库包含：

- `workspace`
- `agent`
- `message`
- `inbox`
- `document`
- `context`
- `sleep_block`
- `subagent_task`

## 行级同步覆盖

实际带 `__change_log` 触发器并添加同步字段的表如下：

| 数据库 | 行级同步表 |
|---|---|
| `vfs` | `resources`, `notes`, `questions`, `review_plans`, `folders` |
| `chat_v2` | `chat_v2_sessions`, `chat_v2_messages`, `chat_v2_blocks` |
| `mistakes` | `mistakes`, `anki_cards`, `review_analyses` |
| `llm_usage` | `llm_usage_logs`, `llm_usage_daily` |

二轮核查确认：`V20260201__add_sync_fields.sql` 也只给这些表添加同步字段。当前并不是“字段覆盖全表但触发器缺失”，而是整套行级同步模型只覆盖这 13 张表。

## 未覆盖但影响业务的数据

以下是典型未覆盖表：

| 数据库 | 未行级同步的典型表 | 风险 |
|---|---|---|
| `vfs` | `files`, `blobs`, `folder_items`, `path_cache`, `mindmaps`, `review_history`, `review_stats`, `answer_submissions`, `todo_lists`, `todo_items`, `pomodoro_records`, `vfs_index_*`, `memory_*` | 文件元数据、目录关系、复习历史、todo、索引状态不会通过行级增量传播 |
| `chat_v2` | `chat_v2_attachments`, `chat_v2_session_state`, `chat_v2_session_mistakes`, `resources`, `chat_v2_todo_lists`, `workspace_index`, `sleep_block`, `subagent_task`, `chat_v2_session_groups`, `chat_v2_session_tags`, `chat_v2_compactions` | 附件元数据、会话 UI 状态、分组、标签、压缩记录等不同步 |
| `mistakes` | `chat_messages`, `review_chat_messages`, `review_sessions`, `review_session_mistakes`, `settings`, `rag_configurations`, `document_tasks`, `custom_anki_templates`, `document_control_states`, `vectorized_data`, `rag_sub_libraries`, `search_logs`, `exam_sheet_sessions`, `migration_progress` | 设置、聊天明细、文档任务、向量数据、搜索日志等不同步 |

这些表中有些应作为本地派生数据或运行时状态排除，有些明显是用户数据。当前代码没有一个统一的“同步分类注册表”来表达这个边界。

## 二轮调研新增发现

### 1. 级联删除问题需要重新表述

另一份报告认为 SQLite `ON DELETE CASCADE` 不会触发子表触发器。这个判断不成立。

用 `sqlite3 :memory:` 验证：

```sql
PRAGMA foreign_keys=ON;
CREATE TABLE p(id TEXT PRIMARY KEY);
CREATE TABLE c(id TEXT PRIMARY KEY, pid TEXT REFERENCES p(id) ON DELETE CASCADE);
CREATE TABLE log(t TEXT, id TEXT);
CREATE TRIGGER c_del AFTER DELETE ON c BEGIN INSERT INTO log VALUES('c', OLD.id); END;
INSERT INTO p VALUES('p1');
INSERT INTO c VALUES('c1','p1');
DELETE FROM p WHERE id='p1';
SELECT * FROM log;
```

结果为：

```text
c|c1
```

所以 Chat V2 中删除 `chat_v2_sessions` 时，级联删除 `chat_v2_messages` 会触发 message 的 DELETE 日志，`chat_v2_blocks` 同理。真实问题是 `chat_v2_attachments` 没有同步触发器，附件表本身不在行级同步范围。

### 2. checksum 覆盖范围大于同步范围

`get_database_sync_state()` 的 checksum 会扫描所有非 `sqlite_%`、非 `__%` 的表。FTS5 会创建 shadow table，例如：

```text
questions_fts
questions_fts_config
questions_fts_content
questions_fts_data
questions_fts_docsize
questions_fts_idx
```

这些表不会被当前 SQL 排除。结果是：FTS、缓存、统计、运行时表的变化可能让 checksum 变化，但没有相应变更 payload 可同步。

### 3. 唯一约束和默认 UPSERT 冲突键不匹配

回放时默认按 `id` 做 UPSERT。下列表使用业务唯一键或内容唯一键：

- `vfs.resources.hash UNIQUE`
- `vfs.files.sha256 UNIQUE`
- `vfs.files.content_hash` 条件唯一索引
- `vfs.blobs.hash PRIMARY KEY`
- `vfs.review_plans.question_id UNIQUE`
- `chat_v2.resources.hash UNIQUE`
- `llm_usage_daily(date, caller_type, model, provider)` 复合主键，当前已有专门处理

当前只有 `llm_usage_daily` 有特殊回放逻辑。`review_plans` 和 `resources` 在多端并发创建同一业务对象时，可能因为唯一约束失败或产生语义重复。

### 4. 引用计数不适合普通行级 LWW

`vfs.resources.ref_count`、`vfs.blobs.ref_count`、`chat_v2.resources.ref_count` 都属于派生计数。多端并发增加/减少引用时，普通整行覆盖会让计数失真。

当前 VFS `resources` 是行级同步表，所以这个风险真实存在。`blobs` 表本身不行级同步，但 blob 文件和 tombstone 又会受 ref_count 驱动的删除队列影响。

### 5. 文件级同步不是记录级合并

workspace db 的同步策略是：

- 本地有且 sha256 与云端不同：上传本地文件。
- 云端有但本地没有：下载云端文件。
- 本地和云端都有但内容不同：本地优先上传。

这不适合多设备并发编辑同一个 workspace db。VFS blob 和资产目录也不是和数据库记录同一个事务提交。

### 6. prune gap 只在 UI 层预检

前端下载/双向同步前会调用 `detectPruneGap`。检测到断层后，用户仍可确认继续；如果检测失败，前端继续同步。后端 `data_governance_run_sync` 自身没有强制拒绝。

这意味着 API 调用方或未来入口绕过前端时，仍可能在缺失中间变更的情况下执行普通增量同步。

### 7. ZIP 恢复后的同步基线重建存在实现偏差

`reset_sync_baseline_after_restore()` 会寻找同时拥有 `local_version` 和 `sync_version` 两列的业务表，并尝试执行：

```sql
UPDATE "{table}" SET sync_version = local_version WHERE sync_version != local_version
```

但实际迁移没有给业务表添加 `sync_version` 列。`sync_version` 只存在于 `__change_log`。因此这一步通常不会重置任何业务记录，只会清空 `__change_log` 和 `__sync_conflicts`。

这不一定会立刻造成数据上传，因为待上传变更来自 `__change_log`；但代码注释和实现不一致，恢复后 manifest/data_version 的语义也需要重新确认。

### 8. 字段级合并是已知缺口

`sync_adversarial_tests.rs` 已经包含行级 LWW 丢失不同字段并发修改的测试，其中字段级合并测试被标为 `#[should_panic]`。这说明项目已经承认当前没有字段级合并。

## 三轮调研新增发现

### 1. prune gap 的判定口径不一致

`data_governance_detect_prune_gap()` 取的是所有数据库 `data_version` 的最大值；`execute_download()` 里真正拉取变更时，起点用的是这些版本的最小值，再按数据库逐个过滤。

这会让某个较慢数据库的断层被更快数据库掩盖掉。前端看起来“没有 prune gap”，实际下载时仍可能遇到缺失中间变更。

### 2. checksum 同时包含同步表和运行时表

`calculate_simple_checksum()` 扫描的是整个 sqlite schema，而不是只看同步表。像 `chat_v2_session_state`、`sleep_block`、`subagent_task`、`path_cache`、`review_stats` 这类运行时或派生表，只要内容变了，checksum 就会变。

反过来，像 `chat_v2_attachments` 这类没有 `updated_at` 的表，内容变了但行数没变时，checksum 也可能看不出来。

这会同时带来两类问题：

- 同步状态被运行时数据扰动，出现没有实际同步差异的 `ChecksumMismatch`。
- 真正重要但缺少 `updated_at` 的表，变化被 checksum 漏掉。

### 3. workspace DB 是整库文件同步

`sync_workspace_databases()` 对 `ws_*.db` 只做文件 hash 比较，然后按“本地优先”上传整个 `.db` 文件；它只做了 `wal_checkpoint(PASSIVE)`，没有把 WAL 链路作为同步对象。

这意味着：

- 最近写入但还在 WAL 里的内容，可能不会进入上传结果。
- 两端同时改同一个 workspace DB 时，没有冲突表，也没有记录级合并，最后就是本地覆盖云端。
- 这个分支里的 workspace 同步失败只记 warn，主流程仍可能返回成功。

## 四轮调研：主流同步方案对照

本轮补充查阅了以下官方资料：

- [Replicache: How Replicache Works](https://doc.replicache.dev/concepts/how-it-works)
- [Zero: What is Sync?](https://zero.rocicorp.dev/docs/sync)
- [Zero: Mutators](https://zero.rocicorp.dev/docs/mutators)
- [Electric: Shapes](https://electric.ax/docs/sync/guides/shapes)
- [Electric: Writes](https://electric.ax/docs/sync/guides/writes)
- [PowerSync overview](https://docs.powersync.com/intro/powersync-overview)
- [PowerSync writing data](https://docs.powersync.com/client-sdks/writing-data)
- [PowerSync handling update conflicts](https://docs.powersync.com/handling-writes/handling-update-conflicts)
- [Couchbase Lite replication](https://docs.couchbase.com/couchbase-lite/current/swift/replication.html)
- [Couchbase conflict resolution](https://docs.couchbase.com/sync-gateway/current/conflict-resolution.html)
- [Cloud Firestore offline persistence](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- [SQLite Session Extension](https://www.sqlite.org/sessionintro.html)
- [Litestream: How it works](https://litestream.io/how-it-works/)
- [Yjs documentation](https://docs.yjs.dev/)
- [Automerge documentation](https://automerge.org/docs/hello/)

### 1. Replicache / Zero 路线

Replicache 的模型是：本地先执行 mutator，变更作为 mutation 推给服务端；服务端在权威数据上重新执行 mutation；客户端拉取服务端补丁后，把本地未确认 mutation 重新执行到新状态上。

Zero 延续了这个方向：UI 读写本地规范化数据；写入通过 mutator；服务端 mutation endpoint 负责把写入提交到数据库；同步引擎再把行变化发回客户端。

对当前项目的启发：

- 记录“操作意图”比只记录整行快照更适合复杂业务。
- 冲突处理不应只靠通用 LWW；应进入业务 mutator，例如复习计划、资源去重、文件引用、消息块排序。
- 需要明确服务端或云端权威点。没有这个点时，pending mutation rebase 很难做到稳定可解释。

### 2. Electric / PowerSync 路线

Electric 的 Shapes 用来把 Postgres 的子集同步到本地，当前文档明确写道 Electric 做的是 read-path sync，不提供内置 write-path sync。写入需要应用自己实现 API、乐观状态或 through-the-database 模式。

PowerSync 更接近“本地 SQLite + 后端源数据库”。客户端直接写本地 SQLite，SDK 生成上传队列；上传队列包含 PUT、PATCH、DELETE；后端负责幂等写入、校验和冲突处理。PowerSync 的默认冲突行为接近 LWW，但文档也强调需要自定义时应放在应用后端。

对当前项目的启发：

- 本地 SQLite 作为交互数据库是合理方向。
- 需要一套上传队列，而不是只依赖 `__change_log sync_version = 0`。
- PATCH 级别的字段变更比整行 JSON 更适合 JSON、计数、复习状态、用量统计。
- 如果引入权威后端数据库，PowerSync/Electric 的分区思想适合参考；如果继续只用对象存储，不能直接照搬。

### 3. Couchbase / Firestore 路线

Couchbase Lite + Sync Gateway 提供双向复制、连续同步、重试、过滤、访问控制和冲突处理。Sync Gateway 4.0 默认 LWW，Couchbase Lite 文档也说明删除优先，并支持自定义 conflict resolver。

Firestore 提供离线缓存和离线写入队列，设备恢复在线后同步；同一文档多次变更默认 LWW。

对当前项目的启发：

- LWW 可以作为普通字段默认策略，但不能作为全局策略。
- 删除需要明确 tombstone 优先级和保留时间。
- 文档型同步产品能解决一部分问题，但当前项目是关系型多库、多表、文件对象、派生索引混合结构，不能把整行 JSON 当作“文档”直接套用。

### 4. SQLite Session / Litestream 路线

SQLite Session 可以生成 changeset/patchset，记录 INSERT、DELETE、UPDATE，并且 UPDATE 包含修改字段的新旧值。应用 changeset 时有 conflict callback，可以处理主键冲突、唯一约束冲突、缺失行、约束失败等情况。限制也明确：虚拟表不支持，表需要主键，schema 需要兼容。

Litestream 是 SQLite WAL 流式复制和灾备恢复工具。它持续复制 WAL 页面，强调 snapshot + 连续 WAL 的完整性。它适合备份、恢复、读副本，不适合多个设备同时写同一个 SQLite 文件后做业务合并。

对当前项目的启发：

- SQLite Session 可作为底层变化捕获机制的候选，用来替换当前整行 JSON 快照的一部分缺陷。
- SQLite Session 仍然不能处理业务合并、文件对象一致性、派生表重建、跨数据库事务。
- workspace `.db` 的文件同步更接近 Litestream/备份类问题，不应承担多端编辑合并。

### 5. CRDT 路线

Yjs 和 Automerge 都适合协同编辑、离线编辑、自动合并。Yjs 提供共享类型，更新顺序无关；Automerge 支持离线修改后自动合并复杂数据结构。

对当前项目的启发：

- CRDT 适合局部字段：富文本笔记、workspace document、可能的思维导图内容、多人编辑草稿。
- CRDT 不适合作为整个关系型数据库的同步方案。复习计划、引用计数、文件生命周期、权限、统计缓存仍需要业务规则。

## 外部样本对照：三个成熟实现

本轮对照基于本地 clone 的官方仓库：

- [Cherry Studio backup / restore](/Volumes/cipan/deep-student/cipan/example/cherry-studio/src/main/services/BackupManager.ts:168)
- [SiYuan sync entry](/Volumes/cipan/deep-student/cipan/example/siyuan/kernel/model/sync.go:174)
- [SiYuan repository flow](/Volumes/cipan/deep-student/cipan/example/siyuan/kernel/model/repository.go:1510)
- [LiveSync data structures](/Volumes/cipan/deep-student/cipan/example/obsidian-livesync/src/lib/src/common/models/db.definition.ts:66)
- [LiveSync journal sync](/Volumes/cipan/deep-student/cipan/example/obsidian-livesync/src/lib/src/replication/journal/JournalSyncAbstract.ts:1)
- [LiveSync replicator](/Volumes/cipan/deep-student/cipan/example/obsidian-livesync/src/lib/src/replication/journal/LiveSyncJournalReplicator.ts:1)

也可直接看官方仓库：

- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)
- [SiYuan](https://github.com/siyuan-note/siyuan)
- [Obsidian LiveSync](https://github.com/vrtmrz/obsidian-livesync)

### 1. Cherry Studio

同步粒度：

- 不是记录级同步。
- 主对象是整套用户态目录：`IndexedDB`、`Local Storage`、`Data`。

远端载体：

- ZIP 备份文件。
- 支持本地目录、WebDAV、S3。

冲突策略：

- 不做合并。
- 恢复时先解压到临时目录，再在启动阶段把 `*.restore` 目录切回正式目录。

加密与校验：

- 主要是备份格式识别、`metadata.json` 校验和恢复标记。
- 备份/恢复链路本身不提供同步级冲突处理。

能借鉴的部分：

- 备份和恢复分层。
- 先写临时目录，再在启动阶段做原子切换。
- 备份元数据要明确写出应用名、平台和格式版本。

不能照搬的部分：

- 它只能当灾备，不是主同步引擎。
- 不处理并发修改、字段冲突、外键关系、引用计数和派生表。

### 2. SiYuan

同步粒度：

- 以数据仓库为单位。
- 具体到文件、块、索引、快照、标签、仓库日志，而不是数据库行。

远端载体：

- 数据仓库支持官方云、WebDAV、S3、Local 等 provider。
- 代码里直接走 `repo.Sync`、`SyncUpload`、`SyncDownload`、`GetCloudLatest`、`GetSyncCloudFiles`。

冲突策略：

- 仓库级合并结果由 `dejavu` 处理。
- 有锁、清理、checkout、回滚快照、索引修复、自动 purge 这些仓库级状态。

加密与校验：

- 数据仓库 key 是前提。
- 官方明确不支持第三方同步盘，否则会损坏数据。
- 同步前后会做索引订正和仓库状态维护。

能借鉴的部分：

- 远端状态要有明确的仓库概念。
- 锁、快照、checkout、恢复路径要完整。
- 同步前后的索引修复和健康检查要单独做。

不能照搬的部分：

- 它围绕 `.sy` 文件和仓库日志，不适合直接套到多 SQLite 库。
- 它没有替我们处理跨库外键、资产目录和派生表的一致性。

### 3. Obsidian LiveSync

同步粒度：

- 文档、块、chunk、milestone、sync parameters。
- `EntryDoc`、`EntryLeaf`、`DatabaseEntry` 都是文档模型的一部分。

远端载体：

- CouchDB/兼容服务。
- Journal + MinIO/S3/R2 对象存储。
- WebRTC P2P 也是一条完整链路。

冲突策略：

- PouchDB 的 revision 冲突是底层事实。
- 简单冲突可自动合并，复杂冲突进入 conflict 流程。
- 复制时依赖 checkpoint、`revsDiff`、`_local` mark、milestone doc。

加密与校验：

- 支持 E2EE，`SyncParameters` 里保存 `protocolVersion` 和 `pbkdf2salt`。
- `milestone` 文档负责兼容性、锁和已接受节点。
- journal 侧还有 checkpoint cache 和 epoch 切换。

能借鉴的部分：

- checkpoint / mark 模型。
- 远端兼容性文档和运行参数文档分离。
- chunk 级去重、重传、对象存储、P2P 这些通道设计。

不能照搬的部分：

- 它的模型是文档库，不是关系型多库。
- 它不处理外键、引用计数、跨表事务和资产文件原子提交。

三者合起来看，最适合当前项目的不是单一套件，而是分层组合：

- 备份/恢复用 Cherry Studio 的临时目录 + 原子切换思路。
- 仓库状态、锁、兼容性和恢复流程参考 SiYuan。
- 变更流、checkpoint、远端参数和对象存储参考 LiveSync。
- 主数据仍然要回到我们自己的领域变更流、上传队列和本地派生重建。

## 最适合当前项目的改造路线

建议目标形态：本地 SQLite 继续作为应用主存储；云端不再同步整库文件作为主链路；结构化数据进入“领域变更流”；大文件进入内容寻址对象存储；派生数据本地重建；必要字段使用 CRDT。

### 阶段 0：先把边界定义清楚

建立声明式同步目录，至少记录：

- 数据库名、表名、主键。
- 是否参与同步。
- 表分类：用户数据、领域事件、文件元数据、派生索引、缓存统计、本地运行时、备份专用、废弃兼容。
- 冲突策略：LWW、字段级合并、集合并集、计数器、删除优先、业务 mutator、CRDT、只重建。
- 业务唯一键：例如 `resources.hash`、`review_plans.question_id`、`files.sha256`。
- 文件引用字段：例如 blob hash、asset key。
- 派生表重建函数。

这份目录应由迁移和测试共同验证。checksum、prune gap、上传队列、回放器都读取这份目录。

### 阶段 1：修正当前模型内的高风险点

需要先完成：

- checksum 只计算参与同步一致性的真实数据，不把 FTS shadow table、缓存、统计、运行时表混进去。
- prune gap 改成按数据库、表或 stream 检测，并在后端同步命令中强制执行。
- `resources.hash`、`review_plans.question_id` 这类业务唯一键进入回放策略。
- `ref_count` 改为派生值或引用边集合推导值，不再参与整行覆盖。
- ZIP 恢复后的同步基线语义重新定义并补测试。
- workspace `.db` 从“主同步数据”降级为备份对象；需要同步的 workspace 持久数据迁入主同步模型。

### 阶段 2：从行快照升级为变更集

当前 `SyncChangeWithData` 只有表名、记录 ID、操作、整行 JSON。建议升级为 `SyncEnvelope`：

- `device_id`
- `client_id`
- `op_id`
- `transaction_id`
- `domain`
- `schema_version`
- `base_checkpoint`
- `changes[]`
- `object_refs[]`
- `created_at_hlc`
- `signature/hash`

单条 change 应包含：

- 表名和主键。
- 操作类型。
- 修改字段集合。
- old/new 值或 SQLite changeset。
- 业务唯一键。
- 依赖关系，例如先有 `resources` 再有 `notes`。
- 冲突策略 ID。

这样可以支持字段级合并、跨表事务、审计、重放、修复和失败重试。

### 阶段 3：增加上传队列和确认机制

参考 PowerSync 和 Replicache/Zero：

- 本地写入先进入 durable upload queue。
- 每个设备维护单调递增 `op_id`。
- 云端或同步服务返回已确认 checkpoint。
- 已确认变更才从队列移除。
- 临时网络错误保留队列。
- 业务拒绝、schema mismatch、不可合并冲突进入 dead-letter / conflict 表。

如果继续只用对象存储，云端至少要做到 append-only log、manifest 条件写入、per-device cursor、日志分段、强制断层检测。对象存储能做到可用的个人多端同步，但很难达到服务端权威同步系统的能力。

### 阶段 4：引入轻量同步服务

如果目标是 SOTA 级别，最终需要一个小型同步服务，而不是只靠 S3/WebDAV/OSS 文件列表。

同步服务负责：

- 认证和设备注册。
- 接收 mutation / changeset。
- 幂等去重。
- 在权威状态或权威日志上执行业务 mutator。
- 输出按客户端可见范围过滤后的变更流。
- 管理 checkpoint、prune、repair。
- 管理 blob 上传完成状态。

对象存储继续用于 blob、资产、备份、日志归档。结构化同步不应依赖“下载所有 JSON 文件再本地决定”的模式。

### 阶段 5：局部引入 CRDT

只在适合的字段使用：

- workspace document 内容。
- 笔记正文或富文本块。
- 思维导图节点结构。
- 多端草稿。

CRDT 数据以 blob 或专门表保存，外层仍由同步目录管理生命周期、权限、引用、压缩和快照。

### 阶段 6：完整恢复和校验

需要具备：

- 同步健康检查。
- stream checkpoint 校验。
- 按表重算 checksum。
- 派生表重建。
- blob 引用完整性扫描。
- 从对象存储回补缺失 blob。
- 从权威日志重放到任意 checkpoint。
- schema 迁移前后的兼容窗口测试。

## 对当前方案是否合适的判断

当前方案适合作为早期个人多端同步原型，不适合作为高可靠云同步系统。

保留当前方向中可用的部分：

- 本地 SQLite。
- append-only 变更文件。
- tombstone。
- 内容寻址 blob。
- 每设备 manifest。
- 事务内回放和外键校验。

需要放弃或降级的部分：

- workspace `.db` 作为主同步数据。
- 全库 checksum。
- 整行 JSON 作为唯一变更表达。
- 通用 `ON CONFLICT(id)` 回放。
- `ref_count` LWW。
- 只在前端预检 prune gap。
- 文件和数据库分离成功但整体仍报成功。

最终路线建议采用“Replicache/Zero 的 mutation 思路 + PowerSync 的本地 SQLite/上传队列思路 + Electric 的数据子集思想 + CRDT 局部文档 + 内容寻址对象存储”。

短期可以不立刻引入完整后端，但数据结构和同步协议应按这个方向改。否则后续从对象存储日志迁移到同步服务时，会再次重写表覆盖、冲突策略和文件一致性模型。

## 对补充报告的核验

另一份补充报告中的多数风险判断成立，尤其是同步覆盖不足、checksum 范围错误、业务唯一键冲突、`ref_count` LWW、workspace 文件级同步、文件与数据库非原子同步。

需要修正或补充的点如下：

| 补充报告判断 | 核验结果 |
|---|---|
| `questions` 触发器仍把 `record_id` 写成 `exam_id` | 早期迁移 `V20260131__add_change_log.sql` 确实如此；但 `V20260211__fix_change_log_record_id.sql` 已经 drop 并重建为 `NEW.id` / `OLD.id`。当前完整迁移后的库不应再有这个 bug。仍需测试旧库迁移健康状态。 |
| ZIP 恢复后的基线重建基本无效 | 成立。`reset_sync_baseline_after_restore()` 查找同时有 `local_version` 和 `sync_version` 的业务表，但实际迁移只给业务表添加了 `local_version`，`sync_version` 在 `__change_log` 内。 |
| 当前 Change Log + LWW 方向是正确选择 | 只能作为短期个人多端同步原型成立。若目标是 SOTA 级别，需要升级为 mutation / changeset / upload queue / checkpoint / 领域合并模型。 |
| SQLite cascade 删除导致子表触发器不触发 | 不成立。SQLite 外键级联删除会触发子表 DELETE trigger。真实问题是未覆盖表，例如 `chat_v2_attachments` 没有 change_log 触发器。 |
| 多表事务乱序必然失败 | 需要限定。当前回放在事务内启用 `PRAGMA defer_foreign_keys = ON` 并在末尾 `foreign_key_check`，同批次内父子乱序可被延迟检查覆盖；跨批次、跨库、未覆盖父表仍然有风险。 |
| HLC 为 48 位毫秒 + 16 位 counter，漂移窗口 60 秒 | 成立，见 `src-tauri/src/data_governance/sync/hlc.rs`。 |

## 能正常工作的场景

满足以下条件时，当前同步链路可以工作：

1. 变更只发生在 13 张行级同步表内。
2. 设备 schema 版本一致。
3. 云端变更未被 prune 清理到本机 `since_version` 之后。
4. 同一记录并发修改可以接受 LWW 或冲突表处理。
5. 不依赖字段级 JSON 合并。
6. 不并发编辑同一个 workspace db。
7. 文件同步成功，且数据库记录与文件资产之间可以接受非原子窗口。
8. 所有设备使用同一加密配置读取文本 payload。

## 不能保证的场景

| 场景 | 当前表现 |
|---|---|
| 修改未覆盖业务表 | 不进入 `__change_log`，不会行级上传 |
| 未覆盖表改变 checksum | 可能显示数据库分叉，但没有变更可应用 |
| 同内容不同 ID 的资源并发创建 | 可能触发 hash UNIQUE 冲突 |
| 同一题多端创建复习计划 | `review_plans.question_id UNIQUE` 可能冲突 |
| 多端并发更新 JSON 不同 key | 记录级 LWW 会覆盖整列 |
| ref_count 多端并发变化 | 计数可能失真，进而影响删除 |
| workspace db 多端并发编辑 | 文件级本地优先，不能合并 |
| workspace db 仍有 WAL 尾写 | 可能漏掉最近提交的内容 |
| 普通资产或 blob 与 DB 记录不同步成功 | 可能出现记录存在但文件缺失，或文件存在但记录缺失 |
| prune gap 被忽略 | 普通增量同步可能遗漏中间变更 |
| checksum 被运行时表扰动 | 可能出现没有实际同步差异的数据库级冲突 |
| ZIP 恢复后立即继续增量同步 | 基线语义需要修正和测试 |

## 对另一份报告的修正

| 报告判断 | 修正 |
|---|---|
| 3 个主数据库 | 当前治理库是 4 个，包括 `llm_usage` |
| VFS 27 张表 | 当前 VFS 记录为 32 张常规表，加 FTS 和视图 |
| SQLite cascade 不触发子表触发器 | 不成立，实测会触发 |
| 删除 session 只记录 session | 对 messages/blocks 不成立；attachments 未覆盖才是真问题 |
| 多表事务乱序必然外键失败 | 同一库同一批次有延迟外键检查；跨批次、跨库、未覆盖父表才是风险 |
| FTS 通过触发器捕获变更 | 当前 FTS 不行级同步，问题在 checksum 和重建策略 |
| AUTOINCREMENT 是主要同步风险 | 当前已同步表大多使用 TEXT id；AUTOINCREMENT 主要在未覆盖聊天明细或内部日志中，优先级低于唯一业务键 |

## 建议处理顺序

### P0

1. 建立同步分类注册表。
   - 明确每张表属于：行级同步、文件级同步、派生重建、本地运行时、备份恢复、废弃兼容。
   - checksum 只应扫描应参与同步一致性的表。

2. 修正 checksum。
   - 排除 FTS shadow table、缓存表、统计表、运行时表。
   - 或为不同表分类计算不同状态，不把所有表混为一个数据库 checksum。

3. 为已同步表补业务唯一键处理。
   - `resources.hash`
   - `review_plans.question_id`
   - 后续如果同步 `files`，需要处理 `sha256` 和 `content_hash`。

4. 后端强制处理 prune gap。
   - `data_governance_run_sync` 在 download/bidirectional 前执行断层检测。
   - 发现断层时默认拒绝，除非显式传入 override。

5. 修复 ZIP 恢复基线重建。
   - 删除业务表 `sync_version` 假设。
   - 明确恢复后 manifest/data_version 如何发布。
   - 增加恢复后同步的集成测试。

### P1

6. 设计 ref_count 同步策略。
   - 不直接用 LWW 覆盖计数字段。
   - 删除应经过 tombstone 和延迟 GC。

7. 明确数据库记录与文件资产的一致性策略。
   - 同步结果需要能表达“数据已同步但文件失败”。
   - 下载方向也应考虑文件失败是否影响整体成功状态。

8. 为 `review_plans` 设计领域合并。
   - 间隔重复状态不能简单按整行覆盖。

9. 对 JSON 字段建立字段级策略。
   - 对设置类 key 可按 key 合并。
   - 对消息元数据、上下文快照等继续使用记录级策略也可以，但需要记录原因。

### P2

10. 增加覆盖表审计测试。
    - 测试每个声明为行级同步的表同时具备同步字段、触发器、回放主键策略。
    - 测试每个未同步表都有明确分类。

11. 增加复杂场景测试。
    - 同 hash 不同 ID 资源合并。
    - 同 question_id 不同 review_plan id。
    - ZIP 恢复后立即双向同步。
    - FTS/cache 变化不影响同步状态。
    - 文件同步失败时 UI 与后端返回一致。

## 已执行验证

已执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test sync_scenarios_tests
cargo test --manifest-path src-tauri/Cargo.toml --test sync_adversarial_tests
```

结果：

```text
60 passed; 0 failed
40 passed; 0 failed
```

这些测试覆盖当前同步模型内的事务、冲突表、tombstone、幂等回放、断层检测基础函数、时钟漂移、字段级合并缺口等。它们不能证明完整应用数据已经被同步覆盖。
