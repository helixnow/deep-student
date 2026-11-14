# L23-sync-providers 行为规格（`host/plugins/sync-providers/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 14 个 · 发出事件 1 种 · 契约：`contracts/ipc/L23-sync-providers.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：命令返回值里的 `Option<T>` 序列化为 `null`（`cloud_storage_get` 的 `Option<Vec<u8>>`、`cloud_storage_stat` 的 `Option<FileInfo>`，mod.rs:322/358）；结构体字段带 `skip_serializing_if = "Option::is_none"` 时缺省（`BackupVersion.app_version/note/recovery_kind`、`FileInfo.etag`、`SyncStatus.latest_version/last_sync_time/error`，sync_manager.rs:110–142、traits.rs:26–40），TS 用 `undefined` 复现。
- [ ] u64/i64 超过 2^53 的表示：D3 要求内部精确、仅 IPC 转 JSON number。manifest 编解码与排序已保留 bigint；F4 首块 API 已在 main 支持 number | bigint，password_proof.ts 的三处调用直接传原 bigint（33/33 定向测试，20261104145807-cdf82c）。lstat 元数据和 CloudStorage 字节接口仍待逐链核对，不能据此关闭整个 P04。S3 对象上限不能证明任意入站 manifest 的 serde 等价。共享 reader 的剩余差异见 BLOCKERS.md。
- P04 续传分支补查：Rust `sync_manager.rs:1782-1800` 用 `symlink_metadata` 拒绝符号链接断点；TS 名为 `lstatSize` 的函数此前调用 `stat` 跟随链接，现改为 `lstat`。回归先在旧实现复现错误偏移 2048 而非 0（`20261104151454-fdc488`，exit 1，1 failed / 6 未选中，无 Errors）；新断言还检查链接目标字节不变、最终 ZIP 非链接、完整 payload 与断点移除。修复后两文件 `20261104151706-9ad192`：40/40、exit 0、无 Errors；typecheck `20261104151706-91bdd0` exit 0。本修复不解决元数据 size 的 number 精度链，后者仍是剩余事项。
- main-red B04：原 `sync_real_business_tables_tests.rs:26-64/:417-459` 用裁剪 resources/change_log 的内存库，初始 4MiB x，再经公开 apply 更新为 5MiB y，仅断言长度/前缀。TS 现恢复该原 schema/触发器/连接与全部输入输出断言；不改默认 30s、不替换生产历史 hook。先前完整迁移库会额外触发原场景没有的 notes 格式探测，该生产组合成本另记 BLOCKERS。定向 `20261104185550-7aae5f` B04 371ms 通过，但同 job W69 31507.68ms 违反其原 <30s 断言，整体 exit 1，未冒称全绿。
- [x] 字段顺序（serde_json preserve_order）：Rust 未启用 `preserve_order`，结构体按声明顺序输出；TS 对象字面量保持同一顺序。测试只解析后比较字段，不做原始 JSON 字符串比对（`CloudManifest` 的版本列表除外，其顺序是协议语义：时间倒序，sync_manager.rs:150–180）。
- [ ] f32 精度：Rust 进度 `percent` 是 `f32`（mod.rs:199,492-495,593-596），TS cloud_commands.ts:27-28 仍以 double 计算/输出。尚无批准此差异的裁定；已上报协调者，不能凭进度条用途或边界测试宣称等价。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：所有失败抛 `CloudStorageError extends CommandError`，其 `value` 为 Rust `AppError` 的 IPC 形状 `{ error_type, message, details }`（host/platform/errors/api.ts:10–13）；稳定错误码写在 `message` 前缀（如 `[E_SYNC_E2EE_CLAIM_CONFLICT]`、`[E_CLOUD_RATE_LIMITED]`，mod.rs:206–260）。生产代码无 `unwrap`/panic 路径，失败一律是命令错误而非进程崩溃。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：`syncProvider` 暴露 `setCancelToken/clearCancelToken/isSyncCancelled`，WebDAV 的限流等待与退避 sleep 通过 `cancellableSleep`/`acquireRequestSlot` 立即抛 `云同步已取消`（webdav.rs:129–180）；下载/上传流在每次 await 间可被信号打断，语义与 Rust 令牌一致；命令自身不创建令牌，由调用方（前端/L20）设置。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：Node 单线程 + 每次命令独立 storage 实例；跨设备互斥由云端协议保证——`.encryption-marker` 用 pending 登记 + 租约/条件写 + 写前后双重复核（e2ee_claim.rs:100–310），manifest 用 `verified_publish` 的 tmp→校验→final→回读（verified_publish.rs:1–330）。无进程内锁，`await` 交错点即 Rust 的竞态窗口，已用确定性交错测试覆盖。
- [x] 时间与 ID：生成方式、格式、时区：时间统一 `formatRfc3339Utc`，等价 chrono `to_rfc3339_opts(SecondsFormat::AutoSi, true)`（webdav.rs:145）；租约对象按 chrono `to_rfc3339()` 输出 `+00:00`，由 `formatChronoRfc3339` 精确复现（sync_lease.rs:84、backup_lease.rs:84）；版本 ID 为 22 位小写十六进制随机串（sync_manager.rs:92–100）；设备 ID 首次生成后持久化（primary→legacy→生成，device_id.rs）；租约/tmp nonce 用 UUID v4；`checked_at` 为当前 UTC。
- [x] 不对含 HashMap 的结构做序列化后比对：生产结构体只用 `Vec`/`BTreeMap`/`BTreeSet`（repo_check.rs:143–148、sync_manager.rs:150–180）；TS 用 `Map` 仅在内存索引，IPC 前转数组；测试逐字段断言，不比较含 Map 的序列化结果。

### L23-V2-1.7：WebDAV 主动限流的单调窗口

Rust `webdav.rs:132-169` 用 `Instant::now()`：清过期项(:142-147)、有容量入队
(:149-151)、满窗按最老项剩余时间等待(:153-169)。TS `src/webdav.ts:190-202`
同分支只将窗口取时从Date.now换为performance.now；容量/共享队列/30分钟窗口/
60秒等待分片/2秒状态上报/真实cancellableSleep均未改。生产request/get/put等路径
仍调用同一gate（:270/:325/:551/:651）；Retry-After HTTP日期继续用墙钟，不混用。

`tests/webdav.test.ts` 新四项补充回归控制两种时钟，调用同一真实gate与取消等待，
跨两个共享窗口实例覆盖墙钟前跳/回拨、正常到期、未到期；无sleep替身/新测试导出。
原 `cancelled_token_aborts_waits` 的填窗时间改成performance.now，对应Rust
:1849-1852的Instant输入；原取消/Err/<5s/复位断言不动。首轮`20261105032738-ed02a1`
exit1（3failed/1passed）包含新测试错误地把Error.name当CloudStorageError的夹具错，
已改为instanceof与原文message断言。更正后源码未修时`20261105032931-233f31`
exit1（2failed/2passed），两个墙钟跳变分别错误等待/提前放行，两个控制项通过。
修后完整WebDAV `20261105033052-311154` 41/41、exit0；typecheck
`20261105033052-b51258` 已取回exit0，boundaries `20261105033052-1f4d8c` exit0，
上述均无Errors。源修复提交 `d476cf29e`，不把此局部证据当作官方lane-gate通过。
四补充项不新增Rust测试行、不提升TESTMAP，不因此关闭整个P04/P08或独立验收。

### L23-A13：原payload类型不匹配的真实apply/no-panic不变量

Rust `tests/sync_adversarial_tests.rs:570-587` 以 `counter:"not_a_number"`、原id/title/
updated_at/deleted_at调用生产 `SyncManager::apply_downloaded_changes`，忽略Result，
只要求不panic；不要求SQLite拒绝、成功或特定counter值。TS在
`tests/adversarial_sync.test.ts::adv_13_payload_type_mismatch` 保原输入和INTEGER
非STRICT schema，沿既有真实F3/已安装sync的 `apply` helper调用
`sync/api.ts:177-181` → `sync/index.ts:170-175` → `apply-batch.ts:92-170`。
真实SQL参数转换 `sqlite-values.ts:199-208` 保留字符串，不在测试中代做类型转换。
原输入本次正常返回，测试丢弃结果，没有catch、结果计数或counter值断言；若抛错
测试会保留原错误，不凭Error.name或任意catch吞掉可能的panic。未发生抛业务Err，
因此没有为未观察分支私引SyncError类或新增错误分类替身。
最小作业 `20261105033816-193e72` 原exit0、1passed/37标题过滤、无Errors；
仅这一Rust行转ported，不把过滤项记为运行通过，不扩到A33或其它无assert条目。

### L23-W55：真实只读连接的apply错误

Rust `tests/sync_weird_tests.rs:1531-1561`先写库、关闭，再以SQLITE_OPEN_READ_ONLY
重开，对原单条Insert断言 `r.is_err()`。TS
`tests/weird_batch_sync.test.ts::w55_readonly_connection_rejected` 保原裁剪items/
change_log schema（仅按既有许可改名test_items）、payload及两次nowTs调用；
写连接通过真实F3关闭，`openFile(path,{profile:{readonly:true}})`对应原只读打开。
公开 `storage/api.ts:354-365` → `service.ts:126-136` → `connection.ts:91-95`
实际设置驱动readonly/fileMustExist，不伪造query_only或只读apply实现。
同一已安装sync的公共apply在真实只读事务入口返回数据库业务Err，TS异常断言匹配
`Database error: .*readonly database`，不让setup抛错或任意panic冒充原 `is_err()`；
不新增原测试没有的行值/成功计数要求。最小作业 `20261105035916-111d65` 原exit0、
1passed/16标题过滤、无Errors。仅W55转ported，没有重跑同文件W69或其他条目。

### L23-A33：payload/record ID不一致的apply与两次查询观察

Rust `tests/sync_adversarial_tests.rs:1224-1263`忽略真实apply的Result，然后对
n1/n2各 `COUNT(*)` 查询并unwrap、打印，不断言写入策略或固定计数。TS
`adversarial_sync.test.ts::adv_33_payload_id_mismatch_with_record_id`保原record_id=n1、
payload.id=n2/title=ambiguous、`2026-05-01T10:00:00Z`及所有其他原字段。
沿已有真实F3 schema/已安装sync公共apply调用，丢弃返回值，无catch/必须成功要求。
两次 `db.one` COUNT对应原query_row.unwrap，保SQL/无行错误直接抛，不以缺值回退0；
打印结果但不assert其数值。生产当前主键不一致在 `apply-record.ts:489-495`返回
单条业务失败，经 `apply-batch.ts:144-151`隔离，不是本测试吞异常或改ID策略。
唯一 `20261105040401-7d0bcb` 原exit0、1passed/38标题过滤、无Errors，实际0/0
仅是此运行观察；不排除Rust原忽略Result允许的业务Err，不伪造公共错误分类。
仅此原标题转ported，其他观察用例仍待逐项判断，无自动obsolete或完整lane签收。

