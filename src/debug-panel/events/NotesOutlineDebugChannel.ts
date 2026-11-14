/**
 * Notes outline scroll diagnostics: a debug bus channel served by NotesOutlineDebugPlugin (no-op in production).
 */
import { debugChannel } from '@/shared/debug/bus';

export const NOTES_OUTLINE_DEBUG_CHANNEL = 'notes-outline';

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

export type NotesOutlineDebugHandlers = {
  log: (payload: OutlineDebugLogPayload) => void;
  snapshot: (payload: OutlineScrollSnapshot) => void;
};

const channel = debugChannel<NotesOutlineDebugHandlers>(NOTES_OUTLINE_DEBUG_CHANNEL);

export const emitOutlineDebugLog = channel.emitter('log');
export const emitOutlineDebugSnapshot = channel.emitter('snapshot');
