# L07-agent-skills-ptc 行为规格（`host/plugins/agent-skills/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 22 个 · 发出事件 4 种 · 契约：`contracts/ipc/L07-agent-skills-ptc.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：命令参数缺省按 Rust `unwrap_or` 默认值处理（如 market limit=24、nonSuspiciousOnly=true、install=false）；结果字段带 `skip_serializing_if = "Option::is_none"` 的不出现（`SkillMarketDownloadScanResult.tempZipPath`、卡片 `verify`、`currentVersion`/`remoteVersion`），无该属性的 `remoteSha256`/`error` 保留 `null`；TS 返回对象的可选键用缺省表示（skill_market_client.rs:973–1034,216–352）。
- [x] u64/i64 超过 2^53 的表示：Host 内部按 D3 精确保真——connector ledger 的 `expires_at_ms` 用 `defineQuery(..., { options: { safeIntegers: true } })` 读出 `bigint`，写侧接受完整 i64 `bigint` 或精确安全整数，过期判断全程 BigInt；仅在 JSON/IPC 结果边界按 Rust/Tauri `serde_json` 数字语义转成 `number`（connector confirm 的 `expires_at_ms`），不得在内部用 Number 舍入。契约与 TS 命令边界仍为 `number`；本 lane 其余 u64 仅市场 `downloads`/`stars`/`limit`，实际值远小于 2^53（contracts/ipc/generated/L07-agent-skills-ptc.ts:121–127；decisions.md D3）。
- [x] 字段顺序（serde_json preserve_order）：workspace `serde_json` 开启 `preserve_order`（src-tauri/Cargo.toml:101）；结果结构体字段顺序固定，provenance JSON 按写入顺序构造。TS 对象字面量保持同一插入顺序，`JSON.stringify(..., null, 2)` 与 `to_string_pretty` 对齐；不依赖 HashMap 的迭代顺序生成 wire 字段。
- [x] f32 精度：本 lane 无 f32 字段（命令结果均为整数、字符串、布尔与对象）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：`ChatV2Error` 命令统一抛 `{"code":"...","message":"..."}` JSON 字符串（error.rs:125–173），TS 用 `CommandError(JSON.stringify(...))` 复刻；`skill_probe_requires` 的 `error: never` 保持不抛；Rust 中会 panic 的客户端构造在 host 端改为正常 JS 异常（不 crash 进程），其余错误文案逐条保留。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：本 lane 现有命令均不接收取消信号；HTTP 仅用 `AbortSignal.timeout` 实现 Rust reqwest 的 10 s/30 s 超时，临时文件与暂存目录用 `finally`/显式清理对应 Rust `Drop`（skill_market_client.rs:915–945；skill-package.ts 的 StagedSkillDirectory.dispose）。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：Rust 的技能目录提交用全局 `Mutex`（skills.rs:1537–1541）；host 端 staging→commit 仍同步执行，等价单写者，而全部 ZIP 扫描/重打包/导出（tap catalog/install、market GitHub handoff、update-from-source tap、package scan）走本 lane 的有界 `worker_threads` 池（`src/workers/zip-pool.ts`，对应 Rust `spawn_blocking`）。worker 启动/退出/postMessage/池不可用按 join 失败归 `IO_ERROR`；worker 执行 ZIP 内容失败才归 `INVALID_INPUT`。市场 GET 缓存按进程共享但无跨 await 复合写；429 重试串行。设置写入在目录提交后串行执行并在失败时回滚。
- [x] 时间与 ID：生成方式、格式、时区：staging/backup/rollback 目录用 `randomUUID()`（对应 Rust `Uuid::new_v4()`），暂存导出用 `skills_tap_<uuid>.zip`；`installedAt` 用平台时间模块 `now().rfc3339`（chrono `AutoSi`，UTC 写 `+00:00`，不写 `Z`）；市场临时文件名用 `process.pid` + epoch 毫秒。无本地时区依赖。
- [x] 不对含 HashMap 的结构做序列化后比对：市场响应头、缓存键与内部 `Map` 只用于查找，不作为命令结果序列化；测试比较数组/对象字段而非哈希表迭代顺序（skill-market.test.ts、skill-package.test.ts）。

## 命令 `chat_v2_list_skill_candidates`

<!-- BEGIN GENERATED:cmd:chat_v2_list_skill_candidates -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs:1263` · async
- 前端：none
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：status?: string | null, limit?: integer(u32) | null
  - 结果：SkillCandidateSummary[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_list_skill_candidates -->

- [x] 输入：`status` 可选，先 `trim`，空串视同缺省；接受状态原名与任务层别名 pending→new / validated→passed / drifted→failed / promoted→published，无法识别时报 `unknown skill candidate status filter: {raw}`；`limit` 缺省 50、上限 500（skill_replay.rs:1218–1262,1160–1172）。
- [x] 输出：`SkillCandidateSummary[]`，按 created_at、candidate_id 升序；每项只含 candidateId/sourceKind/status/sessionId/traceHash/skillIds/signals/createdAt/updatedAt。trajectory 的 skillIds 取 payload.skills_loaded，user_correction 取 corrected_skill_ids；payload 损坏时 skillIds=[]、signals 全 0，列表仍成功。signals.distinctTools 是 tool_sequence 数组长度（不额外去重），toolCalls/failedToolCalls 取整数字段缺省 0（1221–1250）。绝不返回 draft_payload_json / evidence_refs_json（隐私红线，148–183）。
- [x] 错误：普通字符串；status 过滤非法为上述文案，DB/repo 失败为 `failed to list skill candidates: …`，`spawn_blocking` join 失败为 `list skill candidates task join error: …`（1250–1262,664–691）。
- [x] 事件：无（1252–1262）。
- [x] DB 读写：只读 chat_v2.db `skill_candidates`（list_filtered；1250–1257,630–653）。
- [x] 取消/并发：单次同步查询，无取消点；只读快照（1250–1257）。
- [x] 时间/ID：不生成时间或 ID，原样回传行的 created_at/updated_at（1221–1248）。

WP-125 输入边界核实：Rust `skill_replay.rs:1264-1279` → `index.ts:288-289` →
`normalizeListStatus` / `normalizeListLimit`。status 采用 F4 `rustTrim`（去 U+0085，保 U+FEFF）；
Option/u32 的类型及范围先由正式 IPC 契约、kernel `checkArgs` 按 status→limit 检查，业务 helper
不另建校验。`tests/skill-candidates-ipc.test.ts` 走真实 host.invoke，验证错误次序和 501 行数据库上的
默认 50、0、500、501、u32::MAX；查询前后候选行完全相同。此输入路径无新增日志/事件、无新取消点。

## 命令 `chat_v2_promote_skill_candidate`

<!-- BEGIN GENERATED:cmd:chat_v2_promote_skill_candidate -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs:1308` · async
- 前端：none
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：candidateId: string
  - 结果：SkillCandidatePromotion · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_promote_skill_candidate -->

