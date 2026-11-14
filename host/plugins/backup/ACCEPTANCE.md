# L21-backup-governance 独立验收（R4-review-sync，2026-11-04）

结论：不通过

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。TS 路径相对 `host/plugins/backup/`；Rust `commands*.rs` 相对 `src-tauri/src/data_governance/`，`backup/mod.rs` 相对 `src-tauri/crates/dstu-sync/src/data_governance/`，`backup_job_manager.rs` 相对 `src-tauri/crates/dstu-sync/src/`。契约：`contracts/ipc/L21-backup-governance.json`。

**2026-11-04 P03 联合探针补充**：本次只配合L23复核了L21候选 `46bb99a298b7b3920b51c0b8ad6a163e46414a97` 的公开guard，未重跑L21全套、未签收B组整体修复。原B组描述仍为首次基线；新增共享许可、必需release API已观察到，候选与L23的大小写/错误形状仍不兼容，详见§5。11个B组保持待独立签收。

**更新：最新候选e4dd1772f联合复核**：固定L21=`e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`、L23=`1da6dadc5580a6ff9a6cfe59abf1a3a77aef7e1c`；kind方向再次变化（L21现在snake_case、L23现在大写）。同一kernel的真实提供方忙锁/IO传出CommandError(string)，L23透传后得到 `must be object` 契约错误，不再是上轮的HandlerPanic，但仍不等价。许可在配置失败和真实下载成功后均可再次取得，局部释放通过；本次仅§6新增组合证据，不关闭B01/B02/B03整组。固定main15b23540a仍无该新API。

**B组定向签收更新**：按C2申请，对同一固定e4dd树新增复核B01/B02/B03/B08/B09（含2a3738008/31ad462b2）。**B01、B08在该候选树已修并勾选；B02/B03/B09仅部分通过，九个B组仍未决。** main可见性另固定为 `f67db20801c2d787a06f3277f9afd9499dc30fac`，e4dd尚非其祖先；不将候选签收说成main已可用。下方这五组以最新子项为准；其余组保留首次证据/待复核状态，§1–§6为历史证据，§7为本轮作业。没有重跑旧P03组合或L21全套358例。

**后续增量19c023cd6**：新提供方OperationGuardError已携带AppError对象，真实忙锁/IO的新增用例通过，B03该提供方子项签收进展；与最新L23 cb9d683d0的Node原生组合被L23参数属性阻塞（exit1），尚无新的真实组合结果。e4dd字符串wire反例保留历史，不描述为19c提供方当前行为；B02/B09实现未变未重跑，九个B组保持未决，见§8。

**正式main d5cd234aa更新**：协调者指定 `d5cd234aa8a919807b65eeca250e5567cc527f95` 已含19c结构化许可；L23 `624cfe251` 包含该main并直接消费backup/api.ts。新真实持锁/锁目录IO分别得到Validation/FileSystem完整对象，真实上传账本kind=backup、成功后可重取许可，见§9；原“尚未进入main/真实组合被语法阻断”只属旧基线，不再作为当前要求。B03跨进程原语、排队取消等未决仍保留，B02/B09未变不重跑。

## 必须修复

**B06 / L21-D3-AUDIT-DETAILS质量口径（main536aad095，§19）**：当前main仍以it.skip.each禁用两个合法arbitrary_precision正例；C2明确未授权skip，pending只是完成状态。L21候选91067dab2已恢复it.each，原输入/精确重存断言不变，现成Node/Electron回执各2failed/4passed，仍需F4＋L21联合修复。旧450passed/2skip或R4的39passed/2skip不构成完整Value签收。

**B05组合回归限定复验（mainc6309183c，§18）**：650dd fulltest新增四项均因旧fixture缺registerMaintenanceParticipant在安装L11时失败。ecff33220已将三份受影响测试接完整真实F3；R4主线003031-628a63四原红项通过、exit0/38标题过滤skip，原断言/预算未改。维持B05原所有权签收，不扩大为全部恢复/启动或全套绿；其余父组未决保留。

**最新main复验与状态订正（90538c240，§16）**：B09已消费F3真实phase并通过真实FK prepare错误回归，原错误阶段/收尾finding签收。B06的四个迁移后registry/依赖测试已移除latestOpener，真实迁移→实际SQLite历史→生产聚合已通过，签这四个子项。两修复在5b1时已存在，上一轮未决摘要沿用旧描述，现明确订正；旧反例仅属原树。当前backup未决为B02/B03/B06/B07四组。

**最新main补核（5b1b19055，§15）**：B02真实F2启动等待/精确120秒超时已签收；外部F3维护租约的状态漏报由独立作业210356-780ffc证实，仍不关闭B02。B05真实syncSupport恢复激活消费已由main注册finalizer测试闭环，原表所有权问题签收；当前未决为B02/B03/B06/B07/B09五组。历史计数保留为对应旧基线。

**B06历史子项进展（main74252e624）**：a8fc93a40将三个dependency报告用例改测正式MigrationCoordinator.checkDependencies，原MigrationError变体/ID与两组成功报告fixture已逐行核对，主线195643-18bfdd的migrations-metadata19/19通过。§14的空文件+latestOpener证据针对当时所读旧文件；当前main已由6d0c88509替换为真实迁移，见§16。B06剩余初始化/策略等真实性问题仍未闭合。

**正式main闭环（最新，306eb8bbb）**：3f10668bd及其实现前继已入main；main业务/回归文件与已验证090d候选无差异。复用亲跑主线门禁20261104142355-6832bc中的acceptance-fixes **32/32通过**，确认§12新增7条已在main实际执行，未再排队。**B10按原finding列明日志点、B11按已记录错误顺序/上下文问题转main签收**；门禁整体仍exit1，不冒称全分支通过。当前B01/B04/B08/B10/B11五组已签收，余B02/B03/B05/B06/B07/B09六组未闭合，详§13。

**B10/B11新候选（最新）**：固定`090d225cb7445b774b6991991b79a38b0e427a8f`（含3f10668bd），相对固定main16a确有新增logger与列表错误包装。亲跑7条新增生产入口断言全部通过（20261104135156-ee95cb，7passed/25过滤skip、exit0）：验证/恢复坏清单warn三入口、取消请求顺序、健康开始info、空间汇总info及旧ENOTDIR前缀/error日志。候选未main，总框保留；下方旧缺口不覆盖该候选进展，详§12。

**v2 main复验（固定 `eeaf5bdc7ae95a336c34b3a75b19f844726fe064`）**：B01/B08已在main复验；B02既有维护租约借用和release首错/重试、B03排队取消、B09违规诊断及iterator收尾通过，原反例只描述旧树。B02启动状态、B03跨进程原语、B09完整prepare/bind/step分类仍未关闭；下列对应子项及§10为最新状态。未重跑368例。

