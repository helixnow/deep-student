// Rust: chatanki_executor.rs:404–465, 573–634, 685–727 chatanki_run/start argument parsing.
import type { ChatAnkiTemplateMode } from './template-selection.ts';
import { isJsonNumberAtom } from '../../../kernel/serde.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeBool, serdeOption, serdeString, serdeUnitEnum, serdeVec,
  type SerdeStructField,
} from './serde-struct.ts';

export interface ChatAnkiRunArgs {
  goal: string;
  content: string | null;
  route: string | null;
  resourceId: string | null;
  resourceIds: string[];
  templateId: string | null;
  templateIds: string[] | null;
  templateMode: ChatAnkiTemplateMode;
  deckName: string | null;
  noteType: string | null;
  maxCards: number | null;
  extraRequirements: string | null;
  outputProtocol: string | null;
  visualHint: string | null;
  contentFormat: 'auto' | 'glossary' | 'prose';
  enableQaPass: boolean | null;
  enableCriticPass: boolean | null;
  enableFsrsFeedback: boolean | null;
  maxImages: number | null;
  enablePreferenceMemory: boolean | null;
  debug: boolean | null;
}

const I32_MIN = -(2 ** 31);
const I32_MAX = 2 ** 31 - 1;
const U32_MAX = 2 ** 32 - 1;

/** serde_json `Number::as_i64` / `as_u64` under arbitrary_precision: the literal must parse as that integer type. */
function numberAsInteger(value: unknown, unsigned: boolean): number | null {
  if (isJsonNumberAtom(value)) {
    const text = value.rawJSON;
    if (!(unsigned ? /^(?:0|[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)$/).test(text)) return null;
    const exact = BigInt(text);
    if (exact < (unsigned ? 0n : -(2n ** 63n)) || exact > (unsigned ? 2n ** 64n - 1n : 2n ** 63n - 1n)) return null;
    return Number(exact);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (unsigned && (value < 0 || Object.is(value, -0))) return null;
  return value === 0 ? 0 : value;
}

/** `deserialize_optional_i32_flexible` (:404–433): number or numeric string; blank string = None. */
function flexibleI32(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || isJsonNumberAtom(value)) {
    const integer = numberAsInteger(value, false);
    if (integer === null) throw new Error('maxCards must be an integer');
    if (integer < I32_MIN || integer > I32_MAX) throw new Error('maxCards out of i32 range');
    return integer;
  }
  if (typeof value === 'string') {
    const trimmed = rustTrim(value);
    if (trimmed.length === 0) return null;
    const parsed = /^[+-]?[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < I32_MIN || parsed > I32_MAX) {
      throw new Error('maxCards string must be a valid integer');
    }
    return parsed === 0 ? 0 : parsed;
  }
  throw new Error('maxCards must be integer or numeric string');
}

/** `deserialize_optional_u32_flexible` (:437–466), used by `maxImages`. */
function flexibleU32(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || isJsonNumberAtom(value)) {
    const integer = numberAsInteger(value, true);
    if (integer === null) throw new Error('maxImages must be a non-negative integer');
    if (integer > U32_MAX) throw new Error('maxImages out of u32 range');
    return integer;
  }
  if (typeof value === 'string') {
    const trimmed = rustTrim(value);
    if (trimmed.length === 0) return null;
    const parsed = /^\+?[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed > U32_MAX) {
      throw new Error('maxImages string must be a valid integer');
    }
    return parsed;
  }
  throw new Error('maxImages must be integer or numeric string');
}

const optString = serdeOption(serdeString);
const optBool = serdeOption(serdeBool);
const optStrings = serdeOption(serdeVec(serdeString));
const templateMode = serdeUnitEnum(['single', 'multiple', 'all'] as const);
const contentFormat = serdeUnitEnum(['auto', 'glossary', 'prose'] as const);

/**
 * Shared tail of both structs. `rename_all = "camelCase"` makes the wire name camelCase; only the
 * fields with a snake_case `alias` accept the snake spelling (deckName/noteType/templateId/… do not).
 */
const TUNING_FIELDS = {
  maxCards: { name: 'maxCards', default: true, read: flexibleI32 },
  extraRequirements: { name: 'extraRequirements', aliases: ['extra_requirements'], option: true, read: optString },
  outputProtocol: { name: 'outputProtocol', aliases: ['output_protocol'], option: true, read: optString },
  visualHint: { name: 'visualHint', aliases: ['visual_hint'], option: true, read: optString },
  contentFormat: { name: 'contentFormat', aliases: ['content_format'], default: true, read: contentFormat },
  enableQaPass: { name: 'enableQaPass', aliases: ['enable_qa_pass'], option: true, read: optBool },
  enableCriticPass: { name: 'enableCriticPass', aliases: ['enable_critic_pass'], option: true, read: optBool },
  enableFsrsFeedback: { name: 'enableFsrsFeedback', aliases: ['enable_fsrs_feedback'], option: true, read: optBool },
  maxImages: { name: 'maxImages', aliases: ['max_images'], default: true, read: flexibleU32 },
  enablePreferenceMemory: {
    name: 'enablePreferenceMemory', aliases: ['enable_preference_memory'], option: true, read: optBool,
  },
  debug: { name: 'debug', option: true, read: optBool },
} satisfies Record<string, SerdeStructField>;

