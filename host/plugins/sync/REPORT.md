# L20-sync 恢复执行报告（工作协议 v2）

## 2026-11-05 W69 main-red 与 W13 pre-storage（本轮）

### W69 `w69_ten_thousand_tiny_records`（10000 条 / <30000ms）

- 原测试只读复用 `host/plugins/sync-providers/tests/weird_batch_sync.test.ts`：未改一行，10000 条、`success/failure/applied_keys/表 count` 与 `<30_000ms` 原断言全部保留；未加索引、未改阈值/输入/记录数、未缓存 DELETE 查询结果。
- 生产修复（`host/plugins/sync/repository/`）：
  1. `apply-record.ts::currentDeleteVersion` 的 `__change_log` 谓词按交接候选改为 record-first：`WHERE record_id=?2 AND table_name=?1 AND upper(operation)='DELETE' ORDER BY id DESC LIMIT 1`。参数仍 `[tableName, recordId]`，占位符编号、大小写处理、排序、错误与返回不变。
  2. `sqlite-values.ts` 增加**事务作用域 schema 元数据复用**：`PRAGMA table_info` / `sqlite_master exists` 的正结果按 transaction scope 对象缓存，事务结束即失效；只缓存正结果（事务内后建表仍会重读），跨事务不缓存。缓存的是 schema 元数据，不是 `currentDeleteVersion` 的查询结果。W69 每行约 12 次 schema 读取，纯开销约 10s+。
- 实测（同一共享 job queue，`VITEST_MAX_FORKS=3/THREADS=3`，运行时机器 load avg 39–44、`cpu.pressure some avg10` 28–39、`integrating=true`，与其它 lane 作业并发）：
  - 基线（未改）：job `20261105091952-5cd544`，apply **43085ms**，原断言失败。
  - 仅 record-first：job `20261105092633-cb4c07`，**39416ms**，仍失败。
  - record-first + schema 元数据复用：job `20261105093341-1b953b`，**24685ms**，exit 0 / 1 passed。
  - 缓存生命周期收紧后复跑：job `20261105095907-a6dcae`，W69 **20199ms**，同 job 17 passed（含完整 weird_batch + 新不变量回归）。
  - 接入 F3 public seam 后的最终复跑：job `20261105101740-3224f9`，W69 **24054ms**，1 passed exit0（同一共享队列、并发环境）。
  - 完整 `weird_batch_sync.test.ts` + `tests/apply.test.ts`：job `20261105094535-57836a`，**71 passed / exit 0**（覆盖 W69、DELETE 版本、LWW、savepoint/force-exact）。
  - 类型检查：job `20261105094535-78ce27` 与本轮收紧后 `20261105095907-f0ea00`，均 exit 0。

#### schema 缓存生命周期收口（C2 审读点）

- 缓存条件已收紧为 `db.inTransaction === true && typeof db.savepoint === 'function'`：只有 F3 `TransactionScope`（`host/platform/storage/api.ts:240-251` 公开 `afterCommit`/`savepoint`）可作为 key；长生命周期 `DatabaseHandle` 虽然在其连接有事务时也返回 `inTransaction=true`（`database.ts:382-384`），但没有 `savepoint`，因此不会跨多个事务共享同一缓存。
- 生产调用链：`apply-batch.ts:104-140`、`apply-guard.ts:173-...`、`apply-force.ts:74-...` 都在 `db.transaction(tx => ...)` 内把同一个 `tx` 传给 `applySingleChange`/`currentDeleteVersion`/`getRecordData`；`apply-databases.ts` 的 root `db` 只用于事务外的策略判断、打开库和事务后的 quarantine replay，未在事务内作为 schema 读取 executor。
- schema 迁移先于缓存：`apply-batch.ts:106-107`（以及 guard/force 对应行）在行循环前执行 `ensureQuarantineTable(tx)`/`ensureConflictTable(tx)`；这两者只 ALTER `__sync_quarantine`/`__sync_conflicts`，而这两表在生产中只经 `pragma_table_info` 直查（apply-quarantine.ts/conflict-resolver.ts），不经本缓存的 `tableInfo`/`tableExists`。`__sync_id_aliases` 在事务起始 `loadIdAliases` 时创建并只缓存 exists 正结果，创建早于任何 savepoint；`__sync_delete_versions` 虽可在每行 savepoint 内 `CREATE IF NOT EXISTS`，但从不经本缓存的 `tableInfo`/`tableExists` 读取。
- savepoint rollback：raw `SAVEPOINT` 的 `ROLLBACK TO/RELEASE`（apply-shared.ts:86-111）不会撤销已缓存的业务表/`__change_log`/alias 列，因为 savepoint 内 DDL 只触及上述不参与缓存的 `__sync_*` 表。
- 真实回归：`tests/sqlite-values-schema-cache.test.ts` 覆盖 root `DatabaseHandle` 在事务中 `inTransaction=true` 时不得把 `PRAGMA table_info` 正结果带出事务（第一事务读 `[a]`，事务外 `ALTER TABLE ADD b`，第二事务必须读 `[a,b]`）。job `20261105095907-a6dcae`：该回归 + 完整 weird_batch 共 17 passed exit0。
- 仍存在的时间来源：每条记录一次 `__change_log` 全表扫描（测试 fixture 无 record_id 索引，且禁止新增索引）与逐行 apply 开销；余量在 30s 内但不是大余量，报告中如实记录并发前提。

### W13 paths-only pre-storage bootstrap

