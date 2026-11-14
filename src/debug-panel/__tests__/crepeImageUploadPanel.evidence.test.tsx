/**
 * Evidence for the Crepe image upload debug panel, recorded before the file was split. Reports arrive the way the
 * editor sends them: through the `crepe-image-upload` debug channel (emitter and DOM-capture queries) with the debug
 * master switch on, over a fake Crepe image block. The goldens hold the panel (inline colours, icons, full text), its
 * console output, the copied log text and diagnostic report, and the subscription lifecycle. Times run on a fake clock
 * pinned to a local wall time; copied ISO stamps are written as exact offsets from it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

const h = vi.hoisted(() => ({ copied: [] as string[], notices: [] as string[], console: [] as string[] }));

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
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DeepStudentProbe/1.0';

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE && !fs.existsSync(file)) fs.writeFileSync(file, current);
  return fs.readFileSync(file, 'utf8');
}

/** ISO stamps as `START+<ms>ms`; each one is an instant on the fake clock, so the mapping is exact. */
const isoOffsets = (text: string) =>
  text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) => `START+${Date.parse(iso) - START.getTime()}ms`);

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
type Channel = typeof import('@/shared/debug/channels/crepeImageUpload');
type Switch = typeof import('../debugMasterSwitch')['debugMasterSwitch'];
let Panel: React.ComponentType<PanelProps>;
let channel: Channel;
let master: Switch;
let editor: HTMLElement | null = null;
const props = (visible = true, isActivated = true): PanelProps => ({ visible, isActive: true, isActivated, onClose: () => undefined });

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

/** One report through the channel, 23 ms after the previous one. */
async function report(...args: Parameters<Channel['emitImageUploadDebug']>) {
  await step(() => {
    vi.advanceTimersByTime(23);
    channel.emitImageUploadDebug(...args);
  });
}

function mountEditor() {
  editor = document.createElement('div');
  editor.className = 'crepe-editor-wrapper';
  editor.innerHTML = [
    '<div class="milkdown-image-block selected empty">',
    '<div class="image-edit"><div class="placeholder">',
    '<input type="file" id="upload-1" class="hidden" accept="image/*">',
    '<label class="uploader" for="upload-1"><span class="icon">+</span>Upload file</label>',
    '<div class="link-importer"><input class="link-input-area" placeholder="Paste link"></div>',
    '</div></div>',
    '<img class="image" src="assets/a.png" alt="a">',
    '</div>',
    '<p><em>plain</em></p>',
  ].join('');
  document.body.appendChild(editor);
  return editor;
}

const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label || b.title === label)!;
const toolbar = (container: HTMLElement) => container.firstElementChild!.children[0] as HTMLElement;
const envBar = (container: HTMLElement) => container.firstElementChild!.children[1] as HTMLElement;
const list = (container: HTMLElement) => container.firstElementChild!.children[2] as HTMLElement;
const rows = (container: HTMLElement) => Array.from(list(container).children).filter((row) => (row as HTMLElement).style.borderLeft !== '');
const messages = (container: HTMLElement) => rows(container).map((row) => row.children[1]!.textContent);

/** Every stage and level the editor reports, with details, DOM info and an image block snapshot. */
async function sendRound(root: HTMLElement) {
  const icon = root.querySelector<HTMLElement>('label.uploader .icon')!;
  await report('click_detected', 'info', '点击图片上传区域', { target: 'span.icon', button: 0 }, channel.captureDOMInfo(icon));
  await report('selector_check', 'debug', '选择器检查', { matched: ['label.uploader'] });
  await report('tauri_check', 'debug', 'Tauri 环境检测', { isTauri: false });
  await report('dialog_open', 'info', '打开文件对话框', { multiple: false, filters: ['png', 'jpg'] });
  await report('dialog_result', 'warning', '用户取消选择', { path: null });
  await report('file_read', 'debug', 'proxyDomURL 被调用', { url: 'assets/a.png' });
  await report('file_convert', 'success', 'Base64 转换成功', { length: 1234 });
  await report('upload_start', 'info', '调用 notes_save_asset', { noteId: 'note_1', size: 2048 });
  await report('upload_complete', 'success', 'notes_save_asset 返回成功', { path: 'assets/a.png' });
  await report('node_find', 'debug', '查找节点', { found: true });
  await report('node_update', 'success', '更新节点');
  await report('node_insert', 'info', '插入节点', { pos: 12 });
  await report('image_render', 'warning', '图片渲染', { naturalWidth: 0 }, channel.captureDOMInfo(root.querySelector<HTMLElement>('img')));
  await report('click_detected', 'debug', '点击普通文本', undefined, channel.captureDOMInfo(root.querySelector<HTMLElement>('em')));
  await report('dom_snapshot', 'info', 'DOM 快照', undefined, undefined, undefined, channel.captureImageBlockSnapshot(root));
  await report('error', 'error', '图片保存失败', { error: 'ENOSPC: no space left on device' });
}

async function mount(element: React.ReactElement) {
  const view = render(element);
  await act(async () => {});
  return view;
}

// Row times use `toLocaleTimeString()`.
pinDefaultLocaleForFile();

beforeAll(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => USER_AGENT });
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
});

