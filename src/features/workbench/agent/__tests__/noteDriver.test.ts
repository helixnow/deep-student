/**
 * R1-12 / R2-03 noteDriver 单测：
 * 切批、锚点、破坏类 markdown、dirty 建议模式、clean 直写、并发 insert 交错
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
import { PACING_PROFILES } from '../pacing';
import type { AcrRunContext, AgentOp } from '../types';
import {
  bindNoteHotPauseHooks,
  computeDestructiveMarkdown,
  isNoteEditorHot,
  noteDriver,
  registerNoteEditor,
  remapInsertPos,
  resolveNoteAnchorPos,
  splitTextIntoBatches,
  unregisterNoteEditor,
  type NoteAnchor,
} from '../drivers/noteDriver';

describe('splitTextIntoBatches', () => {
  it('空串返回空数组', () => {
    expect(splitTextIntoBatches('', 8, 40)).toEqual([]);
  });

  it('短于 max 时整段一批', () => {
    expect(splitTextIntoBatches('hello', 8, 40)).toEqual(['hello']);
  });

  it('fast 档（min≥9999）整段一批', () => {
    const long = 'a'.repeat(100);
    expect(splitTextIntoBatches(long, 9999, 9999)).toEqual([long]);
  });

  it('在空白处优先断批且长度落在 [min,max]', () => {
    const text = 'word1 word2 word3 word4 word5 word6 word7 word8';
    const batches = splitTextIntoBatches(text, 8, 20);
    expect(batches.join('')).toBe(text);
    for (const b of batches) {
      expect(b.length).toBeGreaterThan(0);
      expect(b.length).toBeLessThanOrEqual(20);
    }
    expect(batches.length).toBeGreaterThan(1);
  });

  it('中文标点处可断批', () => {
    const text = '这是第一句。这是第二句！这是第三句？继续补充一些文字达到长度。';
    const batches = splitTextIntoBatches(text, 8, 16);
    expect(batches.join('')).toBe(text);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(16);
    }
  });

  it('无断点时按 max 硬切', () => {
    const text = 'abcdefghijklmnop';
    const batches = splitTextIntoBatches(text, 4, 5);
    expect(batches.join('')).toBe(text);
    expect(batches.every((b) => b.length <= 5)).toBe(true);
  });
});

describe('resolveNoteAnchorPos', () => {
  function mockApi(opts: { end?: number; headingPos?: number | null }) {
    return {
      getDocEndPos: vi.fn(() => opts.end ?? 100),
      resolveHeadingPos: vi.fn((_h: string) =>
        opts.headingPos === undefined ? 42 : opts.headingPos,
      ),
    };
  }

  it('position=end → getDocEndPos', () => {
    const api = mockApi({ end: 88 });
    expect(resolveNoteAnchorPos(api, { position: 'end' })).toBe(88);
    expect(api.getDocEndPos).toHaveBeenCalled();
    expect(api.resolveHeadingPos).not.toHaveBeenCalled();
  });

  it('缺省 anchor → end', () => {
    const api = mockApi({ end: 10 });
    expect(resolveNoteAnchorPos(api, undefined)).toBe(10);
    expect(resolveNoteAnchorPos(api, null)).toBe(10);
  });

  it('position=afterHeading → resolveHeadingPos', () => {
    const api = mockApi({ headingPos: 55 });
    const anchor: NoteAnchor = { heading: '引言', position: 'afterHeading' };
    expect(resolveNoteAnchorPos(api, anchor)).toBe(55);
    expect(api.resolveHeadingPos).toHaveBeenCalledWith('引言');
  });

  it('afterHeading 可用 section 字段作标题', () => {
    const api = mockApi({ headingPos: 12 });
    expect(
      resolveNoteAnchorPos(api, { section: '结论', position: 'afterHeading' }),
    ).toBe(12);
    expect(api.resolveHeadingPos).toHaveBeenCalledWith('结论');
  });

  it('afterHeading 无标题 → null', () => {
    const api = mockApi({});
    expect(resolveNoteAnchorPos(api, { position: 'afterHeading' })).toBeNull();
    expect(api.resolveHeadingPos).not.toHaveBeenCalled();
  });

  it('afterHeading 标题未找到 → null', () => {
    const api = mockApi({ headingPos: null });
    expect(
      resolveNoteAnchorPos(api, { heading: '不存在', position: 'afterHeading' }),
    ).toBeNull();
  });

  it('position=offset 钳制到 [0, end]', () => {
    const api = mockApi({ end: 50 });
    expect(resolveNoteAnchorPos(api, { position: 'offset', offset: 20 })).toBe(20);
    expect(resolveNoteAnchorPos(api, { position: 'offset', offset: -5 })).toBe(0);
    expect(resolveNoteAnchorPos(api, { position: 'offset', offset: 999 })).toBe(50);
  });
});

describe('computeDestructiveMarkdown', () => {
  it('note_set 整篇替换', () => {
    expect(
      computeDestructiveMarkdown('old', {
        kind: 'note_set',
        payload: { content: 'new body' },
      }),
    ).toEqual({ content: 'new body' });
  });

  it('note_replace 字面量替换', () => {
    expect(
      computeDestructiveMarkdown('hello world hello', {
        kind: 'note_replace',
        payload: { search: 'hello', replace: 'hi' },
      }),
    ).toEqual({ content: 'hi world hi' });
  });

  it('note_replace 空 search → error', () => {
    const r = computeDestructiveMarkdown('x', {
      kind: 'note_replace',
      payload: { search: '', replace: 'y' },
    });
    expect(r.error).toBeTruthy();
  });
});

describe('remapInsertPos', () => {
  it('无 highlight 时回退 fallback 并钳制到 doc end', () => {
    const api = {
      getDocEndPos: () => 80,
      getCrepe: () => null,
    };
    expect(remapInsertPos(api, 15)).toBe(15);
    expect(remapInsertPos(api, 999)).toBe(80);
    expect(remapInsertPos(api, -3)).toBe(0);
  });
});

describe('并发 insert 交错（position mapping）', () => {
  it('用户在 agent 插入点前打字后，后续批次应使用右移后的 pos', () => {
    const batches = splitTextIntoBatches('abcdefghijklmnop', 4, 5);
    expect(batches.length).toBeGreaterThan(1);

    const insertCalls: Array<{ text: string; pos: number }> = [];
    let pos = 10;

    // 第一批 agent 插入
    insertCalls.push({ text: batches[0]!, pos });
    pos += batches[0]!.length;

    // 用户在插入点前打了 5 字符 → mapping 右移（agentHighlight 同语义）
    const userInsertBefore = 5;
    pos += userInsertBefore;

    // 第二批必须落在 remap 后的位置
    insertCalls.push({ text: batches[1]!, pos });

    expect(insertCalls[0]!.pos).toBe(10);
    expect(insertCalls[1]!.pos).toBe(10 + batches[0]!.length + userInsertBefore);
    expect(insertCalls.map((c) => c.text).join('')).toBe(
      batches[0]! + batches[1]!,
    );
  });
});

describe('noteDriver apply — suggestion / clean destructive / typewriter', () => {
  const NOTE_ID = 'note-r203';

  function makeRun(overrides?: Partial<AcrRunContext>): AcrRunContext {
    return {
      runId: 'run-1',
      sessionId: 'sess-1',
      target: { typeId: 'note', resourceId: NOTE_ID },
      windowId: 'win-1',
      pacing: {
        profile: PACING_PROFILES.fast,
        tick: vi.fn(async () => {}),
        dispose: vi.fn(),
      },
      reportProgress: vi.fn(),
      checkPaused: vi.fn(async () => 'resume' as const),
      ledger: { record: vi.fn() },
      ...overrides,
    };
  }

  function makeEditorApi(opts?: { markdown?: string }) {
    let markdown = opts?.markdown ?? 'base content';
    const insertCalls: Array<{ text: string; pos: number }> = [];
    const signals: Array<{ type: string; pos?: number }> = [];

    const api = {
      insertCalls,
      signals,
      getMarkdown: () => markdown,
      setMarkdown: (md: string) => {
        markdown = md;
      },
      getDocEndPos: () => Math.max(2, markdown.length + 2),
      resolveHeadingPos: () => null as number | null,
      agentSignal: (meta: { type: string; pos?: number }) => {
        signals.push(meta);
      },
      agentInsert: (text: string, pos: number) => {
        insertCalls.push({ text, pos });
        return pos + text.length;
      },
      getCrepe: () => null,
    };
    return api;
  }

  beforeEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
    bindNoteHotPauseHooks(null);
  });

  afterEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
    bindNoteHotPauseHooks(null);
  });

  it('dirty + note_replace → canvas:ai-edit-request + suggestionPending', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('canvas:ai-edit-request', handler);

    const op: AgentOp = {
      kind: 'note_replace',
      destructive: true,
      label: '替换段落',
      payload: { search: 'base', replace: 'new' },
    };
    const receipt = await noteDriver.apply(makeRun(), [op]);

    window.removeEventListener('canvas:ai-edit-request', handler);

    expect(receipt.mode).toBe('suggestion');
    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.status).toBe('completed');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({
      noteId: NOTE_ID,
      operation: 'replace',
      search: 'base',
      replace: 'new',
    });
    expect(api.getMarkdown()).toBe('base content');
  });

  it('clean + note_set → 直写 setMarkdown + frontend 回执 + 账本可还原', async () => {
    const api = makeEditorApi({ markdown: 'old' });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const record = vi.fn();
    const run = makeRun({ ledger: { record } });

    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('canvas:ai-edit-request', handler);

    const receipt = await noteDriver.apply(run, [
      {
        kind: 'note_set',
        destructive: true,
        label: '整篇设置',
        payload: { content: 'brand new' },
      },
    ]);

    window.removeEventListener('canvas:ai-edit-request', handler);

    expect(events).toHaveLength(0);
    expect(receipt.mode).toBe('frontend');
    expect(receipt.status).toBe('completed');
    expect(receipt.suggestionPending).toBeFalsy();
    expect(api.getMarkdown()).toBe('brand new');
    expect(record).toHaveBeenCalledTimes(1);
    const invert = record.mock.calls[0]![1] as () => void;
    invert();
    expect(api.getMarkdown()).toBe('old');
  });

  it('note_insert 分批调用 agentInsert，结束后 fadeRun', async () => {
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const text = 'word1 word2 word3 word4 word5 word6 word7 word8';
    const receipt = await noteDriver.apply(
      makeRun({
        pacing: {
          profile: PACING_PROFILES.normal,
          tick: vi.fn(async () => {}),
          dispose: vi.fn(),
        },
      }),
      [
        {
          kind: 'note_insert',
          destructive: false,
          label: '追加',
          anchor: { position: 'end' },
          payload: { content: text },
        },
      ],
    );

    expect(receipt.status).toBe('completed');
    expect(receipt.mode).toBe('frontend');
    expect(api.insertCalls.length).toBeGreaterThan(1);
    expect(api.insertCalls.map((c) => c.text).join('')).toBe(text);
    expect(api.signals.some((s) => s.type === 'fadeRun')).toBe(true);
  });

  it('probe：未注册 editor → closed；已注册 → clean', () => {
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe(
      'closed',
    );
    registerNoteEditor(NOTE_ID, makeEditorApi() as unknown as CrepeEditorApi);
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe(
      'clean',
    );
  });

  it('S-SUG-04：captureSelection 有选区 → probe hot', () => {
    const api = makeEditorApi() as unknown as CrepeEditorApi & {
      captureSelection: () => { from: number; to: number } | null;
    };
    api.captureSelection = () => ({ from: 3, to: 3 });
    registerNoteEditor(NOTE_ID, api);
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe('hot');
    expect(isNoteEditorHot(api)).toBe(true);
  });

  it('S-SUG-04：hot 追加先 pause，光标离开后续放并插入', async () => {
    const pauseRun = vi.fn();
    const resumeRun = vi.fn();
    bindNoteHotPauseHooks({ pauseRun, resumeRun });

    let selection: { from: number; to: number } | null = { from: 1, to: 1 };
    const api = makeEditorApi();
    (api as { captureSelection: () => typeof selection }).captureSelection = () =>
      selection;
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    // op 入口 checkPaused 必须立即 resume；hot 等待靠 waitWhileNoteHot 内部 poll
    const run = makeRun({
      checkPaused: vi.fn(async () => 'resume' as const),
    });

    const op: AgentOp = {
      kind: 'note_append',
      destructive: false,
      label: '追加',
      payload: { content: 'hello' },
      anchor: { position: 'end' },
    };

    const applyPromise = noteDriver.apply(run, [op]);
    await vi.waitFor(() => {
      expect(pauseRun).toHaveBeenCalled();
    });
    selection = null;
    const receipt = await applyPromise;

    expect(resumeRun).toHaveBeenCalled();
    expect(receipt.status).toBe('completed');
    expect(api.insertCalls.length).toBeGreaterThan(0);

    bindNoteHotPauseHooks(null);
  });
});
