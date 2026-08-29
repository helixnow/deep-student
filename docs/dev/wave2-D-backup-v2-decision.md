# Wave2-D R5 裁决：backup-v2 / delta 原语族 = experimental 隔离

- 轮次：0824 Wave2-D 第 5 轮「backup-v2 裁决」
- 分支：`cursor/0824-wave2-cloud-data-a875`
- 性质：书面决策 + 源码锁（注释/allowlist 层面）；**零行为变更、零删除代码**
- 约束遵守：未编译、未运行测试、未 commit、未触碰 `migration/coordinator.rs`
  （两加法原样保留，见 `wave2-D-ledger.md` §2）

## 0. 裁决

**采纳推荐项：delta 族维持 experimental 隔离，不排接线。**

- 生产 Cloud backup/restore 的默认路径继续是「全量 staging → 全量 ZIP →
  可选整包 DSBK → 单对象 `put/get`」（`sync_manager.rs`），**不得**走任何
  孤立的 backup-v2 原语；
- delta 族全部模块保留在仓库内，仅供 `sync_r12_*` 集成测试消费（作为协议
  正确性的可执行规格），不删除、不合并、不暴露；
- 已有 `sync_r12_*` 测试**全部保留**——它们既是行为测试，又是把「零生产
  接线」钉死的源码锁（字面子串 × `src/**/*.rs` 文件白名单）；
- 「接线排期」不给出日历时间：改为 §4 的**接线前置清单**。清单未清零之前，
  任何把 delta 族接到命令层 / UI / `sync_manager` 的改动都应被 code review
  与源码锁双重拒绝。

## 1. 裁决对象（delta 族清单）

| 模块 | 位置 | 职责 | 生产入口 |
| --- | --- | --- | --- |
| `delta_format` | `src-tauri/src/cloud_storage/delta_format.rs` | snapshot descriptor / 仓库配置纯 codec（自包含、禁 parent/patch、fail-closed） | 无 |
| `delta_inventory` | `src-tauri/src/data_governance/backup/delta_inventory.rs` | 已验证 staging 的规范清单与 reuse/upload-new/deleted diff | 无 |
| `backup_lease` | `src-tauri/src/cloud_storage/backup_lease.rs` | `backup-v2/locks/` 独立仓库租约（`E_BACKUP_LEASE_HELD`） | 无 |
| `delta_upload` | `src-tauri/src/cloud_storage/delta_upload.rs` | 快照发布原语 `publish_verified_staging`（index PUT 为唯一 commit point） | 无 |
| `delta_restore` | `src-tauri/src/cloud_storage/delta_restore.rs` | 快照物化原语 `restore_snapshot_to_staging`（云端只读，租约除外） | 无 |
| `delta_gc` | `src-tauri/src/cloud_storage/delta_gc.rs` | 两遍 candidate/grace GC（`collect_gc_candidates` / `sweep_gc_candidates`，宁留垃圾） | 无 |
| include! 片段 | `delta_restore_upstream.rs.in` / `delta_gc_upstream.rs.in` | 跨积木复用的唯一通道，逐行钉死 | 无 |

相邻的 R4 零接线原语（`verified_publish` / `e2ee_claim` / `bad_object` /
`repo_check`）**不在**本裁决范围；本轮只因源码锁冲突动了
`verified_publish.rs` 的两处字面量（见 §3.2）。

## 2. 对齐源码：生产默认路径不走 backup-v2（证据）

以下为本轮（只读 grep，未运行测试）复核结果：

1. **上传/下载仍是整 ZIP 单对象**：`sync_manager.rs:1432` 与 `:1733` 仍构造
   `format!("{}/{}.zip", BACKUPS_DIR, version_id)`，`:1437` 仍
   `.put_file(&remote_key, zip_path, progress)`；全文件零 `backup-v2` /
   `delta_` 字样。
2. **命令层零注册**：`main.rs` / `lib.rs`（invoke_handler）零 delta 族引用；
   `cloud_storage/mod.rs` 对 delta 族只有裸 `pub mod` 声明行，无 `pub use`、
   无命令导出。
3. **入口函数零生产调用方**（全 `src/**/*.rs` 字面扫描，与 sync_r12 锁同法）：
   - `publish_verified_staging` → 仅 `delta_upload.rs`
   - `restore_snapshot_to_staging` → 仅 `delta_restore.rs`
   - `collect_gc_candidates` / `sweep_gc_candidates` → 仅 `delta_gc.rs`
   - `acquire_backup_repo_lease` / `BACKUP_LEASE_HELD` → 仅 `backup_lease.rs`
     + `delta_upload.rs`（未接线积木自身）
   - `delta_inventory` → 仅 `delta_upload.rs` + 模块自身 + `backup/mod.rs`
     声明行
4. **前端零接线**：`CloudStorageSection` 组件源不含
   `delta_upload|publish_verified_staging|backup-v2`（由
   `tests/vitest/data-governance/r09-ux-cloud-storage.test.tsx:444-446` 锁定）。
