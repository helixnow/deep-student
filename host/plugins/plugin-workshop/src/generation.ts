// RUST-FIX(RF-P3-workshop-tools): existing pipeline with read-only tools and Host-materialized files.
import { WORKBENCH_READ_TOOLS } from '../../../../contracts/workbench-read-tools.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSessionService, MessageBlock, ToolResultInfo } from '../../chat/api.ts';
import type { ChatPipelineService } from '../../chat-pipeline/api.ts';
import type { WorkshopCard, WorkshopVerificationResult } from '../api.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import { writeHostStderr } from '../../../kernel/kernel.ts';
import type { WorkshopGeneration } from './operations.ts';
import { developmentSkill, developmentSkillId, recipeFiles, recipeFor, seedTemplate } from './resources.ts';
import { forbiddenCommunityApiProblems, sourceFiles } from './compiler.ts';
import { writeSourceFiles, type SourceFile } from './source.ts';
import type { WorkshopToolExecutor } from './tools.ts';

/** The window event stream of the generation session (`ctx.backendEvents`); used only to report progress. */
export interface WorkshopGenerationEvents {
  listenWindow(window: { window: string; webview: string }, event: string, receive: (payload: unknown) => void): () => void;
}

/** Source paths named so far in the model's streamed JSON answer ({"files":[{"path":"..."}]}). */
export function streamedPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/"path"\s*:\s*"([^"\\]{1,200})"/g)].map(match => match[1]!))];
}

const RECIPE_PURPOSE: Record<string, string> = {
  'agent-tool': 'a new Agent tool: manifest agentTools + "agent:tools", network only through tool.fetch and declared "net:<host>" permissions for hosts the user actually named',
  'selection-model': 'an editor selection-toolbar button and/or the user\'s model through "service:pluginModel"',
  'reference-app': 'an app view with a list, search and built-in data (DsSearchInput, DsCard, DsListItem, DsBadge; formulas with MathText)',
};

