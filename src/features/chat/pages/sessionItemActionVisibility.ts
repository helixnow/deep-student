export interface SessionItemActionVisibilityInput {
  isEditing: boolean;
  isHovered: boolean;
  isSelected: boolean;
}

export const shouldShowSessionActionButtons = ({
  isEditing,
  isHovered,
  isSelected,
}: SessionItemActionVisibilityInput): boolean => {
  if (isEditing) return false;
  return isHovered || isSelected;
};