- 新增 `host/plugins/sync/startup.ts`：默认导出 `definePlugin`，`meta.id='dstu.sync-startup'`、`provides:['storageStartupSync']`、`inject:['paths']`；只从 `paths.os.dataLocal` 经 `syncStateDatabasePath` 取路径，不注入 storage/notes/backup/syncSupport。
- 新增 `host/plugins/sync/repository/startup-state.ts`：通过 F3 正式公开的 `openStartupDatabase(path, { label: 'sync_state' })`（默认 `PROFILES.sync_state`：busy_timeout 5000、synchronous FULL）独立打开 `sync_state.db`，执行同一 `SYNC_STATE_SCHEMA`，deferred 单事务删除 `consume_cursor`/`legacy_processed_key`/`tombstone_watermark`/`instance_binding`/`device_history`，保留 `upload_seq`/`tombstone_event_publish`；错误前缀与 Rust 一致，失败回滚并关闭连接。仅 import `platform/storage/api.ts`，无 private Connection/PROFILES 依赖。
- `dstu.sync` 已从 `meta.provides` 与 `apply` 移除同名 `storageStartupSync`（保留 `sync` 服务自身的 `resetDefaultAfterLocalPurge` 方法，仍委托 `syncSupport.state`）。因此 `node host/profiles/generate.ts --check` 现在通过（修复前直接抛 `dstu.sync: pre-storage bootstrap must inject only paths`）。
- 测试：`tests/startup-bootstrap.test.ts`（provider 仅 paths、F3 purge→reset→清 marker→开业务库、失败保 marker/回滚/业务库关闭；job `20261105095034-8361b4` 3 passed exit0）与 `tests/purge-reset.test.ts`（原断言保留；job `20261105095151-85846b` 2 passed exit0）通过；未改 F3/L23 测试。边界扫描 `host/plugins/sync` 0 violation；`importable` 对 `startup.ts`/`index.ts` 均 ok。
- 剩余跨 owner 接线（不在本 lane 越界）：
  1. **F1（必须）**：官方生成器当前只扫描 `host/plugins/*/index.ts`，需把 `host/plugins/sync/startup.ts` 加入 profile，并保持 generator 已有的唯一 provider + paths-only 校验与 kernel→bootstrap→platform 位置；装配合同即上述 meta/inject 与模块路径。
  2. **F3（已交付并接入）**：F3 提交 `55884368c55756a0747d476d6b55da5f5d57db54`（`ds-mig/F3-storage`）正式导出 `openStartupDatabase(filePath,{label?,profile?}) → StartupDatabase`（默认 sync_state；SqlExecutor+begin/commit/rollback/close；不 ctx.storage/业务库/迁移）。本 lane 以 `cherry-pick -x` 引入同一真实提交（L20 内 `f03a4b0a6`，未手抄源码），`startup-state.ts` 已改为只 import `platform/storage/api.ts`；五表 reset SQL、错误、事务与 close 语义留在 L20 不变。证据：`20261105101416-b5b2c0` 7 passed（F3 seam 2 + startup-bootstrap 3 + purge-reset 2）、`20261105101416-48ce13` typecheck exit 0。

## 独立高危追加：待上传日志精度（14:31）

按C1保留a4f6a0c78冻结门禁证据（141210-610527：1fail/1356pass/20skip，唯一s03），在其后继续R4-SYNC-02。发现getPendingChanges仍用普通db.all读取大i64日志ID，导致上传回执可能确认相邻旧记录；field_deltas_json还用JSON.parse损失整数/REAL表示。

修复由aab3cd060保存实现/回归，e408548ff发布公共ID类型：safeIntegers读取、ChangeLogEntry内部number|bigint、pending/enrich/markSynced/executeBidirectional回执全程精确；field_deltas_json调用既有lossless Value解析，未新增schema约束。`20261104142746-1fffb8` change-log21/change-upload8/integer-internal6，共35passed exit0。原类型检查`20261104142746-9a95b1` exit2仅暴露executeBidirectional旧number[]公开签名，e408548ff已修；复验`20261104143058-7a1841` exit0。原小整数测试断言不变，新增真实API验证只ack高ID、相邻低ID保持pending。

## main-red 16a254adf精确归因（14:06）

亲读 `/home/dsdev/dev/deep-student/.oc-runs/fulltest/latest.json`：head `16a254adfb53d24b971d27b2a7f34bf899d2bec7`，at `2026-11-04T14:02:26.213Z`。本次列出的11文件35失败首栈均为 `TypeError: paths.dataSpaceDeviceId is not a function → vfs-repos/index.ts:161 → sync/tests/host-fixture.ts:24`，在业务断言前安装失败。不是35个新算法问题，也不将此main-red与本分支新增8回归混为一组。

`git show 16a254adf:host/plugins/sync/tests/host-fixture.ts`确实只有deviceId；本分支修复7775325d9早已同时提供公开dataSpaceDeviceId，且安装真实syncSupport，尚因整分支未集成而未进入该main快照。当前b520109b7已合main bec9c35ba，最小job `20261104140941-50966f` plugin5/status3共8passed exit0；不删/skip断言、不修改业务绕过身份API，也不重复写同一修复。main-red仍需随本lane通过新增回归门禁后进入main才能真正关闭。

新增8回归进展：同b520109b7两文件原样job `20261104140353-20cbc8` exit1，business_tables25/25pass，realistic14pass/仅s03fail（总39/40）；正常main已含1a2ed3eb9真实service装配，L20未改L23测试。L10 a38068281同conn读取含软删正文修复仍未在此main，待正常集成后复验最后一项。gate-excerpt工具故障按架构师指令忽略，未作代码更改。

## 最新纠正：8项是本分支新增集成回归，L20负责闭环

架构师已明确main八项通过、合入本分支才失败。撤回下文历史叙述中“L23既有/本lane没有失败”作为责任归因的表述；历史测试计数保留，文件归属不代表根因归属。指定两文件原样job `20261104135611-f99900` exit1：8failed/32passed。两个独立诊断 `20261104135801-feab20` / `20261104134646-a9856a` 仅输出观察（exit0不代表正确），证实新reader依赖拒绝与soft-deleted owner读取回归；具体源码、请求裁定见REGRESSION-8.md。未修改任何L23测试或断言，未加入生产fallback。

## 五条缺失命令正式接线（13:28）

- main `ad11a83943de411a75c87364fd8893a174ce63f9` 经merge `6d2b70efd`进入工作树，L20b async codec已解除阻塞。index/API现发布runSync/runSyncWithProgress/markBlobDeleted/markAssetDeleted/listUnsyncedItems，并注册对应五命令，总24/24；自动检查点43626f419/53657704e/fc8382def/e63ac0775保存接线/测试。使用真正ctx.syncSupport.tombstones，无cast/plaintext-only/复制墓碑。
- L05 coordinator按Rust可选状态通过ctx.reflect.get取正式服务，避免未inject直接属性访问。早期job `20261104131940-d27c49` exit1：8failed/8passed（6项该访问错误，2项WebDAV夹具缺collection self-response）；修复后 `20261104132424-3d8946` 3文件12passed exit0。typecheck `20261104131940-1846e1` exit0。
- `20261104132718-b09cfb` 4passed exit0/无Errors：真实L21共享permit/SSOT、L23 WebDAV网络客户端、L20b墓碑owner、F4异步DSBK、L05 workspace维护及真实SQLite迁移组合。覆盖blob/asset发布回读、busy后释放、unsynced只读报告、加密墓碑字节与解密检查、两个run_sync空云成功及progress完成后cancel=false。仅HTTP服务端/凭据输入是夹具，不替换业务owner。
- 原run-sync与shared-permit用例已从私有函数直调改为真实index invoke，保留原错误、事件、许可、SSOT、审计断言。各命令§2清单已更新，剩余带数据cursor/全部边界、运行时及独立签收未因空云成功统签；TESTMAP不机械批量升ported。
- 下一步按提交→merge→正式lane-gate，运行期间冻结业务/测试文件，避免上轮混合树。新门禁失败必须逐文件归属，不能沿用旧58或旧21启动失败推断。

