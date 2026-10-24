import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSkillSlashCommands } from '../SkillSlashPopover';

vi.mock('../../../skills/registry', () => ({
  skillRegistry: { getAll: () => [] },
  subscribeToSkillRegistry: () => () => {},
}));

describe('manual compact command completion', () => {
  it('completes the built-in command without a skill registry entry', () => {
    const { result } = renderHook(() => useSkillSlashCommands({
      inputValue: '/comp', caretPos: 5, enabled: true,
    }));
    expect(result.current.open).toBe(true);
    expect(result.current.suggestions.map(suggestion => suggestion.id)).toEqual(['compact']);
    expect(result.current.applySelection()).toEqual({ value: '/compact ', caret: 9 });
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
  });

  it.each(['/skill /comp', 'read /comp', '/compact/file.txt'])('does not consume a message or path: %s', (inputValue) => {
    const { result } = renderHook(() => useSkillSlashCommands({ inputValue, caretPos: inputValue.length, enabled: true }));
    expect(result.current.suggestions).toEqual([]);
  });
});
