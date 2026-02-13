# scripts/dev/ — 开发工具脚本

此目录包含仅供开发和调试使用的脚本，**不会**包含在生产构建中。

## Android 开发

| 脚本 | 用途 |
|------|------|
| `start-android-dev.sh` | 一键启动 Android 模拟器 + Tauri 开发环境 |
| `debug-android-console.sh` | Android logcat 前端控制台调试（多种模式） |
| `restart-emulator.sh` | 重启 Android 模拟器并检测网络 |
| `sign-apk.sh` | 快速对已有 APK 进行签名 |

## Rust 后端

| 脚本 | 用途 |
|------|------|
| `run-rust-tests.sh` | 运行完整 Rust 测试套件（单元测试 + 集成测试 + clippy + fmt） |

## 数据库调试

| 脚本 | 用途 |
|------|------|
| `check-templates.sh` | 检查数据库中的模板状态（需传入 db 路径） |
| `test-templates.sh` | 测试模板查询功能（需传入 db 路径） |

## API 测试

| 脚本 | 用途 |
|------|------|
| `test-deepseek-ocr.sh` | 手动测试 DeepSeek-OCR API（需传入 API key） |
