# L20b-sync-support 迁移交接报告

## C2 / R4 主线签收状态同步（最新裁定，仅文档）

按 C2 通知并只读核对 R4 的 ACCEPTANCE §10–12：**S01/S02/S03/S05 指定范围已主线签收**，
不再描述为待 R4 签收。本轮不改 ACCEPTANCE、不代签其它范围、不重跑125全套。

- §10：S02 的原 apply 场景、S03 原 conflict/SQL JSON/notes owner 反例及 S05 阶段映射，
  已在 main `306eb8bbb` 签收；包含负大整数 CAS 的独立探针 `20261104144646-f3d9a4`，exit0。
- §11：S01 五条完整 note-history 原场景及真实宿主，已在主线 `01c074ecf` / 后继无差异
  `ccba04837` 签收。独立主线 `20261104181546-28458e` 中 support 123/123，整作业仍
  1772 passed / 3 failed / 20 Docker skip、原 exit1，不能称整作业全绿。
- §12：`70605832e` 的事件 JSON u64 增量已在 main `9b3c18601`、独立作业
  `20261104220300-b694ec` 的2/2闭环。C2另亲取实现方目录作业 `20261104201431-1d0ae3`
  125/125、exit0；wiring39/未接0是C2提供的复核回执，不冒称本lane新增执行。
  独立整作业原 exit1、1842 passed / 2 failed / 20 Docker skip，无额外 Unhandled Errors，
  两失败属于旧关系第二Host与W69耗时，不改写为全绿。

**仍保留**：S04 通用跨表写者/事务链、S06 真实 busy observer 缺口。F3 main/分支 API 均未发布
该能力，F3 parked，由C2上报接管/裁定；本lane不固定sleep、不造callback、不派停放owner。
原174833的72项摘要仍归档为未知，不能称算法回归、已修或工具故障。映射维持39P/1Q。
以下旧时间点的失败、未签收和候选状态保留为历史，不能覆盖本节指定范围的最新签收裁定。

## S03 自查：不可变事件 JSON 的 u64 序号/size 保真

`putEventVerified` 和 `downloadEvents` 原先用普通 JSON.parse，虽然事件序列化精确写出 bigint，
读回仍把 `9007199254740993` 舍入为相邻偶数，导致自己写出的事件回验失败，或合法远端事件
被拒为“路径与内容不一致”。Rust `tombstone.rs:75-92` 的 seq:u64、size:Option<u64> 及
`:302-316,426-436` 的 serde_json::from_slice 不经 f64。当前只将这两处读取接 L20 公共
parseJsonLossless，仍经过现有 parseTombstoneEvent 字段校验，未改路径/hash/操作ID/水位规则。

新增 `tests/event-json-precision.test.ts` 通过真实已安装服务：
1. 下载合法 format_version=4 的奇数大 seq 和 size，精确保留水位与 size；
2. 从云端大序号前缀发布下一奇数事件，原回验成功、JSON 保留整数原文，重试不重复 PUT。
不修改既有移植测试断言。MemoryStorage 与原 Rust 测试的内存云端边界一致，state/解析/hash/序列化
均为真实生产方法。该补充测试不增 Rust ported 数；R4 已在 §12 对该事件JSON范围完成主线签收，
不扩大至全部serde，也不解释此前72项集成差异。

| 作业 | 原结果 | 证据归属 |
|---|---|---|
| `20261104200503-3216ff` | exit1；2 failed | 新fixture误用单数blob（协议为blobs）；不是生产缺陷证据 |
| `20261104200634-858dac` | exit1；2 failed | kind已修，但下载fixture仍误用format_version=1；不作完整有效反例 |
| `20261104200735-e673d3` | exit1；2 failed | 本次编辑错误：从不重导出parser的本地json.ts导入，已改从sync/api.ts导入 |
| `20261104200833-957c3c` | exit1；24 passed / 1 failed | 原23条async-codec通过；下载新fixture仍因format_version=1失败，后修fixture为Rust版本4 |
| `20261104200941-f251ff` | exit1；2 failed | **有效修前反例**：kind=blobs、format_version=4，临时恢复本次改动前普通JSON.parse后，两条分别路径不符/上传回验失败 |
| `20261104201022-5d0c16` | exit0；2 passed | 相同有效输入/断言，接入公开无损解析器后通过 |
| `20261104201130-f450c8` | exit0；2 passed | Electron真实运行时同两条测试通过 |

各作业无额外 Errors/Unhandled Errors，均未skip。通用 decodeTombstoneFile 的 runtime Value/null/同步异步
契约按 C2 X6-UD-0085 裁定保持，未借本项改成新泛型、限制普通JSON为对象或授全serde解码通过。

## 174833 新集成反馈：当前分支通过，原 72 项差异仍待原始栈

原日志 `integrate-auto-2026-11-04T174833052Z.log` 报72项新增失败，不能沿用165250的旧根因。
由原 root `_integration-p3` reflog 定位 baseline `e87727c09`、candidate `7b5ca5178`、
合并树 `2fce872c5`（17:49:29Z）。相对候选，本lane/kernel/storage/notes/sync生产代码无差异，
notes目录只有文档与journal-registration测试更新。原runner仍仅存excerpt，没有原job ID、
完整栈、数值exit、Errors/skip记录，不能补造这些字段，也不能直接裁为工具故障。

| 作业 / 固定树 | 原结果 | 证据范围 |
|---|---|---|
| `20261104173512-c53cb8` / `7b5ca5178` | exit0；123 passed / 0 skipped，无 Errors/Unhandled Errors | 上一轮宿主修复后的目录级自检，5项全过 |
| `20261104175634-655ae5` / 原样快照 `2fce872c5` | exit0；3 passed / 25 标题过滤，无 Errors/Unhandled Errors | blob/asset DSBK及note-history direct入口，未复现原红灯 |
| `20261104175750-d8056d` / `6361462a6`（main `e87727c09`） | exit0；123 passed / 0 skipped，无 Errors/Unhandled Errors | 合并同一基线后的完整目录自检，5项全过 |

固定快照路径 `/tmp/opencode/L20b-174833-Cgb0Gu`；只链接正式 node_modules，未改参考源码。
同轮typecheck `20261104175750-204c60`、boundaries `20261104175750-dad7c1`、
strict `20261104175751-d001ea`、importable `20261104175750-1955f6` 原exit均0。
已将组合与请求投递C2：下一次原integration root红灯需保留完整stdout/原退出码/环境/实际HEAD，
再按同入口定位；若有现存未摘录日志，请提供路径。本lane未为无法复现的摘要改业务或弱化断言。
原72项摘要归档未知，当前自检绿不反向证明原失败原因；S04/S06 保留，S01/S02/S03/S05
指定范围的主线签收见最新裁定。

## 165250 回归续修：owner 释放已进 main，补齐测试宿主 maintenance 能力（最新）

合并 main `7f4fb688b` 后，L10 `5f9082dbf` 已让 retention 注册返回 Disposer，
并在 notes 插件 effect 中释放 journal/retention 注册。旧 SlotOccupied 原因现在属于历史，
不能仍描述为“owner 未修”。但 notes 初始化新增 worker maintenance 注册，旧本lane宿主未提供。

| 作业 | 检查 | 原结果 |
|---|---|---|
| `20261104171656-8ca196` | 前轮 `4f3fbbd83` 的 §5 目录自检 | exit 1；61 passed / 62 failed / 0 skipped，无 Errors/Unhandled Errors；note-history-apply 5/5，其余重复安装抛 SlotOccupied |
| `20261104173050-679378` | 本轮新 main 下先复验两个 codec 入口 | exit 1；2 failed / 21 标题过滤，无 Errors/Unhandled Errors；`notes/index.ts:118` 抛 registerMaintenanceParticipant is not a function |
| `20261104173204-d56061` | 宿主修正后 blob/asset DSBK + direct resource/relation | exit 0；4 passed / 24 标题过滤，无 Errors/Unhandled Errors |

