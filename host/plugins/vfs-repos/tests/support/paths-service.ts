import type { PathsService } from '../../../../platform/paths/api.ts';

/**
 * F4 `paths` 测试替身：L11 只依赖持久设备身份。
 * 生产安装真实 F4 插件；测试固定身份以便断言 translations/folder_items 的同步列。
 *
 * L11 只调用正式底层入口 `dataSpaceDeviceId()`，不回退 legacy-root-first
 * `deviceId()`；`deviceId` 仍提供，用于以不同值证明生产没有误用旧包装。
 */
export function pathsServiceDouble(deviceId = 'device-test', dataSpaceDeviceId = deviceId): PathsService {
  return {
    deviceId: async () => deviceId,
    dataSpaceDeviceId: async () => dataSpaceDeviceId,
  } as unknown as PathsService;
}
