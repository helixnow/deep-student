model=claude-fable-5-thinking-xhigh
# Step 19/20 深挖：ZIP 恢复 fail-closed / 无 marker 旧加密口令 / E2EE 防降级

- 审计基座：`cursor/0824-static-audit-cde6` 工作树（产品树与 `2d41ea8b` 一致）。
- 对照：`v0.9.44`（本地 tag，只读 `git show`/`git diff` 取证，未做任何 git 写操作）。
- 审计对象：Step 19 restore 三提交（`1df0ec6a`、`6cfabf67`、`d7fb7677`，另含
  `1119f9be` 无用 import 清理）与 Step 20-E cloud 提交（`17f8cdba`，源
  `e9952820`）；及其在 0824 树上的最终落点。
- 与 `02-cloud-sync.md` 的关系：02 号已对 E2EE/#177 做谱系与面上审计（PASS）。
  本篇按任务要求对 Step 19/20 三个专题**逐门禁下钻**，并补 v0.9.44 行为级对照
  与三条 02 号未记录的记录性观察。方法为只读静态审计，未运行 Tauri 实机编译。

## 结论

**PASS（附 3 条记录性观察，均不阻断、不需要本轮产品修复）。**

1. **ZIP restore fail-closed（Step 19）成立**：A/B 管理器缺失的拒绝已前移到磁盘
   预算、清槽与任何数据库写入之前（`commands_restore.rs:644-648`），v0.9.44 的
   「先写满 slotB、最后才在登记切槽时失败」半恢复槽路径已被删除；ZIP 导入在
   **改动目标目录之前**完成归档验证与密封载荷密码预检，越界路径、符号链接、
   压缩炸弹、清单外文件、校验和缺漏全部拒收；三个稳定错误码
   （`E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE`、`E_BACKUP_SEALED_PASSWORD_REQUIRED`、
   `E_BACKUP_SEALED_DECRYPT_FAILED`）已接到前端 i18n，部分归档导入成功后不再
   弹整槽恢复确认。
2. **无 marker 旧加密口令（Step 20-E）成立**：v0.9.44 从未写
   `.encryption-marker`（`git show v0.9.44:.../sync_manager.rs` 全文零命中），
   升级客户端首次带密码上传时不再把未验证口令直接固化成 v2 校验子，而是先对
   既有最新备份完整试解（`sync_manager.rs:653-673`、`738-847`）；明文 ZIP 豁免
   仅限 marker 缺失路径且仅认 `PK` 魔数，v1 marker 下明文与截断/损坏内容仍
   fail-closed（集成测试 `sync_r12_v1_marker_trust.rs` 八用例钉死）。
3. **E2EE 防降级成立**：上传侧 marker 三态 + 校验子 + 本机「曾加密」记忆双门，
   记录级/文件级/blob 下载侧对明文遗留对象显式拒收，死代码
   `get_file_decoded`（曾接受明文）已删除并有锁定测试；相对 v0.9.44 的收紧
   只发生在异常参数/异常容器上，DSBK v1/v2 布局与默认 Argon2 参数未变，
   自家旧备份不会被拒（「只紧不松」成立）。

无需产品修复。**本轮不改代码。**

## 一、Step 19：ZIP restore fail-closed 深挖

### 1.1 A/B fail-closed 前移（对照 v0.9.44 的半恢复槽事故路径）

v0.9.44 的整槽恢复在 DataSpaceManager 缺失时**回退**到硬编码目录：

```628:642:src-tauri/src/data_governance/commands_restore.rs(v0.9.44)
    let (inactive_dir, inactive_slot) = match crate::data_space::get_data_space_manager() {
        Some(mgr) => { /* ... */ (dir, Some(slot)) }
        None => {
            // 未启用双空间模式，回退到 slots/slotB
            let dir = app_data_dir.join("slots").join("slotB");
            warn!("[data_governance] DataSpaceManager 未初始化，回退到 slotB");
            (dir, None)
        }
    };
```

