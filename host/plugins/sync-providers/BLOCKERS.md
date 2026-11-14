# L23-sync-providers 剩余阻塞

## WP-221：八条已移植，集成资格待 C2 独立核验

Rust `sync_comprehensive_tests.rs:520-626` 八条已通过公开同一 `mergeField` 移植；
Node `20261105235110-23fcfb` / Electron `20261105235110-5c9708` 均原 exit0，
31 passed / 0 failed / 0 skipped / Errors0。未发现本包 L20 生产语义缺口。
仅八行 pending→ported，当前实数685 ported / 173 pending / 0 merged / 1 obsolete，
旧统计头按本包授权修正。下方历史汇总不代表当前逐行统计。

开工即有的 `migration/LEDGER.md`、`migration/ledger.json` foreign dirty 保留；
官方 gate 结果在 WP-221 原始报告交付，由 C2 清洁组合与至少1/8独立抽检裁定，
不以31例局部通过签全域 A/B/C，不占当前冻结及209优先集成顺序。

## WP-180：原 WP-032 的 mergeField 接口阻塞已解除

已正常合并 main（本轮起点 `f0b14cfd5`，main `fd9d654d7` 含 `b54983282`；
`23a583250` 已核为 main 祖先）。`host/plugins/sync/api.ts:31-32` 直接重导出
`mergeField` / `MergeResult`，定义在 `src/field-merge.ts:68`；生产消费点
`repository/apply-record.ts:604`、`repository/apply-guard.ts:120` 导入同一实现，
从 `index.ts:169-176` 的公开 apply 服务可达。下面 WP-032 的“没有公开入口”
仅为原包历史事实，已不构成当前阻塞；原报告与预检原件保留。

本包只处理 Rust `sync_comprehensive_tests.rs:421-501` 首八例，Node/Electron 均23/23
（`20261105220122-6571e1` / `20261105220122-949091`，exit0、无 Errors），
TESTMAP 实际 pending189→181 / ported669→677 / obsolete1保持。逐断言映射见
TESTMAP 的 WP-180 节；其余 field_merge 条目不再笼统归为缺 mergeField，需后续
工作包逐项审读。旧 `test_max_value` 的既有去向资格属于历史事项，本包不作裁定。
正式 lane-gate 的 foreign ledger 前置与 C2 独立抽检另行记录，不以定向通过代签。

`04c99885d` 提交→正常 merge main→直接官方 lane-gate 的实际结果为 **exit2**：
`有未提交的改动，先提交再自检（自检结果按提交记录）`，仅列
`migration/LEDGER.md`、`migration/ledger.json`。这是开工即存在的他人生成物，
本包未覆盖、还原或提交；gate 未启动子 job。已向 C2 交固定候选、逐断言映射及
抽检≥1/8请求，等待清洁组合验证与独立回执。

## v2 接手增量（2026-11-04）

- **07:33Z W69同源红灯仅保存，不新增重跑**：C2后发07:37裁定及latest聚合
  head2a8df3141/at07:33:46.683Z，apply40532.18936800001ms>原30000，非新
  Retry-After三红或S108超时。原栈/来源追加W69任务卡，实际L20获权写者未确认，
  不改阈值/输入、不给parked重复排执行、不跨界复制SQL。本轮FTP最小单元已绿并
  交健康会话，实际TESTMAP659/199/1未改；外部ledger前置仍由infra处理。
- **Retry-After集成反馈已固定源复核，不改写原exit**：拒绝候选76bb仅有测试、
  不含c148实现。按新反馈固定9b5f4210f、前后HEAD/tree/目标内容不变，
  typecheck065253-5c3a54/boundaries065254-8da6b4原exit0；目录065254-247c2d
  原exit1、950passed/唯一W69failed/20Docker未执行、无Errors，WebDAV44/44通过。
  原W69仍33073.86823ms>30000，不以baseline豁免当全绿。完整候选/冻结证明/
  原首栈见 `pending/Retry-After-integration-receipt.md`，正式gate仍受ledger dirty阻塞。
- **W21–W23限定三例已执行**：同一9b固定源小集
  `20261105064400-04a877`原exit0、3passed/43标题过滤、无Errors。保W21首Insert
  unwrap、两原纳秒文本及真实title读取；W22原数值1747000000000与nowTs，W23两处
  空字符串，无catch/coercion或额外结果政策。仅三行转ported；最新859=659/199/1，
  W17仍pending，生成头不动。后继目录复核来自新集成反馈要求，不是原小集扩行。
- **W18/W20已按C2两原标题限定单元执行**：保原1969时间/9位纳秒文本与id/title/
  null、payload.updated_at和changed_at；真实F3原内存schema/触发器/refinery行，
  已安装sync公共apply后只打印Result，无catch/时间转换副本/成功或落库值政策。
  `20261105060240-15cfcb`原exit0、2passed/41标题过滤、无Errors；两例各正常返回
  success1/failure0仅是观察，不从旧1969注释添加新拒绝规则，也不据此签纳秒落库
  精度。仅W18/W20转ported；含此前独立W13增量，859实际656ported/202pending/
  1obsolete，生成头不动。W17未来drift等仍pending，未重跑目录/已过项/S108/W69。
- **W13已消费生产同源NaN serializer，不再以“只测stdlib”阻塞**：原Rust
  `sync_weird_tests.rs:388-396`是f64::NAN的serde_json::to_string，非SQL/apply测试；
  固定serde_json1.0.149 `ser.rs:169-179`的NaN分支写null。当前公开
  `sync/api.ts::stringifyJsonLossless`已由真实payload/quarantine生产链调用，NaN
  分支同样正确，无需生产修复或另写JSON替身。最小
  `20261105054602-d9151f`原exit0、1passed/40标题过滤、无Errors；正常返回null
  检查原assert的Ok分支，无catch/私造Err分类。本次未观察throw，不把所有异常当
  Rust业务Err接受；仅W13转ported，最新859=654ported/204pending/1obsolete。