export class PipelineWorkshopGeneration implements WorkshopGeneration {
  readonly chat: ChatSessionService; readonly pipeline: ChatPipelineService; readonly tools: WorkshopToolExecutor;
  readonly events: WorkshopGenerationEvents | null;
  constructor(chat: ChatSessionService, pipeline: ChatPipelineService, tools: WorkshopToolExecutor, events: WorkshopGenerationEvents | null = null) {
    this.chat = chat; this.pipeline = pipeline; this.tools = tools; this.events = events;
  }
  async generate(card: WorkshopCard, source: string, signal: AbortSignal, progress?: (files: string[]) => void): Promise<void | { tokens?: number; blockedReason?: string }> {
    if ((await sourceFiles(source)).length === 0) await seedTemplate(source, card);
    const templates: Record<string, string> = {};
    for (const file of await sourceFiles(source)) templates[file] = await readFile(join(source, file), 'utf8');
    const recipe = await recipeFiles(recipeFor(card));
    const sessionId = `sess_${randomUUID()}`, time = new Date().toISOString();
    this.chat.createSession({ id: sessionId, mode: 'chat', title: `插件工坊：${card.title}`, titleLocked: true,
      persistStatus: 'active', createdAt: time, updatedAt: time, metadata: { workshopId: card.id, parentSessionId: card.sessionId, is_subagent: true } });
    const schemas = this.tools.schemaTools().filter(item => ['dstu_plugin_api_list', 'dstu_plugin_api_read'].includes(item.id));
    const skill = await developmentSkill();
    const target = { window: 'main', webview: 'main' };
    // Progress: the files the model has named so far in its streamed answer. Best effort; never affects the result.
    let streamed = '';
    const stopListening = progress && this.events ? this.events.listenWindow(target, `chat_v2_event_${sessionId}`, raw => {
      const event = raw as { type?: string; phase?: string; chunk?: unknown } | null;
      if (event?.type !== 'content' || event.phase !== 'chunk' || typeof event.chunk !== 'string') return;
      streamed += event.chunk;
      try { progress(streamedPaths(streamed)); }
      catch (error) { writeHostStderr(`[plugin-workshop] could not report file progress: ${String(error)}\n`); }
    }) : null;
    const settings = (card.settings ?? []).filter(setting => setting.value).map(({ key, title, kind }) => ({ key, title, kind }));
    let messageId: string;
    try {
      // The development skill reaches the model once, as the active skill (skillContents), not again in the task text.
      messageId = await this.pipeline.execute(target, {
        sessionId, content: 'Host-controlled creation task. Return ONLY JSON {"files":[{"path":"package.json","content":"..."},...]}. '
          + 'If a concrete missing user value, unavailable capability or external condition prevents progress, return ONLY JSON {"blockedReason":"explain what is missing"}. Repair actionable compiler/runtime errors instead of repeating unchanged code. '
          + 'No markdown fences. All output files are materialized by Host under the assigned source root. You have no filesystem, shell, installation or profile tools. '
          + 'The Host sets the package/module version of a modification and the net:<host> of user addresses itself. '
          + `Preserve plugin id ${card.pluginId} and exact service name ${pluginServiceName(card.pluginId)} (use ${JSON.stringify(card.title)} for zh-CN title). Goal: ${card.description}\nAcceptance/changes: ${JSON.stringify(card.changes)}`
          // The recipe covers what the seed template does not show. The current source stays last, as before.
          + `\nRecipe "${recipe.name}" (adapt it only if the goal needs ${RECIPE_PURPOSE[recipe.name] ?? recipe.name}; otherwise ignore it): ${JSON.stringify(recipe.files)}`
          // F20: a modification must still read what the previous version stored.
          + '\nStored data: keep every persisted record readable across versions. Store a schema version field with the data '
          + '(e.g. { v: 1, ... }); when reading, accept records without it or with an older v and migrate them in code (never throw on or drop them); '
          + 'in a modification never rename or delete existing storage keys, only add new ones.'
          + '\nCredentials: never copy API keys or tokens into source or ordinary configuration. Use the user-provided secret setting and ctx.pluginSecrets.get(key), or the declared plugin model service.'
          + '\nForbidden kernel/context APIs (KERNEL_API_FORBIDDEN in community plugin API v1): NEVER call or access `ctx.files.scope` (or `.scope` / `.root` / `.store` / `.registry` / `.runtime` / `.fiber` on `ctx` or any `ctx.<service>`). '
          + 'For plugin state and persistence, use allowed plugin storage APIs instead: `usePluginStorage` / `usePluginStore` (`ctx.ui.storage`) or `window.localStorage` on the UI side, or `ctx.storage` / `ctx.settings` (with declared `"service:storage"` / `"service:settings"`) on the Host side; for user-chosen local files use `pluginFiles` from `@deepstudent/ui`.'
          + '\nPlugin v2 capabilities (live in Host — pick the lightest tier that fits the goal): '
          + 'Tier 1 pure declarative packages use manifestVersion: 2 and deepStudent.declarative: { rubrics, skills, cardTemplates, workflows } with zero JS/TS needed for custom rubrics, skills, card templates, or workflows; '
          + 'Tier 2 UI-only plugins omit boilerplate Host files when calling brokered services (studyData, pluginModel, pluginNotify) via ctx.ui.host with declared "service:<name>" permissions; '
          + 'Tier 3 full plugins can also hook into Cordis core registries (chatPipelineHooks, gradingRubrics, reviewSchedulers, memoryProvider) via inject plus matching "service:<name>" permissions.'
          + (settings.length ? `\nUser settings: the Host stores the values the user entered as this plugin's config. Never hard-code them; read config[key] in apply(ctx, config) and report clearly when one is missing: ${JSON.stringify(settings)}` : '')
          + `\nTemplate: ${JSON.stringify(templates)}`
          + (card.error ? `\nPrevious attempt failed. Repair the exact diagnostics, preserving working code: ${card.error}\nChecks: ${JSON.stringify(card.check)}` : ''),
        options: { ...(card.execution?.modelId ? { modelId: card.execution.modelId, strictModelId: true } : {}), activeSkillIds: [developmentSkillId], skillContents: { [developmentSkillId]: skill },
          executionAllowedTools: schemas.map(schema => schema.id), schemaToolIds: schemas.map(schema => schema.id) },
      }, signal, null);
    } finally { stopListening?.(); }
    if (signal.aborted) return;
    const blocks = this.chat.getMessageBlocks(messageId);
    const text = extractAssistantAnswerText(blocks);
    const blocked = parseGenerationBlocked(text);
    if (blocked) return { blockedReason: blocked };
    await materializeGeneratedFiles(source, text, signal);
    // Tokens the generation conversation used (its message usage), for the card's 「用了多少」 line. Best effort.
    try {
      const total = this.chat.getMessage(messageId)?._meta?.usage?.totalTokens;
      return typeof total === 'number' && total > 0 ? { tokens: total } : undefined;
    } catch { return undefined; }
  }

