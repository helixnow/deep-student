# agent-skills 等价场景（WAVE0 首包 WP-050）

功能组：本地技能目录的列出/读取/创建/更新/删除、zip 导入、tap 导出、requires 探测、tap 源离线拒绝、基于 provenance 的更新检查。
格式为 `board/WAVE0-EQUIVALENCE.md` §3 v0。这些场景**尚未在 A/B 上运行，没有 golden，不计 C 级**。

| 文件 | 场景数 | 命令 |
|---|---|---|
| `skills-local.json` | 17 | skill_list_directories、skill_read_file、skill_list_package_files、skill_create、skill_update、skill_delete、skill_import_zip、skill_export_tap、skill_probe_requires、skill_tap_catalog、skill_tap_install |
| `skill-updates.json` | 3 | skill_check_updates、skill_update_from_source、save_setting（种子，owner L19） |
| `skill-candidates.json`（WP-075，见文末） | 11 | chat_v2_record_skill_activation、chat_v2_list_skill_candidates、chat_v2_replay_skill_candidate、chat_v2_promote_skill_candidate、chat_v2_rollback_skill_candidate（另用 skill_create/delete/list_directories/read_file 读写文件系统） |
| `skill-market.json`（WP-242，见文末） | 6 | skill_market_skill_detail、skill_market_verify、skill_market_download_and_scan、skill_market_search（只含不联网的错误分支） |
| `skill-network-unreachable.json`（WP-242） | 5 | 4 条市场命令、skill_tap_catalog、skill_tap_install、skill_check_updates、skill_update_from_source（需运行器断网） |
| `skill-arg-shapes.json`（WP-242） | 4 | skill_check_updates、skill_probe_requires、skill_update_from_source、skill_tap_catalog、skill_tap_install（IPC 参数层错误） |
| `pending-network/skill-market-live.json`、`pending-network/skill-tap-live.json`（WP-242） | 2 + 1 | 联网成功路径，不进默认运行集 |

合计 20 个场景、14 条命令（13 条本 lane + 1 条 L19 种子命令），178 个步骤（标注 `expect:error` 的 77 个，未标注的 101 个；标注只是说明，以 A 端实际结果为准）。以上是 WP-050 的统计，WP-075 与 WP-242 的统计见各自章节。

## 运行器前提（X7 / X3）

1. **每个场景必须使用独立的 HOME**（以及 XDG_DATA_HOME、cwd）。Rust 的技能白名单（`skills.rs:89-148`）由 `dirs::home_dir()`、`dirs::data_dir()`、appDataDir、`current_dir()` 派生，场景路径都写成 `~/.deep-student/skills/...` 或 `~/.cursor/skills-cursor`。共享 HOME 会写进真实用户目录，也会让场景之间互相污染。`skill_export_tap` 固定读取 `~/.deep-student/skills`（`skill_taps.rs:761`），因此本包的 ID 都带 `w0-` 前缀。
2. **步骤引用支持嵌在字符串中间**：`${4.path}.zip`、`${0.path}/sub`。场景里没有用到数组下标。
3. **文件系统状态不在 `db` 捕获范围内**。写入后都接了 `skill_list_directories`、`skill_read_file`、`skill_list_package_files` 读回，用来观察文件系统终态。如果运行器能对 HOME 下的技能目录做树快照，建议额外捕获。
4. normalize 目前全部为 `[]`。下面列出的差异只是候选，等 A 端录两次后再定，现在不预先忽略：
   - 错误文案里含 Rust `{:?}` 格式的绝对路径（带双引号转义，例如 `"/tmp/x/.deep-student/skills/..."`），这个值随 HOME 变化。两端 HOME 不同时，这一段可能需要按“HOME 前缀→占位符”替换，但路径的 Debug 引号必须保留并参与比对。
   - 越界错误文案 `Allowed bases: [...]`（`skills.rs:311-315`）里含 data_dir、cwd 派生的路径。
   - `package_sha256`：Rust 用 zip 0.6.6 + miniz_oxide 生成 deflate 字节，TS 用 zlib，两边字节可能不同。这是 BLOCKERS 里已有的待裁定项（`SPEC.md:386`），不在本包内处理。
   - `skill_check_updates(null)` 按 `ORDER BY updated_at DESC` 排序（`dstu-storage/src/database/mod.rs:4144`），而 `updated_at` 精度为秒，同一秒写入的多条记录顺序不确定。逐 ID 查询的步骤可以确定性比对，聚合查询那一步只作参考。
   - `skill_list_directories` 返回 Rust `read_dir` 的原始目录顺序，不排序（`skills.rs:399-430`）；Node `readdir` 是 libuv 排序后的顺序。`skills.list_directories.multi_entry_order` 专门暴露这个差异，**不应规范化掉**，前端 `loader.ts:186` 按这个顺序遍历。

## 命令入口与分支覆盖

前端行号来自当前分支 `src/`；Rust 行号相对 `src-tauri/`。TS 入口都在 `host/plugins/agent-skills/index.ts:237-278`。

