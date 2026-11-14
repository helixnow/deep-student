import type { StudySpaceMemoryScope } from './types';

export function sanitizeSpaceMemoryFolderSegment(spaceName: string): string {
  const cleaned = spaceName
    .replace(/[\p{Cc}"\\/]+/gu, ' ')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'DefaultSpace';
}

export function buildStudySpaceMemoryPromptBlock(
  memoryScope: StudySpaceMemoryScope,
  spaceName: string,
): string | null {
  if (memoryScope === 'global_only') return null;
  const sanitized = sanitizeSpaceMemoryFolderSegment(spaceName);
  if (memoryScope === 'space_isolated') {
    return `[Study Space Memory Scope: Isolated | folderPath="Spaces/${sanitized}"] Read and write study memories strictly under folderPath "Spaces/${sanitized}". Do not mix unrelated spaces.`;
  }
  return `[Study Space Memory Scope: Space + Global | preferredFolderPath="Spaces/${sanitized}"] Prefer folderPath "Spaces/${sanitized}" for subject-specific notes while consulting global learner profile preferences.`;
}
