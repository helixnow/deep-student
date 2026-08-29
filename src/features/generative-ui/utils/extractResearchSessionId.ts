/**
 * 从 render_generative_ui toolInput / toolOutput / intent 提取 researchSessionId
 */

export const MAX_RESEARCH_SESSION_ID_LENGTH = 128;
const RESEARCH_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sanitizeResearchSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RESEARCH_SESSION_ID_LENGTH) return null;
  return RESEARCH_SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

function readField(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

function readMetaResearchSessionId(intent: unknown): string | null {
  if (!intent || typeof intent !== 'object') return null;
  const meta = (intent as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  return sanitizeResearchSessionId((meta as { researchSessionId?: unknown }).researchSessionId);
}

/** 解析 researchSessionId；无效则返回 null */
export function extractResearchSessionId(
  toolInput?: unknown,
  toolOutput?: unknown,
  intent?: unknown,
): string | null {
  return (
    sanitizeResearchSessionId(readField(toolInput, 'researchSessionId')) ??
    sanitizeResearchSessionId(readField(toolOutput, 'researchSessionId')) ??
    readMetaResearchSessionId(intent)
  );
}
