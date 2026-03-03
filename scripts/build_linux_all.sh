#!/usr/bin/env bash
set -euo pipefail

# 构建适用于linux平台的包


SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

say() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die() {
	echo -e "\033[1;31m[error]\033[0m $*" >&2
	exit 1
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

say "Checking build environment..."

require_cmd npm
require_cmd rustup
cd "$REPO_ROOT"

if ! command -v rustup >/dev/null 2>&1; then
	warn "rustup not found, using system cargo"
else
	say "Installing Linux Rust targets..."
	rustup target add x86_64-unknown-linux-gnu 2>/dev/null || true
	rustup target add aarch64-unknown-linux-gnu 2>/dev/null || true
fi

if [[ -z "${SKIP_FRONTEND_BUILD:-}" ]]; then
	say "Generating version info..."
	node scripts/generate-version.mjs || die "Version generation failed"

	say "Building frontend..."
	npm run build || die "Frontend build failed"
else
	warn "Skipping frontend build (SKIP_FRONTEND_BUILD=true)"
fi

say "Building Linux packages (deb, rpm, bin)..."

cd src-tauri

BUILD_DIR="$REPO_ROOT/build-linux"
mkdir -p "$BUILD_DIR"

for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
	arch_suffix=""
	if [[ "$target" == *"aarch64"* ]]; then
		arch_suffix="-arm64"
	fi

	say "Building for $target..."

	npm run tauri build -- --target "$target" --bundles deb,rpm,appimage || warn "build complete but with failed for $target"

	release_dir="target/$target/release/bundle"

	if [[ -d "$release_dir/deb" ]]; then
		cp "$release_dir/deb"/*.deb "$BUILD_DIR/" 2>/dev/null || true
	fi
	if [[ -d "$release_dir/rpm" ]]; then
		cp "$release_dir/rpm"/*.rpm "$BUILD_DIR/" 2>/dev/null || true
	fi
	if [[ -d "$release_dir/appimage" ]]; then
		cp "$release_dir/appimage"/*.AppImage "$BUILD_DIR/" 2>/dev/null || true
		cp "$release_dir/appimage"/*.AppImage.tar.gz "$BUILD_DIR/" 2>/dev/null || true
		cp "$release_dir/appimage"/*.AppImage.tar.gz.sig "$BUILD_DIR/" 2>/dev/null || true
	fi

	binary="target/$target/release/deep-student"
	if [[ -f "$binary" ]]; then
		cp "$binary" "$BUILD_DIR/deep-student${arch_suffix}" 2>/dev/null || true

		say "Creating tar.gz for $target..."
		tmp_dir="$BUILD_DIR/tmp-${target%%-*}"
		mkdir -p "$tmp_dir"
		cp "$binary" "$tmp_dir/deep-student"
		cp -r "$REPO_ROOT/src-tauri/resources" "$tmp_dir/" 2>/dev/null || true
		tar -czf "$BUILD_DIR/deep-student${arch_suffix}.tar.gz" -C "$tmp_dir" .
		rm -rf "$tmp_dir"
	fi
done

say "Build complete!"
say "Output directory: $BUILD_DIR"
echo ""
say "Build artifacts:"
ls -lh "$BUILD_DIR" 2>/dev/null || echo "(no artifacts found)"

say "Linux build done!"
