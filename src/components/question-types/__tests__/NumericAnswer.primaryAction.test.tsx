import React from 'react';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumericAnswer } from '../NumericAnswer';

function renderAnswer(props: Partial<React.ComponentProps<typeof NumericAnswer>> = {}) {
  return render(
    <NumericAnswer
      value="3.14"
      onChange={vi.fn()}
      {...props}
    />,
  );
}

function getInput() {
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('NumericAnswer primary Enter action', () => {
  it('invokes the primary action on a plain Enter', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer({ onPrimaryAction });

    const notCancelled = fireEvent.keyDown(getInput(), { key: 'Enter', cancelable: true });

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
  ] as const)('ignores %s', (_label, init) => {
    const onPrimaryAction = vi.fn();
    renderAnswer({ onPrimaryAction });

    fireEvent.keyDown(getInput(), { key: 'Enter', ...init });

    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('does not act on an Enter that was already handled', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer({ onPrimaryAction });
    const input = getInput();
    const handled = createEvent.keyDown(input, { key: 'Enter', cancelable: true });
    handled.preventDefault();

    fireEvent(input, handled);

    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('does not act after submission', () => {
    const onPrimaryAction = vi.fn();
    renderAnswer({ onPrimaryAction, submitted: true });

    fireEvent.keyDown(getInput(), { key: 'Enter' });

    expect(onPrimaryAction).not.toHaveBeenCalled();
  });
});
