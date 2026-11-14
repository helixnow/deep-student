// RUST-FIX(RF-P3-workshop-tools): existing pipeline with read-only tools and Host-materialized files.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSessionService } from '../../chat/api.ts';
import type { ChatPipelineService } from '../../chat-pipeline/api.ts';
import type { WorkshopCard } from '../api.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import type { WorkshopGeneration } from './operations.ts';
import { developmentSkill, developmentSkillId, seedTemplate } from './resources.ts';
import { sourceFiles } from './compiler.ts';
import { writeSourceFiles, type SourceFile } from './source.ts';
import type { WorkshopToolExecutor } from './tools.ts';

export class PipelineWorkshopGeneration implements WorkshopGeneration {
  readonly chat: ChatSessionService; readonly pipeline: ChatPipelineService; readonly tools: WorkshopToolExecutor;
  constructor(chat: ChatSessionService, pipeline: ChatPipelineService, tools: WorkshopToolExecutor) {
    this.chat = chat; this.pipeline = pipeline; this.tools = tools;
  }
  async generate(card: WorkshopCard, source: string, signal: AbortSignal): Promise<void> {
    if ((await sourceFiles(source)).length === 0) await seedTemplate(source, card);
    const templates: Record<string, string> = {};
    for (const file of await sourceFiles(source)) templates[file] = await readFile(join(source, file), 'utf8');
    const sessionId = `sess_${randomUUID()}`, time = new Date().toISOString();
    this.chat.createSession({ id: sessionId, mode: 'chat', title: `插件工坊：${card.title}`, titleLocked: true,
      persistStatus: 'active', createdAt: time, updatedAt: time, metadata: { workshopId: card.id, parentSessionId: card.sessionId, is_subagent: true } });
    const schemas = this.tools.schemaTools().filter(item => /api_list|api_read/.test(item.id));
    const messageId = await this.pipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId, content: `${await developmentSkill()}\n\nHost-controlled creation task. Return ONLY JSON {"files":[{"path":"package.json","content":"..."},...]}. `
        + 'No markdown fences. All output files are materialized by Host under the assigned source root. You have no filesystem, shell, installation or profile tools. '
        + `Preserve plugin id ${card.pluginId} and exact service name ${pluginServiceName(card.pluginId)} (use ${JSON.stringify(card.title)} for zh-CN title). Goal: ${card.description}\nAcceptance/changes: ${JSON.stringify(card.changes)}\nTemplate: ${JSON.stringify(templates)}`
        + (card.error ? `\nPrevious attempt failed. Repair the exact diagnostics, preserving working code: ${card.error}\nChecks: ${JSON.stringify(card.check)}` : ''),
      options: { activeSkillIds: [developmentSkillId], skillContents: { [developmentSkillId]: await developmentSkill() },
        executionAllowedTools: schemas.map(schema => schema.id), schemaToolIds: schemas.map(schema => schema.id) },
    }, signal, null);
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