随后照常清槽、写入全部数据库与资产，直到最后登记切槽时才碰壁
（v0.9.44 同文件 1079-1084 行 `let Some(slot) = inactive_slot else { ... fail }`）——
**全部恢复 IO 已经发生，slotB 留下无人认领的半恢复内容**。Step 19
（`1df0ec6a`）把该判定前移为守卫：

```644:648:src-tauri/src/data_governance/commands_restore.rs
    // 必须在磁盘预算、清槽和任何数据库写入之前 fail-closed。
    let Some(data_space_manager) = crate::data_space::get_data_space_manager() else {
        job_ctx.fail(atomic_restore_unavailable_error());
        return;
    };
```

错误携带稳定码并声明「已在写入任何恢复数据前中止；当前数据未改动」
（`commands_restore.rs:24-29`，稳定码常量在
`src-tauri/src/data_governance/backup/mod.rs:65` 新增，v0.9.44 无），单测
`commands_restore.rs:1179-1188` 钉住码与「写入任何恢复数据前中止」文案。
后段旧的双重 `else` 兜底（v0.9.44:1079-1090）随之删除，避免同一失败被两处
不同文案报告。

### 1.2 恢复主链门禁顺序（读 → 验 → 门 → 写）

`execute_restore_with_progress`（`commands_restore.rs:372-1173`）的写前门禁按序：

| 顺位 | 门禁 | 行号 | 性质 |
| --- | --- | --- | --- |
| 1 | manifest 存在 + 路径限界 + 版本兼容 | 440-458 | 只读 |
| 2 | `validate_for_slot_restore`（partial archive 拒整槽，稳定码 `E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE`） | 459-466 | 只读 |
| 3 | `restore_assets=false` 显式拒绝（完整快照不能跳资产） | 467-473 | 只读 |
| 4 | `verify_with_assets` 全量完整性 | 474-491 | 只读 |
| 5 | 逐文件 SHA-256 + `.db` 的 `PRAGMA integrity_check` | 550-632 | 只读 |
| 6 | **A/B 管理器 fail-closed（Step 19 前移点）** | 644-648 | 门 |
| 7 | 磁盘预算 ×2 + 目标卷解析 | 657-701 | 门 |
| 8 | 清空目标槽（失败即中止） | 703-729 | 首个写点 |
| 9 | 逐库恢复 / 工作区 / 分层资产 / 密钥（`IncludedLocal` 声明必须真的恢复到密钥文件，860-879） | 737-957 | 写 |
| 10 | 候选槽先迁移验证（`initialize_with_report`），失败不发布任何切槽状态 | 987-995 | 写后验 |
| 11 | 同步基线重建（清 `__change_log`、提升 `sync_version`，防「恢复即覆盖」云端） | 997-1070 | 写后验 |
| 12 | 激活标记 → 维护屏障 → 原子登记切槽（任一步失败回滚标记/屏障） | 1072-1094 | 发布 |

首个磁盘写动作（清槽）严格位于第 6 门之后，Step 19 声明成立。维护屏障自身
也是 fail-close 取向：进入失败只回滚本次取得的组件、绝不解除其他所有者建立的
屏障（`commands_restore.rs:211-247`）；退出失败的组件保持拒新连接并硬报错
（249-288）。

### 1.3 ZIP 导入拒收面（改动目标目录之前完成）

导入实现 `import_backup_from_zip_impl`
（`src-tauri/src/data_governance/backup/zip_export.rs:1736-1952`）顺序为：
`validate_import_archive`（1772）→ `precheck_sealed_payload_password`（1779）→
`validate_import_target_root`（1799）→ 解压 → 解封 → `validate_imported_backup_dir`
（1928）。前两步只读归档，目标目录在 1799 之前不被触碰：

- **中央目录级拒收**（`zip_export.rs:1206-1291`）：`enclosed_name` 拒越界/空路径
  （1217-1228）；未加密 ZIP 禁带 `crypto/`、审计库等敏感路径（1229-1234）；
  路径含换行、重复路径拒收（1236-1247）；条目数 ≤100 000、解压总量 ≤20 GiB、
  单条目与总体压缩比 ≤200（`ARCHIVE_POLICY`，597-601 + 1253-1285）。
