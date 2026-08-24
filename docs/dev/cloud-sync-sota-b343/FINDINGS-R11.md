# FINDINGS-R11 — R10 七路 + R11 两路合入项核销与新发现

- 核销代理：R11-review；模型：`claude-fable-5-thinking-high`（ROUND-11 要求 xhigh，该 slug 当前不可用，**明示降级**，非静默）。
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `d46eff78`（隔离 worktree 只读检出，`/workspace` 未动）。行号/文件锚点以该 commit 为准。
- 范围：R10 已合入七路（conflict-ui / sota / ux / protocol / android / download / chaos）与 R11 已合入两路（rotate / check）逐条核销；新发现分级；仍开项锁定测清单；SOTA-R10 §3 矩阵改判建议。
- 验证手段声明（诚实）：本环境缺 `webkit2gtk-4.1`，Tauri 整仓 **无法编译**，Rust 测试**未运行**；核销以逐行源码核对为主，关键新发现（P1-1 号）另用**独立最小复现**实证（逐字复制被审函数 + 按真实容器布局构造输入，`rustc --edition 2021` 编译运行，输出见 §2）。前端 vitest 亦未运行（依赖未安装），只核文件与断言意图。

## 0. 结论（TL;DR）

1. **九路合入项全部实质到位**，声称的文件、接线、locale、测试文件均逐条核实存在且与描述一致（§1）。R10-conflict-ui 关 P1-1、R10-download 关 S3/FTP/默认 `get_file` 半包、R10-protocol 六锁定测、R11-rotate 文档四件套——证据锚点全部现场复核成立。
2. **一个 P1 新发现**：R11-check 的 `repo_check.rs` 把 DSBK v2 头长写成 48 字节（真实 44），分块字段从密文区 `[44..48]` 读取——对真实 v2 密文对象约 **98.4% 概率误报「DSBK 头不可解」**，加密仓库巡检（该功能的核心场景）实质不可用；且其自带单元测试与「加密好库全绿」集成测试按此逻辑**数学上必红**，说明交付时测试未真正运行。独立复现已实证（§2 P1-1）。
3. 两个 P2 新发现：`get_file_decoded` 是全仓零调用的死代码（且与真实下载路径语义相悖）；WebDAV `get_file` 是四条 provider 路径中唯一无字节数核对的（§2）。
4. 仍开项台账与锁定测映射见 §3；SOTA-R10 §3 矩阵建议翻 1 行、加注 2 行、新增行按「部分达」保守给分（§4）。

---

## 1. 合入项逐条核销

### 1.1 R10-conflict-ui（`3ccd5e38`，FINDINGS-R07 P1-1）— ✅ 核实到位

| 声称 | 核实 | 证据（@d46eff78） |
|---|---|---|
| 单条「保留本地」不再因缺 local 快照禁用 | ✅ | `RecordConflictsPanel.tsx:397`（`disabled` 不含 `!latestLocal`）、`:399`（cloud-only 时挂 hint title） |
| cloud-only 单条 keep_local 两击确认 | ✅ | `:161-170`（`locals.length === 0` 走 `unifiedConfirm`，确认拒绝即 return） |
| 批量 keep_local 纳入 cloud-only 组 | ✅ | `:211-215`（keep_local 不再过滤，keep_cloud 仍要求有 cloud 候选） |
| 人话空状态 + zh/en 两键 | ✅ | `:437-441`；`data.json`（zh `:1158-1159` / en `:1158-1159`），zh↔en 键对齐 |
| r07-cloud-only 锁定测改写 | ✅ | `tests/vitest/data-governance/r07-cloud-only-delete-conflict.test.tsx` 8 例：可点、确认拒绝不执行、expectedConflictIds 仅 cloud 行、批量含 cloud-only 且走确认 |
| FINDINGS-R07 P1-1 回写 | ✅ | FINDINGS-R07 顶部状态表「已关 / R10-conflict-ui」 |

### 1.2 R10-sota（`c9e6c572`，只改文档）— ✅ 核实到位

SOTA-R10.md（十家对照 + §3 矩阵）、ROUND-11.md（十路任务表 + 文件面独占 + 交叉规则）、README 索引两行均存在且内容与描述一致。§1 基线事实表抽核三行（文件级 E2EE / 校验子 / 下载续传）锚点成立。

### 1.3 R10-ux（`18419088`）— ✅ 核实到位

