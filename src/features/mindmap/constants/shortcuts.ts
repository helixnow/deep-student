/**
 * 快捷键单一真源（C6）
 *
 * 本文件是思维导图快捷键的结构化真源：按「视图 × 键位方案（keymap）」组织，
 * 每条绑定携带 i18n label key 与原始组合键串，供以下消费方使用：
 * - 帮助面板（W10 接线）：调用 `getShortcutGroups(view, keymap, platform)`
 *   获得分组好的、已按平台格式化的展示行；
 * - 运行时 hook（useMindMapKeyboard 等）：用 `eventMatchesShortcut(e, combo)`
 *   对照本表的组合键判定，新增键位一律从本表取值；
 * - 旧展示消费方：`SHORTCUTS` / `OUTLINE_SHORTCUTS` / `MINDMAP_SHORTCUTS`
 *   仍然导出（由绑定表派生，deep-student 键位视角），保持兼容。
 *
 * 组合键语法：`mod+shift+Enter` 形式；
 * - `mod` = macOS 的 Cmd / 其它平台的 Ctrl；
 * - 修饰符统一小写（mod / shift / alt / ctrl），主键用 KeyboardEvent.key
 *   的规范值（单字符键小写，如 `mod+b`；特殊键保持原名，如 `ArrowUp`、
 *   `Escape`、`Space` 表示空格）。
 *
 * Tab 双义的消解（原 B4）：
 * - 画布视图：`Tab` 唯一语义是「添加子节点」（多选时批量缩进由 batchOps 行说明，
 *   缩进的键位入口是 `alt+ArrowRight`）；
 * - 大纲视图：`Tab` 唯一语义是「缩进」；添加子节点是 `mod+Enter`
 *   （mubu 键位为 `mod+shift+Enter`）。
 * 两视图语义刻意分叉（画布对标 XMind、大纲对标幕布），本表按视图分列，
 * 不再出现同一视图内一键两义的声明。
 */

import type { MindMapKeymap } from '../utils/mindmapPreferences';

// ============================================================================
// 类型
// ============================================================================

/** 快捷键动作（含背诵模式与新扩展动作） */
export type ShortcutAction =
  | 'addSibling'
  | 'addChild'
  | 'delete'
  | 'duplicate'
  | 'edit'
  | 'note'
  | 'toggleComplete'
  | 'indent'
  | 'outdent'
  | 'moveUp'
  | 'moveDown'
  | 'navigate'
  | 'collapse'
  | 'expand'
  | 'collapseAll'
  | 'expandAll'
  | 'drillIn'
  | 'drillOut'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'undo'
  | 'redo'
  | 'search'
  | 'save'
  | 'copy'
  | 'paste'
  | 'pasteAsText'
  | 'cut'
  | 'selectAll'
  | 'escape'
  | 'focusParent'
  | 'focusFirstChild'
  | 'reciteNavigate'
  | 'reciteReveal'
  | 'reciteExit';

/** 快捷键分组视图 */
export type ShortcutView = 'general' | 'canvas' | 'outline' | 'recite';

/** 平台（决定展示为 ⌘⇧Enter 还是 Ctrl+Shift+Enter） */
export type ShortcutPlatform = 'mac' | 'other';

/**
 * 单条快捷键绑定定义。
 * - `keys` 为两种键位方案共用的默认组合键；
 * - `keymapKeys` 覆盖特定键位方案（空数组表示该方案下不可用，会被过滤）；
 * - `hidden` 的绑定参与运行时判定与旧导出，但不出现在帮助面板分组里
 *   （例如 focusParent 已由 navigate 行覆盖，单列会重复）。
 */
export interface ShortcutBinding {
  action: ShortcutAction;
  /** i18n key（mindmap 命名空间下 shortcuts.* 的短名） */
  labelKey: string;
  keys: string[];
  keymapKeys?: Partial<Record<MindMapKeymap, string[]>>;
  hidden?: boolean;
}