- **最新05:18Z W69 main-red仍缺实际L20写者/窄授权**：main eaa17bc7e全量
  shard6 `20261105050414-f9d810`原exit1，apply39579.047572ms>30000、四计数过；
  W69本体/fixture/L20/F3相对既有失败无差异，只有W55使行号390→412，未见新接口
  不匹配。生产仍table-first；已escalate `2026-11-05T052208691Z-L23-sync-providers.md`
  请求实际写者或一行窄授权。完整新首栈与旧dd564失败并列在`pending/W69-main-red.md`。
  未重测/改生产/放宽原10000及30s，不能用baseline豁免或其它小集绿当闭环。
- **P36/P40限定批次已各有真实小集结果**：P36复用已提交c8e10cc16及
  `20261105045404-bcaeff`原exit0，原5000次单条/COUNT5000/23890.568476ms<60s，
  不重跑。P40按Rust:1668-1711保10个rec_i/payload_i、两次tsAgo(100-i)、真实
  批量apply打印；正常返回后两次LIKE COUNT以db.one对应unwrap，保原LIKE模式，
  不强造成功/固定计数/ID策略，无catch。唯一新增
  `20261105051211-30238b`原exit0、1passed/34标题过滤、无Errors；正常返回单条
  失败10与LIKE计数0/0只是观察，两个查询未因failure_count非零跳过。仅P40新转
  ported；最新859=653ported/205pending/1obsolete，生成头不动，无生产改码。
- **P36原5000次独立apply/性能断言已实际执行**：Rust
  `sync_pathological_tests.rs:1475-1504`保5000次各1条、原r00000…ID/逐条tsAgo及
  内存schema/refinery历史行；计时覆盖输入构造和所有apply，不含末尾COUNT。
  原COUNT=5000和elapsed<60s均保留，未并成批次/加索引/减量/改阈值。
  新case的runner allowance120s仅用于让原60s断言给出结果，不改既有case预算。
  唯一 `20261105045404-bcaeff` 原exit0、1passed/33标题过滤、无Errors，
  23890.568476ms、实际5000条。只P36转ported；最新859=652ported/206pending/
  1obsolete，生成头不动，不外推W69或历史超时已修。
- **W12已按C2限定单元实际执行**：Rust `sync_weird_tests.rs:367-384`的
  u64::MAX-1使用精确 `18_446_744_073_709_551_614n`，通过公开DbJson/真实apply，
  无Number中转，保原内存schema/INTEGER affinity、字段及两次nowTs。只打印Result，
  不断言成功/失败/截断值，无catch或L20生产转换改动。唯一
  `20261105043559-8d4b33`原exit0、1passed/39标题过滤、无Errors；stdout精确大数
  及success0/failure1是观察，正常返回的单条失败不是测试吞panic。仅W12转ported；
  最新859=651ported/207pending/1obsolete，其它观察项不获批量批准，生成头不动。
- **P20原性能断言已实际迁移执行**：旧test头以共享队列不稳定为由保pending，
  不属于真实接口缺口。现按Rust `sync_pathological_tests.rs:852-884` 保10000条
  sync_version=1日志、原内存schema/触发器及refinery历史行，deferred事务提交后
  在构造原单条fresh变更前开始单调计时，真实公开apply返回后断言原 `<500ms`。
  无索引/数据量/计时口径/阈值修改。唯一 `20261105042830-151b20` 原exit0、
  1passed/32标题过滤、无Errors，实测73.875603ms。只P20转ported，不推断P36/W69
  或历史超时已修；最新859=650ported/208pending/1obsolete，生成头仍交infra。
- **A33已按C2下一独立单元移植**：Rust `sync_adversarial_tests.rs:1224-1263`
  保record_id=n1/payload.id=n2、原字段/时间，经真实apply忽略Result后分别COUNT
  n1/n2并unwrap打印。TS复用F3/已安装sync，两个COUNT用真实 `db.one`（无行/SQL
  错误直接抛，不以0回退），无catch/强制成功/固定计数或ID策略修改。唯一最小
  `20261105040401-7d0bcb`原exit0、1passed/38标题过滤、无Errors，打印0/0只是
  本次观察。仅A33转ported；最新859=649ported/209pending/1obsolete，生成头不动。
- **W55只读连接旧接口阻塞已纠正并移植**：当前F3 `ConnectionProfile.readonly`
  和 `OpenFileOptions.profile` 已公开（storage/api.ts:346-365），service传到真实
  better-sqlite3 readonly/fileMustExist标志；不是本轮新增接口。旧test头称无公开
  只读开关属于漏查。现按Rust `sync_weird_tests.rs:1531-1561`先建原裁剪schema、
  关闭可写连接，再只读重开并经已安装sync调用原apply。原 `r.is_err()` 对应生产
  `Database error: ...readonly database`异常，未用query_only代替只读打开或接受任意panic。
  `20261105035916-111d65`原exit0、1passed/16标题过滤、无Errors；只W55转ported。
  最新859行=648ported/210pending/1obsolete，生成头仍交infra；W69/S108未执行。
- **A13“不崩溃”移植已执行，不再以无assert阻塞（C2限定单元）**：原Rust
  `sync_adversarial_tests.rs:570-587` 将字符串counter写入INTEGER列，经真实
  SyncManager apply忽略Result，只要求不panic。现 `adversarial_sync.test.ts` 保原
  输入/SQLite affinity，经已安装sync的公共apply调用，不断言计数/成功/counter值，
  不自写coercion、不catch-all。`20261105033816-193e72`原exit0、1passed/37标题
  过滤、无Errors，原输入没有抛出业务Err或panic；未凭Error.name吞异常。
  当时只将A13转ported，859行=647ported/211pending/1obsolete；后继A33独立移植见上。
  如未来此路径抛业务Err，应保栈并经公开错误分类核对，不能直接把所有throw吞为成功。
- **最高优先级main-red / W69仍缺有权限实施者（2026-11-05 03:04Z）**：main
  dd564e12f全量shard6 `20261105024553-95d982`原exit1，W69 apply42705.341065ms
  超原30000ms；四项计数断言均通过。相关test/L20 apply-record/F3实现相对既有
  诊断未变，无新接口不匹配证据，且该全量版本不含新S108 observer。
  当前生产仍table-first，微基准候选未应用；L23写白名单不含L20。已通过
  `2026-11-05T030837111Z-L23-sync-providers.md`立即请求架构指定实际获权写者，
  或只对该predicate-order一行明确授权；后续保10000/全部计数/<30s验证W69及
  DELETE/LWW，真实修复才提交fix(main-red)。完整新首栈/版本/原job见
  `pending/W69-main-red.md`；没有重测或声称owner已接手/性能已修。
