/** Text-to-speech commands (`src/tts.rs`). Voice input lives in `register-voice-input.ts` (portable, shared
 * with the mobile entry). */
import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import { registerVoiceInputCommand } from './register-voice-input.ts';
import { checkAvailable, speak } from './tts.ts';
import { synthesizeDeepseek } from './deepseek-tts.ts';

export { registerVoiceInputCommand } from './register-voice-input.ts';

export function registerVoiceCommands(ctx: Context, deps: MediaPluginDeps): void {
  registerVoiceInputCommand(ctx, {
    llm: () => deps.llm(),
    asrFetch: deps.asrFetch,
    recordVoiceUsage: deps.recordVoiceUsage,
  });
  ctx.commands.register('tts_check_available', () => checkAvailable());
  ctx.commands.register<Commands['tts_deepseek']['args'], string>('tts_deepseek', ({ text, voiceId }) =>
    synthesizeDeepseek(deps.llm(), deps.asrFetch, text, voiceId));
  ctx.commands.register<Commands['tts_speak']['args'], null>('tts_speak', ({ text, lang, rate }) => speak(text, lang ?? null, rate ?? null));
  // Rust tts.rs:94–99 does not track or terminate any subprocess.
  ctx.commands.register('tts_stop', () => null);
}
