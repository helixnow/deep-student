import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { hasValidCloze } from './cloze';

export type ReviewEditTemplate = Pick<CustomAnkiTemplate, 'fields' | 'note_type'>;

export interface EditableReviewCard {
  ankiCardId?: string;
  front: string;
  back: string;
  text?: string;
  tags?: string[];
  images?: string[];
  templateId?: string | null;
  extraFields?: Record<string, string>;
  isErrorCard?: boolean;
  errorContent?: string | null;
}

export interface ReviewCardEditValues {
  front: string;
  back: string;
}

export interface AppliedReviewCardEdit extends ReviewCardEditValues {
  text?: string;
  extraFields: Record<string, string>;
}

const FRONT_FIELD_ALIASES = [
  'front',
  'question',
  'word',
  'term',
  'name',
  'quote',
  'prompt',
];

const BACK_FIELD_ALIASES = [
  'back',
  'backdetail',
  'answer',
  'explanation',
  'definition',
  'extra',
  'desc',
  'description',
  'expl',
  'detail',
  'formula',
  'author',
  'source',
];

function normalizeFieldName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function findFieldByAlias(fields: readonly string[], aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const field = fields.find((candidate) => normalizeFieldName(candidate) === alias);
    if (field) return field;
  }
  return undefined;
}

function uniqueFieldNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const normalized = normalizeFieldName(name);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function extraFieldValue(
  extraFields: Record<string, string> | undefined,
  fieldName: string,
): string | undefined {
  if (!extraFields) return undefined;
  const exact = extraFields[fieldName];
  if (typeof exact === 'string' && exact.trim()) return exact;
  const normalized = normalizeFieldName(fieldName);
  const match = Object.entries(extraFields).find(([key, value]) => (
    normalizeFieldName(key) === normalized && typeof value === 'string' && value.trim().length > 0
  ));
  return match?.[1];
}

function definedExtraFieldValue(
  extraFields: Record<string, string> | undefined,
  fieldName: string,
): string | undefined {
  if (!extraFields) return undefined;
  if (typeof extraFields[fieldName] === 'string') return extraFields[fieldName];
  const normalized = normalizeFieldName(fieldName);
  return Object.entries(extraFields).find(([key]) => normalizeFieldName(key) === normalized)?.[1];
}

export function isClozeReviewCard(
  card: EditableReviewCard,
  template?: ReviewEditTemplate | null,
): boolean {
  const noteType = template?.note_type?.trim().toLowerCase();
  if (noteType) return noteType === 'cloze';
  const extraText = extraFieldValue(card.extraFields, 'Text');
  return hasValidCloze(extraText) || hasValidCloze(card.text);
}

function resolvePrimaryFields(
  card: EditableReviewCard,
  template?: ReviewEditTemplate | null,
): { front: string; back: string; cloze: boolean } {
  const templateFields = uniqueFieldNames(template?.fields ?? []);
  const extraFields = uniqueFieldNames(Object.keys(card.extraFields ?? {}));
  // A loaded template is authoritative. Legacy edits may have injected Front/Back into
  // extraFields even when the template actually renders Question/explanation.
  const fields = templateFields.length > 0 ? templateFields : extraFields;
  const cloze = isClozeReviewCard(card, template);
  if (cloze) {
    return {
      front: findFieldByAlias(fields, ['text']) ?? 'Text',
      back: findFieldByAlias(fields, ['extra']) ?? 'Extra',
      cloze: true,
    };
  }

  const front = findFieldByAlias(fields, FRONT_FIELD_ALIASES)
    ?? template?.fields?.[0]
    ?? 'Front';
  const back = findFieldByAlias(fields, BACK_FIELD_ALIASES)
    ?? template?.fields?.find((field) => normalizeFieldName(field) !== normalizeFieldName(front))
    ?? 'Back';
  return { front, back, cloze: false };
}

function assignExtraField(
  extraFields: Record<string, string>,
  fieldName: string,
  value: string,
): void {
  const normalized = normalizeFieldName(fieldName);
  let hasCanonicalKey = false;
  for (const key of Object.keys(extraFields)) {
    if (normalizeFieldName(key) !== normalized) continue;
    extraFields[key] = value;
    if (key === fieldName) hasCanonicalKey = true;
  }
  if (!hasCanonicalKey) extraFields[fieldName] = value;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) ?? '';
}

export function getReviewCardEditValues(
  card: EditableReviewCard,
  template?: ReviewEditTemplate | null,
): ReviewCardEditValues {
  const primary = resolvePrimaryFields(card, template);
  const primaryBackValue = definedExtraFieldValue(card.extraFields, primary.back);
  return {
    front: firstNonBlank(
      extraFieldValue(card.extraFields, primary.front),
      primary.cloze ? card.text : undefined,
      card.front,
    ),
    back: primary.cloze
      ? primaryBackValue ?? ''
      : firstNonBlank(primaryBackValue, card.back),
  };
}

export function applyReviewCardEdit(
  card: EditableReviewCard,
  values: ReviewCardEditValues,
  template?: ReviewEditTemplate | null,
): AppliedReviewCardEdit {
  const primary = resolvePrimaryFields(card, template);
  const extraFields = { ...(card.extraFields ?? {}) };
  assignExtraField(extraFields, primary.front, values.front);
  assignExtraField(extraFields, primary.back, values.back);

  return {
    front: values.front,
    back: values.back,
    ...(primary.cloze ? { text: values.front } : card.text !== undefined ? { text: card.text } : {}),
    extraFields,
  };
}

function setFallbackField(
  extraFields: Record<string, string>,
  fieldName: string,
  value: string | undefined,
): void {
  if (!value) return;
  const normalized = normalizeFieldName(fieldName);
  if (Object.keys(extraFields).some((key) => normalizeFieldName(key) === normalized)) return;
  extraFields[fieldName] = value;
}

export function toRenderableReviewCard(card: EditableReviewCard): AnkiCard {
  const extraFields = { ...(card.extraFields ?? {}) };
  setFallbackField(extraFields, 'Front', card.front);
  setFallbackField(extraFields, 'Back', card.back);
  setFallbackField(extraFields, 'Text', card.text);
  return {
    id: card.ankiCardId,
    front: card.front,
    back: card.back,
    text: card.text,
    tags: [...(card.tags ?? [])],
    images: [...(card.images ?? [])],
    fields: { ...extraFields },
    extra_fields: extraFields,
    template_id: card.templateId ?? null,
    is_error_card: card.isErrorCard ?? false,
    error_content: card.errorContent ?? null,
  };
}
