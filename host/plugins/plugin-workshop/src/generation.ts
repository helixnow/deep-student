// RUST-FIX(RF-P3-workshop-tools): existing pipeline with read-only tools and Host-materialized files.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSessionService } from '../../chat/api.ts';
import type { ChatPipelineService } from '../../chat-pipeline/api.ts';
import type { WorkshopCard } from '../api.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import type { WorkshopGeneration } from './operations.ts';
import { developmentSkill, developmentSkillId, recipeFiles, recipeFor, seedTemplate } from './resources.ts';
import { sourceFiles } from './compiler.ts';
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
  async generate(card: WorkshopCard, source: string, signal: AbortSignal, progress?: (files: string[]) => void): Promise<void | { tokens?: number }> {
    if ((await sourceFiles(source)).length === 0) await seedTemplate(source, card);
    const templates: Record<string, string> = {};
    for (const file of await sourceFiles(source)) templates[file] = await readFile(join(source, file), 'utf8');
    const recipe = await recipeFiles(recipeFor(card));
    const sessionId = `sess_${randomUUID()}`, time = new Date().toISOString();
    this.chat.createSession({ id: sessionId, mode: 'chat', title: `插件工坊：${card.title}`, titleLocked: true,
      persistStatus: 'active', createdAt: time, updatedAt: time, metadata: { workshopId: card.id, parentSessionId: card.sessionId, is_subagent: true } });
    const schemas = this.tools.schemaTools().filter(item => /api_list|api_read/.test(item.id));
    const skill = await developmentSkill();
    const target = { window: 'main', webview: 'main' };
    // Progress: the files the model has named so far in its streamed answer. Best effort; never affects the result.
    let streamed = '';
    const stopListening = progress && this.events ? this.events.listenWindow(target, `chat_v2_event_${sessionId}`, raw => {
      const event = raw as { type?: string; phase?: string; chunk?: unknown } | null;
      if (event?.type !== 'content' || event.phase !== 'chunk' || typeof event.chunk !== 'string') return;
      streamed += event.chunk;
      try { progress(streamedPaths(streamed)); } catch { /* progress is best effort */ }
    }) : null;
    const settings = (card.settings ?? []).filter(setting => setting.value).map(({ key, title, kind }) => ({ key, title, kind }));
    let messageId: string;
    try {
      // The development skill reaches the model once, as the active skill (skillContents), not again in the task text.
      messageId = await this.pipeline.execute(target, {
        sessionId, content: 'Host-controlled creation task. Return ONLY JSON {"files":[{"path":"package.json","content":"..."},...]}. '
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
          + (settings.length ? `\nUser settings: the Host stores the values the user entered as this plugin's config. Never hard-code them; read config[key] in apply(ctx, config) and report clearly when one is missing: ${JSON.stringify(settings)}` : '')
          + `\nTemplate: ${JSON.stringify(templates)}`
          + (card.error ? `\nPrevious attempt failed. Repair the exact diagnostics, preserving working code: ${card.error}\nChecks: ${JSON.stringify(card.check)}` : ''),
        options: { activeSkillIds: [developmentSkillId], skillContents: { [developmentSkillId]: skill },
          executionAllowedTools: schemas.map(schema => schema.id), schemaToolIds: schemas.map(schema => schema.id) },
      }, signal, null);
    } finally { stopListening?.(); }
    if (signal.aborted) return;
    const blocks = this.chat.getMessageBlocks(messageId);
    const text = blocks.filter(block => block.type === 'content').map(block => block.content ?? '').join('');
    await materializeGeneratedFiles(source, text, signal);
    // Tokens the generation conversation used (its message usage), for the card's 「用了多少」 line. Best effort.
    try {
      const total = this.chat.getMessage(messageId)?._meta?.usage?.totalTokens;
      return typeof total === 'number' && total > 0 ? { tokens: total } : undefined;
    } catch { return undefined; }
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
