/**
 * Evidence for the Crepe drag-and-drop debug panel, recorded before the file was split by responsibility (event
 * model, DOM capture and issue detection, editor probing, log diagnosis, panel). Real DOM events reach the panel's
 * window listeners over a fake Crepe editor, and the goldens hold everything the panel shows (classes, inline colours,
 * icons, full text including the detail JSON), the notifications, and the copied text. Times run on a fake clock
 * pinned to a local wall time; copied epoch times are kept as offsets from it and checked against their ISO stamps.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

const h = vi.hoisted(() => ({ copied: [] as string[], notices: [] as string[] }));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text);
    return true;
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn((type: string, message: string) => h.notices.push(`${type}: ${message}`)),
}));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';
const START = new Date(2026, 10, 7, 10, 0, 0, 0);

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE && !fs.existsSync(file)) fs.writeFileSync(file, current);
  return fs.readFileSync(file, 'utf8');
}

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
let Panel: React.ComponentType<PanelProps>;
const props = (isActivated: boolean): PanelProps => ({ visible: true, isActive: true, isActivated, onClose: () => undefined });

/**
 * The copied entries with epoch times as offsets from START; each ISO stamp and id prefix is checked exactly. The id's
 * random part is checked for shape only: it is drawn inside a state updater, and React may run an updater more than
 * once, which shifts the draws of later entries.
 */
function readCopied(text: string) {
  const parsed = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
  const one = (entry: Record<string, unknown>) => {
    const { timestamp, id, ts, ...rest } = entry as { timestamp: string; id: string; ts: number };
    expect(timestamp).toBe(new Date(ts).toISOString());
    expect(id).toMatch(new RegExp(`^${ts}-[0-9a-f]{1,6}$`));
    return { keys: Object.keys(entry), offset: ts - START.getTime(), ...rest };
  };
  return Array.isArray(parsed) ? parsed.map(one) : one(parsed);
}

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

interface Fire { x?: number; y?: number; prevented?: boolean; types?: string[]; related?: Element }

/** One DOM event, 41 ms after the previous one. `types` gives it a dataTransfer as a browser drag event has. */
async function fire(target: EventTarget, type: string, init: Fire = {}) {
  await step(() => {
    vi.advanceTimersByTime(41);
    const event = new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0, relatedTarget: init.related ?? null,
    });
    if (init.types) {
      Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: 'move', dropEffect: 'none', types: init.types } });
    }
    if (init.prevented) event.preventDefault();
    target.dispatchEvent(event);
  });
}

class NodeSelection {}

function mountEditor() {
  const host = document.createElement('div');
  host.innerHTML = [
    '<div class="crepe-editor-wrapper">',
    '<div class="milkdown" data-dragging="false">',
    '<div class="milkdown-block-handle" data-show="true" draggable="true">',
    '<div class="operation-item">+</div><div class="operation-item">⋮⋮</div>',
    '</div>',
    '<div class="ProseMirror" contenteditable="true">',
    '<p data-node-type="paragraph">第一段</p><p data-node-type="paragraph">第二段</p>',
    '</div></div></div>',
  ].join('');
  document.body.appendChild(host);
  (window as unknown as Record<string, unknown>).__MILKDOWN_VIEW__ = {
    editable: true,
    dragging: { slice: { size: 1 }, move: true },
    state: { selection: new NodeSelection() },
    hasFocus: () => false,
  };
  const q = (selector: string) => document.querySelector(selector)!;
  return {
    handle: q('.milkdown-block-handle'),
    plus: document.querySelectorAll('.operation-item')[0]!,
    grip: document.querySelectorAll('.operation-item')[1]!,
    first: document.querySelectorAll('.ProseMirror p')[0]!,
    second: document.querySelectorAll('.ProseMirror p')[1]!,
  };
}

const headerButtons = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('h2 + div > button'));
const filterButton = (container: HTMLElement, type: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.startsWith(`${type}: `))!;

// Log rows show `toLocaleTimeString(undefined, …)` times.
pinDefaultLocaleForFile();