| 命令 | 前端 invoke | Rust 入口 | 可达 Err / 提前返回 → 场景 |
|---|---|---|---|
| skill_list_directories | `features/chat/skills/api.ts:61`、`loader.ts:172` | `crates/dstu-agent/src/chat_v2/skills.rs:370` | 越界 `:311` → traversal_rejected（绝对路径、`..`、`~`、空串）；不存在返回 `[]` `:385` → missing_hidden_files_only[0]；不是目录 `:390` → [5]；跳过隐藏目录 `:419`、只含文件 → [3][4]；多条目顺序 → multi_entry_order |
| skill_read_file | `api.ts:71`、`loader.ts:188,440` | `skills.rs:595` | 越界 `:605` → read_file[6][7]；不存在 `:608` → [4]；不是文件 `:615` → [5]；非 UTF-8 读失败 `:623` → export_import.roundtrip[6]；`~` 与 `./` 路径的回显 → [2][3] |
| skill_list_package_files | `api.ts:81`、`loader.ts:132` | `skills.rs:565` | 越界 `:533` → tree_skip_depth[13]；不存在返回 `[]` `:578` → [12]；不是目录 `:542` → [10]；缺 SKILL.md `:550` → [11]；跳过 node_modules/隐藏目录/build `:453`、深度 4 收、5 不收 `:472`、排序 `:590`、末尾 `/` → [8][9] |
| skill_create | `api.ts:91`（`SkillsManagementPage.tsx:630,1014,1063`） | `skills.rs:646` | 非法字符 `:665` → create[2-5]；空 ID `:674` → [6]；越界 `:688` → [8][9]；已存在 `:691` → [7]；create_dir_all 失败 `:700` → [11]；create_dir 失败 `:709` → [10]；Unicode 字母数字 ID、空内容、自动建嵌套 base → [0][1][12] |
| skill_update | `api.ts:105`（`SkillsManagementPage.tsx:606,1061`） | `skills.rs:743` | 越界 `:755` → update[7][8]；不存在 `:758` → [5]；不是文件 `:765` → [6]；成功与空内容 → [1-4] |
| skill_delete | `api.ts:117`（`SkillsManagementPage.tsx:698`） | `skills.rs:796` | 越界 `:808` → delete[5]；不存在 `:811` → [4][8]；不是目录 `:818` → [3]；缺 SKILL.md `:827` → [2]；成功后读回 → [6][7][9][10] |
| skill_import_zip | `SkillsManagementPage.tsx:856,900` | `skills.rs:2320` | 虚拟 URI 读失败 `:2361-2367` → import_zip.errors[7]；zip 不存在/不是文件 `:2379` → [1][2]；空包 `:2142` → [5]；base 越界 `:2156`（先于扫描）→ [6]、roundtrip[13]；无效 zip `:1394`→`:1346` → [3][8]；已存在且 overwrite=false `:2253` → roundtrip[11][15]；dry-run 不写盘 → [7][8][14]；安装、覆盖、`dryRun:null`、省略 dryRun → [9][12] |
| skill_export_tap | `api.ts:204`（`SkillsManagementPage.tsx:834`） | `src/chat_v2/skill_taps.rs:17` → `crates/.../skill_taps.rs:734` | 空列表 `:743` → export_tap.errors[0]；65 个 `:746` → [1]；64 个通过上限后报目录不存在 `:785` → [2][7]；非法 ID `:752` → [3][4]；非 .zip `:683` → [5]；双重编码 content URI `:680` → [6]；无可导出文件（只有隐藏文件）`:815` → [9]；本地写失败 `:705` → [11]；虚拟目标暂存后写失败 `:710-731` → [12]；同一 ID 重复 → [13]（结果待 A 定，zip 0.6.6 对重名条目的行为未在源码确认）；成功 → roundtrip[5] |
| skill_probe_requires | `features/chat/skills/requiresGating.ts:58` | `skill_requires.rs:87` | 没有 Err，返回值恒为 Ok。三种空输入 → empty_inputs；合法/非法/边界长度（bin 64/65、env 128/129）、invalid 排序去重 `:573`、重复的合法 bin 不去重 → valid_invalid_boundaries；python 包探测 → python_packages；前端实际发送 `python_packages`（snake_case），Tauri 只认 `pythonPackages`，这个键被忽略 → frontend_snake_case_key |
| skill_tap_catalog | `api.ts:168`（`SkillTapBrowser.tsx:177`） | `skill_taps.rs:462` | URL 解析错误 `:468`（`:83-123` 的非 github/http、缺 repo、`.git` 空 repo、空串）→ tap_catalog.offline_rejections |
| skill_tap_install | `api.ts:181`（`SkillTapBrowser.tsx:199,221`） | `skill_taps.rs:489` | zipUrl 不是 codeload 直链 `:519` → tap_install.offline_rejections（含省略可选参数） |
| skill_check_updates | `api.ts:305`（`SkillsManagementPage.tsx:433`） | `skill_updates.rs:354` | 没有 provenance、空过滤、未知 ID → no_provenance；不可重取的来源 `:303`；url 走 http 被拒、内网 IP 被拒、URL 解析失败（`fetch_executor.rs:658-683`）；tap 缺 `#`、tap 非 https（`skill_taps.rs:447-455`）；market 缺 slug `:215`、market slug 非法（`skill_market_client.rs:376,803`）；损坏 JSON/缺字段跳过并 warn `:389-397`；非法 ID、大写前缀（LIKE 能匹配但 strip_prefix 失败）跳过 `:378-383`；重复过滤 ID → offline_provenance_kinds |
| skill_update_from_source | `api.ts:328`（`SkillsManagementPage.tsx:470`） | `skill_updates.rs:414` | 非法 ID `:429`（空、全空白、非 ASCII、`.`）；trim 后找不到 provenance `:107`；损坏/缺字段 `:113`；不可重取 `:436`；重取失败 `:444`（http、内网、坏 URL、tap 两种、market 两种）→ update_from_source.errors |
| save_setting（L19） | `components/WebSearchAdvancedConfig.tsx:239` | `src/cmd/web_search.rs:541` | 只用来写 `skill.provenance.*` 种子，不覆盖它自己的分支 |