/** `ChatAnkiRunArgs` field order (:573–634). */
const RUN_FIELDS: readonly SerdeStructField[] = [
  { name: 'goal', read: serdeString },
  { name: 'content', option: true, read: optString },
  { name: 'route', option: true, read: optString },
  { name: 'resourceId', option: true, read: optString },
  { name: 'resourceIds', option: true, read: optStrings },
  { name: 'templateId', option: true, read: optString },
  { name: 'templateIds', option: true, read: optStrings },
  { name: 'templateMode', read: templateMode },
  { name: 'deckName', option: true, read: optString },
  { name: 'noteType', option: true, read: optString },
  TUNING_FIELDS.maxCards, TUNING_FIELDS.extraRequirements, TUNING_FIELDS.outputProtocol,
  TUNING_FIELDS.visualHint, TUNING_FIELDS.contentFormat, TUNING_FIELDS.enableQaPass,
  TUNING_FIELDS.enableCriticPass, TUNING_FIELDS.enableFsrsFeedback, TUNING_FIELDS.maxImages,
  TUNING_FIELDS.enablePreferenceMemory, TUNING_FIELDS.debug,
];

/** `ChatAnkiStartArgs` field order (:685–727): no route/resource/visualHint/maxImages fields. */
const START_FIELDS: readonly SerdeStructField[] = [
  { name: 'goal', read: serdeString },
  { name: 'content', read: serdeString },
  { name: 'templateId', option: true, read: optString },
  { name: 'templateIds', option: true, read: optStrings },
  { name: 'templateMode', read: templateMode },
  { name: 'deckName', option: true, read: optString },
  { name: 'noteType', option: true, read: optString },
  TUNING_FIELDS.maxCards, TUNING_FIELDS.extraRequirements, TUNING_FIELDS.outputProtocol,
  TUNING_FIELDS.contentFormat, TUNING_FIELDS.enableQaPass, TUNING_FIELDS.enableCriticPass,
  TUNING_FIELDS.enableFsrsFeedback, TUNING_FIELDS.enablePreferenceMemory, TUNING_FIELDS.debug,
];

function fieldValues(raw: unknown, struct: string, fields: readonly SerdeStructField[]): Map<string, unknown> {
  const values = deserializeSerdeStruct(raw, struct, fields, false);
  return new Map(fields.map((field, index) => [field.name, values[index]]));
}

function orNull<T>(value: unknown): T | null {
  return value === undefined ? null : value as T | null;
}

function runArgsFrom(values: Map<string, unknown>): ChatAnkiRunArgs {
  return {
    goal: values.get('goal') as string,
    content: orNull(values.get('content')),
    route: orNull(values.get('route')),
    resourceId: orNull(values.get('resourceId')),
    resourceIds: orNull<string[]>(values.get('resourceIds')) ?? [],
    templateId: orNull(values.get('templateId')),
    templateIds: orNull(values.get('templateIds')),
    templateMode: values.get('templateMode') as ChatAnkiTemplateMode,
    deckName: orNull(values.get('deckName')),
    noteType: orNull(values.get('noteType')),
    maxCards: orNull(values.get('maxCards')),
    extraRequirements: orNull(values.get('extraRequirements')),
    outputProtocol: orNull(values.get('outputProtocol')),
    visualHint: orNull(values.get('visualHint')),
    contentFormat: (values.get('contentFormat') as ChatAnkiRunArgs['contentFormat'] | undefined) ?? 'auto',
    enableQaPass: orNull(values.get('enableQaPass')),
    enableCriticPass: orNull(values.get('enableCriticPass')),
    enableFsrsFeedback: orNull(values.get('enableFsrsFeedback')),
    maxImages: orNull(values.get('maxImages')),
    enablePreferenceMemory: orNull(values.get('enablePreferenceMemory')),
    debug: orNull(values.get('debug')),
  };
}

/** `serde_json::from_value::<ChatAnkiRunArgs>`: unknown keys ignored, input-order visit, struct-order missing fields. */
export function parseChatAnkiRunArgs(raw: unknown): ChatAnkiRunArgs {
  return runArgsFrom(fieldValues(raw, 'ChatAnkiRunArgs', RUN_FIELDS));
}

/** `serde_json::from_value::<ChatAnkiStartArgs>`: run-only keys (route, resourceIds, visualHint, maxImages) are unknown and ignored. */
export function parseChatAnkiStartArgs(raw: unknown): ChatAnkiRunArgs {
  return runArgsFrom(fieldValues(raw, 'ChatAnkiStartArgs', START_FIELDS));
}
