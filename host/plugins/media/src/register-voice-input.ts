/**
 * `voice_input_transcribe`（`src/voice_input.rs`）：只经 `ctx.settings`、L02 `llm@1` 与 ASR HTTP
 * （桌面 `llmHttp` → 移动端 `ctx.http` → 主线程 Capacitor HTTP）完成，音频以 base64 随请求传入，
 * 不需要 nativeAudio 解码。因此桌面与移动端共用这一份实现（`host/plugins/media/mobile.ts`）。
 *
 * 桌面 TTS（`tts_*`）走 `node:child_process`，留在 `register-voice.ts`。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { LLMManager } from '../../llm/api.ts';
import type { AsrFetch, VoiceInputUsageRecorder } from './voice-input.ts';
import {
  VoiceInputError, resolveSiliconflowKey, transcribeVoiceInput,
} from './voice-input.ts';

export interface VoiceInputCommandDeps {
  /** L02 `llm@1`；缺失时按 `VoiceInputError` 的配置错误返回。 */
  llm(): LLMManager | null;
  /** ASR HTTP 走 `llmHttp`（桌面）或 `ctx.http`（移动端）。 */
  asrFetch: AsrFetch;
  recordVoiceUsage: VoiceInputUsageRecorder;
}

export function registerVoiceInputCommand(ctx: Context, deps: VoiceInputCommandDeps): void {
  ctx.commands.register<Commands['voice_input_transcribe']['args'],
    Awaited<ReturnType<typeof transcribeVoiceInput>>>('voice_input_transcribe',
    async ({ request }) => {
      try {
        const key = await resolveSiliconflowKey(ctx.settings);
        return await transcribeVoiceInput(request, deps.llm(), key, deps.asrFetch, deps.recordVoiceUsage);
      } catch (error) {
        if (error instanceof VoiceInputError) throw new CommandError(error.appError);
        throw error;
      }
    });
}
