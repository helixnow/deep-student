# Fable SOTA Review — 2026-06-11

> 依据 `docs/FABLE_SOTA_GOAL.md` 执行的全量审阅记录。
> 审阅者：Fable 5（Cursor Agent）。边审阅边记录，findings 随批次增量更新。
> 状态标记：`[进行中]` / `[已完成]` / `[待用户反馈]`

## 0. 审阅范围与方法

- 按 Batch A-H 顺序执行，P0 批次优先（A: 云同步、B: Chat V2、C: 移动端、E: 学习闭环）。
- 每个 finding 使用 FABLE_SOTA_GOAL.md §5.2 规定格式（Severity/Area/Files/Invariant/Evidence/Counterexample/...）。
- 当前未提交 diff 单独标记 `Current Diff Relevance`。
- 历史文档结论一律与当前代码重新核对，不当作事实。

## 0.1 当前工作区 diff 快照（2026-06-11）

未提交改动涉及：

- `src-tauri/src/data_governance/sync/mod.rs`：
  1. 新增 `looks_like_sync_test_fixture_table()`——生产代码内嵌测试表名单（`items|notes|weird|a|b|big`），命中且含 `id`+`updated_at` 列即跳过 apply 校验。**需要重点审查是否污染生产语义**。
  2. `apply_downloaded_changes` 排序逻辑改为 (dependency_rank, 原序位) 稳定排序。
- `src-tauri/tests/sync_*`：批量将“整批回滚”语义改为“单条隔离、批次继续”；W.43 LWW 相等时间戳语义从“覆盖”改为“保留先到”；scenario_58 改为“同一 state store 只消费一次 tombstone”。
- `src/api/dataGovernance.ts`（~188 行）、`src/utils/cloudStorageApi.ts`、`src/utils/debugLogger.ts`：前端 API 层改动，待审。
- `src-tauri/tests/anki_export_integration.rs`：测试在缺 `custom_anki_templates` 表时回退内置模板。
- `tests/vitest/data-governance/*`、`tests/ct/mocks/react-i18next.tsx`：前端测试期望更新。
- 未跟踪文件 `deep-student.db`（工作区根目录出现数据库文件，疑似测试产物，注意不要误提交）。

---

## Batch A: Cloud Sync SOTA Audit `[完成]`

### A.0 不变量清单（来自 cloud-sync-remediation-plan.md，与当前代码核对）

- INV-1 无静默丢失：变更要么被应用，要么显式进入检疫/冲突/错误且对用户可见。
- INV-2 收敛性：任意同步交错后所有 RowSync 表逐字节一致；单记录终态只取决于变更集合。
- INV-3 删除有效性：删除传播且不复活；同身份重建不被旧删除误杀。
- INV-4 时钟独立：墙钟仅作 LWW 偏好信号（带确定性 tie-break）。
- INV-5 失败诚实：部分失败以 success=false/warning 贯穿后端→事件→UI；游标在数据未安全落地前绝不推进。
- INV-6 传输契约：list 递归完整或显式 truncated；not-found 与错误区分；put 原子可见。
- INV-7 新设备可引导：快照引导 + 增量追赶，或明确错误。

已核对的当前实现状态（与历史文档对照）：

- ✅ P0-3/O1 已落地：`commands_sync.rs:2725-2737` 仅 success 且无 error_message 才 `emit_completed`；`SyncSettingsSection.tsx:227-254` 消费返回值并区分 success/warning/error。
- ✅ P0-4/O2 已落地：`secure_store.rs:467` 有 `ftp_password`；`CloudStorageSection.tsx` 保存/加载 ftpPassword。
- ✅ D5 检疫机制已落地：`__sync_quarantine` 表 + 逐条 SAVEPOINT + 暂时性/永久性分类 + `data_governance_list/retry/discard_quarantine` 命令 + `SyncQuarantinePanel.tsx`（挂载于 SyncTab.tsx:572）。
- ✅ D1 部分落地：v3 seq 连续消费 + 缺号仲裁（mod.rs:1665-1729）+ truncated 拒绝下载（mod.rs:1602-1606）+ `commit_download_progress` 在 apply 成功后才推进游标（commands_sync.rs:3276 之前 `?` 短路）。
- ✅ 多库 apply 失败会返回 Err（commands_backup.rs:503-514），游标不推进；检疫项随批次事务一起提交，游标照常推进（符合"已提交∪已检疫"规则）。

### A.1 Findings（第一轮：sync/mod.rs 应用层 + 当前 diff）

```text
[P0] 当前 diff 将 dataGovernance.ts 全部 invoke 参数改为 snake_case，与 Tauri 命令 camelCase 契约不符，恢复/备份/同步主链路将整体断裂
Area: 云同步/备份/恢复 前端 API 层
Files: src/api/dataGovernance.ts（未提交 diff，~188 行）; src-tauri/src/data_governance/commands_*.rs; tests/vitest/data-governance/dataGovernance.api-contract.test.ts
Invariant Violated: 跨层契约一致性（§4.3）；INV-5（失败诚实——错误形态为裸 IPC 错误而非业务错误）
Evidence:
  - 当前 diff 把 invoke 参数全部改为 snake_case（如 backup_id、cloud_config、keep_recent），并加了恒等函数 snakeArgs() 包装。
  - tauri-macros 2.5.4 默认 ArgumentCase::Camel（wrapper.rs:50,460-462），Rust 参数 backup_id 暴露给 JS 的键是 backupId；tauri 2.10.2 取参为 v.get(self.key) 精确匹配（ipc/command.rs:97），无 snake_case 回退。
  - 仓库内所有 data_governance 命令均为裸 #[tauri::command]，无 rename_all="snake_case"（已全量 grep 验证）。
Reproduction / Counterexample:
  1. 应用此 diff 后，用户在设置页点"从备份恢复"→ restoreBackup() 发送 { backup_id }。
  2. 后端期望键 backupId（必填 String）→ Tauri 返回 "invalid args `backupId` ... missing required key" → 恢复完全不可用。
  3. runSyncWithProgress() 发送 { cloud_config } → 后端 Option<CloudStorageConfig> 静默变 None → 报"未提供云存储配置"，用户明明已配置，被误导去反复检查配置。
  4. runBackup('incremental', baseVersion) → backup_type/base_version 全部静默 None → 后端默认执行 **full** 备份且不含 assets——用户请求增量备份却得到全量备份，无任何告警。
  5. checkDiskSpaceForRestore() 的 catch 把 IPC 错误吞掉并返回"空间足够"→ 错误被二次掩盖。
User Impact: 备份、恢复、验证、取消、审计日志清理、同步全链路不可用或静默走默认参数；部分路径（备份类型）是静默语义改变。
Current Diff Relevance: 完全由当前未提交 diff 引入。HEAD 上的 api-contract 测试已先写成 snake_case 期望（测试先错），此 diff 是"改实现迁就错误测试"，单测全绿但真实 IPC 断裂——mock invoke 的契约测试无法发现键名错误。
Affected User Journey: "备份恢复后继续使用"、"同步配置失败后从设置页恢复"两条 P0 旅程直接阻断。
Observability Gap: vitest mock 了 invoke，永远不会发现键名与后端不符；无任何 e2e 校验 IPC 参数绑定。
Why Existing Tests Miss It: 契约测试只断言"前端发了什么"，不断言"后端能否解析"；Rust 侧测试不经过 IPC 序列化层。
Minimal Fix Direction: 回退 dataGovernance.ts 的键名为 camelCase（或后端全部命令加 rename_all="snake_case"，二选一，必须同侧统一）；修正 api-contract 测试期望。推荐前者（改动面小且与全仓其他 API 文件一致）。
Suggested Test: 新增 Rust 集成测试用 tauri::test::mock_builder 实际 invoke 一条 data_governance 命令，断言 camelCase 键可绑定、snake_case 键报错；或在 CI 中用脚本对照 invoke 调用键与 Rust 签名生成的 camelCase 键集。
Confidence: 高（已读 tauri-macros 2.5.4 与 tauri 2.10.2 源码确认无回退匹配）。
```

```text
[P1] 生产代码内嵌测试表名单 looks_like_sync_test_fixture_table，绕过 RowSync 注册表白名单（M20/D11.6 防线倒退）
Area: 云同步 apply 白名单
Files: src-tauri/src/data_governance/sync/mod.rs:4007-4056（未提交 diff 新增）
Invariant Violated: D11.6 表白名单收紧（未注册表必须检疫）；测试代码与生产代码隔离原则
Evidence:
  - ensure_table_allowed_and_exists_for 中，新增的 looks_like_sync_test_fixture_table(conn, t) 调用**没有任何 cfg 门控**（上一行的 test_/_records/resource_notes 旁路有 #[cfg(test)]，新增的没有），表名 ∈ {items, notes, weird, a, b, big} 且含 id+updated_at 列即跳过注册表校验。
  - "notes" 是 vfs 库真实生产 RowSync 表（classification.rs:65）；其余名字（items/a/b/big/weird）是 sync_weird_tests/sync_scenarios_tests 的 fixture 表名。
  - 推断动机：src-tauri/tests/ 下的集成测试以非 cfg(test) 方式编译主 crate，旧的 #[cfg(test)] 旁路对它们不生效，于是直接在生产路径开洞。
Reproduction / Counterexample:
  1. 任意未来迁移在任何业务库新增名为 items 的表（含 id/updated_at——本仓库表几乎全部满足）。
  2. 恶意或损坏的云端 payload 声称 table_name="items"。
  3. 注册表校验被跳过 → 数据直接 UPSERT 进该表，绕过 RowSync 分类、conflict_policy、字段合并配置。
User Impact: 当前生产库无 items/a/b/big/weird 表时风险潜伏；但白名单防线被结构性削弱，"notes" 的库归属校验也被短路。
Current Diff Relevance: 由当前未提交 diff 引入。
Affected User Journey: 多设备同步（防恶意/损坏 payload 的防线）。
Observability Gap: 旁路命中时无任何日志；用户与开发者都不知道白名单被跳过。
Why Existing Tests Miss It: 它本身就是为让测试通过而加的；没有测试断言"生产构建下 items 表会被拒绝"。
Minimal Fix Direction: 删除该函数；为集成测试提供显式注入口（如 SyncManager::set_test_classification_override 仅在 #[cfg(any(test, feature="sync-test-fixtures"))] 下编译，integration tests 启用该 feature），或直接把 fixture 表名注册进 classification registry 的 test-only 段。
Suggested Test: Rust 集成测试（默认 feature）：构造 table_name="items" 的变更 → 断言 failure_count=1 且进入 __sync_quarantine。
Confidence: 高。
```

