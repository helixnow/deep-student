#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

say() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; }
die() { error "$*"; exit 1; }
info() { echo -e "\033[1;36m[info]\033[0m $*"; }

# ============================================================================
# 构建模式配置
# ============================================================================
# BUILD_MODE:
#   1 = 正式发布（正式密钥库，原包名）
#   2 = 测试-同包名（开发密钥库，原包名）
#   3 = 测试-不同包名（开发密钥库，包名加 .dev 后缀）
BUILD_MODE=""
DEBUG_MODE=false
USE_DEV_PACKAGE=false
ORIGINAL_IDENTIFIER=""
TAURI_CONF="$REPO_ROOT/src-tauri/tauri.conf.json"
TAURI_CONF_BACKUP=""

# ============================================================================
# 交互式菜单函数
# ============================================================================
show_build_menu() {
    echo ""
    echo -e "\033[1;35m╔════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[1;35m║         Deep Student Android 构建工具                      ║\033[0m"
    echo -e "\033[1;35m╠════════════════════════════════════════════════════════════╣\033[0m"
    echo -e "\033[1;35m║\033[0m  请选择构建模式：                                          \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m                                                            \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m  \033[1;32m1)\033[0m 🚀 正式发布                                          \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     使用正式密钥库签名，原包名 com.deepstudent.app         \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     适用于：生产环境发布、Google Play 上传                \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m                                                            \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m  \033[1;33m2)\033[0m 🔧 测试版（同包名）                                   \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     使用开发密钥库，原包名 com.deepstudent.app             \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     适用于：覆盖安装测试、快速调试                         \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m                                                            \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m  \033[1;34m3)\033[0m 🧪 测试版（不同包名）                                 \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     使用开发密钥库，包名 com.deepstudent.app.dev           \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m     适用于：与正式版共存测试、对比调试                     \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m                                                            \033[1;35m║\033[0m"
    echo -e "\033[1;35m║\033[0m  \033[1;31m0)\033[0m 退出                                                 \033[1;35m║\033[0m"
    echo -e "\033[1;35m╚════════════════════════════════════════════════════════════╝\033[0m"
    echo ""
    read -rp "请输入选项 [0-3]: " choice
    
    case $choice in
        1)
            BUILD_MODE="release"
            DEBUG_MODE=false
            USE_DEV_PACKAGE=false
            say "已选择：🚀 正式发布模式"
            ;;
        2)
            BUILD_MODE="dev-same-pkg"
            DEBUG_MODE=true
            USE_DEV_PACKAGE=false
            say "已选择：🔧 测试版（同包名）"
            ;;
        3)
            BUILD_MODE="dev-diff-pkg"
            DEBUG_MODE=true
            USE_DEV_PACKAGE=true
            say "已选择：🧪 测试版（不同包名）"
            ;;
        0)
            say "已取消构建"
            exit 0
            ;;
        *)
            error "无效选项: $choice"
            exit 1
            ;;
    esac
}

# ============================================================================
# 包名修改函数（修改 tauri.conf.json 并重新初始化 Android 项目）
# ============================================================================
ORIGINAL_IDENTIFIER=""
DEV_IDENTIFIER=""
ANDROID_REINIT_NEEDED=false

setup_dev_package() {
    if [[ "$USE_DEV_PACKAGE" == true ]]; then
        # 读取原始 identifier
        ORIGINAL_IDENTIFIER=$(grep '"identifier":' "$TAURI_CONF" | head -n 1 | sed 's/.*"identifier": *"\([^"]*\)".*/\1/')
        
        if [[ -z "$ORIGINAL_IDENTIFIER" ]]; then
            die "无法从 tauri.conf.json 读取 identifier"
        fi
        
        # 检查是否已经是 .dev 后缀
        if [[ "$ORIGINAL_IDENTIFIER" == *".dev" ]]; then
            info "包名已经是测试版后缀: $ORIGINAL_IDENTIFIER"
            USE_DEV_PACKAGE=false  # 不需要修改
            return
        fi
        
        DEV_IDENTIFIER="${ORIGINAL_IDENTIFIER}.dev"
        
        say "修改包名: $ORIGINAL_IDENTIFIER -> $DEV_IDENTIFIER"
        
        # 使用 sed 替换 tauri.conf.json
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "s/\"identifier\": *\"$ORIGINAL_IDENTIFIER\"/\"identifier\": \"$DEV_IDENTIFIER\"/" "$TAURI_CONF"
        else
            sed -i "s/\"identifier\": *\"$ORIGINAL_IDENTIFIER\"/\"identifier\": \"$DEV_IDENTIFIER\"/" "$TAURI_CONF"
        fi
        
        info "✓ 包名已临时修改为: $DEV_IDENTIFIER"
        
        # 标记需要重新初始化 Android 项目
        ANDROID_REINIT_NEEDED=true
        
        # 删除旧的 Android 项目并重新初始化
        say "重新初始化 Android 项目（包名已更改）..."
        rm -rf "$REPO_ROOT/src-tauri/gen/android" 2>/dev/null || true
        # 确保目录被删除
        if [[ -d "$REPO_ROOT/src-tauri/gen/android" ]]; then
            find "$REPO_ROOT/src-tauri/gen/android" -delete 2>/dev/null || true
        fi
        npx @tauri-apps/cli android init || die "Android 项目初始化失败"
        info "✓ Android 项目已重新初始化"
    fi
}

