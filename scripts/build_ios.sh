#!/usr/bin/env bash
set -Eeuo pipefail

# iOS IPA 全自动构建和签名脚本
# Usage:
#   bash ./scripts/build_ios.sh
#
# 环境变量配置（可选）:
#   IOS_SIGNING_IDENTITY        # 签名证书名称，默认自动检测
#   IOS_TEAM_ID                 # Team ID，必须设置为你的 Apple Team ID
#   IOS_PROVISIONING_PROFILE    # Provisioning Profile UUID（可选）
#   IOS_EXPORT_METHOD           # 导出方法: app-store|ad-hoc|development|enterprise，默认: ad-hoc
#   SKIP_FRONTEND_BUILD=true    # 跳过前端构建
#   SKIP_IOS_BUILD=true         # 跳过 iOS 编译（仅导出已有 archive）
#   SKIP_ICON_GENERATION=true   # 跳过图标生成

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# 颜色输出
say() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; }
die() { error "$*"; exit 1; }

# 检查必需命令
require_cmd() { 
    command -v "$1" >/dev/null 2>&1 || die "缺少必需命令: $1"
}

require_cmd npm
require_cmd npx
require_cmd xcodebuild
require_cmd security
require_cmd codesign

cd "$REPO_ROOT"

# ============================================================================
# 1. 配置检查
# ============================================================================
say "检查构建环境..."

# 检查 Xcode
if ! xcodebuild -version >/dev/null 2>&1; then
    die "未安装 Xcode 或 Command Line Tools"
fi

XCODE_VERSION=$(xcodebuild -version | head -n 1)
say "✓ $XCODE_VERSION"

# 检查 iOS 目标
if ! rustup target list --installed | grep -q "aarch64-apple-ios"; then
    warn "未安装 aarch64-apple-ios 目标，正在安装..."
    rustup target add aarch64-apple-ios
    rustup target add aarch64-apple-ios-sim  # 模拟器支持
fi

say "✓ Rust iOS 目标已安装"

# ============================================================================
# 2. 签名证书配置
# ============================================================================
say "配置签名证书..."

# Team ID
if [[ -z "${IOS_TEAM_ID:-}" ]]; then
    die "请设置环境变量 IOS_TEAM_ID 为你的 Apple Team ID"
fi
TEAM_ID="$IOS_TEAM_ID"

# 导出方法
EXPORT_METHOD="${IOS_EXPORT_METHOD:-ad-hoc}"

# 检测可用的签名证书
if [[ -z "${IOS_SIGNING_IDENTITY:-}" ]]; then
    say "自动检测签名证书..."
    
    # 根据导出方法选择合适的证书
    case "$EXPORT_METHOD" in
        "app-store")
            # App Store 需要 Distribution 证书
            IOS_SIGNING_IDENTITY=$(security find-identity -p codesigning -v | \
                grep "Apple Distribution" | \
                grep "$TEAM_ID" | \
                head -n1 | \
                sed -E 's/.*"(.+)"/\1/' || true)
            ;;
        "development")
            # Development 需要 Development 证书
            IOS_SIGNING_IDENTITY=$(security find-identity -p codesigning -v | \
                grep "Apple Development" | \
                grep "$TEAM_ID" | \
                head -n1 | \
                sed -E 's/.*"(.+)"/\1/' || true)
            ;;
        "ad-hoc"|"enterprise")
            # Ad-Hoc 和 Enterprise 优先使用 Distribution
            IOS_SIGNING_IDENTITY=$(security find-identity -p codesigning -v | \
                grep "Apple Distribution" | \
                grep "$TEAM_ID" | \
                head -n1 | \
                sed -E 's/.*"(.+)"/\1/' || true)
            
            # 如果没有 Distribution，尝试使用 Development
            if [[ -z "$IOS_SIGNING_IDENTITY" ]]; then
                IOS_SIGNING_IDENTITY=$(security find-identity -p codesigning -v | \
                    grep "Apple Development" | \
                    grep "$TEAM_ID" | \
                    head -n1 | \
                    sed -E 's/.*"(.+)"/\1/' || true)
            fi
            ;;
    esac
fi

if [[ -z "$IOS_SIGNING_IDENTITY" ]]; then
    die "未找到合适的签名证书。请确保已安装 Apple Distribution 或 Apple Development 证书"
fi

say "✓ 使用签名证书: $IOS_SIGNING_IDENTITY"
say "✓ Team ID: $TEAM_ID"
say "✓ 导出方法: $EXPORT_METHOD"

