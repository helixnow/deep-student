/**
 * TileMenuPopover（P3 / O4）— 缩放键（绿灯）悬停平铺菜单。
 *
 * 对标 macOS Sequoia 绿灯悬停菜单：3×3 九宫格——
 *   左上 / 填满 / 右上
 *   左半 / 居中 / 右半
 *   左下 / 恢复 / 右下
 * 方向键在网格内移动，Enter/Space 选择，Esc 关闭。
 * 材质一律走 wb-glass 类名契约；进出动画 animationend + 超时兜底卸载。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import type { DisplayMode } from '../core/types';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import './TileMenuPopover.css';

export type TileMenuAction = Exclude<DisplayMode, 'floating'> | 'center' | 'restore';

/** 3×3 网格（行优先），空间排布与真实落位方向一致 */
export const TILE_MENU_GRID: TileMenuAction[][] = [
  ['tiled-tl', 'maximized', 'tiled-tr'],
  ['tiled-left', 'center', 'tiled-right'],
  ['tiled-bl', 'restore', 'tiled-br'],
];

/** 退出动画兜底卸载（> --wb-tilemenu-out-duration / --wb-motion-quick） */
export const TILE_MENU_EXIT_FALLBACK_MS = 260;

const ACTION_LABEL_KEYS: Record<TileMenuAction, string> = {
  'tiled-tl': 'workbench:tile.topLeft',
  maximized: 'workbench:tile.fill',
  'tiled-tr': 'workbench:tile.topRight',
  'tiled-left': 'workbench:tile.left',
  center: 'workbench:tile.center',
  'tiled-right': 'workbench:tile.right',
  'tiled-bl': 'workbench:tile.bottomLeft',
  restore: 'workbench:tile.restore',
  'tiled-br': 'workbench:tile.bottomRight',
};

type GlyphCell = { slot: string; active: boolean };

/** 每个平铺选项的微缩桌面示意：高亮当前窗 + 淡化其余区域 */
function glyphCellsFor(action: TileMenuAction): GlyphCell[] {
  switch (action) {
    case 'tiled-left':
      return [
        { slot: 'cell-left', active: true },
        { slot: 'cell-right', active: false },
      ];
    case 'tiled-right':
      return [
        { slot: 'cell-left', active: false },
        { slot: 'cell-right', active: true },
      ];
    case 'tiled-tl':
      return [
        { slot: 'cell-tl', active: true },
        { slot: 'cell-tr', active: false },
        { slot: 'cell-bl', active: false },
        { slot: 'cell-br', active: false },
      ];
    case 'tiled-tr':
      return [
        { slot: 'cell-tl', active: false },
        { slot: 'cell-tr', active: true },
        { slot: 'cell-bl', active: false },
        { slot: 'cell-br', active: false },
      ];
    case 'tiled-bl':
      return [
        { slot: 'cell-tl', active: false },
        { slot: 'cell-tr', active: false },
        { slot: 'cell-bl', active: true },
        { slot: 'cell-br', active: false },
      ];
    case 'tiled-br':
      return [
        { slot: 'cell-tl', active: false },
        { slot: 'cell-tr', active: false },
        { slot: 'cell-bl', active: false },
        { slot: 'cell-br', active: true },
      ];
    case 'maximized':
      return [{ slot: 'cell-fill', active: true }];
    case 'center':
      return [
        { slot: 'cell-desktop-dim', active: false },
        { slot: 'cell-center', active: true },
      ];
    default:
      return [];
  }
}

const ZoneGlyph: React.FC<{ action: TileMenuAction }> = ({ action }) => {
  if (action === 'restore') {
    return (
      <span className="wb-tilemenu-restore" aria-hidden>
        <ArrowCounterClockwise size={14} />
      </span>
    );
  }
  const cells = glyphCellsFor(action);
  return (
    <span className="wb-tilemenu-glyph" data-wb-tile-glyph={action} aria-hidden>
      {cells.map(({ slot, active }) => (
        <span
          key={slot}
          className={`wb-tilemenu-glyph-cell ${slot} ${active ? 'is-active' : 'is-dim'}`}
        />
      ))}
    </span>
  );
};