### 本包没有覆盖的分支（逐条说明原因）

- 需要网络、且 Rust 端点写死，不能参数化到本地模拟服务：
  - `skill_tap_catalog`、`skill_tap_install` 的下载和之后的全部分支（`skill_taps.rs:470-622`）：只接受 `https://github.com` 和 `https://codeload.github.com`。
  - `skill_check_updates`、`skill_update_from_source` 中 url/tap/market 来源的成功重取与 sha 比对（`skill_updates.rs:318-334,447-560`）：url 只接受 https 公网地址；market 的基地址写死为 `COMMUNITY_SKILL_MARKET_BASE = "https://clawhub.ai"`（`skill_market_client.rs:36`）。
  - 要覆盖这些分支，需要 X5/C1 提供 DNS+TLS 层的本地确定性服务（或经 D-007 授权的构建配置开关）。本包不连真实市场，也不改 Rust。
- 只能靠故障注入触发，前端命令无法到达：canonicalize、read_dir、单个目录项、文件类型读取的 IO 失败；remove_dir_all、write、staging、commit、rollback 失败；spawn_blocking join 失败；设置库读写失败（`skill_taps.rs:601`、`skill_updates.rs:368`）；白名单为空（`skills.rs:263`）。
- 需要 >2 MiB 的内联参数或特制 zip 字节，场景语法放不下：`MAX_SKILL_FILE_BYTES`（`skills.rs:349`）、zip 64 MiB 上限、条目数/条目名/单文件/总量上限、ZIP64、多卷、条目名冲突、根目录 SKILL.md 取 frontmatter 名（`skills.rs:1340-1535`）。这些分支需要 X3 提供 zip 种子文件。
- 平台相关：符号链接跳过（`skills.rs:499`，命令无法创建链接）；移动端路径；Windows verbatim 前缀。

## 剩余命令（本 lane，未纳入本包）

- 市场组：skill_market_search、skill_market_skill_detail、skill_market_verify、skill_market_download_and_scan。已由 WP-242 接手，见文末。以下是 WP-050 当时的记录：属于网络型命令，需要参数化的本地市场服务。另外，X1 冒烟（`/tmp/opencode/x1-smoke-wc0AaK/summary.json`，见 `board/INTEGRATION.md:52`）中 Node 侧 `skill_market_search` 有一次耗时 5006 ms，原因**待归因**：可能是真实市场不可达导致的超时，也可能是其他原因。本包不调整预算，也不认定为生产回归。
- 候选/用量组：已由 WP-075 的 `skill-candidates.json` 接手，见下一节。
- “启用/信任”不属于本 lane：`chat_v2_set_skill_trust`（`skillTrustStorage.ts:156`）归 L05（`contracts/ipc/L05-agent-workspace.json:610`）。

---

# 技能候选与使用记录（WP-075）

文件 `skill-candidates.json`：11 个场景、161 步（标 `expect:error` 的 86 步，只是说明，以 A 端实际结果为准），全部 `seed: "empty"`、`capture.events=true`、`db=["*"]`、`normalize=[]`。尚未在 A/B 上运行，不计 C 级。ID 前缀 `w0c-`，与 WP-050 的 `w0-` 不冲突。

## 命令清单与入口

本组 5 条本 lane 命令都在 Rust `src-tauri/src/lib.rs:2503-2509` 注册，TS 在 `host/plugins/agent-skills/index.ts:280-293` 注册。真正有前端调用的只有 1 条：

| 命令 | 前端 invoke | Rust 入口 | 说明 |
|---|---|---|---|
| chat_v2_record_skill_activation | `src/features/chat/skills/skillUsageStats.ts:37`（常量 `:21`，参数 `{ skillId, sessionId: sessionId ?? null }`）；调用方 `core/store/skillActions.ts:223-224` | `crates/dstu-agent/src/chat_v2/skill_usage.rs:1102` → `SkillUsageRepo::record_activation :232` → `insert :205` | 契约 `contracts/ipc/L07-agent-skills-ptc.json:102` 记为 `frontend: none`，是静态抽取器没认出常量名（`scripts/electron-migration/frontend-audit/result.json` 能识别到）。契约不由本 lane 改 |
| chat_v2_list_skill_candidates | 无 | `skill_replay.rs:1264` → `list_candidate_summaries :1249` → `SkillCandidateRepo::list_filtered`（`skill_usage.rs:623`） | `src/` 中没有任何调用，按 IPC 已注册命令写场景，不计入前端可达数 |
| chat_v2_replay_skill_candidate | 无 | `skill_replay.rs:1288` → `replay_candidate :470` | 同上 |
| chat_v2_promote_skill_candidate | 无 | `skill_replay.rs:1309` → `learned_skills_base :1354` → `promote_candidate_with_base :794` | 同上 |
| chat_v2_rollback_skill_candidate | 无 | `skill_replay.rs:1332` → `learned_skills_base :1354` → `rollback_candidate_with_base :914` | 同上 |

辅助命令 `skill_create`、`skill_delete`、`skill_list_directories`、`skill_read_file` 已由 WP-050 覆盖，这里只用来放置用户技能、读回文件系统终态，不重复覆盖它们的分支。

## 候选行没有公开 seed 入口（阻塞）

