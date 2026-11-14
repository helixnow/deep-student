import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadTauriConfig } from '../shell/tauri-config.ts';
import { mapWindowConfig } from '../shell/window-options.ts';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(windows: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'f2-tauri-conf-'));
  roots.push(dir);
  writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ app: { windows } }));
  return () => loadTauriConfig(dir, 'linux');
}

it('the shipped tauri config windows decode on every desktop platform', () => {
  const dir = new URL('../../resources/app/', import.meta.url).pathname;
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(loadTauriConfig(dir, platform).windows[0]?.title).toBe('Deep Student');
    expect(loadTauriConfig(dir, platform).frontendDist).toBe(new URL('../../dist', import.meta.url).pathname);
  }
});

it('app.windows elements follow tauri-utils WindowConfig aliases, enums and colours', () => {
  const [win] = load([{
    'min-width': 10,
    titleBarStyle: 'OVERLAY',
    theme: 'Dark',
    backgroundColor: '#ff000080',
    trafficLightPosition: { x: 1, y: 2 },
    devtools: null,
  }])().windows;
  expect(win).toEqual({ minWidth: 10, titleBarStyle: 'Overlay', theme: 'dark', backgroundColor: [255, 0, 0, 128], trafficLightPosition: { x: 1, y: 2 } });
  // Tauri Color is RGBA; Electron backgroundColor is #AARRGGBB.
  expect(mapWindowConfig(win!, 'linux', false).backgroundColor).toBe('#80ff0000');
  expect(load([{ backgroundColor: [1, 2, 3] }])().windows[0]?.backgroundColor).toEqual([1, 2, 3, 255]);
});

it('app.windows elements fail closed on input WindowConfig rejects', () => {
  expect(load([{ widht: 1 }])).toThrow('app.windows[0]: unknown field `widht`');
  expect(load([{ width: '800' }])).toThrow('invalid type: string "800", expected f64');
  expect(load([{ resizable: null }])).toThrow('invalid type: null, expected a boolean');
  expect(load([{ minWidth: 1, 'min-width': 2 }])).toThrow('duplicate field `minWidth`');
  expect(load([{ backgroundColor: '#12345' }])).toThrow('Invalid hex color length');
  expect(load([{ trafficLightPosition: { x: 1 } }])).toThrow('missing field `y`');
  expect(load([{ scrollBarStyle: 'overlay' }])).toThrow('unknown variant `overlay`');
  expect(load({})).toThrow('app.windows: invalid type');
});

it('app.windows focusable reaches the native window options independently of initial focus', () => {
  const win = load([{ focusable: false, focus: true }])().windows[0]!;
  expect(mapWindowConfig(win, 'linux', false)).toMatchObject({ focusable: false, focus: true });
  expect(mapWindowConfig(load([{}])().windows[0]!, 'linux', false).focusable).toBe(true);
});