- **W57 原存储入口仍缺**：Rust sync_weird_tests.rs:1649-1659 对同一 `SyncManager`
  和 MemStore 顺序 mark 100 次，再 download_for_device，断言 100 条。
  L20 已公开的 markBlobDeleted 只接收 config，额外走命令许可、SSOT 与真实 HTTP。
  该版本回归保留 100 次与 count=100，作业 `20261104183657-d8df94` exit 1，
  7 passed / 1 failed（W57 180s 测试时限未完成），无 Errors；W57 未提为 ported。
  fulltest 下发 main-red 最高优先级后，该未完成实验暂停并完整保存在
  `pending/W57.md`（含原 100 次与 count=100）；不是已 ported 案例的跳过或断言删除。
  需 L20 从 api.ts 窄导出既有 `src/file-deletions.ts::markBlobDeleted` 与必要
  DeletionOptions（或同义的 storage/device/codec/真实 tombstone owner 接缝），必须
  复用高层命令实际调用的同一函数。L23 不私引该实现、不复制算法、不改 100 次或
  跳过原断言；等公开面后按原 MemStore 输入正式执行，不拿 HTTP 时限当原 Rust 性能断言。
- **新 main / L10-F3 注册生命周期**：`cloud_mark_scenarios_sync.test.ts` 第二个真实 Host
  安装 notes 时抛 `SlotOccupied`，4 条已移植场景未执行。首次失败作业
  `20261104170504-df0d9d` exit 1，栈 :286-304 为 asset-retention 注册；当时 L10 还丢弃
  Disposer。后续 main 已补 ctx.effect/dispose，不能继续把“未释放”当最新事实。
  当次 `20261104173553-3c986d` exit 1 仍在第二 Host 的
  `registerDeletionJournal`（storage/deletion-journal-owner.ts:34，日志 :258-281）
  因模块级单例 Slot 占用而失败。需所有者明确多 Host 注册/共享策略，不在本 lane catch
  吞错、替换 notes 或手工清除平台 Slot。两份失败及部分修复状态均已通知协调者。
  **本 lane 候选已修**：原场景 33 只有顺序 A-write→B-read→B-write，无并存应用要求。
  新 main 已提供正常 dispose 释放注册，夹具现按该顺序结束 A 的 Host，再启动独立
  目录 B（A 的持久化目录保留至 case cleanup）；每 case 使用独立实际 Host。
  `20261104175948-196cc8` 4/4、exit 0、无 Errors；不再要求 owner 改全局 Slot 策略，
  仍待新全套/集成复验。没有直接访问/清除 Slot 或替换 owner。
  新全套 `20261104180553-98da7b` 的 4 条场景也已执行通过；此项在本 lane 已验证，
  待进入 main 后独立复核，不再列为最新全套失败。
- **新 main / L10-L20 大正文同步性能**：B04 的原 5MiB 内容断言未改。
  定向 `20261104171426-ec1507` 仍 exit 1（1 failed / 24 未选中），30s testTimeout；
  单 worker CPU-profile 作业 `20261104171719-39ffed` 同样 exit 1、无 Errors。
  `/tmp/opencode/l23-perf/CPU.20261105.011723.1744678.0.001.cpuprofile` 显示
  apply 约 32.94s，其中 `sync/repository/note-history::validateIncomingImpl →
  notes.format.detect → notes/src/structure::markdownRoots → micromark/dev`
  约 32.65s。需 L10/L20 处理生产正文格式检查的成本/阻塞；不在本 lane 换解析器、
  吞日志、缩小 5MiB 或增大断言预算来过关。
  来源补充：原 Rust B04 的 fixture（:26-65）是裁剪 resources/change_log 的内存库，
  没有历史表；TS 选择完整迁移库才进入格式检测。原 B04 只有长度/前缀两断言，
  30s 是 Vitest 默认时限（不同于 W69 的原 Rust 30s 断言）。已请求协调者明确
  原 fixture 与额外生产组合的归属，未自行移除历史钩子或扩大时限。另已恢复原
  :419-425 的初始 4MiB x（TS 先前误为 '{}'），再更新为 5MiB y，原断言保持。
  **main-red 本 lane 夹具修复**：按已经明确的 Rust :26-64/:417-459 恢复 B04 原
  裁剪 schema 和内存连接；真实生产 hook 仍安装且由原同样的“无历史表”条件返回，
  不是替换 hook 或修改调用。`20261104185550-7aae5f` 中 B04 371ms 通过，作业整体
  exit 1 来自 W69（31507.68ms），39 条未选中，无 Errors。原 B04 故障待全套复验；
  完整迁移库格式检测的性能问题继续保留为 L10/L20 独立生产问题，不借此签收。
  后续全套 `20261104190258-934ddd` 已复验 B04 348ms 通过、business_tables 25/25；
  原 B04 不再是本 lane 失败项，待 `cd20f3370` 进入 main 及独立复核。