/** 帮助面板展示行（getShortcutGroups 的输出单元） */
export interface ShortcutGroupItem {
  action: ShortcutAction;
  /** 完整 i18n key，直接传给 t()（如 `mindmap:shortcuts.addChild`） */
  labelKey: string;
  /** 原始组合键串（调试 / 二次格式化用） */
  combos: string[];
  /** 已按平台格式化的展示键（与 combos 一一对应） */
  keys: string[];
}

export interface ShortcutGroup {
  id: ShortcutView;
  /** 完整 i18n key（如 `mindmap:shortcuts.groupCanvas`） */
  titleKey: string;
  items: ShortcutGroupItem[];
}

// ============================================================================
// 绑定表（真源）
// ============================================================================

/** 通用（两视图一致，不随 keymap 变化） */
const GENERAL_BINDINGS: ShortcutBinding[] = [
  { action: 'undo', labelKey: 'undo', keys: ['mod+z'] },
  { action: 'redo', labelKey: 'redo', keys: ['mod+shift+z', 'mod+y'] },
  { action: 'save', labelKey: 'save', keys: ['mod+s'] },
  { action: 'search', labelKey: 'search', keys: ['mod+f'] },
  { action: 'escape', labelKey: 'escape', keys: ['Escape'] },
];

/**
 * 画布视图（useMindMapKeyboard + useMindMapClipboard 的真实行为）。
 * mubu 差异：mod+Enter=完成、mod+shift+Enter=加子、mod+[/]=聚焦下钻/返回。
 */
const CANVAS_BINDINGS: ShortcutBinding[] = [
  { action: 'addSibling', labelKey: 'addSiblingOrEdit', keys: ['Enter'] },
  {
    action: 'addChild', labelKey: 'addChild',
    keys: ['Tab', 'mod+Enter'],
    keymapKeys: { mubu: ['Tab', 'mod+shift+Enter'] },
  },
  {
    action: 'toggleComplete', labelKey: 'toggleComplete',
    keys: [],
    keymapKeys: { mubu: ['mod+Enter'] },
  },
  { action: 'edit', labelKey: 'editNode', keys: ['F2', 'Space'] },
  { action: 'note', labelKey: 'editNote', keys: ['shift+Enter'] },
  { action: 'delete', labelKey: 'deleteNode', keys: ['Backspace', 'Delete'] },
  { action: 'duplicate', labelKey: 'duplicate', keys: ['mod+d'] },
  {
    action: 'navigate', labelKey: 'navigate',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  },
  { action: 'moveUp', labelKey: 'moveUp', keys: ['mod+ArrowUp', 'alt+ArrowUp'] },
  { action: 'moveDown', labelKey: 'moveDown', keys: ['mod+ArrowDown', 'alt+ArrowDown'] },
  // 画布缩进入口是 Alt+→（单选 Tab 保留为「加子节点」；多选 Tab 批量缩进）
  { action: 'indent', labelKey: 'indent', keys: ['alt+ArrowRight'] },
  { action: 'outdent', labelKey: 'outdent', keys: ['shift+Tab', 'alt+ArrowLeft'] },
  {
    action: 'collapse', labelKey: 'collapse',
    keys: ['mod+[', 'alt+['],
    keymapKeys: { mubu: ['alt+['] },
  },
  {
    action: 'expand', labelKey: 'expand',
    keys: ['mod+]', 'alt+]'],
    keymapKeys: { mubu: ['alt+]'] },
  },
  {
    action: 'collapseAll', labelKey: 'collapseAll',
    keys: ['mod+shift+[', 'alt+shift+['],
    keymapKeys: { mubu: ['alt+shift+['] },
  },
  {
    action: 'expandAll', labelKey: 'expandAll',
    keys: ['mod+shift+]', 'alt+shift+]'],
    keymapKeys: { mubu: ['alt+shift+]'] },
  },
  {
    action: 'drillIn', labelKey: 'drillIn',
    keys: [],
    keymapKeys: { mubu: ['mod+]'] },
  },
  {
    action: 'drillOut', labelKey: 'drillOut',
    keys: [],
    keymapKeys: { mubu: ['mod+['] },
  },
  { action: 'bold', labelKey: 'bold', keys: ['mod+b'] },
  { action: 'italic', labelKey: 'italic', keys: ['mod+i'] },
  { action: 'underline', labelKey: 'underline', keys: ['mod+u'] },
  { action: 'copy', labelKey: 'copy', keys: ['mod+c'] },
  { action: 'cut', labelKey: 'cut', keys: ['mod+x'] },
  { action: 'paste', labelKey: 'paste', keys: ['mod+v'] },
  { action: 'pasteAsText', labelKey: 'pasteAsText', keys: ['mod+shift+v'] },
  { action: 'selectAll', labelKey: 'selectAll', keys: ['mod+a'] },
  // navigate 行已覆盖 ←/→，单列会在帮助面板重复 → hidden
  { action: 'focusParent', labelKey: 'navigate', keys: ['ArrowLeft'], hidden: true },
  { action: 'focusFirstChild', labelKey: 'navigate', keys: ['ArrowRight'], hidden: true },
];

