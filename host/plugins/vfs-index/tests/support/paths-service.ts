import type { PathsService } from '../../../../platform/paths/api.ts';

/**
 * Minimal F4 `paths` stand-in for vfs-repos plugin startup. L11 only consumes
 * the persistent device identity; production wires the real F4 service.
 */
export function pathsServiceDouble(deviceId = 'device-test'): PathsService {
  return {
    deviceId: async () => deviceId,
    // L11 now consumes F4's authoritative identity entry at startup.
    dataSpaceDeviceId: async () => deviceId,
  } as unknown as PathsService;
}