  /** Read-only runtime verification. Interactions and business writes need a separate scoped authorization. */
  async verify(card: WorkshopCard, source: string, signal: AbortSignal): Promise<WorkshopVerificationResult> {
    const files: Record<string, string> = {};
    for (const file of await sourceFiles(source)) {
      const content = await readFile(join(source, file), 'utf8');
      files[file] = content;
      if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) {
        const forbidden = forbiddenCommunityApiProblems(content);
        if (forbidden.length) {
          return { status: 'failed', evidence: [], error: forbidden.join('\n') };
        }
      }
    }
    const criteria = verificationCriteria(card);
    const appCandidate = isAppViewCandidate(card);
    const verifyTools = appCandidate ? [...VERIFICATION_TOOLS] : ['dstu_plugin_inventory'];
    const expectedVersion = card.validation?.version ?? card.version;
    const content = appCandidate
      ? 'Host-controlled read-only runtime verification task. The candidate is activated but NOT verified. Inspect the actual application using read-only tools. '
        + `Candidate pluginId=${card.pluginId}, version=${expectedVersion}. Criteria (zero-based indices): ${JSON.stringify(criteria)}. `
        + 'The trusted UI opens the exact candidate view. Discover its actual windowId and registered typeId with workbench_list_windows or workbench_get_capabilities; never invent a view key. Observe that exact windowId. '
        + 'Read observation.state: pluginId, version, status, text and controls. If loading, workbench_wait_for state_equals status ready. '
        + 'Inspect rendered controls, labels, initial state, and absence of errors against each criterion. '
        + 'This verifier has NO interaction, plugin-tool, shell, installation, network or data-write authority. For interactive features (buttons, inputs, calculators, timers, etc.), evaluate whether the healthy rendered UI displays the expected controls and initial output in observation.state — return "passed" when the healthy page renders them without errors. '
        + 'Return "failed" with concrete diagnostics if the page has errors, fails to load, or is missing expected UI elements. '
        + 'Return "blocked" ONLY when an external prerequisite is genuinely missing (missing user setting/API key/account info or unavailable runtime/window). '
        + 'For each criterion claimed passed, cite successful observation tool_call IDs from this conversation and the visible outcome. '
        + 'Output ONLY the raw JSON verdict object (no markdown fences, either directly as final assistant text OR inside attempt_completion.result if completing with a tool): '
        + '{"status":"passed|failed|blocked","error":"diagnostic if not passed","checks":[{"criterion":0,"observed":"what the actual page showed","toolCallIds":["actual call id"]}]}. '
        + 'A passed result must cover every criterion with current-candidate observations. Source and API documentation are not runtime proof. '
        + `Candidate source (context, not proof): ${JSON.stringify(files)}`
      : 'Host-controlled read-only runtime verification task. This candidate does not register a standalone app window; it contributes to existing app surfaces or Host tools '
        + `(places=${JSON.stringify(card.places ?? card.expectedPlaces ?? [])}). `
        + `Candidate pluginId=${card.pluginId}, version=${expectedVersion}. Criteria (zero-based indices): ${JSON.stringify(criteria)}. `
        + 'Call dstu_plugin_inventory to inspect the live plugin inventory and confirm the candidate plugin is present with matching id, matching version, enabled=true, and state="running". '
        + 'If the plugin is degraded, disabled, stopped, or running the wrong version, return "failed" with diagnostics. '
        + 'Return "blocked" ONLY if runtime inventory is unavailable or an external prerequisite is genuinely missing. '
        + 'For each criterion claimed passed, cite the successful dstu_plugin_inventory tool_call ID (and any observation tool_call ID if applicable). '
        + 'Output ONLY the raw JSON verdict object (no markdown fences, either directly as final assistant text OR inside attempt_completion.result if completing with a tool): '
        + '{"status":"passed|failed|blocked","error":"diagnostic if not passed","checks":[{"criterion":0,"observed":"what inventory/runtime showed","toolCallIds":["actual call id"]}]}. '
        + `Candidate source (context, not proof): ${JSON.stringify(files)}`;
    const sessionId = `sess_${randomUUID()}`, time = new Date().toISOString();
    this.chat.createSession({ id: sessionId, mode: 'chat', title: `插件验收：${card.title}`, titleLocked: true,
      persistStatus: 'active', createdAt: time, updatedAt: time, metadata: { workshopId: card.id, parentSessionId: card.sessionId, is_subagent: true } });
    const messageId = await this.pipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId,
      content,
      options: { ...(card.execution?.modelId ? { modelId: card.execution.modelId, strictModelId: true } : {}),
        schemaToolIds: verifyTools, executionAllowedTools: verifyTools,
        activeSkillIds: [], memoryEnabled: false, ragEnabled: false, webSearchEnabled: false },
    }, signal, null);
    if (signal.aborted) return { status: 'blocked', evidence: [], error: 'Verification cancelled' };
    const blocks = this.chat.getMessageBlocks(messageId);
    const text = extractAssistantAnswerText(blocks);
    // Message metadata stores only the tool/block link; the authoritative payload lives in that message's block.
    const results = (this.chat.getMessage(messageId)?._meta?.toolResults ?? []).map(result => {
      if (!result.blockId) return result;
      const block = blocks.find(item => item.id === result.blockId);
      if (!block || stripBuiltin(block.toolName ?? '') !== stripBuiltin(result.toolName)) {
        return { ...result, success: false, output: null, error: 'Verification tool result block is unavailable or mismatched' };
      }
      return { ...result, input: block.toolInput ?? null, output: block.toolOutput ?? null,
        success: result.success && block.status === 'success', error: result.error ?? block.error };
    });
    const initial = validateVerificationResult(text, card, results);
    if (
      initial.status === 'blocked'
      && /^WORKSHOP_VERIFICATION_(?:INVALID|INCOMPLETE)\b/.test(initial.error ?? '')
      && results.some(result => isVerifiedCandidateInventoryResult(result, card.pluginId, expectedVersion))
    ) {
      const inventoryCallIds = results
        .filter(result => isVerifiedCandidateInventoryResult(result, card.pluginId, expectedVersion))
        .map(result => result.toolCallId);
      const recoveryMessageId = await this.pipeline.execute({ window: 'main', webview: 'main' }, {
        sessionId,
        content: `Your previous reply failed structured validation (${initial.error ?? 'WORKSHOP_VERIFICATION_INVALID'}). Do NOT call any tools. `
          + `Candidate pluginId=${card.pluginId}, version=${expectedVersion}. Criteria (zero-based indices): ${JSON.stringify(criteria)}. `
          + `Verified dstu_plugin_inventory toolCallIds already recorded in this session: ${JSON.stringify(inventoryCallIds)}. `
          + 'Output ONLY the raw JSON verdict object (no markdown fences, either directly as final assistant text OR inside attempt_completion.result if completing with a tool): '
          + '{"status":"passed|failed|blocked","error":"diagnostic if not passed","checks":[{"criterion":0,"observed":"what inventory showed","toolCallIds":["actual call id"]}]}.',
        options: { ...(card.execution?.modelId ? { modelId: card.execution.modelId, strictModelId: true } : {}),
          schemaToolIds: [], executionAllowedTools: [],
          activeSkillIds: [], memoryEnabled: false, ragEnabled: false, webSearchEnabled: false },
      }, signal, null);
      if (signal.aborted) return { status: 'blocked', evidence: [], error: 'Verification cancelled' };
      const recoveryText = extractAssistantAnswerText(this.chat.getMessageBlocks(recoveryMessageId));
      const recovered = validateVerificationResult(recoveryText, card, results);
      if (recovered.status === 'blocked') {
        console.warn('[plugin-workshop] verify blocked:', recovered.error);
      }
      return recovered;
    }
    if (initial.status === 'blocked') {
      console.warn('[plugin-workshop] verify blocked:', initial.error);
    }
    return initial;
  }
}


