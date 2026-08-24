# PROTOCOL-R10 — FINDINGS-R01/03/05/07 与 FIX-QUEUE 逐条核销

- 核销代理：R10-protocol（重派；`claude-fable-5-thinking-high`——用户要求 xhigh，slug 不可用，明示降级，非静默）
- 基线：`cursor/cloud-sync-sota-b343` @ `f96a09a9`（R10 已收 conflict-ui / sota / ux 之后）
- 方式：只读代码调研 + 本文档 + 新锁定测试 `src-tauri/tests/sync_r10_protocol_locks.rs`。**不重做已合入实现**；证据行号均在基线上现场核实（非转抄旧 FINDINGS）。
- CI 声明：基线分支最近的 CI runs 均为 cancelled/queued（被后续推送取代），三项 CI 红灯（Contract Gate / Vitest 4 / Rust Archive）**无法就地复核**，状态按「未复核」留档，不冒充已关。

## 结论摘要

| 台账 | 条目数 | 已关 | 部分 | 仍开 | 未复核 |
|---|---|---|---|---|---|
| FINDINGS-R01 | 9 P0 + 9 P1 + 6 P2 | 9 + 9 + 2 | 3（P2） | 1（P2） | 0 |
| FINDINGS-R03 | 2 P0 + 6 P1 + 2 P2 | 全部 10 | 0 | 0 | 0 |
| FINDINGS-R05 复审残留 | 6 | 4 | 1 | 1（留档项） | 0 |
| FINDINGS-R07 | 1 P0 + 2 P1 + 4 P2 + 6 开放项 | P0-1、P1-1、P1-2、P2-4（豁免）、开放项 4 | P2-1 | P2-2、P2-3、ftp.rs 留档 | CI 三项 |
| FIX-QUEUE 登记 | 2 开放 | 0 | 1 | 1 | 0 |

**仍开高危收敛为 4 件**（均已补锁定测，见文末）：P2-2（KDF 参数无上限）、P2-3（resolve 快速路径事务外快照）、P2-1 残余（升级信任边界，仅文档缓解）、R01-P2 残余（文件名长度未钳制）。全部为 P2 级；**P0/P1 已清零**。

> **R10-verifier 回写（本文档定稿后）**：P2-2 已关——`derive_key` 应用级上限（1 GiB / t≤16 / p≤8），校验子与 DSBK 头共用同一入口，超限派生前 fail-closed；锁定测 3 号已改写为断言边界，验收测见 `sync_r10_verifier.rs`。下文 P2-2 相关行保持历史留档不改。仍开收敛为 3 件（P2-3、P2-1 残余、文件名长度）。

> **wrap-conflict 回写（Round 13）**：P2-3 已关——resolve 快速路径在 `BEGIN IMMEDIATE` 后、标记 resolved 前用 `get_record_data` 事务内重读业务行，按同一套 `(operation, data)` 重算 already-desired，不匹配即 fail-closed 拒绝（「本地记录在冲突确认期间已变化」）；锁定测 4 号已改写为断言该重读存在，行为级验收见 `sync_r12_conflict_fast_path.rs`。下文 P2-3 相关行保持历史留档不改。

---

## FINDINGS-R01 核销（R01 → R02 修复 → R03 复审链）

### P0（9 项，全部已关）

| ID | 状态 | 证据（本轮现场核实） |
|---|---|---|
| P0-ZIP | **已关** | `src-tauri/src/data_governance/backup/zip_export.rs:14-17`（加密全保真 ZIP 密封原始 manifest，`validate_for_slot_restore` 通过后可整槽恢复）、`:313`（恢复路径实调该校验）；密码入口已接线（R04 `P2-UI-PASS`，见 R03 节） |
| P0-MERGE | **已关** | 可交换字段折叠已在生产入口 `apply_downloaded_changes_with_conflict_guard` 生效：`src-tauri/src/data_governance/sync/mod.rs:7276-7279`（守卫路径内折叠）、`:7714-7727`（折叠语义与策略门） |
| P0-DEL | **已关** | DELETE 过 LWW 门；败方 DELETE 落 `side='cloud'` 冲突行——集成测前提断言现场可证：`src-tauri/tests/sync_r07_delete_resolve_lock_tests.rs:84-100`（较旧 DELETE `success_count=0` 且产出单侧冲突行） |
| P0-CLOCK | **已关** | 慢钟不再静默丢：SkipStale 落冲突行 + 坏钟写入进隔离区自动重放 `src-tauri/src/data_governance/sync/mod.rs:5830-5991`（`__sync_quarantine` 建表/入列/重放/清除） |
| P0-CLEAR | **已关** | 清除配置确认（R02-cloud-ui）；R09-ux/R10-ux 两轮复审确认危险操作确认仍接线（FIX-QUEUE R09-ux/R10-ux 节），R10-ux 另补 `r10-ux-backup-restore-confirm.test.tsx` 钉住变体分级 |
| P0-RESOLVE | **已关** | 库级冲突四策略均先弹确认（R10-ux 复审 ✓，FIX-QUEUE R10-ux 节）；确认文案接线自 R02-sync-ui |
| P0-WEBDAV | **已关** | 429/503/423 重试 + PROPFIND 探活（R02-webdav，R03 判关）；R05 再修 MKCOL/404 假成功（`FINDINGS-R05:9`）；R07 补 409 语义 |
| P0-FTP-LIST | **已关** | `list_outcome` 诚实截断（R02-ftp，R03 判关）；R07-contract 又补父目录不存在时 delete 幂等语义（FIX-QUEUE R07 登记） |
| P0-ANDROID-DOC | **已关** | 文档 + UI 禁用卡片（R03 判关）；后端 SSOT 拒绝见 R03 节 P1-ANDROID-FTP-SSOT |