restore_package_name() {
    if [[ "$USE_DEV_PACKAGE" == true && -n "$ORIGINAL_IDENTIFIER" && -n "$DEV_IDENTIFIER" ]]; then
        say "恢复包名: $DEV_IDENTIFIER -> $ORIGINAL_IDENTIFIER"
        
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "s/\"identifier\": *\"$DEV_IDENTIFIER\"/\"identifier\": \"$ORIGINAL_IDENTIFIER\"/" "$TAURI_CONF"
        else
            sed -i "s/\"identifier\": *\"$DEV_IDENTIFIER\"/\"identifier\": \"$ORIGINAL_IDENTIFIER\"/" "$TAURI_CONF"
        fi
        
        info "✓ 包名已恢复为: $ORIGINAL_IDENTIFIER"
        
        # 恢复原始 Android 项目
        if [[ "$ANDROID_REINIT_NEEDED" == true ]]; then
            say "恢复原始 Android 项目..."
            rm -rf "$REPO_ROOT/src-tauri/gen/android" 2>/dev/null || true
            if [[ -d "$REPO_ROOT/src-tauri/gen/android" ]]; then
                find "$REPO_ROOT/src-tauri/gen/android" -delete 2>/dev/null || true
            fi
            npx @tauri-apps/cli android init || warn "Android 项目恢复失败，请手动运行: npx @tauri-apps/cli android init"
            info "✓ Android 项目已恢复"
        fi
    fi
}

ensure_android_project() {
    if [[ ! -d "$REPO_ROOT/src-tauri/gen/android" ]]; then
        say "检测到 Android 项目未初始化，正在初始化..."
        npx @tauri-apps/cli android init || die "Android 项目初始化失败"
        info "✓ Android 项目初始化完成"
    fi
}

apply_android_version_code() {
    local build_number="$1"
    if [[ -z "$build_number" ]]; then
        warn "内部版本号为空，跳过写入 tauri.conf.json"
        return
    fi
    if [[ ! -f "$TAURI_CONF" ]]; then
        warn "未找到 tauri.conf.json，跳过写入 versionCode"
        return
    fi
    TAURI_CONF_BACKUP="$(mktemp)"
    cp "$TAURI_CONF" "$TAURI_CONF_BACKUP"
    node -e '
const fs = require("fs");
const path = process.argv[1];
const buildNumber = Number(process.argv[2]);
const raw = fs.readFileSync(path, "utf8");
const data = JSON.parse(raw);
if (!data.bundle) data.bundle = {};
if (!data.bundle.android) data.bundle.android = {};
data.bundle.android.versionCode = Number.isNaN(buildNumber) ? 1 : buildNumber;
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
' "$TAURI_CONF" "$build_number"
    say "✓ tauri.conf.json 已写入 Android versionCode: $build_number"
}

restore_android_version_code() {
    if [[ -n "$TAURI_CONF_BACKUP" && -f "$TAURI_CONF_BACKUP" ]]; then
        mv "$TAURI_CONF_BACKUP" "$TAURI_CONF"
        TAURI_CONF_BACKUP=""
        info "✓ tauri.conf.json 已恢复"
    fi
}

# 确保脚本退出时恢复
trap 'restore_android_version_code; restore_package_name' EXIT