5. **记录级同步不受影响**：`commands_sync.rs` 继续只用
   `sync_lease::acquire_sync_target_lease` / `E_SYNC_LEASE_HELD`。

## 3. 本轮源码锁动作（注释 / allowlist，不删代码）

### 3.1 新增的 experimental 标注（纯注释，零行为变更）

- `cloud_storage/mod.rs`：在 delta 族声明区加裁决横幅注释 + 为四个裸
  `pub mod delta_*;` 补 doc 注释（声明行本身逐字不动，兼容锁测试的
  exact-line 断言）；
- 六个模块（`delta_format` / `delta_inventory` / `backup_lease` /
  `delta_upload` / `delta_restore` / `delta_gc`）模块文档各加一段
  「[Wave2-D R5 裁决] 状态 = experimental 隔离」并回指本文件；
- 五个公开入口函数（`publish_verified_staging`、
  `restore_snapshot_to_staging`、`collect_gc_candidates`、
  `sweep_gc_candidates`、`acquire_backup_repo_lease`）doc 注释各加
  「[experimental 隔离入口] 生产代码零调用方」标注。

**不加 `debug_assert` / 编译期 feature 门的理由**：本轮禁编译禁测试，任何
新增可执行代码或 `#[cfg(feature)]` 门都无法验证（feature 门还会让
`sync_r12_*` 测试对这些模块的 `use` 在默认 feature 下编译失败）；且现有
sync_r12 源码锁（字面子串 × 文件白名单，接线即红）严格强于运行期
`debug_assert`（release 下会被编译掉，且「被生产调用」没有可判定的运行期
谓词）。注释 + 既有测试锁已是该约束下的最强组合。

### 3.2 修复一处既有源码锁冲突（R4 × R12）

R4 落地的 `verified_publish.rs` 在模块文档与
`E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE` 错误文案里写了 `backup_lease`
字面量，而 R12 的
`sync_r12_backup_lease.rs::source_lock_backup_lease_has_zero_production_wiring`
对该字面量做全 `src/` 白名单扫描且**没有**豁免 `verified_publish.rs`——
该锁在本分支处于会红的状态。本轮把两处字面量改写为「backup-v2 仓库租约」
（语义不变；稳定错误码常量与其断言 `verified_publish.rs:491` 未动），使锁
恢复严格成立，而不是反向放宽测试白名单。

### 3.3 保留项

- `sync_r12_*` 全部测试保留（含 6,000+ 行协议用例与源码锁）；
- `delta_gc_upstream.rs.in` / `delta_restore_upstream.rs.in` 逐行钉死机制
  原样保留；
- 不删任何 delta 族代码；不改 `migration/coordinator.rs`（两加法）。

## 4. 接线前置清单（何时才允许把 delta 族接进生产）

接线不是被永久否决，而是被**清单门禁**：以下条件全部满足前，PR 不得移除
sync_r12 源码锁、不得在命令层 / UI / `sync_manager` 引用 delta 族。

1. **协议完备**：E2EE key 管理路补齐（`idKeyEpoch` 轮换、DSBK 会话密钥与
   `.encryption-marker` 校验子的关系定稿）；跨设备 GC 语义定稿（当前 GC 的
   live set 建立在「完整列举全部 per-device index」上，LIST 截断即 fail-closed）。
2. **故障注入达标**：upload commit point、restore 半途失败、GC collect/sweep
   两遍之间的并发发布，各自有故障注入套件且稳定通过（DELTA-R11 §5 的口径）。
3. **恢复链对接设计**：backup-v2 物化出的 staging 如何进入现有导入 / A/B 槽
   切换、防降级门禁（`ensure_download_not_degraded` 语义）如何覆盖对象级
   下载，有评审过的设计文档。
4. **门禁替换**：接线 PR 必须把 sync_r12 源码锁**替换成真实集成测试**（锁的
   失败信息里已写明此要求），并同步更新本文件、DELTA-R11、FIX-QUEUE 台账。
5. **文案边界**：首版只可称「未变文件复用 / 增量传输」，不得称 CDC、块级
   去重或全局内容去重（DELTA-R11 §0）。

## 5. 复核方式

```bash
# 生产默认路径锚点（应各有命中）
rg -n 'format!\("\{\}/\{\}\.zip", BACKUPS_DIR, version_id\)' src-tauri/src/cloud_storage/sync_manager.rs
# delta 族引用面（应与 §2.3 的白名单一致）
rg -l 'publish_verified_staging|restore_snapshot_to_staging|collect_gc_candidates' src-tauri/src
# 全量锁（需要编译环境时）
cargo test --test sync_r12_delta_format --test sync_r12_delta_inventory \
  --test sync_r12_backup_lease --test sync_r12_delta_upload \
  --test sync_r12_delta_restore --test sync_r12_delta_gc
```
