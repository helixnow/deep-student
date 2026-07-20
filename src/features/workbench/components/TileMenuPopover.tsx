/**
 * TileMenuPopover（P3 / O4）— 缩放键（绿灯）悬停平铺菜单。
 *
 * 对标 macOS Sequoia 绿灯悬停菜单：3×3 九宫格——
 *   左上 / 填满 / 右上
 *   左半 / 居中 / 右半
 *   左下 / 恢复 / 右下
 * 网格下方追加整行「进入沉浸模式」项（P2：绿灯默认动作的菜单入口）。
 * 按住 ⌥ Option：Fill ⇄ Center 互换（Sequoia+ 的 Option 排布变体）。
 * 方向键在网格与沉浸行间循环移动，Enter/Space 选择，Esc 关闭。
 * 材质一律走 wb-glass 类名契约；进出动画 animationend + 超时兜底卸载。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, ArrowsOutSimple } from '@phosphor-icons/react';
import type { DisplayMode } from '../core/types';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import './TileMenuPopover.css';

export type TileMenuAction =
  | Exclude<DisplayMode, 'floating'>
  | 'center'
  | 'restore'
  | 'immersive';

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
  immersive: 'workbench:tile.immersive',
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

  /**
   * ⌥ Option 变体（对标 macOS Sequoia+：按住 Option 菜单项换排布）：
   * 顶行中格 Fill(maximized) ⇄ 中心格 Center 互换。开菜单期间监听全局
   * Alt 按放；指针带 altKey 进入弹层时也同步（Option 先于菜单打开被按下）。
   */
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    if (phase !== 'open') {
      setAltHeld(false);
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onWindowBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [phase]);

  const grid = useMemo<TileMenuAction[][]>(() => {
    if (!altHeld) return TILE_MENU_GRID;
    return TILE_MENU_GRID.map((row) =>
      row.map((action) =>
        action === 'maximized' ? 'center' : action === 'center' ? 'maximized' : action,
      ),
    );
  }, [altHeld]);

  const rows = grid.length;
  const cols = grid[0].length;

  const finishExit = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    // 竞态加固：只允许 closing → null。快速 hover 关→开时，迟到的退场
    // animationend / 兜底定时器不得把已重新打开（phase='open'）的菜单卸载。
    setPhase((prev) => (prev === 'closing' ? null : prev));
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

  /** 虚拟行数 = 网格行 + 沉浸整行（索引 rows，单项占满一行） */
  const totalRows = rows + 1;
  const immersiveRow = rows;

  const move = (dRow: number, dCol: number) => {
    setActive((prev) => {
      const nextRow = (prev.row + dRow + totalRows) % totalRows;
      // 沉浸行只有一项：水平移动原地循环；离开时恢复进入前的列
      const next = {
        row: nextRow,
        col:
          nextRow === immersiveRow || prev.row === immersiveRow
            ? prev.col
            : (prev.col + dCol + cols) % cols,
      };
      const key = next.row === immersiveRow ? `${immersiveRow}:0` : `${next.row}:${next.col}`;
      itemRefs.current.get(key)?.focus();
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
        onSelect(active.row === immersiveRow ? 'immersive' : grid[active.row][active.col]);
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
      grid.flatMap((row, r) =>
        row.map((action, c) => ({ action, r, c })),
      ),
    [grid],
  );

  if (phase === null) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('workbench:window.tileMenu')}
      data-wb-tile-menu
      data-phase={phase}
      data-wb-tile-alt={altHeld ? 'true' : undefined}
      className="wb-tilemenu wb-glass wb-glass-lens"
      onKeyDown={handleKeyDown}
      onAnimationEnd={handleAnimationEnd}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        onRequestClose({ returnFocus: false });
      }}
      onPointerEnter={(e) => {
        if (phase !== 'open') return;
        // Option 先于菜单打开被按下时，keydown 监听收不到；从指针事件补同步
        setAltHeld(e.altKey);
        onHoverChange?.(true);
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
      {/* P2：沉浸模式整行入口（= 绿灯默认动作的菜单等价物） */}
      <button
        ref={(el) => {
          const key = `${immersiveRow}:0`;
          if (el) itemRefs.current.set(key, el);
          else itemRefs.current.delete(key);
        }}
        type="button"
        role="menuitem"
        aria-label={t(ACTION_LABEL_KEYS.immersive)}
        title={t(ACTION_LABEL_KEYS.immersive)}
        tabIndex={active.row === immersiveRow ? 0 : -1}
        data-wb-tile-action="immersive"
        data-wb-tile-active={active.row === immersiveRow ? 'true' : undefined}
        disabled={phase === 'closing'}
        onFocus={() => setActive((prev) => ({ row: immersiveRow, col: prev.col }))}
        onClick={() => onSelect('immersive')}
        className="wb-tilemenu-item wb-tilemenu-immersive"
      >
        <ArrowsOutSimple size={13} aria-hidden />
        <span className="wb-tilemenu-immersive-label">{t(ACTION_LABEL_KEYS.immersive)}</span>
      </button>
    </div>
  );
};

export default TileMenuPopover;
