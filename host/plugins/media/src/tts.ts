import { spawn } from 'node:child_process';
import { getSystemErrorMap } from 'node:util';
import { AppError } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';

export function ttsArgs(platform: NodeJS.Platform, text: string, lang: string | null, rate: number | null): string[] {
  const args: string[] = [];
  if (lang !== null) {
    const key = lang === 'zh-CN' || lang === 'zh' ? 'zh' : lang === 'ja-JP' || lang === 'ja' ? 'ja' : 'en';
    const voice = platform === 'darwin' ? { zh: 'Ting-Ting', en: 'Alex', ja: 'Kyoko' }[key] : key;
    args.push('-v', voice);
  }
  if (rate !== null) {
    // Rust input and multiplication are f32, followed by a saturating u32 cast.
    const product = Math.fround(Math.fround(175) * Math.fround(rate));
    const wpm = Math.min(0xffff_ffff, Math.max(0, Math.trunc(product)));
    args.push(platform === 'darwin' ? '-r' : '-s', String(wpm));
  }
  // RUST-FIX(RF-W04-tts-text-option-injection): tts.rs:153/204 pass the text bare, so text starting with `-` was parsed as a say/espeak option.
  args.push('--', text);
  return args;
}

function spawnMessage(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (typeof e.errno === 'number' && e.errno < 0) {
    const message = getSystemErrorMap().get(e.errno)?.[1] ?? e.message;
    return `${message[0]!.toUpperCase()}${message.slice(1)} (os error ${-e.errno})`;
  }
  return e.message;
}

async function output(command: string, args: string[]): Promise<{ success: boolean; stderr: string }> {
  if (args.some(a => a.includes('\0'))) throw new Error('nul byte found in provided data');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stdout.resume();
    child.stderr.on('data', (data: Buffer) => stderr.push(data));
    child.on('error', error => reject(new Error(spawnMessage(error))));
    child.on('close', code => resolve({ success: code === 0, stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

export async function checkAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  try { return (await output('which', ['espeak'])).success; }
  catch { return false; }
}

export async function speak(text: string, lang: string | null, rate: number | null, platform: NodeJS.Platform = process.platform): Promise<null> {
  if (platform === 'win32') throw new CommandError(AppError.new('Unknown', 'Windows TTS 需要额外配置，请使用 Web Speech API'));
  if (platform !== 'darwin' && platform !== 'linux') throw new CommandError(AppError.new('Unknown', '当前平台不支持 TTS'));
  const command = platform === 'darwin' ? 'say' : 'espeak';
  let result: { success: boolean; stderr: string };
  try { result = await output(command, ttsArgs(platform, text, lang, rate)); }
  catch (error) {
    throw new CommandError(AppError.internal(`执行 ${command} 命令失败: ${(error as Error).message}`));
  }
  if (!result.success) throw new CommandError(AppError.internal(`TTS 失败: ${result.stderr}`));
  return null;
}
