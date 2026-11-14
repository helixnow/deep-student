# F4-security：v2 接手盘点（2026-11-04）

本文件覆盖 F4 的 secrets/settings/log/paths/errors/diagnostics/time/util/net-policy；
命令规格仍以 `migration/spec/F4-security.md` 为入口，原测试去向仍在
`migration/testmap/F4-security.md`。这些目录此前没有 LANE.md / ACCEPTANCE.md，
没有待勾选的 F4 独立复核项；不把“无复核项”当作通过 v2。

恢复点：`09cb1edc4` 已完成 F1 版本测试映射及 F7 tokenizer 状态订正，
`d1d251987` 已修 SSE 多 CR；`221e01b1a` 合入 main `2ee9a9cbe`。
原 44 命令注册、246 ported / 17 merged / 7 approved obsolete / 30 pending 是旧账本快照，
不代表逐行为 v2 签收。旧 SPEC 的完成表述以本盘点的未决项为限。

## 八类核对

编号对应 standard-v2 §1：①生产接线、②所有权、③serde、④日志/错误、⑤测试、
⑥分支、⑦运行时、⑧复验。“待逐分支”表示未完成审读，不冒充已通过。
路径省略前缀 `host/platform/`。

| 命令/模块 | 八类核对结果与证据 |
|---|---|
| secure_save_cloud_credentials / secure_get_cloud_credentials / secure_delete_cloud_credentials / secure_clear_cloud_encryption_password | ① `secrets/commands.ts:20-28`；②只写安全文件；③ `secure-store.ts:529-578,965-972` 已校验字段、staged generation 用 bigint，但 JSON duplicate/数值 token/serde Display 待逐分支；④错误仅 SecureStoreError 被命令捕获，所有 IO 失败映射待审；⑤ `secrets/tests/commands.test.ts` 是真实命令；⑥事务回滚待逐分支；⑦命令局部串行不等于所有服务调用串行，需对 Rust 锁边界复核；⑧未签收 |
| secure_store_is_available / secure_store_get_keystore_protection / secure_store_set_keystore_protection | ① `secrets/commands.ts:29-34`；②标记/种子归 F4；③布尔输入经 kernel；④ `secure-store.ts:883-955` 日志/回滚存在，删除 marker 的错误优先级待审；⑤原平台条件测试保留；⑥Windows/keystore 分支待逐分支；⑦跨 openStore 实例同步待审；⑧未签收 |
| secret_prompt_submit / secret_prompt_status / secret_prompt_discard / secret_prompt_capabilities | ① `secrets/commands.ts:35-40`；②仅内存；③kernel 输入；④固定 integration unavailable 是 Rust 行为；⑤ `secrets/tests/commands.test.ts`；⑥submit 不可用不应激活其他分支；⑦dispose 已接 ctx.effect，时钟/zeroize 待逐分支；⑧未签收 |
| secrets.openCrypto / backup / publication | ① `secrets/index.ts:75-90` provide；②密钥与 journal 归 F4；③ **F4-V2-02** `crypto-publication.ts:66` 对 UTF-8 采用替换解码，Rust `crypto_publication.rs:139-145` from_slice 应拒绝非法字节；④日志前滚/回滚有对应；⑤原崩溃矩阵存在；⑥原子发布失败路径继续审读；⑦KDF/大文件 CPU 与清零所有退出点待逐分支；⑧未签收 |
| get_backup_config / set_backup_config / clear_backup_directory / pick_backup_directory | ① `settings/backup-commands.ts:98-145`；②经 settings 所有者；③ **F4-V2-01** `backup-config.ts:121,125` 把 null bool 默认化、`:92,97` 原型属性可误作枚举；Rust `backup_config.rs:28-52,74-89` 不允许；④parse 错误已有 Unknown 包装但 Display 非逐字；⑤现测试只覆盖语法坏 JSON，需真实存储→invoke 回归；⑥默认/None/enum 所有分支待逐字段；⑦dialog 后写库顺序已保留；⑧未签收 |
| get_auto_backup_status / get_default_backup_directory | ① `get_default_backup_directory` 注册于 `settings/backup-commands.ts:151-154`；`get_auto_backup_status` Rust 未注册（`src-tauri/src/lib.rs:2219-2223`），WP-126 起 Host 也不注册，读取保留为 `loadAutoBackupStatus`；②settings 只读/目录探测；③状态 Option string 校验在 `backup-config.ts:164-189`，重复键/Display 待审；④ `writableAppDataDir:85-89` catch 与 ensureWritable 吞错误关系待核；⑤生产命令测试存在；⑥回退日志待逐分支；⑦探测用异步 IO；⑧未签收 |
| settings 服务及 D1 WithConn | ① `settings/index.ts:201-224`；②只写自有 settings 表；③字符串值不属于泛型 JSON 解码；④敏感写失败回滚在 `:175-195`；⑤真实 SQLite 测试已有；⑥逐分支审读继续；⑦实例锁覆盖敏感迁移；**F4-V2-03** SQL 仍放 index.ts:15-28，v2 要求 repository；⑧未签收 |
| cloud_config_ssot_get / cloud_config_ssot_save / cloud_config_ssot_clear / cloud_config_publish | ① `errors/cloud-config-commands.ts` 只转发真实 cloudConfig；②所有业务/SSOT 编排由 L21/L23；③kernel 校验输入，持久化解码归提供方；④透传 CommandError；⑤ F4 转发测试不证明提供方事务；⑥/⑦须以 L21/L23 验收为准；⑧未据 API 存在签收提供方 |
| get_debug_logs_info / clear_debug_logs / cleanup_old_debug_logs / ensure_debug_log_dir / read_debug_log_file | ① `log/commands.ts:30-39`；②只写日志；③路径经 kernel，文件 UTF-8 待核；④flush 错误映射已有；⑤ `log/tests/commands.test.ts`；⑥路径/mtime/删除失败逐分支待核；⑦同步扫描/读取还在 Host；⑧未签收 |
| save_test_log / get_test_logs / open_log_file / open_logs_folder | ① `log/commands.ts:40-77`；②日志归 F4；③kernel 字符串；④spawn 的 error 已监听；⑤生产命令测试；⑥mtime 失败排序与 Rust 待核；⑦同步 IO 尚需处理；⑧未签收 |
| write_debug_logs / report_frontend_log / log_debug_message / tauri_lab_frontend_log | ① `log/commands.ts:78-120`；②只写日志；③kernel LogEntry/FrontendLogPayload；④日志级别/可选字段输出待逐分支；⑤现有命令测试；⑥脱敏/截断顺序待逐分支；⑦同步追加/队列与 timer 生命周期待审；⑧未签收 |
| export_diagnostics_bundle / log 服务 | ① `log/index.ts:135`、`log/commands.ts:26`；②日志/导出文件；③Options 经 kernel；④IO 上下文已有；⑤真实 ZIP 测试；⑥按 Rust diagnostics.rs 逐分支待审；⑦ **F4-V2-04** `log/diagnostics.ts:108,123` 在 Host 脱敏/同步 ZIP，Rust spawn_blocking，应迁 worker；⑧未签收 |
| check_package_manager / check_all_package_managers / auto_install_package_manager | ① `diagnostics/index.ts:23-31`；②无表写入；③kernel 字符串；④安装 info 已接 logger；⑤ `diagnostics/tests/package-manager.test.ts`；⑥探测与平台分支待逐项；⑦child exit/close 与 timeout reaping 已实现，继承 pipe 分支待核；⑧未签收 |
| check_test_dependencies / debug_get_database_stats / debug_vfs_textbook_pages / debug_vfs_migration_status / write_test_report | ① `diagnostics/database-commands.ts:23-69`；②repository 只读外部表，报告文件归 F4；③chat_history JSON 结构与整数读取待逐字段；④已有命令错误映射，数据库查询错误全路径待核；⑤真实 SQLite/命令测试；⑥Rust `debug_commands.rs` 待逐分支；⑦performance.now 用于耗时，IO 部分异步；⑧未签收 |
| toggle_devtools | ① `diagnostics/devtools.ts:16`；②通过 F2 shell；③kernel；④字符串错误映射；⑤命令测试；⑥cfg 与当前窗口在 F2 核对；⑦异步请求；⑧未签收 |
| backgroundTasks | ① `diagnostics/index.ts:18-20` provide + shutdown effect；②仅内存；③无 JSON；④ `background-tasks.ts:19,31,46-48` 对应 Rust :78,101-111；⑤两个原测试；⑥拒绝准入/等待/超时分支已核；⑦关闭准入先于等待、finally 清 timer，不取消任务符合 Rust；⑧消费链 W17 归对应 lane |
| paths / time / util / net-policy / errors 值 API | ①公开 api，调用点待逐符号核对；②paths 仅身份文件，其他无表写；③ `paths/index.ts:358` state JSON 只检查 active，需与 F3 所有者语义核对；④SSE logger 已由 log 绑定；⑤同名原测试存在，不能仅凭数量签收；⑥Unicode/日期/URL/ZIP/错误构造器逐分支审读继续；⑦SSE 线性扫描已修，ZIP 同步入口的消费者线程归各消费方；⑧既有 P06、多 CR 签收保留，不重复修复 |