| 声称 | 核实 | 证据 |
|---|---|---|
| `localizeCloudError` 新增 S3 映射 | ✅ | `CloudStorageSection.tsx:193-195`（`当前安装包不支持\s*S3\s*兼容存储` → `errors.s3DisabledInBuild`） |
| `doSaveConfig` SSOT 失败带原因 | ✅ | `:463-468`（catch 内 `localizeCloudError(e)` 拼入通知，注释注明对齐加载路径） |
| BackupTab 恢复确认 `primary` → `warning` | ✅ | `BackupTab.tsx:1106-1112`（delete=danger / restore=warning / 其余 primary，注释说明分级理由） |
| zh/en 新键 | ✅ | `cloudStorage.json` zh/en `:197`，全量键 diff 为空（zh↔en 无互缺） |
| 两个 vitest 新文件 | ✅ | `r10-ux-cloud-error-mapping.test.tsx`、`r10-ux-backup-restore-confirm.test.tsx` 均在 |

### 1.4 R10-protocol（`58df21ea`）— ✅ 核实到位

- PROTOCOL-R10.md 存在，结论「P0/P1 清零、仍开收敛为 4 件 P2」；本轮抽核其关键证据锚点（`backup_crypto.rs:678-701` 校验子原样采用参数、`derive_key:26-44` 无业务上限、`commands_sync.rs` 四上传入口、`sync_manager.rs:494-562` 标记状态机）全部成立。
- `sync_r10_protocol_locks.rs` 恰好 6 个用例，名称与 PROTOCOL-R10 文末映射表逐一对应（`p2_2_*` 三枚、`p2_3_*`、`p2_1_*`、`r01_p2_filename_*`）。
- FINDINGS-R07 顶部状态表回写存在，正文历史未删。
- CI 三项「未复核」的诚实声明仍然成立——本轮同样无法就地复核（见 §0 验证手段声明）。

### 1.5 R10-android（`50fc09ff`，仅测试 + 文档）— ✅ 核实到位

`src-tauri/tests/sync_r10_android.rs`（426 行，10 用例：content URI 宿主半边 / 物化与重启壳源码锚定 / 租约提交身份对账）存在；用户指南 16 移动端增量（`:153` content:// 临时中转、约两倍空间、自动清理）已落；FIX-QUEUE P2-LOCALE 前端半边回写在案；真机缺口三项如实声明并转 R11-android2。未动生产代码 ✅（该提交只碰 tests + docs）。

### 1.6 R10-download（`9a16b122`）— ✅ 核实到位（但见 §2 P2-2/P2-3 两条衍生发现）

| 声称 | 核实 | 证据 |
|---|---|---|
| FTP `stream_to_file` 字节数校验 | ✅ | `ftp.rs:464-468`（`downloaded != total_size` fail-closed，注释说明 EOF 不可区分） |
| FTP `get_file` stat=None 早退 | ✅ | `ftp.rs:1141-1144`（不再按 `total_size=0` 继续 RETR） |
| S3 `get_file` 字节数校验 | ✅ | `s3.rs:421-426`（含并发替换形态说明） |
| 默认 `get_file` 字节数校验 | ✅ | `traits.rs:295-301` |
| ftp.rs 内嵌三单测 + 集成测新文件 | ✅ | `ftp.rs:1409-1459` 三例；`sync_r10_download.rs` 6 例（半包拒绝 / 一致成功 / 换大版本拒绝等） |
| 指南 16 补一句 | ✅ | `:80` 末句「所有云端下载都会核对实际字节数与声明大小」 |

**核销附注**：该句指南表述对 WebDAV 的非续传 `get_file` 并不成立（无字节数核对，见 §2 P2-3）；且其风险论证引用的调用方 `get_file_decoded` 实为死代码（§2 P2-2）。修复本身正确且有真实受益方（`repo_check` 正以 `expected=None` 调 `get_file`）。

### 1.7 R10-chaos（`96b558bb`，仅新增五测试文件）— ✅ 核实到位（未编译验证）

五文件共 16 用例（clock 4 / idempotent 3 / lease 2 / mixed_e2ee 4 / truncation 3），模块文档明确「与既有覆盖的差异」（如 lease 文件锁 state.json 损坏面、mixed_e2ee 锁「同一加密设备 seq 流中途被塞明文」），非占位测试。与既有测试文件无重名冲突。**未编译运行**（环境缺 webkit），编译通过性留待 CI。