### L23-P20：保留归档日志规模与原单条apply性能断言

Rust `tests/sync_pathological_tests.rs:852-884` 在原内存库中以一个deferred事务
插10000条 `archived_<i>` / sync_version=1日志，提交后先起Instant、再构造fresh
变更，真实apply.unwrap后断言elapsed.as_millis()<500。TS
`pathological_sync.test.ts::p20_large_synced_changelog_does_not_slow_sync` 对应保留
相同规模/归档状态/事务/原schema及refinery历史行，只沿既有test_items表名许可；
performance.now同样在mkChange/两次nowTs之前起计，apply返回后取elapsed，严格<500。
不加新索引/缓存/替身，不减少日志、不将输入构造移出计时或放宽原断言；只在计时
完成后打印实际耗时。唯一最小 `20261105042830-151b20` 原exit0、1passed/
32标题过滤、无Errors，73.875603ms。该阶段仅P20转ported，P36后续独立移植见下，W69/S108未测；
不将此样本推断为其它性能问题或整lane已闭合。

### L23-W12：精确u64大数的真实apply/Result观察

Rust `tests/sync_weird_tests.rs:367-384`以u64::MAX-1进入原INTEGER counter字段，
调用生产apply并打印Result，不要求成功/失败/特定截断值。TS
`weird_sync.test.ts::w12_large_numbers_in_json`保原new_db内存schema/触发器及
refinery历史行、id=big/title=t/两次nowTs/deleted_at=null；仅按既有许可改表名。
公开 `DbJson` payload中counter始终为 `18_446_744_073_709_551_614n`，不先经
JS Number或测试侧coercion；沿已安装sync公共apply，直接打印返回结果，无catch。
当前生产 `sqlite-values.ts:202-204`拒绝超i64 bigint绑定，`apply-record.ts:301-305`
形成单条业务失败、`apply-batch.ts:144-151`隔离后正常返回；不私引/伪造错误分类，
不改该生产策略来迁就测试。唯一 `20261105043559-8d4b33` 原exit0、1passed/
39标题过滤、无Errors，stdout精确18446744073709551614及success0/failure1仅作
本次观察，不固化为契约。只W12转ported，不扩签其它数值/serde/SQL转换或整lane。

### L23-P36：5000次独立apply与原计数/60秒断言

Rust `tests/sync_pathological_tests.rs:1475-1504`在原内存schema上先起Instant，
逐次构造r00000…r04999与tsAgo(10000-i)，5000次分别apply.unwrap；计时止于循环
之后、COUNT查询之前，原断言COUNT=5000、elapsed.as_secs()<60。TS
`pathological_sync.test.ts::p36_5000_sequential_single_changes`保完整上述范围，
同条payload与changed_at复用原ts，真实F3/已安装sync公共apply，performance.now
对应Instant；COUNT用真实db.one，严格<60000ms。未并批/加索引/缓存/减少输入或
放宽断言；新case runner allowance120s独立于原60s业务阈值，不更改已有case预算。
唯一 `20261105045404-bcaeff` 原exit0、1passed/33标题过滤、无Errors，
23890.568476ms且实际5000条。只P36转ported；不从单次成功推断其它性能问题已修，
未重跑P20/W12/W69/S108/目录或全集。

### L23-P40：10组不匹配ID的批量apply与LIKE查询观察

Rust `tests/sync_pathological_tests.rs:1668-1711`保10个record_id=rec_i与
payload.id=payload_i、title=t、每条两次ts_ago(100-i)/deleted_at=null；生产apply
打印Result，Ok时分别query_row.unwrap读取LIKE 'payload_%'与'rec_%'计数并打印。
TS `pathological_sync.test.ts::p40_bulk_payload_id_record_id_mismatch`保原内存schema/
触发器/refinery行、全部输入、真实已安装sync公共apply及两个原LIKE模式；正常返回
即执行两次db.one，不把failure_count>0误当顶层Err而跳过查询，也不以缺值回退0。
无catch/私造错误分类、固定结果计数/必须成功或ID策略改码。唯一新增
`20261105051211-30238b`原exit0、1passed/34标题过滤、无Errors；返回success0/
failure10以及两LIKE计数0/0仅为观察。P36已在c8e10cc16保原两断言，复用
`20261105045404-bcaeff`原exit0/5000条/23890.568476ms，本批不重复其5000次执行。
本批TESTMAP仅新改P40一行，不重跑P20/W12/S108/W69/目录或全集，不签整lane。

### L23-W13：原NaN序列化断言的生产同源映射

Rust `tests/sync_weird_tests.rs:388-396`只构造f64::NAN并to_string，assert Err或
Ok("null")，未调用apply。固定serde_json1.0.149的 `ser.rs:169-179` 明确将NaN写
null；TS `weird_sync.test.ts::w13_float_infinity_nan_not_serializable`将Number.NaN
传入公开 `sync/api.ts:27` 的stringifyJsonLossless，正常返回后核对原Ok分支的null。
`sync/src/json.ts:116-122,129-140`现有实现已正确，无生产修改。它由
index.ts:170的真实apply→apply-batch.ts:144-148→apply-quarantine.ts:136→
change-payload.ts:36,40-46实际序列化调用，不是为测试新建的未接线副本或JSON替身。
本次无throw，不编造Err返回或catch任意异常；若出现throw须保栈再核公开错误边界，
不把潜在panic作业务Err吞掉。未运行Rust编译/差分，仅原源码/固定crate分支审读及
真实TS公开API最小回归：`20261105054602-d9151f`原exit0、1passed/40标题过滤、
无Errors。只原标题原NaN输入，不追加Infinity矩阵或扩签W33/所有serde行为。

### L23-W18/W20：保原时间文本的真实apply观察

Rust `tests/sync_weird_tests.rs:495-510`的pre_epoch/t与
`1969-12-31T23:59:59Z`，以及:533-555的nano/t与
`2026-05-01T12:00:00.123456789Z`均原样保留在payload.updated_at/changed_at，
deleted_at=null；W20还保原未用ts_ago(10)计算及同连接别名，不把该值替换nano。
TS两原标题通过私有newMemoryDb fixture调用真实F3 :memory:/原schema/触发器/
refinery行，复用已安装sync/public apply，分别打印Result。fixture不是时间解析或
apply副本，未改旧病例的磁盘fixture。无catch/私造Err分类或L20策略/解析修改；
1969旧注释不变成新校验，成功/拒绝/写入及纳秒落库值均不作新增断言。
唯一 `20261105060240-15cfcb` 原exit0、两原标题各passed/共41标题过滤、无Errors；
两例均正常返回success1/failure0仅作观察，不签完整时间处理精度。仅两行转ported，
W17及其它观察项仍逐项待判，未重跑已过P36/P40/目录/S108/W69或全集。

### L23-V2-1.3：Retry-After u64秒的精确解析与等待封顶

Rust `cloud_storage/webdav.rs:311-324`先parse::<u64>得到精确Duration，再min30s，
并接受u64原有`+`前缀。TS原Number(raw)*1000会丢精度、接受u64越界并误选30s等待，
也漏掉+3。现在只改数字分支：u64上界前以BigInt解析，精确毫秒在safe整数范围才
转number，unsafe时保bigint；cappedRetryAfter先比较30s上限，再将有界等待转number。
大数不进入计时器/IPC；HTTP-date分支、原窗口/重试/预算/指数退避原样保留，本次
不签HTTP-date与chrono的全域等价。parseRetryAfter内部helper返回number|bigint|null，
仅供本文件cappedRetryAfter及原测试调用；cappedRetryAfter仍返回number|null，未改
跨插件API、其它同名parser或复制新日期解析器。

补充三例覆盖u64::MAX精确毫秒/30s封顶、MAX+1拒绝、+3；原Rust
retry_after_parsing_and_cap(:2063-2089)全部既有输入/断言不变。先红
`20261105062952-911a4f`原exit1、3failed/41标题过滤、无Errors；修后整WebDAV
`20261105063307-6de124`原exit0、44/44、无Errors，boundaries
`20261105063307-05c5dd` exit0/2979files/0违规；typecheck
`20261105063307-2c37ae`已取回原exit0、无Errors。三补充不计新Rust行，该阶段TESTMAP656/202/1不变，
不连带签P04剩余数据边界、W69或正式gate。

### L23-W21/W22/W23：原时间形状/读取观察与固定源回执

Rust `tests/sync_weird_tests.rs:560-637`对应三原标题：W21先n/v1/Insert的
`...100000001Z` apply.unwrap，后以`...100000002Z`/v2更新并真实读取title打印，
不要求v2；W22 updated_at为原数值1747000000000、changed_at为now_ts，未预转
字符串；W23 updated_at和changed_at都为原空字符串，未用默认时间替换。
TS沿既有真实内存schema/F3/已安装sync公共apply，首调用异常直接传播对应unwrap，
其余正常返回打印Result/读取观察，无catch/私造Err分类/时间解析或coercion副本，
不新增成功/拒绝/落库政策。固定源checkpoint9b5f4210f/treee8d2b4e0，最小
`20261105064400-04a877`原exit0、3passed/43标题过滤、无Errors，前后源/用例/
配置/HEAD一致；实际title=v2及各success1/failure0仅是观察，W17仍未获批准。

后继新集成反馈指向旧仅测试WIP76bb，当前含c148实现；按反馈另固定同9b树执行
typecheck065253-5c3a54/boundaries065254-8da6b4（原exit0）与本lane目录
065254-247c2d（原exit1：950passed/1W69failed/20Docker未执行，无Errors），
WebDAV44/44及weird_sync46/46通过，不把既有W69豁免改称全绿。完整原job IDs、
冻结证据与W69首栈在 `pending/Retry-After-integration-receipt.md`。本批仅三行去向
转ported，不扩到W17/其它观察项，不在该次结果后重复求绿或签整lane。

### L23-V2-1.3-FTP：紧凑日期校验与MLSD/MDTM不同投影

