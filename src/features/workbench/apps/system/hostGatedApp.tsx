/**
 * 卡片中心窗口（模板、制卡任务、闪卡）与 Host 插件 `dstu.anki` 配对：Host 半降级时窗口内换成
 * `HostUnavailablePanel`，而不是让页面拿着空数据显示“还没有卡片”。经典壳的同一组视图由
 * `ui-plugins/official/shell` 的配对插件处理；工作台应用目前没有声明 Host 插件的字段，所以在这里按窗口判断。
 *
 * 没有应用内核（轻量窗口、测试）或 Host 清单未到时按在线处理，与内核的乐观安装一致。
 */
import React, { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { whenAppUiKernel } from '@/ui-kernel/app-kernel';
import type { UiHostStatusService } from '@/ui-kernel/services/host-status';
import type { AppWindowProps } from '../../core/types';

export const ANKI_HOST_PLUGIN = 'dstu.anki';

const HostUnavailablePanel = React.lazy(() => import('@/components/system-status/HostUnavailablePanel'));

const noop = () => {};

/** 首帧就同步读到已发布的内核，免得应用先挂载一帧、发出 Host 调用后再换成降级面板。 */
function currentHostStatus(): UiHostStatusService | undefined {
  let status: UiHostStatusService | undefined;
  whenAppUiKernel((kernel) => { status = kernel.hostStatus; })();
  return status;
}

/** 降级时返回原因（可能为空串），否则 null。 */
function useDegradedReason(hostId: string): string | null {
  const [status, setStatus] = useState(currentHostStatus);
  useEffect(() => (status ? noop : whenAppUiKernel((kernel) => setStatus(kernel.hostStatus))), [status]);
  const subscribe = useCallback((onChange: () => void) => status?.subscribe(onChange) ?? noop, [status]);
  return useSyncExternalStore(subscribe, () => (status?.state(hostId) === 'degraded' ? status.reason(hostId) ?? '' : null));
}

// RUST-FIX(RF-W09-workbench-cards-host-degraded): Host 半降级时换成降级面板
export function hostGatedApp(
  hostId: string,
  nameKey: string,
  load: () => Promise<{ default: React.ComponentType<AppWindowProps> }>,
): React.LazyExoticComponent<React.FC<AppWindowProps>> {
  return React.lazy(async () => {
    const { default: AppWindow } = await load();
    const HostGatedAppWindow: React.FC<AppWindowProps> = (props) => {
      const { t } = useTranslation();
      const reason = useDegradedReason(hostId);
      const { onTitleChange } = props;
      useEffect(() => {
        if (reason !== null) onTitleChange(t(nameKey));
      }, [reason, onTitleChange, t]);
      if (reason === null) return <AppWindow {...props} />;
      return (
        <Suspense fallback={null}>
          <HostUnavailablePanel hostId={hostId} titleKey={nameKey} reason={reason || undefined} />
        </Suspense>
      );
    };
    return { default: HostGatedAppWindow };
  });
}
