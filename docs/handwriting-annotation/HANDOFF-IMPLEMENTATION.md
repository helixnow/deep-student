# 唯一实施交接：导入预览修复与自由画布

> 更新：2026-11-04。**本轮已授权代码实施、已知阻断修复和可运行的本地验收已收尾。** 自由画布创建开放，真实原生渲染与自动保存已验证；没有后台验收仍在运行。F中的新包真机、Docker provider、Windows、私有代表性迁移fixture仍未覆盖，不能冒称整套跨平台／真机验收完成。只从本文和README恢复，不从旧closure计划恢复已结束的提交／模型／APK任务。

## 1. 当前状态与权限

- 分支：`feat/handwriting-annotation-chat`；HEAD：`d48bec383fc478c8567a3f26fa0f424f46fa251f`，index仍为空。本轮没有Git暂存、提交、push、PR、merge或发布。
- 当前源码已停止写入，全部已启动本地验收已结束，未新增提交。不是旧136文件冻结现场；旧58／88／136清单都只保留历史恢复身份。
- **自由画布创建已开放工作副本入口**：统一TS菜单flag为true；Rust临时关闭常量已移除。Tauri和工具共用`create_board_gated`，它委托repo在发布首个board的同一savepoint内核连接capability／future floor并安装9个真实DML guard。不是绕安全门禁翻常量。
- 后续用户已明确要求“进行安卓虚拟机测试，实机测试”，再要求“抓取实机测试bug”。官方mobile-slim ARM64 release／x86_64 debug构建分别exit0（1075.39s／1137.49s），源码逐SHA不变。ARM64新包SHA256 `94c0c769d2eb44cc945590bacbb23d4fd1e5e397da4388d79cfb2fbe1da17174`已核签名／ABI／16KiB并`install -r`保留数据更新真机，实际安装字节相同。真机锁屏，预览／手写功能未验；x86_64新包尚未验签／安装／功能验收。未提交或调用外部模型，历史11次请求不重新开额度。
- 子agent仅探索／补测试／实现；主agent亲自运行所有本文验收。个别agent违背禁止自测要求的结果不作为证据，过程偏差在本地ledger保留；主agent已重新亲跑对应RED／GREEN。
- 不建分支／worktree，不reset／clean／restore现场，不清缓存、不重装依赖，不改ignore／lint或预算基线，不force-add归档。

## 2. 最终源码身份

最后原生验收快照（不含docs）：

| 项目 | 当前值 |
| --- | --- |
| 非docs源码／配置／迁移／测试文件 | **142个，5,850,475 bytes** |
| 分支／HEAD | `feat/handwriting-annotation-chat`／`d48bec383fc478c8567a3f26fa0f424f46fa251f` |
| index | 0 bytes |
| 权威清单 | `finalization-20261104/source-final-current.json` |
| source rows SHA256 | `eba6986aa0751df9c418ebe1b30aa492cfda33f1d318d2537d5812da4267bda9` |

路径相对于本轮本地忽略归档：

`docs/archive/handwriting-annotation/2026-11-03-implementation/resume-20261104/`

摘要算法：`sha256(json.dumps(source_files, sort_keys=True, separators=(',', ':')).encode())`，不是清单文件自身hash。每项含相对路径、bytes和SHA256。保全包`finalization-20261104/source-final-files.tar.gz`已按142项大小／hash核验，SHA256为`cae7b13346b374f9d3298d899d3c527bbb91ed50c44e39e25e1fdda5c18468b9`。`final-integrity-verification.json`记录逐项一致、index0、57相对链接／标题锚点与4活动JSON通过；此完整性检查只证明文件与文档一致，业务验收结论由下表逐项日志证明。归档不随clone、不force-add、不替代commit。

第三次136文件冻结已在恢复时逐文件／集合／tar核验完全一致。原758文件归档仍保留；活动旧文档Git删除是文档治理预期，不restore。

## 3. 本轮实际通过：有源码时点，不可相加

下列均为主agent运行。日志名相对于`finalization-20261104/`。不同套件重叠，不能相加成独立测试总数。

