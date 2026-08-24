# RESTORE-MATRIX-R07 — 跨版本恢复闭环只读复审

- 代理：R07-restore（只读，未改任何业务代码）
- 模型：claude-fable-5-thinking-high（期望 xhigh 不可用/无法自证，明示降级，非静默）
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `871528a3`
- 复审面：`data_governance/backup/zip_export.rs`、`data_governance/backup/mod.rs`、
  `data_governance/commands_zip.rs`、`data_governance/commands_restore.rs`、
  `crypto/backup_crypto.rs`、`cloud_storage/sync_manager.rs`、`cloud_storage/mod.rs`、
  `data_space.rs`、`secure_store.rs`、`commands_sync.rs`（仅上传策略入口）
- 方法：静态通读 + 与既有单测断言相互印证；未运行测试（只读约束）。
- 避开面：notes / chat / workbench 一律未触碰。

## 恢复闭环主链（作为矩阵的"期望"基准）

1. **包体产生**：本地全量/分层备份（`BackupManager::backup_with_assets` / `backup_tiered`）产出
   manifest v3 + coverage ledger；ZIP 导出分两种——未加密便携（剥密钥/审计，`key_policy=excluded_portable`
   + `PartialOverlay`）与加密全保真（敏感数据 + 原始清单密封进 `portable_secrets.dsbk`，外层清单
   `key_policy=included_encrypted`，`zip_export.rs:47,177-276`）。
2. **云端往返**：`cloud_sync_upload` 可选把整个 ZIP 再套一层 DSBK v2 分块容器
   （`cloud_storage/mod.rs:278-296`），上传前先过 `.encryption-marker` 密码校验子门禁
   （`sync_manager.rs:494-562`）；`cloud_sync_download` 识别 DSBK 魔数流式解密回 ZIP
   （`cloud_storage/mod.rs:432-483`）。
3. **导入**：`data_governance_import_zip` 解压到 `backups/<id>`，解封密封载荷、按原始清单
   verify_internal + checksums 全量校验，并诚实分类 restorable / partial_archive
   （`commands_zip.rs:1829-1839`，`zip_export.rs:1396-1512,278-437`）。
4. **整槽恢复**：`data_governance_restore_backup` 过 `check_manifest_compatibility` +
   `validate_for_slot_restore` + `verify_with_assets` 三重门禁后写入**非活跃槽**（先清槽），
   随后在候选槽内完成 schema 迁移（`initialize_with_report`）、同步基线重建
   （清 `__change_log`、提升 `sync_version`、清冲突，`commands_restore.rs:991-1064`）、
   写激活标记、登记恢复维护租约（`data_space.rs:1804-1843`），`requires_restart=true`。
5. **切槽激活**：重启时 `initialize_on_start` 应用 pending 并校验租约目标已激活
   （`data_space.rs:1585-1628`）；`finalize_restore_activation` 轮换设备 ID、写
   `record_device_rotation` 重置同步游标，随后两段式解除租约（committed → complete，
   `commands_restore.rs:79-149`，`data_space.rs:1850-1899`）。

## 恢复矩阵

