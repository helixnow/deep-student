# 0824 Cloud Delta 合并预演（第八轮）

日期：2026-08-25
分支：`cursor/0824-rehearse-cloud-delta-cde6`

## 范围与结论

- 0824 起始基线：`origin/cursor/0824-cde6` @ `4f05d227`
- 验证期间刷新后的 0824：`origin/cursor/0824-cde6` @ `6e1aec78`
- #177 起始目标：`origin/cursor/cloud-sync-sota-b343` @ `017bb297`
- 验证期间刷新后的 #177：`origin/cursor/cloud-sync-sota-b343` @ `a4378a20`
- 首轮 cloud 合并提交：`d28b7de3`
- 远端预演历史对齐提交：`5b0b8d32`（内容树不变）
- 最新 0824 刷新提交：`623c9bd1`
- 最新 cloud 合并提交：`88bb8ca3`

预演已把 #177 在 0824 尚未拥有的 `fb77f0af..a4378a20` 增量合入。
其中 `017bb297` 完成 22 位随机备份对象名、短哈希 manifest 名及旧名兼容迁移；
随后 `a4378a20` 把记录级 manifest/change 路径也改为短哈希，同时保留 payload
内完整设备 ID 和旧明文路径读取兼容。

验证期间两个输入分支均并发前移，因此先把预演刷新到已合 F subapp 的最新 0824，
再补入 #177 的单提交记录路径增量。两次输入合并均为自动合并，无产品代码冲突。
未修改或推送 `main`、`cursor/0824-cde6`。

## 增量与既有裁决

首轮增量包含：

- E2EE/ZIP 密码稳定错误码及前端本地化；
- 云端恢复磁盘预检、维护模式、便携归档整槽恢复拒绝；
- `recoveryKind` 上传、清单、状态卡和恢复确认全链路；
- 中性备份对象名、短哈希设备 manifest 名、旧对象/旧 manifest 双读与迁移。

`a4378a20` 只追加记录级路径哈希及配套兼容测试。合并没有改动
`cloud_storage/ftp.rs`、`cloud_storage/s3.rs`、`cloud_storage/webdav.rs` 或
`data_governance/sync/tombstone.rs`，因此保留 0824 已裁决的：

- #169 / FTP 550：只有可解析为「不存在」的 550 才按缺失父目录处理；
- #174：WebDAV 编码 href/base 解码和保守 S3 endpoint 规范化；
- blob tombstone：本地仍有活跃引用时拒绝消费删除并复活上传；
- asset tombstone：共享内容对象仍被引用时不物理删除。

## 编译门禁

最终组合 tip 上以下门禁全部通过：

```bash
npm ci
npm run version:generate
npm run typecheck
npx vite build
cargo +stable check --manifest-path src-tauri/Cargo.toml --lib
```

- `npm ci`：1192 packages；报告 12 个既有 audit 项，本轮未改依赖。
- TypeScript：0 错误。
- Vite：19,807 modules，生产构建通过；仅既有循环 chunk / 大 chunk 告警。
- Rust stable 1.98：库编译通过；28 项既有非阻断 warning。
- Linux 首次 Rust 验证补齐 CI 同款 GTK/WebKitGTK、protobuf、lld 和 PDFium。
  PDFium 下载器造成的已跟踪许可证格式变化已恢复，没有带入提交。

## 定向回归

```bash
cargo +stable test --manifest-path src-tauri/Cargo.toml \
  --test sync_r12_record_path_names -- --nocapture
cargo +stable test --manifest-path src-tauri/Cargo.toml \
  --test sync_r12_neutral_names -- --nocapture
cargo +stable test --manifest-path src-tauri/Cargo.toml \
  --test sync_scenarios_tests \
  blob_tombstone_rejected_when_locally_referenced_and_blob_revived -- --nocapture
```

- 记录级路径哈希：6 passed。
- 中性备份/manifest 名兼容矩阵：7 passed。
- 活跃引用 tombstone 防线：1 passed。

刷新前还对未被后续提交触碰的既有裁决完成定向验证：

- S3 endpoint 规范化：5 passed。
- FTP 不可分类 550 fail-closed：1 passed。
- WebDAV 编码路径/href：3 passed。
- Cloud 前端受影响集：8 files、115 tests passed。
