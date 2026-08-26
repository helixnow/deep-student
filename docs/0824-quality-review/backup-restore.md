# 备份 / ZIP 恢复 / E2EE 口令质量评审

对比范围：`v0.9.44` → `origin/cursor/0824-cde6`（`2d41ea8b`）。本报告聚焦本地备份、ZIP 导出/导入、整槽恢复命令链与备份口令（DSBK 容器、校验子、口令 UX）；云端 provider 与 `sync_manager` 主链已由《云同步质量评审》（`cloud-sync.md`）覆盖，本文只在口令语义交叉处引用，不重复展开。全部结论基于静态源码评审与前端契约测试执行；**未执行、也不建议执行任何会清空数据槽的真实恢复操作**，恢复行为的判断依据是源码路径与仓库内既有测试。

## 结论

这块改造的主体是真实的，不是文案工程：**fail-closed 的落点大多选对了，且几乎没有向后兼容代价**。整槽恢复删除了 v0.9.44 会写出半恢复槽的 slotB 回退；ZIP 导入导出获得了一条完整的「加密全保真换机包」链路（密封载荷、解封、原始清单锚定、错密码不碰数据槽）；口令生命周期（最小长度、已存口令 fail-closed、续传口令不落盘）和不可信输入防御（KDF 参数上限、校验子、本机加密记忆）都接进了生产路径并有针对性测试。

但有一个必须修的对外宣称问题，和一个把 fail-closed 做成死路的 UX 问题：

1. **P1：「端到端加密换机包」的宣称超过实现。** 本地导出的"加密"ZIP 外层仍以明文携带全部业务数据库与资产（聊天记录、错题、文件库原始文件），密码只密封密钥材料、审计库和 user_skills。UI 却宣称「端到端加密 ZIP」「密码丢失将无法解密」。
2. **P2：加密导入的断点续传是死路。** 后端正确地要求续传重新提供口令（口令不落检查点），但前端续传按钮不传口令、也没有输入入口，可续传任务实际永远续传失败。

发布口径建议：机制本身可以随版本走；「端到端加密」的措辞在 P1 修复（改文案或改实现）之前不应出现在用户可见文案里。

## 一、相对 v0.9.44 的真实改造

### 1. 整槽恢复的 fail-closed 是纯收益

v0.9.44 在 `DataSpaceManager` 缺失时回退写 `slots/slotB`，把完整数据库写完后才在登记切槽时失败——失败结局相同，但会留下一个无人管理的半恢复槽。现在这个门被提前到磁盘预算、清槽和任何写入之前：

```642:648:src-tauri/src/data_governance/commands_restore.rs
    // 整槽恢复只能由 DataSpaceManager 原子登记 A/B 切换。旧回退路径会先把
    // 完整数据库写进 slotB，最后才因无法登记切槽而失败，留下半恢复槽。
    // 必须在磁盘预算、清槽和任何数据库写入之前 fail-closed。
    let Some(data_space_manager) = crate::data_space::get_data_space_manager() else {
        job_ctx.fail(atomic_restore_unavailable_error());
        return;
    };
```

这是本轮 fail-closed 里质量最高的一处：**旧路径从来不可能成功**（最终必然卡在切槽登记），所以提前拒绝没有挡掉任何原本能完成的恢复，只消除了副作用。错误带稳定码 `ATOMIC_RESTORE_UNAVAILABLE_CODE` 且明确说明「当前数据未改动」（`commands_restore.rs:24-29`）。恢复链其余部分（先验清单/校验和/PRAGMA integrity_check、写非活跃槽、`initialize_with_report` 迁移验证、同步基线重建、维护模式 + 激活标记 + 原子切槽登记）在 v0.9.44 已存在，本轮未动骨架，这个克制是对的。

### 2. 加密全保真 ZIP：设计正确，宣称有问题

v0.9.44 的 ZIP 导出只有一种形态：未加密便携包（剥离密钥材料、`key_policy=excluded_portable`、`mark_partial`，导入后不能整槽恢复）。这意味着 ZIP/云盘换机后 API 凭据必然丢失。0824 新增的密封载荷模式补上了这个闭环：

- 导出时把原始 `manifest.json` + 全部便携排除文件（crypto/ 密钥、audit.db、user_skills）打进内层 ZIP，经 Argon2id + AES-256-GCM 分块加密为 `portable_secrets.dsbk`（`zip_export.rs:186-285`）；外层清单声明 `key_policy=included_encrypted` 并登记载荷的大小与密文 SHA-256。
- 导入时先全量解压外层，再解封载荷、还原原始清单，删除载荷与过期的 `checksums.sha256`，此后由**原始清单**做逐文件 SHA-256 + 完整性校验（`zip_export.rs:1403-1518`）。
- 未解封的外层清单被恢复门明确拒绝，且给出可操作指引而不是笼统报错：

