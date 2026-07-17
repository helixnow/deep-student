/**
 * DockContextMenu（P5 → O6）— Dock 应用项右键菜单
 *
 * 复用 app-menu context 模式，外壳用 wb-dockmenu- 覆盖玻璃材质 / 升起动画：
 * - 「打开 / 新建窗口」
 * - （运行中）逐窗列表：前台窗口勾选标记；点击聚焦
 * - 固定 / 取消固定
 * - （运行中）关闭全部窗口（destructive；逐窗走 requestCloseAnimated）
 *
 * 关闭链路：AppMenuContent 用 setTimeout(--dropdown-close-dur) 兜底卸载，
 * 不依赖 transitionend；reduced-motion 下 transition:none 也不会卡住。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  PushPin,
  PushPinSlash,
  SquaresFour,
  XCircle,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '../../../components/ui/app-menu';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { workbenchBus } from '../core/workbenchBus';
import { requestCloseAnimated } from '../hooks/useWindowLifecycleAnim';
import { toggleDockPinned, useDockPinned } from './DockPinnedStore';
import './DockContextMenu.css';

export interface DockContextMenuProps {
  typeId: string;
  /** 单个可接收 onContextMenu/className 的元素（通常是 DockItem） */
  children: React.ReactElement;
}

export function DockContextMenu({ typeId, children }: DockContextMenuProps) {
  const { t } = useTranslation();
  const pinned = useDockPinned();
  const isPinned = pinned.includes(typeId);

  // 指纹订阅（selector 返回原始字符串，zustand Object.is 去重）：本组件包裹每个
  // DockItem、菜单未打开时也在跑，只覆盖菜单项实际消费的字段 — id（key/focus）、
  // minimized（前台判定/已最小化标记）、title（条目文案）；条目数由指纹结构隐含。
  const winsKey = useWindowStore((s) =>
    getSortedWindows(s.windows)
      .filter((w) => w.typeId === typeId)
      .map((w) => `${w.id}:${w.minimized ? 1 : 0}:${w.title}`)
      .join('|'),
  );
  // 原始值 selector：焦点栈变化但栈顶不变时不触发重渲染
  const foregroundId = useWindowStore((s) => s.focusStack[s.focusStack.length - 1] ?? null);

  const wins = React.useMemo(
    () => getSortedWindows(useWindowStore.getState().windows).filter((w) => w.typeId === typeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- winsKey 即窗口数据指纹
    [winsKey, typeId],
  );

  const def = appRegistry.get(typeId);
  const appLabel = def ? t(def.nameKey, def.typeId) : typeId;
  const isMulti = def?.instanceMode === 'multi';
  const canOpenNew = isMulti || wins.length === 0;
  // single：始终「打开」（已运行则禁用）；multi 有实例时「新建窗口」
  const openLabel =
    isMulti && wins.length > 0
      ? t('workbench:dock.newWindow')
      : t('workbench:dock.open');

  const handleOpen = () => {
    workbenchBus.launch({ typeId, reason: 'dock' });
  };

  const handleCloseAll = () => {
    const current = Object.values(useWindowStore.getState().windows).filter(
      (w) => w.typeId === typeId,
    );
    void (async () => {
      for (const win of current) {
        await requestCloseAnimated(win.id);
      }
    })();
  };

  return (
    <AppMenu mode="context">
      <AppMenuTrigger asChild>{children}</AppMenuTrigger>
      <AppMenuContent
        width={224}
        className="wb-dockmenu"
        data-testid="wb-dock-context-menu"
      >
        <AppMenuGroup>
          <AppMenuItem
            icon={<Plus size={16} weight="bold" />}
            disabled={!canOpenNew}
            onClick={handleOpen}
          >
            {openLabel}
          </AppMenuItem>
        </AppMenuGroup>

        {wins.length > 0 && (
          <>
            <AppMenuSeparator />
            <AppMenuGroup label={t('workbench:dock.windows')}>
              {wins.map((win) => {
                const isForeground = win.id === foregroundId && !win.minimized;
                return (
                  <AppMenuItem
                    key={win.id}
                    icon={<SquaresFour size={16} />}
                    checked={isForeground}
                    onClick={() => useWindowStore.getState().focusWindow(win.id)}
                    suffix={
                      win.minimized ? (
                        <span className="wb-dockmenu-min-tag">
                          {t('workbench:dock.minimized')}
                        </span>
                      ) : undefined
                    }
                  >
                    <span className="truncate">{win.title || appLabel}</span>
                  </AppMenuItem>
                );
              })}
            </AppMenuGroup>
          </>
        )}

        <AppMenuSeparator />
        <AppMenuGroup>
          <AppMenuItem
            icon={isPinned ? <PushPinSlash size={16} /> : <PushPin size={16} />}
            onClick={() => toggleDockPinned(typeId)}
          >
            {isPinned
              ? t('workbench:dock.unpin')
              : t('workbench:dock.pin')}
          </AppMenuItem>
          {wins.length > 0 && (
            <AppMenuItem
              destructive
              className="wb-dockmenu-destructive"
              icon={<XCircle size={16} />}
              onClick={handleCloseAll}
            >
              {t('workbench:dock.closeAll')}
            </AppMenuItem>
          )}
        </AppMenuGroup>
      </AppMenuContent>
    </AppMenu>
  );
}
