# 云同步收尾：用户指南与 locale

- 基线：`origin/cursor/cloud-sync-sota-b343` @ `d746da20`
- 分支：`cursor/cloud-sync-sota-wrap-docs-b343`
- 范围：中英文 locale 对齐审计、用户指南 16 按当前实现收口
- 约束：未合并 `r07-docs`

## 1. locale 对齐结果

递归比较中英文 JSON 叶键，并单独核对所有 `{{variable}}` 插值变量：

| locale | 范围 | zh-CN 叶键 | en-US 叶键 | 缺键 | 插值差异 |
|---|---|---:|---:|---:|---:|
| `sync.json` | 全文件 | 163 | 163 | 0 | 0 |
| `cloudStorage.json` | 全文件 | 199 | 199 | 0 | 0 |
| `data.json` | `governance` | 508 | 508 | 0 | 0 |

指定基线已经没有中英文缺键，因此没有添加无人消费的占位键。收尾只同步修正了现有键的中英文语义：

- `cloudStorage.description`：明确 Android 仅 WebDAV，桌面端另有 S3 与实验性 FTP/FTPS。
- `cloudStorage.provider.s3Disabled`：从含糊的“此版本”改成“当前平台或安装包”。
- `cloudStorage.provider.ftpDisabledMobile`：从笼统“移动端”改成实现实际限制 Android。
- `data.governance.cloud_sync_not_configured_desc`：配置指引按 Android / 桌面能力区分，不再在 Android 上提示 S3。

## 2. 用户指南 16 与实现对照

| 收口项 | 指南结论 | 实现依据 |
|---|---|---|
| Android 无 S3 / FTP | Android 发行版只支持 WebDAV；保存或加载 S3/FTP 配置会被拒绝 | `mobile-slim` 未启用 S3；FTP Android 编译期禁用；配置 SSOT 有平台校验 |
| 两套云端机制 | 云端整包备份与记录级双向同步彼此独立；本地备份是基础安全层，不再称“三套云同步机制” | `CloudSyncManager` 与 `data_governance::sync::SyncManager` 是两条独立链路 |
| 仓库巡检只读 | 下载并校验清单引用对象，报告缺失、损坏、孤儿；绝不修改或删除云端数据 | `data_governance_repo_check` 与 `repoCheck.*` 文案 |
| KDF 上限 | 云端 Argon2id 参数在派生前钳制为内存 1 GiB、迭代 16、并行 8；超限 fail-closed | `backup_crypto.rs` 的 `KDF_MAX_M_COST_KIB` / `KDF_MAX_T_COST` / `KDF_MAX_P_COST` |
| 加密目录本机记忆 | 仅保存云端实例单向指纹与观察时间，不上传、不含地址或路径明文；标记误删后仍阻止本机明文降级 | `EncryptedRootMemory` 与 `.cloud-encrypted-roots.json` |
| 记录级时点恢复不上云 | 危险覆盖前自动快照只在本地 `__sync_record_history`；每库保留最近 50 批，回退结果才作为新变更参与下次同步 | `data_governance/sync/history.rs` |
| 未同步文件清单 | 只读列出未下载、明文遗留拒收、大小写冲突、净化重名与非法路径，并给出重试/改名/迁移指引 | `UnsyncedItemsPanel` 与 `data_governance_list_unsynced_items` |
| WebDAV 字节核对 | 续传完成后做整文件 SHA256；包括非续传 WebDAV 在内的 provider 下载都会核对实际字节数与声明大小 | `webdav.rs::get_file` 与 provider 下载契约 |

## 3. 删除的过时内容

- 删除“空间紧张时开启精简备份模式”：旧精简选项已停用，自动备份创建完整恢复点。
- 删除“用命令面板进入数据管理再设置备份目录”：当前入口就在「数据治理 → 备份」。
- 删除“三套独立机制”的云同步心智：改为“本地备份基础层 + 两套独立云端机制”。
- 删除“移动端流程与桌面端一致”的绝对表述：Android 的 provider、文件选择器和重启语义存在明确差异。
- 压缩并重写指南末尾长期累积、且包含“文件级对象未加密”旧结论的维护注释；当前文件级 workspace / VFS blob / 资产对象已纳入 E2EE。

## 4. 验证门

收尾验证应至少覆盖：

1. 六个 JSON 文件可解析。
2. 三组指定 locale 的中英文叶键集合相同。
3. 同键的 `{{variable}}` 集合相同。
4. 指南不再出现“精简备份模式”“三套独立机制”“移动端流程与桌面端一致”等过时句子。

实际结果：

- 指定三组 locale 的范围检查通过：缺键 0、插值差异 0。
- `npm run check:i18n` 退出 0，指定的 `sync.json`、`cloudStorage.json`、`data.json` 均显示键完全一致。
- `npm run check:i18n:missing` 退出 1，唯一键不对称文件是本任务范围外、基线已有的 `mindmap.json`（英文缺 3 个旧式复数键，中文缺 6 个 `_one` / `_other` 键）；本分支没有扩张到 mindmap locale。
