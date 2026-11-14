/**
 * The Crepe drag-and-drop panel watches the editor's block handle while it is activated: when no editor is open it
 * looks again every second, and once the handle appears it attaches its own mousedown / dragstart loggers there.
 * Deactivating or closing the panel must end both (the debug host promises nothing keeps listening or logging once a
 * panel is off).
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
let Panel: React.ComponentType<PanelProps>;
const props = (isActivated: boolean): PanelProps => ({ visible: true, isActive: true, isActivated, onClose: () => undefined });

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const retries = () => warn.mock.calls.filter(([message]) => String(message).includes('Block handle not found')).length;
const directLogs = () => log.mock.calls.filter(([message]) => String(message).includes('(direct)')).length;

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function mountBlockHandle(): Element {
  const host = document.createElement('div');
  host.innerHTML = '<div class="crepe-editor-wrapper"><div class="milkdown"><div class="milkdown-block-handle" draggable="true"></div></div></div>';
  document.body.appendChild(host);
  return host.querySelector('.milkdown-block-handle')!;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 7, 10, 0, 0, 0) });
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  ({ default: Panel } = (await import('../plugins/CrepeDragDropDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Crepe drag-and-drop panel: block handle watch', () => {
  it('RF-W19-crepe-drag-block-handle-retry-leak: stops looking for the block handle once deactivated', async () => {
    const { rerender } = render(<Panel {...props(true)} />);
    await advance(2500);
    expect(retries()).toBe(3);
    await act(async () => rerender(<Panel {...props(false)} />));
    await advance(10_000);
    // The original kept only the first timer's cleanup, so each later retry scheduled the next one forever.
    expect(retries()).toBe(3);
  });

  it('RF-W19-crepe-drag-block-handle-retry-leak: stops looking for the block handle once closed', async () => {
    const { unmount } = render(<Panel {...props(true)} />);
    await advance(1500);
    unmount();
    await advance(10_000);
    expect(retries()).toBe(2);
  });

  it('RF-W19-crepe-drag-block-handle-retry-leak: removes the block handle loggers attached by a later retry', async () => {
    const { rerender } = render(<Panel {...props(true)} />);
    await advance(500);
    const handle = mountBlockHandle();
    await advance(600);
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(directLogs()).toBe(1);
    await act(async () => rerender(<Panel {...props(false)} />));
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    handle.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    expect(directLogs()).toBe(1);
  });

  it('keeps the loggers on a block handle that was already there until deactivation', async () => {
    const handle = mountBlockHandle();
    const { rerender } = render(<Panel {...props(true)} />);
    handle.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    expect(directLogs()).toBe(1);
    expect(retries()).toBe(0);
    await act(async () => rerender(<Panel {...props(false)} />));
    handle.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    expect(directLogs()).toBe(1);
  });
});
