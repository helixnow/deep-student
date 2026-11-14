import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  stopAnkiTaskWatcher,
  refreshAnkiTaskCount,
} from '../../apps/system/ankiTaskSource';
import {
  stopFlashcardsDueWatcher,
  refreshFlashcardsDueCount,
} from '../../apps/system/flashcardsDueSource';
import { resetTodoAgendaSourceForTests } from '../../apps/system/todoAgendaSource';
import { resetSpaceSnapshotsForTests } from '../../core/spaceSnapshots';
import * as stagePresetsModule from '../../core/stagePresets';
import { isShortcutGuardedEvent, useWorkbenchOverlay } from '../../core/shortcuts';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { resetMenuBarAutohideForTests } from '../menuBarAutohideStore';
import { StatusBar } from '../StatusBar';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => ({ due: 0 }) as unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
  }),
}));
vi.mock('@/features/learning-today/todayLearningStore', () => ({
  getTodayLearningSnapshot: () => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] }),
  subscribeTodayLearning: () => () => {},
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({
  openTodayReviewTarget: vi.fn(),
}));

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  fireEvent(window, new Event('resize'));
}

beforeEach(async () => {
  registerTestApp('files', { instanceMode: 'single' });
  registerTestApp('notes', { instanceMode: 'single' });
  registerTestApp('chat', { instanceMode: 'single' });
  registerTestApp('flashcards', { instanceMode: 'single' });
  stopFlashcardsDueWatcher();
  stopAnkiTaskWatcher();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ due: 0 });
  await refreshFlashcardsDueCount();
  await refreshAnkiTaskCount();
  useWorkbenchOverlay.setState({ exposeOpen: false });
  resetWindowStoreForTests({ w: 1440, h: 900 });
  stagePresetsModule.resetStagePresetStoreForTests();
  resetSpaceSnapshotsForTests();
  resetMenuBarAutohideForTests();
  setViewportWidth(1280);
});

afterEach(() => {
  setViewportWidth(originalInnerWidth);
  stopFlashcardsDueWatcher();
  stopAnkiTaskWatcher();
  resetTodoAgendaSourceForTests();
  resetWindowStoreForTests();
  stagePresetsModule.resetStagePresetStoreForTests();
  resetSpaceSnapshotsForTests();
  resetMenuBarAutohideForTests();
  vi.restoreAllMocks();
});

