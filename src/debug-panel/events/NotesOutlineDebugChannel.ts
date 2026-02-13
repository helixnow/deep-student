export const NOTES_OUTLINE_DEBUG_EVENT = 'notes:outline-scroll-debug';

export type OutlineDebugLogLevel = 'info' | 'warn' | 'error';

export interface OutlineScrollSnapshot {
  noteId: string | null;
  timestamp?: number;
  heading?: {
    text: string;
    normalized?: string;
    level?: number;
  };
  outlineState?: {
    headings: number;
    liveContent?: boolean;
    parsingDurationMs?: number;
  };
  scrollEvent?: {
    reason: string;
    targetPos?: number | null;
    resolvedPos?: number | null;
    exactMatch?: boolean;
  };
  editorState?: {
    hasView: boolean;
    hasSelection: boolean;
    selectionFrom?: number;
    selectionTo?: number;
    containerScrollTop?: number;
    containerScrollHeight?: number;
    containerClientHeight?: number;
  };
  domState?: {
    viewportExists: boolean;
    viewportSelector?: string;
    headingDomPath?: string;
  };
}

export interface OutlineDebugLogPayload {
  category: 'outline' | 'event' | 'editor' | 'scroll' | 'dom' | 'error';
  action: string;
  level?: OutlineDebugLogLevel;
  details?: Record<string, unknown>;
  source?: string;
}

export type OutlineDebugEventDetail =
  | { type: 'log'; payload: OutlineDebugLogPayload }
  | { type: 'snapshot'; payload: OutlineScrollSnapshot };

const dispatchDebugEvent = (detail: OutlineDebugEventDetail) => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(NOTES_OUTLINE_DEBUG_EVENT, { detail }));
  } catch {
    // ignore - 调试辅助工具不影响主流程
  }
};

export const emitOutlineDebugLog = (payload: OutlineDebugLogPayload) => {
  dispatchDebugEvent({ type: 'log', payload });
};

export const emitOutlineDebugSnapshot = (payload: OutlineScrollSnapshot) => {
  dispatchDebugEvent({ type: 'snapshot', payload });
};