### P1（9 项，全部已关）

R03 已判「R01 P1 已关」，本轮抽核关键三项仍成立：

| 项 | 状态 | 证据 |
|---|---|---|
| E2EE 静默明文降级 | **已关** | 记录级：`src-tauri/src/data_governance/commands_sync.rs:54-78`（带密码校验的策略入口）；文件级：`src-tauri/src/data_governance/sync/mod.rs:929-955`（无密码 + 有标记拒传，读标记失败 fail-closed） |
| device_id 身份漂移 | **已关** | 落 `<app_data_dir>/.device_id`（R02-identity）；R09-android 子进程探针钉住恢复后 rotate（`src-tauri/tests/sync_android_device_switch.rs`，FIX-QUEUE R09 节） |
| 坏时钟 tombstone DoS | **已关** | 单条隔离（r04-tombstone）；隔离区基建现场可证 `sync/mod.rs:5830-5991` |
| 其余六项（整百截断、冲突计数、分层默认、重启预告、半配置测试、截断假绿） | **已关** | R03 判关（`FINDINGS-R03:16`）；其中截断启发式 R05 又收窄为 750/751/1000/1001（`FINDINGS-R05:9`） |

### P2（6 项：2 关、3 部分、1 仍开）

| 项 | 状态 | 证据与残余 |
|---|---|---|
| DSBK 头 / 校验子 Argon2 参数无上限 | **仍开** | `src-tauri/src/crypto/backup_crypto.rs:678-701`（`check_password_verifier` 原样采用标记参数复算）、`:26-44`（`derive_key` 仅 argon2 crate 结构校验，无业务上限）、`:127`/`:355`（解密路径原样采用容器头参数）。与 FINDINGS-R07 P2-2 同根。**已补锁定测**（见文末 1-3 号） |
| `CloudStorageCredentials` 明文 Debug | **已关** | `src-tauri/src/cloud_storage/config.rs:82`/`:121`/`:156`（`[REDACTED]`）+ 测试 `:523`/`:537`/`:718`（r06-debug-redact） |
| S3 100MB PUT × 120s 超时；multipart 残留 | **已关** | `src-tauri/src/cloud_storage/s3.rs:22-34`（分块规划，10000 块硬限）、`:81-89`（阈值下单 PUT 120s / 阈值上 multipart 每块独立计时）、`:195-330`（multipart 实现 + 失败 abort 清理）、`:622-676`（阈值/规划测试） |
| 记录级冲突面板 raw JSON | **部分** | 已有 `tryFormatJson` 格式化、cloud-only 人话空状态（`RecordConflictsPanel.tsx:434-437`）、「采用云端(最新/N)」披露（`:411`）；仍是 JSON 视图而非字段级 diff。UX 改进项，非风险项，不进队列 |
| 进度条 a11y；硬编码中文未 i18n | **部分** | 引擎错误已映射人话 i18n：`classifySyncError`（R09-ux）+ `localizeCloudError` 含 S3 映射（R10-ux）+ `syncE2eeErrorMapping`（R09-e2ee）；**后端错误本体仍中文、无稳定错误码**（= FIX-QUEUE `P2-LOCALE-PLATFORM-MSG` 机制半边，仍开）；a11y 未见专项交付 |
| Windows 超长路径、大小写碰撞 | **部分** | 非法字符/保留设备名/尾点空格/NFD/大小写碰撞已关（R09-names：`src-tauri/src/data_governance/sync/asset_filenames.rs:38-118` + 接线 `sync/mod.rs:10765-11301`）；**路径/段长度未钳制**（`sanitize_segment` 无长度处理），MAX_PATH 超长仍可能无法物化。**已补锁定测**（见文末 6 号） |