| 门禁 | 实际结果 | 证据／边界 |
| --- | --- | --- |
| 最后前端四片r5 | **12831 passed／4 skipped／5 todo**；1619文件通过／1skip，四片exit0 | `vitest-shard-{1,2,3,4}-r5.log`；各自`source_unchanged=true` |
| 双TS、lint／ratchet、frontend layers、license、i18n | 全exit0；4611旧warnings／0errors／0新增 | `frontend-quality-final-r5.log`；期间仅2个Rust测试文件变化，生产TS未变；180旧i18n引用缺键默认告警保留 |
| built production frontend／startup | exit0，真实构建entry评估并替换boot placeholder | `frontend-build-final-r5.log`；不是仅源模块单测 |
| bundle体积 | 当前CI warn-only exit0；**总JS gzip10705.8KiB超8560.6KiB阈值** | 入口等关键chunk在预算内；保留+28.8%基线告警，不抬基线 |
| 完整Ink浏览器CT | **108/108通过**，exit0，152.95s，source不变 | `ink-browser-final-r3.log`；含自动journal→CAS、paged／board、Office、真实PNG/PDF／取消；不是Android SAF或笔硬件 |
| board宿主／保存／历史 | **56/56通过** | `autosave-ownrevision-green-r1.log`，含瞬时journal恢复、overview重试、1000ms合并、own-save期间连续落笔、remote epoch拒绝 |
| native Wry真实渲染 | exit0，98.43s，source不变 | `native-render-e2e-r4.log`；同crop长边200／400两产物、像素／hash／源不变、invalid／stale不增产物全部执行 |
| native桥单测 | **22/22通过** | `board-render-identity-green-r1.log`；None／默认2048归一，200／400不同render ID |
| public创建／原生命令 | **23/23通过** | `vfs-commands-enabled-green-r1.log`；guard安装／旧连接拒绝／幂等／future-floor零写；最后不可重试错误分类亦已纳入最终VFS752全绿 |
| 六工具 | **33/33通过** | `executor-enabled-green-r1.log`；真实board create和PREPARED链；最后不可重试错误分类亦已纳入最终app1079全绿 |
| 创建菜单／路由 | **7/7通过** | `board-menu-enabled-green-r1.log`，默认board显示，显式false隐藏，paged仍可选 |
| 可信undo | **6/6通过** | `trusted-undo-green-r1.log`；repo容量19/19另有证据，不以任一替代全部 |
| 最终完整app／storage／sync／VFS | **1079／361／562／752全通过**，0failed／0ignored | `final-affected-rust-libs-r1.log`，exit0，943.19s，`source_unchanged=true`；包含创建启用／future-floor typed修复／classification |
| Nextest全workspace归档 | 125 binaries（含5非test）、648files，exit0 | `nextest-archive-final-r2.log`；元数据和解压副本在本地归档 |
| Nextest八片首轮 | **8193pass／2fail** | `nextest-partition-{1..8}-r4.log`；2项均immutable artifact分类遗漏，修后完整schema覆盖绿；旧归档不冒称最终源码全绿 |
| 独立同步性能 | 10000记录case通过，15.263s | `nextest-sync-timing-r4.log`；30s断言未放宽，竞争分片结束后单独跑 |
| 最终同步schema覆盖 | **11/11通过**，exit0/source不变 | `schema-coverage-final-r2.log`；不把immutable artifact降为local-only、不改旧迁移或删断言 |
| 最终production迁移 | **52/52通过**，满足最低50项，exit0/source不变 | `production-migrations-final-r2.log`；真实production测试，不是空feature目标 |
| 最终Phase5原生harness | 两case均PASSED，exit0/source不变 | `phase5-final-r2.log`；生产VFS的todo与automation完整链 |
| 最终Clippy correctness | workspace／all-targets exit0/source不变，657.57s | `clippy-final-r2.log`；保留style／unused旧告警，不禁correctness规则 |
| 最终fmt／迁移static | 均exit0/source不变，136迁移含base d48不可变性通过 | `fmt-final-r2.log`、`migration-static-final-r2.log` |
| 私有代表性迁移fixture | **明确SKIPPED**，`fixtures_available=false` | `migration-fixtures-availability-r1.log`；没有配置和checked-in fixture，不冒称upgrade测试通过 |
| 原生命令ACL | 4项在八片中PASS | 远端内容／非main窗口拒绝、本地main允许及command parser用例 |
| 构建契约／迁移tooling | **151/151、14/14通过** | `build-contracts-r1.log`、`migration-tooling-r1.log`；相关脚本未变 |
| migration static／base d48不可变性 | 136项通过 | `migration-static-r1.log`；最后仍再核 |
| crate layers／fmt | exit0 | `crate-layers-final-r5.log`、`fmt-final-r5.log`；最后纯错误映射后再fmt检查 |
| 真正旧源码门禁 | 7项安全拒绝gate＋3项parser／codec observations符合预期，exit0 | `legacy-client-extended-main-r1.log`；不是10项完整restore gate，见第6节 |

