#!/usr/bin/env python3
"""Manual, synthetic baseline for the CloudSyncManager whole-ZIP upload path.

This file is intentionally not a Cargo test and is not imported by tests/mod.rs.
Run it manually:

    python3 src-tauri/tests/cloud_sync_delta_benchmark.py

The script only writes under a temporary directory, never reads Deep Student user
data, and never contacts a network. It mirrors the current outer ZIP's DEFLATE
packaging and reports the exact DSBK v2 container overhead from
crypto/backup_crypto.rs. Transfer durations are arithmetic projections, not
provider benchmarks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import random
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

MIB = 1024 * 1024
DSBK_V2_HEADER_BYTES = 44
DSBK_GCM_TAG_BYTES = 16
DSBK_PLAINTEXT_CHUNK_BYTES = MIB
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(MIB):
            digest.update(block)
    return digest.hexdigest()


def write_incompressible_file(path: Path, byte_count: int, seed: int) -> None:
    rng = random.Random(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    remaining = byte_count
    with path.open("wb") as output:
        while remaining:
            size = min(MIB, remaining)
            output.write(rng.randbytes(size))
            remaining -= size


def create_sqlite_database(path: Path, target_bytes: int, seed: int) -> None:
    """Create a mixed text/binary SQLite database of approximately target_bytes."""

    path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA page_size=4096")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute(
            """
            CREATE TABLE study_records (
                id INTEGER PRIMARY KEY,
                payload BLOB NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        row_bytes = 256 * 1024
        row_id = 1
        while path.stat().st_size < target_bytes:
            if row_id % 2:
                prefix = (
                    b'{"kind":"study_record","question":"synthetic benchmark",'
                    b'"answer":"repeatable text payload","tags":["delta","backup"]}'
                )
                payload = (prefix * (row_bytes // len(prefix) + 1))[:row_bytes]
            else:
                payload = rng.randbytes(row_bytes)
            connection.execute(
                "INSERT INTO study_records(id, payload, updated_at) VALUES (?, ?, ?)",
                (row_id, payload, "2026-08-24T00:00:00.000Z"),
            )
            row_id += 1
            if row_id % 16 == 0:
                connection.commit()
        connection.commit()
    finally:
        connection.close()


def mutate_one_sqlite_row(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "UPDATE study_records SET updated_at = ? WHERE id = 1",
            ("2026-08-24T00:00:01.000Z",),
        )
        connection.commit()
    finally:
        connection.close()


def data_inventory(stage: Path) -> dict[str, dict[str, Any]]:
    inventory: dict[str, dict[str, Any]] = {}
    for path in sorted(stage.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        relative = path.relative_to(stage).as_posix()
        inventory[relative] = {
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    return inventory


def write_manifest(
    stage: Path,
    snapshot_id: str,
    created_at: str,
    inventory: dict[str, dict[str, Any]],
) -> None:
    manifest = {
        "format": "synthetic-cloud-sync-delta-baseline-v1",
        "snapshotId": snapshot_id,
        "createdAt": created_at,
        "files": [
            {"path": path, **metadata} for path, metadata in inventory.items()
        ],
    }
    (stage / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def package_zip(stage: Path, destination: Path) -> float:
    started = time.perf_counter()
    with zipfile.ZipFile(
        destination,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
        allowZip64=True,
    ) as archive:
        for source in sorted(stage.rglob("*")):
            if not source.is_file():
                continue
            relative = source.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(relative, date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100600 << 16
            with source.open("rb") as input_file, archive.open(
                info, mode="w", force_zip64=True
            ) as output_file:
                shutil.copyfileobj(input_file, output_file, length=MIB)
    return time.perf_counter() - started


def dsbk_v2_size(plaintext_bytes: int) -> int:
    chunks = max(1, math.ceil(plaintext_bytes / DSBK_PLAINTEXT_CHUNK_BYTES))
    return plaintext_bytes + DSBK_V2_HEADER_BYTES + chunks * DSBK_GCM_TAG_BYTES


def changed_files(
    before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for path in sorted(set(before) | set(after)):
        old = before.get(path)
        new = after.get(path)
        if old != new:
            changes.append(
                {
                    "path": path,
                    "beforeBytes": old["bytes"] if old else 0,
                    "afterBytes": new["bytes"] if new else 0,
                }
            )
    return changes


def transfer_seconds(byte_count: int, mbps: float) -> float:
    return byte_count * 8 / (mbps * 1_000_000)


def archive_result(
    path: Path, package_seconds: float, bandwidths_mbps: list[float]
) -> dict[str, Any]:
    zip_bytes = path.stat().st_size
    encrypted_bytes = dsbk_v2_size(zip_bytes)
    return {
        "zipBytes": zip_bytes,
        "dsbkV2Bytes": encrypted_bytes,
        "packageSeconds": round(package_seconds, 6),
        "projectedTransferSeconds": {
            f"{bandwidth:g}Mbps": {
                "plainZip": round(transfer_seconds(zip_bytes, bandwidth), 3),
                "e2eeDsbk": round(transfer_seconds(encrypted_bytes, bandwidth), 3),
            }
            for bandwidth in bandwidths_mbps
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-mib", type=int, default=32)
    parser.add_argument("--assets-mib", type=int, default=128)
    parser.add_argument("--asset-count", type=int, default=16)
    parser.add_argument(
        "--bandwidth-mbps",
        type=float,
        nargs="+",
        default=[10.0, 50.0],
        help="Upload rates used only for arithmetic transfer-time projections.",
    )
    parser.add_argument("--seed", type=int, default=11011)
    parser.add_argument(
        "--keep-work-dir",
        action="store_true",
        help="Keep generated files and report their directory.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if (
        args.database_mib <= 0
        or args.assets_mib < 0
        or args.asset_count <= 0
        or any(rate <= 0 for rate in args.bandwidth_mbps)
    ):
        raise SystemExit("sizes, asset count, and bandwidths must be positive")

    temporary = Path(tempfile.mkdtemp(prefix="deep-student-delta-benchmark-"))
    stage = temporary / "backup-stage"
    stage.mkdir()

    try:
        database = stage / "databases" / "vfs.db"
        create_sqlite_database(database, args.database_mib * MIB, args.seed)

        total_asset_bytes = args.assets_mib * MIB
        base_asset_bytes, remainder = divmod(total_asset_bytes, args.asset_count)
        for index in range(args.asset_count):
            size = base_asset_bytes + (1 if index < remainder else 0)
            write_incompressible_file(
                stage / "assets" / f"resource-{index:04d}.bin",
                size,
                args.seed + index + 1,
            )

        baseline_inventory = data_inventory(stage)
        write_manifest(
            stage,
            "synthetic-0001",
            "2026-08-24T00:00:00.000Z",
            baseline_inventory,
        )
        baseline_zip = temporary / "baseline.zip"
        baseline_seconds = package_zip(stage, baseline_zip)

        # A real full backup receives a fresh backup ID/timestamp even when user
        # data is unchanged, so the outer ZIP still differs and is fully PUT.
        write_manifest(
            stage,
            "synthetic-0002",
            "2026-08-24T00:15:00.000Z",
            baseline_inventory,
        )
        no_change_zip = temporary / "no-change.zip"
        no_change_seconds = package_zip(stage, no_change_zip)
        no_change_inventory = data_inventory(stage)

        mutate_one_sqlite_row(database)
        mutation_inventory = data_inventory(stage)
        write_manifest(
            stage,
            "synthetic-0003",
            "2026-08-24T00:30:00.000Z",
            mutation_inventory,
        )
        mutation_zip = temporary / "one-row-change.zip"
        mutation_seconds = package_zip(stage, mutation_zip)

        baseline = archive_result(
            baseline_zip, baseline_seconds, args.bandwidth_mbps
        )
        no_change = archive_result(
            no_change_zip, no_change_seconds, args.bandwidth_mbps
        )
        mutation = archive_result(
            mutation_zip, mutation_seconds, args.bandwidth_mbps
        )
        result: dict[str, Any] = {
            "scope": {
                "kind": "synthetic-local-baseline",
                "networkUsed": False,
                "userDataRead": False,
                "notes": [
                    "ZIP packaging mirrors DEFLATE level 6, deterministic metadata, and whole-object PUT byte counts.",
                    "DSBK v2 bytes are exact format overhead, but Argon2/encryption CPU time is not measured.",
                    "Transfer seconds are arithmetic projections at supplied uplink rates, not provider timings.",
                    "The mixed synthetic SQLite payload and incompressible assets are a declared profile, not a claim about a typical user's library.",
                ],
            },
            "environment": {
                "platform": platform.platform(),
                "python": platform.python_version(),
            },
            "profile": {
                "databaseTargetMiB": args.database_mib,
                "assetsMiB": args.assets_mib,
                "assetCount": args.asset_count,
                "sourceDataBytes": sum(
                    item["bytes"] for item in baseline_inventory.values()
                ),
                "sourceFileCount": len(baseline_inventory),
            },
            "runs": {
                "baseline": baseline,
                "noUserDataChange": {
                    **no_change,
                    "logicalChangedFiles": changed_files(
                        baseline_inventory, no_change_inventory
                    ),
                },
                "oneRowChanged": {
                    **mutation,
                    "logicalChangedFiles": changed_files(
                        no_change_inventory, mutation_inventory
                    ),
                },
            },
            "currentRetentionUpperBoundAtThisProfile": {
                "versionsPerDevice": 10,
                "plainZipBytes": no_change["zipBytes"] * 10,
                "e2eeDsbkBytes": no_change["dsbkV2Bytes"] * 10,
                "qualification": (
                    "Simple ten-times size illustration. Actual per-device archives "
                    "vary, and shared/legacy manifests alter global visible counts."
                ),
            },
        }
        if args.keep_work_dir:
            result["workDirectory"] = str(temporary)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        if not args.keep_work_dir:
            shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    main()