- **解压级拒收**：`prepare_import_destination`（677-741）逐段拒符号链接与
  非目录父路径；`copy_with_actual_size_budget`（743-760）按**实际写出字节**
  再执行一次总量预算（防中央目录谎报）；`extract_zip_file_atomically`
  （762-790）比对实际大小与中央目录声明并经临时文件原子落盘。
- **密封载荷（加密全保真 ZIP）**：外层含 `portable_secrets.dsbk` 而未给密码时
  在**解压任何条目之前**报 `E_BACKUP_SEALED_PASSWORD_REQUIRED`
  （`precheck_sealed_payload_password`，1541-1564；测试断言目标目录未被创建，
  2599-2671）；解密失败报 `E_BACKUP_SEALED_DECRYPT_FAILED`（1453-1458），
  错误码文档明确 AEAD 无法区分错密码与篡改、码必须诚实覆盖两者（52-55）；
  内层 ZIP 只允许敏感域 + 原始 manifest（`validate_secrets_archive`，
  1302-1368）；解封中断时清理已落盘敏感明文半成品（1466-1494），外层条目
  保持可续传。
- **导入后总验**（`validate_imported_backup_dir`，287-446）：未加密 ZIP 必须
  声明 `key_policy=excluded_portable`（307-318）；`SnapshotKind::Full` 必须再过
  `validate_for_slot_restore`（320-324，与恢复门禁同一判定，
  `backup/mod.rs:1063-1101`）；清单未声明的文件、符号链接、校验和缺漏/重复/
  不匹配一律拒收（350-444）。

对照 v0.9.44：`git show v0.9.44:.../zip_export.rs` 中 `ARCHIVE_POLICY`、
`validate_import_archive`、`prepare_import_destination` 已存在（385、946、465 行），
但**整个密封载荷体系不存在**（`ENCRYPTED_SECRETS_ENTRY`、
`precheck_sealed_payload_password`、`validate_secrets_archive`、
`unseal_encrypted_secrets` 零命中）——v0.9.44 的 ZIP 一律便携包。0824 对其的
承接是 LegacyCandidate 升级验证（`zip_export.rs:291-299` +
`backup/mod.rs:1341-1381`），且测试明文钉住
「v0.9.44-compatible portable ZIPs may import for inspection but must never
replace a slot」（`zip_export.rs:2330-2338`）。ZIP 拒收相对 v0.9.44 是纯加严。

### 1.4 稳定错误码与前端接线（`6cfabf67` + `1df0ec6a`）

- 常量三处对齐：Rust `zip_export.rs:47-58` / `backup/mod.rs:65`；TS
  `src/utils/cloudStorageApi.ts:22-24`（诊断文本兜底提码 105-112）；映射
  `src/features/settings/components/data-governance/localizeCloudError.ts:78-84`。
- zh-CN 文案落地：`src/locales/zh-CN/cloudStorage.json:217-219`
  （`sealedBackupPasswordRequired` / `atomicRestoreUnavailable` 均声明
  「当前数据没有被改动」）；en-US 同键同批落地。
- 误导性确认抑制：导入完成后仅当
  `cloudApi.isImportedArchiveSlotRestorable(stats)` 为真才弹整槽恢复提示
  （`src/features/settings/components/DataGovernanceDashboard.tsx:888-897`）；
  便携/部分归档显式关掉弹窗。任务级错误本地化在同文件 590-597 按码分流。
  Rust 侧导入结果的 `recovery_kind`/`restorable` 以导入清单的
  `validate_for_slot_restore` 为准（`commands_zip.rs:2018-2028`），与恢复门禁
  同源，前端不是安全边界。
- `d7fb7677` 复核：对 `zip_export.rs` 仅 rustfmt 换行（4 插入 3 删除），无语义。

### 1.5 已存云端密码接线的 fail-closed（导出/导入两侧）

- 导出：开关打开却读不到已存密码 → 稳定码
  `E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED` 拒绝，禁止静默降级成便携包
  （`commands_zip.rs:76-114`）；显式/已存密码短于 8 个 Unicode 码点同样拒绝
  （`secure_store.rs:1911-1922`）。排队前预检一次（693-698），后台再解析一次
  （788-798），两处同函数。