**后续B04/B11 main最小复验**：固定main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`，backup与eeaf无差异，但B04/B11相对首次f23基线确有尚未签收修复。作业20261104115609-eaa58a五例通过；真实F3双故障探针20261104115805-ab41d2确认审计连接优先已修、空间检查列目录错误前缀仍缺失，原exit1保留。**B04签收，B11部分签收；B10按源码逐点更新仍不关闭。** 目前八个B组未闭合，见§11。

- [x] **B01 复核确认：本lane字符串Err命令出口已修（e4dd候选）。** `index.ts:100-127` 的stringErrorCommand把普通业务Error转换为CommandError(string)，显式将TypeError/RangeError等编程异常透传；所有error:string注册使用wrap（`:201-291`）。5条真实invoke精确断言通过：incremental拒绝、审计status、清理token、未知databaseId、非法backupId（`tests/acceptance-fixes.test.ts:59-102`，作业20261104063704-2fbc80）。Rust `commands_backup.rs:1746-1748`、`commands.rs:537-567,610-616,1013-1022`。该关闭仅限原B01的字符串命令出口，**不涵盖B03/P03跨服务需要AppError对象的错误契约**。
- [ ] **B02 部分修复：真实F3屏障、既有租约借用、release重试及启动等待已签收；外部维护状态漏报仍在。** 下列旧子项行号指各自基线，最新证据见§15。
  - [x] **真实写阻断已核实**：`src/operations.ts:253-297` 调用F3 enterMaintenance、再进入工作区；run_backup在staging之前enter、之后release（`src/backup-commands.ts:278-300`）。独立探针不替换F3 enterMaintenance：已持有VFS句柄写入与新database借用均抛MAINTENANCE，备份完成后写入恢复（作业20261104064052-6f8b96）。不能再描述为纯UI标签。
  - [x] **既有维护模式借用main已修**：eeaf `src/operations.ts:78-82,363-371` 匹配真实F3的StorageError/code=MAINTENANCE/database=mistakes/确切already-in-maintenance文案；DATABASE_NAMES首项就是mistakes，进入其它库前即返回无退出权的屏障。`tests/acceptance-fixes.test.ts:200-214` 使用真实StorageServiceImpl先持有外部lease，run_backup完成后原库仍不可借用，只有外部owner release后恢复。作业20261104111500-ac6715通过，对齐Rust `commands_backup.rs:1098-1104`。
  - [x] **release首错与同调用重试main已修**：eeaf `src/operations.ts:410-442` 首次退出失败后立即再试，仍抛第一次错误；第二次也失败才error并保留blocked。`tests/acceptance-fixes.test.ts:216-249` 包装真实lease仅注入首次release故障，实际底层屏障仍生效；亲跑验证两次尝试、job仍failed且首错保留、随后库可用。对应Rust release失败后的Drop再次尝试；无需另强求dispose调用形式。
  - [x] **上述回归已换真实F3**：eeaf `tests/acceptance-fixes.test.ts:67-94,146-249` 不再用本地布尔模拟enterMaintenance。正常写阻断沿用旧独立真实F3证据，本轮只跑新增借用/重试；其它helpers替身不能用于扩签未覆盖的工作区/启动路径。
  - [x] **启动等待main已修**：e4b5bbdaa接入真实F2 startupGate；`index.ts:242-250`先等待120_000ms再查询。startup-readiness三例通过真实invoke验证未ready阻塞、ready放行及精确120秒错误，主线195643-18bfdd、203745-e6de2c均3/3，详§15。
  - [ ] **外部维护状态main仍漏报**：5b1的`governance.ts:437-446`仅取Operations数组。真实F3外部`enterMaintenance(['mistakes'])`后database借用已抛MAINTENANCE，命令却返回false/[]；独立作业20261104210356-780ffc原exit1。Rust `commands.rs:440-488`检查实际组件维护态，不能因启动等待通过关闭此项。
- [ ] **B03 部分修复：共享许可/超时主体有效，错误契约、排队取消与跨进程等价未闭合。**
  - [x] **复核确认**：模块级queue/active，backup/governance/SyncPorts共同委托同一Operations（`src/operations.ts:75-78,158-246`、`index.ts:53-96,155-165`、`src/sync-ports.ts:55-72`）。亲跑 `tests/operation-and-sync-ports.test.ts:36-113` 覆盖9种kind、跨服务互斥、等待取得、1秒超时不补授以及sync limiter，不是supplied guard替身；作业20261104063704-f51a4e通过。
  - [x] **结构化失败/kind的真实组合复核确认**：d5cd234aa正式main提供方与624cfe251消费者共用同kernel，实际持锁及锁目录IO的invoke得到Validation/FileSystem完整AppError，真实加密上传账本kind=backup、完成后再取restore许可成功。消费者直接import正式api.ts，镜像/猜文案已删。证据为作业20261104074838-775a11前段成功断言；其末段复核者即时取消预期错误造成exit1，完整归因见L23§11，不把整作业写成全绿。供方锁原语及底层IO Display保真不包含在此消费侧签收。
    - [x] **19c023cd6提供方修复复核确认**：`src/operation-errors.ts:39-79` 的value/app_error为相同完整AppError，busy→Validation、lock_io→FileSystem，附稳定reason/code；`src/operations.ts:64-86` 按已知AppError类型转换，普通Error继续抛。新增真实provider忙锁/IO用例在作业20261104070640-d367ed通过。以上未勾选的旧e4dd描述只作历史；与cb9消费者实际组合因加载失败尚未验证，所以B03组合子项暂不关闭。
  - [x] **备份队列等待取消main已修**：eeaf新增acquireForJob的200ms轮询，由备份/恢复/ZIP任务消费；亲跑 `tests/acceptance-fixes.test.ts:298-324` 在原holder未释放时取消已settle，job为cancelled/用户取消任务，且未越权释放holder、释放后可再取许可。作业20261104111500-ac6715通过。测试允许450ms调度裕量，不声称实测严格200ms上界；Rust `commands_backup.rs:980-1016` 轮询间隔与源码一致。
  - [ ] **跨进程原语仍非fs2等价**：`host/platform/storage/backup-common.ts:380-415,428-436` 实际用wx锁文件+PID存活、release删除文件，Rust `storage/backup_common.rs:244-266` 用文件advisory lock。当前用例 `tests/acceptance-fixes.test.ts:167-184` 只验证同进程两个host及文件存在/消失，不证明跨进程互操作/原有无锁账本兼容；须联合F3修复/提供原生原语证据，不能以本轮互斥通过签收整个B03。
- [x] **B04 正式main复核确认：includeAssets完整恢复点门与全非法assetTypes默认回退已修。** 4c6c `src/backup-commands.ts:300-307`在屏障release之后、任务成功之前对includeAssets调用validateForSlotRestore，对齐Rust `commands_backup.rs:2023,2039-2045`；`src/backup-manager.ts:383-392`过滤后为空即默认集合，对齐`:1977-1997`。亲跑`tests/acceptance-fixes.test.ts:328-352`：显式只选images导致非槽恢复完整快照时job.failed；全非法集合回退后job.completed且images/documents覆盖为absent而非excluded。作业20261104115609-eaa58a exit0。manager仍允许partial是原能力，不再误当作命令会报告完整成功；本关闭仅限原B04两项，不替整套资产/加密/恢复语义签收。
- [x] **B05 原表所有权与恢复激活真实owner消费main已签收。** 首次sync_state/VFS平行SQL证据属于f23，保留§1–§4；VFS接缝已在main16a核实，5b1又以实际注册的F3 finalizer及真实syncSupport状态数据库完成恢复激活闭环（§15）。本项不扩大为全部恢复错误/启动流程验收。
  - **D1/D4裁定对齐（main e303957124）**：已允许所有者业务 `*WithConn` 接收同一SqlExecutor，由调用方开启并传递原子事务；B05不禁止该接缝。未决依据仍是backup自己写他表及复制所有者逻辑，不能为单写者而拆掉原Rust事务（`decisions.md:106-110,123-124`）。
  - **e4dd状态说明**：sync-state本地文件已删除，恢复激活改调syncSupport.state（`src/restore-commands.ts:178-191`）；这是源码进展，本轮未验证完整恢复消费链。VFS写SQL仍保留，TESTMAP:64-65仍pending，恢复执行两测试不构成临时越权SQL获准，整组不关闭。
  - [x] **main16a VFS表所有者接缝已核实**：`backup-manager.ts:638-667`的prepare/finalize委托正式`vfsMaintenance.resetRebuildableIndex(targetDir)`；L11负责目标库、事务、重置SQL及close。既有正式main门禁20261104132355-e8e497中backup-manager19例、restore11例通过，包含两条真实L11组件恢复测试；本轮逐行核测试确实安装真实L11，未重复排队。只签B05表所有权及所列恢复结果，不签所有者全部错误/锁时机语义。
  - [x] **恢复激活真实owner组合已签**：旧restore.test的调用记录替身不足为证这一判断保留；新增`startup-finalizer.test.ts:103-131`通过正式storage.runStartupFinalizers执行backup注册回调，真实syncSupport写轮换历史并清游标/legacy/watermark，真实paths落盘身份，marker/lease清理及重复runner断言通过。主线203745-e6de2c该文件3/3；事务在owner `state.ts:217-224`内完成，顺序与Rust对应，详§15。
- [ ] **B06 多条 ported 测试不测生产行为或改变原断言。** 首次f23的`tests/migration-behavior.test.ts:203-355`在测试内重写InitializationReport、ensureDirectories、initializeWithReport、维护策略、可中毒RegistryStateHolder；对应原测试测生产函数（`init.rs:370-460`、`commands.rs:1437-1450`）。当时test_initialize_without_feature把应失败改成功，缺真实等价覆盖；merged本身不要求另行审批，不能将“没有merged批准”作为缺陷。后续撤回/删除情况见下面子项，不能用旧代码描述新树。当前main初始化/策略副本及未闭合的原断言覆盖仍待复核；after-migration假opener已在§16关闭，不再列作当前缺口。
  - **e4dd状态说明**：原init测试describe块及RegistryStateHolder已删除，对应7+1行退pending（TESTMAP:160,223-229）；并非所有本地初始化helper均已删除，`tests/migration-behavior.test.ts` 仍保留InitializationReport/initializeWithReport/策略函数供其它测试使用。B06主体仍待完整入口验证；本轮未凭REPORT“全部删除”自述关闭。
  - [x] **迁移依赖报告三用例main已修**：a8fc93a40改为正式MigrationCoordinator/CoreMigrationReport，原错误变体与两成功fixture均对齐，195643-18bfdd中文件19/19通过；这三项签收见§14，后续after-migration独立闭环见下一项及§16。
  - [x] **四个迁移后registry/依赖用例main已修**：6d0c88509去掉latestOpener与空文件夹具，正式F3 worker运行runAll，再用真实handle读生产aggregateSchemaRegistry；四库数/正全局版本/状态存在/实际集合最新版本及依赖成功完整。211150-fa2d6b文件19/19通过，§14该子项转历史（§16）。
- [ ] **B07 正式main完整运行已原exit0，Rust账本仍有10条pending。** 首次333通过但RPC Errors=1/exit1及e4dd旧范围保留§3/§7，不能继续把旧RPC错误当当前main现状。本轮官方main677f作业20261104161616-fddb22原exit0，backup25文件400例全通过，无额外Errors；不是采信owner自述或基线豁免。当前账本313ported/10pending及B06真实性仍未闭合，故B级总框保持待办，不用绿色运行覆盖未移植测试。
- [x] **B08 复核确认：选择→验证→审计全程持有原许可（e4dd候选）。** `src/backup-commands.ts:187-230` 已在list之前acquire，try内选择/验证/审计/构造返回，finally才release。原最小用例 `tests/acceptance-fixes.test.ts:217-230` 通过；独立真实F3+L21 probe在等待期间才新增备份，返回选择该备份，audit真实INSERT时另取许可被拒，命令结束后可再取许可（作业20261104064219-4aad86）。对照Rust `commands_backup.rs:1512-1535,1572-1605`，原B08竞态修复；B03其它锁问题另列。
- [x] **B09 原只读/FK收尾/prepare-query-step分类问题main已签收。** 最新90538的正式F3 phase提供方与1783a548f消费者均已存在；真实FK mismatch通过kernel得到准备失败，而非笼统首行读取失败。以下历史反例和已签子项保留，新增闭环见§16。
  - [x] **复核确认**：`src/governance.ts:334-350` 明确readonly=true/busyTimeoutMs=5000/mustExist，open与quick-check上下文保留。原用例实际经Connection传递readonly选项，亲跑通过；独立探针进一步使用真实StorageServiceImpl/SqliteDatabase路径。
  - [x] **FK违规诊断与收尾main已修**：eeaf `src/governance.ts:347-375` finally先rows.return再storage.close，close错误不覆盖已存在的主错。真实F3孤儿外键用例 `tests/acceptance-fixes.test.ts:391-411` 亲跑得到精确“数据库完整性检查失败: 检测到外键约束违规”、无busy，作业20261104111500-ac6715通过。旧busy反例属于旧树。
  - [x] **阶段分类main已修**：eeaf时无phase的首next反例保留；当前`connection.ts:133-145,205-228,242-248`在真实prepare/bind/step边界附phase，`governance.ts:386-392`按prepare→准备、bind→执行、execute/其它→读取映射。真实FK缺唯一键回归精确验证准备失败，211150-fa2d6b通过；不再以旧generator结构推断仍无法区分阶段（§16）。
  - [x] **新增真实平台坏FK回归补上原漏检**：上述测试调用setupStorageServiceHost，实际运行SQL并精确断言违规消息；不再以没有“只读打开失败”作为全部FK通过证据。只读profile仍由373-389用例与源码覆盖，本轮没有重复该未变化用例。
- [x] **B10 原finding列明日志漏项main复核签收。** §11保留4c6c当时源码缺口；其后§12逐点审读及7条候选生产入口断言，现由main相同实现和32/32门禁回归完成闭环。不将本组签收扩大为全仓/所有未审日志正确。
  - [x] `backup-commands.ts:60-87`的getBackupList明确传warn，list/delete失败调用host error；`backup-manager.ts:62-72`保留坏manifest/ID不匹配警告。原“get_backup_list全部静默”不再用于当前main。
  - [x] `index.ts:210-214`取消失败warn/成功info；`governance.ts:226-229,260-265,291-314`迁移pending、健康依赖/问题/汇总日志；`jobs.ts:157-161`非法转换warn与job_id/前后状态已补。
  - [x] 原两个process.emitWarning本地副本已删除：sync-state.ts删除，vfs-restore.ts的resetSyncBaselineAfterRestore删除。只签原代码不再存在，不据此关闭B05所有者/整链日志。
  - [x] **manager警告真实消费链main已补**：验证/带资产验证在`backup-commands.ts:145,180`、恢复在`restore-commands.ts:424`显式传host warn，三个真实kernel入口的坏兄弟清单警告回归通过；与Rust `backup/mod.rs:5720-5730`同级别/关键字段，不只是新增参数未使用。
  - [x] **空间检查及业务info main已补**：空间列表失败error与前缀、statfs失败error、汇总info已在实际路径；取消请求info早于结果、健康开始info亦恢复。§12的7条新增断言在主线acceptance-fixes32例中通过，对齐Rust `commands_backup.rs:1340-1343,1373-1383,2254`和`commands.rs:829`。
- [x] **B11 原四项及列表失败上下文main复核签收。** 已记录各错误顺序/文案/目录类型反例均闭环；历史exit1保留，不泛签本lane所有未知错误路径。
  - [x] **审计连接优先于status校验**：`governance.ts:122-136`已按Rust `commands.rs:537-554`先取连接。真实StorageServiceImpl对audit建立维护lease，同时传status=invalid，kernel返回“获取审计数据库连接失败: Database audit is in maintenance mode”，非状态错误（20261104115805-ab41d2前段断言通过）。
  - [x] **空间检查缺备份文案**：`backup-commands.ts:94`传“未找到备份”，精确断言`未找到备份: missing-backup`通过，对齐Rust`:1345-1348`。
  - [x] **删除缺失前缀**：`backup-manager.ts:111-115`保留`File not found: 备份不存在:`，经真实invoke断言通过，对齐Rust BackupError::FileNotFound。
  - [x] **目标目录类型/canonicalize**：`backup-commands.ts:98-108`先isDirectory，再realpathSync再statfs；目标为普通文件时invoke拒绝用例通过，路径解析顺序与Rust`:1363-1375`源码对应。
  - [x] **空间检查列目录失败main已修**：`backup-commands.ts:94-100`先list并包装，`backup-manager.ts`恢复BackupError::Io前缀。原根目录为文件反例在main精确返回`获取备份列表失败: IO error: Not a directory (os error 20)`且有error日志。旧20261104115805-ab41d2 exit1仍是有效历史；当前签收据main真实回归而非B01字符串出口推断。

## 建议

- [ ] 删除 `index.ts:103-105` 的旧 `sync.provider@1` 回退，协调好 backup/cloud-config/provider 依赖拓扑；不要直接加双向 inject 形成循环。
- [ ] 增补真实插件组合下的快照屏障、错误载荷与共享 guard 测试。仅直接调用类方法不能发现 B01。

## 已核实通过

以下为首次基线核实事实；e4dd候选的新通过子项以B01/B02/B03/B08/B09及§7为准，不混用旧行号/统计。

- [x] 33 条契约命令均在 `index.ts:58-76` 声明，注册覆盖 `:100-167`；本次详查下表 17 条，并追踪 run_backup 的后台主链。
- [x] `backup/governance/cloudConfig` 名称、版本描述及实际 Service/provide 一致（`api.ts:113-125`、`index.ts:23-25,42-52,57,80-88`）。
- [x] 扫描 29 个生产 TS 文件，未见 console、跨插件非 api.ts import、tests/fake import；入口仅接线，业务在 src。表所有权问题另见 B05，不能由 import 扫描洗掉。
- [x] 旧 restore_with_assets 入口仍按相同中文消息拒绝，且正确用 CommandError（`index.ts:109-111` 对 `commands_asset.rs:117-125`）。
- [x] ZIP 密码纯函数的大多数成功/兼容分支确实执行生产实现，未以假 crypto 代替本次抽查对象（`src/zip-commands.ts:43-86`；详见 16 条用例表）。
- [x] importable、静态 wiring 均通过；两次 Vitest 的 333 个断言均 passed，但均非成功退出。

## 1. 命令等价逐项审读（17 条）

| 命令（均带 data_governance_ 前缀） | 结论与 TS 文件:行 | Rust 对照 |
|---|---|---|
| get_maintenance_status | 问题 B02：省略启动等待/真实 blocked/健康；`src/governance.ts:360-368` | `commands.rs:431-493` |
| get_schema_registry | 返回字段及实时刷新主路通过；失败受 B01 影响，`src/governance.ts:73-113` | `commands.rs:500-523` |
| get_audit_logs | 问题 B01/B11；默认 limit=100、offset/status 可选与返回 logs/total 正确，`src/governance.ts:116-147` | `commands.rs:530-576` |
| cleanup_audit_logs | 问题 B01/B10；±60s、keep>=100、days>=7、keep 优先/默认90天及前后审计主路正确，`src/governance.ts:150-213` | `commands.rs:599-732` |
| get_migration_status | 返回 null/未初始化/待迁移统计主路通过；错误映射/警告问题 B01/B10，`src/governance.ts:216-250` | `commands.rs:739-816` |
| run_health_check | 问题 B09/B10；initialized/dependency/pending/quick/FK 汇总存在，`src/governance.ts:253-330` | `commands.rs:823-1001` |
| get_database_status | 刷新先于 ID 校验、无状态 null 正确；错误走 B01，`src/governance.ts:334-357` | `commands.rs:1006-1053` |
| get_backup_list | 缺目录 []、recovery 分类字段主路一致；B01/B10，`src/backup-commands.ts:57-61`、`src/backup-manager.ts:51-68` | `commands_backup.rs:1194-1258` |
| delete_backup | ID 校验→锁→目录/边界→删除→true 顺序一致；B01/B03/B10/B11，`src/backup-commands.ts:64-77` | `commands_backup.rs:1272-1306` |
| check_disk_space_for_restore | 问题 B01/B11；预算 bigint→契约 number，目标判定/错误上下文不同，`src/backup-commands.ts:80-108` | `commands_backup.rs:1321-1390` |
| verify_backup | verify 错误折叠为 is_valid/checksum_match/errors、DB option null 主路一致；B01/B03，`src/backup-commands.ts:111-141` | `commands_backup.rs:1404-1484` |
| auto_verify_latest_backup | 问题 B08；错误/审计返回结构主路存在，`src/backup-commands.ts:171-208` | `commands_backup.rs:1495-1605` |
| run_backup | 问题 B01–B04；full/true 缺省、incremental 拒绝文案和 queued 返回相同，屏障与完整性分支缺失，`src/backup-commands.ts:211-323` | `commands_backup.rs:1738-1805,1980-2045` |
| cancel_backup | 布尔取消位主路通过；缺失败 warn（B10），`src/jobs.ts:132-136`、`index.ts:112` | `commands_backup.rs:2250-2268`、`backup_job_manager.rs:901-914` |
| get_backup_job | 通过：未知 null、可选 started/finished/result 缺省，`src/jobs.ts:138-147` | `commands_backup.rs:2282-2287`、`backup_job_manager.rs:924-925` |
| list_backup_jobs | 通过：遍历现存任务、无新增排序承诺，`src/jobs.ts:149` | `commands_backup.rs:2300-2304`、`backup_job_manager.rs:917-921` |
| restore_with_assets | 通过：原停用消息正确作为字符串错误发出，`index.ts:109-111` | `commands_asset.rs:117-125` |

这些命令不全是 SQL 事务；审计清理原来也非包裹单事务，本次不额外要求。跨库备份却确实需要原有的写入屏障，不能以单库 online backup 替代。

## 2. ported 测试真实性抽查（24 条）

前 16 条映射 `TESTMAP.md:181-196`：TS `zip-password` = `tests/zip-password.test.ts`；Rust `zip` = `commands_zip.rs`。后 8 条映射 `TESTMAP.md:160,223-229`：TS `migration` = `tests/migration-behavior.test.ts`。

| 原 Rust 测试名 | TS:行 / Rust:行 | 结论 |
|---|---|---|
| flag_without_stored_password_is_fail_closed | zip-password:9 / zip:1930 | 问题 B06：3 个拒绝输入保留，但完整错误相等弱化为 substring |
| unconfigured_stays_portable | zip-password:16 / zip:1950 | 通过：三个 None/default/false 向量 |
| stored_password_used_when_flag_on | zip-password:22 / zip:1967 | 通过 |
| explicit_password_overrides_stored | zip-password:26 / zip:1976 | 通过 |
| empty_explicit_falls_back_to_stored | zip-password:30 / zip:1989 | 通过 |
| portable_import_ignores_stored_password | zip-password:34 / zip:2002 | 通过 |
| portable_import_keeps_explicit_password_for_existing_reject | zip-password:38 / zip:2011 | 通过 |
| sealed_import_uses_stored_password | zip-password:42 / zip:2025 | 通过 |
| sealed_import_without_stored_is_fail_closed | zip-password:46 / zip:2034 | 问题 B06：完整错误相等弱化 |
| short_stored_password_is_fail_closed | zip-password:50 / zip:2042 | 通过：code 与最小长度 8 均断言 |
| short_explicit_password_is_fail_closed | zip-password:55 / zip:2056 | 问题 B06：仅 code，删了最小长度值断言 |
| password_minimum_counts_unicode_code_points_and_keeps_stable_code | zip-password:59 / zip:2070 | 通过：4/8 emoji 边界 |
| short_leftover_does_not_force_portable_when_flag_off | zip-password:64 / zip:2094 | 通过 |
| sealed_import_short_stored_passes_through_to_unseal | zip-password:68 / zip:2104 | 通过：老短口令兼容 |
| sealed_import_short_explicit_passes_through_to_unseal | zip-password:72 / zip:2113 | 通过 |
| portable_import_keeps_short_explicit_for_existing_reject | zip-password:76 / zip:2127 | 通过 |
| test_ensure_directories | migration:1091 / init.rs:370 | 问题 B06：函数定义也在测试文件 :220 |
| test_initialization_report_new | migration:1100 / init.rs:382 | 问题 B06：测试自造类 :203 |
| test_initialization_report_is_fully_successful | migration:1108 / init.rs:392 | 问题 B06：测试自造状态/策略 |
| test_needs_initialization_new_app（init） | migration:1120 / init.rs:409 | 问题 B06：包装函数在测试 :309 |
| test_get_current_schema_state_empty | migration:1124 / init.rs:420 | 问题 B06：未验证真实 init 入口，测试函数 :314 |
| test_initialize_audit_log | migration:1130 / init.rs:434 | 问题 B06：虽用生产建表 API，初始化编排是测试重写 :227 |
| test_initialize_without_feature | migration:1143 / init.rs:452 | 问题 B06：原失败改成功，不能标 ported |
| refresh_schema_registry_from_dir_maps_poisoned_lock_error | migration:2204 / commands.rs:1437 | 问题 B06：测试内 poisoned flag/RegistryStateHolder，不是生产锁行为 |

`migration/approvals.json:3-40` 中没有允许这些用例反转、替换为测试本地算法或合并的批准。本 lane 实际没有 obsolete/merged 行；未批准事项不能隐含藏在 ported 中。wiring 308/308 可达只证明测试文件导入图有生产路径，识别不了同一文件内的替身。

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/backup
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 Test Files  19 passed (19)
      Tests  333 passed (333)
     Errors  1 error
   Duration  365.92s
exit=1

$ npx vitest run -c vitest.host.config.ts host/plugins/backup --maxWorkers=1
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 Test Files  19 passed (19)
      Tests  333 passed (333)
     Errors  1 error
   Duration  289.69s
exit=1

$ node scripts/electron-migration/importable.mjs host/plugins/backup/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane backup
合计 ported 308，其中所测模块未从 index.ts 接入 0（0.0%）
```

