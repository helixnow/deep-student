/**
 * Shell snippet printing the shell's soft RLIMIT_NPROC (`unlimited` or a count). `ulimit -u` is a
 * bash/zsh spelling: Debian/Ubuntu `/bin/sh` is dash, which rejects it ("Illegal option -u") and
 * spells NPROC `-p` — bash's pipe-size flag — so Linux reads the kernel's own `/proc/self/limits`.
 */
export const linuxNprocProbe = (limitsFile = '/proc/self/limits') =>
  `while read -r a b soft rest; do if [ "$a $b" = 'Max processes' ]; then echo "$soft"; fi; done < ${limitsFile}`;

export const NPROC_PROBE = process.platform === 'linux' ? linuxNprocProbe() : 'ulimit -u';
