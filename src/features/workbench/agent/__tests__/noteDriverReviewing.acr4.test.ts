/**
 * ACR 4.0 A4 — noteDriver 建议模式的 reviewing presence 接线（A8 收敛后）：
 * markSuggestionReviewing 已在 presenceStore（A1）真实落地，noteDriver 改为
 * 直接 import 调用（保留 try/catch 降级）。本文件 mock presenceStore 观测调用，
 * 验证：建议被认领 → 标记 reviewing；Accept/Reject（onSettled）→ 清除且幂等。
 * 另验证 API 抛错时守卫静默降级（不阻断建议流程）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';

const { markSuggestionReviewingMock, clearReviewingMock } = vi.hoisted(() => {
  const clearReviewingMock = vi.fn();
  return {
    clearReviewingMock,
    markSuggestionReviewingMock: vi.fn(
      (_windowId: string, _runId: string, _label: string) => clearReviewingMock,
    ),
  };
});

vi.mock('../presenceStore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    markSuggestionReviewing: markSuggestionReviewingMock,
  };
});

import { PACING_PROFILES } from '../pacing';
import type { AcrRunContext, AgentOp } from '../types';
import {
  markSuggestionReviewingGuarded,
  noteDriver,
  registerNoteEditor,
  unregisterNoteEditor,
} from '../drivers/noteDriver';

const NOTE_ID = 'note-acr4-reviewing';

function makeRun(overrides?: Partial<AcrRunContext>): AcrRunContext {
  return {
    runId: 'run-reviewing-1',
    sessionId: 'sess-1',
    target: { typeId: 'note', resourceId: NOTE_ID },
    windowId: 'win-reviewing',
    pacing: {
      profile: PACING_PROFILES.fast,
      tick: vi.fn(async () => {}),
      dispose: vi.fn(),
    },
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: { record: vi.fn() },
    ...overrides,
  } as AcrRunContext;
}

function makeEditorApi(markdown = 'base content') {
  let md = markdown;
  return {
    getMarkdown: () => md,
    setMarkdown: (next: string) => {
      md = next;
      return true;
    },
    getFullMarkdown: () => md,
    getDocEndPos: () => md.length + 2,
    resolveHeadingPos: () => null as number | null,
    agentSignal: vi.fn(),
    agentInsert: () => null,
    getCrepe: () => null,
    hasFocus: () => false,
    flushPendingSave: vi.fn(async () => {}),
  };
}

const replaceOp: AgentOp = {
  kind: 'note_replace',
  destructive: true,
  label: '替换段落',
  payload: { search: 'base', replace: 'next' },
};

describe('noteDriver 建议模式 reviewing presence（ACR 4.0）', () => {
  beforeEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
    markSuggestionReviewingMock.mockClear();
    clearReviewingMock.mockClear();
  });

  afterEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
  });

  it('建议被认领 → markSuggestionReviewing；onSettled → 清除且幂等', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    registerNoteEditor(NOTE_ID, makeEditorApi() as unknown as CrepeEditorApi, 'win-reviewing');

    let settle: (() => void) | undefined;
    const claim = (event: Event) => {
      const detail = (event as CustomEvent<{
        onLocalDisposition?: (v: { accepted: true }) => void;
        onSettled?: () => void;
      }>).detail;
      settle = detail.onSettled;
      detail.onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', claim);

    const receipt = await noteDriver.apply(makeRun(), [replaceOp]);
    window.removeEventListener('canvas:ai-edit-request', claim);

    expect(receipt.suggestionPending).toBe(true);
    expect(markSuggestionReviewingMock).toHaveBeenCalledTimes(1);
    expect(markSuggestionReviewingMock).toHaveBeenCalledWith(
      'win-reviewing',
      'run-reviewing-1',
      expect.stringContaining('替换段落'),
    );
    expect(clearReviewingMock).not.toHaveBeenCalled();

    // 用户 Accept/Reject 后由 useCanvasAIEditHandler 调 onSettled
    expect(settle).toBeTypeOf('function');
    settle!();
    expect(clearReviewingMock).toHaveBeenCalledTimes(1);
    // 幂等：重复 settle 不重复清除
    settle!();
    expect(clearReviewingMock).toHaveBeenCalledTimes(1);
  });

  it('建议未被认领（无人 accept）→ 不标记 reviewing', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    registerNoteEditor(NOTE_ID, makeEditorApi() as unknown as CrepeEditorApi, 'win-reviewing');

    const receipt = await noteDriver.apply(makeRun(), [replaceOp]);

    expect(receipt.status).toBe('failed');
    expect(markSuggestionReviewingMock).not.toHaveBeenCalled();
  });

  it('run 无 windowId → 跳过标记（presence 需要 windowId）', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    registerNoteEditor(NOTE_ID, makeEditorApi() as unknown as CrepeEditorApi);
    const claim = (event: Event) => {
      (event as CustomEvent<{
        onLocalDisposition?: (v: { accepted: true }) => void;
      }>).detail.onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', claim);

    await noteDriver.apply(makeRun({ windowId: null }), [replaceOp]);
    window.removeEventListener('canvas:ai-edit-request', claim);

    expect(markSuggestionReviewingMock).not.toHaveBeenCalled();
  });

  it('markSuggestionReviewingGuarded：API 抛错时静默降级为 null', () => {
    markSuggestionReviewingMock.mockImplementationOnce(() => {
      throw new Error('presence store not ready');
    });
    expect(markSuggestionReviewingGuarded('win-x', 'run-x', 'label')).toBeNull();
  });
});
