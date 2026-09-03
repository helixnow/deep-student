/**
 * 只读「打开已有资源」导航 — 用例文本（Wave2-B 第 5 轮口径：未执行 vitest）。
 *
 * 锁定三件事：
 * 1. 组合 id / 反解 / 校验对合（intent ↔ handler 同源派生）；
 * 2. dispatch 只派发既有导航事件（DSTU_OPEN_NOTE / pdf-ref:open），
 *    source='generative-ui'，非法输入零派发；
 * 3. GenUI 只读边界：本模块产出的 handler 全部 low risk、无 undo，
 *    且源码不得出现任何写路径符号（saveAnkiCards / dstu.create / saveNoteContent）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createOpenResourceActionHandlers,
  dispatchOpenNoteNavigation,
  dispatchOpenPdfPageNavigation,
  openNoteActionId,
  openPdfPageActionId,
  parseOpenResourceActionId,
  GENERATIVE_UI_OPEN_NOTE_SOURCE,
  MAX_OPEN_PDF_PAGE_NUMBER,
} from '@/features/generative-ui/handlers/openResourceActionHandlers';
import { buildOpenResourceEntryBlock } from '@/features/generative-ui/utils/buildOpenResourceEntryBlock';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { actionBarPropsSchema, validateBlockProps } from '@/features/generative-ui/schema';
import { clearPendingNotesHeadingTargetsForTests, consumeNotesHeadingTarget } from '@/features/notes/headingTargetBridge';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

describe('open-resource action id 组合 / 反解', () => {
  it('composes and parses note ids round-trip', () => {
    const id = openNoteActionId('note_abc-123');
    expect(id).toBe('open-note:note_abc-123');
    expect(parseOpenResourceActionId(id!)).toEqual({ kind: 'note', noteId: 'note_abc-123' });
  });

  it('composes and parses pdf page ids round-trip', () => {
    const id = openPdfPageActionId('tb_xyz789', 12);
    expect(id).toBe('open-pdf-page:tb_xyz789:12');
    expect(parseOpenResourceActionId(id!)).toEqual({
      kind: 'pdf-page',
      sourceId: 'tb_xyz789',
      pageNumber: 12,
    });
  });

  it('rejects malformed ids at both compose and parse time', () => {
    expect(openNoteActionId('')).toBeNull();
    expect(openNoteActionId('../etc/passwd')).toBeNull();
    expect(openNoteActionId('note with space')).toBeNull();
    expect(openNoteActionId('n'.repeat(64))).toBeNull();
    expect(openPdfPageActionId('tb_x', 0)).toBeNull();
    expect(openPdfPageActionId('tb_x', 1.5)).toBeNull();
    expect(openPdfPageActionId('tb_x', MAX_OPEN_PDF_PAGE_NUMBER + 1)).toBeNull();

    expect(parseOpenResourceActionId('open-note:')).toBeNull();
    expect(parseOpenResourceActionId('open-note:has space')).toBeNull();
    expect(parseOpenResourceActionId('open-pdf-page:tb_x')).toBeNull();
    expect(parseOpenResourceActionId('open-pdf-page:tb_x:0')).toBeNull();
    expect(parseOpenResourceActionId('open-pdf-page:tb_x:007')).toBeNull();
    expect(parseOpenResourceActionId('open-pdf-page::3')).toBeNull();
    expect(parseOpenResourceActionId('start-review')).toBeNull();
  });
});

describe('dispatch 只读导航事件', () => {
  beforeEach(() => {
    clearPendingNotesHeadingTargetsForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches DSTU_OPEN_NOTE with generative-ui source', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    expect(dispatchOpenNoteNavigation({ noteId: 'note_1' })).toBe(true);
    const evt = spy.mock.calls.find(
      (c) => (c[0] as CustomEvent).type === 'DSTU_OPEN_NOTE',
    )?.[0] as CustomEvent;
    expect(evt).toBeDefined();
    expect(evt.detail).toEqual({ noteId: 'note_1', source: GENERATIVE_UI_OPEN_NOTE_SOURCE });
  });

  it('publishes heading target before dispatching when heading is given', () => {
    expect(dispatchOpenNoteNavigation({ noteId: 'note_1', heading: ' 第二章 ' })).toBe(true);
    // pending map 冷启动语义：编辑器挂载后 consume 一次即清
    expect(consumeNotesHeadingTarget('note_1')).toBe('第二章');
    expect(consumeNotesHeadingTarget('note_1')).toBeNull();
  });

  it('dispatches pdf-ref:open on document with the chat citation detail shape', () => {
    const spy = vi.spyOn(document, 'dispatchEvent');
    expect(dispatchOpenPdfPageNavigation({ sourceId: 'tb_x', pageNumber: 3 })).toBe(true);
    const evt = spy.mock.calls.find(
      (c) => (c[0] as CustomEvent).type === 'pdf-ref:open',
    )?.[0] as CustomEvent;
    expect(evt).toBeDefined();
    expect(evt.detail).toEqual({ sourceId: 'tb_x', pageNumber: 3 });
  });

  it('does not dispatch anything for invalid targets', () => {
    const winSpy = vi.spyOn(window, 'dispatchEvent');
    const docSpy = vi.spyOn(document, 'dispatchEvent');
    expect(dispatchOpenNoteNavigation({ noteId: '../x' })).toBe(false);
    expect(dispatchOpenPdfPageNavigation({ sourceId: 'tb_x', pageNumber: -1 })).toBe(false);
    expect(winSpy).not.toHaveBeenCalled();
    expect(docSpy).not.toHaveBeenCalled();
  });
});

describe('handler 工厂与入口块构建对合', () => {
  it('creates low-risk handlers without undo for every valid target', () => {
    const handlers = createOpenResourceActionHandlers({
      notes: [{ noteId: 'note_1', label: '打开笔记' }],
      pdfPages: [{ sourceId: 'tb_x', pageNumber: 3, label: '打开 PDF 第 3 页' }],
    });
    expect(Object.keys(handlers)).toEqual(['open-note:note_1', 'open-pdf-page:tb_x:3']);
    for (const def of Object.values(handlers)) {
      expect(def.riskLevel).toBe('low');
      expect(def.undo).toBeUndefined();
    }
  });

  it('block builder emits schema-valid action-bar aligned with handler ids', () => {
    const block = buildOpenResourceEntryBlock({
      notes: [{ noteId: 'note_1', label: '打开笔记' }],
      pdfPages: [{ sourceId: 'tb_x', pageNumber: 3, label: '打开 PDF 第 3 页' }],
    });
    expect(block).not.toBeNull();
    expect(block!.type).toBe('action-bar');
    const validated = validateBlockProps(actionBarPropsSchema, block!.props);
    expect(validated.ok).toBe(true);

    const handlers = createOpenResourceActionHandlers({
      notes: [{ noteId: 'note_1', label: '打开笔记' }],
      pdfPages: [{ sourceId: 'tb_x', pageNumber: 3, label: '打开 PDF 第 3 页' }],
    });
    const actions = (block!.props as { actions: Array<{ id: string }> }).actions;
    for (const action of actions) {
      expect(handlers).toHaveProperty(action.id);
    }
  });

  it('returns null when every target is invalid', () => {
    expect(
      buildOpenResourceEntryBlock({
        notes: [{ noteId: 'bad id', label: 'x' }, { noteId: 'note_1', label: '  ' }],
      }),
    ).toBeNull();
  });
});

describe('chat bridge 自动注册（与引用同信任面）', () => {
  const intentWith = (actionId: string): GenerativeUIIntent => ({
    version: '1',
    blocks: [
      {
        type: 'action-bar',
        props: { actions: [{ id: actionId, label: 'model label', riskLevel: 'low' }] },
      },
    ],
  });

  it('registers handlers for well-formed open-resource action ids', () => {
    const handlers = resolveGenerativeUIChatActionHandlers({
      intent: intentWith('open-pdf-page:tb_x:3'),
    });
    expect(handlers['open-pdf-page:tb_x:3']).toBeDefined();
    expect(handlers['open-pdf-page:tb_x:3']?.riskLevel).toBe('low');
  });

  it('leaves malformed open-resource ids unregistered (button never renders)', () => {
    const handlers = resolveGenerativeUIChatActionHandlers({
      intent: intentWith('open-pdf-page:tb_x:banana'),
    });
    expect(handlers['open-pdf-page:tb_x:banana']).toBeUndefined();
  });
});

describe('GenUI 只读边界（源码级）', () => {
  it('open-resource modules contain no write-path symbols', () => {
    const root = path.join(process.cwd(), 'src/features/generative-ui');
    for (const rel of [
      'handlers/openResourceActionHandlers.ts',
      'utils/buildOpenResourceEntryBlock.ts',
    ]) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src, rel).not.toMatch(/saveAnkiCards|anki_cards|dstu\.create|saveNoteContent|createNote\(/);
      expect(src, rel).not.toMatch(/invoke\s*\(/);
    }
  });
});
