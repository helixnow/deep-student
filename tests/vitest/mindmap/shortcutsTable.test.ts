/**
 * 快捷键单一真源（constants/shortcuts.ts）契约测试（W07 / C6）
 *
 * 锁定内容：
 * 1. getShortcutGroups 的分组顺序、i18n key 前缀、平台格式化输出；
 * 2. keymap 过滤：mubu 专属（drillIn/Out、mod+Enter=完成）与 deep-student
 *    专属（mod+[/] 折叠）互不泄漏；
 * 3. Tab 双义消解：画布 Tab 只出现在 addChild，大纲 Tab 只出现在 indent；
 * 4. eventMatchesShortcut 的修饰符严格匹配语义；
 * 5. 旧导出（SHORTCUTS / OUTLINE_SHORTCUTS / MINDMAP_SHORTCUTS）仍可用。
 */

import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  OUTLINE_SHORTCUTS,
  MINDMAP_SHORTCUTS,
  eventMatchesShortcut,
  formatShortcut,
  getShortcutGroups,
  resolveShortcutKeys,
  type ShortcutGroup,
} from '@/features/mindmap/constants/shortcuts';

function findItem(groups: ShortcutGroup[], groupId: string, action: string) {
  return groups
    .find((g) => g.id === groupId)
    ?.items.find((item) => item.action === action);
}

describe('getShortcutGroups', () => {
  it('returns [general, view, recite] in order with full i18n keys', () => {
    const groups = getShortcutGroups('canvas', 'deep-student', 'mac');
    expect(groups.map((g) => g.id)).toEqual(['general', 'canvas', 'recite']);
    expect(groups[0].titleKey).toBe('mindmap:shortcuts.groupGeneral');
    expect(groups[1].titleKey).toBe('mindmap:shortcuts.groupCanvas');
    expect(groups[2].titleKey).toBe('mindmap:shortcuts.groupRecite');
    for (const group of groups) {
      for (const item of group.items) {
        expect(item.labelKey.startsWith('mindmap:shortcuts.')).toBe(true);
        expect(item.keys.length).toBe(item.combos.length);
        expect(item.keys.length).toBeGreaterThan(0);
      }
    }
  });

  it('switches to outline group for outline view', () => {
    const groups = getShortcutGroups('outline', 'deep-student', 'mac');
    expect(groups.map((g) => g.id)).toEqual(['general', 'outline', 'recite']);
  });

  it('filters keymap-specific bindings: drillIn/out only under mubu', () => {
    const ds = getShortcutGroups('canvas', 'deep-student', 'mac');
    const mubu = getShortcutGroups('canvas', 'mubu', 'mac');
    expect(findItem(ds, 'canvas', 'drillIn')).toBeUndefined();
    expect(findItem(ds, 'canvas', 'drillOut')).toBeUndefined();
    expect(findItem(mubu, 'canvas', 'drillIn')?.combos).toEqual(['mod+]']);
    expect(findItem(mubu, 'canvas', 'drillOut')?.combos).toEqual(['mod+[']);
    expect(findItem(ds, 'canvas', 'toggleComplete')).toBeUndefined();
    expect(findItem(mubu, 'canvas', 'toggleComplete')?.combos).toEqual(['mod+Enter']);
  });

  it('mubu keymap removes mod+[/] from collapse/expand (reserved for drill)', () => {
    const mubu = getShortcutGroups('canvas', 'mubu', 'mac');
    expect(findItem(mubu, 'canvas', 'collapse')?.combos).toEqual(['alt+[']);
    expect(findItem(mubu, 'canvas', 'expand')?.combos).toEqual(['alt+]']);
    const ds = getShortcutGroups('canvas', 'deep-student', 'mac');
    expect(findItem(ds, 'canvas', 'collapse')?.combos).toContain('mod+[');
  });

  it('resolves Tab ambiguity: canvas Tab=addChild only, outline Tab=indent only', () => {
    const canvas = getShortcutGroups('canvas', 'deep-student', 'mac')[1];
    const canvasTabActions = canvas.items
      .filter((item) => item.combos.includes('Tab'))
      .map((item) => item.action);
    expect(canvasTabActions).toEqual(['addChild']);

    const outline = getShortcutGroups('outline', 'deep-student', 'mac')[1];
    const outlineTabActions = outline.items
      .filter((item) => item.combos.includes('Tab'))
      .map((item) => item.action);
    expect(outlineTabActions).toEqual(['indent']);
  });

  it('recite group is isolated to navigation / reveal / exit', () => {
    const recite = getShortcutGroups('canvas', 'deep-student', 'mac')[2];
    expect(recite.items.map((item) => item.action).sort()).toEqual(
      ['reciteExit', 'reciteNavigate', 'reciteReveal'],
    );
  });

  it('includes new bindings: duplicate and alt-arrow moves', () => {
    const groups = getShortcutGroups('canvas', 'deep-student', 'mac');
    expect(findItem(groups, 'canvas', 'duplicate')?.combos).toEqual(['mod+d']);
    expect(findItem(groups, 'canvas', 'moveUp')?.combos).toContain('alt+ArrowUp');
    expect(findItem(groups, 'canvas', 'outdent')?.combos).toContain('alt+ArrowLeft');
    expect(findItem(groups, 'canvas', 'indent')?.combos).toContain('alt+ArrowRight');
    expect(findItem(groups, 'canvas', 'selectAll')?.combos).toEqual(['mod+a']);
  });
});

