#!/usr/bin/env bash
#
# Unbundle the wayland client libraries from the Linux AppImage.
#
# Why (issue #481): Tauri's AppImage bundler runs linuxdeploy, which copies the
# build distro's (Ubuntu 22.04) `libwayland-*.so*` into `$APPDIR/usr/lib` next to
# the bundled WebKitGTK. The generated `AppRun` puts `$APPDIR/usr/lib` on
# `LD_LIBRARY_PATH`, so the loader also applies it to libraries the app dlopens
# later -- including the HOST's GPU/display stack (libEGL, libGL, libgbm and the
# DRI drivers are deliberately not bundled).
#
# On a host whose Mesa is newer than Ubuntu 22.04's wayland 1.20, `libEGL_mesa`
# then resolves against the bundled wayland and fails to load:
#
#   /usr/lib/libEGL_mesa.so.0: undefined symbol: wl_fixes_interface
#
# (`wl_fixes_interface` was added in wayland 1.23.) `eglGetDisplay` returns no
# display, `WebKitWebProcess` aborts and the window never paints:
#
#   Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
#
# NVIDIA's proprietary EGL does not link libwayland-client, which is why this
# looked like an "AMD/Intel only" bug. Every Mesa driver hits it, on X11 too.
#
# libwayland-* belongs to the host display stack for the same reason libEGL and
# libgbm do: it talks to the host compositor and is loaded by the host's
# drivers, so a copy pinned to the build distro can only go stale. Removing the
# bundled copies lets the loader pick the host's; the bundled GTK/WebKit link
# them by SONAME and wayland has not broken that ABI.
#
# This runs AFTER `tauri bundle --bundles appimage` produced (and signed) the
# AppImage. Repacking changes the bytes in place, so the Tauri updater signature
# no longer matches -- callers must delete `$appimage.sig` and re-run
# `tauri signer sign "$appimage"` afterwards (reusable-build-linux.yml does).
#
# Repacking keeps the ORIGINAL AppImage runtime bytes (everything before the
# squashfs offset) and the original squashfs compression/block size, so nothing
# is downloaded and the image keeps its shape. It requires squashfs-tools.
#
# Usage: scripts/ci/patch-appimage-wayland.sh <path/to/App.AppImage>
#
# Exit codes: 0 = image is (now) free of bundled libwayland-*; 1 = failure.
set -euo pipefail

appimage=${1:-}
if [[ -z $appimage ]]; then
  echo "usage: $0 <path/to/App.AppImage>" >&2
  exit 2
fi
if [[ ! -f $appimage ]]; then
  echo "error: no such file: $appimage" >&2
  exit 1
fi
appimage=$(readlink -f "$appimage")

for tool in mksquashfs unsquashfs; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found. Install squashfs-tools." >&2
    exit 1
  fi
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

chmod +x "$appimage"

# The squashfs image starts where the runtime ends, so the offset IS the size of
# the runtime bytes we keep verbatim. Both --appimage-offset and
# --appimage-extract are handled by the AppImage runtime before mounting, so
# neither needs FUSE (GitHub runners do not ship libfuse2).
offset=$("$appimage" --appimage-offset)
case "$offset" in
  '' | *[!0-9]*)
    echo "error: --appimage-offset returned '$offset', which is not a byte count." >&2
    exit 1
    ;;
esac
if (( offset <= 0 )); then
  echo "error: --appimage-offset returned $offset." >&2
  exit 1
fi

# Match the original image's compression so the patched AppImage keeps the same
# shape and size class as the one linuxdeploy produced.
superblock=$(unsquashfs -o "$offset" -s "$appimage")
comp=$(printf '%s\n' "$superblock" | awk '/^Compression/ { print $2; exit }')
block=$(printf '%s\n' "$superblock" | awk '/^Block size/ { print $3; exit }')
if [[ -z $comp || -z $block ]]; then
  echo "error: could not read the squashfs superblock:" >&2
  printf '%s\n' "$superblock" >&2
  exit 1
fi
echo "AppImage runtime=${offset}B compression=${comp} block=${block}"