- **新 main / L20 万条批次性能**：W69 保留原 10000 条与 <30s 断言。
  已修正本 lane 的 Rust open_in_memory→磁盘夹具误译，并用 performance.now 对应
  Rust Instant；但定向 `20261104171426-1268a9` 仍 exit 1（15 passed / 1 failed），
  apply 38322ms。内存语义修正不等于性能问题已关闭，需 L20 所有者继续排查。
  单 worker profile `20261104172145-2fa67b` 同样 exit 1（1 failed / 15 未选中），
  30332.81ms，未放宽原阈值。`/tmp/opencode/l23-perf-w69/CPU.20261105.012147.1756315.0.001.cpuprofile`
  显示 apply 约 30.23s，`apply-record::currentDeleteVersion` 累计约 16.24s，
  其中 F3 connection.get 自耗约 13.15s；请 L20/F3 核对 DELETE 版本/日志查询成本。
  当前最高优先级的唯一整套失败：`20261104190258-934ddd` exit 1，851 passed /
  1 failed / 20 Docker 未执行，W69 40352.41ms，无 Errors。修复目标在 L20/F3
  所有者实现，超出本 lane 写入白名单；已请求实际分派或明确最小跨 lane 授权。
  最小 SQL 候选与真实驱动诊断已备好：`pending/W69-main-red.md` /
  `tests/diagnostics/w69-query.ts`。Job `20261104194043-6655ea` exit 0、无 Errors；
  原 table-first 7103.67ms，record-first 4383.61ms（约快 38%），计划不变，混合
  DELETE 最新结果检查相同。仅需 owner 评估谓词顺序的一行差异，再跑完整 W69；
  不是本 lane 已修生产或已达到 30s 的声明。
  最新实际生产租约增量 `554a8ae57` 的全套 `20261104222318-490817` exit 1，
  891 passed / 1 failed / 20 Docker 未执行，W69 36334.14ms，仍是唯一失败；
  新认领边界及既有用例通过，无 Errors。不得把主线既有红可忽略当作已关闭此项。
  **实际交接阻塞**：只读 sessions.json 发现 L20-sync 从
  `2026-11-04T14:43:12.297Z` 停放且 queue.length=1；已投递任务尚未执行。
  已直接 queue C2-platform 请求恢复 owner 并同步升级架构师，不把“排入队列”
  当作“已经接手”。本 lane 不自行 restart 其他 lane，也未获跨目录写授权。
- **P04 / F4 精确首块 API 阻塞已解除**：main 已含 F4 的
  `dsbkFirstChunkSpeculativePrefixLen` / `planFirstChunkTrial` /
  `trialDecryptFirstChunk(objectLen: number | bigint)`。L23 `src/password_proof.ts`
  三处改为直接传清单的 bigint（对应 Rust `sync_manager.rs:1349,1370,1399`），
  不复制加密计划算法。真实加密首块 + 清单大小 `9007199254740993n` 经 manager
  试解通过：作业 `20261104145807-cdf82c`，33/33、exit 0、无 Errors。
- **P04 / F4 共享 JsonReader 接入仍阻塞**：`2d9d56497` 已进入 main，但尚未修复
  上报的三项差异。`host/platform/util/index.ts` 公开入口实测：
  `new JsonReader('1e2').readString()` 报 `floating point \`100.0\``，而 dstu-sync
  启用 arbitrary_precision 后该错误应为 `number`；越界 u64 的文本输出
  `1.8446744073709552e19`，serde_json 1.0.149 的 zmij 输出为 `e+19`；
  构造器仅接收 string，无法保持 from_slice 的非法 UTF-8 校验时点与 IgnoredAny
  不校验 UTF-8 的区别。需 F4 在公开面支持这些语义后，L23 才能删除已有
  `serde_struct.ts` 并消费共享 reader；不私引分支、不另复制实现。
- **F4 身份旧阻塞已关闭**：main 的 `paths.dataSpaceDeviceId()` 已可用，四条身份
  持久化/轮换/子进程用例已在 `tests/device_identity.test.ts` 通过（作业
  `20261104102017-767a84`，7 passed / 1 个“owner API 缺失”防护用例门控）。
- **进度 f32 裁定**：`src/cloud_commands.ts:27-28` 仍 double；Rust
  `cloud_storage/mod.rs:492-495,593-596` 为 f32。未见批准，已请求协调者明确
  是严格对齐计算及 serde f32 最短输出，还是接受有范围的数值差异。
- **W50 / L20 HLC 比较面**：新基线 AP 审读确认 Rust
  `sync_weird_tests.rs:1337-1340` 先断言解析后 HLC 的 `cmp == Ordering::Less`，
  再断言字符串字典序；`tests/weird_sync.test.ts` 只有后者。
  main 的 `sync/api.ts::HlcValue` 仅有 millis/counter/toString/toU64，无对应 cmp。
  需 L20 公开实际 HLC 比较（如 `HlcValue.cmp(other): -1 | 0 | 1`），不以测试内比较器
  或 packed-u64 排序替代。该原测试已退回 pending，保留已有字符串断言。
- **测试统计头刷新**：只改 TESTMAP 允许的去向列：场景 35/36 转 ported，W50
  退 pending；续派又迁移身份稳定性的 scenario_38/adv_14 和 DELETE 漂移隔离 R27。
  L20 mark 方法进入 main 后场景 31–34 又经真实命令组合迁移。
  W39 直接调用真实公开 apply helper 后已通过并转 ported；W57 尚未提级。
   最新增量后，实际为 659 ported / 199 pending / 1 obsolete（859 行）。
  scaffold 只能全仓 refresh；为遵守写入白名单，不自行执行该写操作，请协调者刷新
  本文件的生成统计头（仍为旧 637/221）。未手改生成头，不以过期表头宣称闭合 P08。
- **R26 / L20 自动重放**：`sync_regression_tests.rs:1116-1121` 调用
  `replay_quarantined_changes(conn, None, QUARANTINE_AUTO_REPLAY_MAX_ATTEMPTS)`；
  main 的 sync/api.ts 仍没有按传入连接自动重放的公开方法。命令
  `retryQuarantine(databaseName,id)` / `retryAllQuarantine()` 不是该 API，不能用它们
  替代自动重放。请 L20 发布已有生产自动重放方法及 maxAttempts 常量或默认值接缝。
  R26 保持 pending；R27 无重放步骤，已独立经公开 apply 移植，不再整组阻塞。

> 本文件只记录**无法在本 lane 内完成**的 TESTMAP pending 项及其证据。
> 数据来源：`host/plugins/sync-providers/TESTMAP.md` 现状（2026-11-04），
> 逐文件对照 `src-tauri/tests/*.rs` 的 `use` 与调用点。
> 数据空间切槽 4 条已用 F3 `DataSpaceManager` 移植；设备身份 4 条依赖 F4
> `paths.dataSpaceDeviceId()`，main 已集成并通过四条身份用例。L20 的 214 条不再是
> “接口只在分支”：main 已发布多数引擎公开面，剩余是移植积压与少量未发布符号。

## 1. L20-sync：main 已发布引擎面，214 条转为移植积压（214 条）

