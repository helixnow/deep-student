/**
 * 模板标识解析（`streaming_anki_service.rs:222-351`）。
 */
import type { AnkiGenerationOptions, TemplateDescription } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { rustTrim } from '../../../platform/util/index.ts';

// ============================================================================
// 模板标识解析（`streaming_anki_service.rs:222-351`）
// ============================================================================

export function normalizeTemplateIdentifier(value: string): string {
  let out = '';
  for (const ch of rustTrim(value).toLowerCase()) {
    const cp = ch.codePointAt(0) ?? 0;
    const asciiAlnum = (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    if (asciiAlnum || (cp >= 0x4e00 && cp <= 0x9fff)) out += ch;
  }
  return out;
}

export function eqIgnoreAsciiCase(left: string, right: string): boolean {
  return left.length === right.length && left.toLowerCase() === right.toLowerCase();
}

export function resolveTemplateIdCandidate(
  rawCandidate: string | null | undefined,
  templateDescriptions: readonly TemplateDescription[] | null | undefined,
  templateIds: readonly string[] | null | undefined,
  templateFieldsById: Readonly<Record<string, string[]>> | null | undefined,
): string | null {
  const candidate = rawCandidate === null || rawCandidate === undefined ? null : rustTrim(rawCandidate);
  if (candidate === null || candidate === '') return null;

  const exactMatches: string[] = [];

  if (templateFieldsById !== null && templateFieldsById !== undefined) {
    if (Object.hasOwn(templateFieldsById, candidate)) return candidate;
    for (const key of Object.keys(templateFieldsById)) {
      if (eqIgnoreAsciiCase(key, candidate)) return key;
    }
  }

  if (templateIds !== null && templateIds !== undefined) {
    if (templateIds.some((id) => id === candidate)) return candidate;
    for (const id of templateIds) {
      if (eqIgnoreAsciiCase(id, candidate)) return id;
    }
  }

  if (templateDescriptions !== null && templateDescriptions !== undefined) {
    for (const t of templateDescriptions) {
      if (t.id === candidate || eqIgnoreAsciiCase(t.id, candidate) || t.name === candidate) {
        exactMatches.push(t.id);
      }
    }
  }

  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) return null;

  const normalizedCandidate = normalizeTemplateIdentifier(candidate);
  if (normalizedCandidate === '') return null;

  const normalizedMatches: string[] = [];
  if (templateFieldsById !== null && templateFieldsById !== undefined) {
    for (const key of Object.keys(templateFieldsById)) {
      if (normalizeTemplateIdentifier(key) === normalizedCandidate) normalizedMatches.push(key);
    }
  }
  if (templateIds !== null && templateIds !== undefined) {
    for (const id of templateIds) {
      if (normalizeTemplateIdentifier(id) === normalizedCandidate && !normalizedMatches.includes(id)) {
        normalizedMatches.push(id);
      }
    }
  }
  if (templateDescriptions !== null && templateDescriptions !== undefined) {
    for (const t of templateDescriptions) {
      if (
        (normalizeTemplateIdentifier(t.id) === normalizedCandidate ||
          normalizeTemplateIdentifier(t.name) === normalizedCandidate) &&
        !normalizedMatches.includes(t.id)
      ) {
        normalizedMatches.push(t.id);
      }
    }
  }

  return normalizedMatches.length === 1 ? normalizedMatches[0]! : null;
}

export function formatTemplateIdentifierHelp(options: AnkiGenerationOptions): string {
  const entries: string[] = [];
  if (options.template_descriptions !== null && options.template_descriptions !== undefined) {
    for (const t of options.template_descriptions) {
      entries.push(`${t.id}(${t.name})`);
      if (entries.length >= 8) break;
    }
  } else if (options.template_ids !== null && options.template_ids !== undefined) {
    for (const id of options.template_ids) {
      entries.push(id);
      if (entries.length >= 8) break;
    }
  } else if (options.template_fields_by_id !== null && options.template_fields_by_id !== undefined) {
    for (const key of Object.keys(options.template_fields_by_id)) {
      entries.push(key);
      if (entries.length >= 8) break;
    }
  }
  return entries.length === 0 ? '可用模板列表为空' : `可用模板(部分): ${entries.join(', ')}`;
}
