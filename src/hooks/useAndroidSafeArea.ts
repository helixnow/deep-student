import { useSyncExternalStore } from 'react';

import {
  getAndroidSafeAreaInsets,
  subscribeAndroidSafeArea,
  type AndroidSafeAreaInsets,
} from '@/utils/platform';

const getServerSnapshot = (): AndroidSafeAreaInsets | null => null;

/**
 * #472: 订阅 Android 原生安全区（CSS px）。非 Android 恒为 null。
 *
 * CSS 侧已有 --android-safe-area-*；需要参与数值计算的布局（如桌面壳标题栏
 * 高度）用本 hook 拿到同一份数据，系统栏显隐 / 旋转时自动重渲染。
 */
export function useAndroidSafeArea(): AndroidSafeAreaInsets | null {
  return useSyncExternalStore(subscribeAndroidSafeArea, getAndroidSafeAreaInsets, getServerSnapshot);
}