固定suppaftp7.1.0：ListParser::parse_mlsx_time用chrono校验后取timestamp()整秒
投影SystemTime（负值as u64后checked_add失败回退epoch）；tokio mdtm用
NaiveDate::from_ymd_opt / NaiveTime::from_hms_opt，非法日期及秒60返回BadResponse。
Rust `ftp.rs:782-795`保UTC及FileSystem/FTP MDTM错误前缀。TS旧Date.UTC会滚动非法
日期并混淆整秒/闰秒，现复用现有公开F4 parseRfc3339做既有14位compact日期解码，
不复制parser：MLSD减去nanos只取原timestamp整秒，负纪元fallback0；MDTM秒范围
按原from_hms_opt，错误走既有FileSystem路径。无大小/重试/预算/原断言修改。

六补充先红 `20261105073524-b30864`原exit1、5failed/1passed/29过滤，无Errors；
固定源06867c21a/tree8891dadd后 `20261105074123-c98ffc` FTP35/35原exit0，
typecheck495e83/boundariesa16bba原exit0/无Errors。全部窗口源/测试/config/HEAD
未变，无目录/W69/S108/全集重跑。完整固定依赖源码URL、实际job IDs/冻结证明及
提交信息计数纠正在 `pending/FTP-calendar-receipt.md`。实际TESTMAP659/199/1不变，
六补充不增Rust行，不据此签POSIX/DOS/整个时间语义或整lane；交健康会话，不重复作业。

## 跨插件接线

- 已接线：`secrets`（`ctx.secrets.backup`，DSBK/E2EE 加密、密码校验、本机加密目录记忆）。
- 已接线：`backup`（`ctx.backup.hydrateCloudConfig`，SSOT 元数据替换 + SecureStore 凭据注入）。
- 已按 main `d5cd234aa`（L21 `19c023cd6`）公开契约接线：`backup.tryAcquireOperation(kind: 'backup'|'restore'|'prune')` 返回 `BackupOperationGuard`；L23 直接导入 `../backup/api.ts` 的类型与 `isOperationGuardError`，先取 guard 再构造 storage/manager，成功、异常、取消路径都显式 `release()`。官方 `OperationGuardError` 的 `busy`→`Validation`、`lock_io`→`FileSystem` 由其 `app_error` 原样穿过 kernel；旧镜像已删除。
- 外部消费待接线：`syncProvider.createStorage`（`dstu.backup` 生产路径仍通过 `ctx.reflect.get('syncProvider')` 读取，未在 `inject` 声明；需 L21 改为 `inject: ['syncProvider']` + `ctx.syncProvider`）。

## 平台：FTP 仅桌面

主代理决定（W08 第八轮）：FTP/FTPS 是仅桌面的提供方。

- 依据：Rust 在 Android 上编译期排除 FTP 后端（`cloud_storage/mod.rs:51,179`），`create_storage_with_capabilities` 的 Android 分支返回 `Configuration` + `details.code = E_FTP_UNSUPPORTED_ON_ANDROID`（mod.rs:271-275）。TS 的 FTP 传输直接基于 `node:net` / `node:tls`，移动端运行时没有等价能力。
- 声明：`DESKTOP_ONLY_PROVIDERS = ['ftp']`（`src/config.ts`，经 `api.ts` 公开）。
- 结构：插件主体（命令注册、hydrate、guard、manager 构造、`createPlatformStorage`）在 `src/entry.ts`，不导入 `src/ftp.ts`。桌面入口 `index.ts` 保留静态 `meta`，声明 `DESKTOP_PLATFORM`（`DESKTOP_CAPABILITIES` + FTP 传输），是插件内唯一在运行时导入 `ftp.ts` 的模块。将来的移动端入口以 `{ capabilities: ANDROID_CAPABILITIES, transports: {} }` 调用同一主体，`ftp.ts` 不进入它的闭包。下方历史验收记录里写的 `index.ts` 指当时主体所在的位置。
- 没有链接 FTP 传输的入口：按能力矩阵在校验阶段拒绝；注入的能力即使声称支持 FTP，`createPlatformStorage` 的 ftp 分支也返回同一平台错误（对应 Rust 的 `#[cfg(target_os = "android")]` 兜底分支）。两条路径都在任何网络 I/O 之前。错误码沿用 Rust 稳定契约 `E_FTP_UNSUPPORTED_ON_ANDROID`，前端 `src/utils/cloudStorageApi.ts` 按码映射文案。
- 移动端检查：`scan.mjs --mobile-readiness` 目前按 `index.ts`（桌面入口）计算，`ftp.ts` 会出现在 own 列表里，它属于仅桌面，不算移动端阻塞项。`tests/ftp_desktop_only.test.ts` 用扫描库断言：共享主体和 `api.ts` 的闭包不含 `ftp.ts`；桌面入口比共享主体多出的只有 `ftp.ts`（含 `node:net` / `node:tls`）；插件内只有 `index.ts` 在运行时导入它。插件有了 `mobile.ts` 之后，扫描器会改按它计算，`ftp.ts` 自然不再出现。
- iOS：Rust 只在 Android 排除 FTP（`cfg(not(target_os = "android"))`，iOS 构建会编入）。新移动端在 iOS 上同样没有原始 TCP 套接字，所以“仅桌面”覆盖整个 mobile 平台。移动端入口装配后，iOS 上拒绝 FTP 属于有意偏离 Rust，届时随入口登记 RF，前端按平台调整文案（错误码不变）。

## 命令 `cloud_storage_check_connection`

<!-- BEGIN GENERATED:cmd:cloud_storage_check_connection -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:297` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:718`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig
  - 结果：boolean · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_check_connection -->

- [x] 输入：`config` 先经 `hydrate_cloud_config` 用 SecureStore 覆盖所有凭据（mod.rs:297–305）；TS 侧 `hydrate` 直接调用 L21 `ctx.backup.hydrateCloudConfig` 做 SSOT 元数据替换与 SecureStore 凭据注入（src/entry.ts），不再信任 IPC 秘密。
- [x] 输出：成功恒为 `true`（mod.rs:304）。
- [x] 错误：配置校验失败为 `Validation`/`Configuration`，网络/认证失败为 `Network`（mod.rs:300–305）；不吞错、不改写文案。
- [x] 事件：无。
- [x] DB 读写：无数据库读写；只读 SecureStore 凭据。
- [x] 取消/并发：不注册取消令牌；每次调用新建 storage，无共享可变状态。
- [x] 时间/ID：无时间戳/ID 生成。

## 命令 `cloud_storage_delete`

<!-- BEGIN GENERATED:cmd:cloud_storage_delete -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:346` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:788`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, key: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_delete -->

- [x] 输入：`config`（hydrate 后）+ `key`（云端相对 key，禁止 `..` 穿越；webdav.rs:124–140）。
- [x] 输出：`null`；WebDAV 404 视为已删除（webdav.rs:810–817），S3/FTP 同语义。
- [x] 错误：网络/权限失败为 `Network`；非法 key 为 `Validation`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消令牌；删除是单请求，幂等。
- [x] 时间/ID：无。

## 命令 `cloud_storage_exists`

<!-- BEGIN GENERATED:cmd:cloud_storage_exists -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:370` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:822`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, key: string
  - 结果：boolean · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_exists -->

- [x] 输入：`config` + `key`。
- [x] 输出：`stat(key) !== null`（traits.rs:340–350）。
- [x] 错误：仅元信息请求失败时抛 `Network`；对象不存在不是错误。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无。
- [x] 时间/ID：无。

## 命令 `cloud_storage_get`

<!-- BEGIN GENERATED:cmd:cloud_storage_get -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:322` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:753`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, key: string
  - 结果：integer(u8)[] | null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_get -->

- [x] 输入：`config` + `key`。
- [x] 输出：对象字节数组；不存在返回 `null`（mod.rs:322–330）。走默认内存预算 `MEMORY_GET_DEFAULT_BUDGET_BYTES`，声明长度超预算在读取前拒绝（webdav.rs:765–778）。
- [x] 错误：半包/长度不符/停滞为 `Network`，文案含“已拒绝（请重试）”；超预算为 `Network`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：读取循环受 90 秒分块停滞保护；取消令牌由调用方设置。
- [x] 时间/ID：无。

## 命令 `cloud_storage_is_s3_enabled`

<!-- BEGIN GENERATED:cmd:cloud_storage_is_s3_enabled -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:737` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1029`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：（无）
  - 结果：boolean
<!-- END GENERATED:cmd:cloud_storage_is_s3_enabled -->

- [x] 输入：无。
- [x] 输出：恒为 `true`——Host 构建内直接实现 S3 传输（`S3Storage`），等价 Rust `cfg!(feature = "cloud_storage_s3")` 在桌面构建中的结果（mod.rs:735–739）。
- [x] 错误：无。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步返回，无。
- [x] 时间/ID：无。

## 命令 `cloud_storage_list`

<!-- BEGIN GENERATED:cmd:cloud_storage_list -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:334` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:771`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, prefix: string
  - 结果：FileInfo[] · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_list -->

- [x] 输入：`config` + `prefix`；WebDAV 递归遍历子目录（上限 200 目录，webdav.rs:1450–1510）。
- [x] 输出：`FileInfo[]`，按 `lastModified` 倒序（webdav.rs:1506）；`size` 为字节数，`etag` 可缺省。
- [x] 错误：列表请求/XML 解析失败为 `Network`；目录不存在时 WebDAV 返回空列表而非错误。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：限流等待可被取消令牌打断；无共享状态。
- [x] 时间/ID：`lastModified` 统一 RFC3339 UTC。

## 命令 `cloud_storage_put`

<!-- BEGIN GENERATED:cmd:cloud_storage_put -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:309` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:735`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, key: string, data: integer(u8)[]
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_put -->

- [x] 输入：`config` + `key` + 字节数组；WebDAV 先确保父目录存在（`MKCOL`，目录缓存去重，webdav.rs:390–400）。
- [x] 输出：`null`；HTTP 2xx 即成功（webdav.rs:747–759）。
- [x] 错误：非 2xx 为 `Network`，文案含状态码；非法 key 为 `Validation`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：单请求；重试仅对 423/5xx 且受 `Retry-After` 约束（webdav.rs:270–330）。
- [x] 时间/ID：无。

## 命令 `cloud_storage_stat`

<!-- BEGIN GENERATED:cmd:cloud_storage_stat -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:358` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:805`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, key: string
  - 结果：FileInfo | null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_storage_stat -->

