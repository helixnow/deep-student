import type { VoiceInputInsertMode, VoiceInputTarget } from './types';

export interface TranscriptInsertionInput {
  value: string;
  transcript: string;
  selectionStart: number;
  selectionEnd: number;
  mode: VoiceInputInsertMode;
}

export interface TranscriptInsertionResult {
  nextValue: string;
  nextSelectionStart: number;
  nextSelectionEnd: number;
  changed: boolean;
}

export function applyTranscriptInsertion(input: TranscriptInsertionInput): TranscriptInsertionResult {
  if (!input.transcript.trim()) {
    return {
      nextValue: input.value,
      nextSelectionStart: input.selectionStart,
      nextSelectionEnd: input.selectionEnd,
      changed: false,
    };
  }

  const safeStart = Math.max(0, Math.min(input.selectionStart, input.value.length));
  const safeEnd = Math.max(safeStart, Math.min(input.selectionEnd, input.value.length));
  const nextValue = `${input.value.slice(0, safeStart)}${input.transcript}${input.value.slice(safeEnd)}`;
  const nextSelection = safeStart + input.transcript.length;

  return {
    nextValue,
    nextSelectionStart: nextSelection,
    nextSelectionEnd: nextSelection,
    changed: nextValue !== input.value,
  };
}

class VoiceInputTargetRegistry {
  private readonly targets = new Map<string, VoiceInputTarget>();
  private activeTargetId: string | null = null;

  registerTarget(target: VoiceInputTarget): void {
    this.targets.set(target.id, target);
    if (!this.activeTargetId) {
      this.activeTargetId = target.id;
    }
  }

  unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);
    if (this.activeTargetId === targetId) {
      this.activeTargetId = this.targets.keys().next().value ?? null;
    }
  }

  setActiveTarget(targetId: string): void {
    if (this.targets.has(targetId)) {
      this.activeTargetId = targetId;
    }
  }

  getActiveTarget(): VoiceInputTarget | null {
    if (!this.activeTargetId) {
      return null;
    }
    return this.targets.get(this.activeTargetId) ?? null;
  }
}

export const voiceInputTargetRegistry = new VoiceInputTargetRegistry();

function focusTextarea(textarea: HTMLTextAreaElement): void {
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
}

export function createTextareaVoiceInputTarget(options: {
  id: string;
  getTextarea: () => HTMLTextAreaElement | null;
  getValue: () => string;
  setValue: (value: string) => void;
  afterInsert?: () => void;
}): VoiceInputTarget {
  return {
    id: options.id,
    ownsNode: (node) => {
      const textarea = options.getTextarea();
      if (!textarea || !node || typeof Node === 'undefined') {
        return false;
      }

      return node === textarea || textarea.contains(node);
    },
    insertTranscript: async (text, mode) => {
      const textarea = options.getTextarea();
      const value = options.getValue();
      const selectionStart = textarea?.selectionStart ?? value.length;
      const selectionEnd = textarea?.selectionEnd ?? value.length;
      const result = applyTranscriptInsertion({
        value,
        transcript: text,
        selectionStart,
        selectionEnd,
        mode,
      });

      if (!result.changed) {
        return false;
      }

      options.setValue(result.nextValue);

      requestAnimationFrame(() => {
        const liveTextarea = options.getTextarea();
        if (!liveTextarea) {
          return;
        }
        focusTextarea(liveTextarea);
        liveTextarea.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd);
        options.afterInsert?.();
      });

      return true;
    },
  };
}