```1077:1084:src-tauri/src/data_governance/backup/mod.rs
        // 加密全保真 ZIP 的外层清单：在 snapshot_kind 检查之前先给出
        // 可操作指引（提供备份密码解封），而不是笼统的"不是完整快照"。
        if self.key_policy == BackupKeyPolicy::IncludedEncrypted {
            return Err(BackupError::Manifest(
                "备份的敏感数据仍处于密码加密封存状态；请在导入 ZIP 时提供备份密码完成解封，再执行整槽恢复"
                    .to_string(),
            ));
        }
```

有两个设计点值得肯定：

- **原始清单在 AEAD 保护之内，间接锚定了整包完整性。** 外层条目虽是明文，但解封后按原始清单逐文件核对 SHA-256——篡改外层数据库会在导入时被检出（前提是用户走带密码的导入）。防篡改是成立的，问题只在保密（见 P1）。
- **错密码不留半成品。** 解封中断会清理已落盘的敏感明文（`zip_export.rs:1466-1494`）；`zip_export_import_restore_tests.rs:449` 的 `encrypted_zip_wrong_password_never_touches_target_slot` 断言错密码后残留清单继续拒绝整槽恢复。另有 `precheck_sealed_payload_password`（`zip_export.rs:1541-1564`）在解压任何条目之前就拦截「密封包缺密码」，避免白费一次全量 IO。

状态与载荷不一致的四象限（声明加密无载荷 / 有载荷未声明 / 便携包给了密码 / 密封包缺密码）全部显式拒绝（`zip_export.rs:1423-1446`），没有静默降级路径。

### 3. 口令生命周期：一致且大多 fail-closed 正确

- **最小长度 8 字符**在三处对齐：`secure_store.rs`（保存云口令时）、`zip_export.rs` 导出层、前端 `BackupTab.tsx:347-360`（按 Unicode 标量计数与后端 `chars().count()` 一致，测试锁定）。
- **已存云口令的复用是 fail-closed 的**：开关打开却读不到口令时拒绝导出，绝不静默打成便携包冒充全保真（`commands_zip.rs:76-114`，稳定码 `E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED`）；接线前遗留的短口令同样拒绝，而不是交给导出层半路失败。导入侧只对带密封载荷的 ZIP 套用已存口令，便携包忽略 stored——避免「无需提供备份密码」把旧包挡在门外（`commands_zip.rs:121-135`），这个不对称处理是对旧产物兼容性的正确取舍。
- **口令从不持久化到任务检查点**，续传必须重新提供（`commands_backup.rs:2311-2331`）。方向正确，但前端没接（见 P2）。
- 云上传链路复用同一口令：`CloudStorageSection.tsx:904-920` 显式口令优先、已配置时让后端读安全存储、不把安全存储口令读进 React state；上传的整个 ZIP 在 `cloud_storage/mod.rs:357` 再被 DSBK 整体加密。**云端对象确实是全加密的**——这也反衬出本地导出 ZIP 的宣称问题（P1）只存在于本地文件形态。
- 前端错误分类器 `syncE2eeErrorMapping.ts` 采用稳定码优先、旧文案正则兜底的两层设计，且测试用 `readFileSync` 直接锁定 Rust 源码中的码字面值与文案片段，防止两端漂移——这是本轮前端契约测试里做得最扎实的一类。

### 4. `backup_crypto.rs` 从 509 行扩到 1268 行，扩的是防御而不是花样

- **KDF 参数应用级上限**（1 GiB / t=16 / p=8）在任何派生开始前检查，所有派生路径（校验子复算、DSBK v1/v2 解密、`FileCipherSession`）共用同一入口 `derive_key`（`backup_crypto.rs:36-58,102-103`）。上限取默认写入面的 16 倍，只防不可信云对象的资源耗尽，不拒收自家任何历史备份——fail-closed 无兼容代价的又一例。
- **密码校验子**做了域分隔（`digest = SHA-256(domain || Argon2id(password, salt))`），摘要不可反推口令或任何 DSBK 密钥；未知 KDF、字段损坏返回 `Err` 而非 `Ok(false)`，强制调用方 fail-closed（`backup_crypto.rs:676-771`）。
- **`FileCipherSession`** 把「每对象一次 Argon2」优化为会话级派生一次 + 解密侧按 (salt, params) 缓存，nonce 安全性论证（v1 96-bit 随机 / v2 56-bit 前缀 + 计数器 + final 标记，会话生命周期一轮同步）写在文档里且数量级成立；Drop 时 zeroize 密钥与口令。
- **本机「曾加密」记忆**（`EncryptedRootMemory`，`backup_crypto.rs:773-883`）：记忆文件损坏按「曾加密」处理、不存在按「无记忆」处理，两个方向的默认值都选了更安全的一侧。

