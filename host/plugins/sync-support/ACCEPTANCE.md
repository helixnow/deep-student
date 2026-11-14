# L20b-sync-support 独立验收（R4-review-sync，2026-11-04）

结论：不通过

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。TS 路径相对 `host/plugins/sync-support/`；Rust 路径相对 `src-tauri/crates/dstu-sync/src/data_governance/sync/`。本 lane 没有 Tauri 命令：不虚构 15 条命令，改审 19 个生产服务入口。`contracts/ipc/L20-sync.json` 的命令归 L20，而非本插件注册。

**2026-11-04 定向复核更新**：固定审查 L20b 提交 `7f8b92ed7c12e7892a19efae718814445e606cce`（含 `e5e55daa5`、`21dd2e62a`、`5ab819dc1`、`06a9550f9`）。以下“必须修复”为最新状态；§1–§4 保留首次审读证据，不能将其中旧行号、35/5 统计或已修精度问题当作新提交的现状。新证据、25 个亲跑用例及反例见 §5。结论仍为不通过，六个编号组均有未决部分。

**新增候选复核（82d123466 / L10 32e423cb2）**：固定L20b `82d123466a73ee8b197f2bf561b0e0d5c42ff318`，另组合L10 `32e423cb253f845bdfaaaa225b66ad8153a37878`，与main `3b2758d7ac8e69263377ab7356206c94af9d8a24`分开。**S02六条真实apply原测试已修并关闭**；S03冲突JSON三项已修，L10候选组合修复正向CAS/INTEGER历史/props_json反例，但原树5项失败、负大整数CAS仍不精确；S04本lane已转所有者并保持事务，L20笔记主链平行写入仍未闭合；S05新增迭代路径不等于全阶段正确。当前S01/S03/S04/S05/S06五组未决，完整作业/源证据见§8。

**v2状态校正**：新标准§1.8要求合入main后复验。上述S02为候选验证通过，不能称v2已完成；固定main eeaf5bdc7仍登记六条pomodoro pending，本轮恢复S02待main签收状态，候选9/9证据保留。L10精度修复已随e60e7a771进入main，不再以“32e未main”泛称当前owner缺失；旧组合/旧main状态只对应所列SHA，新的主链复验另记。

## 必须修复

**S01正式main签收（最新，01c074ecf / ccba04837）**：已逐行核对新`tests/note-history-apply.test.ts`全部五个Rust原场景，独立source/target、默认reader/owner及真实同tx路径成立；官方主线181546-28458e中该文件5/5、本插件14文件123例全部通过。宿主已接真实F3维护注册和目录，旧worker接口缺失消失。S01按本插件生产消费与原五测试范围关闭；S04通用写者/S06 busy仍开，整体不通过。L20旧测试及其全局TESTMAP引用仍属于R4-SYNC-07，不能据本文件通过抹去，见§11。

**最新集成阻塞，算法签收按SHA保留**：fb463的官方门禁有62个notes初始化SlotOccupied，原生172008-b2036f确认first.dispose后第二宿主仍失败；不是S02/S03/S05算法断言回退。7f4 main已接disposer，真实F3顺序重装174905-f091b7通过，但本插件现有`tests/service-host.ts`的storage facade缺新notes worker使用的registerMaintenanceParticipant，175042-bd0522在首次安装即exit1。另多Host组合还有journal Slot冲突。并入S01的实际消费宿主闭环，详sync ACCEPTANCE §11；当前整体不通过，不能把677f旧绿泛称后继组合可用。已通知C2协调F3/L10/L20b，未改测试。

**main677f消费链更新**：L20已合入，官方作业20261104161616-fddb22原exit0（1758passed/20 Docker skip），其中L20 note-history15/15、support117例均通过。笔记默认reader/owner接线与整数旧反例现已主线闭环，不能继续用旧main否定；但五个原note_history场景之一的TS源/目标库fixture改变，以及通用业务/冲突平行写者仍保留在S01/S04。S06 busy握手没有新增证据，整体仍不通过。

**复核环境归因更正**：此前L20 note-history的130739-f91838收集失败，已查明是R4临时归档漏tsconfig（useDefineForClassFields=true），不是notes/L07生产实现故障。补同SHA原配置后153914-f36472五条默认hook/精度/事务测试通过；原exit1保留。此前Node生产探针及实际工作树主线门禁不受此漏归档问题影响。详sync ACCEPTANCE §9。

**正式main闭环（最新，306eb8bbb）**：固定`306eb8bbbe74ad8f225da9313d24dd8eb0a8ef40`已含cae04c341、82d所有者改动及L10负CAS修复7a6783fdb。复用亲跑主线门禁20261104142355-6832bc的pomodoro9/9、state-errors13/13、JSON5/5、integer6/6、owner事务3/3，通过源码确认本插件范围相对该门禁基线8d7b05d14无变化；另新增负CAS原反例main探针20261104144646-f3d9a4通过。**S02/S03/S05按原finding范围main签收；S01/S04/S06仍未闭合**。L20自己的旧hook/D3缺陷由R4-SYNC-01/02继续追踪，不能从support签收外推其主链通过。详§10；旧候选/失败历史不删除。

**S05新候选进展（cae04c341 / 3b7a8aa14）**：固定`3b7a8aa14bd45b33e1a2c3aa1a503ea4788c4021`，含`cae04c341ed509623ab584a8118f247866f828e0`。`repository/state.ts:84-94`已删除produced判据，只按F3 phase选择prepare/bind，其余step走row。对两个缺表prepare、游标首次/后续step和设备轮换首次step，经真实安装的syncSupport服务做5条精确错误断言，作业20261104135131-38b468 exit0。属于新代码有效修复，不再以旧首step算法描述该候选；固定main16a254adf尚不含此提交，S05待main闭环，S06不联动关闭。证据见§9。

**L20消费链后继候选2ed5f1491（非main签收）**：R4按f53290429及后继复核，L20默认hook已转notes.sync，并由syncSupport.noteHistory提供available/affectedNotes读者；无history门先返回、真实默认apply正CAS9007199254740993→9007199254740994及owner同事务故障回滚已亲核（20261104130934-9eb153、20261104131323-c945a6，均exit0，详L20 ACCEPTANCE §5）。不能再用eeaf“候选仍平行写笔记”覆盖这个进展。L10负CAS实现未变，不重复旧失败；L20通用业务写者及support主线自身改动仍分开判定，S01/S03/S04总框不关闭。L20查询阶段六例通过是其自己的readList实现，不替support S05/S06签收。该L20候选非固定main44b66353c祖先。

