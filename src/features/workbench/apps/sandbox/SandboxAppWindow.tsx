/**
 * 沙箱工作台应用窗口（P9 薄包装 → O18 窗口化边界打磨）
 *
 * 复用 `SandboxWorkbenchSurface`。应用保持 single 单例窗口，并显式绑定
 * legacy/standalone owner；chat owner 的激活不会切换本窗口正在展示的预览。
 * embedded=false：无会话时渲染引导空态而非 null；
 * 工具栏关闭按钮 → requestClose（关窗），会话数据留在 store。
 * 窗口标题跟随当前会话标题。
 *
 * O18 窗口化边界处理：
 * - **iframe 焦点守卫**：预览画布是 iframe——非焦点窗口上的 pointerdown
 *   若直接落进 iframe，事件不会冒泡回宿主文档，窗口壳收不到聚焦信号
 *   （点了没反应）。isActive=false 时铺一层透明守卫，首次点击先走
 *   宿主 DOM 冒泡到 WindowShell 完成聚焦（macOS 语义：第一次点击只激活
 *   窗口），聚焦后守卫卸载、交互直达 iframe；
 * - lazy 化 + 画布形态骨架屏 + 内容淡入；
 * - 窗口尺寸分级 data 属性（供窄窗微调，legacy 断点看视口拿不到）。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSkeleton } from '../system/SystemWindowShared';
import { useWbSysSize } from '../system/useWbSysSize';
import './SandboxAppWindow.css';

const SandboxWorkbenchSurface = React.lazy(
  () => import('@/features/sandbox/components/SandboxWorkbenchSurface'),
);

const SandboxAppWindow: React.FC<AppWindowProps> = ({ onTitleChange, requestClose, isActive }) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();
  const sessionTitle = useSandboxWorkbenchStore((state) => (
    selectSandboxWorkbenchOwnerState(state, LEGACY_SANDBOX_OWNER_KEY).activeSession?.title ?? null
  ));

  useEffect(() => {
    onTitleChange(sessionTitle || t('workbench:apps.sandbox', '沙箱工作台'));
  }, [onTitleChange, t, sessionTitle]);

  return (
    <div
      ref={ref}
      className="relative h-full w-full min-w-0 overflow-hidden bg-background"
      data-wb-sandbox-app
    >
      <Suspense fallback={<WbSysSkeleton variant="surface" />}>
        <WbSysFade>
          <SandboxWorkbenchSurface
            className="h-full"
            onClose={requestClose}
            ownerKey={LEGACY_SANDBOX_OWNER_KEY}
          />
        </WbSysFade>
      </Suspense>
      {!isActive && (
        <div className="wb-sandbox-focus-guard" data-wb-sandbox-focus-guard aria-hidden />
      )}
    </div>
  );
};

export default SandboxAppWindow;