afterAll(() => {
  delete (navigator as unknown as Record<string, unknown>).userAgent;
  delete (navigator as unknown as Record<string, unknown>).platform;
});

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 90) + 1) / 1000);
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      h.console.push(`${level} ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' | ')}`);
    });
  }
  vi.resetModules();
  ({ debugMasterSwitch: master } = await import('../debugMasterSwitch'));
  master.enable();
  ({ default: Panel } = (await import('../plugins/CrepeImageUploadDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
  channel = await import('@/shared/debug/channels/crepeImageUpload');
});

afterEach(() => {
  cleanup();
  editor?.remove();
  editor = null;
  master.disable();
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.copied.length = 0;
  h.notices.length = 0;
  h.console.length = 0;
});

describe('Crepe image upload debug panel (evidence before the split)', () => {
  it('shows every stage and level with details, DOM info and the image block snapshot, and logs each to the console', async () => {
    const root = mountEditor();
    const { container } = await mount(<Panel {...props()} />);
    const empty = panelText(container);
    h.console.length = 0;
    await sendRound(root);

    expect(empty).toBe(golden('crepe-image-upload.empty.txt', empty));
    const round = `${panelText(container)}----\n${h.console.join('\n')}\n`;
    expect(round).toBe(golden('crepe-image-upload.round.txt', round));
  });

  it('tests selectors, snapshots, filters by level, copies, pauses and clears', async () => {
    const root = mountEditor();
    const { container } = await mount(<Panel {...props()} />);
    const scrolls = vi.spyOn(Element.prototype, 'scrollIntoView');
    await sendRound(root);
    const views: string[] = [];
    const view = (label: string, body: string) => views.push(`## ${label}\n${body}`);

    await step(() => fireEvent.click(button(container, '测试选择器')));
    view('selector test, uploader present', panelText(rows(container).at(-1)!));
    root.remove();
    await step(() => fireEvent.click(button(container, '测试选择器')));
    await step(() => fireEvent.click(button(container, '快照')));
    view('selector test and snapshot, no editor', `${messages(container).slice(-2).join('\n')}\n${panelText(envBar(container))}`);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await report('tauri_check', 'success', 'Tauri 环境');
    view('Tauri present', panelText(envBar(container)));
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    const select = container.querySelector('select')!;
    for (const level of ['debug', 'info', 'warning', 'error', 'success', 'all']) {
      await step(() => fireEvent.change(select, { target: { value: level } }));
      view(`filter ${level}`, `${toolbar(container).querySelector('span')!.textContent}\n${messages(container).join('\n')}`);
    }

    await step(() => fireEvent.change(select, { target: { value: 'warning' } }));
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    await step(() => fireEvent.change(select, { target: { value: 'all' } }));
    await act(async () => {
      fireEvent.click(button(container, '复制完整诊断报告'));
    });

    await step(() => fireEvent.click(button(container, '监听中')));
    await report('error', 'error', '暂停时的报告');
    view('paused', `${panelText(button(container, '已暂停'))}${toolbar(container).querySelector('span')!.textContent}`);
    await step(() => fireEvent.click(button(container, '已暂停')));
    await report('node_update', 'info', '恢复后的报告');
    view('resumed', `${toolbar(container).querySelector('span')!.textContent}\n${messages(container).at(-1)}`);

    await step(() => fireEvent.click(button(container, '清空日志')));
    view('cleared', panelText(container.firstElementChild!.children[1] as HTMLElement) + panelText(list(container)));
    view('scrollIntoView', `${scrolls.mock.calls.length} calls, ${JSON.stringify([...new Set(scrolls.mock.calls.map((call) => JSON.stringify(call)))])}`);

    const controls = `${views.join('\n')}\n`;
    expect(controls).toBe(golden('crepe-image-upload.controls.txt', controls));
    const copied = `${isoOffsets(h.copied[0]!)}\n----\n${isoOffsets(h.copied[1]!)}\n----\n${h.notices.join('\n')}\n`;
    expect(h.copied).toHaveLength(2);
    expect(copied).toBe(golden('crepe-image-upload.copied.txt', copied));
  });

  it('records only with the master switch on and while mounted, also when hidden or not activated', async () => {
    const steps: string[] = [];
    const note = (label: string, container: HTMLElement) =>
      steps.push(`${label}: rows ${container.firstElementChild ? messages(container).join(', ') || '-' : '(not rendered)'}, console ${h.console.length}`);

    await report('node_find', 'info', '挂载前');
    const { container, rerender, unmount } = await mount(<Panel {...props(true, false)} />);
    note('mounted (not activated) after an earlier report', container);
    await report('node_find', 'info', '未激活');
    note('not activated', container);

    master.disable();
    await report('node_find', 'error', '总开关关闭');
    note('master switch off', container);
    master.enable();

    await step(() => rerender(<Panel {...props(false)} />));
    await report('node_update', 'info', '隐藏时');
    note('hidden', container);
    await step(() => rerender(<Panel {...props()} />));
    note('shown again', container);

    unmount();
    await report('node_insert', 'info', '卸载后');
    note('unmounted', container);
    const { container: again } = await mount(<Panel {...props()} />);
    note('mounted again', again);

    const current = `${steps.join('\n')}\n`;
    expect(current).toBe(golden('crepe-image-upload.lifecycle.txt', current));
  });

  it('keeps the newest 201 reports (slice(-200) before appending)', async () => {
    const { container } = await mount(<Panel {...props()} />);
    await step(() => {
      for (let i = 0; i < 205; i += 1) {
        vi.advanceTimersByTime(1);
        channel.emitImageUploadDebug('node_find', 'debug', `report ${i}`);
      }
    });
    const shown = messages(container);
    expect(shown).toHaveLength(201);
    expect(shown[0]).toBe('report 4');
    expect(shown[200]).toBe('report 204');
    expect(toolbar(container).querySelector('span')!.textContent).toBe('201 / 201 条');
  });
});
