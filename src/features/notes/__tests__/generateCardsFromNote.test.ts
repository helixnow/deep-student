/**
 * 笔记「生成卡片」接线层：正文取全文、牌组名取笔记标题，
 * 制卡本身必须落到共享入口 generateCardsFromText（不另起链路）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe/types';
import { generateCardsFromText } from '@/features/anki/generateCardsFromText';
import { generateCardsFromNote, readNoteMarkdown } from '../generateCardsFromNote';
import { buildMobileEditorCommands } from '../mobileEditorCommands';

vi.mock('@/features/anki/generateCardsFromText', () => ({
  MIN_CONTENT_LENGTH_FOR_CARDS: 10,
  generateCardsFromText: vi.fn(async () => ({ ok: true as const })),
}));

function makeEditor(overrides: Partial<CrepeEditorApi> = {}): CrepeEditorApi {
  return {
    getMarkdown: vi.fn(() => '# 细胞呼吸\n线粒体是有氧呼吸的主要场所。'),
    getCrepe: vi.fn(() => null),
    focus: vi.fn(),
    ...overrides,
  } as unknown as CrepeEditorApi;
}

describe('generateCardsFromNote', () => {
  beforeEach(() => {
    vi.mocked(generateCardsFromText).mockClear();
  });

  it('把笔记正文与标题交给共享制卡入口', async () => {
    const editor = makeEditor();

    await generateCardsFromNote({
      editor,
      noteTitle: '生物 · 第三章',
      translate: (_key, defaultValue) => defaultValue,
    });

    expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(generateCardsFromText).mock.calls[0][0];
    expect(payload.content).toBe('# 细胞呼吸\n线粒体是有氧呼吸的主要场所。');
    expect(payload.deckName).toBe('生物 · 第三章');
    expect(payload.messages.tooShort).toBeTruthy();
    expect(payload.messages.openTaskDashboard).toBeTruthy();
  });

  it('无标题时回退到通用牌组名', async () => {
    await generateCardsFromNote({
      editor: makeEditor(),
      noteTitle: '   ',
      translate: (_key, defaultValue) => defaultValue,
    });

    expect(vi.mocked(generateCardsFromText).mock.calls[0][0].deckName).toBe('笔记制卡');
  });

  it('readNoteMarkdown 优先取完整文档，并对未就绪编辑器返回空串', () => {
    const windowed = makeEditor({
      getMarkdown: vi.fn(() => '可见前缀'),
      getFullMarkdown: vi.fn(() => '可见前缀 + 窗口外正文'),
    });
    expect(readNoteMarkdown(windowed)).toBe('可见前缀 + 窗口外正文');
    expect(readNoteMarkdown(null)).toBe('');
    expect(
      readNoteMarkdown(makeEditor({
        getMarkdown: vi.fn(() => {
          throw new Error('editor destroyed');
        }),
      })),
    ).toBe('');
  });

  it('移动端命令桥的 generateCards 走同一个共享入口', async () => {
    const commands = buildMobileEditorCommands(makeEditor(), {
      enableGenerateCards: true,
      noteTitle: '化学笔记',
    });

    expect(commands.generateCards).toBeTypeOf('function');
    commands.generateCards?.();
    await vi.waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(generateCardsFromText).mock.calls[0][0].deckName).toBe('化学笔记');
  });

  it('宿主未开启 enableGenerateCards 时不注入制卡命令（底栏不渲染按钮）', () => {
    const commands = buildMobileEditorCommands(makeEditor(), { noteTitle: '化学笔记' });
    expect(commands.generateCards).toBeUndefined();
    expect(buildMobileEditorCommands(makeEditor()).generateCards).toBeUndefined();
  });

  it('制卡任务在途时忽略重复点击（触屏双击只发一个任务）', async () => {
    let resolveTask: (value: { ok: true }) => void = () => {};
    vi.mocked(generateCardsFromText).mockImplementationOnce(
      () => new Promise((resolve) => { resolveTask = resolve; }),
    );

    const commands = buildMobileEditorCommands(makeEditor(), { enableGenerateCards: true });
    commands.generateCards?.();
    commands.generateCards?.();

    await vi.waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    });

    resolveTask({ ok: true });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // 任务结束后守卫解除，可以再次制卡
    commands.generateCards?.();
    expect(generateCardsFromText).toHaveBeenCalledTimes(2);
  });

  it('in-flight 守卫按编辑器实例隔离，另一篇笔记不受影响', async () => {
    vi.mocked(generateCardsFromText).mockImplementationOnce(() => new Promise(() => {}));

    const first = buildMobileEditorCommands(makeEditor(), { enableGenerateCards: true });
    const second = buildMobileEditorCommands(makeEditor(), { enableGenerateCards: true });
    first.generateCards?.();
    first.generateCards?.();
    second.generateCards?.();

    await vi.waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(2);
    });
  });

  it('宿主重渲染重建命令对象后守卫仍然生效', async () => {
    vi.mocked(generateCardsFromText).mockImplementationOnce(() => new Promise(() => {}));

    const editor = makeEditor();
    buildMobileEditorCommands(editor, { enableGenerateCards: true }).generateCards?.();
    await vi.waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    });

    buildMobileEditorCommands(editor, { enableGenerateCards: true }).generateCards?.();
    expect(generateCardsFromText).toHaveBeenCalledTimes(1);
  });
});
