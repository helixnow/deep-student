/**
 * App 壳层事件：导航 / settings / chat·workbench 桥接。
 *
 * Owner 约定：
 * - 监听：优先 App.tsx（壳层）或明确的 feature bridge（如 WorkbenchEventBridge）
 * - 派发：通过 dispatchAppEvent；禁止在业务组件里手写裸 CustomEvent 字符串（逐步迁移）
 * - 生命周期：React 侧用 useAppEvent / useEventRegistry，保证 add/remove 成对
 */

import {
  addTypedEventListener,
  dispatchTypedEvent,
  toTypedEventListener,
  type EventTargetKind,
} from './registry';
import type { CurrentView } from '@/types/navigation';

export const APP_EVENTS = {
  SYSTEM_SETTINGS_CHANGED: 'systemSettingsChanged',
  WORKBENCH_MODE_CHANGED: 'workbench:mode-changed',
  VIEW_SWITCHED: 'app:view-switched',
  NAVIGATE_TO_TAB: 'navigate-to-tab',
  NAVIGATE_TO_VIEW: 'NAVIGATE_TO_VIEW',
  SETTINGS_NAVIGATE_TAB: 'SETTINGS_NAVIGATE_TAB',
  OPEN_IMPORT_CONVERSATION: 'DSTU_OPEN_IMPORT_CONVERSATION',
  OPEN_CLOUD_STORAGE_SETTINGS: 'DSTU_OPEN_CLOUD_STORAGE_SETTINGS',
  OPEN_MARKDOWN_EDITOR: 'OPEN_MARKDOWN_EDITOR',
  OPEN_NOTES: 'OPEN_NOTES',
  OPEN_CREPE_DEMO: 'OPEN_CREPE_DEMO',
  OPEN_CHAT_V2_TEST: 'OPEN_CHAT_V2_TEST',
  NAVIGATE_TO_KNOWLEDGE_BASE: 'DSTU_NAVIGATE_TO_KNOWLEDGE_BASE',
  LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE: 'learningHubNavigateToKnowledge',
  LEARNING_HUB_OPEN_RESOURCE: 'learningHubOpenResource',
  LEARNING_HUB_OPEN_EXAM: 'learningHubOpenExam',
  LEARNING_HUB_OPEN_TRANSLATION: 'learningHubOpenTranslation',
  LEARNING_HUB_OPEN_ESSAY: 'learningHubOpenEssay',
  LEARNING_HUB_OPEN_NOTE: 'learningHubOpenNote',
  PREFILL_CHAT_INPUT: 'PREFILL_CHAT_INPUT',
  CHAT_V2_SET_INPUT: 'CHAT_V2_SET_INPUT',
  CHAT_GROUPS_UPDATED: 'chat-v2:groups-updated',
  NAVIGATE_TO_SESSION: 'navigate-to-session',
  MODERN_SIDEBAR_GROUP_ACTION: 'modern-sidebar:group-action',
  MOBILE_APP_NAVIGATE: 'deepstudent:mobile-sidebar-navigate',
  CHAT_NEW_SESSION: 'CHAT_NEW_SESSION',
  NOTES_CREATE_NEW: 'NOTES_CREATE_NEW',
  NAVIGATE_TO_EXAM_SHEET: 'navigateToExamSheet',
  NAVIGATE_TO_TRANSLATION: 'navigateToTranslation',
  NAVIGATE_TO_ESSAY: 'navigateToEssay',
  NAVIGATE_TO_NOTE: 'navigateToNote',
  WB_PREVIEW_QUICK_LOOK: 'wb-preview:quick-look',
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

/** settings 广播：字段为可选，监听方按 settingKey / 语义字段过滤 */
export interface SystemSettingsChangedDetail {
  settingKey?: string;
  value?: unknown;
  topbarTopMargin?: boolean;
  macosFontSmoothing?: boolean;
  pointerCursor?: boolean;
  mcpReloaded?: boolean;
  [key: string]: unknown;
}

export interface WorkbenchModeChangedDetail {
  enabled: boolean;
}

export interface ViewSwitchedDetail {
  from: CurrentView;
  to: CurrentView;
}

export interface NavigateToTabDetail {
  tabName: string;
}

export interface NavigateToViewDetail {
  view?: string;
  returnTo?: string;
  returnPayload?: unknown;
  openResource?: string;
}

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'apis'
  | 'models'
  | 'params'
  | 'search'
  | 'mcp'
  | 'statistics'
  | 'automation'
  | 'data-governance'
  | 'shortcuts'
  | 'about'
  | 'voice-input'
  | 'memory'
  | 'workbench'
  | 'document-processing';

export interface SettingsNavigateTabDetail {
  tab: SettingsTabId;
  dataGovernanceTab?: string;
}

export interface KnowledgeNavigateDetail {
  preferTab?: 'manage' | 'memory';
  locator?: {
    sourceId?: string;
    resourceId?: string;
    resourceType?: string;
    title?: string;
    path?: string;
  };
}

export interface LearningHubOpenResourceDetail {
  dstuPath: string;
}

export interface LearningHubOpenExamDetail {
  sessionId: string;
  cardId?: string | null;
  mistakeId?: string | null;
}

export interface LearningHubOpenTranslationDetail {
  translationId: string;
  title?: string;
}

export interface LearningHubOpenEssayDetail {
  essayId: string;
  title?: string;
}

export interface LearningHubOpenNoteDetail {
  noteId: string;
  source?: string;
}

export interface PrefillChatInputDetail {
  content: string;
  autoSend?: boolean;
}

export interface ChatV2SetInputDetail {
  content: string;
  autoSend?: boolean;
}

export interface NavigateToSessionDetail {
  sessionId: string;
}

export interface ModernSidebarGroupActionDetail {
  action?: string;
}

export interface MobileAppNavigateDetail {
  view?: CurrentView;
}

export interface NavigateToExamSheetDetail {
  sessionId: string;
  cardId?: string;
  mistakeId?: string;
}

export interface NavigateToTranslationDetail {
  translationId: string;
  title?: string;
}

export interface NavigateToEssayDetail {
  essayId: string;
  title?: string;
}

export interface NavigateToNoteDetail {
  noteId: string;
  source?: string;
}

/** preview 壳 Quick Look 浮层（宿主见 workbench/apps/preview/quickLook.tsx） */
export interface WbPreviewQuickLookDetail {
  /** 目标资源 id；null 表示关闭 */
  resourceId: string | null;
  /**
   * 再次请求当前已打开的资源时是否关闭（空格 Quick Look 的开关语义）。
   * 默认 true；传 false 表示"确保打开"（如方向键切换选中项时跟随刷新）。
   */
  toggle?: boolean;
}

export interface AppEventPayloads {
  [APP_EVENTS.SYSTEM_SETTINGS_CHANGED]: SystemSettingsChangedDetail;
  [APP_EVENTS.WORKBENCH_MODE_CHANGED]: WorkbenchModeChangedDetail;
  [APP_EVENTS.VIEW_SWITCHED]: ViewSwitchedDetail;
  [APP_EVENTS.NAVIGATE_TO_TAB]: NavigateToTabDetail;
  [APP_EVENTS.NAVIGATE_TO_VIEW]: NavigateToViewDetail;
  [APP_EVENTS.SETTINGS_NAVIGATE_TAB]: SettingsNavigateTabDetail;
  [APP_EVENTS.OPEN_IMPORT_CONVERSATION]: void;
  [APP_EVENTS.OPEN_CLOUD_STORAGE_SETTINGS]: void;
  [APP_EVENTS.OPEN_MARKDOWN_EDITOR]: void;
  [APP_EVENTS.OPEN_NOTES]: void;
  [APP_EVENTS.OPEN_CREPE_DEMO]: void;
  [APP_EVENTS.OPEN_CHAT_V2_TEST]: void;
  [APP_EVENTS.NAVIGATE_TO_KNOWLEDGE_BASE]: KnowledgeNavigateDetail;
  [APP_EVENTS.LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE]: KnowledgeNavigateDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE]: LearningHubOpenResourceDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_EXAM]: LearningHubOpenExamDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_TRANSLATION]: LearningHubOpenTranslationDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_ESSAY]: LearningHubOpenEssayDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_NOTE]: LearningHubOpenNoteDetail;
  [APP_EVENTS.PREFILL_CHAT_INPUT]: PrefillChatInputDetail;
  [APP_EVENTS.CHAT_V2_SET_INPUT]: ChatV2SetInputDetail;
  [APP_EVENTS.CHAT_GROUPS_UPDATED]: void;
  [APP_EVENTS.NAVIGATE_TO_SESSION]: NavigateToSessionDetail;
  [APP_EVENTS.MODERN_SIDEBAR_GROUP_ACTION]: ModernSidebarGroupActionDetail;
  [APP_EVENTS.MOBILE_APP_NAVIGATE]: MobileAppNavigateDetail;
  /** 命令面板新建会话；侧栏 group-action 复用时可带 action */
  [APP_EVENTS.CHAT_NEW_SESSION]: ModernSidebarGroupActionDetail | undefined;
  [APP_EVENTS.NOTES_CREATE_NEW]: void;
  [APP_EVENTS.NAVIGATE_TO_EXAM_SHEET]: NavigateToExamSheetDetail;
  [APP_EVENTS.NAVIGATE_TO_TRANSLATION]: NavigateToTranslationDetail;
  [APP_EVENTS.NAVIGATE_TO_ESSAY]: NavigateToEssayDetail;
  [APP_EVENTS.NAVIGATE_TO_NOTE]: NavigateToNoteDetail;
  [APP_EVENTS.WB_PREVIEW_QUICK_LOOK]: WbPreviewQuickLookDetail;
}

type DetailArgs<K extends AppEventName> = [AppEventPayloads[K]] extends [void]
  ? []
  : undefined extends AppEventPayloads[K]
    ? [detail?: Exclude<AppEventPayloads[K], undefined>]
    : [detail: AppEventPayloads[K]];

export function dispatchAppEvent<K extends AppEventName>(
  type: K,
  ...args: DetailArgs<K>
): void {
  if (args.length === 0) {
    dispatchTypedEvent(type);
    return;
  }
  dispatchTypedEvent(type, args[0]);
}

export function addAppEventListener<K extends AppEventName>(
  type: K,
  handler: (detail: AppEventPayloads[K], event: CustomEvent<AppEventPayloads[K]>) => void,
  options?: boolean | AddEventListenerOptions,
  target: EventTargetKind = 'window',
): () => void {
  return addTypedEventListener<AppEventPayloads[K]>(type, handler, options, target);
}

export function toAppEventListener<K extends AppEventName>(
  handler: (detail: AppEventPayloads[K], event: CustomEvent<AppEventPayloads[K]>) => void,
): EventListener {
  return toTypedEventListener<AppEventPayloads[K]>(handler);
}
