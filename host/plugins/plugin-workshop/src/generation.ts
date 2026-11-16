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
  async generate(card: WorkshopCard, source: string, signal: AbortSignal, progress?: (files: string[]) => void): Promise<void> {
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
  throw lastError instanceof Error ? lastError : new Error('WORKSHOP_INVALID: invalid JSON from model');
}

export async function materializeGeneratedFiles(source: string, text: string, signal: AbortSignal): Promise<void> {
  const payload = parseGeneratedFilesPayload(text);
  await writeSourceFiles(source, payload.files, signal);
}
