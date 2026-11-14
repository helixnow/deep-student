# L23-sync-providers：同步传输与供应商

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L23-sync-providers（同步传输与供应商） |
| 目录 | `host/plugins/sync-providers/` |
| Rust 范围（lanes.md） | dstu-sync 的 cloud_storage（S3、WebDAV、FTP）、tests/sync_*、webdav、e2ee |
| 主要提供 | `sync.provider@1` |
| 主要消费 | F4、F7 |
| 特别注意 | 测试量最大（859 个），以移植为主；断点续传、截断、文件名跨平台 |
| 规模（本目录） | 53532 行 · 50 个文件 · 14 个命令（前端调用 14） · 859 个测试 |
| 规模（整条 lane，inventory） | 53532 行 · 50 个文件 · 14 个命令（前端 14） · 859 个测试 |
| 契约 | [`contracts/ipc/L23-sync-providers.json`](../../../contracts/ipc/L23-sync-providers.json) |
| 服务草稿 | [`contracts/services/DRAFT-L23-sync-providers.md`](../../../contracts/services/DRAFT-L23-sync-providers.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-sync/src/cloud_storage/backup_lease.rs` | 521 | 3 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/bad_object.rs` | 1003 | 16 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/config.rs` | 774 | 10 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/delta_format.rs` | 286 | 0 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/delta_gc.rs` | 645 | 0 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/delta_restore.rs` | 663 | 0 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/delta_upload.rs` | 826 | 0 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/e2ee_claim.rs` | 1623 | 14 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/ftp.rs` | 1674 | 15 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs` | 882 | 12 | 14 |
| `src-tauri/crates/dstu-sync/src/cloud_storage/repo_check.rs` | 746 | 5 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/resume.rs` | 248 | 4 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/s3.rs` | 1441 | 17 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/sync_lease.rs` | 578 | 3 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/sync_manager.rs` | 3463 | 32 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/traits.rs` | 860 | 7 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/verified_publish.rs` | 585 | 7 |  |
| `src-tauri/crates/dstu-sync/src/cloud_storage/webdav.rs` | 2842 | 32 |  |
| `src-tauri/tests/e2ee_claim_race_tests.rs` | 555 | 4 |  |
| `src-tauri/tests/sync_adversarial_tests.rs` | 1491 | 40 |  |
| `src-tauri/tests/sync_android_device_switch.rs` | 1143 | 9 |  |
| `src-tauri/tests/sync_android_restart.rs` | 914 | 15 |  |
| `src-tauri/tests/sync_chaos_tests.rs` | 703 | 10 |  |
| `src-tauri/tests/sync_comprehensive_tests.rs` | 1079 | 59 |  |
| `src-tauri/tests/sync_file_level_e2ee.rs` | 528 | 7 |  |
| `src-tauri/tests/sync_integration_deep_tests.rs` | 659 | 12 |  |
| `src-tauri/tests/sync_pathological_tests.rs` | 1712 | 40 |  |
| `src-tauri/tests/sync_proptest.rs` | 568 | 6 |  |
| `src-tauri/tests/sync_provider_contract_tests.rs` | 2464 | 62 |  |
| `src-tauri/tests/sync_r02_hardening_tests.rs` | 613 | 4 |  |
| `src-tauri/tests/sync_r05_regression_tests.rs` | 526 | 7 |  |
| `src-tauri/tests/sync_r06_delete_resolve_tests.rs` | 300 | 2 |  |
| `src-tauri/tests/sync_r07_autosync_pending_tests.rs` | 77 | 2 |  |
| `src-tauri/tests/sync_r07_cross_platform_names_tests.rs` | 414 | 4 |  |
| `src-tauri/tests/sync_r07_delete_resolve_lock_tests.rs` | 372 | 3 |  |
| `src-tauri/tests/sync_r07_e2ee_wrong_password_tests.rs` | 417 | 4 |  |
| `src-tauri/tests/sync_r07_filename_tests.rs` | 448 | 4 |  |
| `src-tauri/tests/sync_r09_download_resume_tests.rs` | 468 | 6 |  |
| `src-tauri/tests/sync_r09_file_e2ee.rs` | 919 | 12 |  |
| `src-tauri/tests/sync_r09_filenames.rs` | 488 | 7 |  |
| `src-tauri/tests/sync_real_business_tables_tests.rs` | 1291 | 25 |  |
| `src-tauri/tests/sync_real_flow_smoke_tests.rs` | 3036 | 15 |  |
| `src-tauri/tests/sync_real_schema_tests.rs` | 942 | 11 |  |
| `src-tauri/tests/sync_realistic_scenarios.rs` | 4111 | 115 |  |
| `src-tauri/tests/sync_regression_tests.rs` | 1172 | 28 |  |
| `src-tauri/tests/sync_scenarios_tests.rs` | 2971 | 72 |  |
| `src-tauri/tests/sync_schema_coverage_tests.rs` | 533 | 11 |  |
| `src-tauri/tests/sync_weird_tests.rs` | 2283 | 72 |  |
| `src-tauri/tests/webdav_download_resume_tests.rs` | 401 | 6 |  |
| `src-tauri/tests/webdav_list_truncation_tests.rs` | 274 | 8 |  |

### 命令（14）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `cloud_storage_check_connection` | `crates/dstu-sync/src/cloud_storage/mod.rs:297` | async | app | src/utils/cloudStorageApi.ts:718 | (config: CloudStorageConfig) → boolean ! AppError |
| `cloud_storage_delete` | `crates/dstu-sync/src/cloud_storage/mod.rs:346` | async | app | src/utils/cloudStorageApi.ts:788 | (config: CloudStorageConfig, key: string) → null ! AppError |
| `cloud_storage_exists` | `crates/dstu-sync/src/cloud_storage/mod.rs:370` | async | app | src/utils/cloudStorageApi.ts:822 | (config: CloudStorageConfig, key: string) → boolean ! AppError |
| `cloud_storage_get` | `crates/dstu-sync/src/cloud_storage/mod.rs:322` | async | app | src/utils/cloudStorageApi.ts:753 | (config: CloudStorageConfig, key: string) → integer(u8)[] \| null ! AppError |
| `cloud_storage_is_s3_enabled` | `crates/dstu-sync/src/cloud_storage/mod.rs:737` | sync | app | src/utils/cloudStorageApi.ts:1029 | (（无）) → boolean |
| `cloud_storage_list` | `crates/dstu-sync/src/cloud_storage/mod.rs:334` | async | app | src/utils/cloudStorageApi.ts:771 | (config: CloudStorageConfig, prefix: string) → FileInfo[] ! AppError |
| `cloud_storage_put` | `crates/dstu-sync/src/cloud_storage/mod.rs:309` | async | app | src/utils/cloudStorageApi.ts:735 | (config: CloudStorageConfig, key: string, data: integer(u8)[]) → null ! AppError |
| `cloud_storage_stat` | `crates/dstu-sync/src/cloud_storage/mod.rs:358` | async | app | src/utils/cloudStorageApi.ts:805 | (config: CloudStorageConfig, key: string) → FileInfo \| null ! AppError |
| `cloud_sync_delete_version` | `crates/dstu-sync/src/cloud_storage/mod.rs:714` | async | app | src/utils/cloudStorageApi.ts:917 | (config: CloudStorageConfig, versionId: string) → null ! AppError |
| `cloud_sync_download` | `crates/dstu-sync/src/cloud_storage/mod.rs:552` | async | app | src/utils/cloudStorageApi.ts:898 | (config: CloudStorageConfig, versionId?: string \| null, localDir: string, allowPlaintextHistory?: boolean \| null) → DownloadResult ! AppError |
| `cloud_sync_get_device_id` | `crates/dstu-sync/src/cloud_storage/mod.rs:731` | sync | app | src/utils/cloudStorageApi.ts:931 | (（无）) → string |
| `cloud_sync_get_status` | `crates/dstu-sync/src/cloud_storage/mod.rs:384` | async | app | src/utils/cloudStorageApi.ts:838 | (config: CloudStorageConfig) → SyncStatus ! AppError |
| `cloud_sync_list_versions` | `crates/dstu-sync/src/cloud_storage/mod.rs:396` | async | app | src/utils/cloudStorageApi.ts:851 | (config: CloudStorageConfig) → BackupVersion[] ! AppError |
| `cloud_sync_upload` | `crates/dstu-sync/src/cloud_storage/mod.rs:410` | async | app | src/utils/cloudStorageApi.ts:870 | (config: CloudStorageConfig, zipPath: string, appVersion?: string \| null, note?: string \| null, recoveryKind?: string \| null) → UploadResult ! AppError |

### 发出的事件（1）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `cloud-sync-progress` | 字面量 | crates/dstu-sync/src/cloud_storage/mod.rs:206 (emit) |

### 契约中的事件（1，`contracts/ipc/L23-sync-providers.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `cloud-sync-progress` | 否 | CloudSyncProgressEvent | crates/dstu-sync/src/cloud_storage/mod.rs:206 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-221：后续八条字段合并原断言移植

本包从 `499b437c2` 正常 fast-forward 到 main
`0292921234955ff14c6f105d2595acc958ccb5da`，仅新增 Rust
`sync_comprehensive_tests.rs:520-626` 对应八例（TS :331-382）。公开
`sync/api.ts:31` 的同一 `mergeField` 已在 main，由生产 apply-record/apply-guard
消费；八例原输入与21个 assert 完整保留，原测试无 unwrap。逐条证据见 TESTMAP
WP-221 节，既有测试及30s/default hook预算保持。

Node `20261105235110-23fcfb` / Electron `20261105235110-5c9708` 整文件各
31 passed / 0 failed / 0 skipped / Errors0，原 exit0。只有八行去向转 ported，
逐行统计677/181/0/1→685/173/0/1（ported/pending/merged/obsolete）；本包明确
授权下刷新旧头部。起点 checksum 作业排队到新增测试后执行，3 passed / 28标题
过滤，不算新增八例的验收或固定旧树23例基线。所有检查经 jobs；正式 gate 原始结果
见交付报告。foreign 两账本保留，由 C2 清洁组合并独立抽检≥1/8后裁定资格。

### WP-180：消费已 main 的 mergeField，移植原 WP-032 八 ID

开工正常 merge main 至 `f0b14cfd5`（main `fd9d654d7`，含 L20 集成 `b54983282`；
`23a583250` 为 main 祖先）。亲读 Rust `sync_comprehensive_tests.rs:421-501` 后，
只在 `tests/comprehensive_sync.test.ts:273-329` 增加八例，经 `sync/api.ts:31`
的直接重导出消费 `src/field-merge.ts:68`。生产 `apply-record.ts:604` /
`apply-guard.ts:120` 使用同一实现，从 `sync/index.ts:169-176` 服务可达。

原5/3、7/7、0/0、blobs10/3和四组标签输入逐一保留，四计数测试三元组全部断言；
两个标签 union 同时保 as_array().unwrap() 的数组形状检查，原 len/merged 断言不减。
逐条文件/行号与失败边界在 TESTMAP 的 WP-180 节。Node 基线15/15
`20261105220014-54710e` exit0；新增后 Node `20261105220122-6571e1` 和 Electron
`20261105220122-949091` 均 **23/23、exit0、0 skipped、无 Errors**，预算未改。

TESTMAP 仅八条 pending→ported，实际 **677 ported / 181 pending / 0 merged /
1 obsolete**；旧生成统计头未手改。BLOCKERS 已明确 WP-032 接口缺口是历史，
本轮无同步实现改动，旧 `test_max_value` 去向资格保持历史、不撤销或恢复。
已向 C2 请求至少1/8独立抽检；正式 gate / foreign ledger 前置结果在交付回执记录。

提交 `04c99885d` 后正常 merge main（当次 up-to-date），直接运行官方绝对路径
lane-gate，原 **exit2**：`有未提交的改动，先提交再自检（自检结果按提交记录）`，
只列 `migration/LEDGER.md` / `migration/ledger.json` 两项开工即有的 foreign dirty，
没有启动子检查 job。保留他人账本，由 C2 做清洁组合；独立抽检请求已带固定源码提交。
分项 jobs：strict boundaries `20261105220122-9b8512` exit0（3133 files/0违规）；
importable `20261105220122-953388` exit0；去向更新后 wiring
`20261105220337-cd703c` exit0（ported677，未接入0）。只读 ledger
`20261105220122-0491ec` exit0，commands/tests/orphan problems均0；该作业在去向
更新前启动，其全仓 A/B 数不作为本包八条新去向的验收。新增测试后的类型检查
`20261105220337-c403af` exit0、无 Errors（基线 `20261105220014-c23257` 亦 exit0）。

### Q2.4已完成：FTP giant按职责拆分（2026-11-05）

C2本轮裁定实际拆分；代码tip `c236ef96e`（父 `6c371057a` 新增模块）。
`src/ftp.ts` 1207→1095行，纯列表/日期解码移至 `src/ftp-listing.ts`：
`FtpListEntry`、MLSD/compact日期、POSIX/DOS及`parseListEntry`。`ftp.ts`保留
原值/类型re-export，`FtpStorage`/`FtpSession.mdtm`继续调用同一实现；未改
POSIX/DOS、传输预算/重试、TLS、日志、断言或TESTMAP去向，源码锁定段未移。
拆分后固定源作业：FTP整文件`20261105092045-9d6940` exit0/35/35、
typecheck`20261105092045-bb42a2` exit0、boundaries`20261105092045-9de025`
exit0/2981files/0违规，均无Errors。标准最终gate仍被lane外ledger dirty前置
阻塞（不碰/stash/reset）；W69与199 pending独立保留，不因拆分改状态。

### Q2.4历史：精确FTP giant反馈仅保存，未实施结构改动

收到1208行拆分反馈后已审读quality.md §2.4及FTP职责/导出/源码锁定测试，但尚未
移动或改写源码。后发C2指定先交接由健康会话落实，按该最新指令本轮只记录计划。
精确键giant|host/plugins/sync-providers/src/ftp.ts，feedback-state.sent ref83fe334bb；
C2核旧1197→新1207、阈值>1200，是结构问题而非新测试失败。职责最小提取纯列表/
日期模块可行，保ftp.ts必要值/类型re-export与真实生产调用；不压行删注释、不改
POSIX/DOS/传输策略/预算、不加框架或扩大去向。详见HANDOFF置顶。
源未动，本轮无新测试/类型/边界作业；实际拆分后才固定源复用FTP35例及规定检查，
不新增案例矩阵/目录/W69/S108重测。该质量项仍pending，不把计划写成已解决；
TESTMAP659/199/1、已验068日期修复及外部ledger/W69阻塞不变。

### L23-V2-1.3-FTP：最小日期修复结果已齐，按C2交健康会话

源候选06867c21a/tree8891dadd，依锁定suppaftp7.1.0官方只读源纠正Date.UTC滚动
非法日期及MLSD SystemTime/MDTM NaiveTime混淆。复用F4原时间原语，不复制parser，
保原不同投影/错误/大小与传输预算；六新例含两条真实FTP stat拒绝路径。先红
`20261105073524-b30864`原exit1、5failed/1passed/29过滤；固定源后完整FTP
`20261105074123-c98ffc` **原exit0、35/35**，typecheck
`20261105074123-495e83` / boundaries `20261105074123-a16bba` **原exit0**，均无Errors。
全部回执期间未改源/用例/config或merge，结束HEAD/tree相同、diff空；此后才保存。
详细依赖原语/URL/冻结/原job表见 `pending/FTP-calendar-receipt.md`。

source checkpoint提交信息误沿用旧656/202/1，实际冻结树/当前TESTMAP均659/199/1，
本修复无去向改动，不改写历史元数据。六补充不提Rust行，生成头/外部ledger未动。
晚到fulltest2a8df3141/07:33Z的W69仍40532.189368ms>30000，C2后发裁定只保存，
本轮未新排W69/S108/目录/全集、未跨界改SQL或指标。当前最小单元已保存，长会话
按要求交健康会话；全部job均已取回，不重复已过专项，不自行restart/park/切模型。

### 固定9b树取回集成反馈复核；W21–W23三例去向收尾

W21–W23源码先提交9b5f4210f，保Rust:560-637全部原输入/首unwrap/title读取/
数值和空字符串形状，不加结果政策、catch或解析副本。小集
`20261105064400-04a877`原exit0、3passed/43标题过滤、无Errors；前后HEAD/tree/
源/测试/config一致，title=v2与success1/failure0仅观察。只三行去向转ported，
859实际659/199/1，生成头不动，W17等不一并批准。

之后收到集成三新失败反馈；只读gate-fail记录tip76bb于06:38，只有新测试、未含
06:39提交的c148生产修复，未修改/清除外部记录或冒认原merge/root。按该新反馈
另固定同9b树执行一次typecheck `20261105065253-5c3a54`/boundaries
`20261105065254-8da6b4`（均原exit0），目录 `20261105065254-247c2d` **原exit1，
950passed/仅W69failed33073.86823ms/20Docker未执行，无Errors**。WebDAV44/44、
weird_sync46/46通过；测试活跃期不merge/编辑，结束核仍9b/treee8d2、相关diff空，
仅原外部ledger dirty。本次目录确实覆盖已有P36/S108/W69，是新集成反馈要求，
未另排阶段诊断或循环重测，不将baseline豁免说成全绿。完整原首栈/来源见
`pending/Retry-After-integration-receipt.md`；W69生产写者和正式gate前置仍未解除。

### L23-V2-1.3：WebDAV Retry-After数字分支的u64/精度修复

自动续派先merge至133e74a96，W69写权限/生产查询与ledger阻塞无变化。对照Rust
webdav.rs:311-324发现自有Number秒数解析漏u64上界/丢精度/+前缀，越界值会错误
选择30s等待而非默认退避。仅数字分支改BigInt精确校验/毫秒表示，safe范围或
等待封顶后才转number；HTTP-date、窗口、重试预算/退避策略和跨插件API均未改。
新三回归先红 `20261105062952-911a4f` **原exit1、3failed/41标题过滤、无Errors**；
源码修后 `20261105063307-6de124` **原exit0、WebDAV44/44、无Errors**，包含原
Retry-After HTTP-date/封顶/退避及所有传输用例；boundaries `20261105063307-05c5dd`
exit0、0违规。typecheck `20261105063307-2c37ae`已取回原exit0、无Errors。此为真实自有实现
增量，不是重复同红树；未重跑迁移目录/全套/W69/S108。TESTMAP656/202/1不变，
三补充不提升Rust行；不把此小修签成整个P04或历史性能根因修复。

### L23-W18/W20：C2限定原1969/纳秒文本的两个真实apply观察

本轮merge至85193f897后只移植原W18:495-510/W20:533-555，保原id/title/null、
1969-12-31T23:59:59Z与2026-05-01T12:00:00.123456789Z在payload/changed_at原文，
W20未用tsAgo(10)及同连接别名亦保留。新增私有内存fixture只供这两例，真实F3/
原schema/触发器/refinery行，不改其他病例；实际已安装sync公共apply后打印Result。
无catch/私造错误分类、时间解析复制或L20策略修改，不强造成功/拒绝/落库值政策。
唯一小集 `20261105060240-15cfcb` **原exit0、2passed/41标题过滤、无Errors**，
两例均正常返回success1/failure0仅作观察；不把旧1969注释当规则，不签纳秒落库精度。
TESTMAP仅两行转ported，含此前独立W13后实际859=656/202/1，生成头不动；
未扩大W17/其它观察项，未重跑已过项/目录/S108/W69/全集。

### L23-W13：生产同源serializer的原NaN单个回归

本轮先merge至6f9e307b9，W69实现/写权限、外部ledger阻塞未变。审自有pending W13：
原Rust:388-396是serde_json::to_string(f64::NAN)断言Err或null，不是SQL/apply调用。
固定serde_json1.0.149 ser.rs:169-179对NaN写null；main公开stringifyJsonLossless
已有同分支且被真实payload/quarantine链消费，实现正确，本轮仅补测试，不造副本。
TS原NaN输入走公开serializer，正常返回后断言原Ok分支null，无catch或伪造Err分类。
`20261105054602-d9151f` **原exit0、1passed/40标题过滤、无Errors**。只W13去向
转ported，859实际654/204/1，生成头不动；未编译Rust/宣称差分、未跑目录/其它
用例/S108/W69/全集，不扩签其它JSON语义或整lane，旧性能红灯仍未修。

### main-red最高优先级增量：05:18Z eaa17全量仍为W69性能失败

复用固定eaa17bc7e的shard6 `20261105050414-f9d810`原exit1：apply39579.047572ms
超30000，四计数断言均过；W69本体/fixture/L20/F3无相关差异，W55仅使行号
390→412，无新接口不匹配证据。未据此排尽运行环境影响或定CPU/算法完整根因。
真实生产仍table-first，候选未应用；已escalate `2026-11-05T052208691Z-L23-sync-providers.md`
请求实际L20获权写者/一行窄授权，原首栈及旧失败并列保存在W69任务卡。
此轮无新作业、源码修复或测试指标修改，不把失败分流文档标为fix(main-red)。

### L23-P40：复用P36既有通过，补齐10组ID不匹配的原观察

C2下一批限定P36/P40；P36已在c8e10cc16提交且job20261105045404-bcaeff原exit0、原5000次/
COUNT5000/23890.568476ms<60s，本轮复用，不重跑。仅新增P40原Rust:1668-1711：
真实内存F3/schema/refinery行，10个rec_i/payload_i、两次tsAgo(100-i)/title/null，
真实批量apply打印后正常返回时执行两次原LIKE COUNT/unwrap（db.one），不以单条
业务失败数跳过查询、不固定计数/要求成功/改ID策略，无catch或私造错误分类。
`20261105051211-30238b` **原exit0、1passed/34标题过滤、无Errors**；打印返回
success0/failure10及两COUNT0/0只是观察。TESTMAP仅P40新转ported，859实际653/205/1，
生成头不动；未重跑P36/P20/W12/S108/W69/目录/全集，无生产实现改动。

### L23-P36：原5000次独立apply/COUNT与60s断言移植

本轮merge至da5fe744f，L20/F3无实现增量，W69写权/ledger阻塞不变。继续明确有
断言的自有pending P36，保Rust:1475-1504原内存schema/refinery行、5000次单条
apply、r00000…ID/逐条ts、计时包含构造/调用但不含COUNT，严格原COUNT=5000与
elapsed<60s。新case runner allowance120s仅让原断言有机会执行，不放宽60s阈值，
未并批/增索引/减量或修改既有case预算。只一次最小 `20261105045404-bcaeff`：
**原exit0、1passed/33标题过滤、无Errors，23890.568476ms，实际5000条**。
TESTMAP仅P36转ported，859实际652/206/1，生成头不动；无生产修改或循环求绿，
不重跑P20/W12/W69/S108/目录/全集，不连带W69或历史根因结论。

### L23-W12：C2限定的精确u64大数Result观察

仅移植 `w12_large_numbers_in_json`，保Rust:367-384原id=big/title=t/counter=
u64::MAX-1、nowTs/deleted_at及原内存schema/INTEGER affinity。使用公开DbJson与
精确bigint `18_446_744_073_709_551_614n`，不经Number，不在测试中做转换。
真实F3/已安装sync公共apply后打印Result，无catch/必须成功或失败/截断值断言，
不改L20生产转换。唯一 `20261105043559-8d4b33` **原exit0、1passed/39标题过滤、
无Errors**；打印精确大数及success0/failure1为本次观察，无顶层抛错，不吞panic。
TESTMAP仅W12一行转ported；当前在已独立P20增量之后实际859=651/207/1，生成头
不改。未重跑W55/A13/A33/目录/S108/W69/全集，其它观察项仍逐项判断。

### L23-P20：归档日志性能原断言的单个最小移植

本轮merge至5c1e95964，官方gate仍仅外部ledger dirty前置exit2；W69生产写权
未解除。继续自有pending，纠正“共享队列不稳定所以不执行”的旧P20说明。
保Rust:852-884原10000条已同步日志、内存schema/触发器/refinery历史行、deferred
事务提交、构造变更前开始的单调计时、真实公开apply及原<500ms；无新索引/减量/
计时范围调整/阈值放宽。只执行一次最小 `20261105042830-151b20`：**原exit0，
1passed/32标题过滤，无Errors，73.875603ms<500**。仅P20 TESTMAP转ported，
最新859=650ported/208pending/1obsolete，生成头不改；没有生产修改或循环求绿，
不推断P36/W69已修，不重跑S108/W69/目录/全集。

### L23-A33：限定补齐apply与两次COUNT的原不崩溃观察

按C2仅处理 `adv_33_payload_id_mismatch_with_record_id`，保Rust:1224-1263原
record_id=n1/payload.id=n2、title/time/deleted_at等字段。实际F3/已安装sync公共
apply丢弃Result，两次 `db.one` COUNT对应原query_row.unwrap，打印但不固定计数。
无catch、强加成功/必须写某ID、私造错误分类或生产ID策略修改。
唯一 `20261105040401-7d0bcb` **原exit0、1passed/38标题过滤、无Errors**，
真实COUNT打印n1=0/n2=0仅作观察。仅A33去向转ported，859行实际649/209/1，
生成头留infra。未重跑38条/目录、S108/W69/全集，其他观察例仍逐项待判断。

### L23-W55：纠正公开只读标志漏查，原只读apply用例移植

自动续派先merge main，仍无W69生产/权限增量，官方gate被外部ledger dirty前置
exit2。核pending发现F3当前已有公开ConnectionProfile.readonly，并实际传入驱动；
原“没有只读打开flag”的test头阻塞不成立，不需另派提供方实现。
只移植 `w55_readonly_connection_rejected`，保Rust:1531-1561原schema/输入/只读
重开/`is_err()`：真实F3建库→关闭→readonly重开→已安装sync实际apply，匹配真实
database readonly错误，不用query_only、catch-all或任意throw冒充业务Err。

`20261105035916-111d65` **原exit0、1passed/16标题过滤、无Errors**。TESTMAP仅
W55转ported，859行实际648ported/210pending/1obsolete；未改生成头，无生产改动。
未重跑同文件W69、S108或全集，A33/其它无assert条目仍不在本单元批准范围。

### L23-A13：限定补齐payload类型不匹配的原不崩溃不变量

按C2最新单元仅移植 `adv_13_payload_type_mismatch`。Rust:570-587原counter字符串
进入INTEGER列，调用生产apply并忽略Result，不要求排除业务Err、成功或特定值。
TS保原payload/SQLite affinity，复用真实F3/已安装sync/public apply，不自写apply/
coercion、不catch-all；本输入实际正常返回。原“不含assert所以不能移植”的说明
已纠正，A14旧缺接口描述只改为既有device_identity去向，未另跑A14。

最小 `20261105033816-193e72` **原exit0、1passed/37标题过滤、无Errors**，
只将对应TESTMAP一行转ported；实际859行=647ported/211pending/1obsolete，生成头
仍旧637/221交infra。A33及其它pending/obsolete裁定均未扩大；未重跑37条/目录、
S108/W69或全集，无生产修改。SPEC/BLOCKERS记录实际路径与未观察业务Err的边界。

### L23-V2-1.7：WebDAV 限流窗口对齐 Rust Instant

本轮先merge main（f1cedb569），W69实际L20写者及外部ledger dirty均未解除；
S108唯一诊断额度已用、不重跑。继续HANDOFF已保存的自有事项：Rust
webdav.rs:142/145/150用Instant，TS窗口仍墙钟。生产仅一行Date.now→performance.now，
不改HTTP-date Retry-After、窗口/共享键/取消/等待策略，不增开关或复制算法。

新增四回归用真实gate/共享实例/实际已取消AbortSignal，不替换sleep或业务实现。
原取消测试只把填窗输入对齐Rust:1851的Instant，原全部断言不变。首次
`20261105032738-ed02a1` exit1（3failed/1passed），其中1项为新测试Error.name假设
错误，已保留原结果并更正为instanceof+原文message；更正后未修源码先红
`20261105032931-233f31` exit1（2failed/2passed/37标题过滤）：两个墙钟跳变失败，
正常到期/未到期控制项通过。修后完整WebDAV `20261105033052-311154` **41/41、
exit0、无Errors**；boundaries `20261105033052-1f4d8c` exit0、2977files/0违规。
typecheck `20261105033052-b51258` 后续已取回原exit0、无Errors；源修复提交
`d476cf29e`，三项实际结果已齐，不追加重测。4个补充不提升
TESTMAP或R4验收；没有重跑同红树W69、S108或930/1938全集。

### main-red最高优先级：03:04Z全量W69证据已核，生产写权仍阻塞

固定main dd564e12f、shard6 `20261105024553-95d982`原exit1，W69
apply42705.341065ms>30000，四项计数断言通过；case42745.878074ms。
相关test/L20/F3相对既有诊断未变，未发现新接口不匹配，且全量版本不含S108
observer。当前生产SQL仍table-first；旧微基准快38%不证明原W69能过30s。
已立即escalate `2026-11-05T030837111Z-L23-sync-providers.md` 请求有L20写权限
的实际实施者或明确一行窄授权，未自行改parked源码、未降低断言/加测试索引或重跑。
完整原首栈与新证据在 `pending/W69-main-red.md`，BLOCKERS同步。此为失败分流，
不是生产修复；真实修复才以fix(main-red)提交并保原用例与DELETE/LWW验证。

### L23-P08：C2解除旧会话限制后，唯一S108阶段诊断已取回

C2确认实际上下文回落并撤销“仅等新会话”的限制，允许当前工作树一次诊断。
已读HANDOFF/c852/a61与C2 01:15–02:31（及后继02:41裁定），开工/提交前查重
无同目标活跃作业。仅提交 `20261105025729-64ec28`，受测HEAD `e077e3f6a`，
测试观察代码已在自动checkpoint `fdd901192`；**原exit0、1passed/19标题过滤，
S10865592ms，文件80820ms、总96.29s，无Errors/cleanup/RPC错误**。

原10×10/最终100断言、180s/10s及真实迁移/owner链均保留，不重做Buffer或改W69。
58阶段start均有end、无error：D0–D9 runAll累计63251.231ms；applyPending1697.181ms，
内嵌applyDownloadedChanges1529.424ms不与外层相加；host.dispose14.154ms、12个
storage.dispose合计233.534ms、root rm32.288ms，cleanup起止跨度282.916ms。
有效forks cap3、实际单文件worker PID3925782；队列起止8/5个test作业，不拿cap
或机器核数代替实际并发。当前notes依赖较原a968有增量，非原失败树/全套环境复现。

完整回执见 `pending/S108-stage-diagnostic.md`，原87e02a/65a692失败与be9c71通过，
以及后继main组合6dc310通过均分开保留。本次仅定位成功运行的阶段耗时边界到真实
F3 runAll，不证明历史超时也发生在此、不定CPU/算法根因、不扩签P04/P08。
额度已用，本轮保存后结束，不为新回执继续重测；ledger dirty仍交infra，W69写者待定。

### 最新 R4 组合故障：保存后由清洁会话做单个最小诊断

C2 固定 R4 `d89674497` / main `a968`，job `20261105004819-87e02a` 原 exit 1：
**1916 passed / 2 failed / 20 Docker skip；Failed Suites 1；Errors 1**，另有
Unhandled onTaskUpdate。新增 S108 原180000ms超时与 stress afterAll
`h.dispose()` 原10000ms超时；W69 47523ms 为独立既有失败，不能统称唯一W69/全部CPU。
旧930/1仅覆盖其原SHA，不外推到此组合。

此长会话仅保存交接，不排新诊断/不重跑930或1938全套。下一清洁会话复用已有相关
作业（若有），否则只做一次最小S108及cleanup诊断；保10设备×10条、最终100条、
原180s/10s与实际F3/owner链，记录逐device建库、apply、host卸载、storage关闭、rm
各阶段开始/完成/错误/单调耗时和实际worker并发环境。非零保完整首栈，不循环求绿；
只有明确定位到F3/L20生产阶段才交C2具体方法/栈。完整最新约束已置HANDOFF最上段。
本次无新增实现/无新增作业，不改变预算、迁移、owner或原断言。

C2 后续亲取同业务源码对照 `20261105011308-be9c71`：原 exit 1，1917 passed /
唯一 W69 39002ms failed / 20 Docker 未执行，无 Errors；S108 42730ms 通过，无
cleanup/RPC 超时。只说明该次未复现，不是生产修复，不擦掉原
`20261105004819-87e02a` 的 S108 184280ms、afterAll10s超时、Failed Suites1 / Errors1。
两次结果已在 HANDOFF 原失败旁并列；新会话优先复用，最多一次最小阶段诊断，
不循环求绿、不抬预算。本轮依 C2 指令只保存对照，没有排任何测试或诊断作业。
自动续派只读预检又确认两原作业 cwd/命令相同（无显式 maxWorkers），保留各自
start/end 与原日志首栈索引；没有据此推断实际 worker 环境相同。queue/running
未发现现成最小S108作业，较早其他组合不能替代；新会话仍须先重新查重。
当前未改 harness/stress，没有新增实现/作业，细节已保存到 HANDOFF 原失败旁。

### 下载缓冲所有权增量（W69/协调链仍阻塞）

已 merge main；L20/F3 热点与公开接口仍无新代码，官方 lane-gate 仍被外部 ledger
dirty 拦截（exit 2）。继续独立修本 lane 的实际 Node Buffer 借用语义差异：Rust
traits.rs:273-276 在预算检查后复制输入到 Vec，TS slice 对网络 Buffer 仅共享内存。
改一行为 Uint8Array.from，保留预算、长度和所有原断言，未加哈希/开关/协议分支。

先红 `20261104235153-1714e6` exit 1（2 failed / 8 passed，无 Errors）：Buffer 和
子视图被输入重用污染，普通 Uint8Array 控制项原已通过。修后
`20261104235457-37bc5f` 三文件90/90、exit 0、无 Errors；typecheck
`20261104235457-4b0e27` exit 0、无 Errors。三补充用例不计入新的 Rust 行，仍
646 ported / 212 pending / 1 obsolete，不把组件通过当作完整门禁或 W69 已修。

中断恢复后的只读 ledger `20261105000439-73920d` exit 0，问题数 commands/tests/
orphan registrations 全 0。全仓 commands1058 A100%，tests8109 A87.8%/B1.9%，
prod-reachable unreachable16、unknown3633不否决；不是本 lane 的验收或新问题认定。
本轮 Buffer 代码后的全插件 `20261105000759-c4232d` exit 1，**930 passed /
1 failed / 20 Docker 未执行**，无 Errors；唯一未改动 W69 为46509.72ms，原阈值保留。
boundaries `20261105000759-6696cd` exit 0，2949 files/0违规，无 Errors；
typecheck `20261105000759-95595f` 随后已取回 exit 0、无 Errors，三项结果均如实记录。
最新简明交接点在 HANDOFF.md，勿因自动 checkpoint 或 diff 为空重复写已提交代码。
结果取回后再核调度：C2 已恢复运行且属于其工作树、queue1；L20 仍从14:43Z停放、
未运行、queue2。新状态已更新 HANDOFF；不继续沿用旧“C2仍不运行”的结论，
也不把消息已排入队列说成 W69 owner 已开始修复。

### P04 UUID 增量（协调链与 W69 阻塞仍独立开放）

merge main 后 W69 热点/所需公开面仍未更新，官方 lane-gate 仍外部 ledger dirty
exit 2。只读确认 C2 连续 provider 拒绝、进程未在运行，L20 停放/请求未消费的
协调链问题已升级架构师；本 lane 不自行 restart 别的会话或扩大写权限。

本轮核到独立的 UUID 验证偏差：锁定 uuid 1.20.0 parser.rs::try_parse 仅允许
32/36/38/45 字节四种形状，包装内必须是 hyphenated UUID；TS 连续剥掉两层包装
再接受 simple，会把 Rust 无法解析的操作 ID/nonce 当合法过期租约提前回收。
已按源严格选择形状，继续允许 nil、全 f、大小写 hex，不新增 version/variant 校验。

先红 `20261104230901-8ccf84` exit 1（9 failed / 21 passed）；加入 LF 拒绝控制后
`20261104231104-a3afa9` exit 1（9 failed / 27 passed）；均无 Errors。
修复后 `20261104231345-08b2cd` 五文件107/107、exit 0、无 Errors；三个生产协议
入口的新补充用例36条，不修改原断言、原Rust行或TESTMAP646/212/1，不把控制项
重复算成修复。源链接与语义证据在 SPEC；整个 P04/W69 不因此自行关闭。
typecheck `20261104231345-a3ef36` exit 0、无 Errors；尚需本轮提交后组合验证。

受测提交 `05e7047c0` 的整组验证：

- `20261104231951-3ce591` exit 1，**927 passed / 1 failed / 20 Docker 未执行**，
  63 文件通过 / 1 failed / 1 Docker 文件跳过，无 Errors。UUID36及既有租约、认领、
  B04/云场景通过；唯一未改动 W69 为 38294.80ms，原 10000/<30s 完整保留。
- typecheck `20261104231951-cf3bf3` exit 0、无 Errors；boundaries
  `20261104231951-e36009` exit 0，2936 files、0 violation(s)、无 Errors。
- C2 连续 provider 拒绝与 L20 停放/排队的实际协调阻塞已请求架构师恢复；
  不将已排请求说成已执行，不自行 restart 外 lane。官方 §5 前置仍因 ledger
  外部 dirty exit 2，整个 P04/main-red 未签收，不写“已完成”。

### P04 认领租约增量（W69 仍为独立 owner 阻塞）

已 merge main，热点和所需共享入口尚未更新；没有越权修改 L20/F3 或改变 W69
原性能断言。继续独立修 e2ee_claim 的三个 trim 与两条 fallback/Display 纳秒路径：
复用 F4 rustTrim/nowEpochNanos/parseRfc3339/toRfc3339，内部创建时刻直接 BigInt 纳秒。
普通及超限损坏对象 +1ns 不能提前回收，恰好到期仍回收；有效租约错误保留全部小数。
已有单位换算移至 time.ts 供两类租约共享，不新增 clock/JSON/crypto 解析副本。

- 有效先红：`20261104220409-abd0a7` exit 1，9 failed / 1 passed，无 Errors。
  更早 `20261104220212-2eb696` 的 10 failed 包含 fixture 字节容器比较错误，另保留。
- 修复后 `20261104220727-bcf23f` exit 1（3 failed / 84 passed）、
  `20261104220940-185e7d` exit 1（3 failed / 86 passed）余错为三处 Buffer/U8
  构造类型比较；改为完全相同字节值比较，未删对象不变/不允许写 marker 等断言。
- 最终 `20261104221443-8a3cd8` 六文件 **89/89**、exit 0、无 Errors；
  新 claim 边界 12 条（均经实际入口/生产 encoder，标准时钟控制），typecheck
  `20261104220727-1d1240` exit 0、无 Errors。
- 原移植测试断言不变，TESTMAP 仍 646 ported / 212 pending / 1 obsolete；
原始失败、fixture 修正与生产修复分开记录，整体 P04/主线 W69 仍未关闭。

受测提交 `554a8ae57` 的整组结果：

- `20261104222318-490817` exit 1，**891 passed / 1 failed / 20 Docker 未执行**，
  62 文件通过 / 1 failed / 1 Docker 文件跳过，无 Errors。新认领 12 条、原认领/
  竞态用例及 B04、原租约时间/身份回归均通过；唯一未改动的 W69 为 36334.14ms。
- typecheck `20261104222318-3e2881` exit 0、无 Errors；boundaries
  `20261104222318-e23a20` exit 0，2920 files、0 violation(s)、无 Errors。
- 没有把 fixture 表示错误、定向通过或微基准当成整体门禁通过；W69 的 owner
  请求、原断言与官方 ledger dirty（exit 2）前置阻塞均保留。

W69 交接状态补查：只读 sessions.json 确认 L20-sync 从
`2026-11-04T14:43:12.297Z` 停放，queue.length=1。此前直接投递请求已进入队列，
但不能说成所有者已接手。现已直接 queue C2-platform 请求恢复/安排 L20，携带原
任务卡/最小候选/诊断与必须保留的测试；同步 escalate 架构师说明实际停放阻塞。
本 lane 未自行 restart 其他会话、改其源码或清除平台 Slot。

### P04 字符串增量：租约持有者与本机归属

已 merge main（无热点更新）；官方 lane-gate 仍外部 ledger dirty exit 2，W69 的
真实候选和生产修改权限继续等待所有者，未修改或豁免其原 10000/<30s 测试。

本轮只修租约创建/结构校验/本机归属的五处 JS trim，直接复用 main F4 rustTrim。
来源为 sync_lease.rs:64/75/102/132-138、backup_lease.rs:71/82/109；不复制 Unicode
规则，不重写平台设备身份。先红 `20261104205939-fa0b93` exit 1（10 failed，
无 Errors）；新补充用例经公开协议获取入口验证 BOM/NEL 的非空、规范化与 held
分类，外部损坏对象 fallback 与有效 BOM-only 正常回收也覆盖。

`20261104210342-806b34` 六文件 62/62、exit 0、无 Errors；Unicode 14 条，
typecheck `20261104210122-41d10f` exit 0、无 Errors；
原移植断言不变、TESTMAP 仍 646 ported / 212 pending / 1 obsolete。不将这些
supplemental 凑作新的 Rust 行或验收签收，P04 仍待 main 后 R4 复核。

受测提交 `04ce6ad97`（含 main `7c088c4e4`）的整组结果：

- `20261104210850-9061ea` exit 1，**879 passed / 1 failed / 20 Docker 未执行**，
  61 文件通过 / 1 failed / 1 Docker 文件跳过，无 Errors。Unicode 14 条、时间 14 条、
  serde 22 条以及原 B04/云场景均通过；唯一未改动的 W69 为 39491.47ms，原阈值保留。
- typecheck `20261104210850-31afd3` exit 0、无 Errors；boundaries
  `20261104210850-d8dcb1` exit 0，2835 files、0 violation(s)、无 Errors。
- fulltest 的 main `5b1b19055`（21:07Z）同一 W69 红已最高优先级响应；核对热点
  L20/F3 代码与已 profile 版本无差异，已通过 coord queue 直接投递 L20 所有者，
  携带单行等价 SQL 候选、38% 微基准和要求保留的原断言，未擅改其文件或称已采纳。
- §5 前置仍因外部生成 ledger dirty exit 2，不能宣告门禁或 main-red 关闭。

### P04 时间增量（W69 生产改动仍待所有者）

W69 的 L20/F3 热点及接口未更新、未获跨 lane 授权，未重跑同一红树或扩大白名单。
继续处理可独立完成的 P04 租约互斥边界：旧实现按毫秒截断 Rust DateTime，导致
同毫秒 contender 排错、晚 1ns 的租约/损坏对象 fallback 提前回收、held 错误丢分数。

新补充测试 `lease_time.test.ts` 先复现 `20261104202337-f23627` exit 1：8 failed，
无 Errors。生产扫描/创建/续租/排序及两个协议的 Display 统一复用 F4 纳秒 API，
不新写时钟解析器；内部 fallback 和时间参数用 bigint 纳秒，ttlMs 仅换算单位。
测试固定时刻及 fallback 值按同一瞬间等值转换，原 sync_lease/backup_lease 断言不变。

`20261104203016-212292` 五文件 48/48、exit 0、无 Errors；时间用例 14 条包含
相等到期回收、+1ns 保留、相等瞬间跨 offset UUID tie-break、完整 TTL 与标签精度。
这些 supplemental 不新增 Rust 行、不提升 TESTMAP，仍 646 ported / 212 pending /
1 obsolete。整体验收/P04签收与 main-red W69 不因此自动关闭。

提交 `dedc94240` 后合并 main（受测 HEAD `1343b2c40`）的整组验证：

- 全套 `20261104203449-60552e` exit 1，**865 passed / 1 failed / 20 Docker 未执行**，
  60 文件通过 / 1 failed / 1 Docker 文件跳过，无 Errors。时间 14 条与 serde 22 条
  均执行通过；business_tables 25/25、cloud_mark 4/4 仍通过。
- 唯一失败仍是未改动的 W69：36723.81ms，原 10000/<30000ms 断言保留；
  不能把原查询微基准候选或补充用例通过说成主线性能已修。
- typecheck `20261104203449-ef7c77` exit 0、无 Errors；boundaries
  `20261104203449-d49ca1` exit 0，2810 files、0 violation(s)、无 Errors。
- 官方 §5 前置仍为外部 ledger dirty（exit 2），不写“已完成”，不触碰其文件。

### main-red 续派：W69 等价查询顺序诊断（未越权改生产）

merge main 至 `919514029`（已包含本 lane 的 `810149749`）；热点 L20/F3 文件没有新变更。
lane-gate 仍被外部 ledger dirty 拦截（exit 2）。非交互模式无法回答权限问题，未将
“无回答”当作扩大写入白名单的授权，继续保留原范围。

为提供可执行的最小候选，新增非测试替身的真实 F3 SQL 成本诊断
`tests/diagnostics/w69-query.ts`（不计迁移测试或完成数）：
`20261104194043-6655ea` exit 0、无 Errors。同一 10000 行/2000 次缺失查询，
原 table-first 7103.67ms，record-first 4383.61ms，operation-first 10210.89ms；
计划均 SCAN。三者对混合大小写/多 DELETE/其他表和记录都返回同一最新 DELETE，
ordered-result-check passed。仅将 record_id=?2 过滤提前约快 38%，占位符、参数、
排序、大小写逻辑都不变，无新增索引/状态缓存/跳过查询。

该候选已保存 `pending/W69-main-red.md` 交 L20；本 lane 没有修改生产 SQL，不能把
微基准当作 W69 全批/全套通过。原 10000 条/<30s 断言及已知红仍保留。
诊断增量的 typecheck `20261104194512-2fa06d` exit 0、无 Errors；boundaries
`20261104194512-f9563b` exit 0，2779 files、0 violation(s)、无 Errors。
本轮没有改动 L20/F3 生产查询或原性能测试，不复跑未变红树冒充修复进展。

### 自动续派：W39 移植与 W57 原入口缺口

merge main（先无新内容，后合至 `7a8f150c2`），lane-gate 仍因外部 ledger dirty exit 2。
未重复运行未变的 B04/W69 红树或修改原性能阈值；继续核清 pending 可用面：

- `tests/sync_weird_tests.rs::w39_tombstone_for_nonexistent_blob`：Rust :997-1046
  直接调用 tombstone apply helper，参数为 `ab`×32 hash、`ab/<hash>.bin`、size=0、
  prefix=blobs、deleteCloud=true。本 lane 经真实 `ctx.syncSupport.tombstones` 服务
  调用同一 helper；空 MemoryStorage 对应原 NoopStorage，Rust `r.is_ok()` 对应
  Promise 解析为返回 Vec 的 Array。`20261104184517-c994b5` 3/3、exit 0、无 Errors。
- W57 尝试保留同设备 d1、100 次原 hash_i/size=0 与最终 count=100，使用已公开的
  kernel/SSOT/HTTP 生产路径；`20261104183657-d8df94` exit 1，7 passed / 1 failed，
  W57 因 180s 测试时限未执行完，无 Errors。fulltest 下发 main-red 最高优先级后，
  未完成实验和完整 100 次/count=100 预期保存在 `pending/W57.md`，不混入已 ported
  案例，不加 skip 或减少原断言；TESTMAP 一直 pending。Rust 原入口接收 MemStore，
  L20 高层 API 只有 config，所需
  既有低层函数的窄公开面已记 BLOCKERS 并请求协调者，不私引/复制实现。
- typecheck `20261104183657-a3f72c` exit 0、无 Errors。TESTMAP 仅变 W39 去向，
  实际 **646 ported / 212 pending / 1 obsolete**；未手改生成头或复活批准 obsolete。

### fulltest 最高优先级 main-red（01c074ecf，18:44Z）

已核该 main 提交：W69 仍是磁盘 newDb/Date.now；B04 初始仍为 '{}'，且使用完整
迁移库而非原 `new_vfs_resources_db` 内存裁剪 schema。内存/单调时钟与初始 4MiB
修正已在本分支，但尚未进入该 main。L10 format/structure 和 L20 apply-record/
note-history 与 profile 受测代码一致，性能热点已立即升级给协调者和所有者。

本轮按 Rust :26-64/:417-459 恢复 B04 原内存 schema、触发器与 4MiB x→5MiB y，
仍调用真实公开 apply，保留原两断言；不改 30s 时限、不替换或禁用历史 hook。原连接
没有 history/version_id 表，生产 hook 自身按 Rust 条件返回；并非为 green 强行关闭。
完整迁移库额外发现的 notes.format.detect 32.65s 成本继续列为 owner 性能问题，
不以原测试恢复通过来签收该完整生产组合。W69 的原 <30s 断言保持，仍等待真实查询
性能修复。新 W57 工作已显式暂停到 pending 任务说明，不混入这轮 main-red 验证。

定向 `20261104185550-7aae5f` 保留真实整体 exit 1：B04 已通过（371ms），W69
仍失败（31507.68ms），39 条未选中，无 Errors；不把该作业写成全绿。
typecheck `20261104185550-affa24` exit 0、无 Errors。B04 的主线修复将用
`fix(main-red)` 提交，W69 的原性能断言、所有计数和失败记录继续保留。

`fix(main-red)` 提交 `cd20f3370`（含 main `fa082dd53`）后整组验证：

- `20261104190258-934ddd` exit 1：**851 passed / 1 failed / 20 Docker 未执行**，
  1 文件失败 / 59 文件通过 / 1 Docker 文件跳过，无 Errors。B04 348ms 通过，
  business_tables 25/25；4 云场景与 22 租约回归也通过。
- 唯一失败 W69 为 40352.41ms，原 10000 条及 <30000ms 断言完整保留。该热点在
  L20/F3 生产查询，已按最高优先级升级；本 lane 不越权修改实现或加测试索引。
- typecheck `20261104190258-5558c8` exit 0、无 Errors；boundaries
  `20261104190258-eb0ac3` exit 0，2777 files、0 violation(s)、无 Errors。
- 未完成的 W57 原入口迁移仍 pending，失败实验保留在 pending/W57.md；未把它
  伪称已移植/通过。TESTMAP 实际 646 ported / 212 pending / 1 obsolete。
- §5 提交→merge main→lane-gate 仍被 lane 外 ledger dirty 前置条件阻塞（exit 2），
  不能以 main 既有红不挡集成为由宣告 main-red 整体解决。

### 最新三项集成反馈：先修复 Host 生命周期夹具

已 merge main（包含 notes 的 ctx.effect/dispose）。原场景 33 的生产操作依次为
A 写→B 读→B 写，不测试两个应用 Host 并存。夹具不再在 beforeAll 同时创建两 Host：
每 case 创建真实 A，场景 33 在 A 的写完成后调用公开 Host.dispose，再创建使用独立
目录/状态库的真实 B；A 目录保留至 case cleanup。所有原断言与两设备 ID、云存储、
SSOT、凭据和许可实现不变，不清平台 Slot、不替换 owner、不吞注册异常。
`20261104175948-196cc8` 4/4、exit 0、无 Errors；整体仍待按最新 HEAD 重跑三门禁。

受测提交 `23a1c75fb` 的三门禁已实际复跑：

- `20261104180553-98da7b` exit 1：**849 passed / 2 failed / 20 Docker 未执行**，
  2 文件失败 / 58 文件通过 / 1 Docker 文件跳过，无 Errors。云端场景 31–34 全部
  执行通过，Slot 夹具问题不再复现；租约 22 条通过。未以定向 4 条代称全套绿。
- 剩余 B04 仍为 Vitest 30s 超时；初始 4MiB x 已按 Rust :419-425 恢复，更新 5MiB y
  的两条原断言不变。当前完整迁移库多出的 notes 格式检查归属仍等待协调者裁定。
  W69 原 <30000ms 断言仍失败（36990.25ms），原 10000 条及计数断言未修改。
- typecheck `20261104180553-93580d` exit 0、无 Errors；boundaries
  `20261104180553-5d490e` exit 0，2765 files、0 violation(s)、无 Errors。
- 已提交→merge main→lane-gate；仍因外部生成 ledger dirty exit 2，不绕过前置检查。
  两项当前失败及 owner profile 已上报，不宣告全部完成。

### P04 续派：同步/备份租约 typed serde 边界

- merge main 至 `6cffad6db` 后，F4 JsonReader 三项差异仍在，F3 PermissionDenied 与
  L20 HLC cmp / 自动 replay 公共面也未补齐；不重复修此前已过单元。
- `lease.ts` 的 JSON.parse 会错误接受 1.0/1e0 作 u32、重复已知字段、null bool 与
  已知字符串中的非法 UTF-8，进而信任损坏对象的内层过期时间，提前回收本应按
  last_modified+TTL 保留的对象。复用已有 fromSlice/decodeStruct，按两个 Rust struct
  解码；activation_committed 仅缺失时默认 false。未新增 parser 或 crypto 副本。
- `lease_decode.test.ts` 通过 api.ts 公共协议入口做补充回归，四处生产读取（扫描/
  写后回验/释放/心跳）统一用同一 decoder；保留未知字段忽略、合法数组等接受面。
  原有移植测试不变、TESTMAP 不提级，仍 645 ported / 213 pending / 1 obsolete。
- 先红：`20261104165152-02af9c` exit 1，14 failed / 4 passed，无 Errors。
  六文件复验 `20261104165503-0bfed3` 80/80、exit 0、无 Errors；追加释放/心跳后
  `20261104165900-a130a9` 22/22、exit 0、无 Errors；typecheck
  `20261104165503-d69888` exit 0、无 Errors。P04 整体仍待 main 后 R4 复核。
- 受测提交 `d4c567707` 的全套 `20261104170504-df0d9d` **exit 1**：845 passed /
  2 failed / 24 未执行（20 Docker + 4 云场景），无 Errors。全部 22 条租约回归通过。
  真实新阻塞为 notes 注册 F3 全局 Slot 时第二 Host 抛 SlotOccupied（非 hook 超时），
  已单列 BLOCKERS/通知 L10-F3；不替换 owner 或吞异常。另 B04 5MiB case 超过测试
  30s，W69 10000 条耗时 42731ms（原阈值 <30000），分别定向复验。
  typecheck `20261104170504-92b9ec` exit 0、无 Errors；boundaries
  `20261104170504-50cc6b` exit 0，2751 files、0 violation(s)，无 Errors。
- W69 夹具修正：`sync_weird_tests.rs:16-17` 的 new_db 是 open_in_memory，现经 F3
  `openFile(':memory:', {profile:'plain'})` 对齐；显式多连接/reopen 文件用例保持磁盘。
  `Date.now` 耗时测量改为 performance.now 对应 Rust Instant，保留全部 10000 条及
  <30000ms 断言。定向 `20261104171426-1268a9` exit 1，15 passed / 1 failed，
  W69 仍为 38322ms，无 Errors，未声称性能已修复。
- B04 定向 `20261104171426-ec1507` exit 1（1 failed / 24 未选中），仍是 30s 超时。
  单 worker CPU-profile `20261104171719-39ffed` 同样 exit 1、无 Errors，生产 apply
  约 32.94s 中 32.65s 在 notes 格式检测/markdownRoots/micromark 调用链，profile 路径
  和 owner 请求见 BLOCKERS；不弱化 5MiB、阈值、生产钩子或原断言。
- W69 单 worker profile `20261104172145-2fa67b` exit 1：1 failed / 15 未选中，
  30332.81ms，所有计数断言通过而原 <30000ms 失败；无 Errors。
  apply 约 30.23s、currentDeleteVersion 约 16.24s（F3 get 自耗约 13.15s），
  归属 L20/F3 的性能调查，profile 路径见 BLOCKERS。没有通过新增索引/改 schema、
  缩减条数、计时豁免或跳过生产查询来造绿。
- 17 项集成失败反馈的受测 SHA 已核 `.oc-runs/gate-fail.json`：
  `a7bef3ecbb44e7d1c3e3f025a616d143a1a1d971`（2026-11-04T17:13:41Z）。
  该检查点仅包含第一批红测，尚无后续 c237c11c1/d4c567707 的租约生产修复；
  与本地先红 14 项相符。不能据此撤销当前 Slot/B04/W69 真实失败；新 HEAD 将按
  指令再次跑同样三门禁，保留各候选/日志的基线区别。
- 按反馈复跑的实际受测提交 `98dad6c4a`（已合 main `04d6b39e7`）：
  `20261104173553-3c986d` exit 1，3 文件失败 / 57 文件通过 / 1 Docker 文件跳过；
  **845 passed / 2 failed / 24 未执行**，无 Errors。租约 22 条全部通过，14 个旧失败不再
  复现；当前 B04 仍 30s 超时、W69 为 42299.44ms，4 条云场景仍因 Slot 未进入。
  新 main 已补 notes 的 ctx.effect/dispose，但第二 Host 改在 registerDeletionJournal
  Slot 失败（日志 :258-281），不再沿用旧“丢 Disposer”当最新结论。typecheck
  `20261104173553-09edc3` exit 0、无 Errors；boundaries `20261104173553-285dc9`
  exit 0，2758 files、0 violation(s)，无 Errors。未放宽任何原断言或替换 owner，
  等待 L10/L20/F3 修复上述实际阻塞，不能声明门禁通过。

### 自动续派：已解除阻塞的三条原测试

先 merge main（无新变更），§5 lane-gate 仍因外部 ledger dirty 而 exit 2；不重复
上一轮 P04/AP 修复。本轮只迁移公开面已满足的三条，保持原断言：

| 原 Rust ID | 生产入口与原断言对应 |
| --- | --- |
| `tests/sync_scenarios_tests.rs::scenario_38_device_id_persistence` | `device_identity.test.ts` 经 kernel `cloud_sync_get_device_id` 两次调用真实 F4 owner；Rust :1291 相等、:1292 非空，两条逐一对应 |
| `tests/sync_adversarial_tests.rs::adv_14_device_id_collision_scenario` | 同文件真实 kernel 命令；Rust :608 只要求两次相等，不改为“全球唯一”或新增 install_uuid 算法 |
| `tests/sync_regression_tests.rs::r27_clock_drift_delete_quarantined` | `regression_sync.test.ts` 经公开 `ctx.sync.applyDownloadedChanges`；保留 +300000ms、source_device_id 与 seq=8，Rust :1157 失败数 1、:1165 本地未删、:1170 隔离数 1 全部对应；沿用既有 items→test_items 明示夹具映射 |

定向作业 `20261104160125-dd00c4`：两文件 43/43、exit 0、无 Errors；typecheck
`20261104160125-7ade6a` exit 0、无 Errors。R26 的
自动重放仍缺 owner 公开面，独立保留 pending 并写入 BLOCKERS，不为整组解阻而替换
成手动 retry 命令。TESTMAP 仅改去向列，实际 641 ported / 217 pending / 1 obsolete；
生成统计头仍待协调者按原请求刷新，不手改生成区块。

合入 L20 新主线后的全套 `20261104160452-dc5f5e` exit 1：823 passed，20 Docker
未执行，场景 35/36 另 2 条因初始化 hook 超过 30000ms 未执行，无 Errors。此次不继续
扩大超时，而是移除两条 helper 测试与原 Rust 无关的全业务库迁移：仍安装真实
vfs-repos→notes→syncSupport，由 F3 和 state owner 初始化所需状态库；不替换 tombstone
算法、不改任何原断言、恢复默认 hook 时限。`20261104161557-2ee876`：2/2、exit 0、
无 Errors，执行 775ms。此前同一完整 realistic harness 初始化花了 35600ms。

### 自动续派：消费刚进入 main 的 L20 标记删除命令

main 合并 `88f32f9af` 含 L20 `677f6727c` 后，`markBlobDeleted` / `markAssetDeleted`
公开面及注册命令实际可用。新增 `tests/cloud_mark_scenarios_sync.test.ts`，不私引
L20/L21/L20b 实现，不复制发布算法；通过真实 kernel 命令、L21 backup 许可/SSOT、
F4 Settings/Secrets/Paths、L20b tombstones、L23 WebDAV client 两设备组合验证：

| 原 Rust ID（`tests/sync_scenarios_tests.rs::`） | 原断言与 fixture |
| --- | --- |
| `scenario_31_blob_tombstone_upload_download` | :1093/:1094/:1095：1 条记录、hash_abc 存在、device_a；保留原 hash/path/1024 |
| `scenario_32_asset_tombstone_propagates` | :1108/:1109：1 条记录、size=2048；TS owner 的 u64 用 2048n |
| `scenario_33_tombstone_second_device_sees_deletion` | :1125/:1126/:1135：设备 B 看到 hash_x 与 device_a，B 再写 hash_y 后共 2 条；使用独立真实本地状态库 |
| `scenario_34_tombstone_offline_returns_error` | :1146 `is_err()`；关闭 loopback 服务产生实际连接失败，kernel 收到业务错误字符串而非替换业务实现 |

作业 `20261104161319-4062cd` 4/4、exit 0、无 Errors；typecheck
`20261104161319-557407` exit 0、无 Errors。HTTP 端是测试远端（原 Rust 使用
MockCloudStorage），所测 sync/backup/crypto/SSOT/tombstone/provider 均为生产实现；
未进入的 vfsDatabase 维护状态端口与既有 realistic harness 相同，不拿它证明维护语义。
TESTMAP 实际 645 ported / 213 pending / 1 obsolete，原 859 行及批准 obsolete 不变。

本轮最终受测提交 `e2d603f2c`（含 `bc2151d79` 精简 fixture 与 `9a1c3ed73` 三条原测试）：

- 全插件 `20261104162059-c10808` exit 0：59 文件通过 / 1 Docker 文件未执行，
  **829 passed / 20 Docker 未执行**，无 Errors；场景 31–36 均已执行，不用之前的
  setup 超时未执行项凑通过数。
- typecheck `20261104162059-7e470a` exit 0，无 Errors；boundaries
  `20261104162059-8998dc` exit 0，2692 files / 0 violation(s)，无 Errors。
- ledger（`--check --no-write`）`20261104162059-58634a` exit 0，commands 1058 / tests
  8109，problems commands/tests/orphan registrations 全 0；全仓 prod-reachable
  unreachable 25，unknown 3743 不否决。该全仓数不是本 lane 新增问题的认定。
- §5 已按提交→merge main→lane-gate 实际执行，仍因 lane 外生成的
  `migration/LEDGER.md`、`migration/ledger.json` dirty 而 exit 2。未提交/还原这两个
  文件，未绕过前置检查；生成统计头刷新、共享接口缺口及 R4 独立复核仍开放，不写“已完成”。

### 中断恢复增量（2026-11-04，P04）

- 恢复时先核对最近 20 条提交、工作区与 TESTMAP：859 行，637 ported / 221 pending /
  1 obsolete；保留 lane 外 ledger 生成改动，不重做已提交的 AP/LP、X7 公开入口。
- 只读账本作业 `20261104145656-1b2497`（`migration:ledger -- --check --no-write`）
  exit 0：commands 1058，tests 8109，problems commands/tests/orphan registrations 全 0。
- F4 首块 `objectLen: number | bigint` 已在 main；`password_proof.ts` 删除 Number 中转，
  三个调用保留原 u64。新增 manager 回归用真实多块 DSBK 首块及清单大小
  `9007199254740993n` 验证试解成功且不全量下载；原测试断言不变。
  作业 `20261104145807-cdf82c`：33/33、exit 0、无 Errors；typecheck
  `20261104145807-69a423` exit 0、无 Errors。
- F4 JsonReader 同样已在 main，但 arbitrary_precision / zmij 指数符号 / from_slice
  字节输入仍不满足本 lane 调用点；保留已有 reader，最小需求与实测写入 BLOCKERS。
  P04 仍待 R4 复核，不声明全闭合。
- P04 提交 `37a441513` 后的全插件作业 `20261104150204-d1b869`：819 passed /
  20 Docker skipped，exit 0、无 Errors；boundaries `20261104150203-886f96` exit 0，
  2540 files、0 violation(s)。§5 lane-gate 因 lane 外 `migration/LEDGER.md`、
  `migration/ledger.json` dirty 仍 exit 2；不还原/提交他人改动，不绕过前置检查。
- 后续场景 35/36 经 main 真实 `syncSupport.tombstones` 服务移植（原 Rust 直接调用
  helpers，非 manager 替身），`20261104150503-b60293`：2/2、exit 0、无 Errors；
  typecheck `20261104150517-a99050` exit 0、无 Errors。W50 发现缺原 cmp 断言而退回
  pending；TESTMAP 实际 638 ported / 220 pending / 1 obsolete。仅修改去向列，
  已请求协调者刷新过期生成头（scaffold 无 lane 写入过滤），本 lane 不手改生成头。
- P04 续传补查发现 `lstatSize()` 错用 `stat()`，与 Rust
  `sync_manager.rs:1782-1800` 的 `symlink_metadata` 相反，链接会被误当普通断点并改写目标。
  新回归先复现：`20261104151454-fdc488` exit 1，1 failed / 6 未选中、无 Errors，
  实际 resumeFrom=2048（应为 0）。仅将该 helper 改用 `lstat()` 后，
  `20261104151706-9ad192` 两文件 40/40、exit 0、无 Errors；新断言验证从零重下、
  链接目标字节不变、最终 ZIP 非链接、payload 完整、原断点移除。
  typecheck `20261104151706-91bdd0` exit 0、无 Errors。
- TESTMAP 去向更新后账本只读复验 `20261104151242-c36fdd` exit 0，
  problems commands/tests/orphan registrations 全 0；boundaries
  `20261104151338-ea09ac` exit 0，2541 files、0 violation(s)。
- 最终组合首次作业 `20261104152118-df5a99` **exit 1**：820 passed，20 Docker
  未执行，另 2 条新墓碑用例因 beforeAll 在 10000ms 超时而未执行（并非行为通过），
  无 Errors。定向初始化已耗时 8963ms；全套并发时迁移超过 hook 默认值。
  仅将 `tombstone_scenarios_sync.test.ts` 的真实初始化 hook 改用现有测试时限 30000ms，
  不改生产代码或业务断言，等待新全套结果。boundaries `20261104152118-c2d4b7`
  exit 0，2541 files、0 violation(s)。
- 初始化 hook 修复后的最终组合（代码 tip `aecbf9c61`，main 合并 `071598bca`）：
  `20261104152914-bc8d5e` exit 0，58 files passed / 1 Docker file skipped，
  **822 passed / 20 Docker 未执行**，无 Errors；typecheck
  `20261104152914-e36c13` exit 0、无 Errors；boundaries
  `20261104152914-ae4c13` exit 0，2558 files、0 violation(s)。
  不将这次通过抹去上述 `20261104152118-df5a99` 的真实失败。

### v2 接手盘点（2026-11-04，GPT-6 Astra）

已读取前 30 条提交，合并 main；接手时存在未提交 `tests/chaos_sync.test.ts`
及 lane 外 ledger 生成改动，保留原样，不纳入本次提交。以下为审读发现，
不是对既有 ported/A/B 的重新签收。类别号对应 standard-v2 §1。

| 命令/模块 | 八类自查结果与证据（本目录相对路径） |
|---|---|
| cloud_storage_check_connection | 1.1 入口 index.ts:179；1.2 仅 hydrate 所有者；1.3/1.4 配置映射 index.ts:61-62；1.5 commands_errors.test.ts；1.6/1.7 HTTP 分支继续按 provider 复核；1.8 P01/P02 已由 R4 签收 |
| cloud_storage_put | 1.1 index.ts:185；1.2 无 DB；1.3 Uint8Array 转换 :187；1.4/1.6/1.7 provider 的重试/取消/日志仍须逐项核对；1.5 commands_errors.test.ts；1.8 不扩大 P01/P02 签收 |
| cloud_storage_get | 1.1 index.ts:191；1.2 无 DB；1.3 bytes/null :194；1.4/1.6/1.7 有界读取由 provider 实现，未重新签收；1.5 webdav/s3 测试；1.8 P08 Docker 未执行 |
| cloud_storage_list | 1.1 index.ts:197；1.2 无 DB；1.3 api.ts:12/33 FileInfo.size 仍 number，D3 待审；1.4/1.6/1.7 列表截断/排序/取消须核对；1.5 webdav_list_truncation.test.ts；1.8 P08 未闭合 |
| cloud_storage_delete | 1.1 index.ts:202；1.2 云对象由本 lane 管理；1.3 key 走 kernel；1.4/1.6 错误传播 :204；1.5 provider 测试；1.7 取消仍需 provider 审读；1.8 无新增签收 |
| cloud_storage_stat | 1.1 index.ts:208；1.2 无 DB；1.3 FileInfo.size number 同 list；1.4/1.6 null/错误 :210；1.5 provider 测试；1.7 元信息时间须逐字段核对；1.8 无新增签收 |
| cloud_storage_exists | 1.1 index.ts:213；1.2 无 DB；1.3 boolean；1.4/1.6 stat 错误向上传播；1.5 provider 测试；1.7 provider 请求生命周期待审；1.8 无新增签收 |
| cloud_storage_is_s3_enabled | 1.1 index.ts:291；1.2 无持久化；1.3 boolean；1.4 无日志/错误；1.5 sync_android_platform.test.ts；1.6 desktop capability；1.7 同步无资源；1.8 P08 profile 原断言已签收 |
| cloud_sync_get_status | 1.1 index.ts:220；1.2 无 DB；1.3 manifest.ts:136-176 解码（拆分前 sync_manager.ts:328-389）仍有自造 timestamp 错误 serde_struct.ts:100；1.4 P04 Display 未闭合；1.5 manifest_decode.test.ts；1.6 全树解析先于语义校验，错误先后待修；1.7 纳秒比较已有 P05 签收；1.8 P04 未决 |
| cloud_sync_list_versions | 1.1 index.ts:225；1.2 无 DB；1.3/1.4/1.6 同 get_status；1.5 manifest_decode.test.ts；1.7 纳秒排序 P05；1.8 P04 未决 |
| cloud_sync_upload | 1.1 index.ts:236；1.2 L21 正式 guard :239；1.3 password_proof.ts:113/122/132/147（原 sync_manager.ts:932/941/954/969）在 F4 调用前丢 u64；1.4 日志/错误 cloud_commands.ts:87/96；1.5 commands_transfer 断言减少需逐条复核；1.6/1.7 临时文件 finally :111-118 已签 P07，percent :27-28 double 待裁定；1.8 P03/P07 不重开，P04/P08 未决 |
| cloud_sync_download | 1.1 index.ts:261；1.2 L21 guard :263；1.3 sync_manager.ts:707（拆分前 :1170）比较前的 lstat 仍 number；1.4 cloud_transfer 错误已签 P07；1.5 commands_transfer；1.6 防降级分支已有测试；1.7 同 upload 进度差异；1.8 P04/P08 未决 |
| cloud_sync_delete_version | 1.1 index.ts:279；1.2 正式 prune guard；1.3 versionId kernel/manager 校验；1.4 cloud_commands.ts:176 warn；1.5 真实插件组装待持久化测试；1.6/1.7 finally release index.ts:149；1.8 P03 已签收消费者 |
| cloud_sync_get_device_id | 1.1 index.ts:289；1.2/1.3/1.4 全委托 F4 src/device_identity.ts:17-22；1.5 tests/device_identity.test.ts:36-43 旧 owner 门控已过期；1.6/1.7 主路径/重启/轮换由正式 F4 提供；1.8 merge 后须执行四条原 pending，不能只凭 API 存在关闭 |
| syncProvider / CloudStorage | 1.1 index.ts:84-103 正式 provide；1.2 无业务表写入；1.3 api.ts:39/44 字节数 number 待 D3 全链审读；1.4/1.6 provider/lease/marker JSON 与日志尚未逐项重新证明；1.5 545 ported 是待核对账本，不等同验收；1.7 traits 取消全局状态须对 Rust；1.8 P08 未决 |
| delta / repo-check / leases | 1.1 api.ts:90-162 重导出不是调用方证据，需按 Rust 活跃/死代码逐符号核对；1.2 云对象所有权；1.3 JSON 与 u64 后续自查；1.4/1.6/1.7 按各 Rust 文件继续核对；1.5 不能凭测试名签收；1.8 保持复核开放 |

处理次序：P08 恢复 config Android 完整错误相等、核清两份断言减少；
去除已过期 F4 门控并运行身份生产链；P04 修可独立完成的解码差异/精确续传，
F4 crypto 参数精度先请求所有者；持久化真实 L21/L23 组合错误/守卫测试；
随后继续真实引擎移植积压。ACCEPTANCE.md 由复核人更新。

真实跨 lane 需求：F4 BackupCrypto 的三个首块 API objectLen 当前仅 number
（host/platform/secrets/api.ts:262-264），请求支持 number | bigint 并在内部精确比较；
L20 classification/asset filenames/field merge/tombstone/delete resolve 逐符号待核；
L21 移动 capabilities 注入、L13 autosync 保留 BLOCKERS 中证据。
F4 dataSpaceDeviceId 已随本次 main 合并进入，不再是未发布接口。
f32 进度没有批准凭据，向协调者请求裁定；不能以“只用于显示”当等价。

### 当前状态与下一步（2026-11-04 续作会话）

已完成：

- 14/14 命令 A 级；`api.ts` 已发布 `syncProvider` 服务与 `createStorage`、`runRepoCheck`、租约等公共面。
- L23 自有传输/管理器/加密/清单模块与其 Rust 单元测试已迁移（S3/WebDAV/FTP/http/resume/verified_publish/bad_object/e2ee_claim/sync_manager/mod/repo_check/lease/delta_*）。
- 真实业务表 B01-B25（`tests/business_tables_sync.test.ts`）、`sync_scenarios_tests` 可公开 apply 的 46 条（`tests/scenarios_sync.test.ts`）、回归 R01-R25b、深度集成 I.01-I.15、R02 加固、R05 DELETE 加固、pathological apply 32 条、adversarial 37 条、weird W.01-W.11 等已移植并通过最小集。
- P01/P02/P03/P05/P06(候选组合)/P07/P09 已按 R4 复核签收；P04 旧 token/u64/UTC 反例已修；P08 子进程/profile 断言已补。
- 已合并 main，删除 L21 guard 镜像，直接消费官方 `OperationGuardError`。

剩余（按下一轮顺序）：

1. `sync_weird_tests` 剩余可公开 apply 的 33 条（w12/w13/w17/w18/w20-w23/w28/w33/w39/w51-w70 等）——继续逐条移植到 `tests/weird_sync.test.ts`，无公开面的 tombstone（w39/w57）单列。
2. `sync_comprehensive_tests` 中只依赖已发布 `hasPruneGap`/`resetSyncBaselineAfterRestore`/`getDatabaseSyncState` 的 prune_gap 7、restore_baseline 4、checksum 可行项。
3. `sync_real_schema_tests` 11、`sync_proptest` 6、`sync_chaos_tests` 10 等 apply/事务/收敛用例（先核对每组 Rust 是否真的走生产引擎，而不是自写 harness）。
4. `sync_realistic_scenarios` 115：Rust 文件是自包含 harness（内联 `apply_changes_to_db`），不能照搬为“生产测试”；逐条判断能否改用 L20 公开 apply 并保持原收敛断言，不能等价的单列。
5. 真实跨 lane 阻塞逐符号保留 pending：L20 `classification` 注册表、`field_merge`、`asset_filenames`/`AssetDirsManifest`、tombstone/`SyncManager` 文件级方法、delete-resolve 命令；L21 capabilities 注入/整包 ZIP；L13 autosync config；F4 `paths.dataSpaceDeviceId()` 进 main。

复核剩余“必须修复”：

- P04：未知字段（重复键/`__proto__`）应忽略而非误拒/补必填；错误文案与 line/column 需 serde 等价；`sync_manager.ts` 中 size 在续传/密码计划前不得提前转 Number（D3 仅 IPC 边界可转）。
- P08：TESTMAP 表头与实际行数同步；Docker 20 条只能记“未执行”；4 条 F4 身份测试是运行时 owner API 门控跳过，不是 Rust cfg，必须保留 pending + 候选组合证据，不能写成正常平台跳过；main 未集成前不能宣称 P06 main 可用。

下一步顺序：先提交已完成的 weird 增量并跑最小集；随后按上面 2、3、1 的可行子集继续移植，每单元提交；P04 剩余三项按 Rust `sync_manager.rs:104-143` 与 serde 行为修实现与测试；P08 只做账本/证据同步，不重跑已闭组。

## v2 排雷清单（X6 报告 0119143715c0bab2d8f698b7c1d58651358e85be，源码基线 2ee9a9cbe）

编号与顺序按原报告固定，不重排、不复用。“候选已修”只表示 L23 分支已有生产入口改动，需进入 main 后由 R4 复验才算完成。三类 PR/AP/LP 是 report-only 候选，逐语义核对后才定性。

### UD（未经校验的业务解码）

| ID | 基线位置 | 状态 | 修复 SHA / 生产入口证据 |
| --- | --- | --- | --- |
| X6-UD-0076 | e2ee_claim.ts:129 decodeMarker | 候选已修待复核 | d1bc79217/db9b90b26：`readMarkerSnapshot` 改用 `marker.ts::decodeEncryptionMarker`（serde struct 逐字段解码，含 PasswordVerifier）；`tests/marker_lease_decode.test.ts` 经 `claimEncryptionMarker`/`CloudSyncManager` 验证 |
| X6-UD-0077 | e2ee_claim.ts:177 ensureNoLiveLease | 候选已修待复核 | db9b90b26：`readLease` = `from_slice::<EncryptionClaimLease>().ok().filter(structurally_valid)`，nonce 用 `isUuid`，时间用 `parseRfc3339`，有效 expiry 纳秒比较；后续 P04 增量补齐 fallback/Display 纳秒、Rust trim、uuid 1.20 精确形状（保留原基线/ID）；测试经 `claimEncryptionMarker` |
| X6-UD-0078 | json_exact.ts:194 Parser.parseString | 候选已修待复核 | 本提交删除 json_exact.ts；`serde_struct.ts` 为按 serde_json 1.0.149 SliceRead 移植的流式字节解析，字符串按 `parse_str` 逐字节转义并在闭合引号处严格 UTF-8 校验；R4 §13 四个反例在 `tests/manifest_decode.test.ts` 经 `decodeManifest` 全文断言 |
| X6-UD-0079 | repo_check.ts:199 markerIsParseable | 候选已修待复核 | db9b90b26：对应 repo_check.rs:394 `from_slice::<EncryptionMarker>().is_err()`，改用 `decodeEncryptionMarker`；`marker_lease_decode.test.ts` 经 `runRepoCheck` 验证 |
| X6-UD-0080 | sync_manager.ts:675 readEncryptionMarkerStateWithRaw | 候选已修待复核 | d1bc79217：Present/Corrupted 判定改用 `decodeEncryptionMarker`，失败保留原 warn 文本并 fail-closed |
| X6-UD-0081 | sync_manager.ts:730 claimMarkerWithPassword | 候选已修待复核 | d1bc79217：已发布字节经 `decodeEncryptionMarker` 回读 |
| X6-UD-0082 | sync_manager.ts:756 persistEncryptionMarker | 候选已修待复核 | d1bc79217：同上 |

SW：本插件 0 项。

### AP（断言数候选，需逐语义对照）

| ID | 位置 | 状态 |
| --- | --- | --- |
| X6-AP-0417 | tests/config.test.ts:100 test_config_validation（Rust 4 > TS 1） | 误报：:100 是 mod.rs:747 同名测试（Rust 1 条 assert，TS 1 条）；config.rs:429 的 4 条断言在 config.test.ts:15-25 逐条对应 |
| X6-AP-0418 | tests/config.test.ts:27 test_https_enforcement_webdav（5 > 4） | 确认遗漏并补回：config.rs:497 `assert!(!forged.insecure_transport_authorized)`，TS 断言 JSON 载荷无法设置 symbol 能力键；其余 4 条已对应 |
| X6-AP-0419 | tests/config.test.ts:57 test_is_local_endpoint（8 > 2） | 误报：两个循环覆盖 config.rs:622-645 全部 8 个端点、真假值一致 |
| X6-AP-0420 | tests/ftp.test.ts:206 ftp_contract_source_guards（24 > 8） | 逐条对照 ftp.rs:1430-1543：原子上传/MLSD/递归/截断/状态码白名单/STOR 超时/SIZE 回验/读路径不建目录/get_bounded 预检/越界断流/预算不重试由本文件其他行为用例覆盖；确认缺口并补回 `get()` 默认预算（行为）与 TLS 来源、FTP_DATA_TIMEOUT、RETR 逐块空闲超时（源码守卫，Rust 原为 rustls/suppaftp 依赖守卫，TS 对应 node:tls 内置） |
| X6-AP-0421 | tests/s3.test.ts:32 put_file_source_guards_remote_size_check（15 > 4） | 逐条对照 s3.rs:1092-1152：Range 续传、分片重试、声明长度、预算预检、陈旧分片、前缀读由本文件其他行为用例覆盖；确认缺口并补回 `get()` 默认预算（行为）与内存下载 90 秒停滞文案（源码守卫） |
| X6-AP-0422 | tests/webdav.test.ts:609 webdav_contract_source_guards（13 > 3） | 确认真实偏差并修复：WebDAV 四条读路径停滞错误为通用“读取响应体停滞…”，Rust webdav.rs:1321/1496/1601/1676 为各自文案；`http.ts chunks(stallMs, stallMessage)` 传入原文案，新增 fake-timer 停滞行为用例；其余守卫由列举/截断/大小回验/预算用例覆盖 |
| X6-AP-0423 | tests/data_space_cutover.test.ts:47 restore_writes_inactive_slot…（16 > 15） | 确认遗漏并补回 sync_android_restart.rs:640 `inactive_slot()==B`。另：Rust :647/:697 断言 `ErrorKind::PermissionDenied`，F3 `data-space.ts:148/188` 抛普通 Error 无 kind，TS 只能断言文案；属 F3 实现，已列 BLOCKERS 待 F3 |
| X6-AP-0424 | tests/sync_provider_contract.test.ts:313 webdav_bad_credentials_rejected（2 > 1） | 误报：多出的是 `assert!(docker_contract_enabled())` 前置条件，TS 以 `describe.skipIf(!DS_SYNC_TEST_DOCKER)` 等价门控（Rust 同为 #[ignore]）；行为断言 1 对 1 |
| X6-AP-0425 | tests/sync_provider_contract.test.ts:338 s3_bad_credentials_rejected（2 > 1） | 误报：同 AP-0424，多出的是 `assert!(docker_contract_enabled())` 前置条件；Rust sync_provider_contract_tests.rs:2295 有 `#[ignore]`（此前误读为缺失，已订正），TS 保持同一 DS_SYNC_TEST_DOCKER opt-in 门控与 wrong-secret→checkConnection 拒绝断言；未执行 Docker，不计为通过 |
| X6-AP-0426 | tests/sync_provider_contract.test.ts:371 ftp_bad_credentials_rejected（2 > 1） | 误报：同 AP-0424，多出的是 Docker 前置条件 |
| X6-AP-0427 | tests/hardening_sync.test.ts:223 r02x_two_device_tag_union…（17 > 16） | 误报：多出的 `assert_eq!(tags_a, tags_b)`（sync_r02_hardening_tests.rs:199）由前两条各自等于同一字面量 `["alpha","beta"]` 蕴含；其余逐条对应 |
| X6-AP-0428 | tests/regression_sync.test.ts:236 r06_reset_baseline_on_empty_db（2 > 1） | 误报：Rust `t==0`、`r==0` 两条，TS `toEqual([0, 0])` 一条同时断言两值 |

### AP 新基线按 Rust ID 关联（8d7b05d14，报告 a07019791e219c91f89fc3960ef5644846486b94）

原基线 2ee9a9cbe 的编号/结论保留；重扫不能把旧修复重新计为缺口。以下路径均为
`src-tauri/` 相对路径。旧修复承载记录：0418 为 `6d0f7e32c`/`81bff9e99`；
0420–0423 为 `b4220792a`/`457af4eea`/`0c762b9f5`/`d65a63510`；
0425 误读订正为 `2c2d0dd35`。进入 main 后仍需独立复验，不能以本表代签。

| 原 Rust ID | 原稳定编号 |
| --- | --- |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_config_validation` | X6-AP-0417 |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_https_enforcement_webdav` | X6-AP-0418 |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_is_local_endpoint` | X6-AP-0419 |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::ftp_contract_source_guards` | X6-AP-0420 |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::put_file_source_guards_remote_size_check` | X6-AP-0421 |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::webdav_contract_source_guards` | X6-AP-0422 |
| `tests/sync_android_restart.rs::restore_writes_inactive_slot_and_switch_happens_only_after_restart` | X6-AP-0423 |
| `tests/sync_provider_contract_tests.rs::webdav_bad_credentials_rejected` | X6-AP-0424 |
| `tests/sync_provider_contract_tests.rs::s3_bad_credentials_rejected` | X6-AP-0425 |
| `tests/sync_provider_contract_tests.rs::ftp_bad_credentials_rejected` | X6-AP-0426 |
| `tests/sync_r02_hardening_tests.rs::r02x_two_device_tag_union_converges_when_both_sides_have_pending` | X6-AP-0427 |
| `tests/sync_regression_tests.rs::r06_reset_baseline_on_empty_db` | X6-AP-0428 |

以下 7 条原清单没有编号，以完整 Rust ID 固定关联，待 X6 提供追加编号，不挪用/重排
0417–0428。前 6 条无须改测试凑数：

| 新增原 Rust ID | 逐断言证据 / 状态 |
| --- | --- |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_touches_local_version` | Rust :255 `is_ok()` 对应 TS :151 直接调用（抛错即失败）；:258/260 对应 TS :152/153 正数；:271/273 对应 :154/155 local/sync_version 均为 5；五条全覆盖 |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_multiple_tables` | Rust :316 `is_ok()` 对应 TS :186 直接调用；:318 对应 :187 >=3；:341/342/343 的三对值对应 :188-199 `toEqual([3,3])`/`[7,7]`/`[1,1]`；五条全覆盖 |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_table_without_local_version_is_skipped` | Rust :367 `is_ok()` 对应 TS :217 直接调用；:369 reset_count==0 对应 :218；:381 row count==1 对应 :219；三条全覆盖 |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_empty_db_does_not_panic` | Rust :403 `is_ok()` 对应 TS :235 直接调用；:405/:406 两个 0 同由 `toEqual([0,0])` 覆盖；三条全覆盖 |
| `tests/sync_realistic_scenarios.rs::s61_empty_change_log_on_one_device` | Rust :2320/:2321 两个方向均为 0；TS realistic_scenarios_vfs_advanced_sync.test.ts:340 `toEqual([0,0])` 同时覆盖，无须拆 expect |
| `tests/sync_realistic_scenarios.rs::s93_sync_with_no_changes_zero_op_cycle` | Rust :3225/:3226 第一轮、:3228/:3229 第二轮双向各为 0；TS realistic_scenarios_recovery_sync.test.ts:352/:353 两次 `toEqual([0,0])` 同时覆盖四值 |
| `tests/sync_weird_tests.rs::w50_hlc_compare_strings_edge` | 确认缺失：Rust :1337 解析后对象 cmp，TS :584 只有字典序。L20 `HlcValue` 没有 cmp 公开面；退回 pending，BLOCKERS 已请求 owner，不在测试内自写比较算法冒充 |

### LP（warn 日志计数候选，需逐分支对照）

| ID | 位置 | 状态 |
| --- | --- | --- |
| X6-LP-0255 | src/backup_lease.ts（backup_lease.rs warn 1 > 0） | 无对应分支：Rust :376 在 `Drop`（未显式 release 的异常退出）里异步释放失败时 warn；JS 无析构，lease.ts:453-459 记录该差异，TS 生产调用方 delta_gc/delta_restore/delta_upload 全部 try/finally `releaseBestEffort`，其失败 warn 已对应 Rust 显式 release 分支 |
| X6-LP-0256 | src/bad_object.ts（bad_object.rs warn 4 > 3） | 误报：Rust :168 与 :193 是同一文案的两处调用，TS 合并为 `deleteTmpBestEffort`（bad_object.ts:147）由两处调用；四个 warn 分支全部对应 |
| X6-LP-0257 | src/delta_gc.ts（delta_gc.rs warn 2 > 1） | 误报：Rust :472/:586 两处同文案，TS `releaseBestEffort` 被 :394/:473 两处调用 |
| X6-LP-0258 | src/lease.ts（sync_lease.rs warn 1 > 0） | 无对应分支：同 LP-0255，sync_lease.rs:400 为 `Drop` 路径；TS 无析构，仓内无生产调用方，公开 api 的使用方须显式 release |
| X6-LP-0259 | 插件合计（warn 52 > 50） | 已核：差 2 条即 LP-0255/0258 的 Drop 路径（0256/0257 为同文案多处调用合并），无遗漏的 warn 分支 |