日志：`/tmp/opencode/R4-backup-vitest.log`、`/tmp/opencode/R4-backup-vitest-single.log`。只针对原运行的 worker 超时做了一次降并发复跑；未重复其它已过检查。真实 TestHost 临时目录中的额外命令探针输出：

```text
data_governance_run_backup HandlerPanic command "data_governance_run_backup" panicked (in production the frontend promise would never settle): Incremental backup has been removed; use full backup or cloud sync
data_governance_get_audit_logs HandlerPanic command "data_governance_get_audit_logs" panicked (in production the frontend promise would never settle): 无效的状态过滤值: invalid。可选值: Completed, Failed, Partial
```

## 4. 语义差异与平台差异

- **缺陷（应修）**：B01–B11。备份锁、跨库屏障、完整恢复点约束、错误返回与日志都不能以平台不同为由省略。
- **已登记的平台差异**：`docs/dev/electron-migration/decisions.md:52-59` 记录 better-sqlite3、毫秒级生成时间和异步 backup；`:24-31` 记录 Electron Argon2 与 crypto 跨平台动态向量待补。`SPEC.md:17` 记载 safe-integer 限制，但这不是 Rust u64 全域等价证明；本次不把自述当批准。
- **不作错误推断**：两次 RPC 超时尚不能判定是业务失败；fakeSecrets 仅存在 tests，不能仅凭测试替身名称指控生产假加密。但 B06 的被测逻辑本体写在测试文件中，有明确反证。
- **B 级状态**：未决缺陷、TESTMAP pending 与两次非零测试退出，B 不成立。

