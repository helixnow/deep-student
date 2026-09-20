#!/usr/bin/env bash
# Install through dpkg, not a file snapshot that can omit .pc files/postinst state.
set -euo pipefail
sudo apt-get -o Acquire::Retries=3 update
sudo apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf protobuf-compiler clang lld xvfb xauth dbus-x11 "${@}"
pkg-config --print-errors --exists 'gdk-3.0 >= 3.22' webkit2gtk-4.1