- [x] 输入：`config` + `key`。
- [x] 输出：`FileInfo | null`（404 返回 `null`，webdav.rs:819–824）。
- [x] 错误：网络/解析失败为 `Network`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无。
- [x] 时间/ID：`lastModified` 为 RFC3339 UTC；缺失/非法时间用 epoch 兜底（s3.rs:1040–1060）。

## 命令 `cloud_sync_delete_version`

<!-- BEGIN GENERATED:cmd:cloud_sync_delete_version -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:714` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:917`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, versionId: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_sync_delete_version -->

- [x] 输入：`config`（hydrate 后）+ `versionId`；先取 L21 `backup.tryAcquireOperation('Prune')`（对应 Rust `DataGovernanceOperationGuard::try_acquire(Prune)`，mod.rs:714–726），删除完成或失败后在 `finally` 显式 `release()`。
- [x] 输出：`null`；先更新 manifest 再删对象（pruned manifest-before-GC，sync_manager.rs:1300–1400）。
- [x] 错误：版本不存在为 `Validation`；对象删除失败为 `Network`；guard 冲突为 `Conflict`。
- [x] 事件：无（Rust 删除不推进度）。
- [x] DB 读写：无。
- [x] 取消/并发：manifest 更新走 `verified_publish`，回读不一致即失败。
- [x] 时间/ID：manifest `updatedAt` 为当前 UTC。

## 命令 `cloud_sync_download`

<!-- BEGIN GENERATED:cmd:cloud_sync_download -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:552` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:898`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, versionId?: string | null, localDir: string, allowPlaintextHistory?: boolean | null
  - 结果：DownloadResult · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_sync_download -->

- [x] 输入：`config`、可选 `versionId`（缺省取最新）、`localDir`、`allowPlaintextHistory`（缺省 false，仅本次调用生效，mod.rs:552–580）；先取 L21 guard(Restore)。
- [x] 输出：`{ version, localPath }`；DSBK 密文解密后原子改名覆盖 `localPath`（mod.rs:640–690）。
- [x] 错误：加密标记存在但对象非 DSBK → 防降级 `Validation`（`E_SYNC_E2EE_DOWNGRADE_REJECTED`），并删除已下载文件；缺密码 → `Configuration`（`E_SYNC_E2EE_PASSWORD_REQUIRED`）；解密失败 → `Validation`（`E_SYNC_E2EE_WRONG_PASSWORD`）。
- [x] 事件：`cloud-sync-progress`，`operation=download`，先发 `transferring 0/0/0`，逐块 `done/total`（≤95），完成发 `done 100`（mod.rs:206–230、600–700）。
- [x] DB 读写：无。
- [x] 取消/并发：下载流受取消令牌/停滞保护；同一本地目录并发下载由调用方串行化，临时文件随机命名。
- [x] 时间/ID：事件 `operationId` 来自 L21 guard；`version.timestamp` 为 RFC3339 UTC。

## 命令 `cloud_sync_get_device_id`

<!-- BEGIN GENERATED:cmd:cloud_sync_get_device_id -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:731` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:931`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：（无）
  - 结果：string
<!-- END GENERATED:cmd:cloud_sync_get_device_id -->

- [x] 输入：无（读 `ctx.app.dataDir`）。
- [x] 输出：稳定设备 ID：优先 primary 文件，其次 legacy 文件，最后生成并原子写入（device_id.rs）。
- [x] 错误：持久化失败时仍返回本次生成的 ID（与 Rust `get_device_id` 一致），不向 IPC 抛错。
- [x] 事件：无。
- [x] DB 读写：无数据库；读写 dataDir 下设备 ID 文件。
- [x] 取消/并发：进程内串行 await；原子写避免半文件。
- [x] 时间/ID：新 ID 为随机串；不随时间变化。

## 命令 `cloud_sync_get_status`

<!-- BEGIN GENERATED:cmd:cloud_sync_get_status -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:384` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:838`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig
  - 结果：SyncStatus · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_sync_get_status -->

- [x] 输入：`config`（hydrate 后）。
- [x] 输出：`SyncStatus`：`connected`、`cloudVersionCount`、可选 `latestVersion`、`lastSyncTime`、`error`、`encryptionMemoryPersistFailure`（sync_manager.rs:180–240）。
- [x] 错误：连接/manifest 读取失败写入 `error` 并 `connected=false`，命令本身仍成功（与 Rust 一致）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无。
- [x] 时间/ID：`lastSyncTime` 为 RFC3339 UTC 或 null。

## 命令 `cloud_sync_list_versions`

<!-- BEGIN GENERATED:cmd:cloud_sync_list_versions -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:396` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:851`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig
  - 结果：BackupVersion[] · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_sync_list_versions -->

- [x] 输入：`config`（hydrate 后）。
- [x] 输出：合并所有 per-device manifest 后的版本数组，按 `timestamp` 倒序（sync_manager.rs:600–700）。
- [x] 错误：manifest 读取/解析失败为 `Network`/`Validation`；单个坏 manifest 不阻断其它设备（与 Rust 合并策略一致）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无。
- [x] 时间/ID：返回既有 `timestamp`，不重新生成。

## 命令 `cloud_sync_upload`

<!-- BEGIN GENERATED:cmd:cloud_sync_upload -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:410` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:870`）
- 契约：`contracts/ipc/L23-sync-providers.json`
  - 参数：config: CloudStorageConfig, zipPath: string, appVersion?: string | null, note?: string | null, recoveryKind?: string | null
  - 结果：UploadResult · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_sync_upload -->

- [x] 输入：`config`、`zipPath`、可选 `appVersion`/`note`/`recoveryKind`；先取 L21 guard(Backup)，再按加密策略校验/登记密码校验子（mod.rs:410–470、sync_manager.rs:900–1100）。
- [x] 输出：`{ version, prunedVersions }`；新版本 ID 为 22 位随机十六进制，`size` 为上传对象字节数，`checksum` 为 SHA256。
- [x] 错误：有密码但云端标记密码不一致 → `Validation`（`E_SYNC_E2EE_WRONG_PASSWORD`），且在任何 `backups/` 写入前失败；无密码但已有加密标记 → `Validation`（`E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED`）；标记损坏 → `Validation`（`E_SYNC_E2EE_MARKER_CORRUPTED`）；上传后远端大小/清单回读不一致 → `Network`/`Conflict`，并回滚对象。
- [x] 事件：`cloud-sync-progress`，`operation=upload`，先发 `transferring 0/fileSize/0`，逐块 ≤95，完成发 `done 100`（mod.rs:470–545）。
- [x] DB 读写：无。
- [x] 取消/并发：上传流受取消令牌；E2EE 认领用 pending+租约+双重复核，manifest 用 verified_publish；临时加密文件随机命名并在成功/失败路径删除。
- [x] 时间/ID：`version.timestamp` 为当前 UTC；`operationId` 来自 L21 guard；版本 ID 随机。

## 事件 `cloud-sync-progress`

<!-- BEGIN GENERATED:event:cloud-sync-progress -->
- 事件名 `cloud-sync-progress`
- 发送点：`src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:206`（emit）
<!-- END GENERATED:event:cloud-sync-progress -->

