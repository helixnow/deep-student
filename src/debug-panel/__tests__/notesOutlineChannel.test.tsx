/**
 * FE-B7: notes outline diagnostics reach NotesOutlineDebugPlugin over the debug bus (formerly a window CustomEvent);
 * the panel shows what arrives while it is active and not paused, as before.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../events/NotesOutlineDebugChannel';
import NotesOutlineDebugPlugin from '../plugins/NotesOutlineDebugPlugin';

const props = { visible: true, isActivated: true, onClose: () => undefined };

afterEach(() => {
  cleanup();
});

function counts() {
  return {
    logs: screen.getByText(/^实时日志/).textContent,
    snapshots: screen.getByText(/^状态快照/).textContent,
  };
}

describe('notes outline debug channel (FE-B7)', () => {
  it('delivers logs and snapshots to the active panel', () => {
    render(<NotesOutlineDebugPlugin {...props} isActive />);
    act(() => {
      emitOutlineDebugLog({ category: 'scroll', action: 'scroll-to-heading', details: { pos: 12 } });
      emitOutlineDebugSnapshot({ noteId: 'note-1', timestamp: 1, heading: { text: 'Intro' } });
    });
    expect(counts()).toEqual({ logs: '实时日志（1）', snapshots: '状态快照（1）' });
    expect(screen.getByText('scroll-to-heading')).toBeTruthy();
    expect(screen.getByText('note-1')).toBeTruthy();
  });

  it('drops reports while the panel is inactive or paused', () => {
    const view = render(<NotesOutlineDebugPlugin {...props} isActive={false} />);
    act(() => emitOutlineDebugLog({ category: 'outline', action: 'while-inactive' }));
    view.rerender(<NotesOutlineDebugPlugin {...props} isActive />);
    expect(counts()).toEqual({ logs: '实时日志（0）', snapshots: '状态快照（0）' });

    fireEvent.click(screen.getByText('暂停'));
    act(() => emitOutlineDebugLog({ category: 'outline', action: 'while-paused' }));
    expect(counts().logs).toBe('实时日志（0）');

    fireEvent.click(screen.getByText('继续'));
    act(() => emitOutlineDebugLog({ category: 'outline', action: 'resumed' }));
    expect(counts().logs).toBe('实时日志（1）');
    expect(screen.queryByText('while-inactive')).toBeNull();
    expect(screen.queryByText('while-paused')).toBeNull();
  });
});
