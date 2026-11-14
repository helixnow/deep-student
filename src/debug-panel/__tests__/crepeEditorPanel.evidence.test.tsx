/**
 * Evidence for the Crepe editor debug panel, recorded before the file was split. Reports arrive the way the editor
 * sends them, through the `crepe-editor` debug channel with the master switch on; global errors and rejections as
 * window events; the live DOM snapshot from a fake Crepe wrapper every second. The goldens hold the panel (classes,
 * inline colours, icons, full text including closed <details>), the diagnosis, the filters, the copied and exported
 * JSON, and the activation lifecycle. Times run on a fake clock pinned to a local wall time; ISO stamps (also the one
 * in the export file name) are written as exact offsets from it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

const h = vi.hoisted(() => ({
  copied: [] as string[],
  notices: [] as string[],
  blobs: [] as Array<{ text: string; type?: string }>,
  downloads: [] as Array<{ href: string; download: string }>,
  revoked: [] as string[],
}));

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

/** ISO stamps (and the export name's `YYYY-MM-DDTHH-MM-SS`) as offsets from START; each is an instant on the fake clock. */
const stamps = (text: string) =>
  text
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) => `START+${Date.parse(iso) - START.getTime()}ms`)
    .replace(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/g, (_, day, hh, mm, ss) => `START+${Date.parse(`${day}T${hh}:${mm}:${ss}Z`) - START.getTime()}ms`);

/**
 * Raw epoch times in the export (`"ts"` and the `<ts>-<random hex>` ids) as offsets from START. The hex part is
 * written as `<random>`: how many `Math.random()` draws precede an entry varies between runs (the id is made inside a
 * state updater), so the test checks each id's shape against its own `ts` instead.
 */
const epochs = (text: string) =>
  text
    .replace(/"id": "(\d{13})-[0-9a-f]{1,6}"/g, (_, ts) => `"id": "START+${Number(ts) - START.getTime()}ms-<random>"`)
    .replace(/"ts": (\d{13})/g, (_, ts) => `"ts": START+${Number(ts) - START.getTime()}ms`);

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
type Channel = typeof import('@/shared/debug/channels/crepeEditor');
type Switch = typeof import('../debugMasterSwitch')['debugMasterSwitch'];
let Panel: React.ComponentType<PanelProps>;
let channel: Channel;
let master: Switch;
let wrapper: HTMLElement | null = null;
const props = (isActivated = true, visible = true): PanelProps => ({ visible, isActive: true, isActivated, onClose: () => undefined });

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

/** One report through the channel, 29 ms after the previous one. */
async function report(...args: Parameters<Channel['emitCrepeDebug']>) {
  await step(() => {
    vi.advanceTimersByTime(29);
    channel.emitCrepeDebug(...args);
  });
}

async function windowEvent(event: Event) {
  await step(() => {
    vi.advanceTimersByTime(29);
    window.dispatchEvent(event);
  });
}

function rejection(reason: unknown) {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

function mountWrapper(ready: boolean) {
  wrapper = document.createElement('div');
  wrapper.className = ready ? 'crepe-editor-wrapper ready' : 'crepe-editor-wrapper';
  wrapper.setAttribute('data-ready', String(ready));
  if (!ready) wrapper.setAttribute('style', 'pointer-events: none; opacity: 0.5');
  wrapper.innerHTML = `<div class="milkdown"><div class="ProseMirror" contenteditable="${ready}"><p>text</p></div></div><div class="toolbar"></div>`;
  document.body.appendChild(wrapper);
  return wrapper;
}

const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.title === label || b.textContent?.trim() === label)!;
const logList = (container: HTMLElement) => container.querySelector<HTMLElement>('.max-h-\\[400px\\]')!;
const messages = (container: HTMLElement) =>
  Array.from(logList(container).querySelectorAll('.text-sm.text-gray-800')).map((el) => el.textContent);
const logHeader = (container: HTMLElement) => logList(container).previousElementSibling!.textContent;