- [x] 载荷：`{ operationId, operation, stage, stageLabel, bytesDone, bytesTotal, percent }`（mod.rs:186–200；契约 `CloudSyncProgressEvent`）。
- [x] 触发时机与顺序：上传/下载开始各发一次 `transferring`（0 字节），传输回调逐块发 `transferring`，成功后发 `done`（100）；失败不发 `done`（mod.rs:470–545、600–700）。
- [x] 节流/合并：不节流，按底层上传/下载回调逐块发送；`operationId` 用于区分并发操作，迟到事件不会串台。
- [x] 是否在事务提交后：无数据库事务；`done` 在对象/清单写入成功并完成校验后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` 全局广播（mod.rs:204–210），Host 侧 `ctx.backendEvents.emit` 对应全部监听者。

## 验收问题处理（R4-review-sync，2026-11-04）

本节逐条记录独立验收人 R4 的“必须修复”项。`ACCEPTANCE.md` 归验收人所有，本 lane 不修改。
代码/测试提交：`5ac7944d5`（实现）、`b5b2b732c`（命令级与 manifest 测试）、`59f0c3fb7`（传输/身份测试与 S3 夹具）。

| 编号 | 处理结果 | 证据 |
|---|---|---|
| P01 | 已修复。`src/config.ts` 新增 `configErrorToAppError`：`CloudStorageConfigError` 无 code → `Validation`，有 code → `Configuration` + `details.code`；`index.ts createStorage` 统一捕获并抛 `CloudStorageError`，命令边界返回 AppError 对象而非 panic/普通 Error。 | `src/config.ts`（`configErrorToAppError`）、`index.ts`（`createStorage` catch）；`tests/commands_errors.test.ts` 覆盖 `createStorage({})`、命令级 `cloud_storage_check_connection` 的 `{error_type,message,details}` 完整载荷；Rust `cloud/mod.rs:279-291`。 |
| P02 | 已修复。`providerKey` 先归一化 serde 外部标签 map 形式（`{webdav:null}`/`{s3:null}`/`{ftp:null}`）与缺省 provider（`#[serde(default)]` → WebDAV），`validateConfig` 与 `createStorage` 共用归一化结果，map-form 不再绕过 HTTPS/凭据/能力校验。 | `src/config.ts`（`providerKey`、`validateConfig`）；`tests/commands_errors.test.ts` 的 map-form 公网明文拒绝、loopback 通过、空用户名拒绝与命令级拒绝；Rust `cloud/config.rs:216-245`、`cloud/mod.rs:228-245`。 |
| P03 | 已按 main `d5cd234aa`（L21 `19c023cd6`）正式契约修复。删除旧 guard 镜像 `src/backup_operation_guard.ts`，直接从 `../backup/api.ts` 导入 `BackupOperationGuard`/`DataGovernanceOperationKind`/`isOperationGuardError`；`acquireOperation` 直接调用 `ctx.backup.tryAcquireOperation(kind)`，让官方 `OperationGuardError`（`reason`/`code`/`app_error`/`value` 同对象）原样穿过 kernel：`busy`→`Validation`、`lock_io`→`FileSystem`。不再检查 `operationBusy` 布尔，不再按 `CommandError(string)` 猜锁 IO。`DataGovernanceOperationKind` 为 serde snake_case，upload/download/delete_version 分别传 `backup`/`restore`/`prune`；先取 guard 再构造 storage/manager 与设备 ID，成功、异常、取消路径都在 `finally` 显式 `release()`；只有结构化 `isOperationGuardError` 的 release 失败记录 warn，未知 TypeError/编程错误保持 panic。 | `index.ts`（`withOperation`/`acquireOperation`）；`tests/commands_transfer.test.ts` 使用 main 官方 `OperationBusyError` / `OperationLockError` 覆盖 busy→Validation、锁 IO→FileSystem、未知 TypeError panic、release 编程错误 panic、release IO 容忍、先 acquire 后校验、成功/失败均释放；main 树最小复验见 `BLOCKERS.md` §7。 |
| P04 | 已修复。`decodeManifest` 使用 token 级 JSON 解析器（2026-11-04 增量：未知字段内的重复键按 serde `IgnoredAny` 忽略、`__proto__` 作为普通未知键不参与必填判定；类型错误带实际值且位置取该值末尾字节列；嵌套缺字段定位到嵌套对象右侧；`version.size` 在续传/首块密码计划内保持 `bigint`，仅平台 crypto 参数边界转 Number）：保留原始数字 token（`1.0`/`1e2` 不能冒充 u32/u64）、拒绝重复结构性字段、`u64` 全程 `bigint` 且不再用 `MAX_SAFE_INTEGER` 拒绝合法值；解析/类型/缺失字段错误带 `line/column`；`DateTime<Utc>` 按 chrono serde 输出 `Z`（AutoSi），而非 `+00:00`。manifest 序列化直接写十进制 `u64` token，避免 `JSON.stringify` 抛 bigint 或丢精度；IPC 边界才转 number。 | `src/json_exact.ts`、`src/sync_manager.ts`（`ManifestVersion`/`decodeManifest`/`encodeManifest`/`toWireVersion`）；`tests/manifest_decode.test.ts` 覆盖 `1.0`、重复 `version`/`id`、u64 最大值与精确 round-trip、line/column、`Z` 规范化；Rust `cloud/sync_manager.rs:104-143`。 |
| P05 | 已修复。manifest 排序、`latest`、`updatedAt` 与设备 `lastSyncTime` 合并改用 `bigint` 纳秒比较（`parseRfc3339().epochNanos`），同毫秒内保持真实先后；ID 仅作完全相等时 tie-break。 | `src/sync_manager.ts`（`timestampNanos`、`mergeManifest`、`deviceLastSyncTime`）；`tests/manifest_decode.test.ts` 的 `.123000001`/`.123999999` 与重复 ID 用例；`tests/sync_manager.test.ts`；Rust `cloud/sync_manager.rs:416-428`。 |
| P06 | 改为薄正式调用，待 F4 集成。命令与 manager 只调用 F4 `paths.dataSpaceDeviceId()`；`src/device_identity.ts` 不再重写 env 优先级、legacy 迁移、WeakMap 进程缓存或错误日志，也不再提供 optional method fallback / `WithoutMethod` 测试桥。F4 `d85995b4b`/`679b53948` 的正式方法与 production logger 已实现（F4 自有 6 身份场景测试 job `20261104063141-9a504c` 通过），但未进 main；缺失方法按编程错误 panic 传播，4 条 `sync_android_*` 身份集成测试在 main 树条件跳过，TESTMAP 记 pending。main 集成后无需改 L23 生产代码即可运行。 | `index.ts`、`src/device_identity.ts`；`tests/device_identity.test.ts` 保留薄调用/错误透传测试，以及两条真实子进程探针（成功退出、跨进程持久化/轮换）；Rust `storage/data_space/device_id.rs:62-230`、`cloud/mod.rs:731-733`。组合 F4 树验证见本轮验证记录。 |
| P07 | 已修复。上传先创建加密临时文件（失败 `FileSystem`“创建加密临时文件失败”），加密失败仍为 `Unknown`；上传成功后先删除加密临时文件，再 emit `done`；失败路径同样清理。下载打开失败 `FileSystem`，短头保留文件并带 `read_exact` 的 `failed to fill whole buffer`；解密临时文件创建失败 `FileSystem`，错密码 `Validation`；成功后原子改名。密码判空用 Rust `!is_empty()`（`nonEmptyPassword`）。 | `src/cloud_transfer.ts`、`src/cloud_commands.ts`、`index.ts`；`tests/cloud_transfer.test.ts` 覆盖失败分支及“done 时临时文件已为 0”；Rust `cloud/mod.rs:453-460,627-641,663-700`。 |
| P08 | 已修复。防降级两条用例补 `AppErrorType::Validation`、`details=null` 与错误原文断言；Android FTP/S3 拒绝断言精确到 `Configuration` + `details.code` + 完整 message；`mobile_feature_profiles_exclude_s3_backend` 直接读 `src-tauri/Cargo.toml`，断言 `mobile-slim`/`android-release` 不含 `cloud_storage_s3` 与独立 `"ftp"`、`default` 含 `cloud_storage_s3`；S3 virtual-hosted 用例用自带 `lookup` 的 `http.Agent` 解析本地 fake server，保留 Host 与网络请求断言。Docker 20 条未执行，只记“未执行”。 | `tests/mod.test.ts`、`tests/commands_transfer.test.ts`、`tests/sync_android_platform.test.ts`、`tests/s3.test.ts`；Rust `cloud/mod.rs:785-799,827-837`、`sync_android_device_switch.rs:657-690`。 |
| P09 | 已修复。上传/下载/删除的业务编排移入 `src/cloud_commands.ts`（含加密临时文件清理时序、防降级、下载后处理、进度事件），`index.ts` 只保留命令注册、hydrate、guard、manager 构造与端口接线；`config.ts` 使用平台 Rust 语义 `trim`，`device_id.ts` 不再手写 trim。 | `index.ts`、`src/cloud_commands.ts`、`src/cloud_transfer.ts`、`src/config.ts`、`src/device_id.ts`；边界 strict 扫描本 lane 0 命中；Rust `cloud/mod.rs:411-710`。 |

### 本轮验证记录（2026-11-04）

#### v2 接手修正与 Linux 门禁（GPT-6 Astra）

- 基线 `20261104093418-c5b7bf` exit1：8 failed suites，11 failed / 632 passed /
  65 skipped，**Errors 3**（worker RPC timeout）。三个 paths fixture 未适配正式
  F4 方法；proptest/deep/pathological 将 Rust `open_in_memory` 错译为每次磁盘 fsync。
  恢复内存 SQLite（Rust sync_proptest.rs:28、sync_integration_deep_tests.rs:19、
  sync_pathological_tests.rs:16），原样本数、原 expect 不变。定向
  `20261104102629-a1ab18` exit0，94/94 passed，无 Errors。
- 再合 main 后要求的三门禁：`20261104104944-768305` typecheck exit0；
  `20261104104944-02bf49` boundaries exit0（2399 files, 0 violations）；
  `20261104104944-16a44a` 本插件全套 exit0，**775 passed / 20 skipped**，
  56 passed / 1 skipped files，无 Errors/Unhandled。20 skipped 是原 Docker 条件，
  没有设备 API 门控跳过。此结果不证明 TESTMAP pending 已完成。
- P08 config 原 `config.rs:749-754 assert_eq!`：`.toThrow(string)` 改为首尾锚定
  完整 message；拒绝任何前后缀，生产 validateConfig 路径不变。
- P08 两条正式身份测试按原 Rust（sync_android_restart.rs:864-912、
  sync_android_device_switch.rs:1096-1140）改成每次真实子进程，并补回显式
  `is_file`、old/new 输出存在断言；删除运行时 owner 可用性门控，缺接口测试改为
  显式注入缺方法故障，仍断言 HandlerPanic。定向 `20261104104756-de3dfa`
  exit0，20/20 passed，无 Errors。另恢复被 da290fd2e 删除的 hostname/env/
  primary/legacy/default dirs/持久化与迁移日志断言，均调用生产 kernel 命令与真实 F4。
  恢复后 `20261104105453-914e66` exit0，14/14 passed，无 Errors；device_identity
  文件的 expect 从 36 增至 55（含原子进程/落盘的原断言，非计数填充）。
- 对旧 `commands_transfer` 30→27 的逐断言核查（3628c40c5）：删掉 1 条直接
  `throw AppError.file_system(...)` 的裸对象透传断言，以及缺 release 方法的
  2 条断言（panic、文件不存在）。前者不是正式 L21 `OperationGuardError extends
  CommandError` 契约；后者“下载前验证 release 存在并不写文件”是已删除本地镜像
  的额外预检，不是 Rust mod.rs:560-567 的 RAII 行为。正式 busy/IO 的完整
  AppError 对象、未知程序错误的 panic、失败/成功路径 release 与下载内容断言仍在。
  这 3 条不是 Rust 原测试断言；提交旧说明把所有下降笼统归镜像不够准确，
  不能据此推断 device_identity 被删行为无需保留（本次已恢复）。

#### P04 marker / lease 按 Rust struct 解码 + quality.md 拆分（Claude Opus 5.5）

- 新 `src/serde_struct.ts`：serde derive `Deserialize` 语义（map 形式：已知字段按文档顺序
  解码、重复已知字段 `duplicate field`、未知字段忽略、`#[serde(default)]` 缺省、
  其余缺失 `missing field`；seq 形式：按声明顺序取位，过短 `invalid length`，过长拒绝）。
  `fromSlice` 对应 `serde_json::from_slice`（严格 UTF-8、不跳 BOM）。manifest 解码迁到
  `src/manifest.ts` 并复用同一实现，错误文本不变。
- `EncryptionMarker`（sync_manager.rs:162-174）与 `PasswordVerifier`
  （backup_crypto.rs:908-923）逐字段解码：u32 必须是整数 token 且在范围内，
  `createdAt` 按 `DateTime<Utc>` 解析并以 `Z` 规范化，`keyVerifier` 缺省或 null 为 None，
  verifier 六个字段全部必填。读取（sync_manager.rs:878-905）、认领快照
  （e2ee_claim.rs:281）、仓库检查（repo_check.rs:394）三处都改用它；失败仍按 Corrupted
  fail-closed 并保留原 warn 文本。
- `EncryptionClaimLease`（e2ee_claim.rs:137-147）逐字段解码 + `structurally_valid`
  （:174-180）：nonce 按 `Uuid::parse_str` 接受 simple/hyphenated/braced/urn，时间用
  `parse_from_rfc3339`（原 `Date.parse` 过宽），到期比较精确到纳秒。解码失败等同 `.ok()` 的
  None，按 `last_modified + ttl` 回退。