- [x] 输入：`candidateId` 同 replay 校验；技能基目录为 `expand_path(DEFAULT_AGENT_SKILLS_BASE)`（`~/.deep-student/skills`）并经 `validate_skill_path` 白名单校验，Display 文本作普通字符串错误（1318–1348,327–339）。仅 passed 可晋升；published 走幂等/自愈通路；其它状态报 `must be validated ('passed') before promote; current status '{status}'`（915–928）。
- [x] 输出：`SkillCandidatePromotion {candidateId, status, draftPayload, promotedAt, skillId, skillFilePath, skillVersion, skillFileWritten}`；draftPayload 是指纹统计量草稿，不含用户内容；同 trace_hash 重复 promote 返回既有文件且 skillFileWritten=false（143–164,851–1010）。
- [x] 错误：候选不存在/草稿不可解析；目录同名但无 G09 血缘 → `skill id collision: … refusing to overwrite`；published 但血缘漂移 → `… lineage diverged (manual edit?); refusing to clobber`；暂存/落盘 IO 错误原样（含 `Failed to create skills base …`）；状态竞争 → `… status changed concurrently during promote`；join 失败 → `promote skill candidate task join error: …`（928–1010,1318–1340）。
- [x] 事件：无（1318–1340）。
- [x] DB 读写：读候选行；文件落盘成功后 `UPDATE skill_candidates SET status='published' WHERE candidate_id=? AND status='passed'`（原子守卫）；不写 skill_usage（928–1021）。
- [x] 文件副作用：把 draft_payload 渲染成 SKILL.md（frontmatter name/description/version/source=g09_candidate/source_kind/source_candidate_id/trace_hash/created_at + 统计量正文），经 `StagedSkillDirectory` 暂存→原子目录交换，并写同目录 `AGENT_INSTALLED.json`（sourceKind=g09_candidate、proposalId、contentSha256/packageSha256、packageVersion、files、installedAt、sessionId）。同工作流新观测按 lineage version 递增；先落文件再推进状态，失败保持 passed 可重试（540–910）。
- [x] 取消/并发：同步落盘 + 单写者目录提交；状态迁移守卫挡并发双晋升；无取消点（929–1010）。
- [x] 时间/ID：`promotedAt`/marker `installedAt` 为 UTC RFC3339；skill_id 由不含 session 的确定性签名派生（`learned-workflow-<sig12>` / `learned-correction-<sig12>`），version 从 1 起按 lineage 递增（549–600,864–878）。

## 命令 `chat_v2_record_skill_activation`

<!-- BEGIN GENERATED:cmd:chat_v2_record_skill_activation -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_usage.rs:1101` · async
- 前端：none
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：skillId: string, sessionId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_record_skill_activation -->

- [x] 输入：`skillId` 先 `trim`；trim 后为空或 UTF-8 字节长度 >255 → 错误 `invalid skill_id length: {len}`（`String::len` 是字节数，不是字符数）。`sessionId` 可选，不去空白；缺省/`null` 落空串（skill_usage.rs:1095–1113）。
- [x] 输出：`null`（Rust `Result<(), String>` 的 unit）；成功时插入一条 `skill_usage` 行，`kind='activation'`、`run_id=NULL`、`loads=0`、`outcome='unknown'`（1097–1113,243–259）。
- [x] 错误：普通字符串，不是 `ChatV2Error` JSON 信封；校验失败 `invalid skill_id length: …`，DB 失败 `failed to insert skill usage: …`，`spawn_blocking` join 失败 `skill activation task join error: …`（1095–1113,205–208）。
- [x] 事件：无（1095–1113）。
- [x] DB 读写：向 chat_v2.db `skill_usage` 仅 INSERT（front-end 激活通路）；不与轮末 `tool_load` 双计（1113,243–259）。
- [x] 取消/并发：`spawn_blocking` 写一条后返回；无取消点；不读其它表（1097–1113）。
- [x] 时间/ID：`usage_id = susage_{uuid v4}`，`created_at` 为 UTC RFC3339（`chrono::Utc::now().to_rfc3339()`）（204–216,243–258）。

WP-125：Rust `skill_usage.rs:1107-1116` → `index.ts:285-286` → `recordSkillActivation`，
只将此处 JS trim 改为 F4 `rustTrim`；其后 `Buffer.byteLength(..., 'utf8')` 和 0/255 边界不变。
真实 host.invoke 用例验证 U+0085/U+FEFF、255/256 字节、sessionId 不 trim、类型错误先于业务错误，
以及失败不落库、重复激活各插一行、所有默认列/UUID/RFC3339、无候选及事件副作用。
DB 仍只写本 lane 的 skill_usage；普通字符串错误仍由既有 CommandError 包装，无新增运行时分支。

## 命令 `chat_v2_replay_skill_candidate`

<!-- BEGIN GENERATED:cmd:chat_v2_replay_skill_candidate -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs:1287` · async
- 前端：none
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：candidateId: string
  - 结果：ReplayReport · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_replay_skill_candidate -->

- [x] 输入：`candidateId` trim 后非空且 UTF-8 字节长度 ≤255，否则 `invalid candidate_id length: {len}`（1287–1304）。仅 status ∈ {new, screened} 可回放；其它状态报 `skill candidate {id} is not replayable in status '{status}'`（1127–1136）。
- [x] 输出：`ReplayReport {candidateId, sourceKind, sessionId, stillValid, driftReasons, traceHashStored, traceHashRecomputed, traceHashMatches, previousStatus, resultingStatus, replayedAt}`；stillValid = 无漂移码且重算 hash 等于库存值，写回 passed，否则 failed；traceHashRecomputed 在 payload 损坏时为 null（1137–1168）。
- [x] 错误：候选不存在 `skill candidate not found: {id}`；探针 DB 错误原样向上（`failed to probe message existence: …` / `failed to list skill usage: …`）；状态守卫竞争 `… status changed concurrently during replay`；join 失败 `replay skill candidate task join error: …`；全部为普通字符串（1100–1168,1304–1316）。
- [x] 事件：无（1287–1316）。
- [x] DB 读写：读 `skill_candidates`、`chat_v2_messages`（run/user 锚点存在性）、`skill_usage`（按 run 的账目与 outcome）；随后以 `UPDATE … WHERE status=期望前驱` 逐步推进 new→screened→replaying→passed|failed（1100–1168,628–650）。
- [x] 取消/并发：先跑完全部只读探针再迁移状态，避免探针失败留下 replaying 中间态；状态迁移原子守卫，竞争即整体报错；无取消点（1109–1155）。
- [x] 时间/ID：`replayedAt` 为 UTC RFC3339；不生成新 ID（73–75,1160–1167）。

WP-125：Rust `skill_replay.rs:1292-1298` → `index.ts:291-292` → `normalizeCandidateId`，
与 activation 同用 F4 White_Space trim，随后仍按 UTF-8 字节校验再查候选。真实 host.invoke
验证 U+0085-only 报 length 0、U+FEFF-only 报含原字符的 not found、255 字节进查库、256 字节拒绝；
状态机/DB 查询更新和错误包装沿原实现。该 helper 的 promote/rollback 调用对应 Rust `:1313-1319,1336-1342`。

