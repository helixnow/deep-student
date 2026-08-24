# 0824 wrapup × cloud-sync 最新 tip 预演

## 合并基线

- 预演分支：`cursor/0824-rehearse-wrapup-cloud-cde6`
- wrapup 基线：`origin/cursor/0824-theme-wrapup-cde6` @ `1f8d9850`
- 已有预演：`38143f17`，第一父提交为 wrapup，第二父提交为旧 #177 @ `493c4c74`
- 本轮 cloud-sync：`origin/cursor/cloud-sync-sota-b343` @ `bcd61eec`

本轮在既有预演分支上继续 merge 最新 #177，避免重写已推送历史。#177 的
R12 delta format/inventory/lease/upload/restore/GC 原语、完整 ZIP/E2EE 修复、CI
内存门禁和配套文档作为主体保留。

## 语义合并结论

- `src-tauri/src/cloud_storage/ftp.rs`
  - 保留 #177 的 provider 实现与状态码解析结构。
  - 保留 wrapup/#169 的 fail-closed 判定：只有白名单状态码且正文明确表示
    not-found/gone 才把 CWD 失败当作父目录缺失；歧义 `550 Failed to change
    directory`、权限错误和非 550 错误继续上抛。
- `src-tauri/src/cloud_storage/s3.rs`
  - 保留 #177 的 multipart 分块规划和主体实现。
  - 保留 wrapup/#174 的保守端点识别：只剥离腾讯 COS、阿里 OSS、缤纷云 S4
    和 AWS 已知 provider 的 bucket-host 前缀；不猜测自建域名或 path-style
    路径，bucket 名为 `s3` 时也不会误剥规范端点。
- `src-tauri/src/cloud_storage/webdav.rs`
  - 保留 #177 的 WebDAV provider 与 fake-DAV 契约测试主体。
  - 保留 wrapup/#174 的编码归一化：endpoint 基础路径和 href 在同一解码空间
    比较，构建 URL 时只编码一次，覆盖中文、空格、绝对/相对 href。
- `src-tauri/src/data_governance/sync/mod.rs`
  - tombstone 在过滤清单前解析物理 `object_key`。
  - 内容寻址对象仍有活跃清单引用时保留；最后一个引用消失时删除。这样既不会
    破坏共享对象，也不会把回收永久推给尚未接线的 GC。
- `src/utils/cloudStorageApi.ts`
  - 同时保留 wrapup 的 i18next 配置错误文案与 #177 的 `CommandError`
    envelope/stable-code 透传。

其余冲突按最新 #177 主体处理：Vitest CI 使用 6144 MiB 堆与最多两个 fork；
auto-sync persist 采用完整、校验后的迁移切片。tombstone 场景测试同时覆盖
“共享引用保留”和“最后引用删除”。另修正两条合并后才可见的测试契约：
auto-sync 动态间隔用例在第二轮仍 pending 时切档；cloud SSOT 缺配置断言按
当前 i18n key 的译文校验。

## 编译与回归门禁

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `cargo check -p deep-student --lib`（cwd=`src-tauri`） | PASS（仅既有 warning） |
| `cargo test -p deep-student --lib cloud_storage`（cwd=`src-tauri`） | PASS，86 passed |
| `cargo test -p deep-student --test sync_scenarios_tests asset_tombstone_ -- --test-threads=1`（cwd=`src-tauri`，干净 sync state） | PASS，4 passed |
| `npx vitest run src/utils/__tests__/cloudStorageSsot.test.ts src/stores/__tests__/autoSyncStore.test.ts tests/vitest/data-governance/r11-android-platform-error-codes.test.ts tests/vitest/data-governance/r11-autosync-intervals-failclose.test.tsx` | PASS，4 files / 65 tests |

首次并行运行 tombstone 定向组时，本机已有默认 `sync_state.db` 被多个测试并发
写入，出现一次 `database is locked`；清理该测试状态并串行运行后 4/4 通过。
这是测试状态隔离问题，不是 tombstone 断言失败。
