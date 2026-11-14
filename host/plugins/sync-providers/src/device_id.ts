/**
 * Device identity helpers.
 *
 * The filesystem path resolution, atomic write (temp file in the target parent
 * directory), legacy XDG/dirs lookup, hostname environment order and
 * migration/persist logging are implemented once by F4 `ctx.paths`
 * (`dstu-storage/src/data_space/device_id.rs`). This module only re-exports the
 * pure functions so the sync manager keeps the same import surface.
 */

export {
  deviceIdShortHash,
  normalizeDeviceId,
} from '../../../platform/paths/device-id-core.ts';

/** Short hash length used by `manifests/<hash>.json` and `createdByDevice`. */
export const DEVICE_ID_SHORT_HASH_LEN = 16;
