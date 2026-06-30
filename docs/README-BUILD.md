# 构建脚本快速参考

## 一键命令

### macOS（签名+公证）
```bash
bash ./scripts/build_mac.sh
```

### iOS（Ad-Hoc 测试版）
```bash
bash ./scripts/build_ios.sh
```

### Android（ARM64 签名版）
```bash
bash ./scripts/build_android.sh
```

### Linux（deb / rpm / bin）
```bash
bash ./scripts/build_linux_all.sh
```

---

## 详细文档

- 📖 [构建配置指南](./BUILD-CONFIG.md) - 各平台签名、证书、环境变量完整说明

---

## 脚本位置

| 平台 | 脚本路径 | 执行权限 | 备注 |
|------|----------|----------|------|
| macOS | `./scripts/build_mac.sh` | ✅ | 签名+公证 |
| iOS | `./scripts/build_ios.sh` | ✅ | |
| Android | `./scripts/build_android.sh` | ✅ | |
| Windows (交叉编译) | `./scripts/build_windows.sh` | ✅ | 从 macOS 构建 |
| Linux | `./scripts/build_linux_all.sh` | ✅ | deb/rpm/bin |
| 全平台 | `./scripts/build_all.sh` | ✅ | 顺序调用各平台脚本 |

---

## 产物输出

| 平台 | 输出目录 | 文件格式 |
|------|----------|----------|
| macOS | `src-tauri/target/release/bundle/dmg/` | `.dmg` |
| iOS | `build-ios/` | `.ipa`, `.zip` (dSYM) |
| Android | `build-android/` | `.apk`, `.aab` |
| Windows | `build-windows/` | `.exe` (NSIS) |
| Linux | `build-linux/` | `.deb`, `.rpm`, 可执行文件 |

---

## 环境要求

### 所有平台共同要求
- ✅ Node.js 18+
- ✅ Rust (rustup)
- ✅ npm

### macOS 专有
- ✅ Xcode
- ✅ Apple Developer 证书

### iOS 专有
- ✅ Xcode
- ✅ Apple Developer 证书
- ✅ iOS 目标: `rustup target add aarch64-apple-ios`

### Android 专有
- ✅ Java JDK 17+
- ✅ Android SDK
- ✅ Android NDK
- ✅ Android 目标: `rustup target add aarch64-linux-android`

### Windows 交叉编译（从 macOS）
- ✅ NSIS: `brew install nsis`
- ✅ LLVM: `brew install llvm`
- ✅ cargo-xwin: `cargo install --locked cargo-xwin`
- ✅ Windows 目标: `rustup target add x86_64-pc-windows-msvc`
- ✅ 添加 LLVM 到 PATH（在 ~/.zshrc 中添加）:
  ```bash
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
  ```

---

## 快速故障排查

### 问题：构建脚本没有执行权限

```bash
chmod +x ./scripts/build_*.sh
```

### 问题：找不到证书

```bash
# macOS/iOS
security find-identity -p codesigning -v

# Android
keytool -list -v -keystore ~/.android/release.keystore
```

### 问题：环境变量未设置

```bash
# 检查 Android 环境
echo $ANDROID_HOME
echo $NDK_HOME

# 设置（如果需要）
export ANDROID_HOME=/path/to/android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
```

### 问题：Windows 交叉编译失败

```bash
# 1. 确保 LLVM 在 PATH 中
which lld-link
# 如果找不到，添加到 ~/.zshrc:
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"

# 2. 重新安装 cargo-xwin
cargo install --locked cargo-xwin --force

# 3. 清理 xwin 缓存重试
rm -rf ~/.xwin-cache
bash ./scripts/build_windows.sh
```

---

**创建日期**: 2025-10-11