### 1.8 R11-rotate（`93c10018`，只改文档）— ✅ 核实到位

KEY-ROTATION-R11.md 四件套（用户流程 / v3 草案 / 命名元数据评估 / KDF 钳制复审）齐备。抽核锚点：备份对象名生成（`sync_manager.rs:665-687`，时间戳毫秒 + 设备短 ID 6 位 + 随机 8 位）✅；`manifests/<device_id>.json` ✅；「下载/裁剪全经 manifest 按 id 查找、不解析文件名」的兼容根据 ✅（`repo_check` 亦复用同规则白名单，旁证）；**「R10-verifier 未交付、KDF 无上限」复审结论 ✅**（`derive_key:26-44` 与 `check_password_verifier:678-701` 现场核实均无应用级上限，与 PROTOCOL-R10 P2-2 一致）。§6.4 验收标准表可直接作为 R12-kdf-clamp 的测试规格。

### 1.9 R11-check（`437e4123`）— ⚠️ 接线到位，**核心校验有 P1 缺陷**

| 声称 | 核实 | 证据 |
|---|---|---|
| `repo_check.rs` 新文件、只读、诚实性契约 | ✅ 结构成立 | 遍历 manifest（per-device + legacy）、孤儿/tmp 残留、截断降级 Incomplete、manifests 截断抑制孤儿判定（`repo_check.rs:388-450`）、问题明细 500 条截断 |
| 命令注册四件套 | ✅ | `commands_sync.rs:4839-4860`（只加不改、无 Guard、`hydrate_cloud_config`）、`lib.rs:2620-2621`、`cloud_storage/mod.rs`、`permissions/application-commands.toml:209` |
| UI 巡检区 + 指引 | ✅ | `CloudStorageSection.tsx:1694+`（三态徽标、连接成功后可用、上传/下载中禁用）、指南 16 `:90-102`（流量预告、只读声明、不完整不当灾备） |
| locale zh/en `repoCheck.*` | ✅ | 各 32 键，zh↔en 全对齐；`problemKind` 11 键与枚举 camelCase 序列化值一一对应 |
| 集成测 8 例 + 单测 4 例 | ⚠️ 文件在，**至少两例必红** | 见 §2 P1-1：`dsbk_v2_header_roundtrip_is_decodable` 与 `healthy_encrypted_repo_reports_all_green` 按现实现数学上不可能通过 |
| **DSBK 头核查正确性** | ❌ | **v2 头长/偏移错误，加密仓库大面积误报**——本轮唯一 P1，见 §2 |

---

## 2. 新发现（P0 / P1 / P2）

本轮无 P0（新缺陷均不损数据：巡检只读，下载缺口有第二道防线兜底）。

### P1-1 `repo_check` 的 DSBK v2 头解析偏移错误：加密仓库巡检大面积误报「头不可解」，交付测试必红

**事实链**：

1. 真实 DSBK v2 容器头是 **44 字节**：`[DSBK:4][v2:1][m:4][t:4][p:4][salt:16][nonce_prefix:7][chunk:4]`，chunk 字段在偏移 `[40..44)`——`src-tauri/src/crypto/backup_crypto.rs:187`（格式注释）与 `:246-253`（写入顺序，4+1+4+4+4+16+7+4=44）为准；真实 chunk 值为 1 MiB（`:22`）。
2. `src-tauri/src/cloud_storage/repo_check.rs:49` 却声明 `DSBK_V2_HEADER_LEN = 48`（其注释「magic4 + ver1 + params12 + salt16 + nonce_prefix7 + chunk4」自身算术即 44，非 48），并在 `:217` 从 `head[44..48]` 读 chunk——**该区间是首个密文分块的前 4 字节**（AES-GCM 输出，伪随机）。
3. 后果：对任何真实 v2 密文对象，chunk 校验读到随机 4 字节，落在合法区间 `(0, 64 MiB]` 的概率仅 ≈ 64Mi/2³² ≈ **1.56%**，即约 **98.4% 的健康加密对象被误报 `UndecodableDsbkHeader`（「分块大小非法」）**，巡检结论从全绿翻成「发现 N 个问题」。加密仓库恰是该功能最重要的服务对象。另 v2 最小体积判定用 48+16=64（真实 44+16=60），60–63 字节对象会被误报「截断」（次要）。
4. **独立复现实证**（逐字复制 `dsbk_header_error`，按真实布局构造头，`rustc --edition 2021` 编译运行）：

   ```text
   FALSE-POSITIVE: 真实布局 v2 头被误判不可解 → DSBK v2 头分块大小非法: 2880154539
   单元测试输入 head.len()=44，dsbk_header_error 结果 = Some("DSBK v2 头被截断，读不到分块参数")（测试断言 None，实际必 Some → 测试必红）
   ```

