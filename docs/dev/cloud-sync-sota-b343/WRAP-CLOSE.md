# 收尾状态（父代理，`d746da20`）

用户要求停止前交付「可用高质量版本」。本文件记录**已合入可交付面**与**诚实未关项**。本地完整 `cargo test` 受 GTK/WebKit 与 CI 排队限制，以 CI + 源码核销为准。

## 已合入、可作交付基线

| 项 | 状态 | 证据 |
|---|---|---|
| KDF 应用级上限 | 已合 | `backup_crypto.rs`：`KDF_MAX_*` + `derive_key` 第一步 `ensure_kdf_params_within_app_limits` |
| 本机加密目录记忆 | 已合 | `EncryptedRootMemory`；删标记后拒明文 |
| 记录级时点恢复 | 已合 | `history.rs` + 冲突面板撤销；快照不上云 |
| 未同步清单 | 已合 | `UnsyncedItemsPanel` + 只读命令 |
| WebDAV 非续传字节核对 | 已合 | `webdav.rs` `downloaded != total_size` fail-closed |
| `get_file_decoded` 死代码 | 已删 | P2-1 关；`sync_r12_decoded_dead.rs` |
| repo_check DSBK v2 头 | 已修 | SSOT `DSBK_V2_HEADER_LEN=44`，chunk `[40..44)` |

## 诚实未关（不阻塞「备份/换机可用」，但是差距）

- **android2 手册 / 错误码机制统一**：未合入专属枝（收尾子代理在飞）。
- **sync target 租约**：未合；自动同步已认 `E_SYNC_LEASE_HELD`，后端 token 待 lease 路。
- **可逆文件名 / 增量备份调研**：未合。
- **基线遗留红灯**：tombstone 场景非法短 hash；明文遗留下载 `downloaded=0`（勿为绿灯放松 fail-closed）。
- **SOTA 不做**：实时协作、原地密钥轮换（换密码=换目录重传）。

## go/no-go

**有条件 go**：桌面 WebDAV 整包备份 + 记录级同步 + E2EE 门禁 + 巡检 + 冲突可撤销，可作为本枝高质量可用版本。Android 换机仍几乎只能 WebDAV；租约与可逆文件名未达不宣称 SOTA 齐。

收尾子代理（`gpt-5.6-sol-xhigh-fast`）回传后只合修复/文档增量，不再开新功能面。
