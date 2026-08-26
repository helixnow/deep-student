# VFS / 数据库迁移 / 数据治理恢复改造质量评审

对照 `v0.9.44` 与 `origin/cursor/0824-cde6 @ 2d41ea8b`，这次改造不是简单补字段：VFS 自定义属性已经形成从迁移、Repo、DSTU 到前端和搜索的完整闭环，迁移治理也比旧版更能处理历史脏状态；备份格式、覆盖账本和 A/B 候选槽校验同样有明显进步。

但“数据治理恢复”的执行层尚未达到它现在声明的强语义。当前代码一方面把备份定义为 full-fidelity、把切槽描述为原子恢复，另一方面会在候选槽完成验证前改写全局密钥，并且成功流程没有消费完清单声明的持久域。也就是说，备份格式的质量已经领先于恢复编排；这一部分不能仅凭清单验证和 A/B 切槽就判定为可发布。

## 改得好的地方

### `notes.props` 是一次质量较高的纵向改造

新迁移只增加 nullable `TEXT` 列，不回填历史行，避免了无意义的数据重写；数据库 `NULL`、Rust `None`、DSTU 边界 `{}` 的约定清楚，空对象写回又规范化为 SQL `NULL`，没有留下两套等价持久化表示。

写入路径也比旧版可靠。`VfsNoteMetadataUpdate` 将 title、tags、favorite、props 放进同一条 CAS `UPDATE`，所有校验先于写入，未知顶层字段直接拒绝，不再出现多次提交、后一步失败导致部分成功、或自定义字段被静默吞掉的问题。`props` 采用整对象 LWW 而不冒然做 JSON 深合并，也是正确取舍：任意键删除若没有 tombstone，所谓“自动合并”很容易把已删除属性复活。

搜索修复了旧版最实质的问题：标签、目录和属性过滤发生在最终 offset/limit 之前，而不是先截断候选再由前端过滤。Unicode 键、标量值和大小写无关匹配也已经贯通后端，功能闭环明显强于 v0.9.44。

### 迁移从“能跑”提升到了“能收敛历史中间态”

`pre_repair_vfs_schema` 先补齐旧 VFS 缺失的初始化表，再回放 change-log 契约，最后处理 `V20260824 notes.props`，顺序是合理的。对 `props` 同时覆盖“列已存在、history 缺失”和“history 已记录、列缺失”，比单纯依赖 Refinery 重跑更符合 SQLite 现场恢复需求。稀疏旧库重建 `notes` 时还会依据已记录版本恢复 `props` 契约，没有因为补旧表而把新 schema 降级。

迁移注册表、预期列验证、schema fingerprint 与 `migration-lock.json` 同步更新，也避免了“SQL 实际执行了，但静态 schema head 和验证器仍停在旧版本”的分叉。Mistakes 的 Anki 可空字段归一化只改 `NULL`/空串，不覆盖已有 `extra_fields_json`；LLM Usage 用 nullable `cache_write_tokens` 区分“未测量”和真实零值，这两处数据语义也处理得克制。

### 备份包的信任边界比旧版清楚

manifest v3 用持久域 registry 和 coverage ledger 区分“完整、空、缺失、排除”，并将 full snapshot 作为证据推导结果，而不是一个调用方随意设置的标签。未加密便携 ZIP 会剥离密钥、审计库等敏感域并降级为 partial；加密 ZIP 则把原始 manifest 与敏感文件密封，导入后再恢复原始完整语义。ZIP 路径、文件数、总大小、校验和覆盖以及未声明文件检查均比旧版严格。

恢复侧要求 DataSpaceManager 可用、写入前清空非活跃槽、预检目标卷空间、恢复后先迁移和验证候选库、重建同步基线，最后才登记 pending cutover。这些改动确实消除了旧版“先写半个 slotB，最后才发现无法切槽”的失败模式。

## 阻断性缺陷

### 1. 密钥在候选槽验证前改写全局应用目录，破坏了 A/B 原子边界

`commands_restore.rs:860-879` 在数据库恢复完成后立即执行：