## 命令 `chat_v2_rollback_skill_candidate`

<!-- BEGIN GENERATED:cmd:chat_v2_rollback_skill_candidate -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs:1331` · async
- 前端：none
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：candidateId: string
  - 结果：SkillCandidateRollback · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_rollback_skill_candidate -->

- [x] 输入：`candidateId` 同 replay 校验；技能基目录同 promote。仅 published 可回滚，否则 `skill candidate {id} must be 'published' to rollback; current status '{status}'`（1331–1370）。
- [x] 输出：`SkillCandidateRollback {candidateId, status, skillId, retiredFrom, archivedTo, rolledBackAt}`；目录本就不存在时 retiredFrom/archivedTo 为 null，仅推进状态机（1035–1060,1082–1122）。
- [x] 错误：候选不存在/签名派生失败；目录存在但血缘缺失或漂移 → `refusing to retire non-G09 skill directory … (lineage missing or diverged)`；创建 `.archive` 或 rename 失败原样返回；状态竞争 → `… status changed concurrently during rollback`；join 失败 → `rollback skill candidate task join error: …`（1074–1122,1331–1350）。
- [x] 事件：无（1331–1350）。
- [x] DB 读写：读候选行；退役文件成功后 `UPDATE skill_candidates SET status='rolled_back' WHERE candidate_id=? AND status='published'`（1076–1080）。
- [x] 文件副作用：把 `<skills_base>/<skill_id>` 整体 rename 到 `<skills_base>/.archive/<skill_id>.rolledback-<UTC stamp>`（隐藏子目录，不物理删除）；先退役文件再推进状态，退役失败时保持 published 且技能仍可用（1030–1122）。
- [x] 取消/并发：同步 rename + 状态守卫；无取消点。
- [x] 时间/ID：`rolledBackAt` 为 UTC RFC3339；归档后缀 `YYYYMMDDTHHMMSS.mmmZ`；无新业务 ID（1035–1060,1105–1108）。

## 命令 `skill_check_updates`

<!-- BEGIN GENERATED:cmd:skill_check_updates -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_updates.rs:354` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:305`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：skillIds?: string[] | null
  - 结果：SkillUpdateCheckResult[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:skill_check_updates -->

- [x] 输入：`skillIds` 缺省检查全部 `skill.provenance.*`；设置按 `updated_at DESC` 枚举，跳过非法 skill_id 与 JSON 损坏记录（损坏仅告警）（354–405）。
- [x] 输出：每个技能一条 `SkillUpdateCheckResult`；`url`/`tap` 重新取包并比较 sha256，`skill_market` 只比较本地与远端 version（不下载包，`remoteSha256=null`），其它来源 `checkable:false`；`currentVersion`/`remoteVersion` 仅市场来源出现；单条失败写入 `error` 不中断整批（216–352）。
- [x] 错误：读取/枚举设置失败为 IO_ERROR；`url` 走 `download_https_bytes`（https/逐跳 SSRF/30 s/≤64 MiB），`tap` 重新下载仓库并确定性重打包，市场用共享客户端；错误保留在条目 `error` 字符串（129–214,236–352）。
- [x] 事件：无（354–405）。
- [x] DB 读写：只读主库 `settings` 前缀 `skill.provenance.`（354–370）。
- [x] 取消/并发：逐条串行检查；共享市场客户端缓存；无取消点（393–404）。
- [x] 时间/ID：无生成时间或 ID（216–352）。

## 命令 `skill_create`

<!-- BEGIN GENERATED:cmd:skill_create -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:646` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:91`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：basePath: string, skillId: string, content: string
  - 结果：SkillFileContent · 错误：string
<!-- END GENERATED:cmd:skill_create -->

- [x] 输入：先检查内容 UTF-8 字节数 ≤2MiB，再检查 Unicode alphanumeric/-/_，再空 ID，再目标路径（skills.rs:657–688）。
- [x] 输出：content 原样、path 为展开路径拼接 skillId/SKILL.md，不返回 canonical 路径（skills.rs:680–682,726–729）。
- [x] 错误：ChatV2Error → JSON 字符串 {code,message}；目录冲突先于创建；IO 逐步映射（skills.rs:690–722；error.rs:160–173）。
- [x] 事件：无 emit（skills.rs:657–730）。
- [x] DB 读写：无 DB；mkdir_all(base)、mkdir(skillDir)、write(SKILL.md)（skills.rs:698–722）。
- [x] 取消/并发：无取消、无创建互斥、失败不回滚已创建目录（skills.rs:698–722）。
- [x] 时间/ID：skillId 来自入参，无自动时间/ID（skills.rs:657–661）。

## 命令 `skill_delete`

<!-- BEGIN GENERATED:cmd:skill_delete -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:796` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:117`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：path: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:skill_delete -->

- [x] 输入：展开 ~，路径校验，存在性，目录类型，SKILL.md 存在性依次检查（skills.rs:803–832）。
- [x] 输出：unit → null（skills.rs:844）。
- [x] 错误：缺失 RESOURCE_NOT_FOUND、非目录/缺 SKILL.md INVALID_INPUT、删除失败 IO_ERROR，统一 JSON 字符串（skills.rs:811–839；error.rs:160–173）。
- [x] 事件：无 emit（skills.rs:803–845）。
- [x] DB 读写：无 DB；递归删除目录（skills.rs:834–840）。
- [x] 取消/并发：无取消、无互斥（skills.rs:803–845）。
- [x] 时间/ID：无（skills.rs:803–845）。

## 命令 `skill_export_tap`

<!-- BEGIN GENERATED:cmd:skill_export_tap -->
- Rust：`src-tauri/src/chat_v2/skill_taps.rs:17` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:204`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：skillIds: string[], destPath: string
  - 结果：TapExportResult · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:skill_export_tap -->

- [x] 输入：`skillIds` 非空且 ≤64，每个 id 必须匹配 `[\p{Alphabetic}\p{N}_-]+`（skill_taps.rs:743–758）；`destPath` 为虚拟 URI 时跳过扩展名检查，否则必须是 `.zip`，双重编码的虚拟 URI 拒绝（skill_taps.rs:676–689）；技能根目录固定为 `~/.deep-student/skills`（skill_taps.rs:761）。
- [x] 输出：`TapExportResult {path, skillCount, fileCount}`；zip 顶层为 `<skillId>/<相对路径>`，条目按路径排序，隐藏段与 `AGENT_INSTALLED.json` 跳过（skill_taps.rs:790–817），最后追加 `README.md` 技能清单（skill_taps.rs:856–863）；`fileCount` 含 README（skill_taps.rs:835,863）。
- [x] 错误：未选技能/超过 64/非法 id/目标非 `.zip` 为 `Invalid input: …`；读取技能目录、超 64 MiB、写目标失败为 `IO error: …`（skill_taps.rs:743–759,876–884,734–893）。
- [x] 事件：无（skill_taps.rs:656–893）。
- [x] DB 读写：无 DB（skill_taps.rs:656–893）。
- [x] 取消/并发：Rust 在一个 `spawn_blocking` 内构建并写盘（skill_taps.rs:762–884），Host 在 worker 中构建、以 `fs/promises` 异步写目标/暂存（L07-05），无取消点；虚拟目标先写应用私有暂存文件再交给 ContentResolver，失败也清理暂存（skill_taps.rs:691–732）。Electron 桌面端无该通道，`content://` 目标以明确错误失败（native-needs.md）。
- [x] 时间/ID：暂存文件名 `skills_tap_<uuid>.zip`（skill_taps.rs:712）；zip 条目时间戳固定为 `DateTime::default()`（1980-01-01）。

