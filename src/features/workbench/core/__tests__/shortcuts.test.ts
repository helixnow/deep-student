/**
 * shortcuts — macOS 修饰键语义映射（P0）单测。
 *
 * 覆盖两个平台语义下的：
 * - matchWorkbenchShortcut 匹配（ctrl→⌘ / Ctrl+Alt→⌘⌥ / Ctrl+Alt+Shift→⌘⌥⇧、
 *   macOS 原 Ctrl 通道兜底、非 macOS metaKey 一律拒绝、shiftAgnostic 不回归、
 *   code 优先匹配策略）；
 * - splitShortcutBinding / formatShortcutBinding 键帽输出
 *   （macOS 符号顺序 ⌃⌥⇧⌘、非 macOS 保持 Ctrl/Alt/Shift 文本）。
 *
 * 平台经 setWorkbenchShortcutPlatformOverride 注入，afterEach 还原。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatShortcutBinding,
  matchWorkbenchShortcut,
  resolveShortcutModifiers,
  setWorkbenchShortcutPlatformOverride,
  splitShortcutBinding,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_DEFINITIONS,
} from '../shortcuts';

afterEach(() => {
  setWorkbenchShortcutPlatformOverride(null);
});

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

function bindingOf(id: string) {
  const def = WORKBENCH_SHORTCUT_DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`unknown shortcut id: ${id}`);
  return def.binding;
}

describe('matchWorkbenchShortcut — 非 macOS（历史行为不变）', () => {
  it('Ctrl+Alt+← → tile-left；Ctrl+W → close-window；Ctrl+Tab → cycle-next', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(
      matchWorkbenchShortcut(keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }))?.id,
    ).toBe('tile-left');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'w', code: 'KeyW', ctrlKey: true }))?.id,
    ).toBe('close-window');
    expect(matchWorkbenchShortcut(keydown({ key: 'Tab', ctrlKey: true }))?.id).toBe('cycle-next');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'Tab', ctrlKey: true, shiftKey: true }))?.id,
    ).toBe('cycle-prev');
  });

  it('metaKey 参与的组合一律拒绝', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(
      matchWorkbenchShortcut(keydown({ key: 'w', code: 'KeyW', metaKey: true })),
    ).toBeNull();
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'ArrowLeft', metaKey: true, altKey: true }),
      ),
    ).toBeNull();
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true }),
      ),
    ).toBeNull();
  });

  it('shiftAgnostic：? 键带不带 Shift 都命中速查表', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(
      matchWorkbenchShortcut(keydown({ key: '?', shiftKey: true, code: 'Slash' }))?.id,
    ).toBe('cheatsheet');
    expect(matchWorkbenchShortcut(keydown({ key: '?', code: 'Slash' }))?.id).toBe('cheatsheet');
    // 单独一个 `/` 不再命中：Slash code 兜底已移除（误触修复）
    expect(matchWorkbenchShortcut(keydown({ key: '/', code: 'Slash' }))).toBeNull();
  });

  it('Ctrl+Alt+Shift+E → expose-app（不带 Shift 仍是 expose）', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true }),
      )?.id,
    ).toBe('expose-app');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'e', code: 'KeyE', ctrlKey: true, altKey: true }))?.id,
    ).toBe('expose');
  });
});

describe('matchWorkbenchShortcut — macOS（⌘ 基底映射）', () => {
  it('ctrl-only → ⌘：⌘W 关窗、⌘Tab 切换器、⌘` 同应用循环', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(
      matchWorkbenchShortcut(keydown({ key: 'w', code: 'KeyW', metaKey: true }))?.id,
    ).toBe('close-window');
    expect(matchWorkbenchShortcut(keydown({ key: 'Tab', metaKey: true }))?.id).toBe('cycle-next');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'Tab', metaKey: true, shiftKey: true }))?.id,
    ).toBe('cycle-prev');
    expect(
      matchWorkbenchShortcut(keydown({ key: '`', code: 'Backquote', metaKey: true }))?.id,
    ).toBe('cycle-app-next');
  });

  it('Ctrl+Alt → ⌘⌥；Ctrl+Alt+Shift → ⌘⌥⇧', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(
      matchWorkbenchShortcut(keydown({ key: 'ArrowLeft', metaKey: true, altKey: true }))?.id,
    ).toBe('tile-left');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))?.id,
    ).toBe('minimize');
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'ArrowLeft', metaKey: true, altKey: true, shiftKey: true }),
      )?.id,
    ).toBe('move-left');
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'W', code: 'KeyW', metaKey: true, altKey: true, shiftKey: true }),
      )?.id,
    ).toBe('close-all');
  });

  it('原 Ctrl 通道仍作兜底（⌘Tab 被系统拦截时 ⌃Tab 可达）', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(matchWorkbenchShortcut(keydown({ key: 'Tab', ctrlKey: true }))?.id).toBe('cycle-next');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'w', code: 'KeyW', ctrlKey: true }))?.id,
    ).toBe('close-window');
    expect(
      matchWorkbenchShortcut(keydown({ key: 'ArrowUp', ctrlKey: true, altKey: true }))?.id,
    ).toBe('maximize');
  });

  it('修饰键需精确匹配：⌘⌥W ≠ close-window（其为 ⌘W）、纯 ⌘? 不命中速查表', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(
      matchWorkbenchShortcut(keydown({ key: 'w', code: 'KeyW', metaKey: true, altKey: true })),
    ).toBeNull();
    expect(matchWorkbenchShortcut(keydown({ key: '?', code: 'Slash', metaKey: true }))).toBeNull();
  });

  it('shiftAgnostic 不回归：macOS 上 ? 带不带 Shift 都命中', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(
      matchWorkbenchShortcut(keydown({ key: '?', shiftKey: true, code: 'Slash' }))?.id,
    ).toBe('cheatsheet');
    expect(matchWorkbenchShortcut(keydown({ key: '?', code: 'Slash' }))?.id).toBe('cheatsheet');
    // `/` 单键不再误触速查表
    expect(matchWorkbenchShortcut(keydown({ key: '/', code: 'Slash' }))).toBeNull();
  });

  it('code 优先匹配策略保持：⌥ 产生替代字符时按 code 命中', () => {
    setWorkbenchShortcutPlatformOverride(true);
    // ⌘⌥E：macOS 上 e.key 可能是 '´'（dead key），code 仍是 KeyE
    expect(
      matchWorkbenchShortcut(keydown({ key: '´', code: 'KeyE', metaKey: true, altKey: true }))?.id,
    ).toBe('expose');
  });

  it('expose-app：⌘⌥⇧E 命中，⌃⌥⇧E 兜底通道亦可达', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(
      matchWorkbenchShortcut(
        keydown({ key: '´', code: 'KeyE', metaKey: true, altKey: true, shiftKey: true }),
      )?.id,
    ).toBe('expose-app');
    expect(
      matchWorkbenchShortcut(
        keydown({ key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true }),
      )?.id,
    ).toBe('expose-app');
  });
});

describe('resolveShortcutModifiers', () => {
  it('非 macOS 原样返回（meta 恒 false）', () => {
    expect(resolveShortcutModifiers(bindingOf('close-window'), false)).toEqual({
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    expect(resolveShortcutModifiers(bindingOf('move-left'), false)).toEqual({
      ctrl: true,
      alt: true,
      shift: true,
      meta: false,
    });
  });

  it('macOS：ctrl → meta，alt/shift 原样保留', () => {
    expect(resolveShortcutModifiers(bindingOf('close-window'), true)).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: true,
    });
    expect(resolveShortcutModifiers(bindingOf('tile-left'), true)).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      meta: true,
    });
    expect(resolveShortcutModifiers(bindingOf('move-left'), true)).toEqual({
      ctrl: false,
      alt: true,
      shift: true,
      meta: true,
    });
    // 无修饰键 binding（?）不受映射影响
    expect(resolveShortcutModifiers(bindingOf('cheatsheet'), true)).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  });
});

describe('键帽输出 — 非 macOS（文本键帽）', () => {
  it('splitShortcutBinding 输出 Ctrl/Alt/Shift 文本', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(splitShortcutBinding(bindingOf('close-window'))).toEqual(['Ctrl', 'W']);
    expect(splitShortcutBinding(bindingOf('tile-left'))).toEqual(['Ctrl', 'Alt', '←']);
    expect(splitShortcutBinding(bindingOf('move-left'))).toEqual(['Ctrl', 'Alt', 'Shift', '←']);
    expect(splitShortcutBinding(bindingOf('cycle-app-next'))).toEqual(['Ctrl', '`']);
    expect(splitShortcutBinding(bindingOf('cheatsheet'))).toEqual(['?']);
  });

  it('formatShortcutBinding 以 + 连接', () => {
    setWorkbenchShortcutPlatformOverride(false);
    expect(formatShortcutBinding(bindingOf('close-window'))).toBe('Ctrl+W');
    expect(formatShortcutBinding(bindingOf('move-left'))).toBe('Ctrl+Alt+Shift+←');
  });
});

describe('键帽输出 — macOS（符号键帽，顺序 ⌃⌥⇧⌘）', () => {
  it('splitShortcutBinding 输出符号且按 ⌃⌥⇧⌘ 排序', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(splitShortcutBinding(bindingOf('close-window'))).toEqual(['⌘', 'W']);
    expect(splitShortcutBinding(bindingOf('tile-left'))).toEqual(['⌥', '⌘', '←']);
    expect(splitShortcutBinding(bindingOf('move-left'))).toEqual(['⌥', '⇧', '⌘', '←']);
    expect(splitShortcutBinding(bindingOf('cycle-prev'))).toEqual(['⇧', '⌘', 'Tab']);
    expect(splitShortcutBinding(bindingOf('cycle-app-next'))).toEqual(['⌘', '`']);
    // 无修饰键 binding 不带符号
    expect(splitShortcutBinding(bindingOf('cheatsheet'))).toEqual(['?']);
  });

  it('formatShortcutBinding 省略 +（对齐项目 ⌘K 展示约定）', () => {
    setWorkbenchShortcutPlatformOverride(true);
    expect(formatShortcutBinding(bindingOf('close-window'))).toBe('⌘W');
    expect(formatShortcutBinding(bindingOf('tile-left'))).toBe('⌥⌘←');
    expect(formatShortcutBinding(bindingOf('move-left'))).toBe('⌥⇧⌘←');
  });
});

describe('useWorkbenchOverlay — App Exposé 过滤态（P2）', () => {
  afterEach(() => {
    useWorkbenchOverlay.setState({
      exposeOpen: false,
      exposeAppTypeId: null,
      switcherOpen: false,
      switcherIds: [],
      switcherIndex: 0,
      cheatsheetOpen: false,
      cheatsheetSticky: false,
    });
  });

  it('openExpose 无参 = 全局俯瞰（过滤为 null）', () => {
    useWorkbenchOverlay.getState().openExpose();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();
  });

  it('openExpose({ appTypeId }) 设置过滤；closeExpose 清空过滤', () => {
    useWorkbenchOverlay.getState().openExpose({ appTypeId: 'chat' });
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBe('chat');

    useWorkbenchOverlay.getState().closeExpose();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();
  });

  it('App 过滤会话中 openExpose 无参可切回全局俯瞰', () => {
    useWorkbenchOverlay.getState().openExpose({ appTypeId: 'chat' });
    useWorkbenchOverlay.getState().openExpose();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();
  });

  it('toggleExpose 只服务全局入口：开/关都回到无过滤', () => {
    useWorkbenchOverlay.getState().openExpose({ appTypeId: 'chat' });
    useWorkbenchOverlay.getState().toggleExpose();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();

    useWorkbenchOverlay.getState().toggleExpose();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();
  });

  it('打开切换器 / 速查表会关闭俯瞰并清过滤', () => {
    useWorkbenchOverlay.getState().openExpose({ appTypeId: 'chat' });
    useWorkbenchOverlay.getState().openSwitcher(['w1', 'w2'], 1);
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();

    useWorkbenchOverlay.getState().closeSwitcher();
    useWorkbenchOverlay.getState().openExpose({ appTypeId: 'chat' });
    useWorkbenchOverlay.getState().openCheatsheet();
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBeNull();
  });
});