- 导入：只有外层 ZIP 确有 `portable_secrets.dsbk` 才套用已存密码
  （`resolve_import_zip_password`，121-135；嗅探 `zip_contains_encrypted_secrets`
  只看条目名不解密，`zip_export.rs:1524-1531`），便携包忽略 stored 避免旧包
  被「无需密码」挡在门外。单测覆盖 15 个用例（`commands_zip.rs:2385-2587`）。
- 续传导入失败**不**清理目标目录（半成品是续传起点），敏感明文半成品由解封层
  自清（`commands_zip.rs:2126-2133` 文档 + `zip_export.rs:1466-1494`）；
  非续传导入失败整目录清理（`commands_zip.rs:2104-2113`）。密码从不写入
  job params / 日志（2150 注释 + `ZipExportOptions.encryption_password`
  `skip_serializing`，`zip_export.rs:467-473`）。

## 二、Step 20-E：无 marker 旧加密口令（`17f8cdba`）

### 2.1 v0.9.44 事实基线

`git show v0.9.44:src-tauri/src/cloud_storage/sync_manager.rs` 对
`marker|encryption|ENCRYPTION` 全文零命中：v0.9.44 支持 DSBK 云备份
（`backup_crypto.rs` v0.9.44:9-24 已有 v1/v2 容器）但**从不写
`.encryption-marker`**。因此存在真实升级场景：云 root 里躺着 DSBK 密文、
没有任何 marker。`17f8cdba` 之前的 0824 行为是 Absent 分支直接用本机密码
生成校验子登记 v2 marker——若首台升级设备口令输错，错口令会被固化成此后
所有设备的校验基准，正确口令的设备反而被拦。

### 2.2 修复语义（当前树）

```653:673:src-tauri/src/cloud_storage/sync_manager.rs
        let marker = match self.read_encryption_marker_state().await? {
            EncryptionMarkerState::Absent => {
                // v0.9.44 already supported DSBK cloud backups but did not write
                // `.encryption-marker`. Do not let the first upgraded client pin an
                // unverified (possibly mistyped) password into a v2 marker: ...
                self.prove_password_against_existing_backups(password, true)
                    .await?;
                // ...通过后才登记 v2 校验子并写 marker
```

`prove_password_against_existing_backups`（738-847）取 manifest 的
`latest`（缺失时 `versions.first()`，766-773），下载到临时目录后
`spawn_blocking` 全量试解（817-827）；备份列表读不到、下载失败、解密失败
任一步都返回错误且**不改动 marker**（错误文案均含「本次未改动加密标记」）。
`allow_plaintext_zip=true` 仅此路径生效，且豁免窗口极窄：读 4 字节前缀，
只有「非 DSBK 且是 `PK\x03\x04|PK\x05\x06|PK\x07\x08`」才免试解放行
（791-816）——历史明文 ZIP 是合法的 pre-E2EE 状态，没有既有口令可证明，
允许用户从此开启新加密链；其余非 DSBK 非 ZIP 内容落入试解并必然失败
（fail-closed）。短读（<4 字节）不会匹配 ZIP 魔数，同样落入试解失败。

v1 marker 升级路径（708-725）传 `allow_plaintext_zip=false`：v1 marker 声称
仓库已加密，明文最新备份是矛盾状态，不得用任何口令认领（注释 751-753 明确
该取舍）。`version>=2` 却缺校验子按篡改/损坏 fail-closed（727-734），损坏
marker 在校验路径直接拒绝（674-680），三态区分见
`EncryptionMarkerState`（154-161）——对外的 `read_encryption_marker`
把损坏折叠为「存在」（588-599，明文门禁用），密码路径用内部三态避免把
损坏当可升级旧标记。

### 2.3 测试覆盖（`src-tauri/tests/sync_r12_v1_marker_trust.rs`）