## 命令 `skill_import_zip`

<!-- BEGIN GENERATED:cmd:skill_import_zip -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2320` · async
- 前端：app（2 处，例 `src/components/skills-management/SkillsManagementPage.tsx:856`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：zipPath: string, basePath: string, overwrite: boolean, dryRun?: boolean | null
  - 结果：SkillImportZipResult · 错误：string · 注入：window
<!-- END GENERATED:cmd:skill_import_zip -->

- [x] 输入：`zipPath` 先 `expand_path`；`content://`/`asset://`/`ph://`/`image://`/`camera://` 与 SAF 前缀走虚拟读取通道（skills.rs:2357–2376）；本地路径要求 is_file 且 ≤64 MiB，读取时 `take(limit+1)` 防 TOCTOU（skills.rs:2378–2413）。`basePath` 经 `expand_path` + `validate_skill_path`；`dryRun` 缺省 false（skills.rs:2347）。
- [x] 输出：`SkillImportZipResult`：skill_id/path/files_extracted/scripts_count/references_count/allowed_tools_count/package_sha256/risk_level/risk_signals，`requires` 仅在有 SKILL.md 时探测并出现（skills.rs:2175–2217）。`path` 是逻辑拼接的安装目标，不 canonicalize。
- [x] 错误：空包/超限/非 zip/路径越界/重复路径/限额均 `Invalid input: …`，扫描器原始文案原样保留（skills.rs:2142–2161,1386–1535）；staging/写入/rename 失败为 `IO error: …`（skills.rs:2260–2275）；ChatV2Error JSON 字符串见 error.rs:160–173。本地 ZIP 打开失败为 `IO error: Failed to open zip "…": …`，读取失败为 `Failed to read zip "…": …`，并用 `take(limit+1)` 等价的有界读取保留 TOCTOU 限制（skills.rs:2397–2413）；本地 stat/open/read/close 对应 `tokio::fs`，经 `fs/promises` 执行，不阻塞 Host 事件循环（L07-05）。
- [x] 事件：无（skills.rs:2320–2350）。
- [x] DB 读写：无 DB（skills.rs:2320–2414）。
- [x] 取消/并发：Rust 用全局 `Mutex` 串行化目录提交（skills.rs:1537–1541,1823–1825）；host 端提交全程同步执行，等价于单写者。发布用 rename + rollback backup；Node 未暴露 `renamex_np`，走 Rust 的 fallback 分支（live→backup→staging→live），失败恢复旧目录（skills.rs:1887–2009）。无取消点（不响应 AbortSignal，与 Rust 一致）。
- [x] 时间/ID：staging 目录 `.NAME.staging-<uuid>`、backup `.NAME.backup-<uuid>`、rollback discard `.skill.rollback-discard-<uuid>`（skills.rs:1751,1918,2062）；无时间戳。

## 命令 `skill_list_directories`

<!-- BEGIN GENERATED:cmd:skill_list_directories -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:370` · async
- 前端：app（2 处，例 `src/features/chat/skills/api.ts:61`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：path: string
  - 结果：SkillDirectoryEntry[] · 错误：string
<!-- END GENERATED:cmd:skill_list_directories -->

- [x] 输入：先展开 ~，路径验证先于存在性；允许目录缺失返回 []（skills.rs:377–388）。
- [x] 输出：仅子目录、跳过隐藏名，文件系统枚举顺序不排序，path 保留逻辑拼接（skills.rs:407–433）。
- [x] 错误：非目录 INVALID_INPUT、枚举 IO_ERROR，ChatV2Error JSON 字符串（skills.rs:390–410；error.rs:160–173）。
- [x] 事件：无（skills.rs:377–434）。
- [x] DB 读写：无 DB；只读目录与跟随链接的 metadata（skills.rs:398–430）。
- [x] 取消/并发：无取消、无快照锁（skills.rs:377–434）。
- [x] 时间/ID：无（skills.rs:377–434）。

## 命令 `skill_list_package_files`

<!-- BEGIN GENERATED:cmd:skill_list_package_files -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:565` · async
- 前端：app（2 处，例 `src/features/chat/skills/api.ts:81`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：path: string
  - 结果：SkillPackageFileEntry[] · 错误：string
<!-- END GENERATED:cmd:skill_list_package_files -->

- [x] 输入：路径校验后要求目录且含 SKILL.md；缺失根返回 []（skills.rs:531–591）。
- [x] 输出：最多200项、深度≤4、跳过 symlink/隐藏目录/node_modules/target/dist/build，保留隐藏文件；相对 / 路径按 Rust UTF-8 排序；metadata 失败 size=0（skills.rs:446–525,588–591）。
- [x] 错误：无效目录 INVALID_INPUT、读取 IO_ERROR，JSON 字符串；仅 RESOURCE_NOT_FOUND 转 []（skills.rs:531–591）。
- [x] 事件：无（skills.rs:466–591）。
- [x] DB 读写：无 DB；只读目录及文件 metadata（skills.rs:466–525）。
- [x] 取消/并发：无取消与目录快照锁（skills.rs:466–591）。
- [x] 时间/ID：无（skills.rs:466–591）。

## 命令 `skill_market_download_and_scan`

<!-- BEGIN GENERATED:cmd:skill_market_download_and_scan -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1277` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:430`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：slug: string, version?: string | null, install?: boolean | null, overwrite?: boolean | null, expectedPackageSha256?: string | null, tempZipPath?: string | null, declaredRiskLevel?: string | null
  - 结果：SkillMarketDownloadScanResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:skill_market_download_and_scan -->

