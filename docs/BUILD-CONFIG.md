# 构建与打包配置

桌面使用 Electron，移动端使用 Capacitor。使用 Node.js 24 和 npm，不需要 Rust 或 Tauri 工具链。源码、原生兼容层和构建入口都在本仓库；上一代 Tauri / Rust 版本仅保留在仓库 git 历史的 `v0.11.x` 标签与历史分支中。

在仓库根目录安装依赖，并设置构建号（浅克隆或与 CI 一致时显式指定；PowerShell 用 `$env:DEEP_STUDENT_BUILD_NUMBER = '20000'`）：

```bash
npm ci --legacy-peer-deps
export DEEP_STUDENT_BUILD_NUMBER=20000
```

## Electron 桌面版

```bash
npm run dev:electron
# 生成安装包：在目标平台运行，选择 --mac、--win 或 --linux。
npm run build
node electron/scripts/package.mjs --mac
# 本机冒烟可用 --dir，只生成解包后的应用目录。
```

若 Electron 未安装二进制，运行 `node node_modules/electron/install.js`。打包前用 `npx @electron/rebuild -f -w better-sqlite3` 对齐 Electron 的原生模块 ABI。产物默认写入 `release/`，macOS 生成 DMG / ZIP，Windows 生成 EXE / ZIP，Linux 生成 AppImage / DEB。macOS 本地默认使用临时签名；正式签名配置见 `electron/signing/` 和 `electron/scripts/app-hardening.cjs`。

`resources/app/` 包含窗口配置、IPC 权限和历史 SQL 迁移；SQL 文件按原始字节随包分发。`resources/legal/` 提供打包依赖与预编译 WASM 的许可证声明。

## Capacitor 移动版

Android 需要 JDK 21 和 Android SDK platform 36。以下命令默认构建 debug APK，产物为 `mobile/dist/deep-student-debug.apk`。签名版参数见 `mobile/scripts/build-apk.mjs`。

```bash
npm --prefix mobile ci --legacy-peer-deps
node mobile/scripts/build-apk.mjs
```

在 macOS 使用 Xcode 构建 iOS 模拟器应用：

```bash
npm --prefix mobile ci --legacy-peer-deps
npm --prefix mobile run build
cd mobile
npx cap add ios --packagemanager CocoaPods  # 首次生成 iOS 工程
npx cap sync ios
open ios/App/App.xcworkspace
```

## CI 与自动发布

- [Build all platforms](../.github/workflows/build-all-platforms.yml)：在 `main` 推送和手动触发时打包 macOS / Windows / Linux / Android / iOS 模拟器产物，上传 Actions artifacts 供下载验证。
- [Release PR](../.github/workflows/release-please.yml)：通过 Release Please 维护版本号与变更日志 PR。
- [Release](../.github/workflows/release.yml)：在 `main` 的 CI 通过后识别发布提交，或在推送 `vX.Y.Z` 标签 / 手动触发时，调用可恢复的跨平台发布流水线（`reusable-release-pipeline.yml`）。
- [Rebuild Release](../.github/workflows/rebuild-release.yml)：手动触发，对既有发布标签进行断点续跑或全量重跑（支持自动复用已完成阶段，或通过 `force_rebuild` 全量重建）。
- [Publish Release](../.github/workflows/reusable-publish.yml)：校验各平台产物身份与哈希后，统一发布至 GitHub Release、同步至 Cloudflare R2（含自动更新清单）、刷新 CDN 缓存并触发部署钩子。
- [Sync Release to R2](../.github/workflows/upload-r2.yml)：手动触发，将指定标签的 GitHub Release 资产同步到 Cloudflare R2 并更新 `latest.json`。