## 处理顺序

1. 没有未勾选的 F4 ACCEPTANCE finding；先修 F4-V2-01 的真实持久化输入差异，
   新测试经真实 settings + backupConfig 插件和 kernel invoke，不改弱旧测试。
2. F4-V2-02 journal 非法 UTF-8 要在任何回滚副作用前失败；补真实 publication 服务测试。
3. F4-V2-03 搬 SQL 到自有 repository，保留 D1 接缝；F4-V2-04 迁 worker 并证明事件循环可响应。
4. 继续上述“待逐分支”项；这些是 F4 自有待办，不列为跨 lane 阻塞。每类独立提交并请求复验。

## 修复记录（v2）

| ID | 内容 | 代码/测试提交 | 验证作业 |
|---|---|---|---|
| F4-V2-01 | `backup.config`：显式 null 的 bool 改为报错，BackupTier 不再匹配原型属性名；改用共享 JSON 原语后，已知字段重复、`24.0`/`1e1`/超出 u32 都会被拒绝；`backup.auto_backup_status` 同样处理 | `9b4d5cae8`、`32bbf06e8`、`5476f201d` | `20261104113505-fa3c9f` 36 passed exit 0 |
| F4-V2-02 | crypto publication journal 遇非法 UTF-8 时在任何回滚/删除之前失败 | `229de4023` | `20261104111137-d2b61e` 44 passed exit 0 |
| P04 | `dsbkFirstChunkSpeculativePrefixLen` / `planFirstChunkTrial` / `trialDecryptFirstChunk` 接受精确 u64 `bigint`；剩余长度和 final 判定全程用 bigint；number 只接受安全整数；`prefixLen` 有上界，仍是 number | `c7a9ba6bf` | Node `20261104112803-339d54`（first-chunk-u64 4 passed）；Electron `20261104112803-270ba5` 43 passed exit 0 |
| F4-V2-JSON | 共享原语改成流式 `JsonReader`：typed decoder 逐字段消费，类型错误、重复字段先于尾随字符报出；`-0` 算 F64；column 按 UTF-8 字节计。Value 读取用 `parseJsonDocument`/`objectLastWins`；base64 也从 `util/api.ts` 发布。backup-config 是第一个消费方。未闭合项见 `util/BLOCKERS.md` | `c7a9ba6bf`、`5476f201d`、`47b0f26e5`、`2d9d56497` | `20261104122813-753c3d` 40 passed；lane-gate 2d9d56497 全部通过 |
| F4-V2-03 | settings 表 SQL 从 `settings/index.ts` 移到 `settings/repository/settings.ts`，改为接收 `SqlExecutor` 的仓储函数，D1 `*WithConn` 接缝不变。行为不变，由既有真实 SQLite 测试覆盖。因为 boundaries 规则只放行插件 repository 与 storage，这里沿用每条语句一条 boundary-allow 的窄机制 | 本提交 | settings 31 passed `20261104134653-4cf220`；boundaries 0 违规 `20261104135140-f92886` |
| F4-V2-04 | `export_diagnostics_bundle` 的日志脱敏和 ZIP 压缩移到一次性 worker（`log/diagnostics-worker.ts`、纯函数 `log/diagnostics-sanitize.ts`），对应 Rust `spawn_blocking`。文件扫描、读取、原子替换仍在主线程用异步 IO。错误前缀不变。测试：18 MiB 日志导出期间 10ms 定时器持续触发。把实现临时改回同步时该测试失败（job `20261104135951-e1a5f4`），说明它能抓住回退 | 本提交 | log 25 passed `20261104140112-87ac91`；typecheck `20261104140121-274caf` |

## 当前验证与真实跨 lane 阻塞

### W07 第六轮：DSBK Web Streams 接口（2026-11-07，W08 password_proof / cloud_transfer 需要）

- 新增 `BackupCrypto.encryptBackupStream/decryptBackupStream` 与 `FileCipherSession.encryptStream/decryptStream`，
  路径式接口不变。帧逻辑在可移植的 `dsbk-stream.ts`（只用 Uint8Array/DataView/Web Streams，GCM 与密钥注入），
  `backup-crypto.ts` 注入 Node GCM；`BackupCryptoError` 与 DSBK 常量移入该文件并由 backup-crypto.ts 原样转出。
- 语义：调用即锁定两端；成功读到 EOF 并 close output；失败 cancel input、abort output 后抛出（配合
  `ctx.files.openWrite(…, { mode: 'atomic' })` 不落盘）。错误文案按 Rust `encrypt_backup_file_with_key` /
  `decrypt_backup_file_with_key_provider`：读写端错误带「读取数据失败 / 读取加密头失败 / 写入加密头部失败 /
  写入密文失败 / 写入解密输出失败 / 刷新…输出失败」上下文；v1 整段认证后才写出。
- 测试 `tests/dsbk-stream.test.ts`：分块边界与路径式双向互通、独立向量逐字节、错误文案与路径式逐条一致、
  源/汇失败与取消、已释放会话、真实 `createNodeFiles` 的 openRead → openWrite(atomic)、模块闭包无 Node。

### 新 main 的五条 CorpusManifest 共享测试消费闭合（2026-11-05）

- 正常merge main `23c679e40` 后，真实 `chat_v2_stage_context_attachments` 注册链调用 L07 公共
  buildCorpusManifest/validateCorpusManifest/modelNotice；不是 L05本地objects副本，也不只是API导出。
- Rust task_objects.rs:1517-1672 五原测试（同名handle、去重引用、notice、快照、坏shape）的原断言
  在 agent-skills/tests/task-objects-manifests.test.ts:150-259逐条保留。定向job
  `20261105114147-b5f72c` 五例+既有kernel附件分页产物回归6passed/27仅标题过滤skip/exit0/无Errors。
  生产链/精确映射见权威migration/testmap/F4-security.md，本轮不改owner代码/旧断言。