### 最后门禁已结束

`remaining_backend.py`全部门禁已结束：最终四库、schema覆盖、production迁移、Phase5、Clippy、fmt和迁移static均exit0，且每个JSON记录`source_unchanged=true`。私有fixture可用性检查按skip政策正常退出，但升级测试明确未执行。没有残留测试／编译任务。

保留八片首轮8193通过／2失败与修复后的最终受影响四库、完整schema覆盖证据。`rust-evidence-source-comparison.json`逐项列出归档与最终源码差异；未变crate／integration二进制保留已运行证据，**不伪称重新跑了一次最终全8片绿**。逐门禁退出码／计数均已亲读，不以总脚本末尾exit0掩盖早前失败。

## 4. 本轮关闭的缺陷与关键裁决

1. **Undo容量**：恢复已删对象改用AI add同一whole-object first-fit，不无条件新增第257块；保receipt z、后来human和原预算，undo不生成apply changes。
2. **跨失败block重试撤销**：PREPARED authority在同一Immediate Chat事务中精确CAS迁移，校验源／目标父会话、tool、call、public／VFS input hash、before/after/z等；清旧＋写新＋block_ids原子完成。旧ERROR终态不改，fresh同op竞争和stale expected-old拒绝，目标写入失败回滚；不能恢复“VFS先commit后补回执”的不安全方案。
3. **质量门禁**：BlobPart用Uint8Array.from推断，不cast逃逸；稳定hook方法解构防循环，house event registry与触控token；跨feature调用经Ink index惰性出口。旧基线与预算均未提高。
4. **真实原生E2E**：测试用run_return保证尾部断言执行；Tauri alternate filename不能自动替代配置，需compile-time TAURI_CONFIG overlay，先断effective identifier／devUrl／frontendDist／assets。不用主app数据、假PNG、第二renderer或猜minified导出。
5. **board渲染尺寸与身份**：selector真正传long_edge；render_id纳有效long_edge，None与默认2048一致，200／400不同，paged哈希路径不变。
6. **草稿普通瞬时错误**：ready session不因一次storage-error永久跳过后续gesture／pagehide持久化；恢复成功仅offline，不假saved／不绕owner／不继续盲CAS。
7. **overview与自动保存**：错误显式Retry；完成gesture后宿主1000ms合并save，manual／ask／export先取消timer，unmount／doc／remote epoch取消；原子hook与显式save契约不变。成功summary的z授权绑定doc／surface／remote epoch，本地保存不阻断下一笔，远端必须fresh；过期响应在副作用前丢弃。
8. **创建启用**：不把Rust常量改true，而让统一facade由repo原子guard接管；future floor拒绝、零写、不降级。CapabilityTooLow精确映射现有`ink.unsupported_schema`→`UNSUPPORTED_SCHEMA`不可重试，其他SQL错误仍保retryable Database；最终四库已验证通过。
9. **immutable artifact日志分类**：只有exact `(vfs,ink_render_artifacts,update/delete)`豁免不可能发生的change-log事件，INSERT仍强制同步；旧migration的不可变触发器不动。

## 5. 不能破坏的实现契约

- `.dsink`仍为普通VFS file子格式，不新建顶层节点、第二文件系统或运行时依赖。manifest唯一权威，resources／preview派生，revision opaque＋CAS。
- v1固定分页不自动升级；v2只有blank source、pages为空、稳定surface。signed world±10M，chunk保存完整对象，IDs／z全板唯一。
- 预算：manifest1MiB；chunk8MiB／10000对象／100000samples；board64MiB／256块／100000对象／2000000samples；read16MiB；编码cache32MiB；viewport16M像素／DPR≤2。不是最大JS堆或低端设备性能实测。
- 锁序`BlobMutationGuard→SQLite writer`；持guard helper不得重入或跨await。chunk refs进入copy／GC／conflict双方／sync／backup闭包。
- 同IDB v2的pages／board_deltas，owner／sequence比较／tombstone原子；每document独立session；CAS版本首次await前快照。own echo不盲删草稿，remote epoch清陈旧history。
- 真实共享renderer合成背景＋笔迹，AI只接不可变PNG，不向正文／RAG／工具get输出原points冒充视觉。问AI只加图片附件，不自动send/model。
- 破坏操作精确一次性审批不放宽；copy不克隆AI receipt／authority；undo对象级保后来人类内容。
- board finite world crop与paged normalized crop互斥；export显式region，PNG单框／PDF行优先裁边≤500；失败／cancel清stage，不暗导出全surface。

