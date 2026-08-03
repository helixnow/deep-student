#!/usr/bin/env bash

# Print NDK host tags in preference order for the current shell host.
android_ndk_host_tags() {
  local host_os="${1:-$(uname -s)}"
  local host_arch="${2:-$(uname -m)}"

  case "$host_os" in
    Darwin)
      case "$host_arch" in
        arm64|aarch64) printf '%s\n' darwin-arm64 darwin-x86_64 ;;
        x86_64|amd64) printf '%s\n' darwin-x86_64 ;;
        *) return 1 ;;
      esac
      ;;
    Linux)
      case "$host_arch" in
        x86_64|amd64) printf '%s\n' linux-x86_64 ;;
        *) return 1 ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      printf '%s\n' windows-x86_64
      ;;
    *) return 1 ;;
  esac
}

android_ndk_find_prebuilt() {
  local ndk_home="$1"
  local host_os="${2:-$(uname -s)}"
  local host_arch="${3:-$(uname -m)}"
  local host_tag

  while IFS= read -r host_tag; do
    if [[ -d "$ndk_home/toolchains/llvm/prebuilt/$host_tag" ]]; then
      printf '%s\n' "$ndk_home/toolchains/llvm/prebuilt/$host_tag"
      return 0
    fi
  done < <(android_ndk_host_tags "$host_os" "$host_arch")
  return 1
}

android_ndk_find_tool() {
  local prebuilt_dir="$1"
  local tool="$2"
  local suffix candidate

  for suffix in '' .cmd .exe .bat; do
    candidate="$prebuilt_dir/bin/${tool}${suffix}"
    if [[ -x "$candidate" || ( -f "$candidate" && -n "$suffix" ) ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
