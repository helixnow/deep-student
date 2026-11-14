# 移动端构建（Capacitor 8.6）

`mobile/` 是独立工程，依赖装在 `mobile/node_modules`，不碰根工程。原生工程目录 `android/` 和 `ios/` 按需生成，已列入 `.gitignore`，不入库。

## 1. Web 产物与浏览器内验证

```sh
cd mobile
npm ci
npm run build                   # 完整 React 前端 + Worker Host → dist/index.html（--mode app）
npm run build:diagnostics       # 原最小诊断页（--mode diagnostics）
npx playwright install chromium # 只需一次
npm test                        # 生产构建 + vite preview(5318) + Chromium：Worker Host 冷启动、命令调用、SQLite WASM/OPFS
```

## 2. 生成原生工程

```sh
npx cap add android   # 生成 android/（Gradle 工程），并把 dist/ 拷到 app/src/main/assets/public
npx cap add ios       # 生成 ios/（Xcode 工程，Swift Package Manager，不需要 CocoaPods）
npx cap sync          # 之后每次 build 完执行，同步 web 产物和插件
```

`capacitor.config.json`：`appId=com.deepstudent.mobile`，`webDir=dist`。

## 一键生成 Android APK

```sh
npm --prefix mobile run build:apk -- --clean-android
# 自定义产物路径（相对当前工作目录）
npm --prefix mobile run build:apk -- --output /path/to/deep-student.apk
```

命令先执行 `npm run build`，再按需 `cap add android` / `cap sync android`，执行
`./gradlew assembleDebug --console=plain`，默认输出 `mobile/dist/deep-student-debug.apk`。
需要根工程与 mobile 两处的 npm 依赖，以及 Android SDK platform 36（`ANDROID_HOME` / `ANDROID_SDK_ROOT`，
macOS 缺省 `~/Library/Android/sdk`）。优先探测 JDK 21；本机只有 Homebrew JDK 17 时，调整生成工程的 Java
目标版本为 17，并在退出时恢复 `node_modules/@capacitor/android/capacitor/build.gradle` 原文。
存在 `~/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3-bin.zip` 时直接用该缓存。
`--clean-android` 在成功或失败后都会删除 `mobile/android/`；不要对有手工原生改动的工程使用该参数。

完整前端只有在 app 模式且页面有 `#root` 时加载；`?diagnostics=1` 强制保留诊断呈现。
完整业务功能还取决于 `host/profiles/mobile.json` 的插件装配；ACL 会自动采用每个插件声明的命令与 Rust
`allow-application-commands` 的交集，不能通过动态注册绕开此限制。

## 3. 编译与运行

- Android：`npx cap open android`（Android Studio），或在 `android/` 下执行 `./gradlew assembleDebug`。
  - 生成出的工程使用 AGP 8.13、Gradle 8.14.3、Java 21，compileSdk/targetSdk 36，minSdk 24。
  - 需要 JDK 21，以及 Android SDK（platform 36、build-tools 35）。
- iOS：`npx cap open ios`，用 Xcode 构建。工程最低系统为 iOS 15，Package.swift 的 swift-tools 为 5.9。需要完整的 Xcode，Command Line Tools 不够。

## 4. 本机现状（2026-11-07 实测）

| 步骤 | 结果 |
| --- | --- |
| `cap add android` / `cap add ios` | 都成功，工程和 web 资源已生成 |
| Android 编译 | **缺 JDK 21**（本机没有 Java Runtime，`cap add` 的 gradle sync 步骤因此跳过）。Android SDK 已就绪：`~/Library/Android/sdk`，含 platforms 34/35/36、build-tools 35.0.0、cmdline-tools |
| iOS 编译 | **缺 Xcode**（只装了 Command Line Tools，没有 `xcodebuild`） |

补齐后的验证顺序：先 `./gradlew assembleDebug` 或 Xcode 构建，再上真机或模拟器确认：

1. WebView 中 Worker 能启动，OPFS `opfs-sahpool` 可用。Android System WebView 和 WKWebView 的 OPFS 支持程度要实测，浏览器内验证覆盖不到；
2. 能力清单（`src/capabilities.ts`）中标为 partial 的项。
