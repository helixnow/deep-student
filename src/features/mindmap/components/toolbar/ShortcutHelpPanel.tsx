/**
 * 快捷键帮助内联面板
 *
 * 从 MindMapContentView 抽出的独立组件，并从「画布右上角浮动卡片」
 * 内联化为工具栏下方文档流面板（与 VersionHistoryPanel 同范式，无遮罩）。
 *
 * W07 契约：结构化快捷键表 getShortcutGroups(view, keymap, platform)。
 * normalizeShortcutGroups 是该契约的防御性归一化——字段名差异
 * （items/shortcuts、label/labelKey/description）时降级而非崩溃；
 * 契约本体（constants/shortcuts.ts）归 C 代理，此处只做消费侧修正。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowLeft, Keyboard, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { getShortcutGroups, detectShortcutPlatform } from '../../constants/shortcuts';
import { useCanvasDragMode } from '../../hooks/useCanvasDragMode';
import type { MindMapKeymap } from '../../utils/mindmapPreferences';

// ============================================================================
// W07 键表归一化（防御性）
// ============================================================================

export interface NormalizedShortcutItem {
  keys: string[];
  label: string;
}

export interface NormalizedShortcutGroup {
  id: string;
  title: string;
  items: NormalizedShortcutItem[];
}

/**
 * 把 W07 getShortcutGroups 的返回值归一化为 { title, items:[{keys,label}] }。
 * 兼容 items/shortcuts 两种字段名与 label/labelKey/description 三种文案来源，
 * 结构完全不符时返回空数组（面板会退化为只显示键位方案说明与背诵组）。
 */
export function normalizeShortcutGroups(raw: unknown, t: TFunction): NormalizedShortcutGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((group, groupIndex): NormalizedShortcutGroup => {
      const g = (group ?? {}) as Record<string, unknown>;
      const rawItems = (
        Array.isArray(g.items) ? g.items : Array.isArray(g.shortcuts) ? g.shortcuts : []
      ) as unknown[];
      const title =
        typeof g.title === 'string'
          ? g.title
          : typeof g.titleKey === 'string'
            ? t(g.titleKey, { defaultValue: g.titleKey })
            : '';
      const items = rawItems
        .map((item): NormalizedShortcutItem => {
          const it = (item ?? {}) as Record<string, unknown>;
          const keys = Array.isArray(it.keys)
            ? it.keys.map(String)
            : typeof it.keys === 'string'
              ? [it.keys]
              : Array.isArray(it.combos)
                ? it.combos.map(String)
                : [];
          const label =
            typeof it.label === 'string'
              ? it.label
              : typeof it.labelKey === 'string'
                ? t(it.labelKey, { defaultValue: it.labelKey })
                : typeof it.description === 'string'
                  ? it.description
                  : '';
          return { keys, label };
        })
        .filter((item) => item.keys.length > 0 && item.label);
      return {
        id: typeof g.id === 'string' ? g.id : `group-${groupIndex}`,
        title,
        items,
      };
    })
    .filter((group) => group.items.length > 0);
}

// ============================================================================
// 展示子组件
// ============================================================================

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd
    className={cn(
      'px-1.5 py-0.5 rounded-[4px] text-[11px] leading-none whitespace-nowrap',
      'border border-[var(--mm-border)] border-b-2 bg-[var(--mm-bg)]',
      'text-[var(--mm-text-secondary)] font-medium shadow-sm',
    )}
  >
    {children}
  </kbd>
);