- 只把五行pending改merged，当前245ported/34merged/9obsolete/12pending；
  L07另4（含分页原测试中只在测试调用的Corpus decoder）、L04 2、rubric1、L15 5继续保留。
  derived_edge原测试的对象字面量序列化不冒充公共值构造，schema_v1完整调用链待续审。
  不写generated ledger/header、不凭映射更新宣称整lane已完成。

### F4-V2-23：save_test_log 磁盘写入不占 Host 线程（2026-11-05）

- C2逐行复核续项：Rust `commands.rs:6292` 原成功 debug 日志在旧TS中已遗漏，不是异步迁移新引入。
  现于 await writeFile 成功之后经现有 ctx.logger.debug 记录 `测试日志已保存: <带引号路径>`，
  沿现有路径 Debug 的 JSON.stringify 惯例，不打印 content、不新增日志框架。
  既有两例原断言保留，补观察真实logger的passthrough spy：延迟写入期间无成功日志，完成后恰一条完整路径；
  文件名/类型拒绝及真实写失败不输出成功。red `20261105083621-92105f` 1failed/1passed；
  green `20261105083652-27adf7` 新旧命令4passed/0skip/exit0/无Errors。
- 继续本文件“save_test_log 同步 IO 尚需处理”项。Rust `commands.rs:6262-6290` 校验文件名→日志类型→
  建目录→写满内容→返回；Host 原 mkdirSync/writeFileSync 在命令线程写整份前端日志。
  按 v2 §1.7 改为 Node promise FS IO pool，严格按原顺序 await。仅此命令变更，其他日志同步入口未借此签收。
- 保留原 validation/FileSystem 类型与两个 IO 错误前缀、目录/文件名、覆盖写入和完成后返回；
  不添加临时文件/原子替换、取消或跨调用锁，不把 Rust 此命令的同步 fs 误述为 spawn_blocking。
- 新 kernel+真实 OS 文件测试：明确延迟实际 writeFile 的完成，验证 save 尚未返回、文件尚不存在时
  timer 和 get_test_logs 仍可执行；释放后真实 Unicode 内容逐字相等。不是假 FS/CPU sleep。
  另一例保文件名早于类型校验，真实目录充当输出文件时保写失败包装/目录不变。
- red `20261105081849-430055`：1failed/1passed，原实现完全未进入异步写入；
  green `20261105081935-6abe0f` 新旧命令测试4passed/0skip/exit0/无Errors。旧测试断言未改。
- 此前新main合并tip `290b924e8`（base `c4048f239`）固定gate仍仅typecheck失败；
  Context及Value跨owner阻塞未解除，不拿本单元或native专项通过宣称整分支发布。最终提交后重新固定gate。

### F4-NATIVE-ARGON2：C2 AP0136/0137 真实生产消费（2026-11-05）

- 按 C2 优先任务增补可选实例依赖 `BackupCryptoOptions.nativeArgon2` / `SecretsServiceOptions.nativeArgon2`，
  从正式 F7 native/api.ts 引类型。secrets 插件快照取 ctx 服务；官方 profile native-before-secrets。
  原手动/无native profile不变，选中native的错误不silent fallback，没有全局可变provider/新包/F7私实现导入。
  精确合同/真实装配方案已先投C2/L21（`/tmp/opencode/f4-native-argon-plan.md`）。
- 实例 deriver 贯穿 encrypt/decrypt bytes/file、首块、session初始/foreign cache、password verifier，
  保应用上限→参数→salt顺序、65536KiB/t3/p4/v0x13/32、UTF8+NUL及错误前缀。
  Native key分配以Buffer view接管；补齐单次decrypt key finally清理，session缓存只在dispose清理，
  password可写Buffer success/error均清理，不声称JS immutable string物理清零。
- `native-backup-consumption.test.ts` 正式插件+公开factory，正例 passthrough观察真实F7 N-API、非假快KDF。
  初始 red `20261105065407-0d53e1`：1 failed（factory根本未调用native）；接线最终结果：
  Node26.5 Linux x64 `20261105071416-8ab0a2` 5 passed，Electron45.2.1/Node24.22.1
  `20261105071501-95c36f` 5 passed，均0skip/exit0/无Errors。生产默认参数九次KDF用例Electron约1.8秒，
  保原30s用例预算、timer投递、原独立v1/v2字节向量、旧无依赖profile、校验0调用、故障不回退、key/cache清理。
  唯一负例采用明确provider拒绝注入，不把它当N-API成功证据。
- 既有默认v1/v2 hex仅逐字移到共享fixture，原解密断言/输入完全不改；legacy固定字节两例
  `20261105070828-7aed3c` 2 passed（37 skip仅标题过滤），不重跑无关F4全域或F7原两向量。
- L21旧setupCryptoEnv在Host前手动建factory且未传provider，必须在其真实装配中取得ctx.nativeArgon2再传入。
  F4不越权改L21 fixture，不抬预算；AP0136/0137 stored链/原30秒及其余17 pending/Value联合类型仍待同树独立复验。

### F4-V2-22：诊断命令的原 println 输出及顺序（2026-11-05）

- Rust `debug_commands.rs:71` 在统计连接前打印收集提示；`:438-456` 在教材查询成功后打印标题和
  各行摘要。原 TS 两处均漏输出。现在使用与现有 println 移植一致的 process.stdout.write，
  不改为带前缀 logger、不加 debug-only 开关（Rust 原输出无条件），不改 SQL/DTO。
- kernel+真实 SQLite/真实 stdout 观察：连接失败仍先有统计提示；教材准备失败没有结果标题；
  成功后保行序、Some/None、空res与0chars/UTF8字节长度。仅连接失败做明确接口故障注入，
  stdout 采集仍转发原 sink，不用伪造日志成功。
- 原 job `20261105062432-864b2b` 2 failed；新增准备失败顺序断言后
  `20261105063015-e61fc1` 新旧诊断 6 passed / exit 0；旧输出/错误形状断言未删弱。

### F4-V2-21：崩溃报告 write_all 后 fsync（2026-11-05）

- Rust `crash_logger.rs:176-178` 写满脱敏报告后 sync_all；原 TS 单次 writeSync(string) 可能截断回溯。
  改为标准 writeFileSync(existing_fd, UTF8 Buffer)，保持原 fsync、权限、命名和关闭路径。
- 正式 ctx.log.writeCrashLog + 真实 OS 文件，明确对匹配报告注入短写；验证完整 header/message/
  脱敏回溯尾部/换行及无替换字符，并观察 fsync 时文件大小已等于最终完整大小。
  不触发真实进程异常、不调用 Sentry，不以此签收整个 Rust panic hook。
- 原 job `20261105055326-9bbe49` 1 failed；修复后新旧日志 `20261105055431-74533c`
  21 passed / exit 0；增加同步顺序观察后 `20261105055552-15ca2d` 1 passed / exit 0。
  旧日志/脱敏断言未删弱，没有新建 IO helper/依赖或改变 KDF/其他 lane。

### SecretPromptStore 限定审批正常 main 后落表（2026-11-05）

- C2 `e4680aa8a` 已随正常 main 合并，本树祖先检查确认后才把两个精确ID由 pending 改为
  obsolete:dead-in-rust disabled-entry。没有复制审批或修改其分片、Rust、原TS断言/skip/禁用功能。
