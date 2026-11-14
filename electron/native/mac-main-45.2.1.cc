// Copyright (c) 2022 Slack Technologies, Inc.
// Based on Electron v45.2.1 shell/app/electron_main_mac.cc (non-HELPER)
// and shell/app/uv_stdio_fix.cc. Electron is MIT licensed; see LICENSE.electron.
// Keep this entry in sync with that exact version, not with helper startup.
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>
#include <sysexits.h>
#include <tuple>
#include <unistd.h>

extern "C" int ElectronMain(int argc, char* argv[]);
extern "C" int ElectronInitializeICUandStartNode(int argc, char* argv[]);
namespace electron::fuses {
bool IsRunAsNodeEnabled();
bool IsNodeOptionsEnabled();
}

static void FixStdioStreams() {
  struct stat st;
  if (fstat(STDIN_FILENO, &st) < 0 && errno == EBADF)
    std::ignore = freopen("/dev/null", "r", stdin);
  if (fstat(STDOUT_FILENO, &st) < 0 && errno == EBADF)
    std::ignore = freopen("/dev/null", "w", stdout);
  if (fstat(STDERR_FILENO, &st) < 0 && errno == EBADF)
    std::ignore = freopen("/dev/null", "w", stderr);
}

int main(int argc, char* argv[]) {
  FixStdioStreams();
  // Node initializes its disk cache before application JS. Keep the framework's
  // fuse decision, but extend the release policy to these cache inputs here.
  if (!electron::fuses::IsNodeOptionsEnabled()) {
    const bool directory = getenv("NODE_COMPILE_CACHE") != nullptr;
    const bool portable = getenv("NODE_COMPILE_CACHE_PORTABLE") != nullptr;
    if (unsetenv("NODE_COMPILE_CACHE") != 0 ||
        unsetenv("NODE_COMPILE_CACHE_PORTABLE") != 0) {
      perror("native cache environment removal failed");
      return EX_OSERR;
    }
    if (directory || portable) {
      fprintf(stdout, "[dstu-native-cache-v1] pid=%ld removed=%s%s%s\n",
              static_cast<long>(getpid()), directory ? "NODE_COMPILE_CACHE" : "",
              directory && portable ? "," : "",
              portable ? "NODE_COMPILE_CACHE_PORTABLE" : "");
      fflush(stdout);
    }
  }
  const char* run_as_node = getenv("ELECTRON_RUN_AS_NODE");
  if (electron::fuses::IsRunAsNodeEnabled() && run_as_node && *run_as_node)
    return ElectronInitializeICUandStartNode(argc, argv);
  return ElectronMain(argc, argv);
}