## 5. 配合 L23 的真实 guard 组合探针（46bb99a298）

固定提供方 `46bb99a298b7b3920b51c0b8ad6a163e46414a97`、消费者 `c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`。两个原样git archive临时测试副本，在同一TestHost安装真实backup与sync-providers插件，guard不使用替身；仅调用守卫/配置边界，不执行备份恢复工作流。完整配置、命令和输出见 `host/plugins/sync-providers/ACCEPTANCE.md` §5。

- **已观察到的改进**：候选 `api.ts:91-109` 发布必需 operationId/release；`src/operations.ts:40-43,158-172` 有共享许可状态。实际持有Backup后第二次获取被拒，release后能获取Restore。这是局部行为证据，未据此签收跨进程所有分支或实际数据库/工作区屏障。
- **仍需共同修复**：候选 `index.ts:46-48` 的参数是大写Backup/Restore/Prune；L23实际传小写backup/restore/prune，小写前两者落入默认prune，真实调用已复现。应统一双方公开服务契约，不能用任意值默认prune掩盖错误。
- **错误边界仍不兼容**：候选 `src/operations.ts:163` 忙锁抛普通Error，经L23 `index.ts:135` 穿透，真实invoke成为HandlerPanic；Rust `src-tauri/crates/dstu-storage/src/backup_common.rs:149-166` 是Validation AppError。须明确服务错误传输契约并由消费者对齐。

```text
real L21 guard backup => prune
real L21 guard restore => prune
real L21 guard prune => prune
real L21 guard Backup => backup
real L21 guard Restore => restore
real L21 guard Prune => prune
real L21 held -> real L23 invoke: HandlerPanic command "cloud_sync_upload" panicked (in production the frontend promise would never settle): 已有数据治理操作正在运行（当前 Backup，operation_id=42015ec3-dea1-4055-a264-e67e9cc7e014）
real L21 permit after release: restore
```

被审main c7的backup尚无此新方法；本节不将候选分支当作已整合生产结果，不关闭B01/B02/B03。

### main e303957124 合并后的裁定口径

D2明确共享操作许可唯一归L21，公开guard.release必须存在；本轮对比e303与c7的backup api/index/operations无差异，候选46bb99a298仍只能记待集成。大小写及业务错误形状反例继续保留，未据类型声明或finally文本签收实际屏障。

D3只允许IPC边界采用Tauri JSON number表示；内部字节数、预算、游标等仍须精确，不得收窄合法u64请求来规避精度问题。D1/D4对B05的同事务业务接缝已对齐，未签收整组B修复。合并类型检查及相关L23命令最小集结果在汇总文档记录，未重跑L21全套或消除首次Errors/exit=1证据。

## 6. 最新 L21 provider 与 L23 候选组合（e4dd1772f / 1da6dadc5）

仅补审P03关联的B03/B01服务边界，不重跑L21全套。作业全部经全局队列，详见L23 ACCEPTANCE §7。

### 已验证的实际行为

- **局部许可释放有效**：真实backup插件 + 真实L23/manager/DAV。配置失败后可取restore许可；真实下载成功后可取backup许可，进度ID非空。`src/operations.ts:137-155` 的显式释放不只是类型/代码文本证据。
- **kind又发生漂移**：`api.ts:150-157` 与 `index.ts:53-54` 现在正式接受snake_case DataGovernanceOperationKind；L23镜像仍大写。实际锁账本写入Backup/Restore/Prune原样大写，KIND_DEBUG却仅支持小写（`:80-90`）。不是旧的“全部映成prune”，而是未经归一化的大写进入错误账本值。双方要基于同一正式api.ts联动，旧46bb99a298结论仅保留历史。
- **忙锁包装丢类型**：`OperationBusyError extends CommandError` 只传message字符串（`src/operations.ts:26-33`）；`operationCommandError` 把平台AppError也扁平为message（`:51-54,227-239`）。因此真实L21虽可settle，仍不满足L23云命令AppError契约。Rust `src-tauri/crates/dstu-storage/src/backup_common.rs:149-166,236-251` 的Validation/FileSystem必须保留，不能以“现在是CommandError”签成等价。

测试副本由e4dd完整host/contracts加1da原样sync-providers目录组成，确保两插件共享同一个kernel CommandError类；没有改动生产源文件，未用自造guard替代L21。SSOT设置/凭据是测试输入，真实hydrate、guard和文件锁运行。真实IO失败通过在临时appData下创建普通文件 `recovery`，使建锁目录失败，不模拟throw。

`job.mjs result 20261104062036-519809 --tail 240` 关键原文：

```text
provider kind Backup ledger= Backup
provider kind Restore ledger= Restore
provider kind Prune ledger= Prune
provider kind backup ledger= backup
provider kind restore ledger= restore
provider kind prune ledger= prune
provider busy error value= "已有数据治理操作正在运行（当前 Backup，operation_id=0d5b9119-9550-4efb-bf3a-738ad2294038）"
invoke busy= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
provider IO error value= "创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-A4P3bL/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-A4P3bL/recovery'"
invoke IO= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
invoke config failure= {"error_type":"Validation","message":"缺少 WebDAV 配置","details":null}
real permit after command failure= restore
real-provider download= true next permit= backup
download operationIds nonempty= true
[作业 20261104062036-519809] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062036-519809.log
```

探针捕获并打印错误，退出0仅表示探针执行完成，不是业务验收通过。L23自身把未知TypeError改为Unknown、缺release也可成功的探针另见其P03；不将消费者缺陷算作提供方自造行为。生产跨进程文件锁算法和实际数据库/工作区屏障本轮未完整复核，B02/B03不关闭。`e4dd1772f` 非固定main `15b23540a` 的祖先，候选服务不能宣布main可用。

## 7. B01/B02/B03/B08/B09 修复申请定向复核（e4dd1772f）

### 证据范围

按要求读取 `ds-mig/L21-backup-governance:{SPEC,REPORT}.md` 后，独立核查实际e4dd树、Rust和用例。源树固定 `e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`；本轮main固定 `f67db20801c2d787a06f3277f9afd9499dc30fac`，祖先检查exit=1。测试在原样git archive副本 `/tmp/opencode/R4-L21-e4dd1772f-QPkqOg`，包含host/contracts/原迁移SQL与配置，仅复用现有node_modules；未修改实现/测试、未编译运行Rust、未合并候选。

| 编号 | 独立判定 |
|---|---|
| B01 | **候选已修**：五条真实invoke返回精确字符串，error:string入口统一wrap；P03跨服务AppError问题不属于此关闭范围 |
| B02 | **部分修复**：真实F3写阻断/释放已证；已有维护态不能借用、释放失败缺Drop重试、启动状态/就绪等待仍缺 |
| B03 | **部分修复**：模块级共享许可、跨服务互斥、等待、超时不补授通过；错误/kind组合复用§6；排队取消及跨进程原语未等价 |
| B08 | **候选已修**：锁内选择/验证/审计、finally释放，有新增备份与审计时争锁的真实观测 |
| B09 | **部分修复**：readonly/5秒timeout已修；FK坏数据导致未结束iterator，close忙错误覆盖原违规诊断；阶段错误仍不完整 |

B04/B10/B11的e4dd改动未在本轮逐组签收，首轮问题记录为待复核而非宣称新树毫无修复；B05所有者、B06初始化/registry原入口缺口明确保持未关闭。取消两VFS skip并保持pending不等于越权SQL获准。

### 亲跑最小集：19例，不跑全套

所有运行经全局队列：`node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- <命令>`。等待时审读实现和Rust。两条Vitest命令都使用固定root/config、`--no-cache --maxWorkers=1`：

```text
node /home/dsdev/dev/ds-mig/R4-review-sync/node_modules/vitest/vitest.mjs run
--root /tmp/opencode/R4-L21-e4dd1772f-QPkqOg
-c /tmp/opencode/R4-L21-e4dd1772f-QPkqOg/vitest.host.config.ts
--no-cache --maxWorkers=1
```

作业 `20261104063704-2fbc80` 追加 `host/plugins/backup/tests/acceptance-fixes.test.ts -t 'B0[12389] '`；result原始摘要：

