# Round 05 合入结论

R05 七路已合入 `cursor/cloud-sync-sota-b343`（含 webdav probe × 1k 启发式冲突消解）。

## 本轮落地

- Android SSOT 保存/加载拒绝 FTP，错误文案与 `create_storage` 对齐
- 前端将 Android FTP 硬编码英文错误映射为 i18n
- WebDAV：`check_connection` 在 MKCOL 失败 + PROPFIND 404 时不再误报成功；截断启发式收窄为 750/751/1000/1001
- 加密 ZIP 续传必须带密码；解封失败清理明文半成品
- 回归测试：慢钟 DELETE 冲突、不可解析 DELETE 隔离、有标记无密码拒绝记录级上传

## 复审残留（R06）

- 败方 DELETE 只落 cloud 侧，resolve 命令要求双侧 → 徽章永久占位
- 附件/工作区库仍明文上传，与「E2EE 已启用」预期不符
- 加密标记无密钥校验子，错密码可污染同一 root
- 无自动同步；Android 换机/重启语义未实测
- 资产文件名跨平台（Win 非法字符、大小写、NFD）
- 并行枝 `fix-sync-tombstone-db14` 合 main 时 `ftp.rs` 必冲突