```text
[P1] LWW 相等时间戳 tie-break 本地侧恒用 "local-unknown" 字面量，跨设备不构成全序 → 同秒并发写永久分叉（INV-2 违例）
Area: 云同步 LWW 比较器
Files: src-tauri/src/data_governance/sync/mod.rs:3239-3301（canonical_lww_key/compare_lww_timestamps/lww_device_id_from_data）, 6108-6176（should_skip_stale_update）, 5907-5960（DELETE LWW 门）; conflict_resolver.rs:305-321, 381-398; commands_backup.rs:274-293
Invariant Violated: INV-2（收敛性）、INV-4（确定性 tie-break）
Evidence:
  - canonical_lww_key 的比较键为 (millis, counter, device_id, content)。
  - 所有 5 个判定点的本地侧 device_id 都来自 lww_device_id_from_data(&local_data, "local-unknown")——业务表行没有 device_id 列，所以**本地侧永远是常量 "local-unknown"**，而云端侧是真实 source_device_id。
  - 两台设备比较的不是同一对键：A 比较 ("local-unknown" vs B_id)，B 比较 ("local-unknown" vs A_id)，不构成全局全序。
Reproduction / Counterexample:
  1. 设备 A（device_id "alpha-xxxx"）与设备 B（"beta-xxxx"）在同一秒各自编辑同一条 note（触发器 datetime('now') 秒级精度，同秒碰撞常见）。
  2. 双方上传后各自下载对方变更，此时双方该记录的 __change_log 已标记已上传（sync_version≠0）→ conflict_resolver 的"本地有未同步修改"前置不成立 → 不走冲突留痕，直接走 should_skip_stale_update。
  3. A 比较 "local-unknown"('l') > "beta-xxxx"('b') → 本地胜 → 保留 A 值；B 比较 "local-unknown" > "alpha-xxxx" → 本地胜 → 保留 B 值。
  4. 终态：A 显示 A 值，B 显示 B 值，永久分叉，无冲突记录、无检疫、无告警。
  5. 若设备名首字母 > 'l'（如 "mac-…"/"win-…"），则双方都判云端胜 → 互换值，同样分叉。
User Impact: 多设备活跃用户的同秒并发编辑静默分叉；用户以为已同步（completed toast 真实弹出）。
Current Diff Relevance: 非 diff 引入，但当前 diff 的 W.43 测试（"相等时间戳保留先到"）恰好把这个不对称行为固化为预期——测试通过的原因是 'l'(local-unknown) > 'c'(cloud-unknown)，属于"碰巧通过"。
Affected User Journey: 多设备同步、冲突、恢复。
Observability Gap: 双方都打 debug 级 "LWW skip" 日志，无 INFO/告警；checksum 漂移检测（M16 已知伪阴性）大概率发现不了单行分叉。
Why Existing Tests Miss It: 测试都在单连接/单进程内模拟，本地侧/云端侧 fallback 常量恰好稳定；没有"双设备对称交换"收敛断言（计划中的 sync_convergence_tests.rs 未建）。
Minimal Fix Direction: 给 should_skip_stale_update/DELETE 门/resolve_one/should_apply_change_by_strategy 传入本机真实 device_id（SyncManager 持有，commands 侧有 get_device_id()），本地侧键用 (updated_at, 本机 device_id)；内容兜底比较改为 canonicalize 后的稳定串。
Suggested Test: sync_convergence_tests.rs：双 SyncManager 不同 device_id、同秒同记录不同值、双向交换应用后断言两库该行逐字节一致（任意 device_id 字典序组合 proptest）。
Confidence: 高（代码路径确认；触发概率取决于同秒并发频率）。
```

```text
[P1] 同记录 DELETE→重建 的批内顺序仍被 rank 重排（M6 只修了一半），时间戳不可解析时终态错误
Area: 云同步 apply 排序
Files: src-tauri/src/data_governance/sync/mod.rs:4743-4791（ordered_changes_for_apply/apply_dependency_rank，当前 diff 修改处）
Invariant Violated: INV-2；remediation plan P3-3 "同 (table, record_id) 的多条变更严格按源顺序"
Evidence:
  - 旧实现对同 (table, record_id) 比较原始下标（保序），但该比较器不满足全序（同记录按下标、跨记录按 rank，可构造 A2<B<A1 且 A1<A2 的环），Rust 1.81+ 的 sort_by 检测到非全序会 panic——当前 diff 改为 (rank, 原序位) 稳定排序，**修复了潜在 panic**（好事，应记录）。
  - 但新键里 DELETE rank=1000-insert_rank（恒排批尾），同一记录"DELETE(t1)→重建INSERT(t2)"会被重排为 INSERT 先、DELETE 后；终态正确性完全依赖 DELETE 的 LWW 门（apply_single_change_inner:5910-5960）拿 t2>t1 拦住删除。
  - LWW 门前置条件：change.changed_at 可被 lww_timestamp_millis 解析、表有 deleted_at 列（has_tombstone，5912 行 `!skip_lww && has_tombstone`）、表有 updated_at 列、本地行可读。任一不满足（如 legacy 变更 changed_at 为空串/坏格式，或表无墓碑列），DELETE 直接执行 → 重建被错误删除。
  - 具体例证：answer_submissions（V20260210 建表）既无 deleted_at 也无 updated_at，却注册为 RowSync（classification.rs:165）——对该表 LWW 门恒不生效，硬 DELETE 恒排批尾恒执行（同 id 重建场景因 nanoid 新鲜 id 而罕见，但契约上无保护）。
Reproduction / Counterexample:
  1. 设备 A 删除 note X（产生 DELETE，changed_at 格式损坏或为空——legacy v1 变更常见），随后重建同 id note X。
  2. 两条变更进同一下载批；排序后 INSERT 先应用、DELETE 后应用。
  3. DELETE 的 LWW 门因 changed_at 不可解析而不生效 → 软删执行 → 终态 X 被删，但源顺序终态应为"存在"。
User Impact: 删除→重建场景下记录复消失；用户重建的内容丢失。
Current Diff Relevance: 当前 diff 修复了 panic 风险但显式删除了同记录保序分支；语义回归到依赖 LWW 门兜底。
Affected User Journey: 删除资料后重新导入/重建，再多设备同步。
Observability Gap: DELETE 应用只有 debug 日志；无"批内同记录乱序"告警。
Why Existing Tests Miss It: W.45/scenario 类测试的 changed_at 都是合法 RFC3339，LWW 门恰好兜住；没有坏时间戳 + 删除重建组合用例。
Minimal Fix Direction: 排序键改为 (rank, 同记录组内源序保持)：对同 (table,record_id) 的变更组先取组内最小源位作为组键排序，组内按源顺序展开；或按 plan 原文"依赖 rank 仅在不同记录间生效"。
Suggested Test: sync_weird_tests 新增：同批 [DELETE(t_bad), INSERT(t_bad)]（changed_at 不可解析）断言终态存在；以及 [INSERT, DELETE] 断言终态删除。
Confidence: 高（路径确认；触发需 legacy/损坏时间戳）。
```

```text
[P2] 未知错误默认按"永久性"进检疫，与 plan 的保守化方向相反（误检疫风险）
Area: 云同步 错误分类
Files: src-tauri/src/data_governance/sync/mod.rs:4817-4834（is_transient_apply_error）
Invariant Violated: remediation plan §8 风险缓解："仅白名单错误类型入检疫，未知错误一律按暂时性整批重试"
Evidence: is_transient_apply_error 用字符串白名单匹配暂时性错误（database is locked/busy/disk i/o/full/oom），其余 SyncError::Database 一律视为永久性 → 检疫。SQLite 错误文案变化（版本/语言/包装层）或新错误类型会被误判永久性。
Reproduction / Counterexample: rusqlite 返回 "attempt to write a readonly database"（临时性：文件权限瞬态/卷只读重挂载）→ 被当永久性检疫 → 该条变更不再自动重试，需用户手动进隔离区面板。
User Impact: 本可自动恢复的变更滞留隔离区；用户需手动干预（好在可见可重试，非静默丢失，故 P2）。
Current Diff Relevance: 非 diff 引入。
Affected User Journey: 弱网/低端设备同步。
Observability Gap: 隔离区面板可见（缓解）；但无"误检疫率"观测。
Why Existing Tests Miss It: 测试只注入了明确的永久性错误。
Minimal Fix Direction: 倒转默认：永久性错误用白名单（payload 结构错误/主键不一致/未注册表/FK 新增违规/别名环），其余默认暂时性整批重试；或对 rusqlite::Error 按 ErrorCode 而非文案分类。
Suggested Test: 注入 readonly/unknown 错误断言整批回滚且游标不动。
Confidence: 高。
```

```text
[P2] 隔离区重试/丢弃命令不取 BACKUP_GLOBAL_LIMITER、不查维护模式（与 O3 同型）
Area: 数据治理命令
Files: src-tauri/src/data_governance/commands_sync.rs:3719-3815
Invariant Violated: 全局互斥约定（备份/恢复/导入期间不得并发写业务库）
Evidence: data_governance_retry_quarantine 直接 open_sync_connection + apply_downloaded_changes 写业务表，无 check_maintenance_mode、无 BACKUP_GLOBAL_LIMITER；恢复进行中用户仍可在隔离区面板点"重试"并发写库。
Reproduction / Counterexample: 恢复任务运行中（维护模式开启），用户在 SyncQuarantinePanel 点重试 → 与 restore 的数据库替换并发写 → 可能写进即将被替换的库或替换后的新库（取决于时序），结果不可预测。
User Impact: 边界时序下隔离重试结果丢失或写错库。
Current Diff Relevance: 非 diff 引入。
Affected User Journey: 备份恢复后处理隔离项。
Observability Gap: 无审计日志记录 retry/discard 操作（list/cleanup 等命令均有 audit log，此处没有）。
Minimal Fix Direction: 复用 commands 中 maintenance-mode + limiter 模式（同 import 的 P0-5 修复）；retry/discard 写一条 AuditLog。
Suggested Test: 维护模式开启时 retry_quarantine 应返回明确错误。
Confidence: 高。
```

