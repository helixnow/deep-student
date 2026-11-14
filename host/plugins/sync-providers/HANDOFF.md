# L23 当前交接点（FTP日期修复已验；FTP giant 已按职责拆分）

## 最新：20:10 批次 8 新例 + 2 真实映射（199→189 pending）

本批只新增/改本 lane 测试目录与 TESTMAP 去向列，未改生产、未碰外部 ledger。

- 新例（8，全部原断言执行通过）：`delete_resolve_sync.test.ts` 5 例
  （R06 单侧冲突形状/keep_local、R07 keep_cloud/merged-null/stale ids），
  `quarantine_replay_sync.test.ts` 1 例（R26 漂移隔离+重放）、
  `comprehensive_sync.test.ts` 1 例（review_plan question_id UPSERT）、
  `weird_sync.test.ts` 1 例（W54 极值 AUTOINCREMENT 不 panic）。
- 真实映射 2：`test_max_value` → `host/plugins/sync/tests/field-merge.test.ts:25`
  （输入 10/7、result 10、merged=true 与原 Rust 一致）；
  `w50_hlc_compare_strings_edge` → `weird_sync.test.ts`（补 parse 后
  millis/counter 有序断言，再保留原 `a < b`）。
- 结果：TESTMAP 859 行 = **669 ported / 189 pending / 1 obsolete**。
  固定测试 job `20261105120636-bcac15` 原 exit0、4 files/68 passed；
  boundaries `20261105120636-b5baa7` exit0、2983 files/0 违规。
- 两个优先文件仍为 **85 pending**（comprehensive 43 + provider contract 42）：
  comprehensive 的 43 条全部依赖 L20 未公开的 `classification` /
  `field_merge`（`host/plugins/sync/api.ts` 无对应成员；跨插件只能经 api.ts）；
  provider contract 42 条全部依赖 L20 未公开的 SyncManager 资产/blob/workspace/
  manifest 方法，且真 provider 需要 Docker（本机无 docker 命令，8080/9000/2121
  均关闭）。L23 不复制 L20 实现、不改对方测试、不把 skip 当移植。
- 下一批顺序（只用公开 `ctx.sync` apply/冲突/隔离）：sync_weird 剩余可执行项、
  sync_realistic_scenarios 的 apply-only 场景、sync_real_flow 的 apply-only 项；
  其余 asset/file/manifest/classification 项需 L20 在 api.ts 窄导出后按原例移植。

## 最新完成：Q2.4 FTP职责拆分（已实施并验证，代码可合入）

C2 本轮裁定实际拆分，原 `giant|host/plugins/sync-providers/src/ftp.ts` 已落地。
受测代码 tip **`c236ef96e`**（父 **`6c371057a`** 新增模块；06867c21a 已是祖先）：
`src/ftp.ts` 由 1207 行降至 1095 行，低于 >1200 的反馈阈值，未删注释/压行规避。

- 新私有模块 `src/ftp-listing.ts`：`FtpListEntry`、MLSD/compact 日期解码、
  POSIX/DOS parser 与 `parseListEntry`，全为原实现逐字节搬移。
- `ftp.ts` 保留原值/类型 re-export（`parseMlsxLine`/`parseMlsxTimestamp`/
  `parsePosixLine`/`parseLsTime`/`parseDosLine`/`parseDosTime`/`parseListEntry`/
  `FtpListEntry`），`FtpStorage` 的 list/stat 与 `FtpSession.mdtm` 仍调用同一实现。
- 未改 POSIX/DOS 语义、传输预算/重试、TLS、日志、断言或 TESTMAP 去向；
  `ftp_contract_source_guards` 的 backend/数据通道锁定段未移动，测试路径无需改。

固定源验证全部取回（均在本轮拆分后、无中途 merge 业务代码）：

| 检查 | Job | 原结果 |
| --- | --- | --- |
| FTP整文件 | `20261105092045-9d6940` | exit0，35/35，无Errors |
| typecheck | `20261105092045-bb42a2` | exit0，无Errors |
| boundaries | `20261105092045-9de025` | exit0，2981files/0违规，无Errors |