- 当前245 ported/29 merged/9 obsolete/17 pending；两个旧helper测试继续保留执行，
  不能把限定退休范围扩至四命令或 SecretValue::Drop，亦不宣称 JS 物理清零已等同 Rust。
  本条替代下方首次审读时的“待审批 main”状态，历史证据保留；其余17跨lane与类型联合阻塞不变。
- job `20261105052333-26d92b` ledger --check --no-write exit 0；未写/提交生成统计文件。

### F4-V2-20：主日志初始化失败的 fd Drop 清理（2026-11-05）

- tauri-plugin-log2.8.0 RotatingFile::new 在 open_file 后若 rotate/remove_old_files 返回 Err，
  Rust 自动 Drop inner File；TS raw fd 原没有构造失败清理。日志文件可打开但旧归档无法清理时会泄漏。
- 构造失败时关闭部分初始化资源并保留原始错误；close 先移除持有的 fd 状态再调用 closeSync，
  rotate 复用同一关闭路径。未改变正常日志格式/轮转/权限或为错误添加 fallback。
- 正式 log 插件加载 + 真实文件/fd，只有归档 unlink 做明确 IO 故障注入；
  验证插件仍拒绝初始化、fd 实际 EBADF、六个归档均未被删除。原 job `20261105050431-f4aa23`
  1 failed；修复后新旧日志 `20261105050735-c2be60` 21 passed / exit 0。
- Electron 定向 `20261105051359-c67fd4` 1 passed / exit 0，无 Errors。

### F4-V2-19：SecretPromptStore 两条旧 ported 的生产证据撤回（2026-11-05）

- 审读 Rust secret_prompt.rs 全部231行及全仓caller：available():17-19 固定false，submit :143-145
  在 :158 insert 前返回；consume :99 没有生产caller。TS commands.ts:35-40 创建store但只接
  contains/discard/不可用submit，insert/consume仅由 commands.test.ts:8-25 调用。
- 两个原名测试的原6条/2条断言与实现均保留，不为扫描器造调用或激活Rust也禁用的未来功能。
  v2 无当前生产消费证据，先将两条从 ported 回到 pending；当前19 pending=17跨lane+2本lane证据裁定。
- Rust仍有被固定false挡住的源码调用点，因此不伪报零源码caller、不擅自obsolete，向C2请求具体裁定。
  这不是四个 secret_prompt 命令未实现（当前固定失败/状态/丢弃/capabilities已有kernel回归），
  也不凭Node helper测试声称JS不可变字符串已具备与Rust Zeroizing等同的全域内存清零证据。
- 首次审读时 `migration/approvals.json` / `approvals.d` 未见这两个ID的既有批准，没有推翻旧批准或删测试。
  job `20261105043225-232b23` ledger --check --no-write exit 0；统计文件未写入/提交。
- C2 后续已给限定 disabled-entry obsolete 审批 `e4680aa8a`，不是整个模块零源码 caller；
  通知到达时 main 祖先检查 exit1，尚不改两行。等待审批分片正常 main 后再更新，
  不复制审批，不启用禁用功能，不豁免四命令或拒绝路径上 SecretValue::Drop 的语义。

### F4-V2-18：主日志轮转器写满整条记录（2026-11-05）

- Cargo.lock:12803 锁定 tauri-plugin-log2.8.0；上游 log-v2.8.0/plugins/log/src/lib.rs 的
  RotatingFile::flush 使用 File::write_all 后才增加 current_size。原 TS 单次 writeSync 忽略短写，
  会截断记录/UTF-8 且错误推进计数。
- 直接使用 Node writeFileSync(existing_fd, Buffer) 的写满语义，保留已打开 append fd、轮转/命名/
  上限/计数/格式，不另建同步 IO 框架或改 logger ABI。
- 正式 ctx.log.logger + 真实 OS 文件，明确对匹配记录的 writeSync 注入一半字节短写并恢复 builtin ESM
  绑定；验证故障实际触发、完整 Unicode 内容/换行、无截断替换字符。原 job `20261105040102-54ea41`
  1 failed；修复后 `20261105040201-68f9a8` 新旧日志20 passed / exit 0。
  未据此签收 write_all 失败后的 Rust buffer 重试等所有 IO 错误路径。

### F4-V2-17：日志排序的 Unix 文件名反斜杠（2026-11-05）

- Rust `debug_log_service.rs::list_log_files_in_dir/list_log_files` 以 Vec<PathBuf>::sort 排序；
  原 compareRustPaths 在 Unix 也把反斜杠拆组件，真实目录中 a\\b.json 与 a-b.json 的 oldest/newest
  因而颠倒，影响同源清理顺序。读取边界 F4-V2-09 已允许此合法文件名，不能排序时换另一套平台语义。
- 只改分隔符按运行/目标平台选择；createPaths 传入其目标平台。没有为此重写通用 Path 解析器，
  不据此授所有 Windows Prefix/CurDir/ParentDir 比较语义的全域签收。
- kernel get_debug_logs_info + 真实目录回归，旧 job `20261105033214-bb79ab` 1 failed
  （2条旧用例仅标题过滤）；修复后 `20261105033506-5196c0` 路径/读取/清理31 passed / exit 0。
  新 Windows 断言只是目标平台字符串模拟，不冒充 Windows 原生执行。

### F4-V2-16：健康检查的 Response 丢弃语义（2026-11-05）

- Rust `test_utils/health_check.rs:19-52` 在响应头可用时采样耗时、取 status 后返回，Response Drop
  不把 body 清理错误变为请求错误。原 TS await cancel() 会让清理失败覆盖 HTTP 503 等原错误，
  甚至返回 available=true 同时 Request failed；耗时也误包含清理阶段。
- 仅把 body.cancel 改为不等待的清理并忽略其 IO 拒绝，latency 在 header 结果处采样；
  fetch 请求错误/2秒超时、服务顺序、web_search 默认可用与返回契约不变。
- 新测试走真实 kernel/SQLite，只有 HTTP transport 及 body cleanup 采用明确故障注入
  （不是实网 Prometheus 签收），Native Response/ReadableStream 上验证200/503各自错误语义。
  原 job `20261105025241-adaf6b` 2 failed；修复后 `20261105030148-c1364a` 新旧健康检查
  3 passed / exit 0。未删弱旧断言，不据此闭合重定向/其他 reqwest/Undici 默认传输差异。

### F4-V2-15：只读诊断的 SQL INTEGER/REAL 区别及行错误日志（2026-11-05）

- Rust `debug_commands.rs:255-278,419-435` 使用 row.get::<u32/i32/String>，记录坏行的真实
  rusqlite Error Display 后跳过。原 TS 默认 number 把 REAL 1.0 当合法整数，并只输出无细节 warn。
- 使用 F3 公开 defineQuery.safeIntegers，INTEGER 为 bigint、REAL 为 number；u32/i32 先检查真实
  SQL 类型及精确范围后才转 number。教材行按原 OCR4/extracted5→id0/resource1/file2/page3 顺序解码，
  migration MAX(version) 非 u32 时按原 unwrap_or(0)，history 坏行带完整列类型/越界日志。
  SQL 只读文本/表/命令契约不变，不更改 F3 驱动或增添公共 SQLite 兼容层。
- 错误文案对照 Cargo.lock 锁定 rusqlite0.40.1 src/error.rs Display，未执行 Rust。
  正式 kernel + 真实 SQLite 类型/只读计数回归及仓储 warn 采集：原 job `20261105020917-0aca8c`
  2 failed；修复后 `20261105021211-76559f` 新旧诊断 9 passed / exit 0。