# `--appimage-extract` does not restore extended attributes. linuxdeploy AppDirs
# are plain copied files with no xattrs, so this should never fire -- but a
# repack that silently dropped file capabilities/SELinux labels would be worse
# than no repack at all, so stop instead.
xattr_line=$(printf '%s\n' "$superblock" | grep -i 'xattr' || true)
[[ -n $xattr_line ]] && echo "superblock xattrs: $xattr_line"
if printf '%s\n' "$xattr_line" | grep -qiE 'xattrs are (present|stored)'; then
  echo "error: this AppImage stores xattrs, which --appimage-extract cannot restore." >&2
  echo "Repacking would silently drop them. Handle that before releasing." >&2
  exit 1
fi

head -c "$offset" "$appimage" >"$work/runtime"
runtime_size=$(stat -c %s "$work/runtime")
if [[ $runtime_size != "$offset" ]]; then
  echo "error: kept $runtime_size runtime bytes, wanted $offset." >&2
  exit 1
fi

mkdir -p "$work/extract"
(cd "$work/extract" && "$appimage" --appimage-extract >/dev/null)
appdir=$work/extract/squashfs-root
if [[ ! -d $appdir ]]; then
  echo "error: --appimage-extract produced no squashfs-root." >&2
  exit 1
fi
if [[ ! -x $appdir/AppRun ]]; then
  echo "error: AppRun is missing or not executable in the extracted AppImage." >&2
  exit 1
fi

# Symlinks count: today linuxdeploy copies these as plain files, but it emits
# `.so` symlinks elsewhere in the same AppDir. Removing only `-type f` could
# leave a SONAME link behind and still pass the survivor check below.
mapfile -t wayland_libs < <(find "$appdir" \( -type f -o -type l \) -name 'libwayland-*.so*' | sort)
if (( ${#wayland_libs[@]} == 0 )); then
  # Nothing bundled means the host's libraries are already in charge. Leave the
  # AppImage (and therefore its updater signature) untouched.
  echo "note: no bundled libwayland-* found in $appimage; nothing to unbundle."
  exit 0
fi
for lib in "${wayland_libs[@]}"; do
  echo "unbundling ${lib#"$appdir"/}"
  rm -f "$lib"
done

mksquashfs "$appdir" "$work/image.squashfs" \
  -root-owned -noappend -no-progress -mkfs-time 0 \
  -comp "$comp" -b "$block" >/dev/null

cat "$work/runtime" "$work/image.squashfs" >"$work/patched.AppImage"
chmod +x "$work/patched.AppImage"

# Prove the round trip BEFORE overwriting the release artifact: a repack that
# quietly dropped files (or failed to remove the libraries) must fail the build
# instead of shipping an AppImage that still opens a blank window on Mesa.
mkdir -p "$work/verify"
(cd "$work/verify" && "$work/patched.AppImage" --appimage-extract >/dev/null)
repacked=$work/verify/squashfs-root
if [[ ! -x $repacked/AppRun ]]; then
  echo "error: AppRun is missing or not executable after the repack." >&2
  exit 1
fi
mapfile -t survivors < <(find "$repacked" \( -type f -o -type l \) -name 'libwayland-*.so*' | sort)
if (( ${#survivors[@]} > 0 )); then
  echo "error: bundled wayland libraries survived the repack:" >&2
  printf '  %s\n' "${survivors[@]}" >&2
  echo "Shipping them breaks EGL on every Mesa driver; see issue #481." >&2
  exit 1
fi
# Counted on the ALREADY-MODIFIED appdir, so the removals above are expected on
# both sides and this only catches files the repack itself lost.
before=$(find "$appdir" | wc -l)
after=$(find "$repacked" | wc -l)
if [[ $before != "$after" ]]; then
  echo "error: the repack changed the file count ($before -> $after)." >&2
  exit 1
fi

mv -f "$work/patched.AppImage" "$appimage"
chmod +x "$appimage"
echo "patched $appimage ($after entries; ${#wayland_libs[@]} wayland libs unbundled)"