/**
 * 大纲视图（OutlineView / SortableOutlineNode 编辑态行为）。
 * mubu 差异：mod+Enter=完成、shift+Enter=备注、mod+shift+Enter=加子、mod+[/]=缩放。
 */
const OUTLINE_BINDINGS: ShortcutBinding[] = [
  { action: 'addSibling', labelKey: 'addSiblingOrSplit', keys: ['Enter'] },
  {
    action: 'addChild', labelKey: 'addChild',
    keys: ['mod+Enter'],
    keymapKeys: { mubu: ['mod+shift+Enter'] },
  },
  {
    action: 'toggleComplete', labelKey: 'toggleComplete',
    keys: [],
    keymapKeys: { mubu: ['mod+Enter'] },
  },
  {
    action: 'note', labelKey: 'editNote',
    keys: ['mod+shift+Enter'],
    keymapKeys: { mubu: ['shift+Enter'] },
  },
  { action: 'indent', labelKey: 'indent', keys: ['Tab', 'alt+ArrowRight'] },
  { action: 'outdent', labelKey: 'outdent', keys: ['shift+Tab', 'alt+ArrowLeft'] },
  { action: 'delete', labelKey: 'deleteNode', keys: ['Backspace', 'Delete'] },
  { action: 'moveUp', labelKey: 'moveUp', keys: ['mod+ArrowUp', 'alt+ArrowUp'] },
  { action: 'moveDown', labelKey: 'moveDown', keys: ['mod+ArrowDown', 'alt+ArrowDown'] },
  {
    action: 'navigate', labelKey: 'navigate',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  },
  {
    action: 'collapse', labelKey: 'collapse',
    keys: ['mod+[', 'alt+['],
    keymapKeys: { mubu: ['alt+['] },
  },
  {
    action: 'expand', labelKey: 'expand',
    keys: ['mod+]', 'alt+]'],
    keymapKeys: { mubu: ['alt+]'] },
  },
  {
    action: 'drillIn', labelKey: 'drillIn',
    keys: [],
    keymapKeys: { mubu: ['mod+]'] },
  },
  {
    action: 'drillOut', labelKey: 'drillOut',
    keys: [],
    keymapKeys: { mubu: ['mod+['] },
  },
  // 大纲编辑态无文本选区时，Cmd+C/X/V 作用于节点树（有选区时保持原生文本行为）
  { action: 'copy', labelKey: 'copy', keys: ['mod+c'] },
  { action: 'cut', labelKey: 'cut', keys: ['mod+x'] },
  { action: 'paste', labelKey: 'paste', keys: ['mod+v'] },
  { action: 'pasteAsText', labelKey: 'pasteAsText', keys: ['mod+shift+v'] },
];

/**
 * 背诵模式（键位与编辑态完全隔离：仅导航 + 揭示 + 退出）。
 * useMindMapKeyboard 的背诵分支屏蔽其余所有编辑键。
 */