---

## FINDINGS-R03 核销（10 项，全部已关）

| ID | 状态 | 证据（本轮现场核实） |
|---|---|---|
| P0-DEL-PARSE | **已关** | `src-tauri/src/data_governance/sync/mod.rs:7871-7885`（`changed_at` 不可解析 fail-closed 转隔离区）+ 回归测 `:14009-14044`；R05 集成测再钉（`FINDINGS-R05:11`） |
| P0-SYNC-E2EE | **已关** | 记录级策略门四入口（见 R07 节 P1-2）；`decode_payload` 拒明文（r04-sync-e2ee）；R07-contract 已把混合明文/密文契约测改写为 fail-closed 语义（FIX-QUEUE R07 登记） |
| P1-QCOUNT | **已关** | `src-tauri/src/data_governance/sync/field_merge.rs:65`/`:169`/`:467-474`（`attempt_count`/`correct_count` 故意退出 MaxValue 合并，`reset_progress` 不回弹，注册表测试钉死） |
| P1-DEL-LOSE | **已关** | 败方 DELETE 落 `side='cloud'` 冲突行；现场证据同 R01 P0-DEL（`sync_r07_delete_resolve_lock_tests.rs:75-100` 前提断言） |
| P1-FOLD-POLICY | **已关** | `src-tauri/src/data_governance/sync/mod.rs:7721-7727`（折叠只在 `KeepLatest` 下进行，Manual/KeepLocal 不自动改写本地行） |
| P1-ANDROID-FTP-SSOT | **已关** | `src-tauri/src/cloud_config_commands.rs:140`/`:330`（SSOT 保存拒 FTP-on-Android）；R09-android 改为能力驱动（`PlatformStorageCapabilities`，`cloud_storage/config.rs:10-22`），行为不变且宿主机可测 |
| P1-E2EE-CLEAR | **已关** | `src-tauri/src/secure_store.rs:2063`（停用加密走显式 API，不再依赖空密码提交）；停用诚实文案 `src/locales/zh-CN/cloudStorage.json:87`/`:93` |
| P1-TOMB-DOS | **已关** | 单条隔离 + 自动重放（`sync/mod.rs:5830-5991`，r04-tombstone） |
| P2-FOLD-NOOP | **已关** | r04-sync-del 交付（FIX-QUEUE Round 04 表）；折叠返回「是否实际折叠」布尔（`sync/mod.rs:7727`），空转不再写库 |
| P2-UI-PASS | **已关** | r04-zip-ui 接线密码入口；R09-restore-ops 再补非续传导入无密码早失败（`zip_export.rs:1514` `precheck_sealed_payload_password`） |

---

## FINDINGS-R05 复审残留核销（6 项）

| 项 | 状态 | 证据 |
|---|---|---|
| 败方 DELETE 只落 cloud 侧、resolve 要求双侧 | **已关** | 后端回退（R06-del-resolve，`commands_sync.rs:4452-4462`）+ 前端可达（R10-conflict-ui，见 R07 节 P1-1） |
| 附件/工作区库明文上传 | **已关** | r07-file-e2ee，见 R07 节 P0-1 |
| 加密标记无密钥校验子 | **已关** | v2 校验子标记 + 错密码写前拦截，见 R07 节 P1-2 |
| 无自动同步；Android 换机/重启未实测 | **已关** | 最小自动同步默认关：`src/stores/syncStatusStore.ts:223-258`（`useAutoSyncStore` 默认 `enabled:false`，调度器读该开关，r07-autosync）；Android：`src-tauri/tests/sync_android_device_switch.rs` / `sync_android_restart.rs`（R09-android） |
| 资产文件名跨平台 | **部分** | 主体已关（R09-names），长度残余仍开——同 R01-P2 末项，锁定测 6 号 |
| `fix-sync-tombstone-db14` 合 main 时 `ftp.rs` 必冲突 | **产品语义已关；ftp.rs 整枝仍勿直接合** | 资产 tombstone 的未过滤清单解析 + 内容寻址对象显式 skip 已由 `cursor/cloud-sync-sota-tombstone-port-b343` 合入本枝（`06e82848`）。**未**带原枝 `ftp.rs`（专属枝 550 白名单更严）。原枝整包合 main 仍会撞 `ftp.rs`，继续留档人工消解 |