```text
 ✓ host/plugins/backup/tests/acceptance-fixes.test.ts (14 tests | 5 skipped) 3977ms
 Test Files  1 passed (1)
      Tests  9 passed | 5 skipped (14)
   Start at  14:37:04
   Duration  9.58s
[作业 20261104063704-2fbc80] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063704-2fbc80.log
```

5 skipped为本轮名称过滤排除B04/B11，不是删除或跳过失败测试。作业 `20261104063704-f51a4e` 追加 `host/plugins/backup/tests/operation-and-sync-ports.test.ts`：

```text
 ✓ host/plugins/backup/tests/operation-and-sync-ports.test.ts (10 tests) 4510ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  14:37:06
   Duration  9.64s
[作业 20261104063704-f51a4e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063704-f51a4e.log
```

两次均无Errors行。operation-and-sync-ports测试调用真实L21公开许可/SyncPorts，不使用supplied guard：九kind、backup/governance互斥、等待释放、1秒超时不补授、同步limiter、SSOT/凭据载入和审计行均实际执行。settings/secrets及agentTools注册接收端为测试侧接口：后两条仅证明真实L21发出注册及executor.canHandle，不证明完整L07执行链或其它lane已集成。

### 独立真实 F3 探针：弥补 supplied storage 的盲区

原 `createRealStorage` 并非完整平台服务，只有真实Connection包装且维护为no-op；B02测试再用本地boolean取代enterMaintenance，B09适配器缺iterate。为验证真实行为，作业 `20261104064052-6f8b96` 在同一固定树中使用**未替换enterMaintenance的 StorageServiceImpl + SqliteDatabase**，通过真实backup插件的host.invoke运行。

准备：独立临时appData/dataLocalDir，4核心库含最小probe表；vfs有refinery_schema_history版本20260130。没有使用用户数据库。四个独立host场景：

1. 在备份openFile观察点（只透传底层open，不替换屏障）尝试用之前取得的vfs句柄INSERT，以及重新storage.database('vfs')，都被真实MAINTENANCE拒绝；备份完成后同一句柄INSERT成功。
2. 先由真实storage.enterMaintenance(['mistakes'])进入已有维护模式，再invoke run_backup；TS拒绝，而Rust主库已维护时应借用既有屏障并保留外部ownership。测试结束只释放自己持有的lease。
3. 对外部工作区接口注入“首次exit抛transient error、第二次可成功”的故障，真实F3正常staging。只观察到exit调用一次，任务failed；说明release失败直接return、没有Rust Drop第二次尝试。这个故障注入不声称完整真实工作区已测试。
4. 真实vfs库关闭FK enforcement后建parent/child并插入孤儿行，再invoke run_health_check。结果把应有的外键违规替换成close忙错误；不是模拟SQLite异常。

`job.mjs result 20261104064052-6f8b96 --tail 200` 输出原文：

```text
B02 actual held-handle write blocked= MAINTENANCE Database vfs is in maintenance mode
B02 new database borrow blocked= MAINTENANCE
B02 actual storage job= completed after-release write= 1
B02 pre-existing maintenance job= failed message= 无法建立一致备份快照: 数据库进入备份快照屏障失败: Database mistakes is already in maintenance mode
B02 release failure job= failed exit calls= 1 message= 退出备份快照屏障失败: 工作区: transient exit failure
B09 actual FK issue= ["有 70 个迁移待执行 (当前: v20260130, 目标: v20261027)","数据库完整性检查失败: This database connection is busy executing a query"]
[作业 20261104064052-6f8b96] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064052-6f8b96.log
```

迁移待执行是刻意的最小旧schema夹具背景；本轮未运行迁移，实际发现是第二项FK诊断被掩盖。exit=0表示捕获/打印完成，不是上述异常符合Rust。

### B08审计锁内观测与B03排队取消

作业 `20261104064219-4aad86` 同样用真实StorageServiceImpl/真实公开backup服务：先持backup许可并invoke auto_verify，在等待期间写入合法备份 `added-while-waiting`，再释放持有者；命令选中新备份。审计数据库只加透明run观察器，真实INSERT仍执行，观察器尝试取得prune被原共享许可拒绝；命令返回后能再取restore，确认审计前没有过早释放。

同一真实服务再持backup许可，启动run_backup并请求取消，450ms后仍queued；释放持有者后才cancelled。Rust `commands_backup.rs:999-1016` 的200ms取消轮询未迁到该等待路径。原文：

```text
B08 selected= added-while-waiting audit observed= true audit lock held= true next permit acquired=true
B03 cancelled while held status= queued phase= queued
B03 status after holder release= cancelled
[作业 20261104064219-4aad86] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064219-4aad86.log
```

超时不补授已在新公开API测试中通过，但不等于run_backup等待取消语义完整；这两类等待分别记账。真实L21+L23忙锁/IO/kind的上轮作业 `20261104062036-519809` 使用的正是本次同一e4dd/1da组合，直接沿用，不重复排队。

### 签收边界

B01/B08只对固定候选修复勾选；main可见性仍待集成。B02/B03/B09未决子项已给文件行号、Rust对照及实际反例。B05/B06/B07继续保留；TESTMAP实查306ported/17pending，报告所称22文件358passed仅为owner提供的全套结果，未替代本轮19例和反例。当前 **9个B组未决（B02/B03/B04/B05/B06/B07/B09/B10/B11）**，结论仍不通过。

## 8. B03结构化错误新增量（19c023cd6）

继续B组任务时固定新L21=`19c023cd63ff456e0dadc4d2cfd841924455b935`、新L23=`cb9d683d0fd782a04188cc1661dd6598fdbc1771`。19c相比e4dd的B02/B09相关governance/backup-commands无改动，本轮未重复这些旧用例。main可见性固定f37426009，backup/api.ts仍无新守卫。

已查真实代码：OperationGuardError从CommandError继承，value为AppError对象而非string；reason/code和原message分离。L21自身error:string命令在 `index.ts:123-128` 对该类专门映射为message字符串，保留不同命令契约。普通Error不再由operationCommandError一律扁平化。由真实backup服务取得busy和真实recovery路径IO的新用例通过，故承认提供方结构化错误修复；不据此关闭共享许可所有问题。

作业 **20261104070640-d367ed** 使用同一kernel的19c+cb9原样组合副本，选择1条L21新结构化错误测试及10条L23错误/生命周期测试（L23测试的外部guard为测试侧替身）：

```text
 Test Files  2 passed (2)
      Tests  11 passed | 13 skipped (24)
   Start at  15:06:41
   Duration  7.01s
[作业 20261104070640-d367ed] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070640-d367ed.log
```

13 skipped为名称过滤，无Errors行。测试新增对 `syncCommandPorts().limiter.acquire` 锁IO返回closed的断言（`src/sync-ports.ts:73-87`）；它只是当前适配行为，不能单凭期望写成closed证明原错误语义已等价，仍需结合L20消费方的失败上下文复核。

真实Node组合探针 **20261104070755-b0ffa4** 尚未执行provider调用即失败：

```text
host/plugins/sync-providers/src/sync_manager.ts:171
constructor(message: string, readonly line?: number, readonly column?: number)
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
Node.js v26.5.0
[作业 20261104070755-b0ffa4] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104070755-b0ffa4.log
```

归因是L23新生产参数属性，不是L21业务失败；没有为求审计绿改实现/转译绕过。完整对象与源码位置在L23 ACCEPTANCE §9。B03类型/kind/known-error有修复进展，但生产可加载且真实组合验证后才签收组合子项；排队取消与跨进程锁等未决仍属e4dd已证且19c未改的范围。

## 9. 已main的正式错误契约与新消费者组合（d5cd234aa / 624cfe251）

已核 `d5cd234aa:host/plugins/backup/api.ts:92-123,174-188` 正式发布guard/结构化失败；与19c对应backup目录无差异，不能重复要求集成旧e4dd。L23 624cfe251是该main后代，直接导入所有者契约。F4 paths仍由固定679b候选提供供成功传输场景使用，分开记录待集成。

只补前次因Node加载失败而未执行的新真实组合，未重跑B02/B09/旧19例。作业20261104074838-775a11中实际使用真实L21 guard、SSOT hydrate、L23 manager、F4加密和本地DAV。已成功的断言/原文：

```text
P03 real busy= {"error_type":"Validation","message":"已有数据治理操作正在运行（当前 Backup，operation_id=4e175dd5-099c-454b-b92c-b65eab8404bc）","details":null}
P03 real IO= {"error_type":"FileSystem","message":"创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-8juoWY/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-8juoWY/recovery'","details":null}
P03/P07 real encrypted upload done temp= 0 kind= backup next permit=restore
```

作业之后试图断言“progress回调中abort必令本次PUT失败”，得到 `AssertionError: Missing expected rejection`，**作业exit=1**（日志 `/home/dsdev/.oc-jobs/done/20261104074838-775a11.log`）。复核者补读Rust cloud_storage/webdav.rs:1119-1269确认它只在退避/限流等待点使用取消令牌，不要求成功首轮PUT即时取消，因此不将该错误预期派为实现缺陷。原失败保留，不重跑成功的前段求绿。

B03上述消费契约子项签收，跨进程wx/PID原语、备份等待取消仍未决；B01/B08此前已关闭，其余九个B组保持。与L23消费侧P03关闭不矛盾，不能据它宣布L21完整B通过。

## 10. v2正式main闭环：B02/B03/B09（eeaf5bdc7）

固定main `eeaf5bdc7ae95a336c34b3a75b19f844726fe064`，包含协调者指定 `0d4a73c61` / `5f02d66bd`。独立快照 `/tmp/opencode/R4-v2-main-eeaf-FoYvZ8` 原样git archive，不叠加候选或改测试。按standard-v2 §1–§2复验生产入口；新结果不替换§7旧真实F3失败。

| 全局队列作业 | 范围 | 原result |
|---|---|---|
| 20261104111500-ac6715 | acceptance-fixes，过滤 `B01 \|B08 \|borrows an existing\|retries a failed\|cancelling a queued\|foreign-key violation` | **exit0，10passed/9skipped**；5条B01、B08、B02借用/重试、B03取消、B09坏FK |
| 20261104112233-364289 | 同文件仅 `reports global permit acquisition failures`（上一过滤未覆盖的新分支） | **exit0，1passed/18skipped**；真实锁目录IO导致job.failed，保留“获取全局备份锁失败:”且不误加“备份失败:” |

两作业均无Failed/Unhandled Errors段，skipped为标题过滤。完整命令和输出保存在 `/home/dsdev/.oc-jobs/done/<job-id>.log`；未重复全目录368例。