当前 main（含 `d5cd234aa`）的 `host/plugins/sync/api.ts` 已发布本 lane 需要的多数
引擎面：`applyDownloadedChanges*`、`applyDownloadedChangesToDatabases`、
`getPendingChanges`、`filterPendingChangesForDatabase`、`enrichChangesWithData`、
`executeBidirectional`、`executeDownload`、`downloadChanges`、
`uploadEnrichedChanges`、`commitDownloadProgress`、`validateRemoteFormat`、
`validateUploadSchemaCompatibility`、`uploadManifest`，
`MergeStrategy`/`SyncManifest`/`PendingChanges`/`EngineChange`/`ConflictPolicy`
等类型，以及 `commitDownloadProgress`/`prepareDeleteVersionsForCleanup` 等写路径。

因此 214 条不能再称为“接口不存在”或“只待 main 集成”；逐项复核后的真实状态：

- **已具备公开面、可进入移植**：只依赖上述 engine API 与 `ConflictPolicy` 的用例，
  例如多数 `sync_realistic_scenarios`、`sync_scenarios_tests`、`sync_weird_tests`、
  `sync_comprehensive_tests`、`sync_adversarial_tests`、`sync_pathological_tests`。
  这些仍需 L20 engine + 数据库 fixture，属于 L23 的移植工作量，不是阻塞。
- **仍缺 L20 公开面**：`classification` 注册表（`sync_schema_coverage_tests`、
  `sync_real_flow_smoke_tests` 等）、`asset_filenames`/`AssetDirsManifest`
  （`sync_r07_filename_tests`、`sync_r09_filenames`、
  `sync_r07_cross_platform_names_tests`）、`commands_sync` 的
  `delete_record_with_resolve`/`resolve_delete_conflict`
  （`sync_r06_delete_resolve_tests`、`sync_r07_delete_resolve_lock_tests`）、
   等具体符号仍待逐项核实；`field_merge` 的 `mergeField` 已由 WP-179 在 main
   公开，不能再作为缺接口阻塞（见置顶 WP-180）。
- **Docker 门控**：214 条中 42 条 provider 契约测试还受
  `DS_SYNC_TEST_DOCKER=1` 门控（Rust 侧 `#[ignore]` 同条件）。
- **标记删除公开面已进入 main**：L20 `SyncService.markBlobDeleted` /
  `markAssetDeleted` 与注册命令已提供，场景 31–34 经真实 L20/L21/F4/L20b/L23
  组合迁移到 `tests/cloud_mark_scenarios_sync.test.ts`，不再记接口阻塞。
  作业 `20261104161319-4062cd` 4/4、exit 0、无 Errors；真实两个 Host 分别使用
  device_a/device_b，SSOT/凭据发布经所有者服务，云端使用真实 WebDAV client。
- **仍缺文件级 CloudSyncManager 公开面**：scenario 37、40、57-59、61 等仍需
  `sync_vfs_blobs` / `sync_vfs_blobs_with_tombstones` 等文件级入口，不能用已经公开的
  mark 方法冒充完整文件生命周期同步。scenario 38 的 F4
  设备身份阻塞已解除并通过真实 kernel 命令移植；scenario 39/51 仅测试 Rust
  `MockCloudStorage` 测试替身本身。
  scenario 35/36 原本就直接调用 tombstone helper，不应被 manager 公开面阻塞；
  已经 main 的真实 syncSupport 插件服务移植到 `tests/tombstone_scenarios_sync.test.ts`，
  作业 `20261104150503-b60293` 2/2、exit 0、无 Errors。

按 TESTMAP pending 数与 Rust `use` 静态引用，依赖仍未发布公开面的文件级上限：

| 仍缺的 L20 公开面 | 涉及文件（pending） | 上限 |
|---|---|---|
| `classification` 注册表 | `sync_schema_coverage_tests`（11）、`sync_real_flow_smoke_tests`（15） | 26 |
| `asset_filenames` / `AssetDirsManifest` | `sync_r07_filename_tests`（4）、`sync_r09_filenames`（7）、`sync_r07_cross_platform_names_tests`（4） | 15 |
| `delete_record_with_resolve` / `resolve_delete_conflict` | `sync_r06_delete_resolve_tests`（2）、`sync_r07_delete_resolve_lock_tests`（3） | 5 |
| **合计（文件级上限）** | | **46** |

其余约 168 条主要依赖 main 已发布的 engine API；它们是 L23 的移植工作量，不再记
“接口不存在”。`sync_real_business_tables_tests` 的 25 条业务表用例已用真实 F3
生产迁移与真实 vfs/notes/sync 插件移植到 `tests/business_tables_sync.test.ts`；
`sync_scenarios_tests` 的 46 条 apply/冲突/回放场景（01-30、41-50、52-56、60）
已用原始 fixture schema 移植到 `tests/scenarios_sync.test.ts`；
`sync_regression_tests` 的 26 条 HLC/基线重建/清理/批量/冲突守卫用例已移植到
`tests/regression_sync.test.ts`；
`sync_integration_deep_tests` 的 12 条 HLC/因果/回放/冲突/批量不变量已移植到
`tests/integration_deep_sync.test.ts`；
`sync_r02_hardening_tests` 的 4 条双端 tag/收藏合并、复合主键 DELETE 版本和慢钟冲突去重用例已移植到
`tests/hardening_sync.test.ts`；
`sync_r05_regression_tests` 的 4 条慢钟 DELETE/不可解析时间戳隔离/新 DELETE 对照已移植到
`tests/delete_hardening_sync.test.ts`（同文件 3 条记录级 E2EE 上传策略此前已 ported）；
`sync_pathological_tests` 的 35 条 apply/LWW/冲突/UPSERT/change_log、P20/P36性能及P40观察用例已移植到
`tests/pathological_sync.test.ts`，P.11-P.15 的 WAL/savepoint/foreign_keys/
exclusive/query_only pragma 交互 5 条已移植到
`tests/pathological_pragma_sync.test.ts`；
`sync_adversarial_tests` 的 37 条时钟/僵尸/LWW/保留期/schema/回声/注入/冲突表用例
已移植到 `tests/adversarial_sync.test.ts`；
`sync_weird_tests` 的 55 条 Unicode/数值/时间戳/JSON/HLC/批量/多连接/force-exact
用例已移植到 `tests/weird_sync.test.ts` 与 `tests/weird_batch_sync.test.ts`；
`sync_comprehensive_tests` 的 3 条 checksum、4 条 restore baseline 与 7 条 prune gap
用例已移植到 `tests/comprehensive_sync.test.ts`；
`sync_real_schema_tests` 的 11 条真实 VFS schema/FK/ref_count/复合主键用例
已移植到 `tests/real_schema_sync.test.ts`；
`sync_proptest` 6 条属性测试已用固定种子移植到 `tests/proptest_sync.test.ts`；
`sync_real_flow_smoke_tests` 的前 4 条真实迁移库往返已移植到
`tests/real_flow_smoke_sync.test.ts`；
`sync_realistic_scenarios` 的 S.01-S.15（notes/resources/exam/folder/todo/
pomodoro/essay/translation/mindmap）已用真实 F3 生产迁移替换 Rust 内联
apply harness，移植到 `tests/realistic_scenarios_sync.test.ts`。

