import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineEditText } from '../InlineEditText';

describe('resource title IME', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not confirm/cancel the title from a candidate key (%j)', (composition) => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(<InlineEditText value="Original" isEditing onConfirm={confirm} onCancel={cancel} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '中文标题' } });
    for (const key of ['Enter', 'Escape']) expect(fireEvent.keyDown(input, { key, ...composition })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(confirm).toHaveBeenCalledExactlyOnceWith('中文标题');
  });
});