### 5. 诚实标注链是成体系的，且都接到了同一判定源

这轮最讨喜的模式是「能否整槽恢复」全部收敛到 `validate_for_slot_restore` 一个判定源：

- 自动备份的 `recovery_kind` 改为按 **ZIP 内实际清单**（便携改写后）判定，修掉了 v0.9.44 把导入后无法整槽恢复的便携 ZIP 误标 `disaster_recovery` 的问题（`backup_config.rs:534-556`）；
- ZIP 导入完成后用同一门重新分类产物（`commands_zip.rs:2018-2028`）；
- 前端分层备份补了「部分归档不能整槽恢复」与「当前选择不含 vfs_blobs」的显式警告，默认层级改为 core+important+含资产，使默认导出覆盖文件库原始文件；
- 恢复确认框从 `primary` 升为 `warning` 变体（`BackupTab.tsx:1113-1120`），与云端恢复、库级冲突覆盖同级，有 `r10-ux-backup-restore-confirm` 测试锁定。

### 6. 未接线积木的自我约束值得保留

`delta_restore.rs`、`backup_lease.rs`、`delta_inventory.rs` 共约 1500 行是 backup-v2 增量恢复的积木，模块文档第一句就是「本模块未接线」，并由 `sync_r12_delta_restore.rs` 的源码锁强制「不得宣称增量恢复已实现」。积木本身的恢复顺序（租约 → 索引 → descriptor 三层校验 → 临时目录全量物化 → 交叉核对 → 原子改名 → 改名后复核，任何失败清空目标）是对的，但**它不改变本轮的功能事实：生产恢复仍是整 ZIP 单对象路径**，评审其余部分均按此事实展开。

## 二、fail-closed 是否真让升级更安全：逐项判定

| 改造点 | 判定 | 依据 |
| --- | --- | --- |
| 整槽恢复拒绝无 DataSpaceManager | **纯赢** | 旧回退路径必然失败于切槽登记，提前拒绝只消除半恢复槽副作用 |
| KDF 参数上限 | **纯赢** | 自家全部历史写入面（64 MiB/3/4，从未改过）远在上限内 |
| 未解封清单拒整槽恢复 | **纯赢** | 该形态 v0.9.44 不存在，无旧产物受影响 |
| 便携包忽略 stored 口令 | **纯赢** | 专门为旧云端便携包保留导入通道而设计 |
| 短口令拒绝（含接线前遗留的已存口令） | **基本纯赢** | 密封导出自诞生即有 8 字符门，不存在短口令密封产物；唯一代价是遗留短云口令用户需重新配置，错误码可操作 |
| 自动备份分类失败 → 整个自动备份失败 | **过度** | `portable_manifest_bytes` 只服务于标签，其失败被 `map_err` 提升为整个自动备份任务失败（`backup_config.rs:539-544`）。清单坏到生成不了便携清单时备份大概率也有问题，但「标签算不出→备份不产出」的因果强度不匹配，宁可产出并标 `partial_archive` |
| 续传缺口令在改动目标前失败 | **机制对、闭环断** | 见 P2：后端保持目标可续传，前端没有给口令的入口，安全但不可用 |

对 v0.9.44 旧产物的兼容性核对（静态）：旧便携 ZIP（`excluded_portable`）与 Legacy ZIP（`LegacyCandidate + LegacyUnknown`）的导入验证路径逐字保留；DSBK v1 整块容器仍可读；默认 Argon2 参数未变。**没有发现任何一条「v0.9.44 能成功、0824 被 fail-closed 拦下」的旧产物路径**——这轮 fail-closed 的选点纪律确实好。

## 三、问题

### P1：「端到端加密换机包」宣称超过实现，方向与全线诚实标注相反

本地加密导出的外层 ZIP 走与便携包完全相同的打包循环，业务数据库（chat_v2、mistakes、vfs、llm_usage）、workspaces、全部资产（含 vfs_blobs 原始文件）**全部以明文 Deflate 条目进入外层**（`zip_export.rs:1001-1102`）；密码只密封 `is_portable_excluded_relative_path` 命中的集合——crypto/ 密钥、audit.db、user_skills（`backup/mod.rs` 域注册表中仅这几处 `encrypted: true` / 特判）。而 UI 文案：

