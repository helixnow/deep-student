#!/bin/bash
# 下载 pdfium 动态库用于 PDF 渲染与文本提取
#
# 使用方法: ./scripts/download-pdfium.sh [platform]
# platform: macos-x64, macos-arm64, windows-x64, linux-x64,
#           android-arm64, android-arm, android-x64, android-x86,
#           all, all-desktop, all-android (默认: 当前平台)

set -e

PDFIUM_VERSION="7350"  # 最新稳定版本
PDFIUM_BASE_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${PDFIUM_VERSION}"
OUTPUT_DIR="$(dirname "$0")/../src-tauri/resources/pdfium"
PDFIUM_BINARY_LICENSE="$OUTPUT_DIR/LICENSE.pdfium-binaries"
PDFIUM_LICENSES_DIR="$OUTPUT_DIR/licenses"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检测当前平台
detect_platform() {
    local os=$(uname -s)
    local arch=$(uname -m)
    
    case "$os" in
        Darwin)
            if [[ "$arch" == "arm64" ]]; then
                echo "macos-arm64"
            else
                echo "macos-x64"
            fi
            ;;
        Linux)
            echo "linux-x64"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "windows-x64"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# 下载并解压 pdfium
download_pdfium() {
    local platform=$1
    local url=""
    local archive_name=""
    local lib_name=""
    local extract_path=""
    
    case "$platform" in
        macos-x64)
            url="${PDFIUM_BASE_URL}/pdfium-mac-x64.tgz"
            archive_name="pdfium-mac-x64.tgz"
            lib_name="libpdfium.dylib"
            extract_path="lib/libpdfium.dylib"
            ;;
        macos-arm64)
            url="${PDFIUM_BASE_URL}/pdfium-mac-arm64.tgz"
            archive_name="pdfium-mac-arm64.tgz"
            lib_name="libpdfium.dylib"
            extract_path="lib/libpdfium.dylib"
            ;;
        windows-x64)
            url="${PDFIUM_BASE_URL}/pdfium-win-x64.tgz"
            archive_name="pdfium-win-x64.tgz"
            lib_name="pdfium.dll"
            extract_path="bin/pdfium.dll"
            ;;
        linux-x64)
            url="${PDFIUM_BASE_URL}/pdfium-linux-x64.tgz"
            archive_name="pdfium-linux-x64.tgz"
            lib_name="libpdfium.so"
            extract_path="lib/libpdfium.so"
            ;;
        android-arm64)
            url="${PDFIUM_BASE_URL}/pdfium-android-arm64.tgz"
            archive_name="pdfium-android-arm64.tgz"
            lib_name="libpdfium_android_arm64.so"
            extract_path="lib/libpdfium.so"
            ;;
        android-arm)
            url="${PDFIUM_BASE_URL}/pdfium-android-arm.tgz"
            archive_name="pdfium-android-arm.tgz"
            lib_name="libpdfium_android_arm.so"
            extract_path="lib/libpdfium.so"
            ;;
        android-x64)
            url="${PDFIUM_BASE_URL}/pdfium-android-x64.tgz"
            archive_name="pdfium-android-x64.tgz"
            lib_name="libpdfium_android_x64.so"
            extract_path="lib/libpdfium.so"
            ;;
        android-x86)
            url="${PDFIUM_BASE_URL}/pdfium-android-x86.tgz"
            archive_name="pdfium-android-x86.tgz"
            lib_name="libpdfium_android_x86.so"
            extract_path="lib/libpdfium.so"
            ;;
        *)
            log_error "不支持的平台: $platform"
            return 1
            ;;
    esac
    
    local output_file="${OUTPUT_DIR}/${lib_name}"
    
    # 二进制与其法律材料必须同时存在，避免发布包只携带动态库。
    if [[ -f "$output_file" && -f "$PDFIUM_BINARY_LICENSE" && -f "$PDFIUM_LICENSES_DIR/pdfium.txt" ]]; then
        log_warn "文件及许可证已存在: $output_file，跳过下载"
        return 0
    fi
    
    log_info "正在下载 pdfium for $platform..."
    log_info "URL: $url"
    
    # 创建临时目录
    local temp_dir=$(mktemp -d)
    local archive_path="${temp_dir}/${archive_name}"
    
    # 下载
    if command -v curl &> /dev/null; then
        curl -L -o "$archive_path" "$url"
    elif command -v wget &> /dev/null; then
        wget -O "$archive_path" "$url"
    else
        log_error "需要 curl 或 wget 来下载文件"
        rm -rf "$temp_dir"
        return 1
    fi
    
    # 解压
    log_info "正在解压..."
    mkdir -p "${temp_dir}/extracted"
    tar -xzf "$archive_path" -C "${temp_dir}/extracted"
    
    # 复制库文件
    mkdir -p "$OUTPUT_DIR"
    if [[ ! -f "$output_file" ]]; then
        cp "${temp_dir}/extracted/${extract_path}" "$output_file"
    else
        log_info "保留现有平台库，仅补齐许可证: $output_file"
    fi

    # 上游压缩包包含 PDFium 主许可证及其静态链接第三方组件的许可证。
    # 保留整套材料；只复制动态库会使二进制发行缺少必要通知。
    if [[ ! -f "${temp_dir}/extracted/LICENSE" || ! -d "${temp_dir}/extracted/licenses" ]]; then
        log_error "PDFium 压缩包缺少 LICENSE 或 licenses/"
        rm -rf "$temp_dir"
        return 1
    fi
    cp "${temp_dir}/extracted/LICENSE" "$PDFIUM_BINARY_LICENSE"
    rm -rf "$PDFIUM_LICENSES_DIR"
    mkdir -p "$PDFIUM_LICENSES_DIR"
    cp -R "${temp_dir}/extracted/licenses/." "$PDFIUM_LICENSES_DIR/"
    
    # 清理
    rm -rf "$temp_dir"
    
    log_info "✅ 已下载: $output_file ($(du -h "$output_file" | cut -f1))"
}

# 主函数
main() {
    local platform=${1:-$(detect_platform)}
    
    mkdir -p "$OUTPUT_DIR"
    
    if [[ "$platform" == "all" ]]; then
        log_info "下载所有平台的 pdfium 动态库..."
        download_pdfium "macos-x64"
        download_pdfium "macos-arm64"
        download_pdfium "windows-x64"
        download_pdfium "linux-x64"
        download_pdfium "android-arm64"
        download_pdfium "android-arm"
        download_pdfium "android-x64"
        download_pdfium "android-x86"
    elif [[ "$platform" == "all-desktop" ]]; then
        log_info "下载所有桌面平台的 pdfium 动态库..."
        download_pdfium "macos-x64"
        download_pdfium "macos-arm64"
        download_pdfium "windows-x64"
        download_pdfium "linux-x64"
    elif [[ "$platform" == "all-android" ]]; then
        log_info "下载所有 Android 平台的 pdfium 动态库..."
        download_pdfium "android-arm64"
        download_pdfium "android-arm"
        download_pdfium "android-x64"
        download_pdfium "android-x86"
    elif [[ "$platform" == "unknown" ]]; then
        log_error "无法检测当前平台，请手动指定: macos-x64, macos-arm64, windows-x64, linux-x64, android-arm64, android-arm, android-x64, android-x86"
        exit 1
    else
        download_pdfium "$platform"
    fi
    
    log_info "🎉 完成！pdfium 动态库已下载到 $OUTPUT_DIR"
}

main "$@"