标准最终 gate 实跑前置 **exit2**：`git merge --no-edit main` 后仅有 lane 外
`migration/LEDGER.md`、`migration/ledger.json` 未提交（按红线不碰、不 stash/reset），
故 lane-gate 未进入检查项；三个固定源检查已按上表独立取回。合并后最终 tip
`ff0769e13`（业务拆分代码仍为 `c236ef96e`）。W69 原 owner/30s 断言仍独立开放。
TESTMAP 实际仍 **659ported/199pending/1obsolete（859行）**，本次拆分不清 pending、
不批量标 obsolete，生成头仍交 infra 刷新。

## 最新C2裁定与承接起点：本轮结果已齐，不再新增专项

后发07:37指令优先：latest main2a8df3141/07:33:46的W69仍
40532.189368ms>原30s，同源L20 currentDeleteVersion/实际获权写者未确认。
只保存，不重跑W69/S108/目录、不改指标/跨界SQL，不让旧反馈打断冻结作业。
会话52%但1087步，C2已上报健康会话承接，本轮不自行restart/park/切模型，也不
重复发起相同重开请求；下一会话先核main、权限/新反馈，不重做已过单元。

FTP候选 **06867c21a** / tree **8891dadd75b4995e0414a8686f7cb6290ffb71df**：
复用既有F4 chrono原语验证MLSD/MDTM紧凑日期，保suppaftp7.1.0原不同投影/错误，
无新parser或原断言/预算修改。原先红 **20261105073524-b30864 exit1：5failed/
1passed/29过滤、无Errors**；随后固定同源验证均已取回：

| 检查 | Job | 原结果 |
| --- | --- | --- |
| FTP整文件 | `20261105074123-c98ffc` | exit0，35/35，无Errors |
| typecheck | `20261105074123-495e83` | exit0，无Errors |
| boundaries | `20261105074123-a16bba` | exit0，2979files/0违规，无Errors |

全部窗口前后HEAD/tree/目标source/test/config未变，只有原外部ledger dirty；
回执全取回后才编辑本交接/允许main同步。**无本轮待取job，不重复上述检查**。
完整固定依赖原语/官方源URL、协议用例、冻结证明及计数纠正见
`pending/FTP-calendar-receipt.md`。06867提交信息误用旧656/202/1，实际冻结树/当前
均 **659ported/199pending/1obsolete（859行）**；六补充未改去向，不重写历史commit。
生成头仍637/221交infra。上次目录950/1只属于旧9b冻结树，不覆盖本FTP新候选；
本候选只验证FTP35/类型/边界，不签完整FTP/JSON/时间/整lane，正式gate仍受前置阻塞。

## 最新：旧WIP集成拒绝已核，含实现固定树复核不再出现三新失败

gate-fail候选76bb（06:38）仅有测试，不含c148（06:39）生产修复；不清除旧记录。
按晚到新集成反馈要求，固定HEAD9b5f4210f/treee8d2b4e0另跑一次：typecheck
`20261105065253-5c3a54` / boundaries `20261105065254-8da6b4` 原exit0；目录
`20261105065254-247c2d` **原exit1，950passed/1W69failed/20Docker未执行，无Errors**。
WebDAV44/44及weird_sync46/46通过，唯一W69仍33073.86823ms>30000，不当作全绿。
前后HEAD/tree/源/用例/config未变，结束仍仅外部ledger dirty；结果全部取回后才
允许下一main同步。此目录是新反馈明确要求，确实覆盖已有P36/S108/W69，未另排
S108阶段诊断或循环重测；旧R4失败/Errors1不擦除。
完整候选/原job/冻结证明及W69首栈：`pending/Retry-After-integration-receipt.md`。

## W21–W23小集已执行并收尾（不重跑）

源checkpoint同9b，小集 `20261105064400-04a877`原exit0、3passed/43标题过滤、
无Errors。原首Insert unwrap/两纳秒文本/title读取、数值1747000000000与原nowTs、
两处空字符串均保留，真实内存F3/公开apply，无catch/coercion/固定结果政策。
title=v2及各success1/failure0仅观察；仅这三行转ported，最新859=659ported/
199pending/1obsolete，生成头不动；W17仍pending，不自动批准其它观察项。