**正式main补核eeaf（本轮最新）**：已完成L20补审，详见`docs/dev/electron-migration/audits/R4-review-sync.md` 末节「原 host/plugins/sync/ACCEPTANCE.md 全文无损迁入」（原路径已按2026-11-05授权迁入，不再单独存在）。真实F4+F3+notes/vfs-repos/sync-support/sync同kernel探针20261104112304-515659确认：默认apply仍用L20自有hook，正大整数CAS被误拒绝；正式notes owner负大整数CAS仍舍入。S01/S03/S04未闭合已不只是旧候选推测。L20 TESTMAP实际211ported/47pending/5obsolete，其中11条note/pomodoro原测试映射到L20自身；support表28ported/12pending不能当作全链没有这些测试，亦不能凭L20标ported代替main运行。原样main命令测试fixture缺dataSpaceDeviceId，在正式F4已提供API的情况下仍装宿主失败。S02本轮维持待main行为签收，不再以支持方表头单独判定实现不存在。

**后续4c15a5c8e/301ab4267交接**：亲取实现者已有作业20261104112222-1c0a5d，原exit1、13文件（12过/1失败）、114passed/2failed、无额外Unhandled Errors，两失败仍是missing-table prepare前缀；未重跑。相对已审82d，生产实现无变化，仅测试宿主补paths.dataSpaceDeviceId与报告/账本说明。上述两SHA及82d、L20 hook候选522dfea98均非固定main4c6cd1ba8祖先，不能把“使用正式main notes的候选宿主测试”说成“support修改已合main”。正向owner原反例通过与本轮负i64/默认apply失败可以同时成立；S05首step以是否已produced判query的算法也未变，不能仅等F3 prepare phase就整体关闭S05；S06真实busy握手仍pending。

- [x] **S01 本插件实际消费及五条原note_history测试main复核签收。** 新`tests/note-history-apply.test.ts`以一个真实应用owner和两个独立迁移库按Rust原角色运行，默认sync→support reader→notes writer且同tx；五例全部主线通过，本插件TESTMAP:54-58指向这个文件，不再用旧函数级测试承担原集成凭证。L20旧同源fixture偏差及双Host问题仍在其07下保留，本签收不外推S04跨表所有权或整个L20验收。
- [x] **S02 正式main复核签收：六条原apply测试恢复真实生产调用。** main的`tests/service-host.ts:14-19`安装真实sync/notes/vfs-repos/sync-support，外部空端口不替代行级apply；`tests/pomodoro-counts.test.ts:154-166,182-194,204-215,226-228,239-243,255-263`调用公开host.sync.applyDownloadedChanges，不自写UPSERT/模拟Delete。Rust `pomodoro_counts.rs:289-562`的双设备2+3、删除不复活、重放、换绑归零、远端Delete、success_count=1/failure_count=1均保留；本文件与82d已审测试无差异。主线门禁20261104142355-6832bc中该文件9/9通过，整体exit1来自别的suite，不改写为全绿。此签收不替S01/S04笔记整链签收。
- [x] **S03 正式main复核签收：本插件公开服务及notes owner的已记录整数/JSON反例均已修。** 既有主线JSON5例与INTEGER6例全部通过，负CAS再由20261104144646-f3d9a4针对新7a6783fdb亲验。范围限定本组原support/owner反例；L20旧本地hook、field merge、pending/echo问题仍在独立R4-SYNC-02，不被本组勾选覆盖。
  - **82d更新**：以下7f8通过项/旧反例保留历史，不能用旧“自写JSON.parse仍在support”描述新代码。82d `src/json.ts:1-16,28-50` 已消费L20 api.ts的无损parser/比较/序列化，toWireJson保留DbJson；本轮三条conflicts相邻大整数JSON反例均通过，见新增子项。
  - [x] **复核确认**：六类 state 整数 SELECT 在读取前启用 safeIntegers（`repository/state.ts:91-115,130-160`）；亲跑覆盖 2^53+1、i64::MAX、max 单调性/饱和及同 operation 重试（`tests/integer-precision.test.ts:10-30`）。Rust `state.rs:155-200,224-289,312-442`。
  - [x] **复核确认**：普通记录及 questions 兼容读取均启用 safeIntegers（`repository/records.ts:179-189,237-245`）；CAS 用 bigint checked_add 到 i64::MAX、echo pre-log max 保持 bigint（`src/note-history.ts:182-189`、`src/pomodoro.ts:39-44`、`repository/pomodoro.ts:19-21,49-54`），原测试直接整数边界通过。Rust `note_history.rs:102-114`、`pomodoro_counts.rs:99,134-143`。
  - [x] **复核确认**：内部 API 允许 bigint、toWireJson 不再转 Number、数组/对象 SQL JSON 写入使用 stringifyJson（`api.ts:16-24`、`src/json.ts:41-62`、`repository/note-history.ts:98-115`）。真实平台库与安装后的公开服务测试覆盖依赖载荷、冲突比较/快照参数/原始 JSON 落库、旧 echo 不误标（`tests/integer-precision.test.ts:50-108`）。该项只证明 L20b 内部边界；L20 编码消费仍随 S01 待接。
  - [x] **82d冲突JSON反例已修**：`tests/json-text-precision.test.ts:29-70` 通过真实服务验证不同hash、resolveOne识别/精确保留快照、两条不同冲突均落库且重复才去重；Malformed冲突JSON字符串回退仍保留（`:12-26`）。Rust `conflict_resolver.rs:525-561`。
  - [x] **原82d三个owner反例已在main复验通过**：不同props_json拒绝、正CAS精确递增、相同INTEGER历史重放均由主线json-text-precision/integer-precision原断言验证。旧20261104083351-f20459及301570的失败保留，不能用新main结果覆盖其exit1。
  - [x] **叠加L10 32e423cb2的候选修复已核实**：`notes/repository/sync.ts:20-28,78-87,154-158,219-225` 使用safeIntegers与共享lossless比较；同一kernel组合的正向CAS/i64MAX、INTEGER历史和props_json不变量通过，且owner事务回滚通过（作业20261104083352-6f6575，5passed，exit0）。该L10提交未入固定main3b。
  - [x] **有符号下界main已修**：7a6783fdb使`notes/repository/sync.ts:158-160`仅在双边安全范围转Number。固定main306原样快照，经真实syncSupport.noteHistory.prepareRelation与notes owner，-9007199254740994n+1得到bigint -9007199254740993n并严格相等断言通过（20261104144646-f3d9a4，exit0）。Rust `note_history.rs:102-114`的i64 checked_add与无正数CHECK约束依据不变；旧226c92舍入证据仅属旧树。
