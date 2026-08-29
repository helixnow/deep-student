# FINDINGS-R07 — R06 合入独立复审结论

> **R10-protocol 状态表回写（基线 `f96a09a9`，逐条证据见 [PROTOCOL-R10](./PROTOCOL-R10.md)；下方正文为 R07 复审历史留档，不删改）**
>
> | 条目 | 状态 | 关闭方 / 备注 |
> |---|---|---|
> | P0-1 文件级明文上传 | **已关** | r07-file-e2ee；验收 a/b/c 三要点全过（含「部分覆盖」文案回收） |
> | P1-1 冲突面板 cloud-only「保留本地」不可达 | **已关** | R10-conflict-ui；单条/批量可达 + 两击确认 + 锁定测改写 |
> | P1-2 记录级 bool 策略入口 | **已关** | r07-record-verifier；四入口写前拦截，附带缺口（首建 v2 标记）同关 |
> | P2-1 升级信任第一台带密码设备 | **部分** | 代码信任边界未变；R09-restore-ops 运维解锁指南为唯一缓解，`sync_r10_protocol_locks.rs` 钉住指南不失效 |
> | P2-2 校验子 KDF 参数无上限 | **已关** | R10-verifier：`derive_key` 应用级上限（1 GiB / t≤16 / p≤8），校验子与 DSBK 头共用同一入口，超限派生前 fail-closed；另补本机「目录曾加密」记忆防删标记后明文上传。验收测 `sync_r10_verifier.rs`；锁定测 3 号已改写为断言边界 |
> | P2-3 resolve 快速路径事务外快照读 | **仍开** | 事务内仅重验 generation；`sync_r10_protocol_locks.rs` 源码锁定，建议并入 R11 sync 面 |
> | P2-4 keep_cloud 多候选 | **已关（豁免）** | UI 披露「最新/N」，按 R07 原判「不修亦可」结案 |
> | 开放项：autosync / 资产文件名 / Android | **已关** | r07-autosync / R09-names（长度残余另跟踪）/ R09-android |
> | 开放项：CI 红灯三项 | **未复核** | 修复已合入；基线最近 runs 均 cancelled/queued，待完整 CI run 确认 |
> | 开放项：`ftp.rs` 合 main 必冲突 | **仍开（留档）** | 非本枝可修，持续留档 |

- 复审代理：R07-review（`claude-fable-5-thinking-high`，xhigh 不可用明示降级，非静默）
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `871528a3`
- 方式：只读代码复审 + git 历史对照；未运行 CI（CI 红灯由 R07-contract / R07-vitest / R07-archive 在途处理，本文不重复展开）
- 范围：ROUND-06 声称已合入的九路 + FINDINGS-R05 复审残留的真实闭环情况

## 结论摘要

R06 已合入部分**基本属实、质量合格**：单侧 DELETE 冲突后端可解（`b31ee744`）、加密标记校验子（`7e090429`）、E2EE 诚实披露（`a2571b65` 等）、Android FTP SSOT、WebDAV 探活 fail-closed、加密 ZIP 续传均经逐行核实成立（见文末「已核实闭环」）。

但闭环有两处**没有真正到手**：

1. `b31ee744` 只修了后端命令，冲突面板 UI 的「保留本地」按钮对单侧冲突仍然禁用——修复的主目标场景在界面上不可达（P1-1）。
2. `7e090429` 只护住 ZIP `backups/` 路径，记录级上传仍走不校验密码的 bool 策略入口——「错密码不得污染同一 root」只关了一半门（P1-2）。

文件级明文上传（P0-1）是已知未交付项（R07-asset-e2ee 在途），本文按复审职责留档并给出验收要点。

> **父代理回写（基线之后）**：复审基于 `871528a3`。随后已合入 `r07-file-e2ee`（P0-1 文件级 DSBK）与 `r07-record-verifier`（P1-2 记录级上传走带密码校验子入口）。P1-1（`RecordConflictsPanel` 对 cloud-only 组禁用「保留本地」）已由 R10-conflict-ui 关闭，见下方 P1-1 条目回写。`r07-autosync` 已合入默认关调度，R07-tests 里的 autosync `todo`/`ignore` 占位可能过时。

---

## P0

### P0-1 文件级对象仍无条件明文上传，直接违反同 root 禁明文/密文混布不变量