# ============================================================================
# 解析命令行参数
# ============================================================================
for arg in "$@"; do
    case $arg in
        --debug)
            # 兼容旧的 --debug 参数，等同于模式 2
            BUILD_MODE="dev-same-pkg"
            DEBUG_MODE=true
            USE_DEV_PACKAGE=false
            say "启用调试模式（--debug 参数）"
            shift
            ;;
        --dev)
            # 新增 --dev 参数，等同于模式 3
            BUILD_MODE="dev-diff-pkg"
            DEBUG_MODE=true
            USE_DEV_PACKAGE=true
            say "启用开发测试模式（--dev 参数，使用不同包名）"
            shift
            ;;
        --release)
            # 新增 --release 参数，等同于模式 1
            BUILD_MODE="release"
            DEBUG_MODE=false
            USE_DEV_PACKAGE=false
            say "启用正式发布模式（--release 参数）"
            shift
            ;;
        --menu)
            # 强制显示菜单
            BUILD_MODE=""
            shift
            ;;
        *)
            ;;
    esac
done

# 如果没有通过命令行指定模式，显示交互式菜单
if [[ -z "$BUILD_MODE" ]]; then
    show_build_menu
fi

# 配置测试包名（如果需要）
setup_dev_package

# 切换到项目根目录，确保所有相对路径命令能正确执行
cd "$REPO_ROOT" || die "无法切换到项目根目录: $REPO_ROOT"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令: $1"
}

