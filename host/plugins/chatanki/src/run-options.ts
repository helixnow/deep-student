// Rust: chatanki_executor.rs run/start normalizers — :537–571 (outputProtocol, maxCards clamp),
// :7264–7282 (document name), :10917–10953 (glossary paragraphs), :11189–11207 (preference hint),
// :10741–10868 + :13785–13815 (template selection).
import type {
  ChatAnkiPreferenceStore, ChatAnkiSettingsStore, CustomAnkiTemplate, ToolExecutionContext,
} from '../api.ts';
import { errorText } from './execution.ts';
import { isGlossaryEntryStart } from './generation-options.ts';
import { parsePreferenceStore, CHATANKI_PREFERENCE_MEMORY_SETTING_KEY } from './preference-memory.ts';
import { publishedAppError } from './result.ts';
import {
  BUILTIN_FALLBACK_TEMPLATE_IDS, collectRequestedTemplateIds, goalPrefersChoiceTemplate,
  type ChatAnkiTemplateMode, type TemplateSelection,
} from './template-selection.ts';
import { rustDebugString } from '../../../kernel/serde.ts';
import { charCount, rustTrim, takeChars } from '../../../platform/util/text.ts';

/** `normalize_output_protocol_arg` (:537–547): legal values pass through, auto/blank is None, anything else fails. */
export function normalizeOutputProtocolArg(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = rustTrim(raw).toLowerCase();
  if (normalized === '' || normalized === 'auto') return null;
  if (normalized === 'delimiter' || normalized === 'json_object' || normalized === 'json_schema') return normalized;
  throw new Error(`invalid outputProtocol '${normalized}': expected auto | delimiter | json_object | json_schema`);
}

export const MAX_CARDS_HARD_LIMIT = 100;

/** `clamp_max_cards_arg` (:554–571): over the hard limit clamps to 100 with a structured warning. */
export function clampMaxCardsArg(requested: number | null): [number | null, Record<string, unknown> | null] {
  if (requested === null || requested <= MAX_CARDS_HARD_LIMIT) return [requested, null];
  return [MAX_CARDS_HARD_LIMIT, {
    code: 'max_cards_clamped',
    messageKey: 'blocks.ankiCards.warnings.maxCardsClamped',
    messageParams: { requested, applied: MAX_CARDS_HARD_LIMIT },
    requested,
    applied: MAX_CARDS_HARD_LIMIT,
    message: `maxCards ${requested} exceeds the per-run hard limit; clamped to ${MAX_CARDS_HARD_LIMIT}. `
      + 'Split into multiple runs for more cards.',
  }];
}

/** `derive_document_name` (:7264–7282): an explicit non-default deck name beats the goal. */
export function deriveDocumentName(deckName: string | null, goal: string): string {
  const deck = deckName === null ? null : rustTrim(deckName);
  if (deck !== null && deck.length > 0 && deck.replace(/[A-Z]/g, (c) => c.toLowerCase()) !== 'default') return deck;
  const name = rustTrim(goal);
  if (name.length === 0) return 'chatanki';
  return charCount(name) > 80 ? `${takeChars(name, 77)}...` : name;
}

/** `str::lines`: split on `\n`, drop one trailing `\r` per line, no final empty line. */
function rustLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return lines;
}

/** `normalize_glossary_paragraphs` (:10917–10953): one paragraph per glossary entry, joined by blank lines. */
export function normalizeGlossaryParagraphs(text: string): string {
  const paragraphs: string[] = [];
  let current = '';
  const flush = (): void => {
    if (rustTrim(current).length > 0) paragraphs.push(rustTrim(current));
    current = '';
  };
  for (const raw of rustLines(text)) {
    const line = rustTrim(raw);
    if (line.length === 0) { flush(); continue; }
    if (isGlossaryEntryStart(line)) { flush(); current = line; continue; }
    current = current.length === 0 ? line : `${current}\n${line}`;
  }
  flush();
  return paragraphs.join('\n\n');
}

export const PREFERENCE_PROMPT_TOKEN_BUDGET = 120;

/** L16 `retrieve_preference_prompt`, published by `anki` as `retrievePreferencePrompt`. */
export type ChatAnkiPreferencePrompt = (
  store: ChatAnkiPreferenceStore, goal: string, templateNames: readonly string[], maxTokens: number,
) => string;

/**
 * `build_preference_hint` (:11189–11207) with the caller's reads (:8167–8178): settings read failure,
 * a missing or unparseable store, or an empty retrieval all mean "no hint".
 */
export function buildPreferenceHint(
  settings: ChatAnkiSettingsStore | null, retrieve: ChatAnkiPreferencePrompt | null,
  goal: string, templateNames: readonly string[],
): string | null {
  if (settings === null || retrieve === null) return null;
  let json: string | null;
  try { json = settings.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY); }
  catch { return null; }
  if (json === null) return null;
  let store: ChatAnkiPreferenceStore;
  try { store = parsePreferenceStore(json); }
  catch { return null; }
  const hint = retrieve(store, goal, templateNames, PREFERENCE_PROMPT_TOKEN_BUDGET);
  return rustTrim(hint).length === 0 ? null : hint;
}