- **文件**：`src-tauri/src/data_governance/sync/mod.rs`
  - `sync_vfs_blobs_with_progress_excluding`（~L9919 `storage.put_file`）
  - `sync_asset_directories_with_progress_excluding`（~L10246 `storage.put_file`）
  - workspace db 上传（~L9552 `storage.put_file`）
  - 调用方 `src-tauri/src/data_governance/commands_sync.rs` ~L846-948（三段全部无加密门禁）
- **现状**：记录级变更包/清单/tombstone 走 DSBK 加密（`encode_payload`），但同一次同步里 workspace `.db`、VFS blob 原文、资产文件以明文 `put_file` 到同一 root。`.encryption-marker` 存在时 `ensure_plaintext_upload_allowed` 会拒绝明文 ZIP 与明文记录级上传，却拦不住这三条文件级路径——「禁明文/密文混布」不变量被自己的同步流程系统性打破。
- **复现**：配置加密密码 → 启用附件/工作区同步 → 执行记录级同步 → 云端 `blobs/`、`assets/`、`workspaces/` 下对象为原文（仅传输层加密）。
- **缓解**：UI 与用户指南已诚实披露「部分覆盖」（`a2571b65`），密码遗失不致误导，但机密性缺口本身未关。
- **修复代理**：R07-asset-e2ee（在途，`bc-5808704e`）。**验收要点**：a) 有 `.encryption-marker` / 已配密码时文件级对象必须加密包装或明确拒传+诚实文案；b) 不得破坏 content-addressed blob hash（包装层与明文 hash 可分离，见 ROUND-07 遗留提醒）；c) 交付后同步回收 `cloudStorage.json` 的「部分覆盖」文案。

## P1

### P1-1 单侧冲突后端可解，但冲突面板「保留本地」按钮仍不可达（`b31ee744` 未端到端闭环）

- **文件**：`src/features/settings/components/data-governance/RecordConflictsPanel.tsx`
  - 单条按钮：L382 `disabled={isResolving || isEditing || !latestLocal}`
  - 批量：L198-200 `handleBulkResolve('keep_local')` 过滤 `pair.locals.length > 0`
- **现状**：LWW 门败方 DELETE（`sync/mod.rs` ~L7664）与 UPSERT SkipStale（~L7818）都只落 `side='cloud'` 单行，没有 local 行。后端 `data_governance_resolve_record_conflict` 已放宽（缺 local 侧回退当前业务表行，`commands_sync.rs` L4448-4462），但该文件自 R02 后未再更新：单侧组的 `latestLocal` 为 undefined → 「保留本地」灰、批量 keep_local 跳过。用户界面上只剩「采用云端」（= 执行删除/覆盖本地胜方行！）或手动合并（合并基底恰是 cloud 的 `null`）。修复的主目标场景「驳回过期删除、保留本地胜方」不可达，冲突徽章事实上仍需以危险操作或曲折操作才能清除。
- **复现**：慢钟设备发 DELETE 输掉 LWW → 冲突面板出现 cloud-only 组 → 「保留本地」按钮禁用；批量「全部保留本地」跳过该组。
- **建议修复**：单侧 cloud-only 组放开 keep_local（语义=驳回云端败方，后端已支持并有测试钉住）；批量过滤同步放开；补 vitest 断言单侧组按钮可用。落点纯前端 + `tests/vitest/data-governance/`，与 R07 在途各代理文件面不冲突，建议下一空档新派（如 R08-conflict-ui）或并入 R07-vitest 的 data-governance 文件面（需先在 FIX-QUEUE 登记）。

> **R10-conflict-ui 回写（已关）**：分支 `cursor/cloud-sync-sota-r10-conflict-ui-b343` 已放开 `RecordConflictsPanel` 的单条与批量「保留本地」——单条按钮不再因缺 local 快照禁用（cloud-only 组点击先走 `unifiedConfirm` 两击确认，语义 = 驳回云端败方 DELETE/覆盖、保留本地胜方），批量 keep_local 不再按 `locals.length > 0` 过滤；local 侧「无」补人话空状态说明；文案 zh/en 落 `data.json`（`governance.conflict_cloud_only_hint` / `conflict_keep_local_cloud_only_confirm`）；`r07-cloud-only-delete-conflict.test.tsx` 已改写为锁定新行为（可点、确认拒绝不执行、expectedConflictIds 正确、批量包含 cloud-only 组）。

