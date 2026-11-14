import { useEffect, useState } from 'react';

import type { PluginUiHostStatus } from './ui-status';

/**
 * 订阅 W17 `hostStatus` 的变化（清单、降级、同意、安全模式都可能晚于首帧到达）。
 * 返回同一个 handle；读取留在渲染期，保证拿到当前值而不是订阅时的快照。
 */
export function usePluginUiHostStatus<T extends PluginUiHostStatus | null | undefined>(status: T): T {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!status) return;
    return status.subscribe(() => setVersion((version) => version + 1));
  }, [status]);
  return status;
}