- 流式重写（R4 §13 反例）：`src/serde_struct.ts` 改为按 serde_json 1.0.149 `de.rs`/`read.rs`
  (SliceRead)/`error.rs`、serde_derive 1.0.228、serde_core 1.0.228、zmij 1.0.21、chrono 0.4.41
  源码移植的字节流解析器，删除先整树解析的 `json_exact.ts`（X6-UD-0078）。类型错误、
  `duplicate field`（在解析第二个值之前）、`missing field` 先于后续语法错误和 `end()` 的
  trailing；列号按字节（emoji 4 字节）；`-0` 与大于 u64 的整数按 F64 拒绝，浮点文本按 zmij
  格式（`100.0`、`1.8446744073709552e+19`）；`null` 显示为 `null`，字符串按 Rust Debug。
  dstu-sync/Cargo.toml:38 启用了 `arbitrary_precision`：非整数数字出现在字符串字段时报
  `invalid type: number`，已按该特性实现。`DateTime<Utc>` 的类型错误期望文本按 chrono
  visitor 为 `an RFC 3339 formatted date and time string`，原 manifest_decode 断言
  “expected a string”与 Rust 不符，已按 chrono serde.rs:58-60 改正。
- 未核实项：Rust `str` Debug 的可打印/字素扩展表用 Unicode 类别近似；chrono `FromStr`
  （`parse_rfc3339_relaxed`，可接受空格分隔、`UTC` 等）与其 `ParseError` 文案未移植，仍用
  严格 `parse_from_rfc3339` 与自造文案（serde_struct.ts `decodeUtcTimestamp`）；serde_json
  非 float_roundtrip 的 f64 舍入可能与 JS `Number()` 差 1 ulp。本机无 Rust 工具链，未执行 Rust。
  同步/备份租约的 JSON 边界已在下述 P04 增量处理；上述 chrono/Debug/f64 缺口仍开放。
- quality.md §4 拆分：sync_manager.ts 1232 → 约 765 行；manifest 模型 →
  `manifest.ts`，密码试解 → `password_proof.ts`，serde 语义 → `serde_struct.ts`。
- 测试：`tests/marker_lease_decode.test.ts` 全部走生产入口
  （`CloudSyncManager.readEncryptionMarker`/`ensurePlaintextUploadAllowed`、`runRepoCheck`、
  `claimEncryptionMarker`）。

#### P04 同步/备份租约增量：复用既有字节 reader

`SyncTargetLease`（sync_lease.rs:49-59）与 `BackupRepoLease`（backup_lease.rs:56-66）
同为 snake_case derive：format_version 是 u32；target/holder_device_id/operation_id/
created_at/expires_at 是必填 String；activation_committed 是 `#[serde(default)] bool`，
**缺失默认 false，显式 null 错误**。`lease.ts` 删除 JSON.parse，复用 `fromSlice` /
`decodeStruct` / `decodeU32` / `decodeString`；既有 reader 补齐 serde_json de.rs:1469-1497
与 serde_core BoolVisitor 的 bool 读取。没有新建 parser、crypto 副本或 marker 包装。

| Rust 分支（sync_lease.rs / backup_lease.rs） | TS 落点及结果 |
| --- | --- |
| :202 / :178 写后回验 from_slice | `lease.ts::putVerified` → 同一 decodeLease(spec, bytes)，解码失败保留 Network 与各自“回验…内容失败”前缀 |
| :265 / :241 扫描 `.ok().filter(structurally_valid)` | `scanActiveLeases` → tryDecodeLease；非法 u32 token、重复已知字段、null bool、已知字符串非法 UTF-8 都变为损坏租约，使用 last_modified+TTL，不信任其内层 expires_at |
| :303 / :279 释放前 from_slice | `releaseOwnedCandidate`；损坏则 Network/“释放…前解析失败”，不执行删除 |
| :330 / :306 心跳 from_slice | `renewOwnedCandidate`；损坏则 Conflict/“…在持有期间损坏”，错误由已有 heartbeat 记录；不静默续租 |

`tests/lease_decode.test.ts` 的补充回归通过 api.ts 公开获取入口覆盖两个协议与四条读取路径。
旧实现先复现 `20261104165152-02af9c` exit 1，14 failed / 4 passed，无 Errors；修复后
相关六文件 `20261104165503-0bfed3` 80/80、exit 0、无 Errors，追加释放/心跳检查后
`20261104165900-a130a9` 22/22、exit 0、无 Errors。还保留 Rust 合法输入：缺省 bool、
未知重复字段、derive struct 数组、未知 IgnoredAny 字符串内非法 UTF-8。回验 bool 错误全文为
`invalid type: null, expected a boolean at line 8 column 30`。这些是 supplemental，不增加
TESTMAP 原 Rust 测试行或签收数；共享 F4 reader 的三项语义需求仍按 BLOCKERS 等待提供方。

#### P04 租约时间：纳秒排序、过期与 Display

原 `lease.ts` 把 DateTime 字段降到 epoch milliseconds；同毫秒的不同 created_at 会
误走 UUID tie-break，expires_at 或损坏对象 last_modified+TTL 晚于 now 1ns 也会被
提前回收，held 错误的 AutoSi 分数被截断为三位。

| Rust 来源（sync_lease.rs / backup_lease.rs） | TS 落点 |
| --- | --- |
| :173-178 / :149 compare_contenders 的 DateTime cmp | `leaseCreatedAt` 用 F4 parseRfc3339.epochNanos，BigInt 比较；仅相等时使用原 UUID tie-break |
| :268-274 / :244-249 last_modified+ttl / expires_at <= now | `fallbackExpiry` / `scanActiveLeases` 保留 parsed epochNanos 与 TTL 纳秒，边界保持 <=，不把 +1ns 向下取整 |
| :63-80 / :69-86 new；:337 / :313 renewal | 实际获取/续租调用 F4 nowEpochNanos/toRfc3339，内部时钟参数和 fallback 全程 BigInt；ttlMs 只做单位换算，不重写时区解析 |
| :124-129 / :131-136 expires_label | sync_lease.ts / backup_lease.ts 用 F4 toRfc3339 保留 AutoSi 纳秒和 UTC +00:00 |

`tests/lease_time.test.ts` 是 supplemental：两个协议的 8 个反例先复现
`20261104202337-f23627` exit 1（8 failed、无 Errors），修复后相关 5 文件
`20261104203016-212292` 48/48、exit 0、无 Errors；14 个时间用例包含等时回收、
等时不同 offset 的 UUID 排序、原 TTL 加法等正向分支。原测试的固定时刻只按等值
ms→ns 转换夹具字段/参数，原断言数量、值与方向未改变。内部 helpers 不在服务公共面，
直接统一为 bigint 纳秒，不引入双单位兼容层。TESTMAP 不因补充用例提级。

#### P04 租约持有者：复用 F4 Rust trim

Rust sync_lease.rs:64/75/102（backup_lease.rs:71/82/109）分别在创建非空校验、
写入规范化和外部对象 structurally_valid 中使用 str::trim；同步租约 :132-138
同样用它比较本机 ID。TS 五处原 String.trim 会误删 U+FEFF，却保留 Rust 会去除的
U+0085（NEXT LINE）：可将不同持有者混同、拒绝 Rust 有效的 BOM-only ID，或
信任 blank NEL 外部对象的 expires_at。现五处直接调用 main 的 F4 util/index.ts
公开 rustTrim，未新增 Unicode 表/正则、未改设备 ID 其他生成或缓存规则。

`tests/lease_holder.test.ts` 经 api.ts 的实际获取/held-error 路径做 supplemental：
先复现 `20261104205939-fa0b93` exit 1，10 failed、无 Errors；修复并补齐外部
structurally_valid 的有效/损坏正反分支后，`20261104210342-806b34` 六文件
62/62、exit 0、无 Errors。Unicode 用例共 14 条；原移植断言/TESTMAP 不变。
主线 W69 性能和共享 reader 等阻塞不因此关闭，仍需 main 后独立复验。

#### P04 加密标记认领租约：补齐相同的 trim/纳秒边界

`e2ee_claim.rs:150-176` 的创建和 structurally_valid 同样用 Rust trim；原 TS 另有
三处 JS trim，现直接用 F4 rustTrim。`:315-321` 超限对象 fallback、`:339-352`
普通损坏对象 fallback/有效租约错误 Display 都是 DateTime，现复用 F4 nowEpochNanos /
parseRfc3339 / toRfc3339，按 BigInt 纳秒比较与输出，不再 Date.parse/Number 降毫秒。
相等到期仍按原 `expires_at > now` 的反面回收，+1ns 的对象保持活跃，超限路径仍
在读取 body 前检查。已有毫秒→纳秒的单位换算移至本 lane time.ts 复用；未新增解析器。

`e2ee_claim_boundaries.test.ts` 通过真实 claimEncryptionMarker、原生产 marker encoder
与外部 MemoryStorage/metadata 输入覆盖 12 个补充用例；只控制标准测试时钟。
最早 `20261104220212-2eb696` exit 1（10 failed）含一个 fixture Buffer/Uint8Array
表示比较错误；统一 marker 字节表示后，生产未改的 `20261104220409-abd0a7` exit 1
（9 failed / 1 passed）才是有效反例基线。实现修复后 `20261104220727-bcf23f`
exit 1（3 failed / 84 passed）、`20261104220940-185e7d` exit 1（3 failed /
86 passed）的三处余错仍是 fixture typed-array/Buffer 构造类型比较；改为同字节值的
Buffer 对比，不减任何数据值/保留对象要求。最终 `20261104221443-8a3cd8` 六文件
89/89、exit 0、无 Errors；原始失败日志均保留，不把 fixture 错误冒称生产缺陷。
新增 12 条仍为 supplemental，不提升 TESTMAP，不关闭整个 P04。

#### P04 UUID：精确采用 Rust 允许的四种形状