仅改 `tests/service-host.ts`：F3 真实 createStorageService 提供 app-local locations 与真实
registerMaintenanceParticipant（不是 no-op），保留原真实 SQLite handle 的 database/pathOf 路由。
notes 创建真实 worker pool 并完成注册；测试不触发 worker 命令，不替换其实现。
正常及安装失败都释放 host/storage/自有 SQLite。所有业务原输入与断言未改，旧红灯证据保留。
该轮自有缺口是测试装配，不冒领 L10 owner 释放实现；S06 busy 仍独立 pending，
宿主与指定S01场景后由R4 §11主线签收。

## 165250 集成回归：固定组合与 retention 注册生命周期（历史红灯）

旧 `053d7f27c` selfgate 5 绿保留，不能代表后继组合通过。原日志：
`/home/dsdev/dev/deep-student/.oc-runs/integrate-auto-2026-11-04T165250128Z.log`，报新增63项。
从 `_integration-p2` reflog 定位 baseline `fb463060d`、candidate `053d7f27c`、
合并树 `b82afc31c`（16:52:57Z）；随后回退 candidate `5e044ece5`、合并树 `fa0d5bffa`。
当时 gate-runner 直接 spawn 检查，未经 job.mjs，也未落完整 stdout/数值退出码/Errors/skip；
现存摘录不能补造这些字段。以下是固定组合的**新增最小复验**，不是冒称找回原栈。

固定 `b82afc31c` 的原样 git archive 快照 `/tmp/opencode/L20b-165250-dQdz4K`：

| 作业 | 原结果 | 具体入口 / 栈 |
|---|---|---|
| `20261104170655-11b47d` | exit 1；1 passed / 27 skipped；1 failed suite；无额外 Errors/Unhandled Errors | blob DSBK 成功；note-history 在 beforeAll 第二次安装 notes 时失败，5项未执行，另22项标题过滤 |
| `20261104170838-db350a` | exit 1；1 passed / 1 failed / 21 skipped；无 Errors/Unhandled Errors | 同文件 blob 成功并 dispose；紧接 asset 在新 host 初始化时抛同一 SlotOccupied；21项为标题过滤 |
| `20261104171349-5962ce` | exit 0；2 passed / 3 skipped；无 Errors/Unhandled Errors | 合并 main 后本lane fixture改为单应用host：direct resource与relation真实链均通过；3项标题过滤 |

复验首栈：kernel `Slot.provide:32` → F3 `registerNoteAssetRetention:106` →
L10 `registerNotesAssetRetention:16` → `notes/index.ts:169` → `serviceHost`。
不是旧 paths/CPU 归因，也不是 DSBK encode/decode 断言失败。F3 `91cdc7d61` 将注册改为
`Slot.provide` 并返回 Disposer，L10 包装返回 void、丢弃 disposer，未挂 plugin 生命周期。

本 lane 仅修自己的并发双 host fixture：一个真实应用绑定 target；source/target 仍是两个
真实迁移库，所有 owner/engine 方法显式传原连接；目标 notes_relation_get 改由该单 host 调用。
原输入/断言/同 tx spy 全部保留，没有换 notes 替身或重写 Slot。跨用例 dispose 后再安装
仍存在的注册释放问题交 C2/架构协调 owner（已 queue C2，不直接派停放lane）。
未重跑全63，当前仍有 owner 依赖红灯；39 ported 是映射状态而非当前全套通过。
S06 真实 busy 接口缺口独立保留，不随本项关闭。

## S01 已主线签收：正式 main 接线与完整 note_history 测试；S04 仍保留

main `677f6727c` 已含 L20 `572ff765e` 等变更：默认 hooks 的 reader 通过
`ctx.syncSupport.noteHistory`，笔记/格式/关系/历史写统一经 L10 notes.sync/revisions，
原 L20 平行写 SQL 已删。hooks 函数名仍在不代表仍走旧副本；此前 BLOCKERS 描述已更新。

新增 `tests/note-history-apply.test.ts`，不改原函数级测试断言，也不导入/替换 L20 私有 hooks。
两库均由真实 F3 migrations 创建，源笔记由 notes.repository 创建/更新，传输经公开
sync.getPendingChanges→enrichChangesWithData→applyDownloadedChanges，乱序批次与 Rust 一致。
5 条 Rust 原测试的 failure_count、真实 replay/Delete、目标空库、pin、不可变冲突隔离、
restoreCopy 断言全部保留；逐项见 TESTMAP。relation 两个 reference 标志通过目标真实
notes_relation_get 命令验证。额外 spy 仅观察默认 support reader 与 L10 writer 接收到同一 tx，
没有 mockImplementation 或 setDefaultNoteHistory。

Node 作业 `20261104160636-53cfb7`、Electron 作业 `20261104160922-2faa05`：各 5 passed，
原 exit 均为 0，均无 Errors/Unhandled Errors。
映射从 34 ported / 6 pending 恢复为 39 ported / 1 pending；S06 busy_handler 仍缺。
本段原作业是实现方证据；R4 后已由 §11 独立主线复验签收 S01（见最新裁定），
不是本lane代签。未修改 ACCEPTANCE.md，S04通用链仍未决，不宣布整lane B。

## L10 main 更新后的真实 owner 回归补齐（历史过程）

正式 main 已含 L10 `7a6783fdb`（负大 i64 CAS）及 `7df6fff90`（含软删笔记的推断格式读取）。
本 lane 仅补真实服务测试，不修改 owner 实现：

- `integer-precision.test.ts` 原 CAS 循环新增 `-9007199254740994n` 与 i64::MIN 输入，
  保留原正向/溢出断言。对应 R4 §8 负数反例及 Rust `note_history.rs:102-114` 的 i64 checked_add。
- `owner-transactions.test.ts` 原推断格式/远端快照回滚测试保留全部断言，并分别覆盖活动及软删笔记；
  额外确认快照正文、source 及 deleted_at 不变。Rust `note_history.rs:279-316` 的远端正文 SELECT
  无 deleted_at 条件，随后 snapshot；走安装后的 syncSupport→真实 notes.sync/revisions，未替换 hooks。

作业 `20261104145316-0d5433`：上述两文件 10 passed，exit 0，无 Errors/Unhandled Errors。
这是 support 到真实 owner 接缝的补充证据，不是 L20 完整 apply/replay/检疫已接通证明。
Rust 映射仍 34 ported / 6 pending；S01/S04 及 S06 的外部阻塞见 BLOCKERS.md。验收仍归 R4。

## S05：F3 phase 进 main 后复验与首 step 修正（历史；后由 R4 主线签收）

合并含 F3 `9900d8dda` 的 main 后：

| 作业号 | 范围 | 结果 |
|---|---|---|
| `20261104122242-2989d0` | state-errors.test.ts，代码未改 | 0；12 passed。两条缺表 prepare（读取消费游标/读取设备轮换历史）原断言通过 |
| `20261104123246-065f70` | 修正后首跑 | 1；3 failed，原因是本次编辑遗留 `produced` 引用（ReferenceError），非行为结论 |
| `20261104123619-eb8627` | state-errors + state | 0；15 passed，无 Errors/Unhandled Errors |

R4 §8 指出的首 step 错分已修：`repository/state.ts` 的 stateRows 不再以“是否已产出行”
选 query 上下文，改为 prepare→读取、bind→查询、其余 step→遍历/解析。依据 Rust
`state.rs:424-430`（rows.next 任意失败都是“遍历消费游标失败”）与 `state.rs:299-305`
（query_map 的行迭代失败是“解析设备轮换历史失败”），以及 R4 核对的 rusqlite 0.40.1
`Statement::query` 只做参数绑定。原测试首行 overflow 期望“查询…”与 Rust 不等价，改为“遍历…”；
新增设备轮换首 step 用例。114/2 为 F3 前的历史结果，保留。S05 后已由 R4 §10 主线签收，
S06 busy_handler 仍缺，不因错误阶段签收而关闭。

