/** Command layer for `chat_v2_stage_context_attachments` (attachment_stage_executor.rs:1848-1922). */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { Commands } from '../api.ts';
import { stageContextAttachments, type StageContextDeps } from './attachment-stage.ts';
import { errorText } from './logger.ts';

type Args<K extends keyof Commands> = Commands[K]['args'];

/** Rust returns `Result<_, String>`: every failure reaches the frontend as the plain message. */
export function registerStageContextAttachmentsCommand(ctx: Context, deps: StageContextDeps): void {
  ctx.commands.register<Args<'chat_v2_stage_context_attachments'>>('chat_v2_stage_context_attachments', async a => {
    try { return await stageContextAttachments(deps, a.sessionId, a.items); }
    catch (error) { throw new CommandError(errorText(error)); }
  });
}