| # | 场景 | 期望 | 实际 | 缺口 |
|---|---|---|---|---|
| 1 | 明文 ZIP（未加密便携）导入→恢复 | 只能作为部分归档检查/导出，绝不能整槽恢复；包内不得携带密钥/审计材料；对明文包提供密码应明确报错 | ✅ 符合。导出即剥离敏感域并 `mark_partial`（`zip_export.rs:78-154`）；导入侧 `validate_import_archive` 直接拒绝含密钥/审计路径的明文包（`zip_export.rs:1220-1225`）；明文包带密码报"无需提供备份密码"（`zip_export.rs:1417-1424`）；恢复门禁 `validate_for_slot_restore` 以 `snapshot_kind != Full` 拒绝（`mod.rs:1077-1082`），导入完成消息诚实标注"部分归档，不能整槽恢复" | 无 |
| 2 | 加密全保真 ZIP + 错密码 | 解封前不落任何敏感明文；错密码明确报错；不残留半成品 | ✅ 符合。密封载荷先解密到临时文件（AEAD tag 校验失败即报"备份密码错误或载荷损坏"，`zip_export.rs:1441-1452`）；解封中断清理已落盘明文半成品（`zip_export.rs:1460-1488`）；非续传导入失败后整目录清理（`commands_zip.rs:1915-1923`）；外层清单 `included_encrypted` 未解封时恢复门禁给出可操作指引（`mod.rs:1071-1076`） | 无（见 P3-1 的体验项） |
| 3 | 加密 ZIP 断点续传、未带密码 | 在改动目标目录前明确失败，半成品保持可续传；密码绝不持久化 | ✅ 符合。resumable 路径在解压前预检 `portable_secrets.dsbk` 存在且密码缺失即失败（`zip_export.rs:1721-1734`）；失败不清理目标目录（续传起点，`commands_zip.rs:1939-1940`）；`BackupJobParams` 不含密码、检查点不落密码（`commands_zip.rs:1961-1966`）；续传跳过仅按大小匹配的非 .db 文件，由终验 checksums + verify_internal 兜底 | 无（云端**下载**本身无续传，见 P2-2） |
| 4 | 分层备份缺 assets tier → 恢复 | 覆盖账本必须诚实记 Excluded，包体降级为部分归档，整槽恢复被拒；全量包缺派生索引则本机重建 | ✅ 符合。tiered 未选资产根记 `CoverageStatus::Excluded`（`mod.rs:5747-5753`），`mark_full` 因 require_full 拒绝 Excluded/Failed 而失败 → `mark_partial`（`mod.rs:960-977,5833-5835`）→ 场景 1 同路径被拒；恢复命令显式拒绝 `restore_assets=false`（`commands_restore.rs:456-459`）；全量包 Lance 组件不完整时 `prepare/finalize_vfs_index_restore` 双向清除陈旧索引并重置账本等待重建（`mod.rs:2478-2510,2248-2467`，有回归测试锚定） | 无 |
| 5 | 旧 `.encryption-marker`（v1 无校验子） | 旧标记必须继续可读；明文上传照旧拦截；带密码首传做一次性升级；损坏/异常标记 fail-closed；恢复（下载+解密）不受标记影响 | ✅ 基本符合。v1 标记可读（`key_verifier: Option` + serde default）；明文上传只看"对象是否存在"，内容损坏按存在处理（`sync_manager.rs:441-456,565-574`）；`verify_encryption_password_before_upload`：v≤1 一次性升级为 v2 并保留首写者；v≥2 缺校验子或内容损坏 fail-closed（`sync_manager.rs:494-562`）；下载侧不查标记，错密码由 DSBK AEAD 拒绝 | ⚠ P1-1：记录级同步入口仍走无密码 bool 版策略，新 root 会继续铸造 v1 无校验子标记，且配错密码设备在该路径不被拦截；⚠ P2-1：一次性升级信任"第一个带密码上传的设备" |
| 6 | 跨 schema（旧备份→新应用 / 新备份→旧应用 / 未知库） | 旧→新：先恢复进候选槽再迁移，迁移失败不切槽；新→旧、未知库、未来 manifest 主版本一律 fail-close | ✅ 符合。manifest 主版本仅接受 1..=3（`mod.rs:75,361-383`）；schema 版本高于本机已知上限拒绝、schema_versions/files 中未知数据库拒绝（`mod.rs:4529-4613`）；v1/v2 旧清单只降级为 LegacyCandidate，槽恢复被拒且不能静默升级（`mod.rs:385-400`，多条单测锚定）；旧 schema 在候选槽内 `initialize_with_report` 迁移+验证通过后才登记切槽（`commands_restore.rs:981-989`）；启动时租约目标未激活直接拒启（`data_space.rs:1612-1622`） | 无 |
| 7 | Android 仅 WebDAV | 不可用的 provider 必须显式拒绝（不能静默失败）；换机恢复链在 WebDAV 上完整可走 | ✅ 基本符合。`android-release` feature 不含 `cloud_storage_s3`（`Cargo.toml:378-385`）→ S3 在 `create_storage` 返回明确配置错误；FTP 为编译期 `cfg(not(android))`，Android 侧 `create_storage` 与 `config.validate` 都用同一可映射常量拒绝（`cloud_storage/mod.rs:112-125`，`config.rs:283-286`）；WebDAV 全平台可用；`content://` 虚拟 URI 先物化再导入（`commands_zip.rs:1581-1604`） | ⚠ P3-2：S3 错误文案面向编译者（"请在编译时启用 cloud_storage_s3 feature"），终端用户不可操作 |

### 交叉验证：跨设备密钥材料（场景 2/6 的隐含前提）