| 用例（行号） | 钉住的行为 |
| --- | --- |
| 212 空仓 v1 marker | 首个带密码设备仍可认领升级（保持旧行为） |
| 257 正确口令 | 试解通过后 v1→v2，保留首次写入者/时间 |
| 305 错误口令 | 有既有备份时不得认领，marker 保持 v1 |
| 358 下载失败 | marker 原样，不误升级 |
| 399 截断对象 | SHA 校验失败 → 不升级（v1 下损坏内容 fail-closed） |
| 434 明文遗留 + v1 marker | **不允许**明文豁免，任何口令都不得固化 |
| 472 无 marker + 旧 DSBK | 错口令不得抢占 v0.9.44 仓；正确口令随后可认领 |
| 510 无 marker + 明文 ZIP | 允许开启新加密链（v0.9.44 → E2EE 升级路径） |

「v1 marker 下明文与损坏内容仍 fail-closed」由 399/434 两用例直接钉死，
与合并计划 `docs/0824-MERGE-PLAN.md:930-933` 的声明一致。

## 三、E2EE 防降级

### 3.1 上传侧（写任何对象之前）

- **有密码**：`enforce_encryption_policy_before_upload_with_password`
  （`sync_manager.rs:898-911`）→ 校验/登记校验子（见第二节）→ 成功后把该
  root 指纹写入本机「曾加密」记忆。ZIP 上传（`cloud_storage/mod.rs:329-338`）
  与记录级同步（`data_governance/sync/mod.rs:43-80`）共用同一入口与同一
  `.encryption-marker`。
- **无密码**：`ensure_plaintext_upload_allowed`（849-872）双门——云端 marker
  存在（含损坏折叠为存在）拒明文；marker 已被删但本机
  `EncryptedRootMemory` 记得该 root 曾加密仍拒明文
  （`backup_crypto.rs:791-883`：指纹域分隔落盘不含明文 endpoint，记忆文件
  损坏按「曾加密」处理，876-882）。
- marker 写入后 GET 逐字节回读，短写不得报成功（`sync_manager.rs:601-616`）。
- 校验子本身不可逆且域分隔（`backup_crypto.rs:668-771`）：摘要 =
  SHA-256(domain‖Argon2id(pw,salt))，未知 KDF/损坏字段返回 `Err` 由调用方
  fail-closed（748-757），测试钉住摘要 ≠ 加密密钥（986-1001）。
- 不可信容器的 Argon2 参数先过应用级上限（1 GiB/16/8，36-57），在**分配派生
  内存之前**拒绝；上限覆盖 v0.9.44 默认写入面 64 MiB/3/4（v0.9.44:14-16
  同值），测试 1117-1131 钉住「不拒自家旧备份」——收紧只打异常参数，
  「只紧不松」成立。

### 3.2 下载/读取侧（记录级与文件级）

- `decode_payload`（`sync/mod.rs:876-899`）：本端已启用加密时，无 DSBK 头的
  明文 payload 显式报 `E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED`，错误含迁移
  指引；未启用加密才放行明文（兼容 v0.9.44 明文模式）。测试 12285-12322。
- 文件级对象：清单条目缺 `cipher_sha256`（旧明文对象）在本端启用加密时拒收
  （`download_file_object`，9699-9719）；blob 同理且不做无意义重试
  （10669-10675）；合并去重时密文条目不得被时间戳更新的明文条目降级覆盖
  （5216 注释 + 6234 测试）。
- 死代码封堵：曾接受明文的 `get_file_decoded` 已连同 `file_has_dsbk_magic`
  删除，防止被当积木接回重新打开防降级豁免（`sync/mod.rs:1010-1016`，
  锁定测 `tests/sync_r12_decoded_dead.rs`）。
- 文件级明文上传：本端无密码但云端有 marker → 拒（929-954）；读 marker
  失败 fail-closed 宁可本轮不传（928）。
- 四个稳定码（`cloud_storage/mod.rs:59-71`）与前端分类器
  `syncE2eeErrorMapping.ts:24-47`（code 优先、旧中文文案正则兜底 59-108）
  一致，测试用后端原文钉死。

### 3.3 对照 v0.9.44 汇总