const RECITE_BINDINGS: ShortcutBinding[] = [
  {
    action: 'reciteNavigate', labelKey: 'reciteNavigate',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  },
  { action: 'reciteReveal', labelKey: 'reciteReveal', keys: ['Enter', 'Space'] },
  { action: 'reciteExit', labelKey: 'reciteExit', keys: ['Escape'] },
];

const BINDINGS_BY_VIEW: Record<Exclude<ShortcutView, 'general'>, ShortcutBinding[]> = {
  canvas: CANVAS_BINDINGS,
  outline: OUTLINE_BINDINGS,
  recite: RECITE_BINDINGS,
};

// ============================================================================
// 键位方案解析与平台格式化
// ============================================================================

/** 按键位方案解析绑定的实际组合键（空数组 = 该方案下不可用） */
export function resolveShortcutKeys(binding: ShortcutBinding, keymap: MindMapKeymap): string[] {
  return binding.keymapKeys?.[keymap] ?? binding.keys;
}

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
};

const OTHER_MODIFIER_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

const KEY_DISPLAY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Del',
};

/**
 * 把组合键串格式化为平台习惯的展示文本：
 * - mac：`mod+shift+Enter` → `⌘⇧Enter`（符号紧排，无分隔符）；
 * - other：`mod+shift+Enter` → `Ctrl+Shift+Enter`。
 */
export function formatShortcut(combo: string, platform: ShortcutPlatform): string {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  const keyLabel =
    KEY_DISPLAY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);

  if (platform === 'mac') {
    // 固定修饰符顺序：⌃ ⌥ ⇧ ⌘（macOS 人机界面指南约定）
    const order = ['ctrl', 'alt', 'shift', 'mod'];
    const symbols = order
      .filter((mod) => modifiers.includes(mod))
      .map((mod) => MAC_MODIFIER_SYMBOLS[mod]);
    return `${symbols.join('')}${keyLabel}`;
  }

  const order = ['mod', 'ctrl', 'alt', 'shift'];
  const labels = order
    .filter((mod) => modifiers.includes(mod))
    .map((mod) => OTHER_MODIFIER_LABELS[mod]);
  // mod 与 ctrl 同现时去重（理论上不会同现，防御）
  const deduped = labels.filter((label, index) => labels.indexOf(label) === index);
  return [...deduped, keyLabel].join('+');
}

/** 探测当前平台（帮助面板可直接用，避免各处重复写 UA 判断） */
export function detectShortcutPlatform(): ShortcutPlatform {
  try {
    const hint = `${globalThis.navigator?.platform ?? ''} ${globalThis.navigator?.userAgent ?? ''}`;
    return /mac|iphone|ipad|ipod/i.test(hint) ? 'mac' : 'other';
  } catch {
    return 'other';
  }
}

// ============================================================================
// 事件匹配（运行时 hook 消费）
// ============================================================================

/**
 * 判断键盘事件是否命中组合键串（严格匹配修饰符：多按/少按修饰符都不命中）。
 * `mod` 同时接受 metaKey 与 ctrlKey（跨平台），单字符主键大小写不敏感。
 */
export function eventMatchesShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  combo: string,
): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));

  const eventKey = e.key === ' ' ? 'Space' : e.key;
  const matchesKey =
    key.length === 1
      ? eventKey.toLowerCase() === key.toLowerCase()
      : eventKey === key;
  if (!matchesKey) return false;

  const wantsMod = modifiers.has('mod');
  const wantsCtrl = modifiers.has('ctrl');
  if (wantsMod !== (e.metaKey || e.ctrlKey) && !wantsCtrl) return false;
  if (wantsCtrl && !e.ctrlKey) return false;
  if (modifiers.has('shift') !== e.shiftKey) return false;
  if (modifiers.has('alt') !== e.altKey) return false;
  return true;
}

// ============================================================================
// 帮助面板分组（W10 消费的契约）
// ============================================================================

const GROUP_TITLE_KEYS: Record<ShortcutView, string> = {
  general: 'groupGeneral',
  canvas: 'groupCanvas',
  outline: 'groupOutline',
  recite: 'groupRecite',
};