## 最新自有实现增量：L23-V2-1.3 Retry-After u64精度/上界

Rust先u64秒→Duration再封顶，TS旧Number会接受越界/舍入且漏+前缀。本候选只改
数字分支，精确bigint毫秒在safe范围或30s封顶后才转number；不改HTTP-date/窗口/
重试策略/预算、跨插件API，不复制日期parser。三补充先红
`20261105062952-911a4f`原exit1/3failed，修后 `20261105063307-6de124`原exit0、
WebDAV44/44、无Errors；boundaries `20261105063307-05c5dd` exit0/0违规，
typecheck `20261105063307-2c37ae`已取回原exit0/无Errors，**不重复submit**。
该修复阶段TESTMAP656/202/1不变，未跑迁移目录/全集/W69/S108；后继反馈目录复核
见最上段，完整对应及原作业见SPEC/LANE。

## 最新限定增量：W18/W20保原时间文本的真实apply观察通过

原id/title/null、payload.updated_at与changed_at分别保1969-12-31T23:59:59Z与
2026-05-01T12:00:00.123456789Z，真实F3原内存schema/已安装sync公共apply后打印。
无catch/时间解析副本/生产策略修改，不加成功/拒绝/纳秒落库值断言；W20原未用
tsAgo(10)与同连接别名亦保留。`20261105060240-15cfcb`原exit0、2passed/41标题
过滤、无Errors，两例正常返回success1/failure0仅是观察。仅两行TESTMAP转ported，
含此前独立W13后859实际656ported/202pending/1obsolete；生成头不动，W17等仍pending，
不重跑已过P36/P40等/目录/S108/W69/全集，不签整体时间精度或整lane。

## 最新独立增量：W13生产同源NaN serializer最小回归通过

原Rust W13只将f64::NAN序列化并断言Err或null，未调用apply。已审固定
serde_json1.0.149 NaN写null分支；TS走现有公开且真实payload/quarantine生产链使用
的stringifyJsonLossless，正常返回后验证原Ok分支null，无catch/自造Err或serializer。
实现本就正确，无生产修改。`20261105054602-d9151f`原exit0、1passed/40标题过滤、
无Errors，仅W13 TESTMAP转ported；最新859=654ported/204pending/1obsolete，
生成头不动。仅源码审读+TS公开API证据，无Rust执行/差分或其它serde/整lane扩签。

## 最新最高优先级：05:18Z eaa17的W69原失败已核，生产仍未修

固定main eaa17bc7e，shard6 `20261105050414-f9d810`原exit1，apply39579.047572ms
超原30s，四计数断言通过。W69/fixture/L20/F3未改，W55只使行号390→412，未见新
接口不匹配；当前生产仍table-first。新escalate `2026-11-05T052208691Z-L23-sync-providers.md`
请求实际L20写者或一行窄授权，未获授权前不越界；完整原栈与旧dd564失败并列在
`pending/W69-main-red.md`。此轮未新排测试或改代码，不把记录新红灯冒充生产修复。

## 最新限定批次：P36既有回执复用，P40新最小回归通过

P36已提交c8e10cc16，复用 `20261105045404-bcaeff`原exit0/COUNT5000/
23890.568476ms<60s，本轮不重跑。仅新增P40原10组rec_i/payload_i及字段/两次
tsAgo，真实F3/公开sync批量apply打印Result后正常返回时继续两次原LIKE COUNT
（db.one对应unwrap）观察，无catch/固定计数/成功要求或生产ID策略改码。
`20261105051211-30238b`原exit0、1passed/34标题过滤、无Errors；返回单条失败10
及两COUNT0/0仅观察，不把单条失败误当顶层Err跳过查询。仅P40新TESTMAP转ported，
最新859=653ported/205pending/1obsolete，生成头不动；不重跑其它原例/目录/全集。