## 集成门禁反馈恢复：正式 main L10 精度与测试宿主身份接口（历史）

合并 `daa3e239f` 已取得正式 main 的L10精度修复 `32e423cb2` / `3cb9e7770`，
随后同步main至 `f1ceaceaf`。之前候选等待描述不再适用于L10。

首次按反馈运行目录级检查，失败入口为真实 L11 `paths.dataSpaceDeviceId is not a function`：
测试provide仍只提供旧deviceId。已仅补充新公开身份方法，仍安装真实notes/vfsRepo/support。
不改任何精度或不可变history断言，不用返回Number迁就测试。

已完成的队列结果：

| 作业号 | 检查 | 原退出码 / 结果 |
|---|---|---|
| `20261104091122-cb6483` | 初次typecheck | 0 |
| `20261104091123-afd108` | 初次migration:boundaries | 0；0 violation |
| `20261104091123-c5cb1c` | 修复测试宿主前目录级Vitest | 1；69 failed / 47 passed；身份接口缺失及其级联失败，不能算业务精度未修 |
| `20261104105720-b564e3` | 修复宿主后json-text/integer/state最小集 | 0；13 passed，0 skipped，无Errors/Unhandled Errors |
| `20261104105720-d78341` | ledger --check --no-write | 0；问题0 |
| `20261104110057-b4673f` | 修复宿主后目录级Vitest（按集成反馈要求） | 1；114 passed / 2 failed，0 skipped；无Errors/Unhandled Errors |
| `20261104110057-9d18dc` | 最终migration:boundaries | 0；2384文件，0 violation |
| `20261104110057-090c49` | 最终typecheck:host | 0 |
| `20261104110058-091d21` | Electron运行时json-text/integer/state最小集 | 0；13 passed，无Errors/Unhandled Errors |
| `20261104112222-1c0a5d` | 再次门禁反馈后合并main，目录级Vitest | 1；114 passed / 2 failed（仅S05两条prepare文案）；无Errors/Unhandled Errors |
| `20261104112222-24150b` | 同轮typecheck:host | 0 |
| `20261104112222-2d98ea` | 同轮migration:boundaries | 0；2402文件，0 violation |

再次门禁反馈所列 state.test.ts / json-text-precision / integer-precision 失败，与修复宿主前
`20261104091123-c5cb1c` 的 dataSpaceDeviceId 级联失败同组；合并最新main后这些用例全部通过，
门禁摘录对应的是 `301ab4267` 之前的提交。剩余2条仍等F3 phase，未改断言。

C2 对 `4c15a5c8e` 裁定：两条缺表 prepare 前缀（读取→查询）为真实 S05 未闭合，
标为**已知依赖阻塞**，不设门禁豁免，不用 skip / it.fails / 排除 / 改断言换绿。
F3 `a5b6c8a8d` 已申请正常集成；phase 进 main 后只跑 state-errors 两条原失败
（必要时附同文件第一 step 对照）。R4 独立签收前不算完整 S05；S06 busy_handler 继续 pending。

原三个真实owner反例（CAS、INTEGER history相同值重放、props_json相邻整数不可变冲突）
全部通过。本lane修复的是测试宿主接线；精度生产修复来自已合main的L10，不冒领实现。
F3 phase仍未main，S05两条prepare失败及S06实际busy缺口独立保留，不影响S03证据。
未修改ACCEPTANCE，34P/6Q不等于整lane验收通过。

目录级剩余失败仅 `cursors missing-table ... prepare-stage read prefix` 和
`device rotations missing-table ... prepare-stage read prefix`；两条依赖F3物理prepare/bind/execute
打标，已有迭代适配不能从旧无phase错误推断。未改为统一“读取”前缀，未跳过测试求绿。
本lane测试宿主适配已由 `301ab4267` 保存（连同SPEC/TESTMAP状态更新）；待F3进入main后
只需重验这两个原失败与相关阶段最小集，不需重复S03。

