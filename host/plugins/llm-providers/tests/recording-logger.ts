import type { PluginLogger } from '../api.ts';

/** Test double for the plugin logger; production log calls still run unchanged. */
export function createRecordingLogger(): {
  logger: PluginLogger;
  messages: { level: 'error' | 'warn' | 'info' | 'debug'; message: string; args: unknown[] }[];
} {
  const messages: { level: 'error' | 'warn' | 'info' | 'debug'; message: string; args: unknown[] }[] = [];
  const record = (level: 'error' | 'warn' | 'info' | 'debug') =>
    (message: string, ...args: unknown[]) => { messages.push({ level, message, args }); };
  return {
    messages,
    logger: { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') },
  };
}
