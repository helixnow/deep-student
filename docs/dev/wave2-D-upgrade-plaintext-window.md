# Wave2-D：升级窗口的明文/密文混布时间点

> 0824 Wave2-D 第 5 轮。记录「云端根目录从明文时代升级到 E2EE」这一窗口内，
> 明文对象与密文对象混布的确切时间点、各读写路径的当前行为、
> 以及尚未实现的部分（opt-in）。所有行号/行为以本分支
> `cursor/0824-wave2-cloud-data-a875` 为准，未跑编译与测试。

## 1. 为什么会有混布窗口

云端根目录（`root/backups/`、`root/manifests/`、`root/sync/` 等）的加密状态
由 `.encryption-marker` 登记（R4 起经 `.encryption-marker.lease` 租约协议认领，
见 `cloud_storage/e2ee_claim.rs`）。但 marker 只声明「此后必须是密文」，
**不会也不能改写既有对象**：

- 启用加密前上传的整包备份（`backups/<id>.zip`）是明文 ZIP；
- 启用加密前的记录级同步对象（payload / 文件级对象 / blob）没有 DSBK 头、
  没有 `cipher_sha256`；
- manifest 按 `id` 引用这些对象，与加密与否无关。

因此从「第一次明文上传」到「所有旧明文版本被删除或被同密码重传覆盖」之间，
云端天然处于明文/密文混布状态。这不是 bug，是升级窗口的固有形态；
需要明确的是各路径在这个窗口内**读**和**写**分别怎么处理。

## 2. 时间线（T0–T4）

| 时刻 | 事件 | 云端状态 |
| --- | --- | --- |
| T0 | root 建立，未配置 E2EE，若干次「立即备份到云端」 | 纯明文：`backups/` 全是明文 ZIP，无 marker |
| T1 | 用户在某设备配置加密密码，首次上传前经租约协议认领 marker（`ClaimExpectation::Absent`，或 v1→v2 升级） | marker 就位；`backups/` 仍全是明文 |
| T2 | 认领设备后续上传 | **混布开始**：新版本是 DSBK 密文，T0 的明文版本原样保留且仍被 manifest 引用 |
| T3 | 其他设备陆续填入同一密码并上传；用户可能手动删除旧版本 | 混布比例下降，但只要 T0 版本没删完，窗口就没关 |
| T4 | 所有明文版本被删除 / 被覆盖 | 纯密文（marker 保留） |

关闭窗口（T3→T4）目前**完全依赖用户手动操作**：产品不做自动重加密迁移，
也不做旧明文版本的自动清理。

## 3. 窗口内各路径的当前行为

### 3.1 历史版本列表：旧明文版本仍会列出（无预警）

`CloudSyncManager` 的版本列表来自 manifest 聚合。`BackupVersion`
（`sync_manager.rs:139`）字段为 id / timestamp / size / checksum / device_id /
app_version / note / recovery_kind——**没有「是否加密」字段**。因此：

- 启用加密后，T0 的明文版本仍然出现在「历史版本」里，外观与密文版本无异；
- 前端无法在点「恢复此版本」之前预警「这是防降级会拒绝的明文版本」；
- 用户只能在下载后收到拒绝错误（见 3.2）。

这是已知的 UX 缺口：列表阶段不可区分，拒绝只发生在下载侧。

### 3.2 手动下载：防降级默认拒（含对合法旧明文的「误伤」，属任务卡要求的行为）

R4 起 `cloud_sync_download`（`cloud_storage/mod.rs`）在下载前读 marker，
下载后查对象头 4 字节，按 `ensure_download_not_degraded` 四象限判定：

| marker | 对象头 | 行为 |
| --- | --- | --- |
| 在 | DSBK | 放行，走解密链 |
| 在 | 非 DSBK | **拒**：`E_SYNC_E2EE_DOWNGRADE_REJECTED`，且已下载对象从本机删除 |
| 不在 | 非 DSBK | 放行（预 E2EE 时代的合法明文备份） |
| 不在 | DSBK | 放行走解密（v0.9.44 等旧版加密但未写 marker） |

