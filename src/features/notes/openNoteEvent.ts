/**
 * DSTU_OPEN_NOTE 事件所有权三分规则（跨 Chat / Workbench 防双开核心契约）
 *
 * 1. Notes 自有 source（notes-editor / wikilink / mention）→ Workbench 处理
 * 2. 显式其它 source（如 note_tool_preview、agent_task_panel）→ Chat 处理
 * 3. 无 source 的遗留事件 → Workbench 处理
 *
 * 行为由 __tests__/openNoteEvent.test.ts 锁定；消费方为
 * WorkbenchEventBridge（shouldWorkbenchHandleOpenNote）与
 * useChatPageEvents（shouldChatHandleOpenNote）。
 * 增删 source 必须同步 chat / workbench 两侧测试，勿单方面修改。
 *
 * 经典壳（Workbench 未启用；Android/iOS 恒为经典壳）没有 WorkbenchEventBridge，
 * 落点改由 resolveClassicShellOpenNoteTarget 决定（App.tsx 与 useChatPageEvents 共用）。
 */
export const NOTES_OWNED_OPEN_NOTE_SOURCES = [
  'notes-editor',
  'wikilink',
  'mention',
] as const;

/** Notes 工作区自有的 open-note 事件来源 */
export type NotesOwnedOpenNoteSource = typeof NOTES_OWNED_OPEN_NOTE_SOURCES[number];

/**
 * DSTU_OPEN_NOTE 事件的 detail 形状（对外契约，勿改字段名）
 *
 * 派发方包括 crepe wikilink/mention 插件、createFromWikilink、chat 多处。
 */
export interface DstuOpenNoteDetail {
  /** 目标笔记 ID（必填；缺失时两侧 should* 判定均为 false） */
  noteId: string;
  /** 事件来源标识；决定 Chat / Workbench 谁处理（见三分规则） */
  source?: string;
  /** 可选的打开目标提示（如特定视图） */
  target?: string;
  /** 可选的标题锚点（配合 headingTargetBridge 冷启动跳转） */
  heading?: string;
}

/** True only for events whose navigation is owned by the Notes workspace. */
export function isNotesOwnedOpenNoteSource(source: unknown): source is NotesOwnedOpenNoteSource {
  return typeof source === 'string'
    && (NOTES_OWNED_OPEN_NOTE_SOURCES as readonly string[]).includes(source);
}

/** Explicit non-Notes sources are owned by Chat. */
export function shouldChatHandleOpenNote(detail: DstuOpenNoteDetail | null | undefined): boolean {
  return Boolean(detail?.noteId)
    && typeof detail?.source === 'string'
    && !isNotesOwnedOpenNoteSource(detail.source);
}

/** Source-less legacy events and Notes editor events are owned by Workbench. */
export function shouldWorkbenchHandleOpenNote(
  detail: DstuOpenNoteDetail | null | undefined,
): boolean {
  return Boolean(detail?.noteId)
    && (detail?.source == null || isNotesOwnedOpenNoteSource(detail.source));
}

/** 经典壳下 DSTU_OPEN_NOTE 的处理方。 */
export type ClassicShellOpenNoteTarget = 'chat' | 'learning-hub';

/**
 * 经典壳（非 Workbench）下 DSTU_OPEN_NOTE 的落点。
 *
 * WorkbenchEventBridge 只挂在 WorkbenchDesktop 内：经典壳里 Notes 自有 / 无 source
 * 的事件（wikilink、@mention、note:// 链接、块链接跳转）原本无人处理；Chat 自有事件在
 * 聊天页不是当前视图时（视图保活隐藏或已被触屏 LRU 淘汰）开进聊天画布也等于没反应。
 *
 * - 'chat'：聊天页是当前视图且事件归 Chat → useChatPageEvents 开进聊天画布
 * - 'learning-hub'：其余有效事件 → App 切到学习资源页并以标签打开
 * - null：无 noteId，忽略
 */
export function resolveClassicShellOpenNoteTarget(
  detail: DstuOpenNoteDetail | null | undefined,
  currentView: string,
): ClassicShellOpenNoteTarget | null {
  if (!detail?.noteId) return null;
  if (shouldChatHandleOpenNote(detail) && currentView === 'chat-v2') return 'chat';
  return 'learning-hub';
}