- [x] 输入：`install`/`overwrite` 缺省 false；`version` 为空时先 `verify(None)` 取 latest，失败再 `detail` 取 version，两路错误都拼进最终错误；仍为空则 `Community marketplace version could not be resolved (verify: …; detail: …)`。安装分支必须提供 64 位十六进制 `expectedPackageSha256` 与 `tempZipPath`（1277–1385,506–607）。
- [x] 输出：非安装返回 `SkillMarketDownloadScanResult {slug, version, provenance, tempZipPath, sourceKind("zip"|"github-handoff"), scan, installed:false}`；安装返回同一结构但 `tempZipPath` 缺省、`sourceKind:"confirmed-scan-artifact"`、`installed:true`（1360–1368,1468–1476）。`scan` 复用 `skill_import_zip` 的 dry-run/安装内核。
- [x] 错误：下载/verify 错误按 1479–1487 分类；GitHub handoff 重打包走 worker，worker 启动/退出/join 失败消息为 `Handoff repack task failed: …`（按 1482 规则归 `IO_ERROR`），ZIP 内容失败为 `Handoff repack failed: …` 再按 `Invalid/Unsupported/Incomplete` 规则分类；临时 zip 写入为 `IO error:`；安装前重新 verify 并要求 `ok && securityPassed && slug/version 完全匹配`，否则 `Invalid input:`；包 sha 或 risk 与确认时不同、`declaredRiskLevel` 缺失/非 low|medium|high 均 fail-closed；`tempZipPath` 必须位于 `<tmp>/deep-student-skill-market` 且为 ≤64 MiB 的 `.zip`（923–967,1371–1425,1479–1487）。
- [x] 事件：无（1277–1477）。
- [x] DB 读写：安装成功后 UPSERT 主库 `settings` 键 `skill.provenance.{skillId}`，值为 `AGENT_INSTALLED.json` 同款 provenance；写失败回滚目录并返回 `Failed to persist skill market provenance …`（1427–1459；dstu-storage database/mod.rs:4108–4119）。
- [x] 取消/并发：下载→写临时 zip→重新 verify→staging→commit 串行；无取消点。安装使用单写者目录提交锁（skills.rs:1537–1541）。
- [x] 时间/ID：临时文件名 `{sanitized-slug}-{pid}-{epochMillis}.zip`，24 小时后清理；`installedAt` 为 RFC3339 UTC；provenance 固定 `sessionId="skills_management"`（857–882,1427–1439）。

## 命令 `skill_market_search`

<!-- BEGIN GENERATED:cmd:skill_market_search -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1196` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:396`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：q?: string | null, limit?: integer(u32) | null, nonSuspiciousOnly?: boolean | null, sort?: string | null
  - 结果：SkillMarketSearchResponse · 错误：string
<!-- END GENERATED:cmd:skill_market_search -->

- [x] 输入：`q` 缺省空串；`q.trim()` 为空走 `GET /api/v1/skills?sort=`（sort 仅 downloads/stars/trending，其它回退 trending），否则 `GET /api/v1/search?q=`；`limit` 缺省 24，夹在 1–50；`nonSuspiciousOnly` 缺省 true（skill_market_client.rs:1196–1233,289–373）。所有 GET 走 5 分钟进程级缓存，429 最多重试 2 次、按 `Retry-After`（最少 1 秒、封顶 30 秒）等待（154–287,775–781）。
- [x] 输出：`SkillMarketSearchResponse {mode:"search"|"list", items}`；卡片字段 slug/displayName/summary/version/downloads/ownerHandle/stars；有 version 的条目（最多 100）批量 POST `/api/v1/skills/-/security-verdicts` 附 `verify`，ownerHandle 为空时用 publisherHandle 填充；`verify` 无值时不出现（1158–1189,973–992）。
- [x] 错误：HTTP 非 2xx 为 `Community marketplace {search|skills} failed (HTTP …): 前 200 字符`，429 耗尽为 `RATE_LIMITED: …`；`map_skill_market_err` 把 RATE_LIMITED 归 `Other`，含 Invalid/Unsupported/Incomplete 归 `INVALID_INPUT`，其余 `IO_ERROR`，最终 `to_command_error` JSON 字符串（790–801,1479–1487；error.rs:160–173）。advisory 徽章请求失败只保留无徽章（1173）。
- [x] 事件：无（1196–1235）。
- [x] DB 读写：无 DB（1196–1235）。
- [x] 取消/并发：单次请求超时 10 s；同步顺序 enrich；无取消点（36–44,233–246）。
- [x] 时间/ID：无生成时间或 ID；仅缓存时间戳（154–219）。

## 命令 `skill_market_skill_detail`

<!-- BEGIN GENERATED:cmd:skill_market_skill_detail -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1237` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:405`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：slug: string
  - 结果：SkillMarketSkillDetail · 错误：string
<!-- END GENERATED:cmd:skill_market_skill_detail -->

- [x] 输入：`slug` 经 `sanitize_slug`：trim 后非空、≤128 字节、仅 ASCII 字母数字与 `-_.`，否则 `Invalid community marketplace skill slug`；再 URL 编码请求 `GET /api/v1/skills/{slug}`（803–813,375–412）。
- [x] 输出：`SkillMarketSkillDetail`；`latestVersion.version` 优先、其次 `skill.tags.latest`，owner 取根级 `owner`，缺失字段为空串/0（375–412,995–1006）。
- [x] 错误：HTTP 非 2xx 为 `Community marketplace skill detail failed (HTTP …): …`；JSON 形状错误为 `Invalid community marketplace detail JSON: …`；按 1479–1487 分类（375–412）。
- [x] 事件：无（1237–1250）。
- [x] DB 读写：无 DB（1237–1250）。
- [x] 取消/并发：GET 缓存与 429 重试同 search（249–287）。
- [x] 时间/ID：无（1237–1250）。

## 命令 `skill_market_verify`

<!-- BEGIN GENERATED:cmd:skill_market_verify -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1252` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:412`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：slug: string, version?: string | null
  - 结果：SkillMarketVerifyResult · 错误：string
<!-- END GENERATED:cmd:skill_market_verify -->

- [x] 输入：`slug` 同 detail 校验；`version` trim 后非空才附加 `?version=`；请求 `GET /api/v1/skills/{slug}/verify`（414–451）。
- [x] 输出：`SkillMarketVerifyResult`；`ok` 缺省 false、reasons 缺省 []、slug 缺省请求 slug、security.status 缺省 `"unknown"`、security.passed 缺省 false（430–450,1008–1020）。
- [x] 错误：HTTP 非 2xx 为 `Community marketplace verify failed (HTTP …): …`；JSON 错误为 `Invalid community marketplace verify JSON: …`；按 1479–1487 分类（428–431）。
- [x] 事件：无（1252–1271）。
- [x] DB 读写：无 DB（1252–1271）。
- [x] 取消/并发：GET 缓存与 429 重试同 search（249–287）。
- [x] 时间/ID：无（1252–1271）。

## 命令 `skill_probe_requires`

