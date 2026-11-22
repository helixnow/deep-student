/**
 * Crepe 桌面端浮动块操作菜单（Portal）与目标块高亮层
 *
 * 承载块菜单的动作元信息（Turn into / 块操作 / 页面布局）、图标与文案映射，
 * 以及挂载到 document.body 的浮动菜单与目标块浅底高亮覆盖层。
 */

import React from 'react';
import { createPortal } from 'react-dom';
import i18next from 'i18next';
import {
  TextT,
  TextHOne,
  TextHTwo,
  TextHThree,
  ListBullets,
  ListNumbers,
  CheckSquare,
  Quotes,
  Code,
  Info,
  CaretRight,
  Copy,
  Trash,
  LinkSimple,
  ArrowBendUpRight,
  Columns,
  type Icon,
} from '@phosphor-icons/react';
import { canExecuteCrepeCommand, LAYOUT_COMMANDS, isLayoutCommand } from './commandRegistry';
import { layoutCommandLabel } from './commandMenus';
import { officialBlockMenuEntries, type BlockMenuContributionRow } from './blockMenuContributions';
import type { CrepeBlockTurnInto } from './blockMenuCommands';
import type { BlockTarget } from './blockTarget';
import type { CrepeBlockActionsHost } from './types';

export type BlockMenuState = {
  target: BlockTarget;
  noteId: string | undefined;
  x: number;
  y: number;
  /** Merged official/community rows of this open; the target is fixed while the menu stays open. */
  rows?: readonly BlockMenuContributionRow[];
} | null;

export type BlockMenuHighlight = {
  pos: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BlockMenuAction =
  | CrepeBlockTurnInto
  | typeof LAYOUT_COMMANDS[number]
  | 'duplicate'
  | 'delete'
  | 'copy-block-link'
  | 'move-to-note';

export type BlockTransferState = {
  noteId: string;
  blockIds: string[];
  host: CrepeBlockActionsHost;
} | null;

/** turn-into 目标（渲染顺序即键盘导航顺序） */
export const BLOCK_MENU_TURN_INTO_ACTIONS: readonly CrepeBlockTurnInto[] = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'task-list',
  'quote',
  'code-block',
  'callout',
  'toggle',
];

export const BLOCK_MENU_ICONS: Partial<Record<BlockMenuAction, Icon>> = {
  paragraph: TextT,
  'heading-1': TextHOne,
  'heading-2': TextHTwo,
  'heading-3': TextHThree,
  'bullet-list': ListBullets,
  'ordered-list': ListNumbers,
  'task-list': CheckSquare,
  quote: Quotes,
  'code-block': Code,
  callout: Info,
  toggle: CaretRight,
  duplicate: Copy,
  delete: Trash,
  'copy-block-link': LinkSimple,
  'move-to-note': ArrowBendUpRight,
};

export function getBlockMenuActionLabel(action: BlockMenuAction): string {
  if (isLayoutCommand(action)) return layoutCommandLabel(action);
  switch (action) {
    case 'paragraph': return i18next.t('notes:blockMenu.paragraph', 'Text');
    case 'heading-1': return i18next.t('notes:blockMenu.heading1', 'Heading 1');
    case 'heading-2': return i18next.t('notes:blockMenu.heading2', 'Heading 2');
    case 'heading-3': return i18next.t('notes:blockMenu.heading3', 'Heading 3');
    case 'heading-4': return i18next.t('notes:blockMenu.heading4', 'Heading 4');
    case 'heading-5': return i18next.t('notes:blockMenu.heading5', 'Heading 5');
    case 'heading-6': return i18next.t('notes:blockMenu.heading6', 'Heading 6');
    case 'bullet-list': return i18next.t('notes:blockMenu.bulletList', 'Bulleted list');
    case 'ordered-list': return i18next.t('notes:blockMenu.orderedList', 'Numbered list');
    case 'task-list': return i18next.t('notes:slashMenu.listGroup.taskList', 'To-do list');
    case 'quote': return i18next.t('notes:blockMenu.quote', 'Quote');
    case 'code-block': return i18next.t('notes:slashMenu.advancedGroup.codeBlock', 'Code block');
    case 'callout': return i18next.t('notes:slashMenu.advancedGroup.callout', 'Callout');
    case 'toggle': return i18next.t('notes:toggle.slashLabel', 'Toggle list');
    case 'duplicate': return i18next.t('notes:blockMenu.duplicate', 'Duplicate');
    case 'delete': return i18next.t('notes:blockMenu.delete', 'Delete');
    case 'copy-block-link': return i18next.t('notes:blockMenu.copyBlockLink', '复制块链接');
    case 'move-to-note': return i18next.t('notes:blockMenu.moveToNote', '移动到其他笔记…');
  }
}

