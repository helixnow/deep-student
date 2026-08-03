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
  requiresStructuredMarkdownInsertion,
  remapInsertPos,
  resolveNoteAnchorPos,
  splitMarkdownIntoSegments,
  splitTextIntoBatches,
  unregisterNoteEditor,
  type NoteAnchor,
} from '../drivers/noteDriver';

function acknowledgeSuggestion(event: Event): void {
  const detail = (event as CustomEvent<{
    onLocalDisposition?: (value: { accepted: true }) => void;
  }>).detail;
  detail?.onLocalDisposition?.({ accepted: true });
}

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

describe('splitMarkdownIntoSegments', () => {
  it('空/纯空白返回空数组', () => {
    expect(splitMarkdownIntoSegments('')).toEqual([]);
    expect(splitMarkdownIntoSegments('  \n\n  ')).toEqual([]);
  });

  it('标题、段落、水平线按块切分', () => {
    expect(splitMarkdownIntoSegments('## 标题\n\n第一段\n仍是第一段\n\n---\n\n第二段')).toEqual([
      '## 标题',
      '第一段\n仍是第一段',
      '---',
      '第二段',
    ]);
  });

  it('列表整体原子（含宽松列表空行与缩进续行）', () => {
    expect(splitMarkdownIntoSegments('前言\n\n- a\n- b\n\n- c\n  续行\n\n结尾')).toEqual([
      '前言',
      '- a\n- b\n\n- c\n  续行',
      '结尾',
    ]);
    expect(splitMarkdownIntoSegments('1. one\n2. two\n\n段落')).toEqual([
      '1. one\n2. two',
      '段落',
    ]);
  });

  it('代码围栏与表格保持原子', () => {
    expect(splitMarkdownIntoSegments('```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后文')).toEqual([
      '```ts\nconst a = 1;\n\nconst b = 2;\n```',
      '后文',
    ]);
    expect(splitMarkdownIntoSegments('| a | b |\n|---|---|\n| 1 | 2 |\n\n后文')).toEqual([
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '后文',
    ]);
  });

  it('引用块（含懒续行）与多行公式保持原子', () => {
    expect(splitMarkdownIntoSegments('> 引用第一行\n仍属引用\n\n后文')).toEqual([
      '> 引用第一行\n仍属引用',
      '后文',
    ]);
    expect(splitMarkdownIntoSegments('$$\nE = mc^2\n$$\n\n后文')).toEqual([
      '$$\nE = mc^2\n$$',
      '后文',
    ]);
  });

  it('setext 下划线随段落吸收，不切成水平线', () => {
    expect(splitMarkdownIntoSegments('标题文本\n---\n\n正文')).toEqual([
      '标题文本\n---',
      '正文',
    ]);
  });

  it('片段按 \\n\\n 连接可还原为语义等价文档', () => {
    const source = '## 计划\n\n- 项一\n- 项二\n\n> 提示\n\n收尾段';
    expect(splitMarkdownIntoSegments(source).join('\n\n')).toBe(source);
  });
});