```text
[P3] 后端硬编码 UI 文案语言不一致："Open Settings" 混在中文文案中（error_details.rs）
Area: 错误反馈 i18n
Files: src-tauri/src/error_details.rs:122 vs 137/143/158/...; src-tauri/tests/error_details_tests.rs（当前 diff 把断言从"前往设置"改为"Open Settings"）
Invariant Violated: §3 P1 i18n——en-US/zh-CN 同步补齐，后端不应输出硬编码 UI 语言
Evidence: 同一 suggestions 数组里 label 一个英文其余中文；当前 diff 修改测试以匹配实现而非修正不一致。
User Impact: 错误对话框中英文混排（中文用户看到 "Open Settings"+“检查API密钥”）。
Current Diff Relevance: 测试改动属当前 diff；生产不一致先于 diff 存在。
Minimal Fix Direction: error_details 返回 action_type/i18n key，前端用 locales 渲染；短期内统一语言。
Confidence: 高。
```

### A.1 补充观察（非 finding）

- `deep-student.db` 出现在仓库根目录（未跟踪）。`anki_export_integration.rs` 直接 `Connection::open("../deep-student.db")`——集成测试在仓库根创建/读取真实库文件，存在被误提交风险（.gitignore 需确认覆盖）+ 测试间共享可变状态。当前 diff 为它加了"表不存在则用内置模板"回退，说明此测试依赖工作区残留状态，本质是测试设计问题。
- `scenario_58_shared_state_consumes_tombstone_once`（当前 diff 改名）：测试承认同进程多 SyncManager 共享 SyncStateStore 时 tombstone 只消费一次。该测试不再覆盖"三设备墓碑传播"语义，真实多设备收敛断言出现缺口（原 scenario_58 的覆盖意图丢失）——建议补一个用独立 app data dir 的真三设备用例。

### A.2 Findings（第二轮：cloud_storage 三后端传输契约 / 墓碑 / restore 设备轮换）

先记录已核实为正确落地的部分（避免重复审）：

- ✅ F1/F4：FTP `list` 已递归（目录栈 + MLSD 优先、LIST 回退，ftp.rs:656-715）；not-found 与错误已区分（`is_not_found_error`）。
- ✅ F3：FTP put 走 `upload_reader_atomic`（临时名+rename）；WebDAV/S3 put 语义由服务端保证。
- ✅ F7/F9：WebDAV `list_outcome` 显式 truncated（750 条目上限 / MAX_DIRS=200，webdav.rs:679-763）；PROPFIND 请求 resourcetype。
- ✅ P0-6/F10：S3 显式 connect 30s + operation_attempt 120s 超时（s3.rs:52-60）；list 用 continuation_token 分页（s3.rs:433-482）。
- ✅ T5/T7：墓碑按方向参数决定是否删云端；per-source watermark 过滤+推进（tombstone.rs:387-441；mod.rs:8489-8496 仅在 apply 成功后推进）。
- ✅ C9：`prune_old_changes` 只删本设备文件、要求快照覆盖全部 RowSync 库 + 活跃消费者游标下界、truncated 时拒绝 prune（mod.rs:2471-2578）。
- ✅ C3：restore 后 `reset_sync_baseline_after_restore`（清 change_log、提升 sync_version）+ `rotate_device_id_after_restore` + `record_device_rotation` 重置消费游标/墓碑水位/legacy key（state.rs:370-399）——游标过期问题被轮换正确覆盖。
- ✅ 实例绑定（F12）：`instance_binding_hint` 三后端均实现；`bind_instance` 不匹配时拒绝同步（state.rs:98-132）。
- ✅ 墓碑列表被截断时拒绝推进（tombstone.rs:255-276），快照列表截断拒绝引导（mod.rs:2276-2283）。

```text
[P1] WebDAV 客户端无读/总超时 + 同步全程持有全局锁且无取消命令：单个停滞 TCP 连接冻结整个数据治理子系统直至重启
Area: 云同步 传输层稳健性
Files: src-tauri/src/cloud_storage/webdav.rs:57-61; src-tauri/src/data_governance/commands_sync.rs:2508-2529; src-tauri/Cargo.toml:74（reqwest 0.11）
Invariant Violated: remediation plan P1-2/F8（动态超时）；INV-5（失败诚实——挂起不是失败也不是成功，用户无任何出路）
Evidence:
  - reqwest Client 仅设 connect_timeout(30s)，无 .timeout()（总超时）；reqwest 0.11 无 read_timeout API。旧版 300s 总超时（会杀大文件传输）被移除后未补任何替代。
  - run_sync_with_progress 在整个同步期间持有 BACKUP_GLOBAL_LIMITER permit；commands_sync.rs 全文无 cancel 命令。
  - FTP 侧同样未发现 read timeout 设置（ftp.rs:71-101 create_client 无超时配置，suppaftp 默认无限等待）。
Reproduction / Counterexample:
  1. WebDAV 服务器在 GET 响应中途停止发送（NAT 空闲超时、服务器假死、移动网络切换——坚果云用户挂梯子时常见）。
  2. res.bytes().await 永久挂起 → 同步 future 不完成 → permit 永不释放。
  3. 用户看到进度条永久停滞；点"立即备份"→"等待全局数据治理锁超时（30秒）"；唯一出路是杀进程。
User Impact: 弱网用户同步卡死且连带备份/恢复全部不可用；无取消按钮、无超时自愈。
Current Diff Relevance: 非 diff 引入。
Affected User Journey: "断网环境同步失败可恢复"P0 旅程——当前不是失败而是永久挂起，比失败更糟。
Observability Gap: 挂起期间无任何事件发出；前端 SyncProgressIndicator 停在中间态，无 watchdog。
Why Existing Tests Miss It: 测试后端都是内存/本地 mock，从不模拟"连接建立后停滞"。
Minimal Fix Direction: ① 升级 reqwest 0.12 并设 read_timeout(60s)（workspace 已有 0.12.28 传递依赖，迁移成本低）；或对每个请求包 tokio::time::timeout（按 size 动态计算）。② FTP 同样包 timeout。③ 增加 data_governance_cancel_sync 命令 + 前端取消按钮（CancellationToken 在 await 点检查）。
Suggested Test: mock 一个 accept-then-stall 的 TcpListener 作为 WebDAV endpoint，断言同步在 N 秒内返回 Err 而非挂起。
Confidence: 高（代码确认无超时；挂起即锁死由 limiter 结构决定）。
```

```text
[P1] Blob 墓碑应用不检查本地 DB 引用：跨设备仍被引用的去重 blob 被物理删除，且云端副本同时被删 → 不可恢复丢失
Area: 云同步 墓碑/Blob
Files: src-tauri/src/data_governance/sync/mod.rs:8437-8467（仅查云清单）; sync/tombstone.rs:735-764（仅查文件 mtime）; src-tauri/src/vfs/repos/blob_repo.rs:92-95（去重命中不刷新 mtime）; mod.rs:7774-7791（上传按目录扫描，文件没了就不会再上传）
Invariant Violated: INV-1（无静默丢失）、INV-3（"同身份重建不被旧删除误杀"的镜像case：他端从未删除且仍引用）
Evidence:
  - apply_blob_tombstones 的保护仅两层：云清单 entry.updated_at > deleted_at（mod.rs:8439-8459）、本地文件 mtime > deleted_at（tombstone.rs:749-759）。两层都不查 vfs.db 的 blobs.ref_count / files 引用行。
  - blob 按内容哈希全局去重：两台设备各自导入同一份 PDF 得到同一 hash；一台删除时 ref_count→0 产生墓碑，但它无法知道另一台是否还有自己的引用行。
  - store_blob_with_conn 去重命中（文件已存在且 size 相同）时 should_write=false，不刷新 mtime → "重导入时文件已在"场景 mtime 兜底失效。
  - blob 上传清单来自 scan_blobs_dir（目录扫描非 DB），文件被删后 B 永不重传；云端副本已被 A 的墓碑删除 → 双侧皆失。
Reproduction / Counterexample:
  1. 设备 A 导入 doc.pdf（hash H）并同步；设备 B 同步获得 H（本地文件 mtime=下载时刻 T0）。
  2. B 在另一个笔记本里再次引用同一份 doc.pdf（去重命中 H，新增一行 files 引用；mtime 不变）。B 的这行尚未上传或已上传均可。
  3. A 删除自己的 doc.pdf 条目 → A 端 ref_count→0 → 物理删除 + 墓碑 H@T1（T1>T0）→ A 同步（云端 blob 文件与清单条目同时被摘除）。
  4. B 同步：row 层收到 A 的 files 行删除（只删 A 那行，B 自己的引用行还在）；blob 墓碑 H@T1 应用——云清单已无 H（keep=true）、本地 mtime T0<T1（不跳过）→ B 本地 H 文件被物理删除。
  5. 终态：B 的 files 行指向不存在的 blob → 打开报"文件不存在"；云端无副本可重拉 → 永久丢失。全程无冲突、无检疫，仅 info 日志。
User Impact: 多设备 + 去重场景下，一台设备的删除可静默摧毁另一台仍在使用的附件。
Current Diff Relevance: 非 diff 引入。
Affected User Journey: 多设备资料管理（P0：附件/文档跨设备一致性）。
Observability Gap: 删除仅 tracing::info；B 端用户首次发现是在打开文件失败时，且无法归因。
Why Existing Tests Miss It: 墓碑测试均为单设备视角 + 文件系统断言，无 "B 仍有 DB 引用" 的跨库断言。
Minimal Fix Direction: 应用 blob 墓碑前查 vfs.db：`SELECT ref_count FROM blobs WHERE hash=?`（或 files 引用计数）>0 则跳过删除、保留文件，并视本地为"复活"——下轮上传把 H 重新写回云清单（scan_blobs_dir 已会这么做，只要文件不被删）。同时 store_blob 去重命中时 touch 文件 mtime（一行 filetime 调用）补齐第二层兜底。
Suggested Test: Rust 集成测试：B 库中保留一行 files 引用 H + 本地 H 文件 mtime < deleted_at + 云清单无 H → 应用墓碑后断言文件仍存在且下轮上传重新发布 H。
Confidence: 高（三处代码相互印证；触发需要跨设备去重引用，真实用户可达）。
```