/** Every category and level, details (also empty), DOM and editor snapshots, and global errors with and without a keyword. */
async function sendRound(target: HTMLElement) {
  await report('lifecycle', 'info', 'CrepeEditor mount', { noteId: 'note_1' });
  await report('init', 'debug', '创建 Crepe 实例', { features: ['code-mirror', 'image-block'] });
  await report('dependency', 'warning', 'Prism 语言包加载慢', { ms: 812 });
  await report('dom', 'info', 'DOM 状态', {}, channel.captureDOMSnapshot(target));
  await report('editor', 'debug', 'markdownUpdated', { length: 42 }, undefined, {
    crepeExists: true, isReady: false, readonly: false, noteId: 'note_1', subject: null, markdownLength: 42,
  });
  await report('snapshot', 'info', '编辑器快照', undefined, undefined, { crepeExists: false, isReady: false, readonly: true, noteId: null, markdownLength: 0 });
  await report('error', 'error', 'Crepe.create() 失败', { error: 'TypeError: x is undefined' });
  await windowEvent(new ErrorEvent('error', { message: 'Prism is not defined', filename: 'prism.js', lineno: 3, colno: 7, error: new ReferenceError('Prism is not defined') }));
  await windowEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded', filename: 'app.js', lineno: 1, colno: 1 }));
  const reason = new Error('milkdown plugin failed');
  reason.stack = 'Error: milkdown plugin failed\n    at load (milkdown.js:9:1)';
  await windowEvent(rejection(reason));
  await windowEvent(rejection('network down'));
}

async function mount(element: React.ReactElement) {
  const view = render(element);
  await act(async () => {});
  return view;
}

// Row times use `toLocaleTimeString(undefined, …)`.
pinDefaultLocaleForFile();

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 90) + 1) / 1000);
  vi.resetModules();
  ({ debugMasterSwitch: master } = await import('../debugMasterSwitch'));
  master.enable();
  ({ default: Panel } = (await import('../plugins/CrepeEditorDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
  channel = await import('@/shared/debug/channels/crepeEditor');
});

afterEach(() => {
  cleanup();
  wrapper?.remove();
  wrapper = null;
  master.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const list of [h.copied, h.notices, h.blobs, h.downloads, h.revoked]) list.length = 0;
});