### 证据

- `git show main:host/plugins/sync/api.ts` 包含上列已发布方法/类型；不再引用
  `ds-mig/L20-sync` 分支作为接口来源。
- 缺公开面的引用点可用 `rg 'classification|asset_filenames|AssetDirsManifest|
  delete_record_with_resolve|resolve_delete_conflict|field_merge'
  src-tauri/tests/sync_*.rs` 复核。

### 已完成的替代验证

- `CloudStorage` 的续传、截断、E2EE、manifest、坏写收敛等 L23 侧行为已有真实端口
  测试（`tests/webdav_*`、`tests/s3.test.ts`、`tests/sync_manager.test.ts`、
  `tests/e2ee_claim*.test.ts` 等）。
- provider 契约中 20 条仅依赖 L23 `CloudStorage`/`CloudSyncManager` 的用例已移植，
  保留 `DS_SYNC_TEST_DOCKER=1` 门。

## 2. L21-backup：云配置 SSOT 缺 capability 注入面（5 条）

`ctx.cloudConfig` 已由 L21 在 main 发布（`host/plugins/backup/api.ts` 的
`cloudConfigService`，实现见 `host/plugins/backup/src/cloud-config.ts`），因此不能
再说 SSOT 服务“未发布”。仍缺的是 Android/mobile-slim 能力注入：

- `createCloudConfigService` 的 `CloudConfigServiceDeps` 没有 capabilities 参数，
  `save`/`get` 固定走桌面 `DESKTOP_CAPABILITIES`；Rust 的
  `save_cloud_config_ssot_with_capabilities` /
  `load_cloud_config_ssot_with_capabilities` 没有对应的公开注入面。
- 因此 `android_ssot_rejects_ftp_on_save_and_load`、
  `build_without_s3_rejects_s3_with_user_facing_message`、
  `android_only::android_ssot_refuses_to_persist_or_load_ftp_records`、
  `android_only::android_ssot_keeps_webdav_available` 无法在本 lane 用真实服务
  验证移动能力拒绝；需要 L21 发布带 capabilities 的服务/测试钩子。
- `webdav_only_device_switch_closed_loop` 还依赖 L21 的 ZIP 导出/导入编排
  （`export_backup_to_zip` / `import_backup_from_zip_with_password`）。

## 3. 数据空间切槽 / 设备身份（9 条；切槽已闭合，身份待 F4 集成）

这两组能力不属于 L11：

- 数据空间切槽是 F3 平台能力（`ctx.storage.dataSpace` / `DataSpaceManager`，
  `host/platform/storage/data-space.ts`），启动恢复 hook 在
  `host/platform/storage/startup.ts`。
- 设备身份是 F4 平台能力（`ctx.paths.dataSpaceDeviceId()` /
  `rotateDeviceIdAfterRestore()`，`host/platform/paths/index.ts`；
  `deviceId()` 是 L20 legacy-root-first 包装，L23 不使用）。
  F4 `d85995b4b`/`679b53948` 已实现正式方法与 production logger，但未进 main；
  L23 `src/device_identity.ts` 只保留对 `paths.dataSpaceDeviceId()` 的薄调用，
  不重写 env/legacy/WeakMap/日志，也没有 optional fallback。main 集成前，
  缺失方法按编程错误 panic 传播。

本轮逐项处理：

| Rust 测试 | 去向 |
|---|---|
| `restore_writes_inactive_slot_and_switch_happens_only_after_restart` | `tests/data_space_cutover.test.ts` |
| `startup_fails_closed_when_lease_target_is_not_active` | 同上 |
| `restore_cutover_registration_guards_reject_invalid_input` | 同上 |
| `restart_guard_refuses_boot_when_lease_target_not_activated` | 同上 |
| `device_id_persists_in_app_data_dir_and_rotates_after_restore` | ported：`tests/device_identity.test.ts`，作业 `20261104102017-767a84` 通过 |
| `device_id_lives_in_app_data_dir_and_rotates_after_restore` | 同上 |
| `sync_r07_device_id_probe` | ported：`tests/device_identity.test.ts` 真实子进程探针，作业 `20261104102017-767a84` 通过 |
| `r09_device_id_probe_subprocess` | 同上：子进程断言 initial/old/new/after 与成功退出 |
| `mobile_feature_profiles_exclude_s3_backend` | `tests/sync_android_platform.test.ts`：直接读 `src-tauri/Cargo.toml`，断言两个移动 profile 不含 S3/独立 FTP、default 含 S3 |

F3 待补（X6-AP-0423）：Rust sync_android_restart.rs:647/:697 断言清空活跃槽与过早解除租约的
`ErrorKind::PermissionDenied`；F3 `data-space.ts:148/188` 抛无 kind/code 的普通 `Error`，TS 只能断言文案。
需 F3 给这两处错误带可断言的类别（如 `code: 'EACCES'` 或平台 IO 错误 kind），本 lane 不改 F3 代码。

启动恢复的业务编排（WebDAV 下载 → 写非活跃槽 → 重启切换）由 L21/F3 的恢复链路
负责；本 lane 只验证平台切槽/身份语义与云传输边界，不复制恢复编排。

## 4. L13-vfs-api：自动同步配置未发布（2 条）

