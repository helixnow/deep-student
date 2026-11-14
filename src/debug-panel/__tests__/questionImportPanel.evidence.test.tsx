/**
 * Evidence for the question import debug panel, recorded before the file is split. Backend progress arrives through
 * the module-level Tauri `listen('question_import_progress')` (mocked: the test calls the handler the module
 * registered) with payloads shaped like the IPC contract (only SessionCreated / Completed / Failed carry a session
 * id); frontend reports go through the `question-import` debug channel. The goldens hold the log list (icons, colours,
 * labels, durations, expanded details), the stats line and the copied text; the per-session tracker, the stuck check
 * on the module's 15 s interval, the filters, copy / download / clear and the 3000-entry cap are asserted directly.
 * The fake clock starts before the module loads; epoch times and the download name are written as offsets from it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panelText } from './domDump';

type Handler = (event: { payload: unknown }) => void;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listened: [] as string[],
  listenFails: false,
  copied: [] as string[],
  copyFails: 0,
  blobs: [] as Array<{ text: string; type?: string }>,
  downloads: [] as Array<{ href: string; download: string }>,
  revoked: [] as string[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    h.listened.push(name);
    if (h.listenFails) throw new Error('no event bridge');
    h.handlers.set(name, handler);
    return () => undefined;
  }),
}));
vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    if (h.copyFails > 0) {
      h.copyFails--;
      throw new Error('clipboard denied');
    }
    h.copied.push(text);
    return true;
  }),
}));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';
const START = new Date(2026, 10, 7, 10, 0, 0, 0);
const SESSION = 'qimp_0123456789abcdef_tail';

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE && !fs.existsSync(file)) fs.writeFileSync(file, current);
  return fs.readFileSync(file, 'utf8');
}

/** Epoch milliseconds (13 digits) as offsets from START; the copied detail carries the tracker's raw timestamps. */
const epochs = (text: string) => text.replace(/\b(\d{13})\b/g, (_, ms) => `START+${Number(ms) - START.getTime()}ms`);

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
type Channel = typeof import('@/shared/debug/channels/questionImport');
let Panel: React.ComponentType<PanelProps>;
let channel: Channel;
const props = (over: Partial<PanelProps> = {}): PanelProps => ({ visible: true, isActive: true, isActivated: true, onClose: () => undefined, ...over });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  h.handlers.clear();
  h.listened.length = 0;
  h.listenFails = false;
  h.copied.length = 0;
  h.copyFails = 0;
  h.blobs.length = 0;
  h.downloads.length = 0;
  h.revoked.length = 0;
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function load() {
  ({ default: Panel } = (await import('../plugins/QuestionImportDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
  channel = await import('@/shared/debug/channels/questionImport');
  await flush();
}

/** One backend progress event `after` ms after the previous one. */
async function backend(after: number, payload: Record<string, unknown> | null) {
  await act(async () => {
    vi.advanceTimersByTime(after);
    h.handlers.get('question_import_progress')!({ payload });
  });
}

async function frontend(after: number, ...args: Parameters<Channel['emitImportDebug']>) {
  await act(async () => {
    vi.advanceTimersByTime(after);
    channel.emitImportDebug(...args);
  });
}

const parts = (container: HTMLElement) => {
  const root = container.firstElementChild as HTMLElement;
  const [stats, filters, list] = Array.from(root.children) as HTMLElement[];
  return { stats, filters, list };
};
const statsLine = (container: HTMLElement) =>
  Array.from(parts(container).stats.children).filter((el) => el.tagName === 'SPAN').map((el) => el.textContent).join(' | ');
const rows = (container: HTMLElement) => Array.from(parts(container).list.children).filter((el) => el.tagName === 'DIV' && el.firstElementChild?.tagName === 'DIV') as HTMLElement[];
const summaries = (container: HTMLElement) => rows(container).map((row) => row.firstElementChild!.lastElementChild!.textContent);
const button = (container: HTMLElement, title: string) => container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const selects = (container: HTMLElement) => Array.from(parts(container).filters.querySelectorAll('select'));
const search = (container: HTMLElement) => parts(container).filters.querySelector('input')!;
const count = (container: HTMLElement) => parts(container).filters.lastElementChild!.textContent;

/** A whole import as the backend sends it, with the frontend's invoke reports around it; 73 970 ms in total. */
async function sendImport() {
  await frontend(5, 'info', 'frontend:invoke-start', '调用 importQuestionBankStream: 期中试卷.pdf', { detail: { fileName: '期中试卷.pdf', model: 'vlm-x' } });
  await backend(40, { type: 'Preprocessing', stage: 'decoding', message: '解码文档', percent: 5 });
  await backend(300, { type: 'Preprocessing', stage: 'creating_session', message: '创建会话', percent: 30 });
  await backend(200, { type: 'RenderingPages', current: 1, total: 2 });
  await backend(150, { type: 'RenderingPages', current: 2, total: 2 });
  await backend(1200, { type: 'OcrImageCompleted', image_index: 0, total_images: 2 });
  await backend(1800, { type: 'OcrImageCompleted', image_index: 1, total_images: 2 });
  await backend(100, { type: 'OcrPhaseCompleted', total_images: 2, total_chars: 5321 });
  await backend(250, { type: 'ExtractingFigures', current: 1, total: 1 });
  await backend(400, { type: 'StructuringQuestion', current: 1, total: 3 });
  await backend(80, { type: 'SessionCreated', session_id: SESSION, name: '期中试卷', total_chunks: 2 });
  await backend(60, { type: 'ChunkStart', chunk_index: 0, total_chunks: 2 });
  await backend(2500, {
    type: 'QuestionParsed', question_index: 0, total_parsed: 1,
    question: { content: '已知函数 f(x) = x² - 2x + 3，求 f(x) 在区间 [0, 3] 上的最大值与最小值，并说明取得最值时 x 的取值。', question_type: 'calculation' },
  });
  await backend(700, { type: 'QuestionParsed', question_index: 1, total_parsed: 2, question: { content: '填空：1 + 1 = ____', question_type: 'fill_blank' } });
  await backend(90, { type: 'ChunkCompleted', chunk_index: 0, total_chunks: 2, questions_in_chunk: 2, total_parsed: 2 });
  await backend(30, { type: 'ChunkStart', chunk_index: 1, total_chunks: 2 });
  await backend(21000, { type: 'QuestionParsed', question_index: 2, total_parsed: 3, question: { content: 42, question_type: 'single_choice' } });
  await backend(45000, { type: 'ChunkCompleted', chunk_index: 1, total_chunks: 2, questions_in_chunk: 1, total_parsed: 3 });
  await backend(40, { type: 'Completed', session_id: SESSION, name: '期中试卷', total_questions: 3, partial: false, failed_count: 0 });
  await frontend(15, 'success', 'frontend:invoke-end', 'invoke 返回: 3 道题目', { sessionId: SESSION, durationMs: 73955 });
  await backend(5, { type: 'Mystery', progress: 0.5 });
  await backend(5, null);
}

describe('question import debug panel (evidence before the split)', () => {
  it('records a whole import: phases, the per-session summary, durations and expanded details', async () => {
    await load();
    expect(h.listened).toEqual(['question_import_progress']);
    const { container } = render(<Panel {...props()} />);
    expect(summaries(container)).toEqual(['Tauri question_import_progress 监听器已注册']);

    await sendImport();
    expect(count(container)).toBe('(23)');
    expect(golden('question-import.stats.txt', `${statsLine(container)}\n`)).toBe(`${statsLine(container)}\n`);

    // Expand every row that has a detail: the summary, a parsed question and the unknown event among them.
    for (const row of rows(container)) {
      const main = row.firstElementChild as HTMLElement;
      if (main.style.cursor === 'pointer') fireEvent.click(main);
    }
    const list = epochs(panelText(parts(container).list));
    expect(list).toBe(golden('question-import.round.txt', list));

    // Clicking an expanded row closes it again; a row without detail does not toggle.
    const summaryRow = rows(container).find((row) => row.textContent!.includes('=== 导入汇总'))!;
    fireEvent.click(summaryRow.firstElementChild!);
    expect(summaryRow.querySelector('pre')).toBeNull();
  });

  it('files pre-session events under "?" (no session id in their payloads), so the summary lacks their timings and the orphan reports stuck', async () => {
    await load();
    const { container } = render(<Panel {...props()} />);
    await sendImport();
    const summary = rows(container).find((row) => row.textContent!.includes('=== 导入汇总'))!;
    expect(summary.firstElementChild!.lastElementChild!.textContent).toBe(
      `=== 导入汇总: ${SESSION.slice(0, 16)} | 图片=0/0 块=2/2 题目=3 | 预处理=?ms OCR=?ms 结构化=69360ms 总耗时=69420ms ===`,
    );
    // The list hides "sid=?"; the copied text keeps it on every pre-session line.
    expect(rows(container).some((row) => row.children[1]?.textContent === 'sid=?')).toBe(false);
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    expect(h.copied[0].split('\n').filter((line) => line.includes(' sid=? ')).map((line) => line.split(' ')[2])).toEqual([
      '[backend:preprocessing]', '[backend:preprocessing]', '[backend:rendering-pages]', '[backend:rendering-pages]', '[backend:ocr-image]',
      '[backend:ocr-image]', '[backend:ocr-phase-done]', '[backend:extracting-figs]', '[backend:structuring]',
    ]);

    // The "?" session (started at START+45ms) never completes. The 15 s interval, running since module load, first sees
    // it past 3 minutes at the START+195000ms tick (the START+180000ms tick is 45 ms short); it reports once, the
    // completed session never.
    const stuck = () => rows(container).filter((row) => row.textContent!.includes('已超过 3 分钟仍未完成'));
    await act(async () => {
      vi.advanceTimersByTime(194_999 - (Date.now() - START.getTime()));
    });
    expect(stuck()).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(stuck().map((row) => row.firstElementChild!.lastElementChild!.textContent)).toEqual([
      '导入 ? 已超过 3 分钟仍未完成 | 图片=2/2 块=0/0 题目=0',
    ]);
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    expect(h.copied.at(-1)!.split('\n').at(-1)).toBe('10:03:15.000 [WARN] [anomaly:stuck] sid=? 194955ms 导入 ? 已超过 3 分钟仍未完成 | 图片=2/2 块=0/0 题目=0');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(stuck()).toHaveLength(1);
  });

  it('a failed import gets a summary without structuring time; a second import lands on the previous session id', async () => {
    await load();
    const { container } = render(<Panel {...props()} />);
    await backend(10, { type: 'SessionCreated', session_id: 'sess-one', name: '一', total_chunks: 1 });
    await backend(500, { type: 'ChunkStart', chunk_index: 0, total_chunks: 1 });
    await backend(1500, { type: 'Failed', session_id: 'sess-one', error: 'LLM 超时', total_parsed: 0 });
    await backend(100, { type: 'Preprocessing', stage: 'decoding', message: '第二次导入', percent: 3 });
    expect(summaries(container).slice(1)).toEqual([
      '会话创建: sess-one | 一 | 1 块',
      '块 1/1 开始解析',
      '导入失败: LLM 超时 | 已解析 0 题',
      '=== 导入汇总: sess-one | 图片=0/0 块=0/1 题目=0 | 预处理=?ms OCR=?ms 结构化=?ms 总耗时=2000ms ===',
      '[decoding] 第二次导入 (3%)',
    ]);
    expect(rows(container).map((row) => row.children[1]?.textContent ?? null).slice(1)).toEqual([
      'sid=sess-one', 'sid=sess-one', 'sid=sess-one', 'sid=sess-one', 'sid=sess-one',
    ]);
  });

  it('filters by level, phase prefix and a case-insensitive search, then copies, downloads and clears', async () => {
    await load();
    const { container } = render(<Panel {...props()} />);
    await sendImport();
    const [level, phase] = selects(container);

    const shown = (setup: () => void) => {
      setup();
      return [count(container), summaries(container)];
    };
    expect(shown(() => fireEvent.change(level, { target: { value: 'success' } }))).toEqual([
      '(3)', ['VLM/OCR 阶段完成: 2 张图片, 5321 字符 | 耗时 1900ms', '★ 导入完成: 期中试卷 | 3 道题目 | 总耗时 69420ms', 'invoke 返回: 3 道题目'],
    ]);
    expect(shown(() => fireEvent.change(level, { target: { value: 'debug' } }))[0]).toBe('(4)');
    expect(shown(() => fireEvent.change(level, { target: { value: 'error' } }))).toEqual(['(0)', []]);
    expect(hasText(container, '等待题目导入事件... 上传文档即可开始监控')).toBe(true);
    fireEvent.change(level, { target: { value: 'all' } });

    expect(shown(() => fireEvent.change(phase, { target: { value: 'backend:ocr' } }))[1]).toEqual([
      'VLM/OCR 图片 1/2 完成', 'VLM/OCR 图片 2/2 完成', 'VLM/OCR 阶段完成: 2 张图片, 5321 字符 | 耗时 1900ms',
    ]);
    expect(shown(() => fireEvent.change(phase, { target: { value: 'backend:chunk' } }))[0]).toBe('(4)');
    expect(shown(() => fireEvent.change(phase, { target: { value: 'backend:question' } }))[0]).toBe('(3)');
    // 「完成/失败」 is the backend:completed prefix only.
    expect(shown(() => fireEvent.change(phase, { target: { value: 'backend:completed' } }))[1]).toEqual(['★ 导入完成: 期中试卷 | 3 道题目 | 总耗时 69420ms']);
    expect(shown(() => fireEvent.change(phase, { target: { value: 'frontend:' } }))[0]).toBe('(2)');
    expect(shown(() => fireEvent.change(phase, { target: { value: 'system' } }))[0]).toBe('(3)');
    expect(shown(() => fireEvent.change(phase, { target: { value: 'backend:' } }))[0]).toBe('(18)');

    // Search: summary or session id, lower-cased but not trimmed (only an all-blank query is ignored).
    fireEvent.change(phase, { target: { value: 'all' } });
    expect(shown(() => fireEvent.change(search(container), { target: { value: 'QIMP_0123' } }))[0]).toBe('(12)');
    expect(shown(() => fireEvent.change(search(container), { target: { value: 'QIMP_0123 ' } }))[0]).toBe('(0)');
    expect(shown(() => fireEvent.change(search(container), { target: { value: '   ' } }))[0]).toBe('(23)');
    fireEvent.change(phase, { target: { value: 'all' } });
    fireEvent.change(search(container), { target: { value: '' } });

    // Copy: the filtered rows as text; the button turns green for 1.5 s.
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    expect(h.copied).toHaveLength(1);
    expect(epochs(h.copied[0])).toBe(golden('question-import.copied.txt', epochs(h.copied[0])));
    expect(button(container, '复制日志').style.color).toBe('rgb(16, 185, 129)');
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(button(container, '复制日志').style.color).toBe('rgb(107, 114, 128)');

    // A failing clipboard falls back to a textarea and execCommand('copy').
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    fireEvent.change(phase, { target: { value: 'frontend:' } });
    h.copyFails = 1;
    const appended: string[] = [];
    const append = vi.spyOn(document.body, 'appendChild').mockImplementation(function (this: HTMLElement, node: Node) {
      if (node instanceof HTMLTextAreaElement) appended.push(node.value);
      return HTMLElement.prototype.appendChild.call(this, node) as never;
    });
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    append.mockRestore();
    expect(execCommand.mock.calls).toEqual([['copy']]);
    expect(appended).toEqual([
      '10:00:00.005 [INFO] [frontend:invoke-start] 调用 importQuestionBankStream: 期中试卷.pdf \n  detail: {\n  "fileName": "期中试卷.pdf",\n  "model": "vlm-x"\n}\n'
        + `10:01:13.960 [SUCCESS] [frontend:invoke-end] sid=${SESSION.slice(0, 16)} 73955ms invoke 返回: 3 道题目`,
    ]);
    expect(document.querySelector('textarea')).toBeNull();
    expect(button(container, '复制日志').style.color).toBe('rgb(16, 185, 129)');
    delete (document as unknown as Record<string, unknown>).execCommand;

    // Download: the same text as a .log file named after the current instant.
    vi.stubGlobal('Blob', class {
      constructor(chunks: string[], options?: { type?: string }) {
        h.blobs.push({ text: chunks.join(''), type: options?.type });
      }
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:question-import' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => h.revoked.push(url) });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      h.downloads.push({ href: this.href, download: this.download });
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.click(button(container, '下载日志'));
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    expect(h.blobs).toEqual([{ text: appended[0], type: 'text/plain' }]);
    expect(h.downloads.map((d) => ({ ...d, download: d.download.replace(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, (_, day, hh, mm, ss, ms) => `START+${Date.parse(`${day}T${hh}:${mm}:${ss}.${ms}Z`) - START.getTime()}ms`) }))).toEqual([
      { href: 'blob:question-import', download: 'question-import-debug-START+75720ms.log' },
    ]);
    expect(h.revoked).toEqual(['blob:question-import']);

    // Clear: every log, the session tracker and the ids go; one system entry is written.
    fireEvent.change(phase, { target: { value: 'all' } });
    fireEvent.click(button(container, '清空'));
    expect(summaries(container)).toEqual(['日志已清空']);
    expect(statsLine(container)).toBe('题目导入调试 | 共 1');
    await act(async () => {
      fireEvent.click(button(container, '复制日志'));
    });
    expect(h.copied.at(-1)).toBe('10:01:15.720 [INFO] [system] 日志已清空');
    await act(async () => {
      vi.advanceTimersByTime(200_000);
    });
    expect(summaries(container)).toEqual(['日志已清空']);
  });

  it('collects while closed, renders only when visible and active, subscribes only while activated, and reports a failed listener', async () => {
    await load();
    await frontend(5, 'info', 'frontend:invoke-start', '面板挂载前');
    const view = render(<Panel {...props({ visible: false })} />);
    expect(view.container.innerHTML).toBe('');
    view.rerender(<Panel {...props({ isActive: false })} />);
    expect(view.container.innerHTML).toBe('');
    view.rerender(<Panel {...props()} />);
    expect(summaries(view.container)).toEqual(['Tauri question_import_progress 监听器已注册', '面板挂载前']);

    view.rerender(<Panel {...props({ isActivated: false })} />);
    await frontend(5, 'info', 'frontend:invoke-start', '停用期间');
    expect(summaries(view.container)).toHaveLength(2);
    view.rerender(<Panel {...props()} />);
    expect(summaries(view.container).at(-1)).toBe('停用期间');
    cleanup();

    vi.resetModules();
    h.listenFails = true;
    await load();
    const failed = render(<Panel {...props()} />);
    expect(summaries(failed.container)).toEqual(['Tauri 监听器注册失败: Error: no event bridge']);
    expect(h.listened).toEqual(['question_import_progress', 'question_import_progress']);
  });

  it('keeps the newest 3000 entries', async () => {
    await load();
    const { container } = render(<Panel {...props()} />);
    fireEvent.change(search(container), { target: { value: 'zzz-none' } });
    await act(async () => {
      for (let i = 0; i < 3004; i++) channel.emitImportDebug('debug', 'system', `cap #${i}#`);
    });
    expect(statsLine(container)).toBe('题目导入调试 | 共 3000');
    const match = (q: string) => {
      fireEvent.change(search(container), { target: { value: q } });
      return count(container);
    };
    expect([match('监听器已注册'), match('#3#'), match('#4#'), match('#3003#')]).toEqual(['(0)', '(0)', '(1)', '(1)']);
  });
});

function hasText(container: HTMLElement, text: string) {
  return container.textContent!.includes(text);
}
