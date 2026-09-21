import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';
import i18n from '@/i18n';
import { getSetting, saveSetting } from '@/utils/settingsApi';
import { isTauriRuntime } from '@/utils/shared';
import type { NoteTemplate } from './noteTemplates';
import { isLearningPropValue, LEARNING_PROP_KEYS, type LearningField, type NoteLearningProps } from './noteLearningProps';

export const PERSONAL_NOTE_TEMPLATES_KEY = 'notes.personalTemplates.v1';
export const PERSONAL_NOTE_TEMPLATES_CHANGED = 'notes:personal-templates-changed';
export type PersonalNoteTemplate = NoteTemplate & {
  id: `personal:${string}`;
  /** Optional additions to the existing v1 library; older templates remain valid. */
  defaultForCourse?: string;
  learningPreset?: NoteLearningProps;
};

function validatePreset(value: unknown): asserts value is NoteLearningProps {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([field, raw]) => !Object.hasOwn(LEARNING_PROP_KEYS, field) || !isLearningPropValue(field as LearningField, raw))) {
    throw new Error(i18n.t('notes:personalTemplates.errors.invalid_preset'));
  }
}

export function getCourseDefaultTemplate(templates: readonly PersonalNoteTemplate[], course: string): PersonalNoteTemplate | undefined {
  return course.trim() ? templates.find((template) => template.defaultForCourse === course.trim()) : undefined;
}

export async function loadPersonalNoteTemplates(): Promise<PersonalNoteTemplate[]> {
  // getSetting's native error fallback is unsuitable for a read-modify-write library.
  // Use the same settings repository, but let a failed read remain an error.
  const raw = isTauriRuntime
    ? await invoke<string | null>('get_setting', { key: PERSONAL_NOTE_TEMPLATES_KEY })
    : await getSetting(PERSONAL_NOTE_TEMPLATES_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => (
    item && typeof item.id === 'string' && item.id.startsWith('personal:')
    && typeof item.title === 'string' && typeof item.summary === 'string' && typeof item.markdown === 'string'
  ))) throw new Error(i18n.t('notes:personalTemplates.errors.load_failed'));
  for (const template of parsed) {
    if (template.learningPreset !== undefined) validatePreset(template.learningPreset);
    if (template.defaultForCourse !== undefined && !isLearningPropValue('course', template.defaultForCourse)) {
      throw new Error(i18n.t('notes:personalTemplates.errors.invalid_stored_course'));
    }
  }
  return parsed;
}

// Multiple open note panels share the library. Serialize read-modify-write operations.
let pendingWrite: Promise<unknown> = Promise.resolve();
export function savePersonalNoteTemplate(input: {
  id?: `personal:${string}`;
  title: string;
  summary?: string;
  markdown: string;
  /** Empty string clears the assignment; omitted preserves it on updates. */
  defaultForCourse?: string;
  learningPreset?: NoteLearningProps;
}): Promise<PersonalNoteTemplate> {
  const operation = pendingWrite.then(async () => {
    const title = input.title.trim();
    if (!title || !input.markdown.trim()) throw new Error(i18n.t('notes:personalTemplates.errors.required'));
    if (title.length > 120) throw new Error(i18n.t('notes:personalTemplates.errors.title_too_long'));
    if (new TextEncoder().encode(input.markdown).byteLength > 1024 * 1024) throw new Error(i18n.t('notes:personalTemplates.errors.body_too_large'));
    const templates = await loadPersonalNoteTemplates();
    const existing = templates.find((item) => item.id === input.id);
    const defaultForCourse = input.defaultForCourse === undefined ? existing?.defaultForCourse : input.defaultForCourse.trim();
    if (defaultForCourse && !isLearningPropValue('course', defaultForCourse)) throw new Error(i18n.t('notes:personalTemplates.errors.invalid_course'));
    const learningPreset = input.learningPreset ?? existing?.learningPreset;
    if (learningPreset !== undefined) validatePreset(learningPreset);
    const template: PersonalNoteTemplate = {
      ...existing,
      id: input.id ?? `personal:${nanoid()}`,
      title, summary: input.summary?.trim() ?? '', markdown: input.markdown,
    };
    if (defaultForCourse) template.defaultForCourse = defaultForCourse;
    else delete template.defaultForCourse;
    if (learningPreset !== undefined) template.learningPreset = learningPreset;
    // A course has one explicit default. Selecting a new one does not delete the old template.
    if (defaultForCourse) {
      for (const other of templates) {
        if (other.id !== template.id && other.defaultForCourse === defaultForCourse) delete other.defaultForCourse;
      }
    }
    const index = templates.findIndex((item) => item.id === template.id);
    if (index < 0) templates.push(template);
    else templates[index] = template;
    await saveSetting(PERSONAL_NOTE_TEMPLATES_KEY, JSON.stringify(templates));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PERSONAL_NOTE_TEMPLATES_CHANGED));
    return template;
  });
  pendingWrite = operation.catch(() => undefined);
  return operation;
}