describe('StudyFlowStageSwitcher inside StatusBar', () => {
  it.each([1280, 780])('toggles dual-reader on and off without leaving a bottom-left tile at viewport %s', async (width) => {
    registerTestApp('file-preview', { instanceMode: 'multi' });
    const readerA = useWindowStore.getState().openWindow({ typeId: 'file-preview', instanceKey: 'reader-a' });
    const readerB = useWindowStore.getState().openWindow({ typeId: 'file-preview', instanceKey: 'reader-b' });
    useWindowStore.getState().focusWindow(readerA);
    await stagePresetsModule.applyStudyFlowStagePreset('deep-reading-map');
    setViewportWidth(width);
    render(<StatusBar />);
    const toggle = () => {
      if (width < 960) fireEvent.click(screen.getByTestId('wb-stage-compact-trigger'));
      fireEvent.click(screen.getByTestId(width < 960 ? 'wb-stage-compact-dual-reader' : 'wb-stage-dual-reader-toggle'));
    };
    toggle();
    await waitFor(() => expect(stagePresetsModule.getStagePresetState().sidecarMode).toBe('dual_reader'));
    expect(useWindowStore.getState().windows[readerA].displayMode).toBe('tiled-tl');
    expect(useWindowStore.getState().windows[readerB].displayMode).toBe('tiled-bl');
    act(() => { useWindowStore.getState().focusWindow(readerB); });
    toggle();
    await waitFor(() => expect(stagePresetsModule.getStagePresetState().sidecarMode).toBeNull());
    expect(useWindowStore.getState().windows[readerA].displayMode).toBe('tiled-left');
    expect(useWindowStore.getState().windows[readerB]).toMatchObject({ displayMode: 'floating', minimized: true });
    expect(Object.values(useWindowStore.getState().windows).some((win) => win.displayMode === 'tiled-bl')).toBe(false);
  });

  it('guards Mod+Alt+number gestures in editable fields and during IME composition', () => {
    for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"><span></span></div>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      const target = host.querySelector('span') ?? host.firstElementChild!;
      for (const key of ['1', '2', '3', '4']) {
        const event = new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true });
        Object.defineProperty(event, 'target', { value: target });
        expect(isShortcutGuardedEvent(event)).toBe(true);
      }
    }
    expect(isShortcutGuardedEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, altKey: true, isComposing: true }))).toBe(true);
    expect(isShortcutGuardedEvent(new KeyboardEvent('keydown', { keyCode: 229 }))).toBe(true);
  });

  it('renders [精读导图] [笔记共创] [刷题订正] [自由桌面], updates aria-pressed & 6px dot, and tiles windows', async () => {
    const applySpy = vi.spyOn(stagePresetsModule, 'applyStudyFlowStagePreset');
    render(<StatusBar />);

    const switcher = screen.getByTestId('wb-stage-switcher');
    expect(switcher).toBeInTheDocument();

    const btnReadMap = screen.getByTestId('wb-stage-preset-deep-reading-map');
    const btnNoteAi = screen.getByTestId('wb-stage-preset-note-cocreation');
    const btnPractice = screen.getByTestId('wb-stage-preset-practice-correction');
    const btnFreeform = screen.getByTestId('wb-stage-preset-freeform-desktop');

    expect(btnReadMap).toHaveTextContent('精读导图');
    expect(btnNoteAi).toHaveTextContent('笔记共创');
    expect(btnPractice).toHaveTextContent('刷题订正');
    expect(btnFreeform).toHaveTextContent('自由桌面');

    // Default active preset is freeform-desktop
    expect(btnFreeform).toHaveAttribute('aria-pressed', 'true');
    expect(btnReadMap).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('wb-stage-dot-freeform-desktop')).toHaveClass('h-1.5', 'w-1.5');
    expect(screen.queryByTestId('wb-stage-sidecar-toggle')).toBeNull();

    // Switch to 精读导图
    fireEvent.click(btnReadMap);
    await waitFor(() => {
      expect(btnReadMap).toHaveAttribute('aria-pressed', 'true');
    });
    expect(btnFreeform).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('wb-stage-dot-deep-reading-map')).toHaveClass('h-1.5', 'w-1.5');
    expect(applySpy).toHaveBeenCalledWith(
      'deep-reading-map',
      expect.objectContaining({ spaceId: null }),
    );

    // Sidecar toggle button appears for deep-reading-map and toggles 3-pane AI sidecar
    const sidecarBtn = screen.getByTestId('wb-stage-sidecar-toggle');
    expect(sidecarBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(sidecarBtn);
    await waitFor(() => {
      expect(sidecarBtn).toHaveAttribute('aria-pressed', 'true');
    });
    const modes = Object.values(useWindowStore.getState().windows).map((w) => w.displayMode);
    expect(modes).toEqual(expect.arrayContaining(['tiled-left', 'tiled-tr', 'tiled-br']));

    // Switch to 笔记共创
    fireEvent.click(btnNoteAi);
    await waitFor(() => {
      expect(btnNoteAi).toHaveAttribute('aria-pressed', 'true');
    });
    expect(btnReadMap).toHaveAttribute('aria-pressed', 'false');
  });

  it('collapses into compact dropdown pill below 960px and switches stages cleanly', async () => {
    render(<StatusBar />);
    act(() => {
      setViewportWidth(780);
    });

    expect(screen.queryByTestId('wb-stage-switcher')).toBeNull();
    const compactTrigger = screen.getByTestId('wb-stage-compact-trigger');
    expect(compactTrigger).toHaveTextContent('自由桌面');
    expect(compactTrigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(compactTrigger);
    expect(compactTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('wb-stage-compact-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('wb-stage-compact-item-practice-correction'));
    await waitFor(() => {
      expect(compactTrigger).toHaveTextContent('刷题订正');
    });
    expect(screen.queryByTestId('wb-stage-compact-menu')).toBeNull();
  });
});
