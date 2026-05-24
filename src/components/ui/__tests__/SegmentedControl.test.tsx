import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SegmentedControl } from '@/components/ui/SegmentedControl';

describe('SegmentedControl', () => {
  it('renders a radiogroup with the selected option exposed as radio state', () => {
    render(
      <SegmentedControl
        ariaLabel="选择主题模式"
        value="light"
        onValueChange={vi.fn()}
        options={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '系统默认' },
        ]}
      />
    );

    const group = screen.getByRole('radiogroup', { name: '选择主题模式' });
    const selectedOption = screen.getByRole('radio', { name: '浅色' });
    const unselectedOption = screen.getByRole('radio', { name: '深色' });

    expect(group.className).toContain('study-shell-segmented');
    expect(selectedOption).toHaveAttribute('aria-checked', 'true');
    expect(selectedOption).toHaveAttribute('tabindex', '0');
    expect(unselectedOption).toHaveAttribute('aria-checked', 'false');
    expect(unselectedOption).toHaveAttribute('tabindex', '-1');
  });

  it('moves selection with arrow keys following radio group interaction patterns', async () => {
    const user = userEvent.setup();
    const handleValueChange = vi.fn();

    render(
      <SegmentedControl
        ariaLabel="选择主题模式"
        value="light"
        onValueChange={handleValueChange}
        options={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '系统默认' },
        ]}
      />
    );

    const selectedOption = screen.getByRole('radio', { name: '浅色' });
    selectedOption.focus();

    await user.keyboard('{ArrowRight}');
    await user.keyboard('{End}');

    expect(handleValueChange).toHaveBeenNthCalledWith(1, 'dark');
    expect(handleValueChange).toHaveBeenNthCalledWith(2, 'system');
  });

  it('keeps the radiogroup reachable even when every option is disabled', () => {
    render(
      <SegmentedControl
        ariaLabel="全部禁用"
        value="a"
        onValueChange={vi.fn()}
        options={[
          { value: 'a', label: 'A', disabled: true },
          { value: 'b', label: 'B', disabled: true },
        ]}
      />
    );

    const [firstRadio, secondRadio] = screen.getAllByRole('radio');
    expect(firstRadio).toHaveAttribute('tabindex', '0');
    expect(firstRadio).toHaveAttribute('aria-disabled', 'true');
    expect(firstRadio).toBeDisabled();
    expect(secondRadio).toHaveAttribute('tabindex', '-1');
    expect(secondRadio).toHaveAttribute('aria-disabled', 'true');
  });

  it('tolerates a value that does not match any option by focusing the first enabled radio', () => {
    render(
      <SegmentedControl
        ariaLabel="无匹配"
        value={'missing' as 'a' | 'b'}
        onValueChange={vi.fn()}
        options={[
          { value: 'a' as const, label: 'A' },
          { value: 'b' as const, label: 'B' },
        ]}
      />
    );

    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
  });
});