/** `infer_template_id_from_goal` (:13785–13815): highest-scoring active choice template (≥4 choice fields). */
export function inferTemplateIdFromGoal(goal: string, templates: readonly CustomAnkiTemplate[]): string | null {
  if (!goalPrefersChoiceTemplate(goal)) return null;
  const choiceFields = ['question', 'optiona', 'optionb', 'optionc', 'optiond'];
  let best: [CustomAnkiTemplate, number] | null = null;
  for (const template of templates.filter((candidate) => candidate.is_active)) {
    const fieldSet = new Set(template.fields.map((field) => rustTrim(field).toLowerCase()));
    const score = choiceFields.filter((field) => fieldSet.has(field)).length;
    if (score >= 4 && (best === null || score > best[1])) best = [template, score];
  }
  return best === null ? null : best[0].id;
}

/** Template reads `resolve_template_selection` needs, from `main_db.or(anki_db)` or the L16 facade + settings. */
export interface ChatAnkiTemplateSource {
  getById(id: string): CustomAnkiTemplate | null;
  listAll(): CustomAnkiTemplate[];
  /** `Database::get_default_template` (`settings.default_template_id`). */
  defaultTemplateId(): string | null;
}

const DEFAULT_TEMPLATE_SETTING_KEY = 'default_template_id';

function storeErrorText(error: unknown): string {
  return publishedAppError(error)?.message ?? errorText(error);
}

function wrapped<T>(read: () => T): () => T {
  return () => {
    try { return read(); }
    catch (caught) { throw new Error(storeErrorText(caught)); }
  };
}

export function chatAnkiTemplateSource(ctx: ToolExecutionContext): ChatAnkiTemplateSource | null {
  const db = ctx.mainDb ?? ctx.ankiDb ?? null;
  if (db !== null) {
    const settings = db.getSetting !== undefined ? db : ctx.settings ?? null;
    return {
      getById: (id) => db.getCustomTemplateById(id),
      listAll: () => db.getAllCustomTemplates(),
      defaultTemplateId: () => settings?.getSetting?.(DEFAULT_TEMPLATE_SETTING_KEY) ?? null,
    };
  }
  const templates = ctx.templates ?? null;
  if (templates === null) return null;
  const settings = ctx.settings ?? null;
  return {
    getById: (id) => wrapped(() => templates.get(id))(),
    listAll: () => wrapped(() => templates.list())(),
    defaultTemplateId: () => (settings === null ? null : settings.getSetting(DEFAULT_TEMPLATE_SETTING_KEY)),
  };
}

/** `resolve_template_selection` (:10741–10868); errors are the tool failure text. */
export function resolveTemplateSelection(
  source: ChatAnkiTemplateSource | null, goal: string, mode: ChatAnkiTemplateMode,
  templateId: string | null, templateIds: readonly string[] | null,
  info: (message: string) => void = () => undefined,
): TemplateSelection {
  if (source === null) throw new Error('Anki database not available');
  const exists = (id: string): boolean => {
    try { return source.getById(id) !== null; }
    catch (caught) { throw new Error(`加载模板失败: ${errorText(caught)}`); }
  };
  if (mode === 'single') {
    const explicit = templateId === null ? '' : rustTrim(templateId);
    let tid: string;
    let fromDefault = false;
    if (explicit.length > 0) {
      tid = explicit;
    } else {
      let stored: string | null;
      try { stored = source.defaultTemplateId(); }
      catch (caught) { throw new Error(`读取默认模板设置失败: ${errorText(caught)}`); }
      const defaultTid = stored === null || rustTrim(stored).length === 0 ? null : rustTrim(stored);
      if (defaultTid !== null && exists(defaultTid)) {
        tid = defaultTid;
        fromDefault = true;
      } else {
        const fallback = BUILTIN_FALLBACK_TEMPLATE_IDS.find((id) => {
          try { return exists(id); }
          catch { return false; }
        });
        if (fallback === undefined) {
          throw new Error('templateMode=single 时必须提供 templateId（指定单个模板），或先在设置中配置默认模板');
        }
        info(`[ChatAnkiToolExecutor] no usable default template (${defaultTid === null ? 'None' : `Some(${rustDebugString(defaultTid)})`}); falling back to built-in ${fallback}`);
        tid = fallback;
        fromDefault = true;
      }
    }
    if (!exists(tid)) throw new Error(`指定模板不存在: ${tid}`);
    if (fromDefault) info(`[ChatAnkiToolExecutor] templateMode=single without templateId; using user default template ${tid}`);
    return { templateId: tid, templateIds: null };
  }
  if (mode === 'multiple') {
    const ids = collectRequestedTemplateIds(templateId, templateIds);
    if (ids.length === 0) throw new Error('templateMode=multiple 时必须提供非空 templateIds（或 templateId）');
    for (const id of ids) {
      if (!exists(id)) throw new Error(`指定模板不存在: ${id}`);
    }
    return { templateId: null, templateIds: ids };
  }
  let templates: CustomAnkiTemplate[];
  try { templates = source.listAll(); }
  catch (caught) { throw new Error(`加载模板列表失败: ${errorText(caught)}`); }
  const active = templates.filter((template) => template.is_active);
  if (active.length === 0) throw new Error('templateMode=all 但当前没有启用中的模板');
  if (goalPrefersChoiceTemplate(goal)) {
    const choice = inferTemplateIdFromGoal(goal, active);
    if (choice !== null) return { templateId: choice, templateIds: null };
  }
  return { templateId: null, templateIds: active.map((template) => template.id) };
}