<!-- BEGIN GENERATED:cmd:skill_probe_requires -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_requires.rs:87` · async
- 前端：app（1 处，例 `src/features/chat/skills/requiresGating.ts:58`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：bins?: string[] | null, env?: string[] | null, pythonPackages?: string[] | null
  - 结果：SkillRequiresProbe
<!-- END GENERATED:cmd:skill_probe_requires -->

- [x] 输入：bins/env/pythonPackages 的 None → []；校验顺序 bins、env、python_packages（skill_requires.rs:87–99,366–402）。
- [x] 输出：bins/env/python_packages 保留顺序和重复项；invalid 按 UTF-8 排序去重；missing_count 不计非法名称（skill_requires.rs:547–583）。
- [x] 错误：无 Result 错误；进程启动/探测失败与 5 秒超时返回 found=false（skill_requires.rs:494–545）。
- [x] 事件：无 emit（skill_requires.rs:87–99,547–583）。
- [x] DB 读写：无数据库；读取 PATH、HOME、环境变量与可执行文件元信息（skill_requires.rs:404–492,559）。
- [x] 取消/并发：按声明顺序逐项 await；5 秒超时不杀死后台进程，不关联 invoke abandon（skill_requires.rs:494–545,551–567）。
- [x] 时间/ID：无时间戳与 ID 生成；单项探测超时 5 秒（skill_requires.rs:26）。

## 命令 `skill_read_file`

<!-- BEGIN GENERATED:cmd:skill_read_file -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:595` · async
- 前端：app（3 处，例 `src/features/chat/skills/api.ts:71`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：path: string
  - 结果：SkillFileContent · 错误：string
<!-- END GENERATED:cmd:skill_read_file -->

- [x] 输入：展开~、先校验路径再判断存在性与文件类型，不限文件名/大小（skills.rs:600–625）。
- [x] 输出：UTF-8 严格解码（保留 BOM），content/path，不 canonicalize 返回路径（skills.rs:623–630）。
- [x] 错误：缺失 RESOURCE_NOT_FOUND、非文件 INVALID_INPUT、IO/无效 UTF-8 IO_ERROR；JSON 字符串（skills.rs:607–625；error.rs:160–173）。
- [x] 事件：无（skills.rs:600–631）。
- [x] DB 读写：无 DB；只读文件（skills.rs:623）。
- [x] 取消/并发：无取消或读锁（skills.rs:600–631）。
- [x] 时间/ID：无（skills.rs:600–631）。

## 命令 `skill_tap_catalog`

<!-- BEGIN GENERATED:cmd:skill_tap_catalog -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs:462` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:168`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：repoUrl: string
  - 结果：TapCatalog · 错误：string
<!-- END GENERATED:cmd:skill_tap_catalog -->

- [x] 输入：`repoUrl` 仅接受 `https://github.com/{owner}/{repo}[/tree/{ref}]` 或 `https://codeload.github.com/…`；无 ref 时按 main、master 两个候选依次下载（skill_taps.rs:83–123）。下载复用 FetchExecutor：仅 https、逐跳 SSRF 检查、30 秒超时、64 MiB 上限（skill_taps.rs:126–141；fetch_executor.rs:574–707）。
- [x] 输出：`TapCatalog {repoUrl, resolvedZipUrl, skills[]}`，条目含 subdir/skillId/name/description/version/fileCount；扫描取仓库顶层前缀、跳过隐藏段、深度 ≤4、最多 200 条，子目录技能在前按路径排序、根技能最后（skill_taps.rs:194–294）。
- [x] 错误：URL 形状与 zip 内容扫描失败为 `Invalid input: …`；下载全部候选失败为 `IO error: Failed to download repository zip: …`；worker 启动/退出/join 失败为 `IO error: Catalog scan task failed: …`（skill_taps.rs:467–482）。
- [x] 事件：无（skill_taps.rs:462–483）。
- [x] DB 读写：无 DB，只读下载字节（skill_taps.rs:462–483）。
- [x] 取消/并发：下载后同步扫描；无取消点（skill_taps.rs:473–476）。
- [x] 时间/ID：无生成时间或 ID（skill_taps.rs:462–483）。

## 命令 `skill_tap_install`

<!-- BEGIN GENERATED:cmd:skill_tap_install -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs:489` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:181`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：zipUrl: string, subdir: string, overwrite: boolean, dryRun?: boolean | null, expectedPackageSha256?: string | null
  - 结果：SkillImportZipResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:skill_tap_install -->

- [x] 输入：`zipUrl` 必须以 `https://codeload.github.com/` 开头；下载后按 `subdir` 确定性重打包（隐藏文件/空段/`..` 跳过，输出条目排序、固定压缩与时间戳，≤64 MiB）（skill_taps.rs:519–538,304–407）。`dryRun` 只扫描不写盘；非 dry-run 必须提供 64 位十六进制 `expectedPackageSha256`（skill_taps.rs:540–581）。
- [x] 输出：重打包字节走 `SkillImportZipResult` 扫描/安装内核；安装前写入 `AGENT_INSTALLED.json` provenance（sourceKind=“tap”、sourceDetail=`{zipUrl}#{subdir}`、packageSha256、riskLevel、installedAt、sessionId=`skills_management`），并持久化到设置键 `skill.provenance.{skillId}`（skill_taps.rs:583–613）。
- [x] 错误：非 codeload URL、期望哈希缺失/非法/不匹配均为 `Invalid input: …`（含 `Tap package changed after confirmation: expected …, got …`）；ZIP 内容重打包失败为 `Invalid input: …`，下载/worker 启动退出或 join/提交/写设置为 `IO error: …`；设置写入失败会回滚已提交目录（skill_taps.rs:519–524,533–537,553–581,600–612）。
- [x] 事件：无（skill_taps.rs:489–623）。
- [x] DB 读写：主库 `settings` 表 UPSERT `skill.provenance.{skillId}`（Database::save_setting，dstu-storage database/mod.rs:4108–4119），仅在目录提交后写入；失败回滚（skill_taps.rs:598–613）。
- [x] 取消/并发：下载→重打包→staging→commit；无取消点。目录提交单写者，设置写入在提交后串行执行（skill_taps.rs:540–613）。
- [x] 时间/ID：`installedAt` 为 UTC RFC3339（chrono `Utc::now().to_rfc3339()`，skill_taps.rs:589）；staging/backup 目录名含 uuid（skills.rs:1751,1918）。重打包 deflate 字节与 Rust zip/miniz_oxide 不同，`packageSha256` 与既有 Rust 安装记录不一致时会出现一次误报更新（见“语义歧义”）。

## 命令 `skill_update`

<!-- BEGIN GENERATED:cmd:skill_update -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:743` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:105`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：path: string, content: string
  - 结果：SkillFileContent · 错误：string
<!-- END GENERATED:cmd:skill_update -->

- [x] 输入：先内容≤2MiB，再展开/路径校验/存在/文件类型（skills.rs:748–770）。
- [x] 输出：content 原样、path 展开后逻辑路径（skills.rs:779–782）。
- [x] 错误：大小/路径/类型 INVALID_INPUT、缺失 RESOURCE_NOT_FOUND、写入 IO_ERROR；JSON 字符串（skills.rs:749–775；error.rs:160–173）。
- [x] 事件：无（skills.rs:748–783）。
- [x] DB 读写：无 DB；原地覆盖文件（skills.rs:773–775）。
- [x] 取消/并发：无取消/OCC/互斥，不做原子 rename（skills.rs:773–775）。
- [x] 时间/ID：无（skills.rs:748–783）。

### 已观察到的原行为（保留）

