/**
 * 插件视图应用窗口：在学习桌面窗口里渲染社区插件的 `views` 条目。
 *
 * 渲染走 `<SlotOutlet>`，与插件其它贡献同一套隔离：插件作用域（`useT` / `usePluginStorage`…）、
 * 单条错误边界并计入插件错误预算、`data-ds-plugin` 样式作用域。条目随插件卸载撤销时显示占位。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { UiKernel } from '@/ui-kernel/kernel';
import type { ShellViewContribution } from '@/ui-kernel/contracts/shell';
import { SlotOutlet } from '@/ui-kernel/outlet';
import { UiKernelProvider, useOptionalUiKernel, useSlotEntry } from '@/ui-kernel/react';
import { resolveShellViewComponent } from '@/ui-kernel/shell-view';
import type { AppWindowProps } from '../../core/types';

export interface PluginViewAppWindowProps extends AppWindowProps {
  viewKey: string;
  /** 镜像该视图的内核；窗口树里已有 `<UiKernelProvider>` 时以上下文为准。 */
  kernel: UiKernel;
}

const Notice: React.FC<{ testId: string; children: React.ReactNode }> = ({ testId, children }) => (
  <div
    className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
    data-testid={testId}
    role="status"
  >
    {children}
  </div>
);

const PluginViewBody: React.FC<{ viewKey: string }> = ({ viewKey }) => {
  const { t } = useTranslation();
  const entry = useSlotEntry('views', viewKey);
  if (!entry || entry.origin === 'builtin') {
    return <Notice testId="wb-plugin-view-missing">{t('workbench:pluginViewApp.unavailable')}</Notice>;
  }
  return (
    <div
      className="h-full w-full min-h-0 overflow-auto"
      data-testid="wb-plugin-view-window"
      data-plugin-view={viewKey}
      data-plugin-owner={entry.owner}
      data-plugin-version={entry.version ?? ''}
    >
      <SlotOutlet
        name="views"
        filter={(candidate) => candidate.key === viewKey}
        suspense={<Notice testId="wb-plugin-view-loading">{t('workbench:pluginViewApp.loading')}</Notice>}
        fallback={<Notice testId="wb-plugin-view-failed">{t('workbench:pluginViewApp.failed')}</Notice>}
        render={(candidate) => {
          const Component = resolveShellViewComponent(candidate.value as ShellViewContribution);
          return <Component />;
        }}
      />
    </div>
  );
};

export const PluginViewAppWindow: React.FC<PluginViewAppWindowProps> = ({ viewKey, kernel }) => {
  const contextKernel = useOptionalUiKernel();
  const body = <PluginViewBody viewKey={viewKey} />;
  return contextKernel ? body : <UiKernelProvider kernel={kernel}>{body}</UiKernelProvider>;
};

export default PluginViewAppWindow;
