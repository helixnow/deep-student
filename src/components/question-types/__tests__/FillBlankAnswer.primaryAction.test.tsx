import React from 'react';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FillBlankAnswer } from '../FillBlankAnswer';

function renderAnswer(
  count = 2,
  props: Partial<React.ComponentProps<typeof FillBlankAnswer>> = {},
) {
  return render(
    <FillBlankAnswer
      answers={Array.from({ length: count }, (_, index) => `answer-${index + 1}`)}
      onChange={vi.fn()}
      {...props}
    />,
  );
}

function getInputs() {
  return screen.getAllByRole('textbox') as HTMLInputElement[];
}

describe('FillBlankAnswer primary Enter action', () => {
  it('moves focus to the next blank without invoking the primary action', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer(3, { onPrimaryAction });
    const [first, second] = getInputs();

    first.focus();
    const notCancelled = fireEvent.keyDown(first, { key: 'Enter', cancelable: true });

    expect(notCancelled).toBe(false);
    expect(second).toHaveFocus();
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('invokes the primary action once on the last blank and leaves cancellation to the parent', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer(2, { onPrimaryAction });
    const last = getInputs()[1];

    const notCancelled = fireEvent.keyDown(last, { key: 'Enter', cancelable: true });

    expect(notCancelled).toBe(true);
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
    expect(onPrimaryAction.mock.calls[0][0]).toMatchObject({ key: 'Enter' });
  });

  it.each([
    ['IME composition', { isComposing: true }],
    ['WebKit keyCode 229', { keyCode: 229 }],
    ['repeat', { repeat: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Alt', { altKey: true }],
    ['Shift', { shiftKey: true }],
  ] as const)('ignores %s for focus movement and the primary action', (_label, init) => {
    const onPrimaryAction = vi.fn();
    renderAnswer(2, { onPrimaryAction });
    const [first, last] = getInputs();

    first.focus();
    fireEvent.keyDown(first, { key: 'Enter', ...init });
    expect(first).toHaveFocus();
    expect(onPrimaryAction).not.toHaveBeenCalled();

    fireEvent.keyDown(last, { key: 'Enter', ...init });
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('does not act on an Enter that was already handled', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer(2, { onPrimaryAction });
    const [first, last] = getInputs();
    const handledFirst = createEvent.keyDown(first, { key: 'Enter', cancelable: true });
    const handledLast = createEvent.keyDown(last, { key: 'Enter', cancelable: true });
    handledFirst.preventDefault();
    handledLast.preventDefault();

    first.focus();
    fireEvent(first, handledFirst);
    fireEvent(last, handledLast);

    expect(first).toHaveFocus();
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('does not act after submission', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer(2, { onPrimaryAction, submitted: true });
    const [first, last] = getInputs();

    fireEvent.keyDown(first, { key: 'Enter' });
    fireEvent.keyDown(last, { key: 'Enter' });

    expect(onPrimaryAction).not.toHaveBeenCalled();
  });
});
