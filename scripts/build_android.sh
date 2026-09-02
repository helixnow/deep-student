#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/android-ndk-tools.sh"

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
        inject_android_permissions
        inject_android_soft_input_mode
        sync_main_activity
        sync_apk_installer_files
        inject_apk_file_provider
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

inject_android_permissions() {
    local MANIFEST="$REPO_ROOT/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
    if [[ ! -f "$MANIFEST" ]]; then
        warn "AndroidManifest.xml not found; microphone permission injection skipped"
        return
    fi

    local PERMISSIONS=(
        "android.permission.RECORD_AUDIO"
        "android.permission.MODIFY_AUDIO_SETTINGS"
    )
    local changed=false

    for PERMISSION in "${PERMISSIONS[@]}"; do
        local PERM_LINE="<uses-permission android:name=\"$PERMISSION\" />"
        if grep -qF "$PERMISSION" "$MANIFEST" 2>/dev/null; then
            continue
        fi

        say "Injecting Android permission: $PERMISSION"
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "/<manifest/a\\
    $PERM_LINE" "$MANIFEST"
        else
            sed -i "/<manifest/a\\    $PERM_LINE" "$MANIFEST"
        fi
        changed=true
    done

    if [[ "$changed" == true ]]; then
        info "✓ Android microphone permissions injected"
    fi
}

# 同步受控 ApkInstallerPlugin.kt + FileProvider 路径配置（应用内 APK 更新安装）
# 到生成工程。与 MainActivity 同理：tauri android init 重新生成后裸模板不含
# 这些文件，缺失时 install_apk 命令会在运行期报"插件未初始化"。
sync_apk_installer_files() {
    local SRC_KT="$REPO_ROOT/src-tauri/mobile/android/ApkInstallerPlugin.kt"
    local DST_KT="$REPO_ROOT/src-tauri/gen/android/app/src/main/java/com/deepstudent/app/ApkInstallerPlugin.kt"
    local SRC_XML="$REPO_ROOT/src-tauri/mobile/android/res/xml/file_paths.xml"
    local DST_XML="$REPO_ROOT/src-tauri/gen/android/app/src/main/res/xml/file_paths.xml"

    if [[ ! -f "$SRC_KT" || ! -f "$SRC_XML" ]]; then
        warn "受控 APK 安装器文件不存在（$SRC_KT / $SRC_XML）；跳过同步"
        return
    fi
    if [[ ! -d "$(dirname "$DST_KT")" ]]; then
        warn "Android 工程 java 目录不存在; ApkInstallerPlugin 同步跳过"
        return
    fi
    if ! cmp -s "$SRC_KT" "$DST_KT" 2>/dev/null; then
        cp "$SRC_KT" "$DST_KT"
        info "✓ ApkInstallerPlugin.kt 已从受控副本同步"
    fi
    mkdir -p "$(dirname "$DST_XML")"
    if ! cmp -s "$SRC_XML" "$DST_XML" 2>/dev/null; then
        cp "$SRC_XML" "$DST_XML"
        info "✓ file_paths.xml 已从受控副本同步"
    fi
}

# 注入 FileProvider manifest 声明：应用内更新下载的 APK 以 content:// URI
# 授权给系统安装器读取（file:// 在 Android 7+ 会被拒绝）。幂等。
inject_apk_file_provider() {
    local MANIFEST="$REPO_ROOT/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
    if [[ ! -f "$MANIFEST" ]]; then
        warn "AndroidManifest.xml not found; FileProvider injection skipped"
        return
    fi
    if grep -qF 'androidx.core.content.FileProvider' "$MANIFEST" 2>/dev/null; then
        return
    fi

    # 注意：${applicationId} 是 manifest placeholder，由 gradle 构建时替换，
    # 必须防止 shell 展开，故用单引号。整段单行插入（BSD/GNU sed 对替换串中
    # \n 的解释不一致，单行写法两边行为一致；XML 不关心缩进）。
    local PROVIDER_LINE='<provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" /></provider>'

    say "Injecting FileProvider for APK installer"
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s|</application>|$PROVIDER_LINE</application>|" "$MANIFEST"
    else
        sed -i "s|</application>|$PROVIDER_LINE</application>|" "$MANIFEST"
    fi

    if grep -qF 'androidx.core.content.FileProvider' "$MANIFEST" 2>/dev/null; then
        info "✓ FileProvider injected"
    else
        warn "FileProvider injection failed"
    fi
}