## 最新独立增量：P36原5000次apply与计数/60s断言已执行

保原内存schema/refinery行、5000次独立公开apply及输入构造、原COUNT=5000与
elapsed<60s，未并批/减量/增索引；单调计时止于COUNT之前对应原Instant。
新case runner allowance120s不改变原60s业务阈值或既有case预算。
唯一 `20261105045404-bcaeff`原exit0、1passed/33标题过滤、无Errors，
23890.568476ms、实际5000条；只P36 TESTMAP转ported，最新859=652ported/
206pending/1obsolete，生成头不动。未重跑P20/W12/W69/S108/目录/全集，不外推旧根因。

## 最新限定增量：W12精确u64大数已走真实apply并打印Result

C2限定 `w12_large_numbers_in_json`，保原内存schema/SQLite affinity与字段/时间，
counter为精确 `18_446_744_073_709_551_614n`（公开DbJson，不经Number）。真实F3/
已安装sync公共apply后只打印Result，无catch/成功失败或截断值断言、无生产改动。
`20261105043559-8d4b33`原exit0、1passed/39标题过滤、无Errors；stdout精确大数
及success0/failure1只是观察，原输入正常返回、无抛业务Err分类缺口或panic吞咽。
只W12 TESTMAP转ported；含此前独立P20增量，最新859=651ported/207pending/1obsolete，
生成头不动。其它观察项不批量批准，不重跑W55/A13/A33/目录/S108/W69/全集。

## 最新独立增量：P20原10000归档日志 / <500ms断言已实际执行

`p20_large_synced_changelog_does_not_slow_sync` 保原内存schema与10000条synced日志，
原deferred事务提交后在构造fresh变更前起单调计时，经真实F3/已安装sync公开apply，
原<500ms不动；未增索引/缓存或改计时范围。唯一 `20261105042830-151b20`
原exit0、1passed/32标题过滤、无Errors，73.875603ms。只P20转ported，最新859=
650ported/208pending/1obsolete，生成头不动；P36/W69仍独立，不重跑S108/W69/全集。
旧“队列不稳定所以不迁移”不是接口缺口，已用真实最小结果取代，不泛化此通过。

## 最新限定增量：A33原apply/两次COUNT观察已执行

按C2独立范围，`adv_33_payload_id_mismatch_with_record_id`保原record_id=n1与
payload.id=n2及字段/时间，真实F3+已安装sync apply后丢弃Result，再两次db.one COUNT
对应原unwrap并打印，不强加成功/固定计数/写哪个ID，无catch或生产策略修改。
`20261105040401-7d0bcb`原exit0、1passed/38标题过滤、无Errors；n1=0/n2=0仅观察，
不是固定预期。仅A33 TESTMAP转ported，最新859=649ported/209pending/1obsolete，
未改生成头；未重跑38条、S108/W69/全集，其他观察用例不获自动obsolete批准。

## 最新独立增量：W55真实只读apply已移植

F3当前公开 `ConnectionProfile.readonly` 可经openFile.profile传入真实SQLite驱动，
旧W55“未公开flag”说明是漏查，不是提供方仍缺实现。原
`w55_readonly_connection_rejected` 已按Rust:1531-1561保建库→关闭→原生只读重开、
原单条payload及apply Err不变量；断言生产database readonly错误而非任意panic。
最小 `20261105035916-111d65` 原exit0、1passed/16标题过滤、无Errors；仅W55
TESTMAP行转ported，最新859=648ported/210pending/1obsolete，生成头不动。
未执行W69/S108/全集，无生产实现改动；SPEC/LANE/BLOCKERS保对应及回执。

## 最新限定增量：A13原不崩溃不变量已通过真实生产apply

C2限定只处理 `adv_13_payload_type_mismatch`，最小作业
`20261105033816-193e72`原exit0、1passed/37标题过滤、无Errors。保原字符串counter/
INTEGER列，复用F3及已安装sync，不自写apply/coercion、不catch-all或要求成功/特定值；
本输入实际正常返回，未触发抛业务Err分类缺口。TESTMAP仅此一行转ported，最新实际
647ported/211pending/1obsolete（859行），生成头不动。A33等其它条目不获自动移植/
obsolete批准，不重跑目录/S108/W69/全集；详见SPEC的L23-A13与LANE。