审读补充：

1. **B01/B08由候选转main签收**：五条字符串命令出口、持锁后选择备份的回归本轮main通过；§7更强的audit期间持锁/等待新增备份旧探针保留，不重复无变化路径。
2. **B02借用不是fake maintenance**：真实StorageServiceImpl的错误与operations:78-82四个条件匹配；F3按DATABASE_NAMES顺序进入，mistakes第一项冲突时无本次已进入库。返回的no-op release仅放弃本次所有权，真实外部lease仍阻断mistakes，测试自己释放后才恢复。符合Rust的主库already-maintenance借用分支；不外推所有外部维护组合。
3. **B02重试保首错**：exitOnce先storage后workspace；两次都失败才记录error且保留blocked。真实lease首次失败注入后第二次确实解锁，但job仍收到第一次退出错误；形式与Rust Drop不同、可观察结果一致。启动ready/status仍独立未决。
4. **B03取消**：acquireForJob轮询200ms，取消排队位置后不提前放行后继，不释放当前holder。任务消费者已接线，原“持锁450ms仍queued”不再用于描述main。锁IO新分支已单独补验；跨进程原语尚未因此等价。
5. **B09**：return先于close恢复generator finally，真实外键违规错误已保留。首次step标读取正确；但F3 generator的prepare同样延迟到next，无法据外层两个try区分全部阶段，剩余项仍不签收。

当前B01/B08整组main签收；B02/B03/B09仅以上子项签收，仍共九个B组未闭合。B04/B05/B06/B07/B10/B11没有在本轮扩签；main TESTMAP实际311ported/12pending，页首及旧候选统计只作历史。

## 11. B04/B11下一最小复核与B10日志逐点核对（4c6cd1ba8）

### 基线与执行理由

固定正常main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`。先比对确认backup目录相对eeaf没有变化；B04/B11实现修复在e4dd已存在，但旧独立验收仅签B01/B08和B02/B03/B09部分，**B04/B11未执行过本轮所选回归**。相对首次报错基线f23，明确新增了includeAssets恢复点门、非法集合默认回退、审计先取连接、missing-backup文案、isDirectory/realpath和FileNotFound前缀；所以此次是补齐已合main修复的独立闭环，不是重复无变化的已完成用例。

使用原样main快照 `/tmp/opencode/R4-P04-main-4c6c-HjJFPR`，从同一SHA补充归档原迁移/fixture文件。未修改任何测试或实现。没有重跑已签B01/B02/B03/B08/B09或368全目录，也未再跑S05/P04原失败。

### 作业及原result

**20261104115609-eaa58a**：

```text
node <R4>/node_modules/vitest/vitest.mjs run --root <snapshot> -c <snapshot>/vitest.host.config.ts --no-cache --maxWorkers=1 host/plugins/backup/tests/acceptance-fixes.test.ts -t 'B04 |B11 '
 ✓ host/plugins/backup/tests/acceptance-fixes.test.ts (19 tests | 14 skipped)
 Test Files 1 passed (1)
 Tests 5 passed | 14 skipped (19)
 退出码 0
```

5例=两个B04、三个B11；14skip为显式标题过滤，无Failed/Unhandled Errors段。原用例通过kernel invoke→真实BackupCommands/manager/filesystem/SQLite执行，没替换被测恢复点门、目录判断或错误格式。setupRealHost使用SQLite适配器、维护租约为fixture；此次不以它再次证明B02屏障。全非法资产用例断言的是默认域absent而非excluded，不能扩推“所有种类资产字节已完整往返”。B04所要求的默认选择与partial拒绝实际经过生产分支。

**20261104115805-ab41d2**：补五例未覆盖的“同时出错优先级”与列目录IO上下文，使用真实StorageServiceImpl的维护lease，不替换database方法。前段audit进入维护后传非法status；释放原lease后，第二段只把该测试宿主的备份根改为普通文件，调用空间检查。

```text
B11 real audit maintenance plus invalid status {"error":"获取审计数据库连接失败: Database audit is in maintenance mode"}
B11 backup root is file {"error":"ENOTDIR: not a directory, scandir '/tmp/dstu-test-host-XdWC0b/recovery/backups'"}
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^获取备份列表失败:/.
actual: "ENOTDIR: not a directory, scandir '/tmp/dstu-test-host-XdWC0b/recovery/backups'"
expected: /^获取备份列表失败:/
退出码 1
```

前段两个顺序断言通过，末段1个真实业务上下文断言失败；这是Node AssertionError，不是Vitest的Errors分类，也不是被捕获打印后exit0。finally已释放测试宿主/存储。两个完整命令/stdout在 `/home/dsdev/.oc-jobs/done/<job-id>.log`，不通过删断言或重跑把exit1洗绿。

### B10日志源码映射

| Rust原位置/要求 | 固定main TS真实调用点 | 判定 |
|---|---|---|
| backup/mod.rs:5720-5730，ID不匹配/坏manifest warn | backup-manager.ts:62-72；getBackupList在backup-commands.ts:64传logger | 列表命令这一调用链已补 |
| 同一manager警告应随验证/恢复调用存在 | findBackup默认warn为空函数；backup-commands.ts:130,165和restore-commands.ts:337未传回调 | **仍漏**，不能只看manager有warn字符串 |
| commands_backup.rs:1212-1214/1300-1302，list/delete失败error | backup-commands.ts:65-67/80-82 | 已补级别及错误上下文 |
| commands_backup.rs:2259-2265，取消结果info/warn | index.ts:210-214 | 已补；但:2254请求开始info仍缺 |
| commands.rs:760-768，pending迁移warn | governance.ts:226-229 | 条件、库/数量/版本字段对应 |
| commands.rs:838-840，健康依赖warn | governance.ts:260-265；另291-314问题/汇总日志 | 已补；:829开始info仍缺 |
| backup_job_manager.rs:943-948，非法状态转换warn | jobs.ts:157-161 | 已有host logger、前后状态和job_id；不再静默return |
| 旧本地sync-state/vfs-restore使用process.emitWarning | sync-state.ts已删，vfs-restore的resetSyncBaselineAfterRestore副本已删 | 旧位置问题消除，不替owner调用链整体授通过 |
| commands_backup.rs:1340-1343/1373-1383，空间检查列表/磁盘失败error与结果info | backup-commands.ts:94/108-114无对应logger | **仍漏**，列表错误上下文还已被B11真实探针证实 |

B10保持未决。本表是逐点生产源码证据，未把任意“两条日志测试绿”解释为整个文件/插件日志等价。

### 当前结论

**B04在main签收；B11原四个子项签收，但新增列目录失败上下文未闭合；B10仅分点确认进展。** B01/B04/B08三个整组已签收，其余B02/B03/B05/B06/B07/B09/B10/B11八组仍未决。旧f23/e4dd反例、非零作业与各自范围保留；本轮不修改SPEC、TESTMAP或审批。

## 12. B05主线所有者证据与B10/B11候选后继

### B05：不重复已跑main测试，补核消费链真实性

固定main `16a254adfb53d24b971d27b2a7f34bf899d2bec7`包含`dac4927af22f6817c2bad3dc83fc8f1ac7c1de29`。`repository/vfs-restore.ts`已删除，`backup-manager.ts:638-667`保留完整组件分支与调用次序，但实际表写交L11。正式L11 `src/maintenance-service.ts:75-97`打开目标槽vfs.db，事务内调用自己的repository，finally关闭连接；`repository/maintenance.ts:344-478`执行schema-aware资源/索引/files/exam_sheets重置，对照Rust `backup/mod.rs:2307-2446`及后续重置列。

复用已亲跑的main作业**20261104132355-e8e497**：`backup-manager.test.ts (19 tests)`与`restore.test.ts (11 tests)`均通过；整作业因其它插件失败仍为exit1，原文不改。本轮核对：

- `tests/helpers.ts:195-204`的installVfsRestoreOwner实际安装vfs-repos；不是no-op reset或测试本地重写SQL。
- `backup-manager.test.ts:139-208`实际创建资源/units/segments/dims/profiles/files/exam_sheets及Lance文件，调用生产finalize，经正式服务验证重置值、清空队列、删除不完整目录。
- `:210-232`验证legacy schema不误删payload、完整Lance组件保持文件；这些原断言未被删除。
- `restore.test.ts:317-351`通过kernel恢复命令跑到prepare/finalize并验证候选槽文件及cutover标记；依赖中dataSpace/密钥发布是fixture，因此不据此签整个真实启动切槽。

签收B05的VFS单写者子项；真实syncSupport恢复激活组合仍待。原本的轮换SQL副本已删除，但记录调用替身不证明真实数据库状态，不能以API存在关闭总框。

### B10/B11：只跑新增的7条

固定候选`090d225cb7445b774b6991991b79a38b0e427a8f`，原样快照`/tmp/opencode/R4-B-090d-FxEZX7`。`3f10668bd906ca7dfc2509f052d0e60632565758`记录本轮修复并增加断言，业务改动已在其前继`2272e79d8`中：checkDiskSpace先listBackups，失败加“获取备份列表失败:”并error；manager补BackupError::Io的`IO error:`前缀；verify/verifyWithAssets/restore向findBackup传host warn；取消请求、健康开始、空间汇总info接回真实入口。

对照Rust `commands_backup.rs:1340-1343,1373-1383,2254`、`commands.rs:829`、`backup/mod.rs:5705-5731`逐点审读后，作业**20261104135156-ee95cb**只选`acceptance-fixes.test.ts -t 'B10 |prefixes a backup-list IO failure'`（统一snapshot root/config/no-cache/maxWorkers=1）。

```text
 ✓ B10 data_governance_verify_backup warns about an unreadable sibling manifest while locating the backup
 ✓ B10 data_governance_verify_backup_with_assets warns about an unreadable sibling manifest while locating the backup
 ✓ B10 data_governance_restore_backup warns about an unreadable sibling manifest while locating the backup
 ✓ B10 cancel_backup logs the request before the outcome
 ✓ B10 run_health_check logs its start
 ✓ B10 check_disk_space logs the space summary
 ✓ B11 check_disk_space prefixes a backup-list IO failure and logs it as error
 Tests 7 passed | 25 skipped (32)
 退出码 0