5. **交付测试必红，说明交付时未真正运行**：单元测试 `dsbk_v2_header_roundtrip_is_decodable`（`repo_check.rs:641-652`）构造的 44 字节头会被 `head.len() < 48` 分支直接判「被截断」，`assert_eq!(…, None)` 不可能通过；集成测试 `healthy_encrypted_repo_reports_all_green`（`sync_r11_repo_check.rs:226-239`，fixture `fake_dsbk_v2` `:184-197` 同为 44 字节头 + `0xAB` 填充体，`head[44..48]=0xABABABAB` > 64 MiB）同样必红。FIX-QUEUE R11-check 节「好库全绿（明文/加密各一）」的绿灯声明不成立。

**修复建议（R12 认领，文件面 `repo_check.rs` + 其两个测试段）**：`DSBK_V2_HEADER_LEN` 改 44、chunk 改读 `[40..44)`；单测保持现输入（修复后自然转绿）；集成测的加密对象 fixture 建议改用真实 `encrypt_backup_file` 产物（护住布局漂移），并补一例「真实加密上传 → 巡检全绿」的端到端断言。**修复前 UI 面建议**：不必回滚功能（明文仓库巡检与存在性/SHA256/孤儿检测均正确可用），但加密仓库用户会看到大量假阳性——尽快修。

### P2-1 `get_file_decoded` 是全仓零调用的死代码，且语义与真实下载路径相悖

- `data_governance/sync/mod.rs:1016` 定义的 `get_file_decoded` 在 `src-tauri/`（src + tests）中**没有任何调用点**（全仓仅定义处 1 行命中）；文件级对象真实下载路径是 `download_file_object`（`:9543-9620`）。
- 危害不止冗余：两者语义已分叉——`get_file_decoded` 在本端启用加密时**接受明文对象**（`:1003-1011` 注释明示），而 `download_file_object` 对缺 `cipher_sha256` 的明文遗留在启用加密时**拒收**（`:9553-9561`，R04 防降级延伸）。死代码若被后来者当成可用积木接回，会静默重新打开防降级豁免。
- 连带：R10-download 与 FIX-QUEUE 对「无 expected 的 `get_file` 调用方」的风险论证引用的正是这个死函数（`sync_r10_download.rs` 模块文档同引）；修复本身仍然有效（真实的 `expected=None` 调用方是 `repo_check.rs:484`），但台账论据应当更正。
- 建议：直接删除 `get_file_decoded`（或接回并对齐 `download_file_object` 的防降级语义——但目前无任何调用需求，删除更优）。

**状态更新（R12-decoded-dead，已关）**：按「删除更优」路线落地——`get_file_decoded` 连同其唯一消费者 `file_has_dsbk_magic`（全仓仅该函数调用）一并删除，原位置留墓碑注释指向 `download_file_object`；新锁定测 `sync_r12_decoded_dead.rs`（① `src/` 全树无两函数的定义/调用、墓碑注释存活；② `download_file_object` 明文遗留分支的 `encryption_enabled()` 拒收门禁与文案存活——钉死「不再有加密时收明文的旁路」）。连带更正：`sync_r10_download.rs` 模块文档与用例注释中「`expected=None` 调用方」的论据由死函数改为真实调用方 `repo_check.rs`（巡检下载）；FIX-QUEUE R10-download 节同步更正；PROTOCOL-R10 R07-file-e2ee 段的下载侧引用改指 `download_file_object`。

### P2-2 WebDAV 非续传 `get_file` 是四条 provider 下载路径中唯一无字节数核对的

