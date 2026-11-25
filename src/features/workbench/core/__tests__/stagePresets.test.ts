import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tauriCore from '@tauri-apps/api/core';
import { dstu, type DstuNode } from '@/dstu';
import { sessionManager } from '@/features/chat';
import {
  applyStudyFlowStagePreset,
  getStagePresetState,
  mapStudySpacePresetToStagePreset,
  resetStagePresetStoreForTests,
} from '../stagePresets';
import { tilingPairKey } from '../tiling';
import { workbenchBus } from '../workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { registerTestApp } from './testUtils';

function registerStageApps(): void {
  registerTestApp('files', { instanceMode: 'single' });
  registerTestApp('file-preview', { instanceMode: 'multi' });
  registerTestApp('textbook', { instanceMode: 'multi' });
  registerTestApp('media', { instanceMode: 'single' });
  registerTestApp('notes', { instanceMode: 'single' });
  registerTestApp('chat', { instanceMode: 'single' });
  registerTestApp('flashcards', { instanceMode: 'single' });
  registerTestApp('exam', { instanceMode: 'single' });
  registerTestApp('todo', { instanceMode: 'single' });
}

beforeEach(() => {
  registerStageApps();
  localStorage.clear();
  workbenchBus.setEnabled(false);
  resetWindowStoreForTests({ w: 1600, h: 900 });
  resetStagePresetStoreForTests();
});

afterEach(() => {
  workbenchBus.setEnabled(false);
  vi.restoreAllMocks();
});

describe('mapStudySpacePresetToStagePreset', () => {
  it('maps StudySpace WorkbenchLayoutPreset values to StudyFlowStagePresetId', () => {
    expect(mapStudySpacePresetToStagePreset('split_reader_chat')).toBe('deep-reading-map');
    expect(mapStudySpacePresetToStagePreset('split_notes_chat')).toBe('note-cocreation');
    expect(mapStudySpacePresetToStagePreset('chat_focus')).toBe('note-cocreation');
    expect(mapStudySpacePresetToStagePreset('practice_review')).toBe('practice-correction');
    expect(mapStudySpacePresetToStagePreset('freeform_desktop')).toBe('freeform-desktop');
    expect(mapStudySpacePresetToStagePreset(undefined)).toBe('freeform-desktop');
  });
});

