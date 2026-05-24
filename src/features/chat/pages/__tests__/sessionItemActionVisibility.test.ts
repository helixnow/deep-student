import { describe, expect, it } from 'vitest';
import { shouldShowSessionActionButtons } from '../sessionItemActionVisibility';

describe('shouldShowSessionActionButtons', () => {
  it('hides action buttons while editing', () => {
    expect(shouldShowSessionActionButtons({
      isEditing: true,
      isHovered: true,
      isSelected: true,
    })).toBe(false);
  });

  it('shows action buttons when selected', () => {
    expect(shouldShowSessionActionButtons({
      isEditing: false,
      isHovered: false,
      isSelected: true,
    })).toBe(true);
  });

  it('shows action buttons when hovered', () => {
    expect(shouldShowSessionActionButtons({
      isEditing: false,
      isHovered: true,
      isSelected: false,
    })).toBe(true);
  });

  it('hides action buttons by default', () => {
    expect(shouldShowSessionActionButtons({
      isEditing: false,
      isHovered: false,
      isSelected: false,
    })).toBe(false);
  });
});
