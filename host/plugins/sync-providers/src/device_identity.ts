/**
 * L23's only device-identity entry point.
 *
 * The authoritative semantics (`DEVICE_ID` env → primary `base/.device_id` →
 * legacy files with migration → generate/persist, process-stable fallback,
 * production logging) are owned by F4 `PathsService.dataSpaceDeviceId()`
 * (`dstu-storage/src/data_space/device_id.rs`).
 *
 * This module must not duplicate that orchestration and must not fall back to
 * `paths.deviceId()`, which is the L20 `commands_sync` legacy-root-first
 * wrapper. `dataSpaceDeviceId()` is published on `ds-mig/F4-security` but not
 * integrated into main yet; until it is, a missing method is a contract /
 * programming error and propagates unchanged (there is deliberately no local
 * compatibility layer).
 */

import type { PathsService } from '../../../platform/paths/api.ts';

/** Thin call into the F4 owner API. Errors propagate unchanged. */
export async function dataSpaceDeviceId(paths: PathsService): Promise<string> {
  const owner = paths as PathsService & { dataSpaceDeviceId(): Promise<string> };
  return owner.dataSpaceDeviceId();
}