```923:928:src/locales/zh-CN/data.json
    "export_warning_encrypted": "将使用压缩级别 {{level}} 创建端到端加密 ZIP（使用当前设置的备份密码）。请牢记密码：丢失后无法解密。",
    "e2ee_password_label": "备份密码（端到端加密，可选）",
    "e2ee_password_placeholder": "留空导出未加密便携包",
    "e2ee_password_hint": "设置至少 {{min}} 个字符的密码将导出加密全保真换机包，在新设备导入时输入同一密码即可整槽恢复。密码丢失将无法解密。",
    "e2ee_password_too_short": "备份密码至少需要 {{min}} 个字符（按 Unicode 码点计数，不能为空白）",
    "e2ee_export_note": "已设置备份密码：将导出端到端加密的全保真换机包，在其他设备导入并输入同一密码后可整槽恢复。密码丢失将无法解密。",
```

用户按这段文案的合理预期是：把这个 ZIP 放到网盘/U 盘/邮箱，没有密码的人读不到内容。实际上任何拿到 ZIP 的人无需密码即可解出全部聊天记录、错题和文件库原文；密码保护的只是 API 凭据等密钥材料。「密码丢失将无法解密」也不准确——丢了密码，99% 的数据照样可读，丢的是凭据和整槽恢复资格。

这轮改造在便携包方向反复强调「诚实降级宣称」（不能整槽恢复、凭据需重录），加密包方向却把「密钥密封」放大成「端到端加密」，是同一价值观下的双重标准。注意云上传路径没有此问题：整个 ZIP 会再被 DSBK 包一层（`cloud_storage/mod.rs:357`），云端对象是真全加密。

修复方向二选一：

- **改文案**（成本低）：「备份密码将加密保护 API 凭据等敏感数据；归档内容本身未加密，请勿在不可信渠道传播」；或
- **改实现**（配得上现有文案）：本地导出后把整个 ZIP 再经 `encrypt_backup_file` 包成 `.dsbk`，与云对象同构；导入命令需新增 DSBK 外壳识别（云下载路径已有该解密能力，主要是本地导入命令的接线工作）。

### P2：加密导入的断点续传对用户是死路

后端契约明确且正确：口令不落检查点，`data_governance_resume_backup_job` 新增 `password` 参数，缺失时在改动目标目录前失败、目标保持可续传（`commands_backup.rs:2311-2331`，`zip_export.rs:1553-1559` 的续传文案甚至指引「请提供备份密码后重新恢复导入任务」）。但前端：

```594:600:src/api/dataGovernance.ts
export async function resumeBackupJob(
  jobId: string,
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>("data_governance_resume_backup_job", {
    jobId,
  });
}
```

`DataGovernanceDashboard.tsx:974` 调用时不传口令，`BackupTab` 的「继续」按钮也没有口令输入对话框（导入口令对话框只挂在新导入按钮上）。结果：加密包导入一旦中断，UI 上的续传永远失败，错误信息让用户做一件 UI 做不到的事。fail-closed 变成 fail-dead-end——用户唯一出路是放弃续传目录、重新走一次全量导入。修复很小：续传时检测任务的 ZIP 是否带密封载荷（已有 `zip_contains_encrypted_secrets`），是则弹已有的口令对话框再调用。

### P3 级问题