- 不据此签收 SQLite 原始 TEXT 非法 UTF-8 字节（驱动已投影 string）等所有 FromSql 分支；
  当前修复只闭合已观察的类型/范围/首错顺序与对应日志，不声称整 lane 完成。

### F4-V2-14：详细日志后台磁盘 IO 与 pending 生命周期（2026-11-05）

- Rust `debug_log_service.rs:399-447` 在调用线程序列化、spawn_blocking 原子落盘并在闭包末尾释放
  PendingWriteGuard。原 TS setImmediate 内仍 mkdir/write/fsync/rename *Sync，会占 Host 事件循环。
- 仅后台任务改用 Node promise FS 的 IO pool，file.writeFile 写满、file/dir sync 后发布；
  自动清理也异步且纳入 pending finally。同步返回预期路径/命名/600 权限/rename/每50次清理等接口不变。
  Rust let _ = remove_file 的清理失败明确忽略再 warn；close 按 Rust Drop 处理，不覆盖原写入错误。
- 真正的 `ctx.log.debugLogs` / kernel 回归，用真实文件和明确的 FileHandle.sync 完成延迟注入：
  held sync 时不发布文件、其他命令/计时器可运行；假时钟仅推进10秒deadline，flush返回false，
  释放后成功；普通文件充当目录时 warn 并收敛 pending，501文件按10%清理后剩451。
- 原实现 job `20261105012742-48e811` 1 failed；修复后新旧 log 目录
  `20261105013329-294e9a` 31 passed / exit 0，无 Errors；未更改旧断言或引入worker协议/依赖。

### L21 Value 任意精度保存面（2026-11-05，C2/L21 具体请求）

- 发布 `util/api.ts::{jsonNumberToRawJSON,stringifyJsonValue}` 与类型 JsonRawNumber；
  复用已有 F4 错误包装的 Value 数字规范化逻辑，原私有 serializer 删除并改用公共实现。
  不重写 lexer、不变更 JsonValueNumber/typed reader、不新增包或执行 Rust。
- 数值原子是标准 JSON.rawJSON，1e999 不降 null、不经 Number、不加引号变业务 string，
  与 L21 现有 bigint replacer 兼容；AST compact 保存同时保留 Value 首次键序/last-wins。
  普通 JS 对象的整数样式键排序限制明确在 API.md，不把数字无损投影冒称全文字节等价。
- Node 新原语+既有本地化错误 `20261105005822-d0b386` 18 passed，Electron
  `20261105005835-ec4a61` 4 passed，均 exit 0。真实 L21 auditDetails/save 还须其 owner 同树复验，
  不因新 helper 把此前 10 条组合 tsc 错误自动标已修。

### F4-V2-13：脱敏保留合法 JSON 自有键（2026-11-05）

- Rust `debug_log_service.rs:83-126` 用 serde_json::Map 插入每个键，原 TS 用 `{}` 下标赋值，
  会把合法 `__proto__` 键从脱敏结果中丢掉（这里只是局部返回对象，不宣称全局原型污染）。
- 改为 Object.fromEntries 按数据键构造，仍执行同样的凭据字段递归脱敏；不改正则策略/服务 ABI，
  不为此引入安全框架或全模块豁免。
- 新回归通过 kernel `report_frontend_log` 和真实落盘日志：保留 `__proto__`/constructor/note/keep，
  两处嵌套密码均为 REDACTED，不出现测试凭据原文。原实现 job `20261105004331-dbd5e7` 1 failed；
  修复后 job `20261105004501-ac4bac` 新旧脱敏/诊断 ZIP 21 passed / exit 0。
- 未据此闭合已记录的 Rust/JS Unicode 正则边界差异或全部 Value 精度；F7 regex 服务是异步的，
  不能为一个局部 map 修复静默改变已发布同步脱敏接口。

### C2 要求的完整消费者 tsc 盘点（2026-11-05）

- 固定树 `51a041d88c5c77df93a31a402c459149533707ea`（main `c6309183c`），仅执行一次
  `typecheck:host`，job `20261105001519-08b811` exit 2；未重写原语或重复业务回归。
- 完整输出是 10 条 TS2339、8 个位置、5 个文件、4 个 owner：L21 audit.ts:199:33；
  L22 stream-context.ts:220:96；L18 text-formats.ts:59:48、vlm-serde.ts:58:75/202:92/241:99；
  L14 question-import-service.ts:175:45/175:84/175:104/589:22。
  旧只列 L22/L14 或 L22/L14/L18 的 gate 摘要不完整，必须把 L21 纳入联合候选。
- 原始日志 `/home/dsdev/.oc-jobs/done/20261105001519-08b811.log`，各处实际用途/应保持的 typed 与
  Value 数字语义更新到 `util/BLOCKERS.md`。typed JsonNumber 不新增 arbitrary；Value 的 raw 才是精度依据，
  不给 arbitrary 伪造 value/Infinity，不将 raw 无条件变业务 string 或 Number。
- 此为供方候选+新 main 的组合类型失败，不说不含候选的 main 自己已有同样 TS 错误；
  F4 无新增类型错误，未越权改四个 owner。按 C2 要求转架构/C1 同一组合树处理。

### L04 ToolScope 生产消费解除（2026-11-05）

- main `9b3c18601` 已有 worker 生产链 `workspace-run-agent.ts:546` → `issueWorkerGrant` →
  `scopesFromAllowedTools` → `toolScopeFromAllowEntry`，chat/api.ts 正式导出值 factory。
- 原 Rust `agent.rs:515-523` 的 MCP scope 序列化断言从公开 factory 构造，不在测试写同形对象冒充实现；
  `util/tests/agent-scope.test.ts` job `20261104215522-1879cf` 1 passed / exit 0，映射为 ported。
- pending 现为 17（L07 9、L04 2、rubric 1、L15 5）。另外两条 agent 测试仍缺真实消费/公开值操作证据，
  不随同一文件里 ToolScope 的闭合而整体关闭。

### F4-V2-12：DSBK stream write_all 语义（2026-11-05）

- Rust `backup_crypto.rs:382-411` 的头部/密文及解密明文使用 write_all，原 TS 单次 FileHandle.write
  未检查 bytesWritten，合法短写会静默生成截断文件。新增局部 writeAll 循环，只推进实际写入字节数；
  不改文件格式、KDF、上限、session 缓存或其他 lane。
- 新回归通过真实 `ctx.secrets.backup` session + 真实文件，只在 FileHandle.write 做明确故障注入：
  每次仍实际向 OS 写入、但仅处理请求的一半字节。不以伪造加密/内存文件冒充集成成功；
  核对 v2 header44+payload+tag16 总长与解密字节完全相等。
- 原实现 job `20261104211012-912a51` 2 failed；修复后新旧 DSBK job
  `20261104211057-d19ffd` 41 passed / exit 0。旧密码/损坏/截断/跨 session 向量未删改。
  不据短写成功路径授 Rust BufWriter 所有 flush/IO 错误优先级的全域等价。

### 路径预览审读边界（2026-11-05）

- `paths/api.ts:8,109` 明确 resolveActiveSlot 为只读预览，运行期以 F3 locations.activeDir 为准；
  当前全 host 搜索只有定义与三条补充测试，没有生产调用。Rust DataSpace::read_state 包含 tmp 恢复/推断/
  写回，不应为这段无生产调用的只读预览复制 F3 恢复逻辑，也不把它签为完整 active_slot 行为。