```text
ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

## C2 提供方候选更新（82d123466 之后）

已读取 L10 候选 `3cb9e7770` 及其实现 `32e423cb2` 的实际diff：revision/history 两个
SELECT 已设置 safeIntegers，JSON 文本比较及对象写入已调用 L20 的 parseJsonLossless /
dbJsonEquals / stringifyJsonLossless。**候选已修、待集成**，不是 owner 未实现；本 lane
尚未在 main 上验证该候选。此次 merge main 没有带入 notes 精度修复或 F3 phase。

现有真实 owner 三条精度失败保留，不改变期望值或绕过 owner。main 集成后仅提交
integer-precision.test.ts 与 json-text-precision.test.ts 的最小队列作业，再记录原exit/Errors。
本轮只有交接文档更新，没有重复提交已完成测试，也没有轮询提供方。
F3阶段信息仍为候选待main；S06实际busy缺口不变；L20默认note-history hooks平行写入由
C2派回L20处理，本lane不改其目录或私替hooks。34 ported / 6 pending 不代表整lane B通过。

## C2 07:07 S03 parser 接入复核与 source 能力错误

已执行 merge main（Already up to date）。公开 parser 接入已在 `1aacd0184` 完成：
本地 conflict canonicalize 直接调用 L20 api.ts；原 jsonFieldEquals 历史比较副本已删除，
applyRevision 通过真实 L10 notes.sync。不是等待候选接口，也未复制私有parser。

本轮补齐缺source必须明确失败：canonicalize 只对 SyntaxError 按 Rust 回退原JSON文本，
共享parser的 `Lossless JSON parsing requires JSON.parse source access` 能力错误直接传播，
不静默回退为字符串，也不Number→BigInt补救。新增公开服务测试保留原生JSON解析和生产
共享parser，仅移除平台reviver第三参数模拟该能力缺失。

```text
[作业 20261104073719-89f434] 退出码 1
Test Files 1 failed (1)
Tests 1 failed | 4 passed (5)
[作业 20261104073719-c1897c] 退出码 0
[作业 20261104074022-ebf68b] 退出码 1
Test Files 1 failed (1)
Tests 1 failed | 4 passed (5)
```

上述依次为Node最小文件、typecheck、Electron同文件；Electron作业在中断前已完成，
恢复时只补记其结果，未重复提交。代码/测试已由 `afc7eccd1` 保存。

5例中：缺source拒绝、原hash/resolveOne/去重三反例均通过；真实L10 applyRevision的
props_json不可变校验仍失败。无Errors/Unhandled Errors行。未删除、跳过或反转失败断言，
S03整体仍未闭；S05两条未变失败没有重跑。当前总计13文件116例，仅本文件最小集验证。

服务器中断恢复：已检查最近20条提交、工作树和TESTMAP，代码检查点完整；仅补记已完成
Electron结果并按唤醒指令重新取ledger，不重复跑已完成测试。恢复后main仍无L10精度修复/
F3 phase，真实失败继续保留。恢复ledger作业 `20261104074508-33247d` 退出码0：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

账本无无效登记问题不意味着上述语义失败或6条pending已经闭合。

## C2 06:38 owner 接真与共享 JSON（最新）

### 自有实现完成的变更

- 合并 main `9c13dfc39` 后（本分支 `0f65a19b6`），已将 note-history 所有 mutation
  委托真实 L10 notes.sync / revisions；删除关系 CAS/locator/块失效/不可变历史写/pin/
  inferred format 的本地业务和写 SQL 副本。repository/note-history.ts 现在仅有 SELECT。
- 删除 repository/pomodoro.ts，计数经 ctx.vfsRepo.pomodoros.recomputeCompletedPomodorosForSyncBatch
  同步调用，传原 SqlExecutor。相关批次只调一次，不新开事务，不经 worker；错误仅加一层
  原 SyncError Database 前缀。真实 owner 事务测试验证 SAVEPOINT 后/提交前执行、外层失败全部
  回滚（history/关系/todo），及 inferred format/snapshot 同事务回滚。
- 删除测试 notes 服务替身。service-host 安装真实 notes/vfs-repos/sync-support；夹具仅建表
  和播种数据。既有 CAS/不可变历史/JSON 反例现确实经过真实 owner，未 stub 被测比较逻辑。
- 随后合并 `7625998df` 已带入 L20 公开 JSON 接口；src/json.ts 从 sync/api.ts 引用唯一
  JsonFloat/DbJson、parseJsonLossless、clone/equality/stringify。删除本地普通 JSON.parse
  比较路径；内部保留 bigint 与浮点 source，不在插件服务边界降为 number。
- L20 apply API 进入 main 后，六条 pomodoro Rust 测试已恢复真实公开 applyDownloadedChanges
  调用，原双设备/软删/重放/换绑/Delete/检疫success_count=1/failure_count=1断言全部恢复。
  不再用 fixture SQL 冒充远端写入。**TESTMAP 当前34 ported / 6 pending / 0 merged / 0 obsolete**。

### 未闭合项与真实失败

- **S03**：三条 conflicts JSON 文本反例（hash、resolveOne、去重）已通过。真实 notes owner
  仍有三条失败，不能以“owner负责”隐藏：
  1. prepareRelation 的 revision=9007199254740993，返回9007199254740993而非9007199254740994；
  2. 同 content_bytes=9007199254740993 的历史重放误报 `Immutable history conflict: v (content_bytes)`；
  3. 同 version_id 的 props_json.counter 从9007199254740992改到9007199254740993仍被接受。
  证据：notes/repository/sync.ts:157-162、223-230、80-90。C1/L10 修复；本 lane 回归原断言保留。
- **S01/S04 的 L20 调用点**：main 的 sync/index.ts:77 仍安装自身 createNoteHistoryHooks，
  不是 syncSupport.noteHistory；sync/repository/note-history.ts:177/229等仍写notes/relations。
  该平行副本和生产hooks归L20清理，不能通过测试私自替换hooks来宣称接真。五条note_history
  完整apply映射继续pending；本lane函数级测试已走真实notes，但不冒充完整Rust管线。
- **S05**：本轮未改变F3基线，两条prepare阶段失败保留；不重复运行未变失败。
- **S06**：实际busy通知仍缺，继续pending，未用sleep证明争用。未修改ACCEPTANCE。

### 队列验证（变更相关最小集）

以下测试作业均无 `Errors` / `Unhandled Errors` 行；保留其原退出码，失败未隐藏。

| 作业号 | 检查 | 原始结果摘要 |
|---|---|---|
| `20261104065421-a3c997` | 初次owner接线四文件 | exit 1；14 passed / 6 failed；其中plugin夹具缺tags列随后按真实notes schema补齐 |
| `20261104070132-a71f64` | owner/note-history/precision/plugin/pomodoro六文件 | exit 1；25 passed / 6 failed；均为JSON文本或owner精度问题（含2个当时已添加owner事务用例通过） |
| `20261104070132-e1cfec` | typecheck | exit 0 |
| `20261104070602-ec06f1` | owner-transactions完整三条 | exit 0；3 passed |
| `20261104070602-d9b5ac` | Electron上述六文件 | exit 1；26 passed / 6 failed；含新增inferred-format事务回滚用例通过 |
| `20261104070958-15d584` | 接共享parser后：json-text/conflicts/integer三文件 | exit 1；17 passed / 3 failed；仅上述三个真实notes owner精度失败 |
| `20261104070958-c86a6c` | 接共享parser后typecheck | exit 0 |
| `20261104071723-1c314f` | pomodoro-counts真实L20 apply | exit 0；9 passed，含恢复的6条Rust集成 |
| `20261104072034-960eef` | 最终Electron pomodoro/json-text/conflicts/integer四文件 | exit 1；26 passed / 3 failed；仅上述三个真实notes owner精度失败 |
| `20261104072034-516598` | 最终typecheck | exit 0 |
| `20261104072034-fcc3f5` | strict | exit 1；全仓4条，本lane无未豁免违规 |
| `20261104072034-a6967b` | ledger --check --no-write | exit 0 |
| `20261104072034-4dad70` | wiring --lane sync-support | exit 0；34条ported均可达 |
| `20261104072146-7896c2` | 同一ledger脚本只读内存lane摘要 | exit 0；未改生成文件或输入 |

新增用例总量为13文件115例，仅作数量统计，未将未重跑全套宣称全绿。原生导入检查
`importable: ok`。没有新增npm/native依赖。

官方 L20 命令 A/B = **66.7%/0%**（16/24、0/24），测试 A/B = **82.1%/1.9%**
（216/263、5/263）；L20b 无独立命令。未达A的8条（data_governance_前缀）：
import_sync_data、list_unsynced_items、mark_asset_deleted、mark_blob_deleted、
resolve_record_conflict、rollback_sync_snapshot_batch、run_sync、run_sync_with_progress，
属于 L20 主lane尚未注册/接完的命令，本lane未改其目录。官方表与本地34/6映射由协调者同步。

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78.2% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 34，其中所测模块未从 index.ts 接入 0（0.0%）
```

strict 本lane所有输出行（原pomodoro忽略错误现在归L11，未另造豁免）：

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
```

### 提交与交接

- `6d183b75f`：删除写SQL/业务副本并委托所有者。
- `97ab6863d` / `716e3e67c`：测试接真实owner、移除notes替身、事务与精度证据。
- `bc3ff9c8b`：API增补与inferred-format回滚测试。
- `1aacd0184`：接入L20共享无损JSON，删除本地表示/解析副本。
- `1e16de1e9`：恢复6条真实pomodoro apply测试与TESTMAP映射。

最终同步main为 `7a33b3b44`；上表检查在 `7625998df` 后的本lane实现上完成，
随后main仅更新其他lane/队列规范，未改变本轮已验证实现或L10/F3的失败基线，未重复跑失败集。
所有代码与真实失败证据均已在分支检查点保存；本轮报告/规格同步提交不表示B级通过。

以下章节为之前基线的历史快照；提供方可用性与测试结果以本节为准。

## C2 06:08 更新：接口已发布待集成，S05 iterate 适配已准备

已核实 L20 `api.ts:26` 公开无损 JSON 全套函数（文件最近提交 `90bd48d00`），
F3 bf8f7b439/edac96ed7 提供 StorageError.phase，L11 PomodoroRepository 提供
recomputeCompletedPomodorosForSyncBatch(conn, changedTables)。当前合入 main 仍不含
这三个公开接口，不能称 main 已可消费；不再称“提供方分支无接口”。精确接法见 SPEC。

本轮自有改动：state 查询改用 iterate，按 F3 的实际 phase 和是否已产行区分前缀；
产行后的执行错误不再被 all 合并成“查询”。通过实际 SQLite abs(i64::MIN) / UNION ALL
验证首行执行与后续遍历差异。当前 F3 main 不携带 phase，两个 missing-table 反例继续失败；
没有按错误文本猜 prepare。测试适配器只透传实际 SQLite iterator，不模拟错误阶段。

全局队列结果（均为本工作树）：

```text
[作业 20261104061720-010549] 退出码 1
Test Files 1 failed (1)
Tests 1 failed | 11 skipped (12)
```

该作业为修改实现前新增遍历反例的 `-t` 定向复现；11 skipped 为名称筛选，未添加 skip。

```text
[作业 20261104061841-69119b] 退出码 1
Test Files 1 failed | 3 passed (4)
Tests 2 failed | 19 passed (21)
```

该作业为适配后的 state-errors/state/plugin/integer-precision 最小集；新遍历反例通过，
失败仅两个未集成 F3 phase 的 prepare 文案。两个作业均没有运行器 Errors/Unhandled Errors 行。
四个 JSON 文本反例未变，未重复运行。S03/S05 仍未闭合，S02/S06 仍 pending，S01/S04 未闭。

后续队列结果（`job.mjs result` 退出码，不用 passed 行替代）：

| 作业号 | 检查 | 退出码 / 结果 |
|---|---|---|
| `20261104061852-794608` | typecheck:host | 0 |
| `20261104062119-23b502` | Electron 同四文件最小集 | 1；2 failed / 19 passed，0 skipped；无 Errors/Unhandled Errors 行 |
| `20261104062144-31c7dd` | boundaries:strict | 1；全仓14条，本 lane 0条未豁免 |
| `20261104062145-4b584d` | ledger --check --no-write | 0；账本问题清零不等于已知语义缺陷修复 |
| `20261104062145-57529e` | wiring --lane sync-support | 0；ported 28 均可达 |

Node 原生导入 `importable: ok`。本轮没有新增 npm/native 依赖。

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.9% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 28，其中所测模块未从 index.ts 接入 0（0.0%）
```

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