### P1-2 记录级上传仍走 bool 策略入口，错密码设备可向同一 root 写入无法互解的记录级密文（`7e090429` 半闭环）

- **文件**：`src-tauri/src/data_governance/commands_sync.rs` L53-78（`enforce_record_upload_encryption_policy*`）→ `sync_manager.rs` `enforce_encryption_policy_before_upload(bool)`
- **现状**：ZIP 路径已改带密码校验的入口（`cloud_storage/mod.rs` L271-273，写任何 `backups/` 对象前 fail-fast）。但记录级上传前的策略检查仍是 bool 版——只判「标记存在与否」，不校验密码，而调用方明明拿得到 `config.encryption_password`（同文件 L35-41 就在读它）。配错密码的设备照常把用错密钥加密的 DSBK 变更包/清单/tombstone 上传到同一 root；其他设备 `decode_payload`（`sync/mod.rs` L799-815）解密失败直接报「密码错误或数据损坏」，全网记录级同步中断，且错误无法区分是哪台设备污染、也不能自动恢复。R06 目标「错密码不得污染同一 root」只对 `backups/` 成立。
- **附带缺口**：fresh root 上记录级先行时 `persist_encryption_marker` 登记的是 v1 无校验子标记，校验子保护要等到之后某次 ZIP 上传才被动升级。
- **复现**：设备 A 用密码 X 建立同步 → 设备 B 配密码 Y（标记已有校验子也拦不住，因为记录级路径根本不查）→ B 上传成功 → A 下轮同步解密失败挂起。
- **建议修复**：`enforce_record_upload_encryption_policy_for_config` 改传 `config.encryption_password` 走 `enforce_encryption_policy_before_upload_with_password`；记录级首建标记时带校验子。落点 `commands_sync.rs` 头部 + `sync_manager.rs`（后者 R07 无人独占，需在 FIX-QUEUE 登记）；建议新派 R08-record-verify 或并入 R07-asset-e2ee 收尾（同为加密面）。

## P2

### P2-1 旧标记一次性升级无条件信任「第一个带密码上传的设备」

- **文件**：`sync_manager.rs` `verify_encryption_password_before_upload` L539-554
- v1 无校验子标记由第一台带密码上传的设备升级为 v2。若该设备恰好配错密码（与既有密文不一致），升级后**正确密码**设备反而被永久拦截，需人工删标记。注释已声明该信任边界与旧行为一致，属自觉权衡；建议升级时向 UI/事件流暴露「标记已升级 + 升级设备」以便事后追责，或升级前先用该密码试解一个既有 `backups/` 对象。

### P2-2 校验子 KDF 参数来自不受信任云端，未做上限钳制

- **文件**：`crypto/backup_crypto.rs` `check_password_verifier` L489-512
- 复算摘要直接采用标记里的 `m_cost/t_cost/p_cost`。被控云端可写入超大 `m_cost`（GiB 级）使客户端在上传前校验时 OOM/长时间挂起（DoS，不涉机密性）。建议对三参数设硬上限（如 m_cost ≤ 1 GiB、t_cost ≤ 16、p_cost ≤ 8），超限按「无法校验」fail-closed。
- **回写（R10-verifier，已关）**：按上述建议值落地——`derive_key` 第一步执行 `ensure_kdf_params_within_app_limits`（`KDF_MAX_M_COST_KIB = 1 GiB`、`KDF_MAX_T_COST = 16`、`KDF_MAX_P_COST = 8`），校验子复算、DSBK v1/v2 解密头、`FileCipherSession` 全部经由该入口，超限在派生开始前 `Err`（用户级文案，不含内部参数值）；默认写入面（64 MiB/3/4）与历史合法参数（128 MiB 等）不受影响。验收测试 `src-tauri/tests/sync_r10_verifier.rs`；`sync_r10_protocol_locks.rs` 3 号用例已按其自述改写为断言钳制边界。

### P2-3 resolve 快速路径的业务行快照读在事务外