---

## FINDINGS-R07 核销

### P0-1 文件级明文上传 → **已关**（r07-file-e2ee，验收三要点全过）

- **a) 加密门禁**：`src-tauri/src/data_governance/sync/mod.rs:929-955`（`ensure_file_upload_encryption_policy`——无密码 + 云端有标记拒传、读标记失败 fail-closed），三条文件级路径全部接线：`:9920`（VFS blob）、`:10351`（资产目录）、`:10804`（workspace db）；有密码时经 `put_file_encoded`（`:966-998`）DSBK v2 流式加密上传。
- **b) 内容寻址不破坏**：对象键与清单 hash 保持**明文内容哈希**（`:957-962` 注释 + `download_file_object` 下载解密后按明文 sha256 回验；原引用的 `get_file_decoded` 系死代码，已按 FINDINGS-R11 P2-1 由 R12-decoded-dead 删除）。
- **c) 「部分覆盖」文案已回收**：`src/locales/zh-CN/cloudStorage.json:84` 现描述为全覆盖（整包 ZIP + 记录级 + 文件级对象）。
- 集成测：`src-tauri/tests/sync_file_level_e2ee.rs`、`sync_r09_file_e2ee.rs`；记录级四上传入口审计见 FIX-QUEUE「R09-e2ee 审计结论」。

### P1-1 冲突面板「保留本地」cloud-only 不可达 → **已关**（R10-conflict-ui，本轮现场复核）

- 单条按钮不再因缺 local 快照禁用：`src/features/settings/components/data-governance/RecordConflictsPanel.tsx:396-401`（`disabled` 不含 `!latestLocal`，cloud-only 时挂 `conflict_cloud_only_hint` title）。
- cloud-only 单条 keep_local 先走两击确认：`:156-163`（`locals.length === 0` 时 `unifiedConfirm`，语义 = 驳回云端败方）。
- 批量 keep_local 纳入 cloud-only 组：`:209-217`（targets 不再按 `locals.length > 0` 过滤，注释明示后端回退语义）。
- 人话空状态：`:434-437`（local 侧「无」+ 说明文案）。
- 锁定测：`tests/vitest/data-governance/r07-cloud-only-delete-conflict.test.tsx` 已改写为锁定新行为（FIX-QUEUE R10-conflict-ui 节）。

### P1-2 记录级上传 bool 策略入口 → **已关**（r07-record-verifier，含附带缺口）

- 策略助手带密码：`src-tauri/src/data_governance/commands_sync.rs:54-78`（`enforce_record_upload_encryption_policy*` → `enforce_encryption_policy_before_upload_with_password`）。
- 四个上传入口全部写前拦截：`:1648`（run_sync）、`:2820-2826`（run_sync_with_progress，失败先 emit）、`:3846`（mark_blob_deleted）、`:3880`（mark_asset_deleted）；入口完备性由 R09-e2ee 审计钉死（FIX-QUEUE「记录级四个上传入口」节）。
- **附带缺口同关**：fresh root 记录级首建即登记 v2 带校验子标记——单测 `:4948-4965`（`record_upload_policy_writes_marker_with_verifier_when_encrypted`）；错密码写前失败 `:5001-5026`。

### P2 四项

| ID | 状态 | 说明 |
|---|---|---|
| P2-1 升级无条件信任第一台带密码设备 | **部分** | 代码信任边界未变：`src-tauri/src/cloud_storage/sync_manager.rs:536-553`（v1 标记以本机密码一次性升级，仅日志留痕）。已交付缓解：R09-restore-ops 运维解锁指南（`docs/user-guide/16-数据管理与云同步.md:109-113` 章节 + `:159-160` FAQ）。未做：升级事件向 UI/事件流暴露、升级前试解既有 `backups/` 对象。**已补锁定测**（5 号，钉住指南与日志不被删） |
| P2-2 校验子 KDF 参数无上限钳制 | **仍开** | `backup_crypto.rs:678-701` 复算原样采用标记参数；argon2 crate 仅拦结构非法（零值等），GiB 级合法 m_cost 仍可 DoS。**已补锁定测**（1-3 号）。建议 R11 落地：m_cost ≤ 1 GiB、t_cost ≤ 16、p_cost ≤ 8，超限 fail-closed，且 DSBK 解密头（`:127`/`:355`）一并钳制 |
| P2-3 resolve 快速路径快照读在事务外 | **仍开** | `commands_sync.rs:4446-4448`（事务外读）→ `:4531-4539`（据此判定）→ `:4541`（`BEGIN IMMEDIATE`，事务内仅重验 generation `:4544-4567`）；慢速路径有事务内 preflight `:4637-4650` 可对照。影响限冲突留痕口径，业务行无损。**已补锁定测**（4 号） |
| P2-4 keep_cloud 多候选只应用最新 | **已关（豁免）** | UI 披露「采用云端(最新/N)」`RecordConflictsPanel.tsx:411`；R07 判「不修亦可」，按可接受风险豁免结案 |