```text
[P2] FTP LIST 解析失败的条目被静默丢弃，但 list_outcome 仍声称 complete（INV-6 违例）；S3 截断+无 token 时死循环
Area: 云同步 传输层 list 契约
Files: src-tauri/src/cloud_storage/ftp.rs:686-690; src-tauri/src/cloud_storage/s3.rs:477-481
Invariant Violated: INV-6（list 递归完整或显式 truncated，禁止静默部分列表）
Evidence:
  - FTP：parse_list_entry 失败 → warn 日志 + continue（条目从结果中消失）；FtpStorage 不覆写 list_outcome → 默认包装为 truncated=false 的"完整"结果。MLSD 不可用而回退 LIST 时，非标准格式（如 DOS 风格、本地化月份名）整目录条目可能全部解析失败。
  - S3：is_truncated=true 但 next_continuation_token=None 时（非 AWS 兼容实现的已知行为差异），continuation_token 置 None → 下轮从头再列 → 无限循环 + files 重复累积，内存持续增长，同步永久挂起（叠加上一条全局锁问题）。
Reproduction / Counterexample:
  1. FTP：某国产 NAS 仅支持 LIST 且输出 DOS 格式 → 全部条目解析失败 → 返回空列表 complete → 下载侧把"看不见的 change 文件"当作不存在 → 缺号仲裁误判对端设备异常（或 published_max_seq 与文件不符触发拒绝）；prune 侧 list 为空则 safe_seq=0 不删（侥幸安全）。
  2. S3：MinIO 老版本 / 某些 OSS 网关在 prefix 含特殊字符时返回 truncated 无 token → 同步线程死循环。
User Impact: FTP 用户同步结果不可信或被错误仲裁；S3 边缘实现用户同步挂死。
Current Diff Relevance: 非 diff 引入。
Observability Gap: FTP 仅 warn 日志；S3 死循环无任何输出。
Why Existing Tests Miss It: ftp.rs 内嵌测试只测正常格式解析；S3 无分页异常用例。
Minimal Fix Direction: FTP：解析失败时整个 list 调用返回 Err（或 ListOutcome{truncated:true}），并让 FtpStorage 覆写 list_outcome 透传该信号；S3：is_truncated 且无 token 时 break + 返回 Err 或 truncated=true。
Suggested Test: ftp parse 失败注入 → 断言 list_outcome.truncated 或 Err；s3 mock 返回 truncated 无 token → 断言有限时间内返回错误。
Confidence: 高（FTP 路径确认；S3 触发依赖第三方实现行为，但防御成本极低）。
```

```text
[P2] 恢复后"同步基线重建/设备轮换"失败仅写日志，恢复结果仍报成功——下一次同步可能"恢复即覆盖"或静默跳过他端变更（INV-5 违例）
Area: 数据治理 恢复→同步衔接
Files: src-tauri/src/data_governance/commands_restore.rs:698-703（基线重建失败 warn）、716-738（轮换失败 warn）
Invariant Violated: INV-5（部分失败必须贯穿到 UI）；代码注释自述风险："下次同步可能覆盖云端"
Evidence:
  - reset_sync_baseline_after_restore 失败 → warn! → baseline_reset_details 不含该库 → 恢复响应无 warnings 字段记录此事。
  - rotate_device_id_after_restore 失败 → 旧 device_id + 旧 consume_cursor 继续生效：恢复回退到 T_backup 的数据，但游标已消费到 T_now → (T_backup, T_now] 区间他端变更永不重放 → 静默发散；同时 __change_log 若未被清空，恢复出的旧整库可能被当作新变更整体上传。
  - 对照：插槽切换失败有 switch_warning 进响应（741-757），同样严重的前两者却没有。
Reproduction / Counterexample: 恢复到只读残留/被占用的 sync_state.db（Windows 文件锁、磁盘满）→ 轮换写 .device_id 失败 → 恢复报成功 → 用户重启后正常同步 → 云端较新数据被旧基线覆盖或本地缺失他端区间变更。
User Impact: 恢复后第一次同步可能破坏云端或本地静默缺数据，用户无任何提示。
Current Diff Relevance: 非 diff 引入。
Minimal Fix Direction: 两处失败时：① 写入恢复响应 warnings（复用 switch_warning 通道）；② 设置"同步暂挂"标志（如 sync_state 写 pending_baseline_repair），下次同步启动时检测到则拒绝增量同步并提示用户重试基线重建。
Suggested Test: 注入 sync_state.db 打开失败 → 断言恢复响应含 warning 且后续 run_sync 被拒绝。
Confidence: 高。
```

```text
[P3] CloudStorage 默认 get_file 非原子写盘、默认 put_file 大文件全量驻留内存——契约脚枪（生产后端均已覆写，暂未触发）
Area: 云同步 传输层默认实现
Files: src-tauri/src/cloud_storage/traits.rs:159-235（put_file 默认）、247-311（get_file 默认，File::create 直写目标路径无 temp+rename）
Invariant Violated: F13/F14 的修复仅落在三个生产后端覆写里，trait 默认实现仍保留旧缺陷；新增后端（如未来 SMB/本地目录）若不覆写即继承缺陷。
Evidence: get_file 默认直接 File::create(local_path) 写最终路径，中断留半截文件；put_file 默认把 ≥100MB 文件整个读进 Vec。WebDAV(480/552)、FTP(795/857)、S3(138/293) 均已覆写，默认实现当前仅被测试 mock 使用。
Minimal Fix Direction: 默认实现改为 temp+rename + 流式（或直接 unimplemented 强制后端实现），并在 trait 文档注明原子性契约。
Confidence: 高（影响面为未来扩展）。
```

---

### A.3 当前 diff 二轮复核（工作区在审阅期间持续演进，~116 文件）

**已核实的正面修复**（均为当前 diff/今日提交带入，方向正确）：

- ✅ S3 兼容性：`request_checksum_calculation(WhenRequired)`，修复腾讯云 COS/阿里 OSS/MinIO 对 CRC32 头报错（s3.rs:58-67）。注意：S3 list 截断死循环（A.2）仍未修。
- ✅ qbank 判分 SSE：finish_reason 兜底 + 残留 buffer flush + 单元测试（pipeline.rs #56）——修复"网关不发 [DONE] 导致完整结果被丢弃"。
- ✅ MCP ProtocolVersion 枚举顺序修复：原先 V2025_06_18 在 Ord 上小于 V2024_11_05，版本协商比较反向（protocol_version.rs）。
- ✅ pdfstream_check_access 新命令：探测规则与协议处理器完全一致，消除"探测成功、加载 403"（commands.rs #59）。
- ✅ EPUB 解析回归测试三连（document_parser.rs #58）；gemini 合成 functionCall 降级文本（防 Gemini 3 拒绝）；helpers.rs 移除 `unwrap_or_default()` 吞错的死函数。

**新增 Findings**：

```text
[P2] qbank 判分 #56 的权衡引入新静默失败：parse（解析）模式下流 Incomplete 但已有文本时，截断的解析文本被原样持久化为 questions.ai_feedback，完成事件照发，用户看到半截解析且无任何标记
Area: 题库 AI 判分/解析 管道
Files: src-tauri/src/qbank_grading/pipeline.rs:154-169（Incomplete 仅在空文本时报错）; 216-228（accumulated 直写 ai_feedback）
Invariant Violated: INV-5（失败诚实）；目标文档 §G "AI 生成失败一半，用户能否区分"
Evidence: 注释自述"grade 模式仍由下方 verdict 校验兜底"——parse 模式无任何兜底：verdict/score 跳过校验，SAVEPOINT 持久化截断文本，emit 完成。
Reproduction: 解析模式下网络中断于 60% → accumulated 非空、无 finish_reason → warn 日志 + 半截解析存库 → 用户下次打开该题看到戛然而止的解析，无重试提示。
User Impact: 截断解析被当成正式结果缓存（ai_graded_at 已盖章），用户难以发现缺失，重新生成入口不明显。
Current Diff Relevance: 当前 diff 引入（旧行为是整段丢弃+报错，同样不理想但诚实）。
Minimal Fix Direction: Incomplete 时仍持久化但在 emit 时发 warning 事件（前端 toast"解析可能不完整，建议重试"），或 ai_feedback 落库时附加截断标记字段；最小改法：parse 模式 Incomplete 时也走 emit_error 但携带已渲染文本，让前端展示"部分结果+重试"。
Suggested Test: pipeline 单测：mock 流中断 → 断言 parse 模式返回带 incomplete 标记 / 不盖 ai_graded_at。
Confidence: 高。
```

```text
[P3] InputBarV2 思考深度标签硬编码中文（当前 diff 把硬编码英文改成硬编码中文），EN 界面回归
Area: i18n
Files: src/features/chat/components/input-bar/InputBarV2.tsx:82-105（THINKING_DEPTH_LABELS 常量，'低'/'中'/'高'/'超高'）
Evidence: 该常量不经 t()，en-US 用户的模型思考深度菜单将显示中文；同 diff 其他文案（recentSessions 等）都正确走了 locales。
Minimal Fix Direction: 迁入 chatV2.json（thinkingDepth.low/medium/high/...）双语言文件。
Confidence: 高。
```

## Batch B: Chat V2 前后端状态机 `[完成]`

### B.0 已核实的正确设计

- ✅ 会话级序列号：后端 per-session AtomicU64（events.rs:713-771），前端 eventBridge 去重 + 乱序缓冲 + gap 超时跳过（eventBridge.ts:329-530），缓冲满时 skipGapAndFlush 防卡死。
- ✅ 会话级事件（stream_complete/error/cancelled/reconnect）有双重陈旧过滤：`isTargetingCurrentStreamMessage` + `isStaleByExpectationTimestamp`（TauriAdapter.ts:1611-1723）——旧流的完成事件不会误杀新流。
- ✅ 并发发送防护：`try_register_stream` 在单锁内检查+注册（state.rs:226-249）。
- ✅ retryMessage 有完整快照回滚（messageActions.ts:989-1000）+ messageOperationLock finally 释放。
- ✅ LLM 流式有总超时（LLM_STREAM_TIMEOUT_SECS）+ 瞬时错误指数退避重试 + emit_stream_reconnect 用户可见（tool_loop.rs:676-779）。