# ============================================================================
# 3. 图标生成
# ============================================================================
if [[ -z "${SKIP_ICON_GENERATION:-}" ]]; then
    say "生成 iOS 图标..."
    
    if [[ ! -f "app-icon.png" ]]; then
        warn "未找到 app-icon.png，将使用默认图标"
    else
        # 生成图标
        npm run icons:ios || warn "图标生成失败，将使用现有图标"
        
        # 修复不透明背景（iOS 要求）
        npm run icons:ios:opaque || warn "图标不透明处理失败"
        
        say "✓ iOS 图标生成完成"
    fi
else
    warn "跳过图标生成（SKIP_ICON_GENERATION=true）"
fi

# ============================================================================
# 4. 生成版本信息（包括内部版本号）
# ============================================================================
say "生成版本信息..."
node scripts/generate-version.mjs || die "版本信息生成失败"
say "✓ 版本信息生成完成"

# ============================================================================
# 5. 前端构建
# ============================================================================
if [[ -z "${SKIP_FRONTEND_BUILD:-}" ]]; then
    say "构建前端资源..."
    npm run build || die "前端构建失败"
    say "✓ 前端构建完成"
else
    warn "跳过前端构建（SKIP_FRONTEND_BUILD=true）"
fi

# ============================================================================
# 5. 初始化 iOS 项目（如果需要）
# ============================================================================
IOS_PROJECT_DIR="$REPO_ROOT/src-tauri/gen/apple"

if [[ ! -d "$IOS_PROJECT_DIR" ]]; then
    say "初始化 iOS 项目..."
    npx @tauri-apps/cli ios init || die "iOS 项目初始化失败"
    say "✓ iOS 项目初始化完成"
fi

# ============================================================================
# 6. 配置 Xcode 项目
# ============================================================================
say "配置 Xcode 项目..."

XCODEPROJ="$IOS_PROJECT_DIR/deep-student.xcodeproj"
SCHEME="deep-student_iOS"

if [[ ! -d "$XCODEPROJ" ]]; then
    die "未找到 Xcode 项目: $XCODEPROJ"
fi

# 创建或更新 ExportOptions.plist
EXPORT_OPTIONS="$IOS_PROJECT_DIR/ExportOptions.plist"

write_export_options() {
    cat > "$EXPORT_OPTIONS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>$EXPORT_METHOD</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>uploadSymbols</key>
    <true/>
    <key>uploadBitcode</key>
    <false/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
EOF
}

write_export_options
say "✓ ExportOptions.plist 已更新"

# ============================================================================
# 设置内部版本号（Build Number）
# ============================================================================
say "设置内部版本号..."
# 从生成的version.ts文件中提取build number
BUILD_NUMBER=$(grep "BUILD_NUMBER:" "$REPO_ROOT/src/version.ts" | sed "s/.*BUILD_NUMBER: '\([^']*\)'.*/\1/")
if [[ -z "$BUILD_NUMBER" ]]; then
    warn "无法获取内部版本号，使用默认值 1"
    BUILD_NUMBER="1"
fi
say "✓ 内部版本号: $BUILD_NUMBER"

# ============================================================================
# 7. iOS Archive 构建
# ============================================================================
if [[ -z "${SKIP_IOS_BUILD:-}" ]]; then
    say "开始构建 iOS Archive..."
    say "这可能需要 10-30 分钟，请耐心等待..."
    
    ARCHIVE_PATH="$IOS_PROJECT_DIR/build/deep-student_iOS.xcarchive"
    
    # 清理旧的构建产物
    rm -rf "$ARCHIVE_PATH"
    
    # 使用 Tauri CLI 构建（推荐方式）
    say "使用 Tauri CLI 构建 iOS..."
    
    # 设置 Rust 目标
    export CARGO_BUILD_TARGET="aarch64-apple-ios"
    
    # 构建 iOS（Tauri 会自动调用 xcodebuild）
    npx @tauri-apps/cli ios build --verbose || {
        warn "Tauri CLI 构建失败，尝试使用 xcodebuild 直接构建..."
        
        # 备用方案：直接使用 xcodebuild
        cd "$IOS_PROJECT_DIR"
        
        xcodebuild archive \
            -project "$(basename "$XCODEPROJ")" \
            -scheme "$SCHEME" \
            -configuration Release \
            -archivePath "$ARCHIVE_PATH" \
            -destination "generic/platform=iOS" \
            DEVELOPMENT_TEAM="$TEAM_ID" \
            CODE_SIGN_STYLE=Automatic \
            ONLY_ACTIVE_ARCH=NO \
            CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
            -allowProvisioningUpdates || die "xcodebuild archive 失败"
        
        cd "$REPO_ROOT"
    }
    
    # 检查 Archive 是否生成
    if [[ ! -d "$ARCHIVE_PATH" ]]; then
        die "Archive 构建失败: $ARCHIVE_PATH 不存在"
    fi
    
    say "✓ iOS Archive 构建完成"