### 已知开放项（R07 文末 6 项）

| 项 | 状态 | 证据 |
|---|---|---|
| 文件级 E2EE（P0-1） | **已关** | 见上 |
| 自动同步缺失 | **已关** | r07-autosync：默认关 + 状态可见（`syncStatusStore.ts:223-258`；R10-ux 复审再确认默认关） |
| 跨平台资产文件名 | **已关（长度残余转 R01-P2 项跟踪）** | R09-names，见 R01 P2 末项 |
| Android 换机/重启测试 | **已关** | R09-android 两个测试文件 + 能力钩子 |
| CI 红灯三项（Contract / Vitest 4 / Archive） | **未复核** | R07-contract/R07-vitest 修复已合入（FIX-QUEUE R07 登记）；基线分支最近 runs 均 cancelled/queued，无法就地取信绿灯，留待下一次完整 CI run 确认 |
| `ftp.rs` 合 main 必冲突 | **仍开（留档）** | 同 R05 节末项 |

---

## FIX-QUEUE 仍开登记项核销

| 项 | 状态 | 说明 |
|---|---|---|
| P2-LOCALE-PLATFORM-MSG | **部分** | 前端半边已关（R10-ux：S3 拒绝映射 `errors.s3DisabledInBuild` + 跨层契约测）；**机制统一半边仍开**——FTP（英文常量）/S3（中文常量）仍靠字符串正则映射，待后端稳定错误码后迁移（含 `syncE2eeErrorMapping.ts`）。R10-ux 的源码契约 vitest 已钉住现行正则契约，本轮不重复补测 |
| `auto.rs` 孤儿文件 | **已消失** | R09 登记的未跟踪孤儿草稿 `data_governance/sync/auto.rs` 在当前基线不存在（工作树干净），无需处理 |

---

## 仍开清单 → 锁定测映射（`src-tauri/tests/sync_r10_protocol_locks.rs`）

| # | 用例 | 钉住什么 |
|---|---|---|
| 1 | `p2_2_structurally_invalid_kdf_params_fail_closed` | 已有防线：零值参数必须 `Err`（fail-closed），不得与 `Ok(false)`（密码不一致）混淆 |
| 2 | `p2_2_marker_kdf_params_are_honored_not_clamped_to_default` | 缺口行为：标记参数被原样采用参与复算（128 MiB 非默认参数真实执行）；钳制落地后该参数仍应低于上限、用例继续通过 |
| 3 | `p2_2_kdf_cost_upper_bound_still_missing_source_lock` | 诚实仍开：`check_password_verifier` 无钳制；一旦有人加钳制，用例失败逼出台账回写（含 DSBK 解密头同根检查） |
| 4 | `p2_3_resolve_fast_path_business_row_recheck_still_missing_source_lock` | 诚实仍开：快速路径事务内仅 generation 重验、无业务行重读；同时钉住 `BEGIN IMMEDIATE` 与 generation 重验两道既有防线不被删 |
| 5 | `p2_1_marker_upgrade_unlock_guide_doc_lock` | 缓解不失效：用户指南解锁章节 + FAQ + 升级日志留痕不被删除/改名 |
| 6 | `r01_p2_filename_length_still_unclamped_lock` | 诚实仍开：超长段幂等但长度未钳制；未来加钳制必须同步处理截断碰撞与云端 key 迁移 |

## 对 R11 的建议（不在本轮做）

1. **R11-verifier-clamp**（P2-2）：`backup_crypto.rs` 校验子 + DSBK 头双处参数上限，超限 fail-closed；更新锁定测 1-3 号为断言边界。
2. **P2-3** 并入任一 sync 面代理：快速路径把业务行重读搬进事务（对照慢速路径 hook），更新锁定测 4 号。
3. **P2-1 收尾**（可与 1 捆绑）：升级事件暴露 UI/事件流，或升级前试解一个既有 `backups/` 对象。
4. **错误码机制**（P2-LOCALE 半边）：后端稳定错误码替代字符串正则，三处映射一并迁移。
5. **文件名长度钳制**（低优先）：需连带设计截断碰撞与云端既有 key 迁移，勿单改 `sanitize_segment`。