- `webdav.rs:905-995`：流读到结束即成功，`downloaded` 只用于进度回调，从不与 `total_size`（PROPFIND 声明）比对；仅当调用方传 `expected_checksum` 才有第二道防线。对照：同文件续传路径 `get_file_resumable` 有超量拒绝（`:1131-1133`）与 `written != total_size` 拒绝（`:1152-1154`）；S3/FTP/默认实现 R10 起均有核对（§1.6）。
- 实际暴露面收窄但存在：reqwest/hyper 对 Content-Length 不满足的过早断流通常报错（半包多数被传输层拦截），但 R10-download 为 S3 明确覆盖的「对象在 stat 与 GET 之间被并发替换（大小不同的错版本）」形态对 WebDAV 同样成立且不会触发传输层错误。现有 `expected=None` 调用方：`repo_check.rs:484`（巡检自行比对 SHA256，错版本会被归为 `ChecksumMismatch`，不损数据但归因失真——本应是「对象已变更」）。备份下载走 `version.checksum`，文件级对象走 `download_file_object` 双哈希，均有兜底。
- 建议：`webdav.rs::get_file` 补 `downloaded != total_size` fail-closed（与 S3 同文案形态），并在 `webdav_download_resume_tests.rs` 旁补一例非续传半包/换包测。指南 16 `:80`「所有云端下载都会核对字节数」在此之前对 WebDAV 非续传路径是超前表述。
- **状态更新（R10-providers 回写）**：已关闭——`webdav.rs::get_file` EOF 后补 `downloaded != total_size` fail-closed（与 S3 同文案形态，temp 文件随错误清理不落盘），新锁定测 `sync_r10_provider_contract.rs` 4 例（换小包/换大包/截断流拒绝 + 一致对照），指南 16 溯源注释对齐。登记见 FIX-QUEUE「R10-providers」节。

### P2-3（过程项）交付绿灯声明与实际可验证性脱节

- R11-check 声称测试齐备但至少两例必红（P1-1 第 5 点），属「声称绿灯未经运行」——比缺测试更危险，因为它给台账制造了虚假的已验证感。
- 本轮及近几轮（R10-chaos / R10-download / R10-android）所有 Rust 测试都因基线 CI runs cancelled/queued + 本环境不可编译而**从未见过一次完整绿灯**；PROTOCOL-R10 已把 CI 三项列「未复核」，本轮追加：**在下一次完整 CI run 之前，所有「测试 N 例」类交付声明均应视为「已交付未验证」**。建议 R12 第一优先级是把 CI 跑绿一次（含 P1-1 修复），比新增任何功能路都重要。

---

## 3. 仍开项 → 锁定测清单

### 3.1 已有锁定测（文件名与用例，现场核实存在）

| 仍开项 | 锁定测 | 状态 |
|---|---|---|
| P2-2 KDF 参数无上限（R01-P2 / R07-P2-2 同根） | `sync_r10_protocol_locks.rs` 1–3 号（零值 fail-closed / 参数原样采用 / 无钳制源码锁） | ✅ 在案；R12-kdf-clamp 落地时按 KEY-ROTATION-R11 §6.4 七条验收改写 |
| P2-3 resolve 快速路径事务外快照 | 同上 4 号（源码锁 + 两道既有防线） | ✅ 在案 |
| P2-1 升级信任边界（仅文档缓解） | 同上 5 号（指南/FAQ/日志不被删） | ✅ 在案 |
| R01-P2 文件名长度未钳制 | 同上 6 号（幂等 + 长度原样） | ✅ 在案 |
| P2-LOCALE 机制半边（字符串正则映射） | `r10-ux-cloud-error-mapping.test.tsx`（从 Rust 源码提取常量钉死正则契约） | ✅ 在案；错误码落地时连同 `syncE2eeErrorMapping.ts` 迁移 |
| FINDINGS-R07 P1-1（已关）回归 | `r07-cloud-only-delete-conflict.test.tsx` 8 例 | ✅ 已改写为新行为锁定测 |
| `ftp.rs` 合 main 必冲突 | 无（非测试可锁项） | 留档，合 main 时人工消解 |
| CI 红灯三项（Contract / Vitest 4 / Archive） | 即 CI 本身 | 未复核，待完整 run |

### 3.2 缺锁定测的新仍开项（应补断言，供 R12 认领）