- W07（2026-11-07）：该预览读不到 state.json 就回落 slotA，与 Rust `read_state` 的 .tmp/目录推断不一致，
  且仍无生产调用，已从 `PathsService` 删除；活动槽唯一解析在 `storage/locations.ts` 的 `DataSpace.readState`。

### DIFFICULTY_RUBRIC 共享出口与真实消费候选（2026-11-05）

- 新 main 已有真实消费：L18 `llm-structurer-service.ts:139` / `vlm-grounding-service.ts:293`，
  L14 `question-import-legacy.ts:249`，但均使用自有副本并注明等待 F4 发布。
- F4 `util/prompt-contracts.ts` 现发布逐字 Rust 常量，从 `util/api.ts` / `util/index.ts` 出口提供，
  不复制 L01/L03 的 LaTeX 契约。原 `difficulty_rubric_covers_all_levels` 五条断言保留，另有
  Rust 源文本逐字对照；job `20261104204013-9f2595`：2 passed / exit 0。
- TESTMAP 该行保持 pending，18 总数不变；消费方未切共享实现前不将常量测试或本地副本当正式接线。
  查询时 L14/L18 parked，C2 failed，按既有指令只 escalate 实际协调者，不向停放队列追加执行消息。

### F4-V2-11：诊断统计的 DebugRawChatMessage 解码（2026-11-05）

- Rust `src/debug_commands.rs:28-50` 定义 F4 自有 DebugRawChatMessage（不是 L04 业务 ChatMessage），
  `:111-137` 只有整条 `Vec` 反序列化成功才计数。原 TS JSON.parse+isMessage 误接受重复已知字段、
  已知 Value 内孤立代理项，也不接受 derive 的 19 字段数组形式。
- 自有只读 repository 内增加局部 decoder，复用 JsonReader；三个必填字符串、Option<string>、
  Option<Vec<string>>、Option<Value> 分开读取。未知字段 IgnoredAny，已知 Value 仍严格 Unicode/深度
  并接受任意精度数字。解码后只保留统计需要的 presence flags；任意消息失败仍整条历史跳过。
  没有改 SQL、其他表/业务类型、命令契约或新增失败日志（Rust 此分支也静默跳过）。
- 正式 kernel+真实 SQLite 回归：重复字段/Option null 重复、_meta/rag_sources 的非法字符串、
  部分有效 Vec 的全条跳过、合法数组/empty Some 计数、unknown 与已知 Value 的不同规则；
  确认原 chat_history 字节不变。修复前 job `20261104201926-6e152d` 5 failed/1 passed；
  修复后 job `20261104202046-1c31e0` 新旧诊断 7 passed / exit 0。
  未据此签收 diagnostics 其他 SQL row 类型/错误文本或全部 Rust 分支。

### F4-V2-10：本地化错误字符串保留 Value 精度（2026-11-05）

- Rust `dstu-core/tool_args.rs:49-102` 在 Value/arbitrary_precision 上补字段再 to_string。
  TS JSON.parse/JSON.stringify 会把 2^53+1 舍入、1e400 改 null，并误接收 Value 不接受的孤立代理项。
- 仅改 `ensure_localized_error` 字符串进出内部路径，复用公开 Value reader / last-wins 成员视图，
  私有输出保留数字原文并遵循 scan_exponent 的小写 e/显式正号、整数 -0 → 0。
  未新增 parser、未扩大公开 JsonValue 类型、未给其他 lane 添加 serializer 接口或进行强制 Number 转换。
- 生产可达：`vfs/src/tools/retrieval-executor.ts:52` 调公开 `errors/api.ts` 的 ensure_localized_error；
  新回归由同一公开函数入口验证实际输出字符串，比较完整文本、不先 JSON.parse 舍入后再比值。
  修复前 job `20261104195742-f896de`：3 failed/1 passed；修复后 errors 目录
  job `20261104195900-1b6105`：41 passed / exit 0，原本地化错误/错误形状断言均未删弱。
- 该单元不闭合 `coerce_json_array` 的旧 JsonValue 返回类型/任意精度消费问题，也不代表所有工具或 IPC
  接缝获得 D3 签收。包管理器探测/version 分支已对照 Rust package_manager.rs:37-81,119-130 与
  :317-362 审读，此次未见需修偏差，不制造改动。

### F4-V2-09：调试日志文本与平台路径组件语义（2026-11-05）

- Rust `dstu-platform/debug_log_service.rs:694-709` 先 Path::starts_with 授权，再扩展名，再
  fs::read_to_string。TS 原 `readFileSync(...,'utf8')` 会替换非法字节返回成功；同时 Unix
  路径组件比较误把 `\\` 当分隔符，允许 log 根下的 `debug-logs\\outside.json` 冒充目录内文件。
- 文件 bytes 复用既有严格 UTF-8 工具，非法字节映射为 Rust read_to_string 的 IO Display：
  `读取调试日志失败: stream did not contain valid UTF-8`，保留原 Unknown CommandError 形状。
  组件分隔符按当前运行平台选择，Unix 的 `\\` 仍是合法文件名字符，不做额外拒绝。
- 新测试走 kernel 的真实 read_debug_log_file：无效/截断 UTF-8、合法 BOM/中文/emoji/替换字符，
  Unix 伪目录文件拒绝而真正目录内含反斜杠文件可读。原实现 job `20261104192601-6b1250`
  2 failed；修复后 log 目录 job `20261104192700-1828ca` 27 passed / exit 0。
  Unix 特定文件名用例在 Windows 明确跳过，不当成 Windows 运行验证。

### F4-V2-08：active/staged 云凭据 typed 持久化读取（2026-11-05）

- 对照 Rust `secure_store.rs:2136-2154,2397-2421,2533-2540,2673-2687`：原 TS 在 JSON.parse 后
  校验，重复字段被覆盖、已知字符串孤立代理项被接受、错误先后及 sequence 与 serde derive 不一致。
- active/staged 复用公开 JsonReader 逐字段读取；保留 `CloudStorageCredentials` defaulted Option
  sequence、StagedCloudCredentials 的两必填位置、u64 精度与 typed 数值边界；未知值明确 IgnoredAny。
  删除私有的 reviver 数字包装及解析后重复字段不可见路径，没有新增 parser 或变更冻结服务接口。
- 正式 kernel `secure_get_cloud_credentials` 与 `ctx.secrets.openStore` 的 commit/abort 回归：
  坏输入 commit 前拒绝，active/staged/generation 保持；合法 MAX_u64 与 sequence 可提交；
  abort 对坏 staged 记录 warn + 清除（Rust 唯一清障出口），日志用 serde Display，不带 JS Error 类名。
- 修复前 job `20261104184236-7e2202`：10 failed/1 passed；修复后联合旧 store/命令测试
  job `20261104184405-f677a4`：71 passed/2 平台 skipped，exit 0；新增 abort 日志用例后
  job `20261104184602-464fee`：12 passed / exit 0。没有删弱旧断言或修改 TESTMAP 去向。
- 本单元没有处理跨实例并发锁、OS keyring/DPAPI 或所有 from_slice 字节域，不授整 lane 完成。

### F4-V2-07：备份配置的 derive sequence / IgnoredAny / enum 收尾（2026-11-05）

- Rust `backup_config.rs:28-52,204-212`、serde_derive1.0.228 `deserialize_seq/expr_is_missing_seq`：
  BackupConfig 全字段有 serde(default)，数组短尾保留字段默认值；AutoBackupStatus 无字段 default，
  五个 Option 在数组中必须显式占位（对象仍可缺省）。原 TS 都仅接受对象。
