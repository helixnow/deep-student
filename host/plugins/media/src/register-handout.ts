/** Handout, pinned temp-session images and notes DOCX export (`src/cmd/handout.rs`, `src/commands.rs:356-395`). */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeOfficeWriter } from '../../../platform/native/office/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { AppCommandState } from '../../integration/api.ts';
import type { LLMManager, LlmOcrModels, LlmRawPrompt } from '../../llm/api.ts';
import { HandoutRegistry } from './handout.ts';
import { handoutLlmComplete, handoutVlmCaption, type HandoutLlmDeps } from './handout-llm.ts';
import { getImageAsBase64 } from './image-base64.ts';
import { notesExportDocx } from './notes-export-docx.ts';
import { pinImages, unpinImages } from './pin-images.ts';

export function registerHandoutCommands(ctx: Context): void {
  // src/commands.rs:356-395: temp session owned by L22 appCommandState (modify_temp_session).
  const pinDeps = {
    appCommandState: (): AppCommandState => {
      const service = ctx.get('appCommandState') as AppCommandState | undefined;
      if (service === undefined) throw new CommandError(AppError.configuration('临时会话服务未提供：需要 L22 appCommandState'));
      return service;
    },
    settings: ctx.settings,
  };
  ctx.commands.register<Commands['pin_images']['args'], boolean>('pin_images',
    ({ tempId, images }) => pinImages(pinDeps, tempId, images));
  ctx.commands.register<Commands['unpin_images']['args'], boolean>('unpin_images',
    ({ tempId }) => unpinImages(pinDeps, tempId));
  // src/cmd/handout.rs:129-142: cancellation registry shared by the LLM/VLM commands.
  const handouts = new HandoutRegistry();
  ctx.commands.register<Commands['handout_cancel']['args'], null>('handout_cancel',
    ({ requestId }) => handouts.cancel(requestId));
  ctx.commands.register<Commands['handout_release']['args'], null>('handout_release',
    ({ requestId }) => handouts.release(requestId));
  // src/cmd/handout.rs:74-127: L02 llmRawPrompt calls; VLM choice = vlm_grounding_service.rs get_vlm_config.
  const required = <T>(name: string): T => {
    const service = ctx.get(name) as T | undefined;
    if (service === undefined) throw new CommandError(AppError.configuration(`讲义模型调用服务未提供：需要 L02 ${name}`));
    return service;
  };
  const handoutLlm: HandoutLlmDeps = {
    registry: handouts,
    llm: () => required<LLMManager>('llm'),
    ocrModels: () => required<LlmOcrModels>('llmOcrModels'),
    rawPrompt: () => required<LlmRawPrompt>('llmRawPrompt'),
    log: ctx.logger('media.handout'),
  };
  ctx.commands.register<Commands['handout_llm_complete']['args'], string>('handout_llm_complete',
    args => handoutLlmComplete(handoutLlm, args));
  ctx.commands.register<Commands['handout_vlm_caption']['args'], string>('handout_vlm_caption',
    args => handoutVlmCaption(handoutLlm, args));
  // src/cmd/handout.rs:144-187: notes_assets images resolved here; F7 writer = generate_docx_from_spec.
  const notesDocxLog = ctx.logger('media.handout');
  ctx.commands.register<Commands['notes_export_docx']['args'], string>('notes_export_docx',
    ({ spec }) => notesExportDocx(spec, {
      imageAsBase64: (src) => getImageAsBase64(ctx.paths.appDataDir, src),
      writer: () => {
        const service = ctx.get('nativeOfficeWriter') as NativeOfficeWriter | undefined;
        if (service === undefined) {
          throw new CommandError(AppError.configuration('DOCX 生成服务未提供：需要 F7 nativeOfficeWriter'));
        }
        return service;
      },
      warn: (message) => notesDocxLog.warn(message),
    }));
}