锁定 uuid 1.20.0（Cargo.lock:14004-14005）的
[`src/parser.rs::try_parse`](https://raw.githubusercontent.com/uuid-rs/uuid/v1.20.0/src/parser.rs)
仅接受 simple 32 字节，或 hyphenated 36 / braced 38 / urn 45 字节，后两种包装
必须包含 hyphenated UUID。原 `isUuid` 连续剥掉 urn 和 braces 后同时接受 simple，
误接受 braced-simple、urn-simple、urn-braced，可能信任畸形租约内部的过期时间。

现先按准确形状/长度选分支，再用原 ASCII hex/hyphen 校验；不 trim UUID、不限制
version/variant 位，不引入 NPM parser 或新密码/JSON 实现。该 predicate 同时服务
同步/备份 operation_id 和 EncryptionClaimLease.nonce，外部失效继续按原 TTL fallback。

`lease_uuid.test.ts` 全部经三个实际协议入口；初始三种错误包装
`20261104230901-8ccf84` exit 1（9 failed / 21 passed），追加已正确拒绝的 LF 控制后
`20261104231104-a3afa9` exit 1（9 failed / 27 passed），均无 Errors。修复后
`20261104231345-08b2cd` 五文件107/107、exit 0、无 Errors，36 个补充用例保留
nil、全 f、大写和四种有效形式；没有把既有 LF 拒绝行为冒称新修复或提升 TESTMAP。

#### 下载缓冲的字节所有权（Rust Vec vs Node Buffer）

traits.rs:273-276 的 BoundedMemoryBody.push 在预算判断后 extend_from_slice，拥有
输入字节快照。TS 原 chunk.slice 对 Uint8Array 会复制，对实际 HTTP/S3 输入 Buffer
却只建立共享视图；输入重用/修改会改变已收集的数据。现仅改为 Uint8Array.from，
保留预算判断顺序与原 len 记账，不添加哈希、协议分支或兼容层。子视图只复制有效范围。

补充回归 `20261104235153-1714e6` exit 1（2 failed / 8 passed，无 Errors）区分了
Buffer/Buffer view 的错误与 Uint8Array 正向控制。修复后 `20261104235457-37bc5f`
traits/S3/WebDAV 三文件90/90、exit 0、无 Errors；typecheck4b0e27 exit 0。
原移植断言/TESTMAP 不变，这不是 W69 的生产性能修复。

P04/P08 仍未由复核人签收：下表旧“已修复”仅为历史实现者记录，不能替代
ACCEPTANCE 判定。P04 的首块 bigint、serde timestamp Display/错误先后仍有缺口；
P08 的 pending/Docker 未执行仍保留。

- P06 主树最小集：作业 `20261104071123-5baa22`（`device_identity.test.ts` + `commands_transfer.test.ts` + `commands_errors.test.ts`），退出码 0，26 passed / 4 skipped；4 skipped 为等待 F4 正式接口的持久化/轮换与两条子进程探针。
- typecheck：作业 `20261104071041-c62efb` 退出码 0，无 Errors。
- P06 组合 F4 树：`/tmp/opencode/L23-P06-F4-679b-ksvVl6`（F4 `679b53948` 全树 + 本 lane 当前代码），作业 `20261104071128-95e9aa`，退出码 0，7 passed / 1 skipped；4 条身份集成测试（含 2 条真实子进程探针）在真实 `paths.dataSpaceDeviceId()` 下全部通过，子进程均成功退出。1 skipped 为“该树已有 owner API”时不适用的缺失接口反例。
- P04 最小集：作业 `20261104070442-c6abb7`（`manifest_decode.test.ts` + `sync_manager.test.ts`），退出码 0，43 passed。
- P03 main 树最小复验（main `d5cd234aa` + 本 lane）：作业 `20261104072917-5b3d58`（`commands_transfer.test.ts`），退出码 0，11/11 passed；使用 main 官方 `OperationBusyError`→Validation、`OperationLockError`→FileSystem、未知 TypeError→HandlerPanic，并覆盖成功 release 与 operationId。typecheck 作业 `20261104072935-3a9bcd` 退出码 0，无 Errors。详见 `BLOCKERS.md` §7。
- merge main 后最小集：作业 `20261104073245-dca3e5`（`commands_transfer.test.ts` + `commands_errors.test.ts` + `device_identity.test.ts`），退出码 0，24 passed / 4 skipped；当时 4 skipped 为等待 F4 `dataSpaceDeviceId()` 进 main 的身份集成测试，该 API 进 main 后已由作业 `20261104102017-767a84` 验证通过。
- `sync_real_business_tables_tests.rs` B01-B25 移植：作业 `20261104075337-595843`（`tests/business_tables_sync.test.ts`），退出码 0，25/25 passed；使用真实 F3 生产迁移与真实 vfs/notes/sync 插件，B20/B21 的 `mistakes` payload 按生产 NOT NULL 列补全并保留原 upsert/revive 断言。typecheck 作业 `20261104075655-682e71` 退出码 0，无 Errors；`migration:ledger --check --no-write` 退出码 0，problems 0。
- `sync_scenarios_tests.rs` scenario 01-30 移植：作业 `20261104075955-efdcf6`（`tests/scenarios_sync.test.ts`），退出码 0，30/30 passed；使用 ad-hoc F3 `openFile` 句柄与 Rust 原 fixture schema（`notes`/`__change_log`/triggers），仅安装真实 sync 插件，保持 apply、冲突表、隔离区、LWW 与回放断言。scenario 07 为通过公开引擎的测试 fixture 白名单，将 `children` 改名为 `test_children`，FK 违规与隔离断言不变。typecheck 作业 `20261104080042-04a2f9` 退出码 0，无 Errors。
- `sync_scenarios_tests.rs` scenario 41-50、52-56、60 追加移植：作业 `20261104080412-1c076b`（同一文件），退出码 0，46/46 passed（含 01-30）；覆盖深层 JSON、特殊 record id、注入拒绝、Unicode、超长字段、文件库重开冲突持久化、混合冲突批次、已删除记录重复删除与冲突表快照。typecheck 作业 `20261104080412-486d7b` 退出码 0，无 Errors。
- `sync_regression_tests.rs` R01-R25b 移植：作业 `20261104080801-bbb2fc`（`tests/regression_sync.test.ts`），退出码 0，26/26 passed；覆盖 HLC counter/漂移/混合格式、基线重建边界、清理幂等、3000 条批边界、合并策略时间戳与冲突守卫重放幂等。Rust fixture `items` 按公开引擎的测试白名单改名为 `test_items`，断言不变；r26/r27 因缺 `replay_quarantined_changes` 公开面继续 pending。typecheck 作业 `20261104080843-ae306e` 退出码 0，无 Errors。
- `sync_integration_deep_tests.rs` I.01-I.15 移植：作业 `20261104081141-89ca90` 首轮 11/12（`toU64()` 经 Number 丢失精度），修正为 bigint 比较后作业 `20261104081223-c1dfcd` 退出码 0，12/12 passed；覆盖 legacy HLC、因果重排、部分失败重试幂等、pending 回声抑制、冲突 JSON 往返、1000 条批次与 500 次同记录更新。首轮 typecheck 作业 `20261104081141-b5d20f` 退出码 0，无 Errors。
- `sync_r02_hardening_tests.rs` 4 条移植：作业 `20261104081515-fb135c`（`tests/hardening_sync.test.ts`），退出码 0，4/4 passed；覆盖双端 pending 的 tags/favorite 合并与下一轮上传 payload、复合主键较旧 DELETE 拒绝/较新 DELETE 生效/迟到 UPSERT 不复活、慢钟败方冲突去重与语义回声不入表。typecheck 作业 `20261104081515-e1281e` 退出码 0，无 Errors。
- `sync_r05_regression_tests.rs` 数据库侧 4 条移植：作业 `20261104081745-b82232`（`tests/delete_hardening_sync.test.ts`），退出码 0，4/4 passed；覆盖慢钟 DELETE 败方入冲突表与去重、本地 pending 时胜败双方快照、不可解析 changed_at fail-closed 隔离与 attempts 递增、新 DELETE 无冲突残留。typecheck 作业 `20261104081745-08937a` 退出码 0，无 Errors。
- `sync_pathological_tests.rs` P.01-P.39 apply 侧 32 条移植：作业 `20261104082225-efebee`（`tests/pathological_sync.test.ts`），退出码 0，32/32 passed；覆盖 HLC updated_at LWW、生命周期复活、DELETE/UPDATE 交错、混合 conflict guard、空库 UPDATE→UPSERT、DELETE payload 忽略、1000 冲突批、缺 change_log、pending 抑制精度、乱序回放、硬删/复活/tombstone、多表与多列 schema、冲突语义（数组顺序、空 tags 等价、元字段忽略）、大小写 id、异构 payload、未知列隔离、change_log 计数不变量与 50 轮冲突。p11-p15（PRAGMA/savepoint/locking）、p20/p36（纯墙钟性能）、p19/p40（无断言观察项）按符号保持 pending。typecheck 作业 `20261104082335-d5952f` 退出码 0，无 Errors。
- `sync_adversarial_tests.rs` A.01-A.40 中可移植 37 条：作业 `20261104082650-57c5c3`（`tests/adversarial_sync.test.ts`），退出码 0，37/37 passed；覆盖时钟回退/超前、同秒并发收敛、时间戳格式与时区、僵尸复活、合法 revive、行级 LWW 已知丢字段、prune gap、schema 缺列/未知列、回声循环、5MB 记录、100 次冲突去重（101 行）、超长 id、控制字符、脏 updated_at、毫秒精度、表名/列名注入、确定性批次、冲突表查询与跨轮累积、DELETE/UPDATE 同批排序。adv_13/adv_33 无断言、adv_14 依赖 F4 身份，保持 pending。typecheck 作业 `20261104082657-d7441d` 退出码 0，无 Errors。
- `sync_weird_tests.rs` W.01-W.50 apply/HLC 侧 39 条：作业 `20261104083245-c7db11`（`tests/weird_sync.test.ts`），退出码 0，39/39 passed；首轮 38/39 的 w11 失败是把 i64 极值经 better-sqlite3 默认 Number 读出导致的舍入，改为 `CAST(... AS TEXT)` 后通过，存储值本身无损。覆盖 Unicode/ZWJ/BiDi/四字节、空与控制字符 id、null byte、i64 极值、浮点精度、epoch/闰秒、HLC 饱和与排序、嵌套 JSON/重复键/数组/空对象/null 字段/对象字段、保留字列名、双删/幽灵删/时间倒置删、混合批次 2500 条与 1000+1 错误隔离。
- `sync_weird_tests.rs` W.51-W.70 存储/批量侧 16 条：作业 `20261104083426-bf62af`（`tests/weird_batch_sync.test.ts`），退出码 0，16/16 passed；覆盖同文件多连接、重启后持久化、时钟回跳、llm_usage_daily 非法 record id、语义相同编辑、空/空白 title、未抑制回声、10000 字符 id、50 批顺序、旧冲突表迁移复用、已解决冲突不阻挡新冲突、10000 条批次（22.6s，断言 <30s）、savepoint 回滚保留 prior keys 与 force-exact finalize 校验。typecheck 作业 `20261104083433-337ea9` 退出码 0，无 Errors。w12/w17/w18/w20/w21/w22/w23/w52/w54/w55/w58/w64、w13/w33、w28、w39/w57 按符号保持 pending。
- `sync_comprehensive_tests.rs` checksum/restore/prune 14 条：作业 `20261104083815-4a406e`（`tests/comprehensive_sync.test.ts`），退出码 0，14/14 passed；覆盖 `getDatabaseSyncState` 的 schema/data version 与空库 checksum、恢复后 `local_version` 对齐与多表/无同步列/空库边界、`hasPruneGap` 七种边界。typecheck 作业 `20261104083820-94f7c7` 退出码 0，无 Errors。field_merge 25 条、classification/trigger/edge 19 条与自包含 review_plan SQL harness 1 条按符号保持 pending。
- `sync_real_schema_tests.rs` real_61-real_70 共 11 条：作业 `20261104084447-050af7`（`tests/real_schema_sync.test.ts`），退出码 0，11/11 passed；使用 Rust 原真实 VFS schema（resources/notes/exam_sheets/questions 外键链、change_log 触发器、FTS 触发器），覆盖 FK 违规隔离、同批父子乱序、三级级联、软删/物理删边界、100 条 FTS 触发器事务、ref_count 重算与 delta 冲突、INTEGER updated_at、DerivedRebuild 复合主键拒绝、删父/删子同批与 10 note 冲突。real_64b 的 `parents`/`children` 按公开 fixture 白名单改为 `test_parents`/`test_children`，FK 断言不变。typecheck 作业 `20261104084500-903992` 退出码 0，无 Errors。
- `sync_proptest.rs` 6 条属性测试：作业 `20261104085720-0b0d7e`（`tests/proptest_sync.test.ts`），退出码 0，6/6 passed；用固定种子 mulberry32 复现原 128/64 case 与 id/label/counter/op 生成器，覆盖 apply 幂等、KeepCloud 冲突无损、全局排序收敛、非法变更隔离、Insert/Update UPSERT 等价、DELETE 幂等。期间修正了并发写入的同名文件：用单调 case 目录避免跨测试复用旧库、补 `allowSyncTestFixtureTables` 与 `test_items` 白名单表名；断言未弱化。
- `sync_real_flow_smoke_tests.rs` 前 4 条：作业 `20261104085515-a49411`（前 3 条）与 `20261104090031-a1f79b`（第 4 条）均退出码 0，4/4 passed；两个 F3 `StorageService` 各自跑生产 `migrations.runAll()`，覆盖真实 vfs note 反向 FK 应用/零回声/markSynced、真实 chat 四层级 FK 链反向应用/零回声、恢复基线清理旧 change_log 后仅产生新 note delta，以及 `llm_usage_daily` DerivedRebuild 不产生 pending、legacy 派生条目经 `filterPendingChangesForDatabase` 过滤后只保留 `llm_usage_logs`。typecheck 作业 `20261104085814-cb6abf` 退出码 0，无 Errors。其余 11 条 smoke 按 all-RowSync/unique-key/legacy 过滤/manifest 依赖保持 pending。
- `sync_chaos_tests.rs` 10 条 chaos 收敛：作业 `20261104093336-a83fd0`（`tests/chaos_sync.test.ts`），退出码 0，19 个用例（10 个 Rust 测试名）全部 passed；保留 Rust 的 seed/动作比例/游标交换/最终全局排序交付与断言，生产 apply 跑在内存 `test_items` fixture 上。为避开 Vitest 单 worker RPC 看门狗，三条长会话按 seed 拆成独立用例并在长循环内让出事件循环，断言未变；`chaos_three_devices_converge` 覆盖 seed 0-9，`chaos_many_seeds_all_converge` 覆盖 20 个 seed。typecheck 作业 `20261104093550-1579c7` 退出码 0，无 Errors。
- `sync_realistic_scenarios.rs` 115 条中 102 条已移植，分为五个文件：S.01-S.15 共 15 条在 `tests/realistic_scenarios_sync.test.ts`（作业 `20261104091504-0c4cf9`，15/15），S.16-S.35 共 20 条在 `tests/realistic_scenarios_chat_mistakes_sync.test.ts`（作业 `20261104095432-ca4163`，20/20），S.36-S.68 的 29 条断言用例在 `tests/realistic_scenarios_vfs_advanced_sync.test.ts`，S.69-S.94 的 18 条断言用例在 `tests/realistic_scenarios_recovery_sync.test.ts`，S.96-S.115 共 20 条在 `tests/realistic_scenarios_stress_sync.test.ts`（作业 `20261104101218-ee38b5`，20/20）。上述四文件合并最小集作业 `20261104101445-0b8779` 退出码 0，82/82 passed。Rust 文件的内联 harness 自带 `apply_changes_to_db`（INSERT OR REPLACE/软删 SQL）；移植只替换该步为生产 `ctx.sync` 的 `getPendingChanges` → `enrichChangesWithData` → `applyDownloadedChanges`，设备均为跑完 `migrations.runAll()` 的 F3 `StorageService`（vfs/chat_v2/mistakes）。为对齐生产 LWW（Rust harness 无 LWW 步），本地更新补单调递增的 `updated_at`；S.79 增加一条真实 completed `pomodoro_records` 事实，供生产 `pomodoro_counts` 重算正数。S.106/S.107/S.108/S.111/S.112 在长循环内让出宏任务，避免 Vitest worker RPC 看门狗，断言未变。仍 pending 的 13 条：S.38/S.47/S.70/S.75/S.85 原测试无断言；S.39/S.76/S.77/S.84 断言手写 `resources.ref_count`，生产 `recompute_derived_ref_counts` 会按实际引用重算为 0，手写计数不可表达；S.59 的 2027 未来时间戳被生产 drift fail-close 拒绝；S.90 的未知表条目在 `enrichChangesWithData` 前置拒绝；S.91 断言 Rust 测试专用 `SimulatedCloudStore`；S.95 仅断言 Rust fixture 的 schema 装配。
- 旧 L21 `e4dd1772f` 组合探针（`20261104070222-8acb9c`）是候选树证据，已被 main 树复验取代，不再作为当前依据。
- `migration:boundaries:strict`：本 lane 0 命中；全仓 4 条既有违规（3 empty-catch、1 console-log，均不在本 lane），退出码 1 由这些既有项导致。
- `importable.mjs host/plugins/sync-providers/index.ts`：`importable: ok`，退出码 0。
- `migration:wiring -- --lane sync-providers`：作业 `20261104102133-5d48ac` 退出码 0，ported 637（与 TESTMAP 头部一致），所测模块未从 `index.ts` 接入 0。
- `migration:ledger --check --no-write`：merge main 后退出码 0，全局 commands/test problems 均为 0；`mobile_profiles_exclude_s3_and_keep_recovery_core` 的 obsolete 批准随 `migration/approvals.d/C2-platform.json` 进入分支，不再需要改聚合批准文件。
- 按协调者要求，本轮未重复跑全 lane；上一轮全 lane 结果已被 P06 身份入口修改取代，不作为本轮证据。

补充说明：

- 质量反馈（断言数变化）说明：`commands_transfer.test.ts` 的 `expect` 30→27、`device_identity.test.ts` 的 46→36 是删除 L23 自造镜像与本地身份编排后的有意收缩，不是为通过而削弱。前者删除的是旧 L21 guard 镜像的 `CommandError(string)` 猜测、optional release 与 AppError 透传反例（main 官方 `OperationGuardError` 已取代，R4 P03 签收）；后者删除的是 L23 本地 env/WeakMap/legacy 身份重建断言（R4 P06 要求唯一编排归 F4，等价语义由 F4 六个真实场景测试覆盖；Rust 原身份测试现已通过，作业 `20261104102017-767a84`）。替代覆盖分别保留在 `commands_transfer.test.ts` 的官方 busy/lock/未知 TypeError/release 断言与 `device_identity.test.ts` 的 owner 委派/错误透传及两条真实子进程探针。
- 20 条 provider 契约测试仍需 `DS_SYNC_TEST_DOCKER=1` 与 Docker；本机无 Docker，本轮状态只能记“未执行”，不写成 skipped 通过。
- TESTMAP 现为 **ported 637 / pending 221 / merged 0 / obsolete 1**。数据空间切槽 4 条、mobile_feature 桌面 S3/FTP profile 不变量 1 条、真实业务表 B01-B25 共 25 条、场景 01-30、41-50、52-56、60 共 46 条、回归 R01-R25b 共 26 条、深度集成 I.01-I.15 共 12 条、R02 加固 4 条、R05 DELETE 加固 4 条、pathological P.01-P.39 中的 37 条（32 条 apply + 5 条 pragma 交互）用例、adversarial A.01-A.40 中的 37 条用例、weird W.01-W.70 中的 55 条用例、comprehensive checksum/restore/prune 14 条、真实 VFS schema 11 条、proptest 6 条、真实迁移库往返 4 条、realistic S.01-S.115 中 102 条、chaos 10 条已 ported；此外并行批次已把 pathological P.11-P.15 的 5 条 pragma 用例移植到 `tests/pathological_pragma_sync.test.ts`（作业 `20261104090141-74fe67`，退出码 0，5/5）；4 条设备身份集成测试（2 条持久化/轮换 + 2 条真实子进程探针）已在 `tests/device_identity.test.ts` 通过：作业 `20261104102017-767a84` 退出码 0，7 passed / 1 个“owner API 缺失”防护用例保持门控；F4 `dataSpaceDeviceId()` 已进入 main。`mobile_profiles_exclude_s3_and_keep_recovery_core` 按 main 的 `approvals.d/C2-platform.json` 标 obsolete（mobile-only）。
- 221 条 pending：L20 移植积压（main 已发布多数引擎 API 与 `ConflictPolicy`；仍缺 `classification` 注册表、`asset_filenames`/`AssetDirsManifest`、delete-resolve、`field_merge` 等公开面，另有 42 条 Docker provider 契约未执行）、L21 SSOT/ZIP 5（缺 capability 注入面与整包导出/导入）、L13 autosync 2，以及 realistic 13 条上一段列明的不可表达/无断言用例。mobile-only Cargo profile 已移除出 pending。
- C2 已驳回 `mobile_feature_profiles_exclude_s3_backend` 的整条 obsolete：Rust `sync_android_device_switch.rs:682-685` 含 default 桌面 S3 断言；已迁移桌面能力不变量并 ported，不再按 mobile-only 申请作废。
