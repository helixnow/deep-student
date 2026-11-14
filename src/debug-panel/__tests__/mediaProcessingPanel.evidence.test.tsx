/**
 * Evidence for the media processing debug panel, recorded before the 801-line file was split. Backend progress
 * arrives through Tauri `listen` (mocked: the test calls the handlers the panel registered), attachment logs as
 * `CHATV2_LOG_ADDED` window events, and the store cards come from the real pdfProcessingStore. The goldens hold the
 * panel (classes, icons, full text), the rows under each filter, the expanded detail, and the listener lifecycle.
 * Times run on a fake clock pinned to a local wall time.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATV2_LOG_EVENT } from '@/features/chat/debug/chatV2Logger';
import type { PdfProcessingStatus, usePdfProcessingStore as StoreHook } from '@/features/pdf/stores/pdfProcessingStore';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

type Handler = (event: { payload: unknown }) => void;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  listened: [] as string[],
  unlistened: [] as string[],
  held: null as null | Array<() => void>,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    h.listened.push(name);
    const register = () => {
      if (!h.handlers.has(name)) h.handlers.set(name, new Set());
      h.handlers.get(name)!.add(handler);
      return () => {
        h.unlistened.push(name);
        h.handlers.get(name)!.delete(handler);
      };
    };
    if (h.held) return new Promise((resolve) => h.held!.push(() => resolve(register())));
    return Promise.resolve(register());
  }),
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
/** The panel's own store instance: modules are reset before each case. */
let store: typeof StoreHook;
const props = (isActivated: boolean, visible = true): PanelProps => ({ visible, isActive: true, isActivated, onClose: () => undefined });

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

/** One backend event through the handlers the panel registered, `gap` ms after the previous one. */
async function emit(name: string, payload: unknown, gap = 37) {
  await step(() => {
    vi.advanceTimersByTime(gap);
    for (const handler of [...(h.handlers.get(name) ?? [])]) handler({ payload });
  });
}

/** One chatV2Logger entry as the logger broadcasts it. */
async function chatLog(action: string, data: Record<string, unknown>, category = 'attachment', gap = 37) {
  await step(() => {
    vi.advanceTimersByTime(gap);
    const detail = { id: `log-${action}`, timestamp: new Date().toISOString(), category, stage: 'attachment', action, data, severity: 'info' };
    window.dispatchEvent(new CustomEvent(CHATV2_LOG_EVENT, { detail }));
  });
}

const STORE: Array<[string, PdfProcessingStatus]> = [
  ['att_pdf_1', { stage: 'page_rendering', percent: 47.6, readyModes: ['text'], currentPage: 3, totalPages: 8, mediaType: 'pdf' }],
  ['att_img_1', { stage: 'completed', percent: 100, readyModes: ['image', 'ocr'], mediaType: 'image' }],
  ['att_pdf_2', { stage: 'error', percent: 30, readyModes: [], error: 'OCR provider timeout' }],
  ['att_pdf_6', { stage: 'completed_with_issues', percent: 0, readyModes: [], currentPage: 0, totalPages: 5 }],
];