export interface TileMenuPopoverProps {
  open: boolean;
  /** 当前窗口显示模式（用于高亮当前态） */
  currentMode: DisplayMode;
  onSelect: (action: TileMenuAction) => void;
  onRequestClose: (options?: { returnFocus?: boolean }) => void;
  /** 键盘打开时聚焦网格；纯 hover 打开必须保留原焦点。 */
  autoFocus?: boolean;
  /** 指针进出弹层（父级用于维持 hover 打开状态） */
  onHoverChange?: (hovering: boolean) => void;
}

export const TileMenuPopover: React.FC<TileMenuPopoverProps> = ({
  open,
  currentMode,
  onSelect,
  onRequestClose,
  autoFocus = true,
  onHoverChange,
}) => {
  const { t } = useTranslation('workbench');
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 1, col: 1 });
  /** 退场动画期间保持挂载；null = 从未打开过 */
  const [phase, setPhase] = useState<'open' | 'closing' | null>(open ? 'open' : null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useLiquidGlassLens(menuRef, phase === 'open' || phase === 'closing');

  const rows = TILE_MENU_GRID.length;
  const cols = TILE_MENU_GRID[0].length;

  const finishExit = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setPhase(null);
  };

  useEffect(() => {
    if (open) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setPhase('open');
      setActive({ row: 1, col: 1 });
      if (autoFocus) {
        const raf = requestAnimationFrame(() => {
          itemRefs.current.get('1:1')?.focus();
        });
        return () => cancelAnimationFrame(raf);
      }
      return undefined;
    }
    if (phase === null) return undefined;
    setPhase('closing');
    exitTimerRef.current = setTimeout(finishExit, TILE_MENU_EXIT_FALLBACK_MS);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
    // phase 故意不入依赖：关闭路径只由 open 翻转驱动，避免 closing→null 再入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [open, autoFocus]);

  const move = (dRow: number, dCol: number) => {
    setActive((prev) => {
      const next = {
        row: (prev.row + dRow + rows) % rows,
        col: (prev.col + dCol + cols) % cols,
      };
      itemRefs.current.get(`${next.row}:${next.col}`)?.focus();
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (phase === 'closing') return;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        move(-1, 0);
        break;
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        move(1, 0);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        move(0, -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        move(0, 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        onSelect(TILE_MENU_GRID[active.row][active.col]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onRequestClose({ returnFocus: true });
        break;
      case 'Tab':
        // 允许浏览器执行正常 Tab 顺序，只关闭弹层且不抢回缩放键。
        onRequestClose({ returnFocus: false });
        break;
      default:
        break;
    }
  };

  const handleAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (phase !== 'closing') return;
    finishExit();
  };

  const flat = useMemo(
    () =>
      TILE_MENU_GRID.flatMap((row, r) =>
        row.map((action, c) => ({ action, r, c })),
      ),
    [],
  );

  if (phase === null) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('workbench:window.tileMenu')}
      data-wb-tile-menu
      data-phase={phase}
      className="wb-tilemenu wb-glass wb-glass-lens"
      onKeyDown={handleKeyDown}
      onAnimationEnd={handleAnimationEnd}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        onRequestClose({ returnFocus: false });
      }}
      onPointerEnter={() => {
        if (phase === 'open') onHoverChange?.(true);
      }}
      onPointerLeave={() => {
        if (phase === 'open') onHoverChange?.(false);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {flat.map(({ action, r, c }) => {
        const isActive = active.row === r && active.col === c;
        const isCurrent =
          action !== 'center' && action !== 'restore' && action === currentMode;
        const label = t(ACTION_LABEL_KEYS[action]);
        return (
          <button
            key={action}
            ref={(el) => {
              if (el) itemRefs.current.set(`${r}:${c}`, el);
              else itemRefs.current.delete(`${r}:${c}`);
            }}
            type="button"
            role="menuitem"
            aria-label={label}
            title={label}
            aria-current={isCurrent || undefined}
            tabIndex={isActive ? 0 : -1}
            data-wb-tile-action={action}
            data-wb-tile-active={isActive ? 'true' : undefined}
            data-wb-tile-current={isCurrent ? 'true' : undefined}
            disabled={phase === 'closing'}
            onFocus={() => setActive({ row: r, col: c })}
            onClick={() => onSelect(action)}
            className="wb-tilemenu-item"
          >
            <ZoneGlyph action={action} />
          </button>
        );
      })}
    </div>
  );
};

export default TileMenuPopover;