### B.1 Findings

```text
[P2] 停止后立即重发：旧流水线的滞后块事件无消息级陈旧过滤，可在已完成消息上创建幽灵块，且可被 autosave 持久化
Area: Chat V2 事件桥接/取消语义
Files: src-tauri/src/chat_v2/state.rs:154-173（cancel_stream 立即移除 token，协作式取消有滞后窗口）; src/features/chat/core/middleware/eventBridge.ts:567-631（块事件无 messageId 陈旧检查）; TauriAdapter.ts:1629-1638（仅会话级事件有过滤）
Invariant Violated: 目标文档 §Chat V2 "停止→重试不互相破坏状态"；"幽灵 block"
Evidence:
  - chat_v2_cancel_stream → cancel_stream() 同步移除 active_streams 条目并触发 token；旧流水线任务继续运行到下一个 is_cancelled 检查点（工具执行中可达数秒）。
  - token 移除后 try_register_stream 立即放行新流 → 新旧两条流水线并发，共用同一 per-session 序列计数器 → 旧流滞后事件的 seq 与新流事件交错且单调，前端序列机制视其为合法新事件。
  - processEventInternal 按 event.messageId 路由（eventBridge.ts:583-584）；旧流的 start 事件携带旧 messageId → handler.onStart 在已完成的旧消息上新建块；resetBridgeState 清掉了 round 上下文，shouldDropEventByRound 失效（expectedRound undefined → 不丢弃）。
  - handleVariantStart/块创建后调用 autoSave.scheduleAutoSave（eventBridge.ts:682）→ 幽灵块可被写回后端，重载后仍在。
Reproduction / Counterexample:
  1. 发消息触发一个耗时工具（如联网搜索 5s）；工具执行中点"停止"。
  2. 停止返回后立刻再发一条新消息（UI 已允许）。
  3. 旧流水线工具完成 → emit tool_call end / 下一轮 content start（在 token 检查点之前）→ 前端在旧消息上新建/更新块。
  4. 旧消息出现一个无终态的幽灵工具块/空内容块；autosave 持久化后重载仍在。
User Impact: 已完成对话出现悬挂的"正在调用工具"块；用户无法解释也无法移除（无该块的删除入口时）。
Current Diff Relevance: 非 diff 引入。
Observability Gap: 前端仅 console 级日志；后端不知道事件被发往"已取消"流。
Why Existing Tests Miss It: eventBridge 测试只测序列号逻辑，不模拟"取消后滞后发射"；后端测试不跑真实双流水线竞争。
Minimal Fix Direction: ① 发射器层：emitter 持有 generation/stream_id，cancel 后旧 generation 事件直接丢弃（后端单点修复，最彻底）；或 ② 前端块事件也校验 event.messageId ∈ {currentStreamingMessageId, 当前变体消息}，旧消息块事件丢弃（注意不破坏 continue_message 场景）。
Suggested Test: 集成测试：注册流 A→cancel→立即注册流 B→A 的 emitter 再发 start/end → 断言前端 store 旧消息块数不变。
Confidence: 高（机制由代码结构保证；触发窗口取决于工具/LLM 当前 await 点）。
```

```text
[P2] 崩溃/强退后重载会话：running/pending 块原样恢复为"流式中"视觉，无任何归一化，且 sessionStatus=idle 导致无停止按钮——永久僵尸 spinner
Area: Chat V2 崩溃恢复
Files: src-tauri/src/chat_v2/handlers/load_session.rs:38-73（无状态修复）; src/features/chat/core/store/restoreActions.ts:582-601（running/pending 进 activeBlockIds，块状态不归一化）; MessageItem.tsx:1306-1308（pending/running 按流式渲染）
Invariant Violated: 目标文档 §Chat V2 "崩溃或强退后 block/tool status 能恢复到用户可理解的状态"
Evidence:
  - 后端流式中通过 persistence 写入块 status=running/pending；崩溃后 DB 残留该状态。
  - load_session 原样返回；restoreActions 把这些块加入 activeBlockIds 且保留原 status，但 sessionStatus 设为 'idle'、currentStreamingMessageId=null。
  - UI 把 pending/running 块按流式渲染（spinner/光标）；因 sessionStatus=idle，停止按钮不出现；无超时降级。
Reproduction / Counterexample:
  1. 流式输出/工具执行中强杀应用（或系统崩溃）。
  2. 重启进入该会话：最后一条助手消息的工具块永远转圈，"思考中"块永远闪烁。
  3. 用户无从停止/重试（消息级重试入口可用，但用户不知道这是"死"状态而非"慢"）。
User Impact: 用户误以为任务还在跑而等待；或不敢操作怕打断；信任感受损。
Current Diff Relevance: 非 diff 引入。
Minimal Fix Direction: 恢复路径归一化：load_session（后端）或 restoreActions（前端）把非活跃流的 running/pending 块改为 interrupted/error（保留内容，标记"已中断，可重试"）。后端修复更优：同时修正持久层数据。可加条件：仅当 has_active_stream(session_id)=false 时归一化（避免误伤 F5 重载时仍在跑的流）。
Suggested Test: vitest：恢复含 running 块的会话 + 无活跃流 → 断言块状态为 interrupted 且不在 activeBlockIds。
Confidence: 高。
```

```text
[P3] 发送失败的回滚不完整：空助手占位消息与用户消息残留，无终态错误标记
Area: Chat V2 乐观更新回滚
Files: src/features/chat/adapters/TauriAdapter.ts:2037-2051（catch 仅 abortStream + 通知）; messageActions.ts:1009-1077（abortStream 只处理 activeBlockIds，不移除空占位消息）
Evidence: sendMessageWithIds 先落 user+assistant 占位（乐观），invoke 失败（如另一流活跃被 try_register_stream 拒绝、参数校验失败）→ catch 调 abortStream：没有块可标记，占位助手消息（0 块）留在 messageOrder。用户看到一条空的助手气泡，无错误标记；用户消息保留尚算合理（便于重试），但空助手气泡是纯垃圾状态。
User Impact: 偶发发送失败后对话里多一个空气泡；多次失败累积多个。
Minimal Fix Direction: catch 中若助手占位消息块数为 0 → 从 messageMap/messageOrder 移除；或标记 terminalError 显示"发送失败，点击重试"。
Confidence: 高。
```

### B.2 备忘（轻微/未深挖，不计 finding）

- SESSION_SEQUENCE_COUNTERS 仅在删除会话时清理（manage_session.rs:631），长生命周期内存缓增；变体子 token 以 `session:variant` 键注册后由变体收尾移除，主键 remove_stream 不清它们，若变体异常退出可能残留条目（量级小）。
- 错误重试白名单 is_retryable_llm_error 用字符串匹配（tool_loop.rs:661-674），同 Batch A 的错误分类问题同型，provider 文案变化会漏判，但此处方向保守（漏判→不重试→用户可手动重试），可接受。

## Batch C: 移动端交互与 UX `[完成]`

### C.0 已核实的正确设计

- ✅ z-index 统一注册表（zIndex.ts）层级语义清晰；MobileBottomSheet/toast/modal/contextMenu 分档合理。
- ✅ MobileSlidingLayout 轴锁定（1.2 倍比率）+ 垂直滑动让位原生滚动 + visibilitychange/contextmenu 兜底结束拖拽 + 拖拽中 baseTranslate 快照防渲染干扰（精细）。
- ✅ 安全区基础设施完整：ios-safe-area.css（env(safe-area-inset-*)）+ Android --android-safe-area-*（platform.ts 注入）+ .safe-* 工具类。
- ✅ 隐藏 view 不抢占 bottom tab fullscreen claim（MobileSlidingLayout.tsx:141-185 用 MutationObserver 判定可见层）——目标文档点名的"隐藏 view 占用 fullscreen claim"已有防护。

### C.1 Findings

```text
[P1] 移动端整页文本选择被禁用：MobileSlidingLayout 容器的 select-none 类经 selection.css 的 `.select-none * {... !important}` 级联到全部子树，击穿消息/代码/markdown 白名单——用户无法长按复制 AI 回答
Area: 移动端交互 / native-feel 选择白名单
Files: src/components/layout/MobileSlidingLayout.tsx:416（容器 className 含 select-none）; src/styles/native-feel/selection.css:126-130（.select-none, .select-none * 带 !important）; src/styles/tailwind.css:53-60（全局禁选基线）
Invariant Violated: 目标文档 §移动端 "水平手势不得误拦截文本选择"；§UX "用户能复制 AI 实际输出"
Evidence:
  - 设计意图：@layer base 全局 user-select:none（低优先级）+ selection.css 非分层白名单恢复（message-selectable-area/prose/pre/code 等，无 !important）。
  - selection.css:126 把 .select-none 重定义为 **子树级**（.select-none *）且 !important。MobileSlidingLayout 根容器带 select-none → 移动端聊天页全部内容是其子树。
  - 白名单规则无 !important（除 .select-text，但其与 .select-none 同特异性同 !important，按 cascade 后者（行 126 > 行 120）胜出）→ 子树内一切恢复手段失效。
  - ChatV2Page.tsx:987 确认移动端聊天整页包在 MobileSlidingLayout 内；ExplainPopover（划词解释）依赖文本选择触发，移动端因此整体不可达。
  - input/textarea 也被 user-select:none !important 命中（selection.css:22 规则无 !important 保护）——iOS WebView 中可能干扰输入框光标拖动/选词。
Reproduction / Counterexample: 移动端打开任意对话 → 长按 AI 回答中的一段文字 → 无选择手柄出现（iOS/Android WebView 对 user-select:none 的长按行为）→ 无法复制片段、无法触发划词解释/翻译。
User Impact: 移动端核心"复制答案/划词解释"交互不可用；只能整条消息复制（若有按钮）。
Current Diff Relevance: 非 diff 引入（native-feel Phase A 引入）。
Why Existing Tests Miss It: CT/vitest 不断言 computed style 的 user-select；无移动端真机交互测试。
Minimal Fix Direction: ① MobileSlidingLayout 根容器移除 select-none（拖拽中误选已由轴锁 + preventDefault 缓解；如需，仅在 isDragging 时临时加）；② 同时把 selection.css 的 .select-none 改回元素级（去掉 ` *` 或去掉 !important），避免任何包装容器一键杀死子树。
Suggested Test: Playwright CT：移动视口渲染聊天页，断言 message 内 p 元素 getComputedStyle(user-select)==='text'。
Confidence: 高（CSS 级联是确定性的；具体设备表现建议真机复验一次）。
```

