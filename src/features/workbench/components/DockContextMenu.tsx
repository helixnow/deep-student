/**
 * DockContextMenu（P5 → O6）— Dock 应用项右键菜单
 *
 * 复用 app-menu context 模式，外壳用 wb-dockmenu- 覆盖玻璃材质 / 升起动画。
 * 菜单行来自 `app.menu` 的 `workbench.dock`（无 UI 内核时用同一张官方表，见
 * ui-plugins/official/menu/dockMenu.tsx）：
 * - 「打开 / 新建窗口」
 * - （运行中）逐窗列表：前台窗口勾选标记；点击聚焦
 * - 固定 / 取消固定
 * - （运行中）关闭全部窗口（destructive；逐窗走 requestCloseAnimated）
 * 分隔线把行分组；带标题的分隔线给其后一组加组标题，组内行文案截断。
 *
 * 关闭链路：AppMenuContent 用 setTimeout(--dropdown-close-dur) 兜底卸载，
 * 不依赖 transitionend；reduced-motion 下 transition:none 也不会卡住。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AppMenuDock } from '@/ui-sdk';
import { officialDockMenuEntries } from '@/ui-plugins/official/menu/dockMenu';
import { inlineAppMenuSubmenus, type ResolvedAppMenuItem } from '@/ui-plugins/official/menu/appMenu';
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
import { useDockPinned } from './DockPinnedStore';
import { useAppMenuRows } from './appMenuHost';
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
  const dock: AppMenuDock = {
    typeId,
    appLabel,
    instanceMode: def?.instanceMode,
    windows: wins.map((win) => ({ id: win.id, label: win.title || appLabel, minimized: Boolean(win.minimized) })),
    foregroundWindowId: foregroundId,
    pinned: isPinned,
  };

  return (
    <AppMenu mode="context">
      <AppMenuTrigger asChild>{children}</AppMenuTrigger>
      <AppMenuContent
        width={224}
        className="wb-dockmenu"
        data-testid="wb-dock-context-menu"
      >
        <DockMenuRows dock={dock} />
      </AppMenuContent>
    </AppMenu>
  );
}

interface DockMenuGroup {
  key: string;
  /** 有 = 组前有分隔线；`label` 为组标题 */
  separator?: { label?: string };
  rows: ResolvedAppMenuItem[];
}

/** 菜单打开时才渲染（AppMenuContent 关闭即卸载子树），关闭态不解析行 */
function DockMenuRows({ dock }: { dock: AppMenuDock }) {
  const rows = inlineAppMenuSubmenus(useAppMenuRows('workbench.dock', dock, officialDockMenuEntries));
  const groups: DockMenuGroup[] = [];
  for (const row of rows) {
    if (row.kind === 'separator') groups.push({ key: row.key, separator: { label: row.label }, rows: [] });
    else if (groups.length === 0) groups.push({ key: row.key, rows: [row] });
    else groups[groups.length - 1].rows.push(row);
  }
  return (
    <>
      {groups.map((group) => (
        <React.Fragment key={group.key}>
          {group.separator && <AppMenuSeparator />}
          <AppMenuGroup label={group.separator?.label}>
            {group.rows.map((row) => {
              const run = row.run;
              return (
                <AppMenuItem
                  key={row.key}
                  icon={row.icon}
                  shortcut={row.shortcut}
                  disabled={row.disabled}
                  checked={row.checked}
                  destructive={row.danger}
                  className={row.danger ? 'wb-dockmenu-destructive' : undefined}
                  suffix={row.suffix ? <span className="wb-dockmenu-min-tag">{row.suffix}</span> : undefined}
                  data-testid={row.testId}
                  {...(row.radio ? { role: 'menuitemradio', 'aria-checked': Boolean(row.checked) } : {})}
                  onClick={(event) => {
                    if (!run || row.closeOnRun === false) event.preventDefault();
                    run?.();
                  }}
                >
                  {group.separator?.label ? <span className="truncate">{row.label}</span> : row.label}
                </AppMenuItem>
              );
            })}
          </AppMenuGroup>
        </React.Fragment>
      ))}
    </>
  );
}
