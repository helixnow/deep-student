# 构建与打包脚本速查

本仓库统一采用 **Electron（桌面端）+ Capacitor（移动端）+ WebUI / PWA（浏览器端）** 架构，全程基于 Node.js 与 npm，无需 Rust / Tauri 工具链。

详细签名、证书与 CI 发布说明见 [BUILD-CONFIG.md](./BUILD-CONFIG.md)，浏览器端架构与运行时说明见 [WEBUI-AND-PWA.md](./WEBUI-AND-PWA.md)。

---

## 环境要求

| 场景 | 必备环境 | 说明 |
|---|---|---|
| 通用（所有平台） | **Node.js 24+**、npm | 在仓库根目录使用 `npm ci --legacy-peer-deps` 安装依赖；不需要 Rust 工具链 |
| Electron 桌面端 | 同上 | 如未下载 Electron 二进制，执行 `node node_modules/electron/install.js` |
| Android APK | **JDK 21**（优先，亦兼容 JDK 17）、**Android SDK Platform 36**（Build Tools `36.0.0`） | 无需安装 Android Studio |
| iOS 源码构建 | macOS、**Xcode**、CocoaPods | 通过 `mobile/` 下的 Capacitor 工程构建 |

### 浅克隆构建号说明

完整 git 历史下，版本生成脚本会自动基于基线提交计算构建号；若使用浅克隆（如 `git clone --depth=1`）或独立分支缺少基线提交，需显式设置环境变量 `DEEP_STUDENT_BUILD_NUMBER`（大于 `14638` 的正整数）：

```bash
# macOS / Linux
export DEEP_STUDENT_BUILD_NUMBER=20000
```

```powershell
# Windows PowerShell
$env:DEEP_STUDENT_BUILD_NUMBER = '20000'
```

---

## 常用命令速查

### 开发模式

```bash
# 启动 Electron 桌面开发模式
npm run dev:electron

# 启动 WebUI + PWA 开发服务（Vite middleware + Host，默认 http://127.0.0.1:1428）
npm run web
```

### WebUI 与 PWA 生产构建

产物输出目录：`dist-web/`。

```bash
npm run build:web && npm run web:prod
```

### Electron 桌面端打包

产物默认输出目录：`release/`（可通过 `DS_ELECTRON_PACKAGE_OUTPUT` 指定其他目录）。

```bash
# 1. 对齐 Electron 原生模块 ABI
npx @electron/rebuild -f -w better-sqlite3

# 2. 构建前端静态资源
npm run build

# 3. 执行对应平台打包（在目标平台上运行）
node electron/scripts/package.mjs --dir     # 仅生成未压缩应用目录，便于本机验收
node electron/scripts/package.mjs --mac     # macOS (.dmg / .zip)
node electron/scripts/package.mjs --win     # Windows (.exe NSIS / .zip)
node electron/scripts/package.mjs --linux   # Linux (.AppImage / .deb)
```

可选架构参数：`--arm64` 或 `--x64`（默认使用当前宿主机架构）。

### Android APK 打包（Capacitor）

产物默认输出目录：`mobile/dist/`。

```bash
# 首次构建前先安装 mobile/ 子项目依赖
npm --prefix mobile ci --legacy-peer-deps

# Debug APK（默认产出 mobile/dist/deep-student-debug.apk）
node mobile/scripts/build-apk.mjs

# 正式签名 Release APK（默认产出 mobile/dist/deep-student-release.apk）
node mobile/scripts/build-apk.mjs --release
```

支持 `--output <PATH>` 自定义输出路径，以及 `--clean-android` 在构建结束后清理生成的 `mobile/android/` 目录。完整签名参数与 iOS 构建步骤见 [BUILD-CONFIG.md](./BUILD-CONFIG.md)。

---

## 产物输出汇总

| 目标平台 | 构建入口 | 默认输出位置 | 产物格式 |
|---|---|---|---|
| WebUI / PWA | `npm run build:web` | `dist-web/` | 静态资源、`manifest.webmanifest`、`sw.js` |
| macOS | `node electron/scripts/package.mjs --mac` | `release/` | `.dmg`、`.zip` |
| Windows | `node electron/scripts/package.mjs --win` | `release/` | `.exe` (NSIS)、`.zip` |
| Linux | `node electron/scripts/package.mjs --linux` | `release/` | `.AppImage`、`.deb` |
| Android | `node mobile/scripts/build-apk.mjs` | `mobile/dist/` | `deep-student-debug.apk` / `deep-student-release.apk` |

---

## 质量与验证门禁

提交或打包前按改动范围执行对应检查：

```bash
# 前端代码与样式检查
npm run lint
npm run lint:css
npm run typecheck

# Host、插件与架构契约检查
npm run typecheck:host
npm run check:plugins
npm run check:arch
npm run contracts:check

# 公开仓库表面白名单检查
npm run check:public-surface

# 自动化测试
npm run test
npm run test:host
npm run test:plugins
```