```rust
manager.set_app_data_dir(inactive_dir.clone());
manager.restore_crypto_keys(&backup_subdir)
```

这并不会把密钥恢复到 inactive slot。`BackupManager::application_data_root`（`backup/mod.rs:2614-2627`）看到 `.../slots/slotB` 后会主动向上解析到应用根目录；`restore_crypto_keys` 最终替换的是该根目录下的 `.master_key` 和 `.secure`（`3747-3777`）。此后流程仍可能在资产恢复、VFS 派生索引校验、候选库迁移、同步基线重建、activation marker 或 `mark_restore_cutover_pending` 任一步失败。

函数内部的 rollback 临时目录只保证“本次密钥 rename 过程”失败时恢复旧目标；`.pre_restore/crypto` 虽然保存了旧密钥，但上述后续失败分支没有调用它回滚。因此完全可能得到：

- 恢复任务报告失败；
- 活跃槽仍是旧数据库；
- 全局密钥已经变成备份中的新密钥；
- 当前进程在重启前继续使用旧槽，却读取或写入另一代安全存储。

全局 backup permit 只串行化备份类任务，并不冻结正常业务读写，所以这不只是崩溃恢复问题，也存在运行中密钥代际混用窗口。

应把 crypto 先复制并验证到独立 staging，候选槽迁移、资产校验和同步基线全部通过后，再进入一个有持久化 journal 的 cutover 阶段。journal 至少要记录旧密钥快照、新密钥 staging、目标槽和 pending 状态，使启动时可以完成或回滚未完成事务。密钥发布、SecureStore/CryptoService 重载和 pending-slot 登记必须属于同一个可恢复状态机；仅靠函数内原子 rename 不等于整次恢复原子。

### 2. “完整快照”成功恢复时会静默漏掉清单中已声明完整的持久域

registry 将以下内容纳入 full snapshot：

- `audit`：`databases/audit.db`，ApplicationData scope；
- `webview-settings`：`persistent/webview_settings.json`；
- `custom-grading-modes`：`persistent/custom_grading_modes.json`；
- `user-skills` 等需要显式信任的域。

但主命令 `execute_restore_with_progress` 只显式恢复了核心数据库、workspace、普通 manifest 文件、crypto 和 assets。它没有调用已经存在的 `restore_audit_db_from_manifest`。同时：

- `restore_non_database_manifest_files` 会跳过所有 `.db`，所以 audit 不会经通用路径恢复；
- 同一函数会跳过整个 `persistent/`，所以 webview settings 与 custom grading modes 也不会恢复；
- user skills 要求显式信任是合理的，但当前恢复结果没有“待信任/已隔离”的可见终态，只是被跳过。

目标槽在恢复前已被清空，因此这不是“保留现值”，而是新槽中相应设置直接缺失。任务仍可以报告完整恢复成功，coverage ledger 由此只证明“包里有”，没有证明“恢复执行过”。这与 full-fidelity 和 required-components 的命名不符，也削弱了审计恢复的可信度。

恢复编排应直接消费 `DomainRestorePlan`，而不是继续按文件后缀和目录名写第二套分发规则。每个 `Complete` 域都必须得到明确终态：已恢复、按策略合并、隔离等待信任，或导致恢复失败；成功前还应断言不存在未消费的 complete domain。audit 是替换、合并还是保留本机链，需要明确产品策略，但不能静默遗漏。

### 3. 主恢复路径绕过了 manifest-aware crypto restore，可恢复未声明文件

代码已经提供 `restore_crypto_keys_from_manifest`：它会比较 crypto restore plan 与磁盘上的实际文件集合、大小和 SHA-256，再验证材料并恢复。但主命令调用的是较低层的 `restore_crypto_keys`。

前置 `verify_internal` 会校验 manifest 和 coverage 中列出的文件，却不会枚举并拒绝备份目录里额外出现的 `crypto/.secure/*.enc`；随后低层恢复函数会遍历 `.secure` 的实际目录并安装这些额外文件。ZIP 导入时“校验和覆盖所有归档文件”只能保护导入当刻，不能防止导入后或本地备份目录被追加文件。