## 6. 旧端、设备与环境边界

- `legacy-client-d48/`从Git d48提取1442原src-tauri blob＋4同提交registry；主agent重新hash无差异。唯一新增／修改bin为`old_client_gate.rs`，当前SHA256 `b503ee75e56e35aff6f4673b6a8f825b2000a7c8262ca576f7c4c3df2ca0824b`，fixture manifest已区分7gates／3observations。
- 已真实执行旧public read／write format、upload／download、active lease并发拒绝及旧BackupManager新schema拒绝，PUT／DELETE零新增、sentinel不变。旧生产Tauri两入口均先validate后acquire lease已静态核；不声称旧APK等价、真实provider或完整Tauri race运行过。
- 缺min_reader的非canonical描述会被旧parser默认3；缺schema_versions parser拒绝但空map兼容门会接受。不是合法新board包绕过；canonical producer必须正确写reader5／schema。
- raw delta descriptor codec不检查board，但该模块当前零生产caller，现有集成测试锁定未接线；没有完整raw-delta restore正向／负向证明，不得写成通过。
- writer guard是旧连接DML兼容围栏，不是恶意DDL沙箱；不夸大为全部跨进程物理删除安全证明。
- 保留先前固定分页C的窄竞态观察：跨document实例paste closure自比、save原子拒绝后ghost undo、被动effect与transient selection交错尚未形成并关闭全部真实回归；不据board108CT宣称这些观察已消失。另保留非阻塞质量项：重复object_id在repo拒绝而非planner早拒、Add→Remove净空仍可bump revision、逐chunk读取有界但性能未实测、同会话receipt扫描成本。后续若复现为实质缺陷，先补具体RED，不无边界重构。
- Docker daemon socket权限不足，不提权／改组、不装软件绕过；provider ignored suites未实跑。Windows需要对应runner。本机没有私有代表性迁移fixture配置，按既有skip政策明确记录，不伪造upgrade。当前CI仅informational的npm／cargo在线advisory audit本轮未新增运行，不据离线锁文件验收宣称无漏洞公告。
- 后续已获Android测试授权并完成两ABI构建、ARM64验签／保留数据安装；真机业务因锁屏未复现。抓取928行应用专属日志和180s实时窗口，只发现6次未关联资源ID异常；release前端console默认不进logcat，根因不能猜。见 [当前取证](issues/android-import-preview.md#7-2026-11-04新包与实机bug抓取)。SAF矩阵／旧坏条目原位识别／新包手写／真笔压／掌触／延迟／API24仍未验，x86_64新包也未运行验收。
- 没有应用外部模型请求或Git提交授权；新APK仅本次测试用途，不发布，旧模型／三个commit／APK验收不重做。

## 7. 当前恢复顺序

1. 先读本文与README，核`source-final-current.json`文件集合／逐SHA、分支／HEAD／空index；旧136清单只用于历史恢复。
2. 本轮代码与本地验收已收尾，不自动重派旧agent或重开整轮验收。若未来有新改动，按实际源码差异失效受影响结果并重新验证；保留历史失败，不从旧closure恢复任务。
3. 本文、README、roadmap17、acceptance、usage／design和issue已同步当前范围；源码包／逐SHA／index／文档链接核验已完成。不要新增竞争交接或逐agentreport。
4. Android设备阶段已有具体授权，两ABI包已构建、新ARM64包已保留数据安装；用户随后转向bug抓取。下一步是解锁后原位复现或用现有设置入口导出默认诊断ZIP，继续限定应用证据；当前没有实时监听仍在运行，不自动无限期抓取。不要重复构建／安装同包或据系统日志猜修复。Git提交／外部模型仍需单独授权；设备／provider／Windows／私有fixture边界单列。

原始过程与裁决在`finalization-20261104/ledger.md`，可验证失败不删除。历史长交接／closure均已归档，不能据其旧计划恢复已经结束的外部动作。