- [ ] **S04 本lane的所有者委托已接通，但整条L20笔记链的单写者仍未闭合。** 首次直接写notes/todo的证据保留§1–§5；82d不再保留这些support写SQL。当前判定依据是下方真实owner事务结果与L20平行笔记仓储，不以公开SqlExecutor参数本身否决。Rust对照 `note_history.rs:118-149,153-257`、`pomodoro_counts.rs:90-145`。
  - [x] **82d本lane写者已转交**：旧上段指首次基线。当前repository/note-history.ts仅SELECT，repository/pomodoro.ts删除；`src/note-history.ts:80-87,98-103,160-162` 经notes.sync/revisions，`src/pomodoro.ts:11-29` 经vfsRepo.pomodoros批量方法，传同一个SqlExecutor。真实owner的spy仅观察、不stub；notes/关系/计数/推断格式在同事务写入、后续失败全部回滚，3个用例通过（owner-transactions.test.ts:12-85）。
  - [ ] **整链通用写者仍未收敛**：main677f笔记专用hook已委托notes.sync，不再有旧本地formats/revisions/关系业务副本；但L20 `apply-record.ts`通用UPSERT与`apply-refcounts.ts`仍直接写业务/资源/索引表，且本地conflict仓储写正式归support的__sync_conflicts。依据是实际写者，不是SqlExecutor参数；详R4-SYNC-01。S03原owner精度反例已签，不再把该旧缺口混入当前S04。
  - **D1/D4裁定对齐（main e303957124）**：允许表所有者发布带可选SqlExecutor的业务 `*WithConn` 方法，由调用者开启原子事务并传递同一连接；不因公开连接参数本身否决。S04保留的依据是上述消费者实际执行他表写SQL及重复实现，验收应检查真正写者、同一事务和回滚，而不是要求拆成独立提交或禁止连接接缝（`decisions.md:106-110,123-124`）。
- [x] **S05 正式main复核签收：BEGIN/COMMIT/列解析及prepare/bind/step上下文按原finding闭环。** cae04c341已main，state-errors13例全过；F3正式phase被生产stateRows消费，首次及后续next不再按是否yield猜query。旧非零结果与错期望分析保留历史，见§10。
  - [x] **复核确认**：`src/state.ts:232-249` 在 callback 正常结束后切换提交阶段；reserve/rotation/purge 保留各语句自身上下文（`:130-145,210-228`）。三个真实延迟外键 COMMIT 失败用例验证正确文案、全部写入回滚、游标仍为7和随后重试成功；BEGIN 嵌套失败保留调用者事务，SELECT 失败未泄漏事务（`tests/state-errors.test.ts:5-58`）。亲跑9用例通过。Rust `state.rs:236-285,498-518,531-549`。
  - [x] **复核确认**：cursors 的设备/序号列及 deviceRotations 的文本列现在单独校验和报错（`src/state.ts:148-154,187-196,264-278`；`tests/state-errors.test.ts:60-81`）；真实 SQLite Text/Blob 错列测试通过。Rust `state.rs:299-305,432-437`。
  - [x] **prepare主线已闭合**：正式F3提供phase，stateRows按prepare映射“读取…”，两个DROP表原失败断言在主线13例中通过。原82d缺phase的301570失败保留，不再列为当前main阻塞。
  - [x] **首次step错分主线已修**：cae04c341删除produced条件，bind才用query，execute走row。主线`state-errors.test.ts:104-130`首次/后续游标overflow及轮换首step断言通过，与Rust state.rs:424-430及rusqlite0.40.1只bind的query语义一致。
- [ ] **S06 虚假 ported 已撤回，真实 busy 握手仍缺。** 新测试仍只等 300ms 后提交，再校验最终序号；不能证明 worker 已争锁。Rust `state.rs:620-659` 通过 busy_handler waiting 信号确认争用后才释放写者。
  - [x] **复核确认撤回**：`7f8b92ed7` 的 `TESTMAP.md:54,79` 改 pending；`tests/state.test.ts:25,47-51` 明示 final-sequence only，worker 使用真实平台库及公开服务（`tests/state-worker.ts:6-16`）。
  - [ ] F3 的实际 SQLite busy 通知/释放测试能力及原读前等待保证尚未验证；补充用例通过不能关闭本项。

## 建议

- [x] **复核确认文档修正**：`7f8b92ed7:TESTMAP.md:7-8,61-63` 区分 40 条 Rust 映射（28 ported/12 pending）与 81 个参数化/补充 TS 用例；本轮只亲跑最小集25例，未将实现者报告的81例计作本次全套验证。
- [x] **按D1/D4修正建议**：不再把公开业务方法中的SqlExecutor参数本身列为问题。所有者的 `*WithConn` 接缝受批准；调用方仅传递连接、不得借此执行任意SQL。S04按真实表写入所有权与事务边界验收。

## 已核实通过

本段保留首次基线 `f23c98702` 的核实结果；`7f8b92ed7` 的通过子项与亲跑结果见上方各编号及 §5。

- [x] 首次基线的 67 个 TS 用例亲自运行通过；不是从 REPORT/SPEC 采信。结果不能消除 S02/S06 的断言缺口。
- [x] `syncSupport` lowerCamelCase 名称、`1.0.0` 描述、meta.provides 与实际 provide 一致（`api.ts:21-22`、`index.ts:40-60`）。
- [x] 事件序号确实使用 BEGIN IMMEDIATE，写游标/发布序号/水位的 SQL 使用 max 保持单调（`src/state.ts:132-146`、`repository/state.ts:97-103,135-155`；Rust `state.rs:183-197,236-285,342-355,399-412`）。精度及错误阶段仍见 S03/S05。
- [x] 生产 SQL 位于 repository；扫描 24 个生产 TS 文件，未发现 console、跨插件非 api.ts 导入或测试替身导入。跨插件接口引用见 `api.ts:14-16`。
- [x] tombstone 的坏时间跳过、manifest 回读失败不删 legacy、缺权威快照不裁剪，在下面抽查中保持原断言。
- [x] `src/pomodoro.ts:77-82` 的忽略 echo 更新失败有真实 Rust 无日志 `let _ =` 依据（`pomodoro_counts.rs:134-143`），不误报为丢 warn。

## 1. 服务等价逐项审读（19 项）

状态存储由 `index.ts:51-60` → `src/service.ts:15-20` 发布。表中“通过”限定该函数已核查的逻辑；整 lane 的消费链问题 S01 仍成立。