const ShortcutRow: React.FC<NormalizedShortcutItem> = ({ keys, label }) => (
  <div className="flex items-center justify-between gap-3 py-1 min-w-0">
    <span className="text-[13px] text-[var(--mm-text-secondary)] truncate">{label}</span>
    <span className="flex items-center gap-1 flex-shrink-0">
      {keys.map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </span>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export interface ShortcutHelpPanelProps {
  /** store 的当前视图（'mindmap' | 'outline'；W07 键表内部视图键为 canvas/outline） */
  view: 'outline' | 'mindmap';
  keymap: MindMapKeymap;
  onClose: () => void;
  className?: string;
  /** 移动端全屏子屏：使用统一返回顶栏，并允许内容占满剩余高度 */
  mobile?: boolean;
}

export const ShortcutHelpPanel: React.FC<ShortcutHelpPanelProps> = ({
  view,
  keymap,
  onClose,
  className,
  mobile = false,
}) => {
  const { t } = useTranslation(['mindmap']);
  // 画布空白拖拽模式（框选/平移）：手势提示按当前模式展示对应操作
  const [canvasDragMode] = useCanvasDragMode();

  const allGroups = useMemo(() => {
    const platform = detectShortcutPlatform();
    let groups: NormalizedShortcutGroup[] = [];
    try {
      // W07 键表的视图键为 'canvas' | 'outline'（store 的 currentView 是 'mindmap' | 'outline'）
      groups = normalizeShortcutGroups(
        getShortcutGroups(view === 'mindmap' ? 'canvas' : 'outline', keymap, platform),
        t,
      );
    } catch (error) {
      console.error('[ShortcutHelpPanel] getShortcutGroups failed:', error);
    }

    // 画布手势提示（依赖运行时拖拽模式，不属于 W07 静态键表）
    const gestureGroup: NormalizedShortcutGroup = {
      id: 'canvas-gestures',
      title: t('mindmap:shortcuts.groupCanvas'),
      items: [
        {
          keys: [
            canvasDragMode === 'pan'
              ? t('mindmap:shortcuts.marqueeSelectKeysPanMode', { defaultValue: '⇧ + 拖拽空白处' })
              : t('mindmap:shortcuts.marqueeSelectKeys', { defaultValue: '拖拽空白处' }),
          ],
          label: t('mindmap:shortcuts.marqueeSelect', { defaultValue: '框选多选节点' }),
        },
        {
          keys: [
            canvasDragMode === 'pan'
              ? t('mindmap:shortcuts.panCanvasKeysPanMode', { defaultValue: '拖拽空白处' })
              : t('mindmap:shortcuts.panCanvasKeys', { defaultValue: 'Space / 中键 / 右键 + 拖拽' }),
          ],
          label: t('mindmap:shortcuts.panCanvas', { defaultValue: '平移画布' }),
        },
        {
          keys: [t('mindmap:shortcuts.associationEntryKeys', { defaultValue: '右键节点' })],
          label: t('mindmap:shortcuts.associationAdd', { defaultValue: '添加关联线（再点目标）' }),
        },
      ],
    };

    // 背诵模式快捷键组：W07 表未覆盖时补齐（导航/揭示/退出）
    const reciteTitle = t('mindmap:shortcuts.groupRecite');
    const hasReciteGroup = groups.some(
      (group) => group.id.toLowerCase().includes('recite') || group.title === reciteTitle,
    );
    const reciteGroup: NormalizedShortcutGroup = {
      id: 'recite',
      title: reciteTitle,
      items: [
        { keys: ['↑ ↓ ← →'], label: t('mindmap:shortcuts.reciteNavigate') },
        { keys: ['Enter', 'Space'], label: t('mindmap:shortcuts.reciteReveal') },
        { keys: ['Esc'], label: t('mindmap:shortcuts.reciteExit') },
      ],
    };

    return [
      ...groups,
      ...(view === 'mindmap' ? [gestureGroup] : []),
      ...(hasReciteGroup ? [] : [reciteGroup]),
    ];
  }, [view, keymap, canvasDragMode, t]);

  return (
    <div
      className={cn(
        'flex flex-col border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)]',
        mobile && 'h-full min-h-0 border-b-0 bg-[var(--mm-bg)]',
        className,
      )}
      role="region"
      aria-label={t('mindmap:shortcuts.title')}
    >
      <div className={cn(
        'flex items-center gap-2 px-4 py-2 border-b border-[var(--mm-border)]',
        mobile && 'mm-mobile-subview-header',
      )}>
        {mobile ? (
          <DsButton
            variant="ghost"
            className="mm-mobile-subview-back"
            onClick={onClose}
            aria-label={t('mindmap:toolbar.closeShortcuts')}
          >
            <ArrowLeft size={20} />
          </DsButton>
        ) : (
          <Keyboard size={15} className="shrink-0 text-[var(--mm-text-muted)]" />
        )}
        <h3 className="text-sm font-medium flex-1 text-[var(--mm-text)]">
          {t('mindmap:shortcuts.title')}
        </h3>
        <span className="text-xs text-[var(--mm-text-muted)] hidden md:inline">
          {keymap === 'classic'
            ? t('mindmap:preferences.classicKeymapActive')
            : t('mindmap:preferences.deepStudentKeymapActive')}
        </span>
        {!mobile && (
          <DsButton
            variant="ghost"
            className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
            onClick={onClose}
            aria-label={t('mindmap:toolbar.closeShortcuts')}
          >
            <X className="w-4 h-4" />
          </DsButton>
        )}
      </div>

      <CustomScrollArea
        className={cn(
          'max-h-72',
          mobile && 'max-h-none flex-1 min-h-0',
        )}
        viewportClassName={cn(
          'max-h-72 px-4 py-3',
          mobile && 'mm-mobile-subview-scroll max-h-none',
        )}
        fullHeight={false}
      >
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {allGroups.map((group) => (
            <div key={group.id} className="min-w-0">
              <div className="text-[11px] font-medium text-[var(--mm-text-muted)] uppercase tracking-wide mb-1.5">
                {group.title}
              </div>
              {group.items.map((item, itemIndex) => (
                <ShortcutRow key={itemIndex} keys={item.keys} label={item.label} />
              ))}
            </div>
          ))}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default ShortcutHelpPanel;
