/**
 * useTextSelection 回归测试
 *
 * 1. isToolbarInteraction 残留：右键点击工具栏也会武装该标记，若 mouseup
 *    只在左键分支消费它，标记残留会吞掉下一次正常划词的 mouseup，
 *    导致工具栏整次不弹出。
 * 2. 正常路径：左键划词 → 工具栏出现；点击工具栏按钮不触发重评估。
 */

import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useTextSelection } from '../useTextSelection';

// jsdom 未实现 Range.getBoundingClientRect，补一个固定矩形
(Range.prototype as any).getBoundingClientRect = () => ({
  top: 10,
  left: 10,
  width: 100,
  height: 16,
  bottom: 26,
  right: 110,
  x: 10,
  y: 10,
  toJSON: () => ({}),
});

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const sel = useTextSelection(ref);
  return (
    <div ref={ref}>
      <p data-testid="content">some selectable text here</p>
      {sel.isVisible && (
        <div data-selection-toolbar data-testid="toolbar">
          <button type="button">copy</button>
        </div>
      )}
      <span data-testid="state">{sel.isVisible ? 'visible' : 'hidden'}</span>
    </div>
  );
}

/** 在容器文本节点上建立真实选区（jsdom Selection API） */
function selectContentText() {
  const p = screen.getByTestId('content');
  const textNode = p.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 2);
  range.setEnd(textNode, 14);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** mouseup 后 hook 用 rAF 延迟一帧评估选区，等两帧确保跑完 */
async function flushEvaluation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('useTextSelection', () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('左键划词后弹出工具栏', async () => {
    render(<Harness />);
    selectContentText();
    fireEvent.mouseUp(document, { button: 0 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('visible');
  });

  it('右键点击工具栏后，下一次左键划词仍能弹出工具栏（标记不残留）', async () => {
    render(<Harness />);

    // 第一次正常划词 → 工具栏出现
    selectContentText();
    fireEvent.mouseUp(document, { button: 0 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('visible');

    // 右键点击工具栏：mousedown(button 2) 武装标记 + contextmenu 清除工具栏，
    // mouseup(button 2) 不触发评估
    const toolbar = screen.getByTestId('toolbar');
    fireEvent.mouseDown(toolbar, { button: 2 });
    fireEvent.contextMenu(toolbar);
    fireEvent.mouseUp(document, { button: 2 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('hidden');

    // 第二次正常划词：若标记残留，这次 mouseup 会被吞掉，工具栏不出现
    selectContentText();
    fireEvent.mouseUp(document, { button: 0 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('visible');
  });

  it('左键点击工具栏不触发重评估（标记正常消费）', async () => {
    render(<Harness />);
    selectContentText();
    fireEvent.mouseUp(document, { button: 0 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('visible');

    // 左键点工具栏按钮：mousedown 武装标记，mouseup 消费并跳过评估——
    // 选区仍在但不应因这次点击改变可见性语义（保持 visible，由按钮动作自行 clear）
    const toolbar = screen.getByTestId('toolbar');
    fireEvent.mouseDown(toolbar, { button: 0 });
    fireEvent.mouseUp(document, { button: 0 });
    await flushEvaluation();
    expect(screen.getByTestId('state').textContent).toBe('visible');
  });
});