describe('Crepe editor debug panel (evidence before the split)', () => {
  it('shows every category and level, the global errors it recognises, and the live snapshot diagnosis', async () => {
    const target = mountWrapper(false);
    const { container } = await mount(<Panel {...props()} />);
    const activated = stamps(panelText(container));
    await sendRound(target);
    await step(() => vi.advanceTimersByTime(1000));

    expect(activated).toBe(golden('crepe-editor.activated.txt', activated));
    const round = stamps(panelText(container));
    expect(round).toBe(golden('crepe-editor.round.txt', round));
  });

  it('filters, copies, exports, snapshots and clears', async () => {
    const target = mountWrapper(false);
    const { container } = await mount(<Panel {...props()} />);
    await sendRound(target);
    const views: string[] = [];
    const view = (label: string) => views.push(`## ${label}\n${logHeader(container)}\n${messages(container).join('\n')}`);

    await step(() => fireEvent.click(button(container, '仅显示错误和警告')));
    view('errors and warnings only');
    const filterButton = panelText(button(container, '仅显示错误和警告'));
    await step(() => fireEvent.click(button(container, '仅显示错误和警告')));

    const chip = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.startsWith(`${label}:`))!;
    await step(() => fireEvent.click(chip('错误')));
    view('category chip 错误');
    const chipOn = panelText(chip('错误'));
    await step(() => fireEvent.click(chip('错误')));
    view('category chip 错误 again (all)');

    const [categorySelect, levelSelect] = Array.from(container.querySelectorAll('select'));
    await step(() => fireEvent.change(categorySelect!, { target: { value: 'editor' } }));
    view('category select editor');
    await step(() => fireEvent.change(categorySelect!, { target: { value: 'all' } }));
    for (const level of ['debug', 'info', 'warning', 'error']) {
      await step(() => fireEvent.change(levelSelect!, { target: { value: level } }));
      view(`level ${level}`);
    }
    await step(() => fireEvent.change(levelSelect!, { target: { value: 'all' } }));

    const search = container.querySelector('input[type="text"]')!;
    await step(() => fireEvent.change(search, { target: { value: 'NOTE_1' } }));
    view('keyword NOTE_1 (case-insensitive, matches the details JSON)');
    await step(() => fireEvent.change(search, { target: { value: 'no-such-text' } }));
    view('keyword without matches');
    const noMatch = `${panelText(logList(container))}copy all disabled: ${button(container, '复制所有日志到剪贴板').disabled}`;
    await step(() => fireEvent.change(search, { target: { value: '' } }));

    await step(() => fireEvent.click(button(container, '自动滚动到底部')));
    const autoScrollOff = panelText(button(container, '自动滚动到底部'));

    await act(async () => {
      fireEvent.click(logList(container).querySelectorAll<HTMLButtonElement>('button[title="复制日志"]')[3]!);
    });
    await step(() => fireEvent.change(levelSelect!, { target: { value: 'error' } }));
    await act(async () => {
      fireEvent.click(button(container, '复制所有日志到剪贴板'));
    });
    await step(() => fireEvent.change(levelSelect!, { target: { value: 'all' } }));

    vi.stubGlobal('Blob', class {
      constructor(parts: string[], options?: { type?: string }) {
        h.blobs.push({ text: parts.join(''), type: options?.type });
      }
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:crepe-editor-export' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => h.revoked.push(url) });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      h.downloads.push({ href: this.href, download: this.download });
    });
    await step(() => vi.advanceTimersByTime(1000));
    await step(() => fireEvent.click(button(container, '导出日志为JSON文件')));
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;

    target.remove();
    await step(() => fireEvent.click(button(container, '手动捕获 DOM 快照')));
    view('manual snapshot without a wrapper');
    const snapshotPanels = panelText(root(container).children[1] as HTMLElement);

    await step(() => fireEvent.click(button(container, '清空日志')));
    const cleared = `${panelText(logList(container))}export disabled: ${button(container, '导出日志为JSON文件').disabled}`;

    const controls = stamps(`${views.join('\n')}\n----\n${filterButton}${chipOn}${autoScrollOff}----\n${noMatch}\n----\n${snapshotPanels}----\n${cleared}\n`);
    expect(controls).toBe(golden('crepe-editor.controls.txt', controls));
    expect(h.copied).toHaveLength(2);
    expect(h.blobs).toHaveLength(1);
    const exportedLogs = (JSON.parse(h.blobs[0]!.text) as { logs: Array<{ id: string; ts: number; timestamp: string }> }).logs;
    for (const log of exportedLogs) {
      expect(log.id).toMatch(new RegExp(`^${log.ts}-[0-9a-f]{1,6}$`));
      expect(log.timestamp).toBe(new Date(log.ts).toISOString());
    }
    const exported = epochs(stamps(
      `${h.copied[0]}\n----\n${h.copied[1]}\n----\n${h.notices.join('\n')}\n----\n${JSON.stringify(h.downloads)} ${h.blobs[0]!.type} revoked ${JSON.stringify(h.revoked)}\n${h.blobs[0]!.text}\n`,
    ));
    expect(exported).not.toMatch(/\d{13}/);
    expect(exported).toBe(golden('crepe-editor.copied.txt', exported));
  });

  it('listens only while activated, keeps its logs across deactivation, and reports a healthy editor', async () => {
    const steps: string[] = [];
    const note = (label: string, container: HTMLElement) =>
      steps.push(`${label}: ${root(container) ? `${logHeader(container)} [${messages(container).join(', ')}]` : '(not rendered)'}, timers ${vi.getTimerCount()}`);

    mountWrapper(true);
    const { container, rerender, unmount } = await mount(<Panel {...props(false)} />);
    await report('lifecycle', 'info', '未激活时');
    note('not activated', container);

    await step(() => rerender(<Panel {...props()} />));
    await report('editor', 'info', '激活后');
    note('activated', container);
    await step(() => vi.advanceTimersByTime(1000));
    const healthy = panelText(root(container).children[1] as HTMLElement);

    master.disable();
    await report('editor', 'error', '总开关关闭');
    note('master switch off', container);
    master.enable();

    await step(() => rerender(<Panel {...props(true, false)} />));
    note('visible=false (ignored)', container);

    await step(() => rerender(<Panel {...props(false)} />));
    await report('editor', 'info', '停用后');
    await windowEvent(new ErrorEvent('error', { message: 'crepe crashed while inactive' }));
    await windowEvent(rejection('ProseMirror rejected while inactive'));
    note('deactivated', container);

    await step(() => rerender(<Panel {...props()} />));
    note('activated again', container);
    unmount();
    note('unmounted', container);

    const current = stamps(`${steps.join('\n')}\n----\n${healthy}`);
    expect(current).toBe(golden('crepe-editor.lifecycle.txt', current));
  });

  it('keeps the newest 500 logs', async () => {
    const { container } = await mount(<Panel {...props()} />);
    await step(() => {
      for (let i = 0; i < 505; i += 1) {
        vi.advanceTimersByTime(1);
        channel.emitCrepeDebug('editor', 'debug', `report ${i}`);
      }
    });
    const shown = messages(container);
    expect(shown).toHaveLength(500);
    expect(shown[0]).toBe('report 5');
    expect(shown[499]).toBe('report 504');
    expect(logHeader(container)).toBe('日志记录 (500 / 500)');
  });
});