## 最新最高优先级：fulltest dd564 的 W69 main-red（需获权生产写者）

03:04Z全量通知已核：shard6 `20261105024553-95d982`原exit1，原apply
42705.341065ms>30000、四计数断言通过；相关test/L20/F3无新diff，没有接口变更
证据；全量dd564不含S108 observer。当前L20生产仍table-first，候选尚未应用。
已escalate `2026-11-05T030837111Z-L23-sync-providers.md` 请求实际L20获权写者
或一行窄授权；L23不自行越界，也不把文档写成fix(main-red)生产修复。
新原首栈/版本/job与既有微基准并列保存在 `pending/W69-main-red.md`。
本轮未重跑同红树；S108一次额度仍已用，不借新全量消息重新诊断。

## 当前交接：唯一 S108 + cleanup 诊断已有结果，不再重测

**诊断额度已使用**：`20261105025729-64ec28` 原exit0，S10865592ms、最终100条
通过；无Errors/hook/RPC超时，19个其他标题仅过滤。受测HEAD `e077e3f6a` /
tree `5e6a6e58d833114e3feb994fb10b5dc9eaf61e97`，实际worker PID3925782，
forks cap3、单文件实际1个worker；队列起止8/5个test job快照均已记录。
D0–D9真实runAll累计63251.231ms，applyPending1697.181ms（内部apply1529.424ms），
host→12storage→rm起止跨度282.916ms。58个stage start全部有end、无error。
**仅是本次阶段观察，不是旧超时根因修复**，不消除历史失败或宣称全lane已完成。
完整58阶段起止/有效配置/并发快照/版本差异与原日志位置见
`pending/S108-stage-diagnostic.md`。本轮取得真实结果后保存结束，不再测试。

**C2 最新执行裁定已撤销“必须等新会话”的限制**：原session未变，但实测上下文
891300→56873、health5%。现允许当前工作树执行已保存的一次诊断；得到真实结果后
保存并结束，不继续重测。以下历史“等清洁会话”要求仅保留其数据/预算/查重边界，
不再阻止本次执行。外部ledger dirty只阻正式gate，不阻本scope诊断。

固定来源（C2 已核）：R4 `d89674497` / main `a968`，原作业
`20261105004819-87e02a` **exit 1**：**1916 passed / 2 failed / 20 Docker skip**，
另 **Failed Suites 1、Errors 1**，有 **Unhandled onTaskUpdate**。

- 新增：`realistic_scenarios_stress_sync.test.ts::s108_10_devices_each_creating_10_records`
  实际 **184280ms**，超过原 **180000ms**。
- 新增 suite cleanup：同文件 afterAll 的 `h.dispose()` 超过原 **10000ms**。
- W69 **47523ms** 是独立的既有失败，不能将这次组合统称“唯一 W69”或“全部 CPU”。
- 旧930/1仅属于其原受测版本，不覆盖这个新R4组合；不要重跑930或1938全套。

### 已有后次对照（C2 已亲取，不新排重跑）

同业务源码的后一次规定 gate `20261105011308-be9c71` 原 **exit 1**：
**1917 passed / 唯一 W69 failed（39002ms）/ 20 Docker 未执行；无 Errors**。
该次 S108 **42730ms 通过**，且**没有 cleanup / RPC 超时**。

这只说明该次运行未复现 S108/cleanup/onTaskUpdate 故障，不是有生产修复或根因结论；
不能擦掉上述 `20261105004819-87e02a` 的184280ms、afterAll10s超时、Failed Suites1
和Errors1。两次结果并列保留，不能只选较绿的一次概括组合，也不能因此取消预算。