function parseGeneratedFilesPayload(text: string): { files: SourceFile[] } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { files?: SourceFile[] };
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) {
        return { files: parsed.files };
      }
    } catch (error) {
      lastError = error;
    }
  }
  // An answer that opens a JSON object but never closes it was cut off (the output limit): say so, so the card can
  // explain it and the repair round writes less instead of guessing at a syntax error.
  if (looksTruncated(trimmed, lastError)) {
    throw new Error(`WORKSHOP_TRUNCATED: the answer was cut off before the JSON ended (${trimmed.length} characters). Write fewer and shorter files: keep only what the goal needs, no comments, no sample data beyond a few items.`);
  }
  throw lastError instanceof Error ? lastError : new Error('WORKSHOP_INVALID: invalid JSON from model');
}

/** The model's JSON answer ended early (unterminated string, more opening than closing brackets, "Unexpected end"). */
export function looksTruncated(text: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/Unexpected end of JSON|Unterminated string|end of data/i.test(message)) return true;
  const start = text.indexOf('{');
  if (start < 0) return false;
  let depth = 0, inString = false, escaped = false;
  for (const char of text.slice(start)) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return inString || depth > 0;
}

export async function materializeGeneratedFiles(source: string, text: string, signal: AbortSignal): Promise<void> {
  const payload = parseGeneratedFilesPayload(text);
  await writeSourceFiles(source, payload.files, signal);
}


