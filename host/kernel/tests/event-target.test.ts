import { describe, expect, it } from 'vitest';
import { emitToFilter, matchAnyOrFilter } from '../event-target.ts';
import type { EventTarget } from '../protocol.ts';

const any: EventTarget = { kind: 'Any' };
const app: EventTarget = { kind: 'App' };
const windowMain: EventTarget = { kind: 'Window', label: 'main' };
const windowQuick: EventTarget = { kind: 'Window', label: 'quick' };
const webviewMain: EventTarget = { kind: 'Webview', label: 'main' };
const webviewWindowMain: EventTarget = { kind: 'WebviewWindow', label: 'main' };
const anyLabelMain: EventTarget = { kind: 'AnyLabel', label: 'main' };

describe('Tauri event target filtering', () => {
  it('treats broadcast as filter=None so window listeners receive backend emit', () => {
    const filter = emitToFilter(any);
    expect(filter).toBeNull();
    for (const target of [any, app, windowMain, windowQuick, webviewMain, webviewWindowMain, anyLabelMain]) {
      expect(matchAnyOrFilter(target, filter)).toBe(true);
    }
  });

  it('matches Window filters like emit_to(Window{label})', () => {
    const filter = emitToFilter(windowMain)!;
    expect(filter(windowMain)).toBe(true);
    expect(filter(anyLabelMain)).toBe(true);
    expect(filter(windowQuick)).toBe(false);
    expect(filter(webviewMain)).toBe(false);
    expect(filter(webviewWindowMain)).toBe(false);
    expect(filter(app)).toBe(false);
    expect(filter(any)).toBe(false);
    expect(matchAnyOrFilter(any, filter)).toBe(true);
    expect(matchAnyOrFilter(windowMain, filter)).toBe(true);
    expect(matchAnyOrFilter(windowQuick, filter)).toBe(false);
  });

  it('matches AnyLabel filters across window/webview kinds by label', () => {
    const filter = emitToFilter(anyLabelMain)!;
    expect(filter(windowMain)).toBe(true);
    expect(filter(webviewMain)).toBe(true);
    expect(filter(webviewWindowMain)).toBe(true);
    expect(filter(anyLabelMain)).toBe(true);
    expect(filter(windowQuick)).toBe(false);
    expect(filter(app)).toBe(false);
  });

  it('keeps Webview / WebviewWindow / App scopes isolated', () => {
    const webviewFilter = emitToFilter(webviewMain)!;
    expect(webviewFilter(webviewMain)).toBe(true);
    expect(webviewFilter(anyLabelMain)).toBe(true);
    expect(webviewFilter(webviewWindowMain)).toBe(false);
    expect(webviewFilter(windowMain)).toBe(false);

    const webviewWindowFilter = emitToFilter(webviewWindowMain)!;
    expect(webviewWindowFilter(webviewWindowMain)).toBe(true);
    expect(webviewWindowFilter(anyLabelMain)).toBe(true);
    expect(webviewWindowFilter(webviewMain)).toBe(false);
    expect(webviewWindowFilter(windowMain)).toBe(false);

    const appFilter = emitToFilter(app)!;
    expect(appFilter(app)).toBe(true);
    expect(appFilter(windowMain)).toBe(false);
    expect(appFilter(any)).toBe(false);
  });
});