else
    warn "跳过 iOS 编译（SKIP_IOS_BUILD=true）"
    
    # 查找现有的 Archive
    ARCHIVE_PATH="$IOS_PROJECT_DIR/build/deep-student_iOS.xcarchive"
    if [[ ! -d "$ARCHIVE_PATH" ]]; then
        die "未找到现有的 Archive: $ARCHIVE_PATH"
    fi
    say "使用现有 Archive: $ARCHIVE_PATH"
fi

# 某些情况下 Tauri CLI 会重写 ios 工程目录，导致 ExportOptions 被清理，导出前确保文件存在
if [[ ! -f "$EXPORT_OPTIONS" ]]; then
    warn "ExportOptions.plist 在构建过程中丢失，正在重新生成..."
    write_export_options
    say "✓ ExportOptions.plist 已重新生成"
fi

# ============================================================================
# 8. 导出 IPA
# ============================================================================
say "导出 IPA..."

EXPORT_PATH="$IOS_PROJECT_DIR/build/ipa-export"
rm -rf "$EXPORT_PATH"

TMP_EXPORT_OPTIONS="/tmp/dstu-export-options.plist"
cp "$EXPORT_OPTIONS" "$TMP_EXPORT_OPTIONS"

cd "$IOS_PROJECT_DIR"

xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$TMP_EXPORT_OPTIONS" \
    -allowProvisioningUpdates || die "IPA 导出失败"

cd "$REPO_ROOT"

# 查找生成的 IPA
IPA_FILE=$(find "$EXPORT_PATH" -name "*.ipa" -type f | head -n 1)

if [[ -z "$IPA_FILE" || ! -f "$IPA_FILE" ]]; then
    die "IPA 导出失败: 未找到 .ipa 文件"
fi

say "✓ IPA 导出完成"

# ============================================================================
# 9. 验证签名
# ============================================================================
say "验证 IPA 签名..."

# 解压 IPA 到临时目录进行验证
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

unzip -q "$IPA_FILE" -d "$TEMP_DIR"

APP_PATH=$(find "$TEMP_DIR/Payload" -name "*.app" -type d | head -n 1)

if [[ -z "$APP_PATH" ]]; then
    die "无法从 IPA 中找到 .app 文件"
fi

# 验证代码签名
codesign --verify --deep --strict "$APP_PATH" || die "签名验证失败"

# 显示签名信息
say "签名信息:"
codesign -dvv "$APP_PATH" 2>&1 | grep -E "Authority|TeamIdentifier|Identifier" | head -n 5

say "✓ IPA 签名验证通过"

# ============================================================================
# 10. 生成最终文件
# ============================================================================
say "生成最终发布文件..."

# 创建输出目录
FINAL_OUTPUT_DIR="$REPO_ROOT/build-ios"
mkdir -p "$FINAL_OUTPUT_DIR"

# 获取版本号
VERSION=$(grep '"version":' package.json | head -n 1 | cut -d'"' -f4)

# 复制 IPA 到输出目录
FINAL_IPA_NAME="DeepStudent-v${VERSION}-iOS-${EXPORT_METHOD}.ipa"
FINAL_IPA_PATH="$FINAL_OUTPUT_DIR/$FINAL_IPA_NAME"

cp "$IPA_FILE" "$FINAL_IPA_PATH"

# 同时复制 dSYM 符号文件（用于崩溃分析）
DSYM_PATH="$ARCHIVE_PATH/dSYMs"
if [[ -d "$DSYM_PATH" ]]; then
    DSYM_ZIP="$FINAL_OUTPUT_DIR/DeepStudent-v${VERSION}-iOS-dSYMs.zip"
    (cd "$ARCHIVE_PATH" && zip -r "$DSYM_ZIP" dSYMs) >/dev/null
    say "✓ dSYM 符号文件已保存: $DSYM_ZIP"
fi

# ============================================================================
# 11. 生成文件信息
# ============================================================================
say "生成文件信息..."

IPA_SIZE=$(du -h "$FINAL_IPA_PATH" | cut -f1)
IPA_SHA256=$(shasum -a 256 "$FINAL_IPA_PATH" | cut -d' ' -f1)

