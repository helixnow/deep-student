import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TagInput from './TagInput';

function Harness({ initial = [] as string[], onChange }: { initial?: string[]; onChange?: (next: string[]) => void }) {
  const [tags, setTags] = useState(initial);
  return (
    <TagInput
      value={tags}
      onChange={(next) => {
        onChange?.(next);
        setTags(next);
      }}
      placeholder="tags"
    />
  );
}

describe('TagInput comma commit', () => {
  it('commits on a comma that arrives through the value (Android soft keyboard)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('tags') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '物理，' } });
    expect(onChange).toHaveBeenLastCalledWith(['物理']);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'math,chem' } });
    expect(onChange).toHaveBeenLastCalledWith(['物理', 'math']);
    expect(input.value).toBe('chem');
  });

  it('commits once for a hardware-keyboard comma keydown', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('tags') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'bio' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(['bio']);
    expect(input.value).toBe('');
  });

  it('ignores the Enter that confirms an IME composition', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('tags') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'wuli' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onChange).toHaveBeenLastCalledWith(['wuli']);
  });
});