| 面 | v0.9.44 | 0824（Step 19/20 后） |
| --- | --- | --- |
| 整槽恢复无 A/B 管理器 | 回退 slotB，写满后失败留半恢复槽（628-642 + 1079-1084） | 写前 fail-closed + 稳定码（644-648） |
| 加密全保真 ZIP | 不存在（只有便携包） | 密封载荷 + 密码前置 + AEAD + 半成品清理 |
| v0.9.44 便携 ZIP 导入 | n/a | 可检视，永不整槽（LegacyCandidate 严验 + 测试钉死） |
| `.encryption-marker` | 不存在 | 三态 + 校验子 + 回读 + 本机记忆 |
| 无 marker 仓首次加密上传 | n/a（不写 marker） | 先试解既有 DSBK 才固化口令；明文 ZIP 可开新链 |
| 明文对象读取（本端启用加密） | 静默当明文读 | 记录/文件/blob 全部显式拒收 |
| DSBK 容器 | v1(45B 头)/v2 分块，magic `DSBK` | 布局不变，旧 v1 仍可解（`backup_crypto.rs:401-415`） |
| KDF 参数 | 无上限（云端参数直接派生） | 应用级上限先行，异常参数派生前拒绝 |

## 四、记录性观察（不阻断，无需本轮修复）

1. **整包下载路径对明文对象无 marker 门**：`cloud_sync_download`
   （`cloud_storage/mod.rs:503-557`）按 4 字节魔数分流，非 DSBK 内容即使本机
   配置了加密密码也原样返回，不查 `.encryption-marker`。防降级在此面是
   不对称的（上传/记录级/文件级都拒明文，手动整包下载不拒）。**缓解链完整**：
   被换成明文的 ZIP 走导入时禁带 `crypto/`（`zip_export.rs:1229-1234`）、
   必须 `excluded_portable`（307-318）→ 只能落成部分归档，整槽恢复被
   `validate_for_slot_restore` 与 `commands_restore.rs:459-466` 双门拦死，
   前端也不再弹恢复确认。最坏结果是「可检视的部分归档」而非静默整槽替换，
   故记录不升级为 FAIL。
2. **无 marker 试解只采样一个版本**：`prove_password_against_existing_backups`
   取 `manifest.latest`（或 first，`sync_manager.rs:766-773`）。混合历史仓
   （最新是明文 ZIP、更旧的 DSBK 用另一口令）可按明文豁免用新口令认领 root；
   旧密文此后按 `E_SYNC_E2EE_WRONG_PASSWORD` 报错，fail-closed 无数据损失，
   但恢复旧版本时的报错对用户是死角。属既有取舍（明文 ZIP = 合法 pre-E2EE
   状态）的边缘 UX，记录备查。
3. **无 CAS 的并发认领竞态**：两台设备同时对空仓/无 marker 仓用不同口令走
   Absent 分支，`write_encryption_marker` 的回读只验证自身写入
   （601-616），后写覆盖先写；输家后续上传会被校验子拦截（方向正确），但其
   已上传对象成为「另一口令加密」的孤儿。这是无条件写云存储接口的固有限制，
   与 v1 升级路径共享，02 号亦未定级，记录备查。

## 五、验证边界

- 本轮为只读静态审计：未运行 `cargo test`/Tauri 实机、未接真实
  WebDAV/S3/FTP 云端、未做真机换机演练。上述行为断言基于源码 + 既有测试
  文本；Step 19/20 落地时的编译/迁移门禁记录见
  `docs/0824-MERGE-PLAN.md:897-903`、`958-963`。
- 真实云供应商的 marker 覆盖写语义（最终一致性、条件写缺失）与灾难恢复
  放量证据仍需外部凭据/CI，静态审计不冒充线上演练。

## 处置

- Step 19（`1df0ec6a`/`6cfabf67`/`d7fb7677`/`1119f9be`）与 Step 20-E
  （`17f8cdba`）：全部已在基座产品树，无语义回退，无需回放。
- 三条记录性观察：备查，不构成本轮产品修复项。
- 产品修复：无。
- **本轮不改代码。**