## C1全量旧基线去重回执 / R4-SYNC-02追加（13:06）

- C1报告固定head `158eaacf1fdf81900244c91f16d331a2b5fc34fd`、at `2026-11-04T12:29:42.878Z` 的21文件启动失败，首栈为 `paths.dataSpaceDeviceId is not a function → vfs-repos/index.ts:161 → sync/tests/host-fixture.ts:24`。当前候选已修：`7775325d9`为host-fixture/test-db提供该公开paths方法（f53290429保存说明，不冒充该代码SHA）；不重复改业务绕调用或skip。
- 现有同根验证job `20261104124638-4d275f`：plugin.test.ts **5passed**、status.test.ts **3passed**；note-history **15passed**、quarantine **6passed**、conflict-commands **11passed**。该job运行于本lane tip c0d08bc72；此21文件旧启动根因已不存在，不用再跑全仓。整job的58失败在L23，旧根因与业务断言分开。
- 后续 `20261104125929-9111ef` exit1实际是 **59failed/1223passed/20skipped，7failed/110passed/1skipped文件**，不能沿用58。该gate起始tip d4d6cefbb，但运行途中新增了回声水位反例，属工作树变动、不能当固定tip快照证据。新首栈：`integer-internal.test.ts:61`旧日志ID9007199254740993的sync_version期望0、实得1793797495；另58仍在L23（首例business_tables_sync.test.ts:234，长度期望5242880、实得2）。日志 `/home/dsdev/.oc-jobs/done/20261104125929-9111ef.log`；没有将新增本lane失败归咎unused。
- 根因修复 `476d0d463`：changeLogMaxId/echo suppression始终bigint，Rust mod.rs:7268-7291的旧未同步日志不能被舍入的水位提前确认。测试及参数类型先由自动检查点2ed5f1491保存。定向job `20261104130331-bf1378` **5passed exit0**，typecheck `20261104130331-cb260d` **exit0**。下一次正式gate须冻结工作树到结束再继续编辑，不把混合树结果当固定提交。
- F3回执 `1c7e85967`（含前序候选）确认多库任务接口已发布待main：export使用runWithDatabases/四库activeDir固定、openExisting(readonly:false)、timeoutMs:0、不传signal；注册真实storage维护屏障与卸载清理。不能以默认readonly改变原open_sync_connection权限，不能以F3接口24例绿代替export链闭环。
- L17 `d2c80ee3f`公开merger已发布待main；原R5-M4词法/fingerprint差异仍保留。当前高优先链是消费正式owner接口→五条命令生产接线，不继续扩张低优先X6自查。

## R4-SYNC-02..06 当前修复与新证据（2026-11-04）

### §5自检实际结果（tip 805eff938）

后续tip c0d08bc72自检：`20261104124638-4d275f` exit1，仍58failed/1223passed/20skipped（6failed/111passed/1skipped文件），失败范围仍全在L23。本laneapply.test.ts 55passed，含c63b6c4f7补回AP-0407/0408；整数4/阶段解码6/维护3/导出11均pass。typecheck `20261104124638-086bac`、boundaries `20261104124638-4be8cc`、strict `20261104124638-5949b3`、importable `20261104124638-514e13`均exit0（实际lane-gate返回）。无Unhandled Errors段。

关键路径优先级调整：五条缺命令逐项§2清单和主分支表已写SPEC，不把函数实现报作注册完成。L20b async codec候选cae04c341、F3多库worker/文件公共接口候选4f3db3e42与L23真实fixture修复0857c65b7均已核在owner分支、尚未到当前main；已向C2立即投递COMMAND-CRITICAL-PATH.md请求正常集成。Memory公共merger仍未发布。其余X6排雷排在补命令之后。

- 已按提交→merge main→lane-gate执行。4/5项通过：typecheck `20261104123624-5e5738` exit0；boundaries `20261104123624-5e9837` exit0（2436files/0违规）；strict changed `20261104123624-d3714e` exit0（34files/0违规）；importable `20261104123624-c29b2d` exit0。
- 测试 `20261104123624-5ca22d` exit1：6failed/111passed/1skipped文件，58failed/1223passed/20skipped测试。58失败均在sync-providers的business_tables、real_flow_smoke及4组realistic_scenarios；当前realistic_sync_harness.ts:69仍注入unused('syncSupport')，此前已按C2分派L23。L20不越权修夹具、不在默认生产hook加fallback。完整日志 `/home/dsdev/.oc-jobs/done/20261104123624-5ca22d.log`。
- 本轮回归在同一门禁已实际通过：integer-internal 4、maintenance-order 3、query-decoding 6、field-merge 26、transfer-commands 11；无本lane失败和Unhandled Errors段。02前述getSafe修复与04 adapter修复得到验证，非沿用405历史数。
- 后续C2 X6清单已落LANE.md，13个AP计数/标题候选核为误报；AP-0407/0408确认原派生字段断言遗漏并补回，待其新提交自检。AP-0401真实state cursor读断言缺口与AP-0415外lane原断言仍待核/修。

- 02：field merge改DbJson/i64精确比较，numeric tag接受完整i64，列表分页前保留bigint，retry/replay精确ID绑定。生产回归先暴露新夹具缺question_id唯一索引，修夹具后又暴露apply-record读取localBefore漏safeIntegers，后者已改getSafe。两个失败如实保留：`20261104120909-2ca01c` 46passed/1failed exit1；`20261104122549-a354e8` 3passed/1failed exit1。末次生产修复尚待新门禁，不拿纯函数绿代替。
- 03：真实kernel logger exporter验证日志/维护顺序。旧job `20261104120311-9f7673` 8passed/2failed exit1是spy不同logger实例；修测试观测方式后 `20261104121748-310fe7` 3passed exit0。原顺序断言未弱化。typecheck `20261104120910-00487f` exit0（早期范围）。
- 04：merge main `84bc8fed7`后正式F3 phase可用，已改prepare/bind/step与逐行解码/flatten。`20261104122734-c89888` 新6例+原列表4例通过，原retry-all因旧测试adapter未实现iterate失败（总15passed/1failed exit1）；已补真实driver iterate，无生产fallback。typecheck `20261104122734-8be5bf` exit2仅新fault query泛型错误，已修正，待新门禁确认。
- 05：TESTMAP退回pending，恢复原3/4→5、原时间和中文目标断言；自写merger用例显式标为supplemental，不再冠原Rust测试名冒充owner。原补充向量/断言保留。Memory公共api仍无merger，正式生产接线仍缺；已投递L17，见R4-owner-requests.md。
- 06：导出改逐token缓冲写，保留create→serialize→flush和原错误类别，原roundtrip追加大整数/REAL/跨缓冲Unicode断言。worker与URI分支仍pending；已向F3请求公共多库只读worker及文件接口。没有使用私有worker实现或async外壳冒充线程隔离。
- 本节新变更最终自检尚未完成；以下405等历史数字不证明本轮修复。按§5提交→merge main→lane-gate后记录真实结果。