# 同步受控 MainActivity.kt（含 A-5 返回键接管 + SA-1 真实安全区注入）到生成工程。
# tauri android init 会生成裸模板 MainActivity，缺失这两段逻辑会导致
# 返回手势直接退出 App、安全区退回猜测值。受控副本是单一事实源。
sync_main_activity() {
    local SRC="$REPO_ROOT/src-tauri/mobile/android/MainActivity.kt"
    local DST="$REPO_ROOT/src-tauri/gen/android/app/src/main/java/com/deepstudent/app/MainActivity.kt"
    if [[ ! -f "$SRC" ]]; then
        warn "受控 MainActivity.kt 不存在: $SRC"
        return
    fi
    if [[ ! -d "$(dirname "$DST")" ]]; then
        warn "Android 工程 java 目录不存在; MainActivity 同步跳过"
        return
    fi
    if ! cmp -s "$SRC" "$DST" 2>/dev/null; then
        cp "$SRC" "$DST"
        info "✓ MainActivity.kt 已从受控副本同步"
    fi
}

# 显式声明键盘 softInputMode（tauri android init 重新生成工程后仍能保住该配置）。
# adjustResize 是前端键盘适配（useKeyboardHeight/Dialog 键盘避让）依赖的确定性行为，
# 避免不同 ROM 对未声明时的默认策略（adjustUnspecified）各自为政。
inject_android_soft_input_mode() {
    local MANIFEST="$REPO_ROOT/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
    if [[ ! -f "$MANIFEST" ]]; then
        warn "AndroidManifest.xml not found; windowSoftInputMode injection skipped"
        return
    fi
    if grep -qF 'android:windowSoftInputMode' "$MANIFEST" 2>/dev/null; then
        return
    fi

    say "Injecting android:windowSoftInputMode=\"adjustResize\""
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' 's|android:launchMode="singleTask"|android:launchMode="singleTask" android:windowSoftInputMode="adjustResize"|' "$MANIFEST"
    else
        sed -i 's|android:launchMode="singleTask"|android:launchMode="singleTask" android:windowSoftInputMode="adjustResize"|' "$MANIFEST"
    fi

    if grep -qF 'android:windowSoftInputMode' "$MANIFEST" 2>/dev/null; then
        info "✓ windowSoftInputMode injected"
    else
        warn "windowSoftInputMode injection failed; please check $MANIFEST"
    fi
}

assert_android_permissions_in_apk() {
    local APK="$1"
    local REQUIRED_PERMISSIONS=(
        "android.permission.RECORD_AUDIO"
        "android.permission.MODIFY_AUDIO_SETTINGS"
    )
    local DUMP=""

    if [[ -n "$AAPT_CMD" ]]; then
        DUMP="$("$AAPT_CMD" dump permissions "$APK" 2>/dev/null || true)"
    fi

    if [[ -z "$DUMP" && -n "$AAPT2_CMD" ]]; then
        DUMP="$("$AAPT2_CMD" dump permissions "$APK" 2>/dev/null || true)"
    fi

    if [[ -z "$DUMP" ]]; then
        die "Unable to inspect APK permissions with aapt/aapt2"
    fi

    for PERMISSION in "${REQUIRED_PERMISSIONS[@]}"; do
        if ! grep -qF "$PERMISSION" <<<"$DUMP"; then
            error "APK is missing Android permission: $PERMISSION"
            echo "$DUMP" >&2
            die "Android APK permission verification failed"
        fi
    done

    info "✓ APK declares microphone permissions: ${REQUIRED_PERMISSIONS[*]}"
}

normalize_android_sdk_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    echo "$path"
    return 0
  fi
  if command -v cygpath >/dev/null 2>&1; then
    local converted
    converted="$(cygpath -u "$path" 2>/dev/null || true)"
    if [[ -n "$converted" && -d "$converted" ]]; then
      echo "$converted"
      return 0
    fi
  fi
  echo "$path"
}