- 复用同一字段读取与 `endArray`；未知字段明确 `skipIgnoredValue`，不误拒 `1e400`/孤立代理项/深容器；
  已知字段严格校验不变。BackupTier 外标签 map 改用 `readEnumVariant/endEnumObject`，
  unit 值预期为 `unit`，第二键不预读；原多键输入错误列 42 修为 Rust 未消费逗号前的列 29。
- 全部新回归经真实 settings 存储 + kernel `get_backup_config/get_auto_backup_status/clear_backup_directory`；
  原实现 job `20261104182110-2d6fd9` 4 failed（6 条旧测试仅标题过滤），
  修复后 settings 目录 job `20261104182219-a239fe` 36 passed / exit 0，无旧断言删弱。
- 未改契约或共享 reader，未运行 Rust；未宣称未知枚举的 alias 错误文案等其余分支均已等价。

### F4-V2-06：publication journal derive 数组路径（2026-11-05）

- 对照 serde_derive1.0.228 `de.rs::deserialize_seq/expr_is_missing_seq` 与原
  `CryptoPublicationJournal` 声明，补齐八字段 positional struct 数组形式。
  Option 在对象中可缺省，但在本 struct 的数组中仍必须占位（没有 serde(default)）。
- 复用同一字段读取函数与公开 `endArray`，不新写 parser；字段不足为 invalid_length，
  读满八项后优先处理 extra/trailing，不解析第九值，类型错仍先于 extra 报出。
- 正式 publication 服务回归：有效数组分别前滚/回滚；坏数组失败后新旧密钥和 journal 均保留。
  修复前 job `20261104175600-d042e6`：8 failed（10 条旧用例仅过滤）；修复后
  job `20261104175708-4c7a0f`：新旧 publication 33 passed / exit 0。
  未更改旧测试断言、不授整个 from_slice（含未知字段非法 UTF-8 字节）的全域等价签收。

### D11 native Argon2 运行验证（2026-11-05，C2 指定最小范围）

- 固定 F4 merged tree：`353ddccc3c5e155075ca19c3d5b8083732861676`，正常 main 基线
  `fb463060d162d6c261ebb731180bcfaa833e95a2`；native Argon2 实现/入口/测试相对 main 无差异。
  没有安装包、没有改测试/参数/断言、没有运行 Rust 或全 native 目录。
- 仅既有 `host/platform/native/tests/argon2.test.ts`：

| runtime（Linux x64） | 命令 | job | 结果 |
|---|---|---|---|
| Node v26.5.0，modules147，N-API10 | `npx vitest run -c vitest.host.config.ts host/platform/native/tests/argon2.test.ts` | `20261104165345-2c851e` | 2 passed，0 skipped，exit 0，无 Errors |
| Electron 45.2.1（RUN_AS_NODE），Node v24.22.1，modules150，N-API10 | `npm run test:host:electron -- host/platform/native/tests/argon2.test.ts` | `20261104165420-87dbbc` | 2 passed，0 skipped，exit 0，无 Errors |

- 两个既有用例实际执行：密码 ASCII/UTF-8/NUL、p1/p4 的 raw bytes 对 noble；
  DSBK 参数 m65536 KiB/t3/p4、32 字节 raw bytes 对 noble及 Host timer 继续触发。
- 仅验证本机 F7 `ctx.nativeArgon2` 加载/KDF；不代表跨平台签收或 DSBK 已切后端。
  `secrets/backup-crypto.ts:70-104` 仍用 node:crypto 原生（可用时）或 noble，不消费 native 服务。
  如需接线须另行设计服务注入/异步生命周期，保留 F4 KDF 上限与密码清零，不在此临时改算法。

### L06 X6-UD-0002：positional struct 收尾接缝（2026-11-05）

- 已有独立 `skipIgnoredValue` 满足 unknown 1e400/孤立代理项/深容器需求，L06 显式接入，不改旧 skipValue。
- 新增 `JsonReader.endArray()`，对应 serde_json1.0.149 `de.rs:1072-1086 end_seq`，固定字段读满后
  不读取多余元素，正确区分闭合/尾逗号/trailing/EOF；并修正共享 peekError：SliceRead 看下一字节，
  不是把尚未消费的 emoji 全部 4 字节计入。
- 原九字段加第十项向量报 `trailing characters at line 1 column 20`；额外 emoji 前后字节列号和换行
  有明确断言。job `20261104164901-d6491a`：reader/ignore/真实 publication 共 28 passed / exit 0。
  无 Rust 执行，消费方 Proposal/TodoStep 的真实入口签收仍归 L06。

### 共享测试去向续审（2026-11-05）

- main `0ed7917b8` 已含 L15 SM-2 API/15 条原名测试，10 条被测函数可从
  `review_plan_process` 到达（`calculateNextReview`/`calculateEaseFactor`/`calculateNextReviewDate`），
  对照 Rust `spaced_repetition.rs:353-440,484-500` 逐原断言映射为 merged。
  job `20261104163919-93a437` 16 passed / exit 0；不据全 suite 绿关闭其余 5 个无生产调用证据的 helper。
- 初次复核时 pending 为 20；D11 随 main `fb463060d` 合入后，F7 tiktoken 正式根依赖已解除。
  对照 Rust `token_budget.rs:259-328` 原输入/断言，定向 job `20261104165839-630b72`：
  原剩余两例 2 passed / exit 0（7 skipped 仅标题过滤），现再映射 2 merged。
  当前 pending 18（L07 9 / L04 3 / L03 1 / L15 5），不更改 generated ledger 文件。
  L07 共享 manifest 与 L05 的本地 objects.ts 副本仍不同，不把副本调用算作正式消费。

### F4-V2-05：publication journal 对象字段 typed 解码（2026-11-05）

- Rust `crypto_publication.rs:25-38,139-145`：derive 反序列化先于任何回滚/清理。
  TS 仍以 JSON.parse 读取，误接收 `version:1.0` / `-0`、重复已知字段、已知字符串孤立代理项，
  且类型错误会被后续 trailing/非法 token 覆盖。
- 改用公开 `JsonReader`，已知字段流式校验、已知重复（含 Option null）先拒绝，缺失必填按声明顺序报错；
  未知字段明确 `skipIgnoredValue()`。UTF-8 严格解码与既有 IO 错误包装不变。
- 新测试经真实 `ctx.secrets.publication.recover`，对 null/非 null lease 验证：坏输入失败时
  新旧密钥与 journal 全部未变；合法 unknown（1e400/孤立代理项/深数组）仍可忽略并正常恢复。
  原实现 job `20261104163434-945a38`：9 failed/1 passed（包括误回滚反例）；修复后
  job `20261104163544-43de0c`：新旧 publication 测试 25 passed / exit 0。
- 本单元只闭合对象字段语义；后续数组形式见 F4-V2-06，不据 25 pass 宣称整个 journal 解码等价。

### 新 main 消费方接线阻塞（2026-11-05）

- 新合入 L22 `integration/src/stream-context.ts:220` 与 L14
  `qbank/src/question-import-service.ts:175,588-589` 假设 Value 数字都有 `.value`，
  没有处理 F3 接缝引入的 `{kind:'arbitrary',raw}`。自检 typecheck TS2339；另四项通过。
  不给 arbitrary 伪造 Infinity `.value`，不越权改 owner 的领域序列化/范围判断。
