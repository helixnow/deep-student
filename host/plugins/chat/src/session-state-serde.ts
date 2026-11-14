/**
 * serde shapes of the typed `SessionState` columns (chat_v2/types.rs ChatParams 2651,
 * PanelStates 2802, `features: HashMap<String, bool>`). Rust drops unknown fields on
 * deserialize and `load_session_state` (repo.rs:2759-2773) maps any type error to None.
 */
import type { ChatParams, PanelStates } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { f32ToJsonNumber, ryuFormat } from '../../../platform/util/index.ts';

type FieldKind = 'string' | 'f32' | 'u32' | 'i32' | 'bool' | 'strings';

const CHAT_PARAMS_FIELDS: ReadonlyArray<readonly [keyof ChatParams & string, FieldKind]> = [
  ['modelId', 'string'], ['temperature', 'f32'], ['topP', 'f32'], ['frequencyPenalty', 'f32'],
  ['presencePenalty', 'f32'], ['contextLimit', 'u32'], ['maxTokens', 'u32'], ['enableThinking', 'bool'],
  ['reasoningEffort', 'string'], ['thinkingBudget', 'i32'], ['disableTools', 'bool'],
  ['model2OverrideId', 'string'], ['ragTopK', 'u32'], ['ragLibraryIds', 'strings'],
  ['learnModePrompt', 'string'], ['selectedMcpServers', 'strings'], ['selectedSearchEngines', 'strings'],
  ['graphIds', 'strings'], ['graphTopK', 'u32'], ['modelDisplayName', 'string'],
  ['ragEnableReranking', 'bool'], ['maxToolRecursion', 'u32'], ['multimodalRagEnabled', 'bool'],
  ['multimodalTopK', 'u32'], ['multimodalEnableReranking', 'bool'], ['multimodalLibraryIds', 'strings'],
  ['visionQuality', 'string'],
];

const PANEL_STATES_FIELDS: ReadonlyArray<readonly [keyof PanelStates & string, FieldKind]> = [
  ['rag', 'bool'], ['mcp', 'bool'], ['search', 'bool'], ['learn', 'bool'],
  ['model', 'bool'], ['advanced', 'bool'], ['attachment', 'bool'], ['skill', 'bool'],
];

const INVALID = Symbol('invalid');

function field(kind: FieldKind, value: unknown): unknown {
  switch (kind) {
    case 'string': return typeof value === 'string' ? value : INVALID;
    case 'bool': return typeof value === 'boolean' ? value : INVALID;
    case 'strings':
      return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : INVALID;
    case 'u32':
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff ? value : INVALID;
    case 'i32':
      return Number.isInteger(value) && (value as number) >= -0x8000_0000 && (value as number) <= 0x7fff_ffff ? value : INVALID;
    case 'f32': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID;
      // serde_json serializes a non-finite f32 (an f64 narrowed past f32::MAX) as null.
      return f32ToJsonNumber(value);
    }
  }
}

function project<T>(fields: ReadonlyArray<readonly [string, FieldKind]>, value: unknown): T | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, kind] of fields) {
    const raw = source[name];
    if (raw === undefined || raw === null) continue;
    const parsed = field(kind, raw);
    if (parsed === INVALID) return undefined;
    if (parsed !== null) out[name] = parsed;
  }
  return out as T;
}

function stringifyShape(fields: ReadonlyArray<readonly [string, FieldKind]>, value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [name, kind] of fields) {
    const item = value[name];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(name)}:${kind === 'f32' ? ryuFormat(item as number) : JSON.stringify(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** `serde_json::from_value::<ChatParams>(..).ok()`: unknown keys dropped, any type error → undefined. */
export function serdeChatParams(value: unknown): ChatParams | undefined {
  return project<ChatParams>(CHAT_PARAMS_FIELDS, value);
}

export function serdePanelStates(value: unknown): PanelStates | undefined {
  return project<PanelStates>(PANEL_STATES_FIELDS, value);
}

export function serdeFeatures(value: unknown): Record<string, boolean> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, item]) => typeof item === 'boolean')
    ? Object.fromEntries(entries) as Record<string, boolean> : undefined;
}

/** `serde_json::to_string(&ChatParams)`: struct order, None skipped, f32 spelled like serde (`1.0`). */
export function chatParamsJson(value: ChatParams): string {
  return stringifyShape(CHAT_PARAMS_FIELDS, value as Record<string, unknown>);
}

export function panelStatesJson(value: PanelStates): string {
  return stringifyShape(PANEL_STATES_FIELDS, value as Record<string, unknown>);
}