const I18N_PREFIX = 'mindmap:shortcuts.';

function toGroup(
  id: ShortcutView,
  bindings: ShortcutBinding[],
  keymap: MindMapKeymap,
  platform: ShortcutPlatform,
): ShortcutGroup {
  const items = bindings.flatMap((binding): ShortcutGroupItem[] => {
    if (binding.hidden) return [];
    const combos = resolveShortcutKeys(binding, keymap);
    if (combos.length === 0) return [];
    return [
      {
        action: binding.action,
        labelKey: `${I18N_PREFIX}${binding.labelKey}`,
        combos,
        keys: combos.map((combo) => formatShortcut(combo, platform)),
      },
    ];
  });
  return { id, titleKey: `${I18N_PREFIX}${GROUP_TITLE_KEYS[id]}`, items };
}

/**
 * 帮助面板数据源（契约见 W07 报告）：
 * - `view` 为当前激活视图（canvas | outline），返回顺序固定为
 *   [通用, 当前视图, 背诵模式]；
 * - `keymap` 取 `useMindMapPreferences().keymap`；
 * - `platform` 取 `detectShortcutPlatform()`；
 * - 每行的 `labelKey` 是完整 i18n key，直接 `t(item.labelKey)`；
 *   `keys` 已按平台格式化，多个键位并列展示即可；
 * - keymap 下不可用的绑定（如 deep-student 的 drillIn）已被过滤，
 *   调用方无需再做键位方案分支。
 */
export function getShortcutGroups(
  view: 'canvas' | 'outline',
  keymap: MindMapKeymap,
  platform: ShortcutPlatform,
): ShortcutGroup[] {
  return [
    toGroup('general', GENERAL_BINDINGS, keymap, platform),
    toGroup(view, BINDINGS_BY_VIEW[view], keymap, platform),
    toGroup('recite', RECITE_BINDINGS, keymap, platform),
  ];
}

// ============================================================================
// 兼容导出（由绑定表派生，deep-student 键位视角）
// ============================================================================

function toLegacyRecord(groups: ShortcutBinding[][]): Partial<Record<ShortcutAction, string[]>> {
  const record: Partial<Record<ShortcutAction, string[]>> = {};
  for (const bindings of groups) {
    for (const binding of bindings) {
      const keys = resolveShortcutKeys(binding, 'deep-student');
      if (keys.length === 0) continue;
      const existing = record[binding.action] ?? [];
      const merged = [...existing];
      for (const key of keys) {
        if (!merged.includes(key)) merged.push(key);
      }
      record[binding.action] = merged;
    }
  }
  return record;
}

/**
 * 全量动作 → 键位映射（deep-student 视角；mubu 专属动作以 mubu 键位补齐）。
 * 仅为兼容旧消费方保留；新代码请使用 getShortcutGroups / resolveShortcutKeys。
 */
export const SHORTCUTS: Record<ShortcutAction, string[]> = {
  ...(toLegacyRecord([GENERAL_BINDINGS, CANVAS_BINDINGS, OUTLINE_BINDINGS, RECITE_BINDINGS]) as Record<
    ShortcutAction,
    string[]
  >),
  // deep-student 下为空的 mubu 专属动作，用 mubu 键位补齐（保持旧表的可查性）
  toggleComplete: ['mod+Enter'],
  drillIn: ['mod+]'],
  drillOut: ['mod+['],
};

/** 大纲视图专用快捷键（deep-student 键位；派生自 OUTLINE_BINDINGS） */
export const OUTLINE_SHORTCUTS: Partial<Record<ShortcutAction, string[]>> =
  toLegacyRecord([GENERAL_BINDINGS, OUTLINE_BINDINGS]);

/** 画布视图专用快捷键（deep-student 键位；派生自 CANVAS_BINDINGS） */
export const MINDMAP_SHORTCUTS: Partial<Record<ShortcutAction, string[]>> =
  toLegacyRecord([GENERAL_BINDINGS, CANVAS_BINDINGS]);