- 已通过 coord escalate（`2026-11-04T163253228Z-F4-security.md`）及直接 queue L22/L14 提交精确位置与请求。
  等 owner 处理后合 main 重验；此阻塞不当作 F4 全域完成证据。

### L01 V2-03/UD0040：独立 IgnoredAny 接缝（2026-11-04）

- `JsonReader.skipIgnoredValue()` 新增精确未知字段跳过面，公开类出口仍为 `util/api.ts`。
  依据 serde_json1.0.149 `de.rs:1102-1281,1910` 与 `read.rs::ignore_str/ignore_escape`：
  迭代栈、不构造值、不做浮点范围检查、不验证代理项配对、不消耗 typed 剩余深度。
  保留 pending colon、词法/结构检查及 ASCII 错误列号；已知字段仍用 typed 方法。
- 没有改 `skipValue()` 或 `nextKey()` 自动丢弃未读值的语义，旧调用方不受隐式放宽。
- `util/tests/json-ignored.test.ts`：L01 的 pages/unknown 向量、1e400、孤立代理项、
  未知 127/128/4096 层、非法 hex/未闭合/控制字符/坏数字，以及 known/legacy 深度和代理项继续拒绝。
  job `20261104155153-cebc7c`：新旧 reader 16 passed / exit 0。
  没有 Rust 执行、未新增 ported 行；L01 在 StoredSession/OAuthTokenResponse/AttachmentPreview
  真实入口接线后须自行复验，不用供方词法单测替代消费方签收。

### F3 文件头 JSON 检测：Value arbitrary_precision（2026-11-04）

- Rust `unified_file_manager.rs:829` 使用 `from_str::<Value>`；应用图启用 arbitrary_precision。
  `de.rs:937-1050` 的 Value `scan_*` 保留任意精度数字，`de.rs:1217-1281` 的 `ignore_*` 也不做
  f64 溢出检查。此前 reader 共用 typed 的 `number()`，误拒合法 `{"a":1e400}`。
- 已拆开数字词法与 typed 有限性检查：`parseJsonDocument` / `readValue` 保留 raw、超 f64 范围用
  `JsonValueNumber {kind:'arbitrary',raw}`，`skipValue` 仅检查词法（不再分配被忽略子树）；
  typed `readNumber`/`readUnsigned`/`readSigned` 仍拒绝同一超范围输入并先于 trailing 报错。
- `util/tests/json-exact.test.ts` + 真实配置命令回归 `settings/tests/backup-decoding.test.ts`：
  job `20261104152543-5e4c37`，18 passed / exit 0。覆盖未知扩展超范围数不影响后续 typed 字段、
  raw/重复键、无穷范围、非法词法、转义和深度/尾随字符边界。不改 TESTMAP、无 Rust 编译或全域等价签收。

### L12 ProcessingProgress.percent：f32 出站接缝（2026-11-04）

- `util/api.ts` / `util/index.ts` 增补 `f32ToJsonNumber(value): number | null`。
  依据 `dstu-vfs/Cargo.toml:47-50` 显式启用 arbitrary_precision、Cargo.lock 锁定
  serde_json 1.0.149 / zmij 1.0.21、`number.rs:323-338` 的 `Number::from_f32` 分支。
- 实现只做出站投影：按 f32 相邻值的精确二进制中点区间，搜索最少有效数字，取最近值/等距偶数；
  只有最终十进制转回 JS number。保留 -0，非有限和窄化溢出为 null，不修改现有 f64 `ryuFormat`。
- 静态向量来自 L12 两例与 zmij 1.0.21 `tests/test.rs::ftoa_test`（含最小次正规数、
  134217800/134217810 的边界取舍），另覆盖 f32 极值与每个有限指数的正负 roundtrip。
  Node 作业 `20261104150922-a7a89d`：4 tests passed / exit 0。
- Electron 作业 `20261104151448-fff7fe`：同 4 tests passed / exit 0。
  随 C2 反馈另显式保留 `Math.fround(1.1)` → `1.1` 及等距十进制选偶数向量。
  zmij 1.0.21 `src/lib.rs::to_decimal_schubfach` 的 `below_closer` 分支为最近/等距偶数的
  源码依据；本实现使用精确 bigint 有理数区间而非搬运其优化乘法表。
- 没有运行 Rust、没有差分签收；L12 尚需在真实 snapshot 接线并独立复验。
  未改 TESTMAP 去向或契约；nullable 契约由 F5 裁定。helper 不保证 `JSON.stringify(-0)` 的符号，
  也不向所有 f32 消费方自动推广。

- job `20261104095249-fc9862` typecheck exit 0。
- job `20261104095251-b12470` ledger exit 0，problems commands/tests/orphan 均 0。
- job `20261104095251-bc9049` strict exit 1：4 违规均在 L13 vfs；F4 仅已有 SQL allow。
- job `20261104095249-fee4f7` 错选整个 platform（含 F3/F7）：933 passed / 5 skipped / Errors 4 / exit 1，
  不计绿；F4 九目录 `20261104104914-5fe236` 为 35 files / 374 passed / 4 platform skips，exit 0，无 Errors。
- 30 条共享测试的逐 ID/符号证据在 `migration/testmap/F4-security.md:374-425`；
  L07 真消费、L15 正式集成、L04 agent 值接口、L03 difficulty 真消费、F7 tokenizer 正式集成仍待解除。
- Rust 实际密文样本、Windows DPAPI、Linux 桌面 keyring 为协调者暂缓的 C 级，不用模拟结果冒充。

### F4-V2-JSON：R4 c5304d793 反例的完整结果（供 typed owner 接入后复验）

| R4 反例 | 输入（经生产 `get_backup_config`，或直接用 `JsonReader`） | 当前 TS 结果 | 测试 |
|---|---|---|---|
| 负零给 u32 | `{"maxBackupCount":-0}` | `解析备份配置失败: invalid type: floating point \`-0.0\`, expected u32 at line 1 column 20` | `settings/tests/backup-decoding.test.ts`；reader 版 `[-0]` 在 column 3 报同样错误（`util/tests/json-exact.test.ts`） |
| UTF-8 列（emoji 计 4 字节） | `{"backupDirectory":"😀","slimBackup":1}` | `invalid type: integer \`1\`, expected a boolean at line 1 column 40` | 同上；reader 版 `{"a":"😀","b":false}` 在 column 21 |
| 已知字段重复且第二个值非法 | `{"slimBackup":true,"slimBackup":!}` | `duplicate field \`slimBackup\` at line 1 column 31`（不是 `expected value`） | 同上；reader 版 `{"a":1,"a":!}` 在 column 10 |
| 类型错误后跟尾随字符 | `{"slimBackup":"x"} trailing` | `invalid type: string "x", expected a boolean at line 1 column 17`（不是 `trailing characters`） | 同上 |

作业：`20261104122813-753c3d`（40 passed）、修正后的 `20261104124718-12c959`（14 passed），均 exit 0。
列号和文案是按 serde_json 1.0.149 / serde_derive 1.0.228 源码人工推算的期望值，没有和 Rust 实际输出做差分对照。
这些结果只覆盖 F4 自己的 BackupConfig/AutoBackupStatus 解码器。L11/L12/L23/F3 接入后各自独立复验；
lane-gate 绿不代表 serde 全域等价。X6 `unchecked-decode` 只扫描 `host/plugins`，没有扫到 `host/platform/util/json-exact.ts`；
F4 不申请模块级豁免。消费方需要豁免时，按 `gate-checks/approved-decoders.json` 的精确路径加协调者批准机制办理。
