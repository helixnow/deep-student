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
import { usePluginManagerWorkshop } from '@/features/plugin-manager';
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
  const { t, i18n } = useTranslation(['workbench', 'plugin_manager']);
  const entry = useSlotEntry('views', viewKey);
  const workshop = usePluginManagerWorkshop();
  if (!entry || entry.origin === 'builtin') {
    return <Notice testId="wb-plugin-view-missing">{t('workbench:pluginViewApp.unavailable')}</Notice>;
  }
  const canRefine = Boolean(entry.owner?.startsWith('workshop.plugin-') && workshop?.onModify);
  const isEn = (i18n?.resolvedLanguage ?? i18n?.language ?? '').toLowerCase().startsWith('en');
  return (
    <div
      className="relative h-full w-full min-h-0 overflow-auto"
      data-testid="wb-plugin-view-window"
      data-plugin-view={viewKey}
      data-plugin-owner={entry.owner}
      data-plugin-version={entry.version ?? ''}
    >
      {canRefine ? (
        <div
          aria-label={t('plugin_manager:workshop.quickBarAriaLabel', {
            defaultValue: isEn ? 'Plugin Workshop quick bar' : '插件工坊快捷栏',
          })}
          className="pointer-events-none sticky top-2 z-10 flex justify-end px-3"
        >
          <button
            type="button"
            data-testid="workshop-refine-with-ai"
            onClick={() => workshop?.onModify(entry.owner!)}
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted"
          >
            {t('plugin_manager:workshop.actions.refineWithAi', {
              defaultValue: isEn ? '✦ Refine with AI' : '✦ 让 AI 优化',
            })}
          </button>
        </div>
      ) : null}
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