find_build_tools_cmd() {
  local cmd="$1"

  if command -v "$cmd" >/dev/null 2>&1; then
    command -v "$cmd"
    return 0
  fi

  local search_dirs=()
  if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME/build-tools" ]]; then
    if [[ -n "${ANDROID_BUILD_TOOLS_VERSION:-}" && -d "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION" ]]; then
      search_dirs+=("$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION")
    fi
    while IFS= read -r dir; do
      search_dirs+=("$dir")
    done < <(find "$ANDROID_HOME/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V)
  fi

  for dir in "${search_dirs[@]}"; do
    if [[ -x "$dir/$cmd" ]]; then
      echo "$dir/$cmd"
      return 0
    fi
  done

  return 1
}

require_cmd npm
require_cmd npx
require_cmd keytool

APKSIGNER_CMD="$(find_build_tools_cmd apksigner)" || true
ZIPALIGN_CMD="$(find_build_tools_cmd zipalign)" || true

if ! command -v jarsigner >/dev/null 2>&1; then
  die "缺少必需命令: jarsigner"
fi

jarsigner_cmd=$(command -v jarsigner)

if [[ -z "$APKSIGNER_CMD" ]]; then
  warn "未找到 apksigner，将在完成签名后跳过 V2/V3 验证"
fi

# ============================================================================
# 1. 配置检查
# ============================================================================
say "检查构建环境..."

# 检查 Java
if ! command -v java >/dev/null 2>&1; then
    die "未找到 Java。请安装 JDK 17 或更高版本"
fi

JAVA_VERSION=$(java -version 2>&1 | head -n 1 | cut -d'"' -f2 | cut -d'.' -f1)
if [[ "$JAVA_VERSION" -lt 17 ]]; then
    die "Java 版本过低（需要 >= 17）。当前版本: $JAVA_VERSION"
fi

# 检查 Android SDK
if [[ -z "${ANDROID_HOME:-}" ]]; then
    die "未设置 ANDROID_HOME 环境变量"
fi

if [[ ! -d "$ANDROID_HOME" ]]; then
    die "ANDROID_HOME 路径不存在: $ANDROID_HOME"
fi

# 检查 NDK
if [[ -z "${NDK_HOME:-}" ]]; then
    warn "未设置 NDK_HOME，将尝试使用 ANDROID_HOME 下的 NDK"
    if [[ -d "$ANDROID_HOME/ndk" ]]; then
        NDK_HOME=$(find "$ANDROID_HOME/ndk" -maxdepth 1 -type d | tail -n 1)
        export NDK_HOME
        say "自动检测到 NDK: $NDK_HOME"
    else
        die "未找到 NDK。请设置 NDK_HOME 或在 ANDROID_HOME 下安装 NDK"
    fi
fi

# 检查 Rust Android 目标
if ! rustup target list --installed | grep -q "aarch64-linux-android"; then
    warn "未安装 aarch64-linux-android 目标，正在安装..."
    rustup target add aarch64-linux-android
fi

say "✓ 环境检查通过"
say "  Java: $(java -version 2>&1 | head -n 1)"
say "  Android SDK: $ANDROID_HOME"
say "  NDK: $NDK_HOME"

# ============================================================================
# 2. 密钥库配置
# ============================================================================
if [[ "$DEBUG_MODE" == true ]]; then
    say "调试模式：使用默认调试密钥库..."
    
    # 使用调试密钥库路径和固定密码
    KEYSTORE_PATH="$REPO_ROOT/build-android/dev-release.keystore"
    KEY_ALIAS="deepstudent-debug"
    ANDROID_KEYSTORE_PASSWORD="android"
    ANDROID_KEY_PASSWORD="android"
    
    # 如果调试密钥库不存在，创建它
    if [[ ! -f "$KEYSTORE_PATH" ]]; then
        say "创建调试密钥库..."
        mkdir -p "$(dirname "$KEYSTORE_PATH")"
        
        keytool -genkeypair \
            -v \
            -keystore "$KEYSTORE_PATH" \
            -alias "$KEY_ALIAS" \
            -keyalg RSA \
            -keysize 2048 \
            -validity 10000 \
            -storepass "$ANDROID_KEYSTORE_PASSWORD" \
            -keypass "$ANDROID_KEY_PASSWORD" \
            -dname "CN=Deep Student Debug, OU=Development, O=Deep Student, L=Beijing, ST=Beijing, C=CN" \
            || die "创建调试密钥库失败"
        
        say "✓ 调试密钥库创建成功"
    fi
    
    say "✓ 使用调试密钥库: $KEYSTORE_PATH"
    say "  密码: $ANDROID_KEYSTORE_PASSWORD"
    
else
    say "配置签名密钥库..."

    # 密钥库路径
    KEYSTORE_PATH="${ANDROID_KEYSTORE_PATH:-$HOME/.android/release.keystore}"
    KEY_ALIAS="${ANDROID_KEY_ALIAS:-deepstudent}"

    # 如果密钥库不存在，创建新的
    if [[ ! -f "$KEYSTORE_PATH" ]]; then
        warn "密钥库不存在: $KEYSTORE_PATH"
        say "正在创建新的密钥库..."
        
        mkdir -p "$(dirname "$KEYSTORE_PATH")"
        
        # 提示用户输入密码
        if [[ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]]; then
            read -rsp "请输入新密钥库的密码: " ANDROID_KEYSTORE_PASSWORD
            echo
            read -rsp "请再次输入密码确认: " PASSWORD_CONFIRM
            echo
            
            if [[ "$ANDROID_KEYSTORE_PASSWORD" != "$PASSWORD_CONFIRM" ]]; then
                die "两次输入的密码不一致"
            fi
            export ANDROID_KEYSTORE_PASSWORD
        fi
        
        # 生成密钥库
        keytool -genkeypair \
            -v \
            -keystore "$KEYSTORE_PATH" \
            -alias "$KEY_ALIAS" \
            -keyalg RSA \
            -keysize 4096 \
            -validity 10000 \
            -storepass "$ANDROID_KEYSTORE_PASSWORD" \
            -keypass "${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}" \
            -dname "CN=Deep Student, OU=Development, O=Deep Student, L=Beijing, ST=Beijing, C=CN"
        
        say "✓ 密钥库创建成功: $KEYSTORE_PATH"
    else
        say "✓ 使用现有密钥库: $KEYSTORE_PATH"
    fi

    # 确保有密码
    if [[ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]]; then
        read -rsp "请输入密钥库密码: " ANDROID_KEYSTORE_PASSWORD
        echo
        export ANDROID_KEYSTORE_PASSWORD
    fi

    # 密钥密码默认与密钥库密码相同
    ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"

    # 验证密钥库
    if ! keytool -list -keystore "$KEYSTORE_PATH" -alias "$KEY_ALIAS" -storepass "$ANDROID_KEYSTORE_PASSWORD" &>/dev/null; then
        die "密钥库验证失败。请检查密码或密钥别名"
    fi

    say "✓ 密钥库验证通过"
fi

# ============================================================================
# 3. 生成版本信息（包括内部版本号）
# ============================================================================
say "生成版本信息..."
node scripts/generate-version.mjs || die "版本信息生成失败"
say "✓ 版本信息生成完成"

# ============================================================================
# 4. 图标生成
# ============================================================================
if [[ -z "${SKIP_ICON_GENERATION:-}" ]]; then
    if [[ ! -f "$REPO_ROOT/app-icon.png" ]]; then
        warn "未找到 app-icon.png，将使用现有图标"
    else
        ensure_android_project
        say "生成应用图标..."
        npm run icons || warn "图标生成失败，将使用现有图标"
        say "✓ 图标生成完成"
    fi
else
    warn "跳过图标生成（SKIP_ICON_GENERATION=true）"
fi

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
# 6. Android APK 构建
# ============================================================================
if [[ -z "${SKIP_ANDROID_BUILD:-}" ]]; then
    # 打包 pdfium 动态库到 Android APK
    say "打包 pdfium 动态库..."
    ensure_android_project
    JNILIBS_DIR="$REPO_ROOT/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
    mkdir -p "$JNILIBS_DIR"
    PDFIUM_ANDROID_SO="$REPO_ROOT/src-tauri/resources/pdfium/libpdfium_android_arm64.so"
    if [[ -f "$PDFIUM_ANDROID_SO" ]]; then
        cp "$PDFIUM_ANDROID_SO" "$JNILIBS_DIR/libpdfium.so"
        say "✓ pdfium 已打包: $(ls -lh "$JNILIBS_DIR/libpdfium.so" | awk '{print $5}')"
    else
        warn "未找到 Android pdfium: $PDFIUM_ANDROID_SO"
        say "  尝试下载..."
        bash "$REPO_ROOT/scripts/download-pdfium.sh" android-arm64 || warn "pdfium 下载失败，PDF 功能将不可用"
        if [[ -f "$PDFIUM_ANDROID_SO" ]]; then
            cp "$PDFIUM_ANDROID_SO" "$JNILIBS_DIR/libpdfium.so"
            say "✓ pdfium 已下载并打包"
        fi
    fi

    say "开始构建 Android APK（ARM64 架构）..."
    say "这可能需要几分钟时间，请耐心等待..."

    # 清理旧的构建产物（可选）
    # rm -rf src-tauri/gen/android/app/build/outputs/apk

    # 配置 Android NDK 工具链环境变量
    # 检测系统架构（darwin-x86_64 或 darwin-arm64）
    NDK_PREBUILT_DIR=""
    if [[ -d "$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64" ]]; then
        NDK_PREBUILT_DIR="$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64"
    elif [[ -d "$NDK_HOME/toolchains/llvm/prebuilt/darwin-arm64" ]]; then
        NDK_PREBUILT_DIR="$NDK_HOME/toolchains/llvm/prebuilt/darwin-arm64"
    else
        die "无法找到 NDK 预构建工具链目录"
    fi

    # 设置 Cargo 使用的 Android 工具链
    export CC_aarch64_linux_android="$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang"
    export CXX_aarch64_linux_android="$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang++"
    export AR_aarch64_linux_android="$NDK_PREBUILT_DIR/bin/llvm-ar"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang"
    
    # 配置 src-tauri/.cargo/config.toml 中的 Android 链接器
    # 确保 Cargo 使用正确的链接器
    CARGO_CONFIG_FILE="$REPO_ROOT/src-tauri/.cargo/config.toml"
    if ! grep -q "\[target.aarch64-linux-android\]" "$CARGO_CONFIG_FILE" 2>/dev/null; then
        say "更新 Cargo 配置文件以包含 Android NDK 链接器配置..."
        cat >> "$CARGO_CONFIG_FILE" <<EOF

# Android NDK 配置（由 build_android.sh 自动添加）
[target.aarch64-linux-android]
linker = "$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang"
ar = "$NDK_PREBUILT_DIR/bin/llvm-ar"
EOF
    else
        # 如果配置已存在，更新链接器路径
        say "更新 Android NDK 链接器路径..."
        if [[ "$(uname)" == "Darwin" ]]; then
            if [[ "$(uname -m)" == "arm64" ]]; then
                sed -i '' "s|linker = \".*aarch64-linux-android.*\"|linker = \"$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang\"|" "$CARGO_CONFIG_FILE"
                sed -i '' "s|ar = \".*llvm-ar\"|ar = \"$NDK_PREBUILT_DIR/bin/llvm-ar\"|" "$CARGO_CONFIG_FILE"
            else
                sed -i '' "s|linker = \".*aarch64-linux-android.*\"|linker = \"$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang\"|" "$CARGO_CONFIG_FILE"
                sed -i '' "s|ar = \".*llvm-ar\"|ar = \"$NDK_PREBUILT_DIR/bin/llvm-ar\"|" "$CARGO_CONFIG_FILE"
            fi
        else
            sed -i "s|linker = \".*aarch64-linux-android.*\"|linker = \"$NDK_PREBUILT_DIR/bin/aarch64-linux-android21-clang\"|" "$CARGO_CONFIG_FILE"
            sed -i "s|ar = \".*llvm-ar\"|ar = \"$NDK_PREBUILT_DIR/bin/llvm-ar\"|" "$CARGO_CONFIG_FILE"
        fi
    fi
    
    say "配置 Android NDK 工具链:"
    say "  CC: $CC_aarch64_linux_android"
    say "  AR: $AR_aarch64_linux_android"
    say "  Linker: $CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"

    # 设置内部版本号（versionCode）
    say "设置内部版本号..."
    BUILD_NUMBER=$(grep "BUILD_NUMBER:" "$REPO_ROOT/src/version.ts" | sed "s/.*BUILD_NUMBER: '\([^']*\)'.*/\1/")
    if [[ -z "$BUILD_NUMBER" ]]; then
        warn "无法获取内部版本号，使用默认值 1"
        BUILD_NUMBER="1"
    fi
    if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
        warn "内部版本号不是纯数字，重置为 1"
        BUILD_NUMBER="1"
    fi
    say "✓ 内部版本号: $BUILD_NUMBER"

    apply_android_version_code "$BUILD_NUMBER"
    
    # 导出环境变量供Tauri使用
    export TAURI_ANDROID_VERSION_CODE="$BUILD_NUMBER"

    # 使用 Tauri CLI 进行标准构建（默认 release）
    npx @tauri-apps/cli android build --target aarch64 || die "Android 构建失败"

    # 可选：构建一个可调试的发布变体，便于用 Chrome Inspect 调试发布白屏
    if [[ -n "${ANDROID_DEBUGGABLE_RELEASE:-}" ]]; then
        say "构建可调试的发布变体（arm64ReleaseDebuggable）..."
        ( \
          cd src-tauri/gen/android && \
          chmod +x ./gradlew && \
          ./gradlew :app:assembleArm64ReleaseDebuggable \
        ) || die "构建 arm64ReleaseDebuggable 失败"
        say "✓ 构建 arm64ReleaseDebuggable 完成"
    fi

    say "✓ Android APK 构建完成"
else
    warn "跳过 Android 编译（SKIP_ANDROID_BUILD=true）"
fi

# ============================================================================
# 5. 定位未签名的 APK
# ============================================================================
say "定位构建产物..."

UNSIGNED_APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"

# 如果启用了 ANDROID_DEBUGGABLE_RELEASE，尝试优先匹配可调试发布包
if [[ -n "${ANDROID_DEBUGGABLE_RELEASE:-}" ]]; then
    if [[ -f "src-tauri/gen/android/app/build/outputs/apk/arm64/releaseDebuggable/app-arm64-releaseDebuggable-unsigned.apk" ]]; then
        UNSIGNED_APK="src-tauri/gen/android/app/build/outputs/apk/arm64/releaseDebuggable/app-arm64-releaseDebuggable-unsigned.apk"
    fi
fi

if [[ ! -f "$UNSIGNED_APK" ]]; then
    # 尝试查找其他可能的路径
    warn "未在默认路径找到 APK，尝试搜索..."
    if [[ -n "${ANDROID_DEBUGGABLE_RELEASE:-}" ]]; then
        FOUND_APKS=($(find src-tauri/gen/android -type f -name "*releaseDebuggable*-unsigned.apk" 2>/dev/null || true))
    fi
    if [[ ${#FOUND_APKS[@]} -eq 0 ]]; then
        FOUND_APKS=($(find src-tauri/gen/android -name "*-unsigned.apk" -type f 2>/dev/null || true))
    fi
    
    if [[ ${#FOUND_APKS[@]} -eq 0 ]]; then
        die "未找到未签名的 APK 文件"
    fi
    
    UNSIGNED_APK="${FOUND_APKS[0]}"
    warn "使用找到的 APK: $UNSIGNED_APK"
fi

say "✓ 找到未签名 APK: $UNSIGNED_APK"

# ============================================================================
# 6. APK 签名
# ============================================================================
say "开始 APK 签名..."

# 准备输出路径
OUTPUT_DIR="$(dirname "$UNSIGNED_APK")"
SIGNED_APK="$OUTPUT_DIR/app-universal-release-signed.apk"
ALIGNED_APK="$OUTPUT_DIR/app-universal-release-aligned.apk"
SOURCE_APK_FOR_SIGNING="$UNSIGNED_APK"

rm -f "$SIGNED_APK" "$ALIGNED_APK"

if [[ -n "$ZIPALIGN_CMD" ]]; then
  say "对齐 APK..."
  "$ZIPALIGN_CMD" -v 4 "$UNSIGNED_APK" "$ALIGNED_APK" || die "APK 对齐失败"
  SOURCE_APK_FOR_SIGNING="$ALIGNED_APK"
  say "✓ APK 对齐完成"
else
  warn "未找到 zipalign 工具，跳过对齐步骤"
fi

say "开始 APK 签名..."

if [[ -n "$APKSIGNER_CMD" ]]; then
  say "使用 apksigner 生成 V2/V3 签名..."
  "$APKSIGNER_CMD" sign \
    --ks "$KEYSTORE_PATH" \
    --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "pass:$ANDROID_KEYSTORE_PASSWORD" \
    --key-pass "pass:$ANDROID_KEY_PASSWORD" \
    --in "$SOURCE_APK_FOR_SIGNING" \
    --out "$SIGNED_APK" || die "apksigner 签名失败"
else
  say "未找到 apksigner，回退到 jarsigner (V1)"
  "$jarsigner_cmd" \
    -verbose \
    -sigalg SHA256withRSA \
    -digestalg SHA-256 \
    -keystore "$KEYSTORE_PATH" \
    -storepass "$ANDROID_KEYSTORE_PASSWORD" \
    -keypass "$ANDROID_KEY_PASSWORD" \
    -signedjar "$SIGNED_APK" \
    "$SOURCE_APK_FOR_SIGNING" \
    "$KEY_ALIAS" || die "APK 签名失败"
fi

say "✓ APK 签名完成"

FINAL_APK="$SIGNED_APK"

if [[ -n "$APKSIGNER_CMD" ]]; then
  say "验证 APK 签名 (apksigner)..."
  "$APKSIGNER_CMD" verify --print-certs "$FINAL_APK" || die "APK V2/V3 签名验证失败"
  say "✓ APK V2/V3 签名验证通过"
else
  say "验证 APK 签名 (jarsigner V1)..."
  "$jarsigner_cmd" -verify -verbose -certs "$FINAL_APK" || die "APK 签名验证失败"
  say "✓ APK V1 签名验证通过（未检测 V2/V3，请确保目标设备接受 V1 签名）"
fi

# ============================================================================
# 7. APK 对齐（使用 zipalign）
# ============================================================================
# say "对齐 APK..."

# 查找 zipalign 工具
# if [[ -n "$ZIPALIGN_CMD" ]]; then
#     "$ZIPALIGN_CMD" -v 4 "$SIGNED_APK" "$ALIGNED_APK" || die "APK 对齐失败"
    
#     # 使用对齐后的版本
#     FINAL_APK="$ALIGNED_APK"
#     say "✓ APK 对齐完成"
# else
#     warn "未找到 zipalign 工具，跳过对齐步骤"
#     FINAL_APK="$SIGNED_APK"
# fi

# ============================================================================
# 8. 验证签名
# ============================================================================
# if [[ -n "$APKSIGNER_CMD" ]]; then
#     say "验证 APK 签名 (apksigner)..."
#     "$APKSIGNER_CMD" verify --print-certs "$FINAL_APK" || die "APK V2/V3 签名验证失败"
#     say "✓ APK V2/V3 签名验证通过"
# else
#     say "验证 APK 签名 (jarsigner V1)..."
#     "$jarsigner_cmd" -verify -verbose -certs "$FINAL_APK" || die "APK 签名验证失败"
#     say "✓ APK V1 签名验证通过（未检测 V2/V3，请确保目标设备接受 V1 签名）"
# fi

# FINAL_APK="$SIGNED_APK"

# ============================================================================
# 9. 生成最终文件
# ============================================================================
say "生成最终发布文件..."

# 创建带版本号的最终文件名
VERSION=$(grep '"version":' package.json | head -n 1 | cut -d'"' -f4)
FINAL_OUTPUT_DIR="$REPO_ROOT/build-android"
mkdir -p "$FINAL_OUTPUT_DIR"

# 根据构建模式确定文件名后缀
case "$BUILD_MODE" in
    "release")
        BUILD_SUFFIX="release"
        BUILD_TYPE_DESC="🚀 正式发布版"
        ;;
    "dev-same-pkg")
        BUILD_SUFFIX="dev"
        BUILD_TYPE_DESC="🔧 测试版（同包名）"
        ;;
    "dev-diff-pkg")
        BUILD_SUFFIX="dev-isolated"
        BUILD_TYPE_DESC="🧪 测试版（不同包名）"
        ;;
    *)
        BUILD_SUFFIX="release"
        BUILD_TYPE_DESC="标准构建"
        ;;
esac

FINAL_APK_NAME="DeepStudent-v${VERSION}-arm64-${BUILD_SUFFIX}.apk"
FINAL_APK_PATH="$FINAL_OUTPUT_DIR/$FINAL_APK_NAME"

cp "$FINAL_APK" "$FINAL_APK_PATH"

# 同时复制 AAB 文件（如果存在）
AAB_PATH="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
if [[ -f "$AAB_PATH" ]]; then
    FINAL_AAB_NAME="DeepStudent-v${VERSION}-arm64-release.aab"
    FINAL_AAB_PATH="$FINAL_OUTPUT_DIR/$FINAL_AAB_NAME"
    cp "$AAB_PATH" "$FINAL_AAB_PATH"
    say "✓ AAB 文件已复制: $FINAL_AAB_PATH"
fi

# ============================================================================
# 10. 生成文件信息
# ============================================================================
say "生成文件信息..."

APK_SIZE=$(du -h "$FINAL_APK_PATH" | cut -f1)
APK_SHA256=$(shasum -a 256 "$FINAL_APK_PATH" | cut -d' ' -f1)

# 确定包名显示
if [[ "$USE_DEV_PACKAGE" == true && -n "$ORIGINAL_IDENTIFIER" ]]; then
    DISPLAY_IDENTIFIER="${ORIGINAL_IDENTIFIER}.dev"
else
    DISPLAY_IDENTIFIER=$(grep '"identifier":' "$TAURI_CONF" | head -n 1 | sed 's/.*"identifier": *"\([^"]*\)".*/\1/')
fi

INFO_FILE="$FINAL_OUTPUT_DIR/build-info.txt"
cat > "$INFO_FILE" <<EOF
Deep Student Android 构建信息
================================

构建模式: $BUILD_TYPE_DESC
版本: $VERSION
包名: $DISPLAY_IDENTIFIER
构建时间: $(date '+%Y-%m-%d %H:%M:%S')
架构: ARM64 (aarch64)

APK 文件:
  路径: $FINAL_APK_PATH
  大小: $APK_SIZE
  SHA256: $APK_SHA256

密钥库信息:
  路径: $KEYSTORE_PATH
  别名: $KEY_ALIAS
  类型: $(if [[ "$DEBUG_MODE" == true ]]; then echo "开发密钥库"; else echo "正式密钥库"; fi)

构建特性:
  - SQLite (bundled)
  - LanceDB 向量存储
  - 所有 Mac 版功能
  
安装说明:
  1. 在 Android 设备上启用"未知来源"安装
  2. 传输 APK 到设备
  3. 点击安装
  
或使用 ADB 安装:
  adb install "$FINAL_APK_NAME"

上传 Google Play:
  使用 AAB 文件: $(basename "$FINAL_AAB_PATH" 2>/dev/null || echo "未生成")
EOF

say "✓ 构建信息已保存: $INFO_FILE"

# ============================================================================
# 完成
# ============================================================================
say ""
say "=========================================="
say "✨ Android APK 构建和签名完成！"
say "=========================================="
say ""
say "🎯 构建模式: $BUILD_TYPE_DESC"
say "📦 最终产物:"
say "   APK: $FINAL_APK_PATH"
say "   包名: $DISPLAY_IDENTIFIER"
say "   大小: $APK_SIZE"
if [[ -f "$FINAL_AAB_PATH" ]]; then
    say "   AAB: $FINAL_AAB_PATH"
fi
say ""
say "📄 构建信息: $INFO_FILE"
say ""
say "🚀 可以使用以下命令安装到设备:"
say "   adb install \"$FINAL_APK_PATH\""
say ""
if [[ "$DEBUG_MODE" == true ]]; then
    say "🔧 调试模式: 使用开发密钥库，密码为 'android'"
else
    say "💡 提示: 密钥库已保存在 $KEYSTORE_PATH"
    say "   请妥善保管密钥库和密码，用于后续更新签名"
fi
if [[ "$USE_DEV_PACKAGE" == true ]]; then
    say ""
    say "🧪 测试版说明: 此 APK 使用不同包名，可与正式版同时安装"
fi
say ""