# 获取 Bundle Identifier
BUNDLE_ID=$(defaults read "$APP_PATH/Info.plist" CFBundleIdentifier 2>/dev/null || echo "com.deepstudent.app")

# 获取构建信息
BUILD_NUMBER=$(defaults read "$APP_PATH/Info.plist" CFBundleVersion 2>/dev/null || echo "1")

INFO_FILE="$FINAL_OUTPUT_DIR/build-info.txt"
cat > "$INFO_FILE" <<EOF
Deep Student iOS 构建信息
================================

版本: $VERSION (Build $BUILD_NUMBER)
构建时间: $(date '+%Y-%m-%d %H:%M:%S')
Bundle ID: $BUNDLE_ID

IPA 文件:
  路径: $FINAL_IPA_PATH
  大小: $IPA_SIZE
  SHA256: $IPA_SHA256

签名信息:
  证书: $IOS_SIGNING_IDENTITY
  Team ID: $TEAM_ID
  导出方法: $EXPORT_METHOD

构建特性:
  - SQLite (bundled)
  - LanceDB 向量存储
  - 所有 Mac 版功能
  - iOS 14.0+ 支持
  
安装说明:

1. Development 版本:
   - 在设备上安装描述文件
   - 使用 Xcode 或 Apple Configurator 安装
   - 命令: xcrun devicectl device install app --device <DEVICE_ID> "$FINAL_IPA_NAME"

2. Ad-Hoc 版本:
   - 确保设备 UDID 已添加到 Provisioning Profile
   - 使用 Xcode、Configurator 或第三方工具安装
   - 或通过网页分发（需要 HTTPS）

3. App Store 版本:
   - 使用 Transporter 上传到 App Store Connect
   - 或使用命令: xcrun altool --upload-app --type ios --file "$FINAL_IPA_NAME"

通过 Xcode 安装到设备:
  1. 连接 iOS 设备
  2. 打开 Xcode
  3. Window -> Devices and Simulators
  4. 选择设备，点击 "+" 添加 IPA

通过 Apple Configurator 安装:
  1. 打开 Apple Configurator
  2. 连接设备
  3. 添加 -> Apps -> 选择 IPA 文件

上传到 TestFlight:
  xcrun altool --upload-app \\
    --type ios \\
    --file "$FINAL_IPA_NAME" \\
    --username "your-apple-id" \\
    --password "app-specific-password"
EOF

say "✓ 构建信息已保存: $INFO_FILE"

# ============================================================================
# 12. 清理临时文件
# ============================================================================
say "清理临时文件..."

# 保留 Archive 以便后续重新导出
# 清理 export 目录
rm -rf "$EXPORT_PATH"

# ============================================================================
# 完成
# ============================================================================
say ""
say "=========================================="
say "✨ iOS IPA 构建和签名完成！"
say "=========================================="
say ""
say "📦 最终产物:"
say "   IPA: $FINAL_IPA_PATH"
say "   大小: $IPA_SIZE"
say "   导出方法: $EXPORT_METHOD"
say ""
say "📄 构建信息: $INFO_FILE"
say ""

# 根据导出方法提供相应的安装建议
case "$EXPORT_METHOD" in
    "development")
        say "🔧 Development 版本说明:"
        say "   - 仅限开发设备安装"
        say "   - 可使用 Xcode 直接安装"
        say "   - 有效期: 1 年"
        ;;
    "ad-hoc")
        say "📱 Ad-Hoc 版本说明:"
        say "   - 可分发给测试用户（最多 100 台设备）"
        say "   - 需要设备 UDID 已添加到 Provisioning Profile"
        say "   - 有效期: 1 年"
        say "   - 可通过网页、Email 或第三方工具分发"
        ;;
    "app-store")
        say "🚀 App Store 版本说明:"
        say "   - 使用 Transporter 或 altool 上传到 App Store Connect"
        say "   - 可先上传到 TestFlight 进行内测"
        say "   - 需要通过 App Review 后才能在 App Store 发布"
        ;;
    "enterprise")
        say "🏢 Enterprise 版本说明:"
        say "   - 可分发给企业内部员工"
        say "   - 无设备数量限制"
        say "   - 需要 Apple Enterprise 账号"
        ;;
esac

say ""
say "💡 提示:"
say "   - Archive 已保存，可使用不同的导出方法重新导出"
say "   - 要更改导出方法，设置 IOS_EXPORT_METHOD 环境变量"
say "   - dSYM 文件已保存，用于崩溃日志符号化"
say ""