/** Only read-only inspection: no workbench actions, generated tools or installation authority. */
export const VERIFICATION_TOOLS = Object.keys(WORKBENCH_READ_TOOLS);
const observationTools = new Set(['workbench_observe', 'workbench_wait_for', 'workbench_query_state']);
const stripBuiltin = (name: string) => name.replace(/^builtin[-:]/, '');
export function isAppViewCandidate(card: Pick<WorkshopCard, 'places' | 'expectedPlaces' | 'template'>): boolean {
  const places = card.places ?? card.expectedPlaces;
  if (places?.length) return places.some(place => place.kind === 'app');
  if (card.places) return false;
  return card.template === 'learning-tool';
}
export function verificationCriteria(card: Pick<WorkshopCard, 'description' | 'changes'>): string[] {
  return [card.description, ...card.changes];
}
function jsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Allow model commentary before/after JSON fences or objects.
  }
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  for (let match = fenceRegex.exec(trimmed); match !== null; match = fenceRegex.exec(trimmed)) {
    try {
      return JSON.parse(match[1]!);
    } catch {
      // Try subsequent fenced blocks if an earlier block wasn't valid JSON.
    }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(trimmed);
}
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
type AssistantAnswerBlock = Pick<MessageBlock, 'type'> & Partial<Pick<MessageBlock, 'status' | 'content' | 'toolName' | 'toolInput' | 'toolOutput'>>;
function extractAttemptCompletionResult(block: AssistantAnswerBlock): string {
  const output = asObject(block.toolOutput);
  const nestedOutput = asObject(output?.result);
  const input = asObject(block.toolInput);
  for (const candidate of [output?.result, nestedOutput?.result, input?.result]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}
function isCleanJsonAnswer(text: string): boolean {
  if (!text.trim()) return false;
  try {
    jsonAnswer(text);
    return true;
  } catch {
    return false;
  }
}
/** Extract the assistant's structured answer from `attempt_completion` or `content` blocks, preferring clean JSON. */
export function extractAssistantAnswerText(blocks: readonly AssistantAnswerBlock[]): string {
  let completionText = '';
  for (const block of [...blocks].reverse()) {
    if (block.status === 'success' && stripBuiltin(block.toolName ?? '') === 'attempt_completion') {
      const candidate = extractAttemptCompletionResult(block);
      if (candidate) {
        completionText = candidate;
        break;
      }
    }
  }
  const contentText = blocks.filter(block => block.type === 'content').map(block => block.content ?? '').join('');
  if (isCleanJsonAnswer(completionText)) return completionText;
  if (isCleanJsonAnswer(contentText)) return contentText;
  return completionText || contentText;
}
function parseGenerationBlocked(text: string): string | undefined {
  try {
    const value = jsonAnswer(text) as { blockedReason?: unknown };
    return typeof value?.blockedReason === 'string' && value.blockedReason.trim() ? value.blockedReason.trim() : undefined;
  } catch { return undefined; }
}
/** Read only the runtime observation fields, never JSON embedded in candidate-controlled visible text. */
function hasCandidateObservation(value: unknown, pluginId: string, version: string | null): boolean {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  if (!value || typeof value !== 'object' || version === null) return false;
  const result = value as Record<string, unknown>;
  const observation = result.observation && typeof result.observation === 'object'
    ? result.observation as Record<string, unknown> : result;
  if (!observation.state || typeof observation.state !== 'object') return false;
  const state = observation.state as Record<string, unknown>;
  return state.pluginId === pluginId && state.version === version && state.status === 'ready';
}
function hasCandidateInventory(value: unknown, pluginId: string, version: string | null): boolean {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  if (!value || typeof value !== 'object' || version === null) return false;
  const record = value as Record<string, unknown>;
  const plugins = Array.isArray(record.plugins) ? record.plugins : null;
  if (!plugins) return false;
  return plugins.some(item => {
    if (!item || typeof item !== 'object') return false;
    const entry = item as Record<string, unknown>;
    return entry.id === pluginId && entry.version === version && entry.enabled === true && entry.state === 'running';
  });
}
function toolSucceeded(result: ToolResultInfo): boolean {
  if (!result.success || result.error) return false;
  let output = result.output;
  if (typeof output === 'string') { try { output = JSON.parse(output); } catch { return true; } }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (record.ok === false || record.success === false || record.isError === true) return false;
    if (stripBuiltin(result.toolName) === 'workbench_wait_for' && (record.matched !== true || record.timedOut === true)) return false;
  }
  return true;
}
function isVerifiedCandidateInventoryResult(result: ToolResultInfo, pluginId: string, version: string | null): boolean {
  return toolSucceeded(result)
    && stripBuiltin(result.toolName) === 'dstu_plugin_inventory'
    && hasCandidateInventory(result.output, pluginId, version);
}
/** Checks existing persisted tool facts; unobserved candidates cannot become the usable release. */
export function validateVerificationResult(text: string, card: WorkshopCard, results: readonly ToolResultInfo[]): WorkshopVerificationResult {
  const blocked = (error: string): WorkshopVerificationResult => ({ status: 'blocked', evidence: [], error });
  let answer: { status?: unknown; error?: unknown; checks?: unknown };
  try { answer = jsonAnswer(text) as typeof answer; } catch { return blocked('WORKSHOP_VERIFICATION_INVALID: verifier did not return a structured result'); }
  if (!answer || !['passed', 'failed', 'blocked'].includes(String(answer.status))) return blocked('WORKSHOP_VERIFICATION_INVALID: missing verification status');
  if (answer.status !== 'passed') return { status: answer.status as 'failed' | 'blocked', evidence: [],
    error: typeof answer.error === 'string' && answer.error.trim() ? answer.error : 'Runtime verification did not complete' };
  if (!Array.isArray(answer.checks)) return blocked('WORKSHOP_VERIFICATION_INVALID: missing criterion results');
  const byId = new Map(results.map(result => [result.toolCallId, result]));
  const evidence: string[] = [];
  const appCandidate = isAppViewCandidate(card);
  const expectedVersion = card.validation?.version ?? card.version;
  const isCandidateObsResult = (result: ToolResultInfo): boolean => {
    if (!toolSucceeded(result)) return false;
    const toolName = stripBuiltin(result.toolName);
    if (observationTools.has(toolName) && hasCandidateObservation(result.output, card.pluginId, expectedVersion)) return true;
    if (!appCandidate && isVerifiedCandidateInventoryResult(result, card.pluginId, expectedVersion)) return true;
    return false;
  };
  const verifiedCandidateResults = results.filter(isCandidateObsResult);
  const resolveResult = (rawId: unknown, preferCandidateObs: boolean): ToolResultInfo | undefined => {
    if (typeof rawId !== 'string') return undefined;
    const trimmed = rawId.trim();
    if (!trimmed) return undefined;
    const exact = byId.get(trimmed);
    if (exact) return exact;
    const normalized = stripBuiltin(trimmed);
    const byName = results.filter((r) => toolSucceeded(r) && stripBuiltin(r.toolName) === normalized);
    if (byName.length > 0) {
      return byName.find(isCandidateObsResult) ?? byName[byName.length - 1];
    }
    return preferCandidateObs && verifiedCandidateResults.length > 0
      ? verifiedCandidateResults[0]
      : undefined;
  };
  const criteria = verificationCriteria(card);
  const usesOneBasedIndices =
    criteria.length > 0 &&
    !answer.checks.some((item: { criterion?: unknown }) => item?.criterion === 0) &&
    answer.checks.every(
      (item: { criterion?: unknown }) =>
        typeof item?.criterion === 'number' &&
        Number.isInteger(item.criterion) &&
        item.criterion >= 1 &&
        item.criterion <= criteria.length,
    );
  for (const [index, criterion] of criteria.entries()) {
    const targetCriterion = usesOneBasedIndices ? index + 1 : index;
    const check = answer.checks.find((item: { criterion?: unknown }) => item?.criterion === targetCriterion);
    if (!check || typeof check.observed !== 'string' || !check.observed.trim() || !Array.isArray(check.toolCallIds) || !check.toolCallIds.length) {
      return blocked(`WORKSHOP_VERIFICATION_INCOMPLETE: no runtime result for criterion ${index}: ${criterion}`);
    }
    const resolvedIds: string[] = [];
    let runtime = false;
    let sawValidSucceeded = false;
    let sawExplicitFailure = false;
    for (const id of check.toolCallIds) {
      const exact = typeof id === 'string' ? byId.get(id.trim()) : undefined;
      if (exact && !toolSucceeded(exact)) {
        sawExplicitFailure = true;
        continue;
      }
      const resolved = resolveResult(id, true);
      if (!resolved || !toolSucceeded(resolved) || !resolved.toolCallId) {
        return blocked(`WORKSHOP_VERIFICATION_INVALID: missing or failed tool call for criterion ${index}`);
      }
      sawValidSucceeded = true;
      resolvedIds.push(resolved.toolCallId);
      if (isCandidateObsResult(resolved)) runtime = true;
    }
    if (sawExplicitFailure || !sawValidSucceeded) {
      return blocked(`WORKSHOP_VERIFICATION_INVALID: missing or failed tool call for criterion ${index}`);
    }
    if (!runtime) return blocked(`WORKSHOP_VERIFICATION_INCOMPLETE: criterion ${index} has no current-candidate observation`);
    evidence.push(`${criterion}: ${check.observed} [${resolvedIds.join(', ')}]`);
  }
  return { status: 'passed', evidence };
}