关键点：**「marker 在 + 非 DSBK」无法区分「密文被明文替换（降级攻击）」
和「T0 的合法明文历史版本」**——两者在字节层完全一致。任务卡（R4）要求
默认拒绝，宁可误伤合法旧明文，也不给攻击者留「换回明文」的通道。
marker 读取同样 fail-closed：marker 对象存在但内容损坏时按「存在」处理。

误伤场景的用户补救（也写进了 `errors.e2eeDowngradeRejected` 文案，R5）：

1. 在仍持有该数据的设备上，用同一密码执行一次「立即备份到云端」，
   得到密文新版本，再恢复新版本；
2. 或（接受风险时）用网盘自带工具在产品外手动取回旧明文 ZIP——产品内
   没有旁路。

### 3.3 明文历史版本的显式 opt-in：未做

R4 欠账明确记录（ledger §「R4 欠账」）：「防降级可能误伤『启用加密后仍列出
的明文历史版本』——任务卡要求拒；R6 可加显式 opt-in」。当前状态：

- **没有**任何「我知道这是旧明文版本，仍要恢复」的确认开关；
- **没有**按版本白名单 / 按时间戳（marker `created_at` 之前的版本视为
  合法明文）的放行逻辑——后者被有意排除：manifest 与时间戳都在攻击者
  可写的同一云端，不能作为放行依据；
- 若 R6 实现 opt-in，至少要求：仅前端显式勾选 + 二次确认；下载结果绕过
  恢复链的整槽校验之外不得有其他松动；opt-in 不写入任何持久开关（一次
  一确认）。

### 3.4 记录级同步：明文遗留对象拒收、明文上传拒发

与手动下载对称的既有行为（R09 起，非本轮新增，列出以完整时间点）：

- 本端已启用加密时，下载到缺 DSBK 头的 payload / 缺 `cipher_sha256` 的
  文件级对象 / 明文 blob → `E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED`；
- marker 在（或本机「曾加密」记忆在，P11 第二道防线）时的明文上传 →
  同码拒绝；
- 上传发布前复验 marker 逐字节一致（R4），不一致 →
  `E_SYNC_E2EE_CLAIM_CONFLICT` 并回滚本次上传。

### 3.5 巡检：能看见混布，但只读

`repo_check.rs` 对 marker 在场的仓库核对每个对象的 DSBK 头，明文对象报
`plaintextInEncryptedRepo`。巡检是发现「窗口还没关」的唯一产品内手段，
但它只读不改，收敛仍靠用户。

## 4. 稳定错误码 ↔ 前端映射（R5 后）

| 码 | 后端发射点 | 前端 i18n key |
| --- | --- | --- |
| `E_SYNC_E2EE_DOWNGRADE_REJECTED` | `mod.rs ensure_download_not_degraded` | `cloudStorage:errors.e2eeDowngradeRejected`（R5 新增） |
| `E_SYNC_E2EE_CLAIM_CONFLICT` | `e2ee_claim.rs` / `sync_manager.rs` 发布前复验 | `cloudStorage:errors.e2eeClaimConflict`（R5 新增） |
| `E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED` | `sync/mod.rs` / `sync_manager.rs` | `cloudStorage:errors.e2eePlaintextLegacyRejected`（既有） |

## 5. 遗留与后续

- 历史列表无加密标识（3.1）→ 候选 R6+：manifest 新版本条目加
  `encrypted: bool`（旧条目缺省未知），列表阶段预警；
- 明文历史版本 opt-in（3.3）→ R6 候选，约束见上；
- 自动重加密迁移（后台把旧明文版本用已配置密码重传）未排期；
- 本文档描述的行为均未经本轮编译/测试验证（第 5 轮红线：禁跑）。
