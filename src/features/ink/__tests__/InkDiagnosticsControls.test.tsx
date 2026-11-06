import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInkDiagnosticsExportPayload,
  InkDiagnosticsControls,
} from '../InkDiagnosticsControls';
import {
  clearInkDiagnostics,
  getInkDiagnosticsSnapshot,
  isInkDiagnosticsEnabled,
  recordInkDiagnostic,
  setInkDiagnosticsEnabled,
} from '../inkDiagnostics';

const mocks = vi.hoisted(() => ({
  saveTextFile: vi.fn(),
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveTextFile: mocks.saveTextFile,
  },
}));

function seedEvents(count: number) {
  setInkDiagnosticsEnabled(true);
  for (let index = 0; index < count; index += 1) {
    recordInkDiagnostic('test.pointer', { clientX: index, clientY: index + 1 });
  }
  setInkDiagnosticsEnabled(false);
}

beforeEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  mocks.saveTextFile.mockReset();
});

afterEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
});

describe('InkDiagnosticsControls', () => {
  it('starts and stops recording through the public diagnostics API', async () => {
    render(<InkDiagnosticsControls />);
    const controls = screen.getByTestId('ink-diagnostics-controls');
    const toggle = screen.getByTestId('ink-diagnostics-toggle');
    expect(controls).toHaveAttribute('data-enabled', 'false');
    expect(isInkDiagnosticsEnabled()).toBe(false);

    fireEvent.click(toggle);
    expect(isInkDiagnosticsEnabled()).toBe(true);
    await waitFor(() => expect(controls).toHaveAttribute('data-enabled', 'true'));

    recordInkDiagnostic('test.pointer', { clientX: 12, clientY: 34 });
    fireEvent.click(toggle);
    expect(isInkDiagnosticsEnabled()).toBe(false);
    await waitFor(() => expect(controls).toHaveAttribute('data-enabled', 'false'));
    expect(getInkDiagnosticsSnapshot().retainedCount).toBe(1);
    expect(screen.getByTestId('ink-diagnostics-summary').textContent).not.toBe('');
  });

  it('clears buffered records and refreshes the displayed count', () => {
    seedEvents(2);
    render(<InkDiagnosticsControls />);

    fireEvent.click(screen.getByTestId('ink-diagnostics-clear'));

    expect(getInkDiagnosticsSnapshot().retainedCount).toBe(0);
    expect(screen.getByTestId('ink-diagnostics-summary').textContent).not.toBe('');
    expect(screen.getByTestId('ink-diagnostics-notice')).toHaveAttribute('role', 'status');
  });

  it('exports a JSON snapshot with an explicit truncation flag', async () => {
    seedEvents(1);
    mocks.saveTextFile.mockResolvedValue({ canceled: false, path: 'content://diagnostics/1' });
    render(<InkDiagnosticsControls />);

    fireEvent.click(screen.getByTestId('ink-diagnostics-export'));

    await waitFor(() => expect(mocks.saveTextFile).toHaveBeenCalledTimes(1));
    const options = mocks.saveTextFile.mock.calls[0][0] as {
      content: string;
      defaultFileName: string;
      filters: Array<{ name: string; extensions: string[] }>;
    };
    const exported = JSON.parse(options.content) as Record<string, any>;
    expect(exported.format).toBe('deepstudent.ink-diagnostics');
    expect(exported.truncated).toBe(false);
    expect(exported.truncation).toEqual({ truncated: false, droppedEvents: 0 });
    expect(exported.eventCount).toBe(1);
    expect(exported.snapshot.retainedCount).toBe(1);
    expect(exported.snapshot.records).toHaveLength(1);
    expect(options.defaultFileName).toMatch(/^ink-diagnostics-.*\.json$/);
    expect(options.filters).toEqual([{ name: 'JSON', extensions: ['json'] }]);
  });

  it('marks the export as truncated when the core reports dropped records', () => {
    const exported = buildInkDiagnosticsExportPayload(
      { retainedCount: 1, capacity: 2, dropped: 2, records: [{ event: 'pointer' }] },
      new Date('2026-11-05T12:00:00.000Z'),
    );

    expect(exported.truncated).toBe(true);
    expect(exported.truncation).toEqual({ truncated: true, droppedEvents: 2 });
    expect(exported.eventCount).toBe(1);
    expect(exported.exportedAt).toBe('2026-11-05T12:00:00.000Z');
  });

  it('keeps export errors local and leaves the controls usable', async () => {
    seedEvents(1);
    mocks.saveTextFile.mockRejectedValue(new Error('disk full'));
    render(<InkDiagnosticsControls />);

    fireEvent.click(screen.getByTestId('ink-diagnostics-export'));

    await waitFor(() => expect(screen.getByTestId('ink-diagnostics-notice')).toHaveAttribute('role', 'alert'));
    expect(screen.getByTestId('ink-diagnostics-notice').textContent).not.toBe('');
    expect(screen.getByTestId('ink-diagnostics-controls')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ink-diagnostics-toggle'));
    expect(isInkDiagnosticsEnabled()).toBe(true);
  });

  it('disables export while recording so the snapshot cannot change under the export', () => {
    render(<InkDiagnosticsControls />);
    fireEvent.click(screen.getByTestId('ink-diagnostics-toggle'));

    expect(screen.getByTestId('ink-diagnostics-export')).toBeDisabled();
  });
});