# 确保脚本退出时恢复
trap 'restore_package_name' EXIT

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
  for ext in .exe .bat .cmd; do
    if command -v "${cmd}${ext}" >/dev/null 2>&1; then
      command -v "${cmd}${ext}"
      return 0
    fi
  done

  local search_dirs=()
  local android_home=""
  if [[ -n "${ANDROID_HOME:-}" ]]; then
    android_home="$(normalize_android_sdk_path "$ANDROID_HOME")"
  fi
  if [[ -n "$android_home" && -d "$android_home/build-tools" ]]; then
    if [[ -n "${ANDROID_BUILD_TOOLS_VERSION:-}" && -d "$android_home/build-tools/$ANDROID_BUILD_TOOLS_VERSION" ]]; then
      search_dirs+=("$android_home/build-tools/$ANDROID_BUILD_TOOLS_VERSION")
    fi
    while IFS= read -r dir; do
      search_dirs+=("$dir")
    done < <(find "$android_home/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V)
  fi

  for dir in "${search_dirs[@]}"; do
    for candidate in "$dir/$cmd" "$dir/$cmd.exe" "$dir/$cmd.bat" "$dir/$cmd.cmd"; do
      if [[ -x "$candidate" || -f "$candidate" ]]; then
        echo "$candidate"
        return 0
      fi
    done
  done

  return 1
}

require_cmd npm
require_cmd npx
require_cmd keytool

APKSIGNER_CMD="$(find_build_tools_cmd apksigner)" || true
ZIPALIGN_CMD="$(find_build_tools_cmd zipalign)" || true
AAPT_CMD="$(find_build_tools_cmd aapt)" || true
AAPT2_CMD="$(find_build_tools_cmd aapt2)" || true

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
        NDK_HOME=$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)
        export NDK_HOME
        say "自动检测到 NDK: $NDK_HOME"
    else
        die "未找到 NDK。请设置 NDK_HOME 或在 ANDROID_HOME 下安装 NDK"
    fi
fi
NDK_HOME="$(normalize_android_sdk_path "$NDK_HOME")"
export NDK_HOME
if [[ ! -d "$NDK_HOME" ]]; then
    die "NDK_HOME 路径不存在: $NDK_HOME"
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
    if [[ ! -f "$REPO_ROOT/public/app-icon.png" ]]; then
        warn "未找到 public/app-icon.png，将使用现有图标"
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
    inject_android_permissions
    inject_android_soft_input_mode
    sync_main_activity
    sync_apk_installer_files
    inject_apk_file_provider
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

    # 配置 Android NDK 工具链环境变量。宿主标签和 Windows 扩展名
    # 由独立 helper 解析，避免把开发机路径写回 Cargo 配置。
    NDK_PREBUILT_DIR="$(android_ndk_find_prebuilt "$NDK_HOME")" \
        || die "当前宿主不受支持，或 NDK 缺少匹配的预构建工具链: $(uname -s)/$(uname -m)"
    NDK_CC="$(android_ndk_find_tool "$NDK_PREBUILT_DIR" aarch64-linux-android21-clang)" \
        || die "缺少 NDK 工具: aarch64-linux-android21-clang"
    NDK_CXX="$(android_ndk_find_tool "$NDK_PREBUILT_DIR" aarch64-linux-android21-clang++)" \
        || die "缺少 NDK 工具: aarch64-linux-android21-clang++"
    NDK_AR="$(android_ndk_find_tool "$NDK_PREBUILT_DIR" llvm-ar)" \
        || die "缺少 NDK 工具: llvm-ar"

    # 设置 Cargo 使用的 Android 工具链
    export CC_aarch64_linux_android="$NDK_CC"
    export CXX_aarch64_linux_android="$NDK_CXX"
    export AR_aarch64_linux_android="$NDK_AR"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_CC"
    
    say "配置 Android NDK 工具链:"
    say "  CC: $CC_aarch64_linux_android"
    say "  AR: $AR_aarch64_linux_android"
    say "  Linker: $CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"

    # Android 商店发布号与内部 build number 分离，必须使用 tracked release code。
    say "设置 Android versionCode..."
    ANDROID_VERSION_CODE=$(node scripts/generate-version.mjs --print-android-version-code) \
        || die "无法获取 Android versionCode"
    if [[ ! "$ANDROID_VERSION_CODE" =~ ^[0-9]+$ ]]; then
        die "Android versionCode 不是纯数字: $ANDROID_VERSION_CODE"
    fi
    say "✓ Android versionCode: $ANDROID_VERSION_CODE"

    # 导出环境变量供Tauri使用
    export TAURI_ANDROID_VERSION_CODE="$ANDROID_VERSION_CODE"
    TAURI_ANDROID_CONFIG="{\"bundle\":{\"android\":{\"versionCode\":${ANDROID_VERSION_CODE}}}}"

    # 使用 Tauri CLI 进行标准构建（默认 release）
    npx @tauri-apps/cli android build --target aarch64 --config "$TAURI_ANDROID_CONFIG" \
        || die "Android 构建失败"

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

assert_android_permissions_in_apk "$FINAL_APK"

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
