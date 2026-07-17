/**
 * 补全浮层通用层（mention `@` 与 wikilink `[[` 共享）。
 *
 * 统一以下此前在两处各写一份、易漂移的逻辑：
 * - floating-ui 定位 + autoUpdate 绑定
 * - 单一虚拟锚点复用（避免每次查询都 create/remove body 节点）
 * - listbox / option 角色、方向键选中态、入场动画重放、mousedown 防抢焦点
 *
 * 各插件仅需提供 className 前缀与 decorateItem / renderPlaceholder。
 */

import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from '@floating-ui/dom';
import type { EditorView } from '@milkdown/prose/view';

/** 锚点矩形（取自 view.coordsAtPos，视口坐标） */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export type PlaceholderKind = 'empty' | 'loading';

export interface SuggestOverlayConfig<T> {
  /** BEM 基类，如 'crepe-wikilink-suggest'（沿用既有 CSS，不改类名） */
  className: string;
  /** 填充单个选项按钮的内容 / 附加类（选中态由通用层统一处理） */
  decorateItem: (row: HTMLButtonElement, item: T) => void;
  /** 无选项时的占位节点；返回 null 表示不渲染 */
  renderPlaceholder: (kind: PlaceholderKind) => HTMLElement | null;
}

export interface SuggestOverlay<T> {
  /** 打开或复用浮层；rect 为锚点位置，placeholder 决定空态文案 */
  open: (
    rect: AnchorRect,
    items: T[],
    onPick: (item: T) => void,
    placeholder?: PlaceholderKind,
  ) => void;
  /** 更新选项与选中项（不改锚点） */
  update: (items: T[], selectedIndex?: number, placeholder?: PlaceholderKind) => void;
  /** 仅重定位锚点（签名未变、光标移动时） */
  moveAnchor: (rect: AnchorRect) => void;
  setSelected: (index: number) => void;
  close: () => void;
  isOpen: () => boolean;
  getSelectedIndex: () => number;
  getItems: () => T[];
}

/** 从编辑器位置换算锚点矩形 */
export function anchorRectFromView(view: EditorView, pos: number): AnchorRect {
  const coords = view.coordsAtPos(pos);
  return { left: coords.left, top: coords.top, bottom: coords.bottom };
}

export function createSuggestOverlay<T>(
  config: SuggestOverlayConfig<T>,
): SuggestOverlay<T> {
  const { className, decorateItem, renderPlaceholder } = config;

  let root: HTMLDivElement | null = null;
  let anchorEl: HTMLDivElement | null = null;
  let cleanupAutoUpdate: (() => void) | null = null;
  let items: T[] = [];
  let selectedIndex = 0;
  let placeholder: PlaceholderKind = 'empty';
  let onPick: ((item: T) => void) | null = null;

  const ensureRoot = (): HTMLDivElement => {
    if (root) return root;
    const el = document.createElement('div');
    el.className = className;
    el.setAttribute('role', 'listbox');
    // 点浮层不夺走编辑器焦点（保持选区，applyPick 才能替换触发文本）
    el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(el);
    root = el;
    return el;
  };

  /** 单一虚拟锚点：仅在首次创建，之后复位而非重建 */
  const ensureAnchor = (): HTMLDivElement => {
    if (anchorEl) return anchorEl;
    const el = document.createElement('div');
    el.className = `${className}-anchor`;
    Object.assign(el.style, {
      position: 'fixed',
      width: '0px',
      pointerEvents: 'none',
      opacity: '0',
    });
    document.body.appendChild(el);
    anchorEl = el;
    return el;
  };

  const bindAutoUpdate = (anchor: HTMLElement, floating: HTMLElement) => {
    cleanupAutoUpdate?.();
    cleanupAutoUpdate = autoUpdate(anchor, floating, () => {
      void computePosition(anchor, floating, {
        placement: 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
      });
    });
  };

  const positionAnchor = (rect: AnchorRect): HTMLDivElement => {
    const el = ensureAnchor();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.height = `${Math.max(1, rect.bottom - rect.top)}px`;
    return el;
  };

  const render = () => {
    const el = ensureRoot();
    el.replaceChildren();

    if (items.length === 0) {
      const node = renderPlaceholder(placeholder);
      if (node) el.appendChild(node);
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `${className}__item`;
      if (index === selectedIndex) {
        row.classList.add(`${className}__item--active`);
      }
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
      decorateItem(row, item);
      row.addEventListener('click', () => onPick?.(item));
      el.appendChild(row);
    });
  };

  const replayEnterAnimation = (el: HTMLElement) => {
    const enterClass = `${className}--enter`;
    el.classList.remove(enterClass);
    void el.offsetWidth;
    el.classList.add(enterClass);
  };

  const clampSelection = (index: number): number =>
    items.length === 0 ? 0 : Math.max(0, Math.min(index, items.length - 1));

  return {
    open(rect, nextItems, pick, nextPlaceholder = 'empty') {
      items = nextItems;
      selectedIndex = 0;
      placeholder = nextPlaceholder;
      onPick = pick;
      const el = ensureRoot();
      el.style.display = 'block';
      replayEnterAnimation(el);
      render();
      bindAutoUpdate(positionAnchor(rect), el);
    },
    update(nextItems, index = 0, nextPlaceholder) {
      items = nextItems;
      if (nextPlaceholder) placeholder = nextPlaceholder;
      selectedIndex = clampSelection(index);
      if (root) render();
    },
    moveAnchor(rect) {
      if (!root || root.style.display === 'none') return;
      bindAutoUpdate(positionAnchor(rect), root);
    },
    setSelected(index) {
      if (items.length === 0) return;
      // 环绕：-1 → 末项，末项+1 → 首项
      selectedIndex = ((index % items.length) + items.length) % items.length;
      if (root) render();
    },
    close() {
      cleanupAutoUpdate?.();
      cleanupAutoUpdate = null;
      onPick = null;
      if (root) {
        root.style.display = 'none';
        root.replaceChildren();
      }
      // 复用锚点：仅移出视口，不销毁 DOM（下次 open 复位）
      if (anchorEl) {
        anchorEl.style.height = '0px';
      }
      items = [];
      selectedIndex = 0;
      placeholder = 'empty';
    },
    isOpen: () => Boolean(root && root.style.display !== 'none' && root.isConnected),
    getSelectedIndex: () => selectedIndex,
    getItems: () => items,
  };
}