/** Every backend event and attachment log the panel handles, plus two it ignores. */
async function sendRound() {
  await emit('media-processing-progress', { fileId: 'att_pdf_1', mediaType: 'pdf', status: { stage: 'text_extraction', percent: 12.4, readyModes: [] } });
  await emit('media-processing-progress', {
    fileId: 'att_pdf_1', mediaType: 'pdf', status: { stage: 'page_rendering', percent: 47.6, readyModes: ['text'], currentPage: 3, totalPages: 8 },
  });
  await emit('media-processing-progress', { fileId: 'att_img_1', mediaType: 'image', status: { stage: 'image_compression', percent: 50, readyModes: [] } });
  await emit('media-processing-completed', { fileId: 'att_img_1', mediaType: 'image', readyModes: ['image', 'ocr'] });
  await emit('media-processing-error', { fileId: 'att_pdf_2', mediaType: 'pdf', stage: 'ocr_processing', error: 'OCR provider timeout' });
  await emit('pdf-processing-progress', { fileId: 'att_pdf_3', status: { stage: 'vector_indexing', percent: 88, readyModes: ['text', 'ocr'], currentPage: 8, totalPages: 8 } });
  await emit('pdf-processing-completed', { fileId: 'att_pdf_3', readyModes: ['text', 'ocr', 'image'] });
  await emit('pdf-processing-error', { fileId: 'att_pdf_4', stage: 'text_extraction', error: 'encrypted pdf' });
  await chatLog('inject_mode_change', { attachmentId: 'att_pdf_1', mediaType: 'pdf', before: ['text'], after: ['text', 'image'], toggledMode: 'image' });
  await chatLog('inject_mode_change', { before: [], after: ['ocr'] });
  await chatLog('format_resource_done', {
    resourceId: 'res_img_1', typeId: 'image', injectedContent: { textBlocks: 1, imageBlocks: 2, totalTextLength: 40, hasMultimodal: true }, injectModes: { res_img_1: ['image'] },
  });
  await chatLog('format_resource_done', { resourceId: 'res_pdf_1', typeId: 'file' });
  await chatLog('processing_store_init', { sourceId: 'att_pdf_5', mediaType: 'pdf', stage: 'pending', percent: 0, readyModes: [] });
  await chatLog('status_sync_progress', { sourceId: 'att_pdf_5', stage: 'ocr_processing', percent: 33.3, readyModes: ['text'] });
  await chatLog('status_sync_completed', { sourceId: 'att_pdf_5', mediaType: 'pdf', percent: 100, readyModes: ['text', 'ocr'] });
  await chatLog('status_sync_error', { sourceId: 'att_img_2', mediaType: 'image', error: 'decode failed' });
  await chatLog('attachment_remove', { sourceId: 'att_pdf_5' });
  await chatLog('remove_attachment', { attachmentId: 'att_img_2' });
  await chatLog('retry_processing_start', { sourceId: 'att_pdf_2', mediaType: 'pdf' });
  await chatLog('processing_store_cleanup', { sourceId: 'att_pdf_4' });
  await chatLog('processing_store_batch_cleanup', { sourceIds: ['att_pdf_3', 'att_img_1'] });
  await chatLog('status_sync_progress', { sourceId: 'att_other' }, 'pipeline');
  await chatLog('upload_done', { sourceId: 'att_other' });
}

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[class*="border-b border-border/50 py-2 px-2"]'));
const rowText = (container: HTMLElement) => rows(container).map((row) => row.textContent);
const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;
const header = (container: HTMLElement) => Array.from(container.querySelectorAll('h3')).map((el) => el.textContent).join(' | ');
const stats = (container: HTMLElement) => container.querySelector('.flex.flex-wrap.gap-3.text-xs')!.textContent;
const toolbar = (container: HTMLElement) => container.querySelector<HTMLElement>('.flex.items-center.justify-between.flex-wrap')!;

async function mount(element: React.ReactElement) {
  const view = render(element);
  await act(async () => {});
  return view;
}

// Row times use `toLocaleTimeString(undefined, …)`.
pinDefaultLocaleForFile();

