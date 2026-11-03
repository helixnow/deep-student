# Android preparation helper — closure (Task 3 / Task 5)

Status: generated, not executed by the author. The main agent owns self-check and execution.

## What it is

`docs/handwriting-annotation/tasks/closure-android-prepare.py` is a disposable local
reproducibility helper. It runs the checked-in CI preparation against the already
initialized local `src-tauri/gen/android` tree. It is **not** a new build system and
does not run `tauri android init`, build, test, install, adb, or download.

The recipe is read live from `.github/workflows/reusable-build-android.yml` on every
run. The helper fails if an expected step or marker is missing.

## Dependencies

- Python 3 with PyYAML (observed: Python 3.14.4, PyYAML 6.0.3).
- `bash` and `node` on PATH.
- `src-tauri/gen/android` already created by
  `npx tauri android init --ci --skip-targets-install`.
- `src-tauri/gen/android/app/src/main/jniLibs/x86_64/libpdfium.so` already installed
  and validated (observed ELF64 x86-64 Android, 5,142,432 bytes, sha256
  `14e3bdd53b68840c24ed6ef25e1e9441c9a02aa713b3f80ca710e4903443b55f`).
- For ARM64 mode only: `src-tauri/resources/pdfium/libpdfium_android_arm64.so`
  (present) and the checked-in `scripts/ci/prepare-android-gradle.mjs`.
- No `.release-tooling` checkout, no secrets, no network access, no downloaded scripts.
  The workflow's `.release-tooling/scripts/ci/prepare-android-gradle.mjs` is mapped to
  the repository copy `scripts/ci/prepare-android-gradle.mjs`.

## Official blocks used

From `reusable-build-android.yml`, job `build`:

1. `Prepare Android project (permissions / soft input / MainActivity)` — executed
   verbatim (permissions, `windowSoftInputMode=adjustResize`, managed Kotlin plugins,
   `file_paths.xml`, FileProvider).
2. `Copy custom Android icons` — executed verbatim; this is what invokes
   `node scripts/ci/prepare-bilibili-android.mjs`.
3. `Bundle pdfium for Android` — ARM64 mode only, executed verbatim. x86_64 mode
   intentionally skips it because the official block targets `arm64-v8a`.
4. `Reuse Tauri's initial native build in the Gradle packaging phase` — ARM64 mode
   only; runs the project copy of `prepare-android-gradle.mjs`. x86_64 mode does not
   patch or run it.

Marker checks fail closed if these blocks stop containing the expected manifest,
MainActivity, icon-script, or pdfium paths.

## Exact commands

Self-check (no execution, no mutation):

```bash
python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi x86_64 --check
```

Emulator preparation (x86_64):

```bash
python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi x86_64
```

This executes only blocks 1 and 2, then verifies the existing
`jniLibs/x86_64/libpdfium.so` by ELF machine (`x86-64`), Android note, and the pinned
sha256. It does not copy, download, or delete anything for pdfium. It also refuses to
run if `DS_ANDROID_PREBUILT_NATIVE=1` is present in the environment.

Later ARM64 preparation:

```bash
python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi arm64 --check
python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi arm64
```

ARM64 mode pre-verifies the arm64 resource before executing the official block, so the
block's `else` download branch cannot run. It then runs the project Gradle prep patch.

Build commands remain the main agent's responsibility and were not run here:

```bash
# x86_64 diagnostic APK (never set DS_ANDROID_PREBUILT_NATIVE here)
npx tauri android build --target x86_64 --apk --ci --features mobile-slim -- --locked --no-default-features

# later ARM64 delivery APK (official CI profile; DS_ANDROID_PREBUILT_NATIVE=1 only here)
DS_ANDROID_PREBUILT_NATIVE=1 npx tauri android build --target aarch64 --apk --ci --features mobile-slim -- --locked --no-default-features
```

## Safety invariants

- No ABI directory or generated file is deleted by this helper. `jniLibs` is only
  listed read-only; extra ABI directories are reported as untouched.
- No downloads and no network calls; the arm64 block is pre-gated on the local
  resource. x86_64 never invokes the arm64 pdfium block.
- No secrets are read or emitted.
- `DS_ANDROID_PREBUILT_NATIVE=1` is rejected for x86_64 and never set by the helper.
  The Gradle patch's own guard only permits `aarch64` release reuse.
- x86_64 pdfium replacement is refused unless the pinned validated sha256 matches;
  the helper never silently accepts a desktop glibc or wrong-ABI library.

## Known boundaries

- The x86_64 pdfium comes from the already validated generated file. If it is absent,
  the helper fails rather than downloading it; the main agent must restore the
  validated archive/library and rerun `--check`.
- Running ARM64 preparation after x86_64 leaves both `x86_64/` and `arm64-v8a/`
  under `jniLibs` because deletion is out of scope. The helper reports this; the main
  agent decides whether that is acceptable for the ARM64 package.
- Executing the two shared CI blocks changes only the generated Android project, as
  CI does. It does not change checked-in native or rendered sources.