`question_sync_service::SyncConfig` 没有对应服务成员，影响
`sync_r07_autosync_pending_tests::r07_autosync_config_surface_serde_contract`
与 `r07_autosync_scheduler_behavior_pending`（后者在 Rust 侧本身就是 `#[ignore]` 占位）。

## 5. 构建 profile 断言（1 条已批准 obsolete，1 条已迁移）

- `sync_android_restart::mobile_profiles_exclude_s3_and_keep_recovery_core`：
  C2 于 `bccaf6201` 逐行核实只读 `mobile-slim`/`android-release` 两个移动 Cargo
  profile，批准 **mobile-only obsolete**；该批准已由 main 的
  `migration/approvals.d/C2-platform.json` 聚合。TESTMAP 已标 obsolete，
  不再保留“分片未接通”的旧阻塞。
- `sync_android_device_switch::mobile_feature_profiles_exclude_s3_backend`：
  C2 **整条驳回** obsolete——Rust `sync_android_device_switch.rs:657-690` 还断言
  default 桌面构建启用 S3。测试直接读取 `src-tauri/Cargo.toml`：
  `mobile-slim`/`android-release` 不得含 `cloud_storage_s3` 或独立 `"ftp"`，
  `default` 必须含 `cloud_storage_s3`；同时保留运行时 `DESKTOP_CAPABILITIES`
  与移动能力矩阵断言。已标 ported。

## 6. 汇总

| 类别 | pending |
|---|---|
| L20-sync 引擎/字段合并/分类/文件名/删除解决/realistic 剩余（main 已发布多数引擎面） | 214（含 Docker 契约 42） |
| L21-backup 云配置 SSOT / 整包导出导入 | 5 |
| L13 autosync 配置 | 2 |
| **合计** | **221** |

已批准 mobile-only 的 `sync_android_restart::mobile_profiles_exclude_s3_and_keep_recovery_core`
单列为 obsolete（approval 见 `migration/approvals.d/C2-platform.json`），不计入 pending。
merge main 后该批准分片已在分支内，`migration:ledger --check --no-write` 退出码 0；
未修改聚合批准文件。

## 7. 附录：L21 共享操作守卫（P03，非 TESTMAP 计数项）

main `d5cd234aa`（合入 L21 `19c023cd6`）的 `host/plugins/backup/api.ts` 已正式导出：

```ts
interface BackupOperationGuard {
  readonly snapshot: DataGovernanceOperationSnapshot;
  operationId(): string;
  release(): void;
}
BackupService.tryAcquireOperation(kind: DataGovernanceOperationKind): BackupOperationGuard
```

以及结构化失败面 `OperationGuardError` / `OperationBusyError` /
`OperationLockError` / `OperationLockBusyError` / `isOperationGuardError` /
`OPERATION_GUARD_ERROR_CODES`。`OperationGuardError` 继承 kernel `CommandError`，
`reason`/`code`/`app_error`/`value` 在同一对象上：`busy` → `Validation`，
`lock_io` → `FileSystem`。

L23 已合并 main 并删除旧镜像 `src/backup_operation_guard.ts`，现在直接：

- 从 `../backup/api.ts` 导入 `BackupOperationGuard`、`DataGovernanceOperationKind`、
  `isOperationGuardError`；
- `acquireOperation(kind)` 直接调用 `ctx.backup.tryAcquireOperation(kind)`，让 L21
  的 `CommandError`（`value`=同形 AppError）原样穿过 kernel；
- 不再检查 `operationBusy` 布尔、不再按 `CommandError(string)` 猜锁 IO、不再维护
  可选方法类型；
- release 时只有结构化的 `isOperationGuardError`（如锁 IO）记录 warn；未知
  TypeError / 编程错误继续 panic，不把成功伪装成成功。

`DataGovernanceOperationKind` 仍为 serde snake_case；L23 upload/download/
delete_version 分别传 `backup`/`restore`/`prune`，先取 guard 再构造
storage/manager，成功、异常、取消路径都在 `finally` 显式 `release()`。

### 本轮 main 树最小复验（2026-11-04）

- 作业 `20261104072917-5b3d58`（`commands_transfer.test.ts`，`--maxWorkers=1`）：
  退出码 0，11/11 passed。直接使用 main 的 `OperationBusyError` →
  `{error_type:'Validation'}`、`OperationLockError` → `{error_type:'FileSystem'}`；
  未知 TypeError → kernel panic；成功下载仍使用 guard 的 `operationId` 并 release。
- merge 后最小集作业 `20261104073245-dca3e5`（`commands_transfer` +
  `commands_errors` + `device_identity`）：退出码 0，24 passed / 4 skipped；
  4 skipped 为 F4 身份集成测试。typecheck `20261104072935-3a9bcd` 退出码 0。
- 旧 L21 `e4dd1772f` 组合探针（`20261104070222-8acb9c`）是候选树证据，已不再作为
  当前 main 的验证依据。

## `sync_realistic_scenarios.rs` 剩余 13 条（2026-11-04 扩展移植后）

115 条中 102 条已移植（S.01-S.15、S.16-S.35、S.36-S.68 的 29 条断言用例、
S.69-S.94 的 18 条断言用例、S.96-S.115）。剩余 13 条不是移植积压，而是与生产
引擎语义或 Rust 测试专用替身冲突：

- **尚待逐项核对原调用不变量**：S.38（编辑/删除竞争）、S.47（删除/编辑竞争）、
  S.70（unlink 只打日志）、S.75（树重构只打日志）、S.85（blob 行同步只打日志）。
  A13/A33已分别获C2限定移植并执行；此处五条仍维持pending，不新增自造断言，
  也不再把“无显式assert”直接当成没有不崩溃不变量或自动obsolete依据。
- **手写 ref_count 不可表达**：S.39/S.76/S.77/S.84 先手工改 `resources.ref_count`
  再断言同步后的数字；生产 `recompute_derived_ref_counts` 在每次 apply 后按实际
  引用行重算（无引用即 0），且 `supports_counter_delta` 恒为 false。保留 pending，
  不伪造引用行去凑数字。