beforeEach(async () => {
  h.handlers.clear();
  h.listened.length = 0;
  h.unlistened.length = 0;
  h.held = null;
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 90) + 1) / 1000);
  vi.resetModules();
  ({ usePdfProcessingStore: store } = await import('@/features/pdf/stores/pdfProcessingStore'));
  ({ default: Panel } = (await import('../plugins/MediaProcessingDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('media processing debug panel (evidence before the split)', () => {
  it('records every backend event and attachment log, newest first, with the counts and the store cards', async () => {
    const { container } = await mount(<Panel {...props(true)} />);
    const empty = panelText(container);
    await step(() => store.setState({ statusMap: new Map(STORE) }));
    await sendRound();

    expect(empty).toBe(golden('media-processing.empty.txt', empty));
    const round = panelText(container);
    expect(round).toBe(golden('media-processing.round.txt', round));
  });

  it('expands a row, filters by media type, hides the store, pauses, resumes and clears', async () => {
    const { container } = await mount(<Panel {...props(true)} />);
    await step(() => store.setState({ statusMap: new Map(STORE) }));
    await sendRound();
    const views: string[] = [];
    const view = (label: string, body: string) => views.push(`## ${label}\n${body}`);

    const oldest = () => rows(container).at(-1)!;
    await step(() => fireEvent.click(rows(container)[0]!));
    view('expanded newest', panelText(rows(container)[0]!));
    await step(() => fireEvent.click(oldest()));
    view('expanded oldest, newest closed', `${panelText(oldest())}open rows: ${rows(container).filter((row) => row.querySelector('pre')).length}`);
    await step(() => fireEvent.click(oldest()));
    view('collapsed', `open rows: ${container.querySelectorAll('pre').length}`);

    for (const label of ['PDF', '图片', '全部']) {
      await step(() => fireEvent.click(button(container, label)));
      view(`filter ${label}`, `${header(container)}\n${stats(container)}\n${rowText(container).join('\n')}`);
    }
    const filterButtons = panelText(toolbar(container).children[1] as HTMLElement);

    await step(() => fireEvent.click(button(container, 'Store')));
    view('store hidden', `${container.textContent?.includes('pdfProcessingStore 状态')}`);
    await step(() => fireEvent.click(button(container, 'Store')));
    view('store shown', `${container.textContent?.includes('pdfProcessingStore 状态')}`);

    const listenedBeforePause = h.listened.length;
    await step(() => fireEvent.click(button(container, '暂停')));
    await act(async () => {});
    await emit('media-processing-completed', { fileId: 'att_paused', mediaType: 'pdf', readyModes: ['text'] });
    await chatLog('attachment_remove', { sourceId: 'att_paused' });
    view('paused', `${header(container)}\n${stats(container)}\n${rowText(container).slice(0, 2).join('\n')}\nlisten +${h.listened.length - listenedBeforePause}, unlisten ${h.unlistened.length}`);
    const pausedToolbar = panelText(toolbar(container));
    await step(() => fireEvent.click(button(container, '恢复')));
    await act(async () => {});
    await emit('media-processing-completed', { fileId: 'att_resumed', mediaType: 'image', readyModes: ['image'] });
    view('resumed', `${header(container)}\n${stats(container)}\n${rowText(container).slice(0, 2).join('\n')}\nlisten +${h.listened.length - listenedBeforePause}, unlisten ${h.unlistened.length}`);

    await step(() => fireEvent.click(button(container, '清空')));
    const cleared = panelText(container);

    const current = `${views.join('\n')}\n----\n${filterButtons}----\n${pausedToolbar}----\n${cleared}`;
    expect(current).toBe(golden('media-processing.controls.txt', current));
  });

  it('listens only while activated, keeps recording while hidden, and drops listeners that resolve after deactivation', async () => {
    const steps: string[] = [];
    const note = (label: string, container: HTMLElement) =>
      steps.push(`${label}: listen ${h.listened.length}, unlisten ${h.unlistened.length}, handlers ${[...h.handlers.values()].reduce((n, set) => n + set.size, 0)}, rows ${rows(container).length}, empty ${container.innerHTML === ''}`);

    const { container, rerender, unmount } = await mount(<Panel {...props(false)} />);
    await chatLog('attachment_remove', { sourceId: 'att_before' });
    note('inactive', container);

    await step(() => rerender(<Panel {...props(true)} />));
    await act(async () => {});
    note('activated', container);
    steps.push(`channels: ${[...new Set(h.listened)].join(', ')}`);
    await emit('media-processing-progress', { fileId: 'att_1', mediaType: 'pdf', status: { stage: 'pending', percent: 0, readyModes: [] } });
    await chatLog('attachment_remove', { sourceId: 'att_1' });
    note('two events', container);

    await step(() => rerender(<Panel {...props(true, false)} />));
    await chatLog('remove_attachment', { attachmentId: 'att_hidden' });
    note('hidden', container);
    await step(() => rerender(<Panel {...props(true)} />));
    note('shown again', container);

    await step(() => rerender(<Panel {...props(false)} />));
    await emit('media-processing-progress', { fileId: 'att_off', mediaType: 'pdf', status: { stage: 'pending', percent: 0, readyModes: [] } });
    await chatLog('attachment_remove', { sourceId: 'att_off' });
    note('deactivated', container);

    h.held = [];
    await step(() => rerender(<Panel {...props(true)} />));
    note('reactivated, listen pending', container);
    await step(() => rerender(<Panel {...props(false)} />));
    const held = h.held;
    h.held = null;
    await act(async () => {
      for (const release of held) release();
    });
    note('deactivated, then listen resolved', container);

    await step(() => rerender(<Panel {...props(true)} />));
    await act(async () => {});
    note('reactivated', container);
    steps.push(`rows: ${rowText(container).join(' / ')}`);
    unmount();
    note('unmounted', container);

    const current = `${steps.join('\n')}\n`;
    expect(current).toBe(golden('media-processing.lifecycle.txt', current));
  });

  it('keeps the newest 200 events', async () => {
    const { container } = await mount(<Panel {...props(true)} />);
    const [handler] = h.handlers.get('media-processing-progress')!;
    await step(() => {
      for (let i = 0; i < 205; i += 1) {
        vi.advanceTimersByTime(1);
        handler!({ payload: { fileId: `att_${i}`, mediaType: 'pdf', status: { stage: 'pending', percent: 0, readyModes: [] } } });
      }
    });
    const list = rows(container);
    expect(list).toHaveLength(200);
    expect(list[0]!.textContent).toContain('att_204');
    expect(list[199]!.textContent).toContain('att_5');
    expect(stats(container)).toContain('事件: 200');
  });
});