describe('requiresStructuredMarkdownInsertion', () => {
  it('单行纯文本保持打字机路径', () => {
    expect(requiresStructuredMarkdownInsertion('plain text')).toBe(false);
  });

  it('多行、粗体和公式使用 Markdown 解析路径', () => {
    expect(requiresStructuredMarkdownInsertion('line 1\nline 2')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('**bold**')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('$F=ma$')).toBe(true);
  });

  it('单行标题、列表、引用、链接和行内代码也使用 Markdown 解析路径', () => {
    expect(requiresStructuredMarkdownInsertion('# 标题')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('- 列表项')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('1. 有序项')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('> 引用')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('[链接](https://example.com)')).toBe(true);
    expect(requiresStructuredMarkdownInsertion('使用 `code`')).toBe(true);
  });

  it('普通标点和算术星号不误判为 Markdown', () => {
    expect(requiresStructuredMarkdownInsertion('数组下标 [0]')).toBe(false);
    expect(requiresStructuredMarkdownInsertion('2 * 3 = 6')).toBe(false);
    expect(requiresStructuredMarkdownInsertion('价格是 $5')).toBe(false);
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

  it('note_replace 零命中 → error，不伪造 applied', () => {
    const literal = computeDestructiveMarkdown('hello', {
      kind: 'note_replace',
      payload: { search: 'missing', replace: 'new' },
    });
    expect(literal).toEqual({ content: 'hello', error: '未找到要替换的内容' });

    const regex = computeDestructiveMarkdown('hello', {
      kind: 'note_replace',
      payload: { search: 'z+', replace: 'new', isRegex: true },
    });
    expect(regex).toEqual({ content: 'hello', error: '未找到要替换的内容' });
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
    const markdownInsertCalls: Array<{ markdown: string; pos: number }> = [];
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
      windowId: null,
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

  function makeEditorApi(opts?: {
    markdown?: string;
    focused?: boolean;
    saveError?: Error;
    windowedFullMarkdown?: string;
  }) {
    let markdown = opts?.markdown ?? 'base content';
    let fullMarkdown = opts?.windowedFullMarkdown ?? markdown;
    let focused = opts?.focused ?? false;
    let nextSaveError = opts?.saveError;
    const insertCalls: Array<{ text: string; pos: number }> = [];
    const markdownInsertCalls: Array<{ markdown: string; pos: number }> = [];
    const signals: Array<{ type: string; pos?: number }> = [];
    const flushPendingSave = vi.fn(async () => {
      if (nextSaveError) {
        const error = nextSaveError;
        nextSaveError = undefined;
        throw error;
      }
    });

    const api = {
      insertCalls,
      markdownInsertCalls,
      signals,
      flushPendingSave,
      setFocused: (next: boolean) => {
        focused = next;
      },
      failNextSave: (error: Error) => {
        nextSaveError = error;
      },
      getMarkdown: () => markdown,
      setMarkdown: (md: string) => {
        markdown = md;
        if (opts?.windowedFullMarkdown === undefined) fullMarkdown = md;
        return true;
      },
      getFullMarkdown: () => fullMarkdown,
      isDocumentWindowed: () => opts?.windowedFullMarkdown !== undefined && markdown !== fullMarkdown,
      replaceFullMarkdown: opts?.windowedFullMarkdown !== undefined
        ? async (md: string, replaceOpts: { expectedMarkdown: string }) => {
            if (fullMarkdown !== replaceOpts.expectedMarkdown) {
              throw new Error('OCC conflict');
            }
            fullMarkdown = md;
            markdown = md;
            await flushPendingSave();
            return true;
          }
        : undefined,
      getDocEndPos: () => Math.max(2, markdown.length + 2),
      resolveHeadingPos: () => null as number | null,
      agentSignal: (meta: { type: string; pos?: number }) => {
        signals.push(meta);
      },
      agentInsert: (text: string, pos: number) => {
        insertCalls.push({ text, pos });
        markdown += text;
        fullMarkdown = markdown;
        return { from: pos, to: pos + text.length, cursor: pos + text.length };
      },
      agentInsertMarkdown: (source: string, pos: number) => {
        markdownInsertCalls.push({ markdown: source, pos });
        markdown += source;
        fullMarkdown = markdown;
        return { from: pos, to: pos + source.length, cursor: pos + source.length };
      },
      getCrepe: () => null,
      hasFocus: () => focused,
    };
    return api;
  }

  beforeEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
    bindNoteHotPauseHooks(null);
    window.addEventListener('canvas:ai-edit-request', acknowledgeSuggestion);
  });

  afterEach(() => {
    __resetContentDirtyRegistry();
    unregisterNoteEditor(NOTE_ID);
    bindNoteHotPauseHooks(null);
    window.removeEventListener('canvas:ai-edit-request', acknowledgeSuggestion);
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

  it('混合批次先保存已应用内容，再保留 suggestionPending', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_append',
        destructive: false,
        label: '先追加',
        payload: { content: 'plain addition' },
      },
      {
        kind: 'note_replace',
        destructive: true,
        label: '再建议替换',
        payload: { search: 'base', replace: 'new' },
      },
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.mode).toBe('suggestion');
    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.applied).toBe(1);
    expect(receipt.done).toEqual(['先追加', '已提交建议：再建议替换']);
    expect(api.flushPendingSave).toHaveBeenCalledTimes(1);
  });

  it('建议后的步骤不会越过用户确认点执行', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_set',
        destructive: true,
        label: '等待整篇确认',
        payload: { content: 'replacement' },
      },
      {
        kind: 'note_append',
        destructive: false,
        label: '不应提前追加',
        payload: { content: 'later' },
      },
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.mode).toBe('suggestion');
    expect(receipt.suggestionPending).toBe(true);
    expect(receipt.undone).toEqual(['不应提前追加']);
    expect(api.insertCalls).toHaveLength(0);
    expect(api.flushPendingSave).not.toHaveBeenCalled();
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
    expect(api.flushPendingSave).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    const invert = record.mock.calls[0]![1] as () => Promise<void>;
    await invert();
    expect(api.getMarkdown()).toBe('old');
    expect(api.flushPendingSave).toHaveBeenCalledTimes(2);
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
    expect(api.flushPendingSave).toHaveBeenCalledTimes(1);
    expect(api.signals.some((s) => s.type === 'fadeRun')).toBe(true);
  });

  it('多行 Markdown 走块级流式结构化插入，不作为纯文本写入', async () => {
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const markdown = '## 小结\n\n- **要点一**\n- $F=ma$';
    const expectedPos = api.getDocEndPos();

    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_insert',
        destructive: false,
        label: '追加 Markdown',
        anchor: { position: 'end' },
        payload: { content: markdown },
      },
    ]);

    expect(receipt.status).toBe('completed');
    // 顶层块逐段插入：标题一段、列表整体一段（列表原子，保证解析等价）
    expect(api.markdownInsertCalls).toEqual([
      { markdown: '## 小结', pos: expectedPos },
      { markdown: '- **要点一**\n- $F=ma$', pos: expectedPos + '## 小结'.length },
    ]);
    expect(api.insertCalls).toHaveLength(0);
    expect(api.flushPendingSave).toHaveBeenCalledTimes(1);
  });

  it('内容已应用但持久化失败 → partial 且不伪造用户手动编辑', async () => {
    const api = makeEditorApi({ saveError: new Error('disk unavailable') });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_insert',
        destructive: false,
        label: '追加',
        anchor: { position: 'end' },
        payload: { content: 'hello' },
      },
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.applied).toBe(1);
    expect(receipt.done).toEqual(['追加']);
    expect(receipt.undone).toEqual([]);
    expect(receipt.message).toContain('自动保存失败');
    expect(receipt.userPatch).toBeUndefined();
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

  it('ACR 4.0：probe 带 windowId 时严格按窗口取编辑器，不漂移到最近注册实例', () => {
    const cleanApi = makeEditorApi({ focused: false });
    const hotApi = makeEditorApi({ focused: true });
    registerNoteEditor(NOTE_ID, cleanApi as unknown as CrepeEditorApi, 'win-clean');
    // hot 实例最近注册：无 windowId 的 probe 回落它
    registerNoteEditor(NOTE_ID, hotApi as unknown as CrepeEditorApi, 'win-hot');

    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe('hot');
    // 收紧后：windowId 指向 clean 实例时必须探测该实例（此前会漂移到 hot）
    expect(
      noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID, windowId: 'win-clean' }),
    ).toBe('clean');
    expect(
      noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID, windowId: 'win-hot' }),
    ).toBe('hot');
    // 指定窗口没有挂载该资源 → closed（与 apply 的选择器一致）
    expect(
      noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID, windowId: 'win-missing' }),
    ).toBe('closed');

    unregisterNoteEditor(NOTE_ID, cleanApi as unknown as CrepeEditorApi, 'win-clean');
    unregisterNoteEditor(NOTE_ID, hotApi as unknown as CrepeEditorApi, 'win-hot');
  });

  it('ACR 4.0：clean 破坏类直改后调用 agentFlashChange 做变更区域演出', async () => {
    const api = makeEditorApi({ markdown: 'old body' });
    const flashCalls: Array<[string, string]> = [];
    (api as unknown as { agentFlashChange: (p: string, n: string) => boolean }).agentFlashChange =
      (previous: string, next: string) => {
        flashCalls.push([previous, next]);
        return true;
      };
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_set',
        destructive: true,
        label: '整篇设置',
        payload: { content: 'brand new body' },
      },
    ]);

    expect(receipt.status).toBe('completed');
    expect(flashCalls).toEqual([['old body', 'brand new body']]);
  });

  it('ACR 4.0：编辑器未实现 agentFlashChange 时直改路径不受影响', async () => {
    const api = makeEditorApi({ markdown: 'old' });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const receipt = await noteDriver.apply(makeRun(), [
      {
        kind: 'note_set',
        destructive: true,
        label: '整篇设置',
        payload: { content: 'new' },
      },
    ]);
    expect(receipt.status).toBe('completed');
    expect(api.getMarkdown()).toBe('new');
  });

  it('S-SUG-04：失焦后保留 selection 也不是 hot', () => {
    const api = makeEditorApi({ focused: false }) as unknown as CrepeEditorApi & {
      captureSelection: () => { from: number; to: number } | null;
    };
    api.captureSelection = () => ({ from: 3, to: 3 });
    registerNoteEditor(NOTE_ID, api);
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe('clean');
    expect(isNoteEditorHot(api)).toBe(false);
  });

  it('S-SUG-04：编辑器真实聚焦 → probe hot', () => {
    const api = makeEditorApi({ focused: true });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe('hot');
    expect(isNoteEditorHot(api)).toBe(true);
  });

  it('S-SUG-04：hot 追加先 pause，光标离开后续放并插入', async () => {
    const pauseRun = vi.fn();
    const resumeRun = vi.fn();
    bindNoteHotPauseHooks({ pauseRun, resumeRun });

    const api = makeEditorApi({ focused: true });
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
    api.setFocused(false);
    const receipt = await applyPromise;

    expect(resumeRun).toHaveBeenCalled();
    expect(receipt.status).toBe('completed');
    expect(api.insertCalls.length).toBeGreaterThan(0);

    bindNoteHotPauseHooks(null);
  });

  it('窗口化长笔记 append 使用全文末尾，不把可见前缀当全文', async () => {
    const visible = Array.from({ length: 600 }, (_, index) => `line-${index}`).join('\n');
    const hidden = '\nhidden-601\nhidden-602';
    const api = makeEditorApi({ markdown: visible, windowedFullMarkdown: visible + hidden });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);

    const receipt = await noteDriver.apply(makeRun(), [{
      kind: 'note_append',
      destructive: false,
      label: '长笔记追加',
      anchor: { position: 'end' },
      payload: { content: '\ntrue-end' },
    }]);

    expect(receipt.status).toBe('completed');
    expect(api.getFullMarkdown()).toBe(`${visible}${hidden}\ntrue-end`);
    expect(api.getFullMarkdown()).toContain('hidden-602');
  });

  it('用户在 Agent 写入后继续编辑时，inverse 以 OCC 冲突拒绝且不覆盖用户内容', async () => {
    const api = makeEditorApi({ markdown: 'before' });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const record = vi.fn();
    const receipt = await noteDriver.apply(makeRun({ ledger: { record } }), [{
      kind: 'note_set',
      destructive: true,
      label: 'Agent 设置',
      payload: { content: 'agent-after' },
    }]);
    expect(receipt.status).toBe('completed');
    const inverse = record.mock.calls[0]![1] as () => Promise<void>;

    api.setMarkdown('user-after');
    await expect(inverse()).rejects.toThrow(/撤销冲突/);
    expect(api.getMarkdown()).toBe('user-after');
  });

  it('inverse 保存失败后保留幂等状态，重试只保存而不再次修改正文', async () => {
    const api = makeEditorApi({ markdown: 'before' });
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const record = vi.fn();
    await noteDriver.apply(makeRun({ ledger: { record } }), [{
      kind: 'note_set',
      destructive: true,
      label: 'Agent 设置',
      payload: { content: 'agent-after' },
    }]);
    const inverse = record.mock.calls[0]![1] as () => Promise<void>;
    api.failNextSave(new Error('disk unavailable'));

    await expect(inverse()).rejects.toThrow('disk unavailable');
    expect(api.getMarkdown()).toBe('before');
    await expect(inverse()).resolves.toBeUndefined();
    expect(api.getMarkdown()).toBe('before');
  });

  it('按 windowId 精确选择同资源编辑器', async () => {
    const first = makeEditorApi({ markdown: 'first' });
    const second = makeEditorApi({ markdown: 'second' });
    registerNoteEditor(NOTE_ID, first as unknown as CrepeEditorApi, 'win-first');
    registerNoteEditor(NOTE_ID, second as unknown as CrepeEditorApi, 'win-second');

    const receipt = await noteDriver.apply(makeRun({ windowId: 'win-second' }), [{
      kind: 'note_append',
      destructive: false,
      label: '只写第二窗',
      payload: { content: '-changed' },
    }]);

    expect(receipt.status).toBe('completed');
    expect(first.getMarkdown()).toBe('first');
    expect(second.getMarkdown()).toBe('second-changed');
    unregisterNoteEditor(NOTE_ID, first as unknown as CrepeEditorApi, 'win-first');
    unregisterNoteEditor(NOTE_ID, second as unknown as CrepeEditorApi, 'win-second');
  });

  it('旧实例卸载不会注销同窗口后来注册的新 editor API', () => {
    const oldApi = makeEditorApi({ markdown: 'old-instance' });
    const newApi = makeEditorApi({ markdown: 'new-instance' });
    registerNoteEditor(NOTE_ID, oldApi as unknown as CrepeEditorApi, 'win-same');
    registerNoteEditor(NOTE_ID, newApi as unknown as CrepeEditorApi, 'win-same');

    unregisterNoteEditor(NOTE_ID, oldApi as unknown as CrepeEditorApi, 'win-same');
    expect(noteDriver.probe({ typeId: 'note', resourceId: NOTE_ID })).toBe('clean');
    unregisterNoteEditor(NOTE_ID, newApi as unknown as CrepeEditorApi, 'win-same');
  });

  it('已有 diff 拒绝新建议时返回 failed，不伪造 suggestionPending', async () => {
    registerContentDirtyChecker('note', NOTE_ID, () => true);
    const api = makeEditorApi();
    registerNoteEditor(NOTE_ID, api as unknown as CrepeEditorApi);
    const rejectSuggestion = (event: Event) => {
      (event as CustomEvent<{
        onLocalDisposition?: (value: { accepted: false; reason: string }) => void;
      }>).detail.onLocalDisposition?.({
        accepted: false,
        reason: '已有一条笔记编辑建议等待确认',
      });
    };
    window.addEventListener('canvas:ai-edit-request', rejectSuggestion);

    const receipt = await noteDriver.apply(makeRun(), [{
      kind: 'note_set',
      destructive: true,
      label: '第二条建议',
      payload: { content: 'next' },
    }]);
    window.removeEventListener('canvas:ai-edit-request', rejectSuggestion);

    expect(receipt.status).toBe('failed');
    expect(receipt.suggestionPending).toBeFalsy();
    expect(receipt.message).toContain('已有一条');
  });
});
