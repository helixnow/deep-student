/** Localize persisted Quick Learning / 快速学习 labels for UI display. */
import i18n from '@/i18n';

export const QUICK_LEARNING_NAME_ALIASES = ['快速学习', 'Quick Learning'] as const;

export function isQuickLearningLabel(name: string | null | undefined): boolean {
  if (!name) return false;
  return (QUICK_LEARNING_NAME_ALIASES as readonly string[]).includes(name.trim());
}

/** Prefer current locale label when the stored name is a known Quick Learning alias. */
export function displayQuickLearningLabel(name: string): string {
  if (!isQuickLearningLabel(name)) return name;
  return i18n.t('quickAssistant:service.group_name', {
    defaultValue: i18n.language?.toLowerCase().startsWith('zh') ? '快速学习' : 'Quick Learning',
  });
}