`skill_candidates` 表只有一条写入路径：`SkillCandidateRepo::insert_if_new`（`skill_usage.rs:520`），调用方是轮末钩子 `on_turn_committed`（`skill_usage.rs:772`，由 `pipeline/persistence.rs:1549` 调）和 `process_turn :795`。生成候选需要以下任一条件：

- trajectory：一轮聊天成功提交，且其中至少 3 个不同的成功工具调用（`:857-895`，`TRAJECTORY_MIN_DISTINCT_TOOLS` `:60`）；
- user_correction：retry / edit_and_resend 推翻上一轮（`:904-969`），或 G07 终态 `partial/blocked` 且本轮加载过技能（`:838-852`）。

这些都要经过 L03/L04 的聊天发送管线和能按脚本返回工具调用的模拟 LLM（X5）。前端没有直接写候选的命令，`chat_v2_record_skill_activation` 只写 `skill_usage`，不产生候选。所以从 empty 出发，replay/promote/rollback 只能走到参数校验和 “not found”，这些场景只算错误分支覆盖，**不算成功覆盖**；list 在空库上的成功返回只验证了过滤参数解析，没有验证行形状、排序和 limit 截断。

需要的 seed（owner：X3 历史 seed，或 X5 模拟 LLM + L03/L04 发送管线脚本；本 lane 不自造 SQL 种子）：

| 需要的 seed 行 | 覆盖的分支 |
|---|---|
| status=new/screened 的 trajectory 候选，带存在的 run/user 消息行与 tool_load usage 行，trace_hash 一致 | replay → passed（`skill_replay.rs:487-520`），转移 `replay_transitions :452` |
| 同上但删掉锚点消息、usage 行、改 skills_loaded、outcome=failed、改 trace_hash | replay → failed，漂移码 `anchor_run_missing / anchor_user_message_missing / usage_rows_missing / skills_diverged / outcome_invalidated / trace_hash_mismatch`（`:323-391`） |
| edit_and_resend / retry / outcome_failed 三种 user_correction 候选，锚点存在或缺失 | `reconcile_correction :393-450`：`anchor_usage_missing / correction_mark_missing / failure_mark_missing / payload_unparseable` |
| draft_payload 不是 JSON、evidence_refs 不是 JSON | `payload_unparseable / evidence_unparseable`；promote 的 `draft payload is unparseable :803`；rollback 的 `derive_learned_skill_id :565-602` |
| status 为 passed/failed/published/rolled_back 的候选 | replay 拒绝 `:480-486`；promote 必须 passed `:849-855`；rollback 必须 published `:923-929` |
| passed 候选 + `~/.deep-student/skills/learned-*` 下已有同名用户技能 / G09 技能（同或不同 trace_hash） | promote 冲突拒绝 `:732-736`、幂等 `:738-745`、版本递增 `:746-747`、真实落盘 `:750-783` |
| published 候选 + 文件存在（血缘一致/漂移）或被删 | promote 幂等返回 `:813-826`、拒绝覆盖 `:828-832`、自愈重装 `:833-846` |
| published 候选 + 技能目录存在（G09 血缘 / 非 G09）或不存在 | rollback 归档到 `.archive/<id>.rolledback-<ts>` `:965-1005`、拒绝退役非 G09 目录 `:974-980`、只推进状态 `:970-972` |
| 多行不同 status、created_at | list 的 status 过滤、`ORDER BY created_at, candidate_id`、limit 截断、摘要 `signals` 计数（`:1197-1247`） |

## 逐命令分支覆盖

| 命令 | 可达 Err / 提前返回 → 场景[步] | 未覆盖 |
|---|---|---|
| chat_v2_record_skill_activation | 成功：重复写入不去重（每次新 `susage_<uuid>` 行）、sessionId 为值/null/省略/空串/带空格（session 不 trim，None 落 `''`，`:239`）→ activation.record_basic[0-6]；trim 后为空 `:1108-1110` → skill_id_trim_and_length[2][3]；UTF-8 字节长度 255 收 / 256 拒（ASCII、CJK 3 字节 85/86、emoji 4 字节、é 2 字节）→ [4-12]；超长 sessionId 不校验 → [13]；Unicode 空白 trim → unicode_whitespace_trim；参数缺失/类型错/snake_case 键（Tauri 反序列化错误）→ arg_shape_errors[0-8]；多余键被忽略、`session_id` 键被忽略按 None 落库 → [9][10]；未知技能 ID、技能删除前后都照常落账、usage 行不随 `skill_delete` 删除 → unknown_and_deleted_skill；记录激活不产生候选 → record_basic[7][8] | 插入失败 `:225`、取连接失败、spawn_blocking join 失败 `:1116`：只能故障注入 |
| chat_v2_list_skill_candidates | 成功（空库）：status 省略/null/空串/全空白视为不过滤 `:1268`；7 个原名与 4 个别名 `parse_status_filter :1187`；trim 后匹配；limit 省略/null 用 50 `:70`，0、1、500、>500 截到 500 `:71`、u32 最大值 → list.empty_store_filters；未知过滤值 `:1271`（大小写、连字符、别名大小写、逗号列表）、status/limit 类型错、limit 负数/超 u32/小数/字符串 → list.invalid_filters | 行形状、排序、截断需要候选 seed（见上节）；查询/解析失败、join 失败只能故障注入 |
| chat_v2_replay_skill_candidate | 长度校验 `:1293-1298`（空、全空白、ASCII 255/256、CJK 85/86、trim 后 255）；not found `:477`（nil uuid、带空格的未知 ID 报错文本是 trim 后的 ID、同一未知 ID 两次）；参数缺失/类型错 → replay.invalid_and_unknown_id；激活行 ID/会话 ID 不是候选 → cross_id_namespaces[2][5] | 成功和全部状态/漂移分支需要候选 seed；`concurrently :501` 只能并发竞争触发 |
| chat_v2_promote_skill_candidate | 同上长度校验 `:1314`；`learned_skills_base :1354` 在技能根目录尚不存在时也通过 → promote[1]；not found `:802`；技能根目录、已有用户技能在报错后不变 → promote 末尾读回；ID 形似 `learned-workflow-*` 的已有用户技能目录不被触碰 → cross_id_namespaces[3] | 成功、幂等、冲突、版本递增需要候选 seed；暂存/提交 IO 失败、`concurrently :863` 只能故障注入；白名单为空 `skills.rs:263` 不可达 |
| chat_v2_rollback_skill_candidate | 同上长度校验 `:1337`；not found `:922`；报错后不创建 `.archive/`（`skill_list_directories` 对不存在目录返回 `[]`）、用户技能不变 → rollback 末尾读回；cross_id_namespaces[4] | 成功归档、拒绝退役、只推进状态需要候选 seed；`create_dir_all/rename` 失败、`concurrently :937` 只能故障注入 |