- **未来时钟 fail-close**：S.59 写 `2027-01-01` 的 `deleted_at/updated_at`；生产
  drift 守卫超过 `MAX_DRIFT_MS` 抛 `ClockDriftSuspectedError`，不会按 Rust harness
  的 INSERT OR REPLACE 静默写入。
- **未知表前置拒绝**：S.90 插入 `table_name='nonexistent_table'` 的 change_log；
  `enrichChangesWithData` 在查询列时即拒绝未知表，无法进入逐条 apply 的隔离路径。
- **测试专用替身**：S.91 只断言 Rust `SimulatedCloudStore` 的空下载；S.95 只断言
  Rust fixture 的按库 schema 装配，均不经过生产同步面。

验证：S.16-S.35 作业 `20261104095432-ca4163`（20/20，退出码 0）；S.36-S.68 +
S.69-S.94 + S.01-S.15 合并作业 `20261104101445-0b8779`（82/82，退出码 0）；
S.96-S.115 作业 `20261104101218-ee38b5`（20/20，退出码 0）。

## 历史：`sync_comprehensive_tests.rs::field_merge_tests` 首八条（WP-032，2026-11-06）

以下保留 WP-032 当时的证据：TESTMAP 289–296 行这 8 条维持 pending
（pending 189→189），当时 L20 没有公开的 `mergeField`。当前接口状态见置顶 WP-180。

- **Rust 原测试**（`src-tauri/tests/sync_comprehensive_tests.rs` L421–503）直接调用
  `deep_student_lib::data_governance::sync::field_merge::merge_field(table, column, Some(local), Some(remote))`，
  并断言它返回的三元组 `(value, was_merged, is_conflict)`：
  | Rust 测试（行） | 输入 | 原断言 |
  |---|---|---|
  | `test_ref_count_falls_back_to_conflict`（L421） | resources.ref_count 5 / 3 | value==3、!merged、conflict |
  | `test_ref_count_equal_is_identity`（L430） | resources.ref_count 7 / 7 | value==7、!merged、!conflict |
  | `test_ref_count_zero_identity`（L439） | resources.ref_count 0 / 0 | value==0、!merged、!conflict |
  | `test_blobs_ref_count_falls_back_to_conflict`（L448） | blobs.ref_count 10 / 3 | value==3、!merged、conflict |
  | `test_tag_union_with_overlap`（L459） | notes.tags [a,b,c] / [b,c,d] | 是数组、len==4、merged |
  | `test_tag_union_disjoint`（L472） | notes.tags [x,y] / [a,b] | 是数组、len==4、merged |
  | `test_tag_union_identical`（L485） | notes.tags [a,b] / [a,b] | !merged |
  | `test_tag_union_empty`（L496） | notes.tags [] / [] | value==[]、!merged |
- **brief 指定的 `ctx.sync.applyMergeStrategy` 不经过 `merge_field`**。Rust
  `apply_merge_strategy`（`crates/dstu-sync/src/data_governance/sync/mod.rs:4532-4603`）
  只按 `ConflictRecord` 和策略把 record_id 分到 push/pull，KeepLatest 比较时间戳。
  `rg 'merge_field\(' src-tauri/crates/dstu-sync/src` 显示 `field_merge.rs` 之外没有调用点；
  TS 的 `host/plugins/sync/src/merge.ts:152` 同样不调用 `mergeField`。它的返回值
  `MergeApplicationResult` 里没有字段值、was_merged 或 is_conflict，所以上表的断言都无法在它上面表达。
- **sync 插件的公开面里没有 `mergeField`**。`git show main:host/plugins/sync/api.ts`
  只重新导出 payload、json、sqlite-values、record-data、merge；`SyncService` 没有字段合并方法；
  `index.ts` 只有默认导出的插件。`mergeField` 只存在于内部文件
  `host/plugins/sync/src/field-merge.ts:68`，由 `repository/apply-*.ts` 内部使用。
  本 lane 不能跨 lane 引入内部文件，也不复制合并实现。
- **apply 公开路径不能代替**。`applyDownloadedChanges*` 只对
  `fieldMergeColumnsForTable(table)` 里的列调用 `mergeField`，之后只写最终行。
  `resources.ref_count` 不在 picklist 里，且 apply 后会被 `recomputeDerivedRefCountsIfRelevant`（`repository/apply-batch.ts:155`）重算；
  `blobs` 根本不在 registry 中；`merged`/`conflict` 两个标志在行数据里看不到。
  用行值推断这些标志会弱化原断言，所以不采用。
- **已有同名或近似用例不算复用**。`host/plugins/sync/tests/field-merge.test.ts` 中的
  `test_merge_field_ref_count`/`regression_m22_ref_count_is_not_auto_merged` 用的是 10/7，
  `test_tag_union`/`test_merge_field_tags` 用的是另外的标签集合；
  equal/zero identity、blobs、disjoint、identical、empty 都没有同一输入的用例。
  它们只是 `field_merge.rs` 内联测试的移植，不是这 8 条的逐条同义证据。
- **owner 行为预检（不计入 ported）**：作业 `20261105184211-ec9004`（exit 0）用一次性脚本
  直接调用 L20 内部的 `mergeField`，输入为上表的 8 组，得到
  `[3,false,true]`、`[7,false,false]`、`[0,false,false]`、`[3,false,true]`、
  `[["a","b","c","d"],true,false]`、`[["a","b","x","y"],true,false]`、
  `[["a","b"],false,false]`、`[[],false,false]`。8 组都符合 Rust 原断言，所以没有 owner 缺陷要报，
  缺的只是公开入口。该脚本不在仓库里，不能作为移植证据。
- **需要 L20 提供的接口**（由 C1 派单）：在 `host/plugins/sync/api.ts` 公开
  `mergeField(tableName: string, columnName: string, localValue: DbJson | undefined, remoteValue: DbJson | undefined): [DbJson, boolean, boolean]`，
  对应 `field_merge.rs:95 merge_field`。可以加在 `SyncService` 上，也可以照 `canonicalizeSyncValueForCompare`
  的做法从 api.ts 重新导出。发布后，本 lane 在 `tests/comprehensive_sync.test.ts` 里通过该公开面
   按上表逐条移植。WP-180 仅授权首八条，L506 起其余 field_merge 不在本包范围。
