import { CommandError } from '../../../kernel/api.ts';
import type { AppError } from '../../../platform/errors/api.ts';

const rawJson = JSON as typeof JSON & { rawJSON(text: string): unknown };

// serde_json::to_string writes a u64 trusted-profile field (bigint above 2^53) as its exact digits.
const stringifyExact = (payload: unknown): string => JSON.stringify(payload, (_key, item: unknown) =>
  typeof item === 'bigint' ? rawJson.rawJSON(item.toString()) : item);

function truncateAgentText(value: string): { text: string; truncated: boolean } {
  const chars = Array.from(value);
  return { text: chars.slice(0, 2_000).join(''), truncated: chars.length > 2_000 };
}

/** automations.rs:139–178: non-conflicts keep the plain message; conflicts become the OCC payload. */
export function serializeAutomationUpdateError(error: AppError, agentFacing: boolean): string {
  if (error.error_type !== 'Conflict') return error.message;
  const details = error.details;
  const payload: Record<string, unknown> = details !== null && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown> : {};
  const current = payload.current;
  if (agentFacing && current !== null && typeof current === 'object' && !Array.isArray(current)) {
    const item = current as Record<string, unknown>;
    const fieldsTruncated: string[] = [];
    for (const field of ['prompt', 'agent_prompt']) {
      const source = item[field];
      if (typeof source !== 'string') continue;
      const bounded = truncateAgentText(source);
      item[field] = bounded.text;
      if (bounded.truncated) fieldsTruncated.push(field);
    }
    item.promptTruncated = fieldsTruncated.length > 0;
    item.fieldsTruncated = fieldsTruncated;
  }
  if (!Object.hasOwn(payload, 'code')) payload.code = 'AUTOMATION_VERSION_CONFLICT';
  payload.errorType = 'conflict';
  payload.message = error.message;
  return stringifyExact(payload);
}

/** automations.rs:185–201; conflicts have a separate OCC payload. */
export function automationCommandError(error: AppError): CommandError {
  if (error.error_type === 'Conflict') return new CommandError(serializeAutomationUpdateError(error, false));
  const codes = {
    Validation: 'VALIDATION_ERROR', Database: 'DATABASE_ERROR', NotFound: 'NOT_FOUND',
    Network: 'NETWORK_ERROR', FileSystem: 'IO_ERROR', LLM: 'LLM_ERROR',
    Configuration: 'CONFIGURATION_ERROR', Unknown: 'AUTOMATION_ERROR',
  };
  return new CommandError(JSON.stringify({ code: codes[error.error_type], message: error.message }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