`skills.rs:269–300`：目标不存在时只做逻辑规范化，已存在 base 则 realpath。
因此 macOS `/var` → `/private/var` 之类别名路径，在 base 已存在后创建/读取不存在的子路径可被路径校验拒绝。
调用方传 canonical 根时正常；迁移保持此行为。当前 IO errno 文案按 Node 系统错误表映射，Windows 原生错误编号仍需三平台验证。

## 命令 `skill_update_from_source`

<!-- BEGIN GENERATED:cmd:skill_update_from_source -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/skill_updates.rs:414` · async
- 前端：app（1 处，例 `src/features/chat/skills/api.ts:328`）
- 契约：`contracts/ipc/L07-agent-skills-ptc.json`
  - 参数：skillId: string
  - 结果：SkillUpdateApplyResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:skill_update_from_source -->

- [x] 输入：`skillId` trim 后必须匹配 `[A-Za-z0-9_-]+`，否则 `Invalid input: Skill ID can only contain letters, numbers, hyphens, and underscores`；读取 provenance，缺失为 `ResourceNotFound`，损坏为 IO_ERROR；来源必须是 url/tap/skill_market（414–470）。
- [x] 输出：`SkillUpdateApplyResult {skillId, updated, packageSha256, riskLevel, path, trustStatus}`；sha 与记录相同且非市场 version 漂移时 `updated:false, path:"", trustStatus:"unchanged"`；实际更新后 `trustStatus:"untrusted"` 并要求用户重新信任（30–66,472–486,595–611）。
- [x] 错误：重新取包失败为 IO_ERROR；tap 来源的仓库 zip 重打包走 worker，worker 启动/退出/join 失败保留 `Repack task failed: …` 并归 IO_ERROR；dry-run 扫描发现 skill_id 漂移为 `Upstream package now installs '…' instead of '…'; refusing to update…`；设置写失败回滚目录（488–501,571–590）。
- [x] 事件：无（414–488）。
- [x] DB 读写：读 + 成功后 UPSERT `skill.provenance.{skillId}`；新 provenance 增加 `updatedFromSha256`，市场来源写回 `marketSlug`/`marketVersion`；`installedAt` 更新（531–583）。
- [x] 取消/并发：取包→dry-run→prepare→commit 串行；无取消点；目录提交单写者（skills.rs:1537–1541）。
- [x] 时间/ID：`installedAt` 为 RFC3339 UTC；`sessionId` 沿用旧 provenance；无新 ID（531–556）。

## 事件 `acr:bridge-cancel`

<!-- BEGIN GENERATED:event:acr:bridge-cancel -->
- 事件名 `acr:bridge-cancel`，常量 `ACR_BRIDGE_CANCEL`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:237`（emit）
<!-- END GENERATED:event:acr:bridge-cancel -->

- [x] 载荷：`{correlationId, bridgeToken, runId, toolCallId, sessionId}`，camelCase（workbench_bridge.rs:225–234）。
- [x] 触发时机与顺序：超时、响应通道关闭、取消、桥 future 被 drop 时各发一次；超时/取消先 emit cancel 再等 3 秒权威回执（workbench_bridge.rs:236–245,410–511）。
- [x] 节流/合并：不节流，每个 bridge 调用最多一次（workbench_bridge.rs:452–511）。
- [x] 是否在事务提交后：与数据库无关（workbench_bridge.rs:295–512）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`window_ref()` 的窗口 `emit`，即全局广播（workbench_bridge.rs:236–245,463）。

## 事件 `acr:bridge-request`

<!-- BEGIN GENERATED:event:acr:bridge-request -->
- 事件名 `acr:bridge-request`，常量 `ACR_BRIDGE_REQUEST`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:401`（emit）
<!-- END GENERATED:event:acr:bridge-request -->

- [x] 载荷：`AcrBridgeRequest` camelCase：correlationId、bridgeToken、command、args、timeoutMs、runId（`acr3:{sessionLen}:{session}:{toolCallId}`）、toolCallId、sessionId（workbench_bridge.rs:175–195,390–400）。
- [x] 触发时机与顺序：先注册 response/progress 监听，再 emit 请求；emit 失败返回 `bridge emit failed: …`（workbench_bridge.rs:331–408）。
- [x] 节流/合并：不节流；进度由前端 ≤5Hz，后端原样转发（workbench_bridge.rs:352–383）。
- [x] 是否在事务提交后：与数据库无关（workbench_bridge.rs:295–512）。
- [x] 目标窗口（emit / emit_to / emit_filter）：调用上下文窗口 `window.emit`（全局监听者）（workbench_bridge.rs:401–408）。

## 事件 `chat_v2://settings_changed`

<!-- BEGIN GENERATED:event:chat_v2://settings_changed -->
- 事件名 `chat_v2://settings_changed`，常量 `SETTINGS_CHANGED_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:93`（emit）
<!-- END GENERATED:event:chat_v2://settings_changed -->

- [x] 载荷：`{action, key:"mcp.tools.list"}`，由 `emit_mcp_list_changed` 构造（mcp_settings_store.rs:91–100）。
- [x] 触发时机与顺序：MCP 配置写入落地后调用；返回 emit 是否成功（mcp_settings_store.rs:85–100）。
- [x] 节流/合并：不节流（mcp_settings_store.rs:91–100）。
- [x] 是否在事务提交后：安全存储写入完成后（mcp_settings_store.rs:58–63,85–100）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`window.app_handle().emit`，全局（mcp_settings_store.rs:91–98）。

## 事件 `skill-lifecycle-bridge-request`

<!-- BEGIN GENERATED:event:skill-lifecycle-bridge-request -->
- 事件名 `skill-lifecycle-bridge-request`，常量 `BRIDGE_REQUEST_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs:214`（emit）
<!-- END GENERATED:event:skill-lifecycle-bridge-request -->

- [x] 载荷：`{correlationId, command, args, sessionId}`（skill_lifecycle_executor.rs:200–220）。
- [x] 触发时机与顺序：技能治理桥调用前端时发出，等待 `skill-lifecycle-bridge-response:{correlationId}`；超时/取消逻辑与 ACR 桥同构（skill_lifecycle_executor.rs:190–260）。
- [x] 节流/合并：不节流，每次调用一次（skill_lifecycle_executor.rs:190–260）。
- [x] 是否在事务提交后：与数据库无关（skill_lifecycle_executor.rs:190–260）。
- [x] 目标窗口（emit / emit_to / emit_filter）：调用上下文窗口 `emit`（skill_lifecycle_executor.rs:206–218）。

## 工具执行器 `builtin-ptc_run`（PTC）

依据 `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` 与 `ptc_executor.rs`（非 IPC 命令；执行器由工具注册表调用）。解释器由 Host Context 的 `nativeStarlark` 服务提供（F7 `host/platform/native/starlark` 的真实 `starlark 0.14.2` WASI 引擎），生产代码不直接 import 具体实现；本 lane 负责策略、预算、trace、物化与受管对象读写。

