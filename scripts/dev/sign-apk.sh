#!/bin/bash
# 快速对已有 APK 进行签名（使用开发密钥库）
# 用法: bash scripts/dev/sign-apk.sh <apk_path> [--release]
#
# 默认使用开发密钥库（密码 android）
# 传入 --release 使用正式密钥库

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── 颜色 ──
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
RESET='\033[0m'

say()  { echo -e "${GREEN}==>${RESET} $*"; }
warn() { echo -e "${YELLOW}[warn]${RESET} $*"; }
die()  { echo -e "${RED}[error]${RESET} $*" >&2; exit 1; }
info() { echo -e "${CYAN}[info]${RESET} $*"; }

# ── 参数解析 ──
APK_PATH=""
USE_RELEASE=false

for arg in "$@"; do
    case "$arg" in
        --release) USE_RELEASE=true ;;
        -h|--help)
            echo "用法: $0 <apk_path> [--release]"
            echo ""
            echo "参数:"
            echo "  apk_path    要签名的 APK 文件路径"
            echo "  --release   使用正式密钥库（默认使用开发密钥库）"
            exit 0
            ;;
        *)
            if [[ -z "$APK_PATH" ]]; then
                APK_PATH="$arg"
            fi
            ;;
    esac
done

[[ -z "$APK_PATH" ]] && die "请指定 APK 文件路径。用法: $0 <apk_path> [--release]"
[[ -f "$APK_PATH" ]] || die "APK 文件不存在: $APK_PATH"

# ── 环境 ──
if [[ -z "${ANDROID_HOME:-}" ]]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
        [[ -d "$candidate" ]] && export ANDROID_HOME="$candidate" && break
    done
fi

command -v jarsigner >/dev/null 2>&1 || die "缺少 jarsigner，请确保 JDK 已安装"

find_build_tool() {
    local cmd="$1"
    if command -v "$cmd" >/dev/null 2>&1; then
        command -v "$cmd"
        return 0
    fi
    if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME/build-tools" ]]; then
        local found
        found=$(find "$ANDROID_HOME/build-tools" -name "$cmd" -type f 2>/dev/null | sort -V | tail -n 1)
        if [[ -n "$found" && -x "$found" ]]; then
            echo "$found"
            return 0
        fi
    fi
    return 1
}

APKSIGNER_CMD="$(find_build_tool apksigner)" || true
ZIPALIGN_CMD="$(find_build_tool zipalign)" || true

# ── 密钥库配置 ──
if [[ "$USE_RELEASE" == true ]]; then
    say "使用正式密钥库"
    KEYSTORE_PATH="${ANDROID_KEYSTORE_PATH:-$HOME/.android/release.keystore}"
    KEY_ALIAS="${ANDROID_KEY_ALIAS:-deepstudent}"

    [[ -f "$KEYSTORE_PATH" ]] || die "正式密钥库不存在: $KEYSTORE_PATH"

    if [[ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]]; then
        read -rsp "请输入密钥库密码: " ANDROID_KEYSTORE_PASSWORD
        echo
    fi
    ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
else
    say "使用开发密钥库"
    KEYSTORE_PATH="$REPO_ROOT/build-android/dev-release.keystore"
    KEY_ALIAS="deepstudent-debug"
    ANDROID_KEYSTORE_PASSWORD="android"
    ANDROID_KEY_PASSWORD="android"

    if [[ ! -f "$KEYSTORE_PATH" ]]; then
        say "开发密钥库不存在，正在创建..."
        mkdir -p "$(dirname "$KEYSTORE_PATH")"
        keytool -genkeypair -v \
            -keystore "$KEYSTORE_PATH" \
            -alias "$KEY_ALIAS" \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -storepass "$ANDROID_KEYSTORE_PASSWORD" \
            -keypass "$ANDROID_KEY_PASSWORD" \
            -dname "CN=Deep Student Debug, OU=Development, O=Deep Student, L=Beijing, ST=Beijing, C=CN"
        say "✓ 开发密钥库已创建"
    fi
fi

# ── 准备输出路径 ──
APK_DIR="$(dirname "$APK_PATH")"
APK_BASE="$(basename "$APK_PATH" .apk)"
ALIGNED_APK="$APK_DIR/${APK_BASE}-aligned.apk"
SIGNED_APK="$APK_DIR/${APK_BASE}-signed.apk"

rm -f "$ALIGNED_APK" "$SIGNED_APK"

# ── zipalign ──
SOURCE_APK="$APK_PATH"
if [[ -n "$ZIPALIGN_CMD" ]]; then
    say "对齐 APK..."
    "$ZIPALIGN_CMD" -v 4 "$APK_PATH" "$ALIGNED_APK" >/dev/null
    SOURCE_APK="$ALIGNED_APK"
    say "✓ 对齐完成"
else
    warn "未找到 zipalign，跳过对齐"
fi

# ── 签名 ──
say "签名 APK..."
if [[ -n "$APKSIGNER_CMD" ]]; then
    "$APKSIGNER_CMD" sign \
        --ks "$KEYSTORE_PATH" \
        --ks-key-alias "$KEY_ALIAS" \
        --ks-pass "pass:$ANDROID_KEYSTORE_PASSWORD" \
        --key-pass "pass:$ANDROID_KEY_PASSWORD" \
        --in "$SOURCE_APK" \
        --out "$SIGNED_APK"
    say "✓ apksigner V2/V3 签名完成"
else
    jarsigner \
        -verbose \
        -sigalg SHA256withRSA \
        -digestalg SHA-256 \
        -keystore "$KEYSTORE_PATH" \
        -storepass "$ANDROID_KEYSTORE_PASSWORD" \
        -keypass "$ANDROID_KEY_PASSWORD" \
        -signedjar "$SIGNED_APK" \
        "$SOURCE_APK" \
        "$KEY_ALIAS"
    say "✓ jarsigner V1 签名完成"
fi

# ── 验证 ──
say "验证签名..."
if [[ -n "$APKSIGNER_CMD" ]]; then
    "$APKSIGNER_CMD" verify --print-certs "$SIGNED_APK" || die "签名验证失败"
    say "✓ 签名验证通过"
else
    jarsigner -verify "$SIGNED_APK" >/dev/null || die "签名验证失败"
    say "✓ 签名验证通过 (V1)"
fi

# ── 清理临时文件 ──
rm -f "$ALIGNED_APK"

# ── 结果 ──
SIGNED_SIZE=$(du -h "$SIGNED_APK" | cut -f1)
echo ""
say "=========================================="
say "✨ APK 签名完成！"
say "=========================================="
say "  输入: $APK_PATH"
say "  输出: $SIGNED_APK"
say "  大小: $SIGNED_SIZE"
say "  密钥: $(if [[ "$USE_RELEASE" == true ]]; then echo '正式密钥库'; else echo '开发密钥库'; fi)"
echo ""
say "安装到设备: adb install \"$SIGNED_APK\""