| 项 | 建议测试文件 | 应补断言（意图不可少，名字可调） |
|---|---|---|
| P1-1 repo_check v2 头偏移 | `sync_r11_repo_check.rs`（修复时改）+ `repo_check.rs` 单测段 | ① `real_dsbk_v2_object_passes_header_check`：用 `encrypt_backup_file` 真实产物（而非手搓 fixture）跑 `run_repo_check`，加密好库必须 `Ok` 且零 `UndecodableDsbkHeader`；② 现有 44 字节头单测在修复后转绿（不许改断言迁就实现）；③ 60–63 字节 v2 对象不误报截断 |
| P2-1 死代码 | ~~无需新测~~ **已关（R12-decoded-dead）** | 已删除 `get_file_decoded` + `file_has_dsbk_magic`，并加码源码锁定测 `sync_r12_decoded_dead.rs`（不存在锁 + `download_file_object` 防降级门禁存活锁） |
| P2-2 WebDAV 字节核对 | `webdav_download_resume_tests.rs` 同型新文件或同文件新段 | 假 WebDAV 服务器 PROPFIND 声明 N 字节、GET 送 M≠N（M<N 与 M>N 各一）→ 非续传 `get_file`（`expected_checksum=None`）必须 `Err` 且不落盘。**已交付（R10-providers）**：`sync_r10_provider_contract.rs` 4 例，按左述断言落地 |
| P2-3 绿灯声明 | CI | 完整跑一次 `cargo test` + vitest 4 shard；P1-1 修复并入同一 run 验证 |

---

## 4. SOTA-R10 §3 矩阵改判建议

按本轮核销事实，对 [SOTA-R10](./SOTA-R10.md) §3 矩阵逐行给出改判建议（改判由父代理/下轮 sota 路回写，本文不直接改 SOTA-R10）：

| 维度 | R10 判定 | 建议 | 理由 |
|---|---|---|---|
| 多设备冲突 | 已达；P1-1 仍开不改判 | **翻「已达（无保留）」** | P1-1 已由 R10-conflict-ui 关闭且有 8 例锁定测（§1.1），SOTA-R10 §5 预告的「交付后改判」条件已满足 |
| 错密码 | 双路径已达；剩 Argon2 钳制收尾 | 维持，**注记收尾项归属更新** | 钳制仍未交付（R10-verifier 未回传，KEY-ROTATION-R11 §6 独立复审确认）；验收标准已写死，待 R12-kdf-clamp |
| 列表截断 | 已达 | 维持，**可加注** | R10-download 半包 fail-closed（S3/FTP/默认）延伸了「传输诚实」防线；注意 WebDAV 非续传缺口（§2 P2-2）补齐前不宜宣称四家全覆盖 |
| 仓库巡检 | 未达（新列） | **改「部分达」，暂不翻「已达」** | R11-check 已交付 restic `check` 档的完整框架（存在性/SHA256/孤儿/截断诚实/只读契约均正确），**明文仓库可用**；但加密仓库因 P1-1 大面积误报，核心场景不可用。P1-1 修复 + CI 绿后可翻「已达（下载全量档，无 pack 级局部校验）」 |
| E2EE 覆盖 | 已达 | 维持 | 无回退证据 |
| 跨平台文件名 | 部分达 | 维持 | names / names2 均未回传，无变化 |
| 自动同步 | 最小档已达 | 维持 | autosync2 未回传 |
| 换机恢复 | 已达；真机未跑 | 维持，可加注 | R10-android 补 content URI 宿主半边 + 租约身份对账 10 例；真机核对单仍待 R11-android2 |
| 增量/去重 | 未达 | 维持 | delta 未回传 |
| 时点恢复 | 未达 | 维持 | history 未回传 |

---

## 5. 去向建议（进 FIX-QUEUE / R12）

按优先级：

1. **R12-repocheck-fix（P1-1）**：`repo_check.rs` v2 头对齐（44 / chunk@[40..44) / 最小体积 60）+ 集成测改真实密文 fixture + §3.2 三断言。文件面：`repo_check.rs`、`sync_r11_repo_check.rs`。小改动，先行单独合入。
2. **CI 绿灯一次（P2-3）**：包含 1 的修复，一次完整 `cargo test` + vitest 四 shard，把 PROTOCOL-R10 与本文的「未复核/未验证」批量销账。
3. **R12-kdf-clamp（P2-2 老项）**：按 KEY-ROTATION-R11 §6.3/6.4 落地，改写 `sync_r10_protocol_locks.rs` 1–3 号。
4. **webdav `get_file` 字节核对（本轮 P2-2）**：可并入任一 provider 面代理；改前在 FIX-QUEUE 登记 `webdav.rs`。
5. ~~**删除 `get_file_decoded`（本轮 P2-1）**：一行级清理，可搭车任何 sync 面代理；FIX-QUEUE 台账中 R10-download 的论据引用同步更正。~~ **已关（R12-decoded-dead），见 §2 P2-1 状态更新。**