```

无Failed/Unhandled Errors，25skip为过滤。均经kernel命令、真实生产list/manager流程；logger.exporter只记录host日志，不替代被测logger调用。旧反例ENOTDIR现精确为`获取备份列表失败: IO error: Not a directory (os error 20)`且有error日志；正常返回的空间统计与info所有数值相同。未重跑B04或B11已签四条。

日志`/home/dsdev/.oc-jobs/done/20261104135156-ee95cb.log`。090d/3f均非固定main16a祖先，因此只记候选通过；不把7例当整个lane日志全覆盖，也不覆盖§11原exit1。

## 13. B10/B11从候选转正式main签收

固定main **306eb8bbbe74ad8f225da9313d24dd8eb0a8ef40**已含3f10668bd（祖先检查exit0）；`git diff 090d225cb 306eb8bbb -- host/plugins/backup/src host/plugins/backup/index.ts host/plugins/backup/tests/acceptance-fixes.test.ts`为空。与已亲跑的main门禁基线8d7b05d14相比，backup代码/测试亦无变化。

复用**20261104142355-6832bc**原stdout：

```text
✓ host/plugins/backup/tests/acceptance-fixes.test.ts (32 tests)
✓ B10 data_governance_verify_backup warns about an unreadable sibling manifest while locating the backup
✓ B10 data_governance_verify_backup_with_assets warns about an unreadable sibling manifest while locating the backup
✓ B10 data_governance_restore_backup warns about an unreadable sibling manifest while locating the backup
✓ B10 cancel_backup logs the request before the outcome
✓ B10 run_health_check logs its start
```

低于报告耗时阈值的空间info/IO用例未单独打印慢用例行，但本文件32/32通过且没有skip，包含§12那7条原断言；不把“只打印5行”误读为其余未执行。已逐点审读源修复和真正logger消费点，因此完成B10原枚举漏项与B11最后IO上下文的main签收。

整个四插件门禁仍**exit1**、Failed Suites10/Failed Tests35（来自sync），无额外Unhandled Errors，原日志`/home/dsdev/.oc-jobs/done/20261104142355-6832bc.log`。不为本次签收重复执行32例或7例，也不修改总门禁状态。B05恢复激活真实owner组合、B09全SQL错误阶段等剩余六组仍不关闭。

## 14. B06迁移依赖测试改回正确生产对象（74252e624）

固定main **74252e62407fe2a607693d9195d4068b6cd64bbd**，修复 **a8fc93a40**（X6-AP-0111/X6-AP-0124）。`tests/migrations-metadata.test.ts:43-47`只负责临时目录，真正被测的是F3正式MigrationCoordinator和CoreMigrationReport；`coordinator.ts:111`的runAll实际调用同一个`:163-170 checkDependencies`，不是测试重写依赖检查，也不是用SchemaRegistry代替MigrationReport。

逐项对照：

| Rust原测试 | 当前TS | 原断言/fixture |
|---|---|---|
| migration_tests.rs:885-907 / tests.rs:507-528 的test_dependency_not_satisfied_error | :127-139 | 空MigrationReport，期望实际MigrationError、detail.kind=DependencyNotSatisfied、database=chat_v2、dependency=vfs；复合toMatchObject保留三个结构字段，未以字符串包含代替错误变体 |
| migration_tests.rs:912-934 的test_dependency_satisfied_success | :141-151 | VFS成功report，from0/to20260203、count=真实VFS集合计数、100ms/null，chat_v2依赖检查成功 |
| tests.rs:534-556 的test_dependency_satisfied | :222-234 | 单独保留原20260131/count2成功报告，不改成最新schema registry版本来求绿 |

主线作业**20261104195643-18bfdd**中该文件**19/19通过**，无该文件skip或失败；整体仍因L20关系第二Host/W69两项失败而exit1。以上三项属于原Rust的report单元测试，不需要虚构真实迁移才算有效；本轮直接复用官方gate结果，未再重复提交。

**B06仍未闭合的具体反例**：同文件`:25-40 latestOpener`不管SQL返回预制latest版本，`:180-188 test_schema_registry_aggregation_after_migration`只创建空数据库文件后传这个opener；Rust `migration_tests.rs:1148-1193`先真正run_all，再aggregate并验证数据库状态。`:199-204 test_schema_registry_dependency_check_passes`同样未跑迁移，而Rust`:1198-1209`明确先run_all。即使真实迁移完全未执行或数据库为空，这两个TS用例仍可由预制行获得“最新版本”，因此它们不证明原迁移后集成不变量。不是按expect数量猜问题，也不以三个dependency单元修复覆盖这些集成用例。

原init/RegistryStateHolder等B06历史问题和pending仍保留；未修改任何测试、TESTMAP或审批，待owner按对应原测试真正接线后复验。

## 15. B02启动等待与外部状态分离、B05真实激活消费签收（5b1b19055）

固定main **5b1b190553712eaddfee1e862c10f61ab11a55f3**；本分支门禁tip **9e93decc730410a2f70c098434099156ebe2ad4f**。本轮复用已完成主线测试，只新增一个外部维护状态探针。

### B02

修复e4b5bbdaa的`index.ts:242-250`先await正式F2 gate，再读取维护状态。`startup-readiness.test.ts:23-60`未用替身gate；超时例只推进真实gate的timer，119999ms仍pending、120000ms精确返回`应用启动初始化超时（120 秒），请重启应用`。对应Rust `commands.rs:434-439`；原缺启动等待子项关闭。

独立探针 **20261104210356-780ffc** 在上述固定main归档`/tmp/opencode/R4-main-5b1-maintenance-b8YbjR`运行：真实F2 gate先ready，真实StorageServiceImpl打开mistakes，外部直接取得`enterMaintenance(['mistakes'])`租约，验证新借用抛`MAINTENANCE`，再经kernel invoke状态命令。原输出关键值：

```text
EXTERNAL_LEASE_STATUS {"is_in_maintenance_mode":false,"blocked_components":[],"current_operation":null,...} borrowError MAINTENANCE
AssertionError [ERR_ASSERTION]: false !== true
```

**原exit1，1个预期行为断言失败；普通Node探针，无Vitest Errors/skip计数，无额外运行错误。** finally释放外部lease并dispose。归档保留原三份tsconfig，排除此前归档缺配置的collection问题。源码原因是`governance.ts:438`只读Operations模块内blocked数组，而外部F3租约不更新该数组；Rust`:440-488`逐个读取实际组件维护态。该反例未断言TS库名须直接等于Rust的main标签，也不否定此前“借用外部租约不得擅自release”的已通过子项。B02总体继续开放，修复应由owner取得正式实际状态后聚合，不能用current_operation非空或启动ready推测没有维护态。

### B05

main已含startup-finalizer测试增量855f3c20e/2f727ea45；`index.ts:311-312`注册`backup.restore-activation`，F3 runner实际调用`finalizeRestoreActivation`。测试安装真实storage、paths、secrets、DataSpaceManager、notes、vfs及syncSupport；正例真实runAll后种入cursor17/legacy键/watermark42，走注册回调而非直接调用helper，验证新身份文件、轮换理由`backup_restore_activation`、游标/水位归零、legacy清除、marker和lease消失及重复runner无额外轮换。

`restore-commands.ts:205-236`的次序为记录旧/新身份→owner重置状态→persist新身份→commit租约→删除marker→完成cutover，对齐Rust `commands_restore.rs:173-208`。`sync-support/src/state.ts:217-224,240-255`由owner在同一F3事务写轮换历史并完成三项清理；backup repository现存写SQL仅自有audit。结合此前真实L11 VFS所有者验证，关闭B05原单写者及真实恢复激活消费者缺口。

证据边界：fixture在`:51-58`设置F3已经完成的活动槽切换，不是完整Electron/F1启动；不将这些正例扩签所有恢复故障或崩溃重试语义。原替身测试保留作历史，签收依据已换成实际owner数据库结果。

### 原始门禁

既有 **20261104195643-18bfdd** 两文件各3/3；最新 **20261104203745-e6de2c** 两文件仍各3/3、无文件skip，但全作业**exit1**：1812passed/2failed/20Docker skipped，151passed/2failed/1skipped files，无额外Unhandled Errors。失败仍是关系第二Host的registerDeletionJournal SlotOccupied，以及W69 **38490.490397ms > 30000**。typecheck **20261104203745-d57a1b**、boundaries **-eecbe0**、importable **-73dd05**均exit0。selfgate记录ok=true是main既有失败豁免，非原测试全绿；本轮未重复排这六条通过用例。

## 16. 遗留状态订正：B06真实迁移聚合、B09错误阶段main闭环（90538c240）

固定main **90538c2404a6c479bb91f6c1a6835f8f0e840edb**，已完成官方gate tip **139cee6561822dfb55d51f3cf86e1d38b2aa9ffd**。只读核实 **6d0c885093317367192a7d0c57c1431ead12de32** 与 **1783a548fb860c9cb631db50233e257aa7f7fac3** 也都是上一轮5b1的祖先；5b1→90538这两个业务文件无新增差异。因此本节是补核既有main修复并纠正审计滞后，不是声称刚出现的新实现。§14旧latestOpener与§10旧无phase证据保留，但不能继续拿来描述5b1/90538。

### B06：四个registry/依赖测试

`tests/migrations-metadata.test.ts:29-48`经公开`createMigrationWorker().runAll`执行真实迁移（worker-tasks.ts:11-19实际创建MigrationCoordinator并runAll）；成功报告必须为true。之后opener返回真实F3文件handle，`repository/schema-registry.ts:50-101`实际读取refinery_schema_history；该聚合也是`Governance.refreshSchemaRegistry`生产调用的函数。finally先drain worker，再dispose并清临时目录。测试不再创建空文件配伪造版本结果。

| 原Rust测试 | TS落点 | 核实保留的行为 |
|---|---|---|
| tests.rs:696-731 test_schema_registry_aggregation | :184-196 | 真迁移后聚合，4库、global_version>0、每库存在且版本>0；原TS最新版本精确断言保留 |
| migration_tests.rs:1148-1193 test_schema_registry_aggregation_after_migration | :198-212 | 同上且与实际coordinator.sets的latestVersion逐库相等，不仅与消费侧静态数组相等 |
| tests.rs:736-755 test_schema_registry_dependency_check | :214-219 | 真迁移/真聚合后调用生产checkDependencies成功 |
| migration_tests.rs:1198-1214 test_schema_registry_dependency_check_passes | :221-226 | 保留同一真实迁移前置及依赖结果 |

主线 **20261104211150-fa2d6b** 中migrations-metadata **19/19通过**（20119ms，无该文件skip）。签收四个真实性子项；此前三个MigrationReport依赖单元签收仍有效。B06主线仍有`migration-behavior.test.ts`本地initializeWithReport及策略函数调用，不能以这个文件整体绿或registry修复签整个B06。

### B09：实际错误来源与消费者映射

F3 `connection.ts`原生prepare失败带phase=prepare；参数转换/数量校验失败经bind附phase=bind；stmt.iterate/iterator.next执行失败带phase=execute。错误字段来自实际层次，不解析错误字符串。L21 `governance.ts:386-392`将这些阶段分别映射Rust `commands.rs:912-920`的准备/执行/读取上下文，仍在finally先return后close，并保留原主错。

真实回归`acceptance-fixes.test.ts:567-582`创建非唯一父列的外键引用，经kernel health check得到精确`数据库完整性检查失败: foreign_key_check 准备失败: foreign key mismatch - "fk_child" referencing "fk_parent"`，并否定读取失败；不是注入自造StorageError。**211150-fa2d6b**中此例575ms通过，同文件35/35；原只读5秒profile与真实孤儿FK/iterator收尾两例亦通过（540/676ms）。bind/step映射依据平台及消费者分支审读，不声称本次运行注入了三种故障。该命令的PRAGMA无参数，也不要求为其虚构绑定错误。原B09可关闭，范围为已列健康检查finding，不泛签F3所有SQL操作。

### 尚未main的初始化修复

另只读审阅L21 **930fac6645f2860e49a9669c86ac5ba435131fd6**（修复说明428211444）：三个旧initializeWithReport用例改成真实paths/log/secrets→正式F3插件安装、卸载/重装；新app根为空、正常模式断言避免测试日志触发恢复分支。两条初始化后pending-count=0及原resource跨初始化保留输入/结果，对照Rust migration_tests.rs:1311-1319、tests.rs:854-864、critical_audit_tests.rs:1644-1677未见原断言弱化。它不是初始化报告的替身，也不证明剩余两个报告字段测试已接线。

亲取owner已有作业 **20261104210258-0b127b**（Node）与 **-224e82**（Electron）：各3passed/89过滤skip、exit0、无Errors；不是R4新跑或main证据。审计记录候选 **20261104202728-944320**也是3passed/89过滤skip、exit0、无Errors，包含两个新库pending-count与真实审计save/query。保留候选身份，待正常main后用集成结果复核，不拿它覆盖当前主线的本地初始化/策略副本。TESTMAP仍313ported/10pending的形式状态不能充当真实性签收。

### 本轮复用的完整门禁原结果

**20261104211150-fa2d6b**原exit1：1812passed/2failed/20Docker skip、151passed/2failed/1skipped files，无额外Unhandled Errors；仍为关系第二Host SlotOccupied与W69 **39563.847364ms > 30000**。typecheck **-e280a1**、boundaries **-24d832**、importable **-14aa89**均exit0，selfgate政策ok=true。本轮未重新排上述未变测试，原失败和全部历史结果保留。

## 17. B06初始化候选进入main（9b3c18601）

固定main **9b3c18601f674826479ed0e7f6ac7d13edca2b70**已含§16所审初始化/审计测试的代码增量（d25ccf1d7/5e27abda5等自动检查点，经674d65cde合入）。相对固定候选930fac664，migration-behavior仅三段说明注释不同，实际依赖、测试输入、调用和断言相同；不能因说明提交428211444未随同进入就忽略已合的真实代码。

`withStorageStartup:149-181`安装真实F3及paths/log/secrets，两条初始化后pending-count=0和保留资源跨卸载/重装测试走实际生命周期；`initializeWithReport`剩余调用仍是两个报告测试，`shouldForceMaintenanceModeOnInitFailure`仍是两个测试内策略用例。三个已改真实入口用例不等于这四项也已修，更不自动恢复init.rs七条/锁一条pending。

主线 **20261104220300-b694ec** 的migration-behavior **92/92通过**，无该文件skip；两条test_no_initialization_needed_after_init分别4992/3898ms，test_initialization_preserves_existing_data为6584ms。**B06三个真实初始化子项及本节相同文件的正式审计save/query修复完成main签收**，复用此次实际结果，不重复owner的210258-0b127b/-224e82，也不改TESTMAP。两个本地报告/两个策略及原pending不因文件全过关闭；B02真实外部维护状态漏报、B03锁原语和B07完整性继续开放。

该整门禁原exit1，1842passed/2failed/20Docker skip、154passed/2failed/1skipped files，无额外Unhandled Errors；旧关系第二Host SlotOccupied与W69=38593.657126ms仍失败。typecheck220300-7fc4a5、boundaries-9c02bf、importable-164155均exit0；政策通过不是全部原测试通过。

## 18. C2指定三文件四原红项：完整F3维护参与者夹具（c6309183c）

按C2最新限定，只复核`tests/backup-manager.test.ts`、`tests/restore.test.ts`、`tests/zip-integration.test.ts`受影响B05链。固定main **c6309183c4cddc06b3647530f3306f7906f2295b**，R4合并HEAD **731efa7fab09c5f1706ef90e0dcca634dad27d56**；修复 **ecff332205b70e292a24d31609f05c0208e3ebc2** 为main祖先，三测试文件相对修复提交无差异。

**原失败亲核**：读取fulltest/latest.json的固定head **650ddffbef3c755dce9fc3b3eb2fe5502bf72382** / at **2026-11-04T23:26:51.932Z**，四项failureMessages均为`TypeError: ctx.storage.registerMaintenanceParticipant is not a function`，栈L11 `index.ts:172`→`helpers.installVfsRestoreOwner:223`（恢复/ZIP再经installSyncService）。两VFS例463.98/384.83ms，完整恢复471.91ms，ZIP451.05ms；这是安装失败，不是恢复结果不一致或超时。原聚合JSON为success=false、11966passed/32failed/79pending；JSON未给原进程exit/Unhandled Errors，不从success反推数值退出码，也不把四例当全部失败。

**修复真实性**：backup-manager共用setupEnv、完整槽restore、加密ZIP完整往返改为createStorageService，保留真实registerMaintenanceParticipant及enterMaintenance；host卸载后dispose storage。restore.test删除旧Connection包装/no-op维护的本地createRealStorage；没有给L11注册补可选调用或假方法。L11实际注册vfs-worker的pauseAndDrain/resume及卸载disposer继续执行。B05 `backup-manager.ts:683-712`仍委托正式vfsMaintenance.resetRebuildableIndex，未复活backup本地VFS写者。

**原断言完整**：ecff diff仅改装配/清理，不删expect或改timeout。两Rust对应VFS用例（backup/mod.rs:6777/7032）保留partial目录移除、资源与索引/维度/profile/file/exam字段重置、legacy数据保留、完整组件保留；恢复保留四库候选槽、marker、lease的backup/target/activation_committed=false、requires_restart与success；ZIP保留sealed/解密后manifest、原库哈希和最终MARKER_VALUE。完整恢复60s、ZIP120s及其它原预算不变。

| 证据 | 原始结果 | 归属 |
|---|---|---|
| **20261104233518-7302dd** | Electron 3文件/4passed/38标题过滤skip，exit0，无Errors/Unhandled Errors | 已亲取owner修复树结果，不冒称R4新执行 |
| **20261104233518-5a602c** | Node backup27文件/437passed/0skip，exit0，无Errors/Unhandled Errors | 复用owner既有目录回执，未重跑437例 |
| **20261105003031-628a63** | R4实际main 3文件/4passed/38标题过滤skip，exit0，无Errors/Unhandled Errors | 本轮唯一新增测试作业；四例耗时2787/1797/21717/22704ms |

因此四个fixture主线红项完成限定复验，B05原签收有效。此恢复fixture仍有publication/settings等边界替身，`installSyncService`也不是完整真实notes/syncSupport启动组合；不借四例扩签D2失败政策/外部维护状态或此前§15之外的整条启动链。B02/B03/B06/B07、Slot/W69等父组保留。

**自检范围说明**：本轮遵循C2“仅三受影响文件最小复核、不重跑1842集求绿”。现有lane-gate.mjs没有测试路径过滤参数，gateChecks会按验收文档路径触发四插件全目录；已向C2请求限定门禁裁定，未修改脚本/白名单/selfgate记录。003031-628a63是窄集通过，不冒称新HEAD完整lane-gate通过。只提交授权验收文档；sync/ACCEPTANCE 后于2026-11-05按用户授权无损迁入R4总审计末节，未改白名单。

**C2后续澄清**：三文件限制仅针对额外手工专项，不豁免standard-v2 §5最终官方lane-gate；C2接受64e4e8456及固定c630四项闭环，不再要求L21重做。上段为请求裁定时的历史状态，现按澄清提交/merge后执行一次官方gate，额外专项不重复；审计路径触发广域测试及sync白名单仍交架构处理。

## 19. 未授权skip与合法Value正例恢复执行（536aad095 / 候选91067dab2）

固定main **536aad0958f4fe5830da347b1f37a1f57089ce93**、合并HEAD **ab0533ca7923f2e0dc78add6e60dd9a8353e2286**。C2已明确：两个arbitrary_precision正例的完成状态pending不授权用skip禁用；R4此前分列20Docker与2审计skip、未扩签serde，只是记录事实，**不是批准skip**。当前main `tests/audit-decode.test.ts:237`仍是it.skip.each，不能把依赖待合入当作合法豁免。

原正例输入及期望保留：`{"n":1e999}`重存为`{"n":1e+999}`；数组中的±1e999与高精度小数也必须保留精确数字token。Rust `dstu-storage/src/audit/mod.rs:38,799-804`字段为Value，桌面arbitrary_precision下这些是合法JSON值，不应走坏JSON→Null降级。typed AuditOperation整数拒绝超范围数与此Value正例是不同合同；仅检查序列化错误前缀不能证明全部typed诊断顺序正确。

只读核L21候选 **91067dab299d13753538181847856ccd74030b50**：改回普通it.each，仅变更注释和skip标记，两个输入、not.toBeNull、精确重存断言不变；该提交不是固定main祖先。亲取现成作业 **20261105022638-b0d5a2**（Node）及 **-5547a9**（Electron），各**2failed/4passed/35标题过滤skip、exit1**，无额外Errors/Unhandled Errors。两失败均是`decoded.details === null`违反`:247 not.toBeNull`；真正坏JSON/SQL NULL/空串fallback及typed拒绝控制通过。恢复可执行修正了测试禁用，不等于实现已修，更不能称main闭环。

此前R4 main **20261105020220-6dc310**原exit1，1930passed/1failed/22skip，其中20Docker＋2本节未授权skip；governance-tool-execution5/5、audit-decode39passed/2skip。仅保留该运行事实，不据工具子集registry通过签全App装配、普通sync_run取消/超时停止I/O或完整Value。owner旧450passed/2skip回执同样仅属历史；registry两项未复现也不证明原集成根因已修。

等待正式F4数字投影合同与L21消费者正常同树，并复核已恢复的原正例/fallback/typed边界；本轮不新增已知失败专项、不改测试/生产/TESTMAP，不以null、Infinity、字符串或能力探测跳过迁就实现。B06/B07及其它父组保持未决。