// RUST-FIX(RF-W18-block-menu-contributions): official segments and community rows share slot order.
export function desktopBlockEntries(
  view: BlockTarget['view'],
  target: BlockTarget,
  run: (action: BlockMenuAction) => void,
  blocked: (action: BlockMenuAction, target: BlockTarget) => string | undefined,
) {
  return officialBlockMenuEntries((segment) => {
    const actions = segment === 'insert'
      ? []
      : segment === 'turn-into'
        ? BLOCK_MENU_TURN_INTO_ACTIONS
        : segment === 'actions'
          ? (['duplicate', 'delete', 'copy-block-link', 'move-to-note'] as const)
          : LAYOUT_COMMANDS;
    return actions.map((action) => ({
      id: action,
      label: getBlockMenuActionLabel(action),
      disabled:
        Boolean(blocked(action, target))
        || (action !== 'copy-block-link'
          && action !== 'move-to-note'
          && !canExecuteCrepeCommand(view, action, { target })),
      run: () => run(action),
    }));
  });
}

export interface CrepeBlockMenuProps {
  blockMenu: BlockMenuState;
  blockMenuElRef: React.RefObject<HTMLDivElement | null>;
  blockMenuActive: number;
  blockMenuHighlights: readonly BlockMenuHighlight[];
  identityActionBlockedReason: (action: BlockMenuAction, target: BlockTarget) => string | undefined;
  onActiveIndexChange: (index: number) => void;
  onRunContributedRow: (item: BlockMenuContributionRow) => void;
}

/**
 * Portal 到 body：编辑器可能位于带 transform 的移动端滑动轨道内，
 * position:fixed 会相对轨道定位导致菜单错位（外点关闭仍按 .crepe-block-menu 类判定，不受影响）。
 */
export const CrepeBlockMenu: React.FC<CrepeBlockMenuProps> = ({
  blockMenu,
  blockMenuElRef,
  blockMenuActive,
  blockMenuHighlights,
  identityActionBlockedReason,
  onActiveIndexChange,
  onRunContributedRow,
}) => {
  if (!blockMenu) return null;

  return (
    <>
      {createPortal(
        <div
          ref={blockMenuElRef}
          className="crepe-block-menu"
          role="menu"
          tabIndex={-1}
          aria-label={i18next.t('notes:blockMenu.label', 'Block actions')}
          style={{ left: blockMenu.x, top: blockMenu.y }}
        >
          <div className="crepe-block-menu__label">
            {i18next.t('notes:blockMenu.turnInto', 'Turn into')}
          </div>
          {(blockMenu.rows ?? []).map(({ entry, row }, index) => {
            if (entry.origin !== 'builtin') {
              const RowIcon = row.icon;
              return (
                <React.Fragment key={`${entry.owner}:${entry.id}:${row.id}:${index}`}>
                  <div className="crepe-block-menu__separator" />
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={blockMenuActive === index ? 0 : -1}
                    data-active={blockMenuActive === index || undefined}
                    data-command={row.id}
                    data-destructive={row.destructive || undefined}
                    disabled={row.disabled === true}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    onClick={() => onRunContributedRow({ entry, row })}
                  >
                    <span className="crepe-block-menu__icon" aria-hidden="true">
                      {RowIcon && <RowIcon size={16} />}
                    </span>
                    <span className="crepe-block-menu__text">{row.label}</span>
                  </button>
                </React.Fragment>
              );
            }

            const action = row.id as BlockMenuAction;
            const isActive = blockMenuActive === index;
            const blockedReason = identityActionBlockedReason(action, blockMenu.target);
            const ActionIcon = BLOCK_MENU_ICONS[action] ?? Columns;

            const button = (
              <button
                key={action}
                type="button"
                role="menuitem"
                tabIndex={isActive ? 0 : -1}
                data-active={isActive || undefined}
                data-block-command={action}
                data-destructive={action === 'delete' || undefined}
                disabled={
                  (action !== 'copy-block-link'
                    && action !== 'move-to-note'
                    && !canExecuteCrepeCommand(blockMenu.target.view, action, { target: blockMenu.target }))
                  || Boolean(blockedReason)
                }
                title={blockedReason}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => {
                  if (!row.disabled) row.run(blockMenu.target.view);
                }}
              >
                <ActionIcon className="crepe-block-menu__icon" size={16} aria-hidden="true" />
                <span className="crepe-block-menu__text">{getBlockMenuActionLabel(action)}</span>
              </button>
            );

            // 分组：turn-into → 块操作 → 页面布局
            if (action === 'duplicate' || action === LAYOUT_COMMANDS[0]) {
              return (
                <React.Fragment key={action}>
                  <div className="crepe-block-menu__separator" />
                  {action !== 'duplicate' && (
                    <div className="crepe-block-menu__label">
                      {i18next.t('notes:layout.label', '页面布局')}
                    </div>
                  )}
                  {button}
                </React.Fragment>
              );
            }
            return button;
          })}
        </div>,
        document.body,
      )}
      {createPortal(
        <div aria-hidden="true" data-block-menu-range="true" style={{ pointerEvents: 'none' }}>
          {blockMenuHighlights.map((rect) => (
            <div
              key={rect.pos}
              data-block-menu-target-pos={rect.pos}
              style={{
                position: 'fixed',
                pointerEvents: 'none',
                zIndex: 'calc(var(--z-popover, 1200) - 1)',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                // Notion：被操作的块只铺一层浅蓝底，不描边
                background: 'hsl(var(--primary) / 0.12)',
                borderRadius: 4,
              }}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};