## WP-125 入口核差与剩余候选差异

WP-075 当时只列候选；WP-125 已核对 Rust、正式契约及 `index.ts:285-298` 的真实 `host.invoke` 路径。
下列结论是生产入口测试/源码审读证据，仍未运行 A/B 录制，不计 C 级；场景 `normalize=[]` 保持原样。

- **limit 越界：实际 IPC 正确，无需修实现。** `contracts/ipc/L07-agent-skills-ptc.json:14-49` 定义 status→limit、Option<u32>、0..4294967295；kernel `contracts.ts:262-286` 在调用 handler 前依次校验。负数/小数/超 u32 根本到不了 `normalizeListLimit`，不能以直接 helper 输入推断 IPC 差异。`tests/skill-candidates-ipc.test.ts` 验证精确错误；501 行自有候选种子验证省略/null→50、0→空、500/501/MAX→500 且不写库。
- **trim 字符集：真实差异已修。** `recordSkillActivation`、`normalizeCandidateId`、`normalizeListStatus` 改用 main 已发布的 `platform/util/index.ts::rustTrim`（`text.ts` 的 Unicode White_Space）。U+0085 被去掉、U+FEFF 保留；保留 trim 后 UTF-8 字节长度、原错误文案和 sessionId 原值。candidate helper 同时被 replay/promote/rollback 消费。原 7 条真实 IPC 断言修前 6 failed/1 passed（job `20261105195531-e3d4db`），修后连同 usage/replay 原测试 50 passed（`20261105195640-e59af7`）；原断言未修改。
- **参数错误顺序：真实入口已核。** status 类型错先于 limit 类型错，limit 类型错先于未知 status 业务错误；activation 的 skillId 类型错先于 sessionId 类型错，sessionId 类型错先于空 skillId 业务错误。测试保留精确字符串和失败不写 usage 的断言。
- **非确定字段（候选 normalize，未批准）**：`skill_usage.usage_id`（`susage_<uuid v4>`）、`created_at`（chrono `to_rfc3339()`，小数秒位数随值变化，`+00:00` 后缀）。不能抹掉行数、`kind='activation'`、`loads=0`、`outcome='unknown'`、`run_id/latency_ms/tokens` 为 NULL、`task_session_id` 原值（含 `''` 与未 trim 的空格）。
- **Tauri 参数错误文案**：缺键/类型错的报错由 Tauri `invoke` 参数反序列化层生成，TS 端需由 F1/F4 的参数层给出同形文本；本 lane 不负责该层。

## 剩余（本组）

- 候选成功流与状态机全部分支：阻塞于上文 seed，owner X3（历史 seed）或 X5 + L03/L04（脚本化聊天轮）。登记建议并入 D50（历史 seed 需求），市场成功流的网络前置仍是 D38，与本组无关。
- 前端可达数：本组只有 `chat_v2_record_skill_activation` 计入 765 条前端可达命令；其余 4 条若 X2 inventory 也确认无前端调用，应在 G3 例外清单里登记为“仅 IPC 注册、无前端入口”，由协调者裁定，本 lane 不自行批准。

---

# 市场、tap 与来源更新（WP-242）

本包补 G3-GAPS 中缺合法成功场景的 7 条命令，并给 `skill_check_updates`、`skill_probe_requires` 补错误场景。格式同上，全部 `seed: "empty"`、`normalize: []`；读命令场景 `capture={events:true, db:[]}`，有写盘或写设置的场景 `capture={events:true, db:["*"]}`。**尚未在 A/B 上运行，不计 C 级。** 场景 ID 前缀 `skills.market.*`、`skills.unreachable.*`、`skills.*.arg_shape_errors`、`skills.market_live.*`、`skills.tap_live.*`，与 WP-050/WP-075 不冲突。

| 文件 | 场景 | 步骤 | 标 `expect:error` | 运行集 |
|---|---:|---:|---:|---|
| `skill-market.json` | 6 | 76 | 71 | 默认集，任何网络环境下都不发请求 |
| `skill-network-unreachable.json` | 5 | 44 | 31 | 默认集，**前提：运行器无外网**（见下） |
| `skill-arg-shapes.json` | 4 | 35 | 30 | 默认集，不发请求 |
| `pending-network/skill-market-live.json` | 2 | 37 | 9 | 不进默认集 |
| `pending-network/skill-tap-live.json` | 1 | 20 | 8 | 不进默认集 |
| 合计 | 18 | 212 | 149 | |

