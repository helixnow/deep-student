import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../logging/exportDiagnostics', () => ({
  canExportDiagnostics: () => false,
  chooseAndExportDiagnostics: vi.fn(),
  revealDiagnostics: vi.fn(),
}));

import { TopLevelFallback } from '../TopLevelFallback';

describe('SPOF-5B TopLevelFallback non-destructive UI layout reset', () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        reload: reloadMock,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it('clears UI layout cache keys, preserves auth and study data, and reloads when clicked', () => {
    localStorage.setItem('desktop.workbenchSnapshot', '{"broken":true}');
    localStorage.setItem('workbench.notesWorkspace.state.v1', '{"corrupt":1}');
    localStorage.setItem('sidebar_collapsed', 'true');
    localStorage.setItem('translation.workbench.splitRatio', 'NaN');
    localStorage.setItem('auth_token', 'keep-token');
    localStorage.setItem('deepstudent_legal_consent', '{"accepted":true}');
    localStorage.setItem('ds.studySpace.activeId.v1', 'space_physics');
    localStorage.setItem('essay_draft_42', 'Keep my study draft');
    sessionStorage.setItem('ds.workbench.activeSession', '1');

    render(<TopLevelFallback error={new Error('Corrupt layout crash')} />);

    const resetButton = screen.getByTestId('fallback-reset-layout');
    expect(resetButton).toHaveTextContent(/重置界面布局缓存|Reset UI Layout Cache/i);

    fireEvent.click(resetButton);

    // UI layout keys are cleared.
    expect(localStorage.getItem('desktop.workbenchSnapshot')).toBeNull();
    expect(localStorage.getItem('workbench.notesWorkspace.state.v1')).toBeNull();
    expect(localStorage.getItem('sidebar_collapsed')).toBeNull();
    expect(localStorage.getItem('translation.workbench.splitRatio')).toBeNull();
    expect(sessionStorage.getItem('ds.workbench.activeSession')).toBeNull();

    // Auth, legal consent, and study data remain intact.
    expect(localStorage.getItem('auth_token')).toBe('keep-token');
    expect(localStorage.getItem('deepstudent_legal_consent')).toBe('{"accepted":true}');
    expect(localStorage.getItem('ds.studySpace.activeId.v1')).toBe('space_physics');
    expect(localStorage.getItem('essay_draft_42')).toBe('Keep my study draft');

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
