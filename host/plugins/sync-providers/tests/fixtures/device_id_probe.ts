/**
 * Child-process probe for the device identity tests.
 *
 * Mirrors `sync_android_restart.rs::sync_r07_device_id_probe` and
 * `sync_android_device_switch.rs::r09_device_id_probe_subprocess`: each child is
 * one app start and must exit 0. The identity implementation is F4's
 * `paths.dataSpaceDeviceId()`; this probe does not reconstruct it.
 *
 * Run with `node --experimental-strip-types --no-warnings <this file>`.
 */

import { createPaths, type PathsService } from '../../../../platform/paths/index.ts';

type OwnerPaths = PathsService & { dataSpaceDeviceId(): Promise<string> };

const base = process.env.L23_DEVICE_PROBE_DATA_DIR;
if (base === undefined || base === '') throw new Error('L23_DEVICE_PROBE_DATA_DIR is required');

const env = { ...process.env };
const paths = createPaths({
  dataDir: base,
  platform: 'linux',
  env,
  log: (level, message) => console.error(`[device-id:${level}] ${message}`),
}) as OwnerPaths;

if (typeof paths.dataSpaceDeviceId !== 'function') {
  console.error('F4 paths.dataSpaceDeviceId() is not available in this tree');
  process.exit(2);
}

const initial = await paths.dataSpaceDeviceId();
console.log(`PROBE_DEVICE_ID=${initial}`);
console.log(`R09_PROBE_INITIAL=${initial}`);

if (process.env.L23_DEVICE_PROBE_ROTATE === '1') {
  const [oldId, newId] = await paths.rotateDeviceIdAfterRestore();
  const after = await paths.dataSpaceDeviceId();
  console.log(`PROBE_OLD=${oldId}`);
  console.log(`PROBE_NEW=${newId}`);
  console.log(`PROBE_AFTER=${after}`);
  console.log(`R09_PROBE_OLD=${oldId}`);
  console.log(`R09_PROBE_NEW=${newId}`);
  console.log(`R09_PROBE_AFTER=${after}`);
}