`1075503be` 检查点保存状态服务 iterate 调用、新回归与测试存储 iterator 透传；
`f36f83b40` 保存 repository/state.ts 的 phase 适配及 SPEC/TESTMAP。
上述队列结果在合并 main `bfe7cb091` 后取得；随后合并 `015d0c7b4` 仅更新其他 lane，
未重跑未变的本 lane 失败基线。此为接口集成前的部分修复，
仍保留原六条真实失败；不宣布 S03/S05 或全 lane 验收通过。

## C2 04:45 / R4 §5 新反例续修（最新状态：未修复）

已先补真实公开服务回归并亲跑：

```text
tests/json-text-precision.test.ts: 4 failed (4)
tests/state-errors.test.ts: 2 failed | 9 passed (11)
```

`npm run typecheck:host` exit 0。协调者检查点 `60db56a15` 保存四条 JSON 回归，
`4b15b3b55` 保存两条 prepare 回归及 SPEC/TESTMAP 更正；它们是未修缺陷证据，不是通过提交。

四条 S03 分别证明 `props_json` 中 9007199254740992/9007199254740993 被折叠后导致
hash 相同、resolveOne=null、第二条冲突被去重、不可变版本改变被接受；两条 S05 证明
缺 consume_cursor/device_history 的 prepare 错误仍被标成“查询”而非“读取”。
全部经 `serviceHost` 安装的生产服务 + 真实 F3，测试没有重写被测逻辑，也没有 skip。

**当时阻塞证据（已被上节新交付更新）**：当时当前 main 和 `ds-mig/L20-sync:host/plugins/sync/api.ts` 均未导出
`parseJsonLossless`，候选仍在 L20 私有 src/json.ts；按 C2 指令不得私导入或复制实现。
请求 L20/F4 发布共享无损解析入口（签名见 SPEC），随后替换本 lane 两处损精度解析并重跑四条。
S05 等待 F3 prepare/bind/step 元数据，不能按错误文本猜阶段或统一改 catch 前缀。
S03 不能因 SQLite 部分通过而标整体完成；本轮新增测试保持失败暴露该缺陷。

下方 **104/104 是异步 codec 提交时的历史通过结果**，不是新增六条反例后的全套状态。
S02/S06 继续 pending，S01/S04 未闭；ACCEPTANCE 未修改。

## C2 异步 codec 交付（104 测试通过快照）

- 已发布 `PayloadCodec` 的 Promise 返回支持与 `SyncPayloadCodec` / `AsyncPayloadCodec`。
  L20 的异步 E2EE codec 可直接传入现有 blob/asset/workspace 上传、全量下载、after 下载、
  按设备下载端口；接口名和参数顺序不变。同步 `plainCodec` 与同步 decode 调用保留原行为。
- 全部事件编码/解码、旧/新清单解码、每设备清单编码均等待完成；顺序保持 Rust：
  事件 GET/编码/PUT/GET/解码回验 → 清单编码/PUT/字节回读 → 尽力删除 legacy。
  编码和事件解码失败原样传播；清单解密与 JSON 损坏保持各自错误上下文。
- 新增 23 个公开服务回归，真实消费 F4 `createFileCipherSession` Promise DSBK，覆盖三种
  清单、不可变事件、重试、所有下载变体、legacy、加密失败/错密码/回读错误及同步兼容。
  没有以明文 codec 绕开加密，也没有引入加密实现或新依赖。
- 合并 main `b4bee66f6` 后：Node 与 Electron **各 11 文件、104 测试通过，0 跳过**；
  `typecheck:host` exit 0；原生导入 `importable: ok`；wiring exit 0；strict 本 lane 0 个未豁免违规。
  全仓 strict exit 1（其他目录 14 条），ledger exit 1（21 个测试问题）。
- Rust TESTMAP 仍为 **28 ported / 12 pending**；23 个新增回归不冒充 Rust 集成测试。
  11 条 apply 集成等待 L20 分支进入 main，另 1 条等待 F3 busy 通知。S03/S05 已修部分
  由 R4 复核，不自行修改 ACCEPTANCE 或宣称 B 级通过。