## F1/C2 W13 pre-storage裁定响应（最新）

- C2本次续作再次核对提供方分支：F1 generate.ts现已实现唯一storageStartupSync检测、仅paths依赖校验与kernel后显式位置（候选未进当前main），不再列为“F1未编写”。仍未交付的是独立开库+唯一state-owner调用的公开运行时接缝：F3 api.ts仅导出路径，L20b api.ts仅有依赖服务实例的state.resetDefaultAfterLocalPurge，没有可直接import的state工厂/按路径reset函数。
- 最小提供方交接建议（具体符号待提供方命名）：F3公开 `openStandaloneDatabase(path, {profile:'plain'}) -> { db: DatabaseHandle, close():void }`；L20b公开 `resetDefaultAfterLocalPurgeAt(path)`，内部只调用该工厂、既有state-owner reset事务、finally关闭。本lane paths-only入口只取paths.syncStateDatabase（或已集成F3正式path）并调用这个公开纯业务函数，不inject storage/syncSupport/notes、不复制五表SQL。也可由L20b公开state工厂让本lane组合，但仍须同一owner实现。
- 独立入口仍需路径授权或发现规则：允许范围仅sync/，可放sync/startup.ts；F1扫描规则仅根插件index.ts。不能擅建sync-startup/或修改F1代码。请协调者明确入口路径的归属；正式bootstrap落地前不把现有晚期同名provider报完成。