beforeEach(async () => {
  h.copied.length = 0;
  h.notices.length = 0;
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 90) + 1) / 1000);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  ({ default: Panel } = (await import('../plugins/CrepeDragDropDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__MILKDOWN_VIEW__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Crepe drag-and-drop debug panel (evidence before the split)', () => {
  it('shows the activation row and the missing-editor diagnosis when no editor is open', async () => {
    const { container } = render(<Panel {...props(true)} />);
    await step(() => vi.advanceTimersByTime(3000));
    await fire(document.body, 'mousedown', { x: 5, y: 5 });
    expect(panelText(container)).toBe(golden('crepe-drag-drop.no-editor.txt', panelText(container)));
  });

  it('records a drag round, runs the editor diagnosis, copies, filters and clears', async () => {
    const editor = mountEditor();
    const { container } = render(<Panel {...props(true)} />);
    await fire(document.body, 'mousedown', { x: 1, y: 1 });
    await fire(editor.grip, 'mousedown', { x: 12, y: 40 });
    await fire(editor.grip, 'pointerdown', { x: 12, y: 40 });
    await fire(editor.plus, 'mousedown', { x: 4, y: 40 });
    await fire(editor.first, 'mouseup', { x: 30, y: 40 });
    await fire(editor.handle, 'dragstart', { x: 12, y: 40, types: ['text/html', 'text/plain'] });
    await fire(editor.second, 'dragenter', { x: 40, y: 80, types: ['text/html'], related: editor.first });
    await fire(editor.second, 'dragover', { x: 40, y: 82, types: ['text/html'], prevented: true });
    await fire(editor.second, 'dragover', { x: 40, y: 84, types: ['text/html'] });
    await fire(editor.handle, 'drag', { x: 40, y: 84, types: ['text/html'] });
    await fire(editor.first, 'dragleave', { x: 40, y: 86, types: ['text/html'], related: editor.second });
    await fire(editor.second, 'drop', { x: 40, y: 88, types: ['text/html'], prevented: true });
    await fire(editor.handle, 'dragend', { x: 40, y: 88, types: [] });
    await fire(document.body, 'dragover', { x: 900, y: 600, types: [] });
    const round = panelText(container);

    const [, issuesOnly, autoScroll, diagnose, copyAll, clear] = headerButtons(container);
    await step(() => fireEvent.click(diagnose!));
    const diagnosed = panelText(container);

    await step(() => fireEvent.click(copyAll!));
    const copiedAll = readCopied(h.copied.at(-1)!);
    await step(() => fireEvent.click(container.querySelectorAll<HTMLButtonElement>('button[title="复制日志"]')[2]!));
    const copiedOne = readCopied(h.copied.at(-1)!);

    await step(() => fireEvent.click(issuesOnly!));
    await step(() => fireEvent.click(filterButton(container, 'mousedown')));
    await step(() => fireEvent.click(filterButton(container, 'pointerdown')));
    await step(() => fireEvent.click(autoScroll!));
    const filtered = panelText(container);
    await step(() => fireEvent.click(copyAll!));
    const copiedFiltered = readCopied(h.copied.at(-1)!);

    await step(() => fireEvent.click(clear!));
    const cleared = panelText(container);

    const current = `${JSON.stringify({ notices: h.notices, copiedAll, copiedOne, copiedFiltered }, null, 2)}\n`;
    expect(round).toBe(golden('crepe-drag-drop.round.txt', round));
    expect(diagnosed).toBe(golden('crepe-drag-drop.diagnosed.txt', diagnosed));
    expect(filtered).toBe(golden('crepe-drag-drop.filtered.txt', filtered));
    expect(cleared).toBe(golden('crepe-drag-drop.cleared.txt', cleared));
    expect(current).toBe(golden('crepe-drag-drop.copied.json', current));
  });

  it('ignores events while paused and logs a fresh activation row on resume', async () => {
    const editor = mountEditor();
    const { container } = render(<Panel {...props(true)} />);
    const record = () => headerButtons(container)[0]!;
    await step(() => fireEvent.click(record()));
    await fire(editor.handle, 'dragstart', { x: 12, y: 40, types: ['text/html'] });
    const paused = panelText(container);
    await step(() => fireEvent.click(record()));
    await fire(editor.handle, 'dragstart', { x: 13, y: 41, types: [] });
    const resumed = panelText(container);
    expect(`${paused}----\n${resumed}`).toBe(golden('crepe-drag-drop.pause.txt', `${paused}----\n${resumed}`));
  });

  it('stops listening when deactivated and keeps the earlier rows on reactivation', async () => {
    const editor = mountEditor();
    const { container, rerender } = render(<Panel {...props(true)} />);
    await fire(editor.handle, 'dragstart', { x: 12, y: 40, types: ['text/html'] });
    rerender(<Panel {...props(false)} />);
    expect(container.innerHTML).toBe('');
    await fire(editor.handle, 'dragstart', { x: 14, y: 42, types: ['text/html'] });
    await step(() => rerender(<Panel {...props(true)} />));
    await fire(editor.second, 'drop', { x: 40, y: 88, types: ['text/html'] });
    expect(panelText(container)).toBe(golden('crepe-drag-drop.reactivate.txt', panelText(container)));
  });
});