第三份原样本 `20261105013305-65a692`（R4 tip71faeb536/basef2d）原exit1：
1916passed/2failed/20Docker skip；S108183077ms再次超180s，W6944129.309275ms，
无hook/Failed Suites/RPC/Errors。另 `20261105020220-6dc310` 是后继main628依赖组合，
原exit1、1930passed/1W69failed/22skip（20Docker+当时2条禁用Value）；S10837894ms通过、
无Errors。第四份不是前三份“全同源码”的证据，不能抹掉前三份的任一失败。

### 本次诊断的开工边界（结果已在上段，不再提交）

- 开工基线 `f28f29cf9` / main `dd564e12f`，tree `61cfdb04b63db7bc03387b7883e5be2712197898`。
  对原main `a9683a43b`，harness/stress、L20/F3/Vitest配置无业务差异；notes的
  api/index/repository实现有增量、sync-support仅文档差异。不是原失败tree复现。
- 开工查queue/running没有含s108或stress文件的活跃作业；提交前再次查重。
- 仅在test fixture真实调用处添加可选阶段观察器、stress worker身份日志，以及
  一次性诊断reporter读取有效Vitest配置/HEAD/tree/dirty及队列起止快照。
  不mock、不改缓存时点/清理顺序/断言/预算，不改生产实现。
- 唯一测试命令将只以原标题选择S108，沿用现有beforeAll/beforeEach/afterAll；
  其他标题过滤不等于新增skip或执行通过。原失败tree/依赖差异不因本次成功消失。

### 已完成的只读预检（未新排任务）

- 两个原 receipt 均为 cwd `/home/dsdev/dev/ds-mig/R4-review-sync`，命令相同：
  `npx vitest run -c vitest.host.config.ts host/plugins/backup host/plugins/sync-providers host/plugins/sync-support host/plugins/sync`。
  命令没有显式 maxWorkers 参数，**不能由此推断两次实际 worker 并发相同**。
- `87e02a` startedAt `00:50:03.712Z`、endedAt `01:09:15.122Z`；
  `be9c71` startedAt `01:13:08.893Z`、endedAt `01:26:15.820Z`，均原 exit1。
- 原始日志位于 `/home/dsdev/.oc-jobs/done/<job-id>.log`：`87e02a` :797-827
  为 cleanup/S108 首栈，:838-856 保留完整 Unhandled onTaskUpdate / Errors1；
  `be9c71` :89 为 S10842730ms通过。优先读取原文，不重构或省略失败首栈。
- 本次查询 queue/running 的 metadata 未发现 `s108` 或该 stress 文件的最小作业；
  done 中仅有较早、不同工作树/命令/版本的 stress 运行，不能替代本次阶段诊断。
  新会话执行前仍须重新查询，避免在此保存后另有任务入队而重复提交。
- 当前 L23 从交接提交后至本次 main 合并，harness/stress 两个文件没有业务 diff；
  这不证明全部依赖或运行环境与 R4 固定组合一致，不能外推复现结论。

新会话只做下列最小定位，不先按读代码给失败归因：

1. 先复用以上原失败与后次对照，再核是否已有相关排队/运行作业，匹配命令、工作树、受测版本；可复用则
   取回结果，不重复提交。若实际诊断不在上述固定版本，必须明确标出差异，不冒称复现。
2. 仅选择 S108 原用例及其 cleanup；保留 **10设备×每设备10条、最终100条**，
   原180s/10s预算与实际F3/owner链。不skip、减数据、抬预算、改假迁移或改业务结果。
3. 对现有真实调用记录阶段 **开始/完成/错误、单调耗时**：逐device建库/
   `storage.migrations.runAll()`、apply、host卸载、各storage关闭、各目录rm。
   记录实际worker/执行器并发环境和配置来源，不将机器核数或预设值冒充实际并发。
4. C2已亲读 `realistic_sync_harness.ts:82-90`：每个新device先真实runAll再缓存；
   `dispose:101-105` 顺序为 host.dispose→各storage.dispose→rm。保持顺序，不用
   重排/吞异常/假关闭让cleanup变绿。诊断只围绕一个case及其现有fixture，不造通用框架。
