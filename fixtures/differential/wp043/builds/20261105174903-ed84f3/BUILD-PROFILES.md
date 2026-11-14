# Instrumented compiler artifacts, not application coverage

Job `20261105174903-ed84f3` exited 101 before an application executable existed.
Its instrumented build scripts and proc macros produced **1283 profraw files**,
**407281200 bytes**. These do not establish command handler line coverage.

Original bytes remain locally in this X7 worktree:

- `fixtures/differential/wp043/build-profiles-preserved/`
- Lossless archive `fixtures/differential/wp043/builds/20261105174903-ed84f3/build-script-profraw.tar.gz`
  (**156158843 bytes**, archive job `20261105175854-592a68`, exit 0).

The archive's member paths start with `build-profiles/`. No raw profile content was
edited. The raw directory and archive are ignored runtime artifacts, not source to
auto-checkpoint. An earlier coordinator auto-checkpoint had staged 1254 of these
generated files; the final tree removes those Git entries while retaining the
original files and archive locally. No history rewrite is performed.

Actual A1/A2 application runs/profiles: **none**. LLVM22 report tools are missing.