加密全保真 ZIP 解封后 `crypto/` 域按原始清单整槽恢复；但 `.key_seed` 若为 Windows DPAPI
封装或平台密钥库引用（`KEYSTORE1:`），`validate_backup_seed_file` 在目标机上 fail-closed
（`secure_store.rs:935-1042`），`verify_crypto_material` 还会在沙箱内实际解密每个 `.enc`
凭据后才放行（`mod.rs:3388-3506`）。即：跨机器恢复"绑定原机"的密钥会**先于覆盖目标**明确失败，
不会出现恢复成功但凭据全部不可解的静默坏态。已有 5 条单测锚定该边界（`mod.rs:6878-7030`）。

## 缺口清单

### P1-1 记录级同步策略入口未传密码，仍在铸造无校验子标记

`enforce_record_upload_encryption_policy_for_config`（`commands_sync.rs:65-78`）手里有完整
`CloudStorageConfig`（含 `encryption_password`），却只把 bool 传给
`enforce_encryption_policy_before_upload` → 新 root 由记录级同步首传时经
`persist_encryption_marker` 写出 **v1 无校验子**标记（`sync_manager.rs:471-483`）；且配错密码的
设备在记录级路径不会被上传前拦截（R06 校验子目标只覆盖了 ZIP 路径）。建议：该入口改走
`enforce_encryption_policy_before_upload_with_password`。与 R07-asset-e2ee 的文件级明文上传
缺口同域，建议合并登记 FIX-QUEUE，本代理不改代码。

> **父代理回写（基线之后）**：本复审基于 `871528a3`。随后合入的 `r07-record-verifier` 已让记录级四个上传入口走 `enforce_encryption_policy_before_upload_with_password`；文件级对象亦已由 `r07-file-e2ee` 加密。P1-1 视为关闭，勿再按旧入口派修。

### P2-1 旧标记一次性升级的信任边界

v≤1 标记的升级信任"第一个带密码上传的设备"（`sync_manager.rs:536-554`，注释已声明与旧行为
信任边界一致）。若配错密码的设备先到，会用错密码铸造校验子，把持有正确密码的原设备锁在
上传之外（恢复不受影响：下载+解密仍由 AEAD 判定）。可接受的文档化取舍，但恢复运维手册应
写明解锁方法（人工删除/重写云端标记）。

> **R09-e2ee 回写（2026-08-24）**：解锁方法已写入用户指南 16「常见问题」——统一各设备密码后，
> 用网盘客户端删除/重写云端根目录 `.encryption-marker`，再由持正确密码的设备上传一次重新登记
> 校验子；并明确警示删标记不解密数据、须先统一密码否则会被再次错登记。信任边界本身未改
> （复审未发现 P0：错密码抢升只锁上传、不碰数据，且恢复路径仍由 DSBK AEAD fail-closed 判定）。
> 另：`sync_r09_file_e2ee.rs` 已锚定 v1 标记升级保留首写者、错密码/损坏标记 fail-closed 的行为。

### P2-2 云端下载无断点续传

`download_with_progress` 为整文件流式下载 + SHA256 校验（`sync_manager.rs:786-841`），中断后
只能整包重下。ZIP **导入**有续传而**下载**没有，多 GB 包在移动网络上是闭环里最脆的一段。

### P3-1 加密 ZIP 无密码的非续传导入报错偏晚

非续传路径要等外层全部解压完才在 `unseal_encrypted_secrets` 报"请提供备份密码"
（`zip_export.rs:1434-1440`），随后整目录清理——正确但浪费一次全量解压 IO。续传路径已有
解压前预检（`zip_export.rs:1721-1734`），非续传路径可复用同一预检提前失败。

### P3-2 Android 上 S3 的错误文案不可操作

`create_storage` 对未编译 S3 的报错让用户"在编译时启用 feature"（`cloud_storage/mod.rs:108-111`）；
FTP 已有专门的用户级常量文案，S3 建议对齐（如"当前安装包不支持 S3，请使用 WebDAV"）。

## 结论

恢复闭环在七个场景上的门禁完整、fail-close 一致：明文/加密便携包语义分离干净，槽替换
只认 manifest v3 + coverage ledger + Full 快照，跨 schema 双向都拒绝危险方向且迁移先于
切槽，A/B 槽以持久租约 + 两段式解除保证半激活状态不可启动。发现的缺口集中在**上传策略
的记录级入口**（P1-1，会持续产生无校验子标记）与**下载续传缺失**（P2-2），均不在本代理
文件面内，建议父代理登记 FIX-QUEUE 后交由对应写码代理处理。