5. 不mock性能时钟/迁移/owner。若仍非零，保完整首栈、阶段完成点及原exit/Errors，
   不循环求绿。只有明确定位到F3/L20生产阶段后，才将具体方法/栈交C2安排parked接管。
   RPC/onTaskUpdate与执行环境由infra同步定位，不能提前混同于业务算法根因。

## 既有 W69 协调裁定（保留，不覆盖新组合）

- C2 已亲读本文件、W69 任务卡及 main 的 table-first SQL；候选尚未实施，
  尚无有 L20 写权限的接管者，不得说成 owner 已接手或 baseline 豁免已闭环。
- 架构侧负责明确实施者；保留原 10000/全部计数/<30s，之后再跑 W69 和 DELETE/LWW。
- 已验证的 Buffer 源码、回归、930 passed + 1 failed 结果不重复提交作业；
  本 lane 无新增实现时，不重跑同一红树，也不再向停放 lane 堆叠信箱。
- 外部 ledger dirty 和 TESTMAP 生成头刷新交 infra；不暂存/还原/混交其文件。
- W69生产修改仍等待具体owner或相关main增量，未获跨lane授权；新组合的
  S108/cleanup诊断按最上段在保存后的清洁会话执行。

## 硬边界

- 仅写 `host/plugins/sync-providers/`；`ACCEPTANCE.md` 为 R4 所有、只读。
- 不写其他 lane、`migration/`、`contracts/`、全局 `docs/`；不自行恢复其他会话。
- 不 stash/reset/checkout/clean/rebase/push/切分支，不删他人的未提交修改。
- 重任务必须经 `/home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs`。
- 每单元只提交本 lane 文件，finding ID + `Co-Authored-By: GPT-6 Astra`；提交前 merge
  main，结束前提交→merge main→`lane-gate.mjs`。不得用隐藏 dirty 等方式绕过。

## 从这里继续，不重做已保存代码

- 当前分支 `ds-mig/L23-sync-providers`。协调者频繁 auto-WIP：diff 为空不代表丢失，
  先看 git log/show 和文件标记。
- 最新显式修复 `8d593beb3`：BoundedMemoryBody 从 Buffer.slice 改为
  Uint8Array.from，对齐 Rust Vec::extend_from_slice。代码在 `afdbed201`，三个
  回归在 `001a6c402`，都已保存，不再重写。
- 有效先红 `20261104235153-1714e6` exit 1，2 failed / 8 passed、无 Errors；
  修后三文件 `20261104235457-37bc5f` 90/90 exit 0，typecheck `4b0e27` exit 0。
- 本次恢复请求已执行 log -20/status/TESTMAP。当前逐行统计实际 859 行：
  **659 ported / 199 pending / 1 approved obsolete**。生成头仍旧 637/221；
  只允许手改去向，scaffold 无 lane 写入过滤，已请协调者刷新，勿全仓 refresh。

## Buffer 阶段历史结果（均已取回，不能外推到新 R4 组合）

| 检查 | Job | 实际结果 |
| --- | --- | --- |
| 用户要求的 ledger --check --no-write | `20261105000439-73920d` | exit0，commands/tests/orphans问题全0 |
| Buffer 修复后 typecheck:host | `20261105000759-95595f` | exit0，无Errors |
| Buffer 修复后 migration:boundaries | `20261105000759-6696cd` | exit0，2949files/0违规，无Errors |
| Buffer 修复后全插件 | `20261105000759-c4232d` | exit1，930passed/1W69failed/20Docker未执行，无Errors |

W69 本轮46509.72ms，原10000/<30s未动；Buffer三个补充用例与其他原回归通过。
ledger全仓：commands1058 A100%，tests8109 A87.8%/B1.9%，unreachable16、unknown3633不否决；
不是本lane验收/新增问题认定。提交时核实际exit/Errors，不把定向绿或运行中当通过。

## 独立既有 main-red：W69（尚未解决，但不是新 R4 组合的唯一故障）

- 原测试 `w69_ten_thousand_tiny_records` 必须保留 10000 条、四项结果计数和
  `<30000ms`。本 lane 已修正 Rust open_in_memory 被误译磁盘、Date.now→performance.now，
  但生产 apply 仍超时。不增测试索引、不减输入、不改计时口径/阈值。