```text
[P2] 手势逃生口 data-gesture-ignore 全仓库零使用；无多指手势中止；横向可滚动内容（代码块/表格/PDF/导图）被水平轴锁劫持
Area: 移动端手势系统
Files: src/components/layout/MobileSlidingLayout.tsx:21-26（INTERACTIVE_SELECTOR 定义了 [data-gesture-ignore] 但全仓库无任何组件使用）; 339-342（onTouchMove 单指逻辑，无 touches.length>1 检查）; 252-255（轴锁水平后 preventDefault）
Invariant Violated: 目标文档 §移动端 "水平手势是否会误拦截垂直滚动、文本选择、代码块滚动、PDF 缩放、导图拖拽、slider"
Evidence:
  - 逃生口存在但零采纳：rg 全仓库仅定义处一条匹配。代码块（pre 横向滚动）、表格、PDF 查看器、思维导图画布、横向滑杆都没有标记。
  - 代码块横向滑动：触点不命中 INTERACTIVE_SELECTOR → handleDragStart 启动 → deltaX > 1.2×deltaY → 轴锁水平 → preventDefault → pre 的原生横向滚动被吞，整屏平移到侧栏。
  - 双指捏合：touchAction 'pan-y pinch-zoom' 声明允许捏合，但 onTouchMove 始终读 touches[0]；第二指落下后单指位移仍可能锁水平 → preventDefault 阻断浏览器捏合（PDF/图片缩放场景）。标准做法是 touchstart/touchmove 检测 e.touches.length > 1 即放弃拖拽。
Reproduction / Counterexample: 移动端让 AI 输出一段超宽代码（长行）→ 在代码块上横向滑动想看右侧内容 → 整个聊天页滑向侧边栏，代码块不滚动。
User Impact: 看代码/表格的核心阅读动作与导航手势冲突；PDF 捏合缩放可能间歇失效。
Current Diff Relevance: 非 diff 引入。
Minimal Fix Direction: ① onTouchStart/Move 加 `if (e.touches.length > 1) { abort drag; return; }`；② handleDragStart 前检查 target.closest('pre, table, [data-gesture-ignore], .react-pdf__Document, canvas') 或更通用：沿途存在 scrollWidth>clientWidth 且可横向滚动的祖先即放行；③ 给代码块/导图/PDF 容器补 data-gesture-ignore。
Suggested Test: CT：模拟代码块上的横向 touch 序列，断言 screenPosition 不变且 pre.scrollLeft 改变。
Confidence: 高（代码路径确定；具体组件是否有自行 stopPropagation 需逐个确认，但逃生口零使用是事实）。
```

```text
[P3] 移动端布局容器 zIndex=2500（drawer 档）与 body 级 portal popover（1000）跨上下文比较脆弱——若 view-layer-shell 不构成 stacking context，划词解释/翻译/输入栏面板会被整页盖住
Area: 移动端层级契约
Files: src/components/layout/MobileSlidingLayout.tsx:420（容器 zIndex: Z_INDEX.drawer=2500）; ExplainPopover.tsx:317 / TranslationPopover.tsx:647 / ComposerPanelOverlay.tsx:193（portal 到 document.body，z=1000）
Evidence: 三个 popover createPortal 到 body 且 z=1000 < 2500。两者是否同一 stacking context 取决于 App 视图层包装（[data-view-layer-shell]）是否因 transform/opacity/contain 创建上下文——静态审阅无法定论，但"布局容器用 drawer 档 z + portal 用更低档"的组合違反注册表自身的层级语义（popover 档本应高于内容层）。
Minimal Fix Direction: 布局容器不应占用 drawer 档（其内部 z[1]/z[2] 已能分层，根容器可用 base 档）；或 body portal 一律 ≥ sheet 档。建议运行时验证一次三个 popover 在移动端的实际可见性。
Confidence: 中（需运行时复验）。
```

### C.2 备忘（待运行时验证项）

- 输入栏高度联动（ResizeObserver/blocking bars/附件 chips）与软键盘 occlusion 未逐项静态审完；建议配合 tauri-lab 真机/模拟器走查目标文档列出的 7 条移动端用户序列。
- 360x740 小屏 + 系统字体放大组合下的 Topbar/TabBar 溢出未验证。

## Batch D: VFS/索引/Lance 双写 `[完成]`

> 前置说明：`docs/reviews/vfs-learning-hub-chatv2-review-findings.md`（2026-06-10）已对本域做过全面审阅。本轮以"回归核查：哪些已修、哪些仍开放"+ 增量审阅为主，避免重复记录。

### D.0 已修复确认（对照昨日清单）

- ✅ A1（questions_fts 触发器模式错误）：`V20260610__fix_questions_fts_triggers.sql` 已落地。
- ✅ A2（事务内先删物理文件）：blob_repo.rs:301 注释确认已拆"标记/删文件"两阶段。
- ✅ F5/Lance 孤儿队列：`V20260611__add_lance_orphan_queue.sql` + `drain_lance_orphan_queue`（indexing.rs:3739-3808，幂等删除、retry 上限、每轮索引前排空）。
- ✅ 文本索引失败补偿闭环：Lance 写入 → SQLite SAVEPOINT → 失败回滚 Lance 向量 → 回滚失败则 mark_failed 带组合错误（indexing.rs:2434-2473），状态机诚实。
- ✅ delete_resource_index 顺序正确（先 Lance 后 SQLite，失败可重试，幂等）。

### D.1 Findings（仍开放/增量）

```text
[P2] 回收站恢复文件后永久退出 RAG：删除时物理清除向量+units，restore_file_with_conn 不重置索引状态（昨日 A6，今日确认仍未修复）
Area: VFS 软删除/恢复 × 索引一致性
Files: src-tauri/src/vfs/repos/file_repo.rs:834-863（restore 只恢复 files/folder_items）; delete_file_with_index_cleanup（删 units+Lance）
Invariant Violated: 目标文档 §VFS "失败补偿完整"；§UX "删除或恢复资源后，Chat 引用、搜索给出一致反馈"
Evidence: restore_file_with_conn 无 VfsIndexStateRepo::mark_pending 调用、无重索引触发。删除路径已物理删向量与 units。
Reproduction: 删除已索引 PDF → 回收站恢复 → RAG/语义搜索永远找不到该文件；前端索引状态若显示"已索引"则为假（units 已删）。
User Impact: 恢复的资料从 AI 检索中静默消失，用户无法理解为什么 Chat 不引用它。
Minimal Fix Direction: restore_file_with_conn 内 mark_pending(resource_id)，由后台索引循环自动重建；或恢复时检查 units 为空即标 pending。
Suggested Test: 删除→恢复→断言 index_state='pending' 且下轮 process_pending_batch 重建。
Confidence: 高。
```

```text
[P3] delete_resource_index 多模态删除失败留下"text 向量已删、SQLite units 仍在"的中间态；崩溃窗口同理
Area: VFS 索引删除原子性
Files: src-tauri/src/vfs/indexing.rs:3616-3653
Evidence: 步骤 1（text Lance）成功、步骤 2（multimodal Lance）失败 → Err 返回，SQLite units/segments 未删 → 元数据声称已索引但 text 向量已不存在；重试可自愈（删除幂等），但期间检索静默缺失。步骤 2 与 3 之间崩溃同理。
Minimal Fix Direction: 失败时把 resource 标记 pending/failed（与 text 路径的补偿一致），或将 Lance 删除失败也写入 __lance_orphan_queue 后照常删 SQLite 元数据（队列已具备兜底能力）。
Confidence: 高（路径明确，影响为暂态不一致）。
```

## Batch E: 学习闭环与 SSOT `[完成]`

### E.1 Findings

```text
[P1] 删除题目不清理复习计划（昨日 C4）：修复函数 delete_plan_by_question 已写好但零调用方——"修复存在但没接线"
Area: 学习闭环 题库×复习计划
Files: src-tauri/src/vfs/repos/review_plan_repo.rs:660-666（函数存在）; src-tauri/src/question_bank_service.rs:253-270（delete_question 不调用）; commands.rs:4991-5011（qbank_delete_question/batch 不调用）
Invariant Violated: 目标文档 §学习闭环 "删除题目…是否同时维护 review_plans"；必测序列"用户删除题目后查看到期复习"
Evidence: rg 全仓库 delete_plan_by_question 仅定义处与自身 with_conn 重载，无任何 service/handler 调用。
Reproduction: 创建复习计划的题目 → 删除该题 → 到期日打开复习入口 → 幽灵条目出现（指向已软删题目），点开报 not found 或空内容。
User Impact: 复习列表持续出现死条目，破坏"到期复习"信任；长期使用越积越多。
Current Diff Relevance: 非 diff 引入。
Why Existing Tests Miss It: 无"删除题目→到期列表"的跨 repo 集成测试。
Minimal Fix Direction: qbank_delete_question/batch_delete_questions（service 层）软删题目同事务内调用 delete_plan_by_question_with_conn；补一条迁移清理存量幽灵计划（review_plans JOIN questions WHERE questions.deleted_at IS NOT NULL）。
Suggested Test: Rust 集成测试覆盖单删/批删两路径断言 review_plans 同步清理。
Confidence: 高。
```