| 服务方法 | 结论与 TS 证据 | Rust 对照 |
|---|---|---|
| state.bindInstance | 通过：读取再比较 provider/hint，同值不写，异值 Network；`src/state.ts:73-88` | `state.rs:119-153` |
| state.getTombstoneWatermark | 问题 S03；缺行=0/负数夹零逻辑正确，`src/state.ts:90-94` | `state.rs:155-173` |
| state.setTombstoneWatermark | 通过写入分支：u64→i64 饱和、SQL max，`src/state.ts:96-106`、`repository/state.ts:97-103` | `state.rs:175-200` |
| state.reserveTombstoneEventSeq | 问题 S03/S05；委托 existing=null 正确，`src/state.ts:108-118` | `state.rs:204-220` |
| state.reserveTombstoneEventSeqWithExisting | 问题 S03/S05；IMMEDIATE、幂等、existing>0 优先正确，`src/state.ts:120-151` | `state.rs:224-289` |
| state.deviceRotationsForNew | 问题 S05；tuple 列形状正确，`src/state.ts:154-157` | `state.rs:291-309` |
| state.nextUploadSeq | 问题 S03；max(local,cloud)+1 饱和且不写，`src/state.ts:160-166` | `state.rs:312-333` |
| state.markPublishedSeq | 通过写入分支：取 max、不回退，`src/state.ts:168-171` | `state.rs:335-358` |
| state.publishedMaxSeq | 问题 S03；缺省零正确，`src/state.ts:173-177` | `state.rs:360-372` |
| state.getCursor | 问题 S03（已实测），`src/state.ts:179-183` | `state.rs:374-390` |
| state.setCursor | 通过写入分支：饱和/max/时间格式，`src/state.ts:185-188` | `state.rs:392-415` |
| state.cursors | 问题 S03/S05；Map 形状符合内部 HashMap，`src/state.ts:190-195` | `state.rs:417-442` |
| state.isLegacyProcessed | 通过：存在布尔、缺行 false，`src/state.ts:198-202` | `state.rs:444-462` |
| state.markLegacyProcessed | 通过：INSERT OR IGNORE、不重复，`src/state.ts:204-207` | `state.rs:464-478` |
| state.recordDeviceRotation | 问题 S05；事务内历史/消费游标/legacy/水位、保留上传序号正确，`src/state.ts:209-222` | `state.rs:491-521` |
| state.resetDefaultAfterLocalPurge | 问题 S05；五表清理且保留 upload_seq/event_publish 正确，`src/state.ts:224-237`、`repository/state.ts:195-202` | `state.rs:528-552` |
| pomodoroCounts.recompute | 问题 S03/S04；计数口径、IS NOT、归零、echo 抑制一致，`src/pomodoro.ts:55-83`、`repository/pomodoro.ts:10-50` | `pomodoro_counts.rs:90-145` |
| noteHistory.prepareRelation | 问题 S03；locator/type 先验、CAS +1 的顺序正确，但上限改变，`src/note-history.ts:139-188` | `note_history.rs:77-115` |
| noteHistory.retargetNoteRelations | 问题 S01/S04；缺 parser 即拒绝；Rust 实际调用 NoteRelationRepo，`src/note-history.ts:192-242` | `note_history.rs:118-149` |

## 2. ported 测试真实性抽查（25 条）

TS `tombstone`/`pomodoro`/`state` 分别指 `tests/tombstone.test.ts`、`tests/pomodoro-counts.test.ts`、`tests/state.test.ts`；Rust 对应 `tombstone.rs`、`pomodoro_counts.rs`、`state.rs`。映射见 `TESTMAP.md:15-30,45-54`。

| Rust 测试名 | TS:行 / Rust:行 | 结论 |
|---|---|---|
| test_prune_tombstones_retains_expired_without_authoritative_snapshot | tombstone:142 / tombstone.rs:1740 | 通过：旧/新均保留、removed=0 |
| watermark_never_filters_same_millisecond_or_clock_rewind_tombstones | tombstone:153 / tombstone.rs:1772 | 通过：blob/asset/workspace 三类 |
| malformed_tombstone_manifest_fails_closed | tombstone:177 / tombstone.rs:1817 | 通过：生产 decoder 拒绝并含未推进水位 |
| test_find_blob_by_hash | tombstone:221 / tombstone.rs:1829 | 通过：真实临时目录、非法/缺失 hash |
| test_blob_tombstones_roundtrip | tombstone:240 / tombstone.rs:1854 | 通过：生产 normalizer 解析后数量/设备相同 |
| immutable_event_identity_and_key_are_stable | tombstone:261 / tombstone.rs:1872 | 通过：生产 hash/key/parser，序号与回读 |
| per_device_tombstone_manifests_reread_after_put | tombstone:292 / tombstone.rs:2027 | 通过：原 source-lock 转三类上传实际行为检查 |
| upload_blob_tombstones_fails_when_reread_mismatches | tombstone:337 / tombstone.rs:2048 | 通过：损坏失败且 legacy 保留 |
| upload_blob_tombstones_fails_when_missing_after_put | tombstone:350 / tombstone.rs:2092 | 通过：缺失不得成功 |
| bad_or_future_deleted_at_is_skipped_and_never_advances_watermark | tombstone:359 / tombstone.rs:2125 | 通过：只有效项推进 |
| apply_blob_tombstones_skips_bad_clock_entries_without_failing_batch | tombstone:387 / tombstone.rs:2178 | 通过：实际文件删除/保留/affected |
| event_watermark_stops_before_bad_clock_event | tombstone:423 / tombstone.rs:2235 | 通过：生产 after 路径选 1/3、水位停 1 |
| download_blob_tombstones_after_excludes_bad_entries_from_merge_and_watermark | tombstone:444 / tombstone.rs:2284 | 通过：剔除 future、完整 device 水位 |
| tombstone_watermark_source_uses_content_device_id | tombstone:462 / tombstone.rs:2342 | 通过：新旧 key、一致/不一致设备 |
| download_blob_tombstones_after_reads_legacy_raw_name_as_same_device | tombstone:472 / tombstone.rs:2373 | 通过：legacy 与同一设备水位 |
| td02_two_devices_2_plus_3_converge_to_5 | pomodoro:168 / pomodoro_counts.rs:289 | 问题 S02：自写 apply 替代真实管线 |
| td02_remote_tombstone_delete_does_not_resurrect_count | pomodoro:197 / pomodoro_counts.rs:366 | 问题 S02：没有原字段冲突合并路径 |
| td02_repeated_apply_is_idempotent | pomodoro:226 / pomodoro_counts.rs:416 | 问题 S02：只验证测试内 UPSERT 幂等 |
| td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo | pomodoro:246 / pomodoro_counts.rs:466 | 问题 S02：换绑落库由测试代码完成 |
| td02_remote_delete_operation_zeroes_count | pomodoro:261 / pomodoro_counts.rs:494 | 问题 S02：测试手动 UPDATE deleted_at |
| td02_partial_apply_with_quarantined_change_reflects_committed_rows_only | pomodoro:291 / pomodoro_counts.rs:532 | 问题 S02：无隔离、无 success/failure_count |
| td02_recompute_scope_idempotency_and_echo_suppression | pomodoro:307 / pomodoro_counts.rs:571 | 通过：真实 SQL/trigger、NULL/漂移缓存、无 echo、第二次无写 |
| td02_recompute_skips_databases_without_todo_tables | pomodoro:361 / pomodoro_counts.rs:666 | 通过：缺表生产路径 |
| tombstone_event_sequence_is_monotonic_and_idempotent | state:15 / state.rs:579 | 通过：1/重复1/云max7→8 |
| tombstone_sequence_waits_for_writer_before_reading | state:26 / state.rs:597 | 问题 S06：缺争用握手 |

实际 TESTMAP：ported 35、pending 5、merged/obsolete 均 0；没有需要核销的 obsolete/merged 批准项。不能把 S02 的六条继续算作完整移植。`migration/approvals.json` 不包含免除这些断言的批准。

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/sync-support
 Test Files  8 passed (8)
      Tests  67 passed (67)
   Duration  4.19s
