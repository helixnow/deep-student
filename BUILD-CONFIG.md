# 构建配置指南

本文档说明如何配置构建环境以进行跨平台构建。

## 📋 快速开始

### 1. 复制环境变量模板

```bash
cp .env.example .env
```

### 2. 编辑 `.env` 文件，填入你的配置

使用文本编辑器打开 `.env` 文件，根据你的需求填入相应的配置。

### 3. 加载环境变量

```bash
# 在终端中执行（bash/zsh）
source .env

# 或者在每次构建前设置
export IOS_TEAM_ID="YOUR_TEAM_ID"
bash ./scripts/build_ios.sh
```

---

## 🍎 iOS 构建配置

### 必需配置

#### 1. Apple Team ID

在 [Apple Developer](https://developer.apple.com/account) 账号页面查看你的 Team ID。

```bash
export IOS_TEAM_ID="YOUR_TEAM_ID"
```

#### 2. 签名证书

**查看已安装的证书：**

```bash
security find-identity -p codesigning -v
```

**如果没有证书：**

1. 访问 [Apple Developer - Certificates](https://developer.apple.com/account/resources/certificates)
2. 创建证书（根据需要选择类型）：
   - Apple Development - 用于开发测试
   - Apple Distribution - 用于 Ad-Hoc 和 App Store
3. 下载证书并双击安装到钥匙串

### 可选配置

#### 导出方法

```bash
# development - 开发测试
export IOS_EXPORT_METHOD=development

# ad-hoc - 内部测试（默认）
export IOS_EXPORT_METHOD=ad-hoc

# app-store - App Store 发布
export IOS_EXPORT_METHOD=app-store

# enterprise - 企业分发
export IOS_EXPORT_METHOD=enterprise
```

#### 指定签名证书

```bash
# 通常不需要手动指定，脚本会自动检测
export IOS_SIGNING_IDENTITY="Apple Distribution: Your Name (TEAM_ID)"
```

---

## 🖥️ macOS 构建配置

### 必需配置

#### 1. 签名证书

```bash
# 查看已安装的证书
security find-identity -p codesigning -v

# 设置签名证书
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
```

#### 2. 公证配置

**推荐方式：使用 Keychain Profile**

```bash
# 创建 keychain profile（只需执行一次）
xcrun notarytool store-credentials "ProfileName" \
  --apple-id "your-apple-id@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "xxxx-xxxx-xxxx-xxxx"

# 设置环境变量
export APPLE_NOTARIZE_KEYCHAIN_PROFILE="ProfileName"
```

**或使用 Apple ID 和密码：**

```bash
export APPLE_ID="your-apple-id@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # App-specific password
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

**如何创建 App-specific Password：**

1. 访问 [appleid.apple.com](https://appleid.apple.com)
2. 登录你的 Apple ID
3. 安全 → App 专用密码
4. 生成新密码

---

## 🤖 Android 构建配置

### 必需配置

#### 1. Android SDK 和 NDK

```bash
# 设置 SDK 路径
export ANDROID_HOME="/path/to/android/sdk"

# 设置 NDK 路径
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
```

**如何安装 Android SDK：**

- 通过 Android Studio 安装（推荐）
- 或下载 [Command Line Tools](https://developer.android.com/studio#command-tools)

#### 2. Java JDK

```bash
# macOS
brew install openjdk@17

# 或下载 OpenJDK
# https://adoptium.net/

# 设置 JAVA_HOME（如果需要）
export JAVA_HOME="/path/to/jdk-17"
```

#### 3. Rust Android 目标

```bash
rustup target add aarch64-linux-android
```

### 签名配置

#### 首次构建

首次运行构建脚本时，会自动创建密钥库：

```bash
bash ./scripts/build_android.sh
```

脚本会提示你输入：
- 密钥库密码
- 密钥别名（默认：deepstudent）
- 密钥密码

密钥库会保存在 `~/.android/release.keystore`

#### 使用自定义密钥库

```bash
export ANDROID_KEYSTORE_PATH="/path/to/your.keystore"
export ANDROID_KEYSTORE_PASSWORD="your-password"
export ANDROID_KEY_ALIAS="your-alias"
export ANDROID_KEY_PASSWORD="your-key-password"

bash ./scripts/build_android.sh
```

---

## 🔧 构建优化选项

### 跳过前端构建

如果前端代码未修改，可以跳过前端构建以节省时间：

```bash
export SKIP_FRONTEND_BUILD=true
bash ./scripts/build_ios.sh
```

### iOS：仅重新导出

如果已经构建了 Archive，只需要重新导出为不同格式：

```bash
# 首次构建 Ad-Hoc 版本
IOS_EXPORT_METHOD=ad-hoc bash ./scripts/build_ios.sh

# 重新导出为 App Store 版本（跳过编译）
SKIP_IOS_BUILD=true \
IOS_EXPORT_METHOD=app-store \
bash ./scripts/build_ios.sh
```

### macOS：仅签名和公证

如果已经构建了 DMG，只需要重新签名和公证：

```bash
export SKIP_BUILD=true
bash ./scripts/build_mac.sh
```

---

## 📂 推荐的配置管理

### 创建平台特定的配置文件

#### `.env.ios`

```bash
#!/bin/bash
export IOS_TEAM_ID="YOUR_TEAM_ID"
export IOS_EXPORT_METHOD="ad-hoc"
```

#### `.env.macos`

```bash
#!/bin/bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_NOTARIZE_KEYCHAIN_PROFILE="ProfileName"
```

#### `.env.android`

```bash
#!/bin/bash
export ANDROID_HOME="/path/to/android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export ANDROID_KEYSTORE_PASSWORD="your-password"
```

### 使用方法

```bash
# iOS 构建
source .env.ios
bash ./scripts/build_ios.sh

# macOS 构建
source .env.macos
bash ./scripts/build_mac.sh

# Android 构建
source .env.android
bash ./scripts/build_android.sh
```

**⚠️ 重要：不要将包含真实密码的 `.env.*` 文件提交到 Git！**

```bash
# 将这些文件添加到 .gitignore
echo ".env" >> .gitignore
echo ".env.*" >> .gitignore
```

---

## 🔐 安全建议

1. **不要在代码或文档中硬编码密钥**
2. **使用环境变量管理敏感信息**
3. **定期更新证书和密钥**
4. **备份重要的证书和密钥库**
5. **使用 Keychain Profile 而非明文密码**
6. **限制密钥库文件的访问权限**

```bash
# 设置密钥库文件权限
chmod 600 ~/.android/release.keystore
```

---

## 🆘 故障排查

### 问题：找不到环境变量

**检查环境变量是否已设置：**

```bash
echo $IOS_TEAM_ID
echo $ANDROID_HOME
```

**确保正确加载了 .env 文件：**

```bash
source .env
# 或
set -a; source .env; set +a
```

### 问题：证书不匹配

```bash
# iOS: 清理构建缓存
rm -rf src-tauri/gen/apple

# macOS: 重新导入证书
security find-identity -p codesigning -v
```

### 问题：密钥库密码错误

如果忘记了密钥库密码，只能重新创建密钥库。已签名的应用将无法更新。

---

## 🪟 Windows 构建配置

### 必需配置

#### 1. Visual Studio Build Tools

安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-studio-cpp-build-tools/)，选择"C++ 桌面开发"工作负载。

#### 2. WebView2

Windows 10/11 通常已预装。如未安装，可从 [Microsoft 下载](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。

#### 3. Rust Windows 目标

```bash
rustup target add x86_64-pc-windows-msvc
```

### 构建命令

```bash
bash ./scripts/build_windows.sh
```

### 签名配置（可选）

Windows 应用签名需要代码签名证书：

```bash
export WINDOWS_CERTIFICATE_PATH="/path/to/certificate.pfx"
export WINDOWS_CERTIFICATE_PASSWORD="your-password"
```

---

## 📚 相关文档

- [快速参考](./README-BUILD.md)

---

**最后更新**: 2026-02-07