- [x] 输入：`script` 必须是字符串且 `trim` 后非空，字节数 ≤ 64 KiB（Rust `script.len()` 为 UTF-8 字节），否则 `ptc_run requires a 'script' string argument` / `ptc_run 'script' must not be empty` / `ptc_run script too large: N bytes (max 65536 bytes)`；`max_calls` 默认 50、0 视为越界回默认并 warn、>200 收敛到 200 并 warn；`timeout_secs` 默认 120、0 视为缺省、>600 收敛到 600 并 warn（ptc_executor.rs:120–170；ptc_runtime.rs:65–91）。
- [x] 执行：父 `AbortSignal` 派生脚本级取消；墙上时钟 `start + timeout_secs`；子调用经 `dispatchWithAdmission` 重新过中央准入，子上下文继承父 session_id/tool_call_id、派生 `${block}-ptc-${seq}` block，且不继承 shell 审批（ptc_executor.rs:196–258,537–560）。
- [x] `call(tool,args)`：工具名 trim 后补 `builtin-` 前缀；`builtin-ptc_run` 自我递归硬错误；只读面 fail-closed（36 个白名单名）+ 5 个受控写工具；工具执行失败返回 `{ok:false,error}` envelope 而不中断脚本；策略违规/预算耗尽/取消是硬错误；每次调用（含失败）留 trace，写调用标 `side_effect`（ptc_runtime.rs:381–516）。
- [x] 解释器限制：callstack 256、heap peak 32 MiB、tick 10,000,000；禁用 `load`；错误保留 `ptc_run script parse error:` / `ptc_run script error:` 文案（ptc_runtime.rs:65–91,1004–1015；F7 引擎）。
- [x] `object_read`：handle（校验 `capabilities.readable`）或显式 `{root_id,relative_path}`（camelCase 同受支持）；仅 `artifacts` root；页 ≤32 KiB、默认 8 KiB；offset 越界返回空页 eof=true、负数/0 limit 硬错误；UTF-8 不切半字符；返回 `{content,encoding,offset,limit,next_offset,total_size,eof,sha256}`；与 `call` 共用预算账本并留 trace（ptc_runtime.rs:531–600,727–790；dstu-core/task_objects.rs:790–955）。
- [x] `object_write`：handle 校验 `capabilities.writable` 或显式 locator；仅 `artifacts` root；内容 ≤256 KiB；`offset=None` 覆盖/新建、`offset=n` pwrite（不得越过现有长度）；`expected_sha256` 乐观锁仅对已存在目标生效且缺失目标报错；`utf-8`/`base64`（base64 0.21.7 canonical 语义）；tmp+rename 原子落盘；返回 handle，`derived_from` 为本脚本 `object_read` 过的来源（内容寻址），未读则为 `origin_unknown`；与 `call` 共用预算账本，trace 标 `side_effect`（ptc_runtime.rs:619–725,830–960；dstu-core/task_objects.rs:1010–1120）。
- [x] 大结果：`JSON.stringify(result,null,2)` 字符数 ≤4096 内联；超出则物化到 `<artifacts>/ptc/ptc-<callId>-<ms>.json`，返回 `object_handle`、`result_bytes`、`result_chars`、前 2048 字符 `preview` 与 `materialized_note`；无 artifacts 根时退化为 `result_truncated:true` + `preview` + `materialize_error`；物化失败只 warn 不失败（ptc_executor.rs:320–430）。
- [x] 输出：`{status:"ok",calls_used,duration_ms,trace,result,result_materialized}`，有写时追加 `writes_summary`（`seq/tool/ok/args_hash` + 可选 `locator/written_sha256`）；失败为 `{status:"error"|"timeout",error,...}`；timeout 文案 `ptc_run timed out after Ns (wall-clock)`。输入解析失败与缺失中央分发器直接 reject（`Err(String)`），并先发 tool_call_error（ptc_executor.rs:680–737；ptc_runtime.rs:333–379）。
- [x] 元数据：`can_handle` 接受 `builtin-ptc_run`/`ptc_run`，敏感度 Medium，`result_char_budget=None`，名称 `PtcExecutor`（ptc_executor.rs:740–768）。
- [ ] 生产接线（L07-01）：`index.ts:222–236` 已实例化并注册真实 `PtcToolExecutor`；`src/tools/ptc-tool-executor.ts:54–88` 将脚本子调用交给传入的 `admitted_tool_dispatcher`。但当前 main 没有生产调用 `agentTools.toolExecutors()` 的 L04 registry/dispatcher 组装点（Rust `pipeline.rs:155–181`），因此只确认提供方注册，端到端接线待 B1（`BLOCKERS.md`）。
- [x] 引擎接线（X4 W08）：`PtcExecutor` 每次执行通过 `ctx.get('nativeStarlark')` 解析 Host Context 的引擎，脚本、取消、deadline 与结果语义不变；profile 替换后下一次 PTC 执行立即使用新引擎，测试用替换服务记录 `evaluate` 调用（`tests/ptc-production-wiring.test.ts`）。
- [x] 只读白名单的生产权威是 L06 `tool_descriptors.ptc_allowed`：`ptc-runtime.ts` 直接使用 `agent-orchestration/api.ts` 发布的 `isPtcAllowed` 作为默认策略（`DESCRIPTOR_POLICY`），`PTC_ALLOWED_TOOLS` 仅保留为与 Rust 同一份的测试 oracle；两条同步测试已移植（`ptc_whitelist_delegates_to_descriptor_registry`、`controlled_write_policy_is_registered_non_destructive_and_disjoint`，tests/ptc-runtime.test.ts）。

## 服务与跨插件接线

- [x] 服务名（ARCHITECTURE.md §3）：本插件提供 `agentSkills`（`AgentSkillsService`）与 `agentTools`（`AgentToolsService`），`meta.provides`、Cordis `declare module` 键与 `ctx.provide` 名称一致；版本描述 `agentSkillsService`/`agentToolsService` 导出为 `{ name, version: '1.0.0' }`（index.ts:190；api.ts:321–331）。
- [x] 依赖声明：`inject: ['paths', 'settings', 'storage']`，生产路径经 `ctx.paths`/`ctx.settings`/`ctx.storage` 调用平台真实服务，不再用 `ctx.get(...)` 动态查找（index.ts:191–218）。
- [x] 跨插件接线：`agent-orchestration/api.ts` 已发布 `BUILTIN_DESCRIPTORS` / `isPtcAllowed`（L06，Rust `tool_descriptors.rs`）；PTC 默认策略直接调用该导出，不再保留生产回退 oracle。`PtcDescriptorPolicy` 注入点保留给需要替换策略的宿主/测试（ptc-runtime.ts:93–108）。
- [x] `agentTools` 执行器注册表：发布 `registerToolExecutors(executors)` / `toolExecutors()`（`AgentToolExecutorRegistry`），供 L10/L21/L24 等持有执行器的插件登记；注册顺序保持追加语义（Rust `ToolExecutorRegistry::register`，executor_registry.rs:201–207），派发/超时/审批仍归 L04。L24 `ChatAnkiToolExecutor` 的 `registerToolExecutors` 接口按本发布对齐（chatanki/api.ts:528–534）。