- **文件**：`commands_sync.rs` L4445-4447（读快照）vs L4540（`BEGIN IMMEDIATE`）
- `already_in_desired_state` 用事务外读到的 `current_local_snapshot` 判定，事务内只重验冲突 generation；纯本地编辑不触碰 `__sync_conflicts`，窗口内可按旧快照误标 resolved（决策未广播、业务行无损，仅冲突留痕口径失真）。慢速路径已有事务内 preflight 重验（L4636-4649）可对照，建议快速路径把业务行重读一并搬进事务。

### P2-4 多 cloud 候选组 keep_cloud 只应用最新一条但全组标记 resolved

- **文件**：`commands_sync.rs` `get_side_data`（`ORDER BY id DESC LIMIT 1`）+ 全组 `UPDATE`
- UI 按钮已披露「采用云端(最新/N)」，被弃候选仍留在已解决记录里可查，风险可接受。可选改进：resolution 字段记录被弃候选 id。不修亦可。

## 已核实闭环（证据）

| 项 | 证据 |
|---|---|
| `b31ee744` 后端逻辑 | 缺 local 侧回退当前业务表行（L4455-4462）；决策与现状一致时事务内重验 generation 后仅标记（L4530-4594）；keep_cloud 采纳 DELETE 走 `apply_single_change_force`（skip_lww=true，L7543-7550），不会被 LWW 门二次拦截；测试 `sync_r06_delete_resolve_tests.rs` 两用例均无 `#[ignore]` |
| `7e090429` 旧标记兼容 | v1 无校验子标记可读且一次性原位升级、保留首写者与时间（L539-554）；损坏 / 未知 KDF / v2 缺校验子全部 fail-closed（L511-517、L530-533、L556-560）；`backup_crypto.rs` 4 个单测 + `sync_manager.rs` 幂等/升级测试 |
| `7e090429` 错密码 fail-fast | `cloud_sync_upload` 在创建加密临时文件与任何 `backups/` 写入**之前**调用带密码策略入口（`cloud_storage/mod.rs` L271-273）；校验子为 Argon2id + 域分隔 SHA-256 + 随机 salt，不可逆、不可推备份密钥 |
| E2EE 诚实披露 | `cloudStorage.json`（zh/en）「已配置端到端加密（部分覆盖）」+ description 明列文件级对象明文；用户指南 16 已回写（`b7d96a16` + `a2571b65`）；停用加密确认文案已纠正（`08f74125`） |
| Android FTP SSOT | `cloud_config_commands.rs` L286-291 保存/加载双拒 + `CloudConfigSsotError::ftp_unsupported_on_platform`；android cfg 门测试两枚（L616-637）；前端错误已 i18n（R05） |
| WebDAV 探活 | `check_connection`：MKCOL 确定性失败被记录，PROPFIND 404 + MKCOL 失败 → 报错不误报成功；PROPFIND 不可用回退 GET 同判定（`webdav.rs` L699-740）；4 个回归测试（L1399-1469） |
| 加密 ZIP 续传 | 密码前置检查在改动目标目录之前（`zip_export.rs` L1721-1734）；解封中断清理明文半成品（L1460-1488）；密码不入检查点（`commands_zip.rs` L1961） |

## 已知开放项（非本轮新发现，均已在 ROUND-07 派发）

- 文件级 E2EE（= P0-1，R07-asset-e2ee）
- 自动同步完全缺失（代码中无任何触发器，R07-autosync）
- 跨平台资产文件名（R07-asset-names 待补派）
- Android 换机/重启语义测试（R07-android）
- CI 红灯：Provider Contract Gate / Vitest shard 4 / Rust Tests Build Archive exit 143（R07-contract / R07-vitest / R07-archive）
- 并行枝 `fix-sync-tombstone-db14` 合 main 时 `ftp.rs` 必冲突（持续留档）

## 对 R08 的分派建议

1. **R08-conflict-ui**（P1-1，纯前端 + vitest，小步）
2. **R08-record-verify**（P1-2，`commands_sync.rs` 策略入口 + `sync_manager.rs` 标记登记，小步；若 R07-asset-e2ee 交付涉及同文件面则合并进去）
3. P2-1/P2-2 可捆绑为 **R08-verifier-hardening**（KDF 参数钳制 + 升级事件披露）
4. P2-3/P2-4 择机并入任一 sync 面代理，不单独派