exit=0
$ node scripts/electron-migration/importable.mjs host/plugins/sync-support/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane sync-support
合计 ported 35，其中所测模块未从 index.ts 接入 0（0.0%）
```

日志：`/tmp/opencode/R4-sync-support-vitest.log`。另以真实 `Connection(':memory:')` 与 `SqliteSyncStateStore` 执行一次精度探针（未编译/运行 Rust、未修改实现/测试）：

```text
state cursor input= 9007199254740993 readback= 9007199254740992
```

## 4. 语义差异与平台差异

- **缺陷（应修）**：S01–S06；包含消费链、测试替身、整数精度、表所有权、错误阶段和争用测试证明不足。
- **已登记的平台差异**：`SPEC.md:43-46` 记录 bigint 与平台时间；`docs/dev/electron-migration/decisions.md:52-59` 接受生成时间精度/SQLite 平台差异。这不等于批准 S03 的整数截断。`SPEC.md:44` 对业务列精度损失的自述只是登记，未见批准。
- **无误报项**：同步方法在 Node 同一调用栈内不需要复制 Rust Mutex；事件序号已有数据库 IMMEDIATE 事务。无日志的 Rust `let _ =` 可保留，不能一律改成抛异常。
- **B 级状态**：单元测试全绿、importable/wiring 全绿均属实，但未闭合消费链与移植真实性，B 不成立。

## 5. C2 指定修复定向复核（2026-11-04，7f8b92ed7）

### 判定范围

先执行了 `git show ds-mig/L20b-sync-support:host/plugins/sync-support/TESTMAP.md` 和同路径 SPEC.md，再核对指定检查点及实际源码/测试。读取时分支曾从 7f8b92ed7 移动到新的整合提交，因此本轮所有新行号、测试及结论**固定到 7f8b92ed7**，不混用后续分支内容。SPEC/报告只用于定位待查声明，不作为通过证据。

| 编号 | 本轮独立判定 | 下一步 |
|---|---|---|
| S01 | 保持未关闭：固定提交的 L20 中检索 syncSupport 无命中；notes/api.ts:63-70 仍无 blocks | L20/L10 接入真实消费链 |
| S02 | 撤回虚假 ported 已确认；原六条集成未迁完 | 真实 apply/隔离/重放，不把 fixture SQL 当 apply |
| S03 | **部分修复**：state/records/CAS/echo/内部 bigint 通过；JSON 文本比较反例仍成立 | 无损解析 JSON 文本及补真实语义回归；L20 编码接线随 S01 |
| S04 | 保持未关闭：表所有者写 API 未接，平行 SQL 仍在 | 所有者 API 与去重实现 |
| S05 | **部分修复**：BEGIN/COMMIT/列解析通过；prepare/bind-query/step 仍未闭合 | F3 阶段信息与 L20b 错误映射 |
| S06 | 撤回虚假 ported 已确认；真实 busy 通知仍缺 | 原等待握手保证，不能仅 final-sequence |

S03 的新反例是原精度组的剩余范围，不新增编号、不以测试通过掩盖差异。S01/S04 未因局部测试绿而勾选。

### 亲跑最小集

从 R4 工作树执行命令，把 `git archive 7f8b92ed7` 的 host/contracts/测试配置等原样解包到 `/tmp/opencode/R4-L20b-7f8b92ed7-1CZ8h7`，仅作为固定提交的测试副本；node_modules 引用既有依赖，关闭 Vitest cache。没有切换分支、合入实现、修改任一实现/测试文件或写入其它 lane 工作树。

首次副本遗漏根 tsconfig 引用的 `tsconfig.node.json`，4 个 suite 在收集前报 `TSConfckParseError ... ENOENT ... tsconfig.node.json`，`Tests no tests`、exit=1。补入**同提交原文件**后运行成功；这个测试副本准备错误不归因于 L20b。

实际命令（cwd 始终为 R4 工作树）：

```sh
node node_modules/vitest/vitest.mjs run \
  --root /tmp/opencode/R4-L20b-7f8b92ed7-1CZ8h7 \
  -c /tmp/opencode/R4-L20b-7f8b92ed7-1CZ8h7/vitest.host.config.ts \
  --no-cache --maxWorkers=1 \
  host/plugins/sync-support/tests/integer-precision.test.ts \
  host/plugins/sync-support/tests/state-errors.test.ts \
  host/plugins/sync-support/tests/pomodoro-counts.test.ts \
  host/plugins/sync-support/tests/state.test.ts
```

原始输出摘要：

```text
 RUN  v3.2.7 /tmp/opencode/R4-L20b-7f8b92ed7-1CZ8h7
 ✓ host/plugins/sync-support/tests/integer-precision.test.ts (5 tests) 1084ms
 ✓ host/plugins/sync-support/tests/state.test.ts (2 tests) 1522ms
 ✓ host/plugins/sync-support/tests/pomodoro-counts.test.ts (9 tests) 1737ms
 ✓ host/plugins/sync-support/tests/state-errors.test.ts (9 tests) 1751ms
 Test Files  4 passed (4)
      Tests  25 passed (25)
   Start at  12:38:26
   Duration  3.66s