## 为什么这 7 条在 main 上没有合法成功步

- `skill_market_*` 四条：基址是常量 `COMMUNITY_SKILL_MARKET_BASE = "https://clawhub.ai"`（Rust `skill_market_client.rs:36`，TS `src/skill-market.ts:24`），每条成功路径都至少发一次 HTTPS 请求，WP-050 当时没写。
- `skill_tap_catalog`、`skill_tap_install`、`skill_update_from_source`：WP-050 只写了联网前的拒绝分支。成功路径必经 `fetch_repo_zip`（`skill_taps.rs:126`，只接受 `https://codeload.github.com`）或 `refetch_package_bytes`（`skill_updates.rs:153`，url/tap/market 三种来源全部联网）。`skill_update_from_source` 的“不联网就成功”分支不存在：非法 ID `:429`、无 provenance `:107`、损坏 `:113`、不可重取 `:436` 都是 Err，第一个 Ok（`updated:false`，`:465-474`）在重取之后。
- 结论：这 7 条的成功场景只能放 `pending-network/`。按 L18 先例（WP-231），这些场景不计入默认运行集；G3-GAPS 的扫描口径包含 `pending-network`，所以它们会被识别为“有合法成功场景”，但录制前必须满足下文的解除条件。

## 运行器前提

1. 与上文相同：每个场景独立 HOME、XDG_*、TMPDIR（`scenario-v0.mjs::prepareScenarioRun` 已这样做）。`install_guards` 依赖这一点：Rust `read_bound_temp_zip`（`skill_market_client.rs:923-931`）先 canonicalize `std::env::temp_dir()/deep-student-skill-market`，独立 TMPDIR 下这个目录不存在，所以合法 sha + 任意 tempZipPath 都停在“artifact directory is unavailable”，不发请求。如果运行器共享 TMPDIR 且之前跑过下载，结果会变。
2. `skill-network-unreachable.json` 要求运行器所在网络命名空间解析不到 `clawhub.ai`、`github.com`、`codeload.github.com`（或无默认路由）。这是 D-169 已确认的“离线 DNS 失败正常 reject”分支。在联网机器上跑这个文件会真的访问外网，结果变成成功或 HTTP 错误；owner X7 负责在运行器层隔离网络（例如独立 netns），不满足时跳过整个文件，不要拆开跑。
3. Rust reqwest 0.11 用 `rustls-tls`（`src-tauri/Cargo.toml:157`），信任根是编译进去的 webpki-roots，不读系统 CA 或 `SSL_CERT_FILE`。所以“确定性 mock + 自签 CA”不能只靠环境变量注入到 A 端，需要 X5/X7 另定方案（D-007 授权的构建开关或可信证书）。另外 tap/url 来源经 `FetchExecutor` 的 SSRF 检查（`tools/fetch_executor.rs:658-683`），解析到回环/内网地址会被拒，mock 不能简单地把域名指到 127.0.0.1。

## pending-network：owner 与解除条件

- owner：X5（确定性市场/GitHub mock）+ X7（运行器网络隔离与 CA 注入）。
- 解除条件（全部满足后，把两个文件移到 `equivalence/` 根目录并在本节记录）：
  1. A/B 两端都能把 `clawhub.ai`、`github.com`、`codeload.github.com` 解析到同一个确定性 mock，且 TLS 校验在两端都通过、不改 Rust 业务代码；
  2. mock 的 IP 能通过 FetchExecutor 的 SSRF 检查，或经 C2 批准的同等替代；
  3. mock 返回固定内容：市场 search/list 至少 1 个条目（`items[0]` 被后续步骤引用）、该条目的 detail/verify（`ok:true`、`security.passed:true`、slug/version 与请求一致，否则 install 会在 `enforce_install_verdict :947` 被拒）、download 返回 zip；`zz-no-such-*` 返回 404；GitHub 仓库 `anthropics/skills` 的 `refs/heads/main` 返回含 `skills/pdf/SKILL.md` 的 zip，`zz-no-such-branch-w0`、`zz-no-such-owner-w0` 返回 404；
  4. 在 mock 就绪前如果要临时对真实外网录制，必须两端同一时间窗口各录两次，并接受 `anthropics/skills` main 分支与 clawhub 热门列表随时间变化的事实；这种录制只能作参考，不作 golden。

## 逐命令覆盖

前端行号相对 `src/`，Rust 行号相对 `src-tauri/crates/dstu-agent/src/chat_v2/`。“默认集”指 `skill-market.json` 与 `skill-arg-shapes.json`；“断网集”指 `skill-network-unreachable.json`。

