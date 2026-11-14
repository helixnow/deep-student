# Node 应用资源

这里的资源由 Electron、Web Host 和 Capacitor 共同消费，不依赖 Rust 构建。

- `migrations/`：历史 SQL 与锁清单。移动目录不改变 SQL 字节、文件名、版本或 checksum。
- `capabilities/`、`permissions/`：应用窗口、内置能力与 IPC 权限配置。
- `tauri*.conf.json`：保留既有配置格式的数据文件，由 Node shell 读取；名称不表示运行 Tauri。
- `Info.plist`、`Entitlements.plist`：macOS 权限文案和签名声明。
- `android/release-signing-cert.sha256`：公开签名证书指纹，不是私钥。

SQL 仍按 `scripts/check-migrations.mjs` 校验不可变性，与 Host 的 TS 迁移定义核对。
Electron 安装包将 SQL 逐字节复制到独立的 `migrations/` 资源目录；移动端以原始文本打包。