exit=0
```

这25例包含14个新精度/错误阶段回归及11个相关状态/重算用例。逐读 `tests/service-host.ts:1-20`，确认被测模块来自安装后的 index.ts、存储为真实 F3 SqliteDatabase；notes 在测试侧提供，未证明完整 L10/L20 集成。COMMIT 测试真实触发 `DEFERRABLE INITIALLY DEFERRED` 外键约束，不是 mock transaction 抛异常。

### S03 剩余缺陷：公开服务定向反例

使用同一固定快照的 `tests/service-host.ts::serviceHost()`（真实 F3 + 已安装插件），没有修改或增加测试文件。输入：

```ts
const low  = { id: 'r', props_json: '{"counter":9007199254740992}' };
const high = { id: 'r', props_json: '{"counter":9007199254740993}' };
```

1. 调 `conflicts.computeDataHash(low/high)`，两个 hash 相同。
2. 真实内存库建 `items(id TEXT PRIMARY KEY, props_json TEXT)`，插入 low；`__change_log(table_name, record_id, sync_version)` 插入 `('items','r',0)`。通过 `conflicts.createResolver('keep_cloud', historyPort)` 对 high 的 Update 调 resolveOne，得到 null。historyPort 仅提供固定 batch/成功快照，实际冲突判定未替换。
3. 同一 record/side，先后调用 `conflicts.saveConflictRecord` 保存 low/high，得到 true/false，第二份不同内容错误地被去重。
4. 使用既有 `MINIMAL_NOTES_SCHEMA`，构造合法 `markdown-legacy` 历史版本（version_id=v、note_id=n、title=t、content_md=body、tags_json/asset_refs_json='[]'、source=remote_sync、created_at='2026-11-04T00:00:00Z'、format_version=1、serializer_version=markdown-v1、props_json=low.props_json）。调用公开 noteHistory.applyRevision 插入后，以相同 v 只改 props_json=high.props_json，再次调用被接受。测试侧 notes 仅负责固定格式检查；整数文本相等判定来自被测生产 `jsonFieldEquals`。

原始输出：

```text
adjacent JSON-text hashes equal: true
different JSON-text resolveOne: null
different JSON-text conflict inserts: true false
changed immutable props_json: ACCEPTED
```

Rust 静态对照：`conflict_resolver.rs:525-561` 使用 serde_json::from_str<Value>，该数仍在 i64 域内，两个 Value 不等；`note_history.rs:222-235` 应产生 `Immutable history conflict: v (props_json)`。这不是超过 JS 精度后的前端显示问题，而是已存 SQLite JSON 文本被错误归一化，直接影响冲突和不可变校验。新5条整数测试仅覆盖 INTEGER/直接 bigint，没有覆盖此路径。

### S05 剩余阶段反例

对上述真实 serviceHost 数据库执行 `DROP TABLE consume_cursor` 后调 `state.cursors('i')`：

```text
cursors missing-table prepare error: Database error: 查询消费游标失败: no such table: consume_cursor
```

Rust `state.rs:419-423` 的 prepare 失败前缀应为“读取消费游标失败”；列解析修复不解决这个问题。bind/query 和 step 仍被 all 统一封装，详见 S05 子项。

**最新统计**：`7f8b92ed7:TESTMAP.md` 逐行确认 ported=28、pending=12、merged=0、obsolete=0；本轮不运行或继承实现者的全套81例结果，也不重复 L21/L23 全套。B 级仍不成立。

## 6. 合并架构裁定（main e303957124）

经授权合并 `e303957124ac220f55bee1b04cca5d3937983b92`。S04采用D1/D4的所有者 `*WithConn` 同事务接缝标准，上方建议已修正；实际消费者写他表的证据未改变，S04不关闭。

D3（`decisions.md:118-121`）区分Host内部精确值与IPC JSON number。S03反例输入是SQLite TEXT中的原始JSON字符串，错误发生在内部比较/hash/去重/历史不可变校验，不是IPC数值舍入，不能列为允许的平台差异。state/直接bigint等已修子项保留勾选，JSON文本缺口仍未决。quality §10沿用生产入口、原断言及Errors/退出码要求；没有重复25例求绿。合并门禁见汇总文档的本次合并节。

## 7. 新所有者接缝的复核基线（9c13dfc39）

固定main `9c13dfc39f2c29aaffda6c61f7dedee2273197f5` 已有 `notes.sync`/`format.blocks`（`host/plugins/notes/api.ts:70-99`）及L11 `pomodoros.recomputeCompletedPomodorosForSyncBatch`（`host/plugins/vfs-repos/api.ts:360-370`）。此前S01/S04中“接口尚未发布”只适用于当时7f8b/e303基线，不能据此断言新main仍无接口。新消费提交尚需独立验证，S01/S04不只因方法存在而勾选。

已只读核实9c13所有者 `host/plugins/notes/repository/sync.ts:81-90` 仍用JSON.parse比较JSON文本；`:157-159` 的revision由无safeIntegers读取后转BigInt；`:223-229` 的本地history读取也未显式safe整数。这是后续S03/S04联合复核的源码基线，不是新owner已亲跑的结论。需在实际消费树上同时验证：写SQL只在所有者、同一传入事务/回滚保持、相邻大整数JSON不误合并、CAS覆盖i64范围、不可变历史不放过不同字段。不能因搬走本lane SQL而将这些不变量遗留在所有者。

本次不重复既有25例；原S03动态反例明确仍属于7f8b，不冒充9c13 notes的运行结果。所有者风险由C2派C1/L10，本文件不修改对方实现。

## 8. S02/S03/S04/S05 新候选复核（82d123466 + L10 32e423cb2）

### 固定树与测试真实性

L20b固定 `82d123466a73ee8b197f2bf561b0e0d5c42ff318`（含本轮指定修复）；L10候选固定 `32e423cb253f845bdfaaaa225b66ad8153a37878`；main可见性固定 `3b2758d7ac8e69263377ab7356206c94af9d8a24`。后两候选祖先检查均未进入该main。原样快照：

- 纯82d树：`/tmp/opencode/R4-S-82d123-pZONeO`。
- 同kernel组合：`/tmp/opencode/R4-S-82d-L10-32e-qpg2DJ`，只将notes目录原样替换为32e，未修改任何实现/测试。

`tests/service-host.ts:5-19` 安装真实notes/vfs-repos/sync-support；需要apply时再装真实sync，F3为真实SqliteDatabase。提供的backup/syncProvider等空端口不在这些row-apply路径调用，未替换被测apply/owner逻辑。`owner-transactions.test.ts` 的vi.spyOn不提供mockImplementation，只观察真实owner方法接收的同一tx，且验证实际数据库值及回滚，不是只比调用次数。

### 亲跑作业（全局队列，无重复提交）

统一命令：`node <R4>/node_modules/vitest/vitest.mjs run --root <固定快照> -c <快照>/vitest.host.config.ts --no-cache --maxWorkers=1`，按下表选文件/标题。

**20261104083351-f20459**：纯82d的pomodoro-counts、json-text-precision、owner-transactions。

```text
 ✓ host/plugins/sync-support/tests/owner-transactions.test.ts (3 tests) 1201ms
 ❯ host/plugins/sync-support/tests/json-text-precision.test.ts (5 tests | 1 failed) 1724ms
   × applyRevision rejects a changed immutable JSON integer before upgrading the pin
     → expected [Function] to throw an error
 ✓ host/plugins/sync-support/tests/pomodoro-counts.test.ts (9 tests) 2809ms
 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 16 passed (17)
   Duration  16.67s
[作业 20261104083351-f20459] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104083351-f20459.log
```

**20261104083351-301570**：纯82d的state-errors、integer-precision，标题过滤 `missing-table|first execution|prepare_relation|real notes owner`，不重复旧BEGIN/COMMIT/状态游标全套。

```text
prepare_relation: expected 9007199254740993n to be 9007199254740994n
real notes owner: identical INTEGER history replay threw Immutable history conflict: v (content_bytes)
cursors missing-table: expected 读取消费游标失败, got 查询消费游标失败
device rotations missing-table: expected 读取设备轮换历史失败, got 查询设备轮换历史失败
 ✓ cursors separates first execution failure from failure after a yielded row
 Test Files  2 failed (2)
      Tests  4 failed | 1 passed | 13 skipped (18)
   Duration  14.25s