describe('applyStudyFlowStagePreset', () => {
  it('disables dual-reader without orphan tiles, tab loss, stale ratios or replacing Reader A after focusing Reader B', async () => {
    const readerA = useWindowStore.getState().openWindow({ typeId: 'file-preview', instanceKey: 'a' });
    const readerB = useWindowStore.getState().openWindow({ typeId: 'file-preview', instanceKey: 'b' });
    useWindowStore.getState().focusWindow(readerA);
    const dual = await applyStudyFlowStagePreset('deep-reading-map', { sidecar: 'dual_reader' });
    expect(dual.leftWindowId).toBe(readerA);
    expect(dual.sidecarWindowId).toBe(readerB);
    useWindowStore.getState().focusWindow(readerB);
    const pair = await applyStudyFlowStagePreset('deep-reading-map', { sidecar: null });
    expect(pair.leftWindowId).toBe(readerA);
    const { windows, tilingRatios } = useWindowStore.getState();
    expect(windows[readerA].displayMode).toBe('tiled-left');
    expect(windows[pair.rightWindowId!].displayMode).toBe('tiled-right');
    expect(windows[readerB]).toMatchObject({ minimized: true, displayMode: 'floating', instanceKey: 'b' });
    expect(Object.keys(windows)).toHaveLength(3);
    expect(tilingRatios['h-left']).toBeUndefined();
    expect(tilingRatios[tilingPairKey(readerA, pair.rightWindowId!)]).toBe(0.48);
    expect(Object.values(windows).some((win) => win.displayMode === 'tiled-bl')).toBe(false);
  });
  it('preserves reader/notes hosts and payloads across reading -> review -> reading without stealing the active tab', async () => {
    const reader = useWindowStore.getState().openWindow({ typeId: 'file-preview', instanceKey: 'active-document', payload: { activeTab: 'chapter-3' } });
    const notes = useWindowStore.getState().openWindow({ typeId: 'notes', payload: { activeTab: 'my-map' } });
    const preferMindmap = vi.fn();
    window.addEventListener('workbench:prefer-mindmap-tab', preferMindmap);
    try {
      await applyStudyFlowStagePreset('deep-reading-map');
      await applyStudyFlowStagePreset('practice-correction');
      const result = await applyStudyFlowStagePreset('deep-reading-map');
      expect(result.leftWindowId).toBe(reader);
      expect(result.rightWindowId).toBe(notes);
      expect(useWindowStore.getState().launchPayloads[reader]).toEqual({ activeTab: 'chapter-3' });
      expect(useWindowStore.getState().launchPayloads[notes]).toEqual({ activeTab: 'my-map' });
      expect(Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === 'notes')).toHaveLength(1);
      expect(preferMindmap).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('workbench:prefer-mindmap-tab', preferMindmap);
    }
  });

  it('deep-reading-map reuses open Reader + Notes at 0.48 split and minimizes unrelated windows without closing them', async () => {
    const store = useWindowStore.getState();
    const floatingDraftId = store.openWindow({
      typeId: 'todo',
      title: 'Unsaved Todo Draft',
      initialFrame: { x: 120, y: 90, w: 460, h: 360 },
    });
    const pdfWinId = store.openWindow({
      typeId: 'file-preview',
      instanceKey: 'pdf_math_101',
      title: '线性代数讲义.pdf',
      initialFrame: { x: 60, y: 50, w: 720, h: 600 },
    });

    const preferEvents: Array<{ rootFolderId: string | null }> = [];
    const onPreferMindmap = (e: Event) => {
      preferEvents.push((e as CustomEvent<{ rootFolderId: string | null }>).detail);
    };
    window.addEventListener('workbench:prefer-mindmap-tab', onPreferMindmap);

    try {
      const result = await applyStudyFlowStagePreset('deep-reading-map', {
        spaceId: 'space_math',
        rootFolderId: 'fld_math',
      });

      const after = useWindowStore.getState();
      expect(result.presetId).toBe('deep-reading-map');
      expect(result.leftWindowId).toBe(pdfWinId);
      expect(result.rightWindowId).toBeTruthy();
      expect(after.windows[pdfWinId].displayMode).toBe('tiled-left');
      expect(after.windows[result.rightWindowId!].typeId).toBe('notes');
      expect(after.windows[result.rightWindowId!].displayMode).toBe('tiled-right');
      expect(
        after.tilingRatios[tilingPairKey(pdfWinId, result.rightWindowId!)],
      ).toBe(0.48);
      expect(after.tilingRatios['v']).toBe(0.48);
      expect(after.focusStack.at(-1)).toBe(result.rightWindowId);

      // Unrelated floating window is minimized, NEVER closed
      expect(after.windows[floatingDraftId]).toBeDefined();
      expect(after.windows[floatingDraftId].minimized).toBe(true);
      expect(preferEvents).toEqual([{ rootFolderId: 'fld_math' }]);
      expect(getStagePresetState()).toEqual({
        activeStagePreset: 'deep-reading-map',
        sidecarMode: null,
      });
    } finally {
      window.removeEventListener('workbench:prefer-mindmap-tab', onPreferMindmap);
    }
  });

  it('deep-reading-map opens files navigated to rootFolderId when no Reader window is open', async () => {
    workbenchBus.setEnabled(true);
    const activateSpy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);

    const result = await applyStudyFlowStagePreset('deep-reading-map', {
      spaceId: 'space_bio',
      rootFolderId: 'fld_bio_root',
    });

    const after = useWindowStore.getState();
    expect(after.windows[result.leftWindowId!].typeId).toBe('files');
    expect(after.windows[result.leftWindowId!].displayMode).toBe('tiled-left');
    expect(after.windows[result.rightWindowId!].typeId).toBe('notes');
    expect(after.windows[result.rightWindowId!].displayMode).toBe('tiled-right');
    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'files',
      instanceKey: '',
      action: 'openFolder',
      payload: { folderId: 'fld_bio_root' },
    });
  });

  it('supports 3-pane sidecar arrangement (tiled-left + tiled-tr + tiled-br) in deep-reading-map', async () => {
    const pdfWinId = useWindowStore.getState().openWindow({
      typeId: 'textbook',
      instanceKey: 'tb_1',
    });

    const result = await applyStudyFlowStagePreset('deep-reading-map', {
      sidecar: 'chat',
    });

    const after = useWindowStore.getState();
    expect(result.leftWindowId).toBe(pdfWinId);
    expect(after.windows[result.leftWindowId!].displayMode).toBe('tiled-left');
    expect(after.windows[result.rightWindowId!].typeId).toBe('notes');
    expect(after.windows[result.rightWindowId!].displayMode).toBe('tiled-tr');
    expect(after.windows[result.sidecarWindowId!].typeId).toBe('chat');
    expect(after.windows[result.sidecarWindowId!].displayMode).toBe('tiled-br');
    expect(after.tilingRatios['v']).toBe(0.48);
    expect(after.tilingRatios['h-right']).toBe(0.58);
    expect(after.focusStack.at(-1)).toBe(result.rightWindowId);
    expect(getStagePresetState()).toEqual({
      activeStagePreset: 'deep-reading-map',
      sidecarMode: 'chat',
    });
  });

  it('note-cocreation tiles notes (0.52) + chat (0.48) and practice-correction tiles flashcards/exam + companion', async () => {
    const noteRes = await applyStudyFlowStagePreset('note-cocreation');
    let state = useWindowStore.getState();
    expect(state.windows[noteRes.leftWindowId!].typeId).toBe('notes');
    expect(state.windows[noteRes.leftWindowId!].displayMode).toBe('tiled-left');
    expect(state.windows[noteRes.rightWindowId!].typeId).toBe('chat');
    expect(state.windows[noteRes.rightWindowId!].displayMode).toBe('tiled-right');
    expect(
      state.tilingRatios[tilingPairKey(noteRes.leftWindowId!, noteRes.rightWindowId!)],
    ).toBe(0.52);

    // Since both notes and chat are now open, practice-correction arranges 3-pane flashcards + notes + chat!
    const practiceRes = await applyStudyFlowStagePreset('practice-correction', {
      defaultDeckId: 'deck_calculus',
    });
    state = useWindowStore.getState();
    expect(state.windows[practiceRes.leftWindowId!].typeId).toBe('flashcards');
    expect(state.windows[practiceRes.leftWindowId!].displayMode).toBe('tiled-left');
    expect(state.launchPayloads[practiceRes.leftWindowId!]).toEqual({
      deckId: 'deck_calculus',
    });
    expect(state.windows[practiceRes.rightWindowId!].typeId).toBe('notes');
    expect(state.windows[practiceRes.rightWindowId!].displayMode).toBe('tiled-tr');
    expect(state.windows[practiceRes.sidecarWindowId!].typeId).toBe('chat');
    expect(state.windows[practiceRes.sidecarWindowId!].displayMode).toBe('tiled-br');
    expect(state.tilingRatios['v']).toBe(0.5);
    expect(state.tilingRatios['h-right']).toBe(0.55);
    // S4-11: 刷题订正必须把闪卡/试卷主练窗带入前台，而非让右侧辅助窗抢焦
    expect(state.focusStack[state.focusStack.length - 1]).toBe(practiceRes.leftWindowId);
  });

  it('freeform-desktop transitions all tiled-* windows back to floating and restores original restoreFrames', async () => {
    const store = useWindowStore.getState();
    const notesFrame = { x: 140, y: 110, w: 620, h: 480 };
    const chatFrame = { x: 820, y: 150, w: 540, h: 460 };
    const notesId = store.openWindow({
      typeId: 'notes',
      initialFrame: notesFrame,
    });
    const chatId = store.openWindow({
      typeId: 'chat',
      initialFrame: chatFrame,
    });

    await applyStudyFlowStagePreset('note-cocreation');
    expect(useWindowStore.getState().windows[notesId].displayMode).toBe('tiled-left');
    expect(useWindowStore.getState().windows[chatId].displayMode).toBe('tiled-right');
    expect(useWindowStore.getState().windows[notesId].restoreFrame).toEqual(notesFrame);

    await applyStudyFlowStagePreset('freeform-desktop');
    const restored = useWindowStore.getState();
    expect(restored.windows[notesId].displayMode).toBe('floating');
    expect(restored.windows[notesId].frame).toEqual(notesFrame);
    expect(restored.windows[notesId].restoreFrame).toBeNull();
    expect(restored.windows[chatId].displayMode).toBe('floating');
    expect(restored.windows[chatId].frame).toEqual(chatFrame);
    expect(restored.windows[chatId].restoreFrame).toBeNull();
    expect(getStagePresetState().activeStagePreset).toBe('freeform-desktop');
  });

  it('S4-11: hydrates recent reader/mindmap, note/chat session, and exam/mistake-note/chat across the 3 study presets when materials exist', async () => {
    const textbookNode: DstuNode = {
      id: 'tb_linear_1',
      sourceId: 'tb_linear_1',
      path: '/tb_linear_1',
      name: '线性代数教材.pdf',
      type: 'textbook',
      createdAt: 100,
      updatedAt: 500,
    };
    const mindmapNode: DstuNode = {
      id: 'mm_linear_1',
      sourceId: 'mm_linear_1',
      path: '/mm_linear_1',
      name: '特征值知识导图',
      type: 'mindmap',
      createdAt: 100,
      updatedAt: 600,
    };
    const mistakeNoteNode: DstuNode = {
      id: 'note_mistake_1',
      sourceId: 'note_mistake_1',
      path: '/note_mistake_1',
      name: '高数错题订正总结',
      type: 'note',
      createdAt: 100,
      updatedAt: 550,
    };
    const examNode: DstuNode = {
      id: 'exam_midterm_1',
      sourceId: 'exam_midterm_1',
      path: '/exam_midterm_1',
      name: '期中模拟卷',
      type: 'exam',
      createdAt: 100,
      updatedAt: 700,
    };

    vi.spyOn(dstu, 'list').mockImplementation((async (_path, opts) => {
      switch (opts?.typeFilter) {
        case 'textbook':
          return { ok: true, value: [textbookNode] };
        case 'mindmap':
          return { ok: true, value: [mindmapNode] };
        case 'note':
          return { ok: true, value: [mistakeNoteNode] };
        case 'exam':
          return { ok: true, value: [examNode] };
        default:
          return { ok: true, value: [] };
      }
    }) as typeof dstu.list);
    vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue('sess_study_active');
    vi.spyOn(tauriCore, 'invoke').mockImplementation(async (cmd: string) => {
      if (cmd === 'get_due_review_items') {
        return [{ plan: { exam_id: 'exam_midterm_1' } }];
      }
      return [];
    });

    // 1. 精读导图 -> binds recent textbook reader + recent mindmap
    const readRes = await applyStudyFlowStagePreset('deep-reading-map');
    let state = useWindowStore.getState();
    expect(state.windows[readRes.leftWindowId!].typeId).toBe('file-preview');
    expect(state.windows[readRes.leftWindowId!].instanceKey).toBe('tb_linear_1');
    expect(state.windows[readRes.rightWindowId!].typeId).toBe('notes');
    expect(state.launchPayloads[readRes.rightWindowId!]).toEqual({
      resourceType: 'mindmap',
      resourceId: 'mm_linear_1',
      title: '特征值知识导图',
    });

    // 2. 笔记共创 (clean desktop) -> binds recent note + recent active chat session
    resetWindowStoreForTests({ w: 1600, h: 900 });
    const cocreateRes = await applyStudyFlowStagePreset('note-cocreation');
    state = useWindowStore.getState();
    expect(state.windows[cocreateRes.leftWindowId!].typeId).toBe('notes');
    expect(state.launchPayloads[cocreateRes.leftWindowId!]).toEqual({
      resourceType: 'note',
      resourceId: 'note_mistake_1',
      title: '高数错题订正总结',
    });
    expect(state.windows[cocreateRes.rightWindowId!].typeId).toBe('chat');
    expect(state.windows[cocreateRes.rightWindowId!].instanceKey).toBe('sess_study_active');

    // 3. 刷题订正 (clean desktop) -> binds recent exam (review_first) + mistake note + active chat
    resetWindowStoreForTests({ w: 1600, h: 900 });
    const practiceRes = await applyStudyFlowStagePreset('practice-correction');
    state = useWindowStore.getState();
    expect(state.windows[practiceRes.leftWindowId!].typeId).toBe('exam');
    expect(state.launchPayloads[practiceRes.leftWindowId!]).toEqual({
      resourceId: 'exam_midterm_1',
      practiceMode: 'review_first',
      title: '期中模拟卷',
    });
    expect(state.windows[practiceRes.rightWindowId!].typeId).toBe('notes');
    expect(state.launchPayloads[practiceRes.rightWindowId!]).toEqual({
      resourceType: 'note',
      resourceId: 'note_mistake_1',
      title: '高数错题订正总结',
    });
    expect(state.windows[practiceRes.sidecarWindowId!].typeId).toBe('chat');
    expect(state.windows[practiceRes.sidecarWindowId!].instanceKey).toBe('sess_study_active');
  });
});