```text
[P1] 复习计划"今天"用 UTC、待办"今天"用本地时区：UTC+8 用户每天 00:00–08:00 复习到期列表少一天（昨日 C5，仍开放）
Area: 学习闭环 日期语义
Files: src-tauri/src/vfs/repos/review_plan_repo.rs:242,352,599,819（Utc::now().format("%Y-%m-%d")）; src-tauri/src/vfs/repos/todo_repo.rs:1012（Local::now()）
Invariant Violated: 目标文档 §学习闭环 "UTC 日期、本地日期、due date、todo、pomodoro、review_plan 是否有一致的'今天'语义"
Reproduction: 北京时间 6 月 12 日 07:00（UTC 6 月 11 日 23:00），due_date='2026-06-12' 的复习不出现在"今日到期"（UTC today=06-11）；同一时刻 todo 的"今天"已是 06-12。两个入口对"今天"答案不同。
User Impact: 中国/东亚用户清晨复习时段（最常用时段之一）看不到当天到期复习；跨模块不一致摧毁"今天"心智模型。
Minimal Fix Direction: 统一改用本地日期（学习类产品惯例）：单一 `fn today_local() -> String` 收敛所有写/查点；due_date 存储保持日期字符串不变。
Suggested Test: 用 TZ=Asia/Shanghai 在 UTC 23:30 模拟，断言 due 今日的计划出现在列表。
Confidence: 高。
```

```text
[P1] 题目集 Chat 注入仍读 exam_sheets.preview_json 导入时快照（昨日 D1，仍开放）：用户改完答案让 AI 解释，AI 看到的是旧答案
Area: 学习闭环 SSOT × Chat 注入
Files: src-tauri/src/vfs/ref_handlers.rs:1053-1063（exam 分支直接返回 preview_json）; questions 表才是用户编辑后的 SSOT
Invariant Violated: 目标文档 §学习闭环 "preview_json 与 questions 表是否出现双轨写入、读取陈旧快照"；必测序列"导入试卷→手动改答案→让 Chat 解释同一题"
Evidence: ref_handlers exam 分支 `SELECT preview_json FROM exam_sheets WHERE id=?1` 直出；编辑题目只写 questions 表，不回写 preview_json（双轨）。
User Impact: AI 基于过时题面/答案讲解 → 用户校对成果被无视，AI 答非所问且用户难以发现原因（最伤信任的一类缺陷）。
Minimal Fix Direction: exam 引用解析改为从 questions 表组装当前题目（已有 qbank_executor 类似逻辑可复用）；preview_json 仅用于"原始扫描图"场景并明确标注"导入原貌"。
Suggested Test: 集成测试：改答案→解析 exam ref→断言注入文本含新答案。
Confidence: 高。
```

```text
[P3] batch_delete_questions service 层退化为逐题事务（昨日 C6 仍开放）
Area: 题库批量操作
Files: src-tauri/src/question_bank_service.rs:273-310（循环内对每个 id 调 batch_delete_questions(&[id])，每次独立 BEGIN IMMEDIATE）
Evidence: repo 的批量函数支持整批一个事务，service 却逐个调用——批删 500 题 = 500 个事务 + 500 次 get_question 前置查询；且语义上不再是原子批删。
Minimal Fix Direction: service 直接把整个 ids 切片传给 repo 批量函数；exam_ids 统计改为一次 SQL 聚合。
Confidence: 高。
```

## Batch F: 安全/无障碍/性能 `[完成]`（抽查式）

### F.0 已核实的正确设计

- ✅ Chat 全文搜索 snippet：FTS5 哨兵字节（X'02'/X'03'）+ 先 HTML 转义再替换 `<mark>`（repo.rs:2887,2930-2937）——XSS 处理正确且优雅。
- ✅ XlsxPreview/Mermaid/SVG/HTML 代码块预览：DOMPurify FORBID_TAGS（script/iframe/foreignObject/embed/object）+ XML 预览用 sandbox="" iframe + srcdoc 双重转义（CodeBlock.tsx:332-433）。
- ✅ 云存储凭据：localStorage 仅存非敏感配置，密码/secretKey 走 secure store 且"防御性不回退"（cloudStorageApi.ts:78-140）。
- ✅ Tauri capabilities：http 域名白名单按 provider 枚举（无 *://*）；fs 限 app 目录 + 用户内容目录；无 shell 权限。
- ✅ WebDAV 强制 HTTPS（仅 localhost 豁免）+ TLS≥1.2（webdav.rs:46-59）。

### F.1 Findings

```text
[P3] debugLogger 脱敏仅处理顶层 password/apiKey/token 三个键；嵌套对象与 500 字符 preview 可能携带敏感内容；sanitizeState 保留 chatHistory 文本入盘
Area: 调试日志隐私
Files: src/utils/debugLogger.ts:611-666（sanitize* 三函数）; 495-503（flushLogs → write_debug_logs 落盘）
Evidence: sanitizeRequest 不递归（headers.Authorization、config.password 漏网）；sanitizePayload 截断但保留 500 字符预览；sanitizeState 的 chatHistory 仅按条数截断、内容原样。当前 logApiCall 无调用方（风险潜伏而非现行），但 logStateChange/logEvent 在用。
User Impact: 用户导出/上报 debug 日志时可能附带对话内容片段。
Minimal Fix Direction: 递归脱敏（键名正则 /pass|secret|token|key|auth/i）；chatHistory 仅记录长度与 id；明示"日志包含对话内容"并提供脱敏导出。
Confidence: 高（代码确定；现行暴露面取决于调用方）。
```

```text
[P3] 后端错误日志直接打印用户学习内容（Anki 卡片全文 JSON）
Area: 日志隐私
Files: src-tauri/src/streaming_anki_service.rs:1042-1043（[ANKI_PARSE_ERROR] 原始内容: {card_json}）、844-845
Evidence: 解析失败时完整卡片内容（用户资料）进入日志文件，error 级别必然落盘。
Minimal Fix Direction: 只记录长度+前 80 字符+hash；或 debug 级别 + 默认关闭。
Confidence: 高。
```

### F.2 无障碍与性能（第二轮补查）

**性能——已核实的正确设计**：

- ✅ Chat 消息列表：`@tanstack/react-virtual`，>80 条自动切虚拟化（MessageList.tsx:46,179）。
- ✅ 题库列表：后端分页（page/page_size）+ loadRequestId 过期请求丢弃 + loadMore 增量合并去重（questionBankStore.ts:792-874）——分页与并发防护都做对了。
- ✅ 性能面最大已知项仍是昨日 B6（附件 base64 全量过 IPC 后才判过大），未修，不重复记录。

**无障碍 Findings**：

```text
[P2] 主对话框原语 NotionDialog（全仓 58 处使用）无焦点陷阱、无初始焦点、无关闭后焦点归还——aria-modal="true" 名不副实
Area: 无障碍 模态对话框
Files: src/components/ui/NotionDialog.tsx:82-140（仅 ESC 监听 + aria-modal 标记）; src/hooks/useFocusTrap.ts（已有现成实现，但全仓只有 ImageViewer 用了）
Invariant Violated: 目标文档 §F "焦点管理：模态/抽屉/弹层是否有 focus trap 与焦点返回"；WCAG 2.4.3
Evidence: 打开对话框后焦点仍留在触发按钮；Tab 会穿透到遮罩后的页面元素；关闭后焦点不归还。useFocusTrap 钩子质量不错却没接到主原语上——又一例"修复存在但没接线"。
Reproduction: 键盘操作打开任意确认对话框（如删除确认）→ Tab → 焦点跑到对话框外的页面按钮上，可误触发遮罩后的操作。
User Impact: 键盘用户与屏幕阅读器用户在所有对话框上的操作不可靠；删除确认类对话框尤其危险（焦点穿透可能误触背后按钮）。
Minimal Fix Direction: NotionDialog 内接入 useFocusTrap（含初始聚焦第一个可聚焦元素、关闭时 restore focus）；ESC 监听加栈管理（多层对话框只关最顶层）。
Suggested Test: vitest + testing-library：打开对话框后 Tab 循环不出对话框；关闭后 document.activeElement 回到触发器。
Confidence: 高。
```

```text
[P3] framer-motion 动画不响应系统"减少动态效果"：CSS 层 prefers-reduced-motion 覆盖（notion-animations.css:367）对 JS 驱动动画无效，未配置 MotionConfig reducedMotion="user"
Area: 无障碍 动效
Files: src/main.tsx / src/App.tsx（无 MotionConfig）; 全仓大量 motion.div（对话框、移动端滑动布局、弹层）
Evidence: CSS 的 animation-duration:0.01ms 只压制 CSS 动画；framer-motion 用 rAF/WAAPI 内联样式，照常播放。仅 13 个文件用了 tailwind motion-reduce: 工具类。
User Impact: 前庭障碍用户关闭系统动画后，应用主要动效（页面切换、对话框弹入、移动端滑屏）依旧全量播放。
Minimal Fix Direction: 根组件包一层 <MotionConfig reducedMotion="user">（framer-motion 内建支持，一行）。
Confidence: 高。
```

**无障碍——已核实的正确面**：UnifiedNotification/MessageList/进度组件均有 aria-live；对话框普遍有 role="dialog"+aria-modal+ESC；图标按钮普遍带 aria-label（抽查 InputBar/App.tsx 通过）。

## Batch G: 学习产物生成与集成 `[完成]`（抽查式）

### G.0 已核实的正确设计

- ✅ 流式制卡坏 JSON 不静默：解析失败 → create_error_card → emit 给 UI（用户可见可重试），无法创建错误卡才升级 handle_task_error（streaming_anki_service.rs:827-891）；安全阻断（SafetyBlocked）也有专属错误卡。目标文档"AI 生成失败一半，用户能区分已保存/失败项"在此路径成立。
- ✅ 卡片上限硬截断（max_cards_per_mistake）防失控生成。
- ✅ 多模板 template_id 解析有显式校验与帮助信息（缺失即报错而非猜测）。

### G.1 第二轮补查（apkg 导出 / AnkiConnect）

**已核实的正确设计**：

- ✅ apkg 导出原子性：NamedTempFile 同目录写入 + persist 原子替换；临时目录带 uuid 随机后缀（并发安全，今日提交 8ed2116 修复）；媒体文件读取失败 → 整体导出失败（诚实）。
- ✅ AnkiConnect 批量添加：返回 Vec<Option<u64>> 逐卡结果，部分失败前端可逐卡区分；全部失败才报错——符合"用户能区分已保存/失败项"目标。
- ✅ 文件名安全：sanitize_filename_component 剥路径段，build_safe_output_path 收敛输出目录。

