import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { TextSwap } from '@/components/ui/TextSwap';
import { coarseHitClassFor28 } from '@/components/ui/coarseHit';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import type { DesktopBreadcrumbItem } from './DesktopHeaderContext';

export interface DesktopBreadcrumbBarProps {
  items: readonly DesktopBreadcrumbItem[];
  meta?: React.ReactNode;
  className?: string;
}

const MAX_UNCOLLAPSED_DEPTH = 3;

const SEPARATOR = (
  <span className="shrink-0 select-none text-muted-foreground/45" aria-hidden="true">
    /
  </span>
);

/**
 * 桌面端右侧顶栏统一面包屑组件（以设置页面包屑为基准）。
 *
 * - 统一 14px / font-medium（继承 `.desktop-shell-header-title`）；
 * - 父级弱化（`text-muted-foreground`），支持 `onClick` 点击返回上级；
 * - 超过 3 级时自动压缩中间节点为 `一级 / … / 父级 / 当前`，点击 `…` 可展开全部被折叠层级；
 * - 末级高亮（`text-foreground`），支持 `TextSwap` 或自定义编辑组件（如对话重命名）；
 * - 附注 `meta` 置于末级右侧，采用弱化小号等宽数字，不使用 `/` 混淆层级。
 */
export const DesktopBreadcrumbBar: React.FC<DesktopBreadcrumbBarProps> = ({
  items,
  meta,
  className,
}) => {
  const { t } = useTranslation('common');

  if (items.length === 0) {
    return null;
  }

  const isCollapsed = items.length > MAX_UNCOLLAPSED_DEPTH;
  const rootItem = items[0];
  const hiddenMiddleItems = isCollapsed ? items.slice(1, items.length - 2) : [];
  const trailingItems = isCollapsed ? items.slice(items.length - 2) : items.slice(1);
  const lastItem = items[items.length - 1];

  const renderAncestor = (item: DesktopBreadcrumbItem, key: string) => {
    const tooltip = item.title ?? item.label;
    if (item.onClick) {
      return (
        <DsButton
          key={key}
          variant="ghost"
          size="sm"
          data-no-drag
          onClick={item.onClick}
          title={tooltip}
          className={cn(
            'desktop-shell-breadcrumb-button shrink-0 max-w-[160px] text-muted-foreground hover:text-foreground',
            coarseHitClassFor28,
          )}
        >
          <span className="block min-w-0 truncate">{item.label}</span>
        </DsButton>
      );
    }

    return (
      <span
        key={key}
        title={tooltip}
        className="shrink-0 max-w-[160px] truncate text-muted-foreground"
      >
        {item.label}
      </span>
    );
  };

  const renderCurrent = (item: DesktopBreadcrumbItem, key: string) => {
    const tooltip = item.title ?? item.label;
    if (item.render) {
      return (
        <span key={key} data-no-drag className="min-w-0 flex-1">
          {item.render}
        </span>
      );
    }

    if (item.onClick) {
      return (
        <DsButton
          key={key}
          variant="ghost"
          size="sm"
          data-no-drag
          onClick={item.onClick}
          title={tooltip}
          className={cn(
            'desktop-shell-breadcrumb-button min-w-0 max-w-full text-foreground',
            coarseHitClassFor28,
          )}
        >
          <TextSwap text={item.label} className="block min-w-0 truncate" />
        </DsButton>
      );
    }

    return (
      <span
        key={key}
        title={tooltip}
        className="min-w-0 flex-1 text-foreground"
      >
        <TextSwap text={item.label} className="block min-w-0 max-w-full truncate" />
      </span>
    );
  };

  return (
    <nav
      aria-label={lastItem?.label ?? t('common:app.default_header')}
      data-shell-header-breadcrumb={items.length > 1 ? 'true' : undefined}
      className={cn(
        'desktop-shell-header-title desktop-shell-breadcrumb flex min-w-0 items-center gap-1.5',
        className,
      )}
    >
      {items.length === 1 ? (
        renderCurrent(rootItem, rootItem.id ?? `crumb-0-${rootItem.label}`)
      ) : (
        <>
          {renderAncestor(rootItem, rootItem.id ?? `crumb-0-${rootItem.label}`)}
          {isCollapsed && hiddenMiddleItems.length > 0 ? (
            <>
              {SEPARATOR}
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-no-drag
                    aria-label={t('common:more')}
                    title={hiddenMiddleItems.map((entry) => entry.label).join(' / ')}
                    className={cn(
                      'desktop-shell-breadcrumb-button shrink-0 text-muted-foreground hover:text-foreground',
                      coarseHitClassFor28,
                    )}
                  >
                    …
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="start" width={200}>
                  {hiddenMiddleItems.map((entry, idx) => (
                    <AppMenuItem
                      key={entry.id ?? `hidden-${idx}-${entry.label}`}
                      disabled={!entry.onClick}
                      onClick={() => entry.onClick?.()}
                    >
                      <span className="truncate">{entry.label}</span>
                    </AppMenuItem>
                  ))}
                </AppMenuContent>
              </AppMenu>
            </>
          ) : null}
          {trailingItems.map((item, idx) => {
            const isLast = idx === trailingItems.length - 1;
            const key = item.id ?? `crumb-trail-${idx}-${item.label}`;
            return (
              <React.Fragment key={key}>
                {SEPARATOR}
                {isLast ? renderCurrent(item, key) : renderAncestor(item, key)}
              </React.Fragment>
            );
          })}
        </>
      )}
      {meta ? (
        <span
          data-shell-header-meta="true"
          className="ml-1.5 hidden shrink-0 items-center text-xs font-normal tabular-nums text-muted-foreground/60 sm:inline-flex"
        >
          {meta}
        </span>
      ) : null}
    </nav>
  );
};