这使不可信备份目录的“未声明文件不得生效”原则在最敏感的域失守。主流程应只调用 `restore_crypto_keys_from_manifest`，并在验证完成后固定恢复计划或使用不可变 staging，避免验证与执行读取不同的目录集合。

## 其余质量风险与优化空间

### 属性键的写入契约和搜索语法仍不一致

Rust 和属性编辑器允许除控制字符、保留字和长度超限外的任意键；搜索解析器却只接受 `[\p{L}\p{N}_][\p{L}\p{N}_-]*`。例如带空格、句点、emoji 或其他合法标点的键可以保存，却不能通过承诺的 `key:value` 语法检索。“任意键值属性”因此并不完全成立。

前端长度使用 JavaScript `string.length`，后端使用 Rust `chars().count()`，含代理对字符时两端上限也不同。另一个类型问题是后端允许 string/number/bool，但编辑器把已有 number/bool 转为字符串展示，编辑后会按字符串写回，造成无提示类型退化。

应先确定一种可查询的键语法，并在编辑器保存时执行同一规则；若确实要支持任意 Unicode 键，则搜索语法需要转义或引号键。字符计数、大小写归一和保留字最好由共享测试向量约束。标量类型则应二选一：前端保留类型并提供类型编辑，或把持久化契约明确收窄为字符串。

### 当前属性搜索保证了正确分页，但扩展性一般

有属性/标签/目录过滤时，`search_notes` 以 50～200 条分页扫描候选，在 Rust 中解析 props，并对命中项逐条读取正文生成 snippet。结果正确性比旧版好，但稀疏属性命中、大 offset 或大笔记库会退化为全量扫描和 N+1 查询；10,000 轮上限只是熔断，不是查询计划。

短期可批量读取正文并记录扫描量、轮数和耗时；若属性成为常用检索维度，宜维护规范化的 `note_props(note_id, key_norm, value_norm, value_type)` 投影表及索引，让属性交集、排序和分页在 SQL 中一次完成，而不是给 JSON 任意路径堆临时表达式索引。

### coordinator 的兼容修复正在形成第二套迁移系统

本次专项 pre-repair 有必要且实现正确，但 coordinator 已同时承担补表、补列、补索引、改 history、修 checksum 和重放部分 SQL。随着版本增加，修复顺序本身会成为隐含迁移图；`set_abort_divergent(false)` 又使正确性更依赖这些补偿逻辑、lock 和 fingerprint 的组合。

建议把每个修复收敛为带版本、前置条件、事实检查和结果报告的声明式 repair step，并把“修改 schema”和“补 history”分开审计。这样可以对任意历史 fixture 输出实际执行过的 repair 列表，也能避免后续继续向一个长函数追加版本特例。

### 测试覆盖仍偏向局部成功路径

`test_v0944_vfs_upgrade_adds_nullable_note_props_without_touching_rows` 等用例直接调用 `run_refinery_migrations`，很好地覆盖了 ALTER/history 中间态，但没有证明完整启动路径中的 `verify_migrations`、schema fingerprint 和最终报告同样通过。应增加从 v0.9.44 fixture 直接运行完整 coordinator 初始化的测试，并覆盖稀疏表、已有 fingerprint、FTS/索引缺失的组合。

恢复更需要故障矩阵：密钥发布后分别在资产复制、VFS finalize、候选迁移、baseline、marker、maintenance、pending-state 注入失败，并验证“活跃槽、全局密钥、审计库、维护状态”要么全旧要么处于可恢复 journal 状态。当前最严重的密钥问题，正是单函数原子性测试无法发现的跨阶段缺陷。

## 结论

VFS `notes.props` 和迁移治理相对 v0.9.44 是实质性提升，设计选择大体正确；搜索性能和键契约可作为后续收口项。数据治理的备份格式与验证层也已经达到较高水平。

真正的发布风险集中在恢复编排：全局密钥提前生效、持久域未被完整消费、crypto 执行绕过 restore plan。这三项会让“失败不影响现有数据”“完整快照可完整恢复”“未声明文件不生效”三个核心承诺失真。修复前，不应把当前路径认定为原子、全保真的整槽恢复。
