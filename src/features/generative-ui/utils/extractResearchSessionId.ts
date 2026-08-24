/**
 * 从 render_generative_ui toolInput / toolOutput / intent 提取 researchSessionId
 */

function readField(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

function readMetaResearchSessionId(intent: unknown): string | null {
  if (!intent || typeof intent !== 'object') return null;
  const meta = (intent as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  const id = (meta as { researchSessionId?: unknown }).researchSessionId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** 解析 researchSessionId；无效则返回 null */
export function extractResearchSessionId(
  toolInput?: unknown,
  toolOutput?: unknown,
  intent?: unknown,
): string | null {
  const fromInput = readField(toolInput, 'researchSessionId');
  if (typeof fromInput === 'string' && fromInput.trim()) {
    return fromInput.trim();
  }

  const fromOutput = readField(toolOutput, 'researchSessionId');
  if (typeof fromOutput === 'string' && fromOutput.trim()) {
    return fromOutput.trim();
  }

  return readMetaResearchSessionId(intent);
}
