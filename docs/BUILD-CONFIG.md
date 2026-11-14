# Node 版构建与打包

桌面使用 Electron，移动端使用 Capacitor。使用 Node.js 24 和 npm，不需要 Rust 或 Tauri 工具链。源码、原生兼容层和构建入口都在本仓库；上一代 Tauri 版只保留在 [旧仓库](https://github.com/helixnow/deep-student)。

在仓库根目录安装依赖，并设置 Node 构建号（本地示例与 CI 一致；PowerShell 用 `$env:DEEP_STUDENT_BUILD_NUMBER = '20000'`）：

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

`resources/app/` 包含窗口配置、IPC 权限和历史 SQL 迁移；SQL 文件按原始字节随包分发。`legal/` 提供打包依赖与预编译 WASM 的许可证声明。

## Capacitor 移动版

Android 需要 JDK 21 和 Android SDK platform 36。以下命令默认构建 debug APK，产物为 `mobile/dist/deep-student-debug.apk`。签名版参数见 `mobile/scripts/build-apk.mjs`。

```bash
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

## CI

[Build all platforms](../.github/workflows/build-all-platforms.yml) 在 `main` 和手动触发时打包，产物可从对应 Actions 运行下载。Release Please 继续维护 Node 的版本与变更日志。旧 Tauri 自动发布、补包和向下载站上传的流程已退役；Node 打包流程上传 Actions artifacts。