| 命令 | 前端 invoke | Rust 入口 | 成功 → 场景 | 错误/提前返回 → 场景 | 未覆盖与理由 |
|---|---|---|---|---|---|
| skill_market_search | `features/chat/skills/api.ts:396`（`components/skills-management/SkillTapBrowser.tsx:264`，参数 `{q,limit:24,nonSuspiciousOnly,sort:'trending'}`） | `skill_market_client.rs:1197` | pending：list（trending/downloads/stars/非法 sort 回落 trending `:337`）、limit 0/100 被 clamp 到 1/50 `:335`、空白 q 走 list、q trim 后走 search `:1219-1232`、无结果 → `market_live.search_detail_verify[0-7,13]`（第 13 步再次请求同一 URL，覆盖进程级 5 分钟缓存 `:255`） | 参数层：limit 负数/超 u32/小数/字符串、nonSuspiciousOnly 非布尔、q/sort 类型错 → `market.search.arg_shape_errors`；DNS 失败 `:125` → 断网集 `unreachable.market_search`（含 q 为 `"Invalid"`：URL 进入 reqwest 错误文本，`map_skill_market_err :1479` 按 `contains("Invalid")` 会把 IO 错误归为 InvalidInput） | 429 重试与 RATE_LIMITED `:263-280`、非 2xx `:790`、JSON 解析失败、`enrich_verify` 的 security_verdicts 失败 `:1158` 需要 mock 返回特定状态码/坏 JSON。handler 本身不做输入校验，没有不联网的业务 Err |
| skill_market_skill_detail | `api.ts:405`（组件内无调用，代理工具 `builtin-skill_market_skill_detail` 与 demo `src/demo/app/packs/skills-mcp/backend.ts:254` 使用） | `:1238` | pending：`items[0].slug`、固定 `sonoscli`（Rust 测试 `decode_provenance_slug_and_version` 的 slug）→ `market_live.search_detail_verify[8][9]` | slug 非法 `sanitize_slug :803`（空、全空白、`/`、`..`、空格、`@`、CJK、`%2F`、129 字节、NBSP trim 后为空、零宽字符）、缺参/null/数字 → `market.detail.invalid_slug`；DNS 失败（含 trim、128 字节边界、slug 含 Invalid）→ `unreachable.market_detail_verify[0-3]`；404 → pending `[14]` | 非 2xx 以外的 JSON 错误、缓存命中需要 mock 控制 |
| skill_market_verify | `api.ts:412`（`SkillTapBrowser.tsx:306`） | `:1253` | pending：带版本、null、全空白版本（`:425` 过滤后不加 `?version=`）→ `[10-12]` | slug 非法（同上 11 种 + 版本非空时仍先校验 slug）、缺参、version 类型错、slug 是数组 → `market.verify.invalid_slug`；DNS 失败（含版本需百分号编码）→ `unreachable.market_detail_verify[4-8]`；不存在的 slug/版本 → pending `[15][16]` | 同上 |
| skill_market_download_and_scan | `api.ts:430`（`SkillTapBrowser.tsx:316` 扫描、`:355` 安装） | `:1278` | pending：扫描（指定版本 / null 版本经 verify 解析 `:1321`）、安装（overwrite false/true）后写 provenance 与 `AGENT_INSTALLED.json`，读回目录、package 文件、`skill_check_updates` → `market_live.scan_install_update[2][3][8][9][11][13][14][15][16][18][19]` | 不联网：版本无法解析 `:1334`（verify 与 detail 两段错误拼接、slug 非法、install=true 时也先解析、全空白版本跳过解析后在下载的 `sanitize_slug` 报错）→ `market.download_and_scan.version_unresolved`；install 守卫顺序：缺 sha `:1373` → sha 非 64 位十六进制 `:690`（空、63、65、非十六进制；大写+空白 trim 后合法）→ 缺 tempZipPath `:1380` → artifact 目录不存在 `:925`（含相对路径、空串）；版本非空时 slug 非法排在 sha 检查之后 → `install_guards`；参数层 → `arg_shape_errors`；DNS 失败（verify/detail 两段都失败的拼接文本、指定版本后下载失败）→ `unreachable.market_download_and_scan`；联网后：sha 不符 `:1403`、artifact 已被消费（`TempArtifactCleanup` 在 Err 后也删文件 `:918`）、tempZipPath 在 base 外 `:935`、缺 declaredRiskLevel `:1414`、已存在且 overwrite=false → pending `[4-7][10][12]` | 风险等级不一致 `:1420`（需 mock 让两次扫描结果不同，目前 sha 先比，同一 artifact 不可能 sha 同而风险不同）；artifact 超 64 MiB `:940`；`enforce_install_verdict` 拒绝 `:953/:961` 需 mock 返回 `ok:false` 或 slug 不符；GitHub handoff 分支 `:541-607`；save_setting 失败回滚 `:1447` 只能故障注入 |
| skill_tap_catalog | `api.ts:168`（`SkillTapBrowser.tsx:177`，预设 `https://github.com/anthropics/skills` `:58`） | `skill_taps.rs:462` | pending：仓库 URL、`www.` + `.git` + 尾斜杠 + 前后空白、`/tree/main/...`、codeload 直链 → `tap_live.catalog_install_update[0-3]` | URL 解析错误：WP-050 `skills.tap_catalog.offline_rejections`；参数层（缺参、null、数字、snake_case 键）→ `tap.arg_shape_errors[0-3]`；DNS 失败 `fetch_repo_zip :140`（main/master 两个候选的最后一个错误）→ `unreachable.tap[0-3]`；仓库不存在 → pending `[15]` | `scan_repo_zip_for_catalog` 的 InvalidInput（坏 zip、超 200 个技能）需 mock 返回特制 zip；spawn_blocking join 失败只能故障注入 |
| skill_tap_install | `api.ts:181`（`SkillTapBrowser.tsx:199` dry-run、`:221` 安装；前端总是发送 `dryRun` 与 `expectedPackageSha256`） | `skill_taps.rs:489` | pending：dry-run 扫描、带 sha 安装、overwrite=true 覆盖，读回 → `[4][8][10][11][19]` | 非 codeload 直链：WP-050 `skills.tap_install.offline_rejections`；参数层（缺 overwrite、overwrite=null、字符串、缺/空 subdir、zipUrl=null、dryRun/sha 类型错）→ `tap.arg_shape_errors[4-12]`；DNS 失败（dry-run、缺 sha、坏 sha 都在下载之后才校验）→ `unreachable.tap[4-6]`；联网后：缺 sha `:557`、sha 格式 `:564`、sha 不符 `:578`、已存在且 overwrite=false、子目录不存在、`../`、分支不存在 → pending `[5-7][9][12-14]` | 重打包超限 `:400`、save_setting 失败回滚 `:601` 只能靠特制 zip / 故障注入 |
| skill_update_from_source | `api.ts:328`（`SkillsManagementPage.tsx:470`） | `skill_updates.rs:414` | pending：tap 安装后 `updated:false`/`trust_status:"unchanged"`（`:465-474`）→ `tap_live[17]`；市场安装后同理（`market_version_bumped` 为 false）→ `market_live[17]` | 非法 ID、无 provenance、损坏、不可重取、各来源离线重取失败：WP-050 `skills.update_from_source.errors`；参数层（缺参、null、数字、数组、snake_case 键）→ `update_from_source.arg_shape_errors`；合法 tap/market（含 marketSlug 与只靠 sourceDetail 解析两种）/公网 url provenance 的 DNS 失败 `:444`（含 ID 前后空白 trim）→ `unreachable.update_sources[8-11]` | `updated:true` 分支（`:477-560`）需要 mock 在两次请求间换包；包 ID 漂移拒绝 `:481`；持久化失败回滚 `:533` 只能故障注入 |
| skill_check_updates | `api.ts:305`（`SkillsManagementPage.tsx:433`） | `skill_updates.rs:354` | 已有：WP-050 `no_provenance`、`offline_provenance_kinds`；新增：合法 tap/market/url provenance 离线时结果条目带 `error`（命令仍 Ok）→ `unreachable.update_sources[4-7]`；snake_case 键被忽略按 None → `check_updates.arg_shape_errors[6]` | 参数层：skillIds 为字符串/数字数组/含 null/混合/对象/布尔 → `check_updates.arg_shape_errors[0-5]` | handler 唯一的 Err 是 `get_settings_by_prefix` 失败 `:368`（数据库故障），seed=empty 下不可达；单条重取失败写进条目 `error`，不让命令失败（`:351-352`） |
| skill_probe_requires | `features/chat/skills/requiresGating.ts:58` | `skill_requires.rs:87` | 已有：WP-050 四个场景；新增全 null 对照 → `probe_requires.arg_shape_errors[6]` | 参数层：bins 为字符串/数字数组、env 含 null/为对象、pythonPackages 为字符串/布尔数组 → `probe_requires.arg_shape_errors[0-5]` | 函数返回 `SkillRequiresProbe`，不是 `Result`，handler 内没有 Err；只有 Tauri 参数反序列化能失败 |