**Findings**：

```text
[P3] apkg 媒体打包按 basename 去重：不同路径同名文件第二个被静默丢弃，引用该图的卡片显示第一个文件的内容
Area: Anki 导出 媒体打包
Files: src-tauri/src/apkg_exporter_service.rs:899-910（seen_media_names 按 file_name 去重）
Evidence: /a/diagram.png 与 /b/diagram.png（不同内容）→ 第二个不进 zip；Anki 媒体命名空间扁平是格式限制，但静默吞掉而非重命名/告警违反 INV-1 精神。
Minimal Fix Direction: 冲突时按内容 hash 改名（diagram_abc123.png）并同步改写卡片 HTML 引用；或至少 warn + 导出结果中报告跳过清单。
Confidence: 高（路径明确；触发需同名异内容图片，制卡场景截图常为 timestamp 命名，概率中低）。
```

```text
[P3] apkg 字段值未过滤 0x1F 分隔符：LLM 输出若含 U+001F，note 字段错位损坏导入的牌组
Area: Anki 导出 字段编码
Files: src-tauri/src/apkg_exporter_service.rs:675（field_values.join("\x1f")，值未清洗控制字符）
Minimal Fix Direction: join 前 value.replace('\x1f', " ")（顺带清 \x00-\x08 控制符）。
Confidence: 高（构造性边界；真实触发罕见）。
```

## Batch H: 端到端用户体验 `[完成]`（基于 A–G 综合 + 静态可判定项）

### H.1 跨批次体验断层汇总（本轮新发现的体验级问题都已计入对应批次，此处给旅程视角）

- 旅程"多设备同步资料"：A 批 LWW 分叉（同秒并发静默分叉）+ blob 墓碑误删（仍被引用的附件被删且云端无副本）→ 该旅程当前不可信。两个 P1 都是静默的，用户唯一感知是"东西不见了/不一致"。
- 旅程"弱网同步失败后恢复"：WebDAV/FTP 无读超时 + 全局锁 + 无取消 → 用户面对永久转圈，且备份/恢复一并被锁死；"失败可恢复"目标不成立（A 批 P1）。
- 旅程"备份恢复后继续使用"：当前 diff 的 IPC 契约断裂（P0）直接阻断；即使修复，基线重建/设备轮换失败的静默化（A 批 P2）让"恢复成功"提示不可信。
- 旅程"删除/恢复资料"：恢复后退出 RAG（D 批）+ 删除题目留幽灵复习（E 批）→ "系统给出一致反馈"目标不成立。
- 旅程"移动端学习"：无法长按复制 AI 回答（C 批 P1）+ 代码块横向滚动被手势劫持（C 批 P2）→ 移动端阅读/复用产出的基本动作受阻。
- 旅程"做题→复习"：UTC"今天"语义（E 批 P1）让清晨复习窗口失效。
- 旅程"Chat 解释我改过的题"：陈旧 preview_json（E 批 P1）→ AI 答非所问。
- 正面项：错误卡机制（G）、同步完成通知诚实化（A.0 已核实 O1）、隔离区面板（A.0 D5）说明"失败诚实"方向的基建已起步，问题集中在覆盖面而非方向。

### H.2 备忘

- 首启引导、空状态、长任务跨重启可发现性需运行时走查（建议配合 deep-student-tauri-lab skill 做一轮真机器走查，覆盖目标文档 §UX 的 9 条必测序列）。

---

## 汇总（最终报告）

### 1. Executive Summary

本轮按 FABLE_SOTA_GOAL.md 完成 A–H 八个批次审阅（A–E 深审 + F/G 第二轮补查 + H 旅程综合 + 当前 diff 二轮复核），共记录 **1 P0 / 9 P1 / 10 P2 / 12 P3 = 32 项**，另核实 25+ 项正确设计与 10 项今日提交/diff 已修复项（S3 校验和兼容、qbank SSE 哨兵、MCP 版本序、pdfstream 探测一致性、apkg 并发隔离等）。

**系统当前离 SOTA 的真实距离**：方向正确、骨架优秀（事件序号、错误卡、隔离区、孤儿队列、墓碑水位线、FTS 转义、DOMPurify 矩阵都是 SOTA 级设计），但三类问题拉开差距：

1. **静默失败仍是系统性弱点**（INV-1/INV-5 反复违例）：blob 误删、恢复后基线重建失败照报成功、FTP 解析丢条目报 complete、恢复文件退出 RAG——共同模式是"补偿/防线代码存在，但失败路径退化为 warn! + 继续"。
2. **修复未接线 / 修复未回归**：delete_plan_by_question 写好却零调用是最典型样本；昨日清单 6 项开放问题今日复核 5 项仍开放（C4/C5/D1/A6/B6）。**缺"修复必须带集成测试 + 回归清单核销"的流程约束，这是比任何单个 bug 更优先的事**。
3. **移动端是被遗忘的二等公民**：文本选择全局禁用、手势逃生口零接线，说明移动路径缺真机走查环节。

**Top 5 立即行动**（按用户伤害 × 修复成本排序）：
1. [P0] 回滚当前 diff 的 snake_case 改名（dataGovernance.ts）——主链路全断，一行配置级修复。
2. [P1] blob 墓碑应用前查本地 ref_count（不可恢复数据丢失，修复约 20 行）。
3. [P1] WebDAV/FTP 加读超时 + 同步取消命令（永久冻结，配置级修复）。
4. [P1] 移动端 select-none 改为手势期间动态加类（一处 className + 一处状态绑定）。
5. [P1] E 批三件套接线：delete_plan_by_question 接入删除路径 / today 统一本地时区 / exam 注入改读 questions 表。

### 2. Cross-Layer Contract Matrix（仅列有断点的行）

| 契约 | 前端期望 | 后端实际 | 断点 | 严重度 |
|---|---|---|---|---|
| dataGovernance invoke 参数 | （diff 后）snake_case | Tauri 自动 camelCase | 全部 39 处 invoke 参数不被识别 | P0 |
| LWW tie-break | 跨设备收敛 | 本地恒为 "local-unknown" 参与字典序 | 同秒并发永久分叉 | P1 |
| list_outcome 截断语义 | truncated=true 时上层降级 | FTP 解析失败仍 complete=true；S3 截断+无 token 死循环 | 增量同步漏判、卡死 | P2 |
| 恢复→同步基线 | 恢复成功 = 基线已重建 | 重建失败仅 warn，照报成功 | 恢复即覆盖风险 | P2 |
| 块事件→消息归属 | 事件只作用于当前流消息 | 块级事件无 messageId 陈旧过滤（会话级有） | 停止后重发产生幽灵块 | P2 |
| 恢复会话块状态 | DB 中 running = 已中断 | 前端原样恢复为流式中视觉 | 僵尸 spinner | P2 |
| exam ref → Chat 注入 | 注入当前题目数据 | 读 preview_json 导入快照 | AI 看旧答案 | P1 |
| 回收站恢复 → RAG | 恢复后可检索 | 向量已物理删、不重建索引 | 恢复文件退出 RAG | P2 |
| "今天" 语义 | 全系统一致 | review_plan=UTC, todo=Local | 清晨 8 小时窗口不一致 | P1 |

### 3. Mobile Interaction Audit（结论）

- **选择文本**：全局禁用（C 批 P1，击穿白名单 CSS）——移动端最高优先级。
- **手势冲突**：逃生口未接线 + 无多指中止 + 轴锁劫持横向内容（C 批 P2）。
- **层级**：2500 容器 vs 1000 popover 跨上下文脆弱（C 批 P3，需真机确认）。
- **正确面**：轴锁实现本身干净（方向锁定、visibilitychange 复位、键盘感知 useMobileViewportLock）。

### 4. UX Friction Map（旅程 → 断点，详见 Batch H）

多设备同步（不可信：分叉+误删）｜弱网恢复（永久转圈+全局锁死）｜备份恢复（P0 断裂+成功提示不可信）｜删除/恢复资料（幽灵复习+退出 RAG）｜移动端学习（无法复制）｜清晨复习（少一天）｜改题后问 AI（答非所问）。正面：错误卡、诚实同步通知、隔离区 UI 已具备 SOTA 雏形。

### 5. Accessibility / I18n / Security Notes

- 安全抽查全部通过（FTS snippet 转义、DOMPurify 矩阵、凭据分级存储、capabilities 白名单、强制 HTTPS）；仅日志隐私两处 P3。
- I18n：error_details.rs 中英混排（A 批 P3）。
- 无障碍：未做系统性审阅，遗留专项（F.2）。

### 6. Test Plan(增量，按 ROI 排序)

1. **契约测试**：脚本扫描 invoke 参数名 vs Rust 命令签名（防 P0 复发，CI 级）。
2. **Rust 集成**：blob 墓碑 × 本地引用（A 批）；删题→到期复习列表（E 批）；恢复→索引状态（D 批）；恢复失败→命令返回值含 warning（A 批）。
3. **时区矩阵**：TZ=Asia/Shanghai 在 UTC 23:30 跑 review_plan/todo "今天"一致性。
4. **前端 Vitest**：停止→重发幽灵块（eventBridge 注入滞后事件）；restore 时 running 块归一化。
5. **真机走查**（deep-student-tauri-lab）：目标文档 §UX 9 条必测序列 + 移动端长按复制/popover 层级。

### 7. Fix Plan（三波次）

- **Wave 1（本周，全部 ≤50 行级）**：P0 回滚；WebDAV/FTP 读超时；blob ref_count 检查；select-none 动态化；delete_plan_by_question 接线；today_local() 统一；S3 死循环 break。
- **Wave 2（下周）**：恢复失败提升为用户可见警告；块事件 messageId 过滤；restore 块状态归一化；exam 注入改读 questions；FTP list_outcome 诚实化；恢复文件 mark_pending；qbank parse 模式截断标记；NotionDialog 接入 useFocusTrap；looks_like_sync_test_fixture_table 移出生产路径（feature gate）。
- **Wave 3（专项）**：同步取消命令 + 全局锁粒度化；LWW tie-break 设备 ID 全序（需迁移设计）；同记录 DELETE→重建 组内保序排序键；手势逃生口接线；MotionConfig reducedMotion；流程：回归清单核销制 + 修复必附集成测试。