提交：`dc1b5b937` 已提交上一轮完整 81 测试/R4 报告及 L20 阻塞更正；
`78b0aa1f4` 协调者检查点保存异步 codec 生产实现和 23 个测试。

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.3% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 28，其中所测模块未从 index.ts 接入 0（0.0%）
```

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

## C2 04:25 交接更正

该次验证为下节的 **81 测试、28 ported / 12 pending**；后续 67/35 的章节均为历史快照。
已核实 `ds-mig/L20-sync:host/plugins/sync/api.ts` 存在
`applyDownloadedChanges/getPendingChanges/enrichChangesWithData` 等公开方法，C2 确认
L20 index 已消费 syncSupport；下文 S01/S02 的“未发布”应读为“分支已发布、尚未合入 main”。
11 条 apply 集成测试等待真实生产链路进入当前基线，保持 pending。
本次按协调者明确要求提交最新报告，提交不表示全仓门禁或 R4 验收通过。

## 2026-11-04 R4 验收问题修复（81 测试快照）

已读取 R4 分支的 ACCEPTANCE 与汇总；**未改 ACCEPTANCE**。逐编号处理、Rust 对照、
提交与剩余接口需求在 SPEC 的“验收问题处理”节。最终合并 main：`6ed01c7af`，无冲突。

### 处理结论

- **S03 已修复所列整数损失**：读取前启用 safeIntegers；CAS checked_add 使用完整 i64；
  change_log max 不经 Number；内部服务传递 bigint，保存冲突 JSON 数字不截断。
  5 个回归经 `index.ts` 安装的服务与真实 F3 数据库，覆盖持久化、比较、快照与回声抑制。
- **S02 虚假 ported 已纠正，完整集成仍阻塞**：删除自写 apply/UPSERT/伪检疫管线；
  原有计数断言作为明确标注的 fixture/recompute-only 用例保留，6 条 Rust 映射改 pending。
- **S05 部分修复**：三种事务的 BEGIN/COMMIT、语句及列解析文案已区分；
  9 个真实 SQLite 回归验证 deferred FK 提交失败回滚与后续重试、嵌套 BEGIN、读取及列错误。
  prepare/bind/step 区分仍缺 F3 阶段化接口，保持未闭合。
- **S01/S04/S06 未闭合**：分别依赖 L20/L10 的真实消费与 blocks、L10/L11 的表所有者
  事务内写操作、F3 的实际 SQLite busy 通知。S06 已改 pending，保留的最终序号测试不冒充
  busy_handler 握手；没有用 ready/延时制造“已争用”的证明。

### 仍需协调的具体接口

1. L20 `SyncService`（`sync/api.ts:32-52`）：applyDownloadedChanges、getPendingChanges、
   enrichChangesWithData；接入 syncSupport、移除自身平行实现；发布 LWW/history。
2. L10 `NoteFormatRepository`（`notes/api.ts:63-70`）：blocks；新增同事务的关系换绑/块失效、
   不可变历史应用/pin、推断格式更新并清空 updated_at。当前直接写这些表的架构缺陷仍未解决。
3. L11：同一 SqlExecutor 上全量番茄计数重算与 echo 抑制的业务 API；当前逐记录接口不能
   替代 Rust 全量重算。未经提供方发布，不跨目录搬表或修改其实现。
4. F3：查询错误的 prepare/bind/step 阶段元数据（或阶段化查询 API）；测试用实际 busy
   observer/handler 通知与释放。`SqlExecutor` 与 `ConnectionProfile` 目前均未提供。
5. L20 的 JsonValue 仍只有 number，本 lane 内部服务已增补 bigint；消费方须保留整数并在
   JSON 编码边界使用无损数字表示，不能转 Number。没有新增 npm/F7 依赖。

全部 **12 项 pending** 的测试 ID、具体缺失断言与提供方证据在 TESTMAP：
note_history 5 + pomodoro apply 6 + writer busy 1。ported 28、merged 0、obsolete 申请 0。

### 验证与账本

- `npm run typecheck:host`：exit 0（前轮 accounts.mjs 声明缺失已随 main 修复）。
- Node Vitest 与 Electron Vitest：各 **10 文件、81 passed、0 skipped**。
- `importable: ok`；wiring exit 0。
- strict exit 1：全仓 20 条未豁免违规，本 lane 0 条。
- ledger exit 1：全仓 21 个测试问题。官方 L20 命令 A **66.7%** / B **0%**，
  测试 A **53.6%** / B **0%**；本 lane 无独立命令，40 条对应测试在官方表仍为
  A 8/40（20%）、B 0/40（0%）。这是同一 ledger 的只读内存输出，不使用本地测试数替代。
  官方仍读 sync/TESTMAP，由协调者同步本地 28/12 映射。
- L20 未达 A 的 8 条命令仍见下面 Linux 快照的逐项清单，原因仍是未声明/未注册，归 L20。

原始输出：

```text
ledger: commands 1058 (A 89.1% B 1.8% C 0%), tests 8036 (A 73.3% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 28，其中所测模块未从 index.ts 接入 0（0.0%）
```

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

### 提交状态与语义

协调者 WIP 检查点：`9084fc63e`（精度回归）、`e5e55daa5`（精度修复）、
`21dd2e62a`（事务阶段与测试去伪）、`5ab819dc1`（API bigint、列错误、公开服务测试入口）、
`06a9550f9`（TESTMAP 状态更正、冲突精度补充用例）。
最新 SPEC/TESTMAP 计数说明/REPORT 为后续工作树改动；全仓提交前门禁仍红，
不创建 B 级完成提交。未发现新增 Rust bug；原来的整数截断不是获准平台差异，已修复。
JSON 字符串解析/浮点表示等历史语义差异没有由这次 SQLite 整数修复一并解决。

## 2026-11-04 Linux 续作（上一轮快照）

从 `089d7f7fa` 恢复，已两次执行 `git merge --no-edit main`，均 fast-forward、无冲突，
当前合入基线 `3eda92215`（首次到 `8176f4199`）。以下旧章节是历史快照。
协调者自动检查点 `198013807` 已保存入口、SPEC、TESTMAP 改动；这是 WIP，
不是全仓门禁通过凭证。最新 LANE/REPORT 更新仍在工作树中。

### 本轮变更与验证

- L10 已在 `host/plugins/notes/index.ts:120` 提供 `notes`，`api.ts:114` 已声明
  `Context.notes`；入口删除临时 Context 交叉类型断言，直接使用公开声明。
- 本 lane 测试的临时目录已使用 `os.tmpdir()`，无需平台修补；Linux 没有 import 大小写失败。
- Node Vitest 与 `npm run test:host:electron -- host/plugins/sync-support` 均为
  **8 文件、67 测试通过、0 跳过**（入口变更后重跑）。
- Node 原生导入：`importable: ok`。wiring exit 0；strict 本 lane 0 个未豁免违规。
- 首次合并后的 `typecheck:host` 延长超时后通过；第二次合并与入口变更后重跑
  exit 2：main 新增 `scripts/electron-migration/accounts.test.ts:2:68` 报 TS7016，
  `./lib/accounts.mjs` 缺少类型声明。本 lane 无类型报错，该文件不在允许修改范围。
- 全仓 strict exit 1（其他目录 20 条违规）；ledger exit 1（250 个测试问题）。
  全仓门禁尚未通过，不作完成声明，也不满足任务要求的正式提交前置条件。

### ledger 与测试映射

同一官方 ledger 脚本在 `--no-write` 下的内存计算（未改写账本或输入）：

| 范围 | 命令 A / B | 测试 A / B |
|---|---|---|
| L20-sync 官方统计 | 16/24（66.7%） / 0/24（0%） | 141/263（53.6%） / 0/263（0%） |
| 本 lane 40 个 Rust 测试在官方表中的现值 | 无独立命令 | 8/40（20%） / 0/40（0%） |

官方仍只读取 `host/plugins/sync/TESTMAP.md`。本地映射 **ported 35 / merged 0 /
obsolete 申请 0 / pending 5**；逐测试 ID 对照见本目录 TESTMAP。协调者需同步该表，
不能将 67 个通过的 TS 用例当作 40 个 Rust 测试已全部移植，也不能把本地比例当作官方 A/B。

L20 未达 A 的 8 个命令（均为 `data_governance_` 前缀）：`detect_conflicts`、
`detect_prune_gap`、`list_unsynced_items`、`mark_asset_deleted`、`mark_blob_deleted`、
`repo_check`、`run_sync`、`run_sync_with_progress`。官方证据均为未声明、未注册，
SPEC 0/7；这些命令属于 L20 主 lane，不在本 lane 的允许修改范围。

### 逐项阻塞复核

五项 pending 均属“其他 lane 未发布接口”，已重读 Rust `note_history.rs:400-731`
及 main 上的公开 API；逐测试缺失断言仍见 TESTMAP 的逐项表：

- `direct_remote_resource_update_keeps_both_full_document_snapshots`：缺 L20 apply/pending/enrich，
  无法验证真实源/目标库与双侧完整快照。
- `relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it`：缺 L20 apply/pending/enrich，
  无法验证发送端去 CAS、两轮 replay、failure_count 与真实关系引用状态。
- `remote_pin_is_retained_after_unpinned_replay_and_prune`：缺 L20 apply/pending/enrich，
  无法验证真实重放与 Delete 保留 pin。
- `row_sync_transmits_history_dependencies_and_preserves_remote_before_after`：缺 L20 apply/pending/enrich，
  无法验证乱序批次、未来格式/能力失败后空库与同步后的 restoreCopy。
- `immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins`：缺 L20 apply/pending/enrich，
  无法验证隔离、failure_count=1/0、Delete 保留 pin 和未来版本拒绝。

共同证据：`host/plugins/sync/api.ts:32-52` 仍未发布 `applyDownloadedChanges`、
`getPendingChanges`、`enrichChangesWithData`，L20 目录无 `syncSupport` 消费。
L10 `NoteFormatRepository`（`notes/api.ts:63-70`）仍缺 `blocks`；NotesService
仍无关系/历史同步写入接口（`notes.sync.prepareRelation/retargetRelations/applyRevision`）。
L20 仍缺公开 LWW/history 端口。已有 `NoteBlockParser` / `SyncHistoryPort` 及测试替身保留；
不得以私有实现导入或重复实现同步管线来消除这些阻塞。

### API、依赖与语义

本轮没有修改 `api.ts`。当前服务名为 `syncSupport`（描述版本 `1.0.0`），提供 state、
tombstones、noteHistory、pomodoroCounts、conflicts；按此前协议 v2 从派发中的旧名
`sync.support@1` 统一而来。DRAFT 覆盖整个 L20，本 lane 只提供五个支撑模块；
`open_default` 由 F3 `storage.database('sync_state')` 承担，L23 经现有适配器接入。
无新增 npm 或 F7 原生依赖需求。未发现新增 Rust bug；既有数值 wire 精度/规范化差异
仍见末尾“Rust 特殊行为与语义差异”，本轮不宣称这些差异已经解决。

### 本轮门禁输出

```text
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 35，其中所测模块未从 index.ts 接入 0（0.0%）
```

strict 中本 lane 的全部输出行：

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

## 可擦除语法硬门禁复核

- 已执行 `git merge --no-edit main`，合并提交 `c037c55e6`，无构造函数冲突；
  `git merge-base --is-ancestor 0af04df83 HEAD` 成功，协调者统一修复已在本分支历史中。
- 本 lane 没有 erasable-syntax 违规，不需要新增语法改写。
- 合并后执行 `node scripts/electron-migration/importable.mjs host/plugins/sync-support/index.ts`：

```text
importable: ok
```

- 同步重跑 strict / wiring / ledger，输出与下节记录一致：本 lane 0 个未豁免违规，
  35 个 ported 均可达；全仓 strict 249 条与 ledger 341 个测试问题仍未清零。
- 本轮仅记录验证结果；原有 5 个 pending 及缺失 API 证据仍见 TESTMAP。

## 自动质量反馈修复：时间副本与 tombstone 拆分（最新）

三条反馈均已处理：
- 删除 `src/time.ts`，包括 `toRfc3339Utc` / `nowRfc3339`；state 与清单上传直接导入
  `host/platform/time/index.ts` 的 `toRfc3339`。纳秒比较使用平台解析结果，不另写格式化器。
- `src/tombstones.ts` 从 1657 行缩为 236 行，仅保留服务组装与原导出。
- 拆分后的文件：`tombstone-model.ts` 583 行、`tombstone-events.ts` 274 行、
  `tombstone-manifests.ts` 618 行、`tombstone-files.ts` 189 行。依赖单向，无循环。
  拆分按 TypeScript 符号依赖移动声明，移动时逐声明核对函数体未变；临时迁移工具已删除。

初次回归发现旧 TS 测试仍 grep `tombstones.ts` 检查回读函数名。对照 Rust
`tombstone.rs:2027-2044`，按质量规范第五节改为三个生产上传路径的行为测试，
同时检查 PUT→GET 次序、回读损坏/缺失不能成功；未通过改 grep 路径绕过失败。

提交前已 merge main（`fdf912be6`），实现由协调者检查点 `db6d7d964` 保存；
类型检查通过、8 文件 67 个测试通过（0 跳过）、Node 原生导入检查 `importable: ok`。
没有新增 npm/原生依赖，没有修改服务契约。本 lane 仍为 ported 35、pending 5；
每项 pending 的缺失 L20 API 证据见 TESTMAP，拆分没有新增阻塞。

本轮门禁原始输出：

```text
ledger: commands 1058 (A 68.7% B 1.8% C 0%), tests 8036 (A 66.3% B 0.4%); problems: commands 0, tests 341, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 35，其中所测模块未从 index.ts 接入 0（0.0%）
```

strict 本 lane 全部输出行：

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

全仓 strict 仍 exit 1（249 条），ledger 仍 exit 1（341 个测试问题），未宣称全仓门禁通过。
本 lane 没有未豁免 strict 违规；新增 erasable-syntax 检查也通过。

## 协调者指令 1–4 执行结果（上一轮快照）

已合入 main，提交前最后一次合并为 `2f7557bd1`；合并后再次通过 typecheck 与 65 项测试。
本轮实现由协调者检查点 `299ebba89`、`c17a6d636`、`3547f81d9` 保存，文档检查点为 `47df20500`。
服务统一为 `syncSupport`，
`api.ts` 导出 `syncSupportService = { name: 'syncSupport', version: '1.0.0' }`。
插件 inject `storage` / `notes`，通过 `ctx.notes` 调用真实服务；缺新名提供方时等待注入，
不回退旧服务或测试替身。logger 改为构造必传，所有生产空 logger 已删除。

本轮修复与验证：
- Rust 六处 tracing 逐处列于 SPEC；修复 workspace 事件下载丢弃警告的问题。
  5 个日志测试验证旧对象探测/删除失败、坏时间戳、更新文件和无匹配云对象的日志与继续语义。
- 删除 `ignoreError` 空函数；三个无日志忽略分支的 boundary-allow 均注明真实 Rust 依据。
- 182 行本地时间实现改为 F4 time 的薄适配；trim/严格 UTF-8 统一走 F4 util。
  LWW 改用内部时间解析器，避免把 Rust 不接受的纯数字时间戳当有效值。
- 删除本地行级 Markdown marker 近似。新增 `NoteBlockParser` 最小消费接口；
  缺失 `notes.format.blocks` 时在写入前报错，真实 parser 抛错则按 Rust 取空 ID 集合。
- typecheck 通过；8 文件、65 测试通过，0 跳过；TESTMAP 仍为 ported 35 / pending 5。

### 完成协议要求的原始输出

`npm run migration:ledger -- --check --no-write` 最后一行（exit 1）：

```text
ledger: commands 1058 (A 67.7% B 1.8% C 0%), tests 8036 (A 66.1% B 0.4%); problems: commands 0, tests 341, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

`npm run migration:wiring -- --lane sync-support`（exit 0；npm 环境提示省略）：

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane sync-support

合计 ported 35，其中所测模块未从 index.ts 接入 0（0.0%）
```

strict 中属于本 lane 的全部行：

```text
(allowed) host/plugins/sync-support/repository/records.ts:140:5 [empty-catch]
(allowed) host/plugins/sync-support/src/conflicts.ts:118:7 [empty-catch]
(allowed) host/plugins/sync-support/src/pomodoro.ts:81:7 [empty-catch]
```

本 lane 0 个未豁免违规；全仓 exit 1，249 个违规（console-log 213、empty-catch 36）。
未把全仓失败表述为通过；其他 lane 不在本轮允许修改范围。
按协议 v2 提交本 lane 已验证单元的报告及临时产物清理，不宣称全局门禁或整体迁移完成。

### 尚待接线的证据

5 项 pending 的逐项名称、缺失 API 和断言见 `TESTMAP.md` 的同名表：均缺
`sync.applyDownloadedChanges`（其中两项同时缺 `getPendingChanges/enrichChangesWithData`），
这些方法不存在于 `host/plugins/sync/api.ts:32-52`。`notes.revisions.restoreCopy` 已发布，
不是阻塞；其集成测试要先有真实同步目标库。自有函数级测试均继续运行。

其他未完成接线：
- `notes.format.blocks`：`host/plugins/notes/api.ts:60-67` 没有该符号；不得导入私有结构解析器。
- `notes`：L10 `index.ts:190/203` 仍提供旧名；本 lane 已明确 inject 新名等待提供方。
- `syncSupport`：L20 `host/plugins/sync/index.ts` 尚无 inject/调用；禁止修改该目录，需 L20 接入。
- 关系表/历史表写入的所有权：现有同步 SQL 仍在本 lane repository，按新架构需 L10 提供
  `notes.sync.prepareRelation` / `retargetRelations` / `applyRevision`（事务内原子操作）；
  `notes/api.ts` 尚无此接口。现状不算完成新的单写入方架构验收。
- LWW 比较与快照：L20 尚未发布 `sync.compareLwwTimestamps` / `sync.history`；
  现有最小 `SyncHistoryPort` 必须由真实 L20 调用方注入，测试替身不算生产接线。

能力目录生成器只读执行：`node scripts/plugin-catalog/generate.mjs --check` 报目录过期；
另在内存执行同一生成器并输出本 lane 的自检问题，未写 docs/plugins：

```text
服务 `notes` 被 dstu.memory, dstu.sync-support 使用，但没有提供方
服务 `notes` 已提供，但没有任何插件在运行时消费它（其他插件可能只在测试替身里用了它的接口，生产路径未接线）
服务 `syncSupport` 已提供，但没有任何插件在运行时消费它（其他插件可能只在测试替身里用了它的接口，生产路径未接线）
```

本轮未新增依赖；已用 F4 共享模块替换通用手写实现，没有 IP/SSRF/HTTP 客户端。
数值 wire 的后续统一建议由协调者评估 `lossless-json`（serde_json 无同源 JS 实现）；
当前 `sync.JsonValue` 只有 number，不能完整承载 i64/u64/REAL 变体，需 L20 同时扩充公开契约。
未用手写新 parser 绕开依赖安装权限；相关差异仍未验收。

下列章节保留上一轮快照（包含旧服务名、旧测试数与旧 ledger 值），不作为本轮完成声明。

## 状态

五个支撑模块与 `sync.support@1` 已实现并进入协调者检查点；**尚未达到完整逐行等价验收**。
未决项包括 note_history 块解析、5 个 Rust 集成测试的完整断言、全局门禁失败。
测试全部通过不等于迁移全部完成。

本轮续接修复：
- 插件读取 `notes`（原来误读 `notes`），插件测试验证经该服务写入快照。
- 删除 SQLite 不可用时自动跳过的分支；ABI/加载错误直接使测试失败。
- 保留首发 `TombstoneStorage.instance_binding_hint/list_outcome` 与 `last_modified`；
  新增 `ProviderTombstoneStorage` / `adaptTombstoneStorage` 对接 L23 camelCase 接口。
  类型断言验证 CloudStorage 满足新增接口，测试验证发布/下载完整往返。
- 将只有函数级覆盖的 5 个 note_history 测试映射从 ported 更正为 pending。

## 验证与 ledger

基于合入 main `efedccb6a` 后的工作树：

| 检查 | 结果 |
|---|---|
| `npm run typecheck:host` | 通过 |
| lane Vitest | 6 文件、56 测试通过、0 跳过 |
| tombstone 类型修正后的定向复核 | 27/27 通过 |
| `npm run migration:boundaries:strict` | exit 1；279 条：console-log 235、empty-catch 44；本目录 0 条 |
| `npm run migration:ledger -- --check --no-write` | exit 1；commands 0、tests 341、orphan registrations 0；无 dstu-sync 测试问题条目 |

本轮未修改其他 lane 清除全局问题，也未执行正式完成提交。自动检查点不是门禁通过凭证。

| 范围 | 命令 A / B | 测试 A / B |
|---|---|---|
| L20-sync 官方账本 | 16/24（66.7%） / 0/24（0%） | 141/263（53.6%） / 0/263（0%） |
| 本 lane 本地映射 + Vitest JSON 的内存计算 | 无命令 | 35/40（87.5%） / 35/40（87.5%） |
| 同步映射后的模拟 L20-sync（非官方现值） | 16/24（66.7%） / 0/24（0%） | 168/263（63.9%） / 35/263（13.3%） |

模拟使用官方 `computeLedger`，仅在内存合并本地 TESTMAP 与测试报告，不写生成文件。
官方 ledger 未注册 L20b 文档目录，仍读取 `host/plugins/sync/TESTMAP.md`；
其对应 40 项中 19 ported、21 pending，实际 A 为 8/40（其余已有 ported 受 wiring 判定影响）。
协调者应同步本地 35 条 ported，保留 note_history 5 条 pending，并提供 Vitest JSON 才能计算 B。
56 项测试的 JSON 已被自动检查点 `65f29dcb4` 收录，可从该提交读取；工作树移除临时产物。

TESTMAP：40 个 Rust 测试，ported 35、merged 0、obsolete 0、pending 5。
56 个 Vitest 用例含 40 个 Rust 同名用例和 16 个补充用例；同名不等于完整等价。

## api.ts 与 DRAFT

- `DRAFT-L20-sync.md` 描述整个 L20；本 lane 只负责五个支撑模块，无命令注册。
  `meta.lane = L20-sync`、`meta.provides = ['sync.support@1']`。
- `state::open_default` 改为 F3 `storage.database('sync_state')`；DRAFT 中 F2 使用的
  `reset_default_after_local_purge` 增补为 `resetDefaultAfterLocalPurge()`。
- tombstone 保留 Rust 数据字段名，服务方法采用 camelCase；u64 水位/序号用 bigint。
  L23 CloudStorage 经显式适配器传入，首发 snake_case 接口保留。
- `plainCodec`、`SyncSupportError` 与错误判定由仅类型声明接到运行时导出；增补
  `clockDriftSuspected`。实际错误类构造器为 `(kind, message, options?)`，首发声明未显式
  声明构造器；这一签名差异需协调者确认，不能声称首发声明完全不变。
- SyncManager、命令、apply/enrich、通用快照管线由 L20 提供；冲突解析通过
  `SyncHistoryPort` 注入真实的 `newBatchId/snapshotRecord`。

## 跨 lane 请求与剩余工作

1. **L10**：公开 `blocks(content): readonly { id: string; body: string }[]`，或等价的
   `invalidateMissingBlocks(conn, noteId)`。当前 notes 没有此接口，不能导入其私有实现。
   接入时保留 Rust parser error → 空 ID 集合的行为。当前行级 marker 近似不满足
   根节点、代码围栏、重复/连续 marker 语义。
2. **L20**：将 SyncManager 接入 `sync.support@1`，提供公开 apply/enrich/pending 入口。
   五个 note_history Rust 测试须用真实源/目标库、乱序批次、failure_count、远端 Delete、
   两次 replay、失败后空库与 L10 `restoreCopy` 完整重跑。现有 fake-notes 单元测试不能代替。
3. **L20**：注入真实 `SyncHistoryPort`，统一 LWW 比较、时间转换、device pair；
   现 `src/lww.ts` 按 Rust 对应函数移植。
4. **L23**：采用 `adaptTombstoneStorage(cloudStorage)`；无需重命名其已发布接口。
5. **协调者**：同步 TESTMAP、清除全局门禁问题、确认错误类构造器声明差异。

没有新增 npm 依赖或原生构建需求。生产使用既有 F3 SqlExecutor / better-sqlite3 与
Node fs/crypto。原生 ABI 不匹配须修复环境或运行既有 Electron 测试入口，不能跳过。

## Rust 特殊行为与语义差异

- `prune_tombstones` 在无权威 replace snapshot 时恒返回 0，保持原样，不自行判为 bug。
- 默认事件 format_version=4；pin 只升不降；事件序号 `max(local, cloud)+1` 遵循 Rust 饱和规则。
- tombstone 时间比较保留秒/纳秒，避免丢掉亚毫秒顺序。
- JS Date 生成时间只有毫秒精度；Rust chrono 当前时间可能有更高精度。
- 业务 JSON 的 `1.0`/`1`、超过 2^53 的整数、serde_json 浮点输出尚不能承诺与 JS wire JSON
  全字节等价；内部 JsonFloat 仅保留 SQLite REAL 信息。
- 非 ASCII 键排序与 JSON 规范化仍需跨语言样例验证。这些是迁移差异，不是 Rust bug。
  未发现有足够证据的新增 Rust bug。

## 提交记录

- 首次 api.ts：`d9116258f`（协调者自动检查点）。
- 本轮恢复起点：`679c6f71c`；合入 main：`64c2b7a9d`。
- 本轮代码修正：`65f29dcb4`（协调者自动检查点，不是正式完成提交）。
- 报告与清理晚于该检查点，以工作树为准。门禁未全通过，不创建完成提交；正式提交前
  仍须 merge main、四项门禁通过、仅暂存本目录，提交尾附 `Co-Authored-By: DeepSeek V4.1 Flash`。
