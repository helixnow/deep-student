import { CommandError } from '../../../../kernel/api.ts';

/** `ChatV2Error::to_string()`: the Display text carried as `message` in the command-error JSON. */
export function chatV2Display(error: unknown): string {
  if (error instanceof CommandError && typeof error.value === 'string') {
    try {
      const parsed = JSON.parse(error.value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { message?: unknown }).message === 'string') {
        return (parsed as { message: string }).message;
      }
    } catch { return error.value; }
  }
  return error instanceof Error ? error.message : String(error);
}