- 热点在 **L20** `host/plugins/sync/repository/apply-record.ts::currentDeleteVersion`
  的 DELETE 日志 SQL，超出写入白名单。profile 约 16.24s，其中 F3 get 自耗13.15s。
- 最小候选和真实 F3 诊断：`pending/W69-main-red.md`、
  `tests/diagnostics/w69-query.ts`；job `20261104194043-6655ea` exit 0，record-first
  比当前 table-first 约快38%，结果控制相同。只是候选，不证明全 W69 过30s。
- 已直接 queue L20/C2，并多次 escalate。此前 C2 连续 provider拒绝/不运行，
  L20 从14:43Z停放；架构师已收到恢复协调链请求。本轮结果取回后再次只读核查：
  **C2 已恢复运行且属于其工作树、队列1；L20仍停放、不运行、队列2**。
  不再把旧 C2 故障状态当成最新事实；owner 是否恢复仍须等实际反馈。
  **排入队列不等于已接手**。不自行 restart 或把无答复当跨 lane 授权。
- 只有 owner 新代码进 main 或明确扩权后才可修改该 W69 生产路径；不要对同一未变
  红树重复跑 full。实际自有生产变更仍须按规定验证组合影响，不能回复“无剩余工作”。

## 其余状态

- `lane-gate.mjs` 当前先退出2：外部生成 `migration/LEDGER.md`、`migration/ledger.json`
  dirty。不是本 lane 工作，不提交/还原；已请求协调者处理。
- B04 `fix(main-red)` 在 `cd20f3370` 已恢复原 Rust 内存 schema/4MiB→5MiB，两个
  原断言和时限未改，整组通过；完整迁移库多出的 L10 格式检测成本独立保留，勿混淆。
- 云场景31–34已用正常 Host.dispose 实现原 A-write→B-read→B-write 顺序，原断言
  与真实 owner 不变，已全套通过；勿恢复同进程并存两套全局 owner 的旧夹具。
- P04后续已修 typed lease、纳秒排序/到期、Rust trim、claim fallback/Display、UUID
  精确四形状（uuid1.20）；证据按稳定UD0077等记录在LANE/SPEC。补充用例不提升
  TESTMAP，不自行编辑验收或签收。最新整组（Buffer之前）`20261104231951-3ce591`
  exit1：927passed/唯一W69failed/20Docker未执行，无Errors。
- F4 JsonReader仍仅string，缺从片段UTF8语义/arbitrary_precision错误分类/zmij e+，
  暂保留已有serde reader；不再复制新parser/crypto。chrono relaxed、u64文件元数据链、
  f32输出等剩余见BLOCKERS，不能宣告P04全完成。
- W57未完成的HTTP实验和原100次/count100预期完整保存在 `pending/W57.md`，
  一直pending；需L20公开现有storage级生产函数后正式移植，不私导入或造替身。

## 自有增量 L23-V2-1.7：WebDAV单调限流候选（不等整lane签收）

- 已执行原待办：Rust webdav.rs:132-169的Instant窗口在TS仅一行改为performance.now；
  共享容量/等待/取消/HTTP-date墙钟语义均不动。原取消测试仅修填窗输入时钟，保原断言。
- 四补充回归通过同一真实gate/共享实例/实际AbortSignal，不造sleep或新导出。初次
  ed02a1有Error.name夹具错误，原失败保留；更正后233f31源码先红exit1、2failed/
  2passed（正常控制通过、前跳/回拨失败）。修后完整WebDAV
  `20261105033052-311154` 41/41、exit0、无Errors，boundaries1f4d8c exit0/0违规。
- typecheck `20261105033052-b51258` 已取回原exit0、无Errors；源修复提交
  `d476cf29e`，三项结果已齐，不重复submit。四补充不提升TESTMAP，
  不覆盖W69 main-red或已用的S108诊断，不重跑930/1938全集；独立验收仍由R4签收。