[作业 20261104083351-301570] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104083351-301570.log
```

**20261104083352-6f6575**：组合32e notes后，仅选变化相关的props_json、owner CAS/INTEGER历史和两条owner事务用例（过滤 `applyRevision rejects|prepare_relation|real notes owner|passed transaction|inferred format`）。

```text
 ✓ host/plugins/sync-support/tests/json-text-precision.test.ts (5 tests | 4 skipped) 677ms
 ✓ host/plugins/sync-support/tests/owner-transactions.test.ts (3 tests | 1 skipped) 879ms
 ✓ host/plugins/sync-support/tests/integer-precision.test.ts (6 tests | 4 skipped) 964ms
 Test Files  3 passed (3)
      Tests  5 passed | 9 skipped (14)
   Duration  14.26s
[作业 20261104083352-6f6575] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104083352-6f6575.log
```

skipped均为明确标题过滤，不是删除失败。三次没有额外Unhandled Errors行；有5个真实断言失败的两个原树作业完整保留exit1。组合通过只属于该候选组合，不能改写原树结果或声称main已修。

### 坏JSON语义：严格历史与宽松冲突比较不能混用

已逐行对照Rust：

- `note_history.rs:213-235` 在入库前解析props_json，比较已有 `*_json` 字段时 `serde_json::from_str(...).map_err(error)?`，坏本地JSON应报Database错误，**没有原字符串回退**。因此L10 `repository/sync.ts:78-87` catch→DatabaseError的分支方向正确，不误报为吞掉Rust回退。
- `conflict_resolver.rs:552-559` 是 `if let Ok(parsed)`，坏JSON回退原字符串；82d `src/json.ts:28-39` 保留这个不同的分支。

对同kernel候选组合通过公开syncSupport服务做作业 **20261104085310-226c92**：插入合法历史后将本地props_json改为 `{invalid`，再重放；另调用冲突规范化的坏字符串，最后验证有符号CAS下界。

```text
malformed stored history= SyncSupportError Database error: Expected property name or '}' in JSON at position 1 (line 1 column 2)
malformed conflict fallback= {"props_json":"{invalid"}
negative CAS expected=-9007199254740993 actual= -9007199254740992 type= number
[作业 20261104085310-226c92] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104085310-226c92.log
```

这是捕获并打印的观察探针，exit0不等于所有观察符合Rust。前两项分支方向正确（未签JSON库文案逐字一致）；第三项是候选owner仍存在的D3精度缺陷。真实note_learning_relations.revision迁移列无正数CHECK（V20260922:39-49），Rust按i64 checked_add，不能仅看正向i64MAX测试绿就宣称全域精确。

### S05首次step的库默认行为核对

项目锁定rusqlite0.40.1。只读核对该版本 [statement.rs 的 Statement::query/query_map](https://github.com/rusqlite/rusqlite/blob/v0.40.1/src/statement.rs)，并未运行Rust。

实际源URL：`https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.1/src/statement.rs`。`query` 实现只有 `params.__bind_in(self)?; Ok(Rows::new(self))`，文档Failure也明确只有binding失败；query_map委托query。结合项目 `state.rs:424-430`：第一次或后续next的SQL step错误都应“遍历消费游标失败”。82d以是否已produced行选择query/row，第一行overflow被错分成query，新测试的这一项虽然绿，期望本身不等价。F3 phase可解决prepare/bind识别，但不能替代修正该本lane条件。

### 最新判定

S02六条原apply测试已修；S03冲突JSON已修、L10候选正向精度已修但负大整数及main主链仍未闭合；S04support本身已完成owner委托和同事务回滚，L20默认笔记hook仍自行写表；S05 prepare失败及首step错分仍未闭合；S06真实busy握手仍pending。实际TESTMAP **34ported/6pending**，不继承旧104/104或任何owner全绿自述。当前五组未决，B不成立。

## 9. S05 prepare与step新修复候选最小复核

固定`3b7a8aa14bd45b33e1a2c3aa1a503ea4788c4021`，原样快照`/tmp/opencode/R4-S-3b7a-GajcUC`，真实修复`cae04c341ed509623ab584a8118f247866f828e0`。相对4c15旧树，stateRows删除`produced`，`phase=prepare`用prepare前缀、bind用query、首次或后续execute均用row；原测试错误期望“查询消费游标失败: integer overflow”已改为正确的“遍历…”，另加设备轮换首step用例。对照Rust `state.rs:296-307,419-437`及§8锁定rusqlite源码，这次期望变更是在恢复原语义，不是删断言求绿。

仅执行变化相关5个断言，未重跑114例，也未重跑无变化的busy握手/owner负CAS。使用Node原生加载该候选现有`tests/service-host.ts`：实际安装notes/vfs-repos/sync-support，实际SqliteDatabase；没有替换state方法或伪造StorageError.phase。保留此前Vitest依赖收集阻塞，不通过改转换器/依赖来绕过它。

作业**20261104135131-38b468**：实际DROP表引出prepare失败，以SQLite VIEW的`abs(i64::MIN)`分别产生首/后step错误；每条用assert.throws比较完整错误，打印后不符即exit1。

```text
S05 cursor prepare Database error: 读取消费游标失败: no such table: consume_cursor
S05 cursor first step Database error: 遍历消费游标失败: integer overflow
S05 cursor later step Database error: 遍历消费游标失败: integer overflow
S05 rotations prepare Database error: 读取设备轮换历史失败: no such table: device_history
S05 rotations first step Database error: 解析设备轮换历史失败: integer overflow
S05 five production assertions passed
退出码 0
```

无额外Errors，完整脚本/输出`/home/dsdev/.oc-jobs/done/20261104135131-38b468.log`。cae04/3b7均非固定main `16a254adfb53d24b971d27b2a7f34bf899d2bec7`祖先；这5项候选行为通过，S05主框保持待main复验。S06真实SQLite busy握手未新增证据，不能借该5条错误阶段断言关闭。§8原exit1与错误测试期望的历史分析全部保留。

## 10. S02/S03/S05主线签收（306eb8bbb）

固定main`306eb8bbbe74ad8f225da9313d24dd8eb0a8ef40`；本插件及notes.sync相对已亲跑主线门禁基线8d7b05d14无文件差异。复用**20261104142355-6832bc**原日志，不重复已执行用例：

```text
✓ host/plugins/sync-support/tests/pomodoro-counts.test.ts (9 tests)
✓ host/plugins/sync-support/tests/state-errors.test.ts (13 tests)
✓ host/plugins/sync-support/tests/integer-precision.test.ts (6 tests)
✓ host/plugins/sync-support/tests/json-text-precision.test.ts (5 tests)
✓ host/plugins/sync-support/tests/owner-transactions.test.ts (3 tests)
```

其中pomodoro/owner事务测试相对82d已逐断言审读版本无改动，宿主仅补正式dataSpaceDeviceId；实际安装owner并调用公开服务，没有用recompute-only冒充apply。S05两缺表及首次/后续step正确期望均来自cae04c341，已经在主线运行。整个门禁仍有其他L20失败而**exit1**，无额外Unhandled Errors，不能称整作业成功或抹去未运行的L20 note-history suite。

新增且仅新增主线负CAS探针**20261104144646-f3d9a4**，针对真正变化的7a6783fdb。原样快照`/tmp/opencode/R4-main-306-negative-RGlG0I`，现有service-host安装真实notes/vfs-repos/support、真实SqliteDatabase；MINIMAL_NOTES_SCHEMA仅建测试表，行为来自正式owner。插入revision=-9007199254740994n，经公开support方法准备，严格assert.equal：

```text
MAIN_NEGATIVE_CAS -9007199254740993 bigint
退出码 0
```

完整脚本与日志在`/home/dsdev/.oc-jobs/done/20261104144646-f3d9a4.log`。不复跑未变化的正向/JSON全套。S02、S03（本插件/owner原反例）、S05转正式main签收；S01/S04整条笔记消费链及S06真实busy握手仍未决，整体不通过。L20旧hook仍可能误拒大CAS，和此处owner修复不矛盾，继续由R4-SYNC-02单独追踪。

## 11. S01五个真实原场景与宿主修复的主线闭环

固定门禁主线 **01c074ecfb2fa79ae5db30add1a04c4abe48943d**；读到的后继main **ccba0483745be0bb95cdb1f03c14f6d0994fa41d**与其在support/notes/sync相关文件上无差异。`4f3fbbd83`引入一个应用+两个数据库的正确fixture；`7b5ca5178`将service-host接到真实F3维护注册/目录。未重跑已完成的5例，复用亲跑作业**20261104181546-28458e**。

`service-host.ts:23-35`创建真实StorageServiceImpl，locations和registerMaintenanceParticipant直接来自它；仅将测试指定的真实Sqlite handle路由给database/pathOf。没有no-op worker或owner写者替身，也没有通过跳过notes安装避免冲突；dispose/安装失败都会清理宿主与storage。这里验证的是row-engine与注册契约，不声称测试过notes worker业务任务或跨库维护阻断。

新文件`:20-34`在两个独立目录运行正式迁移，source/target为不同真实handle；只安装一次应用，命令入口的默认数据库指target，源端操作显式传source。`:61-69`复现Rust payloads的pending筛选、enrich、suppress_echo和倒序接收，`:83-84`只调用已发布sync.applyDownloadedChanges；没有setDefaultNoteHistory覆盖。

| Rust `note_history.rs`原场景 | TS `note-history-apply.test.ts` | 原断言/关键fixture核对 |
|---|---|---|
| direct_remote_resource_update… :417-467 | :88-114 | 真source创建→target初次apply→target仅resource更新；两次failure0、完整新正文、旧完整正文+pinned及新快照。call-through spies额外确认support reader和notes writer收到同一个tx，不替换实现 |
| relation_sync_rebuilds_local_cas… :471-533 | :116-139 | 出站无revision；target首次1/重放1/改绑2/再放2；缺目标资源计数0；同一应用的目标库命令返回resource_exists/locator_exists均true，不再另装第二Host |
| remote_pin_is_retained… :537-579 | :141-151 | Rust原本就是同库pin/unpin/Delete；TS对source执行原链，failure0、最后仍pinned，无误改成双库要求 |
| row_sync_transmits_history_dependencies… :583-675 | :153-178 | 两种未来格式/能力失败且target空，history无seq/有pin，两个apply failure0、after正文、before pinned及after快照、restoreCopy还原before |
| immutable_history_conflict… :680-729 | :180-198 | tampered failure1、正文/pin保留，原payload retry failure0、Delete保pin、未来版本failure1且get报不存在；增加断言没有替换原断言 |

原result：

```text
✓ host/plugins/sync-support/tests/note-history-apply.test.ts (5 tests)
support：14文件123例全部通过（含各原断言与补充用例）
whole job：1772 passed | 3 failed | 20 Docker skipped，原exit1
```

3个失败是其它目录的L20双Host关系用例和两个providers耗时项，不把整作业改成绿；也不再把旧62个初始化失败当该主线现状。本lane实际表39ported/1pending，唯一pending仍是实际SQLite busy握手，S06不签。

**边界**：本插件S01已完成真正生产链和原五场景；L20全局TESTMAP:204-208仍指旧`sync/tests/note-history.test.ts`，旧同源fixture及第二Host冲突没有因新增文件自动消失。该映射/旧测试问题继续归R4-SYNC-07，沿架构接管流程处理，R4不修改TESTMAP或旧测试。S04实际通用跨表写者仍待，整个support仍不通过。

## 12. S03不可变事件JSON读回精度增量（main9b3c18601）

固定main **9b3c18601f674826479ed0e7f6ac7d13edca2b70**，新增 **70605832e80b8b38faef455d29b84df05dc042e2**。原S03签收范围是已记录的conflict/SQL JSON与notes owner反例，本节补记后来发现的事件JSON读回缺口及修复，不声称旧签收已经覆盖它。

Rust `tombstone.rs:75-92`的seq:u64和size:Option<u64>，在`:310,435`直接由serde_json解码，精度不经f64。TS原输出已精确序列化，回读却用普通JSON.parse；改动仅在`src/tombstone-events.ts:90,210`消费正式`sync/api.ts::parseJsonLossless`，之后仍由parseTombstoneEvent校验字段/整数范围。hash、path、operation ID、连续水位、verify解析失败返回false和download解析失败抛Database的分支均保留，对照Rust`:302-349,421-463`。

两条`event-json-precision.test.ts`通过实际安装的syncSupport服务运行，state是实际SQLite；MemoryStorage仅模拟云端字节存取。下载例用合法version4/kind=blobs、seq9007199254740993n、size9007199254740995n，验证精确size与推进水位；上传例从前一偶数云端序号开始，校验真实发布/回验成功、JSON原整数、第二次不重复PUT。没有在测试内复刻被测解析/序号分配。

已亲取owner有效修前 **20261104200941-f251ff**：2failed/exit1，分别为路径内容不一致、上传后回验失败；修后 **20261104201022-5d0c16**：2passed/exit0。两作业无skip、无额外Errors/Unhandled Errors。REPORT所列更早错误fixture（单数blob、version1）和错误import的失败不当作本次有效反例。主线 **20261104220300-b694ec** 已实际执行event-json-precision **2/2通过**（1200ms，无该文件skip）；S03这个新增事件JSON子项完成main签收，不另排重复两例。

范围仅为不可变事件入站u64精度；通用manifest helper的Value/null合同、其它未审serde行为及S04/S06仍按原结论，不因新增两个补充测试增加Rust ported数。

整门禁220300-b694ec原exit1，1842passed/2failed/20Docker skip、154passed/2failed/1skipped files，无额外Unhandled Errors；两失败为旧关系第二Host SlotOccupied及W69=38593.657126ms。selfgate政策通过不冒称原测试全绿，S04/S06与R4-SYNC-07未决保持。