辅助命令 `save_setting`（owner L19，写 `skill.provenance.*` 种子）、`skill_list_directories`、`skill_list_package_files` 只用来放置种子和读回终态，分支已由 WP-050 覆盖。

## 候选差异（未规范化，等 A 端录两次后再定）

- **artifact 目录不存在的错误文本**：Rust 是 `Community marketplace scan artifact directory is unavailable: No such file or directory (os error 2)`；TS 用 `realpathSync`，Node 错误文本是 `ENOENT: no such file or directory, realpath '…'`（`src/skill-market.ts:422-425`）。`install_guards[6-10]` 会暴露这个差异。这是生产文案差异，需要独立后续包修实现，本包不改。
- **DNS 失败文本**：Rust 按 reqwest 0.11 Display 输出 `error sending request for url (…): …`，D-169 记录 TS 已对齐；底层解析器的错误文本（getaddrinfo vs hyper/trust-dns）可能仍有差异。tap/url 来源走 FetchExecutor，文本由 `fetch_executor.rs` 生成。
- **slug trim 字符集**：Rust `str::trim` 按 Unicode White_Space，JS `String.prototype.trim` 额外去掉 U+FEFF、不去 U+0085。`sanitizeSlug`（`src/skill-market.ts:300`）用的是 JS `trim`。本包的非法 slug 用 NBSP（两边都去）与零宽空格（两边都不去），结果一致；`"\u0085x"` 或 `"\uFEFFx"` 会让一端判非法、另一端联网，所以没放进默认集。建议独立后续包改用 `platform/util::rustTrim`（WP-125 已在候选组这样做）。
- pending 场景里的 `installedAt`（chrono `to_rfc3339()`）、`tempZipPath`（含随机后缀）、市场热门列表顺序、`downloads`/`stars` 计数都是非确定字段，等 mock 就绪后再决定规范化规则。

## 统计（WP-242）

- 7 条目标命令全部有成功场景，但都只在 `pending-network/`（需联网 mock）；默认集与断网集里每条都有错误场景，合计默认集错误分支（按 Rust 分支计）：search 2（参数层、DNS）、detail 3（slug、参数层、DNS）、verify 3、download_and_scan 8（版本解析、缺 sha、sha 格式、缺 tempZipPath、artifact 目录、slug 顺序、参数层、DNS）、tap_catalog 3（WP-050 URL 解析 + 参数层 + DNS）、tap_install 3、update_from_source 6（WP-050 五类 + 参数层 + DNS）。
- `skill_check_updates`、`skill_probe_requires` 补了参数层错误场景；两者的 handler 内没有 seed=empty 可达的 Err，理由见上表。
- 未运行 A/B，未计 C 级。
