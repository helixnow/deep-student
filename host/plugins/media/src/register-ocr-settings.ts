/**
 * OCR 设置类命令（`src/cmd/ocr.rs` 的模型 / 引擎配置部分），只依赖 `ctx.settings` 与
 * `llm-providers` / `llm` 的纯函数，不触达 `node:*`：桌面与移动端共用这一份实现
 * （移动端入口 `host/plugins/media/mobile.ts`，`scripts/portability/scan.mjs --profile` 守护）。
 *
 * PDF OCR 会话与引擎探测（`register-ocr.ts`）需要 PDFium / 图片 / 临时目录，留在桌面入口。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { LLMManager } from '../../llm/api.ts';
import {
  addOcrEngine, getAvailableOcrModels, getOcrEngines, getOcrPromptTemplate, getOcrThinkingEnabled,
  inferOcrEngineFromModel, removeOcrEngine, setOcrEngineType, updateOcrEnginePriority, validateOcrModel,
  OcrSettingsError,
} from './ocr-settings.ts';

export interface OcrSettingsDeps {
  /** L02 `llm@1`；没有时模型校验跳过（与 Rust `if let Ok(...)` 一致）。 */
  llm(): LLMManager | null;
}

export function ocrFailure(error: unknown): never {
  if (error instanceof OcrSettingsError) {
    throw new CommandError(error.kind === 'validation'
      ? AppError.validation(error.message)
      : AppError.database(error.message));
  }
  throw error;
}

export function registerOcrSettingsCommands(ctx: Context, { llm }: OcrSettingsDeps): void {
  ctx.commands.register('get_ocr_engine_type', () => {
    try { return ctx.settings.get('ocr.engine_type') ?? 'paddle_ocr_vl'; }
    catch (error) { throw new CommandError(AppError.database(`读取 OCR 引擎配置失败: ${(error as Error).message}`)); }
  });
  ctx.commands.register<Commands['set_ocr_thinking_enabled']['args'], boolean>('set_ocr_thinking_enabled', ({ enabled }) => {
    try { ctx.settings.save('ocr.enable_thinking', enabled ? 'true' : 'false'); }
    catch (error) { throw new CommandError(AppError.database(`保存 OCR 推理配置失败: ${(error as Error).message}`)); }
    return true;
  });
  ctx.commands.register<Commands['save_available_ocr_models']['args'], boolean>('save_available_ocr_models', ({ models }) => {
    const configs = models.map((m, i) => ({ configId: m.configId, model: m.model, engineType: m.engineType,
      name: m.name, isFree: m.isFree ?? false, enabled: m.enabled ?? true, priority: m.priority ?? i }));
    let json: string;
    try { json = JSON.stringify(configs); }
    catch (error) { throw new CommandError(AppError.database(`序列化 OCR 模型配置失败: ${(error as Error).message}`)); }
    try { ctx.settings.save('ocr.available_models', json); }
    catch (error) { throw new CommandError(AppError.database(`保存 OCR 模型配置失败: ${(error as Error).message}`)); }
    return true;
  });
  ctx.commands.register('get_ocr_thinking_enabled', () => getOcrThinkingEnabled(ctx.settings));
  ctx.commands.register('get_ocr_engines', () => getOcrEngines(ctx.app.platform));
  ctx.commands.register<Commands['get_ocr_prompt_template']['args'], string>('get_ocr_prompt_template',
    ({ engineType, mode }) => getOcrPromptTemplate(engineType, mode));
  ctx.commands.register<Commands['infer_ocr_engine_from_model']['args'], string>('infer_ocr_engine_from_model',
    ({ model }) => inferOcrEngineFromModel(model));
  ctx.commands.register<Commands['validate_ocr_model']['args'], ReturnType<typeof validateOcrModel>>('validate_ocr_model',
    ({ model, engineType }) => validateOcrModel(model, engineType));
  ctx.commands.register<Commands['set_ocr_engine_type']['args'], boolean>('set_ocr_engine_type', ({ engineType }) => {
    try { setOcrEngineType(ctx.settings, engineType); return true; }
    catch (error) { return ocrFailure(error); }
  });
  ctx.commands.register<Commands['remove_ocr_engine']['args'], boolean>('remove_ocr_engine', ({ configId }) => {
    try { removeOcrEngine(ctx.settings, configId); return true; }
    catch (error) { return ocrFailure(error); }
  });
  ctx.commands.register<Commands['update_ocr_engine_priority']['args'], boolean>('update_ocr_engine_priority',
    ({ engineList }) => {
      try { updateOcrEnginePriority(ctx.settings, engineList); return true; }
      catch (error) { return ocrFailure(error); }
    });
  ctx.commands.register<Commands['add_ocr_engine']['args'], boolean>('add_ocr_engine',
    async ({ configId, model, name, engineType }) => {
      try {
        await addOcrEngine(ctx.settings, llm(), configId, model, name, engineType ?? null, ctx.app.platform);
        return true;
      } catch (error) { return ocrFailure(error); }
    });
  ctx.commands.register<Commands['get_available_ocr_models']['args'], Awaited<ReturnType<typeof getAvailableOcrModels>>>(
    'get_available_ocr_models',
    async () => {
      const ocrLog = ctx.logger('media.ocr');
      try {
        return await getAvailableOcrModels(ctx.settings, llm(), ctx.app.platform,
          message => { ocrLog.info(message); });
      }
      catch (error) { return ocrFailure(error); }
    });
}