1. **弱口令与「无法解密」承诺的组合。** 8 字符门只查长度，`12345678` 能过。配合「密码丢失将无法解密」的文案，用户会拿弱口令保护换机包。Argon2id 64 MiB×3 对 8 位纯数字空间（10^8）的离线暴破并非不可行。至少应加常见口令黑名单或简单熵检查；若 P1 选择改文案，此项压力也随之下降。
2. **便携包 + 误输口令在全量解压后才失败。** `precheck_sealed_payload_password` 只拦「密封包缺密码」；反向的「便携包给了密码」要等外层全量解压完、进入解封阶段才报错（`zip_export.rs:1424-1429`），且非续传路径失败后整目录清理。导入口令对话框对所有 ZIP 都弹（可留空），这个误操作路径是真实存在的。前置检查同样只需看条目名，成本为零。
3. **错密码重试 = 每次全量解压。** 大包（策略上限 20 GiB）输错一次密码，代价是一次全量解压 + 整目录清理 + 重来。可以在解压前对 `portable_secrets.dsbk` 的首个分块做试解密（一次 Argon2 + 1 MiB AEAD），把错密码的失败提前到秒级。
4. **KDF 上限对移动端仍偏高。** 1 GiB 上限在桌面上是「拒绝前不吃多少资源」的合理值，但 Android 低端机上一次 1 GiB 的 Argon2 派生尝试可能直接被系统 OOM-kill，攻击者构造 900 MiB 参数的对象即可稳定杀进程。可考虑按平台收紧（移动端 256 MiB 已覆盖 4 倍默认写入面）。
5. **解封后的明文密钥长期留存。** 加密包导入成功后，另一台设备的 crypto/ 密钥、审计库以明文躺在 `backups/<id>/` 下。与本地全量备份的既有边界一致（本地备份本就含明文密钥），不算回归；但「导入后迟迟不恢复」的场景下这份跨设备密钥的留存值得提示或限期清理。
6. **导出实现双份，存在漂移风险。** 未加密导出走 `commands_zip.rs` 手写的逐文件循环（为了细粒度进度），加密导出整体委托 `export_backup_to_zip`（`commands_zip.rs:874-909`）。两者共用 `portable_manifest_bytes` / `preflight_export_source` / `ensure_zip_output_outside_source` 等闸门，但打包循环本体是两份。后续给库导出器加进度回调、删掉手写循环是更稳的形态。

## 四、优化空间

1. **加密导出无进度、不可取消。** 加密分支只在 10% 打一个「正在密封敏感数据并生成加密全保真 ZIP...」（`commands_zip.rs:877-885`）后同步阻塞到结束，`export_backup_to_zip` 不接受取消回调。未加密路径有逐文件进度 + 取消，两条路径体验不对称，大导出会呈现假死。
2. **导入路径的重复哈希。** 解封后 `validate_imported_backup_dir` 里 `verify_internal` 按清单逐文件 SHA-256，随后 `checksums.sha256` 校验环节又对每个文件再算一遍（`zip_export.rs:431`）。20 GiB 包等于至少两遍全量哈希。v0.9.44 已如此，非本轮回归，但既然本轮把加密包解封后主动删除过期 checksums，未加密路径也可以在 verify_internal 覆盖的文件上跳过重复计算。
3. **续传 skip 逻辑的一个理论边界。** 断点续传按「已存在且大小相同」跳过非 .db 文件（`zip_export.rs:1830-1867`）。若上次导入已成功解封（原始 manifest 已覆盖外层 manifest）而后续失败，再次续传时倘若两份 manifest 恰好等长，会跳过重解外层 manifest，随后解封层将以「清单未声明却携带载荷」拒绝——fail-closed 兜住了，但错误信息会让人费解。把 `manifest.json` 与 .db 一样列为不可跳过即可消除该边界。
4. **`EncryptedRootMemory` 持久化失败只告警不阻断**（WRAP-E2EE 自己也点了这一条）。第二道防线允许静默缺席，与它「fail-closed 记忆」的定位不完全一致；至少应在设置页暴露记忆写入失败的状态。

## 五、测试与验证

- **本环境执行**：`syncE2eeErrorMapping.test.ts`（12 用例，含对 Rust 源码字面值的锁定）、`BackupTab.zip-password.test.tsx`（12）、`r10-ux-backup-restore-confirm.test.tsx`（3）——27/27 通过。
- **静态审阅**：`zip_export_import_restore_tests.rs`（725 行：加密/便携往返、错密码不碰槽、无密码可操作报错、stored 口令三态、诚实分类）、`sync_r07_e2ee_wrong_password_tests.rs`（错密码不污染云 root）、`commands_zip.rs` 内嵌的口令解析矩阵（含 Unicode 计数与稳定码断言）。测试选点与本文关注的失败形态高度重合，覆盖质量高于 v0.9.44 的同区域。
- **未执行**：Rust 集成测试（仓库内 WRAP-E2EE 记录了该环境 Rust 1.88 无法编译 `rusqlite 0.40.1` 基线依赖的既有限制）；任何真实的整槽恢复或槽清空操作（有意不做——恢复行为的正确性判断依据源码与上述测试，不以清空真实数据槽为代价验证）。

## 总评

以「fail-closed 是否让升级更安全」为题眼：**是，且这轮的选点纪律少见地好**——几乎每一处 fail-closed 都选在「旧路径本来就不可能成功」或「只拦不可信输入」的位置，对 v0.9.44 产物零兼容代价。真正的短板不在安全机制，而在两端的收尾：对外宣称（P1）把密钥密封说成了端到端加密，对内闭环（P2）把安全的拒绝做成了没有出口的拒绝。这两个都是小改动能修的问题，修完之后这块可以算 0824 改造里质量最高的区域之一。
