/**
 * ACR R2-10 — content onActivation：exam focusQuestion / textbook page / 可行动回执
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrollToHeading = vi.fn();

vi.mock('../../../agent/drivers/noteDriver', () => ({
  getNoteEditor: (id: string) =>
    id === 'note_1' ? { scrollToHeading } : undefined,
}));

vi.mock('../../../agent/drivers/qbankDriver', () => ({
  QBANK_FOCUS_EVENT: 'qbank:focus-question',
}));

import { CONTENT_APP_DEFINITIONS, handleNoteActivation } from '../register';

function def(typeId: string) {
  const d = CONTENT_APP_DEFINITIONS.find((x) => x.typeId === typeId);
  if (!d?.onActivation) throw new Error(`missing ${typeId}`);
  return d.onActivation;
}

describe('content onActivation R2-10', () => {
  beforeEach(() => {
    scrollToHeading.mockClear();
  });

  it('note scrollToHeading 调用编辑器', () => {
    const result = handleNoteActivation({
      windowId: 'w1',
      instanceKey: 'note_1',
      action: 'scrollToHeading',
      payload: { heading: '引言', level: 2 },
    });
    expect(result).toEqual({ handled: true });
    expect(scrollToHeading).toHaveBeenCalledWith('引言', 2);
  });

  it('exam focusQuestion 派发 qbank:focus-question', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    const result = def('exam')({
      windowId: 'w1',
      instanceKey: 'exam_1',
      action: 'focusQuestion',
      payload: { questionId: 'Q2' },
    });
    expect(result).toEqual({ handled: true });
    expect(spy).toHaveBeenCalled();
    const ev = spy.mock.calls.find(
      (c) => (c[0] as CustomEvent).type === 'qbank:focus-question',
    )?.[0] as CustomEvent;
    expect(ev.detail).toEqual({ questionId: 'Q2' });
    spy.mockRestore();
  });

  it('exam 缺 questionId → handled:false 可行动 hint', () => {
    const result = def('exam')({
      windowId: 'w1',
      instanceKey: 'exam_1',
      action: 'focusQuestion',
      payload: {},
    });
    expect(result).toMatchObject({
      handled: false,
      code: 'INVALID_ARGS',
    });
  });

  it('textbook scrollToHeading + page → pdf-ref:focus', () => {
    const spy = vi.spyOn(document, 'dispatchEvent');
    const result = def('textbook')({
      windowId: 'w1',
      instanceKey: 'tb_1',
      action: 'scrollToHeading',
      payload: { page: 3 },
    });
    expect(result).toEqual({ handled: true });
    const ev = spy.mock.calls.find(
      (c) => (c[0] as CustomEvent).type === 'pdf-ref:focus',
    )?.[0] as CustomEvent;
    expect(ev.detail.pageNumber).toBe(3);
    expect(ev.detail.sourceId).toBe('tb_1');
    spy.mockRestore();
  });

  it('translation 纯标题 → handled:false 不假装成功', () => {
    const result = def('translation')({
      windowId: 'w1',
      instanceKey: 'tr_1',
      action: 'scrollToHeading',
      payload: { heading: '第一章' },
    });
    expect(result).toMatchObject({
      handled: false,
      code: 'UNSUPPORTED_ACTION',
    });
  });
});