describe('formatShortcut', () => {
  it('formats mac with tight symbols in HIG order', () => {
    expect(formatShortcut('mod+shift+Enter', 'mac')).toBe('⇧⌘Enter');
    expect(formatShortcut('mod+b', 'mac')).toBe('⌘B');
    expect(formatShortcut('alt+ArrowUp', 'mac')).toBe('⌥↑');
    expect(formatShortcut('Escape', 'mac')).toBe('Esc');
    expect(formatShortcut('Space', 'mac')).toBe('Space');
  });

  it('formats non-mac with + separators', () => {
    expect(formatShortcut('mod+shift+Enter', 'other')).toBe('Ctrl+Shift+Enter');
    expect(formatShortcut('alt+ArrowRight', 'other')).toBe('Alt+→');
    expect(formatShortcut('Delete', 'other')).toBe('Del');
  });
});

describe('eventMatchesShortcut', () => {
  const ev = (key: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}) => ({
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });

  it('accepts meta or ctrl for mod', () => {
    expect(eventMatchesShortcut(ev('d', { meta: true }), 'mod+d')).toBe(true);
    expect(eventMatchesShortcut(ev('d', { ctrl: true }), 'mod+d')).toBe(true);
    expect(eventMatchesShortcut(ev('d'), 'mod+d')).toBe(false);
  });

  it('is strict about extra / missing modifiers', () => {
    expect(eventMatchesShortcut(ev('d', { meta: true, shift: true }), 'mod+d')).toBe(false);
    expect(eventMatchesShortcut(ev('ArrowUp', { alt: true }), 'alt+ArrowUp')).toBe(true);
    expect(eventMatchesShortcut(ev('ArrowUp', { alt: true, meta: true }), 'alt+ArrowUp')).toBe(false);
    expect(eventMatchesShortcut(ev('ArrowUp'), 'alt+ArrowUp')).toBe(false);
  });

  it('matches single-char keys case-insensitively and Space via " "', () => {
    expect(eventMatchesShortcut(ev('D', { meta: true }), 'mod+d')).toBe(true);
    expect(eventMatchesShortcut(ev(' '), 'Space')).toBe(true);
    expect(eventMatchesShortcut(ev('Enter'), 'Enter')).toBe(true);
    expect(eventMatchesShortcut(ev('Enter'), 'Escape')).toBe(false);
  });
});

describe('legacy exports stay usable', () => {
  it('SHORTCUTS keeps well-known entries', () => {
    expect(SHORTCUTS.undo).toContain('mod+z');
    expect(SHORTCUTS.save).toContain('mod+s');
    expect(SHORTCUTS.selectAll).toContain('mod+a');
    expect(SHORTCUTS.duplicate).toContain('mod+d');
    expect(SHORTCUTS.toggleComplete).toContain('mod+Enter');
    expect(SHORTCUTS.drillIn).toContain('mod+]');
  });

  it('per-view tables keep Tab unambiguous', () => {
    expect(MINDMAP_SHORTCUTS.addChild).toContain('Tab');
    expect(MINDMAP_SHORTCUTS.indent ?? []).not.toContain('Tab');
    expect(OUTLINE_SHORTCUTS.indent).toContain('Tab');
    expect(OUTLINE_SHORTCUTS.addChild ?? []).not.toContain('Tab');
  });
});

describe('resolveShortcutKeys', () => {
  it('falls back to default keys and honors keymap overrides', () => {
    const binding = {
      action: 'addChild' as const,
      labelKey: 'addChild',
      keys: ['Tab', 'mod+Enter'],
      keymapKeys: { mubu: ['Tab', 'mod+shift+Enter'] },
    };
    expect(resolveShortcutKeys(binding, 'deep-student')).toEqual(['Tab', 'mod+Enter']);
    expect(resolveShortcutKeys(binding, 'mubu')).toEqual(['Tab', 'mod+shift+Enter']);
  });
});