- 接受明确的paths-only bootstrap方案：生成器放kernel固定条目之后、platform条目之前；正常无purge不reset；失败交F3保留marker/恢复状态/不打开业务库；不使用晚期finalizer、不建立storage↔syncSupport环。真实desktop四场景仍pending，已有纯业务reset测试不能替代它们。
- 当前生产仍不是正式bootstrap：dstu.sync的storageStartupSync在依赖storage后才提供，只验证业务委托。正式bootstrap交付时必须从此meta/provide迁出，避免F1“唯一provider且仅inject paths”的检查把它误当合格入口。现阶段不伪造一个没有开库能力的paths-only入口。
- F3实际接口缺口：`git show ds-mig/F3-storage:host/platform/storage/api.ts`确认syncStateDatabasePath只导出路径；未公开可在storage服务发布前直接调用的开库/关闭函数。唯一openFile是StorageService方法。请F3在api.ts公开独立数据库工厂（DatabaseHandle、plain profile/busy_timeout5000、显式关闭）；不能让业务私import storage/database.ts、直引better-sqlite3或复制平台驱动。五表/保upload_seq算法仍留业务所有者，不移到F3。
- 入口发现/权限缺口：当前main及F1分支generate.ts仅扫host/plugins/*/index.ts，未实现本消息描述的bootstrap扫描调整；本lane允许路径仍仅host/plugins/sync/。请F1/协调者选择明确发现sync/startup.ts，或授权新增独立bootstrap目录；本lane不能直接改生成器/desktop.json，也不能把sync/index默认导出替换后丢掉既有命令。F1消息“不约束目录/id”不等于仓库写权限扩大。
- 可复用业务证据保持：state.rs:528-551五张消费表同事务清空，upload_seq/tombstone_event_publish保留；Node405/Electron相关17测试已覆盖成功、幂等、发布序号保留和错误整批回滚。pre-storage开库与真实profile装配未测，不提前签收X4 W13。

## 最新集成门禁修复（main含L10精度修复后）

- 后续main扩展L23测试后完整前缀门禁`20261104112311-61d42a`仍exit1：6失败文件、58failed/1203passed/21skipped，均失败于sync-providers（business_tables、real_flow_smoke及4组realistic_scenarios）；本lane没有失败。`business_tables_sync.test.ts:166`、`realistic_sync_harness.ts:69`仍以unused('syncSupport')注入，真实VFS拥有history表后主hooks确实要调用该服务；需要L23夹具安装真实sync-support而不是提供throwing proxy。本lane不越权修改、不在生产路径静默fallback。完整输出 `/home/dsdev/.oc-jobs/done/20261104112311-61d42a.log`；未声称集成门禁已经通过。
- `20261104112311-b7481f` migration:boundaries exit0，原文 `boundaries: scanned 2403 files, 0 violation(s), 177 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log`。strict独立作业`20261104111005-d93029` exit1（全仓4条，本lane未豁免0），不混淆两个检查。
- 最新main复验typecheck `20261104112311-577ddf` exit0；ledger `20261104105852-f388a2` exit0，原文 `ledger: commands 1058 (A 93.1% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。wiring保持213ported/0未接入、index原生导入ok。

- 首次复现不带尾斜杠的门禁选择器 `host/plugins/sync`（会同时选sync-providers/support）时，作业`20261104111005-30a960`为32failed/911passed/46skipped、5失败文件、exit1。32项下游行apply失败来自本lane S01新reader获取时序，已按Rust note_history.rs:264-266/371-373恢复“无version_id历史表先返回”；不是为测试添加fallback。另1项L23 business夹具缺dataSpaceDeviceId，后续main已修正该外部夹具。
- S01修正后的定向下游复验`20261104112001-04cad9`：本lane apply/note-history及L23 scenarios/regression/deep/hardening共6文件109passed、exit0、无Errors。typecheck `20261104112001-a69d9b` exit0。保留所有原断言，无history库不再误隔离普通notes行；有history库仍用真实syncSupport/notes owner。

- 合入含L10 32e423cb2/3cb9e7770修复的main后，原props_json与大i64 CAS断言不变并通过；不再把它们列为“候选未合”阻塞。S01默认hooks测试安装真实sync+notes+syncSupport，经公开apply验证支撑reader与notes owner收到同一事务，未由测试setDefaultNoteHistory覆盖默认生产链。
- 修复本lane测试夹具：L11已改用F4正式dataSpaceDeviceId，三个真实VFS宿主提供该方法；不把新owner依赖缺失伪装为SQL失败/skip。
- purge-reset新增测试保留seq+2断言，补齐真实markPublishedSeq(seq+1)发布步骤。Rust state.rs:312-331 next_upload_seq只SELECT并计算、:335-357才写upload_seq；先前夹具误把候选读取当已发布。该测试不是原Rust移植断言变更，生产reset实现未改。
- 队列结果：`20261104110810-67d980` 本lane Node全量48文件405passed、exit0、无Errors；`20261104110811-68af68` Electron默认history/precision+purge 2文件17passed、exit0、无Errors；`20261104110810-b542f5` migration:boundaries exit0，0违规。原生入口ok、wiring 213ported/0未接入。
- X4时序仍未签收：reset业务方法已真实提供并验证成功/整批回滚/上传序号保留，但F3 pre-storage purge调用时点仍待正式两阶段接点。不能因为上述状态reset测试通过就称启动finalizer已接通。

## S01 默认链与 X4 W13 新增（当前轮）

- 默认index hooks现显式组合 `ctx.syncSupport.noteHistory` 的只读available/affectedNotes与`ctx.notes.sync`的同事务写面；测试不再setDefaultNoteHistory覆盖默认链，真实安装vfs-repos→notes→sync-support→sync。现有main支撑方完整payload面仍旧WireJson，未将DbJson强转或转Number，也未调用其旧重复写副本。sync内note-history文件已无SQL，只保留格式预检与委托。
- S01新组合测试首轮用revision-only批次，因Rust该分支直接到immutable owner而没有reader调用，作业`20261104083635-fa7c66`多出1条夹具断言失败（总12passed/3failed）；已改为同批实际resource Update+history回放，保留reader/owner同事务断言，未改生产语义。定向`20261104085328-450c2b` exit0：1passed/14未选中，不能写成15项全绿；既有两项L10精度失败未弱化、未重跑冒充消失。
- X4提供唯一业务接点：index实际provide `storageStartupSync.resetDefaultAfterLocalPurge`，并由sync同名方法转发同一对象；算法唯一委托syncSupport.state，无restore-baseline替代，无重复state SQL，无F3硬inject新环。
- X4时序仍需F3解决：lib.rs:1015-1052要求purge文件→reset→检查had_errors→清marker→业务库初始化。当前F3 index.ts:71-75在:106 startup.start内调用reset，而:107才发布storage；sync/support依赖storage，只补晚期provider不能宣称启动已闭合。F3候选registerFinalizer说明是在全部插件apply后运行，不能无条件挪到那里（notes等此前已打开业务库）。需正式两阶段接点或pre-business state-owner可用时点；L20提供的业务方法错误原样上抛，F3负责marker保留与拒绝开库。不得把storageStartupSync加入storage硬inject。

## W18 / SyncPorts 最新装配（覆盖旧轮验证状态）

- 最新最小验证：`20261104081110-06034f` typecheck exit0；Node真实许可/SSOT/审计/锁IO组合 `20261104081110-a69c50` 5passed exit0；Electron组合+run-sync `20261104081110-59b635` 9passed exit0，无Errors行。
- 最终静态门禁：`20261104081613-7ea5f2` ledger exit0，原文 `ledger: commands 1058 (A 92.2% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`；`20261104081612-23bb1e` strict exit1（其他lane4条，本lane未豁免0）。wiring为213 ported/0未接入，index.ts与run-sync.ts原生导入均ok；静态门禁不覆盖下列owner运行时失败。
- owner精度验证：Node `20261104074940-ac2383` 12passed/2failed，exit1；Electron `20261104075922-3d236d` 同样12passed/2failed，另有 `Errors 1 error`（Vitest onTaskUpdate RPC timeout），exit1。两条真实断言失败不是RPC导致，原输出保留；未对未变缺陷重复全套。

- `repository/note-history.ts` 由456行缩为只读编排与所有者委托：关系CAS、retarget/失效、history插入/pin、推断格式写入全部使用 `notes.sync`，同一个apply SqlExecutor传入，不再保留本lane笔记写SQL/块解析器。before/after快照顺序保持，owner异常经SyncError进入原SAVEPOINT/隔离路径。
- `runSync` / `runSyncWithProgress` 直接调用 `backup.syncCommandPorts()` 装配limiter/SSOT/audit；本地仅供tombstones/workspaceCoordinator，application固定await ctx.sync，不再等待L21提供。`SyncAuditRequest`复用backup/api.ts，不维护另一套kind镜像。
- 等待导入仍使用正式backup.acquireOperation('sync',60000)，不消费syncPorts.acquire的lock_io→closed哨兵；tryAcquire抛IO与busy=null区别处理，进度失败仍发failed。新增真实backup组合测试验证共享busy及文件锁IO字符串原样返回。
- 真实owner回归已暴露两个待修缺陷，未改断言：`20261104074940-ac2383` Node note-history 14用例，12passed/2failed、exit1、无Unhandled Errors行。props_json相邻大整数差异未抛不可变冲突；CAS结果9007199254740993n而应9007199254740994n。精确owner位置在PENDING.md。此前全套396通过是委托前结果，不能作为当前W18绿灯。
- owner事务验证通过：委托函数读到未提交after正文，随后故障使整条回滚到before。原5条历史集成断言保留且通过；测试标题/数量不替代S03/S04签收。失败归L10所有者修复，当前保留红测试并报告，不私改其他lane。

## D1–D8 最新交付（覆盖下方旧轮记录）

- 后续L21已合入main，本lane继续推进D2：正式注册 import_sync_data / resolve_record_conflict / rollback_sync_snapshot_batch，公共服务增加同名camelCase入口；直接调用backup.acquireOperation('sync',60000)/tryAcquireOperation('sync')，busy与lock_io按正式reason区分，必需finally release。真实backup+sync插件IPC验证共享互斥、导入等待、业务行应用、失败后重取许可；不是本地mutex测试替代生产锁。
- D2完成后队列全套：Node `20261104072536-e803bf` / Electron `20261104072537-5bf70d` 各47文件396测试、exit0、无Errors行；typecheck `20261104071949-530e01` exit0。ledger `20261104072537-3cf4c1` exit0，摘要 `ledger: commands 1058 (A 92.2% B 7.2% C 0%), tests 8036 (A 78.2% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。strict `20261104072537-1baf5f` exit1仍为其他lane4条，本lane未豁免0；wiring原文 `合计 ported 213，其中所测模块未从 index.ts 接入 0（0.0%）`。
- 当前未注册降为5条：run_sync、run_sync_with_progress、mark_blob_deleted、mark_asset_deleted、list_unsynced_items，均等待main中L20b异步codec。原表的“L21未集成”已失效；不再把L21或多库apply当阻塞。
- TESTMAP更新为213 ported /45 pending /5批准obsolete；两条手动JSON原测试已由正式导入入口接通。writer busy仍pending、三个混合测试按D8保留活跃断言。

- 集成确认：main `f37426009` 已合入本lane公开JSON与多库apply接口，已通过 `git show main:host/plugins/sync/api.ts` 核对第26/108行。下游现在可从main消费，无需私import。L21/L20b新许可/异步codec仍未进入当前main，二者状态分开记录。
- 最终队列增量：`20261104070405-3f1e3b` typecheck exit0；`20261104065723-23cf24` Node D3边界6测试exit0；`20261104070405-a32a4b` Electron同6测试exit0；均无Errors行。全套392测试结果见下，D3新增1用例后只复验相关文件，不虚报全套393。
- 最终ledger `20261104070405-9cae21` exit0：`ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78.2% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。wiring原文：`合计 ported 211，其中所测模块未从 index.ts 接入 0（0.0%）`；index原生导入 `importable: ok`。
- 最终strict `20261104070405-5019d3` exit1：全仓4条（empty-catch3/console-log1），本lane无未豁免行；详见 `/home/dsdev/.oc-jobs/done/20261104070405-5019d3.log`，不掩盖退出码。

- 已自行解决 main 的两个自有路径冲突，合并提交 `a33715097`；后续 main 合入 `eff9956ea`，保留拆分 apply 实现、main 服务新名/按需 notes 获取、真实 notes/vfs-repos 夹具。无旧名测试转发，无 notes 内部仓储 import。合并不再是本 lane 阻塞。
- JSON 最小公开面与多库 apply 已由 `e099f37eb` 及其前置检查点提交；当前 index 确实提供 async `applyDownloadedChangesToDatabases`，run_sync 两条路径 await 后才确认游标。D7不向L21索要application、不添加backup↔sync硬inject。下游从本lane api.ts导入共享解析器，S03仍需R4独立复核。
- L11批量重算已进入main并接入：删除本lane todo缓存更新/清零/echo SQL，index inject vfsRepo，把原IMMEDIATE事务SqlExecutor传给 `pomodoros.recomputeCompletedPomodorosForSyncBatch`；新增失败回滚测试验证同一事务，包含原8条计数断言。支撑方自己的重复SQL由其lane整改。
- SQLite驱动缺失/ABI失败不再被catch→null→describe.skip吞掉；所有本lane条件跳过已移除。L22兼容导出的sqliteAvailable恒true仅在require及真实连接成功后初始化，失败直接阻断门禁。
- TESTMAP：211 ported、47 pending、5 C2-approved obsolete、0 merged。writer实际busy握手仍pending。11条历史/番茄的原断言覆盖矩阵列在TESTMAP，均经公开sync服务和真实SQLite；没有因L20b局部pending一律退回。D8的schema活跃部分已ported，blob UUID完整活跃断言已补；C8和文件命名仍等待文件入口集成，未整条obsolete/未启用dead链。
- D3已执行：内部size/游标精确，仅命令边界转JSON number；无unsafe整数伪阻塞。未同步文件命令另有大u64边界回归。
- 剩余集成：当前main backup/api.ts尚无正式操作许可/SSOT/audit面，sync-support/api.ts仍同步codec；L21与L20b分支已交付，待协调者合入后装配8条未注册命令，不复制其实现。notes.sync已发布，但applyRevision的JSON.parse比较仍丢失R4大整数差异；该所有者需消费公开无损边界后才能替换剩余历史写副本。format.blocks现已存在。
- 作业结果：`20261104061930-69e971` typecheck exit0；`20261104061930-f73e12` 合并定向23测试exit0；`20261104064227-7448af` 所有者接线typecheck exit0；`20261104064227-7f5bcb` 接线定向30测试exit0。完整Node `20261104064641-236f64` / Electron `20261104064641-f1fd82` 各46文件392测试、exit0、无Errors行。
- `20261104062845-91d868` 曾exit2：L22仍导入sqliteAvailable，已以“成功加载后才export true”兼容修正；未恢复静默跳过。
- ledger作业`20261104064641-9f77e8` exit0：`ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 78% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。
- strict作业`20261104064641-ef18f0` exit1：全仓4条未豁免违规（empty-catch3/console-log1），本lane未豁免0。完整输出见对应全局作业日志；不把全仓exit1写成绿。

## C2 最新续作（优先于下文历史记录）

- 已公开并接入生产 service：`sync.applyDownloadedChangesToDatabases(changes, strategy): Promise<ApplyToDatabasesResult>`；两个 run_sync 路径改用该方法。5000ms连接、未知/缺目标库拒绝、跨库已提交保留、Manual 双侧冲突及错误日志均验证。L21 不应复制 repository/apply-databases.ts。
- 已公开单一无损边界：`DbJson`、`JsonFloat`、`parseJsonLossless`、`stringifyJsonLossless`、`dbJsonEquals`、`cloneDbJson`、`sqliteValueToJson`、`canonicalizeSyncValueForCompare`（均从 api.ts 导入）。numeric reviver 缺 source 明确失败；JSON文本和SQL INTEGER、嵌套值、整数/浮点及原始十进制差异均有 Node/Electron 回归。
- `enrichChangesWithData` 的返回类型已更正为 `EngineChange[]`（数据可含 bigint/JsonFloat，元数据可含 bigint），对应运行时既有无损实现。L20b 请使用 EngineChange/DbJson，而非旧仅 number 的 SyncChangeWithData/JsonValue 声明；公开 apply/getPending/enrich 名称不变。
- note-history 测试已装真实 vfs-repos/notes，所有 notes 内部仓储 import 已删除；关系状态改经真实 notes_relation_get IPC，原断言不变。本分支旧 L11 注入由测试专用旧名转发过渡，仅因为 main 合并冲突尚未解决，服务新名本身已发布。
- C2 最新权威状态：199 ported / 64 pending / 0 merged / 0 obsolete；L20b 部分严格为28/12。旧“35闭合”与旧“27 merged”统计作废，六条 pomodoro apply 和 writer busy 握手保留退回，历史5项等待共享生产路径与 R4 复核。
- L21 `BackupService.syncCommandPorts()` 和 L20b async codec 已在各自分支发布；不是接口不存在，而是待集成。syncSupport LWW/history 不能在仍用旧 JsonValue/WireJson 数值边界时直接强制 cast 接入；请 L20b 使用本 API 的 DbJson/EngineChange/JsonFloat 后合入。L10 format.blocks 也仍需公开。X4 startup hook 不增加 storage→syncSupport→storage 硬依赖环。
- 建议 F4 在 R4 确认后将本单一 JSON 边界归入 platform/json，并保留 api.ts 重导出和同一个 JsonFloat 类身份；不另写 parser。本次新增测试不是 S03 全闭合声明。
- 当前验证：Node/Electron 各46文件、391测试通过；typecheck、原生导入通过。wiring 为199 ported、0未接入；strict 本 lane 无未豁免行。main merge 两处冲突已 abort，等待协调者整合。
- 恢复后的复验补充：完整套件仍391断言全部通过，但两种运行时各出现 Vitest `onTaskUpdate` RPC 超时（运行器退出1）；随后最终定向复验 lossless-json-api/apply-databases-api/note-history 在 Node/Electron 各3文件23测试通过、无运行器错误。此前13:38/13:39的完整门禁退出0；不把后续运行器异常写成全绿。

## 已接入

- 静态 IPC 注册：16/24。新增 `detect_prune_gap`；撤下缺少共享全局许可的 import/resolve-record/rollback-snapshot 三条路径。不能把“已有主体实现”当作完整接线。
- 服务改名为 `sync`，导出 `syncService` 版本描述；全部跨插件依赖显式 inject 并从 ctx 属性调用。提供本地 apply/force/conflict-guard、pending/enrich/state/checksum、rollback 引擎、合并、`validateRemoteFormat`、`detectChangeLogGaps`、`validateUploadSchemaCompatibility`、`uploadManifest`。
- L10/L23/L20b 的新服务名已发布。main 的 notes/vfs-repos 去环修正因本 lane 两处合并冲突尚未进入分支，见下文；测试使用真实 L10/L11 插件与测试专用旧名转发。
- 远端格式协商：v3/v4 默认值、未来版本拒绝、30 天兼容租约、全部有效设备升级证明、写前复核、PUT 后结构回读验证。
- 断层预检：先读发布水位再列举分片；合并 raw/hash 设备别名；按实例读取消费游标；检测前缀/中间/尾部缺失，不推进消费游标。
- 已接入 `sync.downloadChanges`：v3/v4 连续下载、完整 operation_id/设备/seq 校验、F7 zstd、legacy PendingChanges、keep-last 去重；返回待确认的游标和 legacy keys，不推进本地水位。现有 dedupe 方法已有真实下载调用，相关映射恢复 ported。
- 已接入 `sync.executeDownload`：上传兼容性门槛、云清单缺失时的 changes 扫描、schema/manual 冲突门槛、统计；重建云实例不读取旧实例游标，下载不确认未应用变更。
- 已接入 `sync.uploadEnrichedChanges`：协商 v3/v4 根、保留上传 seq、compact→zstd→DSBK、可选流式进度及 fallback、size/bytes 双回验后 markPublishedSeq；临时文件成功/失败均释放。
- 新增 `sync.executeBidirectional`（只下载，回传待上传 IDs）、`sync.commitDownloadProgress`（显式确认）、`sync.prepareDeleteVersionsForCleanup`（归档前固化 DELETE 版本）。通过真实 Host 服务测试；与既有 API 增补兼容。
- F4 `time`/`util` 合入后已替换生产代码的本地 RFC3339/灵活时间解析、trim 和 UTF-8 字节长度实现。保留领域 ID 格式适配。

## 本轮修正的等价性问题

- 标准 blob 与资产同步、三类墓碑发布及 blob/asset 删除编排已补齐；真实生产入口等待 `AsyncBlobTombstones` / `AsyncAssetTombstones` / `AsyncTombstoneWriter` 与 L21 共享许可。原测试经生产函数验证，未提前注册或提升 TESTMAP。

- Linux 续作：已补齐只读未同步清单聚合、文件对象流式 E2EE 与完整 workspace 同步；`src/tombstone-needs.ts` 明确两个异步墓碑读取端口需求。工作区原测试 7 项 + 文件传输 5 项通过；尚无兼容的 L20b 生产端口，相关 TESTMAP 保持 pending。
- 补齐 `run-sync.ts` 两个入口、三个进度阶段、普通同步阶段、本地写命令许可外壳；依赖端口未提供前保持未注册。进度解析失败、busy 不发幽灵 preparing、未来 format 零租约写、许可/状态钩子清理均有行为测试。
- 发现并修正 Buffer.slice 的共享内存偏差：明文 codec 改为 Uint8Array.from，对齐 Rust to_vec；故障注入用独立字节副本，已验证同长错字节不能通过上传回验。

- JS `split('-', 3)` 改为 Rust `splitn(3, '-')`：保留完整 UUID operation ID。
- u64 解析检查上界；序号递增采用饱和语义；清单时间比较保留纳秒，内部时间解析拒绝数字时间戳。
- format 的默认字段只在缺省时补默认，非法类型/null 拒绝；`min_client` 与 alias 同时存在拒绝。
- format 回读按结构比较，HashMap 键顺序不影响结果。
- DSBK 在缺少 secrets 服务时仍能识别并拒绝无密码解码；加密器按 Rust 懒初始化、并发复用、结束释放密钥。
- 保留损坏设备清单 warn 后继续，与解密错误必须中止的区别；格式协商日志经插件 logger。
- 修正 checksum 的 SQL 表达式列名：`quote(column)` 必须别名为原 column，F3 对象行才能读取值。原实现会把数据都读为 undefined，导致正文变化漏报；完整 Rust 原测试已通过。
- 手动 JSON helper 补齐 exported_at 必填验证、先 create 再序列化的顺序、IO/解析/编码错误分类与命令日志；两个原测试已移植，但由于导入入口等待共享许可仍保持 pending。
- 完成两设备笔记历史集成测试：未来格式整批拒绝、传输依赖不含本地 seq 且含 pinned、before/after 历史保留、L10 restoreCopy 可恢复 before。
- 完成未同步文件的四个原分类/合并测试；无生产入口前保持 pending，不通过无意义导出来提升 A。
- registry 预检六个原测试已通过并接入两个顶层函数；顶层尚未注册，映射继续 pending。
- 修正变更元数据 source_seq/change_log_id 的 bigint 精度、检疫 u64→i64 失败后的 fallback，以及 DELETE 版本读取的 safeIntegers，避免同序号迟到 UPSERT 复活记录。

## 实际依赖阻塞与剩余工作

- 2026-11-04 后续 main 合并在 `repository/apply.ts`、`tests/note-history.test.ts` 冲突，已按协议 abort。main 的 `8176f4199` 解除了 notes/vfs-repos 注入环，待协调者解决合并；本分支测试仍以测试专用旧名转发接真实插件。
- 三类文件级同步的合并、删除、队列与进度编排均已实现；L05 `WorkspaceCoordinator.enterMaintenanceMode/exitMaintenanceMode` 已发布并通过公开类型消费，未把这项列为外部缺口。

| 命令 | 当前缺口 |
|---|---|
| `mark_blob_deleted` / `mark_asset_deleted` | L20b async codec、L21 共享 try-acquire 已在提供方分支发布，待集成。 |
| `list_unsynced_items` | L20b 异步读取已发布待集成；本 lane 分类/合并与聚合已实现，另有 IPC u64 表示待协调。 |
| `run_sync` / `run_sync_with_progress` | 函数及文件/行/进度编排已实现；L21 共享许可/SSOT/审计与 L20b async codec 待集成；跨库 apply 已公开。 |
| `import_sync_data` | L21 已发布共享等待许可，当前分支待集成，IPC 保持未注册。 |
| `resolve_record_conflict` / `rollback_sync_snapshot_batch` | L21 已发布共享 try-acquire，当前分支待集成，IPC 保持未注册。 |

上表8条命令保持未注册：当前工作树的提供方仍是旧接口，最新提供方分支已经补齐许可/codec，不再列为“未发布”。main 两处冲突需协调者整合；不能私导入 operations 或用明文 codec 绕过。

64 项 pending 的逐项证据见 [PENDING.md](PENDING.md)：含 C2/R4 退回与共享路径复核、跨 lane 集成及死代码/禁用快照分支待裁定。未自行标 obsolete；本 lane 尚未全部达到 A/B。

供 L20b 对接的 `SyncCursorStore` 已从 `sync/api.ts` 发布：`bindInstance(instanceId, provider, endpointHint)`、`cursors(instanceId)`。打开/关闭持久化仓储仍归调用方，预检本身不写游标。

## API 与 DRAFT

DRAFT 的 `SyncManager` 落为无状态 `sync` 方法，logger/笔记历史钩子由插件注入。远端方法接收 L23 `CloudStorage`；codec 实际算法复用 F4。本轮文件/命令函数已编写，但公共服务不暴露尚缺真实端口的高层操作。api.ts 另导出异步墓碑、共享许可、审计/SSOT/apply 的最小消费类型，供 L20b/L21 对齐。

没有修改能力目录、profile、契约、其他 lane 或依赖安装文件。

## 数值与原实现差异待协调

- 引擎清单与 seq/cursor 使用 bigint 保留 >2^53；目前 F1 kernel 明确拒绝 IPC BigInt，生成的 `DatabaseConflictResponse`、`PruneGapResponse` 是 number。需 F1/契约协调确定大整数 wire 表示；当前清单 JSON 字符串保留精确整数。
- 手写结构校验与 JS JSON parser 的内层错误文字尚不能逐字匹配 serde_json；外层 Rust 步骤上下文已保留。此项不能视为已完成严格错误文案验收。
- Rust `parse_change_key` 只在首段恰好 12 位时认作 seq，而格式化宽度是最小宽度；大于 12 位的 seq 会走 legacy。当前保留 Rust 行为，未擅自改变协议。
- Rust 普通同步执行分支里的 `?` 会提前返回，绕过其后写出的 Err 审计分支；当前保留这一行为，不强行补失败审计。进度入口则返回失败响应并发 failed 事件。
- 无新增 npm/native 安装需求；zstd 消费已发布的 F7 nativeCompression。

## 验证与统计

- 当前 Node/Electron 各 **46文件、391测试通过**；保留所有原断言。typecheck 与原生入口导入通过。
- wiring：`合计 ported 199，其中所测模块未从 index.ts 接入 0（0.0%）`。strict 本 lane 未豁免违规0；旧允许项没有被用于吞掉新日志。
- TESTMAP：263行；199 ported，0 merged，64 pending，0 obsolete；最新28/12支撑模块映射覆盖过期统计，完整待办清单见 PENDING.md。
- ledger 命令 A=16/24（66.7%），B=0%；未注册的8条命令不提升。全仓仍有250条测试问题，原始摘要见本轮回复。
- ledger 最终摘要和 wiring/strict 原始输出见本轮回复；A 由脚本计算，不手写 ledger 文件。
- reviewer-owned ACCEPTANCE 尚缺，未自行提升 B。
- Node/Electron 全插件测试、typecheck、Node 原生类型擦除入口导入已验证；strict：L20 无未豁免违规；全仓仍有其他 lane 的 strict/ledger 问题。
- 本轮显式里程碑：`472e48a5c`、`6e83c76ef`、`2db71e259`、`c190fbefb`、`4a4c68be2`、`c869d99e7`、`ceeba00a4`；实现还由协调者多次 WIP 检查点保全，最终收尾提交见本轮回复。

## 2026-11-05 缺口工单（20:10 生效）：44/46 映射与移植

- 工单缺口 46 = 37 同域强匹配 + 9 真移植。完成 44 行：37 A 全部逐条比对断言/边界后改 `ported:`；D 中 7 条经等价核验映射（其中 3 条 Rust 为 source-contract，用真实行为用例等价覆盖：`regression_c8_upload_path_verifies_size`、`progress_v2_download_paths_enforce_prune_gap_check`、`deletion_queues_never_permanently_abandon_failed_entries`），另真移植 `state.rs::tombstone_sequence_waits_for_writer_before_reading`。
- 新移植细节：真实双连接同一 `sync_state.db`，writer `BEGIN IMMEDIATE` + 未提交插入，contender `busy_timeout=500` 调 `reserveTombstoneEventSeq`；断言等待 ≥300ms 后才 `SQLITE_BUSY`（deferred 升级会立即失败），writer COMMIT 后重试得到 seq=2。job `20261105120739-0bdfb0` 5 passed。
- X1 真缺陷：`importSyncDataCommand`/apply 后置钩子读 `ctx.mastery`，plugin 未声明；`index.ts` inject 追加 `mastery`（review 提供且只 inject storage，无环），未改行为/替身。job `20261105115506-7c5392` 9 passed。
- 合并 main 的测试适配：L10 notes 注册进程级 deletion journal Slot，且 sync-support inject notes，同进程不能有两个 notes 实例；`note-history.test.ts` 改为把 target 已 apply 的关系行复制回主 host 后经公开 `notes_relation_get` 断言，不跨插件 import、不建第二个实例。
- 剩余 2 行 pending（WP-004 更正）：`file_and_snapshot_keys_are_neutral_ids` 的活跃 blob manifest 断言待后续复核，snapshot 子义已按 D8 退休，无需实现；`regression_j8c_resources_data_merges_learner_profiles` 的 merger 已在 main `memory/api.ts:60` 公开，待 L20 消费与原向量验证，不再归因 L17 缺 API。本包按 brief 不扩做这两项映射。
- 跨 lane 提醒：inject `mastery` 后，L23 `realistic_sync_harness.ts` 等直接安装 sync 的测试需补 `provide('mastery', ...)`，否则 Cordis 必需 inject 会拒绝安装。
