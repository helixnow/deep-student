/* WP-081 Linux measurement-only LD_PRELOAD probe. No SQLite settings change.
 * cc -shared -fPIC -O2 ... -o /tmp/opencode/wp081-io.so -ldl
 * WP081_IO_LOG=/tmp/opencode/... LD_PRELOAD=... node ...
 * CLOCK_MONOTONIC is the same clock as Node process.hrtime. errno/result pass
 * through unchanged. Each record is written AFTER the measured real syscall.
 * This measures selected native I/O calls, not all kernel time or device latency.
 */
#define _GNU_SOURCE
#define _LARGEFILE64_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>

static int output = -1;
static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static ssize_t (*real_pread64)(int, void *, size_t, off64_t);
static ssize_t (*real_pwrite64)(int, const void *, size_t, off64_t);
static double monotonic_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}
__attribute__((constructor)) static void init(void) {
  real_fsync = dlsym(RTLD_NEXT, "fsync");
  real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  real_pread64 = dlsym(RTLD_NEXT, "pread64");
  real_pwrite64 = dlsym(RTLD_NEXT, "pwrite64");
  const char *file = getenv("WP081_IO_LOG");
  if (file) output = open(file, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
}
static void record(const char *op, int fd, double start, double end, ssize_t result) {
  int saved = errno;
  if (output >= 0) {
    char link[64], file[4096], line[4608];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, file, sizeof(file) - 1);
    if (n < 0) n = 0;
    file[n] = 0;
    int size = snprintf(line, sizeof(line), "%d\t%ld\t%s\t%.6f\t%.6f\t%zd\t%s\n",
      getpid(), syscall(SYS_gettid), op, start, end - start, result, file);
    if (size > 0 && size < (int)sizeof(line)) {
      ssize_t written = write(output, line, (size_t)size);
      if (written != size) _exit(90); /* Incomplete evidence must not look valid. */
    }
  }
  errno = saved;
}
int fsync(int fd) {
  double start = monotonic_ms(); int result = real_fsync(fd); double end = monotonic_ms();
  record("fsync", fd, start, end, result); return result;
}
int fdatasync(int fd) {
  double start = monotonic_ms(); int result = real_fdatasync(fd); double end = monotonic_ms();
  record("fdatasync", fd, start, end, result); return result;
}
ssize_t pread64(int fd, void *buffer, size_t count, off64_t offset) {
  double start = monotonic_ms(); ssize_t result = real_pread64(fd, buffer, count, offset); double end = monotonic_ms();
  record("pread64", fd, start, end, result); return result;
}
ssize_t pwrite64(int fd, const void *buffer, size_t count, off64_t offset) {
  double start = monotonic_ms(); ssize_t result = real_pwrite64(fd, buffer, count, offset); double end = monotonic_ms();
  record("pwrite64", fd, start, end, result); return result;
}
