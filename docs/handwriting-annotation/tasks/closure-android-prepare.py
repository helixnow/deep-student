#!/usr/bin/env python3
"""Execute the checked-in Android CI preparation recipe against local gen/android.

Scope: disposable local reproducibility helper for the handwriting-annotation
closure. It does not run `tauri android init`, build, test, install, adb,
download anything, or touch generated/native sources on its own. The two
cross-ABI preparation blocks are always read live from
.github/workflows/reusable-build-android.yml and executed verbatim.

ABI modes:
  x86_64  emulator: run the two shared prep blocks; verify the already
          validated gen/android .../jniLibs/x86_64/libpdfium.so. The official
          "Bundle pdfium for Android" block is arm64-only and is skipped.
  arm64   later release: run the two shared prep blocks, the official arm64
          pdfium block (fail-closed if the resource is absent, so its download
          branch can never run), and the project copy of
          scripts/ci/prepare-android-gradle.mjs.

No ABI directory is ever deleted by this helper.

Usage:
  python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi x86_64 --check
  python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi x86_64
  python3 docs/handwriting-annotation/tasks/closure-android-prepare.py --abi arm64
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

WORKFLOW_REL = ".github/workflows/reusable-build-android.yml"
GEN_ANDROID_REL = "src-tauri/gen/android"
MANIFEST_REL = "src-tauri/gen/android/app/src/main/AndroidManifest.xml"
JNILIBS_REL = "src-tauri/gen/android/app/src/main/jniLibs"
X64_SO_REL = "src-tauri/gen/android/app/src/main/jniLibs/x86_64/libpdfium.so"
ARM64_RESOURCE_REL = "src-tauri/resources/pdfium/libpdfium_android_arm64.so"
GRADLE_PREPARE_REL = "scripts/ci/prepare-android-gradle.mjs"

STEP_PREPARE = "Prepare Android project (permissions / soft input / MainActivity)"
STEP_ICONS = "Copy custom Android icons"
STEP_PDFIUM = "Bundle pdfium for Android"

# The x64 library installed and verified for this closure. Pinning the digest
# prevents an accidental desktop-glibc or wrong-ABI replacement from passing.
VALIDATED_X64_SHA256 = "14e3bdd53b68840c24ed6ef25e1e9441c9a02aa713b3f80ca710e4903443b55f"

# A workflow edit that removes or rewrites these expectations must fail here
# instead of silently running a different local recipe.
REQUIRED_MARKERS = {
    STEP_PREPARE: (
        "AndroidManifest.xml",
        "android.permission.RECORD_AUDIO",
        "MainActivity.kt",
        "src-tauri/gen/android/app/src/main/java",
    ),
    STEP_ICONS: ("prepare-bilibili-android.mjs", "src-tauri/icons/android"),
    STEP_PDFIUM: ("jniLibs/arm64-v8a", "libpdfium_android_arm64.so"),
}

ABI_DIR = {"x86_64": "x86_64", "arm64": "arm64-v8a"}
ABI_MACHINE = {"x86_64": 62, "arm64": 183}
ABI_ELF_LABEL = {"x86_64": "x86-64", "arm64": "AArch64"}


class PrepareError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise PrepareError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_android_elf(path: Path, abi: str, expect_sha256: str | None = None) -> str:
    if not path.is_file():
        fail(f"missing library: {path}")
    data = path.read_bytes()
    if len(data) < 64 or data[:4] != b"\x7fELF":
        fail(f"not an ELF file: {path}")
    if data[4] != 2 or data[5] != 1:
        fail(f"not a 64-bit little-endian ELF: {path}")
    machine = struct.unpack_from("<H", data, 18)[0]
    expected_machine = ABI_MACHINE[abi]
    if machine != expected_machine:
        fail(
            f"wrong ELF machine for {abi}: {machine} "
            f"(expected {expected_machine} / {ABI_ELF_LABEL[abi]}) at {path}"
        )
    if b".note.android.ident" not in data:
        fail(f"ELF is not an Android build (missing .note.android.ident): {path}")
    digest = hashlib.sha256(data).hexdigest()
    if expect_sha256 is not None and digest != expect_sha256:
        fail(
            f"unexpected sha256 for {path}: {digest} "
            f"(expected {expect_sha256})"
        )
    return digest


def load_workflow_steps(root: Path) -> dict[str, str]:
    workflow = root / WORKFLOW_REL
    if not workflow.is_file():
        fail(f"checked-in workflow not found: {workflow}")
    try:
        import yaml  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment guard
        raise PrepareError(
            "PyYAML is required to read the checked-in workflow live "
            "(install python3-yaml or pip install PyYAML)"
        ) from exc

    try:
        document: Any = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise PrepareError(f"cannot parse {workflow}: {exc}") from exc

    try:
        steps = document["jobs"]["build"]["steps"]
    except (KeyError, TypeError) as exc:
        raise PrepareError(
            f"{workflow} no longer has jobs.build.steps; refusing to guess a recipe"
        ) from exc

    wanted = {STEP_PREPARE, STEP_ICONS, STEP_PDFIUM}
    found: dict[str, str] = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        name = step.get("name")
        if name in wanted:
            run = step.get("run")
            if not isinstance(run, str) or not run.strip():
                fail(f"official step {name!r} has no runnable shell block")
            found[name] = run

    missing = sorted(wanted - set(found))
    if missing:
        fail(f"official preparation step(s) missing from {WORKFLOW_REL}: {missing}")

    for name, markers in REQUIRED_MARKERS.items():
        if name not in found:
            continue
        for marker in markers:
            if marker not in found[name]:
                fail(
                    f"official step {name!r} no longer contains {marker!r}; "
                    "review the workflow before using the local helper"
                )
    return found


def preflight(root: Path, abi: str) -> None:
    if not (root / GEN_ANDROID_REL).is_dir():
        fail(
            f"{root / GEN_ANDROID_REL} is missing; run "
            "`npx tauri android init --ci --skip-targets-install` first"
        )
    if not (root / MANIFEST_REL).is_file():
        fail(f"generated manifest missing: {root / MANIFEST_REL}")
    if shutil.which("bash") is None:
        fail("bash is required to run the checked-in workflow blocks")
    if shutil.which("node") is None:
        fail("node is required by the official icon preparation block")

    if abi == "x86_64":
        if os.environ.get("DS_ANDROID_PREBUILT_NATIVE") == "1":
            fail(
                "DS_ANDROID_PREBUILT_NATIVE=1 is only valid for an aarch64 "
                "release build and must never be set for x86_64"
            )
        validate_android_elf(root / X64_SO_REL, "x86_64", VALIDATED_X64_SHA256)
    else:
        validate_android_elf(root / ARM64_RESOURCE_REL, "arm64")
        if not (root / GRADLE_PREPARE_REL).is_file():
            fail(f"project Gradle preparation script missing: {root / GRADLE_PREPARE_REL}")


def run_shell_block(root: Path, name: str, script: str) -> None:
    print(f"[run] {name}")
    # CI's default Linux shell is `bash -e {0}`. Reuse that behaviour and a
    # temporary script outside the repository; never execute downloaded code.
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".sh", prefix="ds-android-prepare-", delete=False
    )
    temp_path = Path(handle.name)
    try:
        handle.write(script)
        if not script.endswith("\n"):
            handle.write("\n")
        handle.close()
        os.chmod(temp_path, 0o600)
        result = subprocess.run(
            ["bash", "-e", str(temp_path)],
            cwd=str(root),
            check=False,
        )
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
    if result.returncode != 0:
        fail(f"official step {name!r} failed with exit code {result.returncode}")
    print(f"[ok]  {name}")


def run_node_script(root: Path, relative: str) -> None:
    script = root / relative
    if not script.is_file():
        fail(f"project script missing: {script}")
    print(f"[run] node {relative}")
    result = subprocess.run(["node", str(script)], cwd=str(root), check=False)
    if result.returncode != 0:
        fail(f"node {relative} failed with exit code {result.returncode}")
    print(f"[ok]  node {relative}")


def audit_jni_libs(root: Path, abi: str) -> None:
    base = root / JNILIBS_REL
    print(f"[audit] {base.relative_to(root)} (read-only; nothing is deleted)")
    if not base.is_dir():
        print("  (absent)")
        return
    target = ABI_DIR[abi]
    for entry in sorted(base.iterdir(), key=lambda item: item.name):
        if not entry.is_dir():
            print(f"  {entry.name}: file (left untouched)")
            continue
        files = sorted(child.name for child in entry.iterdir())
        role = "target" if entry.name == target else "extra (left untouched)"
        print(f"  {entry.name}/ [{role}]: {files if files else '(empty)'}")


def summarize_x64(root: Path) -> None:
    path = root / X64_SO_REL
    digest = validate_android_elf(path, "x86_64", VALIDATED_X64_SHA256)
    size = path.stat().st_size
    print(f"[verify] {path.relative_to(root)}")
    print(f"  ELF64 {ABI_ELF_LABEL['x86_64']} Android, {size} bytes, sha256 {digest}")


def run_check(root: Path, abi: str) -> None:
    print(f"[check] abi={abi} workflow={WORKFLOW_REL}")
    steps = load_workflow_steps(root)
    for name in (STEP_PREPARE, STEP_ICONS):
        print(f"  official block present: {name}")
    preflight(root, abi)
    if abi == "x86_64":
        print(f"  official block skipped (arm64-only): {STEP_PDFIUM}")
        summarize_x64(root)
    else:
        for name in (STEP_PREPARE, STEP_ICONS, STEP_PDFIUM):
            print(f"  official block present: {name}")
        validate_android_elf(root / ARM64_RESOURCE_REL, "arm64")
        print(f"  project Gradle preparation: {GRADLE_PREPARE_REL}")
    audit_jni_libs(root, abi)
    print("[check] ok; nothing was executed or modified")


def execute(root: Path, abi: str) -> None:
    steps = load_workflow_steps(root)
    preflight(root, abi)

    run_shell_block(root, STEP_PREPARE, steps[STEP_PREPARE])
    run_shell_block(root, STEP_ICONS, steps[STEP_ICONS])

    if abi == "x86_64":
        print(f"[skip] {STEP_PDFIUM} (arm64-only; x86_64 library is validated in place)")
        summarize_x64(root)
        print("[note] prepare-android-gradle.mjs is ARM64-only and was not run")
    else:
        # Preflight already proved the resource exists, so the workflow block
        # cannot take its download branch.
        run_shell_block(root, STEP_PDFIUM, steps[STEP_PDFIUM])
        validate_android_elf(root / ARM64_RESOURCE_REL, "arm64")
        print("[verify] arm64 pdfium copied by the official block")
        # CI checks out this file under .release-tooling/scripts/ci; the
        # repository's checked-in copy is the local equivalent.
        run_node_script(root, GRADLE_PREPARE_REL)
        print("[note] set DS_ANDROID_PREBUILT_NATIVE=1 only for the later aarch64 release build")

    audit_jni_libs(root, abi)
    print(f"[done] {abi} preparation complete")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the checked-in CI Android prep blocks against local gen/android."
    )
    parser.add_argument("--abi", choices=sorted(ABI_DIR), required=True)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate workflow steps, prerequisites, and existing libraries only",
    )
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parents[3]),
        help="repository root (default: derived from this file)",
    )
    args = parser.parse_args(argv)
    root = Path(args.repo_root).resolve()
    try:
        if args.check:
            run_check(root, args.abi)
        else:
            execute(root, args.abi)
        return 0
    except PrepareError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
